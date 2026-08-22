const fs = require("node:fs/promises");
const path = require("node:path");

const REQUIRED_AGENT_CORE_RUNTIME_FILES = [
  ["agent-core-native/node_modules/@suzu-lives/agent-core-native/package.json", "Agent Core native runtime anchor"],
  ["agent-core-native/node_modules/sharp/dist/index.mjs", "sharp image runtime"],
  ["agent-core-native/node_modules/node-pty/prebuilds/win32-x64/conpty.node", "node-pty Windows runtime"],
  ["agent-core-native/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node", "koffi Windows runtime"],
  ["app.asar.unpacked/node_modules/@suzu-lives/suzu-agent-runtime/vendor/core/modules/attachment-local.mjs", "Agent Core attachment module"],
  ["app.asar.unpacked/node_modules/@suzu-lives/suzu-agent-runtime/src/embedded-module-loader.mjs", "Agent Core module loader"],
];

function packageTypeForTargets(targets = []) {
  const names = [...new Set((targets || [])
    .map((target) => String(target?.name || "").trim().toLowerCase())
    .filter(Boolean))];
  if (names.length !== 1) {
    throw new Error("一次 Suzu Windows 打包只能生成一种分发目标，无法安全写入 package-type。");
  }
  if (names[0] === "nsis" || names[0] === "zip") return names[0];
  return "manual";
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function verifyPackagedAgentCoreRuntime(resourcesPath) {
  const missing = [];
  for (const [relativePath, label] of REQUIRED_AGENT_CORE_RUNTIME_FILES) {
    if (!await fileExists(path.join(resourcesPath, ...relativePath.split("/")))) missing.push(label);
  }

  const sharpNativeDirectory = path.join(
    resourcesPath,
    "agent-core-native",
    "node_modules",
    "@img",
    "sharp-win32-x64",
    "lib",
  );
  let sharpNativeFiles = [];
  try {
    sharpNativeFiles = await fs.readdir(sharpNativeDirectory);
  } catch {
    // The missing package is reported below with the same actionable build error.
  }
  if (!sharpNativeFiles.some((fileName) => /^sharp-win32-x64-.+\.node$/iu.test(fileName))) {
    missing.push("sharp Windows native binary");
  }

  if (missing.length > 0) {
    throw new Error(
      `Suzu Agent Core 打包依赖缺失：${missing.join("；")}。停止生成安装包，避免发布后运行时缺少原生模块。`,
    );
  }
}

async function afterPack(context = {}) {
  if (context.electronPlatformName !== "win32") return;
  const appOutDir = String(context.appOutDir || "").trim();
  if (!appOutDir) throw new Error("electron-builder 未提供 appOutDir，无法写入 package-type。");
  const resourcesPath = path.join(appOutDir, "resources");
  await verifyPackagedAgentCoreRuntime(resourcesPath);
  await fs.writeFile(path.join(resourcesPath, "package-type"), `${packageTypeForTargets(context.targets)}\n`, "utf8");
}

exports.default = afterPack;
exports.packageTypeForTargets = packageTypeForTargets;
exports.verifyPackagedAgentCoreRuntime = verifyPackagedAgentCoreRuntime;
