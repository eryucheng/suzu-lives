import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendUsageEvent } from "@suzu-lives/cost-ledger";
import { resolveUnpackedRuntimeAssetPath } from "./runtime-asset-path.mjs";

export class DirectVideoUnderstandingError extends Error {
  constructor(message, { exitCode = 4, stderr = "" } = {}) {
    super(message);
    this.name = "DirectVideoUnderstandingError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function requiredDataRoot(value) {
  const root = clean(value);
  if (!root) throw new DirectVideoUnderstandingError("缺少 Suzu Lives 软件数据目录。", { exitCode: 4 });
  return path.resolve(root);
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function bundledWorker() {
  return resolveUnpackedRuntimeAssetPath(fileURLToPath(new URL("../worker/video-understanding.py", import.meta.url)));
}

function defaultConfigPath(dataRoot) {
  return path.join(dataRoot, "capabilities", "video-understanding", "config.json");
}

export function resolveVideoUnderstandingConfigPath({ dataRoot, configPath = "" } = {}) {
  const root = requiredDataRoot(dataRoot);
  const requested = clean(configPath);
  const candidate = requested ? path.resolve(root, requested) : defaultConfigPath(root);
  if (!inside(root, candidate)) {
    throw new DirectVideoUnderstandingError("视频理解配置必须位于 Suzu Lives 软件数据目录内。", { exitCode: 4 });
  }
  return candidate;
}

function workerResult({ command, args, spawnImpl = spawn, environment }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const options = { stdio: ["ignore", "pipe", "pipe"], windowsHide: true };
      if (environment && typeof environment === "object") options.env = environment;
      child = spawnImpl(command, args, options);
    } catch (error) {
      reject(new DirectVideoUnderstandingError(`无法启动视频理解执行器：${clean(error?.message) || "未知错误"}`, { exitCode: 10 }));
      return;
    }
    const stdout = [];
    const stderr = [];
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(new DirectVideoUnderstandingError(`无法启动视频理解执行器：${clean(error?.message) || "未知错误"}`, { exitCode: 10 }));
    };
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.once("error", fail);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      resolve({
        code: Number(code ?? -1),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function parseWorkerEvents(stdout, { requireResult } = {}) {
  const usageEvents = [];
  let result;
  for (const line of String(stdout || "").split(/\r?\n/u)) {
    const source = line.trim();
    if (!source) continue;
    let event;
    try {
      event = JSON.parse(source);
    } catch {
      throw new DirectVideoUnderstandingError("视频理解执行器返回了无效事件。", { exitCode: 10 });
    }
    if (event?.type === "usage" && event.event && typeof event.event === "object" && !Array.isArray(event.event)) {
      usageEvents.push(event.event);
      continue;
    }
    if (event?.type === "result" && event.result && typeof event.result === "object" && !Array.isArray(event.result)) {
      result = event.result;
      continue;
    }
    throw new DirectVideoUnderstandingError("视频理解执行器返回了未知事件。", { exitCode: 10 });
  }
  if (requireResult && !result) throw new DirectVideoUnderstandingError("视频理解执行器没有返回稳定 JSON 结果。", { exitCode: 10 });
  return { result, usageEvents };
}

async function appendUsageEvents({ ledgerPath, agentId, usageEvents }) {
  const target = clean(ledgerPath);
  if (!target) throw new DirectVideoUnderstandingError("缺少 Suzu Lives 用量账本路径。", { exitCode: 10 });
  const identity = clean(agentId);
  for (const event of usageEvents) {
    try {
      await appendUsageEvent(target, { ...event, agentId: identity });
    } catch (error) {
      throw new DirectVideoUnderstandingError(`无法写入 Suzu Lives 用量账本：${clean(error?.message) || "未知错误"}`, { exitCode: 10 });
    }
  }
}

/**
 * Runs the software-owned video command without capability-registry or
 * authorization-token preconditions. The worker receives only software-owned
 * data paths and never receives a contact project path.
 */
export async function runDirectVideoUnderstanding({
  dataRoot,
  ledgerPath,
  agentId = "",
  videoPath,
  question = "",
  cacheKey = "",
  configPath = "",
  noCache = false,
  keepClip = false,
  dryRun = false,
  pythonCommand = process.env.SUZU_LIVES_PYTHON || process.env.PYTHON || "python",
  pythonArgs = [],
  spawnImpl = spawn,
  environment,
} = {}) {
  const root = requiredDataRoot(dataRoot);
  const video = clean(videoPath);
  if (!video) throw new DirectVideoUnderstandingError("视频路径或 URL 不能为空。", { exitCode: 4 });
  const config = resolveVideoUnderstandingConfigPath({ dataRoot: root, configPath });
  const command = clean(pythonCommand);
  if (!command) throw new DirectVideoUnderstandingError("缺少视频理解 Python 运行时。", { exitCode: 10 });
  const args = [
    ...pythonArgs.map((value) => String(value)),
    bundledWorker(),
    video,
    "--config", config,
    "--data-root", root,
    "--event-stream",
  ];
  if (question !== undefined && question !== null && String(question) !== "") args.push("--question", String(question));
  if (cacheKey !== undefined && cacheKey !== null && String(cacheKey) !== "") args.push("--cache-key", String(cacheKey));
  if (noCache === true) args.push("--no-cache");
  if (keepClip === true) args.push("--keep-clip");
  if (dryRun === true) args.push("--dry-run");

  const worker = await workerResult({ command, args, spawnImpl, environment });
  const parsed = parseWorkerEvents(worker.stdout, { requireResult: worker.code === 0 });
  await appendUsageEvents({ ledgerPath, agentId, usageEvents: parsed.usageEvents });
  if (worker.code !== 0) {
    const stderr = clean(worker.stderr) || `视频理解执行器退出（${worker.code}）。`;
    throw new DirectVideoUnderstandingError(stderr, { exitCode: worker.code > 0 ? worker.code : 10, stderr: `${stderr}\n` });
  }
  return parsed.result;
}
