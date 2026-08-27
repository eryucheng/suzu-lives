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
    actions.dismissNotice("已复制“report.txt”，可在资源管理器中粘贴。");
    assert.equal(conversationReactSnapshot(context).notice, "");

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

test("message context menu copies text and images before hiding the selected message", async () => {
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
      blocks: [
        { kind: "text", text: "这条回复可以删除。" },
        { fileName: "reply.png", fileUrl: "file:///D:/Temp/reply.png", kind: "media", mediaKind: "image" },
      ],
      timestamp: "2026-08-23T12:00:00.000Z",
    }],
    projectRoot: "D:/suzu-data/contacts/suzu",
    sessions: [{ id: "session-suzu", title: "Suzu" }],
    status: "ready",
    version: "message-delete-before",
  };
  globalThis.window = {
    clearInterval: () => {},
    innerHeight: 768,
    innerWidth: 1366,
    setInterval: () => 1,
  };
  const context = {
    api: {
      conversation: {
        copyMediaImage: async (value) => { calls.push({ type: "image", value }); },
        copyMessageText: async (value) => { calls.push({ type: "text", value }); },
        deleteMessage: async (value) => {
          calls.push({ type: "delete", value });
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
      canDelete: true,
      copyText: "这条回复可以删除。",
      images: [{ fileName: "reply.png", fileUrl: "file:///D:/Temp/reply.png" }],
      kind: "assistant",
      lineNumber: 42,
      messageId: "assistant-42",
      x: 120,
      y: 160,
    });

    await actions.copyMessageText(conversationReactSnapshot(context).messageContextMenu);
    assert.deepEqual(calls, [{ type: "text", value: { text: "这条回复可以删除。" } }]);
    assert.equal(conversationReactSnapshot(context).notice, "已复制消息。");

    actions.openMessageContextMenu(row, { x: 120, y: 160 });
    await actions.copyMediaImage(conversationReactSnapshot(context).messageContextMenu.images[0]);
    assert.deepEqual(calls.at(-1), { type: "image", value: { fileUrl: "file:///D:/Temp/reply.png" } });
    assert.equal(conversationReactSnapshot(context).notice, "已复制“reply.png”，可直接粘贴。");

    actions.openMessageContextMenu(row, { x: 120, y: 160 });
    const focusRequestBeforeDelete = conversationReactSnapshot(context).ui.composerFocusRequest;
    const deletion = actions.deleteMessage(conversationReactSnapshot(context).messageContextMenu);
    assert.deepEqual(conversationReactSnapshot(context).overlays.confirmation, {
      cancelLabel: "取消",
      confirmLabel: "删除消息",
      detail: "已生成的会话摘要不会修改；若它曾写入长期记忆，对应记忆也会被撤回。",
      message: "这条消息会从当前聊天记录中隐藏。",
      title: "删除这条消息？",
    });
    assert.notEqual(calls.at(-1)?.type, "delete");
    actions.confirmConfirmation();
    await deletion;
    assert.deepEqual(calls.at(-1), { type: "delete", value: {
      confirmed: true,
      lineNumber: 42,
      messageId: "assistant-42",
    }});
    assert.equal(conversationReactSnapshot(context).messageContextMenu, null);
    assert.equal(conversationReactSnapshot(context).messageRows.filter((item) => item.type === "message").length, 0);
    assert.equal(conversationReactSnapshot(context).notice, "已从聊天记录中隐藏这条消息。");
    assert.equal(conversationReactSnapshot(context).composer.unavailable, false);
    assert.ok(conversationReactSnapshot(context).ui.composerFocusRequest > focusRequestBeforeDelete);
  } finally {
    stopConversationPolling();
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});

test("hiding a newly accepted user message also retires its optimistic row", async () => {
  const priorWindow = globalThis.window;
  const contact = { agentId: "agent-pending", id: "contact-pending", name: "Pending" };
  let currentSnapshot = {
    activeContact: contact,
    activeSessionId: "session-pending",
    contacts: [contact],
    contactsRoot: "D:/suzu-data/contacts",
    messages: [],
    projectRoot: "D:/suzu-data/contacts/pending",
    sessions: [{ id: "session-pending", title: "Pending" }],
    status: "ready",
    version: "pending-delete-before",
  };
  globalThis.window = {
    clearInterval: () => {},
    innerHeight: 768,
    innerWidth: 1366,
    setInterval: () => 1,
  };
  const context = {
    api: {
      conversation: {
        deleteMessage: async () => {
          currentSnapshot = {
            ...currentSnapshot,
            deletedEventSequences: [8],
            messages: [],
            version: "pending-delete-after",
          };
          return currentSnapshot;
        },
        onEvent: () => () => {},
        send: async ({ content }) => {
          currentSnapshot = {
            ...currentSnapshot,
            messages: [{
              blocks: [{ kind: "text", text: content }],
              id: "user-pending-8",
              kind: "user",
              lineNumber: 8,
              timestamp: new Date().toISOString(),
            }],
            version: "pending-send-accepted",
          };
          return { requestId: "request-pending", sessionId: "session-pending" };
        },
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
    actions.setDraft("刚发送的消息");
    actions.submitMessage();
    await flush();
    await flush();

    const row = conversationReactSnapshot(context).messageRows
      .find((item) => item.type === "message" && item.kind === "user");
    assert.equal(row?.blocks?.[0]?.text, "刚发送的消息");
    actions.openMessageContextMenu(row, { x: 120, y: 160 });
    const deletion = actions.deleteMessage(conversationReactSnapshot(context).messageContextMenu);
    actions.confirmConfirmation();
    await deletion;

    assert.equal(
      conversationReactSnapshot(context).messageRows.some((item) => (
        item.type === "message" && item.blocks?.some((block) => block.text === "刚发送的消息")
      )),
      false,
    );
    assert.equal(conversationReactSnapshot(context).composer.unavailable, false);
  } finally {
    stopConversationPolling();
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});
