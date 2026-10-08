/*
 * Token kullanımı ve günlük limitler
 *  - Her AI çağrısı data/usage/YYYY-MM-DD.jsonl dosyasına bir satır olarak yazılır
 *    (kim, ne zaman, hangi tür, hangi soru, kaç token)
 *  - Limitler data/limits.json'da saklanır, Ayarlar ekranından değiştirilir
 *      dailyLimit         : tüm kullanıcılar için günlük toplam token (0 = sınırsız)
 *      perUserDailyLimit  : kullanıcı başına günlük token (0 = sınırsız)
 *  - Gün sınırı USAGE_TIMEZONE'a göre hesaplanır (varsayılan Europe/Istanbul)
 */
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.MORPHEUS_DATA_DIR || path.join(__dirname, "..", "data");
const USAGE_DIR = path.join(DATA_DIR, "usage");
const LIMITS_FILE = path.join(DATA_DIR, "limits.json");
const TZ = process.env.USAGE_TIMEZONE || "Europe/Istanbul";

const LIMIT_DEFAULTS = { dailyLimit: 0, perUserDailyLimit: 0 };

/** YYYY-MM-DD (USAGE_TIMEZONE'da) */
const dayOf = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/* ------------------------------------------------------------------ */
/*  Limitler                                                           */
/* ------------------------------------------------------------------ */
let limitsCache = null;

function getLimits() {
  if (limitsCache) return limitsCache;
  try { limitsCache = { ...LIMIT_DEFAULTS, ...JSON.parse(fs.readFileSync(LIMITS_FILE, "utf8")) }; }
  catch { limitsCache = { ...LIMIT_DEFAULTS }; }
  return limitsCache;
}

function saveLimits({ dailyLimit, perUserDailyLimit }, user) {
  const num = (v, name) => {
    const n = Number(v ?? 0);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} 0 veya pozitif bir tam sayı olmalı`);
    return n;
  };
  const next = {
    dailyLimit: num(dailyLimit, "Günlük limit"),
    perUserDailyLimit: num(perUserDailyLimit, "Kullanıcı başına limit"),
    updatedAt: new Date().toISOString(),
    updatedBy: user || null,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LIMITS_FILE, JSON.stringify(next, null, 2));
  limitsCache = next;
  return next;
}

/* ------------------------------------------------------------------ */
/*  Kayıtlar                                                           */
/* ------------------------------------------------------------------ */
const dayCache = new Map(); // date → records[]

function readDay(date) {
  if (dayCache.has(date)) return dayCache.get(date);
  let rows = [];
  try {
    rows = fs.readFileSync(path.join(USAGE_DIR, `${date}.jsonl`), "utf8")
      .split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {}
  // Bugün ve dün dışındaki günler değişmeyeceği için önbellekte kalabilir; bugün zaten bellekte güncelleniyor
  dayCache.set(date, rows);
  if (dayCache.size > 120) dayCache.delete(dayCache.keys().next().value);
  return rows;
}

/**
 * @param {{user, ip, kind, question, model, usage, estimated, ok, error, logId}} r
 */
function record(r) {
  const now = new Date();
  const u = r.usage || {};
  const row = {
    time: now.toISOString(),
    date: dayOf(now),
    user: r.user || "bilinmiyor",
    ip: r.ip || null,
    kind: r.kind,
    question: String(r.question || "").slice(0, 2000),
    model: r.model || null,
    promptTokens: Number(u.prompt_tokens) || 0,
    completionTokens: Number(u.completion_tokens) || 0,
    totalTokens: Number(u.total_tokens) || (Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0),
    estimated: Boolean(r.estimated),
    ok: r.ok !== false,
    error: r.error || null,
    logId: r.logId || null,
  };
  readDay(row.date).push(row);
  try {
    fs.mkdirSync(USAGE_DIR, { recursive: true });
    fs.appendFileSync(path.join(USAGE_DIR, `${row.date}.jsonl`), JSON.stringify(row) + "\n");
  } catch (e) {
    console.error("[usage] yazılamadı:", e.message);
  }
  return row;
}

const sum = (rows) => rows.reduce((s, r) => s + r.totalTokens, 0);

function today(user) {
  const date = dayOf();
  const rows = readDay(date);
  const limits = getLimits();
  const total = sum(rows);
  const userTotal = user ? sum(rows.filter((r) => r.user === user)) : null;
  return {
    date,
    total,
    requests: rows.length,
    dailyLimit: limits.dailyLimit,
    remaining: limits.dailyLimit ? Math.max(0, limits.dailyLimit - total) : null,
    user: user || null,
    userTotal,
    perUserDailyLimit: limits.perUserDailyLimit,
    userRemaining: limits.perUserDailyLimit && user ? Math.max(0, limits.perUserDailyLimit - userTotal) : null,
  };
}

/** Limit dolmuşsa 429 hatası fırlatır (çağrıdan ÖNCE kontrol edilir). */
function assertAllowed(user) {
  const t = today(user);
  if (t.dailyLimit && t.total >= t.dailyLimit) {
    const e = new Error(`Günlük token limiti doldu (${t.total.toLocaleString("tr-TR")} / ${t.dailyLimit.toLocaleString("tr-TR")}). Limit yarın sıfırlanır veya Ayarlar'dan artırılabilir.`);
    e.status = 429;
    throw e;
  }
  if (t.perUserDailyLimit && user && t.userTotal >= t.perUserDailyLimit) {
    const e = new Error(`${user} için günlük token limiti doldu (${t.userTotal.toLocaleString("tr-TR")} / ${t.perUserDailyLimit.toLocaleString("tr-TR")}).`);
    e.status = 429;
    throw e;
  }
}

function dateRange(from, to) {
  const out = [];
  const d = new Date(`${from}T12:00:00Z`), end = new Date(`${to}T12:00:00Z`);
  for (let i = 0; d <= end && i < 400; i++, d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = r[key] || "—";
    const g = m.get(k) || { key: k, totalTokens: 0, promptTokens: 0, completionTokens: 0, requests: 0, errors: 0 };
    g.totalTokens += r.totalTokens; g.promptTokens += r.promptTokens; g.completionTokens += r.completionTokens;
    g.requests++; if (!r.ok) g.errors++;
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

/** Tarih aralığı raporu */
function report({ from, to, user, kind, limit = 500 } = {}) {
  const t = dayOf();
  to = /^\d{4}-\d{2}-\d{2}$/.test(to || "") ? to : t;
  from = /^\d{4}-\d{2}-\d{2}$/.test(from || "") ? from : dateRange(to, to)[0].slice(0, 8) + "01";
  if (from > to) [from, to] = [to, from];
  const days = dateRange(from, to);
  let rows = days.flatMap(readDay);
  if (user) rows = rows.filter((r) => r.user === user);
  if (kind) rows = rows.filter((r) => r.kind === kind);
  return {
    from, to, timezone: TZ,
    total: { totalTokens: sum(rows), promptTokens: rows.reduce((s, r) => s + r.promptTokens, 0),
             completionTokens: rows.reduce((s, r) => s + r.completionTokens, 0), requests: rows.length,
             errors: rows.filter((r) => !r.ok).length },
    days: days.map((date) => {
      const d = rows.filter((r) => r.date === date);
      return { date, totalTokens: sum(d), requests: d.length };
    }),
    byUser: groupBy(rows, "user"),
    byKind: groupBy(rows, "kind"),
    records: rows.slice().sort((a, b) => (a.time < b.time ? 1 : -1)).slice(0, limit),
    users: [...new Set(days.flatMap(readDay).map((r) => r.user))].sort(),
    limits: getLimits(),
    today: today(user),
  };
}

module.exports = { record, today, assertAllowed, report, getLimits, saveLimits, dayOf };
