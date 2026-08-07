import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRepository, openMemoryDatabase } from "@suzu-lives/memory-core";
import { reviewReportedGoalState } from "../src/index.mjs";

const KEY = "user:goal:publish-memory-project";

function setup({ withCurrent = false, withEstablished = false } = {}) {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  let current = null;
  if (withCurrent) {
    current = repository.upsertMemory({
      id: "current-reported-goal",
      agentId: "agent-test",
      kind: "plan",
      layer: "prospective",
      content: "用户表示自己计划发布记忆项目。",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: KEY,
      reality: "real",
      evidenceMode: "explicit",
      representationLayer: "reported",
      stateFamily: "goal",
      statePhase: "active",
      temporalState: "in_progress",
      knownAt: "2026-07-01T08:00:00.000Z",
      validFrom: "2026-07-01T08:00:00.000Z",
    });
  }
  if (withEstablished) {
    repository.upsertMemory({
      id: "current-established-goal",
      agentId: "agent-test",
      kind: "plan",
      layer: "prospective",
      content: "持续产出支持该项目正处于执行中。",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: KEY,
      reality: "real",
      evidenceMode: "observed",
      representationLayer: "established",
      temporalState: "in_progress",
      knownAt: "2026-07-20T08:00:00.000Z",
      validFrom: "2026-07-20T08:00:00.000Z",
    });
  }
  return { database, repository, current };
}

function addObservation(repository, {
  id,
  observedAt = "2026-07-10T12:00:00.000Z",
  sourceContent = "我决定把记忆项目发布出来。",
  qualification = "qualified",
  targetMatch = "exact",
  goalText = "发布记忆项目",
  intentionLevel = "plan",
  specificity = "actionable",
  holderMatch = "yes",
  attribution = "explicit_self_statement",
  responsibility = "subject",
  agency = "self_chosen",
  acceptsResponsibility = "yes",
  lifecycle = "active",
  completionBasis = "none",
  currentStatePresent = false,
  relation = "no_current_state",
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
    content: `目标证据：${sourceContent}`,
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
  const supports = relation === "no_current_state"
    || ["same_goal", "progress_update", "pauses", "resumes", "narrower_step"].includes(relation);
  const observation = repository.recordStateEvidenceObservation({
    id: `observation-${id}`,
    agentId: "agent-test",
    stateFamily: "goal",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    memoryId: memory.id,
    evidenceGroupId: `event:${id}`,
    contextId: "context:publish-memory-project",
    signal: `goal_${lifecycle}`,
    claimedDirection: supports ? "support" : "opposition",
    effectiveDirection: qualification === "qualified" ? (supports ? "support" : "opposition") : "neutral",
    qualification,
    confidence: 0.9,
    origin: "deterministic",
    scope: {
      goalLabel: "发布记忆项目",
      targetMatch,
      intentionLevel,
      lifecycle,
      currentRelation: relation,
      currentRepresentationLayer,
    },
    payloadSchemaVersion: "goal-merged-evidence-v1",
    payload: {
      target: { targetMatch, goalText, intentionLevel, specificity },
      holder: { holderMatch, attribution, responsibility, agency, acceptsResponsibility },
      lifecycle: { lifecycle, completionBasis, timeReference: "" },
      relation: { currentStatePresent, relation },
    },
    excludedReason: qualification === "excluded" ? "not-a-current-personal-goal" : "",
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

function review(repository, overrides = {}) {
  return reviewReportedGoalState({
    repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    subjectLabel: "用户",
    goalLabel: "发布记忆项目",
    ...overrides,
  });
}

test("creates a reported goal statement without claiming execution", () => {
  const fixture = setup();
  const evidence = addObservation(fixture.repository, { id: "direct-plan" });
  const before = Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const result = review(fixture.repository);
  assert.equal(result.status, "ready");
  assert.equal(result.action, "create");
  assert.equal(result.proposedState.temporalState, "current");
  assert.equal(result.proposedState.statePhase, "active");
  assert.equal(result.proposedState.representationLayer, "reported");
  assert.equal(result.proposedState.goalClaim.executionStatus, "unverified");
  assert.deepEqual(result.proposedState.evidenceObservationIds, [evidence.observation.id]);
  assert.equal(result.automaticCompletionFactWriteAllowed, false);
  assert.equal(Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count), before);
  fixture.database.close();
});

test("does not turn a wish or Agent inference into the subject's reported goal", () => {
  const fixture = setup();
  addObservation(fixture.repository, {
    id: "wish",
    sourceContent: "希望以后有机会发布。",
    intentionLevel: "wish",
    qualification: "excluded",
  });
  addObservation(fixture.repository, {
    id: "agent-inference",
    sourceContent: "我觉得用户应该想发布。",
    attribution: "agent_inference",
    qualification: "unresolved",
    observedAt: "2026-07-11T12:00:00.000Z",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.automaticReminderOrTaskCreationAllowed, false);
  fixture.database.close();
});

test("does not create a shared commitment from one person's use of we", () => {
  const fixture = setup();
  addObservation(fixture.repository, {
    id: "single-side-we",
    sourceContent: "我们一定会一起把它发布。",
    intentionLevel: "commitment",
    responsibility: "shared",
    agency: "shared_agreement",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.automaticSharedCommitmentWriteAllowed, false);
  fixture.database.close();
});

test("does not let an established execution state occupy the reported layer", () => {
  const fixture = setup({ withEstablished: true });
  addObservation(fixture.repository, { id: "plan-with-established" });
  const result = review(fixture.repository);
  assert.equal(result.action, "create");
  assert.equal(result.currentStateId, "");
  assert.equal(fixture.repository.getMemory("current-established-goal").status, "active");
  fixture.database.close();
});

test("rejects evidence compared against an unspecified state layer", () => {
  const fixture = setup();
  addObservation(fixture.repository, {
    id: "unspecified-layer",
    currentRepresentationLayer: "",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "no-qualified-layer-aligned-direct-goal-statement");
  fixture.database.close();
});

test("keeps different new goals unresolved without an explicit replacement", () => {
  const fixture = setup();
  addObservation(fixture.repository, { id: "publish", observedAt: "2026-07-10T12:00:00.000Z" });
  addObservation(fixture.repository, {
    id: "keep-private",
    observedAt: "2026-07-11T12:00:00.000Z",
    sourceContent: "我决定只留作私人项目。",
    goalText: "只保留私人项目",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "multiple-unresolved-direct-states-without-change-cue");
  fixture.database.close();
});

test("keeps a direct result out of the subject's self-reported completion", () => {
  const fixture = setup({ withCurrent: true });
  const evidence = addObservation(fixture.repository, {
    id: "direct-result",
    sourceContent: "发布产物已经存在。",
    lifecycle: "completed",
    completionBasis: "direct_result",
    currentStatePresent: true,
    relation: "completes",
  });
  linkCurrent(fixture.repository, fixture.current, evidence, "challenged_by");
  const result = review(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.automaticCompletionFactWriteAllowed, false);
  fixture.database.close();
});

test("previews a self-reported completion without writing an objective completion fact", () => {
  const fixture = setup({ withCurrent: true, withEstablished: true });
  const evidence = addObservation(fixture.repository, {
    id: "self-reported-complete",
    sourceContent: "我已经整理完并发布了。",
    lifecycle: "completed",
    completionBasis: "explicit_self_report",
    currentStatePresent: true,
    relation: "completes",
  });
  linkCurrent(fixture.repository, fixture.current, evidence, "challenged_by");
  const result = review(fixture.repository);
  assert.equal(result.action, "complete");
  assert.equal(result.proposedState, null);
  assert.equal(result.truthBoundary.completionFactStatus, "self-reported-only");
  assert.equal(fixture.repository.getMemory(fixture.current.id).status, "active");
  assert.equal(fixture.repository.getMemory("current-established-goal").status, "active");
  fixture.database.close();
});

test("previews pause and progress without replacing the reported goal", () => {
  const pauseFixture = setup({ withCurrent: true });
  const paused = addObservation(pauseFixture.repository, {
    id: "paused",
    sourceContent: "我先暂停，等资料到了再继续。",
    lifecycle: "paused",
    currentStatePresent: true,
    relation: "pauses",
  });
  linkCurrent(pauseFixture.repository, pauseFixture.current, paused);
  const pauseResult = review(pauseFixture.repository);
  assert.equal(pauseResult.action, "pause");
  assert.equal(pauseResult.proposedState.temporalState, "current");
  assert.equal(pauseResult.proposedState.statePhase, "paused");
  pauseFixture.database.close();

  const progressFixture = setup({ withCurrent: true });
  const progress = addObservation(progressFixture.repository, {
    id: "progress",
    sourceContent: "README 已经写到一半了。",
    targetMatch: "subcategory",
    goalText: "完成 README",
    lifecycle: "in_progress",
    currentStatePresent: true,
    relation: "narrower_step",
  });
  linkCurrent(progressFixture.repository, progressFixture.current, progress);
  const progressResult = review(progressFixture.repository);
  assert.equal(progressResult.action, "progress_update");
  assert.equal(progressResult.proposedState, null);
  assert.equal(progressFixture.repository.getMemory(progressFixture.current.id).status, "active");
  progressFixture.database.close();
});
