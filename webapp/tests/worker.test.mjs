// Tests for webapp/worker.js against a fake GitHub: node webapp/tests/worker.test.mjs
import assert from 'node:assert/strict';
import worker from '../worker.js';

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
const env = {
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

// hourly refresh: only Cardly changed (GNARL same commit; 'old' has no source)
calls.length = 0;
const pending = [];
await worker.scheduled({}, env, { waitUntil: p => pending.push(p) });
await Promise.all(pending);
const refreshed = calls.filter(c => c.url.endsWith('/dispatches')).map(c => JSON.parse(c.init.body).inputs.repo);
assert.deepEqual(refreshed, ['Vicevinnybeats/Cardly']);
console.log('worker tests: all passed');
