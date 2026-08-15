import fs from "node:fs/promises";
import path from "node:path";

export class ProjectHooksError extends Error {}

const HOOK_MARKER = "--suzu-lives-hook";
const TIME_AWARENESS_HOOK = { event: "UserPromptSubmit", role: "time-awareness", timeout: 5 };
const MEMORY_RECALL_HOOK = { event: "UserPromptSubmit", role: "memory-recall", timeout: 15 };
const POWERSHELL_COMMAND = "powershell.exe";

function clean(value) { return String(value ?? "").trim(); }
function inside(root, target) { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function object(value) { return value && typeof value === "object" && !Array.isArray(value); }

async function lstatIfPresent(fsOps, target) {
  try { return await fsOps.lstat(target); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function projectRoot(projectRoot, fsOps) {
  const requested = clean(projectRoot);
  if (!requested) throw new ProjectHooksError("请先选择 Claude 项目目录。");
  const target = path.resolve(requested);
  const stat = await lstatIfPresent(fsOps, target);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new ProjectHooksError("Claude 项目目录必须是安全的普通目录。");
  return fsOps.realpath(target);
}

async function safeDirectory(fsOps, root, target, { create = false } = {}) {
  if (!inside(root, target)) throw new ProjectHooksError("Hook 配置路径超出当前项目目录。");
  const stat = await lstatIfPresent(fsOps, target);
  if (!stat && create) {
    await fsOps.mkdir(target);
    return safeDirectory(fsOps, root, target);
  }
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new ProjectHooksError(".claude 必须是项目内的普通目录，不能是符号链接。");
}

async function readSettings(fsOps, root, settingsPath) {
  if (!inside(root, settingsPath)) throw new ProjectHooksError("Hook 配置路径超出当前项目目录。");
  const stat = await lstatIfPresent(fsOps, settingsPath);
  if (!stat) return { exists: false, value: {} };
  if (stat.isSymbolicLink() || !stat.isFile()) throw new ProjectHooksError(".claude/settings.json 必须是普通文件，不能是符号链接。");
  let value;
  try { value = JSON.parse((await fsOps.readFile(settingsPath, "utf8")).replace(/^\uFEFF/u, "")); }
  catch { throw new ProjectHooksError(".claude/settings.json 不是有效 JSON，未修改用户配置。"); }
  if (!object(value)) throw new ProjectHooksError(".claude/settings.json 的根节点必须是对象，未修改用户配置。");
  const verified = await lstatIfPresent(fsOps, settingsPath);
  if (!verified || verified.isSymbolicLink() || !verified.isFile()) throw new ProjectHooksError(".claude/settings.json 在读取时发生变化，未修改用户配置。");
  return { exists: true, value };
}

async function writeSettingsAtomic(fsOps, root, settingsPath, value) {
  const stat = await lstatIfPresent(fsOps, settingsPath);
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new ProjectHooksError(".claude/settings.json 不是安全的普通文件，未写入。");
  const temporary = `${settingsPath}.suzu-lives-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  await fsOps.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    const verified = await lstatIfPresent(fsOps, settingsPath);
    if (verified && (verified.isSymbolicLink() || !verified.isFile())) throw new ProjectHooksError(".claude/settings.json 在写入前发生变化，未写入。");
    if (!inside(root, settingsPath)) throw new ProjectHooksError("Hook 配置路径超出当前项目目录。");
    await fsOps.rename(temporary, settingsPath);
  } catch (error) {
    await fsOps.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function assertHooksContainer(value) {
  if (!object(value)) throw new ProjectHooksError("settings.json 的 hooks 必须是对象，未修改用户配置。");
  for (const [event, entries] of Object.entries(value)) {
    if (!Array.isArray(entries)) throw new ProjectHooksError(`settings.json 的 hooks.${event} 必须是数组，未修改用户配置。`);
  }
}

function managedHook(value, role) {
  if (!object(value) || value.type !== "command" || !Array.isArray(value.args)) return false;
  if (value.args[0] === HOOK_MARKER && value.args[1] === role) return true;
  const commandIndex = value.args.indexOf("-Command");
  const script = commandIndex === -1 ? "" : value.args[commandIndex + 1];
  return value.command === POWERSHELL_COMMAND
    && typeof script === "string"
    && script.includes(`suzu-lives:project-hook:${role}`);
}

function powerShellLiteral(value, label) {
  const source = clean(value);
  if (!source || /[\r\n\0]/u.test(source)) throw new ProjectHooksError(`${label} 无效。`);
  return `'${source.replace(/'/gu, "''")}'`;
}

function hookDefinition({ command, hookRunner, dataRoot, role, timeout }) {
  const script = [
    `$null = ${powerShellLiteral(`suzu-lives:project-hook:${role}`, "Hook 标识")};`,
    "$env:ELECTRON_RUN_AS_NODE = '1';",
    "&",
    powerShellLiteral(command, "Suzu Lives 启动入口"),
    powerShellLiteral(hookRunner, "Hook 运行器"),
    powerShellLiteral(HOOK_MARKER, "Hook 标识"),
    powerShellLiteral(role, "Hook 角色"),
    powerShellLiteral("--project-root", "Hook 参数"),
    "$env:CLAUDE_PROJECT_DIR",
    powerShellLiteral("--data-root", "Hook 参数"),
    powerShellLiteral(dataRoot, "软件数据目录"),
  ].join(" ");
  return {
    type: "command",
    command: POWERSHELL_COMMAND,
    args: ["-NoProfile", "-NonInteractive", "-Command", script],
    timeout,
  };
}

function updateEvent(entries, definition, role) {
  let found = false;
  const next = [];
  for (const entry of entries) {
    if (!object(entry) || !Array.isArray(entry.hooks)) {
      next.push(entry);
      continue;
    }
    const hooks = [];
    for (const hook of entry.hooks) {
      if (!managedHook(hook, role)) hooks.push(hook);
      else if (!found) { hooks.push(definition); found = true; }
    }
    next.push({ ...entry, hooks });
  }
  if (!found) next.push({ hooks: [definition] });
  return next;
}

function removeMatchingHooks(entries, matches) {
  return entries.flatMap((entry) => {
    if (!object(entry) || !Array.isArray(entry.hooks)) return [entry];
    const hooks = entry.hooks.filter((hook) => !matches(hook));
    return hooks.length ? [{ ...entry, hooks }] : [];
  });
}

function removeEvent(entries, role) {
  return removeMatchingHooks(entries, (hook) => managedHook(hook, role));
}

function legacyMemoryHook(value) {
  return managedHook(value, "user-prompt") || managedHook(value, "assistant-stop");
}

function removeLegacyMemoryHooks(hooks) {
  const next = { ...hooks };
  for (const event of ["UserPromptSubmit", "Stop"]) {
    const entries = next[event];
    if (!Array.isArray(entries)) continue;
    const retained = removeMatchingHooks(entries, legacyMemoryHook);
    if (retained.length) next[event] = retained;
    else delete next[event];
  }
  return next;
}

async function inspectManagedHook({ projectRoot: selectedProjectRoot, hook, fsOps = fs } = {}) {
  const root = await projectRoot(selectedProjectRoot, fsOps);
  const claudeDirectory = path.join(root, ".claude");
  const settingsPath = path.join(claudeDirectory, "settings.json");
  const directoryStat = await lstatIfPresent(fsOps, claudeDirectory);
  if (!directoryStat) return { installed: false, settingsPath };
  await safeDirectory(fsOps, root, claudeDirectory);
  const stored = await readSettings(fsOps, root, settingsPath);
  if (!stored.exists || stored.value.hooks === undefined) return { installed: false, settingsPath };
  assertHooksContainer(stored.value.hooks);
  const entries = stored.value.hooks[hook.event] || [];
  const installed = entries.some((entry) => object(entry)
    && Array.isArray(entry.hooks)
    && entry.hooks.some((entryHook) => managedHook(entryHook, hook.role)));
  return { installed, settingsPath };
}

async function installManagedHook({ projectRoot: selectedProjectRoot, command, hookRunner, dataRoot, hook, removeLegacyMemory = false, fsOps = fs } = {}) {
  const executable = clean(command); const runner = clean(hookRunner); const rootData = clean(dataRoot);
  if (!path.isAbsolute(executable) || !path.isAbsolute(runner) || !rootData || !path.isAbsolute(rootData)) throw new ProjectHooksError("无法定位打包后的 Suzu Lives Hook 启动入口、运行器或软件数据目录。");
  const root = await projectRoot(selectedProjectRoot, fsOps);
  const claudeDirectory = path.join(root, ".claude");
  await safeDirectory(fsOps, root, claudeDirectory, { create: true });
  const settingsPath = path.join(claudeDirectory, "settings.json");
  const stored = await readSettings(fsOps, root, settingsPath);
  const settings = structuredClone(stored.value);
  let hooks = settings.hooks === undefined ? {} : settings.hooks;
  assertHooksContainer(hooks);
  const existing = hooks[hook.event] || [];
  hooks[hook.event] = updateEvent(
    existing,
    hookDefinition({ command: executable, hookRunner: runner, dataRoot: rootData, role: hook.role, timeout: hook.timeout }),
    hook.role,
  );
  if (removeLegacyMemory) hooks = removeLegacyMemoryHooks(hooks);
  settings.hooks = hooks;
  await writeSettingsAtomic(fsOps, root, settingsPath, settings);
  return { status: "installed", settingsPath, events: [hook.event] };
}

async function uninstallManagedHook({ projectRoot: selectedProjectRoot, hook, removeLegacyMemory = false, fsOps = fs } = {}) {
  const root = await projectRoot(selectedProjectRoot, fsOps);
  const claudeDirectory = path.join(root, ".claude");
  const settingsPath = path.join(claudeDirectory, "settings.json");
  const directoryStat = await lstatIfPresent(fsOps, claudeDirectory);
  if (!directoryStat) return { status: "not-installed", settingsPath };
  await safeDirectory(fsOps, root, claudeDirectory);
  const stored = await readSettings(fsOps, root, settingsPath);
  if (!stored.exists || stored.value.hooks === undefined) return { status: "not-installed", settingsPath };
  const settings = structuredClone(stored.value);
  assertHooksContainer(settings.hooks);
  const entries = settings.hooks[hook.event] || [];
  const next = removeEvent(entries, hook.role);
  let changed = JSON.stringify(next) !== JSON.stringify(entries);
  if (next.length) settings.hooks[hook.event] = next;
  else delete settings.hooks[hook.event];
  if (removeLegacyMemory) {
    const cleaned = removeLegacyMemoryHooks(settings.hooks);
    changed = changed || JSON.stringify(cleaned) !== JSON.stringify(settings.hooks);
    settings.hooks = cleaned;
  }
  if (!changed) return { status: "not-installed", settingsPath };
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  await writeSettingsAtomic(fsOps, root, settingsPath, settings);
  return { status: "uninstalled", settingsPath };
}

export function inspectTimeAwarenessHook(options = {}) {
  return inspectManagedHook({ ...options, hook: TIME_AWARENESS_HOOK });
}

export function inspectMemoryRecallHook(options = {}) {
  return inspectManagedHook({ ...options, hook: MEMORY_RECALL_HOOK });
}

export function installTimeAwarenessHook(options = {}) {
  return installManagedHook({ ...options, hook: TIME_AWARENESS_HOOK });
}

export function installMemoryRecallHook(options = {}) {
  return installManagedHook({ ...options, hook: MEMORY_RECALL_HOOK, removeLegacyMemory: true });
}

export function uninstallTimeAwarenessHook(options = {}) {
  return uninstallManagedHook({ ...options, hook: TIME_AWARENESS_HOOK });
}

export function uninstallMemoryRecallHook(options = {}) {
  return uninstallManagedHook({ ...options, hook: MEMORY_RECALL_HOOK, removeLegacyMemory: true });
}

export function createProjectHooksService({ settingsService, executablePath, hookRunnerPath, packaged = false, fsOps = fs } = {}) {
  if (!settingsService?.load || !settingsService?.response) throw new ProjectHooksError("项目 Hook 服务需要软件设置服务。");
  const context = ({ projectRoot: requestedProjectRoot = "" } = {}) => {
    const settings = settingsService.load();
    const response = settingsService.response(settings);
    return { projectRoot: clean(requestedProjectRoot) || settings.projectRoot, dataRoot: response.dataRoot };
  };
  return {
    inspectTimeAwareness: (options = {}) => inspectTimeAwarenessHook({ projectRoot: context(options).projectRoot, fsOps }),
    installTimeAwareness: (options = {}) => {
      if (!packaged) throw new ProjectHooksError("开发环境不会写入项目 Hook；请使用打包后的 Suzu Lives 安装。 ");
      const current = context(options);
      return installTimeAwarenessHook({ projectRoot: current.projectRoot, command: executablePath, hookRunner: hookRunnerPath, dataRoot: current.dataRoot, fsOps });
    },
    uninstallTimeAwareness: (options = {}) => uninstallTimeAwarenessHook({ projectRoot: context(options).projectRoot, fsOps }),
    inspectMemoryRecall: (options = {}) => inspectMemoryRecallHook({ projectRoot: context(options).projectRoot, fsOps }),
    installMemoryRecall: (options = {}) => {
      if (!packaged) throw new ProjectHooksError("开发环境不会写入项目 Hook；请使用打包后的 Suzu Lives 安装。 ");
      const current = context(options);
      return installMemoryRecallHook({ projectRoot: current.projectRoot, command: executablePath, hookRunner: hookRunnerPath, dataRoot: current.dataRoot, fsOps });
    },
    uninstallMemoryRecall: (options = {}) => uninstallMemoryRecallHook({ projectRoot: context(options).projectRoot, fsOps }),
  };
}
