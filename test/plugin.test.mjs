import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import entry from '../index.mjs';
import { settings, manualBundle } from '../src/config.mjs';

test('entry exports only supported module and registers correct config SDKs', async () => {
  assert.equal(entry.id, 'magpie-aihub');
  const hooks = await entry.server({ client: {} }, { models: [{ id: 'responses-model' }, { id: 'chat-model', api: 'chat' }] });
  const config = {};
  await hooks.config(config);
  assert.equal(config.provider['aihub-auto'].api, 'https://aihub.top/v1');
  assert.equal(config.provider['aihub-auto'].models['responses-model'].provider.npm, '@ai-sdk/openai');
  assert.equal(config.provider['aihub-auto'].models['chat-model'].provider.npm, '@ai-sdk/openai-compatible');
  assert.equal(hooks.auth.methods[0].prompts[0].type, 'password');
  assert.equal(hooks.auth.methods[1].prompts[1].type, 'password');
  // Magpie otherwise asks for an unrelated extra API key after the custom prompts.
  assert.ok(hooks.auth.methods.every(method => method.keyless === true && typeof method.authorize === 'function'));
});

test('manual auth bundle remains secret and loader uses dedicated internal placeholder', async () => {
  const hooks = await entry.server({ client: {} });
  const result = await hooks.auth.methods[0].authorize({ keys: JSON.stringify([{ groupId: 1, key: 'FAKE_TEST_KEY', multiplier: 0.1, models: ['model'] }]) });
  assert.equal(result.type, 'success');
  assert.equal(JSON.parse(result.key).mode, 'manual');
  assert.ok(!JSON.stringify(result.metadata).includes('FAKE_TEST_KEY'));
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: result.key }));
  assert.equal(loader.apiKey, 'magpie-aihub-internal');
  const discovered = await hooks.provider.models({ models: {} }, { auth: { key: result.key } });
  assert.equal(discovered.model.api.npm, '@ai-sdk/openai');
});

test('fresh managed auth exposes advertised models through the real provider hook without creating keys', async () => {
  const priorFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    assert.equal(new URL(url).origin, 'https://aihub.top');
    assert.equal(init.method ?? 'GET', 'GET');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-access');
    calls.push(path);
    const fixtures = {
      '/api/v1/groups/available': [{ id: 1, status: 'active', platform: 'openai', rate_multiplier: 0.1 }],
      '/api/v1/groups/rates': {},
      '/api/v2/public/providers': [{ group_id: 1, platform: 'openai', available: true, model_cards: [{ model: 'advertised-model', health: 'passed' }] }],
    };
    assert.ok(Object.hasOwn(fixtures, path), 'discovery must not prepare keys or infer');
    return Response.json({ code: 0, data: fixtures[path] });
  };
  try {
    const hooks = await entry.server({ client: { auth: { set: () => assert.fail('discovery must not persist new keys') } } });
    const auth = { type: 'api', key: JSON.stringify({ version: 1, mode: 'managed', instanceId: 'fresh-managed', access: 'synthetic-access', keys: [] }) };
    const models = await hooks.provider.models({ models: {} }, { auth });
    assert.deepEqual(Object.keys(models), ['advertised-model']);
    assert.equal(models['advertised-model'].api.npm, '@ai-sdk/openai');
    assert.equal(models['advertised-model'].providerID, 'aihub-auto');
    assert.equal(calls.length, 3);
  } finally { globalThis.fetch = priorFetch; }
});

test('metadata and page embed the same verified official AIHub image without another asset route', async () => {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  const icon = metadata.magpie.icon;
  assert.match(icon, /^data:image\/png;base64,/);
  const bytes = Buffer.from(icon.slice(icon.indexOf(',') + 1), 'base64');
  assert.equal(bytes.length, 20448);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '4ca27ef38578050dbf72af67769efd77fd3cba146916f60bcb6f1198b93793f0');
  assert.ok(html.includes(`src="${icon}"`));
  assert.ok(html.includes('alt="" aria-hidden="true"'), 'decorative brand image keeps the visible page heading as its accessible name');
});

test('session header is scoped to this provider', async () => {
  const hooks = await entry.server({ client: {} });
  const a = { headers: {} }, b = { headers: {} };
  await hooks['chat.headers']({ model: { providerID: 'aihub-auto' }, sessionID: 'test-session' }, a);
  await hooks['chat.headers']({ model: { providerID: 'other' }, sessionID: 'test-session' }, b);
  assert.equal(a.headers['x-aihub-auto-session'], 'test-session');
  assert.deepEqual(b.headers, {});
});

test('chat default still discovers Gemini Responses and sets its platform header', async () => {
  const hooks = await entry.server({ client: {} }, { defaultApi: 'chat' });
  const data = manualBundle(JSON.stringify([{ groupId: 1, platform: 'gemini', key: 'SYNTHETIC', multiplier: 0.1, models: ['gemini-test'] }]));
  const models = await hooks.provider.models({}, { auth: { key: JSON.stringify({ version: 1, mode: 'manual', instanceId: 'gemini-default', keys: data }) } });
  assert.equal(models['gemini::gemini-test'].api.npm, '@ai-sdk/openai');
  assert.equal(models['gemini::gemini-test'].api.id, 'gemini-test');
  const output = {};
  await hooks['chat.headers']({ model: { providerID: 'aihub-auto', id: 'gemini::gemini-test' } }, output);
  assert.equal(output.headers['x-aihub-auto-platform'], 'gemini');
});

test('configuration refuses unknown secret fields and invalid numeric values', () => {
  assert.throws(() => settings({ password: 'fake' }), /Unknown option/);
  assert.throws(() => settings({ maxMultiplier: NaN }), /Invalid/);
  assert.throws(() => settings({ maxAttempts: 2.5 }), /integer/);
  assert.throws(() => settings({ models: [{ id: 'space bad' }] }), /model id/);
  assert.equal(settings({ maxMultiplier: 0 }).maxMultiplier, 0);
  assert.throws(() => settings({ platformCaps: { unknown: 1 } }), /Unknown platform/);
  assert.throws(() => settings({ platformCaps: { deepseek: 200 } }), /platformCaps\.deepseek/);
  assert.deepEqual(settings({ platformCaps: { deepseek: 1 } }).platformCaps, { deepseek: 1 });
  assert.equal(settings().autoCreateKeys, false);
  assert.throws(() => manualBundle('[{"groupId":1,"key":"fake"}]'), /multiplier/);
});

test('model discovery failure keeps the provider catalogue instead of blanking it', async () => {
  const hooks = await entry.server({ client: {} });
  const key = JSON.stringify({ version: 1, mode: 'managed', instanceId: 'catalogue-fallback', access: 'expired-access', keys: [] });
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'expired' }), { status: 401 });
  try {
    const kept = await hooks.provider.models({ models: { kept: { id: 'kept' } } }, { auth: { key } });
    assert.deepEqual(Object.keys(kept), ['kept']);
  } finally { globalThis.fetch = priorFetch; }
});
