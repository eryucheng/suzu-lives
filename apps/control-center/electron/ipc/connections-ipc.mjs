import fsp from "node:fs/promises";
import path from "node:path";

import { createNamedApiConnectionService } from "@suzu-lives/service-connections";
import { validateComfyRegistry } from "@suzu-lives/image-workbench";

export function createConnectionsService({ safeStorage, settingsService }) {
  const dataRoot = settingsService.response(settingsService.load()).dataRoot;
  const namedApi = createNamedApiConnectionService({ dataRoot, safeStorage });
  const comfyPath = path.join(dataRoot, "connections", "comfyui.json");
  const comfySnapshot = async () => { let value = {}; try { value = JSON.parse(await fsp.readFile(comfyPath, "utf8")); } catch {} let registry = { version: 1, workflows: {} }; try { registry = validateComfyRegistry(value.registry || registry); } catch {} return { baseUrl: String(value.baseUrl || "http://127.0.0.1:8188").trim(), timeoutMs: Number(value.timeoutMs) || 600000, pollIntervalMs: Number(value.pollIntervalMs) || 1000, registry: { version: 1, workflows: Object.values(registry.workflows).map(({ id, enabled, description }) => ({ id, enabled, description })) } }; };
  const saveComfy = async (value = {}) => { let existing = {}; try { existing = JSON.parse(await fsp.readFile(comfyPath, "utf8")); } catch {} let registry = { version: 1, workflows: {} }; const text = String(value.registry || "").trim(); try { registry = validateComfyRegistry(text ? JSON.parse(text) : (existing.registry || registry)); } catch (error) { throw new Error(error?.message || "ComfyUI registry 无效。"); } const baseUrl = String(value.baseUrl || "http://127.0.0.1:8188").trim().replace(/\/+$/u, ""); try { const parsed = new URL(baseUrl); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); } catch { throw new Error("ComfyUI 地址必须是 HTTP(S) URL。"); } await fsp.mkdir(path.dirname(comfyPath), { recursive: true }); await fsp.writeFile(comfyPath + ".tmp", JSON.stringify({ baseUrl, timeoutMs: Number(value.timeoutMs) || 600000, pollIntervalMs: Number(value.pollIntervalMs) || 1000, registry }, null, 2) + "\n", "utf8"); await fsp.rename(comfyPath + ".tmp", comfyPath); return comfySnapshot(); };
  const apiServicesSnapshot = async () => ({ ...(await namedApi.snapshot()), comfy: await comfySnapshot() });
  const resolveNamed = (feature) => namedApi.resolve(feature);
  const imageApiSnapshot = async () => {
    const selected = await resolveNamed("image-workbench");
    return {
      baseUrl: selected?.baseUrl || "",
      configured: Boolean(selected?.apiKey),
      connectionName: selected?.name || "",
      credentialStatus: selected?.credentialStatus || "missing",
      provider: selected?.name || "未选择 API",
      referenceImageModel: selected?.model || "",
      source: selected?.apiKey ? "saved" : "none",
      textToImageModel: selected?.model || "",
      baseUrlSource: "saved",
      timeoutMs: selected?.timeoutMs || 180000,
    };
  };
  return {
    imageApiSnapshot,
    resolveImageApi: async () => resolveNamed("image-workbench"),
    resolveImageVisionApi: async () => resolveNamed("image-vision"),
    resolveVideoUnderstandingApi: async () => resolveNamed("video-understanding"),
    apiServicesSnapshot,
    resolveNamedApiConnection: resolveNamed,
    saveNamedApiConnection: async (value) => { await namedApi.save(value); return apiServicesSnapshot(); },
    removeNamedApiConnection: async (id) => { await namedApi.remove(id); return apiServicesSnapshot(); },
    bindNamedApiConnection: async (feature, connectionId) => { await namedApi.bind(feature, connectionId); return apiServicesSnapshot(); },
    comfySnapshot,
    saveComfy,
  };
}

export function registerConnectionsIpc({ ipcMain, connectionsService }) {
  ipcMain.handle("connections:image-api-snapshot", () => connectionsService.imageApiSnapshot());
  ipcMain.handle("connections:comfyui-snapshot", () => connectionsService.comfySnapshot());
  ipcMain.handle("connections:save-comfyui", (_event, value) => connectionsService.saveComfy(value));
  ipcMain.handle("connections:api-services-snapshot", () => connectionsService.apiServicesSnapshot());
  ipcMain.handle("connections:save-named-api", (_event, value) => connectionsService.saveNamedApiConnection(value));
  ipcMain.handle("connections:remove-named-api", (_event, id) => connectionsService.removeNamedApiConnection(id));
  ipcMain.handle("connections:bind-named-api", (_event, feature, connectionId) => connectionsService.bindNamedApiConnection(feature, connectionId));
}
