import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CapabilityExecutionError, assertInvocationGate, assertVerifiedCapabilityAuthorization } from "@suzu-lives/capability-runtime";

export class DeviceBridgeError extends Error {}

const activeCameraSessions = new Map();

function clean(value) {
  return String(value ?? "").trim();
}
function dataRoot(value) {
  const root = clean(value);
  if (!root) throw new DeviceBridgeError("缺少 Suzu Lives 软件数据目录。");
  return path.resolve(root);
}

function nonNegativeInteger(value, label, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 32) throw new DeviceBridgeError(`${label}必须是 0 到 32 的整数。`);
  return number;
}

function bounded(value, label, maximum) {
  const text = clean(value);
  if (!text || text.length > maximum) throw new DeviceBridgeError(`${label}不能为空，且最多 ${maximum} 个字符。`);
  return text;
}

function boundedNumber(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER, fallback = 0 } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new DeviceBridgeError(`${label}必须在 ${minimum} 到 ${maximum} 之间。`);
  return number;
}

function deviceRuntimeRoot(root, abilityId) {
  return path.join(dataRoot(root), "capabilities", abilityId);
}

function safeStamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/gu, "-");
}

function safeSessionId(value) {
  const id = clean(value || randomUUID()).replace(/[^a-z0-9_-]/giu, "");
  if (!id) throw new DeviceBridgeError("无法生成摄像头会话标识。 ");
  return id.slice(0, 100);
}

async function writeJsonAtomic(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, filePath);
}

async function readJsonIfPresent(filePath, fallback = {}) {
  try {
    const parsed = JSON.parse(await fsp.readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw new DeviceBridgeError(`无法读取软件管理的设备状态：${error.message}`);
  }
}

function bundledCameraWorker() {
  return fileURLToPath(new URL("../worker/camera-worker.py", import.meta.url));
}

function executeProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const output = { code: Number(code ?? -1), stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (output.code === 0) resolve(output);
      else reject(new DeviceBridgeError(`设备执行器失败（${output.code}）：${(output.stderr || output.stdout).slice(-1200)}`));
    });
  });
}

async function probeCameraRuntime({ pythonCommand, runProcess = executeProcess }) {
  await runProcess(pythonCommand, ["-c", "import cv2"]);
  return true;
}

function cameraSessionKey(root, cameraIndex) {
  return `${dataRoot(root)}\u0000${cameraIndex}`;
}

function cameraStatePath(root) {
  return path.join(deviceRuntimeRoot(root, "computer-camera"), "state.json");
}

function cameraCapturePath(root, now) {
  return path.join(deviceRuntimeRoot(root, "computer-camera"), "captures", `capture-${safeStamp(now())}.jpg`);
}

function assertCameraAuthorization(authorization, invocation, action) {
  assertVerifiedCapabilityAuthorization({
    authorization,
    abilityId: "computer-camera",
    action,
    scope: invocation?.scope,
  });
}

function parseWorkerLine(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Starts the bundled long-lived worker. The worker retains the physical
 * camera after warmup and only closes when the software sends a close command.
 */
function startNativeCameraSession({ pythonCommand, cameraIndex, warmupSeconds, statusPath, onUnexpectedEnd = () => undefined, startupTimeoutMs = 20_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonCommand, [
      bundledCameraWorker(),
      "--session",
      "--status-file", statusPath,
      "--camera-index", String(cameraIndex),
      "--warmup-seconds", String(warmupSeconds),
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const pending = new Map();
    const stderr = [];
    let stdoutBuffer = "";
    let ready = false;
    let closing = false;
    let settled = false;
    const fail = (error) => {
      if (!settled) {
        settled = true;
        if (!ready && !child.killed) {
          try { child.kill(); } catch { /* The close handler records the failed lifecycle. */ }
        }
        reject(error instanceof Error ? error : new DeviceBridgeError(String(error)));
      }
    };
    const startupTimer = setTimeout(() => fail(new DeviceBridgeError("摄像头 worker 预热超时。")), startupTimeoutMs);
    const settleRequest = (message) => {
      const request = pending.get(clean(message.id));
      if (!request) return;
      pending.delete(clean(message.id));
      if (message.status === "error") request.reject(new DeviceBridgeError(`摄像头 worker 失败：${clean(message.error) || "未知错误"}`));
      else request.resolve(message);
    };
    const send = (command, fields = {}) => new Promise((resolveRequest, rejectRequest) => {
      if (!ready || child.killed || !child.stdin.writable) {
        rejectRequest(new DeviceBridgeError("摄像头会话未处于可操作状态。"));
        return;
      }
      const id = safeSessionId();
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      child.stdin.write(`${JSON.stringify({ id, command, ...fields })}\n`, "utf8", (error) => {
        if (!error) return;
        pending.delete(id);
        rejectRequest(new DeviceBridgeError(`无法向摄像头 worker 发送命令：${clean(error.message) || "未知错误"}`));
      });
    });
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/u);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        const message = parseWorkerLine(line);
        if (!message) continue;
        if (message.status === "ready" && !ready) {
          ready = true;
          clearTimeout(startupTimer);
          if (!settled) {
            settled = true;
            resolve({
              capture: ({ outputPath }) => send("capture", { outputPath }),
              close: async () => {
                closing = true;
                const message = await send("close");
                return message;
              },
              process: { pid: child.pid || 0 },
            });
          }
          continue;
        }
        settleRequest(message);
      }
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => fail(new DeviceBridgeError(`摄像头 worker 无法启动：${clean(error?.message) || "未知错误"}`)));
    child.once("close", (code) => {
      clearTimeout(startupTimer);
      const detail = clean(Buffer.concat(stderr).toString("utf8")).slice(-1200);
      const error = new DeviceBridgeError(`摄像头 worker 已退出（${Number(code ?? -1)}）：${detail || "状态未知"}`);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      if (!ready) fail(error);
      else if (!closing) Promise.resolve(onUnexpectedEnd(error)).catch(() => undefined);
    });
  });
}

export function planComputerCameraCapture({ dataRoot: root, cameraIndex = 0, requestedBy = "", operation = "capture" } = {}) {
  const runtimeDataRoot = deviceRuntimeRoot(root, "computer-camera");
  const captureIndex = nonNegativeInteger(cameraIndex, "摄像头编号");
  const normalizedOperation = clean(operation || "capture").toLowerCase();
  return {
    abilityId: "computer-camera",
    status: "requires-device-authorization",
    operation: normalizedOperation,
    cameraIndex: captureIndex,
    requestedBy: clean(requestedBy).slice(0, 120),
    runtimeDataRoot,
    statePath: cameraStatePath(root),
    plannedOutputPath: path.join(runtimeDataRoot, "captures", `capture-${safeStamp()}.jpg`),
    willOpenCamera: false,
    willShowNotice: false,
    nextRequirement: "开启会先预热并保持软件拥有的摄像头会话；拍摄与用户确认关闭均需独立的单次软件授权。",
  };
}

/** Start and warm a persistent camera session after a start-session credential. */
export async function executeComputerCameraSession({
  dataRoot: root,
  gate,
  configuration = {},
  authorization,
  invocation,
  cameraIndex = 0,
  warmupSeconds = 0.8,
  dependencyProbe,
  sessionFactory = startNativeCameraSession,
  runProcess,
  now = () => new Date(),
  randomId = randomUUID,
} = {}) {
  assertInvocationGate({ abilityId: "computer-camera", gate, dependencies: {} });
  assertCameraAuthorization(authorization, invocation, "start-session");
  const pythonCommand = bounded(configuration.pythonCommand, "摄像头 Python 运行时", 500);
  const camera = nonNegativeInteger(cameraIndex, "摄像头编号");
  const warmup = boundedNumber(warmupSeconds, "摄像头预热时间", { minimum: 0, maximum: 30, fallback: 0.8 });
  assertInvocationGate({ abilityId: "computer-camera", gate, dependencies: { "摄像头会话执行器": typeof sessionFactory === "function" } });
  const available = dependencyProbe ? await dependencyProbe({ pythonCommand }) : await probeCameraRuntime({ pythonCommand, runProcess });
  assertInvocationGate({ abilityId: "computer-camera", gate, dependencies: { "OpenCV 运行时": available === true } });
  const key = cameraSessionKey(root, camera);
  if (activeCameraSessions.has(key)) throw new CapabilityExecutionError("CAMERA_SESSION_ACTIVE", "该摄像头已由 Suzu Lives 会话持有，不能重复开启。", { abilityId: "computer-camera", cameraIndex: camera });
  const sessionId = safeSessionId(randomId());
  const statePath = cameraStatePath(root);
  const baseState = { abilityId: "computer-camera", sessionId, cameraIndex: camera, startedAt: now().toISOString() };
  await writeJsonAtomic(statePath, { ...baseState, status: "starting", warmupSeconds: warmup });
  const markUnexpectedFailure = async (error) => {
    activeCameraSessions.delete(key);
    await writeJsonAtomic(statePath, { ...baseState, status: "failed", failedAt: now().toISOString(), error: clean(error?.message).slice(0, 500) || "camera worker stopped" });
  };
  try {
    const session = await sessionFactory({ pythonCommand, cameraIndex: camera, warmupSeconds: warmup, statusPath: statePath, sessionId, onUnexpectedEnd: markUnexpectedFailure, runProcess });
    if (!session || typeof session.capture !== "function" || typeof session.close !== "function") throw new DeviceBridgeError("摄像头会话执行器没有提供 capture/close 接口。 ");
    const readyAt = now().toISOString();
    const readyState = { ...baseState, warmedAt: readyAt, warmupSeconds: warmup };
    activeCameraSessions.set(key, { sessionId, session, cameraIndex: camera, statePath, baseState: readyState });
    await writeJsonAtomic(statePath, { ...readyState, status: "ready" });
    return { abilityId: "computer-camera", status: "ready", sessionId, cameraIndex: camera, statePath, warmedAt: readyAt, process: session.process };
  } catch (error) {
    await markUnexpectedFailure(error);
    throw error;
  }
}
/** Capture, inspect, or explicitly close the persistent session. */
export async function executeComputerCameraCapture({
  dataRoot: root,
  gate,
  authorization,
  invocation,
  cameraIndex = 0,
  operation = "capture",
  now = () => new Date(),
} = {}) {
  assertInvocationGate({ abilityId: "computer-camera", gate, dependencies: {} });
  const camera = nonNegativeInteger(cameraIndex, "摄像头编号");
  const normalizedOperation = clean(operation || "capture").toLowerCase();
  const action = normalizedOperation === "close" ? "close-session" : normalizedOperation === "status" ? "read-status" : "capture";
  if (!new Set(["capture", "close", "status"]).has(normalizedOperation)) throw new DeviceBridgeError("电脑摄像头操作只能是 capture、close 或 status。 ");
  assertCameraAuthorization(authorization, invocation, action);
  const statePath = cameraStatePath(root);
  if (normalizedOperation === "status") {
    const state = await readJsonIfPresent(statePath, { status: "not-started" });
    return { abilityId: "computer-camera", status: "ok", cameraIndex: camera, statePath, cameraState: state };
  }
  const key = cameraSessionKey(root, camera);
  const active = activeCameraSessions.get(key);
  if (!active) throw new CapabilityExecutionError("CAMERA_SESSION_NOT_READY", "摄像头尚未完成预热会话；请先在 Suzu Lives 中开启。", { abilityId: "computer-camera", cameraIndex: camera });
  if (normalizedOperation === "close") {
    const closingAt = now().toISOString();
    await writeJsonAtomic(statePath, { ...active.baseState, status: "closing", closeRequestedAt: closingAt, userConfirmedClose: true });
    try {
      const worker = await active.session.close();
      activeCameraSessions.delete(key);
      const closedAt = now().toISOString();
      await writeJsonAtomic(statePath, { ...active.baseState, status: "closed", closeRequestedAt: closingAt, closedAt, userConfirmedClose: true });
      return { abilityId: "computer-camera", status: "closed", sessionId: active.sessionId, cameraIndex: camera, statePath, userConfirmedClose: true, worker };
    } catch (error) {
      await writeJsonAtomic(statePath, { ...active.baseState, status: "failed", failedAt: now().toISOString(), closeRequestedAt: closingAt, userConfirmedClose: true, error: clean(error?.message).slice(0, 500) || "camera close failed" });
      throw error;
    }
  }
  const outputPath = cameraCapturePath(root, now);
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await writeJsonAtomic(statePath, { ...active.baseState, status: "capturing", captureStartedAt: now().toISOString(), outputPath });
  try {
    const worker = await active.session.capture({ outputPath });
    if (worker?.status !== "captured" || !fs.existsSync(outputPath)) {
      throw new DeviceBridgeError("摄像头会话没有确认写入照片。 ");
    }
    const capturedAt = now().toISOString();
    await writeJsonAtomic(statePath, { ...active.baseState, status: "ready", warmedAt: active.baseState.warmedAt, lastCapturePath: outputPath, capturedAt });
    return { abilityId: "computer-camera", status: "ok", sessionId: active.sessionId, cameraIndex: camera, outputPath, statePath, capture: worker };
  } catch (error) {
    await writeJsonAtomic(statePath, { ...active.baseState, status: "failed", failedAt: now().toISOString(), error: clean(error?.message).slice(0, 500) || "camera capture failed" });
    throw error;
  }
}
