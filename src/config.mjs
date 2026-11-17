import { PLATFORMS, validPlatform, modelDescriptor, protocolBase, protocolNpm } from './platforms.mjs';

export const PROVIDER = 'aihub-auto';
export const ORIGIN = 'https://aihub.top';
export const BASE = `${ORIGIN}/v1`;

const defaults = {
  maxMultiplier: 0.16, platformCaps: {}, strategy: 'balanced', maxAttempts: 3, poolSize: 4,
  minBalance: 0, maxKeysPerAccount: 8, balanceRefreshMs: 60_000,
  refreshMs: 60_000, maxStaleMs: 600_000, firstByteTimeoutMs: 30_000,
  totalTimeoutMs: 90_000, cooldownMs: 30_000, sessionTtlMs: 86_400_000,
  maxSessions: 5000, maxBodyBytes: 20 * 1024 * 1024,
  breakerWindowMs: 300_000, breakerMinSamples: 5, breakerFailureRate: 0.5,
  dailyBudget: 0, priceAlertRatio: 0.2,
  excludedGroups: [], allowedGroups: [], requirePassed: false,
  defaultApi: 'responses', models: [], autoCreateKeys: false,
  platforms: [...PLATFORMS], monitorPort: 19871,
  // Deprecated: the page service is always on, so this stored option is accepted
  // for older installs and otherwise ignored.
  monitorEnabled: false,
};

export function settings(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Options must be an object');
  for (const key of Object.keys(raw)) {
    if (!(key in defaults)) throw new Error(`Unknown option: ${key}. Secrets belong in the sign-in form.`);
  }
  const o = { ...defaults, ...raw };
  const numbers = {
    maxMultiplier: [0, 100], maxAttempts: [1, 5], poolSize: [1, 8],
    minBalance: [0, 100_000], maxKeysPerAccount: [1, 32], balanceRefreshMs: [10_000, 3_600_000],
    refreshMs: [10_000, 3_600_000], maxStaleMs: [10_000, 3_600_000],
    firstByteTimeoutMs: [10, 120_000], totalTimeoutMs: [10, 300_000],
    cooldownMs: [10, 3_600_000], sessionTtlMs: [1000, 604_800_000],
    maxSessions: [1, 50_000], maxBodyBytes: [1024, 50 * 1024 * 1024], monitorPort: [1024, 65535],
    breakerWindowMs: [10_000, 3_600_000], breakerMinSamples: [1, 100], breakerFailureRate: [0, 1],
    priceAlertRatio: [0.01, 10], dailyBudget: [0, 1_000_000],
  };
  for (const [key, [min, max]] of Object.entries(numbers)) {
    if (typeof o[key] !== 'number' || !Number.isFinite(o[key]) || o[key] < min || o[key] > max)
      throw new Error(`Invalid ${key}: expected ${min}..${max}`);
    if (!Number.isInteger(o[key]) && !['maxMultiplier', 'minBalance', 'dailyBudget', 'breakerFailureRate', 'priceAlertRatio'].includes(key))
      throw new Error(`${key} must be an integer`);
  }
  if (!['economy', 'balanced', 'speed', 'price', 'value', 'reliable'].includes(o.strategy)) throw new Error('Invalid strategy');
  if (!o.platformCaps || typeof o.platformCaps !== 'object' || Array.isArray(o.platformCaps)) throw new Error('platformCaps must be an object');
  for (const [platform, cap] of Object.entries(o.platformCaps)) {
    if (!validPlatform(platform)) throw new Error(`Unknown platform in platformCaps: ${platform}`);
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0 || cap > 100) throw new Error(`Invalid platformCaps.${platform}: expected 0..100`);
  }
  o.platformCaps = { ...o.platformCaps };
  if (!['responses', 'chat'].includes(o.defaultApi)) throw new Error('Invalid defaultApi');
  if ([o.requirePassed, o.autoCreateKeys, o.monitorEnabled].some(v => typeof v !== 'boolean')) throw new Error('Boolean option expected');
  if (!Array.isArray(o.platforms) || !o.platforms.length || !o.platforms.every(validPlatform) || new Set(o.platforms).size !== o.platforms.length) throw new Error('Invalid platforms');
  o.platforms = [...o.platforms];
  for (const key of ['excludedGroups', 'allowedGroups']) {
    if (!Array.isArray(o[key]) || !o[key].every(id => Number.isSafeInteger(id) && id > 0)) throw new Error(`Invalid ${key}`);
  }
  if (!Array.isArray(o.models) || o.models.length > 200) throw new Error('models must be an array of at most 200 entries');
  o.models = o.models.map(m => {
    m = modelDescriptor(m, o.defaultApi);
    for (const key of ['context', 'output']) if (m[key] !== undefined && (!Number.isSafeInteger(m[key]) || m[key] < 1)) throw new Error(`Invalid model ${key}`);
    return { ...m, api: m.api ?? o.defaultApi };
  });
  if (new Set(o.models.map(m => m.id)).size !== o.models.length) throw new Error('Duplicate model id');
  return o;
}

export function manualBundle(text) {
  let rows;
  try { rows = JSON.parse(text); } catch { throw new Error('Enter a JSON array of group keys'); }
  if (!Array.isArray(rows) || !rows.length || rows.length > 32) throw new Error('Provide 1..32 group keys');
  const keys = rows.map(r => {
    if (!r || !Number.isSafeInteger(r.groupId) || r.groupId < 1 || typeof r.key !== 'string' || !r.key.trim() || r.key.length > 4096)
      throw new Error('Each group needs a positive groupId and a key');
    if (typeof r.multiplier !== 'number' || !Number.isFinite(r.multiplier) || r.multiplier < 0) throw new Error('Each group needs its actual multiplier');
    if (r.models !== undefined && (!Array.isArray(r.models) || !r.models.every(m => typeof m === 'string'))) throw new Error('Invalid group models');
    const platform = r.platform ?? 'openai';
    if (!validPlatform(platform)) throw new Error('Invalid group platform');
    return { groupId: r.groupId, key: r.key.trim(), platform, multiplier: r.multiplier, models: r.models, owned: false };
  });
  if (new Set(keys.map(k => k.groupId)).size !== keys.length) throw new Error('Duplicate groupId');
  return keys;
}

export function configModels(o) {
  return Object.fromEntries(o.models.map(m => [m.id, {
    id: m.modelId, name: m.id,
    provider: { npm: protocolNpm(m.api), api: protocolBase(m.api) },
    headers: { 'x-aihub-auto-platform': m.platform },
    limit: { context: m.context ?? 128000, output: m.output ?? 16384 },
    tool_call: true,
  }]));
}
