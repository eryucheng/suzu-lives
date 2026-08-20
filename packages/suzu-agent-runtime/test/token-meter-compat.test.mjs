import assert from "node:assert/strict";
import { basename } from "node:path";
import test from "node:test";

import { resolveSuzuAgentCoreModule } from "../src/core-module-catalog.mjs";
import {
  TokenMeter,
  restoredHistoricalAssistantMessages,
} from "../src/token-meter-compat.mjs";

function restoredSession() {
  const events = [];
  events[0] = {
    type: "user/message",
    seq: 0,
    data: { content: [{ type: "text", text: "你好" }] },
    surfaceOp: "append",
  };
  events[1] = {
    type: "assistant/message",
    seq: 1,
    // This is the exact shape produced by the old Claude JSONL importer:
    // durable conversation content, but no DSH turn/step lifecycle.
    data: { message: { content: [{ type: "text", text: "你好，我在。" }] } },
    surfaceOp: "append",
  };
  return {
    events,
    surface: { nodes: [0, 1] },
    requestHeader: () => ({ system: "系统提示", tools: [] }),
    deriveEventMessage: (event) => event?.data?.message || event?.data || null,
  };
}

test("restored assistant history bypasses only the missing-lifecycle token replay", () => {
  const session = restoredSession();

  assert.equal(restoredHistoricalAssistantMessages(session), true);
  // The early compatibility branch is intentionally independent from Cordis
  // construction, so this exercises the same measure() path as a real Core.
  const measurement = TokenMeter.prototype.measure.call({}, session);

  assert.deepEqual(measurement.nodes.map((node) => node.seq), [0, 1]);
  assert.ok(measurement.nodes.every((node) => node.tokens > 0));
  assert.ok(measurement.totalTokens >= measurement.surfaceTokens);
  assert.equal(measurement.baseline.kind, "estimated");
});

test("a native assistant with lifecycle fields remains on the upstream meter", () => {
  const session = restoredSession();
  session.events[1].data.turn = 4;
  session.events[1].data.step = 2;

  assert.equal(restoredHistoricalAssistantMessages(session), false);
});

test("the Core token-meter role resolves to Suzu's compatibility module", () => {
  assert.equal(basename(resolveSuzuAgentCoreModule("token-meter")), "token-meter-compat.mjs");
});
