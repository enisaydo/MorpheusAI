/*
 * Konuşma Evreni — ajanlar arası konuşmaların yaşadığı dünya
 *
 *   Dünya (soldan sağa):
 *     Tux'un evi        Antarktika'da Linux veri merkezi: igloo, kuzey ışıkları, RHEL rack'leri, kar
 *     MCP otoyolu       Matrix şehri üzerinde neon köprü, veri arabaları, iki uçta MCP kapısı (Bearer)
 *     Nebuchadnezzar    Morpheus'un gemisi: operatör konsolu, deri koltuk, Ansible örsü (AAP), Bitbucket kasası, çıkış telefonu
 *
 *   Karakterler yürür, düşünür, konuşur, kapıdan ışınlanır; kamera onları takip eder.
 *   Bir konuşma seçilince kısa bir film olarak oynatılır: soran ajan karşının evine gider, soruyu sorar;
 *   Morpheus playbook'u Ansible örsünde döver; görev varsa sunucunun rack'ine birlikte gidilir.
 *   Boştayken ajanlar evlerinde kendi işini yapar. Konum düğmeleriyle, sürükleyerek veya Ctrl+tekerlekle gezilir.
 *
 *   Bağımlılık yok; MorpheusAI ve UnixAI OS'ta aynı dosya. "Efektler" anahtarı / prefers-reduced-motion hareketi kapatır.
 */
(function () {
  "use strict";

  /* ================================================================== */
  /*  Sabitler                                                          */
  /* ================================================================== */
  const WH = 460, GROUND = 392, WW = 2600;
  const GATE_L = 905, GATE_R = 1715;
  const SPOT = { kiosk: 235, igloo: 105, phone: 1795, console: 1935, chair: 2090, forge: 2275, vault: 2445 };
  const GREEN = "#00ff66", CYAN = "#3df5ff", RED = "#ff2d55", AMBER = "#ffb000", ICE = "#bfe9ff";
  const GLYPHS = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン0123456789Z:=*+-<>|";
  const PROMPTS = { unixai: "root@unixai:~#", morpheus: "morpheus@nebuchadnezzar:~$" };
  const HOME_NAME = { unixai: "Tux'un evi · Linux veri merkezi", morpheus: "Nebuchadnezzar · Morpheus'un gemisi" };
  const DEFAULT_SERVERS = ["rhel-db01", "rhel-web01", "rhel-app01"];
  const PLACES = [
    { id: "tux", label: "🐧 Tux'un evi", x: 420, z: 1 },
    { id: "road", label: "⚡ MCP otoyolu", x: 1310, z: 0.9 },
    { id: "ship", label: "🚀 Morpheus'un gemisi", x: 2150, z: 1 },
    { id: "mission", label: "🎯 Görev yeri", x: null, z: 1.25 },
    { id: "all", label: "🌍 Tüm evren", x: WW / 2, z: 0.42 },
  ];

  const prefersReduced = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const kindOf = (name) => (/morpheus/i.test(name || "") ? "morpheus" : "unixai");
  const other = (k) => (k === "unixai" ? "morpheus" : "unixai");
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const hash = (n) => { n = Math.sin(n * 127.1) * 43758.5453; return n - Math.floor(n); };
  const CANCEL = Symbol("iptal");

  /* ================================================================== */
  /*  Durum                                                             */
  /* ================================================================== */
  const U = {
    stage: null, cv: null, ctx: null, w: 0, h: 0, dpr: 1, t: 0, last: 0, running: false, effects: true,
    selfKind: "unixai", servers: [], alerts: {}, mission: null, playToken: 0, scripted: false, lastPlay: null,
    statusEl: null, chapterEl: null, statsEl: null, skip: null,
    cam: { x: 420, z: 1, tx: 420, tz: 1, follow: null, manualUntil: 0 },
    orb: null, sparks: [], codeBits: [], items: [], drag: null, forgeHot: false, vaultGlow: false, phoneRing: false,
  };

  function makeChar(kind) {
    return { kind, x: kind === "unixai" ? SPOT.kiosk : SPOT.chair, dir: -1, speed: kind === "unixai" ? 230 : 260,
      target: null, onArrive: null, phase: 0, walking: false, action: kind === "morpheus" ? "sit" : "type", alpha: 1, fade: 0,
      bubble: null, carry: null, idleAt: 0, label: kind === "unixai" ? "UnixAI ajanı" : "MorpheusAI ajanı" };
  }
  const C = { unixai: makeChar("unixai"), morpheus: makeChar("morpheus") };

  /* rastgele ama her açılışta aynı sahne öğeleri */
  const STARS = Array.from({ length: 90 }, (_, i) => ({ x: hash(i) * 1200 - 200, y: hash(i + 99) * 230 - 20, r: hash(i + 7) * 1.4 + 0.3 }));
  const SNOW = Array.from({ length: 130 }, (_, i) => ({ x: hash(i + 300) * 1060 - 120, y: hash(i + 500) * 470, s: 18 + hash(i + 700) * 30, w: hash(i + 900) * 6.28 }));
  const CITY = Array.from({ length: 34 }, (_, i) => ({ x: 760 + i * 34 + hash(i + 40) * 12, w: 22 + hash(i + 60) * 18, h: 90 + hash(i + 80) * 210 }));
  const RAIN_COLS = Array.from({ length: 42 }, (_, i) => ({ x: 930 + i * 19, sp: 60 + hash(i + 11) * 90, off: hash(i + 33) * 400 }));
  const CARS = Array.from({ length: 9 }, (_, i) => ({ p: hash(i + 120), sp: 0.05 + hash(i + 140) * 0.08, dir: i % 2 ? -1 : 1, c: i % 3 ? GREEN : CYAN }));

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
        <canvas class="uv-world" role="img" aria-label="Konuşma evreni: UnixAI ve MorpheusAI ajanlarının dünyası"></canvas>
        <div class="uv-hud">
          <div class="uv-title"><span class="uv-glitch" data-text="KONUŞMA EVRENİ">KONUŞMA EVRENİ</span>
            <small>Tux'un buzul veri merkezi ⇄ MCP otoyolu ⇄ Nebuchadnezzar</small></div>
          <div class="uv-ctrl">
            <span class="uv-stats" id="uvStats"></span>
            <button type="button" class="uv-btn" id="uvReplay" title="Seçili konuşmayı film olarak oynat">▶ Oynat</button>
            <button type="button" class="uv-btn ghost hidden" id="uvSkip" title="Filmi atla">⏭ Atla</button>
            <button type="button" class="uv-btn ghost" id="uvFx" aria-pressed="true"></button>
          </div>
        </div>
        <nav class="uv-places" aria-label="Evrende git">${PLACES.map((p) => `<button type="button" data-place="${p.id}">${p.label}</button>`).join("")}</nav>
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
      stage.querySelectorAll("[data-place]").forEach((b) => (b.onclick = () => goPlace(b.dataset.place)));
      bindDrag();
      fxLabel();
      if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);
      else window.addEventListener("resize", resize);
      resize();
      U.cam.x = U.cam.tx = U.selfKind === "unixai" ? 470 : 2120;
    }
    kick();
    status(`${PROMPTS[U.selfKind]} evren hazır — bir konuşma seçin, düğmelerle gezin veya sahneyi sürükleyin`, true);
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
    if (!U.running && visible()) { U.running = true; U.last = performance.now(); requestAnimationFrame(loop); }
  }
  document.addEventListener("visibilitychange", kick);

  /* ---------------- kamera ---------------- */
  const scale = () => (U.h / WH) * U.cam.z;
  const halfView = () => U.w / 2 / scale();
  function goPlace(id) {
    const p = PLACES.find((x) => x.id === id);
    if (!p) return;
    const target = U.mission || serverList()[0];
    U.cam.follow = null;
    U.cam.manualUntil = performance.now() + 7000;
    flyTo(id === "mission" ? rackX(target) + 40 : p.x, p.z);
    chapter(id === "mission" ? `Görev yeri · ${target} rack'i` : id === "all" ? "Tüm evren" : p.label.replace(/^\S+\s/, ""));
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
    const dt = Math.min(0.05, (now - U.last) / 1000);
    U.last = now;
    if (U.effects) U.t += dt * 1000;
    update(dt, now);
    render();
    if (U.effects) requestAnimationFrame(loop);
    else setTimeout(() => requestAnimationFrame(loop), 250); // hareketsiz modda seyrek çizim
  }

  function update(dt, now) {
    const mv = U.effects ? dt : 0;
    for (const c of Object.values(C)) {
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
    if (U.orb) { // ışınlanma küresi
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
    const hv = halfView();
    cam.x = hv * 2 >= WW ? WW / 2 : clamp(cam.x, hv - 40, WW - hv + 40);
    for (const arr of [U.sparks, U.codeBits]) for (const p of arr) { p.x += p.vx * mv; p.y += p.vy * mv; p.vy += (p.g || 0) * mv; p.life -= mv; }
    U.sparks = U.sparks.filter((p) => p.life > 0);
    U.codeBits = U.codeBits.filter((p) => p.life > 0);
  }

  /** Boştayken ajanlar evlerinde kendi işini yapar */
  function idle(c, now) {
    if (c.target != null || now < c.idleAt) return;
    c.idleAt = now + rnd(5500, 9500);
    if (c.kind === "unixai") {
      const spots = [SPOT.kiosk, SPOT.igloo + 75, ...serverList().map((s) => rackX(s) - 40)];
      const x = spots[(Math.random() * spots.length) | 0];
      c.action = null;
      walkRaw(c, x).then(() => {
        if (U.scripted) return;
        c.action = x === SPOT.kiosk ? "type" : x === SPOT.igloo + 75 ? "wave" : "inspect";
        c.dir = x === SPOT.kiosk ? -1 : 1;
      });
    } else {
      const r = Math.random();
      const x = r < 0.4 ? SPOT.chair : r < 0.75 ? SPOT.console + 10 : rnd(2140, 2380);
      c.action = null;
      walkRaw(c, x).then(() => {
        if (U.scripted) return;
        c.action = x === SPOT.chair ? "sit" : x === SPOT.console + 10 ? "type" : null;
        if (x !== SPOT.chair) c.dir = x === SPOT.console + 10 ? -1 : c.dir;
        else c.dir = -1;
      });
    }
  }

  /* ================================================================== */
  /*  Çizim                                                             */
  /* ================================================================== */
  function render() {
    const ctx = U.ctx;
    ctx.setTransform(U.dpr, 0, 0, U.dpr, 0, 0);
    ctx.fillStyle = "#010604";
    ctx.fillRect(0, 0, U.w, U.h);
    worldTransform(0.45); drawFarLayer(ctx);
    worldTransform(1);
    drawTuxRegion(ctx);
    drawHighway(ctx);
    drawShip(ctx);
    drawItems(ctx);
    drawChar(ctx, C.unixai);
    drawChar(ctx, C.morpheus);
    drawOrb(ctx);
    drawParticles(ctx);
    drawBubble(ctx, C.unixai);
    drawBubble(ctx, C.morpheus);
    drawSnow(ctx);
    ctx.setTransform(U.dpr, 0, 0, U.dpr, 0, 0);
    const g = ctx.createRadialGradient(U.w / 2, U.h / 2, U.h * 0.3, U.w / 2, U.h / 2, U.w * 0.75);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, U.w, U.h);
  }

  const glow = (ctx, color, blur) => { ctx.shadowColor = color; ctx.shadowBlur = blur; };
  const noGlow = (ctx) => { ctx.shadowBlur = 0; };
  function rrect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function text(ctx, s, x, y, font, color, align = "center") { ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.fillText(s, x, y); }

  /* ---------------- uzak katman: Matrix şehri ---------------- */
  function drawFarLayer(ctx) {
    for (const b of CITY) {
      ctx.fillStyle = "#03110a";
      ctx.fillRect(b.x, GROUND - 40 - b.h, b.w, b.h + 40);
      ctx.fillStyle = "rgba(0,255,102,0.22)";
      for (let wy = GROUND - 30 - b.h; wy < GROUND - 50; wy += 11)
        for (let wx = b.x + 4; wx < b.x + b.w - 4; wx += 7)
          if (hash(wx * 3 + wy + Math.floor(U.t / 2500)) > 0.62) ctx.fillRect(wx, wy, 3, 5);
    }
  }

  /* ---------------- Tux'un evi ---------------- */
  const serverList = () => (U.servers.length ? U.servers.slice(0, 5) : DEFAULT_SERVERS);
  function rackX(name) { return 400 + Math.max(0, serverList().indexOf(name)) * 96; }

  function drawTuxRegion(ctx) {
    const sky = ctx.createLinearGradient(0, -200, 0, GROUND);
    sky.addColorStop(0, "#01030d"); sky.addColorStop(1, "#06243a");
    ctx.fillStyle = sky; ctx.fillRect(-400, -400, 1330, GROUND + 400);
    for (const s of STARS) { ctx.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin(U.t / 900 + s.x)); ctx.fillStyle = "#e6f7ff"; ctx.fillRect(s.x, s.y, s.r, s.r); }
    ctx.globalAlpha = 1;
    // kuzey ışıkları
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      for (let x = -300; x <= 1000; x += 20) {
        const y = 40 + k * 28 + Math.sin(x / 140 + U.t / 1800 + k) * 22 + Math.sin(x / 57 + U.t / 1100) * 8;
        x === -300 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = k === 1 ? "rgba(61,245,255,0.16)" : "rgba(0,255,102,0.14)";
      ctx.lineWidth = 26 - k * 6;
      glow(ctx, k === 1 ? CYAN : GREEN, 30);
      ctx.stroke();
    }
    noGlow(ctx);
    // buzdağları
    ctx.fillStyle = "#0f3550";
    ctx.beginPath(); ctx.moveTo(-300, GROUND); ctx.lineTo(-120, GROUND - 160); ctx.lineTo(10, GROUND - 90); ctx.lineTo(140, GROUND - 190); ctx.lineTo(300, GROUND - 70);
    ctx.lineTo(520, GROUND - 140); ctx.lineTo(700, GROUND - 60); ctx.lineTo(860, GROUND - 120); ctx.lineTo(980, GROUND); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "rgba(191,233,255,0.35)"; ctx.lineWidth = 1.5; ctx.stroke();
    // buz zemin
    const gr = ctx.createLinearGradient(0, GROUND, 0, GROUND + 120);
    gr.addColorStop(0, "#2a6688"); gr.addColorStop(1, "#06182a");
    ctx.fillStyle = gr; ctx.fillRect(-400, GROUND, 1360, 260);
    ctx.strokeStyle = ICE; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-400, GROUND); ctx.lineTo(960, GROUND); ctx.stroke();
    // igloo
    const ix = SPOT.igloo;
    ctx.fillStyle = "#d8f1ff";
    ctx.beginPath(); ctx.arc(ix, GROUND, 62, Math.PI, 0); ctx.fill();
    ctx.strokeStyle = "rgba(40,90,120,0.45)"; ctx.lineWidth = 1.2;
    for (const r of [22, 42]) { ctx.beginPath(); ctx.arc(ix, GROUND, r, Math.PI, 0); ctx.stroke(); }
    for (let a = 0; a < 6; a++) { const an = Math.PI + (a + 0.5) * (Math.PI / 6); ctx.beginPath(); ctx.moveTo(ix + Math.cos(an) * 22, GROUND + Math.sin(an) * 22); ctx.lineTo(ix + Math.cos(an) * 62, GROUND + Math.sin(an) * 62); ctx.stroke(); }
    ctx.fillStyle = "#0a1a26"; ctx.beginPath(); ctx.arc(ix + 30, GROUND, 20, Math.PI, 0); ctx.fill();
    ctx.fillStyle = "rgba(255,176,0,0.35)"; ctx.beginPath(); ctx.arc(ix + 30, GROUND, 14, Math.PI, 0); ctx.fill();
    sign(ctx, 4, GROUND - 130, "Tux'un evi", "Linux veri merkezi · /srv", CYAN);
    // kiosk terminali
    const kx = SPOT.kiosk - 46;
    ctx.fillStyle = "#1b2b36"; ctx.fillRect(kx - 3, GROUND - 42, 6, 42);
    ctx.fillStyle = "#050b0f"; rrect(ctx, kx - 34, GROUND - 100, 68, 58, 5); ctx.fill();
    ctx.strokeStyle = CYAN; ctx.lineWidth = 1.5; glow(ctx, CYAN, 8); ctx.stroke(); noGlow(ctx);
    const lines = ["$ uptime", "load 0.42", "$ df -h /u01", "96% /u01 !", "$ journalctl", "-p err ...", "$ vgs", "vg_data 2T"];
    const off = Math.floor(U.t / 700) % lines.length;
    ctx.font = "7px 'Red Hat Mono', monospace"; ctx.textAlign = "left";
    for (let i = 0; i < 6; i++) { const l = lines[(off + i) % lines.length]; ctx.fillStyle = /!/.test(l) ? AMBER : "rgba(0,255,102,0.85)"; ctx.fillText(l, kx - 29, GROUND - 88 + i * 8); }
    // rack'ler
    const list = serverList();
    ctx.fillStyle = "rgba(191,233,255,0.08)"; ctx.fillRect(rackX(list[0]) - 60, GROUND - 4, list.length * 96 + 30, 6);
    list.forEach((name) => drawRack(ctx, rackX(name), name));
  }

  function drawRack(ctx, x, name) {
    const st = U.alerts[name];
    const col = st === "alert" ? RED : st === "pending" ? AMBER : st === "ok" ? GREEN : CYAN;
    ctx.fillStyle = "#070d12"; rrect(ctx, x - 30, GROUND - 176, 60, 176, 4); ctx.fill();
    ctx.strokeStyle = st ? col : "#2a4252"; ctx.lineWidth = st ? 2 : 1.2;
    if (st) glow(ctx, col, 16);
    ctx.stroke(); noGlow(ctx);
    for (let u = 0; u < 9; u++) {
      const y = GROUND - 166 + u * 18;
      ctx.fillStyle = "#101c24"; ctx.fillRect(x - 24, y, 48, 13);
      for (let l = 0; l < 3; l++) {
        const on = hash(u * 7 + l * 13 + x + Math.floor(U.t / (180 + l * 90))) > 0.4;
        ctx.fillStyle = on ? (u === 4 && st === "alert" ? RED : u === 4 && st === "pending" ? AMBER : GREEN) : "#0b2a16";
        ctx.fillRect(x - 20 + l * 5, y + 5, 3, 3);
      }
      ctx.fillStyle = "#1d2e38"; ctx.fillRect(x + 4, y + 4, 16, 5);
    }
    ctx.save(); ctx.translate(x, GROUND - 186); ctx.rotate(U.t / 90);
    ctx.strokeStyle = "#5c7d90"; ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) { ctx.rotate((Math.PI * 2) / 3); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(8, 2); ctx.stroke(); }
    ctx.restore();
    text(ctx, name, x, GROUND + 18, "600 11px 'Red Hat Mono', monospace", st ? col : "rgba(191,233,255,0.85)");
    if (st === "alert" || st === "pending") {
      const by = GROUND - 210 + Math.sin(U.t / 260) * 3;
      glow(ctx, col, 12);
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(x, by - 12); ctx.lineTo(x + 11, by + 8); ctx.lineTo(x - 11, by + 8); ctx.closePath(); ctx.fill(); noGlow(ctx);
      text(ctx, "!", x, by + 6, "800 12px sans-serif", "#000");
    }
  }

  function sign(ctx, x, y, title, sub, color) {
    ctx.font = "8.5px 'Red Hat Mono', monospace";
    const w = Math.max(110, ctx.measureText(sub).width + 18);
    ctx.fillStyle = "#3b2b1c"; ctx.fillRect(x + w / 2 - 2, y + 36, 5, GROUND - y - 36);
    ctx.fillStyle = "rgba(2,14,20,0.92)"; rrect(ctx, x, y, w, 38, 5); ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 1.2; glow(ctx, color, 10); ctx.stroke(); noGlow(ctx);
    text(ctx, title, x + w / 2, y + 16, "700 11px 'Red Hat Display', sans-serif", "#e6ffee");
    text(ctx, sub, x + w / 2, y + 29, "8.5px 'Red Hat Mono', monospace", color);
  }

  function drawSnow(ctx) {
    ctx.fillStyle = "rgba(230,247,255,0.8)";
    for (const f of SNOW) {
      const y = ((f.y + (U.t / 1000) * f.s) % 470) - 60;
      const x = f.x + Math.sin(U.t / 1000 + f.w) * 8;
      if (x < 930) ctx.fillRect(x, y, 1.8, 1.8);
    }
  }

  /* ---------------- MCP otoyolu ---------------- */
  function drawHighway(ctx) {
    ctx.font = "13px 'Red Hat Mono', monospace"; ctx.textAlign = "center";
    for (const col of RAIN_COLS) {
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
    ctx.strokeStyle = GREEN; ctx.lineWidth = 2; glow(ctx, GREEN, 12);
    ctx.beginPath(); ctx.moveTo(GATE_L - 30, y); ctx.lineTo(GATE_R + 30, y); ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = "rgba(0,255,102,0.4)";
    ctx.beginPath(); ctx.moveTo(GATE_L - 30, y + 14); ctx.lineTo(GATE_R + 30, y + 14); ctx.stroke();
    noGlow(ctx);
    ctx.strokeStyle = "rgba(0,255,102,0.35)"; ctx.lineWidth = 1.2;
    for (const px of [1110, 1310, 1510]) {
      ctx.fillStyle = "#04140b"; ctx.fillRect(px - 5, y - 170, 10, 170);
      for (const d of [-1, 1]) { ctx.beginPath(); ctx.moveTo(px, y - 165); ctx.quadraticCurveTo(px + d * 50, y - 70, px + d * 100, y); ctx.stroke(); }
      glow(ctx, RED, 10); ctx.fillStyle = Math.floor(U.t / 600) % 2 ? RED : "#400"; ctx.fillRect(px - 2, y - 176, 4, 4); noGlow(ctx);
    }
    for (const car of CARS) {
      const p = ((car.p + (U.t / 1000) * car.sp * car.dir) % 1 + 1) % 1;
      const x = GATE_L + 40 + p * (GATE_R - GATE_L - 80);
      glow(ctx, car.c, 12);
      ctx.fillStyle = car.c; ctx.fillRect(x - 12, y - 8, 24, 5);
      ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.fillRect(car.dir > 0 ? x + 9 : x - 12, y - 8, 3, 5);
      noGlow(ctx);
      ctx.fillStyle = car.c === GREEN ? "rgba(0,255,102,0.12)" : "rgba(61,245,255,0.12)";
      ctx.fillRect(car.dir > 0 ? x - 52 : x + 12, y - 7, 40, 3);
    }
    text(ctx, "MCP OTOYOLU · POST /mcp · JSON-RPC", (GATE_L + GATE_R) / 2, y + 34, "600 11px 'Red Hat Mono', monospace", "rgba(184,245,200,0.7)");
    drawGate(ctx, GATE_L, CYAN, "unixai /mcp");
    drawGate(ctx, GATE_R, GREEN, "morpheus /mcp");
  }

  function drawGate(ctx, x, color, sub) {
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
    text(ctx, `Bearer ✓ · ${sub}`, x, GROUND - 180 + 22, "8.5px 'Red Hat Mono', monospace", "rgba(184,245,200,0.75)");
  }

  /* ---------------- Nebuchadnezzar ---------------- */
  function drawShip(ctx) {
    const x0 = 1740, x1 = 2900;
    const g = ctx.createLinearGradient(0, -100, 0, GROUND);
    g.addColorStop(0, "#020805"); g.addColorStop(1, "#0a1a12");
    ctx.fillStyle = g; ctx.fillRect(x0, -400, x1 - x0, GROUND + 400);
    const fade = ctx.createLinearGradient(x0 - 60, 0, x0 + 40, 0);
    fade.addColorStop(0, "rgba(10,26,18,0)"); fade.addColorStop(1, "rgba(10,26,18,1)");
    ctx.fillStyle = fade; ctx.fillRect(x0 - 60, -400, 100, GROUND + 400);
    ctx.strokeStyle = "rgba(120,160,130,0.12)"; ctx.lineWidth = 1;
    for (let x = x0 + 30; x < x1; x += 80) { ctx.beginPath(); ctx.moveTo(x, 20); ctx.lineTo(x, GROUND); ctx.stroke(); }
    ctx.fillStyle = "rgba(150,190,160,0.25)";
    for (let x = x0 + 34; x < x1; x += 80) for (let y = 40; y < GROUND; y += 60) ctx.fillRect(x, y, 2, 2);
    ctx.strokeStyle = "#1d3326"; ctx.lineWidth = 12; ctx.beginPath(); ctx.moveTo(x0, 30); ctx.lineTo(x1, 30); ctx.stroke();
    ctx.strokeStyle = "#13261b"; ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(x0, 50); ctx.lineTo(x1, 50); ctx.stroke();
    ctx.strokeStyle = "rgba(30,60,40,0.9)"; ctx.lineWidth = 2;
    for (let i = 0; i < 9; i++) { const cx = x0 + 60 + i * 95; ctx.beginPath(); ctx.moveTo(cx, 50); ctx.quadraticCurveTo(cx + 25, 110 + (i % 3) * 25 + Math.sin(U.t / 1500 + i) * 4, cx + 55, 50); ctx.stroke(); }
    ctx.fillStyle = "#07120c"; ctx.fillRect(x0, GROUND, x1 - x0, 260);
    ctx.strokeStyle = "rgba(0,255,102,0.18)"; ctx.lineWidth = 1;
    for (let x = x0; x < x1; x += 18) { ctx.beginPath(); ctx.moveTo(x, GROUND); ctx.lineTo(x - 10, GROUND + 30); ctx.stroke(); }
    ctx.strokeStyle = "rgba(0,255,102,0.5)"; ctx.beginPath(); ctx.moveTo(x0, GROUND); ctx.lineTo(x1, GROUND); ctx.stroke();
    sign(ctx, 2110, GROUND - 235, "Nebuchadnezzar", "Morpheus'un gemisi · Zion", GREEN);
    drawPhone(ctx, SPOT.phone);
    drawConsole(ctx, SPOT.console);
    drawChair(ctx, SPOT.chair);
    drawForge(ctx, SPOT.forge);
    drawVault(ctx, SPOT.vault);
  }

  function drawPhone(ctx, x) {
    ctx.fillStyle = "#1a1210"; ctx.fillRect(x - 18, GROUND - 60, 36, 60);
    ctx.fillStyle = "#2a1b16"; ctx.fillRect(x - 22, GROUND - 64, 44, 6);
    const ring = U.phoneRing && U.t % 400 < 200;
    ctx.save(); ctx.translate(x + (ring ? Math.sin(U.t / 20) * 1.5 : 0), GROUND - 78);
    ctx.fillStyle = "#0d0d0d"; rrect(ctx, -16, 0, 32, 14, 4); ctx.fill();
    ctx.fillStyle = "#151515"; rrect(ctx, -20, -8, 40, 9, 4); ctx.fill();
    ctx.restore();
    if (ring) { ctx.strokeStyle = GREEN; ctx.lineWidth = 1.5; for (const r of [26, 34]) { ctx.beginPath(); ctx.arc(x, GROUND - 74, r, -2.4, -0.7); ctx.stroke(); } }
    text(ctx, "çıkış ☎", x, GROUND + 18, "9px 'Red Hat Mono', monospace", "rgba(184,245,200,0.75)");
  }

  function drawConsole(ctx, x) {
    ctx.fillStyle = "#0c1a12"; ctx.fillRect(x - 70, GROUND - 46, 140, 46);
    ctx.fillStyle = "#16281d"; ctx.fillRect(x - 76, GROUND - 52, 152, 8);
    for (let m = 0; m < 3; m++) {
      const mx = x - 66 + m * 46, my = GROUND - 128 - (m === 1 ? 14 : 0);
      ctx.fillStyle = "#2f4a38"; ctx.fillRect(mx + 19, my + 34, 4, GROUND - 52 - my - 34);
      ctx.fillStyle = "#000"; rrect(ctx, mx, my, 42, 34, 3); ctx.fill();
      ctx.strokeStyle = "#2f4a38"; ctx.lineWidth = 2; ctx.stroke();
      ctx.save(); ctx.beginPath(); ctx.rect(mx + 2, my + 2, 38, 30); ctx.clip();
      ctx.font = "7px 'Red Hat Mono', monospace"; ctx.textAlign = "center";
      for (let c = 0; c < 6; c++) {
        const head = ((U.t / 1000) * (30 + ((c * 17 + m * 5) % 40)) + c * 20) % 52 - 6;
        for (let k = 0; k < 5; k++) { ctx.fillStyle = `rgba(0,255,102,${0.95 - k * 0.18})`; ctx.fillText(GLYPHS[(c * 3 + k + m + Math.floor(U.t / 150)) % GLYPHS.length], mx + 5 + c * 6.4, my + head - k * 7); }
      }
      ctx.restore();
    }
    text(ctx, "operatör konsolu", x, GROUND + 18, "9px 'Red Hat Mono', monospace", "rgba(184,245,200,0.75)");
  }

  function drawChair(ctx, x) {
    ctx.fillStyle = "#3a1410"; rrect(ctx, x - 30, GROUND - 92, 60, 60, 12); ctx.fill();
    ctx.fillStyle = "#4d1a14";
    rrect(ctx, x - 38, GROUND - 52, 76, 24, 8); ctx.fill();
    rrect(ctx, x - 44, GROUND - 66, 14, 40, 6); ctx.fill();
    rrect(ctx, x + 30, GROUND - 66, 14, 40, 6); ctx.fill();
    ctx.fillStyle = "#1a0a08"; ctx.fillRect(x - 32, GROUND - 28, 6, 28); ctx.fillRect(x + 26, GROUND - 28, 6, 28);
    const tx = x + 74; // kırmızı/mavi hap sehpası
    ctx.fillStyle = "#16281d"; ctx.fillRect(tx - 18, GROUND - 40, 36, 5); ctx.fillRect(tx - 2, GROUND - 36, 4, 36);
    pill(ctx, tx - 7, GROUND - 46 + Math.sin(U.t / 500) * 1.5, RED, 0.2);
    pill(ctx, tx + 8, GROUND - 46 + Math.cos(U.t / 500) * 1.5, "#2d8cff", -0.2);
  }

  function drawForge(ctx, x) {
    const hot = U.forgeHot ? 1 : 0.35 + 0.15 * Math.sin(U.t / 300);
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

  function drawVault(ctx, x) {
    ctx.fillStyle = "#0f1a26"; rrect(ctx, x - 40, GROUND - 110, 80, 110, 6); ctx.fill();
    ctx.strokeStyle = "#2d8cff"; ctx.lineWidth = 2; glow(ctx, "#2d8cff", U.vaultGlow ? 22 : 6); ctx.stroke(); noGlow(ctx);
    ctx.fillStyle = "#2d8cff";
    ctx.beginPath(); ctx.moveTo(x - 22, GROUND - 86); ctx.lineTo(x + 22, GROUND - 86); ctx.lineTo(x + 15, GROUND - 52); ctx.lineTo(x - 15, GROUND - 52); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#0f1a26"; ctx.beginPath(); ctx.moveTo(x - 6, GROUND - 76); ctx.lineTo(x + 6, GROUND - 76); ctx.lineTo(x + 4, GROUND - 62); ctx.lineTo(x - 4, GROUND - 62); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#6fb2ff"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x + 26, GROUND - 40, 8, 0, Math.PI * 2); ctx.stroke();
    text(ctx, "Bitbucket kasası", x, GROUND + 18, "9px 'Red Hat Mono', monospace", "rgba(140,190,255,0.85)");
  }

  function pill(ctx, x, y, color, rot = 0, s = 1) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s);
    glow(ctx, color, 12);
    ctx.fillStyle = color; rrect(ctx, -8, -3.5, 16, 7, 3.5); ctx.fill();
    noGlow(ctx);
    ctx.fillStyle = "rgba(255,255,255,0.55)"; ctx.fillRect(-5, -2, 5, 1.5);
    ctx.restore();
  }

  /* ---------------- eşyalar ---------------- */
  function drawItems(ctx) {
    for (const it of U.items) if (it.kind === "scroll") drawScroll(ctx, it.x, it.y + Math.sin(U.t / 300) * 3, it.score);
  }
  function drawScroll(ctx, x, y, score) {
    glow(ctx, AMBER, 14);
    ctx.fillStyle = "#f1e2b8"; ctx.fillRect(x - 13, y - 9, 26, 18);
    noGlow(ctx);
    ctx.fillStyle = "#c9b27a"; ctx.fillRect(x - 15, y - 10, 4, 20); ctx.fillRect(x + 11, y - 10, 4, 20);
    ctx.fillStyle = "#6b5520"; for (let i = 0; i < 3; i++) ctx.fillRect(x - 8, y - 5 + i * 4, 14 - i * 3, 1.5);
    if (score != null) text(ctx, `uyum ${score}`, x, y - 14, "700 9px 'Red Hat Mono', monospace", GREEN);
  }
  function drawEnvelope(ctx, x, y) {
    glow(ctx, CYAN, 10);
    ctx.fillStyle = "#e9f6ff"; ctx.fillRect(x - 11, y - 7, 22, 14);
    noGlow(ctx);
    ctx.strokeStyle = "#5a8aa8"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x - 11, y - 7); ctx.lineTo(x, y + 1); ctx.lineTo(x + 11, y - 7); ctx.stroke();
  }

  /* ---------------- karakterler ---------------- */
  function drawChar(ctx, c) {
    if (c.alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = c.alpha;
    ctx.translate(c.x, GROUND);
    if (c.kind === "unixai") drawTux(ctx, c); else drawMorpheusChar(ctx, c);
    ctx.restore();
    if (c.alpha > 0.5 && !c.bubble) {
      const top = c.kind === "unixai" ? -88 : c.action === "sit" ? -128 : -164;
      text(ctx, c.label, c.x, GROUND + top, "700 10px 'Red Hat Display', sans-serif", c.kind === "unixai" ? CYAN : GREEN);
    }
  }

  function drawTux(ctx, c) {
    const w = c.walking ? c.phase : 0;
    const bob = c.walking ? Math.abs(Math.sin(w)) * 3 : Math.sin(U.t / 600) * 0.8;
    ctx.scale(c.dir < 0 ? -1 : 1, 1);
    ctx.fillStyle = AMBER; // ayaklar
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
    for (const s of [-1, 1]) { // kanatlar
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
    if (c.action === "inspect") { // büyüteç
      const sway = Math.sin(U.t / 400) * 4;
      ctx.fillStyle = "rgba(61,245,255,0.25)"; ctx.beginPath(); ctx.arc(28 + sway, -58, 7, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#c9d6de"; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(28 + sway, -58, 8, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(22 + sway, -51); ctx.lineTo(16 + sway, -43); ctx.stroke();
    }
    if (c.action === "type") { ctx.fillStyle = "rgba(61,245,255,0.8)"; for (let i = 0; i < 3; i++) if (Math.floor(U.t / 150 + i) % 2) ctx.fillRect(18 + i * 5, -40, 3, 2); }
    if (c.carry === "mail") drawEnvelope(ctx, 0, -92 + Math.sin(U.t / 250) * 2);
    if (c.carry === "scroll") drawScroll(ctx, 0, -94);
  }

  function drawMorpheusChar(ctx, c) {
    const w = c.walking ? c.phase : 0;
    ctx.scale(c.dir < 0 ? -1 : 1, 1);
    ctx.lineCap = "round";
    if (c.action === "sit") { // koltukta oturur
      ctx.translate(0, -26);
      ctx.strokeStyle = "#0c0c0c"; ctx.lineWidth = 7;
      ctx.beginPath(); ctx.moveTo(-6, -24); ctx.lineTo(16, -24); ctx.lineTo(18, 20); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(2, -24); ctx.lineTo(24, -22); ctx.lineTo(26, 20); ctx.stroke();
      coat(ctx, -64, -24, 0);
      head(ctx, -78, c);
      ctx.strokeStyle = "#0f1a14"; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(-8, -56); ctx.lineTo(14, -36); ctx.stroke();
      return;
    }
    const swing = c.walking ? Math.sin(w) * 0.5 : 0;
    ctx.strokeStyle = "#0c0c0c"; ctx.lineWidth = 7; // bacaklar
    for (const s of [1, -1]) {
      const a = swing * s;
      ctx.beginPath(); ctx.moveTo(0, -62); ctx.lineTo(Math.sin(a) * 30, -62 + Math.cos(a) * 30); ctx.lineTo(Math.sin(a) * 32 + 4, -3); ctx.stroke();
      ctx.fillStyle = "#050505"; ctx.beginPath(); ctx.ellipse(Math.sin(a) * 32 + 9, -3, 9, 4, 0, 0, Math.PI * 2); ctx.fill();
    }
    coat(ctx, -112, -34, c.walking ? Math.sin(w) * 6 : Math.sin(U.t / 900) * 1.5);
    ctx.strokeStyle = "#0f1a14"; ctx.lineWidth = 7; // kollar
    const forging = c.action === "forge";
    const armA = forging ? -2.2 + Math.abs(Math.sin(U.t / 160)) * 2.0 : c.action === "type" ? -0.9 + Math.sin(U.t / 120) * 0.1 : c.carry === "pill" ? -1.1 : c.walking ? -swing : 0.1;
    ctx.save(); ctx.translate(6, -104); ctx.rotate(armA);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 40); ctx.stroke();
    if (forging) { ctx.fillStyle = "#6b4a2a"; ctx.fillRect(-2, 36, 4, 22); ctx.fillStyle = "#9aa3a8"; ctx.fillRect(-9, 54, 18, 10); }
    if (c.carry === "pill") pill(ctx, 0, 46, RED, 0, 1.4);
    ctx.restore();
    ctx.save(); ctx.translate(-6, -104); ctx.rotate(c.walking ? swing : c.bubble ? 0.4 + Math.sin(U.t / 200) * 0.2 : 0.05);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 40); ctx.stroke(); ctx.restore();
    head(ctx, -124, c);
    if (c.carry === "scroll") drawScroll(ctx, 0, -156);
    if (c.carry === "mail") drawEnvelope(ctx, 0, -158 + Math.sin(U.t / 250) * 2);
  }

  function coat(ctx, top, bottom, flap) {
    glow(ctx, "rgba(0,255,102,0.35)", 10);
    ctx.fillStyle = "#0a120d";
    ctx.beginPath(); ctx.moveTo(-14, top); ctx.lineTo(14, top); ctx.lineTo(22 + flap, bottom); ctx.lineTo(-20 - flap * 0.5, bottom); ctx.closePath(); ctx.fill();
    noGlow(ctx);
    ctx.strokeStyle = "rgba(0,255,102,0.25)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, top + 4); ctx.lineTo(2, bottom); ctx.stroke();
    ctx.fillStyle = "#13221a"; ctx.beginPath(); ctx.moveTo(-14, top); ctx.lineTo(-4, top + 16); ctx.lineTo(0, top); ctx.lineTo(4, top + 16); ctx.lineTo(14, top); ctx.closePath(); ctx.fill();
  }

  function head(ctx, y, c) {
    ctx.fillStyle = "#3b2a20"; ctx.beginPath(); ctx.arc(2, y, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.12)"; ctx.beginPath(); ctx.arc(-2, y - 5, 5, 0, Math.PI * 2); ctx.fill();
    glow(ctx, GREEN, 6); // pince-nez gözlük
    ctx.fillStyle = "#020"; ctx.beginPath(); ctx.ellipse(4, y - 1, 3.6, 2.8, 0, 0, Math.PI * 2); ctx.ellipse(11, y - 1, 3.6, 2.8, 0, 0, Math.PI * 2); ctx.fill();
    noGlow(ctx);
    ctx.fillStyle = "rgba(0,255,102,0.8)"; ctx.fillRect(3, y - 2, 1.5, 1.2); ctx.fillRect(10, y - 2, 1.5, 1.2);
    if (c.bubble?.kind === "say") { ctx.fillStyle = "#1a0f0a"; ctx.fillRect(6, y + 6, 5, 1 + Math.abs(Math.sin(U.t / 90)) * 2); }
  }

  /* ---------------- konuşma / düşünce balonları ---------------- */
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
    const headY = GROUND + (c.kind === "unixai" ? -96 : c.action === "sit" ? -140 : -176);
    const col = c.kind === "unixai" ? CYAN : GREEN;
    const left = U.cam.x - halfView() + 8, right = U.cam.x + halfView() - 8;
    if (b.kind === "think") {
      const item = b.items[Math.floor((performance.now() - b.t0) / 900) % b.items.length];
      ctx.font = "12px 'Red Hat Mono', monospace";
      const label = "… " + item;
      const w = Math.min(ctx.measureText(label).width + 24, 320);
      const x = clamp(c.x + 10, left, right - w), y = headY - 46;
      ctx.fillStyle = "rgba(4,22,12,0.94)"; ctx.strokeStyle = "rgba(184,245,200,0.7)"; ctx.lineWidth = 1.2;
      rrect(ctx, x, y - 16, w, 26, 13); ctx.fill(); ctx.stroke();
      for (const [dx, dy, r] of [[2, 18, 5], [-4, 28, 3]]) { ctx.beginPath(); ctx.arc(c.x + dx, y + dy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      text(ctx, label, x + 12, y + 1, "12px 'Red Hat Mono', monospace", "#d6ffe4", "left");
      return;
    }
    ctx.font = "12px 'Red Hat Text', sans-serif";
    const shown = U.effects ? Math.min(b.text.length, Math.floor((performance.now() - b.t0) / 24)) : b.text.length;
    const lines = wrap(ctx, b.text.slice(0, shown) || " ", 250, 5);
    const w = Math.max(120, Math.min(276, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 24));
    const h = lines.length * 16 + 28;
    const bx = clamp(c.x - w / 2, left, right - w), by = headY - h - 10;
    ctx.fillStyle = "rgba(2,14,8,0.95)"; ctx.strokeStyle = col; ctx.lineWidth = 1.5;
    glow(ctx, col, 12); rrect(ctx, bx, by, w, h, 8); ctx.fill(); noGlow(ctx); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(c.x - 7, by + h - 1); ctx.lineTo(c.x, by + h + 10); ctx.lineTo(c.x + 7, by + h - 1); ctx.closePath(); ctx.fillStyle = "rgba(2,14,8,0.95)"; ctx.fill();
    text(ctx, PROMPTS[c.kind], bx + 10, by + 15, "600 9px 'Red Hat Mono', monospace", col, "left");
    lines.forEach((l, i) => text(ctx, l, bx + 10, by + 32 + i * 16, "12px 'Red Hat Text', sans-serif", "#e6ffee", "left"));
  }

  /* ---------------- ışınlanma ve parçacıklar ---------------- */
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
    for (const p of U.sparks) { ctx.globalAlpha = clamp(p.life * 2, 0, 1); glow(ctx, AMBER, 8); ctx.fillStyle = AMBER; ctx.fillRect(p.x, p.y, 2.5, 2.5); }
    noGlow(ctx);
    ctx.font = "11px 'Red Hat Mono', monospace"; ctx.textAlign = "center";
    for (const p of U.codeBits) { ctx.globalAlpha = clamp(p.life, 0, 1); ctx.fillStyle = GREEN; ctx.fillText(p.ch, p.x, p.y); }
    ctx.globalAlpha = 1;
  }
  function burstCode(x, top, n = 26) {
    if (!U.effects) return;
    for (let i = 0; i < n; i++) U.codeBits.push({ x: x + rnd(-22, 22), y: GROUND - rnd(0, top), vx: rnd(-10, 10), vy: rnd(-70, -20), life: rnd(0.6, 1.3), ch: GLYPHS[(Math.random() * GLYPHS.length) | 0] });
  }
  function burstSparks(x, y, n = 14) {
    if (!U.effects) return;
    for (let i = 0; i < n; i++) U.sparks.push({ x, y, vx: rnd(-90, 90), vy: rnd(-160, -40), g: 380, life: rnd(0.4, 0.9) });
  }

  /* ================================================================== */
  /*  Senaryo (film)                                                    */
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
    /** Kapıdan ışınlanma: karakterler koda dönüşüp otoyolda akar, diğer kapıdan çıkar */
    const travel = async (chars, toKind, label) => {
      const fromGate = chars[0].x < 1300 ? GATE_L : GATE_R, toGate = toKind === "unixai" ? GATE_L : GATE_R;
      if (fromGate === toGate) return;
      const inward = fromGate === GATE_L ? -1 : 1;
      await Promise.all(chars.map((c, i) => walk(c, fromGate + inward * i * 30)));
      chars.forEach((c) => { c.fade = -1; burstCode(c.x, c.kind === "morpheus" ? 150 : 80); });
      await wait(550);
      const orb = { x: fromGate, from: fromGate, to: toGate, t0: performance.now(), dur: 2600, trail: [], color: chars[0].kind === "unixai" ? CYAN : GREEN, label };
      follow(orb, 0.85);
      chapter("MCP otoyolu");
      await new Promise((r) => { orb.done = r; U.orb = orb; });
      alive();
      U.phoneRing = false;
      const out = toGate === GATE_L ? -1 : 1;
      chars.forEach((c, i) => { c.x = toGate + out * (14 + i * 36); c.dir = out; c.fade = 1; burstCode(c.x, 120); });
      follow(chars[0], 1.1);
      await wait(650);
    };
    return { alive, wait, walk, say, think, follow, travel };
  }

  /** Konuşmayı film olarak oynatır; ayrıntı panelini de adım adım açar */
  async function play(record, detail) {
    if (!record || !detail) return;
    U.lastPlay = { record, detail };
    const token = ++U.playToken;
    if (record.server && !U.servers.includes(record.server)) U.servers = [record.server, ...U.servers].slice(0, 5);
    if (record.server) U.mission = record.server;

    const out = record.direction === "giden";
    const askerK = out ? U.selfKind : kindOf(record.peer) === U.selfKind ? other(U.selfKind) : kindOf(record.peer);
    const answerK = other(askerK);
    const A = C[askerK], B = C[answerK];
    const rems = record.remediations || [];
    const mission = rems.length > 0 && Boolean(record.server);

    // ayrıntı paneli: terminal istemleri
    const msgs = detail.querySelectorAll(".a2a-msg");
    msgs.forEach((m, i) => {
      const k = i === 0 ? askerK : answerK;
      m.classList.add("uv-msg", `uv-${k}`);
      const who = m.querySelector(".a2a-who");
      if (who && !who.querySelector(".uv-prompt")) who.insertAdjacentHTML("afterbegin", `<span class="uv-prompt">${PROMPTS[k]}</span> `);
    });
    const cards = detail.querySelectorAll(".a2a-rem");
    const skipBtn = U.stage?.querySelector("#uvSkip");

    // sahneyi baştan kur
    U.scripted = true;
    U.items = []; U.orb = null; U.forgeHot = false; U.vaultGlow = false; U.phoneRing = false;
    U.sparks = []; U.codeBits = [];
    for (const c of Object.values(C)) Object.assign(c, { target: null, onArrive: null, bubble: null, carry: null, alpha: 1, fade: 0, walking: false });
    Object.assign(C.unixai, { x: SPOT.kiosk, dir: -1, action: "type" });
    Object.assign(C.morpheus, { x: SPOT.chair, dir: -1, action: "sit" });
    U.alerts = {};
    if (record.server) U.alerts[record.server] = "alert";

    const finish = () => {
      U.scripted = false;
      U.cam.follow = null;
      U.forgeHot = false; U.phoneRing = false; U.orb = null;
      if (skipBtn) skipBtn.classList.add("hidden");
      U.skip = null;
      detail.classList.remove("uv-playing");
      msgs.forEach((m) => m.classList.add("uv-in"));
      cards.forEach((r) => r.classList.add("uv-in"));
      if (record.server) U.alerts[record.server] = rems.length ? "pending" : record.ok === false ? "alert" : "ok";
      for (const c of Object.values(C)) { c.bubble = null; c.alpha = 1; c.fade = 0; c.idleAt = performance.now() + 5000; }
    };
    const finalPose = () => {
      if (mission) {
        Object.assign(C.unixai, { x: rackX(record.server) - 46, dir: 1, action: null, target: null });
        Object.assign(C.morpheus, { x: rackX(record.server) + 54, dir: -1, action: null, carry: "pill", target: null });
        flyTo(rackX(record.server), 1.15);
      } else flyTo(askerK === "unixai" ? 470 : 2120, 1);
    };

    if (!U.effects) { // hareketsiz: doğrudan son sahne
      finalPose();
      finish();
      status(`${PROMPTS[askerK]} ${String(record.question || "").slice(0, 90)}`, true);
      return;
    }

    detail.classList.add("uv-playing");
    msgs.forEach((m) => m.classList.remove("uv-in", "uv-decrypt"));
    cards.forEach((r) => r.classList.remove("uv-in"));
    if (skipBtn) skipBtn.classList.remove("hidden");
    U.skip = () => { U.playToken++; finalPose(); finish(); status(`${PROMPTS[U.selfKind]} film atlandı — son sahne`, true); };

    const d = director(token);
    const q = String(record.question || "").replace(/\s+/g, " ").trim();
    const ans = String(record.ok === false ? `Hata: ${record.error || ""}` : record.answer || "").replace(/\s+/g, " ").trim();
    const tools = (record.tools || []).map((t) => String(t).replace(/^.*__/, ""));
    try {
      /* Bölüm 1 — soran ajan evinde */
      d.follow(A, 1.15, askerK === "unixai" ? 90 : -60);
      chapter(`Bölüm 1 · ${HOME_NAME[askerK]}`);
      if (askerK === "unixai") {
        status(`${PROMPTS.unixai} ${record.server ? `ssh ${record.server} — bulgu inceleniyor` : "filo inceleniyor"}`);
        if (record.server) { await d.walk(A, rackX(record.server) - 42); A.dir = 1; A.action = "inspect"; await d.wait(2000); }
        else { A.action = "type"; await d.wait(1400); }
        A.action = null;
        await d.say(A, record.server ? `${record.server}'de bir sorun var. MorpheusAI'ye gidip soralım!` : "MorpheusAI'ye gidip soralım!", 2400);
      } else {
        status(`${PROMPTS.morpheus} operatör konsolunda — UnixAI'ye soru hazırlanıyor`);
        await d.walk(A, SPOT.console + 10); A.dir = -1; A.action = "type";
        await d.wait(1600);
        A.action = null;
        await d.say(A, "Tux'a soralım. Çıkış telefonuna!", 2000);
        await d.walk(A, SPOT.phone + 24); A.dir = -1; U.phoneRing = true;
        await d.wait(900);
      }
      A.carry = "mail";

      /* MCP otoyolu */
      status(`${PROMPTS[askerK]} mcp tools/call ${askerK === "unixai" ? "morpheus_agent_ask" : "unixai_agent_ask"}${record.server ? ` --server ${record.server}` : ""}`);
      await d.travel([A], answerK, `${askerK} → ${answerK} · tools/call`);

      /* Bölüm 2 — karşı ajanın evinde soru */
      chapter(`Bölüm 2 · ${HOME_NAME[answerK]}`);
      if (answerK === "morpheus") {
        d.follow(A, 1.15, 90);
        await d.walk(A, SPOT.chair - 110); A.dir = 1;
        B.action = null; B.dir = -1;
      } else {
        d.follow(A, 1.15, -90);
        B.action = null;
        await d.walk(A, SPOT.kiosk + 80); A.dir = -1; B.dir = 1;
      }
      A.carry = null;
      msgs[0]?.classList.add("uv-in");
      await d.say(A, q);

      /* Düşünme; Tux ise rack'e bakar, Morpheus playbook döver */
      d.follow(B, 1.2);
      status(`${PROMPTS[answerK]} düşünüyor… ${tools.join(", ") || "araç yok"}`);
      await d.think(B, tools, clamp(tools.length * 1000, 2000, 3800));
      if (answerK === "unixai" && record.server) {
        await d.walk(B, rackX(record.server) - 42); B.dir = 1; B.action = "inspect"; await d.wait(1800); B.action = null;
        await d.walk(B, SPOT.kiosk + 150); B.dir = -1;
      }
      if (rems.length && answerK === "morpheus") {
        chapter("Bölüm 3 · Ansible örsünde playbook");
        status(`${PROMPTS.morpheus} morpheus_create_remediation — playbook dövülüyor, standart analizi yapılıyor`);
        d.follow(B, 1.3);
        await d.walk(B, SPOT.forge - 50); B.dir = 1; B.action = "forge"; U.forgeHot = true;
        for (let i = 0; i < 7; i++) { await d.wait(320); burstSparks(SPOT.forge - 8, GROUND - 52); }
        B.action = null; U.forgeHot = false;
        U.items = [{ kind: "scroll", x: SPOT.forge - 14, y: GROUND - 74, score: rems[0].score }];
        status(`${PROMPTS.morpheus} playbook hazır · uyum ${rems[0].score ?? "?"} · ${rems[0].id || ""}`);
        await d.wait(900);
        U.items = []; B.carry = "scroll";
        await d.walk(B, SPOT.chair - 20); B.dir = -1;
      }

      /* Cevap */
      msgs[1]?.classList.add("uv-in", "uv-decrypt");
      d.follow(B, 1.15, answerK === "morpheus" ? -60 : 60);
      status(`${PROMPTS[answerK]} cevap veriyor`);
      await d.say(B, ans || "…");

      /* Bölüm 4 — görev: playbook'la sunucunun yanına gidilir */
      if (mission) {
        chapter(`Bölüm 4 · Görev: ${record.server}`);
        status(`${PROMPTS.morpheus} görev yerine gidiliyor — ${record.server} rack'i (Tux'un veri merkezi)`);
        const mor = C.morpheus, tux = C.unixai;
        if (mor.x > 1300) await d.travel(tux.x > 1300 ? [mor, tux] : [mor], "unixai", `görev → ${record.server}`);
        d.follow({ x: rackX(record.server) }, 1.25);
        await Promise.all([d.walk(tux, rackX(record.server) - 46), d.walk(mor, rackX(record.server) + 54)]);
        tux.dir = 1; mor.dir = -1;
        U.alerts[record.server] = "pending";
        mor.carry = "pill";
        cards.forEach((r) => r.classList.add("uv-in"));
        status(`${PROMPTS.morpheus} playbook hazır — kırmızı hap sizde: onaylarsanız Bitbucket → AAP → check`);
        await d.say(mor, `Playbook hazır (uyum ${rems[0].score ?? "?"}). Kırmızı hapı alırsan AAP'de çalıştırırız. Onayını bekliyorum.`, 4600);
        await d.say(tux, `Ben ${record.server}'in başında bekliyorum. 🐧`, 2400);
      } else {
        cards.forEach((r) => r.classList.add("uv-in"));
        A.carry = null;
        await d.travel([A], askerK, "eve dönüş");
        await d.walk(A, askerK === "unixai" ? SPOT.kiosk : SPOT.chair);
        A.action = askerK === "unixai" ? "type" : "sit"; A.dir = -1;
      }
      d.follow({ x: mission ? rackX(record.server) : A.x }, 1);
      status(`${PROMPTS[U.selfKind]} konuşma tamamlandı${record.durationMs != null ? ` · ${(record.durationMs / 1000).toFixed(1)} sn` : ""}${rems.length ? " · playbook onayınızı bekliyor" : ""}`);
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

  window.Universe = { mount, play, setStats };
})();
