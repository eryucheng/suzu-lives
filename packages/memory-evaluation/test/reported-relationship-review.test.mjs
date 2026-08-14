import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRepository, openMemoryDatabase } from "@suzu-lives/memory-core";
import { reviewReportedRelationshipState } from "../src/index.mjs";

const KEY = "user:relationship:agent-test:trust";

function setup({ withCurrent = false, withEstablished = false } = {}) {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  let current = null;
  if (withCurrent) {
    current = repository.upsertMemory({
      id: "current-reported-relationship",
      agentId: "agent-test",
      kind: "relationship",
      layer: "relational",
      content: "用户表示自己信任 Agent。",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: KEY,
      reality: "real",
      evidenceMode: "explicit",
      representationLayer: "reported",
      stateFamily: "relationship",
      statePhase: "active",
      temporalState: "current",
      knownAt: "2026-07-01T08:00:00.000Z",
      validFrom: "2026-07-01T08:00:00.000Z",
    });
  }
  if (withEstablished) {
    repository.upsertMemory({
      id: "current-established-relationship",
      agentId: "agent-test",
      kind: "relationship",
      layer: "relational",
      content: "多项独立证据支持该关系结论。",
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
  sourceContent = "我信任你。",
  qualification = "qualified",
  targetMatch = "exact",
  relationType = "trust",
  polarity = "affirms",
  relationLabel = "信任",
  scopeLabel = "",
  conditionLabel = "",
  holderMatch = "yes",
  counterpartMatch = "yes",
  direction = "holder_to_counterpart",
  attribution = "explicit_self_statement",
  stateTime = "current",
  duration = "ongoing",
  revocationCue = "none",
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
    content: `关系证据：${sourceContent}`,
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    evidenceMode: "explicit",
    temporalState: "historical",
    eventStart: observedAt,
    knownAt: observedAt,
    actorRoles: [
      { role: "speaker", actorRole: "user", actorKey: "user", isPrimary: true },
      { role: "participant", actorRole: "agent", actorKey: "agent-test" },
    ],
  });
  repository.linkSource(memory.id, source.id, "evidence", {
    authority: attribution === "explicit_self_statement" ? "subject_firsthand" : "model_inference",
    sourceTrust: 0.95,
    evidenceStrength: 1,
    provenance: "test",
  });
  const supports = relation === "no_current_state" || ["equivalent", "supports", "broadens"].includes(relation);
  const observation = repository.recordStateEvidenceObservation({
    id: `observation-${id}`,
    agentId: "agent-test",
    stateFamily: "relationship",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    memoryId: memory.id,
    evidenceGroupId: `event:${id}`,
    contextId: "context:user-agent-relationship",
    signal: polarity === "withdraws" ? "relationship_revoked" : `relationship_${relationType}`,
    claimedDirection: supports ? "support" : "opposition",
    effectiveDirection: qualification === "qualified" ? (supports ? "support" : "opposition") : "neutral",
    qualification,
    confidence: 0.9,
    origin: "deterministic",
    scope: {
      relationshipLabel: "用户对 Agent 的信任",
      counterpartRole: "agent",
      counterpartKey: "agent-test",
      relationType,
      scopeLabel,
      conditionLabel,
      stateTime,
      duration,
      currentRelation: relation,
      scopeOverlap,
      currentRepresentationLayer,
    },
    payloadSchemaVersion: "relationship-merged-evidence-v1",
    payload: {
      grounding: { targetMatch, relationType, polarity, relationLabel, scopeLabel, conditionLabel },
      perspective: { holderMatch, counterpartMatch, direction, attribution },
      scopeTime: { stateTime, duration, revocationCue },
      relation: { currentStatePresent, relation, scopeOverlap },
    },
    excludedReason: qualification === "excluded" ? "not-a-direct-holder-view" : "",
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
  return reviewReportedRelationshipState({
    repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    counterpartRole: "agent",
    counterpartKey: "agent-test",
    counterpartLabel: "Agent",
    canonicalKey: KEY,
    subjectLabel: "用户",
    relationshipLabel: "用户对 Agent 的信任",
    ...overrides,
  });
}

test("creates only the holder's reported relationship view", () => {
  const fixture = setup();
  const evidence = addObservation(fixture.repository, { id: "direct-trust" });
  const before = Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const result = review(fixture.repository);
  assert.equal(result.status, "ready");
  assert.equal(result.action, "create");
  assert.equal(result.proposedState.subjectRole, "user");
  assert.deepEqual(result.proposedState.counterpart, {
    role: "agent",
    key: "agent-test",
    label: "Agent",
  });
  assert.equal(result.proposedState.relationshipView.truthStatus, "unverified");
  assert.equal(result.proposedState.relationshipView.sharedConfirmation, "unconfirmed");
  assert.deepEqual(result.proposedState.evidenceObservationIds, [evidence.observation.id]);
  assert.equal(result.automaticCounterpartDispositionWriteAllowed, false);
  assert.equal(Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count), before);
  fixture.database.close();
});

test("does not let a later established state occupy the reported layer", () => {
  const fixture = setup({ withEstablished: true });
  addObservation(fixture.repository, { id: "direct-with-established" });
  const result = review(fixture.repository);
  assert.equal(result.action, "create");
  assert.equal(result.currentStateId, "");
  assert.equal(fixture.repository.getMemory("current-established-relationship").status, "active");
  fixture.database.close();
});

test("does not turn an Agent inference into the holder's relationship view", () => {
  const fixture = setup();
  addObservation(fixture.repository, {
    id: "agent-inference",
    sourceContent: "我感觉用户很信任我。",
    attribution: "agent_inference",
    qualification: "unresolved",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.automaticOtherHolderStateWriteAllowed, false);
  fixture.database.close();
});

test("does not promote a single-side mutual claim into a shared relationship", () => {
  const fixture = setup();
  addObservation(fixture.repository, {
    id: "mutual-claim",
    sourceContent: "我们特别亲密。",
    relationType: "closeness",
    relationLabel: "亲密",
    direction: "mutual_claim",
    qualification: "unresolved",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.automaticSharedRelationshipWriteAllowed, false);
  fixture.database.close();
});

test("rejects evidence whose current-state comparison layer is not reported", () => {
  const fixture = setup();
  addObservation(fixture.repository, {
    id: "unknown-comparison-layer",
    currentRepresentationLayer: "",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "no-qualified-layer-aligned-direct-relationship-view");
  fixture.database.close();
});

test("keeps different direct views unresolved without a safe state transition", () => {
  const fixture = setup();
  addObservation(fixture.repository, { id: "trust", observedAt: "2026-07-10T12:00:00.000Z" });
  addObservation(fixture.repository, {
    id: "distrust",
    observedAt: "2026-07-11T12:00:00.000Z",
    sourceContent: "我不信任你。",
    polarity: "denies",
    relationLabel: "不信任",
  });
  const result = review(fixture.repository);
  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "multiple-unresolved-direct-states-without-change-cue");
  fixture.database.close();
});

test("supersedes only the holder's reported view", () => {
  const fixture = setup({ withCurrent: true, withEstablished: true });
  const evidence = addObservation(fixture.repository, {
    id: "changed-view",
    sourceContent: "我现在不再信任你了。",
    polarity: "denies",
    relationLabel: "不信任",
    currentStatePresent: true,
    relation: "replaces",
    scopeOverlap: "exact",
  });
  linkCurrent(fixture.repository, fixture.current, evidence, "challenged_by");
  const result = review(fixture.repository);
  assert.equal(result.action, "supersede");
  assert.equal(result.currentStateId, fixture.current.id);
  assert.equal(result.proposedState.relationshipView.label, "不信任");
  assert.equal(fixture.repository.getMemory("current-established-relationship").status, "active");
  fixture.database.close();
});

test("previews an exact reported permission revocation without changing runtime permission", () => {
  const fixture = setup({ withCurrent: true });
  const evidence = addObservation(fixture.repository, {
    id: "revoke-permission",
    sourceContent: "以后不要再看我的位置。",
    relationType: "permission",
    polarity: "withdraws",
    relationLabel: "撤回位置查看许可",
    scopeLabel: "查看用户当前位置",
    duration: "ended",
    revocationCue: "explicit",
    currentStatePresent: true,
    relation: "revokes",
    scopeOverlap: "exact",
  });
  linkCurrent(fixture.repository, fixture.current, evidence, "challenged_by");
  const result = review(fixture.repository);
  assert.equal(result.action, "revoke");
  assert.equal(result.proposedState, null);
  assert.equal(result.automaticRuntimePermissionChangeAllowed, false);
  assert.equal(fixture.repository.getMemory(fixture.current.id).status, "active");
  fixture.database.close();
});

test("rejects shared holders because two views require bilateral review", () => {
  const fixture = setup();
  addObservation(fixture.repository, { id: "shared-holder" });
  assert.throws(() => review(fixture.repository, {
    subjectRole: "shared",
    subjectKey: "user+agent-test",
  }), /one fixed personal holder/u);
  fixture.database.close();
});
