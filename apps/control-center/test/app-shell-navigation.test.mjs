import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));

test("the primary shell navigation exposes the current conversation directly below today", () => {
  const shell = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.jsx"), "utf8");
  const primaryNavigation = shell.slice(shell.indexOf("const PRIMARY_NAVIGATION"), shell.indexOf("const UTILITY_NAVIGATION"));

  assert.match(primaryNavigation, /view: "today"[\s\S]*?view: "conversation"[\s\S]*?view: "relationships"[\s\S]*?view: "capabilities"[\s\S]*?view: "plans"[\s\S]*?view: "create"/u);
  assert.match(shell, /view === "conversation"[\s\S]*?openSuzuSearchItem\?\.\("conversation"\)/u);
  assert.match(shell, /route\?\.kind === "conversation"[\s\S]*?\? "conversation"/u);
  assert.match(shell, /item\.view === "conversation" && conversationUnread/u);
});

test("the desktop shell defaults its navigation rail to compact on narrow windows without locking manual expansion", () => {
  const styles = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.css"), "utf8");
  const shell = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.jsx"), "utf8");
  const compactRail = styles.slice(styles.indexOf("@media (max-width:1180px)"), styles.indexOf("@media (max-width:820px)"));

  assert.doesNotMatch(compactRail, /grid-template-columns:70px minmax\(0,1fr\)/u);
  assert.doesNotMatch(compactRail, /\.shell-sidebar-resizer\s*\{\s*display:none;/u);
  assert.match(styles, /transition:grid-template-columns \.26s cubic-bezier\(\.22,\.72,\.2,1\)/u);
  assert.match(styles, /data-sidebar-compact="true"/u);
  assert.match(shell, /const \[sidebarViewportOverride, setSidebarViewportOverride\] = useState\(false\);/u);
  assert.match(shell, /const sidebarAutoCompact = compactSidebarViewport && !sidebarViewportOverride;/u);
  assert.match(shell, /if \(event\.button !== 0\) return;/u);
  assert.match(shell, /if \(activeResize\.autoCompact\) setSidebarViewportOverride\(true\);/u);
  assert.match(styles, /\.shell-brand-name \{[\s\S]*?white-space:nowrap;/u);
  assert.match(styles, /\.desktop-shell > \.app-shell\[data-sidebar-compact="true"\] \.shell-nav-item \{[\s\S]*?padding-left:calc\(\(100% - 19px\)\/2\);/u);
  assert.match(compactRail, /left:calc\(50% \+ 35px\)/u);
  assert.match(styles, /\.shell-command-form \{ width:100%; margin:0; \}/u);
  assert.doesNotMatch(styles, /\.suzu-search-overlay/u);
});

test("the desktop shell provides a persisted draggable sidebar splitter", () => {
  const shell = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.jsx"), "utf8");
  const styles = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.css"), "utf8");
  const app = readFileSync(resolve(HERE, "..", "src", "app.mjs"), "utf8");

  assert.match(shell, /className="shell-sidebar-resizer"/u);
  assert.match(shell, /role="separator"/u);
  assert.match(shell, /onPointerDown=\{beginSidebarResize\}/u);
  assert.match(shell, /onPointerMove=\{resizeSidebar\}/u);
  assert.match(shell, /setShellSidebarWidth/u);
  assert.match(styles, /--shell-sidebar-width:240px;/u);
  assert.match(styles, /--shell-main-center-offset:120px;/u);
  assert.match(styles, /grid-template-columns:var\(--shell-sidebar-width\) minmax\(0,1fr\);/u);
  assert.match(styles, /\.shell-sidebar-resizer\s*\{[\s\S]*?cursor:col-resize;/u);
  assert.match(styles, /data-sidebar-compact="true"/u);
  assert.match(app, /setShellSidebarWidth/u);
  assert.match(app, /shellSidebarWidth: state\.settings\?\.shellSidebarWidth/u);
  assert.match(shell, /"--shell-main-center-offset":/u);
  assert.match(styles, /width:min\(\s*calc\(100vw - var\(--shell-sidebar-width\) - 32px\),\s*clamp\(360px,42vw,680px\)\s*\);/u);
});

test("the top command field opens the fixed Suzu software assistant instead of a command palette", () => {
  const shell = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.jsx"), "utf8");
  const app = readFileSync(resolve(HERE, "..", "src", "app.mjs"), "utf8");
  const dialog = readFileSync(resolve(HERE, "..", "src", "react", "software-assistant-dialog.jsx"), "utf8");
  const assistantStyles = readFileSync(resolve(HERE, "..", "src", "react", "software-assistant-dialog.css"), "utf8");

  assert.match(shell, /SoftwareAssistantDialog/u);
  assert.match(shell, /placeholder="问 Suzu：想做什么？"/u);
  assert.match(shell, /aria-label="问 Suzu"/u);
  assert.doesNotMatch(shell, /SuzuSearchDialog/u);
  assert.match(dialog, /const assistantName = busy \? "正在输入中\.\.\." : "Suzu";/u);
  assert.match(dialog, /<h2 aria-live="polite">\{assistantName\}<\/h2>/u);
  assert.doesNotMatch(dialog, /软件使用助手/u);
  assert.doesNotMatch(dialog, /默认不读取联系人或长期记忆/u);
  assert.match(dialog, /import \{ createPortal \} from "react-dom";/u);
  assert.match(dialog, /createPortal\(dialog, document\.body\)/u);
  assert.match(shell, /owner=\{workspace\?\.owner\}/u);
  assert.match(app, /owner: getIdentity\(state\.settings\)\.owner/u);
  assert.match(dialog, /import \{ ConversationMessageList \} from "\.\/conversation-page\.jsx";/u);
  assert.match(dialog, /import \{ conversationMessageBlocks, mergeConversationMessages, projectedLiveReply \} from "\.\.\/features\/conversation\/index\.mjs";/u);
  assert.match(dialog, /function conversationRow\(/u);
  assert.match(dialog, /type: "message"/u);
  assert.match(dialog, /const blocks = conversationMessageBlocks\(message\);/u);
  assert.match(dialog, /src: "\.\/app-icon\.png"/u);
  assert.match(dialog, /className="software-assistant-dialog__history content--conversation"/u);
  assert.match(dialog, /<ConversationMessageList rows=\{messageRows\} \/>/u);
  assert.match(dialog, /setPendingMessages\(\(current\) => \[\.\.\.current, pending\]\)/u);
  assert.match(dialog, /mergeConversationMessages\(messages, pendingMessages, liveReplies, sessionId\)/u);
  assert.match(dialog, /projectLiveReply\(event, \{ final: true \}\)/u);
  assert.match(dialog, /window\.setInterval\(\(\) => \{ void refresh\(\); \}, 2_000\)/u);
  assert.doesNotMatch(dialog, /正在查看软件状态/u);
  assert.doesNotMatch(dialog, /software-assistant-message/u);
  assert.doesNotMatch(assistantStyles, /software-assistant-message/u);
  assert.doesNotMatch(assistantStyles, /software-assistant-avatar/u);
  assert.match(assistantStyles, /\.software-assistant-overlay\s*\{[\s\S]*?place-items:center;/u);
  assert.doesNotMatch(assistantStyles, /padding-left:calc\(70px \+ 20px\)/u);
});

test("the top command field stays centered in the whole desktop shell", () => {
  const styles = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.css"), "utf8");
  const shell = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.jsx"), "utf8");
  const topbar = styles.slice(styles.indexOf(".shell-topbar {"), styles.indexOf(".shell-topbar-edge"));

  assert.match(topbar, /grid-template-columns:minmax\(120px,1fr\) minmax\(280px,620px\) minmax\(120px,1fr\);/u);
  assert.match(topbar, /padding:0 28px;/u);
  assert.doesNotMatch(topbar, /padding:0 156px 0 28px;/u);
  assert.match(styles, /--shell-command-center-offset:-120px;/u);
  assert.match(styles, /\.shell-command-slot \{[\s\S]*?transform:translateX\(var\(--shell-command-center-offset\)\);/u);
  assert.match(shell, /"--shell-command-center-offset":[\s\S]*?effectiveSidebarWidth/u);
});

test("the application chrome is a compact continuous surface above the rounded workspace", () => {
  const styles = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.css"), "utf8");
  const shell = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.jsx"), "utf8");
  const sidebar = styles.slice(styles.indexOf(".shell-sidebar {"), styles.indexOf(".shell-brand {"));
  const topbar = styles.slice(styles.indexOf(".shell-topbar {"), styles.indexOf(".shell-topbar-edge"));

  assert.match(styles, /--shell-chrome-bg:var\(--bg-elevated\);/u);
  assert.match(styles, /--shell-topbar-height:40px;/u);
  assert.match(styles, /--shell-bottombar-height:8px;/u);
  assert.match(styles, /--shell-page-scrollbar-size:12px;/u);
  assert.match(sidebar, /border-right:0;/u);
  assert.match(sidebar, /background:var\(--shell-chrome-bg\);/u);
  assert.match(sidebar, /padding:var\(--shell-topbar-height\) 16px 17px;/u);
  assert.match(topbar, /height:var\(--shell-topbar-height\);/u);
  assert.match(topbar, /background:var\(--shell-chrome-bg\);/u);
  assert.match(topbar, /backdrop-filter:none;/u);
  assert.match(styles, /:root\[data-theme="light"\] \.shell-topbar\s*\{[\s\S]*?background:var\(--shell-chrome-bg\);/u);
  assert.match(styles, /\.shell-main\s*\{[\s\S]*?background:var\(--shell-chrome-bg\);/u);
  assert.match(styles, /\.shell-main > \.content\s*\{[\s\S]*?border-radius:var\(--shell-workspace-corner\) 0 0 var\(--shell-workspace-corner\);[\s\S]*?background:var\(--bg\);/u);
  assert.match(styles, /\.shell-bottombar\s*\{[\s\S]*?flex:0 0 var\(--shell-bottombar-height\);[\s\S]*?background:var\(--shell-chrome-bg\);/u);
  assert.match(shell, /<\/section>\s*<div aria-hidden="true" className="shell-bottombar" \/>/u);
  assert.match(shell, /aria-label="问 Suzu"[\s\S]*?size="sm"/u);
});
