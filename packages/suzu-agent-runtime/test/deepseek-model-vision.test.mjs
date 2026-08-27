import assert from "node:assert/strict";
import test from "node:test";

import { basename } from "node:path";

import { resolveSuzuAgentCoreModule } from "../src/core-module-catalog.mjs";
import {
  DeepSeekAdapter,
  deepSeekInputModalities,
} from "../src/deepseek-model-vision.mjs";

function adapterOptions({
  baseURL = "https://example.test",
  defaults = { thinking: "enabled" },
} = {}) {
  return {
    baseURL,
    defaults,
    retryPolicy: {
      mode: "normal",
      maxRetries: 0,
      backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      retryableCodes: [],
    },
    models: [
      { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", contextWindow: 1_000_000 },
      { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek-V4-Flash-Vision-Exp", contextWindow: 1_000_000, maxTokens: 384_000 },
    ],
    defaultContextWindow: 1_000_000,
    maxTokens: 4_096,
    streamIdleTimeoutMs: 1_000,
  };
}

function sseResponse(payloads) {
  return new Response(
    payloads.map((payload) => `data: ${payload}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function requestChunks(adapter, event, options) {
  const chunks = [];
  for await (const chunk of adapter.request(
    event,
    new AbortController().signal,
    options,
    "test-key",
    "test-user",
    () => {},
  )) {
    chunks.push(chunk);
  }
  return chunks;
}

function adapterForTest({ resolveAttachments } = {}) {
  return new DeepSeekAdapter({
    options: () => adapterOptions(),
    resolveApiKey: async () => "test-key",
    resolveUserId: () => "test-user",
    ...(resolveAttachments ? { resolveAttachments } : {}),
  });
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
  assert.deepEqual(resolved.reasoning.efforts.map((effort) => effort.id), ["off", "low", "high", "max"]);
  assert.equal(resolved.reasoning.defaultEffort, "high");
  assert.deepEqual(deepSeekInputModalities("deepseek-v4-flash"), ["text"]);
});

test("DeepSeek forwards the low reasoning effort through Chat Completions", async () => {
  const originalFetch = globalThis.fetch;
  let payload;
  globalThis.fetch = async (_url, init) => {
    payload = JSON.parse(init.body);
    return sseResponse([
      '{"choices":[{"delta":{"content":"简短回答"},"finish_reason":"stop"}]}',
      "[DONE]",
    ]);
  };

  try {
    const chunks = await requestChunks(adapterForTest(), {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      reasoningEffort: "low",
      messages: [{
        id: "low-reasoning-user-message",
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "快速回答" }],
      }],
      tools: [],
    }, adapterOptions());

    assert.deepEqual(payload.thinking, { type: "enabled" });
    assert.equal(payload.reasoning_effort, "low");
    assert.equal(chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "简短回答"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DeepSeek thinking requests omit an unreplayable historical tool-call pair", async () => {
  const originalFetch = globalThis.fetch;
  let payload;
  globalThis.fetch = async (_url, init) => {
    payload = JSON.parse(init.body);
    return sseResponse([
      '{"choices":[{"delta":{"content":"继续处理"},"finish_reason":"stop"}]}',
      "[DONE]",
    ]);
  };

  try {
    const options = adapterOptions();
    const chunks = await requestChunks(adapterForTest(), {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      messages: [
        {
          id: "missing-reasoning-tool-call",
          role: "assistant",
          source: { kind: "model" },
          content: [{ type: "tool-call", id: "call-missing", name: "inspect", arguments: "{}" }],
        },
        {
          id: "matching-tool-result",
          role: "user",
          source: { kind: "tool", callId: "call-missing" },
          content: [{
            type: "tool-result",
            toolCallId: "call-missing",
            content: [{ type: "text", text: "工具结果" }],
          }],
        },
        {
          id: "current-user-message",
          role: "user",
          source: { kind: "user" },
          content: [{ type: "text", text: "继续吧" }],
        },
      ],
      tools: [],
    }, options);

    assert.deepEqual(payload.messages, [{ role: "user", content: "继续吧" }]);
    assert.deepEqual(payload.thinking, { type: "enabled" });
    assert.equal(chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "继续处理"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DeepSeek thinking requests preserve the original reasoning for valid tool history", async () => {
  const originalFetch = globalThis.fetch;
  let payload;
  globalThis.fetch = async (_url, init) => {
    payload = JSON.parse(init.body);
    return sseResponse([
      '{"choices":[{"delta":{"content":"已处理"},"finish_reason":"stop"}]}',
      "[DONE]",
    ]);
  };

  try {
    const options = adapterOptions();
    await requestChunks(adapterForTest(), {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      messages: [
        {
          id: "tool-call-with-reasoning",
          role: "assistant",
          source: { kind: "model" },
          content: [
            { type: "reasoning", text: "先检查工具。" },
            { type: "tool-call", id: "call-valid", name: "inspect", arguments: "{}" },
          ],
        },
        {
          id: "valid-tool-result",
          role: "user",
          source: { kind: "tool", callId: "call-valid" },
          content: [{
            type: "tool-result",
            toolCallId: "call-valid",
            content: [{ type: "text", text: "工具结果" }],
          }],
        },
        {
          id: "current-user-message",
          role: "user",
          source: { kind: "user" },
          content: [{ type: "text", text: "继续吧" }],
        },
      ],
      tools: [],
    }, options);

    assert.deepEqual(payload.messages, [
      {
        role: "assistant",
        content: "",
        reasoning_content: "先检查工具。",
        tool_calls: [{
          id: "call-valid",
          type: "function",
          function: { name: "inspect", arguments: "{}" },
        }],
      },
      { role: "tool", tool_call_id: "call-valid", content: "工具结果" },
      { role: "user", content: "继续吧" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DeepSeek Vision emits Agent Core chunks rather than raw SSE payload strings", async () => {
  const originalFetch = globalThis.fetch;
  let payload;
  let requestUrl;
  globalThis.fetch = async (url, init) => {
    requestUrl = url;
    payload = JSON.parse(init.body);
    return sseResponse([
      '{"choices":[{"delta":{"reasoning_content":"先看图像。","content":"图中是一张测试图片。"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"completion_tokens_details":{"reasoning_tokens":2}}}',
      "[DONE]",
    ]);
  };

  try {
    const options = adapterOptions({
      baseURL: "https://api.deepseek.com",
      defaults: { thinking: "disabled" },
    });
    const chunks = await requestChunks(adapterForTest(), {
      provider: "deepseek-official",
      model: "deepseek-v4-flash-vision-exp",
      messages: [{
        id: "image-input",
        role: "user",
        source: { kind: "user" },
        content: [
          { type: "text", text: "图片里是什么？" },
          { type: "image", mediaType: "image/png", data: "AA==" },
        ],
      }],
      tools: [],
    }, options);

    assert.equal(requestUrl, "https://api.deepseek.com/chat/completions");
    assert.deepEqual(payload.messages, [{
      role: "user",
      content: [
        { type: "text", text: "图片里是什么？" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
      ],
    }]);
    assert.equal(chunks.some((chunk) => chunk.type === "reasoning-delta" && chunk.text === "先看图像。"), true);
    assert.equal(chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "图中是一张测试图片。"), true);
    assert.deepEqual(chunks.find((chunk) => chunk.type === "usage")?.usage, {
      inputTokens: 12,
      outputTokens: 4,
      reasoningTokens: 2,
    });
    assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "stop" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DeepSeek Vision replays a read_image tool attachment and accepts the next text message", async () => {
  const originalFetch = globalThis.fetch;
  let payload;
  let attachmentReads = 0;
  globalThis.fetch = async (_url, init) => {
    payload = JSON.parse(init.body);
    return sseResponse([
      '{"choices":[{"delta":{"content":"可以继续。"},"finish_reason":"stop"}]}',
      "[DONE]",
    ]);
  };

  try {
    const attachment = {
      attachmentId: `sha256:${"a".repeat(64)}`,
      mediaType: "image/png",
      bytes: 1,
      width: 1,
      height: 1,
      name: "tool-image.png",
    };
    const adapter = adapterForTest({
      resolveAttachments: () => ({
        async readImage(reference) {
          attachmentReads += 1;
          assert.deepEqual(reference, attachment);
          return { ref: reference, data: new Uint8Array([0]) };
        },
      }),
    });
    const chunks = await requestChunks(adapter, {
      provider: "deepseek-official",
      model: "deepseek-v4-flash-vision-exp",
      messages: [
        {
          id: "initial-user-message",
          role: "user",
          source: { kind: "user" },
          content: [{ type: "text", text: "读取这张图片。" }],
        },
        {
          id: "read-image-call",
          role: "assistant",
          source: { kind: "model" },
          content: [
            { type: "reasoning", text: "先读取图片。" },
            { type: "tool-call", id: "call-read-image", name: "read_image", arguments: "{}" },
            { type: "tool-call", id: "call-inspect", name: "inspect", arguments: "{}" },
          ],
        },
        {
          id: "read-image-result",
          role: "user",
          source: { kind: "tool", callId: "call-read-image" },
          content: [{
            type: "tool-result",
            toolCallId: "call-read-image",
            content: [
              { type: "text", text: "读取了 tool-image.png。" },
              { type: "image", attachment },
            ],
          }],
        },
        {
          id: "inspect-result",
          role: "user",
          source: { kind: "tool", callId: "call-inspect" },
          content: [{
            type: "tool-result",
            toolCallId: "call-inspect",
            content: [{ type: "text", text: "检查完成。" }],
          }],
        },
        {
          id: "next-user-message",
          role: "user",
          source: { kind: "user" },
          content: [{ type: "text", text: "继续告诉我。" }],
        },
      ],
      tools: [],
    }, adapterOptions());

    assert.equal(attachmentReads, 1);
    assert.deepEqual(payload.messages, [
      { role: "user", content: "读取这张图片。" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "先读取图片。",
        tool_calls: [{
          id: "call-read-image",
          type: "function",
          function: { name: "read_image", arguments: "{}" },
        }, {
          id: "call-inspect",
          type: "function",
          function: { name: "inspect", arguments: "{}" },
        }],
      },
      { role: "tool", tool_call_id: "call-read-image", content: "读取了 tool-image.png。" },
      { role: "tool", tool_call_id: "call-inspect", content: "检查完成。" },
      {
        role: "user",
        content: [
          { type: "text", text: "以上工具结果包含以下图片。" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
        ],
      },
      { role: "user", content: "继续告诉我。" },
    ]);
    assert.equal(chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "可以继续。"), true);
    assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "stop" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
