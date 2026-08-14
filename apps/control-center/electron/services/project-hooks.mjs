import fs from "node:fs/promises";
import path from "node:path";

export class ProjectHooksError extends Error {}

const HOOK_MARKER = "--suzu-lives-hook";
const TIME_AWARENESS_HOOK = { event: "UserPromptSubmit", role: "time-awareness", timeout: 5 };

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
  return object(value)
    && value.type === "command"
    && Array.isArray(value.args)
    && value.args[0] === HOOK_MARKER
    && value.args[1] === role;
}

function hookDefinition({ command, dataRoot, role, timeout }) {
  return {
    type: "command",
    command,
    args: [HOOK_MARKER, role, "--project-root", "${CLAUDE_PROJECT_DIR}", "--data-root", dataRoot],
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

export async function inspectTimeAwarenessHook({ projectRoot: selectedProjectRoot, fsOps = fs } = {}) {
  const root = await projectRoot(selectedProjectRoot, fsOps);
  const claudeDirectory = path.join(root, ".claude");
  const settingsPath = path.join(claudeDirectory, "settings.json");
  const directoryStat = await lstatIfPresent(fsOps, claudeDirectory);
  if (!directoryStat) return { installed: false, settingsPath };
  await safeDirectory(fsOps, root, claudeDirectory);
  const stored = await readSettings(fsOps, root, settingsPath);
  if (!stored.exists || stored.value.hooks === undefined) return { installed: false, settingsPath };
  assertHooksContainer(stored.value.hooks);
  const entries = stored.value.hooks[TIME_AWARENESS_HOOK.event] || [];
  const installed = entries.some((entry) => object(entry)
    && Array.isArray(entry.hooks)
    && entry.hooks.some((hook) => managedHook(hook, TIME_AWARENESS_HOOK.role)));
  return { installed, settingsPath };
}

export async function installTimeAwarenessHook({ projectRoot: selectedProjectRoot, command, dataRoot, fsOps = fs } = {}) {
  const executable = clean(command); const rootData = clean(dataRoot);
  if (!path.isAbsolute(executable) || !rootData || !path.isAbsolute(rootData)) throw new ProjectHooksError("无法定位打包后的 Suzu Lives Hook 启动入口或软件数据目录。");
  const root = await projectRoot(selectedProjectRoot, fsOps);
  const claudeDirectory = path.join(root, ".claude");
  await safeDirectory(fsOps, root, claudeDirectory, { create: true });
  const settingsPath = path.join(claudeDirectory, "settings.json");
  const stored = await readSettings(fsOps, root, settingsPath);
  const settings = structuredClone(stored.value);
  const hooks = settings.hooks === undefined ? {} : settings.hooks;
  assertHooksContainer(hooks);
  const existing = hooks[TIME_AWARENESS_HOOK.event] || [];
  hooks[TIME_AWARENESS_HOOK.event] = updateEvent(
    existing,
    hookDefinition({ command: executable, dataRoot: rootData, role: TIME_AWARENESS_HOOK.role, timeout: TIME_AWARENESS_HOOK.timeout }),
    TIME_AWARENESS_HOOK.role,
  );
  settings.hooks = hooks;
  await writeSettingsAtomic(fsOps, root, settingsPath, settings);
  return { status: "installed", settingsPath, events: [TIME_AWARENESS_HOOK.event] };
}

export async function uninstallTimeAwarenessHook({ projectRoot: selectedProjectRoot, fsOps = fs } = {}) {
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
  const entries = settings.hooks[TIME_AWARENESS_HOOK.event] || [];
  const next = removeEvent(entries, TIME_AWARENESS_HOOK.role);
  if (JSON.stringify(next) === JSON.stringify(entries)) return { status: "not-installed", settingsPath };
  if (next.length) settings.hooks[TIME_AWARENESS_HOOK.event] = next;
  else delete settings.hooks[TIME_AWARENESS_HOOK.event];
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  await writeSettingsAtomic(fsOps, root, settingsPath, settings);
  return { status: "uninstalled", settingsPath };
}

export function createProjectHooksService({ settingsService, executablePath, packaged = false, fsOps = fs } = {}) {
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
      return installTimeAwarenessHook({ projectRoot: current.projectRoot, command: executablePath, dataRoot: current.dataRoot, fsOps });
    },
    uninstallTimeAwareness: (options = {}) => uninstallTimeAwarenessHook({ projectRoot: context(options).projectRoot, fsOps }),
  };
}
