import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_VIDEO_ADAPTER,
  normalizeVideoAdapter,
  videoAdapterDefinition,
  videoAdapterSupportsConnection,
} from "../src/video-adapters.mjs";
import { normalizeCustomVideoAdapter } from "../src/custom-video-adapters.mjs";

test("video understanding keeps DashScope as the legacy default while exposing explicit protocol choices", () => {
  assert.equal(DEFAULT_VIDEO_ADAPTER, "dashscope-openai-video");
  assert.equal(normalizeVideoAdapter(""), "dashscope-openai-video");
  assert.equal(normalizeVideoAdapter("openai-compatible"), "dashscope-openai-video");
  assert.equal(videoAdapterDefinition("dashscope-openai-video")?.label, "百炼视频理解（Qwen-VL / QVQ）");
});

test("video protocol choices only accept compatible saved API connections", () => {
  assert.equal(videoAdapterSupportsConnection("dashscope-openai-video", "dashscope"), true);
  assert.equal(videoAdapterSupportsConnection("dashscope-openai-video", "openai-compatible"), true);
  assert.equal(videoAdapterSupportsConnection("gemini-generate-content-video", "generic-api"), true);
  assert.equal(videoAdapterSupportsConnection("gemini-generate-content-video", "dashscope"), false);
});

test("custom video protocol templates only accept documented input variables", () => {
  const adapter = normalizeCustomVideoAdapter({
    id: "custom-video-fixture",
    name: "Fixture Video",
    baseUrl: "https://video.example.test",
    endpointPath: "/inspect",
    requestHeaders: '{"Authorization":"Bearer {{apiKey}}"}',
    requestBody: '{"prompt":"{{question}}","video":"{{videoDataUrl}}","model":"{{model}}"}',
    responseTextPath: "result.text",
  }, { requireBaseUrl: true });
  assert.equal(adapter.requestBody.video, "{{videoDataUrl}}");

  assert.throws(() => normalizeCustomVideoAdapter({
    ...adapter,
    requestBody: '{"video":"{{unknownVariable}}"}',
  }, { requireBaseUrl: true }), /不支持变量/u);
});
