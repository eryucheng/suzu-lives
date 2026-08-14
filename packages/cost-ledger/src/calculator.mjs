import {
  DEFAULT_PRICE_CATALOG,
  normalizeModelId,
  resolvePriceRevision,
} from "./catalog.mjs";

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : 0;
}

export function normalizeUsage(modelName, usage = {}) {
  const model = normalizeModelId(modelName);
  if (model.startsWith("deepseek-")) {
    const nativeMiss = number(usage.prompt_cache_miss_tokens);
    const nativeHit = number(usage.prompt_cache_hit_tokens);
    const hasNativeCacheBreakdown =
      Object.hasOwn(usage, "prompt_cache_miss_tokens")
      || Object.hasOwn(usage, "prompt_cache_hit_tokens");
    return {
      inputUncachedTokens: hasNativeCacheBreakdown ? nativeMiss : (
        number(usage.input_tokens)
        + number(usage.cache_creation_input_tokens)
      ),
      inputCachedTokens: hasNativeCacheBreakdown
        ? nativeHit
        : number(usage.cache_read_input_tokens),
      outputTextTokens: number(usage.completion_tokens) || number(usage.output_tokens),
    };
  }

  if (model === "qwen3.5-omni-flash") {
    const inputDetails = usage.prompt_tokens_details || usage.input_tokens_details || {};
    const outputDetails = usage.completion_tokens_details || usage.output_tokens_details || {};
    const prompt = number(usage.prompt_tokens) || number(usage.input_tokens);
    const audioInput = number(inputDetails.audio_tokens);
    const explicitVisualAndText =
      number(inputDetails.video_tokens)
      + number(inputDetails.image_tokens)
      + number(inputDetails.text_tokens);
    return {
      inputTextImageVideoTokens: explicitVisualAndText || Math.max(0, prompt - audioInput),
      inputAudioTokens: audioInput,
      outputTextTokens:
        number(outputDetails.text_tokens)
        || number(usage.completion_tokens)
        || number(usage.output_tokens),
      outputAudioTokens: number(outputDetails.audio_tokens),
    };
  }

  if (model === "text-embedding-v4") {
    return {
      inputTokens:
        number(usage.prompt_tokens)
        || number(usage.input_tokens)
        || number(usage.total_tokens),
    };
  }

  if (model === "qwen3-tts-vd-2026-01-26") {
    return {
      inputCharacters: number(usage.characters) || number(usage.input_characters),
    };
  }

  return Object.fromEntries(
    Object.entries(usage)
      .map(([key, value]) => [key, number(value)])
      .filter(([, value]) => value > 0),
  );
}

export function calculateCost({
  catalog = DEFAULT_PRICE_CATALOG,
  customRevisions = [],
  model,
  timestamp,
  usage = {},
  units,
} = {}) {
  const price = resolvePriceRevision({
    catalog,
    customRevisions,
    model,
    timestamp,
  });
  const hasExplicitUnits = units
    && typeof units === "object"
    && !Array.isArray(units)
    && Object.keys(units).length > 0;
  const normalizedUnits = hasExplicitUnits
    ? Object.fromEntries(
      Object.entries(units).map(([key, value]) => [key, number(value)]),
    )
    : normalizeUsage(model, usage);
  if (!price) {
    return {
      amountCny: null,
      currency: "CNY",
      status: "unknown-price",
      price: null,
      units: normalizedUnits,
      breakdown: [],
    };
  }

  const breakdown = [];
  let amountCny = 0;
  for (const [key, definition] of Object.entries(price.rateDefinitions || {})) {
    const quantity = number(normalizedUnits[key]);
    const rate = number(price.rates[key]);
    const amount = definition.per > 0 ? (quantity / definition.per) * rate : 0;
    amountCny += amount;
    breakdown.push({
      key,
      label: definition.label,
      quantity,
      per: definition.per,
      rate,
      amountCny: amount,
    });
  }
  return {
    amountCny,
    currency: price.currency,
    status: "estimated",
    price: {
      modelId: price.modelId,
      revisionId: price.revisionId,
      effectiveFrom: price.effectiveFrom,
      origin: price.origin,
    },
    units: normalizedUnits,
    breakdown,
  };
}
