/*
 * MorpheusAI - API katmanı
 * Tüm backend çağrıları buradan geçer.
 */
const Settings = (() => {
  const KEY = "morpheus.settings";
  const defaults = { apiBase: "/api", apiKey: "", model: "" };
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
    return { model: s.model || undefined };
  };

  return {
    health: (deep = false) => request(deep ? "/health?deep=1" : "/health"),
    standards: () => request("/standards"),
    templates: () => request("/templates"),
    template: (id) => request(`/templates/${encodeURIComponent(id)}`),
    workflows: () => request("/workflows"),
    workflow: (id) => request(`/workflows/${encodeURIComponent(id)}`),
    logs: (service) => request(`/logs?limit=200${service ? `&service=${service}` : ""}`),
    log: (id) => request(`/logs/${encodeURIComponent(id)}`),
    prompts: () => request("/prompts"),
    savePrompts: ({ system, includeStandards }) => request("/prompts", { method: "POST", body: { system, includeStandards } }),

    analyzeTemplate: ({ content, rules, customRules, prompt, templateId }) =>
      request("/analyze/template", { method: "POST", body: { content, rules, customRules, prompt, templateId, ...meta() } }),

    analyzeWorkflow: ({ workflow, workflowId, rules, customRules, prompt }) =>
      request("/analyze/workflow", { method: "POST", body: { workflow, workflowId, rules, customRules, prompt, ...meta() } }),

    chat: ({ messages, context, rules, customRules }) =>
      request("/chat", { method: "POST", body: { messages, context, rules, customRules, ...meta() } }),
  };
})();

const API_CONTRACT = `GET  /api/health[?deep=1]   → { status, mode: "genai"|"proxy"|"demo", catalog: "aap"|"mock", genai?, aap? }
GET  /api/standards         → Standard[]
GET  /api/templates         → { id, name, project, playbook, inventory, owner, lastScore, updatedAt, source }[]
GET  /api/templates/:id     → { ...template, content: "<AAP tanımı JSON | playbook YAML>" }
GET  /api/workflows         → { id, name, description, owner, lastScore, nodeCount, source }[]
GET  /api/workflows/:id     → { ...workflow, nodes: Node[], notifications?, settings? }
GET  /api/prompts           → { system, includeStandards, defaults }
POST /api/prompts           ← { system, includeStandards }   (role: "system" içeriği, sunucuda saklanır)
GET  /api/logs[?service=]   → LogSummary[]          (GenAI / AAP çağrıları, en yeni önce)
GET  /api/logs/:id          → { ...LogSummary, request: {headers, body}, response: {headers, body} }

POST /api/analyze/template  ← { content, rules: string[], customRules?, prompt?, templateId? }   → AnalysisResult
POST /api/analyze/workflow  ← { workflow: {name, nodes}, workflowId?, rules, customRules?, prompt? } → AnalysisResult
POST /api/chat              ← { messages: {role, content}[], context?, rules?, customRules? }  → { reply: "<markdown>" }
     context = AnalysisResult | { kind: "template", name, content } | { kind: "workflow", name, workflow }

AnalysisResult = { score: 0-100, status: "compliant"|"warning"|"non_compliant", summary, engine,
                   findings: { ruleId, severity, title, detail, line?, nodeId?, fix? }[], missing?: string[] }
Node = { id, name, type: "job"|"approval"|"project_sync"|"inventory_sync"|"workflow"|"notification",
         success?: id[], failure?: id[], always?: id[] }`;
