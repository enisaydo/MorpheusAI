/*
 * MorpheusAI - API katmanı
 * Tüm backend çağrıları buradan geçer.
 */
const Settings = (() => {
  const KEY = "morpheus.settings";
  const defaults = { apiBase: "/api", apiKey: "", model: "", userName: "" };
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
    if (s.userName) headers["X-Morpheus-User"] = encodeURIComponent(s.userName); // token raporlarında "kim" bilgisi
    const res = await fetch(s.apiBase.replace(/\/$/, "") + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    // Oturum düştüyse (LDAP açık) giriş ekranını göster
    if (res.status === 401 && data.authRequired && !path.startsWith("/auth/")) window.dispatchEvent(new Event("morpheus:auth-required"));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
    return data;
  }

  const meta = () => {
    const s = Settings.get();
    return { model: s.model || undefined };
  };

  return {
    health: (deep = false) => request(deep ? "/health?deep=1" : "/health"),
    me: () => request("/auth/me"),
    login: (username, password) => request("/auth/login", { method: "POST", body: { username, password } }),
    logout: () => request("/auth/logout", { method: "POST", body: {} }),
    standards: () => request("/standards"),
    templates: () => request("/templates"),
    template: (id) => request(`/templates/${encodeURIComponent(id)}`),
    workflows: () => request("/workflows"),
    workflow: (id) => request(`/workflows/${encodeURIComponent(id)}`),
    logs: (service) => request(`/logs?limit=200${service ? `&service=${service}` : ""}`),
    log: (id) => request(`/logs/${encodeURIComponent(id)}`),
    history: (q = {}) => request(`/history?${new URLSearchParams(Object.entries(q).filter(([, v]) => v))}`),
    historyItem: (id) => request(`/history/${encodeURIComponent(id)}`),
    usage: (q = {}) => request(`/usage?${new URLSearchParams(Object.entries(q).filter(([, v]) => v))}`),
    usageToday: () => request("/usage/today"),
    limits: () => request("/limits"),
    saveLimits: (l) => request("/limits", { method: "POST", body: l }),
    prompts: () => request("/prompts"),
    savePrompts: ({ system, includeStandards }) => request("/prompts", { method: "POST", body: { system, includeStandards } }),

    analyzeTemplate: ({ content, rules, customRules, prompt, templateId, title }) =>
      request("/analyze/template", { method: "POST", body: { content, rules, customRules, prompt, templateId, title, ...meta() } }),

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
POST /api/auth/login        ← { username, password }  → { user }  (LDAP; HttpOnly oturum çerezi)
POST /api/auth/logout
GET  /api/auth/me           → { enabled, user? }  (LDAP açık ve oturum yoksa 401)
GET  /api/prompts           → { system, includeStandards, defaults }
POST /api/prompts           ← { system, includeStandards }   (role: "system" içeriği, sunucuda saklanır)
GET  /api/history?from=&to=&kind=&user=&target=&rule=  → { total, byRule[], byTarget[], records[] }  (analiz geçmişi)
GET  /api/history/:id       → { ...analiz, findings[], timeline[] (aynı hedefin önceki analizleri) }
GET  /api/usage?from=&to=&user=&kind=  → { total, days[], byUser[], byKind[], records[], limits, today }
GET  /api/usage/today       → { date, total, dailyLimit, remaining, user, userTotal, perUserDailyLimit }
GET  /api/limits            → { dailyLimit, perUserDailyLimit }        (0 = sınırsız)
POST /api/limits            ← { dailyLimit, perUserDailyLimit }
     Limit dolunca AI çağrıları 429 döner. Kullanıcı: X-Morpheus-User header'ı (veya .env USER_HEADER)
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
