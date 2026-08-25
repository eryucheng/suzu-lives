import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WallpaperLibraryError,
  WALLPAPER_METADATA_FILE,
  createWallpaperLibrary,
  inspectWallpaperDirectory,
  normalizeWallpaperName,
  resolveWallpaperLibraryRoot,
  suggestWallpaperName,
} from "../electron/services/wallpaper-library.mjs";

function temporaryRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), label));
}

test("wallpaper names map directly to safe managed folder names", () => {
  assert.equal(normalizeWallpaperName("深海少女"), "深海少女");
  assert.equal(suggestWallpaperName("  深海:少女?  "), "深海 少女");
  assert.throws(() => normalizeWallpaperName("CON"), WallpaperLibraryError);
  assert.throws(() => normalizeWallpaperName("夜景/循环"), WallpaperLibraryError);
  assert.throws(() => normalizeWallpaperName(""), WallpaperLibraryError);
  assert.equal(resolveWallpaperLibraryRoot("D:/Suzu data"), path.resolve("D:/Suzu data", "appearance", "wallpapers"));
});

test("single image and video imports become named wallpaper folders", async () => {
  const root = temporaryRoot("suzu-wallpaper-library-media-");
  const sourceRoot = temporaryRoot("suzu-wallpaper-library-source-");
  const image = path.join(sourceRoot, "chosen image.PNG");
  const video = path.join(sourceRoot, "loop.webm");
  fs.writeFileSync(image, "image-fixture");
  fs.writeFileSync(video, "video-fixture");
  const library = createWallpaperLibrary({ root: path.join(root, "appearance", "wallpapers") });

  try {
    const importedImage = await library.importSource({ name: "红色少女", source: image, sourceType: "file" });
    const importedVideo = await library.importSource({ name: "星空循环", source: video, sourceType: "file" });

    assert.equal(importedImage.kind, "image");
    assert.equal(importedImage.status, "ready");
    assert.equal(importedVideo.kind, "video");
    assert.equal(importedVideo.status, "ready");
    assert.equal(fs.readFileSync(path.join(library.root, "红色少女", "chosen image.PNG"), "utf8"), "image-fixture");
    assert.equal(fs.readFileSync(path.join(library.root, "星空循环", "loop.webm"), "utf8"), "video-fixture");
    assert.deepEqual(library.snapshot().items.map((item) => item.name), ["红色少女", "星空循环"]);
    await assert.rejects(() => library.importSource({ name: "红色少女", source: image }), /已经有/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test("Wallpaper Engine folders keep their internal tree and use the chosen outer name", async () => {
  const root = temporaryRoot("suzu-wallpaper-library-project-");
  const sourceRoot = temporaryRoot("suzu-wallpaper-project-source-");
  const workshopFolder = path.join(sourceRoot, "3298471920");
  fs.mkdirSync(path.join(workshopFolder, "assets", "video"), { recursive: true });
  fs.writeFileSync(path.join(workshopFolder, "project.json"), JSON.stringify({
    file: "assets/video/main.mp4",
    preview: "preview.jpg",
    title: "蓝色:星空?",
    type: "video",
  }));
  fs.writeFileSync(path.join(workshopFolder, "preview.jpg"), "preview");
  fs.writeFileSync(path.join(workshopFolder, "assets", "video", "main.mp4"), "video");
  const library = createWallpaperLibrary({ root: path.join(root, "appearance", "wallpapers") });

  try {
    const source = library.inspectSource(workshopFolder, "directory");
    assert.equal(source.suggestedName, "蓝色 星空");
    assert.equal(source.detectedKind, "video");

    const item = await library.importSource({ name: "我的星空", source: workshopFolder, sourceType: "directory" });
    assert.equal(item.sourceType, "wallpaper-engine");
    assert.equal(item.entryFile, "assets/video/main.mp4");
    assert.equal(item.status, "ready");
    assert.equal(fs.readFileSync(path.join(library.root, "我的星空", "assets", "video", "main.mp4"), "utf8"), "video");
    assert.equal(fs.existsSync(path.join(library.root, "3298471920")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test("folder inspection distinguishes web, scene and ambiguous media projects", () => {
  const root = temporaryRoot("suzu-wallpaper-library-types-");
  const web = path.join(root, "网页");
  const scene = path.join(root, "场景");
  const ambiguous = path.join(root, "多个媒体");
  fs.mkdirSync(web);
  fs.mkdirSync(scene);
  fs.mkdirSync(ambiguous);
  fs.writeFileSync(path.join(web, "index.html"), "<main></main>");
  fs.writeFileSync(path.join(scene, "scene.pkg"), "scene");
  fs.writeFileSync(path.join(ambiguous, "one.jpg"), "one");
  fs.writeFileSync(path.join(ambiguous, "two.mp4"), "two");

  try {
    assert.deepEqual(
      [inspectWallpaperDirectory(web).kind, inspectWallpaperDirectory(web).status],
      ["web", "unsupported"],
    );
    assert.deepEqual(
      [inspectWallpaperDirectory(scene).kind, inspectWallpaperDirectory(scene).status],
      ["scene", "unsupported"],
    );
    const ambiguousItem = inspectWallpaperDirectory(ambiguous);
    assert.equal(ambiguousItem.kind, "unknown");
    assert.match(ambiguousItem.message, /多个媒体文件/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wallpapers can be renamed and pinned ahead of the alphabetical list", async () => {
  const root = temporaryRoot("suzu-wallpaper-library-update-");
  const sourceRoot = temporaryRoot("suzu-wallpaper-library-update-source-");
  const image = path.join(sourceRoot, "wallpaper.jpg");
  fs.writeFileSync(image, "image");
  const library = createWallpaperLibrary({ root: path.join(root, "appearance", "wallpapers") });

  try {
    await library.importSource({ name: "Alpha", source: image });
    await library.importSource({ name: "Bravo", source: image });
    await library.importSource({ name: "Charlie", source: image });

    const updated = await library.update("Bravo", { name: "Zulu", pinned: true });
    assert.equal(updated.status, "updated");
    assert.equal(updated.previousFolderName, "Bravo");
    assert.equal(updated.wallpaper.folderName, "Zulu");
    assert.equal(updated.wallpaper.pinned, true);
    assert.equal(fs.existsSync(path.join(library.root, "Bravo")), false);
    assert.equal(fs.readFileSync(path.join(library.root, "Zulu", "wallpaper.jpg"), "utf8"), "image");
    assert.equal(JSON.parse(fs.readFileSync(path.join(library.root, "Zulu", WALLPAPER_METADATA_FILE), "utf8")).pinned, true);
    assert.deepEqual(library.snapshot().items.map((item) => item.name), ["Zulu", "Alpha", "Charlie"]);

    const reloaded = createWallpaperLibrary({ root: library.root });
    assert.equal(reloaded.resolve("Zulu").pinned, true);
    await assert.rejects(() => reloaded.update("Zulu", { name: "Alpha", pinned: true }), /已经有/u);
    await reloaded.update("Zulu", { name: "Zulu", pinned: false });
    assert.equal(fs.existsSync(path.join(library.root, "Zulu", WALLPAPER_METADATA_FILE)), false);
    assert.deepEqual(reloaded.snapshot().items.map((item) => item.name), ["Alpha", "Charlie", "Zulu"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test("removing a wallpaper only deletes its managed named folder", async () => {
  const root = temporaryRoot("suzu-wallpaper-library-remove-");
  const sourceRoot = temporaryRoot("suzu-wallpaper-library-remove-source-");
  const image = path.join(sourceRoot, "wallpaper.jpg");
  fs.writeFileSync(image, "image");
  const library = createWallpaperLibrary({ root: path.join(root, "appearance", "wallpapers") });

  try {
    await library.importSource({ name: "待删除", source: image });
    await library.remove("待删除");
    assert.equal(fs.existsSync(path.join(library.root, "待删除")), false);
    assert.equal(fs.existsSync(image), true);
    await assert.rejects(() => library.remove("../outside"), WallpaperLibraryError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});
