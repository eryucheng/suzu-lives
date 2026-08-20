import assert from "node:assert/strict";
import test from "node:test";

import {
  conversationReactSnapshot,
  startConversationPolling,
  stopConversationPolling,
} from "../src/features/conversation/index.mjs";

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("a skipped call clause uses the existing system-message row and honors its visibility setting", async () => {
  const priorWindow = globalThis.window;
  let conversationEvent = null;
  globalThis.window = {
    clearInterval: () => {},
    setInterval: () => 1,
  };
  const context = {
    api: {
      conversation: {
        onEvent: (callback) => {
          conversationEvent = callback;
          return () => { conversationEvent = null; };
        },
        snapshot: async () => ({
          activeContact: { agentId: "agent-suzu", id: "contact-suzu", name: "Suzu" },
          activeSessionId: "session-suzu",
          contacts: [{ agentId: "agent-suzu", id: "contact-suzu", name: "Suzu" }],
          contactsRoot: "D:/suzu-data/contacts",
          messages: [],
          projectRoot: "D:/suzu-data/contacts/suzu",
          sessions: [{ id: "session-suzu", title: "Suzu" }],
          status: "ready",
          version: "test-call-system-message",
        }),
      },
    },
    render: () => {},
    state: {
      settings: {
        conversationPreferences: { system: true },
      },
    },
  };

  try {
    startConversationPolling(context);
    await flush();
    assert.equal(typeof conversationEvent, "function");
    conversationEvent({
      callId: "call-suzu",
      index: 0,
      message: "通话系统：语音服务繁忙，已跳过这一句语音。",
      projectRoot: "D:/suzu-data/contacts/suzu",
      requestId: "suzu-call-open-test",
      sessionId: "session-suzu",
      timestamp: "2026-08-15T10:00:00.000Z",
      type: "call-system-message",
    });

    const visible = conversationReactSnapshot(context).messageRows.find((row) => row.kind === "system");
    assert.ok(visible);
    assert.equal(visible.blocks[0].text, "通话系统：语音服务繁忙，已跳过这一句语音。");

    context.state.settings.conversationPreferences.system = false;
    assert.equal(
      conversationReactSnapshot(context).messageRows.some((row) => row.kind === "system"),
      false,
    );
  } finally {
    stopConversationPolling();
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});

test("a final call transcript appears immediately and is replaced by its durable system row", async () => {
  const priorWindow = globalThis.window;
  let conversationEvent = null;
  let messages = [];
  globalThis.window = {
    clearInterval: () => {},
    setInterval: () => 1,
  };
  const context = {
    api: {
      conversation: {
        onEvent: (callback) => {
          conversationEvent = callback;
          return () => { conversationEvent = null; };
        },
        snapshot: async () => ({
          activeContact: { agentId: "agent-suzu", id: "contact-suzu", name: "Suzu" },
          activeSessionId: "session-suzu",
          contacts: [{ agentId: "agent-suzu", id: "contact-suzu", name: "Suzu" }],
          contactsRoot: "D:/suzu-data/contacts",
          messages,
          projectRoot: "D:/suzu-data/contacts/suzu",
          sessions: [{ id: "session-suzu", title: "Suzu" }],
          status: "ready",
          version: "test-call-transcript",
        }),
      },
    },
    render: () => {},
    state: {
      settings: {
        conversationPreferences: { system: true },
      },
    },
  };

  try {
    startConversationPolling(context);
    await flush();
    conversationEvent({
      callId: "call-suzu",
      final: true,
      projectRoot: "D:/suzu-data/contacts/suzu",
      sessionId: "session-suzu",
      text: "你好，能听见吗？",
      timestamp: "2026-08-15T10:00:00.000Z",
      type: "call-transcript",
    });
    assert.deepEqual(
      conversationReactSnapshot(context).messageRows.filter((row) => row.kind === "system").map((row) => row.blocks[0].text),
      ["通话 · 我：你好，能听见吗？"],
    );

    messages = [{
      blocks: [{ kind: "text", text: "通话 · 我：你好，能听见吗？" }],
      id: "stored-call-transcript",
      kind: "system",
      timestamp: "2026-08-15T10:00:00.000Z",
    }];
    conversationEvent({ kind: "call", sessionId: "session-suzu", type: "turn-complete" });
    await flush();
    assert.deepEqual(
      conversationReactSnapshot(context).messageRows.filter((row) => row.kind === "system").map((row) => row.blocks[0].text),
      ["通话 · 我：你好，能听见吗？"],
    );
  } finally {
    stopConversationPolling();
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});
