import { SuzuCompanionCompactionEngine } from "./companion-compaction.mjs";
import { DEFAULT_SUZU_SOFTWARE_ASSISTANT_COMPACTION_PROMPT } from "./software-assistant-compaction-prompt.mjs";

export const name = "suzu-software-assistant-compaction";
export const inject = [];
export const Config = SuzuCompanionCompactionEngine.Config;

/**
 * The compaction transaction, model-aware safety guard, and retained-tail
 * behavior are exactly the same Agent Core mechanism used by normal chats.
 * Only the session's semantic checkpoint prompt changes: this is product
 * support, not a companion's relationship memory.
 */
export class SuzuSoftwareAssistantCompactionEngine extends SuzuCompanionCompactionEngine {
  async settingsFor(agent, mode, signal) {
    const settings = await super.settingsFor(agent, mode, signal);
    if (!settings) return null;
    return Object.freeze({
      ...settings,
      prompt: DEFAULT_SUZU_SOFTWARE_ASSISTANT_COMPACTION_PROMPT,
    });
  }
}

export function apply(ctx, config = {}) {
  ctx.plugin(SuzuSoftwareAssistantCompactionEngine, config);
}
