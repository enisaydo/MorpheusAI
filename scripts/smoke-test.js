/*
 * Uçtan uca smoke test
 *   1) DEMO modu: temel uç noktalar ve kural motoru
 *   2) GENAI modu: sahte bir TMS + chat/completions gateway'i ayağa kaldırılır;
 *      token alma, cache, header'lar ve AI cevap işleme doğrulanır.
 * Kullanım: npm test
 */
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const SERVER = path.join(__dirname, "..", "server.js");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`  ✓ ${msg}`);
}

function startServer(port, extraEnv) {
  const env = { ...process.env, PORT: String(port), AI_BACKEND_URL: "", ...extraEnv };
  return spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "ignore", "ignore"] });
}

async function waitFor(base) {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Sunucu ayağa kalkmadı: ${base}`);
}

const postJson = (base, p, body) =>
  fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => r.json());

/* ------------------------------------------------------------------ */

async function demoSuite() {
  console.log("\n[DEMO modu — .env.example yer tutucularıyla]");
  const base = "http://127.0.0.1:3999";
  // .env.example olduğu gibi kopyalanmış durum: sunucu çökmemeli, demo'ya düşmeli
  const srv = startServer(3999, {
    MORPHEUS_MODE: "",
    TMS_TOKEN_URL: "https://<api-gateway>/authentication/tms/v3/tmsToken",
    CHAT_URL: "https://<api-gateway>/sdlc-genai-management/sdlc-genai-ch/v0/chat/completions",
  });
  try {
    await waitFor(base);
    const health = await (await fetch(`${base}/api/health`)).json();
    assert(health.status === "ok" && health.mode === "demo", "yer tutucu URL'lerle çökmeden DEMO modunda açıldı");

    const index = await fetch(`${base}/`);
    assert(index.ok && (await index.text()).includes("MorpheusAI"), "index.html sunuluyor");
    for (const f of ["styles.css", "js/api.js", "js/ui.js", "js/app.js"])
      assert((await fetch(`${base}/${f}`)).ok, `${f} sunuluyor`);

    const std = await (await fetch(`${base}/api/standards`)).json();
    assert(Array.isArray(std) && std.length > 0, "standards listesi dolu");

    const bad = await (await fetch(`${base}/api/templates/jt-101`)).json();
    const badRes = await postJson(base, "/api/analyze/template", { content: bad.content });
    assert(badRes.score < 60 && badRes.findings.length > 0, `hatalı template düşük skor aldı (${badRes.score})`);

    const good = await (await fetch(`${base}/api/templates/jt-103`)).json();
    const goodRes = await postJson(base, "/api/analyze/template", { content: good.content });
    assert(goodRes.score >= 85, `uyumlu template yüksek skor aldı (${goodRes.score})`);

    const wf = await (await fetch(`${base}/api/workflows/wf-202`)).json();
    const wfRes = await postJson(base, "/api/analyze/workflow", { workflow: wf });
    assert(wfRes.findings.some((f) => f.ruleId === "WF-004"), "prod workflow onay eksikliği yakalandı");

    const chat = await postJson(base, "/api/chat", { messages: [{ role: "user", content: "merhaba" }] });
    assert(typeof chat.reply === "string" && chat.reply.length > 0, "chat cevap döndü");

    const traversal = await fetch(`${base}/..%2f..%2fserver.js`);
    assert(!(await traversal.text()).includes("require("), "path traversal engelleniyor");
  } finally {
    srv.kill();
  }
}

/* ------------------------------------------------------------------ */

function fakeGateway() {
  const seen = { tmsCalls: 0, chatCalls: 0, lastChatHeaders: null, lastChatBody: null, tmsBody: null };
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/authentication/tms/v3/tmsToken") {
        seen.tmsCalls++;
        seen.tmsBody = body;
        if (req.headers.channel !== "B2B" || !req.headers["x-forwarded-for"]) return send(400, { error: "eksik header" });
        return send(200, { data: { accessToken: "tok-123" }, expiresIn: 600 });
      }
      if (req.url === "/chat/completions") {
        seen.chatCalls++;
        seen.lastChatHeaders = req.headers;
        seen.lastChatBody = JSON.parse(body);
        if (req.headers.authorization !== "Bearer tok-123") return send(401, { error: "unauthorized" });
        const userMsg = seen.lastChatBody.messages.at(-1).content;
        const content = userMsg.includes("şemaya uyan geçerli JSON")
          ? "```json\n" + JSON.stringify({
              score: 42, status: "non_compliant", summary: "AI özeti",
              findings: [{ ruleId: "STD-005", severity: "CRITICAL", title: "Secret", detail: "düz metin", line: 7, fix: "vault" }],
              missing: ["handlers"],
            }) + "\n```"
          : "Merhaba, ben **Morpheus** (sahte gateway).";
        return send(200, { choices: [{ message: { role: "assistant", content } }] });
      }
      send(404, {});
    });
  });
  return { srv, seen };
}

async function genaiSuite() {
  console.log("\n[GENAI modu — sahte gateway]");
  const { srv: gw, seen } = fakeGateway();
  await new Promise((r) => gw.listen(3998, "127.0.0.1", r));
  const base = "http://127.0.0.1:3997";
  const srv = startServer(3997, {
    MORPHEUS_MODE: "",
    TMS_TOKEN_URL: "http://127.0.0.1:3998/authentication/tms/v3/tmsToken",
    TMS_BODY: '{"clientId":"abc"}',
    TMS_H_CHANNEL: "B2B",
    TMS_H_X_FORWARDED_FOR: "127.0.0.1",
    CHAT_URL: "http://127.0.0.1:3998/chat/completions",
    CHAT_H_CHANNEL: "Branch",
    CHAT_H_CLIENT_ID: "client-xyz",
    CHAT_H_CLIENT_SESSION_ID: "{{uuid}}",
    CHAT_H_PROJECT_INFO: "morpheusai",
    CHAT_AUTH_PREFIX: "Bearer",
    CHAT_MODEL: "test-model",
    CHAT_BODY_EXTRA: '{"temperature":0.2}',
  });
  try {
    await waitFor(base);
    const health = await (await fetch(`${base}/api/health?deep=1`)).json();
    assert(health.mode === "genai", ".env ayarlarıyla otomatik GENAI moduna geçti");
    assert(health.genai.tokenCheck === "ok", "TMS token alındı (data.accessToken otomatik bulundu)");
    assert(seen.tmsBody === '{"clientId":"abc"}', "TMS_BODY olduğu gibi gönderildi");

    const chat = await postJson(base, "/api/chat", { messages: [{ role: "user", content: "selam" }] });
    assert(chat.reply.includes("Morpheus"), "chat cevabı choices.0.message.content'ten okundu");

    const h = seen.lastChatHeaders;
    assert(h.authorization === "Bearer tok-123", "Authorization: Bearer <token> eklendi");
    assert(h.channel === "Branch" && h["client-id"] === "client-xyz" && h["project-info"] === "morpheusai", "CHAT_H_* header'ları gönderildi");
    assert(UUID_RE.test(h["client-session-id"]), "{{uuid}} yer tutucusu UUID'ye çevrildi");
    assert(seen.lastChatBody.model === "test-model" && seen.lastChatBody.temperature === 0.2, "model ve CHAT_BODY_EXTRA gövdeye eklendi");
    assert(seen.lastChatBody.messages[0].role === "system", "system prompt eklendi");

    const tpl = await postJson(base, "/api/analyze/template", { content: "- hosts: all\n  tasks: []", rules: ["STD-005"] });
    assert(tpl.engine === "genai" && tpl.score === 42, "AI JSON cevabı AnalysisResult'a dönüştü");
    assert(tpl.findings[0].severity === "critical" && tpl.findings[0].line === 7, "bulgu alanları normalize edildi");
    assert(seen.tmsCalls === 1, `token cache'lendi (TMS çağrısı: ${seen.tmsCalls})`);
  } finally {
    srv.kill();
    gw.close();
  }
}

(async () => {
  try {
    await demoSuite();
    await genaiSuite();
    console.log("\nSmoke test başarılı.");
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    process.exitCode = 1;
  }
})();
