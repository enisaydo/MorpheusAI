/*
 * Langfuse izleme (isteğe bağlı) — OpenTelemetry OTLP/HTTP JSON, bağımlılıksız
 *
 *  .env:
 *    LANGFUSE_URL=http://langfuse.kurum.local:3000     boşsa izleme kapalı
 *    LANGFUSE_PUBLIC_KEY=pk-lf-...   LANGFUSE_SECRET_KEY=sk-lf-...
 *    LANGFUSE_PROJECT_ID=unixai-morpheus               arayüzde "Langfuse'ta aç" bağlantısı için (boşsa API'den bulunur)
 *    LANGFUSE_TLS_INSECURE=false   LANGFUSE_CAPTURE_IO=true (false: soru/cevap/argüman gönderilmez)   LANGFUSE_ENVIRONMENT=production
 *
 *  Ne gönderilir: ajan çalışması (agent) → araç adımları (tool / agent) → GPT çağrıları (generation: model, token);
 *  düzeltme playbook'u üretimi (chain). UnixAI'den gelen soruda iz bağlamı MCP 'context.trace' ile gelir:
 *  iki ajanın konuşması Langfuse'ta tek iz olarak görünür. Gönderim arka planda topludur; Langfuse erişilemezse izler düşer.
 */
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { AsyncLocalStorage } = require("async_hooks");

const SERVICE = "morpheusai";
const als = new AsyncLocalStorage();
const queue = [];
const stats = { sent: 0, dropped: 0, failed: 0, lastError: null, lastSentAt: null };
const project = { id: null, checked: 0 };
let timer = null;

const env = (k) => process.env[k] || "";
const enabled = () => Boolean(env("LANGFUSE_URL") && env("LANGFUSE_PUBLIC_KEY") && env("LANGFUSE_SECRET_KEY"));
const capture = () => !/^(0|false|no|off)$/i.test(env("LANGFUSE_CAPTURE_IO") || "true");
const auth = () => "Basic " + Buffer.from(`${env("LANGFUSE_PUBLIC_KEY")}:${env("LANGFUSE_SECRET_KEY")}`).toString("base64");
const insecure = () => /^(1|true|yes|on)$/i.test(env("LANGFUSE_TLS_INSECURE"));

function clip(v, n = 20000) {
  if (v == null) return undefined;
  let s = v;
  if (typeof v !== "string") {
    try { s = JSON.stringify(require("./logger").maskBody(JSON.stringify(v))); } catch { s = JSON.stringify(v); }
  }
  return s.length <= n ? s : s.slice(0, n) + `…[${s.length - n} karakter kesildi]`;
}
function val(v) {
  if (typeof v === "boolean") return { boolValue: v };
  if (Number.isInteger(v)) return { intValue: String(v) };
  if (typeof v === "number") return { doubleValue: v };
  if (v && typeof v === "object") return { stringValue: JSON.stringify(v) };
  return { stringValue: String(v) };
}

class Span {
  constructor(name, type = "span", { input, parent, trace, attrs } = {}) {
    const cur = als.getStore();
    if (parent?.trace_id) { this.traceId = parent.trace_id; this.parentId = parent.span_id || null; this.traceAttrs = { ...(trace || {}) }; }
    else if (cur) { this.traceId = cur.traceId; this.parentId = cur.spanId; this.traceAttrs = { ...cur.traceAttrs, ...(trace || {}) }; }
    else { this.traceId = crypto.randomBytes(16).toString("hex"); this.parentId = null; this.traceAttrs = { "langfuse.trace.name": name, ...(trace || {}) }; }
    this.spanId = crypto.randomBytes(8).toString("hex");
    this.name = name;
    this.start = BigInt(Date.now()) * 1000000n; // Unix zamanı (ns)
    this.attrs = { "langfuse.observation.type": type };
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) this.attrs[k] = v;
    if (input != null && capture()) this.attrs["langfuse.observation.input"] = clip(input);
    this.error = null;
  }
  set(kv) { for (const [k, v] of Object.entries(kv || {})) if (v != null) this.attrs[k] = v; return this; }
  output(v) { if (v != null && capture()) this.attrs["langfuse.observation.output"] = clip(v); return this; }
  usage(u, model) {
    if (model) this.attrs["gen_ai.response.model"] = model;
    if (u && typeof u === "object") {
      const i = u.prompt_tokens ?? u.input_tokens, o = u.completion_tokens ?? u.output_tokens;
      if (i != null) this.attrs["gen_ai.usage.input_tokens"] = Number(i);
      if (o != null) this.attrs["gen_ai.usage.output_tokens"] = Number(o);
      const d = {};
      if (i != null) d.input = Number(i);
      if (o != null) d.output = Number(o);
      if (u.total_tokens != null) d.total = Number(u.total_tokens);
      this.attrs["langfuse.observation.usage_details"] = JSON.stringify(d);
    }
    return this;
  }
  ids() { return { trace_id: this.traceId, span_id: this.spanId }; }
  end() {
    const attrs = { ...this.traceAttrs, ...this.attrs, "langfuse.environment": env("LANGFUSE_ENVIRONMENT") || "production" };
    if (this.error) { attrs["langfuse.observation.level"] = "ERROR"; attrs["langfuse.observation.status_message"] = this.error; }
    const span = {
      traceId: this.traceId, spanId: this.spanId, name: this.name, kind: 1,
      startTimeUnixNano: String(this.start), endTimeUnixNano: String(BigInt(Date.now()) * 1000000n),
      attributes: Object.entries(attrs).filter(([, v]) => v != null).map(([key, v]) => ({ key, value: val(v) })),
      status: this.error ? { code: 2, message: this.error } : { code: 1 },
    };
    if (this.parentId) span.parentSpanId = this.parentId;
    if (queue.length < 5000) queue.push(span); else stats.dropped++;
    if (!timer) timer = setTimeout(flush, 2000);
  }
}
/**
 * Bir gözlem içinde fn çalıştırır; fn(span) içindeki çağrılar bunun altına bağlanır. İzleme kapalıysa fn(noop) çalışır.
 * @returns fn'in döndürdüğü değer (hata olursa gözleme yazılıp tekrar fırlatılır)
 */
async function span(name, type, opts, fn) {
  if (!enabled()) return fn(NOOP);
  const s = new Span(name, type, opts);
  try { return await als.run(s, () => fn(s)); }
  catch (e) { s.error = String(e?.message || e).slice(0, 500); throw e; }
  finally { s.end(); }
}
const NOOP = { traceId: null, spanId: null, set() { return this; }, output() { return this; }, usage() { return this; }, ids() { return null; } };

function generation(name, messages, model, fn, attrs = {}) {
  const msgs = (messages || []).slice(-12).map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content.slice(0, 4000) : m.content }));
  return span(name, "generation", { input: msgs, attrs: { "gen_ai.request.model": model, ...attrs } }, fn);
}

const current = () => { const s = als.getStore(); return s ? s.ids() : null; };
const currentTraceId = () => als.getStore()?.traceId || null;

/* ---------------- gönderim ---------------- */
function flush() {
  timer = null;
  if (!queue.length || !enabled()) return;
  const spans = queue.splice(0, 200);
  const body = JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: SERVICE } }] },
    scopeSpans: [{ scope: { name: SERVICE }, spans }] }] });
  post(body, 1, spans.length);
  if (queue.length) timer = setTimeout(flush, 200);
}
function post(body, attempt, n) {
  let u;
  try { u = new URL(env("LANGFUSE_URL").replace(/\/+$/, "") + "/api/public/otel/v1/traces"); } catch (e) { stats.lastError = e.message; stats.failed += n; return; }
  const lib = u.protocol === "http:" ? http : https;
  const req = lib.request(u, { method: "POST", rejectUnauthorized: !insecure(), timeout: 15000,
    headers: { "content-type": "application/json", authorization: auth(), "x-langfuse-ingestion-version": "4", "content-length": Buffer.byteLength(body) } }, (res) => {
    res.resume();
    res.on("end", () => {
      if (res.statusCode < 400) { stats.sent += n; stats.lastSentAt = new Date().toISOString(); stats.lastError = null; }
      else fail(`HTTP ${res.statusCode}`);
    });
  });
  const fail = (msg) => {
    stats.lastError = String(msg).slice(0, 200);
    if (attempt === 1) setTimeout(() => post(body, 2, n), 2000).unref(); else stats.failed += n;
  };
  req.on("timeout", () => req.destroy(new Error("zaman aşımı")));
  req.on("error", (e) => fail(e.message));
  req.end(body);
}

async function projectId() {
  if (env("LANGFUSE_PROJECT_ID")) return env("LANGFUSE_PROJECT_ID");
  if (project.id || Date.now() - project.checked < 300000 || !enabled()) return project.id;
  project.checked = Date.now();
  try {
    const r = await fetch(env("LANGFUSE_URL").replace(/\/+$/, "") + "/api/public/projects", { headers: { authorization: auth() } });
    project.id = (await r.json())?.data?.[0]?.id || null;
  } catch (e) { stats.lastError = e.message; }
  return project.id;
}

async function status() {
  const on = enabled();
  const pid = on ? await projectId() : null;
  const base = env("LANGFUSE_URL").replace(/\/+$/, "");
  return { enabled: on, url: base || null, projectId: pid, captureIO: capture(), queue: queue.length, ...stats,
    traceUrl: on && pid ? `${base}/project/${pid}/traces/` : null };
}

module.exports = { enabled, span, generation, current, currentTraceId, status };
