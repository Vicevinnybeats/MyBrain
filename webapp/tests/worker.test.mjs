// Tests for webapp/worker.js against a fake GitHub: node webapp/tests/worker.test.mjs
import assert from 'node:assert/strict';
import worker, { Activity } from '../worker.js';

const SHA_OLD = 'a'.repeat(40), SHA_NEW = 'b'.repeat(40);
const calls = [];
const heads = { 'Vicevinnybeats/GNARL': SHA_OLD, 'Vicevinnybeats/Cardly': SHA_NEW };
globalThis.fetch = async (url, init = {}) => {
  url = String(url); calls.push({ url, init });
  let m;
  if ((m = url.match(/\/repos\/([^/]+\/[^/]+)\/commits\/HEAD$/))) return new Response(heads[m[1]] || '', { status: heads[m[1]] ? 200 : 404 });
  if (url.includes('/actions/workflows/add-map.yml/dispatches')) return new Response(null, { status: 204 });
  if (url.includes('/actions/workflows/remove-map.yml/dispatches')) return new Response(null, { status: 204 });
  if ((m = url.match(/\/repos\/([^/]+\/[^/]+)\/tarball\/([0-9a-f]{40})$/))) return new Response('TARBALL:' + m[1] + '@' + m[2]);
  if (url.includes('/user/repos')) return Response.json([{ full_name: 'Vicevinnybeats/Cardly', private: true, pushed_at: '2026-10-16T00:00:00Z' },
                                                          { full_name: 'Vicevinnybeats/mybrain-maps', private: true, pushed_at: '2026-10-16T00:00:00Z' }]);
  return new Response('unexpected ' + url, { status: 500 });
};
const index = { maps: [{ name: 'gnarl', commit: SHA_OLD, source: 'Vicevinnybeats/GNARL' },
                       { name: 'cardly', commit: SHA_OLD, source: 'Vicevinnybeats/Cardly' },
                       { name: 'old', commit: SHA_OLD }] };
const store = new Map();
const activity = new Activity({ storage: { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, structuredClone(v)); } } });
const env = {
  ACTIVITY: { idFromName: () => 'all', get: () => ({ fetch: (r) => activity.fetch(r) }) },
  GITHUB_TOKEN: { get: async () => 'tok' }, ADD_KEY: 'k', MAPS_REPO: 'Vicevinnybeats/mybrain-maps',
  ASSETS: { fetch: async () => Response.json(index) },
};
const req = (path, opts = {}) => worker.fetch(new Request('https://app.test' + path, opts), env, {});

// locked without key
assert.equal((await req('/api/repos')).status, 401);
// repo list, without the maps repo itself
const repos = await (await req('/api/repos', { headers: { 'x-mybrain-key': 'k' } })).json();
assert.deepEqual(repos.repos.map(r => r.repo), ['Vicevinnybeats/Cardly']);

// a dead token is explained, not just a number
{
  const ok = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes('/user/repos') ? new Response('Bad credentials', { status: 401 }) : ok(url);
  const dead = await req('/api/repos', { headers: { 'x-mybrain-key': 'k' } });
  assert.equal(dead.status, 502); assert.match((await dead.json()).message, /token/);
  globalThis.fetch = ok;
}

// add: dispatch carries repo, head sha and a pass
calls.length = 0;
const add = await req('/api/add', { method: 'POST', headers: { 'x-mybrain-key': 'k' }, body: JSON.stringify({ repo: 'https://github.com/Vicevinnybeats/Cardly' }) });
assert.equal(add.status, 200);
const disp = calls.find(c => c.url.endsWith('/dispatches'));
const inputs = JSON.parse(disp.init.body).inputs;
assert.equal(inputs.repo, 'Vicevinnybeats/Cardly'); assert.equal(inputs.sha, SHA_NEW);
assert.match(inputs.sig, /^[0-9a-f]{64}$/);

// the pass downloads exactly that commit, no key needed
const q = (o) => '/api/archive?' + new URLSearchParams(o);
let r = await req(q(inputs));
assert.equal(r.status, 200); assert.equal(await r.text(), `TARBALL:Vicevinnybeats/Cardly@${SHA_NEW}`);
// tampered repo / sha / signature, and an expired pass, are refused
assert.equal((await req(q({ ...inputs, repo: 'Vicevinnybeats/GNARL' }))).status, 403);
assert.equal((await req(q({ ...inputs, sha: SHA_OLD }))).status, 403);
assert.equal((await req(q({ ...inputs, sig: '0'.repeat(64) }))).status, 403);
assert.equal((await req(q({ ...inputs, ts: String(Date.now() - 31 * 60000) }))).status, 403);
assert.equal((await req(q({ ...inputs, sha: 'nothex' }))).status, 400);

// delete: needs the key, a plain map name, and starts "Remove a map" with it
const rm = (body, key = 'k') => req('/api/remove', { method: 'POST', headers: key ? { 'x-mybrain-key': key } : {}, body: JSON.stringify(body) });
assert.equal((await rm({ name: 'cardly' }, '')).status, 401);
for (const bad of ['../x', 'a/b', '', '..', 'Cardly', 'x y']) assert.equal((await rm({ name: bad })).status, 400, bad);
calls.length = 0;
assert.equal((await rm({ name: 'cardly' })).status, 200);
const rmCall = calls.find(c => c.url.includes('/remove-map.yml/dispatches'));
assert.ok(rmCall.url.includes('/repos/Vicevinnybeats/mybrain-maps/'));
assert.deepEqual(JSON.parse(rmCall.init.body), { ref: 'main', inputs: { name: 'cardly' } });

// live activity: open to send (shaped and limited), key to read
const post = (b) => req('/api/activity', { method: 'POST', body: JSON.stringify(b) });
assert.equal((await post({ session: 'abc123', repo: 'Vicevinnybeats/GNARL', kind: 'read', path: 'src/a.cpp' })).status, 200);
assert.equal((await post({ session: 'abc123', repo: 'Vicevinnybeats/GNARL', kind: 'write', path: 'src/a.cpp' })).status, 200);
assert.equal((await post({ session: 'abc123', repo: 'Vicevinnybeats/GNARL', kind: 'tokens', tokens: { input: 5, output: 7, cache: 'x' } })).status, 200);
for (const bad of [{ session: 'a b', repo: 'x', kind: 'read' }, { session: 's', repo: '../x', kind: 'read' },
                   { session: 's', repo: 'x', kind: 'delete' }, { session: 's', repo: 'x', kind: 'read', path: 'a\nb' },
                   { session: 's', repo: 'x', kind: 'read', path: 'p'.repeat(301) }])
  assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
assert.equal((await req('/api/activity', { method: 'POST', body: 'x'.repeat(3000) })).status, 413);
assert.equal((await req('/api/activity')).status, 401);
const feed = await (await req('/api/activity', { headers: { 'x-mybrain-key': 'k' } })).json();
assert.deepEqual(feed.events.map(e => [e.kind, e.path]), [['read', 'src/a.cpp'], ['write', 'src/a.cpp']]);
const ses = feed.sessions[0];
assert.equal(ses.read, 1); assert.equal(ses.write, 1); assert.deepEqual(ses.tokens, { input: 5, output: 7, cache: 0 });
assert.equal(ses.lastPath, 'src/a.cpp');
const later = await (await req('/api/activity?since=' + (Date.now() + 1000), { headers: { 'x-mybrain-key': 'k' } })).json();
assert.equal(later.events.length, 0);
// map questions: tokens saved add up per session and all time
assert.equal((await post({ session: 'abc123', repo: 'Vicevinnybeats/GNARL', kind: 'ask', tokens: { used: 900, saved: 12000, files: 7 } })).status, 200);
assert.equal((await post({ session: 'abc123', repo: 'Vicevinnybeats/GNARL', kind: 'ask', tokens: { used: 500, saved: 3000, files: 2 } })).status, 200);
const asked = await (await req('/api/activity', { headers: { 'x-mybrain-key': 'k' } })).json();
assert.equal(asked.sessions.find(x => x.id === 'abc123').saved, 15000);
assert.deepEqual([asked.totals.asks, asked.totals.saved], [2, 15000]);
assert.equal(asked.events.filter(e => e.kind === 'ask').length, 2);

// rate limit: one session can't flood the feed
let limited = 0;
for (let k = 0; k < 130; k++) if ((await post({ session: 'flood', repo: 'x', kind: 'read', path: 'a' })).status === 429) limited++;
assert.ok(limited >= 9, 'rate limit');

// hourly refresh: only Cardly changed (GNARL same commit; 'old' has no source)
calls.length = 0;
const pending = [];
await worker.scheduled({}, env, { waitUntil: p => pending.push(p) });
await Promise.all(pending);
const refreshed = calls.filter(c => c.url.endsWith('/dispatches')).map(c => JSON.parse(c.init.body).inputs.repo);
assert.deepEqual(refreshed, ['Vicevinnybeats/Cardly']);
console.log('worker tests: all passed');
