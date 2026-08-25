import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(APP_ROOT, "..", "..");
const readApp = (...parts) => readFileSync(resolve(APP_ROOT, ...parts), "utf8");
const readRepo = (...parts) => readFileSync(resolve(REPO_ROOT, ...parts), "utf8");

test("wallpaper stage renders managed image and video backgrounds below the application shell", () => {
  const stage = readApp("src", "react", "wallpaper-stage.jsx");
  const shell = readApp("src", "react", "app-shell.jsx");
  const shellStyles = readApp("src", "react", "app-shell.css");

  assert.match(stage, /wallpaper\.kind === "video"/u);
  assert.match(stage, /autoPlay[\s\S]*loop[\s\S]*muted[\s\S]*playsInline[\s\S]*preload="metadata"/u);
  assert.match(stage, /visibilitychange/u);
  assert.match(stage, /prefers-reduced-motion: reduce/u);
  assert.match(shell, /<WallpaperStage[\s\S]*?<div\s+[\s\S]*?className=\{`app-shell/u);
  assert.match(shellStyles, /isolation:isolate/u);
  assert.match(shellStyles, /z-index:var\(--z-app,10\)/u);
  assert.match(shellStyles, /data-ui-style="wallpaper-glass"\] \.shell-main::before/u);
  assert.match(shellStyles, /data-ui-style="wallpaper-glass"\] \.shell-main::after/u);
  assert.match(shellStyles, /\.shell-main::before,[\s\S]*?\.shell-main::after \{[\s\S]*?background:var\(--shell-chrome-bg\)/u);
  assert.match(shellStyles, /data-ui-style="wallpaper-glass"\] \.shell-bottombar,[\s\S]*?backdrop-filter:var\(--surface-backdrop\)/u);
  const shellBackdropBlock = shellStyles.match(/:root\[data-ui-style="wallpaper-glass"\] \.shell-sidebar,[\s\S]*?\{[\s\S]*?\}/u)?.[0] || "";
  assert.doesNotMatch(shellBackdropBlock, /\.shell-main > \.content/u);
});

test("appearance controls and preload expose the named wallpaper library workflow", () => {
  const preload = readApp("electron", "preload.cjs");
  const settingsIpc = readApp("electron", "ipc", "settings-ipc.mjs");
  const page = readApp("src", "react", "settings-page.jsx");
  const app = readApp("src", "app.mjs");

  assert.match(preload, /selectWallpaperSource: \(sourceType\) => ipcRenderer\.invoke\("settings:select-wallpaper-source", sourceType\)/u);
  assert.match(preload, /importWallpaper: \(value\) => ipcRenderer\.invoke\("settings:import-wallpaper", value\)/u);
  assert.match(preload, /selectWallpaper: \(folderName\) => ipcRenderer\.invoke\("settings:select-wallpaper", folderName\)/u);
  assert.match(preload, /updateWallpaper: \(value\) => ipcRenderer\.invoke\("settings:update-wallpaper", value\)/u);
  assert.match(preload, /removeWallpaper: \(folderName\) => ipcRenderer\.invoke\("settings:remove-wallpaper", folderName\)/u);
  assert.match(preload, /clearWallpaper: \(\) => ipcRenderer\.invoke\("settings:clear-wallpaper"\)/u);
  assert.match(settingsIpc, /properties: requestedType === "directory" \? \["openDirectory"\] : \["openFile"\]/u);
  assert.match(settingsIpc, /appearance: \{ styleId: "wallpaper-glass", wallpaper: \{ folderName: item\.folderName \} \}/u);
  assert.match(settingsIpc, /ipcMain\.handle\("settings:update-wallpaper"/u);
  assert.match(page, /经典/u);
  assert.match(page, /壁纸玻璃/u);
  assert.match(page, /添加壁纸/u);
  assert.match(page, /<Button disabled=\{Boolean\(pending\)\} onClick=\{onAdd\} size="md">添加壁纸<\/Button>/u);
  assert.match(page, /选择图片或视频/u);
  assert.match(page, /选择壁纸文件夹/u);
  assert.match(page, /壁纸名称/u);
  assert.match(page, /打开壁纸目录/u);
  assert.match(page, /function WallpaperEditDialog/u);
  assert.match(page, /title="编辑壁纸"/u);
  assert.match(page, /aria-label="置顶壁纸"/u);
  assert.match(page, /onClick=\{\(\) => onEdit\(item\)\}[\s\S]*?>编辑<\/Button>/u);
  assert.match(page, /item\.kind === "video" && item\.url[\s\S]*?<video[\s\S]*?muted[\s\S]*?onLoadedMetadata=\{revealWallpaperVideoFirstFrame\}[\s\S]*?preload="metadata"/u);
  assert.match(page, /video\.currentTime = Math\.min\(0\.001, video\.duration\)/u);
  assert.match(page, /\{ label: "壁纸", value: "wallpaper" \}/u);
  assert.match(page, /tab === "wallpaper" \? \(/u);
  const generalSettings = page.slice(page.indexOf("function GeneralSettings"), page.indexOf("function WallpaperSettings"));
  const wallpaperSettings = page.slice(page.indexOf("function WallpaperSettings"), page.indexOf("function systemStatusPresentation"));
  const wallpaperLibrary = page.slice(page.indexOf("function WallpaperLibrary"), page.indexOf("function GeneralSettings"));
  assert.doesNotMatch(generalSettings, /WallpaperLibrary|壁纸玻璃|onSelectWallpaperSource/u);
  assert.match(wallpaperSettings, /<WallpaperLibrary/u);
  assert.match(wallpaperSettings, /壁纸显示/u);
  assert.match(wallpaperLibrary, /<span>\{wallpaperKindLabel\(item\.kind\)\}<\/span>/u);
  assert.doesNotMatch(wallpaperLibrary, /item\.message|item\.entryFile/u);
  assert.match(app, /\["general", "wallpaper", "main-model", "api", "data", "privacy"\]/u);
  assert.match(app, /importSettingsWallpaper/u);
  assert.match(app, /updateSettingsWallpaper/u);
  assert.match(app, /removeSettingsWallpaper/u);
  assert.match(app, /document\.documentElement\.dataset\.uiStyle/u);
  assert.match(app, /reportWallpaperError/u);
});

test("semantic surfaces and body portals share the global layer scale", () => {
  const themes = readRepo("packages", "design-system", "src", "styles", "themes.css");
  const dialog = readRepo("packages", "design-system", "src", "components", "Dialog", "Dialog.tsx");
  const drawer = readRepo("packages", "design-system", "src", "components", "Drawer", "Drawer.tsx");
  const conversation = readApp("src", "react", "conversation-page.jsx");
  const conversationStyles = readApp("src", "styles", "conversation.css");

  for (const token of ["--z-wallpaper", "--z-app", "--z-dialog", "--z-media-preview", "--z-loading", "--surface-shell-chrome", "--surface-page", "--surface-card", "--surface-dialog", "--surface-glass-sheen", "--surface-card-glaze", "--surface-standard-card-shadow", "--surface-chat-bubble"]) {
    assert.match(themes, new RegExp(token, "u"));
  }
  assert.match(themes, /data-ui-style='wallpaper-glass'[\s\S]*?--surface-page: transparent/u);
  assert.match(themes, /data-ui-style='wallpaper-glass'[\s\S]*?--surface-shell-chrome: transparent;/u);
  assert.match(themes, /data-ui-style='wallpaper-glass'[\s\S]*?--surface-chat-workspace: transparent;/u);
  assert.match(themes, /data-ui-style='wallpaper-glass'[\s\S]*?--surface-chat-pane: transparent;/u);
  assert.match(conversationStyles, /data-ui-style="wallpaper-glass"\] \.content\.content--conversation \.conversation-workspace/u);
  assert.match(conversationStyles, /data-ui-style="wallpaper-glass"\] \.content--conversation \.conversation-roster \{[\s\S]*?background: var\(--surface-chat-roster\);/u);
  assert.match(conversationStyles, /conversation-chat-shell \{[\s\S]*?background: transparent;[\s\S]*?box-shadow: none;/u);
  assert.match(conversationStyles, /conversation-bubble \{[\s\S]*?background: var\(--surface-chat-bubble\);/u);
  assert.match(dialog, /createPortal\(dialog, document\.body\)/u);
  assert.match(drawer, /createPortal\(drawer, document\.body\)/u);
  assert.match(conversation, /createPortal\(layer, document\.body\)/u);
});
