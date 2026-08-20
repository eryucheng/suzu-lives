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
  const result = { ...scope };
  if (Object.hasOwn(source, "prompt")) result.prompt = String(source.prompt ?? "");
  if (Object.hasOwn(source, "automatic")) result.automatic = source.automatic;
  if (Object.hasOwn(source, "manual")) result.manual = source.manual;
  return result;
}

function runValue(value) {
  const source = plainObject(value);
  const scope = contactScope(source);
  const result = { ...scope };
  if (Object.hasOwn(source, "manual")) result.manual = source.manual;
  if (Object.hasOwn(source, "retainTokens")) result.retainTokens = source.retainTokens;
  return result;
}

export function registerConversationCompactorIpc({
  ipcMain,
  compactorService,
} = {}) {
  if (!ipcMain?.handle || typeof compactorService?.snapshot !== "function"
    || typeof compactorService?.save !== "function" || typeof compactorService?.run !== "function") {
    throw new Error("记忆压缩器 IPC 需要 ipcMain 和压缩服务。 ");
  }
  ipcMain.handle("conversation-compactor:snapshot", (_event, value) => compactorService.snapshot(contactScope(value)));
  ipcMain.handle("conversation-compactor:save", (_event, value) => compactorService.save(settingsValue(value)));
  ipcMain.handle("conversation-compactor:run", (_event, value) => compactorService.run(runValue(value)));
}
