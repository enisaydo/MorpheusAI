/*
 * LDAP ile giriş ve oturum yönetimi
 *
 *  .env (LDAP_URL doluysa giriş zorunlu olur):
 *    LDAP_URL=ldaps://dc01.kurum.local:636      (veya ldap://...:389 + LDAP_STARTTLS=true)
 *    LDAP_BIND_DN / LDAP_BIND_PASSWORD           servis hesabı (kullanıcıyı aramak için)
 *    LDAP_SEARCH_BASE=DC=kurum,DC=local
 *    LDAP_USER_FILTER=(&(objectClass=user)(sAMAccountName={{username}}))
 *    LDAP_USER_DN_TEMPLATE={{username}}@kurum.local   servis hesabı yoksa: doğrudan kullanıcıyla bind
 *    LDAP_REQUIRED_GROUP=<grup DN>                 boşsa LDAP'ta doğrulanan herkes girer
 *    LDAP_ADMIN_GROUP=<grup DN>                    limit / sistem mesajı değiştirme yetkisi (boşsa herkes)
 *
 *  Oturum: HMAC imzalı, HttpOnly çerez (SESSION_TTL_HOURS, varsayılan 8 saat).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { LdapClient, escapeFilter } = require("./ldap");
const { bool } = require("./env");

const env = (k, d = "") => process.env[k] ?? d;
const COOKIE = "morpheus_session";
const DATA_DIR = process.env.MORPHEUS_DATA_DIR || path.join(__dirname, "..", "data");

const isEnabled = () => Boolean(env("LDAP_URL")) && !/[<>]/.test(env("LDAP_URL"));

function config() {
  return {
    url: env("LDAP_URL"),
    startTls: bool("LDAP_STARTTLS"),
    insecureTls: bool("LDAP_TLS_INSECURE"),
    timeoutMs: Number(env("LDAP_TIMEOUT_MS", "10000")),
    bindDn: env("LDAP_BIND_DN"),
    bindPassword: env("LDAP_BIND_PASSWORD"),
    searchBase: env("LDAP_SEARCH_BASE"),
    userFilter: env("LDAP_USER_FILTER", "(&(objectClass=user)(sAMAccountName={{username}}))"),
    userDnTemplate: env("LDAP_USER_DN_TEMPLATE"),
    displayAttr: env("LDAP_DISPLAY_NAME_ATTR", "displayName"),
    requiredGroup: env("LDAP_REQUIRED_GROUP"),
    adminGroup: env("LDAP_ADMIN_GROUP"),
    ttlHours: Number(env("SESSION_TTL_HOURS", "8")),
  };
}

/* ------------------------------------------------------------------ */
/*  Kaba kuvvet koruması: 15 dk'da 5 hatalı deneme → 15 dk kilit       */
/* ------------------------------------------------------------------ */
const failures = new Map(); // key → { count, first, lockedUntil }
const WINDOW = 15 * 60 * 1000, MAX_FAIL = 5;

function checkLock(key) {
  const f = failures.get(key);
  if (f?.lockedUntil > Date.now()) {
    const e = new Error(`Çok fazla hatalı deneme. ${Math.ceil((f.lockedUntil - Date.now()) / 60000)} dakika sonra tekrar deneyin.`);
    e.status = 429;
    throw e;
  }
}
function noteFailure(key) {
  const now = Date.now();
  const f = failures.get(key);
  const cur = f && now - f.first < WINDOW ? f : { count: 0, first: now };
  cur.count++;
  if (cur.count >= MAX_FAIL) cur.lockedUntil = now + WINDOW;
  failures.set(key, cur);
}

/* ------------------------------------------------------------------ */
/*  LDAP doğrulama                                                     */
/* ------------------------------------------------------------------ */
const sameDn = (a, b) => a.replace(/\s*,\s*/g, ",").toLowerCase() === b.replace(/\s*,\s*/g, ",").toLowerCase();

/**
 * @returns {Promise<{username, displayName, dn, mail, isAdmin, groups:string[]}>}
 */
async function authenticate(username, password, ip) {
  username = String(username || "").trim();
  // AD boş parolayla "anonim bind"e izin verip başarı dönebilir → kesinlikle reddet
  if (!username || !password) throw Object.assign(new Error("Kullanıcı adı ve parola zorunlu"), { status: 400 });
  if (username.length > 128 || /[\0\r\n]/.test(username)) throw Object.assign(new Error("Geçersiz kullanıcı adı"), { status: 400 });

  for (const key of [`u:${username.toLowerCase()}`, `ip:${ip}`]) checkLock(key);

  const c = config();
  const client = new LdapClient({ url: c.url, startTls: c.startTls, insecureTls: c.insecureTls, timeoutMs: c.timeoutMs });
  const fail = (msg = "Kullanıcı adı veya parola hatalı") => {
    noteFailure(`u:${username.toLowerCase()}`);
    noteFailure(`ip:${ip}`);
    return Object.assign(new Error(msg), { status: 401 });
  };

  try {
    await client.connect();
    const attrs = ["distinguishedName", "sAMAccountName", "uid", "cn", "mail", "memberOf", c.displayAttr];
    const filter = c.userFilter.replace(/\{\{\s*username\s*\}\}/g, escapeFilter(username));
    let entry;

    if (c.bindDn) {
      // 1) Servis hesabıyla bağlan, kullanıcıyı bul, 2) kullanıcının DN'i + parolasıyla bind
      await client.bind(c.bindDn, c.bindPassword).catch((e) => {
        throw Object.assign(new Error(`LDAP servis hesabı bağlanamadı: ${e.message}`), { status: 502 });
      });
      const found = await client.search(c.searchBase, filter, attrs);
      if (found.length !== 1) {
        console.warn(`[auth] '${username}' için ${found.length} kayıt bulundu (filtre: ${filter})`);
        throw fail();
      }
      entry = found[0];
      try { await client.bind(entry.dn, password); }
      catch (e) { if (e.code === 49) throw fail(); throw e; }
    } else if (c.userDnTemplate) {
      // Servis hesabı yok: doğrudan kullanıcıyla bind (ör. ali@kurum.local), sonra kendi kaydını oku
      // "CN={{username}},OU=..." biçiminde DN özel karakterleri kaçışlanır; UPN (ali@kurum.local) olduğu gibi kalır
      const value = c.userDnTemplate.includes("=") ? username.replace(/[,+"\\<>;=#]/g, (ch) => "\\" + ch) : username;
      const dn = c.userDnTemplate.replace(/\{\{\s*username\s*\}\}/g, value);
      try { await client.bind(dn, password); }
      catch (e) { if (e.code === 49) throw fail(); throw e; }
      const found = c.searchBase ? await client.search(c.searchBase, filter, attrs).catch(() => []) : [];
      entry = found[0] || { dn, attrs: {} };
    } else {
      throw Object.assign(new Error("LDAP yapılandırması eksik: LDAP_BIND_DN veya LDAP_USER_DN_TEMPLATE tanımlayın"), { status: 500 });
    }

    const a = entry.attrs || {};
    const groups = a.memberof || [];
    if (c.requiredGroup && !groups.some((g) => sameDn(g, c.requiredGroup))) {
      console.warn(`[auth] '${username}' gerekli grupta değil`);
      throw Object.assign(new Error("Bu uygulamaya erişim yetkiniz yok (gerekli LDAP grubunda değilsiniz)"), { status: 403 });
    }
    failures.delete(`u:${username.toLowerCase()}`);
    const user = {
      username: (a.samaccountname || a.uid || [username])[0],
      displayName: (a[c.displayAttr.toLowerCase()] || a.cn || [username])[0],
      mail: (a.mail || [null])[0],
      dn: entry.dn,
      isAdmin: c.adminGroup ? groups.some((g) => sameDn(g, c.adminGroup)) : true,
    };
    console.log(`[auth] giriş başarılı: ${user.username}${user.isAdmin ? " (yönetici)" : ""} ip=${ip}`);
    return user;
  } catch (e) {
    if (!e.status) {
      console.error(`[auth] LDAP hatası (${username}): ${e.message}`);
      throw Object.assign(new Error(`LDAP sunucusuna ulaşılamadı veya hata döndü: ${e.message}`), { status: 502 });
    }
    if (e.status === 401) console.warn(`[auth] hatalı giriş: ${username} ip=${ip}`);
    throw e;
  } finally {
    client.close();
  }
}

/* ------------------------------------------------------------------ */
/*  Oturum çerezi (HMAC imzalı)                                        */
/* ------------------------------------------------------------------ */
let secret = null;
function getSecret() {
  if (secret) return secret;
  if (env("SESSION_SECRET")) return (secret = Buffer.from(env("SESSION_SECRET")));
  const file = path.join(DATA_DIR, "session-secret");
  try { secret = fs.readFileSync(file); }
  catch {
    secret = crypto.randomBytes(32);
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file, secret, { mode: 0o600 }); } catch {}
  }
  return secret;
}

const sign = (payload) => crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");

function createSession(user) {
  const exp = Date.now() + config().ttlHours * 3600 * 1000;
  const payload = Buffer.from(JSON.stringify({ u: user.username, n: user.displayName, a: user.isAdmin, exp })).toString("base64url");
  return { value: `${payload}.${sign(payload)}`, maxAge: Math.floor((exp - Date.now()) / 1000) };
}

function readSession(req) {
  const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [payload, mac] = m[1].split(".");
  if (!payload || !mac) return null;
  const expected = sign(payload);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!s.exp || s.exp < Date.now()) return null;
    return { username: s.u, displayName: s.n, isAdmin: Boolean(s.a), exp: s.exp };
  } catch { return null; }
}

const cookieHeader = (value, maxAge) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` + (bool("SESSION_COOKIE_SECURE") ? "; Secure" : "");

function status() {
  const c = config();
  return {
    enabled: isEnabled(),
    url: isEnabled() ? c.url.replace(/\/\/([^/]*@)?/, "//") : null,
    mode: c.bindDn ? "service-account" : c.userDnTemplate ? "direct-bind" : null,
    requiredGroup: Boolean(c.requiredGroup),
    adminGroup: Boolean(c.adminGroup),
  };
}

module.exports = { isEnabled, authenticate, createSession, readSession, cookieHeader, status };
