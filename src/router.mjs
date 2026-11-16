import { createHash } from 'node:crypto';
import { BASE, ORIGIN } from './config.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const errorResponse = (message, status = 503) => Response.json({ error: { type: 'aihub_routing_error', message } }, { status });

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
    this.locks = new Map();
  }
  eligible(c, model) {
    const o = this.o;
    return !o.excludedGroups.includes(c.groupId) && (!o.allowedGroups.length || o.allowedGroups.includes(c.groupId)) &&
      c.multiplier <= o.maxMultiplier && c.available !== false && !c.blocked &&
      (!o.requirePassed || c.passed === true) && (!c.models || c.models.includes(model)) &&
      !(c.rejected ?? []).includes(model) && !this.rejected.has(`${c.groupId}:${model}`) &&
      (this.cooldown.get(c.groupId) ?? 0) <= this.now();
  }
  score(c) {
    const ms = this.latency.get(c.groupId) ?? c.latency ?? 30000;
    if (this.o.strategy === 'speed') return ms;
    if (this.o.strategy === 'economy') return c.multiplier;
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
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== ORIGIN || url.search || !['/v1/responses', '/v1/chat/completions', '/v1/models'].includes(url.pathname))
      return errorResponse('Only AIHub /v1/responses, /v1/chat/completions and /v1/models are allowed', 400);
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
    if (!body || typeof body.model !== 'string' || !body.model) { clearTimeout(budgetTimer); return errorResponse('A model ID is required', 400); }
    // Stateful server-side continuation cannot safely be replayed across provider accounts.
    // Require clients to send full history; never guess which upstream owns a response ID.
    if (body.previous_response_id || body.conversation) { clearTimeout(budgetTimer); return errorResponse('Send full conversation history; server-side previous_response_id/conversation routing is not supported', 400); }
    const session = sessionKey(request.headers, body, url.pathname);
    let unlock = () => {};
    try {
      unlock = await this.lock(session, signal);
      signal.throwIfAborted();
      this.prune();
      const catalogue = await this.account.catalogue(this.o, signal);
      let candidates = catalogue.filter(c => this.eligible(c, body.model)).sort((a, b) => this.score(a) - this.score(b) || a.groupId - b.groupId);
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
        } catch { return errorResponse('Cannot prepare group key; check AIHub access, creation options and pending keys'); }
        try {
          const ids = await this.account.modelIds(key, this.o, signal);
          if (!ids.includes(body.model)) continue;
        } catch {
          signal.throwIfAborted();
          this.cooldown.set(candidate.groupId, this.now() + this.o.cooldownMs);
          continue;
        }
        attempts++;
        const headers = new Headers({ 'content-type': 'application/json', authorization: `Bearer ${key.key}` });
        // Deliberate allowlist: never leak Magpie/client credentials, cookies or internal session IDs.
        for (const name of ['accept', 'openai-beta']) if (request.headers.has(name)) headers.set(name, request.headers.get(name));
        const attempt = new AbortController();
        const attemptSignal = AbortSignal.any([signal, attempt.signal]);
        const timer = setTimeout(() => attempt.abort(new Error('First-byte timeout')), this.o.firstByteTimeoutMs);
        timer.unref?.();
        const began = this.now();
        let response, reader;
        try {
          response = await this.fetcher(`${BASE}${url.pathname.slice(3)}`, { method: 'POST', headers, body: bytes, signal: attemptSignal, redirect: 'error' });
          if (!response.ok) {
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
    // Model discovery is read-only: never create keys just to populate a dropdown.
    const ids = new Set();
    for (const key of this.account.data.keys.slice(0, this.o.poolSize)) {
      for (const id of await this.account.modelIds(key, this.o, signal)) ids.add(id);
    }
    return [...ids].sort();
  }
}
