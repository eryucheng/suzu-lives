import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";
import { createMemoryService as createSuzuMemoryService } from "@suzu-memory/service";

import {
  createLongTermMemoryService,
  memoryGenerationConnection,
} from "../electron/services/long-term-memory-service.mjs";

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("DeepSeek Anthropic memory extraction disables thinking before forcing a structured tool", () => {
  const connection = memoryGenerationConnection({
    type: "anthropic-compatible",
    apiKey: "test-key",
    baseUrl: "https://api.deepseek.com/anthropic",
    model: "deepseek-v4-flash",
  });
  assert.deepEqual(connection?.extraBody, { thinking: { type: "disabled" } });

  const explicitlyConfigured = memoryGenerationConnection({
    type: "anthropic-compatible",
    apiKey: "test-key",
    baseUrl: "https://api.deepseek.com/anthropic",
    model: "deepseek-v4-flash",
    extraBody: { thinking: { type: "enabled" } },
  });
  assert.deepEqual(explicitlyConfigured?.extraBody, { thinking: { type: "enabled" } });

  const unrelated = memoryGenerationConnection({
    type: "anthropic-compatible",
    apiKey: "test-key",
    baseUrl: "https://api.example.test/anthropic",
    model: "fixture-model",
  });
  assert.equal(unrelated?.extraBody, undefined);
});

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
  assert.equal(Object.hasOwn(turn, "systemPrompt"), false);
  assert.equal(Object.hasOwn(turn, "prepared"), false);
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
  const inspectedBackup = await runtime.inspectReviewBackup({
    contactId: contact.id,
    sourcePath: backup.databasePath,
  });
  assert.equal(inspectedBackup.status, "valid");
  const restoredBackup = await runtime.restoreReviewBackup({
    contactId: contact.id,
    sourcePath: backup.databasePath,
  });
  assert.equal(restoredBackup.status, "restored");
  assert.equal(restoredBackup.safetyBackup.status, "valid");

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

test("a contact with long-term memory disabled neither archives nor recalls automatic chat memory", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-disabled-memory-"));
  const projectRoot = path.join(dataRoot, "contact-project");
  await fs.mkdir(projectRoot, { recursive: true });
  const contact = {
    id: "contact-disabled",
    name: "不记录",
    agentId: "agent-disabled",
    longTermMemoryEnabled: false,
    projectRoot,
    sessionId: "disabled-session",
  };
  const settings = { projectRoot };
  const runtime = createLongTermMemoryService({
    settingsService: {
      load: () => settings,
      response: () => ({ ...settings, dataRoot }),
    },
    contactProjectsService: {
      snapshot: async () => ({ status: "ready", contacts: [contact], activeContact: contact }),
    },
    connectionsService: { resolveNamedApiConnection: async () => null },
  });

  const prepared = await runtime.prepareTurn({
    sessionId: contact.sessionId,
    turnId: "disabled-turn",
    projectRoot,
    userText: "这一轮不要进入长期记忆。",
  });
  const recalled = await runtime.recallForUserPrompt({
    sessionId: contact.sessionId,
    turnId: "disabled-hook",
    projectRoot,
    userText: "也不要召回旧记忆。",
  });
  const databasePath = path.join(
    resolveAgentDataRoot({ dataRoot, agentId: contact.agentId }),
    "memory",
    "sessions",
    contact.sessionId,
    "suzu-memory.db",
  );

  assert.equal(prepared, null);
  assert.equal(recalled, null);
  assert.equal(await exists(databasePath), false);
  runtime.dispose();
});

test("memory import stages the source before initializing a conflicting target identity", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-memory-import-stage-"));
  const contact = {
    id: "contact-suzu",
    name: "Suzu",
    agentId: "agent-target",
    projectRoot: path.join(dataRoot, "contact-suzu"),
    sessionId: "suzu-session",
  };
  await fs.mkdir(contact.projectRoot, { recursive: true });
  const targetDatabasePath = path.join(
    resolveAgentDataRoot({ dataRoot, agentId: contact.agentId }),
    "memory",
    "sessions",
    contact.sessionId,
    "suzu-memory.db",
  );
  const oldTarget = createSuzuMemoryService({
    dataRoot,
    agentId: contact.agentId,
    databasePath: targetDatabasePath,
    defaults: { companionId: contact.agentId, memoryOwner: "旧联系人" },
  });
  oldTarget.initialize();
  oldTarget.withRepository((repository) => repository.upsertEntity({
    agentId: contact.agentId,
    kind: "agent",
    canonicalName: "Suzu",
  }));

  const source = createSuzuMemoryService({
    dataRoot: await fs.mkdtemp(path.join(os.tmpdir(), "suzu-memory-import-source-")),
    agentId: "agent-source",
    defaults: { companionId: "agent-source", memoryOwner: "旧来源" },
  });
  source.initialize();

  const runtime = createLongTermMemoryService({
    conversationReader: {
      resolveContactSession: async () => ({
        contactId: contact.id,
        id: contact.sessionId,
        projectRoot: contact.projectRoot,
        hasTranscript: true,
      }),
    },
    settingsService: {
      load: () => ({ projectRoot: contact.projectRoot, identity: { owner: { displayName: "小林" } } }),
      response: () => ({ dataRoot, projectRoot: contact.projectRoot }),
    },
    contactProjectsService: {
      snapshot: async () => ({ contacts: [contact], activeContact: contact }),
    },
    connectionsService: { resolveNamedApiConnection: async () => null },
  });

  const inspection = await runtime.inspectMemoryImport({
    contactId: contact.id,
    sourcePath: source.paths.databasePath,
  });
  assert.deepEqual(inspection.agentIds, ["agent-source"]);

  const imported = await runtime.importMemoryDatabase({
    contactId: contact.id,
    sourcePath: source.paths.databasePath,
  });
  assert.equal(imported.status, "imported");
  assert.equal(imported.targetAgentId, contact.agentId);
  assert.deepEqual(imported.imported.agentIds, [contact.agentId]);
  runtime.dispose();
});

test("startup recovery drains every queued maintenance batch for an existing contact brain", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-memory-recovery-"));
  const contact = {
    id: "contact-recovery",
    name: "恢复验证",
    agentId: "agent-recovery",
    projectRoot: path.join(dataRoot, "contact-recovery"),
    sessionId: "recovery-session",
  };
  await fs.mkdir(contact.projectRoot, { recursive: true });
  const databasePath = path.join(
    resolveAgentDataRoot({ dataRoot, agentId: contact.agentId }),
    "memory",
    "sessions",
    contact.sessionId,
    "suzu-memory.db",
  );
  const stored = createSuzuMemoryService({
    dataRoot,
    agentId: contact.agentId,
    databasePath,
  });
  stored.initialize();
  stored.withRepository((repository) => {
    for (let index = 0; index < 11; index += 1) {
      const memoryId = `recovery-memory-${index}`;
      repository.upsertMemory({
        id: memoryId,
        agentId: contact.agentId,
        kind: "event",
        layer: "long_term",
        title: `恢复记忆 ${index}`,
        content: `这是一条需要补齐向量任务的历史记忆 ${index}。`,
        subjectRole: index % 2 ? "agent" : "user",
        subjectKey: index % 2 ? contact.agentId : "user",
        reality: "real",
        evidenceMode: "explicit",
        recordedAt: `2026-08-10T10:${String(index).padStart(2, "0")}:00.000Z`,
        status: "active",
      });
      repository.enqueueMaintenanceTask({
        agentId: contact.agentId,
        lane: "embedding",
        taskType: "memory-embedding",
        payload: { memoryIds: [memoryId] },
      });
    }
    const interrupted = repository.listMaintenanceTasks(contact.agentId, {
      lanes: ["embedding"],
      statuses: ["pending"],
      limit: 1,
    })[0];
    repository.claimMaintenanceTasks({
      agentId: contact.agentId,
      lane: "embedding",
      taskTypes: ["memory-embedding"],
      maximumTasks: 1,
      workerId: "interrupted-desktop-process",
      leaseSeconds: 3600,
    });
    assert.equal(repository.getMaintenanceTask(contact.agentId, interrupted.id).status, "running");
  });

  const originalFetch = globalThis.fetch;
  let embeddingRequests = 0;
  globalThis.fetch = async (_url, request) => {
    embeddingRequests += 1;
    const body = JSON.parse(request.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => "" },
      text: async () => JSON.stringify({
        model: "recovery-embedding",
        data: body.input.map((_text, index) => ({ index, embedding: [1, index + 1, 0.5] })),
        usage: {},
      }),
    };
  };
  try {
    const runtime = createLongTermMemoryService({
      conversationReader: {
        resolveContactSession: async (contactId) => ({
          contactId,
          id: contact.sessionId,
          projectRoot: contact.projectRoot,
          hasTranscript: true,
        }),
      },
      settingsService: {
        load: () => ({ projectRoot: contact.projectRoot }),
        response: () => ({ dataRoot, projectRoot: contact.projectRoot }),
      },
      contactProjectsService: {
        snapshot: async () => ({ contacts: [contact], activeContact: contact }),
      },
      connectionsService: {
        resolveNamedApiConnection: async (feature) => feature === "memory-embedding"
          ? {
            type: "openai-compatible",
            apiKey: "test-key",
            baseUrl: "https://memory.test/v1",
            model: "recovery-embedding",
          }
          : null,
      },
    });
    const resumed = await runtime.resumeExistingMaintenance();
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].recoveredMaintenanceTasks, 1);
    assert.equal(resumed[0].failedMaintenanceTasks, 0);
    assert.equal(resumed[0].result.status, "completed");
    assert.equal(resumed[0].result.passes, 2);
    assert.equal(resumed[0].result.graphRebuilt, true);
    assert.equal(embeddingRequests, 2);
    const status = stored.maintenanceStatus({ limit: 50 });
    assert.equal(status.tasks.some((task) => ["pending", "running"].includes(task.status)), false);
    assert.equal(stored.withRepository((repository) => repository.listEmbeddings(
      contact.agentId,
      "recovery-embedding",
    ).length), 11);
    runtime.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
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
