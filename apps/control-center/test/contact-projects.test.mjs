import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createContactProjectsService, normalizeContactName } from "../electron/services/contact-projects.mjs";
import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";
import { claudeProjectDirectoryCandidates } from "../electron/services/conversation-reader.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("contacts are normal Claude projects directly below the selected contacts root", async () => {
  const contactsRoot = await temporaryDirectory("suzu-contact-projects-");
  const canonicalRoot = await fs.realpath(contactsRoot);
  let settings = { contactsRoot, projectRoot: "D:/old-project" };
  const service = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
  });

  const created = await service.create({ name: "小苏" });
  const projectRoot = created.activeContact.projectRoot;
  assert.equal(created.activeContact.projectRoot, projectRoot);
  assert.ok(created.activeContact.agentId);
  assert.match(path.basename(projectRoot), /^contact-[a-f0-9-]{36}$/u);
  assert.equal(path.dirname(projectRoot), canonicalRoot);
  assert.equal(settings.projectRoot, projectRoot);
  assert.equal(settings.preferredContactId, created.activeContact.id);
  assert.equal(created.preferredContact.id, created.activeContact.id);
  assert.equal(await fs.readFile(path.join(projectRoot, "CLAUDE.md"), "utf8"), "");
  const metadata = JSON.parse(await fs.readFile(path.join(projectRoot, ".suzu-lives", "contact.json"), "utf8"));
  assert.equal(metadata.version, 1);
  assert.equal(metadata.id, created.activeContact.id);
  assert.equal(metadata.name, "小苏");
  assert.equal(created.activeContact.approvalMode, "acceptEdits");
  assert.equal(Object.hasOwn(metadata, "approvalMode"), false);
  assert.ok(Number.isFinite(Date.parse(metadata.createdAt)));
  assert.match(metadata.sessionId, /^[0-9a-f-]{36}$/u);
  assert.equal(created.activeContact.sessionId, metadata.sessionId);
  assert.deepEqual(created.contacts.map((contact) => contact.name), ["小苏"]);
  await service.select({ id: created.activeContact.id });

  await fs.mkdir(path.join(contactsRoot, "not-a-contact"));
  const snapshot = await service.snapshot();
  assert.deepEqual(snapshot.contacts.map((contact) => contact.name), ["小苏"]);
  const duplicate = await service.create({ name: "小苏" });
  assert.equal(duplicate.activeContact.name, "小苏");
  assert.notEqual(duplicate.activeContact.id, created.activeContact.id);
  assert.equal(duplicate.preferredContact.id, created.activeContact.id);
});

test("renaming a contact only updates its contact metadata while preserving stable bindings", async () => {
  const contactsRoot = await temporaryDirectory("suzu-contact-rename-");
  let settings = { contactsRoot, projectRoot: "", preferredContactId: "" };
  const service = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
  });
  const created = await service.create({ name: "旧备注" });
  const original = created.activeContact;
  const claudePath = path.join(original.projectRoot, "CLAUDE.md");
  await fs.writeFile(claudePath, "# 旧备注\n", "utf8");

  const renamed = await service.rename({ id: original.id, name: "  新备注  " });
  const contact = renamed.contacts.find((item) => item.id === original.id);
  assert.equal(contact?.name, "新备注");
  assert.equal(contact?.agentId, original.agentId);
  assert.equal(contact?.projectRoot, original.projectRoot);
  assert.equal(contact?.sessionId, original.sessionId);
  assert.equal(renamed.activeContact?.id, original.id);
  assert.equal(renamed.activeContact?.name, "新备注");

  const metadataPath = path.join(original.projectRoot, ".suzu-lives", "contact.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  assert.equal(metadata.name, "新备注");
  assert.equal(metadata.id, original.id);
  assert.equal(metadata.agentId, original.agentId);
  assert.equal(metadata.sessionId, original.sessionId);
  assert.equal(await fs.readFile(claudePath, "utf8"), "# 旧备注\n");

  await assert.rejects(service.rename({ id: original.id, name: " " }), /填写联系人备注/u);
  assert.equal(JSON.parse(await fs.readFile(metadataPath, "utf8")).name, "新备注");
});

test("each contact persists its own Claude approval mode without changing its identity or presentation", async () => {
  const contactsRoot = await temporaryDirectory("suzu-contact-approval-mode-");
  let settings = { contactsRoot, projectRoot: "", preferredContactId: "" };
  const service = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
  });
  const created = await service.create({ name: "小苏" });
  const contact = created.activeContact;
  const metadataPath = path.join(contact.projectRoot, ".suzu-lives", "contact.json");

  const planned = await service.updateApprovalMode({ id: contact.id, approvalMode: "plan" });
  assert.equal(planned.activeContact?.approvalMode, "plan");
  assert.equal(JSON.parse(await fs.readFile(metadataPath, "utf8")).approvalMode, "plan");

  await service.rename({ id: contact.id, name: "新备注" });
  await service.updatePresentation({ id: contact.id, pinned: true });
  const preserved = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  assert.equal(preserved.approvalMode, "plan");
  assert.equal(preserved.pinned, true);

  const bypassed = await service.updateApprovalMode({ id: contact.id, approvalMode: "bypassPermissions" });
  assert.equal(bypassed.activeContact?.approvalMode, "bypassPermissions");
  await assert.rejects(service.updateApprovalMode({ id: contact.id, approvalMode: "everything" }), /审批模式无效/u);

  await service.updateApprovalMode({ id: contact.id, approvalMode: "acceptEdits" });
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(metadataPath, "utf8")), "approvalMode"), false);
});

test("contact presentation state is persisted by ID and deletion removes only the confirmed contact-owned data", async () => {
  const contactsRoot = await temporaryDirectory("suzu-contact-presentation-");
  const dataRoot = await temporaryDirectory("suzu-contact-data-");
  const homeDirectory = await temporaryDirectory("suzu-contact-home-");
  let settings = { contactsRoot, projectRoot: "", preferredContactId: "" };
  const cleanupCalls = [];
  const service = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
    dataRoot,
    homeDirectory,
    onBeforeRemove: async (contact) => { cleanupCalls.push(contact.id); },
  });
  const first = await service.create({ name: "一号" });
  const second = await service.create({ name: "二号" });
  const firstHistoryDirectories = claudeProjectDirectoryCandidates({
    projectRoot: first.activeContact.projectRoot,
    homeDirectory,
  });
  const secondHistoryDirectories = claudeProjectDirectoryCandidates({
    projectRoot: second.activeContact.projectRoot,
    homeDirectory,
  });
  const usableFirstHistoryDirectories = firstHistoryDirectories.filter((directory) => !path.basename(directory).includes(":"));
  const usableSecondHistoryDirectories = secondHistoryDirectories.filter((directory) => !path.basename(directory).includes(":"));
  for (const directory of usableFirstHistoryDirectories) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${first.activeContact.sessionId}.jsonl`), "first", "utf8");
  }
  for (const directory of usableSecondHistoryDirectories) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${second.activeContact.sessionId}.jsonl`), "second", "utf8");
  }
  const firstAgentData = resolveAgentDataRoot({ dataRoot, agentId: first.activeContact.agentId });
  const secondAgentData = resolveAgentDataRoot({ dataRoot, agentId: second.activeContact.agentId });
  await fs.mkdir(firstAgentData, { recursive: true });
  await fs.writeFile(path.join(firstAgentData, "private-memory.txt"), "first", "utf8");
  await fs.mkdir(secondAgentData, { recursive: true });
  await fs.writeFile(path.join(secondAgentData, "private-memory.txt"), "second", "utf8");

  const presented = await service.updatePresentation({
    id: second.activeContact.id,
    pinned: true,
    unread: true,
    muted: true,
    hidden: true,
  });
  const secondContact = presented.contacts.find((contact) => contact.id === second.activeContact.id);
  assert.deepEqual(presented.contacts.map((contact) => contact.id), [second.activeContact.id, first.activeContact.id]);
  assert.deepEqual(
    { hidden: secondContact?.hidden, pinned: secondContact?.pinned, unread: secondContact?.unread, muted: secondContact?.muted },
    { hidden: true, pinned: true, unread: true, muted: true },
  );

  await service.rename({ id: second.activeContact.id, name: "已改备注" });
  const metadataPath = path.join(second.activeContact.projectRoot, ".suzu-lives", "contact.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  assert.deepEqual(
    { hidden: metadata.hidden, pinned: metadata.pinned, unread: metadata.unread, muted: metadata.muted },
    { hidden: true, pinned: true, unread: true, muted: true },
  );

  const read = await service.updatePresentation({ id: second.activeContact.id, unread: false });
  const readContact = read.contacts.find((contact) => contact.id === second.activeContact.id);
  assert.deepEqual(
    { hidden: readContact?.hidden, pinned: readContact?.pinned, unread: readContact?.unread, muted: readContact?.muted },
    { hidden: true, pinned: true, unread: false, muted: true },
  );

  const restored = await service.updatePresentation({ id: second.activeContact.id, hidden: false });
  const restoredContact = restored.contacts.find((contact) => contact.id === second.activeContact.id);
  assert.equal(restoredContact?.hidden, false);
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(metadataPath, "utf8")), "hidden"), false);

  await assert.rejects(service.remove({ id: first.activeContact.id }), /明确确认/u);
  const removed = await service.remove({ id: first.activeContact.id, confirmed: true });
  await assert.rejects(fs.stat(first.activeContact.projectRoot), /ENOENT/u);
  await Promise.all(usableFirstHistoryDirectories.map((directory) => assert.rejects(fs.stat(directory), /ENOENT/u)));
  await assert.rejects(fs.stat(firstAgentData), /ENOENT/u);
  await Promise.all(usableSecondHistoryDirectories.map((directory) => fs.stat(directory)));
  await fs.stat(secondAgentData);
  assert.deepEqual(cleanupCalls, [first.activeContact.id]);
  assert.deepEqual(removed.contacts.map((contact) => contact.id), [second.activeContact.id]);
  assert.equal(settings.preferredContactId, second.activeContact.id);
  assert.equal(settings.projectRoot, second.activeContact.projectRoot);
});

test("renaming the owner only updates matching user profile titles", async () => {
  const contactsRoot = await temporaryDirectory("suzu-owner-profile-title-");
  let settings = { contactsRoot, projectRoot: "", preferredContactId: "" };
  const service = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
  });
  const first = await service.create({ name: "一号" });
  const second = await service.create({ name: "二号" });
  const firstProfile = path.join(first.activeContact.projectRoot, "user.md");
  const secondProfile = path.join(second.activeContact.projectRoot, "user.md");
  await fs.writeFile(firstProfile, "# 旧名字的核心档案\n\n旧名字在正文中不应被替换。\n", "utf8");
  await fs.writeFile(secondProfile, "# 自定义资料标题\n\n旧名字在正文中不应被替换。\n", "utf8");

  const result = await service.syncOwnerProfileTitle({ previousName: "旧名字", name: "新名字" });

  assert.equal(result.status, "synced");
  assert.deepEqual(result.contacts.map((contact) => contact.id), [first.activeContact.id]);
  assert.equal(await fs.readFile(firstProfile, "utf8"), "# 新名字的核心档案\n\n旧名字在正文中不应被替换。\n");
  assert.equal(await fs.readFile(secondProfile, "utf8"), "# 自定义资料标题\n\n旧名字在正文中不应被替换。\n");
});

test("first created contact becomes the default and changing it does not select a different chat", async () => {
  const contactsRoot = await temporaryDirectory("suzu-contact-preferred-");
  let settings = { contactsRoot, projectRoot: "", preferredContactId: "" };
  const service = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
  });

  const first = await service.create({ name: "Suzu" });
  const second = await service.create({ name: "工作" });
  const overwriteCreatedAt = async (contact, createdAt) => {
    const file = path.join(contact.activeContact.projectRoot, ".suzu-lives", "contact.json");
    const metadata = JSON.parse(await fs.readFile(file, "utf8"));
    metadata.createdAt = createdAt;
    await fs.writeFile(file, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  };
  await overwriteCreatedAt(first, "2026-08-01T00:00:00.000Z");
  await overwriteCreatedAt(second, "2026-08-02T00:00:00.000Z");
  settings = { ...settings, preferredContactId: "" };

  const initialized = await service.snapshot();
  assert.equal(initialized.preferredContact.id, first.activeContact.id);
  assert.equal(settings.preferredContactId, "");

  await service.select({ id: first.activeContact.id });
  const changed = await service.setPreferred({ id: second.activeContact.id });
  assert.equal(changed.activeContact.id, first.activeContact.id);
  assert.equal(changed.preferredContact.id, second.activeContact.id);
  assert.equal(settings.projectRoot, first.activeContact.projectRoot);
  assert.equal(settings.preferredContactId, second.activeContact.id);
});

test("contacts use generated project folders even for notes that cannot be Windows file names", async () => {
  const contactsRoot = await temporaryDirectory("suzu-contact-generated-folder-");
  let settings = { contactsRoot, projectRoot: "" };
  const service = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
  });

  const created = await service.create({ name: "AUX: / 小苏" });
  assert.equal(created.activeContact.name, "AUX: / 小苏");
  assert.match(path.basename(created.activeContact.projectRoot), /^contact-[a-f0-9-]{36}$/u);
});

test("new and existing contacts receive the shared Claude project defaults through the injected writer", async () => {
  const contactsRoot = await temporaryDirectory("suzu-contact-project-settings-");
  let settings = { contactsRoot, projectRoot: "" };
  const calls = [];
  const service = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
    ensureClaudeProjectSettings: async ({ projectRoot }) => {
      calls.push(projectRoot);
      return { changed: true, settingsPath: path.join(projectRoot, ".claude", "settings.json") };
    },
  });

  const first = await service.create({ name: "一号" });
  const second = await service.create({ name: "二号" });
  assert.deepEqual(calls, [first.activeContact.projectRoot, second.activeContact.projectRoot]);
  calls.length = 0;

  const synced = await service.syncClaudeProjectSettings();
  assert.equal(synced.status, "synced");
  assert.deepEqual(calls.sort(), [first.activeContact.projectRoot, second.activeContact.projectRoot].sort());
});

test("contact names remain concise visible remarks", () => {
  assert.equal(normalizeContactName("  阿澈  "), "阿澈");
  assert.equal(normalizeContactName("../outside"), "../outside");
  assert.equal(normalizeContactName("CON"), "CON");
  assert.throws(() => normalizeContactName(" "), /填写联系人备注/u);
});

test("changing the contacts root clears the active project instead of importing old projects", async () => {
  const firstRoot = await temporaryDirectory("suzu-contact-first-");
  const secondRoot = await temporaryDirectory("suzu-contact-second-");
  const canonicalSecondRoot = await fs.realpath(secondRoot);
  let settings = { contactsRoot: firstRoot, projectRoot: path.join(firstRoot, "existing") };
  const service = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
  });

  const snapshot = await service.selectRoot(secondRoot);
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.contacts.length, 0);
  assert.equal(settings.contactsRoot, canonicalSecondRoot);
  assert.equal(settings.preferredContactId, "");
  assert.equal(settings.projectRoot, "");
});
