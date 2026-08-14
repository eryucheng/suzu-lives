import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain, Menu, safeStorage } from "electron";
import { autoUpdater } from "electron-updater";

import { runSuzuLivesCli } from "@suzu-lives/claude-integration/agent-cli";
import { asDashScopeImageConnection, createDashScopeConnectionService, createImageVisionCredentialService, createNamedApiConnectionService, createVideoUnderstandingCredentialService } from "@suzu-lives/service-connections";
import { createSettingsService, registerIpcHandlers } from "./ipc/index.mjs";
import { runProjectHookCli } from "./hooks/runtime.mjs";
import { applyFeatureConnectionOverrides } from "./services/connection-model-overrides.mjs";
import { createAppUpdateService } from "./services/app-update.mjs";
import { createDataStorageLocationService } from "./services/data-storage-location.mjs";
import { applyWindowControl, windowControlState } from "./services/window-controls.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");
const APP_ICON = path.join(APP_ROOT, "assets", "app-icon.png");
const RENDERER_ROOT = path.join(APP_ROOT, "renderer");
const WINDOW_CHROME_HEIGHT = 64;
const DEV_RENDERER_URL = String(process.env.SUZU_LIVES_RENDERER_URL || "").trim();
const DEV_RENDERER_ORIGIN = "http://127.0.0.1:5173";

// Keep Electron's own profile alongside Suzu's settings and operational data.
// The separate Roaming locator only records this root so a later launch can find it.
const dataStorageService = createDataStorageLocationService({
  legacyUserDataPath: app.getPath("userData"),
});
app.setPath("userData", dataStorageService.dataRoot);

let mainWindow = null;

function normalizeTheme(value) {
  return value === "dark" ? "dark" : "light";
}

function titleBarOverlay(theme) {
  const light = normalizeTheme(theme) === "light";
  return {
    color: light ? "#f5f7fb" : "#0c0f1c",
    symbolColor: light ? "#1c2435" : "#f3f5fb",
    height: WINDOW_CHROME_HEIGHT,
  };
}

function trustedDevelopmentRendererUrl(value) {
  if (!DEV_RENDERER_URL || app.isPackaged) return false;
  try {
    const expected = new URL(DEV_RENDERER_URL);
    const candidate = new URL(String(value || ""));
    return expected.origin === DEV_RENDERER_ORIGIN
      && candidate.origin === DEV_RENDERER_ORIGIN;
  } catch {
    return false;
  }
}

function rendererUrl(theme) {
  if (!trustedDevelopmentRendererUrl(DEV_RENDERER_URL)) return "";
  const url = new URL(DEV_RENDERER_URL);
  url.searchParams.set("theme", normalizeTheme(theme));
  return url.toString();
}

function applyWindowChromeTheme(window, theme) {
  if (!window || window.isDestroyed()) return false;
  const normalized = normalizeTheme(theme);
  window.setBackgroundColor(normalized === "light" ? "#eef2f7" : "#090b12");
  if (process.platform === "linux" && typeof window.setTitleBarOverlay === "function") {
    window.setTitleBarOverlay(titleBarOverlay(normalized));
  }
  return true;
}

function sendWindowControlState(window = mainWindow) {
  const state = windowControlState(window);
  if (state.available) window.webContents.send("window-chrome:state", state);
  return state;
}

function isSuzuRendererUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "file:" || trustedDevelopmentRendererUrl(url.toString());
  } catch {
    return false;
  }
}

function configureMicrophonePermission(webContents) {
  const session = webContents?.session;
  if (!session) return;
  // Voice calls are an in-app feature.  Approve microphone access only for
  // Suzu's local renderer and only for audio; camera/screen permissions keep
  // their normal deny-by-default behavior.
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin) => (
    permission === "media" && isSuzuRendererUrl(requestingOrigin)
  ));
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const requestedMedia = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
    const audioOnly = requestedMedia.length === 0 || requestedMedia.every((kind) => kind === "audio");
    callback(permission === "media" && audioOnly && isSuzuRendererUrl(details?.requestingUrl || details?.securityOrigin));
  });
}

function createWindow(settingsService) {
  const startupTheme = normalizeTheme(settingsService.load().theme);
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: startupTheme === "light" ? "#eef2f7" : "#090b12",
    icon: APP_ICON,
    autoHideMenuBar: true,
    title: "Suzu Lives",
    titleBarStyle: "hidden",
    ...(process.platform === "linux" ? { titleBarOverlay: titleBarOverlay(startupTheme) } : {}),
    webPreferences: {
      preload: path.join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  configureMicrophonePermission(mainWindow.webContents);
  const developmentUrl = rendererUrl(startupTheme);
  if (developmentUrl) mainWindow.loadURL(developmentUrl);
  else mainWindow.loadFile(path.join(RENDERER_ROOT, "index.html"), { query: { theme: startupTheme } });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.on("maximize", () => sendWindowControlState(mainWindow));
  mainWindow.on("unmaximize", () => sendWindowControlState(mainWindow));
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

function claudeWorkspaceRoot() {
  // Every Suzu persona gets the same software workspace, including future
  // contacts.  In development that is the repository root; packaged builds
  // retain the app's own root as their shared working area.
  return app.isPackaged ? APP_ROOT : path.resolve(APP_ROOT, "..", "..");
}

if (cliArgumentIndex !== -1) {
  app.whenReady()
    .then(() => runSuzuLivesCli({ args: process.argv.slice(cliArgumentIndex + 1), connectionResolver: cliConnectionResolver }))
    .finally(() => app.exit(process.exitCode || 0));
} else if (hookArgumentIndex !== -1) {
  app.whenReady()
    .then(() => runProjectHookCli({
      args: process.argv.slice(hookArgumentIndex + 1),
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
    const appUpdateService = createAppUpdateService({ app, autoUpdater });
    const cliLauncherCommand = conversationAttachmentCli();
    registerIpcHandlers({
      app,
      appUpdateService,
      getMainWindow: () => mainWindow,
      settingsService,
      dataStorageService,
      wechatAttachmentCli: cliLauncherCommand,
      cliLauncherCommand,
      claudeWorkspaceDirectories: [claudeWorkspaceRoot()],
    });
    ipcMain.handle("window-chrome:apply-theme", (event, theme) => {
      if (event.sender !== mainWindow?.webContents) return false;
      return applyWindowChromeTheme(mainWindow, theme);
    });
    ipcMain.handle("window-chrome:state", (event) => {
      if (event.sender !== mainWindow?.webContents) return { available: false, maximized: false };
      return windowControlState(mainWindow);
    });
    ipcMain.handle("window-chrome:control", (event, action) => {
      if (event.sender !== mainWindow?.webContents) return { available: false, maximized: false };
      return applyWindowControl(mainWindow, action);
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
