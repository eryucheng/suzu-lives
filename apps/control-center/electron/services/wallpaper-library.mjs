import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const WALLPAPER_LIBRARY_RELATIVE_DIRECTORY = Object.freeze(["appearance", "wallpapers"]);
export const WALLPAPER_IMAGE_EXTENSIONS = Object.freeze([".jpg", ".jpeg", ".png", ".webp"]);
export const WALLPAPER_VIDEO_EXTENSIONS = Object.freeze([".mp4", ".webm"]);
export const WALLPAPER_METADATA_FILE = ".suzu-wallpaper.json";

const RECOGNIZED_VIDEO_EXTENSIONS = new Set([...WALLPAPER_VIDEO_EXTENSIONS, ".avi", ".m4v", ".mkv", ".mov", ".wmv"]);
const IMAGE_EXTENSIONS = new Set(WALLPAPER_IMAGE_EXTENSIONS);
const VIDEO_EXTENSIONS = new Set(WALLPAPER_VIDEO_EXTENSIONS);
const MAX_WALLPAPER_NAME_LENGTH = 80;
const MAX_IMPORT_FILES = 50_000;
const MAX_IMPORT_BYTES = 8 * 1024 * 1024 * 1024;
const INVALID_NAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/u;
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const TRANSIENT_DIRECTORY = /^\.(?:importing|renaming)-[a-f0-9-]+$/iu;

export class WallpaperLibraryError extends Error {}

function clean(value) {
  return String(value ?? "").trim();
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSameOrWithin(root, candidate) {
  return samePath(root, candidate) || isWithin(root, candidate);
}

function existingStat(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function readJson(target) {
  try {
    return JSON.parse(fs.readFileSync(target, "utf8").replace(/^\uFEFF/u, ""));
  } catch {
    return null;
  }
}

function wallpaperMetadata(root) {
  const target = path.join(root, WALLPAPER_METADATA_FILE);
  const value = regularFile(target) ? readJson(target) : null;
  return { pinned: value?.pinned === true };
}

async function writeWallpaperMetadata(root, { pinned = false } = {}) {
  const target = path.join(path.resolve(root), WALLPAPER_METADATA_FILE);
  const stat = existingStat(target);
  if (stat?.isSymbolicLink() || (stat && !stat.isFile())) {
    throw new WallpaperLibraryError("壁纸的管理信息文件不可写。");
  }
  if (!pinned) {
    await fs.promises.rm(target, { force: true });
    return;
  }
  const temporary = path.join(path.resolve(root), `.suzu-wallpaper-${randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, pinned: true }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await fs.promises.rename(temporary, target);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function normalizedExtension(target) {
  return path.extname(clean(target)).toLowerCase();
}

function toRelativePath(root, target) {
  return path.relative(path.resolve(root), path.resolve(target)).split(path.sep).join("/");
}

function fileUrl(target) {
  return pathToFileURL(path.resolve(target)).href;
}

function regularFile(target) {
  const stat = existingStat(target);
  return Boolean(stat?.isFile() && !stat.isSymbolicLink());
}

function containedProjectFile(root, value) {
  const relative = clean(value).replaceAll("\\", "/");
  if (!relative || relative.startsWith("/") || /^[a-z]:\//iu.test(relative)) return null;
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  const target = path.resolve(root, ...parts);
  if (!isWithin(root, target) || !regularFile(target)) return null;
  return { relative: toRelativePath(root, target), target };
}

function rootFiles(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
      .map((entry) => ({ extension: normalizedExtension(entry.name), name: entry.name, target: path.join(root, entry.name) }));
  } catch {
    return [];
  }
}

function firstFile(files, predicate) {
  return files.find(predicate) || null;
}

function projectPreview(root, project, files) {
  const configured = containedProjectFile(root, project?.preview);
  if (configured && IMAGE_EXTENSIONS.has(normalizedExtension(configured.target))) return configured.target;
  return firstFile(files, (file) => /^preview\.(?:jpe?g|png|webp)$/iu.test(file.name))?.target || "";
}

function itemResult({ entry = null, folderName, kind, message, preview = "", sourceType, status }) {
  const playable = status === "ready" && entry && ["image", "video"].includes(kind);
  return {
    entryFile: entry?.relative || "",
    folderName,
    kind,
    message,
    name: folderName,
    previewUrl: preview && regularFile(preview) ? fileUrl(preview) : playable && kind === "image" ? fileUrl(entry.target) : "",
    sourceType,
    status,
    url: playable ? fileUrl(entry.target) : "",
  };
}

function projectItem(root, folderName, project, files) {
  const projectType = clean(project?.type).toLowerCase();
  let entry = containedProjectFile(root, project?.file);
  const preview = projectPreview(root, project, files);

  if (projectType === "video") {
    entry ||= firstFile(files, (file) => RECOGNIZED_VIDEO_EXTENSIONS.has(file.extension))
      ? containedProjectFile(root, firstFile(files, (file) => RECOGNIZED_VIDEO_EXTENSIONS.has(file.extension)).name)
      : null;
    if (!entry) return itemResult({ folderName, kind: "video", message: "项目声明的视频入口不存在。", preview, sourceType: "wallpaper-engine", status: "missing" });
    if (!VIDEO_EXTENSIONS.has(normalizedExtension(entry.target))) {
      return itemResult({ entry, folderName, kind: "video", message: "已识别视频项目，当前播放器暂不支持这个视频格式。", preview, sourceType: "wallpaper-engine", status: "unsupported" });
    }
    return itemResult({ entry, folderName, kind: "video", message: "Wallpaper Engine 视频壁纸", preview, sourceType: "wallpaper-engine", status: "ready" });
  }

  if (projectType === "web") {
    entry ||= containedProjectFile(root, "index.html");
    return itemResult({
      entry,
      folderName,
      kind: "web",
      message: entry ? "已识别网页壁纸，网页运行层将在后续版本接入。" : "项目声明的网页入口不存在。",
      preview,
      sourceType: "wallpaper-engine",
      status: entry ? "unsupported" : "missing",
    });
  }

  if (projectType === "scene") {
    entry ||= containedProjectFile(root, "scene.pkg") || containedProjectFile(root, "scene.json");
    return itemResult({
      entry,
      folderName,
      kind: "scene",
      message: entry ? "已识别 Wallpaper Engine 场景壁纸。" : "项目声明的场景入口不存在。",
      preview,
      sourceType: "wallpaper-engine",
      status: entry ? "unsupported" : "missing",
    });
  }

  if (projectType === "application") {
    return itemResult({ entry, folderName, kind: "application", message: "已识别应用壁纸；应用程序不会在 Suzu Lives 中执行。", preview, sourceType: "wallpaper-engine", status: "unsupported" });
  }

  return itemResult({ entry, folderName, kind: "unknown", message: projectType ? `暂未识别项目类型：${projectType}` : "project.json 缺少壁纸类型。", preview, sourceType: "wallpaper-engine", status: "unsupported" });
}

export function inspectWallpaperDirectory(directory, { folderName = path.basename(path.resolve(directory)) } = {}) {
  const root = path.resolve(directory);
  const stat = existingStat(root);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    return itemResult({ folderName, kind: "unknown", message: "壁纸文件夹不存在或无法读取。", sourceType: "folder", status: "missing" });
  }

  const files = rootFiles(root);
  const projectPath = path.join(root, "project.json");
  if (regularFile(projectPath)) {
    const project = readJson(projectPath);
    if (!project || typeof project !== "object" || Array.isArray(project)) {
      return itemResult({ folderName, kind: "unknown", message: "project.json 格式无效。", sourceType: "wallpaper-engine", status: "invalid" });
    }
    return projectItem(root, folderName, project, files);
  }

  const scene = firstFile(files, (file) => file.name.toLowerCase() === "scene.pkg");
  if (scene) {
    return itemResult({ entry: containedProjectFile(root, scene.name), folderName, kind: "scene", message: "已识别 Wallpaper Engine 场景壁纸。", sourceType: "wallpaper-engine", status: "unsupported" });
  }
  const web = firstFile(files, (file) => ["index.html", "index.htm"].includes(file.name.toLowerCase()));
  if (web) {
    return itemResult({ entry: containedProjectFile(root, web.name), folderName, kind: "web", message: "已识别网页壁纸，网页运行层将在后续版本接入。", sourceType: "web", status: "unsupported" });
  }

  const media = files.filter((file) => IMAGE_EXTENSIONS.has(file.extension) || VIDEO_EXTENSIONS.has(file.extension));
  if (media.length === 1) {
    const file = media[0];
    const kind = IMAGE_EXTENSIONS.has(file.extension) ? "image" : "video";
    return itemResult({ entry: containedProjectFile(root, file.name), folderName, kind, message: kind === "image" ? "图片壁纸" : "视频壁纸", sourceType: "media", status: "ready" });
  }

  const recognizedVideo = files.filter((file) => RECOGNIZED_VIDEO_EXTENSIONS.has(file.extension));
  if (media.length === 0 && recognizedVideo.length === 1) {
    const file = recognizedVideo[0];
    return itemResult({ entry: containedProjectFile(root, file.name), folderName, kind: "video", message: "已识别视频文件，当前播放器暂不支持这个视频格式。", sourceType: "media", status: "unsupported" });
  }

  return itemResult({
    folderName,
    kind: "unknown",
    message: media.length > 1 ? "文件夹里有多个媒体文件，无法确定主壁纸。" : "暂未识别这个文件夹里的壁纸入口。",
    sourceType: "folder",
    status: "unsupported",
  });
}

export function normalizeWallpaperName(value) {
  const name = clean(value).normalize("NFC");
  if (!name) throw new WallpaperLibraryError("请填写壁纸名称。");
  if (name.length > MAX_WALLPAPER_NAME_LENGTH) throw new WallpaperLibraryError(`壁纸名称不能超过 ${MAX_WALLPAPER_NAME_LENGTH} 个字符。`);
  if (name === "." || name === ".." || name.endsWith(".") || name.endsWith(" ") || INVALID_NAME_CHARACTERS.test(name)) {
    throw new WallpaperLibraryError("壁纸名称包含 Windows 文件夹不能使用的字符。");
  }
  if (RESERVED_WINDOWS_NAME.test(name)) throw new WallpaperLibraryError("这个名称是 Windows 保留名称，请换一个名称。");
  return name;
}

export function suggestWallpaperName(value, fallback = "新壁纸") {
  let name = clean(value).normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, " ").replace(/\s+/gu, " ").trim();
  name = name.replace(/[. ]+$/gu, "").slice(0, MAX_WALLPAPER_NAME_LENGTH).trim();
  if (!name || name === "." || name === ".." || RESERVED_WINDOWS_NAME.test(name)) name = fallback;
  return normalizeWallpaperName(name);
}

function wallpaperProjectTitle(directory) {
  const project = readJson(path.join(directory, "project.json"));
  return project && typeof project === "object" && !Array.isArray(project) ? clean(project.title) : "";
}

function assertFileSource(source, stat) {
  if (!stat.isFile()) throw new WallpaperLibraryError("请选择图片、视频或一个壁纸文件夹。");
  const extension = normalizedExtension(source);
  if (!IMAGE_EXTENSIONS.has(extension) && !VIDEO_EXTENSIONS.has(extension)) {
    throw new WallpaperLibraryError("单文件壁纸仅支持 JPG、PNG、WebP、MP4 和 WebM。");
  }
}

async function copyRegularFile(source, destination, state) {
  const stat = await fs.promises.lstat(source);
  if (stat.isSymbolicLink() || !stat.isFile()) return;
  state.files += 1;
  state.bytes += stat.size;
  if (state.files > MAX_IMPORT_FILES) throw new WallpaperLibraryError(`壁纸文件数量不能超过 ${MAX_IMPORT_FILES.toLocaleString("zh-CN")} 个。`);
  if (state.bytes > MAX_IMPORT_BYTES) throw new WallpaperLibraryError("壁纸内容不能超过 8 GiB。");
  await fs.promises.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
}

async function copyDirectoryContents(source, destination, state) {
  const entries = await fs.promises.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.toLocaleLowerCase() === WALLPAPER_METADATA_FILE.toLocaleLowerCase()) continue;
    const sourceEntry = path.join(source, entry.name);
    const destinationEntry = path.join(destination, entry.name);
    const stat = await fs.promises.lstat(sourceEntry);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      await fs.promises.mkdir(destinationEntry);
      await copyDirectoryContents(sourceEntry, destinationEntry, state);
    } else if (stat.isFile()) {
      await copyRegularFile(sourceEntry, destinationEntry, state);
    }
  }
}

export function resolveWallpaperLibraryRoot(dataRoot) {
  const root = clean(dataRoot);
  if (!root) throw new WallpaperLibraryError("缺少 Suzu Lives 软件数据目录。");
  return path.join(path.resolve(root), ...WALLPAPER_LIBRARY_RELATIVE_DIRECTORY);
}

export function createWallpaperLibrary({ root } = {}) {
  const libraryRoot = path.resolve(clean(root));
  if (!clean(root)) throw new WallpaperLibraryError("缺少壁纸库目录。");
  let cachedSnapshot = null;
  let cachedStamp = "";

  const libraryStamp = () => {
    const stat = existingStat(libraryRoot);
    return stat?.isDirectory() ? `${stat.mtimeMs}:${stat.ctimeMs}` : "missing";
  };
  const invalidate = () => {
    cachedSnapshot = null;
    cachedStamp = "";
  };

  const directoryNames = () => {
    try {
      return fs.readdirSync(libraryRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !TRANSIENT_DIRECTORY.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  };

  const actualName = (value) => {
    const requested = normalizeWallpaperName(value);
    const requestedKey = requested.toLocaleLowerCase("zh-CN");
    return directoryNames().find((name) => name.toLocaleLowerCase("zh-CN") === requestedKey) || "";
  };

  const managedItem = (folderName) => ({
    ...inspectWallpaperDirectory(path.join(libraryRoot, folderName), { folderName }),
    ...wallpaperMetadata(path.join(libraryRoot, folderName)),
  });

  const renameManagedDirectory = async (source, destination) => {
    if (source === destination) return;
    if (!samePath(source, destination)) {
      await fs.promises.rename(source, destination);
      return;
    }
    const temporary = path.join(libraryRoot, `.renaming-${randomUUID()}`);
    await fs.promises.rename(source, temporary);
    try {
      await fs.promises.rename(temporary, destination);
    } catch (error) {
      await fs.promises.rename(temporary, source).catch(() => undefined);
      throw error;
    }
  };

  const snapshot = () => {
    const stamp = libraryStamp();
    if (cachedSnapshot && cachedStamp === stamp) return cachedSnapshot;
    const items = directoryNames()
      .map(managedItem)
      .sort((left, right) => Number(right.pinned) - Number(left.pinned)
        || left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }));
    cachedStamp = stamp;
    cachedSnapshot = { items, path: libraryRoot, status: items.length ? "ready" : "empty" };
    return cachedSnapshot;
  };

  const availableName = (value) => {
    const base = suggestWallpaperName(value);
    const used = new Set(directoryNames().map((name) => name.toLocaleLowerCase("zh-CN")));
    if (!used.has(base.toLocaleLowerCase("zh-CN"))) return base;
    for (let index = 2; index < 10_000; index += 1) {
      const suffix = ` ${index}`;
      const candidate = `${base.slice(0, MAX_WALLPAPER_NAME_LENGTH - suffix.length).trim()}${suffix}`;
      if (!used.has(candidate.toLocaleLowerCase("zh-CN"))) return candidate;
    }
    throw new WallpaperLibraryError("壁纸库中同名内容过多，请填写另一个名称。");
  };

  const inspectSource = (sourcePath, sourceType = "") => {
    const source = path.resolve(clean(sourcePath));
    const stat = existingStat(source);
    if (!stat || stat.isSymbolicLink()) throw new WallpaperLibraryError("所选壁纸不存在或无法读取。");
    if (sourceType === "file" && !stat.isFile()) throw new WallpaperLibraryError("请选择图片或视频文件。");
    if (sourceType === "directory" && !stat.isDirectory()) throw new WallpaperLibraryError("请选择一个壁纸文件夹。");
    if (stat.isFile()) assertFileSource(source, stat);
    else if (!stat.isDirectory()) throw new WallpaperLibraryError("请选择图片、视频或一个壁纸文件夹。");

    const preferred = stat.isDirectory()
      ? wallpaperProjectTitle(source) || path.basename(source)
      : path.basename(source, path.extname(source));
    const suggestedName = availableName(suggestWallpaperName(preferred));
    const detected = stat.isDirectory()
      ? inspectWallpaperDirectory(source, { folderName: suggestedName })
      : { kind: IMAGE_EXTENSIONS.has(normalizedExtension(source)) ? "image" : "video", status: "ready" };
    return {
      detectedKind: detected.kind,
      detectedStatus: detected.status,
      source,
      sourceLabel: path.basename(source),
      sourceType: stat.isDirectory() ? "directory" : "file",
      suggestedName,
    };
  };

  return {
    availableName,
    inspectSource,
    root: libraryRoot,
    snapshot,
    resolve(value) {
      const folderName = actualName(value);
      return folderName ? managedItem(folderName) : null;
    },
    async importSource({ name, source: sourcePath, sourceType = "" } = {}) {
      const folderName = normalizeWallpaperName(name);
      if (actualName(folderName)) throw new WallpaperLibraryError(`壁纸库中已经有“${folderName}”，请换一个名称。`);
      const sourceInfo = inspectSource(sourcePath, sourceType);
      const source = sourceInfo.source;
      if (isSameOrWithin(libraryRoot, source)) throw new WallpaperLibraryError("这个壁纸已经位于 Suzu Lives 壁纸库中。");
      if (sourceInfo.sourceType === "directory" && isSameOrWithin(source, libraryRoot)) {
        throw new WallpaperLibraryError("请选择一个具体的壁纸文件夹，不能选择包含整个壁纸库的上级目录。");
      }

      await fs.promises.mkdir(libraryRoot, { recursive: true });
      const destination = path.join(libraryRoot, folderName);
      const temporary = path.join(libraryRoot, `.importing-${randomUUID()}`);
      const state = { bytes: 0, files: 0 };
      await fs.promises.mkdir(temporary);
      try {
        if (sourceInfo.sourceType === "file") {
          await copyRegularFile(source, path.join(temporary, path.basename(source)), state);
        } else {
          await copyDirectoryContents(source, temporary, state);
        }
        if (!state.files) throw new WallpaperLibraryError("所选文件夹里没有可复制的普通文件。");
        await fs.promises.rename(temporary, destination);
        invalidate();
      } catch (error) {
        await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        if (error instanceof WallpaperLibraryError) throw error;
        throw new WallpaperLibraryError(`无法导入壁纸：${error?.message || error}`);
      }
      return managedItem(folderName);
    },
    async update(value, patch = {}) {
      const folderName = actualName(value);
      if (!folderName) throw new WallpaperLibraryError("找不到这张壁纸。");
      const currentItem = managedItem(folderName);
      const nextFolderName = normalizeWallpaperName(Object.hasOwn(patch, "name") ? patch.name : folderName);
      const existingName = actualName(nextFolderName);
      if (existingName && existingName.toLocaleLowerCase("zh-CN") !== folderName.toLocaleLowerCase("zh-CN")) {
        throw new WallpaperLibraryError(`壁纸库中已经有“${nextFolderName}”，请换一个名称。`);
      }
      const nextPinned = Object.hasOwn(patch, "pinned") ? patch.pinned === true : currentItem.pinned;
      const source = path.join(libraryRoot, folderName);
      const destination = path.join(libraryRoot, nextFolderName);
      let renamed = false;
      try {
        if (folderName !== nextFolderName) {
          await renameManagedDirectory(source, destination);
          renamed = true;
        }
        if (nextPinned !== currentItem.pinned) await writeWallpaperMetadata(destination, { pinned: nextPinned });
        invalidate();
        return { previousFolderName: folderName, status: "updated", wallpaper: managedItem(nextFolderName) };
      } catch (error) {
        if (renamed) {
          await renameManagedDirectory(destination, source).catch(() => undefined);
          await writeWallpaperMetadata(source, { pinned: currentItem.pinned }).catch(() => undefined);
        }
        invalidate();
        if (error instanceof WallpaperLibraryError) throw error;
        throw new WallpaperLibraryError(`无法更新壁纸：${error?.message || error}`);
      }
    },
    async remove(value) {
      const folderName = actualName(value);
      if (!folderName) throw new WallpaperLibraryError("找不到这张壁纸。");
      const target = path.resolve(libraryRoot, folderName);
      if (!isWithin(libraryRoot, target)) throw new WallpaperLibraryError("壁纸文件夹路径无效。");
      const stat = existingStat(target);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new WallpaperLibraryError("壁纸文件夹不存在或无法删除。");
      try {
        await fs.promises.rm(target, { recursive: true, force: false });
        invalidate();
      } catch (error) {
        throw new WallpaperLibraryError(`无法删除壁纸：${error?.message || error}`);
      }
      return { folderName, status: "removed" };
    },
  };
}
