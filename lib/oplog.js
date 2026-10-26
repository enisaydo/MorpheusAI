/*
 * İşlem logları — sistemin yaptığı her iş, kategorisine göre AYRI dosyaya yazılır
 *
 *   logs/<kategori>/<kategori>-YYYY-MM-DD.jsonl     (bir satır = bir olay, JSON)
 *   + journalctl / podman logs için tek satırlık özet
 *
 *   islem          arayüz/API'den yapılan her değişiklik (kim, ne, sonuç)
 *   giris          LDAP giriş denemeleri
 *   duzeltme       düzeltme akışı: playbook üretimi → onay → Bitbucket → AAP proje sync → template → check/run
 *   bitbucket      Bitbucket REST çağrıları (commit, dosya kontrolü)
 *   aap            AAP REST çağrıları (proje sync, job template, job launch/durum)
 *   genai          TMS token + GPT çağrıları
 *   mcp-istemci    bağlı MCP sunucularına giden çağrılar
 *   mcp-sunucu     /mcp'ye gelen çağrılar (hangi istemci, hangi araç)
 *   ajan           ajanın her araç adımı
 *   ajanlar-arasi  UnixAI ⇄ MorpheusAI ajan konuşmaları
 *
 *  .env: LOG_DIR (varsayılan ./logs; AI_LOG_DIR da kabul edilir), LOG_RETENTION_DAYS (varsayılan 90), LOG_FILE=false (dosyaya yazma)
 *  Parola/token/secret değerleri yazılmaz (http çağrılarında lib/logger maskeler).
 */
const fs = require("fs");
const path = require("path");

const LOG_DIR = process.env.LOG_DIR || process.env.AI_LOG_DIR || path.join(__dirname, "..", "logs");
const TO_FILE = !/^(0|false|no|off)$/i.test(process.env.LOG_FILE || process.env.AI_LOG_FILE || "true");
const RETENTION = Number(process.env.LOG_RETENTION_DAYS || 90);

const CATEGORIES = {
  islem: "Kullanıcı / API işlemleri",
  giris: "Giriş denemeleri",
  duzeltme: "Düzeltme akışı (playbook → onay → Bitbucket → AAP)",
  bitbucket: "Bitbucket çağrıları",
  aap: "AAP çağrıları",
  genai: "GenAI (TMS + GPT) çağrıları",
  "mcp-istemci": "Giden MCP çağrıları",
  "mcp-sunucu": "Gelen MCP çağrıları (/mcp)",
  ajan: "Ajan adımları",
  "ajanlar-arasi": "Ajanlar arası konuşmalar",
  canli: "Canlı akış (ajan trafiği, görev akışı)",
};
/** lib/http servis adı → log kategorisi */
const SERVICE_CATEGORY = { mcp: "mcp-istemci" };

const day = (iso) => (iso || new Date().toISOString()).slice(0, 10);
const safeCat = (c) => (CATEGORIES[c] ? c : /^[a-z][a-z0-9-]{1,30}$/.test(c || "") ? c : "diger");
const fileOf = (cat, date) => path.join(LOG_DIR, cat, `${cat}-${date}.jsonl`);

function append(cat, row) {
  if (!TO_FILE) return;
  try {
    fs.mkdirSync(path.join(LOG_DIR, cat), { recursive: true });
    fs.appendFileSync(fileOf(cat, day(row.time)), JSON.stringify(row) + "\n");
  } catch (e) { console.error(`[log] ${cat} yazılamadı: ${e.message}`); }
}

/** Hazır bir kaydı (ör. HTTP çağrısı) kategorinin dosyasına yazar */
function writeEntry(service, entry) {
  append(safeCat(SERVICE_CATEGORY[service] || service), entry);
}

/**
 * Olay kaydı
 * @param {string} cat     kategori (yukarıdaki liste)
 * @param {string} action  kısa açıklama ("Bitbucket'a commit edildi")
 * @param {object} fields  { user, ok, error, ...ayrıntı }
 */
function log(cat, action, fields = {}) {
  cat = safeCat(cat);
  const { user, ok = !fields.error, error, ...detail } = fields;
  const row = { time: new Date().toISOString(), category: cat, action: String(action).slice(0, 300), user: user || null, ok,
    error: error ? String(error.message || error).slice(0, 1000) : null, ...detail };
  append(cat, row);
  const brief = Object.entries(detail).filter(([, v]) => v != null && typeof v !== "object").slice(0, 5).map(([k, v]) => `${k}=${String(v).slice(0, 80)}`).join(" ");
  console.log(`[${cat}] ${row.action}${row.user ? ` · ${row.user}` : ""}${brief ? ` · ${brief}` : ""}${row.error ? ` · HATA: ${row.error}` : ""}`);
  return row;
}

/** Log dosyaları: [{category, label, files:[{date, size}]}] */
function files() {
  let dirs = [];
  try { dirs = fs.readdirSync(LOG_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
  const cats = [...new Set([...Object.keys(CATEGORIES), ...dirs])];
  return cats.map((c) => {
    let fl = [];
    try {
      fl = fs.readdirSync(path.join(LOG_DIR, c)).filter((f) => f.startsWith(`${c}-`) && f.endsWith(".jsonl"))
        .map((f) => ({ date: f.slice(c.length + 1, -6), size: fs.statSync(path.join(LOG_DIR, c, f)).size }))
        .sort((a, b) => (a.date < b.date ? 1 : -1));
    } catch {}
    return { category: c, label: CATEGORIES[c] || c, dir: path.join(LOG_DIR, c), files: fl };
  });
}

/** Bir kategorinin bir günlük dosyasını okur (en yeni önce) */
function read(cat, date = day(), { q, failed, limit = 500 } = {}) {
  cat = safeCat(cat);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Object.assign(new Error("Geçersiz tarih"), { status: 400 });
  let lines = [];
  try { lines = fs.readFileSync(fileOf(cat, date), "utf8").split("\n").filter(Boolean); } catch {}
  const needle = String(q || "").toLowerCase();
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < Math.min(Number(limit) || 500, 2000); i--) {
    if (needle && !lines[i].toLowerCase().includes(needle)) continue;
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    if (failed && row.ok !== false) continue;
    out.push(row);
  }
  return { category: cat, date, total: lines.length, file: fileOf(cat, date), items: out };
}

/** LOG_RETENTION_DAYS'ten eski dosyaları siler */
function cleanup() {
  if (!TO_FILE || !(RETENTION > 0)) return;
  const limit = new Date(Date.now() - RETENTION * 86400000).toISOString().slice(0, 10);
  for (const c of files()) for (const f of c.files) if (f.date < limit) try { fs.unlinkSync(fileOf(c.category, f.date)); } catch {}
}
cleanup();
setInterval(cleanup, 12 * 3600 * 1000).unref();

module.exports = { log, writeEntry, files, read, CATEGORIES, LOG_DIR };
