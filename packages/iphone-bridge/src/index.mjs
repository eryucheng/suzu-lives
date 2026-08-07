import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveAgentDataRoot,
  resolveSuzuLivesDataRoot,
  stableAgentId,
} from "@suzu-lives/agent-registry";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function clean(value) {
  return String(value ?? "").trim();
}

function isSymbolicLink(stat) {
  // Node's lstat reliably reports symbolic links and Windows junctions here.
  return stat.isSymbolicLink();
}

async function lstatIfPresent(fsOps, target) {
  try { return await fsOps.lstat(target); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function lstatIfPresentSync(fsOps, target) {
  try { return fsOps.lstatSync(target); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function assertSafeDirectory(fsOps, target, label) {
  const stat = await lstatIfPresent(fsOps, target);
  if (!stat || isSymbolicLink(stat) || !stat.isDirectory()) throw new Error(`${label}必须是安全的普通目录，不能是符号链接或 Windows junction。`);
}

function assertSafeDirectorySync(fsOps, target, label) {
  const stat = lstatIfPresentSync(fsOps, target);
  if (!stat || isSymbolicLink(stat) || !stat.isDirectory()) throw new Error(`${label}必须是安全的普通目录，不能是符号链接或 Windows junction。`);
}

function pathSegments(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  return { absolute, root: parsed.root, segments: path.relative(parsed.root, absolute).split(path.sep).filter(Boolean) };
}

async function ensureSafeDirectoryChain(fsOps, target, label, { create = false } = {}) {
  const { absolute, root, segments } = pathSegments(target);
  let current = root;
  await assertSafeDirectory(fsOps, current, label);
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat = await lstatIfPresent(fsOps, current);
    if (!stat) {
      if (!create) throw new Error(`${label}不存在。`);
      await fsOps.mkdir(current);
      stat = await lstatIfPresent(fsOps, current);
    }
    if (!stat || isSymbolicLink(stat) || !stat.isDirectory()) throw new Error(`${label}包含不安全的目录、符号链接或 Windows junction。`);
  }
  return absolute;
}

function assertSafeDirectoryChainSync(fsOps, target, label) {
  const { absolute, root, segments } = pathSegments(target);
  let current = root;
  assertSafeDirectorySync(fsOps, current, label);
  for (const segment of segments) {
    current = path.join(current, segment);
    assertSafeDirectorySync(fsOps, current, label);
  }
  return absolute;
}

async function assertSafeRegularFile(fsOps, target, label, { missing = false } = {}) {
  await ensureSafeDirectoryChain(fsOps, path.dirname(target), label);
  const stat = await lstatIfPresent(fsOps, target);
  if (!stat) {
    if (missing) return false;
    throw new Error(`${label}不存在。`);
  }
  if (isSymbolicLink(stat) || !stat.isFile()) throw new Error(`${label}必须是安全的普通文件，不能是符号链接或 Windows junction。`);
  return true;
}

function assertSafeRegularFileSync(fsOps, target, label) {
  assertSafeDirectoryChainSync(fsOps, path.dirname(target), label);
  const stat = lstatIfPresentSync(fsOps, target);
  if (!stat || isSymbolicLink(stat) || !stat.isFile()) throw new Error(`${label}必须是安全的普通文件，不能是符号链接或 Windows junction。`);
}

function parseArgs(values) {
  const positional = [];
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = String(values[index] || "");
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    if (!new Set(["project-root", "data-root", "python"]).has(key)) {
      positional.push(value);
      continue;
    }
    const next = values[index + 1];
    if (next === undefined || String(next).startsWith("--")) throw new Error(`iphone-bridge 选项 --${key} 缺少值。`);
    options[key] = String(next);
    index += 1;
  }
  return { positional, options };
}

export function resolveIphoneBridgePaths({ projectRoot, dataRoot } = {}) {
  const root = path.resolve(clean(projectRoot));
  if (!clean(projectRoot)) throw new Error("iphone-bridge 需要当前 Agent 项目目录。 ");
  const softwareDataRoot = resolveSuzuLivesDataRoot({
    configuredRoot: clean(dataRoot) || process.env.SUZU_LIVES_DATA_ROOT || "",
    localAppData: process.env.LOCALAPPDATA || "",
    fallbackBase: "",
  });
  const agentId = stableAgentId(root);
  const runtimeRoot = path.join(resolveAgentDataRoot({ dataRoot: softwareDataRoot, agentId }), "iphone-bridge");
  return {
    projectRoot: root,
    agentId,
    runtimeRoot,
    configPath: path.join(runtimeRoot, "feedback_config.json"),
    statePath: path.join(runtimeRoot, "feedback_state.json"),
    inboxPath: path.join(runtimeRoot, "inbox"),
    sendScriptPath: path.join(PACKAGE_ROOT, "python", "send_to_iphone.py"),
    receiveScriptPath: path.join(PACKAGE_ROOT, "python", "receive_from_iphone.py"),
  };
}

export function iphoneBridgeUsage() {
  return "suzu-lives iphone-bridge send <主题> <内容> | receive --preview <主题> <内容>（反馈监听由 Suzu 软件管理）";
}

export function runIphoneBridgeCli({
  args = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  spawnProcess = spawnSync,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const { positional, options } = parseArgs(args);
  const action = clean(positional.shift()).toLowerCase();
  if (!new Set(["send", "receive"]).has(action)) throw new Error(iphoneBridgeUsage());
  const paths = resolveIphoneBridgePaths({
    projectRoot: options["project-root"] || cwd,
    dataRoot: options["data-root"] || "",
  });
  const python = options.python || env.SUZU_LIVES_PYTHON || "python";
  assertSafeDirectoryChainSync(fsSync, paths.projectRoot, "当前 Agent 项目目录");
  assertSafeDirectoryChainSync(fsSync, paths.runtimeRoot, "Suzu Lives iPhone 数据目录");
  try { assertSafeRegularFileSync(fsSync, paths.configPath, "软件 iPhone 配置"); }
  catch (error) {
    if (error?.message?.includes("不存在")) throw new Error("iPhone 配置尚未在 Suzu Lives 中完成设置。 ");
    throw error;
  }
  let scriptPath;
  let scriptArgs;
  if (action === "send") {
    if (positional.length !== 2) throw new Error("iphone-bridge send 需要且只接受主题和内容。 ");
    scriptPath = paths.sendScriptPath;
    scriptArgs = [...positional, "--config", paths.configPath];
  } else {
    if (positional[0] !== "--preview" || positional.length !== 3) {
      throw new Error("iPhone 反馈监听由 Suzu 软件管理；命令行只允许 receive --preview <主题> <内容>。 ");
    }
    scriptPath = paths.receiveScriptPath;
    scriptArgs = ["--config", paths.configPath, "--state", paths.statePath, ...positional];
  }
  const result = spawnProcess(python, [scriptPath, ...scriptArgs], {
    encoding: "utf8",
    windowsHide: true,
    cwd: paths.projectRoot,
    env: { ...env, SUZU_LIVES_IPHONE_INBOX_DIR: paths.inboxPath },
  });
  if (result?.stdout) stdout.write(result.stdout);
  if (result?.stderr) stderr.write(result.stderr);
  if (result?.error) throw result.error;
  const status = Number.isInteger(result?.status) ? result.status : 1;
  return { status, action, paths };
}
