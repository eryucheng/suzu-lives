import assert from "node:assert/strict";
import test from "node:test";

import {
  conversationContextRecords,
  conversationDisplayMessages,
  createConversationReader,
} from "../electron/services/conversation-reader.mjs";

function inMemoryDeletionStore() {
  const entriesBySession = new Map();
  return {
    async list({ sessionId }) {
      const entries = entriesBySession.get(sessionId) || [];
      return {
        entries: entries.map((entry) => ({ ...entry })),
        revision: entries.map((entry) => `${entry.eventSeq}:${entry.deletedAt}`).join(","),
      };
    },
    async markDeleted({ sessionId, eventSeq, messageId }) {
      const entries = entriesBySession.get(sessionId) || [];
      const existing = entries.find((entry) => entry.eventSeq === eventSeq);
      if (existing) return { added: false, entry: { ...existing } };
      const entry = {
        eventSeq,
        ...(messageId ? { messageId } : {}),
        deletedAt: `2026-08-23T00:00:${String(entries.length).padStart(2, "0")}.000Z`,
      };
      entriesBySession.set(sessionId, [...entries, entry]);
      return { added: true, entry: { ...entry } };
    },
  };
}

test("deleting a message keeps Core history immutable, hides it in Suzu, and retracts its exact memory source", async () => {
  const projectRoot = "D:/suzu-data/contacts/suzu";
  const contact = {
    agentId: "agent-suzu",
    id: "contact-suzu",
    name: "Suzu",
    projectRoot,
    sessionId: "session-suzu",
  };
  const events = [
    {
      type: "user/message",
      seq: 1,
      time: 1_000,
      surfaceOp: "append",
      data: {
        id: "user-1",
        role: "user",
        content: [{ type: "text", text: "这句话不该再参与长期记忆。" }],
        source: { kind: "user", suzuTurnId: "turn-1" },
      },
    },
    { type: "turn/start", seq: 2, time: 2_000, data: { turn: 7 } },
    {
      type: "assistant/message",
      seq: 3,
      time: 3_000,
      surfaceOp: "append",
      data: {
        turn: 7,
        message: {
          id: "assistant-1",
          role: "assistant",
          content: [{ type: "text", text: "这条回复也可以从聊天视图中隐藏。" }],
        },
      },
    },
    {
      type: "user/message",
      seq: 4,
      time: 4_000,
      surfaceOp: "append",
      data: {
        id: "dynamic-1",
        role: "user",
        content: [{ type: "text", text: "这是本轮动态上下文。" }],
        source: {
          kind: "plugin",
          plugin: "suzu-lifecycle-bridge",
          form: "snapshot",
          sections: [{
            id: "current-time",
            kind: "time-awareness",
            text: "当前时间：10:00。",
          }],
        },
      },
    },
    { type: "turn/end", seq: 5, time: 5_000, data: { turn: 7 } },
  ];
  const originalEvents = structuredClone(events);
  const memoryCalls = [];
  const reader = createConversationReader({
    runtime: {
      async history() {
        return { events, hasMore: false };
      },
    },
    settingsService: { load: () => ({}) },
    contactProjectsService: {
      async snapshot() {
        return {
          activeContact: contact,
          contacts: [contact],
          contactsRoot: "D:/suzu-data/contacts",
          preferredContact: contact,
        };
      },
    },
    memoryRuntime: {
      async retractConversationMessage(value) {
        memoryCalls.push(value);
        return { retracted: 1, status: "retracted" };
      },
    },
    messageDeletionStore: inMemoryDeletionStore(),
  });

  const afterUserDelete = await reader.deleteMessage({
    confirmed: true,
    lineNumber: 1,
    messageId: "user-1",
  });
  assert.deepEqual(memoryCalls[0], {
    projectRoot,
    sessionId: "session-suzu",
    turnId: "turn-1",
    role: "user",
    text: "这句话不该再参与长期记忆。",
    occurredAt: "1970-01-01T00:00:01.000Z",
  });
  assert.deepEqual(afterUserDelete.messages.map((message) => message.id), ["assistant-1"]);
  assert.deepEqual(afterUserDelete.deletedEventSequences, [1]);
  assert.deepEqual(events, originalEvents);

  const afterAssistantDelete = await reader.deleteMessage({
    confirmed: true,
    lineNumber: 3,
    messageId: "assistant-1",
  });
  assert.deepEqual(memoryCalls[1], {
    projectRoot,
    sessionId: "session-suzu",
    turnId: "turn-1",
    role: "companion",
    text: "这条回复也可以从聊天视图中隐藏。",
    occurredAt: "1970-01-01T00:00:03.000Z",
  });
  assert.equal(afterAssistantDelete.messages.length, 0);
  assert.deepEqual(afterAssistantDelete.deletedEventSequences, [1, 3]);
  assert.deepEqual(events, originalEvents);

  const afterDynamicContextDelete = await reader.deleteMessage({ confirmed: true, lineNumber: 4 });
  assert.equal(memoryCalls.length, 2);
  assert.deepEqual(afterDynamicContextDelete.deletedEventSequences, [1, 3, 4]);
  const hiddenSequences = [1, 3, 4];
  assert.equal(conversationDisplayMessages(events, 500, {
    includeDynamicContext: true,
    deletedEventSequences: hiddenSequences,
  }).length, 0);
  assert.equal(conversationContextRecords(events, 600, {
    deletedEventSequences: hiddenSequences,
  }).length, 0);
  assert.deepEqual(events, originalEvents);
});
