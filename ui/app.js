(() => {
  'use strict';

  const PROVIDER = 'aihub-auto';
  const platforms = ['openai', 'deepseek', 'zhipu', 'kimi', 'grok', 'gemini'];
  let savedMonitorEnabled = false;
  function modelIdentity(model) {
    const row = typeof model === 'string' ? { id: model } : model;
    const parts = row?.id?.split('::') ?? [];
    const platform = row?.platform ?? (parts.length === 2 ? parts[0] : 'openai');
    const modelId = parts.length === 2 ? parts[1] : parts[0];
    if (parts.length > 2 || !platforms.includes(platform) || (parts.length === 2 && platform !== parts[0]) || !/^[\w./:@+-]{1,160}$/.test(modelId ?? '')) throw new Error('模型 ID 或平台前缀无效。');
    return { id: platform === 'openai' ? modelId : `${platform}::${modelId}`, platform };
  }
  const defaults = {
    strategy: 'balanced', maxMultiplier: 0.16, maxAttempts: 3, poolSize: 4,
    excludedGroups: [], allowedGroups: [], requirePassed: false,
    autoCreateKeys: false, defaultApi: 'responses', models: [],
    platforms: [...platforms], monitorEnabled: false, monitorPort: 19871,
  };
  // Preserve only recognized, valid nonsecret settings from the latest options.
  const advancedRanges = {
    refreshMs: [10000, 3600000], maxStaleMs: [10000, 3600000],
    firstByteTimeoutMs: [10, 120000], totalTimeoutMs: [10, 300000],
    cooldownMs: [10, 3600000], sessionTtlMs: [1000, 604800000],
    maxSessions: [1, 50000], maxBodyBytes: [1024, 50 * 1024 * 1024],
  };
  const $ = id => document.getElementById(id);
  const form = $('options-form');
  const controls = $('controls');
  const saveButton = $('save-button');
  const status = $('status');
  const dirtyNote = $('dirty-note');
  let bridge;
  let connected = false;
  let busy = false;
  let lastSaveAttempt = 0;

  function message(text, kind = '') {
    status.textContent = text;
    status.className = `status${kind ? ` ${kind}` : ''}`;
    status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  }

  function errorText(error) {
    return error instanceof Error && error.message ? error.message.slice(0, 400) : '宿主未返回可用结果，请重试。';
  }

  function bounded(promise, label, milliseconds = 12000) {
    let timer;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); }),
    ]).finally(() => clearTimeout(timer));
  }

  function optionsObject(value) {
    if (value == null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('插件选项格式无效，应为对象。');
    return value;
  }

  function validInteger(value, min, max) {
    return Number.isSafeInteger(value) && value >= min && value <= max;
  }

  function groupList(value) {
    return Array.isArray(value) && value.every(id => validInteger(id, 1, Number.MAX_SAFE_INTEGER));
  }

  function safeOptions(raw) {
    const result = { ...defaults };
    if (['economy', 'balanced', 'speed'].includes(raw.strategy)) result.strategy = raw.strategy;
    if (typeof raw.maxMultiplier === 'number' && Number.isFinite(raw.maxMultiplier) && raw.maxMultiplier >= 0 && raw.maxMultiplier <= 100) result.maxMultiplier = raw.maxMultiplier;
    if (validInteger(raw.maxAttempts, 1, 5)) result.maxAttempts = raw.maxAttempts;
    if (validInteger(raw.poolSize, 1, 8)) result.poolSize = raw.poolSize;
    for (const key of ['excludedGroups', 'allowedGroups']) if (groupList(raw[key])) result[key] = [...new Set(raw[key])];
    for (const key of ['requirePassed', 'autoCreateKeys', 'monitorEnabled']) if (typeof raw[key] === 'boolean') result[key] = raw[key];
    if (['responses', 'chat'].includes(raw.defaultApi)) result.defaultApi = raw.defaultApi;
    for (const [key, [min, max]] of Object.entries(advancedRanges)) if (validInteger(raw[key], min, max)) result[key] = raw[key];
    if (Array.isArray(raw.platforms) && raw.platforms.length && raw.platforms.every(id => platforms.includes(id))) result.platforms = [...new Set(raw.platforms)];
    if (validInteger(raw.monitorPort, 1024, 65535)) result.monitorPort = raw.monitorPort;
    if (Array.isArray(raw.models)) result.models = raw.models;
    return result;
  }

  function populate(raw) {
    const options = safeOptions(raw);
    for (const key of ['strategy', 'maxMultiplier', 'maxAttempts', 'poolSize', 'defaultApi', 'monitorPort']) $(key).value = String(options[key]);
    for (const platform of platforms) $(`platform-${platform}`).checked = options.platforms.includes(platform);
    savedMonitorEnabled = options.monitorEnabled;
    for (const key of ['excludedGroups', 'allowedGroups']) $(key).value = options[key].join(', ');
    for (const key of ['requirePassed', 'autoCreateKeys', 'monitorEnabled']) $(key).checked = options[key];
    $('models').value = options.models.map(model => {
      const { id } = modelIdentity(model);
      return model.api ? `${id}|${model.api}` : id;
    }).join('\n');
  }

  function invalid(id, text) {
    const field = $(id);
    field.setAttribute('aria-invalid', 'true');
    field.focus();
    throw new Error(text);
  }

  function readNumber(id, label, min, max, integer = true) {
    const raw = $(id).value.trim();
    const value = Number(raw);
    if (!raw || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
      invalid(id, `${label}须为 ${min}–${max} 之间的${integer ? '整数' : '数字'}。`);
    }
    return value;
  }

  function readGroups(id, label) {
    const raw = $(id).value.trim();
    if (!raw) return [];
    const parts = raw.split(',').map(part => part.trim());
    if (parts.some(part => !/^\d+$/.test(part) || !validInteger(Number(part), 1, Number.MAX_SAFE_INTEGER))) {
      invalid(id, `${label}须为英文逗号分隔的正整数 ID，不能有空项。`);
    }
    return [...new Set(parts.map(Number))];
  }

  function readModels() {
    const text = $('models').value.trim();
    if (!text) return [];
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length > 200) invalid('models', '模型列表最多支持 200 个模型。');
    const seen = new Set();
    return lines.map((line, index) => {
      const parts = line.split('|').map(part => part.trim());
      const [inputId, api] = parts;
      let identity;
      try { identity = modelIdentity(inputId); }
      catch { invalid('models', `第 ${index + 1} 个模型 ID 或平台前缀无效。`); }
      const protocol = api ?? $('defaultApi').value;
      if (parts.length > 2 || !['responses', 'chat', 'gemini'].includes(protocol)
        || (protocol === 'gemini' && identity.platform !== 'gemini') || (identity.platform === 'gemini' && protocol === 'chat')) {
        invalid('models', `第 ${index + 1} 个模型协议无效：Gemini 使用 responses 或 gemini，其他平台使用 responses 或 chat。`);
      }
      const { id } = identity;
      if (seen.has(id)) invalid('models', `第 ${index + 1} 个模型 ID 重复，请保留一项。`);
      seen.add(id);
      return api ? { id, api } : { id };
    });
  }

  function readForm() {
    form.querySelectorAll('[aria-invalid]').forEach(field => field.removeAttribute('aria-invalid'));
    if (!['economy', 'balanced', 'speed'].includes($('strategy').value)) invalid('strategy', '请选择有效的路由策略。');
    if (!['responses', 'chat'].includes($('defaultApi').value)) invalid('defaultApi', '请选择有效的默认 API。');
    const enabledPlatforms = platforms.filter(platform => $(`platform-${platform}`).checked);
    if (!enabledPlatforms.length) invalid('platform-openai', '请至少选择一个平台。');
    return {
      platforms: enabledPlatforms,
      monitorEnabled: $('monitorEnabled').checked,
      monitorPort: readNumber('monitorPort', '监控端口', 1024, 65535),
      strategy: $('strategy').value,
      maxMultiplier: readNumber('maxMultiplier', '最高倍率', 0, 100, false),
      maxAttempts: readNumber('maxAttempts', '最多尝试次数', 1, 5),
      poolSize: readNumber('poolSize', '候选池大小', 1, 8),
      excludedGroups: readGroups('excludedGroups', '排除分组'),
      allowedGroups: readGroups('allowedGroups', '仅允许分组'),
      requirePassed: $('requirePassed').checked,
      autoCreateKeys: $('autoCreateKeys').checked,
      defaultApi: $('defaultApi').value,
      models: readModels(),
    };
  }

  function preserveModelLimits(models, previous) {
    const metadata = new Map();
    for (const model of previous) {
      if (!model || typeof model !== 'object' || typeof model.id !== 'string') continue;
      const limits = {};
      for (const key of ['context', 'output']) if (validInteger(model[key], 1, Number.MAX_SAFE_INTEGER)) limits[key] = model[key];
      metadata.set(modelIdentity(model).id, limits);
    }
    return models.map(model => ({ ...metadata.get(model.id), ...model }));
  }

  function setBusy(value) {
    busy = value;
    controls.disabled = value || !connected;
    saveButton.textContent = value ? '正在保存…' : '保存设置';
    form.setAttribute('aria-busy', String(value));
  }

  form.addEventListener('input', event => {
    if (event.target && typeof event.target.removeAttribute === 'function') event.target.removeAttribute('aria-invalid');
    dirtyNote.textContent = '有未保存的更改。';
  });

  // Magpie's iframe disables native form submission; save directly from the button.
  saveButton.addEventListener('click', async () => {
    if (busy || !connected) return;
    let changes;
    try { changes = readForm(); }
    catch (error) { message(errorText(error), 'error'); return; }
    if (Date.now() - lastSaveAttempt < 1100) { message('保存过于频繁，请稍等一秒后重试。', 'error'); return; }
    setBusy(true);
    message('正在保存插件选项…');
    try {
      // Re-read to retain advanced settings changed since this page was opened.
      const latest = safeOptions(optionsObject(await bounded(bridge.options.get(), '读取最新选项超时，尚未发起保存。')));
      const next = { ...latest, ...changes, models: preserveModelLimits(changes.models, latest.models) };
      lastSaveAttempt = Date.now();
      await bounded(bridge.options.set(next), '保存响应超时，结果未知。请重新打开页面核实后再保存。', 15000);
      dirtyNote.textContent = '设置已保存到此插件。';
      message('设置已保存。宿主可能重载插件，会话亲和记忆随之重置。', 'success');
    } catch (error) {
      message(`保存未确认：${errorText(error)}`, 'error');
      dirtyNote.textContent = '表单内容已保留；请核实保存状态后重试。';
    } finally { setBusy(false); }
  });

  $('open-monitor').addEventListener('click', () => {
    if (!connected || busy) return;
    if (!savedMonitorEnabled) { message('请先开启监控并保存，然后重新打开插件页面。', 'error'); return; }
    const service = bridge.service;
    try {
      const url = new URL(service, globalThis.location?.href);
      if (typeof service !== 'string' || !service || !['http:', 'https:'].includes(url.protocol)) throw new Error();
      globalThis.location.replace(url.href);
    } catch { message('当前宿主没有提供有效的插件服务入口。请确认使用支持 page.service 的 Magpie，并在保存后重新打开页面。', 'error'); }
  });

  async function providerSummary() {
    if (typeof bridge.read !== 'function') return;
    try {
      const result = await bounded(bridge.read('providers:list'), '供应商列表读取超时。');
      const providers = Array.isArray(result) ? result : result?.providers;
      if (!Array.isArray(providers)) return;
      const provider = providers.find(item => item && item.id === PROVIDER);
      $('provider-status').textContent = provider
        ? `宿主已列出 ${typeof provider.name === 'string' ? provider.name : PROVIDER}（${PROVIDER}）。只读分组监控需开启后从上方入口访问。`
        : `宿主列表暂未包含 ${PROVIDER}；请检查插件是否启用。只读分组监控需开启后从上方入口访问。`;
    } catch {
      $('provider-status').textContent = `暂时无法读取供应商列表，不影响选项保存。供应商 ID：${PROVIDER}；只读分组监控需开启后从上方入口访问。`;
    }
  }

  async function initialize() {
    bridge = globalThis.magpie;
    if (!bridge || !bridge.ready || typeof bridge.options?.get !== 'function' || typeof bridge.options?.set !== 'function') {
      message('未找到 Magpie 桥接。请从 Magpie 的插件页面打开此面板；直接打开 HTML 无法读取或保存选项。', 'error');
      return;
    }
    try {
      await bounded(bridge.ready, 'Magpie 桥接连接超时，请在宿主中重新打开页面。');
      const raw = optionsObject(await bounded(bridge.options.get(), '读取插件选项超时，请重新打开页面。'));
      populate(raw);
      connected = true;
      setBusy(false);
      message('选项已载入，可编辑并保存。');
      void providerSummary();
    } catch (error) {
      message(`无法载入设置：${errorText(error)}`, 'error');
    }
  }

  void initialize();
})();
