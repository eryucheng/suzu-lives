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
  avatarCrop: null,
  busySessions: new Set(),
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
  sessionNoteDraft: "",
  sessionNoteDirty: false,
  sessionNoteOpen: false,
  sessionSettings: null,
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

const defaults = { attachments: false, tools: false, thinking: false, system: false, tokens: false, timeDisplay: "center" };
const CENTER_TIME_GAP_MS = 5 * 60 * 1_000;

function preferences(settings) {
  return { ...defaults, ...(settings?.conversationPreferences || {}) };
}

function clean(value) {
  return String(value ?? "").trim();
}

export function isScheduledAgentReply(event) {
  return clean(event?.kind) === "schedule"
    && clean(event?.type) === "agent-reply"
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

function messageMatches(items, kind, content) {
  const target = clean(content);
  return (items || []).slice(-12).some((item) => item.kind === kind && messageText(item) === target);
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

function displayedMessages(items) {
  const source = Array.isArray(items) ? items : [];
  const sessionId = clean(viewState.snapshot?.activeSessionId);
  const pending = viewState.pending
    .filter((item) => item.sessionId === sessionId && !messageMatches(source, "user", item.content))
    .map((item) => ({
      id: item.id,
      kind: "user",
      pending: !item.accepted,
      accepted: item.accepted,
      queued: item.queued,
      queuePosition: item.queuePosition,
      steering: item.steering,
      timestamp: item.timestamp,
      blocks: [{ kind: "text", text: item.content }],
    }));
  const liveReplies = [...viewState.liveReplies.values()]
    .filter((item) => item.sessionId === sessionId && item.content && !messageMatches(source, "assistant", item.content))
    .map((item) => ({
      id: `reply-${item.requestId}`,
      kind: "assistant",
      streaming: !item.done,
      timestamp: item.timestamp,
      blocks: [{ kind: "text", text: item.content }],
    }));
  const activePending = pending.filter((item) => !item.queued);
  const queuedPending = pending.filter((item) => item.queued);
  return [...source, ...activePending, ...liveReplies, ...queuedPending];
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

function splitTextOnBlankLines(value) {
  const normalized = String(value ?? "").replace(/\r\n?/gu, "\n");
  const pieces = normalized.split(/\n(?:[ \t]*\n)+/gu).map((part) => part.replace(/^\n+|\n+$/gu, ""));
  const nonEmpty = pieces.filter((part) => part.trim());
  return nonEmpty.length ? nonEmpty : [normalized];
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
    const parts = splitTextOnBlankLines(item.text);
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
  if (value?.kind !== "media" || value?.mediaKind !== "image" || !url) return null;
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
    return {
      fileName: clean(value.fileName) || "未命名附件",
      fileUrl: clean(value.fileUrl),
      mediaKind: value.mediaKind === "image" ? "image" : "file",
      preview: imageItem,
      size: attachmentSize(value.size),
      type: "media",
      typeLabel: value.mediaKind === "image" ? "图片" : "文件",
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
  const focusLineNumber = messageLineNumber(viewState.focus);
  const focusMessageId = clean(viewState.focus?.focusMessageId);
  const focused = (lineNumber && lineNumber === focusLineNumber) || (sourceMessageId && sourceMessageId === focusMessageId);
  return {
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
  if (payload?.status === "missing") return "请先在设置中选择 Agent 工作目录，再新建一个联系人。";
  return `本机 Claude Code · ${payload?.fileName || "新对话"} · ${payload?.scannedRecords || 0} 条记录`;
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

function sessionNoteSnapshot() {
  if (!viewState.sessionNoteOpen) return null;
  const contactId = clean(viewState.snapshot?.activeContact?.id);
  if (!contactId) return null;
  const saved = viewState.sessionSettings?.contactId === contactId ? viewState.sessionSettings : {};
  const note = viewState.sessionNoteDirty ? viewState.sessionNoteDraft : clean(saved.note);
  return { note, contactId };
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
  const ready = (viewState.snapshot?.status || payload?.status) === "ready";
  const agent = getAgentProfile(context.state.settings);
  const identity = getIdentity(context.state.settings);
  const snapshot = viewState.snapshot || {};
  const selected = activeSession(snapshot);
  const contacts = snapshot.contacts || [];
  const activeContact = snapshot.activeContact || null;
  const hasContactsRoot = Boolean(clean(snapshot.contactsRoot || context.state.settings?.contactsRoot));
  const peer = clean(activeContact?.name) || "未选择联系人";
  const callAvailable = ready && Boolean(clean(activeContact?.agentId));
  const preferredContactId = clean(snapshot.preferredContactId);
  const allContactRows = contacts.map((contact) => {
    const name = clean(contact?.name) || "未命名联系人";
    const selectedContact = clean(activeContact?.id) === clean(contact?.id);
    const contactAgent = identity?.agents?.[clean(contact?.agentId)] || identity?.defaultAgent || { displayName: name, avatarDataUrl: "" };
    return {
      avatar: avatarPayload(contactAgent, name),
      hidden: contact?.hidden === true,
      id: clean(contact?.id),
      muted: contact?.muted === true,
      name,
      pinned: contact?.pinned === true,
      preferred: clean(contact?.id) === preferredContactId,
      selected: selectedContact,
      unread: contact?.unread === true,
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
        avatar: avatarPayload(agent, peer),
        name: peer,
      },
    },
    composer: {
      busy: viewState.busySessions.has(clean(snapshot.activeSessionId)),
      draft: viewState.draft,
      emojiOpen: viewState.emojiOpen,
      sending: viewState.sending,
      unavailable: !ready || viewState.sending,
    },
    contactContextMenu,
    contacts: contactRows,
    error: viewState.error ? conversationInfo(payload) : "",
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
      sessionNote: sessionNoteSnapshot(),
      wechatQr: wechatQrSnapshot(activeContact),
    },
    peer,
    permissions: permissionPromptSnapshot(clean(snapshot.activeSessionId)),
    rosterEmpty: hasContactsRoot
      ? contacts.length ? "所有联系人都已隐藏。可在“设置 > 隐私”中恢复。" : "还没有联系人。点击右上角“＋”创建。"
      : "请先到“设置”选择 Agent 工作目录。",
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
  viewState.sessionNoteDirty = false;
  viewState.sessionNoteDraft = "";
  viewState.sessionNoteOpen = false;
  viewState.sessionSettings = null;
  viewState.mediaPreview = null;
  viewState.avatarCrop = null;
  viewState.wechatSnapshot = null;
  viewState.wechatQrOpen = false;
}

async function refreshCurrentSessionSettings(context) {
  const contactId = clean(viewState.snapshot?.activeContact?.id);
  if (!contactId || !context.api.conversation.sessionSettingsSnapshot) {
    resetSessionSettings();
    return;
  }
  const previousContactId = clean(viewState.sessionSettings?.contactId);
  if (previousContactId && previousContactId !== contactId) resetSessionSettings();
  viewState.settingsLoading = true;
  try {
    const [sessionSettings, wechatSnapshot] = await Promise.all([
      context.api.conversation.sessionSettingsSnapshot({ contactId }),
      context.api.wechat?.snapshot ? context.api.wechat.snapshot({ contactId }) : Promise.resolve(null),
    ]);
    if (clean(viewState.snapshot?.activeContact?.id) !== contactId) return;
    viewState.sessionSettings = sessionSettings;
    if (!viewState.sessionNoteDirty) viewState.sessionNoteDraft = clean(sessionSettings?.note);
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
  if (!id || contact?.unread !== true || !context.api.conversation.updateContactPresentation) return;
  try {
    viewState.snapshot = await context.api.conversation.updateContactPresentation({ id, unread: false });
    viewState.lastVersion = viewState.snapshot.version;
    context.render();
  } catch {
    // Reading a conversation should remain available if its local badge cannot be saved.
  }
}

function handleConversationEvent(context, event) {
  // The call sheet owns its own listening/thinking/speaking state.  Do not
  // leak Claude's internal turn labels into the text composer while a voice
  // turn is running; refresh the normal history after it settles instead.
  if (["call", "call-open"].includes(event?.kind)) {
    if (["turn-complete", "turn-stopped", "error"].includes(event.type)) void load(context, true);
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
  if (event?.type === "error" && requestId) {
    if (sessionId) viewState.busySessions.delete(sessionId);
    viewState.permissions.forEach((item, id) => {
      if (item.sessionId === sessionId) viewState.permissions.delete(id);
    });
    viewState.pending = viewState.pending.filter((item) => item.requestId !== requestId);
    viewState.notice = "";
    viewState.error = `Claude Code 没有完成这次回复：${event.message || "未知错误"}`;
    context.render();
    return;
  }
  if (event?.type === "turn-stopped" && requestId && sessionId) {
    viewState.busySessions.delete(sessionId);
    viewState.permissions.forEach((item, id) => {
      if (item.sessionId === sessionId) viewState.permissions.delete(id);
    });
    const reply = viewState.liveReplies.get(requestId);
    if (reply) viewState.liveReplies.set(requestId, { ...reply, done: true });
    viewState.error = "";
    viewState.notice = clean(event.message) || "已停止当前 Claude Code 任务。";
    context.render();
    load(context, true);
    return;
  }
  if (event?.type === "turn-complete" && requestId && sessionId) {
    viewState.busySessions.delete(sessionId);
    context.render();
    load(context, true);
    return;
  }
  if (!requestId || !sessionId) return;
  if (event.type === "reply" || event.type === "reply-stream") {
    const previous = viewState.liveReplies.get(requestId);
    viewState.liveReplies.set(requestId, {
      content: clean(event.content) || previous?.content || "",
      done: event.type === "reply" || event.done === true,
      requestId,
      sessionId,
      timestamp: event.timestamp || previous?.timestamp || new Date().toISOString(),
    });
    if (!viewState.shouldStickToLatest) viewState.unread = true;
    scheduleScrollToLatest();
    context.render();
    if (event.type === "reply" || event.done === true) load(context, true);
  }
}

export function startConversationPolling(context) {
  stopConversationPolling();
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
  const open = Boolean(state.contactCreateOpen || state.contactContextMenu || state.contactRenameOpen || state.menuOpen || state.searchOpen || state.settingsOpen || state.emojiOpen || state.sessionNoteOpen || state.wechatQrOpen || state.mediaPreview || state.avatarCrop);
  state.contactCreateOpen = false;
  state.contactContextMenu = null;
  state.contactRenameOpen = false;
  state.menuOpen = false;
  state.searchOpen = false;
  state.settingsOpen = false;
  state.emojiOpen = false;
  state.sessionNoteOpen = false;
  state.wechatQrOpen = false;
  state.mediaPreview = null;
  state.avatarCrop = null;
  return open;
}

async function sendMessage(context) {
  const raw = clean(viewState.draft);
  if (!raw || viewState.sending) return;
  const command = parseSuzuConversationCommand(raw);
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
      viewState.notice = "当前没有可停止的 Claude 回复。";
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
      viewState.notice = clean(result?.message) || "正在停止当前 Claude Code 任务。";
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
      : await context.api.conversation.send({ content });
    pending.accepted = true;
    pending.queued = result?.queued === true;
    pending.queuePosition = Number(result?.queuePosition) || 0;
    pending.steering = command.action === "steer" && result?.delivered === true;
    pending.requestId = clean(result?.requestId);
    pending.sessionId = clean(result?.sessionId);
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
  viewState.contactContextMenu = null;
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
    closeSessionNote: () => {
      viewState.sessionNoteOpen = false;
      viewState.sessionNoteDraft = "";
      viewState.sessionNoteDirty = false;
      context.render();
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
    openMediaPreview: (item) => void openConversationMediaPreviewForItem(context, item),
    openSessionNote: (contactId) => {
      const id = clean(contactId);
      if (!id) return;
      const saved = viewState.sessionSettings?.contactId === id ? viewState.sessionSettings : {};
      viewState.sessionNoteDraft = clean(saved.note);
      viewState.sessionNoteDirty = false;
      viewState.sessionNoteOpen = true;
      context.render();
    },
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
    saveSessionNote: async (contactId, note) => {
      const id = clean(contactId);
      if (!id || !context.api.conversation.saveSessionSettings) return;
      try {
        viewState.sessionSettings = await context.api.conversation.saveSessionSettings({ contactId: id, note: String(note || "") });
        viewState.sessionNoteDraft = clean(viewState.sessionSettings.note);
        viewState.sessionNoteDirty = false;
        viewState.sessionNoteOpen = false;
        viewState.error = "";
        viewState.notice = "聊天备注已保存。";
      } catch (error) {
        viewState.error = `无法保存聊天备注：${error?.message || error}`;
      }
      context.render();
    },
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
      for (const key of ["pinned", "unread", "muted", "hidden"]) {
        if (typeof source[key] === "boolean") patch[key] = source[key];
      }
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
        } else if (Object.hasOwn(patch, "unread")) {
          viewState.notice = patch.unread ? `已将“${name}”标为未读。` : `已将“${name}”标为已读。`;
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
    setSessionNoteDraft: (value) => {
      viewState.sessionNoteDraft = String(value ?? "");
      viewState.sessionNoteDirty = true;
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
      if (!window.confirm("断开后，这个微信账号将不再进入当前联系人的固定 Claude 对话。确定断开吗？")) return;
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
      focusComposer();
      context.render();
    },
    jumpFromMediaPreview: async ({ lineNumber, messageId } = {}) => {
      viewState.mediaPreview = null;
      await focusConversationRecord(context, { lineNumber, messageId });
    },
  };
}
