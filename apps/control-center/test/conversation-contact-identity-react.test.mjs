import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function source(...parts) {
  return readFile(resolve(ROOT, ...parts), "utf8");
}

test("联系人设置把头像与备注操作收进一个紧凑资料块", async () => {
  const [conversationPage, conversationStyles] = await Promise.all([
    source("src", "react", "conversation-page.jsx"),
    source("src", "styles", "conversation.css"),
  ]);

  assert.match(conversationPage, /conversation-session-settings__section conversation-session-settings__identity/u);
  assert.match(conversationPage, /<strong>\{settings\.contactName\}<\/strong>/u);
  assert.match(conversationPage, />修改备注<\/button>/u);
  assert.match(conversationPage, />更换头像<input/u);
  assert.match(conversationPage, /<button aria-label="关闭联系人设置" className="conversation-session-settings__close suzu-close-button"/u);
  assert.doesNotMatch(conversationPage, /<header><div><span>当前联系人<\/span>/u);
  assert.doesNotMatch(conversationPage, /<h2>联系人头像<\/h2>/u);
  assert.doesNotMatch(conversationPage, /conversation-session-settings__contact-name|conversation-session-settings__avatar-copy/u);
  assert.match(conversationStyles, /conversation-session-settings__identity \{[\s\S]*?grid-template-columns: 48px minmax\(0, 1fr\) 28px;/u);
  assert.match(conversationStyles, /conversation-session-settings__identity-action \{[\s\S]*?background: transparent;/u);
});
