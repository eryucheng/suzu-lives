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

test("the desktop shell collapses its navigation rail before reaching the minimum window width", () => {
  const styles = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.css"), "utf8");
  const compactRail = styles.slice(styles.indexOf("@media (max-width:1180px)"), styles.indexOf("@media (max-width:820px)"));

  assert.match(compactRail, /grid-template-columns:70px minmax\(0,1fr\)/u);
  assert.match(styles, /transition:grid-template-columns \.26s cubic-bezier\(\.22,\.72,\.2,1\)/u);
  assert.match(compactRail, /\.shell-sidebar \{ padding:25px 9px 17px; \}/u);
  assert.match(compactRail, /\.shell-brand-copy \{[\s\S]*?max-width:0;[\s\S]*?opacity:0;/u);
  assert.match(styles, /\.shell-brand-name \{[\s\S]*?white-space:nowrap;/u);
  assert.match(compactRail, /\.shell-nav-item \{[\s\S]*?padding-left:calc\(\(100% - 19px\)\/2\);/u);
  assert.match(compactRail, /left:calc\(50% \+ 35px\)/u);
  assert.match(styles, /\.shell-command-form \{ width:100%; margin:0; \}/u);
  assert.doesNotMatch(styles, /\.suzu-search-overlay/u);
});

test("the top command field opens the fixed Suzu software assistant instead of a command palette", () => {
  const shell = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.jsx"), "utf8");
  const assistantStyles = readFileSync(resolve(HERE, "..", "src", "react", "software-assistant-dialog.css"), "utf8");

  assert.match(shell, /SoftwareAssistantDialog/u);
  assert.match(shell, /placeholder="问 Suzu：想做什么？"/u);
  assert.match(shell, /aria-label="问 Suzu"/u);
  assert.doesNotMatch(shell, /SuzuSearchDialog/u);
  assert.match(assistantStyles, /@media \(max-width:1180px\)[\s\S]*?padding-left:calc\(70px \+ 20px\)/u);
});

test("the top command field stays centered in the whole desktop shell", () => {
  const styles = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.css"), "utf8");
  const topbar = styles.slice(styles.indexOf(".shell-topbar {"), styles.indexOf(".shell-topbar-edge"));
  const compactRail = styles.slice(styles.indexOf("@media (max-width:1180px)"), styles.indexOf("@media (max-width:820px)"));

  assert.match(topbar, /grid-template-columns:minmax\(120px,1fr\) minmax\(280px,620px\) minmax\(120px,1fr\);/u);
  assert.match(topbar, /padding:0 28px;/u);
  assert.doesNotMatch(topbar, /padding:0 156px 0 28px;/u);
  assert.match(styles, /--shell-command-center-offset:-108px;/u);
  assert.match(styles, /\.shell-command-slot \{[\s\S]*?transform:translateX\(var\(--shell-command-center-offset\)\);/u);
  assert.match(compactRail, /--shell-command-center-offset:-35px;/u);
});
