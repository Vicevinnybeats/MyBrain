/* MyBrain web app: map list, map view, search, bottom sheet, lobes, Brain Scan. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PALETTE = window.BrainGraph.PALETTE;
  const fmt = (n) => n.toLocaleString('en-US');
  const isPhone = () => window.matchMedia('(max-width: 899px)').matches;
  const themeNow = () => (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

  let graph = null, map = null, worker = null, mapName = null, reportText = null, sheetMode = null;
  let pathFrom = -1;

  // ------------------------------------------------------------ tiny cache --
  // Finished layouts are kept in IndexedDB so a map opens instantly next time.
  const idb = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open('mybrain', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('layouts');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const tx = async (mode, fn) => {
      try {
        const db = await open();
        return await new Promise((res, rej) => {
          const t = db.transaction('layouts', mode), st = t.objectStore('layouts');
          const r = fn(st); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error);
        });
      } catch (e) { return undefined; }
    };
    return { get: (k) => tx('readonly', st => st.get(k)), set: (k, v) => tx('readwrite', st => st.put(v, k)) };
  })();

  // ---------------------------------------------------------------- router --
  function route() {
    const m = location.hash.match(/^#\/map\/([^/?]+)/);
    if (m) openMap(decodeURIComponent(m[1]));
    else showHome();
  }
  window.addEventListener('hashchange', route);

  // ------------------------------------------------------------------ home --
  function ago(iso) {
    if (!iso) return '';
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' days ago';
  }

  function cardDots(seed) {
    // little decorative network per card, stable per name
    let h = 2166136261;
    for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    const rnd = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0) / 4294967296);
    const pts = Array.from({ length: 7 }, () => [6 + rnd() * 32, 6 + rnd() * 32]);
    let svg = '<svg class="dots" viewBox="0 0 44 44">';
    for (let i = 1; i < pts.length; i++) {
      const j = Math.floor(rnd() * i);
      svg += `<line x1="${pts[i][0]}" y1="${pts[i][1]}" x2="${pts[j][0]}" y2="${pts[j][1]}" stroke="${PALETTE[i % 10]}" stroke-opacity=".6"/>`;
    }
    pts.forEach((p, i) => { svg += `<circle cx="${p[0]}" cy="${p[1]}" r="${i ? 2.6 : 4}" fill="${PALETTE[(i * 3) % 10]}"/>`; });
    return svg + '</svg>';
  }

  // ---- Brain Monitor: the home screen refreshes itself while it is open
  let homeTimer = 0, lastIndexJson = '', lastHealth = null, lastRuns = [];
  async function showHome() {
    closeMap();
    $('#mapview').hidden = true;
    $('#home').hidden = false;
    document.title = 'MyBrain';
    if (!lastIndexJson) $('#map-list').innerHTML = '<p class="muted">Loading maps…</p>';
    await refreshHome(true);
    clearInterval(homeTimer);
    homeTimer = setInterval(() => { if (!$('#home').hidden && !document.hidden) refreshHome(false); }, 20000);
    watchActivity(5000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#home').hidden) refreshHome(false); });

  async function refreshHome(force) {
    let idx = null, ok = true;
    try {
      const r = await fetch('maps/index.json', { cache: 'no-cache', credentials: 'same-origin' });
      if (r.ok) { const t = await r.text(); if (force || t !== lastIndexJson) { lastIndexJson = t; idx = JSON.parse(t).maps || []; } }
      else ok = false;
    } catch (e) { ok = false; }
    if (idx) renderMaps(idx);
    else if (force) renderMaps(window.__mapsIndex || []);
    $('#live').classList.toggle('off', !ok);
    $('#live-text').textContent = ok ? 'live' : 'offline';
    // alerts and runs: the token's health (public) and recent mapping runs (needs the key)
    try { const h = await fetch('api/health', { cache: 'no-store' }); lastHealth = h.ok ? await h.json() : null; } catch (e) { lastHealth = null; }
    if (getKey()) {
      try { const st = await apiCall('api/status'); if (st.status === 200) lastRuns = st.data.runs || []; } catch (e) { /* offline */ }
      if (lastRuns.some(r => r.status !== 'completed' && /^[\w.-]+\/[\w.-]+$/.test(r.repo || '')) && !pollTimer) watchJobs();
    }
    renderAlerts();
    renderVitals();
    renderActivity();
  }

  // ---- live activity: what Claude sessions read and change (mybrain-activity hook)
  const SES_COLORS = ['#f59e0b', '#e879f9', '#60a5fa', '#34d399', '#f87171', '#a78bfa', '#facc15', '#2dd4bf'];
  // each session keeps the colour it was first given, in order of appearance
  const sesColors = new Map();
  const sesColor = (id) => {
    if (!sesColors.has(id)) sesColors.set(id, SES_COLORS[sesColors.size % SES_COLORS.length]);
    return sesColors.get(id);
  };
  const act = { events: [], sessions: [], since: 0, off: false, skew: 0, totals: null };
  let actTimer = 0;
  async function fetchActivity() {
    if (!getKey() || act.off) return false;
    let res;
    try { res = await apiCall('api/activity?since=' + act.since); } catch (e) { return false; }
    if (res.status === 503) { act.off = true; return false; }
    if (res.status !== 200) return false;
    const d = res.data, fresh = d.events || [];
    act.skew = (d.now || Date.now()) - Date.now();
    if (fresh.length) {
      act.events = act.events.concat(fresh).slice(-300);
      act.since = fresh[fresh.length - 1].t;
    }
    act.totals = d.totals || act.totals;
    act.sessions = (d.sessions || []).sort((a, b) => a.first - b.first);
    act.sessions.forEach(x => sesColor(x.id));
    onActivity(fresh);
    return true;
  }
  function watchActivity(ms) {
    clearInterval(actTimer);
    actTimer = setInterval(() => { if (!document.hidden) fetchActivity(); }, ms);
    fetchActivity();
  }
  const sesName = (s) => `Claude · ${short(s.repo || '?')}`;
  const tokTotal = (t) => (t ? t.input + t.output + t.cache : 0);
  const kTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const tail = (p, n = 46) => (p.length > n ? '…' + p.slice(-n + 1) : p);

  function onActivity(fresh) {
    if (!$('#home').hidden) { renderSessions(); renderFeed(); renderAlerts(); renderVitals(); renderActivity(); }
    if (graph && graph.setAgents && mapName) brainActivity(fresh);
  }

  function liveSessions(windowMs = 15 * 60000) {
    const now = Date.now() + act.skew;
    return act.sessions.filter(s => now - s.last < windowMs).sort((a, b) => b.last - a.last);
  }

  function renderSessions() {
    const now = Date.now() + act.skew;
    $('#sessions').innerHTML = liveSessions().map(s => {
      const idle = now - s.last > 2 * 60000;
      const doing = s.lastPath ? `<b>${esc((s.lastKind || '').toUpperCase())}</b> ${esc(tail(s.lastPath))}` : 'started';
      return `<div class="ses${idle ? ' idle' : ''}" style="--c:${sesColor(s.id)}"><span class="dot"></span>
        <span class="nm">${esc(sesName(s))}</span><span class="tk" title="tokens used / saved by asking the map this session">${tokTotal(s.tokens) ? '~' + kTok(tokTotal(s.tokens)) : ''}${s.saved ? ` <span class="sv">−${kTok(s.saved)}</span>` : ''}</span>
        <span class="now">${idle ? `idle ${esc(ago(new Date(s.last).toISOString()))} · ` : ''}${doing} · ${s.ask ? `${s.ask} map question${s.ask === 1 ? '' : 's'} · ` : ''}${s.read} read · ${s.write} changed · ${s.search} searched</span></div>`;
    }).join('');
  }

  function renderFeed() {
    const ev = act.events.filter(e => e.kind !== 'tokens').slice(-40).reverse();
    const byId = new Map(act.sessions.map(s => [s.id, s]));
    $('#feed').innerHTML = ev.map(e => {
      const s = byId.get(e.s) || { repo: e.repo };
      return `<div class="fe" style="--c:${sesColor(e.s)}"><time>${clock(e.t)}</time><span class="who">${esc(short(s.repo || e.repo))}</span>
        <span class="kd ${esc(e.kind)}">${esc(e.kind.toUpperCase())}</span><span class="pth">${e.kind === 'ask'
          ? `<b class="sv">saved ~${kTok(e.saved || 0)}</b> · ${fmt(e.files || 0)} file${e.files === 1 ? '' : 's'} not read` : esc(tail(e.path || ''))}</span></div>`;
    }).join('');
  }

  // two sessions changing the same file within ten minutes
  function writeClashes() {
    const now = Date.now() + act.skew, last = new Map(), out = [];
    for (const e of act.events) {
      if (e.kind !== 'write' || !e.path || now - e.t > 10 * 60000) continue;
      const k = e.repo + '\n' + e.path, prev = last.get(k);
      if (prev && prev.s !== e.s && !out.some(o => o.k === k)) out.push({ k, a: prev, b: e });
      last.set(k, e);
    }
    return out;
  }

  // 3D brain: sessions working in this map's repository orbit it and fire into the files they touch
  let brainSeen = 0;
  function brainActivity(fresh) {
    const m = (window.__mapsIndex || []).find(x => x.name === mapName) || {};
    const mine = (s) => (m.source && (s.repo || '').toLowerCase() === m.source.toLowerCase()) ||
      short(s.repo || '').toLowerCase() === (mapName || '').toLowerCase();
    const agents = liveSessions().filter(mine).map(s => ({ id: s.id, name: sesName(s), color: sesColor(s.id) }));
    const key = agents.map(a => a.id).join(',');
    if (key !== graph._agentKey) { graph.setAgents(agents); graph._agentKey = key; }
    for (const e of fresh) {
      if (e.t <= brainSeen || !e.path || !agents.some(a => a.id === e.s)) continue;
      const node = nodeForPath(e.path);
      if (node >= 0) graph.fire(e.s, node, e.kind);
    }
    if (fresh.length) brainSeen = Math.max(brainSeen, fresh[fresh.length - 1].t);
  }
  let fileNodes = null;
  function nodeForPath(path) {
    if (!map) return -1;
    if (!fileNodes || fileNodes.map !== map) {
      const best = new Map(), N = map.nodes;
      for (let i = 0; i < N.label.length; i++) {
        const f = map.files[N.file[i]];
        if (!f) continue;
        const cur = best.get(f), isFile = N.label[i] === f.split('/').pop();
        if (cur === undefined || isFile || (!(N.label[cur] === f.split('/').pop()) && N.deg[i] > N.deg[cur])) best.set(f, i);
      }
      fileNodes = { map, best };
    }
    const b = fileNodes.best;
    if (b.has(path)) return b.get(path);
    for (const [f, i] of b) if (f.endsWith('/' + path) || path.endsWith('/' + f)) return i;
    return -1;
  }

  function renderVitals() {
    const idx = (window.__mapsIndex || []).filter(m => !loadRemoving()[m.name]);
    const sum = (f) => idx.reduce((a, m) => a + (f(m) || 0), 0);
    const neurons = sum(m => m.stats.neurons), syn = sum(m => m.stats.synapses), lobes = sum(m => m.stats.lobes);
    const unlinked = sum(m => m.unlinked), files = sum(m => m.files);
    const newest = idx.reduce((a, m) => (m.published && (!a || m.published > a) ? m.published : a), null);
    const biggest = idx.reduce((a, m) => (!a || m.stats.neurons > a.stats.neurons ? m : a), null);
    const linkedPct = neurons ? 100 * (1 - unlinked / neurons) : 0;
    const tile = (k, v, pct, sub) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div>
      <div class="bar"><span style="width:${Math.max(2, Math.min(100, pct)).toFixed(0)}%"></span></div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
    const tot = act.totals, savedDay = act.events.filter(e => e.kind === 'ask').reduce((a, e) => a + (e.saved || 0), 0);
    const asksDay = act.events.filter(e => e.kind === 'ask').length;
    $('#vitals').innerHTML = [
      `<div class="tile saved"><div class="k">Tokens saved</div><div class="v">${tot && tot.saved ? '~' + kTok(tot.saved) : '0'}</div>
        <div class="bar"><span style="width:100%"></span></div><div class="s">${tot && tot.asks
          ? `${fmt(tot.asks)} map question${tot.asks === 1 ? '' : 's'}${savedDay ? ` · ~${kTok(savedDay)} today` : ''}`
          : (getKey() ? 'counts when Claude asks the map' : 'needs your key')}</div></div>`,
      tile('Maps', fmt(idx.length), 100, newest ? `newest ${esc(ago(newest))}` : ''),
      tile('Neurons', fmt(neurons), 100, biggest ? `most in ${esc(biggest.name)}` : ''),
      tile('Synapses', fmt(syn), neurons ? 100 * syn / (2 * neurons) : 0, neurons ? `${(syn / Math.max(1, neurons)).toFixed(1)} per neuron` : ''),
      tile('Lobes', fmt(lobes), 100, lobes ? `${Math.round(neurons / Math.max(1, lobes))} neurons each` : ''),
      tile('Linked', `${linkedPct.toFixed(0)}%`, linkedPct, `${fmt(unlinked)} stand alone`),
      tile('Files', fmt(files), 100, idx.length ? `${Math.round(files / idx.length)} per map` : ''),
      tile('Tokens · 24h', act.sessions.length ? '~' + kTok(act.sessions.reduce((a, x) => a + tokTotal(x.tokens), 0)) : '—', 100,
        act.sessions.length ? `${act.sessions.length} Claude session${act.sessions.length === 1 ? '' : 's'}` : (getKey() ? 'no sessions yet' : 'needs your key')),
      tile('Live now', fmt(liveSessions(2 * 60000).length), 100, `${fmt(act.events.filter(e => e.kind === 'read' && Date.now() + act.skew - e.t < 3600000).length)} reads this hour`),
    ].join('');
  }

  function renderAlerts() {
    const out = [];
    const g = lastHealth && lastHealth.github;
    if (lastHealth && lastHealth.sees && !lastHealth.sees.GITHUB_TOKEN) {
      out.push(['', 'The app has no GitHub token', 'Add GITHUB_TOKEN in Cloudflare → Secrets Store (README).']);
    } else if (g && !g.ok) {
      out.push(['', `GitHub refuses the app's token (${g.status})`, '+, refresh and delete stop working. Make a new token and paste it into Cloudflare → Secrets Store → GITHUB_TOKEN.']);
    } else if (g && g.expires) {
      const days = Math.floor((Date.parse(g.expires.replace(' UTC', 'Z').replace(' ', 'T')) - Date.now()) / 86400000);
      if (days < 30) out.push(['warn', `The app's token expires in ${days} day${days === 1 ? '' : 's'}`, 'Regenerate it on GitHub and paste it into Cloudflare → Secrets Store → GITHUB_TOKEN.']);
    }
    const day = Date.now() - 86400000;
    for (const r of lastRuns) {
      if (r.status === 'completed' && r.conclusion && r.conclusion !== 'success' && r.conclusion !== 'cancelled' && Date.parse(r.updated) > day) {
        out.push(['', `Mapping ${esc(short(r.repo || r.title || ''))} failed`, `<a href="${esc(r.url)}" target="_blank" rel="noopener">See why on GitHub</a>`, r.updated]);
      }
    }
    for (const c of writeClashes()) {
      out.push(['', `Write clash: ${esc(tail(c.b.path, 40))}`, `Two Claude sessions changed this file in ${esc(short(c.b.repo))} within ten minutes.`, new Date(c.b.t).toISOString()]);
    }
    if (!getKey()) out.push(['warn', 'Mapping status is hidden on this device', 'Tap + and enter your MyBrain key once to see runs and failures here.']);
    $('#alert-count').textContent = out.filter(a => a[0] !== 'warn' || a[1].includes('expires')).length || '';
    $('#alerts').innerHTML = out.length ? out.map(([cls, title, body, when]) =>
      `<div class="alert ${cls}"><div><b>${title}</b>${body}</div>${when ? `<time>${esc(ago(when))}</time>` : ''}</div>`).join('')
      : '<div class="alert ok"><div><b>All clear</b>The token works and no mapping failed in the last day.</div></div>';
  }

  function renderActivity() {
    const active = jobs.filter(j => j.phase !== 'ready' && j.phase !== 'failed').length;
    const live = liveSessions(2 * 60000).length;
    const parts = [live ? `${live} session${live === 1 ? '' : 's'}` : '', active ? `${active} mapping` : ''].filter(Boolean);
    $('#now-count').textContent = parts.join(' · ');
    $('#now-empty').hidden = jobs.length > 0 || liveSessions().length > 0 || act.events.length > 0;
  }

  function renderMaps(idx) {
    const list = $('#map-list');
    list.innerHTML = '';
    idx.sort((a, b) => (b.published || '').localeCompare(a.published || ''));
    window.__mapsIndex = idx;
    // maps being deleted stay hidden until the app has rebuilt without them
    const gone = loadRemoving();
    const shown = idx.filter(m => !gone[m.name]);
    $('#home-empty').hidden = shown.length > 0;
    $('#map-count').textContent = shown.length || '';
    for (const m of shown) {
      const row = document.createElement('div');
      row.className = 'map-row';
      const b = document.createElement('button');
      b.className = 'map-card';
      const cores = (m.cores || []).slice(0, 3).map(c => `<b>${esc(c)}</b>`).join(' · ');
      b.innerHTML = `${cardDots(m.name)}<div style="min-width:0"><h2>${esc(m.name)}</h2>
        <p>${fmt(m.stats.neurons)} neurons · ${fmt(m.stats.synapses)} synapses · ${fmt(m.stats.lobes)} lobes</p>
        ${cores ? `<div class="cores">Core: ${cores}</div>` : ''}
        <p class="src">updated ${esc(ago(m.published))}${m.commit ? ` · ${esc(m.commit.slice(0, 7))}` : ''}</p></div>`;
      b.onclick = () => { location.hash = '#/map/' + encodeURIComponent(m.name); };
      const del = document.createElement('button');
      del.className = 'del-btn'; del.type = 'button';
      del.setAttribute('aria-label', `Delete the map of ${m.name}`);
      del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v6 M14 11v6"/></svg>';
      del.onclick = () => askDelete(row, m);
      const tools = document.createElement('div');
      tools.className = 'card-tools';
      if (m.source) {
        const ref = document.createElement('button');
        ref.className = 'ref-btn'; ref.type = 'button';
        ref.setAttribute('aria-label', `Update the map of ${m.name} now`);
        ref.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6 M20 4v5h-5"/></svg>';
        ref.onclick = () => refreshMap(ref, m);
        tools.append(ref);
      }
      tools.append(del);
      row.append(b, tools);
      list.appendChild(row);
    }
  }

  // ----------------------------------------------------------- refresh map --
  // Re-maps the repository now (newest commit); the status card shows progress.
  async function refreshMap(btn, m) {
    if (btn.classList.contains('busy')) return;
    btn.classList.add('busy');
    let res;
    try { res = await apiCall('api/add', { method: 'POST', body: JSON.stringify({ repo: m.source }) }); }
    catch (e) { res = { status: 0, data: { message: 'You seem to be offline.' } }; }
    btn.classList.remove('busy');
    if (res.status === 200) { addJob(res.data.repo || m.source); return; }
    if (res.status === 401) {
      $('#add-panel').hidden = false; $('#add-key').hidden = false; $('#add-key').focus();
      $('#add-msg').textContent = 'Enter your MyBrain key (only once on this device), then tap the refresh button again.';
      return;
    }
    toastHome(res.data.message || `Could not update (${res.status}).`);
  }
  function toastHome(text) {
    const box = $('#jobs');
    const el = document.createElement('div');
    el.className = 'job bad'; el.setAttribute('role', 'status');
    el.innerHTML = `<div class="job-step">${esc(text)}</div>`;
    box.prepend(el);
    setTimeout(() => el.remove(), 8000);
  }

  // ------------------------------------------------------------ delete map --
  const REMOVING_KEY = 'mybrain-removing';
  function loadRemoving() {
    let r = {};
    try { r = JSON.parse(localStorage.getItem(REMOVING_KEY) || '{}') || {}; } catch (e) { r = {}; }
    const now = Date.now(), live = new Set((window.__mapsIndex || []).map(m => m.name));
    for (const k of Object.keys(r)) if (!live.has(k) || now - r[k] > 15 * 60000) delete r[k];   // gone, or gave up
    try { localStorage.setItem(REMOVING_KEY, JSON.stringify(r)); } catch (e) { /* private mode */ }
    return r;
  }
  function askDelete(row, m) {
    row.classList.add('confirm');
    row.innerHTML = `<div class="del-ask"><p>Delete the map of <b>${esc(m.name)}</b>?
      <span class="muted">Your repository is not touched. You can map it again with +.</span></p>
      <p class="del-msg muted"></p>
      <div class="del-actions"><button type="button" class="btn ghost keep">Keep</button>
      <button type="button" class="btn danger yes">Delete</button></div></div>`;
    row.querySelector('.keep').onclick = () => showHome();
    row.querySelector('.yes').onclick = async () => {
      const msg = row.querySelector('.del-msg');
      msg.textContent = 'Deleting…';
      let res;
      try { res = await apiCall('api/remove', { method: 'POST', body: JSON.stringify({ name: m.name }) }); }
      catch (e) { msg.textContent = 'You seem to be offline.'; return; }
      if (res.status === 200) {
        const r = loadRemoving(); r[m.name] = Date.now();
        try { localStorage.setItem(REMOVING_KEY, JSON.stringify(r)); } catch (e) { /* private mode */ }
        if (m.source) { jobs = jobs.filter(j => j.repo.toLowerCase() !== m.source.toLowerCase()); saveJobs(); renderJobs(); }
        showHome();
      } else if (res.status === 401) {
        msg.textContent = 'Tap + and enter your MyBrain key first (only once on this device).';
      } else {
        msg.textContent = res.data.message || `Could not delete (${res.status}).`;
      }
    };
  }

  // --------------------------------------------------------------- map view --
  function closeMap() {
    stopPath();
    if (worker) { worker.terminate(); worker = null; }
    if (graph) { graph.destroy(); graph = null; window.__mybrain = null; }
    map = null; mapName = null; reportText = null;
    closeSheet();
  }

  async function openMap(name) {
    if (mapName === name && graph) return;
    closeMap();
    mapName = name;
    $('#home').hidden = true;
    $('#mapview').hidden = false;
    document.title = name + ' · MyBrain';
    $('#search').value = '';
    $('#results').hidden = true;
    $('#map-title').innerHTML = `<b>${esc(name)}</b>`;
    setProgress(0.03, 'Loading map…');
    try {
      const r = await fetch(`maps/${encodeURIComponent(name)}/map.json`, { cache: 'no-cache', credentials: 'same-origin' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      map = await r.json();
    } catch (e) {
      setProgress(null);
      $('#map-title').innerHTML = `<b>${esc(name)}</b> - could not load this map (${esc(e.message)})`;
      return;
    }
    if (mapName !== name) return;
    const st = map.stats;
    $('#map-title').innerHTML = `<b>${esc(name)}</b> · ${fmt(st.neurons)} neurons · ${fmt(st.synapses)} synapses · ${fmt(st.lobes)} lobes`;

    const opts = {
      theme: themeNow(),
      onSelect: (i) => {
        if (i >= 0 && pathFrom >= 0 && i !== pathFrom) { showPath(pathFrom, i); return; }
        if (i >= 0) showNode(i);
        else if (sheetMode === 'node' || sheetMode === 'explain' || sheetMode === 'path') closeSheet();
      },
      onHover: showTooltip,
      labels: $('#labels3d'),
    };
    let three = want3d();
    if (three) {
      setProgress(0.5, 'Growing the brain…');
      three = await load3d();
      if (mapName !== name) return;
    }
    $('#canvas').hidden = three; $('#canvas3d').hidden = !three; $('#labels3d').hidden = !three;
    $('#view3d').innerHTML = `<b>${three ? '2D' : '3D'}</b>`;
    $('#view3d').hidden = !hasWebGL();
    if (three) {
      try { graph = new window.Brain3D($('#canvas3d'), map, opts); }
      catch (e) { console.warn('3D view failed, using 2D', e); three = false; $('#canvas').hidden = false; $('#canvas3d').hidden = true; }
    }
    window.__mybrain = graph;   // handy for debugging / tests
    if (three) { applyAnim(); setProgress(null); layoutInsets(); brainSeen = Date.now() + act.skew - 60000; watchActivity(4000); return; }
    graph = new window.BrainGraph($('#canvas'), map, opts);
    window.__mybrain = graph;
    applyAnim();

    const key = `${name}@${map.published}`;
    const cached = await idb.get(key);
    if (cached && cached.length === 2 * map.nodes.label.length) {
      graph.setPositions(cached, true);
      setProgress(null);
      return;
    }
    runLayout(key);
  }

  // ---- 3D view: Three.js is loaded only when a map is opened in 3D
  const VIEW_KEY = 'mybrain-view';
  function want3d() {
    let v = null;
    try { v = localStorage.getItem(VIEW_KEY); } catch (e) { /* private mode */ }
    return v !== '2d' && (!window.Brain3D || window.Brain3D.supported()) && hasWebGL();
  }
  function hasWebGL() {
    try { const c = document.createElement('canvas'); return Boolean(c.getContext('webgl2') || c.getContext('webgl')); }
    catch (e) { return false; }
  }
  const loadScript = (src) => new Promise((ok, fail) => {
    const el = document.createElement('script');
    el.src = src; el.onload = ok; el.onerror = () => fail(new Error('could not load ' + src));
    document.head.appendChild(el);
  });
  let loading3d = null;
  function load3d() {
    if (window.Brain3D && window.THREE) return Promise.resolve(true);
    loading3d = loading3d || loadScript('vendor/three-bundle.min.js').then(() => loadScript('brain3d.js'))
      .then(() => true).catch(() => { loading3d = null; return false; });
    return loading3d;
  }
  $('#view3d').onclick = () => {
    const now3d = !$('#canvas3d').hidden;
    try { localStorage.setItem(VIEW_KEY, now3d ? '2d' : '3d'); } catch (e) { /* private mode */ }
    const name = mapName;
    closeMap();
    openMap(name);
  };

  function runLayout(key) {
    setProgress(0.08, 'Growing neurons…');
    const n = map.nodes.label.length, E = map.edges.length / 3;
    const edges = new Int32Array(2 * E);
    for (let e = 0; e < E; e++) { edges[2 * e] = map.edges[3 * e]; edges[2 * e + 1] = map.edges[3 * e + 1]; }
    const lobe = Int32Array.from(map.nodes.lobe);
    worker = new Worker('layout-worker.js');
    let first = true;
    worker.onmessage = (ev) => {
      const d = ev.data;
      if (d.type === 'progress') { setProgress(d.value); return; }
      if (!graph) return;
      graph.setPositions(d.pos, first);
      first = false;
      setProgress(d.done ? null : d.value);
      if (d.done) { idb.set(key, d.pos); worker.terminate(); worker = null; graph.fit(true); }
    };
    worker.postMessage({ n, edges, lobe }, [edges.buffer, lobe.buffer]);
  }

  function setProgress(v, label) {
    const p = $('#progress');
    if (v == null) { p.hidden = true; return; }
    p.hidden = false;
    p.querySelector('span').style.width = Math.round(Math.max(0.03, v) * 100) + '%';
    if (label) p.querySelector('em').textContent = label;
  }

  function showTooltip(i, cx, cy) {
    const t = $('#tooltip');
    if (i == null || i < 0 || !map) { t.hidden = true; return; }
    t.innerHTML = `${esc(map.nodes.label[i])}<small>${esc(map.files[map.nodes.file[i]] || '')}</small>`;
    t.style.left = Math.min(cx + 14, window.innerWidth - 300) + 'px';
    t.style.top = (cy + 14) + 'px';
    t.hidden = false;
  }

  // ---------------------------------------------------------------- search --
  let activeResult = -1;
  function searchNodes(q) {
    q = q.trim().toLowerCase();
    if (!q || !map) return [];
    const L = map.nodes.label, F = map.files, fi = map.nodes.file, deg = map.nodes.deg;
    const hits = [];
    for (let i = 0; i < L.length; i++) {
      const l = L[i].toLowerCase();
      let score = -1;
      if (l === q) score = 3; else if (l.startsWith(q)) score = 2; else if (l.includes(q)) score = 1;
      else if ((F[fi[i]] || '').toLowerCase().includes(q)) score = 0;
      if (score >= 0) hits.push([score, deg[i], i]);
    }
    hits.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    return hits.slice(0, 30).map(h => h[2]);
  }

  function renderResults(ids) {
    const box = $('#results');
    activeResult = -1;
    if (!ids.length) {
      box.innerHTML = $('#search').value.trim() ? '<div class="result"><span class="sub">No neurons match.</span></div>' : '';
      box.hidden = !$('#search').value.trim();
      return;
    }
    box.innerHTML = ids.map(i => {
      const c = PALETTE[graph.col[i]];
      return `<button class="result" role="option" data-i="${i}"><span class="dot" style="background:${c}"></span>
        <span><span class="nm">${esc(map.nodes.label[i])}</span><span class="sub">${esc(map.files[map.nodes.file[i]] || '')}</span></span></button>`;
    }).join('');
    box.hidden = false;
  }

  let searchTimer = 0;
  $('#search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderResults(searchNodes($('#search').value)), map && map.nodes.label.length > 20000 ? 160 : 60);
  });
  $('#search').addEventListener('keydown', (e) => {
    const items = [...document.querySelectorAll('#results .result[data-i]')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      activeResult = (activeResult + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((el, k) => el.classList.toggle('active', k === activeResult));
      items[activeResult].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const el = items[Math.max(0, activeResult)];
      if (el) pickResult(+el.dataset.i);
    } else if (e.key === 'Escape') {
      $('#results').hidden = true; $('#search').blur();
    }
  });
  $('#results').addEventListener('click', (e) => {
    const el = e.target.closest('.result[data-i]');
    if (el) pickResult(+el.dataset.i);
  });
  function pickResult(i) {
    $('#results').hidden = true;
    $('#search').blur();                     // closes the phone keyboard
    graph.select(i, { centre: true });
  }
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.search-wrap')) $('#results').hidden = true;
  });

  // ----------------------------------------------------------------- sheet --
  function openSheet(mode, html) {
    sheetMode = mode;
    $('#sheet-body').innerHTML = html;
    $('#sheet-body').scrollTop = 0;
    const sh = $('#sheet');
    sh.hidden = false;
    $('#mapview').classList.add('with-panel');
    $('#menu-lobes').classList.toggle('on', mode === 'lobes');
    $('#menu-scan').classList.toggle('on', mode === 'scan');
    layoutInsets();
  }
  function closeSheet() {
    sheetMode = null;
    $('#sheet').hidden = true;
    $('#sheet').classList.remove('tall');
    $('#mapview').classList.remove('with-panel');
    $('#menu-lobes').classList.remove('on');
    $('#menu-scan').classList.remove('on');
    layoutInsets();
  }
  function layoutInsets() {
    const sh = $('#sheet');
    const h = !sh.hidden && isPhone() ? sh.getBoundingClientRect().height : 0;
    $('.fabs').style.bottom = `calc(${h + 14}px + ${h ? '0px' : 'var(--safe-bottom)'})`;
    if (graph) { graph.bottomInset = h; graph.rightInset = !sh.hidden && !isPhone() ? sh.getBoundingClientRect().width : 0; graph.draw(); }
  }
  $('#sheet-close').onclick = () => { if (graph && graph.selected >= 0) graph.select(-1); closeSheet(); };
  $('#sheet-handle').onclick = () => { $('#sheet').classList.toggle('tall'); setTimeout(layoutInsets, 240); };
  window.addEventListener('resize', layoutInsets);

  const VERBS = {
    calls: ['calls', 'is called by'], imports: ['imports', 'is imported by'],
    imports_from: ['imports from', 'is imported by'], uses: ['uses', 'is used by'],
    references: ['references', 'is referenced by'], inherits: ['inherits from', 'is inherited by'],
    extends: ['extends', 'is extended by'], implements: ['implements', 'is implemented by'],
    contains: ['contains', 'is inside'], method: ['has method', 'is a method of'],
    defines: ['defines', 'is defined in'], includes: ['includes', 'is included by'],
    rationale_for: ['explains', 'is explained by'], case_of: ['is a case of', 'has case'],
    semantically_similar_to: ['is similar to', 'is similar to'], conceptually_related_to: ['relates to', 'relates to'],
    references_doc: ['references', 'is referenced by'], tests: ['tests', 'is tested by'],
  };
  const verb = (rel, out) => {
    if (VERBS[rel]) return VERBS[rel][out ? 0 : 1];
    const r = rel.replace(/_/g, ' ');
    return out ? r : `is linked (${r}) from`;
  };

  function lobeLabel(i) {
    const c = map.nodes.lobe[i];
    return graph.lobeName.get(c) || `Lobe ${c}`;
  }

  function connList(list, out) {
    return list.slice(0, 200).map(({ node, rel }) =>
      `<button class="conn" data-i="${node}"><span class="dot" style="background:${PALETTE[graph.col[node]]}"></span>
        <span class="rel">${esc(verb(rel, out))}</span><span class="nm">${esc(map.nodes.label[node])}</span></button>`
    ).join('') + (list.length > 200 ? `<p class="muted">+ ${list.length - 200} more</p>` : '');
  }

  function showNode(i) {
    showTooltip(-1);
    const N = map.nodes, file = map.files[N.file[i]] || '', loc = N.loc[i] || '';
    const { out, inc } = graph.connections(i);
    const html = `<h2>${esc(N.label[i])}</h2>
      <p class="meta"><span class="dot" style="background:${PALETTE[graph.col[i]]}"></span>${esc(lobeLabel(i))} lobe
        · ${fmt(out.length + inc.length)} synapses<br>${esc(file)}${loc ? ' · ' + esc(loc) : ''}</p>
      <div class="actions">
        <button class="btn" id="do-explain">Explain</button>
        <button class="btn ghost" id="do-focus">Zoom to</button>
        <button class="btn ghost" id="do-path">Path from here</button>
      </div>
      <div id="explain-box"></div>
      ${out.length ? `<h3>Reaches out to (${fmt(out.length)})</h3>${connList(out, true)}` : ''}
      ${inc.length ? `<h3>Reached by (${fmt(inc.length)})</h3>${connList(inc, false)}` : ''}
      ${!out.length && !inc.length ? '<p class="muted">No synapses: this neuron stands alone.</p>' : ''}`;
    openSheet('node', html);
    $('#do-explain').onclick = () => {
      $('#explain-box').innerHTML = `<div class="explain">${explain(i)}</div>`;
      sheetMode = 'explain';
    };
    $('#do-path').onclick = () => startPath(i);
    $('#do-focus').onclick = () => {
      const ids = [...graph.focus];
      graph.fit(true, ids);
    };
  }
  // ------------------------------------------------------------------ path --
  // Like `mybrain path "A" "B"`: pick a start, then tap or search the end.
  function startPath(i) {
    pathFrom = i;
    closeSheet();
    $('#toast-text').innerHTML = `Path from <b>${esc(map.nodes.label[i])}</b>: tap or search the end`;
    $('#toast').hidden = false;
  }
  function stopPath() { pathFrom = -1; $('#toast').hidden = true; }
  $('#toast-cancel').onclick = () => { stopPath(); if (graph) graph.select(-1); };

  function showPath(a, b) {
    stopPath();
    const p = graph.findPath(a, b);
    const L = map.nodes.label;
    if (!p) {
      graph.select(b);
      openSheet('path', `<h2>No path</h2><p class="meta"><b>${esc(L[a])}</b> and <b>${esc(L[b])}</b> are not connected by any chain of synapses.</p>`);
      return;
    }
    let cli = `<b>${esc(L[p.nodes[0]])}</b>\n`, rows = '';
    p.nodes.forEach((n, k) => {
      rows += `<button class="conn" data-i="${n}"><span class="dot" style="background:${PALETTE[graph.col[n]]}"></span><span class="nm">${esc(L[n])}</span></button>`;
      if (k < p.edges.length) {
        const e = p.edges[k], rel = map.rels[graph.er[e]], forward = graph.es[e] === n;
        const arrow = forward ? `--${rel}-->` : `<--${rel}--`;
        rows += `<span class="hop-rel">${esc(arrow)}</span>`;
        cli += `  ${esc(arrow)} <b>${esc(L[p.nodes[k + 1]])}</b>\n`;
      }
    });
    const hops = p.edges.length;
    openSheet('path', `<h2>${esc(L[a])} → ${esc(L[b])}</h2>
      <p class="meta">Shortest path: ${hops} hop${hops === 1 ? '' : 's'}. Zero files opened.</p>
      <div class="path-cli">${cli.trim()}</div>
      <h3>Neurons on the way</h3>${rows}`);
    graph.setPath(p);                  // after the sheet opens, so it frames the space above it
  }

  $('#sheet-body').addEventListener('click', (e) => {
    const el = e.target.closest('.conn[data-i]');
    if (el && graph) graph.select(+el.dataset.i, { centre: true });
  });

  function names(list, k = 4) {
    const seen = new Set(), xs = [];
    for (const { node } of list) { const l = map.nodes.label[node]; if (!seen.has(l)) { seen.add(l); xs.push(l); } }
    const shown = xs.slice(0, k).map(l => `<b>${esc(l)}</b>`);
    const more = xs.length - shown.length;
    if (more > 0) shown.push(`${more} more`);
    return shown.length > 1 ? shown.slice(0, -1).join(', ') + ' and ' + shown[shown.length - 1] : shown[0];
  }

  // The same facts as `mybrain explain`, written as plain sentences.
  function explain(i) {
    const N = map.nodes, label = N.label[i], file = map.files[N.file[i]] || '';
    const base = file.split('/').pop();
    const { out, inc } = graph.connections(i);
    const total = out.length + inc.length;
    const kind = label === base ? 'a file' : /\(\)$/.test(label) ? 'a function' :
      out.some(c => c.rel === 'method') ? 'a class' : 'a neuron';
    const lobeSize = (map.lobes.find(l => l[0] === N.lobe[i]) || [0, '', 1])[2];
    let txt = `<b>${esc(label)}</b> is ${kind}${file && label !== base ? ` in <code>${esc(file)}</code>` : file ? ` at <code>${esc(file)}</code>` : ''}${N.loc[i] ? ` (${esc(N.loc[i])})` : ''}. `;
    txt += `It belongs to the <b>${esc(lobeLabel(i))}</b> lobe, together with ${fmt(Math.max(0, lobeSize - 1))} other neurons. `;
    const group = (list) => { const g = new Map(); for (const c of list) { if (!g.has(c.rel)) g.set(c.rel, []); g.get(c.rel).push(c); } return g; };
    const parts = [];
    for (const [rel, list] of group(out)) parts.push(`it ${esc(verb(rel, true))} ${names(list)}`);
    for (const [rel, list] of group(inc)) parts.push(`it ${esc(verb(rel, false))} ${names(list)}`);
    if (parts.length) txt += 'In short: ' + parts.slice(0, 6).join('; ') + '. ';
    // how central is it?
    const better = map.nodes.deg.reduce((a, d) => a + (d > total ? 1 : 0), 0);
    const pct = (100 * better) / map.nodes.deg.length;
    if (pct < 1) txt += `With ${fmt(total)} synapses it is a <b>core neuron</b>: one of the most connected parts of the project.`;
    else if (pct < 10) txt += `With ${fmt(total)} synapses it is busier than ${Math.round(100 - pct)}% of neurons.`;
    else if (total <= 1) txt += 'It is barely connected, so it may be a leaf or unused.';
    return txt;
  }

  // ----------------------------------------------------------------- lobes --
  function showLobes() {
    const rows = map.lobes.map(([c, name, size]) =>
      `<label class="lobe-row" data-name="${esc(name.toLowerCase())}"><input type="checkbox" data-c="${c}" ${graph.hiddenLobes.has(c) ? '' : 'checked'}>
        <span class="dot" style="background:${PALETTE[graph.lobeColor.get(c) ?? 9]}"></span>
        <span class="nm">${esc(name)}</span><span class="cnt">${fmt(size)}</span></label>`).join('');
    openSheet('lobes', `<h2>Lobes</h2><p class="meta">Groups of neurons that belong together. Untick to hide.</p>
      <div class="lobe-tools"><input id="lobe-filter" type="search" placeholder="Filter lobes…" enterkeyhint="search" autocomplete="off">
      <button class="btn ghost" id="lobes-all">All</button><button class="btn ghost" id="lobes-none">None</button></div>
      <div id="lobe-rows">${rows}</div>`);
    const apply = () => {
      const hid = new Set();
      document.querySelectorAll('#lobe-rows input').forEach(cb => { if (!cb.checked) hid.add(+cb.dataset.c); });
      graph.setHiddenLobes(hid);
    };
    $('#lobe-rows').addEventListener('change', apply);
    $('#lobes-all').onclick = () => { document.querySelectorAll('#lobe-rows input').forEach(cb => (cb.checked = true)); apply(); };
    $('#lobes-none').onclick = () => { document.querySelectorAll('#lobe-rows input').forEach(cb => (cb.checked = false)); apply(); };
    $('#lobe-filter').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      document.querySelectorAll('#lobe-rows .lobe-row').forEach(r => { r.hidden = q && !r.dataset.name.includes(q); });
    });
  }
  $('#menu-lobes').onclick = () => (sheetMode === 'lobes' ? closeSheet() : map && showLobes());

  // ------------------------------------------------------------ brain scan --
  function md(src) {
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[\s(])_([^_]+)_(?=[\s).,]|$)/g, '$1<i>$2</i>');
    const out = []; let list = null, para = [], code = null;
    const flush = () => {
      if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
      if (list) { out.push(`<${list.t}>${list.items.map(x => `<li>${inline(x)}</li>`).join('')}</${list.t}>`); list = null; }
    };
    for (const line of src.split('\n')) {
      if (code !== null) {
        if (line.startsWith('```')) { out.push(`<pre><code>${esc(code)}</code></pre>`); code = null; } else code += line + '\n';
        continue;
      }
      if (line.startsWith('```')) { flush(); code = ''; continue; }
      let m;
      if ((m = line.match(/^(#{1,4})\s+(.*)/))) { flush(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
      if ((m = line.match(/^\s*[-*]\s+(.*)/))) { para.length && flush(); if (!list || list.t !== 'ul') { flush(); list = { t: 'ul', items: [] }; } list.items.push(m[1]); continue; }
      if ((m = line.match(/^\s*\d+\.\s+(.*)/))) { para.length && flush(); if (!list || list.t !== 'ol') { flush(); list = { t: 'ol', items: [] }; } list.items.push(m[1]); continue; }
      if (!line.trim()) { flush(); continue; }
      if (list && /^\s{2,}/.test(line)) { list.items[list.items.length - 1] += ' ' + line.trim(); continue; }
      if (list) flush();
      para.push(line.trim());
    }
    flush();
    return out.join('\n');
  }

  async function showScan() {
    openSheet('scan', '<p class="muted">Loading Brain Scan…</p>');
    $('#sheet').classList.add('tall');
    if (reportText == null) {
      try {
        const r = await fetch(`maps/${encodeURIComponent(mapName)}/report.md`, { cache: 'no-cache', credentials: 'same-origin' });
        reportText = r.ok ? await r.text() : '';
      } catch (e) { reportText = ''; }
    }
    if (sheetMode !== 'scan') return;
    // Very long reports: keep the phone snappy by rendering the first part.
    const text = reportText.length > 120000 ? reportText.slice(0, 120000) + '\n\n_(report shortened)_' : reportText;
    $('#sheet-body').innerHTML = `<div class="report">${text ? md(text) : '<p>No Brain Scan for this map.</p>'}</div>`;
    setTimeout(layoutInsets, 240);
  }
  $('#menu-scan').onclick = () => (sheetMode === 'scan' ? closeSheet() : map && showScan());

  // ------------------------------------------------------------- + add map --
  // Asks the server to run the "Add a map" workflow in the maps repository.
  const KEY = 'mybrain-key';
  const getKey = () => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } };
  const setKey = (k) => { try { localStorage.setItem(KEY, k); } catch (e) { /* private mode */ } };
  let runTimer = 0;

  async function apiCall(path, opts = {}) {
    const headers = { 'content-type': 'application/json' };
    const k = getKey();
    if (k) headers['x-mybrain-key'] = k;
    const r = await fetch(path, { credentials: 'same-origin', ...opts, headers });
    let data = {};
    try { data = await r.json(); } catch (e) { /* not json */ }
    return { status: r.status, data };
  }

  function ago2(iso) { return ago(iso) || ''; }

  // ---- mapping status cards: live steps, a timer and a progress bar ------
  const JOBS_KEY = 'mybrain-jobs';
  let jobs = [];
  try { jobs = JSON.parse(localStorage.getItem(JOBS_KEY) || '[]'); } catch (e) { jobs = []; }
  const isRepo = (s) => /^[\w.-]+\/[\w.-]+$/.test(s || '');
  jobs = Array.isArray(jobs) ? jobs.filter(j => j && isRepo(j.repo)) : [];   // drop cards from older versions' mistakes
  let pollTimer = 0, tickTimer = 0;
  const saveJobs = () => { try { localStorage.setItem(JOBS_KEY, JSON.stringify(jobs)); } catch (e) { /* private mode */ } };
  const STEP_LABEL = {
    'Run actions/checkout@v4': 'Getting ready', 'Run astral-sh/setup-uv@v6': 'Getting ready',
    'Install MyBrain': 'Getting ready', 'Download the project': 'Downloading the code',
    'Build the map (code only, free)': 'Building the map', 'Publish': 'Saving the map',
  };
  const short = (repo) => repo.split('/').pop();
  const mmss = (ms) => { const t = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

  function jobView(j) {
    const now = Date.now();
    const elapsed = (j.doneAt || now) - j.startedAt;
    let text, pct, cls = 'active';
    if (j.phase === 'starting') { text = elapsed > 90000 ? 'Taking longer than usual to start…' : 'Starting…'; pct = 5; }
    else if (j.phase === 'queued') { text = 'Waiting for a free robot…'; pct = 10; }
    else if (j.phase === 'running') {
      text = (STEP_LABEL[j.step] || 'Working') + (j.stepCount ? ` · step ${Math.min(j.stepIndex + 1, j.stepCount)} of ${j.stepCount}` : '');
      pct = 15 + 70 * (j.stepCount ? j.stepIndex / j.stepCount : 0.3);
    }
    else if (j.phase === 'publishing') { text = 'Updating the app with the new map…'; pct = 92; }
    else if (j.phase === 'ready') { text = 'Ready: tap to open'; pct = 100; cls = 'ok'; }
    else { text = `Failed${j.url ? ` · <a href="${esc(j.url)}" target="_blank" rel="noopener">see why</a>` : ''}`; pct = 100; cls = 'bad'; }
    const icon = cls === 'active' ? '<span class="spin" aria-hidden="true"></span>' : `<span aria-hidden="true">${cls === 'ok' ? '✅' : '⚠️'}</span>`;
    return `<div class="job ${cls}" data-repo="${esc(j.repo)}" role="status">
      <div class="job-top"><span class="job-name">${icon}${esc(short(j.repo))}</span><span class="job-time">⏱ ${mmss(elapsed)}</span></div>
      <div class="job-step">${cls === 'bad' ? text : esc(text)}</div>
      <div class="job-bar"><span style="width:${pct.toFixed(0)}%"></span></div></div>`;
  }
  function renderJobs() {
    const box = $('#jobs');
    if (!box) return;
    box.innerHTML = jobs.map(jobView).join('');
    renderActivity();
  }
  $('#jobs').addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const el = e.target.closest('.job.ok');
    if (!el) return;
    const j = jobs.find(x => x.repo === el.dataset.repo);
    if (j) { jobs = jobs.filter(x => x !== j); saveJobs(); location.hash = '#/map/' + encodeURIComponent(j.name || short(j.repo).toLowerCase()); }
  });

  function addJob(repo) {
    jobs = jobs.filter(j => j.repo.toLowerCase() !== repo.toLowerCase());
    jobs.unshift({ repo, startedAt: Date.now(), phase: 'starting' });
    saveJobs(); renderJobs(); watchJobs();
  }

  async function pollJobs() {
    const now = Date.now();
    // forget finished cards after a while
    jobs = jobs.filter(j => !(j.phase === 'ready' && now - j.doneAt > 3 * 60000) && !(j.phase === 'failed' && now - j.doneAt > 20 * 60000));
    let status;
    try { status = await apiCall('api/status'); } catch (e) { status = null; }
    const seen = Boolean(status && status.status === 200);
    const runs = seen ? status.data.runs || [] : [];
    // runs started elsewhere (the hourly refresh) get a card too, once GitHub names their repo
    for (const r of runs) {
      if (r.status !== 'completed' && isRepo(r.repo) && !jobs.some(j => j.repo.toLowerCase() === r.repo.toLowerCase())) {
        jobs.push({ repo: r.repo, startedAt: Date.parse(r.created) || now, phase: 'queued' });
      }
    }
    let index = null;
    for (const j of jobs) {
      if (j.phase === 'ready' || j.phase === 'failed') continue;
      const run = runs.filter(r => (r.repo || '').toLowerCase() === j.repo.toLowerCase() && Date.parse(r.created) >= j.startedAt - 90000)
        .sort((a, b) => Date.parse(b.created) - Date.parse(a.created))[0];
      if (!run) {
        // GitHub never showed a run for this card: give up rather than spin forever
        if (seen && now - j.startedAt > (j.phase === 'starting' ? 5 : 15) * 60000) { j.phase = 'failed'; j.doneAt = now; }
        continue;
      }
      j.url = run.url; j.runCreated = run.created;
      if (run.status === 'completed') {
        if (run.conclusion !== 'success') { j.phase = 'failed'; j.doneAt = Date.parse(run.updated) || now; continue; }
        j.phase = 'publishing';
        if (!index) {
          try { const r = await fetch('maps/index.json', { cache: 'no-store', credentials: 'same-origin' }); index = r.ok ? (await r.json()).maps || [] : []; }
          catch (e) { index = []; }
        }
        const m = index.find(x => (x.source || '').toLowerCase() === j.repo.toLowerCase());
        if (m && m.published && Date.parse(m.published) >= Date.parse(run.created) - 60000) {
          j.phase = 'ready'; j.doneAt = now; j.name = m.name;
          if (!$('#home').hidden) showHome();
        } else if (now - (Date.parse(run.updated) || now) > 10 * 60000) { j.phase = 'failed'; j.doneAt = now; }
      } else {
        j.phase = run.status === 'in_progress' ? 'running' : 'queued';
        j.step = run.step; j.stepIndex = run.stepIndex; j.stepCount = run.stepCount;
      }
    }
    saveJobs(); renderJobs();
    if (!jobs.some(j => j.phase !== 'ready' && j.phase !== 'failed')) stopJobs();
  }
  function watchJobs() {
    if (!pollTimer) pollTimer = setInterval(pollJobs, 5000);
    if (!tickTimer) tickTimer = setInterval(renderJobs, 1000);
    pollJobs();
  }
  function stopJobs() {
    clearInterval(pollTimer); pollTimer = 0;
    clearInterval(tickTimer); tickTimer = 0;
    renderJobs();
  }
  if (jobs.length) { renderJobs(); watchJobs(); }

  // The picker: your GitHub repositories, newest first; tap one to map it.
  let repoCache = null;
  async function loadRepos() {
    const box = $('#repo-list');
    box.innerHTML = '<p class="muted">Loading your repositories…</p>';
    const { status, data } = await apiCall('api/repos');
    if (status === 401) {
      $('#add-key').hidden = false;
      box.innerHTML = '<p class="muted">Type your MyBrain key above (only once on this device), then tap a repository.</p>';
      return;
    }
    if (status !== 200) {
      const why = data.message || (status === 503 ? 'The app has no GITHUB_TOKEN yet (README).' : `The app answered ${status}.`);
      box.innerHTML = `<p class="muted">Could not load your repositories. ${esc(why)}</p>`;
      return;
    }
    repoCache = data.repos || [];
    renderRepos();
  }
  function renderRepos() {
    const box = $('#repo-list');
    if (!repoCache) return;
    const q = $('#add-repo').value.trim().toLowerCase();
    const mapped = new Set((window.__mapsIndex || []).map(m => (m.source || '').toLowerCase()));
    const rows = repoCache.filter(r => !q || r.repo.toLowerCase().includes(q)).slice(0, 60);
    box.innerHTML = rows.length ? rows.map(r => {
      const done = mapped.has(r.repo.toLowerCase());
      return `<button class="repo-row" type="button" role="listitem" data-repo="${esc(r.repo)}">
        <span class="info"><span class="nm">${esc(r.repo.split('/').pop())}${r.private ? ' <span class="muted">🔒</span>' : ''}</span>
        <span class="muted">${esc(r.description ? r.description.slice(0, 80) : 'updated ' + ago(r.pushed))}</span></span>
        <span class="go${done ? ' done' : ''}">${done ? 'Refresh' : 'Map'}</span>
      </button>`;
    }).join('') : (q.includes('/') ? '<p class="muted">Press Enter to map ' + esc(q) + '.</p>' : '<p class="muted">No repository matches.</p>');
  }
  $('#repo-list').addEventListener('click', (e) => {
    const el = e.target.closest('.repo-row');
    if (el) mapRepo(el.dataset.repo);
  });
  $('#add-repo').addEventListener('input', renderRepos);
  $('#add-key').addEventListener('change', () => { if ($('#add-key').value.trim()) { setKey($('#add-key').value.trim()); $('#add-key').hidden = true; loadRepos(); } });

  $('#add-btn').onclick = () => {
    const p = $('#add-panel');
    p.hidden = !p.hidden;
    if (!p.hidden) { $('#add-msg').textContent = ''; $('#add-repo').value = ''; loadRepos(); }
  };
  $('#add-cancel').onclick = () => { $('#add-panel').hidden = true; };
  // Tap outside the card, or Escape, closes the popup.
  $('#add-panel').addEventListener('click', (e) => { if (e.target.id === 'add-panel') $('#add-panel').hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#add-panel').hidden = true; });
  $('#add-form').addEventListener('submit', (e) => { e.preventDefault(); mapRepo($('#add-repo').value.trim()); });

  async function mapRepo(repo) {
    const keyBox = $('#add-key');
    if (!keyBox.hidden && keyBox.value.trim()) setKey(keyBox.value.trim());
    if (!repo) { $('#add-msg').textContent = 'Tap a repository below.'; return; }
    $('#add-msg').textContent = 'Starting…';
    let res;
    try { res = await apiCall('api/add', { method: 'POST', body: JSON.stringify({ repo }) }); }
    catch (err) { $('#add-msg').textContent = 'You seem to be offline.'; return; }
    const { status, data } = res;
    if (status === 200) {
      $('#add-repo').value = '';
      keyBox.hidden = true;
      $('#add-panel').hidden = true;          // the status card on the home screen takes over
      addJob(data.repo);
    } else if (status === 401) {
      keyBox.hidden = false; keyBox.focus();
      $('#add-msg').textContent = data.needKey ? 'Enter your MyBrain key (only needed once on this device).'
        : 'The app cannot see its ADD_KEY secret (see README).';
    } else if (status === 503) {
      $('#add-msg').textContent = 'Almost there: the app has no GITHUB_TOKEN yet (see README).';
    } else if (status === 400) {
      $('#add-msg').textContent = data.message || 'That does not look like owner/name.';
    } else if (status === 404 || status === 405 || status === 501) {
      $('#add-msg').textContent = 'This app version has no + server yet. It arrives with the next build.';
    } else {
      $('#add-msg').textContent = data.message || `GitHub said no (${data.status || status}).`;
    }
  }

  // ----------------------------------------------------------------- misc --
  $('#back').onclick = () => { location.hash = '#/'; };
  $('#fit').onclick = () => graph && graph.fit(true);
  // Firing-signal animation: on by default, remembered per device.
  const animPref = () => { try { return localStorage.getItem('mybrain-anim'); } catch (e) { return null; } };
  function applyAnim() {
    const on = animPref() !== 'off' && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches && animPref() !== 'on');
    $('#anim').classList.toggle('on', on);
    if (graph) graph.setAnimate(on);
  }
  $('#anim').onclick = () => {
    const on = !$('#anim').classList.contains('on');
    try { localStorage.setItem('mybrain-anim', on ? 'on' : 'off'); } catch (e) { /* private mode */ }
    applyAnim();
  };
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (graph) { graph.theme = themeNow(); graph.draw(); }
  });

  // Install as an app (Chrome/Edge/Android). iPhone: Share → Add to Home Screen.
  let installEvt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('#install-btn').hidden = false; });
  $('#install-btn').onclick = async () => { if (!installEvt) return; installEvt.prompt(); installEvt = null; $('#install-btn').hidden = true; };

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').then(reg => reg.update()).catch(() => {});
    // A new version took over: reload once so the page and the app match.
    let reloaded = false;
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded || !hadController) return;
      reloaded = true; location.reload();
    });
  }
  fetch('version.txt', { cache: 'no-cache' }).then(r => (r.ok ? r.text() : '')).then(v => { $('#version').textContent = v.trim(); }).catch(() => {});

  route();
})();
