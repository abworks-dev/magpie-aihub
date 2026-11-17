import test from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORMS, modelDescriptor, publicModelId } from '../src/platforms.mjs';
import { configModels, manualBundle, ORIGIN, settings } from '../src/config.mjs';
import { Router } from '../src/router.mjs';
import { Account } from '../src/account.mjs';

// Every upstream call in this file is intercepted by an injected local fetcher.
const platforms = ['openai', 'deepseek', 'zhipu', 'kimi', 'grok', 'gemini'];
const model = 'shared-model';
const publicId = platform => platform === 'openai' ? model : `${platform}::${model}`;
const candidate = (platform, groupId, extra = {}) => ({ platform, groupId, multiplier: 0.1, models: [model], ...extra });
const post = (path, body, headers = {}) => new Request(`${ORIGIN}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
function fixture(rows, options = {}, respond = () => new Response('ok')) {
  const prepared = [], calls = [], probed = [];
  const account = {
    data: { mode: 'manual', keys: [] },
    catalogue: async () => rows,
    keyFor: async c => { prepared.push(c); return { ...c, key: `local-key-${c.groupId}` }; },
    modelIds: async key => { probed.push(key.groupId); return key.models; },
  };
  const router = new Router(account, settings({ strategy: 'economy', ...options }), {
    fetcher: async (url, init) => { calls.push({ url, init }); return respond(url, init, calls.length); },
  });
  return { router, account, prepared, calls, probed };
}

test('six same-named models have distinct public namespaces and SDK platform hints', () => {
  assert.deepEqual(PLATFORMS, platforms);
  const o = settings({ models: platforms.map(platform => ({ id: model, platform, api: platform === 'gemini' ? 'gemini' : 'responses' })) });
  assert.deepEqual(o.models.map(m => m.id), platforms.map(publicId));
  const config = configModels(o);
  assert.equal(Object.keys(config).length, 6);
  for (const platform of platforms) {
    const entry = config[publicId(platform)];
    assert.equal(entry.id, model);
    assert.equal(entry.headers['x-aihub-auto-platform'], platform);
    assert.deepEqual(entry.provider, platform === 'gemini'
      ? { npm: '@ai-sdk/google', api: `${ORIGIN}/v1beta` }
      : { npm: '@ai-sdk/openai', api: `${ORIGIN}/v1` });
  }
  assert.throws(() => settings({ models: [model, `openai::${model}`] }), /Duplicate/);
  const imported = manualBundle(JSON.stringify(platforms.map((platform, i) => ({ platform, groupId: i + 1, key: `fixture-${i}`, multiplier: 0.1 }))));
  assert.deepEqual(imported.map(k => k.platform), platforms);
});

test('namespace, explicit platform and protocol conflicts fail closed', () => {
  for (const row of [
    { id: `deepseek::${model}`, platform: 'openai' },
    { id: `gemini::${model}`, api: 'chat' },
    { id: `grok::${model}`, api: 'gemini' },
    { id: `unknown::${model}` },
    { id: `kimi::nested::${model}` },
  ]) assert.throws(() => modelDescriptor(row));
  assert.equal(modelDescriptor(`gemini::${model}`, 'responses').api, 'responses');
});

test('same-model failover stays inside each of the six platforms even with cheaper foreign routes', async t => {
  for (const platform of platforms) await t.test(platform, async () => {
    const rows = platforms.filter(p => p !== platform).map((p, i) => candidate(p, i + 1, { multiplier: 0 }));
    rows.push(candidate(platform, 100), candidate(platform, 101, { multiplier: 0.11 }));
    // Even a same-platform route must serve this exact upstream model.
    rows.push(candidate(platform, 102, { multiplier: 0, models: ['other-model'] }));
    // Gemini groups are reached through generateContent, so the fixture answers
    // in that protocol instead of echoing the OpenAI body.
    const native = platform === 'gemini';
    const f = fixture(rows, {}, (_url, _init, count) => new Response(count === 1
      ? 'busy'
      : native ? JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) : 'ok', { status: count === 1 ? 429 : 200 }));
    const body = { model: publicId(platform), input: 'offline fixture' };
    const response = await f.router.fetch(post('/v1/responses', body, { 'x-aihub-auto-session': 'shared-session' }));
    assert.equal(response.status, 200);
    if (native) assert.equal((await response.json()).output[0].content[0].text, 'ok');
    else assert.equal(await response.text(), 'ok');
    assert.deepEqual(f.prepared.map(c => [c.platform, c.groupId]), [[platform, 100], [platform, 101]]);
    assert.deepEqual(f.probed, [100, 101]);
    assert.equal(f.calls.length, 2);
    for (const { url, init } of f.calls) {
      if (native) {
        assert.equal(url, `${ORIGIN}/v1beta/models/${model}:generateContent`);
        assert.deepEqual(JSON.parse(Buffer.from(init.body).toString()).contents, [{ role: 'user', parts: [{ text: 'offline fixture' }] }]);
        assert.equal(init.headers.get('authorization'), null);
      } else {
        assert.equal(url, `${ORIGIN}/v1/responses`);
        assert.deepEqual(JSON.parse(Buffer.from(init.body).toString()), { ...body, model });
      }
      assert.equal(init.headers.get('x-aihub-auto-session'), null);
    }
  });
});

test('one session hint keeps independent sticky routes for same-named models on different platforms', async () => {
  const rows = [candidate('openai', 1), candidate('openai', 2, { multiplier: 0.12 }), candidate('deepseek', 3), candidate('deepseek', 4, { multiplier: 0.12 })];
  const f = fixture(rows);
  const send = async platform => {
    const response = await f.router.fetch(post('/v1/responses', { model: publicId(platform), input: 'fixture' }, { 'x-aihub-auto-session': 'same-client-session' }));
    assert.equal(response.status, 200);
    await response.text();
  };
  await send('openai');
  await send('deepseek');
  rows[1].multiplier = rows[3].multiplier = 0;
  await send('openai');
  await send('deepseek');
  assert.deepEqual(f.prepared.map(c => c.groupId), [1, 3, 1, 3]);
});

test('Gemini native operations preserve exact URL/body and replace caller credentials with only the group Google key', async t => {
  for (const suffix of [':generateContent', ':streamGenerateContent', ':streamGenerateContent?alt=sse']) await t.test(suffix, async () => {
    const f = fixture([candidate('openai', 1, { multiplier: 0 }), candidate('gemini', 2)]);
    const body = '{\n  "contents": [{"role":"user","parts":[{"text":"本地测试"}]}], "generationConfig": {"temperature":0}\n}';
    const path = `/v1beta/models/${model}${suffix}`;
    const response = await f.router.fetch(post(path, body, {
      authorization: 'Bearer caller-fixture', cookie: 'caller-cookie', 'x-goog-api-key': 'caller-google-fixture',
      'x-aihub-auto-platform': 'gemini', 'x-aihub-auto-session': 'private-session', accept: 'text/event-stream',
    }));
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(f.prepared.map(c => c.platform), ['gemini']);
    const { url, init } = f.calls[0];
    assert.equal(url, `${ORIGIN}${path}`);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(Buffer.from(init.body).toString(), body);
    assert.deepEqual(Object.fromEntries(init.headers), { accept: 'text/event-stream', 'content-type': 'application/json', 'x-goog-api-key': `local-key-${f.prepared[0].groupId}` });
  });
});

test('Gemini native rejects every query except the exact streaming alt=sse query before touching the account', async t => {
  for (const suffix of [
    ':generateContent?alt=sse', ':streamGenerateContent?key=caller-fixture', ':streamGenerateContent?alt=json',
    ':streamGenerateContent?alt=sse&key=caller-fixture', ':streamGenerateContent?alt=sse&alt=sse',
    ':streamGenerateContent?%61lt=sse', ':streamGenerateContent?alt=SSE',
  ]) await t.test(suffix, async () => {
    const f = fixture([candidate('gemini', 1)]);
    let catalogueCalls = 0;
    f.account.catalogue = async () => { catalogueCalls++; throw new Error('must not touch account'); };
    const response = await f.router.fetch(post(`/v1beta/models/${model}${suffix}`, { contents: [] }));
    assert.equal(response.status, 400);
    await response.text();
    assert.equal(catalogueCalls, 0);
    assert.deepEqual(f.prepared, []);
    assert.deepEqual(f.calls, []);
  });
});

test('disabled platforms and Gemini native mismatches cannot prepare a key', async t => {
  const cases = [
    { path: '/v1/responses', body: { model: `deepseek::${model}` }, headers: { 'x-aihub-auto-platform': 'grok' } },
    { path: '/v1/responses', body: { model: `deepseek::${model}` }, options: { platforms: ['openai'] } },
    { path: '/v1/chat/completions', body: { model: `gemini::${model}` } },
    { path: `/v1beta/models/${model}:generateContent`, body: { contents: [], model: 'different-model' } },
    { path: `/v1beta/models/${model}:generateContent`, body: { contents: [] }, headers: { 'x-aihub-auto-platform': 'openai' } },
  ];
  for (const [i, c] of cases.entries()) await t.test(String(i), async () => {
    const f = fixture([candidate('gemini', 1), candidate('deepseek', 2)], c.options);
    const response = await f.router.fetch(post(c.path, c.body, c.headers));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_platform_model');
    assert.deepEqual(f.prepared, []);
    assert.deepEqual(f.calls, []);
  });
});

test('read-only managed discovery namespaces all six platforms without touching pending key creation', async () => {
  const data = { version: 1, mode: 'managed', instanceId: 'readonly-instance', access: 'local-access', keys: [],
    pending: { groupId: 6, name: 'pending-fixture', idempotencyKey: 'pending-fixture-id' } };
  let saves = 0, preparations = 0, fetches = 0;
  const account = new Account(data, { save: async () => { saves++; }, fetcher: async () => { fetches++; throw new Error('No remote reads or writes expected'); } });
  account.catalogue = async () => platforms.map((p, i) => candidate(p, i + 1, { advertisedModels: [model] }));
  account.keyFor = async () => { preparations++; throw new Error('Discovery must not prepare keys'); };
  const router = new Router(account, settings({ autoCreateKeys: true }), { fetcher: async () => { throw new Error('No inference expected'); } });
  const before = structuredClone(account.data);
  assert.deepEqual(await router.discover(), platforms.map(publicId).sort());
  const response = await router.fetch(`${ORIGIN}/v1/models`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.map(row => row.id), platforms.map(publicId).sort());
  assert.deepEqual(account.data, before);
  assert.equal(saves, 0);
  assert.equal(preparations, 0);
  assert.equal(fetches, 0);
});

test('the caller can ask for bare ids, which is what joins a same-named routing group', () => {
  assert.equal(publicModelId('gemini', 'gemini-3.8-flash', true), 'gemini-3.8-flash');
  assert.equal(publicModelId('deepseek', 'deepseek::deepseek-v4-pro', true), 'deepseek-v4-pro');
});

test('namespacing a model id twice still yields one parseable id', () => {
  assert.equal(publicModelId('zhipu', 'zhipu::glm-5.2'), 'zhipu::glm-5.2');
  assert.equal(publicModelId('deepseek', 'deepseek:deepseek-flash'), 'deepseek::deepseek-flash');
  assert.equal(publicModelId('openai', 'openai::gpt-5.6'), 'gpt-5.6');
  assert.deepEqual(modelDescriptor(publicModelId('kimi', 'kimi-k3')), { id: 'kimi::kimi-k3', modelId: 'kimi-k3', platform: 'kimi', api: 'responses' });
});

test('a one-colon namespace and a bare id resolve to the same platform/model pair', () => {
  assert.deepEqual([modelDescriptor('deepseek::deepseek-flash').platform, modelDescriptor('deepseek::deepseek-flash').modelId], ['deepseek', 'deepseek-flash']);
  assert.deepEqual([modelDescriptor('deepseek:deepseek-flash').platform, modelDescriptor('deepseek:deepseek-flash').modelId], ['deepseek', 'deepseek-flash']);
  assert.equal(modelDescriptor('gpt-5.6').platform, 'openai');
  assert.equal(modelDescriptor('gpt-5.6:beta').modelId, 'gpt-5.6:beta', 'a colon that is not a platform stays in the id');
});
