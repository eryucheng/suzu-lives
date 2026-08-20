import { createExternalCapabilitiesService } from "@suzu-lives/external-capabilities";

import { resolveSuzuAgentRuntimePaths } from "../services/suzu-agent-runtime.mjs";
import { createAgentExternalCapabilityRegistration } from "../services/agent-external-capabilities.mjs";

function clean(value) {
  return String(value ?? "").trim();
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

/**
 * Adapts the existing local manifest registry to Suzu Agent Core's extension seams:
 * Skills go under the managed user skill root, while MCP rows go in a separate
 * Suzu-managed Cordis patch passed only to Suzu's owned child. This is a
 * global runtime installation, deliberately independent of any one contact.
 */
export function createExternalCapabilitiesIpcService({ settingsService, runtime = null, fsOps } = {}) {
  if (!settingsService || typeof settingsService.load !== "function" || typeof settingsService.response !== "function") {
    throw new Error("外部能力服务需要软件设置服务。 ");
  }
  const settings = settingsService.load();
  const dataRoot = clean(settingsService.response(settings)?.dataRoot);
  const runtimeHome = resolveSuzuAgentRuntimePaths({ dataRoot }).runtimeHome;
  const registrationAdapter = createAgentExternalCapabilityRegistration({
    runtimeHome,
    fsOps,
    onChanged: async () => {
      // The registration remains durable even if a just-closing child reports
      // an OS shutdown issue; next chat starts a fresh owned Agent Core process with
      // the new managed patch. No third-party process runs during import.
      try { return await runtime?.()?.reloadExternalCapabilities?.(); }
      catch { return { reloaded: false }; }
    },
  });
  const service = createExternalCapabilitiesService({
    dataRoot,
    projectRoot: runtimeHome,
    fsOps,
    registrationAdapter,
    scopeLabel: "Suzu Agent Core",
  });
  const snapshot = async () => {
    const value = await service.snapshot();
    return {
      ...value,
      runtime: "agent-core",
      runtimeHome,
      scope: "global-agent-core",
      status: "ready",
      message: "Skill 与 MCP 会安装到 Suzu 管理的 Agent Core；启用、停用后下一次聊天会使用新配置。",
    };
  };
  return {
    snapshot,
    async importManifest(value) {
      const result = await service.importManifest(value);
      return { ...result, snapshot: await snapshot() };
    },
    async setEnabled(value) {
      const result = await service.setEnabled(value);
      return { ...result, snapshot: await snapshot() };
    },
    async remove(value) {
      const result = await service.remove(value);
      return { ...result, snapshot: await snapshot() };
    },
    async adoptLegacyInstallations(value) {
      const result = await service.adoptInstallations(value);
      return { ...result, snapshot: await snapshot() };
    },
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
