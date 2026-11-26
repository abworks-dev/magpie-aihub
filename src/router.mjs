import { createHash } from 'node:crypto';
import { ORIGIN } from './config.mjs';
import { EndpointPool } from './endpoints.mjs';
import { validPlatform, publicModelId, modelDescriptor, bareModelId, splitModelId } from './platforms.mjs';
import { keyFailure } from './errors.mjs';
import { proxyFor } from './proxy.mjs';
import { geminiPath, geminiStream, fromGeminiResponse, toGeminiRequest } from './gemini.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const errorResponse = (message, status = 503, code = 'routing_failed') => Response.json({ error: { type: 'aihub_routing_error', code, message } }, { status });

async function boundedBody(request, limit, signal) {
  if (!request.body) throw new Error('A JSON request body is required');
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Request body exceeds retry buffer limit');
      chunks.push(value);
    }
  } catch (e) { await reader.cancel().catch(() => {}); throw e; }
  finally { signal.removeEventListener('abort', onAbort); reader.releaseLock(); }
  return Buffer.concat(chunks);
}

function sessionKey(headers, body, path) {
  const value = headers.get('x-aihub-auto-session') || body.conversation?.id || (typeof body.conversation === 'string' ? body.conversation : '') || body.prompt_cache_key;
  return value ? digest(`${path}\0${body.model}\0${value}`) : undefined;
}

function retryDelay(value, now, fallback) {
  if (!value) return fallback;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(fallback, delay) : fallback;
}

export class Router {
  constructor(account, options, { fetcher = globalThis.fetch, now = Date.now, rng = Math.random } = {}) {
    this.account = account; this.o = options; this.fetcher = fetcher; this.now = now; this.rng = rng;
    // The entry host is chosen before the group: a dead edge must not blind the
    // router, which is why endpoint health is tracked apart from group health.
    this.endpoints = new EndpointPool(options.endpoints, { mode: options.endpointMode, cooldownMs: options.endpointCooldownMs, now });
    this.inflight = new Map();
    this.sessions = account.keyState?.sessions ?? new Map(); this.cooldown = new Map(); this.latency = new Map(); this.rejected = new Map();
    this.account.isStickyKeyGroup = groupId => {
      const at = this.now();
      for (const session of this.sessions.values()) {
        if (session.groupId === groupId && session.until > at) return true;
      }
      return false;
    };
    // What the eviction policy actually gave back, newest first; the page shows it.
    this.evictions = [];
    this.locks = new Map(); this.lastRoutes = [];
    this.health = new Map(); this.spend = { day: '', usd: 0, tokens: 0 };
    this.priceSeen = new Map(); this.priceChanges = []; this.counters = { requests: 0, failures: 0 };
  }
  // Circuit state is a sliding window rather than "one failure, one cooldown":
  // a single blip must not evict a group that has been healthy for hours.
  window(groupId, now = this.now()) {
    const entry = this.health.get(groupId) ?? { wins: [], fails: [] };
    entry.wins = entry.wins.filter(at => at > now - this.o.breakerWindowMs);
    entry.fails = entry.fails.filter(at => at > now - this.o.breakerWindowMs);
    this.health.set(groupId, entry);
    return entry;
  }
  penalize(groupId, forceMs) {
    const now = this.now();
    const entry = this.window(groupId, now);
    entry.fails.push(now);
    this.counters.failures++;
    if (forceMs) { this.cooldown.set(groupId, now + forceMs); return; }
    const total = entry.fails.length + entry.wins.length;
    const rate = entry.fails.length / Math.max(1, total);
    if (entry.fails.length >= this.o.breakerMinSamples && rate > this.o.breakerFailureRate)
      this.cooldown.set(groupId, now + this.o.cooldownMs);
  }
  praise(groupId) {
    this.window(groupId).wins.push(this.now());
    this.cooldown.delete(groupId);
  }
  budgetDay(now = this.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.spend.day !== day) this.spend = { day, usd: 0, tokens: 0 };
    return day;
  }
  withinBudget(now = this.now()) {
    this.budgetDay(now);
    return !(this.o.dailyBudget > 0) || this.spend.usd < this.o.dailyBudget;
  }
  // Local, immediate estimate: the vendor bills per token, so a routed request
  // costs tokens × the window's real price. Used for the day budget and the page.
  charge(candidate, tokens) {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    this.budgetDay();
    const price = Number.isFinite(candidate.metrics?.realPrice) && candidate.metrics.realPrice >= 0 ? candidate.metrics.realPrice : 0;
    this.spend.tokens += tokens;
    this.spend.usd += (tokens / 1e6) * price;
  }
  trackPrices(rows) {
    for (const row of rows) {
      const price = row.metrics?.realPrice;
      if (!Number.isFinite(price) || price < 0) continue;
      const previous = this.priceSeen.get(row.groupId);
      if (previous > 0 && Math.abs(price - previous) / previous >= this.o.priceAlertRatio)
        this.priceChanges.push({ groupId: row.groupId, name: row.name ?? '', from: previous, to: price, at: this.now() });
      this.priceSeen.set(row.groupId, price);
    }
    if (this.priceChanges.length > 20) this.priceChanges = this.priceChanges.slice(-20);
  }
  recordRoute(candidate, model, outcome) {
    this.lastRoutes.push({ groupId: candidate.groupId, platform: candidate.platform ?? 'openai', at: this.now(), outcome, model });
    if (this.lastRoutes.length > 100) this.lastRoutes.splice(0, this.lastRoutes.length - 100);
  }
  eligibleGroup(c) {
    const o = this.o;
    return o.platforms.includes(c.platform ?? 'openai') && !o.excludedGroups.includes(c.groupId) && (!o.allowedGroups.length || o.allowedGroups.includes(c.groupId)) &&
      c.multiplier <= this.capFor(c.platform ?? 'openai') && c.available !== false && !c.blocked &&
      (!o.requirePassed || c.passed === true) && (this.cooldown.get(c.groupId) ?? 0) <= this.now() &&
      !(this.o.maxInflightPerGroup > 0 && (this.inflight.get(c.groupId) ?? 0) >= this.o.maxInflightPerGroup);
  }
  // A slot is held only until the first byte: that is the wait a sibling request
  // would queue behind, and it keeps long streams from starving a group forever.
  acquireSlot(groupId) {
    if (!(this.o.maxInflightPerGroup > 0)) return () => {};
    this.inflight.set(groupId, (this.inflight.get(groupId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.inflight.get(groupId) ?? 1) - 1;
      if (left > 0) this.inflight.set(groupId, left); else this.inflight.delete(groupId);
    };
  }
  // A platform cap overrides the global one, because the same nominal multiplier
  // means very different money depending on the vendor's base price.
  capFor(platform) {
    const cap = this.o.platformCaps?.[platform];
    return typeof cap === 'number' ? cap : this.o.maxMultiplier;
  }
  priceKnown(c) {
    return Number.isFinite(c.metrics?.realPrice) && c.metrics.realPrice >= 0;
  }
  // The same filters as eligibleGroup/eligible, one reason at a time: a failed
  // route should say what removed every group instead of returning a bare 503.
  // Models a group actually serves: an account-side restriction wins, otherwise
  // the hall's model cards describe it. An empty restriction means "nothing".
  listedModels(c) {
    if (Array.isArray(c.models)) return c.models;
    return Array.isArray(c.advertisedModels) && c.advertisedModels.length ? c.advertisedModels : undefined;
  }
  whyNot(c, model, platform, { requirePrice = false } = {}) {
    const o = this.o;
    const rowPlatform = c.platform ?? 'openai';
    if (rowPlatform !== platform) return 'platform mismatch';
    if (!o.platforms.includes(rowPlatform)) return 'platform disabled';
    if (o.excludedGroups.includes(c.groupId)) return 'excluded group';
    if (o.allowedGroups.length && !o.allowedGroups.includes(c.groupId)) return 'outside the allowed list';
    if (c.multiplier > this.capFor(rowPlatform)) return 'over the multiplier cap';
    if (c.available === false || c.blocked) return 'unavailable in the hall';
    if (o.requirePassed && c.passed !== true) return 'model check not passed';
    if ((this.cooldown.get(c.groupId) ?? 0) > this.now()) return 'cooling down';
    if (requirePrice && !this.priceKnown(c)) return 'no real price yet';
    const listed = this.listedModels(c);
    if (listed && !listed.some(id => bareModelId(id) === model)) return 'model not listed';
    if ((c.rejected ?? []).includes(model) || this.rejected.has(`${c.groupId}:${model}`)) return 'model rejected';
    return '';
  }
  /** Which platforms were looked at, and how many groups there publish this model. */
  describeCatalogue(catalogue, model) {
    const byPlatform = new Map();
    let cards = 0;
    for (const c of catalogue) {
      const platformId = c.platform ?? 'openai';
      const bucket = byPlatform.get(platformId) ?? { groups: 0, listed: 0, eligible: 0, cheapest: null, reasons: new Map() };
      bucket.groups += 1;
      const listed = this.listedModels(c);
      if (listed && listed.length) cards += 1;
      if (listed?.some(id => bareModelId(id) === model)) {
        bucket.listed += 1;
        if (bucket.cheapest === null || c.multiplier < bucket.cheapest) bucket.cheapest = c.multiplier;
        if (this.eligibleGroup(c)) bucket.eligible += 1;
        const why = this.whyNot(c, model, platformId);
        if (why) bucket.reasons.set(why, (bucket.reasons.get(why) ?? 0) + 1);
      }
      byPlatform.set(platformId, bucket);
    }
    const parts = [...byPlatform].map(([platformId, bucket]) => {
      const cheapest = bucket.cheapest === null ? '' : `, cheapest ×${Number(bucket.cheapest).toFixed(3)}`;
      const why = bucket.eligible === 0 && bucket.reasons.size
        ? ', ' + [...bucket.reasons].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([reason, n]) => `${reason} ×${n}`).join(', ')
        : '';
      return `${platformId} (cap ×${Number(this.capFor(platformId)).toFixed(3)}) ${bucket.listed}/${bucket.groups} listed, ${bucket.eligible} eligible${cheapest}${why}`;
    }).join('; ');
    return `enabled ${this.o.platforms.join('/')}; ${parts}; ${cards} groups publish model cards`;
  }
  routeFailure(rows, model, platform, catalogue = rows) {
    const tally = new Map();
    let cheapest = null;
    for (const c of rows) {
      const why = this.whyNot(c, model, platform);
      if (!why) continue;
      tally.set(why, (tally.get(why) ?? 0) + 1);
      if (why === 'over the multiplier cap' && (cheapest === null || c.multiplier < cheapest)) cheapest = c.multiplier;
    }
    const cap = this.capFor(platform);
    const top = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([why, n]) => why === 'over the multiplier cap' && cheapest !== null
        ? `${why} ×${n} (cheapest rejected ×${Number(cheapest).toFixed(3)})`
        : `${why} ×${n}`).join(', ');
    const unmatched = rows.filter(c => this.listedModels(c)?.some(id => bareModelId(id) === model) ?? false).length;
    return `No eligible AIHub route remains within the configured multiplier and attempt limits (platform ${platform}, cap ×${Number(cap).toFixed(3)}, ${rows.length} groups, ${unmatched} list this model: ${top || 'all filtered by platform'}) [${this.describeCatalogue(catalogue, model)}]`;
  }
  eligible(c, model, platform = c.platform ?? 'openai', { requirePrice = this.o.strategy === 'price', strict = false } = {}) {
    const listed = this.listedModels(c);
    return (c.platform ?? 'openai') === platform && this.eligibleGroup(c) && (!requirePrice || this.priceKnown(c)) &&
      (!listed ? strict !== true : listed.some(id => bareModelId(id) === model)) &&
      !(c.rejected ?? []).includes(model) && !this.rejected.has(`${c.groupId}:${model}`);
  }
  score(c) {
    const ms = this.latency.get(c.groupId) ?? c.latency ?? 30000;
    if (this.o.strategy === 'speed') return ms;
    if (this.o.strategy === 'economy') return c.multiplier;
    if (this.o.strategy === 'price') return this.priceKnown(c) ? c.metrics.realPrice : Infinity;
    if (this.o.strategy === 'value') return this.valueScore(c, ms);
    if (this.o.strategy === 'reliable') return this.reliableScore(c);
    return c.multiplier * (1 + Math.min(ms, 60000) / 10000);
  }
  // 性价比：真实价格（缺价时退回名义倍率）× 延迟惩罚 × 失败惩罚。
  valueScore(c, ms = this.latency.get(c.groupId) ?? c.latency ?? 30000) {
    const price = this.priceKnown(c) ? c.metrics.realPrice : c.multiplier;
    const success = Number.isFinite(c.metrics?.successRate) ? Math.min(1, Math.max(0, c.metrics.successRate)) : 1;
    return price * (1 + Math.min(ms, 60000) / 10000) * (1 + 3 * (1 - success));
  }
  // 稳定优先：失败率每差 1% 相当于 1e4 的代价，价格只用来打破同分。
  reliableScore(c) {
    const success = Number.isFinite(c.metrics?.successRate) ? Math.min(1, Math.max(0, c.metrics.successRate)) : 1;
    const price = this.priceKnown(c) ? c.metrics.realPrice : c.multiplier;
    return (1 - success) * 1e6 + price;
  }
  prune() {
    const now = this.now();
    for (const [k, v] of this.sessions) if (v.until <= now) this.sessions.delete(k);
    while (this.sessions.size > this.o.maxSessions) this.sessions.delete(this.sessions.keys().next().value);
    for (const [k, t] of this.cooldown) if (t <= now) this.cooldown.delete(k);
    for (const [k, t] of this.rejected) if (t <= now) this.rejected.delete(k);
  }
  async lock(key, signal) {
    if (!key) return () => {};
    const prior = this.locks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    this.locks.set(key, current);
    const unlock = () => { release(); if (this.locks.get(key) === current) this.locks.delete(key); };
    let onAbort;
    try {
      if (signal) {
        signal.throwIfAborted();
        await Promise.race([prior, new Promise((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); })]);
      } else await prior;
    } catch (e) { prior.finally(unlock); throw e; }
    finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
    return unlock;
  }
  async fetch(input, init) {
    // Reuse an existing Request when there are no overrides. Bun may retain a
    // branch when wrapping a streaming Request, preventing source cancellation.
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    const url = new URL(request.url);
    const native = /^\/v1beta\/models\/([A-Za-z0-9_.@+-]{1,160}):(generateContent|streamGenerateContent)$/.exec(url.pathname);
    const validQuery = native?.[2] === 'streamGenerateContent' ? url.search === '?alt=sse' || !url.search : !url.search;
    if (!this.endpoints.has(url.origin) || !validQuery || (!native && !['/v1/responses', '/v1/chat/completions', '/v1/models'].includes(url.pathname)))
      return errorResponse('Only supported AIHub inference and model-discovery endpoints are allowed', 400);
    if (url.pathname === '/v1/models') {
      if (request.method !== 'GET') return errorResponse('Method not allowed', 405);
      try {
        const bare = this.o.bareModelIds;
        return Response.json({ object: 'list', data: (await this.discover(request.signal)).map(id => ({ id: bare ? bareModelId(id) : id, object: 'model', owned_by: 'aihub' })) });
      }
      catch (error) {
        // Magpie only sees "zero models": keep the reason where the operator reads logs.
        console.error(`[aihub-auto] model discovery failed: ${error?.message ?? error}`);
        return errorResponse('Cannot discover models; configure explicit model IDs or check group credentials');
      }
    }
    if (request.method !== 'POST') return errorResponse('Method not allowed', 405);
    const budget = new AbortController();
    const budgetTimer = setTimeout(() => budget.abort(new Error('Routing deadline')), this.o.totalTimeoutMs);
    budgetTimer.unref?.();
    const signal = AbortSignal.any([request.signal, budget.signal]);
    let bytes, body;
    try { bytes = await boundedBody(request, this.o.maxBodyBytes, signal); body = JSON.parse(bytes.toString('utf8')); }
    catch {
      clearTimeout(budgetTimer);
      if (request.signal.aborted) throw request.signal.reason;
      return errorResponse(signal.aborted ? 'AIHub routing deadline exceeded' : 'Expected a JSON request within the configured body limit', signal.aborted ? 503 : 400);
    }
    let platform, model, bareModel = false, supplied = '', hint = '';
    try {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
      hint = request.headers.get('x-aihub-auto-platform') ?? '';
      supplied = native ? native[1] : body.model;
      if (typeof supplied !== 'string' || !supplied) throw new Error();
      const descriptor = modelDescriptor({ id: supplied, ...(hint ? { platform: hint } : native ? { platform: 'gemini' } : {}), api: native ? 'gemini' : url.pathname === '/v1/chat/completions' ? 'chat' : 'responses' });
      platform = descriptor.platform; model = descriptor.modelId;
      bareModel = !native && splitModelId(supplied)[0] === undefined && (!hint || this.o.bareModelIds);
      if (!validPlatform(platform) || !this.o.platforms.includes(platform) || (native && body.model !== undefined && body.model !== model)) throw new Error();
      if (!native) { body.model = model; bytes = Buffer.from(JSON.stringify(body)); }
    } catch { clearTimeout(budgetTimer); return errorResponse('Invalid or disabled platform/model/protocol combination', 400, 'invalid_platform_model'); }
    // Stateful server-side continuation cannot safely be replayed across provider accounts.
    // Require clients to send full history; never guess which upstream owns a response ID.
    if (body.previous_response_id || body.conversation) { clearTimeout(budgetTimer); return errorResponse('Send full conversation history; server-side previous_response_id/conversation routing is not supported', 400); }
    const session = sessionKey(request.headers, { ...body, model: publicModelId(platform, model) }, url.pathname);
    let unlock = () => {};
    let releaseKey = () => {};
    try {
      unlock = await this.lock(session, signal);
      signal.throwIfAborted();
      this.prune();
      const catalogue = await this.account.catalogue(this.o, signal);
      this.counters.requests++;
      this.trackPrices(catalogue);
      if (!this.withinBudget()) return errorResponse('Daily budget reached; raise it in the plugin settings to keep routing today', 429, 'daily_budget_exceeded');
      // Magpie forwards the model without its namespace, so a bare id must follow
      // the platform that explicitly publishes it. Only when nothing publishes it
      // do we fall back to the parsed platform and the historical permissive match.
      // The per-model header Magpie forwards names the platform that model was
      // published under. Treat it as a preference, not proof: a stale header must
      // not shadow the platform that actually lists the model today.
      // With bare ids the per-model header is one we synthesized ourselves, so it
      // says nothing about the platform: treating it as a preference would send
      // every bare name to openai first.
      const trusted = this.o.bareModelIds ? '' : hint;
      const inferable = bareModel || (Boolean(trusted) && !native && splitModelId(supplied)[0] === undefined);
      const order = trusted && this.o.platforms.includes(trusted) ? [trusted, ...this.o.platforms.filter(item => item !== trusted)] : this.o.platforms;
      let candidates = [];
      if (inferable) {
        for (const requirePrice of [true, false]) {
          for (const platformId of order) {
            const rows = catalogue.filter(c => (c.platform ?? 'openai') === platformId &&
              (this.listedModels(c)?.some(id => bareModelId(id) === model) ?? false) &&
              this.eligible(c, model, platformId, { requirePrice }));
            if (!rows.length) continue;
            platform = platformId;
            candidates = rows;
            break;
          }
          if (candidates.length) break;
        }
      }
      if (!candidates.length) candidates = catalogue.filter(c => this.eligible(c, model, platform));
      // Reusing a group key avoids minting another credential, but not at any
      // price: an unkeyed group must beat a keyed one by more than the bias.
      const keyedGroups = new Set((this.account.data.keys ?? []).map(k => k.groupId));
      const bias = Math.max(0, Number(this.o.reuseBias) || 0);
      const weight = c => this.score(c) * (bias > 0 && !keyedGroups.has(c.groupId) ? 1 + bias : 1);
      candidates.sort((a, b) => weight(a) - weight(b) || a.groupId - b.groupId);
      // Load spreading is opt-in and never overrides fairness: it only reorders
      // within a band around the best candidate, so a much cheaper group still
      // wins. Sticky sessions are re-sorted below, so a warm cache stays put.
      if (this.o.spread !== 'off' && candidates.length > 2) {
        const best = weight(candidates[0]);
        const band = candidates.filter(c => weight(c) <= best * this.o.spreadBand).slice(0, 5);
        if (band.length > 1) {
          let chosen = band[0];
          if (this.o.spread === 'p2c') {
            const first = band[Math.floor(this.rng() * band.length)];
            let second = band[Math.floor(this.rng() * band.length)];
            if (second === first) second = band[(band.indexOf(first) + 1) % band.length];
            chosen = weight(first) <= weight(second) ? first : second;
          } else {
            const share = c => 1 / Math.max(1e-9, weight(c));
            const total = band.reduce((sum, c) => sum + share(c), 0);
            let ticket = this.rng() * total;
            chosen = band[band.length - 1];
            for (const c of band) { ticket -= share(c); if (ticket <= 0) { chosen = c; break; } }
          }
          if (chosen !== candidates[0]) candidates = [chosen, ...candidates.filter(c => c !== chosen)];
        }
      }
      // A price-first route needs a real price. When AIHub returns none for any
      // group, fall back to the nominal multiplier ranking instead of failing.
      if (!candidates.length && this.o.strategy === 'price')
        candidates = catalogue.filter(c => this.eligible(c, model, platform, { requirePrice: false }))
          .sort((a, b) => a.multiplier - b.multiplier || a.groupId - b.groupId);
      const sticky = session && this.sessions.get(session)?.groupId;
      const stickyEndpoint = session ? this.sessions.get(session)?.endpoint : undefined;
      if (sticky) candidates.sort((a, b) => Number(b.groupId === sticky) - Number(a.groupId === sticky));
      // One group serves many models, so the ordering above already prefers a
      // keyed group within the configured reuse bias instead of minting a key per model.
      // A per-platform quota keeps one vendor from eating every slot of a shared pool.
      const used = new Map();
      const hasPlatformSpace = c => this.account.data.mode !== 'managed' || keyedGroups.has(c.groupId) ||
        !this.o.keysPerPlatform || (used.get(c.platform ?? 'openai') ?? 0) < this.o.keysPerPlatform;
      if (this.o.keysPerPlatform > 0 && this.account.data.mode === 'managed') {
        for (const row of catalogue) {
          if (!keyedGroups.has(row.groupId)) continue;
          const platformId = row.platform ?? 'openai';
          used.set(platformId, (used.get(platformId) ?? 0) + 1);
        }
        candidates = candidates.filter(hasPlatformSpace);
      }
      // At cap, exhaust compatible keyed routes before asking for a new key.
      const full = this.account.data.mode === 'managed' && this.account.data.keys.length >= this.o.maxKeysPerAccount;
      const keyedFirst = (a, b) => Number(keyedGroups.has(b.groupId)) - Number(keyedGroups.has(a.groupId));
      if (full) candidates.sort(keyedFirst);
      // The pool size bounds how many candidates one request keeps looking at;
      // it no longer doubles as a key budget.
      candidates = candidates.slice(0, Math.max(1, this.o.poolSize));
      // A group's model card can outlive the model it names. Keep the preferred
      // platform first, then let the other platforms answer for the same bare id
      // instead of reporting the first stale 404.
      if (inferable) {
        const taken = new Set(candidates.map(c => c.groupId));
        const spare = catalogue.filter(c => !taken.has(c.groupId) && hasPlatformSpace(c) &&
          this.eligible(c, model, c.platform ?? 'openai', { requirePrice: false }));
        if (full) spare.sort(keyedFirst);
        if (spare.length) candidates = [...candidates, ...spare.slice(0, Math.max(1, this.o.poolSize))];
      }
      if (full) candidates.sort(keyedFirst);
      const recordEviction = gone => {
        this.evictions.unshift({ at: this.now(), groupId: gone.groupId, name: gone.name });
        if (this.evictions.length > 20) this.evictions.length = 20;
      };
      let attempts = 0, keyMismatch = 0, keyBlocked = 0, firstKeyFailure = null, groupMiss = null;
      let payload = {};
      try { payload = bytes?.length ? JSON.parse(bytes) : {}; } catch { payload = {}; }
      const streaming = payload?.stream === true;
      const inboundPath = url.pathname === '/v1/chat/completions' ? 'chat' : 'responses';
      const epOrder = this.endpoints.order(stickyEndpoint);
      let endpoint = epOrder[0];
      let edgeFailure = false;
      for (let epIndex = 0; epIndex < epOrder.length; epIndex++) {
      endpoint = epOrder[epIndex];
      edgeFailure = false;
      for (const [index, candidate] of candidates.entries()) {
        signal.throwIfAborted();
        if (attempts >= this.o.maxAttempts) break;
        releaseKey();
        releaseKey = this.account.holdKey?.(candidate.groupId) ?? (() => {});
        let key;
        try {
          key = await this.account.keyFor(candidate, this.o, signal, recordEviction);
        } catch (error) {
          signal.throwIfAborted();
          const failure = keyFailure(error);
          // A group that cannot mint a key (cap, balance, switch) says nothing about the
          // groups that already own one, so keep looking and report this if nothing ran.
          const recoverable = ['key_cap_reached', 'balance_too_low', 'key_creation_disabled'].includes(failure.code);
          if (recoverable) { keyBlocked += 1; firstKeyFailure ??= failure; continue; }
          this.recordRoute(candidate, model, failure.code);
          return errorResponse(failure.message, 503, failure.code);
        }
        try {
          let ids = await this.account.modelIds(key, this.o, signal);
          if (!ids.some(id => bareModelId(id) === model)) {
            // The key's own catalogue can lag the group's: refresh once before
            // treating a miss as final.
            ids = await this.account.modelIds(key, { ...this.o, refreshMs: 0 }, signal);
            if (!ids.some(id => bareModelId(id) === model)) {
              keyMismatch += 1;
              // Last resort: ask the remaining group anyway. Its own answer (a
              // 404 or a real completion) beats a guess made from stale lists.
              if (index < candidates.length - 1) continue;
            }
          }
        } catch {
          signal.throwIfAborted();
          this.penalize(candidate.groupId);
          continue;
        }
        attempts++;
        // A native Gemini call already speaks the protocol; only the OpenAI shapes are translated.
        const gemini = !native && (candidate.platform ?? 'openai') === 'gemini';
        const headers = new Headers(gemini
          ? { 'content-type': 'application/json', 'x-goog-api-key': key.key }
          : { 'content-type': 'application/json', ...(native ? { 'x-goog-api-key': key.key } : { authorization: `Bearer ${key.key}` }) });
        // Deliberate allowlist: never leak Magpie/client credentials, cookies or internal session IDs.
        if (!gemini) for (const name of ['accept', 'openai-beta']) if (request.headers.has(name)) headers.set(name, request.headers.get(name));
        const target = gemini ? `${endpoint}${geminiPath(model, streaming)}` : `${endpoint}${url.pathname}${url.search}`;
        const payloadBytes = gemini ? JSON.stringify(toGeminiRequest(payload, inboundPath)) : bytes;
        const attempt = new AbortController();
        const attemptSignal = AbortSignal.any([signal, attempt.signal]);
        const timer = setTimeout(() => { timedOut = true; attempt.abort(new Error('First-byte timeout')); }, this.o.firstByteTimeoutMs);
        timer.unref?.();
        const began = this.now();
        let response, reader, transportFailed = false, timedOut = false;
        const release = this.acquireSlot(candidate.groupId);
        try {
          const proxy = proxyFor(target);
          try { response = await this.fetcher(target, { method: 'POST', headers, body: payloadBytes, signal: attemptSignal, redirect: 'error', ...(proxy ? { proxy } : {}) }); }
          catch (error) { transportFailed = true; throw error; }
          if (!response.ok) {
            this.recordRoute(candidate, model, `http_${response.status}`);
            clearTimeout(timer);
            // A gateway page or a bare 502-504 belongs to the edge host, not to
            // this group; a 401/403 from a secondary host means that host does
            // not know our account. Both are worth another endpoint.
            const edge = EndpointPool.isEdgeResponse(response.status, response.headers.get('content-type')) || (epIndex > 0 && [401, 403].includes(response.status));
            if (edge && epIndex < epOrder.length - 1) { await response.body?.cancel(); edgeFailure = true; break; }
            const retry = response.status === 429 || response.status >= 500 || [401, 403].includes(response.status);
            if (retry) {
              this.penalize(candidate.groupId, retryDelay(response.headers.get('retry-after'), this.now(), this.o.cooldownMs));
              await response.body?.cancel();
              if (session) this.sessions.delete(session);
              continue;
            }
            // Ordinary 400/404 may be caller errors; do not multiply charges trying other groups.
            // Keep the upstream's own words and the exact route: a 404 usually means
            // this group does not serve that model/protocol, not that routing failed.
            let detail = '';
            try {
              const text = await response.text();
              if (text) detail = `: ${text.slice(0, 240).replace(/\s+/g, ' ').trim()}`;
            } catch {}
            // "Not available for this group" is the group's own verdict, not the
            // caller's mistake: remember it briefly and let the next group answer.
            if (response.status === 404 && /not available for this group/i.test(detail)) {
              this.rejected.set(`${candidate.groupId}:${model}`, this.now() + this.o.cooldownMs);
              this.account.forgetModels?.(candidate.groupId);
              groupMiss = { message: `AIHub rejected the request with HTTP ${response.status}${detail} (POST ${url.pathname} via group ${candidate.groupId})`, status: response.status };
              continue;
            }
            return errorResponse(`AIHub rejected the request with HTTP ${response.status}${detail} (POST ${url.pathname} via group ${candidate.groupId})`, response.status);
          }
          this.endpoints.praise(endpoint, this.now() - began);
          // Gemini speaks generateContent, so a non-streaming call is translated
          // whole instead of being piped through.
          if (gemini && !streaming) {
            clearTimeout(timer);
            const raw = await response.text();
            let json;
            try { json = JSON.parse(raw); } catch { throw new Error('Gemini returned a body that is not JSON'); }
            const meta = json?.usageMetadata ?? {};
            this.charge(candidate, (Number(meta.promptTokenCount) || 0) + (Number(meta.candidatesTokenCount) || 0));
            const duration = this.now() - began;
            this.latency.set(candidate.groupId, (this.latency.get(candidate.groupId) ?? duration) * 0.8 + duration * 0.2);
            if (session) { this.sessions.set(session, { groupId: candidate.groupId, endpoint, until: this.now() + this.o.sessionTtlMs }); this.prune(); }
            this.praise(candidate.groupId);
            this.recordRoute(candidate, model, 'success');
            return new Response(JSON.stringify(fromGeminiResponse(json, this.publicId('gemini', model), inboundPath)), {
              status: 200, headers: { 'content-type': 'application/json; charset=utf-8' },
            });
          }
          reader = response.body?.getReader();
          if (!reader) throw new Error('Empty upstream response');
          const first = await reader.read();
          if (first.done) throw new Error('Empty upstream response');
          clearTimeout(timer);
          clearTimeout(budgetTimer);
          const duration = this.now() - began;
          this.latency.set(candidate.groupId, (this.latency.get(candidate.groupId) ?? duration) * 0.8 + duration * 0.2);
          if (session) {
            this.sessions.set(session, { groupId: candidate.groupId, endpoint, until: this.now() + this.o.sessionTtlMs });
            this.prune();
          }
          this.praise(candidate.groupId);
          this.recordRoute(candidate, model, 'success');
          // Once the first byte is handed to the host, no replay is ever attempted.
          // The same pass counts tokens for the local cost estimate; it never edits bytes.
          const decoder = new TextDecoder();
          const encode = text => new TextEncoder().encode(text);
          const translator = gemini ? geminiStream(inboundPath, this.publicId('gemini', model)) : null;
          const usage = { input: 0, output: 0 };
          let tail = '';
          const observe = chunk => {
            const piece = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
            const text = tail + piece;
            for (const match of text.matchAll(/"usage"\s*:\s*\{[^{}]*\}/g)) {
              try {
                const u = JSON.parse(match[0].slice(match[0].indexOf('{'))).usage;
                usage.input = Math.max(usage.input, Number(u?.input_tokens ?? u?.prompt_tokens ?? 0) || 0);
                usage.output = Math.max(usage.output, Number(u?.output_tokens ?? u?.completion_tokens ?? 0) || 0);
              } catch { /* a fragment split across chunks is retried with the next one */ }
            }
            tail = text.slice(-400);
          };
          if (!translator) observe(first.value);
          let firstPending = true;
          const releaseStreamKey = releaseKey;
          const finishStream = () => {
            request.signal.removeEventListener('abort', abortStream);
            releaseStreamKey();
          };
          const abortStream = () => {
            void reader.cancel(request.signal.reason).catch(() => {}).finally(finishStream);
          };
          const stream = new ReadableStream({
            pull: async controller => {
              try {
                attemptSignal.throwIfAborted();
                if (firstPending) {
                  firstPending = false;
                  if (translator) controller.enqueue(encode(translator.push(decoder.decode(first.value, { stream: true }))));
                  else controller.enqueue(first.value);
                  return;
                }
                const next = await reader.read();
                attemptSignal.throwIfAborted();
                if (next.done) {
                  if (translator) { const used = translator.usage(); controller.enqueue(encode(translator.end())); this.charge(candidate, used.input + used.output); }
                  else this.charge(candidate, usage.input + usage.output);
                  reader.releaseLock(); controller.close();
                  finishStream();
                }
                else if (translator) controller.enqueue(encode(translator.push(decoder.decode(next.value, { stream: true }))));
                else { observe(next.value); controller.enqueue(next.value); }
              } catch {
                this.penalize(candidate.groupId);
                if (session && this.sessions.get(session)?.groupId === candidate.groupId) this.sessions.delete(session);
                await reader.cancel().catch(() => {});
                finishStream();
                this.recordRoute(candidate, model, 'stream_interrupted');
                controller.error(new Error('AIHub stream interrupted; request was not replayed'));
              }
            },
            cancel: async reason => {
              attempt.abort();
              await reader.cancel(reason).catch(() => {});
              finishStream();
            },
          });
          const out = new Headers();
          if (translator) out.set('content-type', 'text/event-stream; charset=utf-8');
          else for (const name of ['content-type', 'cache-control']) if (response.headers.has(name)) out.set(name, response.headers.get(name));
          const result = new Response(stream, { status: response.status, headers: out });
          request.signal.addEventListener('abort', abortStream, { once: true });
          if (request.signal.aborted) abortStream();
          releaseKey = () => {};
          return result;
        } catch (error) {
          clearTimeout(timer);
          attempt.abort();
          await reader?.cancel().catch(() => {});
          this.recordRoute(candidate, model, 'connection_failed');
          if (signal.aborted) signal.throwIfAborted();
          // Transport errors (DNS, reset, TLS) are the edge's problem, not this
          // group's: try the next endpoint instead of burning the whole pool.
          // A first-byte timeout means this group is slow, not that the edge is
          // dead: retrying the same group on another host would pay twice.
          if (transportFailed && !timedOut && epIndex < epOrder.length - 1) { edgeFailure = true; break; }
          this.penalize(candidate.groupId);
          if (session) this.sessions.delete(session);
        } finally { clearTimeout(timer); release(); }
      }
      if (edgeFailure) { this.endpoints.penalize(endpoint); continue; }
      break;
      }
      // Every group answered "not available for this group": report the upstream
      // words and status rather than a routing failure that hides them.
      if (groupMiss) return errorResponse(groupMiss.message, groupMiss.status);
      const notes = [];
      if (keyBlocked > 0) notes.push(`${keyBlocked} groups could not mint a key; the groups that already own one were tried instead`);
      if (keyMismatch > 0) notes.push(`${keyMismatch} keyed groups did not list this model in their own catalogue`);
      const note = notes.length ? `; ${notes.join('; ')}` : '';
      // A key problem is the actionable reason when no request ever left.
      if (attempts === 0 && firstKeyFailure) {
        this.recordRoute(candidates[0] ?? { groupId: 0, platform: platform ?? 'openai' }, model, firstKeyFailure.code);
        return errorResponse(firstKeyFailure.message, 503, firstKeyFailure.code);
      }
      const source = ` [source=${JSON.stringify(supplied).slice(0, 48)} hint=${hint || 'none'} bare=${bareModel}]`;
      return errorResponse(this.routeFailure(catalogue.filter(c => (c.platform ?? 'openai') === platform), model, platform, catalogue) + note + source, 503, 'no_eligible_route');
    } catch {
      if (request.signal.aborted) throw request.signal.reason;
      return errorResponse(signal.aborted ? 'AIHub routing deadline exceeded' : 'AIHub catalogue unavailable or no usable route');
    } finally { clearTimeout(budgetTimer); releaseKey(); unlock(); }
  }
  // One line per changed result: tells the operator how many ids each platform
  // actually contributed, which is the fastest way to see a platform filtered out.
  // The id a caller sees: the namespace is optional because Magpie groups models
  // by name, and a prefixed id never joins a group named after the bare model.
  publicId(platform, id) {
    return publicModelId(platform, id, this.o.bareModelIds);
  }
  noteDiscovery(ids) {
    const counts = new Map();
    for (const id of ids) {
      const platform = splitModelId(id)[0] ?? 'openai';
      counts.set(platform, (counts.get(platform) ?? 0) + 1);
    }
    const summary = [...counts].sort().map(([platform, count]) => `${platform} ${count}`).join(', ');
    if (summary === this.discoverySummary) return;
    this.discoverySummary = summary;
    console.error(`[aihub-auto] discovery: ${summary || 'no models'}`);
  }
  async discover(signal) {
    // Discovery never prepares keys or probes inference. Manual imports retain
    // their existing key-backed discovery behavior and need no management login.
    signal?.throwIfAborted();
    const ids = new Set();
    if (this.account.data.mode !== 'managed') {
      for (const key of this.account.data.keys.slice(0, this.o.maxKeysPerAccount)) {
        const platform = key.platform ?? 'openai';
        if (!this.o.platforms.includes(platform)) continue;
        for (const id of await this.account.modelIds(key, this.o, signal)) ids.add(publicModelId(platform, id));
      }
      this.noteDiscovery(ids);
      return [...ids].sort();
    }
    this.prune();
    const catalogue = await this.account.catalogue(this.o, signal);
    const candidates = catalogue.filter(c => this.eligibleGroup(c));
    // No account-visible/eligible groups is a legitimate empty result. A group
    // with unknown models is different: do not report successful empty discovery.
    let evidence = candidates.length === 0;
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      // An enabled, validated restriction can advertise finite IDs when cards
      // are absent. Empty/unknown cards never mean arbitrary model support.
      const advertised = candidate.advertisedModels?.length ? candidate.advertisedModels : candidate.models;
      if (advertised !== undefined) {
        evidence = true;
        for (const id of advertised) if (this.eligible(candidate, id, candidate.platform ?? 'openai', { requirePrice: false })) ids.add(publicModelId(candidate.platform ?? 'openai', id));
      }
    }
    // Only dedicated keys already stored for still-permitted catalogue groups
    // can supplement public evidence; never enumerate/adopt unrelated keys.
    for (const key of this.account.data.keys.slice(0, this.o.maxKeysPerAccount)) {
      const candidate = candidates.find(c => c.groupId === key.groupId);
      if (!candidate || key.owned !== true || candidate.models?.length === 0) continue;
      try {
        const models = await this.account.modelIds(key, this.o, signal);
        evidence = true;
        for (const id of models) if (this.eligible(candidate, id, candidate.platform ?? 'openai', { requirePrice: false })) ids.add(publicModelId(candidate.platform ?? 'openai', id));
      } catch {
        signal?.throwIfAborted();
        // Valid catalogue advertisements remain useful if a dedicated key expired.
      }
    }
    if (!evidence) throw new Error('AIHub model discovery has no supported model IDs in the eligible catalogue or readable dedicated keys; configure explicit model IDs or check catalogue access.');
    this.noteDiscovery(ids);
    return [...ids].sort();
  }
}
