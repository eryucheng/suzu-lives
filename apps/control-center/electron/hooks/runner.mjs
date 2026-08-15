import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runProjectHookCli } from "./runtime.mjs";

const MEMORY_WORKER_ARGUMENT = "--suzu-lives-memory-hook-worker";
const MEMORY_WORKER_TIMEOUT_MS = 12_000;
const MEMORY_WORKER_DIRECTORY_PREFIX = "suzu-lives-memory-hook-";
const MEMORY_WORKER_INPUT_FILE = "payload.json";
const MEMORY_WORKER_OUTPUT_FILE = "result.json";
const MAX_HOOK_INPUT_LENGTH = 256 * 1024;

function writeOutput(stdout, value) {
  return new Promise((resolve, reject) => {
    try {
      stdout.write(value, (error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function readInput(stdin) {
  let input = "";
  for await (const chunk of stdin) {
    input += String(chunk);
    if (input.length > MAX_HOOK_INPUT_LENGTH) throw new Error("Hook 输入过大。");
  }
  return input;
}

function packagedRunner(value) {
  return /(?:^|[\\/])app\.asar(?:[\\/]|$)/iu.test(path.resolve(value));
}

function workerArguments({ runnerPath, envelopePath }) {
  const runner = path.resolve(runnerPath);
  const appRoot = path.resolve(path.dirname(runner), "..", "..");
  return [
    ...(packagedRunner(runner) ? [] : [appRoot]),
    MEMORY_WORKER_ARGUMENT,
    envelopePath,
  ];
}

function waitForWorker(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* The worker may already have exited. */ }
      finish(reject, new Error("记忆 Hook 工作进程超时。"));
    }, timeoutMs);
    child.once("error", (error) => finish(reject, error));
    child.once("close", (code, signal) => {
      if (code === 0 && !signal) finish(resolve);
      else finish(reject, new Error("记忆 Hook 工作进程未正常退出。"));
    });
  });
}

async function removeWorkerFiles(fsOps, directory, inputPath, outputPath) {
  await fsOps.unlink(outputPath).catch(() => undefined);
  await fsOps.unlink(inputPath).catch(() => undefined);
  await fsOps.rmdir(directory).catch(() => undefined);
}

/**
 * Runs under ELECTRON_RUN_AS_NODE so Claude's stdin stays available. The
 * actual retrieval runs in one short normal-Electron child because only that
 * process can decrypt the user's saved memory-embedding credential.
 */
export async function runMemoryRecallHookCli({
  args = [],
  stdin = process.stdin,
  stdout = process.stdout,
  executablePath = process.execPath,
  runnerPath = fileURLToPath(import.meta.url),
  spawnImpl = spawn,
  fsOps = fs,
  temporaryRoot = os.tmpdir(),
  timeoutMs = MEMORY_WORKER_TIMEOUT_MS,
} = {}) {
  let directory = "";
  let inputPath = "";
  let outputPath = "";
  try {
    const input = await readInput(stdin);
    const root = path.resolve(temporaryRoot);
    directory = await fsOps.mkdtemp(path.join(root, MEMORY_WORKER_DIRECTORY_PREFIX));
    inputPath = path.join(directory, MEMORY_WORKER_INPUT_FILE);
    outputPath = path.join(directory, MEMORY_WORKER_OUTPUT_FILE);
    await fsOps.writeFile(inputPath, JSON.stringify({
      args: Array.isArray(args) ? args : [],
      input,
      outputPath,
    }), { encoding: "utf8", flag: "wx" });

    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawnImpl(executablePath, workerArguments({ runnerPath, envelopePath: inputPath }), {
      cwd: packagedRunner(runnerPath) ? undefined : path.resolve(path.dirname(runnerPath), "..", ".."),
      env: environment,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    await waitForWorker(child, timeoutMs);
    const result = JSON.parse(await fsOps.readFile(outputPath, "utf8"));
    if (typeof result?.output === "string" && result.output.length <= MAX_HOOK_INPUT_LENGTH) {
      await writeOutput(stdout, result.output);
    }
  } catch {
    // Command Hooks fail open and never write diagnostics to stdout.
  } finally {
    if (directory && inputPath && outputPath) await removeWorkerFiles(fsOps, directory, inputPath, outputPath);
  }
}

const marker = process.argv.indexOf("--suzu-lives-hook");
const args = marker === -1 ? [] : process.argv.slice(marker + 1);
if (args[0] === "memory-recall") await runMemoryRecallHookCli({ args });
else await runProjectHookCli({ args });
