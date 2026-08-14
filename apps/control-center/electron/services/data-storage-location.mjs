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
  return !TRANSIENT_PROFILE_ENTRIES.has(path.basename(sourcePath));
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
