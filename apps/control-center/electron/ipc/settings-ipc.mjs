import fs from "node:fs";
import path from "node:path";

import {
  legacyStableAgentId,
  resolveAgentDataRoot,
  stableAgentId,
} from "@suzu-lives/agent-registry";
import { createPriceCatalog, sanitizeCustomPriceModels, sanitizePriceRevisions } from "@suzu-lives/cost-ledger";
import { createContactProjectsService } from "../services/contact-projects.mjs";
import { createSystemStatusService } from "../services/system-status.mjs";

const DEFAULT_SETTINGS = Object.freeze({
  contactsRoot: "",
  preferredContactId: "",
  projectRoot: "",
  onboardingCompleted: false,
  onboardingMultimodalCompleted: false,
  memoryRecallEnabled: true,
  conversationComposerHeight: 168,
  conversationRosterWidth: 246,
  shellSidebarWidth: 240,
  theme: "light",
  agentId: "",
  customPriceModels: [],
  priceRevisions: [],
  releaseAnnouncementState: { lastStartedVersion: "", lastAcknowledgedVersion: "" },
  identity: {
    owner: { displayName: "我", avatarDataUrl: "", gender: "", signature: "" },
    defaultAgent: { displayName: "Suzu", avatarDataUrl: "" },
    agents: {},
  },
  conversationPreferences: { attachments: true, dynamicContext: false, tools: true, thinking: true, system: true, tokens: true, timeDisplay: "center" },
});

const MAX_AVATAR_DATA_URL_LENGTH = 2_800_000;
const AVATAR_DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]+={0,2}$/iu;

function clean(value) {
  return String(value ?? "").trim();
}

function externalUrl(value) {
  try {
    const url = new URL(clean(value));
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

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

const LEGACY_CONTACT_AGENT_ID_PATTERN = /^agent-[a-f0-9]{16}$/iu;

function hasLegacyContactIdentityProfile(settings) {
  return Object.keys(settings?.identity?.agents || {}).some((agentId) => LEGACY_CONTACT_AGENT_ID_PATTERN.test(clean(agentId)));
}

async function migrateLegacyContactIdentityProfiles({ contactSnapshot = null, contacts, settingsService } = {}) {
  const current = settingsService.load();
  if (!hasLegacyContactIdentityProfile(current) || typeof contacts?.snapshot !== "function") return current;

  let snapshot = contactSnapshot;
  if (!snapshot) {
    try {
      snapshot = await contacts.snapshot();
    } catch {
      // A temporary contact-catalog read failure must never make settings
      // unavailable. The migration will be retried on the next settings read.
      return current;
    }
  }

  const identity = current.identity || {};
  const agents = { ...(identity.agents || {}) };
  let migrated = false;
  for (const contact of Array.isArray(snapshot?.contacts) ? snapshot.contacts : []) {
    const agentId = clean(contact?.agentId);
    const legacyAgentId = legacyStableAgentId(contact?.projectRoot);
    if (!agentId || !legacyAgentId || agentId === legacyAgentId) continue;
    if (!Object.hasOwn(agents, agentId) && Object.hasOwn(agents, legacyAgentId)) {
      agents[agentId] = { ...agents[legacyAgentId] };
      delete agents[legacyAgentId];
      migrated = true;
    }
  }
  if (!migrated) return current;
  return settingsService.save({
    ...current,
    identity: { ...identity, agents },
  });
}

export function normalizeConversationPreferences(value = {}) {
  return {
    attachments: value.attachments !== false,
    dynamicContext: value.dynamicContext === true,
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

const SHELL_SIDEBAR_COMPACT_WIDTH = 70;
const SHELL_SIDEBAR_MIN_EXPANDED_WIDTH = 240;
const SHELL_SIDEBAR_MAX_WIDTH = 360;
const SHELL_SIDEBAR_COLLAPSE_THRESHOLD = 144;
const CONVERSATION_COMPOSER_MIN_HEIGHT = 168;
const CONVERSATION_COMPOSER_MAX_HEIGHT = 420;
const CONVERSATION_ROSTER_MIN_WIDTH = 192;
const CONVERSATION_ROSTER_MAX_WIDTH = 340;

export function normalizeShellSidebarWidth(value) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return 240;
  if (numeric <= SHELL_SIDEBAR_COLLAPSE_THRESHOLD) return SHELL_SIDEBAR_COMPACT_WIDTH;
  return Math.min(Math.max(numeric, SHELL_SIDEBAR_MIN_EXPANDED_WIDTH), SHELL_SIDEBAR_MAX_WIDTH);
}

export function normalizeConversationComposerHeight(value) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return 168;
  return Math.min(Math.max(numeric, CONVERSATION_COMPOSER_MIN_HEIGHT), CONVERSATION_COMPOSER_MAX_HEIGHT);
}

export function normalizeConversationRosterWidth(value) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return 246;
  return Math.min(Math.max(numeric, CONVERSATION_ROSTER_MIN_WIDTH), CONVERSATION_ROSTER_MAX_WIDTH);
}

export function normalizeReleaseAnnouncementState(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const marker = (candidate) => String(candidate || "").trim().slice(0, 80);
  return {
    lastStartedVersion: marker(source.lastStartedVersion),
    lastAcknowledgedVersion: marker(source.lastAcknowledgedVersion),
  };
}

export function normalizeOnboardingCompleted(value) {
  return value === true;
}

export function normalizeOnboardingMultimodalCompleted(value) {
  return value === true;
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
  const customPriceModels = sanitizeCustomPriceModels(value.customPriceModels);
  const priceCatalog = createPriceCatalog({ customPriceModels });
  return {
    contactsRoot,
    preferredContactId: hasContactsRoot ? normalizePreferredContactId(value.preferredContactId) : "",
    projectRoot,
    onboardingCompleted: normalizeOnboardingCompleted(value.onboardingCompleted),
    onboardingMultimodalCompleted: normalizeOnboardingMultimodalCompleted(value.onboardingMultimodalCompleted),
    memoryRecallEnabled: normalizeMemoryRecallEnabled(value.memoryRecallEnabled),
    conversationComposerHeight: normalizeConversationComposerHeight(value.conversationComposerHeight),
    conversationRosterWidth: normalizeConversationRosterWidth(value.conversationRosterWidth),
    shellSidebarWidth: normalizeShellSidebarWidth(value.shellSidebarWidth),
    theme: value.theme === "dark" ? "dark" : "light",
    agentId: stableAgentId(projectRoot),
    customPriceModels,
    priceRevisions: sanitizePriceRevisions(value.priceRevisions, priceCatalog),
    releaseAnnouncementState: normalizeReleaseAnnouncementState(value.releaseAnnouncementState),
    identity: normalizeIdentity(value.identity),
    conversationPreferences: normalizeConversationPreferences(value.conversationPreferences),
  };
}

function safePatch(value, current = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const patch = {};
  const customPriceModels = Object.hasOwn(value, "customPriceModels")
    ? sanitizeCustomPriceModels(value.customPriceModels)
    : sanitizeCustomPriceModels(current.customPriceModels);
  const priceCatalog = createPriceCatalog({ customPriceModels });
  if (Object.hasOwn(value, "contactsRoot")) patch.contactsRoot = String(value.contactsRoot || "");
  if (Object.hasOwn(value, "projectRoot")) patch.projectRoot = String(value.projectRoot || "");
  if (Object.hasOwn(value, "onboardingCompleted")) patch.onboardingCompleted = normalizeOnboardingCompleted(value.onboardingCompleted);
  if (Object.hasOwn(value, "onboardingMultimodalCompleted")) patch.onboardingMultimodalCompleted = normalizeOnboardingMultimodalCompleted(value.onboardingMultimodalCompleted);
  if (Object.hasOwn(value, "memoryRecallEnabled")) patch.memoryRecallEnabled = normalizeMemoryRecallEnabled(value.memoryRecallEnabled);
  if (Object.hasOwn(value, "conversationComposerHeight")) patch.conversationComposerHeight = normalizeConversationComposerHeight(value.conversationComposerHeight);
  if (Object.hasOwn(value, "conversationRosterWidth")) patch.conversationRosterWidth = normalizeConversationRosterWidth(value.conversationRosterWidth);
  if (Object.hasOwn(value, "shellSidebarWidth")) patch.shellSidebarWidth = normalizeShellSidebarWidth(value.shellSidebarWidth);
  if (Object.hasOwn(value, "theme")) patch.theme = value.theme === "light" ? "light" : "dark";
  if (Object.hasOwn(value, "customPriceModels")) patch.customPriceModels = customPriceModels;
  if (Object.hasOwn(value, "priceRevisions")) patch.priceRevisions = sanitizePriceRevisions(value.priceRevisions, priceCatalog);
  if (Object.hasOwn(value, "identity")) patch.identity = normalizeIdentity(value.identity);
  if (Object.hasOwn(value, "conversationPreferences")) patch.conversationPreferences = normalizeConversationPreferences(value.conversationPreferences);
  return patch;
}

export function createSettingsService({ app, dataStorageService = null }) {
  const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
  const hasStoredSettings = () => {
    try {
      return fs.existsSync(settingsPath());
    } catch {
      return false;
    }
  };
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
  // Product-owned services need the same safe patch boundary as the renderer
  // settings IPC.  Keeping it on the service prevents a startup-only helper
  // from assuming an API that the real settings implementation does not have.
  const update = (patch) => {
    const current = load();
    return save({ ...current, ...safePatch(patch, current) });
  };
  const response = (settings = load()) => ({
    ...settings,
    settingsPath: settingsPath(),
    dataRoot: localDataRoot(),
    dataStorage: dataStorageService?.snapshot?.() || { dataRoot: localDataRoot(), previousDataRoot: "", migration: { status: "idle" } },
    usageLedgerPath: usageLedgerPath(settings),
  });
  return { hasStoredSettings, load, response, save, safePatch, update, usageLedgerPath };
}

export function registerSettingsIpc({ app, appUpdateService = null, contactProjectsService = null, dataStorageService, dialog, getMainWindow, ipcMain, onMemoryRecallEnabledChanged = null, releaseAnnouncementService = null, shell, settingsService, systemStatusService = null }) {
  const contacts = contactProjectsService || createContactProjectsService({ settingsService });
  const systemStatus = systemStatusService || createSystemStatusService({
    dataRoot: () => clean(dataStorageService?.dataRoot) || clean(settingsService.response?.(settingsService.load?.())?.dataRoot),
    settingsService,
  });
  const updateService = appUpdateService || {
    status: () => ({ status: "unavailable", mode: "manual", version: "未知", message: "当前版本没有启用更新服务。" }),
    checkForUpdates: () => ({ status: "unavailable", mode: "manual", version: "未知", message: "当前版本没有启用更新服务。" }),
    downloadUpdate: () => ({ status: "unavailable", mode: "manual", version: "未知", message: "当前版本没有启用更新服务。" }),
    installUpdate: () => ({ status: "unavailable", mode: "manual", version: "未知", message: "当前版本没有启用更新服务。" }),
  };
  const announcementService = releaseAnnouncementService || {
    acknowledge: () => ({ announcement: null, pending: false, version: "" }),
    status: () => ({ announcement: null, pending: false, version: "" }),
  };
  ipcMain.handle("settings:get", async () => {
    // A new installation has no materialized contacts path. Materialize the
    // product-owned default before returning the first settings snapshot, so
    // every page sees the same data-root/contacts location from the start.
    let contactSnapshot = null;
    if (!clean(settingsService.load()?.contactsRoot) && typeof contacts.snapshot === "function") {
      contactSnapshot = await contacts.snapshot();
    }
    const settings = await migrateLegacyContactIdentityProfiles({ contactSnapshot, contacts, settingsService });
    return settingsService.response(settings);
  });
  ipcMain.handle("settings:release-announcement-status", () => announcementService.status());
  ipcMain.handle("settings:acknowledge-release-announcement", () => announcementService.acknowledge());
  ipcMain.handle("settings:app-update-status", () => updateService.status());
  ipcMain.handle("settings:check-for-update", () => updateService.checkForUpdates());
  ipcMain.handle("settings:download-update", () => updateService.downloadUpdate());
  ipcMain.handle("settings:install-update", () => updateService.installUpdate());
  ipcMain.handle("settings:system-status", () => systemStatus.scan());
  ipcMain.handle("settings:update", async (_event, value) => {
    const current = settingsService.load();
    const patch = settingsService.safePatch(value, current);
    const settings = settingsService.save({ ...current, ...patch });
    let ownerProfileTitleSync = null;
    if (Object.hasOwn(patch, "identity")) {
      const previousName = ownerDisplayName(current);
      const nextName = ownerDisplayName(settings);
      if (previousName !== nextName && typeof contacts.syncOwnerProfileTitle === "function") {
        ownerProfileTitleSync = await contacts.syncOwnerProfileTitle({ previousName, name: nextName });
      }
    }
    if (Object.hasOwn(patch, "memoryRecallEnabled")
      && current.memoryRecallEnabled !== settings.memoryRecallEnabled
      && typeof onMemoryRecallEnabledChanged === "function") {
      // The setting is already durable. A project with an invalid user-owned
      // Hook file must not make this global switch look like it failed.
      await Promise.resolve(onMemoryRecallEnabledChanged({ enabled: settings.memoryRecallEnabled })).catch(() => undefined);
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
  ipcMain.handle("shell:open-external", async (_event, targetUrl) => {
    const url = externalUrl(targetUrl);
    if (!url || typeof shell?.openExternal !== "function") return false;
    await shell.openExternal(url);
    return true;
  });
}
