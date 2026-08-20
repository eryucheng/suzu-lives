import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain, Menu, screen } from "electron";
import electronUpdater from "electron-updater";

import { createSettingsService, registerIpcHandlers } from "./ipc/index.mjs";
import { registerLegacyMigrationIpc } from "./ipc/legacy-migration-ipc.mjs";
import { createAppUpdateService, scheduleAppUpdateChecks } from "./services/app-update.mjs";
import { createDataStorageLocationService } from "./services/data-storage-location.mjs";
import { createReleaseAnnouncementService } from "./services/release-announcement.mjs";
import { resetRendererZoom } from "./services/renderer-zoom.mjs";
import { windowSizeForDisplay } from "./services/window-default-size.mjs";
import { applyWindowControl, windowControlState } from "./services/window-controls.mjs";
import { CURRENT_RELEASE_ANNOUNCEMENT } from "../shared/current-release-announcement.mjs";

const { autoUpdater } = electronUpdater;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");
const APP_ICON = path.join(APP_ROOT, "assets", "app-icon.png");
const RENDERER_ROOT = path.join(APP_ROOT, "renderer");
const WINDOW_CHROME_HEIGHT = 64;
const DEV_RENDERER_URL = String(process.env.SUZU_LIVES_RENDERER_URL || "").trim();
const DEV_RENDERER_ORIGIN = "http://127.0.0.1:5173";
const LEGACY_MIGRATION_MODE = process.argv.includes("--legacy-migration");

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
  const windowSize = windowSizeForDisplay(screen.getPrimaryDisplay());
  mainWindow = new BrowserWindow({
    width: windowSize.width,
    height: windowSize.height,
    minWidth: windowSize.minWidth,
    minHeight: windowSize.minHeight,
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
  mainWindow.webContents.once("did-finish-load", () => resetRendererZoom(mainWindow?.webContents));
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

function legacyMigrationRendererUrl() {
  if (!trustedDevelopmentRendererUrl(DEV_RENDERER_URL)) return "";
  const url = new URL(DEV_RENDERER_URL);
  url.pathname = "/legacy-migration.html";
  url.search = "";
  return url.toString();
}

function createLegacyMigrationWindow() {
  mainWindow = new BrowserWindow({
    width: 740,
    height: 680,
    minWidth: 620,
    minHeight: 540,
    show: false,
    backgroundColor: "#0d1220",
    icon: APP_ICON,
    autoHideMenuBar: true,
    title: "Suzu Lives 数据迁移",
    webPreferences: {
      preload: path.join(HERE, "legacy-migration-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  const developmentUrl = legacyMigrationRendererUrl();
  if (developmentUrl) mainWindow.loadURL(developmentUrl);
  else mainWindow.loadFile(path.join(RENDERER_ROOT, "legacy-migration.html"));
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

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
    if (LEGACY_MIGRATION_MODE) {
      registerLegacyMigrationIpc({
        app,
        dataStorageService,
        getMigrationWindow: () => mainWindow,
        ipcMain,
        settingsService,
      });
      createLegacyMigrationWindow();
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createLegacyMigrationWindow();
      });
      return;
    }
    const appUpdateService = createAppUpdateService({ app, autoUpdater });
    const releaseAnnouncementService = createReleaseAnnouncementService({
      app,
      announcement: CURRENT_RELEASE_ANNOUNCEMENT,
      settingsService,
    });
    registerIpcHandlers({
      app,
      appUpdateService,
      releaseAnnouncementService,
      getMainWindow: () => mainWindow,
      settingsService,
      dataStorageService,
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
    const stopAppUpdateChecks = app.isPackaged === true
      ? scheduleAppUpdateChecks({
        checkForUpdates: () => appUpdateService.checkForUpdates(),
      })
      : () => {};
    app.once("before-quit", stopAppUpdateChecks);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(settingsService);
    });
  });

  app.on("window-all-closed", () => {
    if (LEGACY_MIGRATION_MODE || process.platform !== "darwin") app.quit();
  });
  }
