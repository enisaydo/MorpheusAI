/*
 * LDAP ile giriş ve oturum yönetimi
 *
 *  .env — üç değer yeterli (LDAP_SERVER doluysa giriş zorunlu olur):
 *    LDAP_SERVER=dc01.kurum.local            ad, ad:port veya ldap(s)://ad:port  (636 → otomatik ldaps)
 *    LDAP_BASE_DN=DC=kurum,DC=local          kullanıcıların aranacağı kök
 *    LDAP_BIND_DN=...
 *        {{username}} İÇERİYORSA → kullanıcı kendi parolasıyla doğrudan bağlanır (servis hesabı gerekmez)
 *            ör. {{username}}@kurum.local  |  KURUM\{{username}}  |  uid={{username}},ou=people,dc=kurum,dc=local
 *        sabit bir DN İSE → kullanıcı LDAP_BASE_DN altında aranır (LDAP_BIND_PASSWORD varsa bu hesapla,
 *            yoksa anonim), sonra kullanıcının kendi parolasıyla doğrulanır
 *
 *  Opsiyonel: LDAP_USER_FILTER, LDAP_REQUIRED_GROUP, LDAP_ADMIN_GROUP, LDAP_STARTTLS, LDAP_TLS_INSECURE,
 *             LDAP_DISPLAY_NAME_ATTR. Eski adlar (LDAP_URL, LDAP_SEARCH_BASE, LDAP_USER_DN_TEMPLATE) da geçerli.
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

/** "dc01" | "dc01:636" | "ldaps://dc01" → tam LDAP URL'i */
function normalizeServer(v) {
  v = String(v || "").trim();
  if (!v) return "";
  if (/^ldaps?:\/\//i.test(v)) return v;
  const port = v.match(/:(\d+)$/)?.[1];
  return `${port === "636" || port === "3269" ? "ldaps" : "ldap"}://${v}`;
}

const rawServer = () => env("LDAP_SERVER") || env("LDAP_URL");
const isEnabled = () => Boolean(rawServer()) && !/[<>]/.test(rawServer());

/* {{username}}, {username}, %s ve %u yer tutucularını aynı biçime çevirir */
const PLACEHOLDER = /\{\{\s*username\s*\}\}|\{username\}|%s|%u/g;
const hasPlaceholder = (s) => new RegExp(PLACEHOLDER.source).test(s || "");
const withUser = (template, value) => String(template).replace(PLACEHOLDER, () => value);

// AD (sAMAccountName / UPN) ve OpenLDAP (uid) için çalışan varsayılan filtre
const DEFAULT_FILTER = "(|(sAMAccountName={{username}})(userPrincipalName={{username}})(uid={{username}}))";

/** DN'in ilk RDN tipi: "OU=All users,DC=..." → "ou" */
const firstRdnType = (dn) => (String(dn).match(/^\s*([A-Za-z]+)\s*=/)?.[1] || "").toLowerCase();
/** DC bileşenlerinden alan adı: "OU=x,DC=fw,DC=kurum,DC=com" → "fw.kurum.com" */
const domainOf = (dn) => [...String(dn).matchAll(/(?:^|,)\s*DC\s*=\s*([^,]+)/gi)].map((m) => m[1].trim()).join(".");

function config() {
  const bindDnRaw = env("LDAP_BIND_DN");
  const bindIsTemplate = hasPlaceholder(bindDnRaw);
  // LDAP_BIND_DN bir hesap değil de kapsayıcı (OU/DC) ise: kullanıcılar burada; giriş kullanici@alanadi ile
  const bindIsContainer = !bindIsTemplate && ["ou", "dc", "o", "c"].includes(firstRdnType(bindDnRaw));
  const baseDn = env("LDAP_BASE_DN") || env("LDAP_SEARCH_BASE");
  const upnSuffix = env("LDAP_UPN_SUFFIX") || domainOf(bindDnRaw) || domainOf(baseDn);
  return {
    url: normalizeServer(rawServer()),
    startTls: bool("LDAP_STARTTLS"),
    insecureTls: bool("LDAP_TLS_INSECURE"),
    timeoutMs: Number(env("LDAP_TIMEOUT_MS", "10000")),
    // Sabit hesap DN'i → servis hesabı / anonim arama; şablon veya OU → kullanıcının kendisiyle doğrudan bind
    bindDn: bindIsTemplate || bindIsContainer ? "" : bindDnRaw,
    bindPassword: env("LDAP_BIND_PASSWORD"),
    searchBase: bindIsContainer ? bindDnRaw : baseDn,
    userFilter: env("LDAP_USER_FILTER") || DEFAULT_FILTER,
    userDnTemplate: bindIsTemplate ? bindDnRaw
      : bindIsContainer ? `{{username}}@${upnSuffix}`
      : env("LDAP_USER_DN_TEMPLATE"),
    upnBind: bindIsContainer,
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
    // "ali@kurum.local" veya "KURUM\ali" yazılırsa aramada yalın kullanıcı adı (sAMAccountName) kullanılır
    const plainName = username.includes("\\") ? username.split("\\").pop() : username.includes("@") ? username.split("@")[0] : username;
    const filter = withUser(c.userFilter, escapeFilter(plainName));
    const cfgError = (msg) => Object.assign(new Error(`LDAP yapılandırması eksik: ${msg}`), { status: 500 });
    if (c.bindDn && !c.searchBase) throw cfgError("kullanıcıyı aramak için LDAP_BASE_DN gerekli.");
    let entry;

    if (c.bindDn) {
      // 1) Kullanıcıyı bul (parola varsa servis hesabıyla, yoksa anonim), 2) kullanıcının DN'i + parolasıyla bind
      // Not: DN + boş parola ile bind "kimliksiz bind"dir ve çoğu sunucu reddeder; parola yoksa bind
      // hiç yapılmaz, LDAPv3 bağlantısı anonim olarak arama yapar.
      if (c.bindPassword) {
        await client.bind(c.bindDn, c.bindPassword).catch((e) => {
          throw Object.assign(new Error(`LDAP servis hesabı bağlanamadı: ${e.message}`), { status: 502 });
        });
      }
      const found = await client.search(c.searchBase, filter, attrs).catch((e) => {
        if (!c.bindPassword && [1, 48, 50, 53].includes(e.code))
          throw Object.assign(new Error(
            "LDAP sunucusu parolasız (anonim) aramaya izin vermiyor. LDAP_BIND_PASSWORD girin " +
            "veya LDAP_BIND_DN'e {{username}} içeren şablon yazın (ör. {{username}}@kurum.local)."), { status: 502 });
        throw e;
      });
      if (!found.length && !c.bindPassword)
        console.warn(`[auth] anonim aramada '${username}' bulunamadı; sunucu anonim aramada kayıtları gizliyor olabilir`);
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
      const isDnTemplate = c.userDnTemplate.includes("=");
      const value = isDnTemplate ? username.replace(/[,+"\\<>;=#]/g, (ch) => "\\" + ch) : plainName;
      // UPN / DOMAIN\ şablonunda kullanıcı zaten tam biçimi yazdıysa (ali@kurum.local, KURUM\ali) olduğu gibi kullan
      const dn = !isDnTemplate && /[@\\]/.test(username) ? username : withUser(c.userDnTemplate, value);
      try { await client.bind(dn, password); }
      catch (e) { if (e.code === 49) throw fail(); throw e; }
      const found = c.searchBase ? await client.search(c.searchBase, filter, attrs).catch(() => []) : [];
      entry = found[0] || { dn, attrs: {} };
    } else {
      throw cfgError("LDAP_BIND_DN tanımlayın (ör. {{username}}@kurum.local).");
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
    mode: c.bindDn ? (c.bindPassword ? "service-account" : "anonymous-search")
      : c.upnBind ? `upn-bind (${c.userDnTemplate.replace("{{username}}", "kullanici")}, arama: ${c.searchBase})`
      : c.userDnTemplate ? "direct-bind" : null,
    requiredGroup: Boolean(c.requiredGroup),
    adminGroup: Boolean(c.adminGroup),
  };
}

module.exports = { isEnabled, authenticate, createSession, readSession, cookieHeader, status };
