import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryRepository,
  openMemoryDatabase,
  proposePreferenceState,
  resolvePreferenceStateProposal,
} from "../src/index.mjs";

function setup() {
  const database = openMemoryDatabase(":memory:");
  return { database, repository: new MemoryRepository(database) };
}

function evidenceMemory(repository, {
  id,
  content,
  source,
  occurredAt,
} = {}) {
  const sourceRecord = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: `source-${id}`,
    occurredAt,
    speaker: "User",
    content: source,
  });
  repository.upsertMemory({
    id,
    agentId: "agent-test",
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
  repository.linkSource(id, sourceRecord.id, "evidence", {
    authority: "subject_firsthand",
    sourceTrust: 0.95,
    evidenceStrength: 1,
    provenance: "test",
  });
  return { memoryId: id, sourceId: sourceRecord.id };
}

function label(evidence, signal, direction, overrides = {}) {
  return {
    memoryId: evidence.memoryId,
    sourceIds: [evidence.sourceId],
    evidenceGroupId: `group:${evidence.memoryId}`,
    contextId: `context:${evidence.memoryId}`,
    signal,
    direction,
    confidence: 0.9,
    ...overrides,
  };
}

function currentStablePreference(repository) {
  return repository.upsertMemory({
    id: "current-puzzle-preference",
    agentId: "agent-test",
    kind: "derived_hypothesis",
    layer: "semantic",
    title: "用户对解谜游戏的偏好认识",
    content: "用户对解谜游戏表现出稳定偏好。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    reality: "real",
    evidenceMode: "inferred",
    representationLayer: "inferred",
    stateFamily: "preference",
    statePhase: "active",
    temporalState: "current",
    validFrom: "2026-07-01T00:00:00.000Z",
    knownAt: "2026-07-01T00:00:00.000Z",
    actorRoles: [{
      role: "preference_holder",
      actorRole: "user",
      actorKey: "user",
      isPrimary: true,
    }],
    metadata: { preferenceStateLevel: "stable_preference" },
  });
}

test("keeps a selection tendency pending until explicit acceptance", () => {
  const { database, repository } = setup();
  const choice = evidenceMemory(repository, {
    id: "choice-puzzle",
    content: "用户在空闲晚上主动选择了解谜游戏。",
    source: "我今晚还是想玩解谜游戏。",
    occurredAt: "2026-07-10T12:00:00.000Z",
  });
  const before = Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const proposal = proposePreferenceState(repository, {
    agentId: "agent-test",
    batchId: "preference-batch-1",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    subjectLabel: "用户",
    objectLabel: "解谜游戏",
    proposedLevel: "selection_tendency",
    previewStatus: "selection-tendency",
    policyVersion: "preference-test-v1",
    evidence: [label(choice, "active_choice", "support")],
  });
  assert.equal(proposal.review_state, "pending");
  assert.equal(proposal.transition, "create");
  assert.equal(proposal.proposed_kind, "derived_hypothesis");
  assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count), before);

  const accepted = resolvePreferenceStateProposal(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    action: "accept",
    resolvedBy: "human:test",
  });
  assert.equal(accepted.status, "create");
  assert.equal(accepted.memory.kind, "derived_hypothesis");
  assert.equal(accepted.memory.evidence_mode, "inferred");
  assert.equal(accepted.memory.metadata.preferenceStateLevel, "selection_tendency");
  assert.equal(accepted.memory.confidence <= 0.65, true);
  assert.equal(
    repository.listMemoryRoles(accepted.memory.id)
      .some((role) => role.role === "preference_holder" && role.actor_key === "user"),
    true,
  );
  assert.equal(repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: accepted.memory.id,
    toMemoryId: choice.memoryId,
    relation: "supported_by",
  }).relation, "supported_by");
  assert.equal(
    repository.getMemoryDetail("agent-test", accepted.memory.id).sources[0].id,
    choice.sourceId,
  );
  database.close();
});

test("keeps bounded counter-evidence as a challenge without downgrading current preference", () => {
  const { database, repository } = setup();
  const current = currentStablePreference(repository);
  const counter = evidenceMemory(repository, {
    id: "counter-puzzle",
    content: "用户有空时主动选择不玩解谜游戏。",
    source: "今天有空，但我不想玩解谜游戏。",
    occurredAt: "2026-07-20T12:00:00.000Z",
  });
  const proposal = proposePreferenceState(repository, {
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    subjectLabel: "用户",
    objectLabel: "解谜游戏",
    proposedLevel: "stable_preference",
    previewStatus: "behavioral-opposition",
    policyVersion: "preference-test-v1",
    evidenceReviewMode: "bounded",
    evidence: [label(counter, "counter_behavior", "opposition")],
  });
  assert.equal(proposal.transition, "challenge");
  const accepted = resolvePreferenceStateProposal(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    action: "accept",
  });
  assert.equal(accepted.status, "challenge-accepted");
  assert.equal(accepted.memory.id, current.id);
  assert.equal(repository.getMemory(current.id).status, "active");
  assert.equal(repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: current.id,
    toMemoryId: counter.memoryId,
    relation: "challenged_by",
  }).relation, "challenged_by");
  assert.equal(
    Number(database.prepare(`
      SELECT COUNT(*) AS count FROM memory_nodes
      WHERE canonical_key = 'user:preference:puzzle-games'
    `).get().count),
    1,
  );
  database.close();
});

test("promotes a reviewed selection tendency while preserving its earlier state", () => {
  const { database, repository } = setup();
  const current = repository.upsertMemory({
    id: "current-selection-tendency",
    agentId: "agent-test",
    kind: "derived_hypothesis",
    layer: "semantic",
    content: "用户表现出对解谜游戏的选择倾向。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    reality: "real",
    evidenceMode: "inferred",
    representationLayer: "inferred",
    stateFamily: "preference",
    statePhase: "active",
    temporalState: "current",
    validFrom: "2026-07-01T00:00:00.000Z",
    knownAt: "2026-07-01T00:00:00.000Z",
    metadata: { preferenceStateLevel: "selection_tendency" },
  });
  const choice = evidenceMemory(repository, {
    id: "choice-puzzle-stable",
    content: "用户持续主动投入空闲时间玩解谜游戏。",
    source: "我最近有空的时候还是会主动找新的解谜游戏。",
    occurredAt: "2026-07-18T12:00:00.000Z",
  });
  const proposal = proposePreferenceState(repository, {
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    subjectLabel: "用户",
    objectLabel: "解谜游戏",
    proposedLevel: "stable_preference",
    previewStatus: "stable-preference-review",
    policyVersion: "preference-test-v1",
    evidence: [label(choice, "active_choice", "support")],
  });
  assert.equal(proposal.transition, "promote");
  const accepted = resolvePreferenceStateProposal(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    action: "accept",
  });
  assert.equal(accepted.status, "promote");
  assert.equal(accepted.memory.metadata.preferenceStateLevel, "stable_preference");
  assert.equal(repository.getMemory(current.id).status, "superseded");
  assert.equal(repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: accepted.memory.id,
    toMemoryId: current.id,
    relation: "supersedes",
  }).relation, "supersedes");
  database.close();
});

test("allows a full canonical review to downgrade while preserving the old state", () => {
  const { database, repository } = setup();
  const current = currentStablePreference(repository);
  const counter = evidenceMemory(repository, {
    id: "counter-puzzle-full",
    content: "长期复核中，用户多次在可自由选择时不再选择解谜游戏。",
    source: "这段时间有空我也不想再玩解谜游戏了。",
    occurredAt: "2026-07-25T12:00:00.000Z",
  });
  const proposal = proposePreferenceState(repository, {
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    subjectLabel: "用户",
    objectLabel: "解谜游戏",
    proposedLevel: "no_conclusion",
    previewStatus: "behavioral-opposition",
    policyVersion: "preference-test-v1",
    evidenceReviewMode: "full_canonical",
    evidence: [label(counter, "counter_behavior", "opposition")],
  });
  assert.equal(proposal.transition, "downgrade");
  const accepted = resolvePreferenceStateProposal(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    action: "accept",
  });
  assert.equal(accepted.status, "downgrade");
  assert.equal(accepted.memory.metadata.preferenceStateLevel, "no_conclusion");
  assert.equal(accepted.memory.status, "active");
  const historical = repository.getMemory(current.id);
  assert.equal(historical.status, "superseded");
  assert.equal(historical.temporal_state, "historical");
  assert.equal(historical.valid_to, proposal.valid_from);
  assert.equal(repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: accepted.memory.id,
    toMemoryId: current.id,
    relation: "supersedes",
  }).relation, "supersedes");
  assert.equal(repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: accepted.memory.id,
    toMemoryId: counter.memoryId,
    relation: "challenged_by",
  }).relation, "challenged_by");
  assert.deepEqual(
    repository.listCanonicalStateHistory({
      agentId: "agent-test",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: "user:preference:puzzle-games",
    }).map((memory) => memory.id),
    [accepted.memory.id, current.id],
  );
  database.close();
});

test("rejects stale preference proposals after another state becomes current", () => {
  const { database, repository } = setup();
  currentStablePreference(repository);
  const choice = evidenceMemory(repository, {
    id: "choice-puzzle-new",
    content: "用户继续主动选择解谜游戏。",
    source: "我还是选解谜游戏。",
    occurredAt: "2026-07-21T12:00:00.000Z",
  });
  const proposal = proposePreferenceState(repository, {
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    subjectLabel: "用户",
    objectLabel: "解谜游戏",
    proposedLevel: "stable_preference",
    previewStatus: "stable-preference-review",
    policyVersion: "preference-test-v1",
    evidence: [label(choice, "active_choice", "support")],
  });
  repository.updateMemoryStatus("current-puzzle-preference", "superseded");
  repository.upsertMemory({
    id: "newer-current",
    agentId: "agent-test",
    kind: "derived_hypothesis",
    layer: "semantic",
    content: "用户后来明确表示喜欢解谜游戏。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    evidenceMode: "inferred",
    representationLayer: "inferred",
    stateFamily: "preference",
    statePhase: "active",
    temporalState: "current",
    status: "active",
    metadata: { preferenceStateLevel: "stable_preference" },
  });
  assert.throws(() => resolvePreferenceStateProposal(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    action: "accept",
  }), /changed after proposal creation/u);
  assert.equal(repository.getPreferenceStateProposal("agent-test", proposal.id).review_state, "pending");
  database.close();
});
