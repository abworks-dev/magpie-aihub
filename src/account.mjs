import { randomUUID } from 'node:crypto';
import { waitFor } from './async.mjs';
import { api, list, tokenFields, normalizeHall, groupInventory, ApiError } from './api.mjs';
import { loadBilling } from './billing.mjs';
import { BASE, PROVIDER } from './config.mjs';
import { KeyError, SessionExpired } from './errors.mjs';

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
    this.billing = undefined;
    this.billingError = undefined;
    this.audit = [];
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
  // A rejected refresh is a dead session, not a permission problem: map it once,
  // in front of every caller, so routing and the monitor can say "sign in again".
  async renewSession(signal) {
    try { return await this.renew(signal); }
    catch (error) { throw error?.status === 401 ? new SessionExpired() : error; }
  }
  async call(path, args = {}) {
    const usedAccess = this.data.access;
    const invoke = () => api(path, { ...args, token: this.data.access, fetcher: this.fetcher });
    try { return await invoke(); }
    catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401 || !this.data.refresh) throw e;
      // Separate refresh lock: call() can execute inside a key mutation transaction.
      if (this.data.access === usedAccess) {
        if (!this.refreshingAuth) this.refreshingAuth = this.renewSession(args.signal).finally(() => { this.refreshingAuth = undefined; });
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
    const probe = list(publicRows).find(row => row?.range_cache?.ready === true);
    if (probe && !this.rangeFieldsLogged) {
      this.rangeFieldsLogged = true;
      // Field names only: tells us where AIHub keeps the real price without
      // logging any value from the account directory.
      console.error('[aihub-auto] range_cache fields: ' + Object.keys(probe.range_cache ?? {}).join(','));
    }
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
  /**
   * AIHub stays the source of truth for the key count: a key deleted from the
   * console must not keep occupying a slot in the local pool. Pass rows when the
   * caller already listed them.
   */
  async reconcileKeys(rows, signal) {
    if (this.data.mode !== 'managed' || this.data.keys.length === 0) return 0;
    const remote = rows ?? await this.ownRemoteKeys(signal);
    const alive = new Set(remote.filter(row => row && row.status === 'active' && row.id !== undefined).map(row => String(row.id)));
    const kept = this.data.keys.filter(entry => entry.remoteId === undefined || alive.has(String(entry.remoteId)));
    const removed = this.data.keys.length - kept.length;
    if (removed === 0) return 0;
    this.data.keys = kept;
    await this.save();
    this.note('reconciled', 0, `removed_${removed}`);
    return removed;
  }
  /** Delete one key this plugin created; the caller decides which ones qualify. */
  /**
   * Policy-driven cleanup: give the least recently used keys back only when the
   * account is out of slots and a model needs a group none of them serves.
   * Keys of groups still in `keep` are untouched, keys without a usable age are
   * left alone, and the caller decides whether this is a dry run.
   */
  async evictIdle({ keep = new Set(), days = 7, apply = false } = {}, signal) {
    const empty = { apply, candidates: [], deleted: [], failed: [] };
    if (this.data.mode !== 'managed') return empty;
    const rows = await this.ownRemoteKeys(signal);
    const prefix = `magpie-aihub-${this.data.instanceId.slice(0, 12)}-`;
    const cutoff = this.now() - days * 24 * 60 * 60 * 1000;
    const candidates = [];
    for (const row of rows) {
      const name = String(row?.name ?? '');
      if (!name.startsWith(prefix)) continue;
      const groupId = Number(row?.group_id ?? /-g(\d+)$/.exec(name)?.[1]);
      if (!Number.isSafeInteger(groupId) || keep.has(groupId)) continue;
      const created = Date.parse(row?.created_at ?? row?.createdAt ?? '');
      const used = Date.parse(row?.last_used_at ?? row?.lastUsedAt ?? '');
      const at = Math.max(Number.isFinite(used) ? used : 0, Number.isFinite(created) ? created : 0);
      if (!at || at > cutoff) continue;
      candidates.push({ id: Number(row.id), groupId, name, at });
    }
    if (!apply) return { ...empty, candidates };
    const deleted = [], failed = [];
    for (const candidate of candidates) {
      try {
        await this.deleteRemoteKey(candidate.id, signal);
        deleted.push(candidate);
        this.data.keys = this.data.keys.filter(key => key.remoteId !== candidate.id);
        this.note('evicted', candidate.groupId, 'evicted');
      } catch (error) { failed.push({ ...candidate, message: String(error?.message ?? error) }); }
    }
    if (deleted.length) await this.save();
    return { apply, candidates, deleted, failed };
  }
  async deleteRemoteKey(id, signal) {
    return api(`/api/v1/keys/${encodeURIComponent(String(id))}`, { method: 'DELETE', token: this.data.access, fetcher: this.fetcher, signal });
  }
  async billingInfo(o, signal) {
    if (this.data.mode !== 'managed') return undefined;
    if (this.billing && this.now() - this.billing.at < o.balanceRefreshMs) return this.billing;
    if (!this.billingRefresh) {
      this.billingRefresh = loadBilling(this, signal)
        .then(info => { this.billing = info; this.billingError = undefined; return info; })
        .catch(error => {
          this.billingError = error instanceof SessionExpired ? 'billing_session_expired'
            : error?.status === 401 ? 'billing_sign_in_required'
            : error?.status === 403 ? 'billing_access_denied' : 'billing_unavailable';
          if (this.billing && this.now() - this.billing.at <= o.maxStaleMs) return this.billing;
          return undefined;
        })
        .finally(() => { this.billingRefresh = undefined; });
    }
    return waitFor(this.billingRefresh, signal);
  }
  note(action, groupId, code) {
    this.audit.push({ at: this.now(), action, groupId, code });
    if (this.audit.length > 50) this.audit.splice(0, this.audit.length - 50);
  }
  async keyFor(candidate, o, signal) {
    return this.mutate(async () => {
      const existing = this.data.keys.find(k => k.groupId === candidate.groupId);
      if (existing) { if (this.dirty) await this.save(); return existing; }
      if (this.data.mode !== 'managed') throw new KeyError('key_not_imported', '此分组没有导入 Key，请在插件连接中导入对应分组 Key。');
      // One cap only: the per-account key limit. The candidate pool size is a
      // routing knob, not a key budget, so it must not stop a model the account
      // is still willing to key.
      if (this.data.keys.length >= o.maxKeysPerAccount) {
        // Keys deleted in the AIHub console must stop counting before we refuse.
        const dropped = await this.reconcileKeys(undefined, signal).catch(() => 0);
        if (this.data.keys.length >= o.maxKeysPerAccount) {
          this.note('blocked', candidate.groupId, 'key_cap_reached');
          throw new KeyError('key_cap_reached', `专用 Key 数量已达上限 ${o.maxKeysPerAccount}（已在 AIHub 核对，其中 ${this.data.keys.length} 把仍有效${dropped ? `，清理了 ${dropped} 条失效记录` : ''}），请增大「每账户 Key 上限」或复用已有分组。`);
        }
      }
      if (o.minBalance > 0) {
        const billing = await this.billingInfo(o, signal);
        if (typeof billing?.balance === 'number' && billing.balance < o.minBalance) {
          this.note('blocked', candidate.groupId, 'balance_too_low');
          throw new KeyError('balance_too_low', `账户余额低于设定阈值 ${o.minBalance}，已停止创建新 Key。`);
        }
      }
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
      if (this.data.refresh && this.data.expires && this.data.expires <= this.now() + 30000) await this.renewSession(signal);
      let remote = await recover();
      if (remote) this.note('recovered', candidate.groupId, 'recovered');
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
      this.note('created', candidate.groupId, 'created');
      const key = { groupId: candidate.groupId, platform: candidate.platform ?? 'openai', key: remote.key, remoteId: Number(remote.id), name, owned: true };
      this.data.keys.push(key);
      delete this.data.pending;
      await this.save();
      return key;
    }, signal);
  }
  /** Forget a group's cached model list: a group can stop serving a model. */
  forgetModels(groupId) {
    this.models.delete(groupId);
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
