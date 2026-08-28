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
  assert.match(shell, /<header className="topbar shell-topbar">\s*<div aria-label="标题栏控制" className="shell-titlebar-controls" role="group">[\s\S]*?<WindowControls \/>/u);
  assert.match(styles, /\.shell-topbar\s*\{[^}]*position:relative;[^}]*z-index:50;[^}]*-webkit-app-region:drag;/su);
  assert.match(styles, /\.shell-sidebar-resizer\s*\{[^}]*z-index:40;/su);
  assert.match(styles, /\.shell-titlebar-controls\s*\{[^}]*position:absolute;[^}]*right:4px;[^}]*-webkit-app-region:no-drag;/su);
  assert.match(styles, /\.shell-window-controls\s*\{[^}]*display:flex;[^}]*gap:2px;[^}]*-webkit-app-region:no-drag;/su);
});

test("assistant and window controls share compact chrome styling and line icons", () => {
  const shell = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.jsx"), "utf8");
  const styles = readFileSync(resolve(HERE, "..", "src", "react", "app-shell.css"), "utf8");

  assert.match(shell, /className=\{`shell-titlebar-control shell-assistant-toggle/u);
  assert.match(shell, /className="shell-titlebar-control shell-window-control/u);
  assert.match(styles, /\.shell-titlebar-control\s*\{[^}]*width:32px;[^}]*height:32px;[^}]*border-radius:10px;[^}]*color:var\(--text-secondary\);/su);
  assert.match(styles, /\.shell-titlebar-control:hover,\s*\.shell-titlebar-control\.is-active\s*\{[^}]*color:var\(--accent\);/su);
  assert.match(styles, /\.shell-window-control--close:hover,\s*\.shell-window-control--close:active\s*\{[^}]*border-color:#ef1731;[^}]*background:#ef1731;[^}]*color:#fff;/su);
  assert.doesNotMatch(shell, /WINDOW_CONTROL_GLYPH/u);
  assert.match(shell, /restore: <>\s*<path d="M9 5h8\.5[^"]+" \/>\s*<rect x="5" y="8" width="11" height="11" rx="1\.5" \/>\s*<\/>/u);
  assert.match(styles, /\.shell-window-control-icon\s*\{[^}]*stroke:currentColor;[^}]*stroke-width:1\.7;/su);
});
