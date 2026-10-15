/* MyBrain web app server (Cloudflare Worker).
 *
 * Serves the static app, plus two small endpoints behind the "+" button:
 *   POST /api/add     {repo: "owner/name"}  -> starts the "Add a map" workflow
 *                                              in your maps repository
 *   GET  /api/status                          -> the latest mapping runs
 *
 * Who may use them: anyone who passed Cloudflare Access (when Access is on),
 * or whoever sends the right "MyBrain key" (the ADD_KEY secret). Nobody else.
 *
 * Settings (Cloudflare → the mybrain Worker → Settings → Variables and Secrets):
 *   GITHUB_TOKEN (secret)  fine-grained token: only mybrain-maps, Actions read+write
 *   ADD_KEY      (secret)  optional passphrase, needed when Access is off
 *   MAPS_REPO    (text)    owner/repo of the maps repository (set in wrangler.jsonc)
 */
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

function allowed(request, env, ctx) {
  if (ctx && ctx.access) return true;                       // signed in through Access
  const key = request.headers.get('x-mybrain-key') || '';
  return Boolean(env.ADD_KEY && key && timingSafeEqual(key, env.ADD_KEY));
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
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'mybrain-app',
      ...(init.headers || {}),
    },
  });
}

async function api(request, env, ctx, path) {
  if (!allowed(request, env, ctx)) {
    return json({ error: 'locked', needKey: Boolean(env.ADD_KEY) }, 401);
  }
  if (!env.GITHUB_TOKEN || !env.MAPS_REPO) {
    return json({ error: 'not-set-up', message: 'Add the GITHUB_TOKEN secret to the mybrain Worker first.' }, 503);
  }
  const wf = `/repos/${env.MAPS_REPO}/actions/workflows/add-map.yml`;

  if (path === '/api/add' && request.method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) { /* empty body */ }
    const repo = parseRepo(body.repo);
    if (!repo) return json({ error: 'bad-repo', message: 'Use owner/name, e.g. Vicevinnybeats/GNARL' }, 400);
    const r = await gh(env, `${wf}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref: 'main', inputs: { repo } }),
    });
    if (r.status !== 204) {
      return json({ error: 'github', status: r.status, message: (await r.text()).slice(0, 300) }, 502);
    }
    return json({ ok: true, repo });
  }

  if (path === '/api/status' && request.method === 'GET') {
    const r = await gh(env, `${wf}/runs?per_page=8`);
    if (!r.ok) return json({ error: 'github', status: r.status }, 502);
    const data = await r.json();
    return json({
      runs: (data.workflow_runs || []).map(w => ({
        title: w.display_title, status: w.status, conclusion: w.conclusion,
        created: w.created_at, updated: w.updated_at,
      })),
    });
  }
  return json({ error: 'not-found' }, 404);
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
};

export { parseRepo };
