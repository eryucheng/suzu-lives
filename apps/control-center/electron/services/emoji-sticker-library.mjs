import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const EMOJI_STICKER_LIBRARY_DIRECTORY = "emoji-stickers";
export const EMOJI_STICKER_EXTENSIONS = Object.freeze([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
export const EMOJI_STICKER_DIALOG_FILTER = Object.freeze({
  name: "表情包图片",
  extensions: ["png", "jpg", "jpeg", "webp", "gif"],
});

const ASSETS_DIRECTORY = "assets";
const MANIFEST_FILE = "manifest.json";
const MAX_STICKER_BYTES = 10 * 1024 * 1024;
const STICKER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export class EmojiStickerError extends Error {}

function clean(value) {
  return String(value ?? "").trim();
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizedExtension(value) {
  const extension = path.extname(clean(value)).toLowerCase();
  if (!EMOJI_STICKER_EXTENSIONS.includes(extension)) {
    throw new EmojiStickerError("表情包仅支持 PNG、JPG、WebP 或 GIF 图片。");
  }
  return extension;
}

function mimeTypeFor(extension) {
  return {
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  }[extension] || "image/png";
}

function imageSignatureMatches(buffer, extension) {
  const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  const gif = buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a";
  const webp = buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  return (extension === ".png" && png)
    || ((extension === ".jpg" || extension === ".jpeg") && jpeg)
    || (extension === ".gif" && gif)
    || (extension === ".webp" && webp);
}

function safeFileName(value, fallback) {
  const source = path.basename(clean(value));
  return (source || fallback).slice(0, 180);
}

function safeAssetPath(libraryRoot, relativePath) {
  const relative = clean(relativePath).replaceAll("\\", "/");
  if (!relative || relative.startsWith("/") || relative.split("/").includes("..")) {
    throw new EmojiStickerError("表情包文件路径无效。");
  }
  const root = path.resolve(libraryRoot);
  const target = path.resolve(root, ...relative.split("/"));
  const expectedPrefix = `${ASSETS_DIRECTORY}/`;
  if (!relative.startsWith(expectedPrefix) || !isWithin(root, target)) {
    throw new EmojiStickerError("表情包文件必须保存在收藏目录内。");
  }
  normalizedExtension(target);
  return target;
}

function emptyManifest() {
  return { version: 1, stickers: [] };
}

function normalizeId(value) {
  const id = clean(value).toLowerCase();
  if (!STICKER_ID.test(id)) throw new EmojiStickerError("表情包标识无效。");
  return id;
}

async function fileExists(fsOps, target) {
  try {
    await fsOps.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function inspectEmojiSticker(sourcePath, { fsOps = fs } = {}) {
  const rawSource = clean(sourcePath);
  if (!rawSource) throw new EmojiStickerError("缺少表情包图片。 ");
  const source = path.resolve(rawSource);
  const extension = normalizedExtension(source);
  let stat;
  try {
    stat = await fsOps.stat(source);
  } catch {
    throw new EmojiStickerError("所选表情包文件不存在或无法读取。");
  }
  if (!stat.isFile() || stat.size < 12 || stat.size > MAX_STICKER_BYTES) {
    throw new EmojiStickerError(`表情包必须是 12 B 到 ${MAX_STICKER_BYTES >> 20} MiB 的图片。`);
  }
  const header = (await fsOps.readFile(source)).subarray(0, 16);
  if (!imageSignatureMatches(header, extension)) {
    throw new EmojiStickerError("文件扩展名与表情包图片内容不匹配。");
  }
  return {
    extension,
    fileName: safeFileName(path.basename(source), `表情包${extension}`),
    mimeType: mimeTypeFor(extension),
    size: stat.size,
    source,
  };
}

async function validateManifest(value, libraryRoot, { fsOps = fs, requireFiles = true } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.stickers)) {
    throw new EmojiStickerError("表情包收藏清单格式无效。");
  }
  const seenIds = new Set();
  const seenPaths = new Set();
  const stickers = [];
  for (const raw of value.stickers) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new EmojiStickerError("表情包收藏项无效。");
    const id = normalizeId(raw.id);
    if (seenIds.has(id)) throw new EmojiStickerError("表情包收藏清单存在重复标识。");
    seenIds.add(id);
    const target = safeAssetPath(libraryRoot, raw.path);
    const pathKey = process.platform === "win32" ? target.toLowerCase() : target;
    if (seenPaths.has(pathKey)) throw new EmojiStickerError("同一表情包文件不能重复收藏。");
    seenPaths.add(pathKey);
    const extension = normalizedExtension(target);
    const fileName = safeFileName(raw.fileName, `表情包${extension}`);
    const createdAt = clean(raw.createdAt);
    if (!createdAt || !Number.isFinite(Date.parse(createdAt))) throw new EmojiStickerError("表情包收藏时间无效。");
    let size = Number(raw.size);
    if (!Number.isSafeInteger(size) || size < 12 || size > MAX_STICKER_BYTES) throw new EmojiStickerError("表情包收藏大小无效。");
    if (requireFiles) {
      const inspected = await inspectEmojiSticker(target, { fsOps });
      size = inspected.size;
    }
    stickers.push({
      createdAt,
      fileName,
      id,
      mimeType: mimeTypeFor(extension),
      path: path.relative(path.resolve(libraryRoot), target).split(path.sep).join("/"),
      size,
    });
  }
  return { version: 1, stickers };
}

async function readManifest(libraryRoot, { fsOps = fs } = {}) {
  const manifestPath = path.join(libraryRoot, MANIFEST_FILE);
  if (!(await fileExists(fsOps, manifestPath))) return emptyManifest();
  let value;
  try {
    value = JSON.parse((await fsOps.readFile(manifestPath, "utf8")).replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new EmojiStickerError(`无法读取表情包收藏清单：${error instanceof SyntaxError ? "JSON 格式无效。" : "文件不可读取。"}`);
  }
  return validateManifest(value, libraryRoot, { fsOps });
}

async function writeManifestAtomic(libraryRoot, manifest, { fsOps = fs } = {}) {
  const normalized = await validateManifest(manifest, libraryRoot, { fsOps, requireFiles: false });
  await fsOps.mkdir(libraryRoot, { recursive: true });
  const manifestPath = path.join(libraryRoot, MANIFEST_FILE);
  const temporary = path.join(libraryRoot, `.manifest-${randomUUID()}.tmp`);
  try {
    await fsOps.writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    await fsOps.rename(temporary, manifestPath);
  } finally {
    await fsOps.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function resolveEmojiStickerLibraryRoot(dataRoot) {
  const root = clean(dataRoot);
  if (!root) throw new EmojiStickerError("缺少 Suzu Lives 软件数据目录。");
  return path.join(path.resolve(root), EMOJI_STICKER_LIBRARY_DIRECTORY);
}

export function createEmojiStickerLibrary({ libraryRoot, fsOps = fs } = {}) {
  const rawRoot = clean(libraryRoot);
  if (!rawRoot) throw new EmojiStickerError("缺少表情包收藏目录。");
  const root = path.resolve(rawRoot);

  const snapshot = async () => {
    try {
      const manifest = await readManifest(root, { fsOps });
      return {
        items: manifest.stickers.map((item) => ({ ...item, path: safeAssetPath(root, item.path) })),
        status: manifest.stickers.length ? "ready" : "empty",
      };
    } catch (error) {
      return {
        items: [],
        message: error instanceof Error ? error.message : "无法读取表情包收藏。",
        status: "invalid",
      };
    }
  };

  const asset = async (id) => {
    const manifest = await readManifest(root, { fsOps });
    const stickerId = normalizeId(id);
    const item = manifest.stickers.find((value) => value.id === stickerId);
    if (!item) throw new EmojiStickerError("找不到这张收藏表情包。");
    const target = safeAssetPath(root, item.path);
    const inspected = await inspectEmojiSticker(target, { fsOps });
    return { ...item, mimeType: inspected.mimeType, path: target, size: inspected.size };
  };

  return {
    root,
    inspect: (source) => inspectEmojiSticker(source, { fsOps }),
    snapshot,
    asset,
    async read(id) {
      const item = await asset(id);
      return { ...item, data: await fsOps.readFile(item.path) };
    },
    async add({ source } = {}) {
      const current = await readManifest(root, { fsOps });
      const image = await inspectEmojiSticker(source, { fsOps });
      const id = randomUUID();
      const relative = `${ASSETS_DIRECTORY}/${id}${image.extension}`;
      const target = safeAssetPath(root, relative);
      if (await fileExists(fsOps, target)) throw new EmojiStickerError("表情包保存位置已存在，请重试。");

      await fsOps.mkdir(path.dirname(target), { recursive: true });
      const temporary = path.join(path.dirname(target), `.${id}-${randomUUID()}.tmp`);
      const next = {
        version: 1,
        stickers: [...current.stickers, {
          createdAt: new Date().toISOString(),
          fileName: image.fileName,
          id,
          mimeType: image.mimeType,
          path: relative,
          size: image.size,
        }],
      };
      let copied = false;
      try {
        await fsOps.copyFile(image.source, temporary, fsConstants.COPYFILE_EXCL);
        await fsOps.rename(temporary, target);
        copied = true;
        await writeManifestAtomic(root, next, { fsOps });
      } catch (error) {
        if (copied) await fsOps.rm(target, { force: true }).catch(() => undefined);
        if (error instanceof EmojiStickerError) throw error;
        throw new EmojiStickerError(`无法保存表情包：${error?.message || error}`);
      } finally {
        await fsOps.rm(temporary, { force: true }).catch(() => undefined);
      }
      return snapshot();
    },
  };
}
