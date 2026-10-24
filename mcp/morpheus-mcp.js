#!/usr/bin/env node
/*
 * MorpheusAI MCP sunucusu (Model Context Protocol, stdio, bağımlılıksız)
 *
 * MorpheusAI'nin REST API'sini MCP araçları olarak sunar. Claude Code / Claude Desktop gibi bir MCP istemcisi
 * bu sunucuyu ve UnixAI OS MCP sunucusunu birlikte kullanarak iki sistemi konuşturur:
 *   unixai_get_server_findings → morpheus_create_remediation → morpheus_launch_remediation (check) → ...
 *
 * Ortam değişkenleri:
 *   MORPHEUS_URL        http://morpheus.kurum.local:3000
 *   MORPHEUS_API_TOKEN  MorpheusAI .env'deki MORPHEUS_API_TOKEN ile aynı
 *   MORPHEUS_TLS_INSECURE=true   (self-signed sertifika)
 *
 * Çalıştırma: node mcp/morpheus-mcp.js   (MCP istemcisi başlatır; stdout yalnızca JSON-RPC içindir)
 */
const BASE = (process.env.MORPHEUS_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.MORPHEUS_API_TOKEN || "";
if (/^(1|true|yes)$/i.test(process.env.MORPHEUS_TLS_INSECURE || "")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const log = (...a) => process.stderr.write(`[morpheus-mcp] ${a.join(" ")}\n`);

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + "/api" + path, {
    method,
    headers: { "content-type": "application/json", accept: "application/json", "x-morpheus-client": "mcp", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(Number(process.env.MORPHEUS_TIMEOUT_MS || 600000)),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`MorpheusAI ${res.status}: ${data?.error || text.slice(0, 300)}`);
  return data;
}

const s = (description, extra = {}) => ({ type: "string", description, ...extra });

const TOOLS = [
  {
    name: "morpheus_list_standards",
    description: "MorpheusAI'deki kurumsal Ansible standartlarını (kural ID, önem, açıklama) listeler. Playbook yazarken uyulması gereken kurallardır.",
    inputSchema: { type: "object", properties: { scope: s("template veya workflow (boş = tümü)", { enum: ["template", "workflow"] }) } },
    run: async ({ scope }) => (await api("/standards")).filter((r) => !scope || r.scope === scope),
  },
  {
    name: "morpheus_create_remediation",
    description:
      "UnixAI OS'un bir sunucuda bulduğu bulgu için MorpheusAI'ye düzeltme isteği gönderir. MorpheusAI kurumsal standartlara uygun bir Ansible playbook üretir, " +
      "standart analizinden geçirir (uyum skoru) ve kaydı 'onay bekliyor' durumunda döndürür. Henüz hiçbir şey çalıştırılmaz.",
    inputSchema: {
      type: "object",
      required: ["server", "finding"],
      properties: {
        server: {
          type: "object", required: ["name"],
          properties: {
            name: s("Sunucu adı (UnixAI)"), target: s("AAP envanterindeki host adı (boşsa name)"), host: s("IP/FQDN"),
            os_release: s("ör. Red Hat Enterprise Linux release 8.9"), kernel: s("kernel sürümü"),
          },
        },
        finding: {
          type: "object", required: ["title"],
          properties: {
            title: s("Aksiyon / bulgu başlığı"), priority: s("P1|P2|P3"), severity: s("critical|high|medium|low"), category: s("disk, memory, service..."),
            evidence: s("Kanıt (metrik veya log satırı)"), probable_cause: s("Olası kök neden"), rationale: s("Gerekçe"),
            commands: { type: "array", items: { type: "string" }, description: "UnixAI'nin önerdiği komutlar" },
            verification: s("Doğrulama yöntemi"), risk: s("Risk notu"),
          },
        },
      },
    },
    run: async ({ server, finding }) => brief(await api("/remediations", { method: "POST", body: { server, finding, source: "mcp" } }), true),
  },
  {
    name: "morpheus_list_remediations",
    description: "Düzeltme kayıtlarını listeler (durum: generated=onay bekliyor, check_ok, approved, applied, failed...).",
    inputSchema: { type: "object", properties: { status: s("durum filtresi"), server: s("sunucu adı filtresi") } },
    run: async ({ status, server }) => {
      const q = new URLSearchParams(Object.entries({ status, server }).filter(([, v]) => v));
      return api(`/remediations?${q}`);
    },
  },
  {
    name: "morpheus_get_remediation",
    description: "Bir düzeltme kaydının ayrıntısı: playbook, standart uyum bulguları, onay, AAP işlerinin güncel durumu ve olay geçmişi.",
    inputSchema: { type: "object", required: ["id"], properties: { id: s("Düzeltme kayıt numarası (rem-...)") } },
    run: async ({ id }) => brief(await api(`/remediations/${encodeURIComponent(id)}`), true),
  },
  {
    name: "morpheus_launch_remediation",
    description:
      "Düzeltme playbook'unu AAP runner job template'i ile hedef sunucuda başlatır. mode=check: Ansible check modu (dry-run, değişiklik yapmaz) — her zaman kullanılabilir. " +
      "mode=run: gerçek uygulama — kaydın Morpheus arayüzünden bir yönetici tarafından onaylanmış olması ve (varsayılan) önce başarılı bir check çalıştırması gerekir.",
    inputSchema: {
      type: "object", required: ["id"],
      properties: { id: s("Düzeltme kayıt numarası"), mode: s("check veya run", { enum: ["check", "run"], default: "check" }), allowDisruptive: { type: "boolean", description: "Kesinti riskli task'lara izin (yalnızca run)", default: false } },
    },
    run: async ({ id, mode = "check", allowDisruptive = false }) => brief(await api(`/remediations/${encodeURIComponent(id)}/launch`, { method: "POST", body: { mode, allowDisruptive } })),
  },
  {
    name: "morpheus_job_output",
    description: "Bir düzeltmeye ait AAP işinin konsol çıktısını (stdout) döndürür.",
    inputSchema: { type: "object", required: ["id", "jobId"], properties: { id: s("Düzeltme kayıt numarası"), jobId: s("AAP iş numarası") } },
    run: async ({ id, jobId }) => {
      const out = await api(`/remediations/${encodeURIComponent(id)}/jobs/${encodeURIComponent(jobId)}/stdout`);
      return typeof out === "string" ? out.slice(-20000) : out;
    },
  },
  {
    name: "morpheus_analyze_template",
    description: "Bir playbook YAML'ını veya AAP job template tanımını kurumsal standartlara göre analiz eder (skor, bulgular, düzeltmeler).",
    inputSchema: { type: "object", required: ["content"], properties: { content: s("Playbook YAML"), title: s("Başlık"), prompt: s("Ek talimat") } },
    run: async ({ content, title, prompt }) => api("/analyze/template", { method: "POST", body: { content, title, prompt } }),
  },
];

function brief(r, withPlaybook = false) {
  const out = {
    id: r.id, status: r.status, server: r.server, title: r.title, summary: r.summary, risk: r.risk, disruptive: r.disruptive,
    engine: r.engine, compliance: r.compliance && { score: r.compliance.score, status: r.compliance.status, violations: (r.compliance.findings || []).map((f) => `${f.ruleId} [${f.severity}] ${f.title}`) },
    runnable: r.runnable, runnerError: r.runnerError || undefined, approval: r.approval, rejected: r.rejected || undefined,
    jobs: (r.jobs || []).map((j) => ({ id: j.id, mode: j.mode, status: j.status, url: j.url })),
    next: r.status === "generated" ? "Check modda çalıştırın (morpheus_launch_remediation mode=check); gerçek uygulama için Morpheus arayüzünden onay gerekir."
      : r.status === "check_ok" ? "Check başarılı. Gerçek uygulama için Morpheus arayüzünden (Düzeltmeler) onay verilmeli."
      : r.status === "approved" ? "Onaylı. mode=run ile uygulanabilir." : undefined,
  };
  if (withPlaybook && r.playbook) out.playbook = r.playbook;
  return out;
}

/* ------------------------------------------------------------------ */
/*  JSON-RPC 2.0 / MCP (stdio, satır başına bir mesaj)                 */
/* ------------------------------------------------------------------ */
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  const { id, method, params = {} } = msg;
  if (id === undefined) return; // bildirim (notifications/initialized vb.)
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "morpheusai", title: "MorpheusAI (Ansible standartları & düzeltme)", version: "1.0.0" },
        instructions:
          "MorpheusAI kurumsal Ansible standartlarını bilir, UnixAI OS bulguları için standartlara uygun playbook üretir ve AAP'de çalıştırır. " +
          "Akış: morpheus_create_remediation → playbook ve uyum skorunu kullanıcıya göster → morpheus_launch_remediation mode=check → " +
          "check sonucu (morpheus_get_remediation / morpheus_job_output) → gerçek uygulama yalnızca Morpheus arayüzünde onay verildikten sonra mode=run.",
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS.map(({ run, ...t }) => t) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return fail(id, -32602, `Bilinmeyen araç: ${params.name}`);
      try {
        const result = await tool.run(params.arguments || {});
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return reply(id, { content: [{ type: "text", text }], ...(typeof result === "object" ? { structuredContent: Array.isArray(result) ? { items: result } : result } : {}) });
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: e.message }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `Desteklenmeyen metot: ${method}`);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
    handle(msg).catch((e) => log("hata:", e.message));
  }
});
process.stdin.on("end", () => process.exit(0));
log(`hazır → ${BASE}${TOKEN ? "" : " (MORPHEUS_API_TOKEN tanımlı değil)"}`);
