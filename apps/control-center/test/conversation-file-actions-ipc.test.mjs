import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { registerConversationIpc } from "../electron/ipc/conversation-ipc.mjs";

const EXISTING_FILE_URL = new URL("../package.json", import.meta.url).href;
const EXISTING_FILE_PATH = fileURLToPath(EXISTING_FILE_URL);

function registerFileActionHandlers({ clipboard, shell }) {
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
    settingsService: {
      load: () => ({ dataRoot: "D:/Temp/suzu-lives-file-actions/data" }),
      response: (value) => value,
    },
    shell,
  });
  return handlers;
}

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
