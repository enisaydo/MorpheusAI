/*
 * Bağımlılıksız .env yükleyici.
 * Zaten tanımlı ortam değişkenlerini ezmez (Docker / systemd değerleri önceliklidir).
 */
const fs = require("fs");
const path = require("path");

const unquote = (v) => (/^(".*"|'.*')$/s.test(v) ? v.slice(1, -1) : v);

function loadEnv(file = path.join(__dirname, "..", ".env")) {
  // Podman --env-file / docker env_file tırnakları değerin parçası sayar: LDAP_BIND_DN="ou=..." → ou=...
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string" && v.length > 1) process.env[k] = unquote(v);
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

/**
 * PREFIX ile başlayan değişkenleri HTTP header'larına çevirir.
 *   CHAT_H_CLIENT_ID=abc        → client-id: abc
 *   TMS_H_X_FORWARDED_FOR=1.2.3 → x-forwarded-for: 1.2.3
 * (HTTP header adları büyük/küçük harf duyarsızdır.)
 */
function headersFromEnv(prefix) {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith(prefix) && v !== "") out[k.slice(prefix.length).toLowerCase().replace(/_/g, "-")] = v;
  }
  return out;
}

function jsonEnv(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  try { return JSON.parse(v); } catch (e) { throw new Error(`${name} geçerli JSON değil: ${e.message}`); }
}

const bool = (name) => /^(1|true|yes|on)$/i.test(process.env[name] || "");

module.exports = { loadEnv, headersFromEnv, jsonEnv, bool };
