import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startService, serviceHandler, snapshotView } from '../src/service.mjs';

function call(handler, { method = 'GET', path = '/', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      const request = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => { server.close(); resolve({ status: response.statusCode, headers: response.headers, text }); });
      });
      request.on('error', error => { server.close(); reject(error); });
      request.end(body);
    });
  });
}

const snapshot = () => ({
  schemaVersion: 1,
  generatedAt: Date.now(),
  accounts: [{
    label: 'account one', mode: 'managed', sourceUpdatedAt: Date.now(), stale: false,
    groups: [{
      groupId: 7, name: 'Fixture group', platform: 'openai', multiplier: 0.08, available: true,
      passed: null, latency: null, metrics: { successRate: 0.99, cacheHitRate: null, tps: 42, realPrice: null },
      models: ['exact-fixture'], eligible: true, reasons: [], hasKey: true, selectedCount: 1,
      cooldownUntil: null, lastUsedAt: null,
    }],
    routes: [{ platform: 'openai', model: 'exact-fixture', groupId: 7, at: Date.now(), outcome: 'selected' }],
    keyState: { ready: 1, pending: 0, autoCreateKeys: false },
  }],
});

const TOKEN = 'test-token';
const AUTH = { 'x-aihub-service-token': TOKEN };
const handler = (extra = {}) => serviceHandler({ port: 0, token: TOKEN, getSnapshot: async () => snapshot(), ...extra });

test('the page service serves the one app document with the service bridge path', async () => {
  const response = await call(handler(), { path: '/' });
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.match(response.text, /id="options-form"/);
  assert.match(response.text, /id="view-monitor"/);
  assert.match(response.text, /src="\.\.\/bridge\.js"/, 'a service-served document loads the bridge one directory up');
  assert.doesNotMatch(response.text, /src="_magpie\/bridge\.js"/);
  assert.match(response.text, /name="aihub-service-token" content="test-token"/, 'the served copy carries the snapshot token');
  assert.doesNotMatch(response.text, /__AIHUB_SERVICE_TOKEN__/);
  const csp = response.headers['content-security-policy'];
  assert.match(csp, /connect-src 'self'/, 'the app fetches its own snapshot');
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
});

test('assets are the same files Magpie serves and unknown paths stay 404', async () => {
  for (const [path, type] of [['/app.js', /javascript/], ['/style.css', /text\/css/]]) {
    const response = await call(handler(), { path });
    assert.equal(response.status, 200, path);
    assert.match(response.headers['content-type'], type);
    assert.ok(response.text.length > 500, `${path} must not be empty`);
  }
  const unknown = await call(handler(), { path: '/../package.json' });
  assert.equal(unknown.status, 404);
  assert.equal(JSON.parse(unknown.text).error.code, 'NOT_FOUND');
});

test('the snapshot is sanitized, projects null for missing metrics and leaves no account identity', async () => {
  const response = await call(handler(), { path: '/snapshot', headers: AUTH });
  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.equal(body.accounts[0].label, '账户1');
  assert.equal(body.accounts[0].groups[0].passed, null);
  assert.equal(body.accounts[0].groups[0].metrics.cacheHitRate, null);
  assert.equal(body.accounts[0].groups[0].metrics.realPrice, null);
  assert.equal(body.accounts[0].groups[0].metrics.successRate, 0.99);
  assert.equal(body.accounts[0].keyState.ready, 1);
  assert.ok(!response.text.includes('account one'));
});

test('masked labels pass through while full identities stay behind the page token', async () => {
  const masked = snapshot();
  masked.accounts[0].label = 'ab***@example.test';
  assert.equal(JSON.parse(snapshotView(masked)).accounts[0].label, 'ab***@example.test');
  const raw = snapshot();
  raw.accounts[0].label = 'user@example.com';
  assert.equal(JSON.parse(snapshotView(raw)).accounts[0].label, '账户1', 'only the masked shape survives');

  const withIds = handler({ getIdentities: async () => ['someone@example.com', 'bad value with spaces', 'admin'] });
  const denied = await call(withIds, { path: '/identity' });
  assert.equal(denied.status, 403);
  assert.equal(JSON.parse(denied.text).error.code, 'TOKEN_REJECTED');
  const ok = await call(withIds, { path: '/identity', headers: AUTH });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.text).identities, ['someone@example.com', '', 'admin']);
  const none = await call(handler(), { path: '/identity', headers: AUTH });
  assert.deepEqual(JSON.parse(none.text).identities, []);
});

test('only the page itself may ask: host, origin, token, method, body and path guards', async () => {
  const host = await call(handler(), { path: '/snapshot', headers: { ...AUTH, host: 'evil.example' } });
  assert.equal(host.status, 403);
  assert.equal(JSON.parse(host.text).error.code, 'HOST_REJECTED');

  const origin = await call(handler(), { path: '/snapshot', headers: { ...AUTH, origin: 'https://evil.example' } });
  assert.equal(origin.status, 403);
  assert.equal(JSON.parse(origin.text).error.code, 'ORIGIN_REJECTED');

  const sandboxed = await call(handler(), { path: '/snapshot', headers: { ...AUTH, origin: 'null' } });
  assert.equal(sandboxed.status, 200, 'the sandboxed frame sends Origin: null');
  assert.equal(sandboxed.headers['access-control-allow-origin'], 'null');

  const unauthenticated = await call(handler(), { path: '/snapshot', headers: { origin: 'null' } });
  assert.equal(unauthenticated.status, 403, 'without the injected token another frame cannot read the snapshot');
  assert.equal(JSON.parse(unauthenticated.text).error.code, 'TOKEN_REJECTED');
  const wrong = await call(handler(), { path: '/snapshot', headers: { 'x-aihub-service-token': 'nope' } });
  assert.equal(wrong.status, 403);

  const preflight = await call(handler(), {
    method: 'OPTIONS', path: '/snapshot',
    headers: { origin: 'null', 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-aihub-service-token' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-headers'], 'x-aihub-service-token');
  const badPreflight = await call(handler(), {
    method: 'OPTIONS', path: '/snapshot',
    headers: { origin: 'null', 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-anything-else' },
  });
  assert.equal(badPreflight.status, 403);

  const post = await call(handler(), { method: 'POST', path: '/snapshot', headers: { 'content-length': '0' } });
  assert.equal(post.status, 405);

  const body = await call(handler(), { method: 'POST', path: '/snapshot', headers: { 'content-length': '2' }, body: '{}' });
  assert.equal(body.status, 400);
  assert.equal(JSON.parse(body.text).error.code, 'BODY_REJECTED');

  const head = await call(handler(), { method: 'HEAD', path: '/' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
});

test('a failed snapshot read stays a safe code, never an upstream error', async () => {
  const response = await call(serviceHandler({ port: 0, token: TOKEN, getSnapshot: async () => { throw new Error('PRIVATE upstream detail'); } }), { path: '/snapshot', headers: AUTH });
  assert.equal(response.status, 503);
  assert.equal(JSON.parse(response.text).error.code, 'SNAPSHOT_UNAVAILABLE');
  assert.ok(!response.text.includes('PRIVATE'));
});

test('the sanitizer bounds accounts, groups and models and redacts contact-shaped text', () => {
  const view = JSON.parse(snapshotView({
    schemaVersion: 1, generatedAt: new Date().toISOString(), accounts: [{
      mode: 'managed', stale: true,
      groups: Array.from({ length: 260 }, (_, index) => ({
        groupId: index + 1, name: `name-${index} someone@example.invalid`,
        platform: 'openai', multiplier: 0.1, available: null, passed: true, latency: null,
        metrics: {}, models: Array.from({ length: 210 }, (_, model) => `model-${model}`), eligible: false,
        reasons: ['超过倍率上限'], hasKey: false, selectedCount: null,
      })),
      routes: Array.from({ length: 140 }, (_, index) => ({ platform: 'openai', model: 'm', groupId: index + 1, at: Date.now(), outcome: 'selected' })),
      keyState: { ready: 0, pending: 1, autoCreateKeys: true, maxKeysPerAccount: 9, minBalance: 3 },
      billing: {
        at: Date.now(), balance: 12.5, frozen: 0, recharged: 20, notify: { enabled: true, threshold: 2, kind: 'fixed' },
        usage: { requests: 5, tokens: 100, cost: 1, actualCost: 0.9 },
        platforms: Array.from({ length: 14 }, () => ({ platform: 'openai', dailyLimit: null, dailyUsage: 0.1, weeklyLimit: null, weeklyUsage: null, monthlyLimit: 9, monthlyUsage: 1 })),
      },
      billingError: 'billing_unavailable',
      keyEvents: [{ at: Date.now(), action: 'created', groupId: 1, code: 'created' }],
    }],
  }));
  assert.equal(view.accounts.length, 1);
  assert.equal(view.accounts[0].groups.length, 250);
  assert.equal(view.accounts[0].groups[0].models.length, 200);
  assert.equal(view.accounts[0].routes.length, 100);
  assert.ok(!view.accounts[0].groups[0].name.includes('@'));
  assert.equal(view.accounts[0].groups[0].metrics.successRate, null);
  assert.equal(view.accounts[0].stale, true);
  assert.equal(view.accounts[0].billing.platforms.length, 12);
  assert.equal(view.accounts[0].billingError, 'billing_unavailable');
  assert.equal(view.accounts[0].keyEvents.length, 1);
  assert.equal(view.accounts[0].keyState.maxKeysPerAccount, 9);
});

test('the service binds once on loopback and rejects a second listener on the same port', async () => {
  const first = await startService({ port: 0, token: TOKEN, getSnapshot: async () => snapshot() });
  const port = first.address().port;
  assert.equal(first.address().address, '127.0.0.1');
  await assert.rejects(() => startService({ port, token: TOKEN, getSnapshot: async () => snapshot() }), /cannot listen/);
  const response = await fetch(`http://127.0.0.1:${port}/snapshot`, { headers: AUTH });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).accounts.length, 1);
  await new Promise(resolve => first.close(resolve));
});

test('a re-imported copy adopts the running listener instead of failing on the port', async () => {
  const probe = await startService({ port: 0, token: TOKEN, getSnapshot: async () => snapshot() });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const first = await startService({ port, token: TOKEN, getSnapshot: async () => snapshot() });
  const reloaded = await import('../src/service.mjs?reload=1');
  const adopted = await reloaded.startService({ port, token: TOKEN, getSnapshot: async () => snapshot() });
  assert.equal(adopted, first, 'the new copy reuses the listener from the previous copy');
  const response = await fetch(`http://127.0.0.1:${port}/snapshot`, { headers: AUTH });
  assert.equal(response.status, 200);
  await new Promise(resolve => first.close(resolve));
});

test('a plugin factory that starts twice reuses its own listener instead of failing', async () => {
  const probe = await startService({ port: 0, token: TOKEN, getSnapshot: async () => snapshot() });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const claimed = await startService({ port, token: TOKEN, getSnapshot: async () => snapshot() });
  const again = await startService({ port, token: TOKEN, getSnapshot: async () => snapshot() });
  assert.equal(again, claimed, 'the second factory gets the running listener');
  const response = await fetch(`http://127.0.0.1:${port}/snapshot`, { headers: AUTH });
  assert.equal(response.status, 200, 'the reused listener still serves the snapshot');
  await new Promise(resolve => claimed.close(resolve));
  const rebound = await startService({ port, token: TOKEN, getSnapshot: async () => snapshot() });
  assert.notEqual(rebound, claimed, 'a closed listener is not reused');
  await new Promise(resolve => rebound.close(resolve));
});

test('the handler requires a snapshot supplier, a usable port and a well-formed token', () => {
  assert.throws(() => serviceHandler({ port: 0 }), /getSnapshot/);
  assert.throws(() => serviceHandler({ port: 70000, getSnapshot: async () => snapshot() }), /port/);
  assert.throws(() => serviceHandler({ port: 0, token: 'bad token!', getSnapshot: async () => snapshot() }), /token/);
  assert.throws(() => snapshotView({ schemaVersion: 2, accounts: [] }), /INVALID_SNAPSHOT/);
});
