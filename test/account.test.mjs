import test from 'node:test';
import assert from 'node:assert/strict';
import { Account } from '../src/account.mjs';
import { BASE, ORIGIN, manualBundle, settings } from '../src/config.mjs';

const group = { groupId: 42, multiplier: 0.1 };
const options = extra => settings({ autoCreateKeys: true, ...extra });
const managed = extra => ({
  version: 1, mode: 'managed', instanceId: 'test-instance-1234567890',
  access: 'management-access', refresh: 'original-refresh', keys: [], ...extra,
});
const json = (body, status = 200) => Response.json(body, { status });
const pathOf = url => new URL(url).pathname;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// Every Account has an injected fetcher. Responses are local Web API objects only.
test('pending creation must be durably saved before POST, and create sends only name and group_id', async () => {
  const saveStarted = deferred(), releaseSave = deferred();
  const events = [], snapshots = [], posts = [];
  const account = new Account(managed(), {
    save: async data => {
      snapshots.push(structuredClone(data));
      if (data.pending) { events.push('persist-pending'); saveStarted.resolve(); await releaseSave.promise; }
      else events.push('persist-key');
    },
    fetcher: async (url, init) => {
      assert.equal(new URL(url).origin, ORIGIN);
      assert.equal(pathOf(url), '/api/v1/keys');
      if (init.method === 'GET') { events.push('list'); return json([]); }
      assert.equal(init.method, 'POST');
      events.push('create'); posts.push({ init, body: JSON.parse(init.body) });
      assert.ok(snapshots[0].pending, 'a durable pending snapshot exists before the create call');
      return json({ id: 100, key: 'new-dedicated-key', group_id: 42, name: JSON.parse(init.body).name });
    },
  });
  const operation = account.keyFor(group, options());
  await saveStarted.promise;
  assert.equal(posts.length, 0, 'the POST waits for persistence to resolve');
  assert.equal(snapshots[0].pending.groupId, group.groupId);
  assert.ok(snapshots[0].pending.idempotencyKey);
  releaseSave.resolve();
  const key = await operation;
  assert.deepEqual(events, ['list', 'persist-pending', 'create', 'persist-key']);
  assert.equal(posts.length, 1);
  assert.deepEqual(Object.keys(posts[0].body).sort(), ['group_id', 'name']);
  assert.equal(posts[0].body.group_id, group.groupId);
  assert.equal(posts[0].body.name, snapshots[0].pending.name);
  assert.equal(posts[0].init.headers.get('idempotency-key'), snapshots[0].pending.idempotencyKey);
  assert.equal(posts[0].init.redirect, 'error');
  assert.equal(key.key, 'new-dedicated-key');
  assert.equal(key.owned, true);
  assert.equal(snapshots.at(-1).pending, undefined);
  assert.deepEqual(snapshots.at(-1).keys, [key]);
});

test('persistence failure before creation prevents the POST', async () => {
  let posts = 0;
  const account = new Account(managed(), {
    save: async () => { throw new Error('persistence unavailable'); },
    fetcher: async (_url, init) => {
      if (init.method === 'POST') { posts++; return json({ id: 100, key: 'unexpected' }); }
      return json([]);
    },
  });
  await assert.rejects(account.keyFor(group, options()), /persistence unavailable/);
  assert.equal(posts, 0);
});

test('concurrent ensures for the same group serialize into one POST and one dedicated key', async () => {
  const createStarted = deferred(), releaseCreate = deferred();
  const calls = [];
  const account = new Account(managed(), {
    save: async () => {},
    fetcher: async (url, init) => {
      calls.push({ url, method: init.method });
      if (init.method === 'GET') return json([]);
      createStarted.resolve(); await releaseCreate.promise;
      return json({ id: 101, key: 'one-created-key', group_id: 42, name: JSON.parse(init.body).name });
    },
  });
  const first = account.keyFor(group, options());
  await createStarted.promise;
  const second = account.keyFor(group, options());
  const third = account.keyFor(group, options());
  releaseCreate.resolve();
  const keys = await Promise.all([first, second, third]);
  assert.deepEqual(keys.map(key => key.key), ['one-created-key', 'one-created-key', 'one-created-key']);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(account.data.keys.length, 1);
});

test('an unknown create outcome retains pending state across reload and never sends a second POST', async () => {
  let durable, posts = 0;
  const fetcher = async (_url, init) => {
    if (init.method === 'GET') return json([]);
    posts++;
    throw new Error('connection lost after request was sent');
  };
  const account = new Account(managed(), { save: async data => { durable = structuredClone(data); }, fetcher });
  await assert.rejects(account.keyFor(group, options()), /connection lost/);
  assert.ok(durable.pending);
  assert.equal(durable.keys.length, 0);
  const reloaded = new Account(durable, { save: async () => {}, fetcher });
  await assert.rejects(reloaded.keyFor(group, options()), { code: 'key_creation_pending' });
  await assert.rejects(reloaded.keyFor(group, options()), { code: 'key_creation_pending' });
  await assert.rejects(reloaded.keyFor({ ...group, groupId: 43 }, options()), { code: 'key_creation_pending' });
  assert.equal(posts, 1);
});

test('a pending create is recovered by its exact instance-specific name and group without another POST', async () => {
  const name = 'magpie-aihub-test-instanc-g42';
  const pending = { groupId: 42, name, idempotencyKey: 'previous-operation' };
  const methods = [], snapshots = [];
  const account = new Account(managed({ pending }), {
    save: async data => snapshots.push(data),
    fetcher: async (_url, init) => {
      methods.push(init.method);
      assert.equal(init.method, 'GET');
      return json([{ id: 102, key: 'recovered-key', name, group_id: 42, status: 'active' }]);
    },
  });
  const key = await account.keyFor(group, options());
  assert.equal(key.key, 'recovered-key');
  assert.deepEqual(methods, ['GET']);
  assert.equal(snapshots.at(-1).pending, undefined);
  assert.equal(snapshots.at(-1).keys.length, 1);
});

test('existing imported manual keys are returned unchanged with no remote mutation or management calls', async () => {
  const imported = { groupId: 42, key: 'manual-secret', multiplier: 0.1, remoteId: 77, name: 'human-owned-key', owned: false };
  const original = managed({ mode: 'manual', keys: [imported] });
  const calls = [], snapshots = [];
  const account = new Account(original, {
    save: async data => snapshots.push(data),
    fetcher: async (_url, init) => { calls.push(init.method); throw new Error('manual keys must not be managed remotely'); },
  });
  assert.deepEqual(await account.keyFor(group, options()), imported);
  assert.deepEqual(await account.keyFor(group, options()), imported);
  assert.deepEqual(account.data.keys, [imported]);
  assert.deepEqual(original.keys, [imported]);
  assert.deepEqual(calls, []);
  assert.deepEqual(snapshots, []);
});

test('unrelated existing remote keys are never adopted, deleted or updated', async () => {
  const calls = [];
  const account = new Account(managed(), {
    fetcher: async (url, init) => {
      calls.push({ url, method: init.method });
      assert.equal(init.method, 'GET');
      return json([
        { id: 1, name: 'my-manual-key', group_id: 42, key: 'manual-key', status: 'active' },
        { id: 2, name: 'magpie-aihub-another-inst-g42', group_id: 42, key: 'other-instance', status: 'active' },
      ]);
    },
  });
  await assert.rejects(account.keyFor(group, settings()), { code: 'key_creation_disabled' });
  assert.equal(account.data.keys.length, 0);
  assert.deepEqual(calls.map(call => call.method), ['GET']);
});

test('automatic key creation is disabled by default and requires explicit opt-in', async () => {
  assert.equal(settings().autoCreateKeys, false);
  let posts = 0;
  const account = new Account(managed(), {
    fetcher: async (_url, init) => { if (init.method === 'POST') posts++; return json([]); },
  });
  await assert.rejects(account.keyFor(group, settings()), { code: 'key_creation_disabled' });
  assert.equal(posts, 0);
  assert.equal(account.data.pending, undefined);
});

test('refresh persists replacement access and refresh tokens, retaining the previous refresh when omitted', async t => {
  for (const rotated of [false, true]) {
    await t.test(rotated ? 'rotated refresh token' : 'omitted refresh token', async () => {
      const snapshots = [], calls = [];
      let getCount = 0;
      const account = new Account(managed(), {
        save: async data => snapshots.push(structuredClone(data)),
        fetcher: async (url, init) => {
          calls.push({ path: pathOf(url), method: init.method, authorization: init.headers.get('authorization') });
          if (pathOf(url) === '/api/v1/auth/refresh') {
            assert.deepEqual(JSON.parse(init.body), { refresh_token: 'original-refresh' });
            return json({ access_token: 'replacement-access', ...(rotated ? { refresh_token: 'replacement-refresh' } : {}), expires_in: 3600 });
          }
          assert.equal(pathOf(url), '/api/v1/groups/available');
          if (getCount++ === 0) return json({ error: 'expired' }, 401);
          assert.equal(snapshots.length, 1, 'tokens are persisted before a read is replayed');
          assert.equal(init.headers.get('authorization'), 'Bearer replacement-access');
          return json([{ id: 42 }]);
        },
      });
      assert.deepEqual(await account.call('/api/v1/groups/available'), [{ id: 42 }]);
      assert.equal(snapshots.length, 1);
      assert.equal(snapshots[0].access, 'replacement-access');
      assert.equal(snapshots[0].refresh, rotated ? 'replacement-refresh' : 'original-refresh');
      assert.ok(snapshots[0].expires > Date.now());
      assert.deepEqual(calls.map(call => call.path), ['/api/v1/groups/available', '/api/v1/auth/refresh', '/api/v1/groups/available']);
    });
  }
});

test('a write rejected with 401 may refresh credentials but is never automatically replayed', async () => {
  let writes = 0, refreshes = 0;
  const account = new Account(managed(), {
    save: async () => {},
    fetcher: async (url, init) => {
      if (pathOf(url) === '/api/v1/auth/refresh') { refreshes++; return json({ access_token: 'replacement-access' }); }
      assert.equal(init.method, 'POST'); writes++;
      return json({ error: 'expired' }, 401);
    },
  });
  await assert.rejects(account.call('/api/v1/keys', { body: { name: 'safe-name', group_id: 42 } }), error => error.status === 401);
  assert.equal(writes, 1);
  assert.equal(refreshes, 1);
});

test('key recovery can refresh a 401 inside the key transaction without deadlocking or creating a key', async () => {
  const snapshots = [], calls = [];
  let listed = 0;
  const name = 'magpie-aihub-test-instanc-g42';
  const account = new Account(managed(), {
    save: async data => snapshots.push(structuredClone(data)),
    fetcher: async (url, init) => {
      calls.push({ path: pathOf(url), method: init.method });
      if (pathOf(url) === '/api/v1/auth/refresh') return json({ access_token: 'refreshed-inside-key-lock' });
      assert.equal(pathOf(url), '/api/v1/keys');
      assert.equal(init.method, 'GET');
      if (listed++ === 0) return json({ error: 'expired' }, 401);
      assert.equal(init.headers.get('authorization'), 'Bearer refreshed-inside-key-lock');
      assert.equal(snapshots[0].access, 'refreshed-inside-key-lock');
      return json([{ id: 103, key: 'recovered-after-refresh', group_id: 42, name, status: 'active' }]);
    },
  });
  let timer;
  try {
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('key recovery deadlocked during refresh')), 1500); });
    const key = await Promise.race([account.keyFor(group, settings()), deadline]);
    assert.equal(key.key, 'recovered-after-refresh');
    assert.equal(account.data.keys.length, 1);
    assert.equal(snapshots.at(-1).keys[0].key, 'recovered-after-refresh');
    assert.deepEqual(calls, [
      { path: '/api/v1/keys', method: 'GET' },
      { path: '/api/v1/auth/refresh', method: 'POST' },
      { path: '/api/v1/keys', method: 'GET' },
    ]);
  } finally { clearTimeout(timer); }
});

function catalogueFetcher({ v2Status = 200, groups, rates = {}, providers, calls = [] }) {
  return async (url, init) => {
    assert.equal(init.method, 'GET');
    const path = pathOf(url); calls.push(path);
    switch (path) {
      case '/api/v1/groups/available': return json(groups ?? [{ id: 42, platform: 'openai', status: 'active', rate_multiplier: 0.1 }]);
      case '/api/v1/groups/rates': return json(rates);
      case '/api/v2/public/providers': return v2Status === 200
        ? json(providers ?? [{ group_id: 42, platform: 'openai', visible_in_hall: true }])
        : json({ error: 'unavailable' }, v2Status);
      case '/api/v1/public/providers': return json(providers ?? [{ group_id: 42, platform: 'openai', visible_in_hall: true }]);
      default: throw new Error(`Unexpected management endpoint ${path}`);
    }
  };
}

test('/v2 public catalogue falls back to /v1 only for 404 and 410', async t => {
  for (const status of [200, 404, 410, 401, 403, 429, 500]) {
    await t.test(String(status), async () => {
      const calls = [];
      const account = new Account(managed({ refresh: '' }), { fetcher: catalogueFetcher({ v2Status: status, calls }) });
      if ([200, 404, 410].includes(status)) {
        const rows = await account.loadCatalogue();
        assert.deepEqual(rows.map(row => row.groupId), [42]);
      } else {
        await assert.rejects(account.loadCatalogue(), error => error.status === status);
      }
      assert.equal(calls.filter(path => path === '/api/v1/public/providers').length, [404, 410].includes(status) ? 1 : 0);
    });
  }
});

test('catalogue excludes groups with missing, malformed or negative multipliers', async t => {
  const invalid = [
    ['missing', undefined], ['null', null], ['empty', ''], ['nonnumeric', 'not-a-rate'],
    ['negative', -1], ['false', false], ['true', true], ['array', []], ['object', {}], ['whitespace', '   '],
  ];
  for (const [label, value] of invalid) {
    await t.test(label, async () => {
      const groupRow = { id: 42, platform: 'openai', status: 'active' };
      if (value !== undefined) groupRow.rate_multiplier = value;
      const account = new Account(managed(), { fetcher: catalogueFetcher({ groups: [groupRow] }) });
      assert.deepEqual(await account.loadCatalogue(), [], `${label} must not become a billable/free route by numeric coercion`);
    });
  }
});

test('malformed account-specific rates exclude a group even when nominal and public multipliers are valid', async t => {
  for (const [label, value] of [['null', null], ['empty', ''], ['false', false], ['array', []], ['nonnumeric', 'unknown'], ['negative', -1], ['whitespace', '   ']]) {
    await t.test(label, async () => {
      const account = new Account(managed(), {
        fetcher: catalogueFetcher({
          groups: [{ id: 42, platform: 'openai', status: 'active', rate_multiplier: 0.1 }],
          providers: [{ group_id: 42, platform: 'openai', rate_multiplier: 0.1 }], rates: { 42: value },
        }),
      });
      assert.deepEqual(await account.loadCatalogue(), [], 'an unknown actual account rate must not fall back to a nominal rate');
    });
  }
});

test('catalogue accepts a genuine zero multiplier and honors valid account-specific rates', async () => {
  const account = new Account(managed(), {
    fetcher: catalogueFetcher({
      groups: [{ id: 42, platform: 'openai', status: 'active', rate_multiplier: 0.5 }],
      rates: { 42: 0 }, providers: [{ group_id: 42, platform: 'openai', rate_multiplier: 0.8 }],
    }),
  });
  const rows = await account.loadCatalogue();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].multiplier, 0);
  assert.equal(settings({ maxMultiplier: 0 }).maxMultiplier, 0);
});

test('manual imports reject missing and malformed multipliers while preserving actual zero', () => {
  for (const multiplier of [undefined, null, '', '0', 'garbage', false, [], {}, -1]) {
    assert.throws(() => manualBundle(JSON.stringify([{ groupId: 42, key: 'manual-key', multiplier }])), /multiplier/i);
  }
  const [key] = manualBundle(JSON.stringify([{ groupId: 42, key: 'manual-key', multiplier: 0 }]));
  assert.equal(key.multiplier, 0);
  assert.equal(key.owned, false);
});

test('model catalogue uses only the group credential and rejects unsafe redirects', async () => {
  const calls = [];
  const account = new Account(managed(), {
    fetcher: async (url, init) => { calls.push({ url, init }); return json({ data: [{ id: 'model-a' }, { id: 'model-b' }] }); },
  });
  assert.deepEqual(await account.modelIds({ groupId: 42, key: 'group-only-secret' }, settings()), ['model-a', 'model-b']);
  assert.equal(calls[0].url, `${BASE}/models`);
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(Object.fromEntries(calls[0].init.headers instanceof Headers ? calls[0].init.headers : new Headers(calls[0].init.headers)), {
    accept: 'application/json', authorization: 'Bearer group-only-secret',
  });
  assert.equal(calls.length, 1);
});

test('the per-account Key cap blocks a new group before any key POST', async () => {
  let posts = 0;
  const account = new Account(managed({ keys: [{ groupId: 7, platform: 'openai', key: 'existing', remoteId: 1, name: 'existing', owned: true }] }), {
    save: async () => {},
    fetcher: async (_url, init) => { if (init.method === 'POST') posts++; return json([]); },
  });
  await assert.rejects(account.keyFor(group, options({ maxKeysPerAccount: 1 })), error => error.code === 'key_cap_reached');
  assert.equal(posts, 0);
  assert.equal(account.audit.at(-1).action, 'blocked');
  assert.equal(account.audit.at(-1).code, 'key_cap_reached');
});

test('a balance below the threshold stops new keys and still exposes the billing snapshot', async () => {
  let posts = 0;
  const calls = [];
  const account = new Account(managed(), {
    save: async () => {},
    fetcher: async (url, init) => {
      const path = pathOf(url); calls.push(path);
      if (path === '/api/v1/auth/me') return json({ balance: 1.25, frozen_balance: 0, total_recharged: 10 });
      if (path === '/api/v1/usage/stats') return json({ total_requests: 3, total_tokens: 900, total_cost: 0.5, total_actual_cost: 0.4 });
      if (path === '/api/v1/user/platform-quotas') return json({ platform_quotas: [{ platform: 'openai', daily_limit_usd: null, daily_usage_usd: 0.2, monthly_limit_usd: 5, monthly_usage_usd: 1.1 }] });
      if (init.method === 'POST') posts++;
      return json([]);
    },
  });
  await assert.rejects(account.keyFor(group, options({ minBalance: 5 })), error => error.code === 'balance_too_low');
  assert.equal(posts, 0);
  assert.equal(account.audit.at(-1).code, 'balance_too_low');
  const billing = await account.billingInfo(options({ minBalance: 5 }));
  assert.equal(billing.balance, 1.25);
  assert.equal(billing.balanceKnown, true);
  assert.equal(billing.usage.requests, 3);
  assert.equal(billing.platforms[0].monthlyLimit, 5);
  assert.ok(calls.includes('/api/v1/auth/me'));
});

test('an account with no wallet balance is flagged instead of reading as a failed read', async () => {
  const account = new Account(managed(), {
    save: async () => {},
    fetcher: async url => {
      const path = pathOf(url);
      if (path === '/api/v1/auth/me') return json({ frozen_balance: 0, concurrency: 8, rpm_limit: 60 });
      if (path === '/api/v1/usage/stats') return json({ total_requests: 0, total_tokens: 0, total_cost: 0 });
      return json({ platform_quotas: [] });
    },
  });
  const billing = await account.billingInfo(options());
  assert.equal(billing.balance, null);
  assert.equal(billing.balanceKnown, false);
  assert.equal(billing.frozen, 0);
  assert.equal(account.billingError, undefined, 'a present response is not a failed read');
});

test('billing keeps nulls when usage endpoints are unavailable and caches the refresh', async () => {
  let reads = 0;
  const account = new Account(managed(), {
    save: async () => {},
    fetcher: async url => {
      const path = pathOf(url);
      if (path === '/api/v1/auth/me') { reads++; return json({ balance: 3, frozen_balance: 0 }); }
      return json({ message: 'unavailable' }, 404);
    },
  });
  const billing = await account.billingInfo(options());
  assert.equal(billing.balance, 3);
  assert.equal(billing.usage, null);
  assert.deepEqual(billing.platforms, []);
  await account.billingInfo(options());
  assert.equal(reads, 1);
});

test('a rejected refresh reports an expired session instead of a bare 401', async () => {
  const account = new Account(managed(), { save: async () => {}, fetcher: async () => json({ error: 'expired' }, 401) });
  await assert.rejects(account.call('/api/v1/groups/available'), error =>
    error.name === 'SessionExpired' && error.code === 'session_expired' && error.status === 401);
});

test('the candidate pool size no longer caps the number of group keys', async () => {
  const account = new Account(managed(), {
    save: async () => {},
    fetcher: async (_url, init) => {
      if (init.method === 'POST') {
        const body = JSON.parse(init.body);
        return json({ id: 200 + body.group_id, key: `k-${body.group_id}`, group_id: body.group_id, name: body.name });
      }
      return json([]);
    },
  });
  const first = await account.keyFor(group, options({ poolSize: 1, maxKeysPerAccount: 4 }));
  const second = await account.keyFor({ ...group, groupId: 43 }, options({ poolSize: 1, maxKeysPerAccount: 4 }));
  assert.equal(first.groupId, 42);
  assert.equal(second.groupId, 43);
  assert.equal(account.data.keys.length, 2);
});

test('the per-account key limit is the one that stops a new key', async () => {
  const account = new Account(managed({ keys: [{ groupId: 42, platform: 'openai', key: 'k', remoteId: 1, owned: true }] }), {
    save: async () => {},
    fetcher: async () => json([]),
  });
  await assert.rejects(account.keyFor({ ...group, groupId: 43 }, options({ poolSize: 32, maxKeysPerAccount: 1 })), { code: 'key_cap_reached' });
});
