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
async function setting(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v.get === 'function') { try { return (await v.get()) || ''; } catch (e) { return ''; } }
  return '';
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
    return json({
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

export { parseRepo, passMessage };
