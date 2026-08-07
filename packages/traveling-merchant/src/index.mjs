import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSuzuLivesDataRoot } from "@suzu-lives/agent-registry";
import defaultConfig from "../resources/config.example.json" with { type: "json" };

export const TRAVELING_MERCHANT_ID = "traveling-merchant";
export const TRAVELING_MERCHANT_NAME = "远行商人监控";

export function travelingMerchantDefaultConfig() {
  return JSON.parse(JSON.stringify(defaultConfig));
}

export class TravelingMerchantError extends Error {
  constructor(message, { exitCode = 4 } = {}) {
    super(message);
    this.name = "TravelingMerchantError";
    this.exitCode = exitCode;
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function requiredValue(values, index, option) {
  const next = values[index + 1];
  if (!next || next.startsWith("--")) throw new TravelingMerchantError(`选项 ${option} 缺少值。`);
  return next;
}

export function parseTravelingMerchantArgs(values = []) {
  const parsed = {
    dryRun: false,
    force: false,
    fixture: "",
    testNotification: false,
    configPath: "",
    dataRoot: "",
  };
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const value = String(values[index]);
    if (!value.startsWith("--")) throw new TravelingMerchantError(`远行商人监控不接受位置参数：${value}`);
    if (seen.has(value)) throw new TravelingMerchantError(`选项 ${value} 只能指定一次。`);
    seen.add(value);
    if (value === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (value === "--force") {
      parsed.force = true;
      continue;
    }
    if (value === "--test-notification") {
      parsed.testNotification = true;
      continue;
    }
    if (value === "--fixture" || value === "--config" || value === "--data-root") {
      const next = requiredValue(values, index, value);
      if (value === "--fixture") parsed.fixture = next;
      if (value === "--config") parsed.configPath = next;
      if (value === "--data-root") parsed.dataRoot = next;
      index += 1;
      continue;
    }
    throw new TravelingMerchantError(`远行商人监控不支持选项 ${value}。`);
  }
  return parsed;
}

function resolveDataRoot({ requestedRoot, environment }) {
  try {
    return resolveSuzuLivesDataRoot({
      configuredRoot: clean(requestedRoot) || clean(environment?.SUZU_LIVES_DATA_ROOT),
      localAppData: clean(environment?.LOCALAPPDATA),
      fallbackBase: "",
    });
  } catch (error) {
    throw new TravelingMerchantError(clean(error?.message) || "无法定位 Suzu Lives 软件数据目录。");
  }
}

export function resolveTravelingMerchantConfigPath({ dataRoot, configPath = "" } = {}) {
  const root = clean(dataRoot);
  if (!root) throw new TravelingMerchantError("缺少 Suzu Lives 软件数据目录。");
  const requested = clean(configPath);
  if (!requested) return "";
  const candidate = path.resolve(root, requested);
  if (!inside(root, candidate)) {
    throw new TravelingMerchantError("远行商人配置必须位于 Suzu Lives 软件数据目录内。");
  }
  return candidate;
}

function bundledWorker() {
  const unpacked = process.resourcesPath
    ? path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "@suzu-lives", "traveling-merchant", "worker", "merchant_check.py")
    : "";
  if (unpacked && existsSync(unpacked)) return unpacked;
  return fileURLToPath(new URL("../worker/merchant_check.py", import.meta.url));
}

/**
 * Starts the software-owned Python worker. Its stdout/stderr is intentionally
 * passed through by the stable CLI so its JSON contract stays intact.
 */
export function runTravelingMerchantCli(values, {
  environment = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  const parsed = parseTravelingMerchantArgs(values);
  const dataRoot = path.resolve(resolveDataRoot({ requestedRoot: parsed.dataRoot, environment }));
  const configPath = resolveTravelingMerchantConfigPath({ dataRoot, configPath: parsed.configPath });
  const pythonCommand = clean(environment?.SUZU_LIVES_PYTHON) || clean(environment?.PYTHON) || "python";
  const args = [bundledWorker(), "--data-root", dataRoot];
  if (configPath) args.push("--config", configPath);
  if (parsed.dryRun) args.push("--dry-run");
  if (parsed.force) args.push("--force");
  if (parsed.fixture) args.push("--fixture", parsed.fixture);
  if (parsed.testNotification) args.push("--test-notification");
  const result = spawnSyncImpl(pythonCommand, args, {
    encoding: "utf8",
    windowsHide: true,
    env: environment,
  });
  if (result?.error) {
    throw new TravelingMerchantError(`无法启动远行商人执行器：${clean(result.error.message) || "未知错误"}`, { exitCode: 10 });
  }
  return {
    code: Number.isInteger(result?.status) ? result.status : 1,
    stdout: String(result?.stdout || ""),
    stderr: String(result?.stderr || ""),
    dataRoot,
  };
}

/** Runs the existing software-owned worker without blocking the Electron main process. */
export async function runTravelingMerchant(values, {
  environment = process.env,
  spawnImpl = spawn,
} = {}) {
  const parsed = parseTravelingMerchantArgs(values);
  const dataRoot = path.resolve(resolveDataRoot({ requestedRoot: parsed.dataRoot, environment }));
  const configPath = resolveTravelingMerchantConfigPath({ dataRoot, configPath: parsed.configPath });
  const pythonCommand = clean(environment?.SUZU_LIVES_PYTHON) || clean(environment?.PYTHON) || "python";
  const args = [bundledWorker(), "--data-root", dataRoot];
  if (configPath) args.push("--config", configPath);
  if (parsed.dryRun) args.push("--dry-run");
  if (parsed.force) args.push("--force");
  if (parsed.fixture) args.push("--fixture", parsed.fixture);
  if (parsed.testNotification) args.push("--test-notification");
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(pythonCommand, args, { windowsHide: true, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new TravelingMerchantError(`无法启动远行商人执行器：${clean(error?.message) || "未知错误"}`, { exitCode: 10 }));
      return;
    }
    if (!child) {
      reject(new TravelingMerchantError("无法启动远行商人执行器。", { exitCode: 10 }));
      return;
    }
    const stdout = [];
    const stderr = [];
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    child.stdout?.on?.("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on?.("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once?.("error", (error) => {
      settle(reject, new TravelingMerchantError(`无法启动远行商人执行器：${clean(error?.message) || "未知错误"}`, { exitCode: 10 }));
    });
    child.once?.("close", (code) => {
      settle(resolve, {
        code: Number.isInteger(code) ? code : 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        dataRoot,
      });
    });
  });
}

export function renderTravelingMerchantSkill(launcher = "suzu-lives") {
  return `---
name: suzu-lives-traveling-merchant
description: 通过 Suzu Lives 检查洛克王国远行商人页面；Suzu 自动任务负责循环执行并向已开启的会话投递结果。
---

<!-- suzu-lives:ability:traveling-merchant -->
# 洛克王国远行商人监控

这是 Suzu Lives 生成的轻量注册文件，不包含功能源码、安装路径、配置、缓存或凭据。

稳定命令为：

\`${launcher} traveling-merchant [--dry-run] [--force] [--fixture '<本地 HTML>'] [--test-notification]\`

它只读取网页真实商品节点 \`.shop_name\`，不会把宣传文字当作在售商品。正式命中目标物品时，执行器只返回投递内容；Suzu 会把内容分别交给“远行商人”能力中已开启的会话处理和投递。

每次正式运行命中都会准备投递；\`--dry-run\` 只检查不准备投递也不写状态。\`--fixture '<本地 HTML>'\` 仅用于解析检查，不访问网页；可配合 \`--dry-run\` 完成无副作用测试。\`--test-notification\` 只生成测试投递内容，不请求页面。

软件运行状态只写入自身数据目录。可用 \`--config '<软件数据目录内的配置>'\` 选择软件侧覆盖配置；不要把配置或状态放入 Claude 项目。

## 设置自动任务

在 Suzu 的直连会话中，系统提示会给出带软件数据目录的 schedule 命令。先按需要查看并删除旧任务：

\`\`\`powershell
suzu-lives schedule list
suzu-lives schedule remove <旧任务ID>
\`\`\`

再让 Suzu 在每天四个售卖时段开始后第 2 分钟执行稳定入口：

\`\`\`powershell
${launcher} schedule add --cron "2 8,12,16,20 * * *" --exec traveling-merchant --desc "洛克王国远行商人监控"
\`\`\`

Suzu 关闭期间不会执行或补跑自动任务。不要写死项目名、微信 ID、sessionKey 或凭据。
`;
}
