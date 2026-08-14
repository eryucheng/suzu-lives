import assert from "node:assert/strict";
import test from "node:test";

import {
  previewEdgePlasticity,
  previewMemoryPlasticity,
} from "../src/index.mjs";

function stats(overrides = {}) {
  return {
    memoryId: "memory-1",
    selectedCount: 0,
    feedback: {
      used: 0,
      helpful: 0,
      irrelevant: 0,
      incorrect: 0,
      missed: 0,
      corrected: 0,
    },
    ...overrides,
  };
}

test("keeps exposure-only memory learning weak and separate from truth", () => {
  const result = previewMemoryPlasticity(stats({ selectedCount: 5 }));
  assert.equal(result.learningTarget, "accessibility");
  assert.equal(result.evidenceClass, "exposure-only");
  assert.equal(result.candidateDirection, "increase");
  assert.equal(result.evidenceTier, "weak");
  assert.equal(result.automaticAdjustmentAllowed, false);
  assert.equal(result.invariants.confidenceEffect, "none");
  assert.equal(result.invariants.importanceEffect, "none");
  assert.equal(result.invariants.currentRankingEffect, "none");
});

test("distinguishes helpful, missed, irrelevant, and content correction", () => {
  assert.equal(previewMemoryPlasticity(stats({
    feedback: { helpful: 1 },
  })).evidenceClass, "confirmed-helpful");
  assert.equal(previewMemoryPlasticity(stats({
    feedback: { missed: 1 },
  })).evidenceClass, "relevant-but-missed");
  assert.equal(previewMemoryPlasticity(stats({
    feedback: { irrelevant: 1 },
  })).candidateDirection, "decrease");
  const corrected = previewMemoryPlasticity(stats({
    feedback: { helpful: 3, corrected: 1 },
  }));
  assert.equal(corrected.learningTarget, "manual-review");
  assert.equal(corrected.candidateDirection, "hold");
  assert.equal(corrected.evidenceTier, "blocked");
});

test("holds conflicting outcome feedback instead of averaging it", () => {
  const result = previewMemoryPlasticity(stats({
    feedback: { helpful: 2, irrelevant: 1 },
  }));
  assert.equal(result.evidenceClass, "conflicting-feedback");
  assert.equal(result.learningTarget, "manual-review");
  assert.equal(result.candidateDirection, "hold");
});

test("targets learned relation utility without changing the base edge weight", () => {
  const result = previewEdgePlasticity({
    edgeId: "edge-1",
    traversedCount: 4,
    feedback: { used: 1 },
  });
  assert.equal(result.targetType, "edge");
  assert.equal(result.learningTarget, "relation-utility");
  assert.equal(result.evidenceClass, "use-confirmed");
  assert.equal(result.evidenceTier, "weak");
  assert.equal(result.invariants.baseEdgeWeightEffect, "none");
  assert.equal(result.automaticAdjustmentAllowed, false);
});
