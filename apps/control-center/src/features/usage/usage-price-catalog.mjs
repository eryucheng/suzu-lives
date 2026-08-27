function clean(value) {
  return String(value ?? "").trim();
}

export function usageModelKey(value) {
  return clean(value).replace(/\[[^\]]+\]$/u, "").toLowerCase();
}

export function priceCatalogModelKeys(models = []) {
  return new Set((Array.isArray(models) ? models : []).flatMap((model) => (
    [model?.modelId, model?.label, ...(Array.isArray(model?.aliases) ? model.aliases : [])]
      .map(usageModelKey)
      .filter(Boolean)
  )));
}

export function usageEventModelKeys(event = {}) {
  return [event?.model, event?.priceRevision?.modelId]
    .map(usageModelKey)
    .filter(Boolean);
}

export function usedPriceCatalogModels(models = [], events = []) {
  const usedKeys = new Set(
    (Array.isArray(events) ? events : []).flatMap(usageEventModelKeys),
  );
  if (!usedKeys.size) return [];
  return (Array.isArray(models) ? models : []).filter((model) => (
    [model?.modelId, model?.label, ...(Array.isArray(model?.aliases) ? model.aliases : [])]
      .map(usageModelKey)
      .filter(Boolean)
      .some((key) => usedKeys.has(key))
  ));
}
