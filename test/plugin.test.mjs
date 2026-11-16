import test from 'node:test';
import assert from 'node:assert/strict';
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

test('session header is scoped to this provider', async () => {
  const hooks = await entry.server({ client: {} });
  const a = { headers: {} }, b = { headers: {} };
  await hooks['chat.headers']({ model: { providerID: 'aihub-auto' }, sessionID: 'test-session' }, a);
  await hooks['chat.headers']({ model: { providerID: 'other' }, sessionID: 'test-session' }, b);
  assert.equal(a.headers['x-aihub-auto-session'], 'test-session');
  assert.deepEqual(b.headers, {});
});

test('configuration refuses unknown secret fields and invalid numeric values', () => {
  assert.throws(() => settings({ password: 'fake' }), /Unknown option/);
  assert.throws(() => settings({ maxMultiplier: NaN }), /Invalid/);
  assert.throws(() => settings({ maxAttempts: 2.5 }), /integer/);
  assert.throws(() => settings({ models: [{ id: 'space bad' }] }), /model id/);
  assert.equal(settings({ maxMultiplier: 0 }).maxMultiplier, 0);
  assert.equal(settings().autoCreateKeys, false);
  assert.throws(() => manualBundle('[{"groupId":1,"key":"fake"}]'), /multiplier/);
});
