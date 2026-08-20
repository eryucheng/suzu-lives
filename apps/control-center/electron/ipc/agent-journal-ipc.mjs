function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function contactScope(value) {
  const source = plainObject(value);
  return { contactId: clean(source.contactId) };
}

export function registerAgentJournalIpc({ agentJournalService, ipcMain } = {}) {
  if (!ipcMain?.handle || !agentJournalService?.snapshot) {
    throw new Error("Agent 日记 IPC 需要 ipcMain 和日记服务。 ");
  }
  ipcMain.handle("agent-journal:snapshot", (_event, value) => agentJournalService.snapshot(contactScope(value)));
}
