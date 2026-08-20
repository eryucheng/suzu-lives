import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";
import { createMemoryService } from "@suzu-memory/service";

import {
  createLongTermMemoryService,
  memoryRecallContextText,
} from "../electron/services/long-term-memory-service.mjs";

async function temporaryDirectory(prefix) {
  const root = process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp";
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, prefix));
}

async function waitFor(assertion, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (assertion()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for asynchronous memory maintenance");
}

test("DSH memory service retrieves one cached current-turn context from the existing contact memory database", async () => {
  const dataRoot = await temporaryDirectory("suzu-lives-dsh-memory-");
  const projectRoot = path.join(dataRoot, "contact-suzu");
  await fs.mkdir(projectRoot, { recursive: true });
  const contact = {
    id: "contact-suzu",
    name: "Suzu",
    agentId: "agent-suzu",
    projectRoot,
    sessionId: "session-suzu",
  };
  const settings = {
    identity: { owner: { displayName: "小林" } },
    memoryRecallEnabled: true,
    projectRoot,
  };
  const runtime = createLongTermMemoryService({
    conversationReader: {
      resolveContactSession: async (contactId) => ({
        contactId,
        id: contact.sessionId,
        projectRoot: contact.projectRoot,
      }),
    },
    connectionsService: { resolveNamedApiConnection: async () => null },
    contactProjectsService: {
      snapshot: async () => ({
        activeContact: contact,
        contacts: [contact],
        preferredContact: contact,
      }),
    },
    settingsService: {
      load: () => settings,
      response: () => ({ dataRoot, projectRoot }),
    },
  });
  const structuredRequests = [];
  runtime.setStructuredGenerationRuntime({
    async generateStructuredMemory(request) {
      structuredRequests.push(request);
      return {
        available: true,
        result: {
          ok: true,
          output: { memories: [] },
          usage: { inputTokens: 7, outputTokens: 3 },
          model: "deepseek-v4-flash",
          metadata: { provider: "DSH", providerId: "deepseek" },
        },
      };
    },
  });

  const turn = await runtime.prepareTurn({
    occurredAt: "2026-08-18T09:00:00.000Z",
    projectRoot,
    sessionId: contact.sessionId,
    turnId: "turn-1",
    userText: "还记得我说过的旅行计划吗？",
  });
  assert.ok(turn);

  const databasePath = path.join(
    resolveAgentDataRoot({ dataRoot, agentId: contact.agentId }),
    "memory",
    "sessions",
    contact.sessionId,
    "suzu-memory.db",
  );
  const memory = createMemoryService({
    agentId: contact.agentId,
    dataRoot,
    databasePath,
    defaults: {
      companionId: contact.agentId,
      defaultWorldFrame: "relational",
      defaultWorldId: "relationship",
      memoryOwner: contact.name,
      primaryUserId: "user",
      userName: "小林",
    },
  });
  memory.initialize();
  memory.withRepository((repository) => repository.upsertMemory({
    agentId: contact.agentId,
    content: "用户计划在下周末去海边旅行。",
    evidenceMode: "explicit",
    eventDate: "2026-08-12",
    id: "travel-plan",
    kind: "event",
    layer: "long_term",
    reality: "real",
    recordedAt: "2026-08-12T10:00:00.000Z",
    status: "active",
    subjectKey: "user",
    subjectRole: "user",
    title: "下周末海边旅行计划",
    worldFrame: "relational",
    worldId: "relationship",
  }));
  assert.equal(memory.listMemories().total, 1);
  const statusBeforeRecall = await runtime.status({ contactId: contact.id });
  assert.equal(statusBeforeRecall.memories, 1, JSON.stringify(statusBeforeRecall));

  const first = await runtime.recallForTurn({
    occurredAt: "2026-08-18T09:00:00.000Z",
    projectRoot,
    sessionId: contact.sessionId,
    turnId: "turn-1",
    userText: "还记得我说过的旅行计划吗？",
  });
  const second = await runtime.recallForTurn({
    projectRoot,
    sessionId: contact.sessionId,
    turnId: "turn-1",
    userText: "这次不应重复检索。",
  });
  assert.strictEqual(second, first);
  assert.match(first?.contextText || "", /海边旅行/u);
  assert.match(first?.memoryContext?.traceId || "", /^trace-/u);
  assert.doesNotMatch(first?.contextText || "", /suzu-long-term-memory/u);

  settings.memoryRecallEnabled = false;
  assert.equal(await runtime.recallForTurn({
    projectRoot,
    sessionId: contact.sessionId,
    turnId: "turn-2",
    userText: "关闭全局召回后不应再查询。",
  }), null);
  assert.match(memoryRecallContextText("一条记忆"), /一条记忆/u);

  await runtime.completeTurn(turn, {
    assistantText: "记得，是下周末去海边。",
    occurredAt: "2026-08-18T09:01:00.000Z",
  });
  await waitFor(() => structuredRequests.length > 0);
  assert.equal(structuredRequests[0].sessionId, contact.sessionId);
  assert.equal(structuredRequests[0].cwd, projectRoot);
  assert.equal(structuredRequests[0].contactId, contact.id);
  assert.equal(Object.hasOwn(structuredRequests[0], "apiKey"), false);
  assert.match(structuredRequests[0].schemaName, /long-term-memory-extraction/u);
  runtime.dispose();
});
