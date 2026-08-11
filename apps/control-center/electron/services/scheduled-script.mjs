import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const SCRIPT_EXTENSIONS = new Set([".cmd", ".bat", ".py"]);
const MAX_OUTPUT_LENGTH = 8_000;

export class ScheduledScriptError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScheduledScriptError";
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function scriptExtension(value) {
  const extension = path.extname(clean(value)).toLowerCase();
  if (!SCRIPT_EXTENSIONS.has(extension)) {
    throw new ScheduledScriptError("系统定时任务目前只支持 .cmd、.bat 或 .py 脚本。 ");
  }
  return extension;
}

function bounded(value) {
  const text = String(value || "");
  return text.length > MAX_OUTPUT_LENGTH ? text.slice(-MAX_OUTPUT_LENGTH) : text;
}

function scriptPath(value) {
  const source = clean(value);
  if (!source || !path.isAbsolute(source)) throw new ScheduledScriptError("脚本路径必须是绝对路径。 ");
  scriptExtension(source);
  return path.resolve(source);
}

export async function validateScheduledScriptPath(value, { fsOps = fs } = {}) {
  const selectedPath = scriptPath(value);
  let stat;
  try {
    stat = await fsOps.lstat(selectedPath);
  } catch {
    throw new ScheduledScriptError("选择的脚本不存在或无法读取。 ");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ScheduledScriptError("选择的脚本必须是普通文件。 ");
  }
  return { scriptPath: await fsOps.realpath(selectedPath), extension: scriptExtension(selectedPath) };
}

export function scheduledScriptCommand(value, {
  pythonCommand = () => process.env.SUZU_LIVES_PYTHON || process.env.PYTHON || "python",
} = {}) {
  const target = scriptPath(value);
  const extension = scriptExtension(target);
  if (extension === ".py") {
    return { command: clean(pythonCommand()) || "python", args: [target] };
  }
  // spawn passes the path as one process argument; no user data is ever
  // concatenated into a shell command line.
  return {
    command: clean(process.env.ComSpec) || "cmd.exe",
    args: ["/d", "/s", "/c", target],
  };
}

export async function runScheduledScript(value, {
  fsOps = fs,
  spawnImpl = spawn,
  pythonCommand,
} = {}) {
  const selected = await validateScheduledScriptPath(value, { fsOps });
  const invocation = scheduledScriptCommand(selected.scriptPath, { pythonCommand });
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(invocation.command, invocation.args, {
        cwd: path.dirname(selected.scriptPath),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(new ScheduledScriptError(`无法启动系统脚本：${clean(error?.message) || "未知错误"}`));
      return;
    }
    if (!child) {
      reject(new ScheduledScriptError("无法启动系统脚本。 "));
      return;
    }
    let settled = false;
    let stdout = "";
    let stderr = "";
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof ScheduledScriptError
        ? error
        : new ScheduledScriptError(`系统脚本执行失败：${clean(error?.message) || "未知错误"}`));
    };
    child.stdout?.on?.("data", (chunk) => { stdout = bounded(`${stdout}${String(chunk)}`); });
    child.stderr?.on?.("data", (chunk) => { stderr = bounded(`${stderr}${String(chunk)}`); });
    child.once?.("error", fail);
    child.once?.("close", (code, signal) => {
      if (settled) return;
      if (code === 0) {
        settled = true;
        resolve({ scriptPath: selected.scriptPath, stdout, stderr });
        return;
      }
      const reason = signal
        ? `系统脚本已停止（${signal}）。`
        : `系统脚本退出代码为 ${code ?? "未知"}。`;
      fail(new ScheduledScriptError(stderr ? `${reason} ${stderr}` : reason));
    });
  });
}
