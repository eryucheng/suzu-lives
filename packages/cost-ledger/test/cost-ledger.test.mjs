import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendUsageEvent,
  calculateCost,
  createPriceCatalog,
  createUsageEvent,
  priceCatalogView,
  readUsageEvents,
  readUsageSummary,
  rebuildUsageSummary,
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

test("uses low rates all weekend after DeepSeek's August 23 weekday-only peak update", () => {
  const usage = {
    prompt_cache_miss_tokens: 1_000_000,
    prompt_cache_hit_tokens: 1_000_000,
    completion_tokens: 1_000_000,
  };
  const priorSaturdayPeak = calculateCost({
    model: "deepseek-v4-flash",
    timestamp: "2026-08-22T02:00:00.000Z",
    usage,
  });
  const sundayOffPeak = calculateCost({
    model: "deepseek-v4-flash",
    timestamp: "2026-08-23T02:00:00.000Z",
    usage,
  });
  const mondayPeak = calculateCost({
    model: "deepseek-v4-flash",
    timestamp: "2026-08-24T02:00:00.000Z",
    usage,
  });
  const visionWeekend = calculateCost({
    model: "deepseek-v4-flash-vision-exp",
    timestamp: "2026-08-23T02:00:00.000Z",
    usage,
  });

  assert.ok(Math.abs(priorSaturdayPeak.amountCny - 12.1) < 0.000001);
  assert.equal(priorSaturdayPeak.price.revisionId, "official-2026-08-16-peak-offpeak");
  assert.equal(priorSaturdayPeak.price.ratePeriod, "高峰时段");
  assert.ok(Math.abs(sundayOffPeak.amountCny - 6.05) < 0.000001);
  assert.equal(sundayOffPeak.price.revisionId, "official-2026-08-23-weekend-offpeak");
  assert.equal(sundayOffPeak.price.ratePeriod, "空闲时段");
  assert.ok(Math.abs(mondayPeak.amountCny - 12.1) < 0.000001);
  assert.equal(mondayPeak.price.ratePeriod, "高峰时段");
  assert.ok(Math.abs(visionWeekend.amountCny - 6.05) < 0.000001);
  assert.equal(visionWeekend.price.ratePeriod, "空闲时段");
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

test("keeps a compact dashboard summary in sync with concurrent ledger appends", async () => {
  const root = fs.mkdtempSync(path.join(process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp", "suzu-ledger-summary-"));
  const ledgerPath = path.join(root, "events.jsonl");
  const now = new Date();
  await Promise.all(Array.from({ length: 12 }, (_value, index) => appendUsageEvent(ledgerPath, {
    id: `summary-${index}`,
    timestamp: new Date(now.getTime() + index).toISOString(),
    model: "text-embedding-v4",
    source: "测试",
    feature: "summary-test",
    usage: { prompt_tokens: index + 1 },
  })));

  const summary = await readUsageSummary(ledgerPath, { now });
  const stored = await readUsageEvents(ledgerPath);
  const dayEvents = Object.values(summary.days).flat();
  assert.equal(summary.status, "ready");
  assert.equal(stored.events.length, 12);
  assert.equal(dayEvents.length, 12);
  assert.equal(summary.recentEvents.length, 12);
  assert.deepEqual(summary.recentEvents.map((event) => event.id), Array.from({ length: 12 }, (_value, index) => `summary-${index}`));
});

test("marks an externally changed ledger stale until its sidecar is rebuilt", async () => {
  const root = fs.mkdtempSync(path.join(process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp", "suzu-ledger-rebuild-"));
  const ledgerPath = path.join(root, "events.jsonl");
  const now = new Date();
  await appendUsageEvent(ledgerPath, {
    id: "first",
    timestamp: now.toISOString(),
    model: "text-embedding-v4",
    source: "测试",
    feature: "summary-test",
    usage: { prompt_tokens: 1 },
  });
  const external = createUsageEvent({
    id: "external",
    timestamp: new Date(now.getTime() + 1).toISOString(),
    model: "text-embedding-v4",
    source: "测试",
    feature: "summary-test",
    usage: { prompt_tokens: 2 },
  });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(external)}\n`, "utf8");

  assert.equal((await readUsageSummary(ledgerPath, { now })).status, "stale");
  const rebuilt = await rebuildUsageSummary(ledgerPath, { now });
  assert.equal(rebuilt.status, "ready");
  assert.equal(Object.values(rebuilt.days).flat().length, 2);
  assert.deepEqual((await readUsageSummary(ledgerPath, { now })).recentEvents.map((event) => event.id), ["first", "external"]);
});
