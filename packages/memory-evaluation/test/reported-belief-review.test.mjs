import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryRepository,
  openMemoryDatabase,
  resolveReportedStateProposal,
} from "@suzu-lives/memory-core";
import {
  proposeReportedStateFromReview,
  reviewReportedBeliefState,
} from "../src/index.mjs";

const KEY = "user:belief:xiaowang:personality";

function setup({ withCurrent = false } = {}) {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  let current = null;
  if (withCurrent) {
    current = repository.upsertMemory({
      id: "current-belief",
      agentId: "agent-test",
      kind: "belief_state",
      layer: "semantic",
      content: "用户认为小王做事很自私。",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: KEY,
      reality: "real",
      evidenceMode: "explicit",
      representationLayer: "reported",
      stateFamily: "belief",
      statePhase: "active",
      temporalState: "current",
      knownAt: "2026-07-01T08:00:00.000Z",
      validFrom: "2026-07-01T08:00:00.000Z",
    });
  }
  return { database, repository, current };
}

function addBeliefObservation(repository, {
  id,
  claimText,
  observedAt,
  currentStatePresent = false,
  relation = "no_current_state",
  scopeOverlap = "none",
  revisionCue = "none",
  qualification = "qualified",
  excludedReason = "",
  evidenceMode = "explicit",
  currentRepresentationLayer = "reported",
} = {}) {
  const source = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: `source-${id}`,
    occurredAt: observedAt,
    knownAt: observedAt,
    speaker: "User",
    content: claimText,
  });
  const memory = repository.upsertMemory({
    id: `memory-${id}`,
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: `用户表达了对小王的判断：${claimText}`,
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    evidenceMode,
    temporalState: "historical",
    eventStart: observedAt,
    knownAt: observedAt,
    actorRoles: [
      { role: "speaker", actorRole: "user", actorKey: "user", isPrimary: true },
      { role: "participant", actorRole: "other", actorKey: "person:xiaowang" },
    ],
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
    stateFamily: "belief",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    memoryId: memory.id,
    evidenceGroupId: `event:${id}`,
    contextId: "context:xiaowang",
    signal: "belief_assertion",
    claimedDirection: relation === "no_current_state" || ["equivalent", "supports"].includes(relation)
      ? "support" : "opposition",
    effectiveDirection: qualification === "qualified"
      ? (relation === "no_current_state" || ["equivalent", "supports"].includes(relation) ? "support" : "opposition")
      : "neutral",
    qualification,
    confidence: 0.9,
    origin: "deterministic",
    scope: { topicLabel: "对小王性格的判断", scopeOverlap, currentRepresentationLayer },
    payloadSchemaVersion: "belief-merged-evidence-v1",
    payload: {
      proposition: {
        targetMatch: "exact",
        claimText,
        stance: "asserts",
        claimKind: "opinion",
        quantifier: "specific",
      },
      holder: { holderMatch: "yes", attribution: "explicit_self_statement" },
      time: { stateTime: "current", revisionCue, timeReference: "" },
      relation: { currentStatePresent, relation, scopeOverlap },
    },
    excludedReason,
    sourceIds: [source.id],
    observedAt,
  });
  return { memory, source, observation };
}

function review(repository, overrides = {}) {
  return reviewReportedBeliefState({
    repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    subjectLabel: "用户",
    topicLabel: "对小王性格的判断",
    objectRole: "other",
    objectKey: "person:xiaowang",
    objectLabel: "小王",
    ...overrides,
  });
}

test("creates only a reported holder belief and never a target personality fact", () => {
  const fixture = setup();
  const evidence = addBeliefObservation(fixture.repository, {
    id: "direct-judgment",
    claimText: "我觉得小王做事很自私。",
    observedAt: "2026-07-10T12:00:00.000Z",
  });
  const before = Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const result = review(fixture.repository);
  assert.equal(result.status, "ready");
  assert.equal(result.action, "create");
  assert.equal(result.proposedState.subjectRole, "user");
  assert.equal(result.proposedState.subjectKey, "user");
  assert.deepEqual(result.proposedState.propositionTarget, {
    role: "other",
    key: "person:xiaowang",
    label: "小王",
  });
  assert.equal(result.proposedState.proposition.truthStatus, "unverified");
  assert.deepEqual(result.proposedState.evidenceObservationIds, [evidence.observation.id]);
  assert.equal(result.automaticTargetFactWriteAllowed, false);
  assert.equal(result.automaticTargetDispositionWriteAllowed, false);
  assert.equal(Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count), before);
  fixture.database.close();
});

test("bridges a ready reported belief into one pending proposal without writing the state", () => {
  const fixture = setup();
  addBeliefObservation(fixture.repository, {
    id: "proposal-ready",
    claimText: "我觉得小王做事很自私。",
    observedAt: "2026-07-10T12:00:00.000Z",
  });
  const reviewResult = review(fixture.repository);
  const before = Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const first = proposeReportedStateFromReview({
    repository: fixture.repository,
    reviewResult,
    reviewVersion: "reported-belief-review-v1",
    batchId: "reported-belief-batch",
  });
  const replay = proposeReportedStateFromReview({
    repository: fixture.repository,
    reviewResult,
    reviewVersion: "reported-belief-review-v1",
    batchId: "later-scheduler-retry",
  });
  assert.equal(first.status, "pending");
  assert.equal(first.proposal.wasInserted, true);
  assert.equal(first.proposal.review_state, "pending");
  assert.equal(first.proposal.state_family, "belief");
  assert.equal(first.proposal.representation_layer, "reported");
  assert.equal(replay.proposal.wasInserted, false);
  assert.equal(replay.proposal.id, first.proposal.id);
  assert.equal(Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count), before);
  fixture.database.close();
});

test("rejects a ready review whose result or snapshot crosses representation layers", () => {
  const fixture = setup();
  addBeliefObservation(fixture.repository, {
    id: "proposal-cross-layer",
    claimText: "我觉得小王做事很自私。",
    observedAt: "2026-07-10T12:00:00.000Z",
  });
  const reviewResult = review(fixture.repository);
  assert.throws(() => proposeReportedStateFromReview({
    repository: fixture.repository,
    reviewResult: { ...reviewResult, representationLayer: "established" },
    reviewVersion: "reported-belief-review-v1",
  }), /target, layer, or action is invalid/u);
  assert.throws(() => proposeReportedStateFromReview({
    repository: fixture.repository,
    reviewResult: {
      ...reviewResult,
      snapshot: {
        ...reviewResult.snapshot,
        target: {
          ...reviewResult.snapshot.target,
          currentRepresentationLayer: "established",
        },
      },
    },
    reviewVersion: "reported-belief-review-v1",
  }), /target, layer, or action is invalid/u);
  assert.equal(fixture.repository.listReportedStateProposals("agent-test").length, 0);
  fixture.database.close();
});

test("accepts an end-to-end reported belief review only after the explicit human action", () => {
  const fixture = setup();
  addBeliefObservation(fixture.repository, {
    id: "proposal-end-to-end",
    claimText: "我觉得小王做事很自私。",
    observedAt: "2026-07-10T12:00:00.000Z",
  });
  const reviewResult = review(fixture.repository);
  const queued = proposeReportedStateFromReview({
    repository: fixture.repository,
    reviewResult,
    reviewVersion: "reported-belief-review-v1",
    batchId: "reported-belief-end-to-end",
  });
  assert.equal(fixture.repository.getCurrentCanonicalMemory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    representationLayer: "reported",
    stateFamily: "belief",
  }), null);
  const accepted = resolveReportedStateProposal(fixture.repository, {
    agentId: "agent-test",
    proposalId: queued.proposal.id,
    action: "accept",
    resolvedBy: "human:test",
  });
  assert.equal(accepted.status, "created");
  assert.equal(accepted.proposal.review_state, "accepted");
  assert.equal(accepted.memory.kind, "belief_state");
  assert.equal(accepted.memory.state_family, "belief");
  assert.equal(accepted.memory.representation_layer, "reported");
  assert.equal(accepted.memory.metadata.reportedStateDraft.proposition.truthStatus, "unverified");
  assert.equal(fixture.repository.getCurrentCanonicalMemory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    representationLayer: "reported",
    stateFamily: "belief",
  }).id, accepted.memory.id);
  fixture.database.close();
});

test("does not enqueue skipped reported-state reviews", () => {
  const fixture = setup();
  const result = proposeReportedStateFromReview({
    repository: fixture.repository,
    reviewResult: {
      status: "skipped",
      reason: "no-current-state-evidence",
    },
    reviewVersion: "reported-belief-review-v1",
  });
  assert.equal(result.status, "skipped");
  assert.equal(result.proposal, null);
  assert.equal(fixture.repository.listReportedStateProposals("agent-test").length, 0);
  fixture.database.close();
});

test("does not create a reported state from inferred or non-explicit evidence", () => {
  const fixture = setup();
  addBeliefObservation(fixture.repository, {
    id: "inferred",
    claimText: "模型推测用户觉得小王自私。",
    observedAt: "2026-07-10T12:00:00.000Z",
    evidenceMode: "inferred",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "no-qualified-direct-current-belief");
  fixture.database.close();
});

test("holds multiple unresolved direct judgments instead of choosing the newest one", () => {
  const fixture = setup();
  addBeliefObservation(fixture.repository, {
    id: "first",
    claimText: "我觉得小王做事很自私。",
    observedAt: "2026-07-10T12:00:00.000Z",
  });
  addBeliefObservation(fixture.repository, {
    id: "second",
    claimText: "我觉得小王其实很体贴。",
    observedAt: "2026-07-11T12:00:00.000Z",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "multiple-unresolved-direct-beliefs-without-change-cue");
  assert.equal(result.proposedState, null);
  fixture.database.close();
});

test("uses an explicit later change cue for the reported current belief", () => {
  const fixture = setup();
  addBeliefObservation(fixture.repository, {
    id: "old",
    claimText: "我觉得小王做事很自私。",
    observedAt: "2026-07-10T12:00:00.000Z",
  });
  addBeliefObservation(fixture.repository, {
    id: "changed",
    claimText: "后来发现小王其实很体贴。",
    observedAt: "2026-07-11T12:00:00.000Z",
    revisionCue: "changed_mind",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "ready");
  assert.equal(result.action, "create");
  assert.equal(result.selectedObservationId, "observation-changed");
  assert.equal(result.proposedState.proposition.text, "后来发现小王其实很体贴。");
  fixture.database.close();
});

test("reinforces the holder belief without changing the judged person's state", () => {
  const fixture = setup({ withCurrent: true });
  fixture.repository.upsertMemory({
    id: "established-belief-about-xiaowang",
    agentId: "agent-test",
    kind: "derived_hypothesis",
    layer: "semantic",
    content: "多条独立表达支持用户持续持有这一判断。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    reality: "real",
    evidenceMode: "inferred",
    representationLayer: "established",
    temporalState: "current",
    knownAt: "2026-07-20T08:00:00.000Z",
    validFrom: "2026-07-20T08:00:00.000Z",
  });
  const evidence = addBeliefObservation(fixture.repository, {
    id: "support",
    claimText: "我还是觉得小王做事很自私。",
    observedAt: "2026-07-10T12:00:00.000Z",
    currentStatePresent: true,
    relation: "supports",
    scopeOverlap: "exact",
  });
  fixture.repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: fixture.current.id,
    toMemoryId: evidence.memory.id,
    relation: "supported_by",
    direction: "directed",
    weight: 0.9,
    confidence: 0.9,
    provenance: "test",
  });
  const result = review(fixture.repository);
  assert.equal(result.action, "reinforce");
  assert.equal(result.currentStateId, fixture.current.id);
  assert.equal(result.snapshot.target.currentRepresentationLayer, "reported");
  assert.equal(fixture.repository.getMemory(fixture.current.id).status, "active");
  assert.equal(result.automaticTargetDispositionWriteAllowed, false);
  fixture.database.close();
});

test("previews a later explicit change without closing the current belief", () => {
  const fixture = setup({ withCurrent: true });
  const evidence = addBeliefObservation(fixture.repository, {
    id: "changed-current",
    claimText: "我现在觉得小王其实很体贴。",
    observedAt: "2026-07-10T12:00:00.000Z",
    currentStatePresent: true,
    relation: "same_scope_conflict",
    scopeOverlap: "exact",
    revisionCue: "changed_mind",
  });
  fixture.repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: fixture.current.id,
    toMemoryId: evidence.memory.id,
    relation: "challenged_by",
    direction: "directed",
    weight: 0.9,
    confidence: 0.9,
    provenance: "test",
  });
  const result = review(fixture.repository);
  assert.equal(result.action, "supersede");
  assert.equal(result.proposedState.proposition.text, "我现在觉得小王其实很体贴。");
  assert.equal(fixture.repository.getMemory(fixture.current.id).status, "active");
  fixture.database.close();
});

test("keeps a same-scope contradiction without a change cue in review", () => {
  const fixture = setup({ withCurrent: true });
  const evidence = addBeliefObservation(fixture.repository, {
    id: "conflict",
    claimText: "小王其实很体贴。",
    observedAt: "2026-07-10T12:00:00.000Z",
    currentStatePresent: true,
    relation: "same_scope_conflict",
    scopeOverlap: "exact",
  });
  fixture.repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: fixture.current.id,
    toMemoryId: evidence.memory.id,
    relation: "challenged_by",
    direction: "directed",
    weight: 0.9,
    confidence: 0.9,
    provenance: "test",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "review_required");
  assert.equal(result.proposedState, null);
  fixture.database.close();
});

test("rejects belief evidence whose current-state comparison targeted another representation layer", () => {
  const fixture = setup();
  addBeliefObservation(fixture.repository, {
    id: "established-layer-comparison",
    claimText: "我觉得小王做事很自私。",
    observedAt: "2026-07-10T12:00:00.000Z",
    currentRepresentationLayer: "established",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "no-qualified-direct-current-belief");
  fixture.database.close();
});
