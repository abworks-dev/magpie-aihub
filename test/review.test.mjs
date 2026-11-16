import test from 'node:test';
import assert from 'node:assert/strict';
import { Account, accountSaver } from '../src/account.mjs';
import { Router } from '../src/router.mjs';
import { settings } from '../src/config.mjs';
import { waitFor } from '../src/async.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const bundle = () => ({ version: 1, mode: 'manual', instanceId: 'a', keys: [] });

test('a session at the capacity boundary remains sticky while a new session evicts to the limit', async () => {
  const rows = [{ groupId: 1, multiplier: 0.01 }, { groupId: 2, multiplier: 0.02 }];
  const account = { data: { mode: 'manual' }, catalogue: async () => rows,
    keyFor: async c => ({ groupId: c.groupId, key: `fake-${c.groupId}` }), modelIds: async () => ['model'] };
  const used = [];
  const router = new Router(account, settings({ strategy: 'speed', maxSessions: 1 }), {
    fetcher: async (_, init) => { used.push(init.headers.get('authorization')); return new Response('ok'); },
  });
  const send = async session => {
    const result = await router.fetch('https://aihub.top/v1/responses', { method: 'POST',
      headers: { 'x-aihub-auto-session': session }, body: JSON.stringify({ model: 'model', input: 'hi' }) });
    assert.equal(await result.text(), 'ok');
  };
  await send('existing');
  router.latency.set(1, 500); router.latency.set(2, 1);
  await send('existing');
  await send('new');
  assert.deepEqual(used, ['Bearer fake-1', 'Bearer fake-1', 'Bearer fake-2']);
  assert.equal(router.sessions.size, 1);
});

test('stalled inbound body is cancelled by total routing deadline', async () => {
  let cancelled = false;
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const request = new Request('https://aihub.top/v1/responses', { method: 'POST', body, duplex: 'half' });
    const router = new Router({}, settings({ totalTimeoutMs: 20 }));
    const result = await router.fetch(request);
    assert.equal(result.status, 503);
    assert.equal(cancelled, true);
  } finally { clearTimeout(keepAlive); }
});

test('later failed persistence cannot be hidden by earlier successful persistence', async () => {
  const first = deferred(); let calls = 0;
  const account = new Account(bundle(), { save: async () => { if (++calls === 1) await first.promise; else throw new Error('disk failed'); } });
  const a = account.save();
  await Promise.resolve();
  const b = account.save();
  const rejected = assert.rejects(b, /disk failed/);
  first.resolve(); await a; await rejected;
  assert.equal(account.dirty, true);
});

test('saving a disconnected or replaced account is refused', async () => {
  let calls = 0;
  const client = { auth: { set: async () => { calls++; } } };
  await assert.rejects(accountSaver(client, async () => undefined)(bundle()), /changed or disconnected/);
  await assert.rejects(accountSaver(client, async () => ({ key: JSON.stringify({ instanceId: 'b' }) }))(bundle()), /changed or disconnected/);
  assert.equal(calls, 0);
  await accountSaver(client, async () => ({ key: JSON.stringify(bundle()) }))(bundle());
  assert.equal(calls, 1);
});

test('shared work waiter respects its own deadline without duplicating work', async () => {
  const task = deferred(), abort = new AbortController();
  const promise = waitFor(task.promise, abort.signal);
  abort.abort(new Error('caller cancelled'));
  await assert.rejects(promise, /caller cancelled/);
  task.resolve(123);
  assert.equal(await task.promise, 123);
});

test('revoked key model discovery falls back to another group without inference on revoked key', async () => {
  const rows = [{ groupId: 1, multiplier: 0.01 }, { groupId: 2, multiplier: 0.02 }];
  const account = { data: { mode: 'manual' }, catalogue: async () => rows,
    keyFor: async c => ({ groupId: c.groupId, key: `fake-${c.groupId}` }),
    modelIds: async k => { if (k.groupId === 1) throw new Error('401'); return ['model']; },
  };
  const calls = [];
  const router = new Router(account, settings(), { fetcher: async (_, init) => { calls.push(init.headers.get('authorization')); return new Response('ok'); } });
  const response = await router.fetch('https://aihub.top/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'model', input: 'hi' }) });
  assert.equal(await response.text(), 'ok');
  assert.deepEqual(calls, ['Bearer fake-2']);
});
