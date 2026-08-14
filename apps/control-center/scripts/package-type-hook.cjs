const fs = require("node:fs/promises");
const path = require("node:path");

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

async function afterPack(context = {}) {
  if (context.electronPlatformName !== "win32") return;
  const appOutDir = String(context.appOutDir || "").trim();
  if (!appOutDir) throw new Error("electron-builder 未提供 appOutDir，无法写入 package-type。");
  const resourcesPath = path.join(appOutDir, "resources");
  await fs.mkdir(resourcesPath, { recursive: true });
  await fs.writeFile(path.join(resourcesPath, "package-type"), `${packageTypeForTargets(context.targets)}\n`, "utf8");
}

exports.default = afterPack;
exports.packageTypeForTargets = packageTypeForTargets;
