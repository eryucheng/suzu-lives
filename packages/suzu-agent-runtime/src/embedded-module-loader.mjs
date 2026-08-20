import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import { createSuzuAgentCoreNativeRequire, resolveSuzuAgentCoreNativeAnchor } from "./core-bundle.mjs";
import {
  SUZU_AGENT_CORE_MODULE_PREFIX,
  resolveSuzuAgentCoreModule,
  suzuAgentCoreModuleId,
} from "./core-module-catalog.mjs";

const runtimeRequire = createRequire(import.meta.url);
const nativeRequire = createSuzuAgentCoreNativeRequire();
const nativeAnchor = resolveSuzuAgentCoreNativeAnchor();
const nativeRuntimeRoot = dirname(dirname(dirname(nativeAnchor)));

function clean(value) {
  return String(value ?? "").trim();
}

function isBareModuleSpecifier(value) {
  const specifier = clean(value);
  return Boolean(specifier)
    && !specifier.startsWith(".")
    && !specifier.startsWith("/")
    && !specifier.startsWith("file:")
    && !specifier.startsWith("node:")
    && !specifier.startsWith("data:");
}

function profileRequire() {
  const home = clean(process.env.SUZU_AGENT_HOME);
  return home ? createRequire(join(home, "profiles", "web", "cordis.yml")) : null;
}

function barePackageName(specifier) {
  const parts = clean(specifier).split("/");
  const count = parts[0]?.startsWith("@") ? 2 : 1;
  if (parts.length !== count || parts.some((part) => !part)) return "";
  return parts.join("/");
}

function importExportTarget(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  if (typeof value.import === "string") return value.import;
  if (value.node) return importExportTarget(value.node);
  if (value.default) return importExportTarget(value.default);
  return "";
}

function nativeImportTarget(specifier, context) {
  if (!Array.isArray(context?.conditions) || !context.conditions.includes("import")) return "";
  const packageName = barePackageName(specifier);
  if (!packageName) return "";
  const packageRoot = join(nativeRuntimeRoot, ...packageName.split("/"));
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    const rootExport = manifest.exports?.["."] ?? manifest.exports;
    const target = importExportTarget(rootExport);
    const candidate = target.startsWith("./") ? resolvePath(packageRoot, target) : "";
    return candidate && existsSync(candidate) ? candidate : "";
  } catch {
    return "";
  }
}

function resolveNativeSpecifier(specifier, context) {
  return nativeImportTarget(specifier, context) || nativeRequire.resolve(specifier);
}

/**
 * Electron's Node compatibility runtime cannot expose the internal module
 * resolver used by the selected kernel. Product presets therefore use Suzu's
 * own `core/<role>` specifiers, resolved only from the compiled private bundle.
 * It deliberately has no fallback to an upstream product bundle or CLI.
 */
export async function resolve(specifier, context, nextResolve) {
  const coreModuleId = clean(specifier).startsWith(SUZU_AGENT_CORE_MODULE_PREFIX)
    ? suzuAgentCoreModuleId(specifier)
    : "";
  if (coreModuleId) {
    return {
      url: pathToFileURL(resolveSuzuAgentCoreModule(coreModuleId)).href,
      shortCircuit: true,
    };
  }
  if (clean(specifier) === "@deepseek-ai" || clean(specifier).startsWith("@deepseek-ai/")) {
    throw new Error(`Suzu Agent Core 不允许直接解析上游模块：${clean(specifier)}。`);
  }
  try {
    return await nextResolve(specifier, context);
  } catch (initialError) {
    if (!isBareModuleSpecifier(specifier)) throw initialError;
    // Product-owned bridges live with this runtime package; only the small
    // native terminal/image island participates as a final fallback.
    for (const resolver of [profileRequire(), runtimeRequire, nativeRequire].filter(Boolean)) {
      try {
        return {
          url: pathToFileURL(resolver === nativeRequire ? resolveNativeSpecifier(specifier, context) : resolver.resolve(specifier)).href,
          shortCircuit: true,
        };
      } catch {
        // Preserve Node's original error only after all supported roots fail.
      }
    }
    throw initialError;
  }
}
