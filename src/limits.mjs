// Context/output defaults, guessed from the platform and the model id.
//
// AIHub publishes no window size in either place the plugin can read:
// `GET /v1/models` returns ids only, and the console model cards carry price,
// alias, health and sample count. Without a value every model would register
// as 128k/16k, so this table gives a conservative guess per family.
//
// These are placeholders, not vendor specifications. A model entry that
// declares `context` or `output` always wins, and a wrong guess only affects
// how the host displays and budgets a window — the router never truncates or
// rejects a request against this number.

const FALLBACK = { context: 128_000, output: 16_384 };

const PLATFORM_DEFAULTS = {
  gemini: { context: 1_000_000, output: 32_768 },
  grok: { context: 131_072, output: 16_384 },
};

// Ordered: the first pattern that matches the bare, lower-cased model id wins.
const RULES = {
  openai: [
    [/^gpt-5/, { context: 400_000, output: 128_000 }],
    [/^gpt-4\.1/, { context: 1_000_000, output: 32_768 }],
    [/^gpt-4o/, { context: 128_000, output: 16_384 }],
    // o1 / o3 / o4 and their -mini variants share one window (o4-mini 200k/100k).
    [/^o[134](?:-|$)/, { context: 200_000, output: 100_000 }],
    [/^gpt-4-turbo/, { context: 128_000, output: 4_096 }],
  ],
  deepseek: [
    [/^deepseek-(?:v3\.2|chat|reasoner)/, { context: 128_000, output: 64_000 }],
  ],
  zhipu: [
    [/^glm-(?:4\.5|4\.6|5)/, { context: 200_000, output: 128_000 }],
    // GLM-4-Plus / Air / Flash keep the 128k window with a 4k answer cap.
    [/^glm-4/, { context: 128_000, output: 4_096 }],
  ],
  kimi: [
    [/^kimi-k2/, { context: 256_000, output: 32_768 }],
    [/^kimi-latest/, { context: 128_000, output: 4_096 }],
    [/^moonshot-v1-128k/, { context: 128_000, output: 4_096 }],
    [/^moonshot-v1-32k/, { context: 32_000, output: 4_096 }],
    [/^moonshot-v1-8k/, { context: 8_000, output: 4_096 }],
  ],
  grok: [
    [/^grok-4/, { context: 256_000, output: 32_768 }],
    [/^grok-3-mini/, { context: 131_072, output: 8_192 }],
    [/^grok-3/, { context: 131_072, output: 32_768 }],
    [/^grok-2/, { context: 131_072, output: 8_192 }],
  ],
  gemini: [
    [/^gemini-2\.5/, { context: 1_048_576, output: 65_536 }],
    [/^gemini-(?:1\.5|2\.0)/, { context: 1_048_576, output: 8_192 }],
  ],
};

/**
 * Guess `{ context, output }` for one model. Unknown platform or family falls
 * back to the plugin-wide placeholder. Explicit options always take priority,
 * so this is only the value used when nothing was configured.
 */
export function defaultLimits(platform, modelId) {
  const id = String(modelId ?? '').toLowerCase();
  for (const [pattern, limits] of RULES[platform] ?? []) {
    if (pattern.test(id)) return { ...limits };
  }
  return { ...(PLATFORM_DEFAULTS[platform] ?? FALLBACK) };
}

export const FALLBACK_LIMITS = { ...FALLBACK };
