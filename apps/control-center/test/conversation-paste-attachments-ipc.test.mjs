import assert from "node:assert/strict";
import test from "node:test";

import { registerConversationIpc } from "../electron/ipc/conversation-ipc.mjs";

function registerPasteHandler() {
  const handlers = new Map();
  registerConversationIpc({
    app: { once() {} },
    contactProjectsService: {
      snapshot: async () => ({ contacts: [], contactsRoot: "D:/Temp/suzu-lives-clipboard-paste/contacts" }),
    },
    connectionsService: { resolveNamedApiConnection: async () => null },
    dialog: {},
    getMainWindow: () => null,
    ipcMain: {
      handle: (name, handler) => handlers.set(name, handler),
      on() {},
    },
    settingsService: {
      load: () => ({ dataRoot: "D:/Temp/suzu-lives-clipboard-paste/data" }),
      response: (value) => value,
    },
    shell: {},
  });
  return handlers.get("conversation:paste-attachments");
}

test("clipboard images become scoped attachment tokens without exposing a renderer file URL", () => {
  const paste = registerPasteHandler();
  const sender = { isDestroyed: () => false };
  const result = paste({ sender }, {
    items: [{
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      fileName: "ignored-by-main.png",
      mimeType: "image/png",
    }],
  });

  assert.equal(result.canceled, false);
  assert.equal(result.items.length, 1);
  assert.match(result.items[0].fileName, /^clipboard-image-\d+-1\.png$/u);
  assert.equal(result.items[0].kind, "image");
  assert.equal(result.items[0].mimeType, "image/png");
  assert.equal(result.items[0].size, 4);
  assert.ok(result.items[0].selectionToken);
  assert.equal(Object.hasOwn(result.items[0], "fileUrl"), false);

  assert.throws(
    () => paste({ sender }, { items: [{ data: new Uint8Array([1]), mimeType: "image/bmp" }] }),
    /剪贴板图片格式/u,
  );
});
