import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererPort = 5173;
const rendererUrl = `http://127.0.0.1:${rendererPort}`;
const require = createRequire(import.meta.url);
const viteCliPath = path.resolve(path.dirname(require.resolve("vite")), "..", "..", "bin", "vite.js");
const electronCliPath = require.resolve("electron/cli.js");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

async function ensureRuntimeFiles() {
  await Promise.all([
    fs.access(viteCliPath),
    fs.access(electronCliPath),
  ]);
}

async function main() {
  await ensureRuntimeFiles();
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
    stdio: "inherit",
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
      stdio: "inherit",
    });
    await new Promise((resolve, reject) => {
      electronProcess.once("error", reject);
      electronProcess.once("exit", (code) => resolve(code));
    });
  } finally {
    stopAll();
  }
}

main().catch((error) => {
  console.error(`无法启动 Suzu Lives：${error?.message || error}`);
  process.exitCode = 1;
});
