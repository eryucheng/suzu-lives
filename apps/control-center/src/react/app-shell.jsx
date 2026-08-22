import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Avatar, Button, Dialog, Input, SideNav, SideNavItem } from "suzu-design-system";
import { ApplicationRouter } from "./app-router.jsx";
import { ConversationCallProvider } from "./conversation-call.jsx";
import { OnboardingDialog } from "./onboarding-dialog.jsx";
import { SoftwareAssistantDialog } from "./software-assistant-dialog.jsx";

let latestWorkspace = null;
let latestNotice = "";
let updateWorkspace = null;
let updateNotice = null;

export function renderAppWorkspace(workspace = null) {
  latestWorkspace = workspace;
  latestNotice = String(workspace?.notice || "");
  if (!updateWorkspace || !updateNotice) return;
  flushSync(() => {
    updateWorkspace(latestWorkspace);
    updateNotice(latestNotice);
  });
}

export function setGlobalNotice(message = "") {
  latestNotice = String(message || "");
  if (!updateNotice) return;
  flushSync(() => updateNotice(latestNotice));
}

const PRIMARY_NAVIGATION = [
  { view: "today", label: "今天", icon: "spark" },
  { view: "conversation", label: "对话", icon: "chat" },
  { view: "relationships", label: "关系", icon: "people" },
  { view: "capabilities", label: "能力", icon: "sliders" },
  { view: "plans", label: "计划", icon: "calendar" },
  { view: "create", label: "创造", icon: "palette" },
];

const UTILITY_NAVIGATION = [
  { view: "admin", label: "管理", icon: "sliders" },
  { view: "settings", label: "设置", icon: "gear" },
];

const SIDEBAR_COMPACT_WIDTH = 70;
const SIDEBAR_DEFAULT_WIDTH = 240;
const SIDEBAR_MIN_EXPANDED_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 360;
const SIDEBAR_COLLAPSE_THRESHOLD = 144;
const SIDEBAR_COMPACT_VIEWPORT = 1180;

function clampSidebarWidth(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(Math.max(Math.round(numeric), SIDEBAR_COMPACT_WIDTH), SIDEBAR_MAX_WIDTH);
}

function snapSidebarWidth(value) {
  const width = clampSidebarWidth(value);
  if (width <= SIDEBAR_COLLAPSE_THRESHOLD) return SIDEBAR_COMPACT_WIDTH;
  return Math.max(width, SIDEBAR_MIN_EXPANDED_WIDTH);
}

function viewportUsesCompactSidebar() {
  return typeof window !== "undefined" && window.innerWidth <= SIDEBAR_COMPACT_VIEWPORT;
}

function ShellIcon({ name }) {
  const paths = useMemo(() => ({
    spark: <><path d="m12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4Z" /><path d="m19 16 .6 2.4L22 19l-2.4.6L19 22l-.6-2.4L16 19l2.4-.6Z" /></>,
    chat: <><path d="M20 15.5a3.5 3.5 0 0 1-3.5 3.5H10l-4.5 3v-3.3A3.5 3.5 0 0 1 3 15.5v-8A3.5 3.5 0 0 1 6.5 4h10A3.5 3.5 0 0 1 20 7.5Z" /><path d="M7.5 10h8M7.5 13h5" /></>,
    people: <><path d="M16 20v-1.6a4.1 4.1 0 0 0-4.1-4.1H7.1A4.1 4.1 0 0 0 3 18.4V20" /><circle cx="9.5" cy="7.1" r="3.1" /><path d="M17.1 4.3a3.1 3.1 0 0 1 0 5.9" /><path d="M21 20v-1.6a4.1 4.1 0 0 0-2.8-3.9" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /><path d="M8 14h3M8 17h5" /></>,
    palette: <><path d="M12 3a9 9 0 1 0 0 18h1.3a1.7 1.7 0 0 0 0-3.4h-.8a1.6 1.6 0 0 1 0-3.2h2.2A6.3 6.3 0 0 0 21 8.1 5.1 5.1 0 0 0 16 3Z" /><circle cx="7.7" cy="10" r=".8" /><circle cx="10.5" cy="6.8" r=".8" /><circle cx="15" cy="7.3" r=".8" /></>,
    sliders: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="7" cy="18" r="2" /></>,
    gear: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.1 2.1-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.2h-3v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-2.1-2.1.1-.1A1.7 1.7 0 0 0 7 15a1.7 1.7 0 0 0-1.5-1H5.3v-3h.2A1.7 1.7 0 0 0 7 10a1.7 1.7 0 0 0-.3-1.9l-.1-.1 2.1-2.1.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5v-.2h3v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 2.1 2.1-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.2v3h-.2a1.7 1.7 0 0 0-1.4 1Z" /></>,
    search: <><circle cx="10.8" cy="10.8" r="5.8" /><path d="m15.2 15.2 4.1 4.1" /></>,
  }), []);
  return <svg className="shell-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name] || null}</svg>;
}

function Navigation({ items, activeView, conversationUnread = false, onNavigate, className }) {
  return (
    <SideNav className={className}>
      {items.map((item) => (
        <SideNavItem
          key={item.view}
          active={activeView === item.view}
          className={`shell-nav-item${item.view === "conversation" && conversationUnread ? " shell-nav-item--unread" : ""}`}
          icon={<ShellIcon name={item.icon} />}
          onClick={() => onNavigate(item.view)}
        >
          {item.label}
        </SideNavItem>
      ))}
    </SideNav>
  );
}

function GlobalNotice({ message = "" }) {
  return <div aria-live="polite" className={`notice${message ? "" : " hidden"}`} id="notice" role="status">{message}</div>;
}

function IncomingConversationNotice({ notice = null }) {
  if (!notice?.preview) return null;
  return (
    <aside aria-atomic="true" aria-live="polite" className="incoming-conversation-notice" role="status">
      <img alt="" className="incoming-conversation-notice__icon" src="./app-icon.png" />
      <div className="incoming-conversation-notice__copy">
        <div className="incoming-conversation-notice__meta"><strong>Suzu Lives</strong><time>刚刚</time></div>
        <strong className="incoming-conversation-notice__sender">{notice.senderName || "Suzu"}</strong>
        <p>{notice.preview}</p>
      </div>
    </aside>
  );
}

function IncomingVoiceCall({ call = null, onAnswer, onDecline }) {
  if (!call?.requestId) return null;
  const senderName = String(call.senderName || "Suzu").trim() || "Suzu";
  const reason = String(call.reason || "").trim();
  const answering = call.phase === "answering";
  return (
    <aside aria-label={`${senderName} 的语音来电`} className="incoming-voice-call" role="dialog">
      <div className="incoming-voice-call__content">
        <span className="incoming-voice-call__eyebrow">VOICE CALL</span>
        <Avatar className="incoming-voice-call__avatar" name={senderName} size="lg" src={call.avatar || undefined} />
        <strong>{senderName}</strong>
        <p>{answering ? "正在接听来电" : "正在呼叫你"}</p>
        {reason ? <small>{reason}</small> : null}
      </div>
      {answering ? <div aria-live="polite" className="incoming-voice-call__answering">正在连接语音通话<span aria-hidden="true">…</span></div> : <div aria-label="来电操作" className="incoming-voice-call__actions" role="group">
        <button aria-label={`拒绝 ${senderName} 的来电`} className="incoming-voice-call__action incoming-voice-call__action--decline" onClick={() => onDecline?.(call.requestId)} type="button">
          <span aria-hidden="true">☎</span><b>拒绝</b>
        </button>
        <button aria-label={`接听 ${senderName} 的来电`} className="incoming-voice-call__action incoming-voice-call__action--answer" onClick={() => onAnswer?.(call.requestId)} type="button">
          <span aria-hidden="true">☎</span><b>接听</b>
        </button>
      </div>}
    </aside>
  );
}

function ReleaseAnnouncementDialog({ announcement = null, onAcknowledge, open = false }) {
  const release = announcement?.announcement;
  if (!open || !release) return null;
  const version = String(release.version || announcement?.version || "").trim();
  const items = Array.isArray(release.items) ? release.items.filter(Boolean) : [];
  const acknowledge = () => { void onAcknowledge?.(); };
  return (
    <Dialog
      footer={<Button onClick={acknowledge} type="button">知道了</Button>}
      onClose={acknowledge}
      open
      surface="glass"
      title={release.title || "Suzu Lives 已更新"}
    >
      <div className="release-announcement">
        <span className="release-announcement__version">UPDATE{version ? ` · v${version}` : ""}</span>
        {release.summary ? <p>{release.summary}</p> : null}
        {items.length ? <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul> : null}
      </div>
    </Dialog>
  );
}

const WINDOW_CONTROL_GLYPH = {
  close: "\uE8BB",
  maximize: "\uE922",
  minimize: "\uE921",
  restore: "\uE923",
};

function WindowControls() {
  const chrome = globalThis.suzuConsole?.windowChrome;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!chrome?.customControls) return undefined;
    let active = true;
    const sync = (state) => {
      if (active && typeof state?.maximized === "boolean") setMaximized(state.maximized);
    };
    void chrome.state().then(sync).catch(() => undefined);
    const unsubscribe = chrome.onState?.(sync);
    return () => {
      active = false;
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [chrome]);

  if (!chrome?.customControls) return null;
  const control = (action) => {
    void chrome.control(action).then((state) => {
      if (typeof state?.maximized === "boolean") setMaximized(state.maximized);
    }).catch(() => undefined);
  };

  return (
    <div aria-label="窗口控制" className="shell-window-controls" role="group">
      <button aria-label="最小化" className="shell-window-control" onClick={() => control("minimize")} title="最小化" type="button">
        <span aria-hidden="true">{WINDOW_CONTROL_GLYPH.minimize}</span>
      </button>
      <button aria-label={maximized ? "还原窗口" : "最大化"} className="shell-window-control" onClick={() => control("toggle-maximize")} title={maximized ? "还原窗口" : "最大化"} type="button">
        <span aria-hidden="true">{maximized ? WINDOW_CONTROL_GLYPH.restore : WINDOW_CONTROL_GLYPH.maximize}</span>
      </button>
      <button aria-label="关闭窗口" className="shell-window-control shell-window-control--close" onClick={() => control("close")} title="关闭窗口" type="button">
        <span aria-hidden="true">{WINDOW_CONTROL_GLYPH.close}</span>
      </button>
    </div>
  );
}

export function AppShell() {
  const [workspace, setWorkspace] = useState(() => latestWorkspace);
  const [notice, setNotice] = useState(() => latestNotice);
  const [softwareAssistantOpen, setSoftwareAssistantOpen] = useState(false);
  const [softwareAssistantPrompt, setSoftwareAssistantPrompt] = useState("");
  const [softwareAssistantDraft, setSoftwareAssistantDraft] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(() => snapSidebarWidth(latestWorkspace?.shellSidebarWidth));
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [compactSidebarViewport, setCompactSidebarViewport] = useState(viewportUsesCompactSidebar);
  const [sidebarViewportOverride, setSidebarViewportOverride] = useState(false);
  const shellRef = useRef(null);
  const sidebarResizeRef = useRef(null);
  const compactSidebarViewportRef = useRef(compactSidebarViewport);
  const sidebarWidthRef = useRef(sidebarWidth);

  useLayoutEffect(() => {
    updateWorkspace = setWorkspace;
    updateNotice = setNotice;
    return () => {
      if (updateWorkspace === setWorkspace) updateWorkspace = null;
      if (updateNotice === setNotice) updateNotice = null;
    };
  }, []);

  const activeView = workspace?.route?.kind === "conversation"
    ? "conversation"
    : String(workspace?.activeView || "relationships");
  const navigate = (view) => {
    if (view === "conversation") {
      workspace?.actions?.openSuzuSearchItem?.("conversation");
      return;
    }
    workspace?.actions?.navigate?.(view);
  };
  const conversationProps = workspace?.route?.kind === "conversation" ? workspace.route.props : null;
  const conversationUnread = workspace?.conversationUnread === true;
  const openSoftwareAssistant = (prompt = "") => {
    const value = String(prompt || "").trim();
    if (value) setSoftwareAssistantPrompt(value);
    setSoftwareAssistantOpen(true);
  };

  useEffect(() => {
    const openAssistant = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      openSoftwareAssistant();
    };
    window.addEventListener("keydown", openAssistant);
    return () => window.removeEventListener("keydown", openAssistant);
  }, []);

  useEffect(() => {
    const updateCompactViewport = () => {
      const nextCompact = viewportUsesCompactSidebar();
      if (compactSidebarViewportRef.current === nextCompact) return;
      compactSidebarViewportRef.current = nextCompact;
      setCompactSidebarViewport(nextCompact);
      // Entering or leaving the responsive layout starts a new viewport
      // state. A person can still drag it open again while it is narrow.
      setSidebarViewportOverride(false);
    };
    updateCompactViewport();
    window.addEventListener("resize", updateCompactViewport);
    return () => window.removeEventListener("resize", updateCompactViewport);
  }, []);

  useEffect(() => {
    if (sidebarResizeRef.current) return;
    const nextWidth = snapSidebarWidth(workspace?.shellSidebarWidth);
    sidebarWidthRef.current = nextWidth;
    setSidebarWidth(nextWidth);
  }, [workspace?.shellSidebarWidth]);

  const applySidebarWidth = (value) => {
    const nextWidth = clampSidebarWidth(value);
    sidebarWidthRef.current = nextWidth;
    setSidebarWidth(nextWidth);
    return nextWidth;
  };

  const sidebarWidthFromPointer = (clientX, { snap = false } = {}) => {
    const shellLeft = shellRef.current?.getBoundingClientRect?.().left || 0;
    const width = clientX - shellLeft;
    return snap ? snapSidebarWidth(width) : clampSidebarWidth(width);
  };

  const saveSidebarWidth = (width) => {
    void workspace?.actions?.setShellSidebarWidth?.(width);
  };

  const finishSidebarResize = (event, { save = true, useCurrentWidth = false } = {}) => {
    const activeResize = sidebarResizeRef.current;
    if (!activeResize || activeResize.pointerId !== event.pointerId) return;
    const nextWidth = activeResize.moved && !useCurrentWidth && Number.isFinite(event.clientX)
      ? sidebarWidthFromPointer(event.clientX, { snap: true })
      : snapSidebarWidth(sidebarWidthRef.current);
    sidebarResizeRef.current = null;
    sidebarWidthRef.current = nextWidth;
    setSidebarWidth(nextWidth);
    setSidebarResizing(false);
    if (event.currentTarget?.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (save) saveSidebarWidth(nextWidth);
  };

  const beginSidebarResize = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    sidebarResizeRef.current = {
      autoCompact: compactSidebarViewport && !sidebarViewportOverride,
      moved: false,
      pointerId: event.pointerId,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setSidebarResizing(true);
  };

  const resizeSidebar = (event) => {
    const activeResize = sidebarResizeRef.current;
    if (activeResize?.pointerId !== event.pointerId) return;
    if (!activeResize.moved) {
      activeResize.moved = true;
      if (activeResize.autoCompact) setSidebarViewportOverride(true);
    }
    applySidebarWidth(sidebarWidthFromPointer(event.clientX));
  };

  const cancelSidebarResize = (event) => {
    if (sidebarResizeRef.current?.pointerId !== event.pointerId) return;
    finishSidebarResize(event, { save: false, useCurrentWidth: true });
  };

  const resizeSidebarFromKeyboard = (event) => {
    const sidebarAutoCompact = compactSidebarViewport && !sidebarViewportOverride;
    const currentWidth = sidebarAutoCompact ? SIDEBAR_COMPACT_WIDTH : sidebarWidthRef.current;
    let nextWidth = null;
    if (event.key === "ArrowLeft") {
      const candidate = currentWidth - 24;
      nextWidth = candidate < SIDEBAR_MIN_EXPANDED_WIDTH
        ? SIDEBAR_COMPACT_WIDTH
        : snapSidebarWidth(candidate);
    }
    if (event.key === "ArrowRight") nextWidth = currentWidth === SIDEBAR_COMPACT_WIDTH
      ? SIDEBAR_MIN_EXPANDED_WIDTH
      : snapSidebarWidth(currentWidth + 24);
    if (event.key === "Home") nextWidth = SIDEBAR_COMPACT_WIDTH;
    if (event.key === "End") nextWidth = SIDEBAR_MAX_WIDTH;
    if (nextWidth === null) return;
    event.preventDefault();
    if (nextWidth >= SIDEBAR_MIN_EXPANDED_WIDTH) setSidebarViewportOverride(true);
    sidebarWidthRef.current = nextWidth;
    setSidebarWidth(nextWidth);
    saveSidebarWidth(nextWidth);
  };

  const sidebarAutoCompact = compactSidebarViewport && !sidebarViewportOverride;
  const effectiveSidebarWidth = sidebarAutoCompact ? SIDEBAR_COMPACT_WIDTH : sidebarWidth;
  const sidebarIsCompact = effectiveSidebarWidth < SIDEBAR_MIN_EXPANDED_WIDTH;
  const shellStyle = {
    "--shell-command-center-offset": `${-(effectiveSidebarWidth / 2)}px`,
    "--shell-main-center-offset": `${effectiveSidebarWidth / 2}px`,
    "--shell-sidebar-width": `${effectiveSidebarWidth}px`,
  };

  return (
    <div className="desktop-shell">
      <div
        className={`app-shell${sidebarResizing ? " is-resizing-sidebar" : ""}`}
        data-sidebar-compact={sidebarIsCompact ? "true" : "false"}
        ref={shellRef}
        style={shellStyle}
      >
        <aside className="shell-sidebar" aria-label="主导航">
          <div className="shell-brand">
            <Avatar className="shell-brand-avatar" name="Suzu Lives" size="lg" src="./app-icon.png" />
            <div className="shell-brand-copy">
              <div className="shell-brand-name">Suzu Lives</div>
            </div>
          </div>
          <Navigation items={PRIMARY_NAVIGATION} activeView={activeView} conversationUnread={conversationUnread} onNavigate={navigate} className="shell-primary-nav" />
          <div className="shell-sidebar-spacer" />
          <Navigation items={UTILITY_NAVIGATION} activeView={activeView} onNavigate={navigate} className="shell-utility-nav" />
        </aside>
        <div
          aria-label="调整侧边栏宽度"
          aria-orientation="vertical"
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuemin={SIDEBAR_COMPACT_WIDTH}
          aria-valuenow={effectiveSidebarWidth}
          className="shell-sidebar-resizer"
          onKeyDown={resizeSidebarFromKeyboard}
          onPointerCancel={cancelSidebarResize}
          onPointerDown={beginSidebarResize}
          onPointerMove={resizeSidebar}
          onPointerUp={finishSidebarResize}
          role="separator"
          tabIndex={0}
          title="拖动调整侧边栏宽度"
        />

        <main className="main shell-main">
          <header className="topbar shell-topbar">
            <WindowControls />
            <div className="shell-topbar-edge" aria-hidden="true" />
            <div className="shell-command-slot">
              <form className="shell-command-form" onSubmit={(event) => {
                event.preventDefault();
                const prompt = softwareAssistantDraft.trim();
                if (!prompt) {
                  openSoftwareAssistant();
                  return;
                }
                setSoftwareAssistantDraft("");
                openSoftwareAssistant(prompt);
              }}>
                <Input
                  aria-controls="suzu-software-assistant-dialog"
                  aria-expanded={softwareAssistantOpen}
                  aria-haspopup="dialog"
                  aria-label="问 Suzu"
                  className="shell-command"
                  maxLength={12000}
                  onChange={(event) => setSoftwareAssistantDraft(event.currentTarget.value)}
                  placeholder="问 Suzu：想做什么？"
                  prefix={<ShellIcon name="search" />}
                  size="sm"
                  style={{ width: "min(620px, 100%)" }}
                  suffix={<kbd className="shell-command-key">Ctrl K</kbd>}
                  value={softwareAssistantDraft}
                />
              </form>
            </div>
            <div className="shell-topbar-edge" aria-hidden="true" />
          </header>

          <IncomingConversationNotice notice={workspace?.incomingConversationNotice} />
          <IncomingVoiceCall call={workspace?.incomingVoiceCall} onAnswer={workspace?.actions?.answerIncomingVoiceCall} onDecline={workspace?.actions?.declineIncomingVoiceCall} />
          <ReleaseAnnouncementDialog announcement={workspace?.releaseAnnouncement} onAcknowledge={workspace?.actions?.acknowledgeReleaseAnnouncement} open={workspace?.releaseAnnouncementOpen === true} />
          <GlobalNotice message={notice} />
          <section className={`content page-workspace${workspace?.contentClassName ? ` ${workspace.contentClassName}` : ""}`} id="content" aria-live="polite">
            <ConversationCallProvider active={Boolean(conversationProps)} api={conversationProps?.api} snapshot={conversationProps?.snapshot}>
              <ApplicationRouter workspace={workspace} />
            </ConversationCallProvider>
          </section>
          <div aria-hidden="true" className="shell-bottombar" />
          <SoftwareAssistantDialog
            api={globalThis.suzuConsole?.softwareAssistant}
            initialPrompt={softwareAssistantPrompt}
            onClose={() => setSoftwareAssistantOpen(false)}
            onPromptConsumed={() => setSoftwareAssistantPrompt("")}
            open={softwareAssistantOpen}
            owner={workspace?.owner}
          />
          <OnboardingDialog onboarding={workspace?.onboarding} />
        </main>
      </div>
    </div>
  );
}
