import assert from "node:assert/strict";
import test from "node:test";

import { createSuzuStructuredGenerator, inject } from "../src/structured-generator.mjs";

function createTransport() {
  const handlers = new Map();
  return {
    handlers,
    handleCommand(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  };
}

test("structured generator declares the Agent Core services it reads", () => {
  assert.deepEqual(inject, ["sessions", "llm", "agents"]);
});

test("structured generator calls the live Agent Core model route and returns parsed JSON without exposing credentials", async () => {
  const transport = createTransport();
  const calls = [];
  const session = {
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-v4-flash" } }),
  };
  const ctx = {
    sessions: new Map([["session-memory", session]]),
    llm: {
      async *stream(options) {
        calls.push(options);
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: '{"memories":[]}' };
        yield { type: "block-end", index: 0, block: { type: "text", text: '{"memories":[]}' } };
        yield { type: "usage", usage: { inputTokens: 21, outputTokens: 4 } };
        yield { type: "finish", reason: { kind: "stop" } };
      },
    },
  };
  const bridge = createSuzuStructuredGenerator({ transport });
  bridge.apply(ctx, { maxOutputTokens: 4096, timeoutMs: 5_000 });

  const result = await transport.handlers.get("StructuredGenerate")({
    sessionId: "session-memory",
    systemPrompt: "从对话中抽取长期记忆。",
    input: "用户说下周要去海边。",
    schema: { type: "object", required: ["memories"] },
    schemaName: "long-term-memory-extraction-v1",
  });

  assert.deepEqual(result, {
    ok: true,
    output: { memories: [] },
    usage: { inputTokens: 21, outputTokens: 4 },
    model: "deepseek-v4-flash",
    requestId: "",
    durationMs: result.durationMs,
    metadata: {
      provider: "agent-core",
      providerId: "deepseek",
      schemaName: "long-term-memory-extraction-v1",
      taskId: "structured-generation",
    },
  });
  assert.equal(Number.isFinite(result.durationMs) && result.durationMs >= 0, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, "deepseek");
  assert.equal(calls[0].model, "deepseek-v4-flash");
  assert.equal(calls[0].maxTokens, 4096);
  assert.equal(calls[0].temperature, 0);
  assert.deepEqual(calls[0].tools, []);
  assert.equal(Object.hasOwn(calls[0], "sessionId"), false);
  assert.match(calls[0].system, /long-term-memory-extraction-v1/u);
  assert.match(calls[0].system, /JSON Schema/u);
});

test("structured generator accepts a one-shot task with text and image content", async () => {
  const transport = createTransport();
  const calls = [];
  const session = {
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-v4-flash" } }),
  };
  const ctx = {
    sessions: new Map([["session-transient", session]]),
    llm: {
      async *stream(options) {
        calls.push(options);
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: '{"intent":["赞同"]}' };
        yield { type: "block-end", index: 0, block: { type: "text", text: '{"intent":["赞同"]}' } };
        yield { type: "finish", reason: { kind: "stop" } };
      },
    },
  };
  const bridge = createSuzuStructuredGenerator({ transport });
  bridge.apply(ctx);
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

  const result = await transport.handlers.get("StructuredGenerate")({
    sessionId: "session-transient",
    taskId: "sticker.tag.v1",
    systemPrompt: "识别聊天表情包的语义。",
    content: [
      { type: "text", text: "为这张表情包生成标签。" },
      { type: "image", mediaType: "image/png", data: `data:image/png;base64,${image}`, name: "sticker.png" },
    ],
    schema: { type: "object", required: ["intent"] },
    schemaName: "sticker-tag-v1",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { intent: ["赞同"] });
  assert.equal(result.metadata.taskId, "sticker.tag.v1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tools.length, 0);
  assert.equal(calls[0].temperature, 0);
  assert.equal(Object.hasOwn(calls[0], "sessionId"), false);
  assert.deepEqual(calls[0].messages[0].content, [
    { type: "text", text: "为这张表情包生成标签。" },
    { type: "image", mediaType: "image/png", data: image, name: "sticker.png" },
  ]);
  assert.equal(calls[0].messages[0].source.summary, "Suzu transient inference: sticker.tag.v1");
});

test("structured generator uses the live Agent route before a fresh session has a request header", async () => {
  const transport = createTransport();
  const calls = [];
  const ctx = {
    sessions: new Map([["session-fresh", { requestHeader: () => undefined }]]),
    agents: new Map([["session-fresh", {
      options: { provider: "openai-compatible", model: "vision-model" },
    }]]),
    llm: {
      async *stream(options) {
        calls.push(options);
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: '{"name":"猫猫大笑"}' };
        yield { type: "block-end", index: 0, block: { type: "text", text: '{"name":"猫猫大笑"}' } };
        yield { type: "finish", reason: { kind: "stop" } };
      },
    },
  };
  const bridge = createSuzuStructuredGenerator({ transport });
  bridge.apply(ctx);

  const result = await transport.handlers.get("StructuredGenerate")({
    sessionId: "session-fresh",
    input: "识别这张表情包。",
    schema: { type: "object", required: ["name"] },
  });

  assert.equal(result.ok, true);
  assert.equal(result.model, "vision-model");
  assert.equal(calls[0].provider, "openai-compatible");
  assert.equal(calls[0].model, "vision-model");
});

test("structured generator rejects invalid image content before calling a model", async () => {
  const transport = createTransport();
  let calls = 0;
  const ctx = {
    sessions: new Map([["session-transient", {
      requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-v4-flash" } }),
    }]]),
    llm: {
      async *stream() {
        calls += 1;
      },
    },
  };
  const bridge = createSuzuStructuredGenerator({ transport });
  bridge.apply(ctx);

  const result = await transport.handlers.get("StructuredGenerate")({
    sessionId: "session-transient",
    content: [{ type: "image", mediaType: "image/png", data: "not-base64" }],
    schema: { type: "object" },
  });

  assert.equal(result.ok, false);
  assert.match(result.error.message, /Base64/u);
  assert.equal(calls, 0);
});

test("structured generator fails as data when the target Agent Core session is unavailable", async () => {
  const transport = createTransport();
  const bridge = createSuzuStructuredGenerator({ transport });
  bridge.apply({ sessions: new Map(), llm: { stream() { throw new Error("should not run"); } } });

  const result = await transport.handlers.get("StructuredGenerate")({
    sessionId: "missing-session",
    systemPrompt: "系统词",
    input: "输入",
    schema: { type: "object" },
  });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /模型路由不可用/u);
});
