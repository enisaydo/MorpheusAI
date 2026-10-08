/*
 * Ansible Automation Platform (AAP / AWX / Controller) istemcisi
 *
 *  .env:
 *    AAP_URL=https://aap.kurum.local
 *    AAP_API_PREFIX=                   boş = otomatik (2.5/2.6: /api/controller/v2, 2.4/AWX: /api/v2)
 *    AAP_TOKEN=<OAuth2 / PAT token>    veya  AAP_USERNAME + AAP_PASSWORD
 *    AAP_TLS_INSECURE=true
 *    AAP_ORGANIZATION=<ad>             (opsiyonel filtre)
 *
 *  Not: AAP API'si playbook dosya içeriğini sunmaz (içerik SCM'dedir).
 *  Template analizi, job template TANIMI (envanter, credential, extra_vars, survey,
 *  verbosity, timeout, EE, bildirimler...) üzerinden yapılır.
 */
const { request } = require("./http");
const { bool } = require("./env");

const env = (k, d = "") => process.env[k] ?? d;
const TLS_HINT = "Sertifika doğrulamasını kapatmak için .env'e AAP_TLS_INSECURE=true ekleyin.";

function validUrl(v) {
  if (!v || /[<>]/.test(v)) return false;
  try { return /^https?:$/.test(new URL(v).protocol); } catch { return false; }
}

const isConfigured = () => validUrl(env("AAP_URL")) && Boolean(env("AAP_TOKEN") || env("AAP_USERNAME"));

/* API ön eki: AAP_API_PREFIX verilmişse o; değilse otomatik algılanır
 *   AAP 2.5 / 2.6 (platform gateway) → /api/controller/v2
 *   AAP 2.4 ve öncesi, AWX          → /api/v2                                  */
const PREFIX_CANDIDATES = ["/api/controller/v2", "/api/v2"];
let detectedPrefix = null;
let detecting = null;

const normPrefix = (p) => "/" + p.replace(/^\/+|\/+$/g, "");

async function detectPrefix() {
  for (const p of PREFIX_CANDIDATES) {
    try {
      const res = await request("aap", "detect-api", new URL(`${p}/ping/`, env("AAP_URL")).toString(), {
        headers: { accept: "application/json" },
        insecureTls: bool("AAP_TLS_INSECURE"),
        timeoutMs: 15000,
        tlsHint: TLS_HINT,
      });
      if (res.status === 200 && res.json) return p;
    } catch (e) {
      if (/TLS|sertifika|certificate/i.test(e.message)) throw e; // TLS hatasını gizleme
    }
  }
  throw new Error(
    `AAP API bulunamadı: ${PREFIX_CANDIDATES.map((p) => p + "/ping/").join(" ve ")} yanıt vermedi. ` +
    "AAP_URL'i (ör. https://aap.kurum.local) ve AAP_API_PREFIX'i kontrol edin.");
}

async function prefix() {
  if (env("AAP_API_PREFIX")) return normPrefix(env("AAP_API_PREFIX"));
  if (detectedPrefix) return detectedPrefix;
  detecting ||= detectPrefix().then((p) => (detectedPrefix = p)).finally(() => (detecting = null));
  return detecting;
}

async function base() {
  return new URL((await prefix()) + "/", env("AAP_URL")).toString();
}

function authHeaders() {
  const h = { accept: "application/json" };
  if (env("AAP_TOKEN")) h.authorization = `Bearer ${env("AAP_TOKEN")}`;
  else if (env("AAP_USERNAME"))
    h.authorization = "Basic " + Buffer.from(`${env("AAP_USERNAME")}:${env("AAP_PASSWORD")}`).toString("base64");
  return h;
}

async function get(pathOrUrl, kind) {
  // "next" bağlantıları tam yol ("/api/controller/v2/...?page=2") olarak gelir
  const url = /^https?:/.test(pathOrUrl)
    ? pathOrUrl
    : pathOrUrl.startsWith("/api/") ? new URL(pathOrUrl, env("AAP_URL")).toString() : (await base()) + pathOrUrl.replace(/^\//, "");
  const res = await request("aap", kind, url, {
    headers: authHeaders(),
    insecureTls: bool("AAP_TLS_INSECURE"),
    timeoutMs: Number(env("AAP_TIMEOUT_MS", "30000")),
    tlsHint: TLS_HINT,
  });
  if (res.status === 401) throw new Error("AAP kimlik doğrulaması başarısız (401). AAP_TOKEN veya AAP_USERNAME/AAP_PASSWORD'ü kontrol edin.");
  if (res.status === 404) throw new Error(`AAP'de bulunamadı (404): ${new URL(url).pathname}`);
  if (res.status >= 400) throw new Error(`AAP isteği başarısız (HTTP ${res.status}): ${res.text.slice(0, 300)}`);
  if (!res.json) throw new Error(`AAP JSON dönmedi: ${res.text.slice(0, 200)}`);
  return res.json;
}

/** Sayfalı listeyi sonuna kadar okur (en fazla AAP_MAX_PAGES sayfa). */
async function getAll(path, kind) {
  const out = [];
  let next = path + (path.includes("?") ? "&" : "?") + `page_size=${env("AAP_PAGE_SIZE", "200")}`;
  for (let i = 0; next && i < Number(env("AAP_MAX_PAGES", "20")); i++) {
    const page = await get(next, kind);
    out.push(...(page.results || []));
    next = page.next;
  }
  return out;
}

const orgFilter = () => (env("AAP_ORGANIZATION") ? `&organization__name=${encodeURIComponent(env("AAP_ORGANIZATION"))}` : "");
const sf = (o, k) => o.summary_fields?.[k];
const names = (list) => (list || []).map((x) => x.name);

/* ------------------------------------------------------------------ */
/*  Job templates                                                      */
/* ------------------------------------------------------------------ */

const jtSummary = (t) => ({
  id: String(t.id),
  name: t.name,
  description: t.description || "",
  project: sf(t, "project")?.name || "",
  playbook: t.playbook || "",
  inventory: sf(t, "inventory")?.name || (t.ask_inventory_on_launch ? "(launch'ta sorulur)" : ""),
  owner: sf(t, "organization")?.name || "",
  updatedAt: (t.modified || "").slice(0, 10),
  source: "aap",
});

async function listJobTemplates() {
  const rows = await getAll(`job_templates/?order_by=name${orgFilter()}`, "job_templates");
  return rows.map(jtSummary);
}

async function notificationsOf(kindPath, id, types) {
  const out = {};
  await Promise.all(types.map(async (t) => {
    try { out[t] = names(await getAll(`${kindPath}/${id}/notification_templates_${t}/`, `${kindPath}-notifications`)); }
    catch { out[t] = null; } // yetki yoksa bilinmiyor
  }));
  return out;
}

function maskSurvey(spec) {
  if (!spec?.spec) return spec || null;
  return {
    name: spec.name,
    description: spec.description,
    questions: spec.spec.map((q) => ({
      variable: q.variable, question_name: q.question_name, type: q.type, required: q.required,
      default: q.type === "password" ? (q.default ? "$encrypted$/dolu" : "") : q.default,
      choices: q.choices, min: q.min, max: q.max,
    })),
  };
}

async function getJobTemplate(id) {
  const t = await get(`job_templates/${encodeURIComponent(id)}/`, "job_template");
  const [survey, notifications] = await Promise.all([
    t.survey_enabled ? get(`job_templates/${t.id}/survey_spec/`, "survey_spec").catch(() => null) : null,
    notificationsOf("job_templates", t.id, ["error", "success", "started"]),
  ]);

  const askOnLaunch = Object.fromEntries(Object.entries(t).filter(([k, v]) => k.startsWith("ask_") && v === true));
  const definition = {
    type: "aap_job_template",
    id: t.id,
    name: t.name,
    description: t.description,
    organization: sf(t, "organization")?.name,
    job_type: t.job_type,
    inventory: sf(t, "inventory")?.name ?? null,
    project: sf(t, "project")?.name ?? null,
    scm_branch: t.scm_branch || null,
    playbook: t.playbook,
    execution_environment: sf(t, "execution_environment")?.name ?? null,
    credentials: (sf(t, "credentials") || []).map((c) => ({ name: c.name, kind: c.kind })),
    labels: names(sf(t, "labels")?.results),
    forks: t.forks,
    limit: t.limit,
    verbosity: t.verbosity,
    timeout: t.timeout,
    job_tags: t.job_tags,
    skip_tags: t.skip_tags,
    extra_vars: t.extra_vars,
    become_enabled: t.become_enabled,
    diff_mode: t.diff_mode,
    use_fact_cache: t.use_fact_cache,
    allow_simultaneous: t.allow_simultaneous,
    job_slice_count: t.job_slice_count,
    ask_on_launch: askOnLaunch,
    survey_enabled: t.survey_enabled,
    survey: survey ? maskSurvey(survey) : null,
    webhook_service: t.webhook_service || null,
    notifications,
    created_by: sf(t, "created_by")?.username,
    modified_by: sf(t, "modified_by")?.username,
    modified: t.modified,
  };
  return { ...jtSummary(t), content: JSON.stringify(definition, null, 2), format: "aap-json" };
}

/* ------------------------------------------------------------------ */
/*  Workflow job templates                                             */
/* ------------------------------------------------------------------ */

const NODE_TYPE = {
  job: "job",
  project_update: "project_sync",
  inventory_update: "inventory_sync",
  workflow_approval: "approval",
  workflow_job: "workflow",
  system_job: "job",
};

const wfSummary = (w) => ({
  id: String(w.id),
  name: w.name,
  description: w.description || "",
  owner: sf(w, "organization")?.name || "",
  updatedAt: (w.modified || "").slice(0, 10),
  nodeCount: null,
  source: "aap",
});

async function listWorkflows() {
  const rows = await getAll(`workflow_job_templates/?order_by=name${orgFilter()}`, "workflow_job_templates");
  return rows.map(wfSummary);
}

async function getWorkflow(id) {
  const w = await get(`workflow_job_templates/${encodeURIComponent(id)}/`, "workflow_job_template");
  const [rawNodes, notifications] = await Promise.all([
    getAll(`workflow_job_templates/${w.id}/workflow_nodes/`, "workflow_nodes"),
    notificationsOf("workflow_job_templates", w.id, ["error", "success", "started", "approvals"]),
  ]);
  const nodes = rawNodes.map((n) => {
    const ujt = sf(n, "unified_job_template") || {};
    return {
      id: String(n.id),
      name: ujt.name || n.identifier || `Düğüm ${n.id}`,
      type: NODE_TYPE[ujt.unified_job_type] || "job",
      templateId: n.unified_job_template ?? null,
      success: (n.success_nodes || []).map(String),
      failure: (n.failure_nodes || []).map(String),
      always: (n.always_nodes || []).map(String),
      ...(n.all_parents_must_converge ? { converge: true } : {}),
      ...(n.limit ? { limit: n.limit } : {}),
    };
  });
  return {
    ...wfSummary(w),
    nodeCount: nodes.length,
    nodes,
    notifications,
    settings: {
      organization: sf(w, "organization")?.name,
      inventory: sf(w, "inventory")?.name ?? null,
      limit: w.limit,
      scm_branch: w.scm_branch,
      extra_vars: w.extra_vars,
      survey_enabled: w.survey_enabled,
      allow_simultaneous: w.allow_simultaneous,
      ask_on_launch: Object.fromEntries(Object.entries(w).filter(([k, v]) => k.startsWith("ask_") && v === true)),
      labels: names(sf(w, "labels")?.results),
      webhook_service: w.webhook_service || null,
    },
  };
}

/* ------------------------------------------------------------------ */

async function check() {
  const me = await get("me/", "me");
  const user = me.results?.[0]?.username;
  let version = null;
  try { version = (await get("ping/", "ping")).version; } catch {}
  return { user, version };
}

function status() {
  return {
    configured: isConfigured(),
    host: validUrl(env("AAP_URL")) ? new URL(env("AAP_URL")).host : null,
    apiPrefix: env("AAP_API_PREFIX") ? normPrefix(env("AAP_API_PREFIX")) : detectedPrefix || "(otomatik)",
    auth: env("AAP_TOKEN") ? "token" : env("AAP_USERNAME") ? "basic" : null,
    organization: env("AAP_ORGANIZATION") || null,
  };
}

module.exports = { isConfigured, status, check, listJobTemplates, getJobTemplate, listWorkflows, getWorkflow };
