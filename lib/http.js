/*
 * Ortak HTTP istemcisi (bağımlılıksız)
 *  - https/http, gzip/br/deflate çözme, zaman aşımı, TLS doğrulamasını kapatma seçeneği
 *  - Her çağrı lib/logger ile kayıt altına alınır (gizli alanlar maskelenir)
 *  - Ortam proxy değişkenleri (http_proxy) kullanılmaz: kurum içi servislere doğrudan gidilir
 */
const https = require("https");
const http = require("http");
const zlib = require("zlib");
const logger = require("./logger");

const TLS_ERRORS = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_UNTRUSTED",
]);

function rawRequest(url, { method = "GET", headers = {}, body, insecureTls, timeoutMs = 60000, tlsHint }) {
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
    req.on("error", (e) => {
      if (TLS_ERRORS.has(e.code)) e.message += ` (${u.host}). ${tlsHint || "TLS doğrulamasını kapatmak için ilgili *_TLS_INSECURE=true ayarını kullanın."}`;
      if (e.code === "ENOTFOUND" || e.code === "EAI_AGAIN")
        e.message =
          `'${u.hostname}' adı çözülemedi (DNS: ${e.code}). ` +
          (u.hostname.includes(".") ? "" : "Kısa ad yerine tam adı (FQDN, ör. sunucu.kurum.local) kullanın. ") +
          `Sunucuda 'getent hosts ${u.hostname}' ile kontrol edin; gerekirse .env'e PODMAN_ADD_HOSTS=${u.hostname}:<ip> ekleyin.`;
      if (e.code === "ECONNREFUSED") e.message = `${u.host} bağlantıyı reddetti (ECONNREFUSED). Adres/port doğru mu?`;
      reject(e);
    });
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * İsteği atar ve loglar.
 * @param {string} service  "genai" | "aap"
 * @param {string} kind     "tms-token" | "chat" | "job_templates" ...
 * @param {(res)=>object} [metaFn]  yanıttan log'a eklenecek ek bilgi (ör. token kullanımı)
 */
async function request(service, kind, url, opts = {}, metaFn) {
  const started = Date.now();
  const log = (fields) =>
    logger.record({
      service, kind, url,
      method: opts.method || "GET",
      requestHeaders: opts.headers,
      requestBody: opts.body,
      durationMs: Date.now() - started,
      ...fields,
    });
  try {
    const res = await rawRequest(url, opts);
    let meta = null;
    try { meta = metaFn ? metaFn(res) : null; } catch {}
    log({ status: res.status, responseHeaders: res.headers, responseBody: res.text, meta });
    return res;
  } catch (e) {
    log({ error: e.message });
    throw e;
  }
}

module.exports = { request };
