import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";
import { createScheduleTask, listScheduleTasks } from "@suzu-lives/task-scheduler";

import { createCapabilityAccessPolicy } from "../electron/services/capability-access-policy.mjs";
import { createCapabilityRegistry, createCapabilityRuntime } from "../electron/services/capability-registry.mjs";
import { createAgentCapabilityAdapters } from "../electron/services/agent-capability-adapters.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function contactFixture(root) {
  return {
    agentId: "agent-capability",
    id: "contact-capability",
    name: "Suzu",
    projectRoot: path.join(root, "contact"),
  };
}

function settingsService(dataRoot) {
  return {
    load: () => ({}),
    response: () => ({ dataRoot }),
  };
}

test("Agent capability adapters reuse product-owned executors with the active contact scope", async () => {
  const root = await temporaryDirectory("suzu-agent-capability-adapters-");
  const dataRoot = path.join(root, "data");
  const contact = contactFixture(root);
  const calls = [];
  const adapters = createAgentCapabilityAdapters({
    connectionsService: {
      resolveNamedApiConnection: async (feature) => ({
        "image-workbench": { apiKey: "image-key", baseUrl: "https://images.example.test/v1", key: "image-key", model: "image-model", name: "我的图像接口", provider: "fixture", type: "openai-compatible" },
        "image-vision": { apiKey: "vision-key", baseUrl: "https://dashscope.aliyuncs.com/api/v1", key: "vision-key", model: "vision-model", name: "我的图像理解", type: "dashscope" },
        "video-understanding": { apiKey: "video-key", baseUrl: "https://dashscope.aliyuncs.com/api/v1", key: "video-key", model: "video-model", name: "我的视频理解", type: "dashscope" },
        "voice-message": {
          apiKey: "voice-key",
          baseUrl: "https://voice.example.test/v1",
          key: "voice-key",
          model: "voice-model",
          name: "我的语音接口",
          type: "openai-compatible",
        },
      })[feature] || null,
    },
    contactProjectsService: {
      snapshot: async () => ({ contacts: [contact] }),
    },
    recordCapabilityUsage: async (value) => calls.push({ type: "usage", value }),
    runners: {
      runAgentImageGeneration: async (value) => {
        calls.push({ type: "image-generation", value });
        assert.deepEqual(await value.connectionResolver(), { apiKey: "image-key", baseUrl: "https://images.example.test/v1", key: "image-key", model: "image-model", name: "我的图像接口", provider: "fixture", type: "openai-compatible" });
        return { status: "ok", path: path.join(value.agentRoot, "image-generation", "fixture.png") };
      },
      runDirectImageVision: async (value) => {
        calls.push({ type: "image-vision", value });
        return { status: "ok", answer: "图片里有一只猫。" };
      },
      runDirectVideoUnderstanding: async (value) => {
        calls.push({ type: "video-understanding", value });
        return { status: "ok", answer: "视频中有人在散步。" };
      },
      runDirectVoiceMessage: async (value) => {
        calls.push({ type: "voice-message", value });
        return { status: "ok", savedPath: path.join(value.dataRoot, "agents", value.agentId, "voice.mp3") };
      },
      sendMailBridge: async (value) => {
        calls.push({ type: "mail-bridge", value });
        return { status: "sent", subject: value.subject };
      },
      executeWebBrowserAction: async (value) => {
        calls.push({ type: "web-browser", value });
        return { status: "ok", page: { id: "tab-1", url: value.input.url } };
      },
      takePhonePhoto: async (value) => {
        calls.push({ type: "phone-camera", value });
        return {
          status: "ok",
          path: path.join(value.agentRoot, "phone-camera", "fixture.png"),
          shot: value.options.shot,
          model: "phone-model",
          requestId: "phone-request",
          references: ["contact:person.main"],
          workflow: "",
        };
      },
    },
    settingsService: settingsService(dataRoot),
  });
  const envelope = (input) => ({
    capability: { id: "fixture" },
    context: { contactId: contact.id, input, projectRoot: contact.projectRoot },
    lifecycle: "invoke",
  });

  await adapters["image-vision"](envelope({ path: "D:/attachments/cat.png", question: "有什么？" }));
  await adapters["video-understanding"](envelope({ source: "D:/attachments/walk.mp4", question: "发生了什么？" }));
  await adapters["voice-message"](envelope({ text: "晚上好。" }));
  await adapters["mail-bridge"](envelope({ subject: "提醒", content: "08:30 起床" }));
  await adapters["web-browser"]({ ...envelope({ url: "https://example.test/" }), action: { action: "open" } });
  await adapters["image-generation"](envelope({
    prompt: "一只猫坐在窗边",
    references: [{ role: "identity", path: "D:/references/cat.png" }],
  }));
  await adapters["image-generation"](envelope({
    stylePreset: "phone-camera",
    shot: "selfie",
    scene: "窗边自拍",
    references: [{ scope: "contact", id: "person.main" }],
  }));

  const byType = new Map(calls.filter((entry) => entry.type !== "usage").map((entry) => [entry.type, entry.value]));
  assert.equal(byType.get("image-vision").agentId, contact.agentId);
  assert.equal(byType.get("image-vision").ledgerPath, path.join(dataRoot, "agents", contact.agentId, "cost-ledger", "events.jsonl"));
  assert.equal(byType.get("image-vision").environment.VISION_API_KEY, "vision-key");
  assert.equal(byType.get("image-vision").environment.VISION_BASE_URL, "https://dashscope.aliyuncs.com/api/v1");
  assert.equal(byType.get("image-vision").environment.VISION_CONNECTION_TYPE, "dashscope");
  assert.equal(byType.get("image-vision").environment.VISION_MODEL, "vision-model");
  assert.equal(byType.get("video-understanding").environment.VIDEO_UNDERSTANDING_API_KEY, "video-key");
  assert.equal(byType.get("video-understanding").environment.VIDEO_UNDERSTANDING_BASE_URL, "https://dashscope.aliyuncs.com/api/v1");
  assert.equal(byType.get("video-understanding").environment.VIDEO_UNDERSTANDING_MODEL, "video-model");
  assert.equal(byType.get("video-understanding").videoPath, "D:/attachments/walk.mp4");
  assert.equal(byType.get("voice-message").apiKeyOverride, "voice-key");
  assert.equal(byType.get("voice-message").connectionName, "我的语音接口");
  assert.equal(byType.get("voice-message").connectionType, "openai-compatible");
  assert.equal(byType.get("mail-bridge").dataRoot, dataRoot);
  assert.equal(byType.get("mail-bridge").projectRoot, contact.projectRoot);
  assert.equal(byType.get("mail-bridge").subject, "提醒");
  assert.equal(byType.get("mail-bridge").content, "08:30 起床");
  assert.equal(byType.get("web-browser").action, "open");
  assert.equal(byType.get("web-browser").dataRoot, dataRoot);
  assert.equal(byType.get("web-browser").outputRoot, path.join(dataRoot, "agents", contact.agentId, "web-browser"));
  assert.deepEqual(byType.get("web-browser").input, { url: "https://example.test/" });
  assert.deepEqual(byType.get("image-generation").options.refs, ["identity=D:/references/cat.png"]);
  assert.deepEqual(byType.get("phone-camera").options.refs, [{ scope: "contact", id: "person.main" }]);
  assert.equal(calls.filter((entry) => entry.type === "usage").length, 1);
  assert.equal(calls.find((entry) => entry.type === "usage").value.capabilityId, "image-generation");
});

test("a profile-selected voice resolves the API assigned to its own voice service", async () => {
  const root = await temporaryDirectory("suzu-agent-capability-voice-service-");
  const dataRoot = path.join(root, "data");
  const contact = {
    agentId: "agent-1234567890abcdef",
    id: "contact-voice-service",
    name: "Suzu",
    projectRoot: path.join(root, "contact"),
  };
  const agentRoot = resolveAgentDataRoot({ dataRoot, agentId: contact.agentId });
  await fs.mkdir(path.join(dataRoot, "voice-message"), { recursive: true });
  await fs.mkdir(path.join(agentRoot, "voice-message"), { recursive: true });
  await fs.writeFile(path.join(dataRoot, "voice-message", "voice-services.json"), JSON.stringify({
    schemaVersion: 1,
    services: [{
      id: "service-elevenlabs",
      name: "ElevenLabs 语音",
      adapter: "elevenlabs-speech",
      connectionId: "connection-elevenlabs",
      model: "eleven_multilingual_v2",
      createdAt: "2026-08-23T00:00:00.000Z",
    }],
  }));
  await fs.writeFile(path.join(dataRoot, "voice-message", "voice-profiles.json"), JSON.stringify({
    schemaVersion: 1,
    profiles: [{
      id: "profile-elevenlabs",
      serviceId: "service-elevenlabs",
      name: "Narrator",
      voiceId: "voice-id-123",
      model: "",
      createdAt: "2026-08-23T00:00:00.000Z",
    }],
  }));
  await fs.writeFile(path.join(agentRoot, "voice-message", "config.json"), JSON.stringify({
    schemaVersion: 6,
    voiceProfileId: "profile-elevenlabs",
  }));
  const calls = [];
  const adapters = createAgentCapabilityAdapters({
    connectionsService: {
      resolveApiConnectionById: async (id) => id === "connection-elevenlabs" ? {
        apiKey: "elevenlabs-key",
        baseUrl: "https://api.elevenlabs.io",
        key: "elevenlabs-key",
        model: "",
        name: "ElevenLabs 账户",
        type: "generic-api",
      } : null,
      resolveNamedApiConnection: async () => {
        throw new Error("profile voice must not use the old global binding");
      },
    },
    contactProjectsService: { snapshot: async () => ({ contacts: [contact] }) },
    runners: {
      runDirectVoiceMessage: async (value) => {
        calls.push(value);
        return { status: "ok" };
      },
    },
    settingsService: settingsService(dataRoot),
  });

  await adapters["voice-message"]({
    capability: { id: "voice-message" },
    context: { contactId: contact.id, input: { text: "你好。" }, projectRoot: contact.projectRoot },
    lifecycle: "invoke",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].apiKeyOverride, "elevenlabs-key");
  assert.equal(calls[0].baseUrlOverride, "https://api.elevenlabs.io");
  assert.equal(calls[0].connectionName, "ElevenLabs 账户");
  assert.equal(calls[0].connectionType, "generic-api");
});

test("the Agent schedule action creates a conversation task for only the active contact", async () => {
  const root = await temporaryDirectory("suzu-agent-schedule-");
  const dataRoot = path.join(root, "data");
  const contact = contactFixture(root);
  const adapters = createAgentCapabilityAdapters({
    connectionsService: { resolveNamedApiConnection: async () => null },
    contactProjectsService: { snapshot: async () => ({ contacts: [contact] }) },
    settingsService: settingsService(dataRoot),
  });
  const runtime = createCapabilityRuntime({ registry: createCapabilityRegistry(), adapters });
  assert.deepEqual(
    runtime.availableActions({ contactId: contact.id })
      .filter((action) => action.capabilityId === "schedule")
      .map((action) => action.action),
    ["add", "list", "remove"],
  );
  const result = await runtime.invoke({
    capabilityId: "schedule",
    action: "add",
    contactId: contact.id,
    input: {
      delay: "10m",
      description: "十分钟后回消息",
      prompt: "十分钟已到，请自然地找用户说话。",
    },
    projectRoot: contact.projectRoot,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.value.status, "created");
  assert.equal(result.value.task.target.contactId, contact.id);
  assert.equal(result.value.task.source, "agent");
  const tasks = await listScheduleTasks({ dataRoot });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].target.contactId, contact.id);
  assert.equal(tasks[0].target.prompt, "十分钟已到，请自然地找用户说话。");
  assert.equal(tasks[0].source, "agent");
  await createScheduleTask({
    dataRoot,
    delay: "20m",
    contactId: "contact-other",
    description: "其他联系人的回访",
    prompt: "只属于另一个联系人。",
    source: "agent",
  });
  const listed = await runtime.invoke({
    capabilityId: "schedule",
    action: "list",
    contactId: contact.id,
    input: {},
    projectRoot: contact.projectRoot,
  });
  assert.equal(listed.status, "completed");
  assert.equal(listed.value.status, "listed");
  assert.deepEqual(listed.value.tasks.map((task) => task.id), [result.value.task.id]);
  const removed = await runtime.invoke({
    capabilityId: "schedule",
    action: "remove",
    contactId: contact.id,
    input: { id: result.value.task.id },
    projectRoot: contact.projectRoot,
  });
  assert.equal(removed.status, "completed");
  assert.equal(removed.value.status, "removed");
  assert.equal((await listScheduleTasks({ dataRoot })).length, 1);
  const invalid = await runtime.invoke({
    capabilityId: "schedule",
    action: "add",
    contactId: contact.id,
    input: { delay: "5m", cron: "0 20 * * *", prompt: "不应创建" },
    projectRoot: contact.projectRoot,
  });
  assert.equal(invalid.status, "failed");
  assert.match(invalid.error.message, /delay 或 cron/u);
});

test("a contact capability is absent from the Agent catalog until that contact enables it", async () => {
  const dataRoot = await temporaryDirectory("suzu-agent-capability-access-");
  const registry = createCapabilityRegistry();
  const configPaths = [
    path.join(dataRoot, "capabilities", "image-vision", "config.json"),
    path.join(dataRoot, "capabilities", "web-browser", "config.json"),
    path.join(dataRoot, "automation", "mail-bridge", "config.json"),
  ];
  for (const configPath of configPaths) {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ enabledContactIds: ["contact-enabled"] }), "utf8");
  }
  const access = createCapabilityAccessPolicy({
    capabilityRegistry: registry,
    settingsService: settingsService(dataRoot),
  });
  const runtime = createCapabilityRuntime({
    registry,
    canInvoke: access.canInvoke,
    adapters: {
      "image-vision": () => ({ answer: "ok" }),
      "mail-bridge": ({ context }) => ({ status: "sent", subject: context.input.subject }),
      "web-browser": ({ action, context }) => ({ action: action.action, url: context.input.url || "" }),
    },
  });

  assert.deepEqual(runtime.availableActions({ contactId: "contact-disabled" }), []);
  const enabledActions = runtime.availableActions({ contactId: "contact-enabled" });
  assert.deepEqual(enabledActions.filter((entry) => entry.capabilityId !== "web-browser").map((entry) => [entry.capabilityId, entry.action]), [
    ["image-vision", "analyze"],
    ["mail-bridge", "send"],
  ]);
  assert.equal(enabledActions.filter((entry) => entry.capabilityId === "web-browser").length, 16);
  const denied = await runtime.invoke({
    capabilityId: "image-vision",
    action: "analyze",
    contactId: "contact-disabled",
    input: { path: "D:/attachments/cat.png" },
  });
  assert.equal(denied.status, "capability-not-enabled");
  const accepted = await runtime.invoke({
    capabilityId: "image-vision",
    action: "analyze",
    contactId: "contact-enabled",
    input: { path: "D:/attachments/cat.png" },
  });
  assert.equal(accepted.status, "completed");
  const mailAccepted = await runtime.invoke({
    capabilityId: "mail-bridge",
    action: "send",
    contactId: "contact-enabled",
    input: { subject: "提醒", content: "08:30 起床" },
  });
  assert.deepEqual(mailAccepted.value, { status: "sent", subject: "提醒" });
  const browserAccepted = await runtime.invoke({
    capabilityId: "web-browser",
    action: "open",
    contactId: "contact-enabled",
    input: { url: "https://example.test/" },
  });
  assert.deepEqual(browserAccepted.value, { action: "open", url: "https://example.test/" });
});
