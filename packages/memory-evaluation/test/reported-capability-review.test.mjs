import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRepository, openMemoryDatabase } from "@suzu-lives/memory-core";
import { reviewReportedCapabilityState } from "../src/index.mjs";

const KEY = "user:capability:node-scripts";

function setup({ withCurrent = false, withEstablished = false } = {}) {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  let current = null;
  if (withCurrent) {
    current = repository.upsertMemory({
      id: "current-reported-capability",
      agentId: "agent-test",
      kind: "fact",
      layer: "semantic",
      content: "用户说自己能独立编写常见 Node.js 脚本。",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: KEY,
      reality: "real",
      evidenceMode: "explicit",
      representationLayer: "reported",
      stateFamily: "capability",
      statePhase: "active",
      temporalState: "current",
      knownAt: "2026-07-01T08:00:00.000Z",
      validFrom: "2026-07-01T08:00:00.000Z",
    });
  }
  if (withEstablished) {
    repository.upsertMemory({
      id: "current-established-capability",
      agentId: "agent-test",
      kind: "derived_hypothesis",
      layer: "semantic",
      content: "多次直接表现支持用户能够编写 Node.js 脚本。",
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
  sourceContent = "我能独立编写和调试常见 Node.js 脚本。",
  evidenceMode = "explicit",
  qualification = "qualified",
  targetMatch = "exact",
  skillLabel = "Node.js 脚本",
  scopeLabel = "编写常见 Node.js 脚本",
  holderAttribution = "explicit_self_statement",
  evidenceType = "self_report",
  proficiencyClaim = "competent",
  independence = "independent",
  dependencyLabel = "",
  repeatability = "claimed_repeatable",
  changeCue = "none",
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
    speaker: evidenceMode === "observed" ? "Tool" : "User",
    content: sourceContent,
  });
  const memory = repository.upsertMemory({
    id: `memory-${id}`,
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: `能力证据：${sourceContent}`,
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    evidenceMode,
    temporalState: "historical",
    eventStart: observedAt,
    knownAt: observedAt,
    actorRoles: [{
      role: evidenceMode === "observed" ? "subject" : "speaker",
      actorRole: "user",
      actorKey: "user",
      isPrimary: true,
    }],
  });
  repository.linkSource(memory.id, source.id, "evidence", {
    authority: evidenceMode === "observed" ? "direct_observation" : "subject_firsthand",
    sourceTrust: 0.95,
    evidenceStrength: 1,
    provenance: "test",
  });
  const support = relation === "no_current_state"
    || ["equivalent", "supports", "broadens", "proficiency_up"].includes(relation);
  const observation = repository.recordStateEvidenceObservation({
    id: `observation-${id}`,
    agentId: "agent-test",
    stateFamily: "capability",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    memoryId: memory.id,
    evidenceGroupId: `event:${id}`,
    contextId: "context:node-scripts",
    signal: evidenceType === "self_report" ? "capability_claim" : "capability_demonstrated_result",
    claimedDirection: support ? "support" : "opposition",
    effectiveDirection: qualification === "qualified" ? (support ? "support" : "opposition") : "neutral",
    qualification,
    confidence: 0.9,
    origin: "deterministic",
    scope: {
      capabilityLabel: "编写 Node.js 脚本",
      scopeLabel,
      proficiencyClaim,
      independence,
      dependencyLabel,
      stateTime: "current",
      currentRelation: relation,
      scopeOverlap,
      currentRepresentationLayer,
    },
    payloadSchemaVersion: "capability-merged-evidence-v1",
    payload: {
      skill: { targetMatch, skillLabel, scopeLabel, taskDifficulty: "intermediate" },
      holder: { holderMatch: "yes", attribution: holderAttribution },
      performance: {
        evidenceType,
        outcome: evidenceType === "self_report" ? "no_result" : "success",
        proficiencyClaim,
        failureCause: "not_applicable",
      },
      conditions: {
        independence,
        dependencyLabel,
        repeatability,
        conditionLabel: "",
      },
      timeRelation: {
        stateTime: "current",
        changeCue,
        currentStatePresent,
        relation,
        scopeOverlap,
      },
    },
    excludedReason: qualification === "qualified" ? "" : "not-a-direct-current-capability-claim",
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
  return reviewReportedCapabilityState({
    repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    subjectLabel: "用户",
    capabilityLabel: "编写 Node.js 脚本",
  });
}

test("creates an unverified reported capability claim without verified proficiency", () => {
  const fixture = setup();
  const evidence = addObservation(fixture.repository, { id: "claim" });
  const before = Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const result = review(fixture.repository);
  assert.equal(result.status, "ready");
  assert.equal(result.action, "create");
  assert.equal(result.proposedState.representationLayer, "reported");
  assert.equal(result.proposedState.capabilityClaim.verificationStatus, "unverified");
  assert.equal(result.proposedState.capabilityClaim.claimedProficiency, "competent");
  assert.deepEqual(result.proposedState.evidenceObservationIds, [evidence.observation.id]);
  assert.equal(result.automaticVerifiedCapabilityWriteAllowed, false);
  assert.equal(Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count), before);
  fixture.database.close();
});

test("does not turn an observed success into a first-person capability claim", () => {
  const fixture = setup();
  addObservation(fixture.repository, {
    id: "observed",
    sourceContent: "脚本运行成功并输出预期结果。",
    evidenceMode: "observed",
    holderAttribution: "direct_observation",
    evidenceType: "demonstrated_result",
    proficiencyClaim: "none",
    repeatability: "one_off",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "no-qualified-direct-current-capability-claim");
  assert.equal(result.automaticPerformanceEvidenceWriteAllowed, false);
  fixture.database.close();
});

test("does not turn another person's or the Agent's assessment into the subject's claim", () => {
  const fixture = setup();
  addObservation(fixture.repository, {
    id: "inference",
    sourceContent: "我觉得用户应该很擅长写 Node.js。",
    holderAttribution: "model_inference",
    qualification: "unresolved",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.automaticVerifiedCapabilityWriteAllowed, false);
  fixture.database.close();
});

test("keeps unresolved different capability claims instead of choosing the newest", () => {
  const fixture = setup();
  addObservation(fixture.repository, {
    id: "basic",
    observedAt: "2026-07-10T12:00:00.000Z",
    proficiencyClaim: "basic",
  });
  addObservation(fixture.repository, {
    id: "advanced",
    observedAt: "2026-07-11T12:00:00.000Z",
    proficiencyClaim: "advanced",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "multiple-unresolved-direct-states-without-change-cue");
  fixture.database.close();
});

test("updates only the reported proficiency after an explicit improvement claim", () => {
  const fixture = setup({ withCurrent: true, withEstablished: true });
  const evidence = addObservation(fixture.repository, {
    id: "improved",
    sourceContent: "我现在已经能熟练处理复杂 Node.js 脚本了。",
    proficiencyClaim: "advanced",
    changeCue: "improved",
    currentStatePresent: true,
    relation: "proficiency_up",
    scopeOverlap: "exact",
  });
  linkCurrent(fixture.repository, fixture.current, evidence);
  const result = review(fixture.repository);
  assert.equal(result.action, "supersede");
  assert.equal(result.currentStateId, fixture.current.id);
  assert.equal(result.snapshot.target.currentRepresentationLayer, "reported");
  assert.equal(result.proposedState.capabilityClaim.claimedProficiency, "advanced");
  assert.equal(fixture.repository.getMemory("current-established-capability").status, "active");
  fixture.database.close();
});

test("retires only the reported claim after an explicit same-scope loss", () => {
  const fixture = setup({ withCurrent: true, withEstablished: true });
  const evidence = addObservation(fixture.repository, {
    id: "lost",
    sourceContent: "太久没用了，我现在已经不会维护这种 Node.js 脚本了。",
    proficiencyClaim: "none",
    changeCue: "lost",
    currentStatePresent: true,
    relation: "retires",
    scopeOverlap: "exact",
  });
  linkCurrent(fixture.repository, fixture.current, evidence, "challenged_by");
  const result = review(fixture.repository);
  assert.equal(result.action, "retire");
  assert.equal(result.proposedState, null);
  assert.equal(fixture.repository.getMemory(fixture.current.id).status, "active");
  assert.equal(fixture.repository.getMemory("current-established-capability").status, "active");
  fixture.database.close();
});

test("requires review before broadening a reported capability scope", () => {
  const fixture = setup({ withCurrent: true });
  const evidence = addObservation(fixture.repository, {
    id: "broaden",
    sourceContent: "我现在什么 Node.js 系统都能开发。",
    scopeLabel: "开发任意 Node.js 系统",
    currentStatePresent: true,
    relation: "broadens",
    scopeOverlap: "partial",
  });
  linkCurrent(fixture.repository, fixture.current, evidence);
  const result = review(fixture.repository);
  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "latest-capability-claim-does-not-prove-a-safe-transition");
  fixture.database.close();
});

test("rejects capability evidence whose current-state comparison targeted another representation layer", () => {
  const fixture = setup();
  addObservation(fixture.repository, {
    id: "established-layer-comparison",
    currentRepresentationLayer: "established",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "no-qualified-direct-current-capability-claim");
  fixture.database.close();
});
