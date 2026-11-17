import { randomUUID } from 'node:crypto';
import { PROVIDER, BASE, settings, manualBundle, configModels } from './src/config.mjs';
import { login } from './src/api.mjs';
import { Account, accountSaver } from './src/account.mjs';
import { Router } from './src/router.mjs';
import { modelDescriptor, protocolBase, protocolNpm } from './src/platforms.mjs';
import { startService } from './src/service.mjs';
import { monitorSnapshot } from './src/telemetry.mjs';

async function AIHubPlugin({ client }, initialOptions = {}) {
  const options = settings(initialOptions);
  const runtimes = new Map();
  // One listener per plugin factory, never per account: it is the page itself
  // (settings and the read-only monitor in one document). A busy port must not
  // break the provider; Magpie then shows its own retry notice for the page.
  try {
    await startService({ port: options.monitorPort, getSnapshot: () => monitorSnapshot(runtimes, options) });
  } catch (error) {
    console.error(`[aihub-auto] page service on 127.0.0.1:${options.monitorPort} did not start: ${error?.message ?? error ?? 'unknown error'}`);
  }
  function runtime(auth, getCurrentAuth) {
    let data;
    try { data = JSON.parse(auth?.key); } catch { throw new Error('Sign in to AIHub Auto using the plugin authentication form'); }
    if (!data?.instanceId) throw new Error('Unsupported AIHub authentication data');
    let item = runtimes.get(data.instanceId);
    if (!item) {
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
              const tokens = await login(inputs.email, inputs.password, undefined, context.signal);
              const data = { version: 1, mode: 'managed', instanceId: randomUUID(), ...tokens, keys: [] };
              return { type: 'success', key: JSON.stringify(data), metadata: { email: data.identity } };
            } catch { return { type: 'failed' }; }
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
        const ids = await runtime(auth)
          .router.discover(signal)
          .catch(error => {
            // A dead session must not blank the provider catalogue: keep the models
            // Magpie already knows so the connection stays selectable and retryable.
            console.error(`[aihub-auto] model discovery unavailable: ${error?.message ?? error ?? 'unknown error'}`);
            return null;
          });
        if (!ids) return provider?.models ?? {};
        return Object.fromEntries(ids.map(id => {
          const descriptor = modelDescriptor(id, id.startsWith('gemini::') ? 'responses' : options.defaultApi);
          return [id, {
          id, providerID: PROVIDER, name: id,
          api: { id: descriptor.modelId, url: protocolBase(descriptor.api), npm: protocolNpm(descriptor.api) },
          limit: { context: 128000, output: 16384 },
          capabilities: { reasoning: false, toolcall: true, attachment: false, input: { text: true, image: false }, output: { text: true } },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          variants: {}, headers: { 'x-aihub-auto-platform': descriptor.platform }, options: {}, release_date: '', status: 'active',
        }];
        }));
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
