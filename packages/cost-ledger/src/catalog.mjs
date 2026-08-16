import fs from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_CATALOG_PATH = fileURLToPath(
  new URL("../resources/default-prices.json", import.meta.url),
);

function clean(value) {
  return String(value ?? "").trim();
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function validDate(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

const CUSTOM_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,199}$/u;
const MAX_CUSTOM_PRICE_MODELS = 100;

const CUSTOM_RATE_DEFINITIONS = Object.freeze({
  inputTokens: Object.freeze({ label: "输入", unitLabel: "元 / 百万 Token", per: 1_000_000 }),
  outputTextTokens: Object.freeze({ label: "输出", unitLabel: "元 / 百万 Token", per: 1_000_000 }),
  inputUncachedTokens: Object.freeze({ label: "未缓存输入", unitLabel: "元 / 百万 Token", per: 1_000_000 }),
  inputCachedTokens: Object.freeze({ label: "缓存命中输入", unitLabel: "元 / 百万 Token", per: 1_000_000 }),
  inputCharacters: Object.freeze({ label: "输入字符", unitLabel: "元 / 万字符", per: 10_000 }),
  inputAudioSeconds: Object.freeze({ label: "输入音频时长", unitLabel: "元 / 秒", per: 1 }),
  imageRequests: Object.freeze({ label: "图片请求", unitLabel: "元 / 次", per: 1 }),
  generatedImages: Object.freeze({ label: "生成图片", unitLabel: "元 / 张", per: 1 }),
  generatedVoices: Object.freeze({ label: "成功创建音色", unitLabel: "元 / 个", per: 1 }),
});

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeCustomRateDefinitions(value) {
  const source = plainObject(value);
  const definitions = {};
  for (const [key, fallback] of Object.entries(CUSTOM_RATE_DEFINITIONS)) {
    const candidate = plainObject(source[key]);
    if (!Object.keys(candidate).length) continue;
    const per = finiteNonNegative(candidate.per);
    if (per === null || per <= 0) continue;
    definitions[key] = {
      label: clean(candidate.label).slice(0, 80) || fallback.label,
      unitLabel: clean(candidate.unitLabel).slice(0, 80) || fallback.unitLabel,
      per,
    };
  }
  return definitions;
}

export function normalizeModelId(value) {
  return clean(value).replace(/\[[^\]]+\]$/u, "").toLowerCase();
}

export function loadDefaultPriceCatalog() {
  return JSON.parse(fs.readFileSync(DEFAULT_CATALOG_PATH, "utf8").replace(/^\uFEFF/u, ""));
}

export const DEFAULT_PRICE_CATALOG = Object.freeze(loadDefaultPriceCatalog());

export function sanitizeCustomPriceModels(models, catalog = DEFAULT_PRICE_CATALOG) {
  if (!Array.isArray(models)) return [];
  const normalized = [];
  const seen = new Set();
  for (const value of models) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const modelId = normalizeModelId(value.modelId);
    if (!CUSTOM_MODEL_ID_PATTERN.test(modelId) || seen.has(modelId) || resolveCatalogModel(catalog, modelId)) continue;
    const rateDefinitions = normalizeCustomRateDefinitions(value.rateDefinitions);
    if (!Object.keys(rateDefinitions).length) continue;
    const rates = {};
    let complete = true;
    for (const key of Object.keys(rateDefinitions)) {
      const rate = finiteNonNegative(value.rates?.[key]);
      if (rate === null) {
        complete = false;
        break;
      }
      rates[key] = rate;
    }
    const effectiveFrom = validDate(value.effectiveFrom);
    if (!complete || !effectiveFrom) continue;
    seen.add(modelId);
    normalized.push({
      modelId,
      label: clean(value.label).slice(0, 120) || modelId,
      provider: clean(value.provider).slice(0, 120) || "自定义服务商",
      rateDefinitions,
      effectiveFrom,
      rates,
    });
    if (normalized.length >= MAX_CUSTOM_PRICE_MODELS) break;
  }
  return normalized;
}

export function createPriceCatalog({
  catalog = DEFAULT_PRICE_CATALOG,
  customPriceModels = [],
} = {}) {
  const models = { ...(catalog.models || {}) };
  for (const model of sanitizeCustomPriceModels(customPriceModels, catalog)) {
    models[model.modelId] = {
      label: model.label,
      provider: model.provider,
      currency: "CNY",
      aliases: [model.modelId],
      rateDefinitions: model.rateDefinitions,
      revisions: [{
        id: `user-created:${model.modelId}:${model.effectiveFrom}`,
        effectiveFrom: model.effectiveFrom,
        label: "用户新建的价格",
        rates: model.rates,
      }],
      userDefined: true,
    };
  }
  return {
    ...catalog,
    models,
  };
}

export function resolveCatalogModel(catalog, modelName) {
  const normalized = normalizeModelId(modelName);
  if (catalog?.models?.[normalized]) {
    return { id: normalized, model: catalog.models[normalized] };
  }
  for (const [id, model] of Object.entries(catalog?.models || {})) {
    const aliases = [id, ...(model.aliases || [])].map(normalizeModelId);
    if (aliases.includes(normalized)) return { id, model };
  }
  return null;
}

export function sanitizePriceRevisions(revisions, catalog = DEFAULT_PRICE_CATALOG) {
  if (!Array.isArray(revisions)) return [];
  const normalized = [];
  for (const value of revisions) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const modelId = normalizeModelId(value.modelId);
    const model = catalog.models?.[modelId];
    const effectiveFrom = validDate(value.effectiveFrom);
    if (!model || !effectiveFrom) continue;
    const rates = {};
    for (const key of Object.keys(model.rateDefinitions || {})) {
      const rate = finiteNonNegative(value.rates?.[key]);
      if (rate !== null) rates[key] = rate;
    }
    if (!Object.keys(rates).length) continue;
    normalized.push({
      id: clean(value.id) || `custom:${modelId}:${effectiveFrom}`,
      modelId,
      effectiveFrom,
      label: clean(value.label) || "软件内自定义价格",
      rates,
    });
  }
  normalized.sort((left, right) => (
    left.modelId.localeCompare(right.modelId)
    || left.effectiveFrom.localeCompare(right.effectiveFrom)
    || left.id.localeCompare(right.id)
  ));
  return normalized;
}

function revisionsForModel(modelId, model, customRevisions, catalog) {
  const defaults = (model.revisions || []).map((revision) => ({
    ...revision,
    effectiveFrom: validDate(revision.effectiveFrom),
    origin: "default",
  }));
  const custom = sanitizePriceRevisions(customRevisions, catalog)
    .filter((revision) => revision.modelId === modelId)
    .map((revision) => ({ ...revision, origin: "custom" }));
  return [...defaults, ...custom]
    .filter((revision) => revision.effectiveFrom)
    .sort((left, right) => (
      left.effectiveFrom.localeCompare(right.effectiveFrom)
      || (left.origin === "default" ? -1 : 1)
    ));
}

export function resolvePriceRevision({
  catalog = DEFAULT_PRICE_CATALOG,
  customRevisions = [],
  model: modelName,
  timestamp = new Date().toISOString(),
} = {}) {
  const resolved = resolveCatalogModel(catalog, modelName);
  if (!resolved) return null;
  const at = validDate(timestamp) || new Date().toISOString();
  const revisions = revisionsForModel(resolved.id, resolved.model, customRevisions, catalog);
  const applicable = revisions.filter((revision) => revision.effectiveFrom <= at);
  const selected = applicable.at(-1) || revisions[0];
  if (!selected) return null;

  const rates = {};
  for (const revision of revisions) {
    if (revision.effectiveFrom > selected.effectiveFrom) break;
    Object.assign(rates, revision.rates || {});
  }
  return {
    modelId: resolved.id,
    label: resolved.model.label,
    provider: resolved.model.provider,
    currency: resolved.model.currency,
    sourceUrl: resolved.model.sourceUrl,
    rateDefinitions: resolved.model.rateDefinitions,
    revisionId: selected.id,
    revisionLabel: selected.label,
    effectiveFrom: selected.effectiveFrom,
    origin: selected.origin,
    rates,
  };
}

export function priceCatalogView({
  catalog = DEFAULT_PRICE_CATALOG,
  customRevisions = [],
  timestamp = new Date().toISOString(),
} = {}) {
  const sanitized = sanitizePriceRevisions(customRevisions, catalog);
  return {
    schemaVersion: catalog.schemaVersion,
    updatedAt: catalog.updatedAt,
    models: Object.keys(catalog.models || {}).map((modelId) => {
      const model = catalog.models?.[modelId] || {};
      const active = resolvePriceRevision({
        catalog,
        customRevisions: sanitized,
        model: modelId,
        timestamp,
      });
      return {
        ...active,
        isUserDefined: model.userDefined === true,
        customRevisionCount: sanitized.filter((revision) => revision.modelId === modelId).length,
      };
    }),
  };
}
