import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRepository, openMemoryDatabase } from "@suzu-lives/memory-core";
import {
  reviewReportedConditionState,
  reviewReportedHabitState,
} from "../src/index.mjs";

const CONDITION_KEY = "user:condition:project-overtime";
const HABIT_KEY = "user:habit:daily-overtime";

function setup({ currentCondition = false, currentHabit = false, establishedHabit = false } = {}) {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  let condition = null;
  let habit = null;
  if (currentCondition) {
    condition = repository.upsertMemory({
      id: "current-reported-condition",
      agentId: "agent-test",
      kind: "fact",
      layer: "semantic",
      content: "用户报告最近项目要求每天加班。",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: CONDITION_KEY,
      reality: "real",
      evidenceMode: "explicit",
      representationLayer: "reported",
      stateFamily: "condition",
      statePhase: "active",
      temporalState: "current",
      knownAt: "2026-07-01T08:00:00.000Z",
      validFrom: "2026-07-01T08:00:00.000Z",
      metadata: {
        reportedCondition: {
          presence: "present",
          conditionKind: "work",
          effect: "constrains",
          temporality: "temporary",
          scope: { targetMatch: "exact", matchedLabel: "项目加班要求", scopeLabel: "最近项目期间" },
        },
      },
    });
  }
  if (currentHabit) {
    habit = repository.upsertMemory({
      id: "current-reported-habit",
      agentId: "agent-test",
      kind: "belief_state",
      layer: "semantic",
      content: "用户报告最近每天加班。",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: HABIT_KEY,
      reality: "real",
      evidenceMode: "explicit",
      representationLayer: "reported",
      stateFamily: "habit",
      statePhase: "active",
      temporalState: "current",
      knownAt: "2026-07-01T08:00:00.000Z",
      validFrom: "2026-07-01T08:00:00.000Z",
      metadata: {
        reportedHabit: {
          patternType: "habitual",
          regularity: "daily",
          constraint: "work",
          scope: { targetMatch: "exact", matchedLabel: "每天加班", contextLabel: "最近项目期间" },
        },
      },
    });
  }
  if (establishedHabit) {
    repository.upsertMemory({
      id: "current-established-habit",
      agentId: "agent-test",
      kind: "habit",
      layer: "semantic",
      content: "直接记录支持最近每天加班。",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: HABIT_KEY,
      reality: "real",
      evidenceMode: "observed",
      representationLayer: "established",
      temporalState: "current",
      knownAt: "2026-07-20T08:00:00.000Z",
      validFrom: "2026-07-20T08:00:00.000Z",
    });
  }
  return { database, repository, condition, habit };
}

function sourceMemory(repository, { id, sourceContent, observedAt, evidenceMode = "explicit" }) {
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
    layer: "episodic",
    content: sourceContent,
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    evidenceMode,
    temporalState: "historical",
    eventStart: observedAt,
    knownAt: observedAt,
    actorRoles: [{ role: "speaker", actorRole: "user", actorKey: "user", isPrimary: true }],
  });
  repository.linkSource(memory.id, source.id, "evidence", {
    authority: evidenceMode === "explicit" ? "subject_firsthand" : "direct_observation",
    sourceTrust: 0.95,
    evidenceStrength: 1,
    provenance: "test",
  });
  return { source, memory };
}

function addCondition(repository, {
  id,
  observedAt = "2026-07-10T12:00:00.000Z",
  sourceContent = "最近这个项目要求我每天都得加班。",
  qualification = "qualified",
  evidenceMode = "explicit",
  conditionPresence = "present",
  evidenceBasis = "explicit_self_report",
  revisionCue = "none",
} = {}) {
  const record = sourceMemory(repository, { id, sourceContent, observedAt, evidenceMode });
  const observation = repository.recordStateEvidenceObservation({
    id: `observation-${id}`,
    agentId: "agent-test",
    stateFamily: "condition",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: CONDITION_KEY,
    memoryId: record.memory.id,
    evidenceGroupId: `event:${id}`,
    contextId: "context:project",
    signal: conditionPresence === "present" ? "condition_present" : "condition_absent",
    claimedDirection: conditionPresence === "present" ? "support" : "opposition",
    effectiveDirection: qualification === "qualified"
      ? (conditionPresence === "present" ? "support" : "opposition") : "neutral",
    qualification,
    confidence: 0.9,
    origin: "deterministic",
    scope: { matchedLabel: "项目加班要求", scopeLabel: "最近项目期间" },
    payloadSchemaVersion: "memory-condition-evidence-v2",
    payload: {
      targetMatch: "exact",
      matchedLabel: "项目加班要求",
      conditionPresence,
      conditionKind: "work",
      effect: "constrains",
      temporality: "temporary",
      evidenceBasis,
      scopeLabel: "最近项目期间",
      revisionCue,
    },
    excludedReason: qualification === "qualified" ? "" : "condition-evidence-not-direct",
    sourceIds: [record.source.id],
    observedAt,
  });
  return { ...record, observation };
}

function addHabit(repository, {
  id,
  observedAt = "2026-07-10T12:00:00.000Z",
  sourceContent = "最近这个项目期间我每天都在加班。",
  qualification = "qualified",
  evidenceMode = "explicit",
  patternType = "habitual",
  evidenceBasis = "explicit_self_report",
  revisionCue = "none",
} = {}) {
  const record = sourceMemory(repository, { id, sourceContent, observedAt, evidenceMode });
  const supporting = ["repeated", "habitual"].includes(patternType);
  const observation = repository.recordStateEvidenceObservation({
    id: `observation-${id}`,
    agentId: "agent-test",
    stateFamily: "habit",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: HABIT_KEY,
    memoryId: record.memory.id,
    evidenceGroupId: `event:${id}`,
    contextId: "context:project",
    signal: supporting ? "habitual_pattern" : `pattern_${patternType}`,
    claimedDirection: supporting ? "support" : "opposition",
    effectiveDirection: qualification === "qualified"
      ? (supporting ? "support" : "opposition") : "neutral",
    qualification,
    confidence: 0.9,
    origin: "deterministic",
    scope: { matchedLabel: "每天加班", contextLabel: "最近项目期间" },
    payloadSchemaVersion: "memory-habit-evidence-v2",
    payload: {
      targetMatch: "exact",
      matchedLabel: "每天加班",
      patternType,
      regularity: "daily",
      timeState: patternType === "habitual" ? "current" : "changed",
      evidenceBasis,
      constraint: "work",
      contextLabel: "最近项目期间",
      revisionCue,
    },
    excludedReason: qualification === "qualified" ? "" : "habit-evidence-not-direct",
    sourceIds: [record.source.id],
    observedAt,
  });
  return { ...record, observation };
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

function reviewCondition(repository) {
  return reviewReportedConditionState({
    repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: CONDITION_KEY,
    subjectLabel: "用户",
    conditionLabel: "项目加班要求",
  });
}

function reviewHabit(repository) {
  return reviewReportedHabitState({
    repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: HABIT_KEY,
    subjectLabel: "用户",
    habitLabel: "每天加班",
  });
}

test("creates a reported current condition without inferring preference or disposition", () => {
  const fixture = setup();
  addCondition(fixture.repository, { id: "condition" });
  const result = reviewCondition(fixture.repository);
  assert.equal(result.action, "create");
  assert.equal(result.proposedState.kind, "fact");
  assert.equal(result.proposedState.statePhase, "active");
  assert.equal(result.proposedState.conditionClaim.externalVerificationStatus, "unverified");
  assert.equal(result.truthBoundary.preferenceStatus, "not-inferred");
  assert.equal(result.automaticDispositionWriteAllowed, false);
  fixture.database.close();
});

test("does not disguise direct observation as the subject's condition report", () => {
  const fixture = setup();
  addCondition(fixture.repository, {
    id: "observed-condition",
    evidenceMode: "observed",
    evidenceBasis: "direct_observation",
  });
  const result = reviewCondition(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.automaticEstablishedConditionWriteAllowed, false);
  fixture.database.close();
});

test("ends only the same reported condition after an explicit ending cue", () => {
  const fixture = setup({ currentCondition: true });
  const evidence = addCondition(fixture.repository, {
    id: "ended-condition",
    sourceContent: "项目结束了，现在不用再加班。",
    conditionPresence: "absent",
    revisionCue: "ended",
  });
  linkCurrent(fixture.repository, fixture.condition, evidence, "challenged_by");
  const result = reviewCondition(fixture.repository);
  assert.equal(result.action, "end");
  assert.equal(result.proposedState, null);
  assert.equal(fixture.repository.getMemory(fixture.condition.id).status, "active");
  fixture.database.close();
});

test("keeps conflicting condition reports unresolved without a change cue", () => {
  const fixture = setup();
  addCondition(fixture.repository, { id: "present", observedAt: "2026-07-10T12:00:00.000Z" });
  addCondition(fixture.repository, {
    id: "absent",
    observedAt: "2026-07-11T12:00:00.000Z",
    conditionPresence: "absent",
  });
  const result = reviewCondition(fixture.repository);
  assert.equal(result.status, "review_required");
  fixture.database.close();
});

test("creates a reported habit without claiming liking or objective regularity", () => {
  const fixture = setup({ establishedHabit: true });
  addHabit(fixture.repository, { id: "habit" });
  const result = reviewHabit(fixture.repository);
  assert.equal(result.action, "create");
  assert.equal(result.currentStateId, "");
  assert.equal(result.proposedState.kind, "belief_state");
  assert.equal(result.proposedState.statePhase, "active");
  assert.equal(result.proposedState.habitClaim.observedRegularityStatus, "unverified");
  assert.equal(result.truthBoundary.preferenceStatus, "not-inferred");
  assert.equal(fixture.repository.getMemory("current-established-habit").status, "active");
  fixture.database.close();
});

test("does not turn one direct observation into a reported habit", () => {
  const fixture = setup();
  addHabit(fixture.repository, {
    id: "single-observation",
    evidenceMode: "observed",
    evidenceBasis: "direct_observation",
    patternType: "repeated",
  });
  const result = reviewHabit(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.automaticBehaviorEvidenceWriteAllowed, false);
  fixture.database.close();
});

test("stops only the reported habit after an explicit stop cue", () => {
  const fixture = setup({ currentHabit: true });
  const evidence = addHabit(fixture.repository, {
    id: "stopped-habit",
    sourceContent: "项目结束后我已经不再每天加班了。",
    patternType: "stopped",
    revisionCue: "stopped",
  });
  linkCurrent(fixture.repository, fixture.habit, evidence, "challenged_by");
  const result = reviewHabit(fixture.repository);
  assert.equal(result.action, "stop");
  assert.equal(result.proposedState, null);
  assert.equal(result.truthBoundary.establishedHabitIsUnaffected, true);
  fixture.database.close();
});

test("keeps different habit reports unresolved without an explicit change", () => {
  const fixture = setup();
  addHabit(fixture.repository, { id: "daily", observedAt: "2026-07-10T12:00:00.000Z" });
  addHabit(fixture.repository, {
    id: "stopped-without-cue",
    observedAt: "2026-07-11T12:00:00.000Z",
    patternType: "stopped",
  });
  const result = reviewHabit(fixture.repository);
  assert.equal(result.status, "review_required");
  assert.equal(result.automaticStateWriteAllowed, false);
  fixture.database.close();
});
