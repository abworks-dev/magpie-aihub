import test from 'node:test';
import assert from 'node:assert/strict';
import { configModels, settings } from '../src/config.mjs';
import { defaultLimits, FALLBACK_LIMITS } from '../src/limits.mjs';

test('defaultLimits guesses per platform family', () => {
  assert.deepEqual(defaultLimits('gemini', 'gemini-2.5-pro'), { context: 1_048_576, output: 65_536 });
  assert.deepEqual(defaultLimits('gemini', 'gemini-1.5-flash'), { context: 1_048_576, output: 8_192 });
  assert.deepEqual(defaultLimits('openai', 'gpt-5.1'), { context: 400_000, output: 128_000 });
  assert.deepEqual(defaultLimits('openai', 'gpt-4.1-mini'), { context: 1_000_000, output: 32_768 });
  assert.deepEqual(defaultLimits('openai', 'o3-mini'), { context: 200_000, output: 100_000 });
  assert.deepEqual(defaultLimits('deepseek', 'deepseek-chat'), { context: 128_000, output: 64_000 });
  assert.deepEqual(defaultLimits('zhipu', 'glm-4.6'), { context: 200_000, output: 128_000 });
  assert.deepEqual(defaultLimits('kimi', 'kimi-k2-0905-preview'), { context: 256_000, output: 32_768 });
  assert.deepEqual(defaultLimits('grok', 'grok-4-fast'), { context: 256_000, output: 32_768 });
});

test('defaultLimits falls back when the family is unknown', () => {
  assert.deepEqual(defaultLimits('openai', 'some-new-model'), { context: 128_000, output: 16_384 });
  assert.deepEqual(defaultLimits('unknown-platform', 'whatever'), { context: 128_000, output: 16_384 });
  assert.deepEqual(defaultLimits('gemini', 'gemini-9'), { context: 1_000_000, output: 32_768 });
  assert.deepEqual(FALLBACK_LIMITS, { context: 128_000, output: 16_384 });
});

test('configModels applies the guessed limit and keeps explicit values', () => {
  const options = settings({
    models: [
      { id: 'gemini::gemini-2.5-pro' },
      { id: 'gpt-5.1' },
      { id: 'deepseek::deepseek-chat', context: 64_000, output: 8_000 },
    ],
  });
  const models = configModels(options);
  assert.deepEqual(models['gemini::gemini-2.5-pro'].limit, { context: 1_048_576, output: 65_536 });
  assert.deepEqual(models['gpt-5.1'].limit, { context: 400_000, output: 128_000 });
  assert.deepEqual(models['deepseek::deepseek-chat'].limit, { context: 64_000, output: 8_000 });
});

test('configModels falls back to 128k when the model is unknown', () => {
  const models = configModels(settings({ models: [{ id: 'gpt-4-unknown-x' }] }));
  assert.deepEqual(models['gpt-4-unknown-x'].limit, { context: 128_000, output: 16_384 });
});
