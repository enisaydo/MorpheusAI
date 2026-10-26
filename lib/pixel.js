/*
 * Pixel Office (yerleşik) — bu makinedeki açık kaynak Pixel Agents ofisine doğrudan olay gönderir (ayrı köprü gerekmez)
 *
 *  .env:
 *    PIXEL_OFFICE=true            açar (varsayılan kapalı)
 *    PIXEL_URL=, PIXEL_TOKEN=     boşsa aynı makinedeki ~/.pixel-agents/servers/*.json'dan bulunur (Pixel Agents aynı kullanıcıyla çalışmalı)
 *    PIXEL_CWD=/pixel-office      karakterlerin proje klasörü öneki
 *
 *  MorpheusAI'nin canlı akışındaki her olay (ajan adımı, UnixAI'den gelen soru, düzeltme akışı: playbook → onay → Bitbucket → AAP)
 *  Pixel Agents'ın hook biçimine çevrilip POST /api/hooks/claude ile gönderilir. Ofiste iki karakter görünür: UnixAI ve MorpheusAI.
 *  Gönderim arka planda sıralıdır; Pixel Agents kapalıysa uygulama etkilenmez.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const SELF = "morpheus", PEER = "unixai";
const READ_RE = /get_|list_|status|findings|diagnostic|search|query|standards|records|tasks/;
const env = (k) => process.env[k] || "";
const enabled = () => /^(1|true|yes|on)$/i.test(env("PIXEL_OFFICE"));
const stats = { sent: 0, failed: 0, lastError: null, target: null };
const started = new Set();
const busy = { unixai: 0, morpheus: 0 };
const idle = {};
let chain = Promise.resolve();

function agents() {
  const cwd = (env("PIXEL_CWD") || "/pixel-office").replace(/\/+$/, "");
  return { unixai: { session: "unixai-os-ajani", cwd: `${cwd}/UnixAI` }, morpheus: { session: "morpheusai-ajani", cwd: `${cwd}/MorpheusAI` } };
}

function targets() {
  if (env("PIXEL_URL")) return [{ url: env("PIXEL_URL").replace(/\/+$/, ""), token: env("PIXEL_TOKEN") }];
  const dir = path.join(os.homedir(), ".pixel-agents");
  let files = [];
  try { files = fs.readdirSync(path.join(dir, "servers")).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, "servers", f)); } catch {}
  if (!files.length) files = [path.join(dir, "server.json")];
  const out = [];
  for (const f of files) {
    try { const c = JSON.parse(fs.readFileSync(f, "utf8")); if (c.port && c.token) out.push({ url: `http://127.0.0.1:${c.port}`, token: c.token }); } catch {}
  }
  return out;
}

async function send(kind, body) {
  const a = agents()[kind];
  for (const t of targets()) {
    const key = `${t.url}|${a.session}`;
    stats.target = t.url;
    const post = (b) => fetch(`${t.url}/api/hooks/claude`, { method: "POST", signal: AbortSignal.timeout(5000),
      headers: { "content-type": "application/json", authorization: `Bearer ${t.token}` }, body: JSON.stringify({ session_id: a.session, ...b }) });
    try {
      if (!started.has(key)) { await post({ hook_event_name: "SessionStart", source: "startup", cwd: a.cwd }); started.add(key); }
      await post(body);
      stats.sent++;
    } catch (e) { started.delete(key); stats.failed++; stats.lastError = String(e.message).slice(0, 200); }
  }
}
/** Sıralı gönderim (olay sırası korunur) */
const hook = (kind, body) => { chain = chain.then(() => send(kind, body)).catch(() => {}); };

function done(kind, ms = 4000) {
  clearTimeout(idle[kind]);
  idle[kind] = setTimeout(() => { if (!busy[kind]) hook(kind, { hook_event_name: "Stop" }); }, ms);
  idle[kind].unref?.();
}
function start(kind, tool_name, tool_input) { clearTimeout(idle[kind]); busy[kind]++; hook(kind, { hook_event_name: "PreToolUse", tool_name, tool_input }); }
function end(kind, failed) { busy[kind] = Math.max(0, busy[kind] - 1); hook(kind, { hook_event_name: failed ? "PostToolUseFailure" : "PostToolUse" }); done(kind); }
const sub = (kind, desc) => start(kind, "Agent", { description: String(desc).slice(0, 120), run_in_background: true });
const blip = (kind, tool, input, failed) => { start(kind, tool, input); end(kind, failed); };

/** live.publish'ten çağrılır: MorpheusAI olayını ofis hareketine çevirir */
function onEvent(ev) {
  if (!enabled() || ev.replay) return;
  switch (ev.type) {
    case "step": {
      const tool = String(ev.tool || "").replace(/^.*__/, "");
      if (ev.phase === "start") {
        if (/agent_ask$/.test(tool)) return sub(SELF, "UnixAI'ye soruyor");
        if (/create_remediation/.test(tool)) return sub(SELF, "Playbook yazıyor");
        if (READ_RE.test(tool)) return start(SELF, "Read", { file_path: `/${tool}` });
        return start(SELF, "Bash", { command: tool });
      }
      return end(SELF, ev.ok === false);
    }
    case "a2a": {
      const callee = ev.dir === "gelen" ? SELF : PEER;
      if (ev.phase === "start") {
        if (callee === SELF) sub(PEER, "MorpheusAI'ye soruyor"); // UnixAI karakteri de soruyor görünsün
        return sub(callee, `${callee === SELF ? "UnixAI" : "MorpheusAI"}'den soru: ${ev.question || ""}`);
      }
      busy[callee] = Math.max(0, busy[callee] - 1);
      hook(callee, { hook_event_name: ev.ok === false ? "PostToolUseFailure" : "PostToolUse" });
      if (callee === SELF) end(PEER);
      if (ev.remediations) return hook(SELF, { hook_event_name: "PermissionRequest" });
      return done(callee, 1500);
    }
    case "rem": {
      const s = ev.server || "sunucu";
      if (ev.stage === "received") return blip(SELF, "Read", { file_path: `/bulgu-${s}` });
      if (ev.stage === "generated") { blip(SELF, "Write", { file_path: `/playbook-${s}.yml` }); return hook(SELF, { hook_event_name: "PermissionRequest" }); }
      const cmd = { approved: `onaylandı · ${ev.by || ""}`, commit: `git commit · Bitbucket · ${s}`, sync: "AAP proje sync",
        template: `AAP job template · ${s}`, launch: `AAP ${ev.mode === "run" ? "uygula" : "check"} · ${s}` }[ev.stage];
      if (cmd) return blip(SELF, "Bash", { command: cmd });
      if (["job", "rejected", "failed"].includes(ev.stage))
        return blip(SELF, "Bash", { command: String(ev.text || ev.stage).slice(0, 80) }, ev.stage !== "job" || !/successful/.test(ev.text || ""));
      return undefined;
    }
    default:
      return undefined; // ham MCP/REST trafiği ofiste ayrıca gösterilmez
  }
}

/** Servis açılınca iki karakteri ofise al */
function hello() { if (enabled()) for (const k of ["unixai", "morpheus"]) hook(k, { hook_event_name: "Stop" }); }
const status = () => ({ enabled: enabled(), targets: enabled() ? targets().map((t) => t.url) : [], ...stats });

module.exports = { onEvent, hello, status };
