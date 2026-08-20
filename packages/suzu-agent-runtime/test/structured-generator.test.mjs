import assert from "node:assert/strict";
import test from "node:test";

import { createSuzuStructuredGenerator } from "../src/structured-generator.mjs";

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
  assert.match(result.error.message, /会话不可用/u);
});
