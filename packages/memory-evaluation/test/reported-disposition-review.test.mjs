import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRepository, openMemoryDatabase } from "@suzu-lives/memory-core";
import { reviewReportedDispositionState } from "../src/index.mjs";

const KEY = "user:disposition:research-before-decisions";

function setup({ withCurrent = false, withEstablished = false } = {}) {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  let current = null;
  if (withCurrent) {
    current = repository.upsertMemory({
      id: "current-reported-disposition",
      agentId: "agent-test",
      kind: "belief_state",
      layer: "semantic",
      content: "用户认为自己做决定前通常会先查资料。",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: KEY,
      reality: "real",
      evidenceMode: "explicit",
      representationLayer: "reported",
      stateFamily: "disposition",
      statePhase: "active",
      temporalState: "current",
      knownAt: "2026-07-01T08:00:00.000Z",
      validFrom: "2026-07-01T08:00:00.000Z",
      metadata: {
        reportedDisposition: {
          presence: "present",
          scope: {
            targetMatch: "exact",
            matchedLabel: "做决定前先研究",
            situationLabel: "",
            responseLabel: "先查资料再决定",
          },
        },
      },
    });
  }
  if (withEstablished) {
    repository.upsertMemory({
      id: "current-established-disposition",
      agentId: "agent-test",
      kind: "disposition",
      layer: "semantic",
      content: "跨情境行为支持用户做决定前会先查资料。",
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
  sourceContent = "我做决定前通常会先查清楚。",
  qualification = "qualified",
  evidenceMode = "explicit",
  targetMatch = "exact",
  matchedLabel = "做决定前先研究",
  tendencyPresence = "present",
  evidenceType = "explicit_self_description",
  crossContext = "unknown",
  externalConstraint = "unknown",
  timeState = "current",
  situationLabel = "",
  responseLabel = "先查资料再决定",
  revisionCue = "none",
} = {}) {
  const source = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: `source-${id}`,
    occurredAt: observedAt,
    knownAt: observedAt,
    speaker: evidenceType === "explicit_self_description" ? "User" : "Other",
    content: sourceContent,
  });
  const memory = repository.upsertMemory({
    id: `memory-${id}`,
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: `行为倾向证据：${sourceContent}`,
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    evidenceMode,
    temporalState: "historical",
    eventStart: observedAt,
    knownAt: observedAt,
    actorRoles: [{
      role: evidenceType === "explicit_self_description" ? "speaker" : "experiencer",
      actorRole: "user",
      actorKey: "user",
      isPrimary: true,
    }],
  });
  repository.linkSource(memory.id, source.id, "evidence", {
    authority: evidenceType === "explicit_self_description"
      ? "subject_firsthand"
      : evidenceType === "third_party_description" ? "hearsay" : "direct_observation",
    sourceTrust: 0.9,
    evidenceStrength: 1,
    provenance: "test",
  });
  const positive = tendencyPresence === "present";
  const observation = repository.recordStateEvidenceObservation({
    id: `observation-${id}`,
    agentId: "agent-test",
    stateFamily: "disposition",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    memoryId: memory.id,
    evidenceGroupId: `event:${id}`,
    contextId: `context:${id}`,
    signal: positive ? "explicit_disposition" : "disposition_absent",
    claimedDirection: positive ? "support" : "opposition",
    effectiveDirection: qualification === "qualified"
      ? (positive ? "support" : "opposition")
      : "neutral",
    qualification,
    confidence: 0.9,
    origin: "deterministic",
    scope: { matchedLabel, situationLabel, responseLabel, timeState, crossContext },
    payloadSchemaVersion: "memory-disposition-evidence-v2",
    payload: {
      targetMatch,
      matchedLabel,
      tendencyPresence,
      evidenceType,
      crossContext,
      externalConstraint,
      timeState,
      situationLabel,
      responseLabel,
      revisionCue,
    },
    excludedReason: qualification === "qualified" ? "" : "disposition-evidence-not-direct",
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

function review(repository) {
  return reviewReportedDispositionState({
    repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    subjectLabel: "用户",
    dispositionLabel: "做决定前先研究",
  });
}

test("creates a reported self-description without establishing an objective disposition", () => {
  const fixture = setup();
  const evidence = addObservation(fixture.repository, { id: "self-description" });
  const result = review(fixture.repository);
  assert.equal(result.status, "ready");
  assert.equal(result.action, "create");
  assert.equal(result.proposedState.kind, "belief_state");
  assert.equal(result.proposedState.statePhase, "active");
  assert.equal(result.proposedState.representationLayer, "reported");
  assert.equal(result.proposedState.dispositionClaim.objectiveDispositionStatus, "not-established");
  assert.deepEqual(result.proposedState.evidenceObservationIds, [evidence.observation.id]);
  assert.equal(result.automaticEstablishedDispositionWriteAllowed, false);
  fixture.database.close();
});

test("does not turn another person's judgment into the target's self-description", () => {
  const fixture = setup();
  addObservation(fixture.repository, {
    id: "third-party",
    sourceContent: "我觉得他每次决定前都想太多。",
    evidenceType: "third_party_description",
    qualification: "unresolved",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.truthBoundary, undefined);
  assert.equal(result.automaticTargetPersonalityWriteAllowed, false);
  fixture.database.close();
});

test("does not turn one observed response into a reported disposition", () => {
  const fixture = setup();
  addObservation(fixture.repository, {
    id: "single-response",
    sourceContent: "这一次决定前查了资料。",
    evidenceMode: "observed",
    evidenceType: "single_response",
    qualification: "excluded",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.automaticBehaviorEvidenceWriteAllowed, false);
  fixture.database.close();
});

test("does not let an established disposition occupy the reported layer", () => {
  const fixture = setup({ withEstablished: true });
  addObservation(fixture.repository, { id: "self-with-established" });
  const result = review(fixture.repository);
  assert.equal(result.action, "create");
  assert.equal(result.currentStateId, "");
  assert.equal(fixture.repository.getMemory("current-established-disposition").status, "active");
  fixture.database.close();
});

test("keeps opposite self-descriptions unresolved without an explicit change", () => {
  const fixture = setup();
  addObservation(fixture.repository, { id: "present", observedAt: "2026-07-10T12:00:00.000Z" });
  addObservation(fixture.repository, {
    id: "absent",
    observedAt: "2026-07-11T12:00:00.000Z",
    sourceContent: "我不是每次决定前都会先查资料。",
    tendencyPresence: "absent",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "multiple-unresolved-direct-states-without-change-cue");
  fixture.database.close();
});

test("explicit self-assessment change supersedes only the reported layer", () => {
  const fixture = setup({ withCurrent: true, withEstablished: true });
  const evidence = addObservation(fixture.repository, {
    id: "changed",
    sourceContent: "我现在改了，做决定时不会总先查资料了。",
    tendencyPresence: "absent",
    timeState: "changed",
    revisionCue: "changed",
  });
  linkCurrent(fixture.repository, fixture.current, evidence, "challenged_by");
  const result = review(fixture.repository);
  assert.equal(result.action, "supersede");
  assert.equal(result.proposedState.dispositionClaim.presence, "absent");
  assert.equal(result.truthBoundary.establishedDispositionIsUnaffected, true);
  assert.equal(fixture.repository.getMemory("current-established-disposition").status, "active");
  fixture.database.close();
});

test("a clarified opposite situation becomes a scoped exception", () => {
  const fixture = setup({ withCurrent: true });
  const evidence = addObservation(fixture.repository, {
    id: "work-exception",
    sourceContent: "工作上赶时间时我不会先查资料，其他时候会。",
    tendencyPresence: "absent",
    situationLabel: "工作上赶时间",
    revisionCue: "clarified",
  });
  linkCurrent(fixture.repository, fixture.current, evidence, "challenged_by");
  const result = review(fixture.repository);
  assert.equal(result.action, "add_scoped_exception");
  assert.equal(result.truthBoundary.scopedExceptionPreservesBroaderHistory, true);
  fixture.database.close();
});

test("denial of an old attribution remains a reviewable correction, not an automatic rewrite", () => {
  const fixture = setup({ withCurrent: true });
  const evidence = addObservation(fixture.repository, {
    id: "deny-attribution",
    sourceContent: "我从来没觉得自己做决定前总要查资料。",
    tendencyPresence: "absent",
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
