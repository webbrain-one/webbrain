/**
 * WebBrain Agent Visual Indicator (content script)
 *
 * While the agent is operating on this tab it draws:
 *   - an effect around the viewport edges, chosen in Settings → General →
 *     "Agent activity effect" (storage key `agentIndicatorStyle`):
 *       random (default)  — choose a different effect for each run
 *       circuit           — circuit traces grow in from the edges; signals run
 *                           along them and their pads fire neighbouring pads
 *       aurora            — a soft light band drifts around the frame
 *       scan              — corner brackets and a slow scanning beam
 *       gears             — meshing cog trains turn in the corners
 *       classic           — the original pulsing inset glow
 *   - a "Stop WebBrain" floating button,
 *   - the agent cursor and a ring on the element being acted on. The cursor
 *     keeps one size: ahead of each action it glides to the target (the agent
 *     waits for it to land before its input), presses once with a ripple when
 *     the click goes through, and between actions rests where it last acted,
 *     blinking instead of disappearing.
 *
 * Lifecycle messages from the service worker:
 *
 *   WB_SHOW_AGENT_INDICATORS  — agent run started → fade in effect + button
 *   WB_HIDE_AGENT_INDICATORS  — agent run ended → fade out + remove
 *   WB_AGENT_INDICATOR_HEARTBEAT — refresh the active-run lease without
 *                                  changing screenshot visibility
 *   WB_HIDE_FOR_TOOL_USE      — temporarily hide so screenshots don't
 *                                capture our own UI
 *   WB_SHOW_AFTER_TOOL_USE    — restore visibility after the screenshot
 *                                has been captured
 *   WB_SHOW_AGENT_TARGET      — point the cursor at a target. With phase
 *                                'approach' it glides there ahead of the
 *                                input and replies `arriveInMs`; with phase
 *                                'done' it takes the input's verdict.
 *
 * Stop button click → service worker via WB_STOP_AGENT, which calls
 * agent.abort(tabId) the same way the sidepanel's Stop button does.
 *
 * Self-contained — no imports, runs in the page's content-script world.
 * z-index uses the max signed 32-bit range so the indicator sits above
 * site overlays/modals but never accidentally swallows page input: every
 * element is pointer-events: none except the Stop button. Every element is
 * registered in window.__wbPageMonitorDecorations so the page monitor ignores
 * it. Canvas effects animate with requestAnimationFrame and the cursor with
 * CSS transitions and the Web Animations API, because the page monitor
 * observes `style` attributes: a running indicator must not write DOM
 * attributes every frame. prefers-reduced-motion gets still frames.
 */

(function () {
  if (window.__webbrainAgentIndicatorInjected) return;
  window.__webbrainAgentIndicatorInjected = true;

  // How long the target ring and the fully opaque cursor stay after an
  // action before the cursor settles into its resting state.
  const TARGET_RING_TTL_MS = 1400;
  // The background refreshes this lease every 20 seconds. If the background
  // stops before the normal HIDE message, the page-owned UI cleans itself up
  // instead of leaving a permanent effect and Stop button.
  const INDICATOR_HEARTBEAT_TIMEOUT_MS = 65_000;
  const STYLE_STORAGE_KEY = 'agentIndicatorStyle';
  const DEFAULT_STYLE = 'random';
  const STYLES = ['circuit', 'aurora', 'scan', 'gears', 'classic'];

  let effectStyle = DEFAULT_STYLE;
  let runRandomStyle = null;
  let styleLoaded = false;
  let effect = null;
  let stopContainerEl = null;
  let targetOutlineEl = null;
  let cursor = null;
  let targetElement = null;
  let targetRectOverride = null;
  let ringTimer = null;
  let targetRaf = 0;
  let indicatorHeartbeatTimer = null;
  let indicatorsActive = false;
  let suspendedForToolUse = false;
  // Saved visibility state during HIDE_FOR_TOOL_USE so SHOW_AFTER_TOOL_USE
  // can restore the right thing (don't want to show indicators that
  // weren't on before the screenshot).
  let savedStopVisible = false;
  let savedTargetOutlineVisible = false;

  const decorations = () => (window.__wbPageMonitorDecorations ??= new WeakSet());
  const reduceMotionQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };
  const prefersReducedMotion = () => reduceMotionQuery.matches === true;

  function injectStyles() {
    if (document.getElementById('webbrain-agent-styles')) return;
    const style = document.createElement('style');
    style.id = 'webbrain-agent-styles';
    decorations().add(style);
    style.textContent = `
      @keyframes webbrain-pulse {
        0% {
          box-shadow:
            inset 0 0 10px rgba(108, 99, 255, 0.5),
            inset 0 0 20px rgba(108, 99, 255, 0.3),
            inset 0 0 30px rgba(108, 99, 255, 0.1);
        }
        50% {
          box-shadow:
            inset 0 0 15px rgba(108, 99, 255, 0.7),
            inset 0 0 25px rgba(108, 99, 255, 0.5),
            inset 0 0 35px rgba(108, 99, 255, 0.2);
        }
        100% {
          box-shadow:
            inset 0 0 10px rgba(108, 99, 255, 0.5),
            inset 0 0 20px rgba(108, 99, 255, 0.3),
            inset 0 0 30px rgba(108, 99, 255, 0.1);
        }
      }

      @keyframes webbrain-target-ring {
        0%, 100% {
          box-shadow:
            0 0 0 3px rgba(108, 99, 255, 0.18),
            0 0 24px rgba(108, 99, 255, 0.28);
        }
        50% {
          box-shadow:
            0 0 0 6px rgba(108, 99, 255, 0.10),
            0 0 32px rgba(108, 99, 255, 0.38);
        }
      }

      /* The canvas effects and the cursor check this in script; the glow
         and the target ring are CSS, so they hold still here. */
      @media (prefers-reduced-motion: reduce) {
        #webbrain-agent-glow-border { animation: none !important; }
        #webbrain-agent-target-outline {
          animation: none !important;
          transition: opacity 0.35s ease !important;
          box-shadow:
            0 0 0 3px rgba(108, 99, 255, 0.18),
            0 0 24px rgba(108, 99, 255, 0.28) !important;
        }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ------------------------------------------------------------------------
   * Edge effects
   * ---------------------------------------------------------------------- */

  const TAU = Math.PI * 2;
  // WebBrain purples (#6c63ff family) only.
  const C = {
    base: [108, 99, 255],  // #6c63ff accent
    soft: [141, 134, 255], // #8d86ff
    pale: [169, 163, 255], // #a9a3ff
    mist: [199, 195, 255], // #c7c3ff
    deep: [90, 82, 213],   // #5a52d5
    core: [244, 242, 255], // signal highlight
  };
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a <= 0 ? 0 : a >= 1 ? 1 : a.toFixed(4)})`;
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
  const pick = list => list[Math.floor(Math.random() * list.length)];
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
  const easeInOutSine = t => -(Math.cos(Math.PI * t) - 1) / 2;
  const easeOutBack = t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };

  function sprite(color, size, stops) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const r = size / 2;
    const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
    for (const [offset, alpha] of stops) grad.addColorStop(offset, rgba(color, alpha));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    return canvas;
  }

  // Soft inset edge light, a quieter cousin of the classic box-shadow glow.
  function vignette(ctx, w, h, alpha, size) {
    if (alpha <= 0.002) return;
    const s = Math.min(size, w / 2, h / 2);
    for (const [x, y, bw, bh, x0, y0, x1, y1] of [
      [0, 0, w, s, 0, 0, 0, s],
      [0, h - s, w, s, 0, h, 0, h - s],
      [0, 0, s, h, 0, 0, s, 0],
      [w - s, 0, s, h, w, 0, w - s, 0],
    ]) {
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, rgba(C.base, alpha));
      g.addColorStop(0.45, rgba(C.base, alpha * 0.32));
      g.addColorStop(1, rgba(C.base, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x, y, bw, bh);
    }
  }

  function makePath(pts) {
    const n = pts.length;
    const xs = new Float32Array(n), ys = new Float32Array(n), cum = new Float32Array(n);
    let len = 0;
    for (let k = 0; k < n; k++) {
      xs[k] = pts[k][0]; ys[k] = pts[k][1];
      if (k) len += Math.hypot(xs[k] - xs[k - 1], ys[k] - ys[k - 1]);
      cum[k] = len;
    }
    return { xs, ys, cum, len, n };
  }
  function pointAt(p, s, out) {
    if (s <= 0) { out.x = p.xs[0]; out.y = p.ys[0]; return out; }
    if (s >= p.len) { out.x = p.xs[p.n - 1]; out.y = p.ys[p.n - 1]; return out; }
    let k = 1;
    while (k < p.n - 1 && p.cum[k] < s) k++;
    const seg = p.cum[k] - p.cum[k - 1] || 1;
    const u = (s - p.cum[k - 1]) / seg;
    out.x = p.xs[k - 1] + (p.xs[k] - p.xs[k - 1]) * u;
    out.y = p.ys[k - 1] + (p.ys[k] - p.ys[k - 1]) * u;
    return out;
  }
  const subPathPoint = { x: 0, y: 0 };
  function subPath(ctx, p, s0, s1) {
    s0 = clamp(s0, 0, p.len); s1 = clamp(s1, 0, p.len);
    if (s1 - s0 < 0.01) return false;
    pointAt(p, s0, subPathPoint); ctx.moveTo(subPathPoint.x, subPathPoint.y);
    for (let k = 1; k < p.n - 1; k++) if (p.cum[k] > s0 && p.cum[k] < s1) ctx.lineTo(p.xs[k], p.ys[k]);
    pointAt(p, s1, subPathPoint); ctx.lineTo(subPathPoint.x, subPathPoint.y);
    return true;
  }

  // One full-viewport, click-through canvas. Layout properties are !important
  // so page rules such as `canvas { max-width: 100%; height: auto }` cannot
  // resize or reposition it.
  class Layer {
    constructor(id, scale = 1) {
      this.id = id; this.scale = scale;
      this.el = null; this.ctx = null; this.w = 0; this.h = 0;
    }
    mount(root) {
      if (this.el) return;
      const el = document.createElement('canvas');
      el.id = this.id;
      el.setAttribute('aria-hidden', 'true');
      decorations().add(el);
      el.style.cssText = [
        'position: fixed !important', 'top: 0 !important', 'left: 0 !important',
        'right: 0 !important', 'bottom: 0 !important', 'width: 100% !important', 'height: 100% !important',
        'max-width: none !important', 'max-height: none !important', 'margin: 0 !important',
        'padding: 0 !important', 'border: 0 !important', 'transform: none !important',
        'background: transparent !important', 'pointer-events: none !important',
        'z-index: 2147483646 !important', 'display: none !important',
        'opacity: 0', 'transition: opacity 0.45s ease',
      ].join('; ');
      root.appendChild(el);
      this.el = el;
      this.ctx = el.getContext('2d');
    }
    setDisplay(on) { this.el?.style.setProperty('display', on ? 'block' : 'none', 'important'); }
    fit() {
      const w = this.el.clientWidth, h = this.el.clientHeight;
      if (!w || !h) return false;
      const ratio = Math.min(window.devicePixelRatio || 1, 2) * this.scale;
      const pw = Math.max(1, Math.round(w * ratio)), ph = Math.max(1, Math.round(h * ratio));
      const changed = pw !== this.el.width || ph !== this.el.height || w !== this.w || h !== this.h;
      this.w = w; this.h = h;
      if (pw !== this.el.width) this.el.width = pw;
      if (ph !== this.el.height) this.el.height = ph;
      this.ctx.setTransform(pw / w, 0, 0, ph / h, 0, 0);
      return changed;
    }
    clear() {
      if (!this.ctx) return;
      this.ctx.save();
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.clearRect(0, 0, this.el.width, this.el.height);
      this.ctx.restore();
    }
    remove() { this.el?.remove(); this.el = null; this.ctx = null; }
  }

  class Effect {
    constructor() {
      this.layers = [];
      this.active = false; this.mounted = false; this.suspended = false;
      this.raf = 0; this.t = 0; this.last = 0; this.acc = 0; this.w = 0; this.h = 0;
      this.minFrame = 0; // seconds between drawn frames; 0 = every display frame
      this.hideTimer = 0; this.fitRaf = 0;
      this.onResize = () => this.requestFit();
    }
    get still() { return prefersReducedMotion(); }
    mount(root) {
      if (this.mounted) return;
      for (const layer of this.layers) layer.mount(root);
      this.mounted = true;
      window.addEventListener('resize', this.onResize);
    }
    requestFit() {
      if (this.fitRaf || !this.active) return;
      this.fitRaf = requestAnimationFrame(() => { this.fitRaf = 0; this.fit(false); });
    }
    fit(fresh) {
      let changed = false;
      for (const layer of this.layers) changed = layer.fit() || changed;
      const first = this.layers[0];
      if (!first.w) return;
      this.w = first.w; this.h = first.h;
      if (changed || fresh) this.layout(first.w, first.h, fresh);
      if (this.active && !this.raf) this.draw(0);
    }
    show(root) {
      this.mount(root);
      clearTimeout(this.hideTimer);
      const wasActive = this.active;
      this.active = true;
      if (!this.suspended) for (const layer of this.layers) layer.setDisplay(true);
      if (!wasActive) { this.t = 0; this.onShow(); this.fit(true); }
      this.loop();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (this.active) for (const layer of this.layers) if (layer.el) layer.el.style.opacity = '1';
      }));
    }
    hide() {
      if (!this.active) return;
      this.active = false;
      for (const layer of this.layers) if (layer.el) layer.el.style.opacity = '0';
      clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => {
        if (this.active) return;
        this.halt();
        for (const layer of this.layers) { layer.clear(); layer.setDisplay(false); }
      }, 500);
    }
    // Screenshot capture: hide instantly and stop drawing, then continue.
    suspend() {
      this.suspended = true;
      for (const layer of this.layers) layer.setDisplay(false);
      this.halt();
    }
    resume() {
      this.suspended = false;
      if (!this.active) return;
      for (const layer of this.layers) layer.setDisplay(true);
      this.fit(false);
      this.loop();
    }
    loop() {
      if (this.raf || this.suspended || !this.active) return;
      if (this.still) { this.draw(0); return; }
      this.last = performance.now();
      this.acc = 0;
      const tick = now => {
        this.raf = requestAnimationFrame(tick);
        this.acc += Math.max((now - this.last) / 1000, 0);
        this.last = now;
        if (this.acc < this.minFrame - 0.002) return;
        const dt = Math.min(this.acc, 1 / 20);
        this.acc = 0;
        this.t += dt;
        this.step(dt);
        this.draw(dt);
      };
      this.raf = requestAnimationFrame(tick);
    }
    halt() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }
    refreshMotion() { if (!this.active) return; this.halt(); this.loop(); }
    destroy() {
      this.halt();
      clearTimeout(this.hideTimer);
      if (this.fitRaf) cancelAnimationFrame(this.fitRaf);
      this.fitRaf = 0;
      window.removeEventListener('resize', this.onResize);
      for (const layer of this.layers) layer.remove();
      this.mounted = false; this.active = false;
    }
    onShow() {}
    layout() {}
    step() {}
    draw() {}
    target() {}
  }

  /* circuit: traces on a grid (orthogonal and 45° runs, no crossings) grow in
     from every edge. Signals travel them; pads flash when hit and fire
     neighbouring pads through faint synapse links in short cascades. */
  class NeuralCircuit extends Effect {
    constructor() {
      super();
      this.layer = new Layer('webbrain-agent-effect', 1);
      this.layers = [this.layer];
      this.cache = document.createElement('canvas');
      this.sprHead = sprite(C.soft, 64, [[0, 1], [0.18, 0.7], [0.45, 0.18], [1, 0]]);
      this.sprCore = sprite(C.core, 32, [[0, 1], [0.35, 0.65], [1, 0]]);
      this.sprFlash = sprite(C.base, 96, [[0, 0.9], [0.22, 0.45], [0.55, 0.1], [1, 0]]);
      this.traces = []; this.pads = []; this.vias = []; this.links = []; this.pulses = []; this.edges = [];
      this.bands = null; this.rx = 1; this.ry = 1;
      this.spawnAcc = 0; this.intro = 0; this.introDur = 1.4; this.maxPulses = 56; this.rate = 8;
      this.tmpA = { x: 0, y: 0 }; this.tmpB = { x: 0, y: 0 }; this.heads = [];
    }
    onShow() { this.intro = 0; this.pulses.length = 0; this.spawnAcc = 0; }
    layout(w, h, fresh) {
      const g = 8;
      const cols = Math.max(6, Math.round(w / g)), rows = Math.max(6, Math.round(h / g));
      const sx = w / cols, sy = h / rows;
      const depthPx = clamp(Math.min(w, h) * 0.13, 50, 130);
      const maxCells = Math.max(4, Math.round(depthPx / Math.max(sx, sy)));
      this.depthPx = depthPx;
      const W1 = cols + 1;
      const occ = new Int32Array(W1 * (rows + 1)).fill(-1);
      const inside = (i, j) => i >= 0 && j >= 0 && i <= cols && j <= rows;
      const interior = (i, j) => i > 0 && j > 0 && i < cols && j < rows;
      const clearAt = (i, j, id) => {
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (!inside(ii, jj)) continue;
          const o = occ[jj * W1 + ii];
          if (o !== -1 && o !== id) return false;
        }
        return true;
      };
      const mark = (i, j, id) => { occ[j * W1 + i] = id; };
      const unmark = cells => { for (const [i, j] of cells) occ[j * W1 + i] = -1; };
      const edges = [
        { len: cols, at: k => [k, 0], inw: [0, 1], alg: [1, 0], dep: (i, j) => j },
        { len: cols, at: k => [k, rows], inw: [0, -1], alg: [1, 0], dep: (i, j) => rows - j },
        { len: rows, at: k => [0, k], inw: [1, 0], alg: [0, 1], dep: i => i },
        { len: rows, at: k => [cols, k], inw: [-1, 0], alg: [0, 1], dep: i => cols - i },
      ];
      this.edges = edges;
      const route = (e, i, j, plan, id, maxD) => {
        const cells = [];
        for (const [[dx, dy], n] of plan) {
          let moved = 0;
          for (let s = 0; s < n; s++) {
            const ni = i + dx, nj = j + dy;
            if (!interior(ni, nj) || e.dep(ni, nj) > maxD || !clearAt(ni, nj, id)) break;
            i = ni; j = nj; mark(i, j, id); cells.push([i, j]); moved++;
          }
          if (moved < n) break;
        }
        return cells;
      };

      const raw = [];
      let id = 0;
      for (const e of edges) {
        const [ix, iy] = e.inw, [ax, ay] = e.alg;
        let k = randInt(2, 4);
        while (k <= e.len - 2) {
          const [i0, j0] = e.at(k);
          if (Math.random() < 0.74 && clearAt(i0, j0, id)) {
            mark(i0, j0, id);
            const side = Math.random() < 0.5 ? -1 : 1;
            const diag = [ix + side * ax, iy + side * ay];
            const par = [side * ax, side * ay];
            const back = [ix - side * ax, iy - side * ay];
            const r = Math.random();
            const plan = [[[ix, iy], randInt(2, 6)]];
            if (r < 0.38) plan.push([diag, randInt(1, 4)], [[ix, iy], randInt(1, 6)]);
            else if (r < 0.72) plan.push([diag, randInt(1, 3)], [par, randInt(3, 10)]);
            else if (r < 0.88) plan.push([diag, randInt(2, 4)], [back, randInt(1, 3)], [[ix, iy], randInt(1, 3)]);
            else plan.push([[ix, iy], randInt(2, 7)]);
            const maxD = Math.max(3, Math.round(maxCells * rand(0.45, 1)));
            const cells = route(e, i0, j0, plan, id, maxD);
            if (cells.length >= 3) {
              raw.push({ id, edge: e, side, cells: [[i0, j0], ...cells] });
              id++;
              k += randInt(2, 6);
              continue;
            }
            unmark(cells);
            occ[j0 * W1 + i0] = -1;
          }
          k += randInt(1, 3);
        }
      }
      for (const tr of raw) {
        if (tr.cells.length < 7 || Math.random() > 0.36) continue;
        const m = randInt(2, tr.cells.length - 4);
        const [bi, bj] = tr.cells[m];
        const e = tr.edge, s = -tr.side;
        const [ix, iy] = e.inw, [ax, ay] = e.alg;
        const plan = Math.random() < 0.55
          ? [[[ix + s * ax, iy + s * ay], randInt(2, 4)], [[ix, iy], randInt(1, 4)]]
          : [[[ix + s * ax, iy + s * ay], 1], [[s * ax, s * ay], randInt(2, 6)]];
        const cells = route(e, bi, bj, plan, tr.id, maxCells);
        if (cells.length >= 3) tr.branch = { at: m, cells: [[bi, bj], ...cells] };
        else unmark(cells);
      }

      const px = ([i, j]) => [i * sx, j * sy];
      const simplify = cells => {
        if (cells.length < 3) return cells.slice();
        const out = [cells[0]];
        for (let k = 1; k < cells.length - 1; k++) {
          const a = cells[k - 1], b = cells[k], c = cells[k + 1];
          if (b[0] - a[0] !== c[0] - b[0] || b[1] - a[1] !== c[1] - b[1]) out.push(b);
        }
        out.push(cells[cells.length - 1]);
        return out;
      };
      const depthAlpha = (x, y) => lerp(0.62, 0.16, clamp(Math.min(x, y, w - x, h - y) / depthPx, 0, 1));
      const traces = [], pads = [], vias = [], links = [];
      for (const r of raw) {
        const pts = simplify(r.cells).map(px);
        pts[0] = [pts[0][0] - r.edge.inw[0] * 3, pts[0][1] - r.edge.inw[1] * 3]; // start just off-screen
        const path = makePath(pts);
        const end = pts[pts.length - 1];
        const neuron = Math.random() < 0.17;
        const tr = {
          edge: r.edge, path, lw: Math.random() < 0.22 ? 1.6 : 1.1,
          along: r.edge.alg[0] ? pts[0][0] : pts[0][1], x0: pts[0][0], y0: pts[0][1],
          delay: rand(0, 0.34), grow: clamp(path.len / 230, 0.22, 0.72), booted: false, branch: null,
        };
        tr.pad = { x: end[0], y: end[1], r: neuron ? rand(2.7, 3.3) : rand(1.6, 2.2), neuron, flash: 0, links: [], trace: tr, branch: null, a: depthAlpha(end[0], end[1]) };
        pads.push(tr.pad);
        for (let k = 1; k < pts.length - 1; k++) if (Math.random() < 0.16) vias.push({ x: pts[k][0], y: pts[k][1], a: depthAlpha(pts[k][0], pts[k][1]) * 0.9 });
        if (r.branch) {
          let s = 3;
          for (let k = 1; k <= r.branch.at; k++) s += Math.hypot((r.cells[k][0] - r.cells[k - 1][0]) * sx, (r.cells[k][1] - r.cells[k - 1][1]) * sy);
          const bpts = simplify(r.branch.cells).map(px);
          const bpath = makePath(bpts);
          const bend = bpts[bpts.length - 1];
          const br = { path: bpath, s, booted: false };
          br.t0 = tr.delay + (1 - Math.cbrt(1 - clamp(s / path.len, 0, 0.999))) * tr.grow;
          br.grow = clamp(bpath.len / 230, 0.18, 0.5);
          br.pad = { x: bend[0], y: bend[1], r: rand(1.5, 2), neuron: false, flash: 0, links: [], trace: tr, branch: br, a: depthAlpha(bend[0], bend[1]) };
          pads.push(br.pad);
          tr.branch = br;
        }
        traces.push(tr);
      }
      for (let a = 0; a < pads.length; a++) {
        const A = pads[a];
        for (let b = a + 1; b < pads.length; b++) {
          const B = pads[b];
          if (A.trace === B.trace || A.links.length > 1 || B.links.length > 1) continue;
          const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy);
          if (d < 16 || d > 54 || Math.random() < 0.4) continue;
          const bend = rand(-0.35, 0.35) * d;
          const cx = (A.x + B.x) / 2 - (dy / d) * bend, cy = (A.y + B.y) / 2 + (dx / d) * bend;
          const pts = [];
          for (let q = 0; q <= 12; q++) {
            const t = q / 12, u = 1 - t;
            pts.push([u * u * A.x + 2 * u * t * cx + t * t * B.x, u * u * A.y + 2 * u * t * cy + t * t * B.y]);
          }
          const link = { a: A, b: B, path: makePath(pts), alpha: Math.min(A.a, B.a) };
          A.links.push(link); B.links.push(link); links.push(link);
        }
      }
      this.traces = traces; this.pads = pads; this.vias = vias; this.links = links;
      this.introDur = Math.max(0.6, ...traces.map(t => Math.max(t.delay + t.grow, t.branch ? t.branch.t0 + t.branch.grow : 0))) + 0.3;
      this.rate = (w + h) * 2 / 520;
      this.pulses.length = 0;
      if (!fresh) this.intro = Infinity;

      const cacheCtx = this.cache.getContext('2d');
      for (const tr of traces) { tr.gMain = this.depthGrad(this.layer.ctx, tr); tr.gCache = this.depthGrad(cacheCtx, tr); }
      this.paintCache();

      // Everything this effect draws stays within `band` of an edge, so only
      // those four strips are cleared and composited (in whole device pixels,
      // so the cache copies 1:1).
      const W = this.layer.el.width, H = this.layer.el.height;
      this.rx = W / w; this.ry = H / h;
      const band = depthPx + 40;
      const bx = Math.ceil(band * this.rx), by = Math.ceil(band * this.ry);
      this.bands = 2 * bx >= W || 2 * by >= H
        ? [[0, 0, W, H]]
        : [[0, 0, W, by], [0, H - by, W, by], [0, by, bx, H - 2 * by], [W - bx, by, bx, H - 2 * by]];
    }
    depthGrad(ctx, tr) {
      const [ix, iy] = tr.edge.inw;
      const x0 = ix ? (ix > 0 ? 0 : this.w) : tr.x0;
      const y0 = iy ? (iy > 0 ? 0 : this.h) : tr.y0;
      const g = ctx.createLinearGradient(x0, y0, x0 + ix * this.depthPx, y0 + iy * this.depthPx);
      g.addColorStop(0, rgba(C.base, 0.56));
      g.addColorStop(0.5, rgba(C.base, 0.3));
      g.addColorStop(1, rgba(C.base, 0.08));
      return g;
    }
    paintCache() {
      const L = this.layer, c = this.cache;
      c.width = L.el.width; c.height = L.el.height;
      const x = c.getContext('2d');
      x.setTransform(L.el.width / L.w, 0, 0, L.el.height / L.h, 0, 0);
      x.lineCap = 'round'; x.lineJoin = 'round';
      for (const tr of this.traces) {
        x.strokeStyle = tr.gCache; x.lineWidth = tr.lw;
        x.beginPath(); subPath(x, tr.path, 0, tr.path.len); x.stroke();
        if (tr.branch) { x.lineWidth = 1; x.beginPath(); subPath(x, tr.branch.path, 0, tr.branch.path.len); x.stroke(); }
      }
      this.paintExtras(x, 1);
      for (const p of this.pads) this.paintPad(x, p, 1);
    }
    paintExtras(x, alpha) {
      x.globalAlpha = alpha;
      x.setLineDash([1.5, 3.5]); x.lineWidth = 1;
      for (const lk of this.links) { x.strokeStyle = rgba(C.soft, lk.alpha * 0.6); x.beginPath(); subPath(x, lk.path, 0, lk.path.len); x.stroke(); }
      x.setLineDash([]);
      for (const v of this.vias) { x.strokeStyle = rgba(C.base, v.a); x.beginPath(); x.arc(v.x, v.y, 2.3, 0, TAU); x.stroke(); }
      x.globalAlpha = 1;
    }
    paintPad(x, p, scale) {
      const r = p.r * scale;
      if (r <= 0.05) return;
      if (p.neuron) {
        x.globalAlpha = clamp(p.a * 0.85 * scale, 0, 1);
        x.drawImage(this.sprFlash, p.x - 13, p.y - 13, 26, 26);
        x.globalAlpha = 1;
      }
      x.fillStyle = rgba(C.base, Math.min(1, p.a * 1.5));
      x.beginPath(); x.arc(p.x, p.y, r, 0, TAU); x.fill();
      x.strokeStyle = rgba(C.base, p.a * 0.75); x.lineWidth = 1;
      x.beginPath(); x.arc(p.x, p.y, r + 2.4 * scale, 0, TAU); x.stroke();
    }
    step(dt) {
      if (this.intro < this.introDur) {
        this.intro += dt;
        for (const tr of this.traces) {
          if (!tr.booted && this.intro >= tr.delay + tr.grow) { tr.booted = true; tr.pad.flash = Math.max(tr.pad.flash, 0.75); }
          const br = tr.branch;
          if (br && !br.booted && this.intro >= br.t0 + br.grow) { br.booted = true; br.pad.flash = Math.max(br.pad.flash, 0.6); }
        }
      }
      if (this.intro > this.introDur * 0.75) {
        this.spawnAcc += dt * this.rate;
        while (this.spawnAcc >= 1) { this.spawnAcc -= 1; this.spawn(); }
      }
      for (let k = this.pulses.length - 1; k >= 0; k--) {
        const q = this.pulses[k];
        if (q.wait > 0) { q.wait -= dt; continue; }
        const prev = q.s;
        q.s += q.dir * q.speed * dt;
        const br = q.trace && q.trace.branch;
        if (br && q.dir > 0 && prev < br.s && q.s >= br.s && Math.random() < 0.55) {
          this.add(br.path, 1, { end: br.pad, speed: q.speed * 0.92, tail: q.tail * 0.8, gen: q.gen });
        }
        if (!q.arrived && (q.dir > 0 ? q.s >= q.path.len : q.s <= 0)) { q.arrived = true; this.arrive(q); }
        if (q.dir > 0 ? q.s - q.tail >= q.path.len : q.s + q.tail <= 0) this.pulses.splice(k, 1);
      }
      const decay = dt * 1.6;
      for (const p of this.pads) if (p.flash > 0) p.flash = Math.max(0, p.flash - decay);
    }
    add(path, dir, o = {}) {
      if (this.pulses.length >= this.maxPulses) return null;
      const q = {
        path, dir, s: dir > 0 ? 0 : path.len,
        speed: o.speed ?? rand(150, 235), tail: o.tail ?? rand(36, 64),
        end: o.end || null, spark: !!o.spark, gen: o.gen || 0, wait: o.wait || 0,
        trace: o.trace || null, arrived: false,
      };
      this.pulses.push(q);
      return q;
    }
    spawn() {
      if (!this.traces.length) return;
      const tr = pick(this.traces);
      if (Math.random() < 0.7) this.add(tr.path, 1, { end: tr.pad, trace: tr });
      else { tr.pad.flash = Math.max(tr.pad.flash, 0.7); this.add(tr.path, -1, {}); }
    }
    arrive(q) {
      const p = q.end;
      if (!p) return;
      p.flash = 1;
      if (q.spark) {
        if (Math.random() < 0.7) this.add((p.branch || p.trace).path, -1, { gen: q.gen });
        return;
      }
      if (q.gen < 3 && p.links.length && Math.random() < 0.55) {
        const lk = pick(p.links), fwd = lk.a === p;
        this.add(lk.path, fwd ? 1 : -1, { end: fwd ? lk.b : lk.a, spark: true, speed: rand(300, 380), tail: rand(14, 22), gen: q.gen + 1, wait: 0.06 });
      }
    }
    draw() {
      const L = this.layer, x = L.ctx, w = L.w, h = L.h;
      if (!w || !this.bands) return;
      const rx = this.rx, ry = this.ry;
      for (const b of this.bands) x.clearRect(b[0] / rx, b[1] / ry, b[2] / rx, b[3] / ry);
      const still = this.still;
      const inIntro = !still && this.intro < this.introDur;
      const breathe = still ? 1 : 0.8 + 0.2 * Math.sin(this.t * TAU / 3.6);
      vignette(x, w, h, 0.12 * breathe * (inIntro ? clamp(this.intro / 0.5, 0, 1) : 1), 28);
      if (inIntro) this.drawIntro(x);
      else {
        x.globalAlpha = 0.86 + 0.14 * breathe;
        for (const b of this.bands) x.drawImage(this.cache, b[0], b[1], b[2], b[3], b[0] / rx, b[1] / ry, b[2] / rx, b[3] / ry);
        x.globalAlpha = 1;
      }
      if (still) return;
      x.globalCompositeOperation = 'lighter';
      for (const p of this.pads) {
        if (p.flash <= 0) continue;
        const f = p.flash, size = 10 + 34 * f;
        x.globalAlpha = f * 0.95;
        x.drawImage(this.sprFlash, p.x - size / 2, p.y - size / 2, size, size);
      }
      x.globalAlpha = 1;
      x.globalCompositeOperation = 'source-over';
      for (const p of this.pads) {
        if (p.flash <= 0) continue;
        const f = p.flash;
        x.strokeStyle = rgba(C.base, 0.55 * f * f); x.lineWidth = 1.2;
        x.beginPath(); x.arc(p.x, p.y, p.r + 3 + (1 - f) * 15, 0, TAU); x.stroke();
        x.fillStyle = rgba(C.mist, f);
        x.beginPath(); x.arc(p.x, p.y, p.r * (1 + 0.3 * f), 0, TAU); x.fill();
      }
      for (const q of this.pulses) this.drawPulse(x, q);
    }
    drawIntro(x) {
      const T = this.intro, heads = this.heads;
      heads.length = 0;
      x.lineCap = 'round'; x.lineJoin = 'round';
      for (const tr of this.traces) {
        const k = clamp((T - tr.delay) / tr.grow, 0, 1);
        if (k <= 0) continue;
        const s1 = easeOutCubic(k) * tr.path.len;
        x.strokeStyle = tr.gMain; x.lineWidth = tr.lw;
        x.beginPath(); subPath(x, tr.path, 0, s1); x.stroke();
        if (k < 1) heads.push(pointAt(tr.path, s1, { x: 0, y: 0 }));
        else this.paintPad(x, tr.pad, easeOutBack(clamp((T - tr.delay - tr.grow) / 0.3, 0, 1)));
        const br = tr.branch;
        if (br) {
          const kb = clamp((T - br.t0) / br.grow, 0, 1);
          if (kb > 0) {
            const sb = easeOutCubic(kb) * br.path.len;
            x.strokeStyle = tr.gMain; x.lineWidth = 1;
            x.beginPath(); subPath(x, br.path, 0, sb); x.stroke();
            if (kb < 1) heads.push(pointAt(br.path, sb, { x: 0, y: 0 }));
            else this.paintPad(x, br.pad, easeOutBack(clamp((T - br.t0 - br.grow) / 0.3, 0, 1)));
          }
        }
      }
      const late = clamp((T - (this.introDur - 0.55)) / 0.45, 0, 1);
      if (late > 0) this.paintExtras(x, late);
      x.globalCompositeOperation = 'lighter';
      for (const p of heads) {
        x.drawImage(this.sprHead, p.x - 9, p.y - 9, 18, 18);
        x.drawImage(this.sprCore, p.x - 3, p.y - 3, 6, 6);
      }
      x.globalCompositeOperation = 'source-over';
    }
    drawPulse(x, q) {
      if (q.wait > 0) return;
      const P = q.path;
      const head = clamp(q.s, 0, P.len), tailS = clamp(q.s - q.dir * q.tail, 0, P.len);
      if (Math.abs(head - tailS) > 0.5) {
        const A = pointAt(P, tailS, this.tmpA), B = pointAt(P, head, this.tmpB);
        const g = x.createLinearGradient(A.x, A.y, B.x, B.y);
        g.addColorStop(0, rgba(C.base, 0));
        g.addColorStop(0.6, rgba(C.base, q.spark ? 0.6 : 0.72));
        g.addColorStop(1, rgba(C.mist, 1));
        x.strokeStyle = g; x.lineWidth = q.spark ? 1.3 : 1.9; x.lineCap = 'round';
        x.beginPath(); subPath(x, P, Math.min(head, tailS), Math.max(head, tailS)); x.stroke();
      }
      if (q.dir > 0 ? q.s <= P.len : q.s >= 0) {
        const B = pointAt(P, head, this.tmpB);
        const hs = q.spark ? 14 : 22;
        // Solid bead first so the signal still reads on white pages, then the additive glow.
        x.fillStyle = rgba(C.base, 0.95);
        x.beginPath(); x.arc(B.x, B.y, q.spark ? 1.7 : 2.4, 0, TAU); x.fill();
        x.globalCompositeOperation = 'lighter';
        x.drawImage(this.sprHead, B.x - hs / 2, B.y - hs / 2, hs, hs);
        x.drawImage(this.sprCore, B.x - 3.5, B.y - 3.5, 7, 7);
        x.globalCompositeOperation = 'source-over';
      }
    }
    // The agent acted on an element: fire the traces closest to it.
    target(rect) {
      if (!this.active || this.still || !this.traces.length) return;
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      const d = [cy, this.h - cy, cx, this.w - cx];
      const e = this.edges[d.indexOf(Math.min(...d))];
      const along = e.alg[0] ? cx : cy;
      this.traces
        .filter(t => t.edge === e)
        .sort((a, b) => Math.abs(a.along - along) - Math.abs(b.along - along))
        .slice(0, 5)
        .forEach((t, n) => this.add(t.path, 1, { end: t.pad, trace: t, speed: 320, tail: 80, wait: n * 0.06, gen: 3 }));
    }
  }

  /* aurora: a soft band hugs the frame, built from lobes in five purples that
     drift around the perimeter at different speeds, so the glow keeps
     shifting instead of pulsing uniformly. A crisp rim carries two comets
     that orbit in opposite directions and flare when they meet. */
  class Aurora extends Effect {
    constructor() {
      super();
      this.glow = new Layer('webbrain-agent-effect', 0.5); // soft light: half resolution is enough
      this.rim = new Layer('webbrain-agent-effect-rim', 1);
      this.layers = [this.glow, this.rim];
      const st = [[0, 1], [0.3, 0.7], [0.65, 0.22], [1, 0]];
      this.spr = {
        base: sprite(C.base, 128, st), soft: sprite(C.soft, 128, st), pale: sprite(C.pale, 128, st),
        mist: sprite(C.mist, 128, st), deep: sprite(C.deep, 128, st),
      };
      this.sprHead = sprite(C.soft, 64, [[0, 1], [0.2, 0.6], [0.5, 0.15], [1, 0]]);
      this.sprCore = sprite(C.core, 32, [[0, 1], [0.4, 0.6], [1, 0]]);
      this.lobes = []; this.comets = []; this.edgeGeo = []; this.P = 1; this.fadeIn = 0;
      this.pt = { x: 0, y: 0 }; this.pt2 = { x: 0, y: 0 };
    }
    onShow() { this.fadeIn = 0; }
    layout(w, h) {
      const P = this.P = 2 * (w + h);
      // each edge as a segment of the perimeter parameter s (clockwise from top-left)
      this.edgeGeo = [
        { a: 0, b: w, ox: 0, oy: 0, tx: 1, ty: 0, horiz: true },
        { a: w, b: w + h, ox: w, oy: 0, tx: 0, ty: 1, horiz: false },
        { a: w + h, b: 2 * w + h, ox: w, oy: h, tx: -1, ty: 0, horiz: true },
        { a: 2 * w + h, b: P, ox: 0, oy: h, tx: 0, ty: -1, horiz: false },
      ];
      const n = clamp(Math.round(P / 220), 12, 34);
      const colors = ['base', 'base', 'base', 'deep', 'deep', 'soft', 'soft', 'pale', 'mist'];
      const thick = clamp(Math.min(w, h) * 0.085, 48, 96);
      this.lobes = [];
      for (let k = 0; k < n; k++) {
        this.lobes.push({
          s: ((k + rand(-0.3, 0.3)) / n) * P,
          v: rand(22, 64) * (Math.random() < 0.5 ? -1 : 1),
          len: rand(240, 520), th: thick * rand(0.7, 1.25), color: pick(colors),
          a: rand(0.42, 0.78), ph: rand(0, TAU), fr: rand(0.12, 0.32),
        });
      }
      this.comets = [
        { s: rand(0, P), v: P / 7.5, tail: 220 },
        { s: rand(0, P), v: -P / 10, tail: 170 },
      ];
    }
    perim(s, inset, out) {
      const w = this.w, h = this.h, P = this.P;
      s = ((s % P) + P) % P;
      if (s < w) { out.x = s; out.y = inset; }
      else if (s < w + h) { out.x = w - inset; out.y = s - w; }
      else if (s < 2 * w + h) { out.x = w - (s - w - h); out.y = h - inset; }
      else { out.x = inset; out.y = h - (s - 2 * w - h); }
      return out;
    }
    perimPath(ctx, s0, s1, inset) {
      const P = this.P, w = this.w, h = this.h;
      const corners = [w, w + h, 2 * w + h, P];
      let s = s0;
      let p = this.perim(s, inset, this.pt2);
      ctx.moveTo(p.x, p.y);
      for (let guard = 0; s < s1 - 1e-6 && guard < 8; guard++) {
        const m = ((s % P) + P) % P;
        let next = P;
        for (const c of corners) if (c > m + 1e-6) { next = c; break; }
        s += Math.min(s1 - s, next - m);
        p = this.perim(s, inset, this.pt2);
        ctx.lineTo(p.x, p.y);
      }
    }
    sAt(x, y) {
      const w = this.w, h = this.h;
      const d = [y, w - x, h - y, x];
      const e = d.indexOf(Math.min(...d));
      return e === 0 ? x : e === 1 ? w + y : e === 2 ? w + h + (w - x) : 2 * w + h + (h - y);
    }
    step(dt) {
      this.fadeIn = Math.min(1, this.fadeIn + dt / 0.9);
      for (let k = this.lobes.length - 1; k >= 0; k--) {
        const L = this.lobes[k];
        L.s += L.v * dt;
        if (L.life !== undefined) { L.life -= dt; if (L.life <= 0) this.lobes.splice(k, 1); }
      }
      for (const c of this.comets) c.s += c.v * dt;
    }
    draw() {
      const w = this.w, h = this.h;
      if (!w) return;
      const t = this.t, still = this.still, P = this.P;
      const I = still ? 1 : (0.84 + 0.16 * Math.sin(t * TAU / 4.8)) * easeOutCubic(this.fadeIn);
      const g = this.glow.ctx;
      g.clearRect(0, 0, w, h);
      vignette(g, w, h, 0.16 * I, 30); // a continuous floor so the frame never has gaps
      for (const L of this.lobes) {
        const env = L.life === undefined ? 1 : Math.min(1, (L.max - L.life) / 0.18) * clamp(L.life / L.max, 0, 1);
        const breath = still ? 0.8 : 0.62 + 0.38 * Math.sin(t * L.fr * TAU + L.ph);
        const alpha = clamp(L.a * breath * I * env, 0, 1);
        if (alpha < 0.004) continue;
        const th = L.th * (still ? 1 : 0.86 + 0.14 * Math.sin(t * 0.6 + L.ph * 1.7));
        const half = L.len / 2, spr = this.spr[L.color];
        const c = ((L.s % P) + P) % P;
        g.globalAlpha = alpha;
        // one edge-aligned ellipse per edge it touches; half of it sits off-screen
        for (const E of this.edgeGeo) {
          let cc = c;
          if (cc < E.a - half) cc += P; else if (cc > E.b + half) cc -= P;
          if (cc + half < E.a || cc - half > E.b) continue;
          const local = cc - E.a;
          const px = E.ox + E.tx * local, py = E.oy + E.ty * local;
          if (E.horiz) g.drawImage(spr, px - half, py - th, half * 2, th * 2);
          else g.drawImage(spr, px - th, py - half, th * 2, half * 2);
        }
      }
      g.globalAlpha = 1;

      const r = this.rim.ctx;
      r.clearRect(0, 0, w, h);
      r.lineWidth = 1.5;
      r.strokeStyle = rgba(C.base, 0.55 * I);
      r.strokeRect(0.75, 0.75, w - 1.5, h - 1.5);
      if (still) return;
      r.lineCap = 'butt';
      for (const c of this.comets) {
        const dir = Math.sign(c.v), N = 22;
        for (let k = 0; k < N; k++) {
          const s0 = c.s - dir * (k / N) * c.tail, s1 = c.s - dir * ((k + 1) / N) * c.tail;
          const f = 1 - k / N;
          r.strokeStyle = rgba(k < 2 ? C.pale : C.base, f * f * 0.95 * I);
          r.lineWidth = 1.2 + 2.6 * f;
          r.beginPath(); this.perimPath(r, Math.min(s0, s1), Math.max(s0, s1), 1.2); r.stroke();
        }
        const hp = this.perim(c.s, 1.2, this.pt);
        r.fillStyle = rgba(C.base, 0.9 * I);
        r.beginPath(); r.arc(hp.x, hp.y, 2.8, 0, TAU); r.fill();
        r.globalCompositeOperation = 'lighter';
        r.globalAlpha = I;
        r.drawImage(this.sprHead, hp.x - 22, hp.y - 22, 44, 44);
        r.drawImage(this.sprCore, hp.x - 4, hp.y - 4, 8, 8);
        r.globalAlpha = 1;
        r.globalCompositeOperation = 'source-over';
      }
      const [c1, c2] = this.comets;
      let diff = (((c2.s - c1.s) % P) + P) % P;
      if (diff > P / 2) diff -= P;
      const dist = Math.abs(diff);
      if (dist < 170) {
        const f = 1 - dist / 170;
        const m = this.perim(c1.s + diff / 2, 0, this.pt);
        const size = 70 + 90 * f;
        r.globalCompositeOperation = 'lighter';
        r.globalAlpha = f * f * 0.9 * I;
        r.drawImage(this.sprHead, m.x - size / 2, m.y - size / 2, size, size);
        r.globalAlpha = 1;
        r.globalCompositeOperation = 'source-over';
      }
    }
    // The agent acted on an element: brighten the frame nearest to it.
    target(rect) {
      if (!this.active || this.still) return;
      const s = this.sAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
      this.lobes.push({ s, v: 0, len: 360, th: 120, color: 'soft', a: 0.6, ph: 0, fr: 0, life: 1.6, max: 1.6 });
      this.lobes.push({ s, v: 0, len: 200, th: 80, color: 'base', a: 0.7, ph: 0, fr: 0, life: 1.6, max: 1.6 });
    }
  }

  /* scan: viewfinder brackets land in the corners; a thin beam sweeps the
     page (down, rest, up, rest) and a fixed dot matrix lights up behind it,
     stronger near the edges than over the content. */
  class Scan extends Effect {
    constructor() {
      super();
      this.layer = new Layer('webbrain-agent-effect', 1);
      this.layers = [this.layer];
      this.sprEdge = sprite(C.soft, 64, [[0, 1], [0.2, 0.55], [0.5, 0.14], [1, 0]]);
      this.row = document.createElement('canvas');
      this.locks = [];
      this.sp = 14;
    }
    onShow() { this.locks.length = 0; }
    layout(w, h) {
      const L = this.layer;
      this.arm = clamp(Math.min(w, h) * 0.042, 20, 40);
      this.sweep = clamp(h / 330, 2.2, 3.6);
      this.rest = 1.05;
      this.trail = clamp(h * 0.17, 70, 150);
      const sx = L.el.width / w, sy = L.el.height / h;
      const row = this.row;
      row.width = L.el.width;
      row.height = Math.max(1, Math.ceil(4 * sy));
      const x = row.getContext('2d');
      x.setTransform(sx, 0, 0, row.height / 4, 0, 0);
      for (let px = this.sp / 2; px < w; px += this.sp) {
        const u = px / w, d = Math.min(u, 1 - u) * 2;
        x.fillStyle = rgba(C.base, lerp(0.95, 0.22, Math.pow(d, 0.6)));
        x.beginPath(); x.arc(px, 2, 1.1, 0, TAU); x.fill();
      }
      this.beamGrad = L.ctx.createLinearGradient(0, 0, w, 0);
      for (const [o, a] of [[0, 0.9], [0.14, 0.5], [0.5, 0.28], [0.86, 0.5], [1, 0.9]]) this.beamGrad.addColorStop(o, rgba(C.base, a));
    }
    step(dt) {
      for (let k = this.locks.length - 1; k >= 0; k--) {
        this.locks[k].t += dt;
        if (this.locks[k].t > 1.7) this.locks.splice(k, 1);
      }
    }
    draw() {
      const L = this.layer, x = L.ctx, w = L.w, h = L.h;
      if (!w) return;
      x.clearRect(0, 0, w, h);
      const still = this.still, t = this.t;
      const breath = still ? 0.5 : 0.5 + 0.5 * Math.sin(t * TAU / 3.4);
      const fade = still ? 1 : easeOutCubic(clamp(t / 0.6, 0, 1));
      vignette(x, w, h, (0.08 + 0.04 * breath) * fade, 24);
      let snap = 0;
      if (!still) {
        const cyc = this.sweep + this.rest;
        const tt = Math.max(0, t - 0.35); // brackets land first
        const n = Math.floor(tt / cyc), local = tt - n * cyc, down = n % 2 === 0;
        const k = clamp(local / this.sweep, 0, 1), e = easeInOutSine(k);
        const y = down ? lerp(-6, h + 6, e) : lerp(h + 6, -6, e);
        const vis = local < this.sweep ? clamp(Math.min(k / 0.07, (1 - k) / 0.07), 0, 1) * fade : 0;
        if (t > 0.35 && vis > 0) this.drawBeam(x, w, y, down ? -1 : 1, vis);
        const since = local - this.sweep;
        if (t > 0.35 && since >= 0) { const s = Math.max(0, 1 - since / 0.6); snap = s * s; }
      }
      this.drawBrackets(x, w, h, breath, snap, fade);
      for (const lk of this.locks) this.drawLock(x, lk);
    }
    drawBeam(x, w, y, dir, vis) {
      const tr = this.trail, y2 = y + dir * tr;
      const g = x.createLinearGradient(0, y, 0, y2);
      g.addColorStop(0, rgba(C.base, 0.11 * vis));
      g.addColorStop(0.35, rgba(C.base, 0.045 * vis));
      g.addColorStop(1, rgba(C.base, 0));
      x.fillStyle = g;
      x.fillRect(0, Math.min(y, y2), w, tr);
      const sp = this.sp, lo = Math.min(y, y2), hi = Math.max(y, y2);
      for (let ry = Math.ceil(lo / sp) * sp; ry <= hi; ry += sp) {
        const a = Math.pow(1 - Math.abs(ry - y) / tr, 2.2) * 0.75 * vis;
        if (a < 0.01) continue;
        x.globalAlpha = a;
        x.drawImage(this.row, 0, ry - 2, w, 4);
      }
      x.globalAlpha = vis;
      x.fillStyle = this.beamGrad;
      x.fillRect(0, y - 0.75, w, 1.5);
      x.globalCompositeOperation = 'lighter';
      x.drawImage(this.sprEdge, -24, y - 24, 48, 48);
      x.drawImage(this.sprEdge, w - 24, y - 24, 48, 48);
      x.globalCompositeOperation = 'source-over';
      x.fillStyle = rgba(C.base, 0.95);
      x.fillRect(0, y - 1.5, 16, 3);
      x.fillRect(w - 16, y - 1.5, 16, 3);
      x.globalAlpha = 1;
    }
    drawBrackets(x, w, h, breath, snap, fade) {
      const land = this.still ? 1 : easeOutBack(clamp(this.t / 0.55, 0, 1));
      const m = lerp(48, 12, land) + 2 * breath - 4 * snap;
      const a = this.arm * (0.9 + 0.1 * land) + 8 * snap, r = 7;
      x.save();
      x.globalAlpha = clamp(fade * 1.2, 0, 1);
      x.lineCap = 'round'; x.lineJoin = 'round';
      x.beginPath();
      x.moveTo(m, m + a); x.lineTo(m, m + r); x.arcTo(m, m, m + r, m, r); x.lineTo(m + a, m);
      x.moveTo(w - m - a, m); x.lineTo(w - m - r, m); x.arcTo(w - m, m, w - m, m + r, r); x.lineTo(w - m, m + a);
      x.moveTo(w - m, h - m - a); x.lineTo(w - m, h - m - r); x.arcTo(w - m, h - m, w - m - r, h - m, r); x.lineTo(w - m - a, h - m);
      x.moveTo(m + a, h - m); x.lineTo(m + r, h - m); x.arcTo(m, h - m, m, h - m - r, r); x.lineTo(m, h - m - a);
      // Halo from wide translucent strokes. shadowBlur would rasterize a
      // viewport-sized shadow layer here (the path spans all four corners).
      x.strokeStyle = rgba(C.base, 0.07 + 0.08 * snap); x.lineWidth = 12; x.stroke();
      x.strokeStyle = rgba(C.base, 0.14 + 0.12 * snap); x.lineWidth = 6.5; x.stroke();
      x.strokeStyle = rgba(C.base, 0.85 + 0.15 * snap); x.lineWidth = 2.6; x.stroke();
      x.restore();
    }
    drawLock(x, lk) {
      const k = easeOutCubic(clamp(lk.t / 0.35, 0, 1));
      const fade = lk.t < 1.2 ? 1 : Math.max(0, 1 - (lk.t - 1.2) / 0.45);
      const R = lk.rect, pad = lerp(26, 8, k);
      const l = R.left - pad, tp = R.top - pad, rr = R.left + R.width + pad, b = R.top + R.height + pad;
      const a = clamp(Math.min(rr - l, b - tp) * 0.28, 7, 16);
      x.save();
      x.globalAlpha = k * fade;
      x.lineWidth = 2; x.lineCap = 'round'; x.lineJoin = 'round';
      x.strokeStyle = rgba(C.base, 0.95);
      x.beginPath();
      x.moveTo(l, tp + a); x.lineTo(l, tp); x.lineTo(l + a, tp);
      x.moveTo(rr - a, tp); x.lineTo(rr, tp); x.lineTo(rr, tp + a);
      x.moveTo(rr, b - a); x.lineTo(rr, b); x.lineTo(rr - a, b);
      x.moveTo(l + a, b); x.lineTo(l, b); x.lineTo(l, b - a);
      x.stroke();
      x.restore();
    }
    // The agent acted on an element: the viewfinder locks onto it.
    target(rect) {
      if (!this.active || this.still) return;
      this.locks.push({ rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, t: 0 });
    }
  }

  /* gears: a large driver wheel sits just outside each corner and drives two
     trains of smaller cogs along the edges. Meshing is real: one module for
     all wheels, centre distance = sum of pitch radii, tooth phases aligned so
     teeth sit in gaps, angular speed ∝ 1/teeth with alternating direction.
     Wheel bodies vary (spokes, lightening holes, solid) and some wheels carry
     a pinion on the same axle. When the agent acts, the nearest train revs. */
  class Gears extends Effect {
    constructor() {
      super();
      this.layer = new Layer('webbrain-agent-effect', 1);
      this.layers = [this.layer];
      this.sprGlow = sprite(C.soft, 64, [[0, 0.9], [0.3, 0.42], [0.7, 0.08], [1, 0]]);
      this.gears = []; this.clusters = []; this.bands = null; this.rx = 1; this.ry = 1;
      this.minFrame = 1 / 30; // slow rotation reads smooth at 30 fps and halves raster work
    }
    onShow() { for (const c of this.clusters) { c.kick = 0; c.k = 0; } }
    gearSprite(N, m, style, ratio) {
      const r = N * m / 2, ro = r + m, rr = r - 1.25 * m, half = ro + 3;
      const S = Math.ceil(half * 2 * ratio);
      const c = document.createElement('canvas');
      c.width = c.height = S;
      const x = c.getContext('2d');
      x.setTransform(ratio, 0, 0, ratio, S / 2, S / 2);
      const p = TAU / N, twR = 0.56 * p, twT = 0.3 * p;
      x.beginPath();
      for (let k = 0; k < N; k++) {
        const a = k * p, a0 = a - twR / 2, a1 = a - twT / 2, a2 = a + twT / 2, a3 = a + twR / 2;
        if (k === 0) x.moveTo(rr * Math.cos(a0), rr * Math.sin(a0));
        else x.lineTo(rr * Math.cos(a0), rr * Math.sin(a0));
        x.lineTo(ro * Math.cos(a1), ro * Math.sin(a1));
        x.arc(0, 0, ro, a1, a2);
        x.lineTo(rr * Math.cos(a3), rr * Math.sin(a3));
        x.arc(0, 0, rr, a3, a + p - twR / 2);
      }
      x.closePath();
      const hub = Math.max(r * 0.2, 1.8 * m), axle = Math.max(1.6, hub * 0.38), rim = rr - 1.1 * m;
      if (style === 'spokes' && rim - hub > 3 * m) {
        const s = N >= 30 ? 6 : N >= 20 ? 5 : 4;
        const hw = clamp(r * 0.07, 2, 6), inner = hub + m;
        const ao = Math.asin(Math.min(1, hw / rim)), ai = Math.asin(Math.min(1, hw / inner));
        for (let j = 0; j < s; j++) {
          const b = j * TAU / s, e = (j + 1) * TAU / s;
          if (e - ai <= b + ai) continue;
          x.moveTo(rim * Math.cos(b + ao), rim * Math.sin(b + ao));
          x.arc(0, 0, rim, b + ao, e - ao);
          x.arc(0, 0, inner, e - ai, b + ai, true);
          x.closePath();
        }
      } else if (style === 'holes' && rim - hub > 2.4 * m) {
        const k = N >= 24 ? 6 : 5, rho = (hub + rim) / 2;
        const rh = Math.min((rim - hub) * 0.34, rho * Math.sin(Math.PI / k) * 0.6);
        for (let j = 0; j < k; j++) {
          const a = j * TAU / k + p / 2, cx = rho * Math.cos(a), cy = rho * Math.sin(a);
          x.moveTo(cx + rh, cy);
          x.arc(cx, cy, rh, 0, TAU);
        }
      }
      x.moveTo(axle, 0);
      x.arc(0, 0, axle, 0, TAU);
      x.fillStyle = rgba(C.base, style === 'solid' ? 0.08 : 0.1);
      x.fill('evenodd');
      x.lineJoin = 'round';
      x.strokeStyle = rgba(C.base, 0.58);
      x.lineWidth = 1.2;
      x.stroke();
      x.beginPath(); x.arc(0, 0, hub, 0, TAU);
      x.strokeStyle = rgba(C.base, 0.42); x.lineWidth = 1; x.stroke();
      if (style === 'solid' && rim - hub > 2 * m) {
        x.beginPath(); x.arc(0, 0, rim, 0, TAU);
        x.setLineDash([2.5, 3.5]); x.strokeStyle = rgba(C.base, 0.34); x.stroke(); x.setLineDash([]);
      }
      return c;
    }
    layout(w, h) {
      const m = clamp(Math.min(w, h) * 0.0062, 3.4, 6.4);
      const ratio = this.layer.el.width / w;
      const gears = [], clusters = [];
      const corners = [
        { x: 0, y: 0, a: [1, 0], b: [0, 1] },
        { x: w, y: 0, a: [-1, 0], b: [0, 1] },
        { x: w, y: h, a: [-1, 0], b: [0, -1] },
        { x: 0, y: h, a: [1, 0], b: [0, -1] },
      ];
      const styles = ['spokes', 'holes', 'solid', 'holes', 'spokes'];
      const sprites = new Map(); // identical wheels share one sprite
      const make = (N, x, y, phi, omega, cl, style, order) => {
        const g = { N, r: N * m / 2, x, y, phi, omega, cl, style, order, flash: 0 };
        g.half = g.r + m + 3;
        const key = N + style;
        if (!sprites.has(key)) sprites.set(key, this.gearSprite(N, m, style, ratio));
        g.sprite = sprites.get(key);
        gears.push(g);
        return g;
      };
      // phase for C so that its teeth fall into P's gaps along the line of centres
      const meshPhase = (P, Cg) => {
        const alpha = Math.atan2(Cg.y - P.y, Cg.x - P.x);
        const pP = TAU / P.N, pC = TAU / Cg.N;
        let f = ((alpha - P.phi) / pP) % 1; if (f < 0) f += 1;
        let g = (0.5 - f) % 1; if (g < 0) g += 1;
        return alpha + Math.PI - g * pC;
      };
      corners.forEach((cn, ci) => {
        clusters.push({ kick: 0, k: 0, x: cn.x, y: cn.y });
        const toXY = (u, v, e, n) => [cn.x + e[0] * u + n[0] * v, cn.y + e[1] * u + n[1] * v];
        const N0 = randInt(30, 42), R0 = N0 * m / 2, off = R0 * rand(0.3, 0.46);
        const [x0, y0] = toXY(-off, -off, cn.a, cn.b);
        const driver = make(N0, x0, y0, rand(0, TAU), 0.3 * (Math.random() < 0.5 ? 1 : -1), ci, 'spokes', 0);
        for (const [e, n] of [[cn.a, cn.b], [cn.b, cn.a]]) {
          const reach = (e[0] ? w : h) * 0.33;
          let parent = driver, pu = -off, pv = -off, order = 1;
          while (order < 10) {
            const N = pick([9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 24]);
            const R = N * m / 2, D = parent.r + R;
            let v = -R * rand(0.32, 0.78), dv = v - pv;
            if (Math.abs(dv) >= D * 0.92) { v = pv + Math.sign(dv) * D * 0.6; dv = v - pv; }
            const u = pu + Math.sqrt(D * D - dv * dv);
            if (u - R > reach) break;
            const [gx, gy] = toXY(u, v, e, n);
            const g = make(N, gx, gy, 0, -parent.omega * parent.N / N, ci, N <= 11 ? 'solid' : pick(styles), order++);
            g.phi = meshPhase(parent, g);
            if (N >= 16 && Math.random() < 0.3) {
              parent = make(randInt(8, 11), gx, gy, rand(0, TAU), g.omega, ci, 'solid', order); // pinion on the same axle
            } else parent = g;
            pu = u; pv = v;
          }
        }
      });
      this.gears = gears; this.clusters = clusters;

      const W = this.layer.el.width, H = this.layer.el.height;
      this.rx = W / w; this.ry = H / h;
      let band = 0;
      for (const g of gears) band = Math.max(band, Math.min(g.x, g.y, w - g.x, h - g.y) + g.half);
      band = Math.max(band, 30) + 8;
      const bx = Math.ceil(band * this.rx), by = Math.ceil(band * this.ry);
      this.bands = 2 * bx >= W || 2 * by >= H
        ? [[0, 0, W, H]]
        : [[0, 0, W, by], [0, H - by, W, by], [0, by, bx, H - 2 * by], [W - bx, by, bx, H - 2 * by]];
    }
    step(dt) {
      const up = easeOutCubic(clamp(this.t / 1.6, 0, 1));
      for (const c of this.clusters) {
        c.k = up * (1 + 2.6 * c.kick * c.kick);
        c.kick = Math.max(0, c.kick - dt / 1.1);
      }
      for (const g of this.gears) {
        g.phi = (g.phi + g.omega * this.clusters[g.cl].k * dt) % TAU;
        if (g.flash > 0) g.flash = Math.max(0, g.flash - dt * 1.4);
      }
    }
    draw() {
      const L = this.layer, x = L.ctx, w = L.w, h = L.h;
      if (!w || !this.bands) return;
      const rx = this.rx, ry = this.ry;
      for (const b of this.bands) x.clearRect(b[0] / rx, b[1] / ry, b[2] / rx, b[3] / ry);
      const still = this.still, t = this.t;
      vignette(x, w, h, 0.08 * (still ? 1 : clamp(t / 0.6, 0, 1)), 24);
      for (const g of this.gears) {
        const a = still ? 1 : easeOutCubic(clamp((t - g.order * 0.07) / 0.4, 0, 1));
        if (a <= 0) continue;
        x.save();
        x.translate(g.x, g.y);
        x.rotate(g.phi);
        x.globalAlpha = a;
        x.drawImage(g.sprite, -g.half, -g.half, g.half * 2, g.half * 2);
        x.restore();
        if (g.flash > 0) {
          const s = g.r * 1.6;
          x.globalCompositeOperation = 'lighter';
          x.globalAlpha = g.flash * 0.6;
          x.drawImage(this.sprGlow, g.x - s / 2, g.y - s / 2, s, s);
          x.globalAlpha = 1;
          x.globalCompositeOperation = 'source-over';
        }
      }
    }
    // The agent acted on an element: the nearest corner's train revs up.
    target(rect) {
      if (!this.active || this.still || !this.gears.length) return;
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      let best = 0, bestDist = Infinity;
      this.clusters.forEach((c, i) => { const d = Math.hypot(c.x - cx, c.y - cy); if (d < bestDist) { bestDist = d; best = i; } });
      this.clusters[best].kick = 1;
      let nearest = null, nearestDist = Infinity;
      for (const g of this.gears) {
        if (g.cl !== best) continue;
        const d = Math.hypot(g.x - cx, g.y - cy) - g.r;
        if (d < nearestDist) { nearestDist = d; nearest = g; }
      }
      if (nearest) nearest.flash = 1;
    }
  }

  /* classic: the original pulsing inset glow, kept as a choice. */
  class ClassicGlow {
    constructor() { this.el = null; this.active = false; }
    show(root) {
      injectStyles();
      if (!this.el) {
        const el = document.createElement('div');
        el.id = 'webbrain-agent-glow-border';
        decorations().add(el);
        el.style.cssText = `
          position: fixed;
          top: 0; left: 0; right: 0; bottom: 0;
          pointer-events: none;
          z-index: 2147483646;
          opacity: 0;
          transition: opacity 0.3s ease-in-out;
          animation: webbrain-pulse 2s ease-in-out infinite;
          box-shadow:
            inset 0 0 10px rgba(108, 99, 255, 0.5),
            inset 0 0 20px rgba(108, 99, 255, 0.3),
            inset 0 0 30px rgba(108, 99, 255, 0.1);
        `;
        root.appendChild(el);
        this.el = el;
      }
      this.active = true;
      this.el.style.display = '';
      requestAnimationFrame(() => requestAnimationFrame(() => { if (this.active && this.el) this.el.style.opacity = '1'; }));
    }
    hide() { this.active = false; if (this.el) this.el.style.opacity = '0'; }
    suspend() { if (this.el) this.el.style.display = 'none'; }
    resume() { if (this.el) this.el.style.display = ''; }
    refreshMotion() {}
    target() {}
    destroy() { this.el?.remove(); this.el = null; this.active = false; }
  }

  function normalizeStyle(value) {
    return value === 'random' || STYLES.includes(value) ? value : DEFAULT_STYLE;
  }

  function createEffect(style) {
    const effectFor = {
      circuit: () => new NeuralCircuit(),
      aurora: () => new Aurora(),
      scan: () => new Scan(),
      gears: () => new Gears(),
      classic: () => new ClassicGlow(),
    };
    const created = effectFor[style]();
    created.styleName = style;
    return created;
  }

  function startEffect() {
    const root = document.body || document.documentElement;
    if (!root || !indicatorsActive) return;
    const style = effectStyle === 'random' ? runRandomStyle : effectStyle;
    if (effect && effect.styleName !== style) { effect.destroy(); effect = null; }
    if (!effect) effect = createEffect(style);
    effect.show(root);
    if (suspendedForToolUse) effect.suspend();
  }

  // Settings → General → Agent activity effect, applied live while a run is on.
  function applyStyle(value) {
    const next = normalizeStyle(value);
    if (next === effectStyle) return;
    effectStyle = next;
    if (!indicatorsActive || !effect) return;
    const previous = effect;
    effect = null;
    previous.hide();
    setTimeout(() => previous.destroy(), 520);
    startEffect();
  }

  try {
    Promise.resolve(chrome.storage?.local?.get({ [STYLE_STORAGE_KEY]: DEFAULT_STYLE }))
      .then((stored) => { effectStyle = normalizeStyle(stored?.[STYLE_STORAGE_KEY]); })
      .catch(() => {})
      .finally(() => {
        styleLoaded = true;
        if (indicatorsActive && !effect) startEffect();
      });
    chrome.storage?.onChanged?.addListener?.((changes, area) => {
      if (area === 'local' && changes?.[STYLE_STORAGE_KEY]) applyStyle(changes[STYLE_STORAGE_KEY].newValue);
    });
  } catch {
    styleLoaded = true;
  }

  reduceMotionQuery.addEventListener?.('change', () => effect?.refreshMotion?.());

  /* ------------------------------------------------------------------------
   * Agent cursor
   * One size (75% of the original 48×56 arrow). Ahead of an action it glides
   * to the target and holds there; a click presses once with a ripple (the
   * only size change, so a size change always means a click) when the input
   * reaches the page, or at the latest on the agent's success verdict.
   * Between actions it rests on the spot and blinks. Position, press, ripple
   * and blink all use the Web Animations API: no style is written per frame,
   * and unlike a CSS transition a glide keeps its timing through the
   * display:none of a screenshot instead of being cancelled by it.
   * ---------------------------------------------------------------------- */

  const CURSOR_SCALE = 0.75;
  const CURSOR_W = 48 * CURSOR_SCALE;
  const CURSOR_H = 56 * CURSOR_SCALE;
  const TIP_X = 5 * CURSOR_SCALE;
  const TIP_Y = 4 * CURSOR_SCALE;
  // A glide's length grows with its distance, so a short hop stays quick and
  // a long one reads as travel. The agent waits for the landing before it
  // clicks (agent.js AGENT_CURSOR_LEAD_MAX_MS caps that wait), so
  // GLIDE_MAX_MS stays under that cap.
  const GLIDE_MIN_MS = 360;
  const GLIDE_MAX_MS = 760;
  const GLIDE_MS_PER_PX = 0.45;
  const GLIDE_EASING = 'cubic-bezier(0.37, 0, 0.18, 1)';
  const FADE_IN_MS = 250;
  // After the verdict the press and ripple play out before the rest.
  const SETTLE_MS = 900;
  // A cursor that landed and never heard how the action went rests anyway.
  const APPROACH_TTL_MS = 8000;
  // A press held back by a screenshot plays once the cursor is back, unless
  // it has gone this stale.
  const PENDING_PRESS_MAX_MS = 1500;
  const CURSOR_TRANSITION = 'opacity 0.25s ease';
  const tipTransform = (x, y) => `translate(${(x - TIP_X).toFixed(1)}px, ${(y - TIP_Y).toFixed(1)}px)`;
  const CURSOR_SVG = `
    <svg width="100%" height="100%" viewBox="0 0 48 56" fill="none" xmlns="http://www.w3.org/2000/svg" style="display: block;">
      <path d="M5 4L39 31L24 34L31 50L20 54L14 38L5 48V4Z"
        fill="#6c63ff" stroke="white" stroke-width="3" stroke-linejoin="round"/>
      <path d="M24 34L31 50" stroke="rgba(20, 18, 48, 0.34)" stroke-width="2" stroke-linecap="round"/>
    </svg>
  `;

  class AgentCursor {
    constructor() {
      this.el = null; this.body = null; this.ripple = null;
      // 'approach' — gliding to, or holding at, a target the agent is about to act on
      // 'active'   — just acted; the press plays out
      // 'resting'  — waiting for the next action, blinking on the spot
      // 'hidden'
      this.mode = 'hidden';
      this.x = 0; this.y = 0; // where the tip is headed, or is
      this.glide = null; // { animation, fromX, fromY, toX, toY, endsAt }
      this.pressed = false; // pressed since the last approach or aim
      this.suspended = false; this.pendingPressAt = 0;
      this.breath = null; this.pressAnimation = null;
      this.restTimer = null; this.hideTimer = null; this.pressTimer = null;
    }
    mount(root) {
      if (this.el) return;
      const ripple = document.createElement('div');
      ripple.setAttribute('aria-hidden', 'true');
      decorations().add(ripple);
      ripple.style.cssText = `
        position: fixed; top: 0; left: 0;
        width: 40px; height: 40px; margin: -20px 0 0 -20px;
        box-sizing: border-box; border-radius: 50%;
        border: 2px solid rgba(108, 99, 255, 0.85);
        background: rgba(108, 99, 255, 0.10);
        pointer-events: none; z-index: 2147483647; opacity: 0;
      `;
      const el = document.createElement('div');
      el.id = 'webbrain-agent-target-cursor';
      el.setAttribute('aria-hidden', 'true');
      decorations().add(el);
      el.style.cssText = `
        position: fixed; top: 0; left: 0;
        width: ${CURSOR_W}px; height: ${CURSOR_H}px;
        pointer-events: none; z-index: 2147483647; opacity: 0;
        transition: ${CURSOR_TRANSITION};
        filter:
          drop-shadow(0 10px 20px rgba(108, 99, 255, 0.36))
          drop-shadow(0 2px 3px rgba(20, 18, 48, 0.22));
        will-change: transform, opacity;
      `;
      const body = document.createElement('div');
      // transform-origin on the arrow tip, so the click press never moves the point
      body.style.cssText = `width: 100%; height: 100%; transform-origin: ${TIP_X}px ${TIP_Y}px;`;
      body.innerHTML = CURSOR_SVG;
      el.appendChild(body);
      root.append(ripple, el);
      this.el = el; this.body = body; this.ripple = ripple;
    }
    // Where the tip is drawn right now, mid-glide included.
    current() {
      const glide = this.glide;
      if (!glide) return { x: this.x, y: this.y };
      let progress = null;
      try { progress = glide.animation.effect?.getComputedTiming?.().progress; } catch {}
      if (progress == null) return { x: this.x, y: this.y };
      return {
        x: glide.fromX + (glide.toX - glide.fromX) * progress,
        y: glide.fromY + (glide.toY - glide.fromY) * progress,
      };
    }
    // How long until the tip lands.
    remaining() {
      return this.glide ? Math.max(0, this.glide.endsAt - performance.now()) : 0;
    }
    // Send the tip to (x, y): a glide, or a jump when `instant`. Only the
    // landing transform is written to the style; the glide on top of it is
    // a Web Animation. Returns how long the glide takes.
    moveTo(x, y, instant = false, duration = 0) {
      const glide = this.glide;
      if (!instant && !duration && glide && Math.abs(glide.toX - x) < 0.5 && Math.abs(glide.toY - y) < 0.5) {
        return this.remaining();
      }
      const from = this.current();
      glide?.animation.cancel();
      this.glide = null;
      const to = tipTransform(x, y);
      this.el.style.transform = to;
      this.x = x; this.y = y;
      const distance = Math.hypot(x - from.x, y - from.y);
      if (instant || distance < 2 || typeof this.el.animate !== 'function') return 0;
      const ms = Math.round(duration || clamp(GLIDE_MIN_MS + distance * GLIDE_MS_PER_PX, GLIDE_MIN_MS, GLIDE_MAX_MS));
      const animation = this.el.animate(
        [{ transform: tipTransform(from.x, from.y) }, { transform: to }],
        { duration: ms, easing: GLIDE_EASING },
      );
      const next = { animation, fromX: from.x, fromY: from.y, toX: x, toY: y, endsAt: performance.now() + ms };
      this.glide = next;
      animation.onfinish = () => { if (this.glide === next) this.glide = null; };
      return ms;
    }
    // Glide to a target ahead of the agent's input. Returns ms until it lands.
    approach(x, y) {
      clearTimeout(this.restTimer);
      const still = prefersReducedMotion();
      const fresh = this.mode === 'hidden';
      const ms = this.moveTo(x, y, fresh || still);
      this.mode = 'approach';
      this.pressed = false;
      this.reveal();
      this.restTimer = setTimeout(() => this.rest(), APPROACH_TTL_MS);
      if (still) return 0;
      return fresh ? FADE_IN_MS : ms;
    }
    // The agent acts with the tip at (x, y) now. During an approach this is
    // the input it announced: a click presses as the tip lands, and the
    // verdict ends the approach. Otherwise it is a glide of its own.
    aim(x, y, click) {
      const fresh = this.mode === 'hidden';
      this.moveTo(x, y, fresh || prefersReducedMotion());
      this.reveal();
      if (this.mode === 'approach') {
        if (click) this.click();
        return;
      }
      clearTimeout(this.restTimer);
      this.mode = 'active';
      this.pressed = false;
      if (click) this.click();
      this.restTimer = setTimeout(() => this.rest(), TARGET_RING_TTL_MS);
    }
    // Press once, as the tip lands.
    click() {
      if (this.pressed || this.mode === 'hidden') return;
      this.pressed = true;
      if (prefersReducedMotion()) return;
      clearTimeout(this.pressTimer);
      const wait = this.remaining();
      if (wait > 0) this.pressTimer = setTimeout(() => this.playPress(), wait);
      else this.playPress();
    }
    // How the announced action went. A success presses if the click hasn't
    // yet; either way the cursor stays on the spot, then rests.
    finish(ok) {
      if (this.mode !== 'approach') return false;
      if (ok) this.click();
      this.mode = 'active';
      clearTimeout(this.restTimer);
      this.restTimer = setTimeout(() => this.rest(), this.remaining() + SETTLE_MS);
      return true;
    }
    // Keep up with scrolling without re-triggering the click.
    follow(x, y) {
      if (this.mode === 'hidden') return;
      if (Math.abs(x - this.x) < 0.5 && Math.abs(y - this.y) < 0.5) return;
      const left = this.remaining();
      if (left > 0) this.moveTo(x, y, false, Math.max(120, left));
      else this.moveTo(x, y, true);
    }
    rest() {
      if (this.mode !== 'active' && this.mode !== 'approach') return;
      this.mode = 'resting';
      if (prefersReducedMotion() || typeof this.body.animate !== 'function') return;
      this.breath?.cancel();
      this.breath = this.body.animate([
        { opacity: 1, easing: 'ease-in-out' },
        { opacity: 0.2, easing: 'ease-in-out' },
        { opacity: 1 },
      ], { duration: 1800, iterations: Infinity });
    }
    reveal() {
      clearTimeout(this.hideTimer);
      this.el.style.opacity = '1';
      this.settle();
    }
    // Leave the resting blink without an opacity jump.
    settle() {
      if (!this.breath) return;
      let current = 1;
      try { current = parseFloat(getComputedStyle(this.body).opacity) || 1; } catch {}
      this.breath.cancel();
      this.breath = null;
      if (current < 0.98 && typeof this.body.animate === 'function') {
        this.body.animate([{ opacity: current }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
      }
    }
    playPress() {
      this.pressTimer = null;
      if (!this.body || this.mode === 'hidden' || typeof this.body.animate !== 'function') return;
      // Hidden for a screenshot: play it when the cursor is back.
      if (this.suspended) { this.pendingPressAt = performance.now(); return; }
      this.pressAnimation?.cancel();
      this.pressAnimation = this.body.animate([
        { transform: 'scale(1)' },
        { transform: 'scale(0.84)', offset: 0.45 },
        { transform: 'scale(1)' },
      ], { duration: 320, easing: 'ease-out' });
      const at = `translate(${this.x.toFixed(1)}px, ${this.y.toFixed(1)}px)`;
      this.ripple.getAnimations?.().forEach(animation => animation.cancel());
      this.ripple.animate([
        { transform: `${at} scale(0.3)`, opacity: 0.95 },
        { transform: `${at} scale(1.6)`, opacity: 0 },
      ], { duration: 560, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });
    }
    hide() {
      clearTimeout(this.restTimer);
      clearTimeout(this.pressTimer);
      if (this.mode === 'hidden' || !this.el) return;
      this.mode = 'hidden';
      this.pendingPressAt = 0;
      this.el.style.opacity = '0';
      clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => {
        if (this.mode !== 'hidden') return;
        this.breath?.cancel();
        this.breath = null;
      }, 300);
    }
    suspend() {
      this.suspended = true;
      if (this.el) this.el.style.display = 'none';
      if (this.ripple) this.ripple.style.display = 'none';
    }
    resume() {
      this.suspended = false;
      if (this.el) this.el.style.display = '';
      if (this.ripple) this.ripple.style.display = '';
      const heldFor = this.pendingPressAt ? performance.now() - this.pendingPressAt : Infinity;
      this.pendingPressAt = 0;
      if (heldFor <= PENDING_PRESS_MAX_MS) this.playPress();
    }
    destroy() {
      clearTimeout(this.restTimer);
      clearTimeout(this.hideTimer);
      clearTimeout(this.pressTimer);
      this.glide?.animation.cancel();
      this.glide = null;
      this.breath?.cancel();
      this.pressAnimation?.cancel();
      this.el?.remove();
      this.ripple?.remove();
      this.el = null; this.body = null; this.ripple = null;
      this.mode = 'hidden';
    }
  }

  /* ------------------------------------------------------------------------
   * Stop button, target ring, lifecycle
   * ---------------------------------------------------------------------- */

  function createStopButton() {
    const container = document.createElement('div');
    container.id = 'webbrain-agent-stop-container';
    decorations().add(container);
    container.style.cssText = `
      position: fixed;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      justify-content: center;
      align-items: center;
      pointer-events: none;
      z-index: 2147483647;
    `;
    const button = document.createElement('button');
    button.id = 'webbrain-agent-stop-button';
    button.type = 'button';
    button.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 256 256" fill="currentColor"
           style="margin-right: 10px; vertical-align: middle;">
        <path d="M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm0,192a84,84,0,1,1,84-84A84.09,84.09,0,0,1,128,212Zm40-112v56a12,12,0,0,1-12,12H100a12,12,0,0,1-12-12V100a12,12,0,0,1,12-12h56A12,12,0,0,1,168,100Z"/>
      </svg>
      <span style="vertical-align: middle;">Stop WebBrain</span>
    `;
    button.style.cssText = `
      position: relative;
      transform: translateY(80px);
      padding: 11px 18px;
      background: #ffffff;
      color: #1a1a2e;
      border: 1px solid rgba(108, 99, 255, 0.30);
      border-radius: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-shadow:
        0 24px 48px rgba(108, 99, 255, 0.24),
        0 4px 14px rgba(108, 99, 255, 0.20);
      transition:
        transform 0.3s cubic-bezier(0.4, 0, 0.2, 1),
        opacity 0.3s ease,
        background 0.15s ease;
      opacity: 0;
      user-select: none;
      pointer-events: auto;
      white-space: nowrap;
      margin: 0 auto;
    `;
    button.addEventListener('mouseenter', () => {
      if (indicatorsActive) button.style.background = '#f3f0ff';
    });
    button.addEventListener('mouseleave', () => {
      if (indicatorsActive) button.style.background = '#ffffff';
    });
    button.addEventListener('click', async () => {
      // Clear the page-owned UI immediately. The background may have
      // restarted (or the run may already be gone), leaving this indicator
      // with no live background state to clean it up.
      hide();
      try {
        await chrome.runtime.sendMessage({ type: 'WB_STOP_AGENT' });
      } catch { /* extension context invalidated, ignore */ }
    });
    container.appendChild(button);
    return container;
  }

  function createTargetOutline() {
    const el = document.createElement('div');
    el.id = 'webbrain-agent-target-outline';
    decorations().add(el);
    el.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 2147483645;
      opacity: 0;
      border: 2px solid rgba(108, 99, 255, 0.96);
      border-radius: 10px;
      background: rgba(108, 99, 255, 0.035);
      transition:
        opacity 0.35s ease,
        top 0.3s cubic-bezier(0.2, 0.8, 0.2, 1),
        left 0.3s cubic-bezier(0.2, 0.8, 0.2, 1),
        width 0.3s cubic-bezier(0.2, 0.8, 0.2, 1),
        height 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
      animation: webbrain-target-ring 1.3s ease-in-out infinite;
    `;
    return el;
  }

  function getTargetRect() {
    if (targetRectOverride) return targetRectOverride;
    if (!targetElement || typeof targetElement.getBoundingClientRect !== 'function') return null;
    const rect = targetElement.getBoundingClientRect();
    if (
      !Number.isFinite(rect.left) ||
      !Number.isFinite(rect.top) ||
      rect.width < 1 ||
      rect.height < 1
    ) {
      return null;
    }

    const left = clamp(rect.left - 4, 4, Math.max(4, window.innerWidth - 12));
    const top = clamp(rect.top - 4, 4, Math.max(4, window.innerHeight - 12));
    const right = clamp(rect.right + 4, 4, window.innerWidth - 4);
    const bottom = clamp(rect.bottom + 4, 4, window.innerHeight - 4);
    if (right <= left || bottom <= top) return null;
    return {
      left,
      top,
      width: right - left,
      height: bottom - top,
      rawWidth: rect.width,
      rawHeight: rect.height,
    };
  }

  function cursorTip(rect) {
    const innerX = Math.min(Math.max(rect.rawWidth * 0.62, 14), Math.max(14, rect.rawWidth - 8));
    const innerY = Math.min(Math.max(rect.rawHeight * 0.58, 14), Math.max(14, rect.rawHeight - 8));
    return {
      x: clamp(rect.left + innerX, 8, window.innerWidth - CURSOR_W),
      y: clamp(rect.top + innerY, 8, window.innerHeight - CURSOR_H),
    };
  }

  function placeTargetRing(rect) {
    if (!targetOutlineEl) return;
    targetOutlineEl.style.left = `${Math.round(rect.left)}px`;
    targetOutlineEl.style.top = `${Math.round(rect.top)}px`;
    targetOutlineEl.style.width = `${Math.round(rect.width)}px`;
    targetOutlineEl.style.height = `${Math.round(rect.height)}px`;
    targetOutlineEl.style.borderRadius = `${rect.height < 28 ? 7 : 10}px`;
  }

  // Scroll/resize: keep the ring and the (possibly resting) cursor on the
  // element. If it scrolled out of view the cursor stays where it was.
  function placeTargetOverlay() {
    const rect = getTargetRect();
    if (!rect) return;
    placeTargetRing(rect);
    const tip = cursorTip(rect);
    cursor?.follow(tip.x, tip.y);
  }

  function scheduleTargetUpdate() {
    if (!targetElement || targetRaf) return;
    targetRaf = requestAnimationFrame(() => {
      targetRaf = 0;
      placeTargetOverlay();
    });
  }

  function clearTarget() {
    targetElement = null;
    targetRectOverride = null;
    if (ringTimer) {
      clearTimeout(ringTimer);
      ringTimer = null;
    }
    if (targetRaf) {
      cancelAnimationFrame(targetRaf);
      targetRaf = 0;
    }
    if (targetOutlineEl) targetOutlineEl.style.opacity = '0';
    cursor?.hide();
  }

  function armRingTimer(ms) {
    if (ringTimer) clearTimeout(ringTimer);
    ringTimer = setTimeout(() => {
      ringTimer = null;
      if (targetOutlineEl) targetOutlineEl.style.opacity = '0';
      // Outside a run nothing would hide a resting cursor, so it leaves with
      // the ring and its elements are removed once faded.
      if (!indicatorsActive) {
        clearTarget();
        setTimeout(() => {
          if (indicatorsActive || targetElement || targetRectOverride) return;
          cursor?.destroy();
          cursor = null;
          targetOutlineEl?.parentNode?.removeChild(targetOutlineEl);
          targetOutlineEl = null;
        }, 400);
      }
    }, ms);
  }

  // Ring the target and bring the cursor to it. With phase 'approach' the
  // cursor glides there ahead of the input and this returns ms until it
  // lands; otherwise the input happens now.
  function pointAtTarget(source, phase = null) {
    injectStyles();
    const root = document.body || document.documentElement;
    if (!root) return 0;
    const rect = getTargetRect();
    if (!rect) return 0;

    if (!targetOutlineEl) {
      targetOutlineEl = createTargetOutline();
      root.appendChild(targetOutlineEl);
    }
    targetOutlineEl.style.display = suspendedForToolUse ? 'none' : '';
    placeTargetRing(rect);
    targetOutlineEl.style.opacity = '1';

    if (!cursor) cursor = new AgentCursor();
    cursor.mount(root);
    if (suspendedForToolUse) cursor.suspend();
    const tip = cursorTip(rect);
    let arriveInMs = 0;
    if (phase === 'approach') arriveInMs = cursor.approach(tip.x, tip.y);
    else cursor.aim(tip.x, tip.y, /^click/.test(String(source || '')));
    effect?.target?.(rect);
    // The ring stays up while the agent is still on its way to act.
    armRingTimer(cursor.mode === 'approach' ? APPROACH_TTL_MS : TARGET_RING_TTL_MS);
    return arriveInMs;
  }

  function showTarget(el, source = 'interaction') {
    if (!el || typeof el.getBoundingClientRect !== 'function') return;
    targetElement = el;
    targetRectOverride = null;
    pointAtTarget(source);
  }

  function setTargetRect(rect) {
    if (!rect) return false;
    const x = Number(rect.x);
    const y = Number(rect.y);
    const w = Math.max(1, Number(rect.w ?? rect.width ?? 1));
    const h = Math.max(1, Number(rect.h ?? rect.height ?? 1));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return false;

    const width = Math.max(w, 28);
    const height = Math.max(h, 28);
    targetElement = null;
    targetRectOverride = {
      left: clamp(x - Math.max(0, width - w) / 2 - 4, 4, Math.max(4, window.innerWidth - 12)),
      top: clamp(y - Math.max(0, height - h) / 2 - 4, 4, Math.max(4, window.innerHeight - 12)),
      width: Math.min(width + 8, Math.max(1, window.innerWidth - 8)),
      height: Math.min(height + 8, Math.max(1, window.innerHeight - 8)),
      rawWidth: width,
      rawHeight: height,
    };
    return true;
  }

  function showTargetRect(rect, source = 'interaction') {
    if (setTargetRect(rect)) pointAtTarget(source);
  }

  function inView(el) {
    try {
      const r = el.getBoundingClientRect();
      return r.width >= 1 && r.height >= 1 && r.bottom > 0 && r.right > 0
        && r.top < window.innerHeight && r.left < window.innerWidth;
    } catch {
      return false;
    }
  }

  // The agent is about to act on this target (a rect, an accessibility-tree
  // ref_id or a selector): glide there first. Returns ms until the tip
  // lands, which the agent waits out before its input; 0 when nobody can
  // see the glide. A target not in view yet is left to the action, which
  // scrolls it into view and points at it then.
  function approachTarget(msg = {}) {
    let el = null;
    if (typeof msg.ref_id === 'string') {
      if (msg.pageUrl && msg.pageUrl !== location.href) return 0;
      try { el = window.__wb_ax_lookup?.(msg.ref_id) || null; } catch {}
      if (!el) return 0;
    } else if (typeof msg.selector === 'string') {
      try { el = document.querySelector(msg.selector); } catch {}
      if (!el) return 0;
    }
    if (el) {
      if (!inView(el)) return 0;
      targetElement = el;
      targetRectOverride = null;
    } else if (!setTargetRect(msg.rect)) {
      return 0;
    }
    const arriveInMs = pointAtTarget(msg.source || 'click', 'approach');
    return document.visibilityState === 'visible' && !suspendedForToolUse ? arriveInMs : 0;
  }

  // The announced action's verdict.
  function finishTarget(ok) {
    if (cursor?.finish(ok === true)) armRingTimer(TARGET_RING_TTL_MS);
  }

  // CDP input reaches the page as trusted events: a press on the target the
  // cursor is holding at is the click it announced, so it presses with it.
  function onPagePress(event) {
    if (!event.isTrusted || cursor?.mode !== 'approach' || cursor.pressed) return;
    const rect = getTargetRect();
    if (!rect) return;
    const pad = 12;
    if (event.clientX >= rect.left - pad && event.clientX <= rect.left + rect.width + pad
        && event.clientY >= rect.top - pad && event.clientY <= rect.top + rect.height + pad) {
      cursor.click();
    }
  }

  function show(randomStyle) {
    // The background keeps this choice across reloads and repeated SHOWs.
    // Older callers without a choice still get one effect per activation.
    if (STYLES.includes(randomStyle)) runRandomStyle = randomStyle;
    else if (!indicatorsActive) runRandomStyle = pick(STYLES.filter(style => style !== runRandomStyle));
    indicatorsActive = true;
    suspendedForToolUse = false;
    armIndicatorHeartbeat();
    injectStyles();

    const root = document.body || document.documentElement;
    if (!root) return; // page hasn't parsed yet — extremely unlikely on document_idle

    // Until the saved style has loaded, the loader starts the effect.
    if (styleLoaded) startEffect();

    if (stopContainerEl) {
      // The container lays its button out as flex (createStopButton).
      stopContainerEl.style.display = 'flex';
    } else {
      stopContainerEl = createStopButton();
      root.appendChild(stopContainerEl);
    }

    // Two RAFs: first to land the elements in the DOM (so the browser
    // computes their initial transforms with opacity 0 / translateY 80px),
    // second to apply the in-flight values for a clean transition.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const btn = stopContainerEl?.querySelector('#webbrain-agent-stop-button');
        if (btn) {
          btn.style.transform = 'translateY(0)';
          btn.style.opacity = '1';
        }
      });
    });
  }

  function hide() {
    clearIndicatorHeartbeat();
    if (!indicatorsActive) return;
    indicatorsActive = false;
    effect?.hide();
    clearTarget();
    const btn = stopContainerEl?.querySelector('#webbrain-agent-stop-button');
    if (btn) {
      btn.style.transform = 'translateY(80px)';
      btn.style.opacity = '0';
    }
    setTimeout(() => {
      // Bail if the user re-triggered show() during the fade-out.
      if (indicatorsActive) return;
      effect?.destroy();
      effect = null;
      cursor?.destroy();
      cursor = null;
      stopContainerEl?.parentNode?.removeChild(stopContainerEl);
      targetOutlineEl?.parentNode?.removeChild(targetOutlineEl);
      stopContainerEl = null;
      targetOutlineEl = null;
    }, 520);
  }

  function clearIndicatorHeartbeat() {
    if (indicatorHeartbeatTimer != null) clearTimeout(indicatorHeartbeatTimer);
    indicatorHeartbeatTimer = null;
  }

  function armIndicatorHeartbeat() {
    clearIndicatorHeartbeat();
    indicatorHeartbeatTimer = setTimeout(() => {
      indicatorHeartbeatTimer = null;
      if (indicatorsActive) hide();
    }, INDICATOR_HEARTBEAT_TIMEOUT_MS);
  }

  /**
   * Hide everything without tearing it down — for the brief window around a
   * screenshot capture, so the agent doesn't see its own effect or cursor in
   * the screenshots it sends back to the model. The captures of one screen
   * update each ask while it is already hidden: a repeat keeps what the
   * first call saved. Returns whether anything was hidden.
   */
  function hideForToolUse() {
    if (suspendedForToolUse) return false;
    suspendedForToolUse = true;
    savedStopVisible = !!(stopContainerEl && stopContainerEl.style.display !== 'none');
    savedTargetOutlineVisible = !!(targetOutlineEl && targetOutlineEl.style.display !== 'none');
    effect?.suspend();
    cursor?.suspend();
    if (stopContainerEl) stopContainerEl.style.display = 'none';
    if (targetOutlineEl) targetOutlineEl.style.display = 'none';
    return true;
  }

  function showAfterToolUse() {
    suspendedForToolUse = false;
    effect?.resume();
    cursor?.resume();
    if (savedStopVisible && stopContainerEl) stopContainerEl.style.display = 'flex';
    if (savedTargetOutlineVisible && targetOutlineEl) targetOutlineEl.style.display = '';
    savedStopVisible = false;
    savedTargetOutlineVisible = false;
  }

  window.addEventListener('scroll', scheduleTargetUpdate, true);
  window.addEventListener('resize', scheduleTargetUpdate, true);
  window.addEventListener('pointerdown', onPagePress, { capture: true, passive: true });
  window.__webbrainAgentIndicator = { showTarget, showTargetRect, approachTarget, finishTarget, hideTarget: clearTarget };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'WB_SHOW_AGENT_INDICATORS':
        show(msg.randomStyle);
        sendResponse({ ok: true });
        break;
      case 'WB_HIDE_AGENT_INDICATORS':
        hide();
        sendResponse({ ok: true });
        break;
      case 'WB_AGENT_INDICATOR_HEARTBEAT':
        if (indicatorsActive) armIndicatorHeartbeat();
        sendResponse({ ok: true, active: indicatorsActive });
        break;
      case 'WB_HIDE_FOR_TOOL_USE':
        sendResponse({ ok: true, changed: hideForToolUse() });
        break;
      case 'WB_SHOW_AFTER_TOOL_USE':
        showAfterToolUse();
        sendResponse({ ok: true });
        break;
      case 'WB_SHOW_AGENT_TARGET':
        if (msg.phase === 'approach') {
          sendResponse({ ok: true, arriveInMs: approachTarget(msg) });
          break;
        }
        if (msg.phase === 'done') finishTarget(msg.ok === true);
        else if (msg.rect) showTargetRect(msg.rect, msg.source || 'message');
        sendResponse({ ok: true });
        break;
      // Unknown messages are silently ignored — other content scripts in
      // the same world might be using chrome.runtime.onMessage too.
    }
    // Synchronous response — return falsy so the channel closes.
  });
})();
