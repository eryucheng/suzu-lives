function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function memoryScope(value) {
  const source = plainObject(value);
  const contactId = String(source.contactId || "").trim();
  return {
    ...(contactId ? { contactId } : {}),
  };
}

export function registerMemoryIpc({ ipcMain, memoryService, dialog, getMainWindow = () => null }) {
  if (!memoryService) throw new Error("记忆 IPC 需要嵌入式长期记忆服务。");
  const service = memoryService;
  ipcMain.handle("memory:status", (_event, scope) => service.status(plainObject(scope)));
  ipcMain.handle("memory:search", (_event, value) => {
    if (typeof value === "string") return service.search(value);
    const source = plainObject(value);
    return service.search(String(source.query || ""), memoryScope(source));
  });
  ipcMain.handle("memory:brain-graph", (_event, scope) => service.brainGraph(plainObject(scope)));
  ipcMain.handle("memory:list", (_event, filters) => service.list(plainObject(filters)));
  ipcMain.handle("memory:detail", (_event, value) => {
    if (typeof value === "string") return service.detail(value);
    const source = plainObject(value);
    return service.detail(String(source.memoryId || ""), memoryScope(source));
  });
  ipcMain.handle("memory:edit", (_event, payload) => service.edit(
    String(payload?.memoryId || ""),
    payload?.patch && typeof payload.patch === "object" ? payload.patch : {},
    String(payload?.reason || ""),
    memoryScope(payload),
  ));
  ipcMain.handle("memory:delete", (_event, payload) => service.remove(
    String(payload?.memoryId || ""),
    String(payload?.reason || ""),
    memoryScope(payload),
  ));
  ipcMain.handle("memory:restore", (_event, payload) => service.restore(
    String(payload?.memoryId || ""),
    String(payload?.reason || ""),
    memoryScope(payload),
  ));
  ipcMain.handle("memory:review-overview", (_event, filters) => service.reviewOverview(plainObject(filters)));
  ipcMain.handle("memory:review-proposal", (_event, payload) => service.reviewProposal({
    type: String(payload?.type || ""),
    proposalId: String(payload?.proposalId || ""),
    ...memoryScope(payload),
  }));
  ipcMain.handle("memory:resolve-review", (_event, payload) => service.resolveReview({
    type: String(payload?.type || ""),
    proposalId: String(payload?.proposalId || ""),
    action: String(payload?.action || ""),
    note: String(payload?.note || ""),
    ...memoryScope(payload),
  }));
  ipcMain.handle("memory:retry-long-term-extraction-review", (_event, payload) => service.retryLongTermExtractionReview({
    proposalId: String(payload?.proposalId || ""),
    note: String(payload?.note || ""),
    ...memoryScope(payload),
  }));
  ipcMain.handle("memory:revoke-review-relation", (_event, payload) => service.revokeReviewRelation({
    proposalId: String(payload?.proposalId || ""),
    note: String(payload?.note || ""),
    ...memoryScope(payload),
  }));
  ipcMain.handle("memory:recover-review-input-batch", (_event, payload) => service.recoverReviewInputBatch({
    batchId: String(payload?.batchId || ""),
    force: payload?.force === true,
    ...memoryScope(payload),
  }));
  ipcMain.handle("memory:create-review-backup", (_event, scope) => service.createReviewBackup(plainObject(scope)));
  ipcMain.handle("memory:select-review-backup", async () => {
    if (!dialog?.showOpenDialog) throw new Error("当前环境无法选择记忆备份文件。");
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: "选择要恢复的记忆备份",
      properties: ["openFile"],
      filters: [{ name: "记忆数据库备份", extensions: ["db"] }],
    });
    return {
      canceled: result.canceled === true,
      sourcePath: String(result.filePaths?.[0] || ""),
    };
  });
  ipcMain.handle("memory:inspect-review-backup", (_event, payload) => service.inspectReviewBackup({
    sourcePath: String(payload?.sourcePath || ""),
    ...memoryScope(payload),
  }));
  ipcMain.handle("memory:restore-review-backup", (_event, payload) => service.restoreReviewBackup({
    sourcePath: String(payload?.sourcePath || ""),
    ...memoryScope(payload),
  }));
}
