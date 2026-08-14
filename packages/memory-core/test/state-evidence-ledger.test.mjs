import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  MEMORY_STATE_FAMILIES,
  MEMORY_STATE_FAMILY_DEFINITIONS,
  MemoryRepository,
  openMemoryDatabase,
} from "../src/index.mjs";

function setup() {
  const database = openMemoryDatabase(":memory:");
  return { database, repository: new MemoryRepository(database) };
}

test("keeps disposition and current conditions distinct from preference and habit", () => {
  assert.equal(MEMORY_STATE_FAMILIES.includes("disposition"), true);
  assert.equal(MEMORY_STATE_FAMILIES.includes("condition"), true);
  assert.match(MEMORY_STATE_FAMILY_DEFINITIONS.disposition.description, /跨情境/u);
  assert.match(MEMORY_STATE_FAMILY_DEFINITIONS.condition.description, /约束/u);
  assert.equal(MEMORY_STATE_FAMILY_DEFINITIONS.preference.status, "transitional");
  assert.equal(MEMORY_STATE_FAMILY_DEFINITIONS.belief.status, "transitional");
  assert.equal(MEMORY_STATE_FAMILY_DEFINITIONS.habit.status, "transitional");
  assert.equal(MEMORY_STATE_FAMILY_DEFINITIONS.disposition.status, "transitional");
  assert.equal(MEMORY_STATE_FAMILY_DEFINITIONS.condition.status, "transitional");
  assert.equal(MEMORY_STATE_FAMILY_DEFINITIONS.goal.status, "transitional");
  assert.equal(MEMORY_STATE_FAMILY_DEFINITIONS.relationship.status, "transitional");
  assert.equal(MEMORY_STATE_FAMILY_DEFINITIONS.value.status, "transitional");
  assert.equal(MEMORY_STATE_FAMILY_DEFINITIONS.capability.status, "transitional");
  assert.equal(MEMORY_STATE_FAMILY_DEFINITIONS.self_concept.status, "transitional");
  assert.equal(MEMORY_STATE_FAMILY_DEFINITIONS.affective_association.status, "transitional");
  assert.equal(MEMORY_STATE_FAMILY_DEFINITIONS.identity.status, "transitional");
});

function evidenceMemory(repository, {
  agentId = "agent-test",
  id = "choice-puzzle",
  externalId = `source-${id}`,
  content = "用户在空闲时间主动选择了解谜游戏。",
  sourceContent = "我今晚还是想玩解谜游戏。",
  occurredAt = "2026-07-10T12:00:00.000Z",
} = {}) {
  const source = repository.upsertSource({
    agentId,
    sourceKind: "conversation",
    externalId,
    occurredAt,
    speaker: "User",
    content: sourceContent,
  });
  const memory = repository.upsertMemory({
    id,
    agentId,
    kind: "event",
    layer: "episodic",
    content,
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    evidenceMode: "observed",
    temporalState: "historical",
    eventStart: occurredAt,
    knownAt: occurredAt,
  });
  repository.linkSource(memory.id, source.id, "evidence", {
    authority: "subject_firsthand",
    sourceTrust: 0.95,
    evidenceStrength: 1,
    provenance: "test",
  });
  return { memory, source };
}

function analysisRun(repository, evidence, overrides = {}) {
  return repository.recordStateAnalysisRun({
    id: "analysis-preference-1",
    agentId: "agent-test",
    batchId: "preference-batch-1",
    stateFamily: "preference",
    analyzerRole: "behavior-conditions",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    provider: "test-provider",
    model: "test-model",
    promptVersion: "preference-behavior-v1",
    schemaVersion: "preference-behavior-schema-v1",
    inputHash: createHash("sha256").update("bounded-snapshot").digest("hex"),
    status: "completed",
    memoryIds: [evidence.memory.id],
    sourceIds: [evidence.source.id],
    output: { agency: "active", alternatives: "present" },
    usage: { inputTokens: 120, outputTokens: 30 },
    costAmount: 0.001,
    costCurrency: "CNY",
    requestId: "request-1",
    durationMs: 320,
    ...overrides,
  });
}

test("stores state analysis and evidence outside autobiographical memory", () => {
  const { database, repository } = setup();
  const evidence = evidenceMemory(repository);
  const memoryCount = Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const run = analysisRun(repository, evidence);
  assert.equal(run.wasInserted, true);
  assert.deepEqual(run.memoryIds, [evidence.memory.id]);
  assert.deepEqual(run.sourceIds, [evidence.source.id]);
  assert.equal(run.costAmount, 0.001);

  const observation = repository.recordStateEvidenceObservation({
    id: "observation-preference-1",
    agentId: "agent-test",
    batchId: "preference-batch-1",
    stateFamily: "preference",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    memoryId: evidence.memory.id,
    evidenceGroupId: "event:free-evening-1",
    contextId: "context:free-evening",
    signal: "active_choice",
    claimedDirection: "support",
    effectiveDirection: "support",
    qualification: "qualified",
    confidence: 0.88,
    origin: "llm",
    payloadSchemaVersion: "preference-merged-evidence-v1",
    payload: { agency: "active", alternatives: "present" },
    sourceIds: [evidence.source.id],
    analysisRunIds: [run.id],
  });
  assert.equal(observation.wasInserted, true);
  assert.equal(observation.qualification, "qualified");
  assert.deepEqual(observation.analysisRunIds, [run.id]);
  assert.deepEqual(observation.sourceIds, [evidence.source.id]);
  assert.equal(
    Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    memoryCount,
  );
  assert.equal(repository.listStateAnalysisRuns("agent-test", {
    stateFamily: "preference",
  }).length, 1);
  assert.equal(repository.listStateEvidenceObservations("agent-test", {
    stateFamily: "preference",
    canonicalKey: "user:preference:puzzle-games",
  }).length, 1);
  database.close();
});

test("keeps exclusions neutral and versions a later analysis without deleting history", () => {
  const { database, repository } = setup();
  const evidence = evidenceMemory(repository, {
    content: "用户每天因工作要求加班。",
    sourceContent: "最近项目要求我每天都得加班。",
  });
  const firstRun = analysisRun(repository, evidence, {
    canonicalKey: "user:preference:overtime",
    output: { constraint: "work", agency: "constrained" },
  });
  const excluded = repository.recordStateEvidenceObservation({
    id: "observation-overtime-1",
    agentId: "agent-test",
    stateFamily: "preference",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:overtime",
    memoryId: evidence.memory.id,
    evidenceGroupId: "event:overtime",
    signal: "repeated_behavior",
    claimedDirection: "support",
    effectiveDirection: "neutral",
    qualification: "excluded",
    confidence: 0.95,
    origin: "llm",
    payloadSchemaVersion: "preference-merged-evidence-v1",
    payload: { constraint: "work", agency: "constrained" },
    excludedReason: "external-constraint",
    sourceIds: [evidence.source.id],
    analysisRunIds: [firstRun.id],
  });
  const replay = repository.recordStateEvidenceObservation({
    id: "ignored-new-id-for-exact-replay",
    agentId: "agent-test",
    stateFamily: "preference",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:overtime",
    memoryId: evidence.memory.id,
    evidenceGroupId: "event:overtime",
    signal: "repeated_behavior",
    claimedDirection: "support",
    effectiveDirection: "neutral",
    qualification: "excluded",
    confidence: 0.95,
    origin: "llm",
    payloadSchemaVersion: "preference-merged-evidence-v1",
    payload: { agency: "constrained", constraint: "work" },
    excludedReason: "external-constraint",
    sourceIds: [evidence.source.id],
    analysisRunIds: [firstRun.id],
  });
  assert.equal(replay.id, excluded.id);
  assert.equal(replay.wasInserted, false);

  const secondRun = analysisRun(repository, evidence, {
    id: "analysis-preference-2",
    canonicalKey: "user:preference:overtime",
    requestId: "request-2",
    inputHash: createHash("sha256").update("corrected-snapshot").digest("hex"),
    output: { constraint: "none", agency: "active" },
  });
  const corrected = repository.recordStateEvidenceObservation({
    id: "observation-overtime-2",
    agentId: "agent-test",
    stateFamily: "preference",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:overtime",
    memoryId: evidence.memory.id,
    evidenceGroupId: "event:overtime",
    signal: "active_choice",
    claimedDirection: "support",
    effectiveDirection: "support",
    qualification: "qualified",
    confidence: 0.7,
    origin: "llm",
    payloadSchemaVersion: "preference-merged-evidence-v1",
    payload: { constraint: "none", agency: "active" },
    sourceIds: [evidence.source.id],
    analysisRunIds: [secondRun.id],
  });
  assert.equal(corrected.supersedesObservationId, excluded.id);
  assert.equal(repository.getStateEvidenceObservation("agent-test", excluded.id).lifecycle, "superseded");
  assert.equal(repository.listStateEvidenceObservations("agent-test", {
    canonicalKey: "user:preference:overtime",
  })[0].id, corrected.id);
  assert.equal(repository.listStateEvidenceObservations("agent-test", {
    canonicalKey: "user:preference:overtime",
    lifecycles: ["current", "superseded"],
  }).length, 2);
  database.close();
});

test("rejects cross-Agent sources and analysis runs before writing evidence", () => {
  const { database, repository } = setup();
  const evidence = evidenceMemory(repository);
  const other = evidenceMemory(repository, {
    agentId: "agent-other",
    id: "other-memory",
    externalId: "other-source",
  });
  assert.throws(() => repository.recordStateAnalysisRun({
    id: "cross-agent-run",
    agentId: "agent-test",
    stateFamily: "preference",
    analyzerRole: "behavior-conditions",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    promptVersion: "v1",
    schemaVersion: "v1",
    inputHash: "input-hash",
    status: "completed",
    memoryIds: [evidence.memory.id],
    sourceIds: [other.source.id],
  }), /source must support/u);
  const run = analysisRun(repository, evidence);
  assert.throws(() => repository.recordStateEvidenceObservation({
    id: "cross-agent-observation",
    agentId: "agent-other",
    stateFamily: "preference",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    memoryId: other.memory.id,
    evidenceGroupId: "group:other",
    signal: "active_choice",
    claimedDirection: "support",
    effectiveDirection: "support",
    qualification: "qualified",
    origin: "llm",
    payloadSchemaVersion: "v1",
    sourceIds: [other.source.id],
    analysisRunIds: [run.id],
  }), /analysis run does not cover/u);
  assert.equal(
    Number(database.prepare("SELECT COUNT(*) AS count FROM memory_state_evidence_observations").get().count),
    0,
  );
  database.close();
});
