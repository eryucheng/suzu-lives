import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendUsageEvent,
  calculateCost,
  readUsageEvents,
} from "../src/index.mjs";

test("calculates DeepSeek default price from normalized usage", () => {
  const result = calculateCost({
    model: "deepseek-v4-pro",
    timestamp: "2026-07-30T00:00:00.000Z",
    usage: {
      input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    },
  });
  assert.equal(result.status, "estimated");
  assert.ok(Math.abs(result.amountCny - 9.025) < 0.000001);
});

test("uses DeepSeek native cache hit and miss fields when present", () => {
  const result = calculateCost({
    model: "deepseek-v4-pro",
    timestamp: "2026-07-30T00:00:00.000Z",
    usage: {
      prompt_tokens: 3_000_000,
      prompt_cache_miss_tokens: 2_000_000,
      prompt_cache_hit_tokens: 1_000_000,
      completion_tokens: 3_000_000,
    },
  });
  assert.equal(result.status, "estimated");
  assert.ok(Math.abs(result.amountCny - 24.025) < 0.000001);
  assert.equal(result.units.inputUncachedTokens, 2_000_000);
  assert.equal(result.units.inputCachedTokens, 1_000_000);
});

test("falls back to raw usage when a compatibility event has empty units", () => {
  const result = calculateCost({
    model: "text-embedding-v4",
    timestamp: "2026-07-30T00:00:00.000Z",
    usage: {
      prompt_tokens: 1_000_000,
      total_tokens: 1_000_000,
    },
    units: {},
  });
  assert.equal(result.status, "estimated");
  assert.ok(Math.abs(result.amountCny - 0.5) < 0.000001);
  assert.equal(result.units.inputTokens, 1_000_000);
});

test("prices one successful Qwen voice design creation", () => {
  const result = calculateCost({
    model: "qwen-voice-design",
    timestamp: "2026-07-30T00:00:00.000Z",
    usage: {},
    units: {
      generatedVoices: 1,
    },
  });
  assert.equal(result.status, "estimated");
  assert.ok(Math.abs(result.amountCny - 0.2) < 0.000001);
});

test("matches custom prices by event timestamp without changing older events", () => {
  const customRevisions = [
    {
      modelId: "deepseek-v4-pro",
      effectiveFrom: "2026-08-01T00:00:00.000Z",
      rates: {
        inputUncachedTokens: 4,
        inputCachedTokens: 0.04,
        outputTextTokens: 8,
      },
    },
  ];
  const usage = {
    input_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    output_tokens: 1_000_000,
  };
  const before = calculateCost({
    customRevisions,
    model: "deepseek-v4-pro",
    timestamp: "2026-07-31T23:59:59.000Z",
    usage,
  });
  const after = calculateCost({
    customRevisions,
    model: "deepseek-v4-pro",
    timestamp: "2026-08-01T00:00:00.000Z",
    usage,
  });
  assert.ok(Math.abs(before.amountCny - 9.025) < 0.000001);
  assert.ok(Math.abs(after.amountCny - 12.04) < 0.000001);
});

test("appends and reads a raw usage event without storing a price snapshot", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-ledger-"));
  const ledgerPath = path.join(root, "events.jsonl");
  await appendUsageEvent(ledgerPath, {
    agentId: "agent-test",
    model: "text-embedding-v4",
    source: "RAG",
    feature: "rag-embedding",
    requestId: "request-1",
    usage: {
      prompt_tokens: 184,
      total_tokens: 184,
    },
  });
  const stored = await readUsageEvents(ledgerPath);
  assert.equal(stored.status, "ready");
  assert.equal(stored.events.length, 1);
  assert.equal(stored.events[0].units.inputTokens, 184);
  assert.equal(Object.hasOwn(stored.events[0], "price"), false);
  assert.equal(Object.hasOwn(stored.events[0], "amountCny"), false);
});
