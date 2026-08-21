import { compactNumber, money } from "../../core/formatters.mjs";

const USAGE_UNIT_FIELDS = Object.freeze([
  Object.freeze({ key: "totalInputTokens", label: "输入 Token" }),
  Object.freeze({ key: "totalTokens", label: "Token" }),
  Object.freeze({ key: "inputCharacters", label: "字符" }),
  Object.freeze({ key: "inputAudioSeconds", label: "秒", seconds: true }),
  Object.freeze({ key: "imageRequests", label: "张" }),
  Object.freeze({ key: "generatedVoices", label: "个音色" }),
  Object.freeze({ key: "inputTokens", label: "输入 Token" }),
  Object.freeze({ key: "outputTextTokens", label: "输出 Token" }),
]);

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function displayQuantity(value, field) {
  if (field.seconds) {
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 3 }).format(value);
  }
  return compactNumber(value);
}

export function usageAmountLabel(units = {}) {
  if (!units || typeof units !== "object" || Array.isArray(units)) return "—";
  for (const field of USAGE_UNIT_FIELDS) {
    const value = positiveNumber(units[field.key]);
    if (value) return `${displayQuantity(value, field)} ${field.label}`;
  }
  return "—";
}

export function usageCostLabel(event = {}) {
  if (event?.costStatus === "unknown-price") return "未配置价格";
  if (event?.amountCny === null || event?.amountCny === undefined) return "未计价";
  return money(event.amountCny);
}
