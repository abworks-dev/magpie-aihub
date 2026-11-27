import { randomUUID } from 'node:crypto';
import { PROVIDER, BASE, settings, migrateKeyDefaults, manualBundle, configModels } from './src/config.mjs';
import { login, setOrigins } from './src/api.mjs';
import { Account, accountSaver } from './src/account.mjs';
import { Router } from './src/router.mjs';
import { modelDescriptor, protocolBase, protocolNpm } from './src/platforms.mjs';
import { defaultLimits } from './src/limits.mjs';
import { startService } from './src/service.mjs';
import { monitorSnapshot } from './src/telemetry.mjs';
import { usageCard } from './src/usage.mjs';
import { adoptRuntime } from './src/runtime.mjs';

async function pruneIdleKeys(runtimes, days, apply) {
  const result = { apply, candidates: [], deleted: 0, stale: 0, failed: [] };
  for (const { account } of runtimes.values()) {
    if (account.data.mode !== 'managed') continue;
    try {
      const cleanup = await account.evictIdle({ days, apply });
      result.candidates.push(...cleanup.candidates);
      result.deleted += cleanup.deleted.length;
      result.stale += cleanup.stale ?? 0;
      result.failed.push(...cleanup.failed);
    } catch (error) {
      result.failed.push({ step: 'cleanup', message: String(error?.message ?? error) });
    }
  }
  return result;
}

// Gemini models registered under the Responses shape: the plugin translates them.
const descriptorApi = (id, fallback) => (id.startsWith('gemini::') ? 'responses' : fallback);

async function AIHubPlugin({ client }, initialOptions = {}) {
  const options = settings(migrateKeyDefaults(initialOptions));
  // Console calls (sign-in, balance, keys) follow the same entry hosts as inference.
  setOrigins(options.endpoints.map(row => row.url));
  const runtimes = new Map();
  let lastDiscoveryError = '';
  // One listener per plugin factory, never per account: it is the page itself
  // (settings and the read-only monitor in one document). A busy port must not
  // break the provider; Magpie then shows its own retry notice for the page.
  try {
    await startService({
      port: options.monitorPort,
      getSnapshot: () => monitorSnapshot(runtimes, options),
      prune: async ({ apply } = {}) => pruneIdleKeys(runtimes, options.evictIdleDays, apply === true),
      getIdentities: () => [...runtimes.values()].slice(0, 32).map(item => item.account?.data?.identity ?? ''),
      getMetrics: () => {
        const items = [...runtimes.values()];
        const total = pick => items.reduce((sum, item) => sum + (Number(pick(item)) || 0), 0);
        return {
          accounts: items.length,
          requests: total(item => item.router?.counters?.requests),
          failures: total(item => item.router?.counters?.failures),
          spendUsd: total(item => item.router?.spend?.usd),
        };
      },
    });
  } catch (error) {
    console.error(`[aihub-auto] page service on 127.0.0.1:${options.monitorPort} did not start: ${error?.message ?? error ?? 'unknown error'}`);
  }
  function runtime(auth, getCurrentAuth) {
    let data;
    try { data = JSON.parse(auth?.key); } catch { throw new Error('Sign in to AIHub Auto using the plugin authentication form'); }
    if (!data?.instanceId) throw new Error('Unsupported AIHub authentication data');
    let item = runtimes.get(data.instanceId);
    if (!item) {
      // A fresh sign-in is a new instance of the same person: retire the previous
      // one so the monitor cannot list a dead account, and keep its keys so the
      // replacement does not create a second set for the same groups.
      data = adoptRuntime(runtimes, data);
      if (runtimes.size >= 32) throw new Error('Too many active AIHub plugin accounts; reload the plugin host');
      item = { getCurrentAuth };
      const account = new Account(data, { save: accountSaver(client, () => {
        if (!item.getCurrentAuth) throw new Error('Account loader is not ready');
        return item.getCurrentAuth();
      }) });
      Object.assign(item, { account, router: new Router(account, options) });
      runtimes.set(data.instanceId, item);
    }
    if (getCurrentAuth) item.getCurrentAuth = getCurrentAuth;
    return item;
  }
  return {
    config: async config => {
      config.provider ??= {};
      const current = config.provider[PROVIDER] ?? {};
      config.provider[PROVIDER] = {
        ...current, name: 'AIHub Auto', npm: options.defaultApi === 'chat' ? '@ai-sdk/openai-compatible' : '@ai-sdk/openai', api: BASE,
        options: Object.fromEntries(Object.entries(current.options ?? {}).filter(([key]) => key !== 'baseURL')),
        models: { ...configModels(options), ...current.models },
      };
    },
    auth: {
      provider: PROVIDER,
      // Magpie's Usage page reads each account's allowance through this hook
      // (magpie's own; OpenCode ignores it): the wallet balance and the three
      // platform budgets AIHub publishes for the account.
      usage: async (getAuth, provider, scope = {}) => {
        const auth = await getAuth();
        return usageCard(runtime(auth, getAuth), options, { signal: scope?.signal });
      },
      methods: [
        {
          type: 'api', keyless: true, label: '导入分组 Key（无需账号密码）',
          prompts: [{ type: 'password', key: 'keys', message: '分组 Key JSON 数组（保密保存）' }],
          authorize: async inputs => {
            try {
              const data = { version: 1, mode: 'manual', instanceId: randomUUID(), identity: 'Imported group keys', keys: manualBundle(inputs.keys) };
              return { type: 'success', key: JSON.stringify(data), metadata: { email: data.identity } };
            } catch { return { type: 'failed' }; }
          },
        },
        {
          type: 'api', keyless: true, label: 'AIHub 账户登录（可管理专用分组 Key）',
          prompts: [
            { type: 'text', key: 'email', message: 'AIHub 邮箱' },
            { type: 'password', key: 'password', message: 'AIHub 密码（仅用于本次登录）' },
          ],
          authorize: async (inputs, context = {}) => {
            try {
              const email = typeof inputs?.email === 'string' ? inputs.email.trim() : '';
              if (!email || typeof inputs?.password !== 'string' || !inputs.password) {
                return { type: 'failed', error: '请输入 AIHub 邮箱和密码。' };
              }
              const tokens = await login(email, inputs.password, undefined, context.signal);
              const data = { version: 1, mode: 'managed', instanceId: randomUUID(), ...tokens, keys: [] };
              return { type: 'success', key: JSON.stringify(data), metadata: { email: data.identity } };
            } catch (error) {
              const reason = error?.status === 401 ? 'AIHub 拒绝登录，请核对邮箱和密码。'
                : error?.status === 429 ? 'AIHub 登录请求过多，请稍后重试。'
                : 'AIHub 登录未完成，请检查 AIHub 网站或稍后重试。';
              return { type: 'failed', error: reason };
            }
          },
        },
      ],
      loader: async getAuth => {
        const auth = await getAuth();
        const current = runtime(auth, getAuth);
        return {
          apiKey: 'magpie-aihub-internal',
          fetch: async (input, init) => {
            const latest = await getAuth();
            let currentInstance;
            try { currentInstance = JSON.parse(latest?.key).instanceId; } catch { /* disconnected */ }
            if (currentInstance !== current.account.data.instanceId) throw new Error('AIHub account changed; reload this provider connection');
            return current.router.fetch(input, init);
          },
        };
      },
    },
    provider: {
      id: PROVIDER,
      models: async (provider, { auth, signal } = {}) => {
        if (options.models.length || !auth?.key) return provider.models ?? {};
        const item = runtime(auth);
        const ids = await item.router.discover(signal)
          .catch(error => {
            // Magpie marks this account and keeps its last catalogue when the
            // hook throws a confirmed expiry. Other failures fall back locally.
            if (error?.signIn === 'expired') throw error;
            // One repeated failure should not flood the host log on every refresh.
            const detail = String(error?.message ?? error ?? 'unknown error');
            if (detail !== lastDiscoveryError) {
              lastDiscoveryError = detail;
              console.error(`[aihub-auto] model discovery unavailable: ${detail}`);
            }
            return null;
          });
        if (!ids) {
          const known = provider?.models ?? {};
          return Object.keys(known).length ? known : item.lastDiscoveredModels ?? known;
        }
        lastDiscoveryError = '';
        const models = Object.fromEntries(ids.map(id => {
          const descriptor = modelDescriptor(id, descriptorApi(id, options.defaultApi));
          const key = options.bareModelIds ? descriptor.modelId : id;
          const guessed = defaultLimits(descriptor.platform, descriptor.modelId);
          return [key, {
          id: key, providerID: PROVIDER, name: key,
          api: { id: descriptor.modelId, url: protocolBase(descriptor.api), npm: protocolNpm(descriptor.api) },
          limit: { context: guessed.context, output: guessed.output },
          capabilities: { reasoning: false, toolcall: true, attachment: false, input: { text: true, image: false }, output: { text: true } },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          variants: {}, headers: { 'x-aihub-auto-platform': descriptor.platform }, options: {}, release_date: '', status: 'active',
        }];
        }));
        item.lastDiscoveredModels = models;
        return models;
      },
    },
    'chat.headers': async (input, output) => {
      if (input.model?.providerID !== PROVIDER) return;
      output.headers ??= {};
      if (input.sessionID) output.headers['x-aihub-auto-session'] = input.sessionID;
      if (input.model?.id) output.headers['x-aihub-auto-platform'] = modelDescriptor(input.model.id).platform;
    },
  };
}

export default { id: 'magpie-aihub', server: AIHubPlugin };
