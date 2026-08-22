import assert from "node:assert/strict";
import test from "node:test";

import {
  conversationReactSnapshot,
  createConversationReactActions,
  startConversationPolling,
  stopConversationPolling,
} from "../src/features/conversation/index.mjs";

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("file context menu delegates copy and reveal through the scoped conversation bridge", async () => {
  const priorWindow = globalThis.window;
  const calls = [];
  globalThis.window = {
    clearInterval: () => {},
    innerHeight: 768,
    innerWidth: 1366,
    setInterval: () => 1,
  };
  const context = {
    api: {
      conversation: {
        copyMediaFile: async (value) => { calls.push(["copy", value]); },
        onEvent: () => () => {},
        openMediaFile: async (value) => { calls.push(["reveal", value]); },
        snapshot: async () => ({
          activeContact: { agentId: "agent-suzu", id: "contact-suzu", name: "Suzu" },
          activeSessionId: "session-suzu",
          contacts: [{ agentId: "agent-suzu", id: "contact-suzu", name: "Suzu" }],
          contactsRoot: "D:/suzu-data/contacts",
          messages: [],
          projectRoot: "D:/suzu-data/contacts/suzu",
          sessions: [{ id: "session-suzu", title: "Suzu" }],
          status: "ready",
          version: "file-menu-action-test",
        }),
      },
    },
    render: () => {},
    state: { settings: {} },
  };
  const attachment = { fileName: "report.txt", fileUrl: "file:///D:/Temp/report.txt" };

  try {
    startConversationPolling(context);
    await flush();
    const actions = createConversationReactActions(context);
    actions.dismissOverlays();
    actions.openFileContextMenu(attachment, { x: 120, y: 160 });
    assert.deepEqual(conversationReactSnapshot(context).fileContextMenu, {
      fileName: "report.txt",
      fileUrl: "file:///D:/Temp/report.txt",
      x: 120,
      y: 160,
    });

    await actions.copyMediaFile(attachment);
    assert.deepEqual(calls, [["copy", { fileUrl: "file:///D:/Temp/report.txt" }]]);
    assert.equal(conversationReactSnapshot(context).fileContextMenu, null);
    assert.equal(conversationReactSnapshot(context).notice, "已复制“report.txt”，可在资源管理器中粘贴。");

    actions.openFileContextMenu(attachment, { x: 120, y: 160 });
    await actions.openMediaFile(attachment);
    assert.deepEqual(calls.at(-1), ["reveal", { fileUrl: "file:///D:/Temp/report.txt" }]);
    assert.equal(conversationReactSnapshot(context).fileContextMenu, null);
  } finally {
    stopConversationPolling();
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});

test("message context menu hides the selected message after confirmation", async () => {
  const priorWindow = globalThis.window;
  const calls = [];
  let currentSnapshot = {
    activeContact: { agentId: "agent-suzu", id: "contact-suzu", name: "Suzu" },
    activeSessionId: "session-suzu",
    contacts: [{ agentId: "agent-suzu", id: "contact-suzu", name: "Suzu" }],
    contactsRoot: "D:/suzu-data/contacts",
    messages: [{
      id: "assistant-42",
      kind: "assistant",
      lineNumber: 42,
      blocks: [{ kind: "text", text: "这条回复可以删除。" }],
      timestamp: "2026-08-23T12:00:00.000Z",
    }],
    projectRoot: "D:/suzu-data/contacts/suzu",
    sessions: [{ id: "session-suzu", title: "Suzu" }],
    status: "ready",
    version: "message-delete-before",
  };
  globalThis.window = {
    clearInterval: () => {},
    confirm: () => true,
    innerHeight: 768,
    innerWidth: 1366,
    setInterval: () => 1,
  };
  const context = {
    api: {
      conversation: {
        deleteMessage: async (value) => {
          calls.push(value);
          currentSnapshot = {
            ...currentSnapshot,
            messages: [],
            version: "message-delete-after",
          };
          return currentSnapshot;
        },
        onEvent: () => () => {},
        snapshot: async () => currentSnapshot,
      },
    },
    render: () => {},
    state: { settings: {} },
  };

  try {
    startConversationPolling(context);
    await flush();
    const actions = createConversationReactActions(context);
    const row = conversationReactSnapshot(context).messageRows.find((item) => item.type === "message");
    assert.equal(row?.deletable, true);

    actions.openMessageContextMenu(row, { x: 120, y: 160 });
    assert.deepEqual(conversationReactSnapshot(context).messageContextMenu, {
      kind: "assistant",
      lineNumber: 42,
      messageId: "assistant-42",
      x: 120,
      y: 160,
    });

    await actions.deleteMessage(conversationReactSnapshot(context).messageContextMenu);
    assert.deepEqual(calls, [{
      confirmed: true,
      lineNumber: 42,
      messageId: "assistant-42",
    }]);
    assert.equal(conversationReactSnapshot(context).messageContextMenu, null);
    assert.equal(conversationReactSnapshot(context).messageRows.filter((item) => item.type === "message").length, 0);
    assert.equal(conversationReactSnapshot(context).notice, "已从聊天记录中隐藏这条消息。");
  } finally {
    stopConversationPolling();
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});
