import test from 'node:test';
import assert from 'node:assert/strict';
import { Account } from '../src/account.mjs';
import { Router } from '../src/router.mjs';
import { BASE, ORIGIN, settings } from '../src/config.mjs';

const group = (id, extra = {}) => ({ id, status: 'active', platform: 'openai', rate_multiplier: 0.1, ...extra });
const hall = (id, models, extra = {}) => ({
  group_id: id, platform: 'openai', visible_in_hall: true, available: true,
  model_detection: { status: 'passed' },
  ...(models === undefined ? {} : { model_cards: models.map(model => ({ model, health: 'passed' })) }), ...extra,
});
const ownedKey = groupId => ({ groupId, key: `dedicated-${groupId}`, owned: true });

function fixture({ groups = [group(1)], providers = [hall(1, ['model-b', 'model-a'])], rates = {}, keys = [], options = {}, models = {}, failure } = {}) {
  const calls = [], saved = [];
  const fetcher = async (url, init = {}) => {
    assert.equal(new URL(url).origin, ORIGIN);
    const path = new URL(url).pathname;
    const headers = new Headers(init.headers);
    calls.push({ path, method: init.method ?? 'GET', authorization: headers.get('authorization') });
    assert.equal(init.method ?? 'GET', 'GET', 'discovery must not create keys or call inference');
    assert.equal(init.body, undefined);
    if (failure?.path === path) return Response.json({ error: 'unavailable' }, { status: failure.status });
    if (path === '/api/v1/groups/available') return Response.json(groups);
    if (path === '/api/v1/groups/rates') return Response.json(rates);
    if (path === '/api/v2/public/providers') return Response.json(providers);
    if (path === '/v1/models') {
      const value = models[headers.get('authorization')];
      if (value instanceof Error) throw value;
      assert.ok(Array.isArray(value), 'only explicitly permitted dedicated credentials may be queried');
      return Response.json({ data: value.map(id => ({ id })) });
    }
    assert.fail(`Discovery must not call ${path}`);
  };
  const account = new Account({ version: 1, mode: 'managed', instanceId: 'discovery-test', access: 'account-access', keys }, {
    fetcher, save: async data => saved.push(data),
  });
  const router = new Router(account, settings(options), { fetcher });
  return { account, router, calls, saved };
}

test('fresh managed account with zero keys discovers sorted hall IDs using only catalogue GETs', async () => {
  const { account, router, calls, saved } = fixture({ providers: [hall(1, ['model-b', 'model-a', 'model-a'])] });
  const response = await router.fetch(`${BASE}/models`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { object: 'list', data: [
    { id: 'model-a', object: 'model', owned_by: 'aihub' },
    { id: 'model-b', object: 'model', owned_by: 'aihub' },
  ] });
  assert.deepEqual(calls.map(c => c.path).sort(), ['/api/v1/groups/available', '/api/v1/groups/rates', '/api/v2/public/providers']);
  assert.ok(calls.every(c => c.method === 'GET' && c.authorization === 'Bearer account-access'));
  assert.deepEqual(account.data.keys, []);
  assert.equal(account.data.pending, undefined);
  assert.deepEqual(saved, []);
  assert.equal(settings().defaultApi, 'responses');
});

test('managed discovery honors account visibility, all group policy filters and rejected model health', async () => {
  const groups = Array.from({ length: 12 }, (_, i) => group(i + 1));
  groups[4].platform = 'anthropic';
  groups[5].status = 'disabled';
  groups[0].models_list_config = { enabled: true, models: ['good', 'failed'] };
  const providers = [
    hall(1, [], { model_cards: [{ model: 'good' }, { model: 'outside-restriction' }, { model: 'failed', health: 'failed' }] }),
    hall(2, ['excluded']), hall(3, ['expensive']), hall(4, ['unavailable'], { available: false }),
    hall(5, ['anthropic']), hall(6, ['disabled']), hall(7, ['hidden'], { visible_in_hall: false }),
    hall(8, ['failed-detection'], { model_detection: { status: 'failed' } }),
    hall(9, ['unpassed'], { model_detection: { status: 'pending' } }),
    hall(10, ['not-allowed']), hall(11, ['wrong-hall-platform'], { platform: 'anthropic' }),
    hall(12, ['text-failed'], { model_detection: { status: 'passed', stages: { text: { published_state: 'failed' } } } }),
    hall(99, ['not-account-visible']),
  ];
  const { router, calls } = fixture({ groups, providers, rates: { 1: 0.16, 3: 0.17 }, options: {
    maxMultiplier: 0.16, requirePassed: true, excludedGroups: [2], allowedGroups: [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12],
  } });
  assert.deepEqual(await router.discover(), ['good']);
  assert.equal(calls.length, 3);
});

test('only validated finite restrictions can supply IDs when cards are absent or unusable', async () => {
  const { router } = fixture({
    groups: [
      group(1, { models_list_config: { enabled: true, models: ['explicit', 'explicit'] } }),
      group(2, { models_list_config: { enabled: true, models: ['fallback'] } }),
      group(3, { models_list_config: { enabled: true, models: ['other', 'rejected'] } }),
    ],
    providers: [hall(1), hall(2, [], { model_cards: [null, { id: 'not-the-model-field' }, { model: '' }, { model: '*' }, { model: 3 }] }),
      hall(3, [], { model_cards: [{ model: 'rejected', health: 'failed' }] })],
  });
  assert.deepEqual(await router.discover(), ['explicit', 'fallback']);
});

test('enabled empty and malformed group restrictions fail closed even with advertised cards', async t => {
  for (const restriction of [
    { enabled: true, models: [] }, { enabled: true }, { enabled: true, models: 'model-a' },
    { enabled: true, models: ['model-a', 3] }, { enabled: true, models: ['*'] },
    { enabled: 'true', models: ['model-a'] }, {},
  ]) {
    await t.test(JSON.stringify(restriction), async () => {
      const { router, calls } = fixture({ groups: [group(1, { models_list_config: restriction })], keys: [ownedKey(1)] });
      assert.deepEqual(await router.discover(), []);
      assert.equal(calls.length, 3, 'denied model sets must not trigger key discovery');
    });
  }
});

test('unknown or empty cards without a finite restriction produce a descriptive discovery error', async t => {
  for (const cards of [undefined, [], 'unknown', [null, { id: 'unproven' }, { model: 'display name' }]]) {
    await t.test(JSON.stringify(cards) ?? 'absent', async () => {
      const { router } = fixture({ providers: [hall(1, undefined, { model_cards: cards })] });
      await assert.rejects(router.discover(), /no supported model IDs.*catalogue.*dedicated keys/);
      assert.equal((await router.fetch(`${BASE}/models`)).status, 503);
    });
  }
});

test('catalogue failures surface rather than returning an empty successful discovery', async () => {
  const { router } = fixture({ failure: { path: '/api/v1/groups/available', status: 403 } });
  await assert.rejects(router.discover(), error => error.status === 403);
  assert.equal((await router.fetch(`${BASE}/models`)).status, 503);
});

test('known empty or policy-excluded catalogues return an empty list without credential probes', async t => {
  for (const input of [{ groups: [], providers: [] }, { options: { excludedGroups: [1] } }, {
    providers: [hall(1, [], { model_cards: [{ model: 'failed', health: 'failed' }] })],
  }]) {
    await t.test(JSON.stringify(input), async () => assert.deepEqual(await fixture(input).router.discover(), []));
  }
});

test('only stored owned keys for currently eligible groups supplement catalogue IDs with policy filtering', async () => {
  const { router, calls } = fixture({
    groups: [group(1, { models_list_config: { enabled: true, models: ['card', 'key-only', 'failed'] } }), group(2), group(3)],
    providers: [hall(1, [], { model_cards: [{ model: 'card' }, { model: 'failed', health: 'failed' }] }), hall(2, ['excluded']), hall(3, ['public'])],
    keys: [ownedKey(1), ownedKey(2), { ...ownedKey(3), owned: false }, ownedKey(99)],
    options: { excludedGroups: [2] },
    models: { 'Bearer dedicated-1': ['key-only', 'failed', 'not-permitted'] },
  });
  assert.deepEqual(await router.discover(), ['card', 'key-only', 'public']);
  assert.deepEqual(calls.filter(c => c.path === '/v1/models').map(c => c.authorization), ['Bearer dedicated-1']);
});

test('readable dedicated model list resolves unknown cards, while failed keys cannot hide missing evidence', async () => {
  const input = { providers: [hall(1)], keys: [ownedKey(1)] };
  assert.deepEqual(await fixture({ ...input, models: { 'Bearer dedicated-1': ['key-only'] } }).router.discover(), ['key-only']);
  assert.deepEqual(await fixture({ ...input, models: { 'Bearer dedicated-1': [] } }).router.discover(), []);
  await assert.rejects(fixture({ ...input, models: { 'Bearer dedicated-1': new Error('revoked') } }).router.discover(), /no supported model IDs/);
  assert.deepEqual(await fixture({ keys: [ownedKey(1)], models: { 'Bearer dedicated-1': new Error('revoked') } }).router.discover(), ['model-a', 'model-b']);
});

test('managed advertisements respect transient per-group and per-model rejection state', async () => {
  const { router } = fixture({ groups: [group(1), group(2)], providers: [hall(1, ['cooling']), hall(2, ['rejected', 'good'])] });
  router.cooldown.set(1, Date.now() + 60000);
  router.rejected.set('2:rejected', Date.now() + 60000);
  assert.deepEqual(await router.discover(), ['good']);
});

test('manual discovery retains configured/imported key behavior without any management requests', async () => {
  const calls = [];
  const account = new Account({ version: 1, mode: 'manual', instanceId: 'manual', keys: [
    { groupId: 1, key: 'imported-1', multiplier: 0.1, models: ['explicit'] },
    { groupId: 2, key: 'imported-2', multiplier: 0.1 },
  ] }, { fetcher: async (url, init) => {
    calls.push(url);
    assert.equal(url, `${BASE}/models`);
    assert.equal(init.method ?? 'GET', 'GET');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer imported-2');
    return Response.json({ data: [{ id: 'discovered' }, { id: 'explicit' }] });
  } });
  assert.deepEqual(await new Router(account, settings()).discover(), ['discovered', 'explicit']);
  assert.deepEqual(calls, [`${BASE}/models`]);
});
