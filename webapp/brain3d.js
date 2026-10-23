/* MyBrain 3D view: the map as a glowing brain you can turn, zoom and tap.
 *
 * - one finger / left mouse: turn the brain   - two fingers / wheel: zoom
 * - two fingers drag / right mouse: move      - tap a neuron: select it
 * Same public methods as the 2D BrainGraph (graph.js), so app.js drives both.
 * Needs window.THREE (vendor/three-bundle.min.js), loaded only for this view.
 *
 * Layout: each lobe owns a direction on a sphere. Connected neurons fill a
 * dense core, the most connected deepest; barely connected ones sit on an
 * outer shell, so synapses between them draw the web around the core.
 */
(function () {
  'use strict';

  const PALETTE = window.BrainGraph.PALETTE;
  const SIGNAL = '#5eead4';
  const R = 100;                         // brain radius, world units
  const MAX_PULSES = 90;
  const MAX_AGENTS = 16;
  const MAX_MARKERS = 7;            // the biggest lobes, glowing around the brain

  const hex = (h) => new window.THREE.Color(h);

  // Small deterministic random numbers, so a map always grows the same brain.
  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  class Brain3D {
    constructor(canvas, map, opts = {}) {
      const T = window.THREE;
      this.canvas = canvas;
      this.map = map;
      this.onSelect = opts.onSelect || (() => {});
      this.onHover = opts.onHover || (() => {});
      this.theme = opts.theme || 'dark';
      this.labelBox = opts.labels || null;
      window.BrainGraph.initData(this, map);

      this.hiddenLobes = new Set();
      this.selected = -1;
      this.focus = null;
      this.path = null;
      this.bottomInset = 0;
      this.hasLayout = true;
      this.animate = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      this.pulses = [];
      this.agents = [];                  // live sessions around the brain (step 3)
      this.small = Math.min(window.innerWidth, window.innerHeight) < 600;
      // A phone draws far less: no glow pass, pixel ratio 1, fewer lines, and fewer
      // still while a finger is moving it. Measured on GNARL (14k neurons): the glow
      // doubled the frame time and the synapse lines were three quarters of the rest.
      this.phone = this.small || Boolean(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

      this._layout();

      // ---- renderer, scene, camera
      const renderer = this.renderer = new T.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
      // The backdrop is the scene's background, not the clear colour: through the
      // glow pipeline the clear colour is converted to sRGB twice and comes out a
      // visible grey-blue (#22263d for #04050c), measured.
      renderer.setClearColor(0x000000, 1);
      this.scene = new T.Scene();
      this.scene.background = new T.Color(0x04050c);
      this.scene.fog = new T.FogExp2(0x04050c, 0.0016);
      this.camera = new T.PerspectiveCamera(50, 1, 0.5, 4000);
      this.camera.position.set(R * 1.1, R * 0.9, R * 2.2);
      const controls = this.controls = new T.OrbitControls(this.camera, canvas);
      controls.enableDamping = true;
      // A slow glide after the finger lifts reads as lag on a phone: the brain
      // trails the finger. There it follows closely and stops quickly.
      controls.dampingFactor = this.phone ? 0.3 : 0.08;
      controls.rotateSpeed = this.phone ? 0.85 : 0.6;
      controls.zoomSpeed = 0.9;
      controls.minDistance = 4;
      controls.maxDistance = R * 8;
      controls.autoRotate = this.animate;
      controls.autoRotateSpeed = 0.5;
      controls.addEventListener('start', () => { this._userMoving = true; controls.autoRotate = false; this._idleAt = 0; });
      controls.addEventListener('end', () => { this._userMoving = false; this._idleAt = performance.now(); });
      controls.addEventListener('change', () => { if (!controls.autoRotate) this._lastChange = performance.now(); this.draw(); });

      this._buildNodes();
      this._buildEdges();
      this._buildShell();
      this._buildPulses();
      this._buildAgents();
      this._buildMarkers();

      // ---- glow: a bloom pass at reduced resolution (its output is soft anyway)
      this.composer = new T.EffectComposer(renderer);
      this.composer.addPass(new T.RenderPass(this.scene, this.camera));
      this.bloom = new T.UnrealBloomPass(new T.Vector2(256, 256), this.small ? 0.7 : 0.8, 0.3, this.n > 5000 ? 0.62 : 0.42);
      // keep the glow close to what glows: the widest blur levels leave faint light
      // everywhere, and the sRGB output curve turns faint into a visible grey haze
      this.bloom.compositeMaterial.uniforms.bloomFactors.value = [1.0, 0.6, 0.18, 0, 0];
      this.composer.addPass(this.bloom);
      this.composer.addPass(new T.OutputPass());
      this.useBloom = !this.phone;
      try { this.keepBloom = localStorage.getItem('mybrain-bloom') === 'on'; } catch (e) { this.keepBloom = false; }

      this._frame = (t) => this._tick(t);
      this._vis = () => { if (!document.hidden) this.draw(); };
      document.addEventListener('visibilitychange', this._vis);
      this._resize = this.resize.bind(this);
      window.addEventListener('resize', this._resize);
      this._bindInput();
      this.resize();
      this.fit(false);
    }

    destroy() {
      this._destroyed = true;
      document.removeEventListener('visibilitychange', this._vis);
      window.removeEventListener('resize', this._resize);
      this._unbind && this._unbind();
      this.controls.dispose();
      this.scene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      this.composer.dispose && this.composer.dispose();
      this.renderer.dispose();
      if (this.labelBox) this.labelBox.innerHTML = '';
      this._lbl = null;
    }

    // ---------------------------------------------------------------- layout --
    _layout() {
      const n = this.n, rand = rng(n * 2654435761 + this.E);
      // lobes, biggest first, spread over a sphere (Fibonacci points)
      const sizes = new Map();
      for (let i = 0; i < n; i++) sizes.set(this.lobe[i], (sizes.get(this.lobe[i]) || 0) + 1);
      const bySize = [...sizes.keys()].sort((a, b) => sizes.get(b) - sizes.get(a));
      // Interleave by the golden ratio, so lobes of similar size (above all the
      // biggest, which carry the markers) land far apart instead of round one pole.
      const order = bySize.map((c, k) => [c, (k * 0.6180339887498949 + 0.5) % 1]).sort((a, b) => a[1] - b[1]).map(x => x[0]);
      const dir = new Map(), K = order.length, golden = Math.PI * (3 - Math.sqrt(5));
      order.forEach((c, k) => {
        const y = 1 - 2 * (k + 0.5) / K, r = Math.sqrt(1 - y * y), th = golden * k;
        dir.set(c, [Math.cos(th) * r, y, Math.sin(th) * r]);
      });
      this._lobeDir = dir;
      // how spread a lobe is: big lobes take a wider patch
      const spread = (c) => Math.min(0.9, 0.25 + 0.6 * Math.sqrt(sizes.get(c) / n));

      // rank by degree: 0 = most connected
      const rank = new Float32Array(n);
      this.byDeg.forEach((i, k) => { rank[i] = k / Math.max(1, n - 1); });

      const P = this.pos = new Float32Array(3 * n);
      this.shell = new Uint8Array(n);
      const gauss = () => { let u = 0; for (let k = 0; k < 3; k++) u += rand(); return (u - 1.5) / 0.5; };
      for (let i = 0; i < n; i++) {
        const d = dir.get(this.lobe[i]), sp = spread(this.lobe[i]);
        let x = d[0] + gauss() * sp, y = d[1] + gauss() * sp, z = d[2] + gauss() * sp;
        const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
        let r;
        if (this.deg[i] <= 1) { this.shell[i] = 1; r = R * (0.95 + 0.1 * rand()); }
        // the core fills a ball (cube root = even density); busy neurons sit a little deeper
        else r = R * 0.56 * Math.cbrt(rand()) * (0.6 + 0.4 * Math.sqrt(rank[i]));
        P[3 * i] = x * r; P[3 * i + 1] = y * r; P[3 * i + 2] = z * r;
      }
      // pull connected core neurons toward their neighbours, so synapses stay short
      const tmp = new Float32Array(3 * n);
      for (let pass = 0; pass < 3; pass++) {
        for (let i = 0; i < n; i++) {
          const a = this.adjStart[i], b = this.adjStart[i + 1];
          if (this.shell[i] || b === a) { tmp[3 * i] = P[3 * i]; tmp[3 * i + 1] = P[3 * i + 1]; tmp[3 * i + 2] = P[3 * i + 2]; continue; }
          let sx = 0, sy = 0, sz = 0, m = 0;
          const lim = Math.min(b, a + 40);
          for (let k = a; k < lim; k++) {
            const e = this.adj[k], j = this.es[e] === i ? this.et[e] : this.es[e];
            if (this.shell[j]) continue;
            sx += P[3 * j]; sy += P[3 * j + 1]; sz += P[3 * j + 2]; m++;
          }
          const w = m ? 0.35 : 0;
          tmp[3 * i] = P[3 * i] * (1 - w) + (m ? sx / m : 0) * w;
          tmp[3 * i + 1] = P[3 * i + 1] * (1 - w) + (m ? sy / m : 0) * w;
          tmp[3 * i + 2] = P[3 * i + 2] * (1 - w) + (m ? sz / m : 0) * w;
        }
        // keep each neuron's distance from the centre: smoothing turns, it doesn't shrink
        for (let i = 0; i < n; i++) {
          if (this.shell[i]) continue;
          const r0 = Math.hypot(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
          const r1 = Math.hypot(tmp[3 * i], tmp[3 * i + 1], tmp[3 * i + 2]) || 1;
          const k = r0 / r1;
          tmp[3 * i] *= k; tmp[3 * i + 1] *= k; tmp[3 * i + 2] *= k;
        }
        P.set(tmp);
      }
      // a brain is wider than it is tall
      for (let i = 0; i < n; i++) { P[3 * i] *= 1.18; P[3 * i + 1] *= 0.86; }
    }

    // ---------------------------------------------------------------- scene --
    _buildNodes() {
      const T = window.THREE, n = this.n;
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(this.pos, 3));
      const col = new Float32Array(3 * n), size = new Float32Array(n);
      this.alpha = new Float32Array(n).fill(1);
      const pal = PALETTE.map(h => hex(h));
      const cyan = hex(SIGNAL);
      const crowd = Math.min(1, Math.max(0.65, Math.pow(2000 / n, 0.25)));   // smaller dots on big maps
      for (let i = 0; i < n; i++) {
        // neon: the lobe's colour mixed toward the signal cyan, brighter for busy neurons
        const c = pal[this.col[i]].clone().lerp(cyan, this.shell[i] ? 0.6 : 0.5);
        col[3 * i] = c.r; col[3 * i + 1] = c.g; col[3 * i + 2] = c.b;
        size[i] = ((this.shell[i] ? 2.4 : 3.2) + 1.5 * Math.sqrt(this.deg[i])) * crowd;
      }
      g.setAttribute('color', new T.BufferAttribute(col, 3));
      g.setAttribute('size', new T.BufferAttribute(size, 1));
      g.setAttribute('alpha', new T.BufferAttribute(this.alpha, 1));
      g.setIndex(new T.BufferAttribute(Uint32Array.from(this.byDeg), 1));   // busiest first: any prefix is the best subset
      this.nodeGeom = g;
      this.nodeMat = new T.ShaderMaterial({
        uniforms: { uScale: { value: 300 }, uMaxSize: { value: this.phone ? 24 : 64 }, uDensity: { value: Math.min(1, Math.max(0.18, Math.sqrt(1200 / n))) } },
        vertexShader: `
          attribute float size; attribute float alpha; attribute vec3 color;
          uniform float uScale; uniform float uMaxSize; uniform float uDensity; varying vec3 vC; varying float vA;
          void main() {
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = clamp(size * uScale / -mv.z, 1.5, uMaxSize);
            gl_Position = projectionMatrix * mv;
            // alpha 2 = in focus: full strength; otherwise dimmed by how crowded the map is
            vC = color; vA = alpha > 1.5 ? 1.0 : alpha * uDensity;
          }`,
        fragmentShader: `
          varying vec3 vC; varying float vA;
          void main() {
            float d = length(gl_PointCoord - 0.5);
            if (d > 0.5 || vA < 0.01) discard;
            float core = smoothstep(0.22, 0.0, d), halo = smoothstep(0.5, 0.05, d);
            gl_FragColor = vec4(vC * (0.45 + 1.3 * core) + core * 0.25, (halo * 0.3 + core * 0.85) * vA);
          }`,
        transparent: true, depthWrite: false, blending: T.AdditiveBlending,
      });
      this.nodes = new T.Points(g, this.nodeMat);
      this.scene.add(this.nodes);
    }

    _buildEdges() {
      const T = window.THREE;
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(this.pos, 3));
      const pal = PALETTE.map(h => hex(h)), teal = hex('#2dd4bf');
      const col = new Float32Array(3 * this.n);
      for (let i = 0; i < this.n; i++) {
        const c = pal[this.col[i]].clone().lerp(teal, 0.7);
        col[3 * i] = c.r; col[3 * i + 1] = c.g; col[3 * i + 2] = c.b;
      }
      g.setAttribute('color', new T.BufferAttribute(col, 3));
      this.edgeGeom = g;
      // a phone draws the most important synapses only
      this.edgeCap = this.phone ? 7000 : 160000;
      this.moveCap = this.phone ? 2500 : 40000;   // synapses drawn while the brain is moving
      // Phone quality while a finger moves it. The level steps down by itself when
      // this phone's frames come out slow, and is remembered on the device.
      this.levels = [
        { ratio: 0.7, nodes: 6000, edges: 2500, membrane: 1 / 3 },
        { ratio: 0.55, nodes: 3000, edges: 1200, membrane: 1 / 6 },
        { ratio: 0.45, nodes: 1500, edges: 500, membrane: 0 },
      ];
      let lv = 0;
      try { lv = Math.min(2, Math.max(0, Number(localStorage.getItem('mybrain-3d-level')) || 0)); } catch (e) { /* private mode */ }
      this.level = this.phone ? lv : 0;
      this._gaps = [];
      this.edgeOpacity = 0.22 * Math.min(1, Math.max(0.2, Math.sqrt(2500 / Math.max(1, this.E))));
      this.edgeMat = new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: this.edgeOpacity,
        depthWrite: false, blending: T.AdditiveBlending });
      this.edges = new T.LineSegments(g, this.edgeMat);
      this.scene.add(this.edges);
      // bright lines for a selection or a path
      this.hiGeom = new T.BufferGeometry();
      this.hiGeom.setAttribute('position', new T.BufferAttribute(this.pos, 3));
      this.hiMat = new T.LineBasicMaterial({ color: hex(SIGNAL), transparent: true, opacity: 0.95,
        depthWrite: false, blending: T.AdditiveBlending });
      this.hiLines = new T.LineSegments(this.hiGeom, this.hiMat);
      this.scene.add(this.hiLines);
      this._setHi([]);   // without an index it would draw every neuron as a bright line
      this._edgeIndex();
    }

    _edgeIndex() {
      const hid = this.hiddenLobes, L = this.lobe;
      let ids = [];
      // On a big map, the synapses of barely connected outer neurons all run into
      // the few hubs and burn the core white; there the membrane draws the shell
      // and those synapses show when a neuron is selected.
      const busy = this.E > 60000;
      for (let e = 0; e < this.E; e++) {
        if (hid.size && (hid.has(L[this.es[e]]) || hid.has(L[this.et[e]]))) continue;
        if (busy && (this.shell[this.es[e]] || this.shell[this.et[e]])) continue;
        ids.push(e);
      }
      if (ids.length > this.moveCap) {          // most important first, so any prefix is a good subset
        const w = (e) => this.deg[this.es[e]] + this.deg[this.et[e]];
        ids.sort((a, b) => w(b) - w(a));
        ids = ids.slice(0, this.edgeCap);
      }
      const idx = new Uint32Array(2 * ids.length);
      ids.forEach((e, k) => { idx[2 * k] = this.es[e]; idx[2 * k + 1] = this.et[e]; });
      this.edgeGeom.setIndex(new window.THREE.BufferAttribute(idx, 1));
      this.shownEdges = ids.length;
    }

    _buildShell() {
      // The membrane: each outer neuron is joined to its nearest outer
      // neighbours, which draws the web around the core. Decoration only,
      // these lines are not synapses.
      const T = window.THREE, P = this.pos, cell = R * 0.16, grid = new Map();
      const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
      const shell = [];
      for (let i = 0; i < this.n; i++) if (this.shell[i]) shell.push(i);
      const step = Math.max(1, Math.floor(shell.length / (this.phone ? 2500 : 14000)));
      const pts = shell.filter((_, k) => k % step === 0);
      for (const i of pts) {
        const k = key(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
      const pairs = [];
      for (const i of pts) {
        const cx = Math.floor(P[3 * i] / cell), cy = Math.floor(P[3 * i + 1] / cell), cz = Math.floor(P[3 * i + 2] / cell);
        const near = [];
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          const list = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!list) continue;
          for (const j of list) {
            if (j <= i) continue;
            const d = (P[3 * i] - P[3 * j]) ** 2 + (P[3 * i + 1] - P[3 * j + 1]) ** 2 + (P[3 * i + 2] - P[3 * j + 2]) ** 2;
            near.push([d, j]);
          }
        }
        near.sort((a, b) => a[0] - b[0]);
        for (const [, j] of near.slice(0, 3)) pairs.push(i, j);
      }
      const mg = new T.BufferGeometry();
      mg.setAttribute('position', new T.BufferAttribute(P, 3));
      mg.setIndex(new T.BufferAttribute(Uint32Array.from(pairs), 1));
      this.membrane = new T.LineSegments(mg, new T.LineBasicMaterial({ color: 0x2dd4bf, transparent: true,
        opacity: this.membraneOpacity = 0.26 * Math.min(1, Math.max(0.45, Math.sqrt(2500 / Math.max(1, pts.length)))),
        depthWrite: false, blending: T.AdditiveBlending }));
      this.scene.add(this.membrane);

      // and a faint wireframe skull around everything
      const geo = new T.IcosahedronGeometry(R * 1.12, 3);
      geo.scale(1.18, 0.86, 1);
      const wire = new T.WireframeGeometry(geo);
      this.shellMesh = new T.LineSegments(wire, new T.LineBasicMaterial({ color: 0x1e6f78, transparent: true,
        opacity: 0.07, depthWrite: false, blending: T.AdditiveBlending }));
      this.scene.add(this.shellMesh);
    }

    _buildPulses() {
      const T = window.THREE;
      this.pulsePos = new Float32Array(3 * MAX_PULSES);
      this.pulseSize = new Float32Array(MAX_PULSES);
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(this.pulsePos, 3));
      g.setAttribute('size', new T.BufferAttribute(this.pulseSize, 1));
      this.pulseGeom = g;
      this.pulseMat = new T.ShaderMaterial({
        uniforms: { uScale: { value: 300 }, uColor: { value: hex('#d9fffa') } },
        vertexShader: `
          attribute float size; uniform float uScale;
          void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = clamp(size * uScale / -mv.z, 0.0, 22.0); gl_Position = projectionMatrix * mv; }`,
        fragmentShader: `
          uniform vec3 uColor;
          void main() { float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
            float a = smoothstep(0.5, 0.0, d); gl_FragColor = vec4(uColor * (0.6 + a), a); }`,
        transparent: true, depthWrite: false, blending: T.AdditiveBlending,
      });
      this.scene.add(new T.Points(g, this.pulseMat));
    }

    _buildAgents() {
      // coloured dots around the brain, one per live session; beams fire from
      // them into the neurons they read or change (setAgents / fire)
      const T = window.THREE;
      this.agentGroup = new T.Group();
      this.scene.add(this.agentGroup);
      this.beams = [];
      this.beamPos = new Float32Array(6 * 64);
      this.beamCol = new Float32Array(6 * 64);
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(this.beamPos, 3));
      g.setAttribute('color', new T.BufferAttribute(this.beamCol, 3));
      g.setDrawRange(0, 0);
      this.beamGeom = g;
      this.scene.add(new T.LineSegments(g, new T.LineBasicMaterial({ vertexColors: true, transparent: true,
        opacity: 1, depthWrite: false, blending: T.AdditiveBlending })));
      // glowing dots: the sessions themselves, and the head of each beam
      const SPR = MAX_AGENTS + MAX_MARKERS + 64;
      this.sprPos = new Float32Array(3 * SPR); this.sprCol = new Float32Array(3 * SPR); this.sprSize = new Float32Array(SPR);
      const sg = new T.BufferGeometry();
      sg.setAttribute('position', new T.BufferAttribute(this.sprPos, 3));
      sg.setAttribute('color', new T.BufferAttribute(this.sprCol, 3));
      sg.setAttribute('size', new T.BufferAttribute(this.sprSize, 1));
      this.sprGeom = sg;
      this.sprMat = new T.ShaderMaterial({
        uniforms: { uScale: { value: 300 } },
        vertexShader: `
          attribute float size; attribute vec3 color; uniform float uScale; varying vec3 vC;
          void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = clamp(size * uScale / -mv.z, 0.0, 40.0); gl_Position = projectionMatrix * mv; vC = color; }`,
        fragmentShader: `
          varying vec3 vC;
          void main() { float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
            float core = smoothstep(0.2, 0.0, d), halo = smoothstep(0.5, 0.0, d);
            gl_FragColor = vec4(vC * (0.7 + 1.5 * core) + core * 0.4, halo * 0.8 + core); }`,
        transparent: true, depthWrite: false, blending: T.AdditiveBlending,
      });
      this.scene.add(new T.Points(sg, this.sprMat));
    }

    // The important points: the biggest lobes, each a glowing labelled dot outside
    // the shell in its own direction, firing now and then into its neurons.
    _buildMarkers() {
      const T = window.THREE, members = new Map();
      for (let i = 0; i < this.n; i++) {
        const c = this.lobe[i];
        if (!members.has(c)) members.set(c, []);
        members.get(c).push(i);
      }
      const big = [...members.entries()].filter(([c]) => this.lobeName.has(c))
        .sort((a, b) => b[1].length - a[1].length).slice(0, Math.min(MAX_MARKERS, this.phone ? 6 : MAX_MARKERS));
      this.markers = big.map(([c, ids]) => {
        const d = this._lobeDir.get(c) || [1, 0, 0];
        const color = PALETTE[this.lobeColor.get(c) ?? 9];
        return { id: 'lobe:' + c, lobe: c, name: this.lobeName.get(c) || `Lobe ${c}`, color, c: hex(color).lerp(hex('#ffffff'), 0.15),
          p: new T.Vector3(d[0] * R * 1.3, d[1] * R * 1.05, d[2] * R * 1.3),
          ids: ids.sort((a, b) => this.deg[b] - this.deg[a]).slice(0, 60) };
      });
    }

    _markerBeams(now) {
      if (!this.animate || !this.markers.length || now - (this._lastMarkerBeam || 0) < (this.phone ? 1100 : 750)) return;
      this._lastMarkerBeam = now;
      const vis = this.markers.filter(m => !this.hiddenLobes.has(m.lobe));
      if (!vis.length) return;
      const m = vis[Math.floor(Math.random() * vis.length)];
      const node = m.ids[Math.floor(Math.pow(Math.random(), 2) * m.ids.length)];
      this.beams.push({ a: m, node, kind: 'read', born: now, dur: 1600, ambient: true });
      if (this.beams.length > 64) this.beams.shift();
    }

    // ------------------------------------------------------------ public API --
    setPositions() { /* the 3D view grows its own layout */ }

    setHiddenLobes(set) {
      this.hiddenLobes = set;
      this._refreshAlpha();
      this._edgeIndex();
      this.draw();
    }

    setAnimate(on) {
      this.animate = on;
      this.controls.autoRotate = on && this.selected < 0 && !this.path;
      this.pulses = [];
      this.draw();
    }

    draw() { this._dirty = true; this._kick(); }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.W = Math.max(1, r.width); this.H = Math.max(1, r.height);
      const cap = this.phone ? 1 : this.n > 20000 ? 1.25 : 1.5;
      this.dpr = Math.min(window.devicePixelRatio || 1, cap);
      this.renderer.setPixelRatio(this.dpr); this._ratio = this.dpr;
      this.renderer.setSize(this.W, this.H, false);
      this.composer.setPixelRatio(this.dpr);
      this.composer.setSize(this.W, this.H);
      this.bloom.resolution.set(this.W / 2, this.H / 2);
      this.camera.aspect = this.W / this.H;
      this._applyInset();
      const s = this.H * this.dpr * 0.5;
      this.nodeMat.uniforms.uScale.value = s;
      this.pulseMat.uniforms.uScale.value = s;
      this.sprMat.uniforms.uScale.value = s;
      this.draw();
    }

    // A bottom sheet (phone) or side panel (desktop) covers part of the canvas:
    // shift the picture so the brain stays centred in the part you can see.
    _applyInset() {
      const b = this.bottomInset || 0, r = this.rightInset || 0;
      if (b > 0 || r > 0) this.camera.setViewOffset(this.W, this.H, r / 2, b / 2, this.W, this.H);
      else this.camera.clearViewOffset();
      this.camera.updateProjectionMatrix();
      this._inset = b + ':' + r;
    }

    _centerOf(ids) {
      const P = this.pos;
      let x = 0, y = 0, z = 0, m = 0;
      const each = (i) => { if (this.hiddenLobes.has(this.lobe[i])) return; x += P[3 * i]; y += P[3 * i + 1]; z += P[3 * i + 2]; m++; };
      if (ids) ids.forEach(each); else for (let i = 0; i < this.n; i++) each(i);
      if (!m) return { c: [0, 0, 0], r: R };
      x /= m; y /= m; z /= m;
      let r2 = 0;
      const far = (i) => { if (this.hiddenLobes.has(this.lobe[i])) return; const d = (P[3 * i] - x) ** 2 + (P[3 * i + 1] - y) ** 2 + (P[3 * i + 2] - z) ** 2; if (d > r2) r2 = d; };
      if (ids) ids.forEach(far); else r2 = (R * (this.markers && this.markers.length ? 1.32 : 1.2)) ** 2;
      return { c: [x, y, z], r: Math.max(Math.sqrt(r2), 6) };
    }

    fit(animate = true, ids = null) {
      const { c, r } = this._centerOf(ids);
      const fov = this.camera.fov * Math.PI / 180;
      const fitH = r / Math.sin(fov / 2), fitW = fitH / Math.min(1, this.camera.aspect);
      const dist = Math.max(fitH, fitW) * (ids ? 1.25 : 1.02);
      this._flyTo(c, dist, animate ? 650 : 0);
    }

    _flyTo(target, dist, ms) {
      const T = window.THREE, cam = this.camera, ctl = this.controls;
      const t1 = new T.Vector3(...target);
      const dirv = cam.position.clone().sub(ctl.target).normalize();
      const p1 = t1.clone().add(dirv.multiplyScalar(dist));
      if (!ms) { ctl.target.copy(t1); cam.position.copy(p1); ctl.update(); this.draw(); return; }
      const t0 = ctl.target.clone(), p0 = cam.position.clone(), s = performance.now();
      this._fly = (now) => {
        const k = Math.min(1, (now - s) / ms), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        ctl.target.lerpVectors(t0, t1, e);
        cam.position.lerpVectors(p0, p1, e);
        if (k >= 1) this._fly = null;
      };
      this.draw();
    }

    centreOn(i) {
      const P = this.pos;
      const d = Math.min(this.camera.position.distanceTo(this.controls.target), R * 0.9);
      this._flyTo([P[3 * i], P[3 * i + 1], P[3 * i + 2]], Math.max(d, 28), 650);
    }

    select(i, opts = {}) {
      this.selected = i;
      this.path = null;
      this.pulses = [];
      if (i < 0) {
        this.focus = null;
        this._refreshAlpha(); this._setHi([]);
        this.controls.autoRotate = this.animate;
        this.draw(); this.onSelect(-1); return;
      }
      const f = new Set([i]), hi = [];
      for (let k = this.adjStart[i]; k < this.adjStart[i + 1]; k++) {
        const e = this.adj[k]; f.add(this.es[e] === i ? this.et[e] : this.es[e]); hi.push(e);
      }
      this.focus = f;
      this.controls.autoRotate = false;
      this._refreshAlpha(); this._setHi(hi);
      if (opts.centre) this.centreOn(i);
      this.draw();
      this.onSelect(i);
    }

    findPath(a, b) { return window.BrainGraph.prototype.findPath.call(this, a, b); }
    connections(i) { return window.BrainGraph.prototype.connections.call(this, i); }

    setPath(p) {
      this.path = p;
      this.pulses = [];
      this.selected = -1;
      this.focus = p ? new Set(p.nodes) : null;
      this.controls.autoRotate = !p && this.animate;
      this._refreshAlpha();
      this._setHi(p ? p.edges : []);
      if (p) this.fit(true, p.nodes);
      this.draw();
    }

    _refreshAlpha() {
      const a = this.alpha, f = this.focus, hid = this.hiddenLobes;
      for (let i = 0; i < this.n; i++) {
        a[i] = hid.size && hid.has(this.lobe[i]) ? 0 : f ? (f.has(i) ? 2 : 0.08) : 1;
      }
      this.nodeGeom.attributes.alpha.needsUpdate = true;
      this.edgeMat.opacity = f ? 0.04 : this.edgeOpacity;
      this.shellMesh.material.opacity = f ? 0.03 : 0.07;
      this.membrane.material.opacity = f ? 0.03 : this.membraneOpacity;
    }

    _setHi(edgeIds) {
      const idx = new Uint32Array(2 * edgeIds.length);
      edgeIds.forEach((e, k) => { idx[2 * k] = this.es[e]; idx[2 * k + 1] = this.et[e]; });
      this.hiGeom.setIndex(new window.THREE.BufferAttribute(idx, 1));
    }

    // Live sessions (step 3): [{id, name, color}] placed on a ring around the brain.
    setAgents(list) {
      const T = window.THREE;
      // on a ring just outside the shell, so a phone's narrow view still shows them
      this.agents = list.slice(0, MAX_AGENTS).map((a, k, all) => {
        const th = (k / Math.max(1, all.length)) * Math.PI * 2 + 0.6;
        const p = new T.Vector3(Math.cos(th) * R * 1.32, R * (0.55 - 0.35 * (k % 2)), Math.sin(th) * R * 1.0);
        return { ...a, p, c: hex(a.color) };
      });
      this.draw();
    }

    // A beam from a session into a neuron: kind is read / write / search.
    fire(agentId, node, kind) {
      const a = this.agents.find(x => x.id === agentId);
      if (!a || node < 0 || node >= this.n) return;
      this.beams.push({ a, node, kind, born: performance.now(), dur: kind === 'write' ? 2600 : 1800 });
      if (this.beams.length > 64) this.beams.shift();
      this.draw();
    }

    // -------------------------------------------------------------- picking --
    _project() {
      const cam = this.camera;
      cam.updateMatrixWorld();
      const m = new window.THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
      return m;
    }

    pick(cx, cy, radius) {
      const rect = this.canvas.getBoundingClientRect();
      const x = cx - rect.left, y = cy - rect.top;
      const m = this._project(), P = this.pos, W = this.W, H = this.H;
      let best = -1, bestScore = Infinity;
      for (let i = 0; i < this.n; i++) {
        if (this.alpha[i] < 0.05) continue;
        const px = P[3 * i], py = P[3 * i + 1], pz = P[3 * i + 2];
        const w = m[3] * px + m[7] * py + m[11] * pz + m[15];
        if (w <= 0.1) continue;
        const sx = ((m[0] * px + m[4] * py + m[8] * pz + m[12]) / w * 0.5 + 0.5) * W;
        const sy = (1 - ((m[1] * px + m[5] * py + m[9] * pz + m[13]) / w * 0.5 + 0.5)) * H;
        const d = Math.hypot(sx - x, sy - y);
        if (d > radius) continue;
        const score = d + w * 0.02 - Math.sqrt(this.deg[i]) * 0.6;   // prefer near, front, busy
        if (score < bestScore) { bestScore = score; best = i; }
      }
      return best;
    }

    screenOf(i) {
      const m = this._project(), P = this.pos;
      const px = P[3 * i], py = P[3 * i + 1], pz = P[3 * i + 2];
      const w = m[3] * px + m[7] * py + m[11] * pz + m[15];
      if (w <= 0.1) return null;
      return [((m[0] * px + m[4] * py + m[8] * pz + m[12]) / w * 0.5 + 0.5) * this.W,
              (1 - ((m[1] * px + m[5] * py + m[9] * pz + m[13]) / w * 0.5 + 0.5)) * this.H, w];
    }

    _bindInput() {
      const c = this.canvas;
      let down = null, hoverT = 0;
      const pd = (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now(), touch: e.pointerType === 'touch' }; };
      const pu = (e) => {
        if (!down) return;
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = performance.now() - down.t;
        const touch = down.touch; down = null;
        if (moved > 8 || dt > 600) return;
        const rect = c.getBoundingClientRect();
        for (const m of this.markers) {
          const sm = this._screenOfVec(m.p);
          if (sm && Math.hypot(sm[0] - (e.clientX - rect.left), sm[1] - (e.clientY - rect.top)) < (touch ? 26 : 14)) {
            this.select(-1); this.controls.autoRotate = false; this.fit(true, m.ids); return;
          }
        }
        const i = this.pick(e.clientX, e.clientY, touch ? 22 : 12);
        this.select(i);
      };
      const pm = (e) => {
        if (e.pointerType !== 'mouse' || down) return;
        const now = performance.now();
        if (now - hoverT < 60) return;
        hoverT = now;
        const i = this.pick(e.clientX, e.clientY, 10);
        c.style.cursor = i >= 0 ? 'pointer' : 'grab';
        this.onHover(i, e.clientX, e.clientY);
      };
      const pl = () => this.onHover(-1);
      c.addEventListener('pointerdown', pd);
      c.addEventListener('pointerup', pu);
      c.addEventListener('pointermove', pm);
      c.addEventListener('pointerleave', pl);
      this._unbind = () => {
        c.removeEventListener('pointerdown', pd); c.removeEventListener('pointerup', pu);
        c.removeEventListener('pointermove', pm); c.removeEventListener('pointerleave', pl);
      };
    }

    // ---------------------------------------------------------------- frame --
    _kick() {
      if (this._loopOn || this._destroyed) return;
      this._loopOn = true;
      requestAnimationFrame(this._frame);
    }

    _tick(now) {
      this._loopOn = false;
      if (this._destroyed || document.hidden) return;
      const dt = Math.min(0.1, (now - (this._last || now)) / 1000);
      this._last = now;
      if (`${this.bottomInset || 0}:${this.rightInset || 0}` !== this._inset) this._applyInset();
      if (this._fly) this._fly(now);
      // resume turning a while after the last touch, when nothing is selected
      if (this.animate && !this.controls.autoRotate && !this._userMoving && this._idleAt &&
          this.selected < 0 && !this.path && now - this._idleAt > 9000) this.controls.autoRotate = true;
      this.controls.update(dt);
      const live = this.animate || this._fly || this._userMoving || this.beams.length || this.agents.length || this.controls.autoRotate;
      if (this.animate && !(this.phone && this._wasMoving)) this._stepPulses(now, dt);
      if (!(this.phone && this._wasMoving)) this._markerBeams(now);
      this._stepBeams(now);
      // still moving for a moment after the finger lifts, while the turn settles
      const moving = Boolean(this._userMoving || this._fly || now - (this._lastChange || 0) < 140);
      if (moving !== this._wasMoving) {
        this._wasMoving = moving; this._prevMoveFrame = 0; this._gaps = [];
        this._applyQuality(moving); if (!moving) this._dirty = true;
      }
      if (moving && this.phone) this._govern(now);
      // a phone turning on its own needs no more than 30 frames a second
      const throttle = this.phone && !moving && !this._dirty && now - (this._lastDraw || 0) < 32;
      if ((this._dirty || live) && !throttle) {
        this._lastDraw = now;
        this._dirty = false;
        const t0 = performance.now();
        if (this.useBloom) this.composer.render(); else this.renderer.render(this.scene, this.camera);
        this._watchSpeed(performance.now() - t0, now);
        this._labels(now);
      }
      if (live) { this._loopOn = true; requestAnimationFrame(this._frame); }
    }

    _applyQuality(moving) {
      const q = this.levels[this.level], ph = this.phone && moving;
      const ne = this.edgeGeom.index ? this.edgeGeom.index.count : 0;
      this.edgeGeom.setDrawRange(0, moving ? Math.min(ne, 2 * (ph ? q.edges : this.moveCap)) : Infinity);
      this.nodeGeom.setDrawRange(0, ph ? Math.min(this.n, q.nodes) : Infinity);
      const nm = this.membrane.geometry.index.count;
      this.membrane.geometry.setDrawRange(0, ph ? 2 * Math.floor(nm * q.membrane / 2) : Infinity);
      if (!this.phone) return;
      const ratio = ph ? Math.min(this.dpr, q.ratio) : this.dpr, k = this.H * ratio * 0.5;
      if (ratio !== this._ratio) {
        this._ratio = ratio;
        this.renderer.setPixelRatio(ratio);
        this.renderer.setSize(this.W, this.H, false);
      }
      this.nodeMat.uniforms.uScale.value = k; this.pulseMat.uniforms.uScale.value = k; this.sprMat.uniforms.uScale.value = k;
    }

    // Watch real frame times while a finger moves the brain: slower than ~30 fps
    // steps quality down a level (at most twice), and the phone remembers it.
    _govern(now) {
      if (this._prevMoveFrame) this._gaps.push(now - this._prevMoveFrame);
      this._prevMoveFrame = now;
      if (this._gaps.length < 24) return;
      const g = this._gaps.sort((a, b) => a - b), med = g[g.length >> 1];
      this._gaps = [];
      if (med > 34 && this.level < this.levels.length - 1) {
        this.level++;
        try { localStorage.setItem('mybrain-3d-level', String(this.level)); } catch (e) { /* private mode */ }
        this._applyQuality(true);
      }
      this.lastMoveFrameMs = med;
    }

    // If frames get slow (an older phone), drop the glow rather than stutter.
    _watchSpeed(ms, now) {
      this.lastFrameMs = ms;
      if (!this.useBloom || this.keepBloom) return;
      const gap = now - (this._prevNow || now);
      this._prevNow = now;
      this._slow = (this._slow || 0) * 0.95 + (gap > 45 ? 1 : 0) * 0.05;
      if (this._slow > 0.6) this.useBloom = false;
    }

    _stepPulses(now, dt) {
      const want = this.path ? 8 : this.selected >= 0 ? (this.phone ? 12 : 24) : (this.phone ? 20 : MAX_PULSES - 10);
      let budget = 4;
      while (this.pulses.length < want && budget-- > 0) {
        let e = -1, from = -1;
        if (this.path) {
          const k = Math.floor(Math.random() * this.path.edges.length);
          e = this.path.edges[k]; from = this.path.nodes[k];
          if (e === undefined) break;
        } else if (this.selected >= 0) {
          const i = this.selected, d = this.adjStart[i + 1] - this.adjStart[i];
          if (!d) break;
          e = this.adj[this.adjStart[i] + Math.floor(Math.random() * d)]; from = i;
        } else {
          e = Math.floor(Math.random() * this.E);
          const L = this.lobe;
          if (this.hiddenLobes.size && (this.hiddenLobes.has(L[this.es[e]]) || this.hiddenLobes.has(L[this.et[e]]))) continue;
          from = Math.random() < 0.5 ? this.es[e] : this.et[e];
        }
        if (e < 0) break;
        const to = this.es[e] === from ? this.et[e] : this.es[e];
        this.pulses.push({ a: from, b: to, t: 0, dur: 0.7 + Math.random() * 1.1 });
      }
      const P = this.pos, pp = this.pulsePos, ps = this.pulseSize;
      const keep = [];
      for (const p of this.pulses) { p.t += dt / p.dur; if (p.t < 1) keep.push(p); }
      this.pulses = keep;
      for (let k = 0; k < MAX_PULSES; k++) {
        const p = keep[k];
        if (!p) { ps[k] = 0; continue; }
        const e = p.t < 0.5 ? 2 * p.t * p.t : 1 - Math.pow(-2 * p.t + 2, 2) / 2;
        for (let d = 0; d < 3; d++) pp[3 * k + d] = P[3 * p.a + d] + (P[3 * p.b + d] - P[3 * p.a + d]) * e;
        ps[k] = 3.2 * Math.sin(Math.PI * p.t) + 0.8;
      }
      this.pulseGeom.attributes.position.needsUpdate = true;
      this.pulseGeom.attributes.size.needsUpdate = true;
    }

    _stepBeams(now) {
      const P = this.pos, bp = this.beamPos, bc = this.beamCol;
      this.beams = this.beams.filter(b => now - b.born < b.dur);
      this.beams.forEach((b, k) => {
        const age = (now - b.born) / b.dur, grow = Math.min(1, age * 3), fade = 1 - Math.max(0, age - 0.6) / 0.4;
        const tx = P[3 * b.node], ty = P[3 * b.node + 1], tz = P[3 * b.node + 2];
        bp[6 * k] = b.a.p.x; bp[6 * k + 1] = b.a.p.y; bp[6 * k + 2] = b.a.p.z;
        bp[6 * k + 3] = b.a.p.x + (tx - b.a.p.x) * grow; bp[6 * k + 4] = b.a.p.y + (ty - b.a.p.y) * grow; bp[6 * k + 5] = b.a.p.z + (tz - b.a.p.z) * grow;
        const c = b.a.c;
        for (let v = 0; v < 2; v++) { bc[6 * k + 3 * v] = c.r * fade; bc[6 * k + 3 * v + 1] = c.g * fade; bc[6 * k + 3 * v + 2] = c.b * fade; }
      });
      this.beamGeom.setDrawRange(0, 2 * this.beams.length);
      // dots: each session (breathing), then a bright head running down each beam
      const sp = this.sprPos, sc = this.sprCol, ss = this.sprSize;
      ss.fill(0);
      this.agents.forEach((a, k) => {
        sp.set([a.p.x, a.p.y, a.p.z], 3 * k); sc.set([a.c.r, a.c.g, a.c.b], 3 * k);
        ss[k] = 9 + 1.5 * Math.sin(now / 400 + k);
      });
      this.markers.forEach((m, k) => {
        const j = MAX_AGENTS + k;
        if (this.hiddenLobes.has(m.lobe)) return;
        sp.set([m.p.x, m.p.y, m.p.z], 3 * j); sc.set([m.c.r, m.c.g, m.c.b], 3 * j);
        ss[j] = 11 + 1.5 * Math.sin(now / 520 + k * 1.7);
      });
      this.beams.forEach((b, k) => {
        const age = (now - b.born) / b.dur, grow = Math.min(1, age * 3), j = MAX_AGENTS + MAX_MARKERS + k;
        const tx = P[3 * b.node], ty = P[3 * b.node + 1], tz = P[3 * b.node + 2];
        sp.set([b.a.p.x + (tx - b.a.p.x) * grow, b.a.p.y + (ty - b.a.p.y) * grow, b.a.p.z + (tz - b.a.p.z) * grow], 3 * j);
        sc.set([b.a.c.r, b.a.c.g, b.a.c.b], 3 * j);
        ss[j] = (b.kind === 'write' ? 9 : 6) * (1 - Math.max(0, age - 0.6) / 0.4);
      });
      this.sprGeom.attributes.position.needsUpdate = true;
      this.sprGeom.attributes.color.needsUpdate = true;
      this.sprGeom.attributes.size.needsUpdate = true;
      this.beamGeom.attributes.position.needsUpdate = true;
      this.beamGeom.attributes.color.needsUpdate = true;
    }

    // Names float beside the core neurons, the selection, the lobe markers and the
    // sessions. The label elements are kept and only moved: rewriting them every
    // frame made a phone stutter while a finger turned the brain.
    _labels(now = performance.now()) {
      const box = this.labelBox;
      if (!box) return;
      if (this.phone && this._wasMoving && now - (this._lastLabels || 0) < 90) return;
      this._lastLabels = now;
      this._lbl = this._lbl || new Map();
      const m = this._project();
      const proj = (x, y, z) => {
        const w = m[3] * x + m[7] * y + m[11] * z + m[15];
        if (w <= 0.1) return null;
        return [((m[0] * x + m[4] * y + m[8] * z + m[12]) / w * 0.5 + 0.5) * this.W,
                (1 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / w * 0.5 + 0.5)) * this.H];
      };
      const items = [];   // [key, text, x, y, cls, color]
      const P = this.pos;
      for (const a of this.agents) { const s = proj(a.p.x, a.p.y, a.p.z); if (s) items.push(['a:' + a.id, a.name, s[0], s[1] + 10, 'agent', a.color]); }
      for (const mk of this.markers) {
        if (this.hiddenLobes.has(mk.lobe)) continue;
        const s = proj(mk.p.x, mk.p.y, mk.p.z); if (s) items.push(['m:' + mk.lobe, mk.name, s[0], s[1] + 9, 'agent marker', mk.color]);
      }
      const want = [];
      if (this.selected >= 0) want.push(this.selected);
      if (this.path) want.push(this.path.nodes[0], this.path.nodes[this.path.nodes.length - 1]);
      if (this.focus && !this.path) want.push(...[...this.focus].sort((a, b) => this.deg[b] - this.deg[a]).slice(0, 8));
      for (const i of this.byDeg.slice(0, this.small ? 6 : 14)) if (!this.hiddenLobes.has(this.lobe[i])) want.push(i);
      const placed = [];
      const free = (x, y, w) => {
        for (const [px, py, pw] of placed) if (Math.abs(px - x) < (pw + w) / 2 + 6 && Math.abs(py - y) < 16) return false;
        placed.push([x, y, w]); return true;
      };
      // session and lobe names never sit on top of each other: nudge down until free
      for (const it of items) {
        const w = Math.min(it[1].length, 30) * 7.2;
        for (let k = 0; k < 4 && placed.some(([px, py, pw]) => Math.abs(px - it[2]) < (pw + w) / 2 + 4 && Math.abs(py - it[3]) < 14); k++) it[3] += 14;
        placed.push([it[2], it[3], w]);
      }
      const seen = new Set();
      for (const i of want) {
        if (seen.has(i)) continue; seen.add(i);
        const s = proj(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
        if (!s || s[0] < -50 || s[1] < -20 || s[0] > this.W + 50 || s[1] > this.H) continue;
        const label = this.map.nodes.label[i];
        if (i !== this.selected && !free(s[0], s[1], Math.min(label.length, 28) * 7)) continue;
        const cls = (this.focus && !this.focus.has(i) ? 'dim' : '') + (i === this.selected ? ' sel' : '');
        items.push(['n:' + i, label, s[0], s[1] - 8, cls, null]);
      }
      const keep = new Set();
      for (const [key, text, x, y, cls, color] of items) {
        keep.add(key);
        let el = this._lbl.get(key);
        if (!el) { el = document.createElement('span'); el.textContent = text; box.appendChild(el); this._lbl.set(key, el); }
        const c = 'lbl3d ' + cls;
        if (el.className !== c) el.className = c;
        if (color && el.style.color !== color) el.style.color = color;
        const half = Math.min(text.length, 30) * (cls.includes("agent") ? 4.6 : 3.6), cx = Math.max(half + 4, Math.min(this.W - half - 4, x));
        el.style.transform = `translate(${cx.toFixed(0)}px,${y.toFixed(0)}px)`;
      }
      for (const [key, el] of this._lbl) if (!keep.has(key)) { el.remove(); this._lbl.delete(key); }
    }

    _screenOfVec(v) {
      const m = this._project();
      const w = m[3] * v.x + m[7] * v.y + m[11] * v.z + m[15];
      if (w <= 0.1) return null;
      return [((m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12]) / w * 0.5 + 0.5) * this.W,
              (1 - ((m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13]) / w * 0.5 + 0.5)) * this.H];
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  Brain3D.supported = () => {
    try { const c = document.createElement('canvas'); return Boolean(c.getContext('webgl2') || c.getContext('webgl')); }
    catch (e) { return false; }
  };
  window.Brain3D = Brain3D;
})();
