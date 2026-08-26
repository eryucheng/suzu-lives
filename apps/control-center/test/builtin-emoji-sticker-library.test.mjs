import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BUILTIN_EMOJI_STICKERS,
  createBuiltinEmojiStickerLibrary,
} from "../electron/services/builtin-emoji-sticker-library.mjs";

const ASSETS_ROOT = fileURLToPath(new URL("../resources/stickers/builtin/suzu", import.meta.url));
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test("the packaged Suzu sticker category exposes six stable, readable PNG assets", async () => {
  const library = createBuiltinEmojiStickerLibrary({ assetsRoot: ASSETS_ROOT });
  const snapshot = await library.snapshot();

  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.categories[0].name, "Suzu 内置表情");
  assert.equal(snapshot.items.length, 6);
  assert.equal(new Set(snapshot.items.map((item) => item.id)).size, 6);
  assert.deepEqual(snapshot.items.map((item) => item.id), BUILTIN_EMOJI_STICKERS.map((item) => item.id));

  for (const item of snapshot.items) {
    assert.equal(item.builtIn, true);
    assert.equal(item.category, "builtin");
    assert.equal(item.categoryName, "Suzu 内置表情");
    assert.ok(item.metadata.name);
    assert.ok(item.metadata.description);
    assert.ok(item.metadata.keywords.length >= 6);
    assert.equal((await fs.readFile(item.path)).subarray(0, 8).equals(PNG_SIGNATURE), true);
  }
});

test("desktop packaging includes the dedicated built-in sticker resources", async () => {
  const packageJson = JSON.parse(await fs.readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  assert.equal(packageJson.build.files.includes("resources/**/*"), true);
});
