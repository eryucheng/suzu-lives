import assert from "node:assert/strict";
import test from "node:test";

import {
  createVisionHttpRequest,
  extractVisionResponseText,
  visionAdapterSupportsConnection,
} from "../src/vision-adapters.mjs";

const imageDataUrl = "data:image/png;base64,aGVsbG8=";
const common = Object.freeze({
  apiKey: "fixture-key",
  detail: "high",
  imageDataUrl,
  imageMimeType: "image/png",
  maxOutputTokens: 321,
  model: "fixture-vision",
  question: "图片里有什么？",
  systemPrompt: "只描述可见内容。",
});

test("OpenAI-compatible vision keeps the legacy DashScope compatible route", () => {
  const request = createVisionHttpRequest({
    ...common,
    adapter: "openai-chat-completions",
    baseUrl: "https://dashscope.aliyuncs.com/api/v1",
  });

  assert.equal(request.endpoint, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.equal(request.headers.Authorization, "Bearer fixture-key");
  assert.equal(request.body.messages[1].content[1].image_url.url, imageDataUrl);
  assert.equal(request.body.messages[1].content[1].image_url.detail, "high");
  assert.equal(extractVisionResponseText({ adapter: request.adapter, payload: { choices: [{ message: { content: "一只猫。" } }] } }), "一只猫。");
});

test("native image adapters build the vendor request shapes", () => {
  const anthropic = createVisionHttpRequest({ ...common, adapter: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1" });
  assert.equal(anthropic.endpoint, "https://api.anthropic.com/v1/messages");
  assert.equal(anthropic.headers["x-api-key"], "fixture-key");
  assert.equal(anthropic.body.messages[0].content[1].source.data, "aGVsbG8=");
  assert.equal(extractVisionResponseText({ adapter: anthropic.adapter, payload: { content: [{ type: "text", text: "一只猫。" }] } }), "一只猫。");

  const gemini = createVisionHttpRequest({ ...common, adapter: "gemini-generate-content", baseUrl: "https://generativelanguage.googleapis.com/v1beta" });
  assert.equal(gemini.endpoint, "https://generativelanguage.googleapis.com/v1beta/models/fixture-vision:generateContent");
  assert.equal(gemini.headers["x-goog-api-key"], "fixture-key");
  assert.equal(gemini.body.contents[0].parts[1].inline_data.data, "aGVsbG8=");
  assert.equal(extractVisionResponseText({ adapter: gemini.adapter, payload: { candidates: [{ content: { parts: [{ text: "一只猫。" }] } }] } }), "一只猫。");

  const dashscope = createVisionHttpRequest({ ...common, adapter: "dashscope-multimodal", baseUrl: "https://dashscope.aliyuncs.com/api/v1" });
  assert.equal(dashscope.endpoint, "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
  assert.equal(dashscope.body.input.messages[1].content[0].image, imageDataUrl);
  assert.equal(extractVisionResponseText({ adapter: dashscope.adapter, payload: { output: { choices: [{ message: { content: [{ text: "一只猫。" }] } }] } } }), "一只猫。");
});

test("custom vision adapter substitutes only the documented request variables", () => {
  const customAdapter = {
    id: "custom-vision-fixture",
    name: "Fixture Vision",
    baseUrl: "https://vision.example.test",
    endpointPath: "/inspect",
    requestHeaders: { Authorization: "Token {{apiKey}}" },
    requestBody: { prompt: "{{question}}", image: "{{imageBase64}}", model: "{{model}}" },
    responseTextPath: "result.text",
  };
  const request = createVisionHttpRequest({ ...common, adapter: "custom-http-vision", customAdapter });

  assert.equal(request.endpoint, "https://vision.example.test/inspect");
  assert.equal(request.headers.Authorization, "Token fixture-key");
  assert.deepEqual(request.body, { prompt: "图片里有什么？", image: "aGVsbG8=", model: "fixture-vision" });
  assert.equal(extractVisionResponseText({ adapter: request.adapter, customAdapter, payload: { result: { text: "一只猫。" } } }), "一只猫。");
});

test("adapter choices only show compatible saved connection types", () => {
  assert.equal(visionAdapterSupportsConnection("anthropic-messages", "generic-api"), true);
  assert.equal(visionAdapterSupportsConnection("anthropic-messages", "dashscope"), false);
  assert.equal(visionAdapterSupportsConnection("dashscope-multimodal", "dashscope"), true);
});
