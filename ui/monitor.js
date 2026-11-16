(() => {
  'use strict';
  const platforms = [['openai', 'OpenAI'], ['deepseek', 'DeepSeek'], ['zhipu', 'Zhipu GLM'], ['kimi', 'Kimi'], ['grok', 'Grok'], ['gemini', 'Gemini']];
  const $ = id => document.getElementById(id);
  const token = document.querySelector('meta[name="aihub-monitor-token"]')?.content;
  const reasonLabels = {
    excluded: '已排除', excluded_group: '已排除', not_allowed: '不在允许范围', not_in_allowlist: '不在允许范围',
    multiplier: '倍率超限', multiplier_limit: '倍率超限', over_multiplier: '倍率超限',
    unavailable: '目录不可用', not_passed: '检测未通过', detection_failed: '检测失败',
    cooldown: '故障冷却', no_key: '无可用密钥', missing_key: '无可用密钥', key_pending: '密钥待就绪',
    stale: '目录已过期', model_mismatch: '模型不匹配', model_not_supported: '模型不匹配',
    platform_mismatch: '平台不匹配', not_selected: '未选入候选池', pool_limit: '候选池限制',
  };
  let snapshot = null;
  let active = 'openai';
  let timer = null;
  let busy = false;
  let failed = false;
  const text = value => value === null || value === undefined || value === '' ? '—' : String(value);
  const numeric = (value, suffix = '') => typeof value === 'number' && Number.isFinite(value) ? `${value.toLocaleString('zh-CN', { maximumFractionDigits: 4 })}${suffix}` : '—';
  const rate = value => typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%` : '—';
  const date = value => {
    if (value === null || value === undefined) return '—';
    const at = new Date(value);
    return Number.isFinite(at.getTime()) ? at.toLocaleString('zh-CN', { hour12: false }) : '—';
  };
  const element = (tag, value, className) => {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = text(value);
    if (className) node.className = className;
    return node;
  };
  const option = (value, label) => {
    const node = element('option', label);
    node.value = value;
    return node;
  };
  function choices(select, items, allLabel) {
    const previous = select.value;
    select.replaceChildren(option('all', allLabel), ...items.map(([value, label]) => option(value, label)));
    if (items.some(([value]) => value === previous)) select.value = previous;
  }
  function scope() {
    return (snapshot?.accounts ?? []).map((account, index) => ({ ...account, index, label: `账户${index + 1}` }))
      .filter(account => $('account').value === 'all' || String(account.index) === $('account').value);
  }
  function render() {
    if (!snapshot) return;
    const accounts = scope();
    const platformRows = accounts.flatMap(account => account.groups.filter(group => group.platform === active).map(group => ({ account, group })));
    const modelIds = [...new Set(platformRows.flatMap(({ group }) => group.models))].sort();
    choices($('model'), modelIds.map(model => [model, model]), '全部模型');
    const query = $('search').value.trim().toLocaleLowerCase();
    const rows = platformRows.filter(({ group }) => ($('model').value === 'all' || group.models.includes($('model').value))
      && `${group.name} ${group.groupId} ${group.models.join(' ')}`.toLocaleLowerCase().includes(query));
    $('count-groups').textContent = rows.length;
    $('count-eligible').textContent = rows.filter(({ group }) => group.eligible === true).length;
    const selections = rows.map(({ group }) => group.selectedCount).filter(value => typeof value === 'number');
    $('count-selected').textContent = selections.length ? `${numeric(selections.reduce((total, value) => total + value, 0))}${selections.length < rows.length ? '+' : ''}` : '—';
    const multipliers = rows.map(({ group }) => group.multiplier).filter(value => typeof value === 'number');
    $('min-rate').textContent = multipliers.length ? numeric(Math.min(...multipliers), '×') : '—';
    const body = $('groups');
    body.replaceChildren();
    for (const { account, group } of rows) {
      const row = element('tr');
      const title = element('td');
      title.append(element('strong', group.name || `组 ${text(group.groupId)}`), element('small', `${account.label} · #${text(group.groupId)}`));
      const models = element('td', group.models.length ? group.models.join(' · ') : '未提供模型目录', 'model-cell');
      const health = element('td');
      health.append(element('span', group.available === false ? '不可用' : group.passed === true ? '通过' : group.passed === false ? '未通过' : '未知', `pill ${group.available === false || group.passed === false ? 'warn' : group.passed === true ? 'good' : ''}`));
      const state = element('td');
      const cooling = group.cooldownUntil !== null && new Date(group.cooldownUntil).getTime() > Date.now();
      state.append(element('span', cooling ? '冷却' : group.eligible === true ? '可选' : group.eligible === false ? '不可选' : '资格未知', `pill ${cooling ? 'warn' : group.eligible ? 'good' : ''}`));
      state.append(element('small', `已选 ${numeric(group.selectedCount)} · ${group.hasKey === true ? '密钥就绪' : group.hasKey === false ? '无密钥' : '密钥状态未知'}`));
      if (group.reasons.length) state.append(element('small', group.reasons.map(reason => reasonLabels[reason] || reason).join(' · '), 'reasons'));
      if (cooling) state.append(element('small', `冷却至 ${date(group.cooldownUntil)}`));
      state.append(element('small', `最近使用 ${date(group.lastUsedAt)}`));
      row.append(title, models, element('td', numeric(group.multiplier, '×')), health,
        element('td', numeric(group.latency, ' ms')), element('td', rate(group.metrics.successRate)),
        element('td', rate(group.metrics.cacheHitRate)), element('td', numeric(group.metrics.tps)),
        element('td', numeric(group.metrics.realPrice)), state);
      body.append(row);
    }
    $('empty').hidden = rows.length > 0;
    $('empty').textContent = !snapshot.accounts.length ? '尚未加载账户。请先刷新或加载 AIHub 供应商，再刷新此监控页。'
      : !platformRows.length ? '当前账户范围还没有此平台的组目录。请先刷新或加载供应商；监控只读取已存在的数据。'
        : '没有匹配筛选条件的组。';
    $('accounts').replaceChildren(...accounts.map(account => {
      const card = element('article');
      card.append(element('h3', `${account.label} · ${text(account.mode)}`),
        element('p', `目录更新时间：${date(account.sourceUpdatedAt)}`),
        element('p', account.stale === true ? '目录状态：已过期' : account.stale === false ? '目录状态：当前' : '目录状态：未知', account.stale ? 'reasons' : ''),
        element('p', `密钥就绪 ${numeric(account.keyState.ready)} · 待处理 ${numeric(account.keyState.pending)}`),
        element('p', `自动创建密钥：${account.keyState.autoCreateKeys === true ? '已开启（由路由器管理）' : account.keyState.autoCreateKeys === false ? '关闭' : '未知'}`));
      if (account.errorCode) card.append(element('p', `安全错误代码：${account.errorCode}`, 'reasons'));
      return card;
    }));
    const routes = accounts.flatMap(account => account.routes.filter(route => route.platform === active)
      .filter(route => $('model').value === 'all' || route.model === $('model').value)
      .filter(route => `${route.model} ${route.groupId}`.toLocaleLowerCase().includes(query))
      .map(route => ({ ...route, label: account.label })))
      .sort((a, b) => (new Date(b.at).getTime() || 0) - (new Date(a.at).getTime() || 0)).slice(0, 50);
    $('routes').replaceChildren(...(routes.length ? routes.map(route => element('p', `${date(route.at)} · ${route.label} · ${text(route.model)} → #${text(route.groupId)} · ${text(route.outcome)}`)) : [element('p', '暂无匹配的真实路由记录。目录存在不代表已执行推理。', 'muted')]));
    if (!failed) $('status').textContent = `快照生成时间：${date(snapshot.generatedAt)} · ${snapshot.accounts.length} 个匿名账户${document.hidden ? ' · 页面不可见，自动刷新已暂停' : ''}`;
  }
  function schedule() {
    clearTimeout(timer);
    timer = null;
    if ($('auto').checked && !document.hidden) timer = setTimeout(async () => { await refresh(); schedule(); }, 30_000);
  }
  async function refresh() {
    if (busy) return;
    busy = true;
    $('refresh').disabled = true;
    $('status').textContent = '正在读取本地快照…';
    try {
      if (!token || token === '__AIHUB_MONITOR_TOKEN__') throw new Error('VIEW_TOKEN_MISSING');
      const response = await fetch(new URL('./snapshot', window.location.href), {
        method: 'GET', headers: { 'X-AIHub-Monitor': token }, credentials: 'omit', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const known = { 403: '访问被拒绝（403）。请从 Magpie 插件的监控入口重新打开页面，以更新视图令牌。', 404: '监控接口未找到（404）。请检查服务入口和插件版本。', 503: '本地快照读取失败（503）。供应商尚未加载或其快照当前不可用。' };
        throw new Error(known[response.status] || `本地服务返回 HTTP ${response.status}。`);
      }
      const data = await response.json();
      if (data?.schemaVersion !== 1 || !Array.isArray(data.accounts)) throw new Error('快照格式不受支持。请更新插件后重试。');
      snapshot = data;
      failed = false;
      $('failure').hidden = true;
      choices($('account'), data.accounts.map((_, index) => [String(index), `账户${index + 1}`]), '全部账户');
      render();
    } catch (error) {
      failed = true;
      $('failure').hidden = false;
      const message = error?.message;
      $('failure-message').textContent = message === 'VIEW_TOKEN_MISSING' ? '缺少服务端视图令牌。请从 Magpie 的监控入口打开服务页。'
        : error?.name === 'TimeoutError' ? '读取本地快照超过 10 秒。服务可能正在退出或快照回调未响应。'
          : message?.startsWith('本地') || message?.startsWith('访问') || message?.startsWith('监控') || message?.startsWith('快照') ? message
            : '无法连接本地监控服务。请检查插件运行状态与服务代理连接，然后重试。';
      $('status').textContent = snapshot ? `刷新失败 · 正在显示上次成功快照（${date(snapshot.generatedAt)}）` : '尚无可显示的快照';
    } finally {
      busy = false;
      $('refresh').disabled = false;
    }
  }
  platforms.forEach(([id, label]) => {
    const tab = element('button', label);
    tab.type = 'button';
    tab.setAttribute('aria-pressed', String(id === active));
    tab.addEventListener('click', () => {
      active = id;
      for (const button of $('platforms').children) button.setAttribute('aria-pressed', String(button === tab));
      $('model').value = 'all';
      render();
    });
    $('platforms').append(tab);
  });
  $('refresh').addEventListener('click', async () => { await refresh(); schedule(); });
  $('auto').addEventListener('change', schedule);
  $('account').addEventListener('change', () => { $('model').value = 'all'; render(); });
  $('model').addEventListener('change', render);
  $('search').addEventListener('input', render);
  document.addEventListener('visibilitychange', () => { schedule(); render(); });
  refresh();
})();
