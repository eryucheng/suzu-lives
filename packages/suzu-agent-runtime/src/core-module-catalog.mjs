import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const BUNDLE_DIRECTORY = resolve(MODULE_DIRECTORY, "..", "vendor", "core", "modules");
const PRODUCT_CORE_MODULE_OVERRIDES = Object.freeze({
  // Imported pre-0.2 transcripts have no DSH step lifecycle around historical
  // assistant messages.  Keep their compatibility logic in owned source
  // instead of modifying the generated upstream bundle.
  "token-meter": resolve(MODULE_DIRECTORY, "token-meter-compat.mjs"),
});

/**
 * Product-owned names for the selected execution modules. This runtime map
 * deliberately contains no upstream package names: source provenance belongs
 * to the build-only audit catalog and generated third-party notices.
 */
export const SUZU_AGENT_CORE_MODULE_IDS = Object.freeze([
  "timer",
  "app-boot",
  "launch-environment",
  "llm",
  "session",
  "type-registry",
  "type-loader",
  "agent",
  "agent-default-model",
  "jobs-local",
  "llm-retry",
  "settings-file",
  "credentials",
  "credentials-local",
  "compatible-protocols",
  "session-persistence-jsonl",
  "attachment-local",
  "subprocess-local",
  "sandbox-local",
  "sandbox-policy",
  "bash-sandbox",
  "pwsh-sandbox",
  "user-approval",
  "permission-presets",
  "shell-environment",
  "filesystem-observation",
  "skill-catalog",
  "commands",
  "token-meter",
  "tools",
  "system-prompt",
  "agent-loop",
  "filesystem-sandbox",
  "deepseek-model",
  "agent-presets",
  "persona",
  "agent-instructions",
  "command-compact",
  "terminal-bash",
  "terminal-pwsh",
  "filesystem",
  "filesystem-search",
  "background-jobs",
  "skill-filesystem",
  "skill-tool",
  "compaction",
  "compaction-basic",
  "mcp-client",
]);

const MODULE_ID_SET = new Set(SUZU_AGENT_CORE_MODULE_IDS);

export const SUZU_AGENT_CORE_MODULE_PREFIX = "@suzu-lives/suzu-agent-runtime/core/";

function clean(value) {
  return String(value ?? "").trim();
}

export function suzuAgentCoreModuleId(value) {
  const source = clean(value);
  const id = source.startsWith(SUZU_AGENT_CORE_MODULE_PREFIX)
    ? source.slice(SUZU_AGENT_CORE_MODULE_PREFIX.length)
    : source;
  return MODULE_ID_SET.has(id) ? id : "";
}

export function suzuAgentCoreModuleSpecifier(value) {
  const id = suzuAgentCoreModuleId(value);
  if (!id) throw new Error(`未知的 Suzu Agent Core 模块：${clean(value) || "<空>"}。`);
  return `${SUZU_AGENT_CORE_MODULE_PREFIX}${id}`;
}

export function resolveSuzuAgentCoreModule(value) {
  const id = suzuAgentCoreModuleId(value);
  if (!id) throw new Error(`未知的 Suzu Agent Core 模块：${clean(value) || "<空>"}。`);
  const candidate = PRODUCT_CORE_MODULE_OVERRIDES[id] || resolve(BUNDLE_DIRECTORY, `${id}.mjs`);
  if (!existsSync(candidate)) throw new Error(`Suzu Agent Core 模块尚未构建：${id}。`);
  return candidate;
}
