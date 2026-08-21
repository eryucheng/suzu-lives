import assert from "node:assert/strict";
import test from "node:test";

import { DeepSeekAdapter } from "../vendor/core/modules/deepseek-model.mjs";
import { BlockAssembler } from "../vendor/core/modules/llm.mjs";
import { Session } from "../vendor/core/modules/session.mjs";

function adapterOptions() {
  return {
    baseURL: "https://example.test",
    defaults: { thinking: "disabled" },
    retryPolicy: {
      mode: "normal",
      maxRetries: 0,
      backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      retryableCodes: [],
    },
    models: [],
    defaultContextWindow: 64_000,
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

test("DeepSeek adapter ignores empty tool identity continuation fields", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"write_file","arguments":"{"}}]}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"","function":{"name":"","arguments":"}"}}]},"finish_reason":"tool_calls"}]}',
    "[DONE]",
  ]);

  try {
    const config = adapterOptions();
    const adapter = new DeepSeekAdapter({
      options: () => config,
      resolveApiKey: async () => "test-key",
      resolveUserId: () => "test-user",
    });
    const chunks = [];
    for await (const chunk of adapter.request(
      { provider: "deepseek-official", model: "deepseek-v4-flash", messages: [], tools: [] },
      new AbortController().signal,
      config,
      "test-key",
      "test-user",
      () => {},
    )) {
      chunks.push(chunk);
    }

    const deltas = chunks.filter((chunk) => chunk.type === "tool-call-delta");
    assert.deepEqual(deltas.map((chunk) => ({
      id: chunk.id,
      name: chunk.name,
      argumentsDelta: chunk.argumentsDelta,
    })), [
      { id: "call_1", name: "write_file", argumentsDelta: "{" },
      { id: "call_1", name: "write_file", argumentsDelta: "}" },
    ]);
    const closed = chunks.find((chunk) => chunk.type === "block-end");
    assert.deepEqual(closed?.block, {
      type: "tool-call",
      id: "call_1",
      name: "write_file",
      arguments: "{}",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generic stream assembly preserves the first non-empty tool identity", () => {
  const assembler = new BlockAssembler();
  assembler.push({ type: "block-start", index: 0, blockType: "tool-call" });
  assembler.push({
    type: "tool-call-delta",
    index: 0,
    id: "call_1",
    name: "write_file",
    argumentsDelta: "{",
  });
  assembler.push({
    type: "tool-call-delta",
    index: 0,
    id: "",
    name: "",
    argumentsDelta: "}",
  });

  assert.deepEqual(assembler.blocks(), [{
    type: "tool-call",
    id: "call_1",
    name: "write_file",
    arguments: "{}",
  }]);
});

test("session append rejects malformed tool results before they enter history", () => {
  const session = Session.create("integrity-probe", undefined, {
    version: 0,
    id: "integrity-probe",
    createdAt: 0,
    cwd: "D:/integrity-probe",
  });
  const append = (callId) => session.append("tool/result", {
    turn: 1,
    step: 1,
    message: {
      id: `message-${callId || "empty"}`,
      role: "user",
      source: { kind: "tool", callId },
      content: [{ type: "tool-result", toolCallId: callId, content: [], isError: false }],
    },
  }, { surfaceOp: "append" });

  assert.throws(() => append(""), /session event at seq 0 message must have tool source/u);
  assert.equal(session.events.length, 0);

  const event = append("call_1");
  assert.equal(event.seq, 0);
  assert.equal(session.events.length, 1);
});
