import { createExternalCapabilitiesService } from "@suzu-lives/external-capabilities";

function clean(value) {
  return String(value ?? "").trim();
}

function dataRootFor(settingsService, settings) {
  return clean(settingsService.response?.(settings)?.dataRoot || settings?.dataRoot);
}

export async function externalCapabilityIpcResult(action) {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: clean(error?.code),
        message: clean(error?.message) || "无法更新外部能力。",
      },
    };
  }
}

/** Keeps the Electron boundary small; all manifest and file rules live in the package. */
export function createExternalCapabilitiesIpcService({ settingsService, fsOps } = {}) {
  if (!settingsService || typeof settingsService.load !== "function") throw new Error("外部能力服务需要软件设置服务。 ");
  const serviceForCurrentContact = () => {
    const settings = settingsService.load();
    return createExternalCapabilitiesService({
      dataRoot: dataRootFor(settingsService, settings),
      projectRoot: clean(settings?.projectRoot),
      ...(fsOps ? { fsOps } : {}),
    });
  };
  return {
    snapshot: () => serviceForCurrentContact().snapshot(),
    importManifest: ({ manifestPath } = {}) => serviceForCurrentContact().importManifest({ manifestPath }),
    setEnabled: ({ id, enabled } = {}) => serviceForCurrentContact().setEnabled({ id, enabled }),
    remove: ({ id, confirmed } = {}) => serviceForCurrentContact().remove({ id, confirmed }),
  };
}

export function registerExternalCapabilitiesIpc({ dialog, getMainWindow, ipcMain, externalCapabilitiesService }) {
  if (!dialog || typeof dialog.showOpenDialog !== "function") throw new Error("外部能力 IPC 需要本地文件选择器。 ");
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("外部能力 IPC 需要 ipcMain。 ");
  if (!externalCapabilitiesService) throw new Error("外部能力 IPC 需要服务实例。 ");
  ipcMain.handle("external-capabilities:snapshot", () => externalCapabilitiesService.snapshot());
  ipcMain.handle("external-capabilities:import", async () => externalCapabilityIpcResult(async () => {
    const selection = await dialog.showOpenDialog(getMainWindow?.(), {
      title: "导入 Suzu 外部能力清单",
      properties: ["openFile"],
      filters: [
        { name: "Suzu capability manifest", extensions: ["json"] },
        { name: "JSON", extensions: ["json"] },
      ],
    });
    if (selection?.canceled || !selection?.filePaths?.[0]) {
      return { canceled: true, snapshot: await externalCapabilitiesService.snapshot() };
    }
    return { canceled: false, ...(await externalCapabilitiesService.importManifest({ manifestPath: selection.filePaths[0] })) };
  }));
  ipcMain.handle("external-capabilities:set-enabled", (_event, value) => externalCapabilityIpcResult(() => externalCapabilitiesService.setEnabled(value)));
  ipcMain.handle("external-capabilities:remove", (_event, value) => externalCapabilityIpcResult(() => externalCapabilitiesService.remove(value)));
}
