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

test("management keeps runtime rules global and has no contact-specific Claude settings entry", () => {
  const overview = renderAdmin({ state: { adminTab: "runtime", settings: { contactsRoot: "D:/Agents" } } });
  assert.match(overview, /data-admin-tab="runtime"/u);
  assert.match(overview, /连接与运行/u);
  assert.match(overview, /默认运行规则/u);
  assert.match(overview, /Claude 工具权限/u);
  assert.doesNotMatch(overview, /data-open-runtime-section|id="claudeRuntimeConfigForm"|当前联系人|当前项目/u);
  assert.doesNotMatch(overview, /Agent 工作目录|fixture-secret/u);
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
