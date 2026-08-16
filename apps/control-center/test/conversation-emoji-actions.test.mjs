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

test("choosing an emoji closes the picker before the conversation rerenders", async () => {
  const priorWindow = globalThis.window;
  let renders = 0;
  globalThis.window = {
    clearInterval: () => {},
    setInterval: () => 1,
  };
  const context = {
    api: {
      conversation: {
        onEvent: () => () => {},
        snapshot: async () => ({
          activeContact: { agentId: "agent-suzu", id: "contact-suzu", name: "Suzu" },
          activeSessionId: "session-suzu",
          contacts: [{ agentId: "agent-suzu", id: "contact-suzu", name: "Suzu" }],
          contactsRoot: "D:/suzu-data/contacts",
          messages: [],
          projectRoot: "D:/suzu-data/contacts/suzu",
          sessions: [{ id: "session-suzu", title: "Suzu" }],
          status: "ready",
          version: "emoji-action-test",
        }),
      },
    },
    render: () => { renders += 1; },
    state: { settings: {} },
  };

  try {
    startConversationPolling(context);
    await flush();
    const actions = createConversationReactActions(context);
    actions.toggleEmoji();
    assert.equal(conversationReactSnapshot(context).composer.emojiOpen, true);

    actions.insertEmoji("🙂");
    const composer = conversationReactSnapshot(context).composer;
    assert.equal(composer.draft, "🙂");
    assert.equal(composer.emojiOpen, false);
    assert.ok(renders >= 3);
  } finally {
    stopConversationPolling();
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});

test("favorite sticker actions stay behind the dedicated conversation bridge", async () => {
  const priorWindow = globalThis.window;
  const calls = [];
  globalThis.window = {
    clearInterval: () => {},
    setInterval: () => 1,
  };
  const context = {
    api: {
      conversation: {
        emojiStickers: {
          add: async (value) => {
            calls.push(["add", value]);
            return { items: [{ id: "sticker-1" }], status: "ready" };
          },
          select: async () => ({ selectionToken: "selection-1" }),
          send: async (value) => {
            calls.push(["send", value]);
            return { accepted: true };
          },
          snapshot: async () => ({ items: [{ id: "sticker-1" }], status: "ready" }),
        },
        onEvent: () => () => {},
        snapshot: async () => ({
          activeContact: { agentId: "agent-suzu", id: "contact-suzu", name: "Suzu" },
          activeSessionId: "session-suzu",
          contacts: [{ agentId: "agent-suzu", id: "contact-suzu", name: "Suzu" }],
          contactsRoot: "D:/suzu-data/contacts",
          messages: [],
          projectRoot: "D:/suzu-data/contacts/suzu",
          sessions: [{ id: "session-suzu", title: "Suzu" }],
          status: "ready",
          version: "emoji-sticker-action-test",
        }),
      },
    },
    render: () => {},
    state: { settings: {} },
  };

  try {
    startConversationPolling(context);
    await flush();
    const actions = createConversationReactActions(context);
    assert.deepEqual(await actions.loadEmojiStickers(), { items: [{ id: "sticker-1" }], status: "ready" });
    await actions.addEmojiSticker();
    await actions.sendEmojiSticker("sticker-1");
    assert.deepEqual(calls, [
      ["add", { selectionToken: "selection-1" }],
      ["send", { id: "sticker-1" }],
    ]);
  } finally {
    stopConversationPolling();
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});
