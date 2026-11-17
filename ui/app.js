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
  const defaults = {
    strategy: 'balanced', maxMultiplier: 0.16, platformCaps: {}, maxAttempts: 3, poolSize: 4,
    dailyBudget: 0, priceAlertRatio: 0.2,
    excludedGroups: [], allowedGroups: [], requirePassed: false,
    minBalance: 0, maxKeysPerAccount: 8,
    autoCreateKeys: false, defaultApi: 'responses', models: [], monitorPort: 19871,
    platforms: [...platforms],
  };
  // Preserve only recognized, valid nonsecret settings from the latest options.
  const advancedRanges = {
    refreshMs: [10000, 3600000], maxStaleMs: [10000, 3600000],
    firstByteTimeoutMs: [10, 120000], totalTimeoutMs: [10, 300000],
    cooldownMs: [10, 3600000], sessionTtlMs: [1000, 604800000],
    maxSessions: [1, 50000], maxBodyBytes: [1024, 50 * 1024 * 1024],
  };
  const state = { bridge: null, connected: false, busy: false, dirty: false, view: 'settings', snapshot: null, filter: 'all', loading: false };

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
  const controls = $('controls');
  const form = $('options-form');
  const dirtyNote = $('dirty-note');

  function message(text, kind = '') {
    status.textContent = text;
    status.className = `status${kind ? ` status-${kind}` : ''}`;
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
    if (validInteger(raw.poolSize, 1, 8)) result.poolSize = raw.poolSize;
    if (typeof raw.minBalance === 'number' && Number.isFinite(raw.minBalance) && raw.minBalance >= 0 && raw.minBalance <= 100000) result.minBalance = raw.minBalance;
    if (typeof raw.dailyBudget === 'number' && Number.isFinite(raw.dailyBudget) && raw.dailyBudget >= 0 && raw.dailyBudget <= 1000000) result.dailyBudget = raw.dailyBudget;
    if (typeof raw.priceAlertRatio === 'number' && Number.isFinite(raw.priceAlertRatio) && raw.priceAlertRatio >= 0.01 && raw.priceAlertRatio <= 10) result.priceAlertRatio = raw.priceAlertRatio;
    if (validInteger(raw.maxKeysPerAccount, 1, 32)) result.maxKeysPerAccount = raw.maxKeysPerAccount;
    for (const key of ['excludedGroups', 'allowedGroups']) if (groupList(raw[key])) result[key] = [...new Set(raw[key])];
    for (const key of ['requirePassed', 'autoCreateKeys']) if (typeof raw[key] === 'boolean') result[key] = raw[key];
    if (['responses', 'chat'].includes(raw.defaultApi)) result.defaultApi = raw.defaultApi;
    for (const [key, [min, max]] of Object.entries(advancedRanges)) if (validInteger(raw[key], min, max)) result[key] = raw[key];
    if (Array.isArray(raw.platforms) && raw.platforms.length && raw.platforms.every(id => platforms.includes(id))) result.platforms = [...new Set(raw.platforms)];
    if (validInteger(raw.monitorPort, 1024, 65535)) result.monitorPort = raw.monitorPort;
    if (Array.isArray(raw.models)) result.models = raw.models;
    return result;
  }

  function populate(raw) {
    const options = safeOptions(raw);
    for (const key of ['strategy', 'maxMultiplier', 'maxAttempts', 'poolSize', 'defaultApi', 'monitorPort', 'minBalance', 'maxKeysPerAccount', 'dailyBudget', 'priceAlertRatio']) $(key).value = String(options[key]);
    $('platformCaps').value = capsToText(options.platformCaps);
    for (const platform of platforms) $(`platform-${platform}`).checked = options.platforms.includes(platform);
    for (const key of ['excludedGroups', 'allowedGroups']) $(key).value = options[key].join(', ');
    for (const key of ['requirePassed', 'autoCreateKeys']) $(key).checked = options[key];
    $('models').value = options.models.map(model => {
      const { id } = modelIdentity(model);
      return model.api ? `${id}|${model.api}` : id;
    }).join('\n');
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
    if (typeof form.querySelectorAll === 'function') form.querySelectorAll('[aria-invalid]').forEach(field => field.removeAttribute('aria-invalid'));
    if (!['economy', 'balanced', 'speed', 'price', 'value', 'reliable'].includes($('strategy').value)) invalid('strategy', '请选择有效的路由策略。');
    if (!['responses', 'chat'].includes($('defaultApi').value)) invalid('defaultApi', '请选择有效的默认 API。');
    const enabledPlatforms = platforms.filter(platform => $(`platform-${platform}`).checked);
    if (!enabledPlatforms.length) invalid('platform-openai', '请至少选择一个平台。');
    return {
      platforms: enabledPlatforms,
      monitorPort: readNumber('monitorPort', '回环端口', 1024, 65535),
      strategy: $('strategy').value,
      maxMultiplier: readNumber('maxMultiplier', '最高倍率', 0, 100, false),
      dailyBudget: readNumber('dailyBudget', '日预算（美元）', 0, 1000000, false),
      priceAlertRatio: readNumber('priceAlertRatio', '价格波动阈值', 0.01, 10, false),
      platformCaps: (() => { try { return textToCaps($('platformCaps').value); } catch (error) { return invalid('platformCaps', error.message); } })(),
      maxAttempts: readNumber('maxAttempts', '最多尝试次数', 1, 5),
      poolSize: readNumber('poolSize', '候选池大小', 1, 8),
      minBalance: readNumber('minBalance', '余额阈值', 0, 100000, false),
      maxKeysPerAccount: readNumber('maxKeysPerAccount', '每账户 Key 上限', 1, 32),
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
    state.busy = value;
    controls.disabled = value || !state.connected;
    saveButton.disabled = value || !state.connected;
    saveButton.textContent = value ? '正在保存…' : '保存设置';
    form.setAttribute('aria-busy', String(value));
  }

  function setDirty(value) {
    state.dirty = value;
    if (dirtyNote) dirtyNote.textContent = value ? '有未保存的更改。' : '设置只保存在此插件的非敏感选项里。';
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
      const response = await bounded(fetch(url.href, { headers: { accept: 'application/json', 'x-aihub-service-token': token }, cache: 'no-store' }), '读取快照超时', 20000);
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
    } catch (error) {
      state.snapshot = null;
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
  const money = value => num(value) === null ? '—' : '$' + num(value).toFixed(2);

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
        + '<button type="button" class="account-eye" data-account="' + index + '" title="显示完整账号" aria-label="显示完整账号">👁</button>'
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
      const actionLabel = { created: '新建 Key', recovered: '复用已有 Key', blocked: '已阻止' };
      const eventLine = events.length ? '<p class="account-events">' + events.map(e => {
        const label = actionLabel[e.action] ?? e.action;
        return clock(e.at) + ' ' + escapeHtml(label) + (e.action === 'blocked' && e.code ? '（' + escapeHtml(e.code) + '）' : '');
      }).join(' · ') + '</p>' : '';
      // Key inventory: what exists, which connection created it, and whether it ever carried a request.
      const keyRows = Array.isArray(account.keys) ? account.keys : [];
      const neverUsed = keyRows.filter(key => key.owned === true && !key.lastUsedAt).length;
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
        + '</dl>' + platformList + eventLine + keyPool + '</article>';
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

  function renderSnapshot() {
    const rows = groups();
    const accountsList = accounts();
    const routes = accountsList.flatMap(account => account.routes ?? []);
    const eligible = rows.filter(row => row.eligible === true).length;
    const stale = accountsList.some(account => account.stale);
    const errorCode = accountsList.find(account => account.errorCode)?.errorCode ?? '';
    $('monitor-updated').textContent = state.snapshot?.generatedAt ? `更新于 ${clock(state.snapshot.generatedAt)}` : '';
    renderAccounts(accountsList);

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
      </div>`).join('') + (changes.length ? '<div class="kpi"><span class="kpi-label">价格波动</span><span class="kpi-hint">'
        + changes.map(change => `${escapeHtml(change.name || '#' + String(change.groupId ?? ''))} ${decimal(change.from, 4)}→${decimal(change.to, 4)}`).join(' · ')
        + '</span></div>' : '');

    const counts = new Map();
    for (const row of rows) counts.set(row.platform, (counts.get(row.platform) ?? 0) + 1);
    const chips = [['all', '全部', rows.length], ...platforms.filter(p => counts.has(p)).map(p => [p, platformLabel[p], counts.get(p)])];
    $('monitor-filters').innerHTML = chips.map(([key, label, count]) =>
      `<button type="button" class="filter${state.filter === key ? ' is-active' : ''}" data-filter="${key}">${label}<span>${count}</span></button>`).join('');

    const list = visibleGroups();
    if (!accountsList.length) {
      $('monitor-body').innerHTML = '<p class="empty">还没有登录的 AIHub 账户。先在 Magpie 里登录 aihub-auto，再回到这里刷新。</p>';
      return;
    }
    if (!list.length) {
      $('monitor-body').innerHTML = '<p class="empty">当前筛选条件下没有分组。</p>';
      return;
    }
    const rowsHtml = list.sort((a, b) => Number(b.eligible === true) - Number(a.eligible === true) || (a.multiplier ?? 1e9) - (b.multiplier ?? 1e9)).map(row => {
      const reasons = Array.isArray(row.reasons) ? row.reasons : [];
      const stateLabel = row.eligible === true ? '可用' : row.passed === false ? '未通过' : '不可用';
      const why = row.eligible === true || !reasons.length ? '' : `<span class="cell-sub">${escapeHtml(reasons.slice(0, 2).join(' · '))}</span>`;
      const stateText = `<span class="pill ${row.eligible === true ? 'pill-ok' : 'pill-off'}">${stateLabel}</span>${why}`;
      return `<tr class="${row.eligible === true ? '' : 'is-off'}">
        <td><span class="cell-name">${escapeHtml(row.name || `分组 ${row.groupId ?? ''}`)}</span><span class="cell-sub">#${escapeHtml(row.groupId ?? '—')} · ${escapeHtml(row.account)}</span></td>
        <td>${escapeHtml(platformLabel[row.platform] ?? row.platform ?? '—')}</td>
        <td class="num">${row.multiplier === null || row.multiplier === undefined ? '—' : `×${decimal(row.multiplier, 3)}`}</td>
        <td class="num">${num(row.latency) === null ? '—' : (num(row.latency) / 1000).toFixed(1) + 's'}</td>
        <td class="num" title="${num(row.metrics?.observedSeconds) === null ? '窗口时长未知' : `窗口 ${Math.round(num(row.metrics.observedSeconds) / 60)} 分钟`}">${num(row.metrics?.samples) === null ? '—' : num(row.metrics.samples).toLocaleString('zh-CN')}</td>
        <td class="num" title="${num(row.metrics?.successRate1h) === null ? '没有 1h 档数据' : `1h 成功率 ${percent(row.metrics.successRate1h)}`}">${percent(row.metrics?.successRate)}</td>
        <td class="num">${percent(row.metrics?.cacheHitRate)}</td>
        <td class="num">${decimal(row.metrics?.tps, 1)}</td>
        <td class="num" title="${num(row.metrics?.reputation) === null ? '大厅未给出评分' : `AIHub 评分 ${decimal(row.metrics.reputation, 2)}`}">${num(row.metrics?.reputation) === null ? '—' : decimal(row.metrics.reputation, 2)}</td>
        <td class="num" title="${num(row.metrics?.realPrice) === null ? '窗口未就绪或没有区间样本' : `$${decimal(row.metrics.realPrice, 4)}/M ≈ ¥${(row.metrics.realPrice * 7.2).toFixed(2)}/M`}">${num(row.metrics?.realPrice) === null ? '—' : `$${decimal(row.metrics.realPrice, 4)}`}</td>
        <td class="num" title="${escapeHtml((Array.isArray(row.cards) && row.cards.length ? row.cards : (Array.isArray(row.models) ? row.models : []).map(model => ({ model }))).slice(0, 20).map(card => `${card.model}${num(card.price) === null ? '' : ` · ¥${decimal(card.price, 4)}`}${num(card.sampleCount) === null ? '' : ` · ${card.sampleCount} 样本`}${card.health === 'failed' ? ' · 检测失败' : ''}`).join('\n'))}">${Array.isArray(row.models) ? row.models.length : 0}</td>
        <td class="num" title="${row.hasKey ? '本连接已为该分组建了 Key' : '本连接尚未为该分组建 Key'}">${row.selectedCount ?? 0}</td>
        <td title="${row.detectedAt ? `检测时间 ${clock(row.detectedAt)}` : '没有检测时间'}">${row.detection === 'passed' ? '<span class="pill pill-ok">通过</span>' : row.detection === 'failed' || row.passed === false ? '<span class="pill pill-off">失败</span>' : '<span class="cell-sub">未测</span>'}</td>
        <td>${stateText}</td>
        <td class="num">${clock(row.lastUsedAt)}</td>
      </tr>`;
    }).join('');
    const routeHtml = routes.length ? routes.slice(-8).reverse().map(route => `
      <li><span class="mono">${clock(route.at)}</span><span>${escapeHtml(platformLabel[route.platform] ?? route.platform ?? '—')} · ${escapeHtml(route.model || '—')}</span><span class="cell-sub">#${escapeHtml(route.groupId ?? '—')}</span><span class="pill ${routeTone(route.outcome)}">${escapeHtml(route.outcome || '—')}</span></li>`).join('') : '';
    $('monitor-body').innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>分组</th><th>平台</th><th class="num">倍率</th><th class="num" title="大厅样本的首字耗时（TTFT）">首字</th><th class="num" title="区间窗口内的样本数">样本</th><th class="num">成功率</th><th class="num">缓存命中</th><th class="num">TPS</th><th class="num" title="AIHub 大厅给出的分组评分">评分</th><th class="num" title="按区间窗口的实际成本与 Token 折算为每百万 Token 美元，括号内为按 7.2 估算的人民币">真实价格 $/M</th><th class="num">模型</th><th class="num" title="当前会话里共享该分组的路由数">使用</th><th>检测</th><th>状态</th><th class="num">最后使用</th></tr></thead>
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
  $('tab-settings').addEventListener('click', () => showView('settings'));
  $('tab-monitor').addEventListener('click', () => showView('monitor'));
  $('monitor-refresh').addEventListener('click', () => loadSnapshot());
  $('monitor-accounts').addEventListener('click', async event => {
    const button = event.target && typeof event.target.closest === 'function' ? event.target.closest('.account-eye') : null;
    if (!button) return;
    const card = button.closest('.account-card');
    const name = card ? card.querySelector('.account-name') : null;
    if (!name) return;
    if (button.dataset.shown === '1') {
      name.textContent = button.dataset.masked || name.textContent;
      button.dataset.shown = '0';
      button.textContent = '👁';
      return;
    }
    try {
      const full = await loadIdentity(Number(button.dataset.account));
      if (!full) return;
      button.dataset.masked = name.textContent;
      name.textContent = full;
      button.dataset.shown = '1';
      button.textContent = '🙈';
    } catch { /* keep the masked label */ }
  });
  $('monitor-filters').addEventListener('click', event => {
    const target = event.target?.closest?.('[data-filter]');
    if (!target) return;
    state.filter = target.getAttribute('data-filter') || 'all';
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
