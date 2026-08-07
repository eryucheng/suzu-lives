import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRepository, openMemoryDatabase } from "@suzu-lives/memory-core";
import { evaluateIdentityEvidence } from "../src/index.mjs";

const KEY = "user:identity:residence:current";

function setup({ currentLayer = "" } = {}) {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const add = ({
    id,
    sourceContent,
    observedAt = "2026-07-10T12:00:00.000Z",
    speakerRole = "user",
    speakerKey = "user",
  }) => {
    const source = repository.upsertSource({
      agentId: "agent-test",
      sourceKind: "conversation",
      externalId: `source-${id}`,
      occurredAt: observedAt,
      speaker: speakerRole === "user" ? "User" : "Agent",
      content: sourceContent,
    });
    const memory = repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "semantic",
      content: sourceContent,
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
    repository.linkSource(memory.id, source.id, "evidence", {
      authority: speakerRole === "user" ? "subject_firsthand" : "model_inference",
      sourceTrust: speakerRole === "user" ? 0.95 : 0.4,
      evidenceStrength: 1,
      provenance: "test",
    });
    return { memory, source };
  };
  let current = null;
  if (currentLayer) {
    current = repository.upsertMemory({
      id: `current-${currentLayer}-residence`,
      agentId: "agent-test",
      kind: "fact",
      layer: "semantic",
      content: "用户当前长期居住在杭州。",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: KEY,
      stateFamily: "identity",
      statePhase: "active",
      representationLayer: currentLayer,
      reality: "real",
      evidenceMode: currentLayer === "reported" ? "explicit" : "observed",
      temporalState: "current",
      knownAt: "2026-07-01T08:00:00.000Z",
      validFrom: "2026-07-01T08:00:00.000Z",
      metadata: {
        identityClaim: {
          identityField: "residence",
          valueText: "杭州",
          fieldCardinality: "sequence",
          scope: { valueScope: "长期居住地" },
        },
      },
      actorRoles: [{ role: "subject", actorRole: "user", actorKey: "user", isPrimary: true }],
    });
  }
  return { database, repository, add, current };
}

function common(record) {
  return {
    memoryId: record.memory.id,
    sourceIds: [record.source.id],
    confidence: 0.9,
    rationale: "直接来源支持该字段。",
  };
}

function analyzersFor(record, {
  targetMatch = "exact",
  identityField = "residence",
  valueText = "上海",
  statementPolarity = "asserts",
  valueScope = "长期居住地",
  subjectMatch = "yes",
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
    fieldValue: async () => ({ output: { analyses: [{
      ...common(record), targetMatch, identityField, valueText, statementPolarity, valueScope,
    }] } }),
    subjectAttribution: async () => ({ output: { analyses: [{
      ...common(record), subjectMatch, attribution,
    }] } }),
    familyBoundary: async () => ({ output: { analyses: [{
      ...common(record), classification, sensitivity,
    }] } }),
    timeRevision: async () => ({ output: { analyses: [{
      ...common(record), factTime, revisionCue, timeReference: "",
    }] } }),
    currentRelation: async () => ({ output: { analyses: [{
      ...common(record), currentStatePresent, relation, valueOverlap,
    }] } }),
  };
}

function evaluate(fixture, record, options = {}, overrides = {}) {
  return evaluateIdentityEvidence({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    identityField: "residence",
    identityLabel: "当前长期居住地",
    fieldCardinality: "sequence",
    memoryIds: [record.memory.id],
    analyzers: analyzersFor(record, options),
    ...overrides,
  });
}

test("keeps a direct identity report as bounded evidence without writing a fact", async () => {
  const fixture = setup();
  const record = fixture.add({ id: "residence-report", sourceContent: "我现在长期住在上海。" });
  const before = Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const result = await evaluate(fixture, record);
  assert.equal(result.observations[0].qualification, "qualified");
  assert.equal(result.actionPreviews[0].action, "accumulate_evidence");
  assert.equal(result.automaticStateWriteAllowed, false);
  assert.equal(Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count), before);
  fixture.database.close();
});

test("keeps a direct system record separate from a self report", async () => {
  const fixture = setup();
  const record = fixture.add({ id: "system-residence", sourceContent: "账户资料中的长期居住城市为上海。" });
  const result = await evaluate(fixture, record, { attribution: "direct_system_record" });
  assert.equal(result.observations[0].qualification, "qualified");
  assert.equal(result.observations[0].payload.subject.attribution, "direct_system_record");
  assert.equal(result.automaticExternalVerificationAllowed, false);
  fixture.database.close();
});

test("does not turn an Agent guess into the user's identity", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "inferred-residence",
    sourceContent: "他经常聊上海，我猜他住在上海。",
    speakerRole: "agent",
    speakerKey: "agent-test",
  });
  const result = await evaluate(fixture, record, { attribution: "model_inference" });
  assert.equal(result.observations[0].qualification, "unresolved");
  assert.equal(result.observations[0].effective_direction, "neutral");
  fixture.database.close();
});

test("excludes secrets, transient conditions, relationship roles, and self-concepts", async () => {
  const cases = [
    { id: "secret", text: "我的 API Key 是 sk-secret。", classification: "credential_or_secret", sensitivity: "credential" },
    { id: "temporary", text: "我现在在科技馆。", classification: "transient_condition", sensitivity: "personal" },
    { id: "role", text: "我是你的姐姐。", classification: "relationship_role", sensitivity: "personal" },
    { id: "self", text: "我是一个失败的人。", classification: "self_concept", sensitivity: "personal" },
  ];
  for (const item of cases) {
    const fixture = setup();
    const record = fixture.add({ id: item.id, sourceContent: item.text });
    const result = await evaluate(fixture, record, {
      classification: item.classification,
      sensitivity: item.sensitivity,
    });
    assert.equal(result.observations[0].qualification, "excluded");
    assert.equal(result.actionPreviews[0].action, "no_conclusion");
    fixture.database.close();
  }
});

test("keeps a historical residence out of the current identity state", async () => {
  const fixture = setup();
  const record = fixture.add({ id: "historical-residence", sourceContent: "我以前长期住在杭州。" });
  const result = await evaluate(fixture, record, { valueText: "杭州", factTime: "historical" });
  assert.equal(result.observations[0].qualification, "qualified");
  assert.equal(result.actionPreviews[0].action, "no_conclusion");
  assert.equal(result.actionPreviews[0].reason, "historical-identity-fact-does-not-create-current-state");
  fixture.database.close();
});

test("previews a current sequence change only with an explicit matching change cue", async () => {
  const fixture = setup({ currentLayer: "reported" });
  const record = fixture.add({ id: "changed-residence", sourceContent: "我已经从杭州搬到上海长期住了。" });
  const result = await evaluate(fixture, record, {
    revisionCue: "changed",
    currentStatePresent: true,
    relation: "value_changed",
    valueOverlap: "none",
  }, { currentRepresentationLayer: "reported" });
  assert.equal(result.actionPreviews[0].action, "supersede");
  assert.equal(fixture.repository.getMemory(fixture.current.id).status, "active");
  fixture.database.close();
});

test("requires explicit field cardinality and never lets the model change the fixed field", async () => {
  const fixture = setup();
  const record = fixture.add({ id: "bad-policy", sourceContent: "我现在长期住在上海。" });
  await assert.rejects(() => evaluate(fixture, record, {}, { fieldCardinality: "" }), /cardinality/iu);
  const result = await evaluate(fixture, record, { identityField: "occupation" });
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.failedRoles, ["fieldValue"]);
  fixture.database.close();
});

test("requires a value-scoped canonical key for another multi-value item", async () => {
  const fixture = setup({ currentLayer: "reported" });
  const record = fixture.add({ id: "second-alias", sourceContent: "我也用另一个别名小五。" });
  const result = await evaluate(fixture, record, {
    identityField: "alias",
    valueText: "小五",
    valueScope: "常用别名",
    currentStatePresent: true,
    relation: "additional_value",
    valueOverlap: "none",
  }, {
    identityField: "alias",
    identityLabel: "常用别名",
    fieldCardinality: "multi_item",
    currentRepresentationLayer: "reported",
  });
  assert.equal(result.actionPreviews[0].action, "review_required");
  assert.equal(result.actionPreviews[0].reason, "multi-value-identity-item-requires-a-value-scoped-canonical-key");
  fixture.database.close();
});

test("compares identity evidence only with the selected representation layer", async () => {
  const fixture = setup({ currentLayer: "established" });
  const record = fixture.add({ id: "reported-layer", sourceContent: "我现在长期住在上海。" });
  const result = await evaluate(fixture, record, {}, { currentRepresentationLayer: "reported" });
  assert.equal(result.snapshot.currentState, null);
  assert.equal(result.snapshot.target.currentRepresentationLayer, "reported");
  assert.equal(result.observations[0].scope.currentRepresentationLayer, "reported");
  fixture.database.close();
});

test("keeps a failed specialist as audit only", async () => {
  const fixture = setup();
  const record = fixture.add({ id: "provider-failure", sourceContent: "我现在长期住在上海。" });
  const analyzers = analyzersFor(record);
  analyzers.familyBoundary = async () => { throw new Error("provider unavailable"); };
  const result = await evaluateIdentityEvidence({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    identityField: "residence",
    identityLabel: "当前长期居住地",
    fieldCardinality: "sequence",
    memoryIds: [record.memory.id],
    analyzers,
  });
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.failedRoles, ["familyBoundary"]);
  assert.deepEqual(result.observations, []);
  fixture.database.close();
});
