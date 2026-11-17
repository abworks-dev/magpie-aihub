import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// The plugin page is served by this loopback service, so the settings and the
// read-only monitor live in one document. In `magpie web` the host proxies the
// service under the page's token, which is how a browser on another computer
// reaches it without opening any port of its own.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'";
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
// Magpie serves the bridge beside the page (`_magpie/bridge.js`). A document
// served by this service sits one level deeper (`_magpie/service/`), so the
// same bridge file is one directory up.
const BRIDGE_SHELL = 'src="_magpie/bridge.js"';
const BRIDGE_SERVICE = 'src="../bridge.js"';
// Magpie serves the page inside `sandbox="allow-scripts"`, so its origin is
// opaque and a snapshot read is cross-origin with `Origin: null`. The token is
// injected only into the document this service serves, never into Magpie's
// static copy, so another sandboxed frame cannot ask for the snapshot.
const VIEW_TOKEN = randomBytes(32).toString('hex');
const TOKEN_PLACEHOLDER = '__AIHUB_SERVICE_TOKEN__';
const TOKEN_HEADER = 'x-aihub-service-token';
const MAX_BYTES = 1024 * 1024;
// One listener per port in this process: repeated plugin factories reuse it.
// The host may load this module more than once (plugin update, re-import), and
// the listener created by the previous copy keeps holding the port. Keep the
// registry on the process object so a fresh copy adopts the running listener and
// swaps in its own snapshot supplier instead of failing with EADDRINUSE.
const REGISTRY = Symbol.for('aihub-auto.page-service');
const started = globalThis[REGISTRY] ?? (globalThis[REGISTRY] = new Map());
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

const accountLabel = (value, index) => {
  const fallback = `账户${index + 1}`;
  if (typeof value !== 'string') return fallback;
  const candidate = value.trim();
  return /^[^\s@*]{1,8}\*{3}(@[A-Za-z0-9.-]{1,64})?$/.test(candidate) ? candidate : fallback;
};
const cleanText = value => typeof value === 'string'
  ? [...value].filter(ch => { const n = ch.codePointAt(0); return n > 31 && n !== 127; }).join('').trim().slice(0, 160)
  : '';
const identitiesView = raw => JSON.stringify({
  schemaVersion: 1,
  identities: (Array.isArray(raw) ? raw.slice(0, 32) : []).map(value => {
    const text = cleanText(value);
    return /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9.-]{1,64}$/.test(text) || /^[A-Za-z0-9._-]{2,64}$/.test(text) ? text : '';
  }),
});

// The supplier is sanitized independently: never serialize source objects or errors.
export function snapshotView(raw) {
  if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.accounts)) throw new Error('INVALID_SNAPSHOT');
  let groupsLeft = 500;
  let modelsLeft = 4000;
  const result = {
    schemaVersion: 1,
    generatedAt: timestamp(raw.generatedAt),
    accounts: list(raw.accounts, 32).map((account, index) => ({
      label: accountLabel(account?.label, index),
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
      billing: account?.billing ? {
        at: timestamp(account.billing.at),
        balance: number(account.billing.balance), balanceKnown: bool(account.billing.balanceKnown),
        frozen: number(account.billing.frozen), recharged: number(account.billing.recharged),
        notify: account.billing.notify ? {
          enabled: bool(account.billing.notify.enabled), threshold: number(account.billing.notify.threshold),
          kind: code(account.billing.notify.kind),
        } : null,
        usage: account.billing.usage ? {
          requests: number(account.billing.usage.requests), tokens: number(account.billing.usage.tokens),
          cost: number(account.billing.usage.cost), actualCost: number(account.billing.usage.actualCost),
        } : null,
        platforms: list(account.billing.platforms, 12).map(item => ({
          platform: code(item?.platform),
          dailyLimit: number(item?.dailyLimit), dailyUsage: number(item?.dailyUsage),
          weeklyLimit: number(item?.weeklyLimit), weeklyUsage: number(item?.weeklyUsage),
          monthlyLimit: number(item?.monthlyLimit), monthlyUsage: number(item?.monthlyUsage),
        })),
      } : null,
      billingError: code(account?.billingError) || null,
      keyEvents: list(account?.keyEvents, 8).map(event => ({
        at: timestamp(event?.at), action: code(event?.action), groupId: id(event?.groupId), code: code(event?.code),
      })).filter(event => event.action),
      keyState: {
        ready: number(account?.keyState?.ready), pending: number(account?.keyState?.pending),
        autoCreateKeys: bool(account?.keyState?.autoCreateKeys),
        maxKeysPerAccount: number(account?.keyState?.maxKeysPerAccount), minBalance: number(account?.keyState?.minBalance),
      },
    })),
  };
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json) > MAX_BYTES) throw new Error('SNAPSHOT_TOO_LARGE');
  return json;
}

/** Root paths are supplied by Magpie's service proxy; this is not an AIHub proxy. */
export function serviceHandler({ port, getSnapshot, getIdentities, token = VIEW_TOKEN } = {}) {
  if (typeof getSnapshot !== 'function') throw new TypeError('getSnapshot must be a function');
  if (getIdentities !== undefined && typeof getIdentities !== 'function') throw new TypeError('getIdentities must be a function');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid service port');
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(token)) throw new TypeError('Invalid service token');
  const sameToken = provided => {
    if (typeof provided !== 'string' || provided.length > 256) return false;
    const a = Buffer.from(provided), b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
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
      // Magpie rewrites Host to the service's own address; a browser on the LAN
      // (DNS rebinding) does not.
      if (req.headers.host !== `127.0.0.1:${actualPort}`) return error(403, 'HOST_REJECTED', 'The service answers only its exact loopback host.');
      // The page's sandboxed frame sends Origin: null. Unset means a same-origin
      // navigation or a local client; anything else is another site asking.
      if (req.headers.origin !== undefined && req.headers.origin !== 'null') return error(403, 'ORIGIN_REJECTED', 'The service answers only its own page.');
      if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) return error(400, 'BODY_REJECTED', 'The service takes no request body.');
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') return error(405, 'METHOD_REJECTED', 'The plugin page is read-only.', { Allow: 'GET, HEAD, OPTIONS' });
      const path = req.url.split('?')[0];
      if (path === '/snapshot') {
        const cors = { 'Access-Control-Allow-Origin': 'null', Vary: 'Origin' };
        if (req.method === 'OPTIONS') {
          const requested = req.headers['access-control-request-headers'];
          if (req.headers['access-control-request-method'] !== 'GET' || typeof requested !== 'string' || requested.trim().toLowerCase() !== TOKEN_HEADER)
            return error(403, 'PREFLIGHT_REJECTED', `Only GET with ${TOKEN_HEADER} is permitted.`);
          return send(204, '', undefined, { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': TOKEN_HEADER });
        }
        if (req.method !== 'GET') return error(405, 'METHOD_REJECTED', 'The snapshot is read-only.', { ...cors, Allow: 'GET, OPTIONS' });
        if (!sameToken(req.headers[TOKEN_HEADER])) return error(403, 'TOKEN_REJECTED', 'Reload the page to obtain its snapshot token.', cors);
        try {
          return send(200, snapshotView(await getSnapshot()), undefined, cors);
        } catch {
          return error(503, 'SNAPSHOT_UNAVAILABLE', 'The local routing snapshot could not be read. Reload the provider, then retry. No model inference or key creation is performed.', cors);
        }
      }
      if (path === '/identity') {
        const cors = { 'Access-Control-Allow-Origin': 'null', Vary: 'Origin' };
        if (req.method === 'OPTIONS') {
          const requested = req.headers['access-control-request-headers'];
          if (req.headers['access-control-request-method'] !== 'GET' || typeof requested !== 'string' || requested.trim().toLowerCase() !== TOKEN_HEADER)
            return error(403, 'PREFLIGHT_REJECTED', `Only GET with ${TOKEN_HEADER} is permitted.`);
          return send(204, '', undefined, { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': TOKEN_HEADER });
        }
        if (req.method !== 'GET') return error(405, 'METHOD_REJECTED', 'The identity list is read-only.', { ...cors, Allow: 'GET, OPTIONS' });
        if (!sameToken(req.headers[TOKEN_HEADER])) return error(403, 'TOKEN_REJECTED', 'Reload the page to obtain its snapshot token.', cors);
        try {
          return send(200, identitiesView(typeof getIdentities === 'function' ? await getIdentities() : []), undefined, cors);
        } catch {
          return error(503, 'IDENTITY_UNAVAILABLE', 'The local account list could not be read. Reload the provider, then retry.', cors);
        }
      }
      const asset = ASSETS.get(path);
      if (!asset) return error(404, 'NOT_FOUND', 'The plugin page has no such file.');
      if (req.method === 'OPTIONS') return error(405, 'METHOD_REJECTED', 'Only the snapshot answers a preflight.', { Allow: 'GET, HEAD' });
      let body = await readFile(new URL(`../ui/${asset[0]}`, import.meta.url), 'utf8');
      if (asset[0] === 'index.html') body = body.replace(BRIDGE_SHELL, BRIDGE_SERVICE).replace(TOKEN_PLACEHOLDER, token);
      return send(200, req.method === 'HEAD' ? '' : body, asset[1]);
    } catch {
      if (!res.headersSent) error(500, 'SERVICE_UNAVAILABLE', 'The plugin page is temporarily unavailable. Reload it.');
      else res.end();
    }
  };
}

/**
 * Start once per plugin factory: the page itself lives here. Port 0 supports
 * local tests. A repeated start on the same port reuses the running listener and
 * points it at the newest snapshot supplier instead of failing: a plugin factory
 * may be created more than once per host process, and its own page should not
 * look like a port conflict.
 */
export async function startService({ port, getSnapshot, getIdentities, token } = {}) {
  if (port !== 0 && started.has(port)) {
    started.get(port).setSource(getSnapshot);
    started.get(port).setIdentities?.(getIdentities);
    return started.get(port).server;
  }
  const live = { getSnapshot, getIdentities };
  const server = createServer(serviceHandler({ port, getSnapshot: () => live.getSnapshot(), getIdentities: () => (typeof live.getIdentities === 'function' ? live.getIdentities() : []), token }));
  await new Promise((resolve, reject) => {
    const settle = error => {
      server.removeListener('listening', settle);
      server.removeListener('error', settle);
      if (error) reject(new Error(`page service cannot listen on 127.0.0.1:${port}: ${error.message}`));
      else resolve();
    };
    server.once('listening', () => settle());
    server.once('error', settle);
    server.listen(port, '127.0.0.1');
  });
  server.unref();
  if (port !== 0) {
    started.set(port, {
      server,
      setSource: next => { live.getSnapshot = next; },
      setIdentities: next => { live.getIdentities = next; },
    });
    server.once('close', () => started.delete(port));
  }
  return server;
}
