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
const https = require("https");
const http = require("http");
const zlib = require("zlib");
const crypto = require("crypto");
const { headersFromEnv, jsonEnv, bool } = require("./env");

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
    debug: bool("GENAI_DEBUG"),
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

const getPath = (obj, p) => p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

const mask = (h) =>
  Object.fromEntries(Object.entries(h).map(([k, v]) =>
    [k, /authorization|cookie|token|secret|client-id|password/i.test(k) ? String(v).slice(0, 6) + "…" : v]));

function httpRequest(url, { method = "POST", headers = {}, body, insecureTls, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request(
      u,
      {
        method,
        headers: { ...headers, ...(body != null ? { "content-length": Buffer.byteLength(body) } : {}) },
        rejectUnauthorized: !insecureTls,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let buf = Buffer.concat(chunks);
          try {
            const enc = (res.headers["content-encoding"] || "").toLowerCase();
            if (enc.includes("gzip")) buf = zlib.gunzipSync(buf);
            else if (enc.includes("br")) buf = zlib.brotliDecompressSync(buf);
            else if (enc.includes("deflate")) buf = zlib.inflateSync(buf);
          } catch (e) { return reject(new Error(`Yanıt açılamadı: ${e.message}`)); }
          const text = buf.toString("utf8");
          let json;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Zaman aşımı (${timeoutMs} ms): ${u.host}`)));
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

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

  if (c.debug) console.log("[genai] TMS →", c.tms.method, c.tms.url, mask(headers));
  const res = await httpRequest(c.tms.url, { method: c.tms.method, headers, body, insecureTls: c.insecureTls, timeoutMs: c.timeoutMs });
  if (res.status >= 400) throw new Error(`TMS token isteği başarısız (HTTP ${res.status}): ${res.text.slice(0, 300)}`);

  // Token önce yanıt gövdesinde (JSON), yoksa yanıt header'ında aranır (ör. "authorization: Bearer xxx")
  const fromBody = c.tms.tokenPath
    ? getPath(res.json, c.tms.tokenPath)
    : TOKEN_CANDIDATES.map((p) => getPath(res.json, p)).find((v) => typeof v === "string");
  const fromHeader = res.headers[c.tms.tokenHeader];
  const token = String(fromBody || fromHeader || "").replace(/^Bearer\s+/i, "").trim();
  if (!token)
    throw new Error(
      `TMS yanıtında token bulunamadı (gövde veya '${c.tms.tokenHeader}' header'ı). ` +
      `TMS_TOKEN_PATH / TMS_TOKEN_HEADER ayarlayın. Yanıt: ${res.text.slice(0, 300) || "(boş gövde)"}`);

  const exp = Number(
    (c.tms.expiresPath ? getPath(res.json, c.tms.expiresPath) : EXPIRES_CANDIDATES.map((p) => getPath(res.json, p)).find((v) => v != null))
      ?? res.headers["expires_in"]
  ) || c.tms.ttl;

  // süre dolmadan 30 sn önce yenile
  cached = { token, expiresAt: Date.now() + Math.max(exp - 30, 10) * 1000 };
  if (c.debug) console.log(`[genai] token alındı, ~${exp}s geçerli`);
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
 * @param {{model?:string}} opts
 * @returns {Promise<string>} modelin cevabı
 */
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
    if (c.debug) console.log("[genai] CHAT →", c.chat.url, mask(headers));
    return httpRequest(c.chat.url, { method: "POST", headers, body, insecureTls: c.insecureTls, timeoutMs: c.timeoutMs });
  };

  let res = await send(await getToken());
  if (res.status === 401 || res.status === 403) res = await send(await getToken(true)); // token yenile, bir kez tekrar dene
  if (res.status >= 400) throw new Error(`Chat isteği başarısız (HTTP ${res.status}): ${res.text.slice(0, 400)}`);

  const reply = getPath(res.json, c.chat.replyPath);
  if (typeof reply !== "string")
    throw new Error(`Yanıtta '${c.chat.replyPath}' bulunamadı. CHAT_REPLY_PATH ayarlayın. Yanıt: ${res.text.slice(0, 300)}`);
  return reply;
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

module.exports = { chat, getToken, status, isConfigured, configProblems };
