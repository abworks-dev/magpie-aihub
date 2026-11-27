import { validPlatform } from './platforms.mjs';

// Balance/usage read only. Everything here is optional evidence: when AIHub
// does not answer, the caller keeps its previous snapshot (marked stale) and
// the page shows a dash instead of inventing a number.
const number = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
};
const text = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').slice(0, 80) : '';

export async function loadBilling(account, signal) {
  const accountCheck = account.call('/api/v1/auth/me', { signal });
  const optionalRead = path => account.call(path, { signal }).catch(async error => {
    if (error?.status === 404 || error?.status === 403) return null;
    // Give a failed account check priority over an earlier quota failure.
    await accountCheck;
    throw error;
  });
  const [me, stats, quotas] = await Promise.all([
    accountCheck,
    optionalRead('/api/v1/usage/stats'),
    optionalRead('/api/v1/user/platform-quotas'),
  ]);
  const rows = Array.isArray(quotas?.platform_quotas) ? quotas.platform_quotas : [];
  const balance = number(me?.balance);
  return {
    at: Date.now(),
    balance,
    // Distinguishes "the account carries no wallet balance" (organization or
    // quota-only account, the field is absent) from "the read failed" (no
    // billing object at all, billingError explains why). The page shows a dash
    // either way, but only this flag lets it say which case it is.
    balanceKnown: balance !== null,
    frozen: number(me?.frozen_balance),
    recharged: number(me?.total_recharged),
    concurrency: number(me?.concurrency),
    rpmLimit: number(me?.rpm_limit),
    notify: {
      enabled: me?.balance_notify_enabled === true,
      threshold: number(me?.balance_notify_threshold),
      kind: text(me?.balance_notify_threshold_type) || null,
    },
    usage: stats ? {
      requests: number(stats.total_requests),
      tokens: number(stats.total_tokens),
      cost: number(stats.total_cost),
      actualCost: number(stats.total_actual_cost),
    } : null,
    platforms: rows.slice(0, 12).map(row => ({
      platform: validPlatform(row?.platform) ? row.platform : text(row?.platform) || 'unknown',
      dailyLimit: number(row?.daily_limit_usd), dailyUsage: number(row?.daily_usage_usd),
      weeklyLimit: number(row?.weekly_limit_usd), weeklyUsage: number(row?.weekly_usage_usd),
      monthlyLimit: number(row?.monthly_limit_usd), monthlyUsage: number(row?.monthly_usage_usd),
    })),
  };
}
