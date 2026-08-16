import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_RENDERER_ZOOM_FACTOR, resetRendererZoom } from "../electron/services/renderer-zoom.mjs";

test("renderer startup clears a zoom persisted by an older Suzu build", () => {
  const calls = [];
  assert.equal(resetRendererZoom({
    getZoomFactor: () => 5 / 7,
    setZoomFactor: (value) => calls.push(value),
  }), true);
  assert.deepEqual(calls, [DEFAULT_RENDERER_ZOOM_FACTOR]);
});

test("renderer startup leaves the normal CSS baseline alone", () => {
  const calls = [];
  assert.equal(resetRendererZoom({
    getZoomFactor: () => DEFAULT_RENDERER_ZOOM_FACTOR,
    setZoomFactor: (value) => calls.push(value),
  }), true);
  assert.deepEqual(calls, []);
  assert.equal(resetRendererZoom(null), false);
});
