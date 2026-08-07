import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MemoryRepository,
  openMemoryDatabase,
} from "@suzu-lives/memory-core";

import {
  runPlasticityShadow,
} from "../src/index.mjs";

const policy = Object.freeze({
  version: "shadow-test-v1",
  floor: 0.2,
  ceiling: 0.9,
  halfLifeDays: 30,
  exposureGain: 0.01,
  usedGain: 0.02,
  helpfulGain: 0.08,
  missedGain: 0.06,
  irrelevantPenalty: 0.1,
  maximumPositiveStep: 0.12,
  maximumNegativeStep: 0.15,
});

function temporaryDatabase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-plasticity-shadow-"));
  const databasePath = path.join(root, "memory.db");
  const database = openMemoryDatabase(databasePath);
  return { databasePath, database, repository: new MemoryRepository(database) };
}

function shadowInput(databasePath) {
  return {
    databasePath,
    agentId: "agent-test",
    observationWindowId: "2026-08-01-day",
    windowStart: "2026-08-01T00:00:00.000Z",
    windowEnd: "2026-08-02T00:00:00.000Z",
    policies: { memory: policy, edge: policy },
    initialMemoryAccessibility: 0.6,
    initialEdgeRelationUtility: 0.5,
    createdAt: "2026-08-02T00:05:00.000Z",
  };
}

function seedRetrieval(repository, {
  traceId = "shadow-trace-1",
  feedbackId = "shadow-feedback-1",
  createdAt = "2026-08-01T04:00:00.000Z",
} = {}) {
  const trace = repository.recordRetrievalTrace({
    id: traceId,
    agentId: "agent-test",
    queryText: "还记得科技馆和航天展吗",
    resultStatus: "ready",
    seedIds: ["shadow-source"],
    selectedIds: ["shadow-source", "shadow-target"],
    paths: [{
      memoryId: "shadow-target",
      score: 0.8,
      edges: [{
        edgeId: "shadow-edge",
        relation: "semantic",
        fromMemoryId: "shadow-source",
        toMemoryId: "shadow-target",
        relationView: "associative",
      }],
    }],
    createdAt,
  });
  repository.recordRetrievalFeedback({
    id: feedbackId,
    agentId: "agent-test",
    traceId: trace.id,
    signal: "helpful",
    targetMemoryIds: ["shadow-target"],
    createdAt: new Date(Date.parse(createdAt) + 60_000).toISOString(),
  });
}

test("runs an idempotent shadow window without changing retrieval behavior", () => {
  const { databasePath, database, repository } = temporaryDatabase();
  for (const [id, content] of [
    ["shadow-source", "用户去了科技馆。"],
    ["shadow-target", "用户后来参观了航天展。"],
  ]) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content,
    });
  }
  repository.upsertEdge({
    id: "shadow-edge",
    agentId: "agent-test",
    fromMemoryId: "shadow-source",
    toMemoryId: "shadow-target",
    relation: "semantic",
    weight: 0.73,
  });
  seedRetrieval(repository);
  database.close();

  const first = runPlasticityShadow(shadowInput(databasePath));
  assert.equal(first.wasInserted, true);
  assert.equal(first.automaticAdjustmentAllowed, false);
  assert.equal(first.candidateCount, 3);
  assert.equal(first.metadata.automaticAdjustmentAllowed, false);
  assert.deepEqual(
    first.changes.map((change) => [
      change.target_type,
      change.target_id,
      change.intent_view,
      change.evidence_class,
    ]),
    [
      ["edge", "shadow-edge", "associative", "confirmed-helpful"],
      ["memory", "shadow-source", "", "exposure-only"],
      ["memory", "shadow-target", "", "confirmed-helpful"],
    ],
  );

  const inspected = openMemoryDatabase(databasePath);
  assert.equal(Number(inspected.prepare(`
    SELECT COUNT(*) AS count FROM memory_accessibility_state
  `).get().count), 0);
  assert.equal(Number(inspected.prepare(`
    SELECT COUNT(*) AS count FROM memory_edge_relation_utility_state
  `).get().count), 0);
  assert.equal(Number(inspected.prepare(`
    SELECT weight FROM memory_edges WHERE id = 'shadow-edge'
  `).get().weight), 0.73);
  inspected.close();

  const replay = runPlasticityShadow(shadowInput(databasePath));
  assert.equal(replay.wasInserted, false);
  assert.equal(replay.id, first.id);

  const changed = openMemoryDatabase(databasePath);
  seedRetrieval(new MemoryRepository(changed), {
    traceId: "shadow-trace-2",
    feedbackId: "shadow-feedback-2",
    createdAt: "2026-08-01T05:00:00.000Z",
  });
  changed.close();
  assert.throws(
    () => runPlasticityShadow(shadowInput(databasePath)),
    /already recorded with different input/u,
  );
});

test("requires explicit policies, initial values, and a valid closed window", () => {
  const { databasePath, database } = temporaryDatabase();
  database.close();
  const input = shadowInput(databasePath);
  assert.throws(
    () => runPlasticityShadow({ ...input, policies: {} }),
    /require versions/u,
  );
  assert.throws(
    () => runPlasticityShadow({ ...input, initialMemoryAccessibility: undefined }),
    /between 0 and 1/u,
  );
  assert.throws(
    () => runPlasticityShadow({
      ...input,
      windowStart: input.windowEnd,
      windowEnd: input.windowStart,
    }),
    /must be before/u,
  );
});
