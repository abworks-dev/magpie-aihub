import test from 'node:test';
import assert from 'node:assert/strict';
import { monitorSnapshot } from '../src/telemetry.mjs';
import { settings } from '../src/config.mjs';

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
  assert.equal(result.accounts[0].label, '账户 1');
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
