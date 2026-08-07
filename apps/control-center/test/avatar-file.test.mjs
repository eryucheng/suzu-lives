import assert from "node:assert/strict";
import test from "node:test";

import {
  avatarCropLayout,
  avatarCropSourceRect,
  createSquareAvatarCrop,
  moveAvatarCrop,
  readAvatarFile,
  setAvatarCropZoom,
} from "../src/core/avatar-file.mjs";

class FileReaderStub {
  constructor() {
    this.listeners = new Map();
    this.result = "";
  }

  addEventListener(event, listener) {
    this.listeners.set(event, listener);
  }

  readAsDataURL(file) {
    this.result = `data:${file.type};base64,avatar`;
    this.listeners.get("load")?.();
  }
}

test("avatar files accept any size while keeping the shared image format validation", async () => {
  await assert.rejects(
    readAvatarFile({ type: "image/gif", size: 1 }, { FileReaderCtor: FileReaderStub }),
    /PNG、JPEG 或 WebP/u,
  );
  assert.equal(
    await readAvatarFile({ type: "image/webp", size: 1 }, { FileReaderCtor: FileReaderStub }),
    "data:image/webp;base64,avatar",
  );
  assert.equal(
    await readAvatarFile({ type: "image/png", size: 20 * 1024 * 1024 }, { FileReaderCtor: FileReaderStub }),
    "data:image/png;base64,avatar",
  );
});

function closeTo(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 0.0001, `${actual} should be close to ${expected}`);
}

test("square avatar cropping covers the frame and keeps a rectangular image within it", () => {
  const crop = createSquareAvatarCrop({ source: "data:image/png;base64,avatar", imageWidth: 1600, imageHeight: 900, viewportWidth: 320 });
  const layout = avatarCropLayout(crop);
  closeTo(layout.displayWidth, 568.8888888889);
  closeTo(layout.displayHeight, 320);
  closeTo(layout.offsetX, -124.4444444444);
  assert.equal(layout.offsetY, 0);

  const source = avatarCropSourceRect(crop);
  closeTo(source.x, 350);
  closeTo(source.y, 0);
  closeTo(source.width, 900);
  closeTo(source.height, 900);
});

test("avatar crop dragging and zooming stay inside the fixed square selection frame", () => {
  const crop = createSquareAvatarCrop({ imageWidth: 900, imageHeight: 1600, viewportWidth: 320 });
  const farUp = moveAvatarCrop(crop, 9999, 9999);
  assert.equal(farUp.offsetX, 0);
  assert.equal(farUp.offsetY, 0);

  const farDown = moveAvatarCrop(crop, -9999, -9999);
  const downLayout = avatarCropLayout(farDown);
  closeTo(farDown.offsetX, downLayout.minimumX);
  closeTo(farDown.offsetY, downLayout.minimumY);

  const zoomed = setAvatarCropZoom(crop, 2);
  assert.equal(zoomed.zoom, 2);
  const zoomedLayout = avatarCropLayout(zoomed);
  assert.ok(zoomedLayout.displayWidth >= zoomedLayout.viewportWidth);
  assert.ok(zoomedLayout.displayHeight >= zoomedLayout.viewportHeight);
});
