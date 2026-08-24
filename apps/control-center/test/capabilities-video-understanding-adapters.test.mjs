import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCapabilitiesService } from "../electron/ipc/capabilities-ipc.mjs";

test("video understanding saves a custom protocol separately from its API connection", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-video-understanding-adapter-"));
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

  const afterCreate = await service.saveVideoUnderstandingCustomAdapter({
    name: "Fixture Video",
    baseUrl: "https://video.example.test",
    endpointPath: "/inspect",
    requestHeaders: '{"Authorization":"Bearer {{apiKey}}"}',
    requestBody: '{"question":"{{question}}","video":"{{videoDataUrl}}"}',
    responseTextPath: "result.text",
  });
  const created = afterCreate.capabilities.find((item) => item.id === "video-understanding")?.savedSettings.video.customAdapters[0];
  assert.equal(created.name, "Fixture Video");

  await service.saveSettings({
    id: "video-understanding",
    value: { adapter: "custom-http-video", customAdapterId: created.id },
  });
  const configPath = path.join(dataRoot, "capabilities", "video-understanding", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(config.video.adapter, "custom-http-video");
  assert.equal(config.video.custom_adapter_id, created.id);
  assert.equal(config.video.fps, 1);

  await assert.rejects(
    () => service.deleteVideoUnderstandingCustomAdapter({ id: created.id }),
    /正在被视频理解使用/u,
  );
  await service.saveSettings({ id: "video-understanding", value: { adapter: "dashscope-openai-video" } });
  const afterDelete = await service.deleteVideoUnderstandingCustomAdapter({ id: created.id });
  const customAdapters = afterDelete.capabilities.find((item) => item.id === "video-understanding")?.savedSettings.video.customAdapters;
  assert.deepEqual(customAdapters, []);
});

test("video understanding rejects Gemini when the selected API is a DashScope connection", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-video-understanding-compatibility-"));
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
    () => service.saveSettings({ id: "video-understanding", value: { adapter: "gemini-generate-content-video" } }),
    /不能使用当前选择的 API/u,
  );
});

test("saving a video protocol keeps hidden processing defaults unchanged", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-video-understanding-hidden-defaults-"));
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
  const configPath = path.join(dataRoot, "capabilities", "video-understanding", "config.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({
    video: {
      fps: 2,
      timeout_seconds: 321,
      max_output_tokens: 456,
      temperature: 0.7,
      max_binary_bytes: 8_000_000,
      cache_enabled: false,
      ffmpeg_path: "custom-ffmpeg",
      ffprobe_path: "custom-ffprobe",
    },
  }), "utf8");

  await service.saveSettings({ id: "video-understanding", value: { adapter: "dashscope-openai-video" } });
  const saved = JSON.parse(await fs.readFile(configPath, "utf8")).video;
  assert.deepEqual(saved, {
    adapter: "dashscope-openai-video",
    custom_adapter_id: "",
    fps: 2,
    timeout_seconds: 321,
    max_output_tokens: 456,
    temperature: 0.7,
    max_binary_bytes: 8_000_000,
    cache_enabled: false,
    ffmpeg_path: "custom-ffmpeg",
    ffprobe_path: "custom-ffprobe",
  });
});
