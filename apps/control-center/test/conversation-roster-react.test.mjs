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
