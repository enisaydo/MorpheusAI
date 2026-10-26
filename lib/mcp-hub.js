/*
 * MCP merkezi: barındırılan MCP sunucusu (/mcp, Streamable HTTP) + uzak MCP sunucularına istemci bağlantıları
 *
 *  Barındırma: POST /mcp JSON-RPC 2.0 (initialize, tools/list, tools/call, ping) — application/json yanıt, durumsuz
 *    Kimlik: Authorization: Bearer <token> — arayüzden üretilen erişim token'ları (salt-okunur seçeneği) veya .env MORPHEUS_API_TOKEN
 *    Origin: tarayıcıdan gelen isteklerde izin listesinde olmalı; CORS buna göre verilir
 *  İstemci: arayüzden eklenen uzak MCP sunucuları (ör. UnixAI OS); araçları ajana "<bağlantı>__<araç>" adıyla açılır
 *
 *  data/mcp.json (0600): { allowedOrigins[], tokens[], connections[] }
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const tools = require("./tools");
const { request } = require("./http");

const DATA_DIR = process.env.MORPHEUS_DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "mcp.json");
const MASK = "••••••••";
const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "morpheusai", title: "MorpheusAI (Ansible standartları & AAP otomasyon ajanı)", version: "2.0.0" };
const INSTRUCTIONS = "MorpheusAI kurumsal Ansible standartlarını bilen otomasyon ajanıdır: standartlara uygun playbook üretir, analiz eder, AAP'de check/çalıştırma yapar. " +
  "Doğal dille konuşmak için morpheus_agent_ask; gerçek uygulama MorpheusAI arayüzünde insan onayı gerektirir.";
const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const sha = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

function load() {
  let d = {};
  try { d = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
  return { allowedOrigins: d.allowedOrigins || [], tokens: d.tokens || [], connections: d.connections || [] };
}
function save(d) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + ".tmp", JSON.stringify(d, null, 2), { mode: 0o600 });
  fs.renameSync(FILE + ".tmp", FILE);
}
const now = () => new Date().toISOString();

/* ------------------------------------------------------------------ */
/*  Barındırma: token ve Origin                                        */
/* ------------------------------------------------------------------ */
const envTokens = () => (process.env.MORPHEUS_API_TOKEN || "").split(",").map((t) => t.trim()).filter((t) => t.length >= 16);
const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function authenticate(headers) {
  const m = String(headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const h = sha(m[1].trim());
  if (envTokens().some((t) => eq(h, sha(t))))
    return { client: String(headers["x-morpheus-client"] || "api").slice(0, 40), readonly: false, tokenId: "env", canApprove: /^(1|true|yes|on)$/i.test(process.env.REMEDIATION_ALLOW_API_APPROVE || "") };
  const d = load();
  const t = d.tokens.find((x) => eq(h, x.hash));
  if (!t) return null;
  if (!t.lastUsedAt || Date.now() - Date.parse(t.lastUsedAt) > 60000) { t.lastUsedAt = now(); save(d); }
  return { client: t.name, readonly: Boolean(t.readonly), tokenId: t.id, canApprove: Boolean(t.canApprove) };
}

function originAllowed(origin) {
  if (!origin) return true;
  const allowed = load().allowedOrigins;
  return allowed.includes("*") || allowed.map((a) => a.replace(/\/$/, "")).includes(origin.replace(/\/$/, ""));
}

function serverView(baseUrl) {
  const d = load();
  return {
    endpoint: baseUrl.replace(/\/$/, "") + "/mcp", transport: "Streamable HTTP (JSON yanıt)", protocolVersions: VERSIONS,
    allowedOrigins: d.allowedOrigins, envToken: envTokens().length > 0,
    tokens: d.tokens.map(({ hash, ...t }) => t),
    tools: tools.TOOLS.map((t) => ({ name: t.name, readonly: t.readonly, description: t.description })),
  };
}

function saveOrigins(list) {
  const clean = (list || []).map((o) => String(o).trim().replace(/\/$/, "")).filter(Boolean);
  for (const o of clean) if (o !== "*" && !/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(o)) throw httpError(400, `Geçersiz origin: ${o}`);
  const d = load();
  d.allowedOrigins = clean;
  save(d);
  return clean;
}

function createToken(name, readonly, user, canApprove = false) {
  name = String(name || "").trim().slice(0, 60);
  if (!/^[\w .@-]{2,60}$/.test(name)) throw httpError(400, "Token adı 2-60 karakter olmalı (ör. unixai, ekip-x-ajan)");
  const raw = "mph_" + crypto.randomBytes(32).toString("base64url");
  const rec = { id: crypto.randomBytes(6).toString("hex"), name, hash: sha(raw), prefix: raw.slice(0, 8), readonly: Boolean(readonly), canApprove: Boolean(canApprove) && !readonly, createdAt: now(), createdBy: user || null, lastUsedAt: null };
  const d = load();
  d.tokens.push(rec);
  save(d);
  const { hash, ...pub } = rec;
  return { ...pub, token: raw };
}

function deleteToken(id) {
  const d = load();
  if (!d.tokens.some((t) => t.id === id)) throw httpError(404, "Token bulunamadı");
  d.tokens = d.tokens.filter((t) => t.id !== id);
  save(d);
}

/* ------------------------------------------------------------------ */
/*  JSON-RPC (barındırılan /mcp)                                       */
/* ------------------------------------------------------------------ */
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleRpc(msg, principal, ai) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return err(null, -32600, "Invalid Request");
  const { id, method, params = {} } = msg;
  if (id === undefined || id === null) return null;
  switch (method) {
    case "initialize":
      return ok(id, { protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: tools.visible(principal.readonly).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: t.readonly } })) });
    case "tools/call": {
      if (!tools.BY_NAME[params.name]) return err(id, -32602, `Bilinmeyen araç: ${params.name}`);
      const ctx = { user: `mcp:${principal.client}`, client: principal.client, readonly: principal.readonly, source: `mcp:${principal.client}`, ai };
      try {
        const res = await tools.call(params.name, params.arguments || {}, ctx);
        const text = typeof res === "string" ? res : JSON.stringify(res, null, 1);
        return ok(id, { content: [{ type: "text", text }], ...(res && typeof res === "object" ? { structuredContent: Array.isArray(res) ? { items: res } : res } : {}) });
      } catch (e) {
        return ok(id, { content: [{ type: "text", text: e.message }], isError: true });
      }
    }
    default:
      return err(id, -32601, `Desteklenmeyen metot: ${method}`);
  }
}

/* ------------------------------------------------------------------ */
/*  İstemci: uzak MCP sunucuları                                       */
/* ------------------------------------------------------------------ */
const connectionsView = () => load().connections.map((c) => ({ ...c, token: c.token ? MASK : "" }));

function saveConnection(data, user) {
  const name = String(data.name || "").trim().toLowerCase();
  const url = String(data.url || "").trim();
  if (!/^[a-z][a-z0-9_-]{1,30}$/.test(name)) throw httpError(400, "Bağlantı adı küçük harf/rakam/_/- olmalı (2-31 karakter, ör. unixai)");
  try { if (!/^https?:$/.test(new URL(url).protocol)) throw 0; } catch { throw httpError(400, "MCP adresi http(s):// ile başlamalı (ör. http://unixai.kurum.local:3000/mcp)"); }
  const d = load();
  const cur = d.connections.find((c) => c.id === data.id);
  if (d.connections.some((c) => c.name === name && c !== cur)) throw httpError(409, `'${name}' adlı bağlantı zaten var`);
  const token = data.token === MASK ? cur?.token || "" : String(data.token || "").trim();
  const rec = { ...(cur || { id: crypto.randomBytes(6).toString("hex"), createdAt: now() }), name, url, token, enabled: data.enabled !== false,
    insecureTls: Boolean(data.insecureTls), description: String(data.description || "").slice(0, 200), updatedAt: now(), updatedBy: user || null };
  d.connections = cur ? d.connections.map((c) => (c === cur ? rec : c)) : [...d.connections, rec];
  save(d);
  clients.delete(rec.id);
  return { ...rec, token: rec.token ? MASK : "" };
}

function deleteConnection(id) {
  const d = load();
  if (!d.connections.some((c) => c.id === id)) throw httpError(404, "Bağlantı bulunamadı");
  d.connections = d.connections.filter((c) => c.id !== id);
  save(d);
  clients.delete(id);
}

class SessionExpired extends Error {}

class RemoteMCP {
  constructor(conn) { this.conn = conn; this.session = null; this.protocol = null; this.info = null; this.tools = null; this.toolsAt = 0; this.n = 0; this.queue = Promise.resolve(); }

  async post(msg, timeoutMs = 600000) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "x-morpheus-client": "morpheusai" };
    if (this.conn.token) headers.authorization = `Bearer ${this.conn.token}`;
    if (this.session) headers["mcp-session-id"] = this.session;
    if (this.protocol) headers["mcp-protocol-version"] = this.protocol;
    const res = await request("mcp", `mcp:${this.conn.name}:${msg.method}`, this.conn.url, { method: "POST", headers, body: JSON.stringify(msg), insecureTls: this.conn.insecureTls, timeoutMs });
    if (res.status === 404 && this.session) throw new SessionExpired();
    if (res.status >= 400) throw httpError(502, `MCP '${this.conn.name}' HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    if (res.headers["mcp-session-id"]) this.session = res.headers["mcp-session-id"];
    if (msg.id === undefined) return null;
    if (String(res.headers["content-type"] || "").includes("text/event-stream")) {
      for (const block of res.text.split("\n\n")) {
        const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        try { const j = JSON.parse(data); if (j?.id === msg.id) return j; } catch {}
      }
      throw httpError(502, `MCP '${this.conn.name}': SSE yanıtında cevap yok`);
    }
    if (!res.json) throw httpError(502, `MCP '${this.conn.name}': geçersiz yanıt: ${res.text.slice(0, 200)}`);
    return res.json;
  }

  async rpc(method, params = {}, timeoutMs) {
    const r = await this.post({ jsonrpc: "2.0", id: ++this.n, method, params }, timeoutMs);
    if (r.error) throw httpError(502, `MCP '${this.conn.name}' ${method}: ${r.error.message}`);
    return r.result || {};
  }

  async ensure() {
    if (this.info) return;
    const r = await this.rpc("initialize", { protocolVersion: VERSIONS[0], capabilities: {}, clientInfo: { name: "morpheusai", title: "MorpheusAI ajanı", version: SERVER_INFO.version } }, 30000);
    this.protocol = VERSIONS.includes(r.protocolVersion) ? r.protocolVersion : VERSIONS[0];
    this.info = { serverInfo: r.serverInfo, instructions: r.instructions, protocolVersion: this.protocol };
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, 30000);
  }

  withRetry(fn) {
    const run = async () => {
      try { await this.ensure(); return await fn(); }
      catch (e) { if (!(e instanceof SessionExpired)) throw e; this.session = null; this.info = null; await this.ensure(); return fn(); }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async listTools(maxAgeMs = 300000) {
    if (this.tools && Date.now() - this.toolsAt < maxAgeMs) return this.tools;
    this.tools = await this.withRetry(async () => {
      const out = [];
      let cursor;
      for (let i = 0; i < 10; i++) {
        const r = await this.rpc("tools/list", cursor ? { cursor } : {}, 30000);
        out.push(...(r.tools || []));
        if (!(cursor = r.nextCursor)) break;
      }
      return out;
    });
    this.toolsAt = Date.now();
    return this.tools;
  }

  call(name, args) { return this.withRetry(() => this.rpc("tools/call", { name, arguments: args || {} })); }
}

const clients = new Map();
function client(conn) {
  let c = clients.get(conn.id);
  if (!c || c.conn.url !== conn.url || c.conn.token !== conn.token) clients.set(conn.id, (c = new RemoteMCP(conn)));
  return c;
}

async function testConnection(id) {
  const d = load();
  const conn = d.connections.find((c) => c.id === id);
  if (!conn) throw httpError(404, "Bağlantı bulunamadı");
  clients.delete(id);
  const cl = client(conn);
  let res;
  try {
    const t = await cl.listTools(0);
    res = { ok: true, server: cl.info, tools: t.map((x) => ({ name: x.name, description: String(x.description || "").slice(0, 300) })) };
  } catch (e) { res = { ok: false, error: e.message }; }
  const d2 = load();
  const c2 = d2.connections.find((c) => c.id === id);
  if (c2) { c2.lastTest = { at: now(), ok: res.ok, tools: res.tools?.length || 0, error: res.error || null, server: res.server?.serverInfo || null }; save(d2); }
  return res;
}

const exposed = (conn, tool) => `${conn}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

async function remoteTools({ includeAgent = true } = {}) {
  const out = [];
  for (const conn of load().connections.filter((c) => c.enabled !== false)) {
    try {
      for (const t of await client(conn).listTools()) {
        const agent = t.name.endsWith("agent_ask");
        if (agent && !includeAgent) continue;
        out.push({ exposed: exposed(conn.name, t.name), conn, tool: t.name, agent, description: `[${conn.name}] ${t.description || ""}`.slice(0, 1000), inputSchema: t.inputSchema || { type: "object", properties: {} } });
      }
    } catch (e) { console.warn(`[mcp] '${conn.name}' araçları alınamadı: ${e.message}`); }
  }
  return out;
}

async function callRemote(conn, tool, args) {
  const live = require("./live");
  const rId = live.rid(), t0 = Date.now();
  live.publish("mcp", { dir: "giden", peer: conn.name, method: "tools/call", tool, args: live.argsPreview(args), phase: "start", rid: rId });
  let r;
  try { r = await client(conn).call(tool, args); }
  catch (e) {
    live.publish("mcp", { dir: "giden", peer: conn.name, method: "tools/call", tool, phase: "end", rid: rId, ok: false, durationMs: Date.now() - t0, error: live.short(e.message, 200) });
    throw e;
  }
  live.publish("mcp", { dir: "giden", peer: conn.name, method: "tools/call", tool, phase: "end", rid: rId, ok: !r.isError, durationMs: Date.now() - t0 });
  const data = r.structuredContent ?? (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (r.isError) throw httpError(502, `[${conn.name}] ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

module.exports = {
  authenticate, originAllowed, serverView, saveOrigins, createToken, deleteToken, handleRpc,
  connectionsView, saveConnection, deleteConnection, testConnection, remoteTools, callRemote, VERSIONS,
};
