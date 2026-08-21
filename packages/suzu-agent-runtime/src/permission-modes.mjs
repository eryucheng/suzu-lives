export const SUZU_AGENT_PERMISSION_MODES = Object.freeze([
  "danger-full-access",
  "workspace-write",
  "read-only",
]);

export const DEFAULT_SUZU_AGENT_PERMISSION_MODE = "danger-full-access";

export function isSuzuAgentPermissionMode(value) {
  return SUZU_AGENT_PERMISSION_MODES.includes(String(value ?? "").trim());
}

export function normalizeSuzuAgentPermissionMode(value) {
  const mode = String(value ?? "").trim();
  return isSuzuAgentPermissionMode(mode) ? mode : DEFAULT_SUZU_AGENT_PERMISSION_MODE;
}
