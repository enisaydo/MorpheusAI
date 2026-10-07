/*
 * MorpheusAI - API katmanı
 * Tüm backend çağrıları buradan geçer. AI backend'i bağlarken yalnızca
 * bu dosyayı (veya Ayarlar ekranındaki Base URL'i) değiştirmeniz yeterlidir.
 */
const Settings = (() => {
  const KEY = "morpheus.settings";
  const defaults = {
    apiBase: "/api",
    apiKey: "",
    model: "",
    systemPrompt:
      "Sen Morpheus'sun: kurumsal Ansible standartlarına göre Job Template ve Workflow denetleyen bir uzmansın. " +
      "Bulguları önem derecesiyle (critical/high/medium/low/info), ilgili kural ID'si ve somut YAML düzeltme önerisiyle ver. Türkçe cevap ver.",
  };
  let cache;
  const load = () => {
    if (cache) return cache;
    try { cache = { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; }
    catch { cache = { ...defaults }; }
    return cache;
  };
  return {
    get: load,
    save(values) {
      cache = { ...load(), ...values };
      try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch {}
      return cache;
    },
  };
})();

const Api = (() => {
  async function request(path, { method = "GET", body } = {}) {
    const s = Settings.get();
    const headers = { "Content-Type": "application/json" };
    if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;
    const res = await fetch(s.apiBase.replace(/\/$/, "") + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  const meta = () => {
    const s = Settings.get();
    return { model: s.model || undefined, systemPrompt: s.systemPrompt || undefined };
  };

  return {
    health: () => request("/health"),
    standards: () => request("/standards"),
    templates: () => request("/templates"),
    template: (id) => request(`/templates/${encodeURIComponent(id)}`),
    workflows: () => request("/workflows"),
    workflow: (id) => request(`/workflows/${encodeURIComponent(id)}`),

    /** @returns {Promise<AnalysisResult>} */
    analyzeTemplate: ({ content, rules, customRules, prompt, templateId }) =>
      request("/analyze/template", { method: "POST", body: { content, rules, customRules, prompt, templateId, ...meta() } }),

    analyzeWorkflow: ({ workflow, rules, customRules, prompt }) =>
      request("/analyze/workflow", { method: "POST", body: { workflow, rules, customRules, prompt, ...meta() } }),

    chat: ({ messages, context }) =>
      request("/chat", { method: "POST", body: { messages, context, ...meta() } }),
  };
})();

/* Backend ekibi için sözleşme (Ayarlar ekranında da gösterilir) */
const API_CONTRACT = `GET  /api/health           → { status, mode }
GET  /api/standards        → Standard[]
GET  /api/templates        → { id, name, project, playbook, inventory, owner, lastScore, updatedAt }[]
GET  /api/templates/:id    → { ...template, content: "<yaml>" }
GET  /api/workflows        → { id, name, description, owner, lastScore, nodeCount }[]
GET  /api/workflows/:id    → { ...workflow, nodes: Node[] }

POST /api/analyze/template
  ← { content, rules: string[], customRules?: Standard[], prompt?, templateId?, model?, systemPrompt? }
  → AnalysisResult

POST /api/analyze/workflow
  ← { workflow: { name, nodes: Node[] }, rules, customRules?, prompt?, model?, systemPrompt? }
  → AnalysisResult

POST /api/chat
  ← { messages: {role:"user"|"assistant", content}[], context?: AnalysisResult, model?, systemPrompt? }
  → { reply: "<markdown>" }

AnalysisResult = {
  score: 0-100,
  status: "compliant" | "warning" | "non_compliant",
  summary: string,
  findings: {
    ruleId, severity: "critical"|"high"|"medium"|"low"|"info",
    title, detail, line?, nodeId?, fix?
  }[],
  missing?: string[]
}

Node = { id, name, type: "job"|"approval"|"project_sync"|"inventory_sync"|"notification",
         success?: id[], failure?: id[], always?: id[] }

Standard = { id, scope: "template"|"workflow", category, severity, title, description }`;
