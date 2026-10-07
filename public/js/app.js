/* MorpheusAI - uygulama */
const State = {
  standards: [],
  templates: [],
  workflows: [],
  disabled: new Set(readLS("morpheus.disabledRules", [])),
  customRules: readLS("morpheus.customRules", []),
  runRules: new Set(), // template ekranında bu çalıştırma için seçili kurallar
  lastAnalysis: null,
  currentWorkflow: null,
  wfAnalysis: null,
  chat: [],
  stdScope: "all",
};

function readLS(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeLS(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

const allRules = () => [...State.standards, ...State.customRules];
const activeRules = (scope) => allRules().filter((r) => r.scope === scope && !State.disabled.has(r.id));

/* ================================================================== */
/*  Router                                                             */
/* ================================================================== */
const ROUTES = {
  dashboard: "Komuta Merkezi",
  template: "Template Analizi",
  workflow: "Workflow Analizi",
  oracle: "Morpheus'a Sor",
  standards: "Standartlar",
  settings: "Ayarlar",
};

function route() {
  const [name, arg] = location.hash.replace(/^#\/?/, "").split("/");
  const r = ROUTES[name] ? name : "dashboard";
  $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === r));
  $$(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === r));
  $("#crumbs").textContent = ROUTES[r].toLowerCase().replace(/\s/g, "-").replace(/'/g, "");
  $("#sidebar").classList.remove("open");
  if (r === "template" && arg) loadTemplate(decodeURIComponent(arg));
  if (r === "workflow" && arg) loadWorkflow(decodeURIComponent(arg));
  if (r === "oracle") setTimeout(() => $("#chatText").focus(), 50);
  window.scrollTo(0, 0);
}

/* ================================================================== */
/*  Dashboard                                                          */
/* ================================================================== */
function renderDashboard() {
  const t = State.templates, w = State.workflows;
  const all = [...t, ...w];
  const avg = all.length ? Math.round(all.reduce((s, x) => s + (x.lastScore ?? 0), 0) / all.length) : 0;
  const bad = all.filter((x) => x.lastScore < 60).length;
  const good = all.filter((x) => x.lastScore >= 85).length;

  $("#heroGauge").innerHTML = gauge(avg, { size: 190, label: "genel uyum" });
  $("#kpis").innerHTML = [
    ["Job Template", t.length, "analiz edilebilir"],
    ["Workflow", w.length, "akış tanımı"],
    ["Uyumlu", good, "skor ≥ 85", "var(--green)"],
    ["Kritik Durumda", bad, "skor < 60", "var(--red)"],
  ]
    .map(([l, v, s, c]) => `<div class="kpi"><div class="k-label">${l}</div><div class="k-val" style="color:${c || "inherit"}">${v}</div><div class="k-sub">${s}</div></div>`)
    .join("");

  $("#tplTable").innerHTML =
    `<tr><th>Template</th><th>Envanter</th><th>Uyum</th></tr>` +
    t.map((x) => `<tr class="clickable" data-href="#/template/${encodeURIComponent(x.id)}">
        <td><div class="t-name">${esc(x.name)}</div><div class="t-sub">${esc(x.playbook)}</div></td>
        <td class="t-sub">${esc(x.inventory)}</td><td>${scoreBar(x.lastScore)}</td></tr>`).join("");

  $("#wfTable").innerHTML =
    `<tr><th>Workflow</th><th>Adım</th><th>Uyum</th></tr>` +
    w.map((x) => `<tr class="clickable" data-href="#/workflow/${encodeURIComponent(x.id)}">
        <td><div class="t-name">${esc(x.name)}</div><div class="t-sub">${esc(x.description || "")}</div></td>
        <td class="t-sub">${x.nodeCount ?? "-"}</td><td>${scoreBar(x.lastScore)}</td></tr>`).join("");

  animateGauges($("#heroGauge"));
}

/* ================================================================== */
/*  Template analizi                                                   */
/* ================================================================== */
function syncGutter() {
  const ta = $("#tplInput");
  const n = ta.value.split("\n").length;
  $("#tplGutter").textContent = Array.from({ length: n }, (_, i) => i + 1).join("\n");
  $("#tplGutter").scrollTop = ta.scrollTop;
}

function renderRuleChips() {
  const rules = activeRules("template");
  if (!State.runRules.size) rules.forEach((r) => State.runRules.add(r.id));
  $("#tplRules").innerHTML = rules
    .map((r) => `<span class="chip ${State.runRules.has(r.id) ? "on" : ""}" data-rule="${esc(r.id)}" title="${esc(r.title)}">${esc(r.id)}</span>`)
    .join("") || `<span class="muted sm">Aktif kural yok — Standartlar ekranından açın.</span>`;
}

async function loadTemplate(id) {
  $("#tplSelect").value = id;
  try {
    const t = await Api.template(id);
    $("#tplInput").value = t.content || "";
    $("#tplInput").dataset.templateId = id;
    syncGutter();
  } catch (e) { toast(e.message, true); }
}

function scanningView(steps) {
  return `<div class="scanning"><div class="scan-ring"></div><div class="scan-lines" id="scanLines"></div></div>`;
}
function playScan(steps) {
  let i = 0;
  const el = $("#scanLines");
  const timer = setInterval(() => {
    if (!el || i >= steps.length) return clearInterval(timer);
    el.innerHTML += `&gt; ${esc(steps[i++])}<br>`;
  }, 220);
  return () => clearInterval(timer);
}

async function analyzeTemplate() {
  const content = $("#tplInput").value.trim();
  if (!content) return toast("Önce bir template içeriği girin", true);
  const btn = $("#tplAnalyze");
  btn.disabled = true;
  $("#tplResult").innerHTML = scanningView();
  const stop = playScan([
    "YAML ayrıştırılıyor…", "Play yapısı çıkarılıyor…", "Güvenlik kuralları uygulanıyor…",
    "FQCN & idempotency kontrolü…", "Eksik bölümler tespit ediliyor…", "Rapor hazırlanıyor…",
  ]);
  try {
    const rules = [...State.runRules];
    const res = await Api.analyzeTemplate({
      content, rules, prompt: $("#tplPrompt").value.trim() || undefined,
      templateId: $("#tplInput").dataset.templateId || undefined,
      customRules: State.customRules.filter((r) => r.scope === "template" && rules.includes(r.id)),
    });
    State.lastAnalysis = { kind: "template", ...res };
    renderResult($("#tplResult"), res, { kind: "template", title: templateTitle() });
  } catch (e) {
    $("#tplResult").innerHTML = errorView(e);
  } finally {
    stop(); btn.disabled = false;
  }
}

function templateTitle() {
  const id = $("#tplInput").dataset.templateId;
  return State.templates.find((t) => t.id === id)?.name || "Yapıştırılan template";
}

function errorView(e) {
  return `<div class="empty"><div class="empty-ico" style="color:var(--red)">⚠</div>
    <p><b>Analiz başarısız</b></p><p class="muted sm">${esc(e.message)}</p>
    <p class="muted sm">Ayarlar ekranından API bağlantısını kontrol edin.</p></div>`;
}

function renderResult(root, res, { kind, title }) {
  const findings = res.findings || [];
  const counts = SEV_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length]).filter(([, n]) => n);
  const missing = res.missing || [];

  root.innerHTML = `
    <div class="result-head">
      ${gauge(res.score ?? 0, { size: 120, cls: "sm" })}
      <div>
        <span class="status-tag ${res.status}">${STATUS_LABEL[res.status] || res.status}</span>
        <h2>${esc(title)}</h2>
        <div class="muted">${esc(res.summary || "")}</div>
      </div>
    </div>
    <div class="sev-summary">${counts.map(([s, n]) => `${sevTag(s)}<b class="mono sm" style="margin-right:8px">×${n}</b>`).join("") || `<span class="muted sm">Bulgu yok 🎉</span>`}</div>
    <div class="tabs">
      <button class="on" data-tab="findings">Bulgular (${findings.length})</button>
      ${kind === "template" ? `<button data-tab="missing">Eksikler (${missing.length})</button>` : ""}
      <button data-tab="raw">Ham JSON</button>
    </div>
    <div data-pane="findings">${findings.map((f, i) => findingHtml(f, i, kind)).join("") || `<div class="empty"><p>Standart ihlali bulunamadı.</p></div>`}</div>
    <div data-pane="missing" class="hidden"><div class="missing-list">${missing.map((m) => `<div class="missing-item">＋ ${esc(m)}</div>`).join("") || `<p class="muted">Eksik bölüm yok.</p>`}</div></div>
    <div data-pane="raw" class="hidden"><div class="fix"><pre>${esc(JSON.stringify(res, null, 2))}</pre></div></div>
    <div class="result-actions">
      <button class="btn primary sm" data-act="ask">◉ Morpheus'a bu sonucu sor</button>
      <button class="btn ghost sm" data-act="md">⧉ Markdown rapor kopyala</button>
      <button class="btn ghost sm" data-act="json">⇩ JSON indir</button>
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
    if (act === "ask") askAboutAnalysis(kind, title);
    if (act === "md") copyText(markdownReport(res, title));
    if (act === "json") download(`morpheus-${kind}-rapor.json`, JSON.stringify(res, null, 2));
  };
}

function findingHtml(f, i, kind) {
  const loc =
    kind === "template" && f.line ? `<span class="line-link" data-line="${f.line}">satır ${f.line}</span>`
    : f.nodeId ? `<span class="line-link" data-node="${esc(f.nodeId)}">düğüm ${esc(f.nodeId)}</span>` : "";
  return `<div class="finding">
    <div class="finding-top">${sevTag(f.severity)}<span class="finding-title">${esc(f.title)}</span>
      <span class="finding-meta"><span>${esc(f.ruleId || "")}</span>${loc}</span></div>
    <p>${esc(f.detail || "")}</p>
    ${f.fix ? `<div class="fix"><pre>${esc(f.fix)}</pre><button class="btn ghost sm copy" data-copy="${i}">Kopyala</button></div>` : ""}
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
    `# MorpheusAI Raporu — ${title}`,
    ``,
    `**Skor:** ${res.score}/100 · **Durum:** ${STATUS_LABEL[res.status] || res.status}`,
    ``,
    res.summary || "",
    ``,
    `## Bulgular`,
    ...(res.findings || []).map((f) => `- **[${(f.severity || "").toUpperCase()}] ${f.ruleId || ""} ${f.title}** — ${f.detail || ""}${f.line ? ` (satır ${f.line})` : ""}`),
    ...(res.missing?.length ? ["", "## Eksik Bölümler", ...res.missing.map((m) => `- ${m}`)] : []),
  ].join("\n");
}

/* ================================================================== */
/*  Workflow analizi                                                   */
/* ================================================================== */
const NODE_STYLE = {
  job: { fill: "#0f2a1d", stroke: "#1f8f5f", icon: "▶" },
  approval: { fill: "#2a2008", stroke: "#c88a12", icon: "✋" },
  project_sync: { fill: "#0d1b33", stroke: "#3b70c8", icon: "⟳" },
  inventory_sync: { fill: "#1d1430", stroke: "#7a55c0", icon: "≡" },
  notification: { fill: "#2a0f16", stroke: "#b03550", icon: "✉" },
};
const EDGE_COLOR = { success: "#00e68a", failure: "#ff3b5c", always: "#3b8bff" };

async function loadWorkflow(id) {
  $("#wfSelect").value = id;
  try {
    const wf = await Api.workflow(id);
    setWorkflow(wf);
  } catch (e) { toast(e.message, true); }
}

function setWorkflow(wf) {
  State.currentWorkflow = wf;
  State.wfAnalysis = null;
  $("#wfJson").value = JSON.stringify({ name: wf.name, nodes: wf.nodes }, null, 2);
  $("#wfResult").innerHTML = "";
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
  // en uzun yol katmanlaması (döngüye karşı sınırlı)
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
  const W = 196, H = 58, GX = 80, GY = 34, P = 30;
  const pos = {};
  const maxRows = Math.max(...Object.values(cols).map((c) => c.length));
  Object.entries(cols).forEach(([lv, ids]) => {
    const offset = ((maxRows - ids.length) * (H + GY)) / 2;
    ids.forEach((id, i) => (pos[id] = { x: P + lv * (W + GX), y: P + offset + i * (H + GY) }));
  });
  const width = P * 2 + (Object.keys(cols).length) * (W + GX) - GX;
  const height = P * 2 + maxRows * (H + GY) - GY;
  return { pos, W, H, width, height, byId };
}

function drawWorkflow(wf) {
  const nodes = wf.nodes || [];
  if (!nodes.length) {
    $("#wfCanvas").innerHTML = `<div class="empty"><p>Workflow boş.</p></div>`;
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
          // geri/aynı seviye bağlantı: üstten kavis
          const x1 = a.x + W / 2, y1 = a.y, x2 = b.x + W / 2, y2 = b.y;
          const top = Math.min(y1, y2) - 26;
          d = `M${x1},${y1} C${x1},${top} ${x2},${top} ${x2},${y2 - 6}`;
        }
        edges.push(`<path d="${d}" fill="none" stroke="${EDGE_COLOR[kind]}" stroke-width="1.8" stroke-opacity=".85"
          ${kind === "always" ? 'stroke-dasharray="5 4"' : ""} marker-end="url(#arr-${kind})"/>`);
      })));

  const nodeSvg = nodes.map((n) => {
    const p = pos[n.id], st = NODE_STYLE[n.type] || NODE_STYLE.job;
    const name = n.name.length > 24 ? n.name.slice(0, 23) + "…" : n.name;
    return `<g class="wf-node ${flagged.has(n.id) ? "flag" : ""}" data-id="${esc(n.id)}" transform="translate(${p.x},${p.y})">
      <rect class="box" width="${W}" height="${H}" rx="10" fill="${st.fill}" stroke="${st.stroke}"/>
      <rect width="4" height="${H - 20}" x="0" y="10" rx="2" fill="${st.stroke}"/>
      <text x="16" y="24" fill="#e6fff1" font-size="12.5" font-weight="600">${esc(st.icon)}  ${esc(name)}</text>
      <text x="16" y="43" fill="#7fa28d" font-size="10.5" font-family="JetBrains Mono, monospace">${esc(n.type)} · ${esc(n.id)}</text>
      ${flagged.has(n.id) ? `<circle cx="${W - 12}" cy="12" r="7" fill="#ff3b5c"/><text x="${W - 15}" y="16" fill="#fff" font-size="10" font-weight="700">!</text>` : ""}
    </g>`;
  }).join("");

  const markers = Object.entries(EDGE_COLOR).map(([k, c]) =>
    `<marker id="arr-${k}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`).join("");

  $("#wfCanvas").innerHTML = `<svg width="${width}" height="${Math.max(height, 300)}" viewBox="0 0 ${width} ${Math.max(height, 300)}">
    <defs>${markers}</defs>${edges.join("")}${nodeSvg}</svg>`;
}

function highlightNode(id) {
  const g = $(`.wf-node[data-id="${CSS.escape(id)}"]`);
  if (!g) return;
  g.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  g.animate([{ opacity: 1 }, { opacity: 0.2 }, { opacity: 1 }], { duration: 500, iterations: 3 });
}

function showNode(id) {
  const n = State.currentWorkflow?.nodes.find((x) => x.id === id);
  if (!n) return;
  const issues = (State.wfAnalysis?.findings || []).filter((f) => f.nodeId === id);
  const link = (arr) => (arr || []).map((x) => `<code>${esc(x)}</code>`).join(" ") || "<span class='muted'>—</span>";
  modal(n.name, `
    <p class="muted mono sm">${esc(n.type)} · ${esc(n.id)}</p>
    <p><span class="lg success"></span> success: ${link(n.success)}</p>
    <p><span class="lg failure"></span> failure: ${link(n.failure)}</p>
    <p><span class="lg always"></span> always: ${link(n.always)}</p>
    ${issues.length ? `<h4>Bulgular</h4>${issues.map((f, i) => findingHtml(f, i, "workflow")).join("")}` : `<p class="muted">Bu düğüm için bulgu yok.</p>`}`);
}

async function analyzeWorkflow() {
  const wf = State.currentWorkflow;
  if (!wf) return toast("Önce bir workflow seçin", true);
  const btn = $("#wfAnalyze");
  btn.disabled = true;
  const box = $("#wfResult");
  box.classList.remove("hidden");
  box.innerHTML = scanningView();
  const stop = playScan(["Düğümler okunuyor…", "Graf topolojisi çıkarılıyor…", "Failure dalları kontrol ediliyor…", "Onay & rollback adımları aranıyor…", "Rapor hazırlanıyor…"]);
  try {
    const rules = activeRules("workflow").map((r) => r.id);
    const res = await Api.analyzeWorkflow({
      workflow: { name: wf.name, nodes: wf.nodes }, rules,
      customRules: State.customRules.filter((r) => r.scope === "workflow" && !State.disabled.has(r.id)),
    });
    State.wfAnalysis = res;
    State.lastAnalysis = { kind: "workflow", ...res };
    renderResult(box, res, { kind: "workflow", title: wf.name });
    drawWorkflow(wf);
  } catch (e) {
    box.innerHTML = errorView(e);
  } finally {
    stop(); btn.disabled = false;
  }
}

/* ================================================================== */
/*  Morpheus'a Sor (chat)                                              */
/* ================================================================== */
const SUGGESTIONS = [
  "Bu template'te eksik ne var?",
  "Kritik bulguları önceliklendir ve düzeltilmiş YAML öner",
  "Prod workflow standardımızı özetle",
  "FQCN kuralı neden önemli?",
  "Vault ile secret yönetimini nasıl yapmalıyım?",
];

function renderChat() {
  const log = $("#chatLog");
  log.innerHTML = State.chat
    .map((m) => `<div class="msg ${m.role === "user" ? "user" : "bot"}">
      <div class="avatar">${m.role === "user" ? "SEN" : "M"}</div>
      <div class="bubble">${m.pending ? `<div class="typing"><span></span><span></span><span></span></div>` : md(m.content)}</div></div>`)
    .join("");
  log.scrollTop = log.scrollHeight;
  $("#chatSuggest").innerHTML = SUGGESTIONS.map((s) => `<button type="button">${esc(s)}</button>`).join("");
}

async function sendChat(text) {
  text = text.trim();
  if (!text) return;
  State.chat.push({ role: "user", content: text });
  const pending = { role: "assistant", content: "", pending: true };
  State.chat.push(pending);
  renderChat();
  try {
    const messages = State.chat.filter((m) => !m.pending).map(({ role, content }) => ({ role, content }));
    const context = $("#chatCtx").checked ? State.lastAnalysis : undefined;
    const res = await Api.chat({ messages, context });
    pending.content = res.reply ?? res.content ?? JSON.stringify(res);
  } catch (e) {
    pending.content = `⚠ **Hata:** ${e.message}`;
  }
  pending.pending = false;
  renderChat();
}

function askAboutAnalysis(kind, title) {
  location.hash = "#/oracle";
  $("#chatCtx").checked = true;
  sendChat(`"${title}" ${kind === "template" ? "template" : "workflow"} analiz sonucunu yorumla: en kritik bulgular neler ve nasıl düzeltirim?`);
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
  modal("Yeni Standart Kuralı", `
    <form id="ruleForm" class="form">
      <label>Kural ID <input class="input" name="id" required placeholder="STD-100" /></label>
      <label>Başlık <input class="input" name="title" required placeholder="Örn. Log rotasyonu tanımlı olmalı" /></label>
      <div class="row gap-sm">
        <label style="flex:1">Kapsam <select class="input" name="scope"><option value="template">Template</option><option value="workflow">Workflow</option></select></label>
        <label style="flex:1">Önem <select class="input" name="severity">${SEV_ORDER.map((s) => `<option value="${s}">${SEV_LABEL[s]}</option>`).join("")}</select></label>
      </div>
      <label>Kategori <input class="input" name="category" placeholder="Operasyon" /></label>
      <label>Açıklama (AI'a talimat olarak gönderilir) <textarea class="input" name="description" rows="3" required></textarea></label>
      <div class="row gap-sm end"><button class="btn primary" type="submit">Ekle</button></div>
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
/*  Ayarlar & bağlantı                                                 */
/* ================================================================== */
function fillSettings() {
  const s = Settings.get(), f = $("#settingsForm");
  ["apiBase", "apiKey", "model", "systemPrompt"].forEach((k) => (f.elements[k].value = s[k] || ""));
  $("#contract").textContent = API_CONTRACT;
}

async function checkHealth(showToast = false) {
  const c = $("#connStatus"), badge = $("#modeBadge");
  try {
    const h = await Api.health();
    const live = h.mode !== "demo";
    c.className = "conn ok";
    $(".label", c).textContent = live ? "AI backend bağlı" : "Sunucu bağlı · demo";
    badge.textContent = live ? "LIVE" : "DEMO";
    badge.classList.toggle("live", live);
    if (showToast) toast(`Bağlantı başarılı (${h.mode || "ok"})`);
    return true;
  } catch (e) {
    c.className = "conn err";
    $(".label", c).textContent = "Bağlantı yok";
    if (showToast) toast(`Bağlantı hatası: ${e.message}`, true);
    return false;
  }
}

const QUOTES = [
  ["Sana sadece kapıyı gösterebilirim. İçinden geçmesi gereken sensin.", "Morpheus"],
  ["Matrix her yerde. Template'lerin içinde bile.", "Morpheus"],
  ["Yolu bilmekle yolda yürümek arasında fark vardır.", "Morpheus"],
  ["Hiç gerçek olduğundan emin olduğun bir playbook gördün mü?", "Morpheus"],
  ["Özgür bırak zihnini. ignore_errors'u da.", "Morpheus"],
];
function rotateQuote() {
  const [q, a] = QUOTES[(Math.random() * QUOTES.length) | 0];
  $("#quote").innerHTML = `“${esc(q)}”<b>— ${esc(a)}</b>`;
}

/* ================================================================== */
/*  Olaylar & başlatma                                                 */
/* ================================================================== */
function bindEvents() {
  addEventListener("hashchange", route);
  $("#menuBtn").onclick = () => $("#sidebar").classList.toggle("open");
  $("#rainToggle").onclick = () => {
    document.body.classList.toggle("no-rain");
    writeLS("morpheus.noRain", document.body.classList.contains("no-rain"));
  };
  $("#modalClose").onclick = closeModal;
  $("#modal").onclick = (e) => e.target.id === "modal" && closeModal();
  addEventListener("keydown", (e) => e.key === "Escape" && closeModal());

  document.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-href]");
    if (tr) location.hash = tr.dataset.href;
  });

  // template
  const ta = $("#tplInput");
  ta.addEventListener("input", () => { syncGutter(); delete ta.dataset.templateId; });
  ta.addEventListener("scroll", () => ($("#tplGutter").scrollTop = ta.scrollTop));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en } = ta;
      ta.setRangeText("  ", s, en, "end");
      syncGutter();
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) analyzeTemplate();
  });
  $("#tplSelect").onchange = (e) => e.target.value && loadTemplate(e.target.value);
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
    c.classList.toggle("on");
  };
  $("#tplAnalyze").onclick = analyzeTemplate;
  $("#tplPrompt").addEventListener("keydown", (e) => e.key === "Enter" && analyzeTemplate());

  // workflow
  $("#wfSelect").onchange = (e) => e.target.value && loadWorkflow(e.target.value);
  $("#wfAnalyze").onclick = analyzeWorkflow;
  $("#wfJsonToggle").onclick = () => $("#wfJsonWrap").classList.toggle("hidden");
  $("#wfJsonApply").onclick = () => {
    try {
      const data = JSON.parse($("#wfJson").value);
      setWorkflow({ ...(State.currentWorkflow || {}), ...data });
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
  $("#chatSuggest").onclick = (e) => e.target.matches("button") && sendChat(e.target.textContent);

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

  // settings
  $("#settingsForm").onsubmit = (e) => {
    e.preventDefault();
    Settings.save(Object.fromEntries(new FormData(e.target)));
    $("#settingsMsg").textContent = "Kaydedildi ✓";
    setTimeout(() => ($("#settingsMsg").textContent = ""), 2000);
    boot();
  };
  $("#testConn").onclick = () => checkHealth(true);
}

async function boot() {
  await checkHealth();
  try {
    const [std, tpl, wf] = await Promise.all([Api.standards(), Api.templates(), Api.workflows()]);
    State.standards = std; State.templates = tpl; State.workflows = wf;
  } catch (e) {
    toast(`Veri yüklenemedi: ${e.message}`, true);
  }
  $("#tplSelect").innerHTML = `<option value="">AWX'ten seç…</option>` +
    State.templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
  $("#wfSelect").innerHTML = `<option value="">Workflow seç…</option>` +
    State.workflows.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join("");
  State.runRules.clear();
  renderDashboard(); renderRuleChips(); renderStandards();
}

(function init() {
  if (readLS("morpheus.noRain", false)) document.body.classList.add("no-rain");
  startRain();
  rotateQuote();
  setInterval(rotateQuote, 15000);
  fillSettings();
  bindEvents();
  syncGutter();
  State.chat.push({
    role: "assistant",
    content: "Hoş geldin, operatör. Ben **Morpheus**.\n\nAnsible template'lerini ve workflow'larını kurumsal standartlarına göre analiz edebilirim. Bir soru sor ya da aşağıdaki önerilerden birini seç.",
  });
  renderChat();
  boot().then(route);
})();
