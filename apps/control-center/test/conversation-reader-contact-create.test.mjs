import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createConversationReader } from "../electron/services/conversation-reader.mjs";

test("conversation reader preserves the created contact identity independently of the active selection", async () => {
  const createdContact = {
    id: "contact-created",
    projectRoot: path.resolve("contact-created"),
  };
  const selectedContact = {
    id: "contact-selected",
    name: "当前打开的联系人",
    projectRoot: path.resolve("contact-selected"),
    sessionId: "session-selected",
  };
  const initialized = [];
  const reader = createConversationReader({
    contactProjectsService: {
      async create() {
        return { createdContact };
      },
      async snapshot() {
        return {
          status: "ready",
          contactsRoot: path.resolve("contacts"),
          contacts: [{ ...createdContact, name: "新建联系人", sessionId: "session-created" }, selectedContact],
          activeContact: selectedContact,
          preferredContact: selectedContact,
        };
      },
    },
    messageDeletionStore: {
      async list() { return { entries: [], revision: "" }; },
      async markDeleted() { return { entries: [], revision: "" }; },
    },
    onContactCreated: async (contact) => initialized.push(contact),
    runtime: {
      async history() { return { events: [], hasMore: false }; },
    },
    settingsService: { load: () => ({ projectRoot: selectedContact.projectRoot }) },
  });

  const result = await reader.createContact({ name: "新建联系人" });

  assert.deepEqual(initialized, [createdContact]);
  assert.deepEqual(result.createdContact, { id: "contact-created" });
  assert.equal(result.activeContact.id, "contact-selected");
});

test("conversation reader never opens history for a hidden active contact", async () => {
  const hiddenContact = {
    hidden: true,
    id: "contact-hidden",
    name: "已隐藏联系人",
    projectRoot: path.resolve("contact-hidden"),
    sessionId: "session-hidden",
  };
  let historyCalls = 0;
  const reader = createConversationReader({
    contactProjectsService: {
      async snapshot() {
        return {
          status: "ready",
          contactsRoot: path.resolve("contacts"),
          contacts: [hiddenContact],
          activeContact: hiddenContact,
          preferredContact: hiddenContact,
        };
      },
    },
    messageDeletionStore: {
      async list() { return { entries: [], revision: "" }; },
      async markDeleted() { return { entries: [], revision: "" }; },
    },
    runtime: {
      async history() { historyCalls += 1; return { events: [], hasMore: false }; },
    },
    settingsService: { load: () => ({ projectRoot: hiddenContact.projectRoot }) },
  });

  const snapshot = await reader.snapshot();

  assert.equal(snapshot.activeContact, null);
  assert.deepEqual(snapshot.contacts, []);
  assert.equal(snapshot.hiddenContactCount, 1);
  assert.equal(snapshot.projectRoot, "");
  assert.equal(snapshot.activeSessionId, "");
  assert.equal(historyCalls, 0);
});
