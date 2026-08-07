import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSuzuLivesDataRoot } from "@suzu-lives/agent-registry";

export class ComputerCameraError extends Error {}

export const DEFAULT_ACTIVE_SECONDS = 10;
export const DEFAULT_WARMUP_SECONDS = 0.8;
export const LAUNCH_WAIT_MS = 4_000;

function clean(value) { return String(value ?? "").trim(); }
function requiredDataRoot(value) { const root = clean(value); if (!root) throw new ComputerCameraError("缺少 Suzu Lives 软件数据目录。"); return path.resolve(root); }
function finiteNumber(value, label, fallback) { if (value === undefined || value === null || value === "") return fallback; const number = Number(value); if (!Number.isFinite(number)) throw new ComputerCameraError(`${label}必须是有限数字。`); return number; }
function cameraIndex(value) { const number = Number(value); if (!Number.isInteger(number)) throw new ComputerCameraError("--camera-index 必须是整数。"); return number; }
function stamp(now = new Date()) { return now.toISOString().replace(/[:.]/gu, "-"); }
function workerPath() { return fileURLToPath(new URL("../worker/camera-worker.py", import.meta.url)); }
function fileExists(filePath) { try { return fs.statSync(filePath).isFile(); } catch { return false; } }
function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function writeJsonAtomic(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, filePath);
}

async function readJsonIfPresent(filePath) {
  try {
    const value = JSON.parse(await fsp.readFile(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw new ComputerCameraError(`无法读取摄像头运行状态：${error.message}`);
  }
}

function spawnDetachedWorker(command, args) {
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return child;
}

export function parseComputerCameraArgs(values = []) {
  const result = {};
  const options = new Set(["camera-index", "active-seconds", "warmup-seconds", "data-root"]);
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--") || !options.has(token.slice(2))) throw new ComputerCameraError(`未知选项：${token}`);
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) throw new ComputerCameraError(`${token} 缺少值。`);
    result[token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  return result;
}

export function computerCameraPaths({ dataRoot, now = () => new Date() } = {}) {
  const root = requiredDataRoot(dataRoot);
  const runtimeRoot = path.join(root, "capabilities", "computer-camera");
  const token = stamp(now());
  return { runtimeRoot, outputPath: path.join(runtimeRoot, "captures", `capture-${token}.jpg`), statusPath: path.join(runtimeRoot, "runtime", `capture-${token}.json`) };
}

export async function launchComputerCamera({
  dataRoot,
  cameraIndex: rawCameraIndex = 0,
  activeSeconds: rawActiveSeconds = DEFAULT_ACTIVE_SECONDS,
  warmupSeconds: rawWarmupSeconds = DEFAULT_WARMUP_SECONDS,
  pythonCommand = "python",
  spawnImpl = spawnDetachedWorker,
  readStatus = readJsonIfPresent,
  exists = fileExists,
  sleep = wait,
  now = () => new Date(),
  nowMs = () => Date.now(),
  launchWaitMs = LAUNCH_WAIT_MS,
} = {}) {
  const root = requiredDataRoot(dataRoot);
  const index = cameraIndex(rawCameraIndex);
  const activeSeconds = finiteNumber(rawActiveSeconds, "--active-seconds", DEFAULT_ACTIVE_SECONDS);
  const warmupSeconds = finiteNumber(rawWarmupSeconds, "--warmup-seconds", DEFAULT_WARMUP_SECONDS);
  if (activeSeconds < 0 || warmupSeconds < 0) throw new ComputerCameraError("--active-seconds 与 --warmup-seconds 不能小于 0。");
  const { runtimeRoot, outputPath, statusPath } = computerCameraPaths({ dataRoot: root, now });
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.mkdir(path.dirname(statusPath), { recursive: true });
  const args = [workerPath(), "--worker", "--output", outputPath, "--status-file", statusPath, "--camera-index", String(index), "--active-seconds", String(activeSeconds), "--warmup-seconds", String(warmupSeconds)];
  let child;
  try { child = spawnImpl(clean(pythonCommand) || "python", args); }
  catch (error) { throw new ComputerCameraError(`无法启动摄像头 worker：${clean(error?.message) || "未知错误"}`); }
  if (!child) throw new ComputerCameraError("无法启动摄像头 worker。");
  child.once?.("error", (error) => { writeJsonAtomic(statusPath, { status: "error", error: `无法启动摄像头 worker：${clean(error?.message) || "未知错误"}`, outputPath }).catch(() => undefined); });

  const deadline = nowMs() + Math.max(0, finiteNumber(launchWaitMs, "启动等待时间", LAUNCH_WAIT_MS));
  let workerStatus = null;
  while (nowMs() < deadline) {
    workerStatus = await readStatus(statusPath);
    if (workerStatus && ["captured", "closed", "error"].includes(clean(workerStatus.status))) break;
    if (exists(outputPath)) break;
    await sleep(80);
  }
  workerStatus ||= await readStatus(statusPath);
  if (clean(workerStatus?.status) === "error") return { status: "error", error: clean(workerStatus.error) || "摄像头 worker 失败。", outputPath, statusPath, cameraIndex: index };
  const ready = exists(outputPath);
  return {
    abilityId: "computer-camera",
    status: ready ? "captured" : "started",
    ready,
    outputPath,
    statusPath,
    cameraActiveSeconds: activeSeconds,
    background: true,
    noticeVisible: true,
    note: ready ? `照片已经写好；摄像头将在后台满 ${activeSeconds} 秒后自动关闭。` : "后台摄像头已经启动，但照片尚未在初始等待时间内写好。",
    runtimeDataRoot: runtimeRoot,
  };
}

export async function runComputerCameraCli(values, { environment = process.env, launch = launchComputerCamera } = {}) {
  const options = parseComputerCameraArgs(values);
  const dataRoot = resolveSuzuLivesDataRoot({ configuredRoot: options.dataRoot || environment.SUZU_LIVES_DATA_ROOT, localAppData: environment.LOCALAPPDATA, fallbackBase: "" });
  return launch({ dataRoot, cameraIndex: options.cameraIndex, activeSeconds: options.activeSeconds, warmupSeconds: options.warmupSeconds, pythonCommand: environment.SUZU_LIVES_PYTHON || environment.PYTHON || "python" });
}
