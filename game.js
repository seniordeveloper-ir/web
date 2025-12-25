/*
  Tiny offline runner (Chrome-dino vibe) for Senior Developer.
  Controls: Space / ArrowUp / click/tap to jump. R or button to restart.
*/

(() => {
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  const canvas = /** @type {HTMLCanvasElement|null} */ (document.getElementById('runner'));
  const scoreEl = document.getElementById('score');
  const bestEl = document.getElementById('best');
  const restartBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('restart'));

  if (!canvas) return;

  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;

  const EMOJI_FONT_STACK = '"Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji","Segoe UI Symbol",sans-serif';
  // Player uses face emojis (requested): happy while playing, sad on lose.
  const PLAYER_EMOJI_IDLE = '🙂';
  const PLAYER_EMOJI_RUN = '😄';
  const PLAYER_EMOJI_LOSE = '😞';
  const CACTUS_EMOJI = '🌵';

  function measureEmoji(emoji, fontPx) {
    const prevFont = ctx.font;
    ctx.font = `${fontPx}px ${EMOJI_FONT_STACK}`;
    const m = ctx.measureText(emoji);
    ctx.font = prevFont;

    const ascent = Number.isFinite(m.actualBoundingBoxAscent) ? m.actualBoundingBoxAscent : fontPx * 0.78;
    const descent = Number.isFinite(m.actualBoundingBoxDescent) ? m.actualBoundingBoxDescent : fontPx * 0.22;
    const w = Math.max(1, m.width || fontPx);
    const h = Math.max(1, ascent + descent);
    return { w, h, ascent, descent };
  }

  // Crisp drawing on HiDPI
  let lastCssH = 200;
  function fitCanvas() {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const cssW = canvas.clientWidth || canvas.width;
    const cssH = Math.round(cssW * (200 / 640));
    lastCssH = cssH;
    canvas.style.height = `${cssH}px`;

    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Pull theme-ish colors from CSS variables.
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

  // World units are in CSS pixels (not device pixels)
  const world = {
    w: () => canvas.clientWidth || 640,
    h: () => {
      const rectH = canvas.getBoundingClientRect?.().height;
      if (Number.isFinite(rectH) && rectH > 0) return rectH;
      return lastCssH || 200;
    },
  };

  const groundPad = 22;

  const player = {
    x: 46,
    y: 0,
    vy: 0,
    onGround: false,
    emojiIdle: PLAYER_EMOJI_IDLE,
    emojiRun: PLAYER_EMOJI_RUN,
    emojiLose: PLAYER_EMOJI_LOSE,
    fontPx: 30,
    w: 22,
    h: 28,
    jump() {
      if (!this.onGround) return;
      this.vy = -460;
      this.onGround = false;
    },
  };

  /**
   * @type {{
   *  x:number,
   *  y:number,
   *  w:number,
   *  h:number,
   *  glyphs: {emoji:string,size:number,dx:number,w:number,h:number}[]
   * }[]}
   */
  let obstacles = [];
  /** @type {{x:number,y:number,r:number,spd:number}[]} */
  let sparks = [];

  let running = true;
  let started = false;
  let score = 0;
  let best = 0;
  let speed = 260;
  let spawnTimer = 0;
  let last = performance.now();

  const storageKey = 'sd_runner_best';
  try {
    const v = Number(localStorage.getItem(storageKey));
    best = Number.isFinite(v) ? v : 0;
  } catch {
    best = 0;
  }

  function setText(el, value) {
    if (!el) return;
    el.textContent = String(value);
  }

  setText(bestEl, best);
  setText(scoreEl, 0);

  function reset() {
    obstacles = [];
    sparks = [];
    running = true;
    started = false;
    score = 0;
    speed = 260;
    spawnTimer = 0;

    // Measure player faces and keep collision stable by using the max bounds.
    const mIdle = measureEmoji(player.emojiIdle, player.fontPx);
    const mRun = measureEmoji(player.emojiRun, player.fontPx);
    const mLose = measureEmoji(player.emojiLose, player.fontPx);
    const maxW = Math.max(mIdle.w, mRun.w, mLose.w);
    const maxH = Math.max(mIdle.h, mRun.h, mLose.h);
    player.w = Math.max(18, maxW * 0.92);
    player.h = Math.max(22, maxH * 0.92);

    player.vy = 0;
    player.onGround = true;
    player.y = groundY() - player.h;
    setText(scoreEl, 0);
  }

  function groundY() {
    return world.h() - groundPad;
  }

  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function addSpark(x, y, count) {
    if (prefersReducedMotion) return;
    const c = Math.max(6, Math.min(16, count));
    for (let i = 0; i < c; i++) {
      sparks.push({
        x,
        y,
        r: 1.5 + Math.random() * 2.2,
        spd: 120 + Math.random() * 200,
      });
    }
  }

  function spawnObstacle() {
    // Cactus cluster: different sizes ("فونت") and different counts.
    const count = 1 + Math.floor(Math.random() * 3); // 1..3
    const base = 20 + Math.floor(Math.random() * 14); // 20..33
    const gap = 2 + Math.floor(Math.random() * 3); // 2..4

    const glyphs = [];
    let dx = 0;
    let maxH = 0;
    for (let i = 0; i < count; i++) {
      const size = Math.max(18, Math.round(base + (Math.random() * 10 - 5)));
      const m = measureEmoji(CACTUS_EMOJI, size);
      const gw = Math.max(10, m.w);
      const gh = Math.max(14, m.h);
      glyphs.push({ emoji: CACTUS_EMOJI, size, dx, w: gw, h: gh });
      dx += gw + gap;
      maxH = Math.max(maxH, gh);
    }

    const w = Math.max(14, dx - gap);
    const h = Math.max(16, maxH);
    const y = groundY() - h;
    obstacles.push({ x: world.w() + 10, y, w, h, glyphs });
  }

  function update(dt) {
    // Start when the user interacts (so it feels intentional)
    if (!started) {
      player.onGround = true;
      player.y = groundY() - player.h;
      return;
    }

    // Difficulty curve
    speed = Math.min(520, 260 + score * 0.9);

    // Gravity
    const g = 1200;
    player.vy += g * dt;
    player.y += player.vy * dt;

    const gy = groundY();
    if (player.y + player.h >= gy) {
      player.y = gy - player.h;
      player.vy = 0;
      player.onGround = true;
    }

    // Spawn pacing
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnObstacle();
      const minGap = 0.75;
      const maxGap = 1.35;
      spawnTimer = minGap + Math.random() * (maxGap - minGap) + Math.max(0, (520 - speed) / 900);
    }

    // Move obstacles
    for (const o of obstacles) {
      o.x -= speed * dt;
    }
    obstacles = obstacles.filter(o => o.x + o.w > -30);

    // Sparks drift
    for (const s of sparks) {
      s.x -= (speed + s.spd) * dt;
      s.y += (Math.sin(s.x * 0.02) * 10 + 8) * dt;
      s.r *= (1 - 1.8 * dt);
    }
    sparks = sparks.filter(s => s.r > 0.25);

    // Score
    score += dt * 60;
    setText(scoreEl, Math.floor(score));

    // Collision
    const p = { x: player.x, y: player.y, w: player.w, h: player.h };
    for (const o of obstacles) {
      if (rectsOverlap(p, o)) {
        running = false;
        addSpark(player.x + player.w, player.y + player.h - 6, 14);
        if (Math.floor(score) > best) {
          best = Math.floor(score);
          setText(bestEl, best);
          try {
            localStorage.setItem(storageKey, String(best));
          } catch {
            // ignore
          }
        }
        break;
      }
    }
  }

  function draw() {
    const w = world.w();
    const h = world.h();

    ctx.clearRect(0, 0, w, h);

    // Background grid-ish noise (subtle)
    const stroke = cssVar('--stroke', 'rgba(255,255,255,0.12)');
    const muted2 = cssVar('--muted2', 'rgba(255,255,255,0.55)');
    const accent = cssVar('--accent', '#7c3aed');
    const accent2 = cssVar('--accent2', '#22c55e');
    const text = cssVar('--text', 'rgba(255,255,255,0.92)');

    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    for (let x = 12; x < w; x += 38) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    ctx.restore();

    // Ground
    const gy = groundY();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(12, gy + 0.5);
    ctx.lineTo(w - 12, gy + 0.5);
    ctx.stroke();

    // Obstacles
    for (const o of obstacles) {
      // Soft hitbox shadow
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = stroke;
      roundRect(ctx, o.x, o.y + 4, o.w, o.h - 2, 10);
      ctx.fill();
      ctx.restore();

      // Emoji cactus cluster
      ctx.save();
      ctx.textBaseline = 'bottom';
      ctx.textAlign = 'left';
      const baseY = groundY() - 1;
      for (const g of o.glyphs) {
        ctx.font = `${g.size}px ${EMOJI_FONT_STACK}`;
        ctx.fillText(g.emoji, o.x + g.dx, baseY);
      }
      ctx.restore();
    }

    // Player emoji (faces)
    ctx.save();
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.font = `${player.fontPx}px ${EMOJI_FONT_STACK}`;

    // subtle shadow under player
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = stroke;
    roundRect(ctx, player.x + 2, groundY() + 3, Math.max(18, player.w * 0.95), 6, 999);
    ctx.fill();
    ctx.globalAlpha = 1;

    // pick face by state
    const face = !started ? player.emojiIdle : (running ? player.emojiRun : player.emojiLose);

    // Make emoji look punchy (some Linux setups render color emoji a bit washed out)
    // by adding a subtle glow and drawing twice.
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2;
    ctx.fillText(face, player.x, player.y + player.h);
    ctx.restore();

    // Second pass (no shadow) to increase perceived opacity/contrast.
    ctx.fillText(face, player.x, player.y + player.h);
    ctx.restore();

    // Sparks
    if (!prefersReducedMotion) {
      ctx.save();
      ctx.globalAlpha = 0.85;
      for (const s of sparks) {
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Overlays
    ctx.fillStyle = muted2;
    ctx.font = '12px Vazirmatn, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Space/↑/کلیک: پرش', 14, 18);

    if (!started) {
      overlay('برای شروع کلیک کن یا Space را بزن', accent);
      return;
    }

    if (!running) {
      overlay('باختی! R یا «شروع دوباره»', accent);
    }
  }

  function overlay(text, color) {
    const w = world.w();
    const h = canvas.clientHeight || 200;

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.20)';
    roundRect(ctx, 12, Math.round(h * 0.36), w - 24, 54, 14);
    ctx.fill();

    ctx.strokeStyle = cssVar('--stroke', 'rgba(255,255,255,0.12)');
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.font = '700 14px Vazirmatn, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, w / 2, Math.round(h * 0.36) + 33);
    ctx.restore();
  }

  function roundRect(c, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  function start() {
    if (!started) started = true;
    if (!running) return;
  }

  function restart() {
    reset();
    started = true;
  }

  function onJumpIntent() {
    start();
    if (!running) return;
    player.jump();
  }

  // Inputs
  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === ' ' || k === 'ArrowUp' || k === 'w' || k === 'W') {
      e.preventDefault();
      onJumpIntent();
    }
    if (k === 'r' || k === 'R') {
      e.preventDefault();
      restart();
    }
  }, { passive: false });

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    // If game over, first tap restarts; otherwise jump.
    if (!started) {
      started = true;
      return;
    }
    if (!running) {
      restart();
      return;
    }
    onJumpIntent();
  }, { passive: false });

  restartBtn?.addEventListener('click', () => restart());

  // Pause updates when tab hidden (but keep drawing once)
  document.addEventListener('visibilitychange', () => {
    last = performance.now();
  });

  // Init
  fitCanvas();
  reset();

  window.addEventListener('resize', () => {
    fitCanvas();
    // Re-place player on ground
    player.y = groundY() - player.h;
  });

  function loop(now) {
    const dt = Math.min(0.033, Math.max(0, (now - last) / 1000));
    last = now;

    if (running) update(dt);
    draw();

    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);
})();
