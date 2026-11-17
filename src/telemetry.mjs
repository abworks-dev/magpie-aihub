// Explicit public-state projection. Never serialize Account.data or raw remote payloads.
import { SessionExpired } from './errors.mjs';
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').slice(0, 160) : '';

export const maskIdentity = identity => {
  const raw = typeof identity === 'string' ? identity.trim() : '';
  if (!raw) return '';
  const at = raw.indexOf('@');
  const local = [...(at === -1 ? raw : raw.slice(0, at))].slice(0, 2).join('');
  if (!local) return '';
  const domain = at === -1 ? '' : raw.slice(at + 1).trim();
  return domain ? `${local}***@${domain}` : `${local}***`;
};

export async function monitorSnapshot(runtimes, options, now = Date.now) {
  const accounts = [];
  for (const { account, router } of [...runtimes.values()].slice(0, 32)) {
    let errorCode;
    try { await account.catalogue(options, AbortSignal.timeout(15000)); }
    catch (error) { errorCode = error instanceof SessionExpired ? 'session_expired' : error?.status === 401 ? 'account_sign_in_required' : error?.status === 403 ? 'catalogue_access_denied' : 'catalogue_unavailable'; }
    router.prune();
    let billing;
    try { billing = await account.billingInfo(options, AbortSignal.timeout(15000)); }
    catch { billing = undefined; }
    const rows = account.directoryRows ?? account.snapshot?.rows ?? [];
    const groups = rows.slice(0, 500).map(c => {
      const reasons = [];
      if (c.routeEligible === false) reasons.push('分组未发布、非活动或费率证据不完整');
      if (!options.platforms.includes(c.platform ?? 'openai')) reasons.push('平台未启用');
      if (options.excludedGroups.includes(c.groupId)) reasons.push('手工排除');
      if (options.allowedGroups.length && !options.allowedGroups.includes(c.groupId)) reasons.push('不在允许分组中');
      const cap = options.platformCaps?.[c.platform ?? 'openai'] ?? options.maxMultiplier;
      if (typeof c.multiplier !== 'number') reasons.push('实际倍率未知');
      else if (c.multiplier > cap) reasons.push('超过倍率上限');
      if (c.available === false) reasons.push('大厅报告不可用');
      if (c.blocked) reasons.push('模型检测失败');
      if (options.requirePassed && c.passed !== true) reasons.push('没有检测通过证据');
      const cooldownUntil = router.cooldown.get(c.groupId) ?? 0;
      if (cooldownUntil > now()) reasons.push('故障冷却中');
      const selectedCount = [...router.sessions.values()].filter(s => s.groupId === c.groupId).length;
      const last = [...(router.lastRoutes ?? [])].reverse().find(r => r.groupId === c.groupId);
      return {
        groupId: c.groupId, name: text(c.name) || `分组 ${c.groupId}`, platform: text(c.platform) || 'openai',
        multiplier: finite(c.multiplier), available: typeof c.available === 'boolean' ? c.available : null,
        passed: typeof c.passed === 'boolean' ? c.passed : c.blocked === true ? false : null, latency: finite(c.latency),
        detection: text(c.detection) || null, detectionAt: finite(c.detectionAt),
        badges: Array.isArray(c.badges) ? c.badges.filter(b => typeof b === 'string').slice(0, 6).map(text) : [],
        cards: Array.isArray(c.cards) ? c.cards.slice(0, 60).filter(m => typeof m?.model === 'string').map(m => ({
          model: text(m.model), alias: text(m.alias) || null, price: finite(m.price),
          health: text(m.health) || null, sampleCount: finite(m.sampleCount),
        })) : [],
        metrics: {
          successRate: finite(c.metrics?.successRate), cacheHitRate: finite(c.metrics?.cacheHitRate),
          tps: finite(c.metrics?.tps), realPrice: finite(c.metrics?.realPrice),
          samples: finite(c.metrics?.samples), observedSeconds: finite(c.metrics?.observedSeconds),
          successRate1h: finite(c.metrics?.successRate1h), totalMs: finite(c.metrics?.totalMs),
          pingMs: finite(c.metrics?.pingMs), reputation: finite(c.metrics?.reputation),
        },
        models: [...new Set(c.advertisedModels ?? c.models ?? [])].filter(id => typeof id === 'string').slice(0, 200).map(text),
        eligible: reasons.length === 0, reasons, hasKey: account.data.keys.some(k => k.groupId === c.groupId),
        selectedCount, cooldownUntil, lastUsedAt: finite(last?.at),
      };
    });
    accounts.push({
      label: maskIdentity(account.data.identity) || `账户 ${accounts.length + 1}`, mode: account.data.mode,
      sourceUpdatedAt: finite(account.snapshot?.at), stale: Boolean(errorCode) || account.remoteStale === true,
      ...(errorCode ? { errorCode } : {}), groups,
      routes: (router.lastRoutes ?? []).slice(-100).map(r => ({ platform: text(r.platform), model: text(r.model), groupId: r.groupId, at: finite(r.at), outcome: text(r.outcome) })),
      spend: { day: text(router.spend?.day), usd: finite(router.spend?.usd), tokens: finite(router.spend?.tokens) },
      budget: finite(options.dailyBudget),
      priceChanges: (router.priceChanges ?? []).slice(-5).map(change => ({
        groupId: change.groupId, name: text(change.name), from: finite(change.from), to: finite(change.to), at: finite(change.at),
      })),
      keys: account.data.keys.slice(0, 32).map(key => ({
        groupId: key.groupId, platform: text(key.platform ?? 'openai'), owned: key.owned === true,
        lastUsedAt: finite([...router.lastRoutes].reverse().find(route => route.groupId === key.groupId)?.at),
      })),
      keyState: { ready: account.data.keys.length, pending: account.data.pending ? 1 : 0, autoCreateKeys: options.autoCreateKeys, maxKeysPerAccount: options.maxKeysPerAccount, minBalance: options.minBalance },
      billing: billing ? {
        at: finite(billing.at), balance: finite(billing.balance), balanceKnown: billing.balanceKnown === true,
        frozen: finite(billing.frozen), recharged: finite(billing.recharged),
        notify: billing.notify ? { enabled: billing.notify.enabled, threshold: finite(billing.notify.threshold), kind: text(billing.notify.kind) } : null,
        usage: billing.usage ? {
          requests: finite(billing.usage.requests), tokens: finite(billing.usage.tokens),
          cost: finite(billing.usage.cost), actualCost: finite(billing.usage.actualCost),
        } : null,
        platforms: (billing.platforms ?? []).map(p => ({
          platform: text(p.platform),
          dailyLimit: finite(p.dailyLimit), dailyUsage: finite(p.dailyUsage),
          weeklyLimit: finite(p.weeklyLimit), weeklyUsage: finite(p.weeklyUsage),
          monthlyLimit: finite(p.monthlyLimit), monthlyUsage: finite(p.monthlyUsage),
        })),
      } : null,
      billingError: account.billingError ?? null,
      keyEvents: Array.isArray(account.audit) ? account.audit.slice(-8) : [],
    });
  }
  return { schemaVersion: 1, generatedAt: now(), accounts };
}
