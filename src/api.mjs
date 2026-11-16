import { ORIGIN } from './config.mjs';

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
  const res = await fetcher(`${ORIGIN}${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
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
export function normalizeHall(data) {
  return new Map(list(data).flatMap(r => {
    const id = Number(r.group_id);
    if (!Number.isSafeInteger(id) || id < 1) return [];
    const detection = r.model_detection ?? {};
    const blocked = ['failed', 'fail', 'error', 'detection_failed', 'not_configured'].includes(detection.status);
    const stage = detection.stages?.text;
    const textBlocked = ['failed', 'fail', 'error'].includes(stage?.published_state ?? stage?.state);
    const latency = numeric(r.avg_ttft_ms ?? r.range_cache?.avg_ttft_ms);
    return [[id, {
      id, platform: r.platform, available: typeof r.available === 'boolean' ? r.available : undefined,
      visible: r.visible_in_hall !== false, blocked: blocked || textBlocked,
      passed: detection.status === 'passed', multiplier: numeric(r.rate_multiplier),
      latency: latency > 0 ? latency : undefined,
      rejected: (r.model_cards ?? []).filter(m => m.health === 'failed').map(m => m.model),
    }]];
  }));
}

export function groupCandidate(group, rates, hall) {
  const id = Number(group.id);
  const h = hall.get(id);
  if (!Number.isSafeInteger(id) || id < 1 || group.status !== 'active' || group.platform !== 'openai') return undefined;
  // The catalogue alone is insufficient evidence that a supplier is still published.
  if (!h || !h.visible || h.blocked || (h.platform && h.platform !== 'openai')) return undefined;
  const override = Object.hasOwn(rates, String(id)) ? numeric(rates[id]) : undefined;
  if (Object.hasOwn(rates, String(id)) && override === undefined) return undefined;
  const multiplier = override ?? numeric(group.rate_multiplier) ?? h.multiplier;
  if (multiplier === undefined || multiplier < 0) return undefined;
  const restriction = group.models_list_config;
  return { ...h, groupId: id, multiplier, models: restriction?.enabled ? restriction.models ?? [] : undefined };
}
