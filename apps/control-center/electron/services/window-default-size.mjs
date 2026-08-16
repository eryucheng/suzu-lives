// The visual reference is the current design workstation's normal desktop
// window: 1460 × 920 DIP within a 2195 × 1187 DIP usable work area.  Keep the
// *window coverage* constant across displays; leave DPI scaling to Electron.

export const DESIGN_REFERENCE_WORK_AREA = Object.freeze({ width: 2195, height: 1187 });
export const DESIGN_REFERENCE_WINDOW_SIZE = Object.freeze({ width: 1460, height: 920 });
export const DEFAULT_MIN_WINDOW_SIZE = Object.freeze({ width: 1080, height: 700 });

export const WINDOW_WORK_AREA_RATIO = Object.freeze({
  width: DESIGN_REFERENCE_WINDOW_SIZE.width / DESIGN_REFERENCE_WORK_AREA.width,
  height: DESIGN_REFERENCE_WINDOW_SIZE.height / DESIGN_REFERENCE_WORK_AREA.height,
});

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function workAreaSize(display) {
  const size = display?.workAreaSize || display?.workArea || {};
  return {
    width: finitePositive(size.width),
    height: finitePositive(size.height),
  };
}

function sizeForAvailableSpace(available, ratio, fallback) {
  if (!available) return fallback;
  return Math.max(1, Math.min(available, Math.round(available * ratio)));
}

export function windowSizeForDisplay(display) {
  const workArea = workAreaSize(display);
  const width = sizeForAvailableSpace(workArea.width, WINDOW_WORK_AREA_RATIO.width, DESIGN_REFERENCE_WINDOW_SIZE.width);
  const height = sizeForAvailableSpace(workArea.height, WINDOW_WORK_AREA_RATIO.height, DESIGN_REFERENCE_WINDOW_SIZE.height);
  return {
    width,
    height,
    minWidth: Math.min(DEFAULT_MIN_WINDOW_SIZE.width, width),
    minHeight: Math.min(DEFAULT_MIN_WINDOW_SIZE.height, height),
  };
}
