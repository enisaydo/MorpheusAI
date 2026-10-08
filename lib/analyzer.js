/*
 * MorpheusAI - AI tabanlı analiz
 * Standartları ve içeriği prompt'a dönüştürür, GenAI'dan yapılandırılmış JSON ister,
 * cevabı arayüzün beklediği AnalysisResult şekline normalize eder.
 */
const genai = require("./genai");
const demo = require("./demo");
const prompts = require("./prompts");

const RESULT_SCHEMA = `{
  "score": <0-100 tam sayı>,
  "status": "compliant" | "warning" | "non_compliant",
  "summary": "<1-2 cümle genel değerlendirme>",
  "findings": [
    { "ruleId": "<kural ID>", "severity": "critical|high|medium|low|info",
      "title": "<kısa başlık>", "detail": "<açıklama>",
      "line": <satır no veya null>, "nodeId": "<workflow düğüm id veya null>",
      "fix": "<düzeltilmiş YAML/öneri veya null>" }
  ],
  "missing": ["<eksik bölüm>", ...]
}`;

const SEVERITIES = ["critical", "high", "medium", "low", "info"];

/** role: "system" içeriği — Ayarlar ekranından düzenlenen metin */
const systemPrompt = () => prompts.get().system;

function rulesText(standards, ruleIds, customRules = []) {
  const all = [...standards, ...customRules];
  const picked = ruleIds?.length ? all.filter((r) => ruleIds.includes(r.id)) : all;
  return picked.map((r) => `- ${r.id} [${r.severity}] ${r.title}: ${r.description}`).join("\n");
}

const numbered = (text) => text.split(/\r?\n/).map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join("\n");

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fenced ? fenced[1] : text;
  const start = src.indexOf("{"), end = src.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("JSON bulunamadı");
  return JSON.parse(src.slice(start, end + 1));
}

function normalize(r) {
  const findings = (Array.isArray(r.findings) ? r.findings : []).map((f) => ({
    ruleId: f.ruleId || f.rule_id || "",
    severity: SEVERITIES.includes(String(f.severity).toLowerCase()) ? String(f.severity).toLowerCase() : "info",
    title: f.title || "Bulgu",
    detail: f.detail || f.description || "",
    line: Number.isInteger(f.line) ? f.line : null,
    nodeId: f.nodeId || f.node_id || null,
    fix: f.fix || null,
  }));
  findings.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  const score = Math.max(0, Math.min(100, Math.round(Number(r.score) || 0)));
  return {
    score,
    status: ["compliant", "warning", "non_compliant"].includes(r.status)
      ? r.status
      : score >= 85 ? "compliant" : score >= 60 ? "warning" : "non_compliant",
    summary: r.summary || "",
    findings,
    missing: Array.isArray(r.missing) ? r.missing : [],
    engine: "genai",
  };
}

async function runStructured(messages, opts, fallback) {
  const reply = await genai.chat(messages, opts);
  try {
    return normalize(extractJson(reply));
  } catch {
    // Model JSON dönmezse: kural motoru sonucunu göster, AI metnini özet olarak ekle
    const res = fallback();
    return { ...res, summary: reply.slice(0, 1500), engine: "genai-text+heuristic" };
  }
}

async function analyzeTemplate({ content, rules, customRules, prompt, model }, standards) {
  const messages = [
    { role: "system", content: systemPrompt() },
    {
      role: "user",
      content:
        `Aşağıdaki Ansible template'ini kurumsal standartlara göre analiz et. ` +
        `İçerik bir playbook YAML'ı ya da AAP job template tanımı (JSON, type=aap_job_template) olabilir; ` +
        `yalnızca içeriğin türüne uygulanabilen kuralları değerlendir.\n\n` +
        `## Uygulanacak kurallar\n${rulesText(standards.filter((s) => s.scope === "template"), rules, customRules)}\n\n` +
        (prompt ? `## Ek talimat\n${prompt}\n\n` : "") +
        `## Template (satır numaralı)\n\`\`\`\n${numbered(content)}\n\`\`\`\n\n` +
        `Yalnızca şu şemaya uyan geçerli JSON döndür, başka metin yazma:\n${RESULT_SCHEMA}`,
    },
  ];
  return runStructured(messages, { model, kind: "analyze-template" }, () => demo.analyzeTemplate(content, rules));
}

async function analyzeWorkflow({ workflow, rules, customRules, prompt, model }, standards) {
  const messages = [
    { role: "system", content: systemPrompt() },
    {
      role: "user",
      content:
        `Aşağıdaki AAP/AWX workflow akışını kurumsal standartlara göre analiz et. ` +
        `Düğümler success/failure/always dallarıyla birbirine bağlıdır; düğüme özel bulgularda nodeId ver. ` +
        `"notifications" alanı workflow seviyesinde tanımlı bildirimleri gösterir (null = okunamadı).\n\n` +
        `## Uygulanacak kurallar\n${rulesText(standards.filter((s) => s.scope === "workflow"), rules, customRules)}\n\n` +
        (prompt ? `## Ek talimat\n${prompt}\n\n` : "") +
        `## Workflow\n\`\`\`json\n${JSON.stringify(workflow, null, 2)}\n\`\`\`\n\n` +
        `Yalnızca şu şemaya uyan geçerli JSON döndür, başka metin yazma:\n${RESULT_SCHEMA}`,
    },
  ];
  return runStructured(messages, { model, kind: "analyze-workflow" }, () => demo.analyzeWorkflow(workflow, rules));
}

/** Sohbete eklenen bağlamı prompt metnine çevirir. */
function contextText(ctx) {
  if (!ctx) return "";
  if (ctx.kind === "template" && ctx.content)
    return `## Kullanıcının seçtiği template: ${ctx.name || ""}\n\`\`\`\n${String(ctx.content).slice(0, 30000)}\n\`\`\``;
  if (ctx.kind === "workflow" && ctx.workflow)
    return `## Kullanıcının seçtiği workflow: ${ctx.name || ""}\n\`\`\`json\n${JSON.stringify(ctx.workflow, null, 2).slice(0, 30000)}\n\`\`\``;
  return `## Kullanıcının son analiz sonucu\n\`\`\`json\n${JSON.stringify(ctx).slice(0, 12000)}\n\`\`\``;
}

/**
 * Sohbet: messages = [ {role:"system", content: Ayarlar'daki metin (+ standartlar + bağlam)},
 *                      ...önceki mesajlar, {role:"user", content: kullanıcının yazdığı metin (değiştirilmeden)} ]
 */
async function chat({ messages = [], context, model, rules, customRules }, standards = []) {
  const p = prompts.get();
  const active = [...standards, ...(customRules || [])].filter((r) => !rules?.length || rules.includes(r.id));
  const sys = [
    p.system,
    p.includeStandards && active.length
      ? `## Kurumsal standartlar\n${active.map((r) => `- ${r.id} [${r.scope}/${r.severity}] ${r.title}: ${r.description}`).join("\n")}`
      : "",
    contextText(context),
  ].filter(Boolean).join("\n\n");

  const history = messages
    .filter((m) => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string")
    .slice(-20);

  const reply = await genai.chat([{ role: "system", content: sys }, ...history], { model, kind: "chat" });
  return { reply, engine: "genai" };
}

module.exports = { analyzeTemplate, analyzeWorkflow, chat };
