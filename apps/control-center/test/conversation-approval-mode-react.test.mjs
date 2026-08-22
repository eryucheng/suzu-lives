import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function source(...parts) {
  return readFile(resolve(ROOT, ...parts), "utf8");
}

test("联系人审批模式在聊天的 Agent 设置中配置，而不是相处资料编辑器中", async () => {
  const [conversationFeature, conversationPage, conversationStyles, relationshipPage] = await Promise.all([
    source("src", "features", "conversation", "index.mjs"),
    source("src", "react", "conversation-page.jsx"),
    source("src", "styles", "conversation.css"),
    source("src", "react", "relationship-settings-page.jsx"),
  ]);

  assert.match(conversationPage, /const CONTACT_APPROVAL_MODE_OPTIONS/u);
  assert.match(conversationPage, /\{ label: "全权限", value: "danger-full-access" \}/u);
  assert.doesNotMatch(conversationPage, /不审批/u);
  assert.match(conversationPage, /<span>审批模式<\/span>/u);
  assert.match(conversationPage, /ariaLabel="联系人审批模式"/u);
  assert.match(conversationPage, /actions\.setContactPermissionMode\(value\)/u);
  assert.match(conversationPage, /<details className="conversation-session-settings__section conversation-session-settings__display-options">/u);
  assert.doesNotMatch(conversationPage, /conversation-session-settings__display-options" open/u);
  const displayOptions = conversationPage.match(/<details className="conversation-session-settings__section conversation-session-settings__display-options">([\s\S]*?)<\/details>/u)?.[0] || "";
  assert.doesNotMatch(displayOptions, /时间显示/u);
  assert.match(conversationPage, /conversation-session-settings__single-row"><label className="conversation-settings__time-display"><span>时间显示<\/span>/u);
  assert.match(conversationStyles, /conversation-session-settings__display-options > summary::after \{[\s\S]*?content: "展开";/u);
  assert.match(conversationStyles, /conversation-session-settings__display-options\[open\] > summary::after \{[\s\S]*?content: "收起";/u);
  assert.doesNotMatch(conversationPage, /SUZU AGENT · CORE/u);
  assert.match(conversationFeature, /permissionMode: clean\(contact\?\.permissionMode\) \|\| "danger-full-access"/u);
  assert.match(conversationFeature, /setContactPermissionMode: async \(permissionMode\) => \{[\s\S]*?api\.conversation\.updateContactPermissionMode/u);
  assert.doesNotMatch(relationshipPage, /savePermissionMode|APPROVAL_MODE_OPTIONS|relationship-settings-approval-mode/u);
});
