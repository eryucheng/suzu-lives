const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("legacyMigration", {
  inspect: () => ipcRenderer.invoke("legacy-migration:inspect"),
  migrate: () => ipcRenderer.invoke("legacy-migration:migrate"),
  close: () => ipcRenderer.invoke("legacy-migration:close"),
});
