import test from 'node:test';
import assert from 'node:assert/strict';
import { monitorSnapshot } from '../src/telemetry.mjs';
import { snapshotView } from '../src/service.mjs';
import { settings } from '../src/config.mjs';

const runtime = (endpoints) => ({
  account: {
    data: { mode: 'manual', keys: [{ groupId: 7, key: 'DO_NOT_EXPOSE_KEY' }] },
    catalogue: async () => {},
    directoryRows: [{ groupId: 7, name: 'group seven', platform: 'openai', multiplier: 0.1, available: true, passed: true, metrics: { tps: 10 }, advertisedModels: ['m'] }],
    snapshot: { at: 1 },
  },
  router: {
    prune() {}, sessions: new Map(), cooldown: new Map(), lastRoutes: [],
    inflight: new Map([[7, 2]]),
    endpoints: { report: () => endpoints },
  },
});

test('the monitor reports endpoint health and the in-flight count per group', async () => {
  const options = settings({ endpoints: [{ url: 'https://aihub.top', label: '默认' }, { url: 'https://aihub.dog', label: '优化' }], endpointMode: 'balance' });
  const result = await monitorSnapshot(new Map([['x', runtime([
    { url: 'https://aihub.top', label: '默认', latencyMs: 210, failures: 0, wins: 3, ok: true, cooldownUntil: null },
    { url: 'https://aihub.dog', label: '优化', latencyMs: null, failures: 2, wins: 0, ok: false, cooldownUntil: 9999 },
  ])]]), options, () => 1000);
  assert.equal(result.endpointMode, 'balance');
  assert.deepEqual(result.endpoints.map(row => row.url), ['https://aihub.top', 'https://aihub.dog']);
  assert.equal(result.endpoints[0].latencyMs, 210);
  assert.equal(result.endpoints[1].ok, false);
  assert.equal(result.endpoints[1].failures, 2);
  assert.equal(result.accounts[0].groups[0].inflight, 2);
});

test('the service view keeps only the endpoint fields the page draws', () => {
  const view = JSON.parse(snapshotView({
    schemaVersion: 1, generatedAt: 1, endpointMode: 'failover',
    endpoints: [
      { url: 'https://aihub.top', label: '默认', latencyMs: 200, failures: 0, ok: true, cooldownUntil: null, token: 'DO_NOT_EXPOSE' },
      { url: '', label: 'dropped' },
    ],
    accounts: [],
  }));
  assert.equal(view.endpointMode, 'failover');
  assert.equal(view.endpoints.length, 1);
  assert.deepEqual(Object.keys(view.endpoints[0]).sort(), ['cooldownUntil', 'failures', 'label', 'latencyMs', 'ok', 'url']);
  assert.doesNotMatch(JSON.stringify(view), /DO_NOT_EXPOSE/);
});
