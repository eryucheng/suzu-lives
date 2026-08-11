import assert from "node:assert/strict";
import test from "node:test";

import { normalizeClaudeProjectDefaults, normalizeClaudeRuntimeFeatures, normalizeClaudeToolPermissions, normalizeConversationPreferences, normalizeMemoryRecallEnabled, normalizeOnboardingCompleted, normalizeOnboardingMultimodalCompleted, registerSettingsIpc } from "../electron/ipc/settings-ipc.mjs";
import { renderManagedAgentRuntimeSettings, renderSettings } from "../src/features/settings/index.mjs";

test("data settings show one unified storage location and a migration action", () => {
  const html = renderSettings({
    state: {
      settingsTab: "data",
      settings: {
        contactsRoot: "D:/Agents",
        dataRoot: "D:/Suzu Lives",
        dataStorage: { dataRoot: "D:/Suzu Lives", previousDataRoot: "C:/old/Suzu Lives" },
      },
    },
  });
  assert.match(html, /数据存储位置/u);
  assert.match(html, /data-change-data-location/u);
  assert.match(html, /更换位置/u);
  assert.match(html, /旧位置的安全副本/u);
  assert.match(html, /data-remove-previous-data-copy/u);
  assert.match(html, /Agent 工作目录/u);
  assert.match(html, /data-select-contact-projects-root/u);
  assert.match(html, /D:\/Agents/u);
  assert.doesNotMatch(html, /设置文件/u);
});

test("software settings keeps only application controls", () => {
  const html = renderSettings({
    state: { settingsTab: "general", settings: { contactsRoot: "D:/Agents" } },
  });
  assert.match(html, /首次设置/u);
  assert.match(html, /外观/u);
  assert.doesNotMatch(html, /Agent 工作目录|Claude 工具权限|Claude 内建能力|记忆召回/u);
});

test("management runtime settings keeps only default Claude rules", () => {
  const html = renderManagedAgentRuntimeSettings({
    state: { settings: { contactsRoot: "D:/Agents", claudeToolPermissions: { read: true, webFetch: false, webSearch: true }, claudeRuntimeFeatures: { subagents: true }, memoryRecallEnabled: false } },
  });
  assert.doesNotMatch(html, /Agent 工作目录|data-select-contact-projects-root|D:\/Agents/u);
  assert.match(html, /Claude 工具权限|Claude 内建能力/u);
  assert.doesNotMatch(html, /记忆召回/u);
});

test("first-run setup completion is persisted as a strict boolean and can be reopened from settings", () => {
  assert.equal(normalizeOnboardingCompleted(true), true);
  assert.equal(normalizeOnboardingCompleted(false), false);
  assert.equal(normalizeOnboardingCompleted("true"), false);
  assert.equal(normalizeOnboardingMultimodalCompleted(true), true);
  assert.equal(normalizeOnboardingMultimodalCompleted(false), false);
  assert.equal(normalizeOnboardingMultimodalCompleted("true"), false);
  const html = renderSettings({
    state: { settingsTab: "general", settings: { onboardingCompleted: false } },
  });
  assert.match(html, /首次设置/u);
  assert.match(html, /data-open-onboarding/u);
  assert.match(html, /待完成/u);
});

test("memory recall remains default-on after leaving runtime management", () => {
  assert.equal(normalizeMemoryRecallEnabled(undefined), true);
  assert.equal(normalizeMemoryRecallEnabled(false), false);
  assert.equal(normalizeMemoryRecallEnabled("false"), true);
  const html = renderManagedAgentRuntimeSettings({
    state: { settingsTab: "general", settings: { memoryRecallEnabled: false } },
  });
  assert.doesNotMatch(html, /记忆召回|data-memory-recall-toggle/u);
});

test("Claude read and web permissions are default-on and shown in runtime management", () => {
  assert.deepEqual(normalizeClaudeToolPermissions(), { read: true, webFetch: true, webSearch: true });
  assert.deepEqual(normalizeClaudeToolPermissions({ webFetch: false }), { read: true, webFetch: false, webSearch: true });
  const html = renderManagedAgentRuntimeSettings({
    state: { settingsTab: "general", settings: { claudeToolPermissions: { read: true, webFetch: false, webSearch: true } } },
  });
  assert.match(html, /Claude 工具权限/u);
  assert.match(html, /data-claude-tool-permission="read"/u);
  assert.match(html, /data-claude-tool-permission="webFetch"/u);
  assert.match(html, /允许网页搜索/u);
});

test("shared Claude project defaults normalize the contact-wide tool and network rules", () => {
  assert.deepEqual(normalizeClaudeProjectDefaults(), {
    allowedTools: [],
    deniedTools: [],
    skipWebFetchPreflight: true,
  });
  assert.deepEqual(normalizeClaudeProjectDefaults({
    allowedTools: "Bash(git status:*)\nBash(git status:*)",
    deniedTools: "Read(./.env)\nRead(./.env)\nBash(rm:*)",
    skipWebFetchPreflight: false,
  }), {
    allowedTools: ["Bash(git status:*)"],
    deniedTools: ["Read(./.env)", "Bash(rm:*)"],
    skipWebFetchPreflight: false,
  });
});

test("Claude runtime features are default-off and exposed in runtime management", () => {
  assert.deepEqual(normalizeClaudeRuntimeFeatures(), {
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
  });
  assert.deepEqual(normalizeClaudeRuntimeFeatures({ bash: false, glob: false, subagents: true, nativeCron: true }), {
    bash: false,
    edit: true,
    glob: false,
    grep: true,
    subagents: true,
    taskList: false,
    backgroundTasks: false,
    nativeCron: true,
    askUserQuestion: false,
    write: true,
  });
  const html = renderManagedAgentRuntimeSettings({
    state: { settingsTab: "general", settings: { claudeRuntimeFeatures: { subagents: true } } },
  });
  assert.match(html, /Claude 内建能力/u);
  assert.match(html, /data-claude-runtime-feature="subagents" checked/u);
  assert.match(html, /data-claude-runtime-feature="taskList"/u);
  assert.match(html, /data-claude-runtime-feature="backgroundTasks"/u);
  assert.match(html, /data-claude-runtime-feature="nativeCron"/u);
  assert.match(html, /data-claude-runtime-feature="askUserQuestion"/u);
});

test("changing Claude tool permissions syncs the contact projects", async () => {
  const handlers = new Map();
  const syncCalls = [];
  let stored = { claudeToolPermissions: { read: true, webFetch: true, webSearch: true } };
  registerSettingsIpc({
    app: { relaunch: () => {}, exit: () => {} },
    contactProjectsService: { syncClaudeProjectSettings: async () => { syncCalls.push(true); } },
    dataStorageService: null,
    dialog: { showOpenDialog: async () => ({ canceled: true }), showMessageBox: async () => ({ response: 1 }) },
    getMainWindow: () => null,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    shell: { showItemInFolder: () => {}, openPath: () => {} },
    settingsService: {
      load: () => stored,
      safePatch: (value) => ({ claudeToolPermissions: normalizeClaudeToolPermissions(value.claudeToolPermissions) }),
      save: (next) => { stored = next; return stored; },
      response: (settings) => settings,
    },
  });

  const result = await handlers.get("settings:update")(null, { claudeToolPermissions: { webFetch: false } });
  assert.deepEqual(result.claudeToolPermissions, { read: true, webFetch: false, webSearch: true });
  assert.deepEqual(syncCalls, [true]);
});

test("changing shared Claude project defaults syncs the contact projects", async () => {
  const handlers = new Map();
  const syncCalls = [];
  let stored = {};
  registerSettingsIpc({
    app: { relaunch: () => {}, exit: () => {} },
    contactProjectsService: { syncClaudeProjectSettings: async () => { syncCalls.push(true); } },
    dataStorageService: null,
    dialog: { showOpenDialog: async () => ({ canceled: true }), showMessageBox: async () => ({ response: 1 }) },
    getMainWindow: () => null,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    shell: { showItemInFolder: () => {}, openPath: () => {} },
    settingsService: {
      load: () => stored,
      safePatch: (value) => ({ claudeProjectDefaults: normalizeClaudeProjectDefaults(value.claudeProjectDefaults) }),
      save: (next) => { stored = next; return stored; },
      response: (settings) => settings,
    },
  });

  const result = await handlers.get("settings:update")(null, { claudeProjectDefaults: { skipWebFetchPreflight: false } });
  assert.deepEqual(result.claudeProjectDefaults, {
    allowedTools: [],
    deniedTools: [],
    skipWebFetchPreflight: false,
  });
  assert.deepEqual(syncCalls, [true]);
});

test("conversation time display defaults to the centered mode and migrates the old enum", () => {
  assert.deepEqual(normalizeConversationPreferences({ timeDisplay: "center" }), {
    attachments: true,
    tools: true,
    thinking: true,
    system: true,
    tokens: true,
    timeDisplay: "center",
  });
  assert.equal(normalizeConversationPreferences({ timeDisplay: "wechat" }).timeDisplay, "center");
  assert.equal(normalizeConversationPreferences().timeDisplay, "center");
  assert.equal(normalizeConversationPreferences({ timeDisplay: "bubble" }).timeDisplay, "bubble");
});

test("migration IPC schedules a restart only after directory and confirmation dialogs succeed", async () => {
  const handlers = new Map();
  const calls = [];
  const app = {
    relaunch: () => calls.push("relaunch"),
    exit: (code) => calls.push(["exit", code]),
  };
  const dialog = {
    showOpenDialog: async () => ({ canceled: false, filePaths: ["D:/Suzu data"] }),
    showMessageBox: async () => ({ response: 0 }),
  };
  const dataStorageService = {
    dataRoot: "C:/Suzu Lives",
    targetFromSelection: (value) => `${value}/Suzu Lives`,
    validateMigration: (targetRoot) => ({ status: "ready", sourceRoot: "C:/Suzu Lives", targetRoot }),
    scheduleMigration: (targetRoot) => ({ status: "scheduled", targetRoot }),
  };
  registerSettingsIpc({
    app,
    dataStorageService,
    dialog,
    getMainWindow: () => null,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    shell: { showItemInFolder: () => {}, openPath: () => {} },
    settingsService: { load: () => ({}), save: (next) => next, response: () => ({}) },
  });

  const result = await handlers.get("settings:change-data-location")();
  assert.deepEqual(result, { status: "scheduled", targetRoot: "D:/Suzu data/Suzu Lives" });
  assert.deepEqual(calls, ["relaunch", ["exit", 0]]);
});

test("old-copy cleanup IPC requires a second destructive confirmation", async () => {
  const handlers = new Map();
  const calls = [];
  const dataStorageService = {
    snapshot: () => ({ previousDataRoot: "C:/old/Suzu Lives" }),
    removePreviousDataCopy: () => {
      calls.push("removed");
      return { status: "removed", previousDataRoot: "C:/old/Suzu Lives" };
    },
  };
  registerSettingsIpc({
    app: { relaunch: () => {}, exit: () => {} },
    dataStorageService,
    dialog: { showOpenDialog: async () => ({ canceled: true }), showMessageBox: async () => ({ response: 0 }) },
    getMainWindow: () => null,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    shell: { showItemInFolder: () => {}, openPath: () => {} },
    settingsService: { load: () => ({}), save: (next) => next, response: () => ({ dataStorage: { previousDataRoot: "" } }) },
  });

  const result = await handlers.get("settings:remove-previous-data-copy")();
  assert.equal(result.status, "removed");
  assert.deepEqual(calls, ["removed"]);
});
