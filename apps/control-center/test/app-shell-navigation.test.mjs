import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));

test("the primary shell navigation exposes the current conversation directly below today", () => {
  const shell = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.jsx"), "utf8");
  const primaryNavigation = shell.slice(shell.indexOf("const PRIMARY_NAVIGATION"), shell.indexOf("const UTILITY_NAVIGATION"));

  assert.match(primaryNavigation, /view: "today"[\s\S]*?view: "conversation"[\s\S]*?view: "relationships"/u);
  assert.match(shell, /view === "conversation"[\s\S]*?openSuzuSearchItem\?\.\("conversation"\)/u);
  assert.match(shell, /route\?\.kind === "conversation"[\s\S]*?\? "conversation"/u);
  assert.match(shell, /item\.view === "conversation" && conversationUnread/u);
});

test("the desktop shell collapses its navigation rail before reaching the minimum window width", () => {
  const styles = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.css"), "utf8");
  const compactRail = styles.slice(styles.indexOf("@media (max-width:1180px)"), styles.indexOf("@media (max-width:820px)"));

  assert.match(compactRail, /grid-template-columns:70px minmax\(0,1fr\)/u);
  assert.match(compactRail, /\.shell-brand-copy \{ display:none; \}/u);
  assert.match(compactRail, /clip-path:inset\(50%\)/u);
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
