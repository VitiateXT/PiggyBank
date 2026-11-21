(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    pig: $('pig'), pigWrap: $('pigWrap'), pigHop: $('pigHop'), liquid: $('liquid'),
    coinsLayer: $('coinsLayer'), pct: $('pct'),
    monthName: $('monthName'), monthText: $('monthText'), goalText: $('goalText'), totalText: $('totalText'),
    notes: $('notes'), coins: $('coins'), typeBtn: $('typeBtn'),
    soundBtn: $('soundBtn'), settingsBtn: $('settingsBtn'),
    settingsDialog: $('settingsDialog'), settingsForm: $('settingsForm'), goalInput: $('goalInput'),
    undoBtn: $('undoBtn'), resetBtn: $('resetBtn'),
    typeDialog: $('typeDialog'), typeForm: $('typeForm'), typeInput: $('typeInput'),
    banner: $('banner'), toast: $('toast'), fx: $('fx'),
  };

  // Every euro coin and note. Sizes are the real ones in millimetres, so the
  // money in the tray keeps its true proportions.
  const MONEY = [
    { cents: 500, kind: 'note', w: 120, h: 62 },
    { cents: 1000, kind: 'note', w: 127, h: 67 },
    { cents: 2000, kind: 'note', w: 133, h: 72 },
    { cents: 5000, kind: 'note', w: 140, h: 77 },
    { cents: 10000, kind: 'note', w: 147, h: 77 },
    { cents: 20000, kind: 'note', w: 153, h: 77 },
    { cents: 1, kind: 'coin', mm: 16.25, metal: 'copper' },
    { cents: 2, kind: 'coin', mm: 18.75, metal: 'copper' },
    { cents: 5, kind: 'coin', mm: 21.25, metal: 'copper' },
    { cents: 10, kind: 'coin', mm: 19.75, metal: 'gold' },
    { cents: 20, kind: 'coin', mm: 22.25, metal: 'gold' },
    { cents: 50, kind: 'coin', mm: 24.25, metal: 'gold' },
    { cents: 100, kind: 'coin', mm: 23.25, metal: '1e' },
    { cents: 200, kind: 'coin', mm: 25.75, metal: '2e' },
  ];
  const BIGGEST_FIRST = [...MONEY].sort((a, b) => b.cents - a.cents);

  const eur0 = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const eur2 = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const eur = (cents) => (cents % 100 === 0 ? eur0 : eur2).format(cents / 100);

  // Liquid surface position in SVG units: below the body = empty, above it = full.
  const EMPTY_Y = 242;
  const FULL_Y = 46;

  let state = { monthly_goal_cents: 100000, total_cents: 0, deposits: [] };

  // ---------- server ----------

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status})`);
    return data;
  }

  // Deposits show up instantly; the saves run one after another in the background.
  let queue = Promise.resolve();
  let pending = 0;
  function sync(request) {
    pending++;
    queue = queue.then(request).then(
      (s) => {
        if (--pending === 0) {
          state = s;
          render();
        }
      },
      async (err) => {
        pending--;
        toast(err.message);
        await reload();
      },
    );
  }

  async function reload() {
    try {
      state = await api('GET', '/api/state');
      render();
    } catch {
      toast("Couldn't reach the piggy bank server");
    }
  }

  // Accepts "250", "12,50", "1.000", "1,234.56", "1.234,56".
  // The last separator is a decimal point only if 1–2 digits follow it.
  function parseCents(raw) {
    const s = String(raw).trim().replace(/[\s'_€]/g, '');
    if (!/^[\d.,]+$/.test(s)) return NaN;
    const m = s.match(/^(.*)[.,](\d{1,2})$/);
    const intPart = (m ? m[1] : s).replace(/[.,]/g, '');
    const num = Number(`${intPart || '0'}${m ? '.' + m[2] : ''}`);
    return Number.isFinite(num) ? Math.round(num * 100) : NaN;
  }

  // ---------- this month ----------

  const monthKey = (d) => d.getFullYear() * 12 + d.getMonth();

  function monthCents() {
    const now = monthKey(new Date());
    let sum = 0;
    for (const d of state.deposits) if (monthKey(new Date(d.at)) === now) sum += d.cents;
    return sum;
  }

  const monthPct = () => (state.monthly_goal_cents > 0 ? (monthCents() / state.monthly_goal_cents) * 100 : 0);

  // ---------- rendering ----------

  function setLevel(pct) {
    const p = Math.max(0, Math.min(100, pct)) / 100;
    els.liquid.style.transform = `translateY(${EMPTY_Y - p * (EMPTY_Y - FULL_Y)}px)`;
    els.pigWrap.classList.toggle('full', pct >= 100);
  }

  function renderNumbers(cents, exact) {
    els.monthText.textContent = exact ? eur(cents) : eur0.format(Math.round(cents / 100));
    const goal = state.monthly_goal_cents;
    els.pct.textContent = `${Math.floor(goal > 0 ? (cents / goal) * 100 : 0)}%`;
  }

  let countRaf = 0;
  let countTarget = 0;
  let shown = 0;
  function countTo(target, duration = 1200) {
    cancelAnimationFrame(countRaf);
    countTarget = target;
    const from = shown;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      shown = from + (target - from) * (1 - Math.pow(1 - t, 3));
      if (t < 1) {
        renderNumbers(shown, false);
        countRaf = requestAnimationFrame(step);
      } else {
        shown = target;
        countRaf = 0;
        renderNumbers(target, true);
        retrigger(els.monthText.parentElement, 'pop');
      }
    };
    countRaf = requestAnimationFrame(step);
  }

  function render() {
    const month = monthCents();
    setLevel(monthPct());
    if (month !== countTarget) countTo(month);
    else if (!countRaf) renderNumbers(month, true);
    els.goalText.textContent = eur(state.monthly_goal_cents);
    els.totalText.textContent = eur(state.total_cents);
    els.monthName.textContent = new Intl.DateTimeFormat(undefined, { month: 'long' }).format(new Date()).toUpperCase();
  }

  // ---------- money visuals ----------

  function moneyEl(m) {
    const el = document.createElement('div');
    if (m.kind === 'note') {
      const v = m.cents / 100;
      el.className = `money note n${v}`;
      el.style.setProperty('--w', m.w);
      el.style.setProperty('--h', m.h);
      el.innerHTML = `<span class="note-corner">${v}</span><span class="note-eur">EURO</span><span class="note-val">${v}</span>`;
    } else {
      const euro = m.cents >= 100;
      el.className = `money coin c-${m.metal}`;
      el.style.setProperty('--mm', m.mm);
      el.innerHTML = `<span class="coin-val">${euro ? m.cents / 100 : m.cents}</span><span class="coin-unit">${euro ? 'EURO' : 'CENT'}</span>`;
    }
    return el;
  }

  function buildTray() {
    MONEY.forEach((m, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'money-btn';
      btn.setAttribute('aria-label', `Put ${eur(m.cents)} in the piggy`);
      const el = moneyEl(m);
      el.style.setProperty('--delay', `${i * 0.7}s`);
      btn.appendChild(el);
      (m.kind === 'note' ? els.notes : els.coins).appendChild(btn);

      btn.addEventListener('pointerdown', (e) => startDrag(e, m, btn));
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
      // Keyboard activation (pointer taps are handled by the drag code).
      btn.addEventListener('click', (e) => {
        if (e.detail === 0) toss(m, btn);
      });
    });
  }

  // ---------- dragging money ----------

  let drag = null;

  function startDrag(e, m, btn) {
    if (drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    sound.unlock();
    btn.setPointerCapture(e.pointerId);
    btn.classList.add('pressed');
    drag = {
      m, btn, id: e.pointerId, x0: e.clientX, y0: e.clientY, lastX: e.clientX,
      touch: e.pointerType !== 'mouse', ghost: null, over: false, tilt: 0,
    };
  }

  function moveDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.ghost) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 8) return;
      drag.ghost = makeGhost(drag.m, drag.btn.firstElementChild.getBoundingClientRect());
      drag.btn.classList.remove('pressed');
      els.pigWrap.classList.add('dragging');
      sound.pickup();
    }
    const g = drag.ghost;
    drag.tilt = Math.max(-25, Math.min(25, drag.tilt * 0.7 + (e.clientX - drag.lastX) * 0.6));
    drag.lastX = e.clientX;
    // On touch, hold the money above the finger so you can see it.
    const y = e.clientY - (drag.touch ? g.h * 0.7 : 0);
    place(g, e.clientX, y, drag.tilt, 1.15);

    const over = overPig(e.clientX, y);
    if (over !== drag.over) {
      drag.over = over;
      els.pigWrap.classList.toggle('eager', over);
    }
  }

  function endDrag(e, cancelled) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    d.btn.classList.remove('pressed');
    els.pigWrap.classList.remove('dragging');
    if (!d.ghost) {
      if (!cancelled) toss(d.m, d.btn); // a tap throws the money in
      return;
    }
    if (!cancelled && d.over) {
      insert(d.ghost, false, () => deposit(d.m));
    } else {
      els.pigWrap.classList.remove('eager');
      flyBack(d.ghost, d.btn);
    }
  }

  addEventListener('pointermove', moveDrag);
  addEventListener('pointerup', (e) => endDrag(e, false));
  addEventListener('pointercancel', (e) => endDrag(e, true));

  function overPig(x, y) {
    const r = els.pigWrap.getBoundingClientRect();
    const pad = 30;
    return x > r.left - pad && x < r.right + pad && y > r.top - pad && y < r.bottom + pad;
  }

  function makeGhost(m, rect) {
    const el = document.createElement('div');
    el.className = 'ghost';
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
    el.appendChild(moneyEl(m));
    document.body.appendChild(el);
    const g = { el, m, w: rect.width, h: rect.height, x: 0, y: 0, r: 0, s: 1 };
    place(g, rect.left + rect.width / 2, rect.top + rect.height / 2, 0, 1);
    return g;
  }

  const tf = (g, x, y, r, s) => `translate(${x - g.w / 2}px, ${y - g.h / 2}px) rotate(${r}deg) scale(${s})`;

  function place(g, x, y, r, s) {
    Object.assign(g, { x, y, r, s });
    g.el.style.transform = tf(g, x, y, r, s);
  }

  function slotInfo() {
    const r = els.coinsLayer.getBoundingClientRect();
    const pig = els.pig.getBoundingClientRect();
    return { x: r.left, y: r.top, w: (pig.width * 64) / 320 };
  }

  // Shrink notes so they fit through the slot.
  const slotScale = (m, w, slot) => Math.min(1, (slot.w * (m.kind === 'note' ? 0.95 : 0.8)) / w);

  // Fly the ghost to the slot, then hand over to an element behind the pig so it
  // looks like the money slides inside.
  function insert(g, arc, onIn) {
    const slot = slotInfo();
    const s = slotScale(g.m, g.w, slot);
    const tx = slot.x;
    const ty = slot.y - (g.h * s) / 2;
    const frames = [{ transform: tf(g, g.x, g.y, g.r, g.s) }];
    if (arc) {
      frames.push({
        transform: tf(g, (g.x + tx) / 2, Math.min(g.y, ty) - 120, g.m.kind === 'note' ? -14 : 200, 1.2),
        offset: 0.5,
      });
    }
    frames.push({ transform: tf(g, tx, ty, arc && g.m.kind === 'coin' ? 360 : 0, s) });
    const anim = g.el.animate(frames, {
      duration: arc ? 560 : 200,
      easing: arc ? 'cubic-bezier(.35,.1,.45,1)' : 'ease-out',
      fill: 'forwards',
    });
    anim.onfinish = () => {
      sinkIntoPig(g.m, g.w, g.h, s, onIn);
      g.el.remove();
    };
  }

  function sinkIntoPig(m, w, h, s, onIn) {
    const el = document.createElement('div');
    el.className = 'sink';
    Object.assign(el.style, { width: `${w}px`, height: `${h}px`, left: `${-w / 2}px`, top: `${-h / 2}px` });
    el.appendChild(moneyEl(m));
    els.coinsLayer.appendChild(el);
    const anim = el.animate(
      [
        { transform: `translateY(${(-h * s) / 2}px) scale(${s})` },
        { transform: `translateY(${(h * s) / 2 + 8}px) scale(${s})` },
      ],
      { duration: m.kind === 'note' ? 260 : 170, easing: 'ease-in', fill: 'forwards' },
    );
    anim.onfinish = () => {
      el.remove();
      landed(m);
      onIn();
    };
  }

  function flyBack(g, btn) {
    const r = btn.firstElementChild.getBoundingClientRect();
    const anim = g.el.animate(
      [
        { transform: tf(g, g.x, g.y, g.r, g.s), opacity: 1 },
        { transform: tf(g, r.left + r.width / 2, r.top + r.height / 2, 0, 1), opacity: 0.4 },
      ],
      { duration: 260, easing: 'ease-in', fill: 'forwards' },
    );
    anim.onfinish = () => g.el.remove();
  }

  // Tap: the money jumps from the tray into the pig.
  function toss(m, btn) {
    sound.unlock();
    sound.pickup();
    const g = makeGhost(m, btn.firstElementChild.getBoundingClientRect());
    insert(g, true, () => deposit(m));
  }

  // ---------- money arrives ----------

  function landed(m) {
    if (m.kind === 'note') sound.paper();
    else sound.coin(m.cents);
    squash(m.kind === 'note' ? 1.1 : 0.8);
    const p = slotInfo();
    fx.sparkle(p.x, p.y, m.kind === 'note' ? 10 : 6);
    makeHappy();
  }

  function deposit(m) {
    addMoney(m.cents);
  }

  function addMoney(cents) {
    const before = monthPct();
    state.deposits = [...state.deposits, { cents, at: new Date().toISOString() }];
    state.total_cents += cents;
    render();
    floatText(`+${eur(cents)}`);
    if (before < 100 && monthPct() >= 100) setTimeout(celebrateGoal, 700);
    sync(() => api('POST', '/api/deposits', { cents }));
  }

  // Typed amounts are paid out in real notes and coins (biggest first).
  function breakdown(cents, max = 12) {
    const out = [];
    let rest = cents;
    for (const m of BIGGEST_FIRST) {
      while (rest >= m.cents && out.length < max) {
        out.push(m);
        rest -= m.cents;
      }
    }
    return out;
  }

  function dropMoney(list) {
    return new Promise((resolve) => {
      const slot = slotInfo();
      let left = list.length;
      list.forEach((m, i) => {
        const w = m.kind === 'note' ? 86 : m.mm * 1.8;
        const h = m.kind === 'note' ? (w * m.h) / m.w : w;
        const s = slotScale(m, w, slot);
        const el = document.createElement('div');
        el.className = 'sink';
        Object.assign(el.style, { width: `${w}px`, height: `${h}px`, left: `${-w / 2}px`, top: `${-h / 2}px` });
        el.appendChild(moneyEl(m));
        els.coinsLayer.appendChild(el);

        const x = (Math.random() - 0.5) * 170;
        const y = -(200 + Math.random() * 90);
        const spin = m.kind === 'coin' ? 360 * (2 + Math.floor(Math.random() * 2)) : 0;
        const tilt = (Math.random() - 0.5) * 50;
        const anim = el.animate(
          [
            { transform: `translate(${x}px, ${y}px) rotate(${tilt}deg) rotateY(0deg) scale(1)`, opacity: 0 },
            { opacity: 1, offset: 0.12 },
            { transform: `translate(0px, ${(-h * s) / 2}px) rotate(0deg) rotateY(${spin}deg) scale(${s})`, opacity: 1, offset: 0.78 },
            { transform: `translate(0px, ${(h * s) / 2 + 8}px) rotate(0deg) rotateY(${spin}deg) scale(${s})`, opacity: 1 },
          ],
          { duration: 820 + Math.random() * 200, delay: i * 120, easing: 'cubic-bezier(.45,0,.85,.55)', fill: 'forwards' },
        );
        anim.onfinish = () => {
          el.remove();
          landed(m);
          if (--left === 0) resolve();
        };
      });
    });
  }

  // ---------- the pig's mood ----------

  let happyTimer = 0;
  let lastHappySound = 0;
  function makeHappy() {
    const already = els.pigWrap.classList.contains('happy');
    els.pigWrap.classList.remove('eager');
    els.pigWrap.classList.add('happy');
    els.pigHop.animate(
      [
        { transform: 'translateY(0)' },
        { transform: 'translateY(-22px)', offset: 0.4 },
        { transform: 'translateY(0)', offset: 0.75 },
        { transform: 'translateY(-5px)', offset: 0.88 },
        { transform: 'translateY(0)' },
      ],
      { duration: 520, easing: 'ease-out' },
    );
    hearts(already ? 1 : 3);
    const now = performance.now();
    if (now - lastHappySound > 700) {
      lastHappySound = now;
      setTimeout(() => sound.happy(), 120);
    }
    clearTimeout(happyTimer);
    happyTimer = setTimeout(() => els.pigWrap.classList.remove('happy'), 1900);
  }

  const HEART = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-10-9.2C.3 8.6 2.1 4.5 6 4.1c2.3-.2 4.4 1.1 6 3 1.6-1.9 3.7-3.2 6-3 3.9.4 5.7 4.5 4 7.7C19.5 16.4 12 21 12 21z"/></svg>';
  function hearts(n) {
    for (let i = 0; i < n; i++) {
      const h = document.createElement('div');
      h.className = 'heart';
      h.innerHTML = HEART;
      h.style.left = `${60 + Math.random() * 22}%`;
      h.style.top = `${18 + Math.random() * 14}%`;
      h.style.setProperty('--dx', `${(Math.random() - 0.3) * 70}px`);
      h.style.animationDelay = `${i * 140}ms`;
      els.pigHop.appendChild(h);
      h.addEventListener('animationend', () => h.remove());
    }
  }

  // ---------- little animation helpers ----------

  function retrigger(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth; // restart the CSS animation
    el.classList.add(cls);
  }

  function shake(el) {
    el.animate(
      [
        { transform: 'translateX(0)' }, { transform: 'translateX(-10px)' }, { transform: 'translateX(10px)' },
        { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' },
      ],
      { duration: 400, easing: 'ease-out' },
    );
  }

  function squash(strength = 1) {
    const s = 0.07 * strength;
    els.pig.animate(
      [
        { transform: 'scale(1, 1)' },
        { transform: `scale(${1 + s}, ${1 - s})` },
        { transform: `scale(${1 - s / 2}, ${1 + s / 2})` },
        { transform: 'scale(1, 1)' },
      ],
      { duration: 340, easing: 'ease-out' },
    );
  }

  function floatText(text) {
    const d = document.createElement('div');
    d.className = 'float-text';
    d.textContent = text;
    els.pigHop.appendChild(d);
    d.addEventListener('animationend', () => d.remove());
  }

  function showBanner(text) {
    els.banner.textContent = text;
    retrigger(els.banner, 'show');
  }

  let toastTimer = 0;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 3200);
  }

  function celebrateGoal() {
    showBanner('GOAL REACHED!');
    fx.confetti();
    sound.fanfare();
    makeHappy();
  }

  // ---------- particles (sparkles + confetti) ----------

  const fx = (() => {
    const canvas = els.fx;
    const ctx = canvas.getContext('2d');
    let parts = [];
    let raf = 0;
    let last = 0;
    let dpr = 1;

    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(innerWidth * dpr);
      canvas.height = Math.round(innerHeight * dpr);
    }
    resize();
    addEventListener('resize', resize);

    function star(r) {
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const rr = i % 2 ? r * 0.38 : r;
        const a = (i * Math.PI) / 4 - Math.PI / 2;
        ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath();
      ctx.fill();
    }

    function loop(now) {
      const dt = last ? Math.min(3, (now - last) / 16.667) : 1;
      last = now;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      parts = parts.filter((p) => p.life > 0);
      for (const p of parts) {
        p.vy += p.g * dt;
        p.vx *= Math.pow(p.drag, dt);
        p.vy *= Math.pow(p.drag, dt);
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        p.life -= dt;
        ctx.save();
        ctx.globalAlpha = Math.min(1, p.life / 25);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.shape === 'star') {
          star(p.size);
        } else {
          ctx.scale(1, Math.cos(p.rot * 2)); // confetti flutter
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        }
        ctx.restore();
      }
      if (parts.length) {
        raf = requestAnimationFrame(loop);
      } else {
        raf = 0;
        last = 0;
      }
    }

    function add(list) {
      parts.push(...list);
      if (!raf) raf = requestAnimationFrame(loop);
    }

    const rand = (a, b) => a + Math.random() * (b - a);
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const GOLD = ['#fff6b0', '#ffd84d', '#ffb400', '#ffffff'];
    const CONFETTI = ['#ffd84d', '#ff5c8a', '#3ddc84', '#4cc9ff', '#b388ff', '#ff9f43', '#ffffff'];

    return {
      sparkle(x, y, n = 8) {
        add(Array.from({ length: n }, () => ({
          x, y,
          vx: rand(-3.5, 3.5), vy: rand(-7, -2.5),
          g: 0.28, drag: 0.98, rot: rand(0, 6), vr: rand(-0.2, 0.2),
          size: rand(4, 9), life: rand(28, 45), color: pick(GOLD), shape: 'star',
        })));
      },
      confetti() {
        const w = innerWidth;
        const h = innerHeight;
        const list = [];
        for (let i = 0; i < 90; i++) {
          list.push({
            x: rand(0, w), y: rand(-60, -10),
            vx: rand(-1.5, 1.5), vy: rand(2, 5),
            g: 0.06, drag: 0.992, rot: rand(0, 6), vr: rand(-0.25, 0.25),
            size: rand(8, 14), life: rand(150, 220), color: pick(CONFETTI), shape: 'rect',
          });
        }
        for (const side of [0, 1]) {
          for (let i = 0; i < 50; i++) {
            list.push({
              x: side ? w + 10 : -10, y: h * 0.75,
              vx: (side ? -1 : 1) * rand(4, 11), vy: rand(-17, -9),
              g: 0.3, drag: 0.985, rot: rand(0, 6), vr: rand(-0.3, 0.3),
              size: rand(8, 14), life: rand(110, 170), color: pick(CONFETTI), shape: 'rect',
            });
          }
        }
        add(list);
      },
    };
  })();

  // ---------- sound (synthesised, no audio files) ----------

  const sound = (() => {
    let ctx = null;
    let noise = null;
    let muted = false;
    try { muted = localStorage.getItem('piggy-muted') === '1'; } catch { /* storage unavailable */ }

    function unlock() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) ctx = new AC();
      }
      if (ctx && ctx.state === 'suspended') ctx.resume();
    }

    const ready = () => !muted && ctx && ctx.state === 'running';

    function tone(freq, start, dur, type, vol, toFreq) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, start);
      if (toFreq) o.frequency.exponentialRampToValueAtTime(toFreq, start + dur * 0.8);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(vol, start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      o.connect(g).connect(ctx.destination);
      o.start(start);
      o.stop(start + dur + 0.05);
    }

    function noiseBuffer() {
      if (!noise) {
        noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.3), ctx.sampleRate);
        const data = noise.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      }
      return noise;
    }

    return {
      unlock,
      get muted() { return muted; },
      toggle() {
        muted = !muted;
        try { localStorage.setItem('piggy-muted', muted ? '1' : '0'); } catch { /* ignore */ }
      },
      pickup() {
        if (!ready()) return;
        tone(700, ctx.currentTime, 0.06, 'triangle', 0.05, 1000);
      },
      coin(cents) {
        if (!ready()) return;
        const t = ctx.currentTime;
        // bigger coins ring a little lower
        const base = 1900 - Math.log10(cents + 1) * 220 + Math.random() * 60;
        tone(base, t, 0.05, 'square', 0.03);
        tone(base * 1.335, t + 0.04, 0.3, 'triangle', 0.12);
      },
      paper() {
        if (!ready()) return;
        const t = ctx.currentTime;
        const src = ctx.createBufferSource();
        src.buffer = noiseBuffer();
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 0.9;
        bp.frequency.setValueAtTime(1400, t);
        bp.frequency.exponentialRampToValueAtTime(5200, t + 0.22);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.3, t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
        src.connect(bp).connect(g).connect(ctx.destination);
        src.start(t);
        src.stop(t + 0.3);
        tone(1568, t + 0.1, 0.35, 'triangle', 0.07);
        tone(2093, t + 0.16, 0.35, 'triangle', 0.05);
      },
      happy() {
        if (!ready()) return;
        const t = ctx.currentTime;
        tone(620, t, 0.12, 'triangle', 0.09, 980);
        tone(820, t + 0.13, 0.18, 'triangle', 0.09, 1320);
      },
      fanfare() {
        if (!ready()) return;
        const t = ctx.currentTime;
        [523, 659, 784, 1047, 784, 1047].forEach((f, i) => {
          const long = i === 5;
          tone(f, t + i * 0.11, long ? 0.7 : 0.16, 'triangle', 0.14);
          tone(f / 2, t + i * 0.11, long ? 0.7 : 0.16, 'square', 0.025);
        });
      },
      drain() {
        if (!ready()) return;
        tone(700, ctx.currentTime, 0.55, 'triangle', 0.12, 140);
      },
    };
  })();

  function renderSoundBtn() {
    els.soundBtn.textContent = sound.muted ? '🔇' : '🔊';
    els.soundBtn.setAttribute('aria-pressed', String(!sound.muted));
  }

  // ---------- dialogs ----------

  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => btn.closest('dialog').close());
  }
  for (const dlg of [els.settingsDialog, els.typeDialog]) {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close(); // tap on the backdrop
    });
  }

  els.settingsBtn.addEventListener('click', () => {
    sound.unlock();
    els.goalInput.value = String(state.monthly_goal_cents / 100);
    const last = state.deposits[state.deposits.length - 1];
    els.undoBtn.disabled = !last;
    els.undoBtn.textContent = last ? `Undo +${eur(last.cents)}` : 'Undo last';
    els.resetBtn.disabled = state.deposits.length === 0;
    els.settingsDialog.showModal();
  });

  els.settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const goal = parseCents(els.goalInput.value);
    if (!(goal > 0)) {
      shake(els.goalInput.parentElement);
      return;
    }
    const before = monthPct();
    els.settingsDialog.close();
    try {
      await queue;
      state = await api('PUT', '/api/settings', { monthly_goal_cents: goal });
      render();
      if (before < 100 && monthPct() >= 100) setTimeout(celebrateGoal, 800);
    } catch (err) {
      toast(err.message);
    }
  });

  els.undoBtn.addEventListener('click', async () => {
    els.settingsDialog.close();
    try {
      await queue;
      state = await api('DELETE', '/api/deposits/last');
      sound.drain();
      render();
    } catch (err) {
      toast(err.message);
    }
  });

  els.resetBtn.addEventListener('click', async () => {
    if (!confirm('Empty the piggy bank? All deposits will be removed.')) return;
    els.settingsDialog.close();
    try {
      await queue;
      state = await api('DELETE', '/api/deposits');
      sound.drain();
      shake(els.pigWrap);
      render();
    } catch (err) {
      toast(err.message);
    }
  });

  els.typeBtn.addEventListener('click', () => {
    sound.unlock();
    els.typeInput.value = '';
    els.typeDialog.showModal();
  });

  let dropping = false;
  els.typeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cents = parseCents(els.typeInput.value);
    if (!(cents > 0) || dropping) {
      shake(els.typeInput.parentElement);
      return;
    }
    els.typeDialog.close();
    dropping = true;
    try {
      await dropMoney(breakdown(cents));
      addMoney(cents);
    } finally {
      dropping = false;
    }
  });

  els.soundBtn.addEventListener('click', () => {
    sound.unlock();
    sound.toggle();
    renderSoundBtn();
  });

  // A new month may have started while the app was in the background.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) render();
  });

  // ---------- start ----------

  buildTray();
  renderSoundBtn();
  render();
  reload(); // the pig fills up from empty on load
})();
