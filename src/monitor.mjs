import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const VIEW_TOKEN = randomBytes(32).toString('hex');
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; form-action 'none'; base-uri 'none'";
const ASSETS = new Map([
  ['/', ['monitor.html', 'text/html; charset=utf-8']],
  ['/index.html', ['monitor.html', 'text/html; charset=utf-8']],
  ['/monitor.html', ['monitor.html', 'text/html; charset=utf-8']],
  ['/monitor.js', ['monitor.js', 'text/javascript; charset=utf-8']],
  ['/monitor.css', ['monitor.css', 'text/css; charset=utf-8']],
]);
const MAX_BYTES = 1024 * 1024;
const list = (value, limit) => Array.isArray(value) ? value.slice(0, limit) : [];
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const bool = value => typeof value === 'boolean' ? value : null;
const id = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const safeString = (value, limit = 160) => {
  if (typeof value !== 'string') return '';
  return value.slice(0, limit).replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted]')
    .replace(/(?:Bearer\s+\S+|\b(?:sk|key|token|sess|secret)[-_][A-Za-z0-9._-]{6,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\b[a-fA-F0-9]{32,}\b)/gi, '[redacted]');
};
const code = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) ? safeString(value, 64) : '';
const timestamp = value => {
  if (typeof value === 'number') return number(value);
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

// The supplier is sanitized independently: never serialize source objects or errors.
function snapshotView(raw) {
  if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.accounts)) throw new Error('INVALID_SNAPSHOT');
  let groupsLeft = 500;
  let modelsLeft = 4000;
  const result = {
    schemaVersion: 1,
    generatedAt: timestamp(raw.generatedAt),
    accounts: list(raw.accounts, 32).map((account, index) => ({
      label: `账户${index + 1}`,
      mode: code(account?.mode),
      sourceUpdatedAt: timestamp(account?.sourceUpdatedAt),
      stale: bool(account?.stale),
      ...(code(account?.errorCode) ? { errorCode: code(account.errorCode) } : {}),
      groups: list(account?.groups, Math.max(0, Math.min(250, groupsLeft))).map(group => {
        groupsLeft--;
        const models = list(group?.models, Math.min(200, modelsLeft))
          .filter(model => typeof model === 'string').map(model => safeString(model));
        modelsLeft -= models.length;
        return {
          groupId: id(group?.groupId), name: safeString(group?.name), platform: code(group?.platform),
          multiplier: number(group?.multiplier), available: bool(group?.available), passed: bool(group?.passed),
          latency: number(group?.latency),
          metrics: Object.fromEntries(['successRate', 'cacheHitRate', 'tps', 'realPrice'].map(key => [key, number(group?.metrics?.[key])])),
          models, eligible: bool(group?.eligible), reasons: list(group?.reasons, 16).map(reason => safeString(reason, 160)).filter(Boolean),
          hasKey: bool(group?.hasKey), selectedCount: number(group?.selectedCount),
          cooldownUntil: timestamp(group?.cooldownUntil), lastUsedAt: timestamp(group?.lastUsedAt),
        };
      }),
      routes: list(account?.routes, 100).map(route => ({
        platform: code(route?.platform), model: safeString(route?.model), groupId: id(route?.groupId),
        at: timestamp(route?.at), outcome: code(route?.outcome),
      })),
      keyState: {
        ready: number(account?.keyState?.ready), pending: number(account?.keyState?.pending),
        autoCreateKeys: bool(account?.keyState?.autoCreateKeys),
      },
    })),
  };
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json) > MAX_BYTES) throw new Error('SNAPSHOT_TOO_LARGE');
  return json;
}

function sameToken(provided, expected) {
  if (typeof provided !== 'string' || provided.length > 256) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Root paths are supplied by Magpie's service proxy; this is not an AIHub proxy. */
export function monitorHandler({ port, getSnapshot, token = VIEW_TOKEN } = {}) {
  if (typeof getSnapshot !== 'function') throw new TypeError('getSnapshot must be a function');
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(token)) throw new TypeError('Invalid monitor token');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid monitor port');
  return async (req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8', headers = {}) => {
      res.writeHead(status, {
        'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP, ...headers,
      });
      res.end(body);
    };
    const error = (status, errorCode, message, headers) => send(status, JSON.stringify({ schemaVersion: 1, error: { code: errorCode, message } }), undefined, headers);
    try {
      const actualPort = port || req.socket.localPort;
      if (req.headers.host !== `127.0.0.1:${actualPort}`) return error(403, 'HOST_REJECTED', 'Monitor requires its exact loopback host.');
      if (req.headers.origin !== undefined && req.headers.origin !== 'null') return error(403, 'ORIGIN_REJECTED', 'Monitor accepts only its sandboxed page.');
      if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) return error(400, 'BODY_REJECTED', 'Monitor requests cannot contain a body.');
      if (req.url === '/snapshot') {
        const cors = { 'Access-Control-Allow-Origin': 'null', Vary: 'Origin' };
        if (req.method === 'OPTIONS') {
          const requested = req.headers['access-control-request-headers'];
          if (req.headers['access-control-request-method'] !== 'GET' || typeof requested !== 'string' || requested.trim().toLowerCase() !== 'x-aihub-monitor')
            return error(403, 'PREFLIGHT_REJECTED', 'Only GET with X-AIHub-Monitor is permitted.');
          return send(204, '', undefined, { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'X-AIHub-Monitor' });
        }
        if (req.method !== 'GET') return error(405, 'METHOD_REJECTED', 'Monitor is read-only.', { Allow: 'GET, OPTIONS' });
        if (!sameToken(req.headers['x-aihub-monitor'], token)) return error(403, 'TOKEN_REJECTED', 'Reload the monitor page to obtain its view token.', cors);
        try {
          return send(200, snapshotView(await getSnapshot()), undefined, cors);
        } catch {
          return error(503, 'SNAPSHOT_UNAVAILABLE', 'The local routing snapshot could not be read. Refresh or load the provider first, then retry. No model inference or key creation is performed.', cors);
        }
      }
      const asset = ASSETS.get(req.url);
      if (!asset) return error(404, 'NOT_FOUND', 'Monitor route does not exist.');
      if (req.method !== 'GET') return error(405, 'METHOD_REJECTED', 'Monitor assets support GET only.', { Allow: 'GET' });
      let body = await readFile(new URL(`../ui/${asset[0]}`, import.meta.url), 'utf8');
      if (asset[0] === 'monitor.html') body = body.replace('__AIHUB_MONITOR_TOKEN__', token);
      return send(200, body, asset[1]);
    } catch {
      if (!res.headersSent) error(500, 'MONITOR_UNAVAILABLE', 'The local monitor is temporarily unavailable. Reload the page or restart the provider.');
      else res.end();
    }
  };
}

/** Start once per plugin factory, only when monitorEnabled is true. Port 0 supports local tests. */
export async function startMonitor({ port, getSnapshot } = {}) {
  const server = createServer(monitorHandler({ port, getSnapshot }));
  await new Promise((resolve, reject) => {
    const failed = err => { server.removeListener('listening', ready); reject(err); };
    const ready = () => { server.removeListener('error', failed); resolve(); };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen(port, '127.0.0.1');
  });
  server.unref();
  return server;
}
