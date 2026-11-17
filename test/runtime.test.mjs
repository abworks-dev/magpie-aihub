import test from 'node:test';
import assert from 'node:assert/strict';
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

test('data without an instanceId is returned untouched', () => {
  const runtimes = new Map();
  const data = { mode: 'managed', keys: [] };
  assert.equal(adoptRuntime(runtimes, data), data);
  assert.equal(runtimes.size, 0);
});
