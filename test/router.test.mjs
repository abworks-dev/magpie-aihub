import test from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/router.mjs';
import { BASE, ORIGIN, settings } from '../src/config.mjs';

const model = 'test-model';
const candidate = (groupId, extra = {}) => ({ groupId, multiplier: 0.1, latency: groupId * 10, ...extra });
const request = (body = {}, headers = {}, extra = {}) => new Request(`${BASE}/responses`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ model, input: 'hello', ...body }), ...extra,
});
const groupOf = init => Number(init.headers.get('authorization').replace('Bearer route-key-', ''));

function fixture(rows = [candidate(1), candidate(2)], options = {}, dependencies = {}) {
  const calls = [], prepared = [], discovered = [];
  const account = {
    data: { mode: 'manual', keys: rows.map(c => ({ groupId: c.groupId, key: `route-key-${c.groupId}` })) },
    catalogue: async () => rows,
    keyFor: async c => { prepared.push(c.groupId); return { groupId: c.groupId, key: `route-key-${c.groupId}` }; },
    modelIds: async key => { discovered.push(key.groupId); return [model]; },
  };
  const fetcher = async (url, init) => {
    calls.push({ url, init, group: groupOf(init) });
    return dependencies.respond ? dependencies.respond(url, init) : new Response(`group-${groupOf(init)}`);
  };
  const router = new Router(account, settings(options), { fetcher, ...(dependencies.now ? { now: dependencies.now } : {}) });
  return { router, account, calls, prepared, discovered };
}

async function consume(router, input) {
  const response = await router.fetch(input);
  return { response, text: await response.text() };
}

// All upstream traffic uses injected local fetchers; no test calls a live service.
test('same session remains sticky when observed speed rankings change; a new session follows the new ranking', async () => {
  let now = 1000;
  const { router, calls } = fixture([candidate(1, { latency: 10 }), candidate(2, { latency: 100 })],
    { strategy: 'speed' }, {
      now: () => now,
      respond: async (_url, init) => { now += groupOf(init) === 1 ? 200 : 10; return new Response('ok'); },
    });
  await consume(router, request({}, { 'x-aihub-auto-session': 'session-a' }));
  await consume(router, request({}, { 'x-aihub-auto-session': 'session-a' }));
  await consume(router, request({}, { 'x-aihub-auto-session': 'session-b' }));
  assert.deepEqual(calls.map(c => c.group), [1, 1, 2]);
});

test('price strategy prefers the lowest real price and falls back to the multiplier without one', async () => {
  const priced = fixture([candidate(1, { metrics: { realPrice: 0.9 } }), candidate(2, { metrics: { realPrice: 0.2 } })], { strategy: 'price' });
  await consume(priced.router, request());
  assert.equal(priced.calls[0].group, 2, 'the cheaper real price wins over the nominal multiplier');

  const bare = fixture([candidate(1, { multiplier: 0.2 }), candidate(2, { multiplier: 0.1 })], { strategy: 'price' });
  await consume(bare.router, request());
  assert.equal(bare.calls[0].group, 2, 'no real price falls back to the nominal multiplier');
});

test('a platform cap overrides the global multiplier ceiling', () => {
  const { router } = fixture([], { maxMultiplier: 0.16, platformCaps: { deepseek: 1 } });
  assert.equal(router.eligibleGroup({ groupId: 1, multiplier: 0.5, platform: 'deepseek' }), true, 'deepseek keeps a looser cap');
  assert.equal(router.eligibleGroup({ groupId: 2, multiplier: 0.5, platform: 'openai' }), false, 'openai keeps the global cap');
  assert.equal(router.eligibleGroup({ groupId: 3, multiplier: 0.05, platform: 'openai' }), true);
});

test('value strategy trades a lower price against delay and failure rate', async () => {
  const rows = [
    candidate(1, { multiplier: 0.05, latency: 10, metrics: { realPrice: 0.05, successRate: 0.6 } }),
    candidate(2, { multiplier: 0.09, latency: 20, metrics: { realPrice: 0.09, successRate: 1 } }),
  ];
  const { router, calls } = fixture(rows, { strategy: 'value', maxMultiplier: 1 });
  await consume(router, request());
  assert.equal(calls[0].group, 2, 'a slightly pricier route wins when the cheap one fails a third of the time');
});

test('reliable strategy ranks success rate above price', async () => {
  const rows = [
    candidate(1, { multiplier: 0.01, metrics: { realPrice: 0.01, successRate: 0.9 } }),
    candidate(2, { multiplier: 0.15, metrics: { realPrice: 0.15, successRate: 0.99 } }),
  ];
  const { router, calls } = fixture(rows, { strategy: 'reliable', maxMultiplier: 1 });
  await consume(router, request());
  assert.equal(calls[0].group, 2, 'the steadier route wins even though it costs fifteen times more');
});

test('429 fails over and excludes the failed route until Retry-After expires', async t => {
  for (const format of ['seconds', 'http-date']) {
    await t.test(format, async () => {
      let now = 1_700_000_000_000;
      const start = now;
      let limited = true;
      const retryAfter = format === 'seconds' ? '2' : new Date(start + 2000).toUTCString();
      const { router, calls } = fixture([candidate(1, { multiplier: 0.01 }), candidate(2)],
        { strategy: 'economy', cooldownMs: 100 }, {
          now: () => now,
          respond: async (_url, init) => {
            if (groupOf(init) === 1 && limited) { limited = false; return new Response('limited', { status: 429, headers: { 'retry-after': retryAfter } }); }
            return new Response('ok');
          },
        });
      assert.equal((await consume(router, request())).response.status, 200);
      now = start + 1999;
      assert.equal((await consume(router, request())).response.status, 200);
      now = start + 2000;
      assert.equal((await consume(router, request())).response.status, 200);
      assert.deepEqual(calls.map(c => c.group), [1, 2, 2, 1]);
    });
  }
});

test('a partial upstream stream failure reaches the caller without another inference attempt', async () => {
  let reads = 0;
  const { router, calls } = fixture(undefined, {}, {
    respond: async () => new Response(new ReadableStream({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode('first bytes'));
        else controller.error(new Error('upstream disconnected'));
      },
    })),
  });
  const response = await router.fetch(request());
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first bytes');
  await assert.rejects(reader.read(), /interrupted|disconnect|stream/i);
  assert.equal(calls.length, 1);
});

function pendingUntilAborted(signal, onAbort) {
  return new Promise((resolve, reject) => {
    // The finite fallback also keeps Node alive while the implementation's unref'ed timer runs.
    const fallback = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(new Response('too late')); }, 1000);
    function aborted() { clearTimeout(fallback); onAbort(signal.reason); reject(signal.reason); }
    if (signal.aborted) aborted();
    else signal.addEventListener('abort', aborted, { once: true });
  });
}

test('first-byte timeout aborts a fetch awaiting headers before trying the next route', async () => {
  const aborts = [];
  const { router, calls } = fixture(undefined, { firstByteTimeoutMs: 15, totalTimeoutMs: 2500 }, {
    respond: async (_url, init) => groupOf(init) === 1
      ? pendingUntilAborted(init.signal, reason => aborts.push(reason))
      : new Response('fallback'),
  });
  const { response, text } = await consume(router, request());
  assert.equal(response.status, 200);
  assert.equal(text, 'fallback');
  assert.deepEqual(calls.map(c => c.group), [1, 2]);
  assert.equal(aborts.length, 1);
  assert.match(String(aborts[0]), /timeout/i);
  assert.equal(calls[0].init.signal.aborted, true);
});

test('first-byte timeout aborts an upstream body that has headers but never produces a byte', async () => {
  let aborted = false;
  const { router, calls } = fixture(undefined, { firstByteTimeoutMs: 15, totalTimeoutMs: 2500 }, {
    respond: async (_url, init) => {
      if (groupOf(init) !== 1) return new Response('fallback');
      return new Response(new ReadableStream({
        start(controller) {
          const fallback = setTimeout(() => controller.enqueue(new TextEncoder().encode('too late')), 1000);
          init.signal.addEventListener('abort', () => {
            aborted = true; clearTimeout(fallback); controller.error(init.signal.reason);
          }, { once: true });
        },
      }));
    },
  });
  assert.equal((await consume(router, request())).text, 'fallback');
  assert.equal(aborted, true);
  assert.deepEqual(calls.map(c => c.group), [1, 2]);
});

test('caller cancellation while awaiting an upstream fetch aborts it and makes no extra attempt', async () => {
  const controller = new AbortController();
  const reason = new Error('caller stopped');
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let observedAbort;
  const { router, calls } = fixture(undefined, {}, {
    respond: (_url, init) => { started(); return pendingUntilAborted(init.signal, why => { observedAbort = why; }); },
  });
  const operation = router.fetch(request({}, {}, { signal: controller.signal }));
  await ready;
  controller.abort(reason);
  await assert.rejects(operation, error => error === reason);
  assert.equal(observedAbort, reason);
  assert.equal(calls.length, 1);
});

test('an already cancelled request does not prepare keys or start inference', async () => {
  const controller = new AbortController();
  const reason = new Error('already cancelled');
  controller.abort(reason);
  const { router, calls, prepared } = fixture();
  await assert.rejects(router.fetch(request({}, {}, { signal: controller.signal })), error => error === reason);
  assert.deepEqual(calls, []);
  assert.deepEqual(prepared, []);
});

test('cancelling the returned stream aborts and cancels its upstream without a replay', async () => {
  let cancelled = false;
  const { router, calls } = fixture(undefined, {}, {
    respond: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('start')); },
      cancel() { cancelled = true; },
    })),
  });
  const response = await router.fetch(request());
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel('consumer closed');
  assert.equal(cancelled, true);
  assert.equal(calls[0].init.signal.aborted, true);
  assert.equal(calls.length, 1);
});

test('model restrictions and failed model health exclude routes before key preparation', async () => {
  const { router, calls, prepared } = fixture([
    candidate(1, { models: ['other-model'] }),
    candidate(2, { models: [] }),
    candidate(3, { rejected: [model] }),
    candidate(4, { models: [model] }),
  ]);
  assert.equal((await consume(router, request())).response.status, 200);
  assert.deepEqual(prepared, [4]);
  assert.deepEqual(calls.map(c => c.group), [4]);
});

test('multiplier cap includes an exact cap and excludes more expensive groups', async () => {
  const { router, calls } = fixture([
    candidate(1, { multiplier: 0.151 }), candidate(2, { multiplier: 0.15 }),
  ], { maxMultiplier: 0.15 });
  await consume(router, request());
  assert.deepEqual(calls.map(c => c.group), [2]);
});

test('a zero multiplier cap permits only free groups and still honors explicit exclusions', async () => {
  const { router, calls } = fixture([
    candidate(1, { multiplier: 0 }), candidate(2, { multiplier: 0.001 }), candidate(3, { multiplier: 0 }),
  ], { maxMultiplier: 0, excludedGroups: [1] });
  assert.equal((await consume(router, request())).response.status, 200);
  assert.deepEqual(calls.map(c => c.group), [3]);
});

test('allowlist, availability, detection and passed requirements filter routes', async () => {
  const { router, calls } = fixture([
    candidate(1, { passed: true }), candidate(2, { available: false, passed: true }),
    candidate(3, { blocked: true, passed: true }), candidate(4), candidate(5, { passed: true }),
  ], { allowedGroups: [2, 3, 4, 5], requirePassed: true });
  await consume(router, request());
  assert.deepEqual(calls.map(c => c.group), [5]);
});

test('request and response headers use allowlists without leaking credentials or internal sessions', async () => {
  const body = { model, input: 'private input', stream: true };
  const { router, calls } = fixture([candidate(1)], {}, {
    respond: async () => new Response('ok', { headers: {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache',
      'set-cookie': 'upstream=secret', authorization: 'Bearer upstream-secret', 'x-upstream-private': 'secret',
    } }),
  });
  const { response } = await consume(router, request(body, {
    authorization: 'Bearer client-secret', cookie: 'client=secret', 'x-api-key': 'client-key',
    'x-aihub-auto-session': 'private-session', 'x-forwarded-for': '127.0.0.1',
    'openai-organization': 'private-org', accept: 'text/event-stream', 'openai-beta': 'responses=v1',
  }));
  assert.equal(calls[0].url, `${BASE}/responses`);
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(Object.fromEntries(calls[0].init.headers), {
    accept: 'text/event-stream', authorization: 'Bearer route-key-1',
    'content-type': 'application/json', 'openai-beta': 'responses=v1',
  });
  assert.deepEqual(JSON.parse(Buffer.from(calls[0].init.body).toString()), body);
  assert.deepEqual(Object.fromEntries(response.headers), { 'cache-control': 'no-cache', 'content-type': 'text/event-stream' });
});

test('unsafe destinations, paths and query strings are rejected before any account access', async t => {
  for (const url of [
    'https://evil.example/v1/responses', 'http://aihub.top/v1/responses',
    `${ORIGIN}/api/v1/keys`, `${BASE}/responses/extra`, `${BASE}/responses?redirect=evil`,
    `${BASE}/../api/v1/auth/refresh`,
  ]) {
    await t.test(url, async () => {
      const { router, account, calls, prepared } = fixture();
      let catalogueCalls = 0;
      account.catalogue = async () => { catalogueCalls++; throw new Error('must not be reached'); };
      const response = await router.fetch(new Request(url, { method: 'POST', body: JSON.stringify({ model }) }));
      assert.equal(response.status, 400);
      assert.equal(catalogueCalls, 0);
      assert.deepEqual(prepared, []);
      assert.deepEqual(calls, []);
    });
  }
});

test('stateful previous_response_id and conversation requests return 400 without inference', async t => {
  for (const body of [{ previous_response_id: 'resp-previous' }, { conversation: 'conv-existing' }]) {
    await t.test(JSON.stringify(body), async () => {
      const { router, calls, prepared } = fixture();
      const response = await router.fetch(request(body));
      assert.equal(response.status, 400);
      assert.deepEqual(calls, []);
      assert.deepEqual(prepared, []);
    });
  }
});

test('a model absent from every group model catalogue triggers no inference requests', async () => {
  const { router, account, calls, discovered } = fixture();
  account.modelIds = async key => { discovered.push(key.groupId); return ['other-model']; };
  const response = await router.fetch(request());
  assert.equal(response.status, 503);
  assert.deepEqual(discovered, [1, 2]);
  assert.deepEqual(calls, []);
});

test('inference attempts remain bounded even when every group is retryable', async () => {
  const { router, calls } = fixture(Array.from({ length: 6 }, (_, i) => candidate(i + 1)),
    { maxAttempts: 2 }, { respond: async () => new Response('unavailable', { status: 503 }) });
  assert.equal((await consume(router, request())).response.status, 503);
  assert.deepEqual(calls.map(c => c.group), [1, 2]);
});

test('ordinary 400 and 404 inference errors are returned without trying another group', async t => {
  for (const status of [400, 404]) {
    await t.test(String(status), async () => {
      const { router, calls } = fixture(undefined, {}, { respond: async () => new Response('caller error', { status }) });
      assert.equal((await consume(router, request())).response.status, status);
      assert.equal(calls.length, 1);
    });
  }
});

test('model discovery reads existing keys without preparing or creating keys', async () => {
  const { router, account, prepared, calls } = fixture();
  account.modelIds = async key => key.groupId === 1 ? ['z-model', model] : [model, 'a-model'];
  const response = await router.fetch(`${BASE}/models`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.map(row => row.id), ['a-model', model, 'z-model']);
  assert.deepEqual(prepared, []);
  assert.deepEqual(calls, []);
});
