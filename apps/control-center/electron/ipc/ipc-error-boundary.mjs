import { formatErrorForDisplay } from "@suzu-lives/suzu-agent-runtime/error-detail";

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Electron serializes only an IPC handler's visible Error message. Product
 * services deliberately retain a nested `cause`, so flatten it at this single
 * boundary instead of requiring every renderer caller to know each service's
 * error shape.
 */
export function withDetailedIpcErrors(ipcMain) {
  if (!ipcMain || typeof ipcMain.handle !== "function") {
    throw new Error("错误边界需要 ipcMain.handle()。 ");
  }

  return Object.freeze({
    handle(channel, handler) {
      return ipcMain.handle(channel, async (...args) => {
        try {
          return await handler(...args);
        } catch (error) {
          const detailed = new Error(formatErrorForDisplay(error));
          detailed.name = clean(error?.name) || "Error";
          const code = clean(error?.code);
          if (code) detailed.code = code;
          throw detailed;
        }
      });
    },
    on: typeof ipcMain.on === "function" ? ipcMain.on.bind(ipcMain) : undefined,
  });
}
