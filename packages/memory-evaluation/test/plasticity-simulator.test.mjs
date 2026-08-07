import assert from "node:assert/strict";
import test from "node:test";

import {
  previewMemoryPlasticity,
} from "@suzu-lives/memory-core";

import {
  simulatePlasticityTransition,
} from "../src/index.mjs";

const policy = Object.freeze({
  version: "test-policy-v1",
  floor: 0.2,
  ceiling: 0.9,
  halfLifeDays: 10,
  exposureGain: 0.01,
  usedGain: 0.02,
  helpfulGain: 0.08,
  missedGain: 0.06,
  irrelevantPenalty: 0.1,
  maximumPositiveStep: 0.12,
  maximumNegativeStep: 0.15,
});

function simulate(preview, overrides = {}) {
  return simulatePlasticityTransition({
    currentValue: 0.8,
    preview,
    elapsedDays: 10,
    observationWindowId: "window-2026-08-01",
    policy,
    ...overrides,
  });
}

test("requires an explicit policy and observation window", () => {
  const preview = previewMemoryPlasticity({ memoryId: "memory-1" });
  assert.throws(() => simulatePlasticityTransition({
    currentValue: 0.5,
    preview,
    elapsedDays: 1,
    observationWindowId: "window-1",
  }), /has no defaults/u);
  assert.throws(() => simulatePlasticityTransition({
    currentValue: 0.5,
    preview,
    elapsedDays: 1,
    policy,
  }), /observationWindowId/u);
});

test("applies half-life decay toward a non-destructive floor", () => {
  const result = simulate(previewMemoryPlasticity({ memoryId: "memory-1" }));
  assert.equal(result.decayedValue, 0.5);
  assert.equal(result.proposedValue, 0.5);
  assert.equal(result.automaticAdjustmentAllowed, false);
});

test("caps positive and negative steps and preserves bounds", () => {
  const positive = simulate(previewMemoryPlasticity({
    memoryId: "memory-positive",
    selectedCount: 100,
    feedback: { helpful: 10 },
  }), { elapsedDays: 0, currentValue: 0.88 });
  assert.equal(positive.positiveStep, 0.12);
  assert.equal(positive.proposedValue, 0.9);

  const negative = simulate(previewMemoryPlasticity({
    memoryId: "memory-negative",
    feedback: { irrelevant: 10 },
  }), { elapsedDays: 0, currentValue: 0.21 });
  assert.equal(negative.negativeStep, 0.15);
  assert.equal(negative.proposedValue, 0.2);
});

test("blocks correction and conflicting feedback without even applying decay", () => {
  for (const preview of [
    previewMemoryPlasticity({
      memoryId: "memory-corrected",
      feedback: { corrected: 1 },
    }),
    previewMemoryPlasticity({
      memoryId: "memory-conflict",
      feedback: { helpful: 1, irrelevant: 1 },
    }),
  ]) {
    const result = simulate(preview, { currentValue: 0.73, elapsedDays: 50 });
    assert.equal(result.blocked, true);
    assert.equal(result.proposedValue, 0.73);
    assert.equal(result.automaticAdjustmentAllowed, false);
  }
});
