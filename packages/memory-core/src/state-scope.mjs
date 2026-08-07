import { createHash } from "node:crypto";

export const ROOT_STATE_SCOPE_KEY = "root";
export const NON_STATE_SCOPE_KEY = "not_applicable";

function clean(value) {
  return String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function normalizedScopeValue(value) {
  if (typeof value === "string") return clean(value) || undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value.map(normalizedScopeValue).filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const entries = Object.keys(value).sort().flatMap((key) => {
    const normalized = normalizedScopeValue(value[key]);
    return normalized === undefined ? [] : [[clean(key), normalized]];
  }).filter(([key]) => key);
  if (new Set(entries.map(([key]) => key)).size !== entries.length) {
    throw new Error("Scoped state contains ambiguous normalized field names.");
  }
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function normalizeStateScope(scope) {
  const normalized = normalizedScopeValue(scope);
  if (!normalized || Array.isArray(normalized) || typeof normalized !== "object") {
    throw new Error("Scoped state requires a non-empty structured scope.");
  }
  return normalized;
}

export function isValidStateScopeKey(value) {
  const key = String(value ?? "").trim();
  return key === ROOT_STATE_SCOPE_KEY
    || key === NON_STATE_SCOPE_KEY
    || /^scope:[0-9a-f]{64}$/u.test(key);
}

export function stateScopeKeyFromScope(scope) {
  const normalized = normalizeStateScope(scope);
  const hash = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
  return `scope:${hash}`;
}

export function reportedStateScopeFromDraft(stateFamily, draft) {
  const family = clean(stateFamily);
  if (family === "preference") return normalizeStateScope(draft?.preferenceClaim?.scope);
  if (family === "disposition") return normalizeStateScope(draft?.dispositionClaim?.scope);
  throw new Error(`State family ${family || "(empty)"} does not support scoped exceptions.`);
}

export function reportedStateScopeKeyFromDraft(stateFamily, draft) {
  return stateScopeKeyFromScope(reportedStateScopeFromDraft(stateFamily, draft));
}
