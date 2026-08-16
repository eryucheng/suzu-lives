import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createEmojiStickerLibrary,
  EmojiStickerError,
  inspectEmojiSticker,
  resolveEmojiStickerLibraryRoot,
} from "../electron/services/emoji-sticker-library.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

test("favorite sticker library keeps validated originals in Suzu data", async () => {
  const root = await temporaryDirectory("suzu-sticker-library-");
  const source = path.join(root, "开心.png");
  await fs.writeFile(source, PNG_HEADER);
  const library = createEmojiStickerLibrary({ libraryRoot: resolveEmojiStickerLibraryRoot(root) });

  const inspected = await library.inspect(source);
  assert.deepEqual({ fileName: inspected.fileName, mimeType: inspected.mimeType, size: inspected.size }, {
    fileName: "开心.png",
    mimeType: "image/png",
    size: PNG_HEADER.length,
  });

  const added = await library.add({ source });
  assert.equal(added.status, "ready");
  assert.equal(added.items.length, 1);
  assert.equal(added.items[0].fileName, "开心.png");
  assert.match(added.items[0].path, /emoji-stickers[\\/]assets[\\/][0-9a-f-]+\.png$/u);
  assert.notEqual(path.resolve(added.items[0].path), source);

  const restored = await library.read(added.items[0].id);
  assert.deepEqual(restored.data, PNG_HEADER);
  assert.equal(restored.mimeType, "image/png");
});

test("favorite sticker library rejects a mismatched image extension", async () => {
  const root = await temporaryDirectory("suzu-sticker-invalid-");
  const source = path.join(root, "not-a-gif.gif");
  await fs.writeFile(source, PNG_HEADER);
  await assert.rejects(() => inspectEmojiSticker(source), EmojiStickerError);
});
