export const SUZU_AGENT_REASONING_EFFORTS = Object.freeze([
  "off",
  "low",
  "high",
  "max",
]);

export const DEFAULT_SUZU_AGENT_REASONING_EFFORT = "off";

const REASONING_EFFORT_RANKS = Object.freeze({
  none: 0,
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
});

export function isSuzuAgentReasoningEffort(value) {
  return SUZU_AGENT_REASONING_EFFORTS.includes(String(value ?? "").trim());
}

export function normalizeSuzuAgentReasoningEffort(value) {
  const effort = String(value ?? "").trim();
  return isSuzuAgentReasoningEffort(effort) ? effort : DEFAULT_SUZU_AGENT_REASONING_EFFORT;
}

export function adaptSuzuAgentReasoningEffort(value, supportedEfforts = []) {
  const desired = normalizeSuzuAgentReasoningEffort(value);
  const seen = new Set();
  const supported = (Array.isArray(supportedEfforts) ? supportedEfforts : [])
    .map((entry) => String(entry?.id ?? entry ?? "").trim().toLowerCase())
    .filter((effort) => effort && !seen.has(effort) && (seen.add(effort) || true));
  if (!supported.length) return "";
  if (supported.includes(desired)) return desired;
  if (desired === "off") {
    const disabled = supported.find((effort) => effort === "none" || effort === "off");
    if (disabled) return disabled;
  }
  const targetRank = REASONING_EFFORT_RANKS[desired];
  return supported
    .map((effort, index) => ({ effort, index, rank: REASONING_EFFORT_RANKS[effort] }))
    .filter((entry) => Number.isInteger(entry.rank) && entry.rank > 0)
    .sort((left, right) => Math.abs(left.rank - targetRank) - Math.abs(right.rank - targetRank)
      || left.rank - right.rank
      || left.index - right.index)[0]?.effort || "";
}
