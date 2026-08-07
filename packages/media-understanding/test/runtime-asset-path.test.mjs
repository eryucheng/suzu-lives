import assert from "node:assert/strict";
import test from "node:test";

import { resolveUnpackedRuntimeAssetPath } from "../src/runtime-asset-path.mjs";

test("uses Electron's unpacked adjacent worker when it exists", () => {
  const archived = "C:\\Suzu Lives\\resources\\app.asar\\node_modules\\@suzu-lives\\media-understanding\\worker\\image-vision.py";
  const result = resolveUnpackedRuntimeAssetPath(archived, { exists: () => true });
  assert.equal(result, "C:\\Suzu Lives\\resources\\app.asar.unpacked\\node_modules\\@suzu-lives\\media-understanding\\worker\\image-vision.py");
});

test("keeps source and missing-unpacked paths unchanged", () => {
  const source = "D:\\workspace\\packages\\media-understanding\\worker\\image-vision.py";
  assert.equal(resolveUnpackedRuntimeAssetPath(source, { exists: () => true }), source);
  const archived = "C:\\Suzu Lives\\resources\\app.asar\\worker.py";
  assert.equal(resolveUnpackedRuntimeAssetPath(archived, { exists: () => false }), archived);
});
