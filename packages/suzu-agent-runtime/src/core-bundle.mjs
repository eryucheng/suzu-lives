import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveSuzuAgentCoreModule } from "./core-module-catalog.mjs";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CORE_DIRECTORY = resolve(MODULE_DIRECTORY, "..", "vendor", "core");
const BUNDLE_ANCHOR = resolve(CORE_DIRECTORY, "package.json");
const NATIVE_ANCHOR = resolve(CORE_DIRECTORY, "node_modules", "@suzu-lives", "agent-core-native", "package.json");
const NATIVE_RUNTIME_ROOT_VARIABLE = "SUZU_AGENT_CORE_NATIVE_ROOT";

function clean(value) {
  return String(value ?? "").trim();
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label}缺失：${path}`);
  return path;
}

/** The private execution bundle anchor used only by the owned child process. */
export function resolveSuzuAgentCoreBundleAnchor() {
  return requireFile(BUNDLE_ANCHOR, "Suzu Agent Core bundle");
}

/**
 * Loads one selected execution module through Suzu's product-owned module map.
 * The source package name is deliberately absent from this runtime boundary.
 */
export async function importSuzuAgentCoreModule(id) {
  return import(pathToFileURL(resolveSuzuAgentCoreModule(id)).href);
}

/** Resolves the native dependency island carried beside a packaged desktop app. */
export function resolveSuzuAgentCoreNativeRuntimeRoot({
  nativeRuntimeRoot = process.env[NATIVE_RUNTIME_ROOT_VARIABLE],
  resourcesPath = process.resourcesPath,
} = {}) {
  const explicitRoot = clean(nativeRuntimeRoot);
  if (explicitRoot) return resolve(explicitRoot);
  const desktopResourcesPath = clean(resourcesPath);
  return desktopResourcesPath
    ? resolve(desktopResourcesPath, "agent-core-native", "node_modules")
    : "";
}

/**
 * The desktop package carries native dependencies outside app.asar in a
 * resource island. The owned supervisor passes that absolute root to its
 * Node child because ELECTRON_RUN_AS_NODE does not promise resourcesPath.
 * Source and test executions retain the colocated development island.
 */
export function resolveSuzuAgentCoreNativeAnchor({
  nativeRuntimeRoot = process.env[NATIVE_RUNTIME_ROOT_VARIABLE],
  resourcesPath = process.resourcesPath,
} = {}) {
  const roots = [
    resolveSuzuAgentCoreNativeRuntimeRoot({ nativeRuntimeRoot, resourcesPath: "" }),
    resolveSuzuAgentCoreNativeRuntimeRoot({ nativeRuntimeRoot: "", resourcesPath }),
  ].filter((root, index, values) => root && values.indexOf(root) === index);
  const packagedAnchors = roots.map((root) => (
    resolve(root, "@suzu-lives", "agent-core-native", "package.json")
  ));
  for (const packagedAnchor of packagedAnchors) {
    if (existsSync(packagedAnchor)) return packagedAnchor;
  }
  if (existsSync(NATIVE_ANCHOR)) return NATIVE_ANCHOR;
  return requireFile(packagedAnchors[0] || NATIVE_ANCHOR, "Suzu Agent Core native runtime");
}

/**
 * Native terminal/image helpers cannot be bundled into JavaScript. They live
 * in a small private island beside the compiled core, not in app dependencies.
 */
export function createSuzuAgentCoreNativeRequire(options = {}) {
  return createRequire(resolveSuzuAgentCoreNativeAnchor(options));
}
