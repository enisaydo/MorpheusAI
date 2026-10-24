/*
 * Konuşma Evreni — ajanlar arası konuşma sayfasının görsel sahnesi
 *   Morpheus (Matrix) ⇄ Linux (Tux): dijital yağmur, MCP ışın yolu, mesaj paketleri, kırmızı hap (playbook)
 *   Yalnızca "ajanlar arası" sayfasında kullanılır. prefers-reduced-motion ve "Efektler" anahtarı animasyonu kapatır.
 *   Bağımlılık yok; MorpheusAI ve UnixAI OS'ta aynı dosya.
 */
(function () {
  "use strict";

  const GREEN = "#00ff66", GREEN_DIM = "rgba(0,255,102,0.35)", RED = "#ff2d55", CYAN = "#3df5ff", AMBER = "#ffb000";
  const GLYPHS = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン0123456789Z:・.=*+-<>¦|";
  const LINUX_WORDS = ["df -h", "lvextend -r", "vgs", "systemctl status", "journalctl -p err", "dnf check-update", "sestatus", "free -m",
    "uptime", "ss -tulpn", "chronyc tracking", "ansible-playbook", "hosts: all", "become: true", "root@rhel", "/u01", "/var/log",
    "kill -9", "grep -i error", "tail -f", "rpm -qa", "lsblk", "xfs_growfs", "ping", "sudo", "#!/bin/bash", "wake up, neo"];
  const PROMPTS = { unixai: "root@unixai:~#", morpheus: "morpheus@zion:~$", other: "agent@mcp:~$" };

  const prefersReduced = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const kindOf = (name) => (/morpheus/i.test(name || "") ? "morpheus" : /unixai|linux/i.test(name || "") ? "unixai" : "other");
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const U = {
    stage: null, rain: null, fx: null, rctx: null, fctx: null, w: 0, h: 0, dpr: 1,
    drops: [], packets: [], bursts: [], servers: [], t: 0, running: false, effects: true, playToken: 0,
    statusEl: null, statsEl: null, last: null, ambientAt: 0, selfKind: "unixai",
  };

  /* ---------------- kurulum ---------------- */
  function mount(stage, opts = {}) {
    if (!stage) return;
    U.selfKind = opts.self || "unixai";
    U.effects = store.get("universe.effects", "on") !== "off" && !prefersReduced();
    if (U.stage !== stage) {
      U.stage = stage;
      stage.innerHTML = `
        <canvas class="uv-rain" aria-hidden="true"></canvas>
        <canvas class="uv-fx" aria-hidden="true"></canvas>
        <div class="uv-hud">
          <div class="uv-title"><span class="uv-glitch" data-text="KONUŞMA EVRENİ">KONUŞMA EVRENİ</span>
            <small>Morpheus ⇄ Linux · MCP üzerinden konuşan iki ajan</small></div>
          <div class="uv-ctrl">
            <span class="uv-stats" id="uvStats"></span>
            <button type="button" class="uv-btn" id="uvReplay" title="Seçili konuşmayı yeniden oynat">▶ Oynat</button>
            <button type="button" class="uv-btn ghost" id="uvFx" aria-pressed="true"></button>
          </div>
        </div>
        <div class="uv-status mono" id="uvStatus" aria-live="polite"></div>`;
      U.rain = stage.querySelector(".uv-rain");
      U.fx = stage.querySelector(".uv-fx");
      U.rctx = U.rain.getContext("2d");
      U.fctx = U.fx.getContext("2d");
      U.statusEl = stage.querySelector("#uvStatus");
      U.statsEl = stage.querySelector("#uvStats");
      stage.querySelector("#uvReplay").onclick = () => U.last && play(U.last.record, U.last.detail);
      stage.querySelector("#uvFx").onclick = () => {
        U.effects = !U.effects;
        store.set("universe.effects", U.effects ? "on" : "off");
        fxLabel();
        if (!U.effects) drawStatic();
      };
      fxLabel();
      if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);
      else window.addEventListener("resize", resize);
      resize();
    }
    if (!U.running) { U.running = true; requestAnimationFrame(loop); }
    status(`${PROMPTS[U.selfKind]} bağlantı hazır — ${U.selfKind === "unixai" ? "MorpheusAI" : "UnixAI"} ajanı MCP üzerinde dinliyor`, true);
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
    for (const c of [U.rain, U.fx]) {
      c.width = Math.round(U.w * U.dpr); c.height = Math.round(U.h * U.dpr);
      c.style.width = U.w + "px"; c.style.height = U.h + "px";
    }
    U.rctx.setTransform(U.dpr, 0, 0, U.dpr, 0, 0);
    U.fctx.setTransform(U.dpr, 0, 0, U.dpr, 0, 0);
    const cols = Math.ceil(U.w / 16);
    U.drops = Array.from({ length: cols }, (_, i) => newDrop(i, true));
    U.rctx.fillStyle = "#010604";
    U.rctx.fillRect(0, 0, U.w, U.h);
    if (!U.effects) drawStatic();
  }

  function newDrop(i, scatter) {
    const word = Math.random() < 0.12 ? LINUX_WORDS[(Math.random() * LINUX_WORDS.length) | 0] : null;
    return { x: i * 16 + 8, y: scatter ? Math.random() * -U.h : -20 - Math.random() * 200, speed: 2 + Math.random() * 4.5, word, idx: 0, bright: Math.random() < 0.08 };
  }

  /* ---------------- geometri ---------------- */
  const nodeScale = () => Math.max(0.72, Math.min(1.1, U.h / 330));
  const nodePos = (kind) => {
    const left = kind === "unixai" || (kind === "other" && U.selfKind === "morpheus");
    const edge = U.w < 640 ? 0.22 : 0.16;
    return { x: U.w * (left ? edge : 1 - edge), y: Math.min(U.h * 0.56, U.h - 58 - 104 * nodeScale()) };
  };
  function curve(t, fromKind) {
    const a = nodePos("unixai"), b = nodePos("morpheus");
    const p0 = fromKind === "unixai" ? a : b, p2 = fromKind === "unixai" ? b : a;
    const c = { x: U.w / 2, y: U.h * 0.06 };
    const u = 1 - t;
    return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p2.y };
  }

  /* ---------------- çizim ---------------- */
  function drawRain() {
    const ctx = U.rctx;
    ctx.fillStyle = "rgba(1,6,4,0.10)";
    ctx.fillRect(0, 0, U.w, U.h);
    ctx.font = "15px 'Red Hat Mono', ui-monospace, monospace";
    ctx.textAlign = "center";
    for (let i = 0; i < U.drops.length; i++) {
      const d = U.drops[i];
      const ch = d.word ? d.word[d.idx % d.word.length] : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      ctx.fillStyle = d.word ? "rgba(61,245,255,0.85)" : d.bright ? "#d8ffe6" : "rgba(0,255,102,0.75)";
      ctx.fillText(ch, d.x, d.y);
      d.y += d.speed * 2.2;
      d.idx++;
      if (d.word && d.idx >= d.word.length) d.word = null;
      if (d.y > U.h + 20 && Math.random() > 0.96) U.drops[i] = newDrop(i, false);
    }
  }

  function glow(ctx, color, blur) { ctx.shadowColor = color; ctx.shadowBlur = blur; }

  function drawBeam(ctx) {
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(0,255,102,0.18)";
    ctx.beginPath();
    for (let i = 0; i <= 60; i++) { const p = curve(i / 60, "unixai"); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); }
    ctx.stroke();
    ctx.setLineDash([4, 14]);
    ctx.lineDashOffset = -U.t * 0.06;
    ctx.strokeStyle = GREEN_DIM;
    glow(ctx, GREEN, 8);
    ctx.stroke();
    ctx.restore();
    const top = curve(0.5, "unixai");
    ctx.save();
    ctx.font = "600 11px 'Red Hat Mono', monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(184,245,200,0.85)";
    ctx.fillText("⇄  MCP · POST /mcp · Bearer  ⇄", top.x, top.y - 10);
    ctx.restore();
  }

  function halo(ctx, p, r, color, speed, dash) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(U.t * speed);
    ctx.setLineDash(dash);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    glow(ctx, color, 12);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  function drawTux(ctx, p, s) {
    ctx.save();
    ctx.translate(p.x, p.y + 2);
    ctx.scale(s, s);
    glow(ctx, "rgba(61,245,255,0.6)", 18);
    // gövde
    ctx.fillStyle = "#0b0f10";
    ctx.beginPath(); ctx.ellipse(0, 6, 26, 32, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(0, -22, 17, 16, 0, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    // karın
    ctx.fillStyle = "#f2f4ef";
    ctx.beginPath(); ctx.ellipse(0, 10, 17, 24, 0, 0, Math.PI * 2); ctx.fill();
    // gözler (göz kırpma)
    const blink = Math.sin(U.t / 900) > 0.985 ? 0.15 : 1;
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.ellipse(-6, -25, 4.5, 6 * blink, 0, 0, Math.PI * 2); ctx.ellipse(6, -25, 4.5, 6 * blink, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#111";
    ctx.beginPath(); ctx.arc(-5, -24, 2 * blink, 0, Math.PI * 2); ctx.arc(7, -24, 2 * blink, 0, Math.PI * 2); ctx.fill();
    // gaga ve ayaklar
    ctx.fillStyle = AMBER;
    ctx.beginPath(); ctx.moveTo(-8, -16); ctx.quadraticCurveTo(0, -10, 8, -16); ctx.quadraticCurveTo(0, -6, -8, -16); ctx.fill();
    ctx.beginPath(); ctx.ellipse(-12, 37, 10, 5, -0.2, 0, Math.PI * 2); ctx.ellipse(12, 37, 10, 5, 0.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawMorpheus(ctx, p, s) {
    const pills = [[RED, 0], ["#2d8cff", Math.PI]].map(([color, off]) => ({ color, a: U.t / 1600 + off }));
    const drawPill = (x) => pill(ctx, p.x + Math.cos(x.a) * 64 * s, p.y + Math.sin(x.a) * 22 * s, x.color, x.a, Math.sin(x.a) > 0 ? 1 : 0.8);
    ctx.save(); ctx.globalAlpha = 0.55; pills.filter((x) => Math.sin(x.a) <= 0).forEach(drawPill); ctx.restore();
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(s, s);
    glow(ctx, "rgba(0,255,102,0.55)", 20);
    // kafa silueti
    ctx.fillStyle = "#07110a";
    ctx.beginPath(); ctx.ellipse(0, -4, 24, 30, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-34, 40); ctx.quadraticCurveTo(0, 14, 34, 40); ctx.lineTo(34, 44); ctx.lineTo(-34, 44); ctx.fill();
    ctx.shadowBlur = 0;
    // pince-nez gözlük
    const lens = (x) => {
      const g = ctx.createRadialGradient(x - 3, -10, 1, x, -8, 10);
      g.addColorStop(0, "rgba(0,255,102,0.9)"); g.addColorStop(0.35, "rgba(0,80,30,0.95)"); g.addColorStop(1, "#000");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(x, -8, 9, 7, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(184,245,200,0.6)"; ctx.lineWidth = 1; ctx.stroke();
    };
    lens(-10); lens(10);
    ctx.strokeStyle = "rgba(184,245,200,0.6)";
    ctx.beginPath(); ctx.moveTo(-1, -9); ctx.lineTo(1, -9); ctx.stroke();
    // lensde akan yeşil kod
    ctx.fillStyle = "rgba(0,255,102,0.8)";
    ctx.font = "6px monospace";
    for (const x of [-10, 10]) ctx.fillText(GLYPHS[((U.t / 120 + x) | 0) % GLYPHS.length], x - 2, -6);
    ctx.restore();
    // yörüngedeki kırmızı/mavi hap (öndekiler)
    pills.filter((x) => Math.sin(x.a) > 0).forEach(drawPill);
  }

  function pill(ctx, x, y, color, rot = 0, scale = 1) {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(rot); ctx.scale(scale, scale);
    glow(ctx, color, 14);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-9, -4, 18, 8, 4) : ctx.rect(-9, -4, 18, 8); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillRect(-6, -2.5, 6, 1.5);
    ctx.restore();
  }

  function drawNode(ctx, kind, label, sub) {
    const p = nodePos(kind);
    const s = nodeScale();
    const col = kind === "unixai" ? CYAN : GREEN;
    halo(ctx, p, 58 * s, col, 0.0006, [2, 6]);
    halo(ctx, p, 70 * s, "rgba(0,255,102,0.25)", -0.0004, [18, 10]);
    if (kind === "unixai") { drawServers(ctx, p, s, false); drawTux(ctx, p, s); drawServers(ctx, p, s, true); }
    else if (kind === "morpheus") drawMorpheus(ctx, p, s);
    else { ctx.save(); glow(ctx, GREEN, 16); ctx.fillStyle = "#07110a"; ctx.beginPath(); ctx.arc(p.x, p.y, 30 * s, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
    ctx.save();
    ctx.textAlign = "center";
    ctx.font = "700 13px 'Red Hat Display', sans-serif";
    ctx.fillStyle = "#e6ffee";
    glow(ctx, col, 8);
    ctx.fillText(label, p.x, p.y + 86 * s);
    ctx.shadowBlur = 0;
    if (U.w >= 560) {
      ctx.font = "11px 'Red Hat Mono', monospace";
      ctx.fillStyle = "rgba(184,245,200,0.7)";
      ctx.fillText(sub, p.x, p.y + 101 * s);
    }
    ctx.restore();
  }

  /** Tux'un etrafında dönen RHEL sunucuları */
  function drawServers(ctx, p, s, frontPass) {
    const list = U.servers.length ? U.servers.slice(0, 6) : ["rhel"];
    list.forEach((name, i) => {
      const a = U.t / 3000 + (i / list.length) * Math.PI * 2;
      const x = p.x + Math.cos(a) * 104 * s, y = p.y + Math.sin(a) * 30 * s - 4;
      const front = Math.sin(a) > 0;
      if (front !== frontPass) return;
      ctx.save();
      ctx.globalAlpha = front ? 1 : 0.45;
      glow(ctx, CYAN, 6);
      ctx.strokeStyle = CYAN; ctx.fillStyle = "rgba(0,20,24,0.9)";
      ctx.fillRect(x - 7, y - 9, 14, 18); ctx.strokeRect(x - 7, y - 9, 14, 18);
      ctx.shadowBlur = 0;
      ctx.fillStyle = (U.t / 300 + i) % 2 < 1 ? GREEN : "#0a3";
      ctx.fillRect(x - 4, y - 5, 2, 2); ctx.fillRect(x - 4, y, 2, 2);
      if (front && U.w > 640) { ctx.font = "9px 'Red Hat Mono', monospace"; ctx.fillStyle = "rgba(184,245,200,0.8)"; ctx.textAlign = "center"; ctx.fillText(name, x, y + 20); }
      ctx.restore();
    });
  }

  function drawPackets(ctx) {
    const now = performance.now();
    U.packets = U.packets.filter((pk) => {
      const raw = (now - pk.t0) / pk.dur;
      if (raw < 0) return true;
      const t = ease(Math.min(1, raw));
      for (let k = 10; k >= 0; k--) {
        const tt = Math.max(0, t - k * 0.012);
        const q = curve(tt, pk.from);
        ctx.save();
        ctx.globalAlpha = (1 - k / 11) * (pk.faint ? 0.35 : 1);
        glow(ctx, pk.color, k ? 6 : 22);
        ctx.fillStyle = k ? pk.color : "#fff";
        ctx.beginPath(); ctx.arc(q.x, q.y, k ? 2.2 : 4.5, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      const q = curve(t, pk.from);
      if (pk.kind === "pill") pill(ctx, q.x, q.y - 12, RED, U.t / 200, 1.2);
      if (pk.label && !pk.faint) {
        ctx.save();
        ctx.font = "11px 'Red Hat Mono', monospace";
        const w = Math.min(ctx.measureText(pk.label).width + 14, U.w * 0.5);
        ctx.fillStyle = "rgba(1,12,6,0.85)";
        ctx.strokeStyle = pk.color;
        ctx.lineWidth = 1;
        const lx = Math.max(8 + w / 2, Math.min(U.w - 8 - w / 2, q.x));
        ctx.fillRect(lx - w / 2, q.y + 12, w, 18); ctx.strokeRect(lx - w / 2, q.y + 12, w, 18);
        ctx.fillStyle = "#e6ffee"; ctx.textAlign = "center";
        ctx.fillText(pk.label.length > 60 ? pk.label.slice(0, 58) + "…" : pk.label, lx, q.y + 25, w - 8);
        ctx.restore();
      }
      if (raw >= 1) {
        const end = curve(1, pk.from);
        U.bursts.push({ x: end.x, y: end.y, t0: now, color: pk.color, faint: pk.faint });
        pk.done?.();
        return false;
      }
      return true;
    });
    U.bursts = U.bursts.filter((b) => {
      const k = (now - b.t0) / 700;
      if (k >= 1) return false;
      ctx.save();
      ctx.globalAlpha = (1 - k) * (b.faint ? 0.3 : 0.9);
      ctx.strokeStyle = b.color; ctx.lineWidth = 2; glow(ctx, b.color, 14);
      ctx.beginPath(); ctx.arc(b.x, b.y, 10 + k * 60, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      return true;
    });
  }

  function drawScene() {
    const ctx = U.fctx;
    ctx.clearRect(0, 0, U.w, U.h);
    drawBeam(ctx);
    drawNode(ctx, "unixai", "UnixAI ajanı", "Linux · RHEL gözlem");
    drawNode(ctx, "morpheus", "MorpheusAI ajanı", "Ansible · AAP · Bitbucket");
    drawPackets(ctx);
    // tarama çizgisi
    const y = (U.t / 18) % (U.h + 60) - 30;
    const g = ctx.createLinearGradient(0, y - 30, 0, y + 30);
    g.addColorStop(0, "rgba(0,255,102,0)"); g.addColorStop(0.5, "rgba(0,255,102,0.05)"); g.addColorStop(1, "rgba(0,255,102,0)");
    ctx.fillStyle = g; ctx.fillRect(0, y - 30, U.w, 60);
  }

  function drawStatic() {
    if (!U.rctx) return;
    U.rctx.fillStyle = "#010604";
    U.rctx.fillRect(0, 0, U.w, U.h);
    U.rctx.font = "15px 'Red Hat Mono', monospace";
    U.rctx.fillStyle = "rgba(0,255,102,0.14)";
    for (let x = 8; x < U.w; x += 16) for (let y = 16; y < U.h; y += 22) if ((x * 7 + y * 13) % 5 === 0) U.rctx.fillText(GLYPHS[(x + y) % GLYPHS.length], x, y);
    U.t = 0;
    drawScene();
  }

  function visible() { return U.stage && U.stage.isConnected && U.stage.offsetParent !== null && !document.hidden; }

  function loop(ts) {
    if (!visible()) { U.running = false; return; }
    if (U.effects) {
      U.t = ts;
      drawRain();
      if (ts - U.ambientAt > 3200 && !U.packets.some((p) => !p.faint)) { // evren boşta da canlı: küçük sinyaller
        U.ambientAt = ts;
        U.packets.push({ from: Math.random() < 0.5 ? "unixai" : "morpheus", t0: performance.now(), dur: 1800, color: Math.random() < 0.5 ? GREEN : CYAN, faint: true });
      }
      drawScene();
    } else if (U.packets.length || U.bursts.length) {
      drawScene();
    }
    requestAnimationFrame(loop);
  }

  /* ---------------- konuşmayı oynat ---------------- */
  function status(text, instant) {
    const el = U.statusEl;
    if (!el) return;
    const tok = (el._tok = (el._tok || 0) + 1);
    if (instant || !U.effects) { el.textContent = text; return; }
    el.textContent = "";
    let i = 0;
    const step = () => { if (el._tok !== tok) return; el.textContent = text.slice(0, ++i) + (i < text.length ? "▌" : ""); if (i < text.length) setTimeout(step, 14); };
    step();
  }

  function sendPacket(from, label, color, kind, dur = 1500) {
    return new Promise((resolve) => {
      if (!U.effects) return resolve();
      U.packets.push({ from, t0: performance.now(), dur, color, label, kind, done: resolve });
      if (!U.running && visible()) { U.running = true; requestAnimationFrame(loop); }
    });
  }

  function typeInto(el, text, token) {
    return new Promise((resolve) => {
      const full = el.innerHTML;
      if (!U.effects) return resolve();
      el.textContent = "";
      let i = 0;
      const chunk = Math.max(1, Math.round(text.length / 90));
      const step = () => {
        if (U.playToken !== token) { el.innerHTML = full; return resolve(); }
        i += chunk;
        el.textContent = text.slice(0, i);
        el.classList.add("uv-typing");
        if (i < text.length) setTimeout(step, 16);
        else { el.innerHTML = full; el.classList.remove("uv-typing"); resolve(); }
      };
      step();
    });
  }

  /** Ayrıntı panelindeki konuşmayı terminal oturumu gibi süsler ve sahnede paketleri gönderir */
  async function play(record, detail) {
    if (!record || !detail) return;
    U.last = { record, detail };
    const token = ++U.playToken;
    if (record.server && !U.servers.includes(record.server)) U.servers.unshift(record.server);
    const selfIsUnix = U.selfKind === "unixai";
    const out = record.direction === "giden";
    const askerKind = out ? U.selfKind : kindOf(record.peer) === "other" ? (selfIsUnix ? "morpheus" : "unixai") : kindOf(record.peer);
    const answerKind = askerKind === "unixai" ? "morpheus" : "unixai";

    const msgs = detail.querySelectorAll(".a2a-msg");
    msgs.forEach((m, i) => {
      const who = m.querySelector(".a2a-who");
      const k = i === 0 ? askerKind : answerKind;
      m.classList.add("uv-msg", `uv-${k}`);
      if (who && !who.querySelector(".uv-prompt")) who.insertAdjacentHTML("afterbegin", `<span class="uv-prompt">${PROMPTS[k]}</span> `);
    });
    const rems = detail.querySelectorAll(".a2a-rem");
    if (!U.effects) { msgs.forEach((m) => m.classList.add("uv-in")); rems.forEach((r) => r.classList.add("uv-in")); return; }
    detail.classList.add("uv-playing");
    msgs.forEach((m) => m.classList.remove("uv-in", "uv-decrypt"));
    rems.forEach((r) => r.classList.remove("uv-in"));

    const q = String(record.question || "").replace(/\s+/g, " ").trim();
    const qBubble = msgs[0]?.querySelector(".bubble");
    msgs[0]?.classList.add("uv-in");
    status(`${PROMPTS[askerKind]} mcp call ${askerKind === "unixai" ? "morpheus_agent_ask" : "unixai_agent_ask"}${record.server ? ` --server ${record.server}` : ""}`);
    await Promise.all([qBubble ? typeInto(qBubble, q, token) : null, sendPacket(askerKind, q, askerKind === "unixai" ? CYAN : GREEN, "q")]);
    if (U.playToken !== token) return;
    status(`${PROMPTS[answerKind]} ${record.ok === false ? "hata döndü" : "düşünüyor… araçlar: " + ((record.tools || []).join(", ") || "—")}`);
    await sleep(500);
    if (U.playToken !== token) return;
    const ans = String(record.ok === false ? record.error : record.answer || "").replace(/\s+/g, " ").trim();
    await sendPacket(answerKind, ans || "…", record.ok === false ? RED : answerKind === "unixai" ? CYAN : GREEN, "a");
    if (U.playToken !== token) return;
    msgs[1]?.classList.add("uv-in", "uv-decrypt");
    const nRem = (record.remediations || []).length;
    if (nRem) {
      status(`${PROMPTS.morpheus} ${nRem} playbook yazıldı — kırmızı hap gönderiliyor (onay bekliyor)`);
      for (const r of rems) {
        await sendPacket("morpheus", `playbook · ${(record.remediations.find((x) => r.textContent.includes(x.id)) || {}).id || ""}`, RED, "pill", 1300);
        if (U.playToken !== token) return;
        r.classList.add("uv-in");
      }
    }
    detail.classList.remove("uv-playing");
    status(`${PROMPTS[U.selfKind]} konuşma tamamlandı${record.durationMs != null ? ` · ${(record.durationMs / 1000).toFixed(1)} sn` : ""}${nRem ? " · playbook onayınızı bekliyor" : ""}`);
  }

  function setStats(items) {
    if (!U.statsEl) return;
    const servers = [...new Set(items.map((x) => x.server).filter(Boolean))];
    U.servers = servers.length ? servers : U.servers;
    const pb = items.reduce((n, x) => n + (x.remediations?.length || 0), 0);
    U.statsEl.innerHTML = `<b>${items.length}</b> konuşma · <b>${pb}</b> playbook · <b>${servers.length}</b> sunucu`;
  }

  window.Universe = { mount, play, setStats };
})();
