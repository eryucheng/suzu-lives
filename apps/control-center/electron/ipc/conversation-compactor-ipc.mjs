function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function contactScope(value) {
  const source = plainObject(value);
  if (Object.hasOwn(source, "sessionId") || Object.hasOwn(source, "projectRoot")) {
    throw new Error("记忆压缩器只接受联系人范围。 ");
  }
  return { contactId: clean(source.contactId) };
}

function settingsValue(value) {
  const source = plainObject(value);
  const scope = contactScope(source);
  return {
    ...scope,
    ...(Object.hasOwn(source, "prompt") ? { prompt: source.prompt } : {}),
    ...(Object.hasOwn(source, "manual") ? { manual: source.manual } : {}),
    ...(Object.hasOwn(source, "automatic") ? { automatic: source.automatic } : {}),
  };
}

function runValue(value) {
  const source = plainObject(value);
  const scope = contactScope(source);
  return {
    ...scope,
    ...(Object.hasOwn(source, "retainTokens") ? { retainTokens: source.retainTokens } : {}),
  };
}

function importValue(value) {
  const source = plainObject(value);
  return {
    ...contactScope(source),
    sourcePath: clean(source.sourcePath),
  };
}

export function registerConversationCompactorIpc({
  ipcMain,
  compactorService,
  dialog,
  getMainWindow = () => null,
} = {}) {
  if (!ipcMain?.handle || !compactorService) {
    throw new Error("记忆压缩器 IPC 需要 ipcMain 和压缩服务。 ");
  }
  ipcMain.handle("conversation-compactor:snapshot", (_event, value) => compactorService.snapshot(contactScope(value)));
  ipcMain.handle("conversation-compactor:save", (_event, value) => compactorService.save(settingsValue(value)));
  ipcMain.handle("conversation-compactor:check", (_event, value) => compactorService.check(runValue(value)));
  ipcMain.handle("conversation-compactor:run", (_event, value) => compactorService.run(runValue(value)));
  ipcMain.handle("conversation-compactor:select-import-jsonl", async () => {
    if (!dialog?.showOpenDialog) throw new Error("当前环境无法选择会话 JSONL 文件。 ");
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: "选择要导入的 Claude 会话 JSONL",
      properties: ["openFile"],
      filters: [{ name: "Claude 会话 JSONL", extensions: ["jsonl"] }],
    });
    return {
      canceled: result.canceled === true,
      sourcePath: clean(result.filePaths?.[0]),
    };
  });
  ipcMain.handle("conversation-compactor:import-jsonl", (_event, value) => (
    compactorService.importHistory(importValue(value))
  ));
}
