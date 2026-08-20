import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateSuzuContextMeasurement,
  selectSuzuCompactionBatchRange,
  selectSuzuCompactionRange,
  SuzuCompanionCompactionEngine,
  suzuContextBudget,
} from "../src/companion-compaction.mjs";

function sessionWithSurface(nodes, events) {
  return {
    surface: { nodes },
    events,
  };
}

test("Suzu manual compaction selects an older prefix and retains a balanced raw tail", () => {
  const events = [];
  events[1] = { seq: 1, type: "user/message", data: {} };
  events[2] = {
    seq: 2,
    type: "assistant/message",
    data: { message: { content: [{ type: "tool-call", id: "call-1", name: "read", arguments: "{}" }] } },
  };
  events[3] = { seq: 3, type: "tool/result", data: {} };
  events[4] = { seq: 4, type: "assistant/message", data: { message: { content: [{ type: "text", text: "结果来了" }] } } };
  const session = sessionWithSurface([1, 2, 3, 4], events);
  const measurement = {
    nodes: [
      { seq: 1, tokens: 600 },
      { seq: 2, tokens: 500 },
      { seq: 3, tokens: 500 },
      { seq: 4, tokens: 800 },
    ],
  };

  assert.deepEqual(selectSuzuCompactionRange(session, measurement, 700), { start: 1, end: 3 });
  assert.equal(selectSuzuCompactionRange(session, measurement, 3_000), null);
});

test("Suzu manual compaction splits an overlong prefix into balanced input-safe batches", () => {
  const events = [];
  events[1] = { seq: 1, type: "user/message", data: {} };
  events[2] = {
    seq: 2,
    type: "assistant/message",
    data: { message: { content: [{ type: "tool-call", id: "call-1", name: "read", arguments: "{}" }] } },
  };
  events[3] = { seq: 3, type: "tool/result", data: {} };
  events[4] = { seq: 4, type: "assistant/message", data: { message: { content: [{ type: "text", text: "tail" }] } } };
  const session = sessionWithSurface([1, 2, 3, 4], events);
  const measurement = {
    totalTokens: 1_700,
    nodes: [
      { seq: 1, tokens: 400 },
      { seq: 2, tokens: 400 },
      { seq: 3, tokens: 400 },
      { seq: 4, tokens: 500 },
    ],
  };

  // The normal range would be 1..3, but an 850-token input budget cannot
  // include the tool call without its result.  The batch ends at the prior
  // balanced boundary and marks that a later rolling batch is still needed.
  assert.deepEqual(
    selectSuzuCompactionBatchRange(session, measurement, 500, 850),
    { start: 1, end: 1, hasRemainingRange: true },
  );
  assert.deepEqual(
    selectSuzuCompactionBatchRange(session, measurement, 500, 1_300),
    { start: 1, end: 3, hasRemainingRange: false },
  );
});

test("Suzu manual summaries disable contact tools and use the bounded recovery output budget", async () => {
  const calls = [];
  const engine = {
    baseConfig: { maxTokens: 8_192 },
    settingsContext: {
      getStore: () => ({ config: { maxTokens: 8_192 }, settings: { prompt: "condense the conversation" } }),
    },
    ctx: {
      llm: {
        async *stream(options) {
          calls.push(options);
          yield { type: "block-start", index: 0, blockType: "text" };
          yield { type: "text-delta", index: 0, text: "short checkpoint" };
          yield { type: "block-end", index: 0, block: { type: "text", text: "short checkpoint" } };
          yield { type: "finish", reason: { kind: "stop" } };
        },
      },
    },
  };
  const agent = {
    options: { provider: "test-provider", model: "test-model" },
    session: { id: "manual-summary-options" },
  };

  const result = await SuzuCompanionCompactionEngine.prototype.summarize.call(
    engine,
    {
      system: "companion system",
      tools: [{ name: "should-not-reach-summarizer" }],
      messages: [{ role: "user", content: [{ type: "text", text: "older conversation" }] }],
    },
    agent,
    new AbortController().signal,
    { manual: true, maxTokens: 32_768 },
  );

  assert.equal(result.maxTokens, 32_768);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].tools, []);
  assert.equal(calls[0].temperature, 0);
  assert.equal(calls[0].maxTokens, 32_768);
  assert.equal(calls[0].system, "companion system");
  assert.match(calls[0].messages.at(-1).content[0].text, /分批压缩/u);
});

test("Suzu manual compaction rolls successive safe batches into one final checkpoint", async () => {
  const events = [];
  for (let seq = 1; seq <= 4; seq += 1) {
    events[seq] = {
      seq,
      type: seq % 2 === 0 ? "assistant/message" : "user/message",
      data: seq % 2 === 0
        ? { message: { content: [{ type: "text", text: `assistant-${seq}` }] } }
        : { content: [{ type: "text", text: `user-${seq}` }] },
    };
  }
  let nextSeq = 4;
  const session = {
    surface: { nodes: [1, 2, 3, 4] },
    events,
    requestHeader: () => ({ system: "", tools: [] }),
    deriveEventMessage(event) {
      return event?.data?.message || event?.data || null;
    },
    append(type, data, options = {}) {
      const event = { seq: ++nextSeq, type, data };
      events[event.seq] = event;
      const operation = options.surfaceOp;
      if (operation?.op === "replace") {
        const start = this.surface.nodes.indexOf(operation.start);
        const end = this.surface.nodes.indexOf(operation.end);
        this.surface.nodes.splice(start, end - start + 1, event.seq);
      }
      return event;
    },
  };
  let flushes = 0;
  let selectionCalls = 0;
  const engine = {
    baseConfig: {},
    ctx: {
      tokenMeter: {
        measure(current) {
          const nodes = current.surface.nodes.map((seq) => ({ seq, tokens: seq <= 4 ? 1_000 : 120 }));
          return { nodes, totalTokens: nodes.reduce((total, node) => total + node.tokens, 0) };
        },
        estimateMessage: () => 120,
      },
      sessions: { flush: async () => { flushes += 1; } },
    },
    settingsContext: { run: async (_scope, callback) => callback() },
    settingsFor: async () => ({ manual: { retainTokens: 1_000 }, prompt: "condense" }),
    manualInputLimit: async () => 1_000,
    manualSummaryTokenLimit: async () => 8_192,
    manualBatchRange: async () => {
      selectionCalls += 1;
      if (selectionCalls === 1) return { start: 1, end: 2, hasRemainingRange: true };
      if (selectionCalls === 2) return {
        start: session.surface.nodes[0],
        end: 3,
        hasRemainingRange: false,
      };
      throw new Error("manual compaction should stop after the final batch");
    },
    summarize: async () => ({
      summary: [{ type: "text", text: "short checkpoint" }],
      rawOutput: [{ type: "text", text: "short checkpoint" }],
      provider: "test-provider",
      model: "test-model",
      maxTokens: 8_192,
    }),
  };
  const agent = {
    session,
    runMaintenance: async (callback) => callback(new AbortController().signal),
  };

  const result = await SuzuCompanionCompactionEngine.prototype.compactNow.call(
    engine,
    agent,
    new AbortController().signal,
    "manual-batch-test",
  );

  assert.equal(result.batchCount, 2);
  assert.equal(selectionCalls, 2);
  assert.equal(flushes, 2, "each completed batch must be durable before the next one starts");
  assert.deepEqual(session.surface.nodes, [11, 4], "the second batch rolls the first checkpoint into its successor");
  assert.equal(events.filter((event) => event?.type === "compaction/end").length, 2);
});

test("Suzu manual compaction halves an overlarge batch after the summary output cap", async () => {
  const events = [];
  for (let seq = 1; seq <= 4; seq += 1) {
    events[seq] = {
      seq,
      type: seq % 2 === 0 ? "assistant/message" : "user/message",
      data: seq % 2 === 0
        ? { message: { content: [{ type: "text", text: `assistant-${seq}` }] } }
        : { content: [{ type: "text", text: `user-${seq}` }] },
    };
  }
  let nextSeq = 4;
  const session = {
    surface: { nodes: [1, 2, 3, 4] },
    events,
    requestHeader: () => ({ system: "", tools: [] }),
    deriveEventMessage(event) {
      return event?.data?.message || event?.data || null;
    },
    append(type, data, options = {}) {
      const event = { seq: ++nextSeq, type, data };
      events[event.seq] = event;
      const operation = options.surfaceOp;
      if (operation?.op === "replace") {
        const start = this.surface.nodes.indexOf(operation.start);
        const end = this.surface.nodes.indexOf(operation.end);
        this.surface.nodes.splice(start, end - start + 1, event.seq);
      }
      return event;
    },
  };
  let flushes = 0;
  let summaries = 0;
  const inputLimits = [];
  const summaryLimits = [];
  const engine = {
    baseConfig: {},
    ctx: {
      tokenMeter: {
        measure(current) {
          const nodes = current.surface.nodes.map((seq) => ({ seq, tokens: seq <= 4 ? 1_000 : 120 }));
          return { nodes, totalTokens: nodes.reduce((total, node) => total + node.tokens, 0) };
        },
        estimateMessage: () => 120,
      },
      sessions: { flush: async () => { flushes += 1; } },
    },
    settingsContext: { run: async (_scope, callback) => callback() },
    settingsFor: async () => ({ manual: { retainTokens: 1_000 }, prompt: "condense" }),
    manualInputLimit: async () => 1_000,
    manualSummaryTokenLimit: async () => 32_768,
    manualBatchRange: async (_agent, _settings, _signal, inputLimit) => {
      inputLimits.push(inputLimit);
      return inputLimit === 1_000
        ? { start: 1, end: 2, hasRemainingRange: true }
        : { start: 1, end: 1, hasRemainingRange: false };
    },
    summarize: async (_input, _agent, _signal, options) => {
      summaries += 1;
      assert.equal(options.manual, true);
      summaryLimits.push(options.maxTokens);
      if (summaries === 1) {
        const error = new Error("summarization truncated at token cap");
        error.code = "MAX_TOKENS";
        throw error;
      }
      return {
        summary: [{ type: "text", text: "short checkpoint" }],
        rawOutput: [{ type: "text", text: "short checkpoint" }],
        provider: "test-provider",
        model: "test-model",
        maxTokens: 32_768,
      };
    },
  };
  const agent = {
    session,
    runMaintenance: async (callback) => callback(new AbortController().signal),
  };

  const result = await SuzuCompanionCompactionEngine.prototype.compactNow.call(
    engine,
    agent,
    new AbortController().signal,
    "manual-summary-retry-test",
  );

  assert.equal(result.batchCount, 1);
  assert.equal(summaries, 2);
  assert.deepEqual(inputLimits, [1_000, 500]);
  assert.deepEqual(summaryLimits, [800, 400]);
  assert.equal(flushes, 2, "the failed attempt and the retry must both write a terminal record");
  assert.equal(events.filter((event) => event?.type === "compaction/end").length, 2);
});

test("the non-disableable safety policy reserves model output before compacting", async () => {
  const baseConfig = Object.freeze({
    auto: true,
    thresholdRatio: 0.8,
    retainTokens: 5_000,
    maxTokens: 8_192,
    compactionRetries: 1,
    maxOverflowRetries: 1,
    modelPolicies: [],
  });
  const engine = {
    baseConfig,
    ctx: {
      llm: {
        resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }),
      },
    },
    contextBudgetFor: SuzuCompanionCompactionEngine.prototype.contextBudgetFor,
  };
  const agent = {
    session: {
      requestHeader: () => ({ config: { provider: "deepseek", model: "chat" } }),
    },
  };
  const settings = {
    automatic: { enabled: false, tokenThreshold: 15_000, retainTokens: 5_000 },
  };

  const config = await SuzuCompanionCompactionEngine.prototype.safetyConfig.call(
    engine,
    agent,
    settings,
    new AbortController().signal,
  );

  assert.equal(config.thresholdRatio, 0.85904);
  assert.equal(config.retainTokens, 5_000);
  assert.equal(config.auto, true);
});

test("Suzu context budget reserves a configured 256k normal-chat completion", () => {
  assert.deepEqual(suzuContextBudget({
    context: { contextWindow: 1_048_576 },
    defaultMaxTokens: 256_000,
  }), {
    contextWindow: 1_048_576,
    outputReserve: 256_000,
    inputLimitTokens: 788_480,
  });
});

test("Suzu context measurement does not underestimate dense Chinese conversation text", () => {
  const chinese = "你好，今天我们继续把这个功能做好。".repeat(100);
  const events = [];
  events[1] = {
    seq: 1,
    type: "user/message",
    data: { content: [{ type: "text", text: chinese }] },
  };
  const session = {
    surface: { nodes: [1] },
    events,
    requestHeader: () => ({ system: "", tools: [] }),
    deriveEventMessage: (event) => ({ content: event.data.content }),
  };

  const measurement = estimateSuzuContextMeasurement(session);

  assert.equal(measurement.nodes[0].seq, 1);
  assert.ok(measurement.nodes[0].tokens >= chinese.length);
  assert.ok(measurement.totalTokens >= measurement.nodes[0].tokens);
});

test("automatic trigger selection preserves both the safety guard and overflow recovery", async () => {
  const safetyConfig = Object.freeze({ kind: "safety" });
  const configuredConfig = Object.freeze({ kind: "configured" });
  const baseConfig = Object.freeze({ kind: "overflow-recovery" });
  const engine = {
    baseConfig,
    safetyConfig: async () => safetyConfig,
    automaticConfig: async () => configuredConfig,
  };
  const disabled = { automatic: { enabled: false } };
  const enabled = { automatic: { enabled: true } };
  const signal = new AbortController().signal;

  assert.equal(
    await SuzuCompanionCompactionEngine.prototype.configForAutomaticTrigger.call(engine, {}, "pressure", disabled, signal),
    safetyConfig,
  );
  assert.equal(
    await SuzuCompanionCompactionEngine.prototype.configForAutomaticTrigger.call(engine, {}, "pressure", enabled, signal),
    configuredConfig,
  );
  assert.equal(
    await SuzuCompanionCompactionEngine.prototype.configForAutomaticTrigger.call(engine, {}, "context-overflow", disabled, signal),
    baseConfig,
  );
});
