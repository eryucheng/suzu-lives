import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createContactProjectsService, normalizeContactName } from "../electron/services/contact-projects.mjs";
import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("contacts default to the managed contacts directory below Suzu data", async () => {
  const dataRoot = await temporaryDirectory("suzu-contact-managed-root-");
  let settings = { contactsRoot: "", preferredContactId: "", projectRoot: "" };
  const service = createContactProjectsService({
    dataRoot,
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
  });

  const initial = await service.snapshot();
  const expectedRoot = await fs.realpath(path.join(dataRoot, "contacts"));
  assert.equal(initial.status, "ready");
  assert.equal(initial.contactsRoot, expectedRoot);
  assert.equal(settings.contactsRoot, expectedRoot);
  await fs.stat(expectedRoot);

  const created = await service.create({ name: "小苏" });
  assert.equal(path.dirname(created.activeContact.projectRoot), expectedRoot);
});

test("contacts are Suzu workspaces directly below the configured contacts root", async () => {
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
  assert.equal(await fs.readFile(path.join(projectRoot, "SUZU.md"), "utf8"), "");
  const metadata = JSON.parse(await fs.readFile(path.join(projectRoot, ".suzu-lives", "contact.json"), "utf8"));
  assert.equal(metadata.version, 1);
  assert.equal(metadata.id, created.activeContact.id);
  assert.equal(metadata.name, "小苏");
  assert.equal(Object.hasOwn(created.activeContact, "approvalMode"), false);
  assert.equal(created.activeContact.longTermMemoryEnabled, true);
  assert.equal(created.activeContact.permissionMode, "danger-full-access");
  assert.equal(Object.hasOwn(metadata, "approvalMode"), false);
  assert.equal(Object.hasOwn(metadata, "longTermMemoryEnabled"), false);
  assert.equal(metadata.permissionMode, "danger-full-access");
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
  const suzuPath = path.join(original.projectRoot, "SUZU.md");
  await fs.writeFile(suzuPath, "# 旧备注\n", "utf8");

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
  assert.equal(await fs.readFile(suzuPath, "utf8"), "# 旧备注\n");

  await assert.rejects(service.rename({ id: original.id, name: " " }), /填写联系人备注/u);
  assert.equal(JSON.parse(await fs.readFile(metadataPath, "utf8")).name, "新备注");
});

test("each contact can independently stop automatic long-term memory without deleting its existing data", async () => {
  const contactsRoot = await temporaryDirectory("suzu-contact-long-term-memory-");
  let settings = { contactsRoot, projectRoot: "", preferredContactId: "" };
  const service = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
  });
  const created = await service.create({ name: "小苏" });
  const contact = created.activeContact;
  const metadataPath = path.join(contact.projectRoot, ".suzu-lives", "contact.json");

  const disabled = await service.updateLongTermMemoryEnabled({ id: contact.id, enabled: false });
  assert.equal(disabled.activeContact?.longTermMemoryEnabled, false);
  assert.equal(JSON.parse(await fs.readFile(metadataPath, "utf8")).longTermMemoryEnabled, false);

  await service.rename({ id: contact.id, name: "新备注" });
  await service.updatePresentation({ id: contact.id, muted: true });
  const preserved = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  assert.equal(preserved.longTermMemoryEnabled, false);
  assert.equal(preserved.muted, true);

  const enabled = await service.updateLongTermMemoryEnabled({ id: contact.id, enabled: true });
  assert.equal(enabled.activeContact?.longTermMemoryEnabled, true);
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(metadataPath, "utf8")), "longTermMemoryEnabled"), false);
  await assert.rejects(service.updateLongTermMemoryEnabled({ id: contact.id, enabled: "yes" }), /长期记忆开关无效/u);
});

test("contact presentation state is persisted by ID and deletion removes only the confirmed contact-owned data", async () => {
  const contactsRoot = await temporaryDirectory("suzu-contact-presentation-");
  const dataRoot = await temporaryDirectory("suzu-contact-data-");
  let settings = { contactsRoot, projectRoot: "", preferredContactId: "" };
  const cleanupCalls = [];
  const service = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
    dataRoot,
    onBeforeRemove: async (contact) => { cleanupCalls.push(contact.id); },
  });
  const first = await service.create({ name: "一号" });
  const second = await service.create({ name: "二号" });
  const firstAgentData = resolveAgentDataRoot({ dataRoot, agentId: first.activeContact.agentId });
  const secondAgentData = resolveAgentDataRoot({ dataRoot, agentId: second.activeContact.agentId });
  await fs.mkdir(firstAgentData, { recursive: true });
  await fs.writeFile(path.join(firstAgentData, "private-memory.txt"), "first", "utf8");
  await fs.mkdir(secondAgentData, { recursive: true });
  await fs.writeFile(path.join(secondAgentData, "private-memory.txt"), "second", "utf8");

  const presented = await service.updatePresentation({
    id: second.activeContact.id,
    pinned: true,
    unreadCount: 1,
    muted: true,
    hidden: true,
  });
  const secondContact = presented.contacts.find((contact) => contact.id === second.activeContact.id);
  assert.deepEqual(presented.contacts.map((contact) => contact.id), [second.activeContact.id, first.activeContact.id]);
  assert.deepEqual(
    { hidden: secondContact?.hidden, pinned: secondContact?.pinned, unread: secondContact?.unread, unreadCount: secondContact?.unreadCount, muted: secondContact?.muted },
    { hidden: true, pinned: true, unread: true, unreadCount: 1, muted: true },
  );

  const incremented = await service.updatePresentation({ id: second.activeContact.id, unreadIncrement: 104 });
  const incrementedContact = incremented.contacts.find((contact) => contact.id === second.activeContact.id);
  assert.equal(incrementedContact?.unreadCount, 105);

  await service.rename({ id: second.activeContact.id, name: "已改备注" });
  const metadataPath = path.join(second.activeContact.projectRoot, ".suzu-lives", "contact.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  assert.deepEqual(
    { hidden: metadata.hidden, pinned: metadata.pinned, unreadCount: metadata.unreadCount, muted: metadata.muted },
    { hidden: true, pinned: true, unreadCount: 105, muted: true },
  );
  assert.equal(Object.hasOwn(metadata, "unread"), false);

  const read = await service.updatePresentation({ id: second.activeContact.id, unreadCount: 0 });
  const readContact = read.contacts.find((contact) => contact.id === second.activeContact.id);
  assert.deepEqual(
    { hidden: readContact?.hidden, pinned: readContact?.pinned, unread: readContact?.unread, unreadCount: readContact?.unreadCount, muted: readContact?.muted },
    { hidden: true, pinned: true, unread: false, unreadCount: 0, muted: true },
  );
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(metadataPath, "utf8")), "unreadCount"), false);

  const restored = await service.updatePresentation({ id: second.activeContact.id, hidden: false });
  const restoredContact = restored.contacts.find((contact) => contact.id === second.activeContact.id);
  assert.equal(restoredContact?.hidden, false);
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(metadataPath, "utf8")), "hidden"), false);

  await assert.rejects(service.remove({ id: first.activeContact.id }), /明确确认/u);
  const removed = await service.remove({ id: first.activeContact.id, confirmed: true });
  await assert.rejects(fs.stat(first.activeContact.projectRoot), /ENOENT/u);
  await assert.rejects(fs.stat(firstAgentData), /ENOENT/u);
  await fs.stat(secondAgentData);
  assert.deepEqual(cleanupCalls, [first.activeContact.id]);
  assert.deepEqual(removed.contacts.map((contact) => contact.id), [second.activeContact.id]);
  assert.equal(settings.preferredContactId, second.activeContact.id);
  assert.equal(settings.projectRoot, second.activeContact.projectRoot);
});

test("unread counts reject the former boolean flag", async () => {
  const contactsRoot = await temporaryDirectory("suzu-contact-unread-count-");
  let settings = { contactsRoot, projectRoot: "", preferredContactId: "" };
  const service = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
  });
  const created = await service.create({ name: "小苏" });
  await assert.rejects(service.updatePresentation({ id: created.activeContact.id, unread: true }), /unreadCount/u);
  await assert.rejects(service.updatePresentation({ id: created.activeContact.id, unreadCount: -1 }), /未读数无效/u);
  await assert.rejects(service.updatePresentation({ id: created.activeContact.id, unreadCount: 1, unreadIncrement: 1 }), /不能同时指定/u);
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

test("new and existing contacts receive injected Suzu workspace defaults", async () => {
  const contactsRoot = await temporaryDirectory("suzu-contact-project-settings-");
  let settings = { contactsRoot, projectRoot: "" };
  const calls = [];
  const service = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
    ensureContactProjectSettings: async ({ projectRoot }) => {
      calls.push(projectRoot);
      return { changed: true, settingsPath: path.join(projectRoot, ".suzu-lives", "runtime.json") };
    },
  });

  const first = await service.create({ name: "一号" });
  const second = await service.create({ name: "二号" });
  assert.deepEqual(calls, [first.activeContact.projectRoot, second.activeContact.projectRoot]);
  calls.length = 0;

  const synced = await service.syncContactProjectSettings();
  assert.equal(synced.status, "synced");
  assert.deepEqual(calls.sort(), [first.activeContact.projectRoot, second.activeContact.projectRoot].sort());
});

test("contact names remain concise visible remarks", () => {
  assert.equal(normalizeContactName("  阿澈  "), "阿澈");
  assert.equal(normalizeContactName("../outside"), "../outside");
  assert.equal(normalizeContactName("CON"), "CON");
  assert.throws(() => normalizeContactName(" "), /填写联系人备注/u);
});

test("each contact persists its own Agent approval mode and defaults to full access", async () => {
  const contactsRoot = await temporaryDirectory("suzu-contact-permission-mode-");
  let settings = { contactsRoot, projectRoot: "", preferredContactId: "" };
  const service = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
  });
  const first = await service.create({ name: "小苏" });
  const second = await service.create({ name: "工作" });
  const firstId = first.activeContact.id;
  const secondId = second.activeContact.id;

  const updated = await service.updatePermissionMode({ id: firstId, permissionMode: "read-only" });
  assert.equal(updated.contacts.find((contact) => contact.id === firstId)?.permissionMode, "read-only");
  assert.equal(updated.contacts.find((contact) => contact.id === secondId)?.permissionMode, "danger-full-access");

  const metadataPath = path.join(first.activeContact.projectRoot, ".suzu-lives", "contact.json");
  assert.equal(JSON.parse(await fs.readFile(metadataPath, "utf8")).permissionMode, "read-only");
  await service.rename({ id: firstId, name: "新的备注" });
  assert.equal(JSON.parse(await fs.readFile(metadataPath, "utf8")).permissionMode, "read-only");

  await assert.rejects(
    service.updatePermissionMode({ id: firstId, permissionMode: "everything" }),
    /审批模式无效/u,
  );
});
