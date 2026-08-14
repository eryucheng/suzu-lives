import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

const BINARY_KEY = /(?:base64|image[_-]?data|audio[_-]?data|file[_-]?data)/iu;
const DATA_URL = /^data:[^;,]+;base64,/iu;
const MAX_TEXT_LENGTH = 20_000;
const MAX_CONVERSATION_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_CONVERSATION_ATTACHMENT_ITEMS = 24;
const CONVERSATION_ATTACHMENT_RECEIPT = "suzu-conversation-attachment";
const WECHAT_MEDIA_MANIFEST_OPEN = "<suzu-wechat-media>";
const WECHAT_MEDIA_MANIFEST_CLOSE = "</suzu-wechat-media>";
const SCHEDULE_TASK_OPEN = "<suzu-schedule-task>";
const SUZU_MANAGED_SKILL_CONTEXT = /^Base directory for this skill:\s*[^\r\n]+[\s\S]*?<!--\s*suzu-lives:ability:[a-z0-9._-]+\s*-->/iu;
const CLAUDE_RESUME_META_TEXT = "Continue from where you left off.";
const CLAUDE_SYNTHETIC_NO_RESPONSE_TEXT = "No response requested.";
const VOICE_CALL_TURN_OPEN = "<suzu-voice-call-turn>";
const VOICE_CALL_TURN_CLOSE = "</suzu-voice-call-turn>";
const VOICE_CALL_OPEN_OPEN = "<suzu-voice-call-open>";
const VOICE_CALL_OPEN_CLOSE = "</suzu-voice-call-open>";
const SEARCH_CATEGORIES = new Set(["messages", "images", "files", "audio", "links", "date"]);
const DATE_QUERY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function boundedText(value, key = "") {
  const text = String(value ?? "");
  if ((BINARY_KEY.test(key) || DATA_URL.test(text)) && text.length > 512) return `[二进制内容已省略，共 ${text.length} 字符]`;
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}\n[内容已截断]` : text;
}

function safeValue(value, key = "", depth = 0) {
  if (depth > 24) return "[嵌套内容已省略]";
  if (typeof value === "string") return boundedText(value, key);
  if (Array.isArray(value)) return value.map((item) => safeValue(item, key, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, safeValue(childValue, childKey, depth + 1)]));
  return value;
}

function searchableStrings(value, key = "", output = [], depth = 0) {
  if (depth > 24 || value == null) return output;
  if (typeof value === "string") {
    if (!(BINARY_KEY.test(key) || DATA_URL.test(value))) output.push(value.slice(0, MAX_TEXT_LENGTH));
  } else if (typeof value === "number" || typeof value === "boolean") output.push(String(value));
  else if (Array.isArray(value)) value.forEach((item) => searchableStrings(item, key, output, depth + 1));
  else if (typeof value === "object") Object.entries(value).forEach(([childKey, childValue]) => searchableStrings(childValue, childKey, output, depth + 1));
  return output;
}

function formatJson(value) {
  try { return JSON.stringify(safeValue(value), null, 2); } catch { return "[无法显示该内容]"; }
}

function token(value) { if (value === null || value === undefined || value === "") return null; const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : null; }

export function normalizeUsage(usage, model = "") {
  if (!usage || typeof usage !== "object") return null;
  const input = token(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens);
  const cacheCreation = token(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? usage.cache_write_tokens ?? usage.cacheWriteTokens);
  const cacheRead = token(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cached_tokens ?? usage.cachedTokens);
  const output = token(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens);
  if ([input, cacheCreation, cacheRead, output].every((value) => value === null)) return null;
  return { model: String(model || usage.model || ""), input, cacheCreation, cacheRead, output, total: [input, cacheCreation, cacheRead, output].reduce((sum, value) => sum + (value || 0), 0) };
}

function clean(value) {
  return String(value ?? "").trim();
}

function normalizedSearchText(value) {
  return clean(value).normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function normalizedLineNumber(value) {
  const lineNumber = Number(value);
  return Number.isSafeInteger(lineNumber) && lineNumber > 0 ? lineNumber : 0;
}

function localDateKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function searchCategory(value) {
  const category = clean(value).toLocaleLowerCase("en-US");
  return SEARCH_CATEGORIES.has(category) ? category : "messages";
}

function searchRequest(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : { query: value };
  return {
    category: searchCategory(source.category),
    query: clean(source.query),
  };
}

function displayMessageMatchesCategory(message, category) {
  const blocks = Array.isArray(message?.blocks) ? message.blocks : [];
  if (category === "messages") return true;
  if (category === "images") return blocks.some((block) => block?.kind === "media" && block.mediaKind === "image");
  if (category === "files") return blocks.some((block) => block?.kind === "media" && block.mediaKind === "file");
  if (category === "audio") return blocks.some((block) => block?.kind === "media" && block.mediaKind === "audio");
  if (category === "links") return blocks.some((block) => /https?:\/\/[^\s<>()]+/iu.test(String(block?.text || "")));
  return category === "date" && Boolean(localDateKey(message?.timestamp));
}

function matchesSearchRequest(record, messages, request) {
  if (!messages.length) return false;
  if (!messages.some((message) => displayMessageMatchesCategory(message, request.category))) return false;
  const needle = normalizedSearchText(request.query);
  if (request.category === "date") return messages.some((message) => localDateKey(message.timestamp) === request.query);
  if (!needle) return request.category !== "messages";
  return normalizedSearchText(searchableStrings(record).join("\n")).includes(needle);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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
    } catch { /* A normal tool result is not a Suzu attachment receipt. */ }
  }
  return null;
}

function mediaBlock(value, mediaSource = "") {
  const entry = objectValue(value);
  const kind = String(entry.kind || "").trim().toLowerCase();
  const sourcePath = String(entry.path || "").trim();
  const size = Number(entry.size);
  if (!new Set(["image", "audio", "file"]).has(kind) || !sourcePath || !path.isAbsolute(sourcePath)) return null;
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_CONVERSATION_ATTACHMENT_BYTES) return null;
  const filePath = path.resolve(sourcePath);
  let fileUrl = "";
  try { fileUrl = pathToFileURL(filePath).toString(); } catch { /* Keep the local attachment usable as a file card. */ }
  return {
    kind: "media",
    mediaKind: kind,
    fileName: String(entry.fileName || path.basename(filePath)).trim() || path.basename(filePath),
    filePath,
    fileUrl,
    size,
    ...(mediaSource ? { mediaSource } : {}),
  };
}

function attachmentReceipt(value) {
  const source = objectValue(parsedObject(value));
  if (source.status !== "ok" || String(source.type || "").trim() !== CONVERSATION_ATTACHMENT_RECEIPT) return [];
  return (Array.isArray(source.items) ? source.items : [])
    .slice(0, MAX_CONVERSATION_ATTACHMENT_ITEMS)
    .map((item) => mediaBlock(item))
    .filter(Boolean);
}

function attachmentBlocksFromToolResult(value) {
  if (Array.isArray(value)) return value.flatMap((item) => attachmentBlocksFromToolResult(item?.text ?? item?.content ?? item));
  return attachmentReceipt(value);
}

function textWithWechatMedia(value) {
  const source = String(value ?? "");
  const blocks = [];
  let cursor = 0;
  let found = false;
  while (cursor < source.length) {
    const start = source.indexOf(WECHAT_MEDIA_MANIFEST_OPEN, cursor);
    if (start < 0) break;
    const end = source.indexOf(WECHAT_MEDIA_MANIFEST_CLOSE, start + WECHAT_MEDIA_MANIFEST_OPEN.length);
    if (end < 0) break;
    const encoded = source.slice(start + WECHAT_MEDIA_MANIFEST_OPEN.length, end);
    const manifest = objectValue(parsedObject(encoded));
    const mediaSource = String(manifest.source || "").trim().toLowerCase();
    const media = new Set(["wechat", "iphone"]).has(mediaSource)
      ? (Array.isArray(manifest.items) ? manifest.items : [])
        .slice(0, MAX_CONVERSATION_ATTACHMENT_ITEMS)
        .map((item) => mediaBlock(item, mediaSource))
        .filter(Boolean)
      : [];
    if (!media.length) {
      cursor = end + WECHAT_MEDIA_MANIFEST_CLOSE.length;
      continue;
    }
    const leading = source.slice(cursor, start).trim();
    if (leading) blocks.push({ kind: "text", text: boundedText(leading) });
    blocks.push(...media);
    cursor = end + WECHAT_MEDIA_MANIFEST_CLOSE.length;
    found = true;
  }
  if (!found) return source ? [{ kind: "text", text: boundedText(source) }] : [];
  const trailing = source.slice(cursor).trim();
  if (trailing) blocks.push({ kind: "text", text: boundedText(trailing) });
  return blocks;
}

function voiceCallTranscript(value) {
  const source = String(value ?? "").trim();
  if (!source.startsWith(VOICE_CALL_TURN_OPEN) || !source.endsWith(VOICE_CALL_TURN_CLOSE)) return null;
  const encoded = source.slice(VOICE_CALL_TURN_OPEN.length, -VOICE_CALL_TURN_CLOSE.length).trim();
  try {
    const payload = JSON.parse(encoded);
    return payload?.source === "suzu-live-call" && typeof payload.transcript === "string"
      ? payload.transcript
      : null;
  } catch {
    return null;
  }
}

function voiceCallOpening(value) {
  const source = String(value ?? "").trim();
  if (!source.startsWith(VOICE_CALL_OPEN_OPEN) || !source.endsWith(VOICE_CALL_OPEN_CLOSE)) return false;
  const encoded = source.slice(VOICE_CALL_OPEN_OPEN.length, -VOICE_CALL_OPEN_CLOSE.length).trim();
  try {
    const payload = JSON.parse(encoded);
    return payload?.source === "suzu-live-call" && payload?.event === "open";
  } catch {
    return false;
  }
}

function recordUuid(record) {
  return clean(record?.uuid || record?.message?.uuid);
}

function recordParentUuid(record) {
  return clean(record?.parentUuid || record?.message?.parentUuid);
}

function isConversationContinuationUserRecord(record) {
  const content = record?.message?.content;
  if (isClaudeResumeMetaRecord(record) || isManagedSuzuSkillContext(content)) return true;
  return Array.isArray(content)
    && content.length > 0
    && content.every((part) => part?.type === "tool_result");
}

/**
 * Claude persists a voice turn as an ordinary user record plus its normal
 * response chain.  The protocol marker identifies the root; following parent
 * UUIDs keeps tool/context records in the same call turn without changing what
 * Claude receives or stores.
 */
function voiceCallRecordResolver(records) {
  const byUuid = new Map();
  for (const record of records || []) {
    const uuid = recordUuid(record);
    if (uuid) byUuid.set(uuid, record);
  }
  const resolved = new Map();
  const resolving = new Set();

  const belongsToVoiceCall = (record) => {
    const uuid = recordUuid(record);
    if (uuid && resolved.has(uuid)) return resolved.get(uuid);
    if (uuid && resolving.has(uuid)) return false;
    if (uuid) resolving.add(uuid);

    const content = record?.message?.content;
    let result = false;
    if (record?.type === "user" && (voiceCallTranscript(content) !== null || voiceCallOpening(content))) {
      result = true;
    } else if (record?.type === "user" && !isConversationContinuationUserRecord(record)) {
      // A real typed/inbound user message starts a new normal-chat turn even
      // when its parent is the final reply from a previous call.
      result = false;
    } else {
      const parent = byUuid.get(recordParentUuid(record));
      result = parent ? belongsToVoiceCall(parent) : false;
    }

    if (uuid) {
      resolving.delete(uuid);
      resolved.set(uuid, result);
    }
    return result;
  };

  return belongsToVoiceCall;
}

function callTranscriptBlocks(blocks, speaker) {
  const prefix = `通话 · ${speaker}：`;
  let labelled = false;
  return (blocks || []).map((block) => {
    if (labelled || block?.kind !== "text") return block;
    labelled = true;
    return { ...block, text: `${prefix}${block.text}` };
  });
}

function textWithConversationProtocol(value, { media = false } = {}) {
  const transcript = voiceCallTranscript(value);
  const text = transcript === null ? String(value ?? "") : transcript;
  return media
    ? textWithWechatMedia(text)
    : text ? [{ kind: "text", text: boundedText(text) }] : [];
}

function textParts(content) {
  if (typeof content === "string") return content ? textWithConversationProtocol(content) : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (part?.type === "text" && part.text) return textWithConversationProtocol(part.text, { media: true });
    if (part?.type === "thinking") return [{ kind: "thinking", text: boundedText(part.thinking), preview: boundedText(part.thinking).slice(0, 80) }];
    if (part?.type === "tool_use") return [{ kind: "tool_use", name: boundedText(part.name || "工具"), summary: boundedText(part.input?.command || part.input?.file_path || part.input?.description || "").slice(0, 80), detail: formatJson(part.input || {}) }];
    if (part?.type === "tool_result") {
      const media = part.is_error ? [] : attachmentBlocksFromToolResult(part.content);
      if (media.length) return media;
      return [{ kind: "tool_result", error: Boolean(part.is_error), summary: boundedText(typeof part.content === "string" ? part.content : formatJson(part.content)).slice(0, 80), detail: boundedText(typeof part.content === "string" ? part.content : formatJson(part.content)) }];
    }
    return [];
  });
}

function isManagedSuzuSkillContext(content) {
  const values = typeof content === "string"
    ? [content]
    : Array.isArray(content)
      ? content.filter((part) => part?.type === "text").map((part) => String(part.text || ""))
      : [];
  return values.some((value) => SUZU_MANAGED_SKILL_CONTEXT.test(value));
}

function hasExactTextContent(content, expected) {
  const values = typeof content === "string"
    ? [content]
    : Array.isArray(content)
      ? content.filter((part) => part?.type === "text").map((part) => String(part.text || ""))
      : [];
  return values.length === 1 && values[0].trim() === expected;
}

function isClaudeResumeMetaRecord(record) {
  const message = record?.message || {};
  return record?.type === "user"
    && (record?.isMeta === true || message?.isMeta === true)
    && hasExactTextContent(message.content, CLAUDE_RESUME_META_TEXT);
}

function isClaudeSyntheticNoResponseRecord(record) {
  const message = record?.message || {};
  const parentUuid = clean(record?.parentUuid || message?.parentUuid);
  const model = clean(message?.model || record?.model);
  return record?.type === "assistant"
    && parentUuid
    && model === "<synthetic>"
    && hasExactTextContent(message.content, CLAUDE_SYNTHETIC_NO_RESPONSE_TEXT);
}

function scheduledTaskNotice(content) {
  const values = typeof content === "string"
    ? [content]
    : Array.isArray(content)
      ? content.filter((part) => part?.type === "text").map((part) => String(part.text || ""))
      : [];
  for (const value of values) {
    const source = value.trim();
    if (!source.startsWith(SCHEDULE_TASK_OPEN)) continue;
    const description = /^<suzu-schedule-task>\s*\n任务说明：([^\r\n]+)/u.exec(source)?.[1]?.trim();
    return description ? `定时器触发：${description}` : "自动任务已触发";
  }
  return "";
}

function noReplyBlocks(blocks) {
  const text = blocks.filter((block) => block.kind === "text");
  return text.length === 1 && text[0].text.trim() === "NO_REPLY";
}

export function buildDisplayMessages(records, maxMessages = 500) {
  const messages = [];
  const belongsToVoiceCall = voiceCallRecordResolver(records);
  for (const record of records || []) {
    const type = record?.type;
    const message = record?.message || {};
    const voiceCall = belongsToVoiceCall(record);
    let kind = "";
    let blocks = [];
    let label = "";
    if (type === "user") {
      // Claude Code may append an internal `isMeta` resume marker. It is not
      // person-authored chat content and has a paired synthetic assistant row.
      if (isClaudeResumeMetaRecord(record)) continue;
      // Claude writes the full text of an auto-loaded Skill as a synthetic
      // user record. It is execution context, not something the person sent.
      if (isManagedSuzuSkillContext(message.content)) continue;
      // The call-open marker asks the agent to greet after the line connects.
      // It is transport metadata rather than a sentence the person said.
      if (voiceCallOpening(message.content)) continue;
      const taskNotice = scheduledTaskNotice(message.content);
      if (taskNotice) {
        kind = "system";
        blocks = [{ kind: "text", text: taskNotice }];
      } else {
        blocks = textParts(message.content);
        const hasMedia = blocks.some((block) => block.kind === "media");
        const hasInboundMedia = blocks.some((block) => block.kind === "media" && ["wechat", "iphone"].includes(block.mediaSource));
        const onlyToolResults = blocks.length > 0 && blocks.every((block) => block.kind === "tool_result");
        kind = voiceCall ? "system" : hasInboundMedia ? "user" : hasMedia ? "assistant" : onlyToolResults ? "system" : "user";
        if (voiceCall && voiceCallTranscript(message.content) !== null) blocks = callTranscriptBlocks(blocks, "我");
      }
    }
    else if (type === "assistant") {
      if (isClaudeSyntheticNoResponseRecord(record)) continue;
      kind = voiceCall ? "system" : "assistant";
      blocks = textParts(message.content);
      if (noReplyBlocks(blocks)) continue;
      if (voiceCall) blocks = callTranscriptBlocks(blocks, "对方");
    }
    else if (type === "system") { kind = "system"; blocks = [{ kind: "text", text: boundedText(record.content || (record.subtype ? `[系统: ${record.subtype}]` : "[系统消息]")) }]; }
    else if (type === "attachment" || type === "hook_additional_context") {
      const attachment = record.attachment || record;
      const content = Array.isArray(attachment.content) ? attachment.content.join("\n") : attachment.content;
      if (!content) continue;
      kind = "attachment";
      label = attachment.hookName ? `上下文注入 · ${attachment.hookName}` : attachment.type || "上下文注入";
      blocks = [{ kind: "text", text: boundedText(content) }];
    } else continue;
    if (!blocks.length) continue;
    const lineNumber = normalizedLineNumber(record?.__suzuConversationLine);
    messages.push({
      id: String(record.uuid || message.id || (lineNumber ? `line:${lineNumber}` : `${type}:${messages.length}`)),
      kind,
      label,
      timestamp: String(record.timestamp || ""),
      blocks,
      usage: kind === "assistant" ? normalizeUsage(message.usage, message.model || record.model) : null,
      ...(lineNumber ? { lineNumber } : {}),
    });
  }
  // Claude JSONL is usually chronological, but imported or copied sessions can
  // arrive newest-first. Chat UI must always read from older messages to newer.
  return messages
    .map((message, sourceIndex) => ({
      message,
      sourceIndex,
      timestamp: Date.parse(message.timestamp),
    }))
    .sort((left, right) => {
      const leftValid = Number.isFinite(left.timestamp);
      const rightValid = Number.isFinite(right.timestamp);
      if (leftValid && rightValid && left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
      if (leftValid !== rightValid) return leftValid ? -1 : 1;
      return left.sourceIndex - right.sourceIndex;
    })
    .map(({ message }) => message)
    .slice(-maxMessages);
}

export class JsonlTail {
  constructor(filePath, maxRecords = 2500) { this.filePath = path.resolve(filePath); this.maxRecords = maxRecords; this.refreshing = null; this.reset(); }
  reset() { this.records = []; this.offset = 0; this.identity = ""; this.remainder = ""; this.decoder = new StringDecoder("utf8"); this.scannedRecords = 0; this.malformedLines = 0; this.version = 0; }
  fileIdentity(stat) { return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`; }
  ingest(line) { const value = String(line || "").trim(); if (!value) return; try { this.records.push(JSON.parse(value)); if (this.records.length > this.maxRecords) this.records.splice(0, this.records.length - this.maxRecords); this.scannedRecords += 1; this.version += 1; } catch { this.malformedLines += 1; } }
  async consume(start, end) { if (end < start) return; let text = this.remainder; for await (const chunk of fs.createReadStream(this.filePath, { start, end })) { text += this.decoder.write(chunk); const lines = text.split(/\r?\n/); text = lines.pop() || ""; lines.forEach((line) => this.ingest(line)); } const lines = text.split(/\r?\n/); this.remainder = lines.pop() || ""; lines.forEach((line) => this.ingest(line)); }
  async rescan(stat) { this.records = []; this.offset = 0; this.remainder = ""; this.decoder = new StringDecoder("utf8"); this.scannedRecords = 0; this.malformedLines = 0; this.version += 1; this.identity = this.fileIdentity(stat); if (stat.size) await this.consume(0, stat.size - 1); this.offset = stat.size; }
  async refresh() { if (this.refreshing) return this.refreshing; this.refreshing = this.refreshNow().finally(() => { this.refreshing = null; }); return this.refreshing; }
  async refreshNow() { const stat = await fsp.stat(this.filePath); const identity = this.fileIdentity(stat); if (!this.identity || identity !== this.identity || stat.size < this.offset) return this.rescan(stat); if (stat.size > this.offset) { await this.consume(this.offset, stat.size - 1); this.offset = stat.size; } }
}

export async function searchTranscript(filePath, query, limit = 100) {
  const request = searchRequest(query);
  const needle = normalizedSearchText(request.query);
  if (request.category === "messages" && !needle) throw new Error("请输入搜索内容。");
  if (request.category === "date" && !DATE_QUERY_PATTERN.test(request.query)) throw new Error("请选择要查找的日期。");
  if (Array.from(needle).length > 200) throw new Error("搜索内容不能超过 200 个字符。");
  const matches = []; let lineNumber = 0; let scannedRecords = 0; let malformedLines = 0; let matchedRecords = 0;
  const lines = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); scannedRecords += 1; }
    catch { malformedLines += 1; continue; }
    const displayRecord = safeValue(record);
    displayRecord.__suzuConversationLine = lineNumber;
    const messages = buildDisplayMessages([displayRecord], 1);
    if (!matchesSearchRequest(record, messages, request)) continue;
    matchedRecords += 1;
    matches.push({
      lineNumber,
      messageId: String(messages[0]?.id || ""),
      timestamp: String(messages[0]?.timestamp || ""),
      messages,
    });
    if (matches.length > limit) matches.shift();
  }
  return { query: request.query, category: request.category, scannedRecords, malformedLines, matchedRecords, truncated: matchedRecords > matches.length, matches };
}

export async function readTranscriptWindow(filePath, lineNumber, { before = 24, after = 24 } = {}) {
  const focusLineNumber = normalizedLineNumber(lineNumber);
  if (!focusLineNumber) throw new Error("缺少要定位的聊天记录。");
  const previous = Math.min(Math.max(Number(before) || 0, 0), 100);
  const following = Math.min(Math.max(Number(after) || 0, 0), 100);
  const startLine = Math.max(1, focusLineNumber - previous);
  const endLine = focusLineNumber + following;
  const records = [];
  let currentLine = 0;
  const lines = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    currentLine += 1;
    if (currentLine > endLine) break;
    if (currentLine < startLine || !line.trim()) continue;
    try {
      const record = safeValue(JSON.parse(line));
      record.__suzuConversationLine = currentLine;
      records.push(record);
    } catch { /* A malformed line cannot be rendered as conversation context. */ }
  }
  return {
    focusLineNumber,
    startLine,
    endLine: Math.min(endLine, currentLine || endLine),
    messages: buildDisplayMessages(records, previous + following + 1),
  };
}
