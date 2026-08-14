const ACTIONS = new Set(["minimize", "toggle-maximize", "close"]);

function activeWindow(window) {
  if (!window || typeof window !== "object" || window.isDestroyed?.() === true) return null;
  return window;
}

export function windowControlState(window) {
  const target = activeWindow(window);
  return {
    available: Boolean(target),
    maximized: target?.isMaximized?.() === true,
  };
}

export function applyWindowControl(window, action) {
  if (!ACTIONS.has(action)) throw new Error("无效的窗口控制操作。 ");
  const target = activeWindow(window);
  if (!target) return windowControlState(target);

  if (action === "minimize") target.minimize();
  if (action === "toggle-maximize") {
    if (target.isMaximized()) target.unmaximize();
    else target.maximize();
  }
  if (action === "close") target.close();
  return windowControlState(target);
}
