/*
 * Canlı akış: ajanlar arası trafik anlık olarak arayüze iletilir (Server-Sent Events, GET /api/live)
 *
 *  Olay türleri (her olayda id, type, time):
 *    mcp    MCP çağrısı            dir=gelen|giden, peer, method, tool, args (kısa), phase=start|end, ok, durationMs, error, rid
 *    http   uygulamalar arası REST  dir=gelen|giden, peer, method, path, status, ok, durationMs
 *    a2a    ajana soru             dir=gelen|giden, peer, question, server, phase=start|end, answer (kısa), remediations, ok, rid
 *    step   ajanın araç adımı      conversation, tool, where, phase=start|end, ok, durationMs, hop, origin, rid
 *
 *  Bellekte son 300 olay; yeni bağlanan istemci son 40 olayı (veya Last-Event-ID'den sonrasını) alır.
 *  Olaylar logs/canli/ dosyasına da yazılır (GET durum sorguları hariç); servis yeniden başlayınca son olaylar oradan yüklenir.
 *  Parola/token gönderilmez; argümanlar logger maskesiyle kısaltılır.
 */
const crypto = require("crypto");

const MAX_SUBSCRIBERS = 50;
const buf = [];
const subs = new Set();
let seq = 0;

const rid = () => crypto.randomBytes(6).toString("hex");
function short(v, n = 220) {
  if (v == null) return undefined;
  const s = (typeof v === "string" ? v : JSON.stringify(v)).replace(/\s+/g, " ").trim();
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
function argsPreview(args) {
  if (!args || typeof args !== "object" || !Object.keys(args).length) return undefined;
  const { context, ...clean } = args;
  return short(JSON.stringify(require("./logger").maskBody(JSON.stringify(clean))), 180);
}

const frame = (ev) => `id: ${ev.id}\nevent: live\ndata: ${JSON.stringify(ev)}\n\n`;

function publish(type, data = {}) {
  const ev = { id: ++seq, type, time: new Date().toISOString() };
  for (const [k, v] of Object.entries(data)) if (v !== undefined && v !== null && k !== "id" && k !== "type") ev[k] = v; // sıra numarası ezilmesin
  buf.push(ev);
  if (buf.length > 300) buf.shift();
  if (!(type === "http" && data.method === "GET")) require("./oplog").writeEntry("canli", { ...ev, category: "canli" });
  for (const res of subs) { if (!res._filter || res._filter(ev)) { try { res.write(frame(ev)); } catch {} } }
  return ev;
}

/**
 * GET /api/live — bağlantı açık kaldıkça olaylar akar
 * GET /api/remediations/events — yalnızca düzeltme akışı (rem) olayları; UnixAI köprüsü kendi canlı paneline aktarır
 */
function handle(req, res, url, filter) {
  if (subs.size >= MAX_SUBSCRIBERS) { res.writeHead(503, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Çok fazla canlı izleyici" })); }
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write("retry: 3000\n\n");
  const last = Number(req.headers["last-event-id"] || url.searchParams.get("since") || 0);
  // geçmiş olaylar: arayüz yalnızca listeler, karakterler canlandırmaz
  const pool = filter ? buf.filter(filter) : buf;
  for (const ev of last ? pool.filter((e) => e.id > last) : pool.slice(-40)) res.write(frame({ ...ev, replay: true }));
  res._filter = filter || null;
  subs.add(res);
  const ka = setInterval(() => { try { res.write(": ka\n\n"); } catch {} }, 15000);
  const done = () => { clearInterval(ka); subs.delete(res); };
  req.on("close", done);
  res.on("error", done);
}

/** Servis yeniden başladığında son canlı olayları (bugün + dün) belleğe al */
(function preload() {
  try {
    const oplog = require("./oplog");
    const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    let rows = [];
    for (const d of [day(1), day(0)]) rows = rows.concat(oplog.read("canli", d, { limit: 300 }).items.reverse());
    for (const r of rows.slice(-300)) { delete r.category; buf.push({ ...r, id: ++seq }); }
  } catch (e) { console.error("[canlı] geçmiş yüklenemedi:", e.message); }
})();

module.exports = { publish, handle, rid, short, argsPreview };
