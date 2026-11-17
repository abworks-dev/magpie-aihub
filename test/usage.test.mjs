import test from 'node:test';
import assert from 'node:assert/strict';
import { usageCard } from '../src/usage.mjs';
import entry from '../index.mjs';

// The card only ever reads: these tests hand it a runtime whose billing read is
// a stub, so every assertion is about what the plugin tells magpie, not about
// the network. Field shapes follow src/billing.mjs (daily_limit_usd → dailyLimit
// and so on) and the host's auth.usage contract in magpie's internal/plugin/host.js.

const managed = (billing, extra = {}) => ({
  account: {
    data: { mode: 'managed', identity: 'ab***@example.test' },
    billingInfo: async () => billing,
    ...extra,
  },
  router: { spend: { usd: 1.5, tokens: 900 }, counters: { requests: 7, failures: 0 } },
});

test('a managed account shows its balance and the three platform budgets', async () => {
  const card = await usageCard(managed({
    balance: 12.345, balanceKnown: true, at: Date.now(),
    platforms: [
      { platform: 'openai', dailyLimit: 10, dailyUsage: 2.5, weeklyLimit: 70, weeklyUsage: 7, monthlyLimit: 300, monthlyUsage: 30 },
      { platform: 'deepseek', dailyLimit: 5, dailyUsage: 1.25, weeklyLimit: 35, weeklyUsage: 3.5, monthlyLimit: 150, monthlyUsage: 15 },
    ],
  }), {});

  assert.equal(card.plan, 'AIHub 账户');
  assert.equal(card.user, 'ab***@example.test');
  assert.equal(card.balance, '$12.35');
  assert.deepEqual(card.windows.map(w => w.name), ['今日', '本周', '本月']);
  const [today, week, month] = card.windows;
  assert.deepEqual(today, { name: '今日', used: 25, amount: 3.75, limit: 15, unit: 'USD' });
  assert.deepEqual(week, { name: '本周', used: 10, amount: 10.5, limit: 105, unit: 'USD' });
  assert.deepEqual(month, { name: '本月', used: 10, amount: 45, limit: 450, unit: 'USD' });
  assert.equal(card.error, undefined);
});

test('a platform without a limit never widens the budget it is measured against', async () => {
  const card = await usageCard(managed({
    balance: 0, balanceKnown: true,
    platforms: [
      { platform: 'kimi', dailyLimit: 4, dailyUsage: 1 },
      { platform: 'grok', dailyLimit: null, dailyUsage: 99 },   // no cap: its spend is not part of the budget
    ],
  }), {});

  assert.deepEqual(card.windows, [{ name: '今日', used: 25, amount: 1, limit: 4, unit: 'USD' }]);
});

test('a window with a limit and no spend yet reads as 0% instead of no share', async () => {
  const card = await usageCard(managed({
    balanceKnown: false,
    platforms: [{ platform: 'zhipu', dailyLimit: 8, dailyUsage: null, weeklyLimit: null, weeklyUsage: null }],
  }), {});

  assert.equal(card.balance, undefined);                      // "no wallet field" is not "$0.00"
  assert.deepEqual(card.windows, [{ name: '今日', used: 0, amount: 0, limit: 8, unit: 'USD' }]);
});

test('spending past the limit keeps the overspent share magpie draws', async () => {
  const card = await usageCard(managed({
    balanceKnown: false,
    platforms: [{ platform: 'openai', dailyLimit: 10, dailyUsage: 12 }],
  }), {});

  assert.equal(card.windows[0].used, 120);
});

test('an AIHub that answers no quota falls back to the calls this plugin made', async () => {
  const card = await usageCard(managed({ balance: 3, balanceKnown: true, platforms: [] }), {});

  assert.equal(card.balance, '$3.00');
  assert.deepEqual(card.windows, [{ name: '本次运行', display: '7 次请求 · $1.50', used: null, aside: true }]);
});

test('a daily budget the user set is shown when AIHub names no allowance', async () => {
  const card = await usageCard(managed({ balanceKnown: false, platforms: [] }), { dailyBudget: 6 });

  assert.deepEqual(card.windows, [{ name: '今日预算', used: 25, amount: 1.5, limit: 6, unit: 'USD' }]);
});

test('a failed read says why, and still names the local spend', async () => {
  const card = await usageCard(managed(undefined, { billingError: 'billing_sign_in_required' }), {});

  assert.equal(card.plan, 'AIHub 账户');
  assert.equal(card.error, 'AIHub 登录已失效，请重新登录后刷新');
  assert.deepEqual(card.windows, [{ name: '本次运行', display: '7 次请求 · $1.50', used: null, aside: true }]);
});

test('imported group keys have no wallet or platform budget, and say so', async () => {
  let asked = 0;
  const card = await usageCard({
    account: {
      data: { mode: 'manual', identity: 'Imported group keys' },
      billingInfo: async () => { asked += 1; },
    },
    router: { spend: { usd: 0.42 }, counters: { requests: 3 } },
  }, { dailyBudget: 0 });

  assert.equal(asked, 0, 'manual accounts never call the AIHub quota endpoints');
  assert.equal(card.plan, '导入分组 Key');
  assert.equal(card.balance, undefined);
  assert.deepEqual(card.windows, [{ name: '本次运行', display: '3 次请求 · $0.42', used: null, aside: true }]);
});

test('a read that throws past billingInfo becomes the card error, not a rejection', async () => {
  const card = await usageCard({
    account: {
      data: { mode: 'managed', identity: 'ab***@example.test' },
      billingInfo: async () => { throw new Error('The operation was aborted'); },
    },
    router: { spend: { usd: 0 }, counters: { requests: 0 } },
  }, {});

  assert.equal(card.error, 'The operation was aborted');
  assert.deepEqual(card.windows, [{ name: '本次运行', display: '0 次请求 · $0.00', used: null, aside: true }]);
});

test('the plugin answers magpie auth.usage from the AIHub account it was signed in with', async () => {
  const priorFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    asked.push(path);
    assert.equal(init.method ?? 'GET', 'GET');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-access');
    const fixtures = {
      '/api/v1/auth/me': { balance: 20.5, concurrency: 8, rpm_limit: 60 },
      '/api/v1/usage/stats': { total_requests: 12, total_tokens: 3400, total_cost: 1.2, total_actual_cost: 0.96 },
      '/api/v1/user/platform-quotas': {
        platform_quotas: [
          { platform: 'openai', daily_limit_usd: 10, daily_usage_usd: 2.5, weekly_limit_usd: 70, weekly_usage_usd: 7, monthly_limit_usd: 300, monthly_usage_usd: 30 },
          { platform: 'deepseek', daily_limit_usd: 5, daily_usage_usd: 1, weekly_limit_usd: 35, weekly_usage_usd: 3.5, monthly_limit_usd: 150, monthly_usage_usd: 15 },
        ],
      },
    };
    assert.ok(Object.hasOwn(fixtures, path), `auth.usage must stay a read: ${path}`);
    return Response.json({ code: 0, data: fixtures[path] });
  };
  try {
    const hooks = await entry.server({ client: {} });
    assert.equal(typeof hooks.auth.usage, 'function', 'magpie only shows a card for a plugin that tells its usage');
    const key = JSON.stringify({
      version: 1, mode: 'managed', instanceId: 'usage-hook', identity: 'ab***@example.test',
      access: 'synthetic-access', refresh: 'synthetic-refresh', keys: [],
    });
    const card = await hooks.auth.usage(async () => ({ type: 'api', key }), {});
    assert.equal(card.plan, 'AIHub 账户');
    assert.equal(card.user, 'ab***@example.test');
    assert.equal(card.balance, '$20.50');
    assert.deepEqual(card.windows, [
      { name: '今日', used: 23.3, amount: 3.5, limit: 15, unit: 'USD' },
      { name: '本周', used: 10, amount: 10.5, limit: 105, unit: 'USD' },
      { name: '本月', used: 10, amount: 45, limit: 450, unit: 'USD' },
    ]);
    assert.deepEqual(asked.sort(), ['/api/v1/auth/me', '/api/v1/usage/stats', '/api/v1/user/platform-quotas']);
  } finally { globalThis.fetch = priorFetch; }
});
