import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createConversationReader,
  encodeClaudeProjectKey,
} from "../electron/services/conversation-reader.mjs";
import { createContactProjectsService } from "../electron/services/contact-projects.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("native Claude project encoding follows the official session directory convention", () => {
  assert.equal(encodeClaudeProjectKey("D:\\work\\项目_foo.bar@home"), "D--work----foo-bar-home");
});

test("reader discovers and selects native Claude Code JSONL sessions within a contact project", async () => {
  const root = await temporaryDirectory("suzu-native-reader-");
  const contactsRoot = path.join(root, "contacts");
  const homeDirectory = path.join(root, "home");
  const sessionId = "9575c901-be3d-4af8-8e01-4a5ed1bdcf00";
  await fs.mkdir(contactsRoot, { recursive: true });
  let settings = { contactsRoot, conversationSessionId: "" };
  const contactProjectsService = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
  });
  const contact = await contactProjectsService.create({ name: "小苏" });
  const projectRoot = contact.activeContact.projectRoot;
  const projectDirectory = path.join(homeDirectory, ".claude", "projects", encodeClaudeProjectKey(projectRoot));
  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.writeFile(path.join(projectDirectory, `${sessionId}.jsonl`), [
    JSON.stringify({ type: "user", timestamp: "2026-08-04T10:00:00.000Z", message: { content: "这是迁移后的原生会话" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-08-04T10:00:01.000Z", message: { content: [{ type: "text", text: "已经在 Claude 官方目录中。" }] } }),
  ].join("\n").concat("\n"));
  const reader = createConversationReader({
    contactProjectsService,
    settingsService: {
      load: () => settings,
      save: (next) => { settings = next; return settings; },
    },
    homeDirectory,
  });

  const snapshot = await reader.snapshot();
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.activeSessionId, sessionId);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].title, "这是迁移后的原生会话");
  assert.equal(snapshot.messages.at(-1).blocks[0].text, "已经在 Claude 官方目录中。");

  const created = await reader.create();
  assert.equal(created.activeSessionId, settings.conversationSessionId);
  assert.equal(created.sessions[0].draft, true);
  assert.equal(created.messages.length, 0);
  const selected = await reader.select(sessionId);
  assert.equal(selected.activeSessionId, sessionId);
  assert.equal(settings.conversationSessionId, sessionId);
});

test("reader keeps each contact's native Claude history inside its own project", async () => {
  const root = await temporaryDirectory("suzu-contact-reader-");
  const contactsRoot = path.join(root, "contacts");
  const homeDirectory = path.join(root, "home");
  const sessionId = "5ce757ba-b6b5-4261-9323-7a69e771b414";
  await fs.mkdir(contactsRoot, { recursive: true });
  let settings = { contactsRoot, projectRoot: "", conversationSessionId: "" };
  const contactProjectsService = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
  });

  const created = await contactProjectsService.create({ name: "小苏" });
  const firstProjectRoot = created.activeContact.projectRoot;
  const projectDirectory = path.join(homeDirectory, ".claude", "projects", encodeClaudeProjectKey(firstProjectRoot));
  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.writeFile(path.join(projectDirectory, `${sessionId}.jsonl`), `${JSON.stringify({
    type: "user",
    timestamp: "2026-08-05T10:00:00.000Z",
    message: { content: "小苏的独立会话" },
  })}\n`);

  const reader = createConversationReader({
    contactProjectsService,
    homeDirectory,
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
  });
  const firstSnapshot = await reader.snapshot();
  assert.deepEqual(firstSnapshot.contacts.map((contact) => contact.name), ["小苏"]);
  assert.equal(firstSnapshot.contacts[0].agentId, created.activeContact.agentId);
  assert.equal(firstSnapshot.activeContact.name, "小苏");
  assert.equal(firstSnapshot.activeContact.agentId, created.activeContact.agentId);
  assert.equal(firstSnapshot.activeSessionId, sessionId);

  const secondContact = await contactProjectsService.create({ name: "阿澈" });
  const secondSnapshot = await reader.snapshot();
  assert.equal(secondSnapshot.activeContact.name, "阿澈");
  assert.equal(secondSnapshot.activeContact.agentId, secondContact.activeContact.agentId);
  assert.equal(secondSnapshot.sessions.length, 0);

  const restored = await reader.selectContact({ id: created.activeContact.id });
  assert.equal(restored.activeContact.name, "小苏");
  assert.equal(restored.activeSessionId, sessionId);
  assert.notEqual(secondContact.activeContact.id, created.activeContact.id);
});

test("contact mode never falls back to a stale direct project before a contacts root is selected", async () => {
  const root = await temporaryDirectory("suzu-contact-reader-empty-");
  const legacyProjectRoot = path.join(root, "legacy-project");
  const homeDirectory = path.join(root, "home");
  const sessionId = "96a0e19f-16c5-46e9-93a2-4ed0349fe980";
  const projectDirectory = path.join(homeDirectory, ".claude", "projects", encodeClaudeProjectKey(legacyProjectRoot));
  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.writeFile(path.join(projectDirectory, `${sessionId}.jsonl`), `${JSON.stringify({
    type: "user",
    timestamp: "2026-08-05T10:00:00.000Z",
    message: { content: "不应被联系人模式读取的旧消息" },
  })}\n`);
  let settings = { contactsRoot: "", projectRoot: legacyProjectRoot, conversationSessionId: sessionId };
  const contactProjectsService = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
  });
  const reader = createConversationReader({
    contactProjectsService,
    homeDirectory,
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
  });

  const snapshot = await reader.snapshot();
  assert.equal(snapshot.status, "missing");
  assert.equal(snapshot.projectRoot, "");
  assert.equal(snapshot.activeSessionId, "");
  assert.deepEqual(snapshot.messages, []);
});

test("reader reopens a searchable JSONL line with local context for chat positioning", async () => {
  const root = await temporaryDirectory("suzu-reader-focus-");
  const contactsRoot = path.join(root, "contacts");
  const homeDirectory = path.join(root, "home");
  const sessionId = "e1375e14-a8df-42ff-b1b3-9f2c7d12e519";
  await fs.mkdir(contactsRoot, { recursive: true });
  let settings = { contactsRoot, conversationSessionId: sessionId };
  const contactProjectsService = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
  });
  const contact = await contactProjectsService.create({ name: "定位测试" });
  const projectRoot = contact.activeContact.projectRoot;
  const projectDirectory = path.join(homeDirectory, ".claude", "projects", encodeClaudeProjectKey(projectRoot));
  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.writeFile(path.join(projectDirectory, `${sessionId}.jsonl`), [
    JSON.stringify({ type: "user", timestamp: "2026-08-05T10:00:00.000Z", message: { id: "older", content: "前一条消息" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-08-05T10:00:01.000Z", message: { id: "target", content: [{ type: "text", text: "这里是要定位的关键词" }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-08-05T10:00:02.000Z", message: { id: "newer", content: "后一条消息" } }),
  ].join("\n").concat("\n"));
  const reader = createConversationReader({
    contactProjectsService,
    settingsService: {
      load: () => settings,
      save: (next) => { settings = next; return settings; },
    },
    homeDirectory,
  });

  const found = await reader.search({ category: "messages", query: "定位的关键词" });
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0].lineNumber, 2);
  assert.equal(found.matches[0].messageId, "target");

  const focused = await reader.focus({ lineNumber: found.matches[0].lineNumber, messageId: found.matches[0].messageId });
  assert.equal(focused.focusLineNumber, 2);
  assert.equal(focused.focusMessageId, "target");
  assert.deepEqual(focused.messages.map((message) => message.id), ["older", "target", "newer"]);
  assert.deepEqual(focused.messages.map((message) => message.lineNumber), [1, 2, 3]);
});
