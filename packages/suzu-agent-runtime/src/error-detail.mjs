const DEFAULT_FALLBACK = "操作未完成。";
const DEFAULT_MAXIMUM_LENGTH = 1_200;
const MAX_CAUSE_DEPTH = 5;

function clean(value) {
  return String(value ?? "").trim();
}

function bounded(value, maximum) {
  const text = clean(value);
  if (!text || !Number.isFinite(maximum) || maximum <= 0) return "";
  return text.length > maximum ? `${text.slice(0, Math.max(0, maximum - 1))}…` : text;
}

function redactSensitiveText(value) {
  return clean(value)
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/giu, "$1[已隐藏]@")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/=:-]+/giu, "$1 [已隐藏]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret|password)=)[^&#\s]+/giu, "$1[已隐藏]")
    .replace(/((?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password|secret)\s*[:=]\s*["']?)[^\s,;"'\]\)}]+/giu, "$1[已隐藏]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[已隐藏]");
}

function errorMessage(value) {
  if (typeof value === "string") return redactSensitiveText(value);
  if (!value || typeof value !== "object") return "";
  return redactSensitiveText(value.message);
}

function errorCode(value) {
  const code = clean(value?.code);
  return /^[A-Za-z0-9_-]{1,80}$/u.test(code) ? code : "";
}

function addUnique(parts, value) {
  const text = clean(value);
  if (!text) return;
  const normalized = text.toLocaleLowerCase();
  if (parts.some((entry) => {
    const current = entry.toLocaleLowerCase();
    return current.includes(normalized) || normalized.includes(current);
  })) return;
  parts.push(text);
}

/**
 * Converts an Error (including nested `cause` values) into a compact message
 * that can cross Electron IPC safely. It preserves useful operational detail
 * while removing obvious credential values from provider or transport errors.
 */
export function formatErrorForDisplay(error, {
  fallback = DEFAULT_FALLBACK,
  maximumLength = DEFAULT_MAXIMUM_LENGTH,
} = {}) {
  const maximum = Number.isFinite(maximumLength) && maximumLength > 0
    ? Math.floor(maximumLength)
    : DEFAULT_MAXIMUM_LENGTH;
  const parts = [];
  const seen = new Set();
  let current = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth += 1) {
    if ((typeof current === "object" || typeof current === "function") && seen.has(current)) break;
    if (typeof current === "object" || typeof current === "function") seen.add(current);
    const message = errorMessage(current);
    if (message) addUnique(parts, message);
    else {
      const code = errorCode(current);
      if (code) addUnique(parts, `错误代码：${code}`);
    }
    current = typeof current === "object" || typeof current === "function" ? current.cause : null;
  }

  if (!parts.length) return bounded(redactSensitiveText(fallback) || DEFAULT_FALLBACK, maximum);
  const [primary, ...causes] = parts;
  return bounded(causes.length ? `${primary}（原因：${causes.join("；")}）` : primary, maximum);
}
