/*
 * Minimal LDAPv3 istemcisi (bağımlılıksız)
 *  - ldap:// (opsiyonel StartTLS) ve ldaps://
 *  - simple bind, search (equality / presence / & | ! filtreleri), unbind
 *  - Yalnızca kimlik doğrulama için gereken kısım; BER kodlaması RFC 4511'e göre
 */
const net = require("net");
const tls = require("tls");

/* ------------------------------------------------------------------ */
/*  BER                                                                */
/* ------------------------------------------------------------------ */
function encLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, value) => Buffer.concat([Buffer.from([tag]), encLen(value.length), value]);
const seq = (tag, items) => tlv(tag, Buffer.concat(items));
const str = (s, tag = 0x04) => tlv(tag, Buffer.isBuffer(s) ? s : Buffer.from(String(s), "utf8"));
function int(n, tag = 0x02) {
  const bytes = [];
  do { bytes.unshift(n & 0xff); n >>= 8; } while (n > 0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(tag, Buffer.from(bytes));
}
const bool = (b) => tlv(0x01, Buffer.from([b ? 0xff : 0x00]));

/** Tek bir TLV okur: { tag, value, next } veya tamamlanmamışsa null */
function readTlv(buf, off = 0) {
  if (buf.length < off + 2) return null;
  const tag = buf[off];
  let len = buf[off + 1], p = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error("Desteklenmeyen BER uzunluğu");
    if (buf.length < p + n) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p + i];
    p += n;
  }
  if (buf.length < p + len) return null;
  return { tag, value: buf.subarray(p, p + len), next: p + len };
}
function children(buf) {
  const out = [];
  for (let off = 0; off < buf.length;) {
    const t = readTlv(buf, off);
    if (!t) throw new Error("Bozuk BER verisi");
    out.push(t);
    off = t.next;
  }
  return out;
}
const toInt = (b) => b.reduce((n, x) => n * 256 + x, 0);

/* ------------------------------------------------------------------ */
/*  Filtre: "(&(objectClass=user)(sAMAccountName=ali))"                */
/* ------------------------------------------------------------------ */

/** RFC 4515 değer kaçışı (kullanıcı girdisi filtreye konmadan önce) */
const escapeFilter = (v) =>
  String(v).replace(/[\\*()\0]/g, (c) => "\\" + c.charCodeAt(0).toString(16).padStart(2, "0"));

/** "\2a" gibi kaçışları çözüp ham baytlara çevirir */
function unescapeValue(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(...Buffer.from(s[i], "utf8"));
  }
  return Buffer.from(bytes);
}

function parseFilter(text) {
  let i = 0;
  const s = text.trim();
  function parse() {
    if (s[i] !== "(") throw new Error(`Filtre hatası (konum ${i}): '(' bekleniyordu`);
    i++;
    const op = s[i];
    let out;
    if (op === "&" || op === "|") {
      i++;
      const items = [];
      while (s[i] === "(") items.push(parse());
      out = seq(op === "&" ? 0xa0 : 0xa1, items);
    } else if (op === "!") {
      i++;
      out = tlv(0xa2, parse());
    } else {
      const end = s.indexOf(")", i);
      if (end === -1) throw new Error("Filtre hatası: ')' eksik");
      const item = s.slice(i, end);
      const eq = item.indexOf("=");
      if (eq < 1) throw new Error(`Filtre hatası: '${item}'`);
      const attr = item.slice(0, eq), value = item.slice(eq + 1);
      if (/[~<>:]$/.test(attr)) throw new Error(`Desteklenmeyen filtre operatörü: '${item}'`);
      if (value === "*") out = tlv(0x87, Buffer.from(attr, "utf8")); // present
      else if (value.includes("*")) throw new Error(`Joker karakterli (substring) filtre desteklenmiyor: '${item}'`);
      else out = seq(0xa3, [str(attr), str(unescapeValue(value))]); // equalityMatch
      i = end;
    }
    if (s[i] !== ")") throw new Error(`Filtre hatası (konum ${i}): ')' bekleniyordu`);
    i++;
    return out;
  }
  const f = parse();
  if (i !== s.length) throw new Error("Filtre hatası: fazladan karakter");
  return f;
}

/* ------------------------------------------------------------------ */
/*  Bağlantı                                                           */
/* ------------------------------------------------------------------ */
const RESULT_TEXT = {
  0: "success", 1: "operationsError", 2: "protocolError", 8: "strongerAuthRequired", 10: "referral",
  32: "noSuchObject", 34: "invalidDNSyntax", 48: "inappropriateAuthentication", 49: "invalidCredentials",
  50: "insufficientAccessRights", 51: "busy", 52: "unavailable", 53: "unwillingToPerform",
};

class LdapError extends Error {
  constructor(code, diag, op) {
    super(`LDAP ${op}: ${RESULT_TEXT[code] || "hata"} (${code})${diag ? ` — ${diag}` : ""}`);
    this.code = code;
    this.diag = diag;
  }
}

function parseResult(value) {
  const [code, , diag] = children(value);
  return { code: toInt(code.value), diag: diag ? diag.value.toString("utf8") : "" };
}

class LdapClient {
  /** @param {{url:string, timeoutMs?:number, insecureTls?:boolean, startTls?:boolean}} opts */
  constructor(opts) {
    this.opts = { timeoutMs: 10000, ...opts };
    this.msgId = 0;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
  }

  async connect() {
    const u = new URL(this.opts.url);
    const secure = u.protocol === "ldaps:";
    if (!["ldap:", "ldaps:"].includes(u.protocol)) throw new Error(`LDAP_URL ldap:// veya ldaps:// ile başlamalı: ${this.opts.url}`);
    const port = Number(u.port) || (secure ? 636 : 389);
    const tlsOpts = { host: u.hostname, port, servername: net.isIP(u.hostname) ? undefined : u.hostname, rejectUnauthorized: !this.opts.insecureTls };
    this.socket = await new Promise((resolve, reject) => {
      const sock = secure ? tls.connect(tlsOpts) : net.connect({ host: u.hostname, port });
      const timer = setTimeout(() => { sock.destroy(); reject(new Error(`LDAP bağlantı zaman aşımı: ${u.host}`)); }, this.opts.timeoutMs);
      sock.once(secure ? "secureConnect" : "connect", () => { clearTimeout(timer); resolve(sock); });
      sock.once("error", (e) => { clearTimeout(timer); reject(friendly(e, u.hostname)); });
    });
    this.attach(this.socket);
    if (!secure && this.opts.startTls) await this.startTls(tlsOpts);
    return this;
  }

  attach(sock) {
    sock.on("data", (d) => this.onData(d));
    sock.on("error", (e) => this.failAll(friendly(e, this.opts.url)));
    sock.on("close", () => this.failAll(new Error("LDAP bağlantısı kapandı")));
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const msg = readTlv(this.buf);
      if (!msg) break;
      this.buf = this.buf.subarray(msg.next);
      try {
        const [id, op] = children(msg.value);
        const h = this.pending.get(toInt(id.value));
        if (h) h.onMessage(op);
      } catch (e) { this.failAll(e); }
    }
  }

  failAll(err) {
    for (const h of this.pending.values()) h.reject(err);
    this.pending.clear();
  }

  /** İstek gönderir; onMessage true döndürünce tamamlanır */
  send(op, onOp) {
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("LDAP isteği zaman aşımına uğradı")); }, this.opts.timeoutMs);
      const done = (fn) => (v) => { clearTimeout(timer); this.pending.delete(id); fn(v); };
      const h = { reject: done(reject) };
      h.onMessage = (o) => {
        try {
          const r = onOp(o);
          if (r !== undefined) done(resolve)(r);
        } catch (e) { done(reject)(e); }
      };
      this.pending.set(id, h);
      this.socket.write(seq(0x30, [int(id), op]));
    });
  }

  async startTls(tlsOpts) {
    await this.send(seq(0x77, [str("1.3.6.1.4.1.1466.20037", 0x80)]), (o) => {
      if (o.tag !== 0x78) throw new Error("StartTLS: beklenmeyen yanıt");
      const r = parseResult(o.value);
      if (r.code !== 0) throw new LdapError(r.code, r.diag, "StartTLS");
      return true;
    });
    const plain = this.socket;
    plain.removeAllListeners("data");
    this.socket = await new Promise((resolve, reject) => {
      const s = tls.connect({ ...tlsOpts, socket: plain });
      s.once("secureConnect", () => resolve(s));
      s.once("error", (e) => reject(friendly(e, tlsOpts.host)));
    });
    this.attach(this.socket);
  }

  bind(dn, password) {
    return this.send(seq(0x60, [int(3), str(dn), str(password, 0x80)]), (o) => {
      if (o.tag !== 0x61) throw new Error("Bind: beklenmeyen yanıt");
      const r = parseResult(o.value);
      if (r.code !== 0) throw new LdapError(r.code, r.diag, "bind");
      return true;
    });
  }

  /** @returns {Promise<{dn:string, attrs:Object<string,string[]>}[]>} */
  search(base, filter, attributes = [], { sizeLimit = 2 } = {}) {
    const entries = [];
    const req = seq(0x63, [
      str(base), int(2, 0x0a) /* wholeSubtree */, int(0, 0x0a) /* neverDerefAliases */,
      int(sizeLimit), int(Math.ceil(this.opts.timeoutMs / 1000)), bool(false),
      parseFilter(filter), seq(0x30, attributes.map((a) => str(a))),
    ]);
    return this.send(req, (o) => {
      if (o.tag === 0x64) {
        const [name, attrs] = children(o.value);
        const out = {};
        for (const a of children(attrs.value)) {
          const [type, vals] = children(a.value);
          out[type.value.toString("utf8").toLowerCase()] = children(vals.value).map((v) => v.value.toString("utf8"));
        }
        entries.push({ dn: name.value.toString("utf8"), attrs: out });
        return undefined;
      }
      if (o.tag === 0x73) return undefined; // SearchResultReference (AD referansları) yok sayılır
      if (o.tag === 0x65) {
        const r = parseResult(o.value);
        if (r.code !== 0 && !(r.code === 4 && entries.length)) throw new LdapError(r.code, r.diag, "search"); // 4 = sizeLimitExceeded
        return entries;
      }
      throw new Error(`Search: beklenmeyen yanıt (0x${o.tag.toString(16)})`);
    });
  }

  close() {
    try { this.socket?.write(seq(0x30, [int(++this.msgId), Buffer.from([0x42, 0x00])])); } catch {}
    try { this.socket?.end(); } catch {}
  }
}

function friendly(e, host) {
  if (e.code === "ENOTFOUND") return new Error(`LDAP sunucusu '${host}' çözülemedi (DNS). Tam adı kullanın veya PODMAN_ADD_HOSTS ekleyin.`);
  if (e.code === "ECONNREFUSED") return new Error(`LDAP sunucusu bağlantıyı reddetti: ${host}. Port doğru mu (389 / 636)?`);
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(e.code || "")) return new Error(`LDAP TLS sertifikası doğrulanamadı (${e.code}). LDAP_TLS_INSECURE=true ile kapatabilirsiniz.`);
  return e;
}

module.exports = { LdapClient, LdapError, escapeFilter, parseFilter, readTlv, children, seq, str, int, tlv, toInt };
