import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRepository, openMemoryDatabase } from "@suzu-lives/memory-core";
import {
  evaluateIdentityEvidence,
  reviewReportedIdentityState,
} from "../src/index.mjs";

const KEY = "user:identity:residence:current";

function setup({ currentLayer = "", field = "residence", value = "杭州", cardinality = "sequence" } = {}) {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  let current = null;
  if (currentLayer) {
    current = repository.upsertMemory({
      id: `current-${currentLayer}-identity`,
      agentId: "agent-test",
      kind: "fact",
      layer: "semantic",
      content: `用户报告的${field}是${value}。`,
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: KEY,
      representationLayer: currentLayer,
      stateFamily: "identity",
      statePhase: "active",
      reality: "real",
      evidenceMode: currentLayer === "reported" ? "explicit" : "observed",
      temporalState: "current",
      knownAt: "2026-07-01T08:00:00.000Z",
      validFrom: "2026-07-01T08:00:00.000Z",
      metadata: {
        identityClaim: {
          identityField: field,
          identityLabel: "当前长期居住地",
          valueText: value,
          fieldCardinality: cardinality,
          scope: { valueScope: "长期居住地" },
          holderStatementStatus: currentLayer === "reported" ? "directly-reported" : "externally-supported",
          externalVerificationStatus: currentLayer === "reported" ? "unverified" : "verified",
        },
      },
      actorRoles: [{ role: "subject", actorRole: "user", actorKey: "user", isPrimary: true }],
    });
  }
  return { database, repository, current };
}

function add(fixture, {
  id,
  text,
  observedAt = "2026-07-10T12:00:00.000Z",
  speakerRole = "user",
  speakerKey = "user",
} = {}) {
  const source = fixture.repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: `source-${id}`,
    occurredAt: observedAt,
    speaker: speakerRole === "user" ? "User" : "Agent",
    content: text,
  });
  const memory = fixture.repository.upsertMemory({
    id,
    agentId: "agent-test",
    kind: "event",
    layer: "semantic",
    content: text,
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    evidenceMode: "explicit",
    temporalState: "current",
    eventStart: observedAt,
    knownAt: observedAt,
    actorRoles: [
      { role: "speaker", actorRole: speakerRole, actorKey: speakerKey, isPrimary: true },
      { role: "subject", actorRole: "user", actorKey: "user" },
    ],
  });
  fixture.repository.linkSource(memory.id, source.id, "evidence", {
    authority: speakerRole === "user" ? "subject_firsthand" : "model_inference",
    sourceTrust: 0.9,
    evidenceStrength: 1,
    provenance: "test",
  });
  return { memory, source };
}

function common(record) {
  return { memoryId: record.memory.id, sourceIds: [record.source.id], confidence: 0.9, rationale: "来源直接支持。" };
}

function analyzers(record, {
  identityField = "residence",
  valueText = "上海",
  statementPolarity = "asserts",
  attribution = "explicit_self_report",
  classification = "identity_fact",
  sensitivity = "personal",
  factTime = "current",
  revisionCue = "none",
  currentStatePresent = false,
  relation = "no_current_state",
  valueOverlap = "none",
} = {}) {
  return {
    fieldValue: async () => ({ output: { analyses: [{ ...common(record), targetMatch: "exact",
      identityField, valueText, statementPolarity, valueScope: "长期居住地" }] } }),
    subjectAttribution: async () => ({ output: { analyses: [{ ...common(record), subjectMatch: "yes", attribution }] } }),
    familyBoundary: async () => ({ output: { analyses: [{ ...common(record), classification, sensitivity }] } }),
    timeRevision: async () => ({ output: { analyses: [{ ...common(record), factTime, revisionCue, timeReference: "" }] } }),
    currentRelation: async () => ({ output: { analyses: [{ ...common(record), currentStatePresent, relation, valueOverlap }] } }),
  };
}

async function evaluate(fixture, record, options = {}, overrides = {}) {
  return evaluateIdentityEvidence({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    identityField: options.identityField || "residence",
    identityLabel: "当前长期居住地",
    fieldCardinality: overrides.fieldCardinality || "sequence",
    memoryIds: [record.memory.id],
    analyzers: analyzers(record, options),
    currentRepresentationLayer: Object.hasOwn(overrides, "currentRepresentationLayer")
      ? overrides.currentRepresentationLayer
      : "reported",
  });
}

function review(fixture) {
  return reviewReportedIdentityState({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    subjectLabel: "用户",
    identityLabel: "当前长期居住地",
  });
}

function linkCurrent(fixture, record, relation = "supported_by") {
  fixture.repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: fixture.current.id,
    toMemoryId: record.memory.id,
    relation,
    direction: "directed",
    weight: 0.9,
    confidence: 0.9,
    provenance: "test",
  });
}

test("creates an unverified reported identity without establishing an external fact", async () => {
  const fixture = setup();
  const record = add(fixture, { id: "direct-residence", text: "我现在长期住在上海。" });
  await evaluate(fixture, record);
  const result = review(fixture);
  assert.equal(result.action, "create");
  assert.equal(result.proposedState.kind, "fact");
  assert.equal(result.proposedState.representationLayer, "reported");
  assert.equal(result.proposedState.identityClaim.externalVerificationStatus, "unverified");
  assert.equal(result.automaticEstablishedIdentityWriteAllowed, false);
  fixture.database.close();
});

test("does not disguise a direct system record as the subject's own report", async () => {
  const fixture = setup();
  const record = add(fixture, { id: "system-record", text: "账户资料中的长期居住城市为上海。" });
  await evaluate(fixture, record, { attribution: "direct_system_record" });
  const result = review(fixture);
  assert.equal(result.status, "skipped");
  assert.equal(result.automaticExternalAccountSyncAllowed, false);
  fixture.database.close();
});

test("does not let established identity occupy the reported layer", async () => {
  const fixture = setup({ currentLayer: "established" });
  const record = add(fixture, { id: "reported-over-established", text: "我现在长期住在上海。" });
  await evaluate(fixture, record);
  const result = review(fixture);
  assert.equal(result.action, "create");
  assert.equal(result.currentStateId, "");
  assert.equal(result.snapshot.currentState, null);
  assert.equal(fixture.repository.getMemory(fixture.current.id).status, "active");
  fixture.database.close();
});

test("rejects identity evidence compared against an unspecified layer", async () => {
  const fixture = setup();
  const record = add(fixture, { id: "unspecified-layer", text: "我现在长期住在上海。" });
  await evaluate(fixture, record, {}, { currentRepresentationLayer: "" });
  const result = review(fixture);
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "no-qualified-direct-current-identity-report");
  fixture.database.close();
});

test("keeps different direct identity reports unresolved without a change cue", async () => {
  const fixture = setup();
  const first = add(fixture, { id: "hangzhou", text: "我现在长期住在杭州。", observedAt: "2026-07-10T12:00:00.000Z" });
  const second = add(fixture, { id: "shanghai", text: "我现在长期住在上海。", observedAt: "2026-07-11T12:00:00.000Z" });
  await evaluate(fixture, first, { valueText: "杭州" });
  await evaluate(fixture, second, { valueText: "上海" });
  const result = review(fixture);
  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "multiple-unresolved-direct-states-without-change-cue");
  fixture.database.close();
});

test("supersedes only the reported sequence after an explicit residence change", async () => {
  const fixture = setup({ currentLayer: "reported" });
  const record = add(fixture, { id: "moved", text: "我已经从杭州搬到上海长期住了。" });
  await evaluate(fixture, record, {
    revisionCue: "changed",
    currentStatePresent: true,
    relation: "value_changed",
  });
  linkCurrent(fixture, record, "challenged_by");
  const result = review(fixture);
  assert.equal(result.action, "supersede");
  assert.equal(result.proposedState.identityClaim.valueText, "上海");
  assert.equal(result.truthBoundary.establishedIdentityIsUnaffected, true);
  assert.equal(fixture.repository.getMemory(fixture.current.id).status, "active");
  fixture.database.close();
});

test("requires another canonical key for an additional multi-value identity item", async () => {
  const fixture = setup({ currentLayer: "reported", field: "alias", value: "小铃", cardinality: "multi_item" });
  const record = add(fixture, { id: "other-alias", text: "我也使用别名小五。" });
  await evaluate(fixture, record, {
    identityField: "alias",
    valueText: "小五",
    currentStatePresent: true,
    relation: "additional_value",
  }, { fieldCardinality: "multi_item" });
  linkCurrent(fixture, record);
  const result = review(fixture);
  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "multi-value-identity-item-requires-a-value-scoped-canonical-key");
  fixture.database.close();
});

test("retires only the reported identity sequence after an explicit ending", async () => {
  const fixture = setup({ currentLayer: "reported" });
  const record = add(fixture, { id: "residence-ended", text: "我已经不住在杭州了。" });
  await evaluate(fixture, record, {
    valueText: "杭州",
    statementPolarity: "denies",
    revisionCue: "ended",
    currentStatePresent: true,
    relation: "retires",
    valueOverlap: "exact",
  });
  linkCurrent(fixture, record, "challenged_by");
  const result = review(fixture);
  assert.equal(result.action, "retire");
  assert.equal(result.proposedState, null);
  assert.equal(fixture.repository.getMemory(fixture.current.id).status, "active");
  fixture.database.close();
});

test("corrects a denied reported attribution without creating a replacement identity", async () => {
  const fixture = setup({ currentLayer: "reported" });
  const record = add(fixture, { id: "wrong-attribution", text: "我从没说过自己住在杭州，那条记录不是我的。" });
  await evaluate(fixture, record, {
    valueText: "杭州",
    statementPolarity: "denies",
    revisionCue: "denies_prior_state",
    currentStatePresent: true,
    relation: "same_scope_conflict",
    valueOverlap: "exact",
  });
  linkCurrent(fixture, record, "challenged_by");
  const result = review(fixture);
  assert.equal(result.action, "correct_attribution");
  assert.equal(result.proposedState, null);
  assert.equal(result.automaticCredentialWriteAllowed, false);
  fixture.database.close();
});
