import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyError, keyFailure } from '../src/errors.mjs';
import { Account } from '../src/account.mjs';
import { Router } from '../src/router.mjs';
import { ORIGIN, settings } from '../src/config.mjs';

// Local fixtures only: no fetch in these tests reaches AIHub.
const model = 'fixture-model';
const group = { groupId: 41, platform: 'deepseek', multiplier: 0.1, models: [model] };
const request = () => new Request(`${ORIGIN}/v1/responses`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: `deepseek::${model}`, input: 'offline fixture' }),
});
const baseData = () => ({ version: 1, mode: 'managed', instanceId: 'test-instance-fixed', access: 'local-access-fixture', keys: [] });

test('untrusted management failures map to stable local errors without reflecting response secrets', async t => {
  const sensitive = 'fixture-private-management-payload';
  const cases = [
    [401, 'key_sign_in_required'], [403, 'key_access_denied'], [429, 'key_rate_limited'],
    [400, 'key_preparation_failed'], [500, 'key_preparation_failed'], [undefined, 'key_preparation_failed'],
  ];
  for (const [status, code] of cases) await t.test(String(status), async () => {
    const error = Object.assign(new Error(sensitive), { status, body: sensitive, code: sensitive, name: 'KeyError' });
    const mapped = keyFailure(error);
    assert.equal(mapped.code, code);
    assert.ok(mapped.message.length > 0);
    assert.equal(JSON.stringify(mapped).includes(sensitive), false);
    let preparations = 0, modelProbes = 0, inference = 0;
    const account = {
      data: { mode: 'managed', keys: [] }, catalogue: async () => [group, { ...group, groupId: 42, multiplier: 0.11 }],
      keyFor: async () => { preparations++; throw error; },
      modelIds: async () => { modelProbes++; return [model]; },
    };
    const router = new Router(account, settings({ autoCreateKeys: true }), { fetcher: async () => { inference++; throw new Error('No inference allowed'); } });
    const response = await router.fetch(request());
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.deepEqual(body, { error: { type: 'aihub_routing_error', ...mapped } });
    assert.equal(JSON.stringify(body).includes(sensitive), false);
    assert.equal(preparations, 1, 'management errors must not prepare the next group');
    assert.equal(modelProbes, 0);
    assert.equal(inference, 0);
    assert.deepEqual(router.lastRoutes.map(row => row.outcome), [code]);
  });
  for (const error of [undefined, null, 'private raw response', { message: sensitive, code: 'key_duplicate' }]) {
    assert.equal(keyFailure(error).code, 'key_preparation_failed');
    assert.equal(JSON.stringify(keyFailure(error)).includes(sensitive), false);
  }
});

test('real local KeyError survives routing with its actionable code/message and no next-group preparation', async () => {
  const expected = new KeyError('key_creation_pending', 'The earlier create is still pending; check its record.');
  assert.equal(expected.name, 'KeyError');
  let preparations = 0;
  const account = {
    data: { mode: 'managed', keys: [] }, catalogue: async () => [group, { ...group, groupId: 42 }],
    keyFor: async () => { preparations++; throw expected; },
    modelIds: async () => { throw new Error('No model probe allowed'); },
  };
  const router = new Router(account, settings(), { fetcher: async () => { throw new Error('No inference allowed'); } });
  const response = await router.fetch(request());
  assert.equal(response.status, 503);
  assert.deepEqual((await response.json()).error, { type: 'aihub_routing_error', code: expected.code, message: expected.message });
  assert.equal(preparations, 1);
});

test('malformed or incomplete successful create responses retain pending across reload and never replay POST', async t => {
  const name = `magpie-aihub-${baseData().instanceId.slice(0, 12)}-g${group.groupId}`;
  const complete = { id: 71, group_id: group.groupId, key: 'local-created-fixture', name };
  const cases = [
    ['invalid JSON', () => new Response('{broken', { status: 200 })],
    ['missing payload', () => Response.json({ data: {} })],
    ['missing remote id', () => { const { id, ...rest } = complete; return Response.json({ data: rest }); }],
    ['wrong group', () => Response.json({ data: { ...complete, group_id: 999 } })],
    ['wrong instance name', () => Response.json({ data: { ...complete, name: 'unrelated-instance' } })],
    ['empty key', () => Response.json({ data: { ...complete, key: '' } })],
  ];
  for (const [label, createResponse] of cases) await t.test(label, async () => {
    let persisted, posts = 0;
    const calls = [];
    const fetcher = async (url, init) => {
      assert.equal(new URL(url).pathname, '/api/v1/keys');
      const method = init.method;
      calls.push(method);
      if (method === 'GET') return Response.json({ data: { items: [] } });
      assert.equal(method, 'POST');
      posts++;
      assert.equal(persisted.pending.groupId, group.groupId, 'pending must already be durable');
      assert.equal(new Headers(init.headers).get('idempotency-key'), persisted.pending.idempotencyKey);
      return createResponse();
    };
    const account = new Account(baseData(), { save: async value => { persisted = structuredClone(value); }, fetcher });
    const o = settings({ autoCreateKeys: true });
    await assert.rejects(account.keyFor(group, o), label === 'invalid JSON' ? { message: 'AIHub API /api/v1/keys returned invalid JSON' } : { code: 'key_creation_incomplete' });
    assert.equal(posts, 1);
    assert.deepEqual(account.data.keys, []);
    assert.ok(persisted.pending.idempotencyKey);
    const pending = structuredClone(persisted.pending);
    const reloaded = new Account(persisted, { save: async () => { throw new Error('Pending retries must not save or create'); }, fetcher });
    for (let i = 0; i < 2; i++) await assert.rejects(reloaded.keyFor(group, o), { code: 'key_creation_pending' });
    await assert.rejects(reloaded.keyFor({ ...group, groupId: 42 }, o), { code: 'key_creation_pending' });
    assert.equal(posts, 1);
    assert.equal(calls.filter(method => method !== 'GET').length, 1);
    assert.deepEqual(reloaded.data.pending, pending);
    assert.deepEqual(reloaded.data.keys, []);
  });
});

test('ambiguous or unrelated recovery records cannot resolve pending or cause replacement creation', async t => {
  const data = baseData();
  const name = `magpie-aihub-${data.instanceId.slice(0, 12)}-g${group.groupId}`;
  data.pending = { groupId: group.groupId, name, idempotencyKey: 'previous-local-operation' };
  const remote = { id: 71, name, group_id: group.groupId, status: 'active', key: 'local-recovered-fixture' };
  const cases = [
    ['duplicate active exact matches', [remote, { ...remote, id: 72 }], 'key_duplicate'],
    ['wrong group', [{ ...remote, group_id: 999 }], 'key_creation_pending'],
    ['inactive', [{ ...remote, status: 'disabled' }], 'key_creation_pending'],
    ['wrong instance', [{ ...remote, name: 'somebody-else' }], 'key_creation_pending'],
  ];
  for (const [label, rows, code] of cases) await t.test(label, async () => {
    let saves = 0, writes = 0;
    const account = new Account(data, {
      save: async () => { saves++; },
      fetcher: async (url, init) => {
        assert.equal(new URL(url).pathname, '/api/v1/keys');
        if (init.method !== 'GET') writes++;
        assert.equal(init.method, 'GET');
        return Response.json({ data: { items: rows } });
      },
    });
    await assert.rejects(account.keyFor(group, settings({ autoCreateKeys: true })), { code });
    assert.deepEqual(account.data, data);
    assert.equal(saves, 0);
    assert.equal(writes, 0);
  });
});
