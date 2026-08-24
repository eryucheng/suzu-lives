function markerText(value) {
  if (Array.isArray(value)) return value.map((item) => markerText(item)).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (value.content !== undefined) return markerText(value.content);
    return "";
  }
  return typeof value === "string" ? value : "";
}

export function isExactNoReply(value) {
  return markerText(value).trim().toUpperCase() === "NO_REPLY";
}

// Automatic tasks reserve NO_REPLY as a delivery-control marker. Providers
// sometimes put a parenthetical internal note after it, or before a trailing
// marker, so recognize it at either edge of the completed task text.
export function hasBoundaryNoReply(value) {
  const source = markerText(value).trim();
  if (!source) return false;
  return /^NO_REPLY(?=$|[\s,，。.!！?？;；、…（(\[])/iu.test(source)
    || /NO_REPLY(?:[\s,，。.!！?？;；、…]*NO_REPLY)*[\s,，。.!！?？;；、…]*$/iu.test(source);
}
