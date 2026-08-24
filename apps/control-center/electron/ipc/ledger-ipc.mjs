import {
  readTodayCostLedger,
  scanCostLedger,
  warmTodayCostLedger,
} from "../services/cost-ledger.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

export function registerLedgerIpc({ ipcMain, settingsService, contactProjectsService, usageSubjects = [] }) {
  const resolveLedgerScope = async () => {
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
    const usageScopes = (Array.isArray(usageSubjects) ? usageSubjects : []).map((subject) => {
      const projectRoot = clean(subject?.projectRoot);
      const agentId = clean(subject?.agentId);
      return {
        subjectId: clean(subject?.subjectId),
        subjectName: clean(subject?.subjectName),
        subjectType: clean(subject?.subjectType),
        projectRoot,
        sessionId: clean(subject?.sessionId),
        usageLedgerPath: settingsService.usageLedgerPath({
          ...settings,
          agentId,
          projectRoot,
        }),
      };
    });
    return { settings, contactScopes, usageScopes };
  };

  ipcMain.handle("ledger:scan", async () => {
    const { settings, contactScopes, usageScopes } = await resolveLedgerScope();
    return scanCostLedger(settings, { contactScopes, usageScopes });
  });
  ipcMain.handle("ledger:today-summary", async () => {
    const { settings, contactScopes, usageScopes } = await resolveLedgerScope();
    return readTodayCostLedger(settings, { contactScopes, usageScopes });
  });
  ipcMain.handle("ledger:warm-today-summary", async () => {
    const { settings, contactScopes, usageScopes } = await resolveLedgerScope();
    return warmTodayCostLedger(settings, { contactScopes, usageScopes });
  });
}
