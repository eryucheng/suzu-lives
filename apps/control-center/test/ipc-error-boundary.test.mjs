import assert from "node:assert/strict";
import test from "node:test";

import { withDetailedIpcErrors } from "../electron/ipc/ipc-error-boundary.mjs";

test("IPC error boundary preserves a nested cause in the renderer-visible error", async () => {
  const handlers = new Map();
  const rawIpcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    on() {},
  };
  const ipcMain = withDetailedIpcErrors(rawIpcMain);
  ipcMain.handle("fixture:save", () => {
    const cause = Object.assign(new Error("EBUSY: file is in use"), { code: "EBUSY" });
    const error = new Error("无法保存会话记录。", { cause });
    error.name = "ConversationStoreError";
    error.code = "STORE_WRITE_FAILED";
    throw error;
  });

  await assert.rejects(
    handlers.get("fixture:save")({}),
    (error) => error?.name === "ConversationStoreError"
      && error?.code === "STORE_WRITE_FAILED"
      && error?.message === "无法保存会话记录。（原因：EBUSY: file is in use）",
  );
});
