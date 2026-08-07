import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  MemoryRepository,
  openMemoryDatabase,
  resolveReportedStateProposal,
  stateScopeKeyFromScope,
} from "../src/index.mjs";

const TARGET = "user:belief:rain";

function setup() {
  const database = openMemoryDatabase(":memory:");
  return { database, repository: new MemoryRepository(database) };
}

function addReportedBeliefObservation(repository, {
  id = "belief-observation-1",
  comparisonLayer = "reported",
  stateFamily = "belief",
  canonicalKey = TARGET,
  sourceContent = "我觉得雨天很安静。",
  content = "用户明确说自己觉得雨天很安静。",
  occurredAt = "2026-08-02T08:00:00.000Z",
  signal = "explicit_belief",
} = {}) {
  const source = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: `source-${id}`,
    occurredAt,
    speaker: "User",
    content: sourceContent,
  });
  const memory = repository.upsertMemory({
    id: `memory-${id}`,
    agentId: "agent-test",
    kind: "utterance",
    layer: "episodic",
    content,
    subjectRole: "user",
    subjectKey: "user",
    evidenceMode: "explicit",
    temporalState: "historical",
    knownAt: occurredAt,
  });
  repository.linkSource(memory.id, source.id, "evidence", {
    authority: "subject_firsthand",
    sourceTrust: 1,
    evidenceStrength: 1,
    provenance: "test",
  });
  const run = repository.recordStateAnalysisRun({
    id: `run-${id}`,
    agentId: "agent-test",
    stateFamily,
    analyzerRole: `${stateFamily}-holder`,
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey,
    promptVersion: `reported-${stateFamily}-v1`,
    schemaVersion: `reported-${stateFamily}-schema-v1`,
    inputHash: createHash("sha256").update(id).digest("hex"),
    status: "completed",
    memoryIds: [memory.id],
    sourceIds: [source.id],
    output: { claim: sourceContent },
  });
  return repository.recordStateEvidenceObservation({
    id,
    agentId: "agent-test",
    stateFamily,
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey,
    memoryId: memory.id,
    evidenceGroupId: `group-${id}`,
    signal,
    claimedDirection: "support",
    effectiveDirection: "support",
    qualification: "qualified",
    confidence: 0.95,
    origin: "llm",
    scope: { currentRepresentationLayer: comparisonLayer },
    payloadSchemaVersion: `reported-${stateFamily}-observation-v1`,
    payload: { claimText: sourceContent },
    sourceIds: [source.id],
    analysisRunIds: [run.id],
  });
}

function beliefDraft(observation = null, {
  claimText = "我觉得雨天很安静。",
  validFrom = "2026-08-02T08:00:00.000Z",
} = {}) {
  const observationId = observation?.id || "belief-observation-1";
  const memoryId = observation?.memory_id || observation?.memoryId || "memory-belief-observation-1";
  const sourceIds = observation?.sourceIds || ["source-belief-observation-1"];
  return {
    kind: "belief_state",
    stateFamily: "belief",
    representationLayer: "reported",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    temporalState: "current",
    statePhase: "active",
    validFrom,
    proposition: { text: claimText, truthStatus: "unverified" },
    evidenceObservationIds: [observationId],
    evidenceMemoryIds: [memoryId],
    evidenceSourceIds: [...sourceIds],
  };
}

test("keeps a reported review result pending and idempotent without writing formal memory", () => {
  const { database, repository } = setup();
  const observation = addReportedBeliefObservation(repository);
  const beforeNodes = Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const input = {
    agentId: "agent-test",
    batchId: "belief-review-batch",
    stateFamily: "belief",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    action: "create",
    proposedState: beliefDraft(),
    reviewVersion: "reported-belief-review-v1",
    inputHash: createHash("sha256").update("review-input").digest("hex"),
    selectedObservationId: observation.id,
    consideredObservationIds: [observation.id],
  };
  const first = repository.recordReportedStateProposal(input);
  const replay = repository.recordReportedStateProposal({
    ...input,
    id: "ignored-replay-id",
    batchId: "later-scheduler-retry",
  });

  assert.equal(first.wasInserted, true);
  assert.equal(replay.wasInserted, false);
  assert.equal(replay.id, first.id);
  assert.equal(replay.batch_id, "belief-review-batch");
  assert.equal(first.review_state, "pending");
  assert.equal(first.state_family, "belief");
  assert.equal(first.proposed_kind, "belief_state");
  assert.equal(first.selectedObservationId, observation.id);
  assert.deepEqual(first.consideredObservationIds, [observation.id]);
  assert.equal(repository.listReportedStateProposals("agent-test", {
    reviewStates: ["pending"],
    stateFamily: "belief",
  }).length, 1);
  assert.equal(
    Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    beforeNodes,
  );

  const dismissed = repository.dismissReportedStateProposal({
    agentId: "agent-test",
    proposalId: first.id,
    resolvedBy: "tester",
    note: "not-current-anymore",
  });
  assert.equal(dismissed.review_state, "dismissed");
  assert.equal(dismissed.resultMemoryId, "");
  assert.equal(repository.listReportedStateProposals("agent-test", {
    reviewStates: ["pending"],
  }).length, 0);
  assert.throws(() => repository.dismissReportedStateProposal({
    agentId: "agent-test",
    proposalId: first.id,
  }), /already dismissed/u);
  database.close();
});

test("rejects cross-layer evidence, family-kind mismatch, and stale current state", () => {
  const { database, repository } = setup();
  const wrongLayer = addReportedBeliefObservation(repository, {
    id: "wrong-layer-observation",
    comparisonLayer: "established",
  });
  const base = {
    agentId: "agent-test",
    stateFamily: "belief",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    action: "create",
    proposedState: beliefDraft(),
    reviewVersion: "reported-belief-review-v1",
    inputHash: createHash("sha256").update("wrong-layer").digest("hex"),
    selectedObservationId: wrongLayer.id,
    consideredObservationIds: [wrongLayer.id],
  };
  assert.throws(() => repository.recordReportedStateProposal(base), /outside the reviewed target or layer/u);
  assert.throws(() => repository.recordReportedStateProposal({
    ...base,
    proposedState: { ...beliefDraft(), kind: "fact" },
  }), /draft kind is invalid/u);
  assert.throws(() => repository.recordReportedStateProposal({
    ...base,
    action: "complete",
    previousMemoryId: "not-a-belief-action",
    proposedState: null,
  }), /action is invalid for its state family/u);

  repository.upsertMemory({
    id: "current-belief",
    agentId: "agent-test",
    kind: "belief_state",
    layer: "semantic",
    content: "用户报告自己觉得雨天很安静。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    representationLayer: "reported",
    stateFamily: "belief",
    statePhase: "active",
    temporalState: "current",
    evidenceMode: "explicit",
  });
  assert.throws(() => repository.recordReportedStateProposal(base), /changed after review/u);
  database.close();
});

test("accepts create, reinforce, and supersede as three distinct reported-state actions", () => {
  const { database, repository } = setup();
  const initialObservation = addReportedBeliefObservation(repository, {
    id: "initial-rain-belief",
    occurredAt: "2026-08-02T08:00:00.000Z",
  });
  const initialProposal = repository.recordReportedStateProposal({
    agentId: "agent-test",
    batchId: "initial-review",
    stateFamily: "belief",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    action: "create",
    proposedState: beliefDraft(initialObservation),
    reviewVersion: "reported-belief-review-v1",
    inputHash: createHash("sha256").update("initial-review").digest("hex"),
    selectedObservationId: initialObservation.id,
    consideredObservationIds: [initialObservation.id],
    metadata: { target: { stateLabel: "对雨天的看法" } },
  });
  const created = resolveReportedStateProposal(repository, {
    agentId: "agent-test",
    proposalId: initialProposal.id,
    action: "accept",
    resolvedBy: "tester",
  });
  assert.equal(created.status, "created");
  assert.equal(created.memory.content, "用户明确说自己觉得雨天很安静。");
  assert.equal(created.memory.state_family, "belief");
  assert.equal(created.memory.representation_layer, "reported");
  assert.equal(created.memory.metadata.reportedStateDraft.proposition.text, "我觉得雨天很安静。");
  assert.equal(repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: created.memory.id,
    toMemoryId: initialObservation.memory_id,
    relation: "supported_by",
  }).relation, "supported_by");

  const reinforcement = addReportedBeliefObservation(repository, {
    id: "reinforce-rain-belief",
    sourceContent: "我还是觉得雨天很安静。",
    content: "用户再次明确表示自己觉得雨天很安静。",
    occurredAt: "2026-08-03T08:00:00.000Z",
  });
  const reinforceProposal = repository.recordReportedStateProposal({
    agentId: "agent-test",
    stateFamily: "belief",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    action: "reinforce",
    previousMemoryId: created.memory.id,
    proposedState: beliefDraft(reinforcement, {
      claimText: "我还是觉得雨天很安静。",
      validFrom: "2026-08-03T08:00:00.000Z",
    }),
    reviewVersion: "reported-belief-review-v1",
    inputHash: createHash("sha256").update("reinforcement").digest("hex"),
    selectedObservationId: reinforcement.id,
    consideredObservationIds: [reinforcement.id],
  });
  const reinforced = resolveReportedStateProposal(repository, {
    agentId: "agent-test",
    proposalId: reinforceProposal.id,
    action: "accept",
  });
  assert.equal(reinforced.status, "reinforced");
  assert.equal(reinforced.memory.id, created.memory.id);
  assert.equal(repository.listCanonicalStateHistory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    representationLayer: "reported",
    stateFamily: "belief",
  }).length, 1);

  const changedObservation = addReportedBeliefObservation(repository, {
    id: "changed-rain-belief",
    sourceContent: "我现在觉得雨天让人烦躁。",
    content: "用户明确表示自己现在觉得雨天让人烦躁。",
    occurredAt: "2026-08-04T08:00:00.000Z",
  });
  const changedProposal = repository.recordReportedStateProposal({
    agentId: "agent-test",
    stateFamily: "belief",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    action: "supersede",
    previousMemoryId: created.memory.id,
    proposedState: beliefDraft(changedObservation, {
      claimText: "我现在觉得雨天让人烦躁。",
      validFrom: "2026-08-04T08:00:00.000Z",
    }),
    reviewVersion: "reported-belief-review-v1",
    inputHash: createHash("sha256").update("changed-review").digest("hex"),
    selectedObservationId: changedObservation.id,
    consideredObservationIds: [changedObservation.id],
  });
  const changed = resolveReportedStateProposal(repository, {
    agentId: "agent-test",
    proposalId: changedProposal.id,
    action: "accept",
  });
  assert.equal(changed.status, "supersede");
  assert.notEqual(changed.memory.id, created.memory.id);
  assert.equal(repository.getMemory(created.memory.id).status, "superseded");
  assert.equal(repository.getCurrentCanonicalMemory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    representationLayer: "reported",
    stateFamily: "belief",
  }).id, changed.memory.id);
  assert.equal(repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: changed.memory.id,
    toMemoryId: created.memory.id,
    relation: "supersedes",
  }).metadata.transition, "supersede");
  database.close();
});

test("accepts terminal evidence without manufacturing a replacement statement", () => {
  const { database, repository } = setup();
  const key = "user:goal:publish-memory-system";
  const current = repository.upsertMemory({
    id: "current-publish-goal",
    agentId: "agent-test",
    kind: "plan",
    layer: "prospective",
    content: "用户计划发布记忆系统。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: key,
    representationLayer: "reported",
    stateFamily: "goal",
    statePhase: "active",
    temporalState: "in_progress",
    evidenceMode: "explicit",
    knownAt: "2026-08-01T08:00:00.000Z",
    validFrom: "2026-08-01T08:00:00.000Z",
  });
  const completion = addReportedBeliefObservation(repository, {
    id: "publish-completed",
    stateFamily: "goal",
    canonicalKey: key,
    sourceContent: "我已经把记忆系统发布了。",
    content: "用户明确报告自己已经发布记忆系统。",
    occurredAt: "2026-08-05T08:00:00.000Z",
    signal: "goal_completion",
  });
  const proposal = repository.recordReportedStateProposal({
    agentId: "agent-test",
    stateFamily: "goal",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: key,
    action: "complete",
    previousMemoryId: current.id,
    proposedState: null,
    reviewVersion: "reported-goal-review-v1",
    inputHash: createHash("sha256").update("goal-completion").digest("hex"),
    selectedObservationId: completion.id,
    consideredObservationIds: [completion.id],
  });
  const accepted = resolveReportedStateProposal(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    action: "accept",
  });
  assert.equal(accepted.status, "complete");
  assert.equal(accepted.memory.id, current.id);
  assert.equal(accepted.memory.content, "用户计划发布记忆系统。");
  assert.equal(accepted.memory.status, "superseded");
  assert.equal(accepted.memory.state_phase, "completed");
  assert.equal(accepted.memory.temporal_state, "completed");
  assert.equal(repository.getCurrentCanonicalMemory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: key,
    representationLayer: "reported",
    stateFamily: "goal",
  }), null);
  assert.equal(repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: current.id,
    toMemoryId: completion.memory_id,
    relation: "supported_by",
  }).relation, "supported_by");
  database.close();
});

test("marks a corrected attribution disputed and accepts scoped exceptions without replacing the root", () => {
  const correctedFixture = setup();
  const current = correctedFixture.repository.upsertMemory({
    id: "misattributed-belief",
    agentId: "agent-test",
    kind: "belief_state",
    layer: "semantic",
    content: "用户据称觉得雨天很安静。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    representationLayer: "reported",
    stateFamily: "belief",
    statePhase: "active",
    temporalState: "current",
    evidenceMode: "explicit",
    knownAt: "2026-08-01T08:00:00.000Z",
    validFrom: "2026-08-01T08:00:00.000Z",
  });
  const denial = addReportedBeliefObservation(correctedFixture.repository, {
    id: "deny-rain-belief",
    sourceContent: "我从来没说过我觉得雨天很安静。",
    content: "用户明确否认自己曾持有该雨天观念。",
    occurredAt: "2026-08-05T08:00:00.000Z",
    signal: "denies_prior_holding",
  });
  const correction = correctedFixture.repository.recordReportedStateProposal({
    agentId: "agent-test",
    stateFamily: "belief",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    action: "correct_attribution",
    previousMemoryId: current.id,
    proposedState: null,
    reviewVersion: "reported-belief-review-v1",
    inputHash: createHash("sha256").update("correction-review").digest("hex"),
    selectedObservationId: denial.id,
    consideredObservationIds: [denial.id],
  });
  const corrected = resolveReportedStateProposal(correctedFixture.repository, {
    agentId: "agent-test",
    proposalId: correction.id,
    action: "accept",
  });
  assert.equal(corrected.status, "attribution-corrected");
  assert.equal(corrected.memory.status, "disputed");
  assert.equal(corrected.memory.state_phase, "retired");
  assert.equal(correctedFixture.repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: current.id,
    toMemoryId: denial.memory_id,
    relation: "challenged_by",
  }).relation, "challenged_by");
  correctedFixture.database.close();

  const scopedFixture = setup();
  const preferenceKey = "user:preference:fish";
  const broad = scopedFixture.repository.upsertMemory({
    id: "broad-fish-preference",
    agentId: "agent-test",
    kind: "preference",
    layer: "semantic",
    content: "用户报告自己喜欢鱼类食物。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: preferenceKey,
    representationLayer: "reported",
    stateFamily: "preference",
    statePhase: "active",
    temporalState: "current",
    evidenceMode: "explicit",
    knownAt: "2026-08-01T08:00:00.000Z",
    validFrom: "2026-08-01T08:00:00.000Z",
  });
  const exception = addReportedBeliefObservation(scopedFixture.repository, {
    id: "raw-fish-exception",
    stateFamily: "preference",
    canonicalKey: preferenceKey,
    sourceContent: "我喜欢鱼，但不喜欢生鱼。",
    content: "用户报告自己喜欢鱼类食物，但不喜欢生鱼。",
    occurredAt: "2026-08-05T08:00:00.000Z",
    signal: "explicit_preference",
  });
  const exceptionDraft = {
    kind: "preference",
    stateFamily: "preference",
    representationLayer: "reported",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: preferenceKey,
    temporalState: "current",
    statePhase: "active",
    validFrom: "2026-08-05T08:00:00.000Z",
    preferenceClaim: {
      objectLabel: "生鱼",
      polarity: "negative",
      scope: { kind: "subcategory", label: "生鱼", context: "" },
    },
    evidenceObservationIds: [exception.id],
    evidenceMemoryIds: [exception.memory_id],
    evidenceSourceIds: [...exception.sourceIds],
  };
  const exceptionProposal = scopedFixture.repository.recordReportedStateProposal({
    agentId: "agent-test",
    stateFamily: "preference",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: preferenceKey,
    action: "add_scoped_exception",
    previousMemoryId: broad.id,
    proposedState: exceptionDraft,
    reviewVersion: "reported-preference-review-v1",
    inputHash: createHash("sha256").update("scoped-exception").digest("hex"),
    selectedObservationId: exception.id,
    consideredObservationIds: [exception.id],
  });
  const acceptedException = resolveReportedStateProposal(scopedFixture.repository, {
    agentId: "agent-test",
    proposalId: exceptionProposal.id,
    action: "accept",
  });
  const exceptionScopeKey = stateScopeKeyFromScope({
    kind: "subcategory",
    label: "生鱼",
    context: "",
  });
  assert.equal(acceptedException.status, "scoped-exception-added");
  assert.equal(acceptedException.memory.state_scope_key, exceptionScopeKey);
  assert.equal(scopedFixture.repository.getReportedStateProposal(
    "agent-test",
    exceptionProposal.id,
  ).review_state, "accepted");
  assert.equal(scopedFixture.repository.getMemory(broad.id).status, "active");
  assert.equal(scopedFixture.repository.getCurrentCanonicalMemory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: preferenceKey,
    representationLayer: "reported",
    stateFamily: "preference",
  }).id, broad.id);
  assert.equal(scopedFixture.repository.getCurrentCanonicalMemory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: preferenceKey,
    representationLayer: "reported",
    stateFamily: "preference",
    stateScopeKey: exceptionScopeKey,
  }).id, acceptedException.memory.id);
  assert.equal(scopedFixture.repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: acceptedException.memory.id,
    toMemoryId: broad.id,
    relation: "scoped_exception_to",
  }).relation, "scoped_exception_to");

  const duplicateEvidence = addReportedBeliefObservation(scopedFixture.repository, {
    id: "raw-fish-exception-repeat",
    stateFamily: "preference",
    canonicalKey: preferenceKey,
    sourceContent: "我还是不喜欢生鱼。",
    content: "用户再次报告自己不喜欢生鱼。",
    occurredAt: "2026-08-06T08:00:00.000Z",
    signal: "explicit_preference",
  });
  const duplicateProposal = scopedFixture.repository.recordReportedStateProposal({
    agentId: "agent-test",
    stateFamily: "preference",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: preferenceKey,
    action: "add_scoped_exception",
    previousMemoryId: broad.id,
    proposedState: {
      ...exceptionDraft,
      validFrom: "2026-08-06T08:00:00.000Z",
      evidenceObservationIds: [duplicateEvidence.id],
      evidenceMemoryIds: [duplicateEvidence.memory_id],
      evidenceSourceIds: [...duplicateEvidence.sourceIds],
    },
    reviewVersion: "reported-preference-review-v1",
    inputHash: createHash("sha256").update("scoped-exception-repeat").digest("hex"),
    selectedObservationId: duplicateEvidence.id,
    consideredObservationIds: [duplicateEvidence.id],
  });
  assert.throws(() => resolveReportedStateProposal(scopedFixture.repository, {
    agentId: "agent-test",
    proposalId: duplicateProposal.id,
    action: "accept",
  }), /scope already has a current exception/u);
  assert.equal(scopedFixture.repository.getReportedStateProposal(
    "agent-test",
    duplicateProposal.id,
  ).review_state, "pending");

  const rootChangeEvidence = addReportedBeliefObservation(scopedFixture.repository, {
    id: "fish-root-change",
    stateFamily: "preference",
    canonicalKey: preferenceKey,
    sourceContent: "我现在不喜欢鱼了。",
    content: "用户报告自己现在不喜欢鱼类食物。",
    occurredAt: "2026-08-07T08:00:00.000Z",
    signal: "explicit_preference_change",
  });
  const rootChangeProposal = scopedFixture.repository.recordReportedStateProposal({
    agentId: "agent-test",
    stateFamily: "preference",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: preferenceKey,
    action: "supersede",
    previousMemoryId: broad.id,
    proposedState: {
      kind: "preference",
      stateFamily: "preference",
      representationLayer: "reported",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: preferenceKey,
      temporalState: "current",
      statePhase: "active",
      validFrom: "2026-08-07T08:00:00.000Z",
      preferenceClaim: {
        objectLabel: "鱼类食物",
        polarity: "negative",
        scope: { kind: "category", label: "鱼类食物" },
      },
      evidenceObservationIds: [rootChangeEvidence.id],
      evidenceMemoryIds: [rootChangeEvidence.memory_id],
      evidenceSourceIds: [...rootChangeEvidence.sourceIds],
    },
    reviewVersion: "reported-preference-review-v1",
    inputHash: createHash("sha256").update("fish-root-change").digest("hex"),
    selectedObservationId: rootChangeEvidence.id,
    consideredObservationIds: [rootChangeEvidence.id],
  });
  assert.throws(() => resolveReportedStateProposal(scopedFixture.repository, {
    agentId: "agent-test",
    proposalId: rootChangeProposal.id,
    action: "accept",
  }), /requires explicit scope reconciliation/u);
  assert.equal(scopedFixture.repository.getMemory(broad.id).status, "active");
  assert.equal(scopedFixture.repository.getReportedStateProposal(
    "agent-test",
    rootChangeProposal.id,
  ).review_state, "pending");
  scopedFixture.database.close();
});

test("rolls back a failed reported-state acceptance without resolving the proposal", () => {
  const { database, repository } = setup();
  const current = repository.upsertMemory({
    id: "newer-current-belief",
    agentId: "agent-test",
    kind: "belief_state",
    layer: "semantic",
    content: "用户当前觉得雨天很安静。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    representationLayer: "reported",
    stateFamily: "belief",
    statePhase: "active",
    temporalState: "current",
    evidenceMode: "explicit",
    knownAt: "2026-08-05T08:00:00.000Z",
    validFrom: "2026-08-05T08:00:00.000Z",
  });
  const olderChange = addReportedBeliefObservation(repository, {
    id: "older-state-change",
    sourceContent: "我现在觉得雨天很烦。",
    content: "用户表示自己觉得雨天很烦。",
    occurredAt: "2026-08-04T08:00:00.000Z",
  });
  const proposal = repository.recordReportedStateProposal({
    agentId: "agent-test",
    stateFamily: "belief",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    action: "supersede",
    previousMemoryId: current.id,
    proposedState: beliefDraft(olderChange, {
      claimText: "我现在觉得雨天很烦。",
      validFrom: "2026-08-04T08:00:00.000Z",
    }),
    reviewVersion: "reported-belief-review-v1",
    inputHash: createHash("sha256").update("older-change").digest("hex"),
    selectedObservationId: olderChange.id,
    consideredObservationIds: [olderChange.id],
  });
  const before = {
    nodes: Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    sources: Number(database.prepare("SELECT COUNT(*) AS count FROM memory_sources").get().count),
    edges: Number(database.prepare("SELECT COUNT(*) AS count FROM memory_edges").get().count),
  };
  assert.throws(() => resolveReportedStateProposal(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    action: "accept",
  }), /cannot close before its validity begins/u);
  assert.deepEqual({
    nodes: Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    sources: Number(database.prepare("SELECT COUNT(*) AS count FROM memory_sources").get().count),
    edges: Number(database.prepare("SELECT COUNT(*) AS count FROM memory_edges").get().count),
  }, before);
  assert.equal(repository.getMemory(current.id).status, "active");
  assert.equal(repository.getReportedStateProposal("agent-test", proposal.id).review_state, "pending");
  database.close();
});

test("rejects acceptance after reviewed evidence content changes", () => {
  const { database, repository } = setup();
  const observation = addReportedBeliefObservation(repository, {
    id: "evidence-drift",
  });
  const proposal = repository.recordReportedStateProposal({
    agentId: "agent-test",
    stateFamily: "belief",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    action: "create",
    proposedState: beliefDraft(observation),
    reviewVersion: "reported-belief-review-v1",
    inputHash: createHash("sha256").update("evidence-drift").digest("hex"),
    selectedObservationId: observation.id,
    consideredObservationIds: [observation.id],
  });
  repository.editMemoryManually({
    agentId: "agent-test",
    memoryId: observation.memory_id,
    patch: { content: "审核后被人工改写的证据正文。" },
    actor: "human:test",
    reason: "verify immutable proposal evidence",
  });
  assert.throws(() => resolveReportedStateProposal(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    action: "accept",
  }), /evidence memory changed after review/u);
  assert.equal(repository.getReportedStateProposal("agent-test", proposal.id).review_state, "pending");
  assert.equal(repository.getCurrentCanonicalMemory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    representationLayer: "reported",
    stateFamily: "belief",
  }), null);
  database.close();
});
