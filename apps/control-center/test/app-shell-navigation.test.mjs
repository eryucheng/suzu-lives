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
  assert.match(shell, /item\.view === "settings" && appUpdateAttention/u);
  assert.match(shell, /appUpdateAttention=\{appUpdateAttention\}/u);
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
  assert.doesNotMatch(styles, /\.shell-command-form/u);
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

test("the top-right panel toggle opens the fixed Suzu software assistant", () => {
  const shell = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.jsx"), "utf8");
  const shellStyles = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.css"), "utf8");
  const app = readFileSync(resolve(HERE, "..", "src", "app.mjs"), "utf8");
  const dialog = readFileSync(resolve(HERE, "..", "src", "react", "software-assistant-dialog.jsx"), "utf8");
  const assistantStyles = readFileSync(resolve(HERE, "..", "src", "react", "software-assistant-dialog.css"), "utf8");

  assert.match(shell, /SoftwareAssistantDialog/u);
  assert.doesNotMatch(shell, /placeholder="问 Suzu：想做什么？"/u);
  assert.doesNotMatch(shell, /className="shell-command"/u);
  assert.match(shell, /aria-label=\{softwareAssistantOpen \? "收起 Suzu 助手" : "打开 Suzu 助手"\}/u);
  assert.match(shell, /className=\{`shell-titlebar-control shell-assistant-toggle\$\{softwareAssistantOpen \? " is-active" : ""\}`\}/u);
  assert.match(shell, /<ShellIcon name="panelRight" \/>/u);
  assert.match(shell, /setSoftwareAssistantOpen\(\(current\) => !current\)/u);
  assert.match(shellStyles, /\.shell-titlebar-controls \{[\s\S]*?right:4px;[\s\S]*?gap:2px;/u);
  assert.match(shellStyles, /\.shell-titlebar-control \{[\s\S]*?width:32px;[\s\S]*?height:32px;[\s\S]*?cursor:pointer;/u);
  assert.match(shellStyles, /\.shell-titlebar-control\.is-active/u);
  assert.doesNotMatch(shell, /SuzuSearchDialog/u);
  assert.match(dialog, /const assistantName = phase === "clearing" \? "正在清空记录\.\.\." : busy \? "正在输入中\.\.\." : "Suzu";/u);
  assert.match(dialog, /<h2 aria-live="polite">\{assistantName\}<\/h2>/u);
  assert.match(dialog, /api\?\.clearHistory/u);
  assert.match(dialog, /清空问 Suzu 的记录/u);
  assert.match(dialog, /联系人聊天、联系人资料和软件设置不会受影响/u);
  assert.doesNotMatch(dialog, /软件使用助手/u);
  assert.doesNotMatch(dialog, /默认不读取联系人或长期记忆/u);
  assert.match(dialog, /import \{ createPortal \} from "react-dom";/u);
  assert.match(dialog, /createPortal\(dialog, document\.body\)/u);
  assert.match(shell, /owner=\{workspace\?\.owner\}/u);
  assert.match(app, /owner: getIdentity\(state\.settings\)\.owner/u);
  assert.match(dialog, /import \{ ConversationMessageList \} from "\.\/conversation-page\.jsx";/u);
  assert.match(dialog, /mergeConversationMessageWindow/u);
  assert.match(dialog, /mergeConversationMessageWindow\(current, incoming\)\.messages/u);
  assert.match(dialog, /refreshSequenceRef/u);
  assert.match(dialog, /function conversationRow\(/u);
  assert.match(dialog, /type: "message"/u);
  assert.match(dialog, /const blocks = conversationMessageBlocks\(message\);/u);
  assert.match(dialog, /src: "\.\/app-icon\.png"/u);
  assert.match(dialog, /className="software-assistant-dialog__history content--conversation"/u);
  assert.match(dialog, /<ConversationMessageList rows=\{messageRows\} \/>/u);
  assert.match(dialog, /setPendingMessages\(\(current\) => \[\.\.\.current, pending\]\)/u);
  assert.match(dialog, /mergeConversationMessages\(messages, pendingMessages, liveReplies, sessionId\)/u);
  assert.match(dialog, /projectLiveReply\(event, \{ final: true \}\)/u);
  assert.doesNotMatch(dialog, /if \(!text \|\| phase !== "idle"\) return false;/u);
  assert.match(dialog, /disabled=\{!sessionId\}/u);
  assert.match(dialog, /software-assistant-dialog__composer-actions/u);
  assert.match(dialog, /window\.setInterval\(\(\) => \{ void refresh\(\); \}, 2_000\)/u);
  assert.doesNotMatch(dialog, /正在查看软件状态/u);
  assert.doesNotMatch(dialog, /software-assistant-message/u);
  assert.doesNotMatch(assistantStyles, /software-assistant-message/u);
  assert.doesNotMatch(assistantStyles, /software-assistant-avatar/u);
  assert.match(dialog, /aria-modal="false"/u);
  assert.match(dialog, /className=\{`software-assistant-overlay\$\{open \? " is-open" : ""\}/u);
  assert.doesNotMatch(dialog, /onMouseDown=\{onClose\}/u);
  assert.match(dialog, /className="software-assistant-dialog__resizer"/u);
  assert.match(dialog, /onPointerDown=\{beginPanelResize\}/u);
  assert.match(dialog, /onPanelWidthChange/u);
  assert.match(dialog, /更多 Suzu 助手操作/u);
  assert.match(dialog, /SOFTWARE_ASSISTANT_REASONING_EFFORT_OPTIONS/u);
  assert.match(dialog, /<Select[\s\S]*?ariaLabel="Suzu 助手思考强度"[\s\S]*?disabled=\{busy \|\| savingReasoningEffort\}/u);
  assert.match(dialog, /target\.closest\('\[role="listbox"\]'\)/u);
  assert.match(assistantStyles, /:root:has\(\.software-assistant-overlay\.is-open\) body > \[role="listbox"\][\s\S]*?z-index:calc\(var\(--z-assistant,200\) \+ 1\);/u);
  assert.match(dialog, /onReasoningEffortChange/u);
  assert.match(shell, /reasoningEffort=\{workspace\?\.softwareAssistantReasoningEffort\}/u);
  assert.match(shell, /onReasoningEffortChange=\{workspace\?\.actions\?\.setSoftwareAssistantReasoningEffort\}/u);
  assert.match(app, /softwareAssistantReasoningEffort: state\.settings\?\.softwareAssistantReasoningEffort/u);
  assert.match(assistantStyles, /\.software-assistant-overlay\s*\{[\s\S]*?inset:40px 0 0;[\s\S]*?background:transparent;[\s\S]*?pointer-events:none;/u);
  assert.match(assistantStyles, /\.software-assistant-overlay\.is-open[\s\S]*?visibility:visible;/u);
  assert.match(assistantStyles, /\.software-assistant-overlay\.is-open \.software-assistant-dialog[\s\S]*?pointer-events:auto;/u);
  assert.match(assistantStyles, /width:min\(var\(--software-assistant-panel-width,480px\),calc\(100vw - 28px\)\);/u);
  assert.doesNotMatch(assistantStyles, /backdrop-filter:blur\(/u);
  assert.match(shell, /setSoftwareAssistantPanelWidth/u);
  assert.match(shell, /panelWidth=\{workspace\?\.softwareAssistantPanelWidth\}/u);
  assert.match(app, /softwareAssistantPanelWidth: state\.settings\?\.softwareAssistantPanelWidth/u);
});

test("the Suzu panel toggle stays next to the window controls", () => {
  const styles = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.css"), "utf8");
  const shell = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.jsx"), "utf8");
  const topbar = styles.slice(styles.indexOf(".shell-topbar {"), styles.indexOf(".shell-titlebar-controls"));

  assert.doesNotMatch(topbar, /grid-template-columns:/u);
  assert.doesNotMatch(styles, /--shell-command-center-offset/u);
  assert.doesNotMatch(styles, /\.shell-command-slot/u);
  assert.match(styles, /\.shell-titlebar-controls \{[\s\S]*?position:absolute;[\s\S]*?top:4px;[\s\S]*?right:4px;/u);
  assert.match(shell, /className="shell-titlebar-controls"[\s\S]*?className=\{`shell-titlebar-control shell-assistant-toggle[\s\S]*?<WindowControls \/>/u);
  assert.match(shell, /aria-keyshortcuts="Control\+K Meta\+K"/u);
});

test("an incoming unread-message notice is centered in the window and uses its contact identity", () => {
  const styles = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.css"), "utf8");
  const shell = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.jsx"), "utf8");
  const app = readFileSync(resolve(HERE, "..", "src", "app.mjs"), "utf8");
  const notice = styles.slice(styles.indexOf(".incoming-conversation-notice {"), styles.indexOf(".incoming-voice-call {"));
  const compactRail = styles.slice(styles.indexOf("@media (max-width:1180px)"), styles.indexOf("@media (max-width:820px)"));

  assert.match(notice, /left:50%;/u);
  assert.match(notice, /width:min\(480px,calc\(100vw - 48px\)\);/u);
  assert.match(notice, /border-radius:14px;/u);
  assert.match(notice, /padding:9px 12px;/u);
  assert.match(notice, /width:34px;[\s\S]*?height:34px;/u);
  assert.match(notice, /-webkit-line-clamp:1;/u);
  assert.doesNotMatch(compactRail, /\.incoming-conversation-notice/u);
  assert.match(shell, /incoming-conversation-notice__app-name/u);
  assert.match(shell, /src=\{notice\.avatar \|\| "\.\/app-icon\.png"\}/u);
  assert.doesNotMatch(shell, /incoming-conversation-notice__sender/u);
  assert.match(app, /import \{ contactAvatarSource \} from "\.\/core\/contact-avatar\.mjs";/u);
  assert.match(app, /avatar: contactAvatarSource\(contact, state\.settings\)/u);
  assert.match(app, /senderName: String\(contact\?\.name \|\| profile\?\.displayName \|\| "Suzu"\)/u);
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
  assert.match(shell, /aria-controls="suzu-software-assistant-dialog"[\s\S]*?className=\{`shell-titlebar-control shell-assistant-toggle/u);
});
