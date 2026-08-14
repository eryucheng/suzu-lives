import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRepository, openMemoryDatabase } from "@suzu-lives/memory-core";
import { evaluateAffectiveAssociationEvidence } from "../src/index.mjs";
const KEY = "user:affective:science-museum:nostalgia";
function setup({ withCurrent = false, currentRepresentationLayer = "unspecified" } = {}) {
  const database = openMemoryDatabase(":memory:"); const repository = new MemoryRepository(database);
  const add = ({ id, content, sourceContent, speakerRole = "user", speakerKey = "user", sourceSpeaker = "User" }) => {
    const source = repository.upsertSource({ agentId: "agent-test", sourceKind: "conversation", externalId: `source-${id}`,
      occurredAt: "2026-07-10T12:00:00.000Z", speaker: sourceSpeaker, content: sourceContent });
    const memory = repository.upsertMemory({ id, agentId: "agent-test", kind: "event", layer: "semantic", content,
      subjectRole: "user", subjectKey: "user", reality: "real", evidenceMode: "explicit", temporalState: "current",
      eventStart: "2026-07-10T12:00:00.000Z", knownAt: "2026-07-10T12:00:00.000Z",
      actorRoles: [{ role: "speaker", actorRole: speakerRole, actorKey: speakerKey, isPrimary: true },
        { role: "experiencer", actorRole: "user", actorKey: "user" }] });
    repository.linkSource(memory.id, source.id, "evidence", { authority: speakerRole === "user" ? "subject_firsthand" : "model_inference",
      sourceTrust: 0.95, evidenceStrength: 1, provenance: "test" }); return { memory, source };
  };
  let current = null;
  if (withCurrent) {
    const source = repository.upsertSource({ agentId: "agent-test", sourceKind: "conversation", externalId: "source-current-affective",
      occurredAt: "2026-07-01T08:00:00.000Z", speaker: "User", content: "每次想到科技馆我都会怀念那次出行。" });
    const memory = repository.upsertMemory({ id: "current-affective", agentId: "agent-test", kind: "derived_hypothesis",
      layer: "semantic", content: "科技馆会引起用户的怀念感。", subjectRole: "user", subjectKey: "user",
      canonicalKey: KEY, representationLayer: currentRepresentationLayer, reality: "real",
      stateFamily: "affective_association", statePhase: "active",
      evidenceMode: "inferred", temporalState: "current",
      knownAt: "2026-07-01T08:00:00.000Z", validFrom: "2026-07-01T08:00:00.000Z",
      actorRoles: [{ role: "experiencer", actorRole: "user", actorKey: "user", isPrimary: true }] });
    repository.linkSource(memory.id, source.id, "evidence", { authority: "subject_firsthand", sourceTrust: 0.95,
      evidenceStrength: 1, provenance: "test" }); current = { memory, source };
  }
  return { database, repository, add, current };
}
function common(record) { return { memoryId: record.memory.id, sourceIds: [record.source.id], confidence: 0.9,
  rationale: "直接来源支持该字段。" }; }
function analyzersFor(record, {
  targetMatch = "exact", triggerType = "place", triggerLabel = "科技馆", emotionLabel = "怀念",
  valence = "positive", intensity = "medium", experiencerMatch = "yes", attribution = "explicit_self_report",
  associationType = "explicit_trigger_link", causality = "explicit", recurrence = "one_off",
  stateTime = "current", changeCue = "none", currentStatePresent = false,
  relation = "no_current_state", scopeOverlap = "none",
} = {}) {
  return {
    triggerEmotion: async () => ({ output: { analyses: [{ ...common(record), targetMatch, triggerType, triggerLabel,
      emotionLabel, valence, intensity }] } }),
    experiencerAttribution: async () => ({ output: { analyses: [{ ...common(record), experiencerMatch, attribution }] } }),
    associationBasis: async () => ({ output: { analyses: [{ ...common(record), associationType, causality, recurrence }] } }),
    timeRevision: async () => ({ output: { analyses: [{ ...common(record), stateTime, changeCue }] } }),
    currentRelation: async () => ({ output: { analyses: [{ ...common(record), currentStatePresent, relation, scopeOverlap }] } }),
  };
}
function evaluate(fixture, record, analyzers, overrides = {}) { return evaluateAffectiveAssociationEvidence({
  repository: fixture.repository, agentId: "agent-test", subjectRole: "user", subjectKey: "user",
  triggerRole: "other", triggerKey: "place:science-museum", triggerLabel: "科技馆", canonicalKey: KEY,
  associationLabel: "科技馆引起的怀念", memoryIds: [record.memory.id], analyzers, ...overrides }); }

test("keeps one explicit trigger report as evidence without enabling emotional retrieval bias", async () => {
  const fixture = setup(); const record = fixture.add({ id: "one-trigger", content: "用户说科技馆让自己想起那次出行并感到怀念。",
    sourceContent: "一想到科技馆，我就会怀念那次出行。" });
  const before = Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const result = await evaluate(fixture, record, analyzersFor(record));
  assert.equal(result.observations[0].qualification, "qualified"); assert.equal(result.observations[0].signal, "explicit_trigger_link");
  assert.equal(result.actionPreviews[0].action, "accumulate_evidence"); assert.equal(result.activationBiasAllowed, false);
  assert.equal(Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count), before);
  fixture.database.close();
});
test("keeps a direct repeated trigger claim as repeated-pattern evidence", async () => {
  const fixture = setup(); const record = fixture.add({ id: "repeated-trigger", content: "用户说每次看到科技馆照片都会怀念。",
    sourceContent: "每次看到科技馆的照片，我都会有点怀念。" });
  const result = await evaluate(fixture, record, analyzersFor(record, { associationType: "repeated_pattern", recurrence: "repeated_claim" }));
  assert.equal(result.observations[0].qualification, "qualified"); assert.equal(result.observations[0].signal, "repeated_affective_pattern");
  fixture.database.close();
});
test("does not infer a trigger from one emotional cooccurrence", async () => {
  const fixture = setup(); const record = fixture.add({ id: "cooccurrence", content: "用户在科技馆时因为别的消息难过。",
    sourceContent: "在科技馆的时候刚好收到坏消息，我那时很难过。" });
  const result = await evaluate(fixture, record, analyzersFor(record, { emotionLabel: "难过", valence: "negative",
    associationType: "single_cooccurrence", causality: "none" }));
  assert.equal(result.observations[0].qualification, "unresolved"); assert.equal(result.observations[0].excluded_reason, "single-cooccurrence-does-not-prove-trigger-link");
  fixture.database.close();
});
test("does not turn current mood or a general preference into an affective association", async () => {
  const moodFixture = setup(); const mood = moodFixture.add({ id: "current-mood", content: "用户现在心情难过，同时提到科技馆。",
    sourceContent: "我现在有点难过，刚好又看见科技馆。" });
  const moodResult = await evaluate(moodFixture, mood, analyzersFor(mood, { emotionLabel: "难过", valence: "negative",
    associationType: "current_mood", causality: "none", stateTime: "temporary" }));
  assert.equal(moodResult.observations[0].qualification, "excluded"); moodFixture.database.close();
  const prefFixture = setup(); const pref = prefFixture.add({ id: "preference", content: "用户喜欢科技馆。", sourceContent: "我喜欢科技馆。" });
  const prefResult = await evaluate(prefFixture, pref, analyzersFor(pref, { emotionLabel: "喜欢", associationType: "general_preference", causality: "none" }));
  assert.equal(prefResult.observations[0].qualification, "excluded"); prefFixture.database.close();
});
test("does not turn the Agent's tone inference into the user's emotional link", async () => {
  const fixture = setup(); const record = fixture.add({ id: "agent-inference", content: "Agent 猜测科技馆让用户怀念。",
    sourceContent: "听语气我觉得科技馆让用户很怀念。", sourceSpeaker: "Agent", speakerRole: "agent", speakerKey: "agent-test" });
  const result = await evaluate(fixture, record, analyzersFor(record, { attribution: "model_inference" }));
  assert.equal(result.observations[0].qualification, "unresolved"); fixture.database.close();
});
test("retires only an explicitly extinguished same-scope link", async () => {
  const fixture = setup({ withCurrent: true }); const record = fixture.add({ id: "extinguished", content: "用户明确说科技馆已不再引起怀念。",
    sourceContent: "现在再想到科技馆已经不会怀念了。" });
  const result = await evaluate(fixture, record, analyzersFor(record, { changeCue: "extinguished", currentStatePresent: true,
    relation: "retires", scopeOverlap: "exact" }));
  assert.equal(result.actionPreviews[0].action, "retire"); assert.equal(fixture.repository.getMemory(fixture.current.memory.id).status, "active");
  fixture.database.close();
});
test("supersedes a current link only when the subject reports the emotion changed", async () => {
  const fixture = setup({ withCurrent: true }); const record = fixture.add({ id: "emotion-changed", content: "用户说现在想到科技馆主要感到平静。",
    sourceContent: "以前会怀念，现在想到科技馆更多是平静。" });
  const result = await evaluate(fixture, record, analyzersFor(record, { emotionLabel: "平静", valence: "positive", changeCue: "emotion_changed",
    currentStatePresent: true, relation: "emotion_changed", scopeOverlap: "exact" }));
  assert.equal(result.actionPreviews[0].action, "supersede"); fixture.database.close();
});
test("keeps provider failure as audit only", async () => {
  const fixture = setup(); const record = fixture.add({ id: "provider-failure", content: "用户描述情绪触发。",
    sourceContent: "想到科技馆我会怀念。" }); const analyzers = analyzersFor(record);
  analyzers.associationBasis = async () => { throw new Error("provider unavailable"); };
  const result = await evaluate(fixture, record, analyzers); assert.equal(result.status, "incomplete");
  assert.deepEqual(result.failedRoles, ["associationBasis"]); assert.deepEqual(result.observations, []); fixture.database.close();
});
test("rejects a current-state comparison that invents an absent affective link", async () => {
  const fixture = setup(); const record = fixture.add({ id: "invented-current", content: "用户描述情绪触发。",
    sourceContent: "想到科技馆我会怀念。" });
  const result = await evaluate(fixture, record, analyzersFor(record, { currentStatePresent: true, relation: "supports", scopeOverlap: "exact" }));
  assert.equal(result.status, "incomplete"); assert.deepEqual(result.failedRoles, ["currentRelation"]); fixture.database.close();
});
test("compares affective evidence only with the caller-selected representation layer", async () => {
  const fixture = setup({ withCurrent: true, currentRepresentationLayer: "established" });
  const record = fixture.add({ id: "reported-layer", content: "用户直接报告科技馆会引起怀念。",
    sourceContent: "每次想到科技馆，我都会怀念那次出行。" });
  const result = await evaluate(fixture, record, analyzersFor(record), {
    currentRepresentationLayer: "reported",
  });
  assert.equal(result.snapshot.currentState, null);
  assert.equal(result.snapshot.target.currentRepresentationLayer, "reported");
  assert.equal(result.snapshot.inputPolicy.currentStateLayerIsFixedByCaller, true);
  assert.equal(result.observations[0].scope.currentRepresentationLayer, "reported");
  assert.equal(result.actionPreviews[0].action, "accumulate_evidence");
  assert.equal(fixture.repository.getMemory(fixture.current.memory.id).representation_layer, "established");
  fixture.database.close();
});
