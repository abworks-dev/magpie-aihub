import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const code = await readFile(new URL('../ui/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');

function harness({ options = {}, failSave = false, withBridge = true, service = '', fetchImpl = null, pathname = '/_magpie/plugin/tok/index.html', token = null } = {}) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) {
      nodes.set(id, { value: '', textContent: '', innerHTML: '', checked: false, disabled: false, hidden: false,
        className: '', attrs: {}, handlers: {},
        setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
        addEventListener(k, fn) { this.handlers[k] = fn; }, focus() {}, querySelectorAll() { return []; },
      });
    }
    return nodes.get(id);
  };
  const calls = { navigated: undefined, fetch: [] };
  const context = {
    document: {
      getElementById: node,
      querySelector: selector => (selector === 'meta[name="aihub-service-token"]' && token ? { content: token } : null),
    },
    setTimeout, clearTimeout, console, URL,
    location: { href: `https://magpie.example${pathname}`, pathname, replace: url => { calls.navigated = url; } },
    fetch: async url => {
      calls.fetch.push(String(url));
      if (fetchImpl) return fetchImpl(url);
      throw new TypeError('Failed to fetch');
    },
  };
  if (withBridge) context.magpie = {
    service, ready: Promise.resolve({}), read: async () => [],
    options: { get: async () => options, set: async value => { if (failSave) throw new Error('Host save rejected'); calls.saved = value; } },
  };
  vm.runInNewContext(code, context);
  return {
    node, calls,
    saved: () => calls.saved,
    clickSave: () => {
      const click = node('save-button').handlers.click;
      assert.equal(typeof click, 'function', 'the visible Save button must handle clicks directly');
      return click({ type: 'click', target: node('save-button') });
    },
    clickTab: name => node(`tab-${name}`).handlers.click(),
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const snapshot = {
  schemaVersion: 1, generatedAt: Date.now(),
  accounts: [{
    label: '账户1', mode: 'managed', sourceUpdatedAt: Date.now(), stale: false,
    groups: [{ groupId: 7, name: 'Fixture group', platform: 'openai', multiplier: 0.08, available: true, passed: true, latency: 250,
      metrics: { successRate: 0.99, cacheHitRate: 0.5, tps: 42, realPrice: null }, models: ['exact-fixture'], eligible: true,
      reasons: [], hasKey: true, selectedCount: 1, cooldownUntil: null, lastUsedAt: Date.now() }],
    routes: [{ platform: 'openai', model: 'exact-fixture', groupId: 7, at: Date.now(), outcome: 'selected' }],
    keyState: { ready: 1, pending: 0, autoCreateKeys: false },
  }],
};

test('the sandbox gets one declarative page without native forms', () => {
  assert.doesNotMatch(html, /<\/?form\b/i, 'the sandbox does not allow native forms');
  assert.match(html, /<div\b[^>]*id="options-form"[^>]*role="group"/);
  assert.match(html, /<section\b[^>]*id="view-monitor"/, 'the monitor is part of the plugin page');
  assert.doesNotMatch(html, /monitorEnabled/, 'the service is the page now, so there is no monitor toggle');
  const button = html.match(/<button\b[^>]*id="save-button"[^>]*>/i)?.[0];
  assert.ok(button, 'the page must expose a Save button');
  assert.match(button, /\btype="button"/);
});

test('settings load and save model IDs, CSV groups and recognized metadata only', async () => {
  const h = harness({ options: { models: [{ id: 'model-one', api: 'chat', context: 4096 }, { id: 'model-two', api: 'responses' }], refreshMs: 12345, accidentalSecret: 'must-not-persist' } });
  await settle();
  assert.equal(h.node('models').value, 'model-one|chat\nmodel-two|responses');
  assert.equal(h.node('controls').disabled, false);
  h.node('allowedGroups').value = '10, 20';
  h.node('maxMultiplier').value = '0';
  for (const id of ['maxAttempts', 'poolSize', 'monitorPort']) h.node(id).value = String(h.node(id).value);
  await h.clickSave();
  assert.ok(h.saved(), h.node('status').textContent);
  assert.deepEqual(Array.from(h.saved().allowedGroups), [10, 20]);
  assert.equal(h.saved().maxMultiplier, 0);
  assert.equal(h.saved().models[0].context, 4096);
  assert.equal(h.saved().refreshMs, 12345);
  assert.equal(h.saved().accidentalSecret, undefined);
  assert.equal(h.saved().monitorEnabled, undefined, 'the deprecated toggle is not written back');
  assert.equal(h.saved().monitorPort, 19871);
});

test('malformed group IDs are refused before any save', async () => {
  const h = harness(); await settle();
  for (const id of ['maxAttempts', 'poolSize', 'maxMultiplier', 'monitorPort']) h.node(id).value = String(h.node(id).value);
  h.node('excludedGroups').value = '2, -3';
  await h.clickSave();
  assert.equal(h.saved(), undefined);
  assert.equal(h.node('excludedGroups').attrs['aria-invalid'], 'true');
});

test('a failed or missing bridge keeps the page honest', async () => {
  const h = harness({ failSave: true }); await settle();
  for (const id of ['maxAttempts', 'poolSize', 'maxMultiplier', 'monitorPort']) h.node(id).value = String(h.node(id).value);
  await h.clickSave();
  assert.equal(h.node('controls').disabled, false);
  assert.match(h.node('status').textContent, /保存未确认/);
  const missing = harness({ withBridge: false });
  await settle();
  assert.match(missing.node('status').textContent, /未找到 Magpie/);
  assert.equal(missing.node('save-button').disabled, true);
});

test('six platforms, canonical model limits and the service port survive a save', async () => {
  const h = harness({ options: { platforms: ['gemini', 'deepseek'], monitorPort: 23123,
    models: [{ id: 'gemini-2.5-pro', platform: 'gemini', api: 'gemini', context: 100000, output: 8192 }] } });
  await settle();
  assert.equal(h.node('models').value, 'gemini::gemini-2.5-pro|gemini');
  assert.equal(h.node('platform-openai').checked, false);
  assert.equal(h.node('monitorPort').value, '23123');
  h.node('models').value += '\ndeepseek::deepseek-chat|chat';
  for (const id of ['maxAttempts', 'poolSize', 'maxMultiplier']) h.node(id).value = String(h.node(id).value);
  await h.clickSave();
  assert.ok(h.saved(), h.node('status').textContent);
  assert.deepEqual(Array.from(h.saved().platforms), ['deepseek', 'gemini']);
  assert.equal(h.saved().monitorPort, 23123);
  assert.equal(h.saved().models[0].context, 100000);
  assert.equal(h.saved().models[0].output, 8192);
  assert.equal(h.saved().models[1].id, 'deepseek::deepseek-chat');
});

test('cross-platform protocols and an empty platform selection are refused', async () => {
  for (const value of ['gemini::model|chat', 'deepseek::model|gemini', 'unknown::model|responses']) {
    const h = harness(); await settle(); h.node('models').value = value;
    await h.clickSave(); assert.equal(h.saved(), undefined, value);
    assert.equal(h.node('models').attrs['aria-invalid'], 'true');
  }
  const h = harness(); await settle();
  for (const platform of ['openai', 'deepseek', 'zhipu', 'kimi', 'grok', 'gemini']) h.node(`platform-${platform}`).checked = false;
  await h.clickSave(); assert.equal(h.saved(), undefined);
});

test('the monitor tab opens the plugin service instead of a second page', async () => {
  const service = '_magpie/service/';
  const h = harness({ service }); await settle();
  h.clickTab('monitor');
  assert.equal(h.calls.navigated, 'https://magpie.example/_magpie/plugin/tok/_magpie/service/');
  assert.equal(h.node('view-monitor').hidden, false);
  assert.equal(h.node('view-settings').hidden, true);
});

test('on the service page the monitor reads the same-origin snapshot and renders it', async () => {
  const h = harness({
    service: '_magpie/service/',
    pathname: '/_magpie/plugin/tok/_magpie/service/',
    token: 'test-token',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => snapshot }),
  });
  await settle();
  h.clickTab('monitor');
  assert.equal(h.calls.navigated, undefined, 'the service page never re-navigates');
  await settle(); await settle();
  assert.ok(h.calls.fetch[0].endsWith('/_magpie/plugin/tok/_magpie/service/snapshot'), h.calls.fetch[0]);
  assert.match(h.node('monitor-summary').innerHTML, /可用分组/);
  assert.match(h.node('monitor-body').innerHTML, /Fixture group/);
  assert.match(h.node('monitor-body').innerHTML, /99\.0%/);
  assert.match(h.node('monitor-body').innerHTML, /exact-fixture/);
  assert.match(h.node('monitor-filters').innerHTML, /全部/);
});

test('a service page without the bridge still reads its own snapshot', async () => {
  const h = harness({
    withBridge: false, pathname: '/_magpie/plugin/tok/_magpie/service/', token: 'test-token',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => snapshot }),
  });
  await settle();
  h.clickTab('monitor');
  await settle(); await settle();
  assert.equal(h.calls.navigated, undefined, 'the service page never re-navigates');
  assert.equal(h.calls.fetch.length, 1);
  assert.match(h.node('monitor-body').innerHTML, /Fixture group/);
});

test('without a service token the page never guesses a snapshot URL', async () => {
  const h = harness({ token: null });
  await settle();
  h.clickTab('monitor');
  await settle(); await settle();
  assert.equal(h.calls.fetch.length, 0);
  assert.match(h.node('monitor-body').innerHTML, /本机回环页/);
});

test('a desktop page without a service entry explains where the loopback page lives', async () => {
  const h = harness({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await settle();
  h.node('monitorPort').value = '19871';
  h.clickTab('monitor');
  await settle(); await settle();
  assert.equal(h.calls.navigated, undefined);
  assert.match(h.node('monitor-body').innerHTML, /读取快照失败|127\.0\.0\.1:19871/);
});
