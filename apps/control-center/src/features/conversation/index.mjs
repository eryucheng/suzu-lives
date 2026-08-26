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
import { PRODUCT_FEATURES } from "../../../shared/product-features.mjs";
import {
  hasConversationMarkdownFormatting,
  splitConversationReplyBuffer,
} from "../../../shared/conversation-reply-segmentation.mjs";

export { parseSuzuConversationCommand } from "../../../shared/conversation-command.mjs";

const viewState = {
  attachments: [],
  attachmentPicking: false,
  avatarCrop: null,
  busySessions: new Set(),
  transientSystemMessages: [],
  composerFocusRequest: 0,
  confirmation: null,
  contactCreateOpen: false,
  contactContextMenu: null,
  contactRenameOpen: false,
  fileContextMenu: null,
  messageContextMenu: null,
  draft: "",
  emojiOpen: false,
  error: "",
  focus: null,
  lastVersion: null,
  livePresentationOrder: 0,
  liveReplies: new Map(),
  liveTools: [],
  historyLoadingOlder: false,
  historyLoadEpoch: 0,
  historyWindowDetached: false,
  listScrollTop: 0,
  loading: false,
  loadTask: null,
  menuOpen: false,
  mode: "snapshot",
  mediaPreview: null,
  notice: "",
  pending: [],
  pendingLoad: null,
  permissions: new Map(),
  replyFinalizationContexts: new Map(),
  replyFinalizing: new Set(),
  replyRevealTimers: new Map(),
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
  contactCapabilitiesSnapshot: null,
  wechatSnapshot: null,
  wechatQrOpen: false,
  wechatUnsubscribe: null,
  qqSnapshot: null,
  qqBindingOpen: false,
  qqUnsubscribe: null,
};

let pendingConfirmationResolve = null;

const TRANSCRIPT_MATCH_GRACE_MS = 5_000;
const MAX_COMPOSER_ATTACHMENTS = 24;
const MAX_COMPOSER_IMAGES = 20;
const CLIPBOARD_IMAGE_EXTENSION_BY_MIME = Object.freeze({
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
});
const COPYABLE_IMAGE_MEDIA_KINDS = new Set(["image", "sticker"]);
export const COMPLETED_REPLY_BUBBLE_INTERVAL_MS = 300;

// Direct terminal work should be inspectable in the normal chat flow.  Other
// optional diagnostic blocks remain opt-in, but tool calls/results are shown
// unless the user explicitly hides them.
const defaults = { attachments: false, dynamicContext: false, tools: true, thinking: false, system: false, tokens: false, timeDisplay: "center" };
const CENTER_TIME_GAP_MS = 5 * 60 * 1_000;
// Keep a bounded data window even though the durable Agent Core transcript can
// grow indefinitely.  Rendering is virtualized separately; this limit prevents
// the client state and row projection from growing without bound as a person
// repeatedly loads older pages.
export const CONVERSATION_MESSAGE_WINDOW_MAX = 720;

function nextLivePresentationOrder() {
  viewState.livePresentationOrder += 1;
  return viewState.livePresentationOrder;
}

function preferences(settings) {
  return { ...defaults, ...(settings?.conversationPreferences || {}) };
}

function clean(value) {
  return String(value ?? "").trim();
}

export function hasMarkdownFormatting(value) {
  return hasConversationMarkdownFormatting(value);
}

function clipboardImageMimeType(value, fileName = "") {
  const mimeType = clean(value).toLowerCase().split(";", 1)[0];
  if (mimeType === "image/jpg") return "image/jpeg";
  if (mimeType) return mimeType;
  const sourceName = clean(fileName).toLowerCase();
  if (/\.gif$/u.test(sourceName)) return "image/gif";
  if (/\.jpe?g$/u.test(sourceName)) return "image/jpeg";
  if (/\.png$/u.test(sourceName)) return "image/png";
  if (/\.webp$/u.test(sourceName)) return "image/webp";
  return "";
}

function releaseComposerAttachmentPreview(item) {
  const fileUrl = clean(item?.fileUrl);
  if (!fileUrl.startsWith("blob:") || typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") return;
  try {
    URL.revokeObjectURL(fileUrl);
  } catch {
    // A browser may have already released the local preview while the turn ended.
  }
}

function releaseComposerAttachmentPreviews(items) {
  for (const item of Array.isArray(items) ? items : []) releaseComposerAttachmentPreview(item);
}

function composerAttachmentSelections(items, previews = []) {
  return (Array.isArray(items) ? items : []).flatMap((item, index) => {
    const token = clean(item?.selectionToken);
    const fileName = clean(item?.fileName);
    const kind = clean(item?.kind).toLowerCase();
    const size = Number(item?.size);
    if (!token || !fileName || !new Set(["file", "image"]).has(kind) || !Number.isSafeInteger(size) || size <= 0) return [];
    return [{
      fileName,
      fileUrl: clean(previews[index]?.fileUrl) || clean(item?.fileUrl),
      kind,
      mimeType: clean(item?.mimeType),
      selectionToken: token,
      size,
    }];
  });
}

function appendComposerAttachments(items) {
  const existing = new Set(viewState.attachments.map((item) => clean(item?.selectionToken)));
  const appended = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (existing.has(item.selectionToken) || viewState.attachments.length + appended.length >= MAX_COMPOSER_ATTACHMENTS) continue;
    existing.add(item.selectionToken);
    appended.push(item);
  }
  viewState.attachments = [...viewState.attachments, ...appended];
  return appended;
}

async function clipboardImageAttachment(value, { index, pastedAt }) {
  const source = value && typeof value === "object" ? value : {};
  const mimeType = clipboardImageMimeType(source.type || source.mimeType, source.name || source.fileName);
  const extension = CLIPBOARD_IMAGE_EXTENSION_BY_MIME[mimeType];
  if (!extension) throw new Error("剪贴板图片格式只支持 PNG、JPG、GIF 或 WebP。");
  let data = null;
  if (source.data instanceof Uint8Array) data = source.data;
  else if (source.data instanceof ArrayBuffer) data = new Uint8Array(source.data);
  else if (typeof source.arrayBuffer === "function") data = new Uint8Array(await source.arrayBuffer());
  if (!data?.byteLength) throw new Error("剪贴板图片内容无效。");
  let fileUrl = clean(source.fileUrl);
  if (!fileUrl && typeof URL !== "undefined" && typeof URL.createObjectURL === "function" && typeof Blob !== "undefined" && source instanceof Blob) {
    fileUrl = URL.createObjectURL(source);
  }
  return {
    data,
    fileName: `clipboard-image-${pastedAt}-${index + 1}.${extension}`,
    fileUrl,
    kind: "image",
    mimeType,
    size: data.byteLength,
  };
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

function contextMenuPosition(point = {}, { height: menuHeight, width: menuWidth } = {}) {
  const width = typeof window === "undefined" ? 0 : Number(window.innerWidth) || 0;
  const height = typeof window === "undefined" ? 0 : Number(window.innerHeight) || 0;
  const x = Math.round(Number(point?.x));
  const y = Math.round(Number(point?.y));
  return {
    x: Math.max(12, Math.min(Number.isFinite(x) ? x : 12, width ? Math.max(12, width - (Number(menuWidth) || 208)) : Number.POSITIVE_INFINITY)),
    y: Math.max(12, Math.min(Number.isFinite(y) ? y : 12, height ? Math.max(12, height - (Number(menuHeight) || 252)) : Number.POSITIVE_INFINITY)),
  };
}

function contactContextMenuPosition(point = {}) {
  return contextMenuPosition(point, { height: 252, width: 208 });
}

function fileContextMenuPosition(point = {}) {
  return contextMenuPosition(point, { height: 112, width: 176 });
}

function messageContextMenuPosition(point = {}, itemCount = 1) {
  return contextMenuPosition(point, { height: Math.max(64, 12 + Math.max(1, Number(itemCount) || 1) * 42), width: 176 });
}

function messageTextForCopy(row) {
  return (Array.isArray(row?.blocks) ? row.blocks : [])
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .filter((text) => text.trim())
    .join("\n\n");
}

function messageImagesForCopy(row) {
  return (Array.isArray(row?.blocks) ? row.blocks : [])
    .filter((block) => block?.type === "media" && COPYABLE_IMAGE_MEDIA_KINDS.has(clean(block.mediaKind)) && clean(block.fileUrl))
    .map((block) => ({
      fileName: clean(block.fileName) || "图片",
      fileUrl: clean(block.fileUrl),
    }));
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

function messageMatchIndex(items, kind, content, localTimestamp, media = [], ignored = new Set()) {
  const target = clean(content);
  const expectedMedia = Array.isArray(media) ? media : [];
  if (!target && !expectedMedia.length) return -1;
  const localTime = Date.parse(localTimestamp);
  for (let index = 0; index < (items || []).length; index += 1) {
    const item = items[index];
    if (ignored.has(item)) continue;
    if (item.kind !== kind) continue;
    if (target && messageText(item) !== target) continue;
    if (!sameMedia(item.blocks, expectedMedia)) continue;
    if (!Number.isFinite(localTime)) return index;
    const transcriptTime = Date.parse(item.timestamp);
    if (Number.isFinite(transcriptTime) && transcriptTime >= localTime - TRANSCRIPT_MATCH_GRACE_MS) return index;
  }
  return -1;
}

function messageMatches(items, kind, content, localTimestamp, media = []) {
  return messageMatchIndex(items, kind, content, localTimestamp, media) >= 0;
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

function insertMessageAtTimestamp(items, message) {
  const timestamp = Date.parse(message?.timestamp);
  if (!Number.isFinite(timestamp)) return [...items, message];
  const index = items.findIndex((item) => {
    const itemTimestamp = Date.parse(item?.timestamp);
    return Number.isFinite(itemTimestamp) && itemTimestamp > timestamp;
  });
  return index < 0
    ? [...items, message]
    : [...items.slice(0, index), message, ...items.slice(index)];
}

function optionalTimelineSequence(item) {
  const value = item?.coreSequence ?? item?.lineNumber;
  if (value === null || value === undefined || value === "") return null;
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}

function optionalPresentationOrder(item) {
  const value = item?.presentationOrder;
  if (value === null || value === undefined || value === "") return null;
  const order = Number(value);
  return Number.isSafeInteger(order) && order >= 0 ? order : null;
}

function compareLivePresentationMessages(left, right) {
  const leftSequence = optionalTimelineSequence(left);
  const rightSequence = optionalTimelineSequence(right);
  if (leftSequence !== null && rightSequence !== null && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }
  const leftOrder = optionalPresentationOrder(left);
  const rightOrder = optionalPresentationOrder(right);
  if (leftOrder !== null && rightOrder !== null && leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  const leftTimestamp = Date.parse(left?.timestamp);
  const rightTimestamp = Date.parse(right?.timestamp);
  if (Number.isFinite(leftTimestamp) && Number.isFinite(rightTimestamp) && leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }
  return 0;
}

function orderedLivePresentationMessages(items) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => ({ index, item }))
    .sort((left, right) => compareLivePresentationMessages(left.item, right.item) || left.index - right.index)
    .map(({ item }) => item);
}

function insertLivePresentationMessage(items, message) {
  const sequence = optionalTimelineSequence(message);
  if (sequence !== null) {
    const index = items.findIndex((item) => {
      const itemSequence = optionalTimelineSequence(item);
      return itemSequence !== null && itemSequence > sequence;
    });
    return index < 0
      ? [...items, message]
      : [...items.slice(0, index), message, ...items.slice(index)];
  }
  return timestampsFollowAppendOrder(items)
    ? insertMessageAtTimestamp(items, message)
    : [...items, message];
}

function insertPendingMessageAtTimestamp(items, message) {
  const timestamp = Date.parse(message?.timestamp);
  if (!Number.isFinite(timestamp)) return [...items, message];
  const index = items.findIndex((item) => {
    const itemTimestamp = Date.parse(item?.timestamp);
    return Number.isFinite(itemTimestamp) && itemTimestamp > timestamp;
  });
  return index < 0
    ? [...items, message]
    : [...items.slice(0, index), message, ...items.slice(index)];
}

function pendingUserMessage(item) {
  return {
    animateIn: Boolean(item.animateIn),
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
  };
}

function anchorPendingUsersInTranscript(source, pendingItems) {
  const pending = (Array.isArray(pendingItems) ? pendingItems : []);
  const matchedSourceItems = new Set();
  const pendingWithoutDurableMessage = [];
  let timeline = [...source];

  for (const pendingItem of pending) {
    const sourceIndex = messageMatchIndex(
      source,
      "user",
      pendingItem.content,
      pendingItem.timestamp,
      pendingItem.media,
      matchedSourceItems,
    );
    if (sourceIndex < 0) {
      pendingWithoutDurableMessage.push(pendingUserMessage(pendingItem));
      continue;
    }
    const durableItem = source[sourceIndex];
    matchedSourceItems.add(durableItem);
    const timelineIndex = timeline.indexOf(durableItem);
    if (timelineIndex < 0) continue;
    timeline = [...timeline.slice(0, timelineIndex), ...timeline.slice(timelineIndex + 1)];
    // Agent Core may append the durable input after an assistant step. The
    // locally recorded send time is the human-visible chronology, so retain
    // the durable message and move it back ahead of that step rather than
    // letting the matching pending bubble disappear at the bottom.
    timeline = insertPendingMessageAtTimestamp(timeline, {
      ...durableItem,
      timestamp: clean(pendingItem.timestamp) || durableItem.timestamp,
    });
  }

  return pendingWithoutDurableMessage.reduce(
    (items, message) => insertPendingMessageAtTimestamp(items, message),
    timeline,
  );
}

function liveReplySentences(item) {
  const sentences = allLiveReplySentences(item);
  const visibleCount = visibleLiveReplySentenceCount(item, sentences.length);
  return sentences.slice(0, visibleCount);
}

function allLiveReplySentences(item) {
  // Projected live replies always carry `sentences`: an empty array means the
  // current token buffer is intentionally still hidden. The content fallback
  // is only for older/foreign reply records that predate sentence projection.
  if (Array.isArray(item?.sentences)) {
    return item.sentences.map((value) => String(value ?? "")).filter((value) => clean(value));
  }
  const fallback = String(item?.content ?? "");
  return clean(fallback) ? [fallback] : [];
}

function liveReplySentenceTimelineMetadata(item, index) {
  const timeline = Array.isArray(item?.sentenceTimeline) ? item.sentenceTimeline : [];
  const entry = timeline[index];
  const timestamp = clean(entry?.timestamp) || clean(item?.timestamp);
  const coreSequence = optionalTimelineSequence(entry) ?? optionalTimelineSequence(item);
  const presentationOrder = optionalPresentationOrder(entry) ?? optionalPresentationOrder(item);
  return {
    ...(timestamp ? { timestamp } : {}),
    ...(coreSequence === null ? {} : { coreSequence }),
    ...(presentationOrder === null ? {} : { presentationOrder }),
  };
}

function liveReplyEventTimelineMetadata(event, fallbackTimestamp = "") {
  const timestamp = clean(event?.timestamp) || clean(fallbackTimestamp) || new Date().toISOString();
  const coreSequence = optionalTimelineSequence(event);
  const presentationOrder = optionalPresentationOrder(event);
  return {
    timestamp,
    ...(coreSequence === null ? {} : { coreSequence }),
    ...(presentationOrder === null ? {} : { presentationOrder }),
  };
}

function reconcileLiveReplySentenceTimeline(previous, sentences, event) {
  const previousSentences = allLiveReplySentences(previous);
  return sentences.map((text, index) => (
    previousSentences[index] === text
      ? liveReplySentenceTimelineMetadata(previous, index)
      : liveReplyEventTimelineMetadata(event, liveReplyTimestamp(previous, event))
  ));
}

function visibleLiveReplySentenceCount(item, total) {
  const configured = Number(item?.visibleSentenceCount);
  if (!Number.isSafeInteger(configured)) return total;
  return Math.min(Math.max(configured, 0), total);
}

function hasHiddenLiveReplySentences(item) {
  const sentences = allLiveReplySentences(item);
  return visibleLiveReplySentenceCount(item, sentences.length) < sentences.length;
}

function withVisibleLiveReplySentences(previous, next) {
  if (!next) return null;
  const sentences = allLiveReplySentences(next);
  const priorVisible = previous
    ? visibleLiveReplySentenceCount(previous, allLiveReplySentences(previous).length)
    : 0;
  const visibleSentenceCount = sentences.length
    ? Math.min(sentences.length, Math.max(priorVisible, 1))
    : 0;
  return { ...next, visibleSentenceCount };
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
  return liveReplySentences(item).map((text, index) => {
    const timeline = liveReplySentenceTimelineMetadata(item, index);
    return {
      // This message only exists while the live reply is being projected. Mark
      // it as new so the renderer can play one entrance animation on mount.
      animateIn: true,
      id: `reply-${id}-sentence-${index + 1}`,
      kind: "assistant",
      sourceMessageId: `reply-${id}`,
      // A bubble only enters this projection after a whole sentence is ready,
      // so it must never use the token-streaming visual treatment.
      streaming: false,
      timestamp: timeline.timestamp || item.timestamp,
      ...(timeline.coreSequence === undefined ? {} : { coreSequence: timeline.coreSequence }),
      ...(timeline.presentationOrder === undefined ? {} : { presentationOrder: timeline.presentationOrder }),
      blocks: [{ kind: "text", text }],
    };
  });
}

export function mergeConversationMessages(items, pendingItems = [], liveReplyItems = new Map(), activeSessionId = "", transientSystemMessages = [], transientToolMessages = []) {
  const source = Array.isArray(items) ? items : [];
  const sessionId = clean(activeSessionId);
  const pending = (Array.isArray(pendingItems) ? pendingItems : [])
    .filter((item) => item.sessionId === sessionId);
  const replyValues = liveReplyValues(liveReplyItems);
  const liveReplies = replyValues
    .filter((item) => (
      item.sessionId === sessionId
      && (!clean(item.content) || !messageMatches(source, "assistant", item.content, item.timestamp))
    ))
    .flatMap(liveReplyMessages);
  const visibleLocalMessage = (item) => (
    ["assistant", "system"].includes(item?.kind)
      && clean(item.sessionId) === sessionId
      && hasDisplayableBlock(item)
      // A finalized call transcript first appears immediately as a local
      // system row, then arrives durably from Agent Core.  Retire only that
      // exact local duplicate once the stored conversation has caught up.
      && (item.kind !== "system" || !messageMatches(source, "system", messageText(item), item.timestamp))
  );
  // Call markers use their existing local append behavior until Agent Core
  // persists them. Tool rows and streamed text instead share one Core event
  // timeline, so a response can remain between the tool events that surround it.
  const transientSystemRows = (Array.isArray(transientSystemMessages) ? transientSystemMessages : [])
    .filter(visibleLocalMessage);
  const transientToolRows = (Array.isArray(transientToolMessages) ? transientToolMessages : [])
    .filter(visibleLocalMessage);
  // Keep the pending send timestamp as an anchor both before and after the
  // same user message becomes durable. This protects the human-facing order
  // when Agent Core writes its input event later than its first assistant step.
  const sourceWithPending = anchorPendingUsersInTranscript(source, pending);
  const baseTimeline = [...sourceWithPending, ...transientSystemRows];
  return orderedLivePresentationMessages([...transientToolRows, ...liveReplies])
    .reduce((timeline, message) => insertLivePresentationMessage(timeline, message), baseTimeline);
}

function displayedMessages(items) {
  return filterDeletedConversationMessages(mergeConversationMessages(
    items,
    viewState.pending,
    viewState.liveReplies,
    clean(viewState.snapshot?.activeSessionId),
    viewState.transientSystemMessages,
    viewState.liveTools,
  ), viewState.snapshot?.deletedEventSequences);
}

/**
 * The main-process reader is the source of truth for hiding historical rows.
 * Retain the same filter at the renderer boundary so an already-returned
 * snapshot cannot briefly reintroduce a row while React is reconciling it.
 * Local/live rows do not carry a durable event sequence and are left alone.
 */
export function filterDeletedConversationMessages(items, deletedEventSequences = []) {
  const source = Array.isArray(items) ? items : [];
  const hidden = new Set((Array.isArray(deletedEventSequences) ? deletedEventSequences : [])
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0));
  if (!hidden.size) return source;
  return source.filter((item) => {
    const lineNumber = messageLineNumber(item);
    return !lineNumber || !hidden.has(lineNumber);
  });
}

export function filterConversationItems(items, configuredPreferences = {}) {
  const prefs = { ...defaults, ...configuredPreferences };
  return (items || []).flatMap((item) => {
    if ((item.kind === "attachment" && !prefs.attachments)
      || (item.kind === "dynamic-context" && !prefs.dynamicContext)
      || (item.kind === "system" && !prefs.system)) return [];
    const blocks = (item.blocks || []).filter((value) => {
      if (value.kind === "thinking") return prefs.thinking;
      return !((value.kind === "tool_use" || value.kind === "tool_result") && !prefs.tools);
    });
    return blocks.length || (item.kind === "assistant" && prefs.tokens && item.usage) ? [{ ...item, blocks }] : [];
  });
}

export function splitCompanionReplyBuffer(value, { final = false } = {}) {
  return splitConversationReplyBuffer(value, { final });
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

export function projectedLiveReply(previous, event, { final = false } = {}) {
  // The terminal reply for a multi-step turn is an aggregate transport value.
  // Every assistant step is already persisted and shown as its own chat row,
  // so replacing the live sentence projection with that aggregate would add a
  // second, oversized copy at completion.
  const retainStreamProjection = final && Number(event?.assistantMessageCount) > 1;
  const content = retainStreamProjection
    ? String(previous?.content ?? "")
    : mergeLiveReplyContent(previous?.content, event?.content);
  const delivery = retainStreamProjection
    ? {
      remainder: String(previous?.remainder ?? ""),
      sentences: Array.isArray(previous?.sentences) ? previous.sentences : [],
    }
    : splitCompanionReplyBuffer(content, { final });
  const previousCount = allLiveReplySentences(previous).length;
  const deliveredNewSentence = delivery.sentences.length > previousCount;
  return {
    ...previous,
    content,
    done: final,
    phase: final ? "idle" : deliveredNewSentence ? "delivering" : previous?.phase === "thinking" ? "thinking" : "thinking",
    remainder: delivery.remainder,
    requestId: clean(event?.requestId) || clean(previous?.requestId),
    sentences: delivery.sentences,
    sentenceTimeline: reconcileLiveReplySentenceTimeline(previous, delivery.sentences, event),
    sessionId: clean(event?.sessionId) || clean(previous?.sessionId),
    timestamp: liveReplyTimestamp(previous, event),
  };
}

function sameLiveReplySentences(previous, next) {
  const previousSentences = liveReplySentences(previous);
  const nextSentences = liveReplySentences(next);
  return previousSentences.length === nextSentences.length
    && previousSentences.every((sentence, index) => sentence === nextSentences[index]);
}

function liveReplyMessagesChanged(previous, next) {
  return !sameLiveReplySentences(previous, next);
}

export function liveReplyPresentationChanged(previous, next) {
  if (!previous || !next) return previous !== next;
  return Boolean(previous.done) !== Boolean(next.done)
    || clean(previous.phase) !== clean(next.phase)
    || liveReplyMessagesChanged(previous, next);
}

function finishedLiveReply(reply, event = {}) {
  if (!reply) return null;
  if (reply.done === true) return reply;
  const delivery = splitCompanionReplyBuffer(reply.content, { final: true });
  return {
    ...reply,
    done: true,
    phase: "idle",
    remainder: delivery.remainder,
    sentences: delivery.sentences,
    sentenceTimeline: reconcileLiveReplySentenceTimeline(reply, delivery.sentences, event),
  };
}

function replyRevealSetTimeout(callback) {
  if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
    return window.setTimeout(callback, COMPLETED_REPLY_BUBBLE_INTERVAL_MS);
  }
  return globalThis.setTimeout(callback, COMPLETED_REPLY_BUBBLE_INTERVAL_MS);
}

function clearReplyRevealTimeout(timer) {
  if (typeof window !== "undefined" && typeof window.clearTimeout === "function") {
    window.clearTimeout(timer);
    return;
  }
  globalThis.clearTimeout(timer);
}

function clearReplyReveal(requestId) {
  const timer = viewState.replyRevealTimers.get(requestId);
  if (timer !== undefined) clearReplyRevealTimeout(timer);
  viewState.replyRevealTimers.delete(requestId);
  viewState.replyFinalizationContexts.delete(requestId);
  viewState.replyFinalizing.delete(requestId);
}

function clearReplyReveals() {
  for (const requestId of viewState.replyRevealTimers.keys()) clearReplyReveal(requestId);
  viewState.replyFinalizationContexts.clear();
  viewState.replyFinalizing.clear();
}

function finishCompletedLiveReply(requestId) {
  const reply = viewState.liveReplies.get(requestId);
  if (!reply?.done || hasHiddenLiveReplySentences(reply)) return;
  const finalizationContext = viewState.replyFinalizationContexts.get(requestId);
  if (!finalizationContext || viewState.replyFinalizing.has(requestId)) return;
  viewState.replyFinalizationContexts.delete(requestId);
  viewState.replyFinalizing.add(requestId);
  void load(finalizationContext, true)
    .then((loaded) => {
      if (loaded === true) viewState.liveReplies.delete(requestId);
    })
    .finally(() => {
      viewState.replyFinalizing.delete(requestId);
      viewState.liveTools = viewState.liveTools.filter((item) => item.requestId !== requestId);
      finalizationContext.render();
    });
}

function scheduleLiveReplyReveal(context, requestId) {
  const reply = viewState.liveReplies.get(requestId);
  if (!reply) return;
  if (!hasHiddenLiveReplySentences(reply)) {
    finishCompletedLiveReply(requestId);
    return;
  }
  if (viewState.replyRevealTimers.has(requestId)) return;
  const timer = replyRevealSetTimeout(() => {
    viewState.replyRevealTimers.delete(requestId);
    const current = viewState.liveReplies.get(requestId);
    if (!current || !hasHiddenLiveReplySentences(current)) {
      finishCompletedLiveReply(requestId);
      return;
    }
    const total = allLiveReplySentences(current).length;
    const next = {
      ...current,
      phase: current.done ? current.phase : "delivering",
      visibleSentenceCount: Math.min(total, visibleLiveReplySentenceCount(current, total) + 1),
    };
    const messagesChanged = liveReplyMessagesChanged(current, next);
    const presentationChanged = liveReplyPresentationChanged(current, next);
    viewState.liveReplies.set(requestId, next);
    if (messagesChanged) {
      if (!viewState.shouldStickToLatest) viewState.unread = true;
      scheduleScrollToLatest();
    }
    if (presentationChanged) context.render();
    if (hasHiddenLiveReplySentences(next)) scheduleLiveReplyReveal(context, requestId);
    else finishCompletedLiveReply(requestId);
  });
  viewState.replyRevealTimers.set(requestId, timer);
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

function pendingMessageIdForDurableUserMessage(message) {
  if (clean(message?.kind) !== "user") return "";
  const lineNumber = messageLineNumber(message);
  const messageId = clean(message?.messageId);
  const source = (Array.isArray(currentPayload()?.messages) ? currentPayload().messages : [])
    .find((item) => (
      messageLineNumber(item) === lineNumber
      && (!messageId || messageSourceId(item) === messageId)
    ));
  if (!source) return "";
  const sessionId = clean(viewState.snapshot?.activeSessionId);
  const sourceTimestamp = Date.parse(source.timestamp);
  const candidates = viewState.pending
    .filter((item) => (
      clean(item?.sessionId) === sessionId
      && messageMatches([source], "user", item?.content, item?.timestamp, item?.media)
    ))
    .map((item, index) => ({
      id: clean(item?.id),
      index,
      distance: Number.isFinite(sourceTimestamp) && Number.isFinite(Date.parse(item?.timestamp))
        ? Math.abs(sourceTimestamp - Date.parse(item.timestamp))
        : Number.POSITIVE_INFINITY,
    }))
    .filter((item) => item.id)
    .sort((left, right) => left.distance - right.distance || left.index - right.index);
  return candidates[0]?.id || "";
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
    };
  }
  if (value.kind === "thinking" && !prefs.thinking) return null;
  if ((value.kind === "tool_use" || value.kind === "tool_result") && !prefs.tools) return null;
  const toolBlock = value.kind === "tool_use" || value.kind === "tool_result";
  const toolName = clean(value.name) || "工具";
  const title = value.kind === "thinking"
    ? `思考 · ${value.preview || ""}`
    : value.kind === "tool_use"
      ? `工具调用 · ${toolName}${value.summary ? ` · ${value.summary}` : ""}`
      : `${value.error ? "工具结果（错误）" : "工具结果"}${value.summary ? ` · ${value.summary}` : ""}`;
  return {
    detail: String(value.text || value.detail || value.summary || ""),
    title,
    type: "detail",
    ...(toolBlock ? {
      detailKind: value.kind,
      ...(value.error ? { error: true } : {}),
    } : {}),
  };
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

// The product-use assistant has its own session and avatars, but its transcript
// still uses the exact same text, media, and tool-detail blocks as a normal
// conversation. Keep that conversion here so it cannot drift into a second
// renderer with subtly different tool cards.
export function conversationMessageBlocks(message, configuredPreferences = {}) {
  return messageBlocks(message, { ...defaults, ...configuredPreferences });
}

function messageRow(message, context, showTimestamp = true) {
  const prefs = preferences(context.state.settings);
  if ((message.kind === "attachment" && !prefs.attachments)
    || (message.kind === "dynamic-context" && !prefs.dynamicContext)
    || (message.kind === "system" && !prefs.system)) return null;
  const profile = message.kind === "user"
    ? getIdentity(context.state.settings).owner
    : message.kind === "assistant"
      ? getAgentProfile(context.state.settings)
      : null;
  const blocks = messageBlocks(message, prefs);
  const mediaOnly = message.blocks.length === 1 && message.blocks[0]?.kind === "media";
  const audioOnly = blocks.length === 1 && blocks[0]?.type === "audio";
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
    audioOnly,
    avatar: profile ? avatarPayload(profile, profile.displayName) : null,
    blocks,
    deletable: Boolean(
      lineNumber > 0
      && !message.pending
      && !message.streaming
      && ["user", "assistant", "dynamic-context"].includes(clean(message.kind)),
    ),
    entering: Boolean(message.animateIn),
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

function isToolActivityBlock(block) {
  return block?.type === "detail" && ["tool_use", "tool_result"].includes(block.detailKind);
}

function isToolActivityMessageRow(row) {
  return row?.type === "message"
    && row.kind === "assistant"
    && !row.usage
    && Array.isArray(row.blocks)
    && row.blocks.length > 0
    && row.blocks.every(isToolActivityBlock);
}

// Keep the transcript model granular for ordering, search, and persistence,
// then collapse only adjacent tool-only rows for the shared React renderer.
// This also makes the compact tool presentation available in the software
// assistant, which reuses ConversationMessageList with its own message rows.
export function groupConversationToolActivityRows(rows) {
  const grouped = [];
  let current = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isToolActivityMessageRow(row)) {
      current = null;
      grouped.push(row);
      continue;
    }
    if (!current) {
      current = {
        anchorId: row.anchorId,
        entries: [],
        entering: Boolean(row.entering),
        focused: Boolean(row.focused),
        lineNumber: row.lineNumber,
        live: Boolean(row.live),
        sourceMessageId: row.sourceMessageId,
        timestamp: row.timestamp,
        type: "tool-group",
      };
      grouped.push(current);
    }
    current.entries.push(...row.blocks.map((block) => ({
      ...block,
      anchorId: row.anchorId,
      focused: Boolean(row.focused),
      lineNumber: row.lineNumber,
      sourceMessageId: row.sourceMessageId,
    })));
    current.entering ||= Boolean(row.entering);
    current.focused ||= Boolean(row.focused);
    current.live ||= Boolean(row.live);
  }
  return grouped;
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
    const dividerAnchorId = next.anchorId || next.sourceMessageId || (next.lineNumber ? `line-${next.lineNumber}` : "");
    if (style === "center") {
      if (shouldShowCenteredTimeDivider(previousTimestamp, item.timestamp)) {
        rows.push({ anchorId: `time-${dividerAnchorId}`, label: wechatTimeLabel(item.timestamp), type: "time" });
      }
      if (dateFromTimestamp(item.timestamp)) previousTimestamp = item.timestamp;
    } else {
      const day = conversationDay(item.timestamp);
      if (day && day !== previousDay) rows.push({ anchorId: `day-${dividerAnchorId}`, label: day, type: "day" });
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
  // An older-window view no longer contains the live tail. Keep its reading
  // position intact and expose the existing return-to-latest affordance
  // instead of treating the bottom of that historical window as "latest".
  if (isHistoryWindowDetached()) {
    viewState.unread = true;
    return;
  }
  viewState.scrollToLatestRequest += 1;
  viewState.unread = false;
}

function focusComposer() {
  viewState.composerFocusRequest += 1;
}

function conversationConfirmationSnapshot() {
  const confirmation = viewState.confirmation;
  if (!confirmation) return null;
  return {
    cancelLabel: clean(confirmation.cancelLabel) || "取消",
    confirmLabel: clean(confirmation.confirmLabel) || "确认",
    detail: clean(confirmation.detail),
    message: clean(confirmation.message),
    title: clean(confirmation.title) || "请确认",
  };
}

function settleConversationConfirmation(accepted) {
  const resolve = pendingConfirmationResolve;
  pendingConfirmationResolve = null;
  viewState.confirmation = null;
  resolve?.(accepted === true);
  return Boolean(resolve);
}

function requestConversationConfirmation(context, confirmation) {
  settleConversationConfirmation(false);
  return new Promise((resolve) => {
    pendingConfirmationResolve = resolve;
    viewState.confirmation = {
      cancelLabel: clean(confirmation?.cancelLabel) || "取消",
      confirmLabel: clean(confirmation?.confirmLabel) || "确认",
      detail: clean(confirmation?.detail),
      message: clean(confirmation?.message),
      title: clean(confirmation?.title) || "请确认",
    };
    context.render();
  });
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

function proactiveContactEnabled(contactId) {
  const id = clean(contactId);
  const capabilities = Array.isArray(viewState.contactCapabilitiesSnapshot?.capabilities)
    ? viewState.contactCapabilitiesSnapshot.capabilities
    : [];
  const proactiveContact = capabilities.find((capability) => clean(capability?.id) === "proactive-contact");
  if (!proactiveContact || !Array.isArray(proactiveContact?.savedSettings?.enabledContactIds)) return true;
  return proactiveContact.savedSettings.enabledContactIds.map(clean).includes(id);
}

function sessionSettingsSnapshot(context, selected, prefs) {
  const contact = viewState.snapshot?.activeContact || null;
  const contactId = clean(contact?.id);
  const sessionId = clean(selected?.id);
  if (!contactId) return null;
  const contactName = clean(contact?.name) || clean(selected?.title) || "未命名联系人";
  const agent = getAgentProfile(context.state.settings);
  const wechat = viewState.wechatSnapshot;
  const qq = viewState.qqSnapshot;
  // The WeChat connector is scoped by contact ID. Its snapshot deliberately
  // exposes the selected contact link as `contact`, not the Agent session.
  const connection = wechat?.contact || null;
  const pendingQr = wechat?.pendingQr || null;
  const connectionLabel = !wechat
    ? "正在读取微信连接状态"
    : connection
      ? (connection.enabled ? (connection.status === "connected" ? "已连接" : "已保存，正在恢复") : "这位联系人的微信连接已暂停")
      : pendingQr
        ? (pendingQr.status === "scanned" ? "手机已扫码，请在微信确认" : "等待微信扫码")
        : "尚未连接";
  const wechatControl = !wechat
    ? null
    : connection
      ? { enabled: Boolean(connection.enabled), type: "connection" }
      : pendingQr
      ? { type: "pending-qr" }
      : { type: "begin" };
  const qqConnection = qq?.contact || null;
  const pendingBinding = qq?.pendingBinding || null;
  const qqBot = qq?.bot || null;
  const qqConnectionLabel = !qq
    ? "正在读取 QQ 连接状态"
    : !qqBot?.configured
      ? "QQ 机器人尚未配置"
      : qqConnection
        ? (qqConnection.enabled ? (qqConnection.status === "connected" ? "已连接" : qqConnection.status === "attention" ? "需要处理" : "已保存，正在恢复") : "这位联系人的 QQ 连接已暂停")
        : pendingBinding
          ? "等待在 QQ 中发送绑定码"
          : "尚未连接";
  const qqControl = !qq
    ? null
    : !qqBot?.configured
      ? { type: "not-configured" }
      : qqConnection
        ? { enabled: Boolean(qqConnection.enabled), type: "connection" }
        : pendingBinding
          ? { type: "pending-binding" }
          : { type: "begin" };
  return {
    contactAvatar: contact ? avatarPayload(agent, contactName) : null,
    contactId,
    contactName,
    hasSession: Boolean(sessionId),
    preferences: Object.entries({
      attachments: "显示 Hook / 上下文",
      dynamicContext: "显示动态上下文",
      tools: "显示工具调用",
      thinking: "显示思考内容",
      system: "显示系统消息",
      tokens: "显示 Token 用量",
    }).map(([key, label]) => ({ checked: Boolean(prefs[key]), key, label })),
    longTermMemoryEnabled: longTermMemoryEnabled(contact?.longTermMemoryEnabled),
    proactiveContactEnabled: proactiveContactEnabled(contactId),
    permissionMode: clean(contact?.permissionMode) || "danger-full-access",
    removeContactAvatar: Boolean(agent.avatarDataUrl),
    saving: viewState.sending,
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
    qq: contactId ? {
      connectionError: clean(qqConnection?.lastError),
      control: qqControl,
      enabled: Boolean(qqConnection?.enabled),
      hint: Boolean(qqConnection),
      pendingBindingError: "",
      status: qqConnectionLabel,
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

function qqBindingSnapshot(contact) {
  const pendingBinding = viewState.qqSnapshot?.pendingBinding;
  const code = clean(pendingBinding?.code);
  if (!viewState.qqBindingOpen || !code) return null;
  return {
    code,
    expiresAt: clean(pendingBinding?.expiresAt),
    title: clean(contact?.name) || "当前联系人",
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
  const snapshot = viewState.snapshot || {};
  const entries = filterDeletedConversationMessages(
    viewState.mode === "focus" ? sourceEntries : displayedMessages(sourceEntries),
    snapshot.deletedEventSequences,
  );
  const prefs = preferences(context.state.settings);
  const historyAvailable = snapshot.history?.status !== "unavailable";
  const ready = (snapshot.status || payload?.status) === "ready" && historyAvailable;
  const agent = getAgentProfile(context.state.settings);
  const identity = getIdentity(context.state.settings);
  const contacts = snapshot.contacts || [];
  const activeContact = snapshot.activeContact?.hidden === true ? null : snapshot.activeContact || null;
  const selected = activeContact ? activeSession(snapshot) : null;
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
  const hiddenContactCount = Math.max(
    Number.isSafeInteger(snapshot.hiddenContactCount) ? snapshot.hiddenContactCount : 0,
    allContactRows.length - contactRows.length,
  );
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
  const fileContextMenuState = viewState.fileContextMenu;
  const fileContextMenu = clean(fileContextMenuState?.fileUrl)
    ? {
      fileName: clean(fileContextMenuState?.fileName) || "附件",
      fileUrl: clean(fileContextMenuState?.fileUrl),
      x: Number(fileContextMenuState?.x) || 12,
      y: Number(fileContextMenuState?.y) || 12,
    }
    : null;
  const messageRows = activeContact
    ? conversationMessageRows(entries, context, viewState.mode === "focus")
    : [{
      text: contactRows.length
        ? "请选择左侧联系人开始对话。"
        : hiddenContactCount > 0
          ? "联系人已隐藏。可在“设置 > 隐私”中恢复。"
          : hasContactsRoot
            ? "新建联系人后即可开始对话。"
            : "软件数据目录尚未准备好，请稍后重试。",
      type: "empty",
    }];
  const messageContextMenuState = viewState.messageContextMenu;
  const messageContextMenuRow = messageRows.find((row) => (
    row?.type === "message"
    && Number(row.lineNumber) === Number(messageContextMenuState?.lineNumber)
    && (!clean(messageContextMenuState?.messageId)
      || clean(row.sourceMessageId) === clean(messageContextMenuState?.messageId))
  )) || null;
  const messageContextMenu = messageContextMenuRow
    ? {
      canDelete: messageContextMenuRow.deletable === true,
      copyText: messageTextForCopy(messageContextMenuRow),
      images: messageImagesForCopy(messageContextMenuRow),
      kind: messageContextMenuRow.kind,
      lineNumber: Number(messageContextMenuRow.lineNumber),
      messageId: clean(messageContextMenuRow.sourceMessageId),
      x: Number(messageContextMenuState?.x) || 12,
      y: Number(messageContextMenuState?.y) || 12,
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
      attachments: activeContact ? viewState.attachments : [],
      attachmentPicking: Boolean(activeContact) && viewState.attachmentPicking,
      busy: Boolean(activeContact) && viewState.busySessions.has(clean(snapshot.activeSessionId)),
      draft: activeContact ? viewState.draft : "",
      emojiOpen: Boolean(activeContact) && viewState.emojiOpen,
      sending: viewState.sending,
      unavailable: !ready || !activeContact,
    },
    contactContextMenu,
    fileContextMenu: activeContact ? fileContextMenu : null,
    contacts: contactRows,
    error: viewState.error ? conversationInfo(payload) : clean(snapshot.error || payload?.error),
    focus: Boolean(activeContact) && viewState.mode === "focus",
    hasContactsRoot,
    history: {
      detached: Boolean(activeContact) && snapshot.historyWindow?.detached === true,
      hasMore: Boolean(activeContact) && viewState.mode === "snapshot" && snapshot.historyPage?.hasMore === true,
      loadingOlder: Boolean(activeContact) && viewState.historyLoadingOlder,
    },
    listLabel: `${agent.displayName || "Suzu"} 的聊天记录`,
    menuOpen: Boolean(activeContact) && viewState.menuOpen,
    messageContextMenu,
    messageRows,
    notice: viewState.notice,
    overlays: {
      avatarCrop: activeContact ? avatarCropSnapshot() : null,
      confirmation: conversationConfirmationSnapshot(),
      contactCreate: viewState.contactCreateOpen,
      contactRename: activeContact ? contactRenameSnapshot() : null,
      mediaPreview: activeContact ? mediaPreviewSnapshot() : null,
      qqBinding: qqBindingSnapshot(activeContact),
      wechatQr: wechatQrSnapshot(activeContact),
    },
    peer,
    permissions: activeContact ? permissionPromptSnapshot(clean(snapshot.activeSessionId)) : [],
    rosterEmpty: hasContactsRoot
      ? contacts.length ? "所有联系人都已隐藏。可在“设置 > 隐私”中恢复。" : "还没有联系人。点击“＋”创建。"
      : "软件数据目录尚未准备好，请稍后重试。",
    composerHeight: context.state.settings?.conversationComposerHeight,
    rosterWidth: context.state.settings?.conversationRosterWidth,
    search: activeContact ? conversationSearchSnapshot() : null,
    searchOpen: Boolean(activeContact) && viewState.searchOpen,
    sessionSettings: activeContact ? sessionSettingsSnapshot(context, selected, prefs) : null,
    ui: {
      composerFocusRequest: viewState.composerFocusRequest,
      listScrollTop: viewState.listScrollTop,
      scrollTarget: viewState.scrollTarget,
      scrollToLatestRequest: viewState.scrollToLatestRequest,
      searchFocusRequest: viewState.searchFocusRequest,
    },
    unread: Boolean(activeContact) && viewState.unread,
  };
}

function resetSessionSettings() {
  viewState.contactRenameOpen = false;
  viewState.mediaPreview = null;
  viewState.avatarCrop = null;
  viewState.contactCapabilitiesSnapshot = null;
  viewState.wechatSnapshot = null;
  viewState.wechatQrOpen = false;
  viewState.qqSnapshot = null;
  viewState.qqBindingOpen = false;
}

async function refreshCurrentSessionSettings(context) {
  const contactId = clean(viewState.snapshot?.activeContact?.id);
  if (!contactId) {
    resetSessionSettings();
    return;
  }
  viewState.settingsLoading = true;
  try {
    const [contactCapabilitiesSnapshot, wechatSnapshot, qqSnapshot] = await Promise.all([
      context.api.capabilities?.snapshot ? context.api.capabilities.snapshot() : null,
      context.api.wechat?.snapshot ? context.api.wechat.snapshot({ contactId }) : null,
      context.api.qq?.snapshot ? context.api.qq.snapshot({ contactId }) : null,
    ]);
    if (clean(viewState.snapshot?.activeContact?.id) !== contactId) return;
    viewState.contactCapabilitiesSnapshot = contactCapabilitiesSnapshot;
    viewState.wechatSnapshot = wechatSnapshot;
    viewState.qqSnapshot = qqSnapshot;
  } catch (error) {
    if (clean(viewState.snapshot?.activeContact?.id) === contactId) {
      viewState.error = `读取联系人设置失败：${error?.message || error}`;
    }
  } finally {
    viewState.settingsLoading = false;
    if (viewState.settingsOpen) context.render();
  }
}

function conversationHistoryScope(snapshot) {
  const source = snapshot && typeof snapshot === "object" ? snapshot : {};
  return [
    clean(source.activeContact?.id),
    clean(source.activeSessionId),
    clean(source.projectRoot),
  ].join("\u0000");
}

function historyPageOldestEventSeq(snapshot) {
  const sequence = Number(snapshot?.historyPage?.oldestEventSeq);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

function historyMessageKey(message, index) {
  const lineNumber = messageLineNumber(message);
  const id = messageSourceId(message);
  const kind = clean(message?.kind) || "message";
  return lineNumber
    ? `${lineNumber}:${kind}:${id || "event"}`
    : `${kind}:${id || `index:${index}`}`;
}

function mergePagedConversationMessages(previous, next) {
  const records = new Map();
  let order = 0;
  for (const message of [...(Array.isArray(previous) ? previous : []), ...(Array.isArray(next) ? next : [])]) {
    const key = historyMessageKey(message, order);
    const existing = records.get(key);
    records.set(key, { message, order: existing?.order ?? order });
    order += 1;
  }
  return [...records.values()]
    .sort((left, right) => {
      const leftLine = messageLineNumber(left.message);
      const rightLine = messageLineNumber(right.message);
      if (leftLine && rightLine && leftLine !== rightLine) return leftLine - rightLine;
      if (leftLine && !rightLine) return -1;
      if (!leftLine && rightLine) return 1;
      return left.order - right.order;
    })
    .map((entry) => entry.message);
}

function messageWindowLimit(value) {
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit > 0
    ? limit
    : CONVERSATION_MESSAGE_WINDOW_MAX;
}

/**
 * Combines two durable history pages while keeping a bounded local window.
 *
 * A normal Core refresh is newest-first from the user's point of view, so it
 * retains the newest end of the window. Loading an older page is the inverse:
 * it keeps the newly reached older end and drops distant newest rows only once
 * the window is full. That is the same sliding-window rule used by mature chat
 * timelines instead of retaining every page ever visited.
 */
export function mergeConversationMessageWindow(previous, next, {
  direction = "latest",
  limit = CONVERSATION_MESSAGE_WINDOW_MAX,
} = {}) {
  const maximum = messageWindowLimit(limit);
  const prior = Array.isArray(previous) ? previous : [];
  if (direction === "retain") {
    return {
      droppedNewest: false,
      messages: prior.length > maximum ? prior.slice(0, maximum) : prior,
    };
  }
  const merged = mergePagedConversationMessages(prior, next);
  if (merged.length <= maximum) return { droppedNewest: false, messages: merged };
  if (direction === "older") {
    return { droppedNewest: true, messages: merged.slice(0, maximum) };
  }
  return { droppedNewest: false, messages: merged.slice(-maximum) };
}

function mergedDeletedEventSequences(previous, next) {
  return [...new Set([
    ...(Array.isArray(previous) ? previous : []),
    ...(Array.isArray(next) ? next : []),
  ].map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value > 0))]
    .sort((left, right) => left - right);
}

function earlierHistoryPage(previous, next) {
  const previousOldest = historyPageOldestEventSeq(previous);
  const nextOldest = historyPageOldestEventSeq(next);
  if (previousOldest !== null && (nextOldest === null || previousOldest <= nextOldest)) {
    return previous?.historyPage || null;
  }
  return next?.historyPage || previous?.historyPage || null;
}

function mergeConversationSnapshot(previous, next, { direction = "latest" } = {}) {
  if (!previous || !next || conversationHistoryScope(previous) !== conversationHistoryScope(next)) return next;
  const historyPage = earlierHistoryPage(previous, next);
  const historyWindow = mergeConversationMessageWindow(previous.messages, next.messages, { direction });
  return {
    ...next,
    historyWindow: {
      detached: direction === "retain"
        ? previous?.historyWindow?.detached === true
        : previous?.historyWindow?.detached === true || historyWindow.droppedNewest,
    },
    messages: historyWindow.messages,
    deletedEventSequences: mergedDeletedEventSequences(previous.deletedEventSequences, next.deletedEventSequences),
    ...(historyPage ? { historyPage } : {}),
  };
}

function isHistoryWindowDetached(snapshot = viewState.snapshot) {
  return snapshot?.historyWindow?.detached === true || viewState.historyWindowDetached === true;
}

function reconnectConversationHistoryWindow() {
  viewState.historyWindowDetached = false;
  if (viewState.snapshot) {
    viewState.snapshot = {
      ...viewState.snapshot,
      historyWindow: { detached: false },
    };
  }
}

function applyConversationSnapshot(next, { direction, preserveHistory = true } = {}) {
  const previous = viewState.snapshot;
  const sameScope = conversationHistoryScope(previous) === conversationHistoryScope(next);
  const resolvedDirection = direction || (isHistoryWindowDetached(previous) ? "retain" : "latest");
  viewState.snapshot = preserveHistory && sameScope
    ? mergeConversationSnapshot(previous, next, { direction: resolvedDirection })
    : { ...next, historyWindow: { detached: false } };
  viewState.historyWindowDetached = viewState.snapshot?.historyWindow?.detached === true;
  return viewState.snapshot;
}

async function loadOlderMessages(context) {
  if (viewState.loading || viewState.historyLoadingOlder || viewState.mode === "focus") return;
  const beforeSeq = historyPageOldestEventSeq(viewState.snapshot);
  if (!beforeSeq || viewState.snapshot?.historyPage?.hasMore !== true) return;
  const historyEpoch = viewState.historyLoadEpoch;
  viewState.historyLoadingOlder = true;
  context.render();
  try {
    const snapshot = await context.api.conversation.snapshot({ beforeSeq });
    // A contact can be switched while this page is in flight. Do not append
    // the old contact's history to the newly selected conversation.
    if (historyEpoch !== viewState.historyLoadEpoch
      || conversationHistoryScope(viewState.snapshot) !== conversationHistoryScope(snapshot)) return;
    const applied = applyConversationSnapshot(snapshot, { direction: "older" });
    if (applied.historyWindow?.detached === true) viewState.unread = true;
    viewState.error = "";
    context.render();
  } catch (error) {
    viewState.error = `无法读取更早聊天记录：${error?.message || error}`;
    context.render();
  } finally {
    if (historyEpoch === viewState.historyLoadEpoch) viewState.historyLoadingOlder = false;
    // A request can fail or become stale after the contact changes. In both
    // cases remove the loading row immediately instead of leaving it visible
    // until a later conversation event happens to trigger another render.
    context.render();
  }
}

function mergeConversationLoadRequest(previous, next) {
  if (!previous) return next;
  return {
    force: previous.force || next.force,
    resetWindow: previous.resetWindow || next.resetWindow,
  };
}

function invalidateConversationLoads() {
  viewState.historyLoadEpoch += 1;
  viewState.loading = false;
  viewState.loadTask = null;
  viewState.pendingLoad = null;
}

async function load(context, force = false, { resetWindow = false } = {}) {
  if (viewState.mode === "focus") return;
  const request = { force: force === true, resetWindow: resetWindow === true };
  if (viewState.loading) {
    viewState.pendingLoad = mergeConversationLoadRequest(viewState.pendingLoad, request);
    return viewState.loadTask || undefined;
  }
  const historyEpoch = viewState.historyLoadEpoch;
  viewState.loading = true;
  const task = (async () => {
    let loaded = false;
    try {
      const snapshot = await context.api.conversation.snapshot();
      if (historyEpoch === viewState.historyLoadEpoch && viewState.mode !== "focus") {
        if (request.force || snapshot.version !== viewState.lastVersion || !viewState.snapshot) {
          const priorContactId = clean(viewState.snapshot?.activeContact?.id);
          const applied = applyConversationSnapshot(snapshot, { preserveHistory: !request.resetWindow });
          viewState.lastVersion = snapshot.version;
          if (priorContactId !== clean(applied.activeContact?.id)) {
            resetSessionSettings();
            if (viewState.settingsOpen) void refreshCurrentSessionSettings(context);
          }
          scheduleScrollToLatest();
          context.render();
        }
        loaded = true;
      }
    } catch (error) {
      if (historyEpoch === viewState.historyLoadEpoch) {
        viewState.error = `读取联系人聊天记录失败：${error?.message || error}`;
        context.render();
      }
    } finally {
      if (historyEpoch === viewState.historyLoadEpoch) {
        viewState.loading = false;
        const queued = viewState.pendingLoad;
        viewState.pendingLoad = null;
        if (queued && viewState.mode !== "focus") {
          loaded = await load(context, queued.force, { resetWindow: queued.resetWindow }) === true;
        }
      }
    }
    return loaded;
  })();
  viewState.loadTask = task;
  try {
    return await task;
  } finally {
    if (viewState.loadTask === task) viewState.loadTask = null;
  }
}

async function markOpenedContactRead(context) {
  const historyEpoch = viewState.historyLoadEpoch;
  const scope = conversationHistoryScope(viewState.snapshot);
  const contact = viewState.snapshot?.activeContact || null;
  const id = clean(contact?.id);
  if (!id || unreadCount(contact) < 1 || !context.api.conversation.updateContactPresentation) return;
  try {
    const snapshot = await context.api.conversation.updateContactPresentation({ id, unreadCount: 0 });
    if (historyEpoch !== viewState.historyLoadEpoch || scope !== conversationHistoryScope(viewState.snapshot)) return;
    viewState.lastVersion = applyConversationSnapshot(snapshot).version;
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
      animateIn: true,
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
      animateIn: true,
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
    const coreSequence = optionalTimelineSequence(event);
    const presentationOrder = nextLivePresentationOrder();
    const callId = clean(event.callId);
    viewState.liveTools.push({
      animateIn: true,
      blocks: [isStart
        ? { kind: "tool_use", name: toolName, summary: content.slice(0, 80), detail: content }
        : { kind: "tool_result", error: phase === "failed", summary: content.slice(0, 80), detail: content }],
      id: `live-tool-${requestId}-${coreSequence === null ? `arrival-${presentationOrder}` : `seq-${coreSequence}`}`,
      kind: "assistant",
      ...(callId ? { callId } : {}),
      ...(coreSequence === null ? {} : { coreSequence }),
      presentationOrder,
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
    const next = {
      ...previous,
      content: String(previous?.content ?? ""),
      done: false,
      phase: "thinking",
      remainder: String(previous?.remainder ?? ""),
      requestId,
      sentences: Array.isArray(previous?.sentences) ? previous.sentences : [],
      sessionId,
      timestamp: liveReplyTimestamp(previous, event),
    };
    viewState.liveReplies.set(requestId, next);
    if (liveReplyPresentationChanged(previous, next)) context.render();
    return;
  }
  if (event?.type === "error" && requestId) {
    if (sessionId) viewState.busySessions.delete(sessionId);
    viewState.permissions.forEach((item, id) => {
      if (item.sessionId === sessionId) viewState.permissions.delete(id);
    });
    clearReplyReveal(requestId);
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
    clearReplyReveal(requestId);
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
    const previous = viewState.liveReplies.get(requestId);
    const reply = withVisibleLiveReplySentences(previous, finishedLiveReply(previous, {
      ...event,
      presentationOrder: nextLivePresentationOrder(),
    }));
    const messagesChanged = liveReplyMessagesChanged(previous, reply);
    const presentationChanged = liveReplyPresentationChanged(previous, reply);
    if (reply) viewState.liveReplies.set(requestId, reply);
    if (messagesChanged) {
      if (!viewState.shouldStickToLatest) viewState.unread = true;
      scheduleScrollToLatest();
    }
    if (presentationChanged) context.render();
    if (reply) {
      viewState.replyFinalizationContexts.set(requestId, context);
      scheduleLiveReplyReveal(context, requestId);
    } else {
      void load(context, true)
        .finally(() => {
          viewState.liveTools = viewState.liveTools.filter((item) => item.requestId !== requestId);
          context.render();
        });
    }
    void context.refreshUsageLedger?.();
    return;
  }
  if (!requestId || !sessionId) return;
  if (event.type === "reply" || event.type === "reply-stream") {
    const previous = viewState.liveReplies.get(requestId);
    const next = withVisibleLiveReplySentences(previous, projectedLiveReply(previous, {
      ...event,
      presentationOrder: nextLivePresentationOrder(),
    }, {
      final: event.type === "reply" || event.done === true,
    }));
    const messagesChanged = liveReplyMessagesChanged(previous, next);
    const presentationChanged = liveReplyPresentationChanged(previous, next);
    viewState.liveReplies.set(requestId, next);
    if (messagesChanged) {
      if (!viewState.shouldStickToLatest) viewState.unread = true;
      scheduleScrollToLatest();
    }
    if (presentationChanged) context.render();
    scheduleLiveReplyReveal(context, requestId);
  }
}

export function startConversationPolling(context) {
  stopConversationPolling();
  viewState.transientSystemMessages.length = 0;
  viewState.livePresentationOrder = 0;
  viewState.liveTools = [];
  viewState.historyLoadingOlder = false;
  viewState.historyWindowDetached = false;
  viewState.shouldStickToLatest = true;
  void load(context, true, { resetWindow: true }).then(() => markOpenedContactRead(context));
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
  if (typeof context.api.qq?.onEvent === "function") {
    viewState.qqUnsubscribe = context.api.qq.onEvent((event) => {
      const activeContactId = clean(viewState.snapshot?.activeContact?.id);
      if (!activeContactId || !clean(event?.contactId) || clean(event.contactId) === activeContactId) {
        void refreshCurrentSessionSettings(context);
      }
    });
  }
}

export function stopConversationPolling() {
  invalidateConversationLoads();
  settleConversationConfirmation(false);
  clearReplyReveals();
  viewState.livePresentationOrder = 0;
  if (viewState.timer) window.clearInterval(viewState.timer);
  viewState.timer = null;
  viewState.historyLoadingOlder = false;
  viewState.historyWindowDetached = false;
  viewState.unsubscribe?.();
  viewState.unsubscribe = null;
  viewState.wechatUnsubscribe?.();
  viewState.wechatUnsubscribe = null;
  viewState.qqUnsubscribe?.();
  viewState.qqUnsubscribe = null;
  viewState.composerFocusRequest = 0;
  viewState.searchFocusRequest = 0;
  viewState.scrollTarget = null;
  viewState.scrollToLatestRequest = 0;
  void endActiveConversationCall();
}

export function dismissConversationOverlays(target = viewState) {
  const state = target && typeof target === "object" ? target : viewState;
  const confirmationOpen = Boolean(state.confirmation);
  const open = Boolean(confirmationOpen || state.contactCreateOpen || state.contactContextMenu || state.contactRenameOpen || state.fileContextMenu || state.messageContextMenu || state.menuOpen || state.searchOpen || state.settingsOpen || state.emojiOpen || state.wechatQrOpen || state.qqBindingOpen || state.mediaPreview || state.avatarCrop);
  state.contactCreateOpen = false;
  state.contactContextMenu = null;
  state.contactRenameOpen = false;
  state.confirmation = null;
  state.fileContextMenu = null;
  state.messageContextMenu = null;
  state.menuOpen = false;
  state.searchOpen = false;
  state.settingsOpen = false;
  state.emojiOpen = false;
  state.wechatQrOpen = false;
  state.qqBindingOpen = false;
  state.mediaPreview = null;
  state.avatarCrop = null;
  if (confirmationOpen && state === viewState) settleConversationConfirmation(false);
  return open;
}

async function sendMessage(context) {
  const raw = clean(viewState.draft);
  const selectedAttachments = Array.isArray(viewState.attachments) ? viewState.attachments : [];
  if ((!raw && !selectedAttachments.length) || viewState.sending || viewState.attachmentPicking) return;
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
    animateIn: true,
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
  // Sending is a live-tail action. If the person was browsing a detached
  // historical window, the following forced snapshot replaces that window
  // with the current tail so pending and durable copies can reconcile.
  reconnectConversationHistoryWindow();
  viewState.shouldStickToLatest = true;
  viewState.unread = false;
  viewState.pending.push(pending);
  scheduleScrollToLatest();
  focusComposer();
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
    releaseComposerAttachmentPreviews(selectedAttachments);
    viewState.attachments = [];
    if (pending.sessionId) viewState.busySessions.add(pending.sessionId);
    viewState.sending = false;
    scheduleScrollToLatest();
    context.render();
    load(context, true);
  } catch (error) {
    viewState.pending = viewState.pending.filter((item) => item !== pending);
    // A person can prepare the next message while the previous submission is
    // being accepted. Restore the failed text only when no newer draft exists.
    if (!viewState.draft) viewState.draft = raw;
    viewState.error = `没有发出去：${error?.message || error}`;
    viewState.sending = false;
    focusComposer();
    context.render();
  }
}

async function saveCurrentContactAvatar(context, avatarDataUrl) {
  const settings = context.state.settings || {};
  const agentId = clean(viewState.snapshot?.activeContact?.agentId) || clean(settings.agentId);
  if (!agentId) throw new Error("请先选择联系人。 ");
  const identity = getIdentity(settings);
  const nextIdentity = {
    owner: { ...identity.owner },
    defaultAgent: { ...identity.defaultAgent },
    agents: Object.fromEntries(Object.entries(identity.agents || {}).map(([id, profile]) => [id, { ...profile }])),
  };
  nextIdentity.agents[agentId] = { ...(identity.agents?.[agentId] || getAgentProfile(settings)), avatarDataUrl };
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
  invalidateConversationLoads();
  clearReplyReveals();
  resetSessionSettings();
  releaseComposerAttachmentPreviews(viewState.attachments);
  viewState.attachments = [];
  viewState.attachmentPicking = false;
  viewState.contactContextMenu = null;
  viewState.fileContextMenu = null;
  viewState.messageContextMenu = null;
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
  viewState.historyLoadingOlder = false;
  viewState.historyWindowDetached = false;
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
    cancelConfirmation: () => {
      if (!settleConversationConfirmation(false)) return;
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
    closeFileContextMenu: () => {
      if (!viewState.fileContextMenu) return;
      viewState.fileContextMenu = null;
      context.render();
    },
    closeMessageContextMenu: () => {
      if (!viewState.messageContextMenu) return;
      viewState.messageContextMenu = null;
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
    closeQqBinding: () => {
      viewState.qqBindingOpen = false;
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
        viewState.lastVersion = applyConversationSnapshot(
          await context.api.conversation.createContact({ name: value }),
        ).version;
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
      context.render();
      void load(context, true, { resetWindow: true });
    },
    loadOlderMessages: () => void loadOlderMessages(context),
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
      viewState.fileContextMenu = null;
      viewState.messageContextMenu = null;
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
      viewState.fileContextMenu = null;
      viewState.messageContextMenu = null;
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
      viewState.fileContextMenu = null;
      viewState.messageContextMenu = null;
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
    openFileContextMenu: (block, point) => {
      const fileUrl = clean(block?.fileUrl);
      if (!fileUrl) return;
      viewState.fileContextMenu = {
        fileName: clean(block?.fileName) || "附件",
        fileUrl,
        ...fileContextMenuPosition(point),
      };
      viewState.contactContextMenu = null;
      viewState.messageContextMenu = null;
      viewState.menuOpen = false;
      viewState.searchOpen = false;
      viewState.emojiOpen = false;
      context.render();
    },
    openMessageContextMenu: (row, point) => {
      const lineNumber = Number(row?.lineNumber);
      const kind = clean(row?.kind);
      const copyText = messageTextForCopy(row);
      const images = messageImagesForCopy(row);
      if (viewState.sending
        || !Number.isSafeInteger(lineNumber)
        || lineNumber <= 0
        || !["user", "assistant", "dynamic-context"].includes(kind)
        || (row?.deletable !== true && !copyText && !images.length)) return;
      viewState.messageContextMenu = {
        kind,
        lineNumber,
        messageId: clean(row?.sourceMessageId),
        ...messageContextMenuPosition(point, Number(row?.deletable === true) + Number(Boolean(copyText)) + images.length),
      };
      viewState.contactContextMenu = null;
      viewState.fileContextMenu = null;
      viewState.menuOpen = false;
      viewState.searchOpen = false;
      viewState.emojiOpen = false;
      context.render();
    },
    copyMediaFile: async (block) => {
      const fileUrl = clean(block?.fileUrl);
      if (!fileUrl || !context.api.conversation.copyMediaFile) return;
      const fileName = clean(block?.fileName) || "附件";
      viewState.fileContextMenu = null;
      context.render();
      try {
        await context.api.conversation.copyMediaFile({ fileUrl });
        viewState.error = "";
        viewState.notice = `已复制“${fileName}”，可在资源管理器中粘贴。`;
      } catch (error) {
        viewState.error = `无法复制附件：${error?.message || error}`;
      }
      context.render();
    },
    copyMessageText: async (message) => {
      const text = String(message?.copyText ?? "");
      if (!text.trim() || !context.api.conversation.copyMessageText) return;
      viewState.messageContextMenu = null;
      context.render();
      try {
        await context.api.conversation.copyMessageText({ text });
        viewState.error = "";
        viewState.notice = "已复制消息。";
      } catch (error) {
        viewState.error = `无法复制消息：${error?.message || error}`;
      }
      context.render();
    },
    copyMediaImage: async (image) => {
      const fileUrl = clean(image?.fileUrl);
      if (!fileUrl || !context.api.conversation.copyMediaImage) return;
      const fileName = clean(image?.fileName) || "图片";
      viewState.messageContextMenu = null;
      context.render();
      try {
        await context.api.conversation.copyMediaImage({ fileUrl });
        viewState.error = "";
        viewState.notice = `已复制“${fileName}”，可直接粘贴。`;
      } catch (error) {
        viewState.error = `无法复制图片：${error?.message || error}`;
      }
      context.render();
    },
    openMediaFile: async (block) => {
      const fileUrl = clean(block?.fileUrl);
      if (!fileUrl || !context.api.conversation.openMediaFile) return;
      viewState.fileContextMenu = null;
      context.render();
      try {
        await context.api.conversation.openMediaFile({ fileUrl });
      } catch (error) {
        viewState.error = `无法打开附件所在位置：${error?.message || error}`;
      }
      context.render();
    },
    openMediaPreview: (item) => {
      viewState.messageContextMenu = null;
      void openConversationMediaPreviewForItem(context, item);
    },
    openSessionSettings: async () => {
      viewState.menuOpen = false;
      viewState.messageContextMenu = null;
      viewState.searchOpen = false;
      viewState.settingsOpen = true;
      viewState.emojiOpen = false;
      context.render();
      await refreshCurrentSessionSettings(context);
    },
    previousMediaPreview: () => {
      const preview = viewState.mediaPreview;
      const items = Array.isArray(preview?.items) ? preview.items : [];
      const index = Math.max((Number(preview?.index) || 0) - 1, 0);
      if (!items.length || index === preview?.index) return;
      viewState.mediaPreview = { ...preview, index };
      context.render();
    },
    deleteMessage: async (message) => {
      const lineNumber = Number(message?.lineNumber);
      const kind = clean(message?.kind);
      if (viewState.sending
        || !Number.isSafeInteger(lineNumber)
        || lineNumber <= 0
        || !["user", "assistant", "dynamic-context"].includes(kind)
        || typeof context.api.conversation.deleteMessage !== "function") return;
      viewState.messageContextMenu = null;
      const confirmed = await requestConversationConfirmation(context, {
        confirmLabel: "删除消息",
        detail: "已生成的会话摘要不会修改；若它曾写入长期记忆，对应记忆也会被撤回。",
        message: "这条消息会从当前聊天记录中隐藏。",
        title: "删除这条消息？",
      });
      if (!confirmed) return;
      const pendingMessageId = pendingMessageIdForDurableUserMessage({
        kind,
        lineNumber,
        messageId: clean(message?.messageId),
      });
      viewState.sending = true;
      context.render();
      try {
        viewState.lastVersion = applyConversationSnapshot(await context.api.conversation.deleteMessage({
          confirmed: true,
          lineNumber,
          messageId: kind === "dynamic-context" ? "" : clean(message?.messageId),
        }), { preserveHistory: false }).version ?? null;
        if (pendingMessageId) {
          viewState.pending = viewState.pending.filter((item) => clean(item?.id) !== pendingMessageId);
        }
        resetConversationFocus();
        viewState.error = "";
        viewState.notice = "已从聊天记录中隐藏这条消息。";
      } catch (error) {
        viewState.error = `无法删除消息：${error?.message || error}`;
      } finally {
        viewState.sending = false;
        focusComposer();
        context.render();
      }
    },
    refresh: () => void load(context, true),
    removeComposerAttachment: (selectionToken) => {
      const token = clean(selectionToken);
      if (!token) return;
      const removed = viewState.attachments.filter((item) => clean(item?.selectionToken) === token);
      if (!removed.length) return;
      viewState.attachments = viewState.attachments.filter((item) => clean(item?.selectionToken) !== token);
      releaseComposerAttachmentPreviews(removed);
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
      const confirmed = await requestConversationConfirmation(context, {
        confirmLabel: "删除联系人",
        detail: "包括聊天记录、联系人资料、附件、记忆、自动任务和微信连接。此操作无法恢复。",
        message: `将删除“${name}”及其所有专属数据。`,
        title: `删除“${name}”？`,
      });
      if (!confirmed) return;
      viewState.sending = true;
      context.render();
      try {
        if (activeContactRemoved) await endActiveConversationCall();
        viewState.lastVersion = applyConversationSnapshot(
          await context.api.conversation.removeContact({ id, confirmed: true }),
        ).version;
        if (activeContactRemoved) {
          resetConversationForContactChange();
          viewState.draft = "";
        }
        if (context.api.settings?.get) context.state.settings = await context.api.settings.get();
        viewState.error = "";
        viewState.notice = `已删除“${name}”。`;
      } catch (error) {
        viewState.error = `无法删除联系人：${error?.message || error}`;
      } finally {
        viewState.sending = false;
        focusComposer();
        context.render();
      }
    },
    confirmConfirmation: () => {
      if (!settleConversationConfirmation(true)) return;
      context.render();
    },
    renameContact: async (contactId, name) => {
      const id = clean(contactId);
      const value = clean(name);
      if (!id || !value || id !== clean(viewState.snapshot?.activeContact?.id) || viewState.sending || !context.api.conversation.renameContact) return;
      viewState.sending = true;
      context.render();
      try {
        viewState.lastVersion = applyConversationSnapshot(
          await context.api.conversation.renameContact({ id, name: value }),
        ).version;
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
    setConversationComposerHeight: async (height) => {
      if (typeof context.api.settings?.update !== "function") return context.state.settings;
      try {
        context.state.settings = await context.api.settings.update({ conversationComposerHeight: height });
      } catch (error) {
        viewState.error = `无法保存聊天框高度：${error?.message || error}`;
      }
      context.render();
      return context.state.settings;
    },
    setConversationRosterWidth: async (width) => {
      if (typeof context.api.settings?.update !== "function") return context.state.settings;
      try {
        context.state.settings = await context.api.settings.update({ conversationRosterWidth: width });
      } catch (error) {
        viewState.error = `无法保存联系人栏宽度：${error?.message || error}`;
      }
      context.render();
      return context.state.settings;
    },
    setPreferredContact: async (contactId) => {
      const id = clean(contactId);
      if (!id || !context.api.conversation.setPreferredContact) return;
      const contact = (Array.isArray(viewState.snapshot?.contacts) ? viewState.snapshot.contacts : [])
        .find((item) => clean(item?.id) === id) || null;
      viewState.contactContextMenu = null;
      try {
        viewState.lastVersion = applyConversationSnapshot(
          await context.api.conversation.setPreferredContact({ id }),
        ).version;
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
        const previousActiveContactId = clean(viewState.snapshot?.activeContact?.id);
        const nextSnapshot = await context.api.conversation.updateContactPresentation({ id, ...patch });
        const nextActiveContactId = clean(nextSnapshot?.activeContact?.id);
        const activeContactChanged = previousActiveContactId !== nextActiveContactId;
        if (activeContactChanged) await endActiveConversationCall();
        viewState.lastVersion = applyConversationSnapshot(nextSnapshot).version;
        if (activeContactChanged) {
          resetConversationForContactChange();
          viewState.draft = "";
          scheduleScrollToLatest();
          if (context.api.settings?.get) {
            context.state.settings = await context.api.settings.get().catch(() => context.state.settings);
          }
        }
        viewState.error = "";
        if (Object.hasOwn(patch, "pinned")) {
          viewState.notice = patch.pinned ? `已将“${name}”置顶。` : `已取消“${name}”置顶。`;
        } else if (Object.hasOwn(patch, "unreadCount")) {
          viewState.notice = patch.unreadCount > 0 ? `已将“${name}”标为未读。` : `已将“${name}”标为已读。`;
        } else if (Object.hasOwn(patch, "muted")) {
          viewState.notice = patch.muted ? `已开启“${name}”的消息免打扰。` : `已关闭“${name}”的消息免打扰。`;
        } else if (Object.hasOwn(patch, "hidden")) {
          viewState.notice = patch.hidden ? "联系人已隐藏。可在“设置 > 隐私”中恢复。" : `已恢复“${name}”到联系人列表。`;
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
        viewState.lastVersion = applyConversationSnapshot(
          await context.api.conversation.selectContact({ id }),
        ).version;
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
          appendComposerAttachments(composerAttachmentSelections(result?.items));
        }
      } catch (error) {
        viewState.error = `无法选择附件：${error?.message || error}`;
      } finally {
        viewState.attachmentPicking = false;
        context.render();
      }
    },
    pasteComposerImages: async (files) => {
      const sources = Array.isArray(files) ? files : [];
      const currentAttachments = Array.isArray(viewState.attachments) ? viewState.attachments : [];
      const imageCount = currentAttachments.filter((item) => clean(item?.kind).toLowerCase() === "image").length;
      if (!sources.length || viewState.sending || viewState.attachmentPicking || !context.api.conversation.attachments?.paste) return;
      if (currentAttachments.length + sources.length > MAX_COMPOSER_ATTACHMENTS) {
        viewState.error = `一次最多发送 ${MAX_COMPOSER_ATTACHMENTS} 个附件。`;
        context.render();
        return;
      }
      if (imageCount + sources.length > MAX_COMPOSER_IMAGES) {
        viewState.error = `一次最多发送 ${MAX_COMPOSER_IMAGES} 张图片。`;
        context.render();
        return;
      }
      const contactId = clean(viewState.snapshot?.activeContact?.id);
      const candidates = [];
      viewState.attachmentPicking = true;
      viewState.error = "";
      context.render();
      try {
        const pastedAt = Date.now();
        for (const [index, source] of sources.entries()) {
          candidates.push(await clipboardImageAttachment(source, { index, pastedAt }));
        }
        const result = await context.api.conversation.attachments.paste({
          items: candidates.map(({ data, fileName, mimeType }) => ({ data, fileName, mimeType })),
        });
        if (result?.canceled) {
          releaseComposerAttachmentPreviews(candidates);
          return;
        }
        const selected = composerAttachmentSelections(result?.items, candidates);
        if (selected.length !== candidates.length) {
          const discard = context.api.conversation.attachments?.discard;
          if (typeof discard === "function" && selected.length) void discard({ attachmentTokens: selected.map((item) => item.selectionToken) }).catch(() => undefined);
          throw new Error("剪贴板图片没有全部加入待发送附件。");
        }
        if (contactId !== clean(viewState.snapshot?.activeContact?.id)) {
          releaseComposerAttachmentPreviews(candidates);
          const discard = context.api.conversation.attachments?.discard;
          if (typeof discard === "function") void discard({ attachmentTokens: selected.map((item) => item.selectionToken) }).catch(() => undefined);
          return;
        }
        const appended = appendComposerAttachments(selected);
        if (appended.length !== selected.length) {
          const discard = context.api.conversation.attachments?.discard;
          if (typeof discard === "function") void discard({ attachmentTokens: selected.map((item) => item.selectionToken) }).catch(() => undefined);
          throw new Error("待发送附件已达到上限。");
        }
      } catch (error) {
        releaseComposerAttachmentPreviews(candidates);
        viewState.error = `无法粘贴图片：${error?.message || error}`;
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
    setContactPermissionMode: async (permissionMode) => {
      const contactId = clean(viewState.snapshot?.activeContact?.id);
      const nextPermissionMode = clean(permissionMode);
      const currentPermissionMode = clean(viewState.snapshot?.activeContact?.permissionMode) || "danger-full-access";
      if (!contactId || !nextPermissionMode || nextPermissionMode === currentPermissionMode || viewState.sending || !context.api.conversation.updateContactPermissionMode) return;
      viewState.sending = true;
      context.render();
      try {
        viewState.lastVersion = applyConversationSnapshot(
          await context.api.conversation.updateContactPermissionMode({ id: contactId, permissionMode: nextPermissionMode }),
        ).version;
        viewState.error = "";
        viewState.notice = "已更新这位联系人的审批模式。";
      } catch (error) {
        viewState.error = `无法更新联系人审批模式：${error?.message || error}`;
      } finally {
        viewState.sending = false;
        context.render();
      }
    },
    setLongTermMemoryEnabled: async (enabled) => {
      const contactId = clean(viewState.snapshot?.activeContact?.id);
      if (!contactId || viewState.sending || !context.api.conversation.updateContactLongTermMemoryEnabled) return;
      viewState.sending = true;
      context.render();
      try {
        viewState.lastVersion = applyConversationSnapshot(
          await context.api.conversation.updateContactLongTermMemoryEnabled({ id: contactId, enabled: Boolean(enabled) }),
        ).version;
        viewState.error = "";
      } catch (error) {
        viewState.error = `无法更新联系人长期记忆：${error?.message || error}`;
      } finally {
        viewState.sending = false;
        context.render();
      }
    },
    setProactiveContactEnabled: async (enabled) => {
      const contactId = clean(viewState.snapshot?.activeContact?.id);
      if (!contactId || viewState.sending || !context.api.capabilities?.saveSettings) return;
      viewState.sending = true;
      context.render();
      try {
        const response = await context.api.capabilities.saveSettings("proactive-contact", {
          contactEnabled: Boolean(enabled),
          contactId,
        });
        if (!response?.ok) throw new Error(response?.error?.message || "无法更新联系人主动关心。");
        viewState.contactCapabilitiesSnapshot = response.value;
        context.state.capabilitySnapshot = response.value;
        viewState.error = "";
        viewState.notice = enabled ? "已开启这位联系人的主动关心。" : "已关闭这位联系人的主动关心。";
      } catch (error) {
        viewState.error = `无法更新联系人主动关心：${error?.message || error}`;
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
        if (preference === "dynamicContext") {
          // Dynamic context is projected by the reader, so a cached older page
          // may have been built with the opposite preference. Reopen from the
          // newest page instead of mixing two projections.
          invalidateConversationLoads();
          viewState.snapshot = null;
          viewState.historyWindowDetached = false;
          viewState.lastVersion = null;
          await load(context, true);
        }
      } catch (error) {
        viewState.error = `无法更新聊天显示：${error?.message || error}`;
      }
      context.render();
    },
    setDraft: (value) => {
      const next = String(value ?? "");
      if (viewState.draft === next) return;
      viewState.draft = next;
    },
    setListScroll: ({ clientHeight, scrollHeight, scrollTop } = {}) => {
      const top = Number(scrollTop);
      const height = Number(scrollHeight);
      const viewport = Number(clientHeight);
      if (!Number.isFinite(top) || !Number.isFinite(height) || !Number.isFinite(viewport)) return;
      viewState.listScrollTop = top;
      const shouldStick = height - top - viewport < 48;
      const unread = shouldStick && !isHistoryWindowDetached() ? false : viewState.unread;
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
    setQqContactEnabled: async (contactId, enabled) => {
      const id = clean(contactId);
      if (!id || !context.api.qq?.setContactEnabled) return;
      try {
        viewState.qqSnapshot = await context.api.qq.setContactEnabled({ contactId: id, enabled: Boolean(enabled) });
        viewState.error = "";
        viewState.notice = enabled ? "这位联系人已恢复 QQ 消息。" : "这位联系人的 QQ 消息已暂停。";
      } catch (error) {
        viewState.error = `无法更新联系人 QQ 连接：${error?.message || error}`;
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
    startQq: async (contactId) => {
      const id = clean(contactId);
      if (!id || !context.api.qq?.begin) return;
      try {
        viewState.qqSnapshot = await context.api.qq.begin({ contactId: id });
        viewState.qqBindingOpen = true;
        viewState.error = "";
        viewState.notice = "QQ 绑定码已生成。请在 QQ 机器人里发送这串绑定码。";
      } catch (error) {
        viewState.error = `无法生成 QQ 绑定码：${error?.message || error}`;
      }
      context.render();
    },
    submitMessage: () => void sendMessage(context),
    toggleEmoji: () => {
      viewState.emojiOpen = !viewState.emojiOpen;
      viewState.menuOpen = false;
      viewState.messageContextMenu = null;
      if (viewState.emojiOpen) focusComposer();
      context.render();
    },
    toggleMenu: () => {
      viewState.menuOpen = !viewState.menuOpen;
      viewState.messageContextMenu = null;
      viewState.searchOpen = false;
      viewState.settingsOpen = false;
      viewState.emojiOpen = false;
      renderKeepingConversationScroll(context);
    },
    toggleSearch: () => {
      viewState.searchOpen = !viewState.searchOpen;
      viewState.menuOpen = false;
      viewState.messageContextMenu = null;
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
      context.render();
      void load(context, true, { resetWindow: true });
    },
    viewWechatQr: () => {
      viewState.wechatQrOpen = true;
      context.render();
    },
    viewQqBinding: () => {
      viewState.qqBindingOpen = true;
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
    disconnectQq: async (contactId) => {
      const id = clean(contactId);
      if (!id || !context.api.qq?.disconnect) return;
      if (!window.confirm("断开后，这个 QQ 账号将不再进入当前联系人的固定 Suzu 对话。确定断开吗？")) return;
      try {
        viewState.qqSnapshot = await context.api.qq.disconnect({ contactId: id, confirmed: true });
        viewState.qqBindingOpen = false;
        viewState.error = "";
        viewState.notice = "当前联系人的 QQ 连接已断开。";
      } catch (error) {
        viewState.error = `无法断开 QQ：${error?.message || error}`;
      }
      context.render();
    },
    insertEmoji: (emoji) => {
      viewState.draft = `${viewState.draft}${String(emoji || "")}`;
      viewState.emojiOpen = false;
      focusComposer();
      context.render();
    },
    ...(PRODUCT_FEATURES.builtinEmojiStickers ? {
      loadBuiltinEmojiStickers: async () => {
        const stickers = context.api?.conversation?.emojiStickers;
        if (typeof stickers?.builtins !== "function") return { items: [], status: "unavailable" };
        return stickers.builtins();
      },
    } : {}),
    ...(PRODUCT_FEATURES.customEmojiStickers ? {
      loadEmojiStickers: async () => {
        const stickers = context.api?.conversation?.emojiStickers;
        if (typeof stickers?.snapshot !== "function") return { items: [], status: "unavailable" };
        return stickers.snapshot();
      },
      addEmojiSticker: async () => {
        viewState.emojiOpen = false;
        context.setView?.("create");
        context.setCreatePage?.("stickers");
        return { canceled: true, navigated: true };
      },
    } : {}),
    ...(PRODUCT_FEATURES.builtinEmojiStickers || PRODUCT_FEATURES.customEmojiStickers ? {
      sendEmojiSticker: async (value) => {
        const stickers = context.api?.conversation?.emojiStickers;
        if (typeof stickers?.send !== "function") throw new Error("当前版本无法发送表情。");
        const sticker = value && typeof value === "object" ? value : { id: value };
        const id = clean(sticker.id);
        if (!id) throw new Error("缺少要发送的表情。");
        const media = {
          fileName: clean(sticker.fileName) || "表情包",
          fileUrl: clean(sticker.fileUrl),
          kind: "image",
          mediaSource: "sticker",
          mimeType: clean(sticker.mimeType),
          size: Number(sticker.size) || 0,
        };
        const pending = {
          accepted: false,
          animateIn: true,
          content: "",
          media: media.fileUrl && media.size > 0 ? [media] : [],
          id: `pending-sticker-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          queued: false,
          queuePosition: 0,
          requestId: "",
          sessionId: clean(viewState.snapshot?.activeSessionId),
          steering: false,
          timestamp: new Date().toISOString(),
        };
        viewState.emojiOpen = false;
        viewState.error = "";
        viewState.notice = "";
        resetConversationFocus();
        viewState.searchOpen = false;
        reconnectConversationHistoryWindow();
        viewState.shouldStickToLatest = true;
        viewState.unread = false;
        viewState.pending.push(pending);
        scheduleScrollToLatest();
        focusComposer();
        context.render();
        try {
          const result = await stickers.send({ id });
          pending.accepted = true;
          pending.queued = result?.queued === true;
          pending.queuePosition = Number(result?.queuePosition) || 0;
          pending.requestId = clean(result?.requestId);
          pending.sessionId = clean(result?.sessionId) || pending.sessionId;
          if (Array.isArray(result?.media) && result.media.length) pending.media = result.media;
          if (pending.sessionId) viewState.busySessions.add(pending.sessionId);
          scheduleScrollToLatest();
          context.render();
          void load(context, true);
          return result;
        } catch (error) {
          viewState.pending = viewState.pending.filter((item) => item !== pending);
          viewState.error = `没有发出去：${error?.message || error}`;
          focusComposer();
          context.render();
          throw error;
        }
      },
    } : {}),
    jumpFromMediaPreview: async ({ lineNumber, messageId } = {}) => {
      viewState.mediaPreview = null;
      await focusConversationRecord(context, { lineNumber, messageId });
    },
  };
}
