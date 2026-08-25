import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCapabilitiesService } from "../electron/ipc/capabilities-ipc.mjs";

function serviceFor(dataRoot, connection) {
  return createCapabilitiesService({
    connectionsService: {
      resolveNamedApiConnection: async () => connection,
    },
    settingsService: {
      load: () => ({ dataRoot }),
      response: () => ({ dataRoot }),
    },
  });
}

test("image generation saves a custom protocol separately from its API connection", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-image-generation-adapter-"));
  const dataRoot = path.join(root, "data");
  const service = serviceFor(dataRoot, {
    id: "connection-generic",
    key: "fixture-key",
    type: "generic-api",
    baseUrl: "https://connection.example.test/v1",
    model: "fixture-model",
  });

  const afterCreate = await service.saveImageGenerationCustomAdapter({
    name: "Fixture Image",
    baseUrl: "https://image.example.test",
    endpointPath: "/draw",
    imagePath: "result.url",
    requestHeaders: '{"Authorization":"Bearer {{apiKey}}"}',
    requestBody: '{"model":"{{model}}","prompt":"{{prompt}}","images":"{{referenceImages}}"}',
    responseMode: "json-url",
  });
  const created = afterCreate.capabilities.find((item) => item.id === "image-generation")?.savedSettings.customAdapters[0];
  assert.equal(created.name, "Fixture Image");

  await service.saveSettings({
    id: "image-generation",
    value: { adapter: "custom-http-image", customAdapterId: created.id, referenceAdapter: "custom-data-url-array" },
  });
  const configPath = path.join(dataRoot, "capabilities", "image-generation", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(config.adapter, "custom-http-image");
  assert.equal(config.custom_adapter_id, created.id);
  assert.equal(config.reference_adapter, "custom-data-url-array");
  assert.equal(config.reference_model, "fixture-model");
  assert.equal(Object.hasOwn(config, "default_backend"), false);

  await assert.rejects(
    () => service.deleteImageGenerationCustomAdapter({ id: created.id }),
    /正在被图像生成使用/u,
  );
  await service.saveSettings({ id: "image-generation", value: { adapter: "openai-images" } });
  const afterProtocolChange = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(afterProtocolChange.reference_adapter, "none");
  assert.equal(afterProtocolChange.reference_model, "");
  const afterDelete = await service.deleteImageGenerationCustomAdapter({ id: created.id });
  const customAdapters = afterDelete.capabilities.find((item) => item.id === "image-generation")?.savedSettings.customAdapters;
  assert.deepEqual(customAdapters, []);
});

test("image generation rejects an incompatible API for the selected protocol", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-image-generation-compatibility-"));
  const dataRoot = path.join(root, "data");
  const service = serviceFor(dataRoot, {
    id: "connection-dashscope",
    key: "fixture-key",
    type: "dashscope",
    baseUrl: "https://dashscope.aliyuncs.com/api/v1",
    model: "wan2.7-image",
  });

  await assert.rejects(
    () => service.saveSettings({ id: "image-generation", value: { adapter: "openai-images" } }),
    /不能使用当前选择的 API/u,
  );
});

test("image generation settings do not create phone-camera presentation preferences", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-image-generation-phone-preset-"));
  const dataRoot = path.join(root, "data");
  const service = serviceFor(dataRoot, {
    id: "connection-image",
    key: "fixture-key",
    type: "openai-compatible",
    baseUrl: "https://images.example.test/v1",
    model: "fixture-model",
  });

  await service.saveSettings({
    id: "image-generation",
    value: {
      adapter: "openai-images",
    },
  });

  const config = JSON.parse(await fs.readFile(path.join(dataRoot, "capabilities", "image-generation", "config.json"), "utf8"));
  assert.equal(Object.hasOwn(config, "phone_camera"), false);
  await assert.rejects(fs.stat(path.join(dataRoot, "capabilities", "phone-camera", "config.json")), /ENOENT/u);
});
