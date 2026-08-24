import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCapabilitiesService } from "../electron/ipc/capabilities-ipc.mjs";

test("image vision saves a custom protocol separately from its API connection", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-image-vision-adapter-"));
  const dataRoot = path.join(root, "data");
  const service = createCapabilitiesService({
    connectionsService: {
      resolveNamedApiConnection: async () => ({
        id: "connection-generic",
        key: "fixture-key",
        type: "generic-api",
        baseUrl: "https://connection.example.test/v1",
        model: "fixture-model",
      }),
    },
    settingsService: {
      load: () => ({ dataRoot }),
      response: () => ({ dataRoot }),
    },
  });

  const afterCreate = await service.saveImageVisionCustomAdapter({
    name: "Fixture Vision",
    baseUrl: "https://vision.example.test",
    endpointPath: "/inspect",
    requestHeaders: '{"Authorization":"Bearer {{apiKey}}"}',
    requestBody: '{"question":"{{question}}","image":"{{imageDataUrl}}"}',
    responseTextPath: "result.text",
  });
  const created = afterCreate.capabilities.find((item) => item.id === "image-vision")?.savedSettings.vision.customAdapters[0];
  assert.equal(created.name, "Fixture Vision");

  await service.saveSettings({
    id: "image-vision",
    value: { adapter: "custom-http-vision", customAdapterId: created.id },
  });
  const configPath = path.join(dataRoot, "capabilities", "image-vision", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(config.vision.adapter, "custom-http-vision");
  assert.equal(config.vision.custom_adapter_id, created.id);
  assert.equal(config.vision.detail, "auto");

  await assert.rejects(
    () => service.deleteImageVisionCustomAdapter({ id: created.id }),
    /正在被图像理解使用/u,
  );
  await service.saveSettings({ id: "image-vision", value: { adapter: "openai-chat-completions" } });
  const afterDelete = await service.deleteImageVisionCustomAdapter({ id: created.id });
  const customAdapters = afterDelete.capabilities.find((item) => item.id === "image-vision")?.savedSettings.vision.customAdapters;
  assert.deepEqual(customAdapters, []);
});

test("image vision rejects a native protocol paired with an incompatible API connection", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-image-vision-compatibility-"));
  const dataRoot = path.join(root, "data");
  const service = createCapabilitiesService({
    connectionsService: {
      resolveNamedApiConnection: async () => ({
        id: "connection-dashscope",
        key: "fixture-key",
        type: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com/api/v1",
        model: "qwen-vl-max",
      }),
    },
    settingsService: {
      load: () => ({ dataRoot }),
      response: () => ({ dataRoot }),
    },
  });

  await assert.rejects(
    () => service.saveSettings({ id: "image-vision", value: { adapter: "anthropic-messages" } }),
    /不能使用当前选择的 API/u,
  );
});

test("image vision asks for a complete API connection before saving a built-in protocol", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-image-vision-required-fields-"));
  const dataRoot = path.join(root, "data");
  const service = createCapabilitiesService({
    connectionsService: {
      resolveNamedApiConnection: async () => ({
        id: "connection-generic",
        key: "fixture-key",
        type: "generic-api",
        baseUrl: "",
        model: "",
      }),
    },
    settingsService: {
      load: () => ({ dataRoot }),
      response: () => ({ dataRoot }),
    },
  });

  await assert.rejects(
    () => service.saveSettings({ id: "image-vision", value: { adapter: "gemini-generate-content" } }),
    /需要所选 API 填写服务地址/u,
  );
});
