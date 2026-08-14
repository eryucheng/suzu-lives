import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRepository, openMemoryDatabase } from "@suzu-lives/memory-core";
import { buildCanonicalStateEvidenceSnapshot } from "../src/index.mjs";

const KEY = "user:value:careful-work";

function setup({ withCurrent = false } = {}) {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  let current = null;
  if (withCurrent) {
    current = repository.upsertMemory({
      id: "current-value",
      agentId: "agent-test",
      kind: "derived_hypothesis",
      layer: "semantic",
      content: "用户重视把重要工作做仔细。",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: KEY,
      reality: "real",
      evidenceMode: "inferred",
      stateFamily: "value",
      statePhase: "active",
      temporalState: "current",
      knownAt: "2026-07-01T08:00:00.000Z",
      validFrom: "2026-07-01T08:00:00.000Z",
      metadata: { scope: { kind: "work", label: "重要工作" } },
    });
  }
  return { database, repository, current };
}

function addObservation(repository, {
  id,
  stateFamily = "value",
  canonicalKey = KEY,
  evidenceGroupId = `event:${id}`,
  contextId = "context:work",
  qualification = "qualified",
  claimedDirection = "support",
  effectiveDirection = claimedDirection,
  excludedReason = "",
  sourceContent = `原始证据 ${id}`,
  observedAt = "2026-07-10T12:00:00.000Z",
  memoryKind = "event",
  evidenceMode = "explicit",
  scope = {},
} = {}) {
  const source = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: `source-${id}`,
    occurredAt: observedAt,
    knownAt: observedAt,
    speaker: "User",
    content: sourceContent,
  });
  const memory = repository.upsertMemory({
    id: `memory-${id}`,
    agentId: "agent-test",
    kind: memoryKind,
    layer: memoryKind === "utterance" ? "evidence" : "episodic",
    content: `结构化证据 ${id}`,
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    evidenceMode,
    temporalState: "historical",
    eventStart: observedAt,
    knownAt: observedAt,
  });
  repository.linkSource(memory.id, source.id, "evidence", {
    authority: "subject_firsthand",
    sourceTrust: 0.95,
    evidenceStrength: 1,
    provenance: "test",
  });
  const observation = repository.recordStateEvidenceObservation({
    id: `observation-${id}`,
    agentId: "agent-test",
    stateFamily,
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey,
    memoryId: memory.id,
    evidenceGroupId,
    contextId,
    signal: `signal-${id}`,
    claimedDirection,
    effectiveDirection,
    qualification,
    confidence: 0.9,
    origin: "deterministic",
    scope,
    payloadSchemaVersion: `${stateFamily}-test-v1`,
    payload: { marker: id },
    excludedReason,
    sourceIds: [source.id],
    observedAt,
  });
  return { memory, source, observation };
}

function build(repository, overrides = {}) {
  return buildCanonicalStateEvidenceSnapshot({
    repository,
    agentId: "agent-test",
    stateFamily: "value",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    subjectLabel: "用户",
    stateLabel: "认真对待重要工作",
    ...overrides,
  });
}

test("builds one complete family-isolated snapshot with every qualification visible", () => {
  const fixture = setup();
  const support = addObservation(fixture.repository, { id: "support", evidenceGroupId: "event:shared" });
  addObservation(fixture.repository, {
    id: "excluded",
    evidenceGroupId: "event:shared",
    qualification: "excluded",
    claimedDirection: "support",
    effectiveDirection: "neutral",
    excludedReason: "external-constraint",
  });
  addObservation(fixture.repository, {
    id: "unresolved",
    contextId: "",
    qualification: "unresolved",
    claimedDirection: "opposition",
    effectiveDirection: "neutral",
  });
  addObservation(fixture.repository, {
    id: "other-family",
    stateFamily: "capability",
    canonicalKey: KEY,
  });
  const before = Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const result = build(fixture.repository);
  assert.equal(result.status, "ready");
  assert.equal(result.snapshot.observations.length, 3);
  assert.deepEqual(result.snapshot.completeness.qualificationCounts, {
    qualified: 1,
    excluded: 1,
    unresolved: 1,
  });
  assert.equal(result.snapshot.groups.evidence.find((group) => group.id === "event:shared").observationIds.length, 2);
  assert.deepEqual(result.snapshot.groups.observationsWithoutContext, ["observation-unresolved"]);
  assert.equal(result.snapshot.observations.find((item) => item.id === support.observation.id).sources[0].content, "原始证据 support");
  assert.equal(result.snapshot.inputPolicy.evidenceGroupsAreNotVotes, true);
  assert.equal(Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count), before);
  fixture.database.close();
});

test("keeps qualified neutral evidence visible without treating it as a state decision", () => {
  const fixture = setup();
  addObservation(fixture.repository, {
    id: "neutral",
    claimedDirection: "neutral",
    effectiveDirection: "neutral",
  });
  const result = build(fixture.repository);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.snapshot.requiredQualifiedObservationIds, ["observation-neutral"]);
  assert.deepEqual(result.snapshot.qualifiedDirectionalObservationIds, []);
  assert.equal(result.snapshot.synthesisEligibility, "evidence-only");
  fixture.database.close();
});

test("refuses observation truncation instead of reviewing only the newest rows", () => {
  const fixture = setup();
  addObservation(fixture.repository, { id: "one" });
  addObservation(fixture.repository, { id: "two" });
  assert.throws(() => build(fixture.repository, { maxObservations: 1 }), /complete 1-observation budget/u);
  fixture.database.close();
});

test("refuses partial source excerpts instead of hiding evidence behind clipping", () => {
  const fixture = setup();
  addObservation(fixture.repository, { id: "long", sourceContent: "证".repeat(101) });
  assert.throws(() => build(fixture.repository, { maxSourceContentChars: 100 }), /Source .* complete 100-character budget/u);
  fixture.database.close();
});

test("requires every current-state evidence edge to be represented in the ledger", () => {
  const fixture = setup({ withCurrent: true });
  const covered = addObservation(fixture.repository, { id: "covered" });
  fixture.repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: fixture.current.id,
    toMemoryId: covered.memory.id,
    relation: "supported_by",
    direction: "directed",
    weight: 0.9,
    confidence: 0.9,
    provenance: "test",
  });
  const result = build(fixture.repository);
  assert.deepEqual(result.snapshot.completeness.currentStateEvidenceMemoryIds, [covered.memory.id]);
  assert.equal(result.snapshot.completeness.currentStateEvidenceCovered, true);
  fixture.database.close();
});

test("stops when an existing current state has no auditable evidence edges", () => {
  const fixture = setup({ withCurrent: true });
  addObservation(fixture.repository, { id: "later" });
  assert.throws(() => build(fixture.repository), /no auditable evidence edges/u);
  fixture.database.close();
});

test("stops when a current-state evidence memory is absent from the current ledger", () => {
  const fixture = setup({ withCurrent: true });
  addObservation(fixture.repository, { id: "later" });
  const untracked = addObservation(fixture.repository, {
    id: "untracked",
    stateFamily: "capability",
    canonicalKey: "user:capability:careful-work",
  });
  fixture.repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: fixture.current.id,
    toMemoryId: untracked.memory.id,
    relation: "challenged_by",
    direction: "directed",
    weight: 0.8,
    confidence: 0.9,
    provenance: "test",
  });
  assert.throws(() => build(fixture.repository), /ledger is incomplete/u);
  fixture.database.close();
});

test("returns a clean skip when the fixed target has no current observations", () => {
  const fixture = setup();
  const result = build(fixture.repository);
  assert.deepEqual(result, { status: "skipped", reason: "no-current-state-evidence", snapshot: null });
  fixture.database.close();
});

test("treats only explicitly selected request observations as a virtual explicit lane", () => {
  const fixture = setup();
  const selected = addObservation(fixture.repository, {
    id: "request-selected",
    memoryKind: "utterance",
    evidenceMode: "imported",
    scope: { currentRepresentationLayer: "reported" },
  });
  const unselected = addObservation(fixture.repository, {
    id: "request-unselected",
    memoryKind: "utterance",
    evidenceMode: "imported",
    scope: { currentRepresentationLayer: "reported" },
  });
  const request = fixture.repository.recordStateAnalysisRequest({
    agentId: "agent-test",
    batchId: "request-bound-value",
    candidateIndex: 0,
    stateFamily: "value",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    targetLabel: "认真对待重要工作",
    representationLayer: "reported",
    evidenceMode: "explicit",
    memoryIds: [selected.memory.id],
    sourceIds: [selected.source.id],
    createdAt: "2026-07-10T13:00:00.000Z",
  });
  const result = build(fixture.repository, {
    currentRepresentationLayer: "reported",
    analysisRequestId: request.id,
    analysisRequestObservationIds: [selected.observation.id],
  });
  const selectedView = result.snapshot.observations.find((item) => item.id === selected.observation.id);
  const unselectedView = result.snapshot.observations.find((item) => item.id === unselected.observation.id);
  assert.equal(selectedView.memory.storedEvidenceMode, "imported");
  assert.equal(selectedView.memory.evidenceMode, "explicit");
  assert.equal(selectedView.memory.requestBoundExplicit, true);
  assert.equal(unselectedView.memory.evidenceMode, "imported");
  assert.equal(unselectedView.memory.requestBoundExplicit, false);
  assert.equal(fixture.repository.getMemory(selected.memory.id).evidence_mode, "imported");
  fixture.database.close();
});
