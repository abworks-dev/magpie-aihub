import test from 'node:test';
import assert from 'node:assert/strict';
import { EndpointPool, parseEndpoints, DEFAULT_ENDPOINTS, MAX_ENDPOINTS } from '../src/endpoints.mjs';

test('parseEndpoints normalizes origins, dedupes and rejects junk', () => {
  const rows = parseEndpoints([
    { url: 'https://aihub.top/', label: '默认' },
    'https://aihub.dog/v1',
    { url: 'https://AIHUB.top' },
  ]);
  assert.deepEqual(rows, [{ url: 'https://aihub.top', label: '默认' }, { url: 'https://aihub.dog', label: 'aihub.dog' }]);
  assert.deepEqual(parseEndpoints(undefined), DEFAULT_ENDPOINTS.map(row => ({ ...row })));
  assert.throws(() => parseEndpoints([]), /non-empty/);
  assert.throws(() => parseEndpoints('https://aihub.top'), /array/);
  assert.throws(() => parseEndpoints([{ url: 'ftp://aihub.top' }]), /http/);
  assert.throws(() => parseEndpoints([{ url: 'not a url' }]), /invalid endpoint/);
  assert.throws(() => parseEndpoints(new Array(MAX_ENDPOINTS + 1).fill('https://a.example')), /at most/);
});

test('the pool keeps the sticky endpoint first while it is healthy and demotes cooling ones', () => {
  let now = 1000;
  const pool = new EndpointPool([{ url: 'https://a', label: 'a' }, { url: 'https://b', label: 'b' }, { url: 'https://c', label: 'c' }],
    { cooldownMs: 500, now: () => now });
  pool.praise('https://a', 200);
  pool.praise('https://b', 50);
  assert.deepEqual(pool.order(), ['https://b', 'https://a', 'https://c'], 'fastest warm endpoint leads without a preference');
  assert.deepEqual(pool.order('https://a'), ['https://a', 'https://b', 'https://c'], 'the session endpoint stays in front');
  pool.penalize('https://a');
  assert.deepEqual(pool.order('https://a'), ['https://b', 'https://c', 'https://a'], 'a cooling endpoint drops to the back');
  now += 501;
  assert.deepEqual(pool.order(), ['https://b', 'https://a', 'https://c'], 'and returns once its cooldown lapses');
  const report = pool.report();
  assert.equal(report.find(row => row.url === 'https://a').failures, 1);
  assert.equal(report.find(row => row.url === 'https://a').ok, true);
});

test('balance picks among healthy endpoints only and honours the latency weight', () => {
  const pool = new EndpointPool([{ url: 'https://a', label: 'a' }, { url: 'https://b', label: 'b' }], { cooldownMs: 500, now: () => 1000 });
  pool.praise('https://a', 100);
  pool.praise('https://b', 100);
  pool.penalize('https://a');
  assert.equal(pool.pick(undefined, () => 0), 'https://b', 'a cooling endpoint is never picked');
  assert.equal(pool.pick(['https://a'], () => 0), 'https://a', 'the only remaining candidate is returned even while cooling');
});

test('only an edge response is worth another endpoint', () => {
  assert.equal(EndpointPool.isEdgeResponse(503, 'application/json'), false, 'AIHub JSON 503 is a backend answer');
  assert.equal(EndpointPool.isEdgeResponse(429, 'application/json; charset=utf-8'), false);
  assert.equal(EndpointPool.isEdgeResponse(401, 'application/json'), false);
  assert.equal(EndpointPool.isEdgeResponse(502, 'text/html'), true, 'a gateway page is the edge');
  assert.equal(EndpointPool.isEdgeResponse(504, ''), true);
  assert.equal(EndpointPool.isEdgeResponse(200, 'text/html'), true, 'a hijacked HTML body is the edge too');
});
