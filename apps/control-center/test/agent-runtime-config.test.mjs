import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentRuntimeConfigService } from "../electron/services/agent-runtime-config.mjs";
import { renderAdmin } from "../src/features/agent/index.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("runtime settings preserve unknown Claude fields without loading the retired bridge config", async () => {
  const root = await temporaryDirectory("suzu-runtime-");
  const projectRoot = path.join(root, "agent");
  const home = path.join(root, "home");
  const deviceClaudePath = path.join(home, ".claude", "settings.json");
  await fs.mkdir(path.join(projectRoot, ".claude"), { recursive: true });
  await fs.mkdir(path.dirname(deviceClaudePath), { recursive: true });
  await fs.writeFile(path.join(projectRoot, ".claude", "settings.json"), JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "keep-this-hook" }] }] },
    env: { PROJECT_ONLY: "present" },
    alwaysThinkingEnabled: false,
    skipWebFetchPreflight: false,
    permissions: { allow: ["Read"] },
    customField: { keep: true },
  }, null, 2));
  await fs.writeFile(deviceClaudePath, JSON.stringify({
    env: {
      ANTHROPIC_AUTH_TOKEN: "fixture-secret", KEEP: "present", ANTHROPIC_BASE_URL: "https://proxy.example.test",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet-before", ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "Sonnet Before",
    },
    includeCoAuthoredBy: false,
    deviceCustomField: { keep: true },
  }, null, 2));
  const settings = { projectRoot };
  const service = createAgentRuntimeConfigService({ settingsService: { load: () => settings }, homeDirectory: () => home });

  const initial = await service.snapshot();
  assert.equal(initial.claude.status, "ready");
  assert.equal(initial.claude.settings.textService.hasAuthToken, true);
  assert.equal(initial.claude.settings.alwaysThinkingEnabled, false);
  assert.equal(initial.claude.deviceExists, true);
  assert.equal(initial.claude.projectExists, true);
  assert.equal(initial.claude.settings.textService.sonnet.name, "Sonnet Before");
  assert.equal(Object.hasOwn(initial.claude.settings.textService, "authToken"), false);
  assert.equal(Object.hasOwn(initial, "ccConnect"), false);

  const afterClaude = await service.saveClaude({
    allowedTools: "Read\nGrep", deniedTools: "Read(./.env)", baseUrl: "https://proxy.example.test",
    authToken: "", alwaysThinkingEnabled: true, includeCoAuthoredBy: true, skipWebFetchPreflight: true,
    sonnetModel: "sonnet-fixture", sonnetModelName: "Sonnet", opusModel: "opus-fixture", opusModelName: "Opus",
    haikuModel: "haiku-fixture", haikuModelName: "Haiku",
  });
  assert.equal(afterClaude.claude.settings.alwaysThinkingEnabled, true);
  assert.equal(afterClaude.claude.settings.textService.opus.model, "opus-fixture");
  assert.equal(afterClaude.claude.settings.textService.hasAuthToken, true);
  const projectClaudeFile = JSON.parse(await fs.readFile(path.join(projectRoot, ".claude", "settings.json"), "utf8"));
  const deviceClaudeFile = JSON.parse(await fs.readFile(deviceClaudePath, "utf8"));
  assert.equal(projectClaudeFile.hooks.UserPromptSubmit[0].hooks[0].command, "keep-this-hook");
  assert.equal(projectClaudeFile.customField.keep, true);
  assert.equal(projectClaudeFile.env.PROJECT_ONLY, "present");
  assert.equal(projectClaudeFile.alwaysThinkingEnabled, true);
  assert.equal(projectClaudeFile.skipWebFetchPreflight, true);
  assert.equal(Object.hasOwn(projectClaudeFile, "model"), false);
  assert.equal(Object.hasOwn(projectClaudeFile, "effortLevel"), false);
  assert.equal(Object.hasOwn(projectClaudeFile.permissions, "defaultMode"), false);
  assert.equal(deviceClaudeFile.env.ANTHROPIC_AUTH_TOKEN, "fixture-secret");
  assert.equal(deviceClaudeFile.env.KEEP, "present");
  assert.equal(deviceClaudeFile.includeCoAuthoredBy, true);
  assert.equal(deviceClaudeFile.deviceCustomField.keep, true);
  assert.equal(deviceClaudeFile.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME, "Haiku");

  await service.saveClaude({
    preserveTextService: true,
    allowedTools: "Read", deniedTools: "", alwaysThinkingEnabled: false,
    includeCoAuthoredBy: false, skipWebFetchPreflight: false,
  });
  const preservedDeviceFile = JSON.parse(await fs.readFile(deviceClaudePath, "utf8"));
  assert.equal(preservedDeviceFile.env.ANTHROPIC_AUTH_TOKEN, "fixture-secret");
  assert.equal(preservedDeviceFile.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME, "Haiku");

});

test("Claude Code API writes only the system-level Claude files and preserves unrelated settings", async () => {
  const root = await temporaryDirectory("suzu-claude-api-");
  const home = path.join(root, "home");
  const deviceClaudePath = path.join(home, ".claude", "settings.json");
  const userConfigPath = path.join(home, ".claude.json");
  const requests = [];
  await fs.mkdir(path.dirname(deviceClaudePath), { recursive: true });
  await fs.writeFile(deviceClaudePath, JSON.stringify({ env: { KEEP: "preserve" }, hooks: { keep: true } }, null, 2));
  const service = createAgentRuntimeConfigService({
    settingsService: { load: () => ({}) },
    homeDirectory: () => home,
    fetchImpl: async (url, options) => {
      requests.push({ url, headers: options.headers });
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: "MiniMax-M2.7" }, { id: "MiniMax-M2.7" }] }) };
    },
  });

  const before = await service.claudeCodeApiSnapshot();
  assert.equal(before.status, "new");
  assert.equal(before.settingsExists, true);
  assert.equal(before.userConfigExists, false);
  assert.equal(before.skipOnboarding, true);
  assert.equal(before.hasApiKey, false);

  const saved = await service.saveClaudeCodeApi({
    provider: "deepseek", apiKey: "fixture-text-key", model: "deepseek-v4-pro[1m]",
    sonnetModel: "deepseek-v4-pro[1m]", opusModel: "deepseek-v4-pro[1m]",
    haikuModel: "deepseek-v4-flash", subagentModel: "deepseek-v4-flash", effortLevel: "max",
    skipOnboarding: true,
  });
  assert.equal(saved.status, "ready");
  assert.equal(saved.providerId, "deepseek");
  assert.equal(saved.hasApiKey, true);
  assert.equal(Object.hasOwn(saved, "apiKey"), false);
  const device = JSON.parse(await fs.readFile(deviceClaudePath, "utf8"));
  const userConfig = JSON.parse(await fs.readFile(userConfigPath, "utf8"));
  assert.equal(device.env.KEEP, "preserve");
  assert.equal(device.hooks.keep, true);
  assert.equal(device.env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
  assert.equal(device.env.ANTHROPIC_AUTH_TOKEN, "fixture-text-key");
  assert.equal(device.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "deepseek-v4-flash");
  assert.equal(userConfig.hasCompletedOnboarding, true);

  const switchedOff = await service.saveClaudeCodeApi({ provider: "deepseek", skipOnboarding: false });
  assert.equal(switchedOff.skipOnboarding, false);
  const userConfigAfter = JSON.parse(await fs.readFile(userConfigPath, "utf8"));
  assert.equal(Object.hasOwn(userConfigAfter, "hasCompletedOnboarding"), false);
  const deviceAfter = JSON.parse(await fs.readFile(deviceClaudePath, "utf8"));
  assert.equal(deviceAfter.env.ANTHROPIC_AUTH_TOKEN, "fixture-text-key");

  const miniMaxModels = await service.fetchClaudeCodeModels({ provider: "minimax", apiKey: "fixture-model-list-key" });
  assert.deepEqual(miniMaxModels.models, ["MiniMax-M2.7"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.minimaxi.com/anthropic/v1/models");
  assert.equal(requests[0].headers["X-Api-Key"], "fixture-model-list-key");
  const bailianModels = await service.fetchClaudeCodeModels({ provider: "bailian-coding" });
  assert.equal(bailianModels.status, "unsupported");
  assert.equal(requests.length, 1);
  const kimiModels = await service.fetchClaudeCodeModels({ provider: "kimi" });
  assert.equal(kimiModels.status, "ready");
  assert.ok(kimiModels.models.includes("kimi-for-coding"));
});

test("management keeps the Claude connection overview focused and does not render retired bridge controls", () => {
  const runtime = {
    claude: { status: "ready", exists: true, settings: { alwaysThinkingEnabled: true, includeCoAuthoredBy: false, skipWebFetchPreflight: false, allowedTools: ["Read"], deniedTools: [], textService: { baseUrl: "https://proxy.example.test", hasAuthToken: true, sonnet: { model: "sonnet", name: "Sonnet" }, opus: {}, haiku: {} } } },
  };
  const overview = renderAdmin({ state: { adminTab: "runtime", runtimeSection: "overview", agentRuntime: runtime, settings: { contactsRoot: "D:/Agents" } } });
  const claude = renderAdmin({ state: { adminTab: "runtime", runtimeSection: "claude", agentRuntime: runtime } });
  assert.match(overview, /data-admin-tab="runtime"/u);
  assert.match(overview, /data-open-runtime-section="claude"/u);
  assert.doesNotMatch(overview, /id="claudeRuntimeConfigForm"/u);
  assert.match(claude, /id="claudeRuntimeConfigForm"/u);
  assert.match(claude, /alwaysThinkingEnabled/u);
  assert.match(claude, /skipWebFetchPreflight/u);
  assert.match(overview, /连接与运行/u);
  assert.match(overview, /工作目录与默认规则/u);
  assert.match(overview, /Agent 工作目录/u);
  assert.doesNotMatch(`${overview}${claude}`, /fixture-secret/u);
});

test("Claude Code API page keeps secrets out of the renderer and exposes provider choices", () => {
  const page = renderAdmin({
    state: {
      adminTab: "claude-code",
      claudeCodeApi: {
        status: "ready", providerId: "deepseek", baseUrl: "https://api.deepseek.com/anthropic",
        hasApiKey: true, model: "deepseek-v4-pro[1m]", skipOnboarding: true,
      },
      claudeCodeModels: ["deepseek-v4-pro[1m]"],
      claudeCodeModelNotice: "已获取 1 个模型。",
    },
  });
  assert.match(page, /id="claudeCodeApiForm"/u);
  assert.match(page, /DeepSeek/u);
  assert.match(page, /MiniMax/u);
  assert.match(page, /Kimi Code/u);
  assert.match(page, /data-fetch-claude-code-models/u);
  assert.match(page, /skipOnboarding/u);
  assert.doesNotMatch(page, /fixture-text-key|fixture-model-list-key/u);
});
