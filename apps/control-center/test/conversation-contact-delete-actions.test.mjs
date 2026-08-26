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

test("deleting the active contact keeps the surviving conversation ready for typing", async () => {
  const priorWindow = globalThis.window;
  const removedContact = { agentId: "agent-remove", id: "contact-remove", name: "待删除联系人" };
  const retainedContact = { agentId: "agent-retain", id: "contact-retain", name: "保留联系人" };
  let currentSnapshot = {
    activeContact: removedContact,
    activeSessionId: "session-remove",
    contacts: [removedContact, retainedContact],
    contactsRoot: "D:/suzu-data/contacts",
    messages: [],
    projectRoot: "D:/suzu-data/contacts/remove",
    sessions: [{ id: "session-remove", title: removedContact.name }],
    status: "ready",
    version: "contact-delete-before",
  };
  const removeCalls = [];
  globalThis.window = {
    clearInterval: () => {},
    innerHeight: 768,
    innerWidth: 1366,
    setInterval: () => 1,
  };
  const context = {
    api: {
      conversation: {
        onEvent: () => () => {},
        removeContact: async (value) => {
          removeCalls.push(value);
          currentSnapshot = {
            ...currentSnapshot,
            activeContact: retainedContact,
            activeSessionId: "session-retain",
            contacts: [retainedContact],
            projectRoot: "D:/suzu-data/contacts/retain",
            sessions: [{ id: "session-retain", title: retainedContact.name }],
            version: "contact-delete-after",
          };
          return currentSnapshot;
        },
        snapshot: async () => currentSnapshot,
      },
    },
    render: () => {},
    state: { settings: { conversationPreferences: {} } },
  };

  try {
    startConversationPolling(context);
    await flush();
    const actions = createConversationReactActions(context);
    actions.setDraft("属于待删除联系人的草稿");
    const focusRequestBeforeDelete = conversationReactSnapshot(context).ui.composerFocusRequest;
    const removal = actions.removeContact(removedContact.id);
    assert.deepEqual(conversationReactSnapshot(context).overlays.confirmation, {
      cancelLabel: "取消",
      confirmLabel: "删除联系人",
      detail: "包括聊天记录、联系人资料、附件、记忆、自动任务和微信连接。此操作无法恢复。",
      message: `将删除“${removedContact.name}”及其所有专属数据。`,
      title: `删除“${removedContact.name}”？`,
    });
    assert.deepEqual(removeCalls, []);
    actions.confirmConfirmation();
    await removal;

    const view = conversationReactSnapshot(context);
    assert.deepEqual(removeCalls, [{ id: removedContact.id, confirmed: true }]);
    assert.equal(view.peer, retainedContact.name);
    assert.equal(view.composer.unavailable, false);
    assert.equal(view.composer.draft, "");
    assert.ok(view.ui.composerFocusRequest > focusRequestBeforeDelete);
  } finally {
    stopConversationPolling();
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});
