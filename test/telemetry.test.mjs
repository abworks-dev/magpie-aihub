import test from 'node:test';
import assert from 'node:assert/strict';
import { monitorSnapshot } from '../src/telemetry.mjs';
import { settings } from '../src/config.mjs';
import { SessionExpired } from '../src/errors.mjs';

test('monitor projects only catalogue and route metadata, with anonymous account scope and no inference/key operations', async () => {
  let reads = 0;
  const runtimes = new Map([['secret-instance', {
    account: {
      data: { mode: 'managed', access: 'DO_NOT_EXPOSE_ACCESS', refresh: 'DO_NOT_EXPOSE_REFRESH', identity: 'private@example.invalid', keys: [{ groupId: 1, key: 'DO_NOT_EXPOSE_KEY' }], pending: { idempotencyKey: 'DO_NOT_EXPOSE_PENDING' } },
      catalogue: async () => { reads++; }, snapshot: { at: 1000 },
      directoryRows: [{ groupId: 1, name: 'Published supplier', platform: 'deepseek', multiplier: 0.2, available: false, passed: false, metrics: { tps: 42 }, advertisedModels: ['exact-model'] }],
    },
    router: { prune() {}, sessions: new Map([['DO_NOT_EXPOSE_SESSION', { groupId: 1 }]]), cooldown: new Map([[1, 4000]]), lastRoutes: [{ platform: 'deepseek', model: 'exact-model', groupId: 1, at: 2000, outcome: 'selected', prompt: 'DO_NOT_EXPOSE_PROMPT' }] },
  }]]);
  const result = await monitorSnapshot(runtimes, settings(), () => 3000);
  assert.equal(reads, 1);
  assert.equal(result.accounts[0].label, 'pr***@example.invalid');
  assert.equal(result.accounts[0].groups[0].selectedCount, 1);
  assert.equal(result.accounts[0].groups[0].eligible, false);
  assert.ok(result.accounts[0].groups[0].reasons.includes('超过倍率上限'));
  assert.ok(result.accounts[0].groups[0].reasons.includes('故障冷却中'));
  assert.equal(result.accounts[0].groups[0].metrics.tps, 42);
  assert.equal(result.accounts[0].groups[0].metrics.successRate, null);
  assert.equal(result.accounts[0].keyState.pending, 1);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXPOSE|private@example|secret-instance/);
});

test('monitor returns safe stale states for failed catalogue reads rather than raw exception text', async () => {
  const runtime = { account: { data: { mode: 'managed', keys: [] }, catalogue: async () => { throw Object.assign(new Error('SECRET_REMOTE_BODY'), { status: 403 }); } }, router: { prune() {}, cooldown: new Map(), sessions: new Map() } };
  const result = await monitorSnapshot(new Map([['any', runtime]]), settings());
  assert.equal(result.accounts[0].stale, true);
  assert.equal(result.accounts[0].errorCode, 'catalogue_access_denied');
  assert.deepEqual(result.accounts[0].groups, []);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_REMOTE_BODY/);
});

test('monitor exposes billing and key audit metadata without account identity', async () => {
  const runtime = {
    account: {
      data: { mode: 'managed', keys: [] },
      catalogue: async () => {},
      directoryRows: [],
      audit: [{ at: 10, action: 'created', groupId: 4, code: 'created' }],
      billingInfo: async () => ({
        at: 20, balance: 12.5, frozen: 0, recharged: 30,
        notify: { enabled: true, threshold: 2, kind: 'fixed' },
        usage: { requests: 5, tokens: 100, cost: 1, actualCost: 0.8 },
        platforms: [{ platform: 'openai', dailyLimit: null, dailyUsage: 0.2, weeklyLimit: null, weeklyUsage: null, monthlyLimit: null, monthlyUsage: null }],
      }),
    },
    router: { prune() {}, sessions: new Map(), cooldown: new Map(), lastRoutes: [] },
  };
  const result = await monitorSnapshot(new Map([['any', runtime]]), settings());
  assert.equal(result.accounts[0].billing.balance, 12.5);
  assert.equal(result.accounts[0].billing.usage.requests, 5);
  assert.equal(result.accounts[0].billingError, null);
  assert.deepEqual(result.accounts[0].keyEvents, [{ at: 10, action: 'created', groupId: 4, code: 'created' }]);
  assert.equal(result.accounts[0].keyState.maxKeysPerAccount, 8);
  assert.equal(result.accounts[0].keyState.minBalance, 0);
});

test('a dead session is reported as session_expired, not a generic catalogue failure', async () => {
  const runtime = { account: { data: { mode: 'managed', keys: [] }, catalogue: async () => { throw new SessionExpired(); } }, router: { prune() {}, cooldown: new Map(), sessions: new Map() } };
  const result = await monitorSnapshot(new Map([['dead', runtime]]), settings());
  assert.equal(result.accounts[0].errorCode, 'session_expired');
  assert.equal(result.accounts[0].stale, true);
});
