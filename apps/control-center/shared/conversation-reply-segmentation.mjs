const MARKDOWN_FORMATTING_PATTERN = /(?:^|\n) {0,3}(?:#{1,6}(?:\s|$)|[-*+]\s+|\d+[.)]\s+|>\s?|```|~~~)|(?:^|\n)\s*(?:[-*_]\s*){3,}$|(?:^|[^\\])(?:\*\*|__|~~|`|\*[^*\n]+\*|_[^_\n]+_)|\[[^\]\n]+\]\([^\s)]+(?:\s+["'][^"']*["'])?\)|(?<!\w)(?:https?:\/\/|www\.)\S+|(?:^|\n)\|?.+\|.+\|?\s*\n\|?\s*:?-{3,}/m;

export function hasConversationMarkdownFormatting(value) {
  return MARKDOWN_FORMATTING_PATTERN.test(String(value || ""));
}

function sentenceBoundaryEnd(text, index) {
  const character = text[index];
  if (character === "\n") {
    const blankLine = text.slice(index).match(/^\n[ \t]*\n+/u);
    return blankLine ? index + blankLine[0].length : 0;
  }

  let end = 0;
  if ("。！？!?…".includes(character)) {
    end = index + 1;
  } else if (character === ".") {
    if (text.startsWith("...", index)) {
      const next = text[index + 3] || "";
      if (!next || /\s/u.test(next) || "\"”’）)]}".includes(next)) end = index + 3;
    } else {
      const next = text[index + 1] || "";
      if (!next || /\s/u.test(next) || "\"”’）)]}".includes(next)) end = index + 1;
    }
  }
  if (!end) return 0;

  while (text[end] && "。！？!?…".includes(text[end])) end += 1;
  while (text[end] && "\"'”’）)]}".includes(text[end])) end += 1;
  return end;
}

function completedReplyEnd(text) {
  if (hasConversationMarkdownFormatting(text)) return 0;
  let start = 0;
  let inCodeFence = false;

  for (let index = 0; index < text.length; index += 1) {
    if (text.startsWith("```", index)) {
      inCodeFence = !inCodeFence;
      index += 2;
      continue;
    }
    if (inCodeFence) continue;
    const end = sentenceBoundaryEnd(text, index);
    if (!end) continue;
    start = end;
    index = end - 1;
  }
  return start;
}

/**
 * Return exactly the completed prefix of a live reply. Keeping this raw prefix
 * lets every consumer compare cumulative stream payloads without receiving the
 * unfinished token buffer.
 */
export function completedConversationReplyPrefix(value) {
  const text = String(value ?? "").replace(/\r\n?/gu, "\n");
  return text.slice(0, completedReplyEnd(text));
}

/**
 * Turn a companion reply into complete chat bubbles. Until `final` is set,
 * the unfinished tail is kept in `remainder` and never becomes a bubble.
 */
export function splitConversationReplyBuffer(value, { final = false } = {}) {
  const text = String(value ?? "").replace(/\r\n?/gu, "\n");
  if (hasConversationMarkdownFormatting(text)) {
    const markdown = text.trim();
    return {
      remainder: final ? "" : text,
      sentences: final && markdown ? [markdown] : [],
    };
  }
  const sentences = [];
  let start = 0;
  let inCodeFence = false;

  for (let index = 0; index < text.length; index += 1) {
    if (text.startsWith("```", index)) {
      inCodeFence = !inCodeFence;
      index += 2;
      continue;
    }
    if (inCodeFence) continue;
    const end = sentenceBoundaryEnd(text, index);
    if (!end) continue;
    const sentence = text.slice(start, text[index] === "\n" ? index : end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
    index = end - 1;
  }

  const remainder = text.slice(start);
  if (final && remainder.trim()) sentences.push(remainder.trim());
  return { remainder: final ? "" : remainder, sentences };
}
