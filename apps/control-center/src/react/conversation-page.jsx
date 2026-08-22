import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import emojiMartData from "@emoji-mart/data/sets/15/apple.json";
import emojiMartI18n from "@emoji-mart/data/i18n/zh.json";
import appleEmojiSpritesheet from "emoji-datasource-apple/img/apple/sheets-128/32.png";
import { Picker } from "emoji-mart";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatVoice, Select } from "suzu-design-system";

import { hasMarkdownFormatting, shouldSubmitConversationOnEnter } from "../features/conversation/index.mjs";
import { useConversationCall } from "./conversation-call.jsx";
import { captureConversationViewportAnchor, restoreConversationViewportAnchor } from "./conversation-scroll-anchor.mjs";
import { useConversationVoiceInput } from "./conversation-voice-input.jsx";
import "./conversation-page.css";

let activeConversationAudio = null;

const EMOJI_COLLECTION_CATEGORIES = emojiMartData.categories
  .map((category) => String(category?.id || "").trim())
  .filter(Boolean);
const APPLE_EMOJI_SHEET_COLUMNS = Number(emojiMartData.sheet?.cols) || 61;
const APPLE_EMOJI_SHEET_ROWS = Number(emojiMartData.sheet?.rows) || 61;
const APPLE_EMOJI_BY_NATIVE = new Map(
  Object.values(emojiMartData.emojis || {}).flatMap((emoji) => (Array.isArray(emoji?.skins) ? emoji.skins : [])
    .filter((skin) => String(skin?.native || ""))
    .map((skin) => [skin.native, { ...skin, name: emoji?.name }])),
);
const EMOJI_GRAPHEME_SEGMENTER = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;
const MARKDOWN_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const CONTACT_APPROVAL_MODE_OPTIONS = Object.freeze([
  { label: "全权限", value: "danger-full-access" },
  { label: "工作目录可写", value: "workspace-write" },
  { label: "只读", value: "read-only" },
]);
const CONVERSATION_COMPOSER_DEFAULT_HEIGHT = 168;
const CONVERSATION_COMPOSER_MIN_HEIGHT = 168;
const CONVERSATION_COMPOSER_MAX_HEIGHT = 420;
const CONVERSATION_ROSTER_DEFAULT_WIDTH = 246;
const CONVERSATION_ROSTER_MIN_WIDTH = 192;
const CONVERSATION_ROSTER_MAX_WIDTH = 340;
const CONVERSATION_ROSTER_FIXED_VIEWPORT = 940;
const CONVERSATION_ROSTER_NARROW_WIDTH = 210;
const CONVERSATION_SCROLLBAR_IDLE_MS = 1_800;

function clampConversationRosterWidth(value) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return CONVERSATION_ROSTER_DEFAULT_WIDTH;
  return Math.min(Math.max(numeric, CONVERSATION_ROSTER_MIN_WIDTH), CONVERSATION_ROSTER_MAX_WIDTH);
}

function clampConversationComposerHeight(value) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return CONVERSATION_COMPOSER_DEFAULT_HEIGHT;
  return Math.min(Math.max(numeric, CONVERSATION_COMPOSER_MIN_HEIGHT), CONVERSATION_COMPOSER_MAX_HEIGHT);
}

function conversationScrollbarGeometry(list, rail) {
  const clientHeight = Math.max(0, Number(list?.clientHeight) || 0);
  const scrollHeight = Math.max(clientHeight, Number(list?.scrollHeight) || 0);
  const railHeight = Math.max(0, Number(rail?.clientHeight) || clientHeight);
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  if (clientHeight <= 0 || railHeight <= 0 || maxScrollTop <= 1) {
    return { scrollable: false, thumbHeight: 0, thumbTop: 0, maxScrollTop: 0, maxThumbTop: 0 };
  }
  const thumbHeight = Math.min(railHeight, Math.max(32, Math.round((clientHeight / scrollHeight) * railHeight)));
  const maxThumbTop = Math.max(0, railHeight - thumbHeight);
  const scrollTop = Math.min(Math.max(0, Number(list.scrollTop) || 0), maxScrollTop);
  return {
    scrollable: true,
    thumbHeight,
    thumbTop: maxThumbTop ? Math.round((scrollTop / maxScrollTop) * maxThumbTop) : 0,
    maxScrollTop,
    maxThumbTop,
  };
}

function viewportUsesFixedConversationRoster() {
  return typeof window !== "undefined" && window.innerWidth <= CONVERSATION_ROSTER_FIXED_VIEWPORT;
}

function textGraphemes(value) {
  const text = String(value || "");
  if (!text) return [];
  return EMOJI_GRAPHEME_SEGMENTER
    ? Array.from(EMOJI_GRAPHEME_SEGMENTER.segment(text), ({ segment }) => segment)
    : Array.from(text);
}

function appleEmojiSpriteStyle(skin) {
  const x = Number(skin?.x);
  const y = Number(skin?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    backgroundImage: `url(${appleEmojiSpritesheet})`,
    backgroundPosition: `${(100 / (APPLE_EMOJI_SHEET_COLUMNS - 1)) * x}% ${(100 / (APPLE_EMOJI_SHEET_ROWS - 1)) * y}%`,
    backgroundSize: `${APPLE_EMOJI_SHEET_COLUMNS * 100}% ${APPLE_EMOJI_SHEET_ROWS * 100}%`,
  };
}

function ConversationInlineText({ text }) {
  return (
    <>
      {textGraphemes(text).map((segment, index) => {
        const emoji = APPLE_EMOJI_BY_NATIVE.get(segment);
        const style = appleEmojiSpriteStyle(emoji);
        if (!emoji || !style) return <Fragment key={`text-${index}`}>{segment}</Fragment>;
        return <span aria-label={emoji.name || segment} className="conversation-inline-emoji" key={`emoji-${index}`} role="img" style={style} />;
      })}
    </>
  );
}

function ConversationText({ text }) {
  return (
    <div className="conversation-text">
      <ConversationInlineText text={text} />
    </div>
  );
}

function markdownExternalUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return MARKDOWN_EXTERNAL_PROTOCOLS.has(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function ConversationMarkdown({ onOpenExternal, text }) {
  const components = {
    a: ({ children, href, node: _node, ...props }) => {
      const url = markdownExternalUrl(href);
      if (!url) return <span>{children}</span>;
      return (
        <a
          {...props}
          href={url}
          onClick={(event) => {
            event.preventDefault();
            void onOpenExternal?.(url);
          }}
        >{children}</a>
      );
    },
    table: ({ children, node: _node, ...props }) => (
      <div className="conversation-markdown__table-scroll">
        <table {...props}>{children}</table>
      </div>
    ),
  };
  return (
    <div className="conversation-markdown">
      <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>{String(text || "")}</ReactMarkdown>
    </div>
  );
}

function ConversationRenderedText({ onOpenExternal, text }) {
  if (!hasMarkdownFormatting(text)) return <ConversationText text={text} />;
  return <ConversationMarkdown onOpenExternal={onOpenExternal} text={text} />;
}

function clipboardFileIsImage(file, fallbackMimeType = "") {
  const mimeType = String(file?.type || fallbackMimeType || "").trim().toLowerCase();
  return mimeType.startsWith("image/") || /\.(?:gif|jpe?g|png|webp)$/iu.test(String(file?.name || "").trim());
}

function clipboardImageFiles(clipboardData) {
  const fromItems = Array.from(clipboardData?.items || []).flatMap((item) => {
    if (item?.kind !== "file" || typeof item.getAsFile !== "function") return [];
    const file = item.getAsFile();
    return file && clipboardFileIsImage(file, item?.type) ? [file] : [];
  });
  if (fromItems.length) return fromItems;
  return Array.from(clipboardData?.files || []).filter((file) => clipboardFileIsImage(file));
}

function unreadBadgeLabel(value) {
  const count = Number.isSafeInteger(value) && value > 0 ? value : 1;
  return count > 99 ? "99+" : String(count);
}

function unreadContactSummary(contacts) {
  const unreadContacts = (Array.isArray(contacts) ? contacts : []).filter((contact) => contact?.unread);
  if (!unreadContacts.length) return null;
  const visibleNames = unreadContacts
    .map((contact) => String(contact?.name || "").trim())
    .filter(Boolean)
    .slice(0, 2);
  const names = visibleNames.join("、") || "联系人";
  const more = unreadContacts.length > visibleNames.length ? `等 ${unreadContacts.length} 位` : "";
  const label = unreadContacts.length === 1
    ? `${names}有 ${unreadBadgeLabel(unreadContacts[0]?.unreadCount)} 条未读`
    : `${names}${more}有未读`;
  const title = unreadContacts
    .map((contact) => `${String(contact?.name || "").trim() || "联系人"} ${unreadBadgeLabel(contact?.unreadCount)} 条`)
    .join("；");
  return { label, title: `未读消息：${title}` };
}

function ConversationUnreadIndicator({ contacts }) {
  const summary = unreadContactSummary(contacts);
  if (!summary) return null;
  return (
    <span className="conversation-pane__unread-summary" title={summary.title}>
      <i aria-hidden="true" />
      <span className="conversation-pane__unread-summary-copy">{summary.label}</span>
    </span>
  );
}

function PersonAvatar({ avatar, fallback = "" }) {
  if (avatar?.src) return <img alt="" src={avatar.src} />;
  return <span>{avatar?.initial || fallback}</span>;
}

function ConversationIcon({ name }) {
  const common = { "aria-hidden": true, fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeWidth: "1.9", viewBox: "0 0 24 24" };
  if (name === "more") {
    return <svg {...common}><circle cx="5" cy="12" fill="currentColor" r="1.35" stroke="none" /><circle cx="12" cy="12" fill="currentColor" r="1.35" stroke="none" /><circle cx="19" cy="12" fill="currentColor" r="1.35" stroke="none" /></svg>;
  }
  if (name === "emoji") {
    return <svg {...common}><circle cx="12" cy="12" r="8.3" /><path d="M8.4 14.2c.9 1.2 2.1 1.8 3.6 1.8s2.7-.6 3.6-1.8M9 9.5h.01M15 9.5h.01" /></svg>;
  }
  if (name === "favorite") {
    return <svg {...common}><path d="M12 20s-7.1-4.4-8.6-8.6C2.2 8.1 4.1 5.5 7.1 5.5c1.8 0 3.5.9 4.9 2.6 1.4-1.7 3.1-2.6 4.9-2.6 3 0 4.9 2.6 3.7 5.9C19.1 15.6 12 20 12 20Z" /></svg>;
  }
  if (name === "plus") {
    return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
  }
  if (name === "folder") {
    return <svg {...common}><path d="M3.5 7.2h6l1.9 2h9.1v8.7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.2Z" /></svg>;
  }
  if (name === "mic") {
    return <svg {...common}><rect height="12" rx="3.5" width="7" x="8.5" y="3" /><path d="M5.8 11.5a6.2 6.2 0 0 0 12.4 0M12 17.7V21M8.5 21h7" /></svg>;
  }
  if (name === "phone") {
    return <svg {...common}><path d="M7.2 3.8 5.4 5.1c-.9.7-1.2 1.9-.7 3 1.8 4.3 5.2 7.7 9.5 9.5 1.1.5 2.3.2 3-.7l1.3-1.8c.6-.8.5-1.9-.3-2.6l-2.2-1.8c-.7-.6-1.8-.6-2.5.1l-1.1 1.1a13.1 13.1 0 0 1-3.8-3.8l1.1-1.1c.7-.7.7-1.8.1-2.5L9.8 4.1c-.7-.8-1.8-.9-2.6-.3Z" /></svg>;
  }
  return <svg {...common}><circle cx="10.8" cy="10.8" r="5.8" /><path d="m15.2 15.2 4.3 4.3" /></svg>;
}

function ConversationRoster({ actions, contacts, hasContactsRoot, rosterEmpty }) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const visibleContacts = normalizedQuery
    ? contacts.filter((contact) => String(contact?.name || "").toLocaleLowerCase("zh-CN").includes(normalizedQuery))
    : contacts;
  const emptyCopy = normalizedQuery ? `没有找到“${query.trim()}”` : rosterEmpty;
  return (
    <aside className="conversation-roster" aria-label="联系人列表">
      <div className="conversation-roster__heading">
        <label className="conversation-roster__search">
          <ConversationIcon name="search" />
          <input aria-label="搜索联系人" autoComplete="off" onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索" type="search" value={query} />
        </label>
        <button aria-label="新建联系人" disabled={!hasContactsRoot} onClick={actions.openContactCreate} title="新建联系人" type="button">＋</button>
      </div>
      {visibleContacts.length ? visibleContacts.map((contact, index) => (
        <button
          aria-label={`${contact.name}${contact.unread ? `，有${unreadBadgeLabel(contact.unreadCount)}条未读消息` : ""}${contact.muted ? "，已开启消息免打扰" : ""}`}
          aria-current={contact.selected ? "page" : undefined}
          className={`conversation-contact${contact.selected ? " active" : ""}`}
          key={`${contact.id || "contact"}-${index}`}
          onClick={() => { void actions.selectContact(contact.id); }}
          onContextMenu={(event) => {
            event.preventDefault();
            actions.openContactContextMenu?.(contact.id, { x: event.clientX, y: event.clientY });
          }}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            actions.openContactContextMenu?.(contact.id, { x: bounds.left + 12, y: bounds.bottom + 6 });
          }}
          type="button"
        >
          <span className="conversation-contact__avatar">
            <PersonAvatar avatar={contact.avatar} fallback={contact.name} />
            {contact.unread ? <span aria-hidden="true" className="conversation-contact__unread-badge">{unreadBadgeLabel(contact.unreadCount)}</span> : null}
          </span>
          <span className="conversation-contact__copy"><strong>{contact.name}</strong></span>
          <span className="conversation-contact__state" title={contact.unread ? "有未读消息" : contact.muted ? "已开启消息免打扰" : contact.selected ? "当前联系人" : "联系人"}>
            {contact.muted ? <span aria-hidden="true" className="conversation-contact__muted-mark">免</span> : null}
          </span>
        </button>
      )) : <div className="conversation-roster__empty">{emptyCopy}</div>}
    </aside>
  );
}

function ContactContextMenu({ actions, menu }) {
  if (!menu) return null;
  const preferredLabel = menu.preferred ? "已设为首选联系人" : "设为首选联系人";
  const pinnedLabel = menu.pinned ? "取消置顶" : "置顶";
  const unreadLabel = menu.unread ? "标为已读" : "标为未读";
  const mutedLabel = menu.muted ? "取消消息免打扰" : "消息免打扰";
  const hiddenLabel = menu.hidden ? "取消隐藏联系人" : "隐藏联系人";
  return <div
    aria-label={`${menu.contactName}的联系人菜单`}
    className="conversation-contact-context-menu"
    onContextMenu={(event) => event.preventDefault()}
    role="menu"
    style={{ left: menu.x, top: menu.y }}
  >
    <button disabled={menu.preferred} onClick={() => { void actions.setPreferredContact?.(menu.contactId); }} role="menuitem" type="button">{preferredLabel}</button>
    <button onClick={() => { void actions.updateContactPresentation?.(menu.contactId, { pinned: !menu.pinned }); }} role="menuitem" type="button">{pinnedLabel}</button>
    <button onClick={() => { void actions.updateContactPresentation?.(menu.contactId, { unreadCount: menu.unread ? 0 : 1 }); }} role="menuitem" type="button">{unreadLabel}</button>
    <button onClick={() => { void actions.updateContactPresentation?.(menu.contactId, { muted: !menu.muted }); }} role="menuitem" type="button">{mutedLabel}</button>
    <button onClick={() => { void actions.updateContactPresentation?.(menu.contactId, { hidden: !menu.hidden }); }} role="menuitem" type="button">{hiddenLabel}</button>
    <button className="conversation-contact-context-menu__danger" onClick={() => { void actions.removeContact?.(menu.contactId); }} role="menuitem" type="button">删除联系人</button>
  </div>;
}

function EmojiMartContent({ mode, onSelect }) {
  const hostRef = useRef(null);
  const onSelectRef = useRef(onSelect);
  const selectionPendingRef = useRef(false);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let selectionTimer = null;

    const picker = new Picker({
      data: emojiMartData,
      getSpritesheetURL: () => appleEmojiSpritesheet,
      i18n: emojiMartI18n,
      onEmojiSelect: (emoji) => {
        const native = String(emoji?.native || "");
        if (!native || selectionPendingRef.current) return;
        selectionPendingRef.current = true;
        selectionTimer = window.setTimeout(() => {
          selectionTimer = null;
          onSelectRef.current?.(native);
        }, 0);
      },
      autoFocus: mode === "search",
      categories: mode === "search" ? [] : EMOJI_COLLECTION_CATEGORIES,
      dynamicWidth: true,
      emojiButtonSize: 42,
      emojiSize: 26,
      maxFrequentRows: 0,
      navPosition: "none",
      previewPosition: "none",
      searchPosition: mode === "search" ? "static" : "none",
      set: "apple",
      theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
    });

    host.replaceChildren(picker);
    return () => {
      if (selectionTimer !== null) window.clearTimeout(selectionTimer);
      picker.remove();
    };
  }, [mode]);

  return <div className="conversation-emoji-mart" ref={hostRef} />;
}

function stickerErrorMessage(error) {
  return String(error?.message || error || "无法完成表情包操作。").trim() || "无法完成表情包操作。";
}

function ConversationEmojiPicker({ actions }) {
  const [tab, setTab] = useState("collection");
  const [stickers, setStickers] = useState([]);
  const [loadingStickers, setLoadingStickers] = useState(true);
  const [addingSticker, setAddingSticker] = useState(false);
  const [sendingStickerId, setSendingStickerId] = useState("");
  const [stickerError, setStickerError] = useState("");

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const snapshot = await actions.loadEmojiStickers?.();
        if (!current || !snapshot || snapshot.status === "unavailable") return;
        if (snapshot.status === "invalid") throw new Error(snapshot.message || "表情包收藏无法读取。");
        setStickers(Array.isArray(snapshot.items) ? snapshot.items : []);
      } catch (error) {
        if (current) setStickerError(stickerErrorMessage(error));
      } finally {
        if (current) setLoadingStickers(false);
      }
    })();
    return () => { current = false; };
  }, []);

  const addSticker = async () => {
    if (addingSticker) return;
    setAddingSticker(true);
    setStickerError("");
    try {
      const snapshot = await actions.addEmojiSticker?.();
      if (!snapshot || snapshot.canceled) return;
      if (snapshot.status === "invalid") throw new Error(snapshot.message || "表情包收藏无法读取。");
      setStickers(Array.isArray(snapshot.items) ? snapshot.items : []);
    } catch (error) {
      setStickerError(stickerErrorMessage(error));
    } finally {
      setAddingSticker(false);
    }
  };

  const sendSticker = async (id) => {
    if (!id || sendingStickerId) return;
    setSendingStickerId(id);
    setStickerError("");
    try {
      await actions.sendEmojiSticker?.(id);
    } catch (error) {
      setStickerError(stickerErrorMessage(error));
    } finally {
      setSendingStickerId("");
    }
  };

  const selectTab = (next) => {
    setStickerError("");
    setTab(next);
  };

  return (
    <section aria-label="表情选择器" className="conversation-emoji-panel conversation-emoji-picker">
      <div className="conversation-emoji-picker__body">
        {tab === "favorites" ? (
          <div aria-label="收藏表情包" className="conversation-sticker-favorites" role="tabpanel">
            <div className="conversation-sticker-favorites__grid">
              <button
                aria-label="添加收藏表情包"
                className="conversation-sticker-favorites__item conversation-sticker-favorites__add"
                disabled={addingSticker}
                onClick={() => { void addSticker(); }}
                title="添加收藏表情包"
                type="button"
              ><ConversationIcon name="plus" /></button>
              {stickers.map((sticker) => (
                <button
                  aria-label={`发送表情包 ${sticker.fileName || "未命名表情包"}`}
                  className="conversation-sticker-favorites__item"
                  disabled={Boolean(sendingStickerId)}
                  key={sticker.id}
                  onClick={() => { void sendSticker(sticker.id); }}
                  title={sticker.fileName || "收藏表情包"}
                  type="button"
                ><img alt="" src={sticker.fileUrl} /></button>
              ))}
            </div>
            {!loadingStickers && !stickers.length ? <p className="conversation-sticker-favorites__empty">收藏的表情包会显示在这里。</p> : null}
            <p className="conversation-sticker-favorites__hint">支持 PNG、JPG、WebP、GIF；发送时会标记为表情包。</p>
          </div>
        ) : <EmojiMartContent mode={tab} onSelect={actions.insertEmoji} />}
      </div>
      {stickerError ? <p className="conversation-emoji-picker__error" role="status">{stickerError}</p> : null}
      <nav aria-label="表情选择器分类" className="conversation-emoji-picker__tabs" role="tablist">
        <button aria-label="搜索表情" aria-selected={tab === "search"} className={tab === "search" ? "is-active" : ""} onClick={() => selectTab("search")} role="tab" title="搜索表情" type="button"><ConversationIcon name="search" /></button>
        <button aria-label="全部表情" aria-selected={tab === "collection"} className={tab === "collection" ? "is-active" : ""} onClick={() => selectTab("collection")} role="tab" title="全部表情" type="button"><ConversationIcon name="emoji" /></button>
        <button aria-label="收藏表情包" aria-selected={tab === "favorites"} className={tab === "favorites" ? "is-active" : ""} onClick={() => selectTab("favorites")} role="tab" title="收藏表情包" type="button"><ConversationIcon name="favorite" /></button>
      </nav>
    </section>
  );
}

function ConversationComposer({ actions, callActive = false, composer, composerHeight, focusRequest = 0, onResizeKeyDown, onResizePointerCancel, onResizePointerDown, onResizePointerMove, onResizePointerUp, voiceInput }) {
  const inputRef = useRef(null);
  const draftMirrorRef = useRef(null);
  const unavailable = Boolean(composer.unavailable);
  const externalDraft = String(composer.draft || "");
  const [draft, setDraft] = useState(() => externalDraft);
  const draftHasAppleEmoji = textGraphemes(draft).some((segment) => APPLE_EMOJI_BY_NATIVE.has(segment));
  const attachments = Array.isArray(composer.attachments) ? composer.attachments : [];
  const submitLabel = composer.sending ? "发送中" : composer.busy ? "加入队列" : "发送";
  const resize = (target = inputRef.current) => {
    if (!target) return;
    const availableHeight = Math.max(78, target.parentElement?.clientHeight || 78);
    target.style.height = "auto";
    target.style.height = `${availableHeight}px`;
  };
  const syncDraftMirrorScroll = (target = inputRef.current) => {
    const mirror = draftMirrorRef.current;
    if (!target || !mirror) return;
    mirror.scrollLeft = target.scrollLeft;
    mirror.scrollTop = target.scrollTop;
  };
  useLayoutEffect(() => {
    setDraft((current) => (current === externalDraft ? current : externalDraft));
  }, [externalDraft]);
  useLayoutEffect(() => {
    resize();
    syncDraftMirrorScroll();
    if (focusRequest) inputRef.current?.focus();
  }, [attachments.length, composerHeight, draft, focusRequest]);
  const submitMessage = () => {
    // The text field intentionally owns a local draft so typing does not
    // re-render the whole conversation. Clear that local copy synchronously
    // when a send is accepted; the outer conversation state restores it if
    // delivery subsequently fails.
    if (unavailable || composer.attachmentPicking || (!draft.trim() && !attachments.length)) return;
    setDraft("");
    actions.submitMessage();
  };
  return (
    <form className={`conversation-composer${attachments.length ? " has-attachments" : ""}`} onSubmit={(event) => { event.preventDefault(); submitMessage(); }}>
      <div aria-label="调整聊天框高度" aria-orientation="horizontal" aria-valuemax={CONVERSATION_COMPOSER_MAX_HEIGHT} aria-valuemin={CONVERSATION_COMPOSER_MIN_HEIGHT} aria-valuenow={composerHeight} className="conversation-composer-resizer" onKeyDown={onResizeKeyDown} onPointerCancel={onResizePointerCancel} onPointerDown={onResizePointerDown} onPointerMove={onResizePointerMove} onPointerUp={onResizePointerUp} role="separator" tabIndex={0} title="拖动调整聊天框高度" />
      <div className={`conversation-composer__surface${attachments.length ? " has-attachments" : ""}`}>
        <div className={`conversation-composer__input-layer${draftHasAppleEmoji ? " has-emoji-mirror" : ""}${unavailable ? " is-unavailable" : ""}`}>
          <textarea
            value={draft}
            disabled={unavailable}
            maxLength={20000}
            onChange={(event) => {
              const nextDraft = event.currentTarget.value;
              setDraft(nextDraft);
              actions.setDraft(nextDraft);
              resize(event.currentTarget);
            }}
            onKeyDown={(event) => {
              if (!shouldSubmitConversationOnEnter(event)) return;
              event.preventDefault();
              submitMessage();
            }}
            onPaste={(event) => {
              const images = clipboardImageFiles(event.clipboardData);
              if (!images.length) return;
              event.preventDefault();
              void actions.pasteComposerImages(images);
            }}
            onScroll={(event) => syncDraftMirrorScroll(event.currentTarget)}
            placeholder="输入消息（Enter 发送；Ctrl+Enter 或 Shift+Enter 换行）"
            ref={inputRef}
            rows={3}
          />
          {draftHasAppleEmoji ? <div aria-hidden="true" className="conversation-composer__draft-mirror" ref={draftMirrorRef}><ConversationText text={draft} /></div> : null}
        </div>
        {!draft && !attachments.length ? <div aria-hidden="true" className="conversation-composer__command-hints">
          <span>/suzu stop 停止</span>
          <span>/suzu queue &lt;内容&gt; 排队</span>
        </div> : null}
        {attachments.length ? <div aria-label="待发送附件" className="conversation-composer__attachments">
          {attachments.map((attachment) => (
            <span className="conversation-composer__attachment" key={attachment.selectionToken} title={attachment.fileName}>
              {attachment.kind === "image" && attachment.fileUrl
                ? <img alt="" src={attachment.fileUrl} />
                : <ConversationIcon name="folder" />}
              <span>{attachment.fileName}</span>
              <button aria-label={`移除 ${attachment.fileName}`} disabled={unavailable} onClick={() => actions.removeComposerAttachment(attachment.selectionToken)} type="button">×</button>
            </span>
          ))}
        </div> : null}
        <div className="conversation-composer__footer">
          <div aria-label="聊天工具" className="conversation-composer__tools">
            <button
              aria-label="表情"
              className={`conversation-composer__tool${composer.emojiOpen ? " is-active" : ""}`}
              disabled={unavailable}
              onClick={actions.toggleEmoji}
              title="表情"
              type="button"
            ><ConversationIcon name="emoji" /></button>
            <button aria-label="添加文件" className="conversation-composer__tool" disabled={unavailable || composer.attachmentPicking} onClick={() => { void actions.selectComposerAttachments("file"); }} title="添加文件" type="button"><ConversationIcon name="folder" /></button>
            <button
              aria-label={voiceInput?.label || "语音输入"}
              aria-pressed={voiceInput?.active === true}
              className={`conversation-composer__tool${voiceInput?.active ? " is-active" : ""}`}
              disabled={(!voiceInput?.active && (unavailable || callActive)) || !voiceInput?.available}
              onClick={() => { void voiceInput?.toggle?.(); }}
              title={callActive && !voiceInput?.active ? "语音通话中，暂时不能使用语音输入" : (voiceInput?.label || "语音输入")}
              type="button"
            ><ConversationIcon name="mic" /></button>
          </div>
          <div className="conversation-composer__submit-area">
            <button className="conversation-send-button" disabled={unavailable || composer.attachmentPicking}>{submitLabel}</button>
          </div>
        </div>
      </div>
      {composer.emojiOpen ? <ConversationEmojiPicker actions={actions} /> : null}
    </form>
  );
}

function ConversationHeader({ actions, snapshot, callControl }) {
  const callLabel = callControl.active ? "正在语音通话" : "开始语音通话";
  return (
    <header className="conversation-pane__header">
      <h1 className="conversation-peer">{snapshot.peer || "未选择联系人"}</h1>
      <div className="conversation-pane__actions">
        <ConversationUnreadIndicator contacts={snapshot.contacts} />
        <button
          aria-label={callControl.active ? "正在与此联系人语音通话，可在下方状态栏挂断" : "开始与此联系人语音通话"}
          aria-pressed={callControl.active}
          className={`conversation-icon-button conversation-icon-button--call${callControl.active ? " is-active" : ""}`}
          disabled={!callControl.available}
          onClick={() => { if (!callControl.active) void callControl.open(); }}
          title={callControl.active ? "语音通话中，可在下方状态栏挂断" : callLabel}
          type="button"
        ><ConversationIcon name="phone" /></button>
        <button
          aria-label="搜索消息"
          className={`conversation-icon-button${snapshot.searchOpen ? " is-active" : ""}`}
          onClick={actions.toggleSearch}
          title="搜索消息"
          type="button"
        ><ConversationIcon name="search" /></button>
        <button
          aria-label="更多聊天选项"
          className={`conversation-icon-button${snapshot.menuOpen ? " is-active" : ""}`}
          onClick={actions.toggleMenu}
          title="更多聊天选项"
          type="button"
        ><ConversationIcon name="more" /></button>
        {snapshot.menuOpen ? (
          <div className="conversation-menu">
            <button onClick={() => { void actions.openSessionSettings(); }} type="button">设置</button>
            <button onClick={actions.refresh} type="button">刷新记录</button>
            {snapshot.focus ? <button onClick={actions.viewCurrentConversation} type="button">返回当前聊天</button> : null}
          </div>
        ) : null}
      </div>
    </header>
  );
}

function readableDuration(audio) {
  const duration = Number(audio?.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function readableProgress(audio, duration = readableDuration(audio)) {
  const currentTime = Math.max(0, Number(audio?.currentTime) || 0);
  return duration ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;
}

function PlayableChatVoice({ fileName, fileUrl }) {
  const audioRef = useRef(null);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(fileUrl ? "" : "音频文件地址缺失");
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    audio?.pause();
    if (audio) audio.currentTime = 0;
    setDuration(0);
    setError(fileUrl ? "" : "音频文件地址缺失");
    setPlaying(false);
    setProgress(0);
    return () => {
      if (activeConversationAudio === audio) activeConversationAudio = null;
      audio?.pause();
    };
  }, [fileUrl]);

  const syncAudio = (audio) => {
    const nextDuration = readableDuration(audio);
    setDuration(nextDuration);
    setProgress(readableProgress(audio, nextDuration));
    setPlaying(Boolean(audio && !audio.paused && !audio.ended));
  };

  const togglePlayback = async (nextPlaying) => {
    const audio = audioRef.current;
    if (!audio || !fileUrl) {
      setError("音频文件地址缺失");
      return;
    }
    if (!nextPlaying) {
      audio.pause();
      return;
    }
    if (activeConversationAudio && activeConversationAudio !== audio && !activeConversationAudio.paused) activeConversationAudio.pause();
    if (audio.ended) audio.currentTime = 0;
    try {
      await audio.play();
      activeConversationAudio = audio;
      setError("");
    } catch {
      setPlaying(false);
      setError("音频无法播放");
    }
  };

  return (
    <div aria-label={fileName} className="conversation-audio">
      <audio
        onDurationChange={(event) => syncAudio(event.currentTarget)}
        onEnded={(event) => syncAudio(event.currentTarget)}
        onError={() => {
          setPlaying(false);
          setError("音频文件无法读取");
        }}
        onLoadedMetadata={(event) => {
          syncAudio(event.currentTarget);
          setError("");
        }}
        onPause={(event) => {
          if (activeConversationAudio === event.currentTarget) activeConversationAudio = null;
          syncAudio(event.currentTarget);
        }}
        onPlay={(event) => {
          activeConversationAudio = event.currentTarget;
          syncAudio(event.currentTarget);
        }}
        onTimeUpdate={(event) => syncAudio(event.currentTarget)}
        preload="metadata"
        ref={audioRef}
        src={fileUrl || undefined}
      />
      <ChatVoice className="conversation-chat-voice" duration={duration} onToggle={togglePlayback} playing={playing} progress={progress} />
      {error ? <span className="conversation-audio__error" role="status">{error}</span> : null}
    </div>
  );
}

function FileContextMenu({ actions, menu }) {
  if (!menu) return null;
  return <div
    aria-label={`${menu.fileName}的文件菜单`}
    className="conversation-file-context-menu"
    onContextMenu={(event) => event.preventDefault()}
    role="menu"
    style={{ left: menu.x, top: menu.y }}
  >
    <button onClick={() => { void actions.copyMediaFile?.(menu); }} role="menuitem" type="button">复制</button>
    <button onClick={() => { void actions.openMediaFile?.(menu); }} role="menuitem" type="button">打开</button>
  </div>;
}

function ConversationFileIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 64 76">
      <path d="M12 2h26l14 14v54a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4Z" fill="currentColor" opacity=".16" />
      <path d="M38 2v14h14" fill="currentColor" opacity=".26" />
      <text fill="currentColor" fontFamily="ui-sans-serif, system-ui, sans-serif" fontSize="29" fontWeight="700" textAnchor="middle" x="31" y="52">?</text>
    </svg>
  );
}

function ConversationMessageBlock({ block, onOpenExternal, onOpenFile, onOpenFileContextMenu, onPreview }) {
  if (block.type === "audio") return <PlayableChatVoice fileName={block.fileName} fileUrl={block.fileUrl} />;
  if (block.type === "text") return <ConversationRenderedText onOpenExternal={onOpenExternal} text={block.text} />;
  if (block.type === "detail") return <details className="conversation-detail"><summary>{block.title}</summary><pre>{block.detail}</pre></details>;
  if (block.type !== "media") return null;
  const preview = block.preview;
  if (block.mediaKind === "sticker") {
    return preview ? (
      <button
        aria-label={`放大查看表情包 ${preview.name}`}
        className="conversation-sticker"
        onClick={() => onPreview(preview)}
        title={preview.name}
        type="button"
      ><img alt="表情包" loading="lazy" src={preview.url} /></button>
    ) : null;
  }
  const clickableFile = block.mediaKind === "file" && onOpenFile;
  if (block.mediaKind === "file") {
    return (
      <section className="conversation-media conversation-media--file">
        <button
          aria-label={clickableFile ? `在文件夹中显示 ${block.fileName}` : `文件 ${block.fileName}`}
          className="conversation-media__file-card"
          disabled={!clickableFile}
          onClick={clickableFile ? () => onOpenFile(block) : undefined}
          onContextMenu={(event) => {
            if (!clickableFile || !onOpenFileContextMenu) return;
            event.preventDefault();
            onOpenFileContextMenu(block, { x: event.clientX, y: event.clientY });
          }}
          onKeyDown={(event) => {
            if (!clickableFile || !onOpenFileContextMenu || (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))) return;
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            onOpenFileContextMenu(block, { x: bounds.left + 12, y: bounds.bottom + 6 });
          }}
          title={clickableFile ? `在文件夹中显示 ${block.fileName}` : undefined}
          type="button"
        >
          <span className="conversation-media__file-copy">
            <strong>{block.fileName}</strong>
            {block.size ? <span>{block.size}</span> : null}
          </span>
          <span className="conversation-media__file-icon"><ConversationFileIcon /></span>
        </button>
      </section>
    );
  }
  if (!preview) return null;
  return (
    <section className={`conversation-media conversation-media--${block.mediaKind}`}>
      <button
        aria-label={`放大查看 ${preview.name}`}
        className="conversation-media__preview"
        onClick={() => onPreview(preview)}
        type="button"
      ><img alt={preview.name} className="conversation-media__image" loading="lazy" src={preview.url} /></button>
    </section>
  );
}

function ConversationUsage({ usage }) {
  if (!usage) return null;
  const items = [usage.model, ...(usage.fields || []).map((field) => `${field.label} ${field.value}`)].filter(Boolean);
  return <div className="conversation-usage">{items.join(" · ")}</div>;
}

function ConversationMessage({ onOpenExternal, onOpenFile, onOpenFileContextMenu, onPreview, row }) {
  const className = [
    "conversation-message",
    row.kind,
    row.entering && "is-entering",
    row.mediaOnly && "is-media-only",
    row.live && "is-live",
    row.focused && "is-focus-target",
  ].filter(Boolean).join(" ");
  return (
    <article
      className={className}
      data-conversation-anchor-id={row.anchorId || undefined}
      data-conversation-line-number={row.lineNumber || undefined}
      data-conversation-message-id={row.sourceMessageId || undefined}
    >
      {row.avatar ? <div className="conversation-avatar"><PersonAvatar avatar={row.avatar} /></div> : null}
      <div className="conversation-bubble">
        {row.blocks.map((block, index) => <ConversationMessageBlock block={block} key={`${block.type}-${block.fileUrl || block.text || block.title || index}-${index}`} onOpenExternal={onOpenExternal} onOpenFile={onOpenFile} onOpenFileContextMenu={onOpenFileContextMenu} onPreview={onPreview} />)}
        <ConversationUsage usage={row.usage} />
        {row.timestamp ? <div className="conversation-meta">{row.timestamp}</div> : null}
      </div>
    </article>
  );
}

export function ConversationMessageList({ onOpenExternal, onOpenFile, onOpenFileContextMenu, onPreview, rows }) {
  if (!rows.length) return null;
  return rows.map((row, index) => {
    const key = row.type === "message"
      ? `${row.type}-${row.anchorId || row.sourceMessageId || row.lineNumber || index}`
      : `${row.type}-${row.sourceMessageId || row.lineNumber || "row"}-${index}`;
    if (row.type === "day") return <div className="conversation-day" key={key}>{row.label}</div>;
    if (row.type === "time") return <div className="conversation-time-divider" key={key}>{row.label}</div>;
    if (row.type === "empty") return <div className="conversation-empty" key={key}>{row.text}</div>;
    return <ConversationMessage key={key} onOpenExternal={onOpenExternal} onOpenFile={onOpenFile} onOpenFileContextMenu={onOpenFileContextMenu} onPreview={onPreview} row={row} />;
  });
}

function ConversationPermissions({ actions, permissions }) {
  if (!permissions.length) return null;
  return (
    <section aria-label="Suzu Agent 权限请求" className="conversation-permissions">
      {permissions.map((permission) => (
        <article className="conversation-permission" key={permission.requestId}>
          <div><strong>Suzu Agent 想使用：{permission.toolName}</strong><pre>{permission.preview}</pre></div>
          <div className="conversation-permission__actions">
            <button onClick={() => { void actions.respondPermission(permission.requestId, "deny"); }} type="button">拒绝</button>
            <button className="primary" onClick={() => { void actions.respondPermission(permission.requestId, "allow"); }} type="button">允许</button>
          </div>
        </article>
      ))}
    </section>
  );
}

function WechatSettingsControls({ actions, contactId, control }) {
  if (!control) return null;
  if (control.type === "open-capability") {
    return <div className="conversation-session-settings__actions"><button className="secondary-button" onClick={actions.openWechatCapability} type="button">打开“连接微信”总开关</button></div>;
  }
  if (control.type === "connection") {
    return <div className="conversation-session-settings__connection-actions"><label className="conversation-session-settings__switch"><input checked={control.enabled} onChange={(event) => { void actions.setWechatContactEnabled(contactId, event.currentTarget.checked); }} type="checkbox" /><span>接收并投递这位联系人</span></label><button className="text-button" onClick={() => { void actions.disconnectWechat(contactId); }} type="button">断开微信</button></div>;
  }
  if (control.type === "pending-qr") {
    return <div className="conversation-session-settings__actions"><button className="secondary-button" onClick={actions.viewWechatQr} type="button">显示二维码</button><button className="text-button" onClick={() => { void actions.startWechat(contactId); }} type="button">重新生成二维码</button></div>;
  }
  return <div className="conversation-session-settings__actions"><button className="secondary-button" onClick={() => { void actions.startWechat(contactId); }} type="button">生成微信二维码</button></div>;
}

function ConversationSessionSettings({ actions, onDisplayPreferenceChange, onTimeDisplayChange, settings }) {
  if (!settings) return null;
  const changeDisplayPreference = typeof onDisplayPreferenceChange === "function" ? onDisplayPreferenceChange : actions.setDisplayPreference;
  const changeTimeDisplay = typeof onTimeDisplayChange === "function" ? onTimeDisplayChange : actions.setTimeDisplay;
  const permissionMode = settings.permissionMode || "danger-full-access";
  return (
    <aside aria-label="当前联系人设置" className={`conversation-session-settings${settings.visible ? "" : " hidden"}`} id="conversationSettings">
      <section className="conversation-session-settings__section conversation-session-settings__identity"><span className="conversation-contact__avatar"><PersonAvatar avatar={settings.contactAvatar} fallback={settings.contactName} /></span><div className="conversation-session-settings__identity-copy"><strong>{settings.contactName}</strong><div className="conversation-session-settings__identity-actions"><button className="conversation-session-settings__identity-action" onClick={() => actions.openContactRename(settings.contactId)} type="button">修改备注</button><label className="conversation-session-settings__identity-action">更换头像<input accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void actions.uploadContactAvatar(file); }} type="file" /></label>{settings.removeContactAvatar ? <button className="conversation-session-settings__identity-action" onClick={() => { void actions.removeContactAvatar(); }} type="button">移除头像</button> : null}</div></div><button aria-label="关闭联系人设置" className="conversation-session-settings__close suzu-close-button" onClick={actions.closeSessionSettings} type="button">×</button></section>
      <details className="conversation-session-settings__section conversation-session-settings__display-options"><summary className="conversation-settings__time-display"><span>聊天显示</span></summary><div className="conversation-session-settings__checks">{settings.preferences.map((preference) => <label key={preference.key}><input checked={preference.checked} onChange={(event) => { void changeDisplayPreference(preference.key, event.currentTarget.checked); }} type="checkbox" />{preference.label}</label>)}</div></details>
      <section className="conversation-session-settings__section conversation-session-settings__single-row"><label className="conversation-settings__time-display"><span>时间显示</span><Select ariaLabel="时间显示方式" className="conversation-settings__select" onChange={(value) => { void changeTimeDisplay(value); }} options={[{ label: "每条气泡内", value: "bubble" }, { label: "画面中心", value: "center" }]} value={settings.timeDisplay} /></label></section>
      <section className="conversation-session-settings__section conversation-session-settings__single-row"><label className="conversation-settings__time-display"><span>审批模式</span><Select ariaLabel="联系人审批模式" className="conversation-settings__select" disabled={Boolean(settings.saving)} onChange={(value) => { void actions.setContactPermissionMode(value); }} options={CONTACT_APPROVAL_MODE_OPTIONS} value={permissionMode} /></label></section>
      <section className="conversation-session-settings__section"><header><div><span>COMPANION</span><h2>主动关心</h2><p>开启后，Suzu 会在软件运行期间结合你们的对话安排后续主动联系；关闭后会停止为这位联系人创建新的主动关心任务。</p></div></header><label className="conversation-session-settings__switch"><input checked={settings.proactiveContactEnabled} disabled={Boolean(settings.saving)} onChange={(event) => { void actions.setProactiveContactEnabled(event.currentTarget.checked); }} type="checkbox" /><span>启用主动关心</span></label></section>
      <section className="conversation-session-settings__section"><header><div><span>MEMORY · CORE</span><h2>长期记忆</h2><p>这个开关控制这位联系人的自动写入和召回；已有记忆会保留。召回内容会作为当前 Agent 请求的动态上下文参与对话，聊天页面显示实际消息。</p></div></header><label className="conversation-session-settings__switch"><input checked={settings.longTermMemoryEnabled} onChange={(event) => { void actions.setLongTermMemoryEnabled(event.currentTarget.checked); }} type="checkbox" /><span>启用长期记忆</span></label></section>
      {settings.hasSession ? (
        <>
          <section className="conversation-session-settings__section"><header><div><span>LOCAL MEDIA</span><h2>本地附件</h2><p>Agent 交付给这位联系人的图片和文件保存在 Suzu 本地缓存中。</p></div></header><div className="conversation-session-settings__actions"><button className="secondary-button" onClick={() => { void actions.openMediaDirectory(settings.contactId); }} type="button">打开文件目录</button></div></section>
          {settings.wechat ? <section className="conversation-session-settings__section conversation-session-settings__wechat"><header><div><span>WECHAT</span><h2>微信连接</h2><p>二维码会在中间弹出。扫码后，请向这个微信机器人发一条文字消息，确认它已进入当前联系人的固定对话；回复默认投递 Agent 的说话内容。</p></div><span className="conversation-session-settings__status">{settings.wechat.status}</span></header><WechatSettingsControls actions={actions} contactId={settings.contactId} control={settings.wechat.control} />{settings.wechat.pendingQrError ? <p className="conversation-session-settings__error">{settings.wechat.pendingQrError}</p> : null}{settings.wechat.connectionError ? <p className="conversation-session-settings__error">{settings.wechat.connectionError}</p> : null}{settings.wechat.hint ? <p className="conversation-session-settings__hint">指令和普通消息与这里一致：/suzu stop、/suzu queue …；普通消息会优先处理。</p> : null}</section> : null}
        </>
      ) : <section className="conversation-session-settings__section"><header><div><span>CONTACT SETTINGS</span><h2>联系人设置</h2><p>当前联系人还没有聊天记录。发送第一条消息后，这里会显示本地附件和微信连接。</p></div></header></section>}
    </aside>
  );
}

function ConversationSearchPanel({ actions, focusRequest = 0, search }) {
  const inputRef = useRef(null);
  const [query, setQuery] = useState(search?.query || "");
  useEffect(() => setQuery(search?.query || ""), [search?.category?.id, search?.query]);
  useLayoutEffect(() => {
    if (focusRequest) inputRef.current?.focus();
  }, [focusRequest]);
  if (!search) return null;
  return (
    <section aria-label="搜索当前聊天" className="conversation-search-panel" id="conversationSearchPanel">
      <header className="conversation-search-panel__header">
        <form className="conversation-search-panel__form" onSubmit={(event) => { event.preventDefault(); actions.runSearch(query); }} role="search"><span aria-hidden="true"><ConversationIcon name="search" /></span><input aria-label={search.placeholder} maxLength={search.inputType === "date" ? undefined : 200} onChange={(event) => { const value = event.currentTarget.value; setQuery(value); actions.setSearchQuery(value, { submitDate: search.inputType === "date" }); }} placeholder={search.placeholder} ref={inputRef} type={search.inputType} value={query} /></form>
        <button className="conversation-search-panel__cancel" onClick={actions.closeSearch} type="button">取消</button>
      </header>
      <div className="conversation-search-panel__body">
        <p className="conversation-search-panel__intro">快速搜索聊天内容</p>
        <div aria-label="搜索分类" className="conversation-search-panel__categories" role="group">{search.categories.map((category) => <button className={`conversation-search-panel__category${category.id === search.category.id ? " is-active" : ""}`} key={category.id} onClick={() => actions.selectSearchCategory(category.id)} type="button"><strong>{category.label}</strong><small>{category.hint}</small></button>)}</div>
        <section aria-live="polite" className="conversation-search-panel__matches"><header><strong>{search.matchesLabel}</strong><span>{search.matchesNote}</span></header><ConversationSearchResults actions={actions} search={search} /></section>
      </div>
    </section>
  );
}

function ConversationSearchResults({ actions, search }) {
  if (search.error) return <div className="conversation-search-panel__empty is-error">{search.error}</div>;
  if (search.empty) return <div className="conversation-search-panel__empty">{search.empty}</div>;
  if (search.images.length) {
    return <div className="conversation-search-panel__image-results">{search.images.map((image) => <button aria-label={`查看图片 ${image.name}`} className="conversation-search-panel__image-result" key={image.key} onClick={() => actions.openMediaPreview(image)} type="button"><img alt={image.name} loading="lazy" src={image.url} /><span>{image.name}</span></button>)}</div>;
  }
  return <div className="conversation-search-panel__results">{search.results.map((result, index) => <button className="conversation-search-panel__result" key={`${result.messageId || "line"}-${result.lineNumber || index}`} onClick={() => { void actions.focusSearchMatch(result); }} type="button"><span>{result.timestamp} · {result.kind}</span><strong>{result.summary}</strong></button>)}</div>;
}

function ContactCreateDialog({ actions, open }) {
  const inputRef = useRef(null);
  const [name, setName] = useState("");
  useEffect(() => {
    if (!open) return;
    setName("");
    inputRef.current?.focus();
  }, [open]);
  if (!open) return null;
  return <div className="conversation-contact-create-overlay" onClick={(event) => { if (event.target === event.currentTarget) actions.closeContactCreate(); }}><form aria-label="新建联系人" className="conversation-contact-create-dialog" onSubmit={(event) => { event.preventDefault(); void actions.createContact(name); }}><header><div><span>NEW CONTACT</span><h2>新建联系人</h2></div><button aria-label="关闭" className="suzu-close-button" onClick={actions.closeContactCreate} type="button">×</button></header><label><span>联系人备注</span><input autoComplete="off" maxLength={80} onChange={(event) => setName(event.currentTarget.value)} placeholder="只在 Suzu 中显示，可与其他联系人重名" ref={inputRef} required value={name} /></label><p>创建后即可开始聊天。</p><footer><button className="text-button" onClick={actions.closeContactCreate} type="button">取消</button><button className="primary-button">创建联系人</button></footer></form></div>;
}

function ContactRenameDialog({ actions, contact }) {
  const inputRef = useRef(null);
  const [name, setName] = useState(contact?.name || "");
  useEffect(() => {
    if (!contact) return;
    setName(contact.name || "");
    inputRef.current?.focus();
  }, [contact?.contactId, contact?.name]);
  if (!contact) return null;
  return <div className="conversation-contact-create-overlay" onClick={(event) => { if (event.target === event.currentTarget && !contact.saving) actions.closeContactRename(); }}><form aria-label="修改联系人备注" className="conversation-contact-create-dialog" id="conversationContactRename" onSubmit={(event) => { event.preventDefault(); void actions.renameContact(contact.contactId, name); }}><header><div><span>CONTACT REMARK</span><h2>修改联系人备注</h2></div><button aria-label="关闭修改联系人备注" className="suzu-close-button" disabled={contact.saving} onClick={actions.closeContactRename} type="button">×</button></header><label><span>联系人备注</span><input autoComplete="off" disabled={contact.saving} maxLength={80} onChange={(event) => setName(event.currentTarget.value)} placeholder="只在 Suzu 中显示，可与其他联系人重名" ref={inputRef} required value={name} /></label><p>聊天记录和关联设置仍按联系人 ID 保持不变。</p><footer><button className="text-button" disabled={contact.saving} onClick={actions.closeContactRename} type="button">取消</button><button className="primary-button" disabled={contact.saving}>{contact.saving ? "保存中…" : "保存备注"}</button></footer></form></div>;
}

function WechatQrDialog({ actions, qr }) {
  if (!qr) return null;
  return <div className="conversation-wechat-qr-overlay" onClick={(event) => { if (event.target === event.currentTarget) actions.closeWechatQr(); }}><section aria-labelledby="conversationWechatQrTitle" aria-modal="true" className="conversation-wechat-qr-dialog" id="conversationWechatQr" role="dialog"><header><div><span>WECHAT · 当前联系人</span><h2 id="conversationWechatQrTitle">连接「{qr.title}」</h2></div><button aria-label="关闭二维码" className="suzu-close-button" onClick={actions.closeWechatQr} type="button">×</button></header><img alt="用于连接当前联系人的微信二维码" src={qr.imageDataUrl} /><p className="conversation-wechat-qr-dialog__status">{qr.status}</p><p className="conversation-wechat-qr-dialog__instruction"><strong>扫码后，请在微信里向这个机器人发送一条文字消息。</strong><span>这条消息会作为“我”进入这位联系人的固定 Suzu 对话，用来确认连接正确。</span></p><button className="secondary-button" onClick={actions.closeWechatQr} type="button">我知道了</button></section></div>;
}

function MediaPreviewDialog({ actions, preview }) {
  if (!preview) return null;
  return <div className="conversation-media-preview-overlay" onClick={(event) => { if (event.target === event.currentTarget) actions.closeMediaPreview(); }}><section aria-labelledby="conversationMediaPreviewTitle" aria-modal="true" className="conversation-media-preview-dialog" id="conversationMediaPreview" role="dialog"><header><div><strong id="conversationMediaPreviewTitle">{preview.imageName}</strong><span>{preview.index + 1} / {preview.total}</span></div><button aria-label="关闭图片预览" className="suzu-close-button" onClick={actions.closeMediaPreview} type="button">×</button></header><div className="conversation-media-preview-dialog__stage"><button className="conversation-media-preview-dialog__nav" disabled={preview.previousDisabled} onClick={actions.previousMediaPreview} type="button">上一张</button><img alt={preview.imageName} src={preview.imageUrl} /><button className="conversation-media-preview-dialog__nav" disabled={preview.nextDisabled} onClick={actions.nextMediaPreview} type="button">下一张</button></div><footer><button className="text-button" onClick={() => { void actions.jumpFromMediaPreview({ lineNumber: preview.lineNumber, messageId: preview.messageId }); }} type="button">跳转到图片所在位置</button></footer></section></div>;
}

function AvatarCropDialog({ actions, crop }) {
  const dragRef = useRef(null);
  const imageRef = useRef(null);
  const stageRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [workingCrop, setWorkingCrop] = useState(crop);
  useEffect(() => setWorkingCrop(crop), [crop?.source]);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const measure = () => {
      const bounds = stage.getBoundingClientRect();
      const next = actions.resizeAvatarCrop(bounds.width, bounds.height);
      if (next) setWorkingCrop(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [actions, crop?.source]);
  if (!crop) return null;
  const active = workingCrop || crop;
  const { layout } = active;
  const endDrag = (event) => {
    const drag = dragRef.current;
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    try { stageRef.current?.releasePointerCapture(drag.pointerId); } catch { /* A released pointer needs no further work. */ }
    dragRef.current = null;
    setDragging(false);
  };
  return <div className="conversation-avatar-crop-overlay" onClick={(event) => { if (event.target === event.currentTarget) actions.closeAvatarCrop(); }}><section aria-labelledby="conversationAvatarCropTitle" aria-modal="true" className="conversation-avatar-crop-dialog" id="conversationAvatarCrop" role="dialog"><header><div><span>CONTACT AVATAR</span><h2 id="conversationAvatarCropTitle">裁剪头像</h2></div><button aria-label="取消裁剪" className="suzu-close-button" onClick={actions.closeAvatarCrop} type="button">×</button></header><p>拖动图片调整位置；方框内的正方形区域会作为头像保存。</p><div aria-label="头像裁剪区域" className={`conversation-avatar-crop-dialog__stage${dragging ? " is-dragging" : ""}`} onPointerCancel={endDrag} onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); setDragging(true); }} onPointerMove={(event) => { const drag = dragRef.current; if (!drag || drag.pointerId !== event.pointerId) return; const next = actions.moveAvatarCrop(event.clientX - drag.x, event.clientY - drag.y); dragRef.current = { ...drag, x: event.clientX, y: event.clientY }; if (next) setWorkingCrop(next); }} onPointerUp={endDrag} ref={stageRef}><img alt="正在裁剪的联系人头像" draggable="false" ref={imageRef} src={active.source} style={{ height: `${layout.displayHeight}px`, transform: `translate(${layout.offsetX}px, ${layout.offsetY}px)`, width: `${layout.displayWidth}px` }} /><span aria-hidden="true" className="conversation-avatar-crop-dialog__frame" /></div><label className="conversation-avatar-crop-dialog__zoom"><span>缩放</span><input max={active.maxZoom} min={active.minZoom} onChange={(event) => { const next = actions.setAvatarCropZoom(event.currentTarget.value); if (next) setWorkingCrop(next); }} step="0.01" type="range" value={layout.zoom} /><output>{active.zoom}%</output></label><footer><button className="text-button" onClick={actions.closeAvatarCrop} type="button">取消</button><button className="primary-button" onClick={() => { void actions.confirmAvatarCrop(imageRef.current); }} type="button">确认使用</button></footer></section></div>;
}

function ConversationCallBar({ call, onEnd }) {
  if (!call) return null;
  const status = call.error || call.status;
  const statusPhase = call.error ? "error" : call.phase;
  return <section aria-label={`与${call.contactName}的语音通话`} className="conversation-call-bar"><div className="conversation-call-bar__identity"><span className="conversation-call-bar__avatar"><PersonAvatar avatar={call.avatar} fallback={call.contactName} /></span><div><strong>{call.contactName}</strong><span aria-live="polite" className={`conversation-call-bar__status is-${statusPhase}`}><i aria-hidden="true" />{status}</span></div></div><button aria-label="挂断语音通话" className="conversation-call-bar__hangup" disabled={call.ending} onClick={() => { void onEnd(); }} type="button"><ConversationIcon name="phone" /><span>{call.ending ? "正在挂断" : "挂断"}</span></button></section>;
}

function ConversationCallDialing({ call, onEnd }) {
  if (!call?.dialing || call.initiator === "agent") return null;
  const status = "正在呼叫";
  const detail = "等待对方接听";
  return <section aria-label={`${status}${call.contactName}`} className="conversation-call-dialing" onClick={(event) => event.stopPropagation()}><div className="conversation-call-dialing__screen"><div className="conversation-call-dialing__content"><span className="conversation-call-dialing__avatar"><PersonAvatar avatar={call.avatar} fallback={call.contactName} /></span><strong>{call.contactName}</strong><span aria-live="polite" className="conversation-call-dialing__status">{status}<span aria-hidden="true" className="conversation-call-dialing__dots">…</span></span><p>{detail}</p></div><button aria-label="取消语音通话" className="conversation-call-dialing__hangup" disabled={call.ending} onClick={() => { void onEnd(); }} type="button"><ConversationIcon name="phone" /><span>{call.ending ? "正在挂断" : "挂断"}</span></button></div></section>;
}

function ConversationOverlays({ actions, overlays }) {
  const active = overlays || {};
  return <>
    <ContactCreateDialog actions={actions} open={active.contactCreate} />
    <ContactRenameDialog actions={actions} contact={active.contactRename} />
    <WechatQrDialog actions={actions} qr={active.wechatQr} />
    <MediaPreviewDialog actions={actions} preview={active.mediaPreview} />
    <AvatarCropDialog actions={actions} crop={active.avatarCrop} />
  </>;
}

export function ConversationPage({ actions, api = null, incomingCall = null, snapshot = {} }) {
  const callControl = useConversationCall();
  const acceptedIncomingCall = useRef("");
  const incomingCallDialingSeen = useRef("");
  const listRef = useRef(null);
  const workspaceRef = useRef(null);
  const chatShellRef = useRef(null);
  const conversationScrollbarRailRef = useRef(null);
  const conversationScrollbarDragRef = useRef(null);
  const composerResizeRef = useRef(null);
  const rosterResizeRef = useRef(null);
  const latestScrollRequest = useRef(0);
  const scrollTargetRequest = useRef(0);
  const viewportAnchorRef = useRef(null);
  const conversationScrollbarIdleTimer = useRef(null);
  const [rosterWidth, setRosterWidth] = useState(() => clampConversationRosterWidth(snapshot.rosterWidth));
  const [rosterResizing, setRosterResizing] = useState(false);
  const [fixedRosterViewport, setFixedRosterViewport] = useState(viewportUsesFixedConversationRoster);
  const [composerHeight, setComposerHeight] = useState(() => clampConversationComposerHeight(snapshot.composerHeight));
  const [composerResizing, setComposerResizing] = useState(false);
  const [conversationScrollbarVisible, setConversationScrollbarVisible] = useState(false);
  const [conversationScrollbar, setConversationScrollbar] = useState(() => ({
    scrollable: false,
    thumbHeight: 0,
    thumbTop: 0,
    maxScrollTop: 0,
    maxThumbTop: 0,
  }));
  const composerHeightRef = useRef(composerHeight);
  const rosterWidthRef = useRef(rosterWidth);
  const contacts = Array.isArray(snapshot.contacts) ? snapshot.contacts : [];
  const activeContactId = String(contacts.find((contact) => contact?.selected)?.id || "").trim();
  const composer = snapshot.composer || {};
  const messageRows = Array.isArray(snapshot.messageRows) ? snapshot.messageRows : [];
  const permissions = Array.isArray(snapshot.permissions) ? snapshot.permissions : [];
  const ui = snapshot.ui || {};
  const contactContextMenu = snapshot.contactContextMenu || null;
  const fileContextMenu = snapshot.fileContextMenu || null;
  const openExternalLink = useCallback((url) => {
    if (typeof api?.settings?.openExternal !== "function") return;
    return api.settings.openExternal(url).catch(() => undefined);
  }, [api]);
  const updateConversationScrollbar = useCallback((list = listRef.current) => {
    const next = conversationScrollbarGeometry(list, conversationScrollbarRailRef.current);
    setConversationScrollbar((current) => (
      current.scrollable === next.scrollable
      && current.thumbHeight === next.thumbHeight
      && current.thumbTop === next.thumbTop
      && current.maxScrollTop === next.maxScrollTop
      && current.maxThumbTop === next.maxThumbTop
        ? current
        : next
    ));
    return next;
  }, []);
  const revealConversationScrollbar = useCallback(() => {
    if (conversationScrollbarIdleTimer.current !== null) {
      window.clearTimeout(conversationScrollbarIdleTimer.current);
    }
    setConversationScrollbarVisible(true);
    const hideWhenIdle = () => {
      conversationScrollbarIdleTimer.current = null;
      if (conversationScrollbarDragRef.current) {
        conversationScrollbarIdleTimer.current = window.setTimeout(hideWhenIdle, CONVERSATION_SCROLLBAR_IDLE_MS);
        return;
      }
      setConversationScrollbarVisible(false);
    };
    conversationScrollbarIdleTimer.current = window.setTimeout(hideWhenIdle, CONVERSATION_SCROLLBAR_IDLE_MS);
  }, []);
  useEffect(() => () => {
    if (conversationScrollbarIdleTimer.current !== null) {
      window.clearTimeout(conversationScrollbarIdleTimer.current);
    }
  }, []);
  const moveConversationScrollbar = useCallback((clientY, rail = conversationScrollbarRailRef.current) => {
    const list = listRef.current;
    if (!list || !rail) return;
    const geometry = conversationScrollbarGeometry(list, rail);
    if (!geometry.scrollable) return;
    const rect = rail.getBoundingClientRect();
    const thumbTop = Math.min(
      geometry.maxThumbTop,
      Math.max(0, clientY - rect.top - (geometry.thumbHeight / 2)),
    );
    list.scrollTop = geometry.maxThumbTop
      ? (thumbTop / geometry.maxThumbTop) * geometry.maxScrollTop
      : 0;
    updateConversationScrollbar(list);
  }, [updateConversationScrollbar]);
  const beginConversationScrollbarDrag = (event) => {
    if (event.button !== 0) return;
    const geometry = updateConversationScrollbar();
    if (!geometry.scrollable) return;
    event.preventDefault();
    conversationScrollbarDragRef.current = { pointerId: event.pointerId, rail: event.currentTarget };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    moveConversationScrollbar(event.clientY, event.currentTarget);
    revealConversationScrollbar();
  };
  const dragConversationScrollbar = (event) => {
    const drag = conversationScrollbarDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    moveConversationScrollbar(event.clientY, drag.rail);
    revealConversationScrollbar();
  };
  const finishConversationScrollbarDrag = (event) => {
    const drag = conversationScrollbarDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    conversationScrollbarDragRef.current = null;
    if (event.currentTarget?.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    revealConversationScrollbar();
  };
  const captureViewportAnchor = useCallback(() => {
    const anchor = captureConversationViewportAnchor(listRef.current);
    viewportAnchorRef.current = anchor ? { ...anchor, contactId: activeContactId } : null;
  }, [activeContactId]);
  const setDisplayPreferenceWithAnchor = useCallback((key, checked) => {
    captureViewportAnchor();
    return actions.setDisplayPreference(key, checked);
  }, [actions, captureViewportAnchor]);
  const setTimeDisplayWithAnchor = useCallback((value) => {
    captureViewportAnchor();
    return actions.setTimeDisplay(value);
  }, [actions, captureViewportAnchor]);
  const voiceInput = useConversationVoiceInput({
    active: Boolean(activeContactId),
    api,
    onError: actions.reportVoiceInputError,
    onStart: actions.clearVoiceInputError,
    onTranscript: actions.appendVoiceInputTranscript,
    scopeKey: activeContactId,
  });
  useEffect(() => {
    const updateFixedRosterViewport = () => setFixedRosterViewport(viewportUsesFixedConversationRoster());
    updateFixedRosterViewport();
    window.addEventListener("resize", updateFixedRosterViewport);
    return () => window.removeEventListener("resize", updateFixedRosterViewport);
  }, []);
  useEffect(() => {
    if (rosterResizeRef.current) return;
    const nextWidth = clampConversationRosterWidth(snapshot.rosterWidth);
    rosterWidthRef.current = nextWidth;
    setRosterWidth(nextWidth);
  }, [snapshot.rosterWidth]);
  useEffect(() => {
    if (composerResizeRef.current) return;
    const nextHeight = clampConversationComposerHeight(snapshot.composerHeight);
    composerHeightRef.current = nextHeight;
    setComposerHeight(nextHeight);
  }, [snapshot.composerHeight]);
  useLayoutEffect(() => {
    updateConversationScrollbar();
  }, [messageRows, updateConversationScrollbar]);
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(() => updateConversationScrollbar(list));
    observer.observe(list);
    return () => observer.disconnect();
  }, [updateConversationScrollbar]);
  const applyRosterWidth = (value) => {
    const nextWidth = clampConversationRosterWidth(value);
    rosterWidthRef.current = nextWidth;
    setRosterWidth(nextWidth);
    return nextWidth;
  };
  const rosterWidthFromPointer = (clientX) => {
    const workspaceLeft = workspaceRef.current?.getBoundingClientRect?.().left || 0;
    return clampConversationRosterWidth(clientX - workspaceLeft);
  };
  const finishRosterResize = (event, { save = true, useCurrentWidth = false } = {}) => {
    const activeResize = rosterResizeRef.current;
    if (!activeResize || activeResize.pointerId !== event.pointerId) return;
    const nextWidth = !useCurrentWidth && Number.isFinite(event.clientX)
      ? rosterWidthFromPointer(event.clientX)
      : rosterWidthRef.current;
    rosterResizeRef.current = null;
    rosterWidthRef.current = nextWidth;
    setRosterWidth(nextWidth);
    setRosterResizing(false);
    if (event.currentTarget?.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (save) void actions.setConversationRosterWidth?.(nextWidth);
  };
  const beginRosterResize = (event) => {
    if (event.button !== 0 || fixedRosterViewport) return;
    event.preventDefault();
    rosterResizeRef.current = { pointerId: event.pointerId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setRosterResizing(true);
    applyRosterWidth(rosterWidthFromPointer(event.clientX));
  };
  const resizeRoster = (event) => {
    if (rosterResizeRef.current?.pointerId !== event.pointerId) return;
    applyRosterWidth(rosterWidthFromPointer(event.clientX));
  };
  const cancelRosterResize = (event) => {
    if (rosterResizeRef.current?.pointerId !== event.pointerId) return;
    finishRosterResize(event, { save: false, useCurrentWidth: true });
  };
  const resizeRosterFromKeyboard = (event) => {
    if (fixedRosterViewport) return;
    let nextWidth = null;
    if (event.key === "ArrowLeft") nextWidth = clampConversationRosterWidth(rosterWidthRef.current - 16);
    if (event.key === "ArrowRight") nextWidth = clampConversationRosterWidth(rosterWidthRef.current + 16);
    if (event.key === "Home") nextWidth = CONVERSATION_ROSTER_MIN_WIDTH;
    if (event.key === "End") nextWidth = CONVERSATION_ROSTER_MAX_WIDTH;
    if (nextWidth === null) return;
    event.preventDefault();
    rosterWidthRef.current = nextWidth;
    setRosterWidth(nextWidth);
    void actions.setConversationRosterWidth?.(nextWidth);
  };
  const applyComposerHeight = (value) => {
    const nextHeight = clampConversationComposerHeight(value);
    composerHeightRef.current = nextHeight;
    setComposerHeight(nextHeight);
    return nextHeight;
  };
  const composerHeightFromPointer = (clientY) => {
    const chatBottom = chatShellRef.current?.getBoundingClientRect?.().bottom || 0;
    return clampConversationComposerHeight(chatBottom - clientY);
  };
  const finishComposerResize = (event, { save = true, useCurrentHeight = false } = {}) => {
    const activeResize = composerResizeRef.current;
    if (!activeResize || activeResize.pointerId !== event.pointerId) return;
    const nextHeight = !useCurrentHeight && Number.isFinite(event.clientY)
      ? composerHeightFromPointer(event.clientY)
      : composerHeightRef.current;
    composerResizeRef.current = null;
    composerHeightRef.current = nextHeight;
    setComposerHeight(nextHeight);
    setComposerResizing(false);
    if (event.currentTarget?.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (save) void actions.setConversationComposerHeight?.(nextHeight);
  };
  const beginComposerResize = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    composerResizeRef.current = { pointerId: event.pointerId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setComposerResizing(true);
    applyComposerHeight(composerHeightFromPointer(event.clientY));
  };
  const resizeComposer = (event) => {
    if (composerResizeRef.current?.pointerId !== event.pointerId) return;
    applyComposerHeight(composerHeightFromPointer(event.clientY));
  };
  const cancelComposerResize = (event) => {
    if (composerResizeRef.current?.pointerId !== event.pointerId) return;
    finishComposerResize(event, { save: false, useCurrentHeight: true });
  };
  const resizeComposerFromKeyboard = (event) => {
    let nextHeight = null;
    if (event.key === "ArrowUp") nextHeight = clampConversationComposerHeight(composerHeightRef.current + 16);
    if (event.key === "ArrowDown") nextHeight = clampConversationComposerHeight(composerHeightRef.current - 16);
    if (event.key === "Home") nextHeight = CONVERSATION_COMPOSER_MIN_HEIGHT;
    if (event.key === "End") nextHeight = CONVERSATION_COMPOSER_MAX_HEIGHT;
    if (nextHeight === null) return;
    event.preventDefault();
    composerHeightRef.current = nextHeight;
    setComposerHeight(nextHeight);
    void actions.setConversationComposerHeight?.(nextHeight);
  };
  useEffect(() => {
    const requestId = String(incomingCall?.requestId || "").trim();
    const contactId = String(incomingCall?.contactId || "").trim();
    if (!requestId || acceptedIncomingCall.current === requestId || !contactId || contactId !== activeContactId) return;
    if (!callControl.available || callControl.active) return;
    acceptedIncomingCall.current = requestId;
    void Promise.resolve().then(async () => {
      const opened = await callControl.open({ initiator: "agent" });
      if (!opened) actions.consumeIncomingVoiceCall?.(requestId);
    });
  }, [actions, activeContactId, callControl.active, callControl.available, callControl.open, incomingCall?.contactId, incomingCall?.requestId]);
  useEffect(() => {
    const requestId = String(incomingCall?.requestId || "").trim();
    const call = callControl.call;
    if (!requestId) return;
    if (call?.initiator === "agent" && call.dialing) {
      incomingCallDialingSeen.current = requestId;
      return;
    }
    if (incomingCallDialingSeen.current !== requestId) return;
    void Promise.resolve().then(() => actions.consumeIncomingVoiceCall?.(requestId));
  }, [actions, callControl.call, incomingCall?.requestId]);
  useEffect(() => {
    if (!contactContextMenu && !fileContextMenu) return undefined;
    const close = (event) => {
      if (event.target?.closest?.(".conversation-contact-context-menu, .conversation-file-context-menu")) return;
      actions.closeContactContextMenu?.();
      actions.closeFileContextMenu?.();
    };
    const closeOnResize = () => {
      actions.closeContactContextMenu?.();
      actions.closeFileContextMenu?.();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", closeOnResize);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [actions, contactContextMenu, fileContextMenu]);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const request = Number(ui.scrollToLatestRequest) || 0;
    if (request && request !== latestScrollRequest.current) {
      latestScrollRequest.current = request;
      viewportAnchorRef.current = null;
      list.scrollTop = list.scrollHeight;
      return;
    }
    const anchor = viewportAnchorRef.current;
    viewportAnchorRef.current = null;
    if (anchor && (!anchor.contactId || anchor.contactId === activeContactId) && restoreConversationViewportAnchor(list, anchor)) return;
    const top = Number(ui.listScrollTop);
    if (Number.isFinite(top)) list.scrollTop = top;
  }, [activeContactId, messageRows, ui.listScrollTop, ui.scrollToLatestRequest]);
  useLayoutEffect(() => {
    const target = ui.scrollTarget;
    const request = Number(target?.request) || 0;
    const list = listRef.current;
    if (!list || !request || request === scrollTargetRequest.current) return;
    scrollTargetRequest.current = request;
    const candidates = [...list.querySelectorAll("[data-conversation-message-id], [data-conversation-line-number]")];
    const item = candidates.find((node) => target.lineNumber && Number(node.dataset.conversationLineNumber) === Number(target.lineNumber))
      || candidates.find((node) => target.messageId && node.dataset.conversationMessageId === target.messageId);
    if (!item) return;
    item.scrollIntoView({ block: "center", behavior: "smooth" });
    item.classList.add("is-jump-target");
    const timer = window.setTimeout(() => item.classList.remove("is-jump-target"), 1800);
    return () => window.clearTimeout(timer);
  }, [messageRows, ui.scrollTarget]);
  const dismissOnEscape = (event) => {
    if (event.key !== "Escape" || !actions.dismissOverlays()) return;
    event.preventDefault();
  };
  const dismissOnWorkspaceClick = (event) => {
    const interactive = event.target.closest?.(".conversation-pane__actions, .conversation-menu, .conversation-session-settings, .conversation-search-panel, .conversation-composer, .conversation-composer-resizer, .conversation-roster, .conversation-roster-resizer, .conversation-contact-context-menu, .conversation-file-context-menu, .conversation-permissions, .conversation-media__preview, .conversation-contact-create-dialog, .conversation-wechat-qr-dialog, .conversation-media-preview-dialog, .conversation-avatar-crop-dialog");
    if (!interactive) actions.dismissOverlays();
  };
  return (
    <section aria-label="对话" className={`conversation-workspace${rosterResizing ? " is-resizing-roster" : ""}${composerResizing ? " is-resizing-composer" : ""}`} onClick={dismissOnWorkspaceClick} onKeyDown={dismissOnEscape} ref={workspaceRef} style={{ "--conversation-composer-height": `${composerHeight}px`, "--conversation-roster-width": `${fixedRosterViewport ? CONVERSATION_ROSTER_NARROW_WIDTH : rosterWidth}px` }}>
      <ConversationRoster actions={actions} contacts={contacts} hasContactsRoot={snapshot.hasContactsRoot} rosterEmpty={snapshot.rosterEmpty} />
      <div aria-label="调整联系人栏宽度" aria-orientation="vertical" aria-valuemax={CONVERSATION_ROSTER_MAX_WIDTH} aria-valuemin={CONVERSATION_ROSTER_MIN_WIDTH} aria-valuenow={fixedRosterViewport ? CONVERSATION_ROSTER_NARROW_WIDTH : rosterWidth} className="conversation-roster-resizer" onKeyDown={resizeRosterFromKeyboard} onPointerCancel={cancelRosterResize} onPointerDown={beginRosterResize} onPointerMove={resizeRoster} onPointerUp={finishRosterResize} role="separator" tabIndex={fixedRosterViewport ? -1 : 0} title="拖动调整联系人栏宽度" />
      <ContactContextMenu actions={actions} menu={contactContextMenu} />
      <FileContextMenu actions={actions} menu={fileContextMenu} />
      <section className={`conversation-pane${callControl.call ? " has-active-call" : ""}`}>
        <ConversationHeader actions={actions} callControl={callControl} snapshot={snapshot} />
        <ConversationCallBar call={callControl.call} onEnd={callControl.end} />
        <ConversationSessionSettings actions={actions} onDisplayPreferenceChange={setDisplayPreferenceWithAnchor} onTimeDisplayChange={setTimeDisplayWithAnchor} settings={snapshot.sessionSettings} />
        {snapshot.error || callControl.startError ? <div className="conversation-error">{snapshot.error || callControl.startError}</div> : null}
        {snapshot.notice ? <div className="conversation-notice">{snapshot.notice}</div> : null}
        {snapshot.focus ? <div className="conversation-focus-banner"><span>已定位到搜索结果附近的聊天记录</span><button onClick={actions.viewCurrentConversation} type="button">回到最新消息</button></div> : null}
        <div className="conversation-chat-shell" ref={chatShellRef}>
          <ConversationPermissions actions={actions} permissions={permissions} />
          <div className="conversation-transcript">
            <div aria-label={snapshot.listLabel || "Suzu 的聊天记录"} aria-live="polite" className="conversation-list" data-conversation-list="" onPointerDown={revealConversationScrollbar} onScroll={(event) => { actions.setListScroll(event.currentTarget); updateConversationScrollbar(event.currentTarget); revealConversationScrollbar(); }} onWheel={revealConversationScrollbar} ref={listRef} role="log"><ConversationMessageList onOpenExternal={openExternalLink} onOpenFile={actions.openMediaFile} onOpenFileContextMenu={actions.openFileContextMenu} onPreview={actions.openMediaPreview} rows={messageRows} /></div>
            <div aria-hidden="true" className={`conversation-scrollbar${conversationScrollbarVisible && conversationScrollbar.scrollable ? " is-visible" : ""}`} onPointerCancel={finishConversationScrollbarDrag} onPointerDown={beginConversationScrollbarDrag} onPointerMove={dragConversationScrollbar} onPointerUp={finishConversationScrollbarDrag} ref={conversationScrollbarRailRef}>
              <div className="conversation-scrollbar__thumb" style={{ height: `${conversationScrollbar.thumbHeight}px`, transform: `translateY(${conversationScrollbar.thumbTop}px)` }} />
            </div>
          </div>
          {snapshot.unread ? <button className="conversation-latest" onClick={actions.jumpToLatest} type="button">回到最新消息</button> : null}
          <ConversationComposer actions={actions} callActive={callControl.active} composer={composer} composerHeight={composerHeight} focusRequest={ui.composerFocusRequest} onResizeKeyDown={resizeComposerFromKeyboard} onResizePointerCancel={cancelComposerResize} onResizePointerDown={beginComposerResize} onResizePointerMove={resizeComposer} onResizePointerUp={finishComposerResize} voiceInput={voiceInput} />
        </div>
        <ConversationSearchPanel actions={actions} focusRequest={ui.searchFocusRequest} search={snapshot.search} />
        <ConversationCallDialing call={callControl.call} onEnd={callControl.end} />
      </section>
      <ConversationOverlays actions={actions} overlays={snapshot.overlays} />
    </section>
  );
}
