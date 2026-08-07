import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRepository, openMemoryDatabase } from "@suzu-lives/memory-core";
import { reviewReportedValueState } from "../src/index.mjs";

const KEY = "user:value:keep-promises";

function setup({ withCurrent = false, withEstablished = false } = {}) {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  let current = null;
  if (withCurrent) {
    current = repository.upsertMemory({
      id: "current-reported-value",
      agentId: "agent-test",
      kind: "belief_state",
      layer: "semantic",
      content: "用户说守信对自己很重要。",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: KEY,
      reality: "real",
      evidenceMode: "explicit",
      representationLayer: "reported",
      stateFamily: "value",
      statePhase: "active",
      temporalState: "current",
      knownAt: "2026-07-01T08:00:00.000Z",
      validFrom: "2026-07-01T08:00:00.000Z",
    });
  }
  if (withEstablished) {
    repository.upsertMemory({
      id: "current-established-value",
      agentId: "agent-test",
      kind: "derived_hypothesis",
      layer: "semantic",
      content: "多次真实取舍支持用户通常优先守信。",
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
  }
  return { database, repository, current };
}

function addObservation(repository, {
  id,
  observedAt = "2026-07-10T12:00:00.000Z",
  sourceContent = "对我来说守信很重要。",
  qualification = "qualified",
  targetMatch = "exact",
  stance = "protects",
  valueLabel = "守信",
  scopeLabel = "一般承诺",
  attribution = "explicit_self_statement",
  evidenceType = "explicit_principle",
  protectedValueMatch = "yes",
  stateTime = "current",
  revisionCue = "none",
  currentStatePresent = false,
  relation = "no_current_state",
  scopeOverlap = "none",
  currentRepresentationLayer = "reported",
} = {}) {
  const source = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: `source-${id}`,
    occurredAt: observedAt,
    knownAt: observedAt,
    speaker: attribution === "explicit_self_statement" ? "User" : "Agent",
    content: sourceContent,
  });
  const memory = repository.upsertMemory({
    id: `memory-${id}`,
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: `价值证据：${sourceContent}`,
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
    authority: attribution === "explicit_self_statement" ? "subject_firsthand" : "model_inference",
    sourceTrust: 0.95,
    evidenceStrength: 1,
    provenance: "test",
  });
  const support = relation === "no_current_state" || ["equivalent", "supports", "broadens"].includes(relation);
  const observation = repository.recordStateEvidenceObservation({
    id: `observation-${id}`,
    agentId: "agent-test",
    stateFamily: "value",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    memoryId: memory.id,
    evidenceGroupId: `event:${id}`,
    contextId: "context:keep-promises",
    signal: evidenceType === "costly_choice" ? "value_costly_choice_evidence" : "value_principle_evidence",
    claimedDirection: support ? "support" : "opposition",
    effectiveDirection: qualification === "qualified" ? (support ? "support" : "opposition") : "neutral",
    qualification,
    confidence: 0.9,
    origin: "deterministic",
    scope: {
      valueLabel,
      stance,
      scopeLabel,
      evidenceType,
      stateTime,
      currentRelation: relation,
      scopeOverlap,
      currentRepresentationLayer,
    },
    payloadSchemaVersion: "value-merged-evidence-v1",
    payload: {
      target: { targetMatch, stance, valueLabel, scopeLabel },
      holder: { holderMatch: "yes", attribution },
      basis: {
        evidenceType,
        alternatives: evidenceType === "costly_choice" ? "present" : "unknown",
        agency: evidenceType === "costly_choice" ? "active" : "unknown",
        costType: evidenceType === "costly_choice" ? "opportunity" : "none",
        protectedValueMatch,
      },
      time: { stateTime, revisionCue },
      relation: { currentStatePresent, relation, scopeOverlap },
    },
    excludedReason: qualification === "qualified" ? "" : "not-a-direct-current-value-declaration",
    sourceIds: [source.id],
    observedAt,
  });
  return { memory, source, observation };
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

function review(repository) {
  return reviewReportedValueState({
    repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    subjectLabel: "用户",
    valueLabel: "守信优先级",
  });
}

test("creates a reported value declaration without claiming cross-context stability", () => {
  const fixture = setup();
  const evidence = addObservation(fixture.repository, { id: "principle" });
  const before = Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const result = review(fixture.repository);
  assert.equal(result.status, "ready");
  assert.equal(result.action, "create");
  assert.equal(result.proposedState.representationLayer, "reported");
  assert.equal(result.proposedState.valueClaim.aggregationStatus, "unverified-stability");
  assert.deepEqual(result.proposedState.evidenceObservationIds, [evidence.observation.id]);
  assert.equal(result.automaticStableValueWriteAllowed, false);
  assert.equal(Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count), before);
  fixture.database.close();
});

test("does not disguise a costly choice as a principle the subject explicitly declared", () => {
  const fixture = setup();
  addObservation(fixture.repository, {
    id: "costly-choice",
    sourceContent: "我本来可以休息，但还是花一晚完成了答应的事情。",
    evidenceType: "costly_choice",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "no-qualified-direct-current-value-declaration");
  assert.equal(result.automaticBehaviorEvidenceWriteAllowed, false);
  fixture.database.close();
});

test("does not turn the Agent's judgment into the subject's value declaration", () => {
  const fixture = setup();
  addObservation(fixture.repository, {
    id: "agent-judgment",
    sourceContent: "我觉得用户特别看重守信。",
    attribution: "model_inference",
    qualification: "unresolved",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.automaticDispositionWriteAllowed, false);
  fixture.database.close();
});

test("keeps different current declarations unresolved without an explicit change", () => {
  const fixture = setup();
  addObservation(fixture.repository, { id: "first", observedAt: "2026-07-10T12:00:00.000Z" });
  addObservation(fixture.repository, {
    id: "second",
    observedAt: "2026-07-11T12:00:00.000Z",
    stance: "deprioritizes",
    sourceContent: "守信没有照顾好自己重要。",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "multiple-unresolved-direct-states-without-change-cue");
  fixture.database.close();
});

test("supersedes only the reported declaration after an explicit change", () => {
  const fixture = setup({ withCurrent: true, withEstablished: true });
  const evidence = addObservation(fixture.repository, {
    id: "changed",
    sourceContent: "我以前什么承诺都硬撑，现在改了，安全比守信优先。",
    stance: "deprioritizes",
    evidenceType: "reasoned_priority",
    revisionCue: "changed",
    currentStatePresent: true,
    relation: "replaces",
    scopeOverlap: "exact",
  });
  linkCurrent(fixture.repository, fixture.current, evidence, "challenged_by");
  const result = review(fixture.repository);
  assert.equal(result.action, "supersede");
  assert.equal(result.currentStateId, fixture.current.id);
  assert.equal(result.snapshot.target.currentRepresentationLayer, "reported");
  assert.equal(result.proposedState.valueClaim.stance, "deprioritizes");
  assert.equal(fixture.repository.getMemory("current-established-value").status, "active");
  fixture.database.close();
});

test("narrows a reported declaration after an explicit scope clarification", () => {
  const fixture = setup({ withCurrent: true });
  const evidence = addObservation(fixture.repository, {
    id: "clarified",
    sourceContent: "守信还是重要，但涉及安全的承诺不能硬撑。",
    stance: "deprioritizes",
    scopeLabel: "涉及人身安全的承诺",
    evidenceType: "reasoned_priority",
    revisionCue: "clarified",
    currentStatePresent: true,
    relation: "narrows",
    scopeOverlap: "partial",
  });
  linkCurrent(fixture.repository, fixture.current, evidence, "challenged_by");
  const result = review(fixture.repository);
  assert.equal(result.action, "narrow_scope");
  assert.equal(fixture.repository.getMemory(fixture.current.id).status, "active");
  fixture.database.close();
});

test("requires review before broadening a reported value scope", () => {
  const fixture = setup({ withCurrent: true });
  const evidence = addObservation(fixture.repository, {
    id: "broadens",
    sourceContent: "任何情况下都必须守信。",
    scopeLabel: "任何承诺",
    currentStatePresent: true,
    relation: "broadens",
    scopeOverlap: "partial",
  });
  linkCurrent(fixture.repository, fixture.current, evidence);
  const result = review(fixture.repository);
  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "latest-value-declaration-does-not-prove-a-safe-transition");
  fixture.database.close();
});

test("rejects value evidence whose current-state comparison targeted another representation layer", () => {
  const fixture = setup();
  addObservation(fixture.repository, {
    id: "established-layer-comparison",
    currentRepresentationLayer: "established",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "no-qualified-direct-current-value-declaration");
  fixture.database.close();
});
