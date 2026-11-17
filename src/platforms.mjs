const origin = 'https://aihub.top';
export const PLATFORMS = Object.freeze(['openai', 'deepseek', 'zhipu', 'kimi', 'grok', 'gemini']);
export const validPlatform = value => PLATFORMS.includes(value);
export const protocolBase = api => `${origin}/${api === 'gemini' ? 'v1beta' : 'v1'}`;
export const protocolNpm = api => api === 'gemini' ? '@ai-sdk/google' : api === 'chat' ? '@ai-sdk/openai-compatible' : '@ai-sdk/openai';
export const publicModelId = (platform, id) => platform === 'openai' ? id : `${platform}::${id}`;
// Magpie renders `platform::model` as `platform:model` in its provider dialog and
// may forward either shape back, so accept both and keep the bare model id.
export const splitModelId = value => {
  const text = String(value);
  const at = text.indexOf('::');
  if (at > 0) return [text.slice(0, at), text.slice(at + 2)];
  const colon = text.indexOf(':');
  if (colon > 0 && validPlatform(text.slice(0, colon))) return [text.slice(0, colon), text.slice(colon + 1)];
  return [undefined, text];
};
export const bareModelId = value => splitModelId(value)[1];
export function modelDescriptor(value, defaultApi = 'responses') {
  const row = typeof value === 'string' ? { id: value } : value;
  if (!row || typeof row.id !== 'string') throw new Error('Invalid model id');
  if (row.id.split('::').length > 2) throw new Error('Invalid model namespace');
  const [namespace, bare] = splitModelId(row.id);
  const platform = row.platform ?? namespace ?? 'openai';
  const modelId = bare;
  if (!validPlatform(platform) || (namespace && namespace !== platform)) throw new Error('Invalid model platform');
  if (!/^[A-Za-z0-9_./:@+-]{1,160}$/.test(modelId)) throw new Error('Invalid model id');
  const api = row.api ?? defaultApi;
  if (!['responses', 'chat', 'gemini'].includes(api) || (api === 'gemini' && platform !== 'gemini') || (platform === 'gemini' && api === 'chat')) throw new Error('Unsupported platform protocol');
  return { ...row, id: publicModelId(platform, modelId), modelId, platform, api };
}
