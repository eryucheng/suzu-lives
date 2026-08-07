import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createContactProjectsService, normalizeContactName } from "../electron/services/contact-projects.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("contacts are normal Claude projects directly below the selected contacts root", async () => {
  const contactsRoot = await temporaryDirectory("suzu-contact-projects-");
  const canonicalRoot = await fs.realpath(contactsRoot);
  let settings = { contactsRoot, projectRoot: "D:/old-project", conversationSessionId: "old-session" };
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
  assert.equal(settings.conversationSessionId, "");
  assert.equal(await fs.readFile(path.join(projectRoot, "CLAUDE.md"), "utf8"), "# 小苏\n");
  const metadata = JSON.parse(await fs.readFile(path.join(projectRoot, ".suzu-lives", "contact.json"), "utf8"));
  assert.equal(metadata.version, 1);
  assert.equal(metadata.id, created.activeContact.id);
  assert.equal(metadata.name, "小苏");
  assert.ok(Number.isFinite(Date.parse(metadata.createdAt)));
  assert.deepEqual(created.contacts.map((contact) => contact.name), ["小苏"]);

  await fs.mkdir(path.join(contactsRoot, "not-a-contact"));
  const snapshot = await service.snapshot();
  assert.deepEqual(snapshot.contacts.map((contact) => contact.name), ["小苏"]);
  const duplicate = await service.create({ name: "小苏" });
  assert.equal(duplicate.activeContact.name, "小苏");
  assert.notEqual(duplicate.activeContact.id, created.activeContact.id);
});

test("contacts use generated project folders even for notes that cannot be Windows file names", async () => {
  const contactsRoot = await temporaryDirectory("suzu-contact-generated-folder-");
  let settings = { contactsRoot, projectRoot: "", conversationSessionId: "" };
  const service = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
  });

  const created = await service.create({ name: "AUX: / 小苏" });
  assert.equal(created.activeContact.name, "AUX: / 小苏");
  assert.match(path.basename(created.activeContact.projectRoot), /^contact-[a-f0-9-]{36}$/u);
});

test("new and existing contacts receive the shared Claude project defaults through the injected writer", async () => {
  const contactsRoot = await temporaryDirectory("suzu-contact-project-settings-");
  let settings = { contactsRoot, projectRoot: "", conversationSessionId: "" };
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
  let settings = { contactsRoot: firstRoot, projectRoot: path.join(firstRoot, "existing"), conversationSessionId: "old-session" };
  const service = createContactProjectsService({
    settingsService: { load: () => settings, save: (next) => { settings = next; return settings; } },
  });

  const snapshot = await service.selectRoot(secondRoot);
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.contacts.length, 0);
  assert.equal(settings.contactsRoot, canonicalSecondRoot);
  assert.equal(settings.projectRoot, "");
  assert.equal(settings.conversationSessionId, "");
});
