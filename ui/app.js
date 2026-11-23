(() => {
  'use strict';

  const PROVIDER = 'aihub-auto';
  const platforms = ['openai', 'deepseek', 'zhipu', 'kimi', 'grok', 'gemini'];
  const platformLabel = { openai: 'OpenAI', deepseek: 'DeepSeek', zhipu: '智谱', kimi: 'Kimi', grok: 'Grok', gemini: 'Gemini' };
  const catalogueLabels = {
    session_expired: '登录已失效，请重新登录', account_sign_in_required: '账户登录态缺失',
    catalogue_access_denied: '目录无权限', catalogue_unavailable: '目录读取失败',
  };
  const billingLabels = {
    billing_session_expired: '登录已失效，请重新登录', billing_sign_in_required: '账户登录态缺失',
    billing_access_denied: '账单接口无权限', billing_unavailable: '账单读取失败',
  };
  // One icon set, 16px, currentColor: the eye toggles the masked account label.
  const EYE_OPEN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.6"/></svg>';
  const EYE_CLOSED = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 6.2A10.6 10.6 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.7"/><path d="M6.3 7.9A17 17 0 0 0 2 12s3.6 6 10 6c1.5 0 2.8-.3 4-.9"/></svg>';

  const defaults = {
    strategy: 'balanced', maxMultiplier: 0.16, platformCaps: {}, maxAttempts: 3, poolSize: 4,
    dailyBudget: 0, priceAlertRatio: 0.2,
    excludedGroups: [], allowedGroups: [], requirePassed: false,
    minBalance: 0, maxKeysPerAccount: 8, keysPerPlatform: 0, reuseBias: 0.25, evictIdleKeys: false, evictIdleDays: 7,
    autoCreateKeys: false, bareModelIds: false, defaultApi: 'responses', models: [], monitorPort: 19871,
    endpoints: [{ url: 'https://aihub.top', label: '默认' }], endpointMode: 'failover', endpointCooldownMs: 60000,
    spread: 'off', spreadBand: 1.1, maxInflightPerGroup: 0,
    platforms: [...platforms],
  };
  // Preserve only recognized, valid nonsecret settings from the latest options.
  const advancedRanges = {
    refreshMs: [10000, 3600000], maxStaleMs: [10000, 3600000],
    firstByteTimeoutMs: [10, 120000], totalTimeoutMs: [10, 300000],
    cooldownMs: [10, 3600000], sessionTtlMs: [1000, 604800000],
    maxSessions: [1, 50000], maxBodyBytes: [1024, 50 * 1024 * 1024],
  };
  const state = { bridge: null, connected: false, busy: false, dirty: false, view: 'settings', snapshot: null, filter: 'all', loading: false, pickerPlatform: 'all', sort: { key: 'default', dir: 'asc' } };

  function modelIdentity(model) {
    const row = typeof model === 'string' ? { id: model } : model;
    const parts = row?.id?.split('::') ?? [];
    const platform = row?.platform ?? (parts.length === 2 ? parts[0] : 'openai');
    const modelId = parts.length === 2 ? parts[1] : parts[0];
    if (parts.length > 2 || !platforms.includes(platform) || (parts.length === 2 && platform !== parts[0]) || !/^[\w./:@+-]{1,160}$/.test(modelId ?? '')) throw new Error('模型 ID 或平台前缀无效。');
    return { id: platform === 'openai' ? modelId : `${platform}::${modelId}`, platform };
  }

  const $ = id => document.getElementById(id);
  const status = $('status');
  const saveButton = $('save-button');
  const saveRowButton = $('save-row-button');
  const controls = $('controls');
  const form = $('options-form');

  function message(text, kind = '') {
    status.textContent = text;
    status.className = `status${kind ? ` status-${kind}` : ''}`;
    status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  }

  function errorText(error) {
    return error instanceof Error && error.message ? error.message.slice(0, 400) : '宿主未返回可用结果，请重试。';
  }

  // A failed fetch with no status at all is a connection failure: the host
  // retires the page service on every plugin update or settings save and only
  // starts it again on the next call. Messages differ per engine (Firefox
  // "NetworkError when attempting to fetch resource.", Chrome "Failed to
  // fetch"); match on shape, not on realm-sensitive instanceof.
  function isConnectionFailure(error) {
    if (!error || typeof error !== 'object') return false;
    if (error.name === 'TypeError' || error.name === 'AbortError') return true;
    return /NetworkError|Failed to fetch|network error|Load failed/i.test(String(error.message ?? ''));
  }

  function requestSnapshot(url, token) {
    return bounded(fetch(url.href, { headers: { accept: 'application/json', 'x-aihub-service-token': token }, cache: 'no-store' }), '读取快照超时', 20000);
  }

  function renderServiceGap() {
    $('monitor-updated').textContent = '';
    $('monitor-summary').innerHTML = '';
    $('monitor-filters').innerHTML = '';
    $('monitor-body').innerHTML = '<p class="empty">插件宿主刚重载过，页面服务还没就绪——更新插件或保存设置后都会这样，通常一两秒内恢复。</p><p class="empty"><button type="button" class="btn" id="snapshot-retry">重试</button></p>';
    const retry = $('snapshot-retry');
    if (retry && typeof retry.addEventListener === 'function') retry.addEventListener('click', () => { loadSnapshot(); });
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

  function capsToText(caps) {
    return Object.entries(caps ?? {}).map(([platform, cap]) => `${platform}=${cap}`).join('\n');
  }

  function textToCaps(value) {
    const caps = {};
    for (const part of String(value ?? '').split(/[\n,;]+/)) {
      const item = part.trim();
      if (!item) continue;
      const at = item.indexOf('=');
      if (at === -1) throw new Error(`无法识别的倍率上限：${item}`);
      const platform = item.slice(0, at).trim().toLowerCase();
      const cap = Number(item.slice(at + 1).trim());
      if (!platforms.includes(platform)) throw new Error(`未知平台：${platform}`);
      if (!Number.isFinite(cap) || cap < 0 || cap > 100) throw new Error(`倍率上限超出 0–100：${item}`);
      caps[platform] = cap;
    }
    return caps;
  }

  function safeOptions(raw) {
    const result = { ...defaults };
    if (['economy', 'balanced', 'speed', 'price', 'value', 'reliable'].includes(raw.strategy)) result.strategy = raw.strategy;
    if (typeof raw.maxMultiplier === 'number' && Number.isFinite(raw.maxMultiplier) && raw.maxMultiplier >= 0 && raw.maxMultiplier <= 100) result.maxMultiplier = raw.maxMultiplier;
    if (raw.platformCaps && typeof raw.platformCaps === 'object' && !Array.isArray(raw.platformCaps))
      result.platformCaps = Object.fromEntries(Object.entries(raw.platformCaps)
        .filter(([platform, cap]) => platforms.includes(platform) && typeof cap === 'number' && Number.isFinite(cap) && cap >= 0 && cap <= 100));
    if (validInteger(raw.maxAttempts, 1, 5)) result.maxAttempts = raw.maxAttempts;
    if (validInteger(raw.poolSize, 1, 32)) result.poolSize = raw.poolSize;
    if (typeof raw.minBalance === 'number' && Number.isFinite(raw.minBalance) && raw.minBalance >= 0 && raw.minBalance <= 100000) result.minBalance = raw.minBalance;
    if (typeof raw.dailyBudget === 'number' && Number.isFinite(raw.dailyBudget) && raw.dailyBudget >= 0 && raw.dailyBudget <= 1000000) result.dailyBudget = raw.dailyBudget;
    if (typeof raw.priceAlertRatio === 'number' && Number.isFinite(raw.priceAlertRatio) && raw.priceAlertRatio >= 0.01 && raw.priceAlertRatio <= 10) result.priceAlertRatio = raw.priceAlertRatio;
    if (validInteger(raw.maxKeysPerAccount, 1, 32)) result.maxKeysPerAccount = raw.maxKeysPerAccount;
    if (validInteger(raw.keysPerPlatform, 0, 32)) result.keysPerPlatform = raw.keysPerPlatform;
    if (typeof raw.reuseBias === 'number' && Number.isFinite(raw.reuseBias) && raw.reuseBias >= 0 && raw.reuseBias <= 5) result.reuseBias = raw.reuseBias;
    if (validInteger(raw.evictIdleDays, 1, 90)) result.evictIdleDays = raw.evictIdleDays;
    for (const key of ['excludedGroups', 'allowedGroups']) if (groupList(raw[key])) result[key] = [...new Set(raw[key])];
    for (const key of ['requirePassed', 'autoCreateKeys', 'bareModelIds', 'evictIdleKeys']) if (typeof raw[key] === 'boolean') result[key] = raw[key];
    if (['responses', 'chat'].includes(raw.defaultApi)) result.defaultApi = raw.defaultApi;
    for (const [key, [min, max]] of Object.entries(advancedRanges)) if (validInteger(raw[key], min, max)) result[key] = raw[key];
    if (Array.isArray(raw.platforms) && raw.platforms.length && raw.platforms.every(id => platforms.includes(id))) result.platforms = [...new Set(raw.platforms)];
    if (validInteger(raw.monitorPort, 1024, 65535)) result.monitorPort = raw.monitorPort;
    if (Array.isArray(raw.models)) result.models = raw.models;
    if (['sticky', 'failover', 'balance'].includes(raw.endpointMode)) result.endpointMode = raw.endpointMode;
    if (['off', 'p2c', 'weighted'].includes(raw.spread)) result.spread = raw.spread;
    if (typeof raw.spreadBand === 'number' && Number.isFinite(raw.spreadBand) && raw.spreadBand >= 1 && raw.spreadBand <= 5) result.spreadBand = raw.spreadBand;
    if (validInteger(raw.maxInflightPerGroup, 0, 1000)) result.maxInflightPerGroup = raw.maxInflightPerGroup;
    if (validInteger(raw.endpointCooldownMs, 1000, 3600000)) result.endpointCooldownMs = raw.endpointCooldownMs;
    if (Array.isArray(raw.endpoints)) {
      const rows = raw.endpoints.filter(row => row && typeof row.url === 'string').map(row => ({ url: row.url, label: typeof row.label === 'string' ? row.label : '' }));
      if (rows.length) result.endpoints = rows;
    }
    return result;
  }

  function populate(raw) {
    const options = safeOptions(raw);
    for (const key of ['strategy', 'maxMultiplier', 'maxAttempts', 'poolSize', 'defaultApi', 'monitorPort', 'minBalance', 'maxKeysPerAccount', 'keysPerPlatform', 'reuseBias', 'evictIdleDays', 'dailyBudget', 'priceAlertRatio', 'spread', 'maxInflightPerGroup', 'endpointMode']) $(key).value = String(options[key]);
    $('platformCaps').value = capsToText(options.platformCaps);
    $('endpointCooldownSec').value = String(Math.round((options.endpointCooldownMs ?? 60000) / 1000));
    for (const platform of platforms) $(`platform-${platform}`).checked = options.platforms.includes(platform);
    for (const key of ['excludedGroups', 'allowedGroups']) $(key).value = options[key].join(', ');
    for (const key of ['requirePassed', 'autoCreateKeys', 'bareModelIds', 'evictIdleKeys']) $(key).checked = options[key];
    $('models').value = options.models.map(model => {
      const { id } = modelIdentity(model);
      const limit = validInteger(model.context, 1, Number.MAX_SAFE_INTEGER);
      const parts = [id];
      if (model.api) parts.push(model.api);
      if (limit) parts.push(String(model.context));
      if (limit && validInteger(model.output, 1, Number.MAX_SAFE_INTEGER)) parts.push(String(model.output));
      return parts.join('|');
    }).join('\n');
    renderEndpoints(options.endpoints);
    renderGroupPicker();
  }

  function invalid(id, text) {
    const field = $(id);
    field.setAttribute('aria-invalid', 'true');
    if (typeof field.focus === 'function') field.focus();
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

  // ---- group picker ------------------------------------------------------
  // The text input stays the source of truth (it is what gets saved), the list
  // is a convenience layer that reads from the last snapshot and writes back.

  function pickedGroups() {
    try { return readGroups('allowedGroups', '仅允许分组'); } catch { return []; }
  }

  function setPickedGroups(list) {
    const input = $('allowedGroups');
    if (!input) return;
    input.value = [...new Set(list)].sort((a, b) => a - b).join(', ');
    setDirty(true);
    renderGroupPicker();
  }

  function renderGroupPicker() {
    const list = $('group-list');
    if (!list) return;
    const count = $('group-picker-count');
    const all = groups();
    const tools = document.querySelector('.picker-tools');
    if (tools) tools.hidden = !all.length;
    if (!all.length) {
      list.innerHTML = '<p class="empty">打开「监控」页加载一次分组后，这里会列出可点选的分组。</p>';
      if (count) count.textContent = '尚未加载分组';
      return;
    }
    const chips = $('group-platforms');
    if (chips) {
      const counts = new Map();
      for (const group of all) counts.set(group.platform, (counts.get(group.platform) ?? 0) + 1);
      const items = [['all', '全部', all.length], ...platforms.filter(platform => counts.has(platform)).map(platform => [platform, platformLabel[platform], counts.get(platform)])];
      chips.innerHTML = items.map(([key, label, count]) =>
        `<button type="button" class="chip-filter${state.pickerPlatform === key ? ' is-active' : ''}" data-platform="${key}" aria-pressed="${state.pickerPlatform === key}">${escapeHtml(label)}<span>${count}</span></button>`).join('');
    }
    const chosen = new Set(pickedGroups());
    const needle = String($('group-search')?.value ?? '').trim().toLowerCase();
    const onlyEligible = Boolean($('group-only-eligible')?.checked);
    const rows = all
      .filter(group => state.pickerPlatform === 'all' || group.platform === state.pickerPlatform)
      .filter(group => !onlyEligible || group.eligible === true)
      .filter(group => !needle || (group.groupId + ' ' + (group.name ?? '') + ' ' + (group.platform ?? '')).toLowerCase().includes(needle))
      .sort((a, b) => Number(b.eligible === true) - Number(a.eligible === true) || a.groupId - b.groupId);
    if (count) {
      count.textContent = chosen.size
        ? '已锁定 ' + chosen.size + ' 个分组 · 只在这些组里选路'
        : '未限制：留空表示全部满足条件的分组都可能被选中';
    }
    list.innerHTML = rows.slice(0, 200).map(group => {
      const on = chosen.has(group.groupId);
      const tone = group.eligible === true ? 'pill-ok' : 'pill-off';
      const state = group.eligible === true ? '可用' : ((group.reasons ?? [])[0] ?? '被排除');
      const account = group.account ? '<span class="pick-account">' + escapeHtml(group.account) + '</span>' : '';
      return '<button type="button" class="pick' + (on ? ' is-on' : '') + '" data-group="' + group.groupId + '" aria-pressed="' + on + '">'
        + '<span class="pick-id">#' + group.groupId + '</span>'
        + '<span class="pick-name">' + escapeHtml(group.name ?? '分组 ' + group.groupId) + '</span>'
        + '<span class="pick-meta">' + escapeHtml(platformLabel[group.platform] ?? group.platform ?? '—') + ' · ×' + decimal(group.multiplier, 3) + account + '</span>'
        + '<span class="pill ' + tone + '">' + escapeHtml(state) + '</span>'
        + '</button>';
    }).join('') || '<p class="empty">没有匹配的分组，换个关键词试试。</p>';
  }

  function wireGroupPicker() {
    const list = $('group-list');
    if (list) list.addEventListener('click', event => {
      const button = event.target?.closest?.('.pick');
      if (!button) return;
      const id = Number(button.dataset.group);
      if (!Number.isSafeInteger(id)) return;
      const chosen = new Set(pickedGroups());
      if (chosen.has(id)) chosen.delete(id); else chosen.add(id);
      setPickedGroups([...chosen]);
    });
    const search = $('group-search');
    if (search) search.addEventListener('input', () => renderGroupPicker());
    const only = $('group-only-eligible');
    if (only) only.addEventListener('change', () => renderGroupPicker());
    const chips = $('group-platforms');
    if (chips) chips.addEventListener('click', event => {
      const button = event.target?.closest?.('[data-platform]');
      if (!button) return;
      state.pickerPlatform = button.getAttribute('data-platform') || 'all';
      renderGroupPicker();
    });
    const selectEligible = $('group-select-eligible');
    if (selectEligible) selectEligible.addEventListener('click', () => {
      const chosen = new Set(pickedGroups());
      for (const group of groups()) if (group.eligible === true) chosen.add(group.groupId);
      setPickedGroups([...chosen]);
    });
    const clear = $('group-clear');
    if (clear) clear.addEventListener('click', () => setPickedGroups([]));
  }

  function readModels() {
    const text = $('models').value.trim();
    if (!text) return [];
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length > 200) invalid('models', '模型列表最多支持 200 个模型。');
    const seen = new Set();
    return lines.map((line, index) => {
      const parts = line.split('|').map(part => part.trim());
      const [inputId, ...extra] = parts;
      let identity;
      try { identity = modelIdentity(inputId); }
      catch { invalid('models', `第 ${index + 1} 个模型 ID 或平台前缀无效。`); }
      let api;
      let context;
      let output;
      for (const token of extra) {
        if (['responses', 'chat', 'gemini'].includes(token)) {
          if (api) invalid('models', `第 ${index + 1} 个模型重复写了协议。`);
          api = token;
          continue;
        }
        const value = Number(token);
        if (!token || !Number.isSafeInteger(value) || value < 1) {
          invalid('models', `第 ${index + 1} 个模型的上下文参数无效：行尾可依次写 |协议、|context、|output，数字需为正整数。`);
        }
        if (context === undefined) context = value;
        else if (output === undefined) output = value;
        else invalid('models', `第 ${index + 1} 个模型最多带 context 与 output 两个数字。`);
      }
      const protocol = api ?? $('defaultApi').value;
      if (!['responses', 'chat', 'gemini'].includes(protocol)
        || (protocol === 'gemini' && identity.platform !== 'gemini') || (identity.platform === 'gemini' && protocol === 'chat')) {
        invalid('models', `第 ${index + 1} 个模型协议无效：Gemini 使用 responses 或 gemini，其他平台使用 responses 或 chat。`);
      }
      if (context !== undefined && output !== undefined && output > context) {
        invalid('models', `第 ${index + 1} 个模型的输出上限不能大于上下文窗口。`);
      }
      const { id } = identity;
      if (seen.has(id)) invalid('models', `第 ${index + 1} 个模型 ID 重复，请保留一项。`);
      seen.add(id);
      const model = { id };
      if (api) model.api = api;
      if (context !== undefined) model.context = context;
      if (output !== undefined) model.output = output;
      return model;
    });
  }

  function endpointRowHtml(row, index) {
    return `<div class="endpoint-row" data-index="${index}">
      <input class="endpoint-label" type="text" maxlength="24" value="${escapeHtml(row.label ?? '')}" placeholder="标签" aria-label="端点标签">
      <input class="endpoint-url" type="text" value="${escapeHtml(row.url ?? '')}" placeholder="https://aihub.top" aria-label="端点地址" spellcheck="false" autocomplete="off">
      <button class="mini endpoint-remove" type="button" aria-label="移除端点">移除</button>
    </div>`;
  }

  function renderEndpoints(list) {
    const rows = Array.isArray(list) && list.length ? list : [{ url: 'https://aihub.top', label: '默认' }];
    $('endpoint-list').innerHTML = rows.map(endpointRowHtml).join('');
  }

  function readEndpoints() {
    const list = $('endpoint-list');
    if (!list || typeof list.querySelectorAll !== 'function') return undefined;
    const rows = [...list.querySelectorAll('.endpoint-row')].map(row => ({
      url: (row.querySelector?.('.endpoint-url')?.value ?? '').trim(),
      label: (row.querySelector?.('.endpoint-label')?.value ?? '').trim(),
    })).filter(row => row.url);
    return rows.length ? rows : undefined;
  }

  function readForm() {
    if (typeof form.querySelectorAll === 'function') form.querySelectorAll('[aria-invalid]').forEach(field => field.removeAttribute('aria-invalid'));
    if (!['economy', 'balanced', 'speed', 'price', 'value', 'reliable'].includes($('strategy').value)) invalid('strategy', '请选择有效的路由策略。');
    if (!['responses', 'chat'].includes($('defaultApi').value)) invalid('defaultApi', '请选择有效的默认 API。');
    const enabledPlatforms = platforms.filter(platform => $(`platform-${platform}`).checked);
    if (!enabledPlatforms.length) invalid('platform-openai', '请至少选择一个平台。');
    const values = {
      platforms: enabledPlatforms,
      monitorPort: readNumber('monitorPort', '回环端口', 1024, 65535),
      strategy: $('strategy').value,
      maxMultiplier: readNumber('maxMultiplier', '最高倍率', 0, 100, false),
      dailyBudget: readNumber('dailyBudget', '日预算（美元）', 0, 1000000, false),
      priceAlertRatio: readNumber('priceAlertRatio', '价格波动阈值', 0.01, 10, false),
      platformCaps: (() => { try { return textToCaps($('platformCaps').value); } catch (error) { return invalid('platformCaps', error.message); } })(),
      maxAttempts: readNumber('maxAttempts', '最多尝试次数', 1, 5),
      poolSize: readNumber('poolSize', '候选池大小', 1, 32),
      minBalance: readNumber('minBalance', '余额阈值', 0, 100000, false),
      maxKeysPerAccount: readNumber('maxKeysPerAccount', '每账户 Key 上限', 1, 32),
      keysPerPlatform: readNumber('keysPerPlatform', '每平台 Key 配额', 0, 32),
      reuseBias: readNumber('reuseBias', '复用溢价', 0, 5, false),
      evictIdleKeys: $('evictIdleKeys').checked,
      evictIdleDays: readNumber('evictIdleDays', '闲置天数', 1, 90),
      excludedGroups: readGroups('excludedGroups', '排除分组'),
      allowedGroups: readGroups('allowedGroups', '仅允许分组'),
      requirePassed: $('requirePassed').checked,
      autoCreateKeys: $('autoCreateKeys').checked,
      bareModelIds: $('bareModelIds').checked,
      defaultApi: $('defaultApi').value,
      spread: $('spread').value,
      maxInflightPerGroup: readNumber('maxInflightPerGroup', '单分组在途上限', 0, 1000),
      endpointMode: $('endpointMode').value,
      endpointCooldownMs: readNumber('endpointCooldownSec', '端点冷却（秒）', 1, 3600) * 1000,
      models: readModels(),
    };
    // An endpoint list only exists once the page rendered it; a headless save
    // without that list keeps the stored endpoints instead of blanking them.
    const endpoints = readEndpoints();
    if (endpoints) values.endpoints = endpoints;
    return values;
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
    state.busy = value;
    controls.disabled = value || !state.connected;
    saveButton.disabled = value || !state.connected;
    saveButton.textContent = value ? '正在保存…' : '保存设置';
    if (saveRowButton) {
      saveRowButton.disabled = value || !state.connected;
      saveRowButton.textContent = value ? '正在保存…' : '保存设置';
    }
    form.setAttribute('aria-busy', String(value));
  }

  function setDirty(value) {
    state.dirty = value;
    const badge = $('dirty-badge');
    if (badge) badge.hidden = !value;
    // The bottom bar only exists to catch unsaved edits; hide it otherwise.
    $('save-row')?.classList.toggle('is-dirty', value);
  }

  // ---- views -------------------------------------------------------------

  function showView(name) {
    state.view = name;
    for (const [tab, view] of [['settings', 'view-settings'], ['monitor', 'view-monitor']]) {
      const isActive = tab === name;
      const tabNode = $(`tab-${tab}`);
      tabNode.className = `tab${isActive ? ' is-active' : ''}`;
      tabNode.setAttribute('aria-selected', String(isActive));
      $(view).hidden = !isActive;
    }
    if (name === 'monitor') openMonitor();
    else renderGroupPicker();
  }

  function serviceUrl() {
    const raw = state.bridge?.service;
    if (typeof raw !== 'string' || !raw) return '';
    try {
      const url = new URL(raw, globalThis.location?.href);
      return ['http:', 'https:'].includes(url.protocol) ? url : null;
    } catch { return null; }
  }

  function inServicePage() {
    return /\/_magpie\/service\/?$/.test(globalThis.location?.pathname ?? '');
  }

  // Magpie sandboxes the page, so its origin is opaque and a snapshot read is a
  // cross-origin request. The service injects this token into the document it
  // serves; Magpie's static copy keeps the placeholder and never has it.
  function serviceToken() {
    const meta = typeof document.querySelector === 'function' ? document.querySelector('meta[name="aihub-service-token"]') : null;
    const value = meta?.content ?? meta?.getAttribute?.('content') ?? '';
    // The placeholder is what Magpie's static copy carries: only the service
    // replaces it, so a bare placeholder means "not served by the service".
    if (value === '__AIHUB_SERVICE_TOKEN__') return '';
    return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : '';
  }

  function openMonitor() {
    const service = serviceUrl();
    // A readable snapshot token means this document came from the service
    // itself (its loopback origin, directly or through Magpie's proxy); the
    // static page Magpie serves has the placeholder and no connect-src.
    const served = inServicePage() || Boolean(serviceToken());
    if (service && !served) {
      // Open the service page on its monitor view: the reader already asked
      // for it, and the settings tab is where that document starts.
      const target = new URL(service.href);
      target.hash = '#monitor';
      globalThis.location.replace(target.href);
      return;
    }
    if (!served && !state.connected) {
      renderMonitorHint(true);
      return;
    }
    loadSnapshot();
  }

  function renderMonitorHint(local) {
    const port = Number($('monitorPort')?.value) || 19871;
    const text = local
      ? `本机回环页：<a href="http://127.0.0.1:${port}/" target="_blank" rel="noreferrer">http://127.0.0.1:${port}/</a>（在运行 Magpie 的这台电脑上打开）。这个页面由 Magpie 提供，无法直接读取插件服务。`
      : '当前宿主没有提供插件服务入口，监控需要较新版本的 Magpie，并在 magpie web 或插件页面中打开。';
    $('monitor-summary').innerHTML = '';
    $('monitor-filters').innerHTML = '';
    $('monitor-body').innerHTML = `<p class="empty">${text}</p>`;
  }

  async function loadSnapshot() {
    if (state.loading) return;
    const token = serviceToken();
    if (!token) { renderMonitorHint(true); return; }
    state.loading = true;
    $('monitor-refresh').disabled = true;
    $('monitor-body').innerHTML = '<p class="empty">正在读取本机快照…</p>';
    try {
      const url = new URL('snapshot', globalThis.location.href);
      let response;
      try {
        response = await requestSnapshot(url, token);
      } catch (error) {
        if (!isConnectionFailure(error)) throw error;
        // One quiet retry: a restarted host needs a moment to bind its port.
        await new Promise(resolve => setTimeout(resolve, 1000));
        response = await requestSnapshot(url, token);
      }
      if (!response.ok) {
        let payload = null;
        try { payload = await response.json(); } catch { payload = null; }
        const code = typeof payload?.error?.code === 'string' ? payload.error.code : '';
        if (code === 'TOKEN_REJECTED' && reloadForFreshToken()) {
          $('monitor-updated').textContent = '';
          $('monitor-summary').innerHTML = '';
          $('monitor-filters').innerHTML = '';
          $('monitor-body').innerHTML = '<p class="empty">插件刚重载过，页面令牌已过期，正在重新加载…</p>';
          return;
        }
        const hint = {
          TOKEN_REJECTED: '页面令牌已过期，请刷新本页',
          ORIGIN_REJECTED: '请求的 Origin 不是本页，入口代理可能改写或去掉了 Origin',
          HOST_REJECTED: '请求的 Host 不是回环地址，入口代理需保留宿主对 Host 的重写',
          PREFLIGHT_REJECTED: '预检被拒，入口代理可能没有转发 CORS 预检',
        }[code];
        const label = code ? `快照接口返回 ${response.status}（${code}）` : `快照接口返回 ${response.status}`;
        throw new Error(hint ? `${label}：${hint}` : label);
      }
      state.snapshot = await response.json();
      renderSnapshot();
      renderGroupPicker();
    } catch (error) {
      state.snapshot = null;
      if (isConnectionFailure(error)) {
        renderServiceGap();
        return;
      }
      $('monitor-updated').textContent = '';
      $('monitor-summary').innerHTML = '';
      $('monitor-filters').innerHTML = '';
      $('monitor-body').innerHTML = `<p class="empty">读取快照失败：${escapeHtml(errorText(error))}</p>`;
    } finally {
      state.loading = false;
      $('monitor-refresh').disabled = false;
    }
  }

  // A plugin reload replaces the page token, so a document opened before the
  // reload can only recover by asking the host for the current page. Reload at
  // most once per 15 seconds: without the guard a still-broken page would loop.
  const RELOAD_KEY = 'aihub-service-reload';
  function reloadForFreshToken() {
    const loc = globalThis.location;
    if (!loc || typeof loc.reload !== 'function') return false;
    try {
      const last = Number(globalThis.sessionStorage?.getItem(RELOAD_KEY) ?? 0);
      if (Number.isFinite(last) && last > 0 && Date.now() - last < 15000) return false;
      globalThis.sessionStorage?.setItem(RELOAD_KEY, String(Date.now()));
    } catch { /* an opaque origin has no storage; reload anyway */ }
    setTimeout(() => loc.reload(), 250);
    return true;
  }

  // ---- monitor rendering -------------------------------------------------

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  function routeTone(outcome) {
    if (outcome === 'ok' || outcome === 'success' || outcome === 'selected') return 'pill-ok';
    return outcome ? 'pill-off' : 'pill-neutral';
  }
  // The sign belongs before the dollar sign: an account that spent past its
  // top-up reads -$0.10, the same way Magpie's own usage card prints it.
  const money = value => {
    const n = num(value);
    if (n === null) return '—';
    return (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
  };

  async function loadIdentity(index) {
    const token = serviceToken();
    if (!token) return '';
    const url = new URL('identity', globalThis.location.href);
    const response = await bounded(fetch(url.href, { headers: { accept: 'application/json', 'x-aihub-service-token': token }, cache: 'no-store' }), '读取账号超时', 15000);
    if (!response.ok) return '';
    const payload = await response.json();
    const value = Array.isArray(payload?.identities) ? payload.identities[index] : '';
    return typeof value === 'string' ? value : '';
  }

  function renderAccounts(list) {
    const target = $('monitor-accounts');
    if (!target) return;
    if (!list.length) { target.innerHTML = ''; return; }
    target.innerHTML = list.map((account, index) => {
      const billing = account.billing;
      const keys = account.keyState ?? {};
      const mode = account.mode === 'manual' ? '手工 Key' : '账户登录';
      const head = '<header><span class="account-name">' + escapeHtml(account.label || '账户') + '</span>'
        + '<button type="button" class="account-eye" data-account="' + index + '" title="显示完整账号" aria-label="显示完整账号">' + EYE_OPEN + '</button>'
        + '<span class="pill pill-neutral">' + mode + '</span>'
        + (account.stale ? '<span class="pill pill-off">目录较旧</span>' : '') + '</header>';
      if (!billing) {
        const why = account.billingError ? '余额读取失败：' + escapeHtml(billingLabels[account.billingError] ?? account.billingError)
          : account.mode === 'manual' ? '手工 Key 模式不读取账户余额' : '余额尚未读取';
        const dead = account.billingError === 'billing_session_expired' || account.billingError === 'billing_sign_in_required';
        const hint = dead ? '<p class="account-empty">在 Magpie「供应商 → AIHub Auto」里重新登录，回到本页点「刷新」。</p>' : '';
        return '<article class="account-card">' + head + '<p class="account-empty">' + why + '</p>' + hint + '</article>';
      }
      const platforms = Array.isArray(billing.platforms) ? billing.platforms : [];
      const total = pick => platforms.reduce((sum, item) => sum + (num(item?.[pick]) ?? 0), 0);
      const usage = billing.usage;
      const events = Array.isArray(account.keyEvents) ? account.keyEvents.slice(-3) : [];
      const platformList = platforms.length ? '<ul class="account-platforms">' + platforms.map(item => {
        const daily = '今 ' + money(item.dailyUsage) + (num(item.dailyLimit) === null ? '' : ' / ' + money(item.dailyLimit));
        const monthly = num(item.monthlyLimit) === null ? '' : ' · 月 ' + money(item.monthlyUsage) + ' / ' + money(item.monthlyLimit);
        return '<li><span>' + escapeHtml(platformLabel[item.platform] ?? item.platform ?? '—') + '</span><span class="mono">' + daily + monthly + '</span></li>';
      }).join('') + '</ul>' : '';
      const actionLabel = { created: '新建 Key', recovered: '复用已有 Key', blocked: '已阻止', evicted: '清理闲置 Key' };
      const eventLine = events.length ? '<p class="account-events">' + events.map(e => {
        const label = actionLabel[e.action] ?? e.action;
        return clock(e.at) + ' ' + escapeHtml(label) + (e.action === 'blocked' && e.code ? '（' + escapeHtml(e.code) + '）' : '');
      }).join(' · ') + '</p>' : '';
      // Key inventory: what exists, which connection created it, and whether it ever carried a request.
      const keyRows = Array.isArray(account.keys) ? account.keys : [];
      const neverUsed = keyRows.filter(key => key.owned === true && !key.lastUsedAt).length;
      const evicted = Array.isArray(account.evictions) ? account.evictions : [];
      const evictionLine = evicted.length ? '<p class="account-note">按策略清理 ' + evicted.length + ' 把闲置 Key：'
        + evicted.slice(0, 3).map(gone => 'g' + escapeHtml(String(gone.groupId ?? '—')) + ' · ' + clock(gone.at)).join(' · ') + '</p>' : '';
      const keyPool = keyRows.length ? '<details class="account-keys"><summary>Key 池 ' + keyRows.length + ' 把'
        + (neverUsed ? ' · 未使用 ' + neverUsed + ' 把（可撤销）' : '') + '</summary><ul>'
        + keyRows.slice(0, 12).map(key => '<li><span>' + escapeHtml(platformLabel[key.platform] ?? key.platform ?? '—')
          + ' · #' + escapeHtml(String(key.groupId ?? '—')) + '</span><span class="cell-sub">'
          + (key.owned ? '插件创建' : '手工') + ' · ' + (key.lastUsedAt ? '用于 ' + clock(key.lastUsedAt) : '从未使用')
          + '</span></li>').join('') + '</ul></details>' : '';
      return '<article class="account-card">' + head
        + '<div class="account-balance"><span class="account-figure"' + (billing.balanceKnown === false ? ' title="该账户未返回余额字段（可能是组织或配额账号）"' : '') + '>' + money(billing.balance) + '</span>'
        + '<span class="account-sub">可用余额 · 冻结 ' + money(billing.frozen) + '</span>'
        + (billing.balanceKnown === false ? '<span class="account-note">该账户未返回余额字段（组织/配额账号）</span>' : '')
        + '</div>'
        + '<dl class="account-metrics">'
        + '<div><dt>今日消耗</dt><dd>' + money(total('dailyUsage')) + '</dd></div>'
        + '<div><dt>本月消耗</dt><dd>' + money(total('monthlyUsage')) + '</dd></div>'
        + '<div><dt>累计请求</dt><dd>' + (usage && num(usage.requests) !== null ? num(usage.requests).toLocaleString('zh-CN') : '—') + '</dd></div>'
        + '<div><dt>专用 Key</dt><dd>' + (keys.ready ?? 0) + (keys.maxKeysPerAccount ? ' / ' + keys.maxKeysPerAccount : '') + '</dd></div>'
        + '</dl>' + platformList + eventLine + evictionLine + keyPool + '</article>';
    }).join('');
  }

  const percent = value => num(value) === null ? '—' : `${(num(value) * 100).toFixed(1)}%`;
  const decimal = (value, digits = 2) => num(value) === null ? '—' : num(value).toFixed(digits);
  const clock = value => {
    const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
  };

  function accounts() {
    return Array.isArray(state.snapshot?.accounts) ? state.snapshot.accounts : [];
  }

  function groups() {
    return accounts().flatMap(account => (account.groups ?? []).map(group => ({ ...group, account: account.label, stale: account.stale })));
  }

  function visibleGroups() {
    const rows = groups();
    return state.filter === 'all' ? rows : rows.filter(row => row.platform === state.filter);
  }

  // Every header is a sort key: the first click sorts ascending, the next flips it.
  const sortColumns = [
    { key: 'name', label: '分组', className: '', hint: '', value: row => String(row.name || '') },
    { key: 'multiplier', label: '倍率', className: 'num', hint: '大厅给出的倍率，悬停看评分', value: row => num(row.multiplier) },
    { key: 'latency', label: '首字', className: 'num', hint: '大厅样本的首字耗时（TTFT）', value: row => num(row.latency) },
    { key: 'samples', label: '样本', className: 'num', hint: '区间窗口内的样本数', value: row => num(row.metrics?.samples) },
    { key: 'successRate', label: '成功率', className: 'num', hint: '', value: row => num(row.metrics?.successRate) },
    { key: 'cacheHitRate', label: '缓存', className: 'num', hint: '缓存命中率', value: row => num(row.metrics?.cacheHitRate) },
    { key: 'tps', label: 'TPS', className: 'num', hint: '', value: row => num(row.metrics?.tps) },
    { key: 'realPrice', label: '价格 $/M', className: 'num', hint: '按区间窗口的实际成本与 Token 折算为每百万 Token 美元', value: row => num(row.metrics?.realPrice) },
    { key: 'models', label: '模型', className: 'num', hint: '大厅模型卡片里该分组声明的模型数', value: row => (Array.isArray(row.models) ? row.models.length : 0) },
    { key: 'selectedCount', label: '使用', className: 'num', hint: '当前会话里共享该分组的路由数', value: row => num(row.selectedCount) ?? 0 },
    { key: 'eligible', label: '状态', className: '', hint: '是否通过全部闸门；悬停看被排除的原因', value: row => (row.eligible === true ? 1 : 0) },
    { key: 'lastUsedAt', label: '最后使用', className: 'num', hint: '', value: row => num(row.lastUsedAt) },
  ];

  function orderRows(list) {
    const column = sortColumns.find(item => item.key === state.sort.key);
    if (!column) {
      // The default order puts every usable group first, cheapest multiplier next.
      return list.sort((a, b) => Number(b.eligible === true) - Number(a.eligible === true) || (a.multiplier ?? 1e9) - (b.multiplier ?? 1e9));
    }
    const sign = state.sort.dir === 'desc' ? -1 : 1;
    return [...list].sort((a, b) => {
      const left = column.value(a);
      const right = column.value(b);
      if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1;
      if (right === null || right === undefined) return -1;
      if (typeof left === 'string' || typeof right === 'string') return sign * String(left).localeCompare(String(right), 'zh-CN');
      return sign * (left - right);
    });
  }

  function headHtml() {
    return sortColumns.map(column => {
      const active = state.sort.key === column.key;
      const arrow = active ? (state.sort.dir === 'asc' ? '↑' : '↓') : '';
      const aria = active ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
      const hint = column.hint ? ` title="${escapeHtml(column.hint)}"` : '';
      return `<th scope="col" class="${column.className} sortable${active ? ' is-sorted' : ''}" data-sort="${column.key}" aria-sort="${aria}"${hint}>${column.label}<span class="sort-arrow">${arrow}</span></th>`;
    }).join('');
  }

  function renderEndpointHealth() {
    const rows = Array.isArray(state.snapshot?.endpoints) ? state.snapshot.endpoints : [];
    const target = $('monitor-endpoints');
    if (!target) return;
    if (!rows.length) { target.innerHTML = ''; return; }
    const modeLabel = { failover: '故障转移', sticky: '只用主端点', balance: '均衡' }[state.snapshot?.endpointMode] ?? '—';
    target.innerHTML = `<div class="endpoint-head"><span class="endpoint-title">端点</span><span class="endpoint-mode">${escapeHtml(modeLabel)}</span></div>` + rows.map(row => `
      <div class="endpoint-health">
        <span class="dot ${row.ok ? 'dot-ok' : 'dot-off'}"></span>
        <span class="endpoint-name">${escapeHtml(row.label || row.url)}</span>
        <span class="endpoint-url mono">${escapeHtml(row.url)}</span>
        <span class="endpoint-metric">${row.latencyMs === null || row.latencyMs === undefined ? '—' : row.latencyMs + 'ms'}</span>
        <span class="endpoint-metric">${row.failures ? `失败 ${row.failures}` : '无失败'}</span>
      </div>`).join('');
  }

  function renderSnapshot() {
    const rows = groups();
    const accountsList = accounts();
    const routes = accountsList.flatMap(account => account.routes ?? []);
    const eligible = rows.filter(row => row.eligible === true).length;
    const stale = accountsList.some(account => account.stale);
    const errorCode = accountsList.find(account => account.errorCode)?.errorCode ?? '';
    $('monitor-updated').textContent = state.snapshot?.generatedAt ? `更新于 ${clock(state.snapshot.generatedAt)}` : '';
    renderAccounts(accountsList);
    renderEndpointHealth();

    const skipped = new Map();
    for (const row of rows) if (row.eligible !== true) for (const reason of row.reasons ?? []) skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
    const skippedTop = [...skipped].sort((a, b) => b[1] - a[1]);
    const skippedHint = skippedTop.length ? `主因：${skippedTop.slice(0, 2).map(([reason, count]) => `${reason} ×${count}`).join('、')}` : '没有分组被排除';
    const spendUsd = accountsList.reduce((sum, account) => sum + (num(account.spend?.usd) ?? 0), 0);
    const budget = accountsList.map(account => num(account.budget)).find(value => value !== null && value > 0) ?? 0;
    const changes = accountsList.flatMap(account => (account.priceChanges ?? []).map(change => ({ ...change, account: account.label }))).slice(-5);
    $('monitor-summary').innerHTML = [
      ['今日花费', money(spendUsd), budget > 0 ? `预算 ${money(budget)}` : '未设预算（插件设置）', '按响应里的 usage 与分组真实价格估算，单位与真实价格列一致'],
      ['账户', accountsList.length, errorCode ? `目录：${escapeHtml(catalogueLabels[errorCode] ?? errorCode)}` : stale ? '目录较旧' : '目录已刷新'],
      ['分组', rows.length, '来自当前目录'],
      ['可用分组', eligible, `${rows.length - eligible} 个被排除 · ${escapeHtml(skippedHint)}`, skippedTop.map(([reason, count]) => `${reason} ×${count}`).join('\n')],
      ['路由记录', routes.length, '最近 100 条内存记录'],
    ].map(([label, value, hint, title]) => `
      <div class="kpi"${title ? ` title="${escapeHtml(title)}"` : ''}>
        <span class="kpi-label">${label}</span>
        <span class="kpi-value">${value}</span>
        <span class="kpi-hint">${hint}</span>
      </div>`).join('') + (changes.length ? (() => {
      const all = changes.map(change => `${change.name || '#' + String(change.groupId ?? '')} ${decimal(change.from, 3)}→${decimal(change.to, 3)}`);
      const first = changes[0];
      const from = num(first.from);
      const to = num(first.to);
      const ratio = from > 0 && to !== null ? Math.round((to / from - 1) * 100) : null;
      return `<div class="kpi" title="${escapeHtml(all.join('\n'))}">
        <span class="kpi-label">价格波动</span>
        <span class="kpi-value">${changes.length}</span>
        <span class="kpi-hint">${escapeHtml(first.name || '#' + String(first.groupId ?? ''))} ${ratio === null ? '' : (ratio > 0 ? '+' : '') + ratio + '%'}${changes.length > 1 ? ` · 另 ${changes.length - 1} 处` : ''}</span>
      </div>`;
    })() : '');

    const counts = new Map();
    for (const row of rows) counts.set(row.platform, (counts.get(row.platform) ?? 0) + 1);
    const chips = [['all', '全部', rows.length], ...platforms.filter(p => counts.has(p)).map(p => [p, platformLabel[p], counts.get(p)])];
    $('monitor-filters').innerHTML = chips.map(([key, label, count]) =>
      `<button type="button" class="filter${state.filter === key ? ' is-active' : ''}" data-filter="${key}">${label}<span>${count}</span></button>`).join('');

    const list = orderRows(visibleGroups());
    if (!accountsList.length) {
      $('monitor-body').innerHTML = '<p class="empty">还没有登录的 AIHub 账户。先在 Magpie 里登录 aihub-auto，再回到这里刷新。</p>';
      return;
    }
    if (!list.length) {
      $('monitor-body').innerHTML = '<p class="empty">当前筛选条件下没有分组。</p>';
      return;
    }
    const rowsHtml = list.map(row => {
      const reasons = Array.isArray(row.reasons) ? row.reasons : [];
      const stateLabel = row.eligible === true ? '可用' : (row.passed === false || row.detection === 'failed') ? '未通过' : '不可用';
      const why = row.eligible === true || !reasons.length ? '' : `<span class="cell-sub cell-why" title="${escapeHtml(reasons.join('\n'))}">${escapeHtml(reasons[0])}${reasons.length > 1 ? ` +${reasons.length - 1}` : ''}</span>`;
      const stateText = `<span class="dot ${row.eligible === true ? 'dot-ok' : 'dot-off'}"></span><span class="cell-state-text">${stateLabel}</span>${why}`;
      return `<tr class="${row.eligible === true ? '' : 'is-off'}${row.eligible === true && Number(row.selectedCount) > 0 ? ' is-current' : ''}">
        <td class="cell-group"><span class="cell-name">${escapeHtml(row.name || `分组 ${row.groupId ?? ''}`)}</span><span class="cell-sub">${escapeHtml(platformLabel[row.platform] ?? row.platform ?? '—')} · #${escapeHtml(row.groupId ?? '—')} · ${escapeHtml(row.account)}</span></td>
        <td class="num">${row.multiplier === null || row.multiplier === undefined ? '—' : `×${decimal(row.multiplier, 3)}`}</td>
        <td class="num">${num(row.latency) === null ? '—' : (num(row.latency) / 1000).toFixed(1) + 's'}</td>
        <td class="num" title="${num(row.metrics?.observedSeconds) === null ? '窗口时长未知' : `窗口 ${Math.round(num(row.metrics.observedSeconds) / 60)} 分钟`}">${num(row.metrics?.samples) === null ? '—' : num(row.metrics.samples).toLocaleString('zh-CN')}</td>
        <td class="num" title="${row.metrics?.successRateWindow ? `${row.metrics.successRateWindow} 档成功率 ${percent(row.metrics?.successRate)}${row.metrics.successRateWindow === '1h' ? '（大厅当前只给 1h 档）' : ''}` : '大厅未给成功率'}">${percent(row.metrics?.successRate)}</td>
        <td class="num">${percent(row.metrics?.cacheHitRate)}</td>
        <td class="num">${decimal(row.metrics?.tps, 1)}</td>
        <td class="num" title="${num(row.metrics?.realPrice) === null ? '窗口未就绪或没有区间样本' : `$${decimal(row.metrics.realPrice, 3)}/M ≈ ¥${(row.metrics.realPrice * 7.2).toFixed(2)}/M`}">${num(row.metrics?.realPrice) === null ? '—' : `$${decimal(row.metrics.realPrice, 3)}`}</td>
        <td class="num" title="${escapeHtml((Array.isArray(row.cards) && row.cards.length ? row.cards : (Array.isArray(row.models) ? row.models : []).map(model => ({ model }))).slice(0, 20).map(card => `${card.model}${num(card.price) === null ? '' : ` · ¥${decimal(card.price, 4)}`}${num(card.sampleCount) === null ? '' : ` · ${card.sampleCount} 样本`}${card.health === 'failed' ? ' · 检测失败' : ''}`).join('\n'))}">${Array.isArray(row.models) ? row.models.length : 0}</td>
        <td class="num" title="${row.hasKey ? '本连接已为该分组建了 Key' : '本连接尚未为该分组建 Key'}${row.inflight ? ` · 在途 ${row.inflight}` : ''}">${row.selectedCount ?? 0}</td>
        <td>${stateText}</td>
        <td class="num">${clock(row.lastUsedAt)}</td>
      </tr>`;
    }).join('');
    const routeHtml = routes.length ? routes.slice(-8).reverse().map(route => `
      <li><span class="mono">${clock(route.at)}</span><span>${escapeHtml(platformLabel[route.platform] ?? route.platform ?? '—')} · ${escapeHtml(route.model || '—')}</span><span class="cell-sub">#${escapeHtml(route.groupId ?? '—')}</span><span class="pill ${routeTone(route.outcome)}">${escapeHtml(route.outcome || '—')}</span></li>`).join('') : '';
    $('monitor-body').innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead><tr>${headHtml()}</tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <p class="note">指标缺失或未就绪时显示 —，不用 0 冒充；目录刷新只读 AIHub 接口，不跑推理、不建 Key。</p>
      ${routeHtml ? `<div class="routes"><h3>最近路由</h3><ul>${routeHtml}</ul></div>` : ''}`;
  }

  // ---- wiring ------------------------------------------------------------

  form.addEventListener('input', event => {
    if (event.target && typeof event.target.removeAttribute === 'function') event.target.removeAttribute('aria-invalid');
    setDirty(true);
  });
  form.addEventListener('change', () => setDirty(true));

  $('endpoint-add').addEventListener('click', () => {
    const rows = [...$('endpoint-list').querySelectorAll('.endpoint-row')].map(row => ({
      url: row.querySelector('.endpoint-url')?.value ?? '', label: row.querySelector('.endpoint-label')?.value ?? '',
    }));
    if (rows.length >= 8) { message('最多 8 个端点。', 'error'); return; }
    $('endpoint-list').innerHTML = [...rows, { url: '', label: '' }].map(endpointRowHtml).join('');
    setDirty(true);
  });
  $('endpoint-list').addEventListener('click', event => {
    const button = event.target.closest?.('.endpoint-remove');
    const row = button?.closest('.endpoint-row');
    if (!row) return;
    if ($('endpoint-list').querySelectorAll('.endpoint-row').length <= 1) { message('至少保留一个端点。', 'error'); return; }
    row.remove();
    setDirty(true);
  });
  // Draw the default row before any host options arrive, so the list is never
  // an empty box on a page that cannot reach the bridge.
  if ($('endpoint-list') && !$('endpoint-list').innerHTML) renderEndpoints();

  async function save() {
    if (state.busy || !state.connected) return;
    let changes;
    try { changes = readForm(); }
    catch (error) { message(errorText(error), 'error'); return; }
    setBusy(true);
    message('正在保存…');
    try {
      const previous = optionsObject(await bounded(state.bridge.options.get(), '读取插件选项超时'));
      const previousModels = Array.isArray(previous.models) ? previous.models : [];
      const options = { ...safeOptions(previous), ...changes };
      options.models = preserveModelLimits(changes.models, previousModels);
      await bounded(state.bridge.options.set(options), '保存插件选项超时');
      setDirty(false);
      message('已保存。宿主可能重载插件，重载后本页会自动刷新。', 'success');
    } catch (error) {
      message(`保存未确认：${errorText(error)} 可重试，或到 Magpie 的插件选项里检查。`, 'error');
    } finally {
      setBusy(false);
    }
  }

  saveButton.addEventListener('click', save);
  if (saveRowButton) saveRowButton.addEventListener('click', save);
  $('tab-settings').addEventListener('click', () => showView('settings'));
  $('tab-monitor').addEventListener('click', () => showView('monitor'));
  $('monitor-refresh').addEventListener('click', () => loadSnapshot());
  let pruneArmed = false;
  $('monitor-prune').addEventListener('click', async () => {
    const button = $('monitor-prune');
    button.disabled = true;
    const apply = pruneArmed;
    $('monitor-updated').textContent = apply ? '正在清理闲置 Key…' : '正在检查闲置 Key…';
    try {
      const url = new URL('prune', globalThis.location.href);
      const response = await bounded(fetch(url.href, {
        method: 'POST', cache: 'no-store',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'x-aihub-service-token': serviceToken() },
        body: JSON.stringify({ apply }),
      }), '清理超时', 30000);
      const payload = await response.json().catch(() => null);
      const data = payload?.data ?? null;
      if (!response.ok || !data) throw new Error(payload?.error?.message ?? `清理失败（HTTP ${response.status}）`);
      if (!apply) {
        const candidates = data.candidates?.length ?? 0;
        pruneArmed = candidates > 0;
        const stale = data.stale ?? 0;
        $('monitor-updated').textContent = candidates > 0
          ? `发现 ${candidates} 把闲置 Key${stale ? `，并清理了 ${stale} 条失效记录` : ''}，再点一次确认清理`
          : (stale ? `已清理 ${stale} 条失效记录，没有闲置 Key` : '没有闲置 Key');
      } else {
        pruneArmed = false;
        const failed = data.failed?.length ?? 0;
        const stale = data.stale ?? 0;
        $('monitor-updated').textContent = `已清理 ${data.deleted ?? 0} 把闲置 Key${stale ? `，并清理 ${stale} 条失效记录` : ''}${failed ? `，${failed} 把失败` : ''}`;
        await loadSnapshot();
      }
    } catch (error) {
      $('monitor-updated').textContent = `清理失败：${error?.message ?? error}`;
    } finally { button.disabled = false; }
  });
  $('monitor-accounts').addEventListener('click', async event => {
    const button = event.target && typeof event.target.closest === 'function' ? event.target.closest('.account-eye') : null;
    if (!button) return;
    const card = button.closest('.account-card');
    const name = card ? card.querySelector('.account-name') : null;
    if (!name) return;
    if (button.dataset.shown === '1') {
      name.textContent = button.dataset.masked || name.textContent;
      button.dataset.shown = '0';
      button.innerHTML = EYE_OPEN;
      return;
    }
    try {
      const full = await loadIdentity(Number(button.dataset.account));
      if (!full) return;
      button.dataset.masked = name.textContent;
      name.textContent = full;
      button.dataset.shown = '1';
      button.innerHTML = EYE_CLOSED;
    } catch { /* keep the masked label */ }
  });
  wireGroupPicker();
  $('monitor-filters').addEventListener('click', event => {
    const target = event.target?.closest?.('[data-filter]');
    if (!target) return;
    state.filter = target.getAttribute('data-filter') || 'all';
    renderSnapshot();
  });
  $('monitor-body').addEventListener('click', event => {
    const header = event.target?.closest?.('th[data-sort]');
    if (!header) return;
    const key = header.getAttribute('data-sort');
    state.sort = { key, dir: state.sort.key === key && state.sort.dir === 'asc' ? 'desc' : 'asc' };
    renderSnapshot();
  });

  // Magpie hands the page its theme: use its tokens instead of guessing from
  // the OS, so the page looks like the window it is drawn in.
  function applyTheme(theme) {
    if (!theme || typeof theme !== 'object') return;
    const root = document.documentElement;
    if (typeof theme.dark === 'boolean') {
      root.dataset.theme = theme.dark ? 'dark' : 'light';
      root.style.colorScheme = theme.dark ? 'dark' : 'light';
    }
    const tokens = theme.tokens && typeof theme.tokens === 'object' ? theme.tokens : {};
    for (const [key, value] of Object.entries(tokens)) {
      if (!/^[a-z][a-z0-9-]{0,40}$/i.test(key)) continue;
      if (typeof value !== 'string' || value.length > 64) continue;
      root.style.setProperty(`--magpie-${key}`, value);
    }
  }

  async function connect() {
    const bridge = globalThis.magpie;
    if (!bridge || typeof bridge.options?.get !== 'function') {
      // The loopback service has no bridge: settings stay with the Magpie page.
      if (serviceToken()) message('已连接本机插件服务；修改设置请回到 Magpie 的插件页面。');
      else message('未找到 Magpie 页面桥接，设置不可用；监控可在本机回环页查看。', 'error');
      saveButton.disabled = true;
      return;
    }
    state.bridge = bridge;
    try {
      await bounded(bridge.ready, '连接 Magpie 超时');
      applyTheme(bridge.theme);
      if (typeof bridge.onTheme === 'function') bridge.onTheme(applyTheme);
      const options = await bounded(bridge.options.get(), '读取插件选项超时');
      populate(optionsObject(options));
      state.connected = true;
      setBusy(false);
      message('已连接 Magpie', 'success');
      setDirty(false);
    } catch (error) {
      message(`初始化失败：${errorText(error)}`, 'error');
      saveButton.disabled = true;
    }
  }

  connect().then(() => {
    // Deep link: /#monitor opens the read-only view without leaving the page.
    if (globalThis.location?.hash === '#monitor') showView('monitor');
  });
})();
