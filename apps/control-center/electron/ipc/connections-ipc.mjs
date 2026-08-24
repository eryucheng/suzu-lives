import { createNamedApiConnectionService } from "@suzu-lives/service-connections";
import { readVoiceServices } from "@suzu-lives/voice-message/voice-services";

export function createConnectionsService({ safeStorage, settingsService }) {
  const dataRoot = settingsService.response(settingsService.load()).dataRoot;
  const namedApi = createNamedApiConnectionService({ dataRoot, safeStorage });
  const apiServicesSnapshot = () => namedApi.snapshot();
  const resolveNamed = (feature) => namedApi.resolve(feature);
  const removeNamedApiConnection = async (id) => {
    const connectionId = String(id ?? "").trim();
    const voiceServices = readVoiceServices(dataRoot).filter((service) => service.connectionId === connectionId);
    if (voiceServices.length) {
      const names = voiceServices.slice(0, 3).map((service) => `“${service.name}”`).join("、");
      throw new Error(`这条 API 正被语音服务${names}${voiceServices.length > 3 ? "等" : ""}使用。请先修改或删除对应语音服务。`);
    }
    await namedApi.remove(connectionId);
    return apiServicesSnapshot();
  };
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
    resolveApiConnectionById: (connectionId) => namedApi.resolveById(connectionId),
    saveNamedApiConnection: async (value) => { await namedApi.save(value); return apiServicesSnapshot(); },
    removeNamedApiConnection,
    bindNamedApiConnection: async (feature, connectionId) => { await namedApi.bind(feature, connectionId); return apiServicesSnapshot(); },
  };
}

export function registerConnectionsIpc({ ipcMain, connectionsService }) {
  ipcMain.handle("connections:image-api-snapshot", () => connectionsService.imageApiSnapshot());
  ipcMain.handle("connections:api-services-snapshot", () => connectionsService.apiServicesSnapshot());
  ipcMain.handle("connections:save-named-api", (_event, value) => connectionsService.saveNamedApiConnection(value));
  ipcMain.handle("connections:remove-named-api", (_event, id) => connectionsService.removeNamedApiConnection(id));
  ipcMain.handle("connections:bind-named-api", (_event, feature, connectionId) => connectionsService.bindNamedApiConnection(feature, connectionId));
}
