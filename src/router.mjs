import { createHash } from 'node:crypto';
import { ORIGIN } from './config.mjs';
import { validPlatform, publicModelId, modelDescriptor } from './platforms.mjs';
import { keyFailure } from './errors.mjs';
import { proxyFor } from './proxy.mjs';

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
  constructor(account, options, { fetcher = globalThis.fetch, now = Date.now } = {}) {
    this.account = account; this.o = options; this.fetcher = fetcher; this.now = now;
    this.sessions = new Map(); this.cooldown = new Map(); this.latency = new Map(); this.rejected = new Map();
    this.locks = new Map(); this.lastRoutes = [];
  }
  recordRoute(candidate, model, outcome) {
    this.lastRoutes.push({ groupId: candidate.groupId, platform: candidate.platform ?? 'openai', at: this.now(), outcome, model });
    if (this.lastRoutes.length > 100) this.lastRoutes.splice(0, this.lastRoutes.length - 100);
  }
  eligibleGroup(c) {
    const o = this.o;
    return o.platforms.includes(c.platform ?? 'openai') && !o.excludedGroups.includes(c.groupId) && (!o.allowedGroups.length || o.allowedGroups.includes(c.groupId)) &&
      c.multiplier <= o.maxMultiplier && c.available !== false && !c.blocked &&
      (!o.requirePassed || c.passed === true) && (this.cooldown.get(c.groupId) ?? 0) <= this.now();
  }
  priceKnown(c) {
    return Number.isFinite(c.metrics?.realPrice) && c.metrics.realPrice >= 0;
  }
  eligible(c, model, platform = c.platform ?? 'openai', { requirePrice = this.o.strategy === 'price' } = {}) {
    return (c.platform ?? 'openai') === platform && this.eligibleGroup(c) && (!requirePrice || this.priceKnown(c)) &&
      (!c.models || c.models.includes(model)) &&
      !(c.rejected ?? []).includes(model) && !this.rejected.has(`${c.groupId}:${model}`);
  }
  score(c) {
    const ms = this.latency.get(c.groupId) ?? c.latency ?? 30000;
    if (this.o.strategy === 'speed') return ms;
    if (this.o.strategy === 'economy') return c.multiplier;
    if (this.o.strategy === 'price') return this.priceKnown(c) ? c.metrics.realPrice : Infinity;
    return c.multiplier * (1 + Math.min(ms, 60000) / 10000);
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
    if (url.origin !== ORIGIN || !validQuery || (!native && !['/v1/responses', '/v1/chat/completions', '/v1/models'].includes(url.pathname)))
      return errorResponse('Only supported AIHub inference and model-discovery endpoints are allowed', 400);
    if (url.pathname === '/v1/models') {
      if (request.method !== 'GET') return errorResponse('Method not allowed', 405);
      try { return Response.json({ object: 'list', data: (await this.discover(request.signal)).map(id => ({ id, object: 'model', owned_by: 'aihub' })) }); }
      catch { return errorResponse('Cannot discover models; configure explicit model IDs or check group credentials'); }
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
    let platform, model;
    try {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
      const hint = request.headers.get('x-aihub-auto-platform');
      const supplied = native ? native[1] : body.model;
      if (typeof supplied !== 'string' || !supplied) throw new Error();
      const descriptor = modelDescriptor({ id: supplied, ...(hint ? { platform: hint } : native ? { platform: 'gemini' } : {}), api: native ? 'gemini' : url.pathname === '/v1/chat/completions' ? 'chat' : 'responses' });
      platform = descriptor.platform; model = descriptor.modelId;
      if (!validPlatform(platform) || !this.o.platforms.includes(platform) || (native && body.model !== undefined && body.model !== model)) throw new Error();
      if (!native) { body.model = model; bytes = Buffer.from(JSON.stringify(body)); }
    } catch { clearTimeout(budgetTimer); return errorResponse('Invalid or disabled platform/model/protocol combination', 400, 'invalid_platform_model'); }
    // Stateful server-side continuation cannot safely be replayed across provider accounts.
    // Require clients to send full history; never guess which upstream owns a response ID.
    if (body.previous_response_id || body.conversation) { clearTimeout(budgetTimer); return errorResponse('Send full conversation history; server-side previous_response_id/conversation routing is not supported', 400); }
    const session = sessionKey(request.headers, { ...body, model: publicModelId(platform, model) }, url.pathname);
    let unlock = () => {};
    try {
      unlock = await this.lock(session, signal);
      signal.throwIfAborted();
      this.prune();
      const catalogue = await this.account.catalogue(this.o, signal);
      let candidates = catalogue.filter(c => this.eligible(c, model, platform)).sort((a, b) => this.score(a) - this.score(b) || a.groupId - b.groupId);
      // A price-first route needs a real price. When AIHub returns none for any
      // group, fall back to the nominal multiplier ranking instead of failing.
      if (!candidates.length && this.o.strategy === 'price')
        candidates = catalogue.filter(c => this.eligible(c, model, platform, { requirePrice: false }))
          .sort((a, b) => a.multiplier - b.multiplier || a.groupId - b.groupId);
      const sticky = session && this.sessions.get(session)?.groupId;
      if (sticky) candidates.sort((a, b) => Number(b.groupId === sticky) - Number(a.groupId === sticky));
      // A full managed pool does not create/delete keys just because market rankings move.
      if (this.account.data.mode === 'managed' && this.account.data.keys.length >= this.o.poolSize)
        candidates = candidates.filter(c => this.account.data.keys.some(k => k.groupId === c.groupId));
      let attempts = 0;
      for (const candidate of candidates) {
        signal.throwIfAborted();
        if (attempts >= this.o.maxAttempts) break;
        let key;
        try {
          key = await this.account.keyFor(candidate, this.o, signal);
        } catch (error) {
          signal.throwIfAborted();
          const failure = keyFailure(error);
          this.recordRoute(candidate, model, failure.code);
          return errorResponse(failure.message, 503, failure.code);
        }
        try {
          const ids = await this.account.modelIds(key, this.o, signal);
          if (!ids.includes(model)) continue;
        } catch {
          signal.throwIfAborted();
          this.cooldown.set(candidate.groupId, this.now() + this.o.cooldownMs);
          continue;
        }
        attempts++;
        const headers = new Headers({ 'content-type': 'application/json', ...(native ? { 'x-goog-api-key': key.key } : { authorization: `Bearer ${key.key}` }) });
        // Deliberate allowlist: never leak Magpie/client credentials, cookies or internal session IDs.
        for (const name of ['accept', 'openai-beta']) if (request.headers.has(name)) headers.set(name, request.headers.get(name));
        const attempt = new AbortController();
        const attemptSignal = AbortSignal.any([signal, attempt.signal]);
        const timer = setTimeout(() => attempt.abort(new Error('First-byte timeout')), this.o.firstByteTimeoutMs);
        timer.unref?.();
        const began = this.now();
        let response, reader;
        try {
          const target = `${ORIGIN}${url.pathname}${url.search}`;
          const proxy = proxyFor(target);
          response = await this.fetcher(target, { method: 'POST', headers, body: bytes, signal: attemptSignal, redirect: 'error', ...(proxy ? { proxy } : {}) });
          if (!response.ok) {
            this.recordRoute(candidate, model, `http_${response.status}`);
            clearTimeout(timer);
            const retry = response.status === 429 || response.status >= 500 || [401, 403].includes(response.status);
            if (retry) {
              this.cooldown.set(candidate.groupId, this.now() + retryDelay(response.headers.get('retry-after'), this.now(), this.o.cooldownMs));
              await response.body?.cancel();
              if (session) this.sessions.delete(session);
              continue;
            }
            // Ordinary 400/404 may be caller errors; do not multiply charges trying other groups.
            await response.body?.cancel();
            return errorResponse(`AIHub rejected the request with HTTP ${response.status}; review model and request parameters`, response.status);
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
            this.sessions.set(session, { groupId: candidate.groupId, until: this.now() + this.o.sessionTtlMs });
            this.prune();
          }
          this.cooldown.delete(candidate.groupId);
          this.recordRoute(candidate, model, 'success');
          // Once the first byte is handed to the host, no replay is ever attempted.
          let firstPending = true;
          const stream = new ReadableStream({
            pull: async controller => {
              try {
                if (firstPending) { firstPending = false; controller.enqueue(first.value); return; }
                const next = await reader.read();
                if (next.done) { reader.releaseLock(); controller.close(); }
                else controller.enqueue(next.value);
              } catch {
                this.cooldown.set(candidate.groupId, this.now() + this.o.cooldownMs);
                if (session && this.sessions.get(session)?.groupId === candidate.groupId) this.sessions.delete(session);
                await reader.cancel().catch(() => {});
                this.recordRoute(candidate, model, 'stream_interrupted');
                controller.error(new Error('AIHub stream interrupted; request was not replayed'));
              }
            },
            cancel: async reason => { attempt.abort(); await reader.cancel(reason).catch(() => {}); },
          });
          const out = new Headers();
          for (const name of ['content-type', 'cache-control']) if (response.headers.has(name)) out.set(name, response.headers.get(name));
          return new Response(stream, { status: response.status, headers: out });
        } catch {
          clearTimeout(timer);
          attempt.abort();
          await reader?.cancel().catch(() => {});
          this.recordRoute(candidate, model, 'connection_failed');
          if (signal.aborted) signal.throwIfAborted();
          this.cooldown.set(candidate.groupId, this.now() + this.o.cooldownMs);
          if (session) this.sessions.delete(session);
        } finally { clearTimeout(timer); }
      }
      return errorResponse('No eligible AIHub route remains within the configured multiplier and attempt limits');
    } catch {
      if (request.signal.aborted) throw request.signal.reason;
      return errorResponse(signal.aborted ? 'AIHub routing deadline exceeded' : 'AIHub catalogue unavailable or no usable route');
    } finally { clearTimeout(budgetTimer); unlock(); }
  }
  async discover(signal) {
    // Discovery never prepares keys or probes inference. Manual imports retain
    // their existing key-backed discovery behavior and need no management login.
    signal?.throwIfAborted();
    const ids = new Set();
    if (this.account.data.mode !== 'managed') {
      for (const key of this.account.data.keys.slice(0, this.o.poolSize)) {
        const platform = key.platform ?? 'openai';
        if (!this.o.platforms.includes(platform)) continue;
        for (const id of await this.account.modelIds(key, this.o, signal)) ids.add(publicModelId(platform, id));
      }
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
        for (const id of advertised) if (this.eligible(candidate, id)) ids.add(publicModelId(candidate.platform ?? 'openai', id));
      }
    }
    // Only dedicated keys already stored for still-permitted catalogue groups
    // can supplement public evidence; never enumerate/adopt unrelated keys.
    for (const key of this.account.data.keys.slice(0, this.o.poolSize)) {
      const candidate = candidates.find(c => c.groupId === key.groupId);
      if (!candidate || key.owned !== true || candidate.models?.length === 0) continue;
      try {
        const models = await this.account.modelIds(key, this.o, signal);
        evidence = true;
        for (const id of models) if (this.eligible(candidate, id)) ids.add(publicModelId(candidate.platform ?? 'openai', id));
      } catch {
        signal?.throwIfAborted();
        // Valid catalogue advertisements remain useful if a dedicated key expired.
      }
    }
    if (!evidence) throw new Error('AIHub model discovery has no supported model IDs in the eligible catalogue or readable dedicated keys; configure explicit model IDs or check catalogue access.');
    return [...ids].sort();
  }
}
