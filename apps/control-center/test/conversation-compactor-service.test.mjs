import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { stableAgentId } from "@suzu-lives/agent-registry";
import { listScheduleTasks } from "@suzu-lives/task-scheduler";
import { createConversationCompactorService } from "../electron/services/conversation-compactor-service.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("conversation compactor keeps prompts and invocations isolated by contact plus Claude session", async () => {
  const root = await temporaryDirectory("suzu-conversation-compactor-service-");
  const dataRoot = path.join(root, "data");
  const contacts = [
    {
      id: "contact-suzu",
      name: "Suzu",
      projectRoot: path.join(root, "contact-suzu"),
      sessions: [{ id: "shared-session", title: "Suzu 的对话", preview: "", updatedAt: "2026-08-10T10:00:00.000Z" }],
    },
    {
      id: "contact-work",
      name: "工作",
      projectRoot: path.join(root, "contact-work"),
      sessions: [{ id: "shared-session", title: "工作的对话", preview: "", updatedAt: "2026-08-10T11:00:00.000Z" }],
    },
  ];
  const calls = [];
  const importCalls = [];
  const reader = {
    compactorSnapshot: async () => ({
      status: "ready",
      activeContact: { id: "contact-work", name: "工作" },
      activeSessionId: "shared-session",
      contacts,
    }),
    resolveCompactorSession: async ({ contactId }) => {
      const contact = contacts.find((item) => item.id === contactId);
      const sessionId = contact?.sessions[0]?.id;
      if (!contact || !sessionId) throw new Error("会话不存在");
      return {
        id: sessionId,
        projectRoot: contact.projectRoot,
        transcriptPath: path.join(contact.projectRoot, `${sessionId}.jsonl`),
        hasTranscript: true,
        contact: { id: contact.id, name: contact.name },
      };
    },
  };
  const service = createConversationCompactorService({
    createGeneratorImpl: () => async () => ({}),
    importConversationHistoryImpl: async (input) => {
      importCalls.push(input);
      return { status: "imported" };
    },
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    reader,
    runCompactionImpl: async (input) => { calls.push(input); return { status: "written" }; },
    settingsService: {
      load: () => ({ identity: { owner: { displayName: "我" } } }),
      response: () => ({ dataRoot }),
    },
  });

  await service.save({ contactId: "contact-suzu", prompt: "Suzu 会话的提示词" });
  await service.save({ contactId: "contact-work", prompt: "工作会话的提示词" });
  const suzuSnapshot = await service.snapshot({ contactId: "contact-suzu" });
  const workSnapshot = await service.snapshot({ contactId: "contact-work" });
  assert.deepEqual(suzuSnapshot.contacts.map((contact) => ({ id: contact.id, hasConversation: contact.hasConversation })), [
    { id: "contact-suzu", hasConversation: true },
    { id: "contact-work", hasConversation: true },
  ]);
  assert.equal(suzuSnapshot.selectedConversation.contactId, "contact-suzu");
  assert.equal(Object.hasOwn(suzuSnapshot.selectedConversation, "id"), false);
  assert.equal(Object.hasOwn(suzuSnapshot, "selectedSessionId"), false);
  assert.equal(suzuSnapshot.settings.prompt, "Suzu 会话的提示词");
  assert.equal(workSnapshot.settings.prompt, "工作会话的提示词");

  await service.run({ contactId: "contact-suzu", retainTokens: 3_200 });
  await service.run({ contactId: "contact-work" });
  assert.deepEqual(calls.map((input) => ({
    memoryOwner: input.memoryOwner,
    sessionId: input.sessionId,
    systemPrompt: input.systemPrompt,
    transcriptPath: input.transcriptPath,
    strategy: input.strategy,
    retainTokens: input.rules?.recentRawTokensToKeep,
  })), [
    {
      memoryOwner: "Suzu",
      sessionId: "shared-session",
      systemPrompt: "Suzu 会话的提示词",
      transcriptPath: path.join(contacts[0].projectRoot, "shared-session.jsonl"),
      strategy: "token-tail",
      retainTokens: 3_200,
    },
    {
      memoryOwner: "工作",
      sessionId: "shared-session",
      systemPrompt: "工作会话的提示词",
      transcriptPath: path.join(contacts[1].projectRoot, "shared-session.jsonl"),
      strategy: "token-tail",
      retainTokens: 5_000,
    },
  ]);

  const suzuAgentId = stableAgentId(contacts[0].projectRoot);
  const workAgentId = stableAgentId(contacts[1].projectRoot);
  const suzuConfig = path.join(dataRoot, "agents", suzuAgentId, "conversations", "shared-session", "compactor.json");
  const workConfig = path.join(dataRoot, "agents", workAgentId, "conversations", "shared-session", "compactor.json");
  assert.equal(JSON.parse(await fs.readFile(suzuConfig, "utf8")).prompt, "Suzu 会话的提示词");
  assert.equal(JSON.parse(await fs.readFile(workConfig, "utf8")).prompt, "工作会话的提示词");

  const sourcePath = path.join(root, "older-suzu-history.jsonl");
  await service.importHistory({ contactId: "contact-suzu", sourcePath });
  assert.deepEqual(importCalls.map((input) => ({
    sessionId: input.sessionId,
    sourceTranscriptPath: input.sourceTranscriptPath,
    targetProjectRoot: input.targetProjectRoot,
    transcriptPath: input.transcriptPath,
  })), [{
    sessionId: "shared-session",
    sourceTranscriptPath: sourcePath,
    targetProjectRoot: contacts[0].projectRoot,
    transcriptPath: path.join(contacts[0].projectRoot, "shared-session.jsonl"),
  }]);
});

test("conversation compactor creates and removes only its own per-session automatic tasks", async () => {
  const root = await temporaryDirectory("suzu-conversation-compactor-automatic-");
  const dataRoot = path.join(root, "data");
  const contact = {
    id: "contact-suzu",
    name: "Suzu",
    projectRoot: path.join(root, "contact-suzu"),
    sessions: [{ id: "session-suzu", title: "日常", preview: "", updatedAt: "2026-08-10T12:00:00.000Z" }],
  };
  const calls = [];
  await fs.mkdir(contact.projectRoot, { recursive: true });
  await fs.writeFile(path.join(contact.projectRoot, "session-suzu.jsonl"), [
    {
      parentUuid: null,
      sessionId: "session-suzu",
      timestamp: "2026-08-10T08:00:00.000Z",
      type: "user",
      uuid: "old-user",
      message: { role: "user", content: "较早的对话" },
    },
    {
      parentUuid: "old-user",
      sessionId: "session-suzu",
      timestamp: "2026-08-10T08:01:00.000Z",
      type: "assistant",
      uuid: "old-agent",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "较早的回复" }],
        usage: { input_tokens: 20_000 },
      },
    },
    {
      parentUuid: "old-agent",
      sessionId: "session-suzu",
      timestamp: "2026-08-10T11:00:00.000Z",
      type: "user",
      uuid: "recent-user",
      message: { role: "user", content: "最近的对话" },
    },
    {
      parentUuid: "recent-user",
      sessionId: "session-suzu",
      timestamp: "2026-08-10T11:01:00.000Z",
      type: "assistant",
      uuid: "recent-agent",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "最近的回复" }],
        usage: { input_tokens: 20_000 },
      },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  const resolve = async ({ contactId }) => {
    assert.equal(contactId, contact.id);
    const sessionId = contact.sessions[0].id;
    return {
      id: sessionId,
      projectRoot: contact.projectRoot,
      transcriptPath: path.join(contact.projectRoot, `${sessionId}.jsonl`),
      hasTranscript: true,
      contact: { id: contact.id, name: contact.name },
    };
  };
  const service = createConversationCompactorService({
    createGeneratorImpl: () => async () => ({}),
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    reader: {
      compactorSnapshot: async () => ({
        status: "ready",
        activeContact: { id: contact.id, name: contact.name },
        activeSessionId: contact.sessions[0].id,
        contacts: [contact],
      }),
      resolveCompactorSession: resolve,
      resolveCompactorSessionForRuntime: async ({ projectRoot, sessionId }) => {
        assert.equal(projectRoot, contact.projectRoot);
        return resolve({ contactId: contact.id });
      },
    },
    runCompactionImpl: async (input) => { calls.push(input); return { status: "written" }; },
    settingsService: {
      load: () => ({ identity: { owner: { displayName: "我" } } }),
      response: () => ({ dataRoot }),
    },
  });
  const scope = { contactId: contact.id };

  await service.save({
    ...scope,
    automatic: {
      enabled: true,
      trigger: "time",
      time: "08:30",
      tokenThreshold: 16_000,
      retainTokens: 1,
    },
  });
  let tasks = await listScheduleTasks({ dataRoot });
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].target, {
    type: "operation",
    name: "conversation-compactor",
    trigger: "time",
    projectRoot: path.resolve(contact.projectRoot),
    sessionId: contact.sessions[0].id,
  });
  assert.equal(tasks[0].cron, "30 8 * * *");

  await service.save({
    ...scope,
    automatic: {
      enabled: true,
      trigger: "token",
      time: "08:30",
      tokenThreshold: 16_000,
      retainTokens: 1,
    },
  });
  assert.deepEqual(await listScheduleTasks({ dataRoot }), []);

  const first = await service.enqueueTokenAuto({
    projectRoot: contact.projectRoot,
    sessionId: contact.sessions[0].id,
  });
  const duplicate = await service.enqueueTokenAuto({
    projectRoot: contact.projectRoot,
    sessionId: contact.sessions[0].id,
  });
  assert.equal(first.scheduled, true);
  assert.equal(duplicate.scheduled, false);
  tasks = await listScheduleTasks({ dataRoot });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].kind, "once");
  assert.equal(tasks[0].target.trigger, "token");

  await service.runScheduledAutomaticTask(tasks[0]);
  assert.deepEqual(calls.map((input) => ({
    memoryOwner: input.memoryOwner,
    minimumContextTokens: input.minimumContextTokens,
    retainTokens: input.rules?.recentRawTokensToKeep,
    strategy: input.strategy,
  })), [{
    memoryOwner: "Suzu",
    minimumContextTokens: 16_000,
    retainTokens: 1,
    strategy: "token-tail",
  }]);

  await service.save({
    ...scope,
    automatic: {
      enabled: false,
      trigger: "token",
      time: "08:30",
      tokenThreshold: 16_000,
      retainTokens: 1,
    },
  });
  assert.deepEqual(await listScheduleTasks({ dataRoot }), []);
});
