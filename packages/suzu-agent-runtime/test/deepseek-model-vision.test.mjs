import assert from "node:assert/strict";
import test from "node:test";

import { basename } from "node:path";

import { resolveSuzuAgentCoreModule } from "../src/core-module-catalog.mjs";
import {
  DeepSeekAdapter,
  deepSeekInputModalities,
} from "../src/deepseek-model-vision.mjs";

function adapterOptions() {
  return {
    baseURL: "https://api.deepseek.com",
    defaults: {},
    defaultContextWindow: 1_000_000,
    maxTokens: 256_000,
    models: [
      { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", contextWindow: 1_000_000 },
      { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek-V4-Flash-Vision-Exp", contextWindow: 1_000_000, maxTokens: 384_000 },
    ],
    streamIdleTimeoutMs: 300_000,
  };
}

test("the product DeepSeek Core role resolves through Suzu's Vision-aware adapter", () => {
  assert.equal(basename(resolveSuzuAgentCoreModule("deepseek-model")), "deepseek-model-vision.mjs");
});

test("DeepSeek Vision exposes image input only for the visual model", async () => {
  const adapter = new DeepSeekAdapter({ options: () => adapterOptions() });
  const models = await adapter.listModels("deepseek-official");
  const visual = models.find((model) => model.id === "deepseek-v4-flash-vision-exp");
  const text = models.find((model) => model.id === "deepseek-v4-flash");
  const resolved = await adapter.resolveModel("deepseek-official", "deepseek-v4-flash-vision-exp");

  assert.deepEqual(visual.inputModalities, ["text", "image"]);
  assert.deepEqual(text.inputModalities, ["text"]);
  assert.deepEqual(resolved.inputModalities, ["text", "image"]);
  assert.deepEqual(deepSeekInputModalities("deepseek-v4-flash"), ["text"]);
});

test("DeepSeek Vision serializes a native image block as an OpenAI image_url payload", async () => {
  const adapter = new DeepSeekAdapter({ options: () => adapterOptions() });
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response("data: {\"choices\":[]}\n\ndata: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  };
  try {
    const chunks = [];
    for await (const chunk of adapter.request({
      model: "deepseek-v4-flash-vision-exp",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "看看这张图" },
          { type: "image", mediaType: "image/png", data: "aW1hZ2U=", name: "reference.png" },
        ],
      }],
    }, new AbortController().signal, adapterOptions(), "test-key", "test-user", () => {})) {
      chunks.push(chunk);
    }

    const payload = JSON.parse(request.options.body);
    assert.equal(request.url, "https://api.deepseek.com/chat/completions");
    assert.deepEqual(payload.messages, [{
      role: "user",
      content: [
        { type: "text", text: "看看这张图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
      ],
    }]);
    assert.deepEqual(chunks, ["{\"choices\":[]}", "[DONE]"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
