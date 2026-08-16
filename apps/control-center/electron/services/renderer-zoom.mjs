// Electron persists page zoom by origin in its user profile.  Suzu does not
// expose a user zoom preference, so always restore the CSS design baseline at
// startup and clear any zoom left by older builds.

export const DEFAULT_RENDERER_ZOOM_FACTOR = 1;

export function resetRendererZoom(webContents) {
  if (!webContents || typeof webContents.setZoomFactor !== "function") return false;
  const current = Number(webContents.getZoomFactor?.());
  if (!Number.isFinite(current) || Math.abs(current - DEFAULT_RENDERER_ZOOM_FACTOR) > 0.001) {
    webContents.setZoomFactor(DEFAULT_RENDERER_ZOOM_FACTOR);
  }
  return true;
}
