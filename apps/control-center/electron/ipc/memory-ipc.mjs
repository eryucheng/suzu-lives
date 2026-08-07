import { createMemoryService } from "../services/memory-service.mjs";

export function registerMemoryIpc({ ipcMain, settingsService, memoryService }) {
  const service = memoryService || createMemoryService({ settingsService });
  ipcMain.handle("memory:status", () => service.status());
  ipcMain.handle("memory:search", (_event, query) => service.search(String(query || "")));
  ipcMain.handle("memory:brain-graph", () => service.brainGraph());
  ipcMain.handle("memory:list", (_event, filters) => service.list(
    filters && typeof filters === "object" ? filters : {},
  ));
  ipcMain.handle("memory:detail", (_event, memoryId) => service.detail(
    String(memoryId || ""),
  ));
  ipcMain.handle("memory:edit", (_event, payload) => service.edit(
    String(payload?.memoryId || ""),
    payload?.patch && typeof payload.patch === "object" ? payload.patch : {},
    String(payload?.reason || ""),
  ));
  ipcMain.handle("memory:delete", (_event, payload) => service.remove(
    String(payload?.memoryId || ""),
    String(payload?.reason || ""),
  ));
  ipcMain.handle("memory:restore", (_event, payload) => service.restore(
    String(payload?.memoryId || ""),
    String(payload?.reason || ""),
  ));
  ipcMain.handle("memory:structure-proposals", (_event, filters) => (
    service.structureProposals(filters && typeof filters === "object" ? filters : {})
  ));
  ipcMain.handle("memory:resolve-structure", (_event, payload) => service.resolveStructure({
    proposalId: String(payload?.proposalId || ""),
    action: String(payload?.action || ""),
    note: String(payload?.note || ""),
  }));
  ipcMain.handle("memory:subject-attribution-proposals", (_event, filters) => (
    service.subjectAttributionProposals(
      filters && typeof filters === "object" ? filters : {},
    )
  ));
  ipcMain.handle("memory:resolve-subject-attribution", (_event, payload) => (
    service.resolveSubjectAttribution({
      proposalId: String(payload?.proposalId || ""),
      action: String(payload?.action || ""),
      note: String(payload?.note || ""),
    })
  ));
  ipcMain.handle("memory:retrieval-traces", (_event, filters) => (
    service.retrievalTraces(filters && typeof filters === "object" ? filters : {})
  ));
  ipcMain.handle("memory:retrieval-feedback", (_event, payload) => (
    service.recordRetrievalFeedback({
      traceId: String(payload?.traceId || ""),
      signal: String(payload?.signal || ""),
      targetMemoryIds: Array.isArray(payload?.targetMemoryIds) ? payload.targetMemoryIds : [],
      note: String(payload?.note || ""),
    })
  ));
  ipcMain.handle("memory:retrieval-stats", (_event, filters) => (
    service.memoryRetrievalStats(filters && typeof filters === "object" ? filters : {})
  ));
  ipcMain.handle("memory:edge-retrieval-stats", (_event, filters) => (
    service.edgeRetrievalStats(filters && typeof filters === "object" ? filters : {})
  ));
  ipcMain.handle("memory:plasticity-preview", (_event, filters) => (
    service.plasticityPreview(filters && typeof filters === "object" ? filters : {})
  ));
}
