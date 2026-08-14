import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { internalCapabilityCliUsage } from "@suzu-lives/capability-registry/internal-cli";
import { PROACTIVE_CONTACT_ID, PROACTIVE_CONTACT_NAME, renderProactiveContactSkill } from "@suzu-lives/proactive-contact";

export class ClaudeIntegrationError extends Error { constructor(message, { code = "" } = {}) { super(message); this.code = code; } }

const CLAUDE_START = "<!-- suzu-lives:managed:start -->";
const CLAUDE_END = "<!-- suzu-lives:managed:end -->";
const ABILITIES_START = "<!-- suzu-lives:abilities:start -->";
const ABILITIES_END = "<!-- suzu-lives:abilities:end -->";
const ABILITY_MARKER_PREFIX = "<!-- suzu-lives:ability:";
const EXTERNAL_SKILL_MARKER_PREFIX = "<!-- suzu-lives:external-capability:";
const EXTERNAL_SKILL_METADATA_FILE = ".suzu-lives-external-capability.json";
const EXTERNAL_SKILL_METADATA_VERSION = 2;
const EXTERNAL_SKILL_MAX_FILE_BYTES = 1_000_000;
const EXTERNAL_SKILL_MAX_TOTAL_BYTES = 8_000_000;
const EXTERNAL_SKILL_MAX_FILES = 256;
const EXTERNAL_SKILL_MAX_DEPTH = 16;
const EXTERNAL_MCP_METADATA_FILE = "suzu-lives-external-capabilities.json";
const EXTERNAL_MCP_METADATA_VERSION = 1;
const EXTERNAL_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const TIME_AWARENESS_ID = "time-awareness";
const SELECTABLE_CLAUDE_TOOL_PERMISSIONS = Object.freeze([
  ["read", "Read"],
  ["webFetch", "WebFetch"],
  ["webSearch", "WebSearch"],
]);
const AGENT_ABILITY_CATALOG = Object.freeze([
  { id: "image-generation", name: "图像生成", description: "生成、编辑图片，并可结合视觉参考。", category: "create", setting: { route: "api", label: "设置图片" } },
  { id: "phone-camera", name: "手机拍照式图像", description: "生成具有手机拍摄感的图片。", category: "create", setting: { route: "api", label: "设置图片" } },
  { id: TIME_AWARENESS_ID, name: "时间感知", description: "按会话以设定的间隔感知本机日期、星期与当前时间。", category: "perceive" },
  { id: "image-vision", name: "图像理解", description: "理解一张明确提供的本地图片。", category: "perceive", setting: { route: "api", label: "设置图像理解" } },
  { id: "video-understanding", name: "视频理解", description: "理解一段明确提供的视频。", category: "perceive", setting: { route: "api", label: "设置视频理解" } },
  { id: "voice-message", name: "语音消息", description: "将文字或已有音频通过既有通道发送。", category: "create", setting: { route: "audio", label: "打开音色设计" } },
  { id: "iphone-bridge", name: "iPhone 互通", description: "调用 Suzu Lives 中配置的 iPhone 快捷指令。", category: "act" },
  { id: "proactive-contact", name: "主动关心", description: "在 Suzu 运行期间用自动任务安排主动联系。", category: "companion" },
]);
const CLAUDE_REGISTERABLE_ABILITIES = new Map([
  ["image-generation", { id: "image-generation", name: "图像生成", renderSkill: renderImageGenerationSkill }],
  ["phone-camera", { id: "phone-camera", name: "手机拍照式生图", renderSkill: renderPhoneCameraSkill }],
  ["image-vision", { id: "image-vision", name: "图像理解", renderSkill: renderImageVisionSkill }],
  ["video-understanding", { id: "video-understanding", name: "视频理解", renderSkill: renderVideoUnderstandingSkill }],
  ["voice-message", { id: "voice-message", name: "语音消息", renderSkill: renderVoiceMessageSkill }],
  ["voice-call", { id: "voice-call", name: "软件内语音来电", renderSkill: renderVoiceCallSkill }],
  ["visual-reference-manager", { id: "visual-reference-manager", name: "视觉参考资料库", renderSkill: renderVisualReferenceManagerSkill }],
  [TIME_AWARENESS_ID, { id: TIME_AWARENESS_ID, name: "时间感知", renderSkill: renderTimeAwarenessSkill }],
  ["iphone-bridge", { id: "iphone-bridge", name: "iPhone Bridge", renderSkill: renderIphoneBridgeSkill }],
  [PROACTIVE_CONTACT_ID, { id: PROACTIVE_CONTACT_ID, name: PROACTIVE_CONTACT_NAME, renderSkill: renderProactiveContactSkill }],
]);

function clean(value) {
  return String(value ?? "").trim();
}

function safeCommand(value) {
  const command = clean(value || "suzu-lives");
  const portableCli = /^"([A-Za-z]:[\\/][^"\r\n]{1,240}\.exe)" --suzu-lives-cli$/iu;
  const developmentCli = /^"([A-Za-z]:[\\/][^"\r\n]{1,240}\.exe)" "([A-Za-z]:[\\/][^"\r\n]{1,240})" --suzu-lives-cli$/iu;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(command) && !portableCli.test(command) && !developmentCli.test(command)) {
    throw new ClaudeIntegrationError("稳定启动命令格式无效。");
  }
  return command;
}

function assertLauncher(launcher = {}) {
  const command = safeCommand(launcher.command);
  if (launcher.available !== true) throw new ClaudeIntegrationError(`未找到稳定启动命令 ${command}，因此不会写入 Claude 注册文件。`);
  return command;
}

function registerableClaudeAbility(abilityId) {
  return CLAUDE_REGISTERABLE_ABILITIES.get(clean(abilityId).toLowerCase()) || null;
}

function knownRegistrationAbility(abilityId) {
  return Boolean(registerableClaudeAbility(abilityId));
}

export function claudeRegistrationAbilityIds() {
  return [...CLAUDE_REGISTERABLE_ABILITIES.keys()].sort();
}

export function claudeAgentAbilityCatalog() {
  return AGENT_ABILITY_CATALOG.map((ability) => ({ ...ability }));
}

export function inspectClaudeRegistration({ projectRoot, abilityId } = {}) {
  const normalizedId = clean(abilityId).toLowerCase();
  if (!knownRegistrationAbility(normalizedId)) return { abilityId: normalizedId, registered: false, reason: "该能力没有软件注册入口。" };
  const requestedRoot = clean(projectRoot);
  if (!requestedRoot) return { abilityId: normalizedId, registered: false, reason: "尚未选择 Claude 项目目录。" };
  const root = path.resolve(requestedRoot);
  const skillPath = path.join(root, ".claude", "skills", normalizedId, "SKILL.md");
  const abilitiesPath = path.join(root, "abilities.md");
  try {
    const rootStat = fsSync.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { abilityId: normalizedId, registered: false, reason: "当前项目目录不安全或不可读取。" };
    const skillStat = fsSync.lstatSync(skillPath);
    const abilitiesStat = fsSync.lstatSync(abilitiesPath);
    if (skillStat.isSymbolicLink() || !skillStat.isFile() || abilitiesStat.isSymbolicLink() || !abilitiesStat.isFile()) return { abilityId: normalizedId, registered: false, reason: "没有找到当前 Agent 的受管注册文件。" };
    const marker = `${ABILITY_MARKER_PREFIX}${normalizedId} -->`;
    const skill = fsSync.readFileSync(skillPath, "utf8");
    const abilities = fsSync.readFileSync(abilitiesPath, "utf8");
    return {
      abilityId: normalizedId,
      registered: skill.includes(marker) && abilities.includes(marker),
      reason: skill.includes(marker) && abilities.includes(marker) ? "当前 Agent 已注册该软件拥有的 Skill。" : "没有找到当前 Agent 的受管注册标记。",
    };
  } catch {
    return { abilityId: normalizedId, registered: false, reason: "没有找到当前 Agent 的受管注册文件。" };
  }
}

function assertRegisterableAbility(abilityId) {
  const direct = registerableClaudeAbility(abilityId);
  if (direct) return direct;
  throw new ClaudeIntegrationError("这项能力没有当前可用的 Suzu Lives 注册入口。");
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function lstatIfPresent(fsOps, target) {
  try {
    return await fsOps.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertSafeDirectory(fsOps, target, label) {
  const stat = await lstatIfPresent(fsOps, target);
  if (!stat) return false;
  if (stat.isSymbolicLink()) throw new ClaudeIntegrationError(`${label}不能是符号链接；未写入 Claude 项目。`);
  if (!stat.isDirectory()) throw new ClaudeIntegrationError(`${label}必须是目录；未写入 Claude 项目。`);
  return true;
}

async function ensureSafeDirectory(fsOps, root, segments) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!inside(root, current)) throw new ClaudeIntegrationError("Claude 注册目录超出用户选择的项目范围。 ");
    if (!(await assertSafeDirectory(fsOps, current, current))) {
      try {
        await fsOps.mkdir(current);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      await assertSafeDirectory(fsOps, current, current);
    }
  }
  return current;
}

async function assertSafeParents(fsOps, root, filePath) {
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new ClaudeIntegrationError("Claude 注册目标路径无效。 ");
  const segments = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const stat = await lstatIfPresent(fsOps, current);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ClaudeIntegrationError(`${current} 不是项目内安全目录；未写入 Claude 项目。`);
    }
  }
}

async function assertSafeFile(fsOps, root, filePath, label) {
  if (!inside(root, filePath)) throw new ClaudeIntegrationError("Claude 注册目标路径无效。 ");
  await assertSafeParents(fsOps, root, filePath);
  const stat = await lstatIfPresent(fsOps, filePath);
  if (!stat) return false;
  if (stat.isSymbolicLink()) throw new ClaudeIntegrationError(`${label}不能是符号链接；未写入 Claude 项目。`);
  if (!stat.isFile()) throw new ClaudeIntegrationError(`${label}必须是普通文件；未写入 Claude 项目。`);
  return true;
}

async function readTextIfPresent(fsOps, root, filePath, label) {
  await assertSafeFile(fsOps, root, filePath, label);
  try {
    const content = await fsOps.readFile(filePath, "utf8");
    await assertSafeFile(fsOps, root, filePath, label);
    return { exists: true, content };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, content: "" };
    throw error;
  }
}

function record(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeSelectableClaudeToolPermissions(value = {}) {
  const source = record(value) ? value : {};
  return {
    read: source.read !== false,
    webFetch: source.webFetch !== false,
    webSearch: source.webSearch !== false,
  };
}

function normalizeClaudeToolRules(value) {
  const source = Array.isArray(value) ? value : [];
  const rules = [];
  const seen = new Set();
  for (const item of source) {
    if (typeof item !== "string") continue;
    const tool = clean(item);
    if (!tool || tool.length > 500 || seen.has(tool)) continue;
    seen.add(tool);
    rules.push(tool);
    if (rules.length >= 120) break;
  }
  return rules;
}

function normalizeClaudeProjectDefaults(value) {
  if (value === undefined) return null;
  const source = record(value) ? value : {};
  return {
    allowedTools: normalizeClaudeToolRules(source.allowedTools),
    deniedTools: normalizeClaudeToolRules(source.deniedTools),
    skipWebFetchPreflight: source.skipWebFetchPreflight !== false,
  };
}

function sameStringList(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function parseClaudeProjectSettings(content) {
  const source = String(content || "").trim();
  if (!source) return {};
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new ClaudeIntegrationError(".claude/settings.json 不是有效 JSON，未修改 Claude 项目设置。 ");
  }
  if (!record(parsed)) throw new ClaudeIntegrationError(".claude/settings.json 的根节点必须是对象，未修改 Claude 项目设置。 ");
  return parsed;
}

function suzuCliBashPermission(command) {
  // Use Claude Code's documented Bash-prefix form.  The old `:*` form is
  // recognized below only so existing Suzu projects are upgraded safely.
  return `Bash(${safeCommand(command)} *)`;
}

function isSuzuCliBashPermission(value) {
  const match = /^Bash\((.+?)(?::\*| \*)\)$/u.exec(clean(value));
  if (!match) return false;
  try {
    const command = safeCommand(match[1]);
    return command === "suzu-lives" || command.endsWith(" --suzu-lives-cli");
  } catch {
    return false;
  }
}

function normalizeWorkspaceDirectories(value = []) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ClaudeIntegrationError("共享项目目录必须是数组，未修改 Claude 项目设置。 ");
  const seen = new Set();
  return value.flatMap((item) => {
    const directory = clean(item);
    if (!directory || /[\r\n]/u.test(directory) || !path.isAbsolute(directory)) {
      throw new ClaudeIntegrationError("共享项目目录必须是有效的绝对路径，未修改 Claude 项目设置。 ");
    }
    const resolved = path.resolve(directory);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return [];
    seen.add(key);
    return [resolved];
  });
}

function sameDirectory(left, right) {
  const first = clean(left);
  const second = clean(right);
  if (!first || !second || !path.isAbsolute(first) || !path.isAbsolute(second)) return false;
  const normalizedLeft = path.resolve(first);
  const normalizedRight = path.resolve(second);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function updateSuzuClaudeProjectSettings(existing, { command, previousProjectDefaults, projectDefaults, toolPermissions, workspaceDirectories } = {}) {
  const settings = parseClaudeProjectSettings(existing.content);
  if (settings.permissions !== undefined && !record(settings.permissions)) {
    throw new ClaudeIntegrationError(".claude/settings.json 的 permissions 必须是对象，未修改 Claude 项目设置。 ");
  }
  const permissions = { ...(settings.permissions || {}) };
  const normalizedProjectDefaults = normalizeClaudeProjectDefaults(projectDefaults);
  const previousAllowedTools = new Set(normalizedProjectDefaults
    ? (normalizeClaudeProjectDefaults(previousProjectDefaults)?.allowedTools || [])
    : []);
  const allowedTools = new Set(normalizedProjectDefaults?.allowedTools || []);
  if (permissions.allow !== undefined && !Array.isArray(permissions.allow)) {
    throw new ClaudeIntegrationError(".claude/settings.json 的 permissions.allow 必须是数组，未修改 Claude 项目设置。 ");
  }
  const existingAllow = permissions.allow || [];
  if (existingAllow.some((item) => typeof item !== "string")) {
    throw new ClaudeIntegrationError(".claude/settings.json 的 permissions.allow 只能包含字符串，未修改 Claude 项目设置。 ");
  }
  if (normalizedProjectDefaults && permissions.deny !== undefined && !Array.isArray(permissions.deny)) {
    throw new ClaudeIntegrationError(".claude/settings.json 的 permissions.deny 必须是数组，未修改 Claude 项目设置。 ");
  }
  const existingDeny = normalizedProjectDefaults ? (permissions.deny || []) : [];
  if (normalizedProjectDefaults && existingDeny.some((item) => typeof item !== "string")) {
    throw new ClaudeIntegrationError(".claude/settings.json 的 permissions.deny 只能包含字符串，未修改 Claude 项目设置。 ");
  }
  if (settings.additionalDirectories !== undefined && !Array.isArray(settings.additionalDirectories)) {
    throw new ClaudeIntegrationError(".claude/settings.json 的 additionalDirectories 必须是数组，未修改 Claude 项目设置。 ");
  }
  const existingDirectories = settings.additionalDirectories || [];
  if (existingDirectories.some((item) => typeof item !== "string")) {
    throw new ClaudeIntegrationError(".claude/settings.json 的 additionalDirectories 只能包含字符串，未修改 Claude 项目设置。 ");
  }

  const currentSuzuPermission = suzuCliBashPermission(command);
  const sharedDirectories = normalizeWorkspaceDirectories(workspaceDirectories);
  const selectablePermissions = normalizeSelectableClaudeToolPermissions(toolPermissions);
  const enabledSelectablePermissions = new Set(SELECTABLE_CLAUDE_TOOL_PERMISSIONS
    .filter(([key]) => selectablePermissions[key])
    .map(([, permission]) => permission));
  const knownSelectablePermissions = new Set(SELECTABLE_CLAUDE_TOOL_PERMISSIONS.map(([, permission]) => permission));
  const nextAllow = [];
  let currentSuzuPermissionSeen = false;
  const selectablePermissionsSeen = new Set();
  let changed = false;
  for (const item of existingAllow) {
    if (previousAllowedTools.has(item) && !allowedTools.has(item)) {
      changed = true;
      continue;
    }
    if (isSuzuCliBashPermission(item) && item !== currentSuzuPermission) {
      changed = true;
      continue;
    }
    if (item === currentSuzuPermission) {
      if (currentSuzuPermissionSeen) {
        changed = true;
        continue;
      }
      currentSuzuPermissionSeen = true;
    }
    if (knownSelectablePermissions.has(item)) {
      if (!enabledSelectablePermissions.has(item) || selectablePermissionsSeen.has(item)) {
        changed = true;
        continue;
      }
      selectablePermissionsSeen.add(item);
    }
    nextAllow.push(item);
  }
  if (!currentSuzuPermissionSeen) {
    nextAllow.push(currentSuzuPermission);
    changed = true;
  }
  for (const permission of enabledSelectablePermissions) {
    if (selectablePermissionsSeen.has(permission)) continue;
    nextAllow.push(permission);
    changed = true;
  }
  for (const permission of allowedTools) {
    if (nextAllow.includes(permission)) continue;
    nextAllow.push(permission);
    changed = true;
  }
  const nextDirectories = [...existingDirectories];
  for (const directory of sharedDirectories) {
    if (nextDirectories.some((item) => sameDirectory(item, directory))) continue;
    nextDirectories.push(directory);
    changed = true;
  }
  if (normalizedProjectDefaults && settings.skipWebFetchPreflight !== normalizedProjectDefaults.skipWebFetchPreflight) changed = true;
  if (normalizedProjectDefaults && !sameStringList(existingDeny, normalizedProjectDefaults.deniedTools)) changed = true;
  if (!normalizedProjectDefaults && settings.skipWebFetchPreflight !== true) changed = true;
  if (permissions.defaultMode !== "acceptEdits") changed = true;

  if (!changed) return { changed: false, content: existing.content };
  const nextPermissions = { ...permissions, defaultMode: "acceptEdits", allow: nextAllow };
  if (normalizedProjectDefaults) {
    if (normalizedProjectDefaults.deniedTools.length) nextPermissions.deny = normalizedProjectDefaults.deniedTools;
    else delete nextPermissions.deny;
  }
  return {
    changed: true,
    content: `${JSON.stringify({
      ...settings,
      ...(normalizedProjectDefaults
        ? {
          skipWebFetchPreflight: normalizedProjectDefaults.skipWebFetchPreflight,
        }
        : { skipWebFetchPreflight: true }),
      ...(settings.additionalDirectories !== undefined || nextDirectories.length ? { additionalDirectories: nextDirectories } : {}),
      permissions: nextPermissions,
    }, null, 2)}\n`,
  };
}

async function resolveSafeProjectRoot(projectRoot, fsOps) {
  if (!clean(projectRoot)) throw new ClaudeIntegrationError("请先选择 Claude 项目目录。");
  const requestedRoot = path.resolve(clean(projectRoot));
  let rootStat;
  try {
    rootStat = await fsOps.lstat(requestedRoot);
  } catch {
    throw new ClaudeIntegrationError("选择的 Claude 项目目录不存在。 ");
  }
  if (rootStat.isSymbolicLink()) throw new ClaudeIntegrationError("选择的 Claude 项目目录不能是符号链接。 ");
  if (!rootStat.isDirectory()) throw new ClaudeIntegrationError("选择的 Claude 项目路径不是目录。 ");
  return fsOps.realpath(requestedRoot);
}

async function prepareSuzuClaudeProjectSettings({ root, command, previousProjectDefaults, projectDefaults, toolPermissions, workspaceDirectories, fsOps }) {
  const claudeDirectory = await ensureSafeDirectory(fsOps, root, [".claude"]);
  const settingsPath = path.join(claudeDirectory, "settings.json");
  await assertSafeFile(fsOps, root, settingsPath, ".claude/settings.json");
  const existing = await readTextIfPresent(fsOps, root, settingsPath, ".claude/settings.json");
  return {
    settingsPath,
    existing,
    updated: updateSuzuClaudeProjectSettings(existing, { command, previousProjectDefaults, projectDefaults, toolPermissions, workspaceDirectories }),
  };
}

export async function ensureSuzuClaudeProjectSettings({ projectRoot, launcher = {}, previousProjectDefaults, projectDefaults, toolPermissions, workspaceDirectories, fsOps = fs } = {}) {
  const command = assertLauncher(launcher);
  const root = await resolveSafeProjectRoot(projectRoot, fsOps);
  const prepared = await prepareSuzuClaudeProjectSettings({ root, command, previousProjectDefaults, projectDefaults, toolPermissions, workspaceDirectories, fsOps });
  if (prepared.updated.changed) await writeAtomically(fsOps, root, prepared.settingsPath, prepared.updated.content);
  return {
    settingsPath: prepared.settingsPath,
    changed: prepared.updated.changed,
    command,
  };
}

async function writeAtomically(fsOps, root, filePath, content) {
  await assertSafeFile(fsOps, root, filePath, filePath);
  const temporary = `${filePath}.suzu-lives-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  await fsOps.writeFile(temporary, content, "utf8");
  try {
    await assertSafeFile(fsOps, root, filePath, filePath);
    await fsOps.rename(temporary, filePath);
  } catch (error) {
    await fsOps.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function deleteIfPresent(fsOps, root, filePath) {
  await assertSafeFile(fsOps, root, filePath, filePath);
  try {
    await fsOps.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function writeRegistrationTransaction(fsOps, root, files) {
  const prepared = [];
  try {
    for (const file of files) {
      await assertSafeFile(fsOps, root, file.path, file.label);
      if (file.delete === true) {
        prepared.push({ ...file, temporary: "" });
        continue;
      }
      const temporary = `${file.path}.suzu-lives-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
      await fsOps.writeFile(temporary, file.content, "utf8");
      prepared.push({ ...file, temporary });
    }
  } catch (error) {
    await Promise.all(prepared.filter((file) => file.temporary).map((file) => fsOps.unlink(file.temporary).catch(() => undefined)));
    throw error;
  }

  const committed = [];
  try {
    for (const file of prepared) {
      await assertSafeFile(fsOps, root, file.path, file.label);
      if (file.delete === true) await deleteIfPresent(fsOps, root, file.path);
      else await fsOps.rename(file.temporary, file.path);
      committed.push(file);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const file of committed.reverse()) {
      try {
        if (file.previous.exists) await writeAtomically(fsOps, root, file.path, file.previous.content);
        else await deleteIfPresent(fsOps, root, file.path);
      } catch (rollbackError) {
        rollbackErrors.push(clean(rollbackError?.message) || "unknown rollback error");
      }
    }
    await Promise.all(prepared.filter((file) => !committed.includes(file) && file.temporary).map((file) => fsOps.unlink(file.temporary).catch(() => undefined)));
    const suffix = rollbackErrors.length ? `；回滚失败：${rollbackErrors.join("；")}` : "；已回滚此前写入";
    throw new ClaudeIntegrationError(`Claude 注册事务未完成${suffix}。${clean(error?.message) ? ` 原因：${clean(error.message)}` : ""}`);
  }
}

function registeredIds(existing) {
  const ids = new Set();
  const pattern = /<!-- suzu-lives:ability:([a-z0-9-]+) -->/giu;
  for (const match of existing.matchAll(pattern)) {
    if (knownRegistrationAbility(match[1])) ids.add(match[1]);
  }
  return ids;
}

function standardCapabilityBullet(id, command) {
  return "- <!-- suzu-lives:ability:" + id + " --> `" + id + "`：使用 `" + command + "` 调用软件拥有的标准能力执行器。";
}

export function renderClaudeManagedBlock({ abilityIds, command = "suzu-lives" } = {}) {
  const launcher = safeCommand(command);
  const ids = [...new Set((abilityIds || []).map((value) => clean(value).toLowerCase()))]
    .filter((id) => knownRegistrationAbility(id))
    .sort();
  const bullets = ids.map((id) => {
    if (id === "voice-message") return standardCapabilityBullet(id, internalCapabilityCliUsage({ launcher, capabilityId: id, action: "generate" }));
    if (id === "voice-call") return standardCapabilityBullet(id, internalCapabilityCliUsage({ launcher, capabilityId: id, action: "request" }));
    if (id === "image-generation") return standardCapabilityBullet(id, internalCapabilityCliUsage({ launcher, capabilityId: id, action: "generate" }));
    if (id === "phone-camera") return standardCapabilityBullet(id, internalCapabilityCliUsage({ launcher, capabilityId: id, action: "generate" }));
    if (id === "image-vision") return `- <!-- suzu-lives:ability:${id} --> \`${id}\`：使用 \`${internalCapabilityCliUsage({ launcher, capabilityId: id })}\` 调用软件拥有的标准能力执行器。`;
    if (id === "video-understanding") return `- <!-- suzu-lives:ability:${id} --> \`${id}\`：使用 \`${internalCapabilityCliUsage({ launcher, capabilityId: id })}\` 调用软件拥有的标准能力执行器。`;
    if (id === TIME_AWARENESS_ID) return `- <!-- suzu-lives:ability:${id} --> \`${id}\`：由 Suzu 在每次用户消息进入时检查本机日期、星期和当前时间；按软件中设定的会话间隔注入。`;
    if (id === "visual-reference-manager") return `- <!-- suzu-lives:ability:${id} --> \`${id}\`：使用 \`${launcher} visual-reference-manager init|list|show|validate|apply --scope shared|contact\` 维护共享或当前联系人的视觉资料库。`;
    if (id === "iphone-bridge") return `- <!-- suzu-lives:ability:${id} --> \`${id}\`：使用 \`${launcher} iphone-bridge send ...\` 向 iPhone 发出请求；反馈监听由正在运行的 Suzu 直接处理。`;
    if (id === PROACTIVE_CONTACT_ID) return `- <!-- suzu-lives:ability:${id} --> \`${id}\`：使用已注册的轻量 Skill 按 Suzu \`schedule\` 语义管理链式关心和一次性回访。`;
    return "";
  }).join("\n");
  const notices = [];
  if (ids.includes("image-vision")) notices.push(`\`image-vision\` 使用 Suzu 的标准 \`capability <id> <action> --input-json\` 协议；它仍只读取明确给出的本地图片和软件数据目录中的配置。`);
  if (ids.includes("video-understanding")) notices.push(`\`video-understanding\` 使用 Suzu 的标准 \`capability <id> <action> --input-json\` 协议；它只处理明确给出的本地视频或 http(s) URL，并把临时片段、缓存、保留片段和配置限制在软件数据目录。`);
  if (ids.includes(TIME_AWARENESS_ID)) notices.push(`\`time-awareness\` 通过 Suzu 受管的 \`UserPromptSubmit\` Hook 检查本轮当前本地时间；同一 Claude 会话仅按软件中设定的间隔写入新的时间提醒。它不读取消息正文、不联网、不替代其他同事件 Hook。`);
  if (ids.includes("voice-message")) notices.push("`voice-message` 使用 Suzu 的标准 `capability <id> <action> --input-json` 协议；它只在软件数据目录中生成 MP3，再由当前 Suzu 会话的附件交付命令显示和投递。");
  if (ids.includes("voice-call")) notices.push("`voice-call` 只会向当前 Suzu 软件发起一通应用内来电请求；用户必须在软件中亲自接听，之后才会开启麦克风和实时语音，不会拨打真实电话号码。");
  if (ids.includes("image-generation")) notices.push("`image-generation` 使用 Suzu 的标准 `capability <id> <action> --input-json` 协议；默认后端与 ComfyUI 配置位于统一软件数据目录，运行记录和候选图片仍属于当前 Agent 的数据目录。");
  if (ids.includes("phone-camera")) notices.push("`phone-camera` 使用 Suzu 的标准 `capability <id> <action> --input-json` 协议；它可明确读取共享或当前联系人的视觉资料，但不能读取其他联系人的专属资料，失败不会静默切换后端。");
  if (ids.includes("visual-reference-manager")) notices.push(`\`visual-reference-manager\` 使用独立的软件拥有命令；共享资料与当前联系人专属资料物理隔离，写入前仍需先 dry-run 和用户确认。`);
  if (ids.includes("iphone-bridge")) notices.push(`\`iphone-bridge\` 使用独立的软件拥有命令；只保留既有 iPhone 邮件快捷指令的发送与反馈监听语义。`);
  if (ids.includes(PROACTIVE_CONTACT_ID)) notices.push(`\`proactive-contact\` 使用 Suzu 自有的 \`schedule\` 自动任务；仅在软件运行期间执行，关闭期间不补跑。`);
  return `${CLAUDE_START}\n## Suzu Lives 能力注册\n\n这些是由 Suzu Lives 管理的轻量入口。功能源码、设置、缓存和凭据不在此项目中；请只使用下方登记的入口。\n\n${bullets}\n\n${notices.join("\n\n")}\n${CLAUDE_END}`;
}

function renderTimeAwarenessSkill() {
  return `---\nname: suzu-lives-time-awareness\ndescription: 让 Agent 按会话以 Suzu Lives 设定的间隔感知本机当前日期、星期和时间。\n---\n\n<!-- suzu-lives:ability:time-awareness -->\n# 时间感知\n\n这是 Suzu Lives 生成的受管能力。开启后，软件会在每次 \`UserPromptSubmit\` 时检查当前电脑本地日期、星期与时间；同一 Claude 会话达到 Suzu Lives 中设定的间隔后，才把新的时间作为本轮上下文注入。\n\n它是自动能力，不需要、也不要为了询问“现在几点”再调用终端或旧脚本。注入内容只描述当前时刻，不是用户或 Agent 的历史对话；回答时间相关问题时以最近一次注入的时间为准。\n\n时间 Hook 不读取消息正文、不联网、不调用模型；它只在 Suzu 的会话私有数据中记录最近一次注入时间，并会与其他 \`UserPromptSubmit\` Hook（例如 RAG）并列运行。不要改用旧项目脚本。\n`;
}

function renderImageVisionSkill(launcher) {
  const command = internalCapabilityCliUsage({ launcher, capabilityId: "image-vision" });
  return `---\nname: suzu-lives-image-vision\ndescription: 通过 Suzu Lives 的标准能力 CLI 理解一张明确给出的本地图片。\n---\n\n<!-- suzu-lives:ability:image-vision -->\n# 图像理解\n\n这是 Suzu Lives 生成的轻量注册文件，不包含功能源码、安装路径、配置、缓存或凭据。\n\n仅在需要理解用户明确提供的单张本地图片时调用：\n\n\`${command}\`\n\n其中 \`<JSON>\` 例如 \`{"path":"<本地图片路径>","question":"<具体问题>"}\`。输入只接受 \`path\`、\`question\`、\`configPath\`、\`noRetry\`；\`configPath\` 必须位于软件数据目录内，\`noRetry: true\` 会关闭被上游拒绝时的中性描述重试。成功和失败都会在 stdout 返回统一 JSON：\`schemaVersion\`、\`status\`、\`capabilityId\`、\`action\` 与 \`result\` 或 \`error\`。\n\n不要绕过软件入口，也不要把配置、密钥或图片复制进 Claude 项目；若错误码为 \`vision_refused\`、\`upstream_error\` 或 \`invalid_request\`，如实说明问题，不要补写看不见的内容。\n`;
}

function renderVideoUnderstandingSkill(launcher) {
  const command = internalCapabilityCliUsage({ launcher, capabilityId: "video-understanding" });
  return `---\nname: suzu-lives-video-understanding\ndescription: 通过 Suzu Lives 的标准能力 CLI 理解一段明确给出的本地视频或 http(s) 视频。\n---\n\n<!-- suzu-lives:ability:video-understanding -->\n# 视频理解\n\n这是 Suzu Lives 生成的轻量注册文件，不包含功能源码、安装路径、配置、缓存或凭据。\n\n仅在需要理解用户明确提供的视频内容时调用：\n\n\`${command}\`\n\n其中 \`<JSON>\` 例如 \`{"source":"<本地视频路径或 http(s) URL>","question":"<具体问题>"}\`。输入只接受 \`source\`、\`question\`、\`cacheKey\`、\`configPath\`、\`noCache\`、\`keepClip\`、\`dryRun\`。软件会检查 FFmpeg/FFprobe，准备受大小限制的 MP4 片段；\`dryRun: true\` 只准备和校验视频，不请求模型。\`configPath\` 必须位于软件数据目录内。成功和失败都会在 stdout 返回统一 JSON：\`schemaVersion\`、\`status\`、\`capabilityId\`、\`action\` 与 \`result\` 或 \`error\`。\n\n不要绕过软件入口，也不要把配置、密钥、缓存或视频复制进 Claude 项目；若返回 \`clip_too_large\`、\`dependency_missing\`、\`api_error\` 或其他稳定错误码，如实说明视频、工具或软件配置问题，不要补写未看到或未听到的内容。\n`;
}

function markdownCode(value) {
  return "`" + value + "`";
}

function renderStandardVoiceMessageSkill(launcher) {
  const command = internalCapabilityCliUsage({ launcher, capabilityId: "voice-message", action: "generate" });
  const inspect = internalCapabilityCliUsage({ launcher, capabilityId: "voice-message", action: "inspect" });
  return [
    "---",
    "name: suzu-lives-voice-message",
    "description: 通过 Suzu Lives 的标准能力 CLI 生成一条明确要求的 MP3 语音，并交付到当前会话。",
    "---",
    "",
    "<!-- suzu-lives:ability:voice-message -->",
    "# 发送语音",
    "",
    "只在用户明确要求语音回复、或一段很短的话用声音显著更自然时调用。",
    "",
    markdownCode(command),
    "",
    "其中 JSON 例如 " + markdownCode('{"text":"<要说的话>"}') + "。也可使用 " + markdownCode('{"audioPath":"<用户明确给出的本地音频路径>"}') + " 转换已有音频；text 与 audioPath 必须且只能提供一个。可选字段只有 timeoutMs。音色始终使用当前联系人的已保存选择；未配置时，向用户说明需要到“能力 → 语音消息”配置联系人音色，不要自行指定或猜测音色。",
    "",
    "成功 JSON 的 result.savedPath 是生成的 MP3。必须紧接着使用当前 Suzu 会话系统提示中提供的附件交付命令，以 --audio 交付这个路径。只检查当前联系人语音配置时，使用 " + markdownCode(inspect) + "；无需指定配置路径。",
    "",
    "不要绕过软件入口，也不要把配置、密钥或音频复制进 Claude 项目。",
    "",
  ].join("\n");
}

function renderStandardImageGenerationSkill(launcher) {
  const command = internalCapabilityCliUsage({ launcher, capabilityId: "image-generation", action: "generate" });
  const list = internalCapabilityCliUsage({ launcher, capabilityId: "image-generation", action: "list-workflows" });
  const validate = internalCapabilityCliUsage({ launcher, capabilityId: "image-generation", action: "validate-workflows" });
  return [
    "---",
    "name: suzu-lives-image-generation",
    "description: 通过 Suzu Lives 的标准能力 CLI 生成普通图片或明确指定的 ComfyUI 工作流图片。",
    "---",
    "",
    "<!-- suzu-lives:ability:image-generation -->",
    "# Image Generation",
    "",
    "普通生成图片和明确指定的本地 ComfyUI 工作流使用：",
    "",
    markdownCode(command),
    "",
    "输入 JSON 例如 " + markdownCode('{"prompt":"画面中实际需要生成的内容"}') + "。可选字段：backend（api 或 comfyui）、workflow、size、seed、references、outputDirectory、configPath。references 是至多 16 项的数组，每项为 { role, path }，role 只能是 identity、location、object 或 style。",
    "",
    "列出或校验统一的 ComfyUI 工作流时，分别使用 " + markdownCode(list) + " 与 " + markdownCode(validate) + "，输入 JSON 只接受可选的 configPath。API 或 ComfyUI 出错时不能切换到另一后端。",
    "",
    "成功 JSON 的 result.path 才代表图片已保存。若用户要求交付，先生成，再使用当前会话提供的附件交付命令；不要自动导入视觉参考库或调用 image-vision。",
    "",
  ].join("\n");
}

function renderStandardPhoneCameraSkill(launcher) {
  const command = internalCapabilityCliUsage({ launcher, capabilityId: "phone-camera", action: "generate" });
  return [
    "---",
    "name: suzu-lives-phone-camera",
    "description: 让 Agent 通过 Suzu Lives 的标准能力 CLI 生成真实手机随手拍、自拍或镜面自拍。",
    "---",
    "",
    "<!-- suzu-lives:ability:phone-camera -->",
    "# Phone Camera",
    "",
    "食物、房间、街景和眼前所见用 rear；正面自拍用 selfie；穿搭或全身镜前照用 mirror。只把画面中真正可见的事实放进 scene。",
    "",
    markdownCode(command),
    "",
    "输入 JSON 例如 " + markdownCode('{"shot":"rear","scene":"画面中实际可见的场景","dryRun":true}') + "。可选字段为 referenceIds、backend、workflow、size、seed、outputDirectory、configPath、dryRun。referenceIds 是至多 16 项的 { scope, id }，scope 只能是 shared 或 contact；只放当前画面真正需要的资料或分组。contact 只会读取当前联系人专属资料，不能访问其他联系人。",
    "",
    "成功 JSON 的 result.path 才代表图片已保存；失败不会静默切换后端。若用户要求交付图片，先生成，再用当前会话提供的附件交付命令。",
    "",
  ].join("\n");
}

function renderVoiceMessageSkill(launcher) {
  return renderStandardVoiceMessageSkill(launcher);
}

function renderVoiceCallSkill(launcher) {
  const command = internalCapabilityCliUsage({ launcher, capabilityId: "voice-call", action: "request" });
  return [
    "---",
    "name: suzu-lives-voice-call",
    "description: 通过 Suzu Lives 向当前联系人发起一通需要对方亲自接听的应用内语音来电。",
    "---",
    "",
    "<!-- suzu-lives:ability:voice-call -->",
    "# 发起语音来电",
    "",
    "这是一通 Suzu Lives 软件内的来电，不会拨打真实电话号码，也不会自行打开麦克风。用户会先看到来电并决定接听或拒绝；只有接听后软件才会开始现有的实时语音通话。",
    "",
    "当用户明确让你打电话，或在主动关心时你确实自然地想听听对方声音、适合用电话继续交流时，才可以请求一次来电：",
    "",
    markdownCode(command),
    "",
    "输入 JSON 可写为 " + markdownCode('{\"reason\":\"想听听你的声音\"}') + "；reason 可省略，只简短说明来电缘由。一次回复最多请求一次，不能把它当作催促、提醒或重复追呼工具。用户拒绝、未接或没有回应时不要自动重试，也不要假装已经接通或听到了对方声音。",
    "",
    "命令成功仅代表软件已收到来电请求；不要绕过此入口，不要伪造来电文本或使用其他方式访问麦克风、电话或音频设备。",
    "",
  ].join("\n");
}

function renderImageGenerationSkill(launcher) {
  return renderStandardImageGenerationSkill(launcher);
}

function renderPhoneCameraSkill(launcher) {
  return renderStandardPhoneCameraSkill(launcher);
}

function renderVisualReferenceManagerSkill(launcher) {
  return `---\nname: suzu-lives-visual-reference-manager\ndescription: 通过 Suzu Lives 维护用户明确要求保存、登记、查看、更新、删除或校验的视觉参考资料库。\n---\n\n<!-- suzu-lives:ability:visual-reference-manager -->\n# Visual Reference Manager\n\n这是 Suzu Lives 生成的直连注册文件；请只使用下方稳定入口。\n\n只在用户明确要求维护参考资料库时使用；不要把普通聊天附件自动永久保存。资料分为两种物理隔离的归属：\n\n- \`shared\`：用户的共享资料，例如家、常用物品、公共风格，以及用户明确指定可共享的本人资料。\n- \`contact\`：当前联系人的专属资料；这是默认值，人物脸、服装和私人物品只能写在这里，不能访问其他联系人的资料。\n\n角色只能是 \`identity\`、\`location\`、\`object\`、\`style\`，ID 使用稳定的小写英文层级。每次命令都明确写 \`--scope shared\` 或 \`--scope contact\`：\n\n\`${launcher} visual-reference-manager init --scope contact\`\n\n\`${launcher} visual-reference-manager list --scope shared --query "卧室" --limit 10\`\n\n\`${launcher} visual-reference-manager show home.bedroom.door-view --scope shared\`\n\n\`${launcher} visual-reference-manager validate --scope contact\`\n\n新增、更新、换角色或删除时，先准备版本为 1 的维护计划 JSON，再执行：\n\n\`${launcher} visual-reference-manager apply --scope contact --plan '<计划文件>' --dry-run\`\n\n只有 dry-run 成功、没有冲突且用户已确认后，才执行同一计划的 \`${launcher} visual-reference-manager apply --scope contact --plan '<计划文件>'\`。\`remove\` 必须明确 \`delete_file: true|false\`；不要手工编辑 manifest，也不要把当前联系人的人物资料改写到 \`shared\`。\n`;
}

function renderIphoneBridgeSkill(launcher) {
  return `---\nname: suzu-lives-iphone-bridge\ndescription: 通过 Suzu Lives 中配置的 iPhone 邮件快捷指令发送请求。\n---\n\n<!-- suzu-lives:ability:iphone-bridge -->\n# iPhone Bridge\n\n这是 Suzu Lives 生成的直连注册文件。软件代码、配置、反馈状态和附件都在统一的 Suzu Lives 软件数据根。\n\n向 iPhone 发出请求时使用：\n\n\`${launcher} iphone-bridge send '闹钟' '08:30 起床'\`\n\n手机反馈由正在运行的 Suzu 本地接收器直接投递到能力设置中勾选的一个或多个会话。不要手动管理反馈接收器，也不要使用其他转发路径。\n\n若返回未配置，请先在 Suzu Lives 中完成 iPhone 设置；不要复制、打印或手工修改敏感配置。\n`;
}

export function renderCapabilitySkill({ abilityId, command = "suzu-lives" } = {}) {
  const launcher = safeCommand(command);
  const direct = registerableClaudeAbility(abilityId);
  if (direct) return direct.renderSkill(launcher);
  throw new ClaudeIntegrationError("这项能力没有当前可用的 Suzu Lives 注册入口。");
}

export function mergeClaudeManagedBlock(existing, block) {
  const source = String(existing || "");
  const start = source.indexOf(ABILITIES_START);
  const end = source.indexOf(ABILITIES_END);
  if ((start === -1) !== (end === -1) || (end !== -1 && end < start)) throw new ClaudeIntegrationError("abilities.md 中的 Suzu Lives 托管标记不完整，未修改用户文件。 ");
  if (start !== -1) return `${source.slice(0, start)}${block}${source.slice(end + ABILITIES_END.length)}`;
  const prefix = source.trimEnd();
  return prefix ? `${prefix}\n\n${block}\n` : `${block}\n`;
}

export function ensureUniqueClaudeReference(existing, relativePath = "abilities.md") {
  const source = String(existing || ""); const reference = `@${clean(relativePath)}`; const eol = source.includes("\r\n") ? "\r\n" : "\n"; const lines = source.split(/\r?\n/u); let seen = false;
  const next = lines.filter((line) => { if (line.trim() !== reference) return true; if (seen) return false; seen = true; return true; });
  if (!seen) { if (next.length === 1 && next[0] === "") next.length = 0; next.push(reference); }
  return next.join(eol);
}

function renderAbilitiesManagedBlock({ abilityIds, command = "suzu-lives" } = {}) {
  return renderClaudeManagedBlock({ abilityIds, command }).replace(CLAUDE_START, ABILITIES_START).replace(CLAUDE_END, ABILITIES_END);
}

export async function writeClaudeRegistration({ projectRoot, abilityId, launcher = {}, toolPermissions, workspaceDirectories, fsOps = fs } = {}) {
  const capability = assertRegisterableAbility(abilityId);
  const command = assertLauncher(launcher);
  const root = await resolveSafeProjectRoot(projectRoot, fsOps);

  const claudePath = path.join(root, "CLAUDE.md");
  const abilitiesPath = path.join(root, "abilities.md");
  await assertSafeFile(fsOps, root, claudePath, "CLAUDE.md");
  await assertSafeFile(fsOps, root, abilitiesPath, "abilities.md");
  const skillsRoot = await ensureSafeDirectory(fsOps, root, [".claude", "skills", capability.id]);
  const skillPath = path.join(skillsRoot, "SKILL.md");
  await assertSafeFile(fsOps, root, skillPath, "SKILL.md");
  const [existingClaude, existingAbilities, existingSkill] = await Promise.all([
    readTextIfPresent(fsOps, root, claudePath, "CLAUDE.md"),
    readTextIfPresent(fsOps, root, abilitiesPath, "abilities.md"),
    readTextIfPresent(fsOps, root, skillPath, "SKILL.md"),
  ]);
  const marker = `${ABILITY_MARKER_PREFIX}${capability.id} -->`;
  const skillCollision = existingSkill.content && !existingSkill.content.includes(marker);
  if (skillCollision) throw new ClaudeIntegrationError("目标 SKILL.md 不属于 Suzu Lives，未覆盖用户文件。", { code: "skill-conflict" });
  const ids = registeredIds(existingAbilities.content);
  ids.add(capability.id);
  const claudeContent = ensureUniqueClaudeReference(existingClaude.content, "abilities.md");
  const abilitiesContent = mergeClaudeManagedBlock(existingAbilities.content, renderAbilitiesManagedBlock({ abilityIds: [...ids], command }));
  const skillContent = renderCapabilitySkill({ abilityId: capability.id, command });
  const projectSettings = await prepareSuzuClaudeProjectSettings({ root, command, toolPermissions, workspaceDirectories, fsOps });
  const registrationFiles = [
    { path: skillPath, label: "SKILL.md", content: skillContent, previous: existingSkill },
    { path: abilitiesPath, label: "abilities.md", content: abilitiesContent, previous: existingAbilities },
    { path: claudePath, label: "CLAUDE.md", content: claudeContent, previous: existingClaude },
    ...(projectSettings.updated.changed ? [{ path: projectSettings.settingsPath, label: ".claude/settings.json", content: projectSettings.updated.content, previous: projectSettings.existing }] : []),
  ];

  await writeRegistrationTransaction(fsOps, root, registrationFiles);
  return { abilityId: capability.id, files: registrationFiles.map((file) => file.path), command };
}

/**
 * Removes only files and markers that were created by Suzu Lives.  User-owned
 * Skills are deliberately left untouched, so the management-page switch is a
 * real Agent-facing control rather than a cosmetic preference.
 */
export async function removeClaudeRegistration({ projectRoot, abilityId, fsOps = fs } = {}) {
  const capability = assertRegisterableAbility(abilityId);
  const root = await resolveSafeProjectRoot(projectRoot, fsOps);
  const claudePath = path.join(root, "CLAUDE.md");
  const abilitiesPath = path.join(root, "abilities.md");
  const skillPath = path.join(root, ".claude", "skills", capability.id, "SKILL.md");
  const [existingClaude, existingAbilities, existingSkill] = await Promise.all([
    readTextIfPresent(fsOps, root, claudePath, "CLAUDE.md"),
    readTextIfPresent(fsOps, root, abilitiesPath, "abilities.md"),
    readTextIfPresent(fsOps, root, skillPath, "SKILL.md"),
  ]);
  const marker = `${ABILITY_MARKER_PREFIX}${capability.id} -->`;
  const ids = registeredIds(existingAbilities.content);
  if (!ids.has(capability.id)) return { abilityId: capability.id, removed: false, files: [] };
  if (!existingSkill.content.includes(marker)) {
    throw new ClaudeIntegrationError("当前同名 Skill 不属于 Suzu Lives，未移除用户文件。", { code: "skill-conflict" });
  }
  ids.delete(capability.id);
  const claudeContent = ensureUniqueClaudeReference(existingClaude.content, "abilities.md");
  const abilitiesContent = mergeClaudeManagedBlock(existingAbilities.content, renderAbilitiesManagedBlock({ abilityIds: [...ids] }));
  const registrationFiles = [
    { path: skillPath, label: "SKILL.md", delete: true, previous: existingSkill },
    { path: abilitiesPath, label: "abilities.md", content: abilitiesContent, previous: existingAbilities },
    { path: claudePath, label: "CLAUDE.md", content: claudeContent, previous: existingClaude },
  ];
  await writeRegistrationTransaction(fsOps, root, registrationFiles);
  return { abilityId: capability.id, removed: true, files: [claudePath, abilitiesPath, skillPath] };
}

function externalCapabilityId(value) {
  const id = clean(value).toLowerCase();
  if (!EXTERNAL_ID.test(id)) throw new ClaudeIntegrationError("外部能力 ID 格式无效。", { code: "external-manifest-invalid" });
  return id;
}

function externalVersion(value) {
  const version = clean(value);
  if (!version || version.length > 120 || /[\r\n\u0000]/u.test(version)) {
    throw new ClaudeIntegrationError("外部能力版本格式无效。", { code: "external-manifest-invalid" });
  }
  return version;
}

function externalSkillDirectory(capabilityId) {
  return `suzu-external-${externalCapabilityId(capabilityId)}`;
}

function externalMcpServerName(capabilityId) {
  return `suzu-external-${externalCapabilityId(capabilityId)}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  return value;
}

function jsonHash(value) {
  return sha256(JSON.stringify(canonicalJson(value)));
}

function externalTypes(value) {
  const requested = Array.isArray(value) ? value : ["skill", "mcp"];
  const types = [...new Set(requested.map((item) => clean(item).toLowerCase()).filter(Boolean))];
  if (!types.length || types.some((type) => !["skill", "mcp"].includes(type))) {
    throw new ClaudeIntegrationError("外部能力注册类型无效。", { code: "external-manifest-invalid" });
  }
  return types;
}

function jsonObject(value, label) {
  if (!record(value)) throw new ClaudeIntegrationError(`${label}必须是 JSON 对象。`, { code: "external-manifest-invalid" });
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch { throw new ClaudeIntegrationError(`${label}无法序列化为 JSON。`, { code: "external-manifest-invalid" }); }
  if (!serialized || serialized.length > 64_000) {
    throw new ClaudeIntegrationError(`${label}过大或无效。`, { code: "external-manifest-invalid" });
  }
  return JSON.parse(serialized);
}

function parseJsonObject(content, label, code = "external-registration-invalid") {
  const source = String(content || "").trim();
  if (!source) return {};
  let parsed;
  try { parsed = JSON.parse(source); }
  catch { throw new ClaudeIntegrationError(`${label}不是有效 JSON，未修改用户项目。`, { code }); }
  if (!record(parsed)) throw new ClaudeIntegrationError(`${label}根节点必须是对象，未修改用户项目。`, { code });
  return parsed;
}

async function readOptionalSafeProjectFile(fsOps, root, filePath, label) {
  if (!inside(root, filePath)) throw new ClaudeIntegrationError("外部能力注册目标路径无效。", { code: "external-registration-invalid" });
  const relative = path.relative(root, filePath);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const stat = await lstatIfPresent(fsOps, current);
    if (!stat) return { exists: false, content: "" };
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ClaudeIntegrationError(`${current} 不是项目内安全目录；未修改用户项目。`, { code: "external-registration-invalid" });
    }
  }
  const stat = await lstatIfPresent(fsOps, filePath);
  if (!stat) return { exists: false, content: "" };
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ClaudeIntegrationError(`${label}必须是普通文件；未修改用户项目。`, { code: "external-registration-invalid" });
  }
  const content = await fsOps.readFile(filePath, "utf8");
  const afterRead = await lstatIfPresent(fsOps, filePath);
  if (!afterRead || afterRead.isSymbolicLink() || !afterRead.isFile()) {
    throw new ClaudeIntegrationError(`${label}在读取时发生了不安全变更；未修改用户项目。`, { code: "external-registration-invalid" });
  }
  return { exists: true, content };
}

async function readOptionalSafeProjectBinaryFile(fsOps, root, filePath, label) {
  if (!inside(root, filePath)) throw new ClaudeIntegrationError("外部能力注册目标路径无效。", { code: "external-registration-invalid" });
  const relative = path.relative(root, filePath);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const stat = await lstatIfPresent(fsOps, current);
    if (!stat) return { exists: false, content: Buffer.alloc(0) };
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ClaudeIntegrationError(`${current} 不是项目内安全目录；未修改用户项目。`, { code: "external-registration-invalid" });
    }
  }
  const stat = await lstatIfPresent(fsOps, filePath);
  if (!stat) return { exists: false, content: Buffer.alloc(0) };
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ClaudeIntegrationError(`${label}必须是普通文件；未修改用户项目。`, { code: "external-registration-invalid" });
  }
  const raw = await fsOps.readFile(filePath);
  const content = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const afterRead = await lstatIfPresent(fsOps, filePath);
  if (!afterRead || afterRead.isSymbolicLink() || !afterRead.isFile() || afterRead.size !== content.byteLength) {
    throw new ClaudeIntegrationError(`${label}在读取时发生了不安全变更；未修改用户项目。`, { code: "external-registration-invalid" });
  }
  return { exists: true, content };
}

function externalSkillRelativePath(value, { code = "external-source-invalid", label = "外部 Skill 文件路径" } = {}) {
  const source = typeof value === "string" ? value : "";
  const invalid = () => { throw new ClaudeIntegrationError(`${label}必须是包内使用 / 的安全相对路径。`, { code }); };
  if (!source || source.length > 1_000 || /[\r\n\u0000]/u.test(source) || source.includes("\\") || path.posix.isAbsolute(source) || path.win32.isAbsolute(source)) invalid();
  const segments = source.split("/");
  if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === "..")) invalid();
  if (segments.length - 1 > EXTERNAL_SKILL_MAX_DEPTH) {
    throw new ClaudeIntegrationError(`外部 Skill 文件目录层级不能超过 ${EXTERNAL_SKILL_MAX_DEPTH} 层。`, { code });
  }
  const normalized = segments.join("/");
  if (normalized === EXTERNAL_SKILL_METADATA_FILE) {
    throw new ClaudeIntegrationError("外部 Skill 包不能覆盖 Suzu Lives 的受管标记文件。", { code });
  }
  return normalized;
}

function externalSkillBytes(value, label) {
  let content;
  if (Buffer.isBuffer(value)) content = Buffer.from(value);
  else if (typeof value === "string") content = Buffer.from(value, "utf8");
  else if (value instanceof Uint8Array) content = Buffer.from(value);
  else throw new ClaudeIntegrationError(`${label}必须是普通文件内容。`, { code: "external-source-invalid" });
  if (content.byteLength > EXTERNAL_SKILL_MAX_FILE_BYTES) {
    throw new ClaudeIntegrationError(`${label}不能超过 ${EXTERNAL_SKILL_MAX_FILE_BYTES.toLocaleString("zh-CN")} 字节。`, { code: "external-source-invalid" });
  }
  return content;
}

function parseExternalSkillMetadata(content, capabilityId) {
  const metadata = parseJsonObject(content, "外部 Skill 受管标记", "external-skill-conflict");
  const expectedId = externalCapabilityId(capabilityId);
  if (metadata.capabilityId !== expectedId) {
    throw new ClaudeIntegrationError("同名外部 Skill 没有有效的 Suzu Lives 受管标记，未覆盖用户文件。", { code: "external-skill-conflict" });
  }
  if (metadata.schemaVersion === 1 && /^[a-f0-9]{64}$/u.test(clean(metadata.contentSha256))) {
    return {
      ...metadata,
      files: { "SKILL.md": clean(metadata.contentSha256) },
      legacy: true,
    };
  }
  if (metadata.schemaVersion !== EXTERNAL_SKILL_METADATA_VERSION || !record(metadata.files)) {
    throw new ClaudeIntegrationError("同名外部 Skill 没有有效的 Suzu Lives 受管标记，未覆盖用户文件。", { code: "external-skill-conflict" });
  }
  const entries = Object.entries(metadata.files);
  if (!entries.length || entries.length > EXTERNAL_SKILL_MAX_FILES) {
    throw new ClaudeIntegrationError("外部 Skill 受管文件清单无效，未覆盖用户文件。", { code: "external-skill-conflict" });
  }
  const files = {};
  const pathKeys = new Set();
  for (const [rawPath, hash] of entries) {
    const relativePath = externalSkillRelativePath(rawPath, { code: "external-skill-conflict", label: "外部 Skill 受管文件路径" });
    const pathKey = process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
    if (relativePath !== rawPath || Object.hasOwn(files, relativePath) || pathKeys.has(pathKey) || !/^[a-f0-9]{64}$/u.test(clean(hash))) {
      throw new ClaudeIntegrationError("外部 Skill 受管文件清单无效，未覆盖用户文件。", { code: "external-skill-conflict" });
    }
    pathKeys.add(pathKey);
    files[relativePath] = clean(hash);
  }
  if (!Object.hasOwn(files, "SKILL.md")) {
    throw new ClaudeIntegrationError("外部 Skill 受管文件清单缺少 SKILL.md，未覆盖用户文件。", { code: "external-skill-conflict" });
  }
  return { ...metadata, files, legacy: false };
}

function renderExternalSkillContent({ capabilityId, content }) {
  const bytes = externalSkillBytes(content, "外部 SKILL.md");
  const source = bytes.toString("utf8");
  if (!source.trim() || !Buffer.from(source, "utf8").equals(bytes)) {
    throw new ClaudeIntegrationError("外部 SKILL.md 必须是非空 UTF-8 文本，未写入用户项目。", { code: "external-source-invalid" });
  }
  const trailingNewline = source.endsWith("\n") ? source : `${source}\n`;
  return `${trailingNewline}\n${EXTERNAL_SKILL_MARKER_PREFIX}${externalCapabilityId(capabilityId)} -->\n`;
}

function normalizeExternalSkillFiles(skill, capabilityId) {
  if (!record(skill)) throw new ClaudeIntegrationError("外部 Skill 安装内容无效。", { code: "external-source-invalid" });
  const supplied = Array.isArray(skill.files)
    ? skill.files
    : [{ relativePath: "SKILL.md", content: skill.content, sourcePath: skill.sourcePath }];
  if (!supplied.length || supplied.length > EXTERNAL_SKILL_MAX_FILES) {
    throw new ClaudeIntegrationError(`外部 Skill 包必须包含 1 至 ${EXTERNAL_SKILL_MAX_FILES} 个文件。`, { code: "external-source-invalid" });
  }
  const seen = new Set();
  const files = [];
  let totalBytes = 0;
  for (const item of supplied) {
    if (!record(item)) throw new ClaudeIntegrationError("外部 Skill 包文件无效。", { code: "external-source-invalid" });
    const relativePath = externalSkillRelativePath(item.relativePath);
    const key = process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
    if (seen.has(key)) throw new ClaudeIntegrationError("外部 Skill 包包含重复文件路径。", { code: "external-source-invalid" });
    seen.add(key);
    let content = externalSkillBytes(item.content, `外部 Skill 文件 ${relativePath}`);
    if (relativePath === "SKILL.md") content = Buffer.from(renderExternalSkillContent({ capabilityId, content }), "utf8");
    totalBytes += content.byteLength;
    if (totalBytes > EXTERNAL_SKILL_MAX_TOTAL_BYTES) {
      throw new ClaudeIntegrationError(`外部 Skill 包总大小不能超过 ${EXTERNAL_SKILL_MAX_TOTAL_BYTES.toLocaleString("zh-CN")} 字节。`, { code: "external-source-invalid" });
    }
    files.push({ relativePath, content });
  }
  if (!files.some((file) => file.relativePath === "SKILL.md")) {
    throw new ClaudeIntegrationError("外部 Skill 包必须在根目录包含 SKILL.md。", { code: "external-source-invalid" });
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
}

function externalSkillTarget(folder, relativePath) {
  const target = path.resolve(folder, ...relativePath.split("/"));
  if (!inside(folder, target)) {
    throw new ClaudeIntegrationError("外部 Skill 注册目标路径无效。", { code: "external-registration-invalid" });
  }
  return target;
}

async function ensureExternalSkillParent(fsOps, root, target) {
  const relative = path.relative(root, path.dirname(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ClaudeIntegrationError("外部 Skill 注册目标目录无效。", { code: "external-registration-invalid" });
  }
  await ensureSafeDirectory(fsOps, root, relative.split(path.sep).filter(Boolean));
}

async function verifiedExternalSkillFiles({ root, folder, ownership, fsOps }) {
  const files = new Map();
  for (const [relativePath, hash] of Object.entries(ownership.files)) {
    const target = externalSkillTarget(folder, relativePath);
    const existing = await readOptionalSafeProjectBinaryFile(fsOps, root, target, `外部 Skill 文件 ${relativePath}`);
    if (!existing.exists || sha256(existing.content) !== hash) {
      throw new ClaudeIntegrationError(`已登记的外部 Skill 文件 ${relativePath} 被删除或手动修改，未覆盖用户文件。`, { code: "external-skill-modified" });
    }
    files.set(relativePath, { path: target, label: `外部 Skill 文件 ${relativePath}`, previous: existing });
  }
  return files;
}

async function prepareExternalSkillWrite({ root, capabilityId, version, skill, fsOps }) {
  const id = externalCapabilityId(capabilityId);
  const files = normalizeExternalSkillFiles(skill, id);
  const folder = await ensureSafeDirectory(fsOps, root, [".claude", "skills", externalSkillDirectory(id)]);
  const metadataPath = path.join(folder, EXTERNAL_SKILL_METADATA_FILE);
  const existingMetadata = await readOptionalSafeProjectFile(fsOps, root, metadataPath, "外部 Skill 受管标记");
  const ownership = existingMetadata.exists ? parseExternalSkillMetadata(existingMetadata.content, id) : null;
  const managed = ownership ? await verifiedExternalSkillFiles({ root, folder, ownership, fsOps }) : new Map();
  const nextPaths = new Set(files.map((file) => file.relativePath));
  const writes = [];
  for (const file of files) {
    const target = externalSkillTarget(folder, file.relativePath);
    const previous = managed.get(file.relativePath)?.previous
      || await readOptionalSafeProjectBinaryFile(fsOps, root, target, `外部 Skill 文件 ${file.relativePath}`);
    if (!managed.has(file.relativePath) && previous.exists) {
      throw new ClaudeIntegrationError(`目标外部 Skill 文件 ${file.relativePath} 不属于 Suzu Lives，未覆盖用户文件。`, { code: "external-skill-conflict" });
    }
    writes.push({ path: target, label: `外部 Skill 文件 ${file.relativePath}`, content: file.content, previous });
  }
  for (const file of writes) await ensureExternalSkillParent(fsOps, root, file.path);
  const metadata = {
    schemaVersion: EXTERNAL_SKILL_METADATA_VERSION,
    capabilityId: id,
    version: externalVersion(version),
    files: Object.fromEntries(files.map((file) => [file.relativePath, sha256(file.content)])),
    sourcePath: clean(skill?.sourcePath).slice(0, 4_000),
    registeredAt: new Date().toISOString(),
  };
  const removals = [...managed.entries()]
    .filter(([relativePath]) => !nextPaths.has(relativePath))
    .map(([, file]) => ({ ...file, delete: true }));
  return [
    ...removals,
    ...writes,
    { path: metadataPath, label: "外部 Skill 受管标记", content: `${JSON.stringify(metadata, null, 2)}\n`, previous: existingMetadata },
  ];
}

function parseExternalMcpMetadata(content) {
  const parsed = parseJsonObject(content, "外部 MCP 受管标记", "external-mcp-conflict");
  if (!Object.keys(parsed).length) return { schemaVersion: EXTERNAL_MCP_METADATA_VERSION, entries: {} };
  if (parsed.schemaVersion !== EXTERNAL_MCP_METADATA_VERSION || !record(parsed.entries)) {
    throw new ClaudeIntegrationError("外部 MCP 受管标记格式无效，未修改用户项目。", { code: "external-mcp-conflict" });
  }
  const entries = {};
  for (const [id, entry] of Object.entries(parsed.entries)) {
    if (!EXTERNAL_ID.test(id) || !record(entry) || entry.serverName !== externalMcpServerName(id) || !/^[a-f0-9]{64}$/u.test(clean(entry.configurationSha256))) {
      throw new ClaudeIntegrationError("外部 MCP 受管标记包含无效条目，未修改用户项目。", { code: "external-mcp-conflict" });
    }
    entries[id] = { ...entry };
  }
  return { schemaVersion: EXTERNAL_MCP_METADATA_VERSION, entries };
}

function parseMcpProjectConfig(content) {
  const configuration = parseJsonObject(content, ".mcp.json", "external-mcp-conflict");
  if (configuration.mcpServers !== undefined && !record(configuration.mcpServers)) {
    throw new ClaudeIntegrationError(".mcp.json 的 mcpServers 必须是对象，未修改用户项目。", { code: "external-mcp-conflict" });
  }
  return { configuration, servers: { ...(configuration.mcpServers || {}) } };
}

async function prepareExternalMcpWrite({ root, capabilityId, version, configuration, fsOps }) {
  const id = externalCapabilityId(capabilityId);
  const claudeDirectory = await ensureSafeDirectory(fsOps, root, [".claude"]);
  const mcpPath = path.join(root, ".mcp.json");
  const metadataPath = path.join(claudeDirectory, EXTERNAL_MCP_METADATA_FILE);
  const [existingMcp, existingMetadata] = await Promise.all([
    readTextIfPresent(fsOps, root, mcpPath, ".mcp.json"),
    readTextIfPresent(fsOps, root, metadataPath, "外部 MCP 受管标记"),
  ]);
  const project = parseMcpProjectConfig(existingMcp.content);
  const metadata = parseExternalMcpMetadata(existingMetadata.content);
  const serverName = externalMcpServerName(id);
  const currentServer = project.servers[serverName];
  const currentOwnership = metadata.entries[id];
  if (currentServer !== undefined) {
    if (!currentOwnership || currentOwnership.serverName !== serverName) {
      throw new ClaudeIntegrationError("同名 MCP 条目不属于 Suzu Lives，未覆盖用户配置。", { code: "external-mcp-conflict" });
    }
    if (jsonHash(currentServer) !== currentOwnership.configurationSha256) {
      throw new ClaudeIntegrationError("已登记的 MCP 条目被手动修改，未覆盖用户配置。", { code: "external-mcp-modified" });
    }
  } else if (currentOwnership && currentOwnership.serverName !== serverName) {
    throw new ClaudeIntegrationError("外部 MCP 受管标记与目标条目不一致，未修改用户项目。", { code: "external-mcp-conflict" });
  }
  const serverConfiguration = jsonObject(configuration, "外部 MCP 配置");
  const nextServers = { ...project.servers, [serverName]: serverConfiguration };
  const nextMetadata = {
    schemaVersion: EXTERNAL_MCP_METADATA_VERSION,
    entries: {
      ...metadata.entries,
      [id]: {
        serverName,
        version: externalVersion(version),
        configurationSha256: jsonHash(serverConfiguration),
        registeredAt: new Date().toISOString(),
      },
    },
  };
  const nextMcp = { ...project.configuration, mcpServers: nextServers };
  return [
    { path: mcpPath, label: ".mcp.json", content: `${JSON.stringify(nextMcp, null, 2)}\n`, previous: existingMcp },
    { path: metadataPath, label: "外部 MCP 受管标记", content: `${JSON.stringify(nextMetadata, null, 2)}\n`, previous: existingMetadata },
  ];
}

async function prepareExternalSkillRemoval({ root, capabilityId, fsOps }) {
  const id = externalCapabilityId(capabilityId);
  const folder = path.join(root, ".claude", "skills", externalSkillDirectory(id));
  const skillPath = path.join(folder, "SKILL.md");
  const metadataPath = path.join(folder, EXTERNAL_SKILL_METADATA_FILE);
  const [existingSkill, existingMetadata] = await Promise.all([
    readOptionalSafeProjectBinaryFile(fsOps, root, skillPath, "外部 SKILL.md"),
    readOptionalSafeProjectFile(fsOps, root, metadataPath, "外部 Skill 受管标记"),
  ]);
  if (!existingSkill.exists && !existingMetadata.exists) return [];
  if (!existingMetadata.exists) {
    throw new ClaudeIntegrationError("当前同名外部 SKILL.md 不属于 Suzu Lives，未移除用户文件。", { code: "external-skill-conflict" });
  }
  const ownership = parseExternalSkillMetadata(existingMetadata.content, id);
  const managed = await verifiedExternalSkillFiles({ root, folder, ownership, fsOps });
  return [
    ...[...managed.values()].map((file) => ({ ...file, delete: true })),
    { path: metadataPath, label: "外部 Skill 受管标记", delete: true, previous: existingMetadata },
  ];
}

async function prepareExternalMcpRemoval({ root, capabilityId, fsOps }) {
  const id = externalCapabilityId(capabilityId);
  const mcpPath = path.join(root, ".mcp.json");
  const metadataPath = path.join(root, ".claude", EXTERNAL_MCP_METADATA_FILE);
  const [existingMcp, existingMetadata] = await Promise.all([
    readOptionalSafeProjectFile(fsOps, root, mcpPath, ".mcp.json"),
    readOptionalSafeProjectFile(fsOps, root, metadataPath, "外部 MCP 受管标记"),
  ]);
  if (!existingMetadata.exists) return [];
  const metadata = parseExternalMcpMetadata(existingMetadata.content);
  const ownership = metadata.entries[id];
  if (!ownership) return [];
  const serverName = externalMcpServerName(id);
  if (ownership.serverName !== serverName) {
    throw new ClaudeIntegrationError("外部 MCP 受管标记与目标条目不一致，未移除用户配置。", { code: "external-mcp-conflict" });
  }
  const files = [];
  const nextEntries = { ...metadata.entries };
  delete nextEntries[id];
  if (existingMcp.exists) {
    const project = parseMcpProjectConfig(existingMcp.content);
    const currentServer = project.servers[serverName];
    if (currentServer !== undefined) {
      if (jsonHash(currentServer) !== ownership.configurationSha256) {
        throw new ClaudeIntegrationError("已登记的 MCP 条目被手动修改，未移除用户配置。", { code: "external-mcp-modified" });
      }
      const nextServers = { ...project.servers };
      delete nextServers[serverName];
      files.push({
        path: mcpPath,
        label: ".mcp.json",
        content: `${JSON.stringify({ ...project.configuration, mcpServers: nextServers }, null, 2)}\n`,
        previous: existingMcp,
      });
    }
  }
  files.push({
    path: metadataPath,
    label: "外部 MCP 受管标记",
    content: `${JSON.stringify({ schemaVersion: EXTERNAL_MCP_METADATA_VERSION, entries: nextEntries }, null, 2)}\n`,
    previous: existingMetadata,
  });
  return files;
}

async function inspectExternalSkill({ root, capabilityId, fsOps }) {
  const id = externalCapabilityId(capabilityId);
  const folder = path.join(root, ".claude", "skills", externalSkillDirectory(id));
  const [skill, metadata] = await Promise.all([
    readOptionalSafeProjectBinaryFile(fsOps, root, path.join(folder, "SKILL.md"), "外部 SKILL.md"),
    readOptionalSafeProjectFile(fsOps, root, path.join(folder, EXTERNAL_SKILL_METADATA_FILE), "外部 Skill 受管标记"),
  ]);
  if (!skill.exists && !metadata.exists) return { registered: false, reason: "当前项目没有这项外部 Skill 的受管登记。", version: "" };
  if (!metadata.exists) return { registered: false, reason: "当前同名外部 SKILL.md 不属于 Suzu Lives。", version: "" };
  try {
    const ownership = parseExternalSkillMetadata(metadata.content, id);
    await verifiedExternalSkillFiles({ root, folder, ownership, fsOps });
    return { registered: true, reason: "当前项目已登记这项外部 Skill。", version: clean(ownership.version) };
  } catch (error) {
    return { registered: false, reason: clean(error?.message) || "外部 Skill 受管标记无效。", version: "" };
  }
}

async function inspectExternalMcp({ root, capabilityId, fsOps }) {
  const id = externalCapabilityId(capabilityId);
  const [mcp, metadata] = await Promise.all([
    readOptionalSafeProjectFile(fsOps, root, path.join(root, ".mcp.json"), ".mcp.json"),
    readOptionalSafeProjectFile(fsOps, root, path.join(root, ".claude", EXTERNAL_MCP_METADATA_FILE), "外部 MCP 受管标记"),
  ]);
  if (!metadata.exists) return { registered: false, reason: "当前项目没有这项外部 MCP 的受管登记。", version: "" };
  try {
    const tracking = parseExternalMcpMetadata(metadata.content);
    const ownership = tracking.entries[id];
    if (!ownership) return { registered: false, reason: "当前项目没有这项外部 MCP 的受管登记。", version: "" };
    if (!mcp.exists) return { registered: false, reason: "外部 MCP 受管标记存在，但 .mcp.json 缺失。", version: clean(ownership.version) };
    const project = parseMcpProjectConfig(mcp.content);
    const server = project.servers[ownership.serverName];
    if (server === undefined) return { registered: false, reason: "外部 MCP 受管标记存在，但目标条目缺失。", version: clean(ownership.version) };
    if (jsonHash(server) !== ownership.configurationSha256) return { registered: false, reason: "已登记的 MCP 条目被手动修改。", version: clean(ownership.version) };
    return { registered: true, reason: "当前项目已登记这项外部 MCP。", version: clean(ownership.version) };
  } catch (error) {
    return { registered: false, reason: clean(error?.message) || "外部 MCP 配置无效。", version: "" };
  }
}

/**
 * Writes only Suzu-owned external capability files. It never starts a
 * third-party command or contacts a server; Claude Code may use the written
 * project configuration only after its own normal approval flow.
 */
export async function writeExternalClaudeRegistration({ projectRoot, capabilityId, version, skill = null, mcp = null, fsOps = fs } = {}) {
  const id = externalCapabilityId(capabilityId);
  if (!skill && !mcp) throw new ClaudeIntegrationError("外部能力至少需要一个可登记的 Skill 或 MCP 适配器。", { code: "external-manifest-invalid" });
  const root = await resolveSafeProjectRoot(projectRoot, fsOps);
  const files = [];
  if (skill) files.push(...(await prepareExternalSkillWrite({ root, capabilityId: id, version, skill, fsOps })));
  if (mcp) files.push(...(await prepareExternalMcpWrite({ root, capabilityId: id, version, configuration: mcp.configuration, fsOps })));
  await writeRegistrationTransaction(fsOps, root, files);
  return { capabilityId: id, files: files.map((file) => file.path) };
}

/** Removes only entries accompanied by Suzu's ownership metadata and hash. */
export async function removeExternalClaudeRegistration({ projectRoot, capabilityId, types, fsOps = fs } = {}) {
  const id = externalCapabilityId(capabilityId);
  const root = await resolveSafeProjectRoot(projectRoot, fsOps);
  const files = [];
  for (const type of externalTypes(types)) {
    if (type === "skill") files.push(...(await prepareExternalSkillRemoval({ root, capabilityId: id, fsOps })));
    if (type === "mcp") files.push(...(await prepareExternalMcpRemoval({ root, capabilityId: id, fsOps })));
  }
  if (files.length) await writeRegistrationTransaction(fsOps, root, files);
  return { capabilityId: id, removed: files.length > 0, files: files.map((file) => file.path) };
}

/** Reads external registration state without modifying the selected project. */
export async function inspectExternalClaudeRegistration({ projectRoot, capabilityId, types, fsOps = fs } = {}) {
  const id = externalCapabilityId(capabilityId);
  const selectedTypes = externalTypes(types);
  if (!clean(projectRoot)) {
    const unavailable = { registered: false, reason: "尚未选择当前联系人的 Claude 项目目录。", version: "" };
    return { capabilityId: id, skill: selectedTypes.includes("skill") ? unavailable : null, mcp: selectedTypes.includes("mcp") ? unavailable : null, registered: false };
  }
  let root;
  try { root = await resolveSafeProjectRoot(projectRoot, fsOps); }
  catch (error) {
    const unavailable = { registered: false, reason: clean(error?.message) || "当前 Claude 项目不可读取。", version: "" };
    return { capabilityId: id, skill: selectedTypes.includes("skill") ? unavailable : null, mcp: selectedTypes.includes("mcp") ? unavailable : null, registered: false };
  }
  const [skill, mcp] = await Promise.all([
    selectedTypes.includes("skill") ? inspectExternalSkill({ root, capabilityId: id, fsOps }) : null,
    selectedTypes.includes("mcp") ? inspectExternalMcp({ root, capabilityId: id, fsOps }) : null,
  ]);
  return { capabilityId: id, skill, mcp, registered: [skill, mcp].filter(Boolean).every((entry) => entry.registered === true) };
}
