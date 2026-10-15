/* MyBrain layout worker: lets the network "float and settle" off the main
 * thread, so the page never freezes, even with tens of thousands of neurons.
 *
 * Two stages:
 *  1. lay out the lobes (clusters) as big circles, so each lobe gets its own area;
 *  2. drop every neuron near its lobe's centre and run a force simulation
 *     (repulsion + synapse springs + a pull towards the lobe centre).
 * Positions are posted back every few ticks so the page can animate them.
 */
importScripts('vendor/d3-force-bundle.min.js');

self.onmessage = (ev) => {
  const { n, edges, lobe, ticks } = ev.data;   // edges: Int32Array [s,t,s,t...]
  const E = edges.length / 2;

  // ---- stage 1: lobe layout -------------------------------------------------
  const lobeIndex = new Map();
  const lobeSize = [];
  const lobeOf = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let k = lobeIndex.get(lobe[i]);
    if (k === undefined) { k = lobeSize.length; lobeIndex.set(lobe[i], k); lobeSize.push(0); }
    lobeOf[i] = k; lobeSize[k]++;
  }
  const L = lobeSize.length;
  const spacing = 7;                                // world units per neuron "slot"
  const lobeR = lobeSize.map(s => Math.sqrt(s) * spacing + 10);
  const lobeNodes = lobeSize.map((s, k) => ({ k, r: lobeR[k] }));
  const pair = new Map();
  for (let e = 0; e < E; e++) {
    const a = lobeOf[edges[2 * e]], b = lobeOf[edges[2 * e + 1]];
    if (a === b) continue;
    const key = a < b ? a * L + b : b * L + a;
    pair.set(key, (pair.get(key) || 0) + 1);
  }
  const lobeLinks = [];
  for (const [key, w] of pair) lobeLinks.push({ source: Math.floor(key / L), target: key % L, w });

  const meta = d3.forceSimulation(lobeNodes)
    .force('charge', d3.forceManyBody().strength(d => -30 * d.r).theta(0.9))
    .force('link', d3.forceLink(lobeLinks).id(d => d.k)
      .distance(l => l.source.r + l.target.r + 20)
      .strength(l => Math.min(0.5, 0.02 * Math.sqrt(l.w))))
    .force('collide', d3.forceCollide(d => d.r + 6).iterations(2))
    .force('x', d3.forceX(0).strength(0.02))
    .force('y', d3.forceY(0).strength(0.02))
    .stop();
  const metaTicks = L > 2000 ? 120 : 250;
  for (let t = 0; t < metaTicks; t++) meta.tick();
  self.postMessage({ type: 'progress', value: 0.1 });

  // ---- stage 2: neurons -------------------------------------------------------
  // Start each neuron on a sunflower spiral inside its lobe circle.
  const fill = new Int32Array(L);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const nodes = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = lobeOf[i], j = fill[k]++;
    const rr = spacing * Math.sqrt(j + 0.5), a = j * golden;
    nodes[i] = { x: lobeNodes[k].x + rr * Math.cos(a), y: lobeNodes[k].y + rr * Math.sin(a),
                 cx: lobeNodes[k].x, cy: lobeNodes[k].y };
  }
  const links = new Array(E);
  for (let e = 0; e < E; e++) links[e] = { source: edges[2 * e], target: edges[2 * e + 1] };

  const deg = new Int32Array(n);
  for (let e = 0; e < E; e++) { deg[edges[2 * e]]++; deg[edges[2 * e + 1]]++; }

  const big = n > 20000;
  const sim = d3.forceSimulation(nodes)
    .force('charge', d3.forceManyBody().strength(big ? -12 : -25).theta(big ? 1.2 : 0.9)
      .distanceMax(big ? 150 : 300))
    .force('link', d3.forceLink(links).distance(18)
      .strength(l => 0.7 / Math.min(deg[l.source.index], deg[l.target.index])).iterations(1))
    .force('x', d3.forceX(d => d.cx).strength(0.15))
    .force('y', d3.forceY(d => d.cy).strength(0.15))
    .alpha(0.5)
    .stop();
  const total = ticks || (n < 3000 ? 300 : n < 10000 ? 180 : n < 30000 ? 110 : 70);
  sim.alphaDecay(1 - Math.pow(0.001 / 0.5, 1 / total));

  const send = (done) => {
    const pos = new Float32Array(2 * n);
    for (let i = 0; i < n; i++) { pos[2 * i] = nodes[i].x; pos[2 * i + 1] = nodes[i].y; }
    self.postMessage({ type: 'positions', pos, done, value: 0.1 + 0.9 * (done ? 1 : t / total) },
      [pos.buffer]);
  };
  // First frame right away (neurons visible in their lobes), then animate.
  let t = 0;
  send(false);
  const every = n < 5000 ? 3 : n < 20000 ? 6 : 10;
  for (t = 1; t <= total; t++) {
    sim.tick();
    if (t % every === 0 && t < total) send(false);
  }
  send(true);
};
