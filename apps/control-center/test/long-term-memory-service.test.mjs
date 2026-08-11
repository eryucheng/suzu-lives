import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";
import { createMemoryService as createSuzuMemoryService } from "@suzu-memory/service";

import { createLongTermMemoryService } from "../electron/services/long-term-memory-service.mjs";

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("embedded long-term memory starts in a new contact database and archives a desktop turn", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-new-memory-"));
  const projectRoot = path.join(dataRoot, "contact-project");
  await fs.mkdir(projectRoot, { recursive: true });
  const contact = {
    id: "contact-fixture",
    name: "阿澄",
    agentId: "agent-fixture",
    projectRoot,
    sessionId: "desktop-session",
  };
  const settings = {
    projectRoot,
    identity: { owner: { displayName: "小林" } },
  };
  const conversationReader = {
    resolveContactSession: async (contactId) => ({
      contactId,
      id: contact.sessionId,
      projectRoot,
      hasTranscript: true,
    }),
  };
  const runtime = createLongTermMemoryService({
    conversationReader,
    settingsService: {
      load: () => settings,
      response: () => ({ ...settings, dataRoot }),
    },
    contactProjectsService: {
      snapshot: async () => ({ status: "ready", contacts: [contact], activeContact: contact }),
    },
    connectionsService: {
      resolveNamedApiConnection: async () => null,
    },
  });

  const turn = await runtime.prepareTurn({
    sessionId: "desktop-session",
    turnId: "turn-1",
    projectRoot,
    userText: "我周五要去看展。",
    occurredAt: "2026-08-10T10:00:00.000Z",
  });
  assert.ok(turn);
  assert.equal(turn.systemPrompt, "");
  await runtime.completeTurn(turn, {
    assistantText: "好，我记住了。",
    occurredAt: "2026-08-10T10:01:00.000Z",
  });

  const agentRoot = resolveAgentDataRoot({ dataRoot, agentId: contact.agentId });
  const newDatabasePath = path.join(agentRoot, "memory", "sessions", "desktop-session", "suzu-memory.db");
  const legacyDatabasePath = path.join(agentRoot, "memory", "memory.db");
  const legacyContactDatabasePath = path.join(agentRoot, "memory", "suzu-memory.db");
  assert.equal(await exists(newDatabasePath), true);
  assert.equal(await exists(legacyDatabasePath), false);
  assert.equal(await exists(legacyContactDatabasePath), false);

  const reviewOverview = await runtime.reviewOverview({
    contactId: contact.id,
    types: ["ingestion", "reported-state", "structure", "relation", "maintenance-failure"],
    reviewStates: ["pending"],
  });
  assert.equal(reviewOverview.status, "ready");
  assert.equal(reviewOverview.storage.activeDatabase.status, "valid");
  const backup = await runtime.createReviewBackup({ contactId: contact.id });
  assert.equal(backup.status, "valid");

  const stored = createSuzuMemoryService({
    dataRoot,
    agentId: contact.agentId,
    databasePath: newDatabasePath,
  });
  const events = stored.listInputEvents({
    statuses: [],
    limit: 10,
  });
  assert.equal(events.total, 2);
  assert.deepEqual(events.items.map((event) => event.content.text).sort(), [
    "好，我记住了。",
    "我周五要去看展。",
  ].sort());
  runtime.dispose();
});

test("embedded long-term memory keeps contacts' fixed Claude sessions in separate brains", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-session-memory-"));
  const firstContact = {
    id: "contact-one",
    name: "阿澄",
    agentId: "agent-one",
    projectRoot: path.join(dataRoot, "contact-one"),
    sessionId: "session-one",
  };
  const secondContact = {
    id: "contact-two",
    name: "工作",
    agentId: "agent-two",
    projectRoot: path.join(dataRoot, "contact-two"),
    sessionId: "session-two",
  };
  await Promise.all([
    fs.mkdir(firstContact.projectRoot, { recursive: true }),
    fs.mkdir(secondContact.projectRoot, { recursive: true }),
  ]);
  const contacts = [firstContact, secondContact];
  const runtime = createLongTermMemoryService({
    conversationReader: {
      resolveContactSession: async (contactId) => {
        const contact = contacts.find((item) => item.id === contactId);
        return {
          contactId,
          id: contact?.sessionId || "",
          projectRoot: contact?.projectRoot || "",
          hasTranscript: Boolean(contact),
        };
      },
    },
    settingsService: {
      load: () => ({ projectRoot: firstContact.projectRoot, identity: { owner: { displayName: "小林" } } }),
      response: () => ({ dataRoot, projectRoot: firstContact.projectRoot }),
    },
    contactProjectsService: {
      snapshot: async () => ({
        status: "ready",
        contacts,
        activeContact: firstContact,
        preferredContact: firstContact,
      }),
    },
    connectionsService: {
      resolveNamedApiConnection: async () => null,
    },
  });

  for (const contact of contacts) {
    const turn = await runtime.prepareTurn({
      sessionId: contact.sessionId,
      turnId: `turn-${contact.sessionId}`,
      projectRoot: contact.projectRoot,
      userText: `${contact.name}的用户消息`,
      occurredAt: "2026-08-10T10:00:00.000Z",
    });
    assert.ok(turn);
    await runtime.completeTurn(turn, {
      assistantText: `${contact.name}的回复`,
      occurredAt: "2026-08-10T10:01:00.000Z",
    });
  }

  const firstDatabasePath = path.join(
    resolveAgentDataRoot({ dataRoot, agentId: firstContact.agentId }),
    "memory",
    "sessions",
    firstContact.sessionId,
    "suzu-memory.db",
  );
  const secondDatabasePath = path.join(
    resolveAgentDataRoot({ dataRoot, agentId: secondContact.agentId }),
    "memory",
    "sessions",
    secondContact.sessionId,
    "suzu-memory.db",
  );
  assert.equal(await exists(firstDatabasePath), true);
  assert.equal(await exists(secondDatabasePath), true);
  assert.notEqual(firstDatabasePath, secondDatabasePath);

  const firstStore = createSuzuMemoryService({
    dataRoot,
    agentId: firstContact.agentId,
    databasePath: firstDatabasePath,
  });
  firstStore.initialize();
  firstStore.withRepository((repository) => repository.upsertMemory({
    id: "only-session-one",
    agentId: firstContact.agentId,
    kind: "event",
    layer: "long_term",
    title: "第一条会话独有记忆",
    content: "这条记忆不应出现在第二条会话的大脑中。",
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    evidenceMode: "explicit",
    recordedAt: "2026-08-10T10:02:00.000Z",
    status: "active",
  }));

  const [firstBrain, secondBrain, firstStatus, secondStatus] = await Promise.all([
    runtime.brainGraph({ contactId: firstContact.id }),
    runtime.brainGraph({ contactId: secondContact.id }),
    runtime.status({ contactId: firstContact.id }),
    runtime.status({ contactId: secondContact.id }),
  ]);
  assert.ok(firstBrain.nodes.some((node) => node.id === "only-session-one"));
  assert.equal(secondBrain.nodes.some((node) => node.id === "only-session-one"), false);
  assert.equal(firstStatus.selectedContactId, firstContact.id);
  assert.equal(secondStatus.selectedContactId, secondContact.id);
  assert.equal(Object.hasOwn(firstStatus, "selectedSessionId"), false);
  runtime.dispose();
});

test("memory page scopes by contact without exposing a native session title", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-contact-memory-"));
  const suzu = {
    id: "contact-suzu",
    name: "Suzu",
    agentId: "agent-suzu",
    projectRoot: path.join(dataRoot, "contact-suzu"),
    sessionId: "suzu-session",
  };
  const work = {
    id: "contact-work",
    name: "工作",
    agentId: "agent-work",
    projectRoot: path.join(dataRoot, "contact-work"),
    sessionId: "work-session",
  };
  await Promise.all([fs.mkdir(suzu.projectRoot, { recursive: true }), fs.mkdir(work.projectRoot, { recursive: true })]);
  const settings = { projectRoot: work.projectRoot, identity: { owner: { displayName: "小林" } } };
  const contactsSnapshot = async () => ({
    status: "ready",
    contacts: [suzu, work],
    activeContact: work,
    preferredContact: suzu,
  });
  const conversationReader = {
    resolveContactSession: async (contactId) => {
      const contact = [suzu, work].find((item) => item.id === contactId);
      return {
        contactId,
        id: contact?.sessionId || "",
        projectRoot: contact?.projectRoot || "",
        hasTranscript: Boolean(contact),
      };
    },
  };
  const runtime = createLongTermMemoryService({
    conversationReader,
    settingsService: {
      load: () => settings,
      response: () => ({ ...settings, dataRoot }),
    },
    contactProjectsService: { snapshot: contactsSnapshot },
    connectionsService: { resolveNamedApiConnection: async () => null },
  });

  const [defaultStatus, suzuStatus, workStatus] = await Promise.all([
    runtime.status(),
    runtime.status({ contactId: suzu.id }),
    runtime.status({ contactId: work.id }),
  ]);
  assert.deepEqual(suzuStatus.contacts, [
    { id: suzu.id, name: suzu.name },
    { id: work.id, name: work.name },
  ]);
  assert.equal(suzuStatus.selectedContactId, suzu.id);
  assert.equal(workStatus.selectedContactId, work.id);
  assert.equal(defaultStatus.selectedContactId, suzu.id);
  assert.equal(Object.hasOwn(suzuStatus, "sessions"), false);
  assert.equal(Object.hasOwn(suzuStatus, "selectedSession"), false);
  assert.equal(Object.hasOwn(suzuStatus, "selectedSessionId"), false);
  assert.doesNotMatch(JSON.stringify(suzuStatus), /你好/u);

  const suzuDatabasePath = path.join(
    resolveAgentDataRoot({ dataRoot, agentId: suzu.agentId }),
    "memory",
    "sessions",
    suzu.sessionId,
    "suzu-memory.db",
  );
  const store = createSuzuMemoryService({ dataRoot, agentId: suzu.agentId, databasePath: suzuDatabasePath });
  store.initialize();
  store.withRepository((repository) => repository.upsertMemory({
    id: "suzu-only-memory",
    agentId: suzu.agentId,
    kind: "event",
    layer: "long_term",
    title: "Suzu 的记忆",
    content: "这条记忆不能出现在工作联系人中。",
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    evidenceMode: "explicit",
    recordedAt: "2026-08-10T10:00:00.000Z",
    status: "active",
  }));

  const [suzuBrain, workBrain] = await Promise.all([
    runtime.brainGraph({ contactId: suzu.id }),
    runtime.brainGraph({ contactId: work.id }),
  ]);
  assert.ok(suzuBrain.nodes.some((node) => node.id === "suzu-only-memory"));
  assert.equal(workBrain.nodes.some((node) => node.id === "suzu-only-memory"), false);
  assert.equal(settings.projectRoot, work.projectRoot);
  runtime.dispose();
});
