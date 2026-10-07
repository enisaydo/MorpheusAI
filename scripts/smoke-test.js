/*
 * Sunucuyu ayrı bir portta başlatır, temel uç noktaları doğrular ve kapatır.
 * Kullanım: npm test
 */
const { spawn } = require("child_process");
const path = require("path");

const PORT = process.env.TEST_PORT || 3999;
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
  env: { ...process.env, PORT, AI_BACKEND_URL: "" },
  stdio: ["ignore", "pipe", "inherit"],
});

const post = (p, body) =>
  fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Sunucu ayağa kalkmadı");
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`  ✓ ${msg}`);
}

(async () => {
  try {
    await waitForServer();

    const health = await (await fetch(`${BASE}/api/health`)).json();
    assert(health.status === "ok" && health.mode === "demo", "health: ok / demo");

    const index = await fetch(`${BASE}/`);
    assert(index.ok && (await index.text()).includes("MorpheusAI"), "index.html sunuluyor");

    for (const f of ["styles.css", "js/api.js", "js/ui.js", "js/app.js"])
      assert((await fetch(`${BASE}/${f}`)).ok, `${f} sunuluyor`);

    const std = await (await fetch(`${BASE}/api/standards`)).json();
    assert(Array.isArray(std) && std.length > 0, "standards listesi dolu");

    const bad = await (await fetch(`${BASE}/api/templates/jt-101`)).json();
    const badRes = await (await post("/api/analyze/template", { content: bad.content })).json();
    assert(badRes.score < 60 && badRes.findings.length > 0, `hatalı template düşük skor aldı (${badRes.score})`);

    const good = await (await fetch(`${BASE}/api/templates/jt-103`)).json();
    const goodRes = await (await post("/api/analyze/template", { content: good.content })).json();
    assert(goodRes.score >= 85, `uyumlu template yüksek skor aldı (${goodRes.score})`);

    const wf = await (await fetch(`${BASE}/api/workflows/wf-202`)).json();
    const wfRes = await (await post("/api/analyze/workflow", { workflow: wf })).json();
    assert(wfRes.findings.some((f) => f.ruleId === "WF-004"), "prod workflow onay eksikliği yakalandı");

    const chat = await (await post("/api/chat", { messages: [{ role: "user", content: "merhaba" }] })).json();
    assert(typeof chat.reply === "string" && chat.reply.length > 0, "chat cevap döndü");

    const traversal = await fetch(`${BASE}/..%2f..%2fserver.js`);
    assert(!(await traversal.text()).includes("require("), "path traversal engelleniyor");

    console.log("\nSmoke test başarılı.");
    process.exitCode = 0;
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();
