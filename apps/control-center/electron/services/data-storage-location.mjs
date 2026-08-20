import fs from "node:fs";
import path from "node:path";

import {
  readSuzuLivesDataRootLocator,
  readSuzuLivesDataRootRedirect,
  resolveSuzuLivesDataRoot,
  suzuLivesDataRootLocatorPath,
  writeSuzuLivesDataRootLocator,
  writeSuzuLivesDataRootRedirect,
} from "@suzu-lives/agent-registry";
import { MANAGED_CONTACTS_DIRECTORY } from "./contact-projects.mjs";
import { relocateAgentWorkspaceStorageSync } from "./agent-session-storage.mjs";

const DATA_ROOT_FOLDER_NAME = "Suzu Lives";
const TRANSIENT_PROFILE_ENTRIES = new Set(["SingletonCookie", "SingletonLock", "SingletonSocket"]);

function clean(value) {
  return String(value ?? "").trim();
}

function absolutePath(value) {
  const candidate = clean(value);
  if (!candidate || !path.isAbsolute(candidate)) return "";
  return path.resolve(candidate);
}

function comparablePath(value) {
  const resolved = absolutePath(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathsMatch(left, right) {
  return Boolean(comparablePath(left) && comparablePath(left) === comparablePath(right));
}

function isInside(parent, candidate) {
  const base = absolutePath(parent);
  const target = absolutePath(candidate);
  if (!base || !target || pathsMatch(base, target)) return false;
  const relative = path.relative(base, target);
  return Boolean(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isDirectory(directory) {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function now() {
  return new Date().toISOString();
}

function migrationError(message) {
  const error = new Error(message);
  error.code = "data-root-migration";
  return error;
}

export function dataRootForSelectedDirectory(directory) {
  const selected = absolutePath(directory);
  if (!selected || !isDirectory(selected)) throw migrationError("请选择一个可用的文件夹。");
  return path.basename(selected).toLowerCase() === DATA_ROOT_FOLDER_NAME.toLowerCase()
    ? selected
    : path.join(selected, DATA_ROOT_FOLDER_NAME);
}

export function validateDataRootMigration({ sourceRoot, targetRoot } = {}) {
  const source = absolutePath(sourceRoot);
  const target = absolutePath(targetRoot);
  if (!source || !target) throw migrationError("数据位置必须是绝对路径。");
  if (!isDirectory(source)) throw migrationError("当前数据位置不存在，无法迁移。");
  if (pathsMatch(source, target)) return { status: "unchanged", sourceRoot: source, targetRoot: target };
  if (path.basename(target).toLowerCase() !== DATA_ROOT_FOLDER_NAME.toLowerCase()) {
    throw migrationError(`新位置会自动使用名为“${DATA_ROOT_FOLDER_NAME}”的文件夹。`);
  }
  if (isInside(source, target) || isInside(target, source)) {
    throw migrationError("新位置不能位于当前数据目录内，也不能包含当前数据目录。");
  }
  if (fs.existsSync(target)) {
    throw migrationError("新位置中已经有同名的 Suzu Lives 数据文件夹，请选择其他位置。");
  }
  return { status: "ready", sourceRoot: source, targetRoot: target };
}

function shouldCopy(sourcePath) {
  const base = path.basename(sourcePath);
  if (TRANSIENT_PROFILE_ENTRIES.has(base)) return false;
  // Windows 上创建符号链接需要开发者模式或管理员权限；跳过符号链接，
  // 避免迁移因为一个 EPERM 中断导致整个数据位置切换失败。
  try {
    return !fs.lstatSync(sourcePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function copyDataRoot(sourceRoot, targetRoot) {
  fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
  fs.cpSync(sourceRoot, targetRoot, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: shouldCopy,
  });
  if (!isDirectory(targetRoot)) throw migrationError("数据复制未完成，未切换到新位置。");
  relocateManagedContactWorkspaces({ sourceRoot, targetRoot });
}

function rebaseContainedPath({ sourceRoot, targetRoot, value }) {
  const source = absolutePath(sourceRoot);
  const target = absolutePath(targetRoot);
  const candidate = absolutePath(value);
  if (!source || !target || !candidate) return "";
  if (pathsMatch(source, candidate)) return target;
  if (!isInside(source, candidate)) return "";
  return path.join(target, path.relative(source, candidate));
}

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
  } catch {
    return fallback;
  }
}

function writeJsonFileAtomic(filePath, value) {
  const temporary = `${filePath}.suzu-data-root-migration-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* Best effort only. */ }
    throw migrationError(`无法更新迁移后的联系人目录引用：${error?.message || String(error)}`);
  }
}

function rebaseProjectRootFields(value, { sourceRoot, targetRoot }) {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const rewritten = rebaseProjectRootFields(entry, { sourceRoot, targetRoot });
      changed ||= rewritten.changed;
      return rewritten.value;
    });
    return { changed, value: changed ? next : value };
  }
  if (!value || typeof value !== "object") return { changed: false, value };
  let changed = false;
  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "projectRoot" && typeof entry === "string") {
      const rebased = rebaseContainedPath({ sourceRoot, targetRoot, value: entry });
      next[key] = rebased || entry;
      changed ||= Boolean(rebased && !pathsMatch(rebased, entry));
      continue;
    }
    const rewritten = rebaseProjectRootFields(entry, { sourceRoot, targetRoot });
    next[key] = rewritten.value;
    changed ||= rewritten.changed;
  }
  return { changed, value: changed ? next : value };
}

function rewriteScheduleProjectRoots({ targetRoot, sourceContactsRoot, targetContactsRoot }) {
  for (const relativeDirectory of [
    path.join("automation", "schedule", "tasks"),
    path.join("automation", "schedule", "history"),
  ]) {
    const directory = path.join(targetRoot, relativeDirectory);
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw migrationError(`无法读取自动任务目录：${error?.message || String(error)}`);
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(directory, entry.name);
      const document = readJsonFile(filePath);
      if (!document || typeof document !== "object" || Array.isArray(document)) continue;
      const rewritten = rebaseProjectRootFields(document, {
        sourceRoot: sourceContactsRoot,
        targetRoot: targetContactsRoot,
      });
      if (rewritten.changed) writeJsonFileAtomic(filePath, rewritten.value);
    }
  }
}

/**
 * The managed default contact root moves together with the application data
 * root. Agent Core treats an absolute cwd as session identity, so after copying we
 * also rebind its session headers, storage directories, and workspace index
 * before the new root becomes active.
 */
function relocateManagedContactWorkspaces({ sourceRoot, targetRoot }) {
  const sourceContactsRoot = path.join(sourceRoot, MANAGED_CONTACTS_DIRECTORY);
  const targetContactsRoot = path.join(targetRoot, MANAGED_CONTACTS_DIRECTORY);
  const settingsPath = path.join(targetRoot, "settings.json");
  const settings = readJsonFile(settingsPath, {});
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return;
  const configuredContactsRoot = absolutePath(settings.contactsRoot);
  // An absent root is the new product default. An arbitrary external root is
  // deliberately left alone: that user chose to keep workspaces outside the
  // software data folder, so copying app data must not claim them.
  if (configuredContactsRoot && !pathsMatch(configuredContactsRoot, sourceContactsRoot)) return;

  try {
    fs.mkdirSync(targetContactsRoot, { recursive: true });
  } catch (error) {
    throw migrationError(`无法创建迁移后的默认联系人目录：${error?.message || String(error)}`);
  }
  let entries;
  try {
    entries = fs.readdirSync(targetContactsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") entries = [];
    else throw migrationError(`无法读取迁移后的联系人目录：${error?.message || String(error)}`);
  }
  const runtimeHome = path.join(targetRoot, "agent-runtime", "core");
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const targetProjectRoot = path.join(targetContactsRoot, entry.name);
    try {
      const stat = fs.lstatSync(targetProjectRoot);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    } catch {
      continue;
    }
    relocateAgentWorkspaceStorageSync({
      runtimeHome,
      sourceProjectRoot: path.join(sourceContactsRoot, entry.name),
      targetProjectRoot,
    });
  }

  const rebasedProjectRoot = rebaseContainedPath({
    sourceRoot: sourceContactsRoot,
    targetRoot: targetContactsRoot,
    value: settings.projectRoot,
  });
  const nextSettings = {
    ...settings,
    contactsRoot: targetContactsRoot,
    ...(rebasedProjectRoot ? { projectRoot: rebasedProjectRoot } : {}),
  };
  const settingsChanged = !pathsMatch(configuredContactsRoot || sourceContactsRoot, targetContactsRoot)
    || Boolean(rebasedProjectRoot && !pathsMatch(settings.projectRoot, rebasedProjectRoot));
  rewriteScheduleProjectRoots({ targetRoot, sourceContactsRoot, targetContactsRoot });
  if (settingsChanged) writeJsonFileAtomic(settingsPath, nextSettings);
}

function migrationSnapshot(locator, dataRoot, startupMigration) {
  const previousDataRoot = locator.previousDataRoot && !pathsMatch(locator.previousDataRoot, dataRoot)
    ? locator.previousDataRoot
    : "";
  return {
    dataRoot,
    previousDataRoot,
    migration: startupMigration,
    failedMigration: locator.failedMigration || null,
  };
}

function completePendingMigration({ locatorPath, locator }) {
  const pending = locator.pendingMigration;
  if (!pending) return { locator, dataRoot: locator.dataRoot, migration: { status: "idle" } };
  const sourceRoot = pending.sourceRoot || locator.dataRoot;
  const targetRoot = pending.targetRoot;
  try {
    const validation = validateDataRootMigration({ sourceRoot, targetRoot });
    if (validation.status === "ready") copyDataRoot(validation.sourceRoot, validation.targetRoot);
    if (validation.status === "ready") writeSuzuLivesDataRootRedirect({ dataRoot: validation.sourceRoot, targetRoot: validation.targetRoot });
    const updated = writeSuzuLivesDataRootLocator({
      locatorPath,
      dataRoot: validation.targetRoot,
      previousDataRoot: validation.status === "ready" ? validation.sourceRoot : locator.previousDataRoot,
    });
    return {
      locator: updated,
      dataRoot: validation.targetRoot,
      migration: {
        status: validation.status === "ready" ? "completed" : "unchanged",
        sourceRoot: validation.sourceRoot,
        targetRoot: validation.targetRoot,
      },
    };
  } catch (error) {
    const failedMigration = {
      sourceRoot,
      targetRoot,
      createdAt: pending.createdAt || now(),
      message: error?.message || String(error),
    };
    const updated = writeSuzuLivesDataRootLocator({
      locatorPath,
      dataRoot: locator.dataRoot || sourceRoot,
      previousDataRoot: locator.previousDataRoot,
      failedMigration,
    });
    return {
      locator: updated,
      dataRoot: updated.dataRoot || sourceRoot,
      migration: { status: "failed", ...failedMigration },
    };
  }
}

export function createDataStorageLocationService({
  appData = process.env.APPDATA,
  localAppData = process.env.LOCALAPPDATA,
  legacyUserDataPath = "",
  configuredRoot = process.env.SUZU_LIVES_DATA_ROOT,
  locatorPath = "",
} = {}) {
  const explicitRoot = clean(configuredRoot);
  const resolvedLocatorPath = absolutePath(locatorPath) || suzuLivesDataRootLocatorPath({
    appData,
    fallbackBase: legacyUserDataPath,
  });
  let locator = readSuzuLivesDataRootLocator({
    appData,
    fallbackBase: legacyUserDataPath,
    locatorPath: resolvedLocatorPath,
  });
  let dataRoot = resolveSuzuLivesDataRoot({
    configuredRoot: explicitRoot,
    localAppData,
    fallbackBase: legacyUserDataPath,
    appData,
    locatorPath: resolvedLocatorPath,
  });
  let startupMigration = { status: "idle" };

  if (!explicitRoot && locator.pendingMigration) {
    const completed = completePendingMigration({ locatorPath: resolvedLocatorPath, locator });
    locator = completed.locator;
    dataRoot = completed.dataRoot;
    startupMigration = completed.migration;
  }

  fs.mkdirSync(dataRoot, { recursive: true });
  const snapshot = () => migrationSnapshot(locator, dataRoot, startupMigration);

  const scheduleMigration = (targetRoot) => {
    if (explicitRoot) throw migrationError("本次运行使用了 SUZU_LIVES_DATA_ROOT，不能从软件内更换数据位置。");
    const validation = validateDataRootMigration({ sourceRoot: dataRoot, targetRoot });
    if (validation.status === "unchanged") return validation;
    locator = writeSuzuLivesDataRootLocator({
      locatorPath: resolvedLocatorPath,
      dataRoot,
      previousDataRoot: locator.previousDataRoot,
      pendingMigration: {
        sourceRoot: validation.sourceRoot,
        targetRoot: validation.targetRoot,
        createdAt: now(),
      },
    });
    startupMigration = { status: "scheduled", sourceRoot: validation.sourceRoot, targetRoot: validation.targetRoot };
    return startupMigration;
  };

  const removePreviousDataCopy = () => {
    const previousDataRoot = locator.previousDataRoot;
    if (!previousDataRoot) return { status: "none" };
    if (path.basename(previousDataRoot).toLowerCase() !== DATA_ROOT_FOLDER_NAME.toLowerCase()) {
      throw migrationError("旧副本路径不符合 Suzu Lives 数据目录规则，已拒绝删除。");
    }
    if (isInside(previousDataRoot, dataRoot) || isInside(dataRoot, previousDataRoot) || pathsMatch(previousDataRoot, dataRoot)) {
      throw migrationError("旧副本路径与当前数据位置冲突，已拒绝删除。");
    }
    if (!isDirectory(previousDataRoot)) {
      locator = writeSuzuLivesDataRootLocator({ locatorPath: resolvedLocatorPath, dataRoot });
      return { status: "missing" };
    }
    if (!pathsMatch(readSuzuLivesDataRootRedirect(previousDataRoot), dataRoot)) {
      throw migrationError("旧副本没有指向当前数据位置，已拒绝删除。");
    }
    fs.rmSync(previousDataRoot, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
    locator = writeSuzuLivesDataRootLocator({ locatorPath: resolvedLocatorPath, dataRoot });
    return { status: "removed", previousDataRoot };
  };

  return {
    dataRoot,
    snapshot,
    targetFromSelection: dataRootForSelectedDirectory,
    validateMigration: (targetRoot) => validateDataRootMigration({ sourceRoot: dataRoot, targetRoot }),
    scheduleMigration,
    removePreviousDataCopy,
  };
}
