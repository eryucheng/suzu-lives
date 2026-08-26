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
const WEBP_HEADER = Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBP", "binary");

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

test("favorite sticker library accepts a source over 10 MiB for cropping while keeping stored originals bounded", async () => {
  const root = await temporaryDirectory("suzu-sticker-large-source-");
  const source = path.join(root, "large-source.png");
  const handle = await fs.open(source, "w");
  try {
    await handle.write(PNG_HEADER, 0, PNG_HEADER.length, 0);
    await handle.truncate(11 * 1024 * 1024);
  } finally {
    await handle.close();
  }
  const library = createEmojiStickerLibrary({ libraryRoot: resolveEmojiStickerLibraryRoot(root) });

  const inspected = await library.inspect(source);
  assert.equal(inspected.size, 11 * 1024 * 1024);
  await assert.rejects(() => library.add({ source }), /最终表情包不能超过 10 MiB/u);
});

test("favorite sticker library stores cropped bytes with editable semantic metadata", async () => {
  const root = await temporaryDirectory("suzu-sticker-metadata-");
  const libraryRoot = resolveEmojiStickerLibraryRoot(root);
  const library = createEmojiStickerLibrary({ libraryRoot });

  const added = await library.add({
    data: WEBP_HEADER,
    fileName: "震惊.webp",
    mimeType: "image/webp",
    metadata: {
      keywords: "角色、墨镜、惊讶",
      name: "震惊猫",
    },
  });
  assert.equal(added.items[0].metadata.name, "震惊猫");
  assert.deepEqual(added.items[0].metadata.keywords, ["角色", "墨镜", "惊讶"]);

  const updated = await library.update(added.addedId, {
    ...added.items[0].metadata,
    description: "看到意外消息时使用",
  });
  assert.equal(updated.items[0].metadata.description, "看到意外消息时使用");
  assert.deepEqual(updated.items[0].metadata.keywords, ["角色", "墨镜", "惊讶"]);

  const removed = await library.remove(added.addedId);
  assert.equal(removed.status, "empty");
  assert.equal(removed.items.length, 0);
});

test("favorite sticker library serializes concurrent writes without losing stickers", async () => {
  const root = await temporaryDirectory("suzu-sticker-concurrent-writes-");
  const libraryRoot = resolveEmojiStickerLibraryRoot(root);
  const firstLibrary = createEmojiStickerLibrary({ libraryRoot });
  const secondLibrary = createEmojiStickerLibrary({ libraryRoot });

  await Promise.all([
    firstLibrary.add({ data: PNG_HEADER, fileName: "第一张.png", mimeType: "image/png", metadata: { name: "第一张" } }),
    secondLibrary.add({ data: WEBP_HEADER, fileName: "第二张.webp", mimeType: "image/webp", metadata: { name: "第二张" } }),
  ]);

  const snapshot = await firstLibrary.snapshot();
  assert.equal(snapshot.items.length, 2);
  assert.deepEqual(new Set(snapshot.items.map((item) => item.metadata.name)), new Set(["第一张", "第二张"]));
});

test("favorite sticker library upgrades a version one manifest when metadata is edited", async () => {
  const root = await temporaryDirectory("suzu-sticker-migrate-");
  const libraryRoot = resolveEmojiStickerLibraryRoot(root);
  const id = "11111111-1111-4111-8111-111111111111";
  await fs.mkdir(path.join(libraryRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(libraryRoot, "assets", `${id}.png`), PNG_HEADER);
  await fs.writeFile(path.join(libraryRoot, "manifest.json"), `${JSON.stringify({
    version: 1,
    stickers: [{
      createdAt: "2026-08-25T00:00:00.000Z",
      fileName: "旧表情.png",
      id,
      mimeType: "image/png",
      path: `assets/${id}.png`,
      size: PNG_HEADER.length,
    }],
  }, null, 2)}\n`, "utf8");

  const library = createEmojiStickerLibrary({ libraryRoot });
  const before = await library.snapshot();
  assert.equal(before.items[0].metadata.name, "");
  assert.deepEqual(before.items[0].metadata.keywords, []);

  await library.update(id, { name: "旧表情", keywords: ["迁移"] });
  const manifest = JSON.parse(await fs.readFile(path.join(libraryRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.version, 3);
  assert.equal(manifest.stickers[0].metadata.name, "旧表情");
  assert.deepEqual(manifest.stickers[0].metadata.keywords, ["迁移"]);
});

test("favorite sticker library keeps useful words from an earlier metadata record", async () => {
  const root = await temporaryDirectory("suzu-sticker-legacy-metadata-");
  const libraryRoot = resolveEmojiStickerLibraryRoot(root);
  const id = "22222222-2222-4222-8222-222222222222";
  await fs.mkdir(path.join(libraryRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(libraryRoot, "assets", `${id}.webp`), WEBP_HEADER);
  await fs.writeFile(path.join(libraryRoot, "manifest.json"), `${JSON.stringify({
    version: 2,
    stickers: [{
      createdAt: "2026-08-25T00:00:00.000Z",
      fileName: "旧表情.webp",
      id,
      metadata: {
        description: "戴墨镜的小老鼠，适合得意地回应。",
        tags: {
          action: ["指向"],
          emotion: { primary: "得意", secondary: [] },
          keywords: ["小老鼠", "墨镜"],
        },
      },
      mimeType: "image/webp",
      path: `assets/${id}.webp`,
      size: WEBP_HEADER.length,
    }],
  }, null, 2)}\n`, "utf8");

  const library = createEmojiStickerLibrary({ libraryRoot });
  const snapshot = await library.snapshot();
  assert.equal(snapshot.items[0].metadata.description, "戴墨镜的小老鼠，适合得意地回应。");
  assert.deepEqual(snapshot.items[0].metadata.keywords, ["小老鼠", "墨镜", "得意", "指向"]);
});
