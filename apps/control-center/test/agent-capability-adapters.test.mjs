import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
      loadPhoneConfig: async () => ({ config: { defaultBackend: "api" } }),
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
    seed: 17,
  }));
  await adapters["phone-camera"](envelope({
    shot: "selfie",
    scene: "窗边自拍",
    references: [{ scope: "contact", id: "person.main" }],
  }));

  const byType = new Map(calls.filter((entry) => entry.type !== "usage").map((entry) => [entry.type, entry.value]));
  assert.equal(byType.get("image-vision").agentId, contact.agentId);
  assert.equal(byType.get("image-vision").ledgerPath, path.join(dataRoot, "agents", contact.agentId, "cost-ledger", "events.jsonl"));
  assert.equal(byType.get("image-vision").environment.VISION_API_KEY, "vision-key");
  assert.equal(byType.get("image-vision").environment.VISION_BASE_URL, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(byType.get("image-vision").environment.VISION_MODEL, "vision-model");
  assert.equal(byType.get("video-understanding").environment.VIDEO_UNDERSTANDING_API_KEY, "video-key");
  assert.equal(byType.get("video-understanding").environment.VIDEO_UNDERSTANDING_BASE_URL, "https://dashscope.aliyuncs.com/compatible-mode/v1");
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
  assert.equal(byType.get("image-generation").options.seed, 17);
  assert.deepEqual(byType.get("phone-camera").options.refs, [{ scope: "contact", id: "person.main" }]);
  assert.equal(calls.filter((entry) => entry.type === "usage").length, 1);
  assert.equal(calls.find((entry) => entry.type === "usage").value.capabilityId, "phone-camera");
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
