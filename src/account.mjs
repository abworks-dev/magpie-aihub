import { randomUUID } from 'node:crypto';
import { waitFor } from './async.mjs';
import { api, list, tokenFields, normalizeHall, groupInventory, ApiError } from './api.mjs';
import { BASE, PROVIDER } from './config.mjs';
import { KeyError } from './errors.mjs';

export class Account {
  constructor(data, { save, fetcher = globalThis.fetch, now = Date.now } = {}) {
    if (data?.version !== 1 || !['manual', 'managed'].includes(data.mode) || typeof data.instanceId !== 'string' || !Array.isArray(data.keys))
      throw new Error('Unsupported AIHub sign-in data; sign in again');
    this.data = structuredClone(data);
    this.persist = save ?? (async () => {});
    this.fetcher = fetcher;
    this.now = now;
    this.queue = Promise.resolve();
    this.saveQueue = Promise.resolve();
    this.snapshot = undefined;
    this.remoteStale = false;
    this.models = new Map();
  }
  mutate(fn, signal) {
    const p = this.queue.then(() => { signal?.throwIfAborted(); return fn(); });
    this.queue = p.catch(() => {});
    return waitFor(p, signal);
  }
  async save() {
    this.dirty = true;
    const revision = this.saveRevision = (this.saveRevision ?? 0) + 1;
    const task = this.saveQueue.then(() => this.persist(structuredClone(this.data)));
    this.saveQueue = task.catch(() => {});
    try { await task; if (this.saveRevision === revision) this.dirty = false; }
    catch (e) { this.dirty = true; throw e; }
  }
  async renew(signal) {
    const result = await api('/api/v1/auth/refresh', { body: { refresh_token: this.data.refresh }, fetcher: this.fetcher, signal });
    Object.assign(this.data, tokenFields(result, this.data));
    await this.save();
  }
  async call(path, args = {}) {
    const usedAccess = this.data.access;
    const invoke = () => api(path, { ...args, token: this.data.access, fetcher: this.fetcher });
    try { return await invoke(); }
    catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401 || !this.data.refresh) throw e;
      // Separate refresh lock: call() can execute inside a key mutation transaction.
      if (this.data.access === usedAccess) {
        if (!this.refreshingAuth) this.refreshingAuth = this.renew(args.signal).finally(() => { this.refreshingAuth = undefined; });
        await waitFor(this.refreshingAuth, args.signal);
      }
      // Never replay a write: even an unusual auth rejection is not proof it had no effect.
      if (args.body !== undefined) throw e;
      return invoke();
    }
  }
  async catalogue(o, signal) {
    if (this.snapshot && this.now() - this.snapshot.at < o.refreshMs) return this.snapshot.rows;
    if (!this.refreshing) {
      this.refreshing = this.loadCatalogue(signal).then(rows => {
        this.snapshot = { rows, at: this.now() }; this.remoteStale = false; return rows;
      }).finally(() => { this.refreshing = undefined; });
    }
    try { return await waitFor(this.refreshing, signal); }
    catch (e) {
      signal?.throwIfAborted();
      this.remoteStale = true;
      if (this.snapshot && this.now() - this.snapshot.at <= o.maxStaleMs) return this.snapshot.rows;
      throw e;
    }
  }
  async loadCatalogue(signal) {
    if (this.data.mode === 'manual') return this.directoryRows = this.data.keys.map(k => ({ ...k, platform: k.platform ?? 'openai', available: undefined, rejected: [] }));
    const [groups, rates, publicRows] = await Promise.all([
      this.call('/api/v1/groups/available', { signal }), this.call('/api/v1/groups/rates', { signal }),
      this.call('/api/v2/public/providers', { signal }).catch(e => {
        if (e.status === 404 || e.status === 410) return this.call('/api/v1/public/providers', { signal });
        throw e;
      }),
    ]);
    if (!rates || typeof rates !== 'object' || Array.isArray(rates)) throw new Error('Unsupported AIHub account rates schema');
    const hall = normalizeHall(publicRows);
    const inventory = list(groups).map(g => groupInventory(g, rates, hall)).filter(Boolean);
    this.directoryRows = inventory;
    return inventory.filter(row => row.routeEligible);
  }
  async ownRemoteKeys(signal) {
    const out = [];
    for (let page = 1; page <= 100; page++) {
      const result = await this.call(`/api/v1/keys?page=${page}&page_size=100`, { signal });
      const items = list(result);
      out.push(...items);
      if (items.length < 100 || (Number.isFinite(Number(result.total)) && out.length >= Number(result.total))) return out;
    }
    throw new Error('AIHub key list exceeds supported pagination limit');
  }
  async keyFor(candidate, o, signal) {
    return this.mutate(async () => {
      const existing = this.data.keys.find(k => k.groupId === candidate.groupId);
      if (existing) { if (this.dirty) await this.save(); return existing; }
      if (this.data.mode !== 'managed') throw new KeyError('key_not_imported', '此分组没有导入 Key，请在插件连接中导入对应分组 Key。');
      if (this.data.keys.length >= o.poolSize) throw new KeyError('key_pool_full', '专用 Key 池已满，请增大 poolSize 或使用已有分组。');
      const name = `magpie-aihub-${this.data.instanceId.slice(0, 12)}-g${candidate.groupId}`;
      const pending = this.data.pending;
      if (pending && pending.groupId !== candidate.groupId) throw new KeyError('key_creation_pending', '此前创建 Key 的结果尚未确认，请先在 AIHub 检查对应记录。');
      // Only our exact instance-specific name can be recovered; unrelated keys are never adopted.
      const recover = async () => {
        const rows = await this.ownRemoteKeys(signal);
        const found = rows.filter(k => k.name === name && Number(k.group_id) === candidate.groupId && k.status === 'active');
        if (found.length > 1) throw new KeyError('key_duplicate', '发现重复的专用 Key，请先在 AIHub 处理重复记录。');
        return found[0];
      };
      if (this.data.refresh && this.data.expires && this.data.expires <= this.now() + 30000) await this.renew(signal);
      let remote = await recover();
      if (!remote && pending) throw new KeyError('key_creation_pending', '此前创建 Key 的结果未知，请在 AIHub 检查；插件不会重复创建。');
      if (!remote) {
        if (!o.autoCreateKeys) throw new KeyError('key_creation_disabled', '此分组尚无专用 Key。请开启自动创建分组 Key，或手工导入该分组 Key。');
        this.data.pending = { groupId: candidate.groupId, name, idempotencyKey: randomUUID() };
        await this.save();
        // One create only. Persist pending BEFORE the request, retain it on all uncertain outcomes.
        remote = await api('/api/v1/keys', { token: this.data.access,
          body: { name, group_id: candidate.groupId }, signal, fetcher: this.fetcher,
          headers: { 'Idempotency-Key': this.data.pending.idempotencyKey },
        });
        if (!remote?.key) remote = await recover();
      }
      if (!remote || typeof remote.key !== 'string' || !remote.key || !Number.isSafeInteger(Number(remote.id)) || Number(remote.group_id) !== candidate.groupId || (remote.name && remote.name !== name))
        throw new KeyError('key_creation_incomplete', 'AIHub 未返回完整的专用 Key，请检查待确认的创建记录。');
      const key = { groupId: candidate.groupId, platform: candidate.platform ?? 'openai', key: remote.key, remoteId: Number(remote.id), name, owned: true };
      this.data.keys.push(key);
      delete this.data.pending;
      await this.save();
      return key;
    }, signal);
  }
  async modelIds(key, o, signal) {
    if (key.models) return key.models;
    const cached = this.models.get(key.groupId);
    if (cached && this.now() - cached.at < o.refreshMs) return cached.ids;
    const res = await this.fetcher(`${BASE}/models`, {
      headers: { authorization: `Bearer ${key.key}`, accept: 'application/json' }, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });
    if (!res.ok) { await res.body?.cancel(); throw new ApiError(res.status, '/v1/models'); }
    const body = await res.json();
    if (!Array.isArray(body.data)) throw new Error('Unsupported model list schema');
    const ids = body.data.map(m => m.id).filter(id => typeof id === 'string');
    this.models.set(key.groupId, { ids, at: this.now() });
    return ids;
  }
}

export function accountSaver(client, getCurrentAuth) {
  return async data => {
    if (!client?.auth?.set) throw new Error('Magpie auth persistence is unavailable');
    const current = await getCurrentAuth();
    let instance;
    try { instance = JSON.parse(current?.key).instanceId; } catch { /* disconnected */ }
    if (instance !== data.instanceId) throw new Error('AIHub account changed or disconnected; refusing stale credential save');
    await client.auth.set({ path: { id: PROVIDER }, body: { type: 'api', key: JSON.stringify(data), metadata: { email: data.identity } } });
  };
}
