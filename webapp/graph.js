/* MyBrain network view: a fast canvas renderer with touch + mouse controls.
 *
 * - one finger: drag the map (or drag a neuron)  - two fingers: pinch to zoom
 * - tap a neuron: select it                      - mouse wheel: zoom
 * Built to stay smooth on a phone: capped pixel ratio, draws only what is on
 * screen, simplifies while you move, limits labels when zoomed out.
 */
(function () {
  'use strict';

  const NODE_K = 0.78;                  // neuron size on screen
  const SIGNAL = '#5eead4';             // colour of firing signals and paths
  const PALETTE = ['#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F',
                   '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC'];

  function hexToRgb(h) {
    const v = parseInt(h.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  class BrainGraph {
    constructor(canvas, map, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.map = map;
      this.onSelect = opts.onSelect || (() => {});
      this.onHover = opts.onHover || (() => {});
      this.theme = opts.theme || 'dark';

      const n = this.n = map.nodes.label.length;
      const ed = map.edges;
      this.E = ed.length / 3;
      this.es = new Int32Array(this.E);
      this.et = new Int32Array(this.E);
      this.er = new Int32Array(this.E);
      for (let e = 0; e < this.E; e++) {
        this.es[e] = ed[3 * e]; this.et[e] = ed[3 * e + 1]; this.er[e] = ed[3 * e + 2];
      }
      this.deg = Int32Array.from(map.nodes.deg);
      this.lobe = Int32Array.from(map.nodes.lobe);

      // Lobe -> colour (same palette and order as the classic graph.html).
      this.lobeColor = new Map();
      this.lobeName = new Map();
      for (const [cid, name] of map.lobes) {
        this.lobeColor.set(cid, cid >= 0 ? cid % PALETTE.length : PALETTE.length - 1);
        this.lobeName.set(cid, name);
      }
      this.col = new Uint8Array(n);
      for (let i = 0; i < n; i++) this.col[i] = this.lobeColor.get(this.lobe[i]) ?? 9;

      this.rw = new Float32Array(n);          // world radius
      for (let i = 0; i < n; i++) this.rw[i] = 2.5 + 1.1 * Math.sqrt(this.deg[i]);

      // Neighbour lists (CSR) for selection highlight / connections.
      const cnt = new Int32Array(n + 1);
      for (let e = 0; e < this.E; e++) { cnt[this.es[e] + 1]++; cnt[this.et[e] + 1]++; }
      for (let i = 0; i < n; i++) cnt[i + 1] += cnt[i];
      this.adjStart = cnt;
      this.adj = new Int32Array(2 * this.E);   // edge ids
      const fillp = cnt.slice(0, n);
      for (let e = 0; e < this.E; e++) {
        this.adj[fillp[this.es[e]]++] = e;
        this.adj[fillp[this.et[e]]++] = e;
      }

      // Neurons ordered by importance (for labels).
      this.byDeg = Array.from({ length: n }, (_, i) => i).sort((a, b) => this.deg[b] - this.deg[a]);

      this.x = new Float32Array(n);
      this.y = new Float32Array(n);
      this.hasLayout = false;
      this.hiddenLobes = new Set();
      this.selected = -1;
      this.focus = null;                       // Set of highlighted neuron ids
      this.path = null;                        // {nodes, edges} of a shown path
      this.scale = 1; this.tx = 0; this.ty = 0;
      this.interacting = false;
      this._drawQueued = false;
      this._lobeCentres = null;

      this.animate = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      this.pulses = [];
      this._glows = new Map();
      this._frame = (t) => this._tick(t);
      this._vis = () => { if (!document.hidden) this._kick(); };
      document.addEventListener('visibilitychange', this._vis);
      this._resize = this.resize.bind(this);
      window.addEventListener('resize', this._resize);
      this.resize();
      this._bindInput();
    }

    destroy() {
      this._destroyed = true;
      document.removeEventListener('visibilitychange', this._vis);
      window.removeEventListener('resize', this._resize);
      this._unbind && this._unbind();
    }

    // ---------------------------------------------------------------- layout --
    setPositions(pos, fit) {
      for (let i = 0; i < this.n; i++) { this.x[i] = pos[2 * i]; this.y[i] = pos[2 * i + 1]; }
      this._lobeCentres = null; this._cores = null;
      if (!this.hasLayout || fit) this.fit(false);
      this.hasLayout = true;
      this.draw();
    }

    positions() {
      const p = new Float32Array(2 * this.n);
      for (let i = 0; i < this.n; i++) { p[2 * i] = this.x[i]; p[2 * i + 1] = this.y[i]; }
      return p;
    }

    bounds(ids) {
      // For the whole map, frame the middle 98% of neurons so a few far-out
      // stragglers don't shrink everything else to dust.
      const xs = [], ys = [];
      const it = ids || { forEach: (f) => { for (let i = 0; i < this.n; i++) f(i); } };
      it.forEach(i => {
        if (this.hiddenLobes.has(this.lobe[i])) return;
        xs.push(this.x[i]); ys.push(this.y[i]);
      });
      if (!xs.length) return [0, 0, 1, 1];
      const q = ids || xs.length < 50 ? 0 : 0.01;
      const pick = (a) => {
        const s = Float32Array.from(a).sort();
        return [s[Math.floor(q * (s.length - 1))], s[Math.ceil((1 - q) * (s.length - 1))]];
      };
      const [x0, x1] = pick(xs), [y0, y1] = pick(ys);
      return [x0, y0, x1, y1];
    }

    fit(animate = true, ids = null) {
      const [x0, y0, x1, y1] = this.bounds(ids);
      const pad = 40;
      const w = Math.max(x1 - x0, 50), h = Math.max(y1 - y0, 50);
      let s = Math.min((this.W - 2 * pad) / w, (this.H - 2 * pad - this.bottomInset) / h);
      if (ids) s = Math.min(s, 2.5);
      const tx = this.W / 2 - s * (x0 + x1) / 2;
      const ty = (this.H - this.bottomInset) / 2 - s * (y0 + y1) / 2;
      this.animateTo(s, tx, ty, animate ? 450 : 0);
    }

    animateTo(s, tx, ty, ms) {
      if (!ms) { this.scale = s; this.tx = tx; this.ty = ty; this.draw(); return; }
      const s0 = this.scale, x0 = this.tx, y0 = this.ty, t0 = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - t0) / ms), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        // zoom in log space so it feels even
        this.scale = Math.exp(Math.log(s0) + (Math.log(s) - Math.log(s0)) * e);
        this.tx = x0 + (tx - x0) * e; this.ty = y0 + (ty - y0) * e;
        this.interacting = k < 1; this.cameraOnly = true;
        this.draw();
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }

    centreOn(i, scale) {
      const s = scale || Math.max(this.scale, 1.6);
      this.animateTo(s, this.W / 2 - s * this.x[i], (this.H - this.bottomInset) / 2 - s * this.y[i], 450);
    }

    // ------------------------------------------------------------- selection --
    select(i, opts = {}) {
      this.selected = i;
      this.path = null;
      this.pulses = [];
      if (i < 0) { this.focus = null; this.draw(); this.onSelect(-1); return; }
      const f = new Set([i]);
      for (let k = this.adjStart[i]; k < this.adjStart[i + 1]; k++) {
        const e = this.adj[k]; f.add(this.es[e] === i ? this.et[e] : this.es[e]);
      }
      this.focus = f;
      if (opts.centre) this.centreOn(i);
      this.draw();
      this.onSelect(i);
    }

    // Shortest chain of synapses between two neurons, ignoring direction
    // (like `mybrain path --undirected`). Returns null when not connected.
    findPath(a, b) {
      if (a === b) return { nodes: [a], edges: [] };
      const prevE = new Int32Array(this.n).fill(-1), seen = new Uint8Array(this.n);
      let q = [a]; seen[a] = 1;
      while (q.length && !seen[b]) {
        const nq = [];
        for (const u of q) {
          for (let k = this.adjStart[u]; k < this.adjStart[u + 1]; k++) {
            const e = this.adj[k], v = this.es[e] === u ? this.et[e] : this.es[e];
            if (seen[v]) continue;
            seen[v] = 1; prevE[v] = e; nq.push(v);
          }
        }
        q = nq;
      }
      if (!seen[b]) return null;
      const nodes = [b], edges = [];
      for (let v = b; v !== a;) {
        const e = prevE[v]; edges.push(e);
        v = this.es[e] === v ? this.et[e] : this.es[e];
        nodes.push(v);
      }
      return { nodes: nodes.reverse(), edges: edges.reverse() };
    }

    setPath(p) {
      this.path = p;
      this.pulses = [];
      this.selected = -1;
      this.focus = p ? new Set(p.nodes) : null;
      if (p) this.fit(true, p.nodes);
      this.draw();
    }

    connections(i) {
      const out = [], inc = [];
      for (let k = this.adjStart[i]; k < this.adjStart[i + 1]; k++) {
        const e = this.adj[k];
        const rel = this.map.rels[this.er[e]];
        if (this.es[e] === i) out.push({ node: this.et[e], rel });
        else inc.push({ node: this.es[e], rel });
      }
      const byDeg = (a, b) => this.deg[b.node] - this.deg[a.node];
      return { out: out.sort(byDeg), inc: inc.sort(byDeg) };
    }

    setHiddenLobes(set) { this.hiddenLobes = set; this._lobeCentres = null; this.draw(); }

    // ---------------------------------------------------------------- render --
    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.W = r.width; this.H = r.height;
      // Cap the pixel ratio: big graphs at 1.5x, small at 2x. Phones are often 3x.
      const cap = this.n > 20000 ? 1.25 : this.n > 5000 ? 1.5 : 2;
      this.dpr = Math.min(window.devicePixelRatio || 1, cap);
      this.canvas.width = Math.round(this.W * this.dpr);
      this.canvas.height = Math.round(this.H * this.dpr);
      this.bottomInset = this.bottomInset || 0;
      this.draw();
    }

    // Rendering is driven by one loop: full redraws when something changed,
    // otherwise the last full frame is reused and only the animation layer
    // (firing signals, breathing core neurons) is drawn on top.
    draw() { this._dirty = true; this._kick(); }

    _kick() {
      if (this._loopOn || this._destroyed) return;
      this._loopOn = true;
      requestAnimationFrame(this._frame);
    }

    _tick(now) {
      this._loopOn = false;
      if (this._destroyed) return;
      const anim = this.animate && this.hasLayout && !document.hidden;
      if (this._dirty) { this._dirty = false; this._render(); }
      else if (anim) {
        if (this.interacting || !this._snap) this._render();
        else {
          const ctx = this.ctx;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(this._snap.canvas, 0, 0);
        }
      }
      if (anim) {
        this._overlay(now);
        this._loopOn = true;
        requestAnimationFrame(this._frame);
      }
    }

    setAnimate(on) { this.animate = on; this.pulses = []; this.draw(); }

    _glow(color) {
      let g = this._glows.get(color);
      if (g) return g;
      g = document.createElement('canvas'); g.width = g.height = 64;
      const c = g.getContext('2d'), rg = c.createRadialGradient(32, 32, 0, 32, 32, 32);
      rg.addColorStop(0, '#ffffff'); rg.addColorStop(0.18, color);
      rg.addColorStop(0.5, color + '55'); rg.addColorStop(1, color + '00');
      c.fillStyle = rg; c.fillRect(0, 0, 64, 64);
      this._glows.set(color, g);
      return g;
    }

    _spawn(now) {
      const small = this.W < 600;
      const want = this.path ? 6 : this.selected >= 0 ? (small ? 18 : 30) : (small ? 34 : 70);
      const s = this.scale, tx = this.tx, ty = this.ty, X = this.x, Y = this.y;
      const onScreen = (i) => {
        const sx = X[i] * s + tx, sy = Y[i] * s + ty;
        return sx > -20 && sy > -20 && sx < this.W + 20 && sy < this.H + 20 &&
          !(this.hiddenLobes.size && this.hiddenLobes.has(this.lobe[i]));
      };
      let budget = 4;
      while (this.pulses.length < want && budget-- > 0) {
        let e = -1, from = -1;
        if (this.path) {
          if (this.pulses.some(p => p.path)) break;
          this.pulses.push({ path: true, k: 0, t: 0, dur: 520 });
          break;
        } else if (this.selected >= 0) {
          const i = this.selected, d = this.adjStart[i + 1] - this.adjStart[i];
          if (!d) break;
          e = this.adj[this.adjStart[i] + Math.floor(Math.random() * d)]; from = i;
        } else {
          for (let tries = 0; tries < 12; tries++) {
            const c = Math.floor(Math.random() * this.E);
            if (onScreen(this.es[c]) || onScreen(this.et[c])) { e = c; break; }
          }
          if (e < 0) break;
          from = Math.random() < 0.5 ? this.es[e] : this.et[e];
        }
        const to = this.es[e] === from ? this.et[e] : this.es[e];
        this.pulses.push({ a: from, b: to, t: 0, dur: 650 + Math.random() * 900, born: now });
      }
    }

    _overlay(now) {
      const dt = Math.min(64, now - (this._last || now));
      this._last = now;
      const ctx = this.ctx, dpr = this.dpr, s = this.scale, tx = this.tx, ty = this.ty, X = this.x, Y = this.y;
      const dark = this.theme === 'dark';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
      const rScale = Math.sqrt(s);

      // breathing core neurons
      if (!this.focus) {
        const cores = this._cores || (this._cores = this.byDeg.slice(0, 24));
        for (let k = 0; k < cores.length; k++) {
          const i = cores[k];
          if (this.hiddenLobes.size && this.hiddenLobes.has(this.lobe[i])) continue;
          const sx = X[i] * s + tx, sy = Y[i] * s + ty;
          if (sx < -40 || sy < -40 || sx > this.W + 40 || sy > this.H + 40) continue;
          const r = Math.max(9, this.rw[i] * rScale * NODE_K * 3.2);
          ctx.globalAlpha = 0.22 + 0.2 * Math.sin(now / 700 + k * 1.7);
          ctx.drawImage(this._glow(PALETTE[this.col[i]]), sx - r, sy - r, 2 * r, 2 * r);
        }
      }

      // firing signals
      this._spawn(now);
      const size = Math.max(5, Math.min(11, 7 * rScale));
      const keep = [];
      for (const p of this.pulses) {
        p.t += dt / p.dur;
        let a, b, t = Math.min(1, p.t), color;
        if (p.path) {
          if (!this.path) continue;
          if (t >= 1) { p.k++; p.t = 0; t = 0; if (p.k >= this.path.edges.length) { p.k = 0; } }
          a = this.path.nodes[p.k]; b = this.path.nodes[p.k + 1];
          color = SIGNAL;
        } else {
          a = p.a; b = p.b;
          color = this.selected >= 0 ? SIGNAL : PALETTE[this.col[a]];
        }
        const ax = X[a] * s + tx, ay = Y[a] * s + ty, bx = X[b] * s + tx, by = Y[b] * s + ty;
        const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const px = ax + (bx - ax) * e, py = ay + (by - ay) * e;
        const t0 = Math.max(0, e - 0.22), qx = ax + (bx - ax) * t0, qy = ay + (by - ay) * t0;
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.2, size / 4);
        ctx.beginPath(); ctx.moveTo(qx, qy); ctx.lineTo(px, py); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.drawImage(this._glow(color), px - size, py - size, 2 * size, 2 * size);
        if (!p.path && p.t >= 1) {                     // arrival spark
          const k = Math.min(1, (p.t - 1) * p.dur / 380);
          ctx.globalAlpha = 1 - k;
          const r = size * (1 + 2.2 * k);
          ctx.drawImage(this._glow(color), bx - r, by - r, 2 * r, 2 * r);
          if (k < 1) keep.push(p);
          continue;
        }
        keep.push(p);
      }
      this.pulses = keep;
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    _colors() {
      const dark = this.theme === 'dark';
      return {
        bg: dark ? '#0f0f1a' : '#ffffff',
        label: dark ? 'rgba(255,255,255,0.92)' : 'rgba(20,20,30,0.92)',
        halo: dark ? 'rgba(15,15,26,0.85)' : 'rgba(255,255,255,0.85)',
        edgeAlpha: dark ? 0.38 : 0.42,
        lobeLabel: dark ? 'rgba(255,255,255,0.75)' : 'rgba(20,20,30,0.75)',
      };
    }

    _lobeCentresCompute() {
      const m = new Map();
      for (let i = 0; i < this.n; i++) {
        const c = this.lobe[i];
        let v = m.get(c); if (!v) { v = [0, 0, 0]; m.set(c, v); }
        v[0] += this.x[i]; v[1] += this.y[i]; v[2]++;
      }
      const arr = [];
      for (const [c, v] of m) arr.push({ c, x: v[0] / v[2], y: v[1] / v[2], size: v[2] });
      arr.sort((a, b) => b.size - a.size);
      return arr;
    }

    _render() {
      const t0 = performance.now();
      const ctx = this.ctx, C = this._colors();
      const dpr = this.dpr, s = this.scale, tx = this.tx, ty = this.ty;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      if (!this.hasLayout) return;
      // Big maps: while the camera moves, slide/scale a snapshot of the last
      // full frame (instant), and redraw it sharp when the gesture ends.
      const snap = this._snap;
      if (this.interacting && this.cameraOnly && snap && snap.dpr === dpr &&
          (this.n > 6000 || this.fullMs > 25)) {
        const k = s / snap.s;
        ctx.setTransform(k, 0, 0, k, dpr * (tx - snap.tx * k), dpr * (ty - snap.ty * k));
        ctx.drawImage(snap.canvas, 0, 0);
        this.lastFrameMs = performance.now() - t0;
        return;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const W = this.W, H = this.H, n = this.n, X = this.x, Y = this.y;
      const hidden = this.hiddenLobes, hasHidden = hidden.size > 0;
      const focus = this.focus;
      // visible world rect (+margin)
      const m = 30 / s;
      const wx0 = -tx / s - m, wy0 = -ty / s - m, wx1 = (W - tx) / s + m, wy1 = (H - ty) / s + m;
      const vis = (i) => X[i] >= wx0 && X[i] <= wx1 && Y[i] >= wy0 && Y[i] <= wy1 &&
                         !(hasHidden && hidden.has(this.lobe[i]));

      // ---- synapses
      const heavy = this.E > 12000;
      const skipEdges = this.interacting && heavy;
      if (!skipEdges) {
        const lw = Math.max(0.6, Math.min(1.8, 0.75 * Math.sqrt(s)));
        ctx.lineWidth = lw;
        ctx.globalAlpha = focus ? 0.05 : (heavy ? C.edgeAlpha * 0.8 : C.edgeAlpha);
        // bucket by source colour: one path per colour
        const paths = [];
        for (let k = 0; k < PALETTE.length; k++) paths.push(new Path2D());
        const es = this.es, et = this.et, col = this.col;
        for (let e = 0; e < this.E; e++) {
          const a = es[e], b = et[e];
          const av = X[a] >= wx0 && X[a] <= wx1 && Y[a] >= wy0 && Y[a] <= wy1;
          const bv = X[b] >= wx0 && X[b] <= wx1 && Y[b] >= wy0 && Y[b] <= wy1;
          if (!av && !bv) continue;
          if (hasHidden && (hidden.has(this.lobe[a]) || hidden.has(this.lobe[b]))) continue;
          const p = paths[col[a]];
          p.moveTo(X[a] * s + tx, Y[a] * s + ty);
          p.lineTo(X[b] * s + tx, Y[b] * s + ty);
        }
        for (let k = 0; k < PALETTE.length; k++) { ctx.strokeStyle = PALETTE[k]; ctx.stroke(paths[k]); }
        if (focus && this.selected >= 0) {
          const i = this.selected;
          ctx.globalAlpha = 0.9; ctx.lineWidth = Math.max(1, lw * 1.8);
          ctx.strokeStyle = PALETTE[this.col[i]];
          ctx.beginPath();
          for (let k = this.adjStart[i]; k < this.adjStart[i + 1]; k++) {
            const e = this.adj[k], a = es[e], b = et[e];
            ctx.moveTo(X[a] * s + tx, Y[a] * s + ty); ctx.lineTo(X[b] * s + tx, Y[b] * s + ty);
          }
          ctx.stroke();
        }
        if (this.path) {                      // glowing path, like the CLI demo
          ctx.globalAlpha = 1;
          ctx.strokeStyle = '#5eead4';
          ctx.shadowColor = '#5eead4'; ctx.shadowBlur = 10;
          ctx.lineWidth = 3;
          ctx.beginPath();
          for (const e of this.path.edges) {
            const a = es[e], b = et[e];
            ctx.moveTo(X[a] * s + tx, Y[a] * s + ty); ctx.lineTo(X[b] * s + tx, Y[b] * s + ty);
          }
          ctx.stroke();
          ctx.shadowBlur = 0;
        }
      }

      // ---- neurons
      const rScale = Math.sqrt(s);       // grow slower than zoom, like vis-network
      const rects = [];
      for (let k = 0; k < PALETTE.length; k++) rects.push(new Path2D());
      const arcs = [];
      for (let k = 0; k < PALETTE.length; k++) arcs.push(new Path2D());
      let shown = 0;
      for (let i = 0; i < n; i++) {
        if (!vis(i)) continue;
        if (focus && focus.has(i)) continue;      // drawn on top below
        const sx = X[i] * s + tx, sy = Y[i] * s + ty;
        const r = Math.max(1.6, this.rw[i] * rScale * NODE_K);
        const k = this.col[i];
        if (r < 2.2) rects[k].rect(sx - r, sy - r, 2 * r, 2 * r);
        else { arcs[k].moveTo(sx + r, sy); arcs[k].arc(sx, sy, r, 0, 6.2832); }
        shown++;
      }
      ctx.globalAlpha = focus ? 0.18 : 1;
      for (let k = 0; k < PALETTE.length; k++) {
        ctx.fillStyle = PALETTE[k];
        ctx.fill(rects[k]); ctx.fill(arcs[k]);
      }
      ctx.globalAlpha = 1;
      if (focus) {
        for (const i of focus) {
          if (hasHidden && hidden.has(this.lobe[i])) continue;
          const sx = X[i] * s + tx, sy = Y[i] * s + ty;
          const r = Math.max(2.5, this.rw[i] * rScale * NODE_K) * (i === this.selected ? 1.6 : 1.1);
          ctx.fillStyle = PALETTE[this.col[i]];
          ctx.beginPath(); ctx.arc(sx, sy, r, 0, 6.2832); ctx.fill();
          if (i === this.selected) {
            ctx.lineWidth = 2.5; ctx.strokeStyle = C.label; ctx.stroke();
          }
          if (this.path) {
            ctx.shadowColor = '#5eead4'; ctx.shadowBlur = 14;
            ctx.lineWidth = 2; ctx.strokeStyle = '#5eead4'; ctx.stroke();
            ctx.shadowBlur = 0;
          }
        }
      }

      // ---- labels
      if (!(this.interacting && n > 20000)) this._labels(ctx, C, vis, rScale);
      this.lastFrameMs = performance.now() - t0;
      this.lastShown = shown;
      if (!this.interacting) {
        this.fullMs = this.lastFrameMs;
        {
          let c = this._snap && this._snap.canvas;
          if (!c || c.width !== this.canvas.width || c.height !== this.canvas.height) {
            c = document.createElement('canvas');
            c.width = this.canvas.width; c.height = this.canvas.height;
          }
          c.getContext('2d').drawImage(this.canvas, 0, 0);
          this._snap = { canvas: c, s, tx, ty, dpr };
        }
      }
    }

    _labels(ctx, C, vis, rScale) {
      const s = this.scale, tx = this.tx, ty = this.ty, X = this.x, Y = this.y;
      const small = window.innerWidth < 600;
      const cap = this.interacting ? (small ? 25 : 50) : (small ? 70 : 160);
      const grid = new Set(), cell = 14;
      const place = (sx, sy, w, h) => {      // coarse collision grid
        const x0 = Math.floor((sx - w / 2) / cell), x1 = Math.floor((sx + w / 2) / cell);
        const y0 = Math.floor((sy - h) / cell), y1 = Math.floor(sy / cell);
        for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++)
          if (grid.has(gx * 100003 + gy)) return false;
        for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) grid.add(gx * 100003 + gy);
        return true;
      };
      ctx.textAlign = 'center';
      ctx.lineJoin = 'round';
      const drawText = (txt, sx, sy, font, color) => {
        ctx.font = font;
        const w = ctx.measureText(txt).width;
        if (!place(sx, sy, w + 6, 17)) return false;
        ctx.lineWidth = 3.5; ctx.strokeStyle = C.halo; ctx.strokeText(txt, sx, sy);
        ctx.fillStyle = color; ctx.fillText(txt, sx, sy);
        return true;
      };
      const trim = (t) => (t.length > 28 ? t.slice(0, 27) + '…' : t);
      const L = this.map.nodes.label;
      let placed = 0;

      // selection first
      if (this.focus) {
        const sel = this.selected;
        const order = this.path ? this.path.nodes :
          [sel, ...[...this.focus].filter(i => i !== sel).sort((a, b) => this.deg[b] - this.deg[a])];
        for (const i of order.slice(0, small ? 30 : 60)) {
          if (!vis(i)) continue;
          const r = Math.max(2.5, this.rw[i] * rScale * NODE_K);
          drawText(trim(L[i]), X[i] * s + tx, Y[i] * s + ty - r - 4,
            i === sel || this.path ? '600 15px system-ui, sans-serif' : '13px system-ui, sans-serif', C.label);
        }
        return;
      }

      // zoomed out: lobe names at their centres
      const zoomedOut = 6.5 * rScale * NODE_K < 5;     // a typical neuron is tiny on screen
      if (zoomedOut) {
        if (!this._lobeCentres) this._lobeCentres = this._lobeCentresCompute();
        for (const c of this._lobeCentres) {
          if (placed >= (small ? 18 : 40)) break;
          if (this.hiddenLobes.has(c.c)) continue;
          const sx = c.x * s + tx, sy = c.y * s + ty;
          if (sx < 0 || sy < 0 || sx > this.W || sy > this.H) continue;
          if (c.size < 3) continue;                        // tiny lobes: no name
          const nm = this.lobeName.get(c.c) || '';
          if (drawText(trim(nm), sx, sy, '600 14px system-ui, sans-serif', C.lobeLabel)) placed++;
        }
        return;
      }
      // zoomed in: neuron labels, most-connected first
      const scanMax = Math.min(this.n, 30000);
      for (let k = 0; k < scanMax && placed < cap; k++) {
        const i = this.byDeg[k];
        if (!vis(i)) continue;
        const r = Math.max(1.6, this.rw[i] * rScale * NODE_K);
        if (r < 3) continue;
        const sx = X[i] * s + tx, sy = Y[i] * s + ty;
        if (sx < 0 || sy < 0 || sx > this.W || sy > this.H) continue;
        if (drawText(trim(L[i]), sx, sy - r - 3, '13px system-ui, sans-serif', C.label)) placed++;
      }
    }

    // ----------------------------------------------------------------- input --
    hit(px, py) {
      const s = this.scale, wx = (px - this.tx) / s, wy = (py - this.ty) / s;
      const rScale = Math.sqrt(s);
      let best = -1, bestD = Infinity;
      const tol = 14 / s;                       // finger-sized tolerance (screen px)
      for (let i = 0; i < this.n; i++) {
        if (this.hiddenLobes.size && this.hiddenLobes.has(this.lobe[i])) continue;
        const dx = this.x[i] - wx, dy = this.y[i] - wy;
        const d = dx * dx + dy * dy;
        const r = Math.max(1.6, this.rw[i] * rScale * NODE_K) / s + tol;
        if (d < r * r && d < bestD) { bestD = d; best = i; }
      }
      return best;
    }

    _bindInput() {
      const cv = this.canvas;
      const pts = new Map();
      let mode = null, start = null, dragNode = -1, pinch = null, endTimer = 0, holdTimer = 0;
      const local = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
      const begin = (camera = true) => { this.interacting = true; this.cameraOnly = camera; clearTimeout(endTimer); };
      const end = () => { clearTimeout(endTimer); endTimer = setTimeout(() => { this.interacting = false; this.draw(); }, 120); };

      const down = (e) => {
        cv.setPointerCapture(e.pointerId);
        const p = local(e);
        pts.set(e.pointerId, p);
        if (pts.size === 1) {
          start = { x: p[0], y: p[1], t: performance.now(), tx: this.tx, ty: this.ty };
          dragNode = this.hasLayout ? this.hit(p[0], p[1]) : -1;
          mode = 'maybe';
          // Touch: hold a neuron for a moment to pick it up; a quick drag pans.
          start.mouse = e.pointerType === 'mouse';
          clearTimeout(holdTimer);
          if (!start.mouse && dragNode >= 0) {
            holdTimer = setTimeout(() => {
              if (mode === 'maybe') { mode = 'node'; begin(false); navigator.vibrate && navigator.vibrate(12); this.select(dragNode); }
            }, 380);
          }
        } else if (pts.size === 2) {
          const [a, b] = [...pts.values()];
          pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: this.scale, tx: this.tx, ty: this.ty,
                    mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 };
          mode = 'pinch'; dragNode = -1; clearTimeout(holdTimer); begin();
        }
      };
      const move = (e) => {
        const p = local(e);
        if (!pts.has(e.pointerId)) {            // mouse hover
          if (e.pointerType === 'mouse' && this.hasLayout && !this.interacting) {
            const i = this.hit(p[0], p[1]);
            cv.style.cursor = i >= 0 ? 'pointer' : 'grab';
            this.onHover(i, e.clientX, e.clientY);
          }
          return;
        }
        pts.set(e.pointerId, p);
        if (mode === 'pinch' && pts.size >= 2) {
          const [a, b] = [...pts.values()];
          const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
          const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
          const ns = Math.max(0.005, Math.min(40, pinch.s * d / pinch.d));
          // keep the world point under the original midpoint under the fingers
          const wx = (pinch.mx - pinch.tx) / pinch.s, wy = (pinch.my - pinch.ty) / pinch.s;
          this.scale = ns; this.tx = mx - wx * ns; this.ty = my - wy * ns;
          this.draw();
          return;
        }
        if (mode === 'maybe' && Math.hypot(p[0] - start.x, p[1] - start.y) > 7) {
          clearTimeout(holdTimer);
          mode = dragNode >= 0 && start.mouse ? 'node' : 'pan';
          begin(mode === 'pan');
          this.onHover(-1);
        }
        if (mode === 'pan') {
          this.tx = start.tx + (p[0] - start.x); this.ty = start.ty + (p[1] - start.y);
          this.draw();
        } else if (mode === 'node') {
          this.x[dragNode] = (p[0] - this.tx) / this.scale;
          this.y[dragNode] = (p[1] - this.ty) / this.scale;
          this._lobeCentres = null;
          this.draw();
        }
      };
      const up = (e) => {
        if (!pts.has(e.pointerId)) return;
        pts.delete(e.pointerId);
        clearTimeout(holdTimer);
        if (mode === 'maybe' && performance.now() - start.t < 600) {
          const i = this.hasLayout ? this.hit(start.x, start.y) : -1;
          this.select(i);                        // tap: select (or clear)
        }
        if (pts.size === 0) { mode = null; end(); }
        else if (pts.size === 1 && mode === 'pinch') {   // one finger left: continue as pan
          const p = [...pts.values()][0];
          start = { x: p[0], y: p[1], t: 0, tx: this.tx, ty: this.ty };
          mode = 'pan';
        }
      };
      const wheel = (e) => {
        e.preventDefault();
        const [px, py] = local(e);
        const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
        const ns = Math.max(0.005, Math.min(40, this.scale * k));
        const wx = (px - this.tx) / this.scale, wy = (py - this.ty) / this.scale;
        this.scale = ns; this.tx = px - wx * ns; this.ty = py - wy * ns;
        begin(); this.draw(); end();
      };
      const dbl = (e) => {
        const [px, py] = local(e);
        const ns = Math.min(40, this.scale * 2);
        const wx = (px - this.tx) / this.scale, wy = (py - this.ty) / this.scale;
        this.animateTo(ns, px - wx * ns, py - wy * ns, 300);
      };
      const leave = () => this.onHover(-1);
      cv.addEventListener('pointerdown', down);
      cv.addEventListener('pointermove', move);
      cv.addEventListener('pointerup', up);
      cv.addEventListener('pointercancel', up);
      cv.addEventListener('pointerleave', leave);
      cv.addEventListener('wheel', wheel, { passive: false });
      cv.addEventListener('dblclick', dbl);
      this._unbind = () => {
        cv.removeEventListener('pointerdown', down); cv.removeEventListener('pointermove', move);
        cv.removeEventListener('pointerup', up); cv.removeEventListener('pointercancel', up);
        cv.removeEventListener('pointerleave', leave);
        cv.removeEventListener('wheel', wheel); cv.removeEventListener('dblclick', dbl);
      };
    }
  }

  BrainGraph.PALETTE = PALETTE;
  BrainGraph.hexToRgb = hexToRgb;
  window.BrainGraph = BrainGraph;
})();
