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
    LDAP_URL: "", LDAP_SERVER: "", LDAP_BASE_DN: "", LDAP_BIND_DN: "", LDAP_BIND_PASSWORD: "", LDAP_SEARCH_BASE: "",
    LDAP_USER_FILTER: "", LDAP_USER_DN_TEMPLATE: "", LDAP_REQUIRED_GROUP: "", LDAP_ADMIN_GROUP: "",
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
        // Gerçek gateway gibi: gövde boş, token ve süre response header'ında ("Bearer: <token>")
        res.writeHead(200, { authorization: "Bearer: tok-123", expires_in: "86389", "content-length": 0 });
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
        if (userMsg.includes("Bu bulguyu gidermek için")) {
          seen.remediationPrompts = (seen.remediationPrompts || 0) + 1;
          seen.lastRemediationPrompt = userMsg;
          const playbook = '---\n- name: "UnixAI | httpd onarımı"\n  hosts: "{{ target_host }}"\n  become: true\n  gather_facts: true\n  tasks:\n' +
            '    - name: "httpd yapılandırmasını doğrula"\n      ansible.builtin.command: apachectl configtest\n      changed_when: false\n      check_mode: false\n      tags: [unixai_remediation]\n' +
            '    - name: "httpd servisini başlat"\n      ansible.builtin.systemd:\n        name: httpd\n        state: started\n      when: unixai_allow_disruptive | default(false) | bool\n      tags: [unixai_remediation]\n';
          return send(200, { choices: [{ message: { role: "assistant", content: JSON.stringify({ title: "httpd onarımı", summary: "configtest + start", risk: "medium", disruptive: true, playbook }) }, finish_reason: "stop" }],
            usage: { prompt_tokens: 50, completion_tokens: 50, total_tokens: 100 } });
        }
        const content = userMsg.includes("şemaya uyan geçerli JSON")
          ? "```json\n" + JSON.stringify({
              score: 42, status: "non_compliant", summary: "AI özeti",
              findings: [{ ruleId: "STD-005", severity: "CRITICAL", title: "Secret", detail: "düz metin", line: 7, fix: "vault" }],
              missing: ["handlers"],
            }) + "\n```"
          : "Merhaba, ben **Morpheus** (sahte gateway).";
        return send(200, {
          choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
          model: "test-model-2026",
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        });
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

    // ---- token kullanımı & limitler ----
    const asUser = (user, content) => fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Morpheus-User": encodeURIComponent(user) },
      body: JSON.stringify({ messages: [{ role: "user", content }] }),
    });
    assert((await asUser("Ayşe Çelik", "nginx template'i nasıl?")).ok, "kullanıcı adıyla sohbet");
    const rep = await (await fetch(`${base}/api/usage`)).json();
    const ayse = rep.byUser.find((u) => u.key === "Ayşe Çelik");
    assert(ayse && ayse.totalTokens === 120 && ayse.requests === 1, "kullanım Türkçe karakterli kullanıcı adıyla kaydedildi (120 token)");
    const rec = rep.records.find((r) => r.user === "Ayşe Çelik");
    assert(rec.question === "nginx template'i nasıl?" && rec.promptTokens === 100 && rec.completionTokens === 20 && rec.logId, "sorgu metni, girdi/çıktı token'ı ve log bağlantısı kaydedildi");
    assert(rep.byKind.some((k) => k.key === "analyze-template") && rep.total.errors >= 1, "türe göre dağılım ve hatalı istekler raporlandı");
    assert(rep.days.at(-1).totalTokens === rep.today.total && rep.today.total > 0, "günlük toplam bugünün kullanımıyla tutarlı");

    const lim = await postJson(base, "/api/limits", { dailyLimit: rep.today.total, perUserDailyLimit: 0 });
    assert(lim.dailyLimit === rep.today.total, "günlük limit Ayarlar'dan kaydedildi");
    const blocked = await asUser("Ayşe Çelik", "tekrar");
    assert(blocked.status === 429 && /Günlük token limiti doldu/.test((await blocked.json()).error), "limit dolunca istek 429 ile reddedildi");
    const callsBefore = seen.chatCalls;
    await asUser("Mehmet", "deneme");
    assert(seen.chatCalls === callsBefore, "limit dolunca gateway'e hiç istek gitmedi");

    await postJson(base, "/api/limits", { dailyLimit: 0, perUserDailyLimit: 120 });
    const userBlocked = await asUser("Ayşe Çelik", "bir daha");
    const otherOk = await asUser("Mehmet", "merhaba");
    assert(userBlocked.status === 429 && otherOk.ok, "kullanıcı başına limit yalnızca o kullanıcıyı engelledi");
    const badLim = await fetch(`${base}/api/limits`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dailyLimit: -5 }) });
    assert(badLim.status === 400, "geçersiz limit değeri reddedildi");
    const today = await (await fetch(`${base}/api/usage/today`, { headers: { "X-Morpheus-User": "Mehmet" } })).json();
    assert(today.user === "Mehmet" && today.userTotal === 120, "bugünkü kullanıcı kullanımı döndü");

    // UnixAI bulgusundan GenAI ile düzeltme playbook'u (uyum skoru düşük → ihlaller verilip 1 kez yeniden üretim)
    await postJson(base, "/api/limits", { dailyLimit: 0, perUserDailyLimit: 0 });
    const rem = await postJson(base, "/api/remediations", {
      server: { name: "rhel-web01", os_release: "Red Hat Enterprise Linux release 9.3" },
      finding: { title: "httpd failed", priority: "P1", evidence: "httpd.service loaded failed failed", commands: ["systemctl status httpd"] },
      source: "unixai-os",
    });
    assert(rem.engine === "genai" && rem.attempts === 2 && seen.remediationPrompts === 2, "GenAI düzeltme playbook'u üretti, uyum eşiği altında olduğu için 1 kez yeniden denendi");
    assert(seen.lastRemediationPrompt.includes("STD-005") && seen.lastRemediationPrompt.includes("Önceki taslağın standart ihlalleri"), "standartlar ve önceki ihlaller modele verildi");
    assert(rem.runnable && rem.tasksYaml.startsWith('- name: "httpd yapılandırmasını doğrula"') && rem.disruptive, "runner için task listesi çıkarıldı, kesinti riski işaretlendi");
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
  // AAP 2.6 benzeri: controller API yalnızca /api/controller/v2 altında, /api/v2 yok; ping kimlik doğrulamasız
  const srv = http.createServer((req, res) => {
    seen.auth = req.headers.authorization;
    const raw = req.url.split("?")[0];
    if (!raw.startsWith("/api/controller/v2/")) return json(res, 404, { detail: "not found" });
    const p = raw.replace("/api/controller/v2/", "/api/v2/");
    if (p === "/api/v2/ping/") return json(res, 200, { version: "4.7.0" });
    if (req.headers.authorization !== "Bearer aap-tok") return json(res, 401, { detail: "unauthorized" });
    const q = new URL(req.url, "http://x").searchParams;
    const routes = {
      "/api/v2/me/": () => page([{ username: "morpheus-bot" }]),
      "/api/v2/ping/": () => ({ version: "4.5.0" }),
      "/api/v2/job_templates/": () =>
        q.get("page") === "2"
          ? page([{ id: 8, name: "Payment API | Deploy", modified: "2026-10-01T00:00:00Z", summary_fields: {} }])
          : page([{ id: 7, name: "nginx kurulum", playbook: "nginx.yml", modified: "2026-10-05T10:00:00Z",
                    summary_fields: { project: { name: "infra" }, inventory: { name: "PROD-WEB" }, organization: { name: "Ops" } } }],
                 "/api/controller/v2/job_templates/?page=2&page_size=200"),
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "morpheus-hist-"));
  const aapEnv = { MORPHEUS_MODE: "demo", AAP_URL: "http://127.0.0.1:3994", AAP_TOKEN: "aap-tok", AAP_API_PREFIX: "", MORPHEUS_DATA_DIR: dataDir };
  let srv = startServer(3993, aapEnv);
  try {
    await waitFor(base);
    const health = await (await fetch(`${base}/api/health?deep=1`)).json();
    assert(health.catalog === "aap" && health.aap.check === "ok" && health.aap.user === "morpheus-bot", "AAP bağlantısı doğrulandı (/me, /ping)");
    assert(health.aap.apiPrefix === "/api/controller/v2", "AAP 2.6 API yolu otomatik algılandı (/api/controller/v2)");

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

    // ---- Analiz geçmişi ----
    assert(res.historyId && res.analyzedAt, "analiz sonucu geçmiş kaydı kimliği ve zamanıyla döndü");
    const res2 = await (await fetch(`${base}/api/analyze/template`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Morpheus-User": "Zeynep" },
      body: JSON.stringify({ content: jt.content, templateId: "7", title: "nginx kurulum" }),
    })).json();
    const hist = await (await fetch(`${base}/api/history`)).json();
    const h7 = hist.records.find((r) => r.id === res2.historyId);
    assert(h7 && h7.score === res2.score && h7.user === "Zeynep" && h7.targetName === "nginx kurulum" && h7.failedRules.includes("JT-002") && h7.counts.critical >= 1,
      "geçmişte skor, kullanıcı, hedef adı, ihlal edilen kurallar ve önem sayıları var");
    assert(hist.records.some((r) => r.kind === "workflow" && r.targetId === "9"), "workflow analizi de geçmişe yazıldı");
    const jt2 = hist.byRule.find((r) => r.ruleId === "JT-002");
    assert(jt2 && jt2.analyses === 2 && jt2.severity === "critical", "en sık ihlal edilen kurallar sayıldı (JT-002 → 2 analiz)");
    const tgt = hist.byTarget.find((t) => t.kind === "template" && t.targetId === "7");
    assert(tgt.count === 2 && tgt.change === 0 && tgt.targetName === "nginx kurulum", "hedef bazında analiz sayısı ve skor değişimi");
    const detail = await (await fetch(`${base}/api/history/${res2.historyId}`)).json();
    assert(detail.findings.length === res2.findings.length && detail.timeline.length === 2 && detail.findings[0].detail,
      "analiz detayı tüm bulgularla ve aynı hedefin önceki analizleriyle döndü");
    const byRule = await (await fetch(`${base}/api/history?rule=JT-008`)).json();
    assert(byRule.records.length >= 1 && byRule.records.every((r) => r.failedRules.includes("JT-008")), "kurala göre filtreleme");

    // Yeniden başlatma: skor geçmişten okunmalı
    srv.kill();
    srv = startServer(3993, aapEnv);
    await waitFor(base);
    const afterRestart = await (await fetch(`${base}/api/templates`)).json();
    assert(afterRestart.find((t) => t.id === "7").lastScore === res2.score, "servis yeniden başlatıldıktan sonra son skor korundu");
  } finally {
    srv.kill();
    api.close();
  }
}

/* ------------------------------------------------------------------ */

/** Sahte LDAP (AD benzeri). Boş parolalı bind'i AD gibi BAŞARILI sayar — uygulamanın reddetmesi gerekir. */
function fakeLdap() {
  const L = require("../lib/ldap");
  const GROUP = "CN=Morpheus Users,OU=Groups,DC=test,DC=local";
  const ADMINS = "CN=Morpheus Admins,OU=Groups,DC=test,DC=local";
  const users = {
    ali: { dn: "CN=Ali Veli,OU=Users,DC=test,DC=local", pw: "dogru", display: "Ali Veli", groups: [GROUP] },
    yonetici: { dn: "CN=Yonetici,OU=Users,DC=test,DC=local", pw: "admin123", display: "Sistem Yöneticisi", groups: [GROUP, ADMINS] },
    disari: { dn: "CN=Disari,OU=Users,DC=test,DC=local", pw: "x1", display: "Dışarıdan", groups: [] },
    kilit: { dn: "CN=Kilit,OU=Users,DC=test,DC=local", pw: "k", display: "Kilit", groups: [GROUP] },
  };
  const seen = { filters: [], denyAnonymous: false, anonymousSearches: 0 };
  const msg = (id, op) => L.seq(0x30, [L.int(id), op]);
  const result = (tag, code) => L.seq(tag, [L.int(code, 0x0a), L.str(""), L.str(code ? "80090308: LdapErr: DSID-0C09042A, data 52e" : "")]);
  const srv = require("net").createServer((sock) => {
    let buf = Buffer.alloc(0), bound = false;
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (let m; (m = L.readTlv(buf));) {
        buf = buf.subarray(m.next);
        const [idT, op] = L.children(m.value);
        const id = L.toInt(idT.value);
        if (op.tag === 0x60) { // bind
          const [, name, pw] = L.children(op.value);
          const dn = name.value.toString(), pass = pw.value.toString();
          const ok = (dn === "CN=svc,DC=test,DC=local" && pass === "svcpw") || pass === "" ||
            Object.entries(users).some(([sam, u]) => (u.dn === dn || `${sam}@test.local` === dn) && u.pw === pass); // DN veya UPN ile bind
          if (ok && pass) bound = true;
          sock.write(msg(id, result(0x61, ok ? 0 : 49)));
        } else if (op.tag === 0x63) { // search
          if (!bound) seen.anonymousSearches++;
          if (!bound && seen.denyAnonymous) { // AD varsayılanı: anonim arama → operationsError
            sock.write(msg(id, result(0x65, 1)));
            continue;
          }
          const parts = L.children(op.value);
          const filterBytes = op.value.subarray(0); // ham filtre bayt kontrolü için
          const findEq = (t) => t.tag === 0xa3 ? [L.children(t.value).map((x) => x.value.toString())]
            : [0xa0, 0xa1].includes(t.tag) ? L.children(t.value).flatMap(findEq) : [];
          const eqs = findEq(parts[6]);
          seen.filters.push(eqs);
          const sam = eqs.find(([a]) => a.toLowerCase() === "samaccountname")?.[1];
          const u = users[sam];
          sock.write(msg(id, L.seq(0x73, [L.str("ldap://ForestDnsZones.test.local/DC=ForestDnsZones,DC=test,DC=local")])));
          if (u) {
            const attr = (k, vals) => L.seq(0x30, [L.str(k), L.seq(0x31, vals.map((v) => L.str(v)))]);
            sock.write(msg(id, L.seq(0x64, [L.str(u.dn), L.seq(0x30, [
              attr("sAMAccountName", [sam]), attr("displayName", [u.display]), attr("memberOf", u.groups), attr("mail", [`${sam}@test.local`]),
            ])])));
          }
          sock.write(msg(id, result(0x65, 0)));
          void filterBytes;
        }
      }
    });
    sock.on("error", () => {});
  });
  return { srv, seen, GROUP, ADMINS };
}

async function ldapSuite() {
  console.log("\n[LDAP girişi — sahte Active Directory]");
  const { srv: ldap, seen, GROUP, ADMINS } = fakeLdap();
  await new Promise((r) => ldap.listen(3989, "127.0.0.1", r));
  const base = "http://127.0.0.1:3987";
  const srv = startServer(3987, {
    MORPHEUS_MODE: "demo",
    LDAP_URL: "ldap://127.0.0.1:3989",
    LDAP_BIND_DN: "CN=svc,DC=test,DC=local",
    LDAP_BIND_PASSWORD: "svcpw",
    LDAP_SEARCH_BASE: "DC=test,DC=local",
    LDAP_USER_FILTER: "(&(objectClass=user)(sAMAccountName={{username}}))",
    LDAP_REQUIRED_GROUP: GROUP,
    LDAP_ADMIN_GROUP: ADMINS.toLowerCase().replace(/,/g, ", "), // büyük/küçük harf ve boşluk farkı tolere edilmeli
    LDAP_USER_DN_TEMPLATE: "",
  });
  const login = (username, password) =>
    fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  const cookieOf = (r) => (r.headers.get("set-cookie") || "").split(";")[0];
  const withCookie = (c, p, opts = {}) => fetch(base + p, { ...opts, headers: { "Content-Type": "application/json", Cookie: c, ...(opts.headers || {}) } });
  try {
    await waitFor(base);
    assert((await fetch(`${base}/api/templates`)).status === 401, "oturumsuz API çağrısı 401");
    const me0 = await fetch(`${base}/api/auth/me`);
    assert(me0.status === 401 && (await me0.json()).enabled === true, "giriş zorunlu olduğu bildirildi");
    assert((await fetch(`${base}/api/health?deep=1`)).status === 401, "derin sağlık kontrolü oturum istiyor");

    assert((await login("ali", "yanlis")).status === 401, "yanlış parola reddedildi");
    assert((await login("ali", "")).status === 400, "boş parola reddedildi (AD anonim bind açığı)");
    assert((await login("*)(sAMAccountName=*", "x")).status === 401, "filtre enjeksiyonu denemesi reddedildi");
    assert(seen.filters.some((f) => f.some(([a, v]) => a === "sAMAccountName" && v === "*)(sAMAccountName=*")),
      "kullanıcı adı LDAP filtresine kaçışlanarak (literal) gönderildi");

    const ok = await login("ali", "dogru");
    const aliCookie = cookieOf(ok);
    const body = await ok.json();
    assert(ok.ok && body.user.displayName === "Ali Veli" && body.user.isAdmin === false, "doğru parolayla giriş (servis hesabı → arama → kullanıcı bind)");
    assert(/HttpOnly/.test(ok.headers.get("set-cookie")) && /SameSite=Lax/.test(ok.headers.get("set-cookie")), "oturum çerezi HttpOnly + SameSite");
    assert((await withCookie(aliCookie, "/api/templates")).ok, "oturumla API erişimi");
    const today = await (await withCookie(aliCookie, "/api/usage/today", { headers: { "X-Morpheus-User": encodeURIComponent("sahte") } })).json();
    assert(today.user === "ali", "token raporlarında kullanıcı LDAP oturumundan alındı (header taklidi yok sayıldı)");
    const lim = await withCookie(aliCookie, "/api/limits", { method: "POST", body: JSON.stringify({ dailyLimit: 5 }) });
    assert(lim.status === 403, "yönetici olmayan kullanıcı limit değiştiremedi");

    const adm = await login("yonetici", "admin123");
    const admBody = await adm.json();
    assert(admBody.user.isAdmin === true, "yönetici grubu tanındı (DN karşılaştırması büyük/küçük harf duyarsız)");
    assert((await withCookie(cookieOf(adm), "/api/limits", { method: "POST", body: JSON.stringify({ dailyLimit: 5000 }) })).ok, "yönetici limit değiştirebildi");

    const outsider = await login("disari", "x1");
    assert(outsider.status === 403, "gerekli LDAP grubunda olmayan kullanıcı reddedildi");

    const [p, mac] = aliCookie.split("=")[1].split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url")), a: true })).toString("base64url");
    assert((await withCookie(`morpheus_session=${forged}.${mac}`, "/api/templates")).status === 401, "kurcalanmış çerez reddedildi");

    for (let i = 0; i < 5; i++) await login("kilit", "yanlis");
    const locked = await login("kilit", "k");
    assert(locked.status === 429, "5 hatalı denemeden sonra hesap geçici kilitlendi");

    const out = await withCookie(aliCookie, "/api/auth/logout", { method: "POST", body: "{}" });
    assert(/Max-Age=0/.test(out.headers.get("set-cookie")), "çıkışta çerez silindi");
  } finally {
    srv.kill();
  }

  // ---- Sadece üç değerle: LDAP_SERVER + LDAP_BASE_DN + LDAP_BIND_DN (kullanıcı şablonu) ----
  const base2 = "http://127.0.0.1:3986";
  const srv2 = startServer(3986, {
    MORPHEUS_MODE: "demo",
    LDAP_SERVER: "127.0.0.1:3989",
    LDAP_BASE_DN: "DC=test,DC=local",
    LDAP_BIND_DN: "{{username}}@test.local",
  });
  const login2 = (username, password) =>
    fetch(`${base2}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  try {
    await waitFor(base2);
    const h = await (await fetch(`${base2}/api/health`)).json();
    assert(h.auth.enabled && h.auth.url === "ldap://127.0.0.1:3989" && h.auth.mode === "direct-bind", "3 değerle yapılandırma: sunucu adresi tamamlandı, doğrudan bind modu");
    const r = await login2("ali", "dogru");
    const b = await r.json();
    assert(r.ok && b.user.displayName === "Ali Veli" && b.user.username === "ali", "servis hesabı olmadan giriş; ad bilgisi varsayılan filtreyle bulundu");
    assert((await login2("ali", "yanlis")).status === 401, "3 değerle yapılandırmada yanlış parola reddedildi");
  } finally {
    srv2.kill();
  }

  // ---- LDAP_BIND_DN bir OU (tırnaklı, Podman'ın aktardığı gibi) → kullanici@alanadi ile bind ----
  const base4 = "http://127.0.0.1:3984";
  const srv4 = startServer(3984, {
    MORPHEUS_MODE: "demo",
    LDAP_SERVER: "127.0.0.1:3989",
    LDAP_BASE_DN: '"DC=test,DC=local"',
    LDAP_BIND_DN: '"OU=All Users,DC=test,DC=local"',
  });
  const login4 = (username, password) =>
    fetch(`${base4}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  try {
    await waitFor(base4);
    const h = await (await fetch(`${base4}/api/health`)).json();
    assert(/^upn-bind \(kullanici@test\.local, arama: OU=All Users,DC=test,DC=local\)$/.test(h.auth.mode),
      "OU verilince tırnaklar temizlendi, alan adı DN'den çıkarıldı (upn-bind)");
    const r = await login4("ali", "dogru");
    const b = await r.json();
    assert(r.ok && b.user.displayName === "Ali Veli" && b.user.username === "ali", "OU + kullanıcı parolasıyla giriş (servis hesabı yok)");
    assert((await login4("ali@test.local", "dogru")).ok, "kullanıcı tam UPN yazınca da giriş yapıldı");
    assert((await login4("ali", "yanlis")).status === 401, "OU modunda yanlış parola reddedildi");
  } finally {
    srv4.kill();
  }

  // ---- Sabit DN, parola YOK → anonim arama + kullanıcının kendi parolasıyla doğrulama ----
  const base3 = "http://127.0.0.1:3985";
  const srv3 = startServer(3985, {
    MORPHEUS_MODE: "demo", LDAP_SERVER: "127.0.0.1:3989", LDAP_BASE_DN: "DC=test,DC=local", LDAP_BIND_DN: "CN=svc,DC=test,DC=local",
  });
  const login3 = (username, password) =>
    fetch(`${base3}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
  try {
    await waitFor(base3);
    const h = await (await fetch(`${base3}/api/health`)).json();
    assert(h.auth.mode === "anonymous-search", "parolasız bind DN → anonim arama modu");
    const before = seen.anonymousSearches;
    const r = await login3("ali", "dogru");
    assert(r.ok && (await r.json()).user.displayName === "Ali Veli" && seen.anonymousSearches === before + 1,
      "servis parolası olmadan giriş: kullanıcı anonim arandı, kendi parolasıyla doğrulandı");
    assert((await login3("ali", "yanlis")).status === 401, "anonim aramada da yanlış kullanıcı parolası reddedildi");
    assert((await login3("ali", "")).status === 400, "anonim aramada da boş kullanıcı parolası reddedildi");
    seen.denyAnonymous = true;
    const denied = await login3("ali", "dogru");
    assert(denied.status === 502 && /anonim\) aramaya izin vermiyor/.test((await denied.json()).error),
      "sunucu anonim aramayı reddederse (AD varsayılanı) açık hata mesajı");
    seen.denyAnonymous = false;
  } finally {
    srv3.kill();
    ldap.close();
  }
}

/* ------------------------------------------------------------------ */
/*  Düzeltme akışı: UnixAI bulgusu → playbook → onay → AAP runner      */
/* ------------------------------------------------------------------ */
function fakeAapRunner() {
  const seen = { launches: [], jobs: {} };
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const u = new URL(req.url, "http://x");
      if (req.headers.authorization !== "Bearer aap-exec") return send(401, {});
      if (u.pathname === "/api/v2/ping/") return send(200, { version: "4.5.0" });
      let m;
      if (req.method === "POST" && (m = u.pathname.match(/^\/api\/v2\/job_templates\/(\d+)\/launch\/$/))) {
        const b = JSON.parse(body);
        const id = 1000 + seen.launches.length;
        seen.launches.push({ template: m[1], ...b });
        seen.jobs[id] = { id, status: "pending", job_type: b.job_type };
        return send(201, { job: id, id, status: "pending", ignored_fields: {} });
      }
      if ((m = u.pathname.match(/^\/api\/v2\/jobs\/(\d+)\/stdout\/$/))) { res.writeHead(200, { "content-type": "text/plain" }); return res.end(`PLAY [UnixAI] ok=3 job=${m[1]}`); }
      if ((m = u.pathname.match(/^\/api\/v2\/jobs\/(\d+)\/$/))) return send(200, seen.jobs[m[1]] || {});
      send(404, {});
    });
  });
  return { srv, seen };
}

async function remediationSuite() {
  console.log("\n[Düzeltme akışı — UnixAI OS bulgusu → playbook → AAP runner]");
  const { srv: aapSrv, seen } = fakeAapRunner();
  await new Promise((r) => aapSrv.listen(3983, "127.0.0.1", r));
  const base = "http://127.0.0.1:3982";
  const TOKEN = "unixai-bridge-token-1234567890";
  const srv = startServer(3982, {
    MORPHEUS_MODE: "demo", AAP_URL: "http://127.0.0.1:3983", AAP_TOKEN: "aap-exec", AAP_API_PREFIX: "/api/v2",
    REMEDIATION_JOB_TEMPLATE_ID: "42", MORPHEUS_API_TOKEN: TOKEN,
  });
  const call = (p, { method = "GET", body, token = TOKEN } = {}) =>
    fetch(base + "/api" + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, data: await r.text().then((t) => { try { return JSON.parse(t); } catch { return t; } }) }));
  const mcp = spawn(process.execPath, [path.join(__dirname, "..", "mcp", "morpheus-mcp.js")], {
    env: { ...process.env, MORPHEUS_URL: base, MORPHEUS_API_TOKEN: TOKEN }, stdio: ["pipe", "pipe", "ignore"],
  });
  let mcpBuf = "";
  const pending = new Map();
  mcp.stdout.on("data", (c) => {
    mcpBuf += c;
    let i;
    while ((i = mcpBuf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(mcpBuf.slice(0, i));
      mcpBuf = mcpBuf.slice(i + 1);
      pending.get(msg.id)?.(msg);
    }
  });
  let rpcId = 0;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = ++rpcId;
    pending.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

  try {
    await waitFor(base);
    const finding = {
      server: { name: "rhel-db01", target: "rhel-db01.corp.local", host: "10.20.30.11", os_release: "Red Hat Enterprise Linux release 8.9 (Ootpa)" },
      finding: { title: "/u01 alanını genişlet", priority: "P1", severity: "critical", evidence: "/u01 %96",
        commands: ["df -h /u01", "lvextend -r -L +200G /dev/vg_data/u01"] },
      source: "unixai-os",
    };
    assert((await call("/remediations", { method: "POST", body: finding, token: "yanlis-token-000000000000" })).status === 401, "geçersiz API token reddedildi");
    const created = await call("/remediations", { method: "POST", body: finding });
    const r = created.data;
    assert(created.status === 201 && r.status === "generated" && r.runnable, "UnixAI bulgusundan düzeltme kaydı oluşturuldu");
    assert(r.playbook.includes('hosts: "{{ target_host }}"') && r.playbook.includes("ansible.builtin.shell") && !/^\s+ansible\.builtin\.shell: "lvextend/m.test(r.playbook),
      "GenAI yokken yalnızca salt-okunur tanı komutları çalıştırılıyor (lvextend bilgi olarak)");
    assert(typeof r.compliance?.score === "number", `standart analizi yapıldı (uyum ${r.compliance.score})`);
    assert((await call(`/remediations/${r.id}/launch`, { method: "POST", body: { mode: "run" } })).status === 409, "onaysız gerçek çalıştırma engellendi");
    assert((await call(`/remediations/${r.id}/approve`, { method: "POST", body: {} })).status === 403, "API token ile onay verilemez (yalnızca arayüz)");

    const chk = await call(`/remediations/${r.id}/launch`, { method: "POST", body: { mode: "check" } });
    const l = seen.launches[0];
    assert(chk.status === 202 && chk.data.status === "check_running" && l.template === "42" && l.job_type === "check" && l.limit === "rhel-db01.corp.local",
      "check (dry-run) AAP runner'ında doğru limit ile başlatıldı");
    const tasks = Buffer.from(l.extra_vars.remediation_tasks_b64, "base64").toString("utf8");
    assert(l.extra_vars.target_host === "rhel-db01.corp.local" && /^- name: "Tanı \| df -h \/u01"/m.test(tasks) && l.extra_vars.unixai_allow_disruptive === false,
      "runner'a task listesi base64 olarak gönderildi");

    const ui = await call(`/remediations/${r.id}/approve`, { method: "POST", body: {}, token: null });
    assert(ui.status === 200 && ui.data.approval, "arayüzden onaylandı");
    assert((await call(`/remediations/${r.id}/launch`, { method: "POST", body: { mode: "run" } })).status === 409, "check bitmeden gerçek çalıştırma engellendi");
    seen.jobs[1000].status = "successful";
    await new Promise((res) => setTimeout(res, 3100)); // durum yenileme aralığı
    const after = await call(`/remediations/${r.id}`);
    assert(after.data.status === "approved" && after.data.jobs[0].status === "successful", "AAP iş durumu güncellendi (check başarılı)");
    const out = await call(`/remediations/${r.id}/jobs/1000/stdout`);
    assert(String(out.data).includes("job=1000"), "AAP iş çıktısı okundu");
    const run = await call(`/remediations/${r.id}/launch`, { method: "POST", body: { mode: "run" } });
    assert(run.status === 202 && seen.launches[1].job_type === "run" && run.data.status === "running", "onay + başarılı check sonrası sunucuya uygulandı");

    console.log("  [MCP]");
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert(init.result.serverInfo.name === "morpheusai" && init.result.capabilities.tools, "MCP initialize");
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tl = await rpc("tools/list", {});
    assert(tl.result.tools.some((t) => t.name === "morpheus_create_remediation") && tl.result.tools.every((t) => t.inputSchema), "MCP tools/list");
    const c2 = await rpc("tools/call", { name: "morpheus_create_remediation", arguments: { server: { name: "rhel-web01" }, finding: { title: "httpd failed", commands: ["systemctl status httpd"] } } });
    const created2 = JSON.parse(c2.result.content[0].text);
    assert(!c2.result.isError && created2.status === "generated" && created2.playbook, "MCP üzerinden düzeltme oluşturuldu");
    const ls = await rpc("tools/call", { name: "morpheus_list_remediations", arguments: { server: "rhel-web01" } });
    assert(JSON.parse(ls.result.content[0].text).items.length === 1, "MCP listeleme (sunucu filtresi)");
    const bad = await rpc("tools/call", { name: "morpheus_launch_remediation", arguments: { id: created2.id, mode: "run" } });
    assert(bad.result.isError && /onay/.test(bad.result.content[0].text), "MCP onaysız gerçek çalıştırmayı hata olarak döndürdü");
  } finally {
    mcp.kill();
    srv.kill();
    aapSrv.close();
  }
}

(async () => {
  try {
    await demoSuite();
    await genaiSuite();
    await aapSuite();
    await ldapSuite();
    await remediationSuite();
    console.log("\nSmoke test başarılı.");
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    process.exitCode = 1;
  }
})();
