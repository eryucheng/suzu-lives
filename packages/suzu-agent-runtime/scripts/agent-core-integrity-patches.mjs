function replaceOne(source, pattern, replacement, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`Cannot apply Suzu Agent Core ${label} bundle patch: upstream layout changed.`);
  }
  const match = matches[0];
  return `${source.slice(0, match.index)}${replacement}${source.slice((match.index ?? 0) + match[0].length)}`;
}

function hasSessionAppendGuard(source) {
  return /adoptSessionEvent\(event(?:\s+as\s+SessionEvent(?:<[^>]+>)?)?\)\s*this\.surfaceManager\.validateNext\(event(?:\s+as\s+SessionEvent(?:<[^>]+>)?)?\)/u.test(source);
}

/**
 * Preserve tool-call identity across malformed streaming continuation chunks,
 * then validate message events at the write boundary. These patches deliberately
 * fail closed when upstream source moves so a future Core rebuild cannot silently
 * reintroduce history-corrupting behavior.
 */
export function applyAgentCoreIntegrityPatches(code, id) {
  let next = code;
  if (/[/\\]dsh-llm-deepseek[/\\]lib[/\\]index\.js$/u.test(id)) {
    next = replaceOne(
      next,
      /if\s*\(\s*call\.id\s*!==\s*(?:undefined|void\s+0)\s*\)\s*(?:\{\s*)?block\.callId\s*=\s*call\.id\s*;?\s*(?:\})?/gu,
      'if (typeof call.id === "string" && call.id.length > 0) block.callId = call.id;',
      "DeepSeek tool-call id",
    );
    next = replaceOne(
      next,
      /if\s*\(\s*call\.function\?\.name\s*!==\s*(?:undefined|void\s+0)\s*\)\s*(?:\{\s*)?block\.name\s*=\s*call\.function\.name\s*;?\s*(?:\})?/gu,
      'if (typeof call.function?.name === "string" && call.function.name.length > 0) block.name = call.function.name;',
      "DeepSeek tool-call name",
    );
  }
  if (/[/\\]dsh-llm[/\\]lib[/\\]index\.js$/u.test(id)) {
    next = replaceOne(
      next,
      /partial\.toolCallId\s*=\s*chunk\.id\s*;?/gu,
      'if (typeof chunk.id === "string" && chunk.id.length > 0) partial.toolCallId = chunk.id;',
      "stream assembler tool-call id",
    );
  }
  if (/[/\\]dsh-session[/\\]lib[/\\]index\.js$/u.test(id) && !hasSessionAppendGuard(next)) {
    if (!next.includes("adoptSessionEvent")) {
      throw new Error("Cannot apply Suzu Agent Core session write validation bundle patch: upstream validator is unavailable.");
    }
    next = replaceOne(
      next,
      /this\.surfaceManager\.validateNext\(event(?:\s+as\s+SessionEvent(?:<[^>]+>)?)?\)/gu,
      "adoptSessionEvent(event as SessionEvent)\n    this.surfaceManager.validateNext(event as SessionEvent)",
      "session write validation",
    );
  }
  return next;
}
