// Magpie hands the host proxy to plugins as MAGPIE_HTTPS_PROXY / MAGPIE_HTTP_PROXY
// / MAGPIE_ALL_PROXY (plain names stay out of the way of a plugin's own
// configuration). Bun's fetch ignores the environment, so every outbound request
// has to carry the value explicitly; without it a container behind a poisoned
// resolver connects straight to a dead address and fails with ECONNRESET.

const SELECT = [
  'MAGPIE_HTTPS_PROXY', 'HTTPS_PROXY', 'MAGPIE_https_proxy', 'https_proxy',
  'MAGPIE_HTTP_PROXY', 'HTTP_PROXY', 'MAGPIE_http_proxy', 'http_proxy',
  'MAGPIE_ALL_PROXY', 'ALL_PROXY', 'MAGPIE_all_proxy', 'all_proxy',
];
const BYPASS = ['MAGPIE_NO_PROXY', 'NO_PROXY', 'MAGPIE_no_proxy', 'no_proxy'];

function firstValue(env, names) {
  for (const name of names) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return undefined; }
}

function matches(host, rule) {
  const bare = rule.replace(/^\./, '').replace(/:\d+$/, '');
  if (bare === '*') return true;
  if (!bare) return false;
  return host === bare || host.endsWith(`.${bare}`);
}

export function bypassed(host, list) {
  if (!list) return false;
  return list.split(',').map(rule => rule.trim().toLowerCase()).filter(Boolean).some(rule => matches(host, rule));
}

export function proxyFor(url, env = process.env) {
  const proxy = firstValue(env, SELECT);
  if (!proxy) return undefined;
  const host = hostOf(url);
  if (!host) return proxy;
  return bypassed(host, firstValue(env, BYPASS)) ? undefined : proxy;
}
