import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  conversationAttachmentReceipt,
  conversationMediaManifest,
  conversationMediaUnderstandingContext,
} from "./conversation-attachment-service.mjs";

const MAX_MESSAGES = 500;
const HISTORY_PAGE_SIZE = 600;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_CONVERSATION_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_CONVERSATION_ATTACHMENT_ITEMS = 24;
const VOICE_CALL_TURN_OPEN = "<suzu-voice-call-turn>";
const VOICE_CALL_TURN_CLOSE = "</suzu-voice-call-turn>";
const VOICE_CALL_OPEN_OPEN = "<suzu-voice-call-open>";
const VOICE_CALL_OPEN_CLOSE = "</suzu-voice-call-open>";
const SUZU_SCHEDULE_TASK_OPEN = "<suzu-schedule-task>";
const SUZU_SCHEDULE_TASK_CLOSE = "</suzu-schedule-task>";
const SUZU_LOCAL_ONLY_SCHEDULE_MARKER = "<!-- suzu-lives:display-system -->";

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

function isSilentAgentReply(content) {
  return markerSource(content).trim() === "NO_REPLY";
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
  return text.length > limit ? `${text.slice(0, limit)}\n[内容已截断]` : text;
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

function containedPath(root, candidate) {
  const base = clean(root);
  const source = clean(candidate);
  if (!base || !source || !path.isAbsolute(base) || !path.isAbsolute(source)) return "";
  const normalizedBase = path.resolve(base, "agents");
  const normalizedCandidate = path.resolve(source);
  const relative = path.relative(normalizedBase, normalizedCandidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return "";
  return normalizedCandidate;
}

function mediaBlockFromManifest(value, { dataRoot, source = "" } = {}) {
  const item = plainObject(value);
  const kind = clean(item.kind).toLowerCase();
  const size = Number(item.size);
  const filePath = containedPath(dataRoot, item.path);
  if (!new Set(["image", "audio", "file"]).has(kind) || !filePath || !Number.isSafeInteger(size) || size <= 0 || size > MAX_CONVERSATION_ATTACHMENT_BYTES) {
    return null;
  }
  const normalizedSource = new Set(["mail", "sticker", "wechat"]).has(clean(source).toLowerCase())
    ? clean(source).toLowerCase()
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
export function conversationContextRecords(entries, maxRecords = HISTORY_PAGE_SIZE) {
  const sourceEntries = Array.isArray(entries) ? entries : [];
  const expiredSequences = expiredContextSequences(sourceEntries);
  const directMessagesByStep = new Map();
  const records = [];
  let currentPosition = null;

  for (const entry of sourceEntries) {
    const event = historyEvent(entry);
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
      .filter((block) => block.display.context);
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
    if (isSilentAgentReply(message.content)) return null;
    const blocks = blocksFromAgentCoreContent(message.content, options);
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
    if (attachments.length) return {
      id: `agent-core:${source.seq}`,
      kind: "assistant",
      label: "",
      timestamp,
      blocks: attachments,
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
  const transcript = [];
  // A voice-call turn is transport-level: its transcript and the assistant
  // reply both render as centered system messages, like the v1 reader.
  let inVoiceCall = false;
  // Planning and journal turns are local-only. The schedule request itself is
  // always hidden; this flag additionally hides any tool/result or accidental
  // model text from a local-only task until the next real person message.
  let inLocalOnlyScheduleTurn = false;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const event = historyEvent(entry);
    const type = clean(event.type);
    if (!new Set(["user/message", "assistant/message", "tool/result"]).has(type)) continue;
    // Agent Core surface replacements are deliberately model-only: a compacted
    // checkpoint replaces older context for the next model request, but must
    // never erase messages a person already saw.  Append-origin events are the
    // documented durable source of a human transcript.
    if (event.surfaceOp !== "append") continue;
    if (type === "user/message") {
      const userMessage = plainObject(userMessageFromEvent(event));
      const content = userMessage.content;
      if (isInternalSuzuScheduleTask(content)) {
        inLocalOnlyScheduleTurn = isLocalOnlySuzuScheduleTask(content);
        continue;
      }
      const messageSource = plainObject(userMessage.source);
      if (inLocalOnlyScheduleTurn && clean(messageSource.kind) !== "user") continue;
      if (voiceCallOpening(content) || voiceCallTranscript(content)) {
        inVoiceCall = true;
      } else if (clean(messageSource.kind) === "user") {
        inVoiceCall = false;
      }
      if (clean(messageSource.kind) === "user") inLocalOnlyScheduleTurn = false;
    }
    if (inLocalOnlyScheduleTurn && (type === "assistant/message" || type === "tool/result")) continue;
    const message = surfaceMessage(event, { ...options, inVoiceCall });
    if (message) transcript.push(message);
  }
  const maximum = Number.isSafeInteger(maxMessages) && maxMessages > 0 ? maxMessages : MAX_MESSAGES;
  return transcript.slice(-maximum);
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
  onContactCreated = null,
  onAgentUsageEvents = null,
  runtime,
  settingsService,
} = {}) {
  if (!settingsService?.load) throw new ConversationReaderError("会话读取需要软件设置服务。", { code: "SETTINGS_REQUIRED" });
  if (!contactProjectsService?.snapshot) throw new ConversationReaderError("Agent 会话读取需要联系人项目服务。", { code: "CONTACTS_REQUIRED" });
  if (typeof runtime?.history !== "function") throw new ConversationReaderError("Agent 会话读取需要运行时历史接口。", { code: "RUNTIME_REQUIRED" });

  let selectionVersion = 0;
  const reconciledUsageHistoryBySession = new Map();

  const contactsSnapshot = async () => contactProjectsService.snapshot();

  const activeCatalog = async () => {
    const settings = settingsService.load();
    const contacts = await contactsSnapshot();
    const sourceContacts = Array.isArray(contacts.contacts) ? contacts.contacts : [];
    const requestedActiveId = clean(plainObject(contacts.activeContact).id);
    // The selected entry must still belong to the current catalog. A stale
    // selection can otherwise wake the local Agent Core process even while the UI
    // correctly says that there are no contacts.
    const active = sourceContacts.find((contact) => clean(plainObject(contact).id) === requestedActiveId) || null;
    const projectRoot = clean(active?.projectRoot);
    const sessionId = clean(active?.sessionId);
    return {
      settings,
      contactsSnapshot: contacts,
      contacts: sourceContacts.map(publicContact).filter(Boolean),
      contactsRoot: clean(contacts.contactsRoot),
      activeContact: active ? publicContact(active) : null,
      preferredContactId: clean(contacts.preferredContact?.id),
      projectRoot,
      sessionId,
    };
  };

  const activeHistory = async (catalog) => {
    if (!catalog.projectRoot || !isSessionId(catalog.sessionId)) return { events: [], hasMore: false };
    try {
      return await runtime.history({
        sessionId: catalog.sessionId,
        contactId: clean(catalog.activeContact?.id),
        cwd: catalog.projectRoot,
        maxMessages: HISTORY_PAGE_SIZE,
      });
    } catch (error) {
      throw new ConversationReaderError(`无法读取 Suzu Agent 会话历史：${clean(error?.message) || "未知错误。"}`, {
        cause: error,
        code: error?.code || "AGENT_HISTORY_FAILED",
      });
    }
  };

  const reconcileUsageHistory = async (catalog, events, highestSequence) => {
    if (typeof onAgentUsageEvents !== "function"
      || !catalog.activeContact?.agentId
      || !catalog.projectRoot
      || !catalog.sessionId) return;
    const previous = reconciledUsageHistoryBySession.get(catalog.sessionId);
    if (Number.isSafeInteger(previous) && previous >= highestSequence) return;
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
      reconciledUsageHistoryBySession.set(catalog.sessionId, highestSequence);
      // A person can create many contacts over time. Keep only a small cache:
      // deduplication itself is durable in the unified usage ledger.
      if (reconciledUsageHistoryBySession.size > 160) reconciledUsageHistoryBySession.clear();
    } catch {
      // History must stay readable even if a local cost-ledger repair fails.
      // A later snapshot will retry because this sequence was not recorded.
    }
  };

  const context = async () => {
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
    ]));
    if (!catalog.projectRoot || !isSessionId(catalog.sessionId)) {
      return {
        status: catalog.projectRoot ? "ready" : "missing",
        ...catalog,
        session: null,
        events: [],
        messages: [],
        contextRecords: [],
        version: `${selectionVersion}:missing:${contactsVersion}`,
        updatedAt: "",
      };
    }
    const history = await activeHistory(catalog);
    const events = Array.isArray(history.events) ? history.events : [];
    const messages = conversationDisplayMessages(events, MAX_MESSAGES, { dataRoot });
    const contextRecords = conversationContextRecords(events);
    const last = messages.at(-1) || null;
    const session = {
      id: catalog.sessionId,
      title: clean(catalog.activeContact?.name) || "对话",
      preview: textForMessage(last) || "还没有可展示的消息",
      updatedAt: clean(last?.timestamp) || new Date().toISOString(),
      createdAt: "",
      draft: events.length === 0,
    };
    const highestSequence = events.reduce((maximum, entry) => Math.max(maximum, Number(historyEvent(entry).seq) || 0), 0);
    await reconcileUsageHistory(catalog, events, highestSequence);
    return {
      status: "ready",
      ...catalog,
      session,
      events,
      messages,
      contextRecords,
      version: `${selectionVersion}:${catalog.sessionId}:${highestSequence}:${events.length}:${contactsVersion}`,
      updatedAt: session.updatedAt,
    };
  };

  const snapshot = async () => {
    const current = await context();
    return {
      status: current.status,
      historyBackend: "agent-core",
      contactDeletion: {
        available: true,
      },
      contactsRoot: current.contactsRoot,
      contacts: current.contacts,
      activeContact: current.activeContact,
      preferredContactId: current.preferredContactId,
      projectRoot: current.projectRoot,
      projectDir: current.projectRoot,
      sessions: current.session ? [publicSession(current.session)] : [],
      activeSessionId: current.session?.id || "",
      fileName: current.session ? "Agent Core 会话历史" : "",
      version: current.version,
      messages: current.messages,
      context: Object.freeze({
        available: current.status === "ready",
        count: current.contextRecords.length,
      }),
      scannedRecords: current.events.length,
      malformedLines: 0,
      pollIntervalMs: 2_000,
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
    return snapshot();
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

  const removeContact = async (value = {}) => {
    if (!contactProjectsService?.remove) throw new ConversationReaderError("当前版本未接入联系人项目服务。", { code: "CONTACTS_REQUIRED" });
    await contactProjectsService.remove(value);
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
    const contacts = await contactsSnapshot();
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
    updateContactPresentation,
  });
}
