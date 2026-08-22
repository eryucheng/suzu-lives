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

test("composer image and file selections remain renderer tokens until the message is sent", async () => {
  const priorWindow = globalThis.window;
  const calls = [];
  globalThis.window = {
    clearInterval: () => {},
    setInterval: () => 1,
  };
  const context = {
    api: {
      conversation: {
        attachments: {
          discard: async (value) => { calls.push(["discard", value]); },
          paste: async (value) => {
            calls.push(["paste", value]);
            return {
              canceled: false,
              items: [{
                fileName: "clipboard-image.png",
                kind: "image",
                mimeType: "image/png",
                selectionToken: "clipboard-1",
                size: 4,
              }],
            };
          },
          select: async (value) => {
            calls.push(["select", value]);
            return {
              canceled: false,
              items: [{
                fileName: "photo.png",
                fileUrl: "file:///D:/Temp/photo.png",
                kind: "image",
                mimeType: "image/png",
                selectionToken: "attachment-1",
                size: 128,
              }],
            };
          },
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
          version: "attachment-action-test",
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
    await actions.selectComposerAttachments("image");
    assert.deepEqual(calls, [["select", { kind: "image" }]]);
    assert.deepEqual(conversationReactSnapshot(context).composer.attachments.map((item) => item.fileName), ["photo.png"]);
    actions.removeComposerAttachment("attachment-1");
    await flush();
    assert.deepEqual(calls.at(-1), ["discard", { attachmentTokens: ["attachment-1"] }]);
    assert.deepEqual(conversationReactSnapshot(context).composer.attachments, []);

    await actions.pasteComposerImages([{
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      fileName: "clipboard.png",
      fileUrl: "blob:clipboard-preview",
    }]);
    const paste = calls.find(([name]) => name === "paste");
    assert.equal(paste?.[1]?.items?.length, 1);
    assert.equal(paste?.[1]?.items?.[0]?.mimeType, "image/png");
    assert.deepEqual(paste?.[1]?.items?.[0]?.data, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    assert.equal(Object.hasOwn(paste?.[1]?.items?.[0] || {}, "fileUrl"), false);
    assert.deepEqual(conversationReactSnapshot(context).composer.attachments.map((item) => ({
      fileUrl: item.fileUrl,
      selectionToken: item.selectionToken,
    })), [{ fileUrl: "blob:clipboard-preview", selectionToken: "clipboard-1" }]);
    actions.removeComposerAttachment("clipboard-1");
    await flush();
    assert.deepEqual(calls.at(-1), ["discard", { attachmentTokens: ["clipboard-1"] }]);
  } finally {
    stopConversationPolling();
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});
