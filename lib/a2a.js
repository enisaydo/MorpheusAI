/*
 * Ajanlar arası konuşma kaydı (MorpheusAI ajanı ⇄ UnixAI ajanı ve diğer bağlı ajanlar)
 * Kullanıcı sohbetlerinden ayrıdır. Her kayıt bir soru-cevap alışverişi:
 *   direction: "giden" (Morpheus karşı ajana sordu) | "gelen" (karşı ajan Morpheus'a sordu)
 *   peer, server, question, answer, remediations (playbook YAML, uyum, durum)
 * data/a2a/YYYY-MM-DD.jsonl
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.MORPHEUS_DATA_DIR || path.join(__dirname, "..", "data");
const DIR = path.join(DATA_DIR, "a2a");
const day = (d = new Date()) => d.toISOString().slice(0, 10);

function record({ direction, peer, question, answer, server, conversationId, remoteConversationId, remediations, tools, ok = true, error, durationMs, user, traceId }) {
  const row = {
    id: crypto.randomBytes(8).toString("hex"), time: new Date().toISOString(), date: day(), direction, peer, user: user || null, server: server || null,
    question: String(question || "").slice(0, 8000), answer: String(answer || "").slice(0, 20000), conversationId: conversationId || null,
    remoteConversationId: remoteConversationId || null, remediations: remediations || [], tools: tools || [], ok, error: error ? String(error).slice(0, 500) : null,
    durationMs: durationMs ?? null, traceId: traceId || require("./tracing").currentTraceId(),
  };
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(path.join(DIR, `${row.date}.jsonl`), JSON.stringify(row) + "\n");
  } catch (e) { console.error("[ajanlar] yazılamadı:", e.message); }
  require("./oplog").writeEntry("ajanlar-arasi", { ...row, category: "ajanlar-arasi", action: direction === "giden" ? `Morpheus → ${peer}` : `${peer} → Morpheus` });
  console.log(`[ajanlar] ${direction === "giden" ? `Morpheus → ${peer}` : `${peer} → Morpheus`}${row.server ? ` (${row.server})` : ""}: ` +
    `${JSON.stringify(row.question.slice(0, 120))} → ${ok ? "✓" : "✕ " + row.error}${row.remediations.length ? ` · ${row.remediations.length} playbook` : ""}`);
  return row;
}

function readDay(d) {
  try {
    return fs.readFileSync(path.join(DIR, `${d}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
const days = (n = 90) => Array.from({ length: n }, (_, i) => day(new Date(Date.now() - i * 86400e3)));

const summary = (r) => ({
  id: r.id, time: r.time, direction: r.direction, peer: r.peer, user: r.user, server: r.server, ok: r.ok, error: r.error, durationMs: r.durationMs,
  conversationId: r.conversationId, question: r.question.slice(0, 300), answer: r.answer.slice(0, 300),
  remediations: (r.remediations || []).map((x) => ({ id: x.id, title: x.title, status: x.status, score: x.score })),
});

function query({ server, peer, limit = 200 } = {}) {
  const items = [];
  for (const d of days()) {
    for (const r of readDay(d).reverse()) {
      if ((!server || r.server === server) && (!peer || r.peer === peer)) items.push(summary(r));
      if (items.length >= limit) break;
    }
    if (items.length >= limit) break;
  }
  const peers = [...new Set(days(30).flatMap(readDay).map((r) => r.peer))].sort();
  return { items, peers };
}

function get(id) {
  if (!/^[0-9a-f]{16}$/.test(id)) return null;
  for (const d of days()) { const r = readDay(d).find((x) => x.id === id); if (r) return r; }
  return null;
}

module.exports = { record, query, get };
