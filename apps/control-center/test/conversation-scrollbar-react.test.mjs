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
  assert.match(page, /function conversationScrollbarGeometry\(list, rail\)/u);
  assert.match(page, /const \[conversationScrollbarVisible, setConversationScrollbarVisible\] = useState\(false\)/u);
  assert.match(page, /const revealConversationScrollbar = useCallback\(\(\) => \{[\s\S]*?setConversationScrollbarVisible\(true\);[\s\S]*?setConversationScrollbarVisible\(false\);/u);
  assert.match(page, /className="conversation-transcript"/u);
  assert.match(page, /className=\{`conversation-scrollbar\$\{conversationScrollbarVisible && conversationScrollbar\.scrollable \? " is-visible" : ""\}`\}/u);
  assert.match(page, /onPointerDown=\{beginConversationScrollbarDrag\}/u);
  assert.match(page, /onPointerMove=\{dragConversationScrollbar\}/u);
  assert.match(page, /onWheel=\{revealConversationScrollbar\}/u);
  assert.match(page, /onPointerDown=\{revealConversationScrollbar\}/u);
  assert.match(page, /onScroll=\{\(event\) => \{ actions\.setListScroll\(event\.currentTarget\); updateConversationScrollbar\(event\.currentTarget\); revealConversationScrollbar\(\); \}\}/u);
  assert.match(styles, /conversation-list \{[\s\S]*?scrollbar-width: none;/u);
  assert.match(styles, /conversation-list::-webkit-scrollbar \{[\s\S]*?width: 0;/u);
  assert.match(styles, /conversation-scrollbar \{[\s\S]*?opacity: 0;[\s\S]*?transition: opacity .24s ease-in-out;/u);
  assert.match(styles, /conversation-scrollbar\.is-visible \{[\s\S]*?opacity: 1;/u);
  assert.match(styles, /conversation-scrollbar__thumb \{[\s\S]*?cursor: grab;/u);
});
