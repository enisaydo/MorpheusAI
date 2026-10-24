/*
 * MorpheusAI araçları — hem yerel ajan hem de barındırılan MCP sunucusu (/mcp) tarafından kullanılır
 * Her araç: name, description, inputSchema, readonly, handler(args, ctx). Salt-okunur token'lar yalnızca readonly araçları görür.
 * ctx: { user, ip, readonly, ai (sunucu GENAI modunda mı), source, client }
 */
const aap = require("./aap");
const analyzer = require("./analyzer");
const demo = require("./demo");
const remediation = require("./remediation");

const STANDARDS = require("../mock/standards.json");
const TEMPLATES = require("../mock/templates.json");
const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const s = (description, extra = {}) => ({ type: "string", description, ...extra });

async function listTemplates() {
  if (aap.isConfigured()) return aap.listJobTemplates();
  return TEMPLATES.map(({ content, ...t }) => ({ ...t, source: "mock" }));
}

async function getTemplate(id) {
  if (aap.isConfigured()) return aap.getJobTemplate(id);
  const t = TEMPLATES.find((x) => String(x.id) === String(id));
  if (!t) throw httpError(404, "Job template bulunamadı");
  return t;
}

function brief(r, withPlaybook = true) {
  return {
    id: r.id, status: r.status, server: r.server, title: r.title, summary: r.summary, risk: r.risk, disruptive: r.disruptive, engine: r.engine,
    compliance: r.compliance && { score: r.compliance.score, status: r.compliance.status, violations: (r.compliance.findings || []).map((f) => `${f.ruleId} [${f.severity}] ${f.title}`) },
    runnable: r.runnable, runnerError: r.runnerError, approval: r.approval, rejected: r.rejected || undefined,
    jobs: (r.jobs || []).map((j) => ({ id: j.id, mode: j.mode, status: j.status, url: j.url })),
    ...(withPlaybook && r.playbook ? { playbook: r.playbook } : {}),
    next: r.status === "generated" ? "Check modda çalıştırılabilir (mode=check). Gerçek uygulama için MorpheusAI arayüzünden onay gerekir."
      : r.status === "check_ok" ? "Check başarılı; gerçek uygulama için MorpheusAI arayüzünde onay bekleniyor."
      : r.status === "approved" ? "Onaylı; mode=run ile uygulanabilir." : undefined,
  };
}

const TOOLS = [
  {
    name: "morpheus_list_standards", readonly: true,
    description: "Kurumsal Ansible standartları (kural ID, kapsam, önem, açıklama). Playbook yazarken ve değerlendirirken uyulacak kurallar.",
    inputSchema: { type: "object", properties: { scope: s("template veya workflow (boş = tümü)", { enum: ["template", "workflow"] }) } },
    handler: async ({ scope }) => STANDARDS.filter((r) => !scope || r.scope === scope),
  },
  {
    name: "morpheus_list_templates", readonly: true,
    description: "AAP'deki job template'ler (AAP bağlı değilse örnek veri).",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({ templates: await listTemplates() }),
  },
  {
    name: "morpheus_get_template", readonly: true,
    description: "Bir AAP job template'inin tanımı (envanter, credential, extra_vars, survey...).",
    inputSchema: { type: "object", required: ["id"], properties: { id: s("Job template ID") } },
    handler: async ({ id }) => getTemplate(id),
  },
  {
    name: "morpheus_analyze_template", readonly: true,
    description: "Bir playbook YAML'ını veya AAP job template tanımını kurumsal standartlara göre analiz eder (skor, bulgular, düzeltme önerileri).",
    inputSchema: { type: "object", required: ["content"], properties: { content: s("Playbook YAML veya AAP tanımı"), title: s("Başlık") } },
    handler: async ({ content, title }, ctx) => (ctx.ai ? analyzer.analyzeTemplate({ content, title }, STANDARDS, ctx) : demo.analyzeTemplate(content)),
  },
  {
    name: "morpheus_create_remediation", readonly: false,
    description: "Bir sunucu bulgusu için kurumsal standartlara uygun düzeltme playbook'u üretir, standart analizinden geçirir ve 'onay bekliyor' kaydı oluşturur. Hiçbir şey çalıştırmaz.",
    inputSchema: {
      type: "object", required: ["server", "finding"],
      properties: {
        server: { type: "object", required: ["name"], properties: { name: s("Sunucu adı"), target: s("AAP envanterindeki host adı (boşsa name)"), host: s("IP/FQDN"), os_release: s("OS sürümü"), kernel: s("kernel") } },
        finding: {
          type: "object", required: ["title"],
          properties: { title: s("Bulgu / aksiyon"), priority: s("P1|P2|P3"), severity: s("critical|high|medium|low"), category: s("kategori"), evidence: s("kanıt"),
            probable_cause: s("olası neden"), rationale: s("gerekçe"), commands: { type: "array", items: { type: "string" } }, verification: s("doğrulama"), risk: s("risk") },
        },
      },
    },
    handler: async ({ server, finding }, ctx) => brief(await remediation.create({ server, finding, source: ctx.source || "mcp" }, STANDARDS, ctx, { ai: ctx.ai })),
  },
  {
    name: "morpheus_list_remediations", readonly: true,
    description: "Düzeltme kayıtları (generated=onay bekliyor, check_ok, approved, applied, failed...).",
    inputSchema: { type: "object", properties: { status: s("durum"), server: s("sunucu adı") } },
    handler: async ({ status, server }) => ({ items: remediation.list({ status, server }), config: remediation.config() }),
  },
  {
    name: "morpheus_get_remediation", readonly: true,
    description: "Bir düzeltmenin ayrıntısı: playbook, uyum, onay, AAP işlerinin güncel durumu.",
    inputSchema: { type: "object", required: ["id"], properties: { id: s("rem-...") } },
    handler: async ({ id }) => {
      const r = await remediation.get(id);
      if (!r) throw httpError(404, "Düzeltme kaydı bulunamadı");
      return brief(r);
    },
  },
  {
    name: "morpheus_launch_remediation", readonly: false,
    description: "Düzeltme playbook'unu AAP runner ile hedef sunucuda başlatır. mode=check: dry-run (değişiklik yapmaz). mode=run: gerçek uygulama — MorpheusAI arayüzünde onay ve başarılı check gerekir.",
    inputSchema: { type: "object", required: ["id"], properties: { id: s("rem-..."), mode: s("check veya run", { enum: ["check", "run"] }) } },
    handler: async ({ id, mode = "check" }, ctx) => brief(await remediation.launch(id, { mode: mode === "run" ? "run" : "check" }, ctx), false),
  },
  {
    name: "morpheus_job_output", readonly: true,
    description: "Bir düzeltmeye ait AAP işinin konsol çıktısı (son 20.000 karakter).",
    inputSchema: { type: "object", required: ["id", "jobId"], properties: { id: s("rem-..."), jobId: s("AAP iş no") } },
    handler: async ({ id, jobId }) => ({ output: String(await remediation.stdout(id, jobId)).slice(-20000) }),
  },
  {
    name: "morpheus_agent_ask", readonly: true, agent: true,
    description: "MorpheusAI AJANINA doğal dilde istek gönderir: Ansible/AAP otomasyon uzmanıdır; standartlara uygun playbook yazar, analiz eder, AAP'de check çalıştırır ve sonucu yorumlar. " +
      "Başka bir ajanın (ör. UnixAI) MorpheusAI ile konuşması için kullanılır; sunucu adını, bulguyu ve kanıtı isteğe ekleyin.",
    inputSchema: {
      type: "object", required: ["question"],
      properties: {
        question: s("İstek veya soru"),
        context: { type: "object", description: "Ajanlar arası izleme (otomatik doldurulur)", properties: { conversation_id: { type: "string" }, hop: { type: "integer" }, from: { type: "string" } } },
      },
    },
    handler: async ({ question, context = {} }, ctx) => {
      const agent = require("./agent");
      const r = await agent.run([{ role: "user", content: question }], {
        ctx: { ...ctx, source: context.from || ctx.source },
        hop: Number(context.hop) || 1, conversationId: context.conversation_id || null, origin: context.from || ctx.client || "mcp",
      });
      return { answer: r.reply, conversationId: r.conversationId, steps: r.trace.length, tools_used: r.trace.filter((t) => t.tool).map((t) => t.tool) };
    },
  },
];
const BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

const visible = (readonly = false, includeAgent = true) => TOOLS.filter((t) => (t.readonly || !readonly) && (includeAgent || !t.agent));

async function call(name, args, ctx) {
  const t = BY_NAME[name];
  if (!t) throw httpError(404, `Bilinmeyen araç: ${name}`);
  if (ctx.readonly && !t.readonly) throw httpError(403, `'${name}' salt-okunur erişimle kullanılamaz`);
  return t.handler(args || {}, ctx);
}

module.exports = { TOOLS, BY_NAME, visible, call };
