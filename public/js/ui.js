/* MorpheusAI - ortak UI yardımcıları */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const SEV_ORDER = ["critical", "high", "medium", "low", "info"];
const SEV_LABEL = { critical: "Kritik", high: "Yüksek", medium: "Orta", low: "Düşük", info: "Bilgi" };
const STATUS_LABEL = { compliant: "UYUMLU", warning: "İYİLEŞTİRME GEREKLİ", non_compliant: "UYUMSUZ" };

const scoreColor = (s) => (s >= 85 ? "var(--green)" : s >= 60 ? "var(--amber)" : "var(--red)");

function gauge(score, { size = 150, label = "uyum skoru", cls = "" } = {}) {
  const r = size / 2 - 10, c = 2 * Math.PI * r, off = c * (1 - score / 100);
  return `<div class="gauge ${cls}">
    <svg width="${size}" height="${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="9"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${scoreColor(score)}" stroke-width="9"
        stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c}"
        style="transition:stroke-dashoffset 1.1s cubic-bezier(.2,.8,.2,1);filter:drop-shadow(0 0 6px ${scoreColor(score)})"
        data-off="${off}"/>
    </svg>
    <div class="g-val"><div class="g-num" style="color:${scoreColor(score)}">${score}</div><div class="g-lbl">${label}</div></div>
  </div>`;
}
function animateGauges(root = document) {
  requestAnimationFrame(() =>
    $$("circle[data-off]", root).forEach((el) => (el.style.strokeDashoffset = el.dataset.off)));
}

const scoreBar = (s) =>
  `<div class="scorebar"><div class="bar"><i style="width:${s}%;background:${scoreColor(s)}"></i></div><b style="color:${scoreColor(s)}">${s}</b></div>`;

const sevTag = (s) => `<span class="sev ${s}">${SEV_LABEL[s] || s}</span>`;

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
    else if (/^#{1,4}\s/.test(line)) out.push(`<p><b>${line.replace(/^#+\s/, "")}</b></p>`);
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
  toastTimer = setTimeout(() => (t.className = "toast"), 2600);
}

function modal(title, html) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = html;
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

/* Matrix yağmuru */
function startRain() {
  const cv = $("#rain"), ctx = cv.getContext("2d");
  const chars = "アイウエオカキクケコサシスセソタチツテトナニヌネノ01ANSIBLEYAML{}[]:-#$>".split("");
  const fs = 15;
  let cols, drops;
  const resize = () => {
    cv.width = innerWidth; cv.height = innerHeight;
    cols = Math.ceil(cv.width / fs);
    drops = Array.from({ length: cols }, () => Math.random() * -60);
  };
  resize();
  addEventListener("resize", resize);
  let last = 0;
  (function frame(t) {
    requestAnimationFrame(frame);
    if (t - last < 55 || document.body.classList.contains("no-rain") || document.hidden) return;
    last = t;
    ctx.fillStyle = "rgba(4,8,6,0.12)";
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.font = `${fs}px JetBrains Mono, monospace`;
    for (let i = 0; i < cols; i++) {
      const y = drops[i] * fs;
      ctx.fillStyle = Math.random() > 0.975 ? "#d8ffe9" : "#00e68a";
      ctx.fillText(chars[(Math.random() * chars.length) | 0], i * fs, y);
      if (y > cv.height && Math.random() > 0.975) drops[i] = 0;
      drops[i]++;
    }
  })(0);
}
