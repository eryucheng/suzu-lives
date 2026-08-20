import { createExternalCapabilitiesIpcService } from "./external-capabilities-ipc.mjs";
import { createLegacyMigrationService } from "../services/legacy-migration-service.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function migrationIpcResult(action) {
  return Promise.resolve()
    .then(action)
    .then((value) => ({ ok: true, value }))
    .catch((error) => ({
      ok: false,
      error: {
        code: clean(error?.code),
        message: clean(error?.message) || "无法安全迁移旧版数据。",
      },
    }));
}

/**
 * Registers the intentionally narrow IPC surface used only by the NSIS-triggered
 * 0.1.x migration window. The normal renderer and its broad application IPC are
 * not created in this mode.
 */
export function registerLegacyMigrationIpc({
  app,
  dataStorageService,
  getMigrationWindow,
  ipcMain,
  settingsService,
} = {}) {
  if (!app?.quit || !dataStorageService?.dataRoot || !getMigrationWindow
    || !ipcMain?.handle || !settingsService?.load || !settingsService?.save) {
    throw new Error("旧版迁移 IPC 缺少必要的本地服务。 ");
  }
  const externalCapabilities = createExternalCapabilitiesIpcService({ settingsService });
  const migration = createLegacyMigrationService({
    dataRoot: dataStorageService.dataRoot,
    settingsService,
    adoptExternalCapabilities: (value) => externalCapabilities.adoptLegacyInstallations(value),
  });
  const fromMigrationWindow = (event) => event?.sender === getMigrationWindow()?.webContents;
  const guarded = (action) => (event) => {
    if (!fromMigrationWindow(event)) {
      return { ok: false, error: { code: "UNAUTHORIZED", message: "迁移请求来自无效窗口。" } };
    }
    return migrationIpcResult(action);
  };

  ipcMain.handle("legacy-migration:inspect", guarded(() => migration.inspect()));
  ipcMain.handle("legacy-migration:migrate", guarded(() => migration.migrate()));
  ipcMain.handle("legacy-migration:close", (event) => {
    if (!fromMigrationWindow(event)) return false;
    app.quit();
    return true;
  });
}
