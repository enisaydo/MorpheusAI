/*
 * MorpheusAI - sunucu (bağımlılıksız, sadece Node.js)
 *
 *  - public/ klasörünü statik olarak sunar
 *  - /api/* uç noktalarını üç moddan biriyle karşılar:
 *      genai : .env'deki TMS token + chat/completions ayarlarıyla kurumsal GenAI'a gider
 *      proxy : AI_BACKEND_URL tanımlıysa tüm /api/* isteklerini oraya iletir
 *      demo  : hiçbiri yoksa mock veri + kural motoru
 *    MORPHEUS_MODE ile mod zorlanabilir (demo | genai | proxy).
 *
 *  Çalıştırma:   node server.js     (ayarlar .env dosyasından okunur)
 */
const { loadEnv } = require("./lib/env");
loadEnv();

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const demo = require("./lib/demo");
const analyzer = require("./lib/analyzer");
const genai = require("./lib/genai");
const aap = require("./lib/aap");
const logger = require("./lib/logger");
const prompts = require("./lib/prompts");
const usage = require("./lib/usage");
const history = require("./lib/history");

const auth = require("./lib/auth");
const remediation = require("./lib/remediation");
const agent = require("./lib/agent");
const mcpHub = require("./lib/mcp-hub");
const crypto = require("crypto");

/* Servisler arası erişim (UnixAI OS köprüsü, MCP sunucusu): Authorization: Bearer <MORPHEUS_API_TOKEN>
 * Virgülle birden fazla token verilebilir. API kullanıcısı düzeltme oluşturup check modda çalıştırabilir;
 * gerçek çalıştırma onayı yalnızca arayüzden verilir (REMEDIATION_ALLOW_API_APPROVE=true değilse). */
const API_TOKENS = (process.env.MORPHEUS_API_TOKEN || "").split(",").map((t) => t.trim()).filter((t) => t.length >= 16);
function apiSession(req) {
  const m = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!m || !API_TOKENS.length) return null;
  const given = crypto.createHash("sha256").update(m[1].trim()).digest();
  const ok = API_TOKENS.some((t) => crypto.timingSafeEqual(given, crypto.createHash("sha256").update(t).digest()));
  return ok ? { username: String(req.headers["x-morpheus-client"] || "api").slice(0, 40), displayName: "API", isAdmin: false, isApi: true } : null;
}

/* Kullanıcı kimliği:
 *   LDAP açıksa → oturumdaki kullanıcı (doğrulanmış)
 *   değilse     → güvenilen proxy header'ı (USER_HEADER) veya arayüzün gönderdiği X-Morpheus-User */
const USER_HEADER = (process.env.USER_HEADER || "").toLowerCase();
const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
function whoIs(req, session) {
  const ip = clientIp(req);
  if (session) return { user: session.username, displayName: session.displayName, isAdmin: session.isAdmin, ip };
  const raw = (USER_HEADER && req.headers[USER_HEADER]) || req.headers["x-morpheus-user"] || "";
  let user = "";
  try { user = decodeURIComponent(String(raw)).trim().slice(0, 80); } catch { user = String(raw).slice(0, 80); }
  return { user: user || `anonim (${ip})`, ip, isAdmin: true };
}

/* LDAP açıkken oturum gerektirmeyen uç noktalar */
const PUBLIC_ROUTES = new Set(["POST /api/auth/login", "POST /api/auth/logout", "GET /api/auth/me", "GET /api/health"]);
/* Yönetici yetkisi gereken uç noktalar (LDAP_ADMIN_GROUP tanımlıysa) */
const ADMIN_ROUTES = new Set(["POST /api/limits", "POST /api/prompts", "POST /api/agent/settings", "POST /api/mcp/origins", "POST /api/mcp/tokens", "POST /api/mcp/connections"]);
const isAdminRoute = (route, pathname, method) => ADMIN_ROUTES.has(route) || (method !== "GET" && /^\/api\/mcp\//.test(pathname));

const PORT = process.env.PORT || 3000;
const AI_BACKEND_URL = process.env.AI_BACKEND_URL || "";
const MODE = resolveMode();

/* Yapılandırma eksik/hatalıysa çökmek yerine demo moduna düşer. */
function resolveMode() {
  const wanted = process.env.MORPHEUS_MODE || (AI_BACKEND_URL ? "proxy" : genai.isConfigured() ? "genai" : "demo");
  if (wanted === "genai" && !genai.isConfigured()) {
    console.warn("[uyarı] GenAI ayarları geçersiz, DEMO moduna geçiliyor:\n  - " + genai.configProblems().join("\n  - "));
    return "demo";
  }
  if (wanted === "proxy" && !AI_BACKEND_URL) {
    console.warn("[uyarı] MORPHEUS_MODE=proxy ama AI_BACKEND_URL boş, DEMO moduna geçiliyor");
    return "demo";
  }
  if (wanted === "demo" && !process.env.MORPHEUS_MODE && process.env.TMS_TOKEN_URL)
    console.warn("[bilgi] GenAI ayarları tamamlanmamış, DEMO modunda çalışılıyor:\n  - " + genai.configProblems().join("\n  - "));
  return wanted;
}
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const STANDARDS = require("./mock/standards.json");
const TEMPLATES = require("./mock/templates.json");
const WORKFLOWS = require("./mock/workflows.json");

/* Katalog: AAP ayarlıysa AAP API'si, değilse mock veri */
const CATALOG = aap.isConfigured() ? "aap" : "mock";
const catalog = {
  templates: () => (CATALOG === "aap" ? aap.listJobTemplates() : TEMPLATES.map(({ content, ...t }) => ({ ...t, source: "mock" }))),
  template: (id) => (CATALOG === "aap" ? aap.getJobTemplate(id) : TEMPLATES.find((x) => x.id === id)),
  workflows: () =>
    CATALOG === "aap" ? aap.listWorkflows() : WORKFLOWS.map(({ nodes, ...w }) => ({ ...w, nodeCount: nodes.length, source: "mock" })),
  workflow: (id) => (CATALOG === "aap" ? aap.getWorkflow(id) : WORKFLOWS.find((x) => x.id === id)),
};

/* Listelerdeki "uyum" sütunu: analiz geçmişindeki son skor (yeniden başlatmada korunur) */
const withScore = (kind, list) =>
  list.map((x) => {
    const l = history.latestScore(kind, x.id);
    return { ...x, lastScore: l ? l.score : x.source === "mock" ? x.lastScore : null, lastAnalyzedAt: l?.time || null };
  });

/** Analiz sonucunu geçmişe yazar ve sonucu (geçmiş kaydının id'siyle) döndürür */
function remember(kind, json, result, who) {
  const row = history.record({
    kind,
    targetId: kind === "template" ? json.templateId : json.workflowId,
    targetName: kind === "template" ? json.title : json.workflow?.name,
    content: kind === "template" ? json.content : JSON.stringify(json.workflow?.nodes || []),
    result,
    user: who.user,
    ip: who.ip,
    rules: json.rules,
    prompt: json.prompt,
  });
  return { ...result, historyId: row.id, analyzedAt: row.time };
}

/* ------------------------------------------------------------------ */
/*  HTTP                                                               */
/* ------------------------------------------------------------------ */

function sendJson(res, code, data) {
  res.writeHead(code, { "Content-Type": MIME[".json"] });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 5e6) reject(new Error("Body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function proxy(req, res, body) {
  const target = new URL(req.url, AI_BACKEND_URL);
  try {
    const r = await fetch(target, {
      method: req.method,
      headers: {
        "Content-Type": req.headers["content-type"] || "application/json",
        ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
      },
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
    });
    res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") || MIME[".json"] });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    sendJson(res, 502, { error: "AI backend'e ulaşılamadı", detail: e.message });
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function health(url) {
  const deep = Boolean(url.searchParams.get("deep"));
  const out = { status: "ok", mode: MODE, catalog: CATALOG, aap: aap.status(), auth: auth.status(),
    agent: { mode: agent.settings().mode, detected: agent.settings().detected, connections: mcpHub.connectionsView().length } };
  if (CATALOG === "aap" && deep) {
    try { const info = await aap.check(); out.aap = { ...aap.status(), check: "ok", ...info }; }
    catch (e) { out.status = "degraded"; out.aap = { ...aap.status(), check: "failed", error: e.message }; }
  }
  if (MODE === "proxy") out.backend = AI_BACKEND_URL;
  if (MODE === "genai") {
    out.genai = genai.status();
    if (deep) {
      try {
        await genai.getToken(true);
        out.genai = { ...genai.status(), tokenCheck: "ok" };
      } catch (e) {
        out.status = "degraded";
        out.genai = { ...genai.status(), tokenCheck: "failed", error: e.message };
      }
    }
  }
  return out;
}

/** Katalogdan tek kayıt döndürür; bulunamazsa 404 ve anlaşılır mesaj. */
async function sendDetail(res, label, fetchFn) {
  const notFound = CATALOG === "aap"
    ? `${label} AAP'de bulunamadı veya bu kullanıcının erişimi yok`
    : `${label} bulunamadı (AAP bağlı değil — .env'de AAP_URL/AAP_TOKEN tanımlayın; şu an örnek veri kullanılıyor)`;
  try {
    const item = await fetchFn();
    return item ? sendJson(res, 200, item) : sendJson(res, 404, { error: notFound });
  } catch (e) {
    if (/\(404\)/.test(e.message)) return sendJson(res, 404, { error: `${notFound}. ${e.message}` });
    throw e;
  }
}

async function handleApi(req, res, url) {
  const body = ["POST", "DELETE"].includes(req.method) ? await readBody(req) : "";
  let json;
  try { json = body ? JSON.parse(body) : {}; } catch { return sendJson(res, 400, { error: "Geçersiz JSON gövdesi" }); }
  const route = `${req.method} ${url.pathname}`;

  /* ---- Kimlik doğrulama (LDAP) ---- */
  const api = apiSession(req);
  if (req.headers.authorization && /^Bearer\s/i.test(req.headers.authorization) && API_TOKENS.length && !api && url.pathname.startsWith("/api/remediations"))
    return sendJson(res, 401, { error: "Geçersiz API token" });
  const session = api || (auth.isEnabled() ? auth.readSession(req) : null);
  switch (route) {
    case "POST /api/auth/login": {
      if (!auth.isEnabled()) return sendJson(res, 400, { error: "LDAP girişi etkin değil" });
      try {
        const user = await auth.authenticate(json.username, json.password, clientIp(req));
        const s = auth.createSession(user);
        res.setHeader("Set-Cookie", auth.cookieHeader(s.value, s.maxAge));
        return sendJson(res, 200, { enabled: true, user: { username: user.username, displayName: user.displayName, isAdmin: user.isAdmin } });
      } catch (e) {
        return sendJson(res, e.status || 500, { error: e.message });
      }
    }
    case "POST /api/auth/logout":
      res.setHeader("Set-Cookie", auth.cookieHeader("", 0));
      return sendJson(res, 200, { ok: true });
    case "GET /api/auth/me":
      if (!auth.isEnabled()) return sendJson(res, 200, { enabled: false });
      return session
        ? sendJson(res, 200, { enabled: true, user: { username: session.username, displayName: session.displayName, isAdmin: session.isAdmin } })
        : sendJson(res, 401, { enabled: true, authRequired: true, error: "Oturum açmanız gerekiyor" });
  }
  if (auth.isEnabled() && !session && (!PUBLIC_ROUTES.has(route) || url.searchParams.get("deep")))
    return sendJson(res, 401, { authRequired: true, error: "Oturum açmanız gerekiyor" });
  if (isAdminRoute(route, url.pathname, req.method) && session && !session.isAdmin)
    return sendJson(res, 403, { error: "Bu işlem için yönetici yetkisi gerekiyor (LDAP yönetici grubu)" });

  if (MODE === "proxy" && url.pathname !== "/api/health") return proxy(req, res, body);
  const ai = MODE === "genai";
  const who = whoIs(req, session);
  if (api) who.isApi = true;

  switch (route) {
    case "GET /api/health":
      return sendJson(res, 200, await health(url));
    case "GET /api/standards":
      return sendJson(res, 200, STANDARDS);
    case "GET /api/templates":
      return sendJson(res, 200, withScore("template", await catalog.templates()));
    case "GET /api/workflows":
      return sendJson(res, 200, withScore("workflow", await catalog.workflows()));
    case "GET /api/prompts":
      return sendJson(res, 200, { ...prompts.get(), defaults: prompts.DEFAULTS });
    case "POST /api/prompts":
      try { return sendJson(res, 200, prompts.save(json)); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    case "GET /api/usage":
      return sendJson(res, 200, usage.report({
        from: url.searchParams.get("from"), to: url.searchParams.get("to"),
        user: url.searchParams.get("user") || undefined, kind: url.searchParams.get("kind") || undefined,
      }));
    case "GET /api/history": {
      const q = (k) => url.searchParams.get(k) || undefined;
      return sendJson(res, 200, history.query({ from: q("from"), to: q("to"), kind: q("kind"), user: q("user"), target: q("target"), rule: q("rule") }));
    }
    case "GET /api/usage/today":
      return sendJson(res, 200, { ...usage.today(who.user), mode: MODE });
    case "GET /api/limits":
      return sendJson(res, 200, usage.getLimits());
    case "POST /api/limits":
      try { return sendJson(res, 200, usage.saveLimits(json, who.user)); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    case "GET /api/agent/settings":
      return sendJson(res, 200, { ...agent.settings(), defaults: agent.DEFAULTS });
    case "POST /api/agent/settings":
      return sendJson(res, 200, agent.saveSettings(json, who.user));
    case "GET /api/agent/conversations":
      return sendJson(res, 200, agent.conversations(Number(url.searchParams.get("limit") || 100)));
    case "GET /api/mcp/server": {
      const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
      return sendJson(res, 200, mcpHub.serverView(`${req.headers["x-forwarded-proto"] || "http"}://${host}`));
    }
    case "POST /api/mcp/origins":
      return sendJson(res, 200, { allowedOrigins: mcpHub.saveOrigins(json.allowedOrigins) });
    case "POST /api/mcp/tokens":
      return sendJson(res, 201, mcpHub.createToken(json.name, json.readonly, who.user));
    case "GET /api/mcp/connections":
      return sendJson(res, 200, mcpHub.connectionsView());
    case "POST /api/mcp/connections":
      return sendJson(res, 200, mcpHub.saveConnection(json, who.user));
    case "GET /api/remediations":
      return sendJson(res, 200, { items: remediation.list({ status: url.searchParams.get("status") || undefined, server: url.searchParams.get("server") || undefined }), config: remediation.config() });
    case "POST /api/remediations":
      return sendJson(res, 201, await remediation.create(json, STANDARDS, who, { ai: MODE === "genai" }));
    case "GET /api/logs":
      return sendJson(res, 200, logger.list({ limit: Number(url.searchParams.get("limit") || 100), service: url.searchParams.get("service") || undefined }));
    case "POST /api/analyze/template":
      if (!json.content) return sendJson(res, 400, { error: "content zorunlu" });
      if (ai) return sendJson(res, 200, remember("template", json, await analyzer.analyzeTemplate(json, STANDARDS, who), who));
      await delay(900);
      return sendJson(res, 200, remember("template", json, demo.analyzeTemplate(json.content, json.rules), who));
    case "POST /api/analyze/workflow":
      if (!json.workflow) return sendJson(res, 400, { error: "workflow zorunlu" });
      if (ai) return sendJson(res, 200, remember("workflow", json, await analyzer.analyzeWorkflow(json, STANDARDS, who), who));
      await delay(900);
      return sendJson(res, 200, remember("workflow", json, demo.analyzeWorkflow(json.workflow, json.rules), who));
    case "POST /api/chat":
      if (ai && json.agent !== false) {
        const ctxText = json.context ? (json.context.kind === "template" ? `Template: ${json.context.name}\n${json.context.content}`
          : json.context.kind === "workflow" ? `Workflow: ${json.context.name}\n${JSON.stringify(json.context.workflow)}` : `Son analiz: ${JSON.stringify(json.context)}`) : null;
        const r = await agent.run(json.messages || [], { ctx: { user: who.user, ip: who.ip, source: "arayüz", ai, readonly: false }, origin: who.user, context: ctxText ? { text: ctxText } : null });
        return sendJson(res, 200, { ...r, engine: "agent" });
      }
      if (ai) return sendJson(res, 200, await analyzer.chat(json, STANDARDS, who));
      await delay(600);
      return sendJson(res, 200, demo.chatReply(json.messages || [], json.context));
  }

  let m;
  if (req.method === "GET" && (m = url.pathname.match(/^\/api\/templates\/(.+)$/))) {
    return sendDetail(res, "Job template", () => catalog.template(decodeURIComponent(m[1])));
  }
  if (req.method === "GET" && (m = url.pathname.match(/^\/api\/workflows\/(.+)$/))) {
    return sendDetail(res, "Workflow", () => catalog.workflow(decodeURIComponent(m[1])));
  }
  if (req.method === "GET" && (m = url.pathname.match(/^\/api\/history\/(.+)$/))) {
    const h = history.get(decodeURIComponent(m[1]));
    return h ? sendJson(res, 200, h) : sendJson(res, 404, { error: "Analiz kaydı bulunamadı" });
  }
  if (req.method === "GET" && (m = url.pathname.match(/^\/api\/agent\/conversations\/([0-9a-f]{16})$/))) {
    const c = agent.conversation(m[1]);
    return c ? sendJson(res, 200, c) : sendJson(res, 404, { error: "Konuşma bulunamadı" });
  }
  if (req.method === "DELETE" && (m = url.pathname.match(/^\/api\/mcp\/tokens\/([0-9a-f]{12})$/))) {
    mcpHub.deleteToken(m[1]);
    return sendJson(res, 200, { ok: true });
  }
  if ((m = url.pathname.match(/^\/api\/mcp\/connections\/([0-9a-f]{12})(\/test)?$/))) {
    if (req.method === "DELETE" && !m[2]) { mcpHub.deleteConnection(m[1]); return sendJson(res, 200, { ok: true }); }
    if (req.method === "POST" && m[2]) return sendJson(res, 200, await mcpHub.testConnection(m[1]));
  }
  if ((m = url.pathname.match(/^\/api\/remediations\/([\w-]+)(?:\/(approve|reject|launch|jobs\/(\d+)\/stdout))?$/))) {
    const id = m[1], sub = m[2];
    if (req.method === "GET" && !sub) {
      const r = await remediation.get(id);
      return r ? sendJson(res, 200, r) : sendJson(res, 404, { error: "Düzeltme kaydı bulunamadı" });
    }
    if (req.method === "GET" && m[3]) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end(await remediation.stdout(id, m[3]));
    }
    if (req.method === "POST" && (sub === "approve" || sub === "reject")) {
      if (who.isApi && !/^(1|true|yes|on)$/i.test(process.env.REMEDIATION_ALLOW_API_APPROVE || ""))
        return sendJson(res, 403, { error: "Onay/ret yalnızca Morpheus arayüzünden verilebilir (REMEDIATION_ALLOW_API_APPROVE kapalı)" });
      if (session && !session.isAdmin && !who.isApi) return sendJson(res, 403, { error: "Onay için yönetici yetkisi gerekiyor" });
      return sendJson(res, 200, sub === "approve" ? remediation.approve(id, who) : remediation.reject(id, who, json.reason));
    }
    if (req.method === "POST" && sub === "launch")
      return sendJson(res, 202, await remediation.launch(id, { mode: json.mode === "run" ? "run" : "check", allowDisruptive: json.allowDisruptive === true }, who));
  }
  if (req.method === "GET" && (m = url.pathname.match(/^\/api\/logs\/(.+)$/))) {
    const e = logger.get(decodeURIComponent(m[1]));
    return e ? sendJson(res, 200, e) : sendJson(res, 404, { error: "Log kaydı bulunamadı" });
  }
  sendJson(res, 404, { error: "Bilinmeyen uç nokta", route });
}

/* ------------------------------------------------------------------ */
/*  Barındırılan MCP sunucusu (Streamable HTTP, JSON yanıt, durumsuz)  */
/* ------------------------------------------------------------------ */
function corsHeaders(origin) {
  return origin ? {
    "Access-Control-Allow-Origin": origin, Vary: "Origin", "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, accept, mcp-session-id, mcp-protocol-version",
    "Access-Control-Expose-Headers": "mcp-session-id", "Access-Control-Max-Age": "600",
  } : {};
}

async function handleMcp(req, res) {
  const origin = req.headers.origin;
  const reply = (code, data, extra = {}) => {
    res.writeHead(code, { ...corsHeaders(origin), ...extra, ...(data === undefined ? { "Content-Length": 0 } : { "Content-Type": MIME[".json"] }) });
    res.end(data === undefined ? undefined : JSON.stringify(data));
  };
  if (!mcpHub.originAllowed(origin)) return reply(403, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Origin izinli değil (Ajan & MCP → İzinli alanlar)" } });
  if (req.method === "OPTIONS") return reply(204);
  if (req.method === "GET") return reply(405, { error: "Bu sunucu yalnızca POST (JSON yanıt) destekler" }, { Allow: "POST" });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
  const principal = mcpHub.authenticate(req.headers);
  if (!principal) return reply(401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Geçersiz veya eksik token (Authorization: Bearer)" } }, { "WWW-Authenticate": 'Bearer realm="morpheusai"' });
  let msg;
  try { msg = JSON.parse(await readBody(req)); } catch { return reply(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  const ai = MODE === "genai";
  const out = Array.isArray(msg)
    ? (await Promise.all(msg.map((x) => mcpHub.handleRpc(x, principal, ai)))).filter(Boolean)
    : await mcpHub.handleRpc(msg, principal, ai);
  if (!out || (Array.isArray(out) && !out.length)) return reply(202);
  return reply(200, out);
}

function serveStatic(req, res, url) {
  let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  let file = path.join(PUBLIC_DIR, p || "index.html");
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "Forbidden" });
  fs.stat(file, (err, st) => {
    if (err || st.isDirectory()) file = path.join(PUBLIC_DIR, "index.html");
    fs.readFile(file, (e, data) => {
      if (e) return sendJson(res, 404, { error: "Not found" });
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  });
}

const server = http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname === "/mcp") return await handleMcp(req, res);
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      serveStatic(req, res, url);
    } catch (e) {
      console.error(`[api] ${req.method} ${url.pathname}:`, e.message);
      sendJson(res, e.status || 502, { error: e.message });
    }
  })
  .listen(PORT, () => {
    const s = genai.status();
    const desc = {
      genai: `GENAI → token: ${s.tokenHost} · chat: ${s.chatHost}`,
      proxy: `PROXY → ${AI_BACKEND_URL}`,
      demo: "DEMO (mock cevaplar) — gerçek AI için .env dosyasını doldurun",
    }[MODE];
    console.log(`\n  MorpheusAI  →  http://localhost:${PORT}`);
    console.log(`  Mod         →  ${desc}`);
    const a = aap.status();
    console.log(`  Katalog     →  ${CATALOG === "aap" ? `AAP → ${a.host}${a.apiPrefix}` : "mock veri (AAP_URL tanımlı değil)"}`);
    const au = auth.status();
    console.log(`  Giriş       →  ${au.enabled ? `LDAP (${au.url}, ${au.mode || "YAPILANDIRMA EKSİK"})` : "kapalı (LDAP_URL tanımlı değil)"}\n`);
  });

for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
