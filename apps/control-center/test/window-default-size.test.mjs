import assert from "node:assert/strict";
import test from "node:test";

import {
  DESIGN_REFERENCE_WINDOW_SIZE,
  WINDOW_WORK_AREA_RATIO,
  windowSizeForDisplay,
} from "../electron/services/window-default-size.mjs";

test("the design workstation keeps its exact original window geometry", () => {
  assert.deepEqual(windowSizeForDisplay({ workAreaSize: { width: 2195, height: 1187 }, scaleFactor: 1.75 }), {
    width: 1460,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
  });
});

test("new displays keep the same usable-work-area coverage without overriding Electron DPI", () => {
  const smaller = windowSizeForDisplay({ workAreaSize: { width: 1366, height: 728 }, scaleFactor: 1 });
  assert.equal(smaller.width, Math.round(1366 * WINDOW_WORK_AREA_RATIO.width));
  assert.equal(smaller.height, Math.round(728 * WINDOW_WORK_AREA_RATIO.height));
  assert.equal(smaller.minWidth, smaller.width);
  assert.equal(smaller.minHeight, smaller.height);

  assert.deepEqual(windowSizeForDisplay(null), {
    width: DESIGN_REFERENCE_WINDOW_SIZE.width,
    height: DESIGN_REFERENCE_WINDOW_SIZE.height,
    minWidth: 1080,
    minHeight: 700,
  });
});
