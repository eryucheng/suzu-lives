import path from "node:path";
import { pathToFileURL } from "node:url";

import { hasBoundaryNoReply, isExactNoReply } from "../../shared/agent-reply-markers.mjs";
import {
  conversationAttachmentReceipt,
  conversationMediaManifest,
  conversationMediaUnderstandingContext,
} from "./conversation-attachment-service.mjs";
import { createConversationMessageDeletionStore } from "./conversation-message-deletion-store.mjs";
import { visibleContactProjectsSnapshot } from "./contact-projects.mjs";
import { PROACTIVE_CONTACT_TURN_SOURCE } from "./proactive-contact-maintenance.mjs";

const MAX_MESSAGES = 500;
const HISTORY_PAGE_SIZE = 600;
// A conversation page is defined by what a person can see. Agent Core still
// stores stream and lifecycle records, so the reader may scan several raw
// event pages to assemble this one visible page.
const CHAT_HISTORY_EVENT_PAGE_SIZE = 100;
const CHAT_HISTORY_VISIBLE_MESSAGE_LIMIT = 100;
const CHAT_HISTORY_BACKFILL_PAGE_SIZE = 2_000;
const CHAT_HISTORY_INITIAL_MAX_EVENTS = 12_000;
const TRANSCRIPT_DISPLAY_DEFAULTS = Object.freeze({
  attachments: false,
  dynamicContext: false,
  tools: true,
  thinking: false,
  system: false,
  tokens: false,
});
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_CONVERSATION_ATTACHMENT_ITEMS = 24;
const VOICE_CALL_TURN_OPEN = "<suzu-voice-call-turn>";
const VOICE_CALL_TURN_CLOSE = "</suzu-voice-call-turn>";
const VOICE_CALL_OPEN_OPEN = "<suzu-voice-call-open>";
const VOICE_CALL_OPEN_CLOSE = "</suzu-voice-call-open>";
const SUZU_SCHEDULE_TASK_OPEN = "<suzu-schedule-task>";
const SUZU_SCHEDULE_TASK_CLOSE = "</suzu-schedule-task>";
const SUZU_LOCAL_ONLY_SCHEDULE_MARKER = "<!-- suzu-lives:display-system -->";
const SUZU_LIFECYCLE_BRIDGE_PLUGIN = "suzu-lifecycle-bridge";
const SUZU_LIFECYCLE_SNAPSHOT_FORM = "snapshot";
const LEGACY_CONVERSATION_DELETION_PLUGIN = "suzu-lives";
const LEGACY_CONVERSATION_DELETION_FORM = "message-deletion";
const AUTOMATION_TASK_CONTEXT_KIND = "automation-task";

function markerSource(content) {
  if (Array.isArray(content)) return content.map((block) => clean(block?.text)).filter(Boolean).join("\n");
  return String(content ?? "");
}

// Scheduled tasks are deliberately persisted in Agent Core so the model has a
// durable audit trail. They are product control input, however, not a message
// sent by the person. Keep the reserved envelope out of every human-facing
// projection, including old sessions created before this filter existed.
function isInternalSuzuScheduleTask(content) {
  const text = markerSource(content).trim();
  return text.startsWith(SUZU_SCHEDULE_TASK_OPEN) && text.endsWith(SUZU_SCHEDULE_TASK_CLOSE);
}

function isLocalOnlySuzuScheduleTask(content) {
  return isInternalSuzuScheduleTask(content)
    && markerSource(content).includes(SUZU_LOCAL_ONLY_SCHEDULE_MARKER);
}

function isDynamicContextSnapshot(source) {
  const snapshot = plainObject(source);
  return clean(snapshot.kind) === "plugin"
    && clean(snapshot.plugin) === SUZU_LIFECYCLE_BRIDGE_PLUGIN
    && clean(snapshot.form) === SUZU_LIFECYCLE_SNAPSHOT_FORM;
}

// Newer Agent Core tasks deliberately carry their body through a dynamic
// context snapshot rather than the legacy <suzu-schedule-task> envelope.
// The snapshot already persists the task kind and output policy, which is the
// durable information the human-facing projection needs to group the turn.
function dynamicAutomationTaskOutputPolicy(source) {
  const snapshot = plainObject(source);
  if (!isDynamicContextSnapshot(snapshot)) return "";
  const sections = Array.isArray(snapshot.sections) ? snapshot.sections : [];
  let found = false;
  for (const section of sections) {
    const candidate = plainObject(section);
    if (clean(candidate.kind) !== AUTOMATION_TASK_CONTEXT_KIND) continue;
    found = true;
    if (clean(plainObject(candidate.metadata).outputPolicy) === "silent") return "silent";
  }
  return found ? "external" : "";
}

function dynamicAutomationTaskScheduleSource(source) {
  const snapshot = plainObject(source);
  if (!isDynamicContextSnapshot(snapshot)) return "";
  const sections = Array.isArray(snapshot.sections) ? snapshot.sections : [];
  for (const section of sections) {
    const candidate = plainObject(section);
    if (clean(candidate.kind) !== AUTOMATION_TASK_CONTEXT_KIND) continue;
    return clean(plainObject(candidate.metadata).scheduleSource);
  }
  return "";
}

function dynamicAutomationTaskTurnKind(source) {
  const snapshot = plainObject(source);
  if (!isDynamicContextSnapshot(snapshot)) return "";
  const sections = Array.isArray(snapshot.sections) ? snapshot.sections : [];
  for (const section of sections) {
    const candidate = plainObject(section);
    if (clean(candidate.kind) !== AUTOMATION_TASK_CONTEXT_KIND) continue;
    return clean(plainObject(candidate.metadata).turnKind);
  }
  return "";
}

function automationTaskContextKey(block) {
  const source = plainObject(block);
  if (clean(source.kind) !== AUTOMATION_TASK_CONTEXT_KIND) return "";
  return clean(source.id) || clean(plainObject(source.metadata).taskId);
}

function dynamicAutomationTaskContextKey(message, source) {
  if (!isDynamicContextSnapshot(source)) return "";
  return contextBlocksFromMessage(message, source)
    .map(automationTaskContextKey)
    .find(Boolean) || "";
}

function silentTaskCleanupSequences(entries) {
  const sequences = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const event = historyEvent(entry);
    if (clean(event.type) !== "user/message") continue;
    const message = userMessageFromEvent(event);
    const source = plainObject(message.source);
    if (clean(source.kind) !== "plugin"
      || clean(source.plugin) !== SUZU_LIFECYCLE_BRIDGE_PLUGIN
      || clean(source.form) !== "task-cleanup") continue;
    for (const sequence of Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []) {
      const value = Number(sequence);
      if (Number.isSafeInteger(value) && value >= 0) sequences.add(value);
    }
  }
  return sequences;
}

function scopedAutomationTaskContextKey(taskKey, position) {
  const turn = Number(position?.turn);
  const scope = Number.isInteger(turn) ? `turn:${turn}` : "";
  if (!taskKey) return "";
  return scope ? `${scope}:${taskKey}` : taskKey;
}

function isSilentAgentReply(content, { terminal = false } = {}) {
  return terminal ? hasBoundaryNoReply(content) : isExactNoReply(content);
}

function scheduledTurnAssistantText(events) {
  return (Array.isArray(events) ? events : [])
    .filter((event) => clean(event?.type) === "assistant/message")
    .map((event) => markerSource(plainObject(plainObject(event).data).message?.content))
    .filter((value) => value.trim())
    .join("\n");
}

function scheduledTurnHasBoundaryNoReply(events) {
  const text = scheduledTurnAssistantText(events);
  return hasBoundaryNoReply(text);
}

function proactiveNoReplySystemMessage(turn) {
  if (clean(turn?.scheduleSource) !== PROACTIVE_CONTACT_TURN_SOURCE) return null;
  const text = scheduledTurnAssistantText(turn?.events);
  if (!hasBoundaryNoReply(text)) return null;
  const finalEvent = (Array.isArray(turn?.events) ? turn.events : [])
    .findLast((event) => clean(event?.type) === "assistant/message");
  if (!finalEvent) return null;
  const message = plainObject(plainObject(finalEvent.data).message);
  return {
    id: `${clean(message.id) || `agent-core:${finalEvent.seq}`}:system`,
    kind: "system",
    label: "主动关心",
    timestamp: isoTime(finalEvent.time),
    blocks: [{ kind: "text", text: bounded(text) }],
    usage: null,
    lineNumber: Number(finalEvent.seq) || 0,
  };
}

function markerJson(content, open, close) {
  const text = markerSource(content);
  const start = text.indexOf(open);
  const end = text.indexOf(close, start + open.length);
  if (start < 0 || end < 0) return null;
  const raw = text.slice(start + open.length, end).trim();
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function voiceCallTranscript(content) {
  const value = markerJson(content, VOICE_CALL_TURN_OPEN, VOICE_CALL_TURN_CLOSE);
  return value ? clean(value.transcript) : "";
}

function voiceCallOpening(content) {
  return markerJson(content, VOICE_CALL_OPEN_OPEN, VOICE_CALL_OPEN_CLOSE) !== null;
}

function usageToken(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

// Agent Core 以 camelCase TokenUsage（inputTokens / cacheReadTokens /
// cacheWriteTokens / outputTokens）发出用量；渲染层只认归一化后的
// input / cacheRead / output 形状，这里统一转换，避免 token 统计显示为 0。
function normalizeDisplayUsage(model, usage) {
  const source = plainObject(usage);
  const input = usageToken(source.inputTokens);
  const cacheCreation = usageToken(source.cacheWriteTokens);
  const cacheRead = usageToken(source.cacheReadTokens);
  const output = usageToken(source.outputTokens);
  if (input === null && cacheCreation === null && cacheRead === null && output === null) return null;
  const total = [input, cacheCreation, cacheRead, output].reduce((sum, value) => sum + (value || 0), 0);
  return {
    model: clean(model),
    input,
    cacheCreation,
    cacheRead,
    output,
    total,
  };
}

export class ConversationReaderError extends Error {
  constructor(message, { cause, code = "AGENT_CONVERSATION_READER_ERROR" } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ConversationReaderError";
    this.code = code;
  }
}


function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// The old reader fixtures stored every Agent Core event under `{ event }`,
// while the actual Core history RPC returns the event records directly.  Keep
// the reader tolerant of both transport shapes at its boundary: otherwise a
// successful persisted conversation is projected as an empty chat as soon as
// the UI reloads it (for example after switching contacts).
function historyEvent(entry) {
  const source = plainObject(entry);
  const wrapped = plainObject(source.event);
  return Object.keys(wrapped).length ? wrapped : source;
}

function historyEventSequence(entry) {
  const sequence = Number(historyEvent(entry).seq);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}

function historyPageMetadata(events, history, { limit = CHAT_HISTORY_EVENT_PAGE_SIZE } = {}) {
  const sequences = (Array.isArray(events) ? events : [])
    .map(historyEventSequence)
    .filter((sequence) => sequence !== null);
  const oldestEventSeq = sequences.length ? Math.min(...sequences) : null;
  return Object.freeze({
    eventCount: Array.isArray(events) ? events.length : 0,
    hasMore: history?.hasMore === true && oldestEventSeq !== null,
    limit,
    oldestEventSeq,
  });
}

function emptyHistoryPage({ limit = CHAT_HISTORY_EVENT_PAGE_SIZE } = {}) {
  return historyPageMetadata([], null, { limit });
}

function visibleTranscriptEntries(messages, value = {}) {
  const preferences = { ...TRANSCRIPT_DISPLAY_DEFAULTS, ...plainObject(value) };
  return (Array.isArray(messages) ? messages : []).flatMap((message, index) => {
    const kind = clean(message?.kind);
    if ((kind === "attachment" && !preferences.attachments)
      || (kind === "dynamic-context" && !preferences.dynamicContext)
      || (kind === "system" && !preferences.system)) return [];
    const visibleBlocks = (Array.isArray(message?.blocks) ? message.blocks : []).filter((block) => {
      if (clean(block?.kind) === "thinking") return preferences.thinking;
      const blockKind = clean(block?.kind);
      return !((blockKind === "tool_use" || blockKind === "tool_result") && !preferences.tools);
    });
    const visible = visibleBlocks.length > 0 || (kind === "assistant" && preferences.tokens && message?.usage);
    return visible ? [{ index, message }] : [];
  });
}

function visibleTranscriptPage(messages, preferences, { limit = CHAT_HISTORY_VISIBLE_MESSAGE_LIMIT } = {}) {
  const source = Array.isArray(messages) ? messages : [];
  const visible = visibleTranscriptEntries(source, preferences);
  if (visible.length <= limit) {
    return Object.freeze({
      messages: source,
      omittedVisibleMessages: false,
      oldestVisibleEventSeq: null,
    });
  }
  const firstVisible = visible.at(-limit);
  const oldestVisibleEventSeq = Number(firstVisible?.message?.lineNumber);
  return Object.freeze({
    messages: source.slice(Number(firstVisible?.index) || 0),
    omittedVisibleMessages: true,
    oldestVisibleEventSeq: Number.isSafeInteger(oldestVisibleEventSeq) && oldestVisibleEventSeq > 0
      ? oldestVisibleEventSeq
      : null,
  });
}

function visibleHistoryPageMetadata(events, history, page, { limit = CHAT_HISTORY_VISIBLE_MESSAGE_LIMIT } = {}) {
  const metadata = historyPageMetadata(events, history, { limit });
  const omittedVisibleMessages = page?.omittedVisibleMessages === true;
  const oldestVisibleEventSeq = Number(page?.oldestVisibleEventSeq);
  return Object.freeze({
    ...metadata,
    hasMore: metadata.hasMore || omittedVisibleMessages,
    ...(omittedVisibleMessages && Number.isSafeInteger(oldestVisibleEventSeq) && oldestVisibleEventSeq > 0
      ? { oldestEventSeq: oldestVisibleEventSeq }
      : {}),
  });
}

function historyPageValue(value = {}) {
  const source = plainObject(value);
  if (!Object.hasOwn(source, "beforeSeq")) return { beforeSeq: undefined };
  const beforeSeq = Number(source.beforeSeq);
  if (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0) {
    throw new ConversationReaderError("会话历史分页游标无效。", { code: "HISTORY_CURSOR_INVALID" });
  }
  return { beforeSeq };
}

function isSessionId(value) {
  return SESSION_ID_PATTERN.test(clean(value));
}

function projectScopeKey(value) {
  const source = clean(value);
  if (!source) return "";
  try {
    const normalized = source.replaceAll("\\", "/").replace(/\/+$/u, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  } catch {
    return "";
  }
}

function isoTime(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time < 0) return "";
  return new Date(time).toISOString();
}

function bounded(value, limit = 20_000) {
  const text = String(value ?? "");
  const suffix = "…";
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - suffix.length))}${suffix}` : text;
}

function contentText(content) {
  const blocks = Array.isArray(content) ? content : [];
  return blocks
    .filter((block) => plainObject(block).type === "text")
    .map((block) => bounded(block.text, 80).replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 80);
}

function publicContact(contact) {
  if (!contact || typeof contact !== "object") return null;
  const unreadCount = Number.isSafeInteger(contact.unreadCount) && contact.unreadCount >= 0 ? contact.unreadCount : 0;
  return {
    id: clean(contact.id),
    name: clean(contact.name),
    agentId: clean(contact.agentId),
    hidden: contact.hidden === true,
    muted: contact.muted === true,
    pinned: contact.pinned === true,
    unread: unreadCount > 0,
    unreadCount,
    longTermMemoryEnabled: contact.longTermMemoryEnabled !== false,
    permissionMode: clean(contact.permissionMode) || "danger-full-access",
    ...(clean(contact.updatedAt) ? { updatedAt: clean(contact.updatedAt) } : {}),
  };
}

function publicSession(session) {
  return {
    id: clean(session?.id),
    title: clean(session?.title) || "未命名对话",
    preview: clean(session?.preview) || "还没有可展示的消息",
    updatedAt: clean(session?.updatedAt),
    ...(clean(session?.createdAt) ? { createdAt: clean(session.createdAt) } : {}),
    ...(session?.draft === true ? { draft: true } : {}),
  };
}

function jsonDetail(value) {
  try { return bounded(JSON.stringify(value, null, 2), 4_000); }
  catch { return "[无法展示内容]"; }
}

function localMediaPath(value) {
  const source = clean(value);
  return source ? path.resolve(source) : "";
}

function normalizedMediaSize(value) {
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : 0;
}

function mediaBlockFromManifest(value, { source = "" } = {}) {
  const item = plainObject(value);
  const kind = clean(item.kind).toLowerCase();
  const size = normalizedMediaSize(item.size);
  const filePath = localMediaPath(item.path || item.filePath || item.savedPath);
  if (!new Set(["image", "audio", "file"]).has(kind) || !filePath) {
    return null;
  }
  const requestedSource = clean(item.mediaSource || source).toLowerCase();
  const normalizedSource = new Set(["mail", "sticker", "wechat"]).has(requestedSource)
    ? requestedSource
    : "";
  const fileName = path.basename(clean(item.fileName) || path.basename(filePath)).slice(0, 180) || path.basename(filePath);
  return {
    kind: "media",
    mediaKind: normalizedSource === "sticker" && kind === "image" ? "sticker" : kind,
    fileName,
    filePath,
    fileUrl: pathToFileURL(filePath).toString(),
    size,
    ...(normalizedSource ? { mediaSource: normalizedSource } : {}),
  };
}

function parsedObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const source = String(value ?? "").trim();
  if (!source) return null;
  const candidates = [source];
  const first = source.indexOf("{");
  const last = source.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(source.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Ordinary Agent Core tool output is not a Suzu attachment receipt.
    }
  }
  return null;
}

function attachmentReceiptBlocks(value, options = {}) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const block = plainObject(entry);
      if (typeof block.text === "string") return attachmentReceiptBlocks(block.text, options);
      if (block.content !== undefined) return attachmentReceiptBlocks(block.content, options);
      return attachmentReceiptBlocks(entry, options);
    });
  }
  const source = plainObject(value);
  if (typeof source.text === "string") return attachmentReceiptBlocks(source.text, options);
  if (source.content !== undefined && !Array.isArray(value)) return attachmentReceiptBlocks(source.content, options);
  const receipt = plainObject(parsedObject(value));
  if (clean(receipt.status) !== "ok" || clean(receipt.type) !== conversationAttachmentReceipt.type) return [];
  return (Array.isArray(receipt.items) ? receipt.items : [])
    .slice(0, MAX_CONVERSATION_ATTACHMENT_ITEMS)
    .map((item) => mediaBlockFromManifest(item, options))
    .filter(Boolean);
}

function directMediaKind(value) {
  const item = plainObject(value);
  const explicit = clean(item.mediaKind || item.kind).toLowerCase();
  if (new Set(["image", "audio", "file"]).has(explicit)) return explicit;
  const sourcePath = clean(item.savedPath || item.path || item.filePath);
  return clean(item.type) === "suzu-voice-audio" || path.extname(sourcePath).toLowerCase() === ".mp3"
    ? "audio"
    : "";
}

function directMediaBlocks(value, options = {}, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => directMediaBlocks(item, options, depth + 1));

  const item = plainObject(parsedObject(value));
  if (!Object.keys(item).length) return [];
  const kind = directMediaKind(item);
  const sourcePath = clean(item.savedPath || item.path || item.filePath);
  if (kind && sourcePath) {
    const block = mediaBlockFromManifest({
      kind,
      fileName: clean(item.fileName),
      path: sourcePath,
      size: item.size,
    }, options);
    return block ? [block] : [];
  }

  return [item.text, item.content, item.value, item.result, item.data]
    .flatMap((candidate) => directMediaBlocks(candidate, options, depth + 1));
}

function isInternalMediaUnderstandingContext(raw) {
  try {
    const value = JSON.parse(String(raw ?? "").trim());
    const data = plainObject(value);
    return data.version === 1
      && clean(data.source) === "suzu-lives-media-understanding"
      && Array.isArray(data.items);
  } catch {
    return false;
  }
}

// Image/video understanding is persisted with the user turn so Agent Core can
// reproduce the same reply after a restart. It is software-generated context,
// not text the person typed, so strip only a valid reserved-envelope shape
// before projecting a bubble. Malformed or ordinary user-authored markup stays
// visible as normal text.
function withoutInternalMediaUnderstandingContext(value) {
  const text = String(value ?? "");
  let cursor = 0;
  let visible = "";
  while (cursor < text.length) {
    const open = text.indexOf(conversationMediaUnderstandingContext.open, cursor);
    if (open < 0) {
      visible += text.slice(cursor);
      break;
    }
    const close = text.indexOf(
      conversationMediaUnderstandingContext.close,
      open + conversationMediaUnderstandingContext.open.length,
    );
    if (close < 0) {
      visible += text.slice(cursor);
      break;
    }
    const end = close + conversationMediaUnderstandingContext.close.length;
    const raw = text.slice(open + conversationMediaUnderstandingContext.open.length, close);
    if (!isInternalMediaUnderstandingContext(raw)) {
      visible += text.slice(cursor, end);
    } else {
      visible += text.slice(cursor, open);
    }
    cursor = end;
  }
  return visible;
}

function mediaBlocksFromText(value, options = {}) {
  const text = withoutInternalMediaUnderstandingContext(value);
  const output = [];
  let cursor = 0;
  let visible = "";
  let found = false;
  const flushText = () => {
    if (visible.trim()) output.push({ kind: "text", text: bounded(visible) });
    visible = "";
  };
  while (cursor < text.length) {
    const open = text.indexOf(conversationMediaManifest.open, cursor);
    if (open < 0) {
      visible += text.slice(cursor);
      break;
    }
    const close = text.indexOf(conversationMediaManifest.close, open + conversationMediaManifest.open.length);
    if (close < 0) {
      visible += text.slice(cursor);
      break;
    }
    const end = close + conversationMediaManifest.close.length;
    const raw = text.slice(open + conversationMediaManifest.open.length, close).trim();
    let manifest = null;
    try { manifest = JSON.parse(raw); } catch { /* Keep user-authored malformed markup as ordinary text. */ }
    const data = plainObject(manifest);
    const items = data.version === 1 && Array.isArray(data.items)
      ? data.items.slice(0, MAX_CONVERSATION_ATTACHMENT_ITEMS)
        .map((item) => mediaBlockFromManifest(item, { ...options, source: data.source }))
        .filter(Boolean)
      : [];
    if (!items.length) {
      visible += text.slice(cursor, end);
      cursor = end;
      continue;
    }
    visible += text.slice(cursor, open);
    flushText();
    output.push(...items);
    found = true;
    cursor = end;
  }
  flushText();
  return { blocks: output, hasMedia: found };
}

function blocksFromAgentCoreContent(value, options = {}) {
  const content = Array.isArray(value) ? value : [];
  const hasManifestMedia = content.some((item) => (
    clean(plainObject(item).type) === "text"
      && mediaBlocksFromText(plainObject(item).text, options).hasMedia
  ));
  return content.flatMap((item) => {
    const block = plainObject(item);
    const type = clean(block.type);
    if (type === "text" && typeof block.text === "string" && block.text) return mediaBlocksFromText(block.text, options).blocks;
    if (type === "reasoning" && typeof block.text === "string" && block.text) {
      return [{ kind: "thinking", text: bounded(block.text), preview: bounded(block.text, 80) }];
    }
    if (type === "tool-call") {
      return [{
        kind: "tool_use",
        name: clean(block.name) || "工具",
        summary: bounded(clean(block.arguments), 80),
        detail: bounded(clean(block.arguments) || "{}", 4_000),
      }];
    }
    if (type === "tool-result") {
      const attachments = attachmentReceiptBlocks(block.content, options);
      if (attachments.length) return attachments;
      const directMedia = directMediaBlocks(block.content, options);
      if (directMedia.length) return directMedia;
      const resultBlocks = blocksFromAgentCoreContent(block.content, options);
      const resultText = resultBlocks
        .map((entry) => clean(entry?.text || entry?.detail || entry?.summary))
        .filter(Boolean)
        .join("\n");
      return [{
        kind: "tool_result",
        error: block.isError === true,
        summary: bounded(resultText || "工具已返回结果", 80),
        detail: bounded(resultText || "[工具未返回可展示文本]", 4_000),
      }];
    }
    if (type === "image") return hasManifestMedia ? [] : [{ kind: "text", text: "[图片附件]" }];
    // Agent Core's block map is extensible. An unknown block is represented as a
    // detail row rather than silently omitted from the durable conversation.
    if (type) return [{ kind: "tool_result", error: false, summary: `Agent 内容：${type}`, detail: jsonDetail(block) }];
    return [];
  });
}

function userMessageFromEvent(event) {
  const data = plainObject(plainObject(event).data);
  const nestedMessage = plainObject(data.message);
  return Object.keys(nestedMessage).length ? nestedMessage : data;
}

function messageForEvent(event) {
  const type = clean(plainObject(event).type);
  if (type === "user/message") return userMessageFromEvent(event);
  if (type === "assistant/message") return plainObject(plainObject(event).data).message;
  return {};
}

function legacyDeletionTargetSequence(event) {
  if (clean(plainObject(event).type) !== "user/message") return -1;
  const source = plainObject(userMessageFromEvent(event).source);
  const target = Number(source.targetEventSeq);
  return clean(source.kind) === "plugin"
    && clean(source.plugin) === LEGACY_CONVERSATION_DELETION_PLUGIN
    && clean(source.form) === LEGACY_CONVERSATION_DELETION_FORM
    && Number.isSafeInteger(target)
    && target >= 0
    ? target
    : -1;
}

function deletedMessageSequences(entries, storedSequences = []) {
  const deleted = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const target = legacyDeletionTargetSequence(historyEvent(entry));
    if (target >= 0) deleted.add(target);
  }
  const values = storedSequences instanceof Set
    ? storedSequences
    : Array.isArray(storedSequences)
      ? storedSequences
      : [];
  for (const value of values) {
    const sequence = Number(value);
    if (Number.isSafeInteger(sequence) && sequence >= 0) deleted.add(sequence);
  }
  return deleted;
}

function contextDisplay(value, kind) {
  const source = value === false
    ? { context: false, transcript: false }
    : value === true
      ? { context: true, transcript: true }
      : plainObject(value);
  const category = clean(source.category) || kind;
  const label = clean(source.label);
  return Object.freeze({
    context: source.context !== false,
    transcript: source.transcript === true,
    ...(category ? { category } : {}),
    ...(label ? { label } : {}),
  });
}

function contextBlocksFromMessage(message, messageSource) {
  const source = plainObject(messageSource);
  const sections = Array.isArray(source.sections) ? source.sections : [];
  if (sections.length) {
    return sections.flatMap((value, index) => {
      const section = plainObject(value);
      const text = String(section.text ?? "");
      if (!text.trim()) return [];
      const kind = clean(section.kind) || "context";
      return [Object.freeze({
        id: clean(section.id || section.name) || `${clean(message?.id) || "context"}:${index + 1}`,
        kind,
        display: contextDisplay(section.display, kind),
        metadata: Object.freeze({ ...plainObject(section.metadata) }),
        priority: Number.isFinite(section.priority) ? Number(section.priority) : 0,
        source: clean(section.source) || clean(source.plugin) || "plugin",
        text: bounded(text),
      })];
    });
  }

  const details = plainObject(source.block);
  const kind = clean(details.kind) || clean(source.form) || "context";
  const blocks = blocksFromAgentCoreContent(message?.content)
    .map((block) => clean(block.text || block.detail || block.summary))
    .filter(Boolean);
  return blocks.map((text, index) => Object.freeze({
    id: clean(details.id) || `${clean(message?.id) || "context"}:${index + 1}`,
    kind,
    display: contextDisplay(details.display, kind),
    metadata: Object.freeze({ ...plainObject(details.metadata) }),
    priority: Number.isFinite(details.priority) ? Number(details.priority) : 0,
    source: clean(details.source) || clean(source.plugin) || "plugin",
    text: bounded(text),
  }));
}

function stepPosition(value) {
  const source = plainObject(value);
  return Number.isInteger(source.turn) && Number.isInteger(source.step)
    ? Object.freeze({ turn: source.turn, step: source.step })
    : null;
}

function positionKey(value) {
  return Number.isInteger(value?.turn) && Number.isInteger(value?.step)
    ? `${value.turn}:${value.step}`
    : "";
}

function eventSequence(event) {
  const sequence = Number(plainObject(event).seq);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0;
}

function optionalEventSequence(event) {
  const sequence = Number(plainObject(event).seq);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : -1;
}

function expiredContextSequences(entries) {
  const expired = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const event = historyEvent(entry);
    if (clean(event.type) !== "assistant/message") continue;
    if (plainObject(event.surfaceOp).op !== "replace") continue;
    for (const sequence of Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []) {
      if (Number.isSafeInteger(sequence) && sequence >= 0) expired.add(sequence);
    }
  }
  return expired;
}

/**
 * Builds an inspectable context view from the same Agent Core history that feeds the
 * normal chat projection. Plugin context stays out of ordinary bubbles unless
 * the originating block explicitly opts into `display.transcript`.
 */
export function conversationContextRecords(entries, maxRecords = HISTORY_PAGE_SIZE, options = {}) {
  const sourceEntries = Array.isArray(entries) ? entries : [];
  const expiredSequences = expiredContextSequences(sourceEntries);
  const deletedSequences = deletedMessageSequences(sourceEntries, options?.deletedEventSequences);
  const directMessagesByStep = new Map();
  const recordedAutomationTaskContexts = new Set();
  const records = [];
  let currentPosition = null;

  for (const entry of sourceEntries) {
    const event = historyEvent(entry);
    const sequence = optionalEventSequence(event);
    if (sequence >= 0 && (deletedSequences.has(sequence) || legacyDeletionTargetSequence(event) >= 0)) continue;
    const type = clean(event.type);
    if (type === "step/start") {
      currentPosition = stepPosition(event.data) || currentPosition;
      continue;
    }
    if (type !== "user/message") continue;
    const message = userMessageFromEvent(event);
    const messageSource = plainObject(message.source);
    const key = positionKey(currentPosition);
    if (clean(messageSource.kind) === "user") {
      if (key) {
        const direct = directMessagesByStep.get(key) || [];
        direct.push(Object.freeze({ id: clean(message.id), sequence: eventSequence(event) }));
        directMessagesByStep.set(key, direct);
      }
      continue;
    }
    if (clean(messageSource.kind) !== "plugin") continue;

    const blocks = contextBlocksFromMessage(message, messageSource)
      .filter((block) => {
        if (!block.display.context) return false;
        const taskKey = scopedAutomationTaskContextKey(automationTaskContextKey(block), currentPosition);
        if (!taskKey) return true;
        if (recordedAutomationTaskContexts.has(taskKey)) return false;
        recordedAutomationTaskContexts.add(taskKey);
        return true;
      });
    if (!blocks.length) continue;
    const form = clean(messageSource.form);
    const dynamic = form === "snapshot";
    records.push(Object.freeze({
      id: clean(message.id) || `context:${eventSequence(event)}`,
      eventSeq: eventSequence(event),
      timestamp: isoTime(event.time),
      ...(currentPosition ? { turn: currentPosition.turn, step: currentPosition.step } : {}),
      form: form || "context",
      plugin: clean(messageSource.plugin) || "plugin",
      scope: dynamic ? "dynamic" : "durable",
      status: dynamic && expiredSequences.has(eventSequence(event)) ? "expired" : "recorded",
      blocks: Object.freeze(blocks),
    }));
  }

  const anchored = records.map((record) => {
    const direct = directMessagesByStep.get(positionKey(record)) || [];
    if (!direct.length) return record;
    const anchor = record.scope === "dynamic"
      ? direct.find((candidate) => candidate.sequence >= record.eventSeq) || direct.at(-1)
      : direct.at(-1);
    return Object.freeze({ ...record, ...(anchor?.id ? { messageId: anchor.id } : {}) });
  });
  const maximum = Number.isSafeInteger(maxRecords) && maxRecords > 0 ? maxRecords : HISTORY_PAGE_SIZE;
  return Object.freeze(anchored.slice(-maximum));
}

function dynamicContextDiagnosticMessage(event, { omittedAutomationTaskContexts = new Set() } = {}) {
  const source = plainObject(event);
  if (clean(source.type) !== "user/message") return null;
  const message = userMessageFromEvent(source);
  const messageSource = plainObject(message.source);
  if (!isDynamicContextSnapshot(messageSource)) return null;
  const contextBlocks = contextBlocksFromMessage(message, messageSource)
    .filter((block) => !omittedAutomationTaskContexts.has(automationTaskContextKey(block)));
  if (!contextBlocks.length) return null;
  return {
    id: `${clean(message.id) || `agent-core:${source.seq}`}:dynamic-context`,
    kind: "dynamic-context",
    label: "动态上下文",
    timestamp: isoTime(source.time),
    blocks: [{
      kind: "text",
      text: contextBlocks.map((block) => (
        `【${clean(block.display?.label) || clean(block.kind) || "上下文"}】\n${block.text}`
      )).join("\n\n"),
    }],
    usage: null,
    lineNumber: Number(source.seq) || 0,
  };
}

function surfaceMessage(event, options = {}) {
  const source = plainObject(event);
  const data = plainObject(source.data);
  const type = clean(source.type);
  const timestamp = isoTime(source.time);
  if (type === "user/message") {
    // Agent Core persists a user message directly in `event.data`, unlike an
    // assistant message which is nested under `event.data.message`.  Keep the
    // nested form as a compatibility fallback for older test fixtures and
    // future adapters, but do not drop the canonical user event: dropping it
    // makes the renderer append its local pending bubble after the assistant
    // reply.
    const message = userMessageFromEvent(source);
    if (isInternalSuzuScheduleTask(message.content)) return null;
    // Plugin-injected context is model input, not something a human said.
    const messageSource = plainObject(message.source);
    if (clean(messageSource.kind) === "plugin") {
      const contextBlocks = contextBlocksFromMessage(message, messageSource);
      const blocks = contextBlocks
        .filter((block) => block.display.transcript)
        .map((block) => ({ kind: "text", text: block.text }));
      return blocks.length ? {
        id: clean(message.id) || `agent-core:${source.seq}`,
        kind: "system",
        label: clean(contextBlocks.find((block) => block.display.transcript)?.display?.label) || "上下文",
        timestamp,
        blocks,
        usage: null,
        lineNumber: Number(source.seq) || 0,
      } : null;
    }
    if (clean(messageSource.kind) !== "user") return null;
    // Voice-call transport markers are not sentences the person typed.  A
    // connected-line marker is skipped entirely; a spoken transcript is
    // rendered as a centered system message like the v1 conversation reader.
    if (voiceCallOpening(message.content)) return null;
    const transcript = voiceCallTranscript(message.content);
    if (transcript) {
      return {
        id: clean(message.id) || `agent-core:${source.seq}`,
        kind: "system",
        label: "",
        timestamp,
        blocks: [{ kind: "text", text: `通话 · 我：${bounded(transcript)}` }],
        usage: null,
        lineNumber: Number(source.seq) || 0,
      };
    }
    const blocks = blocksFromAgentCoreContent(message.content, options);
    return blocks.length ? {
      id: clean(message.id) || `agent-core:${source.seq}`,
      kind: "user",
      label: "",
      timestamp,
      blocks,
      usage: null,
      lineNumber: Number(source.seq) || 0,
    } : null;
  }
  if (type === "assistant/message") {
    const message = plainObject(data.message);
    if (isSilentAgentReply(message.content, { terminal: options?.scheduled === true })) return null;
    const blocks = blocksFromAgentCoreContent(message.content, options)
      // A background schedule may take several model/tool steps. Its final
      // assistant message is the only human-facing part of that whole turn.
      // Native reasoning or tool blocks in it are not chat messages.
      .filter((block) => options?.scheduled !== true || ["text", "media"].includes(block.kind));
    if (!blocks.length) return null;
    const inCall = options?.inVoiceCall === true;
    return {
      id: clean(message.id) || `agent-core:${source.seq}`,
      kind: inCall ? "system" : "assistant",
      label: "",
      timestamp,
      blocks: inCall ? [{ kind: "text", text: `通话 · 对方：${bounded(textForMessage({ blocks }))}` }] : blocks,
      usage: normalizeDisplayUsage(message.model, data.usage),
      lineNumber: Number(source.seq) || 0,
    };
  }
  if (type === "tool/result") {
    const message = plainObject(data.message);
    const attachments = attachmentReceiptBlocks(message.content, options);
    const directMedia = attachments.length ? attachments : directMediaBlocks(message.content, options);
    if (directMedia.length) return {
      id: `agent-core:${source.seq}`,
      kind: "assistant",
      label: "",
      timestamp,
      blocks: directMedia,
      usage: null,
      lineNumber: Number(source.seq) || 0,
    };
    const blocks = blocksFromAgentCoreContent(message.content, options);
    return blocks.length ? {
      id: `agent-core:${source.seq}`,
      kind: "system",
      label: "工具结果",
      timestamp,
      blocks,
      usage: null,
      lineNumber: Number(source.seq) || 0,
    } : null;
  }
  return null;
}

export function conversationDisplayMessages(entries, maxMessages = MAX_MESSAGES, options = {}) {
  const sourceEntries = Array.isArray(entries) ? entries : [];
  const deletedSequences = deletedMessageSequences(sourceEntries, options?.deletedEventSequences);
  const hiddenTaskSequences = silentTaskCleanupSequences(sourceEntries);
  const transcript = [];
  const includeDynamicContext = options?.includeDynamicContext === true;
  const displayedAutomationTaskContexts = new Set();
  let currentPosition = null;
  // A voice-call turn is transport-level: its transcript and the assistant
  // reply both render as centered system messages, like the v1 reader.
  let inVoiceCall = false;
  // Agent Core persists a whole scheduled turn (including intermediate model
  // steps and tool results). Buffer it until its terminal event: proactive
  // NO_REPLY output becomes a system diagnostic, while a visible proactive
  // reply must not expose the scheduling mechanics that led to it.
  let scheduledTurn = null;
  const flushScheduledTurn = () => {
    const pending = scheduledTurn;
    scheduledTurn = null;
    if (!pending) return;
    const noReplySystemMessage = proactiveNoReplySystemMessage(pending);
    if (noReplySystemMessage) {
      transcript.push(noReplySystemMessage);
      return;
    }
    if (pending.localOnly || scheduledTurnHasBoundaryNoReply(pending.events)) return;
    const finalAssistantEvent = pending.events.findLast((event) => clean(event.type) === "assistant/message");
    if (!finalAssistantEvent) return;
    const message = surfaceMessage(finalAssistantEvent, { ...options, inVoiceCall, scheduled: true });
    if (message) transcript.push(message);
  };
  for (const entry of sourceEntries) {
    const event = historyEvent(entry);
    const sequence = optionalEventSequence(event);
    const hiddenTaskSequence = sequence >= 0 && hiddenTaskSequences.has(sequence);
    if (sequence >= 0 && (deletedSequences.has(sequence)
      || legacyDeletionTargetSequence(event) >= 0)) continue;
    const type = clean(event.type);
    if (type === "step/start") {
      currentPosition = stepPosition(event.data) || currentPosition;
      continue;
    }
    // turn/end is not a surface event, but it is the reliable boundary that
    // lets us decide whether a scheduled turn had an external reply.
    if (type === "turn/end") {
      flushScheduledTurn();
      currentPosition = null;
      continue;
    }
    if (!new Set(["user/message", "assistant/message", "tool/result"]).has(type)) continue;
    // Agent Core surface replacements are deliberately model-only: a compacted
    // checkpoint replaces older context for the next model request, but must
    // never erase messages a person already saw.  Append-origin events are the
    // documented durable source of a human transcript.
    if (event.surfaceOp !== "append") continue;
    if (type === "user/message") {
      const userMessage = plainObject(userMessageFromEvent(event));
      const content = userMessage.content;
      const messageSource = plainObject(userMessage.source);
      const dynamicTaskPolicy = dynamicAutomationTaskOutputPolicy(messageSource);
      const dynamicTaskScheduleSource = dynamicAutomationTaskScheduleSource(messageSource);
      const dynamicTaskTurnKind = dynamicAutomationTaskTurnKind(messageSource);
      const automationTaskContext = dynamicAutomationTaskContextKey(userMessage, messageSource);
      const scheduledAutomationTaskContext = scopedAutomationTaskContextKey(
        automationTaskContext,
        currentPosition,
      );
      const repeatedAutomationTaskContext = Boolean(
        scheduledAutomationTaskContext && displayedAutomationTaskContexts.has(scheduledAutomationTaskContext)
      );
      if (scheduledAutomationTaskContext) displayedAutomationTaskContexts.add(scheduledAutomationTaskContext);
      const omittedAutomationTaskContexts = repeatedAutomationTaskContext
        ? new Set([automationTaskContext])
        : new Set();
      if (isInternalSuzuScheduleTask(content) || dynamicTaskPolicy) {
        const continuesScheduledTurn = Boolean(
          dynamicTaskPolicy
            && scheduledAutomationTaskContext
            && scheduledTurn?.automationTaskContext === scheduledAutomationTaskContext
        );
        // A legacy fixture may not contain turn/end; a following schedule
        // request still establishes a safe boundary for the prior one.
        if (!continuesScheduledTurn) flushScheduledTurn();
        // The task itself is invisible control input, but it marks a durable
        // transport boundary. Its reply must render as ordinary chat rather
        // than inherit the preceding voice-call presentation.
        if (dynamicTaskTurnKind === "call-ended") inVoiceCall = false;
        const diagnostic = includeDynamicContext
          ? dynamicContextDiagnosticMessage(event, { omittedAutomationTaskContexts })
          : null;
        // Diagnostics are intentionally projected as a separate, opt-in row.
        // They remain out of normal chat bubbles and never make NO_REPLY or
        // task-control text look like an assistant reply.
        if (diagnostic) transcript.push(diagnostic);
        if (!continuesScheduledTurn) {
          scheduledTurn = {
            automationTaskContext: scheduledAutomationTaskContext,
            scheduleSource: dynamicTaskScheduleSource,
            localOnly: isInternalSuzuScheduleTask(content)
              ? isLocalOnlySuzuScheduleTask(content)
              : dynamicTaskPolicy === "silent",
            events: [],
          };
        }
        continue;
      }
      if (hiddenTaskSequence) continue;
      const diagnostic = includeDynamicContext
        ? dynamicContextDiagnosticMessage(event, { omittedAutomationTaskContexts })
        : null;
      if (diagnostic) transcript.push(diagnostic);
      // Plugin context is model-only input inside the active schedule. It is
      // neither a new human turn nor something to render.
      if (scheduledTurn && clean(messageSource.kind) !== "user") continue;
      flushScheduledTurn();
      if (voiceCallOpening(content) || voiceCallTranscript(content)) {
        inVoiceCall = true;
      } else if (clean(messageSource.kind) === "user") {
        inVoiceCall = false;
      }
    }
    if (hiddenTaskSequence && !scheduledTurn) continue;
    if (scheduledTurn && (type === "assistant/message" || type === "tool/result")) {
      scheduledTurn.events.push(event);
      continue;
    }
    const message = surfaceMessage(event, { ...options, inVoiceCall });
    if (message) transcript.push(message);
  }
  flushScheduledTurn();
  const maximum = Number.isSafeInteger(maxMessages) && maxMessages > 0 ? maxMessages : MAX_MESSAGES;
  // Diagnostics are opt-in and must not shrink the durable human transcript
  // merely because every model step injected a dynamic snapshot.
  const ordinaryIndexes = transcript.flatMap((message, index) => (
    message.kind === "dynamic-context" ? [] : [index]
  ));
  const cutoff = ordinaryIndexes.length > maximum ? ordinaryIndexes.at(-maximum) : 0;
  return transcript.slice(cutoff);
}

function searchRequest(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : { query: value };
  const category = ["messages", "images", "files", "audio", "links", "date"].includes(clean(source.category))
    ? clean(source.category)
    : "messages";
  return { category, query: clean(source.query) };
}

function textForMessage(message) {
  return (Array.isArray(message?.blocks) ? message.blocks : [])
    .map((block) => clean(block?.text || block?.summary || block?.detail))
    .filter(Boolean)
    .join("\n");
}

function textForCoreEvent(event, options = {}) {
  const message = messageForEvent(event);
  return textForMessage({
    blocks: blocksFromAgentCoreContent(message.content, options),
  });
}

function turnIdsByEventSequence(entries) {
  const result = new Map();
  const turns = new Map();
  const pendingTurnIds = [];
  let currentTurn = null;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const event = historyEvent(entry);
    const type = clean(event.type);
    if (type === "turn/start") {
      const turn = Number(plainObject(event.data).turn);
      currentTurn = Number.isInteger(turn) ? turn : null;
      if (currentTurn !== null && pendingTurnIds.length) turns.set(currentTurn, pendingTurnIds.shift());
      continue;
    }
    if (type === "turn/end") {
      currentTurn = null;
      continue;
    }
    const sequence = optionalEventSequence(event);
    if (type === "user/message") {
      const message = userMessageFromEvent(event);
      const source = plainObject(message.source);
      const turnId = clean(source.suzuTurnId);
      if (clean(source.kind) !== "user" || !turnId) continue;
      if (sequence >= 0) result.set(sequence, turnId);
      if (currentTurn === null) pendingTurnIds.push(turnId);
      else turns.set(currentTurn, turnId);
      continue;
    }
    if (type === "assistant/message") {
      const turn = Number(plainObject(event.data).turn);
      const turnId = turns.get(turn);
      if (sequence >= 0 && turnId) result.set(sequence, turnId);
    }
  }
  return result;
}

function localDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Reads displayable history exclusively through Agent Core's session history
 * endpoint.  Contact ownership, project roots, profile metadata, and memory
 * remain Suzu-owned exactly as before.
 */
export function createConversationReader({
  contactProjectsService = null,
  dataRoot = "",
  memoryRuntime = null,
  messageDeletionStore = createConversationMessageDeletionStore(),
  onContactCreated = null,
  onAgentUsageEvents = null,
  runtime,
  settingsService,
} = {}) {
  if (!settingsService?.load) throw new ConversationReaderError("会话读取需要软件设置服务。", { code: "SETTINGS_REQUIRED" });
  if (!contactProjectsService?.snapshot) throw new ConversationReaderError("Agent 会话读取需要联系人项目服务。", { code: "CONTACTS_REQUIRED" });
  if (typeof runtime?.history !== "function") throw new ConversationReaderError("Agent 会话读取需要运行时历史接口。", { code: "RUNTIME_REQUIRED" });
  if (typeof messageDeletionStore?.list !== "function" || typeof messageDeletionStore?.markDeleted !== "function") {
    throw new ConversationReaderError("会话读取需要消息删除记录服务。", { code: "MESSAGE_DELETION_STORE_REQUIRED" });
  }

  let selectionVersion = 0;
  const reconciledUsageHistoryBySession = new Map();
  const usageReconciliationTasksBySession = new Map();

  const contactsSnapshot = async () => contactProjectsService.snapshot();
  const visibleContactsSnapshot = async () => (
    typeof contactProjectsService.visibleSnapshot === "function"
      ? contactProjectsService.visibleSnapshot()
      : visibleContactProjectsSnapshot(await contactsSnapshot())
  );

  const activeCatalog = async () => {
    const settings = settingsService.load();
    const contacts = await visibleContactsSnapshot();
    const sourceContacts = Array.isArray(contacts.contacts) ? contacts.contacts : [];
    const requestedActiveId = clean(plainObject(contacts.activeContact).id);
    // The selected entry must still belong to the current catalog. A stale
    // selection can otherwise wake the local Agent Core process even while the UI
    // correctly says that there are no contacts.
    const active = sourceContacts.find((contact) => {
      const source = plainObject(contact);
      return clean(source.id) === requestedActiveId && source.hidden !== true;
    }) || null;
    const projectRoot = clean(active?.projectRoot);
    const sessionId = clean(active?.sessionId);
    return {
      settings,
      contactsSnapshot: contacts,
      contacts: sourceContacts.map(publicContact).filter(Boolean),
      contactsRoot: clean(contacts.contactsRoot),
      activeContact: active ? publicContact(active) : null,
      hiddenContactCount: Number.isSafeInteger(contacts.hiddenContactCount) && contacts.hiddenContactCount > 0
        ? contacts.hiddenContactCount
        : 0,
      preferredContactId: clean(contacts.preferredContact?.id),
      projectRoot,
      sessionId,
    };
  };

  const activeHistory = async (catalog, { limit = HISTORY_PAGE_SIZE, beforeSeq = undefined } = {}) => {
    if (!catalog.projectRoot || !isSessionId(catalog.sessionId)) return { events: [], hasMore: false };
    const safeLimit = Number.isSafeInteger(limit) && limit > 0
      ? Math.min(limit, 2_000)
      : HISTORY_PAGE_SIZE;
    try {
      return await runtime.history({
        sessionId: catalog.sessionId,
        contactId: clean(catalog.activeContact?.id),
        cwd: catalog.projectRoot,
        maxMessages: safeLimit,
        ...(Number.isSafeInteger(beforeSeq) && beforeSeq >= 0 ? { beforeSeq } : {}),
      });
    } catch (error) {
      throw new ConversationReaderError(`无法读取 Suzu Agent 会话历史：${clean(error?.message) || "未知错误。"}`, {
        cause: error,
        code: error?.code || "AGENT_HISTORY_FAILED",
      });
    }
  };

  const activeMessageDeletions = async (catalog) => {
    if (!catalog.projectRoot || !isSessionId(catalog.sessionId)) {
      return Object.freeze({ eventSequences: Object.freeze([]), revision: "" });
    }
    try {
      const state = await messageDeletionStore.list({
        projectRoot: catalog.projectRoot,
        sessionId: catalog.sessionId,
      });
      const eventSequences = [...new Set((Array.isArray(state?.entries) ? state.entries : [])
        .map((entry) => Number(plainObject(entry).eventSeq))
        .filter((sequence) => Number.isSafeInteger(sequence) && sequence >= 0))]
        .sort((left, right) => left - right);
      return Object.freeze({
        eventSequences: Object.freeze(eventSequences),
        revision: clean(state?.revision),
      });
    } catch (error) {
      throw new ConversationReaderError(
        `无法读取消息删除记录：${clean(error?.message) || "未知错误。"}`,
        { cause: error, code: error?.code || "MESSAGE_DELETION_STATE_FAILED" },
      );
    }
  };

  const displayMessages = (events, catalog, deletions, maxMessages = MAX_MESSAGES) => conversationDisplayMessages(events, maxMessages, {
    dataRoot,
    deletedEventSequences: deletions.eventSequences,
    includeDynamicContext: catalog.settings?.conversationPreferences?.dynamicContext === true,
  });

  // Agent Core pages are measured in durable events. A streamed reply can
  // contain hundreds of chunks, reasoning records, and lifecycle events while
  // producing only a few rows. Assemble the requested visible page before it
  // reaches the renderer. The raw-event ceiling keeps the scan bounded for
  // unusually verbose sessions.
  const readVisibleHistoryPage = async (catalog, initialHistory, deletions) => {
    let history = initialHistory;
    let events = Array.isArray(initialHistory?.events) ? initialHistory.events : [];
    let messages = displayMessages(events, catalog, deletions);
    let visible = visibleTranscriptEntries(messages, catalog.settings?.conversationPreferences);
    const visitedCursors = new Set();

    while (
      history?.hasMore === true
      && visible.length < CHAT_HISTORY_VISIBLE_MESSAGE_LIMIT
      && events.length < CHAT_HISTORY_INITIAL_MAX_EVENTS
    ) {
      const cursor = historyPageMetadata(events, history, { limit: CHAT_HISTORY_EVENT_PAGE_SIZE }).oldestEventSeq;
      if (!Number.isSafeInteger(cursor) || cursor < 0 || visitedCursors.has(cursor)) break;
      visitedCursors.add(cursor);

      const remainingEvents = CHAT_HISTORY_INITIAL_MAX_EVENTS - events.length;
      const olderHistory = await activeHistory(catalog, {
        beforeSeq: cursor,
        limit: Math.min(CHAT_HISTORY_BACKFILL_PAGE_SIZE, remainingEvents),
      });
      const olderEvents = Array.isArray(olderHistory?.events) ? olderHistory.events : [];
      const olderCursor = historyPageMetadata(olderEvents, olderHistory, {
        limit: CHAT_HISTORY_BACKFILL_PAGE_SIZE,
      }).oldestEventSeq;
      // A runtime that cannot move the cursor must not turn an initial render
      // into an unbounded retry loop.
      if (!olderEvents.length || !Number.isSafeInteger(olderCursor) || olderCursor >= cursor) break;

      events = [...olderEvents, ...events];
      history = { ...plainObject(history), hasMore: olderHistory?.hasMore === true };
      messages = displayMessages(events, catalog, deletions);
      visible = visibleTranscriptEntries(messages, catalog.settings?.conversationPreferences);
    }

    return { history, events, messages };
  };

  const reconcileUsageHistory = async (catalog, events, highestSequence) => {
    if (typeof onAgentUsageEvents !== "function"
      || !catalog.activeContact?.agentId
      || !catalog.projectRoot
      || !catalog.sessionId) return;
    const sequences = (Array.isArray(events) ? events : [])
      .map(historyEventSequence)
      .filter((sequence) => sequence !== null);
    const lowestSequence = sequences.length ? Math.min(...sequences) : highestSequence;
    const previous = reconciledUsageHistoryBySession.get(catalog.sessionId);
    const previousHighestSequence = Number(previous?.highestSequence);
    const previousLowestSequence = Number(previous?.lowestSequence);
    // A light chat page can cover the newest events while the background
    // repair still needs to inspect an older range. Track both ends of the
    // already reconciled window so the recent-page fast path never suppresses
    // that repair.
    if (
      Number.isSafeInteger(previousHighestSequence)
      && Number.isSafeInteger(previousLowestSequence)
      && previousHighestSequence >= highestSequence
      && previousLowestSequence <= lowestSequence
    ) return;
    try {
      const result = await onAgentUsageEvents({
        contact: {
          contactId: clean(catalog.activeContact.id),
          agentId: clean(catalog.activeContact.agentId),
          projectRoot: catalog.projectRoot,
          sessionId: catalog.sessionId,
        },
        events,
      });
      if (result?.completed === false) return;
      reconciledUsageHistoryBySession.set(catalog.sessionId, {
        highestSequence: Math.max(previousHighestSequence || 0, highestSequence),
        lowestSequence: Number.isSafeInteger(previousLowestSequence)
          ? Math.min(previousLowestSequence, lowestSequence)
          : lowestSequence,
      });
      // A person can create many contacts over time. Keep only a small cache:
      // deduplication itself is durable in the unified usage ledger.
      if (reconciledUsageHistoryBySession.size > 160) reconciledUsageHistoryBySession.clear();
    } catch {
      // History must stay readable even if a local cost-ledger repair fails.
      // A later snapshot will retry because this sequence was not recorded.
    }
  };

  const reconcileRecentUsageHistory = (catalog) => {
    if (typeof onAgentUsageEvents !== "function" || !catalog.sessionId) return;
    if (usageReconciliationTasksBySession.has(catalog.sessionId)) return;
    const task = (async () => {
      const history = await activeHistory(catalog, { limit: HISTORY_PAGE_SIZE });
      const events = Array.isArray(history?.events) ? history.events : [];
      const highestSequence = events.reduce((maximum, entry) => (
        Math.max(maximum, Number(historyEvent(entry).seq) || 0)
      ), 0);
      await reconcileUsageHistory(catalog, events, highestSequence);
    })()
      .catch(() => undefined)
      .finally(() => usageReconciliationTasksBySession.delete(catalog.sessionId));
    usageReconciliationTasksBySession.set(catalog.sessionId, task);
  };

  const unavailableHistory = (error) => {
    const code = clean(error?.code) || "AGENT_HISTORY_FAILED";
    const reason = clean(error?.message).slice(0, 1_200) || "未知错误。";
    return {
      status: "unavailable",
      code,
      message: `聊天记录暂不可用：${reason}`,
    };
  };

  const unavailableContext = (catalog, contactsVersion, error, { historyLimit = CHAT_HISTORY_EVENT_PAGE_SIZE } = {}) => {
    const unavailable = unavailableHistory(error);
    const session = {
      id: catalog.sessionId,
      title: clean(catalog.activeContact?.name) || "对话",
      preview: "聊天记录暂不可用",
      updatedAt: "",
      createdAt: "",
      draft: false,
    };
    return {
      status: "ready",
      ...catalog,
      history: unavailable,
      session,
      events: [],
      messages: [],
      contextRecords: [],
      deletedEventSequences: Object.freeze([]),
      historyPage: emptyHistoryPage({ limit: historyLimit }),
      version: `${selectionVersion}:${catalog.sessionId}:history-unavailable:${unavailable.code}:${contactsVersion}`,
      updatedAt: "",
    };
  };

  const context = async ({
    historyLimit = HISTORY_PAGE_SIZE,
    beforeSeq = undefined,
    reconcileUsage = true,
    assembleVisiblePage = false,
  } = {}) => {
    const safeHistoryLimit = Number.isSafeInteger(historyLimit) && historyLimit > 0
      ? Math.min(historyLimit, 2_000)
      : HISTORY_PAGE_SIZE;
    const catalog = await activeCatalog();
    const contactsVersion = JSON.stringify(catalog.contacts.map((contact) => [
      contact.id,
      contact.name,
      contact.updatedAt || "",
      contact.unreadCount,
      contact.pinned,
      contact.hidden,
      contact.muted,
      contact.longTermMemoryEnabled,
      contact.permissionMode,
    ]));
    if (!catalog.projectRoot || !isSessionId(catalog.sessionId)) {
      return {
        status: catalog.projectRoot ? "ready" : "missing",
        ...catalog,
        history: {
          status: "missing",
          code: "",
          message: "",
        },
        session: null,
        events: [],
        messages: [],
        contextRecords: [],
        deletedEventSequences: Object.freeze([]),
        historyPage: emptyHistoryPage({ limit: safeHistoryLimit }),
        version: `${selectionVersion}:missing:${contactsVersion}`,
        updatedAt: "",
      };
    }
    let history;
    try {
      history = await activeHistory(catalog, { limit: safeHistoryLimit, beforeSeq });
    } catch (error) {
      return unavailableContext(catalog, contactsVersion, error, { historyLimit: safeHistoryLimit });
    }
    let events = Array.isArray(history.events) ? history.events : [];
    let deletions;
    try {
      deletions = await activeMessageDeletions(catalog);
    } catch (error) {
      return unavailableContext(catalog, contactsVersion, error, { historyLimit: safeHistoryLimit });
    }
    let messages = displayMessages(events, catalog, deletions);
    if (assembleVisiblePage) {
      try {
        const expanded = await readVisibleHistoryPage(catalog, history, deletions);
        history = expanded.history;
        events = expanded.events;
        messages = expanded.messages;
      } catch (error) {
        return unavailableContext(catalog, contactsVersion, error, { historyLimit: safeHistoryLimit });
      }
    }
    const visiblePage = visibleTranscriptPage(messages, catalog.settings?.conversationPreferences);
    messages = visiblePage.messages;
    const contextRecords = conversationContextRecords(events, HISTORY_PAGE_SIZE, {
      deletedEventSequences: deletions.eventSequences,
    });
    const last = [...messages].reverse().find((message) => ["user", "assistant"].includes(clean(message?.kind))) || null;
    const session = {
      id: catalog.sessionId,
      title: clean(catalog.activeContact?.name) || "对话",
      preview: textForMessage(last) || "还没有可展示的消息",
      updatedAt: clean(last?.timestamp) || new Date().toISOString(),
      createdAt: "",
      draft: events.length === 0,
    };
    const highestSequence = events.reduce((maximum, entry) => Math.max(maximum, Number(historyEvent(entry).seq) || 0), 0);
    const historyPage = visibleHistoryPageMetadata(events, history, visiblePage, {
      limit: CHAT_HISTORY_VISIBLE_MESSAGE_LIMIT,
    });
    if (reconcileUsage && beforeSeq === undefined) {
      if (safeHistoryLimit >= HISTORY_PAGE_SIZE) {
        await reconcileUsageHistory(catalog, events, highestSequence);
      } else {
        // Record the visible newest page immediately so a completed chat turn
        // appears in the cost view without waiting for the optional repair.
        // Rebuilding older ledger records still runs in the background and
        // may inspect a wider local history.
        await reconcileUsageHistory(catalog, events, highestSequence);
        reconcileRecentUsageHistory(catalog);
      }
    }
    return {
      status: "ready",
      ...catalog,
      history: {
        status: "ready",
        code: "",
        message: "",
      },
      session,
      events,
      messages,
      contextRecords,
      deletedEventSequences: deletions.eventSequences,
      historyPage,
      version: `${selectionVersion}:${catalog.sessionId}:${highestSequence}:${events.length}:${historyPage.oldestEventSeq ?? "empty"}:${historyPage.hasMore ? "more" : "end"}:${deletions.revision}:${contactsVersion}`,
      updatedAt: session.updatedAt,
    };
  };

  const snapshot = async (value = {}) => {
    const request = historyPageValue(value);
    const current = await context({
      beforeSeq: request.beforeSeq,
      historyLimit: CHAT_HISTORY_EVENT_PAGE_SIZE,
      assembleVisiblePage: true,
    });
    return {
      status: current.status,
      historyBackend: "agent-core",
      contactDeletion: {
        available: true,
      },
      contactsRoot: current.contactsRoot,
      contacts: current.contacts,
      activeContact: current.activeContact,
      hiddenContactCount: current.hiddenContactCount,
      preferredContactId: current.preferredContactId,
      projectRoot: current.projectRoot,
      projectDir: current.projectRoot,
      sessions: current.session ? [publicSession(current.session)] : [],
      activeSessionId: current.session?.id || "",
      fileName: current.session ? "Agent Core 会话历史" : "",
      version: current.version,
      history: current.history,
      historyPage: current.historyPage,
      error: current.history?.status === "unavailable" ? current.history.message : "",
      messages: current.messages,
      // Keep the product-owned deletion state in the snapshot as well as
      // applying it in this reader.  The renderer uses it as a final guard
      // when a history update and a React render cross each other.
      deletedEventSequences: current.deletedEventSequences,
      context: Object.freeze({
        available: current.history?.status === "ready",
        count: current.contextRecords.length,
      }),
      scannedRecords: current.events.length,
      malformedLines: 0,
      pollIntervalMs: 0,
      updatedAt: current.updatedAt,
    };
  };

  const create = async () => {
    throw new ConversationReaderError("每个联系人只保留一个 Agent 会话；如需新对话，请新建联系人。", { code: "ONE_SESSION_PER_CONTACT" });
  };

  const createContact = async ({ name } = {}) => {
    if (!contactProjectsService?.create) throw new ConversationReaderError("当前版本未接入联系人项目服务。", { code: "CONTACTS_REQUIRED" });
    const created = await contactProjectsService.create({ name });
    if (typeof onContactCreated === "function" && created?.createdContact) {
      await Promise.resolve(onContactCreated(created.createdContact)).catch(() => undefined);
    }
    selectionVersion += 1;
    const current = await snapshot();
    const createdContactId = clean(created?.createdContact?.id);
    return createdContactId
      ? { ...current, createdContact: { id: createdContactId } }
      : current;
  };

  const selectContact = async ({ id } = {}) => {
    if (!contactProjectsService?.select) throw new ConversationReaderError("当前版本未接入联系人项目服务。", { code: "CONTACTS_REQUIRED" });
    const selected = await contactProjectsService.select({ id });
    if (Number(selected?.activeContact?.unreadCount) > 0 && contactProjectsService.updatePresentation) {
      await contactProjectsService.updatePresentation({ id: selected.activeContact.id, unreadCount: 0 });
    }
    selectionVersion += 1;
    return snapshot();
  };

  const setPreferredContact = async ({ id } = {}) => {
    if (!contactProjectsService?.setPreferred) throw new ConversationReaderError("当前版本未接入联系人项目服务。", { code: "CONTACTS_REQUIRED" });
    await contactProjectsService.setPreferred({ id });
    selectionVersion += 1;
    return snapshot();
  };

  const renameContact = async ({ id, name } = {}) => {
    if (!contactProjectsService?.rename) throw new ConversationReaderError("当前版本未接入联系人项目服务。", { code: "CONTACTS_REQUIRED" });
    await contactProjectsService.rename({ id, name });
    selectionVersion += 1;
    return snapshot();
  };

  const updateContactPresentation = async (value = {}) => {
    if (!contactProjectsService?.updatePresentation) throw new ConversationReaderError("当前版本未接入联系人项目服务。", { code: "CONTACTS_REQUIRED" });
    await contactProjectsService.updatePresentation(value);
    selectionVersion += 1;
    return snapshot();
  };

  const updateContactPermissionMode = async (value = {}) => {
    if (!contactProjectsService?.updatePermissionMode) {
      throw new ConversationReaderError("当前版本未接入联系人审批模式服务。", { code: "CONTACTS_REQUIRED" });
    }
    await contactProjectsService.updatePermissionMode(value);
    selectionVersion += 1;
    return snapshot();
  };

  const removeContact = async (value = {}) => {
    if (!contactProjectsService?.remove) throw new ConversationReaderError("当前版本未接入联系人项目服务。", { code: "CONTACTS_REQUIRED" });
    await contactProjectsService.remove(value);
    selectionVersion += 1;
    return snapshot();
  };

  const updateContactReasoningEffort = async (value = {}) => {
    if (!contactProjectsService?.updateReasoningEffort) {
      throw new ConversationReaderError("当前版本未接入联系人思考强度服务。", { code: "CONTACTS_REQUIRED" });
    }
    await contactProjectsService.updateReasoningEffort(value);
    selectionVersion += 1;
    return snapshot();
  };

  const deleteMessage = async (value = {}) => {
    const source = plainObject(value);
    if (source.confirmed !== true) {
      throw new ConversationReaderError("请确认后再删除这条消息。", { code: "MESSAGE_DELETE_CONFIRMATION_REQUIRED" });
    }
    const targetSequence = Number(source.lineNumber);
    if (!Number.isSafeInteger(targetSequence) || targetSequence < 0) {
      throw new ConversationReaderError("要删除的消息标识无效。", { code: "MESSAGE_DELETE_INPUT_INVALID" });
    }
    const current = await context();
    if (current.status !== "ready" || current.history?.status !== "ready" || !current.session || !current.projectRoot || !current.activeContact) {
      throw new ConversationReaderError("当前联系人没有可删除的消息。", { code: "MESSAGE_DELETE_UNAVAILABLE" });
    }
    const event = current.events
      .map(historyEvent)
      .find((candidate) => optionalEventSequence(candidate) === targetSequence);
    if (!event) throw new ConversationReaderError("没有找到要删除的消息。", { code: "MESSAGE_NOT_FOUND" });
    const type = clean(event.type);
    const message = messageForEvent(event);
    const messageSource = plainObject(message.source);
    const isUserMessage = type === "user/message" && clean(messageSource.kind) === "user";
    const isAssistantMessage = type === "assistant/message";
    const isDynamicContext = isDynamicContextSnapshot(messageSource);
    if (!isUserMessage && !isAssistantMessage && !isDynamicContext) {
      throw new ConversationReaderError("这条内部记录不能删除。", { code: "MESSAGE_DELETE_UNSUPPORTED" });
    }
    const requestedMessageId = clean(source.messageId);
    if (requestedMessageId && !isDynamicContext && requestedMessageId !== clean(message.id)) {
      throw new ConversationReaderError("要删除的消息已经变化，请刷新后重试。", { code: "MESSAGE_CHANGED" });
    }
    if (current.deletedEventSequences.includes(targetSequence)) return snapshot();

    if ((isUserMessage || isAssistantMessage) && typeof memoryRuntime?.retractConversationMessage === "function") {
      const turnId = turnIdsByEventSequence(current.events).get(targetSequence) || "";
      try {
        await memoryRuntime.retractConversationMessage({
          projectRoot: current.projectRoot,
          sessionId: current.session.id,
          turnId,
          role: isUserMessage ? "user" : "companion",
          text: textForCoreEvent(event, { dataRoot }),
          occurredAt: isoTime(event.time),
        });
      } catch (error) {
        throw new ConversationReaderError(
          `无法撤回关联的长期记忆：${clean(error?.message) || "未知错误。"}`,
          { cause: error, code: error?.code || "MEMORY_RETRACTION_FAILED" },
        );
      }
    }

    try {
      await messageDeletionStore.markDeleted({
        sessionId: current.session.id,
        projectRoot: current.projectRoot,
        eventSeq: targetSequence,
        messageId: isDynamicContext ? "" : clean(message.id),
      });
    } catch (error) {
      throw new ConversationReaderError(
        `无法保存消息删除记录：${clean(error?.message) || "未知错误。"}`,
        { cause: error, code: error?.code || "MESSAGE_DELETE_FAILED" },
      );
    }
    selectionVersion += 1;
    return snapshot();
  };

  const ensureActiveSession = async () => {
    const catalog = await activeCatalog();
    if (!catalog.projectRoot) throw new ConversationReaderError("请先选择联系人工作目录。", { code: "WORKSPACE_REQUIRED" });
    if (!isSessionId(catalog.sessionId)) throw new ConversationReaderError("当前联系人尚未绑定 Agent 会话。", { code: "SESSION_REQUIRED" });
    return {
      id: catalog.sessionId,
      projectRoot: catalog.projectRoot,
      hasTranscript: false,
    };
  };

  const resolveContact = async (contactId) => {
    const id = clean(contactId);
    const contacts = await contactsSnapshot();
    const contact = (Array.isArray(contacts.contacts) ? contacts.contacts : [])
      .find((item) => clean(item?.id) === id) || null;
    if (!contact?.projectRoot || !isSessionId(contact.sessionId)) {
      throw new ConversationReaderError("所选联系人不存在或尚未绑定 Agent 会话。", { code: "CONTACT_NOT_FOUND" });
    }
    return contact;
  };

  const resolveContactSession = async (contactId) => {
    const contact = await resolveContact(contactId);
    return {
      agentId: clean(contact.agentId),
      contactId: clean(contact.id),
      id: clean(contact.sessionId),
      projectRoot: clean(contact.projectRoot),
      hasTranscript: false,
    };
  };

  const contactIdForSession = async ({ sessionId, projectRoot } = {}) => {
    const id = clean(sessionId);
    const scope = projectScopeKey(projectRoot);
    if (!isSessionId(id) || !scope) return "";
    const contacts = await contactsSnapshot();
    const contact = (Array.isArray(contacts.contacts) ? contacts.contacts : [])
      .find((item) => clean(item?.sessionId) === id && projectScopeKey(item?.projectRoot) === scope) || null;
    return clean(contact?.id);
  };

  const compactorSnapshot = async () => {
    const contacts = await visibleContactsSnapshot();
    return {
      status: clean(contacts.status) || "missing",
      activeContact: publicContact(contacts.activeContact),
      preferredContactId: clean(contacts.preferredContact?.id),
      activeSessionId: clean(contacts.activeContact?.sessionId),
      historyBackend: "agent-core",
      contacts: (Array.isArray(contacts.contacts) ? contacts.contacts : []).map((contact) => ({
        ...publicContact(contact),
        sessions: isSessionId(contact?.sessionId) ? [publicSession({
          id: contact.sessionId,
          title: clean(contact.name) || "对话",
          preview: "Suzu Agent 会话历史",
          updatedAt: clean(contact.updatedAt),
        })] : [],
      })),
    };
  };

  const resolveCompactorSession = async ({ contactId } = {}) => resolveContactSession(contactId);

  const resolveCompactorSessionForRuntime = async ({ sessionId, projectRoot = "" } = {}) => {
    const id = clean(sessionId);
    const expectedProject = clean(projectRoot);
    if (!isSessionId(id)) {
      throw new ConversationReaderError("Agent 压缩器请求缺少有效会话标识。", { code: "SESSION_REQUIRED" });
    }
    const contacts = await contactsSnapshot();
    const matches = (Array.isArray(contacts.contacts) ? contacts.contacts : [])
      .filter((contact) => clean(contact?.sessionId) === id)
      .filter((contact) => !expectedProject || projectScopeKey(contact?.projectRoot) === projectScopeKey(expectedProject));
    if (matches.length !== 1) {
      throw new ConversationReaderError("Agent 压缩器无法确认这条会话所属的联系人。", { code: "COMPACTOR_SESSION_UNTRUSTED" });
    }
    const contact = matches[0];
    if (!clean(contact?.projectRoot)) {
      throw new ConversationReaderError("Agent 压缩器无法确认这条会话的工作目录。", { code: "WORKSPACE_REQUIRED" });
    }
    return {
      agentId: clean(contact.agentId),
      contactId: clean(contact.id),
      id,
      projectRoot: clean(contact.projectRoot),
      hasTranscript: false,
    };
  };

  const search = async (value) => {
    const current = await context();
    const request = searchRequest(value);
    if (current.status !== "ready") return { status: "missing", query: request.query, matches: [] };
    if (request.category === "messages" && !request.query) throw new ConversationReaderError("请输入搜索内容。", { code: "SEARCH_QUERY_REQUIRED" });
    if (request.category === "date" && !/^\d{4}-\d{2}-\d{2}$/u.test(request.query)) {
      throw new ConversationReaderError("请选择要查找的日期。", { code: "SEARCH_DATE_INVALID" });
    }
    const query = request.query.toLocaleLowerCase("zh-CN");
    const matches = current.messages.flatMap((message) => {
      const text = textForMessage(message).toLocaleLowerCase("zh-CN");
      const matched = request.category === "date"
        ? localDate(message.timestamp) === request.query
        : request.category === "messages"
          ? text.includes(query)
          : false;
      return matched ? [{
        lineNumber: Number(message.lineNumber) || 0,
        messageId: clean(message.id),
        timestamp: clean(message.timestamp),
        messages: [message],
      }] : [];
    });
    return {
      status: "ready",
      activeSessionId: current.session?.id || "",
      fileName: "Agent Core 会话历史",
      query: request.query,
      category: request.category,
      scannedRecords: current.events.length,
      malformedLines: 0,
      matchedRecords: matches.length,
      truncated: false,
      matches: matches.slice(-100),
    };
  };

  const contextTrace = async (value = {}) => {
    const current = await context();
    const request = plainObject(value);
    const query = clean(request.query);
    const category = clean(request.category).toLocaleLowerCase("en-US");
    const maximum = Number.isSafeInteger(request.limit) && request.limit > 0
      ? Math.min(request.limit, HISTORY_PAGE_SIZE)
      : HISTORY_PAGE_SIZE;
    if (current.status !== "ready") {
      return Object.freeze({ status: "missing", query, category, records: Object.freeze([]) });
    }
    const normalizedQuery = query.toLocaleLowerCase("zh-CN");
    const records = current.contextRecords.flatMap((record) => {
      const blocks = record.blocks.filter((block) => {
        if (category && clean(block.display?.category).toLocaleLowerCase("en-US") !== category) return false;
        if (!normalizedQuery) return true;
        return [
          block.id,
          block.kind,
          block.source,
          block.display?.label,
          block.text,
        ].some((candidate) => clean(candidate).toLocaleLowerCase("zh-CN").includes(normalizedQuery));
      });
      return blocks.length ? [Object.freeze({ ...record, blocks: Object.freeze(blocks) })] : [];
    });
    return Object.freeze({
      status: "ready",
      activeSessionId: current.session?.id || "",
      query,
      category,
      scannedRecords: current.events.length,
      matchedRecords: records.length,
      records: Object.freeze(records.slice(-maximum)),
    });
  };

  const focus = async ({ lineNumber, messageId } = {}) => {
    const current = await context();
    if (current.status !== "ready" || !current.session) {
      throw new ConversationReaderError("当前联系人没有可定位的 Agent 聊天记录。", { code: "FOCUS_UNAVAILABLE" });
    }
    const byId = clean(messageId);
    const expectedLine = Number(lineNumber);
    const index = current.messages.findIndex((message) => (
      (byId && clean(message.id) === byId)
      || (Number.isSafeInteger(expectedLine) && expectedLine > 0 && Number(message.lineNumber) === expectedLine)
    ));
    if (index < 0) throw new ConversationReaderError("找不到要定位的 Agent 聊天记录。", { code: "FOCUS_NOT_FOUND" });
    const start = Math.max(0, index - 28);
    const end = Math.min(current.messages.length, index + 29);
    return {
      status: "ready",
      activeSessionId: current.session.id,
      fileName: "Agent Core 会话历史",
      focusMessageId: clean(current.messages[index].id),
      focusLineNumber: Number(current.messages[index].lineNumber) || 0,
      startLine: Number(current.messages[start]?.lineNumber) || 0,
      endLine: Number(current.messages[end - 1]?.lineNumber) || 0,
      messages: current.messages.slice(start, end),
    };
  };

  const updateContactLongTermMemoryEnabled = async (value = {}) => {
    if (!contactProjectsService?.updateLongTermMemoryEnabled) throw new ConversationReaderError("当前版本未接入联系人长期记忆服务。", { code: "CONTACTS_REQUIRED" });
    await contactProjectsService.updateLongTermMemoryEnabled(value);
    selectionVersion += 1;
    return snapshot();
  };

  return Object.freeze({
    compactorSnapshot,
    contactIdForSession,
    context,
    contextTrace,
    create,
    createContact,
    deleteMessage,
    ensureActiveSession,
    focus,
    removeContact,
    renameContact,
    resolveCompactorSession,
    resolveCompactorSessionForRuntime,
    resolveContactSession,
    search,
    selectContact,
    setPreferredContact,
    snapshot,
    updateContactLongTermMemoryEnabled,
    updateContactPermissionMode,
    updateContactReasoningEffort,
    updateContactPresentation,
  });
}
