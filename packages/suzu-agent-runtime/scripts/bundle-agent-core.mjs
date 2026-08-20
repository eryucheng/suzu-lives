import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { rolldown } from "rolldown";

import { listSuzuAgentCoreSourceEntries } from "./upstream-agent-core-source-catalog.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");
const WORKSPACE_DIRECTORY = resolve(RUNTIME_DIRECTORY, "..", "..");
const SOURCE_DIRECTORY = resolve(process.env.SUZU_AGENT_VENDOR_SOURCE || WORKSPACE_DIRECTORY);
const VENDOR_DIRECTORY = resolve(RUNTIME_DIRECTORY, "vendor");
const DEFAULT_CORE_DIRECTORY = resolve(VENDOR_DIRECTORY, "core");
const CORE_DIRECTORY = resolve(process.env.SUZU_AGENT_CORE_BUNDLE_OUTPUT || DEFAULT_CORE_DIRECTORY);
const OUTPUT_VENDOR_DIRECTORY = dirname(CORE_DIRECTORY);
const MODULE_DIRECTORY = resolve(CORE_DIRECTORY, "modules");
const NATIVE_NODE_MODULES = resolve(CORE_DIRECTORY, "node_modules");
const SNAPSHOT = "deepseek-harness@0.1.0-rc.6";
const COMPATIBLE_PROVIDER_CATALOG = resolve(RUNTIME_DIRECTORY, "src", "compatible-provider-catalog.mjs");

const PI_AI_RUNTIME_DEPENDENCIES = Object.freeze([
  "@anthropic-ai/sdk",
  "openai",
  "partial-json",
  "typebox",
]);

// These modules load a platform binary at runtime. They deliberately remain as
// a tiny private `node_modules` island next to the bundle; every normal JS
// dependency is folded into Suzu's own generated Agent Core modules.
const NATIVE_RUNTIME_PACKAGES = Object.freeze([
  "node-pty",
  "sharp",
  "@img/colour",
  "@img/sharp-win32-x64",
  "detect-libc",
  "semver",
  "koffi",
  "@koromix/koffi-win32-x64",
]);
const NATIVE_RUNTIME_PACKAGE_SET = new Set(NATIVE_RUNTIME_PACKAGES);
const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, name.replace(/^node:/u, "")]));

function clean(value) {
  return String(value ?? "").trim();
}

function packageSegments(name) {
  if (!name || typeof name !== "string" || name.includes("\\") || name.includes("..")) {
    throw new Error(`Invalid package name: ${String(name)}`);
  }
  const segments = name.split("/");
  if ((name.startsWith("@") && segments.length !== 2) || (!name.startsWith("@") && segments.length !== 1)) {
    throw new Error(`Invalid package name: ${name}`);
  }
  return segments;
}

function insideDirectory(candidate, parent) {
  const relation = relative(parent, candidate);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== "..");
}

function packageJsonAt(directory) {
  try { return stat(join(directory, "package.json")); }
  catch { return null; }
}

async function findInstalledPackage(name, startDirectory) {
  const segments = packageSegments(name);
  let current = resolve(startDirectory);
  while (true) {
    const packageDirectory = join(current, "node_modules", ...segments);
    try {
      if ((await packageJsonAt(packageDirectory))?.isFile()) return packageDirectory;
    } catch { /* Keep walking. */ }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return "";
}

async function packageManifest(directory) {
  const source = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  if (!source?.name || !source?.version) throw new Error(`Invalid package manifest at ${directory}`);
  return source;
}

function packageNameFromSpecifier(value) {
  const specifier = clean(value);
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:") || specifier.startsWith("file:")) return "";
  const segments = specifier.split("/");
  if (specifier.startsWith("@")) return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : "";
  return segments[0] || "";
}

function compatibleProviderPackage(name) {
  if (!name.startsWith("@img/sharp-")) return true;
  return name === "@img/sharp-win32-x64";
}

function dependencyNames(manifest) {
  if (manifest?.name === "@earendil-works/pi-ai") return [...PI_AI_RUNTIME_DEPENDENCIES];
  const names = new Set();
  for (const name of Object.keys(manifest?.dependencies || {})) {
    if (name !== "@suzu-lives/suzu-agent-runtime") names.add(name);
  }
  // Native packages need their selected Windows runtime sibling. Other optional
  // dependencies are either platform variants or fallbacks and are discovered
  // from actual bundled imports below when they are really needed.
  for (const name of Object.keys(manifest?.optionalDependencies || {})) {
    if (NATIVE_RUNTIME_PACKAGE_SET.has(name) || compatibleProviderPackage(name)) names.add(name);
  }
  return [...names].sort();
}

async function runtimeImportPackages(directory, packageName = "") {
  if (packageName === "@earendil-works/pi-ai") return [];
  const names = new Set();
  const scanFile = async (path) => {
    const source = await readFile(path, "utf8");
    const expression = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()(["'])([^"']+)\1/gu;
    for (const match of source.matchAll(expression)) {
      const name = packageNameFromSpecifier(match[2]);
      if (name && name !== "@suzu-lives/suzu-agent-runtime" && compatibleProviderPackage(name)) names.add(name);
    }
  };
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "test" || entry.name === "tests" || entry.name === "src") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(?:[cm]?js)$/u.test(entry.name)) await scanFile(path);
    }
  };
  const runtimeRoots = ["lib", "dist", "build", "out"]
    .map((name) => join(directory, name));
  for (const root of runtimeRoots) {
    try {
      if ((await stat(root)).isDirectory()) await visit(root);
    } catch { /* Package has no folder of this name. */ }
  }
  return [...names].sort();
}

async function collectSourcePackages(entries) {
  const queue = entries.map((entry) => ({ name: entry.sourcePackage, parent: SOURCE_DIRECTORY, root: true }));
  const seen = new Map();
  while (queue.length) {
    const next = queue.shift();
    if (seen.has(next.name)) continue;
    const directory = await findInstalledPackage(next.name, next.parent);
    if (!directory) {
      if (next.root) throw new Error(`Required Agent Core source package is not installed: ${next.name}`);
      continue;
    }
    const manifest = await packageManifest(directory);
    if (manifest.name !== next.name) throw new Error(`Resolved ${next.name} to a mismatched package: ${manifest.name}`);
    seen.set(next.name, { directory, manifest });
    for (const name of [...dependencyNames(manifest), ...await runtimeImportPackages(directory, manifest.name)]) {
      queue.push({ name, parent: directory, root: false });
    }
  }
  for (const name of NATIVE_RUNTIME_PACKAGES) {
    if (seen.has(name)) continue;
    const directory = await findInstalledPackage(name, SOURCE_DIRECTORY);
    if (!directory) throw new Error(`Required native Agent Core source package is not installed: ${name}`);
    seen.set(name, { directory, manifest: await packageManifest(directory) });
  }
  return seen;
}

function resolvePackageEntry(directory, packageName) {
  const resolver = createRequire(join(directory, "package.json"));
  const entry = resolver.resolve(packageName);
  if (!insideDirectory(entry, directory)) throw new Error(`Package entry escaped source package: ${packageName}`);
  return entry;
}

function isNativeExternal(specifier) {
  const name = packageNameFromSpecifier(specifier);
  return NATIVE_RUNTIME_PACKAGE_SET.has(name);
}

function isNodeExternal(specifier) {
  const source = clean(specifier);
  return source.startsWith("node:") || NODE_BUILTINS.has(source);
}

function isProductExternal(specifier) {
  return clean(specifier).startsWith("@suzu-lives/suzu-agent-runtime/")
    && clean(specifier) !== "@suzu-lives/suzu-agent-runtime/compatible-provider-catalog";
}

function nativeFilter(packageName, sourceRoot) {
  const root = resolve(sourceRoot);
  const include = (relativePath) => {
    const path = relativePath.replaceAll("\\", "/");
    if (["package.json", "LICENSE", "LICENSE.md", "LICENCE", "NOTICE"].includes(path)) return true;
    if (packageName === "node-pty") {
      return path === "lib" || path.startsWith("lib/")
        || path === "prebuilds"
        || (/^prebuilds\/win32-(?:x64|arm64)(?:\/|$)/u.test(path) && !path.endsWith(".pdb"));
    }
    if (packageName === "sharp") return path === "dist" || path.startsWith("dist/");
    if (packageName === "@img/sharp-win32-x64") return path === "index.cjs" || path === "lib" || path.startsWith("lib/") || path === "versions.json";
    if (packageName === "@img/colour") return path.endsWith(".cjs") || path.endsWith(".js");
    if (packageName === "koffi") {
      return path === "index.js" || path === "index.cjs" || path === "src" || path === "src/koffi" || path === "src/koffi/src" || (path.startsWith("src/koffi/") && path.endsWith(".js"));
    }
    if (packageName === "@koromix/koffi-win32-x64") return path === "index.js" || path === "win32_x64" || path.startsWith("win32_x64/");
    // detect-libc and semver are small JavaScript runtime packages. Exclude
    // their tests/docs/types but retain their published JS layout unchanged.
    return !/(?:^|\/)(?:test|tests|docs|src)\//u.test(path)
      && !/\.(?:d\.ts|map)$/u.test(path)
      && !path.endsWith(".md");
  };
  return (entry) => {
    const relativePath = relative(root, entry);
    return !relativePath || include(relativePath);
  };
}

async function copyNativePackage(entry) {
  const destination = resolve(NATIVE_NODE_MODULES, ...packageSegments(entry.manifest.name));
  if (!insideDirectory(destination, NATIVE_NODE_MODULES)) throw new Error(`Unsafe native package destination: ${destination}`);
  await mkdir(dirname(destination), { recursive: true });
  await cp(entry.directory, destination, {
    recursive: true,
    filter: nativeFilter(entry.manifest.name, entry.directory),
  });
  return destination;
}

/**
 * The selected bootstrap module resolves Cordis entries through its own package resolver,
 * rather than Node's ESM loader hook.  Give that resolver a tiny private
 * Suzu package containing only forwarding entrypoints into this bundle.
 *
 * This is not a copied runtime package: it is generated product glue (one
 * line per selected module) and keeps the bundled core self-contained after
 * the development workspace and its node_modules tree are gone.
 */
async function writeProductCoreBridge(entries) {
  const packageDirectory = resolve(NATIVE_NODE_MODULES, "@suzu-lives", "suzu-agent-runtime");
  const bridgeDirectory = join(packageDirectory, "core");
  await mkdir(bridgeDirectory, { recursive: true });
  await writeFile(join(packageDirectory, "package.json"), `${JSON.stringify({
    name: "@suzu-lives/suzu-agent-runtime",
    private: true,
    type: "module",
    exports: { "./core/*": "./core/*.mjs" },
  }, null, 2)}\n`);
  await Promise.all(entries.map((entry) => writeFile(
    join(bridgeDirectory, `${entry.id}.mjs`),
    `export * from "../../../../modules/${entry.id}.mjs";\n`,
  )));
}

async function fileOrEmpty(path) {
  try { return await readFile(path, "utf8"); }
  catch { return ""; }
}

async function sourceLicense(entry) {
  for (const name of ["LICENSE", "LICENSE.md", "LICENCE", "NOTICE"]) {
    const text = await fileOrEmpty(join(entry.directory, name));
    if (text.trim()) return { file: name, text };
  }
  return { file: "", text: "" };
}

async function writeThirdPartyNotices(entries) {
  const groups = new Map();
  for (const entry of [...entries.values()].sort((left, right) => left.manifest.name.localeCompare(right.manifest.name))) {
    const license = await sourceLicense(entry);
    const key = license.text.trim() ? `${entry.manifest.license || "SEE PACKAGE LICENSE"}:${license.text}` : `${entry.manifest.license || "SEE PACKAGE LICENSE"}:`;
    const group = groups.get(key) || { license: entry.manifest.license || "SEE PACKAGE LICENSE", text: license.text, packages: [] };
    group.packages.push(`${entry.manifest.name}@${entry.manifest.version}`);
    groups.set(key, group);
  }
  const sections = [
    "# Suzu Agent Core — third-party notices",
    "",
    "This generated Suzu Agent Core bundle contains selected execution-layer source from DeepSeek Harness and its runtime dependencies. It does not contain an upstream desktop app, CLI, browser UI, web server, workspace, workflow, subagent, or code-mode product.",
  ];
  for (const group of groups.values()) {
    sections.push("", `## ${group.license}`, "", group.packages.join(", "));
    if (group.text.trim()) sections.push("", group.text.trimEnd());
  }
  await writeFile(join(OUTPUT_VENDOR_DIRECTORY, "THIRD_PARTY_NOTICES.md"), `${sections.join("\n")}\n`);
}

async function directorySize(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(path);
    else if (entry.isFile()) total += (await stat(path)).size;
  }
  return total;
}

function ownAgentCoreDiagnostics(code) {
  return code
    .replaceAll("dsh: invalid profile name", "suzu-agent-core: invalid profile name")
    .replaceAll(
      "background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)",
      "background jobs unavailable: no Suzu Agent Core job controller serves this agent",
    )
    .replaceAll(
      "background job ownership requires the agent registry (load @deepseek-ai/dsh-agent)",
      "background job ownership requires the Suzu Agent Core agent registry",
    )
    .replaceAll(
      "background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs",
      "background jobs unavailable: Suzu Agent Core background-job support is not installed",
    )
    .replaceAll(
      "dsh-tools: mode \"${mode}\" requires a code runtime — load a ctx.codeRuntime implementation (e.g. @deepseek-ai/dsh-code-runtime-worker-thread) or set tools mode to \"native\"",
      "Agent Core: mode \"${mode}\" requires a code runtime, which this profile does not include",
    );
}

function ownAgentCoreExecutionSource(code, id) {
  let next = ownAgentCoreDiagnostics(code);
  if (/[/\\]dsh-subprocess[/\\]lib[/\\]index\.js$/u.test(id)) {
    next = next
      .replace('const DSH_ENV_PREFIX = "DSH_";', 'const DSH_ENV_PREFIX = "SUZU_AGENT_";')
      .replace(
        '!key.toUpperCase().startsWith("DSH_")',
        '!key.toUpperCase().startsWith("DSH_") && !key.toUpperCase().startsWith("SUZU_AGENT_")',
      );
    if (!next.includes('const DSH_ENV_PREFIX = "SUZU_AGENT_";') || !next.includes('!key.toUpperCase().startsWith("SUZU_AGENT_")')) {
      throw new Error("Cannot apply Suzu Agent Core shell-environment bundle patch: subprocess source layout changed.");
    }
  }
  if (/[/\\]dsh-shell-env[/\\]lib[/\\]index\.js$/u.test(id)) {
    next = next.replace(
      'import { DSH_HOME_ENV, resolveDshHome } from "@deepseek-ai/dsh-home-paths";',
      'import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";\nconst DSH_HOME_ENV = "SUZU_AGENT_HOME";',
    );
    if (!next.includes('const DSH_HOME_ENV = "SUZU_AGENT_HOME";')) {
      throw new Error("Cannot apply Suzu Agent Core shell-home bundle patch: shell environment source layout changed.");
    }
  }
  if (/[/\\]dsh-tool-pwsh[/\\]lib[/\\]index\.js$/u.test(id)) {
    next = next.replace(
      "Current harness environment facts are exposed through managed `$env:DSH_*` variables; inspect them when needed.",
      "Current Suzu Agent environment facts are exposed through managed `$env:SUZU_AGENT_*` variables; inspect them when needed.",
    );
    if (!next.includes("Current Suzu Agent environment facts are exposed through managed `$env:SUZU_AGENT_*` variables; inspect them when needed.")) {
      throw new Error("Cannot apply Suzu Agent Core PowerShell prompt bundle patch: tool source layout changed.");
    }
  }
  return next;
}

function coreBundlePlugin() {
  return {
    name: "suzu-agent-core-source-boundary",
    resolveId(source) {
      if (source === "@earendil-works/pi-ai/providers/all" || source === "@suzu-lives/suzu-agent-runtime/compatible-provider-catalog") {
        return COMPATIBLE_PROVIDER_CATALOG;
      }
      return null;
    },
    transform(code, id) {
      const productCode = ownAgentCoreExecutionSource(code, id);
      if (/[/\\]dsh-app-boot[/\\]lib[/\\]index\.js$/u.test(id)) {
        const next = productCode.replace(
          'ctx.provide("dshHomePath", dshHomePath);',
          'ctx.provide("suzuAgentHomePath", dshHomePath);',
        );
        if (!next.includes('ctx.provide("suzuAgentHomePath", dshHomePath);')) {
          throw new Error("Cannot apply Suzu Agent Core bootstrap-path bundle patch: upstream layout changed.");
        }
        return { code: next, map: null };
      }
      if (/[/\\]dsh-jobs[/\\]lib[/\\]index\.js$/u.test(id)) {
        return {
          code: productCode.replace("@deepseek-ai/dsh-jobs is the abstract job registry seam; load an implementation such as @deepseek-ai/dsh-jobs-local instead", "Suzu Agent Core job registry is abstract; load a selected local implementation instead"),
          map: null,
        };
      }
      if (/[/\\]dsh-llm-pi-ai[/\\]lib[/\\]index\.js$/u.test(id)) {
        let next = productCode.replace('from "@earendil-works/pi-ai/providers/all";', 'from "@suzu-lives/suzu-agent-runtime/compatible-provider-catalog";');
        next = next.replace('const name = "llm-pi-ai";', 'const name = "suzu-compatible-llm";');
        next = next.replace('const NS = settingsNamespace("llm-pi-ai");', 'const NS = settingsNamespace("llm-suzu-compatible");');
        next = next.replace(
          'if (directory === void 0) directory = ctx.llm.registerConfigurableProviders(entries);\n\t\telse directory.replace(entries);',
          'if (entries.length === 0) {\n\t\t\tif (directory !== void 0) directory();\n\t\t\tdirectory = void 0;\n\t\t\tdirectoryFacts = entries;\n\t\t\treturn;\n\t\t}\n\t\tif (directory === void 0) directory = ctx.llm.registerConfigurableProviders(entries);\n\t\telse directory.replace(entries);',
        );
        if (!next.includes('settingsNamespace("llm-suzu-compatible")') || !next.includes('if (entries.length === 0) {')) {
          throw new Error("Cannot apply Suzu compatible-model bundle patch: upstream layout changed.");
        }
        return { code: next, map: null };
      }
      return productCode === code ? null : { code: productCode, map: null };
    },
  };
}

async function assertOutputDirectory() {
  const allowed = CORE_DIRECTORY === DEFAULT_CORE_DIRECTORY || insideDirectory(CORE_DIRECTORY, resolve("D:\\Temp"));
  if (!allowed) throw new Error(`Refusing unsafe Agent Core bundle target: ${CORE_DIRECTORY}`);
  if (CORE_DIRECTORY === VENDOR_DIRECTORY || !insideDirectory(CORE_DIRECTORY, VENDOR_DIRECTORY) && CORE_DIRECTORY === DEFAULT_CORE_DIRECTORY) {
    throw new Error(`Refusing unsafe Agent Core bundle target: ${CORE_DIRECTORY}`);
  }
}

async function main() {
  await assertOutputDirectory();
  const entries = listSuzuAgentCoreSourceEntries();
  const sources = await collectSourcePackages(entries);
  const input = Object.fromEntries(entries.map((entry) => {
    const source = sources.get(entry.sourcePackage);
    if (!source) throw new Error(`Missing selected source entry: ${entry.sourcePackage}`);
    return [entry.id, resolvePackageEntry(source.directory, entry.sourcePackage)];
  }));

  await rm(CORE_DIRECTORY, { recursive: true, force: true });
  await mkdir(MODULE_DIRECTORY, { recursive: true });
  await writeFile(join(CORE_DIRECTORY, "package.json"), `${JSON.stringify({
    name: "@suzu-lives/agent-core-bundle",
    version: "0.1.0",
    private: true,
    type: "module",
  }, null, 2)}\n`);

  const bundle = await rolldown({
    input,
    external: (source) => isNodeExternal(source) || isNativeExternal(source) || isProductExternal(source),
    plugins: [coreBundlePlugin()],
    treeshake: true,
  });
  try {
    await bundle.write({
      dir: MODULE_DIRECTORY,
      format: "esm",
      sourcemap: false,
      entryFileNames: "[name].mjs",
      chunkFileNames: "chunks/[name]-[hash].mjs",
      exports: "named",
      banner: "import { createRequire as __suzuCreateRequire } from 'node:module'; const require = __suzuCreateRequire(import.meta.url);",
      minify: true,
    });
  } finally {
    await bundle.close();
  }

  for (const name of NATIVE_RUNTIME_PACKAGES) {
    const source = sources.get(name);
    if (source) await copyNativePackage(source);
  }
  await writeProductCoreBridge(entries);
  await mkdir(resolve(NATIVE_NODE_MODULES, "@suzu-lives", "agent-core-native"), { recursive: true });
  await writeFile(join(NATIVE_NODE_MODULES, "@suzu-lives", "agent-core-native", "package.json"), `${JSON.stringify({
    name: "@suzu-lives/agent-core-native",
    private: true,
    type: "module",
  }, null, 2)}\n`);

  await mkdir(OUTPUT_VENDOR_DIRECTORY, { recursive: true });
  await writeThirdPartyNotices(sources);
  const sizeBytes = await directorySize(CORE_DIRECTORY);
  const manifest = {
    format: "suzu-agent-core-bundle/v1",
    generatedAt: new Date().toISOString(),
    upstreamSnapshot: SNAPSHOT,
    sourceRoot: process.env.SUZU_AGENT_VENDOR_SOURCE ? "external-upstream-snapshot" : "development-workspace",
    moduleCount: entries.length,
    sourcePackageCount: sources.size,
    sizeBytes,
    modules: entries.map((entry) => ({
      id: entry.id,
      source: entry.sourcePackage,
      output: `vendor/core/modules/${entry.id}.mjs`,
    })),
    nativeRuntimePackages: NATIVE_RUNTIME_PACKAGES.map((name) => {
      const source = sources.get(name);
      return source ? { name, version: source.manifest.version } : { name, version: "missing" };
    }),
  };
  await writeFile(join(OUTPUT_VENDOR_DIRECTORY, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`Bundled ${entries.length} Suzu Agent Core modules from ${sources.size} audited source packages (${Math.round(sizeBytes / 1024 / 1024)} MiB runtime output).\n`);
}

main().catch((error) => {
  process.stderr.write(`bundle-agent-core: ${error?.stack || error}\n`);
  process.exitCode = 1;
});
