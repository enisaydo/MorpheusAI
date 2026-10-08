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
const fs = require("fs");
const os = require("os");

const SERVER = path.join(__dirname, "..", "server.js");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`  ✓ ${msg}`);
}

function startServer(port, extraEnv) {
  const env = {
    ...process.env, PORT: String(port), AI_BACKEND_URL: "", AI_LOG_FILE: "false", AAP_URL: "",
    MORPHEUS_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "morpheus-test-")),
    ...extraEnv,
  };
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
        // Gerçek gateway gibi: gövde boş, token ve süre response header'ında
        res.writeHead(200, { authorization: "Bearer tok-123", expires_in: "86389", "content-length": 0 });
        return res.end();
      }
      if (req.url === "/chat/completions") {
        seen.chatCalls++;
        seen.lastChatHeaders = req.headers;
        seen.lastChatBody = JSON.parse(body);
        if (req.headers.authorization !== "Bearer tok-123") return send(401, { error: "unauthorized" });
        const userMsg = seen.lastChatBody.messages.at(-1).content;
        if (userMsg.includes("BOS_CEVAP")) // akıl yürüten modelin token bütçesini bitirmesi
          return send(200, { choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }] });
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
    GENAI_CLIENT_ID: "client-xyz",
    TMS_PASSWORD: 'p@ss"w\\rd',
    TMS_BODY: '{"client_id":"{{env:GENAI_CLIENT_ID}}","username":"u","password":"{{env:TMS_PASSWORD}}"}',
    TMS_H_CHANNEL: "B2B",
    TMS_H_X_FORWARDED_FOR: "127.0.0.1",
    CHAT_URL: "http://127.0.0.1:3998/chat/completions",
    CHAT_H_CHANNEL: "Branch",
    CHAT_H_CLIENT_ID: "{{env:GENAI_CLIENT_ID}}",
    CHAT_H_CLIENT_SESSION_ID: "{{uuid}}",
    CHAT_H_PROJECT_INFO: "morpheusai",
    CHAT_AUTH_PREFIX: "Bearer",
    CHAT_MODEL: "test-model",
    CHAT_MODEL_FIELD: "model_name",
    CHAT_BODY_EXTRA: '{"max_completion_tokens":1440}',
  });
  try {
    await waitFor(base);
    const health = await (await fetch(`${base}/api/health?deep=1`)).json();
    assert(health.mode === "genai", ".env ayarlarıyla otomatik GENAI moduna geçti");
    assert(health.genai.tokenCheck === "ok", "TMS token response header'ından (authorization: Bearer) alındı");
    assert(health.genai.tokenExpiresIn > 86000, `token süresi expires_in header'ından okundu (${health.genai.tokenExpiresIn}s)`);
    const tmsBody = JSON.parse(seen.tmsBody);
    assert(tmsBody.client_id === "client-xyz" && tmsBody.password === 'p@ss"w\\rd', "TMS_BODY {{env:..}} ile dolduruldu, özel karakterli parola JSON'u bozmadı");

    const chat = await postJson(base, "/api/chat", { messages: [{ role: "user", content: "selam" }] });
    assert(chat.reply.includes("Morpheus"), "chat cevabı choices.0.message.content'ten okundu");

    const h = seen.lastChatHeaders;
    assert(h.authorization === "Bearer tok-123", "Authorization: Bearer <token> eklendi");
    assert(h.channel === "Branch" && h["client-id"] === "client-xyz" && h["project-info"] === "morpheusai", "CHAT_H_* header'ları gönderildi");
    assert(UUID_RE.test(h["client-session-id"]), "{{uuid}} yer tutucusu UUID'ye çevrildi");
    assert(seen.lastChatBody.model_name === "test-model" && !("model" in seen.lastChatBody), "model 'model_name' alanıyla gönderildi");
    assert(seen.lastChatBody.max_completion_tokens === 1440, "CHAT_BODY_EXTRA gövdeye eklendi");
    assert(seen.lastChatBody.messages[0].role === "system", "system prompt eklendi");

    const tpl = await postJson(base, "/api/analyze/template", { content: "- hosts: all\n  tasks: []", rules: ["STD-005"] });
    assert(tpl.engine === "genai" && tpl.score === 42, "AI JSON cevabı AnalysisResult'a dönüştü");
    assert(tpl.findings[0].severity === "critical" && tpl.findings[0].line === 7, "bulgu alanları normalize edildi");
    assert(seen.tmsCalls === 1, `token cache'lendi (TMS çağrısı: ${seen.tmsCalls})`);

    const ctxChat = await postJson(base, "/api/chat", {
      messages: [{ role: "user", content: "analiz et" }],
      context: { kind: "template", name: "X", content: "- hosts: all" },
    });
    const sys = seen.lastChatBody.messages[0].content;
    assert(ctxChat.reply && sys.includes("STD-005") && sys.includes("JT-002"), "sohbete kurumsal standartlar eklendi");
    assert(sys.includes("- hosts: all"), "sohbete seçilen template bağlamı eklendi");

    const SYS = "Sen bir test asistanısın.\nKısa cevap ver.";
    const saved = await postJson(base, "/api/prompts", { system: SYS, includeStandards: false });
    assert(saved.system === SYS && saved.includeStandards === false, "sistem mesajı Ayarlar'dan kaydedildi");
    const got = await (await fetch(`${base}/api/prompts`)).json();
    assert(got.system === SYS && got.defaults.system.length > 0, "kaydedilen sistem mesajı geri okundu");
    await postJson(base, "/api/chat", { messages: [{ role: "user", content: "Test" }] });
    const [m0, m1] = seen.lastChatBody.messages;
    assert(m0.role === "system" && m0.content === SYS, "role:system içeriği birebir kaydedilen metin");
    assert(m1.role === "user" && m1.content === "Test" && seen.lastChatBody.messages.length === 2, "role:user içeriği yazılan mesajın aynısı");
    await postJson(base, "/api/prompts", { system: SYS, includeStandards: true });
    await postJson(base, "/api/chat", { messages: [{ role: "user", content: "Test" }] });
    const sys2 = seen.lastChatBody.messages[0].content;
    assert(sys2.startsWith(SYS) && sys2.includes("## Kurumsal standartlar"), "standart ekleme açıkken standartlar metnin sonuna eklendi");
    const tplSys = (await postJson(base, "/api/analyze/template", { content: "- hosts: all" }), seen.lastChatBody.messages[0].content);
    assert(tplSys === SYS, "template analizinde de aynı sistem mesajı kullanıldı");
    const bad = await fetch(`${base}/api/prompts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ system: "  " }) });
    assert(bad.status === 400, "boş sistem mesajı reddedildi");

    const empty = await fetch(`${base}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "BOS_CEVAP" }] }),
    });
    const emptyBody = await empty.json();
    assert(!empty.ok && /boş cevap.*length.*max_completion_tokens/s.test(emptyBody.error), "boş model cevabı açık hata olarak raporlandı");

    const logs = await (await fetch(`${base}/api/logs?service=genai`)).json();
    assert(logs.some((l) => l.kind === "tms-token") && logs.some((l) => l.kind === "chat") && logs.some((l) => l.kind === "analyze-template"),
      `GenAI çağrıları loglandı (${logs.length} kayıt)`);
    const chatLog = await (await fetch(`${base}/api/logs/${logs.find((l) => l.kind === "chat").id}`)).json();
    assert(Array.isArray(chatLog.request.body.messages) && chatLog.response.body.choices, "log kaydında gönderilen mesajlar ve dönen cevap var");
    assert(!JSON.stringify(chatLog).includes("tok-123") && !JSON.stringify(chatLog).includes("client-xyz"), "log kaydında token ve client-id maskelendi");
    assert(chatLog.request.body.max_completion_tokens === 1440, "sayaç alanları (max_completion_tokens) maskelenmedi");
    const tmsLog = await (await fetch(`${base}/api/logs/${logs.find((l) => l.kind === "tms-token").id}`)).json();
    assert(!JSON.stringify(tmsLog).includes('p@ss'), "TMS log kaydında parola maskelendi");
  } finally {
    srv.kill();
    gw.close();
  }
}

/* ------------------------------------------------------------------ */

function fakeAap() {
  const seen = { auth: null };
  const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  const page = (results, next = null) => ({ count: results.length, next, previous: null, results });
  const srv = http.createServer((req, res) => {
    seen.auth = req.headers.authorization;
    if (req.headers.authorization !== "Bearer aap-tok") return json(res, 401, { detail: "unauthorized" });
    const p = req.url.split("?")[0];
    const q = new URL(req.url, "http://x").searchParams;
    const routes = {
      "/api/v2/me/": () => page([{ username: "morpheus-bot" }]),
      "/api/v2/ping/": () => ({ version: "4.5.0" }),
      "/api/v2/job_templates/": () =>
        q.get("page") === "2"
          ? page([{ id: 8, name: "Payment API | Deploy", modified: "2026-10-01T00:00:00Z", summary_fields: {} }])
          : page([{ id: 7, name: "nginx kurulum", playbook: "nginx.yml", modified: "2026-10-05T10:00:00Z",
                    summary_fields: { project: { name: "infra" }, inventory: { name: "PROD-WEB" }, organization: { name: "Ops" } } }],
                 "/api/v2/job_templates/?page=2&page_size=200"),
      "/api/v2/job_templates/7/": () => ({
        id: 7, name: "nginx kurulum", description: "", playbook: "nginx.yml", verbosity: 3, timeout: 0,
        extra_vars: "db_password: S3cret!\nport: 80", allow_simultaneous: true, survey_enabled: false,
        ask_inventory_on_launch: true, modified: "2026-10-05T10:00:00Z",
        summary_fields: { inventory: { name: "PROD-WEB" }, project: { name: "infra" }, credentials: [{ name: "ssh", kind: "ssh" }], labels: { results: [] } },
      }),
      "/api/v2/job_templates/7/notification_templates_error/": () => page([]),
      "/api/v2/job_templates/7/notification_templates_success/": () => page([]),
      "/api/v2/job_templates/7/notification_templates_started/": () => page([]),
      "/api/v2/workflow_job_templates/": () => page([{ id: 9, name: "WF_PROD_WEB_DEPLOY", description: "d", summary_fields: {} }]),
      "/api/v2/workflow_job_templates/9/": () => ({ id: 9, name: "WF_PROD_WEB_DEPLOY", summary_fields: {} }),
      "/api/v2/workflow_job_templates/9/workflow_nodes/": () => page([
        { id: 101, success_nodes: [102], failure_nodes: [], always_nodes: [], unified_job_template: 5,
          summary_fields: { unified_job_template: { name: "SCM sync", unified_job_type: "project_update" } } },
        { id: 102, success_nodes: [], failure_nodes: [103], always_nodes: [], unified_job_template: 7,
          summary_fields: { unified_job_template: { name: "nginx kurulum", unified_job_type: "job" } } },
        { id: 103, success_nodes: [], failure_nodes: [], always_nodes: [], unified_job_template: 11,
          summary_fields: { unified_job_template: { name: "Onay", unified_job_type: "workflow_approval" } } },
      ]),
      "/api/v2/workflow_job_templates/9/notification_templates_error/": () => page([{ name: "Teams" }]),
    };
    const h = routes[p];
    if (h) return json(res, 200, h());
    if (/notification_templates_/.test(p)) return json(res, 200, page([]));
    json(res, 404, { detail: "not found" });
  });
  return { srv, seen };
}

async function aapSuite() {
  console.log("\n[AAP kataloğu — sahte Controller API]");
  const { srv: api, seen } = fakeAap();
  await new Promise((r) => api.listen(3994, "127.0.0.1", r));
  const base = "http://127.0.0.1:3993";
  const srv = startServer(3993, {
    MORPHEUS_MODE: "demo",
    AAP_URL: "http://127.0.0.1:3994",
    AAP_TOKEN: "aap-tok",
  });
  try {
    await waitFor(base);
    const health = await (await fetch(`${base}/api/health?deep=1`)).json();
    assert(health.catalog === "aap" && health.aap.check === "ok" && health.aap.user === "morpheus-bot", "AAP bağlantısı doğrulandı (/me, /ping)");

    const list = await (await fetch(`${base}/api/templates`)).json();
    assert(list.length === 2 && list[0].inventory === "PROD-WEB" && list[0].project === "infra", "job template listesi sayfalı okunup eşlendi");

    const jt = await (await fetch(`${base}/api/templates/7`)).json();
    const def = JSON.parse(jt.content);
    assert(def.type === "aap_job_template" && def.verbosity === 3 && def.notifications.error.length === 0, "job template tanımı içerik olarak üretildi");

    const res = await postJson(base, "/api/analyze/template", { content: jt.content, templateId: "7" });
    const ids = res.findings.map((f) => f.ruleId);
    assert(["JT-001", "JT-002", "JT-003", "JT-004", "JT-006", "JT-007", "JT-008"].every((id) => ids.includes(id)), `AAP kuralları uygulandı (${[...new Set(ids)].join(",")})`);
    const relist = await (await fetch(`${base}/api/templates`)).json();
    assert(relist.find((t) => t.id === "7").lastScore === res.score, "analiz skoru listede gösteriliyor");

    const wf = await (await fetch(`${base}/api/workflows/9`)).json();
    assert(wf.nodes.map((n) => n.type).join() === "project_sync,job,approval" && wf.nodes[1].failure[0] === "103", "workflow düğümleri ve dalları eşlendi");
    const missing = await fetch(`${base}/api/workflows/12345`);
    assert(missing.status === 404 && /AAP'de bulunamadı/.test((await missing.json()).error), "olmayan workflow ID'si için anlaşılır 404 döndü");
    const wres = await postJson(base, "/api/analyze/workflow", { workflow: wf, workflowId: "9" });
    assert(!wres.findings.some((f) => f.ruleId === "WF-005"), "workflow seviyesindeki hata bildirimi WF-005 için dikkate alındı");

    const logs = await (await fetch(`${base}/api/logs?service=aap`)).json();
    const one = await (await fetch(`${base}/api/logs/${logs[0].id}`)).json();
    assert(logs.length > 5 && !JSON.stringify(one).includes("aap-tok"), "AAP çağrıları loglandı, token maskelendi");
  } finally {
    srv.kill();
    api.close();
  }
}

(async () => {
  try {
    await demoSuite();
    await genaiSuite();
    await aapSuite();
    console.log("\nSmoke test başarılı.");
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    process.exitCode = 1;
  }
})();
