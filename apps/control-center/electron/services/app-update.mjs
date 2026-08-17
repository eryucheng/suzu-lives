import fs from "node:fs";
import path from "node:path";

export const APP_UPDATE_INITIAL_CHECK_DELAY_MS = 10_000;
export const APP_UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1_000;

function clean(value) {
  return String(value ?? "").trim();
}

function versionLabel(value) {
  const version = clean(value);
  return version ? `v${version}` : "当前版本";
}

function updaterErrorMessage(error) {
  const source = clean(error?.message || error);
  if (/\b404\b|not found|latest\.yml/iu.test(source)) return "还没有发布可用的正式更新。";
  return "暂时无法连接更新服务，请稍后再试。";
}

function updateInfo(value) {
  const version = clean(value?.version);
  return version ? { version } : null;
}

export function scheduleAppUpdateChecks({
  checkForUpdates,
  clearIntervalFn = globalThis.clearInterval,
  clearTimeoutFn = globalThis.clearTimeout,
  initialDelayMs = APP_UPDATE_INITIAL_CHECK_DELAY_MS,
  intervalMs = APP_UPDATE_CHECK_INTERVAL_MS,
  setIntervalFn = globalThis.setInterval,
  setTimeoutFn = globalThis.setTimeout,
} = {}) {
  if (typeof checkForUpdates !== "function") return () => {};

  let disposed = false;
  let intervalHandle = null;
  const runCheck = () => {
    if (disposed) return;
    try {
      const operation = checkForUpdates();
      if (operation && typeof operation.catch === "function") void operation.catch(() => undefined);
    } catch {
      // Background checks are intentionally silent.  Manual checks still
      // surface their result in Settings.
    }
  };
  const timeoutHandle = setTimeoutFn(() => {
    if (disposed) return;
    runCheck();
    intervalHandle = setIntervalFn(runCheck, intervalMs);
  }, initialDelayMs);

  return () => {
    if (disposed) return;
    disposed = true;
    clearTimeoutFn(timeoutHandle);
    if (intervalHandle !== null) clearIntervalFn(intervalHandle);
  };
}

export function createAppUpdateService({
  app,
  autoUpdater = null,
  fsOps = fs,
  resourcesPath = process.resourcesPath || "",
} = {}) {
  let activeCheck = null;
  let availableUpdate = null;
  let updateDownloaded = false;

  const currentVersion = () => {
    try {
      return clean(app?.getVersion?.()) || "未知";
    } catch {
      return "未知";
    }
  };

  const packageType = () => {
    const root = clean(resourcesPath);
    if (!root) return "";
    try {
      return clean(fsOps.readFileSync(path.join(root, "package-type"), "utf8")).toLowerCase();
    } catch {
      return "";
    }
  };

  const capability = () => {
    const version = currentVersion();
    if (app?.isPackaged !== true) {
      return {
        mode: "manual",
        status: "development",
        version,
        message: "开发环境不会检查正式更新。",
      };
    }
    if (packageType() !== "nsis") {
      return {
        mode: "manual",
        status: "manual",
        version,
        message: "当前是 ZIP/测试构建，无法自动覆盖；正式安装版发布后可在这里更新。",
      };
    }
    if (!autoUpdater || typeof autoUpdater.checkForUpdates !== "function") {
      return {
        mode: "manual",
        status: "unavailable",
        version,
        message: "当前安装包没有启用更新服务。",
      };
    }
    return {
      mode: "automatic",
      status: "ready",
      version,
      message: `当前版本 ${versionLabel(version)}，可检查更新。`,
    };
  };

  const availableResult = (info) => {
    const version = currentVersion();
    const next = updateInfo(info);
    return {
      mode: "automatic",
      status: "available",
      version,
      ...(next ? { availableVersion: next.version } : {}),
      message: next
        ? `发现新版本 ${versionLabel(next.version)}，可下载后重启安装。`
        : "发现新版本，可下载后重启安装。",
    };
  };

  const downloadedResult = () => {
    const version = currentVersion();
    const next = availableUpdate;
    return {
      mode: "automatic",
      status: "downloaded",
      version,
      ...(next ? { availableVersion: next.version } : {}),
      message: "更新已下载完成，重启软件即可安装。",
    };
  };

  const currentResult = (info) => {
    const version = currentVersion();
    const next = updateInfo(info);
    return {
      mode: "automatic",
      status: "current",
      version,
      ...(next ? { availableVersion: next.version } : {}),
      message: `已是最新版本 ${versionLabel(version)}。`,
    };
  };

  const errorResult = (error) => ({
    mode: "automatic",
    status: /\b404\b|not found|latest\.yml/iu.test(clean(error?.message || error)) ? "unavailable" : "error",
    version: currentVersion(),
    message: updaterErrorMessage(error),
  });

  const status = () => {
    const supported = capability();
    if (supported.status !== "ready") return supported;
    if (updateDownloaded) return downloadedResult();
    if (availableUpdate) return availableResult(availableUpdate);
    return supported;
  };

  const checkForUpdates = async () => {
    const supported = capability();
    if (supported.status !== "ready") return supported;
    if (activeCheck) return activeCheck;

    availableUpdate = null;
    updateDownloaded = false;
    autoUpdater.autoDownload = false;

    let observed = null;
    const onAvailable = (info) => {
      observed = { kind: "available", info };
    };
    const onCurrent = (info) => {
      observed = { kind: "current", info };
    };
    autoUpdater.once?.("update-available", onAvailable);
    autoUpdater.once?.("update-not-available", onCurrent);

    const operation = (async () => {
      try {
        const result = await autoUpdater.checkForUpdates();
        const info = observed?.info || result?.updateInfo || null;
        const resultVersion = clean(info?.version);
        const hasAvailableUpdate = observed?.kind === "available"
          || (observed?.kind !== "current" && Boolean(resultVersion) && resultVersion !== currentVersion());
        if (hasAvailableUpdate) {
          availableUpdate = updateInfo(info);
          return availableResult(availableUpdate);
        }
        return currentResult(info);
      } catch (error) {
        return errorResult(error);
      } finally {
        autoUpdater.removeListener?.("update-available", onAvailable);
        autoUpdater.removeListener?.("update-not-available", onCurrent);
      }
    })();
    activeCheck = operation;
    void operation.finally(() => {
      if (activeCheck === operation) activeCheck = null;
    });
    return operation;
  };

  const downloadUpdate = async () => {
    const supported = capability();
    if (supported.status !== "ready") return supported;
    if (updateDownloaded) return downloadedResult();
    if (!availableUpdate) {
      return {
        ...supported,
        message: "请先检查更新。",
      };
    }
    if (typeof autoUpdater.downloadUpdate !== "function") {
      return {
        mode: "automatic",
        status: "unavailable",
        version: currentVersion(),
        message: "当前安装包无法下载更新。",
      };
    }
    try {
      await autoUpdater.downloadUpdate();
      updateDownloaded = true;
      return downloadedResult();
    } catch (error) {
      return errorResult(error);
    }
  };

  const installUpdate = async () => {
    const supported = capability();
    if (supported.status !== "ready") return supported;
    if (!updateDownloaded) {
      return {
        ...supported,
        message: "更新尚未下载完成。",
      };
    }
    if (typeof autoUpdater.quitAndInstall !== "function") {
      return {
        mode: "automatic",
        status: "unavailable",
        version: currentVersion(),
        message: "当前安装包无法安装更新。",
      };
    }
    try {
      autoUpdater.quitAndInstall();
      return {
        mode: "automatic",
        status: "installing",
        version: currentVersion(),
        ...(availableUpdate ? { availableVersion: availableUpdate.version } : {}),
        message: "正在重启并安装更新。",
      };
    } catch (error) {
      return errorResult(error);
    }
  };

  return { checkForUpdates, downloadUpdate, installUpdate, status };
}
