import { ORIGIN } from './config.mjs';
import { validPlatform } from './platforms.mjs';
import { proxyFor } from './proxy.mjs';

export class ApiError extends Error {
  constructor(status, path) {
    super(`AIHub API ${path.split('?')[0]} returned HTTP ${status}; check sign-in or site access.`);
    this.status = status;
  }
}

export async function api(path, { token, body, signal, headers = {}, fetcher = globalThis.fetch } = {}) {
  const requestHeaders = new Headers({ accept: 'application/json', ...headers });
  if (token) requestHeaders.set('authorization', `Bearer ${token}`);
  if (body !== undefined) requestHeaders.set('content-type', 'application/json');
  const url = `${ORIGIN}${path}`;
  // Bun's fetch does not read the proxy from the environment on its own.
  const proxy = proxyFor(url);
  const res = await fetcher(url, {
    method: body === undefined ? 'GET' : 'POST', headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    ...(proxy ? { proxy } : {}),
  });
  if (!res.ok) { await res.body?.cancel(); throw new ApiError(res.status, path); }
  let data;
  try { data = await res.json(); } catch { throw new Error(`AIHub API ${path.split('?')[0]} returned invalid JSON`); }
  if (data && typeof data === 'object' && 'code' in data && String(data.code) !== '0') throw new ApiError(502, path);
  return data?.data ?? data;
}

export function list(data) {
  const rows = Array.isArray(data) ? data : data?.items;
  if (!Array.isArray(rows)) throw new Error('AIHub returned an unsupported list schema');
  return rows;
}

export function tokenFields(data, previous = {}) {
  if (data?.requires_2fa) throw new Error('AIHub requires 2FA; use manual group keys instead.');
  if (typeof data?.access_token !== 'string' || !data.access_token) throw new Error('AIHub did not return an access token');
  const seconds = Number(data.expires_in);
  let expires = Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : 0;
  if (!expires) {
    try { const jwt = JSON.parse(Buffer.from(data.access_token.split('.')[1], 'base64url').toString()); expires = Number(jwt.exp) * 1000 || 0; } catch { /* Expiry may be absent; refresh on a rejected management call. */ }
  }
  return { access: data.access_token, refresh: data.refresh_token || previous.refresh || '', expires };
}

export async function login(email, password, fetcher, signal) {
  const data = await api('/api/v1/auth/login', { body: { email, password, turnstile_token: '' }, fetcher, signal });
  return { ...tokenFields(data), identity: String(data.user?.email ?? email) };
}

const numeric = value => {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  return Number.isFinite(Number(value)) ? Number(value) : undefined;
};
// Catalogue IDs are finite advertised names, never patterns or display labels.
const validModelId = value => typeof value === 'string' && /^[A-Za-z0-9_./:@+-]{1,160}$/.test(value);
const modelRestriction = value => {
  if (value === undefined || value === null) return undefined;
  if (value.enabled === false) return undefined;
  if (value.enabled !== true || !Array.isArray(value.models) || !value.models.every(validModelId)) return [];
  return [...new Set(value.models)];
};

// AIHub reports the observed cost and token counts of a probe window rather than
// a ready-made unit price. Derive USD per 1M tokens so channels stay comparable;
// an explicit real_price (older payloads) still wins.
const rangePrice = rc => {
  const unit = numeric(rc.real_price);
  if (unit !== undefined) return unit;
  const tokens = ['input_tokens', 'cache_read_tokens', 'cache_creation_tokens'].reduce((sum, key) => sum + (numeric(rc[key]) ?? 0), 0);
  const cost = ['input_cost', 'cache_read_cost', 'cache_creation_cost'].reduce((sum, key) => sum + (numeric(rc[key]) ?? 0), 0);
  return tokens > 0 ? (cost / tokens) * 1e6 : null;
};

// One-shot schema probe: the hall payload is the only source for these rows, so
// record which fields AIHub actually sends instead of guessing they are missing.
let describedHall = false;
const keysOf = value => value && typeof value === 'object' ? Object.keys(value).slice(0, 40).join(',') : '-';
function describeHall(rows) {
  if (describedHall || !rows.length) return;
  describedHall = true;
  const row = rows[0];
  const card = Array.isArray(row.model_cards) ? row.model_cards[0] : undefined;
  console.error(`[aihub-auto] hall row keys: ${keysOf(row)} | success_rates: ${keysOf(row.success_rates)} | model_detection: ${keysOf(row.model_detection)} | range_cache: ${keysOf(row.range_cache)} | model_cards[0]: ${keysOf(card)}`);
}

export function normalizeHall(data) {
  const rows = list(data);
  describeHall(rows);
  return new Map(rows.flatMap(r => {
    const id = Number(r.group_id);
    if (!Number.isSafeInteger(id) || id < 1) return [];
    const detection = r.model_detection ?? {};
    const blocked = ['failed', 'fail', 'error', 'detection_failed', 'not_configured'].includes(detection.status);
    const stage = detection.stages?.text;
    const textBlocked = ['failed', 'fail', 'error'].includes(stage?.published_state ?? stage?.state);
    const latency = numeric(r.avg_ttft_ms ?? r.range_cache?.avg_ttft_ms);
    const range = r.range_cache ?? {};
    const fresh = range.ready === true && range.stale === false;
    return [[id, {
      id, platform: r.platform, available: typeof r.available === 'boolean' ? r.available : undefined,
      visible: r.visible_in_hall !== false, blocked: blocked || textBlocked,
      passed: detection.status === 'passed' ? true : blocked || textBlocked ? false : null, multiplier: numeric(r.rate_multiplier),
      name: typeof r.name === 'string' ? r.name : undefined,
      metrics: {
        successRate: numeric(r.success_rates?.['6h'] ?? r.probe_success_rate_6h) ?? null,
        tps: numeric(r.summary_tps ?? r.output_tps) ?? null,
        cacheHitRate: fresh ? numeric(range.cache_hit_rate) ?? null : null,
        realPrice: fresh ? rangePrice(range) : null,
        samples: numeric(range.usage_records) ?? null,
        observedSeconds: numeric(range.observed_seconds) ?? null,
      },
      detection: typeof detection.status === 'string' ? detection.status
        : typeof stage?.state === 'string' ? stage.state
          : typeof stage?.published_state === 'string' ? stage.published_state : null,
      latency: latency > 0 ? latency : undefined,
      advertisedModels: Array.isArray(r.model_cards)
        ? [...new Set(r.model_cards.filter(m => validModelId(m?.model)).map(m => m.model))] : undefined,
      rejected: Array.isArray(r.model_cards)
        ? r.model_cards.filter(m => m?.health === 'failed' && validModelId(m.model)).map(m => m.model) : [],
    }]];
  }));
}

export function groupInventory(group, rates, hall) {
  const id = Number(group.id);
  if (!Number.isSafeInteger(id) || id < 1 || !validPlatform(group.platform)) return undefined;
  const h = hall.get(id);
  const hasOverride = Object.hasOwn(rates, String(id));
  const override = hasOverride ? numeric(rates[id]) : undefined;
  const multiplier = hasOverride ? override : numeric(group.rate_multiplier) ?? h?.multiplier;
  // Keep rejected inventory visible without allowing it into the routing pool.
  const routeEligible = group.status === 'active' && Boolean(h?.visible) && !h.blocked
    && (!h.platform || h.platform === group.platform) && multiplier !== undefined && multiplier >= 0;
  return { ...h, platform: group.platform, name: h?.name ?? group.name, groupId: id, multiplier,
    models: modelRestriction(group.models_list_config), routeEligible };
}

export function groupCandidate(group, rates, hall) {
  const row = groupInventory(group, rates, hall);
  return row?.routeEligible ? row : undefined;
}
