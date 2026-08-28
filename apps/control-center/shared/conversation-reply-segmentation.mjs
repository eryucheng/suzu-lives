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

/**
 * Apply the same reply segmentation to projected conversation blocks that the
 * chat renderer uses for assistant bubbles. Non-text blocks stay attached to
 * the closest preceding text segment.
 */
export function splitConversationReplyBlocks(value) {
  const blocks = Array.isArray(value) ? value : [];
  const segments = [[]];
  for (const block of blocks) {
    if (block?.kind !== "text") {
      segments.at(-1).push(block);
      continue;
    }
    const parts = splitConversationReplyBuffer(block.text, { final: true }).sentences;
    segments.at(-1).push(parts.length ? { ...block, text: parts[0] } : block);
    for (const text of parts.slice(1)) segments.push([{ ...block, text }]);
  }
  return segments.filter((segment) => segment.length);
}

function inlinePreview(value, limit = 500) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function mediaPreviewLabel(block) {
  if (block?.kind !== "media") return "";
  if (block.mediaKind === "sticker") return "[表情包]";
  if (block.mediaKind === "image") return "[图片]";
  if (block.mediaKind === "audio") return "[语音]";
  return "[文件]";
}

function previewForBlocks(blocks) {
  return inlinePreview((Array.isArray(blocks) ? blocks : [])
    .map((block) => block?.kind === "text" ? inlinePreview(block.text) : mediaPreviewLabel(block))
    .filter(Boolean)
    .join(" "));
}

/** Return the text represented by the final visible bubble of one message. */
export function conversationMessagePreview(message) {
  const blocks = Array.isArray(message?.blocks) ? message.blocks : [];
  const segments = message?.kind === "assistant" ? splitConversationReplyBlocks(blocks) : [blocks];
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const preview = previewForBlocks(segments[index]);
    if (preview) return preview;
  }
  return "";
}

/** Find the last human/assistant chat bubble and its original message time. */
export function latestConversationMessageSummary(messages) {
  const source = Array.isArray(messages) ? messages : [];
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const message = source[index];
    if (message?.kind !== "user" && message?.kind !== "assistant") continue;
    const preview = conversationMessagePreview(message);
    if (!preview) continue;
    return {
      preview,
      timestamp: String(message?.timestamp ?? "").trim(),
    };
  }
  return { preview: "", timestamp: "" };
}
