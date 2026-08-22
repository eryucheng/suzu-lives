import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDesktopStartupDiagnostics } from "./desktop-startup-diagnostics.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RENDERER_PORT = 5173;

function resolveRendererPort(value = process.env.SUZU_LIVES_DEV_PORT) {
  const raw = String(value ?? "").trim();
  if (!raw) return DEFAULT_RENDERER_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`SUZU_LIVES_DEV_PORT 必须是 1024 到 65535 之间的端口，当前值：${raw || "（空）"}`);
  }
  return port;
}

const rendererPort = resolveRendererPort();
const rendererUrl = `http://127.0.0.1:${rendererPort}`;
const require = createRequire(import.meta.url);
const viteCliPath = path.resolve(path.dirname(require.resolve("vite")), "..", "..", "bin", "vite.js");
const electronCliPath = require.resolve("electron/cli.js");
const startupDiagnostics = createDesktopStartupDiagnostics();

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function assertRendererPortAvailable(port) {
  const probe = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen({ host: "127.0.0.1", port }, resolve);
    });
  } catch (error) {
    if (error?.code === "EADDRINUSE") {
      throw new Error(`本地开发端口 ${port} 已被占用。请先关闭占用它的开发版，或设置另一个 SUZU_LIVES_DEV_PORT。`);
    }
    throw error;
  } finally {
    if (probe.listening) {
      await new Promise((resolve) => probe.close(resolve));
    }
  }
}

async function rendererIsReady(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.once("error", () => resolve(false));
    request.setTimeout(400, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForRenderer({ rendererUrl, viteProcess }) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (viteProcess.launchError) throw viteProcess.launchError;
    if (viteProcess.exitCode !== null) {
      throw new Error(`Vite 提前退出（${viteProcess.exitCode ?? "未知错误"}）。`);
    }
    if (await rendererIsReady(rendererUrl)) return;
    await delay(120);
  }
  throw new Error("本地界面在 20 秒内没有启动。请检查 Vite 输出。 ");
}

function stop(process) {
  if (process && process.exitCode === null && !process.killed) process.kill();
}

function errorDetails(error) {
  return {
    message: String(error?.message || error || "未知错误"),
    ...(error?.code ? { code: String(error.code) } : {}),
  };
}

function forwardOutput(child, label) {
  const streams = [
    [child?.stdout, process.stdout, "stdout"],
    [child?.stderr, process.stderr, "stderr"],
  ];
  for (const [stream, destination, kind] of streams) {
    if (!stream) continue;
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk) => {
      const output = String(chunk);
      startupDiagnostics.recordOutput(`${label}.${kind}`, output);
      destination.write(output);
    });
  }
}

async function ensureRuntimeFiles() {
  await Promise.all([
    fs.access(viteCliPath),
    fs.access(electronCliPath),
  ]);
}

async function main() {
  startupDiagnostics.record("launcher.start", { appRoot, rendererPort });
  await ensureRuntimeFiles();
  await assertRendererPortAvailable(rendererPort);
  let stopping = false;
  let electronProcess = null;
  const viteProcess = spawn(process.execPath, [
    viteCliPath,
    "--host", "127.0.0.1",
    "--port", String(rendererPort),
    "--strictPort",
  ], {
    cwd: appRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  startupDiagnostics.record("vite.spawned", { pid: viteProcess.pid || null });
  forwardOutput(viteProcess, "vite");
  viteProcess.once("error", (error) => {
    viteProcess.launchError = error;
    startupDiagnostics.record("vite.spawn-failed", errorDetails(error));
  });

  const stopAll = () => {
    if (stopping) return;
    stopping = true;
    stop(electronProcess);
    stop(viteProcess);
  };
  process.once("SIGINT", stopAll);
  process.once("SIGTERM", stopAll);

  viteProcess.once("exit", (code, signal) => {
    startupDiagnostics.record("vite.exit", { code, signal: signal || null });
    if (stopping) return;
    stopping = true;
    console.error(`本地界面服务已退出（${signal || code || "未知原因"}）。`);
    stop(electronProcess);
    process.exitCode = Number.isInteger(code) && code !== 0 ? code : 1;
  });

  try {
    await waitForRenderer({ rendererUrl, viteProcess });
    electronProcess = spawn(process.execPath, [electronCliPath, "."], {
      cwd: appRoot,
      env: {
        ...process.env,
        SUZU_LIVES_RENDERER_URL: rendererUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    startupDiagnostics.record("electron.spawned", { pid: electronProcess.pid || null });
    forwardOutput(electronProcess, "electron");
    const exitCode = await new Promise((resolve, reject) => {
      electronProcess.once("error", reject);
      electronProcess.once("exit", (code) => resolve(code));
    });
    startupDiagnostics.record("electron.exit", { code: exitCode });
    if (Number.isInteger(exitCode) && exitCode !== 0) process.exitCode = exitCode;
  } finally {
    stopAll();
    startupDiagnostics.record("launcher.stop", { exitCode: process.exitCode || 0 });
    await startupDiagnostics.flush();
  }
}

main().catch(async (error) => {
  startupDiagnostics.record("launcher.failed", errorDetails(error));
  await startupDiagnostics.flush();
  console.error(`无法启动 Suzu Lives：${error?.message || error}`);
  process.exitCode = 1;
});
