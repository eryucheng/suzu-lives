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

export function normalizeModelId(value) {
  return clean(value).replace(/\[[^\]]+\]$/u, "").toLowerCase();
}

export function loadDefaultPriceCatalog() {
  return JSON.parse(fs.readFileSync(DEFAULT_CATALOG_PATH, "utf8").replace(/^\uFEFF/u, ""));
}

export const DEFAULT_PRICE_CATALOG = Object.freeze(loadDefaultPriceCatalog());

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

function revisionsForModel(modelId, model, customRevisions) {
  const defaults = (model.revisions || []).map((revision) => ({
    ...revision,
    effectiveFrom: validDate(revision.effectiveFrom),
    origin: "default",
  }));
  const custom = sanitizePriceRevisions(customRevisions)
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
  const revisions = revisionsForModel(resolved.id, resolved.model, customRevisions);
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
      const active = resolvePriceRevision({
        catalog,
        customRevisions: sanitized,
        model: modelId,
        timestamp,
      });
      return {
        ...active,
        customRevisionCount: sanitized.filter((revision) => revision.modelId === modelId).length,
      };
    }),
  };
}
