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

// A scheduled turn reserves NO_REPLY as its terminal delivery marker. Some
// providers concatenate an earlier step or duplicate the marker, so do not
// require the whole completion to be exactly that one token.
export function hasTerminalNoReply(value) {
  const source = markerText(value).trim();
  return Boolean(source) && /NO_REPLY(?:[\s,，。.!！?？;；、…]*NO_REPLY)*[\s,，。.!！?？;；、…]*$/iu.test(source);
}
