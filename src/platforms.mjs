const origin = 'https://aihub.top';
export const PLATFORMS = Object.freeze(['openai', 'deepseek', 'zhipu', 'kimi', 'grok', 'gemini']);
export const validPlatform = value => PLATFORMS.includes(value);
export const protocolBase = api => `${origin}/${api === 'gemini' ? 'v1beta' : 'v1'}`;
export const protocolNpm = api => api === 'gemini' ? '@ai-sdk/google' : api === 'chat' ? '@ai-sdk/openai-compatible' : '@ai-sdk/openai';
export const publicModelId = (platform, id) => platform === 'openai' ? id : `${platform}::${id}`;
export function modelDescriptor(value, defaultApi = 'responses') {
  const row = typeof value === 'string' ? { id: value } : value;
  if (!row || typeof row.id !== 'string') throw new Error('Invalid model id');
  const parts = row.id.split('::');
  if (parts.length > 2) throw new Error('Invalid model namespace');
  const platform = row.platform ?? (parts.length === 2 ? parts[0] : 'openai');
  const modelId = parts.length === 2 ? parts[1] : row.id;
  if (!validPlatform(platform) || (parts.length === 2 && parts[0] !== platform)) throw new Error('Invalid model platform');
  if (!/^[A-Za-z0-9_./:@+-]{1,160}$/.test(modelId)) throw new Error('Invalid model id');
  const api = row.api ?? defaultApi;
  if (!['responses', 'chat', 'gemini'].includes(api) || (api === 'gemini' && platform !== 'gemini') || (platform === 'gemini' && api === 'chat')) throw new Error('Unsupported platform protocol');
  return { ...row, id: publicModelId(platform, modelId), modelId, platform, api };
}
