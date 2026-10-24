#!/usr/bin/env node
/*
 * MorpheusAI MCP — stdio aktarıcısı (bağımlılıksız)
 *
 * MorpheusAI MCP sunucusunu kendisi barındırır: POST {MORPHEUS_URL}/mcp (Streamable HTTP). HTTP destekleyen istemciler
 * (Claude Code, UnixAI ajanı, diğer ajanlar) doğrudan bu adrese bağlanır. Yalnızca stdio destekleyen istemciler için bu betik
 * stdin'deki JSON-RPC mesajlarını /mcp'ye aktarır; araç listesi her zaman sunucuyla aynıdır.
 *
 *   MORPHEUS_URL        http://morpheus.kurum.local:3000
 *   MORPHEUS_API_TOKEN  MorpheusAI → Ajan & MCP'de üretilen MCP token'ı (veya .env MORPHEUS_API_TOKEN)
 *   MORPHEUS_TLS_INSECURE=true
 */
const URL_ = (process.env.MORPHEUS_URL || "http://127.0.0.1:3000").replace(/\/$/, "") + "/mcp";
const TOKEN = process.env.MORPHEUS_API_TOKEN || "";
if (/^(1|true|yes)$/i.test(process.env.MORPHEUS_TLS_INSECURE || "")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
let session = null;
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");

async function forward(msg) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-morpheus-client": "stdio",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}), ...(session ? { "mcp-session-id": session } : {}) },
    body: JSON.stringify(msg),
    signal: AbortSignal.timeout(Number(process.env.MORPHEUS_TIMEOUT_MS || 600000)),
  });
  session = res.headers.get("mcp-session-id") || session;
  const text = await res.text();
  if (!text.trim()) return null;
  try { return JSON.parse(text); }
  catch { return { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: `MorpheusAI geçersiz yanıt (${res.status}): ${text.slice(0, 200)}` } }; }
}

let buf = "";
let chain = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
    chain = chain.then(async () => {
      try {
        const r = await forward(msg);
        if (r && msg.id !== undefined) out(r);
      } catch (e) {
        if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: `MorpheusAI'ye ulaşılamadı: ${e.message}` } });
      }
    });
  }
});
process.stdin.on("end", () => chain.then(() => process.exit(0)));
process.stderr.write(`[morpheus-mcp] aktarıcı hazır → ${URL_}${TOKEN ? "" : " (MORPHEUS_API_TOKEN tanımlı değil)"}\n`);
