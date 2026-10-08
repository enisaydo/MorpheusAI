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
const ROUTES = ["dashboard", "template", "workflow", "oracle", "standards", "logs", "settings"];

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

async function loadTemplate(id) {
  $("#tplSelect").value = id;
  const ta = $("#tplInput");
  ta.value = "Yükleniyor…";
  try {
    const t = await getDetail("template", id);
    ta.value = t.content || "";
    ta.dataset.templateId = id;
  } catch (e) {
    ta.value = "";
    toast(`Template alınamadı: ${e.message}`, true);
  }
  syncGutter();
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
    const res = await Api.analyzeTemplate({
      content, rules, templateId,
      prompt: $("#tplPrompt").value.trim() || undefined,
      customRules: State.customRules.filter((r) => r.scope === "template" && rules.includes(r.id)),
    });
    const title = State.templates.find((t) => t.id === templateId)?.name || "Yapıştırılan içerik";
    State.lastAnalysis = { kind: "template", title, ...res };
    renderResult($("#tplResult"), res, { kind: "template", title });
    updateScore("templates", templateId, res.score);
  } catch (e) {
    $("#tplResult").innerHTML = errorView(e);
  } finally {
    btn.disabled = false;
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
        <div class="engine">${esc(ENGINE_LABEL[res.engine] || res.engine || "")}</div>
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

async function loadWorkflow(id) {
  $("#wfSelect").value = id;
  $("#wfCanvas").innerHTML = loadingView("Workflow yükleniyor…");
  try {
    setWorkflow(await getDetail("workflow", id));
  } catch (e) {
    $("#wfCanvas").innerHTML = errorView(e);
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
      <div class="bubble ${m.error ? "error" : ""}">${m.pending ? `<div class="typing"><span></span><span></span><span></span></div>` : md(m.content)}</div></div>`)
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
  } catch (e) {
    pending.content = `**Hata:** ${e.message}\n\nAyrıntılar için AI Logları ekranına bakın.`;
    pending.error = true;
  }
  pending.pending = false;
  State.chatBusy = false;
  $("#chatSend").disabled = false;
  renderChat();
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
  ["apiBase", "model", "systemPrompt"].forEach((k) => (f.elements[k].value = s[k] || ""));
  $("#contract").textContent = API_CONTRACT;
}

/* ================================================================== */
/*  Olaylar & başlatma                                                 */
/* ================================================================== */
function bindEvents() {
  addEventListener("hashchange", route);
  $("#menuBtn").onclick = () => $("#sidebar").classList.toggle("open");
  $("#modalClose").onclick = closeModal;
  $("#modal").onclick = (e) => e.target.id === "modal" && closeModal();
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
  $("#chatSuggest").onclick = (e) => e.target.matches("button") && sendChat(e.target.textContent);
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
  $("#logAuto").onchange = (e) => setLogAuto(e.target.checked);

  // settings
  $("#settingsForm").onsubmit = (e) => {
    e.preventDefault();
    Settings.save(Object.fromEntries(new FormData(e.target)));
    $("#settingsMsg").textContent = "Kaydedildi";
    setTimeout(() => ($("#settingsMsg").textContent = ""), 2000);
  };
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
  await checkHealth();
  await loadCatalog();
  route();
})();
