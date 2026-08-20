import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendUsageEvent } from "@suzu-lives/cost-ledger";
import { resolveUnpackedRuntimeAssetPath } from "./runtime-asset-path.mjs";

export class DirectImageVisionError extends Error {
  constructor(message, { exitCode = 4, stderr = "" } = {}) {
    super(message);
    this.name = "DirectImageVisionError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function requiredDataRoot(value) {
  const root = clean(value);
  if (!root) throw new DirectImageVisionError("缺少 Suzu Lives 软件数据目录。", { exitCode: 4 });
  return path.resolve(root);
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function bundledWorker() {
  return resolveUnpackedRuntimeAssetPath(fileURLToPath(new URL("../worker/image-vision.py", import.meta.url)));
}

function defaultConfigPath(dataRoot) {
  return path.join(dataRoot, "capabilities", "image-vision", "config.json");
}

export function resolveImageVisionConfigPath({ dataRoot, configPath = "" } = {}) {
  const root = requiredDataRoot(dataRoot);
  const requested = clean(configPath);
  const candidate = requested ? path.resolve(root, requested) : defaultConfigPath(root);
  if (!inside(root, candidate)) {
    throw new DirectImageVisionError("图像理解配置必须位于 Suzu Lives 软件数据目录内。", { exitCode: 4 });
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
      reject(new DirectImageVisionError(`无法启动图像理解执行器：${clean(error?.message) || "未知错误"}`, { exitCode: 10 }));
      return;
    }
    const stdout = [];
    const stderr = [];
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(new DirectImageVisionError(`无法启动图像理解执行器：${clean(error?.message) || "未知错误"}`, { exitCode: 10 }));
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
  let answer = "";
  for (const line of String(stdout || "").split(/\r?\n/u)) {
    const source = line.trim();
    if (!source) continue;
    let event;
    try {
      event = JSON.parse(source);
    } catch {
      throw new DirectImageVisionError("图像理解执行器返回了无效事件。", { exitCode: 10 });
    }
    if (event?.type === "usage" && event.event && typeof event.event === "object" && !Array.isArray(event.event)) {
      usageEvents.push(event.event);
      continue;
    }
    if (event?.type === "result" && typeof event.answer === "string") {
      answer = event.answer.trim();
      continue;
    }
    throw new DirectImageVisionError("图像理解执行器返回了未知事件。", { exitCode: 10 });
  }
  if (requireResult && !answer) throw new DirectImageVisionError("图像理解执行器没有返回可用结果。", { exitCode: 10 });
  return { answer, usageEvents };
}

async function appendUsageEvents({ ledgerPath, agentId, usageEvents }) {
  const target = clean(ledgerPath);
  if (!target) throw new DirectImageVisionError("缺少 Suzu Lives 用量账本路径。", { exitCode: 10 });
  const identity = clean(agentId);
  for (const event of usageEvents) {
    try {
      await appendUsageEvent(target, { ...event, agentId: identity });
    } catch (error) {
      throw new DirectImageVisionError(`无法写入 Suzu Lives 用量账本：${clean(error?.message) || "未知错误"}`, { exitCode: 10 });
    }
  }
}

/**
 * Runs the direct vision command without capability-registry or
 * authorization-token preconditions. The caller supplies only software-owned
 * data and ledger paths; the worker never sees a contact project path.
 */
export async function runDirectImageVision({
  dataRoot,
  ledgerPath,
  agentId = "",
  imagePath,
  question = "",
  configPath = "",
  noRetry = false,
  pythonCommand = process.env.SUZU_LIVES_PYTHON || process.env.PYTHON || "python",
  pythonArgs = [],
  spawnImpl = spawn,
  environment,
} = {}) {
  const root = requiredDataRoot(dataRoot);
  const image = clean(imagePath);
  if (!image) throw new DirectImageVisionError("图片路径不能为空。", { exitCode: 4 });
  const config = resolveImageVisionConfigPath({ dataRoot: root, configPath });
  const command = clean(pythonCommand);
  if (!command) throw new DirectImageVisionError("缺少图像理解 Python 运行时。", { exitCode: 10 });
  const args = [
    ...pythonArgs.map((value) => String(value)),
    bundledWorker(),
    image,
    "--config", config,
    "--data-root", root,
    "--event-stream",
  ];
  if (question !== undefined && question !== null && String(question) !== "") args.push("--question", String(question));
  if (noRetry === true) args.push("--no-retry");

  const worker = await workerResult({ command, args, spawnImpl, environment });
  const parsed = parseWorkerEvents(worker.stdout, { requireResult: worker.code === 0 });
  await appendUsageEvents({ ledgerPath, agentId, usageEvents: parsed.usageEvents });
  if (worker.code !== 0) {
    const stderr = clean(worker.stderr) || `VISION_ERROR：图像理解执行器退出（${worker.code}）。`;
    throw new DirectImageVisionError(stderr, { exitCode: worker.code > 0 ? worker.code : 10, stderr: `${stderr}\n` });
  }
  return {
    abilityId: "image-vision",
    status: "ok",
    answer: parsed.answer,
    configPath: config,
    runtimeDataRoot: path.join(root, "capabilities", "image-vision"),
    usageEventCount: parsed.usageEvents.length,
  };
}
