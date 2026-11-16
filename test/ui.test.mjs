import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const code = await readFile(new URL('../ui/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
function harness(options = {}, failSave = false, withBridge = true, service = '') {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', checked: false, attrs: {}, handlers: {},
      setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
      addEventListener(k, fn) { this.handlers[k] = fn; }, focus() {}, querySelectorAll() { return []; },
    });
    return nodes.get(id);
  };
  let saved, navigated;
  const context = { document: { getElementById: node }, setTimeout, clearTimeout, console, URL,
    location: { href: 'https://magpie.example/plugin/page', replace: url => { navigated = url; } } };
  if (withBridge) context.magpie = { service, ready: Promise.resolve(), read: async () => [], options: {
    get: async () => options,
    set: async value => { if (failSave) throw new Error('Host save rejected'); saved = value; },
  } };
  vm.runInNewContext(code, context);
  return { node, saved: () => saved, navigated: () => navigated,
    clickMonitor: () => node('open-monitor').handlers.click(), clickSave: () => {
    const click = node('save-button').handlers.click;
    assert.equal(typeof click, 'function', 'the visible Save button must handle clicks directly');
    return click({ type: 'click', target: node('save-button') });
  } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('UI save works without native form submission in the Magpie sandbox', () => {
  assert.doesNotMatch(html, /<\/?form\b/i, 'the sandbox does not allow native forms');
  assert.match(html, /<div\b[^>]*id="options-form"[^>]*role="group"/);
  const button = html.match(/<button\b[^>]*id="save-button"[^>]*>/i)?.[0];
  assert.ok(button, 'the settings page must expose a Save button');
  assert.match(button, /\btype="button"/);
});

test('UI loads and saves real newline model IDs, validates CSV, preserves recognized metadata only', async () => {
  const h = harness({ models: [{ id: 'model-one', api: 'chat', context: 4096 }, { id: 'model-two', api: 'responses' }], refreshMs: 12345, accidentalSecret: 'must-not-persist' });
  await settle();
  assert.equal(h.node('models').value, 'model-one|chat\nmodel-two|responses');
  h.node('allowedGroups').value = '10, 20';
  h.node('maxMultiplier').value = '0';
  // Browser input values are strings; our tiny DOM deliberately performs this coercion here.
  for (const id of ['maxAttempts', 'poolSize']) h.node(id).value = String(h.node(id).value);
  await h.clickSave();
  assert.ok(h.saved(), h.node('status').textContent);
  assert.deepEqual(Array.from(h.saved().allowedGroups), [10, 20]);
  assert.equal(h.saved().maxMultiplier, 0);
  assert.equal(h.saved().models[0].context, 4096);
  assert.equal(h.saved().refreshMs, 12345);
  assert.equal(h.saved().accidentalSecret, undefined);
});

test('UI refuses malformed group IDs before any save', async () => {
  const h = harness(); await settle();
  for (const id of ['maxAttempts', 'poolSize', 'maxMultiplier']) h.node(id).value = String(h.node(id).value);
  h.node('excludedGroups').value = '2, -3';
  await h.clickSave();
  assert.equal(h.saved(), undefined);
  assert.equal(h.node('excludedGroups').attrs['aria-invalid'], 'true');
});

test('UI recovers controls after save failure and explains missing bridge', async () => {
  const h = harness({}, true); await settle();
  for (const id of ['maxAttempts', 'poolSize', 'maxMultiplier']) h.node(id).value = String(h.node(id).value);
  await h.clickSave();
  assert.equal(h.node('controls').disabled, false);
  assert.match(h.node('status').textContent, /保存未确认/);
  const missing = harness({}, false, false);
  assert.match(missing.node('status').textContent, /未找到 Magpie/);
});

test('UI preserves six-platform settings and canonical model limits through save', async () => {
  const h = harness({ platforms: ['gemini', 'deepseek'], monitorEnabled: true, monitorPort: 23123,
    models: [{ id: 'gemini-2.5-pro', platform: 'gemini', api: 'gemini', context: 100000, output: 8192 }] });
  await settle();
  assert.equal(h.node('models').value, 'gemini::gemini-2.5-pro|gemini');
  assert.equal(h.node('platform-openai').checked, false);
  h.node('models').value += '\ndeepseek::deepseek-chat|chat';
  await h.clickSave();
  assert.ok(h.saved(), h.node('status').textContent);
  assert.deepEqual(Array.from(h.saved().platforms), ['deepseek', 'gemini']);
  assert.equal(h.saved().monitorEnabled, true);
  assert.equal(h.saved().monitorPort, 23123);
  assert.equal(h.saved().models[0].context, 100000);
  assert.equal(h.saved().models[0].output, 8192);
  assert.equal(h.saved().models[1].id, 'deepseek::deepseek-chat');
});

test('UI rejects cross-platform protocols and empty platform selection', async () => {
  for (const value of ['gemini::model|chat', 'deepseek::model|gemini', 'unknown::model|responses']) {
    const h = harness(); await settle(); h.node('models').value = value;
    await h.clickSave(); assert.equal(h.saved(), undefined, value);
    assert.equal(h.node('models').attrs['aria-invalid'], 'true');
  }
  const h = harness(); await settle();
  for (const platform of ['openai', 'deepseek', 'zhipu', 'kimi', 'grok', 'gemini']) h.node(`platform-${platform}`).checked = false;
  await h.clickSave(); assert.equal(h.saved(), undefined);
});

test('monitor entry uses service bridge only when enabled in saved options', async () => {
  const service = '/_magpie/plugin/token/_magpie/service/';
  const h = harness({ monitorEnabled: true }, false, true, service); await settle();
  h.clickMonitor(); assert.equal(h.navigated(), `https://magpie.example${service}`);
  const disabled = harness({}, false, true, service); await settle();
  disabled.node('monitorEnabled').checked = true; disabled.clickMonitor();
  assert.equal(disabled.navigated(), undefined);
  assert.match(disabled.node('status').textContent, /保存/);
  const unavailable = harness({ monitorEnabled: true }); await settle(); unavailable.clickMonitor();
  assert.equal(unavailable.navigated(), undefined); assert.match(unavailable.node('status').textContent, /服务入口/);
});
