import { createMessage } from "@suzu-lives/suzu-agent-runtime/core/llm";

export const SYSTEM_MESSAGE_PLACEMENTS = Object.freeze({
  PROMPT: "prompt",
  HISTORY_TAIL: "history-tail",
});

const SYSTEM_MESSAGE_PLACEMENT_SET = new Set(Object.values(SYSTEM_MESSAGE_PLACEMENTS));

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function messageText(message) {
  return (Array.isArray(plainObject(message).content) ? message.content : [])
    .filter((block) => plainObject(block).type === "text")
    .map((block) => String(plainObject(block).text ?? ""))
    .join("\n");
}

/** Creates an immutable request-only system instruction with Core message semantics. */
export function createSystemMessage(input) {
  return createMessage({ ...input, role: "system" });
}

export function createSystemMessageInjection({ message, placement } = {}) {
  if (plainObject(message).role !== "system") {
    throw new TypeError("system message injection requires a system message.");
  }
  if (!SYSTEM_MESSAGE_PLACEMENT_SET.has(placement)) {
    throw new TypeError(`unknown system message placement: ${String(placement ?? "")}.`);
  }
  if (!messageText(message)) {
    throw new TypeError("system message injection requires text content.");
  }
  return Object.freeze({ message, placement });
}

/**
 * Projects transient system messages into the two provider-neutral request
 * locations. Prompt messages precede durable history; history-tail messages
 * follow the latest projected conversation state.
 */
export function projectSystemMessageInjections({ system, messages = [] } = {}, injections = []) {
  const promptParts = typeof system === "string" && system.length ? [system] : [];
  const history = Array.isArray(messages) ? [...messages] : [];
  for (const injection of Array.isArray(injections) ? injections : []) {
    const candidate = plainObject(injection);
    const text = messageText(candidate.message);
    if (!text || !SYSTEM_MESSAGE_PLACEMENT_SET.has(candidate.placement)) continue;
    if (candidate.placement === SYSTEM_MESSAGE_PLACEMENTS.PROMPT) promptParts.push(text);
    else history.push(candidate.message);
  }
  return Object.freeze({
    ...(promptParts.length ? { system: promptParts.join("\n\n") } : {}),
    messages: Object.freeze(history),
  });
}
