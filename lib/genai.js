/*
 * Kurumsal GenAI gateway istemcisi
 *
 *   1) TMS_TOKEN_URL'e istek atılır → token alınır ve süresi dolana kadar cache'lenir
 *   2) CHAT_URL'e (chat/completions) header'lar + "Authorization: Bearer <token>" ile istek atılır
 *
 * Tüm adresler, header'lar ve gövdeler .env üzerinden gelir (bkz. .env.example).
 * Değerlerde şu yer tutucular kullanılabilir:
 *   {{uuid}}       → her istekte yeni UUID
 *   {{token}}      → TMS'ten alınan token
 *   {{env:İSİM}}   → başka bir ortam değişkeninin değeri (gövdede JSON-güvenli kaçışlanır)
 */
const crypto = require("crypto");
const { headersFromEnv, jsonEnv, bool } = require("./env");
const { request } = require("./http");

const TLS_HINT = "Sertifika doğrulamasını kapatmak için .env'e GENAI_TLS_INSECURE=true ekleyin.";

const env = (k, d = "") => process.env[k] ?? d;

function config() {
  return {
    tms: {
      url: env("TMS_TOKEN_URL"),
      method: env("TMS_METHOD", "POST"),
      headers: headersFromEnv("TMS_H_"),
      body: env("TMS_BODY"),
      basicUser: env("TMS_BASIC_USER"),
      basicPass: env("TMS_BASIC_PASS"),
      tokenPath: env("TMS_TOKEN_PATH"),
      tokenHeader: env("TMS_TOKEN_HEADER", "authorization").toLowerCase(),
      tokenSource: ["header", "body"].includes(env("TMS_TOKEN_SOURCE").toLowerCase()) ? env("TMS_TOKEN_SOURCE").toLowerCase() : "auto",
      expiresPath: env("TMS_EXPIRES_PATH"),
      ttl: Number(env("TMS_TOKEN_TTL_SECONDS", "300")),
    },
    chat: {
      url: env("CHAT_URL"),
      headers: headersFromEnv("CHAT_H_"),
      authHeader: env("CHAT_AUTH_HEADER", "Authorization"),
      authPrefix: env("CHAT_AUTH_PREFIX", "Bearer").trim().replace(/(.)$/, "$1 "), // "Bearer" → "Bearer "
      model: env("CHAT_MODEL"),
      modelField: env("CHAT_MODEL_FIELD", "model"),
      bodyExtra: jsonEnv("CHAT_BODY_EXTRA", {}),
      replyPath: env("CHAT_REPLY_PATH", "choices.0.message.content"),
    },
    insecureTls: bool("GENAI_TLS_INSECURE"),
    timeoutMs: Number(env("GENAI_TIMEOUT_MS", "60000")),
  };
}

/** Geçerli bir http(s) adresi mi? .env.example'daki <yer-tutucu> değerler geçersiz sayılır. */
function validUrl(value) {
  if (!value || /[<>]/.test(value)) return false;
  try { return /^https?:$/.test(new URL(value).protocol); } catch { return false; }
}

const hostOf = (value) => (validUrl(value) ? new URL(value).host : null);

const isConfigured = () => validUrl(env("TMS_TOKEN_URL")) && validUrl(env("CHAT_URL"));

/** Yapılandırma sorunlarını insan okunur biçimde döndürür (başlangıç logu için). */
function configProblems() {
  return ["TMS_TOKEN_URL", "CHAT_URL"]
    .filter((k) => !validUrl(env(k)))
    .map((k) => (env(k) ? `${k} geçersiz veya yer tutucu içeriyor: ${env(k)}` : `${k} boş`));
}

/* ------------------------------------------------------------------ */

/** Yer tutucuları doldurur. json=true ise değerler JSON string içine güvenle gömülecek şekilde kaçışlanır. */
const fill = (s, vars, { json = false } = {}) =>
  String(s).replace(/\{\{\s*(uuid|token|env:([A-Za-z0-9_]+))\s*\}\}/g, (_, k, envName) => {
    const v = k === "uuid" ? crypto.randomUUID() : k === "token" ? vars.token ?? "" : env(envName);
    return json ? JSON.stringify(String(v)).slice(1, -1) : v;
  });

const fillHeaders = (h, vars) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, fill(v, vars)]));

/** "Bearer xxx", "Bearer: xxx", "bearer:xxx" → "xxx" */
const cleanToken = (v) => String(v || "").trim().replace(/^Bearer\s*:?\s*/i, "").trim();

const getPath = (obj, p) => p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

/* ------------------------------------------------------------------ */
/*  Token                                                              */
/* ------------------------------------------------------------------ */

let cached = null; // { token, expiresAt }
let inflight = null;

const TOKEN_CANDIDATES = ["access_token", "accessToken", "token", "data.access_token", "data.accessToken", "data.token", "result.token"];
const EXPIRES_CANDIDATES = ["expires_in", "expiresIn", "data.expires_in", "data.expiresIn"];

async function fetchToken() {
  const c = config();
  if (!c.tms.url) throw new Error("TMS_TOKEN_URL tanımlı değil (.env)");

  const headers = fillHeaders(c.tms.headers, {});
  if (c.tms.basicUser)
    headers.authorization = "Basic " + Buffer.from(`${c.tms.basicUser}:${c.tms.basicPass}`).toString("base64");
  const body = c.tms.body ? fill(c.tms.body, {}, { json: true }) : c.tms.method === "GET" ? undefined : "{}";

  const res = await request("genai", "tms-token", c.tms.url,
    { method: c.tms.method, headers, body, insecureTls: c.insecureTls, timeoutMs: c.timeoutMs, tlsHint: TLS_HINT });
  if (res.status >= 400) throw new Error(`TMS token isteği başarısız (HTTP ${res.status}): ${res.text.slice(0, 300)}`);

  // Token kaynağı (TMS_TOKEN_SOURCE): auto | header | body
  //   auto: TMS_TOKEN_PATH verilmişse gövdedeki o alan; değilse yanıt header'ı (ör. "authorization: Bearer: xxx"),
  //         o da yoksa gövdedeki bilinen alanlar (access_token, token, data.token ...)
  const src = c.tms.tokenSource;
  const fromHeader = src === "body" ? null : res.headers[c.tms.tokenHeader];
  const fromPath = src !== "header" && c.tms.tokenPath ? getPath(res.json, c.tms.tokenPath) : null;
  const fromBody = src === "header" ? null : TOKEN_CANDIDATES.map((p) => getPath(res.json, p)).find((v) => typeof v === "string");
  const raw = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader;
  const token = cleanToken(fromPath || (src === "body" ? fromBody : raw || fromBody));
  if (!token)
    throw new Error(
      `TMS yanıtında token bulunamadı (kaynak: ${src}; gövde veya '${c.tms.tokenHeader}' header'ı). ` +
      `TMS_TOKEN_SOURCE / TMS_TOKEN_PATH / TMS_TOKEN_HEADER ayarlayın. Yanıt: ${res.text.slice(0, 300) || "(boş gövde)"}`);

  const exp = Number(
    (c.tms.expiresPath ? getPath(res.json, c.tms.expiresPath) : EXPIRES_CANDIDATES.map((p) => getPath(res.json, p)).find((v) => v != null))
      ?? res.headers["expires_in"]
  ) || c.tms.ttl;

  // süre dolmadan 30 sn önce yenile
  cached = { token, expiresAt: Date.now() + Math.max(exp - 30, 10) * 1000 };
  return token;
}

async function getToken(force = false) {
  if (!force && cached && cached.expiresAt > Date.now()) return cached.token;
  inflight ||= fetchToken().finally(() => (inflight = null));
  return inflight;
}

/* ------------------------------------------------------------------ */
/*  Chat completions                                                   */
/* ------------------------------------------------------------------ */

/**
 * @param {{role:string, content:string}[]} messages
 * @param {{model?:string, kind?:string}} opts  kind: log'da görünen çağrı türü
 * @returns {Promise<{content:string, usage:object|null, model:string|null, logId:string}>}
 *   Hata durumunda da (token harcanmışsa) error.usage / error.logId doldurulur.
 */
/**
 * Araç destekli ham çağrı (ajan döngüsü). opts.tools: OpenAI biçimli function listesi.
 * @returns {Promise<{message:object, finishReason:string|null, usage:object|null, model:string|null, logId:string}>}
 *   HTTP hatasında error.status dolu (ajan 'tools' desteklenmiyorsa JSON moduna geçer)
 */
async function complete(messages, opts = {}) {
  const c = config();
  if (!c.chat.url) throw new Error("CHAT_URL tanımlı değil (.env)");
  const payload = {
    ...(opts.model || c.chat.model ? { [c.chat.modelField]: opts.model || c.chat.model } : {}),
    messages,
    ...c.chat.bodyExtra,
    ...(opts.tools?.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
  };
  const body = JSON.stringify(payload);
  const send = async (token) => {
    const headers = fillHeaders(c.chat.headers, { token });
    headers[c.chat.authHeader.toLowerCase()] = c.chat.authPrefix + token;
    return request("genai", opts.kind || "agent", c.chat.url,
      { method: "POST", headers, body, insecureTls: c.insecureTls, timeoutMs: c.timeoutMs, tlsHint: TLS_HINT },
      (r) => ({ usage: r.json?.usage, finishReason: r.json?.choices?.[0]?.finish_reason, model: r.json?.model, tools: opts.tools?.length || 0 }));
  };
  let res = await send(await getToken());
  if (res.status === 401 || res.status === 403) res = await send(await getToken(true));
  if (res.status >= 400)
    throw Object.assign(new Error(`Chat isteği başarısız (HTTP ${res.status}): ${res.text.slice(0, 400)}`), { status: res.status, usage: res.json?.usage || null, logId: res.logId });
  let message = res.json?.choices?.[0]?.message;
  if (!message || typeof message !== "object") {
    const reply = getPath(res.json, c.chat.replyPath);
    if (typeof reply !== "string") throw Object.assign(new Error(`Yanıtta mesaj bulunamadı: ${res.text.slice(0, 300)}`), { logId: res.logId });
    message = { role: "assistant", content: reply };
  }
  return { message, finishReason: res.json?.choices?.[0]?.finish_reason || null, usage: res.json?.usage || null, model: res.json?.model || null, logId: res.logId };
}

async function chat(messages, opts = {}) {
  const c = config();
  if (!c.chat.url) throw new Error("CHAT_URL tanımlı değil (.env)");

  const body = JSON.stringify({
    ...(opts.model || c.chat.model ? { [c.chat.modelField]: opts.model || c.chat.model } : {}),
    messages,
    ...c.chat.bodyExtra,
  });

  const send = async (token) => {
    const headers = fillHeaders(c.chat.headers, { token });
    headers[c.chat.authHeader.toLowerCase()] = c.chat.authPrefix + token;
    return request("genai", opts.kind || "chat", c.chat.url,
      { method: "POST", headers, body, insecureTls: c.insecureTls, timeoutMs: c.timeoutMs, tlsHint: TLS_HINT },
      (r) => ({ usage: r.json?.usage, finishReason: r.json?.choices?.[0]?.finish_reason, model: r.json?.model }));
  };

  let res = await send(await getToken());
  if (res.status === 401 || res.status === 403) res = await send(await getToken(true)); // token yenile, bir kez tekrar dene

  const fail = (msg) => Object.assign(new Error(msg), { usage: res.json?.usage || null, logId: res.logId });
  if (res.status >= 400) throw fail(`Chat isteği başarısız (HTTP ${res.status}): ${res.text.slice(0, 400)}`);

  const reply = getPath(res.json, c.chat.replyPath);
  if (typeof reply !== "string")
    throw fail(`Yanıtta '${c.chat.replyPath}' bulunamadı. CHAT_REPLY_PATH ayarlayın. Yanıt: ${res.text.slice(0, 300)}`);
  if (!reply.trim()) {
    // Akıl yürüten modeller (gpt-5.x) token bütçesini düşünmeye harcarsa içerik boş döner
    const fr = res.json?.choices?.[0]?.finish_reason;
    throw fail(
      `Model boş cevap döndü (finish_reason=${fr ?? "?"}).` +
      (fr === "length" ? " CHAT_BODY_EXTRA içindeki max_completion_tokens değerini artırın (ör. 16000)." : ""));
  }
  return { content: reply, usage: res.json?.usage || null, model: res.json?.model || null, logId: res.logId };
}

function status() {
  const c = config();
  return {
    configured: isConfigured(),
    tokenHost: hostOf(c.tms.url),
    chatHost: hostOf(c.chat.url),
    tokenCached: Boolean(cached && cached.expiresAt > Date.now()),
    tokenExpiresIn: cached ? Math.max(0, Math.round((cached.expiresAt - Date.now()) / 1000)) : 0,
  };
}

module.exports = { chat, complete, getToken, status, isConfigured, configProblems };
