import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));

test("contact roster places the unread indicator on the avatar and does not duplicate selected state", () => {
  const page = readFileSync(resolve(HERE, "..", "src", "react", "conversation-page.jsx"), "utf8");
  const styles = readFileSync(resolve(HERE, "..", "src", "styles", "conversation.css"), "utf8");

  assert.match(page, /function unreadBadgeLabel\(value\)/u);
  assert.match(page, /count > 99 \? "99\+" : String\(count\)/u);
  assert.match(page, /conversation-contact__unread-badge">\{unreadBadgeLabel\(contact\.unreadCount\)\}<\/span>/u);
  assert.match(page, /有\$\{unreadBadgeLabel\(contact\.unreadCount\)\}条未读消息/u);
  assert.doesNotMatch(page, /conversation-contact__selected-mark/u);
  assert.doesNotMatch(page, /conversation-contact__unread-dot/u);
  const app = readFileSync(resolve(HERE, "..", "src", "app.mjs"), "utf8");
  assert.match(app, /unreadIncrement: 1/u);
  assert.match(styles, /\.conversation-contact__unread-badge[\s\S]*?position: absolute/u);
  assert.match(styles, /\.conversation-contact__unread-badge[\s\S]*?background: #fa5151/u);
});

test("contact roster searches visible contacts by their displayed name", () => {
  const page = readFileSync(resolve(HERE, "..", "src", "react", "conversation-page.jsx"), "utf8");
  const styles = readFileSync(resolve(HERE, "..", "src", "styles", "conversation.css"), "utf8");

  assert.match(page, /const \[query, setQuery\] = useState\(""\)/u);
  assert.match(page, /toLocaleLowerCase\("zh-CN"\)\.includes\(normalizedQuery\)/u);
  assert.match(page, /aria-label="搜索联系人"/u);
  assert.match(page, /placeholder="搜索"/u);
  assert.match(page, /visibleContacts\.map/u);
  assert.match(styles, /\.conversation-roster__search[\s\S]*?flex: 1/u);
  assert.match(styles, /\.conversation-roster__heading button[\s\S]*?width: 38px[\s\S]*?height: 38px[\s\S]*?border-radius: 10px/u);
});

test("contact roster width can be adjusted within a bounded range without collapsing it", () => {
  const page = readFileSync(resolve(HERE, "..", "src", "react", "conversation-page.jsx"), "utf8");
  const styles = readFileSync(resolve(HERE, "..", "src", "styles", "conversation.css"), "utf8");
  const conversation = readFileSync(resolve(HERE, "..", "src", "features", "conversation", "index.mjs"), "utf8");

  assert.match(page, /className="conversation-roster-resizer"/u);
  assert.match(page, /onPointerDown=\{beginRosterResize\}/u);
  assert.match(page, /onPointerMove=\{resizeRoster\}/u);
  assert.match(page, /CONVERSATION_ROSTER_MIN_WIDTH = 192/u);
  assert.match(page, /CONVERSATION_ROSTER_MAX_WIDTH = 340/u);
  assert.match(styles, /--conversation-roster-width: 246px;/u);
  assert.match(styles, /grid-template-columns: var\(--conversation-roster-width\) minmax\(0, 1fr\);/u);
  assert.match(styles, /\.conversation-roster-resizer\s*\{[\s\S]*?cursor: col-resize;/u);
  assert.match(styles, /@media \(max-width: 940px\)[\s\S]*?grid-template-columns: 210px minmax\(0, 1fr\);[\s\S]*?\.conversation-roster-resizer\s*\{[\s\S]*?display: none;/u);
  assert.match(conversation, /rosterWidth: context\.state\.settings\?\.conversationRosterWidth/u);
  assert.match(conversation, /setConversationRosterWidth: async/u);
});

test("conversation header names contacts with unread messages beside its actions", () => {
  const page = readFileSync(resolve(HERE, "..", "src", "react", "conversation-page.jsx"), "utf8");
  const styles = readFileSync(resolve(HERE, "..", "src", "styles", "conversation.css"), "utf8");

  assert.match(page, /function unreadContactSummary\(contacts\)/u);
  assert.match(page, /function ConversationUnreadIndicator\(\{ contacts \}\)/u);
  assert.match(page, /<ConversationUnreadIndicator contacts=\{snapshot\.contacts\} \/>/u);
  assert.match(page, /未读消息：\$\{title\}/u);
  assert.match(styles, /\.conversation-pane__unread-summary[\s\S]*?background: #fa5151/u);
  assert.match(styles, /\.conversation-pane__unread-summary-copy[\s\S]*?text-overflow: ellipsis/u);
});
