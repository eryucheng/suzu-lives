import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyWindowControl, windowControlState } from "../electron/services/window-controls.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function windowMock() {
  const calls = [];
  let maximized = false;
  return {
    calls,
    close: () => calls.push("close"),
    isDestroyed: () => false,
    isMaximized: () => maximized,
    maximize: () => {
      maximized = true;
      calls.push("maximize");
    },
    minimize: () => calls.push("minimize"),
    unmaximize: () => {
      maximized = false;
      calls.push("unmaximize");
    },
  };
}

test("custom window controls operate the active BrowserWindow and keep maximize state", () => {
  const window = windowMock();
  assert.deepEqual(windowControlState(window), { available: true, maximized: false });

  assert.deepEqual(applyWindowControl(window, "minimize"), { available: true, maximized: false });
  assert.deepEqual(applyWindowControl(window, "toggle-maximize"), { available: true, maximized: true });
  assert.deepEqual(applyWindowControl(window, "toggle-maximize"), { available: true, maximized: false });
  assert.deepEqual(applyWindowControl(window, "close"), { available: true, maximized: false });
  assert.deepEqual(window.calls, ["minimize", "maximize", "unmaximize", "close"]);
});

test("custom window controls reject unknown commands and safely ignore a missing window", () => {
  assert.deepEqual(applyWindowControl(null, "minimize"), { available: false, maximized: false });
  assert.throws(() => applyWindowControl(windowMock(), "quit-everything"), /无效的窗口控制操作/u);
});

test("custom window controls live inside the titlebar no-drag region", () => {
  const shell = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.jsx"), "utf8");
  const styles = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.css"), "utf8");
  assert.match(shell, /<header className="topbar shell-topbar">\s*<WindowControls \/>/u);
  assert.match(styles, /\.shell-topbar\s*\{[^}]*position:relative;[^}]*-webkit-app-region:drag;/su);
  assert.match(styles, /\.shell-window-controls\s*\{[^}]*position:absolute;[^}]*-webkit-app-region:no-drag;/su);
});
