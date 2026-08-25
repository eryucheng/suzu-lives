const FIELD_LIMITS = Object.freeze({
  description: 280,
  keyword: 32,
  keywords: 12,
  name: 80,
});

function clean(value, limit = FIELD_LIMITS.keyword) {
  return String(value ?? "").trim().replace(/\s+/gu, " ").slice(0, limit);
}

function list(value, limit = FIELD_LIMITS.keywords) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[，,、\n]/u)
      : [];
  const seen = new Set();
  return source.flatMap((item) => {
    const normalized = clean(item);
    const key = normalized.toLocaleLowerCase("zh-CN");
    if (!normalized || seen.has(key)) return [];
    seen.add(key);
    return [normalized];
  }).slice(0, limit);
}

function legacyKeywords(value) {
  const tags = value?.tags && typeof value.tags === "object" && !Array.isArray(value.tags) ? value.tags : {};
  const emotion = tags.emotion && typeof tags.emotion === "object" && !Array.isArray(tags.emotion) ? tags.emotion : {};
  return [
    ...list(tags.keywords),
    ...list(tags.intent),
    clean(emotion.primary),
    ...list(emotion.secondary),
    ...list(tags.action),
    ...list(tags.scene),
    ...list(tags.tone),
    clean(value?.visibleText),
  ];
}

export function emptyEmojiStickerMetadata() {
  return {
    description: "",
    keywords: [],
    name: "",
  };
}

export function normalizeEmojiStickerMetadata(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const keywords = list(source.keywords);
  return {
    description: clean(source.description, FIELD_LIMITS.description),
    keywords: keywords.length ? keywords : list(legacyKeywords(source)),
    name: clean(source.name, FIELD_LIMITS.name),
  };
}

export function emojiStickerMetadataNeedsInference(value = {}) {
  const metadata = normalizeEmojiStickerMetadata(value);
  return !metadata.name || !metadata.description || !metadata.keywords.length;
}

export function mergeEmojiStickerMetadataMissing(currentValue = {}, inferredValue = {}) {
  const current = normalizeEmojiStickerMetadata(currentValue);
  const inferred = normalizeEmojiStickerMetadata(inferredValue);
  return normalizeEmojiStickerMetadata({
    description: current.description || inferred.description,
    keywords: current.keywords.length ? current.keywords : inferred.keywords,
    name: current.name || inferred.name,
  });
}
