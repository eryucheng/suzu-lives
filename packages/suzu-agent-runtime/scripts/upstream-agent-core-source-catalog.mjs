/**
 * Build-only provenance catalog for Suzu Agent Core.
 *
 * The product runtime never imports this file. It is consumed solely by the
 * deterministic bundle build to locate the selected open-source inputs and
 * generate MANIFEST.json / THIRD_PARTY_NOTICES.md.
 */
export const SUZU_AGENT_CORE_SOURCE_ENTRIES = Object.freeze([
  Object.freeze({ id: "timer", sourcePackage: "@deepseek-ai/cordis-plugin-timer" }),
  Object.freeze({ id: "app-boot", sourcePackage: "@deepseek-ai/dsh-app-boot" }),
  Object.freeze({ id: "launch-environment", sourcePackage: "@deepseek-ai/dsh-launch-environment" }),
  Object.freeze({ id: "llm", sourcePackage: "@deepseek-ai/dsh-llm" }),
  Object.freeze({ id: "session", sourcePackage: "@deepseek-ai/dsh-session" }),
  Object.freeze({ id: "type-registry", sourcePackage: "@deepseek-ai/dsh-typert-registry" }),
  Object.freeze({ id: "type-loader", sourcePackage: "@deepseek-ai/dsh-typert-loader" }),
  Object.freeze({ id: "agent", sourcePackage: "@deepseek-ai/dsh-agent" }),
  Object.freeze({ id: "agent-default-model", sourcePackage: "@deepseek-ai/dsh-agent-default-model" }),
  Object.freeze({ id: "jobs-local", sourcePackage: "@deepseek-ai/dsh-jobs-local" }),
  Object.freeze({ id: "llm-retry", sourcePackage: "@deepseek-ai/dsh-llm-retry" }),
  Object.freeze({ id: "settings-file", sourcePackage: "@deepseek-ai/dsh-settings-file" }),
  Object.freeze({ id: "credentials", sourcePackage: "@deepseek-ai/dsh-credentials" }),
  Object.freeze({ id: "credentials-local", sourcePackage: "@deepseek-ai/dsh-credentials-local" }),
  Object.freeze({ id: "compatible-protocols", sourcePackage: "@deepseek-ai/dsh-llm-pi-ai" }),
  Object.freeze({ id: "session-persistence-jsonl", sourcePackage: "@deepseek-ai/dsh-session-persistence-jsonl" }),
  Object.freeze({ id: "attachment-local", sourcePackage: "@deepseek-ai/dsh-attachment-local" }),
  Object.freeze({ id: "subprocess-local", sourcePackage: "@deepseek-ai/dsh-subprocess-local" }),
  Object.freeze({ id: "sandbox-local", sourcePackage: "@deepseek-ai/dsh-sandbox-local" }),
  Object.freeze({ id: "sandbox-policy", sourcePackage: "@deepseek-ai/dsh-sandbox-policy" }),
  Object.freeze({ id: "bash-sandbox", sourcePackage: "@deepseek-ai/dsh-bash-sandbox" }),
  Object.freeze({ id: "pwsh-sandbox", sourcePackage: "@deepseek-ai/dsh-pwsh-sandbox" }),
  Object.freeze({ id: "user-approval", sourcePackage: "@deepseek-ai/dsh-user-approval" }),
  Object.freeze({ id: "permission-presets", sourcePackage: "@deepseek-ai/dsh-permission-presets" }),
  Object.freeze({ id: "shell-environment", sourcePackage: "@deepseek-ai/dsh-shell-env" }),
  Object.freeze({ id: "filesystem-observation", sourcePackage: "@deepseek-ai/dsh-fs-observation-policy" }),
  Object.freeze({ id: "skill-catalog", sourcePackage: "@deepseek-ai/dsh-skill" }),
  Object.freeze({ id: "commands", sourcePackage: "@deepseek-ai/dsh-commands" }),
  Object.freeze({ id: "token-meter", sourcePackage: "@deepseek-ai/dsh-token-meter" }),
  Object.freeze({ id: "tools", sourcePackage: "@deepseek-ai/dsh-tools" }),
  Object.freeze({ id: "system-prompt", sourcePackage: "@deepseek-ai/dsh-system-prompt" }),
  Object.freeze({ id: "agent-loop", sourcePackage: "@deepseek-ai/dsh-agent-loop" }),
  Object.freeze({ id: "filesystem-sandbox", sourcePackage: "@deepseek-ai/dsh-fs-sandbox" }),
  Object.freeze({ id: "deepseek-model", sourcePackage: "@deepseek-ai/dsh-llm-deepseek" }),
  Object.freeze({ id: "agent-presets", sourcePackage: "@deepseek-ai/dsh-agent-presets" }),
  Object.freeze({ id: "persona", sourcePackage: "@deepseek-ai/dsh-persona" }),
  Object.freeze({ id: "agent-instructions", sourcePackage: "@deepseek-ai/dsh-agent-instructions" }),
  Object.freeze({ id: "command-compact", sourcePackage: "@deepseek-ai/dsh-command-compact" }),
  Object.freeze({ id: "terminal-bash", sourcePackage: "@deepseek-ai/dsh-tool-bash" }),
  Object.freeze({ id: "terminal-pwsh", sourcePackage: "@deepseek-ai/dsh-tool-pwsh" }),
  Object.freeze({ id: "filesystem", sourcePackage: "@deepseek-ai/dsh-tool-fs" }),
  Object.freeze({ id: "filesystem-search", sourcePackage: "@deepseek-ai/dsh-tool-fs-search" }),
  Object.freeze({ id: "background-jobs", sourcePackage: "@deepseek-ai/dsh-tool-jobs" }),
  Object.freeze({ id: "skill-filesystem", sourcePackage: "@deepseek-ai/dsh-skill-filesystem" }),
  Object.freeze({ id: "skill-tool", sourcePackage: "@deepseek-ai/dsh-tool-skill" }),
  Object.freeze({ id: "compaction", sourcePackage: "@deepseek-ai/dsh-compaction" }),
  Object.freeze({ id: "compaction-basic", sourcePackage: "@deepseek-ai/dsh-compaction-basic" }),
  Object.freeze({ id: "mcp-client", sourcePackage: "@deepseek-ai/dsh-mcp-client" }),
]);

export function listSuzuAgentCoreSourceEntries() {
  return SUZU_AGENT_CORE_SOURCE_ENTRIES;
}
