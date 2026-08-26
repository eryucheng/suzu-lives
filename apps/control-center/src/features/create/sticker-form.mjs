function clean(value) {
  return String(value ?? "").trim();
}

export function stickerMetadataFormIsEmpty(value = {}) {
  return !clean(value.name) && !clean(value.description) && !clean(value.keywords);
}
