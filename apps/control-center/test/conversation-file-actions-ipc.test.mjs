import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { registerConversationIpc } from "../electron/ipc/conversation-ipc.mjs";

const EXISTING_FILE_URL = new URL("../package.json", import.meta.url).href;
const EXISTING_FILE_PATH = fileURLToPath(EXISTING_FILE_URL);

function registerFileActionHandlers({ clipboard, nativeImage = null, shell }) {
  const handlers = new Map();
  registerConversationIpc({
    app: { once() {} },
    clipboard,
    contactProjectsService: {
      snapshot: async () => ({ contacts: [], contactsRoot: "D:/Temp/suzu-lives-file-actions/contacts" }),
    },
    connectionsService: { resolveNamedApiConnection: async () => null },
    dialog: {},
    getMainWindow: () => null,
    ipcMain: {
      handle: (name, handler) => handlers.set(name, handler),
      on() {},
    },
    nativeImage,
    settingsService: {
      load: () => ({ dataRoot: "D:/Temp/suzu-lives-file-actions/data" }),
      response: (value) => value,
    },
    shell,
  });
  return handlers;
}

test("conversation IPC surface follows the active product feature catalog", () => {
  const handlers = registerFileActionHandlers({ clipboard: {}, shell: {} });
  for (const channel of [
    "conversation:emoji-stickers",
    "conversation:select-emoji-sticker",
    "conversation:add-emoji-sticker",
    "conversation:complete-emoji-sticker",
    "conversation:update-emoji-sticker",
    "conversation:remove-emoji-sticker",
    "conversation:send-emoji-sticker",
  ]) {
    assert.equal(handlers.has(channel), false);
  }
});

test("chat file actions copy the local file and reveal it in its folder", async () => {
  const copied = [];
  const revealed = [];
  const handlers = registerFileActionHandlers({
    clipboard: { _writeFilesForTesting: (paths) => copied.push(paths) },
    shell: { showItemInFolder: (filePath) => revealed.push(filePath) },
  });
  const sender = { isDestroyed: () => false };

  const copiedResult = await handlers.get("conversation:copy-media-file")({ sender }, { fileUrl: EXISTING_FILE_URL });
  const revealedResult = await handlers.get("conversation:open-media-file")({ sender }, { fileUrl: EXISTING_FILE_URL });

  assert.deepEqual(copiedResult, { copied: true });
  assert.deepEqual(copied, [[EXISTING_FILE_PATH]]);
  assert.deepEqual(revealedResult, { revealed: true });
  assert.deepEqual(revealed, [EXISTING_FILE_PATH]);
});

test("chat file actions reject missing or non-file attachment paths", async () => {
  const handlers = registerFileActionHandlers({
    clipboard: { _writeFilesForTesting() {} },
    shell: { showItemInFolder() {} },
  });
  const sender = { isDestroyed: () => false };
  const copy = handlers.get("conversation:copy-media-file");

  await assert.rejects(copy({ sender }, { fileUrl: "https://example.com/report.txt" }), /附件不是本地文件/u);
  await assert.rejects(copy({ sender }, { fileUrl: "file:///D:/Temp/suzu-lives-file-actions/missing.txt" }), /不存在或已被移动/u);
});

test("chat clipboard copies message text and a local image bitmap", async () => {
  const copiedText = [];
  const copiedImages = [];
  const imagePaths = [];
  const image = { isEmpty: () => false };
  const handlers = registerFileActionHandlers({
    clipboard: {
      _writeFilesForTesting() {},
      writeImage: (value) => copiedImages.push(value),
      writeText: (value) => copiedText.push(value),
    },
    nativeImage: {
      createFromPath: (filePath) => {
        imagePaths.push(filePath);
        return image;
      },
    },
    shell: { showItemInFolder() {} },
  });
  const sender = { isDestroyed: () => false };

  const textResult = await handlers.get("conversation:copy-message-text")({ sender }, { text: "可以复制的消息\n第二行" });
  const imageResult = await handlers.get("conversation:copy-media-image")({ sender }, { fileUrl: EXISTING_FILE_URL });

  assert.deepEqual(textResult, { copied: true });
  assert.deepEqual(copiedText, ["可以复制的消息\n第二行"]);
  assert.deepEqual(imageResult, { copied: true });
  assert.deepEqual(imagePaths, [EXISTING_FILE_PATH]);
  assert.deepEqual(copiedImages, [image]);
});
