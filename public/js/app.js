/* MorpheusAI - uygulama */
const State = {
  health: null,
  standards: [],
  templates: [],
  workflows: [],
  disabled: new Set(readLS("morpheus.disabledRules", [])),
  customRules: readLS("morpheus.customRules", []),
  runRules: new Set(),
  lastAnalysis: null,
  currentWorkflow: null,
  wfAnalysis: null,
  chat: [],
  chatBusy: false,
  stdScope: "all",
  logService: "",
  logTimer: null,
  detailCache: new Map(),
};

function readLS(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeLS(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

const allRules = () => [...State.standards, ...State.customRules];
const activeRules = (scope) => allRules().filter((r) => (!scope || r.scope === scope) && !State.disabled.has(r.id));

/* ================================================================== */
/*  Router                                                             */
/* ================================================================== */
const ROUTES = ["dashboard", "template", "workflow", "oracle", "history", "remediations", "agent", "standards", "usage", "logs", "settings"];

function route() {
  const [name, arg] = location.hash.replace(/^#\/?/, "").split("/");
  const r = ROUTES.includes(name) ? name : "dashboard";
  $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === r));
  $$(".sidebar a").forEach((a) => a.classList.toggle("active", a.dataset.route === r));
  $("#sidebar").classList.remove("open");
  if (r === "template" && arg) loadTemplate(decodeURIComponent(arg));
  if (r === "workflow" && arg) loadWorkflow(decodeURIComponent(arg));
  if (r === "oracle") setTimeout(() => $("#chatText").focus(), 50);
  if (r === "logs") loadLogs();
  if (r === "usage") loadUsage();
  if (r === "history") loadHistory();
  if (r === "agent") loadAgentPage();
  if (r === "remediations") { loadRemediations(); if (arg) showRemediation(decodeURIComponent(arg)); }
  if (r === "settings") loadLimits();
  setLogAuto(r === "logs" && $("#logAuto").checked);
  window.scrollTo(0, 0);
}

/* ================================================================== */
/*  Detay önbelleği (AAP çağrılarını azaltmak için)                     */
/* ================================================================== */
async function getDetail(kind, id) {
  const key = `${kind}:${id}`;
  if (!State.detailCache.has(key))
    State.detailCache.set(key, (kind === "template" ? Api.template(id) : Api.workflow(id)).catch((e) => {
      State.detailCache.delete(key);
      throw e;
    }));
  return State.detailCache.get(key);
}

/* ================================================================== */
/*  Genel bakış                                                        */
/* ================================================================== */
function renderDashboard() {
  const t = State.templates, w = State.workflows;
  const analyzed = [...t, ...w].filter((x) => x.lastScore != null);
  const avg = analyzed.length ? Math.round(analyzed.reduce((s, x) => s + x.lastScore, 0) / analyzed.length) : null;
  const bad = analyzed.filter((x) => x.lastScore < 60).length;

  const aap = State.health?.catalog === "aap";
  $("#sourceLabel").className = `label ${aap ? "blue" : "gold"}`;
  $("#sourceLabel").textContent = aap ? `Kaynak: AAP · ${State.health.aap.host}` : "Kaynak: örnek (mock) veri";

  $("#kpis").innerHTML = [
    ["Job template", t.length, aap ? "AAP'den" : "örnek veri"],
    ["Workflow", w.length, aap ? "AAP'den" : "örnek veri"],
    ["Ortalama uyum", avg ?? "—", `${analyzed.length} analiz edilmiş kayıt`],
    ["Uyumsuz", bad, "skor < 60"],
  ].map(([l, v, s]) => `<div class="kpi"><div class="k-label">${l}</div><div class="k-val">${v}</div><div class="k-sub">${s}</div></div>`).join("");

  renderTplTable();
  renderWfTable();
}

function renderTplTable() {
  const q = $("#tplFilter").value.toLowerCase();
  const rows = State.templates.filter((x) => !q || `${x.name} ${x.playbook} ${x.inventory} ${x.project}`.toLowerCase().includes(q));
  $("#tplTable").innerHTML =
    `<tr><th>Ad</th><th>Envanter</th><th>Uyum</th></tr>` +
    (rows.map((x) => `<tr class="clickable" data-href="#/template/${encodeURIComponent(x.id)}">
        <td><div class="t-name">${esc(x.name)}</div><div class="t-sub">${esc([x.project, x.playbook].filter(Boolean).join(" · "))}</div></td>
        <td class="t-sub">${esc(x.inventory || "—")}</td><td>${scoreBar(x.lastScore)}</td></tr>`).join("") ||
      `<tr><td colspan="3" class="muted">Kayıt yok</td></tr>`);
}

function renderWfTable() {
  const q = $("#wfFilter").value.toLowerCase();
  const rows = State.workflows.filter((x) => !q || `${x.name} ${x.description}`.toLowerCase().includes(q));
  $("#wfTable").innerHTML =
    `<tr><th>Ad</th><th>Adım</th><th>Uyum</th></tr>` +
    (rows.map((x) => `<tr class="clickable" data-href="#/workflow/${encodeURIComponent(x.id)}">
        <td><div class="t-name">${esc(x.name)}</div><div class="t-sub">${esc(x.description || "")}</div></td>
        <td class="t-sub">${x.nodeCount ?? "—"}</td><td>${scoreBar(x.lastScore)}</td></tr>`).join("") ||
      `<tr><td colspan="3" class="muted">Kayıt yok</td></tr>`);
}

/* ================================================================== */
/*  Template analizi                                                   */
/* ================================================================== */
function syncGutter() {
  const ta = $("#tplInput");
  $("#tplGutter").textContent = Array.from({ length: ta.value.split("\n").length }, (_, i) => i + 1).join("\n");
  $("#tplGutter").scrollTop = ta.scrollTop;
}

function renderRuleChips() {
  const rules = activeRules("template");
  if (!State.runRules.size) rules.forEach((r) => State.runRules.add(r.id));
  $("#tplRules").innerHTML = rules
    .map((r) => `<span class="chip-rule ${State.runRules.has(r.id) ? "on" : ""}" data-rule="${esc(r.id)}" title="${esc(r.title)}">${esc(r.id)}</span>`)
    .join("") || `<span class="muted sm">Aktif kural yok — Standartlar ekranından açın.</span>`;
  $("#tplRuleCount").textContent = `(${rules.filter((r) => State.runRules.has(r.id)).length}/${rules.length})`;
}

/** @returns {Promise<boolean>} yüklendi mi */
async function loadTemplate(id) {
  $("#tplSelect").value = id;
  const ta = $("#tplInput");
  ta.value = "Yükleniyor…";
  let ok = false;
  try {
    const t = await getDetail("template", id);
    ta.value = t.content || "";
    ta.dataset.templateId = id;
    ensureOption("#tplSelect", id, t.name);
    ok = true;
  } catch (e) {
    ta.value = "";
    delete ta.dataset.templateId;
    $("#tplResult").innerHTML = errorView(new Error(`Template #${id} alınamadı: ${e.message}`));
  }
  syncGutter();
  return ok;
}

/** Listede olmayan (ID ile getirilen) kaydı seçim kutusuna ekler. */
function ensureOption(sel, id, name) {
  const s = $(sel);
  if (![...s.options].some((o) => o.value === id)) s.add(new Option(`${name} (#${id})`, id));
  s.value = id;
}

/** AAP'den ID ile (önbelleği atlayarak) getirir ve analiz eder. */
async function fetchByIdAndAnalyze(kind) {
  const input = $(kind === "template" ? "#tplIdInput" : "#wfIdInput");
  const id = input.value.trim().replace(/^#/, "");
  if (!id) return toast(`${kind === "template" ? "Job template" : "Workflow"} ID girin`, true);
  const btn = $(kind === "template" ? "#tplIdGo" : "#wfIdGo");
  btn.disabled = true;
  State.detailCache.delete(`${kind}:${id}`);
  try {
    if (kind === "template") {
      if (await loadTemplate(id)) await analyzeTemplate();
    } else if (await loadWorkflow(id)) {
      await analyzeWorkflow();
    }
  } finally {
    btn.disabled = false;
  }
}

const loadingView = (text) => `<div class="loading"><div class="spinner"></div><div>${esc(text)}</div></div>`;

function errorView(e) {
  return `<div class="alert danger"><b>İşlem başarısız.</b> ${esc(e.message)}</div>
    <p class="muted sm">Ayrıntılar için <a href="#/logs">AI Logları</a> ekranına bakın.</p>`;
}

async function analyzeTemplate() {
  const content = $("#tplInput").value.trim();
  if (!content) return toast("Önce bir template seçin veya içerik yapıştırın", true);
  const btn = $("#tplAnalyze");
  btn.disabled = true;
  $("#tplResult").innerHTML = loadingView("Morpheus template'i analiz ediyor…");
  try {
    const rules = [...State.runRules];
    const templateId = $("#tplInput").dataset.templateId || undefined;
    const title = State.templates.find((t) => t.id === templateId)?.name || $("#tplSelect").selectedOptions[0]?.text || undefined;
    const res = await Api.analyzeTemplate({
      content, rules, templateId, title: templateId ? title : undefined,
      prompt: $("#tplPrompt").value.trim() || undefined,
      customRules: State.customRules.filter((r) => r.scope === "template" && rules.includes(r.id)),
    });
    const shown = templateId ? title : "Yapıştırılan içerik";
    State.lastAnalysis = { kind: "template", title: shown, ...res };
    renderResult($("#tplResult"), res, { kind: "template", title: shown });
    updateScore("templates", templateId, res.score);
  } catch (e) {
    $("#tplResult").innerHTML = errorView(e);
  } finally {
    btn.disabled = false;
    refreshTokenChip();
  }
}

function updateScore(listName, id, score) {
  const item = id && State[listName].find((x) => x.id === id);
  if (item) { item.lastScore = score; renderDashboard(); }
}

const ENGINE_LABEL = {
  genai: "AI analizi",
  "genai-text+heuristic": "AI yanıtı yapılandırılamadı · kural motoru sonucu",
  "demo-heuristic": "Kural motoru (demo)",
};

function renderResult(root, res, { kind, title }) {
  const findings = res.findings || [];
  const counts = SEV_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length]).filter(([, n]) => n);
  const missing = res.missing || [];
  root.classList.remove("hidden");
  renderChatContext();
  root.innerHTML = `
    <div class="result-head">
      ${gauge(res.score ?? 0)}
      <div>
        <span class="label ${res.status === "compliant" ? "green" : res.status === "warning" ? "gold" : "red"}">${STATUS_LABEL[res.status] || esc(res.status)}</span>
        <h2>${esc(title)}</h2>
        <div>${esc(res.summary || "")}</div>
        <div class="engine">${esc(ENGINE_LABEL[res.engine] || res.engine || "")}${res.analyzedAt ? ` · ${esc(fmtTime(res.analyzedAt))} · <a href="#" data-act="history">geçmişte gör</a>` : ""}</div>
      </div>
    </div>
    <div class="sev-summary">${counts.map(([s, n]) => `${sevTag(s)}<span class="sm" style="margin-right:6px">× ${n}</span>`).join("") || `<span class="muted">Bulgu yok</span>`}</div>
    <div class="tabs">
      <button class="on" data-tab="findings">Bulgular (${findings.length})</button>
      ${kind === "template" ? `<button data-tab="missing">Eksikler (${missing.length})</button>` : ""}
      <button data-tab="raw">JSON</button>
    </div>
    <div data-pane="findings">${findings.map((f, i) => findingHtml(f, i, kind)).join("") || `<p class="muted">Standart ihlali bulunamadı.</p>`}</div>
    <div data-pane="missing" class="hidden">${missing.map((m) => `<div class="missing-item">${esc(m)}</div>`).join("") || `<p class="muted">Eksik bölüm yok.</p>`}</div>
    <div data-pane="raw" class="hidden"><pre class="code-block">${esc(JSON.stringify(res, null, 2))}</pre></div>
    <div class="result-actions">
      <button class="btn secondary sm" data-act="ask">Morpheus'a sor</button>
      <button class="btn link sm" data-act="md">Markdown rapor kopyala</button>
      <button class="btn link sm" data-act="json">JSON indir</button>
    </div>`;
  animateGauges(root);

  root.onclick = (ev) => {
    const tab = ev.target.closest("[data-tab]");
    if (tab) {
      $$("[data-tab]", root).forEach((b) => b.classList.toggle("on", b === tab));
      $$("[data-pane]", root).forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== tab.dataset.tab));
    }
    const copy = ev.target.closest("[data-copy]");
    if (copy) copyText(findings[+copy.dataset.copy].fix);
    const ln = ev.target.closest("[data-line]");
    if (ln) gotoLine(+ln.dataset.line);
    const node = ev.target.closest("[data-node]");
    if (node) highlightNode(node.dataset.node);
    const act = ev.target.closest("[data-act]")?.dataset.act;
    if (act === "ask") askAboutAnalysis(title);
    if (act === "md") copyText(markdownReport(res, title));
    if (act === "history") { ev.preventDefault(); showHistory(res.historyId); }
    if (act === "json") download(`morpheus-${kind}-rapor.json`, JSON.stringify(res, null, 2));
  };
}

function findingHtml(f, i, kind) {
  const loc =
    kind === "template" && f.line ? `<span class="link" data-line="${f.line}">satır ${f.line}</span>`
    : f.nodeId ? `<span class="link" data-node="${esc(f.nodeId)}">düğüm ${esc(f.nodeId)}</span>` : "";
  return `<div class="finding ${esc(f.severity)}">
    <div class="finding-top">${sevTag(f.severity)}<span class="finding-title">${esc(f.title)}</span>
      <span class="finding-meta"><span>${esc(f.ruleId || "")}</span>${loc}</span></div>
    ${f.detail ? `<p>${esc(f.detail)}</p>` : ""}
    ${f.fix ? `<div class="fix"><pre>${esc(f.fix)}</pre><button class="btn link sm copy" data-copy="${i}">Kopyala</button></div>` : ""}
  </div>`;
}

function gotoLine(n) {
  const ta = $("#tplInput");
  const lines = ta.value.split("\n");
  const start = lines.slice(0, n - 1).reduce((s, l) => s + l.length + 1, 0);
  ta.focus();
  ta.setSelectionRange(start, start + (lines[n - 1] || "").length);
  ta.scrollTop = Math.max(0, (n - 4) * 20);
  syncGutter();
}

function markdownReport(res, title) {
  return [
    `# MorpheusAI Raporu — ${title}`, ``,
    `**Skor:** ${res.score}/100 · **Durum:** ${STATUS_LABEL[res.status] || res.status}`, ``,
    res.summary || "", ``, `## Bulgular`,
    ...(res.findings || []).map((f) => `- **[${(f.severity || "").toUpperCase()}] ${f.ruleId || ""} ${f.title}** — ${f.detail || ""}${f.line ? ` (satır ${f.line})` : ""}`),
    ...(res.missing?.length ? ["", "## Eksik Bölümler", ...res.missing.map((m) => `- ${m}`)] : []),
  ].join("\n");
}

/* ================================================================== */
/*  Workflow analizi                                                   */
/* ================================================================== */
const NODE_STYLE = {
  job: { fill: "#ffffff", stroke: "#0066cc" },
  approval: { fill: "#fdf7e7", stroke: "#f0ab00" },
  project_sync: { fill: "#f2f0fc", stroke: "#6753ac" },
  inventory_sync: { fill: "#f2f9f9", stroke: "#009596" },
  workflow: { fill: "#f3faf2", stroke: "#3e8635" },
  notification: { fill: "#faeae8", stroke: "#c9190b" },
};
const EDGE_COLOR = { success: "#3e8635", failure: "#c9190b", always: "#0066cc" };

/** @returns {Promise<boolean>} yüklendi mi */
async function loadWorkflow(id) {
  $("#wfSelect").value = id;
  $("#wfCanvas").innerHTML = loadingView("Workflow AAP'den yükleniyor…");
  try {
    const wf = await getDetail("workflow", id);
    setWorkflow(wf);
    ensureOption("#wfSelect", id, wf.name);
    return true;
  } catch (e) {
    State.currentWorkflow = null;
    $("#wfResult").classList.add("hidden");
    $("#wfCanvas").innerHTML = `<div style="padding:16px">${errorView(new Error(`Workflow #${id} alınamadı: ${e.message}`))}</div>`;
    return false;
  }
}

function setWorkflow(wf) {
  State.currentWorkflow = wf;
  State.wfAnalysis = null;
  $("#wfJson").value = JSON.stringify({ name: wf.name, nodes: wf.nodes, notifications: wf.notifications }, null, 2);
  $("#wfResult").classList.add("hidden");
  drawWorkflow(wf);
}

function layoutWorkflow(nodes) {
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const kids = (n) => [...(n.success || []), ...(n.failure || []), ...(n.always || [])].filter((id) => byId[id]);
  const targets = new Set(nodes.flatMap(kids));
  const level = {};
  const roots = nodes.filter((n) => !targets.has(n.id));
  (roots.length ? roots : nodes.slice(0, 1)).forEach((r) => (level[r.id] = 0));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    nodes.forEach((n) => {
      if (level[n.id] === undefined) return;
      kids(n).forEach((k) => {
        if ((level[k] ?? -1) < level[n.id] + 1 && level[n.id] + 1 < nodes.length) { level[k] = level[n.id] + 1; changed = true; }
      });
    });
    if (!changed) break;
  }
  nodes.forEach((n) => (level[n.id] ??= 0));
  const cols = {};
  nodes.forEach((n) => (cols[level[n.id]] ||= []).push(n.id));
  const W = 200, H = 56, GX = 70, GY = 30, P = 28;
  const pos = {};
  const maxRows = Math.max(...Object.values(cols).map((c) => c.length));
  Object.entries(cols).forEach(([lv, ids]) => {
    const offset = ((maxRows - ids.length) * (H + GY)) / 2;
    ids.forEach((id, i) => (pos[id] = { x: P + lv * (W + GX), y: P + offset + i * (H + GY) }));
  });
  return { pos, W, H, byId, width: P * 2 + Object.keys(cols).length * (W + GX) - GX, height: P * 2 + maxRows * (H + GY) - GY };
}

function drawWorkflow(wf) {
  const nodes = wf.nodes || [];
  if (!nodes.length) {
    $("#wfCanvas").innerHTML = `<div class="empty"><p>Workflow'da düğüm yok.</p></div>`;
    return;
  }
  const { pos, W, H, width, height, byId } = layoutWorkflow(nodes);
  const flagged = new Set((State.wfAnalysis?.findings || []).map((f) => f.nodeId).filter(Boolean));

  const edges = [];
  nodes.forEach((n) =>
    ["success", "failure", "always"].forEach((kind) =>
      (n[kind] || []).forEach((to) => {
        if (!byId[to]) return;
        const a = pos[n.id], b = pos[to];
        let d;
        if (b.x > a.x) {
          const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
          d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 6},${y2}`;
        } else {
          const x1 = a.x + W / 2, y1 = a.y, x2 = b.x + W / 2, y2 = b.y, top = Math.min(y1, y2) - 24;
          d = `M${x1},${y1} C${x1},${top} ${x2},${top} ${x2},${y2 - 6}`;
        }
        edges.push(`<path d="${d}" fill="none" stroke="${EDGE_COLOR[kind]}" stroke-width="1.6"
          ${kind === "always" ? 'stroke-dasharray="5 4"' : ""} marker-end="url(#arr-${kind})"/>`);
      })));

  const nodeSvg = nodes.map((n) => {
    const p = pos[n.id], st = NODE_STYLE[n.type] || NODE_STYLE.job, bad = flagged.has(n.id);
    const name = n.name.length > 26 ? n.name.slice(0, 25) + "…" : n.name;
    return `<g class="wf-node" data-id="${esc(n.id)}" transform="translate(${p.x},${p.y})">
      <rect class="box" width="${W}" height="${H}" rx="3" fill="${st.fill}" stroke="${bad ? "#c9190b" : st.stroke}" stroke-width="${bad ? 2.5 : 1.5}"/>
      <rect width="4" height="${H}" rx="1" fill="${st.stroke}"/>
      <text x="14" y="23" fill="#151515" font-size="13" font-weight="500">${esc(name)}</text>
      <text x="14" y="42" fill="#6a6e73" font-size="11">${esc(n.type)} · #${esc(n.id)}</text>
      ${bad ? `<circle cx="${W - 12}" cy="12" r="8" fill="#c9190b"/><text x="${W - 14.5}" y="16" fill="#fff" font-size="11" font-weight="700">!</text>` : ""}
    </g>`;
  }).join("");

  const markers = Object.entries(EDGE_COLOR).map(([k, c]) =>
    `<marker id="arr-${k}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`).join("");
  const h = Math.max(height, 280);
  $("#wfCanvas").innerHTML = `<svg width="${width}" height="${h}" viewBox="0 0 ${width} ${h}"><defs>${markers}</defs>${edges.join("")}${nodeSvg}</svg>`;
}

function highlightNode(id) {
  const g = $(`.wf-node[data-id="${CSS.escape(id)}"]`);
  if (!g) return;
  g.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  g.animate([{ opacity: 1 }, { opacity: 0.25 }, { opacity: 1 }], { duration: 500, iterations: 3 });
}

function showNode(id) {
  const n = State.currentWorkflow?.nodes.find((x) => x.id === id);
  if (!n) return;
  const issues = (State.wfAnalysis?.findings || []).filter((f) => f.nodeId === id);
  const links = (arr) => (arr || []).map((x) => `<code>#${esc(x)}</code>`).join(" ") || "—";
  modal(n.name, `
    <dl class="kv">
      <dt>Tür</dt><dd>${esc(n.type)}</dd>
      <dt>Düğüm</dt><dd>#${esc(n.id)}${n.templateId ? ` · template #${esc(n.templateId)}` : ""}</dd>
      <dt>success →</dt><dd>${links(n.success)}</dd>
      <dt>failure →</dt><dd>${links(n.failure)}</dd>
      <dt>always →</dt><dd>${links(n.always)}</dd>
    </dl>
    ${issues.length ? `<h4>Bulgular</h4>${issues.map((f, i) => findingHtml(f, i, "workflow")).join("")}` : ""}`);
}

async function analyzeWorkflow() {
  const wf = State.currentWorkflow;
  if (!wf) return toast("Önce bir workflow seçin", true);
  const btn = $("#wfAnalyze");
  btn.disabled = true;
  const box = $("#wfResult");
  box.classList.remove("hidden");
  box.innerHTML = loadingView("Morpheus workflow akışını analiz ediyor…");
  try {
    const res = await Api.analyzeWorkflow({
      workflow: { name: wf.name, nodes: wf.nodes, notifications: wf.notifications, settings: wf.settings },
      workflowId: wf.id,
      rules: activeRules("workflow").map((r) => r.id),
      customRules: State.customRules.filter((r) => r.scope === "workflow" && !State.disabled.has(r.id)),
    });
    State.wfAnalysis = res;
    State.lastAnalysis = { kind: "workflow", title: wf.name, ...res };
    renderResult(box, res, { kind: "workflow", title: wf.name });
    drawWorkflow(wf);
    updateScore("workflows", wf.id, res.score);
  } catch (e) {
    box.innerHTML = errorView(e);
  } finally {
    btn.disabled = false;
    refreshTokenChip();
  }
}

/* ================================================================== */
/*  Morpheus'a Sor                                                     */
/* ================================================================== */
const SUGGESTIONS = [
  "Seçili template'i standartlara göre analiz et",
  "Kritik bulguları önceliklendir ve düzeltme öner",
  "Prod workflow standardımızı özetle",
  "extra_vars yerine credential nasıl kullanılır?",
];

function renderChatContext() {
  const sel = $("#chatCtx"), cur = sel.value;
  sel.innerHTML =
    `<option value="">Yok</option>` +
    (State.lastAnalysis ? `<option value="last">Son analiz: ${esc(State.lastAnalysis.title)}</option>` : "") +
    (State.templates.length ? `<optgroup label="Job template">${State.templates.map((t) => `<option value="t:${esc(t.id)}">${esc(t.name)}</option>`).join("")}</optgroup>` : "") +
    (State.workflows.length ? `<optgroup label="Workflow">${State.workflows.map((w) => `<option value="w:${esc(w.id)}">${esc(w.name)}</option>`).join("")}</optgroup>` : "");
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : "";
}

async function chatContext() {
  const v = $("#chatCtx").value;
  if (!v) return undefined;
  if (v === "last") return State.lastAnalysis;
  const [kind, id] = [v.slice(0, 1), v.slice(2)];
  if (kind === "t") {
    const t = await getDetail("template", id);
    return { kind: "template", name: t.name, content: t.content };
  }
  const w = await getDetail("workflow", id);
  return { kind: "workflow", name: w.name, workflow: { name: w.name, nodes: w.nodes, notifications: w.notifications, settings: w.settings } };
}

function renderChat() {
  const log = $("#chatLog");
  log.innerHTML = State.chat
    .map((m) => `<div class="msg ${m.role === "user" ? "user" : "bot"}">
      <div class="avatar">${m.role === "user" ? "Siz" : "M"}</div>
      <div class="bubble ${m.error ? "error" : ""}">${m.pending ? `<div class="typing"><span></span><span></span><span></span></div>` : md(m.content) + traceHtml(m.trace)}</div></div>`)
    .join("");
  log.scrollTop = log.scrollHeight;
}

async function sendChat(text) {
  text = text.trim();
  if (!text || State.chatBusy) return;
  State.chatBusy = true;
  $("#chatSend").disabled = true;
  State.chat.push({ role: "user", content: text });
  const pending = { role: "assistant", content: "", pending: true };
  State.chat.push(pending);
  renderChat();
  try {
    const messages = State.chat.filter((m) => !m.pending && !m.error && !m.welcome).map(({ role, content }) => ({ role, content }));
    const res = await Api.chat({
      messages,
      context: await chatContext(),
      rules: activeRules().map((r) => r.id),
      customRules: State.customRules.filter((r) => !State.disabled.has(r.id)),
    });
    pending.content = res.reply ?? JSON.stringify(res);
    pending.trace = res.trace;
  } catch (e) {
    pending.content = `**Hata:** ${e.message}\n\nAyrıntılar için AI Logları ekranına bakın.`;
    pending.error = true;
  }
  pending.pending = false;
  State.chatBusy = false;
  $("#chatSend").disabled = false;
  renderChat();
  refreshTokenChip();
}

function askAboutAnalysis(title) {
  renderChatContext();
  $("#chatCtx").value = "last";
  location.hash = "#/oracle";
  sendChat(`"${title}" analiz sonucunu yorumla: en kritik bulgular neler ve nasıl düzeltirim?`);
}

function resetChat() {
  State.chat = [{
    role: "assistant", welcome: true,
    content: "Merhaba, ben **Morpheus**. Aşağıdan bir **bağlam** (job template / workflow / son analiz) seçin veya YAML yapıştırın; kurumsal standartlara göre değerlendireyim.",
  }];
  renderChat();
}

/* ================================================================== */
/*  Standartlar                                                        */
/* ================================================================== */
function renderStandards() {
  const q = $("#stdSearch").value.toLowerCase();
  const list = allRules().filter((r) =>
    (State.stdScope === "all" || r.scope === State.stdScope) &&
    (!q || `${r.id} ${r.title} ${r.description} ${r.category}`.toLowerCase().includes(q)));
  const groups = {};
  list.forEach((r) => (groups[`${r.scope === "template" ? "Template" : "Workflow"} · ${r.category}`] ||= []).push(r));
  $("#stdList").innerHTML = Object.entries(groups).map(([g, rules]) => `
    <div class="std-group"><h4>${esc(g)}</h4>
      ${rules.map((r) => `<div class="std-row ${State.disabled.has(r.id) ? "off" : ""}">
        <span class="std-id">${esc(r.id)}${r.custom ? ` <span class="muted sm">(özel)</span>` : ""}</span>
        <div><div class="std-title">${esc(r.title)}</div><div class="std-desc">${esc(r.description)}</div></div>
        ${sevTag(r.severity)}
        <button class="switch ${State.disabled.has(r.id) ? "" : "on"}" data-toggle="${esc(r.id)}" aria-label="Aç/Kapat"></button>
      </div>`).join("")}
    </div>`).join("") || `<div class="empty"><p>Eşleşen kural yok.</p></div>`;
}

function addRuleModal() {
  modal("Yeni kural", `
    <form id="ruleForm" class="form">
      <label>Kural ID <input class="input" name="id" required placeholder="STD-100" /></label>
      <label>Başlık <input class="input" name="title" required /></label>
      <div class="grid-2">
        <label>Kapsam <select class="input" name="scope"><option value="template">Template</option><option value="workflow">Workflow</option></select></label>
        <label>Önem <select class="input" name="severity">${SEV_ORDER.map((s) => `<option value="${s}">${SEV_LABEL[s]}</option>`).join("")}</select></label>
      </div>
      <label>Kategori <input class="input" name="category" placeholder="Operasyon" /></label>
      <label>Açıklama <small>AI'a talimat olarak gönderilir</small><textarea class="input" name="description" rows="3" required></textarea></label>
      <div class="toolbar end"><button class="btn primary" type="submit">Ekle</button></div>
    </form>`);
  $("#ruleForm").onsubmit = (e) => {
    e.preventDefault();
    const r = Object.fromEntries(new FormData(e.target));
    if (allRules().some((x) => x.id === r.id)) return toast("Bu ID zaten var", true);
    State.customRules.push({ ...r, category: r.category || "Özel", custom: true });
    writeLS("morpheus.customRules", State.customRules);
    State.runRules.add(r.id);
    closeModal(); renderStandards(); renderRuleChips();
    toast("Kural eklendi");
  };
}

/* ================================================================== */
/*  AI Logları                                                         */
/* ================================================================== */
async function loadLogs() {
  try {
    const rows = await Api.logs(State.logService);
    $("#logTable").innerHTML =
      `<tr><th>Zaman</th><th>Servis</th><th>Tür</th><th>Uç nokta</th><th>Durum</th><th>Süre</th><th>Token</th></tr>` +
      (rows.map((r) => `<tr class="clickable" data-log="${esc(r.id)}">
        <td class="mono">${esc(fmtTime(r.time))}</td>
        <td><span class="label ${r.service === "genai" ? "blue" : "gold"}">${r.service === "genai" ? "GenAI" : "AAP"}</span></td>
        <td>${esc(r.kind)}</td>
        <td class="t-sub mono">${esc(r.method)} ${esc(r.path)}</td>
        <td class="${r.ok ? "status-ok" : "status-err"}">${r.status ?? "HATA"}</td>
        <td class="mono">${r.durationMs} ms</td>
        <td class="mono">${r.meta?.usage?.total_tokens ?? ""}</td></tr>`).join("") ||
        `<tr><td colspan="7" class="muted">Henüz kayıt yok. Bir analiz veya sohbet başlatın.</td></tr>`);
  } catch (e) {
    $("#logTable").innerHTML = `<tr><td>${errorView(e)}</td></tr>`;
  }
}

function setLogAuto(on) {
  clearInterval(State.logTimer);
  State.logTimer = on ? setInterval(loadLogs, 5000) : null;
}

/** Sohbet mesajlarını okunur biçimde gösterir (chat istekleri için). */
function messagesHtml(body) {
  const msgs = body?.messages;
  if (!Array.isArray(msgs)) return "";
  return msgs.map((m) => `<div class="finding"><div class="finding-top"><span class="label">${esc(m.role)}</span></div>
    <pre class="code-block" style="margin-top:6px">${esc(m.content)}</pre></div>`).join("");
}

async function showLog(id) {
  try {
    const e = await Api.log(id);
    const reply = e.response?.body?.choices?.[0]?.message?.content;
    const pretty = (v) => esc(typeof v === "string" ? v : JSON.stringify(v, null, 2));
    modal(`${e.service === "genai" ? "GenAI" : "AAP"} · ${e.kind}`, `<div class="log-detail">
      <dl class="kv">
        <dt>Zaman</dt><dd>${esc(fmtTime(e.time))}</dd>
        <dt>İstek</dt><dd class="mono">${esc(e.method)} ${esc(e.host)}${esc(e.path)}</dd>
        <dt>Durum</dt><dd class="${e.ok ? "status-ok" : "status-err"}">${e.status ?? "—"} · ${e.durationMs} ms</dd>
        ${e.meta?.usage ? `<dt>Token kullanımı</dt><dd class="mono">${pretty(e.meta.usage)}</dd>` : ""}
        ${e.meta?.finishReason ? `<dt>finish_reason</dt><dd>${esc(e.meta.finishReason)}</dd>` : ""}
        ${e.error ? `<dt>Hata</dt><dd class="status-err">${esc(e.error)}</dd>` : ""}
      </dl>
      <div class="tabs" style="margin-top:14px">
        <button class="on" data-ltab="req">Gönderilen</button>
        <button data-ltab="res">Dönen</button>
        <button data-ltab="hdr">Header'lar</button>
      </div>
      <div data-lpane="req">${messagesHtml(e.request.body) || `<pre class="code-block">${pretty(e.request.body)}</pre>`}</div>
      <div data-lpane="res" class="hidden">
        ${reply != null ? `<h4>Model cevabı</h4><pre class="code-block">${esc(reply)}</pre><h4>Ham yanıt</h4>` : ""}
        <pre class="code-block">${pretty(e.response.body) || "(boş)"}</pre>
      </div>
      <div data-lpane="hdr" class="hidden">
        <h4>İstek header'ları</h4><pre class="code-block">${pretty(e.request.headers)}</pre>
        <h4>Yanıt header'ları</h4><pre class="code-block">${pretty(e.response.headers)}</pre>
      </div>
      <div class="toolbar end"><button class="btn link sm" id="logDownload">JSON indir</button></div>
    </div>`, { wide: true });
    $("#modalBody").onclick = (ev) => {
      const t = ev.target.closest("[data-ltab]");
      if (!t) return;
      $$("[data-ltab]").forEach((b) => b.classList.toggle("on", b === t));
      $$("[data-lpane]").forEach((p) => p.classList.toggle("hidden", p.dataset.lpane !== t.dataset.ltab));
    };
    $("#logDownload").onclick = () => download(`morpheus-log-${e.id}.json`, JSON.stringify(e, null, 2));
  } catch (err) {
    toast(err.message, true);
  }
}

/* ================================================================== */
/*  Analiz geçmişi                                                     */
/* ================================================================== */
const TARGET_KIND = { template: "Template", workflow: "Workflow" };

function setHistRange(days) {
  const to = new Date(), from = new Date();
  from.setDate(to.getDate() - (days - 1));
  $("#histFrom").value = isoDay(from);
  $("#histTo").value = isoDay(to);
  $$("#histRange button").forEach((b) => b.classList.toggle("on", Number(b.dataset.days) === days));
}

async function loadHistory() {
  if (!$("#histFrom").value) setHistRange(30);
  try {
    const r = await Api.history({
      from: $("#histFrom").value, to: $("#histTo").value, kind: $("#histKind").value,
      user: $("#histUser").value, target: $("#histTarget").value.trim(), rule: State.histRule,
    });
    State.history = r;
    renderHistory(r);
  } catch (e) {
    $("#histKpis").innerHTML = errorView(e);
  }
}

const changeText = (c) =>
  c > 0 ? `<span class="status-ok">▲ +${c}</span>` : c < 0 ? `<span class="status-err">▼ ${c}</span>` : `<span class="muted">—</span>`;

function renderHistory(r) {
  const us = $("#histUser"), cur = us.value;
  us.innerHTML = `<option value="">Tüm kullanıcılar</option>` + r.users.map((u) => `<option>${esc(u)}</option>`).join("");
  us.value = r.users.includes(cur) ? cur : "";
  $("#histRuleFilter").innerHTML = State.histRule
    ? `<span class="label blue">Kural: ${esc(State.histRule)} <a href="#" id="histRuleClear" title="Filtreyi kaldır">✕</a></span>` : "";

  const top = r.byRule[0];
  $("#histKpis").innerHTML = [
    ["Analiz sayısı", fmtNum(r.total.analyses), `${r.total.targets} farklı template/workflow`],
    ["Ortalama skor", r.total.avgScore ?? "—", "seçili dönemde"],
    ["Uyumsuz analiz", fmtNum(r.total.nonCompliant), "skor < 60"],
    ["En sık ihlal", top ? esc(top.ruleId) : "—", top ? `${top.analyses} analizde · ${esc(top.title || "")}` : "ihlal yok"],
  ].map(([l, v, s]) => `<div class="kpi"><div class="k-label">${l}</div><div class="k-val">${v}</div><div class="k-sub">${s}</div></div>`).join("");

  const maxR = Math.max(1, ...r.byRule.map((x) => x.analyses));
  $("#histRules").innerHTML = r.byRule.slice(0, 12).map((x) => `
    <div class="hbar clickable-row" data-rule="${esc(x.ruleId)}" title="${esc(x.ruleId)} — ${esc(x.title || "")}: ${x.analyses} analizde, toplam ${x.findings} bulgu. Filtrelemek için tıklayın.">
      <span class="name">${sevTag(x.severity)} <span class="mono">${esc(x.ruleId)}</span></span>
      <div class="track"><div class="fill" style="width:${(x.analyses / maxR) * 100}%"></div></div>
      <span class="val">${fmtNum(x.analyses)}</span>
    </div>`).join("") || `<p class="muted">Bu dönemde ihlal yok.</p>`;

  $("#histTargets").innerHTML = `<tr><th>Hedef</th><th class="num">Analiz</th><th>Son skor</th><th class="num">Değişim</th><th>Son analiz</th></tr>` +
    (r.byTarget.slice(0, 30).map((t) => `<tr class="clickable" data-target="${esc(t.targetId || t.targetName)}">
      <td><div class="t-name">${esc(t.targetName)}</div><div class="t-sub">${TARGET_KIND[t.kind]}${t.targetId ? ` · #${esc(t.targetId)}` : ""}</div></td>
      <td class="num">${t.count}</td><td>${scoreBar(t.last)}</td><td class="num">${t.count > 1 ? changeText(t.change) : "—"}</td>
      <td class="mono sm">${esc(fmtTime(t.lastTime))}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">—</td></tr>`);

  $("#histCount").textContent = `${r.records.length}${r.records.length >= 500 ? "+ (en yeni 500)" : ""} analiz`;
  $("#histTable").innerHTML =
    `<tr><th>Zaman</th><th>Kullanıcı</th><th>Hedef</th><th>Skor</th><th>Durum</th><th>Bulgular</th><th>İhlal edilen kurallar</th></tr>` +
    (r.records.map((x) => `<tr class="clickable" data-hist="${esc(x.id)}">
      <td class="mono">${esc(fmtTime(x.time))}</td><td>${esc(x.user)}</td>
      <td><div class="t-name">${esc(x.targetName)}</div><div class="t-sub">${TARGET_KIND[x.kind]}${x.targetId ? ` · #${esc(x.targetId)}` : ""}</div></td>
      <td>${scoreBar(x.score)}</td>
      <td>${statusLabel(x.status)}</td>
      <td><div class="sev-counts">${SEV_ORDER.filter((s) => x.counts?.[s]).map((s) => `<span class="sev-count">${sevTag(s)}<b>${x.counts[s]}</b></span>`).join("") || `<span class="muted">yok</span>`}</div></td>
      <td class="q-cell mono sm" title="${esc(x.failedRules.join(", "))}">${esc(x.failedRules.join(", ")) || "—"}</td></tr>`).join("") ||
      `<tr><td colspan="7" class="muted">Bu dönemde analiz yok.</td></tr>`);
}

const statusLabel = (s) =>
  `<span class="label ${s === "compliant" ? "green" : s === "warning" ? "gold" : "red"}">${STATUS_LABEL[s] || esc(s || "—")}</span>`;

async function showHistory(id) {
  try {
    const h = await Api.historyItem(id);
    const link = h.targetId ? `#/${h.kind}/${encodeURIComponent(h.targetId)}` : null;
    modal(`${TARGET_KIND[h.kind]} analizi · ${h.targetName}`, `
      <div class="result-head">
        ${gauge(h.score ?? 0)}
        <div>
          ${statusLabel(h.status)}
          <h2>${esc(h.targetName)}</h2>
          <div>${esc(h.summary || "")}</div>
          <div class="engine">${esc(ENGINE_LABEL[h.engine] || h.engine || "")}</div>
        </div>
      </div>
      <dl class="kv">
        <dt>Analiz zamanı</dt><dd>${esc(fmtTime(h.time))}</dd>
        <dt>Kullanıcı</dt><dd>${esc(h.user)}</dd>
        <dt>Hedef</dt><dd>${TARGET_KIND[h.kind]}${h.targetId ? ` · #${esc(h.targetId)}` : ` · içerik özeti ${esc(h.contentHash || "")}`}</dd>
        <dt>Uygulanan kurallar</dt><dd>${h.rules?.length ? `${h.rules.length} kural` : "tümü"}</dd>
        ${h.prompt ? `<dt>Ek talimat</dt><dd>${esc(h.prompt)}</dd>` : ""}
      </dl>
      <h4>Bulgular (${h.findings.length})</h4>
      ${h.findings.map((f, i) => findingHtml(f, i, "history")).join("") || `<p class="muted">Standart ihlali bulunmadı.</p>`}
      ${h.missing?.length ? `<h4>Eksikler</h4>${h.missing.map((m) => `<div class="missing-item">${esc(m)}</div>`).join("")}` : ""}
      ${h.timeline.length > 1 ? `<h4>Bu hedefin analiz geçmişi</h4>
        <div class="table-wrap"><table class="table">
          <tr><th>Zaman</th><th>Kullanıcı</th><th>Skor</th><th>İhlal edilen kurallar</th></tr>
          ${h.timeline.map((t) => `<tr class="${t.id === h.id ? "current" : "clickable"}" ${t.id === h.id ? "" : `data-hist="${esc(t.id)}"`}>
            <td class="mono">${esc(fmtTime(t.time))}${t.id === h.id ? " <span class='label blue'>bu analiz</span>" : ""}</td>
            <td>${esc(t.user)}</td><td>${scoreBar(t.score)}</td><td class="mono sm">${esc(t.failedRules.join(", ")) || "—"}</td></tr>`).join("")}
        </table></div>` : ""}
      <div class="toolbar end" style="margin-top:12px">
        <button class="btn link sm" id="histJson">JSON indir</button>
        ${link ? `<a class="btn primary sm" href="${link}" id="histReanalyze">Yeniden analiz et</a>` : ""}
      </div>`, { wide: true });
    $("#histJson").onclick = () => download(`morpheus-analiz-${h.id}.json`, JSON.stringify(h, null, 2));
    if (link) $("#histReanalyze").onclick = () => closeModal();
    $("#modalBody").onclick = (e) => {
      const tr = e.target.closest("[data-hist]");
      if (tr) showHistory(tr.dataset.hist);
    };
  } catch (e) {
    toast(e.message, true);
  }
}

function historyCsv() {
  const r = State.history;
  if (!r) return;
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["zaman", "kullanici", "tur", "hedef_id", "hedef", "skor", "durum", "kritik", "yuksek", "orta", "dusuk", "bilgi", "ihlal_edilen_kurallar", "motor"].join(";"),
    ...r.records.map((x) => [x.time, x.user, x.kind, x.targetId, x.targetName, x.score, x.status,
      x.counts.critical, x.counts.high, x.counts.medium, x.counts.low, x.counts.info, x.failedRules.join(" "), x.engine].map(q).join(";"))];
  download(`morpheus-analiz-gecmisi-${r.from}_${r.to}.csv`, "﻿" + lines.join("\n"), "text/csv;charset=utf-8");
}

/* ================================================================== */
/*  Token kullanımı                                                    */
/* ================================================================== */
const KIND_LABEL = { chat: "Sohbet", "analyze-template": "Template analizi", "analyze-workflow": "Workflow analizi" };
const fmtNum = (n) => Number(n || 0).toLocaleString("tr-TR");
const fmtK = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));
const isoDay = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

function setUsageRange(days) {
  const to = new Date(), from = new Date();
  from.setDate(to.getDate() - (days - 1));
  $("#usageFrom").value = isoDay(from);
  $("#usageTo").value = isoDay(to);
  $$("#usageRange button").forEach((b) => b.classList.toggle("on", Number(b.dataset.days) === days));
}

async function refreshTokenChip() {
  try {
    const t = await Api.usageToday();
    const chip = $("#tokenChip");
    const limit = t.dailyLimit;
    $("span", chip).textContent = limit ? `Token: ${fmtK(t.total)} / ${fmtK(limit)}` : `Token: ${fmtK(t.total)} bugün`;
    chip.classList.toggle("over", Boolean(limit && t.total >= limit));
    chip.title = `Bugün ${fmtNum(t.total)} token, ${t.requests} istek` + (limit ? ` · limit ${fmtNum(limit)}` : " · limit yok") +
      (t.perUserDailyLimit ? ` · sizin: ${fmtNum(t.userTotal)} / ${fmtNum(t.perUserDailyLimit)}` : "");
  } catch {}
}

async function loadUsage() {
  if (!$("#usageFrom").value) setUsageRange(7);
  try {
    const r = await Api.usage({
      from: $("#usageFrom").value, to: $("#usageTo").value,
      user: $("#usageUser").value, kind: $("#usageKind").value,
    });
    State.usage = r;
    renderUsage(r);
  } catch (e) {
    $("#usageKpis").innerHTML = errorView(e);
  }
}

function renderUsage(r) {
  // kullanıcı filtresi seçenekleri (seçimi koru)
  const us = $("#usageUser"), cur = us.value;
  us.innerHTML = `<option value="">Tüm kullanıcılar</option>` + r.users.map((u) => `<option>${esc(u)}</option>`).join("");
  us.value = r.users.includes(cur) ? cur : "";

  const t = r.today, limit = t.dailyLimit;
  const pct = limit ? Math.min(100, Math.round((t.total / limit) * 100)) : 0;
  const days = r.days.filter((d) => d.totalTokens > 0).length;
  $("#usageKpis").innerHTML = [
    `<div class="kpi"><div class="k-label">Bugün kullanılan</div><div class="k-val">${fmtNum(t.total)}</div>
      <div class="k-sub">${limit ? `limit ${fmtNum(limit)} · kalan ${fmtNum(t.remaining)}` : "günlük limit yok"}</div>
      ${limit ? `<div class="progress"><i class="${pct >= 100 ? "over" : pct >= 80 ? "warn" : ""}" style="width:${pct}%"></i></div>` : ""}</div>`,
    `<div class="kpi"><div class="k-label">Seçili dönem toplamı</div><div class="k-val">${fmtNum(r.total.totalTokens)}</div>
      <div class="k-sub">${fmtNum(r.total.promptTokens)} girdi · ${fmtNum(r.total.completionTokens)} çıktı</div></div>`,
    `<div class="kpi"><div class="k-label">İstek sayısı</div><div class="k-val">${fmtNum(r.total.requests)}</div>
      <div class="k-sub">${r.total.errors ? `${r.total.errors} hatalı` : "hata yok"}</div></div>`,
    `<div class="kpi"><div class="k-label">Günlük ortalama</div><div class="k-val">${fmtNum(days ? Math.round(r.total.totalTokens / days) : 0)}</div>
      <div class="k-sub">kullanım olan ${days} gün</div></div>`,
  ].join("");
  $("#usageTz").textContent = `Saat dilimi: ${r.timezone}`;

  renderUsageChart(r.days, r.limits.dailyLimit);

  const maxU = Math.max(1, ...r.byUser.map((u) => u.totalTokens));
  $("#usageByUser").innerHTML = r.byUser.map((u) => `
    <div class="hbar" title="${esc(u.key)}: ${fmtNum(u.totalTokens)} token, ${u.requests} istek">
      <span class="name">${esc(u.key)}</span>
      <div class="track"><div class="fill" style="width:${(u.totalTokens / maxU) * 100}%"></div></div>
      <span class="val">${fmtNum(u.totalTokens)}</span>
    </div>`).join("") || `<p class="muted">Bu dönemde kullanım yok.</p>`;

  $("#usageByKind").innerHTML = `<tr><th>Tür</th><th class="num">İstek</th><th class="num">Girdi</th><th class="num">Çıktı</th><th class="num">Toplam</th></tr>` +
    (r.byKind.map((k) => `<tr><td>${esc(KIND_LABEL[k.key] || k.key)}</td><td class="num">${fmtNum(k.requests)}</td>
      <td class="num">${fmtNum(k.promptTokens)}</td><td class="num">${fmtNum(k.completionTokens)}</td><td class="num"><b>${fmtNum(k.totalTokens)}</b></td></tr>`).join("") ||
      `<tr><td colspan="5" class="muted">—</td></tr>`);

  $("#usageCount").textContent = `${r.records.length}${r.records.length >= 500 ? "+ (en yeni 500)" : ""} kayıt`;
  $("#usageTable").innerHTML =
    `<tr><th>Zaman</th><th>Kullanıcı</th><th>Tür</th><th>Sorgu</th><th class="num">Girdi</th><th class="num">Çıktı</th><th class="num">Toplam</th><th>Durum</th></tr>` +
    (r.records.map((x, i) => `<tr class="clickable" data-usage="${i}">
      <td class="mono">${esc(fmtTime(x.time))}</td><td>${esc(x.user)}</td><td>${esc(KIND_LABEL[x.kind] || x.kind)}</td>
      <td class="q-cell" title="${esc(x.question)}">${esc(x.question)}</td>
      <td class="num">${fmtNum(x.promptTokens)}</td><td class="num">${fmtNum(x.completionTokens)}</td>
      <td class="num"><b>${fmtNum(x.totalTokens)}</b>${x.estimated ? ` <span class="muted sm" title="Gateway kullanım bilgisi döndürmedi; tahmini">≈</span>` : ""}</td>
      <td class="${x.ok ? "status-ok" : "status-err"}">${x.ok ? "Başarılı" : "Hata"}</td></tr>`).join("") ||
      `<tr><td colspan="8" class="muted">Bu dönemde sorgu yok.</td></tr>`);
}

/** Günlük kullanım: tek seri dikey çubuk + limit referans çizgisi + çubuk başına hover ipucu */
function renderUsageChart(days, limit) {
  const el = $("#usageChart");
  const W = 640, H = 240, L = 48, R = 12, T = 16, B = 28;
  const max = Math.max(1000, limit || 0, ...days.map((d) => d.totalTokens)) * 1.1;
  const step = Math.pow(10, Math.floor(Math.log10(max / 4)));
  const tick = [1, 2, 2.5, 5, 10].map((m) => m * step).find((s) => max / s <= 5) || step * 10;
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const n = days.length, cw = (W - L - R) / n, bw = Math.max(2, Math.min(36, cw - 2));
  const labelEvery = Math.ceil(n / 10);

  const gridLines = [], yLabels = [];
  for (let v = 0; v <= max; v += tick) {
    gridLines.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`);
    yLabels.push(`<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmtK(v)}</text>`);
  }

  const xLabels = [], cols = [];
  days.forEach((d, i) => {
    const x = L + i * cw + (cw - bw) / 2, top = y(d.totalTokens), r = Math.min(4, bw / 2, y(0) - top);
    // üst köşeleri 4px yuvarlatılmış, tabana oturan çubuk; isabet alanı tüm sütun
    const bar = d.totalTokens > 0
      ? `<path class="bar" d="M${x},${y(0)} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${y(0)} Z"/>`
      : "";
    cols.push(`<g class="col" data-i="${i}"><rect class="hit" x="${L + i * cw}" y="${T}" width="${cw}" height="${H - T - B}"/>${bar}</g>`);
    if (i % labelEvery === 0)
      xLabels.push(`<text x="${L + i * cw + cw / 2}" y="${H - 8}" text-anchor="middle">${d.date.slice(8, 10)}.${d.date.slice(5, 7)}</text>`);
  });

  const limitLine = limit
    ? `<line class="limit" x1="${L}" x2="${W - R}" y1="${y(limit)}" y2="${y(limit)}"/>
       <text class="limit-label" x="${W - R}" y="${y(limit) - 5}" text-anchor="end">Günlük limit ${fmtK(limit)}</text>`
    : "";

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Günlük token kullanımı">
      <g class="grid">${gridLines.join("")}</g>
      <g class="axis">${yLabels.join("")}${xLabels.join("")}</g>
      ${cols.join("")}
      ${limitLine}
    </svg><div class="tip hidden"></div>`;

  const tip = $(".tip", el);
  el.onmousemove = (e) => {
    const g = e.target.closest(".col");
    if (!g) return tip.classList.add("hidden");
    const d = days[+g.dataset.i];
    const box = el.getBoundingClientRect(), rect = g.querySelector(".hit").getBoundingClientRect();
    tip.innerHTML = `<b>${d.date.split("-").reverse().join(".")}</b><br>${fmtNum(d.totalTokens)} token · ${d.requests} istek`;
    tip.style.left = `${rect.left - box.left + rect.width / 2}px`;
    tip.style.top = `${Math.max(12, (g.querySelector(".bar")?.getBoundingClientRect().top ?? rect.bottom) - box.top)}px`;
    tip.classList.remove("hidden");
  };
  el.onmouseleave = () => tip.classList.add("hidden");
}

function showUsageRecord(i) {
  const x = State.usage?.records[i];
  if (!x) return;
  modal(KIND_LABEL[x.kind] || x.kind, `
    <dl class="kv">
      <dt>Zaman</dt><dd>${esc(fmtTime(x.time))}</dd>
      <dt>Kullanıcı</dt><dd>${esc(x.user)}${x.ip ? ` <span class="muted sm">(${esc(x.ip)})</span>` : ""}</dd>
      <dt>Model</dt><dd>${esc(x.model || "—")}</dd>
      <dt>Token</dt><dd>${fmtNum(x.promptTokens)} girdi · ${fmtNum(x.completionTokens)} çıktı · <b>${fmtNum(x.totalTokens)}</b> toplam${x.estimated ? " (tahmini)" : ""}</dd>
      <dt>Durum</dt><dd class="${x.ok ? "status-ok" : "status-err"}">${x.ok ? "Başarılı" : esc(x.error || "Hata")}</dd>
    </dl>
    <h4>Sorgu</h4><pre class="code-block">${esc(x.question)}</pre>
    ${x.logId ? `<div class="toolbar end"><button class="btn link sm" id="openLog">İstek/cevap logunu aç</button></div>` : ""}`);
  if (x.logId) $("#openLog").onclick = () => showLog(x.logId);
}

function usageCsv() {
  const r = State.usage;
  if (!r) return;
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["zaman", "kullanici", "ip", "tur", "sorgu", "model", "girdi_token", "cikti_token", "toplam_token", "tahmini", "durum"].join(";"),
    ...r.records.map((x) => [x.time, x.user, x.ip, x.kind, x.question, x.model, x.promptTokens, x.completionTokens, x.totalTokens, x.estimated, x.ok ? "ok" : x.error].map(q).join(";"))];
  download(`morpheus-token-${r.from}_${r.to}.csv`, "﻿" + lines.join("\n"), "text/csv;charset=utf-8");
}

/* ---- Limitler ---- */
async function loadLimits() {
  try {
    const l = await Api.limits();
    const f = $("#limitForm");
    f.elements.dailyLimit.value = l.dailyLimit || 0;
    f.elements.perUserDailyLimit.value = l.perUserDailyLimit || 0;
    $("#limitInfo").textContent = l.updatedAt ? `Son değişiklik: ${fmtTime(l.updatedAt)}${l.updatedBy ? ` · ${l.updatedBy}` : ""}` : "";
  } catch (e) { $("#limitInfo").textContent = e.message; }
}

/* ---- LDAP giriş ---- */
let loginWaiters = [];
function showLogin() {
  $("#loginScreen").classList.remove("hidden");
  setTimeout(() => $("#loginForm").elements.username.focus(), 30);
  return new Promise((resolve) => loginWaiters.push(resolve));
}

async function submitLogin(e) {
  e.preventDefault();
  const f = e.target, err = $("#loginError"), btn = $("#loginBtn");
  err.classList.add("hidden");
  btn.disabled = true;
  btn.textContent = "Doğrulanıyor…";
  try {
    const r = await Api.login(f.elements.username.value.trim(), f.elements.password.value);
    State.auth = { enabled: true, user: r.user };
    f.elements.password.value = "";
    $("#loginScreen").classList.add("hidden");
    loginWaiters.forEach((w) => w(r.user));
    loginWaiters = [];
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove("hidden");
    f.elements.password.select();
  } finally {
    btn.disabled = false;
    btn.textContent = "Giriş yap";
  }
}

function applyAuthUi() {
  const a = State.auth || {};
  $("#userNameField").classList.toggle("hidden", Boolean(a.enabled));
  const readOnly = a.enabled && a.user && !a.user.isAdmin;
  ["#limitForm", "#promptForm"].forEach((id) => {
    const f = $(id);
    f.classList.toggle("form-disabled", Boolean(readOnly));
    f.title = readOnly ? "Bu ayarları yalnızca yöneticiler değiştirebilir" : "";
  });
  renderUserChip();
}

/* ---- Kullanıcı adı / oturum ---- */
function renderUserChip() {
  const a = State.auth;
  $("span", $("#userChip")).textContent = a?.enabled
    ? `${a.user?.displayName || a.user?.username || "Oturum yok"}${a.user?.isAdmin ? " · yönetici" : ""}`
    : Settings.get().userName || "Kullanıcı adı girin";
}

function userMenu() {
  const a = State.auth;
  if (!a?.enabled) return askUserName(true);
  modal("Oturum", `
    <dl class="kv">
      <dt>Ad</dt><dd>${esc(a.user?.displayName || "—")}</dd>
      <dt>Kullanıcı adı</dt><dd class="mono">${esc(a.user?.username || "—")}</dd>
      <dt>Yetki</dt><dd>${a.user?.isAdmin ? "Yönetici" : "Kullanıcı"}</dd>
    </dl>
    <div class="toolbar end"><button class="btn primary" id="logoutBtn">Çıkış yap</button></div>`);
  $("#logoutBtn").onclick = async () => {
    try { await Api.logout(); } catch {}
    location.reload();
  };
}

function askUserName(force = false) {
  if (State.auth?.enabled) return; // LDAP açıkken kullanıcı adı oturumdan gelir
  if (Settings.get().userName && !force) return;
  modal("Kullanıcı adınız", `
    <form id="userForm" class="form">
      <label>Ad / sicil
        <input class="input" name="userName" required maxlength="80" value="${esc(Settings.get().userName)}" placeholder="ör. EnisA" />
        <small>Token kullanım raporlarında "kim kullandı" olarak görünür. Bu tarayıcıda saklanır.</small>
      </label>
      <div class="toolbar end"><button class="btn primary" type="submit">Kaydet</button></div>
    </form>`);
  $("#userForm").onsubmit = (e) => {
    e.preventDefault();
    Settings.save({ userName: e.target.elements.userName.value.trim() });
    $("#settingsForm").elements.userName.value = Settings.get().userName;
    renderUserChip();
    closeModal();
    refreshTokenChip();
  };
  setTimeout(() => $("#userForm input").focus(), 30);
}

/* ================================================================== */
/*  Bağlantı durumu & ayarlar                                          */
/* ================================================================== */
function setChip(el, cls, text, title) {
  el.className = `chip ${cls}`;
  $("span", el).textContent = text;
  el.title = title;
}

function renderStatus(h) {
  const g = h.genai, a = h.aap;
  const aiCls = h.mode === "demo" ? "warn" : g?.tokenCheck === "failed" ? "err" : "ok";
  setChip($("#aiChip"), aiCls, h.mode === "demo" ? "AI · demo" : "AI", h.mode === "genai" ? `GenAI: ${g?.chatHost}` : h.mode);
  const aapCls = h.catalog !== "aap" ? "warn" : a?.check === "failed" ? "err" : "ok";
  setChip($("#aapChip"), aapCls, h.catalog === "aap" ? "AAP" : "AAP · mock", h.catalog === "aap" ? a.host : "AAP_URL tanımlı değil");

  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  const ok = (s) => `<span class="status-ok">${s}</span>`, bad = (s) => `<span class="status-err">${s}</span>`;
  $("#genaiStatus").innerHTML = h.mode !== "genai"
    ? `<div class="alert info">GenAI bağlı değil (<b>${esc(h.mode)}</b> modu). <code>.env</code>'de <code>TMS_TOKEN_URL</code> ve <code>CHAT_URL</code> tanımlayın.</div>`
    : `<dl class="kv">
        ${row("Token servisi", `<span class="mono">${esc(g.tokenHost)}</span>`)}
        ${row("Chat servisi", `<span class="mono">${esc(g.chatHost)}</span>`)}
        ${row("Token", g.tokenCheck === "failed" ? bad("alınamadı") : g.tokenCached ? ok(`geçerli · ${g.tokenExpiresIn} sn`) : "henüz alınmadı")}
      </dl>${g.error ? `<div class="alert danger" style="margin-top:10px">${esc(g.error)}</div>` : ""}`;
  $("#aapStatus").innerHTML = h.catalog !== "aap"
    ? `<div class="alert info">AAP bağlı değil; örnek veri gösteriliyor. <code>.env</code>'de <code>AAP_URL</code> ve <code>AAP_TOKEN</code> (veya kullanıcı/parola) tanımlayın.</div>`
    : `<dl class="kv">
        ${row("Adres", `<span class="mono">${esc(a.host)}${esc(a.apiPrefix)}</span>`)}
        ${row("Kimlik doğrulama", esc(a.auth))}
        ${a.organization ? row("Organizasyon", esc(a.organization)) : ""}
        ${row("Durum", a.check === "ok" ? ok(`bağlı · ${esc(a.user || "")}${a.version ? ` · v${esc(a.version)}` : ""}`) : a.check === "failed" ? bad("bağlanılamadı") : "test edilmedi")}
      </dl>${a.error ? `<div class="alert danger" style="margin-top:10px">${esc(a.error)}</div>` : ""}`;
}

async function checkHealth(deep = false) {
  try {
    const h = await Api.health(deep);
    State.health = h;
    renderStatus(h);
    if (deep) toast(h.status === "ok" ? "Bağlantılar başarılı" : "Bazı bağlantılar başarısız — ayrıntılar Ayarlar'da", h.status !== "ok");
  } catch (e) {
    setChip($("#aiChip"), "err", "AI", e.message);
    setChip($("#aapChip"), "err", "AAP", e.message);
    if (deep) toast(`Sunucuya ulaşılamadı: ${e.message}`, true);
  }
}

function fillSettings() {
  const s = Settings.get(), f = $("#settingsForm");
  ["apiBase", "model", "userName"].forEach((k) => (f.elements[k].value = s[k] || ""));
  $("#contract").textContent = API_CONTRACT;
}

/* ---- Sistem mesajı (role: system) ---- */
async function loadPrompts() {
  try {
    const p = await Api.prompts();
    State.prompts = p;
    const f = $("#promptForm");
    f.elements.system.value = p.system;
    f.elements.includeStandards.checked = p.includeStandards !== false;
    $("#promptInfo").textContent = p.updatedAt ? `Son kayıt: ${fmtTime(p.updatedAt)}` : "Varsayılan metin";
  } catch (e) {
    $("#promptInfo").textContent = `Yüklenemedi: ${e.message}`;
  }
}

function previewRequest() {
  const f = $("#promptForm");
  const standards = activeRules().map((r) => `- ${r.id} [${r.scope}/${r.severity}] ${r.title}: ${r.description}`).join("\n");
  const system = [f.elements.system.value, f.elements.includeStandards.checked && standards ? `## Kurumsal standartlar\n${standards}` : ""]
    .filter(Boolean).join("\n\n");
  const body = {
    messages: [
      { role: "system", content: system },
      { role: "user", content: "<Morpheus'a Sor ekranında yazdığınız mesaj>" },
    ],
  };
  modal("Gönderilecek chat/completions gövdesi (örnek)", `
    <p class="muted sm">Model alanı (<code>model_name</code>) ve <code>max_completion_tokens</code> sunucudaki <code>.env</code>'den eklenir.
    Sohbette bağlam seçilirse seçilen template/workflow system mesajının sonuna eklenir; önceki mesajlar da sırayla gönderilir.</p>
    <pre class="code-block">${esc(JSON.stringify(body, null, 2))}</pre>`, { wide: true });
}

/* ================================================================== */
/*  Olaylar & başlatma                                                 */
/* ================================================================== */
/* ================================================================== */
/*  Düzeltmeler (UnixAI OS bulguları → playbook → AAP)                  */
/* ================================================================== */
const REM_STATUS = {
  generated: ["Onay bekliyor", "gold"], approved: ["Onaylı", "blue"], check_running: ["Check çalışıyor", "blue"],
  check_ok: ["Check başarılı", "green"], check_failed: ["Check hatalı", "red"], running: ["Uygulanıyor", "blue"],
  applied: ["Uygulandı", "green"], failed: ["Hatalı", "red"], rejected: ["Reddedildi", ""],
};
const remTag = (s) => { const [l, c] = REM_STATUS[s] || [s, ""]; return `<span class="label ${c}">${esc(l)}</span>`; };
const JOB_STATUS = { successful: "status-ok", failed: "status-err", error: "status-err", canceled: "status-err" };
State.remFilter = "";
State.remTimer = null;

async function loadRemediations() {
  try {
    const r = await Api.remediations({ status: State.remFilter, server: $("#remServer").value.trim() });
    const c = (State.remCfg = r.config);
    $("#remConfig").textContent = `Min. uyum ${c.minScore} · ${c.autoApprove ? "otomatik onay AÇIK" : "onay gerekli"} · ${c.requireCheck ? "önce check zorunlu" : "check opsiyonel"} · ${c.aap ? `runner #${c.runnerTemplate || "tanımsız"}` : "AAP bağlı değil"}`;
    const pending = r.items.filter((x) => x.status === "generated").length;
    $("#remCount").textContent = pending ? String(pending) : "";
    $("#remTable").innerHTML = `<tr><th>Zaman</th><th>Sunucu</th><th>Bulgu</th><th>Uyum</th><th>Durum</th><th>Son AAP işi</th><th>Kaynak</th></tr>` +
      (r.items.map((x) => `<tr class="clickable" data-rem="${esc(x.id)}">
        <td class="mono">${esc(fmtTime(x.createdAt))}</td>
        <td><div class="t-name">${esc(x.server.name)}</div><div class="t-sub">${esc(x.server.target)}${x.server.os_release ? ` · ${esc(x.server.os_release)}` : ""}</div></td>
        <td>${x.finding.priority ? `<span class="label ${x.finding.priority === "P1" ? "red" : "gold"}">${esc(x.finding.priority)}</span> ` : ""}${esc(x.finding.title)}</td>
        <td>${x.compliance ? scoreBar(x.compliance.score) : "—"}</td>
        <td>${remTag(x.status)}${x.runnable ? "" : ` <span class="label red" title="${esc(x.runnerError || "")}">çalıştırılamaz</span>`}</td>
        <td>${x.lastJob ? `<span class="${JOB_STATUS[x.lastJob.status] || ""}">#${esc(x.lastJob.id)} ${esc(x.lastJob.mode)} · ${esc(x.lastJob.status)}</span>` : "—"}</td>
        <td class="t-sub">${esc(x.source)}${x.requestedBy ? ` · ${esc(x.requestedBy)}` : ""}</td></tr>`).join("") ||
        `<tr><td colspan="7" class="muted">Henüz düzeltme yok. UnixAI OS'ta bir sunucu bulgusunda <b>MorpheusAI'ye gönder</b>'e basın veya MCP üzerinden gönderin.</td></tr>`);
  } catch (e) { $("#remTable").innerHTML = `<tr><td>${errorView(e)}</td></tr>`; }
}

async function showRemediation(id) {
  clearTimeout(State.remTimer);
  let r;
  try { r = await Api.remediation(id); } catch (e) { return toast(e.message, true); }
  const c = r.compliance || {}, f = r.finding;
  const active = r.jobs.some((j) => ["new", "pending", "waiting", "running"].includes(j.status));
  const checkOk = r.jobs.some((j) => j.mode === "check" && j.status === "successful");
  const cfg = State.remCfg || {};
  modal(`Düzeltme · ${r.server.name}`, `
    <div class="rem-head">
      ${c.score != null ? gauge(c.score, { size: 96, label: "uyum" }) : ""}
      <div>
        <div>${remTag(r.status)} <span class="muted sm">${esc(r.engine === "genai" ? "GenAI" : "Güvenli tanı (GenAI yok)")} · ${r.attempts} deneme · risk: ${esc(r.risk || "-")}${r.disruptive ? " · kesinti riskli adım içerir" : ""}</span></div>
        <h2 class="rem-title">${esc(r.title || f.title)}</h2>
        <p class="muted">${esc(r.summary || "")}</p>
      </div>
    </div>
    ${r.runnable ? "" : `<div class="alert danger">Bu playbook runner ile çalıştırılamaz: ${esc(r.runnerError)}</div>`}
    <div class="tabs">
      <button class="on" data-rtab="pb">Playbook</button>
      <button data-rtab="finding">Bulgu (UnixAI)</button>
      <button data-rtab="comp">Standart uyumu (${(c.findings || []).length})</button>
      <button data-rtab="jobs">AAP işleri (${r.jobs.length})</button>
      <button data-rtab="events">Geçmiş</button>
    </div>
    <div data-rpane="pb"><div class="fix"><pre>${esc(r.playbook)}</pre><button class="btn link sm copy" id="remCopy">Kopyala</button></div></div>
    <div data-rpane="finding" class="hidden"><dl class="kv">
      <dt>Sunucu</dt><dd>${esc(r.server.name)} · AAP hedefi <code>${esc(r.server.target)}</code>${r.server.host ? ` · ${esc(r.server.host)}` : ""}</dd>
      <dt>OS</dt><dd>${esc(r.server.os_release || "—")} ${r.server.kernel ? `· ${esc(r.server.kernel)}` : ""}</dd>
      <dt>Bulgu</dt><dd>${esc(f.priority || "")} ${esc(f.title)}</dd>
      ${f.evidence ? `<dt>Kanıt</dt><dd><pre class="code-block">${esc(f.evidence)}</pre></dd>` : ""}
      ${f.probable_cause ? `<dt>Olası neden</dt><dd>${esc(f.probable_cause)}</dd>` : ""}
      ${f.commands?.length ? `<dt>UnixAI komutları</dt><dd><pre class="code-block">${esc(f.commands.join("\n"))}</pre></dd>` : ""}
      ${f.risk ? `<dt>Risk</dt><dd>${esc(f.risk)}</dd>` : ""}
      <dt>Gönderen</dt><dd>${esc(r.source)}${r.requestedBy ? ` · ${esc(r.requestedBy)}` : ""}</dd>
    </dl></div>
    <div data-rpane="comp" class="hidden">${(c.findings || []).map((x, i) => findingHtml(x, i, "template")).join("") || `<p class="muted">Standart ihlali bulunmadı.</p>`}</div>
    <div data-rpane="jobs" class="hidden">${r.jobs.map((j) => `<div class="finding"><div class="finding-top">
        <b>#${esc(j.id)}</b> <span class="label">${j.mode === "check" ? "check (dry-run)" : "gerçek"}</span> <span class="${JOB_STATUS[j.status] || ""}">${esc(j.status)}</span>
        <span class="finding-meta"><span>${esc(fmtTime(j.launchedAt))}</span>${j.launchedBy ? `<span>${esc(j.launchedBy)}</span>` : ""}
        <span class="link" data-stdout="${esc(j.id)}">çıktı</span>${j.url ? `<a href="${esc(j.url)}" target="_blank" rel="noopener">AAP</a>` : ""}</span></div></div>`).join("") || `<p class="muted">Henüz çalıştırılmadı.</p>`}
      <pre class="code-block hidden" id="remStdout"></pre></div>
    <div data-rpane="events" class="hidden">${r.events.slice().reverse().map((e) => `<div class="ev"><span class="mono muted">${esc(fmtTime(e.at))}</span> <b>${esc(e.by)}</b> — ${esc(e.text)}</div>`).join("")}</div>
    <div class="result-actions">
      ${r.rejected ? `<span class="muted">Reddedildi: ${esc(r.rejected.by)}${r.rejected.reason ? ` — ${esc(r.rejected.reason)}` : ""}</span>` : `
        <button class="btn secondary" id="remCheck" ${!r.runnable || active ? "disabled" : ""}>Check modda çalıştır (dry-run)</button>
        ${r.approval ? `<span class="label blue">Onaylayan: ${esc(r.approval.by)}</span>` : `<button class="btn secondary" id="remApprove" ${!r.runnable ? "disabled" : ""}>Onayla</button>`}
        <button class="btn primary" id="remRun" ${!r.runnable || active || !r.approval || (cfg.requireCheck !== false && !checkOk) ? "disabled" : ""} title="${!r.approval ? "Önce onaylayın" : cfg.requireCheck !== false && !checkOk ? "Önce başarılı bir check çalıştırması gerekli" : ""}">Sunucuya uygula</button>
        <label class="muted sm">${r.disruptive ? `<input type="checkbox" id="remDisruptive" /> Kesinti riskli adımlara izin ver` : ""}</label>
        <span class="toolbar-spacer"></span>
        <button class="btn link" id="remReject">Reddet</button>`}
    </div>`, { wide: true });
  animateGauges($("#modalBody"));
  const body = $("#modalBody");
  body.onclick = async (ev) => {
    const t = ev.target.closest("[data-rtab]");
    if (t) {
      $$("[data-rtab]").forEach((b) => b.classList.toggle("on", b === t));
      $$("[data-rpane]").forEach((p) => p.classList.toggle("hidden", p.dataset.rpane !== t.dataset.rtab));
    }
    const so = ev.target.closest("[data-stdout]");
    if (so) {
      const pre = $("#remStdout");
      pre.classList.remove("hidden");
      pre.textContent = "Yükleniyor…";
      try { const d = await Api.remStdout(r.id, so.dataset.stdout); pre.textContent = d.raw ?? JSON.stringify(d); }
      catch (e) { pre.textContent = e.message; }
    }
  };
  const act = (sel, fn, msg) => {
    const b = $(sel);
    if (!b) return;
    b.onclick = async () => {
      b.disabled = true;
      try { await fn(); toast(msg); showRemediation(r.id); loadRemediations(); }
      catch (e) { toast(e.message, true); b.disabled = false; }
    };
  };
  $("#remCopy").onclick = () => copyText(r.playbook);
  act("#remCheck", () => Api.launchRem(r.id, "check"), "Check (dry-run) çalıştırması AAP'de başlatıldı");
  act("#remApprove", () => Api.approveRem(r.id), "Onaylandı");
  act("#remRun", () => Api.launchRem(r.id, "run", Boolean($("#remDisruptive")?.checked)), "Playbook sunucuya uygulanıyor (AAP)");
  act("#remReject", () => Api.rejectRem(r.id, prompt("Ret nedeni (opsiyonel):") || ""), "Reddedildi");
  if (active) State.remTimer = setTimeout(() => !$("#modal").classList.contains("hidden") && showRemediation(r.id), 5000);
}

/* ---- ajan ekranı yardımcıları ---- */
const fmtDur = (ms) => (ms == null ? "—" : ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} sn` : `${Math.round(ms / 60000)} dk`);
const ago = (iso) => {
  if (!iso) return "—";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? "az önce" : m < 60 ? `${m} dk önce` : m < 1440 ? `${Math.round(m / 60)} sa önce` : `${Math.round(m / 1440)} gün önce`;
};
function fillForm(form, obj) {
  for (const el of form.elements) {
    if (!el.name) continue;
    const v = obj[el.name];
    if (el.type === "checkbox") el.checked = Boolean(v); else el.value = v ?? "";
  }
}
function readForm(form) {
  const out = {};
  for (const el of form.elements) if (el.name) out[el.name] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
  return out;
}

/* ================================================================== */
/*  Ajan & MCP                                                         */
/* ================================================================== */
const MODE_LABEL = { native: "function calling", json: "JSON protokolü", auto: "otomatik" };

/** Ajan cevabının altındaki araç adımları */
function traceHtml(trace) {
  if (!trace?.length) return "";
  const steps = trace.filter((t) => t.type === "tool" || t.type === "info");
  const remote = [...new Set(steps.filter((t) => t.remoteAgent).map((t) => t.where))];
  return `<details class="trace"><summary>${steps.filter((t) => t.type === "tool").length} araç adımı${remote.length ? ` · <b>ajanla konuştu: ${esc(remote.join(", "))}</b>` : ""}</summary>
    ${steps.map((t) => t.type === "info" ? `<div class="tstep info">${esc(t.text)}</div>` : `<div class="tstep ${t.ok ? "" : "err"} ${t.remoteAgent ? "agent" : ""}">
      <div class="tstep-h"><span class="mono">${t.step}.</span> ${t.remoteAgent ? `<span class="label blue">ajan → ${esc(t.where)}</span>` : t.where && t.where !== "local" ? `<span class="label">${esc(t.where)}</span>` : ""}
        <b class="mono">${esc(t.tool)}</b> <span class="${t.ok ? "status-ok" : "status-err"}">${t.ok ? "✓" : "✕"}</span> <span class="muted sm">${fmtDur(t.durationMs)}</span></div>
      <details><summary class="muted sm">girdi / sonuç</summary><pre class="code-block">${esc(JSON.stringify(t.args, null, 1))}</pre><pre class="code-block">${esc(t.ok ? t.result : t.error)}</pre></details>
    </div>`).join("")}</details>`;
}

async function loadAgentPage() {
  const [srv, conns, st, convs] = await Promise.allSettled([Api.mcpServer(), Api.mcpConnections(), Api.agentSettings(), Api.conversations()]);
  if (srv.status === "fulfilled") renderMcpServer(srv.value);
  if (conns.status === "fulfilled") renderConns(conns.value);
  if (st.status === "fulfilled") {
    fillForm($("#agentForm"), st.value);
    $("#agentDetected").textContent = st.value.mode === "auto" ? `Algılanan: ${st.value.detected ? MODE_LABEL[st.value.detected] : "henüz bilinmiyor (ilk istekte denenir)"}` : "";
  }
  if (convs.status === "fulfilled") renderConvs(convs.value);
  renderAgentMap(conns.status === "fulfilled" ? conns.value : [], srv.status === "fulfilled" ? srv.value : null);
}

function renderAgentMap(conns, srv) {
  const tokens = srv?.tokens || [];
  $("#agentMap").innerHTML = `<div class="amap">
    <div class="amap-col"><div class="amap-h">Bağlanan istemciler</div>
      ${tokens.map((t) => `<div class="amap-node in">${esc(t.name)}${t.readonly ? ` <span class="label">salt-okunur</span>` : ""}<small>${t.lastUsedAt ? `son: ${esc(ago(t.lastUsedAt))}` : "henüz bağlanmadı"}</small></div>`).join("") || `<div class="amap-node ghost">Henüz token yok</div>`}
    </div>
    <div class="amap-arrow">→ /mcp →</div>
    <div class="amap-col center"><div class="amap-core">◆<b>Morpheus ajanı</b><small>${esc(MODE_LABEL[State.health?.agent?.detected || State.health?.agent?.mode] || "")}</small></div></div>
    <div class="amap-arrow">→ MCP →</div>
    <div class="amap-col"><div class="amap-h">Bağlı sunucular</div>
      ${conns.map((c) => `<div class="amap-node out ${c.enabled ? "" : "off"}">${esc(c.name)}${c.lastTest ? ` <span class="${c.lastTest.ok ? "status-ok" : "status-err"}">${c.lastTest.ok ? `✓ ${c.lastTest.tools} araç` : "✕"}</span>` : ""}<small>${esc(c.url)}</small></div>`).join("") || `<div class="amap-node ghost">Henüz bağlantı yok</div>`}
    </div></div>`;
}

function renderMcpServer(s) {
  State.mcpServer = s;
  $("#mcpServerInfo").innerHTML = `
    <dt>Uç nokta</dt><dd><code>${esc(s.endpoint)}</code> <button class="btn link sm" id="copyEndpoint">Kopyala</button></dd>
    <dt>Taşıma</dt><dd>${esc(s.transport)} · ${esc(s.protocolVersions.join(", "))}</dd>
    <dt>Araçlar</dt><dd>${s.tools.map((t) => `<span class="label ${t.readonly ? "" : "gold"}" title="${esc(t.description)}">${esc(t.name)}</span>`).join(" ")}</dd>
    <dt>.env token</dt><dd>${s.envToken ? "UNIXAI_API_TOKEN tanımlı (tam yetki)" : "yok"}</dd>`;
  $("#copyEndpoint").onclick = () => copyText(s.endpoint);
  $("#mcpTokens").innerHTML = `<tr><th>Ad</th><th>Önek</th><th>Yetki</th><th>Son kullanım</th><th></th></tr>` +
    (s.tokens.map((t) => `<tr><td class="t-name">${esc(t.name)}</td><td class="mono">${esc(t.prefix)}…</td><td>${t.readonly ? "salt-okunur" : "tam"}</td>
      <td class="t-sub">${t.lastUsedAt ? esc(ago(t.lastUsedAt)) : "—"}</td><td class="row-actions"><button class="btn link sm danger" data-del-token="${esc(t.id)}">İptal et</button></td></tr>`).join("") ||
      `<tr><td colspan="5" class="muted">Token yok. Başka bir ajanın / MCP istemcisinin bağlanması için token üretin.</td></tr>`);
  $("#mcpOriginForm").elements.origins.value = s.allowedOrigins.join("\n");
}

function showNewToken(t) {
  const ep = State.mcpServer?.endpoint || location.origin + "/mcp";
  const cfg = JSON.stringify({ mcpServers: { "morpheusai": { type: "http", url: ep, headers: { Authorization: `Bearer ${t.token}` } } } }, null, 2);
  modal(`Token: ${t.name}`, `<div class="alert info">Token yalnızca şimdi gösterilir; güvenli bir yere kaydedin.</div>
    <div class="fix"><pre class="term">${esc(t.token)}</pre><button class="btn link sm copy" id="cpTok">Kopyala</button></div>
    <div class="sub-h">UnixAI OS'ta (veya başka bir ajanda) bağlantı</div>
    <p class="sm muted">Ajan &amp; MCP → Bağlantı ekle: ad <code>morpheusai</code>, adres <code>${esc(ep)}</code>, bu token.</p>
    <div class="sub-h">Claude Code</div>
    <div class="fix"><pre class="term"><span class="ln">claude mcp add --transport http morpheusai ${esc(ep)} --header "Authorization: Bearer ${esc(t.token)}"</span></pre></div>
    <div class="sub-h">JSON yapılandırma (Claude Desktop / diğer istemciler)</div>
    <div class="fix"><pre>${esc(cfg)}</pre><button class="btn link sm copy" id="cpCfg">Kopyala</button></div>`, { wide: true });
  $("#cpTok").onclick = () => copyText(t.token);
  $("#cpCfg").onclick = () => copyText(cfg);
}

function renderConns(list) {
  State.mcpConns = list;
  $("#mcpConns").innerHTML = `<tr><th>Ad</th><th>Adres</th><th>Durum</th><th></th></tr>` +
    (list.map((c) => `<tr class="${c.enabled ? "" : "row-off"}"><td class="t-name">${esc(c.name)}${c.description ? `<div class="t-sub">${esc(c.description)}</div>` : ""}</td>
      <td class="mono t-sub">${esc(c.url)}</td>
      <td>${c.lastTest ? `<span class="${c.lastTest.ok ? "status-ok" : "status-err"}" title="${esc(c.lastTest.error || "")}">${c.lastTest.ok ? `✓ ${c.lastTest.tools} araç` : "✕ hata"}</span><div class="t-sub">${esc(c.lastTest.server?.name || "")} ${esc(ago(c.lastTest.at))}</div>` : `<span class="muted sm">test edilmedi</span>`}</td>
      <td class="row-actions"><button class="btn link sm" data-conn-test="${esc(c.id)}">Test</button><button class="btn link sm" data-conn-edit="${esc(c.id)}">Düzenle</button><button class="btn link sm danger" data-conn-del="${esc(c.id)}">Sil</button></td></tr>`).join("") ||
      `<tr><td colspan="4" class="muted">Bağlantı yok. Örn. UnixAI OS: <code>http://unixai:3000/mcp</code> + UnixAI'de üretilen token.</td></tr>`);
}

function connModal(id) {
  const c = (State.mcpConns || []).find((x) => x.id === id) || { enabled: true };
  modal(id ? `Bağlantı · ${c.name}` : "MCP bağlantısı ekle", `<form id="connF" class="form">
    <div class="grid-2">
      <label>Ad<input class="input" name="name" value="${esc(c.name || "")}" placeholder="unixai" required /><small>Küçük harf; araçlar <code>ad__araç</code> olur.</small></label>
      <label>MCP adresi<input class="input mono" name="url" value="${esc(c.url || "")}" placeholder="http://unixai.kurum.local:3000/mcp" required /></label>
    </div>
    <label>Token (Bearer)<input class="input mono" name="token" type="password" value="${esc(c.token || "")}" autocomplete="new-password" /><small>Karşı uygulamada üretilen MCP erişim token'ı.</small></label>
    <label>Açıklama<input class="input" name="description" value="${esc(c.description || "")}" placeholder="RHEL sunucu gözlem ajanı" /></label>
    <label class="check"><input type="checkbox" name="enabled" ${c.enabled !== false ? "checked" : ""} /> Etkin (araçları ajana açık)</label>
    <label class="check"><input type="checkbox" name="insecureTls" ${c.insecureTls ? "checked" : ""} /> Sertifika doğrulamasını kapat</label>
    <div id="connOut"></div>
    <div class="toolbar end"><button class="btn primary" type="submit">Kaydet ve test et</button></div></form>`);
  $("#connF").onsubmit = async (e) => {
    e.preventDefault();
    const out = $("#connOut");
    try {
      const saved = await Api.saveMcpConnection({ ...readForm(e.target), id: c.id });
      out.innerHTML = loadingView("Bağlanılıyor…");
      const t = await Api.testMcpConnection(saved.id);
      out.innerHTML = t.ok ? `<div class="alert info"><b class="status-ok">✓ ${esc(t.server?.serverInfo?.title || t.server?.serverInfo?.name || "")}</b> — ${t.tools.length} araç: ${t.tools.map((x) => `<code>${esc(x.name)}</code>`).join(" ")}</div>`
        : `<div class="alert danger"><b>✕</b> ${esc(t.error)}</div>`;
      loadAgentPage();
      checkHealth();
    } catch (err) { out.innerHTML = errorView(err); }
  };
}

function renderConvs(rows) {
  $("#convTable").innerHTML = `<tr><th>Zaman</th><th>Kaynak</th><th>Soru</th><th>Araçlar</th><th>Konuştuğu ajanlar</th><th>Durum</th></tr>` +
    (rows.map((c) => `<tr class="clickable" data-conv="${esc(c.id)}"><td class="mono t-sub">${esc(fmtTime(c.startedAt))}</td>
      <td>${c.hop ? `<span class="label blue">ajan: ${esc(c.origin)}</span>` : esc(c.origin || "")}</td>
      <td class="q-cell" title="${esc(c.question)}">${esc(c.question)}</td>
      <td class="t-sub">${c.tools.length}</td><td>${c.remoteAgents.map((a) => `<span class="label blue">${esc(a)}</span>`).join(" ") || "—"}</td>
      <td class="${c.status === "done" ? "status-ok" : c.status === "failed" ? "status-err" : ""}">${esc(c.status)}</td></tr>`).join("") ||
      `<tr><td colspan="6" class="muted">Henüz konuşma yok.</td></tr>`);
}

async function showConversation(id) {
  try {
    const c = await Api.conversation(id);
    modal(`Ajan konuşması · ${fmtTime(c.startedAt)}`, `<dl class="kv">
      <dt>Kaynak</dt><dd>${esc(c.origin)}${c.hop ? ` · hop ${c.hop}` : ""}${c.parent ? ` · üst konuşma <code>${esc(c.parent)}</code>` : ""}</dd>
      <dt>Mod</dt><dd>${esc(MODE_LABEL[c.mode] || c.mode || "—")}</dd><dt>Durum</dt><dd>${esc(c.status)}${c.error ? ` — <span class="status-err">${esc(c.error)}</span>` : ""}</dd></dl>
      <div class="sub-h">Soru</div><div class="bubble">${esc(c.question)}</div>
      <div class="sub-h">Adımlar</div>${traceHtml(c.trace).replace("<details class=\"trace\">", "<details class=\"trace\" open>")}
      <div class="sub-h">Cevap</div><div class="bubble">${md(c.reply || "")}</div>`, { wide: true });
  } catch (e) { toast(e.message, true); }
}

function bindAgentPage() {
  $("#mcpTokenForm").onsubmit = async (e) => {
    e.preventDefault();
    try { const t = await Api.createMcpToken(e.target.elements.name.value, e.target.elements.readonly.checked); e.target.reset(); showNewToken(t); loadAgentPage(); }
    catch (err) { toast(err.message, true); }
  };
  $("#mcpOriginForm").onsubmit = async (e) => {
    e.preventDefault();
    try { await Api.saveMcpOrigins(e.target.elements.origins.value.split(/\s+/).filter(Boolean)); toast("İzinli alanlar kaydedildi"); }
    catch (err) { toast(err.message, true); }
  };
  $("#mcpTokens").onclick = async (e) => {
    const b = e.target.closest("[data-del-token]");
    if (b && confirm("Bu token iptal edilsin mi? Onu kullanan istemciler bağlanamaz.")) {
      try { await Api.deleteMcpToken(b.dataset.delToken); loadAgentPage(); } catch (err) { toast(err.message, true); }
    }
  };
  $("#mcpConnAdd").onclick = () => connModal(null);
  $("#mcpConns").onclick = async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.connEdit) connModal(b.dataset.connEdit);
    if (b.dataset.connTest) {
      b.disabled = true;
      try { const t = await Api.testMcpConnection(b.dataset.connTest); toast(t.ok ? `Bağlandı · ${t.tools.length} araç` : t.error, !t.ok); loadAgentPage(); }
      catch (err) { toast(err.message, true); } finally { b.disabled = false; }
    }
    if (b.dataset.connDel && confirm("Bağlantı silinsin mi?")) {
      try { await Api.deleteMcpConnection(b.dataset.connDel); loadAgentPage(); } catch (err) { toast(err.message, true); }
    }
  };
  $("#agentForm").onsubmit = async (e) => {
    e.preventDefault();
    try { await Api.saveAgentSettings(readForm(e.target)); toast("Ajan ayarları kaydedildi"); loadAgentPage(); checkHealth(); }
    catch (err) { toast(err.message, true); }
  };
  $("#convRefresh").onclick = loadAgentPage;
  $("#convTable").onclick = (e) => { const tr = e.target.closest("[data-conv]"); if (tr) showConversation(tr.dataset.conv); };
}

function bindEvents() {
  addEventListener("hashchange", route);
  $("#menuBtn").onclick = () => $("#sidebar").classList.toggle("open");
  $("#modalClose").onclick = closeModal;
  // Not: onclick işleyicisi false döndürürse tarayıcı tıklamayı iptal eder (modal içindeki submit düğmeleri çalışmaz)
  $("#modal").onclick = (e) => { if (e.target.id === "modal") closeModal(); };
  addEventListener("keydown", (e) => e.key === "Escape" && closeModal());

  document.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-href]");
    if (tr) location.hash = tr.dataset.href;
    const lg = e.target.closest("tr[data-log]");
    if (lg) showLog(lg.dataset.log);
  });
  $("#tplFilter").oninput = renderTplTable;
  $("#wfFilter").oninput = renderWfTable;

  // template
  const ta = $("#tplInput");
  ta.addEventListener("input", () => { syncGutter(); delete ta.dataset.templateId; });
  ta.addEventListener("scroll", () => ($("#tplGutter").scrollTop = ta.scrollTop));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab") { e.preventDefault(); ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end"); syncGutter(); }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) analyzeTemplate();
  });
  $("#tplSelect").onchange = (e) => e.target.value && (location.hash = `#/template/${encodeURIComponent(e.target.value)}`);
  $("#tplFile").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    ta.value = await f.text();
    delete ta.dataset.templateId;
    $("#tplSelect").value = "";
    syncGutter();
    toast(`${f.name} yüklendi`);
    e.target.value = "";
  };
  $("#tplClear").onclick = () => { ta.value = ""; delete ta.dataset.templateId; $("#tplSelect").value = ""; syncGutter(); };
  $("#tplRules").onclick = (e) => {
    const c = e.target.closest("[data-rule]");
    if (!c) return;
    const id = c.dataset.rule;
    State.runRules.has(id) ? State.runRules.delete(id) : State.runRules.add(id);
    renderRuleChips();
  };
  $("#tplAnalyze").onclick = analyzeTemplate;
  $("#tplPrompt").addEventListener("keydown", (e) => e.key === "Enter" && analyzeTemplate());

  // workflow
  $("#wfSelect").onchange = (e) => e.target.value && (location.hash = `#/workflow/${encodeURIComponent(e.target.value)}`);
  $("#wfAnalyze").onclick = analyzeWorkflow;
  $("#wfIdGo").onclick = () => fetchByIdAndAnalyze("workflow");
  $("#wfIdInput").addEventListener("keydown", (e) => e.key === "Enter" && fetchByIdAndAnalyze("workflow"));
  $("#tplIdGo").onclick = () => fetchByIdAndAnalyze("template");
  $("#tplIdInput").addEventListener("keydown", (e) => e.key === "Enter" && fetchByIdAndAnalyze("template"));
  $("#wfJsonToggle").onclick = () => $("#wfJsonWrap").classList.toggle("hidden");
  $("#wfJsonApply").onclick = () => {
    try {
      setWorkflow({ ...(State.currentWorkflow || {}), ...JSON.parse($("#wfJson").value) });
      toast("Diyagram güncellendi");
    } catch (e) { toast(`JSON hatası: ${e.message}`, true); }
  };
  $("#wfCanvas").addEventListener("click", (e) => {
    const g = e.target.closest(".wf-node");
    if (g) showNode(g.dataset.id);
  });

  // chat
  const ct = $("#chatText");
  $("#chatForm").onsubmit = (e) => { e.preventDefault(); const v = ct.value; ct.value = ""; ct.style.height = ""; sendChat(v); };
  ct.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#chatForm").requestSubmit(); }
  });
  ct.addEventListener("input", () => { ct.style.height = "auto"; ct.style.height = ct.scrollHeight + "px"; });
  $("#chatSuggest").innerHTML = SUGGESTIONS.map((s) => `<button type="button">${esc(s)}</button>`).join("");
  $("#chatSuggest").onclick = (e) => { if (e.target.matches("button")) sendChat(e.target.textContent); };
  $("#chatClear").onclick = resetChat;

  // standards
  $("#stdSearch").oninput = renderStandards;
  $("#stdScope").onclick = (e) => {
    const b = e.target.closest("[data-scope]");
    if (!b) return;
    State.stdScope = b.dataset.scope;
    $$("#stdScope button").forEach((x) => x.classList.toggle("on", x === b));
    renderStandards();
  };
  $("#stdList").onclick = (e) => {
    const t = e.target.closest("[data-toggle]");
    if (!t) return;
    const id = t.dataset.toggle;
    State.disabled.has(id) ? State.disabled.delete(id) : State.disabled.add(id);
    State.disabled.has(id) ? State.runRules.delete(id) : State.runRules.add(id);
    writeLS("morpheus.disabledRules", [...State.disabled]);
    renderStandards(); renderRuleChips();
  };
  $("#stdAdd").onclick = addRuleModal;

  // logs
  $("#logService").onclick = (e) => {
    const b = e.target.closest("[data-service]");
    if (!b) return;
    State.logService = b.dataset.service;
    $$("#logService button").forEach((x) => x.classList.toggle("on", x === b));
    loadLogs();
  };
  $("#logRefresh").onclick = loadLogs;
  bindAgentPage();
  // düzeltmeler
  $("#remRefresh").onclick = loadRemediations;
  $("#remStatus").onclick = (e) => {
    const b = e.target.closest("[data-st]");
    if (!b) return;
    State.remFilter = b.dataset.st;
    $$("#remStatus button").forEach((x) => x.classList.toggle("on", x === b));
    loadRemediations();
  };
  let remT;
  $("#remServer").oninput = () => { clearTimeout(remT); remT = setTimeout(loadRemediations, 300); };
  $("#remTable").onclick = (e) => { const tr = e.target.closest("[data-rem]"); if (tr) showRemediation(tr.dataset.rem); };
  $("#logAuto").onchange = (e) => setLogAuto(e.target.checked);

  // analiz geçmişi
  $("#histRange").onclick = (e) => {
    const b = e.target.closest("[data-days]");
    if (!b) return;
    setHistRange(Number(b.dataset.days));
    loadHistory();
  };
  ["#histFrom", "#histTo"].forEach((id) => ($(id).onchange = () => {
    $("#histRange button").forEach((b) => b.classList.remove("on"));
    loadHistory();
  }));
  $("#histKind").onchange = loadHistory;
  $("#histUser").onchange = loadHistory;
  let histTimer;
  $("#histTarget").oninput = () => { clearTimeout(histTimer); histTimer = setTimeout(loadHistory, 350); };
  $("#histCsv").onclick = historyCsv;
  $("#histRules").onclick = (e) => {
    const r = e.target.closest("[data-rule]");
    if (!r) return;
    State.histRule = r.dataset.rule;
    loadHistory();
  };
  $("#histRuleFilter").onclick = (e) => {
    if (e.target.id !== "histRuleClear") return;
    e.preventDefault();
    State.histRule = "";
    loadHistory();
  };
  $("#histTargets").onclick = (e) => {
    const tr = e.target.closest("[data-target]");
    if (!tr) return;
    $("#histTarget").value = tr.dataset.target;
    loadHistory();
  };
  $("#histTable").onclick = (e) => {
    const tr = e.target.closest("[data-hist]");
    if (tr) showHistory(tr.dataset.hist);
  };

  // token kullanımı
  $("#usageRange").onclick = (e) => {
    const b = e.target.closest("[data-days]");
    if (!b) return;
    setUsageRange(Number(b.dataset.days));
    loadUsage();
  };
  ["#usageFrom", "#usageTo"].forEach((id) => ($(id).onchange = () => {
    $("#usageRange button").forEach((b) => b.classList.remove("on"));
    loadUsage();
  }));
  $("#usageUser").onchange = loadUsage;
  $("#usageKind").onchange = loadUsage;
  $("#usageCsv").onclick = usageCsv;
  $("#usageTable").onclick = (e) => {
    const tr = e.target.closest("[data-usage]");
    if (tr) showUsageRecord(+tr.dataset.usage);
  };
  $("#userChip").onclick = userMenu;
  $("#loginForm").onsubmit = submitLogin;
  // Oturum süresi dolarsa: giriş ekranı → başarılı girişte sayfayı yenile
  addEventListener("morpheus:auth-required", async () => {
    if (!$("#loginScreen").classList.contains("hidden")) return;
    await showLogin();
    location.reload();
  });
  $("#limitForm").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await Api.saveLimits({
        dailyLimit: Number(e.target.elements.dailyLimit.value || 0),
        perUserDailyLimit: Number(e.target.elements.perUserDailyLimit.value || 0),
      });
      toast("Limitler kaydedildi");
      loadLimits();
      refreshTokenChip();
    } catch (err) { toast(err.message, true); }
  };

  // settings
  $("#settingsForm").onsubmit = (e) => {
    e.preventDefault();
    Settings.save(Object.fromEntries(new FormData(e.target)));
    renderUserChip();
    refreshTokenChip();
    $("#settingsMsg").textContent = "Kaydedildi";
    setTimeout(() => ($("#settingsMsg").textContent = ""), 2000);
  };
  $("#promptForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const p = await Api.savePrompts({ system: f.elements.system.value, includeStandards: f.elements.includeStandards.checked });
      State.prompts = { ...State.prompts, ...p };
      $("#promptInfo").textContent = `Son kayıt: ${fmtTime(p.updatedAt)}`;
      toast("Sistem mesajı kaydedildi");
    } catch (err) { toast(err.message, true); }
  };
  $("#promptReset").onclick = () => {
    const d = State.prompts?.defaults;
    if (!d) return;
    $("#promptForm").elements.system.value = d.system;
    $("#promptForm").elements.includeStandards.checked = d.includeStandards;
    toast("Varsayılan metin yüklendi — kalıcı olması için Kaydet'e basın");
  };
  $("#promptPreview").onclick = previewRequest;
  $("#testConn").onclick = async (e) => {
    e.target.disabled = true;
    await checkHealth(true);
    e.target.disabled = false;
  };
}

async function loadCatalog() {
  const results = await Promise.allSettled([Api.standards(), Api.templates(), Api.workflows()]);
  const [std, tpl, wf] = results;
  if (std.status === "fulfilled") State.standards = std.value;
  if (tpl.status === "fulfilled") State.templates = tpl.value;
  if (wf.status === "fulfilled") State.workflows = wf.value;
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) toast(`Veri alınamadı: ${failed[0].reason.message}`, true);

  $("#tplSelect").innerHTML = `<option value="">Job template seçin…</option>` +
    State.templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
  $("#wfSelect").innerHTML = `<option value="">Workflow seçin…</option>` +
    State.workflows.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join("");
  State.runRules.clear();
  renderDashboard(); renderRuleChips(); renderStandards(); renderChatContext();
}

(async function init() {
  fillSettings();
  bindEvents();
  syncGutter();
  resetChat();

  // LDAP açıksa önce giriş
  try { State.auth = await Api.me(); }
  catch (e) { State.auth = e.data || { enabled: false }; }
  if (State.auth.enabled && !State.auth.user) State.auth.user = await showLogin();
  applyAuthUi();

  await checkHealth();
  loadPrompts();
  refreshTokenChip();
  setInterval(refreshTokenChip, 60000);
  await loadCatalog();
  route();
  askUserName();
})();
