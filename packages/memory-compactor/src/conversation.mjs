function contentBlocks(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return Array.isArray(content) ? content : [];
}

const AUTOMATION_PROMPT_PREFIXES = Object.freeze([
  "链式关心。当前时间",
  "每日回顾。",
  "根据时间和前面聊的内容判断",
  "Base directory for this skill:",
]);

const ATTACHMENT_BRIDGE_PROMPT = /^Please analyze the attached image\(s\)\.\s*(?:\n+\(Images also saved locally:[\s\S]*\))?$/u;

function isLegacyProactivePrompt(text) {
  const asksForDecision = text.includes("检查当前时间和上文的对话内容")
    && text.includes("判断是否应该主动给")
    && text.includes("NO_REPLY");
  const chainsNextTimer = text.includes("链式主动关心机制")
    && text.includes("下一次触发")
    && text.includes("NO_REPLY")
    && /(?:timer add|定时器)/iu.test(text);
  return asksForDecision || chainsNextTimer;
}

function nestedText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(nestedText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  return nestedText(value.content);
}

function parseJsonObject(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

export function cleanConversationText(value) {
  return String(value || "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/giu, "")
    .replace(/<local-command-(?:caveat|stdout)>[\s\S]*?<\/local-command-(?:caveat|stdout)>/giu, "")
    .replace(/\n*Context:\s*```(?:json)?[\s\S]*?```\s*/giu, "\n")
    .replace(/\r\n/gu, "\n")
    .split("\n")
    .filter((line) => !/^\s*(?:课|course|count|test|发自我的\s*iPhone)\s*$/iu.test(line))
    .map((line) => line.replace(/[ \t]+$/gu, ""))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function isOperationalText(value) {
  const text = String(value || "").trim();
  return !text
    || /^NO_REPLY(?:\s*<\/tool>)?$/iu.test(text)
    || ATTACHMENT_BRIDGE_PROMPT.test(text)
    || /^API Error:\s*\d+/iu.test(text)
    || /^\d{3}\s+(?:Insufficient Balance|Unauthorized|Forbidden|Too Many Requests)\b/iu.test(text)
    || /^<task-notification>[\s\S]*<\/task-notification>$/iu.test(text)
    || text.includes("<command-name>")
    || /^<system-reminder>[\s\S]*<\/system-reminder>$/iu.test(text)
    || /^<local-command-(?:caveat|stdout)>/iu.test(text);
}

export function isAutomationPrompt(value) {
  const text = String(value || "").trim();
  return AUTOMATION_PROMPT_PREFIXES.some((prefix) => text.startsWith(prefix))
    || isLegacyProactivePrompt(text);
}

export function visibleUserText(entry) {
  const record = entry?.record || {};
  if (
    record.type !== "user"
    || record.message?.role !== "user"
    || record.isCompactSummary
    || record.isMeta
  ) return "";
  const blocks = contentBlocks(record.message.content);
  if (blocks.some((block) => block?.type === "tool_result")) return "";
  const text = cleanConversationText(blocks
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n"));
  return isOperationalText(text) ? "" : text;
}

export function visibleAssistantTexts(entry) {
  const record = entry?.record || {};
  if (
    record.type !== "assistant"
    || record.message?.role !== "assistant"
    || record.isCompactSummary
    || record.isMeta
  ) return [];
  const blocks = contentBlocks(record.message.content);
  const stoppedForTool = record.message?.stop_reason === "tool_use";
  return blocks
    .filter((block) => block?.type === "text")
    .map((block) => cleanConversationText(block.text))
    .filter((text) => !isOperationalText(text))
    .filter((text) => !(
      stoppedForTool
      && /^(?:I need to\b|Wait\b[\s\S]*\bLet me\b)/u.test(text)
    ));
}

function makeMessage(entry, role, speaker, text, sourceKind, ordinal) {
  const sourceUuid = entry.record.uuid;
  if (!sourceUuid || !text) return null;
  return {
    id: `${sourceUuid}:${sourceKind}:${ordinal}`,
    sourceUuid,
    sourceIndex: entry.index,
    timestamp: entry.record.timestamp || null,
    role,
    speaker,
    text,
    sourceKind,
  };
}

function boundedText(value, maximum = 1800) {
  const text = cleanConversationText(value);
  return text.length <= maximum ? text : `${text.slice(0, maximum).trimEnd()}……`;
}

function completedDouyinAction(result) {
  if (result?.intendedActionSkipped === true) return false;
  const status = result?.actionCompletedBeforeOwnerMessage === true
    ? result.actionResultStatus
    : result?.status;
  return ["ok", "sent"].includes(String(status || "").toLowerCase());
}

function douyinLabel(result, fallback = null) {
  const observation = result?.observation || fallback || {};
  const author = boundedText(observation.author, 80);
  const caption = boundedText(observation.caption, 140);
  if (caption && author) return `作品《${caption}》（${author}）`;
  if (caption) return `作品《${caption}》`;
  if (author) return `${author} 的作品`;
  return "当前作品";
}

function douyinToolMessages(entry, { userName, memoryOwner, state }) {
  const record = entry?.record || {};
  if (record.type !== "user" || record.message?.role !== "user") return [];
  const output = [];
  let ordinal = 0;
  for (const block of contentBlocks(record.message.content)) {
    if (block?.type !== "tool_result") continue;
    const result = parseJsonObject(nestedText(block.content));
    if (result?.site !== "douyin" || !result.action) continue;
    if (result.observation?.itemId && !["dm-check", "dm-reply"].includes(result.action)) {
      state.lastObservation = result.observation;
    }
    if (!completedDouyinAction(result)) continue;
    const label = douyinLabel(result, state.lastObservation);
    const summary = boundedText(result.understanding?.summary, 2200);
    let text = "";
    let role = "assistant";
    let sourceKind = "douyin_experience";
    if (result.action === "understand-current" && summary && summary !== "这个视频已经看到结尾了。") {
      text = `我在抖音认真看了${label}。内容是：${summary}`;
    } else if (result.action === "understand-shared" && summary && summary !== "这个视频已经看到结尾了。") {
      text = `我认真看了${userName}从抖音分享给我的${label}。内容是：${summary}`;
    } else if (result.action === "like" && result.changed === true && result.liked === true) {
      text = `我在抖音给${label}点了赞。`;
    } else if (result.action === "comment" && result.changed === true && result.deliveryConfirmed === true) {
      const comment = boundedText(result.text, 500);
      if (comment) text = `我在抖音的${label}下面评论：“${comment}”`;
    } else if (result.action === "share-current" && result.deliveryConfirmed === true) {
      text = `我把抖音里的${label}分享给了${userName}。`;
    } else if (result.action === "dm-reply" && result.deliveryConfirmed === true) {
      text = boundedText(result.text, 1800);
      sourceKind = "douyin_reply";
    }
    if (text) {
      const item = makeMessage(entry, role, memoryOwner, text, sourceKind, ordinal);
      ordinal += 1;
      if (item) output.push(item);
    }
    for (const message of result.ownerMessages || []) {
      const ownerText = boundedText(message?.text, 1800);
      if (!ownerText) continue;
      const identity = [message.kind || "text", message.itemId || "", message.capturedAt || "", ownerText].join("\0");
      if (state.ownerMessages.has(identity)) continue;
      state.ownerMessages.add(identity);
      const item = makeMessage(entry, "user", userName, ownerText, "douyin_owner_message", ordinal);
      ordinal += 1;
      if (item) output.push(item);
    }
  }
  return output;
}

export function standardizeCompactedPrefix({
  prefix,
  userName = "对方",
  memoryOwner = "我",
}) {
  const messages = [];
  let skipAutomationTurn = false;
  const douyinState = { lastObservation: null, ownerMessages: new Set() };
  for (const entry of prefix || []) {
    const userText = visibleUserText(entry);
    if (userText) {
      skipAutomationTurn = isAutomationPrompt(userText);
      if (!skipAutomationTurn) {
        const item = makeMessage(entry, "user", userName, userText, "user_text", 0);
        if (item) messages.push(item);
      }
      continue;
    }
    if (skipAutomationTurn) continue;
    const douyin = douyinToolMessages(entry, { userName, memoryOwner, state: douyinState });
    if (douyin.length) {
      messages.push(...douyin);
      continue;
    }
    visibleAssistantTexts(entry).forEach((text, ordinal) => {
      const item = makeMessage(entry, "assistant", memoryOwner, text, "assistant_text", ordinal);
      if (item) messages.push(item);
    });
  }
  return messages;
}
