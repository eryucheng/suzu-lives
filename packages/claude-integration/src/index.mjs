import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { CAPABILITY_DEFINITIONS, getCapabilityDefinition } from "@suzu-lives/capability-registry";
import { PROACTIVE_CONTACT_ID, PROACTIVE_CONTACT_NAME, renderProactiveContactSkill } from "@suzu-lives/proactive-contact";
import { renderTravelingMerchantSkill, travelingMerchantDefaultConfig, TRAVELING_MERCHANT_ID, TRAVELING_MERCHANT_NAME } from "@suzu-lives/traveling-merchant";

export { travelingMerchantDefaultConfig };

export class ClaudeIntegrationError extends Error { constructor(message, { code = "" } = {}) { super(message); this.code = code; } }

const CLAUDE_START = "<!-- suzu-lives:managed:start -->";
const CLAUDE_END = "<!-- suzu-lives:managed:end -->";
const ABILITIES_START = "<!-- suzu-lives:abilities:start -->";
const ABILITIES_END = "<!-- suzu-lives:abilities:end -->";
const ABILITY_MARKER_PREFIX = "<!-- suzu-lives:ability:";
const TIME_AWARENESS_ID = "time-awareness";
const PLAYWRIGHT_CLI_PERMISSION = "Bash(playwright-cli *)";
const SELECTABLE_CLAUDE_TOOL_PERMISSIONS = Object.freeze([
  ["read", "Read"],
  ["webFetch", "WebFetch"],
  ["webSearch", "WebSearch"],
]);
const AGENT_ABILITY_CATALOG = Object.freeze([
  { id: "image-generation", name: "图像生成", description: "生成、编辑图片，并可结合视觉参考。", category: "create", setting: { route: "api", label: "设置图片" } },
  { id: "phone-camera", name: "手机拍照式图像", description: "生成具有手机拍摄感的图片。", category: "create", setting: { route: "api", label: "设置图片" } },
  { id: "visual-reference-manager", name: "视觉参考库", description: "整理、检索并应用视觉参考。", category: "create", setting: { route: "visual", label: "打开视觉工作台" } },
  { id: "image-vision", name: "图像理解", description: "理解一张明确提供的本地图片。", category: "perceive", setting: { route: "api", label: "设置图像理解" } },
  { id: "video-understanding", name: "视频理解", description: "理解一段明确提供的视频。", category: "perceive", setting: { route: "api", label: "设置视频理解" } },
  { id: TIME_AWARENESS_ID, name: "时间感知", description: "每次收到消息时感知本机日期、星期与当前时间。", category: "perceive" },
  { id: "voice-message", name: "语音消息", description: "将文字或已有音频通过既有通道发送。", category: "create", setting: { route: "audio", label: "打开音色设计" } },
  { id: "web-browser", name: "网页浏览", description: "使用软件拥有的浏览器处理已登录网页。", category: "perceive" },
  { id: "site-automation", name: "网页自动化", description: "为每个已接入的网站单独管理可用动作。", category: "act" },
  { id: "iphone-bridge", name: "iPhone 互通", description: "调用 Suzu Lives 中配置的 iPhone 快捷指令。", category: "act" },
  { id: "proactive-contact", name: "主动关心", description: "在 Suzu 运行期间用自动任务安排主动联系。", category: "companion" },
  { id: "traveling-merchant", name: "旅行商人", description: "运行已有的旅行商人监控与通知流程。", category: "companion" },
]);
const DIRECT_COMPATIBILITY_ABILITIES = new Map([
  ["image-generation", { id: "image-generation", name: "图像生成", renderSkill: renderImageGenerationSkill }],
  ["phone-camera", { id: "phone-camera", name: "手机拍照式生图", renderSkill: renderPhoneCameraSkill }],
  ["visual-reference-manager", { id: "visual-reference-manager", name: "视觉参考资料库", renderSkill: renderVisualReferenceManagerSkill }],
  [TIME_AWARENESS_ID, { id: TIME_AWARENESS_ID, name: "时间感知", renderSkill: renderTimeAwarenessSkill }],
  ["web-browser", { id: "web-browser", name: "网页浏览", renderSkill: renderWebBrowserSkill }],
  ["site-automation", { id: "site-automation", name: "网页自动化", renderSkill: renderSiteAutomationSkill }],
  ["iphone-bridge", { id: "iphone-bridge", name: "iPhone Bridge", renderSkill: renderIphoneBridgeSkill }],
  [PROACTIVE_CONTACT_ID, { id: PROACTIVE_CONTACT_ID, name: PROACTIVE_CONTACT_NAME, renderSkill: renderProactiveContactSkill }],
  [TRAVELING_MERCHANT_ID, { id: TRAVELING_MERCHANT_ID, name: TRAVELING_MERCHANT_NAME, renderSkill: renderTravelingMerchantSkill }],
]);

function clean(value) {
  return String(value ?? "").trim();
}

function safeCommand(value) {
  const command = clean(value || "suzu-lives");
  const portableCli = /^"([A-Za-z]:[\\/][^"\r\n]{1,240}\.exe)" --suzu-lives-cli$/iu;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(command) && !portableCli.test(command)) throw new ClaudeIntegrationError("稳定启动命令格式无效。");
  return command;
}

function assertLauncher(launcher = {}) {
  const command = safeCommand(launcher.command);
  if (launcher.available !== true) throw new ClaudeIntegrationError(`未找到稳定启动命令 ${command}，因此不会写入 Claude 注册文件。`);
  return command;
}

function directCompatibilityAbility(abilityId) {
  return DIRECT_COMPATIBILITY_ABILITIES.get(clean(abilityId).toLowerCase()) || null;
}

function knownRegistrationAbility(abilityId) {
  return Boolean(directCompatibilityAbility(abilityId) || getCapabilityDefinition(abilityId));
}

export function claudeRegistrationAbilityIds() {
  return [...new Set([
    ...DIRECT_COMPATIBILITY_ABILITIES.keys(),
    ...CAPABILITY_DEFINITIONS.filter((item) => item.claudeRegistration && item.executorAttached && item.migration !== "deferred").map((item) => item.id),
  ])].sort();
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
  const direct = directCompatibilityAbility(abilityId);
  if (direct) return direct;
  const capability = getCapabilityDefinition(abilityId);
  if (!capability) throw new ClaudeIntegrationError("未找到该 Suzu Lives 能力。");
  if (!capability.claudeRegistration || capability.migration === "deferred" || capability.executorAttached !== true) {
    throw new ClaudeIntegrationError("该能力尚未接入可注册的软件执行器。");
  }
  return capability;
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
  return `Bash(${safeCommand(command)}:*)`;
}

function isSuzuCliBashPermission(value) {
  return /^Bash\(\s*(?:suzu-lives|"[A-Za-z]:[\\/][^"\r\n]{1,240}\.exe"\s+--suzu-lives-cli):\*\)$/iu.test(clean(value));
}

function updateSuzuClaudeProjectSettings(existing, { command, toolPermissions } = {}) {
  const settings = parseClaudeProjectSettings(existing.content);
  if (settings.permissions !== undefined && !record(settings.permissions)) {
    throw new ClaudeIntegrationError(".claude/settings.json 的 permissions 必须是对象，未修改 Claude 项目设置。 ");
  }
  const permissions = { ...(settings.permissions || {}) };
  if (permissions.allow !== undefined && !Array.isArray(permissions.allow)) {
    throw new ClaudeIntegrationError(".claude/settings.json 的 permissions.allow 必须是数组，未修改 Claude 项目设置。 ");
  }
  const existingAllow = permissions.allow || [];
  if (existingAllow.some((item) => typeof item !== "string")) {
    throw new ClaudeIntegrationError(".claude/settings.json 的 permissions.allow 只能包含字符串，未修改 Claude 项目设置。 ");
  }

  const currentSuzuPermission = suzuCliBashPermission(command);
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
  if (!nextAllow.includes(PLAYWRIGHT_CLI_PERMISSION)) {
    nextAllow.push(PLAYWRIGHT_CLI_PERMISSION);
    changed = true;
  }
  for (const permission of enabledSelectablePermissions) {
    if (selectablePermissionsSeen.has(permission)) continue;
    nextAllow.push(permission);
    changed = true;
  }
  if (settings.skipWebFetchPreflight !== true) changed = true;

  if (!changed) return { changed: false, content: existing.content };
  return {
    changed: true,
    content: `${JSON.stringify({
      ...settings,
      skipWebFetchPreflight: true,
      permissions: { ...permissions, allow: nextAllow },
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

async function prepareSuzuClaudeProjectSettings({ root, command, toolPermissions, fsOps }) {
  const claudeDirectory = await ensureSafeDirectory(fsOps, root, [".claude"]);
  const settingsPath = path.join(claudeDirectory, "settings.json");
  await assertSafeFile(fsOps, root, settingsPath, ".claude/settings.json");
  const existing = await readTextIfPresent(fsOps, root, settingsPath, ".claude/settings.json");
  return {
    settingsPath,
    existing,
    updated: updateSuzuClaudeProjectSettings(existing, { command, toolPermissions }),
  };
}

export async function ensureSuzuClaudeProjectSettings({ projectRoot, launcher = {}, toolPermissions, fsOps = fs } = {}) {
  const command = assertLauncher(launcher);
  const root = await resolveSafeProjectRoot(projectRoot, fsOps);
  const prepared = await prepareSuzuClaudeProjectSettings({ root, command, toolPermissions, fsOps });
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

export function renderClaudeManagedBlock({ abilityIds, command = "suzu-lives" } = {}) {
  const launcher = safeCommand(command);
  const ids = [...new Set((abilityIds || []).map((value) => clean(value).toLowerCase()))]
    .filter((id) => knownRegistrationAbility(id))
    .sort();
  const directAbilityIds = new Set(["image-vision", "video-understanding", TIME_AWARENESS_ID, "voice-message", "image-generation", "phone-camera", "visual-reference-manager", "web-browser", "site-automation", "iphone-bridge", PROACTIVE_CONTACT_ID, TRAVELING_MERCHANT_ID]);
  const bullets = ids.map((id) => {
    if (id === "image-vision") return `- <!-- suzu-lives:ability:${id} --> \`${id}\`：使用 \`${launcher} image-vision <local-image>\` 调用软件拥有的兼容执行器。`;
    if (id === "video-understanding") return `- <!-- suzu-lives:ability:${id} --> \`${id}\`：使用 \`${launcher} video-understanding <local-video-or-http-url>\` 调用软件拥有的兼容执行器。`;
    if (id === TIME_AWARENESS_ID) return `- <!-- suzu-lives:ability:${id} --> \`${id}\`：由 Suzu 在每次用户消息进入时注入本机日期、星期和当前时间；不需要手动调用命令。`;
    if (id === "voice-message") return `- <!-- suzu-lives:ability:${id} --> \`${id}\`：使用 \`${launcher} voice-message <text>\` 调用软件拥有的兼容执行器。`;
    if (id === "image-generation") return `- <!-- suzu-lives:ability:${id} --> \`${id}\`：使用 \`${launcher} image-generation --prompt <visible-scene>\` 调用软件拥有的图像引擎。`;
    if (id === "phone-camera") return `- <!-- suzu-lives:ability:${id} --> \`${id}\`：使用 \`${launcher} phone-camera --shot <rear|selfie|mirror> --scene <visible-scene>\` 生成手机拍照式图片。`;
    if (id === "visual-reference-manager") return `- <!-- suzu-lives:ability:${id} --> \`${id}\`：使用 \`${launcher} visual-reference-manager init|list|show|validate|apply\` 维护软件资料库。`;
    if (id === "web-browser") return `- <!-- suzu-lives:ability:${id} --> \`${id}\`：使用 \`${launcher} web-browser\` 启动或检查软件拥有的专用 Chrome。`;
    if (id === "site-automation") return `- <!-- suzu-lives:ability:${id} --> \`${id}\`：使用 \`${launcher} site <site> <action>\` 调用软件拥有的已接入网站适配器。`;
    if (id === "iphone-bridge") return `- <!-- suzu-lives:ability:${id} --> \`${id}\`：使用 \`${launcher} iphone-bridge send ...\` 向 iPhone 发出请求；反馈监听由正在运行的 Suzu 直接处理。`;
    if (id === PROACTIVE_CONTACT_ID) return `- <!-- suzu-lives:ability:${id} --> \`${id}\`：使用已注册的轻量 Skill 按 Suzu \`schedule\` 语义管理链式关心和一次性回访。`;
    if (id === TRAVELING_MERCHANT_ID) return `- <!-- suzu-lives:ability:${id} --> \`${id}\`：使用 \`${launcher} traveling-merchant\` 调用软件拥有的监控执行器。`;
    return `- <!-- suzu-lives:ability:${id} --> \`${id}\`：使用 \`${launcher} ability status --id ${id}\` 先确认软件状态。`;
  }).join("\n");
  const notices = [];
  if (ids.includes("image-vision")) notices.push(`\`image-vision\` 使用独立的软件拥有命令，不通过 \`ability plan\` 或 \`ability invoke\`；它仍只读取明确给出的本地图片和软件数据目录中的配置。`);
  if (ids.includes("video-understanding")) notices.push(`\`video-understanding\` 使用独立的软件拥有命令，不通过 \`ability plan\` 或 \`ability invoke\`；它只处理明确给出的本地视频或 http(s) URL，并把临时片段、缓存、保留片段和配置限制在软件数据目录。`);
  if (ids.includes(TIME_AWARENESS_ID)) notices.push(`\`time-awareness\` 通过 Suzu 受管的 \`UserPromptSubmit\` Hook 注入本轮当前本地时间；它不读取消息正文、不联网、不写入聊天记录，也不替代其他同事件 Hook。`);
  if (ids.includes("voice-message")) notices.push(`\`voice-message\` 使用独立的软件拥有命令，不通过 \`ability plan\` 或 \`ability invoke\`；它只在软件数据目录中生成 MP3，再由当前 Suzu 会话的附件交付命令显示和投递。`);
  if (ids.includes("image-generation")) notices.push(`\`image-generation\` 使用独立的软件拥有命令，不通过 \`ability plan\` 或 \`ability invoke\`；默认后端、运行记录、候选图片与连接配置仍只位于当前 Agent 的软件数据目录。`);
  if (ids.includes("phone-camera")) notices.push(`\`phone-camera\` 使用独立的软件拥有命令，不通过 \`ability plan\` 或 \`ability invoke\`；它只生成用户说明的手机拍照式画面，失败不会静默切换后端。`);
  if (ids.includes("visual-reference-manager")) notices.push(`\`visual-reference-manager\` 使用独立的软件拥有命令，不通过 \`ability plan\` 或 \`ability invoke\`；资料和 manifest 均在当前 Agent 的软件数据目录，写入前仍需先 dry-run 和用户确认。`);
  if (ids.includes("web-browser")) notices.push(`\`web-browser\` 使用独立的软件拥有命令，不通过 \`ability plan\` 或 \`ability invoke\`；专用 Chrome、profile 与诊断仍只位于当前 Agent 的软件数据目录。`);
  if (ids.includes("site-automation")) notices.push(`\`site-automation\` 使用独立的软件拥有的站点适配器，不通过 \`ability plan\` 或 \`ability invoke\`；已登记的评论、点赞、私信/群回复、分享和群隐私同意均保留适配器自己的幂等与隐私保护。`);
  if (ids.includes("iphone-bridge")) notices.push(`\`iphone-bridge\` 使用独立的软件拥有命令，不通过 \`ability plan\` 或 \`ability invoke\`；只保留既有 iPhone 邮件快捷指令的发送与反馈监听语义。`);
  if (ids.includes(PROACTIVE_CONTACT_ID)) notices.push(`\`proactive-contact\` 使用 Suzu 自有的 \`schedule\` 自动任务；仅在软件运行期间执行，关闭期间不补跑。`);
  if (ids.includes(TRAVELING_MERCHANT_ID)) notices.push(`\`traveling-merchant\` 使用独立的软件拥有命令；其运行状态位于软件数据目录，Cron 由 Suzu \`schedule\` 执行，现有通知发送链路保持不变。`);
  if (ids.some((id) => !directAbilityIds.has(id))) notices.push(`其他能力可先使用显式 \`${launcher} ability plan\` 查看无副作用计划。实际 \`ability invoke\` 还必须带有软件控制面签发的短时、单次、能力/动作/作用域绑定授权凭证；CLI 不会自行签发，也不会把未配置能力降级为计划。`);
  return `${CLAUDE_START}\n## Suzu Lives 能力注册\n\n这些是由 Suzu Lives 管理的轻量入口。功能源码、设置、缓存和凭据不在此项目中；请只使用下方登记的入口。\n\n${bullets}\n\n${notices.join("\n\n")}\n${CLAUDE_END}`;
}

function renderTimeAwarenessSkill() {
  return `---\nname: suzu-lives-time-awareness\ndescription: 让 Agent 在每次用户消息进入时直接感知本机当前日期、星期和时间。\n---\n\n<!-- suzu-lives:ability:time-awareness -->\n# 时间感知\n\n这是 Suzu Lives 生成的受管能力。开启后，软件会在每次 \`UserPromptSubmit\` 时把当前电脑本地日期、星期与时间作为本轮上下文注入。\n\n它是自动能力，不需要、也不要为了询问“现在几点”再调用终端或旧脚本。注入内容只描述当前时刻，不是用户或 Agent 的历史对话；回答时间相关问题时以本轮注入的时间为准。\n\n时间 Hook 不读取消息正文、不联网、不调用模型、不写入聊天记录；它会与其他 \`UserPromptSubmit\` Hook（例如 RAG）并列运行。不要改用旧项目脚本。\n`;
}

function renderImageVisionSkill(launcher) {
  return `---\nname: suzu-lives-image-vision\ndescription: 通过 Suzu Lives 的稳定入口理解一张明确给出的本地图片。\n---\n\n<!-- suzu-lives:ability:image-vision -->\n# 图像理解\n\n这是 Suzu Lives 生成的轻量注册文件，不包含功能源码、安装路径、配置、缓存或凭据。\n\n仅在需要理解用户明确提供的单张本地图片时调用：\n\n\`${launcher} image-vision '<本地图片路径>' --question '<具体问题>'\`\n\n软件会读取自身数据目录中的图像理解配置并调用其视觉连接。可用 \`--config '<软件数据目录内的配置>'\` 选择该目录内的配置；\`--no-retry\` 会关闭被上游拒绝时的中性描述重试。\n\n不要绕过软件入口，也不要把配置、密钥或图片复制进 Claude 项目；若返回 \`VISION_REFUSED\` 或 \`VISION_ERROR\`，如实说明上游拒绝或配置/图片问题，不要补写看不见的内容。\n`;
}

function renderVideoUnderstandingSkill(launcher) {
  return `---\nname: suzu-lives-video-understanding\ndescription: 通过 Suzu Lives 的稳定入口理解一段明确给出的本地视频或 http(s) 视频。\n---\n\n<!-- suzu-lives:ability:video-understanding -->\n# 视频理解\n\n这是 Suzu Lives 生成的轻量注册文件，不包含功能源码、安装路径、配置、缓存或凭据。\n\n仅在需要理解用户明确提供的视频内容时调用：\n\n\`${launcher} video-understanding '<本地视频路径或 http(s) URL>' --question '<具体问题>'\`\n\n软件会检查 FFmpeg/FFprobe，准备受大小限制的 MP4 片段，并读取自身数据目录中的视频模型配置。可选 \`--cache-key '<上游稳定标识>'\` 与实际片段内容共同确定缓存；\`--no-cache\` 忽略且不写入缓存，\`--keep-clip\` 仅把准备后的片段保留到软件数据目录，\`--dry-run\` 只准备和校验视频、不需要 API Key 且不会请求模型。可用 \`--config '<软件数据目录内的配置>'\` 选择该目录内的配置。\n\n不要绕过软件入口，也不要把配置、密钥、缓存或视频复制进 Claude 项目；若返回 \`clip_too_large\`、\`dependency_missing\`、\`api_error\` 或其他稳定错误码，如实说明视频、工具或软件配置问题，不要补写未看到或未听到的内容。\n`;
}

function renderVoiceMessageSkill(launcher) {
  return `---\nname: suzu-lives-voice-message\ndescription: 通过 Suzu Lives 生成一条明确要求的 MP3 语音，并交付到当前会话。\n---\n\n<!-- suzu-lives:ability:voice-message -->\n# 发送语音\n\n这是 Suzu Lives 生成的轻量注册文件，不包含功能源码、安装路径、配置、缓存或凭据。\n\n只在用户明确要求语音回复、或一段很短的话用声音显著更自然时调用。先生成 MP3：\n\n\`${launcher} voice-message '<要说的话>'\`\n\n也可把用户明确给出的本地音频转换成 MP3：\n\n\`${launcher} voice-message --audio-file '<本地音频路径>'\`\n\n成功 JSON 中的 \`savedPath\` 是生成的 MP3。必须紧接着使用当前 Suzu 会话系统提示中提供的附件交付命令，以 \`--audio "<savedPath>"\` 交付它：这样 Suzu 会显示可播放音频，已绑定微信的当前会话会把同一文件作为 MP3 文件投递。不要改用旧脚本、原生语音气泡或任何直接外部通道。\n\n可用 \`--inspect\` 仅检查软件数据目录中的语音配置和声音连接，不调用 TTS 或交付。不要把配置、密钥或音频复制进 Claude 项目。\n`;
}

function renderImageGenerationSkill(launcher) {
  return `---\nname: suzu-lives-image-generation\ndescription: 通过 Suzu Lives 的图像引擎生成普通图片或明确指定的 ComfyUI 工作流图片。\n---\n\n<!-- suzu-lives:ability:image-generation -->\n# Image Generation\n\n这是 Suzu Lives 生成的直连注册文件；不要通过 \`ability plan\` 或 \`ability invoke\` 调用此能力。\n\n普通生成图片和明确指定的本地 ComfyUI 工作流使用此能力：\n\n\`${launcher} image-generation --prompt "画面中实际需要生成的内容"\`\n\n可选 \`--backend api|comfyui\`、\`--workflow <id>\`、\`--size WIDTHxHEIGHT\`、\`--seed <整数>\`，以及重复的 \`--ref [identity|location|object|style=]PATH\`。默认后端来自当前 Agent 的软件配置；API 或 ComfyUI 出错时不能切换到另一后端。\`--list-workflows\` 与 \`--validate-workflows\` 只检查软件数据目录中的 ComfyUI registry，不会连接 ComfyUI。\n\n\`--out\` 与 \`--config\` 必须位于当前 Agent 的 Suzu Lives 数据目录。API 连接来自软件管理的连接或 \`IMAGE_API_KEY\` / \`IMAGE_BASE_URL\` / \`IMAGE_MODEL\` 环境覆盖。成功 JSON 的 \`status: "ok"\` 才代表图片已保存。\n\n若用户要求交付图片，先生成，再使用当前 Suzu 会话系统提示中给出的附件交付命令；它会显示在本会话中，并在该会话已绑定微信时自动发送。不要使用旧的直接发送参数，也不要自动导入视觉参考库或调用 image-vision。\n`;
}

function renderPhoneCameraSkill(launcher) {
  return `---\nname: suzu-lives-phone-camera\ndescription: 让 Agent 通过 Suzu Lives 的图像引擎生成真实手机随手拍、自拍或镜面自拍。\n---\n\n<!-- suzu-lives:ability:phone-camera -->\n# Phone Camera\n\n这是 Suzu Lives 生成的直连注册文件；不要通过 \`ability plan\` 或 \`ability invoke\` 调用此能力。\n\n食物、房间、街景和眼前所见用 \`rear\`；正面自拍用 \`selfie\`；穿搭或全身镜前照用 \`mirror\`。只把画面中真正可见的事实放进 \`--scene\`。\n\n\`${launcher} phone-camera --shot rear --scene "画面中实际可见的场景" --dry-run\`\n\n需要视觉参考时使用重复的 \`--ref <asset-or-set-id>\`；只选择当前画面必要的资料。\`--backend comfyui --workflow <id>\` 只在明确指定本地工作流时使用；失败不会切回 API。成功 JSON 的 \`status: "ok"\` 才代表生成成功。\n\n若用户要求交付图片，先生成，再使用当前 Suzu 会话系统提示中给出的附件交付命令；它会显示在本会话中，并在该会话已绑定微信时自动发送。不要使用旧的直接发送参数。\n`;
}

function renderVisualReferenceManagerSkill(launcher) {
  return `---\nname: suzu-lives-visual-reference-manager\ndescription: 通过 Suzu Lives 维护用户明确要求保存、登记、查看、更新、删除或校验的视觉参考资料库。\n---\n\n<!-- suzu-lives:ability:visual-reference-manager -->\n# Visual Reference Manager\n\n这是 Suzu Lives 生成的直连注册文件；不要通过 \`ability plan\` 或 \`ability invoke\` 调用此能力。\n\n只在用户明确要求维护参考资料库时使用；不要把普通聊天附件自动永久保存。资料副本和清单都由 Suzu Lives 写入当前 Agent 的软件数据目录。\n\n角色只能是 \`identity\`、\`location\`、\`object\`、\`style\`，ID 使用稳定的小写英文层级。使用稳定入口：\n\n\`${launcher} visual-reference-manager init\`\n\n\`${launcher} visual-reference-manager list --query "卧室" --limit 10\`\n\n\`${launcher} visual-reference-manager show home.bedroom.door-view\`\n\n\`${launcher} visual-reference-manager validate\`\n\n新增、更新、换角色或删除时，先准备版本为 1 的维护计划 JSON，再执行：\n\n\`${launcher} visual-reference-manager apply --plan '<计划文件>' --dry-run\`\n\n只有 dry-run 成功、没有冲突且用户已确认后，才执行同一计划的 \`${launcher} visual-reference-manager apply --plan '<计划文件>'\`。\`remove\` 必须明确 \`delete_file: true|false\`；不要手工编辑 manifest。\n`;
}

function renderWebBrowserSkill(launcher) {
  return `---\nname: suzu-lives-web-browser\ndescription: 通过 Suzu Lives 的专用 Chrome 与已接入网站适配器执行网页浏览、互动和会话动作。\n---\n\n<!-- suzu-lives:ability:web-browser -->\n# Web Browser 与 Web Automation\n\n这是 Suzu Lives 生成的直连注册文件；不要通过 \`ability plan\` 或 \`ability invoke\` 调用此能力。\n\n使用软件拥有的专用 Chrome；登录状态只保存在当前 Agent 的 Suzu Lives 数据目录。启动或检查浏览器：\n\n\`${launcher} web-browser\`\n\n\`${launcher} web-browser --check\`\n\n连接本机 CDP 时沿用原命令：\n\n\`playwright-cli attach --cdp=http://127.0.0.1:9222\`\n\n完成后使用 \`playwright-cli detach\`。需要结束一次抖音浏览时，调用 \`${launcher} site douyin close\`；不要直接关闭专用 Chrome。\n\n查询已接入的网站和动作：\n\n\`${launcher} site list\`\n\n\`${launcher} site describe <site>\`\n\n\`${launcher} site <site> <action> [--text <value>] [--state on|off]\`\n\n每个网站的动作由软件拥有的适配器执行；网页自动化中关闭的网站或动作会被适配器直接拒绝。\n\n软件配置仅从当前 Agent 的 Suzu Lives 数据目录读取：\`agents/<agentId>/site-automation/config.json\`。不要读取项目目录中的 \`config.local.json\`、\`runtime/\`、源码或浏览器 profile。\n`;
}

function renderSiteAutomationSkill(launcher) {
  return `---\nname: suzu-lives-site-automation\ndescription: 通过 Suzu Lives 的已接入网站适配器执行网页浏览、互动和会话动作。\n---\n\n<!-- suzu-lives:ability:site-automation -->\n# Web Automation\n\n这是 Suzu Lives 生成的直连注册文件；不要通过 \`ability plan\` 或 \`ability invoke\` 调用此能力。\n\n先使用软件拥有的专用 Chrome：\n\n\`${launcher} web-browser\`\n\n\`${launcher} web-browser --check\`\n\n需要连接 CDP 时沿用原命令：\n\n\`playwright-cli attach --cdp=http://127.0.0.1:9222\`\n\n完成后使用 \`playwright-cli detach\`。需要结束一次抖音浏览时，调用 \`${launcher} site douyin close\`；不要直接关闭专用 Chrome。\n\n先查询已接入的网站和它们允许的动作：\n\n\`${launcher} site list\`\n\n\`${launcher} site describe <site>\`\n\n\`${launcher} site <site> <action> [--text <value>] [--state on|off]\`\n\n每个网站的动作都由软件拥有的适配器执行。不要绕过适配器：它负责该站点原有的登录检查、幂等、私信/群聊范围、显式隐私同意和 dry-run 保护；若用户在网页自动化设置中关闭了网站或动作，适配器会直接拒绝调用。\n\n软件配置仅从当前 Agent 的 Suzu Lives 数据目录读取：\`agents/<agentId>/site-automation/config.json\`。不要读取项目目录中的 \`config.local.json\`、\`runtime/\`、源码或浏览器 profile。\n`;
}

function renderIphoneBridgeSkill(launcher) {
  return `---\nname: suzu-lives-iphone-bridge\ndescription: 通过 Suzu Lives 中配置的 iPhone 邮件快捷指令发送请求。\n---\n\n<!-- suzu-lives:ability:iphone-bridge -->\n# iPhone Bridge\n\n这是 Suzu Lives 生成的直连注册文件。软件代码、配置、反馈状态和附件都在当前 Agent 的 Suzu Lives 数据根。\n\n向 iPhone 发出请求时使用：\n\n\`${launcher} iphone-bridge send '闹钟' '08:30 起床'\`\n\n手机反馈由正在运行的 Suzu 本地接收器直接投递到能力设置中勾选的一个或多个会话。不要手动管理反馈接收器，也不要使用其他转发路径。\n\n若返回未配置，请先在 Suzu Lives 中完成 iPhone 设置；不要复制、打印或手工修改敏感配置。\n`;
}

export function renderCapabilitySkill({ abilityId, command = "suzu-lives" } = {}) {
  const launcher = safeCommand(command);
  const direct = directCompatibilityAbility(abilityId);
  if (direct) return direct.renderSkill(launcher);
  const capability = assertRegisterableAbility(abilityId);
  if (capability.id === "image-vision") return renderImageVisionSkill(launcher);
  if (capability.id === "video-understanding") return renderVideoUnderstandingSkill(launcher);
  if (capability.id === "voice-message") return renderVoiceMessageSkill(launcher);
  return `---\nname: suzu-lives-${capability.id}\ndescription: 通过 Suzu Lives 的稳定入口查询、计划或请求 ${capability.name}。\n---\n\n<!-- suzu-lives:ability:${capability.id} -->\n# ${capability.name}\n\n这是 Suzu Lives 生成的轻量注册文件，不包含功能源码、安装路径、配置、缓存或凭据。\n\n先执行：\n\n\`${launcher} ability status --id ${capability.id}\`\n\n如需无副作用检查，显式执行：\n\n\`${launcher} ability plan --id ${capability.id} --request-json '<JSON>'\`\n\n只有状态明确允许，并且软件控制面已在用户明确确认后签发本次短时、单次授权凭证时，才通过软件入口提交实际请求：\n\n\`${launcher} ability invoke --id ${capability.id} --request-json '<JSON>' --authorization-credential '<软件签发凭证>'\`\n\nCLI 不能签发凭证，且当前管理页面尚未接入凭证发放操作；不要猜测、伪造或重放凭证。若状态显示未配置、未启用、依赖不可用或待授权，不要绕过软件入口；说明所需的 Suzu Lives 配置即可。\n`;
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

export async function writeClaudeRegistration({ projectRoot, abilityId, launcher = {}, toolPermissions, fsOps = fs } = {}) {
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
  const projectSettings = await prepareSuzuClaudeProjectSettings({ root, command, toolPermissions, fsOps });
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
