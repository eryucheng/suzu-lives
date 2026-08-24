const TEXT_INPUT = Object.freeze(["text"]);
const TEXT_AND_IMAGE_INPUT = Object.freeze(["text", "image"]);

function clean(value) {
  return String(value ?? "").trim();
}

function model({
  id,
  name = "",
  contextWindow = 0,
  maxTokens = 0,
  input = TEXT_INPUT,
} = {}) {
  const entry = {
    id: clean(id),
    name: clean(name) || clean(id),
    input: Object.freeze([...new Set((Array.isArray(input) ? input : TEXT_INPUT)
      .map((value) => clean(value).toLowerCase())
      .filter((value) => value === "text" || value === "image"))]),
  };
  if (!entry.input.length) entry.input = TEXT_INPUT;
  if (Number.isSafeInteger(contextWindow) && contextWindow > 0) entry.contextWindow = contextWindow;
  if (Number.isSafeInteger(maxTokens) && maxTokens > 0) entry.maxTokens = maxTokens;
  return Object.freeze(entry);
}

function provider({
  label,
  route,
  baseUrl,
  model: defaultModel,
  protocol,
  native = false,
  models = [],
} = {}) {
  return Object.freeze({
    label: clean(label),
    route: clean(route),
    baseUrl: clean(baseUrl),
    model: clean(defaultModel),
    protocol: clean(protocol),
    native: native === true,
    models: Object.freeze(models.filter((entry) => clean(entry?.id))),
  });
}

/**
 * The product-owned model directory is the single authority for built-in
 * provider defaults, compatible protocol, and known per-model input
 * modalities. Add or revise a built-in model here: settings, onboarding,
 * saved compatible profiles, and runtime attachment routing derive from it.
 */
export const TEXT_MODEL_PROVIDERS = Object.freeze({
  deepseek: provider({
    label: "DeepSeek",
    route: "deepseek-official",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    protocol: "openai-completions",
    native: true,
    models: [
      model({ id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", contextWindow: 1_000_000 }),
      model({ id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", contextWindow: 1_000_000 }),
      model({
        id: "deepseek-v4-flash-vision-exp",
        name: "DeepSeek-V4-Flash-Vision-Exp",
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        input: TEXT_AND_IMAGE_INPUT,
      }),
    ],
  }),
  minimax: provider({
    label: "MiniMax（中国区）",
    route: "suzu-minimax",
    baseUrl: "https://api.minimaxi.com/anthropic",
    model: "MiniMax-M2.7",
    protocol: "anthropic-messages",
    models: [
      model({ id: "MiniMax-M2.7", contextWindow: 204_800 }),
      model({ id: "MiniMax-M2.7-highspeed", contextWindow: 204_800 }),
      model({ id: "MiniMax-M2.5", contextWindow: 204_800 }),
      model({ id: "MiniMax-M2.5-highspeed", contextWindow: 204_800 }),
      model({ id: "MiniMax-M2.1", contextWindow: 204_800 }),
      model({ id: "MiniMax-M2.1-highspeed", contextWindow: 204_800 }),
      model({ id: "MiniMax-M2", contextWindow: 204_800 }),
    ],
  }),
  "bailian-coding": provider({
    label: "阿里百炼（Coding Plan）",
    route: "suzu-bailian-coding",
    baseUrl: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    model: "qwen3.8-max-preview",
    protocol: "anthropic-messages",
    models: [
      model({ id: "qwen3.8-max-preview" }),
      model({ id: "qwen3.7-max" }),
      model({ id: "qwen3.6-flash" }),
    ],
  }),
  "bailian-payg": provider({
    label: "阿里百炼（按量）",
    route: "suzu-bailian-payg",
    baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    model: "qwen3.8-max",
    protocol: "anthropic-messages",
    models: [
      model({ id: "qwen3.8-max", input: TEXT_AND_IMAGE_INPUT }),
      model({ id: "qwen3.7-plus", input: TEXT_AND_IMAGE_INPUT }),
      model({ id: "qwen3.6-plus", input: TEXT_AND_IMAGE_INPUT }),
      model({ id: "qwen3.5-plus", input: TEXT_AND_IMAGE_INPUT }),
      model({ id: "qwen3-vl-plus", input: TEXT_AND_IMAGE_INPUT }),
      model({ id: "qwen3-vl-flash", input: TEXT_AND_IMAGE_INPUT }),
      model({ id: "qwen3.7-max" }),
      model({ id: "qwen3.6-flash", input: TEXT_AND_IMAGE_INPUT }),
    ],
  }),
  kimi: provider({
    label: "Kimi Code",
    route: "suzu-kimi",
    baseUrl: "https://api.kimi.com/coding",
    model: "kimi-for-coding",
    protocol: "anthropic-messages",
    models: [
      model({ id: "k3", contextWindow: 256_000 }),
      model({ id: "k3-256k", contextWindow: 256_000 }),
      model({ id: "kimi-for-coding", contextWindow: 256_000 }),
      model({ id: "kimi-for-coding-highspeed", contextWindow: 256_000 }),
    ],
  }),
  "kimi-api": provider({
    label: "Kimi API",
    route: "suzu-kimi-api",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k2.6",
    protocol: "openai-completions",
    models: [
      model({ id: "kimi-k2.6", contextWindow: 256_000, maxTokens: 32_768, input: TEXT_AND_IMAGE_INPUT }),
      model({ id: "kimi-k2.5", contextWindow: 256_000, maxTokens: 32_768, input: TEXT_AND_IMAGE_INPUT }),
      model({ id: "moonshot-v1-8k-vision-preview", contextWindow: 8_000, input: TEXT_AND_IMAGE_INPUT }),
      model({ id: "moonshot-v1-32k-vision-preview", contextWindow: 32_000, input: TEXT_AND_IMAGE_INPUT }),
      model({ id: "moonshot-v1-128k-vision-preview", contextWindow: 128_000, input: TEXT_AND_IMAGE_INPUT }),
    ],
  }),
  custom: provider({
    label: "自定义兼容服务",
    route: "suzu-custom",
    baseUrl: "",
    model: "",
    protocol: "anthropic-messages",
  }),
});

export const DEFAULT_TEXT_MODEL_PROVIDER_ID = "deepseek";
export const DEFAULT_DEEPSEEK_BASE_URL = TEXT_MODEL_PROVIDERS.deepseek.baseUrl;
export const DEFAULT_DEEPSEEK_MODEL = TEXT_MODEL_PROVIDERS.deepseek.model;

export function textModelProviderId(value) {
  const id = clean(value).toLowerCase();
  return Object.hasOwn(TEXT_MODEL_PROVIDERS, id) ? id : "custom";
}

export function textModelProviderForRoute(value) {
  const route = clean(value);
  for (const [id, definition] of Object.entries(TEXT_MODEL_PROVIDERS)) {
    if (definition.route === route) return id;
  }
  return "custom";
}

export function modelCatalogEntries(providerId) {
  return TEXT_MODEL_PROVIDERS[textModelProviderId(providerId)].models;
}

export function modelCatalogEntry(providerId, modelId) {
  const normalized = clean(modelId).toLowerCase();
  if (!normalized) return null;
  return modelCatalogEntries(providerId)
    .find((entry) => entry.id.toLowerCase() === normalized) || null;
}

export function modelInputModalities(providerId, modelId) {
  return modelCatalogEntry(providerId, modelId)?.input || TEXT_INPUT;
}

export function modelInputModalitiesForRoute(route, modelId) {
  return modelInputModalities(textModelProviderForRoute(route), modelId);
}

export function modelSupportsImageInput(providerId, modelId) {
  return modelInputModalities(providerId, modelId).includes("image");
}
