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
  // Agent Core emits public TokenUsage in camelCase. Normalize it before provider
  // specific compatibility handling so an Agent Core-backed model keeps its original
  // price catalog entry instead of becoming an unpriced raw event.
  const hasCamelCaseUsage = Object.hasOwn(usage, "inputTokens")
    || Object.hasOwn(usage, "outputTokens")
    || Object.hasOwn(usage, "cacheReadTokens")
    || Object.hasOwn(usage, "cacheWriteTokens");
  if (hasCamelCaseUsage) {
    return {
      inputUncachedTokens: number(usage.inputTokens),
      inputCachedTokens: number(usage.cacheReadTokens),
      inputCacheWriteTokens: number(usage.cacheWriteTokens),
      outputTextTokens: number(usage.outputTokens),
    };
  }
  if (model.startsWith("claude-")) {
    const cacheCreation = usage.cache_creation || usage.cache_creation_input_tokens_details || {};
    const cacheWrite5m = number(cacheCreation.ephemeral_5m_input_tokens);
    const cacheWrite1h = number(cacheCreation.ephemeral_1h_input_tokens);
    const cacheWriteTotal = number(usage.cache_creation_input_tokens);
    return {
      inputUncachedTokens: number(usage.input_tokens),
      inputCachedTokens: number(usage.cache_read_input_tokens),
      inputCacheWriteTokens: cacheWrite5m || Math.max(0, cacheWriteTotal - cacheWrite1h),
      inputCacheWrite1hTokens: cacheWrite1h,
      outputTextTokens: number(usage.output_tokens),
    };
  }
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

  if (
    Object.hasOwn(usage, "promptTokenCount")
    || Object.hasOwn(usage, "candidatesTokenCount")
    || Object.hasOwn(usage, "cachedContentTokenCount")
  ) {
    const promptTokens = number(usage.promptTokenCount);
    const cachedTokens = number(usage.cachedContentTokenCount);
    return {
      inputUncachedTokens: Math.max(0, promptTokens - cachedTokens),
      inputCachedTokens: cachedTokens,
      outputTextTokens: number(usage.candidatesTokenCount),
    };
  }

  const raw = Object.fromEntries(
    Object.entries(usage)
      .map(([key, value]) => [key, number(value)])
      .filter(([, value]) => value > 0),
  );
  const inputTokens = number(usage.prompt_tokens) || number(usage.input_tokens);
  const outputTextTokens = number(usage.completion_tokens) || number(usage.output_tokens);
  const inputDetails = usage.prompt_tokens_details || usage.input_tokens_details || {};
  const inputCachedTokens = number(usage.prompt_cache_hit_tokens)
    || number(usage.cache_read_input_tokens)
    || number(inputDetails.cached_tokens);
  const inputCacheWriteTokens = number(usage.cache_creation_input_tokens);
  const cacheMiss = number(usage.prompt_cache_miss_tokens);
  const hasCacheBreakdown = Object.hasOwn(usage, "prompt_cache_miss_tokens")
    || Object.hasOwn(usage, "prompt_cache_hit_tokens")
    || Object.hasOwn(usage, "cache_read_input_tokens")
    || Object.hasOwn(inputDetails, "cached_tokens")
    || Object.hasOwn(usage, "cache_creation_input_tokens");
  return {
    ...raw,
    ...(inputTokens ? { inputTokens } : {}),
    ...(outputTextTokens ? { outputTextTokens } : {}),
    ...(hasCacheBreakdown ? {
      inputUncachedTokens: cacheMiss || Math.max(0, inputTokens - inputCachedTokens),
      inputCachedTokens,
      inputCacheWriteTokens,
    } : {}),
    ...(number(usage.characters) || number(usage.input_characters)
      ? { inputCharacters: number(usage.characters) || number(usage.input_characters) }
      : {}),
    ...(number(usage.input_audio_seconds) || number(usage.audio_seconds) || number(usage.audio_duration_seconds)
      ? { inputAudioSeconds: number(usage.input_audio_seconds) || number(usage.audio_seconds) || number(usage.audio_duration_seconds) }
      : {}),
  };
}

const DETAILED_INPUT_TOKEN_KEYS = Object.freeze([
  "inputUncachedTokens",
  "inputCachedTokens",
  "inputCacheWriteTokens",
  "inputCacheWrite1hTokens",
]);

function tokenTotals(units) {
  const detailedInput = DETAILED_INPUT_TOKEN_KEYS
    .reduce((total, key) => total + number(units[key]), 0);
  const modalityInput = number(units.inputTextImageVideoTokens) + number(units.inputAudioTokens);
  const input = detailedInput || number(units.inputTokens) || modalityInput;
  const output = number(units.outputTextTokens)
    + number(units.outputAudioTokens)
    + number(units.outputTokens);
  return { input, output };
}

function alignUnitsToPrice(units, rateDefinitions) {
  const aligned = { ...units };
  const definitions = rateDefinitions || {};
  const detailedInput = DETAILED_INPUT_TOKEN_KEYS
    .reduce((total, key) => total + number(aligned[key]), 0);

  if (Object.hasOwn(definitions, "inputUncachedTokens")) {
    if (!detailedInput && number(aligned.inputTokens)) {
      aligned.inputUncachedTokens = number(aligned.inputTokens);
    }
    if (!Object.hasOwn(definitions, "inputCachedTokens")) {
      aligned.inputUncachedTokens = number(aligned.inputUncachedTokens) + number(aligned.inputCachedTokens);
      delete aligned.inputCachedTokens;
    }
    if (!Object.hasOwn(definitions, "inputCacheWriteTokens")) {
      aligned.inputUncachedTokens = number(aligned.inputUncachedTokens) + number(aligned.inputCacheWriteTokens);
      delete aligned.inputCacheWriteTokens;
    }
    if (!Object.hasOwn(definitions, "inputCacheWrite1hTokens")) {
      const oneHourWrites = number(aligned.inputCacheWrite1hTokens);
      if (Object.hasOwn(definitions, "inputCacheWriteTokens")) {
        aligned.inputCacheWriteTokens = number(aligned.inputCacheWriteTokens) + oneHourWrites;
      } else {
        aligned.inputUncachedTokens = number(aligned.inputUncachedTokens) + oneHourWrites;
      }
      delete aligned.inputCacheWrite1hTokens;
    }
    delete aligned.inputTokens;
  } else if (Object.hasOwn(definitions, "inputTokens") && !number(aligned.inputTokens) && detailedInput) {
    aligned.inputTokens = detailedInput;
  }
  return aligned;
}

function selectRateTier(rateTiers, totals) {
  if (!Array.isArray(rateTiers) || !rateTiers.length) return null;
  return rateTiers.find((tier) => (
    (!Number.isFinite(Number(tier.maxInputTokens)) || totals.input <= Number(tier.maxInputTokens))
    && (!Number.isFinite(Number(tier.maxOutputTokens)) || totals.output <= Number(tier.maxOutputTokens))
  )) || rateTiers.at(-1);
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
  const inferredUnits = normalizeUsage(model, usage);
  const explicitUnits = hasExplicitUnits
    ? Object.fromEntries(
      Object.entries(units)
        .map(([key, value]) => [key, number(value)])
        .filter(([, value]) => value > 0),
    )
    : {};
  const inferredAndExplicitUnits = hasExplicitUnits
    ? { ...inferredUnits, ...explicitUnits }
    : inferredUnits;
  if (!price) {
    return {
      amountCny: null,
      currency: "CNY",
      status: "unknown-price",
      price: null,
      units: inferredAndExplicitUnits,
      breakdown: [],
    };
  }

  const totals = tokenTotals(inferredAndExplicitUnits);
  const tier = selectRateTier(price.rateTiers, totals);
  const rates = tier ? { ...price.rates, ...(tier.rates || {}) } : price.rates;
  const normalizedUnits = alignUnitsToPrice(inferredAndExplicitUnits, price.rateDefinitions);

  const breakdown = [];
  let amountCny = 0;
  for (const [key, definition] of Object.entries(price.rateDefinitions || {})) {
    const quantity = number(normalizedUnits[key]);
    const rate = number(rates[key]);
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
      ...(price.ratePeriod ? { ratePeriod: price.ratePeriod } : {}),
      ...(tier?.label ? { rateTier: tier.label } : {}),
    },
    units: normalizedUnits,
    breakdown,
  };
}
