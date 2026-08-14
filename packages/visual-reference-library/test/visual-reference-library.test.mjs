import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createVisualReferenceLibrary, safeAssetPath, VisualReferenceError } from "../src/index.mjs";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
async function fixture(prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const source = path.join(directory, "source.png");
  await fs.writeFile(source, png);
  return { directory, source };
}

test("copies a selected image with an atomic manifest and never silently overwrites", async () => {
  const { directory, source } = await fixture("suzu-visual-");
  const library = createVisualReferenceLibrary({ libraryRoot: path.join(directory, "library") });
  await library.upsertSet({ id: "character-main", description: "主角" });
  const added = await library.add({ source, id: "character.main.face-front", role: "identity", description: "正面", preserve: ["脸部"], ignore: ["背景"], sets: ["character-main"] });
  assert.equal(added.assets.length, 1);
  assert.deepEqual(added.assets[0].sets, ["character-main"]);
  const copied = await library.assetPath("character.main.face-front");
  assert.notEqual(copied, source);
  assert.deepEqual(await fs.readFile(copied), png);
  await assert.rejects(() => library.add({ source, id: "character.main.face-front", role: "identity", description: "重复" }), VisualReferenceError);
  assert.equal((await fs.readdir(path.dirname(library.manifestPath()))).some((name) => name.endsWith(".tmp")), false);
});

test("requires an explicit file-deletion choice and keeps files when only removing the library entry", async () => {
  const { directory, source } = await fixture("suzu-visual-remove-");
  const library = createVisualReferenceLibrary({ libraryRoot: path.join(directory, "library") });
  await library.add({ source, id: "object.main", role: "object", description: "物品" });
  const copied = await library.assetPath("object.main");
  await assert.rejects(() => library.remove({ id: "object.main" }), VisualReferenceError);
  await library.remove({ id: "object.main", deleteFile: false });
  assert.equal(await fs.stat(copied).then((value) => value.isFile()), true);
  assert.equal((await library.snapshot()).assets.length, 0);
  assert.throws(() => safeAssetPath(path.join(directory, "library"), "../outside.png"), VisualReferenceError);
});
