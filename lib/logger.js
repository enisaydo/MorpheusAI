/*
 * Dış servis çağrı logları (GenAI, AAP)
 *  - Son AI_LOG_MEMORY (varsayılan 200) kayıt bellekte tutulur → /api/logs ile arayüzde görünür
 *  - Her kayıt logs/ai-YYYY-MM-DD.jsonl dosyasına bir satır olarak yazılır
 *  - Konsola (journalctl / podman logs) tek satırlık özet basılır
 *  - Gizli alanlar (authorization, cookie, client_secret, password, token...) maskelenir
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LOG_DIR = process.env.AI_LOG_DIR || path.join(__dirname, "..", "logs");
const MAX_MEMORY = Number(process.env.AI_LOG_MEMORY || 200);
const MAX_BODY = Number(process.env.AI_LOG_MAX_BODY || 200000); // karakter
const TO_FILE = !/^(0|false|no|off)$/i.test(process.env.AI_LOG_FILE || "true");

// Not: "max_completion_tokens", "total_tokens" gibi sayaçlar maskelenmez
const SECRET_KEY = {
  test: (k) =>
    /^(authorization|proxy-authorization|cookie|set-cookie|password|passwd|token|access_token|refresh_token|id_token|x-api-key|api[-_]?key|client[-_]?id)$/i.test(k) ||
    /secret/i.test(k),
};

const entries = [];

/** Parola/secret hiç gösterilmez; token ve id'lerin yalnızca ilk 4 karakteri (eşleştirme için) gösterilir. */
function maskValue(v, key = "") {
  const s = String(v ?? "");
  if (!s) return s;
  if (/password|passwd|secret/i.test(key)) return `****(${s.length})`;
  const bearer = s.match(/^(Bearer|Basic)\s+(.*)$/i);
  if (bearer) return `${bearer[1]} ${bearer[2].slice(0, 4)}…(${bearer[2].length})`;
  return s.length <= 8 ? "****" : `${s.slice(0, 4)}…(${s.length})`;
}

const maskHeaders = (h = {}) =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k, SECRET_KEY.test(k) ? maskValue(v, k) : v]));

/** JSON gövdedeki gizli alanları maskeler; JSON değilse metni olduğu gibi (kısaltılmış) döndürür. */
function maskBody(body) {
  if (body == null || body === "") return body ?? null;
  let obj = body;
  if (typeof body === "string") {
    try { obj = JSON.parse(body); } catch { return truncate(body); }
  }
  const walk = (o) =>
    Array.isArray(o) ? o.map(walk)
    : o && typeof o === "object"
      ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, SECRET_KEY.test(k) && typeof v !== "object" ? maskValue(v, k) : walk(v)]))
      : o;
  return walk(obj);
}

const truncate = (s) => (typeof s === "string" && s.length > MAX_BODY ? s.slice(0, MAX_BODY) + `…[${s.length - MAX_BODY} karakter kesildi]` : s);

function writeFile(entry) {
  if (!TO_FILE) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `ai-${entry.time.slice(0, 10)}.jsonl`);
    fs.appendFile(file, JSON.stringify(entry) + "\n", () => {});
  } catch {}
}

/**
 * @param {object} e  { service, kind, method, url, requestHeaders, requestBody, status, responseHeaders, responseBody, durationMs, error, meta }
 */
function record(e) {
  const u = (() => { try { return new URL(e.url); } catch { return null; } })();
  const entry = {
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    service: e.service,
    kind: e.kind,
    method: e.method,
    host: u?.host ?? null,
    path: u ? u.pathname + u.search : e.url,
    status: e.status ?? null,
    ok: !e.error && e.status != null && e.status < 400,
    durationMs: e.durationMs,
    request: { headers: maskHeaders(e.requestHeaders), body: maskBody(e.requestBody) },
    response: { headers: maskHeaders(e.responseHeaders), body: maskBody(e.responseBody) },
    error: e.error || null,
    meta: e.meta || null,
  };
  entries.push(entry);
  if (entries.length > MAX_MEMORY) entries.shift();
  writeFile(entry);
  console.log(
    `[${entry.service}] ${entry.kind} ${entry.method} ${entry.host}${entry.path} → ${entry.status ?? "ERR"} ${entry.durationMs}ms` +
    (entry.meta?.usage ? ` tokens=${entry.meta.usage.total_tokens ?? "?"}` : "") +
    (entry.error ? ` HATA: ${entry.error}` : "")
  );
  return entry;
}

function list({ limit = 50, service } = {}) {
  return entries
    .filter((e) => !service || e.service === service)
    .slice(-limit)
    .reverse()
    .map(({ request, response, ...summary }) => summary);
}

const get = (id) => entries.find((e) => e.id === id) || null;

module.exports = { record, list, get, maskHeaders, maskBody };
