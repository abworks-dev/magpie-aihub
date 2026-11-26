import test from 'node:test';
import assert from 'node:assert/strict';
import { Account } from '../src/account.mjs';
import { settings } from '../src/config.mjs';
import { Router } from '../src/router.mjs';
import { adoptRuntime } from '../src/runtime.mjs';

const item = (instanceId, identity, mode, keys) => [instanceId, { account: { data: { instanceId, identity, mode, keys } } }];

test('a re-login retires the previous connection of the same identity and keeps its keys', () => {
  const runtimes = new Map([item('old', 'a@b.c', 'managed', [{ groupId: 1, key: 'k1' }])]);
  const adopted = adoptRuntime(runtimes, { instanceId: 'new', identity: 'a@b.c', mode: 'managed', keys: [] });
  assert.deepEqual([...runtimes.keys()], []);
  assert.deepEqual(adopted.keys, [{ groupId: 1, key: 'k1' }]);
});

test('a second account of the same provider keeps its own connection', () => {
  const runtimes = new Map([item('old', 'a@b.c', 'managed', [{ groupId: 1, key: 'k1' }])]);
  const adopted = adoptRuntime(runtimes, { instanceId: 'new', identity: 'x@y.z', mode: 'managed', keys: [] });
  assert.deepEqual([...runtimes.keys()], ['old']);
  assert.deepEqual(adopted.keys, []);
});

test('a re-login of one account retires only that account and keeps the others', () => {
  const runtimes = new Map([
    item('a-old', 'a@b.c', 'managed', [{ groupId: 1, key: 'k1' }]),
    item('b', 'x@y.z', 'managed', [{ groupId: 2, key: 'k2' }]),
  ]);
  const adopted = adoptRuntime(runtimes, { instanceId: 'a-new', identity: 'a@b.c', mode: 'managed', keys: [] });
  assert.deepEqual([...runtimes.keys()], ['b']);
  assert.deepEqual(adopted.keys, [{ groupId: 1, key: 'k1' }]);
});

test('a replacement that already carries keys does not inherit a second set', () => {
  const runtimes = new Map([item('old', 'a@b.c', 'managed', [{ groupId: 1, key: 'k1' }])]);
  const adopted = adoptRuntime(runtimes, { instanceId: 'new', identity: 'a@b.c', mode: 'managed', keys: [{ groupId: 9, key: 'k9' }] });
  assert.deepEqual(adopted.keys, [{ groupId: 9, key: 'k9' }]);
  assert.equal(runtimes.size, 0);
});

test('only the current connection survives, imported keys included', () => {
  const runtimes = new Map([item('manual-1', 'Imported group keys', 'manual', [{ groupId: 2, key: 'k2' }])]);
  const adopted = adoptRuntime(runtimes, { instanceId: 'manual-2', identity: 'Imported group keys', mode: 'manual', keys: [{ groupId: 3, key: 'k3' }] });
  assert.deepEqual([...runtimes.keys()], []);
  assert.deepEqual(adopted.keys, [{ groupId: 3, key: 'k3' }]);
});

const oldKey = {
  groupId: 1, name: 'magpie-aihub-old-g1', remoteId: 101, key: 'old-key', owned: true,
};
const authData = (instanceId, identity = 'a@b.c', keys = []) => ({
  version: 1, instanceId, identity, mode: 'managed', access: 'management-access', keys,
});
const oldRemote = { id: 101, group_id: 1, name: oldKey.name, status: 'active', created_at: '2020-01-01T00:00:00Z' };
const options = settings({ maxKeysPerAccount: 1, autoCreateKeys: true, evictIdleKeys: true });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('same-identity re-login carries active and sticky key holds but a second identity stays isolated', async () => {
  const calls = [];
  const fetcher = async (_url, { method, body }) => {
    calls.push(method);
    if (method === 'GET') return Response.json([oldRemote]);
    if (method === 'DELETE') return Response.json({});
    const { name, group_id } = JSON.parse(body);
    return Response.json({ id: 102, group_id, name, key: 'new-key' });
  };
  const prior = new Account(authData('old', undefined, [oldKey]), { fetcher });
  const router = new Router(prior, options);
  const release = prior.holdKey(1);
  router.sessions.set('session', { groupId: 1, until: Date.now() + 10000 });
  const runtimes = new Map([['old', { account: prior }]]);
  const unrelated = new Account(adoptRuntime(runtimes, authData('unrelated', 'x@y.z')), { fetcher });
  assert.notEqual(unrelated.keyState, prior.keyState);
  const current = new Account(adoptRuntime(runtimes, authData('new')), { fetcher });
  const nextRouter = new Router(current, options);
  const candidate = { groupId: 2 };
  await assert.rejects(current.keyFor(candidate, options), { code: 'key_cap_reached' });
  release();
  await assert.rejects(current.keyFor(candidate, options), { code: 'key_cap_reached' });
  assert.deepEqual(calls, ['GET', 'GET']);
  nextRouter.sessions.delete('session');
  assert.equal((await current.keyFor(candidate, options)).groupId, 2);
  assert.deepEqual(calls, ['GET', 'GET', 'GET', 'DELETE', 'POST']);
});

test('an issued deletion finishes on the old queue before the new runtime creates and saves', async () => {
  const startDelete = deferred(), finishDelete = deferred();
  const calls = [], saved = [];
  let rows = [oldRemote];
  const fetcher = async (_url, { method, body }) => {
    calls.push(method);
    if (method === 'GET') return Response.json(rows);
    if (method === 'DELETE') {
      startDelete.resolve();
      await finishDelete.promise;
      rows = [];
      return Response.json({});
    }
    const { name, group_id } = JSON.parse(body);
    return Response.json({ id: 103, group_id, name, key: 'new-key' });
  };
  const save = async data => saved.push({ instanceId: data.instanceId, groups: data.keys.map(key => key.groupId) });
  const prior = new Account(authData('old', undefined, [oldKey]), { fetcher, save });
  const running = prior.keyFor({ groupId: 2 }, options);
  const ended = assert.rejects(running, { name: 'SessionExpired' });
  await startDelete.promise;
  const current = new Account(adoptRuntime(new Map([['old', { account: prior }]]), authData('new')), { fetcher, save });
  const queued = current.keyFor({ groupId: 3 }, options);
  assert.deepEqual(calls, ['GET', 'DELETE']);
  finishDelete.resolve();
  await ended;
  assert.equal((await queued).groupId, 3);
  assert.deepEqual(calls, ['GET', 'DELETE', 'GET', 'POST']);
  assert.deepEqual(saved, [
    { instanceId: 'new', groups: [] }, { instanceId: 'new', groups: [] }, { instanceId: 'new', groups: [3] },
  ]);
});

test('data without an instanceId is returned untouched', () => {
  const runtimes = new Map();
  const data = { mode: 'managed', keys: [] };
  assert.equal(adoptRuntime(runtimes, data), data);
  assert.equal(runtimes.size, 0);
});
