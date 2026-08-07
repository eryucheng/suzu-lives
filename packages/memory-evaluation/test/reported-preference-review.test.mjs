import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRepository, openMemoryDatabase } from "@suzu-lives/memory-core";
import { reviewReportedPreferenceState } from "../src/index.mjs";

const KEY = "user:preference:fish";

function setup({ withCurrent = false, withEstablished = false } = {}) {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  let current = null;
  if (withCurrent) {
    current = repository.upsertMemory({
      id: "current-reported-preference",
      agentId: "agent-test",
      kind: "preference",
      layer: "semantic",
      content: "用户表示自己喜欢鱼。",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: KEY,
      reality: "real",
      evidenceMode: "explicit",
      representationLayer: "reported",
      stateFamily: "preference",
      statePhase: "active",
      temporalState: "current",
      knownAt: "2026-07-01T08:00:00.000Z",
      validFrom: "2026-07-01T08:00:00.000Z",
      metadata: {
        reportedPreference: {
          polarity: "positive",
          scope: { kind: "category", label: "鱼", context: "" },
        },
      },
    });
  }
  if (withEstablished) {
    repository.upsertMemory({
      id: "current-established-preference",
      agentId: "agent-test",
      kind: "preference",
      layer: "semantic",
      content: "跨情境主动选择支持用户稳定喜欢鱼。",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: KEY,
      reality: "real",
      evidenceMode: "observed",
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
  sourceContent = "我喜欢吃鱼。",
  qualification = "qualified",
  evidenceMode = "explicit",
  targetMatch = "exact",
  matchedLabel = "鱼",
  expressionType = "likes",
  directness = "explicit_self_statement",
  signal = "explicit_preference",
  explicitSignal = signal,
  behaviorSignal = "",
  stateTime = "current",
  scopeKind = "category",
  scopeLabel = "鱼",
  contextLabel = "",
  revisionCue = "none",
} = {}) {
  const source = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: `source-${id}`,
    occurredAt: observedAt,
    knownAt: observedAt,
    speaker: directness === "explicit_self_statement" ? "User" : "Agent",
    content: sourceContent,
  });
  const memory = repository.upsertMemory({
    id: `memory-${id}`,
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: `偏好证据：${sourceContent}`,
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
    authority: directness === "explicit_self_statement" ? "subject_firsthand" : "model_inference",
    sourceTrust: 0.95,
    evidenceStrength: 1,
    provenance: "test",
  });
  const positive = signal !== "explicit_rejection";
  const observation = repository.recordStateEvidenceObservation({
    id: `observation-${id}`,
    agentId: "agent-test",
    stateFamily: "preference",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    memoryId: memory.id,
    evidenceGroupId: `event:${id}`,
    contextId: "context:fish",
    signal,
    claimedDirection: positive ? "support" : "opposition",
    effectiveDirection: qualification === "qualified"
      ? (positive ? "support" : "opposition")
      : "neutral",
    qualification,
    confidence: 0.9,
    origin: "deterministic",
    scope: { kind: targetMatch, label: scopeLabel, context: contextLabel },
    payloadSchemaVersion: "preference-specialist-merged-v2",
    payload: {
      objectGrounding: { targetMatch, matchedLabel },
      explicitExpression: { expressionType, directness },
      behaviorConditions: behaviorSignal ? {
        behaviorType: "choice",
        agency: "self_initiated",
        constraint: "none",
        alternatives: "available",
        instrumentalGoal: "none",
        opportunityCost: "medium",
        canDecline: "yes",
      } : null,
      sharingAffect: null,
      timeScope: {
        stateTime,
        occurrencePattern: "single",
        scopeKind,
        scopeLabel,
        contextLabel,
        revisionCue,
      },
      selectedSignals: { signal, explicitSignal, behaviorSignal, sharingSignal: "" },
    },
    excludedReason: qualification === "qualified" ? "" : "not-direct-current-preference",
    sourceIds: [source.id],
    observedAt,
  });
  return { source, memory, observation };
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

function review(repository, overrides = {}) {
  return reviewReportedPreferenceState({
    repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    subjectLabel: "用户",
    objectLabel: "鱼",
    ...overrides,
  });
}

test("creates a reported preference without claiming stable or behavioral preference", () => {
  const fixture = setup();
  const evidence = addObservation(fixture.repository, { id: "direct-like" });
  const before = Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const result = review(fixture.repository);
  assert.equal(result.status, "ready");
  assert.equal(result.action, "create");
  assert.equal(result.proposedState.representationLayer, "reported");
  assert.equal(result.proposedState.preferenceClaim.polarity, "positive");
  assert.equal(result.proposedState.preferenceClaim.crossContextStability, "unverified");
  assert.deepEqual(result.proposedState.evidenceObservationIds, [evidence.observation.id]);
  assert.equal(result.automaticStablePreferenceWriteAllowed, false);
  assert.equal(Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count), before);
  fixture.database.close();
});

test("does not turn active choice or repeated constrained behavior into a direct report", () => {
  const fixture = setup();
  addObservation(fixture.repository, {
    id: "active-choice",
    sourceContent: "在几个选项里选了鱼。",
    evidenceMode: "observed",
    expressionType: "none",
    directness: "implicit",
    signal: "active_choice",
    explicitSignal: "",
    behaviorSignal: "active_choice",
  });
  addObservation(fixture.repository, {
    id: "forced-routine",
    sourceContent: "单位每天只提供鱼。",
    evidenceMode: "observed",
    expressionType: "none",
    directness: "implicit",
    signal: "repeated_behavior",
    explicitSignal: "",
    behaviorSignal: "repeated_behavior",
    observedAt: "2026-07-11T12:00:00.000Z",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.automaticSelectionTendencyWriteAllowed, false);
  fixture.database.close();
});

test("does not adopt an Agent or third-party judgment as the subject's direct preference", () => {
  const fixture = setup();
  addObservation(fixture.repository, {
    id: "agent-judgment",
    sourceContent: "我觉得用户应该喜欢鱼。",
    directness: "explicit_reported_statement",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "no-qualified-direct-current-preference-expression");
  fixture.database.close();
});

test("does not let an established preference occupy the reported layer", () => {
  const fixture = setup({ withEstablished: true });
  addObservation(fixture.repository, { id: "direct-with-established" });
  const result = review(fixture.repository);
  assert.equal(result.action, "create");
  assert.equal(result.currentStateId, "");
  assert.equal(fixture.repository.getMemory("current-established-preference").status, "active");
  fixture.database.close();
});

test("keeps opposite direct reports unresolved without an explicit change cue", () => {
  const fixture = setup();
  addObservation(fixture.repository, { id: "like", observedAt: "2026-07-10T12:00:00.000Z" });
  addObservation(fixture.repository, {
    id: "dislike",
    observedAt: "2026-07-11T12:00:00.000Z",
    sourceContent: "我不喜欢鱼。",
    expressionType: "dislikes",
    signal: "explicit_rejection",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "multiple-unresolved-direct-states-without-change-cue");
  fixture.database.close();
});

test("explicit change supersedes only the reported preference layer", () => {
  const fixture = setup({ withCurrent: true, withEstablished: true });
  const evidence = addObservation(fixture.repository, {
    id: "changed",
    sourceContent: "我现在改了，我不喜欢鱼了。",
    expressionType: "dislikes",
    signal: "explicit_rejection",
    revisionCue: "changed",
  });
  linkCurrent(fixture.repository, fixture.current, evidence, "challenged_by");
  const result = review(fixture.repository);
  assert.equal(result.status, "ready");
  assert.equal(result.action, "supersede");
  assert.equal(result.proposedState.preferenceClaim.polarity, "negative");
  assert.equal(result.truthBoundary.establishedPreferenceIsUnaffected, true);
  assert.equal(fixture.repository.getMemory("current-established-preference").status, "active");
  fixture.database.close();
});

test("explicit clarification can narrow the same reported preference", () => {
  const fixture = setup({ withCurrent: true });
  const evidence = addObservation(fixture.repository, {
    id: "narrowed",
    sourceContent: "准确说，我喜欢的是熟鱼。",
    scopeKind: "subcategory",
    scopeLabel: "熟鱼",
    matchedLabel: "熟鱼",
    revisionCue: "clarified",
  });
  linkCurrent(fixture.repository, fixture.current, evidence);
  const result = review(fixture.repository);
  assert.equal(result.action, "narrow_scope");
  assert.equal(result.proposedState.preferenceClaim.scope.label, "熟鱼");
  fixture.database.close();
});

test("opposite clarified detail is a scoped exception and preserves broader history", () => {
  const fixture = setup({ withCurrent: true });
  const evidence = addObservation(fixture.repository, {
    id: "exception",
    sourceContent: "不是不喜欢鱼，只是不吃生鱼。",
    expressionType: "dislikes",
    signal: "explicit_rejection",
    scopeKind: "subcategory",
    scopeLabel: "生鱼",
    matchedLabel: "生鱼",
    revisionCue: "clarified",
  });
  linkCurrent(fixture.repository, fixture.current, evidence, "challenged_by");
  const result = review(fixture.repository);
  assert.equal(result.action, "add_scoped_exception");
  assert.equal(result.truthBoundary.scopedExceptionPreservesBroaderHistory, true);
  fixture.database.close();
});

test("denial of prior attribution does not silently rewrite the current state", () => {
  const fixture = setup({ withCurrent: true });
  const evidence = addObservation(fixture.repository, {
    id: "deny-old",
    sourceContent: "我从来没说过喜欢鱼，我一直不喜欢。",
    expressionType: "dislikes",
    signal: "explicit_rejection",
    revisionCue: "denies_prior_state",
  });
  linkCurrent(fixture.repository, fixture.current, evidence, "challenged_by");
  const result = review(fixture.repository);
  assert.equal(result.action, "correct_attribution");
  assert.equal(result.proposedState, null);
  assert.equal(result.automaticStateWriteAllowed, false);
  assert.equal(fixture.repository.getMemory(fixture.current.id).status, "active");
  fixture.database.close();
});
