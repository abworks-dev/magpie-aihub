import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHall } from '../src/api.mjs';

const row = (id, range_cache) => ({ group_id: id, platform: 'openai', rate_multiplier: 0.05, range_cache });

test('the real price is derived from the observed cost and token counts', () => {
  const hall = normalizeHall([row(7, {
    ready: true, stale: false, cache_hit_rate: 0.98,
    input_tokens: 1_000_000, input_cost: 0.4,
    cache_read_tokens: 0, cache_read_cost: 0, cache_creation_tokens: 0, cache_creation_cost: 0,
  })]);
  const entry = hall.get(7);
  assert.equal(entry.metrics.cacheHitRate, 0.98);
  assert.equal(entry.metrics.realPrice, 0.4);
});

test('cache tokens and their cost join the same blend', () => {
  const hall = normalizeHall([row(9, {
    ready: true, stale: false,
    input_tokens: 1_000_000, input_cost: 1, cache_read_tokens: 3_000_000, cache_read_cost: 0.6,
  })]);
  assert.equal(hall.get(9).metrics.realPrice, 0.4);
});

test('an explicit real_price still wins over the derived value', () => {
  const hall = normalizeHall([row(11, { ready: true, stale: false, real_price: 0.123, input_tokens: 10, input_cost: 10 })]);
  assert.equal(hall.get(11).metrics.realPrice, 0.123);
});

test('a stale, unprepared or empty window leaves the real price unknown', () => {
  const hall = normalizeHall([
    row(12, { ready: true, stale: true, input_tokens: 10, input_cost: 1 }),
    row(13, { ready: false, input_tokens: 10, input_cost: 1 }),
    row(14, { ready: true, stale: false, input_tokens: 0, input_cost: 0 }),
  ]);
  assert.equal(hall.get(12).metrics.realPrice, null);
  assert.equal(hall.get(13).metrics.realPrice, null);
  assert.equal(hall.get(14).metrics.realPrice, null);
});

test('the hall window carries its sample count and detection state', () => {
  const payload = { group_id: 21, platform: 'deepseek', rate_multiplier: 0.5, avg_ttft_ms: 1200,
    model_detection: { status: 'passed' },
    range_cache: { ready: true, stale: false, usage_records: 4321, observed_seconds: 3600, input_tokens: 1000000, input_cost: 0.5 } };
  const entry = normalizeHall([payload]).get(21);
  assert.equal(entry.metrics.samples, 4321);
  assert.equal(entry.metrics.observedSeconds, 3600);
  assert.equal(entry.detection, 'passed');
  assert.equal(entry.latency, 1200);
});

test('the hall exposes the 1h success rate, the reputation and the model cards', () => {
  const entry = normalizeHall([{ group_id: 31, platform: 'openai', rate_multiplier: 0.06,
    success_rates: { '1h': 0.94, '6h': 0.91 }, reputation: 4.15,
    model_cards: [{ model: 'gpt-5.6', alias: 'A', price: 0.07, health: 'ok', sample_count: 21 }, { model: 'bad id!', health: 'failed' }] }]).get(31);
  assert.equal(entry.metrics.successRate1h, 0.94);
  assert.equal(entry.metrics.successRate, 0.91);
  assert.equal(entry.metrics.reputation, 4.15);
  assert.equal(entry.cards.length, 1);
  assert.equal(entry.cards[0].price, 0.07);
  assert.equal(entry.cards[0].sampleCount, 21);
});
