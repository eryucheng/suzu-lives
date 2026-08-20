import { spawn, spawnSync } from "node:child_process";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSuzuLivesDataRoot } from "@suzu-lives/agent-registry";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RUNTIME_DIRECTORY = "mail-bridge";
const STATE_FILENAME = "mail_state.json";

function clean(value) {
  return String(value ?? "").trim();
}

function lstatIfPresentSync(fsOps, target) {
  try { return fsOps.lstatSync(target); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function isUnsafeLink(stat) {
  return stat.isSymbolicLink();
}

function assertSafeDirectorySync(fsOps, target, label) {
  const stat = lstatIfPresentSync(fsOps, target);
  if (!stat) throw new Error(`${label}不存在。`);
  if (isUnsafeLink(stat) || !stat.isDirectory()) {
    throw new Error(`${label}必须是安全的普通目录，不能是符号链接或 Windows junction。`);
  }
}

function pathSegments(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  return { absolute, root: parsed.root, segments: path.relative(parsed.root, absolute).split(path.sep).filter(Boolean) };
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

function assertSafeRegularFileSync(fsOps, target, label) {
  assertSafeDirectoryChainSync(fsOps, path.dirname(target), label);
  const stat = lstatIfPresentSync(fsOps, target);
  if (!stat || isUnsafeLink(stat) || !stat.isFile()) {
    throw new Error(`${label}必须是安全的普通文件，不能是符号链接或 Windows junction。`);
  }
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
    if (next === undefined || String(next).startsWith("--")) throw new Error(`mail-bridge 选项 --${key} 缺少值。`);
    options[key] = String(next);
    index += 1;
  }
  return { positional, options };
}

function softwareDataRoot(dataRoot) {
  return resolveSuzuLivesDataRoot({
    configuredRoot: clean(dataRoot) || process.env.SUZU_LIVES_DATA_ROOT || "",
    localAppData: process.env.LOCALAPPDATA || "",
    appData: process.env.APPDATA || "",
    fallbackBase: "",
    fallbackToLocatorWhenMissing: false,
  });
}

export function resolveMailBridgePaths({ projectRoot, dataRoot } = {}) {
  const root = clean(projectRoot) ? path.resolve(clean(projectRoot)) : "";
  const data = softwareDataRoot(dataRoot);
  const runtimeRoot = path.join(data, "automation", RUNTIME_DIRECTORY);
  return Object.freeze({
    projectRoot: root,
    softwareDataRoot: data,
    runtimeRoot,
    configPath: path.join(runtimeRoot, "config.json"),
    statePath: path.join(runtimeRoot, STATE_FILENAME),
    inboxPath: path.join(runtimeRoot, "inbox"),
    sendScriptPath: path.join(PACKAGE_ROOT, "python", "send_mail.py"),
    receiveScriptPath: path.join(PACKAGE_ROOT, "python", "receive_mail.py"),
  });
}

export function mailBridgeUsage() {
  return "suzu-lives mail-bridge send <主题> <内容> | receive --preview <主题> <内容>（收件监听由 Suzu 软件管理）";
}

function runtimePaths({ dataRoot, projectRoot, cwd } = {}) {
  const paths = resolveMailBridgePaths({ dataRoot, projectRoot });
  const workingDirectory = paths.projectRoot || cwd;
  assertSafeDirectoryChainSync(fsSync, workingDirectory, "当前 Agent 项目目录");
  assertSafeDirectoryChainSync(fsSync, paths.runtimeRoot, "Suzu Lives 邮箱通道数据目录");
  try { assertSafeRegularFileSync(fsSync, paths.configPath, "软件邮箱通道配置"); }
  catch (error) {
    if (error?.message?.includes("不存在")) throw new Error("邮箱通道尚未在 Suzu Lives 中完成设置。 ");
    throw error;
  }
  return Object.freeze({ paths, workingDirectory });
}

function mailEnvironment(env, inboxPath) {
  return { ...env, SUZU_LIVES_MAIL_INBOX_DIR: inboxPath };
}

function boundedOutput(value, maximum = 4_000) {
  const text = String(value ?? "").trim();
  return text.length > maximum ? `${text.slice(0, maximum)}\n[输出已截断]` : text;
}

function runPythonAsync({ command, args, cwd, env, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    if (!child || typeof child.once !== "function") {
      reject(new Error("邮箱发送器没有启动。 "));
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on?.("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on?.("data", (chunk) => { stderr += String(chunk); });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.once("error", fail);
    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      resolve(Object.freeze({
        status: Number.isInteger(status) ? status : 1,
        signal: clean(signal),
        stderr: boundedOutput(stderr),
        stdout: boundedOutput(stdout),
      }));
    });
  });
}

/**
 * Send one request through the configured SMTP endpoint without making the
 * Electron main process wait synchronously for the mail server.  The caller
 * only supplies subject and content; the configured sender, recipient and
 * credential remain inside the software-owned mail configuration.
 */
export async function sendMailBridge({
  subject,
  content,
  projectRoot = "",
  dataRoot = "",
  cwd = process.cwd(),
  env = process.env,
  python = clean(env?.SUZU_LIVES_PYTHON) || "python",
  spawnProcess = spawn,
} = {}) {
  const title = clean(subject);
  const body = clean(content);
  if (!title) throw new Error("邮件主题不能为空。 ");
  if (!body) throw new Error("邮件内容不能为空。 ");
  const runtime = runtimePaths({ dataRoot, projectRoot, cwd });
  const result = await runPythonAsync({
    command: python,
    args: [runtime.paths.sendScriptPath, title, body, "--config", runtime.paths.configPath],
    cwd: runtime.workingDirectory,
    env: mailEnvironment(env, runtime.paths.inboxPath),
    spawnProcess,
  });
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || (result.signal ? `进程被 ${result.signal} 停止。` : "邮件未提交给 SMTP 服务器。 ");
    const error = new Error(`邮箱发送失败：${detail}`);
    error.code = "MAIL_BRIDGE_SEND_FAILED";
    throw error;
  }
  return Object.freeze({
    status: "sent",
    subject: title,
  });
}

export function runMailBridgeCli({
  args = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  spawnProcess = spawnSync,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const { positional, options } = parseArgs(args);
  const action = clean(positional.shift()).toLowerCase();
  if (!new Set(["send", "receive"]).has(action)) throw new Error(mailBridgeUsage());
  const runtime = runtimePaths({
    cwd,
    dataRoot: options["data-root"] || "",
    projectRoot: options["project-root"] || "",
  });
  const { paths } = runtime;
  const python = options.python || env.SUZU_LIVES_PYTHON || "python";
  let scriptPath;
  let scriptArgs;
  if (action === "send") {
    if (positional.length !== 2) throw new Error("mail-bridge send 需要且只接受主题和内容。 ");
    scriptPath = paths.sendScriptPath;
    scriptArgs = [...positional, "--config", paths.configPath];
  } else {
    if (positional[0] !== "--preview" || positional.length !== 3) {
      throw new Error("邮箱收件监听由 Suzu 软件管理；命令行只允许 receive --preview <主题> <内容>。 ");
    }
    scriptPath = paths.receiveScriptPath;
    scriptArgs = ["--config", paths.configPath, "--state", paths.statePath, ...positional];
  }
  const result = spawnProcess(python, [scriptPath, ...scriptArgs], {
    encoding: "utf8",
    windowsHide: true,
    cwd: runtime.workingDirectory,
    env: mailEnvironment(env, paths.inboxPath),
  });
  if (result?.stdout) stdout.write(result.stdout);
  if (result?.stderr) stderr.write(result.stderr);
  if (result?.error) throw result.error;
  const status = Number.isInteger(result?.status) ? result.status : 1;
  return Object.freeze({ status, action, paths });
}
