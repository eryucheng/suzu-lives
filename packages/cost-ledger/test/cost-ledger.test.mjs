import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendUsageEvent,
  calculateCost,
  createPriceCatalog,
  priceCatalogView,
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

test("normalizes public DSH camel-case token usage for the active DeepSeek price", () => {
  const result = calculateCost({
    model: "deepseek-v4-flash",
    timestamp: "2026-08-17T01:00:00.000Z",
    usage: {
      inputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 100_000,
      outputTokens: 1_000_000,
    },
  });
  assert.equal(result.status, "estimated");
  assert.deepEqual(result.units, {
    inputUncachedTokens: 1_100_000,
    inputCachedTokens: 1_000_000,
    outputTextTokens: 1_000_000,
  });
  assert.ok(result.amountCny > 0);
});

test("uses the official DeepSeek V4 peak and off-peak rates from their effective time", () => {
  const usage = {
    prompt_cache_miss_tokens: 1_000_000,
    prompt_cache_hit_tokens: 1_000_000,
    completion_tokens: 1_000_000,
  };
  const flashOffPeak = calculateCost({
    model: "deepseek-v4-flash",
    timestamp: "2026-08-16T16:00:00.000Z",
    usage,
  });
  const flashPeak = calculateCost({
    model: "deepseek-v4-flash",
    timestamp: "2026-08-17T01:00:00.000Z",
    usage,
  });
  const proOffPeak = calculateCost({
    model: "deepseek-v4-pro",
    timestamp: "2026-08-16T16:00:00.000Z",
    usage,
  });
  const proPeak = calculateCost({
    model: "deepseek-v4-pro",
    timestamp: "2026-08-17T06:00:00.000Z",
    usage,
  });

  assert.ok(Math.abs(flashOffPeak.amountCny - 6.05) < 0.000001);
  assert.equal(flashOffPeak.price.ratePeriod, "空闲时段");
  assert.ok(Math.abs(flashPeak.amountCny - 12.1) < 0.000001);
  assert.equal(flashPeak.price.ratePeriod, "高峰时段");
  assert.ok(Math.abs(proOffPeak.amountCny - 18.15) < 0.000001);
  assert.equal(proOffPeak.price.ratePeriod, "空闲时段");
  assert.ok(Math.abs(proPeak.amountCny - 36.3) < 0.000001);
  assert.equal(proPeak.price.ratePeriod, "高峰时段");
});

test("keeps DeepSeek V4 usage before the price change on the former price", () => {
  const result = calculateCost({
    model: "deepseek-v4-flash",
    timestamp: "2026-08-16T15:59:59.999Z",
    usage: {
      prompt_cache_miss_tokens: 1_000_000,
      prompt_cache_hit_tokens: 1_000_000,
      completion_tokens: 1_000_000,
    },
  });

  assert.ok(Math.abs(result.amountCny - 3.02) < 0.000001);
  assert.equal(result.price.revisionId, "official-before-2026-08-16");
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

test("prices CosyVoice V3.5 Plus by input characters", () => {
  const result = calculateCost({
    model: "cosyvoice-v3.5-plus",
    timestamp: "2026-08-21T00:00:00.000Z",
    units: {
      inputCharacters: 10_000,
    },
  });
  assert.equal(result.status, "estimated");
  assert.equal(result.units.inputCharacters, 10_000);
  assert.equal(result.amountCny, 1.5);
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

test("calculates an arbitrary user-created text model from its own price mapping", () => {
  const catalog = createPriceCatalog({
    customPriceModels: [{
      modelId: "openai/gpt-4.1-mini",
      label: "GPT-4.1 mini",
      provider: "OpenAI",
      effectiveFrom: "2026-08-17T00:00:00.000Z",
      rateDefinitions: {
        inputTokens: { label: "输入", unitLabel: "元 / 百万 Token", per: 1_000_000 },
        outputTextTokens: { label: "输出", unitLabel: "元 / 百万 Token", per: 1_000_000 },
      },
      rates: { inputTokens: 2, outputTextTokens: 8 },
    }],
  });
  const result = calculateCost({
    catalog,
    model: "OPENAI/GPT-4.1-MINI",
    timestamp: "2026-08-17T00:00:01.000Z",
    usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
  });

  assert.equal(result.status, "estimated");
  assert.ok(Math.abs(result.amountCny - 10) < 0.000001);
  assert.equal(result.units.inputTokens, 1_000_000);
  assert.equal(result.units.outputTextTokens, 1_000_000);
  assert.equal(priceCatalogView({ catalog }).models.find((item) => item.modelId === "openai/gpt-4.1-mini")?.isUserDefined, true);

  const revised = calculateCost({
    catalog,
    customRevisions: [{
      modelId: "openai/gpt-4.1-mini",
      effectiveFrom: "2026-08-18T00:00:00.000Z",
      rates: { inputTokens: 3, outputTextTokens: 9 },
    }],
    model: "openai/gpt-4.1-mini",
    timestamp: "2026-08-18T00:00:00.000Z",
    usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
  });
  assert.ok(Math.abs(revised.amountCny - 12) < 0.000001);
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
