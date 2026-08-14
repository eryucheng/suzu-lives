export function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

export function fileName(value) {
  return String(value || "").split(/[\\/]/u).filter(Boolean).at(-1) || "";
}

export function dateTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    : "尚无记录";
}

export function money(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return "未计价";
  const amount = Number(value);
  const precision = Math.abs(amount) >= 0.01 ? digits : 5;
  return `¥${amount.toLocaleString("zh-CN", { minimumFractionDigits: precision, maximumFractionDigits: precision })}`;
}

export function compactNumber(value) {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0));
}

export function localDateTimeInput(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function startOfTodayInput() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return localDateTimeInput(date);
}
