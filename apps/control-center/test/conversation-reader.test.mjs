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

test("reader keeps each contact bound to its stored native Claude Code session", async () => {
  const root = await temporaryDirectory("suzu-native-reader-");
  const contactsRoot = path.join(root, "contacts");
  const homeDirectory = path.join(root, "home");
  const sessionId = "9575c901-be3d-4af8-8e01-4a5ed1bdcf00";
  await fs.mkdir(contactsRoot, { recursive: true });
  let settings = { contactsRoot };
  const contactProjectsService = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
    createSessionId: () => sessionId,
  });
  const contact = await contactProjectsService.create({ name: "小苏" });
  const projectRoot = contact.activeContact.projectRoot;
  const projectDirectory = path.join(homeDirectory, ".claude", "projects", encodeClaudeProjectKey(projectRoot));
  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.writeFile(path.join(projectDirectory, `${sessionId}.jsonl`), [
    JSON.stringify({ type: "user", timestamp: "2026-08-04T10:00:00.000Z", message: { content: "这是固定联系人的原生会话" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-08-04T10:00:01.000Z", message: { content: [{ type: "text", text: "已经在 Claude 官方目录中。" }] } }),
  ].join("\n").concat("\n"));
  const extraSessionId = "d49f486e-d0a2-4e9f-954b-f2d118f08f93";
  await fs.writeFile(path.join(projectDirectory, `${extraSessionId}.jsonl`), `${JSON.stringify({
    type: "user",
    timestamp: "2026-08-04T11:00:00.000Z",
    message: { content: "不应成为这个联系人的默认会话" },
  })}\n`);
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
  assert.equal(snapshot.sessions.find((session) => session.id === sessionId)?.title, "这是固定联系人的原生会话");
  assert.equal(snapshot.sessions.some((session) => session.id === extraSessionId), false);
  assert.equal(snapshot.messages.at(-1).blocks[0].text, "已经在 Claude 官方目录中。");
  const renamed = await reader.renameContact({ id: contact.activeContact.id, name: "新备注" });
  assert.equal(renamed.activeContact.id, contact.activeContact.id);
  assert.equal(renamed.activeContact.name, "新备注");
  assert.equal(renamed.activeSessionId, sessionId);
  assert.equal(renamed.messages.at(-1).blocks[0].text, "已经在 Claude 官方目录中。");
  assert.notEqual(renamed.version, snapshot.version);
  await assert.rejects(reader.create(), /只保留一个 Claude 会话/u);
});

test("reader keeps each contact's native Claude history inside its own project", async () => {
  const root = await temporaryDirectory("suzu-contact-reader-");
  const contactsRoot = path.join(root, "contacts");
  const homeDirectory = path.join(root, "home");
  const sessionId = "5ce757ba-b6b5-4261-9323-7a69e771b414";
  await fs.mkdir(contactsRoot, { recursive: true });
  let settings = { contactsRoot, projectRoot: "" };
  const contactProjectsService = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
    createSessionId: () => sessionId,
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
  const secondSession = await reader.ensureActiveSession();
  assert.equal(secondSession.id, secondContact.activeContact.sessionId);
  assert.equal(secondSession.hasTranscript, false);

  const restored = await reader.selectContact({ id: created.activeContact.id });
  assert.equal(restored.activeContact.name, "小苏");
  assert.equal(restored.activeSessionId, sessionId);
  assert.notEqual(secondContact.activeContact.id, created.activeContact.id);
});

test("reader exposes contact presentation state and clears an unread contact when it is opened", async () => {
  const root = await temporaryDirectory("suzu-reader-contact-presentation-");
  const contactsRoot = path.join(root, "contacts");
  await fs.mkdir(contactsRoot, { recursive: true });
  let settings = { contactsRoot, projectRoot: "" };
  const contactProjectsService = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
  });
  const first = await contactProjectsService.create({ name: "小苏" });
  await contactProjectsService.create({ name: "工作" });
  await contactProjectsService.updatePresentation({ id: first.activeContact.id, pinned: true, unread: true, muted: true, hidden: true });
  const reader = createConversationReader({
    contactProjectsService,
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
    homeDirectory: path.join(root, "home"),
  });

  const beforeOpen = await reader.snapshot();
  assert.equal(beforeOpen.contacts[0].id, first.activeContact.id);
  assert.deepEqual(
    { hidden: beforeOpen.contacts[0].hidden, pinned: beforeOpen.contacts[0].pinned, unread: beforeOpen.contacts[0].unread, muted: beforeOpen.contacts[0].muted },
    { hidden: true, pinned: true, unread: true, muted: true },
  );

  const opened = await reader.selectContact({ id: first.activeContact.id });
  assert.equal(opened.activeContact.id, first.activeContact.id);
  assert.deepEqual(
    { hidden: opened.activeContact.hidden, pinned: opened.activeContact.pinned, unread: opened.activeContact.unread, muted: opened.activeContact.muted },
    { hidden: true, pinned: true, unread: false, muted: true },
  );
});

test("reader lists every contact for the compactor without changing the active contact", async () => {
  const root = await temporaryDirectory("suzu-compactor-contact-reader-");
  const contactsRoot = path.join(root, "contacts");
  const homeDirectory = path.join(root, "home");
  const sessionId = "a0d44fcb-804a-4168-a7a2-7ba650c09970";
  await fs.mkdir(contactsRoot, { recursive: true });
  let settings = { contactsRoot, projectRoot: "" };
  const contactProjectsService = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
    createSessionId: () => sessionId,
  });
  const first = await contactProjectsService.create({ name: "小苏" });
  const firstProjectRoot = first.activeContact.projectRoot;
  const firstProjectDirectory = path.join(homeDirectory, ".claude", "projects", encodeClaudeProjectKey(firstProjectRoot));
  await fs.mkdir(firstProjectDirectory, { recursive: true });
  await fs.writeFile(path.join(firstProjectDirectory, `${sessionId}.jsonl`), `${JSON.stringify({
    type: "user",
    timestamp: "2026-08-05T10:00:00.000Z",
    message: { content: "小苏的压缩会话" },
  })}\n`);
  const second = await contactProjectsService.create({ name: "工作" });
  const reader = createConversationReader({
    contactProjectsService,
    homeDirectory,
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
  });

  const snapshot = await reader.compactorSnapshot();
  const contacts = new Map(snapshot.contacts.map((contact) => [contact.id, contact]));
  assert.equal(snapshot.activeContact.id, second.activeContact.id);
  assert.equal(contacts.get(first.activeContact.id).sessions[0].id, sessionId);
  assert.equal(contacts.get(first.activeContact.id).sessions[0].title, "小苏的压缩会话");
  assert.deepEqual(contacts.get(second.activeContact.id).sessions, []);

  const scoped = await reader.resolveCompactorSession({ contactId: first.activeContact.id });
  assert.equal(scoped.id, sessionId);
  assert.equal(scoped.projectRoot, firstProjectRoot);
  assert.equal(scoped.transcriptPath, path.join(firstProjectDirectory, `${sessionId}.jsonl`));
  assert.equal(scoped.hasTranscript, true);
  assert.equal(scoped.contact.id, first.activeContact.id);
  assert.equal(scoped.contact.name, "小苏");
  assert.equal(scoped.contact.agentId, first.activeContact.agentId);
  const runtimeScoped = await reader.resolveCompactorSessionForRuntime({
    projectRoot: firstProjectRoot,
    sessionId,
  });
  assert.equal(runtimeScoped.contact.id, first.activeContact.id);
  await assert.rejects(
    reader.resolveCompactorSessionForRuntime({ projectRoot: path.join(root, "not-owned"), sessionId }),
    /不属于任何联系人/u,
  );
  assert.equal(settings.projectRoot, second.activeContact.projectRoot);
});

test("reader resolves a contact's single scheduled conversation without changing the active contact", async () => {
  const root = await temporaryDirectory("suzu-contact-schedule-reader-");
  const contactsRoot = path.join(root, "contacts");
  const homeDirectory = path.join(root, "home");
  const sessionId = "d0f34d09-17fc-4c0a-b850-2b1fc3d77236";
  await fs.mkdir(contactsRoot, { recursive: true });
  let settings = { contactsRoot, projectRoot: "" };
  const contactProjectsService = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
    createSessionId: () => sessionId,
  });
  const first = await contactProjectsService.create({ name: "小苏" });
  const firstProjectRoot = first.activeContact.projectRoot;
  const sessionDirectory = path.join(homeDirectory, ".claude", "projects", encodeClaudeProjectKey(firstProjectRoot));
  await fs.mkdir(sessionDirectory, { recursive: true });
  await fs.writeFile(path.join(sessionDirectory, `${sessionId}.jsonl`), `${JSON.stringify({
    type: "user",
    timestamp: "2026-08-05T10:00:00.000Z",
    message: { content: "给计划页用的联系人会话" },
  })}\n`);
  const second = await contactProjectsService.create({ name: "阿澈" });
  const reader = createConversationReader({
    contactProjectsService,
    homeDirectory,
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
  });

  const resolved = await reader.resolveContactSession(first.activeContact.id);
  assert.deepEqual(resolved, {
    approvalMode: "acceptEdits",
    contactId: first.activeContact.id,
    id: sessionId,
    projectRoot: firstProjectRoot,
    hasTranscript: true,
  });
  assert.equal(settings.projectRoot, second.activeContact.projectRoot);

  const fresh = await reader.resolveContactSession(second.activeContact.id);
  assert.match(fresh.id, /^[0-9a-f-]{36}$/u);
  assert.equal(fresh.projectRoot, second.activeContact.projectRoot);
  assert.equal(fresh.hasTranscript, false);
});

test("reader reopens a searchable JSONL line with local context for chat positioning", async () => {
  const root = await temporaryDirectory("suzu-reader-focus-");
  const contactsRoot = path.join(root, "contacts");
  const homeDirectory = path.join(root, "home");
  const sessionId = "e1375e14-a8df-42ff-b1b3-9f2c7d12e519";
  await fs.mkdir(contactsRoot, { recursive: true });
  let settings = { contactsRoot };
  const contactProjectsService = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
    createSessionId: () => sessionId,
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
