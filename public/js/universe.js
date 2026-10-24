/*
 * Konuşma Evreni — ajanlar arası konuşmaların yaşadığı dünyalar
 *
 *   Evren seçilebilir (sahnedeki açılır liste, tarayıcıda hatırlanır):
 *     matrix   Matrix ⇄ Linux: Tux'un buzul veri merkezi, MCP otoyolu, Nebuchadnezzar
 *     office   Garanti BBVA ofisi: sistem odası, Linux ekibi, kahve köşesi, otomasyon ekibi, toplantı odası / NOC
 *
 *   Ortak motor: karakterler yürür, oturur, düşünür, konuşur; kamera takip eder. Bir konuşma seçilince evrenin
 *   kendi senaryosu film olarak oynar ve ayrıntı panelindeki mesajlar adım adım açılır. Boştayken karakterler kendi
 *   işlerini yapar. Konum düğmeleri, sürükleme ve Ctrl+tekerlek ile gezilir.
 *
 *   Bağımlılık yok; MorpheusAI ve UnixAI OS'ta aynı dosya. "Efektler" anahtarı / prefers-reduced-motion hareketi kapatır.
 */
(function () {
  "use strict";

  const WH = 460, GROUND = 392;
  const GREEN = "#00ff66", CYAN = "#3df5ff", RED = "#ff2d55", AMBER = "#ffb000", ICE = "#bfe9ff";
  const GLYPHS = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン0123456789Z:=*+-<>|";
  const DEFAULT_SERVERS = ["rhel-db01", "rhel-web01", "rhel-app01"];

  const prefersReduced = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const kindOf = (name) => (/morpheus/i.test(name || "") ? "morpheus" : "unixai");
  const other = (k) => (k === "unixai" ? "morpheus" : "unixai");
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const hash = (n) => { n = Math.sin(n * 127.1) * 43758.5453; return n - Math.floor(n); };
  const CANCEL = Symbol("iptal");

  /* ================================================================== */
  /*  Ortak durum                                                       */
  /* ================================================================== */
  const U = {
    stage: null, cv: null, ctx: null, w: 0, h: 0, dpr: 1, t: 0, last: 0, running: false, effects: true,
    selfKind: "unixai", world: null, servers: [], alerts: {}, mission: null, playToken: 0, scripted: false, lastPlay: null,
    statusEl: null, chapterEl: null, statsEl: null, skip: null,
    cam: { x: 400, z: 1, tx: 400, tz: 1, follow: null, manualUntil: 0 },
    orb: null, sparks: [], codeBits: [], items: [], drag: null, fx: {}, C: {},
  };
  const serverList = () => (U.servers.length ? U.servers.slice(0, 5) : DEFAULT_SERVERS);

  /* ---------------- çizim yardımcıları ---------------- */
  const glow = (ctx, color, blur) => { ctx.shadowColor = color; ctx.shadowBlur = blur; };
  const noGlow = (ctx) => { ctx.shadowBlur = 0; };
  function rrect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function text(ctx, s, x, y, font, color, align = "center") { ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.fillText(s, x, y); }
  function line(ctx, x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
  function pill(ctx, x, y, color, rot = 0, s = 1) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s);
    glow(ctx, color, 12); ctx.fillStyle = color; rrect(ctx, -8, -3.5, 16, 7, 3.5); ctx.fill(); noGlow(ctx);
    ctx.fillStyle = "rgba(255,255,255,0.55)"; ctx.fillRect(-5, -2, 5, 1.5);
    ctx.restore();
  }
  function drawScroll(ctx, x, y, score) {
    glow(ctx, AMBER, 14); ctx.fillStyle = "#f1e2b8"; ctx.fillRect(x - 13, y - 9, 26, 18); noGlow(ctx);
    ctx.fillStyle = "#c9b27a"; ctx.fillRect(x - 15, y - 10, 4, 20); ctx.fillRect(x + 11, y - 10, 4, 20);
    ctx.fillStyle = "#6b5520"; for (let i = 0; i < 3; i++) ctx.fillRect(x - 8, y - 5 + i * 4, 14 - i * 3, 1.5);
    if (score != null) text(ctx, `uyum ${score}`, x, y - 14, "700 9px 'Red Hat Mono', monospace", GREEN);
  }
  function drawPaper(ctx, x, y, score) {
    ctx.fillStyle = "#ffffff"; ctx.strokeStyle = "#9aa6b2"; ctx.lineWidth = 1;
    ctx.fillRect(x - 10, y - 13, 20, 26); ctx.strokeRect(x - 10, y - 13, 20, 26);
    ctx.fillStyle = "#4a5a6a"; for (let i = 0; i < 5; i++) ctx.fillRect(x - 7, y - 9 + i * 4, 14 - (i % 2) * 4, 1.4);
    if (score != null) { ctx.fillStyle = "#2dcc70"; ctx.fillRect(x - 7, y + 8, 14, 3); }
  }
  function drawEnvelope(ctx, x, y) {
    glow(ctx, CYAN, 10); ctx.fillStyle = "#e9f6ff"; ctx.fillRect(x - 11, y - 7, 22, 14); noGlow(ctx);
    ctx.strokeStyle = "#5a8aa8"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x - 11, y - 7); ctx.lineTo(x, y + 1); ctx.lineTo(x + 11, y - 7); ctx.stroke();
  }
  function sign(ctx, x, y, title, sub, color, bg = "rgba(2,14,20,0.92)", fg = "#e6ffee", post = true) {
    ctx.font = "8.5px 'Red Hat Mono', monospace";
    const w = Math.max(110, ctx.measureText(sub).width + 18);
    if (post) { ctx.fillStyle = "#3b2b1c"; ctx.fillRect(x + w / 2 - 2, y + 36, 5, GROUND - y - 36); }
    ctx.fillStyle = bg; rrect(ctx, x, y, w, 38, 5); ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 1.2; glow(ctx, color, 10); ctx.stroke(); noGlow(ctx);
    text(ctx, title, x + w / 2, y + 16, "700 11px 'Red Hat Display', sans-serif", fg);
    text(ctx, sub, x + w / 2, y + 29, "8.5px 'Red Hat Mono', monospace", color);
  }
  function burstCode(x, top, n = 26) {
    if (!U.effects) return;
    for (let i = 0; i < n; i++) U.codeBits.push({ x: x + rnd(-22, 22), y: GROUND - rnd(0, top), vx: rnd(-10, 10), vy: rnd(-70, -20), life: rnd(0.6, 1.3), ch: pick(GLYPHS) });
  }
  function burstSparks(x, y, n = 14, color = AMBER) {
    if (!U.effects) return;
    for (let i = 0; i < n; i++) U.sparks.push({ x, y, vx: rnd(-90, 90), vy: rnd(-160, -40), g: 380, life: rnd(0.4, 0.9), c: color });
  }

  /* ================================================================== */
  /*  EVREN 1 — Matrix ⇄ Linux                                          */
  /* ================================================================== */
  const MATRIX = (() => {
    const WW = 2600, GATE_L = 905, GATE_R = 1715;
    const SPOT = { kiosk: 235, igloo: 105, phone: 1795, console: 1935, chair: 2090, forge: 2275, vault: 2445 };
    const HOME = { unixai: "Tux'un evi · Linux veri merkezi", morpheus: "Nebuchadnezzar · Morpheus'un gemisi" };
    const STARS = Array.from({ length: 90 }, (_, i) => ({ x: hash(i) * 1200 - 200, y: hash(i + 99) * 230 - 20, r: hash(i + 7) * 1.4 + 0.3 }));
    const SNOW = Array.from({ length: 130 }, (_, i) => ({ x: hash(i + 300) * 1060 - 120, y: hash(i + 500) * 470, s: 18 + hash(i + 700) * 30, w: hash(i + 900) * 6.28 }));
    const CITY = Array.from({ length: 34 }, (_, i) => ({ x: 760 + i * 34 + hash(i + 40) * 12, w: 22 + hash(i + 60) * 18, h: 90 + hash(i + 80) * 210 }));
    const RAIN = Array.from({ length: 42 }, (_, i) => ({ x: 930 + i * 19, sp: 60 + hash(i + 11) * 90, off: hash(i + 33) * 400 }));
    const CARS = Array.from({ length: 9 }, (_, i) => ({ p: hash(i + 120), sp: 0.05 + hash(i + 140) * 0.08, dir: i % 2 ? -1 : 1, c: i % 3 ? GREEN : CYAN }));
    const rackX = (name) => 400 + Math.max(0, serverList().indexOf(name)) * 96;

    const W = {
      id: "matrix", label: "Matrix ⇄ Linux evreni", width: WW, bg: "#010604", parallax: 0.45, dark: true,
      subtitle: "Tux'un buzul veri merkezi ⇄ MCP otoyolu ⇄ Nebuchadnezzar",
      prompts: { unixai: "root@unixai:~#", morpheus: "morpheus@nebuchadnezzar:~$" },
      colors: { unixai: CYAN, morpheus: GREEN },
      bubble: { bg: "rgba(2,14,8,0.95)", fg: "#e6ffee" },
      places: [
        { id: "tux", label: "🐧 Tux'un evi", x: 420, z: 1 },
        { id: "road", label: "⚡ MCP otoyolu", x: 1310, z: 0.9 },
        { id: "ship", label: "🚀 Morpheus'un gemisi", x: 2150, z: 1 },
        { id: "mission", label: "🎯 Görev yeri", mission: true, z: 1.25 },
        { id: "all", label: "🌍 Tüm evren", x: WW / 2, z: 0.42 },
      ],
      home: (self) => (self === "unixai" ? 470 : 2120),
      rackX,
      makeChars() {
        return {
          unixai: { kind: "unixai", x: SPOT.kiosk, dir: -1, speed: 230, action: "type", label: "UnixAI ajanı" },
          morpheus: { kind: "morpheus", x: SPOT.chair, dir: -1, speed: 260, action: "sit", label: "MorpheusAI ajanı" },
        };
      },
      headY: (c) => (c.kind === "unixai" ? -96 : c.action === "sit" ? -140 : -176),
      labelY: (c) => (c.kind === "unixai" ? -88 : c.action === "sit" ? -128 : -164),
      drawFar(ctx) {
        for (const b of CITY) {
          ctx.fillStyle = "#03110a"; ctx.fillRect(b.x, GROUND - 40 - b.h, b.w, b.h + 40);
          ctx.fillStyle = "rgba(0,255,102,0.22)";
          for (let wy = GROUND - 30 - b.h; wy < GROUND - 50; wy += 11)
            for (let wx = b.x + 4; wx < b.x + b.w - 4; wx += 7)
              if (hash(wx * 3 + wy + Math.floor(U.t / 2500)) > 0.62) ctx.fillRect(wx, wy, 3, 5);
        }
      },
      draw(ctx) { tuxRegion(ctx); highway(ctx); ship(ctx); },
      drawFront(ctx) {
        ctx.fillStyle = "rgba(230,247,255,0.8)";
        for (const f of SNOW) {
          const y = ((f.y + (U.t / 1000) * f.s) % 470) - 60, x = f.x + Math.sin(U.t / 1000 + f.w) * 8;
          if (x < 930) ctx.fillRect(x, y, 1.8, 1.8);
        }
      },
      drawChar(ctx, c) { if (c.kind === "unixai") drawTux(ctx, c); else drawMorpheus(ctx, c); },
      idle(c) {
        if (c.kind === "unixai") {
          const spots = [SPOT.kiosk, SPOT.igloo + 75, ...serverList().map((s) => rackX(s) - 40)];
          const x = pick(spots);
          return { x, then: () => ({ action: x === SPOT.kiosk ? "type" : x === SPOT.igloo + 75 ? "wave" : "inspect", dir: x === SPOT.kiosk ? -1 : 1 }) };
        }
        const r = Math.random(), x = r < 0.4 ? SPOT.chair : r < 0.75 ? SPOT.console + 10 : rnd(2140, 2380);
        return { x, then: () => ({ action: x === SPOT.chair ? "sit" : x === SPOT.console + 10 ? "type" : null, dir: -1 }) };
      },
      reset() {
        Object.assign(U.C.unixai, { x: SPOT.kiosk, dir: -1, action: "type" });
        Object.assign(U.C.morpheus, { x: SPOT.chair, dir: -1, action: "sit" });
      },
      finalPose(S) {
        if (S.mission) {
          Object.assign(U.C.unixai, { x: rackX(S.server) - 46, dir: 1, action: null });
          Object.assign(U.C.morpheus, { x: rackX(S.server) + 54, dir: -1, action: null, carry: "pill" });
          return rackX(S.server);
        }
        return S.askerK === "unixai" ? 470 : 2120;
      },
      async script(d, S) {
        const { A, B, askerK, answerK, rems, server } = S, P = W.prompts;
        /** Kapıdan ışınlanma: karakterler koda dönüşüp otoyolda akar, diğer kapıdan çıkar */
        const travel = async (chars, toKind, label) => {
          const fromGate = chars[0].x < 1300 ? GATE_L : GATE_R, toGate = toKind === "unixai" ? GATE_L : GATE_R;
          if (fromGate === toGate) return;
          const inward = fromGate === GATE_L ? -1 : 1;
          await Promise.all(chars.map((c, i) => d.walk(c, fromGate + inward * i * 30)));
          chars.forEach((c) => { c.fade = -1; burstCode(c.x, c.kind === "morpheus" ? 150 : 80); });
          await d.wait(550);
          await d.orb(fromGate, toGate, chars[0].kind === "unixai" ? CYAN : GREEN, label);
          U.fx.phoneRing = false;
          const out = toGate === GATE_L ? -1 : 1;
          chars.forEach((c, i) => { c.x = toGate + out * (14 + i * 36); c.dir = out; c.fade = 1; burstCode(c.x, 120); });
          d.follow(chars[0], 1.1);
          await d.wait(650);
        };
        d.follow(A, 1.15, askerK === "unixai" ? 90 : -60);
        d.chapter(`Bölüm 1 · ${HOME[askerK]}`);
        if (askerK === "unixai") {
          d.status(`${P.unixai} ${server ? `ssh ${server} — bulgu inceleniyor` : "filo inceleniyor"}`);
          if (server) { await d.walk(A, rackX(server) - 42); A.dir = 1; A.action = "inspect"; await d.wait(2000); }
          else { A.action = "type"; await d.wait(1400); }
          A.action = null;
          await d.say(A, server ? `${server}'de bir sorun var. MorpheusAI'ye gidip soralım!` : "MorpheusAI'ye gidip soralım!", 2400);
        } else {
          d.status(`${P.morpheus} operatör konsolunda — UnixAI'ye soru hazırlanıyor`);
          await d.walk(A, SPOT.console + 10); A.dir = -1; A.action = "type"; await d.wait(1600); A.action = null;
          await d.say(A, "Tux'a soralım. Çıkış telefonuna!", 2000);
          await d.walk(A, SPOT.phone + 24); A.dir = -1; U.fx.phoneRing = true; await d.wait(900);
        }
        A.carry = "mail";
        d.status(`${P[askerK]} mcp tools/call ${askerK === "unixai" ? "morpheus_agent_ask" : "unixai_agent_ask"}${server ? ` --server ${server}` : ""}`);
        d.chapter("MCP otoyolu");
        await travel([A], answerK, `${askerK} → ${answerK} · tools/call`);
        d.chapter(`Bölüm 2 · ${HOME[answerK]}`);
        if (answerK === "morpheus") { d.follow(A, 1.15, 90); await d.walk(A, SPOT.chair - 110); A.dir = 1; B.action = null; B.dir = -1; }
        else { d.follow(A, 1.15, -90); B.action = null; await d.walk(A, SPOT.kiosk + 80); A.dir = -1; B.dir = 1; }
        A.carry = null;
        S.revealQuestion();
        await d.say(A, S.q);
        d.follow(B, 1.2);
        d.status(`${P[answerK]} düşünüyor… ${S.tools.join(", ") || "araç yok"}`);
        await d.think(B, S.tools, clamp(S.tools.length * 1000, 2000, 3800));
        if (answerK === "unixai" && server) {
          await d.walk(B, rackX(server) - 42); B.dir = 1; B.action = "inspect"; await d.wait(1800); B.action = null;
          await d.walk(B, SPOT.kiosk + 150); B.dir = -1;
        }
        if (rems.length && answerK === "morpheus") {
          d.chapter("Bölüm 3 · Ansible örsünde playbook");
          d.status(`${P.morpheus} morpheus_create_remediation — playbook dövülüyor, standart analizi yapılıyor`);
          d.follow(B, 1.3);
          await d.walk(B, SPOT.forge - 50); B.dir = 1; B.action = "forge"; U.fx.forgeHot = true;
          for (let i = 0; i < 7; i++) { await d.wait(320); burstSparks(SPOT.forge - 8, GROUND - 52); }
          B.action = null; U.fx.forgeHot = false;
          U.items = [{ kind: "scroll", x: SPOT.forge - 14, y: GROUND - 74, score: rems[0].score }];
          d.status(`${P.morpheus} playbook hazır · uyum ${rems[0].score ?? "?"} · ${rems[0].id || ""}`);
          await d.wait(900);
          U.items = []; B.carry = "scroll";
          await d.walk(B, SPOT.chair - 20); B.dir = -1;
        }
        S.revealAnswer();
        d.follow(B, 1.15, answerK === "morpheus" ? -60 : 60);
        d.status(`${P[answerK]} cevap veriyor`);
        await d.say(B, S.ans || "…");
        if (S.mission) {
          d.chapter(`Bölüm 4 · Görev: ${server}`);
          d.status(`${P.morpheus} görev yerine gidiliyor — ${server} rack'i (Tux'un veri merkezi)`);
          const mor = U.C.morpheus, tux = U.C.unixai;
          if (mor.x > 1300) await travel(tux.x > 1300 ? [mor, tux] : [mor], "unixai", `görev → ${server}`);
          d.follow({ x: rackX(server) }, 1.25);
          await Promise.all([d.walk(tux, rackX(server) - 46), d.walk(mor, rackX(server) + 54)]);
          tux.dir = 1; mor.dir = -1;
          U.alerts[server] = "pending"; mor.carry = "pill";
          S.revealCards();
          d.status(`${P.morpheus} playbook hazır — kırmızı hap sizde: onaylarsanız Bitbucket → AAP → check`);
          await d.say(mor, `Playbook hazır (uyum ${rems[0].score ?? "?"}). Kırmızı hapı alırsan AAP'de çalıştırırız. Onayını bekliyorum.`, 4600);
          await d.say(tux, `Ben ${server}'in başında bekliyorum. 🐧`, 2400);
          d.follow({ x: rackX(server) }, 1);
        } else {
          S.revealCards();
          A.carry = null;
          await travel([A], askerK, "eve dönüş");
          await d.walk(A, askerK === "unixai" ? SPOT.kiosk : SPOT.chair);
          A.action = askerK === "unixai" ? "type" : "sit"; A.dir = -1;
          d.follow({ x: A.x }, 1);
        }
      },
    };

    function tuxRegion(ctx) {
      const sky = ctx.createLinearGradient(0, -200, 0, GROUND);
      sky.addColorStop(0, "#01030d"); sky.addColorStop(1, "#06243a");
      ctx.fillStyle = sky; ctx.fillRect(-400, -400, 1330, GROUND + 400);
      for (const s of STARS) { ctx.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin(U.t / 900 + s.x)); ctx.fillStyle = "#e6f7ff"; ctx.fillRect(s.x, s.y, s.r, s.r); }
      ctx.globalAlpha = 1;
      for (let k = 0; k < 3; k++) {
        ctx.beginPath();
        for (let x = -300; x <= 1000; x += 20) {
          const y = 40 + k * 28 + Math.sin(x / 140 + U.t / 1800 + k) * 22 + Math.sin(x / 57 + U.t / 1100) * 8;
          x === -300 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = k === 1 ? "rgba(61,245,255,0.16)" : "rgba(0,255,102,0.14)";
        ctx.lineWidth = 26 - k * 6; glow(ctx, k === 1 ? CYAN : GREEN, 30); ctx.stroke();
      }
      noGlow(ctx);
      ctx.fillStyle = "#0f3550";
      ctx.beginPath(); ctx.moveTo(-300, GROUND); ctx.lineTo(-120, GROUND - 160); ctx.lineTo(10, GROUND - 90); ctx.lineTo(140, GROUND - 190); ctx.lineTo(300, GROUND - 70);
      ctx.lineTo(520, GROUND - 140); ctx.lineTo(700, GROUND - 60); ctx.lineTo(860, GROUND - 120); ctx.lineTo(980, GROUND); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "rgba(191,233,255,0.35)"; ctx.lineWidth = 1.5; ctx.stroke();
      const gr = ctx.createLinearGradient(0, GROUND, 0, GROUND + 120);
      gr.addColorStop(0, "#2a6688"); gr.addColorStop(1, "#06182a");
      ctx.fillStyle = gr; ctx.fillRect(-400, GROUND, 1360, 260);
      ctx.strokeStyle = ICE; ctx.lineWidth = 2; line(ctx, -400, GROUND, 960, GROUND);
      const ix = SPOT.igloo;
      ctx.fillStyle = "#d8f1ff"; ctx.beginPath(); ctx.arc(ix, GROUND, 62, Math.PI, 0); ctx.fill();
      ctx.strokeStyle = "rgba(40,90,120,0.45)"; ctx.lineWidth = 1.2;
      for (const r of [22, 42]) { ctx.beginPath(); ctx.arc(ix, GROUND, r, Math.PI, 0); ctx.stroke(); }
      for (let a = 0; a < 6; a++) { const an = Math.PI + (a + 0.5) * (Math.PI / 6); line(ctx, ix + Math.cos(an) * 22, GROUND + Math.sin(an) * 22, ix + Math.cos(an) * 62, GROUND + Math.sin(an) * 62); }
      ctx.fillStyle = "#0a1a26"; ctx.beginPath(); ctx.arc(ix + 30, GROUND, 20, Math.PI, 0); ctx.fill();
      ctx.fillStyle = "rgba(255,176,0,0.35)"; ctx.beginPath(); ctx.arc(ix + 30, GROUND, 14, Math.PI, 0); ctx.fill();
      sign(ctx, 4, GROUND - 130, "Tux'un evi", "Linux veri merkezi · /srv", CYAN);
      const kx = SPOT.kiosk - 46;
      ctx.fillStyle = "#1b2b36"; ctx.fillRect(kx - 3, GROUND - 42, 6, 42);
      ctx.fillStyle = "#050b0f"; rrect(ctx, kx - 34, GROUND - 100, 68, 58, 5); ctx.fill();
      ctx.strokeStyle = CYAN; ctx.lineWidth = 1.5; glow(ctx, CYAN, 8); ctx.stroke(); noGlow(ctx);
      const lines = ["$ uptime", "load 0.42", "$ df -h /u01", "96% /u01 !", "$ journalctl", "-p err ...", "$ vgs", "vg_data 2T"];
      const off = Math.floor(U.t / 700) % lines.length;
      ctx.font = "7px 'Red Hat Mono', monospace"; ctx.textAlign = "left";
      for (let i = 0; i < 6; i++) { const l = lines[(off + i) % lines.length]; ctx.fillStyle = /!/.test(l) ? AMBER : "rgba(0,255,102,0.85)"; ctx.fillText(l, kx - 29, GROUND - 88 + i * 8); }
      const list = serverList();
      ctx.fillStyle = "rgba(191,233,255,0.08)"; ctx.fillRect(rackX(list[0]) - 60, GROUND - 4, list.length * 96 + 30, 6);
      list.forEach((name) => drawRack(ctx, rackX(name), name, false));
    }

    function highway(ctx) {
      ctx.font = "13px 'Red Hat Mono', monospace"; ctx.textAlign = "center";
      for (const col of RAIN) {
        const head = ((U.t / 1000) * col.sp + col.off) % 420 - 60;
        for (let k = 0; k < 12; k++) {
          const y = head - k * 15;
          if (y < -80 || y > GROUND - 70) continue;
          ctx.fillStyle = k === 0 ? "rgba(214,255,228,0.9)" : `rgba(0,255,102,${0.5 - k * 0.04})`;
          ctx.fillText(GLYPHS[(hash(col.x + k + Math.floor(U.t / 140)) * GLYPHS.length) | 0], col.x, y);
        }
      }
      const y = GROUND;
      ctx.fillStyle = "#020a06"; ctx.fillRect(GATE_L - 30, y, GATE_R - GATE_L + 60, 260);
      ctx.strokeStyle = GREEN; ctx.lineWidth = 2; glow(ctx, GREEN, 12); line(ctx, GATE_L - 30, y, GATE_R + 30, y);
      ctx.lineWidth = 1; ctx.strokeStyle = "rgba(0,255,102,0.4)"; line(ctx, GATE_L - 30, y + 14, GATE_R + 30, y + 14);
      noGlow(ctx);
      ctx.strokeStyle = "rgba(0,255,102,0.35)"; ctx.lineWidth = 1.2;
      for (const px of [1110, 1310, 1510]) {
        ctx.fillStyle = "#04140b"; ctx.fillRect(px - 5, y - 170, 10, 170);
        for (const dd of [-1, 1]) { ctx.beginPath(); ctx.moveTo(px, y - 165); ctx.quadraticCurveTo(px + dd * 50, y - 70, px + dd * 100, y); ctx.stroke(); }
        glow(ctx, RED, 10); ctx.fillStyle = Math.floor(U.t / 600) % 2 ? RED : "#400"; ctx.fillRect(px - 2, y - 176, 4, 4); noGlow(ctx);
      }
      for (const car of CARS) {
        const p = ((car.p + (U.t / 1000) * car.sp * car.dir) % 1 + 1) % 1;
        const x = GATE_L + 40 + p * (GATE_R - GATE_L - 80);
        glow(ctx, car.c, 12); ctx.fillStyle = car.c; ctx.fillRect(x - 12, y - 8, 24, 5);
        ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.fillRect(car.dir > 0 ? x + 9 : x - 12, y - 8, 3, 5); noGlow(ctx);
        ctx.fillStyle = car.c === GREEN ? "rgba(0,255,102,0.12)" : "rgba(61,245,255,0.12)";
        ctx.fillRect(car.dir > 0 ? x - 52 : x + 12, y - 7, 40, 3);
      }
      text(ctx, "MCP OTOYOLU · POST /mcp · JSON-RPC", (GATE_L + GATE_R) / 2, y + 34, "600 11px 'Red Hat Mono', monospace", "rgba(184,245,200,0.7)");
      gate(ctx, GATE_L, CYAN, "unixai /mcp");
      gate(ctx, GATE_R, GREEN, "morpheus /mcp");
    }

    function gate(ctx, x, color, sub) {
      ctx.strokeStyle = color; ctx.lineWidth = 6; glow(ctx, color, 18);
      ctx.beginPath(); ctx.moveTo(x - 38, GROUND); ctx.lineTo(x - 38, GROUND - 120); ctx.arc(x, GROUND - 120, 38, Math.PI, 0); ctx.lineTo(x + 38, GROUND); ctx.stroke();
      noGlow(ctx);
      ctx.save(); ctx.beginPath(); ctx.moveTo(x - 34, GROUND); ctx.lineTo(x - 34, GROUND - 120); ctx.arc(x, GROUND - 120, 34, Math.PI, 0); ctx.lineTo(x + 34, GROUND); ctx.closePath(); ctx.clip();
      const g = ctx.createRadialGradient(x, GROUND - 80, 4, x, GROUND - 80, 90);
      g.addColorStop(0, color === CYAN ? "rgba(61,245,255,0.55)" : "rgba(0,255,102,0.55)"); g.addColorStop(1, "rgba(0,0,0,0.9)");
      ctx.fillStyle = g; ctx.fillRect(x - 40, GROUND - 170, 80, 170);
      ctx.font = "10px 'Red Hat Mono', monospace"; ctx.textAlign = "center";
      for (let i = 0; i < 14; i++) {
        const a = U.t / 700 + i * 0.45, r = 8 + ((i * 9 + U.t / 30) % 34);
        ctx.fillStyle = `rgba(230,255,240,${0.8 - r / 50})`;
        ctx.fillText(GLYPHS[(i * 7 + Math.floor(U.t / 200)) % GLYPHS.length], x + Math.cos(a) * r, GROUND - 80 + Math.sin(a) * r * 1.6);
      }
      ctx.restore();
      text(ctx, "MCP KAPISI", x, GROUND - 170, "700 10px 'Red Hat Mono', monospace", color);
      text(ctx, `Bearer ✓ · ${sub}`, x, GROUND - 158, "8.5px 'Red Hat Mono', monospace", "rgba(184,245,200,0.75)");
    }

    function ship(ctx) {
      const x0 = 1740, x1 = 2900;
      const g = ctx.createLinearGradient(0, -100, 0, GROUND);
      g.addColorStop(0, "#020805"); g.addColorStop(1, "#0a1a12");
      ctx.fillStyle = g; ctx.fillRect(x0, -400, x1 - x0, GROUND + 400);
      const fade = ctx.createLinearGradient(x0 - 60, 0, x0 + 40, 0);
      fade.addColorStop(0, "rgba(10,26,18,0)"); fade.addColorStop(1, "rgba(10,26,18,1)");
      ctx.fillStyle = fade; ctx.fillRect(x0 - 60, -400, 100, GROUND + 400);
      ctx.strokeStyle = "rgba(120,160,130,0.12)"; ctx.lineWidth = 1;
      for (let x = x0 + 30; x < x1; x += 80) line(ctx, x, 20, x, GROUND);
      ctx.fillStyle = "rgba(150,190,160,0.25)";
      for (let x = x0 + 34; x < x1; x += 80) for (let y = 40; y < GROUND; y += 60) ctx.fillRect(x, y, 2, 2);
      ctx.strokeStyle = "#1d3326"; ctx.lineWidth = 12; line(ctx, x0, 30, x1, 30);
      ctx.strokeStyle = "#13261b"; ctx.lineWidth = 7; line(ctx, x0, 50, x1, 50);
      ctx.strokeStyle = "rgba(30,60,40,0.9)"; ctx.lineWidth = 2;
      for (let i = 0; i < 9; i++) { const cx = x0 + 60 + i * 95; ctx.beginPath(); ctx.moveTo(cx, 50); ctx.quadraticCurveTo(cx + 25, 110 + (i % 3) * 25 + Math.sin(U.t / 1500 + i) * 4, cx + 55, 50); ctx.stroke(); }
      ctx.fillStyle = "#07120c"; ctx.fillRect(x0, GROUND, x1 - x0, 260);
      ctx.strokeStyle = "rgba(0,255,102,0.18)"; ctx.lineWidth = 1;
      for (let x = x0; x < x1; x += 18) line(ctx, x, GROUND, x - 10, GROUND + 30);
      ctx.strokeStyle = "rgba(0,255,102,0.5)"; line(ctx, x0, GROUND, x1, GROUND);
      sign(ctx, 2110, GROUND - 235, "Nebuchadnezzar", "Morpheus'un gemisi · Zion", GREEN);
      phone(ctx, SPOT.phone); consoleDesk(ctx, SPOT.console); chair(ctx, SPOT.chair); forge(ctx, SPOT.forge); vault(ctx, SPOT.vault);
    }
    function phone(ctx, x) {
      ctx.fillStyle = "#1a1210"; ctx.fillRect(x - 18, GROUND - 60, 36, 60);
      ctx.fillStyle = "#2a1b16"; ctx.fillRect(x - 22, GROUND - 64, 44, 6);
      const ring = U.fx.phoneRing && U.t % 400 < 200;
      ctx.save(); ctx.translate(x + (ring ? Math.sin(U.t / 20) * 1.5 : 0), GROUND - 78);
      ctx.fillStyle = "#0d0d0d"; rrect(ctx, -16, 0, 32, 14, 4); ctx.fill();
      ctx.fillStyle = "#151515"; rrect(ctx, -20, -8, 40, 9, 4); ctx.fill();
      ctx.restore();
      if (ring) { ctx.strokeStyle = GREEN; ctx.lineWidth = 1.5; for (const r of [26, 34]) { ctx.beginPath(); ctx.arc(x, GROUND - 74, r, -2.4, -0.7); ctx.stroke(); } }
      text(ctx, "çıkış ☎", x, GROUND + 18, "9px 'Red Hat Mono', monospace", "rgba(184,245,200,0.75)");
    }
    function consoleDesk(ctx, x) {
      ctx.fillStyle = "#0c1a12"; ctx.fillRect(x - 70, GROUND - 46, 140, 46);
      ctx.fillStyle = "#16281d"; ctx.fillRect(x - 76, GROUND - 52, 152, 8);
      for (let m = 0; m < 3; m++) {
        const mx = x - 66 + m * 46, my = GROUND - 128 - (m === 1 ? 14 : 0);
        ctx.fillStyle = "#2f4a38"; ctx.fillRect(mx + 19, my + 34, 4, GROUND - 52 - my - 34);
        ctx.fillStyle = "#000"; rrect(ctx, mx, my, 42, 34, 3); ctx.fill();
        ctx.strokeStyle = "#2f4a38"; ctx.lineWidth = 2; ctx.stroke();
        rainBox(ctx, mx + 2, my + 2, 38, 30, m);
      }
      text(ctx, "operatör konsolu", x, GROUND + 18, "9px 'Red Hat Mono', monospace", "rgba(184,245,200,0.75)");
    }
    function chair(ctx, x) {
      ctx.fillStyle = "#3a1410"; rrect(ctx, x - 30, GROUND - 92, 60, 60, 12); ctx.fill();
      ctx.fillStyle = "#4d1a14";
      rrect(ctx, x - 38, GROUND - 52, 76, 24, 8); ctx.fill();
      rrect(ctx, x - 44, GROUND - 66, 14, 40, 6); ctx.fill();
      rrect(ctx, x + 30, GROUND - 66, 14, 40, 6); ctx.fill();
      ctx.fillStyle = "#1a0a08"; ctx.fillRect(x - 32, GROUND - 28, 6, 28); ctx.fillRect(x + 26, GROUND - 28, 6, 28);
      const tx = x + 74;
      ctx.fillStyle = "#16281d"; ctx.fillRect(tx - 18, GROUND - 40, 36, 5); ctx.fillRect(tx - 2, GROUND - 36, 4, 36);
      pill(ctx, tx - 7, GROUND - 46 + Math.sin(U.t / 500) * 1.5, RED, 0.2);
      pill(ctx, tx + 8, GROUND - 46 + Math.cos(U.t / 500) * 1.5, "#2d8cff", -0.2);
    }
    function forge(ctx, x) {
      const hot = U.fx.forgeHot ? 1 : 0.35 + 0.15 * Math.sin(U.t / 300);
      ctx.fillStyle = "#1b1410"; rrect(ctx, x + 22, GROUND - 120, 70, 120, 6); ctx.fill();
      const fg = ctx.createRadialGradient(x + 57, GROUND - 45, 3, x + 57, GROUND - 45, 34);
      fg.addColorStop(0, `rgba(255,220,120,${hot})`); fg.addColorStop(0.6, `rgba(255,90,20,${hot * 0.8})`); fg.addColorStop(1, "rgba(60,10,0,0.2)");
      ctx.fillStyle = fg; rrect(ctx, x + 32, GROUND - 76, 50, 48, 6); ctx.fill();
      text(ctx, "AAP", x + 57, GROUND - 92, "800 14px 'Red Hat Display', sans-serif", `rgba(255,176,0,${0.5 + hot / 2})`);
      ctx.fillStyle = "#3b4146";
      ctx.beginPath(); ctx.moveTo(x - 38, GROUND - 46); ctx.lineTo(x + 18, GROUND - 46); ctx.lineTo(x + 8, GROUND - 34); ctx.lineTo(x - 22, GROUND - 34);
      ctx.lineTo(x - 30, GROUND - 40); ctx.lineTo(x - 52, GROUND - 44); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#2a2f33"; ctx.fillRect(x - 14, GROUND - 34, 14, 22); ctx.fillRect(x - 24, GROUND - 12, 34, 12);
      text(ctx, "Ansible örsü", x - 10, GROUND + 18, "9px 'Red Hat Mono', monospace", "rgba(255,200,120,0.8)");
    }
    function vault(ctx, x) {
      ctx.fillStyle = "#0f1a26"; rrect(ctx, x - 40, GROUND - 110, 80, 110, 6); ctx.fill();
      ctx.strokeStyle = "#2d8cff"; ctx.lineWidth = 2; glow(ctx, "#2d8cff", 6); ctx.stroke(); noGlow(ctx);
      ctx.fillStyle = "#2d8cff";
      ctx.beginPath(); ctx.moveTo(x - 22, GROUND - 86); ctx.lineTo(x + 22, GROUND - 86); ctx.lineTo(x + 15, GROUND - 52); ctx.lineTo(x - 15, GROUND - 52); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#0f1a26"; ctx.beginPath(); ctx.moveTo(x - 6, GROUND - 76); ctx.lineTo(x + 6, GROUND - 76); ctx.lineTo(x + 4, GROUND - 62); ctx.lineTo(x - 4, GROUND - 62); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "#6fb2ff"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x + 26, GROUND - 40, 8, 0, Math.PI * 2); ctx.stroke();
      text(ctx, "Bitbucket kasası", x, GROUND + 18, "9px 'Red Hat Mono', monospace", "rgba(140,190,255,0.85)");
    }

    function drawTux(ctx, c) {
      const w = c.walking ? c.phase : 0;
      const bob = c.walking ? Math.abs(Math.sin(w)) * 3 : Math.sin(U.t / 600) * 0.8;
      ctx.scale(c.dir < 0 ? -1 : 1, 1);
      ctx.fillStyle = AMBER;
      ctx.beginPath(); ctx.ellipse(-9 + (c.walking ? Math.sin(w) * 6 : 0), -3, 10, 4.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(9 - (c.walking ? Math.sin(w) * 6 : 0), -3, 10, 4.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.translate(0, -bob);
      glow(ctx, "rgba(61,245,255,0.5)", 14);
      ctx.fillStyle = "#0b0f10";
      ctx.beginPath(); ctx.ellipse(0, -30, 22, 28, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0, -60, 15, 14, 0, 0, Math.PI * 2); ctx.fill();
      noGlow(ctx);
      ctx.fillStyle = "#f2f4ef"; ctx.beginPath(); ctx.ellipse(2, -26, 15, 21, 0, 0, Math.PI * 2); ctx.fill();
      const flap = c.action === "wave" ? Math.sin(U.t / 120) * 0.9 : c.walking ? Math.sin(w) * 0.35 : c.bubble ? Math.sin(U.t / 160) * 0.4 : 0.1;
      for (const s of [-1, 1]) {
        ctx.save(); ctx.translate(s * 19, -42); ctx.rotate(s * 0.35 + (s > 0 ? -flap : flap * 0.3));
        ctx.fillStyle = "#0b0f10"; ctx.beginPath(); ctx.ellipse(0, 12, 6, 16, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      }
      const blink = Math.sin(U.t / 1300) > 0.985 ? 0.15 : 1;
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.ellipse(-3, -63, 4, 5.5 * blink, 0, 0, Math.PI * 2); ctx.ellipse(7, -63, 4, 5.5 * blink, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#111";
      ctx.beginPath(); ctx.arc(-1, -62, 1.8 * blink, 0, Math.PI * 2); ctx.arc(9, -62, 1.8 * blink, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = AMBER;
      ctx.beginPath(); ctx.moveTo(-3, -55); ctx.quadraticCurveTo(4, -51, 13, -55); ctx.quadraticCurveTo(5, -47, -3, -55); ctx.fill();
      if (c.action === "inspect") {
        const sway = Math.sin(U.t / 400) * 4;
        ctx.fillStyle = "rgba(61,245,255,0.25)"; ctx.beginPath(); ctx.arc(28 + sway, -58, 7, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "#c9d6de"; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(28 + sway, -58, 8, 0, Math.PI * 2); ctx.stroke();
        line(ctx, 22 + sway, -51, 16 + sway, -43);
      }
      if (c.action === "type") { ctx.fillStyle = "rgba(61,245,255,0.8)"; for (let i = 0; i < 3; i++) if (Math.floor(U.t / 150 + i) % 2) ctx.fillRect(18 + i * 5, -40, 3, 2); }
      if (c.carry === "mail") drawEnvelope(ctx, 0, -92 + Math.sin(U.t / 250) * 2);
      if (c.carry === "scroll") drawScroll(ctx, 0, -94);
    }

    function drawMorpheus(ctx, c) {
      const w = c.walking ? c.phase : 0;
      ctx.scale(c.dir < 0 ? -1 : 1, 1);
      ctx.lineCap = "round";
      if (c.action === "sit") {
        ctx.translate(0, -26);
        ctx.strokeStyle = "#0c0c0c"; ctx.lineWidth = 7;
        ctx.beginPath(); ctx.moveTo(-6, -24); ctx.lineTo(16, -24); ctx.lineTo(18, 20); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(2, -24); ctx.lineTo(24, -22); ctx.lineTo(26, 20); ctx.stroke();
        coat(ctx, -64, -24, 0); head(ctx, -78, c);
        ctx.strokeStyle = "#0f1a14"; ctx.lineWidth = 6; line(ctx, -8, -56, 14, -36);
        return;
      }
      const swing = c.walking ? Math.sin(w) * 0.5 : 0;
      ctx.strokeStyle = "#0c0c0c"; ctx.lineWidth = 7;
      for (const s of [1, -1]) {
        const a = swing * s;
        ctx.beginPath(); ctx.moveTo(0, -62); ctx.lineTo(Math.sin(a) * 30, -62 + Math.cos(a) * 30); ctx.lineTo(Math.sin(a) * 32 + 4, -3); ctx.stroke();
        ctx.fillStyle = "#050505"; ctx.beginPath(); ctx.ellipse(Math.sin(a) * 32 + 9, -3, 9, 4, 0, 0, Math.PI * 2); ctx.fill();
      }
      coat(ctx, -112, -34, c.walking ? Math.sin(w) * 6 : Math.sin(U.t / 900) * 1.5);
      ctx.strokeStyle = "#0f1a14"; ctx.lineWidth = 7;
      const forging = c.action === "forge";
      const armA = forging ? -2.2 + Math.abs(Math.sin(U.t / 160)) * 2.0 : c.action === "type" ? -0.9 + Math.sin(U.t / 120) * 0.1 : c.carry === "pill" ? -1.1 : c.walking ? -swing : 0.1;
      ctx.save(); ctx.translate(6, -104); ctx.rotate(armA);
      line(ctx, 0, 0, 0, 40);
      if (forging) { ctx.fillStyle = "#6b4a2a"; ctx.fillRect(-2, 36, 4, 22); ctx.fillStyle = "#9aa3a8"; ctx.fillRect(-9, 54, 18, 10); }
      if (c.carry === "pill") pill(ctx, 0, 46, RED, 0, 1.4);
      ctx.restore();
      ctx.save(); ctx.translate(-6, -104); ctx.rotate(c.walking ? swing : c.bubble ? 0.4 + Math.sin(U.t / 200) * 0.2 : 0.05);
      line(ctx, 0, 0, 0, 40); ctx.restore();
      head(ctx, -124, c);
      if (c.carry === "scroll") drawScroll(ctx, 0, -156);
      if (c.carry === "mail") drawEnvelope(ctx, 0, -158 + Math.sin(U.t / 250) * 2);
    }
    function coat(ctx, top, bottom, flap) {
      glow(ctx, "rgba(0,255,102,0.35)", 10);
      ctx.fillStyle = "#0a120d";
      ctx.beginPath(); ctx.moveTo(-14, top); ctx.lineTo(14, top); ctx.lineTo(22 + flap, bottom); ctx.lineTo(-20 - flap * 0.5, bottom); ctx.closePath(); ctx.fill();
      noGlow(ctx);
      ctx.strokeStyle = "rgba(0,255,102,0.25)"; ctx.lineWidth = 1; line(ctx, 0, top + 4, 2, bottom);
      ctx.fillStyle = "#13221a"; ctx.beginPath(); ctx.moveTo(-14, top); ctx.lineTo(-4, top + 16); ctx.lineTo(0, top); ctx.lineTo(4, top + 16); ctx.lineTo(14, top); ctx.closePath(); ctx.fill();
    }
    function head(ctx, y, c) {
      ctx.fillStyle = "#3b2a20"; ctx.beginPath(); ctx.arc(2, y, 12, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.12)"; ctx.beginPath(); ctx.arc(-2, y - 5, 5, 0, Math.PI * 2); ctx.fill();
      glow(ctx, GREEN, 6);
      ctx.fillStyle = "#020"; ctx.beginPath(); ctx.ellipse(4, y - 1, 3.6, 2.8, 0, 0, Math.PI * 2); ctx.ellipse(11, y - 1, 3.6, 2.8, 0, 0, Math.PI * 2); ctx.fill();
      noGlow(ctx);
      ctx.fillStyle = "rgba(0,255,102,0.8)"; ctx.fillRect(3, y - 2, 1.5, 1.2); ctx.fillRect(10, y - 2, 1.5, 1.2);
      if (c.bubble?.kind === "say") { ctx.fillStyle = "#1a0f0a"; ctx.fillRect(6, y + 6, 5, 1 + Math.abs(Math.sin(U.t / 90)) * 2); }
    }
    return W;
  })();

  function rainBox(ctx, x, y, w, h, seed) {
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.fillStyle = "#000"; ctx.fillRect(x, y, w, h);
    ctx.font = "7px 'Red Hat Mono', monospace"; ctx.textAlign = "center";
    const cols = Math.max(3, Math.floor(w / 6.4));
    for (let c = 0; c < cols; c++) {
      const head = ((U.t / 1000) * (30 + ((c * 17 + seed * 5) % 40)) + c * 20) % (h + 22) - 6;
      for (let k = 0; k < 5; k++) { ctx.fillStyle = `rgba(0,255,102,${0.95 - k * 0.18})`; ctx.fillText(GLYPHS[(c * 3 + k + seed + Math.floor(U.t / 150)) % GLYPHS.length], x + 3 + c * 6.4, y + head - k * 7); }
    }
    ctx.restore();
  }

  /** Rack (her iki evrende sistem odası / veri merkezi) */
  function drawRack(ctx, x, name, light) {
    const st = U.alerts[name];
    const col = st === "alert" ? RED : st === "pending" ? AMBER : st === "ok" ? "#2dcc70" : light ? "#5aa9e6" : CYAN;
    ctx.fillStyle = "#070d12"; rrect(ctx, x - 30, GROUND - 176, 60, 176, 4); ctx.fill();
    ctx.strokeStyle = st ? col : "#2a4252"; ctx.lineWidth = st ? 2 : 1.2;
    if (st) glow(ctx, col, 16);
    ctx.stroke(); noGlow(ctx);
    for (let u = 0; u < 9; u++) {
      const y = GROUND - 166 + u * 18;
      ctx.fillStyle = "#101c24"; ctx.fillRect(x - 24, y, 48, 13);
      for (let l = 0; l < 3; l++) {
        const on = hash(u * 7 + l * 13 + x + Math.floor(U.t / (180 + l * 90))) > 0.4;
        ctx.fillStyle = on ? (u === 4 && st === "alert" ? RED : u === 4 && st === "pending" ? AMBER : light ? "#38b6ff" : GREEN) : "#0b2a16";
        ctx.fillRect(x - 20 + l * 5, y + 5, 3, 3);
      }
      ctx.fillStyle = "#1d2e38"; ctx.fillRect(x + 4, y + 4, 16, 5);
    }
    ctx.save(); ctx.translate(x, GROUND - 186); ctx.rotate(U.t / 90);
    ctx.strokeStyle = "#5c7d90"; ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) { ctx.rotate((Math.PI * 2) / 3); line(ctx, 0, 0, 8, 2); }
    ctx.restore();
    text(ctx, name, x, GROUND + 18, "600 11px 'Red Hat Mono', monospace", st ? col : light ? "#cfe3f5" : "rgba(191,233,255,0.85)");
    if (st === "alert" || st === "pending") {
      const by = GROUND - 210 + Math.sin(U.t / 260) * 3;
      glow(ctx, col, 12);
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(x, by - 12); ctx.lineTo(x + 11, by + 8); ctx.lineTo(x - 11, by + 8); ctx.closePath(); ctx.fill(); noGlow(ctx);
      text(ctx, "!", x, by + 6, "800 12px sans-serif", "#000");
    }
  }

  /* ================================================================== */
  /*  EVREN 2 — Garanti BBVA ofisi                                      */
  /*  Sistem odası | Linux ekibi (Deniz) | kahve köşesi | Otomasyon ekibi (Kaan) | toplantı odası / NOC */
  /* ================================================================== */
  const OFFICE = (() => {
    const WW = 2520;
    const NAVY = "#072146", BRAND = "#2dcc70", TEAL = "#1aa6a0", WALL = "#dfe6eb", WALL2 = "#cfd8de", CARPET = "#3b4a58";
    const SPOT = {
      srvDoor: 625, denizChair: 812, denizDesk: 868, coffee: 1215, cooler: 1335, sofa: 1430,
      kaanDesk: 1660, kaanChair: 1718, printer: 2045, noc: 2230, board: 2410,
    };
    const ROOMS = { server: [0, 625], linux: [625, 1090], kitchen: [1090, 1510], auto: [1510, 1965], noc: [1965, WW] };
    const rackX = (name) => 120 + Math.max(0, serverList().indexOf(name)) * 92;
    const TOWERS = Array.from({ length: 26 }, (_, i) => ({ x: 640 + i * 58 + hash(i + 3) * 20, w: 26 + hash(i + 5) * 22, h: 60 + hash(i + 9) * 120, spire: hash(i + 13) > 0.7 }));
    const SMALL_TALK = ["Kahve tazeymiş ☕", "Change window bu akşam mı?", "ansible-lint temiz ✓", "Patch günü yaklaşıyor…", "CAB toplantısı 14:00'te",
      "rhel-db01'e bakmak lazım", "Yeni AAP sürümü geldi", "Öğle yemeği? 🍽️", "Bitbucket PR'ı onayladım", "Monitoring sakin bugün"];
    const LOOK = {
      unixai: { skin: "#e0b48f", hair: "#2a1d14", style: "short", top: TEAL, pants: "#25313d", glasses: true, badge: BRAND },
      morpheus: { skin: "#c68d62", hair: "#151515", style: "fade", top: NAVY, pants: "#2c2f36", beard: true, headphones: true, badge: BRAND },
    };

    function daylight() {
      const h = new Date().getHours() + new Date().getMinutes() / 60;
      if (h >= 7.5 && h < 17) return "day";
      if ((h >= 17 && h < 19.5) || (h >= 6 && h < 7.5)) return "dusk";
      return "night";
    }

    const W = {
      id: "office", label: "Garanti BBVA ofis evreni", width: WW, bg: "#0b1622", parallax: 0.6, dark: false,
      subtitle: "Garanti BBVA Teknoloji · Linux ekibi ⇄ Otomasyon ekibi",
      prompts: { unixai: "Deniz · Linux Sistem Yönetimi (UnixAI)", morpheus: "Kaan · Otomasyon / Ansible (MorpheusAI)" },
      colors: { unixai: TEAL, morpheus: BRAND },
      bubble: { bg: "rgba(255,255,255,0.97)", fg: NAVY },
      places: [
        { id: "srv", label: "🖥️ Sistem odası", x: 330, z: 1.05 },
        { id: "linux", label: "🐧 Linux ekibi", x: 860, z: 1.1 },
        { id: "kitchen", label: "☕ Kahve köşesi", x: 1290, z: 1.05 },
        { id: "auto", label: "⚙️ Otomasyon ekibi", x: 1700, z: 1.1 },
        { id: "noc", label: "📊 Toplantı · NOC", x: 2230, z: 1 },
        { id: "mission", label: "🎯 Görev yeri", mission: true, z: 1.25 },
        { id: "all", label: "🏢 Tüm ofis", x: WW / 2, z: 0.44 },
      ],
      home: (self) => (self === "unixai" ? 870 : 1680),
      rackX,
      makeChars() {
        return {
          unixai: { kind: "unixai", x: SPOT.denizChair, dir: 1, speed: 190, action: "type", label: "Deniz · Linux (UnixAI)" },
          morpheus: { kind: "morpheus", x: SPOT.kaanChair, dir: -1, speed: 200, action: "type", label: "Kaan · Otomasyon (MorpheusAI)" },
        };
      },
      headY: (c) => (seated(c) ? -116 : -128),
      labelY: (c) => (seated(c) ? -124 : -136),
      labelColor: () => NAVY,
      drawFar(ctx) { /* pencereler ofis çiziminde */ },
      draw(ctx) { building(ctx); },
      drawFront(ctx) { ceilingLights(ctx); },
      drawChar(ctx, c) { person(ctx, c, LOOK[c.kind]); },
      idle(c) {
        const deniz = c.kind === "unixai";
        const r = Math.random();
        if (deniz) {
          if (r < 0.5) return { x: SPOT.denizChair, then: () => ({ action: "type", dir: 1 }) };
          if (r < 0.7) return { x: SPOT.coffee + 30, then: () => ({ action: "coffee", dir: -1 }) };
          if (r < 0.85) { const x = rackX(pick(serverList())) + 40; return { x, then: () => ({ action: "inspect", dir: -1 }) }; }
          return { x: SPOT.cooler + 30, then: () => ({ action: "stretch", dir: -1 }) };
        }
        if (r < 0.5) return { x: SPOT.kaanChair, then: () => ({ action: "type", dir: -1 }) };
        if (r < 0.65) return { x: SPOT.noc - 70, then: () => ({ action: "present", dir: 1 }) };
        if (r < 0.82) return { x: SPOT.cooler - 30, then: () => ({ action: "coffee", dir: 1 }) };
        return { x: rnd(1560, 1620), then: () => ({ action: "phone", dir: pick([-1, 1]) }) };
      },
      /** Boştayken yan yana gelirlerse kısa sohbet */
      ambient(now) {
        const a = U.C.unixai, b = U.C.morpheus;
        if (U.scripted || a.bubble || b.bubble || a.walking || b.walking || Math.abs(a.x - b.x) > 140 || now < (U.fx.chatAt || 0)) return;
        U.fx.chatAt = now + 9000;
        a.dir = Math.sign(b.x - a.x) || 1; b.dir = -a.dir;
        const sp = Math.random() < 0.5 ? a : b;
        sp.bubble = { kind: "say", text: pick(SMALL_TALK), t0: performance.now() };
        setTimeout(() => { if (!U.scripted) sp.bubble = null; }, 2600);
      },
      reset() {
        Object.assign(U.C.unixai, { x: SPOT.denizChair, dir: 1, action: "type" });
        Object.assign(U.C.morpheus, { x: SPOT.kaanChair, dir: -1, action: "type" });
        U.fx.monitorAlert = false; U.fx.print = 0; U.fx.noc = null;
      },
      finalPose(S) {
        if (S.mission) {
          Object.assign(U.C.unixai, { x: rackX(S.server) - 48, dir: 1, action: "inspect" });
          Object.assign(U.C.morpheus, { x: rackX(S.server) + 52, dir: -1, action: null, carry: "paper" });
          U.fx.noc = "pending";
          return rackX(S.server);
        }
        return S.askerK === "unixai" ? 870 : 1680;
      },
      async script(d, S) {
        const { A, B, askerK, answerK, rems, server } = S;
        const deniz = U.C.unixai, kaan = U.C.morpheus;
        const deskOf = (c) => (c.kind === "unixai" ? SPOT.denizChair : SPOT.kaanChair);
        const deskDir = (c) => (c.kind === "unixai" ? 1 : -1);
        const sitDown = (c) => { c.dir = deskDir(c); c.action = "type"; };
        const standUp = (c) => { c.action = null; };
        const goto = async (c, x) => { standUp(c); await d.walk(c, x); };
        const serverRoom = async (c) => { // kart okut, kapı açılsın, rack'e git
          if (!server) return;
          await goto(c, SPOT.srvDoor + 30); c.dir = -1; c.action = "badge"; await d.wait(700); c.action = null;
          await goto(c, rackX(server) + 44); c.dir = -1; c.action = "inspect"; await d.wait(2000); c.action = null;
        };

        /* Bölüm 1 — sorunun fark edilmesi */
        d.follow(A, 1.2, askerK === "unixai" ? 40 : -40);
        if (askerK === "unixai") {
          d.chapter("Bölüm 1 · Linux ekibi masası");
          U.fx.monitorAlert = true;
          d.status(`Deniz'in ekranında alarm: ${server ? `${server} — ` : ""}UnixAI bir bulgu buldu`);
          await d.wait(1600);
          await d.say(A, server ? `Hmm, ${server}'de bir sorun var. Önce sistem odasına bir bakayım.` : "Filoda bir şey var, Kaan'a soralım.", 2600);
          if (server) {
            d.chapter("Sistem odası · DC-1");
            d.status(`Deniz sistem odasında — ${server} rack'i inceleniyor`);
            await serverRoom(A);
            await d.say(A, "Evet, sorun gerçek. Otomasyon ekibine soralım.", 2200);
          }
        } else {
          d.chapter("Bölüm 1 · Otomasyon ekibi masası");
          d.status("Kaan, AAP panosunda bir şey fark etti — Linux ekibine soracak");
          await d.wait(1500);
          await d.say(A, "Bunu Deniz'e sormam lazım. Laptopu alıp gideyim.", 2400);
        }
        A.carry = "laptop";

        /* Koridor — kahve molası */
        d.chapter("Koridor · kahve köşesi");
        d.status(`${askerK === "unixai" ? "Deniz" : "Kaan"} ${askerK === "unixai" ? "Otomasyon" : "Linux"} ekibine gidiyor (MCP: ${askerK === "unixai" ? "morpheus_agent_ask" : "unixai_agent_ask"})`);
        d.follow(A, 1.05);
        await goto(A, SPOT.coffee + (askerK === "unixai" ? -26 : 30)); A.dir = askerK === "unixai" ? 1 : -1;
        A.carry = null; A.action = "coffee"; U.fx.steam = performance.now();
        await d.wait(1500);
        A.action = null; A.carry = "coffee";

        /* Bölüm 2 — karşı masada soru */
        d.chapter(`Bölüm 2 · ${answerK === "unixai" ? "Linux ekibi masası" : "Otomasyon ekibi masası"}`);
        const nearB = answerK === "unixai" ? SPOT.denizChair + 92 : SPOT.kaanChair - 104;
        B.dir = deskDir(B); B.action = "type";
        await goto(A, nearB); A.dir = answerK === "unixai" ? -1 : 1;
        B.action = null; B.dir = -A.dir;
        S.revealQuestion();
        d.follow({ x: (A.x + B.x) / 2 }, 1.25);
        await d.say(A, S.q);

        /* Düşünme ve iş */
        d.status(`${answerK === "unixai" ? "Deniz" : "Kaan"} düşünüyor… ${S.tools.join(", ") || "araç yok"}`);
        await d.think(B, S.tools, clamp(S.tools.length * 1000, 2000, 3600));
        sitDown(B);
        await d.wait(1400);
        if (answerK === "unixai" && server) { await d.say(B, "Bir de rack'e bakayım.", 1500); await serverRoom(B); await goto(B, SPOT.denizChair + 40); B.dir = 1; }
        if (rems.length && answerK === "morpheus") {
          d.chapter("Bölüm 3 · Toplantı odası · playbook ve standart analizi");
          d.status("Kaan playbook'u yazdı — yazıcıdan alıp NOC ekranında standart analizini gösteriyor");
          await d.say(B, "Playbook'u yazdım, yazıcıdan alayım. Gel, NOC ekranında gösteririm.", 2400);
          d.follow(B, 1.15);
          await Promise.all([goto(B, SPOT.printer + 34), (async () => { await d.wait(500); await goto(A, SPOT.printer - 40); })()]);
          B.dir = -1; U.fx.print = performance.now();
          await d.wait(1800);
          B.carry = "paper"; U.fx.print = 0;
          await goto(B, SPOT.noc - 60); B.dir = 1; B.action = "present";
          U.fx.noc = { score: rems[0].score, id: rems[0].id };
          await goto(A, SPOT.noc - 130); A.dir = 1;
          d.follow({ x: SPOT.noc - 40 }, 1.15);
          d.status(`Standart analizi · uyum ${rems[0].score ?? "?"} · ${rems[0].id || ""}`);
          await d.wait(1600);
          B.action = null; B.dir = -1;
        }

        /* Cevap */
        S.revealAnswer();
        d.follow({ x: (A.x + B.x) / 2 }, 1.2);
        d.status(`${answerK === "unixai" ? "Deniz" : "Kaan"} cevap veriyor`);
        standUp(B); B.dir = Math.sign(A.x - B.x) || 1;
        await d.say(B, S.ans || "…");

        /* Bölüm 4 — görev: sistem odasında rack başında */
        if (S.mission) {
          d.chapter(`Bölüm 4 · Görev: ${server} · Sistem odası`);
          d.status(`Deniz ve Kaan sistem odasına gidiyor — ${server}`);
          U.fx.noc = "pending";
          d.follow(kaan, 1.0, -60);
          await Promise.all([goto(deniz, SPOT.srvDoor + 60), goto(kaan, SPOT.srvDoor + 120)]);
          deniz.dir = -1; deniz.action = "badge"; await d.wait(600); deniz.action = null;
          d.follow({ x: rackX(server) }, 1.25);
          await Promise.all([goto(deniz, rackX(server) - 48), goto(kaan, rackX(server) + 52)]);
          deniz.dir = 1; kaan.dir = -1; deniz.action = "inspect";
          U.alerts[server] = "pending"; kaan.carry = "paper";
          S.revealCards();
          d.status("Değişiklik onayı bekleniyor — onaylarsanız Bitbucket → AAP template → check");
          await d.say(kaan, `Playbook hazır (uyum ${rems[0].score ?? "?"}). Değişiklik onayı gelince AAP'de önce check, sonra uygulama.`, 4400);
          await d.say(deniz, `Tamam, ${server}'in başındayım. Onay gelince haber ver ☕`, 2600);
          d.follow({ x: rackX(server) }, 1.05);
        } else {
          S.revealCards();
          await d.say(A, "Teşekkürler! 🙏", 1300);
          A.carry = null;
          d.follow(A, 1.05);
          await goto(A, deskOf(A)); sitDown(A);
          sitDown(B); if (B.x !== deskOf(B)) { await goto(B, deskOf(B)); sitDown(B); }
          d.follow({ x: A.x }, 1.05);
        }
      },
    };

    const seated = (c) => (c.action === "type" || c.action === "sit") && Math.abs(c.x - (c.kind === "unixai" ? SPOT.denizChair : SPOT.kaanChair)) < 2;

    /* ---------------- bina ---------------- */
    function building(ctx) {
      const tod = daylight();
      // dış cephe/üst
      ctx.fillStyle = "#1a2632"; ctx.fillRect(-300, -400, WW + 600, 450);
      // duvarlar
      ctx.fillStyle = WALL; ctx.fillRect(ROOMS.linux[0], 40, ROOMS.noc[1] - ROOMS.linux[0], GROUND - 40);
      ctx.fillStyle = WALL2; ctx.fillRect(ROOMS.linux[0], GROUND - 70, ROOMS.noc[1] - ROOMS.linux[0], 70);
      ctx.fillStyle = "#b9c4cc"; ctx.fillRect(ROOMS.linux[0], GROUND - 72, ROOMS.noc[1] - ROOMS.linux[0], 3);
      // pencereler (şehir manzarası; günün saatine göre)
      window_(ctx, 660, 90, 400, 150, tod, false);
      window_(ctx, 1110, 80, 380, 170, tod, true);
      window_(ctx, 1530, 90, 400, 150, tod, false);
      // tavan
      ctx.fillStyle = "#eef2f5"; ctx.fillRect(ROOMS.linux[0], 40, ROOMS.noc[1] - ROOMS.linux[0], 26);
      ctx.fillStyle = "#c5cfd6"; ctx.fillRect(ROOMS.linux[0], 64, ROOMS.noc[1] - ROOMS.linux[0], 3);
      // halı
      const cg = ctx.createLinearGradient(0, GROUND, 0, GROUND + 90);
      cg.addColorStop(0, CARPET); cg.addColorStop(1, "#1d2731");
      ctx.fillStyle = cg; ctx.fillRect(ROOMS.linux[0], GROUND, ROOMS.noc[1] - ROOMS.linux[0] + 300, 260);
      ctx.strokeStyle = "rgba(255,255,255,0.05)"; ctx.lineWidth = 1;
      for (let x = ROOMS.linux[0]; x < ROOMS.noc[1]; x += 40) line(ctx, x, GROUND, x - 20, GROUND + 60);
      serverRoom(ctx);
      linuxDesk(ctx);
      kitchen(ctx);
      autoDesk(ctx);
      nocRoom(ctx);
      // marka şeridi
      ctx.fillStyle = NAVY; ctx.fillRect(ROOMS.linux[0], 66, ROOMS.noc[1] - ROOMS.linux[0], 6);
      ctx.fillStyle = BRAND; ctx.fillRect(ROOMS.linux[0], 72, ROOMS.noc[1] - ROOMS.linux[0], 2);
    }

    function window_(ctx, x, y, w, h, tod, bridge) {
      const sky = ctx.createLinearGradient(0, y, 0, y + h);
      if (tod === "day") { sky.addColorStop(0, "#5fa8e8"); sky.addColorStop(1, "#cfe8fb"); }
      else if (tod === "dusk") { sky.addColorStop(0, "#29365f"); sky.addColorStop(0.6, "#e7795a"); sky.addColorStop(1, "#f4c27a"); }
      else { sky.addColorStop(0, "#050b1d"); sky.addColorStop(1, "#16234a"); }
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
      ctx.fillStyle = sky; ctx.fillRect(x, y, w, h);
      if (tod === "day") { ctx.fillStyle = "rgba(255,255,255,0.8)"; for (let i = 0; i < 3; i++) { const cx = x + ((i * 150 + U.t / 90) % (w + 80)) - 40; ctx.beginPath(); ctx.ellipse(cx, y + 30 + i * 14, 28, 8, 0, 0, Math.PI * 2); ctx.fill(); } }
      if (tod === "night") { ctx.fillStyle = "#f2f2d0"; ctx.beginPath(); ctx.arc(x + w - 40, y + 30, 10, 0, Math.PI * 2); ctx.fill(); }
      if (bridge) { // Boğaz ve köprü
        ctx.fillStyle = tod === "day" ? "#3d7fb0" : tod === "dusk" ? "#5a4a6a" : "#0b1630";
        ctx.fillRect(x, y + h - 40, w, 40);
        ctx.strokeStyle = tod === "night" ? "rgba(255,210,120,0.9)" : "#c9d3da"; ctx.lineWidth = 2;
        const t1 = x + 90, t2 = x + w - 90, deck = y + h - 44;
        ctx.fillStyle = tod === "night" ? "#2a3550" : "#9aa8b4"; ctx.fillRect(t1 - 4, y + 40, 8, deck - y - 40 + 6); ctx.fillRect(t2 - 4, y + 40, 8, deck - y - 40 + 6);
        ctx.beginPath(); ctx.moveTo(x - 20, deck - 20); ctx.lineTo(t1, y + 42); ctx.quadraticCurveTo((t1 + t2) / 2, deck + 30, t2, y + 42); ctx.lineTo(x + w + 20, deck - 20); ctx.stroke();
        ctx.lineWidth = 3; line(ctx, x, deck, x + w, deck);
        if (tod !== "day") { for (let i = 0; i < 16; i++) { ctx.fillStyle = `hsl(${(i * 40 + U.t / 30) % 360},80%,65%)`; ctx.fillRect(x + 20 + i * ((w - 40) / 15), deck - 3, 3, 3); } }
        ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.lineWidth = 1;
        for (let i = 0; i < 4; i++) line(ctx, x + ((i * 97 + U.t / 40) % w), y + h - 20 + i * 4, x + ((i * 97 + U.t / 40) % w) + 30, y + h - 20 + i * 4);
      }
      for (const t of TOWERS) {
        if (t.x + t.w < x || t.x > x + w) continue;
        const base = bridge ? y + h - 40 : y + h;
        ctx.fillStyle = tod === "day" ? "#6f8396" : tod === "dusk" ? "#3a3550" : "#0e1830";
        ctx.fillRect(t.x, base - t.h, t.w, t.h);
        if (t.spire) { ctx.beginPath(); ctx.moveTo(t.x + t.w / 2 - 3, base - t.h); ctx.lineTo(t.x + t.w / 2, base - t.h - 24); ctx.lineTo(t.x + t.w / 2 + 3, base - t.h); ctx.fill(); }
        if (tod !== "day") { ctx.fillStyle = "rgba(255,220,140,0.75)"; for (let wy = base - t.h + 6; wy < base - 4; wy += 9) for (let wx = t.x + 4; wx < t.x + t.w - 4; wx += 7) if (hash(wx + wy * 3) > 0.55) ctx.fillRect(wx, wy, 3, 4); }
      }
      ctx.restore();
      ctx.strokeStyle = "#8d9aa5"; ctx.lineWidth = 4; ctx.strokeRect(x, y, w, h);
      ctx.lineWidth = 2; for (let mx = x + w / 4; mx < x + w - 5; mx += w / 4) line(ctx, mx, y, mx, y + h);
      ctx.fillStyle = "rgba(255,255,255,0.08)"; ctx.beginPath(); ctx.moveTo(x + 20, y); ctx.lineTo(x + 70, y); ctx.lineTo(x + 20, y + h); ctx.lineTo(x - 30 + 20, y + h); ctx.closePath(); ctx.fill();
    }

    function serverRoom(ctx) {
      const [x0, x1] = ROOMS.server;
      ctx.fillStyle = "#0d1823"; ctx.fillRect(x0 - 300, 40, x1 - x0 + 300, GROUND - 40);
      ctx.fillStyle = "#132332"; ctx.fillRect(x0 - 300, GROUND, x1 - x0 + 300, 260);
      ctx.strokeStyle = "rgba(120,170,220,0.18)"; ctx.lineWidth = 1;
      for (let x = x0 - 300; x < x1; x += 30) line(ctx, x, GROUND, x, GROUND + 60);
      for (let y = GROUND + 15; y < GROUND + 70; y += 15) line(ctx, x0 - 300, y, x1, y);
      ctx.fillStyle = "rgba(56,182,255,0.12)"; ctx.fillRect(x0 - 300, 40, x1 - x0 + 300, 30);
      for (let x = x0 + 40; x < x1; x += 120) { glow(ctx, "#38b6ff", 18); ctx.fillStyle = "#9fdcff"; ctx.fillRect(x, 70, 70, 4); noGlow(ctx); }
      // soğuk hava sisi
      ctx.fillStyle = "rgba(160,210,255,0.05)";
      for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.ellipse(x0 + 80 + ((i * 110 + U.t / 50) % 520), GROUND - 10 - (i % 3) * 8, 60, 10, 0, 0, Math.PI * 2); ctx.fill(); }
      text(ctx, "SİSTEM ODASI · DC-1", (x0 + x1) / 2 - 30, 108, "700 13px 'Red Hat Display', sans-serif", "#9fdcff");
      text(ctx, "yetkili personel · kartlı geçiş", (x0 + x1) / 2 - 30, 124, "9px 'Red Hat Mono', monospace", "rgba(159,220,255,0.7)");
      serverList().forEach((name) => drawRack(ctx, rackX(name), name, true));
      // cam bölme + kapı + kart okuyucu
      const near = Object.values(U.C).some((c) => Math.abs(c.x - x1) < 70);
      U.fx.door = clamp((U.fx.door || 0) + (near ? 0.08 : -0.05), 0, 1);
      ctx.fillStyle = "rgba(170,210,235,0.18)"; ctx.fillRect(x1 - 8, 40, 16, GROUND - 40 - 150);
      ctx.fillStyle = "rgba(170,210,235,0.22)"; ctx.fillRect(x1 - 8 - U.fx.door * 50, GROUND - 150, 16, 150);
      ctx.strokeStyle = "#8fb3c9"; ctx.lineWidth = 2; ctx.strokeRect(x1 - 8 - U.fx.door * 50, GROUND - 150, 16, 150);
      ctx.fillStyle = "#1c2b38"; ctx.fillRect(x1 + 16, GROUND - 92, 10, 16);
      ctx.fillStyle = near ? "#2dcc70" : "#e74c3c"; ctx.fillRect(x1 + 19, GROUND - 88, 4, 3);
    }

    function desk(ctx, x, w, facing) {
      ctx.fillStyle = "#c8a77c"; ctx.fillRect(x - w / 2, GROUND - 64, w, 7);
      ctx.fillStyle = "#8d7354"; ctx.fillRect(x - w / 2 + 4, GROUND - 57, 5, 57); ctx.fillRect(x + w / 2 - 9, GROUND - 57, 5, 57);
      ctx.fillStyle = "#a8896a"; ctx.fillRect(x - w / 2 + 6, GROUND - 57, w - 12, 18);
      ctx.fillStyle = "#2b333b"; ctx.fillRect(x - facing * 20 - 16, GROUND - 68, 32, 4); // klavye
    }
    function officeChair(ctx, x, facing) {
      ctx.fillStyle = "#2b333b";
      ctx.fillRect(x - 15, GROUND - 46, 30, 6);
      ctx.fillRect(x - facing * 16 - 3, GROUND - 92, 7, 48);
      rrect(ctx, x - facing * 16 - 6, GROUND - 96, 12, 30, 4); ctx.fill();
      ctx.fillRect(x - 2, GROUND - 40, 4, 30);
      ctx.strokeStyle = "#2b333b"; ctx.lineWidth = 3; line(ctx, x - 16, GROUND - 6, x + 16, GROUND - 6);
      ctx.fillStyle = "#111"; for (const dx of [-16, 0, 16]) { ctx.beginPath(); ctx.arc(x + dx, GROUND - 3, 3, 0, Math.PI * 2); ctx.fill(); }
    }
    function monitor(ctx, x, y, w, h, content) {
      ctx.fillStyle = "#1f262d"; ctx.fillRect(x + w / 2 - 3, y + h, 6, 12); ctx.fillRect(x + w / 2 - 12, y + h + 10, 24, 3);
      ctx.fillStyle = "#11161b"; rrect(ctx, x - 3, y - 3, w + 6, h + 6, 3); ctx.fill();
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
      content(x, y, w, h);
      ctx.restore();
    }
    function terminal(ctx, x, y, w, h, alert) {
      ctx.fillStyle = "#0b0f12"; ctx.fillRect(x, y, w, h);
      const lines = alert ? ["$ unixai --scan", "rhel-db01 /u01 96%", "!! P1 bulgu", "$ df -h /u01", "/dev/vg_data 96%", "$ vgs"] : ["$ uptime", "load avg 0.42", "$ systemctl --failed", "0 loaded units", "$ dnf check-update", "kernel 5.14…", "$ tail -f messages"];
      const off = Math.floor(U.t / 650) % lines.length;
      ctx.font = "6.5px 'Red Hat Mono', monospace"; ctx.textAlign = "left";
      for (let i = 0; i < 5; i++) { const l = lines[(off + i) % lines.length]; ctx.fillStyle = /!!|96%/.test(l) ? (Math.floor(U.t / 300) % 2 ? "#ff5a5a" : AMBER) : "#5dffa0"; ctx.fillText(l, x + 3, y + 8 + i * 7.5); }
    }
    function yaml(ctx, x, y, w, h) {
      ctx.fillStyle = "#1e1e2a"; ctx.fillRect(x, y, w, h);
      const ls = [["- name: ", "#ff79c6", "UnixAI | /u01", "#f1fa8c"], ["  hosts: ", "#ff79c6", "{{ target }}", "#8be9fd"], ["  become: ", "#ff79c6", "true", "#bd93f9"], ["  tasks:", "#ff79c6", "", ""], ["    - lvextend", "#50fa7b", "", ""], ["    - xfs_growfs", "#50fa7b", "", ""]];
      const off = Math.floor(U.t / 900) % 2;
      ctx.font = "6.5px 'Red Hat Mono', monospace"; ctx.textAlign = "left";
      for (let i = 0; i < 5; i++) { const l = ls[(i + off) % ls.length]; ctx.fillStyle = l[1]; ctx.fillText(l[0], x + 3, y + 8 + i * 7.5); ctx.fillStyle = l[3] || "#fff"; ctx.fillText(l[2], x + 3 + l[0].length * 3.9, y + 8 + i * 7.5); }
    }
    function aapBoard(ctx, x, y, w, h) {
      ctx.fillStyle = "#151a21"; ctx.fillRect(x, y, w, h);
      text(ctx, "AAP", x + 4, y + 8, "700 7px 'Red Hat Mono', monospace", "#ee0000", "left");
      for (let i = 0; i < 4; i++) { const p = 0.3 + 0.7 * Math.abs(Math.sin(U.t / 2000 + i)); ctx.fillStyle = "#2b333b"; ctx.fillRect(x + 4, y + 14 + i * 7, w - 8, 4); ctx.fillStyle = i === 2 ? AMBER : "#2dcc70"; ctx.fillRect(x + 4, y + 14 + i * 7, (w - 8) * p, 4); }
    }
    function plant(ctx, x) {
      ctx.fillStyle = "#7a5a3c"; ctx.beginPath(); ctx.moveTo(x - 12, GROUND - 30); ctx.lineTo(x + 12, GROUND - 30); ctx.lineTo(x + 9, GROUND); ctx.lineTo(x - 9, GROUND); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#2e8b57";
      for (let i = 0; i < 7; i++) { const a = -Math.PI / 2 + (i - 3) * 0.35 + Math.sin(U.t / 1500 + i) * 0.04; ctx.save(); ctx.translate(x, GROUND - 30); ctx.rotate(a + Math.PI / 2); ctx.beginPath(); ctx.ellipse(0, -24, 6, 22, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
    }
    function teamSign(ctx, x, title, sub, color) {
      ctx.fillStyle = "#ffffff"; rrect(ctx, x - 70, 86, 140, 34, 5); ctx.fill();
      ctx.fillStyle = color; ctx.fillRect(x - 70, 86, 5, 34);
      text(ctx, title, x + 2, 101, "700 11px 'Red Hat Display', sans-serif", NAVY);
      text(ctx, sub, x + 2, 114, "8.5px 'Red Hat Mono', monospace", "#5b6b7a");
    }

    function linuxDesk(ctx) {
      teamSign(ctx, 760, "Linux Sistem Yönetimi", "RHEL · UnixAI OS", TEAL);
      ctx.strokeStyle = "#c5cfd6"; ctx.lineWidth = 1; ctx.strokeRect(940, 140, 70, 90); // pano
      ctx.fillStyle = "#fffbe6"; ctx.fillRect(948, 150, 24, 20); ctx.fillStyle = "#e6f6ff"; ctx.fillRect(978, 156, 24, 20); ctx.fillStyle = "#e9ffe9"; ctx.fillRect(955, 182, 26, 22);
      // Tux çıkartması (posterde)
      ctx.fillStyle = "#111"; ctx.beginPath(); ctx.ellipse(992, 202, 7, 9, 0, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.ellipse(992, 205, 4, 6, 0, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = AMBER; ctx.fillRect(989, 197, 6, 2);
      const dx = SPOT.denizDesk;
      desk(ctx, dx, 130, 1);
      monitor(ctx, dx - 40, GROUND - 120, 50, 34, (x, y, w, h) => terminal(ctx, x, y, w, h, U.fx.monitorAlert));
      monitor(ctx, dx + 16, GROUND - 120, 50, 34, (x, y, w, h) => aapBoard(ctx, x, y, w, h));
      ctx.fillStyle = "#fff"; ctx.fillRect(dx + 44, GROUND - 74, 9, 10); ctx.strokeStyle = "#999"; ctx.strokeRect(dx + 44, GROUND - 74, 9, 10); // kupa
      officeChair(ctx, SPOT.denizChair, 1);
      plant(ctx, 1040);
    }

    function kitchen(ctx) {
      teamSign(ctx, 1300, "Kahve köşesi", "mola · sohbet", "#c47f3a");
      const cx = SPOT.coffee;
      ctx.fillStyle = "#e9e3d9"; ctx.fillRect(cx - 70, GROUND - 70, 150, 70); ctx.fillStyle = "#d4cbbd"; ctx.fillRect(cx - 74, GROUND - 74, 158, 6);
      ctx.fillStyle = "#2b2f33"; rrect(ctx, cx - 18, GROUND - 124, 40, 52, 4); ctx.fill();
      ctx.fillStyle = "#4b5157"; ctx.fillRect(cx - 12, GROUND - 116, 28, 10);
      ctx.fillStyle = "#2dcc70"; ctx.fillRect(cx + 12, GROUND - 100, 4, 4);
      if (U.fx.steam && performance.now() - U.fx.steam < 2500) {
        ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.lineWidth = 1.5;
        for (let i = 0; i < 3; i++) { ctx.beginPath(); for (let k = 0; k < 12; k++) { const yy = GROUND - 84 - k * 3; const xx = cx + 2 + i * 4 + Math.sin(k / 2 + U.t / 150 + i) * 2; k ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); } ctx.stroke(); }
      }
      text(ctx, "KAHVE", cx + 2, GROUND - 128, "700 8px 'Red Hat Mono', monospace", "#6b4a2a");
      // su sebili
      const wx = SPOT.cooler;
      ctx.fillStyle = "#d0d7dd"; ctx.fillRect(wx - 14, GROUND - 80, 28, 80);
      ctx.fillStyle = "rgba(90,170,230,0.6)"; rrect(ctx, wx - 12, GROUND - 124, 24, 42, 8); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.6)"; ctx.beginPath(); ctx.arc(wx - 2, GROUND - 100 - ((U.t / 60) % 20), 2, 0, Math.PI * 2); ctx.fill();
      // koltuk
      const sx = SPOT.sofa;
      ctx.fillStyle = "#4a6a8a"; rrect(ctx, sx - 40, GROUND - 52, 80, 30, 8); ctx.fill(); rrect(ctx, sx - 44, GROUND - 76, 88, 28, 8); ctx.fill();
      ctx.fillStyle = "#2d4258"; ctx.fillRect(sx - 36, GROUND - 22, 6, 22); ctx.fillRect(sx + 30, GROUND - 22, 6, 22);
      plant(ctx, 1490);
    }

    function autoDesk(ctx) {
      teamSign(ctx, 1600, "Otomasyon / Ansible", "AAP · Bitbucket · MorpheusAI", BRAND);
      const dx = SPOT.kaanDesk;
      desk(ctx, dx, 130, -1);
      monitor(ctx, dx - 62, GROUND - 120, 50, 34, (x, y, w, h) => yaml(ctx, x, y, w, h));
      monitor(ctx, dx - 6, GROUND - 120, 50, 34, (x, y, w, h) => aapBoard(ctx, x, y, w, h));
      ctx.fillStyle = "#3a3a3a"; ctx.beginPath(); ctx.arc(dx - 52, GROUND - 70, 5, 0, Math.PI * 2); ctx.fill(); // kulaklık standı
      officeChair(ctx, SPOT.kaanChair, -1);
      // duvarda Matrix posteri (iki evren arası göz kırpma)
      ctx.fillStyle = "#000"; ctx.fillRect(1790, 140, 60, 84); rainBox(ctx, 1793, 143, 54, 60, 7);
      text(ctx, "WAKE UP", 1820, 216, "700 8px 'Red Hat Mono', monospace", GREEN);
      plant(ctx, 1900);
    }

    function nocRoom(ctx) {
      const [x0, x1] = ROOMS.noc;
      ctx.fillStyle = "#e8edf1"; ctx.fillRect(x0, 74, x1 - x0, GROUND - 74);
      ctx.fillStyle = "rgba(170,210,235,0.25)"; ctx.fillRect(x0 - 6, 74, 12, GROUND - 74);
      ctx.strokeStyle = "#8fb3c9"; ctx.lineWidth = 2; line(ctx, x0 - 6, 74, x0 - 6, GROUND); line(ctx, x0 + 6, 74, x0 + 6, GROUND);
      teamSign(ctx, 2120, "Toplantı odası · NOC", "CAB · değişiklik yönetimi", NAVY);
      // NOC duvar ekranı
      const sx = SPOT.noc - 90, sy = 140, sw = 190, sh = 110;
      ctx.fillStyle = "#11161b"; rrect(ctx, sx - 5, sy - 5, sw + 10, sh + 10, 4); ctx.fill();
      ctx.fillStyle = "#0e1a26"; ctx.fillRect(sx, sy, sw, sh);
      text(ctx, "AAP · Düzeltme playbook'ları", sx + 8, sy + 14, "700 9px 'Red Hat Mono', monospace", "#cfe3f5", "left");
      const noc = U.fx.noc;
      if (noc && typeof noc === "object") {
        text(ctx, "Standart analizi", sx + 8, sy + 34, "9px 'Red Hat Mono', monospace", "#9fb3c5", "left");
        const sc = noc.score ?? 0, fillW = (sw - 70) * clamp(sc / 100, 0, 1);
        ctx.fillStyle = "#2b333b"; ctx.fillRect(sx + 8, sy + 42, sw - 70, 10); ctx.fillStyle = sc >= 85 ? "#2dcc70" : AMBER; ctx.fillRect(sx + 8, sy + 42, fillW, 10);
        text(ctx, `uyum ${sc}`, sx + sw - 8, sy + 51, "700 11px 'Red Hat Mono', monospace", sc >= 85 ? "#2dcc70" : AMBER, "right");
        text(ctx, noc.id || "", sx + 8, sy + 70, "8px 'Red Hat Mono', monospace", "#9fb3c5", "left");
        text(ctx, "✓ isimlendirme  ✓ idempotent  ✓ check_mode", sx + 8, sy + 86, "8px 'Red Hat Mono', monospace", "#5dffa0", "left");
      } else {
        for (let i = 0; i < 5; i++) {
          const y = sy + 28 + i * 15;
          ctx.fillStyle = "#1c2b38"; ctx.fillRect(sx + 8, y, sw - 16, 10);
          const st = noc === "pending" && i === 0 ? AMBER : i === 3 ? "#e74c3c" : "#2dcc70";
          ctx.fillStyle = st; ctx.fillRect(sx + 10, y + 2, 6, 6);
          text(ctx, noc === "pending" && i === 0 ? "rhel-db01 · onay bekliyor" : ["web-deploy", "patch-rhel9", "db-backup", "cert-renew", "log-rotate"][i], sx + 22, y + 8, "7.5px 'Red Hat Mono', monospace", "#cfe3f5", "left");
        }
      }
      // yazıcı
      const px = SPOT.printer;
      ctx.fillStyle = "#e3e7ea"; rrect(ctx, px - 26, GROUND - 74, 52, 34, 4); ctx.fill();
      ctx.fillStyle = "#c5ccd2"; ctx.fillRect(px - 30, GROUND - 40, 60, 40);
      ctx.fillStyle = "#2b333b"; ctx.fillRect(px - 18, GROUND - 70, 36, 3);
      if (U.fx.print) { const k = clamp((performance.now() - U.fx.print) / 1600, 0, 1); drawPaper(ctx, px, GROUND - 74 - k * 18, 1); ctx.fillStyle = Math.floor(U.t / 200) % 2 ? "#2dcc70" : "#145a32"; ctx.fillRect(px + 16, GROUND - 64, 4, 4); }
      text(ctx, "yazıcı", px, GROUND + 16, "9px 'Red Hat Mono', monospace", "#5b6b7a");
      // beyaz tahta
      const bx = SPOT.board;
      ctx.fillStyle = "#ffffff"; ctx.fillRect(bx - 60, 150, 120, 80); ctx.strokeStyle = "#9aa6b2"; ctx.lineWidth = 2; ctx.strokeRect(bx - 60, 150, 120, 80);
      ctx.font = "italic 9px 'Red Hat Text', sans-serif"; ctx.textAlign = "left"; ctx.fillStyle = "#1a5fb4";
      ctx.fillText("CAB — değişiklik", bx - 52, 166);
      ctx.fillStyle = "#333";
      ctx.fillText(`☐ ${U.mission || "rhel-db01"} /u01`, bx - 52, 182);
      ctx.fillText("☑ playbook standart ✓", bx - 52, 196);
      ctx.fillText(U.fx.noc === "pending" ? "☐ onay bekleniyor…" : "☐ onay", bx - 52, 210);
      // toplantı masası
      ctx.fillStyle = "#b08a62"; ctx.fillRect(2290, GROUND - 56, 160, 8); ctx.fillStyle = "#8d7354"; ctx.fillRect(2300, GROUND - 48, 6, 48); ctx.fillRect(2434, GROUND - 48, 6, 48);
      for (const cx of [2310, 2370, 2430]) { ctx.fillStyle = "#2b333b"; ctx.fillRect(cx - 10, GROUND - 40, 20, 5); ctx.fillRect(cx - 2, GROUND - 35, 4, 35); }
      text(ctx, "Garanti BBVA · Teknoloji", 2400, 110, "700 12px 'Red Hat Display', sans-serif", NAVY);
    }

    function ceilingLights(ctx) {
      for (let x = ROOMS.linux[0] + 40; x < ROOMS.noc[1]; x += 160) {
        glow(ctx, "rgba(255,250,230,0.9)", 18);
        ctx.fillStyle = "#fffbe9"; ctx.fillRect(x, 62, 70, 4);
        noGlow(ctx);
      }
    }

    /* ---------------- insan figürü ---------------- */
    function person(ctx, c, L) {
      const w = c.walking ? c.phase : 0;
      ctx.scale(c.dir < 0 ? -1 : 1, 1);
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      if (seated(c)) { seatedBody(ctx, c, L); return; }
      const swing = c.walking ? Math.sin(w) * 0.55 : 0;
      const bob = c.walking ? Math.abs(Math.sin(w)) * 2 : Math.sin(U.t / 700) * 0.6;
      ctx.translate(0, -bob);
      // bacaklar
      for (const s of [-1, 1]) {
        const a = swing * s;
        const kx = Math.sin(a) * 16, fx = Math.sin(a) * 26;
        ctx.strokeStyle = s > 0 ? L.pants : shade(L.pants, -12); ctx.lineWidth = 9;
        ctx.beginPath(); ctx.moveTo(0, -56); ctx.lineTo(kx + 2, -28); ctx.lineTo(fx, -4 + bob); ctx.stroke();
        ctx.fillStyle = "#1a1a1a"; ctx.beginPath(); ctx.ellipse(fx + 5, -2 + bob, 8, 3.5, 0, 0, Math.PI * 2); ctx.fill();
      }
      body(ctx, c, L, 0, -56, -100, swing);
    }

    function seatedBody(ctx, c, L) {
      ctx.strokeStyle = L.pants; ctx.lineWidth = 9;
      ctx.beginPath(); ctx.moveTo(-2, -48); ctx.lineTo(22, -48); ctx.lineTo(24, -4); ctx.stroke();
      ctx.fillStyle = "#1a1a1a"; ctx.beginPath(); ctx.ellipse(29, -2, 8, 3.5, 0, 0, Math.PI * 2); ctx.fill();
      body(ctx, c, L, 0, -48, -92, 0, true);
    }

    function body(ctx, c, L, hx, hipY, shY, swing, sitting) {
      const lean = sitting && c.action === "type" ? 4 : 0;
      // gövde
      ctx.strokeStyle = L.top; ctx.lineWidth = 20;
      line(ctx, hx, hipY + 6, hx + lean, shY + 8);
      // yaka ve kart askısı
      ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 2; line(ctx, hx + lean - 3, shY - 1, hx + lean + 3, shY + 4);
      ctx.strokeStyle = L.badge; ctx.lineWidth = 1.5; line(ctx, hx + lean + 2, shY, hx + lean + 6, shY + 20);
      ctx.fillStyle = "#fff"; ctx.fillRect(hx + lean + 3, shY + 19, 7, 9); ctx.fillStyle = L.badge; ctx.fillRect(hx + lean + 3, shY + 19, 7, 3);
      // arka kol
      arm(ctx, c, L, hx + lean - 2, shY + 4, sitting ? "rest" : c.walking ? -swing : "idle", true);
      // baş
      headP(ctx, c, L, hx + lean + 2, shY - 13, sitting);
      // ön kol
      const act = c.action;
      const mode = c.walking ? swing : act === "type" ? "type" : act === "coffee" || c.carry === "coffee" ? "coffee" : act === "phone" ? "phone" : act === "present" ? "point"
        : act === "inspect" || c.carry === "laptop" ? "laptop" : act === "badge" ? "badge" : act === "stretch" ? "stretch" : c.carry === "paper" ? "paper" : c.bubble ? "talk" : "idle";
      arm(ctx, c, L, hx + lean + 2, shY + 4, mode, false);
    }

    function arm(ctx, c, L, sx, sy, mode, back) {
      let ex, ey, hx, hy, item = null;
      if (typeof mode === "number") { ex = sx + Math.sin(mode) * 12; ey = sy + 18; hx = sx + Math.sin(mode) * 20; hy = sy + 36; }
      else switch (mode) {
        case "type": { const j = Math.sin(U.t / 70 + (back ? 1.5 : 0)) * 1.5; ex = sx + 14; ey = sy + 20; hx = sx + 30; hy = sy + 26 + j; break; }
        case "rest": ex = sx + 10; ey = sy + 22; hx = sx + 24; hy = sy + 28; break;
        case "coffee": { const sip = Math.sin(U.t / 900) > 0.6; ex = sx + 12; ey = sy + 16; hx = sip ? sx + 12 : sx + 18; hy = sip ? sy - 10 : sy + 14; item = "cup"; break; }
        case "phone": ex = sx + 10; ey = sy + 10; hx = sx + 6; hy = sy - 12; item = "phone"; break;
        case "point": ex = sx + 18; ey = sy - 4; hx = sx + 36; hy = sy - 12; break;
        case "laptop": ex = sx + 14; ey = sy + 18; hx = sx + 26; hy = sy + 22; item = "laptop"; break;
        case "paper": ex = sx + 14; ey = sy + 16; hx = sx + 24; hy = sy + 14; item = "paper"; break;
        case "badge": ex = sx + 16; ey = sy + 8; hx = sx + 32; hy = sy + 6; item = "card"; break;
        case "stretch": ex = sx + 4; ey = sy - 18; hx = sx + 6; hy = sy - 36 - Math.abs(Math.sin(U.t / 500)) * 4; break;
        case "talk": { const g = Math.sin(U.t / 220); ex = sx + 12; ey = sy + 14; hx = sx + 24 + g * 3; hy = sy + 6 + g * 4; break; }
        default: ex = sx + 3; ey = sy + 18; hx = sx + 4; hy = sy + 36;
      }
      if (back && item) item = null;
      ctx.strokeStyle = back ? shade(L.top, -18) : L.top; ctx.lineWidth = 7;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.fillStyle = L.skin; ctx.beginPath(); ctx.arc(hx, hy, 3.6, 0, Math.PI * 2); ctx.fill();
      if (item === "cup") { ctx.fillStyle = "#fff"; ctx.fillRect(hx - 3, hy - 9, 8, 10); ctx.fillStyle = "#6b4a2a"; ctx.fillRect(hx - 2, hy - 8, 6, 2); if (Math.floor(U.t / 400) % 2) { ctx.strokeStyle = "rgba(255,255,255,0.6)"; ctx.lineWidth = 1; line(ctx, hx + 1, hy - 11, hx + 2, hy - 17); } }
      if (item === "phone") { ctx.fillStyle = "#111"; ctx.fillRect(hx - 2, hy - 8, 4, 10); }
      if (item === "laptop") { ctx.fillStyle = "#9aa3ab"; ctx.fillRect(hx - 6, hy - 2, 26, 3); ctx.save(); ctx.translate(hx - 6, hy - 2); ctx.rotate(-1.2); ctx.fillStyle = "#b8c0c6"; ctx.fillRect(0, -1, 22, 2); ctx.restore(); ctx.fillStyle = "#0b0f12"; ctx.fillRect(hx - 4, hy - 19, 3, 16); if (c.kind === "unixai") { ctx.fillStyle = "#111"; ctx.beginPath(); ctx.arc(hx + 8, hy - 1, 2, 0, Math.PI * 2); ctx.fill(); } }
      if (item === "paper") drawPaper(ctx, hx + 6, hy - 6, 1);
      if (item === "card") { ctx.fillStyle = "#fff"; ctx.fillRect(hx, hy - 4, 9, 6); ctx.fillStyle = BRAND; ctx.fillRect(hx, hy - 4, 9, 2); }
    }

    function headP(ctx, c, L, x, y, sitting) {
      ctx.fillStyle = L.skin; ctx.fillRect(x - 3, y + 8, 6, 6); // boyun
      ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = shade(L.skin, -20); ctx.beginPath(); ctx.arc(x - 6, y + 1, 2.5, 0, Math.PI * 2); ctx.fill(); // kulak
      ctx.fillStyle = L.hair;
      if (L.style === "short") { ctx.beginPath(); ctx.arc(x, y - 2, 11.5, Math.PI * 0.95, Math.PI * 2.05); ctx.fill(); ctx.fillRect(x - 11, y - 4, 7, 8); }
      else { ctx.beginPath(); ctx.arc(x, y - 3, 11, Math.PI * 1.05, Math.PI * 1.95); ctx.fill(); ctx.fillRect(x - 11, y - 5, 4, 6); }
      if (L.beard) { ctx.fillStyle = L.hair; ctx.beginPath(); ctx.arc(x + 2, y + 3, 9.5, 0.1, Math.PI * 0.75); ctx.fill(); }
      // göz
      const blink = Math.sin(U.t / 1400 + (c.kind === "unixai" ? 0 : 1.7)) > 0.985;
      ctx.fillStyle = "#1a1a1a"; ctx.fillRect(x + 5, y - 2, 2.2, blink ? 0.6 : 2.4);
      if (L.glasses) { ctx.strokeStyle = "#222"; ctx.lineWidth = 1.3; ctx.strokeRect(x + 3, y - 4.5, 6, 5); line(ctx, x + 3, y - 2, x - 4, y - 3); }
      // ağız
      ctx.fillStyle = "#7a3d2a";
      if (c.bubble?.kind === "say") ctx.fillRect(x + 5, y + 5, 3.5, 1 + Math.abs(Math.sin(U.t / 90)) * 2.2);
      else ctx.fillRect(x + 5, y + 5.5, 3, 1);
      if (L.headphones) {
        ctx.strokeStyle = "#2a2a2a"; ctx.lineWidth = 3;
        if (sitting && c.action === "type") { ctx.beginPath(); ctx.arc(x, y - 1, 13, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke(); ctx.fillStyle = "#2a2a2a"; ctx.fillRect(x - 3, y - 5, 6, 9); }
        else { ctx.beginPath(); ctx.arc(x, y + 14, 8, Math.PI * 0.1, Math.PI * 0.9, true); ctx.stroke(); }
      }
    }
    function shade(hex, amt) {
      const n = parseInt(hex.slice(1), 16);
      const r = clamp((n >> 16) + amt, 0, 255), g = clamp(((n >> 8) & 255) + amt, 0, 255), b = clamp((n & 255) + amt, 0, 255);
      return `rgb(${r},${g},${b})`;
    }
    return W;
  })();

  const WORLDS = { matrix: MATRIX, office: OFFICE };

  /* ================================================================== */
  /*  Kurulum                                                           */
  /* ================================================================== */
  function mount(stage, opts = {}) {
    if (!stage) return;
    U.selfKind = opts.self === "morpheus" ? "morpheus" : "unixai";
    U.effects = store.get("universe.effects", "on") !== "off" && !prefersReduced();
    if (U.stage !== stage) {
      U.stage = stage;
      stage.innerHTML = `
        <canvas class="uv-world" role="img" aria-label="Konuşma evreni: ajanların dünyası"></canvas>
        <div class="uv-hud">
          <div class="uv-title"><span class="uv-glitch" data-text="KONUŞMA EVRENİ">KONUŞMA EVRENİ</span>
            <small id="uvSub"></small></div>
          <div class="uv-ctrl">
            <label class="uv-select"><span>Evren</span>
              <select id="uvWorld" aria-label="Evren seç">${Object.values(WORLDS).map((w) => `<option value="${w.id}">${w.label}</option>`).join("")}</select></label>
            <span class="uv-stats" id="uvStats"></span>
            <button type="button" class="uv-btn" id="uvReplay" title="Seçili konuşmayı film olarak oynat">▶ Oynat</button>
            <button type="button" class="uv-btn ghost hidden" id="uvSkip" title="Filmi atla">⏭ Atla</button>
            <button type="button" class="uv-btn ghost" id="uvFx" aria-pressed="true"></button>
          </div>
        </div>
        <nav class="uv-places" id="uvPlaces" aria-label="Evrende git"></nav>
        <div class="uv-chapter" id="uvChapter" aria-live="polite"></div>
        <div class="uv-status mono" id="uvStatus" aria-live="polite"></div>`;
      U.cv = stage.querySelector(".uv-world");
      U.ctx = U.cv.getContext("2d");
      U.statusEl = stage.querySelector("#uvStatus");
      U.chapterEl = stage.querySelector("#uvChapter");
      U.statsEl = stage.querySelector("#uvStats");
      stage.querySelector("#uvReplay").onclick = () => U.lastPlay && play(U.lastPlay.record, U.lastPlay.detail);
      stage.querySelector("#uvSkip").onclick = () => U.skip && U.skip();
      stage.querySelector("#uvFx").onclick = () => {
        U.effects = !U.effects;
        store.set("universe.effects", U.effects ? "on" : "off");
        fxLabel();
        if (!U.effects && U.skip) U.skip();
        kick();
      };
      const sel = stage.querySelector("#uvWorld");
      sel.onchange = () => setWorld(sel.value, true);
      bindDrag();
      fxLabel();
      if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);
      else window.addEventListener("resize", resize);
      resize();
      setWorld(WORLDS[store.get("universe.world", "matrix")] ? store.get("universe.world", "matrix") : "matrix", false);
    }
    kick();
  }

  /** Evren değiştir: karakterler, konumlar, düğmeler yeniden kurulur; seçili konuşma yeni evrende oynatılır */
  function setWorld(id, replay) {
    const W = WORLDS[id] || MATRIX;
    U.playToken++;
    U.world = W;
    store.set("universe.world", W.id);
    U.stage.dataset.world = W.id;
    U.stage.querySelector("#uvWorld").value = W.id;
    U.stage.querySelector("#uvSub").textContent = W.subtitle;
    U.stage.querySelector("#uvPlaces").innerHTML = W.places.map((p) => `<button type="button" data-place="${p.id}">${p.label}</button>`).join("");
    U.stage.querySelectorAll("[data-place]").forEach((b) => (b.onclick = () => goPlace(b.dataset.place)));
    U.C = {};
    for (const [k, c] of Object.entries(W.makeChars()))
      U.C[k] = { target: null, onArrive: null, phase: 0, walking: false, alpha: 1, fade: 0, bubble: null, carry: null, idleAt: performance.now() + 2500, ...c };
    U.fx = {}; U.items = []; U.orb = null; U.sparks = []; U.codeBits = []; U.scripted = false;
    if (U.skip) { const s = U.stage.querySelector("#uvSkip"); s && s.classList.add("hidden"); U.skip = null; }
    U.cam.follow = null;
    U.cam.x = U.cam.tx = W.home(U.selfKind); U.cam.z = U.cam.tz = 1;
    chapter(W.label);
    status(`${W.label} — bir konuşma seçin, düğmelerle gezin veya sahneyi sürükleyin`, true);
    if (replay && U.lastPlay) play(U.lastPlay.record, U.lastPlay.detail);
    kick();
  }

  function fxLabel() {
    const b = U.stage?.querySelector("#uvFx");
    if (b) { b.textContent = U.effects ? "Efektler: açık" : "Efektler: kapalı"; b.setAttribute("aria-pressed", String(U.effects)); }
  }

  function resize() {
    if (!U.stage) return;
    const r = U.stage.getBoundingClientRect();
    if (!r.width) return;
    U.dpr = Math.min(window.devicePixelRatio || 1, 2);
    U.w = r.width; U.h = r.height;
    U.cv.width = Math.round(U.w * U.dpr); U.cv.height = Math.round(U.h * U.dpr);
    U.cv.style.width = U.w + "px"; U.cv.style.height = U.h + "px";
    kick();
  }

  const visible = () => U.stage && U.stage.isConnected && U.stage.offsetParent !== null && !document.hidden;
  function kick() {
    if (!U.running && visible() && U.world) { U.running = true; U.last = performance.now(); requestAnimationFrame(loop); }
  }
  document.addEventListener("visibilitychange", kick);

  /* ---------------- kamera ---------------- */
  const scale = () => (U.h / WH) * U.cam.z;
  const halfView = () => U.w / 2 / scale();
  function goPlace(id) {
    const p = U.world.places.find((x) => x.id === id);
    if (!p) return;
    const target = U.mission || serverList()[0];
    U.cam.follow = null;
    U.cam.manualUntil = performance.now() + 7000;
    flyTo(p.mission ? U.world.rackX(target) + 30 : p.x, p.z);
    chapter(p.mission ? `Görev yeri · ${target}` : p.label.replace(/^\S+\s/, ""));
    kick();
  }
  function flyTo(x, z = U.cam.tz) {
    U.cam.tx = x; U.cam.tz = z;
    if (!U.effects) { U.cam.x = x; U.cam.z = z; }
  }
  function bindDrag() {
    U.cv.addEventListener("pointerdown", (e) => { U.drag = { x: e.clientX, cam: U.cam.x }; U.cv.setPointerCapture(e.pointerId); });
    U.cv.addEventListener("pointermove", (e) => {
      if (!U.drag) return;
      U.cam.follow = null;
      U.cam.manualUntil = performance.now() + 7000;
      U.cam.x = U.cam.tx = U.drag.cam - (e.clientX - U.drag.x) / scale();
    });
    const end = () => (U.drag = null);
    U.cv.addEventListener("pointerup", end);
    U.cv.addEventListener("pointercancel", end);
    U.cv.addEventListener("wheel", (e) => { // Ctrl + tekerlek: yakınlaş/uzaklaş (sayfa kaydırmasını bozmaz)
      if (!e.ctrlKey) return;
      e.preventDefault();
      U.cam.tz = clamp(U.cam.tz * (e.deltaY > 0 ? 0.9 : 1.1), 0.4, 1.8);
      U.cam.manualUntil = performance.now() + 7000;
    }, { passive: false });
  }
  function worldTransform(par = 1) {
    const s = scale(), d = U.dpr;
    U.ctx.setTransform(d * s, 0, 0, d * s, d * (U.w / 2 - U.cam.x * par * s), d * (U.h * 0.74 - GROUND * s));
  }

  /* ================================================================== */
  /*  Döngü                                                             */
  /* ================================================================== */
  function loop(now) {
    if (!visible()) { U.running = false; return; }
    const dt = clamp((now - U.last) / 1000, 0, 0.05); // ilk karede rAF zamanı performance.now()'dan önce olabilir
    U.last = now;
    if (U.effects) U.t += dt * 1000;
    update(dt, now);
    render();
    if (U.effects) requestAnimationFrame(loop);
    else setTimeout(() => requestAnimationFrame(loop), 250); // hareketsiz modda seyrek çizim
  }

  function update(dt, now) {
    const mv = U.effects ? dt : 0;
    for (const c of Object.values(U.C)) {
      if (c.target != null) {
        const dx = c.target - c.x, step = c.speed * mv;
        if (!U.effects || Math.abs(dx) <= Math.max(step, 0.5)) {
          c.x = c.target; c.target = null; c.walking = false;
          const f = c.onArrive; c.onArrive = null; f && f();
        } else { c.x += Math.sign(dx) * step; c.dir = Math.sign(dx); c.walking = true; c.phase += mv * 11; }
      }
      if (c.fade) {
        c.alpha = U.effects ? clamp(c.alpha + c.fade * mv * 2.4, 0, 1) : c.fade > 0 ? 1 : 0;
        if (c.alpha === 0 || c.alpha === 1) c.fade = 0;
      }
      if (!U.scripted && U.effects) idle(c, now);
    }
    if (!U.scripted && U.effects && U.world.ambient) U.world.ambient(now);
    if (U.orb) {
      const o = U.orb, k = clamp((now - o.t0) / o.dur, 0, 1);
      o.x = o.from + (o.to - o.from) * (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
      o.trail.push(o.x); if (o.trail.length > 22) o.trail.shift();
      if (k >= 1 || !U.effects) { const f = o.done; U.orb = null; f && f(); }
    }
    const cam = U.cam;
    if (cam.follow && now > cam.manualUntil) cam.tx = cam.follow.x + (cam.follow.lead || 0);
    const k = U.effects ? Math.min(1, dt * 2.6) : 1;
    cam.x += (cam.tx - cam.x) * k;
    cam.z += (cam.tz - cam.z) * k;
    const hv = halfView(), WW = U.world.width;
    cam.x = hv * 2 >= WW ? WW / 2 : clamp(cam.x, hv - 40, WW - hv + 40);
    for (const arr of [U.sparks, U.codeBits]) for (const p of arr) { p.x += p.vx * mv; p.y += p.vy * mv; p.vy += (p.g || 0) * mv; p.life -= mv; }
    U.sparks = U.sparks.filter((p) => p.life > 0);
    U.codeBits = U.codeBits.filter((p) => p.life > 0);
  }

  function idle(c, now) {
    if (c.target != null || now < c.idleAt || c.bubble) return;
    c.idleAt = now + rnd(5500, 10000);
    const plan = U.world.idle(c);
    if (!plan) return;
    c.action = null;
    walkRaw(c, plan.x).then(() => { if (!U.scripted) Object.assign(c, plan.then()); });
  }

  /* ================================================================== */
  /*  Çizim                                                             */
  /* ================================================================== */
  function render() {
    const ctx = U.ctx, W = U.world;
    ctx.setTransform(U.dpr, 0, 0, U.dpr, 0, 0);
    ctx.fillStyle = W.bg; ctx.fillRect(0, 0, U.w, U.h);
    worldTransform(W.parallax); W.drawFar(ctx);
    worldTransform(1);
    W.draw(ctx);
    for (const it of U.items) if (it.kind === "scroll") drawScroll(ctx, it.x, it.y + Math.sin(U.t / 300) * 3, it.score);
    const chars = Object.values(U.C);
    // yan yana duran karakterlerin isim etiketleri çakışmasın: sağdakini bir sıra yukarı al
    const [c1, c2] = [...chars].sort((a, b) => a.x - b.x);
    for (const c of chars) c.labelLift = 0;
    if (c1 && c2 && c2.x - c1.x < 150) {
      const y1 = W.labelY(c1), y2 = W.labelY(c2);
      if (Math.abs(y1 - y2) < 15) c2.labelLift = y2 - Math.min(y1, y2) + 15;
    }
    for (const c of chars) drawChar(ctx, c);
    drawOrb(ctx);
    drawParticles(ctx);
    if (W.drawFront) W.drawFront(ctx);
    for (const c of chars) drawBubble(ctx, c);
    ctx.setTransform(U.dpr, 0, 0, U.dpr, 0, 0);
    const g = ctx.createRadialGradient(U.w / 2, U.h / 2, U.h * 0.3, U.w / 2, U.h / 2, U.w * 0.75);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, W.dark ? "rgba(0,0,0,0.55)" : "rgba(0,0,0,0.28)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, U.w, U.h);
  }

  function drawChar(ctx, c) {
    if (c.alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = c.alpha;
    ctx.translate(c.x, GROUND);
    U.world.drawChar(ctx, c);
    ctx.restore();
    if (c.alpha > 0.5 && !c.bubble) {
      const col = U.world.labelColor ? U.world.labelColor(c) : U.world.colors[c.kind];
      ctx.font = "700 10px 'Red Hat Display', sans-serif";
      const tw = ctx.measureText(c.label).width + 10, y = GROUND + U.world.labelY(c) - (c.labelLift || 0);
      if (!U.world.dark) { ctx.fillStyle = "rgba(255,255,255,0.85)"; rrect(ctx, c.x - tw / 2, y - 10, tw, 14, 7); ctx.fill(); }
      text(ctx, c.label, c.x, y, "700 10px 'Red Hat Display', sans-serif", col);
    }
  }

  function wrap(ctx, s, maxW, maxLines) {
    const words = String(s).split(/\s+/).filter(Boolean), lines = [];
    let cur = "", used = 0;
    for (const wd of words) {
      const t = cur ? cur + " " + wd : wd;
      if (ctx.measureText(t).width > maxW && cur) {
        lines.push(cur);
        if (lines.length === maxLines) break;
        cur = wd;
      } else cur = t;
      used++;
    }
    if (lines.length < maxLines && cur) lines.push(cur);
    if (used < words.length) lines[lines.length - 1] = lines[lines.length - 1].replace(/\s*\S{0,3}$/, "") + " …";
    return lines;
  }

  function drawBubble(ctx, c) {
    const b = c.bubble;
    if (!b || c.alpha < 0.5) return;
    const W = U.world, col = W.colors[c.kind], st = W.bubble;
    const headY = GROUND + W.headY(c);
    const left = U.cam.x - halfView() + 8, right = U.cam.x + halfView() - 8;
    if (b.kind === "think") {
      const item = b.items[Math.floor((performance.now() - b.t0) / 900) % b.items.length];
      ctx.font = "12px 'Red Hat Mono', monospace";
      const label = "… " + item;
      const w = Math.min(ctx.measureText(label).width + 24, 320);
      const x = clamp(c.x + 10, left, right - w), y = headY - 46;
      ctx.fillStyle = st.bg; ctx.strokeStyle = col; ctx.lineWidth = 1.2;
      rrect(ctx, x, y - 16, w, 26, 13); ctx.fill(); ctx.stroke();
      for (const [dx, dy, r] of [[2, 18, 5], [-4, 28, 3]]) { ctx.beginPath(); ctx.arc(c.x + dx, y + dy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      text(ctx, label, x + 12, y + 1, "12px 'Red Hat Mono', monospace", st.fg, "left");
      return;
    }
    ctx.font = "12px 'Red Hat Text', sans-serif";
    const shown = U.effects ? Math.min(b.text.length, Math.floor((performance.now() - b.t0) / 24)) : b.text.length;
    const lines = wrap(ctx, b.text.slice(0, shown) || " ", 250, 5);
    ctx.font = "600 9px 'Red Hat Mono', monospace";
    const headW = ctx.measureText(W.prompts[c.kind]).width + 20;
    ctx.font = "12px 'Red Hat Text', sans-serif";
    const w = Math.max(120, headW, Math.min(276, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 24));
    const h = lines.length * 16 + 28;
    const bx = clamp(c.x - w / 2, left, right - w), by = headY - h - 10;
    ctx.fillStyle = st.bg; ctx.strokeStyle = col; ctx.lineWidth = 1.5;
    glow(ctx, col, W.dark ? 12 : 6); rrect(ctx, bx, by, w, h, 8); ctx.fill(); noGlow(ctx); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(c.x - 7, by + h - 1); ctx.lineTo(c.x, by + h + 10); ctx.lineTo(c.x + 7, by + h - 1); ctx.closePath(); ctx.fillStyle = st.bg; ctx.fill();
    text(ctx, W.prompts[c.kind], bx + 10, by + 15, "600 9px 'Red Hat Mono', monospace", col, "left");
    lines.forEach((l, i) => text(ctx, l, bx + 10, by + 32 + i * 16, "12px 'Red Hat Text', sans-serif", st.fg, "left"));
  }

  function drawOrb(ctx) {
    const o = U.orb;
    if (!o) return;
    o.trail.forEach((x, i) => {
      ctx.globalAlpha = (i / o.trail.length) * 0.7;
      glow(ctx, o.color, 16); ctx.fillStyle = o.color;
      ctx.beginPath(); ctx.arc(x, GROUND - 46, 3 + i / 3, 0, Math.PI * 2); ctx.fill();
    });
    ctx.globalAlpha = 1;
    glow(ctx, o.color, 30); ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(o.x, GROUND - 46, 11, 0, Math.PI * 2); ctx.fill();
    noGlow(ctx);
    ctx.font = "10px 'Red Hat Mono', monospace"; ctx.textAlign = "center";
    for (let i = 0; i < 8; i++) { const a = U.t / 150 + i; ctx.fillStyle = "rgba(0,255,102,0.85)"; ctx.fillText(GLYPHS[(i * 5 + Math.floor(U.t / 90)) % GLYPHS.length], o.x + Math.cos(a) * 22, GROUND - 42 + Math.sin(a) * 22); }
    if (o.label) text(ctx, o.label, o.x, GROUND - 80, "600 11px 'Red Hat Mono', monospace", "#e6ffee");
  }

  function drawParticles(ctx) {
    for (const p of U.sparks) { ctx.globalAlpha = clamp(p.life * 2, 0, 1); glow(ctx, p.c || AMBER, 8); ctx.fillStyle = p.c || AMBER; ctx.fillRect(p.x, p.y, 2.5, 2.5); }
    noGlow(ctx);
    ctx.font = "11px 'Red Hat Mono', monospace"; ctx.textAlign = "center";
    for (const p of U.codeBits) { ctx.globalAlpha = clamp(p.life, 0, 1); ctx.fillStyle = GREEN; ctx.fillText(p.ch, p.x, p.y); }
    ctx.globalAlpha = 1;
  }

  /* ================================================================== */
  /*  Senaryo motoru                                                    */
  /* ================================================================== */
  function status(s, instant) {
    const el = U.statusEl;
    if (!el) return;
    const tok = (el._tok = (el._tok || 0) + 1);
    if (instant || !U.effects) { el.textContent = s; return; }
    el.textContent = "";
    let i = 0;
    const step = () => { if (el._tok !== tok) return; el.textContent = s.slice(0, ++i) + (i < s.length ? "▌" : ""); if (i < s.length) setTimeout(step, 12); };
    step();
  }
  function chapter(s) {
    const el = U.chapterEl;
    if (!el) return;
    el.textContent = s;
    el.classList.remove("on"); void el.offsetWidth; el.classList.add("on");
  }

  function walkRaw(c, x) {
    return new Promise((res) => {
      if (c.onArrive) { const f = c.onArrive; c.onArrive = null; f(); }
      if (!U.effects) { c.x = x; c.target = null; return res(); }
      c.target = x; c.onArrive = res;
    });
  }

  function director(token) {
    const alive = () => { if (U.playToken !== token) throw CANCEL; };
    const wait = async (ms) => { if (U.effects) await new Promise((r) => setTimeout(r, ms)); alive(); };
    const walk = async (c, x) => { c.action = null; await walkRaw(c, x); alive(); };
    const say = async (c, s, ms) => {
      c.bubble = { kind: "say", text: s, t0: performance.now() };
      await wait(ms ?? clamp(1500 + s.length * 26, 2400, 6500));
      c.bubble = null;
    };
    const think = async (c, items, ms) => { c.bubble = { kind: "think", items: items.length ? items : ["…"], t0: performance.now() }; await wait(ms); c.bubble = null; };
    const follow = (obj, z = U.cam.tz, lead = 0) => { obj.lead = lead; U.cam.follow = obj; U.cam.tz = z; U.cam.manualUntil = 0; };
    const orb = async (from, to, color, label) => {
      const o = { x: from, from, to, t0: performance.now(), dur: 2600, trail: [], color, label };
      follow(o, 0.85);
      await new Promise((r) => { o.done = r; U.orb = o; });
      alive();
    };
    return { alive, wait, walk, say, think, follow, orb, status, chapter };
  }

  /** Konuşmayı seçili evrenin senaryosuyla film olarak oynatır; ayrıntı panelini de adım adım açar */
  async function play(record, detail) {
    if (!record || !detail || !U.world) return;
    U.lastPlay = { record, detail };
    const token = ++U.playToken;
    const W = U.world;
    if (record.server && !U.servers.includes(record.server)) U.servers = [record.server, ...U.servers].slice(0, 5);
    if (record.server) U.mission = record.server;

    const out = record.direction === "giden";
    const askerK = out ? U.selfKind : kindOf(record.peer) === U.selfKind ? other(U.selfKind) : kindOf(record.peer);
    const answerK = other(askerK);
    const rems = record.remediations || [];

    const msgs = detail.querySelectorAll(".a2a-msg");
    msgs.forEach((m, i) => {
      const k = i === 0 ? askerK : answerK;
      m.classList.add("uv-msg", `uv-${k}`);
      const who = m.querySelector(".a2a-who");
      if (who) { who.querySelector(".uv-prompt")?.remove(); who.insertAdjacentHTML("afterbegin", `<span class="uv-prompt">${W.prompts[k]}</span> `); }
    });
    const cards = detail.querySelectorAll(".a2a-rem");
    const skipBtn = U.stage?.querySelector("#uvSkip");

    const S = {
      askerK, answerK, A: U.C[askerK], B: U.C[answerK], rems, server: record.server || null, mission: rems.length > 0 && Boolean(record.server),
      q: String(record.question || "").replace(/\s+/g, " ").trim(),
      ans: String(record.ok === false ? `Hata: ${record.error || ""}` : record.answer || "").replace(/\s+/g, " ").trim(),
      tools: (record.tools || []).map((t) => String(t).replace(/^.*__/, "")),
      revealQuestion: () => msgs[0]?.classList.add("uv-in"),
      revealAnswer: () => msgs[1]?.classList.add("uv-in", "uv-decrypt"),
      revealCards: () => cards.forEach((r) => r.classList.add("uv-in")),
    };

    // sahneyi baştan kur
    U.scripted = true;
    U.items = []; U.orb = null; U.sparks = []; U.codeBits = [];
    U.fx = { door: U.fx.door || 0 };
    for (const c of Object.values(U.C)) Object.assign(c, { target: null, onArrive: null, bubble: null, carry: null, alpha: 1, fade: 0, walking: false });
    W.reset(S);
    U.alerts = {};
    if (record.server) U.alerts[record.server] = "alert";

    const finish = () => {
      U.scripted = false;
      U.cam.follow = null;
      U.orb = null;
      if (skipBtn) skipBtn.classList.add("hidden");
      U.skip = null;
      detail.classList.remove("uv-playing");
      msgs.forEach((m) => m.classList.add("uv-in"));
      cards.forEach((r) => r.classList.add("uv-in"));
      if (record.server) U.alerts[record.server] = rems.length ? "pending" : record.ok === false ? "alert" : "ok";
      for (const c of Object.values(U.C)) { c.bubble = null; c.alpha = 1; c.fade = 0; c.idleAt = performance.now() + 6000; }
    };
    const finalPose = () => {
      for (const c of Object.values(U.C)) Object.assign(c, { target: null, onArrive: null, walking: false });
      flyTo(W.finalPose(S), 1.1);
    };

    if (!U.effects) {
      finalPose();
      finish();
      status(`${W.prompts[askerK]} — ${S.q.slice(0, 90)}`, true);
      return;
    }

    detail.classList.add("uv-playing");
    msgs.forEach((m) => m.classList.remove("uv-in", "uv-decrypt"));
    cards.forEach((r) => r.classList.remove("uv-in"));
    if (skipBtn) skipBtn.classList.remove("hidden");
    U.skip = () => { U.playToken++; finalPose(); finish(); status("Film atlandı — son sahne", true); };

    const d = director(token);
    try {
      await W.script(d, S);
      d.alive();
      status(`Konuşma tamamlandı${record.durationMs != null ? ` · ${(record.durationMs / 1000).toFixed(1)} sn` : ""}${rems.length ? " · playbook onayınızı bekliyor" : ""}`);
      chapter(rems.length ? "Onayınızı bekliyorlar" : "Konuşma tamamlandı");
      finish();
    } catch (e) {
      if (e !== CANCEL) { console.error(e); finish(); }
    }
  }

  function setStats(items) {
    const servers = [...new Set(items.map((x) => x.server).filter(Boolean))];
    if (servers.length) U.servers = servers.slice(0, 5);
    if (!U.mission && servers.length) U.mission = servers[0];
    for (const x of items) if (x.server && x.remediations?.length && !U.alerts[x.server]) U.alerts[x.server] = "pending";
    if (!U.statsEl) return;
    const pb = items.reduce((n, x) => n + (x.remediations?.length || 0), 0);
    U.statsEl.innerHTML = `<b>${items.length}</b> konuşma · <b>${pb}</b> playbook · <b>${servers.length}</b> sunucu`;
  }

  window.Universe = { mount, play, setStats, worlds: () => Object.values(WORLDS).map((w) => ({ id: w.id, label: w.label })) };
})();
