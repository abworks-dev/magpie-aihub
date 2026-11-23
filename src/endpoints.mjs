// Entry-host failover. AIHub publishes more than one host for the same site
// (the default endpoint plus an "optimized" one), and every host reaches the
// same account. Routing therefore picks a host first and a group second, so a
// dead edge (poisoned DNS, blocked host, gateway 502) does not take the whole
// plugin down — including the balance card, which needs the console API too.

// The two hosts AIHub publishes for one site. Both reach the same account, so
// a stock install can already fail over without any setup.
export const DEFAULT_ENDPOINTS = Object.freeze([
  { url: 'https://aihub.top', label: '默认' },
  { url: 'https://aihub.dog', label: '优化' },
]);
export const MAX_ENDPOINTS = 8;

// A stored endpoint is an origin plus a short human label. Anything that does
// not parse as http(s) is dropped instead of being sent upstream.
export function parseEndpoints(raw) {
  if (raw === undefined) return DEFAULT_ENDPOINTS.map(row => ({ ...row }));
  if (!Array.isArray(raw) || !raw.length) throw new Error('endpoints must be a non-empty array');
  if (raw.length > MAX_ENDPOINTS) throw new Error(`endpoints must hold at most ${MAX_ENDPOINTS} rows`);
  const seen = new Set();
  const rows = [];
  for (const item of raw) {
    const value = typeof item === 'string' ? item : item?.url;
    if (typeof value !== 'string') throw new Error('each endpoint needs a string url');
    let origin;
    try { origin = new URL(value.trim()).origin; } catch { throw new Error(`invalid endpoint url: ${String(value).slice(0, 80)}`); }
    if (origin === 'null' || !/^https?:\/\//.test(origin)) throw new Error(`endpoint must be http(s): ${String(value).slice(0, 80)}`);
    if (seen.has(origin)) continue;
    seen.add(origin);
    const label = (typeof item === 'object' && typeof item?.label === 'string' ? item.label : '').trim().slice(0, 24);
    rows.push({ url: origin, label: label || origin.replace(/^https?:\/\//, '') });
  }
  return rows.length ? rows : DEFAULT_ENDPOINTS.map(row => ({ ...row }));
}

// Per-endpoint health: an EWMA of first-byte latency plus a failure count and a
// cooldown after an edge failure. Kept in memory only; a restart starts clean.
export class EndpointPool {
  constructor(rows = DEFAULT_ENDPOINTS, { mode = 'failover', cooldownMs = 60_000, now = Date.now } = {}) {
    this.rows = rows.map(row => ({ url: row.url, label: row.label }));
    this.mode = mode;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.stats = new Map();
  }

  urls() { return this.rows.map(row => row.url); }
  has(url) { return this.rows.some(row => row.url === url); }

  stat(url) {
    let entry = this.stats.get(url);
    if (!entry) {
      entry = { latency: null, fails: 0, wins: 0, cooldownUntil: 0, lastError: '' };
      this.stats.set(url, entry);
    }
    return entry;
  }

  healthy(url, now = this.now()) { return this.stat(url).cooldownUntil <= now; }

  // The preferred (sticky) endpoint stays first while it is healthy; the rest
  // follow by observed latency, and cooling endpoints go last.
  order(preferred) {
    const now = this.now();
    const rank = url => url === preferred && this.healthy(url, now) ? 0 : this.healthy(url, now) ? 1 : 2;
    const latency = url => this.stat(url).latency ?? Number.MAX_SAFE_INTEGER;
    return [...this.rows]
      .sort((a, b) => rank(a.url) - rank(b.url) || latency(a.url) - latency(b.url))
      .map(row => row.url);
  }

  // Balance mode: pick among healthy endpoints with weight ~ 1/latency. Only
  // usable when every endpoint is known to serve the same account.
  pick(candidates = this.urls(), rng = Math.random) {
    const pool = candidates.filter(url => this.healthy(url));
    if (pool.length <= 1) return pool[0] ?? candidates[0];
    const weight = url => 1000 / Math.max(50, this.stat(url).latency ?? 800);
    const total = pool.reduce((sum, url) => sum + weight(url), 0);
    let ticket = rng() * total;
    for (const url of pool) {
      ticket -= weight(url);
      if (ticket <= 0) return url;
    }
    return pool[pool.length - 1];
  }

  penalize(url, forceMs) {
    const entry = this.stat(url);
    entry.fails += 1;
    entry.cooldownUntil = this.now() + (Number.isFinite(forceMs) && forceMs > 0 ? forceMs : this.cooldownMs);
  }

  praise(url, ms) {
    const entry = this.stat(url);
    entry.wins += 1;
    entry.cooldownUntil = 0;
    if (Number.isFinite(ms) && ms >= 0) entry.latency = entry.latency === null ? ms : entry.latency * 0.8 + ms * 0.2;
  }

  report() {
    const now = this.now();
    return this.rows.map(row => {
      const entry = this.stat(row.url);
      return {
        url: row.url, label: row.label,
        latencyMs: Number.isFinite(entry.latency) ? Math.round(entry.latency) : null,
        failures: entry.fails, wins: entry.wins,
        ok: entry.cooldownUntil <= now,
        cooldownUntil: entry.cooldownUntil > now ? entry.cooldownUntil : null,
      };
    });
  }

  // An edge failure belongs to the entry host, not to the account: transport
  // errors and HTML gateway pages are worth another endpoint. AIHub's own JSON
  // (429/401/403/5xx with an error body) is not — switching hosts cannot help
  // and a retry may bill twice.
  static isEdgeResponse(status, contentType) {
    const type = String(contentType ?? '').toLowerCase();
    if (type.includes('application/json')) return false;
    // An HTML page is a gateway speaking, whatever its status. A bare 502/504
    // is also the edge; a plain-text 503 is left to the group, since a healthy
    // but busy upstream answers that way and another host would not help.
    return type.includes('text/html') || status === 502 || status === 504;
  }
}
