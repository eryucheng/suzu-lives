import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRepository, openMemoryDatabase } from "@suzu-lives/memory-core";
import { reviewReportedSelfConceptState } from "../src/index.mjs";

const KEY = "user:self-concept:caregiver";

function setup({ withCurrent = false } = {}) {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  let current = null;
  if (withCurrent) {
    current = repository.upsertMemory({
      id: "current-self-concept",
      agentId: "agent-test",
      kind: "belief_state",
      layer: "semantic",
      content: "用户一直把自己理解为需要照顾别人的人。",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: KEY,
      reality: "real",
      evidenceMode: "explicit",
      representationLayer: "reported",
      stateFamily: "self_concept",
      statePhase: "active",
      temporalState: "current",
      knownAt: "2026-07-01T08:00:00.000Z",
      validFrom: "2026-07-01T08:00:00.000Z",
    });
  }
  return { database, repository, current };
}

function addObservation(repository, {
  id,
  conceptLabel = "需要照顾别人的人",
  scopeLabel = "一般关系",
  sourceContent = "我一直觉得自己是需要照顾别人的人。",
  observedAt = "2026-07-10T12:00:00.000Z",
  holderAttribution = "explicit_self_definition",
  expressionType = "stable_self_definition",
  contextBasis = "repeated_reflection",
  stateTime = "current",
  revisionCue = "none",
  currentStatePresent = false,
  relation = "no_current_state",
  scopeOverlap = "none",
  qualification = "qualified",
  excludedReason = "",
  currentRepresentationLayer = "reported",
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
    kind: "event",
    layer: "semantic",
    content: `用户表达自我认识：${conceptLabel}`,
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    evidenceMode: "explicit",
    temporalState: "historical",
    eventStart: observedAt,
    knownAt: observedAt,
    actorRoles: [{ role: "speaker", actorRole: "user", actorKey: "user", isPrimary: true }],
  });
  repository.linkSource(memory.id, source.id, "evidence", {
    authority: "subject_firsthand",
    sourceTrust: 0.95,
    evidenceStrength: 1,
    provenance: "test",
  });
  const support = relation === "no_current_state" || ["equivalent", "supports", "broadens"].includes(relation);
  const observation = repository.recordStateEvidenceObservation({
    id: `observation-${id}`,
    agentId: "agent-test",
    stateFamily: "self_concept",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    memoryId: memory.id,
    evidenceGroupId: `event:${id}`,
    contextId: "context:self-reflection",
    signal: holderAttribution === "explicit_self_reflection" ? "self_reflection" : "self_definition",
    claimedDirection: support ? "support" : "opposition",
    effectiveDirection: qualification === "qualified" ? (support ? "support" : "opposition") : "neutral",
    qualification,
    confidence: 0.9,
    origin: "deterministic",
    scope: {
      selfConceptLabel: "照顾者自我认识",
      scopeLabel,
      scopeOverlap,
      currentRepresentationLayer,
    },
    payloadSchemaVersion: "self-concept-merged-evidence-v1",
    payload: {
      concept: { targetMatch: "exact", conceptType: "role_identity", conceptLabel, scopeLabel },
      holder: { holderMatch: "yes", attribution: holderAttribution },
      stability: { expressionType, contextBasis },
      time: { stateTime, revisionCue, timeReference: "" },
      relation: { currentStatePresent, relation, scopeOverlap },
    },
    excludedReason,
    sourceIds: [source.id],
    observedAt,
  });
  return { memory, source, observation };
}

function review(repository) {
  return reviewReportedSelfConceptState({
    repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    subjectLabel: "用户",
    selfConceptLabel: "照顾者自我认识",
  });
}

function linkCurrent(repository, current, evidence, relation = "supported_by") {
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: current.id,
    toMemoryId: evidence.memory.id,
    relation,
    direction: "directed",
    weight: 0.9,
    confidence: 0.9,
    provenance: "test",
  });
}

test("creates a reported self-understanding without manufacturing objective personality", () => {
  const fixture = setup();
  const evidence = addObservation(fixture.repository, { id: "definition" });
  const before = Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const result = review(fixture.repository);
  assert.equal(result.status, "ready");
  assert.equal(result.action, "create");
  assert.equal(result.proposedState.representationLayer, "reported");
  assert.equal(result.proposedState.selfUnderstanding.status, "subjective-current-understanding");
  assert.deepEqual(result.proposedState.evidenceObservationIds, [evidence.observation.id]);
  assert.equal(result.automaticIdentityWriteAllowed, false);
  assert.equal(result.automaticDispositionWriteAllowed, false);
  assert.equal(Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count), before);
  fixture.database.close();
});

test("does not freeze acute self-criticism into reported self-concept", () => {
  const fixture = setup();
  addObservation(fixture.repository, {
    id: "acute",
    conceptLabel: "没用的人",
    sourceContent: "这次又失败了，我真没用。",
    expressionType: "temporary_self_appraisal",
    contextBasis: "acute_emotion",
    stateTime: "temporary",
    qualification: "excluded",
    excludedReason: "acute-emotion-is-not-stable-self-concept",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "no-qualified-direct-current-self-concept");
  fixture.database.close();
});

test("does not turn a third-party label into the subject's self-understanding", () => {
  const fixture = setup();
  addObservation(fixture.repository, {
    id: "third-party",
    sourceContent: "别人都说他是需要照顾人的类型。",
    holderAttribution: "third_party_label",
    qualification: "unresolved",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.automaticPersonalityDiagnosisAllowed, false);
  fixture.database.close();
});

test("keeps two different self-definitions unresolved without an explicit change", () => {
  const fixture = setup();
  addObservation(fixture.repository, { id: "first", observedAt: "2026-07-10T12:00:00.000Z" });
  addObservation(fixture.repository, {
    id: "second",
    conceptLabel: "优先照顾自己的人",
    sourceContent: "我现在更想优先照顾自己。",
    observedAt: "2026-07-11T12:00:00.000Z",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "multiple-unresolved-direct-states-without-change-cue");
  fixture.database.close();
});

test("uses an explicit self-understanding change for the latest reported state", () => {
  const fixture = setup();
  addObservation(fixture.repository, { id: "old", observedAt: "2026-07-10T12:00:00.000Z" });
  addObservation(fixture.repository, {
    id: "changed",
    conceptLabel: "优先照顾自己的人",
    sourceContent: "我以前总觉得要照顾所有人，现在更想先照顾自己。",
    observedAt: "2026-07-11T12:00:00.000Z",
    holderAttribution: "explicit_self_reflection",
    expressionType: "reflective_reinterpretation",
    contextBasis: "turning_point",
    revisionCue: "changed",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "ready");
  assert.equal(result.selectedObservationId, "observation-changed");
  assert.equal(result.proposedState.selfUnderstanding.label, "优先照顾自己的人");
  fixture.database.close();
});

test("previews a scoped clarification without replacing the whole self-narrative", () => {
  const fixture = setup({ withCurrent: true });
  const evidence = addObservation(fixture.repository, {
    id: "narrow",
    conceptLabel: "在亲密关系中愿意照顾别人",
    scopeLabel: "亲密关系",
    currentStatePresent: true,
    relation: "narrows",
    scopeOverlap: "subset",
    revisionCue: "clarified_scope",
  });
  linkCurrent(fixture.repository, fixture.current, evidence, "challenged_by");
  const result = review(fixture.repository);
  assert.equal(result.action, "narrow_scope");
  assert.equal(fixture.repository.getMemory(fixture.current.id).status, "active");
  fixture.database.close();
});

test("previews an explicit replacement while keeping the current state untouched", () => {
  const fixture = setup({ withCurrent: true });
  const evidence = addObservation(fixture.repository, {
    id: "replace",
    conceptLabel: "优先照顾自己的人",
    sourceContent: "我现在不再把照顾所有人当成自己的责任了。",
    currentStatePresent: true,
    relation: "replaces",
    scopeOverlap: "exact",
    revisionCue: "changed",
    expressionType: "reflective_reinterpretation",
    contextBasis: "turning_point",
  });
  linkCurrent(fixture.repository, fixture.current, evidence, "challenged_by");
  const result = review(fixture.repository);
  assert.equal(result.action, "supersede");
  assert.equal(result.proposedState.selfUnderstanding.label, "优先照顾自己的人");
  assert.equal(fixture.repository.getMemory(fixture.current.id).status, "active");
  fixture.database.close();
});

test("rejects self-concept evidence whose current-state comparison targeted another representation layer", () => {
  const fixture = setup();
  addObservation(fixture.repository, {
    id: "established-layer-comparison",
    currentRepresentationLayer: "established",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "no-qualified-direct-current-self-concept");
  fixture.database.close();
});
