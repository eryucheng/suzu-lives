import { compactNumber, dateTime } from "../../core/formatters.mjs";
import {
  AVATAR_CROP_MAX_ZOOM,
  AVATAR_CROP_MIN_ZOOM,
  AVATAR_CROP_OUTPUT_SIZE,
  avatarCropLayout,
  avatarCropSourceRect,
  createSquareAvatarCrop,
  moveAvatarCrop,
  readAvatarFile,
  resizeAvatarCropViewport,
  setAvatarCropZoom,
} from "../../core/avatar-file.mjs";
import { getAgentProfile, getIdentity, profileInitial } from "../../core/identity.mjs";
import { endActiveConversationCall } from "../../react/conversation-call-coordinator.mjs";
import { parseSuzuConversationCommand } from "../../../shared/conversation-command.mjs";

export { parseSuzuConversationCommand } from "../../../shared/conversation-command.mjs";

const viewState = {
  attachments: [],
  attachmentPicking: false,
  avatarCrop: null,
  busySessions: new Set(),
  transientSystemMessages: [],
  composerFocusRequest: 0,
  contactCreateOpen: false,
  contactContextMenu: null,
  contactRenameOpen: false,
  draft: "",
  emojiOpen: false,
  error: "",
  focus: null,
  lastVersion: null,
  liveReplies: new Map(),
  liveTools: [],
  listScrollTop: 0,
  loading: false,
  menuOpen: false,
  mode: "snapshot",
  mediaPreview: null,
  notice: "",
  pending: [],
  permissions: new Map(),
  search: null,
  searchCategory: "messages",
  searchError: "",
  searchFocusRequest: 0,
  searchLoading: false,
  searchOpen: false,
  searchQuery: "",
  sending: false,
  settingsOpen: false,
  settingsLoading: false,
  shouldStickToLatest: true,
  scrollTarget: null,
  scrollToLatestRequest: 0,
  snapshot: null,
  timer: null,
  unread: false,
  unsubscribe: null,
  wechatSnapshot: null,
  wechatQrOpen: false,
  wechatUnsubscribe: null,
};

const TRANSCRIPT_MATCH_GRACE_MS = 5_000;

// Direct terminal work should be inspectable in the normal chat flow.  Other
// optional diagnostic blocks remain opt-in, but tool calls/results are shown
// unless the user explicitly hides them.
const defaults = { attachments: false, tools: true, thinking: false, system: false, tokens: false, timeDisplay: "center" };
const CENTER_TIME_GAP_MS = 5 * 60 * 1_000;

function preferences(settings) {
  return { ...defaults, ...(settings?.conversationPreferences || {}) };
}

function clean(value) {
  return String(value ?? "").trim();
}

function unreadCount(contact) {
  return Number.isSafeInteger(contact?.unreadCount) && contact.unreadCount >= 0 ? contact.unreadCount : 0;
}

export function isScheduledAgentReply(event) {
  return clean(event?.kind) === "schedule"
    && clean(event?.type) === "agent-reply"
    && event?.displayAsSystem !== true
    && Boolean(clean(event?.content));
}

function contactContextMenuPosition(point = {}) {
  const width = typeof window === "undefined" ? 0 : Number(window.innerWidth) || 0;
  const height = typeof window === "undefined" ? 0 : Number(window.innerHeight) || 0;
  const x = Math.round(Number(point?.x));
  const y = Math.round(Number(point?.y));
  return {
    x: Math.max(12, Math.min(Number.isFinite(x) ? x : 12, width ? Math.max(12, width - 208) : Number.POSITIVE_INFINITY)),
    y: Math.max(12, Math.min(Number.isFinite(y) ? y : 12, height ? Math.max(12, height - 252) : Number.POSITIVE_INFINITY)),
  };
}

function sameProjectRoot(left, right) {
  const normalize = (value) => clean(value).replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
  const first = normalize(left);
  const second = normalize(right);
  return Boolean(first && second && first === second);
}

export function shouldSubmitConversationOnEnter(event) {
  return event?.key === "Enter"
    && !event.shiftKey
    && !event.ctrlKey
    && !event.altKey
    && !event.metaKey;
}

function messageText(message) {
  return (message?.blocks || [])
    .filter((block) => block.kind === "text")
    .map((block) => clean(block.text))
    .filter(Boolean)
    .join("\n");
}

function hasDisplayableBlock(message) {
  return (message?.blocks || []).some((block) => clean(block?.text || block?.detail || block?.summary));
}

function mediaSignature(value) {
  const source = value && typeof value === "object" ? value : {};
  const kind = clean(source.mediaKind === "sticker" ? "image" : source.mediaKind || source.kind).toLowerCase();
  const fileName = clean(source.fileName).toLowerCase();
  const size = Number(source.size);
  return kind && fileName && Number.isSafeInteger(size) && size > 0 ? `${kind}\u0000${fileName}\u0000${size}` : "";
}

function sameMedia(items, expected) {
  const requested = (Array.isArray(expected) ? expected : []).map(mediaSignature).filter(Boolean);
  if (!requested.length) return true;
  const available = new Map();
  for (const block of Array.isArray(items) ? items : []) {
    const signature = mediaSignature(block);
    if (signature) available.set(signature, (available.get(signature) || 0) + 1);
  }
  return requested.every((signature) => {
    const remaining = Number(available.get(signature)) || 0;
    if (remaining < 1) return false;
    available.set(signature, remaining - 1);
    return true;
  });
}

function messageMatches(items, kind, content, localTimestamp, media = []) {
  const target = clean(content);
  const expectedMedia = Array.isArray(media) ? media : [];
  if (!target && !expectedMedia.length) return false;
  const localTime = Date.parse(localTimestamp);
  return (items || []).some((item) => {
    if (item.kind !== kind) return false;
    if (target && messageText(item) !== target) return false;
    if (!sameMedia(item.blocks, expectedMedia)) return false;
    if (!Number.isFinite(localTime)) return true;
    const transcriptTime = Date.parse(item.timestamp);
    return Number.isFinite(transcriptTime) && transcriptTime >= localTime - TRANSCRIPT_MATCH_GRACE_MS;
  });
}

function conversationPreview(items) {
  const last = [...(items || [])].reverse().find((item) => ["user", "assistant"].includes(item.kind) && messageText(item));
  return last ? messageText(last).replace(/\s+/gu, " ").slice(0, 38) : "还没有消息";
}

function conversationDay(timestamp) {
  const date = dateFromTimestamp(timestamp);
  if (!date) return "";
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function dateFromTimestamp(value) {
  const source = value instanceof Date ? value : clean(value);
  if (!source) return null;
  const date = new Date(source);
  return Number.isFinite(date.getTime()) ? date : null;
}

function sameCalendarDay(left, right) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function timeOfDay(date) {
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function timeDisplay(prefs) {
  return prefs?.timeDisplay === "bubble" ? "bubble" : "center";
}

function longTermMemoryEnabled(value) {
  return value !== false;
}

export function shouldShowCenteredTimeDivider(previousTimestamp, timestamp) {
  const current = dateFromTimestamp(timestamp);
  if (!current) return false;
  const previous = dateFromTimestamp(previousTimestamp);
  if (!previous) return true;
  if (!sameCalendarDay(previous, current)) return true;
  return current.getTime() - previous.getTime() >= CENTER_TIME_GAP_MS;
}

export function wechatTimeLabel(timestamp, now = new Date()) {
  const date = dateFromTimestamp(timestamp);
  const current = dateFromTimestamp(now);
  if (!date) return "";
  const clock = timeOfDay(date);
  if (!current || sameCalendarDay(date, current)) return clock;

  const yesterday = new Date(current);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameCalendarDay(date, yesterday)) return `昨天 ${clock}`;

  const recentStart = new Date(current);
  recentStart.setHours(0, 0, 0, 0);
  recentStart.setDate(recentStart.getDate() - 6);
  if (date >= recentStart && date < current) return `${date.toLocaleDateString("zh-CN", { weekday: "long" })} ${clock}`;

  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === current.getFullYear() ? `${monthDay} ${clock}` : `${date.getFullYear()}年${monthDay} ${clock}`;
}

function timestampsFollowAppendOrder(items) {
  let previousTimestamp = Number.NaN;
  for (const item of items || []) {
    const timestamp = Date.parse(item?.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    if (Number.isFinite(previousTimestamp) && timestamp < previousTimestamp) return false;
    previousTimestamp = timestamp;
  }
  return true;
}

function insertLiveReplyAtTimestamp(items, reply) {
  const timestamp = Date.parse(reply?.timestamp);
  if (!Number.isFinite(timestamp)) return [...items, reply];
  const index = items.findIndex((item) => {
    const itemTimestamp = Date.parse(item?.timestamp);
    return Number.isFinite(itemTimestamp) && itemTimestamp > timestamp;
  });
  return index < 0
    ? [...items, reply]
    : [...items.slice(0, index), reply, ...items.slice(index)];
}

function liveReplySentences(item) {
  const recorded = Array.isArray(item?.sentences)
    ? item.sentences.map((value) => String(value ?? "")).filter((value) => clean(value))
    : [];
  if (recorded.length) return recorded;
  const fallback = String(item?.content ?? "");
  return clean(fallback) ? [fallback] : [];
}

function liveReplyValues(value) {
  return value instanceof Map ? [...value.values()] : Array.isArray(value) ? value : [];
}

export function companionPeerLabel(contactName, activeSessionId = "", liveReplyItems = new Map()) {
  const peer = clean(contactName) || "未选择联系人";
  const sessionId = clean(activeSessionId);
  if (!sessionId) return peer;
  const isThinking = liveReplyValues(liveReplyItems).some((item) => (
    clean(item?.sessionId) === sessionId
    && item?.done !== true
    && item?.phase === "thinking"
  ));
  return isThinking ? "对方正在输入中..." : peer;
}

function liveReplyMessages(item) {
  const id = clean(item?.requestId) || "reply";
  return liveReplySentences(item).map((text, index) => ({
    id: `reply-${id}-sentence-${index + 1}`,
    kind: "assistant",
    sourceMessageId: `reply-${id}`,
    // A bubble only enters this projection after a whole sentence is ready,
    // so it must never use the token-streaming visual treatment.
    streaming: false,
    timestamp: item.timestamp,
    blocks: [{ kind: "text", text }],
  }));
}

export function mergeConversationMessages(items, pendingItems = [], liveReplyItems = new Map(), activeSessionId = "", transientSystemMessages = [], transientToolMessages = []) {
  const source = Array.isArray(items) ? items : [];
  const sessionId = clean(activeSessionId);
  const pending = (Array.isArray(pendingItems) ? pendingItems : [])
    .filter((item) => item.sessionId === sessionId && !messageMatches(source, "user", item.content, item.timestamp, item.media))
    .map((item) => ({
      id: item.id,
      kind: "user",
      pending: !item.accepted,
      accepted: item.accepted,
      queued: item.queued,
      queuePosition: item.queuePosition,
      steering: item.steering,
      timestamp: item.timestamp,
      blocks: [
        ...(clean(item.content) ? [{ kind: "text", text: item.content }] : []),
        ...(Array.isArray(item.media) ? item.media.map((media) => ({
          kind: "media",
          mediaKind: clean(media?.mediaSource) === "sticker" && clean(media?.kind) === "image" ? "sticker" : clean(media?.kind) || "file",
          fileName: clean(media?.fileName),
          fileUrl: clean(media?.fileUrl),
          size: Number(media?.size) || 0,
          ...(clean(media?.mediaSource) ? { mediaSource: clean(media.mediaSource) } : {}),
        })).filter((media) => media.fileName && media.fileUrl && media.size > 0) : []),
      ],
    }));
  const replyValues = liveReplyValues(liveReplyItems);
  const liveReplies = replyValues
    .filter((item) => (
      item.sessionId === sessionId
      && (!clean(item.content) || !messageMatches(source, "assistant", item.content, item.timestamp))
    ))
    .flatMap(liveReplyMessages);
  const localMessages = [
    ...(Array.isArray(transientSystemMessages) ? transientSystemMessages : []),
    ...(Array.isArray(transientToolMessages) ? transientToolMessages : []),
  ].filter((item) => (
    ["assistant", "system"].includes(item?.kind)
      && clean(item.sessionId) === sessionId
      && hasDisplayableBlock(item)
      // A finalized call transcript first appears immediately as a local
      // system row, then arrives durably from Agent Core.  Retire only that
      // exact local duplicate once the stored conversation has caught up.
      && (item.kind !== "system" || !messageMatches(source, "system", messageText(item), item.timestamp))
  ));
  const appended = [...source, ...pending, ...localMessages];
  // Source rows are already in the transcript's append order.  Preserve that
  // order for special turns such as calls; only place a local unfinished reply
  // back between normal chronological rows so a later message can push it up.
  return timestampsFollowAppendOrder(appended)
    ? liveReplies.reduce((result, reply) => insertLiveReplyAtTimestamp(result, reply), appended)
    : [...appended, ...liveReplies];
}

function displayedMessages(items) {
  return mergeConversationMessages(
    items,
    viewState.pending,
    viewState.liveReplies,
    clean(viewState.snapshot?.activeSessionId),
    viewState.transientSystemMessages,
    viewState.liveTools,
  );
}

export function filterConversationItems(items, configuredPreferences = {}) {
  const prefs = { ...defaults, ...configuredPreferences };
  return (items || []).flatMap((item) => {
    if ((item.kind === "attachment" && !prefs.attachments) || (item.kind === "system" && !prefs.system)) return [];
    const blocks = (item.blocks || []).filter((value) => {
      if (value.kind === "thinking") return prefs.thinking;
      return !((value.kind === "tool_use" || value.kind === "tool_result") && !prefs.tools);
    });
    return blocks.length || (item.kind === "assistant" && prefs.tokens && item.usage) ? [{ ...item, blocks }] : [];
  });
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

/**
 * Turn a companion reply into durable chat bubbles without exposing a token
 * stream.  Until `final` is set, trailing unfinished text stays in
 * `remainder` and therefore never reaches the renderer.
 */
export function splitCompanionReplyBuffer(value, { final = false } = {}) {
  const text = String(value ?? "").replace(/\r\n?/gu, "\n");
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

function mergeLiveReplyContent(previous, next) {
  const current = String(previous ?? "");
  const candidate = String(next ?? "");
  if (!candidate) return current;
  if (!current || candidate.startsWith(current)) return candidate;
  if (current.startsWith(candidate)) return current;
  return `${current}${candidate}`;
}

function liveReplyTimestamp(previous, event) {
  return clean(previous?.timestamp) || clean(event?.timestamp) || new Date().toISOString();
}

function projectedLiveReply(previous, event, { final = false } = {}) {
  const content = mergeLiveReplyContent(previous?.content, event?.content);
  const delivery = splitCompanionReplyBuffer(content, { final });
  const previousCount = Array.isArray(previous?.sentences) ? previous.sentences.length : 0;
  const deliveredNewSentence = delivery.sentences.length > previousCount;
  return {
    ...previous,
    content,
    done: final,
    phase: final ? "idle" : deliveredNewSentence ? "delivering" : previous?.phase === "thinking" ? "thinking" : "thinking",
    remainder: delivery.remainder,
    requestId: clean(event?.requestId) || clean(previous?.requestId),
    sentences: delivery.sentences,
    sessionId: clean(event?.sessionId) || clean(previous?.sessionId),
    timestamp: liveReplyTimestamp(previous, event),
  };
}

function finishedLiveReply(reply) {
  if (!reply) return null;
  const delivery = splitCompanionReplyBuffer(reply.content, { final: true });
  return {
    ...reply,
    done: true,
    phase: "idle",
    remainder: delivery.remainder,
    sentences: delivery.sentences,
  };
}

export function splitAssistantMessageOnBlankLines(message) {
  if (message?.kind !== "assistant" || !Array.isArray(message.blocks)) return [message];
  const segments = [[]];
  let split = false;
  for (const item of message.blocks) {
    if (item?.kind !== "text") {
      segments.at(-1).push(item);
      continue;
    }
    const parts = splitCompanionReplyBuffer(item.text, { final: true }).sentences;
    segments.at(-1).push(parts.length ? { ...item, text: parts[0] } : item);
    if (parts.length < 2) continue;
    split = true;
    for (const text of parts.slice(1)) segments.push([{ ...item, text }]);
  }
  if (!split) return [message];
  return segments.filter((blocks) => blocks.length).map((blocks, index, all) => {
    const last = index === all.length - 1;
    return {
      ...message,
      id: `${message.id || "assistant"}-part-${index + 1}`,
      sourceMessageId: clean(message.sourceMessageId || message.id),
      blocks,
      streaming: Boolean(message.streaming && last),
      usage: last ? message.usage : null,
    };
  });
}

function avatarPayload(profile, fallback) {
  return {
    initial: profileInitial(profile, fallback),
    src: clean(profile?.avatarDataUrl),
  };
}

function attachmentSize(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function messageSourceId(message) {
  return clean(message?.sourceMessageId || message?.id);
}

function messageLineNumber(message) {
  const lineNumber = Number(message?.lineNumber);
  return Number.isSafeInteger(lineNumber) && lineNumber > 0 ? lineNumber : 0;
}

function imageMediaItem(value, message) {
  const url = clean(value?.fileUrl);
  if (value?.kind !== "media" || !["image", "sticker"].includes(value?.mediaKind) || !url) return null;
  const messageId = messageSourceId(message);
  const lineNumber = messageLineNumber(message);
  const name = clean(value.fileName) || "图片附件";
  return {
    key: encodeURIComponent([messageId || `line:${lineNumber}`, url, name].join("|")),
    lineNumber,
    messageId,
    name,
    url,
  };
}

function messageBlock(value, prefs, message) {
  if (!value) return null;
  if (value.kind === "text") return { text: String(value.text ?? ""), type: "text" };
  if (value.kind === "media") {
    if (value.mediaKind === "audio") return null;
    const imageName = clean(value.fileName) || "图片附件";
    const imageItem = imageMediaItem(value, message);
    const sticker = value.mediaKind === "sticker";
    return {
      fileName: clean(value.fileName) || "未命名附件",
      fileUrl: clean(value.fileUrl),
      mediaKind: sticker ? "sticker" : value.mediaKind === "image" ? "image" : "file",
      preview: imageItem,
      size: attachmentSize(value.size),
      type: "media",
      typeLabel: sticker ? "表情包" : value.mediaKind === "image" ? "图片" : "文件",
    };
  }
  if (value.kind === "thinking" && !prefs.thinking) return null;
  if ((value.kind === "tool_use" || value.kind === "tool_result") && !prefs.tools) return null;
  const title = value.kind === "thinking"
    ? `思考 · ${value.preview || ""}`
    : value.kind === "tool_use"
      ? `工具调用 · ${value.name}${value.summary ? ` · ${value.summary}` : ""}`
      : `${value.error ? "工具结果（错误）" : "工具结果"}${value.summary ? ` · ${value.summary}` : ""}`;
  return { detail: String(value.text || value.detail || ""), title, type: "detail" };
}

function usagePayload(value) {
  if (!value) return null;
  const fields = [
    ["输入", value.input],
    ["缓存写入", value.cacheCreation],
    ["缓存读取", value.cacheRead],
    ["输出", value.output],
    ["合计", value.total],
  ].filter(([, number]) => number !== null).map(([label, number]) => ({ label, value: compactNumber(number) }));
  return { fields, model: clean(value.model) };
}

function messageBlocks(message, prefs) {
  return (message.blocks || []).flatMap((item) => {
    if (item?.kind === "media" && item.mediaKind === "audio") {
      return [{
        fileName: clean(item.fileName) || "语音消息",
        fileUrl: clean(item.fileUrl),
        type: "audio",
      }];
    }
    const payload = messageBlock(item, prefs, message);
    return payload ? [payload] : [];
  });
}

function messageRow(message, context, showTimestamp = true) {
  const prefs = preferences(context.state.settings);
  if ((message.kind === "attachment" && !prefs.attachments) || (message.kind === "system" && !prefs.system)) return null;
  const profile = message.kind === "user"
    ? getIdentity(context.state.settings).owner
    : message.kind === "assistant"
      ? getAgentProfile(context.state.settings)
      : null;
  const blocks = messageBlocks(message, prefs);
  const mediaOnly = message.blocks.length === 1 && message.blocks[0]?.kind === "media";
  const usageMeta = prefs.tokens && message.kind === "assistant" ? usagePayload(message.usage) : null;
  if (!blocks.length && !usageMeta) return null;
  const timestamp = showTimestamp && message.timestamp ? dateTime(message.timestamp) : "";
  const sourceMessageId = messageSourceId(message);
  const lineNumber = messageLineNumber(message);
  const anchorId = clean(message.id) || sourceMessageId || (lineNumber ? `line-${lineNumber}` : "");
  const focusLineNumber = messageLineNumber(viewState.focus);
  const focusMessageId = clean(viewState.focus?.focusMessageId);
  const focused = (lineNumber && lineNumber === focusLineNumber) || (sourceMessageId && sourceMessageId === focusMessageId);
  return {
    anchorId,
    avatar: profile ? avatarPayload(profile, profile.displayName) : null,
    blocks,
    focused,
    kind: clean(message.kind),
    lineNumber,
    live: Boolean(message.pending || message.streaming),
    mediaOnly,
    sourceMessageId,
    timestamp,
    type: "message",
    usage: usageMeta,
  };
}

export function conversationMessageRows(items, context, searched = false) {
  const prefs = preferences(context.state.settings);
  const style = timeDisplay(prefs);
  let previousDay = "";
  let previousTimestamp = "";
  const rows = [];
  for (const item of filterConversationItems(items, prefs).flatMap(splitAssistantMessageOnBlankLines)) {
    const next = messageRow(item, context, style === "bubble");
    if (!next) continue;
    if (style === "center") {
      if (shouldShowCenteredTimeDivider(previousTimestamp, item.timestamp)) {
        rows.push({ label: wechatTimeLabel(item.timestamp), type: "time" });
      }
      if (dateFromTimestamp(item.timestamp)) previousTimestamp = item.timestamp;
    } else {
      const day = conversationDay(item.timestamp);
      if (day && day !== previousDay) rows.push({ label: day, type: "day" });
      previousDay = day || previousDay;
    }
    rows.push(next);
  }
  return rows.length
    ? rows
    : [{ text: searched ? "有搜索命中，但都被当前显示设置隐藏。" : "这位联系人还没有可展示的内容。", type: "empty" }];
}

function scheduleScrollToLatest() {
  if (!viewState.shouldStickToLatest) return;
  viewState.scrollToLatestRequest += 1;
  viewState.unread = false;
}

function focusComposer() {
  viewState.composerFocusRequest += 1;
}

function focusSearchInput() {
  viewState.searchFocusRequest += 1;
}

function currentPayload() {
  return viewState.mode === "focus" ? viewState.focus : viewState.snapshot;
}

function conversationInfo(payload) {
  if (viewState.error) return viewState.error;
  if (viewState.mode === "focus") return "已定位到搜索结果附近的聊天记录。";
  if (payload?.status === "missing") return "软件数据目录尚未准备好，请稍后重试。";
  return `本机 Suzu Agent Core · ${payload?.fileName || "新对话"} · ${payload?.scannedRecords || 0} 条记录`;
}

function renderKeepingConversationScroll(context) {
  context.render();
}

const searchCategories = [
  { id: "messages", label: "聊天记录", hint: "关键词" },
  { id: "images", label: "图片", hint: "全部图片" },
  { id: "files", label: "文件", hint: "附件文件" },
  { id: "audio", label: "语音", hint: "音频附件" },
  { id: "links", label: "链接", hint: "网页链接" },
  { id: "date", label: "日期", hint: "按天查找" },
];

function searchCategoryInfo(value) {
  return searchCategories.find((item) => item.id === value) || searchCategories[0];
}

function searchMessages(result) {
  return (result?.matches || []).flatMap((match) => (match?.messages || []).map((message) => ({
    ...message,
    lineNumber: messageLineNumber(message) || messageLineNumber(match),
    sourceMessageId: messageSourceId(message) || clean(match?.messageId),
  })));
}

function imageGalleryFromMessages(messages) {
  return (messages || []).flatMap((message) => (message?.blocks || [])
    .map((value) => imageMediaItem(value, message))
    .filter(Boolean));
}

function imageGalleryFromSearch(result) {
  return imageGalleryFromMessages(searchMessages(result));
}

function currentImageGallery() {
  if (viewState.searchOpen && viewState.search?.category === "images") {
    const images = imageGalleryFromSearch(viewState.search);
    if (images.length) return images;
  }
  const payload = currentPayload();
  const messages = viewState.mode === "snapshot"
    ? displayedMessages(payload?.messages || [])
    : (payload?.messages || []);
  return imageGalleryFromMessages(messages);
}

function searchResultKind(message) {
  if (message?.kind === "user") return "我";
  if (message?.kind === "assistant") return "Agent";
  if (message?.kind === "system") return "系统";
  if (message?.kind === "attachment") return "上下文";
  return "聊天记录";
}

function searchResultSummary(match) {
  const message = (match?.messages || [])[0] || {};
  const text = clean(messageText(message));
  if (text) return text.replace(/\s+/gu, " ").slice(0, 180);
  const files = (message?.blocks || [])
    .filter((block) => block?.kind === "media")
    .map((block) => clean(block.fileName))
    .filter(Boolean);
  return files.join(" · ") || clean(message.label) || "聊天记录";
}

function conversationSearchSnapshot() {
  if (!viewState.searchOpen) return null;
  const category = searchCategoryInfo(viewState.searchCategory);
  const isDate = category.id === "date";
  const placeholder = isDate
    ? "选择日期"
    : category.id === "messages"
      ? "搜索当前聊天"
      : `按名称筛选${category.label}（可选）`;
  const resultCount = viewState.search && !viewState.searchLoading
    ? ` · ${Number(viewState.search.matchedRecords || 0).toLocaleString("zh-CN")} 条结果`
    : "";
  const result = viewState.search;
  const matches = Array.isArray(result?.matches) ? result.matches : [];
  let empty = "";
  let error = "";
  let images = [];
  let results = [];
  if (viewState.searchLoading) {
    empty = "正在搜索本地聊天记录…";
  } else if (viewState.searchError) {
    error = viewState.searchError;
  } else if (!result) {
    empty = "输入关键词，或选择一个分类开始查找。";
  } else if (!matches.length) {
    empty = "没有找到匹配的聊天内容。";
  } else if (result.category === "images") {
    images = imageGalleryFromSearch(result);
    if (!images.length) empty = "没有找到可预览的图片。";
  } else {
    results = matches.map((match) => {
      const message = (match.messages || [])[0] || {};
      const lineNumber = messageLineNumber(message) || messageLineNumber(match);
      const messageId = messageSourceId(message) || clean(match.messageId);
      const timestamp = clean(message.timestamp || match.timestamp);
      return {
        kind: searchResultKind(message),
        lineNumber,
        messageId,
        summary: searchResultSummary(match),
        timestamp: dateTime(timestamp),
      };
    });
  }
  return {
    categories: searchCategories,
    category,
    empty,
    error,
    images,
    inputType: isDate ? "date" : "search",
    matchesLabel: result ? `${category.label}${resultCount}` : category.label,
    matchesNote: result ? "点击结果跳转到原消息" : "按 Enter 搜索",
    placeholder,
    query: viewState.searchQuery,
    results,
  };
}

function scrollToConversationMessage({ lineNumber, messageId } = {}) {
  const wantedLine = messageLineNumber({ lineNumber });
  const wantedMessageId = clean(messageId);
  if (!wantedLine && !wantedMessageId) return;
  viewState.scrollTarget = {
    lineNumber: wantedLine,
    messageId: wantedMessageId,
    request: Number(viewState.scrollTarget?.request || 0) + 1,
  };
}

function activeSession(payload) {
  const id = clean(payload?.activeSessionId);
  return (payload?.sessions || []).find((session) => session.id === id) || null;
}

function sessionSettingsSnapshot(context, selected, prefs) {
  const contact = viewState.snapshot?.activeContact || null;
  const contactId = clean(contact?.id);
  const sessionId = clean(selected?.id);
  if (!contactId) return null;
  const contactName = clean(contact?.name) || clean(selected?.title) || "未命名联系人";
  const agent = getAgentProfile(context.state.settings);
  const wechat = viewState.wechatSnapshot;
  const connection = wechat?.session || null;
  const pendingQr = wechat?.pendingQr || null;
  const masterEnabled = wechat?.enabled === true;
  const connectionLabel = !wechat
    ? "正在读取微信连接状态"
    : !masterEnabled
      ? "全局连接已关闭"
      : connection
        ? (connection.enabled ? (connection.status === "connected" ? "已连接" : "已保存，正在恢复") : "这位联系人的微信连接已暂停")
        : pendingQr
        ? (pendingQr.status === "scanned" ? "手机已扫码，请在微信确认" : "等待微信扫码")
          : "尚未连接";
  const wechatControl = !wechat
    ? null
    : !masterEnabled
      ? { type: "open-capability" }
      : connection
        ? { enabled: Boolean(connection.enabled), type: "connection" }
        : pendingQr
          ? { type: "pending-qr" }
          : { type: "begin" };
  return {
    contactAvatar: contact ? avatarPayload(agent, contactName) : null,
    contactId,
    contactName,
    hasSession: Boolean(sessionId),
    preferences: Object.entries({
      attachments: "显示 Hook / 上下文",
      tools: "显示工具调用",
      thinking: "显示思考内容",
      system: "显示系统消息",
      tokens: "显示 Token 用量",
    }).map(([key, label]) => ({ checked: Boolean(prefs[key]), key, label })),
    longTermMemoryEnabled: longTermMemoryEnabled(contact?.longTermMemoryEnabled),
    removeContactAvatar: Boolean(agent.avatarDataUrl),
    sessionId,
    timeDisplay: timeDisplay(prefs),
    visible: viewState.settingsOpen,
    wechat: contactId ? {
      connectionError: clean(connection?.lastError),
      control: wechatControl,
      enabled: Boolean(connection?.enabled),
      hint: Boolean(connection),
      pendingQrError: clean(pendingQr?.error),
      status: connectionLabel,
    } : null,
  };
}

function contactRenameSnapshot() {
  if (!viewState.contactRenameOpen) return null;
  const contact = viewState.snapshot?.activeContact || null;
  const contactId = clean(contact?.id);
  if (!contactId) return null;
  return {
    contactId,
    name: clean(contact?.name),
    saving: viewState.sending,
  };
}

function wechatQrSnapshot(contact) {
  const pendingQr = viewState.wechatSnapshot?.pendingQr;
  const imageDataUrl = clean(pendingQr?.imageDataUrl);
  if (!viewState.wechatQrOpen || !imageDataUrl) return null;
  const title = clean(contact?.name) || "当前联系人";
  return {
    imageDataUrl,
    status: pendingQr?.status === "scanned"
      ? "已扫码，请在手机微信中确认，并发送一条文字消息。"
      : "请使用要绑定这位联系人的微信扫描二维码。",
    title,
  };
}

function mediaPreviewSnapshot() {
  const preview = viewState.mediaPreview;
  const items = Array.isArray(preview?.items) && preview.items.length
    ? preview.items
    : preview?.url
      ? [preview]
      : [];
  const index = Math.min(Math.max(Number(preview?.index) || 0, 0), Math.max(items.length - 1, 0));
  const item = items[index] || null;
  const imageUrl = clean(item?.url);
  if (!imageUrl) return null;
  const imageName = clean(item?.name) || "图片附件";
  return {
    imageName,
    imageUrl,
    index,
    lineNumber: item.lineNumber || 0,
    messageId: clean(item.messageId),
    nextDisabled: index >= items.length - 1,
    previousDisabled: index <= 0,
    total: items.length,
  };
}

function avatarCropSnapshot() {
  const crop = viewState.avatarCrop;
  if (!crop?.source) return null;
  const layout = avatarCropLayout(crop);
  return {
    layout,
    maxZoom: AVATAR_CROP_MAX_ZOOM,
    minZoom: AVATAR_CROP_MIN_ZOOM,
    source: crop.source,
    zoom: Math.round(layout.zoom * 100),
  };
}

function permissionPromptSnapshot(sessionId) {
  return [...viewState.permissions.values()]
    .filter((item) => item.sessionId === sessionId)
    .map((item) => ({
      preview: clean(item.preview),
      requestId: clean(item.requestId),
      toolName: clean(item.toolName) || "工具",
    }));
}

export function conversationReactSnapshot(context) {
  const payload = currentPayload();
  const sourceEntries = payload?.messages || [];
  const entries = viewState.mode === "focus" ? sourceEntries : displayedMessages(sourceEntries);
  const prefs = preferences(context.state.settings);
  const snapshot = viewState.snapshot || {};
  const historyAvailable = snapshot.history?.status !== "unavailable";
  const ready = (snapshot.status || payload?.status) === "ready" && historyAvailable;
  const agent = getAgentProfile(context.state.settings);
  const identity = getIdentity(context.state.settings);
  const selected = activeSession(snapshot);
  const contacts = snapshot.contacts || [];
  const activeContact = snapshot.activeContact || null;
  const hasContactsRoot = Boolean(clean(snapshot.contactsRoot || context.state.settings?.contactsRoot));
  const contactPeer = clean(activeContact?.name) || "未选择联系人";
  const peer = companionPeerLabel(contactPeer, clean(snapshot.activeSessionId), viewState.liveReplies);
  const callAvailable = ready && Boolean(clean(activeContact?.agentId));
  const preferredContactId = clean(snapshot.preferredContactId);
  const allContactRows = contacts.map((contact) => {
    const name = clean(contact?.name) || "未命名联系人";
    const selectedContact = clean(activeContact?.id) === clean(contact?.id);
    const contactAgent = identity?.agents?.[clean(contact?.agentId)] || identity?.defaultAgent || { displayName: name, avatarDataUrl: "" };
    const contactUnreadCount = unreadCount(contact);
    return {
      avatar: avatarPayload(contactAgent, name),
      hidden: contact?.hidden === true,
      id: clean(contact?.id),
      muted: contact?.muted === true,
      name,
      pinned: contact?.pinned === true,
      preferred: clean(contact?.id) === preferredContactId,
      selected: selectedContact,
      unread: contactUnreadCount > 0,
      unreadCount: contactUnreadCount,
    };
  });
  const contactRows = allContactRows.filter((contact) => !contact.hidden);
  const contextMenuState = viewState.contactContextMenu;
  const contextMenuContact = contactRows.find((contact) => contact.id === clean(contextMenuState?.contactId)) || null;
  const contactContextMenu = contextMenuContact
    ? {
      contactId: contextMenuContact.id,
      contactName: contextMenuContact.name,
      hidden: contextMenuContact.hidden,
      muted: contextMenuContact.muted,
      pinned: contextMenuContact.pinned,
      preferred: contextMenuContact.preferred,
      unread: contextMenuContact.unread,
      x: Number(contextMenuState?.x) || 12,
      y: Number(contextMenuState?.y) || 12,
    }
    : null;
  return {
    call: {
      available: callAvailable,
      contact: {
        avatar: avatarPayload(agent, contactPeer),
        name: contactPeer,
      },
    },
    composer: {
      attachments: viewState.attachments,
      attachmentPicking: viewState.attachmentPicking,
      busy: viewState.busySessions.has(clean(snapshot.activeSessionId)),
      draft: viewState.draft,
      emojiOpen: viewState.emojiOpen,
      sending: viewState.sending,
      unavailable: !ready || viewState.sending,
    },
    contactContextMenu,
    contacts: contactRows,
    error: viewState.error ? conversationInfo(payload) : clean(snapshot.error || payload?.error),
    focus: viewState.mode === "focus",
    hasContactsRoot,
    listLabel: `${agent.displayName || "Suzu"} 的聊天记录`,
    menuOpen: viewState.menuOpen,
    messageRows: conversationMessageRows(entries, context, viewState.mode === "focus"),
    notice: viewState.notice,
    overlays: {
      avatarCrop: avatarCropSnapshot(),
      contactCreate: viewState.contactCreateOpen,
      contactRename: contactRenameSnapshot(),
      mediaPreview: mediaPreviewSnapshot(),
      wechatQr: wechatQrSnapshot(activeContact),
    },
    peer,
    permissions: permissionPromptSnapshot(clean(snapshot.activeSessionId)),
    rosterEmpty: hasContactsRoot
      ? contacts.length ? "所有联系人都已隐藏。可在“设置 > 隐私”中恢复。" : "还没有联系人。点击右上角“＋”创建。"
      : "软件数据目录尚未准备好，请稍后重试。",
    search: conversationSearchSnapshot(),
    searchOpen: viewState.searchOpen,
    sessionSettings: sessionSettingsSnapshot(context, selected, prefs),
    ui: {
      composerFocusRequest: viewState.composerFocusRequest,
      listScrollTop: viewState.listScrollTop,
      scrollTarget: viewState.scrollTarget,
      scrollToLatestRequest: viewState.scrollToLatestRequest,
      searchFocusRequest: viewState.searchFocusRequest,
    },
    unread: viewState.unread,
  };
}

function resetSessionSettings() {
  viewState.contactRenameOpen = false;
  viewState.mediaPreview = null;
  viewState.avatarCrop = null;
  viewState.wechatSnapshot = null;
  viewState.wechatQrOpen = false;
}

async function refreshCurrentSessionSettings(context) {
  const contactId = clean(viewState.snapshot?.activeContact?.id);
  if (!contactId) {
    resetSessionSettings();
    return;
  }
  viewState.settingsLoading = true;
  try {
    const wechatSnapshot = context.api.wechat?.snapshot
      ? await context.api.wechat.snapshot({ contactId })
      : null;
    if (clean(viewState.snapshot?.activeContact?.id) !== contactId) return;
    viewState.wechatSnapshot = wechatSnapshot;
  } catch (error) {
    if (clean(viewState.snapshot?.activeContact?.id) === contactId) {
      viewState.error = `读取联系人设置失败：${error?.message || error}`;
    }
  } finally {
    viewState.settingsLoading = false;
    if (viewState.settingsOpen) context.render();
  }
}

async function load(context, force = false) {
  if (viewState.loading || viewState.mode === "focus") return;
  viewState.loading = true;
  try {
    const snapshot = await context.api.conversation.snapshot();
    if (force || snapshot.version !== viewState.lastVersion || !viewState.snapshot) {
      const priorContactId = clean(viewState.snapshot?.activeContact?.id);
      viewState.snapshot = snapshot;
      viewState.lastVersion = snapshot.version;
      if (priorContactId !== clean(snapshot.activeContact?.id)) {
        resetSessionSettings();
        if (viewState.settingsOpen) void refreshCurrentSessionSettings(context);
      }
      scheduleScrollToLatest();
      context.render();
    }
  } catch (error) {
    viewState.error = `读取联系人聊天记录失败：${error?.message || error}`;
    context.render();
  } finally {
    viewState.loading = false;
  }
}

async function markOpenedContactRead(context) {
  const contact = viewState.snapshot?.activeContact || null;
  const id = clean(contact?.id);
  if (!id || unreadCount(contact) < 1 || !context.api.conversation.updateContactPresentation) return;
  try {
    viewState.snapshot = await context.api.conversation.updateContactPresentation({ id, unreadCount: 0 });
    viewState.lastVersion = viewState.snapshot.version;
    context.render();
  } catch {
    // Reading a conversation should remain available if its local badge cannot be saved.
  }
}

function handleConversationEvent(context, event) {
  if (event?.type === "call-transcript" && event?.final === true) {
    const activeSessionId = clean(viewState.snapshot?.activeSessionId);
    const activeProjectRoot = clean(viewState.snapshot?.projectRoot);
    const sessionId = clean(event?.sessionId);
    const transcript = clean(event?.text);
    if (!sessionId || sessionId !== activeSessionId || !transcript) return;
    if (activeProjectRoot && clean(event?.projectRoot) && !sameProjectRoot(activeProjectRoot, event.projectRoot)) return;
    const timestamp = clean(event?.timestamp) || new Date().toISOString();
    const id = [
      "call-transcript",
      clean(event?.callId) || "call",
      timestamp,
      transcript,
    ].join("\u0000");
    if (viewState.transientSystemMessages.some((item) => item.id === id)) return;
    viewState.transientSystemMessages.push({
      blocks: [{ kind: "text", text: `通话 · 我：${transcript}` }],
      id,
      kind: "system",
      sessionId,
      timestamp,
    });
    if (!viewState.shouldStickToLatest) viewState.unread = true;
    scheduleScrollToLatest();
    context.render();
    return;
  }
  if (event?.type === "call-system-message") {
    const activeSessionId = clean(viewState.snapshot?.activeSessionId);
    const activeProjectRoot = clean(viewState.snapshot?.projectRoot);
    const sessionId = clean(event?.sessionId);
    const message = clean(event?.message);
    if (!sessionId || sessionId !== activeSessionId || !message) return;
    if (activeProjectRoot && clean(event?.projectRoot) && !sameProjectRoot(activeProjectRoot, event.projectRoot)) return;
    const id = [
      "call-system",
      clean(event?.callId) || "call",
      clean(event?.requestId) || "request",
      Number.isSafeInteger(Number(event?.index)) ? Number(event.index) : "message",
    ].join("-");
    if (viewState.transientSystemMessages.some((item) => item.id === id)) return;
    viewState.transientSystemMessages.push({
      blocks: [{ kind: "text", text: message }],
      id,
      kind: "system",
      sessionId,
      timestamp: clean(event?.timestamp) || new Date().toISOString(),
    });
    if (!viewState.shouldStickToLatest) viewState.unread = true;
    scheduleScrollToLatest();
    context.render();
    return;
  }
  // The call sheet owns its own listening/thinking/speaking state.  Do not
  // leak the runtime's internal turn labels into the text composer while a voice
  // turn is running; refresh the normal history after it settles instead.
  if (["call", "call-open"].includes(event?.kind)) {
    if (["turn-complete", "turn-stopped", "error"].includes(event.type)) {
      void load(context, true);
      if (event.type === "turn-complete") void context.refreshUsageLedger?.();
    }
    return;
  }
  const activeProjectRoot = clean(viewState.snapshot?.projectRoot);
  if (activeProjectRoot && clean(event?.projectRoot) && !sameProjectRoot(activeProjectRoot, event.projectRoot)) return;
  const requestId = clean(event?.requestId);
  const sessionId = clean(event?.sessionId);
  if (event?.type === "queue" && sessionId) {
    const positions = new Map((Array.isArray(event.items) ? event.items : [])
      .map((item) => [clean(item?.requestId), Number(item?.position) || 0])
      .filter(([id, position]) => id && position > 0));
    viewState.pending = viewState.pending.map((item) => {
      if (item.sessionId !== sessionId || !item.requestId) return item;
      const position = positions.get(item.requestId);
      if (position) return { ...item, accepted: true, queued: true, queuePosition: position };
      return item.queued ? { ...item, queued: false, queuePosition: 0 } : item;
    });
    context.render();
    return;
  }
  if (event?.type === "permission" && requestId && sessionId) {
    viewState.permissions.set(requestId, {
      requestId,
      sessionId,
      toolName: clean(event.toolName),
      preview: String(event.preview || ""),
    });
    context.render();
    return;
  }
  if (event?.type === "permission-resolved" && requestId) {
    viewState.permissions.delete(requestId);
    context.render();
    return;
  }
  if (event?.type === "tool" && requestId && sessionId) {
    const content = clean(event.content);
    if (!content) return;
    const phase = clean(event.phase);
    const toolName = clean(event.toolName) || "Agent 工具";
    const isStart = phase === "started";
    viewState.liveTools.push({
      blocks: [isStart
        ? { kind: "tool_use", name: toolName, summary: content.slice(0, 80), detail: content }
        : { kind: "tool_result", error: phase === "failed", summary: content.slice(0, 80), detail: content }],
      id: `live-tool-${requestId}-${viewState.liveTools.length + 1}`,
      kind: "assistant",
      requestId,
      sessionId,
      timestamp: clean(event.timestamp) || new Date().toISOString(),
    });
    if (!viewState.shouldStickToLatest) viewState.unread = true;
    scheduleScrollToLatest();
    context.render();
    return;
  }
  if (event?.type === "turn-start" && requestId && sessionId) {
    viewState.pending = viewState.pending.map((item) => (
      item.requestId === requestId
        ? { ...item, accepted: true, queued: false, queuePosition: 0 }
        : item
    ));
    viewState.busySessions.add(sessionId);
    context.render();
    return;
  }
  if (event?.type === "thinking" && requestId && sessionId) {
    const previous = viewState.liveReplies.get(requestId);
    if (previous?.done) return;
    viewState.liveReplies.set(requestId, {
      ...previous,
      content: String(previous?.content ?? ""),
      done: false,
      phase: "thinking",
      remainder: String(previous?.remainder ?? ""),
      requestId,
      sentences: Array.isArray(previous?.sentences) ? previous.sentences : [],
      sessionId,
      timestamp: liveReplyTimestamp(previous, event),
    });
    context.render();
    return;
  }
  if (event?.type === "error" && requestId) {
    if (sessionId) viewState.busySessions.delete(sessionId);
    viewState.permissions.forEach((item, id) => {
      if (item.sessionId === sessionId) viewState.permissions.delete(id);
    });
    const reply = viewState.liveReplies.get(requestId);
    if (reply) viewState.liveReplies.set(requestId, { ...reply, done: true, phase: "idle" });
    viewState.notice = "";
    viewState.error = `Suzu Agent 没有完成这次回复：${event.message || "未知错误"}`;
    context.render();
    void load(context, true);
    return;
  }
  if (event?.type === "turn-stopped" && requestId && sessionId) {
    viewState.busySessions.delete(sessionId);
    viewState.permissions.forEach((item, id) => {
      if (item.sessionId === sessionId) viewState.permissions.delete(id);
    });
    const reply = viewState.liveReplies.get(requestId);
    if (reply) viewState.liveReplies.set(requestId, { ...reply, done: true, phase: "idle" });
    viewState.error = "";
    viewState.notice = clean(event.message) || "已停止当前 Suzu Agent 任务。";
    context.render();
    load(context, true);
    return;
  }
  if (event?.type === "turn-complete" && requestId && sessionId) {
    viewState.busySessions.delete(sessionId);
    const reply = finishedLiveReply(viewState.liveReplies.get(requestId));
    if (reply) viewState.liveReplies.set(requestId, reply);
    context.render();
    void load(context, true).finally(() => {
      viewState.liveTools = viewState.liveTools.filter((item) => item.requestId !== requestId);
      context.render();
    });
    void context.refreshUsageLedger?.();
    return;
  }
  if (!requestId || !sessionId) return;
  if (event.type === "reply" || event.type === "reply-stream") {
    const previous = viewState.liveReplies.get(requestId);
    viewState.liveReplies.set(requestId, projectedLiveReply(previous, event, {
      final: event.type === "reply" || event.done === true,
    }));
    if (!viewState.shouldStickToLatest) viewState.unread = true;
    scheduleScrollToLatest();
    context.render();
    if (event.type === "reply" || event.done === true) load(context, true);
  }
}

export function startConversationPolling(context) {
  stopConversationPolling();
  viewState.transientSystemMessages.length = 0;
  viewState.liveTools = [];
  viewState.shouldStickToLatest = true;
  void load(context, true).then(() => markOpenedContactRead(context));
  if (typeof context.api.conversation.onEvent === "function") {
    viewState.unsubscribe = context.api.conversation.onEvent((event) => handleConversationEvent(context, event));
  }
  if (typeof context.api.wechat?.onEvent === "function") {
    viewState.wechatUnsubscribe = context.api.wechat.onEvent((event) => {
      const activeContactId = clean(viewState.snapshot?.activeContact?.id);
      if (!activeContactId || !clean(event?.contactId) || clean(event.contactId) === activeContactId) {
        void refreshCurrentSessionSettings(context);
      }
    });
  }
  viewState.timer = window.setInterval(() => load(context), 2000);
}

export function stopConversationPolling() {
  if (viewState.timer) window.clearInterval(viewState.timer);
  viewState.timer = null;
  viewState.unsubscribe?.();
  viewState.unsubscribe = null;
  viewState.wechatUnsubscribe?.();
  viewState.wechatUnsubscribe = null;
  viewState.composerFocusRequest = 0;
  viewState.searchFocusRequest = 0;
  viewState.scrollTarget = null;
  viewState.scrollToLatestRequest = 0;
  void endActiveConversationCall();
}

export function dismissConversationOverlays(target = viewState) {
  const state = target && typeof target === "object" ? target : viewState;
  const open = Boolean(state.contactCreateOpen || state.contactContextMenu || state.contactRenameOpen || state.menuOpen || state.searchOpen || state.settingsOpen || state.emojiOpen || state.wechatQrOpen || state.mediaPreview || state.avatarCrop);
  state.contactCreateOpen = false;
  state.contactContextMenu = null;
  state.contactRenameOpen = false;
  state.menuOpen = false;
  state.searchOpen = false;
  state.settingsOpen = false;
  state.emojiOpen = false;
  state.wechatQrOpen = false;
  state.mediaPreview = null;
  state.avatarCrop = null;
  return open;
}

async function sendMessage(context) {
  const raw = clean(viewState.draft);
  const selectedAttachments = Array.isArray(viewState.attachments) ? viewState.attachments : [];
  if ((!raw && !selectedAttachments.length) || viewState.sending) return;
  const command = raw ? parseSuzuConversationCommand(raw) : { action: "message", content: "" };
  if (selectedAttachments.length && command.action !== "message") {
    viewState.error = "图片和文件只能作为普通消息发送。";
    context.render();
    return;
  }
  if (command.action === "notice") {
    viewState.draft = "";
    viewState.error = "";
    viewState.notice = command.message;
    viewState.emojiOpen = false;
    focusComposer();
    context.render();
    return;
  }
  if (command.action === "stop") {
    const sessionId = clean(viewState.snapshot?.activeSessionId);
    if (!sessionId) {
      viewState.draft = "";
      viewState.error = "";
      viewState.notice = "当前没有可停止的 Suzu Agent 回复。";
      focusComposer();
      context.render();
      return;
    }
    viewState.draft = "";
    viewState.error = "";
    viewState.notice = "";
    viewState.sending = true;
    viewState.emojiOpen = false;
    context.render();
    try {
      const result = await context.api.conversation.stop({ sessionId, projectRoot: clean(viewState.snapshot?.projectRoot) });
      viewState.notice = clean(result?.message) || "正在停止当前 Suzu Agent 任务。";
    } catch (error) {
      viewState.error = `无法停止任务：${error?.message || error}`;
    } finally {
      viewState.sending = false;
      focusComposer();
      context.render();
    }
    return;
  }
  const content = command.content;
  const pending = {
    accepted: false,
    content,
    media: selectedAttachments,
    id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    queued: false,
    queuePosition: 0,
    requestId: "",
    sessionId: clean(viewState.snapshot?.activeSessionId),
    steering: command.action === "steer",
    timestamp: new Date().toISOString(),
  };
  viewState.draft = "";
  viewState.error = "";
  viewState.notice = "";
  resetConversationFocus();
  viewState.searchOpen = false;
  viewState.sending = true;
  viewState.emojiOpen = false;
  viewState.shouldStickToLatest = true;
  viewState.unread = false;
  viewState.pending.push(pending);
  scheduleScrollToLatest();
  context.render();
  try {
    const result = command.action === "steer"
      ? await context.api.conversation.steer({ content })
      : await context.api.conversation.send({
        content,
        attachmentTokens: selectedAttachments.map((item) => clean(item?.selectionToken)).filter(Boolean),
        queued: command.action === "queue",
      });
    pending.accepted = true;
    pending.queued = result?.queued === true;
    pending.queuePosition = Number(result?.queuePosition) || 0;
    pending.steering = command.action === "steer" && result?.delivered === true;
    pending.requestId = clean(result?.requestId);
    pending.sessionId = clean(result?.sessionId);
    if (Array.isArray(result?.media) && result.media.length) pending.media = result.media;
    viewState.attachments = [];
    if (pending.sessionId) viewState.busySessions.add(pending.sessionId);
    if (command.action === "steer") viewState.notice = clean(result?.message);
    viewState.sending = false;
    scheduleScrollToLatest();
    context.render();
    load(context, true);
  } catch (error) {
    viewState.pending = viewState.pending.filter((item) => item !== pending);
    viewState.draft = raw;
    viewState.error = `没有发出去：${error?.message || error}`;
    viewState.sending = false;
    focusComposer();
    context.render();
  }
}

async function saveCurrentContactAvatar(context, avatarDataUrl) {
  const settings = context.state.settings || {};
  const agentId = clean(settings.agentId);
  if (!agentId) throw new Error("请先选择联系人。 ");
  const identity = getIdentity(settings);
  const nextIdentity = {
    owner: { ...identity.owner },
    defaultAgent: { ...identity.defaultAgent },
    agents: Object.fromEntries(Object.entries(identity.agents || {}).map(([id, profile]) => [id, { ...profile }])),
  };
  nextIdentity.agents[agentId] = { ...getAgentProfile(settings), avatarDataUrl };
  context.state.settings = await context.api.settings.update({ identity: nextIdentity });
  viewState.error = "";
  viewState.notice = avatarDataUrl ? "联系人头像已保存。" : "联系人头像已移除。";
}

function loadAvatarCropSource(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => {
      const imageWidth = Number(image.naturalWidth || image.width);
      const imageHeight = Number(image.naturalHeight || image.height);
      if (!Number.isFinite(imageWidth) || imageWidth <= 0 || !Number.isFinite(imageHeight) || imageHeight <= 0) {
        reject(new Error("无法读取这张图片的尺寸。"));
        return;
      }
      resolve({ imageWidth, imageHeight });
    }, { once: true });
    image.addEventListener("error", () => reject(new Error("无法打开这张图片。")), { once: true });
    image.src = source;
  });
}

function resetConversationFocus() {
  viewState.focus = null;
  viewState.mode = "snapshot";
  viewState.search = null;
  viewState.searchError = "";
  viewState.searchLoading = false;
}

async function focusConversationRecord(context, { lineNumber, messageId } = {}, { fromSearch = false } = {}) {
  const targetLineNumber = messageLineNumber({ lineNumber });
  const targetMessageId = clean(messageId);
  if (!targetLineNumber || typeof context.api.conversation.focus !== "function") {
    viewState.searchOpen = false;
    scrollToConversationMessage({ lineNumber: targetLineNumber, messageId: targetMessageId });
    context.render();
    return true;
  }
  try {
    viewState.focus = await context.api.conversation.focus({ lineNumber: targetLineNumber, messageId: targetMessageId });
    viewState.mode = "focus";
    viewState.search = null;
    viewState.searchError = "";
    viewState.searchLoading = false;
    viewState.searchOpen = false;
    viewState.shouldStickToLatest = false;
    scrollToConversationMessage({ lineNumber: targetLineNumber, messageId: targetMessageId });
    context.render();
    return true;
  } catch (error) {
    const message = `无法定位聊天记录：${error?.message || error}`;
    if (fromSearch && viewState.searchOpen) viewState.searchError = message;
    else viewState.error = message;
    context.render();
    return false;
  }
}

function avatarCropFromElement(image) {
  const crop = viewState.avatarCrop;
  if (!crop || !image?.naturalWidth || !image?.naturalHeight) throw new Error("头像图片尚未准备好，请稍后重试。");
  const source = avatarCropSourceRect(crop);
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_CROP_OUTPUT_SIZE;
  canvas.height = AVATAR_CROP_OUTPUT_SIZE;
  const drawing = canvas.getContext("2d");
  if (!drawing) throw new Error("当前环境无法裁剪头像。");
  drawing.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/webp", .92);
}

function resizeConversationAvatarCrop(width, height) {
  const crop = viewState.avatarCrop;
  const viewportWidth = Math.round(Number(width) || 0);
  const viewportHeight = Math.round(Number(height) || 0);
  if (!crop || viewportWidth < 1 || viewportHeight < 1) return avatarCropSnapshot();
  if (crop.viewportWidth !== viewportWidth || crop.viewportHeight !== viewportHeight) {
    viewState.avatarCrop = resizeAvatarCropViewport(crop, viewportWidth, viewportHeight);
  }
  return avatarCropSnapshot();
}

function moveConversationAvatarCrop(deltaX, deltaY) {
  if (!viewState.avatarCrop) return null;
  viewState.avatarCrop = moveAvatarCrop(viewState.avatarCrop, Number(deltaX) || 0, Number(deltaY) || 0);
  return avatarCropSnapshot();
}

function zoomConversationAvatarCrop(value) {
  if (!viewState.avatarCrop) return null;
  viewState.avatarCrop = setAvatarCropZoom(viewState.avatarCrop, value);
  return avatarCropSnapshot();
}

async function runConversationSearchForQuery(context, requestedCategory = viewState.searchCategory, requestedQuery = viewState.searchQuery) {
  const category = searchCategoryInfo(requestedCategory).id;
  const query = category === "date" ? String(requestedQuery || "") : clean(requestedQuery);
  viewState.searchCategory = category;
  viewState.searchQuery = query;
  if (category === "messages" && !query) {
    viewState.searchError = "请输入要查找的关键词。";
    focusSearchInput();
    context.render();
    return;
  }
  if (category === "date" && !query) {
    viewState.searchError = "请选择要查找的日期。";
    focusSearchInput();
    context.render();
    return;
  }
  if (typeof context.api.conversation.search !== "function") {
    viewState.searchError = "当前版本无法搜索本地聊天记录。";
    context.render();
    return;
  }
  viewState.searchLoading = true;
  viewState.searchError = "";
  context.render();
  try {
    viewState.search = await context.api.conversation.search({ category, query });
  } catch (error) {
    viewState.searchError = `搜索失败：${error?.message || error}`;
  } finally {
    viewState.searchLoading = false;
    context.render();
  }
}

async function openConversationMediaPreviewForItem(context, value = {}) {
  const fallback = {
    key: clean(value.key) || encodeURIComponent([clean(value.messageId) || `line:${messageLineNumber({ lineNumber: value.lineNumber })}`, clean(value.url), clean(value.name) || "图片附件"].join("|")),
    lineNumber: messageLineNumber({ lineNumber: value.lineNumber }),
    messageId: clean(value.messageId),
    name: clean(value.name) || "图片附件",
    url: clean(value.url),
  };
  if (!fallback.url) return;
  const gallery = currentImageGallery();
  const index = Math.max(gallery.findIndex((item) => item.key === fallback.key), 0);
  viewState.mediaPreview = { items: gallery.length ? gallery : [fallback], index };
  context.render();

  if ((viewState.searchOpen && viewState.search?.category === "images") || typeof context.api.conversation.search !== "function") return;
  try {
    const allImages = imageGalleryFromSearch(await context.api.conversation.search({ category: "images", query: "" }));
    const matchedIndex = allImages.findIndex((item) => item.key === fallback.key);
    if (!viewState.mediaPreview || matchedIndex < 0) return;
    viewState.mediaPreview = { items: allImages, index: matchedIndex };
    context.render();
  } catch {
    // A single image is still useful if its historical gallery cannot be read.
  }
}

function resetConversationForContactChange() {
  resetSessionSettings();
  viewState.attachments = [];
  viewState.attachmentPicking = false;
  viewState.contactContextMenu = null;
  viewState.transientSystemMessages.length = 0;
  viewState.liveTools = [];
  viewState.pending = [];
  viewState.liveReplies.clear();
  viewState.permissions.clear();
  viewState.busySessions.clear();
  viewState.error = "";
  viewState.notice = "";
  resetConversationFocus();
  viewState.searchOpen = false;
  viewState.searchQuery = "";
  viewState.shouldStickToLatest = true;
  viewState.listScrollTop = 0;
  viewState.scrollTarget = null;
}

export function createConversationReactActions(context) {
  return {
    appendVoiceInputTranscript: (value) => {
      const text = clean(value);
      if (!text) return;
      const draft = String(viewState.draft || "");
      const separator = draft && !/[\s\n]$/u.test(draft) ? "\n" : "";
      viewState.draft = `${draft}${separator}${text}`;
      viewState.error = "";
      viewState.notice = "";
      viewState.emojiOpen = false;
      focusComposer();
      context.render();
    },
    closeAvatarCrop: () => {
      viewState.avatarCrop = null;
      context.render();
    },
    closeContactCreate: () => {
      viewState.contactCreateOpen = false;
      context.render();
    },
    closeContactRename: () => {
      viewState.contactRenameOpen = false;
      context.render();
    },
    closeContactContextMenu: () => {
      if (!viewState.contactContextMenu) return;
      viewState.contactContextMenu = null;
      context.render();
    },
    closeMediaPreview: () => {
      viewState.mediaPreview = null;
      context.render();
    },
    closeSearch: () => {
      viewState.searchOpen = false;
      viewState.searchError = "";
      viewState.searchLoading = false;
      renderKeepingConversationScroll(context);
    },
    closeSessionSettings: () => {
      viewState.settingsOpen = false;
      context.render();
    },
    closeWechatQr: () => {
      viewState.wechatQrOpen = false;
      context.render();
    },
    confirmAvatarCrop: async (image) => {
      try {
        await saveCurrentContactAvatar(context, avatarCropFromElement(image));
        viewState.avatarCrop = null;
      } catch (error) {
        viewState.error = `无法保存联系人头像：${error?.message || error}`;
      }
      renderKeepingConversationScroll(context);
    },
    createContact: async (name) => {
      const value = clean(name);
      if (!value || viewState.sending || !context.api.conversation.createContact) return;
      viewState.sending = true;
      context.render();
      try {
        await endActiveConversationCall();
        viewState.snapshot = await context.api.conversation.createContact({ name: value });
        viewState.lastVersion = viewState.snapshot.version;
        if (context.api.settings?.get) context.state.settings = await context.api.settings.get();
        try {
          await context.onContactCreated?.(viewState.snapshot?.activeContact || null);
        } catch {
          // Creating a contact must stay usable even if an optional guide cannot advance.
        }
        viewState.contactCreateOpen = false;
        resetConversationForContactChange();
        viewState.sending = false;
        scheduleScrollToLatest();
        focusComposer();
        context.render();
      } catch (error) {
        viewState.error = `无法新建联系人：${error?.message || error}`;
        viewState.sending = false;
        context.render();
      }
    },
    dismissOverlays: () => {
      if (!dismissConversationOverlays()) return false;
      context.render();
      return true;
    },
    focusSearchMatch: async ({ lineNumber, messageId } = {}) => {
      await focusConversationRecord(context, { lineNumber, messageId }, { fromSearch: true });
    },
    jumpToLatest: () => {
      viewState.shouldStickToLatest = true;
      scheduleScrollToLatest();
      context.render();
    },
    moveAvatarCrop: moveConversationAvatarCrop,
    nextMediaPreview: () => {
      const preview = viewState.mediaPreview;
      const items = Array.isArray(preview?.items) ? preview.items : [];
      const index = Math.min((Number(preview?.index) || 0) + 1, Math.max(items.length - 1, 0));
      if (!items.length || index === preview?.index) return;
      viewState.mediaPreview = { ...preview, index };
      context.render();
    },
    openContactCreate: () => {
      if (viewState.sending) return;
      viewState.contactCreateOpen = true;
      viewState.contactContextMenu = null;
      viewState.error = "";
      viewState.menuOpen = false;
      viewState.searchOpen = false;
      viewState.settingsOpen = false;
      context.render();
    },
    openContactContextMenu: (contactId, point) => {
      const id = clean(contactId);
      const contacts = Array.isArray(viewState.snapshot?.contacts) ? viewState.snapshot.contacts : [];
      if (!id || !contacts.some((contact) => clean(contact?.id) === id)) return;
      viewState.contactContextMenu = { contactId: id, ...contactContextMenuPosition(point) };
      viewState.menuOpen = false;
      viewState.searchOpen = false;
      viewState.emojiOpen = false;
      context.render();
    },
    openContactRename: (contactId) => {
      const id = clean(contactId);
      if (!id || id !== clean(viewState.snapshot?.activeContact?.id) || viewState.sending) return;
      viewState.contactRenameOpen = true;
      viewState.contactContextMenu = null;
      viewState.error = "";
      context.render();
    },
    openMediaDirectory: async (contactId) => {
      const id = clean(contactId);
      if (!id || !context.api.conversation.openMediaDirectory) return;
      try {
        await context.api.conversation.openMediaDirectory({ contactId: id });
      } catch (error) {
        viewState.error = `无法打开联系人媒体目录：${error?.message || error}`;
        context.render();
      }
    },
    openMediaFile: async (block) => {
      const fileUrl = clean(block?.fileUrl);
      if (!fileUrl || !context.api.conversation.openMediaFile) return;
      try {
        await context.api.conversation.openMediaFile({ fileUrl });
      } catch (error) {
        viewState.error = `无法打开附件：${error?.message || error}`;
        context.render();
      }
    },
    openMediaPreview: (item) => void openConversationMediaPreviewForItem(context, item),
    openSessionSettings: async () => {
      viewState.menuOpen = false;
      viewState.searchOpen = false;
      viewState.settingsOpen = true;
      viewState.emojiOpen = false;
      context.render();
      await refreshCurrentSessionSettings(context);
    },
    openWechatCapability: () => {
      context.setView?.("capabilities");
      context.setCapabilityPage?.("detail", "act", "wechat-connection");
    },
    previousMediaPreview: () => {
      const preview = viewState.mediaPreview;
      const items = Array.isArray(preview?.items) ? preview.items : [];
      const index = Math.max((Number(preview?.index) || 0) - 1, 0);
      if (!items.length || index === preview?.index) return;
      viewState.mediaPreview = { ...preview, index };
      context.render();
    },
    refresh: () => void load(context, true),
    removeComposerAttachment: (selectionToken) => {
      const token = clean(selectionToken);
      if (!token) return;
      const removed = viewState.attachments.filter((item) => clean(item?.selectionToken) === token);
      if (!removed.length) return;
      viewState.attachments = viewState.attachments.filter((item) => clean(item?.selectionToken) !== token);
      const discard = context.api.conversation.attachments?.discard;
      if (typeof discard === "function") void discard({ attachmentTokens: removed.map((item) => item.selectionToken) }).catch(() => undefined);
      context.render();
    },
    removeContactAvatar: async () => {
      try {
        await saveCurrentContactAvatar(context, "");
      } catch (error) {
        viewState.error = `无法移除联系人头像：${error?.message || error}`;
      }
      renderKeepingConversationScroll(context);
    },
    removeContact: async (contactId) => {
      const id = clean(contactId);
      if (!id || viewState.sending || !context.api.conversation.removeContact) return;
      const contact = (Array.isArray(viewState.snapshot?.contacts) ? viewState.snapshot.contacts : [])
        .find((item) => clean(item?.id) === id) || null;
      const name = clean(contact?.name) || "这位联系人";
      const activeContactRemoved = id === clean(viewState.snapshot?.activeContact?.id);
      viewState.contactContextMenu = null;
      if (!window.confirm(`删除“${name}”及其聊天记录、联系人资料和所有专属数据？包括附件、记忆、自动任务和微信连接；此操作无法恢复。`)) {
        context.render();
        return;
      }
      viewState.sending = true;
      context.render();
      try {
        if (activeContactRemoved) await endActiveConversationCall();
        viewState.snapshot = await context.api.conversation.removeContact({ id, confirmed: true });
        viewState.lastVersion = viewState.snapshot.version;
        if (activeContactRemoved) resetConversationForContactChange();
        if (context.api.settings?.get) context.state.settings = await context.api.settings.get();
        viewState.error = "";
        viewState.notice = `已删除“${name}”。`;
      } catch (error) {
        viewState.error = `无法删除联系人：${error?.message || error}`;
      } finally {
        viewState.sending = false;
        context.render();
      }
    },
    renameContact: async (contactId, name) => {
      const id = clean(contactId);
      const value = clean(name);
      if (!id || !value || id !== clean(viewState.snapshot?.activeContact?.id) || viewState.sending || !context.api.conversation.renameContact) return;
      viewState.sending = true;
      context.render();
      try {
        viewState.snapshot = await context.api.conversation.renameContact({ id, name: value });
        viewState.lastVersion = viewState.snapshot.version;
        viewState.contactRenameOpen = false;
        viewState.error = "";
        viewState.notice = "联系人备注已更新。";
      } catch (error) {
        viewState.error = `无法更新联系人备注：${error?.message || error}`;
      } finally {
        viewState.sending = false;
        context.render();
      }
    },
    reportVoiceInputError: (message) => {
      const detail = clean(message);
      if (!detail) return;
      viewState.error = detail;
      viewState.notice = "";
      context.render();
    },
    clearVoiceInputError: () => {
      if (!viewState.error) return;
      viewState.error = "";
      context.render();
    },
    resizeAvatarCrop: resizeConversationAvatarCrop,
    respondPermission: async (requestId, behavior) => {
      const id = clean(requestId);
      if (!id || !["allow", "deny"].includes(behavior)) return;
      try {
        await context.api.conversation.respondPermission({ requestId: id, behavior });
        viewState.permissions.delete(id);
        viewState.error = "";
      } catch (error) {
        viewState.error = `无法提交权限选择：${error?.message || error}`;
      }
      context.render();
    },
    runSearch: (query) => void runConversationSearchForQuery(context, viewState.searchCategory, query),
    setPreferredContact: async (contactId) => {
      const id = clean(contactId);
      if (!id || !context.api.conversation.setPreferredContact) return;
      const contact = (Array.isArray(viewState.snapshot?.contacts) ? viewState.snapshot.contacts : [])
        .find((item) => clean(item?.id) === id) || null;
      viewState.contactContextMenu = null;
      try {
        viewState.snapshot = await context.api.conversation.setPreferredContact({ id });
        viewState.lastVersion = viewState.snapshot.version;
        if (context.api.settings?.get) context.state.settings = await context.api.settings.get();
        viewState.error = "";
        viewState.notice = `已将“${clean(contact?.name) || "这位联系人"}”设为首选联系人。`;
      } catch (error) {
        viewState.error = `无法设置首选联系人：${error?.message || error}`;
      }
      context.render();
    },
    updateContactPresentation: async (contactId, value = {}) => {
      const id = clean(contactId);
      const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
      const patch = {};
      for (const key of ["pinned", "muted", "hidden"]) {
        if (typeof source[key] === "boolean") patch[key] = source[key];
      }
      if (Number.isSafeInteger(source.unreadCount) && source.unreadCount >= 0) patch.unreadCount = source.unreadCount;
      if (!id || !Object.keys(patch).length || viewState.sending || !context.api.conversation.updateContactPresentation) return;
      const contact = (Array.isArray(viewState.snapshot?.contacts) ? viewState.snapshot.contacts : [])
        .find((item) => clean(item?.id) === id) || null;
      const name = clean(contact?.name) || "这位联系人";
      viewState.contactContextMenu = null;
      viewState.sending = true;
      context.render();
      try {
        viewState.snapshot = await context.api.conversation.updateContactPresentation({ id, ...patch });
        viewState.lastVersion = viewState.snapshot.version;
        viewState.error = "";
        if (Object.hasOwn(patch, "pinned")) {
          viewState.notice = patch.pinned ? `已将“${name}”置顶。` : `已取消“${name}”置顶。`;
        } else if (Object.hasOwn(patch, "unreadCount")) {
          viewState.notice = patch.unreadCount > 0 ? `已将“${name}”标为未读。` : `已将“${name}”标为已读。`;
        } else if (Object.hasOwn(patch, "muted")) {
          viewState.notice = patch.muted ? `已开启“${name}”的消息免打扰。` : `已关闭“${name}”的消息免打扰。`;
        } else if (Object.hasOwn(patch, "hidden")) {
          viewState.notice = patch.hidden ? `已隐藏“${name}”。可在“设置 > 隐私”中恢复。` : `已恢复“${name}”到联系人列表。`;
        }
      } catch (error) {
        viewState.error = `无法更新联系人显示状态：${error?.message || error}`;
      } finally {
        viewState.sending = false;
        context.render();
      }
    },
    selectContact: async (contactId) => {
      const id = clean(contactId);
      if (!id || viewState.sending || !context.api.conversation.selectContact) return;
      try {
        await endActiveConversationCall();
        viewState.snapshot = await context.api.conversation.selectContact({ id });
        viewState.lastVersion = viewState.snapshot.version;
        if (context.api.settings?.get) context.state.settings = await context.api.settings.get();
        resetConversationForContactChange();
        scheduleScrollToLatest();
        context.render();
      } catch (error) {
        viewState.error = `无法切换联系人：${error?.message || error}`;
        context.render();
      }
    },
    selectComposerAttachments: async (kind) => {
      const attachmentKind = clean(kind).toLowerCase();
      if (!new Set(["file", "image"]).has(attachmentKind) || viewState.sending || viewState.attachmentPicking || !context.api.conversation.attachments?.select) return;
      viewState.attachmentPicking = true;
      viewState.error = "";
      context.render();
      try {
        const result = await context.api.conversation.attachments.select({ kind: attachmentKind });
        if (!result?.canceled) {
          const selected = (Array.isArray(result?.items) ? result.items : []).flatMap((item) => {
            const token = clean(item?.selectionToken);
            const fileName = clean(item?.fileName);
            const itemKind = clean(item?.kind).toLowerCase();
            const size = Number(item?.size);
            if (!token || !fileName || !new Set(["file", "image"]).has(itemKind) || !Number.isSafeInteger(size) || size <= 0) return [];
            return [{
              fileName,
              fileUrl: clean(item?.fileUrl),
              kind: itemKind,
              mimeType: clean(item?.mimeType),
              selectionToken: token,
              size,
            }];
          });
          const existing = new Set(viewState.attachments.map((item) => clean(item?.selectionToken)));
          viewState.attachments = [...viewState.attachments, ...selected.filter((item) => !existing.has(item.selectionToken))].slice(0, 24);
        }
      } catch (error) {
        viewState.error = `无法选择附件：${error?.message || error}`;
      } finally {
        viewState.attachmentPicking = false;
        context.render();
      }
    },
    selectSearchCategory: (category) => {
      const next = searchCategoryInfo(category).id;
      viewState.searchCategory = next;
      viewState.search = null;
      viewState.searchError = "";
      if (next === "date") {
        viewState.searchQuery = "";
        focusSearchInput();
        context.render();
        return;
      }
      if (next === "messages") {
        focusSearchInput();
        context.render();
        return;
      }
      void runConversationSearchForQuery(context, next, viewState.searchQuery);
    },
    setAvatarCropZoom: zoomConversationAvatarCrop,
    setLongTermMemoryEnabled: async (enabled) => {
      const contactId = clean(viewState.snapshot?.activeContact?.id);
      if (!contactId || viewState.sending || !context.api.conversation.updateContactLongTermMemoryEnabled) return;
      viewState.sending = true;
      context.render();
      try {
        viewState.snapshot = await context.api.conversation.updateContactLongTermMemoryEnabled({ id: contactId, enabled: Boolean(enabled) });
        viewState.lastVersion = viewState.snapshot.version;
        viewState.error = "";
      } catch (error) {
        viewState.error = `无法更新联系人长期记忆：${error?.message || error}`;
      } finally {
        viewState.sending = false;
        context.render();
      }
    },
    setDisplayPreference: async (key, checked) => {
      const preference = clean(key);
      if (!Object.hasOwn(defaults, preference)) return;
      try {
        const next = { ...preferences(context.state.settings), [preference]: Boolean(checked) };
        context.state.settings = await context.api.settings.update({ conversationPreferences: next });
      } catch (error) {
        viewState.error = `无法更新聊天显示：${error?.message || error}`;
      }
      context.render();
    },
    setDraft: (value) => {
      const next = String(value ?? "");
      if (viewState.draft === next) return;
      viewState.draft = next;
      context.render();
    },
    setListScroll: ({ clientHeight, scrollHeight, scrollTop } = {}) => {
      const top = Number(scrollTop);
      const height = Number(scrollHeight);
      const viewport = Number(clientHeight);
      if (!Number.isFinite(top) || !Number.isFinite(height) || !Number.isFinite(viewport)) return;
      viewState.listScrollTop = top;
      const shouldStick = height - top - viewport < 48;
      const unread = shouldStick ? false : viewState.unread;
      const changed = viewState.shouldStickToLatest !== shouldStick || viewState.unread !== unread;
      viewState.shouldStickToLatest = shouldStick;
      viewState.unread = unread;
      if (changed) context.render();
    },
    setSearchQuery: (query, { submitDate = false } = {}) => {
      viewState.searchQuery = String(query ?? "");
      viewState.searchError = "";
      if (submitDate && viewState.searchCategory === "date" && viewState.searchQuery) {
        void runConversationSearchForQuery(context, "date", viewState.searchQuery);
      }
    },
    setTimeDisplay: async (value) => {
      try {
        const next = { ...preferences(context.state.settings), timeDisplay: timeDisplay({ timeDisplay: value }) };
        context.state.settings = await context.api.settings.update({ conversationPreferences: next });
      } catch (error) {
        viewState.error = `无法更新聊天显示：${error?.message || error}`;
      }
      context.render();
    },
    setWechatContactEnabled: async (contactId, enabled) => {
      const id = clean(contactId);
      if (!id || !context.api.wechat?.setContactEnabled) return;
      try {
        viewState.wechatSnapshot = await context.api.wechat.setContactEnabled({ contactId: id, enabled: Boolean(enabled) });
        viewState.error = "";
        viewState.notice = enabled ? "这位联系人已恢复微信消息。" : "这位联系人的微信消息已暂停。";
      } catch (error) {
        viewState.error = `无法更新联系人微信连接：${error?.message || error}`;
      }
      context.render();
    },
    startWechat: async (contactId) => {
      const id = clean(contactId);
      if (!id || !context.api.wechat?.begin) return;
      try {
        viewState.wechatSnapshot = await context.api.wechat.begin({ contactId: id });
        viewState.wechatQrOpen = true;
        viewState.error = "";
        viewState.notice = "微信二维码已生成。扫码后请发一条文字消息确认已绑定这位联系人。";
      } catch (error) {
        viewState.error = `无法生成微信二维码：${error?.message || error}`;
      }
      context.render();
    },
    submitMessage: () => void sendMessage(context),
    toggleEmoji: () => {
      viewState.emojiOpen = !viewState.emojiOpen;
      viewState.menuOpen = false;
      if (viewState.emojiOpen) focusComposer();
      context.render();
    },
    toggleMenu: () => {
      viewState.menuOpen = !viewState.menuOpen;
      viewState.searchOpen = false;
      viewState.settingsOpen = false;
      viewState.emojiOpen = false;
      renderKeepingConversationScroll(context);
    },
    toggleSearch: () => {
      viewState.searchOpen = !viewState.searchOpen;
      viewState.menuOpen = false;
      viewState.settingsOpen = false;
      viewState.emojiOpen = false;
      if (viewState.searchOpen) {
        viewState.search = null;
        viewState.searchCategory = "messages";
        viewState.searchError = "";
        viewState.searchLoading = false;
        viewState.searchQuery = "";
        focusSearchInput();
      }
      renderKeepingConversationScroll(context);
    },
    uploadContactAvatar: async (file) => {
      if (!file) return;
      try {
        const source = await readAvatarFile(file);
        const dimensions = await loadAvatarCropSource(source);
        viewState.avatarCrop = createSquareAvatarCrop({ source, ...dimensions });
        viewState.error = "";
      } catch (error) {
        viewState.error = `无法读取联系人头像：${error?.message || error}`;
      }
      renderKeepingConversationScroll(context);
    },
    viewCurrentConversation: () => {
      resetConversationFocus();
      viewState.searchOpen = false;
      viewState.searchQuery = "";
      viewState.shouldStickToLatest = true;
      scheduleScrollToLatest();
      context.render();
      void load(context, true);
    },
    viewWechatQr: () => {
      viewState.wechatQrOpen = true;
      context.render();
    },
    disconnectWechat: async (contactId) => {
      const id = clean(contactId);
      if (!id || !context.api.wechat?.disconnect) return;
      if (!window.confirm("断开后，这个微信账号将不再进入当前联系人的固定 Suzu 对话。确定断开吗？")) return;
      try {
        viewState.wechatSnapshot = await context.api.wechat.disconnect({ contactId: id, confirmed: true });
        viewState.error = "";
        viewState.notice = "当前联系人的微信连接已断开。";
      } catch (error) {
        viewState.error = `无法断开微信：${error?.message || error}`;
      }
      context.render();
    },
    insertEmoji: (emoji) => {
      viewState.draft = `${viewState.draft}${String(emoji || "")}`;
      viewState.emojiOpen = false;
      focusComposer();
      context.render();
    },
    loadEmojiStickers: async () => {
      const stickers = context.api?.conversation?.emojiStickers;
      if (typeof stickers?.snapshot !== "function") return { items: [], status: "unavailable" };
      return stickers.snapshot();
    },
    addEmojiSticker: async () => {
      const stickers = context.api?.conversation?.emojiStickers;
      if (typeof stickers?.select !== "function" || typeof stickers?.add !== "function") {
        throw new Error("当前版本无法添加收藏表情包。");
      }
      const selection = await stickers.select();
      if (selection?.canceled) return selection;
      return stickers.add({ selectionToken: clean(selection?.selectionToken) });
    },
    sendEmojiSticker: async (id) => {
      const stickers = context.api?.conversation?.emojiStickers;
      if (typeof stickers?.send !== "function") throw new Error("当前版本无法发送收藏表情包。");
      const result = await stickers.send({ id: clean(id) });
      viewState.emojiOpen = false;
      viewState.error = "";
      viewState.notice = "";
      viewState.shouldStickToLatest = true;
      scheduleScrollToLatest();
      focusComposer();
      context.render();
      void load(context, true);
      return result;
    },
    jumpFromMediaPreview: async ({ lineNumber, messageId } = {}) => {
      viewState.mediaPreview = null;
      await focusConversationRecord(context, { lineNumber, messageId });
    },
  };
}
