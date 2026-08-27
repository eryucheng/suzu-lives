import assert from "node:assert/strict";
import test from "node:test";

import {
  centeredSquareCrop,
  normalizeSquareAvatarImage,
  portraitBiasedSquareCrop,
  squareCropAroundNormalizedBox,
} from "../src/avatar-image.mjs";

test("avatar image normalization decodes WebP and emits a square PNG", async () => {
  const webp = Buffer.from(
    "UklGRjoAAABXRUJQVlA4IC4AAACwAQCdASoIAAkAAUAmJaACdLoABdQAAP7xTa/9lY/9Kx/6Vj9kj/cGZ9XX+AAA",
    "base64",
  );

  const result = await normalizeSquareAvatarImage(webp);

  assert.equal(result.mimeType, "image/png");
  assert.equal(result.strategy, "portrait-bias");
  assert.equal(result.width, 8);
  assert.equal(result.height, 8);
  assert.deepEqual(Buffer.from(result.bytes).subarray(0, 8), Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]));
});

test("avatar image normalization uses a centered square crop", () => {
  assert.deepEqual(centeredSquareCrop({ width: 480, height: 491 }), {
    left: 0,
    top: 5,
    width: 480,
    height: 480,
  });
  assert.deepEqual(centeredSquareCrop({ width: 900, height: 500 }), {
    left: 200,
    top: 0,
    width: 500,
    height: 500,
  });
});

test("portrait fallback keeps more of the upper composition", () => {
  assert.deepEqual(portraitBiasedSquareCrop({ width: 306, height: 1039 }), {
    left: 0,
    top: 87,
    width: 306,
    height: 306,
  });
  assert.deepEqual(portraitBiasedSquareCrop({ width: 900, height: 500 }), {
    left: 200,
    top: 0,
    width: 500,
    height: 500,
  });
});

test("visual subject coordinates become a padded in-bounds square", () => {
  assert.deepEqual(squareCropAroundNormalizedBox({
    width: 1000,
    height: 1500,
    box: { left: 0.3, top: 0.1, right: 0.7, bottom: 0.4 },
  }), {
    left: 196,
    top: 107,
    width: 608,
    height: 608,
  });
  assert.deepEqual(squareCropAroundNormalizedBox({
    width: 1000,
    height: 1500,
    box: { left: 30, top: 10, right: 70, bottom: 40 },
  }), {
    left: 196,
    top: 107,
    width: 608,
    height: 608,
  });
});
