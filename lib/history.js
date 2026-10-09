/*
 * Analiz geçmişi
 *  - Her template / workflow analizi data/history/YYYY-MM-DD.jsonl dosyasına yazılır:
 *    zaman, kullanıcı, tür, hedef (id + ad), skor, durum, motor, bulgular, eksikler, uygulanan kurallar
 *  - Genel Bakış'taki "son skor" bu kayıtlardan okunur (yeniden başlatmada kaybolmaz)
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.MORPHEUS_DATA_DIR || path.join(__dirname, "..", "data");
const DIR = path.join(DATA_DIR, "history");
const TZ = process.env.USAGE_TIMEZONE || "Europe/Istanbul";
const LATEST_LOOKBACK_DAYS = 365;

const dayOf = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

const SEV_ORDER = ["critical", "high", "medium", "low", "info"];

/* ------------------------------------------------------------------ */
const dayCache = new Map();

function readDay(date) {
  if (dayCache.has(date)) return dayCache.get(date);
  let rows = [];
  try {
    rows = fs.readFileSync(path.join(DIR, `${date}.jsonl`), "utf8")
      .split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {}
  dayCache.set(date, rows);
  if (dayCache.size > 400) dayCache.delete(dayCache.keys().next().value);
  return rows;
}

function daysBack(n, to = dayOf()) {
  const out = [];
  const d = new Date(`${to}T12:00:00Z`);
  for (let i = 0; i < n; i++, d.setUTCDate(d.getUTCDate() - 1)) out.unshift(d.toISOString().slice(0, 10));
  return out;
}

function dateRange(from, to) {
  const out = [];
  const d = new Date(`${from}T12:00:00Z`), end = new Date(`${to}T12:00:00Z`);
  for (let i = 0; d <= end && i < 800; i++, d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

/* ---- Son skor indeksi: "template:7" → { score, time, id } ---- */
let latest = null;
function latestIndex() {
  if (latest) return latest;
  latest = new Map();
  for (const date of daysBack(LATEST_LOOKBACK_DAYS))
    for (const r of readDay(date)) if (r.targetId != null) latest.set(`${r.kind}:${r.targetId}`, { score: r.score, time: r.time, id: r.id });
  return latest;
}

const latestScore = (kind, targetId) => latestIndex().get(`${kind}:${targetId}`) || null;

/* ------------------------------------------------------------------ */
/**
 * @param {{kind:"template"|"workflow", targetId?, targetName?, content?, result, user?, ip?, rules?:string[], prompt?}} a
 */
function record(a) {
  const now = new Date();
  const findings = (a.result.findings || []).map((f) => ({
    ruleId: f.ruleId || "", severity: f.severity, title: f.title, detail: f.detail,
    line: f.line ?? null, nodeId: f.nodeId ?? null, fix: f.fix ?? null,
  }));
  const counts = Object.fromEntries(SEV_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length]));
  const row = {
    id: crypto.randomUUID(),
    time: now.toISOString(),
    date: dayOf(now),
    user: a.user || "bilinmiyor",
    ip: a.ip || null,
    kind: a.kind,
    targetId: a.targetId != null && a.targetId !== "" ? String(a.targetId) : null,
    targetName: a.targetName
      || (a.targetId ? `${a.kind === "template" ? "Template" : "Workflow"} #${a.targetId}` : a.kind === "template" ? "Yapıştırılan içerik" : "Workflow"),
    // Yapıştırılan içerikler için kısa özet: aynı içerik tekrar analiz edilince eşleştirilebilir
    contentHash: a.content ? crypto.createHash("sha256").update(a.content).digest("hex").slice(0, 12) : null,
    score: a.result.score ?? null,
    status: a.result.status || null,
    summary: String(a.result.summary || "").slice(0, 2000),
    engine: a.result.engine || null,
    counts,
    failedRules: [...new Set(findings.map((f) => f.ruleId).filter(Boolean))],
    findings,
    missing: a.result.missing || [],
    rules: a.rules || [],
    prompt: a.prompt || null,
  };
  readDay(row.date).push(row);
  if (row.targetId) latestIndex().set(`${row.kind}:${row.targetId}`, { score: row.score, time: row.time, id: row.id });
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(path.join(DIR, `${row.date}.jsonl`), JSON.stringify(row) + "\n");
  } catch (e) {
    console.error("[history] yazılamadı:", e.message);
  }
  return row;
}

const summaryOf = ({ findings, summary, rules, missing, prompt, ...s }) => s;
const targetKey = (r) => `${r.kind}:${r.targetId ?? "h:" + r.contentHash}`;

/** Tarih aralığı + filtreler; listeler, kural ve hedef istatistikleri */
function query({ from, to, kind, user, target, rule, limit = 500 } = {}) {
  const today = dayOf();
  to = /^\d{4}-\d{2}-\d{2}$/.test(to || "") ? to : today;
  from = /^\d{4}-\d{2}-\d{2}$/.test(from || "") ? from : daysBack(30, to)[0];
  if (from > to) [from, to] = [to, from];
  const all = dateRange(from, to).flatMap(readDay);
  let rows = all;
  if (kind) rows = rows.filter((r) => r.kind === kind);
  if (user) rows = rows.filter((r) => r.user === user);
  if (target) {
    const q = String(target).toLowerCase();
    rows = rows.filter((r) => String(r.targetId) === target || (r.targetName || "").toLowerCase().includes(q));
  }
  if (rule) rows = rows.filter((r) => r.failedRules.includes(rule));
  rows = rows.slice().sort((a, b) => (a.time < b.time ? 1 : -1));

  // En sık ihlal edilen kurallar
  const ruleMap = new Map();
  for (const r of rows)
    for (const f of r.findings) {
      if (!f.ruleId) continue;
      const g = ruleMap.get(f.ruleId) || { ruleId: f.ruleId, title: f.title, severity: f.severity, analyses: new Set(), findings: 0 };
      g.analyses.add(r.id); g.findings++;
      if (SEV_ORDER.indexOf(f.severity) < SEV_ORDER.indexOf(g.severity)) g.severity = f.severity;
      ruleMap.set(f.ruleId, g);
    }
  const byRule = [...ruleMap.values()]
    .map((g) => ({ ...g, analyses: g.analyses.size }))
    .sort((a, b) => b.analyses - a.analyses || SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));

  // Hedeflere göre (ilk → son skor)
  const tMap = new Map();
  for (const r of rows.slice().reverse()) {
    const k = targetKey(r);
    const g = tMap.get(k) || { key: k, kind: r.kind, targetId: r.targetId, targetName: r.targetName, count: 0, first: r.score, last: r.score, lastTime: r.time, sum: 0 };
    g.count++; g.sum += r.score ?? 0; g.last = r.score; g.lastTime = r.time; g.targetName = r.targetName;
    tMap.set(k, g);
  }
  const byTarget = [...tMap.values()]
    .map(({ sum, ...g }) => ({ ...g, avg: Math.round(sum / g.count), change: g.last - g.first }))
    .sort((a, b) => (a.lastTime < b.lastTime ? 1 : -1));

  const scores = rows.map((r) => r.score).filter((s) => s != null);
  return {
    from, to, timezone: TZ,
    total: {
      analyses: rows.length,
      avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      nonCompliant: rows.filter((r) => r.status === "non_compliant").length,
      targets: byTarget.length,
    },
    byRule,
    byTarget,
    records: rows.slice(0, limit).map(summaryOf),
    users: [...new Set(all.map((r) => r.user))].sort(),
  };
}

/** Tek kayıt + aynı hedefin önceki analizleri */
function get(id, lookbackDays = 365) {
  const days = daysBack(lookbackDays);
  for (let i = days.length - 1; i >= 0; i--) {
    const r = readDay(days[i]).find((x) => x.id === id);
    if (!r) continue;
    const k = targetKey(r);
    const timeline = days.flatMap(readDay).filter((x) => targetKey(x) === k)
      .sort((a, b) => (a.time < b.time ? 1 : -1)).slice(0, 50)
      .map((x) => ({ id: x.id, time: x.time, user: x.user, score: x.score, status: x.status, counts: x.counts, failedRules: x.failedRules }));
    return { ...r, timeline };
  }
  return null;
}

module.exports = { record, query, get, latestScore };
