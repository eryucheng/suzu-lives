import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSuzuLivesDataRoot } from "@suzu-lives/agent-registry";

export const MODULE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const REGISTRY_PATH = path.join(MODULE_ROOT, "registry.json");

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Python cannot read Electron's virtual app.asar paths. Keep the launcher
 * resolution here so the regular site flow and the explicit browser command
 * always select the same real file.
 */
export function resolveBrowserStarterPath({
  resourcesPath = process.resourcesPath,
  existsSync = fs.existsSync,
} = {}) {
  const resourcesRoot = clean(resourcesPath);
  const unpackedPath = resourcesRoot
    ? path.join(
      resourcesRoot,
      "app.asar.unpacked",
      "node_modules",
      "@suzu-lives",
      "browser-automation",
      "src",
      "web-browser",
      "start_browser.py",
    )
    : "";
  if (unpackedPath && existsSync(unpackedPath)) return unpackedPath;
  return path.resolve(MODULE_ROOT, "..", "web-browser", "start_browser.py");
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readOptionalJson(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("配置文件必须是软件数据目录内的普通文件。");
    }
    return readJson(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function softwareRuntime({ dataRoot = "", projectRoot = "" } = {}) {
  const resolvedDataRoot = resolveSuzuLivesDataRoot({
    configuredRoot: clean(dataRoot) || process.env.SUZU_LIVES_DATA_ROOT || "",
    localAppData: process.env.LOCALAPPDATA || "",
    appData: process.env.APPDATA || "",
    fallbackBase: "",
    fallbackToLocatorWhenMissing: true,
  });
  return {
    dataRoot: resolvedDataRoot,
    projectRoot: clean(projectRoot),
    runtimeRoot: path.join(resolvedDataRoot, "capabilities", "site-automation"),
    browserRuntimeRoot: path.join(resolvedDataRoot, "capabilities", "web-browser"),
  };
}

export function readJson(filePath) {
  const source = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
  return JSON.parse(source);
}

export function resolveModulePath(value) {
  if (!value || typeof value !== "string") {
    throw new Error("Configured path must be a non-empty string.");
  }
  return path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(MODULE_ROOT, value);
}

/**
 * Configuration and all mutable runtime files live in the software-owned
 * Suzu Lives data root. We never read configuration or runtime from a Claude
 * project directory or an individual contact's data directory.
 */
export function loadConfig(context = {}) {
  const runtime = softwareRuntime(context);
  const defaultConfigPath = path.join(runtime.runtimeRoot, "config.json");
  const requestedConfig = clean(context.configPath || process.env.SUZU_LIVES_SITE_AUTOMATION_CONFIG || defaultConfigPath);
  const sourcePath = path.resolve(runtime.runtimeRoot, requestedConfig);
  if (!inside(runtime.runtimeRoot, sourcePath)) {
    throw new Error("site-automation 配置必须位于 Suzu Lives 软件数据目录内。");
  }
  const raw = readOptionalJson(sourcePath);
  const media = raw?.douyin?.media && typeof raw.douyin.media === "object" ? raw.douyin.media : {};
  const groups = Array.isArray(raw?.douyin?.groupChats) ? raw.douyin.groupChats : [];
  const resolveRuntimePath = (value, fallback) => {
    const candidate = value ? path.resolve(runtime.runtimeRoot, value) : fallback;
    if (!inside(runtime.runtimeRoot, candidate)) throw new Error("site-automation 运行路径必须位于软件数据目录内。");
    return candidate;
  };
  return {
    ...raw,
    sourcePath,
    dataRoot: runtime.dataRoot,
    projectRoot: runtime.projectRoot,
    runtimeRoot: runtime.runtimeRoot,
    browserRuntimeRoot: runtime.browserRuntimeRoot,
    cdpUrl: String(raw.cdpUrl || "http://127.0.0.1:9222").replace(/\/+$/u, ""),
    timeoutMs: Number(raw.timeoutMs || 10000),
    navigationTimeoutMs: Number(raw.navigationTimeoutMs || 25000),
    autoStartBrowser: raw.autoStartBrowser !== false,
    pythonCommand: String(raw.pythonCommand || process.env.SUZU_LIVES_PYTHON || "python"),
    browserStartScript: resolveBrowserStarterPath(),
    diagnosticsDirectory: resolveRuntimePath(raw.diagnosticsDirectory, path.join(runtime.runtimeRoot, "diagnostics")),
    actionLogPath: resolveRuntimePath(raw.actionLogPath, path.join(runtime.runtimeRoot, "action-log.jsonl")),
    suzuLivesCommand: String(raw.suzuLivesCommand || process.env.SUZU_LIVES_COMMAND || "suzu-lives"),
    douyin: {
      ...(raw.douyin && typeof raw.douyin === "object" ? raw.douyin : {}),
      actionLogPath: resolveRuntimePath(raw?.douyin?.actionLogPath, path.join(runtime.runtimeRoot, "douyin", "action-log.jsonl")),
      ownerChat: {
        ...(raw?.douyin?.ownerChat && typeof raw.douyin.ownerChat === "object" ? raw.douyin.ownerChat : {}),
        runtimeDirectory: resolveRuntimePath(raw?.douyin?.ownerChat?.runtimeDirectory, path.join(runtime.runtimeRoot, "douyin")),
      },
      groupChats: groups.map((group) => ({
        ...(group && typeof group === "object" ? group : {}),
        runtimeDirectory: resolveRuntimePath(group?.runtimeDirectory, path.join(runtime.runtimeRoot, "douyin", "groups")),
      })),
      media: {
        ...media,
        runtimeDirectory: resolveRuntimePath(media.runtimeDirectory, path.join(runtime.runtimeRoot, "douyin", "media")),
      },
    },
  };
}

export function loadRegistry() {
  const registry = readJson(REGISTRY_PATH);
  if (
    registry.version !== 1 ||
    !registry.sites ||
    typeof registry.sites !== "object"
  ) {
    throw new Error("registry.json has an invalid format.");
  }
  return registry;
}

export function resolveSite(registry, requested) {
  const normalized = String(requested || "").trim().toLowerCase();
  for (const [siteId, entry] of Object.entries(registry.sites)) {
    const aliases = [siteId, ...(entry.aliases || [])].map((value) =>
      String(value).trim().toLowerCase(),
    );
    if (aliases.includes(normalized)) return { siteId, entry };
  }
  return null;
}

export function loadSiteManifest(entry) {
  const manifestPath = resolveModulePath(entry.manifest);
  const manifest = readJson(manifestPath);
  return { manifest, manifestPath };
}

/**
 * Public, static site metadata for the settings UI.  New sites enter this
 * list through registry.json + their own manifest; the control center does
 * not maintain a second hard-coded site list.
 */
export function listSiteAutomationSites() {
  const registry = loadRegistry();
  return Object.entries(registry.sites).map(([id, entry]) => {
    const { manifest } = loadSiteManifest(entry);
    return {
      id,
      name: clean(entry.name) || clean(manifest.name) || id,
      actions: Object.entries(plainObject(manifest.actions)).map(([actionId, action]) => {
        const definition = plainObject(action);
        return {
          id: actionId,
          label: clean(definition.label) || actionId,
          group: clean(definition.group) || "其他",
          description: clean(definition.description),
          mutating: definition.mutating === true,
        };
      }),
    };
  });
}

function siteControl(config, siteId) {
  return plainObject(plainObject(config).sites)[clean(siteId).toLowerCase()];
}

/**
 * Unconfigured sites and actions stay enabled for compatibility.  Only an
 * explicit false written by the control center disables an action.
 */
export function isSiteEnabled(config, siteId) {
  return plainObject(siteControl(config, siteId)).enabled !== false;
}

export function isSiteActionEnabled(config, siteId, actionId) {
  if (!isSiteEnabled(config, siteId)) return false;
  const actions = plainObject(plainObject(siteControl(config, siteId)).actions);
  return actions[clean(actionId).toLowerCase()] !== false;
}
