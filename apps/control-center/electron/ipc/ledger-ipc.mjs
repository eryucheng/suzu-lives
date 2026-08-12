import { scanCostLedger } from "../services/cost-ledger.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

export function registerLedgerIpc({ ipcMain, settingsService, contactProjectsService }) {
  ipcMain.handle("ledger:scan", async () => {
    const settings = settingsService.load();
    const snapshot = await contactProjectsService.snapshot();
    const contactScopes = (Array.isArray(snapshot?.contacts) ? snapshot.contacts : []).map((contact) => {
      const usageLedgerPath = settingsService.usageLedgerPath({
        ...settings,
        agentId: clean(contact?.agentId),
        projectRoot: clean(contact?.projectRoot),
      });
      return {
        contactId: clean(contact?.id),
        contactName: clean(contact?.name),
        projectRoot: clean(contact?.projectRoot),
        sessionId: clean(contact?.sessionId),
        usageLedgerPath,
      };
    });
    return scanCostLedger(settings, { contactScopes });
  });
}
