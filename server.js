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

const PORT = process.env.PORT || 3000;
const AI_BACKEND_URL = process.env.AI_BACKEND_URL || "";
const MODE = process.env.MORPHEUS_MODE || (AI_BACKEND_URL ? "proxy" : genai.isConfigured() ? "genai" : "demo");
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

/* Katalog verileri (AWX entegrasyonu gelene kadar mock) */
const STANDARDS = require("./mock/standards.json");
const TEMPLATES = require("./mock/templates.json");
const WORKFLOWS = require("./mock/workflows.json");

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
  const out = { status: "ok", mode: MODE };
  if (MODE === "proxy") out.backend = AI_BACKEND_URL;
  if (MODE === "genai") {
    out.genai = genai.status();
    if (url.searchParams.get("deep")) {
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

async function handleApi(req, res, url) {
  const body = req.method === "POST" ? await readBody(req) : "";
  if (MODE === "proxy" && url.pathname !== "/api/health") return proxy(req, res, body);

  let json;
  try { json = body ? JSON.parse(body) : {}; } catch { return sendJson(res, 400, { error: "Geçersiz JSON gövdesi" }); }
  const route = `${req.method} ${url.pathname}`;
  const ai = MODE === "genai";

  switch (route) {
    case "GET /api/health":
      return sendJson(res, 200, await health(url));
    case "GET /api/standards":
      return sendJson(res, 200, STANDARDS);
    case "GET /api/templates":
      return sendJson(res, 200, TEMPLATES.map(({ content, ...t }) => t));
    case "GET /api/workflows":
      return sendJson(res, 200, WORKFLOWS.map(({ nodes, ...w }) => ({ ...w, nodeCount: nodes.length })));
    case "POST /api/analyze/template":
      if (!json.content) return sendJson(res, 400, { error: "content zorunlu" });
      if (ai) return sendJson(res, 200, await analyzer.analyzeTemplate(json, STANDARDS));
      await delay(900);
      return sendJson(res, 200, demo.analyzeTemplate(json.content, json.rules));
    case "POST /api/analyze/workflow":
      if (!json.workflow) return sendJson(res, 400, { error: "workflow zorunlu" });
      if (ai) return sendJson(res, 200, await analyzer.analyzeWorkflow(json, STANDARDS));
      await delay(900);
      return sendJson(res, 200, demo.analyzeWorkflow(json.workflow, json.rules));
    case "POST /api/chat":
      if (ai) return sendJson(res, 200, await analyzer.chat(json));
      await delay(600);
      return sendJson(res, 200, demo.chatReply(json.messages || [], json.context));
  }

  let m;
  if (req.method === "GET" && (m = url.pathname.match(/^\/api\/templates\/(.+)$/))) {
    const t = TEMPLATES.find((x) => x.id === decodeURIComponent(m[1]));
    return t ? sendJson(res, 200, t) : sendJson(res, 404, { error: "Template bulunamadı" });
  }
  if (req.method === "GET" && (m = url.pathname.match(/^\/api\/workflows\/(.+)$/))) {
    const w = WORKFLOWS.find((x) => x.id === decodeURIComponent(m[1]));
    return w ? sendJson(res, 200, w) : sendJson(res, 404, { error: "Workflow bulunamadı" });
  }
  sendJson(res, 404, { error: "Bilinmeyen uç nokta", route });
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
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      serveStatic(req, res, url);
    } catch (e) {
      console.error(`[api] ${req.method} ${url.pathname}:`, e.message);
      sendJson(res, 502, { error: e.message });
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
    console.log(`  Mod         →  ${desc}\n`);
  });

for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
