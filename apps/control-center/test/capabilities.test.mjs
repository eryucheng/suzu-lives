import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { stableAgentId } from "@suzu-lives/agent-registry";
import { configureCapability } from "@suzu-lives/capability-registry";
import { capabilityIpcResult, createCapabilitiesService, packagedCliCommand } from "../electron/ipc/capabilities-ipc.mjs";
import { renderAdmin, renderCapabilities } from "../src/features/agent/index.mjs";

function createTimeAwarenessHooksStub() {
  let installed = false;
  return {
    inspectTimeAwareness: async () => ({ installed }),
    installTimeAwareness: async () => { installed = true; return { status: "installed" }; },
    uninstallTimeAwareness: async () => { installed = false; return { status: "uninstalled" }; },
  };
}

test("abilities use overview, category, then settings pages without implementation internals", () => {
  const snapshot = {
    capabilities: [{ id: "image-vision", name: "图像理解", description: "理解一张明确提供的本地图片。", category: "perceive", setting: { route: "api", label: "设置图像理解" }, added: false, enabled: false, canToggle: true, savedSettings: { saved: true, provider: { baseUrl: "https://vision.example.test/v1", model: "vision-test" } } }],
  };
  const overview = renderCapabilities({ state: { capabilityPage: "overview", capabilitySnapshot: snapshot } });
  const category = renderCapabilities({ state: { capabilityPage: "category", capabilityCategory: "perceive", capabilitySnapshot: snapshot } });
  const detail = renderCapabilities({ state: { capabilityPage: "detail", capabilityCategory: "perceive", capabilitySelectedId: "image-vision", capabilitySnapshot: snapshot } });

  assert.match(overview, /CAPABILITIES/u);
  assert.match(overview, /data-open-capability-category="perceive"/u);
  assert.doesNotMatch(overview, /data-toggle-capability/u);
  assert.match(category, /data-open-capability="image-vision"/u);
  assert.doesNotMatch(category, /data-toggle-capability/u);
  assert.match(detail, /data-toggle-capability="image-vision"/u);
  assert.match(detail, /data-capability-settings-form="image-vision"/u);
  assert.match(detail, /保存图片理解设置/u);
  assert.match(detail, /vision-test/u);
  assert.doesNotMatch(detail, /Claude 注册|稳定 ID|真实前置条件|缺失配置|稳定命令/u);
});

test("WeChat is a software-level action and never becomes a Claude Skill", () => {
  const view = renderCapabilities({
    state: {
      capabilityPage: "detail",
      capabilityCategory: "act",
      capabilitySelectedId: "wechat-connection",
      capabilitySnapshot: { capabilities: [] },
      wechatSnapshot: { enabled: true, linkedSessions: 2, delivery: { agent: true, tools: true } },
    },
  });
  assert.match(view, /连接微信/u);
  assert.match(view, /data-toggle-wechat-connection checked/u);
  assert.match(view, /data-wechat-delivery="agent" checked/u);
  assert.match(view, /联系人项目和 Claude 会话/u);
  assert.doesNotMatch(view, /data-toggle-capability="wechat-connection"/u);
});

test("abilities live in the primary sidebar instead of management tabs", async () => {
  const sidebar = await fs.readFile(new URL("../src/index.html", import.meta.url), "utf8");
  const app = await fs.readFile(new URL("../src/app.mjs", import.meta.url), "utf8");
  const management = renderAdmin({ state: { adminTab: "overview" } });

  assert.match(sidebar, /data-view="capabilities"[^>]*>[\s\S]*?<span>能力<\/span>/u);
  assert.match(app, /state\.view === "capabilities"[\s\S]*?renderCapabilities\(context\)/u);
  assert.match(app, /function setCapabilityPage\(page, category = "", abilityId = ""\)/u);
  assert.doesNotMatch(management, /data-admin-tab="capabilities"/u);
});

test("an enabled ability shows a real Agent-facing switch", () => {
  const capability = {
    id: "image-vision",
    name: "图像理解",
    description: "fixture",
    category: "perceive",
    setting: { route: "api", label: "设置图像理解" },
    added: true,
    enabled: true,
    canToggle: true,
    savedSettings: { saved: false },
  };
  const view = renderCapabilities({ state: { capabilityPage: "detail", capabilityCategory: "perceive", capabilitySelectedId: "image-vision", capabilitySnapshot: { capabilities: [capability] } } });
  assert.match(view, /已开启/u);
  assert.match(view, /data-toggle-capability="image-vision" checked/u);
  assert.doesNotMatch(view, /已加入当前 Agent|注册/u);
});

test("web automation opens websites first, then exposes only that website's real action controls", () => {
  const siteAutomation = {
    id: "site-automation",
    name: "网页自动化",
    description: "使用已接入网站的实际适配器。",
    category: "act",
    added: true,
    enabled: true,
    canToggle: true,
    savedSettings: {
      sites: [{
        id: "douyin",
        name: "抖音",
        enabled: true,
        actions: [
          { id: "feed", label: "进入推荐流", group: "浏览与发现", description: "打开推荐内容。", mutating: false, enabled: true },
          { id: "comment", label: "发布评论", group: "浏览与互动", description: "在当前内容下发布评论。", mutating: true, enabled: false },
        ],
      }],
      configuration: {},
    },
  };
  const overview = renderCapabilities({
    state: { capabilityPage: "detail", capabilityCategory: "act", capabilitySelectedId: "site-automation", capabilitySnapshot: { capabilities: [siteAutomation] } },
  });
  const detail = renderCapabilities({
    state: { capabilityPage: "detail", capabilityCategory: "act", capabilitySelectedId: "site-automation", siteAutomationSelectedSiteId: "douyin", capabilitySnapshot: { capabilities: [siteAutomation] } },
  });

  assert.match(overview, /已接入的网站/u);
  assert.match(overview, /data-open-site-automation-site="douyin"/u);
  assert.doesNotMatch(overview, /data-site-action-enabled/u);
  assert.match(detail, /返回网页自动化/u);
  assert.match(detail, /data-site-enabled="douyin" checked/u);
  assert.match(detail, /data-site-action-enabled="douyin" data-site-action="feed" checked/u);
  assert.match(detail, /data-site-action-enabled="douyin" data-site-action="comment"/u);
  assert.doesNotMatch(detail, /data-toggle-capability="site-automation"/u);
});

test("capability registration writes only after the service receives an explicit register call", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-capabilities-project-"));
  const settingsService = { load: () => ({ projectRoot }) };
  const service = createCapabilitiesService({ settingsService, existsCommand: () => true });

  const before = service.snapshot();
  assert.equal(before.capabilities.find((item) => item.id === "image-vision").canAdd, true);
  assert.equal(await fs.stat(projectRoot).then(() => fs.readdir(projectRoot)).then((items) => items.length), 0);

  const result = await service.register("image-vision");
  const claude = await fs.readFile(path.join(projectRoot, "CLAUDE.md"), "utf8");
  const abilities = await fs.readFile(path.join(projectRoot, "abilities.md"), "utf8");
  const skill = await fs.readFile(path.join(projectRoot, ".claude", "skills", "image-vision", "SKILL.md"), "utf8");
  assert.equal(result.registration.abilityId, "image-vision");
  assert.equal((claude.match(/^@abilities\.md$/gmu) || []).length, 1);
  assert.match(abilities, /suzu-lives:ability:image-vision/u);
  assert.match(skill, /suzu-lives image-vision/u);
});

test("the first ability visit safely enables the catalog once and preserves later switches", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-default-capabilities-project-"));
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-default-capabilities-data-"));
  const agentId = stableAgentId(projectRoot);
  const settings = { projectRoot, dataRoot, agentId };
  const service = createCapabilitiesService({ settingsService: { load: () => settings, response: () => ({ dataRoot }) }, existsCommand: () => true, projectHooksService: createTimeAwarenessHooksStub() });

  const initialized = await service.initializeDefaults();
  assert.equal(initialized.initialized, true);
  assert.equal(initialized.errors.length, 0);
  assert.ok(initialized.snapshot.capabilities.every((item) => item.enabled === true));
  assert.equal(JSON.parse(await fs.readFile(path.join(dataRoot, "agents", agentId, "capabilities", "defaults-v1.json"), "utf8")).initialized, true);

  await service.setActive({ id: "phone-camera", enabled: false });
  const again = await service.initializeDefaults();
  assert.equal(again.initialized, false);
  assert.equal(again.snapshot.capabilities.find((item) => item.id === "phone-camera").enabled, false);
});

test("phone camera and traveling merchant settings use the existing software-side config paths", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-capability-settings-project-"));
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-capability-settings-data-"));
  const agentId = stableAgentId(projectRoot);
  const settings = { projectRoot, dataRoot, agentId };
  const service = createCapabilitiesService({ settingsService: { load: () => settings, response: () => ({ dataRoot }) }, existsCommand: () => true });

  await service.saveSettings({ id: "phone-camera", value: { promptPrefix: "自然生活感", promptSuffix: "不要棚拍" } });
  const phonePath = path.join(dataRoot, "agents", agentId, "phone-camera", "config.json");
  assert.deepEqual(JSON.parse(await fs.readFile(phonePath, "utf8")).prompt, { prefix: "自然生活感", suffix: "不要棚拍" });
  const snapshot = await service.saveSettings({ id: "traveling-merchant", value: { wantedItems: "棱镜球\n炫彩蛋\n棱镜球" } });
  const merchantPath = path.join(dataRoot, "automation", "traveling-merchant", "config.json");
  assert.deepEqual(JSON.parse(await fs.readFile(merchantPath, "utf8")).wantedItems, ["棱镜球", "炫彩蛋"]);
  assert.deepEqual(snapshot.capabilities.find((item) => item.id === "traveling-merchant").savedSettings.wantedItems, ["棱镜球", "炫彩蛋"]);

  const phoneView = renderCapabilities({ state: { capabilityPage: "detail", capabilityCategory: "create", capabilitySelectedId: "phone-camera", capabilitySnapshot: snapshot } });
  const merchantView = renderCapabilities({ state: { capabilityPage: "detail", capabilityCategory: "companion", capabilitySelectedId: "traveling-merchant", capabilitySnapshot: snapshot } });
  assert.match(phoneView, /data-capability-settings-form="phone-camera"/u);
  assert.match(phoneView, /自然生活感/u);
  assert.match(merchantView, /data-capability-settings-form="traveling-merchant"/u);
  assert.match(merchantView, /棱镜球/u);
});

test("session delivery settings keep multiple targets in their own capability configs", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-companion-project-"));
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-companion-data-"));
  const agentId = stableAgentId(projectRoot);
  const settings = { projectRoot, dataRoot, agentId };
  const opened = [];
  const service = createCapabilitiesService({
    settingsService: { load: () => settings, response: () => ({ dataRoot }) },
    existsCommand: () => true,
    openExternal: async (url) => { opened.push(url); },
  });

  await service.saveSettings({ id: "proactive-contact", value: { chainPrompt: "链式提示", followUpPrompt: "回访提示" } });
  await service.saveSettings({ id: "proactive-contact", value: { sessionId: "session-a", sessionEnabled: true } });
  await service.saveSettings({ id: "proactive-contact", value: { sessionId: "session-b", sessionEnabled: true } });
  await service.saveSettings({ id: "traveling-merchant", value: { sessionId: "session-a", sessionEnabled: true } });
  await service.saveSettings({ id: "traveling-merchant", value: { sessionId: "session-b", sessionEnabled: true } });
  await service.register("iphone-bridge");
  await service.saveSettings({ id: "iphone-bridge", value: { sessionId: "session-a", sessionEnabled: true } });
  await service.saveSettings({ id: "iphone-bridge", value: { sessionId: "session-b", sessionEnabled: true } });

  assert.equal(service.isCompanionSessionEnabled({ abilityId: "proactive-contact", sessionId: "session-a", projectRoot }), true);
  assert.equal(service.isCompanionSessionEnabled({ abilityId: "proactive-contact", sessionId: "session-b", projectRoot }), true);
  assert.equal(service.enabledCompanionSessions("traveling-merchant").length, 2);
  assert.equal(service.enabledIphoneBridgeSessions().length, 2);
  const proactive = JSON.parse(await fs.readFile(path.join(dataRoot, "automation", "proactive-contact", "config.json"), "utf8"));
  assert.equal(proactive.chainPrompt, "链式提示");
  assert.equal(proactive.followUpPrompt, "回访提示");
  assert.equal(proactive.enabledSessions.length, 2);
  const iphoneDelivery = JSON.parse(await fs.readFile(path.join(dataRoot, "automation", "iphone-bridge", "config.json"), "utf8"));
  assert.equal(iphoneDelivery.enabledSessions.length, 2);

  const snapshot = service.snapshot();
  const companionView = renderCapabilities({ state: {
    capabilityPage: "detail",
    capabilityCategory: "companion",
    capabilitySelectedId: "proactive-contact",
    capabilitySnapshot: snapshot,
    companionSessions: {
      projectRoot,
      sessions: [
        { id: "session-a", title: "会话 A", preview: "第一条" },
        { id: "session-b", title: "会话 B", preview: "第二条" },
      ],
    },
  } });
  assert.match(companionView, /链式提示/u);
  assert.match(companionView, /data-session-delivery-enabled="proactive-contact"/u);
  assert.match(companionView, /会话 A/u);

  const iphoneView = renderCapabilities({ state: {
    capabilityPage: "detail",
    capabilityCategory: "act",
    capabilitySelectedId: "iphone-bridge",
    capabilitySnapshot: snapshot,
    companionSessions: {
      projectRoot,
      sessions: [
        { id: "session-a", title: "会话 A", preview: "第一条" },
        { id: "session-b", title: "会话 B", preview: "第二条" },
      ],
    },
  } });
  assert.match(iphoneView, /本地直接接收/u);
  assert.match(iphoneView, /data-session-delivery-enabled="iphone-bridge"/u);
  assert.match(iphoneView, /可以同时勾选多个会话/u);

  const page = await service.openTravelingMerchantPage();
  assert.equal(opened[0], page.url);
  assert.match(page.url, /^https:\/\//u);
});

test("each configurable ability saves only its real software-side settings and never exposes stored secrets", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-capability-real-settings-project-"));
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-capability-real-settings-data-"));
  const agentId = stableAgentId(projectRoot);
  const agentRoot = path.join(dataRoot, "agents", agentId);
  const settings = { projectRoot, dataRoot, agentId };
  const service = createCapabilitiesService({ settingsService: { load: () => settings, response: () => ({ dataRoot }) }, existsCommand: () => true });
  await fs.mkdir(path.join(agentRoot, "voice-design"), { recursive: true });
  await fs.writeFile(path.join(agentRoot, "voice-design", "candidates.jsonl"), `${JSON.stringify({ id: "candidate-1", voiceId: "voice-saved", preferredName: "夜色", targetModel: "qwen-voice" })}\n`, "utf8");
  await fs.mkdir(path.join(dataRoot, "capabilities", "image-vision"), { recursive: true });
  await fs.writeFile(path.join(dataRoot, "capabilities", "image-vision", "config.json"), JSON.stringify({ openai: { api_key: "vision-secret", base_url: "https://keep.example.test/v1", model: "old" } }), "utf8");
  await fs.mkdir(path.join(agentRoot, "site-automation"), { recursive: true });
  await fs.writeFile(path.join(agentRoot, "site-automation", "config.json"), JSON.stringify({ douyin: { ownerToken: "private-value" } }), "utf8");

  await service.saveSettings({ id: "image-generation", value: { defaultBackend: "comfyui", comfyBaseUrl: "http://127.0.0.1:8188", comfyTimeoutSeconds: 120, comfyPollIntervalSeconds: 0.5, comfyDefaultWorkflow: "portrait" } });
  await service.saveSettings({ id: "phone-camera", value: { defaultBackend: "comfyui", rearSize: "1600x1000", selfieSize: "1000x1600", mirrorSize: "1000x1600", maxImages: 6, promptPrefix: "自然", promptSuffix: "室内" } });
  await service.saveSettings({ id: "image-vision", value: { model: "vision-selected", detail: "high", timeoutSeconds: 100, maxOutputTokens: 900, maxImageBytes: 2000000, maxEdge: 1800, jpegQuality: 85, retryOnRefusal: false } });
  await service.saveSettings({ id: "video-understanding", value: { model: "video-selected", fps: 2, timeoutSeconds: 300, maxOutputTokens: 600, temperature: 0.4, maxBinaryBytes: 8000000, cacheEnabled: false, ffmpegPath: "ffmpeg-custom", ffprobePath: "ffprobe-custom" } });
  await service.saveSettings({ id: "voice-message", value: { voiceId: "voice-saved", timeoutMs: 45000 } });
  await service.saveSettings({ id: "site-automation", value: { cdpUrl: "http://127.0.0.1:9333", timeoutMs: 12000, navigationTimeoutMs: 30000, autoStartBrowser: false, pythonCommand: "python3" } });
  const snapshot = await service.saveSettings({ id: "traveling-merchant", value: { url: "https://merchant.example.test", wantedItems: "棱镜球", notificationTemplate: "有：{items}", notifyOnError: false, errorNotificationTemplate: "失败：{error}", requestTimeoutSeconds: 20, maxAttempts: 4, retryDelaySeconds: 15 } });

  const image = JSON.parse(await fs.readFile(path.join(agentRoot, "image-generation", "config.json"), "utf8"));
  const phone = JSON.parse(await fs.readFile(path.join(agentRoot, "phone-camera", "config.json"), "utf8"));
  const vision = JSON.parse(await fs.readFile(path.join(dataRoot, "capabilities", "image-vision", "config.json"), "utf8"));
  const video = JSON.parse(await fs.readFile(path.join(dataRoot, "capabilities", "video-understanding", "config.json"), "utf8"));
  const voice = JSON.parse(await fs.readFile(path.join(dataRoot, "capabilities", "voice-message", "config.json"), "utf8"));
  const site = JSON.parse(await fs.readFile(path.join(agentRoot, "site-automation", "config.json"), "utf8"));
  const merchant = JSON.parse(await fs.readFile(path.join(dataRoot, "automation", "traveling-merchant", "config.json"), "utf8"));
  assert.equal(image.default_backend, "comfyui");
  assert.equal(image.comfyui.default_workflow, "portrait");
  assert.equal(phone.size_by_shot.rear, "1600x1000");
  assert.equal(phone.references.max_images, 6);
  assert.equal(vision.openai.api_key, "vision-secret");
  assert.equal(vision.vision.detail, "high");
  assert.equal(video.provider.model, "video-selected");
  assert.equal(video.video.cache_enabled, false);
  assert.equal(voice.voiceId, "voice-saved");
  assert.equal(voice.timeoutMs, 45000);
  assert.equal(site.douyin.ownerToken, "private-value");
  assert.equal(site.autoStartBrowser, false);
  assert.equal(merchant.notificationTemplate, "有：{items}");
  assert.equal(merchant.notifyOnError, false);
  assert.equal(snapshot.capabilities.find((item) => item.id === "voice-message").savedSettings.candidates[0].voiceId, "voice-saved");
  assert.doesNotMatch(JSON.stringify(snapshot), /vision-secret|private-value/u);
});

test("website action switches preserve private site configuration and accept only registered site actions", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-site-action-project-"));
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-site-action-data-"));
  const agentId = stableAgentId(projectRoot);
  const agentRoot = path.join(dataRoot, "agents", agentId);
  const configPath = path.join(agentRoot, "site-automation", "config.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ douyin: { ownerToken: "private-value" }, timeoutMs: 12345 }), "utf8");
  const settings = { projectRoot, dataRoot, agentId };
  const service = createCapabilitiesService({ settingsService: { load: () => settings, response: () => ({ dataRoot }) }, existsCommand: () => true });

  const response = await service.saveSettings({ id: "site-automation", value: { siteId: "douyin", action: "feed", actionEnabled: false } });
  const stored = JSON.parse(await fs.readFile(configPath, "utf8"));
  const douyin = response.capabilities.find((capability) => capability.id === "site-automation").savedSettings.sites.find((site) => site.id === "douyin");
  assert.equal(stored.douyin.ownerToken, "private-value");
  assert.equal(stored.timeoutMs, 12345);
  assert.equal(stored.sites.douyin.actions.feed, false);
  assert.equal(douyin.actions.find((action) => action.id === "feed").enabled, false);
  assert.doesNotMatch(JSON.stringify(response), /private-value/u);
  await service.saveSettings({ id: "site-automation", value: { siteId: "douyin", siteEnabled: false } });
  const afterSiteToggle = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(afterSiteToggle.sites.douyin.enabled, false);
  assert.equal(afterSiteToggle.sites.douyin.actions.feed, false);
  await assert.rejects(
    () => service.saveSettings({ id: "site-automation", value: { siteId: "unknown-site", siteEnabled: false } }),
    /尚未接入/u,
  );
  await assert.rejects(
    () => service.saveSettings({ id: "site-automation", value: { siteId: "douyin", action: "invented-action", actionEnabled: false } }),
    /不属于/u,
  );
});

test("ability switch removes only the Suzu-managed Agent entry and preserves saved settings", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-capability-toggle-project-"));
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-capability-toggle-data-"));
  await fs.mkdir(path.join(dataRoot, "capabilities", "image-vision"), { recursive: true });
  await fs.writeFile(path.join(dataRoot, "capabilities", "image-vision", "config.json"), JSON.stringify({ openai: { api_key: "never-expose", base_url: "https://vision.example.test/v1", model: "vision-test" } }));
  const settingsService = { load: () => ({ projectRoot, dataRoot }), response: () => ({ dataRoot }) };
  const service = createCapabilitiesService({ settingsService, existsCommand: () => true });

  const before = service.snapshot().capabilities.find((item) => item.id === "image-vision");
  assert.deepEqual(before.savedSettings.provider, { baseUrl: "https://vision.example.test/v1", model: "vision-test" });
  assert.doesNotMatch(JSON.stringify(before.savedSettings), /never-expose/u);
  await service.setActive({ id: "image-vision", enabled: true });
  assert.equal(service.snapshot().capabilities.find((item) => item.id === "image-vision").enabled, true);
  const result = await service.setActive({ id: "image-vision", enabled: false });
  assert.equal(result.snapshot.capabilities.find((item) => item.id === "image-vision").enabled, false);
  await assert.rejects(() => fs.readFile(path.join(projectRoot, ".claude", "skills", "image-vision", "SKILL.md"), "utf8"), { code: "ENOENT" });
  assert.match(await fs.readFile(path.join(dataRoot, "capabilities", "image-vision", "config.json"), "utf8"), /never-expose/u);
});

test("capability IPC result preserves a registration conflict code for the renderer", async () => {
  const conflict = await capabilityIpcResult(async () => {
    const error = new Error("目标 SKILL.md 不属于 Suzu Lives，未覆盖用户文件。");
    error.code = "skill-conflict";
    throw error;
  });
  assert.deepEqual(conflict, {
    ok: false,
    error: { code: "skill-conflict", message: "目标 SKILL.md 不属于 Suzu Lives，未覆盖用户文件。" },
  });
});

test("packaged registration writes the actual no-window EXE command without a PATH dependency", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-packaged-capabilities-project-"));
  const executablePath = "C:\\Portable Apps\\Suzu Lives Console.exe";
  const settingsService = { load: () => ({ projectRoot }) };
  const service = createCapabilitiesService({ settingsService, packaged: true, executablePath, existsCommand: () => false });
  const snapshot = service.snapshot();
  assert.equal(snapshot.launcher.available, true);
  assert.equal(snapshot.launcher.command, '"C:\\Portable Apps\\Suzu Lives Console.exe" --suzu-lives-cli');
  await service.register("image-generation");
  const skill = await fs.readFile(path.join(projectRoot, ".claude", "skills", "image-generation", "SKILL.md"), "utf8");
  assert.match(skill, /"C:\\Portable Apps\\Suzu Lives Console\.exe" --suzu-lives-cli image-generation/u);
  assert.doesNotMatch(skill, /`suzu-lives image-generation/u);
  assert.throws(() => packagedCliCommand("relative.exe"));
});

test("capabilities service exposes a testable IPC-only issuance boundary without adding a renderer action", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-capabilities-authorization-data-"));
  const settingsService = {
    load: () => ({}),
    response: () => ({ dataRoot }),
  };
  configureCapability({ dataRoot, id: "computer-camera", configuration: { pythonCommand: "python" } });
  const service = createCapabilitiesService({ settingsService, existsCommand: () => true });
  service.enable("computer-camera");
  const issued = service.issueAuthorization({ id: "computer-camera", request: { operation: "start", cameraIndex: 0, warmupSeconds: 0.1 } });
  assert.match(issued.credential, /^suzu-capability-v1\./u);
  assert.equal(issued.action, "start-session");
});

test("snapshot contains the user-facing catalog rather than the future control registry", () => {
  const service = createCapabilitiesService({ settingsService: { load: () => ({ projectRoot: "C:/temporary-project" }) }, existsCommand: () => true });
  const snapshot = service.snapshot();
  assert.ok(snapshot.capabilities.some((item) => item.id === "image-generation"));
  assert.ok(snapshot.capabilities.some((item) => item.id === "voice-message"));
  assert.equal(snapshot.capabilities.some((item) => item.id === "computer-camera"), false);
  assert.equal(Object.hasOwn(snapshot.capabilities[0], "registration"), false);
});
