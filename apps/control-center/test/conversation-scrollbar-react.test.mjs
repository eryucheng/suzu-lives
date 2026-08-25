import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));

test("conversation scrollbar appears only around transcript scrolling activity", () => {
  const page = readFileSync(resolve(HERE, "..", "src", "react", "conversation-page.jsx"), "utf8");
  const styles = readFileSync(resolve(HERE, "..", "src", "styles", "conversation.css"), "utf8");

  assert.match(page, /CONVERSATION_SCROLLBAR_IDLE_MS = 1_800/u);
  assert.match(page, /CONVERSATION_HISTORY_TOP_TRIGGER_PX = 1/u);
  assert.match(page, /CONVERSATION_HISTORY_TOP_REARM_PX = 32/u);
  assert.match(page, /function conversationScrollbarGeometry\(list, rail\)/u);
  assert.match(page, /const conversationScrollbarFrame = useRef\(null\)/u);
  assert.match(page, /const syncConversationScrollbar = useCallback\(\(list = listRef\.current\) => \{[\s\S]*?rail\.classList\.toggle\("is-scrollable", next\.scrollable\);/u);
  assert.match(page, /const requestConversationScrollbarSync = useCallback\(\(list = listRef\.current\) => \{[\s\S]*?window\.requestAnimationFrame/u);
  assert.match(page, /const revealConversationScrollbar = useCallback\(\(\) => \{[\s\S]*?rail\.classList\.add\("is-visible"\);[\s\S]*?classList\.remove\("is-visible"\);/u);
  assert.doesNotMatch(page, /setConversationScrollbar\(/u);
  assert.match(page, /className="conversation-transcript"/u);
  assert.match(page, /className="conversation-scrollbar"/u);
  assert.match(page, /onPointerDown=\{beginConversationScrollbarDrag\}/u);
  assert.match(page, /onPointerMove=\{dragConversationScrollbar\}/u);
  assert.match(page, /const loadOlderHistoryAtTop = useCallback\(\(list = listRef\.current, \{ fromWheel = false \} = \{\}\) => \{/u);
  assert.match(page, /if \(!fromWheel && !conversationHistoryTopLoadArmedRef\.current\) return false;/u);
  assert.match(page, /onWheel=\{\(event\) => \{[\s\S]*?Number\(event\.deltaY\) >= 0[\s\S]*?loadOlderHistoryAtTop\(event\.currentTarget, \{ fromWheel: true \}\)[\s\S]*?event\.preventDefault\(\);/u);
  assert.match(page, /onPointerDown=\{revealConversationScrollbar\}/u);
  assert.match(page, /onScroll=\{\(event\) => \{[\s\S]*?const list = event\.currentTarget;[\s\S]*?actions\.setListScroll\(list\);[\s\S]*?requestConversationScrollbarSync\(list\);[\s\S]*?revealConversationScrollbar\(\);/u);
  assert.match(page, /const conversationHistoryTopLoadArmedRef = useRef\(false\)/u);
  assert.match(page, /const olderHistoryViewportAnchorRef = useRef\(null\)/u);
  assert.match(page, /scrollTop >= CONVERSATION_HISTORY_TOP_REARM_PX[\s\S]*?conversationHistoryTopLoadArmedRef\.current = true;/u);
  assert.match(page, /loadOlderHistoryAtTop\(list\);/u);
  assert.match(page, /const olderHistoryAnchor = olderHistoryViewportAnchorRef\.current;[\s\S]*?!snapshot\.history\?\.loadingOlder[\s\S]*?restoreConversationViewportAnchor\(list, olderHistoryAnchor\)/u);
  assert.doesNotMatch(page, /scrollTop <= 48/u);
  assert.match(page, /export function ConversationMessageList\([^)]*rows[^)]*\) \{[\s\S]*?return groupConversationToolActivityRows\(rows\)\.map\(/u);
  assert.doesNotMatch(page, /useVirtualizer|conversation-virtual-list/u);
  assert.match(styles, /\.content--conversation \.conversation-transcript \{[\s\S]*?display: grid;[\s\S]*?grid-template-rows: minmax\(0, 1fr\);/u);
  assert.match(styles, /\.content--conversation \.conversation-list \{[\s\S]*?display: flex;[\s\S]*?overflow-x: hidden;[\s\S]*?overflow-y: auto;[\s\S]*?scrollbar-width: none;/u);
  assert.match(styles, /conversation-list::-webkit-scrollbar \{[\s\S]*?width: 0;/u);
  assert.match(styles, /conversation-history-loading \{[\s\S]*?align-self: center;/u);
  assert.match(styles, /conversation-scrollbar \{[\s\S]*?opacity: 0;[\s\S]*?transition: opacity .24s ease-in-out;/u);
  assert.match(styles, /conversation-scrollbar\.is-visible \{[\s\S]*?opacity: 1;/u);
  assert.match(styles, /conversation-scrollbar__thumb \{[\s\S]*?cursor: grab;/u);
});
