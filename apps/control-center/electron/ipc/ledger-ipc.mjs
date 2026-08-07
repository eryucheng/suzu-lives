import { scanCostLedger } from "../services/cost-ledger.mjs";

export function registerLedgerIpc({ ipcMain, settingsService }) {
  ipcMain.handle("ledger:scan", async () => {
    const settings = settingsService.load();
    return scanCostLedger({ ...settings, usageLedgerPath: settingsService.usageLedgerPath(settings) });
  });
}
