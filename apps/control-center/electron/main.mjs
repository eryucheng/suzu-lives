import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, Menu, safeStorage } from "electron";

import { runSuzuLivesCli } from "@suzu-lives/claude-integration/agent-cli";
import { asDashScopeImageConnection, createDashScopeConnectionService, createImageVisionCredentialService, createNamedApiConnectionService, createVideoUnderstandingCredentialService } from "@suzu-lives/service-connections";
import { createSettingsService, registerIpcHandlers } from "./ipc/index.mjs";
import { runProjectHookCli } from "./hooks/runtime.mjs";
import { applyFeatureConnectionOverrides } from "./services/connection-model-overrides.mjs";
import { createDataStorageLocationService } from "./services/data-storage-location.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");
const APP_ICON = path.join(APP_ROOT, "assets", "app-icon.png");

// Keep Electron's own profile alongside Suzu's settings and operational data.
// The separate Roaming locator only records this root so a later launch can find it.
const dataStorageService = createDataStorageLocationService({
  legacyUserDataPath: app.getPath("userData"),
});
app.setPath("userData", dataStorageService.dataRoot);

let mainWindow = null;

function createWindow(settingsService) {
  const startupTheme = settingsService.load().theme;
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: startupTheme === "light" ? "#eef2f7" : "#090b12",
    icon: APP_ICON,
    autoHideMenuBar: true,
    title: "Suzu Lives Console",
    webPreferences: {
      preload: path.join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(APP_ROOT, "src", "index.html"), {
    query: { theme: startupTheme },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

const hookArgumentIndex = process.argv.indexOf("--suzu-lives-hook");
const cliArgumentIndex = process.argv.indexOf("--suzu-lives-cli");

async function cliConnectionResolver({ kind, dataRoot }) {
  const selected = await createNamedApiConnectionService({ dataRoot, safeStorage }).resolve(kind);
  if (selected) return applyFeatureConnectionOverrides({ kind, dataRoot, connection: selected });
  if (kind === "image-generation" || kind === "phone-camera") return asDashScopeImageConnection(await createDashScopeConnectionService({ dataRoot, safeStorage }).resolve());
  if (kind === "voice-message") return createDashScopeConnectionService({ dataRoot, safeStorage }).resolve();
  if (kind === "image-vision") return createImageVisionCredentialService({ dataRoot, safeStorage }).resolve();
  if (kind === "video-understanding") return createVideoUnderstandingCredentialService({ dataRoot, safeStorage }).resolve();
  return { key: "", source: "none" };
}

function quotedCommandPath(value) {
  const source = String(value || "").trim();
  if (!source || /[\r\n"]/u.test(source)) return "";
  return `"${source}"`;
}

function conversationAttachmentCli() {
  const executable = quotedCommandPath(app.isPackaged ? app.getPath("exe") : process.execPath);
  if (!executable) return "";
  if (app.isPackaged) return `${executable} --suzu-lives-cli`;
  const appRoot = quotedCommandPath(APP_ROOT);
  return appRoot ? `${executable} ${appRoot} --suzu-lives-cli` : "";
}

if (cliArgumentIndex !== -1) {
  app.whenReady()
    .then(() => runSuzuLivesCli({ args: process.argv.slice(cliArgumentIndex + 1), connectionResolver: cliConnectionResolver }))
    .finally(() => app.exit(process.exitCode || 0));
} else if (hookArgumentIndex !== -1) {
  app.whenReady()
    .then(() => runProjectHookCli({
      args: process.argv.slice(hookArgumentIndex + 1),
      connectionResolver: cliConnectionResolver,
    }))
    .finally(() => app.quit());
} else {
  const singleInstance = app.requestSingleInstanceLock();
  if (!singleInstance) {
    app.quit();
  } else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId("com.suzulives.console");
    Menu.setApplicationMenu(null);
    const settingsService = createSettingsService({ app, dataStorageService });
    registerIpcHandlers({
      app,
      getMainWindow: () => mainWindow,
      settingsService,
      dataStorageService,
      wechatAttachmentCli: conversationAttachmentCli(),
    });
    createWindow(settingsService);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(settingsService);
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  }
}
