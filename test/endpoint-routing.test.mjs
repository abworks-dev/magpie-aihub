import test from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/router.mjs';
import { BASE, ORIGIN, settings } from '../src/config.mjs';

const model = 'test-model';
const candidate = (groupId, extra = {}) => ({ groupId, multiplier: 0.1, latency: groupId * 10, ...extra });
const request = (body = {}, headers = {}) => new Request(`${BASE}/responses`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ model, input: 'hello', ...body }),
});
const groupOf = init => Number(init.headers.get('authorization').replace('Bearer route-key-', ''));
const originOf = url => new URL(url).origin;

const MIRROR = 'https://aihub.dog';

function fixture(rows = [candidate(1), candidate(2)], options = {}, respond, dependencies = {}) {
  const calls = [];
  const account = {
    data: { mode: 'manual', keys: rows.map(c => ({ groupId: c.groupId, key: `route-key-${c.groupId}` })) },
    catalogue: async () => rows,
    keyFor: async c => ({ groupId: c.groupId, key: `route-key-${c.groupId}` }),
    modelIds: async () => [model],
  };
  const fetcher = async (url, init) => { calls.push({ url, init, group: groupOf(init) }); return respond(url, init); };
  const router = new Router(account, settings(options), { fetcher, ...dependencies });
  return { router, calls };
}

test('a transport failure fails over to the next endpoint and reports the success', async () => {
  const { router, calls } = fixture([candidate(1)], { endpoints: [{ url: ORIGIN, label: '默认' }, { url: MIRROR, label: '优化' }] },
    async url => { if (originOf(url) === ORIGIN) throw new TypeError('fetch failed'); return new Response('ok'); });
  const response = await router.fetch(request());
  assert.equal(await response.text(), 'ok');
  assert.deepEqual(calls.map(call => originOf(call.url)), [ORIGIN, MIRROR]);
  const report = router.endpoints.report();
  assert.equal(report.find(row => row.url === ORIGIN).failures, 1, 'the dead host is marked');
  assert.equal(report.find(row => row.url === MIRROR).wins, 1);
});

test('an AIHub JSON 503 does not switch endpoints', async () => {
  const { router, calls } = fixture([candidate(1), candidate(2)], { endpoints: [{ url: ORIGIN, label: '默认' }, { url: MIRROR, label: '优化' }] },
    async () => Response.json({ error: { message: 'upstream busy' } }, { status: 503 }));
  const response = await router.fetch(request());
  assert.equal(response.status, 503, 'the backend answer is returned as-is');
  assert.ok(calls.length >= 1);
  assert.equal(new Set(calls.map(call => originOf(call.url))).size, 1, 'a backend 503 is the same on every host');
});

test('a session keeps the endpoint that answered it', async () => {
  const { router, calls } = fixture([candidate(1)], { endpoints: [{ url: ORIGIN, label: '默认' }, { url: MIRROR, label: '优化' }] },
    async url => { if (originOf(url) === ORIGIN) throw new TypeError('ECONNRESET'); return new Response('ok'); });
  await router.fetch(request({}, { 'x-aihub-auto-session': 's1' }));
  await router.fetch(request({}, { 'x-aihub-auto-session': 's1' }));
  assert.deepEqual(calls.map(call => originOf(call.url)), [ORIGIN, MIRROR, MIRROR], 'the second request starts on the warm endpoint');
});

test('spread p2c reorders within the band; off keeps the cheapest first', async () => {
  const rows = [candidate(1), candidate(2), candidate(3)];
  const off = fixture(rows, { spread: 'off', strategy: 'economy' }, async () => new Response('ok'));
  await off.router.fetch(request());
  assert.equal(off.calls[0].group, 1, 'without spreading the best candidate always leads');

  const draws = [0.9, 0.1];
  const p2c = fixture(rows, { spread: 'p2c', strategy: 'economy' }, async () => new Response('ok'), { rng: () => draws.shift() ?? 0 });
  await p2c.router.fetch(request());
  assert.equal(p2c.calls[0].group, 3, 'p2c picks one of the two sampled candidates');
  assert.equal(p2c.calls.length, 1, 'one success ends the request');
});

test('maxInflightPerGroup hides a group that is already busy', () => {
  const { router } = fixture([candidate(1)], { maxInflightPerGroup: 1 });
  assert.equal(router.eligibleGroup({ groupId: 1, multiplier: 0.1 }), true);
  router.inflight.set(1, 1);
  assert.equal(router.eligibleGroup({ groupId: 1, multiplier: 0.1 }), false, 'a busy group leaves the pool');
  router.inflight.delete(1);
  assert.equal(router.eligibleGroup({ groupId: 1, multiplier: 0.1 }), true);
  const unlimited = fixture([candidate(1)], { maxInflightPerGroup: 0 }).router;
  unlimited.inflight.set(1, 99);
  assert.equal(unlimited.eligibleGroup({ groupId: 1, multiplier: 0.1 }), true, 'zero disables the cap');
});
