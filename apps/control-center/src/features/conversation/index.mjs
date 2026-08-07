import { compactNumber, dateTime, escapeHtml } from "../../core/formatters.mjs";
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
import { pageIntro, status } from "../../components/panel.mjs";
import { parseSuzuConversationCommand } from "../../../shared/conversation-command.mjs";

export { parseSuzuConversationCommand } from "../../../shared/conversation-command.mjs";

const viewState = {
  avatarCrop: null,
  busySessions: new Set(),
  contactCreateOpen: false,
  dismissController: null,
  draft: "",
  emojiOpen: false,
  error: "",
  focus: null,
  lastVersion: null,
  liveReplies: new Map(),
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
  searchLoading: false,
  searchOpen: false,
  searchQuery: "",
  sessionNoteDraft: "",
  sessionNoteDirty: false,
  sessionSettings: null,
  sending: false,
  settingsOpen: false,
  settingsLoading: false,
  shouldStickToLatest: true,
  snapshot: null,
  timer: null,
  unread: false,
  unsubscribe: null,
  wechatSnapshot: null,
  wechatQrOpen: false,
  wechatUnsubscribe: null,
};

const defaults = { attachments: false, tools: false, thinking: false, system: false, tokens: false, timeDisplay: "bubble" };
const WECHAT_TIME_GAP_MS = 5 * 60 * 1_000;

const chatIcons = {
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="5.8"></circle><path d="m15.2 15.2 4.3 4.3"></path></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.35" fill="currentColor" stroke="none"></circle><circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none"></circle><circle cx="19" cy="12" r="1.35" fill="currentColor" stroke="none"></circle></svg>',
  emoji: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.3"></circle><path d="M8.4 14.2c.9 1.2 2.1 1.8 3.6 1.8s2.7-.6 3.6-1.8M9 9.5h.01M15 9.5h.01"></path></svg>',
  box: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.4v9.2L12 21l-8-4.4V7.4L12 3Z"></path><path d="m4 7.4 8 4.4 8-4.4M12 11.8V21"></path></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.2h6l1.9 2h9.1v8.7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.2Z"></path></svg>',
  scissors: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6.4" cy="17.2" r="2.2"></circle><circle cx="6.4" cy="6.8" r="2.2"></circle><path d="m8.2 8.2 10.3 7.1M8.2 15.8l4-2.8"></path></svg>',
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="3" width="7" height="12" rx="3.5"></rect><path d="M5.8 11.5a6.2 6.2 0 0 0 12.4 0M12 17.7V21M8.5 21h7"></path></svg>',
  sound: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14h3.2L12 18V6L7.2 10H4v4Z"></path><path d="M15 9.2a4.2 4.2 0 0 1 0 5.6M17.8 6.4a8.1 8.1 0 0 1 0 11.2"></path></svg>',
};

function chatIcon(name) {
  return chatIcons[name] || "";
}

function preferences(settings) {
  return { ...defaults, ...(settings?.conversationPreferences || {}) };
}

function clean(value) {
  return String(value ?? "").trim();
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
  return prefs?.timeDisplay === "wechat" ? "wechat" : "bubble";
}

export function shouldShowWechatTimeDivider(previousTimestamp, timestamp) {
  const current = dateFromTimestamp(timestamp);
  if (!current) return false;
  const previous = dateFromTimestamp(previousTimestamp);
  if (!previous) return true;
  if (!sameCalendarDay(previous, current)) return true;
  return current.getTime() - previous.getTime() >= WECHAT_TIME_GAP_MS;
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

function avatar(profile, fallback) {
  return profile.avatarDataUrl
    ? `<img src="${escapeHtml(profile.avatarDataUrl)}" alt="">`
    : `<span>${escapeHtml(profileInitial(profile, fallback))}</span>`;
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

function mediaPreviewAttributes(item) {
  if (!item) return "";
  return `data-conversation-media-preview="${escapeHtml(item.key)}" data-conversation-media-url="${escapeHtml(item.url)}" data-conversation-media-name="${escapeHtml(item.name)}" data-conversation-media-message-id="${escapeHtml(item.messageId)}" data-conversation-media-line-number="${item.lineNumber || ""}"`;
}

function block(value, prefs, message) {
  if (value.kind === "text") return `<div class="conversation-text">${escapeHtml(value.text)}</div>`;
  if (value.kind === "media") {
    const imageName = value.fileName || (value.mediaKind === "audio" ? "音频附件" : "图片附件");
    const imageItem = imageMediaItem(value, message);
    const image = imageItem
      ? `<button type="button" class="conversation-media__preview" ${mediaPreviewAttributes(imageItem)} aria-label="放大查看 ${escapeHtml(imageName)}"><img class="conversation-media__image" src="${escapeHtml(value.fileUrl)}" alt="${escapeHtml(imageName)}" loading="lazy"></button>`
      : "";
    const audio = value.mediaKind === "audio" && clean(value.fileUrl)
      ? `<audio class="conversation-media__audio" controls preload="metadata" src="${escapeHtml(value.fileUrl)}"></audio>`
      : "";
    const type = value.mediaKind === "image" ? "图片" : value.mediaKind === "audio" ? "音频" : "文件";
    const mediaClass = value.mediaKind === "image" ? "image" : value.mediaKind === "audio" ? "audio" : "file";
    const size = attachmentSize(value.size);
    return `<section class="conversation-media conversation-media--${escapeHtml(mediaClass)}">
      ${image}
      ${audio}
      <div class="conversation-media__copy"><small>${type}附件</small><strong>${escapeHtml(value.fileName || "未命名附件")}</strong>${size ? `<span>${escapeHtml(size)}</span>` : ""}</div>
    </section>`;
  }
  if (value.kind === "thinking" && !prefs.thinking) return "";
  if ((value.kind === "tool_use" || value.kind === "tool_result") && !prefs.tools) return "";
  const title = value.kind === "thinking"
    ? `思考 · ${value.preview || ""}`
    : value.kind === "tool_use"
      ? `工具调用 · ${value.name}${value.summary ? ` · ${value.summary}` : ""}`
      : `${value.error ? "工具结果（错误）" : "工具结果"}${value.summary ? ` · ${value.summary}` : ""}`;
  return `<details class="conversation-detail"><summary>${escapeHtml(title)}</summary><pre>${escapeHtml(value.text || value.detail || "")}</pre></details>`;
}

function usage(value) {
  if (!value) return "";
  const fields = [
    ["输入", value.input],
    ["缓存写入", value.cacheCreation],
    ["缓存读取", value.cacheRead],
    ["输出", value.output],
    ["合计", value.total],
  ].filter(([, number]) => number !== null);
  return `<div class="conversation-usage">${value.model ? `${escapeHtml(value.model)} · ` : ""}${fields.map(([label, number]) => `${label} ${compactNumber(number)}`).join(" · ")}</div>`;
}

function row(message, context, showTimestamp = true) {
  const prefs = preferences(context.state.settings);
  if ((message.kind === "attachment" && !prefs.attachments) || (message.kind === "system" && !prefs.system)) return "";
  const profile = message.kind === "user"
    ? getIdentity(context.state.settings).owner
    : message.kind === "assistant"
      ? getAgentProfile(context.state.settings)
      : null;
  const content = message.blocks.map((item) => block(item, prefs, message)).join("");
  const mediaOnly = message.blocks.length === 1 && message.blocks[0]?.kind === "media";
  const usageMeta = prefs.tokens && message.kind === "assistant" ? usage(message.usage) : "";
  const delivery = message.pending
    ? " · 发送中"
    : message.queued
      ? ` · 排队中${message.queuePosition ? `（第 ${message.queuePosition} 条）` : ""}`
      : message.steering
        ? " · 引导已送达"
      : message.accepted
        ? " · 已发送"
        : message.streaming
          ? " · 正在回复"
          : "";
  if (!content && !usageMeta) return "";
  const timestamp = showTimestamp && message.timestamp ? escapeHtml(dateTime(message.timestamp)) : "";
  const sourceMessageId = messageSourceId(message);
  const lineNumber = messageLineNumber(message);
  const focusLineNumber = messageLineNumber(viewState.focus);
  const focusMessageId = clean(viewState.focus?.focusMessageId);
  const focused = (lineNumber && lineNumber === focusLineNumber) || (sourceMessageId && sourceMessageId === focusMessageId);
  return `<article class="conversation-message ${escapeHtml(message.kind)}${mediaOnly ? " is-media-only" : ""}${message.pending || message.streaming ? " is-live" : ""}${focused ? " is-focus-target" : ""}"${sourceMessageId ? ` data-conversation-message-id="${escapeHtml(sourceMessageId)}"` : ""}${lineNumber ? ` data-conversation-line-number="${lineNumber}"` : ""}>
    ${profile ? `<div class="conversation-avatar">${avatar(profile, profile.displayName)}</div>` : ""}
    <div class="conversation-bubble">
      ${content}${usageMeta}
      ${timestamp || delivery ? `<div class="conversation-meta">${timestamp}${delivery}</div>` : ""}
    </div>
  </article>`;
}

export function renderConversationMessages(items, context, searched = false) {
  const prefs = preferences(context.state.settings);
  const style = timeDisplay(prefs);
  let previousDay = "";
  let previousTimestamp = "";
  const rows = filterConversationItems(items, prefs).flatMap(splitAssistantMessageOnBlankLines).flatMap((item) => {
    const next = row(item, context, style === "bubble");
    if (!next) return [];
    let divider = "";
    if (style === "wechat") {
      if (shouldShowWechatTimeDivider(previousTimestamp, item.timestamp)) {
        divider = `<div class="conversation-time-divider">${escapeHtml(wechatTimeLabel(item.timestamp))}</div>`;
      }
      if (dateFromTimestamp(item.timestamp)) previousTimestamp = item.timestamp;
    } else {
      const day = conversationDay(item.timestamp);
      divider = day && day !== previousDay ? `<div class="conversation-day">${escapeHtml(day)}</div>` : "";
      previousDay = day || previousDay;
    }
    return [divider, next].filter(Boolean);
  });
  return rows.length
    ? rows.join("")
    : `<div class="conversation-empty">${searched ? "有搜索命中，但都被当前显示设置隐藏。" : "这条会话还没有可展示的内容。"}</div>`;
}

function scheduleScrollToLatest() {
  const list = document.querySelector("[data-conversation-list]");
  if (!list || !viewState.shouldStickToLatest) return;
  list.scrollTop = list.scrollHeight;
  viewState.unread = false;
}

function focusComposer() {
  window.requestAnimationFrame(() => document.querySelector("[data-conversation-composer]")?.focus());
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
  const current = document.querySelector("[data-conversation-list]");
  const scrollTop = current?.scrollTop;
  context.render();
  if (!Number.isFinite(scrollTop)) return;
  const restore = () => {
    const next = document.querySelector("[data-conversation-list]");
    if (next) next.scrollTop = scrollTop;
  };
  restore();
  window.requestAnimationFrame(restore);
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

function searchResultsMarkup() {
  if (viewState.searchLoading) return '<div class="conversation-search-panel__empty">正在搜索本地聊天记录…</div>';
  if (viewState.searchError) return `<div class="conversation-search-panel__empty is-error">${escapeHtml(viewState.searchError)}</div>`;
  const result = viewState.search;
  if (!result) return '<div class="conversation-search-panel__empty">输入关键词，或选择一个分类开始查找。</div>';
  const matches = Array.isArray(result.matches) ? result.matches : [];
  if (!matches.length) return '<div class="conversation-search-panel__empty">没有找到匹配的聊天内容。</div>';
  if (result.category === "images") {
    const images = imageGalleryFromSearch(result);
    if (!images.length) return '<div class="conversation-search-panel__empty">没有找到可预览的图片。</div>';
    return `<div class="conversation-search-panel__image-results">${images.map((item) => `<button type="button" class="conversation-search-panel__image-result" ${mediaPreviewAttributes(item)} aria-label="查看图片 ${escapeHtml(item.name)}"><img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.name)}" loading="lazy"><span>${escapeHtml(item.name)}</span></button>`).join("")}</div>`;
  }
  return `<div class="conversation-search-panel__results">${matches.map((match) => {
    const message = (match.messages || [])[0] || {};
    const lineNumber = messageLineNumber(message) || messageLineNumber(match);
    const messageId = messageSourceId(message) || clean(match.messageId);
    const timestamp = clean(message.timestamp || match.timestamp);
    return `<button type="button" class="conversation-search-panel__result" data-conversation-search-match data-conversation-search-line-number="${lineNumber || ""}" data-conversation-search-message-id="${escapeHtml(messageId)}"><span>${escapeHtml(dateTime(timestamp))} · ${escapeHtml(searchResultKind(message))}</span><strong>${escapeHtml(searchResultSummary(match))}</strong></button>`;
  }).join("")}</div>`;
}

function conversationSearchPanel() {
  if (!viewState.searchOpen) return "";
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
  return `<section class="conversation-search-panel" id="conversationSearchPanel" aria-label="搜索当前聊天">
    <header class="conversation-search-panel__header">
      <form id="conversationSearch" class="conversation-search-panel__form" role="search">
        <span aria-hidden="true">${chatIcon("search")}</span>
        <input id="conversationQuery" type="${isDate ? "date" : "search"}" maxlength="${isDate ? "" : "200"}" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(viewState.searchQuery)}" aria-label="${escapeHtml(placeholder)}">
      </form>
      <button type="button" class="conversation-search-panel__cancel" data-close-conversation-search>取消</button>
    </header>
    <div class="conversation-search-panel__body">
      <p class="conversation-search-panel__intro">快速搜索聊天内容</p>
      <div class="conversation-search-panel__categories" role="group" aria-label="搜索分类">
        ${searchCategories.map((item) => `<button type="button" class="conversation-search-panel__category${item.id === category.id ? " is-active" : ""}" data-conversation-search-category="${item.id}"><strong>${item.label}</strong><small>${item.hint}</small></button>`).join("")}
      </div>
      <section class="conversation-search-panel__matches" aria-live="polite">
        <header><strong>${viewState.search ? `${category.label}${resultCount}` : category.label}</strong><span>${viewState.search ? "点击结果跳转到原消息" : "按 Enter 搜索"}</span></header>
        ${searchResultsMarkup()}
      </section>
    </div>
  </section>`;
}

function scrollToConversationMessage({ lineNumber, messageId } = {}) {
  const wantedLine = messageLineNumber({ lineNumber });
  const wantedMessageId = clean(messageId);
  window.requestAnimationFrame(() => {
    const candidates = [...document.querySelectorAll("[data-conversation-message-id], [data-conversation-line-number]")];
    const target = candidates.find((item) => wantedLine && Number(item.dataset.conversationLineNumber) === wantedLine)
      || candidates.find((item) => wantedMessageId && clean(item.dataset.conversationMessageId) === wantedMessageId);
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("is-jump-target");
    window.setTimeout(() => target.classList.remove("is-jump-target"), 1800);
  });
}

function conversationComposer(ready) {
  const busy = viewState.busySessions.has(clean(viewState.snapshot?.activeSessionId));
  const unavailable = !ready || viewState.sending;
  const staticTool = (name, label) => `<span class="conversation-composer__static-tool" title="${label}" aria-hidden="true">${chatIcon(name)}</span>`;
  const emoji = ["🙂", "😊", "🥺", "✨", "❤️"];
  return `<form class="conversation-composer" id="conversationComposer">
    <div class="conversation-composer__surface">
      <textarea data-conversation-composer rows="3" maxlength="20000" placeholder="输入消息（Enter 发送；Ctrl+Enter 或 Shift+Enter 换行）" ${unavailable ? "disabled" : ""}>${escapeHtml(viewState.draft)}</textarea>
      <div class="conversation-composer__footer">
        <div class="conversation-composer__tools" aria-label="聊天工具">
          <button type="button" class="conversation-composer__tool${viewState.emojiOpen ? " is-active" : ""}" data-toggle-conversation-emoji title="表情" aria-label="表情" ${unavailable ? "disabled" : ""}>${chatIcon("emoji")}</button>
          ${staticTool("box", "附件")}
          ${staticTool("folder", "文件")}
          ${staticTool("scissors", "截图")}
          ${staticTool("mic", "语音输入")}
        </div>
        <div class="conversation-composer__submit-area">
          ${staticTool("sound", "语音消息")}
          <button class="conversation-send-button" ${unavailable ? "disabled" : ""}>${viewState.sending ? "发送中" : busy ? "加入队列" : "发送"}</button>
        </div>
      </div>
      ${viewState.emojiOpen ? `<div class="conversation-emoji-panel" role="group" aria-label="常用表情">${emoji.map((value) => `<button type="button" data-insert-conversation-emoji="${value}" aria-label="插入表情 ${value}">${value}</button>`).join("")}</div>` : ""}
    </div>
  </form>`;
}

function activeSession(payload) {
  const id = clean(payload?.activeSessionId);
  return (payload?.sessions || []).find((session) => session.id === id) || null;
}

function sessionSettingsPanel(context, selected, prefs) {
  const contact = viewState.snapshot?.activeContact || null;
  const sessionId = clean(selected?.id);
  if (!sessionId && !contact) return "";
  const contactName = clean(contact?.name) || clean(selected?.title) || "未命名联系人";
  const agent = getAgentProfile(context.state.settings);
  const saved = viewState.sessionSettings?.sessionId === sessionId ? viewState.sessionSettings : {};
  const note = viewState.sessionNoteDraft || saved.note || "";
  const wechat = viewState.wechatSnapshot;
  const connection = wechat?.session || null;
  const pendingQr = wechat?.pendingQr || null;
  const masterEnabled = wechat?.enabled === true;
  const connectionLabel = !wechat
    ? "正在读取微信连接状态"
    : !masterEnabled
      ? "全局连接已关闭"
      : connection
        ? (connection.enabled ? (connection.status === "connected" ? "已连接" : "已保存，正在恢复") : "当前会话已暂停")
        : pendingQr
          ? (pendingQr.status === "scanned" ? "手机已扫码，请在微信确认" : "等待微信扫码")
          : "尚未连接";
  const deliveryNote = connection?.lastError ? `<p class="conversation-session-settings__error">${escapeHtml(connection.lastError)}</p>` : "";
  const qrError = pendingQr?.error ? `<p class="conversation-session-settings__error">${escapeHtml(pendingQr.error)}</p>` : "";
  const wechatControls = !wechat
    ? ""
    : !masterEnabled
      ? '<div class="conversation-session-settings__actions"><button type="button" class="secondary-button" data-open-wechat-capability>打开“连接微信”总开关</button></div>'
      : connection
        ? `<div class="conversation-session-settings__connection-actions"><label class="conversation-session-settings__switch"><input type="checkbox" data-wechat-session-enabled="${escapeHtml(sessionId)}" ${connection.enabled ? "checked" : ""}><span>接收并投递这个会话</span></label><button type="button" class="text-button" data-wechat-disconnect="${escapeHtml(sessionId)}">断开微信</button></div>`
        : pendingQr
          ? `<div class="conversation-session-settings__actions"><button type="button" class="secondary-button" data-wechat-show-qr="${escapeHtml(sessionId)}">显示二维码</button><button type="button" class="text-button" data-wechat-begin="${escapeHtml(sessionId)}">重新生成二维码</button></div>`
          : `<div class="conversation-session-settings__actions"><button type="button" class="secondary-button" data-wechat-begin="${escapeHtml(sessionId)}">生成微信二维码</button></div>`;
  const contactAvatarSettings = contact
    ? `<section class="conversation-session-settings__section"><header><div><span>CONTACT</span><h2>联系人头像</h2></div></header><div class="conversation-session-settings__avatar"><span class="conversation-contact__avatar">${avatar(agent, contactName)}</span><div class="conversation-session-settings__avatar-copy"><strong>${escapeHtml(contactName)}</strong><div class="conversation-session-settings__avatar-actions"><label class="secondary-button">选择头像<input type="file" accept="image/png,image/jpeg,image/webp" data-contact-avatar-file hidden></label>${agent.avatarDataUrl ? '<button type="button" class="text-button" data-remove-contact-avatar>移除头像</button>' : ""}</div></div></div></section>`
    : "";
  const chatDisplaySettings = `<section class="conversation-session-settings__section"><header><div><span>CHAT DISPLAY</span><h2>聊天显示</h2></div></header><div class="conversation-session-settings__checks">${Object.entries({ attachments: "显示 Hook / 上下文", tools: "显示工具调用", thinking: "显示思考内容", system: "显示系统消息", tokens: "显示 Token 用量" }).map(([key, label]) => `<label><input type="checkbox" data-conversation-pref="${key}" ${prefs[key] ? "checked" : ""}>${label}</label>`).join("")}<label class="conversation-settings__time-display"><span>时间显示</span><select data-conversation-time-display aria-label="时间显示方式"><option value="bubble" ${timeDisplay(prefs) === "bubble" ? "selected" : ""}>每条气泡内</option><option value="wechat" ${timeDisplay(prefs) === "wechat" ? "selected" : ""}>微信式间隔显示</option></select></label></div></section>`;
  const sessionSettings = sessionId
    ? `<form class="conversation-session-settings__note" data-conversation-session-settings-form="${escapeHtml(sessionId)}"><label><span>备注</span><input type="text" data-conversation-note maxlength="2000" placeholder="给这个会话添加备注" value="${escapeHtml(note)}"></label><div><small>${saved.updatedAt ? `上次保存：${escapeHtml(dateTime(saved.updatedAt))}` : "可随时修改。"}</small><button class="secondary-button">保存备注</button></div></form>
    <section class="conversation-session-settings__section"><header><div><span>LOCAL MEDIA</span><h2>本地附件</h2><p>Agent 交付到这个会话的图片和文件保存在 Suzu 本地缓存中，并按会话分开。</p></div></header><div class="conversation-session-settings__actions"><button type="button" class="secondary-button" data-open-conversation-media-directory="${escapeHtml(sessionId)}">打开文件目录</button></div></section>
    <section class="conversation-session-settings__section conversation-session-settings__wechat"><header><div><span>WECHAT</span><h2>微信连接</h2><p>二维码会在中间弹出。扫码后，请向这个微信机器人发一条文字消息，确认它已进入当前会话；回复默认投递 Agent 的说话内容。</p></div><span class="conversation-session-settings__status">${escapeHtml(connectionLabel)}</span></header>${wechatControls}${qrError}${deliveryNote}${connection ? '<p class="conversation-session-settings__hint">指令和普通消息与这里一致：/suzu stop、/suzu steer …、以及 Claude Code 自己的 / 指令。</p>' : ""}</section>`
    : contact
      ? `<section class="conversation-session-settings__section"><header><div><span>CONVERSATION</span><h2>会话设置</h2><p>当前联系人还没有 Claude 会话。发送第一条消息后，这里会显示备注、本地附件和微信连接。</p></div></header></section>`
      : "";
  return `<aside class="conversation-session-settings${viewState.settingsOpen ? "" : " hidden"}" id="conversationSettings" aria-label="当前会话设置">
    <header><div><span>当前联系人</span><strong>${escapeHtml(contactName)}</strong></div><button type="button" class="conversation-session-settings__close suzu-close-button" data-close-conversation-settings aria-label="关闭会话设置">×</button></header>
    ${contactAvatarSettings}
    ${chatDisplaySettings}
    ${sessionSettings}
  </aside>`;
}

function wechatQrDialog(contact) {
  const pendingQr = viewState.wechatSnapshot?.pendingQr;
  const imageDataUrl = clean(pendingQr?.imageDataUrl);
  if (!viewState.wechatQrOpen || !imageDataUrl) return "";
  const title = clean(contact?.name) || "当前联系人";
  const statusCopy = pendingQr?.status === "scanned"
    ? "已扫码，请在手机微信中确认，并发送一条文字消息。"
    : "请使用要绑定这个会话的微信扫描二维码。";
  return `<div class="conversation-wechat-qr-overlay" data-conversation-wechat-qr-backdrop>
    <section class="conversation-wechat-qr-dialog" id="conversationWechatQr" role="dialog" aria-modal="true" aria-labelledby="conversationWechatQrTitle">
      <header><div><span>WECHAT · 当前会话</span><h2 id="conversationWechatQrTitle">连接「${escapeHtml(title)}」</h2></div><button type="button" class="suzu-close-button" data-close-conversation-wechat-qr aria-label="关闭二维码">×</button></header>
      <img src="${escapeHtml(imageDataUrl)}" alt="用于连接当前会话的微信二维码">
      <p class="conversation-wechat-qr-dialog__status">${escapeHtml(statusCopy)}</p>
      <p class="conversation-wechat-qr-dialog__instruction"><strong>扫码后，请在微信里向这个机器人发送一条文字消息。</strong><span>这条消息会作为“我”进入当前 Claude 会话，用来确认连接正确。</span></p>
      <button type="button" class="secondary-button" data-close-conversation-wechat-qr>我知道了</button>
    </section>
  </div>`;
}

function mediaPreviewDialog() {
  const preview = viewState.mediaPreview;
  const items = Array.isArray(preview?.items) && preview.items.length
    ? preview.items
    : preview?.url
      ? [preview]
      : [];
  const index = Math.min(Math.max(Number(preview?.index) || 0, 0), Math.max(items.length - 1, 0));
  const item = items[index] || null;
  const imageUrl = clean(item?.url);
  if (!imageUrl) return "";
  const imageName = clean(item?.name) || "图片附件";
  const previousDisabled = index <= 0 ? "disabled" : "";
  const nextDisabled = index >= items.length - 1 ? "disabled" : "";
  return `<div class="conversation-media-preview-overlay" data-conversation-media-preview-backdrop>
    <section class="conversation-media-preview-dialog" id="conversationMediaPreview" role="dialog" aria-modal="true" aria-labelledby="conversationMediaPreviewTitle">
      <header><div><strong id="conversationMediaPreviewTitle">${escapeHtml(imageName)}</strong><span>${index + 1} / ${items.length}</span></div><button type="button" class="suzu-close-button" data-close-conversation-media-preview aria-label="关闭图片预览">×</button></header>
      <div class="conversation-media-preview-dialog__stage">
        <button type="button" class="conversation-media-preview-dialog__nav" data-conversation-media-previous ${previousDisabled}>上一张</button>
        <img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(imageName)}">
        <button type="button" class="conversation-media-preview-dialog__nav" data-conversation-media-next ${nextDisabled}>下一张</button>
      </div>
      <footer><button type="button" class="text-button" data-conversation-media-jump data-conversation-media-line-number="${item.lineNumber || ""}" data-conversation-media-message-id="${escapeHtml(item.messageId)}">跳转到图片所在位置</button></footer>
    </section>
  </div>`;
}

function avatarCropDialog() {
  const crop = viewState.avatarCrop;
  if (!crop?.source) return "";
  const layout = avatarCropLayout(crop);
  const zoom = Math.round(layout.zoom * 100);
  return `<div class="conversation-avatar-crop-overlay" data-avatar-crop-backdrop>
    <section class="conversation-avatar-crop-dialog" id="conversationAvatarCrop" role="dialog" aria-modal="true" aria-labelledby="conversationAvatarCropTitle">
      <header><div><span>CONTACT AVATAR</span><h2 id="conversationAvatarCropTitle">裁剪头像</h2></div><button type="button" class="suzu-close-button" data-close-avatar-crop aria-label="取消裁剪">×</button></header>
      <p>拖动图片调整位置；方框内的正方形区域会作为头像保存。</p>
      <div class="conversation-avatar-crop-dialog__stage" data-avatar-crop-stage aria-label="头像裁剪区域">
        <img data-avatar-crop-image src="${escapeHtml(crop.source)}" alt="正在裁剪的联系人头像" draggable="false" style="width:${layout.displayWidth}px;height:${layout.displayHeight}px;transform:translate(${layout.offsetX}px, ${layout.offsetY}px)">
        <span class="conversation-avatar-crop-dialog__frame" aria-hidden="true"></span>
      </div>
      <label class="conversation-avatar-crop-dialog__zoom"><span>缩放</span><input type="range" min="${AVATAR_CROP_MIN_ZOOM}" max="${AVATAR_CROP_MAX_ZOOM}" step="0.01" value="${layout.zoom}" data-avatar-crop-zoom><output data-avatar-crop-zoom-value>${zoom}%</output></label>
      <footer><button type="button" class="text-button" data-close-avatar-crop>取消</button><button type="button" class="primary-button" data-confirm-avatar-crop>确认使用</button></footer>
    </section>
  </div>`;
}

function rosterContact(contact, activeContact, identity) {
  const name = clean(contact?.name) || "未命名联系人";
  const selected = clean(activeContact?.id) === clean(contact?.id);
  const agent = identity?.agents?.[clean(contact?.agentId)] || identity?.defaultAgent || { displayName: name, avatarDataUrl: "" };
  return `<button type="button" class="conversation-contact${selected ? " active" : ""}" data-conversation-contact="${escapeHtml(contact.id)}" ${selected ? 'aria-current="page"' : ""}>
    <span class="conversation-contact__avatar">${avatar(agent, name)}</span>
    <span class="conversation-contact__copy"><strong>${escapeHtml(name)}</strong></span>
    <span class="conversation-contact__state" title="${selected ? "当前联系人" : "联系人"}">${selected ? "●" : ""}</span>
  </button>`;
}

function contactCreateDialog() {
  if (!viewState.contactCreateOpen) return "";
  return `<div class="conversation-contact-create-overlay" data-conversation-contact-create-backdrop>
    <form class="conversation-contact-create-dialog" data-conversation-contact-create-form aria-label="新建联系人">
    <header><div><span>NEW CONTACT</span><h2>新建联系人</h2></div><button type="button" class="suzu-close-button" data-close-conversation-contact-create aria-label="关闭">×</button></header>
      <label><span>联系人备注</span><input data-conversation-contact-name maxlength="80" autocomplete="off" placeholder="只在 Suzu 中显示，可与其他联系人重名" required></label>
      <p>创建后即可开始聊天。</p>
      <footer><button type="button" class="text-button" data-close-conversation-contact-create>取消</button><button class="primary-button">创建联系人</button></footer>
    </form>
  </div>`;
}

function permissionPrompts(sessionId) {
  const prompts = [...viewState.permissions.values()].filter((item) => item.sessionId === sessionId);
  if (!prompts.length) return "";
  return `<section class="conversation-permissions" aria-label="Claude Code 权限请求">${prompts.map((item) => `<article class="conversation-permission">
    <div><strong>Claude Code 想使用：${escapeHtml(item.toolName || "工具")}</strong><pre>${escapeHtml(item.preview || "")}</pre></div>
    <div class="conversation-permission__actions">
      <button type="button" data-conversation-permission="deny" data-conversation-permission-id="${escapeHtml(item.requestId)}">拒绝</button>
      <button type="button" class="primary" data-conversation-permission="allow" data-conversation-permission-id="${escapeHtml(item.requestId)}">允许</button>
    </div>
  </article>`).join("")}</section>`;
}

export function renderRelationshipOverview(context) {
  const memory = context?.state?.memoryStatus || {};
  const memoryReady = memory.status === "ready";
  return `${pageIntro("RELATIONSHIPS", "让关系有连续的记忆", "在这里查看对话、记忆与重要关系。")}
    <section class="relationship-overview" aria-label="关系功能">
      <button type="button" class="relationship-card relationship-card--conversation" data-open-conversation aria-label="打开对话：查看并继续当前 Claude 会话">
        <span class="relationship-card__topline">
          <span class="relationship-card__eyebrow">CONVERSATION</span>
          ${status("可继续", "ready")}
        </span>
        <span class="relationship-card__headline">
          <span class="relationship-card__title">对话</span>
          <span class="relationship-card__subtitle">按联系人查看各自的 Claude 会话，也可以直接继续聊天。</span>
        </span>
        <span class="relationship-card__detail">保留消息、上下文、思考与工具记录。</span>
        <span class="relationship-card__footer">
          <span>本地历史 · 继续当前联系人</span>
          <span class="relationship-card__arrow" aria-hidden="true">→</span>
        </span>
      </button>
      <button type="button" class="relationship-card relationship-card--memory" data-open-memory aria-label="打开记忆：查看、检索和维护长期记忆">
        <span class="relationship-card__secondary-head">
          <span><span class="relationship-card__eyebrow">LONG-TERM CONTEXT</span><h2>记忆</h2></span>
          ${status(memoryReady ? "可用" : "尚未建立", memoryReady ? "ready" : "warning")}
        </span>
        <p>可追溯的长期上下文</p>
        <span class="relationship-card__state"><span>${memoryReady ? `${Number(memory.memories || 0).toLocaleString("zh-CN")} 个节点 · ${Number(memory.edges || 0).toLocaleString("zh-CN")} 条关联` : "进入后可迁移已有记忆。"}</span><span class="relationship-card__arrow" aria-hidden="true">→</span></span>
      </button>
      <button type="button" class="relationship-card relationship-card--settings" data-open-relationship-settings aria-label="打开相处设定：编辑当前项目中的关系文本">
        <span class="relationship-card__secondary-head">
          <span><span class="relationship-card__eyebrow">RELATIONSHIP SETUP</span><h2>相处设定</h2></span>
          ${status("直接写入", "ready")}
        </span>
        <p>管理 CLAUDE.md、persona.md、user.md 与引用的 Markdown 文件。</p>
        <span class="relationship-card__state"><span>仅当前项目 · 不保存副本</span><span class="relationship-card__arrow" aria-hidden="true">→</span></span>
      </button>
      <article class="relationship-card relationship-card--people">
        <div class="relationship-card__secondary-head">
          <div><div class="relationship-card__eyebrow">PEOPLE &amp; PLACES</div><h2>人物与地点</h2></div>
          ${status("还没有资料", "muted")}
        </div>
        <p>重要关系的时间线</p>
        <div class="relationship-card__state"><span>等待结构化来源。</span><span aria-hidden="true">···</span></div>
      </article>
    </section>`;
}

export function renderConversation(context) {
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
  return `<section class="conversation-workspace" aria-label="对话">
    <aside class="conversation-roster" aria-label="联系人列表">
      <div class="conversation-roster__heading"><strong>联系人</strong><button type="button" data-conversation-new title="新建联系人" aria-label="新建联系人" ${hasContactsRoot ? "" : "disabled"}>＋</button></div>
      ${contacts.length ? contacts.map((contact) => rosterContact(contact, activeContact, identity)).join("") : `<div class="conversation-roster__empty">${hasContactsRoot ? "还没有联系人。点击右上角“＋”创建。" : "请先到“设置”选择 Agent 工作目录。"}</div>`}
    </aside>
    <section class="conversation-pane">
      <header class="conversation-pane__header">
        <h1 class="conversation-peer">${escapeHtml(peer)}</h1>
        <div class="conversation-pane__actions">
          <button type="button" class="conversation-icon-button${viewState.searchOpen ? " is-active" : ""}" data-toggle-conversation-search title="搜索消息" aria-label="搜索消息">${chatIcon("search")}</button>
          <button type="button" class="conversation-icon-button${viewState.menuOpen ? " is-active" : ""}" data-toggle-conversation-menu title="更多聊天选项" aria-label="更多聊天选项">${chatIcon("more")}</button>
          ${viewState.menuOpen ? `<div class="conversation-menu">
            <button type="button" data-open-conversation-session-settings>设置</button>
            <button type="button" data-conversation-refresh>刷新记录</button>
            ${viewState.mode === "focus" ? '<button type="button" data-conversation-clear>返回当前聊天</button>' : ""}
          </div>` : ""}
        </div>
      </header>
      ${sessionSettingsPanel(context, selected, prefs)}
      ${viewState.error ? `<div class="conversation-error">${escapeHtml(conversationInfo(payload))}</div>` : ""}
      ${viewState.notice ? `<div class="conversation-notice">${escapeHtml(viewState.notice)}</div>` : ""}
      ${viewState.mode === "focus" ? '<div class="conversation-focus-banner"><span>已定位到搜索结果附近的聊天记录</span><button type="button" data-conversation-clear>回到最新消息</button></div>' : ""}
      <div class="conversation-chat-shell">
        ${permissionPrompts(clean(snapshot.activeSessionId))}
        <div class="conversation-list" data-conversation-list role="log" aria-live="polite" aria-label="${escapeHtml(agent.displayName || "Suzu")} 的聊天记录">
          ${renderConversationMessages(entries, context, viewState.mode === "focus")}
        </div>
        ${viewState.unread ? '<button type="button" class="conversation-latest" data-conversation-jump>回到最新消息</button>' : ""}
        ${conversationComposer(ready)}
      </div>
      ${conversationSearchPanel()}
    </section>
    ${contactCreateDialog()}
    ${wechatQrDialog(activeContact)}
    ${mediaPreviewDialog()}
    ${avatarCropDialog()}
  </section>`;
}

function resetSessionSettings() {
  viewState.sessionNoteDirty = false;
  viewState.sessionNoteDraft = "";
  viewState.sessionSettings = null;
  viewState.mediaPreview = null;
  viewState.avatarCrop = null;
  viewState.wechatSnapshot = null;
  viewState.wechatQrOpen = false;
}

async function refreshCurrentSessionSettings(context) {
  const sessionId = clean(viewState.snapshot?.activeSessionId);
  if (!sessionId || !context.api.conversation.sessionSettingsSnapshot) {
    resetSessionSettings();
    return;
  }
  const previousSessionId = clean(viewState.sessionSettings?.sessionId);
  if (previousSessionId && previousSessionId !== sessionId) resetSessionSettings();
  viewState.settingsLoading = true;
  try {
    const [sessionSettings, wechatSnapshot] = await Promise.all([
      context.api.conversation.sessionSettingsSnapshot({ sessionId }),
      context.api.wechat?.snapshot ? context.api.wechat.snapshot({ sessionId }) : Promise.resolve(null),
    ]);
    if (clean(viewState.snapshot?.activeSessionId) !== sessionId) return;
    viewState.sessionSettings = sessionSettings;
    if (!viewState.sessionNoteDirty) viewState.sessionNoteDraft = clean(sessionSettings?.note);
    viewState.wechatSnapshot = wechatSnapshot;
  } catch (error) {
    if (clean(viewState.snapshot?.activeSessionId) === sessionId) {
      viewState.error = `读取会话设置失败：${error?.message || error}`;
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
      const priorSessionId = clean(viewState.snapshot?.activeSessionId);
      viewState.snapshot = snapshot;
      viewState.lastVersion = snapshot.version;
      if (priorSessionId !== clean(snapshot.activeSessionId)) {
        resetSessionSettings();
        if (viewState.settingsOpen) void refreshCurrentSessionSettings(context);
      }
      context.render();
      scheduleScrollToLatest();
    }
  } catch (error) {
    viewState.error = `读取会话失败：${error?.message || error}`;
    context.render();
  } finally {
    viewState.loading = false;
  }
}

function handleConversationEvent(context, event) {
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
    context.render();
    scheduleScrollToLatest();
    if (event.type === "reply" || event.done === true) load(context, true);
  }
}

export function startConversationPolling(context) {
  stopConversationPolling();
  viewState.shouldStickToLatest = true;
  load(context, true);
  if (typeof context.api.conversation.onEvent === "function") {
    viewState.unsubscribe = context.api.conversation.onEvent((event) => handleConversationEvent(context, event));
  }
  if (typeof context.api.wechat?.onEvent === "function") {
    viewState.wechatUnsubscribe = context.api.wechat.onEvent((event) => {
      const activeSessionId = clean(viewState.snapshot?.activeSessionId);
      if (!activeSessionId || !clean(event?.sessionId) || clean(event.sessionId) === activeSessionId) {
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
  viewState.dismissController?.abort();
  viewState.dismissController = null;
}

async function saveDisplayPreference(context, input) {
  const next = { ...preferences(context.state.settings), [input.dataset.conversationPref]: input.checked };
  context.state.settings = await context.api.settings.update({ conversationPreferences: next });
  context.render();
}

async function saveTimeDisplayPreference(context, input) {
  const next = { ...preferences(context.state.settings), timeDisplay: timeDisplay({ timeDisplay: input.value }) };
  context.state.settings = await context.api.settings.update({ conversationPreferences: next });
  context.render();
}

export function dismissConversationOverlays(target = viewState) {
  const state = target && typeof target === "object" ? target : viewState;
  const open = Boolean(state.contactCreateOpen || state.menuOpen || state.searchOpen || state.settingsOpen || state.emojiOpen || state.wechatQrOpen || state.mediaPreview || state.avatarCrop);
  state.contactCreateOpen = false;
  state.menuOpen = false;
  state.searchOpen = false;
  state.settingsOpen = false;
  state.emojiOpen = false;
  state.wechatQrOpen = false;
  state.mediaPreview = null;
  state.avatarCrop = null;
  return open;
}

function bindConversationOverlayDismissal(context) {
  viewState.dismissController?.abort();
  const controller = new AbortController();
  viewState.dismissController = controller;
  const isOverlayControl = (target) => Boolean(target?.closest?.([
    "#conversationSettings",
    ".conversation-menu",
    "[data-toggle-conversation-menu]",
    "[data-open-conversation-session-settings]",
    "[data-close-conversation-settings]",
    "[data-toggle-conversation-search]",
    "#conversationSearchPanel",
    "#conversationSearch",
    "[data-close-conversation-search]",
    "[data-conversation-search-category]",
    "[data-conversation-search-match]",
    "[data-toggle-conversation-emoji]",
    "[data-conversation-new]",
    ".conversation-contact-create-dialog",
    "[data-conversation-contact-create-backdrop]",
    "[data-close-conversation-contact-create]",
    "#conversationWechatQr",
    "[data-conversation-wechat-qr-backdrop]",
    "[data-close-conversation-wechat-qr]",
    "#conversationMediaPreview",
    "[data-conversation-media-preview]",
    "[data-conversation-media-preview-backdrop]",
    "[data-close-conversation-media-preview]",
    "#conversationAvatarCrop",
    "[data-avatar-crop-backdrop]",
    "[data-close-avatar-crop]",
    "[data-avatar-crop-stage]",
    "[data-avatar-crop-zoom]",
    "[data-confirm-avatar-crop]",
  ].join(", ")));
  document.addEventListener("click", (event) => {
    if (isOverlayControl(event.target) || !dismissConversationOverlays()) return;
    context.render();
  }, { signal: controller.signal });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !dismissConversationOverlays()) return;
    event.preventDefault();
    context.render();
    document.querySelector("[data-toggle-conversation-menu]")?.focus();
  }, { signal: controller.signal });
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
    context.render();
    focusComposer();
    return;
  }
  if (command.action === "stop") {
    const sessionId = clean(viewState.snapshot?.activeSessionId);
    if (!sessionId) {
      viewState.draft = "";
      viewState.error = "";
      viewState.notice = "当前没有可停止的 Claude 会话。";
      context.render();
      focusComposer();
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
      context.render();
      focusComposer();
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
  context.render();
  scheduleScrollToLatest();
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
    context.render();
    scheduleScrollToLatest();
    load(context, true);
  } catch (error) {
    viewState.pending = viewState.pending.filter((item) => item !== pending);
    viewState.draft = raw;
    viewState.error = `没有发出去：${error?.message || error}`;
    viewState.sending = false;
    context.render();
    focusComposer();
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

function applyAvatarCropPreview() {
  const crop = viewState.avatarCrop;
  const image = document.querySelector("[data-avatar-crop-image]");
  const range = document.querySelector("[data-avatar-crop-zoom]");
  const output = document.querySelector("[data-avatar-crop-zoom-value]");
  if (!crop || !image) return;
  const layout = avatarCropLayout(crop);
  image.style.width = `${layout.displayWidth}px`;
  image.style.height = `${layout.displayHeight}px`;
  image.style.transform = `translate(${layout.offsetX}px, ${layout.offsetY}px)`;
  if (range) range.value = String(layout.zoom);
  if (output) output.textContent = `${Math.round(layout.zoom * 100)}%`;
}

function fitAvatarCropToStage(stage) {
  const crop = viewState.avatarCrop;
  const bounds = stage?.getBoundingClientRect?.();
  const width = Math.round(Number(bounds?.width) || 0);
  const height = Math.round(Number(bounds?.height) || 0);
  if (!crop || width < 1 || height < 1) return;
  if (crop.viewportWidth !== width || crop.viewportHeight !== height) {
    viewState.avatarCrop = resizeAvatarCropViewport(crop, width, height);
  }
  applyAvatarCropPreview();
}

function croppedAvatarDataUrl() {
  const crop = viewState.avatarCrop;
  const image = document.querySelector("[data-avatar-crop-image]");
  if (!crop || !image?.naturalWidth || !image?.naturalHeight) throw new Error("头像图片尚未准备好，请稍后重试。" );
  const source = avatarCropSourceRect(crop);
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_CROP_OUTPUT_SIZE;
  canvas.height = AVATAR_CROP_OUTPUT_SIZE;
  const drawing = canvas.getContext("2d");
  if (!drawing) throw new Error("当前环境无法裁剪头像。" );
  drawing.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/webp", .92);
}

function bindAvatarCropEvents(context) {
  const stage = document.querySelector("[data-avatar-crop-stage]");
  if (!stage || !viewState.avatarCrop) return;
  fitAvatarCropToStage(stage);
  let drag = null;
  const finishDrag = (event) => {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    try { stage.releasePointerCapture(drag.pointerId); } catch { /* A released pointer needs no further work. */ }
    drag = null;
    stage.classList.remove("is-dragging");
  };
  stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !viewState.avatarCrop) return;
    event.preventDefault();
    drag = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add("is-dragging");
  });
  stage.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId || !viewState.avatarCrop) return;
    viewState.avatarCrop = moveAvatarCrop(viewState.avatarCrop, event.clientX - drag.clientX, event.clientY - drag.clientY);
    drag = { ...drag, clientX: event.clientX, clientY: event.clientY };
    applyAvatarCropPreview();
  });
  stage.addEventListener("pointerup", finishDrag);
  stage.addEventListener("pointercancel", finishDrag);
  document.querySelector("[data-avatar-crop-zoom]")?.addEventListener("input", (event) => {
    if (!viewState.avatarCrop) return;
    viewState.avatarCrop = setAvatarCropZoom(viewState.avatarCrop, event.currentTarget.value);
    applyAvatarCropPreview();
  });
  document.querySelectorAll("[data-close-avatar-crop]").forEach((button) => button.addEventListener("click", () => {
    viewState.avatarCrop = null;
    context.render();
  }));
  document.querySelector("[data-avatar-crop-backdrop]")?.addEventListener("click", (event) => {
    if (event.target !== event.currentTarget) return;
    viewState.avatarCrop = null;
    context.render();
  });
  document.querySelector("[data-confirm-avatar-crop]")?.addEventListener("click", async () => {
    try {
      await saveCurrentContactAvatar(context, croppedAvatarDataUrl());
      viewState.avatarCrop = null;
    } catch (error) {
      viewState.error = `无法保存联系人头像：${error?.message || error}`;
    }
    renderKeepingConversationScroll(context);
  });
}

function resetConversationFocus() {
  viewState.focus = null;
  viewState.mode = "snapshot";
  viewState.search = null;
  viewState.searchError = "";
  viewState.searchLoading = false;
}

function queryFromSearchInput() {
  const input = document.querySelector("#conversationQuery");
  return viewState.searchCategory === "date"
    ? String(input?.value || viewState.searchQuery || "")
    : clean(input?.value || viewState.searchQuery);
}

async function runConversationSearch(context, requestedCategory = viewState.searchCategory) {
  const category = searchCategoryInfo(requestedCategory).id;
  const query = queryFromSearchInput();
  viewState.searchCategory = category;
  viewState.searchQuery = query;
  if (category === "messages" && !query) {
    viewState.searchError = "请输入要查找的关键词。";
    context.render();
    window.requestAnimationFrame(() => document.querySelector("#conversationQuery")?.focus());
    return;
  }
  if (category === "date" && !query) {
    viewState.searchError = "请选择要查找的日期。";
    context.render();
    window.requestAnimationFrame(() => document.querySelector("#conversationQuery")?.focus());
    return;
  }
  if (typeof context.api.conversation.search !== "function") {
    viewState.searchError = "当前版本无法搜索本地聊天记录。";
    context.render();
    return;
  }
  viewState.searchLoading = true;
  viewState.searchError = "";
  try {
    viewState.search = await context.api.conversation.search({ category, query });
  } catch (error) {
    viewState.searchError = `搜索失败：${error?.message || error}`;
  } finally {
    viewState.searchLoading = false;
    context.render();
  }
}

async function focusConversationRecord(context, { lineNumber, messageId } = {}, { fromSearch = false } = {}) {
  const targetLineNumber = messageLineNumber({ lineNumber });
  const targetMessageId = clean(messageId);
  if (!targetLineNumber || typeof context.api.conversation.focus !== "function") {
    viewState.searchOpen = false;
    context.render();
    scrollToConversationMessage({ lineNumber: targetLineNumber, messageId: targetMessageId });
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
    context.render();
    scrollToConversationMessage({ lineNumber: targetLineNumber, messageId: targetMessageId });
    return true;
  } catch (error) {
    const message = `无法定位聊天记录：${error?.message || error}`;
    if (fromSearch && viewState.searchOpen) viewState.searchError = message;
    else viewState.error = message;
    context.render();
    return false;
  }
}

function mediaPreviewItemFromButton(button) {
  const url = clean(button?.dataset?.conversationMediaUrl);
  if (!url) return null;
  const name = clean(button.dataset.conversationMediaName) || "图片附件";
  const messageId = clean(button.dataset.conversationMediaMessageId);
  const lineNumber = messageLineNumber({ lineNumber: button.dataset.conversationMediaLineNumber });
  return {
    key: clean(button.dataset.conversationMediaPreview) || encodeURIComponent([messageId || `line:${lineNumber}`, url, name].join("|")),
    lineNumber,
    messageId,
    name,
    url,
  };
}

async function openConversationMediaPreview(context, button) {
  const fallback = mediaPreviewItemFromButton(button);
  if (!fallback) return;
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

export function bindConversationEvents(context) {
  bindConversationOverlayDismissal(context);
  bindAvatarCropEvents(context);
  document.querySelector("[data-open-conversation]")?.addEventListener("click", () => context.setRelationshipPage("conversation"));
  document.querySelector("[data-open-memory]")?.addEventListener("click", () => context.setRelationshipPage("memory"));
  document.querySelector("[data-open-relationship-settings]")?.addEventListener("click", () => context.setRelationshipPage("settings"));
  document.querySelector("[data-conversation-new]")?.addEventListener("click", () => {
    if (viewState.sending) return;
    viewState.contactCreateOpen = true;
    viewState.error = "";
    viewState.menuOpen = false;
    viewState.searchOpen = false;
    viewState.settingsOpen = false;
    context.render();
    window.requestAnimationFrame(() => document.querySelector("[data-conversation-contact-name]")?.focus());
  });
  document.querySelectorAll("[data-close-conversation-contact-create]").forEach((button) => button.addEventListener("click", () => {
    viewState.contactCreateOpen = false;
    context.render();
  }));
  document.querySelector("[data-conversation-contact-create-backdrop]")?.addEventListener("click", (event) => {
    if (event.target !== event.currentTarget) return;
    viewState.contactCreateOpen = false;
    context.render();
  });
  document.querySelector("[data-conversation-contact-create-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = clean(document.querySelector("[data-conversation-contact-name]")?.value);
    if (!name || viewState.sending || !context.api.conversation.createContact) return;
    viewState.sending = true;
    try {
      viewState.snapshot = await context.api.conversation.createContact({ name });
      viewState.lastVersion = viewState.snapshot.version;
      if (context.api.settings?.get) context.state.settings = await context.api.settings.get();
      viewState.contactCreateOpen = false;
      resetSessionSettings();
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
      viewState.sending = false;
      context.render();
      scheduleScrollToLatest();
      focusComposer();
    } catch (error) {
      viewState.error = `无法新建联系人：${error?.message || error}`;
      viewState.sending = false;
      context.render();
    }
  });
  document.querySelectorAll("[data-conversation-contact]").forEach((button) => button.addEventListener("click", async () => {
    const id = clean(button.dataset.conversationContact);
    if (!id || viewState.sending || !context.api.conversation.selectContact) return;
    try {
      viewState.snapshot = await context.api.conversation.selectContact({ id });
      viewState.lastVersion = viewState.snapshot.version;
      if (context.api.settings?.get) context.state.settings = await context.api.settings.get();
      resetSessionSettings();
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
      context.render();
      scheduleScrollToLatest();
    } catch (error) {
      viewState.error = `无法切换联系人：${error?.message || error}`;
      context.render();
    }
  }));
  document.querySelector("[data-toggle-conversation-menu]")?.addEventListener("click", () => {
    viewState.menuOpen = !viewState.menuOpen;
    viewState.searchOpen = false;
    viewState.settingsOpen = false;
    viewState.emojiOpen = false;
    renderKeepingConversationScroll(context);
  });
  document.querySelector("[data-open-conversation-session-settings]")?.addEventListener("click", async () => {
    viewState.menuOpen = false;
    viewState.searchOpen = false;
    viewState.settingsOpen = true;
    viewState.emojiOpen = false;
    context.render();
    await refreshCurrentSessionSettings(context);
  });
  document.querySelector("[data-close-conversation-settings]")?.addEventListener("click", () => {
    viewState.settingsOpen = false;
    context.render();
  });
  document.querySelector("[data-contact-avatar-file]")?.addEventListener("change", async (event) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    event.currentTarget.value = "";
    try {
      const source = await readAvatarFile(file);
      const dimensions = await loadAvatarCropSource(source);
      viewState.avatarCrop = createSquareAvatarCrop({ source, ...dimensions });
      viewState.error = "";
    } catch (error) {
      viewState.error = `无法读取联系人头像：${error?.message || error}`;
    }
    renderKeepingConversationScroll(context);
  });
  document.querySelector("[data-remove-contact-avatar]")?.addEventListener("click", async () => {
    try {
      await saveCurrentContactAvatar(context, "");
    } catch (error) {
      viewState.error = `无法移除联系人头像：${error?.message || error}`;
    }
    renderKeepingConversationScroll(context);
  });
  document.querySelector("[data-toggle-conversation-search]")?.addEventListener("click", () => {
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
    }
    renderKeepingConversationScroll(context);
    if (viewState.searchOpen) window.requestAnimationFrame(() => document.querySelector("#conversationQuery")?.focus());
  });
  document.querySelector("[data-close-conversation-search]")?.addEventListener("click", () => {
    viewState.searchOpen = false;
    viewState.searchError = "";
    viewState.searchLoading = false;
    renderKeepingConversationScroll(context);
  });
  document.querySelectorAll("[data-conversation-pref]").forEach((input) => input.addEventListener("change", () => saveDisplayPreference(context, input)));
  document.querySelector("[data-conversation-time-display]")?.addEventListener("change", (event) => saveTimeDisplayPreference(context, event.currentTarget));
  document.querySelector("[data-conversation-note]")?.addEventListener("input", (event) => {
    viewState.sessionNoteDraft = event.currentTarget.value;
    viewState.sessionNoteDirty = true;
  });
  document.querySelector("[data-conversation-session-settings-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const sessionId = clean(event.currentTarget.dataset.conversationSessionSettingsForm);
    if (!sessionId || !context.api.conversation.saveSessionSettings) return;
    try {
      viewState.sessionSettings = await context.api.conversation.saveSessionSettings({ sessionId, note: viewState.sessionNoteDraft });
      viewState.sessionNoteDraft = clean(viewState.sessionSettings.note);
      viewState.sessionNoteDirty = false;
      viewState.error = "";
      viewState.notice = "会话备注已保存。";
    } catch (error) {
      viewState.error = `无法保存会话备注：${error?.message || error}`;
    }
    context.render();
  });
  document.querySelector("[data-open-conversation-media-directory]")?.addEventListener("click", async (event) => {
    const sessionId = clean(event.currentTarget.dataset.openConversationMediaDirectory);
    if (!sessionId || !context.api.conversation.openMediaDirectory) return;
    try {
      await context.api.conversation.openMediaDirectory({ sessionId });
    } catch (error) {
      viewState.error = `无法打开会话文件目录：${error?.message || error}`;
      context.render();
    }
  });
  document.querySelector("[data-wechat-begin]")?.addEventListener("click", async (event) => {
    const sessionId = clean(event.currentTarget.dataset.wechatBegin);
    if (!sessionId || !context.api.wechat?.begin) return;
    try {
      viewState.wechatSnapshot = await context.api.wechat.begin({ sessionId });
      viewState.wechatQrOpen = true;
      viewState.error = "";
      viewState.notice = "微信二维码已生成。扫码后请发一条文字消息确认进入此会话。";
    } catch (error) {
      viewState.error = `无法生成微信二维码：${error?.message || error}`;
    }
    context.render();
  });
  document.querySelector("[data-wechat-show-qr]")?.addEventListener("click", () => {
    viewState.wechatQrOpen = true;
    context.render();
  });
  document.querySelectorAll("[data-close-conversation-wechat-qr]").forEach((button) => button.addEventListener("click", () => {
    viewState.wechatQrOpen = false;
    context.render();
  }));
  document.querySelector("[data-conversation-wechat-qr-backdrop]")?.addEventListener("click", (event) => {
    if (event.target !== event.currentTarget) return;
    viewState.wechatQrOpen = false;
    context.render();
  });
  document.querySelectorAll("[data-conversation-media-preview]").forEach((button) => button.addEventListener("click", () => {
    void openConversationMediaPreview(context, button);
  }));
  document.querySelectorAll("[data-close-conversation-media-preview]").forEach((button) => button.addEventListener("click", () => {
    viewState.mediaPreview = null;
    context.render();
  }));
  document.querySelector("[data-conversation-media-preview-backdrop]")?.addEventListener("click", (event) => {
    if (event.target !== event.currentTarget) return;
    viewState.mediaPreview = null;
    context.render();
  });
  document.querySelector("[data-conversation-media-previous]")?.addEventListener("click", () => {
    const preview = viewState.mediaPreview;
    const items = Array.isArray(preview?.items) ? preview.items : [];
    const index = Math.max((Number(preview?.index) || 0) - 1, 0);
    if (!items.length || index === preview?.index) return;
    viewState.mediaPreview = { ...preview, index };
    context.render();
  });
  document.querySelector("[data-conversation-media-next]")?.addEventListener("click", () => {
    const preview = viewState.mediaPreview;
    const items = Array.isArray(preview?.items) ? preview.items : [];
    const index = Math.min((Number(preview?.index) || 0) + 1, Math.max(items.length - 1, 0));
    if (!items.length || index === preview?.index) return;
    viewState.mediaPreview = { ...preview, index };
    context.render();
  });
  document.querySelector("[data-conversation-media-jump]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const lineNumber = messageLineNumber({ lineNumber: button.dataset.conversationMediaLineNumber });
    const messageId = clean(button.dataset.conversationMediaMessageId);
    viewState.mediaPreview = null;
    await focusConversationRecord(context, { lineNumber, messageId });
  });
  document.querySelector("[data-wechat-session-enabled]")?.addEventListener("change", async (event) => {
    const input = event.currentTarget;
    const sessionId = clean(input.dataset.wechatSessionEnabled);
    if (!sessionId || !context.api.wechat?.setSessionEnabled) return;
    try {
      viewState.wechatSnapshot = await context.api.wechat.setSessionEnabled({ sessionId, enabled: input.checked });
      viewState.error = "";
      viewState.notice = input.checked ? "这个会话已恢复微信消息。" : "这个会话的微信消息已暂停。";
    } catch (error) {
      viewState.error = `无法更新微信会话：${error?.message || error}`;
    }
    context.render();
  });
  document.querySelector("[data-wechat-disconnect]")?.addEventListener("click", async (event) => {
    const sessionId = clean(event.currentTarget.dataset.wechatDisconnect);
    if (!sessionId || !context.api.wechat?.disconnect) return;
    if (!window.confirm("断开后，这个微信账号将不再进入当前 Claude 会话。确定断开吗？")) return;
    try {
      viewState.wechatSnapshot = await context.api.wechat.disconnect({ sessionId, confirmed: true });
      viewState.error = "";
      viewState.notice = "当前会话的微信连接已断开。";
    } catch (error) {
      viewState.error = `无法断开微信：${error?.message || error}`;
    }
    context.render();
  });
  document.querySelector("[data-open-wechat-capability]")?.addEventListener("click", () => {
    context.setView?.("capabilities");
    context.setCapabilityPage?.("detail", "act", "wechat-connection");
  });
  document.querySelector("#conversationSearch")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void runConversationSearch(context);
  });
  document.querySelector("#conversationQuery")?.addEventListener("input", (event) => {
    viewState.searchQuery = event.currentTarget.value;
    viewState.searchError = "";
  });
  document.querySelector("#conversationQuery")?.addEventListener("change", (event) => {
    viewState.searchQuery = event.currentTarget.value;
    if (viewState.searchCategory === "date" && viewState.searchQuery) void runConversationSearch(context);
  });
  document.querySelectorAll("[data-conversation-search-category]").forEach((button) => button.addEventListener("click", () => {
    const category = searchCategoryInfo(button.dataset.conversationSearchCategory).id;
    viewState.searchCategory = category;
    viewState.search = null;
    viewState.searchError = "";
    if (category === "date") {
      viewState.searchQuery = "";
      context.render();
      window.requestAnimationFrame(() => document.querySelector("#conversationQuery")?.focus());
      return;
    }
    viewState.searchQuery = clean(document.querySelector("#conversationQuery")?.value || viewState.searchQuery);
    if (category === "messages") {
      context.render();
      window.requestAnimationFrame(() => document.querySelector("#conversationQuery")?.focus());
      return;
    }
    void runConversationSearch(context, category);
  }));
  document.querySelectorAll("[data-conversation-search-match]").forEach((button) => button.addEventListener("click", async () => {
    await focusConversationRecord(context, {
      lineNumber: button.dataset.conversationSearchLineNumber,
      messageId: button.dataset.conversationSearchMessageId,
    }, { fromSearch: true });
  }));
  document.querySelector("[data-conversation-clear]")?.addEventListener("click", () => {
    resetConversationFocus();
    viewState.searchOpen = false;
    viewState.searchQuery = "";
    viewState.shouldStickToLatest = true;
    context.render();
    load(context, true);
  });
  document.querySelector("[data-conversation-refresh]")?.addEventListener("click", () => load(context, true));
  document.querySelector("[data-conversation-jump]")?.addEventListener("click", () => {
    viewState.shouldStickToLatest = true;
    viewState.unread = false;
    context.render();
    scheduleScrollToLatest();
  });
  document.querySelector("[data-toggle-conversation-emoji]")?.addEventListener("click", () => {
    viewState.emojiOpen = !viewState.emojiOpen;
    viewState.menuOpen = false;
    context.render();
    if (viewState.emojiOpen) focusComposer();
  });
  document.querySelectorAll("[data-insert-conversation-emoji]").forEach((button) => button.addEventListener("click", () => {
    viewState.draft = `${viewState.draft}${button.dataset.insertConversationEmoji || ""}`;
    context.render();
    focusComposer();
  }));
  document.querySelectorAll("[data-conversation-permission]").forEach((button) => button.addEventListener("click", async () => {
    const requestId = clean(button.dataset.conversationPermissionId);
    const behavior = button.dataset.conversationPermission;
    if (!requestId || !["allow", "deny"].includes(behavior)) return;
    try {
      await context.api.conversation.respondPermission({ requestId, behavior });
      viewState.permissions.delete(requestId);
      viewState.error = "";
    } catch (error) {
      viewState.error = `无法提交权限选择：${error?.message || error}`;
    }
    context.render();
  }));
  const list = document.querySelector("[data-conversation-list]");
  list?.addEventListener("scroll", () => {
    const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
    viewState.shouldStickToLatest = distance < 48;
    if (viewState.shouldStickToLatest) viewState.unread = false;
  });
  const composer = document.querySelector("#conversationComposer");
  composer?.addEventListener("submit", (event) => {
    event.preventDefault();
    sendMessage(context);
  });
  const textarea = document.querySelector("[data-conversation-composer]");
  textarea?.addEventListener("input", () => {
    viewState.draft = textarea.value;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 164)}px`;
  });
  textarea?.addEventListener("keydown", (event) => {
    if (shouldSubmitConversationOnEnter(event)) {
      event.preventDefault();
      composer?.requestSubmit();
    }
  });
  scheduleScrollToLatest();
}
