/**
 * Product defaults shared by companion chats and the internal software
 * assistant.  They describe the preferred experience on a normal
 * long-context model; the runtime derives a smaller effective policy when a
 * selected model cannot safely fit them.
 */
export const DEFAULT_SUZU_COMPACTION_TOKEN_THRESHOLD = 32_000;
export const DEFAULT_SUZU_COMPACTION_RETAIN_TOKENS = 8_000;

// When the model's usable input is smaller than the target threshold, keep a
// substantial but bounded raw tail.  At a 20k usable window this preserves
// the intended 8k tail; below that it shrinks with the window instead of
// producing an impossible "retain >= threshold" configuration.
const MAX_SMALL_CONTEXT_RETAIN_RATIO = 0.4;

function positiveInteger(value, fallback = 0) {
  const candidate = Number(value);
  return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : fallback;
}

/**
 * Return a retained raw-history tail that is valid for a concrete compaction
 * threshold.  A zero return is only possible for a one-token-or-smaller
 * input budget, where a positive retained tail would be invalid.
 */
export function adaptiveSuzuCompactionRetainTokens(requestedRetainTokens, thresholdTokens) {
  const threshold = positiveInteger(thresholdTokens);
  if (threshold <= 1) return 0;
  const requested = positiveInteger(requestedRetainTokens, DEFAULT_SUZU_COMPACTION_RETAIN_TOKENS);
  const proportionalMaximum = Math.max(1, Math.floor(threshold * MAX_SMALL_CONTEXT_RETAIN_RATIO));
  return Math.min(requested, proportionalMaximum, threshold - 1);
}
