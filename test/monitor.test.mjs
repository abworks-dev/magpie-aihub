import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { monitorHandler, startMonitor } from '../src/monitor.mjs';

const fixture = () => ({ schemaVersion: 1, generatedAt: '2026-11-16T14:00:00Z', accounts: [{
  label: 'person@example.com', mode: 'auto', sourceUpdatedAt: 123, stale: false,
  email: 'private@example.com', instanceID: 'private-instance', key: 'key-private', token: 'token-private', rawError: 'private-error',
  groups: [{ groupId: 8, name: 'Test group', platform: 'openai', multiplier: 0.1, available: true, passed: true,
    latency: 130, metrics: { successRate: 0.95, cacheHitRate: null, tps: 42, realPrice: undefined, secret: 'metrics-secret' },
    models: ['gpt-test'], eligible: true, reasons: [], hasKey: true, selectedCount: 3, cooldownUntil: 0, lastUsedAt: 456,
    key: 'group-secret', rawError: 'group-error' }],
  routes: [{ platform: 'openai', model: 'gpt-test', groupId: 8, at: 456, outcome: 'success', key: 'route-secret' }],
  keyState: { ready: 1, pending: 0, autoCreateKeys: false, token: 'state-secret' },
}] });
async function setup(t, getSnapshot = async () => fixture()) {
  let calls = 0;
  const server = await startMonitor({ port: 0, getSnapshot: async () => { calls++; return getSnapshot(); } });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const port = server.address().port;
  const get = (path = '/', headers = {}, method = 'GET', body) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const html = await get();
  const token = html.body.match(/name="aihub-monitor-token" content="([A-Za-z0-9_-]+)"/)?.[1];
  return { server, port, get, html, token, calls: () => calls };
}

test('starts an actual loopback server; HTML token and strict sandbox CSP stay out of assets', async t => {
  const h = await setup(t);
  assert.equal(h.server.address().address, '127.0.0.1');
  assert.equal(h.html.status, 200);
  assert.match(h.token, /^[a-f0-9]{64}$/);
  assert.equal(h.html.headers['access-control-allow-origin'], undefined);
  assert.equal(h.html.headers['cross-origin-resource-policy'], undefined);
  assert.equal(h.html.headers['cache-control'], 'no-store');
  assert.equal(h.html.headers['content-security-policy'], "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; form-action 'none'; base-uri 'none'");
  for (const path of ['/monitor.js', '/monitor.css', '/index.html', '/monitor.html']) {
    const response = await h.get(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    if (!path.endsWith('.html')) assert.ok(!response.body.includes(h.token));
  }
  assert.equal(h.calls(), 0, 'loading assets does not read or refresh the provider');
});

test('snapshot is anonymous, whitelisted, finite and null-preserving with no source secrets', async t => {
  const data = fixture();
  data.accounts[0].groups[0].metrics.tps = Infinity;
  data.accounts[0].groups[0].name = 'contact owner@example.com sk-private_secret_key';
  data.accounts[0].groups[0].reasons = ['no_key', '倍率超限', 'token-private_secret_token'];
  const h = await setup(t, async () => data);
  const response = await h.get('/snapshot', { Origin: 'null', 'X-AIHub-Monitor': h.token });
  assert.equal(response.status, 200);
  assert.equal(response.headers['access-control-allow-origin'], 'null');
  assert.equal(response.headers['access-control-allow-credentials'], undefined);
  const result = JSON.parse(response.body);
  const account = result.accounts[0];
  assert.equal(account.label, '账户1');
  assert.equal(result.generatedAt, '2026-11-16T14:00:00.000Z');
  assert.equal(account.mode, 'auto');
  assert.equal(account.groups[0].platform, 'openai');
  assert.deepEqual(account.groups[0].models, ['gpt-test']);
  assert.equal(account.groups[0].name, 'contact [redacted] [redacted]');
  assert.equal(account.routes[0].outcome, 'success');
  assert.deepEqual(Object.keys(result), ['schemaVersion', 'generatedAt', 'accounts']);
  assert.deepEqual(Object.keys(account), ['label', 'mode', 'sourceUpdatedAt', 'stale', 'groups', 'routes', 'keyState']);
  assert.deepEqual(Object.keys(account.groups[0]), ['groupId', 'name', 'platform', 'multiplier', 'available', 'passed', 'latency', 'metrics', 'models', 'eligible', 'reasons', 'hasKey', 'selectedCount', 'cooldownUntil', 'lastUsedAt']);
  assert.deepEqual(account.groups[0].metrics, { successRate: 0.95, cacheHitRate: null, tps: null, realPrice: null });
  assert.equal(account.groups[0].reasons[1], '倍率超限');
  assert.doesNotMatch(response.body, /private|secret|rawError|instanceID|email|@|Bearer|Infinity/);
  assert.equal(h.calls(), 1);
});

test('host, origin, custom token and exact paths reject hostile direct and opaque requests', async t => {
  const h = await setup(t);
  for (const host of ['localhost:' + h.port, 'evil.test:' + h.port, '127.0.0.1:1']) {
    assert.equal((await h.get('/snapshot', { Host: host, 'X-AIHub-Monitor': h.token })).status, 403);
  }
  for (const origin of ['https://evil.test', 'http://127.0.0.1:' + h.port]) {
    assert.equal((await h.get('/', { Origin: origin })).status, 403);
    assert.equal((await h.get('/snapshot', { Origin: origin, 'X-AIHub-Monitor': h.token })).status, 403);
  }
  for (const supplied of [undefined, 'wrong-secret', h.token.slice(1)]) {
    const headers = { Origin: 'null' };
    if (supplied) headers['X-AIHub-Monitor'] = supplied;
    assert.equal((await h.get('/snapshot', headers)).status, 403);
  }
  for (const path of ['/snapshot?token=' + h.token, '/snapshot/', '/../package.json', '//evil.test/', '/proxy?url=https://aihub.top', 'https://evil.test/snapshot']) {
    assert.equal((await h.get(path, { 'X-AIHub-Monitor': h.token })).status, 404);
  }
  assert.equal(h.calls(), 0);
  assert.equal((await h.get('/snapshot', { 'X-AIHub-Monitor': h.token })).status, 200, 'absent Origin is permitted');
});

test('only the exact snapshot preflight gets null-origin CORS and never invokes callback', async t => {
  const h = await setup(t);
  const headers = { Origin: 'null', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-aihub-monitor' };
  const response = await h.get('/snapshot', headers, 'OPTIONS');
  assert.equal(response.status, 204);
  assert.equal(response.headers['access-control-allow-origin'], 'null');
  assert.equal(response.headers['access-control-allow-methods'], 'GET');
  assert.equal(response.headers['access-control-allow-headers'], 'X-AIHub-Monitor');
  assert.equal(response.headers['access-control-allow-credentials'], undefined);
  for (const extra of [{ 'Access-Control-Request-Method': 'POST' }, { 'Access-Control-Request-Headers': 'X-AIHub-Monitor, Authorization' }, { Origin: 'https://evil.test' }]) {
    assert.equal((await h.get('/snapshot', { ...headers, ...extra }, 'OPTIONS')).status, 403);
  }
  assert.equal((await h.get('/', headers, 'OPTIONS')).headers['access-control-allow-origin'], undefined);
  assert.equal(h.calls(), 0);
});

test('no write endpoint or request body can invoke the snapshot supplier', async t => {
  const h = await setup(t);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
    assert.equal((await h.get('/snapshot', { 'X-AIHub-Monitor': h.token }, method)).status, 405);
  }
  assert.equal((await h.get('/snapshot', { 'X-AIHub-Monitor': h.token, 'Content-Length': '1' }, 'GET', 'x')).status, 400);
  assert.equal(h.calls(), 0);
});

test('supplier failures and unsupported schemas expose a fixed actionable safe error', async t => {
  for (const supplier of [async () => { throw new Error('Bearer secret-password owner@example.com'); }, async () => ({ schemaVersion: 2, accounts: [] })]) {
    const h = await setup(t, supplier);
    const response = await h.get('/snapshot', { 'X-AIHub-Monitor': h.token });
    assert.equal(response.status, 503);
    const error = JSON.parse(response.body).error;
    assert.equal(error.code, 'SNAPSHOT_UNAVAILABLE');
    assert.match(error.message, /provider first/);
    assert.doesNotMatch(response.body, /secret-password|Bearer|owner@/);
  }
});

test('caps arrays and strings, handles missing fields, and rejects port collisions', async t => {
  const data = fixture();
  data.accounts[0].groups = Array.from({ length: 1000 }, (_, groupId) => ({ groupId: groupId + 1, name: 'g'.repeat(5000), models: Array(1000).fill('m'), metrics: {} }));
  data.accounts = Array(100).fill(data.accounts[0]);
  const h = await setup(t, async () => data);
  const response = await h.get('/snapshot', { 'X-AIHub-Monitor': h.token });
  assert.equal(response.status, 200);
  assert.ok(Buffer.byteLength(response.body) <= 1024 * 1024);
  const result = JSON.parse(response.body);
  assert.equal(result.accounts.length, 32);
  assert.equal(result.accounts.flatMap(a => a.groups).length, 500);
  assert.equal(result.accounts.flatMap(a => a.groups).flatMap(g => g.models).length, 4000);
  assert.equal(result.accounts[0].groups[0].name.length, 160);
  assert.equal(result.accounts[0].groups[0].available, null);
  await assert.rejects(startMonitor({ port: h.port, getSnapshot: async () => fixture() }), { code: 'EADDRINUSE' });
  assert.throws(() => monitorHandler({ port: -1, getSnapshot() {} }), /port/);
  assert.throws(() => monitorHandler({ port: 0 }), /getSnapshot/);
});

const uiCode = await readFile(new URL('../ui/monitor.js', import.meta.url), 'utf8');
const uiHtml = await readFile(new URL('../ui/monitor.html', import.meta.url), 'utf8');
function dashboard(response = fixture()) {
  const nodes = new Map();
  function node() {
    return { textContent: '', value: 'all', children: [], attrs: {}, handlers: {}, checked: false, hidden: false,
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      setAttribute(name, value) { this.attrs[name] = value; },
      addEventListener(name, handler) { this.handlers[name] = handler; },
    };
  }
  const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  get('search').value = '';
  const events = {};
  const timers = new Map();
  const calls = [];
  let httpStatus = 200;
  const document = { hidden: false, getElementById: get, createElement: node,
    querySelector: () => ({ content: 'test-token-from-meta' }), addEventListener(name, handler) { events[name] = handler; } };
  vm.runInNewContext(uiCode, { document, window: { location: { href: 'https://host/_magpie/plugin/0123456789abcdef0123456789abcdef/_magpie/service/' } }, URL, AbortSignal,
    setTimeout(fn, delay) { const key = {}; timers.set(key, { fn, delay }); return key; }, clearTimeout(key) { timers.delete(key); },
    fetch: async (url, options) => { calls.push({ url: String(url), options }); return { ok: httpStatus === 200, status: httpStatus, json: async () => response }; },
  });
  return { get, document, events, timers, calls, setStatus(status) { httpStatus = status; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('dashboard uses service-relative authenticated read-only fetch and actual six platform tabs', async () => {
  const h = dashboard(); await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, 'https://host/_magpie/plugin/0123456789abcdef0123456789abcdef/_magpie/service/snapshot');
  assert.equal(h.calls[0].options.method, 'GET');
  assert.equal(h.calls[0].options.credentials, 'omit');
  assert.equal(h.calls[0].options.headers['X-AIHub-Monitor'], 'test-token-from-meta');
  assert.deepEqual(h.get('platforms').children.map(n => n.textContent), ['OpenAI', 'DeepSeek', 'Zhipu GLM', 'Kimi', 'Grok', 'Gemini']);
  assert.equal(h.get('groups').children.length, 1);
  assert.equal(h.timers.size, 0, 'automatic refresh defaults off');
  assert.doesNotMatch(uiHtml, /<form\b|<script[^>]*>\s*[^<\s]/i);
  assert.doesNotMatch(uiCode, /innerHTML|aihub\.top|magpie\.(?:read|write|options)/);
});

test('dashboard preserves old snapshot and offers safe actionable refresh failure and recovery', async () => {
  const h = dashboard(); await settle();
  assert.equal(h.get('groups').children.length, 1);
  h.setStatus(503);
  await h.get('refresh').handlers.click();
  assert.equal(h.get('failure').hidden, false);
  assert.match(h.get('failure-message').textContent, /503/);
  assert.match(h.get('status').textContent, /上次成功快照/);
  assert.equal(h.get('groups').children.length, 1);
  assert.equal(h.get('refresh').disabled, false);
  h.setStatus(200);
  await h.get('refresh').handlers.click();
  assert.equal(h.get('failure').hidden, true);
  h.get('search').value = 'not-present';
  h.get('search').handlers.input();
  assert.equal(h.get('groups').children.length, 0);
  assert.match(h.get('empty').textContent, /筛选条件/);
});

test('dashboard automatic reads run at 30 seconds only when visible; empty account is explicit', async () => {
  const h = dashboard({ schemaVersion: 1, generatedAt: 123, accounts: [] }); await settle();
  assert.match(h.get('empty').textContent, /先刷新或加载/);
  h.get('auto').checked = true;
  h.get('auto').handlers.change();
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].delay, 30_000);
  h.document.hidden = true;
  h.events.visibilitychange();
  assert.equal(h.timers.size, 0);
  h.document.hidden = false;
  h.events.visibilitychange();
  assert.equal(h.timers.size, 1);
  h.get('auto').checked = false;
  h.get('auto').handlers.change();
  assert.equal(h.timers.size, 0);
});
