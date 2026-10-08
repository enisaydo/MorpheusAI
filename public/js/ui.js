/* MorpheusAI - ortak UI yardımcıları */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const SEV_ORDER = ["critical", "high", "medium", "low", "info"];
const SEV_LABEL = { critical: "Kritik", high: "Yüksek", medium: "Orta", low: "Düşük", info: "Bilgi" };
const STATUS_LABEL = { compliant: "Uyumlu", warning: "İyileştirme gerekli", non_compliant: "Uyumsuz" };

const scoreColor = (s) => (s >= 85 ? "var(--success)" : s >= 60 ? "var(--warning)" : "var(--danger)");

function gauge(score, { size = 112, label = "uyum skoru" } = {}) {
  const r = size / 2 - 8, c = 2 * Math.PI * r, off = c * (1 - score / 100);
  return `<div class="gauge" style="width:${size}px;height:${size}px">
    <svg width="${size}" height="${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--border-soft)" stroke-width="8"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${scoreColor(score)}" stroke-width="8"
        stroke-dasharray="${c}" stroke-dashoffset="${c}" style="transition:stroke-dashoffset .8s ease" data-off="${off}"/>
    </svg>
    <div class="g-val"><div class="g-num">${score}</div><div class="g-lbl">${label}</div></div>
  </div>`;
}
function animateGauges(root = document) {
  requestAnimationFrame(() => $$("circle[data-off]", root).forEach((el) => (el.style.strokeDashoffset = el.dataset.off)));
}

const scoreBar = (s) =>
  s == null
    ? `<span class="muted sm">Analiz edilmedi</span>`
    : `<div class="scorebar"><div class="bar"><i style="width:${s}%;background:${scoreColor(s)}"></i></div><b>${s}</b></div>`;

const sevTag = (s) => `<span class="label sev-${s}">${SEV_LABEL[s] || esc(s)}</span>`;

/* Minimal & güvenli markdown (önce escape, sonra biçimlendirme) */
function md(src) {
  const blocks = [];
  let s = String(src ?? "").replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,!?:]|$)/g, "$1<i>$2</i>")
    .replace(/(^|[\s(])\*([^*]+)\*(?=[\s).,!?:]|$)/g, "$1<i>$2</i>");

  const out = [];
  let list = null;
  for (const line of s.split("\n")) {
    const ul = line.match(/^\s*[-*]\s+(.*)/), ol = line.match(/^\s*\d+\.\s+(.*)/);
    const item = ul || ol;
    if (item) {
      const tag = ul ? "ul" : "ol";
      if (list !== tag) { if (list) out.push(`</${list}>`); out.push(`<${tag}>`); list = tag; }
      out.push(`<li>${item[1]}</li>`);
      continue;
    }
    if (list) { out.push(`</${list}>`); list = null; }
    if (/^&gt;\s?/.test(line)) out.push(`<blockquote>${line.replace(/^&gt;\s?/, "")}</blockquote>`);
    else if (/^#{1,4}\s/.test(line)) out.push(`<p class="md-h">${line.replace(/^#+\s/, "")}</p>`);
    else if (line.trim()) out.push(`<p>${line}</p>`);
  }
  if (list) out.push(`</${list}>`);
  return out.join("").replace(/<p>\u0000(\d+)\u0000<\/p>|\u0000(\d+)\u0000/g, (_, a, b) => blocks[a ?? b]);
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast show${isErr ? " err" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 3000);
}

function modal(title, html, { wide = false } = {}) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = html;
  $("#modal .modal-box").classList.toggle("wide", wide);
  $("#modal").classList.remove("hidden");
}
function closeModal() { $("#modal").classList.add("hidden"); }

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("Panoya kopyalandı"); }
  catch { toast("Kopyalanamadı", true); }
}

function download(name, content, type = "application/json") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const fmtTime = (iso) => {
  try { return new Date(iso).toLocaleString("tr-TR", { hour12: false }); } catch { return iso; }
};
