/* MyBrain web app server (Cloudflare Worker).
 *
 * Serves the static app, plus the "+" button's endpoints:
 *   GET  /api/repos              your GitHub repositories, for the picker
 *   POST /api/add {repo}         map a repository (starts "Add a map" in mybrain-maps)
 *   POST /api/remove {name}      delete a map (starts "Remove a map" in mybrain-maps)
 *   GET  /api/status             the latest mapping runs
 *   GET  /api/archive?...        the repository's code, for that mapping run only
 *                                (a signed, 30-minute pass; see below)
 *   GET  /api/health             which settings this deployment can see (names only)
 *   POST /api/activity           a Claude session reports a read / write / search (no key)
 *   GET  /api/activity?since=    the live activity feed and sessions (key)
 * and an hourly timer that re-maps every mapped repository that has new commits.
 *
 * Only ONE credential exists: the GITHUB_TOKEN secret (fine-grained; all
 * repositories: Contents read-only; mybrain-maps: Actions read and write).
 * The mapping robot in mybrain-maps never holds it. When the app starts a run
 * it passes the run a signature over (repo, commit, time) made with that token;
 * the run trades it back here for exactly that commit's code, within 30 minutes.
 *
 * Who may use /api/repos, /api/add, /api/remove, /api/status: anyone who passed Cloudflare
 * Access (when Access is on), or whoever sends the right MyBrain key (ADD_KEY).
 *
 * Settings: GITHUB_TOKEN, ADD_KEY (Secrets Store, see wrangler.jsonc),
 *           MAPS_REPO (owner/repo of the maps repository, wrangler.jsonc vars).
 */
const PASS_MINUTES = 30;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

// A setting can be a plain secret (a string) or a Secrets Store binding.
// Pasted on a phone, a value often carries a space, a line break or quotes: drop them.
async function rawSetting(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v.get === 'function') { try { return (await v.get()) || ''; } catch (e) { return ''; } }
  return '';
}
const clean = (x) => String(x).trim().replace(/^["'`]+|["'`]+$/g, '').replace(/^(Bearer|token)\s+/i, '').trim();
async function setting(v) { return clean(await rawSetting(v)); }

// The token's shape, never its value: which kind, how long, whether it was pasted with extras.
async function tokenShape(v) {
  const raw = await rawSetting(v), t = clean(raw);
  const kind = (t.match(/^(github_pat_|ghp_|gho_|ghs_|ghu_)/) || [])[1] || 'unknown';
  const fine = kind === 'github_pat_' ? t.length === 93 : kind === 'ghp_' ? t.length === 40 : null;
  return { kind, length: t.length, lengthLooksRight: fine, hadExtras: raw !== t, hasInnerSpace: /\s/.test(t),
           // the last 4 characters, to compare with the token you copied; where the value comes from
           endsWith: t.length > 20 ? t.slice(-4) : null,
           from: typeof v === 'string' ? 'worker secret' : v && typeof v.get === 'function' ? 'Secrets Store' : 'none' };
}

async function allowed(request, env, ctx) {
  if (ctx && ctx.access) return true;                       // signed in through Access
  const key = request.headers.get('x-mybrain-key') || '';
  const want = await setting(env.ADD_KEY);
  return Boolean(want && key && timingSafeEqual(key, want));
}

// "owner/name", "https://github.com/owner/name(.git)" or "github.com/owner/name"
function parseRepo(input) {
  const s = String(input || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/);
  if (!m || m[2] === '.' || m[2] === '..') return null;
  return `${m[1]}/${m[2]}`;
}

async function gh(env, path, init = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${await setting(env.GITHUB_TOKEN)}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'mybrain-app',
      ...(init.headers || {}),
    },
  });
}

// ---- the signed pass ---------------------------------------------------------
async function hmac(env, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode('mybrain-pass:' + await setting(env.GITHUB_TOKEN)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const passMessage = (repo, sha, ts) => `${repo}\n${sha}\n${ts}`;

// The newest commit of a repository's default branch.
async function headCommit(env, repo) {
  const r = await gh(env, `/repos/${repo}/commits/HEAD`, { headers: { accept: 'application/vnd.github.sha' } });
  if (!r.ok) return { error: r.status };
  return { sha: (await r.text()).trim() };
}

// Start the "Add a map" run for one repository at one commit.
async function startMapping(env, repo) {
  const head = await headCommit(env, repo);
  if (head.error) return { ok: false, status: head.error };
  const ts = String(Date.now());
  const sig = await hmac(env, passMessage(repo, head.sha, ts));
  const r = await gh(env, `/repos/${env.MAPS_REPO}/actions/workflows/add-map.yml/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: 'main', inputs: { repo, sha: head.sha, ts, sig } }),
  });
  if (r.status !== 204) return { ok: false, status: r.status, message: (await r.text()).slice(0, 300) };
  return { ok: true, sha: head.sha };
}

// What a GitHub refusal means, in words the app can show.
function githubSays(status) {
  if (status === 401) return "GitHub refused the app's token: it was deleted, expired or regenerated. Make a new one and put it in Cloudflare's Secrets Store as GITHUB_TOKEN (README).";
  if (status === 403) return "GitHub refused: the app's token lacks a permission, or GitHub's hourly limit was hit. Check the token's settings (README), or try again in an hour.";
  return `GitHub said ${status}. Try again in a minute.`;
}

async function api(request, env, ctx, path) {
  const url = new URL(request.url);

  if (path === '/api/health') {
    // Does GitHub accept the token? (status code and expiry date only, never the token)
    let github = null;
    if (await setting(env.GITHUB_TOKEN)) {
      try {
        const g = await gh(env, '/user/repos?per_page=1');
        github = { status: g.status, ok: g.ok, expires: g.headers.get('github-authentication-token-expiration'),
                   rateLeft: g.headers.get('x-ratelimit-remaining') };
        if (!g.ok) github.says = ((await g.json().catch(() => ({}))).message || '').slice(0, 120);
      } catch (e) { github = { error: String(e).slice(0, 120) }; }
    }
    return json({
      github, token: await tokenShape(env.GITHUB_TOKEN),
      ok: true,
      sees: { ADD_KEY: Boolean(await setting(env.ADD_KEY)), GITHUB_TOKEN: Boolean(await setting(env.GITHUB_TOKEN)),
              MAPS_REPO: env.MAPS_REPO || null, access: Boolean(ctx && ctx.access) },
      settingNames: Object.keys(env).filter(k => k !== 'ASSETS').sort(),
    });
  }

  // The mapping run trades its signed pass for the code. No key: the pass is the key.
  if (path === '/api/archive' && request.method === 'GET') {
    const repo = parseRepo(url.searchParams.get('repo'));
    const sha = url.searchParams.get('sha') || '';
    const ts = url.searchParams.get('ts') || '';
    const sig = url.searchParams.get('sig') || '';
    if (!repo || !/^[0-9a-f]{40}$/.test(sha) || !/^\d{10,16}$/.test(ts)) return json({ error: 'bad-pass' }, 400);
    const age = Date.now() - Number(ts);
    if (age < -60000 || age > PASS_MINUTES * 60000) return json({ error: 'expired-pass' }, 403);
    if (!timingSafeEqual(sig, await hmac(env, passMessage(repo, sha, ts)))) return json({ error: 'bad-pass' }, 403);
    const r = await gh(env, `/repos/${repo}/tarball/${sha}`);
    if (!r.ok) return json({ error: 'github', status: r.status }, 502);
    return new Response(r.body, { headers: { 'content-type': 'application/gzip', 'cache-control': 'no-store' } });
  }

  // Claude sessions report what they do. No key: see Activity above.
  if (path === '/api/activity' && request.method === 'POST') {
    const stub = activityStub(env);
    if (!stub) return json({ error: 'activity-off' }, 503);
    const body = await request.text();
    if (body.length > 2048) return json({ error: 'too-big' }, 413);
    return stub.fetch(new Request('https://activity/add', { method: 'POST', body }));
  }

  if (!(await allowed(request, env, ctx))) {
    return json({ error: 'locked', needKey: Boolean(await setting(env.ADD_KEY)) }, 401);
  }
  if (!(await setting(env.GITHUB_TOKEN)) || !env.MAPS_REPO) {
    return json({ error: 'not-set-up', message: 'Add the GITHUB_TOKEN secret to the mybrain Worker first.' }, 503);
  }

  if (path === '/api/repos' && request.method === 'GET') {
    const all = [];
    for (let page = 1; page <= 5; page++) {
      const r = await gh(env, `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`);
      if (!r.ok) return json({ error: 'github', status: r.status, message: githubSays(r.status) }, 502);
      const batch = await r.json();
      for (const x of batch) all.push({ repo: x.full_name, private: x.private, pushed: x.pushed_at, description: x.description || '' });
      if (batch.length < 100) break;
    }
    return json({ repos: all.filter(x => x.repo !== env.MAPS_REPO) });
  }

  if (path === '/api/add' && request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) { /* empty body */ }
    const repo = parseRepo(body.repo);
    if (!repo) return json({ error: 'bad-repo', message: 'Use owner/name, e.g. Vicevinnybeats/GNARL' }, 400);
    const res = await startMapping(env, repo);
    if (!res.ok) {
      const message = res.status === 404
        ? `GitHub does not let the app see ${repo}. Allow the app's token "All repositories" (README).`
        : res.status === 401 || res.status === 403 ? githubSays(res.status) : (res.message || `GitHub said ${res.status}`);
      return json({ error: 'github', status: res.status, message }, 502);
    }
    return json({ ok: true, repo });
  }

  // Delete a map: runs "Remove a map" in the maps repository (the mapped repo is untouched).
  if (path === '/api/remove' && request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) { /* empty body */ }
    const name = String(body.name || '');
    if (!/^[a-z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..') return json({ error: 'bad-name' }, 400);
    const r = await gh(env, `/repos/${env.MAPS_REPO}/actions/workflows/remove-map.yml/dispatches`, {
      method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { name } }),
    });
    if (r.status !== 204) {
      const message = r.status === 404 ? 'The maps repository has no "Remove a map" workflow yet.' : githubSays(r.status);
      return json({ error: 'github', status: r.status, message }, 502);
    }
    return json({ ok: true, name });
  }

  if (path === '/api/activity' && request.method === 'GET') {
    const stub = activityStub(env);
    if (!stub) return json({ error: 'activity-off', events: [], sessions: [] }, 503);
    return stub.fetch(new Request('https://activity/list?since=' + encodeURIComponent(url.searchParams.get('since') || '0')));
  }

  if (path === '/api/status' && request.method === 'GET') {
    const r = await gh(env, `/repos/${env.MAPS_REPO}/actions/workflows/add-map.yml/runs?per_page=8`);
    if (!r.ok) return json({ error: 'github', status: r.status }, 502);
    const data = await r.json();
    const runs = (data.workflow_runs || []).map(w => ({
      // While a run waits in the queue GitHub titles it with the workflow's name
      // ("Add a map"), not "Map owner/name": such a run has no repo yet.
      id: w.id, title: w.display_title, repo: /^Map [\w.-]+\/[\w.-]+$/.test(w.display_title || '') ? w.display_title.slice(4) : null,
      status: w.status, conclusion: w.conclusion, created: w.created_at, updated: w.updated_at,
      url: w.html_url, step: null, stepIndex: 0, stepCount: 0,
    }));
    // For runs still going, which step they are on (one small request each).
    await Promise.all(runs.filter(x => x.status !== 'completed').slice(0, 4).map(async x => {
      const j = await gh(env, `/repos/${env.MAPS_REPO}/actions/runs/${x.id}/jobs`);
      if (!j.ok) return;
      const job = ((await j.json()).jobs || [])[0];
      if (!job || !job.steps) return;
      const steps = job.steps.filter(st => !/^(Set up job|Complete job|Post )/.test(st.name));
      const cur = steps.find(st => st.status === 'in_progress') || steps.find(st => st.status !== 'completed');
      x.step = cur ? cur.name : null;
      x.stepIndex = steps.filter(st => st.status === 'completed').length;
      x.stepCount = steps.length;
    }));
    return json({ runs });
  }
  return json({ error: 'not-found' }, 404);
}

// ---- live activity -----------------------------------------------------------
// What Claude sessions read and change (sent by `mybrain-activity`, a Claude Code
// hook) is kept for a day in one Durable Object, so every phone and computer sees
// the same feed. Sending is open (sessions hold no key) but strictly shaped and
// rate limited; reading needs the key, like the rest of the app.
const KINDS = new Set(['read', 'write', 'search', 'run', 'start', 'tokens', 'ask']);
const DAY = 86400000;

function cleanEvent(b) {
  if (!b || typeof b !== 'object') return null;
  const session = String(b.session || ''), repo = String(b.repo || ''), kind = String(b.kind || '');
  if (!/^[\w-]{1,64}$/.test(session) || !/^[\w.-]{1,100}(\/[\w.-]{1,100})?$/.test(repo) || !KINDS.has(kind)) return null;
  if (repo.split('/').some(p => p === '.' || p === '..')) return null;
  const ev = { session, repo, kind };
  if (b.path != null) {
    const path = String(b.path);
    if (path.length > 300 || /[\u0000-\u001f]/.test(path)) return null;
    ev.path = path;
  }
  if (kind === 'tokens') {
    const t = b.tokens || {}, n = (v) => Math.max(0, Math.min(1e11, Math.floor(Number(v) || 0)));
    ev.tokens = { input: n(t.input), output: n(t.output), cache: n(t.cache) };
  }
  if (kind === 'ask') {   // a map question: its answer's tokens and the file tokens it spared
    const t = b.tokens || {}, n = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
    ev.tokens = { used: n(t.used, 1e6), saved: n(t.saved, 5e6), files: n(t.files, 1e4) };
  }
  return ev;
}

export class Activity {
  constructor(state) { this.state = state; this.data = null; this.rate = new Map(); }

  async load() {
    if (!this.data) this.data = (await this.state.storage.get('data')) || { events: [], sessions: {} };
    const cut = Date.now() - DAY, d = this.data;
    // all-time totals survive the one-day window: map questions and tokens they saved
    d.totals = d.totals || { asks: 0, saved: 0, since: Date.now() };
    d.events = d.events.filter(e => e.t > cut);
    for (const [k, v] of Object.entries(d.sessions)) if (v.last < cut) delete d.sessions[k];
    return d;
  }

  limited(session) {
    const minute = Math.floor(Date.now() / 60000);
    if (this.rate.get('m') !== minute) { this.rate.clear(); this.rate.set('m', minute); }
    const one = (this.rate.get(session) || 0) + 1, all = (this.rate.get('*') || 0) + 1;
    this.rate.set(session, one); this.rate.set('*', all);
    return one > 120 || all > 600;
  }

  async fetch(request) {
    const d = await this.load();
    if (request.method === 'POST') {
      const ev = cleanEvent(await request.json().catch(() => null));
      if (!ev) return json({ error: 'bad-event' }, 400);
      if (this.limited(ev.session)) return json({ error: 'slow-down' }, 429);
      const now = Date.now();
      const s = d.sessions[ev.session] || (d.sessions[ev.session] = { id: ev.session, repo: ev.repo, first: now, last: now,
        read: 0, write: 0, search: 0, run: 0, ask: 0, saved: 0, tokens: { input: 0, output: 0, cache: 0 } });
      s.last = now; s.repo = ev.repo;
      if (ev.kind === 'tokens') s.tokens = ev.tokens;
      else if (ev.kind === 'ask') {
        s.ask = (s.ask || 0) + 1; s.saved = (s.saved || 0) + ev.tokens.saved;
        d.totals.asks++; d.totals.saved += ev.tokens.saved;
        d.events.push({ t: now, s: ev.session, repo: ev.repo, kind: 'ask', path: '', saved: ev.tokens.saved, files: ev.tokens.files });
        if (d.events.length > 500) d.events.splice(0, d.events.length - 500);
      } else {
        if (ev.kind in s) s[ev.kind]++;
        if (ev.path) { s.lastPath = ev.path; s.lastKind = ev.kind; }
        d.events.push({ t: now, s: ev.session, repo: ev.repo, kind: ev.kind, path: ev.path || '' });
        if (d.events.length > 500) d.events.splice(0, d.events.length - 500);
      }
      await this.state.storage.put('data', d);
      return json({ ok: true });
    }
    const since = Number(new URL(request.url).searchParams.get('since')) || 0;
    return json({ now: Date.now(), events: d.events.filter(e => e.t > since).slice(-200), sessions: Object.values(d.sessions), totals: d.totals });
  }
}

const activityStub = (env) => env.ACTIVITY && env.ACTIVITY.get(env.ACTIVITY.idFromName('all'));

// Hourly: re-map each mapped repository whose newest commit differs from its map's.
async function refreshAll(env) {
  if (!(await setting(env.GITHUB_TOKEN)) || !env.MAPS_REPO) return;
  const idx = await env.ASSETS.fetch(new Request('https://assets.local/maps/index.json'));
  if (!idx.ok) return;
  const { maps = [] } = await idx.json();
  for (const m of maps) {
    if (!m.source) continue;
    const head = await headCommit(env, m.source);
    if (head.error || head.sha === m.commit) continue;
    const res = await startMapping(env, m.source);
    console.log(`refresh ${m.source}: ${res.ok ? 'started' : 'failed ' + res.status}`);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await api(request, env, ctx, url.pathname); }
      catch (e) { return json({ error: 'server', message: String(e).slice(0, 200) }, 500); }
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAll(env));
  },
};

export { parseRepo, passMessage, cleanEvent };
