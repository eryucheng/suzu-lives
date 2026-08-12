import { useLayoutEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { Avatar, Input, SideNav, SideNavItem } from "suzu-design-system";
import { ApplicationRouter } from "./app-router.jsx";
import { ConversationCallProvider } from "./conversation-call.jsx";

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
  { view: "relationships", label: "关系", icon: "people" },
  { view: "plans", label: "计划", icon: "calendar" },
  { view: "create", label: "创造", icon: "palette" },
  { view: "capabilities", label: "能力", icon: "sliders" },
];

const UTILITY_NAVIGATION = [
  { view: "admin", label: "管理", icon: "sliders" },
  { view: "settings", label: "设置", icon: "gear" },
];

function ShellIcon({ name }) {
  const paths = useMemo(() => ({
    spark: <><path d="m12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4Z" /><path d="m19 16 .6 2.4L22 19l-2.4.6L19 22l-.6-2.4L16 19l2.4-.6Z" /></>,
    people: <><path d="M16 20v-1.6a4.1 4.1 0 0 0-4.1-4.1H7.1A4.1 4.1 0 0 0 3 18.4V20" /><circle cx="9.5" cy="7.1" r="3.1" /><path d="M17.1 4.3a3.1 3.1 0 0 1 0 5.9" /><path d="M21 20v-1.6a4.1 4.1 0 0 0-2.8-3.9" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /><path d="M8 14h3M8 17h5" /></>,
    palette: <><path d="M12 3a9 9 0 1 0 0 18h1.3a1.7 1.7 0 0 0 0-3.4h-.8a1.6 1.6 0 0 1 0-3.2h2.2A6.3 6.3 0 0 0 21 8.1 5.1 5.1 0 0 0 16 3Z" /><circle cx="7.7" cy="10" r=".8" /><circle cx="10.5" cy="6.8" r=".8" /><circle cx="15" cy="7.3" r=".8" /></>,
    sliders: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="7" cy="18" r="2" /></>,
    gear: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.1 2.1-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.2h-3v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-2.1-2.1.1-.1A1.7 1.7 0 0 0 7 15a1.7 1.7 0 0 0-1.5-1H5.3v-3h.2A1.7 1.7 0 0 0 7 10a1.7 1.7 0 0 0-.3-1.9l-.1-.1 2.1-2.1.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5v-.2h3v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 2.1 2.1-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.2v3h-.2a1.7 1.7 0 0 0-1.4 1Z" /></>,
    search: <><circle cx="10.8" cy="10.8" r="5.8" /><path d="m15.2 15.2 4.1 4.1" /></>,
  }), []);
  return <svg className="shell-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name] || null}</svg>;
}

function Navigation({ items, activeView, onNavigate, className }) {
  return (
    <SideNav className={className}>
      {items.map((item) => (
        <SideNavItem
          key={item.view}
          active={activeView === item.view}
          className="shell-nav-item"
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

export function AppShell() {
  const [workspace, setWorkspace] = useState(() => latestWorkspace);
  const [notice, setNotice] = useState(() => latestNotice);

  useLayoutEffect(() => {
    updateWorkspace = setWorkspace;
    updateNotice = setNotice;
    return () => {
      if (updateWorkspace === setWorkspace) updateWorkspace = null;
      if (updateNotice === setNotice) updateNotice = null;
    };
  }, []);

  const activeView = String(workspace?.activeView || "today");
  const navigate = (view) => workspace?.actions?.navigate?.(view);
  const conversationProps = workspace?.route?.kind === "conversation" ? workspace.route.props : null;

  return (
    <div className="desktop-shell">
      <div className="app-shell">
        <aside className="shell-sidebar" aria-label="主导航">
          <div className="shell-brand">
            <Avatar className="shell-brand-avatar" name="Suzu Lives" size="lg" src="./app-icon.png" />
            <div className="shell-brand-copy">
              <div className="shell-brand-name">Suzu Lives</div>
              <div className="shell-brand-subtitle">A life with agents</div>
            </div>
          </div>
          <Navigation items={PRIMARY_NAVIGATION} activeView={activeView} onNavigate={navigate} className="shell-primary-nav" />
          <div className="shell-sidebar-spacer" />
          <Navigation items={UTILITY_NAVIGATION} activeView={activeView} onNavigate={navigate} className="shell-utility-nav" />
        </aside>

        <main className="main shell-main">
          <header className="topbar shell-topbar">
            <div className="shell-topbar-edge" aria-hidden="true" />
            <div className="shell-command-slot">
              <Input
                aria-label="问 Suzu 或搜索"
                className="shell-command"
                placeholder="问 Suzu 或搜索"
                prefix={<ShellIcon name="search" />}
                readOnly
                size="lg"
                style={{ width: "min(620px, 100%)" }}
                suffix={<kbd className="shell-command-key">Ctrl K</kbd>}
              />
            </div>
            <div className="shell-topbar-edge" aria-hidden="true" />
          </header>

          <GlobalNotice message={notice} />
          <section className={`content${workspace?.contentClassName ? ` ${workspace.contentClassName}` : ""}`} id="content" aria-live="polite">
            <ConversationCallProvider active={Boolean(conversationProps)} api={conversationProps?.api} snapshot={conversationProps?.snapshot}>
              <ApplicationRouter workspace={workspace} />
            </ConversationCallProvider>
          </section>
        </main>
      </div>
    </div>
  );
}
