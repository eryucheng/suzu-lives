const CLAUDE_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
]);

export const DEFAULT_CLAUDE_PERMISSION_MODE = "acceptEdits";

function clean(value) {
  return String(value ?? "").trim();
}

/** Claude Code renamed the default UI label to Manual, while keeping default as an alias. */
export function normalizeClaudePermissionMode(value) {
  const mode = clean(value);
  if (mode === "manual") return "default";
  return CLAUDE_PERMISSION_MODES.has(mode) ? mode : DEFAULT_CLAUDE_PERMISSION_MODE;
}

export function isClaudePermissionMode(value) {
  const mode = clean(value);
  return mode === "manual" || CLAUDE_PERMISSION_MODES.has(mode);
}
