import fs from "node:fs";
import path from "node:path";

import {
  resolveAgentDataRoot,
  stableAgentId,
} from "@suzu-lives/agent-registry";
import { sanitizePriceRevisions } from "@suzu-lives/cost-ledger";
import { createContactProjectsService } from "../services/contact-projects.mjs";

const DEFAULT_SETTINGS = Object.freeze({
  contactsRoot: "",
  preferredContactId: "",
  projectRoot: "",
  onboardingCompleted: false,
  onboardingMultimodalCompleted: false,
  memoryRecallEnabled: true,
  claudeToolPermissions: { read: true, webFetch: true, webSearch: true },
  claudeRuntimeFeatures: {
    bash: true,
    edit: true,
    glob: true,
    grep: true,
    subagents: false,
    taskList: false,
    backgroundTasks: false,
    nativeCron: false,
    askUserQuestion: false,
    write: true,
  },
  theme: "light",
  agentId: "",
  priceRevisions: [],
  identity: {
    owner: { displayName: "我", avatarDataUrl: "", gender: "", signature: "" },
    defaultAgent: { displayName: "Suzu", avatarDataUrl: "" },
    agents: {},
  },
  conversationPreferences: { attachments: true, tools: true, thinking: true, system: true, tokens: true, timeDisplay: "center" },
});

const MAX_AVATAR_DATA_URL_LENGTH = 2_800_000;
const AVATAR_DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]+={0,2}$/iu;

function normalizeProfile(value, fallbackName) {
  const displayName = String(value?.displayName || fallbackName).trim().slice(0, 60) || fallbackName;
  const avatarDataUrl = String(value?.avatarDataUrl || "");
  return {
    displayName,
    avatarDataUrl: avatarDataUrl.length <= MAX_AVATAR_DATA_URL_LENGTH && AVATAR_DATA_URL_PATTERN.test(avatarDataUrl)
      ? avatarDataUrl
      : "",
  };
}

const OWNER_GENDERS = new Set(["", "female", "male"]);

function normalizeOwnerProfile(value) {
  const gender = String(value?.gender || "");
  return {
    ...normalizeProfile(value, "我"),
    gender: OWNER_GENDERS.has(gender) ? gender : "",
    signature: String(value?.signature || "").trim().slice(0, 120),
  };
}

function normalizeIdentity(value = {}) {
  const agents = {};
  if (value.agents && typeof value.agents === "object" && !Array.isArray(value.agents)) {
    for (const [agentId, profile] of Object.entries(value.agents).slice(0, 100)) {
      if (/^[a-z0-9][a-z0-9_-]{0,127}$/iu.test(agentId)) agents[agentId] = normalizeProfile(profile, "Suzu");
    }
  }
  return {
    owner: normalizeOwnerProfile(value.owner),
    defaultAgent: normalizeProfile(value.defaultAgent, "Suzu"),
    agents,
  };
}

function ownerDisplayName(settings) {
  return String(settings?.identity?.owner?.displayName || "我").trim() || "我";
}

export function normalizeConversationPreferences(value = {}) {
  return {
    attachments: value.attachments !== false,
    tools: value.tools !== false,
    thinking: value.thinking !== false,
    system: value.system !== false,
    tokens: value.tokens !== false,
    timeDisplay: value.timeDisplay === "bubble" ? "bubble" : "center",
  };
}

export function normalizeMemoryRecallEnabled(value) {
  return value !== false;
}

export function normalizeOnboardingCompleted(value) {
  return value === true;
}

export function normalizeOnboardingMultimodalCompleted(value) {
  return value === true;
}

export function normalizeClaudeToolPermissions(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    read: source.read !== false,
    webFetch: source.webFetch !== false,
    webSearch: source.webSearch !== false,
  };
}

function normalizeClaudeToolRuleList(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n|,/u)
      : [];
  const rules = [];
  const seen = new Set();
  for (const item of source) {
    if (typeof item !== "string") continue;
    const rule = item.trim();
    if (!rule || rule.length > 500 || seen.has(rule)) continue;
    seen.add(rule);
    rules.push(rule);
    if (rules.length >= 120) break;
  }
  return rules;
}

export function normalizeClaudeProjectDefaults(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    allowedTools: normalizeClaudeToolRuleList(source.allowedTools),
    deniedTools: normalizeClaudeToolRuleList(source.deniedTools),
    skipWebFetchPreflight: source.skipWebFetchPreflight !== false,
  };
}

export function normalizeClaudeRuntimeFeatures(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    bash: source.bash !== false,
    edit: source.edit !== false,
    glob: source.glob !== false,
    grep: source.grep !== false,
    subagents: source.subagents === true,
    taskList: source.taskList === true,
    backgroundTasks: source.backgroundTasks === true,
    nativeCron: source.nativeCron === true,
    askUserQuestion: source.askUserQuestion === true,
    write: source.write !== false,
  };
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
  } catch {
    return fallback;
  }
}

function normalizePreferredContactId(value) {
  const id = String(value || "").trim().toLowerCase();
  return /^contact-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id) ? id : "";
}

function normalizeSettings(value = {}) {
  const contactsRoot = String(value.contactsRoot || "").trim();
  // Until a contacts root is selected, no project may remain active.
  const hasContactsRoot = Boolean(contactsRoot);
  const projectRoot = hasContactsRoot ? String(value.projectRoot || "").trim() : "";
  const hasClaudeProjectDefaults = Object.hasOwn(value, "claudeProjectDefaults");
  return {
    contactsRoot,
    preferredContactId: hasContactsRoot ? normalizePreferredContactId(value.preferredContactId) : "",
    projectRoot,
    onboardingCompleted: normalizeOnboardingCompleted(value.onboardingCompleted),
    onboardingMultimodalCompleted: normalizeOnboardingMultimodalCompleted(value.onboardingMultimodalCompleted),
    memoryRecallEnabled: normalizeMemoryRecallEnabled(value.memoryRecallEnabled),
    claudeToolPermissions: normalizeClaudeToolPermissions(value.claudeToolPermissions),
    ...(hasClaudeProjectDefaults ? { claudeProjectDefaults: normalizeClaudeProjectDefaults(value.claudeProjectDefaults) } : {}),
    claudeRuntimeFeatures: normalizeClaudeRuntimeFeatures(value.claudeRuntimeFeatures),
    theme: value.theme === "dark" ? "dark" : "light",
    agentId: stableAgentId(projectRoot),
    priceRevisions: sanitizePriceRevisions(value.priceRevisions),
    identity: normalizeIdentity(value.identity),
    conversationPreferences: normalizeConversationPreferences(value.conversationPreferences),
  };
}

function safePatch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const patch = {};
  if (Object.hasOwn(value, "contactsRoot")) patch.contactsRoot = String(value.contactsRoot || "");
  if (Object.hasOwn(value, "projectRoot")) patch.projectRoot = String(value.projectRoot || "");
  if (Object.hasOwn(value, "onboardingCompleted")) patch.onboardingCompleted = normalizeOnboardingCompleted(value.onboardingCompleted);
  if (Object.hasOwn(value, "onboardingMultimodalCompleted")) patch.onboardingMultimodalCompleted = normalizeOnboardingMultimodalCompleted(value.onboardingMultimodalCompleted);
  if (Object.hasOwn(value, "memoryRecallEnabled")) patch.memoryRecallEnabled = normalizeMemoryRecallEnabled(value.memoryRecallEnabled);
  if (Object.hasOwn(value, "claudeToolPermissions")) patch.claudeToolPermissions = normalizeClaudeToolPermissions(value.claudeToolPermissions);
  if (Object.hasOwn(value, "claudeProjectDefaults")) patch.claudeProjectDefaults = normalizeClaudeProjectDefaults(value.claudeProjectDefaults);
  if (Object.hasOwn(value, "claudeRuntimeFeatures")) patch.claudeRuntimeFeatures = normalizeClaudeRuntimeFeatures(value.claudeRuntimeFeatures);
  if (Object.hasOwn(value, "theme")) patch.theme = value.theme === "light" ? "light" : "dark";
  if (Object.hasOwn(value, "priceRevisions")) patch.priceRevisions = sanitizePriceRevisions(value.priceRevisions);
  if (Object.hasOwn(value, "identity")) patch.identity = normalizeIdentity(value.identity);
  if (Object.hasOwn(value, "conversationPreferences")) patch.conversationPreferences = normalizeConversationPreferences(value.conversationPreferences);
  return patch;
}

export function createSettingsService({ app, dataStorageService = null }) {
  const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
  const localDataRoot = () => path.resolve(app.getPath("userData"));
  const usageLedgerPath = (settings) => {
    const agentId = settings.agentId || stableAgentId(settings.projectRoot) || "unassigned";
    return path.join(resolveAgentDataRoot({ dataRoot: localDataRoot(), agentId }), "cost-ledger", "events.jsonl");
  };
  const load = () => {
    const stored = readJson(settingsPath(), {});
    return normalizeSettings({
      ...DEFAULT_SETTINGS,
      ...stored,
      projectRoot: stored.projectRoot || process.env.SUZU_PROJECT_ROOT || "",
    });
  };
  const save = (next) => {
    const value = normalizeSettings(next);
    const destination = settingsPath();
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(`${destination}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(`${destination}.tmp`, destination);
    return value;
  };
  const response = (settings = load()) => ({
    ...settings,
    settingsPath: settingsPath(),
    dataRoot: localDataRoot(),
    dataStorage: dataStorageService?.snapshot?.() || { dataRoot: localDataRoot(), previousDataRoot: "", migration: { status: "idle" } },
    usageLedgerPath: usageLedgerPath(settings),
  });
  return { load, response, save, safePatch, usageLedgerPath };
}

export function registerSettingsIpc({ app, appUpdateService = null, contactProjectsService = null, dataStorageService, dialog, getMainWindow, ipcMain, shell, settingsService }) {
  const contacts = contactProjectsService || createContactProjectsService({ settingsService });
  const updateService = appUpdateService || {
    status: () => ({ status: "unavailable", mode: "manual", version: "未知", message: "当前版本没有启用更新服务。" }),
    checkForUpdates: () => ({ status: "unavailable", mode: "manual", version: "未知", message: "当前版本没有启用更新服务。" }),
    downloadUpdate: () => ({ status: "unavailable", mode: "manual", version: "未知", message: "当前版本没有启用更新服务。" }),
    installUpdate: () => ({ status: "unavailable", mode: "manual", version: "未知", message: "当前版本没有启用更新服务。" }),
  };
  ipcMain.handle("settings:get", () => settingsService.response());
  ipcMain.handle("settings:app-update-status", () => updateService.status());
  ipcMain.handle("settings:check-for-update", () => updateService.checkForUpdates());
  ipcMain.handle("settings:download-update", () => updateService.downloadUpdate());
  ipcMain.handle("settings:install-update", () => updateService.installUpdate());
  ipcMain.handle("settings:select-project", async () => {
    const current = settingsService.load();
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: "选择联系人项目目录",
      defaultPath: current.contactsRoot || undefined,
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true, settings: settingsService.response(current) };
    const selected = path.resolve(result.filePaths[0]);
    await contacts.selectRoot(selected);
    return { canceled: false, settings: settingsService.response() };
  });
  ipcMain.handle("settings:update", async (_event, value) => {
    const current = settingsService.load();
    const patch = settingsService.safePatch(value);
    const settings = settingsService.save({ ...current, ...patch });
    let ownerProfileTitleSync = null;
    if (Object.hasOwn(patch, "identity")) {
      const previousName = ownerDisplayName(current);
      const nextName = ownerDisplayName(settings);
      if (previousName !== nextName && typeof contacts.syncOwnerProfileTitle === "function") {
        ownerProfileTitleSync = await contacts.syncOwnerProfileTitle({ previousName, name: nextName });
      }
    }
    if (Object.hasOwn(patch, "claudeToolPermissions") || Object.hasOwn(patch, "claudeProjectDefaults")) {
      await contacts.syncClaudeProjectSettings({ previousProjectDefaults: current.claudeProjectDefaults });
    }
    return {
      ...settingsService.response(settings),
      ...(ownerProfileTitleSync ? { ownerProfileTitleSync } : {}),
    };
  });
  ipcMain.handle("settings:change-data-location", async () => {
    if (!dataStorageService) throw new Error("当前版本不支持更换数据位置。");
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: "选择 Suzu Lives 数据保存位置",
      defaultPath: path.dirname(dataStorageService.dataRoot),
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return { status: "canceled" };

    const targetRoot = dataStorageService.targetFromSelection(result.filePaths[0]);
    const validation = dataStorageService.validateMigration(targetRoot);
    if (validation.status === "unchanged") return validation;

    const confirmation = await dialog.showMessageBox(getMainWindow(), {
      type: "question",
      title: "迁移 Suzu Lives 数据",
      message: "把软件数据迁移到新位置？",
      detail: `设置、API 连接、Agent 数据、生成内容和本地缓存将迁移到：\n${validation.targetRoot}\n\n软件会自动重启。旧位置会暂时保留为安全回退，确认新位置可用后再自行清理。`,
      buttons: ["开始迁移", "取消"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (confirmation.response !== 0) return { status: "canceled" };

    const scheduled = dataStorageService.scheduleMigration(validation.targetRoot);
    app.relaunch();
    app.exit(0);
    return scheduled;
  });
  ipcMain.handle("settings:remove-previous-data-copy", async () => {
    if (!dataStorageService) throw new Error("当前版本不支持清理旧数据副本。");
    const previousDataRoot = dataStorageService.snapshot().previousDataRoot;
    if (!previousDataRoot) return { status: "none", settings: settingsService.response() };
    const confirmation = await dialog.showMessageBox(getMainWindow(), {
      type: "warning",
      title: "清理旧数据副本",
      message: "永久删除旧位置的数据副本？",
      detail: `这会永久删除：\n${previousDataRoot}\n\n当前数据仍保留在新位置。此操作无法恢复。`,
      buttons: ["永久删除", "取消"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (confirmation.response !== 0) return { status: "canceled", settings: settingsService.response() };
    const result = dataStorageService.removePreviousDataCopy();
    return { ...result, settings: settingsService.response() };
  });
  ipcMain.handle("shell:show-item", (_event, targetPath) => {
    const value = String(targetPath || "").trim();
    if (!value || !path.isAbsolute(value)) return false;
    if (fs.existsSync(value)) shell.showItemInFolder(value);
    else {
      const directory = path.extname(value) ? path.dirname(value) : value;
      fs.mkdirSync(directory, { recursive: true });
      shell.openPath(directory);
    }
    return true;
  });
}
