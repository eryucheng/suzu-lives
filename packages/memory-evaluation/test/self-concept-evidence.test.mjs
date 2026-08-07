import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRepository, openMemoryDatabase } from "@suzu-lives/memory-core";
import { evaluateSelfConceptEvidence } from "../src/index.mjs";

const KEY = "user:self-concept:caretaker-role";
function setup({ withCurrent = false, currentRepresentationLayer = "" } = {}) {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const add = ({ id, content, sourceContent, sourceSpeaker = "User", speakerRole = "user", speakerKey = "user" }) => {
    const source = repository.upsertSource({ agentId: "agent-test", sourceKind: "conversation",
      externalId: `source-${id}`, occurredAt: "2026-07-10T12:00:00.000Z", speaker: sourceSpeaker,
      content: sourceContent });
    const memory = repository.upsertMemory({ id, agentId: "agent-test", kind: "event", layer: "semantic",
      content, subjectRole: "user", subjectKey: "user", reality: "real", evidenceMode: "explicit",
      temporalState: "current", eventStart: "2026-07-10T12:00:00.000Z", knownAt: "2026-07-10T12:00:00.000Z",
      actorRoles: [{ role: "speaker", actorRole: speakerRole, actorKey: speakerKey, isPrimary: true },
        { role: "participant", actorRole: "user", actorKey: "user" }] });
    repository.linkSource(memory.id, source.id, "evidence", { authority: speakerRole === "user" ? "subject_firsthand" : "model_inference",
      sourceTrust: 0.95, evidenceStrength: 1, provenance: "test" });
    return { memory, source };
  };
  let current = null;
  if (withCurrent) {
    const source = repository.upsertSource({ agentId: "agent-test", sourceKind: "conversation",
      externalId: "source-current-self-concept", occurredAt: "2026-07-01T08:00:00.000Z", speaker: "User",
      content: "我一直把自己看成需要照顾所有人的人。" });
    const memory = repository.upsertMemory({ id: "current-self-concept", agentId: "agent-test",
      kind: "belief_state", layer: "semantic", content: "用户把自己理解为需要照顾所有人的人。",
      subjectRole: "user", subjectKey: "user", canonicalKey: KEY, reality: "real", evidenceMode: "explicit",
      stateFamily: "self_concept", statePhase: "active",
      representationLayer: currentRepresentationLayer,
      temporalState: "current", knownAt: "2026-07-01T08:00:00.000Z", validFrom: "2026-07-01T08:00:00.000Z",
      actorRoles: [{ role: "belief_holder", actorRole: "user", actorKey: "user", isPrimary: true }] });
    repository.linkSource(memory.id, source.id, "evidence", { authority: "subject_firsthand", sourceTrust: 0.95,
      evidenceStrength: 1, provenance: "test" });
    current = { memory, source };
  }
  return { database, repository, add, current };
}
function common(record) { return { memoryId: record.memory.id, sourceIds: [record.source.id], confidence: 0.9,
  rationale: "直接来源支持该字段。" }; }
function analyzersFor(record, {
  targetMatch = "exact", conceptType = "role_identity", conceptLabel = "照顾者角色", scopeLabel = "一般关系",
  holderMatch = "yes", attribution = "explicit_self_definition", expressionType = "stable_self_definition",
  contextBasis = "single_reflection", stateTime = "current", revisionCue = "none",
  currentStatePresent = false, relation = "no_current_state", scopeOverlap = "none",
} = {}) {
  return {
    conceptGrounding: async () => ({ output: { analyses: [{ ...common(record), targetMatch, conceptType, conceptLabel, scopeLabel }] } }),
    holderAttribution: async () => ({ output: { analyses: [{ ...common(record), holderMatch, attribution }] } }),
    stabilityContext: async () => ({ output: { analyses: [{ ...common(record), expressionType, contextBasis }] } }),
    timeRevision: async () => ({ output: { analyses: [{ ...common(record), stateTime, revisionCue }] } }),
    currentRelation: async () => ({ output: { analyses: [{ ...common(record), currentStatePresent, relation, scopeOverlap }] } }),
  };
}
function evaluate(fixture, record, analyzers, overrides = {}) {
  return evaluateSelfConceptEvidence({ repository: fixture.repository, agentId: "agent-test",
    subjectRole: "user", subjectKey: "user", canonicalKey: KEY, selfConceptLabel: "照顾者自我角色",
    memoryIds: [record.memory.id], analyzers, ...overrides });
}

test("keeps a direct self-definition as evidence without manufacturing objective personality", async () => {
  const fixture = setup();
  const record = fixture.add({ id: "self-definition", content: "用户把自己看作习惯照顾他人的人。",
    sourceContent: "我一直把自己看成会去照顾别人的人。" });
  const before = Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const result = await evaluate(fixture, record, analyzersFor(record));
  assert.equal(result.observations[0].qualification, "qualified");
  assert.equal(result.observations[0].signal, "self_definition");
  assert.equal(result.actionPreviews[0].action, "accumulate_evidence");
  assert.equal(Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count), before);
  fixture.database.close();
});

test("keeps a turning-point reflection as reflection evidence, not an invented consequence", async () => {
  const fixture = setup();
  const record = fixture.add({ id: "turning-point-reflection",
    content: "用户反思某次经历后重新理解了自己的照顾者角色。",
    sourceContent: "那件事之后我才意识到，我总觉得自己必须照顾好所有人。" });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    attribution: "explicit_self_reflection", expressionType: "reflective_reinterpretation",
    contextBasis: "turning_point",
  }));
  assert.equal(result.observations[0].qualification, "qualified");
  assert.equal(result.observations[0].signal, "self_reflection");
  fixture.database.close();
});

test("does not freeze acute self-criticism into long-term self-concept", async () => {
  const fixture = setup();
  const record = fixture.add({ id: "acute-self-criticism", content: "用户失败后情绪化地自责。",
    sourceContent: "我怎么什么都做不好，我真没用。" });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    conceptType: "self_description", conceptLabel: "无能", expressionType: "temporary_self_appraisal",
    contextBasis: "acute_emotion", stateTime: "temporary",
  }));
  assert.equal(result.observations[0].qualification, "excluded");
  assert.equal(result.actionPreviews[0].action, "no_conclusion");
  fixture.database.close();
});

test("keeps an objective identity fact out of self-concept", async () => {
  const fixture = setup();
  const record = fixture.add({ id: "identity-fact", content: "用户的职业是教师。",
    sourceContent: "我的职业是教师。" });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    conceptType: "role_identity", conceptLabel: "教师", expressionType: "identity_fact",
    contextBasis: "factual_record",
  }));
  assert.equal(result.observations[0].qualification, "excluded");
  assert.equal(result.observations[0].excluded_reason, "self-concept-identity-fact");
  fixture.database.close();
});

test("does not turn the Agent's personality summary into the user's self-concept", async () => {
  const fixture = setup();
  const record = fixture.add({ id: "agent-summary", content: "Agent 认为用户总是照顾别人。",
    sourceContent: "我觉得用户就是一个照顾者。", sourceSpeaker: "Agent", speakerRole: "agent", speakerKey: "agent-test" });
  const result = await evaluate(fixture, record, analyzersFor(record, { attribution: "model_inference" }));
  assert.equal(result.observations[0].qualification, "unresolved");
  assert.equal(result.observations[0].excluded_reason, "self-concept-is-not-the-holder-own-understanding");
  fixture.database.close();
});

test("supersedes only an explicit current change in self-understanding", async () => {
  const fixture = setup({ withCurrent: true });
  const record = fixture.add({ id: "changed-self-understanding",
    content: "用户明确说现在不再认为自己必须照顾所有人。",
    sourceContent: "我以前觉得自己必须照顾所有人，现在不这么看自己了。" });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    attribution: "explicit_self_reflection", expressionType: "reflective_reinterpretation",
    contextBasis: "turning_point", revisionCue: "changed", currentStatePresent: true,
    relation: "replaces", scopeOverlap: "exact",
  }));
  assert.equal(result.observations[0].qualification, "qualified");
  assert.equal(result.actionPreviews[0].action, "supersede");
  assert.equal(fixture.repository.getMemory(fixture.current.memory.id).status, "active");
  fixture.database.close();
});

test("narrows a scoped clarification instead of replacing the whole narrative", async () => {
  const fixture = setup({ withCurrent: true });
  const record = fixture.add({ id: "scope-clarification",
    content: "用户澄清只在亲近关系中容易承担照顾者角色。",
    sourceContent: "不是对所有人，我只会在很亲近的人面前觉得自己要照顾好对方。" });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    scopeLabel: "亲近关系", attribution: "explicit_self_reflection",
    expressionType: "reflective_reinterpretation", revisionCue: "clarified",
    currentStatePresent: true, relation: "narrows", scopeOverlap: "partial",
  }));
  assert.equal(result.actionPreviews[0].action, "narrow_scope");
  assert.notEqual(result.actionPreviews[0].action, "supersede");
  fixture.database.close();
});

test("corrects attribution only when the subject explicitly denies ever holding it", async () => {
  const fixture = setup({ withCurrent: true });
  const record = fixture.add({ id: "never-held",
    content: "用户明确否认曾把自己理解为必须照顾所有人的人。",
    sourceContent: "我从来没把自己当成必须照顾所有人的人，那是别人给我贴的标签。" });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    attribution: "explicit_self_reflection", expressionType: "reflective_reinterpretation",
    revisionCue: "never_held", currentStatePresent: true, relation: "corrects_attribution",
    scopeOverlap: "exact",
  }));
  assert.equal(result.actionPreviews[0].action, "correct_attribution");
  fixture.database.close();
});

test("keeps a provider failure as audit only and writes no merged self-concept evidence", async () => {
  const fixture = setup();
  const record = fixture.add({ id: "provider-failure", content: "用户定义自己的角色。",
    sourceContent: "我一直把自己看成照顾者。" });
  const analyzers = analyzersFor(record);
  analyzers.stabilityContext = async () => { throw new Error("provider unavailable"); };
  const result = await evaluate(fixture, record, analyzers);
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.failedRoles, ["stabilityContext"]);
  assert.deepEqual(result.observations, []);
  fixture.database.close();
});

test("rejects a current-state comparison that invents an absent self-concept", async () => {
  const fixture = setup();
  const record = fixture.add({ id: "invented-current", content: "用户定义自己的角色。",
    sourceContent: "我一直把自己看成照顾者。" });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    currentStatePresent: true, relation: "supports", scopeOverlap: "exact",
  }));
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.failedRoles, ["currentRelation"]);
  fixture.database.close();
});

test("compares a reported self-concept only against the reported current layer", async () => {
  const fixture = setup({ withCurrent: true, currentRepresentationLayer: "established" });
  const record = fixture.add({ id: "reported-layer-self-concept", content: "用户定义自己的角色。",
    sourceContent: "我一直把自己看成照顾者。" });
  const result = await evaluate(fixture, record, analyzersFor(record), {
    currentRepresentationLayer: "reported",
  });
  assert.equal(result.snapshot.currentState, null);
  assert.equal(result.snapshot.target.currentRepresentationLayer, "reported");
  assert.equal(result.observations[0].scope.currentRepresentationLayer, "reported");
  fixture.database.close();
});
