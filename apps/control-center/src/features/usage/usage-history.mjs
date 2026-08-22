const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function emptyTotal() {
  return {
    amountCny: 0,
    inputTokens: 0,
    knownRequestCount: 0,
    outputTokens: 0,
    requestCount: 0,
    unknownRequestCount: 0,
  };
}

function addTotal(target, value = {}) {
  for (const key of Object.keys(target)) target[key] += number(value[key]);
  return target;
}

function two(value) {
  return String(value).padStart(2, "0");
}

function dateKey(date) {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

function validDay(value) {
  const source = String(value || "");
  const match = source.match(DAY_PATTERN);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return dateKey(date) === source ? date : null;
}

function latestKnownDay(daily) {
  return [...daily]
    .map((item) => String(item?.date || ""))
    .filter((value) => validDay(value))
    .sort()
    .at(-1) || "";
}

function anchorDay(value, daily) {
  return validDay(value) || validDay(latestKnownDay(daily)) || new Date();
}

function dayKeys(anchor, count) {
  return Array.from({ length: count }, (_value, index) => {
    const date = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - index, 12);
    return dateKey(date);
  });
}

function monthKey(date) {
  return dateKey(date).slice(0, 7);
}

function monthKeys(anchor, count) {
  return Array.from({ length: count }, (_value, index) => monthKey(new Date(anchor.getFullYear(), anchor.getMonth() - index, 1, 12)));
}

function dailyTotals(summary = {}) {
  const totals = new Map();
  for (const item of Array.isArray(summary.daily) ? summary.daily : []) {
    const key = String(item?.date || "");
    if (!validDay(key)) continue;
    const current = totals.get(key) || emptyTotal();
    addTotal(current, item);
    totals.set(key, current);
  }
  return totals;
}

function monthlyTotals(daily) {
  const totals = new Map();
  for (const [day, value] of daily) {
    const key = day.slice(0, 7);
    const current = totals.get(key) || emptyTotal();
    addTotal(current, value);
    totals.set(key, current);
  }
  return totals;
}

function row(key, totals) {
  return { key, ...(totals.get(key) || emptyTotal()) };
}

/**
 * Creates zero-filled comparison rows from the product-owned, already daily
 * cost ledger summary. No secondary expense store is needed for the UI.
 */
export function usageHistoryRows(summary = {}, {
  anchor = "",
  dailyCount = 14,
  monthlyCount = 12,
  period = "daily",
} = {}) {
  const daily = dailyTotals(summary);
  const current = anchorDay(anchor, Array.isArray(summary.daily) ? summary.daily : []);
  if (period === "monthly") {
    const monthly = monthlyTotals(daily);
    const count = Number.isInteger(monthlyCount) && monthlyCount > 0 ? monthlyCount : 12;
    return monthKeys(current, count).map((key) => row(key, monthly));
  }
  const count = Number.isInteger(dailyCount) && dailyCount > 0 ? dailyCount : 14;
  return dayKeys(current, count).map((key) => row(key, daily));
}
