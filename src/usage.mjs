// Magpie's usage card for an AIHub account, read through auth.usage (magpie's
// own hook; OpenCode ignores it). AIHub itself names the allowance: the wallet
// balance in dollars, then the six platforms' own daily, weekly and monthly
// budgets. Each budget row sums the platforms that publish a limit, so the card
// says "how much of what AIHub allows this account is spent" instead of
// inventing a percentage from local counters.
//
// Everything here is read-only evidence, on the same 60-second cache the page
// uses (Account.billingInfo). A failed read says why in the card instead of
// showing a number: the plugin never guesses an allowance.

const money = (n) => {
  const rounded = (Math.round(Math.abs(n) * 100) / 100).toFixed(2);
  return (n < 0 ? '-$' : '$') + rounded;
};
const round2 = (n) => Math.round(n * 100) / 100;
const share = (amount, limit) => (limit > 0 ? Math.max(0, Math.round((amount / limit) * 1000) / 10) : null);
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// The reasons billing reads fail, in the reader's language. They come from
// Account.billingInfo, which sets one code and keeps the previous snapshot up
// to maxStaleMs; the card shows the code only when there is nothing to show.
const billingErrors = {
  billing_sign_in_required: 'AIHub 登录已失效，请重新登录后刷新',
  billing_session_expired: 'AIHub 会话已过期，请重新登录后刷新',
  billing_access_denied: '该 AIHub 账户不允许读取额度',
  billing_unavailable: 'AIHub 未回应额度查询，稍后自动重试',
};

// budgets sums one period over the platforms that publish a limit for it. A
// platform with usage but no limit is left out of both sides: adding its spend
// to a total it never bounds would read as more of the allowance than exists.
function budgets(platforms, limitKey, usageKey) {
  let amount = 0;
  let limit = 0;
  let counted = 0;
  for (const row of platforms ?? []) {
    const cap = finite(row?.[limitKey]);
    if (cap === null || cap <= 0) continue;
    counted += 1;
    limit += cap;
    amount += Math.max(0, finite(row?.[usageKey]) ?? 0);
  }
  if (!counted) return null;
  return { amount: round2(amount), limit: round2(limit), used: share(amount, limit) };
}

function periodWindow(name, budget) {
  if (!budget) return null;
  return { name, used: budget.used, amount: budget.amount, limit: budget.limit, unit: 'USD' };
}

// spendWindow is what the plugin itself knows when AIHub's quota endpoints say
// nothing: the requests it routed and what they cost, or its own daily budget
// when the user set one (a count the gateway cannot read from AIHub).
function spendWindow(item, options) {
  const spend = finite(item?.router?.spend?.usd) ?? 0;
  const requests = finite(item?.router?.counters?.requests) ?? 0;
  const budget = finite(options?.dailyBudget) ?? 0;
  if (budget > 0) {
    return { name: '今日预算', used: share(spend, budget), amount: round2(spend), limit: round2(budget), unit: 'USD' };
  }
  return { name: '本次运行', display: `${requests} 次请求 · ${money(spend)}`, used: null, aside: true };
}

// walletWindow is what AIHub says about the wallet itself when it publishes no
// platform limits: the calls the account has made and what they cost. It stays
// a text row because a wallet total has no ceiling to draw a share against.
function walletWindow(usage) {
  const requests = finite(usage?.requests);
  const cost = finite(usage?.cost) ?? finite(usage?.actualCost);
  if (cost === null && requests === null) return null;
  const spent = cost === null ? '未报告花费' : money(cost);
  const calls = requests === null ? '' : ` · ${requests} 次请求`;
  return { name: '累计消耗', display: `${spent}${calls}`, used: null, aside: true };
}

/**
 * usageCard answers magpie's auth.usage for one AIHub account.
 *
 * @param {{account?: object, router?: object}} item the plugin runtime of the account
 * @param {object} options the plugin options (as magpie passes them)
 * @param {{signal?: AbortSignal}} [scope]
 */
export async function usageCard(item, options, { signal } = {}) {
  const account = item?.account;
  if (!account) return { error: 'AIHub 账户尚未加载完成' };
  const identity = typeof account.data?.identity === 'string' ? account.data.identity : '';
  const managed = account.data?.mode === 'managed';
  const card = { plan: managed ? 'AIHub 账户' : '导入分组 Key' };
  if (identity) card.user = identity;

  // Imported group keys carry no AIHub session, so there is no wallet or
  // platform budget to read: the card names what this plugin itself routed.
  if (!managed) {
    card.windows = [spendWindow(item, options)];
    return card;
  }

  let billing;
  try {
    billing = await account.billingInfo(options, signal);
  } catch (error) {
    // billingInfo keeps its own reason for a failed read; anything thrown past
    // it is the read being aborted or the account data being unusable.
    return { ...card, windows: [spendWindow(item, options)], error: String(error?.message ?? error ?? '额度读取失败') };
  }

  if (!billing) {
    card.windows = [spendWindow(item, options)];
    const code = billingErrors[account.billingError] ?? (account.billingError ? '额度读取失败' : '');
    if (code) card.error = code;
    return card;
  }

  if (billing.balanceKnown && finite(billing.balance) !== null) card.balance = money(billing.balance);
  const platforms = Array.isArray(billing.platforms) ? billing.platforms : [];
  const windows = [
    periodWindow('今日', budgets(platforms, 'dailyLimit', 'dailyUsage')),
    periodWindow('本周', budgets(platforms, 'weeklyLimit', 'weeklyUsage')),
    periodWindow('本月', budgets(platforms, 'monthlyLimit', 'monthlyUsage')),
  ].filter(Boolean);
  // No platform publishes a limit (an organization or quota-only account, or an
  // AIHub that answers nothing about quotas): the card still names what the
  // wallet itself has spent rather than sitting empty. A run row that only says
  // "0 requests · $0.00" (usually a plugin that has just restarted) is dropped
  // when the wallet row can speak instead.
  const rows = [spendWindow(item, options), walletWindow(billing.usage)].filter(Boolean);
  const spent = finite(item?.router?.spend?.usd) ?? 0;
  const calls = finite(item?.router?.counters?.requests) ?? 0;
  if (rows.length > 1 && rows[0].name === '本次运行' && spent === 0 && calls === 0) rows.shift();
  card.windows = windows.length ? windows : rows;
  return card;
}
