import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRepository, openMemoryDatabase } from "@suzu-lives/memory-core";
import { evaluateValueEvidence } from "../src/index.mjs";

const KEY = "user:value:keep-promises";

function setup({ withCurrent = false, currentRepresentationLayer = "" } = {}) {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const add = ({
    id,
    content,
    sourceContent,
    sourceSpeaker = "User",
    speakerRole = "user",
    speakerKey = "user",
    occurredAt = "2026-07-10T12:00:00.000Z",
  }) => {
    const source = repository.upsertSource({
      agentId: "agent-test",
      sourceKind: "conversation",
      externalId: `source-${id}`,
      occurredAt,
      speaker: sourceSpeaker,
      content: sourceContent,
    });
    const memory = repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "semantic",
      content,
      subjectRole: "user",
      subjectKey: "user",
      reality: "real",
      evidenceMode: "explicit",
      temporalState: "current",
      eventStart: occurredAt,
      knownAt: occurredAt,
      actorRoles: [
        { role: "speaker", actorRole: speakerRole, actorKey: speakerKey, isPrimary: true },
        { role: "participant", actorRole: "user", actorKey: "user" },
      ],
    });
    repository.linkSource(memory.id, source.id, "evidence", {
      authority: speakerRole === "user" ? "subject_firsthand" : "model_inference",
      sourceTrust: 0.95,
      evidenceStrength: 1,
      provenance: "test",
    });
    return { memory, source };
  };
  let current = null;
  if (withCurrent) {
    const source = repository.upsertSource({
      agentId: "agent-test",
      sourceKind: "conversation",
      externalId: "source-current-keep-promises",
      occurredAt: "2026-07-01T08:00:00.000Z",
      speaker: "User",
      content: "我通常把守信放在便利之前。",
    });
    const memory = repository.upsertMemory({
      id: "current-keep-promises-value",
      agentId: "agent-test",
      kind: "derived_hypothesis",
      layer: "semantic",
      content: "用户在真实取舍中通常优先保护守信。",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: KEY,
      stateFamily: "value",
      statePhase: "active",
      reality: "real",
      evidenceMode: "inferred",
      representationLayer: currentRepresentationLayer,
      temporalState: "current",
      knownAt: "2026-07-01T08:00:00.000Z",
      validFrom: "2026-07-01T08:00:00.000Z",
      actorRoles: [
        { role: "subject", actorRole: "user", actorKey: "user", isPrimary: true },
      ],
    });
    repository.linkSource(memory.id, source.id, "evidence", {
      authority: "subject_firsthand",
      sourceTrust: 0.95,
      evidenceStrength: 1,
      provenance: "test",
    });
    current = { memory, source };
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
  stance = "protects",
  valueLabel = "守信",
  scopeLabel = "一般承诺",
  holderMatch = "yes",
  attribution = "explicit_self_statement",
  evidenceType = "explicit_principle",
  alternatives = "unknown",
  agency = "unknown",
  costType = "none",
  protectedValueMatch = "yes",
  stateTime = "current",
  revisionCue = "none",
  currentStatePresent = false,
  relation = "no_current_state",
  scopeOverlap = "none",
} = {}) {
  return {
    targetStance: async () => ({ output: { analyses: [{
      ...common(record), targetMatch, stance, valueLabel, scopeLabel,
    }] } }),
    holderAttribution: async () => ({ output: { analyses: [{
      ...common(record), holderMatch, attribution,
    }] } }),
    evidenceBasis: async () => ({ output: { analyses: [{
      ...common(record), evidenceType, alternatives, agency, costType, protectedValueMatch,
    }] } }),
    timeRevision: async () => ({ output: { analyses: [{
      ...common(record), stateTime, revisionCue,
    }] } }),
    currentRelation: async () => ({ output: { analyses: [{
      ...common(record), currentStatePresent, relation, scopeOverlap,
    }] } }),
  };
}

function evaluate(fixture, record, analyzers, overrides = {}) {
  return evaluateValueEvidence({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    valueLabel: "守信优先级",
    memoryIds: [record.memory.id],
    analyzers,
    ...overrides,
  });
}

test("keeps a direct principle as evidence without creating a stable value", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "direct-principle",
    content: "用户明确说守信对自己很重要。",
    sourceContent: "对我来说守信很重要。",
  });
  const before = Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const result = await evaluate(fixture, record, analyzersFor(record));
  assert.equal(result.observations[0].qualification, "qualified");
  assert.equal(result.observations[0].signal, "value_principle_evidence");
  assert.equal(result.actionPreviews[0].action, "accumulate_evidence");
  assert.notEqual(result.actionPreviews[0].action, "create");
  assert.equal(
    Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    before,
  );
  fixture.database.close();
});

test("accepts an active costly tradeoff as value evidence but still only accumulates it", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "costly-choice",
    content: "用户本可反悔，但为了守信主动放弃休息并完成承诺。",
    sourceContent: "我本来可以反悔去休息，但既然答应了，就花这个晚上把它完成。",
  });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    evidenceType: "costly_choice",
    alternatives: "present",
    agency: "active",
    costType: "opportunity",
  }));
  assert.equal(result.observations[0].qualification, "qualified");
  assert.equal(result.observations[0].signal, "value_costly_choice_evidence");
  assert.equal(result.actionPreviews[0].action, "accumulate_evidence");
  fixture.database.close();
});

test("does not infer a value from forced overtime or other constrained behavior", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "forced-overtime",
    content: "用户因为单位要求而持续加班。",
    sourceContent: "单位要求必须加班，不做会被处罚。",
  });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    valueLabel: "责任",
    evidenceType: "constrained_behavior",
    alternatives: "absent",
    agency: "constrained",
    costType: "time",
  }));
  assert.equal(result.observations[0].qualification, "excluded");
  assert.equal(result.observations[0].excluded_reason, "behavior-is-constrained-or-instrumental");
  assert.equal(result.actionPreviews[0].action, "no_conclusion");
  fixture.database.close();
});

test("keeps an ordinary low-cost choice unresolved instead of manufacturing a value", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "ordinary-choice",
    content: "用户随手选择了先完成一句承诺。",
    sourceContent: "顺手先把答应的小事做了。",
  });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    evidenceType: "ordinary_choice",
    alternatives: "present",
    agency: "active",
    costType: "none",
  }));
  assert.equal(result.observations[0].qualification, "unresolved");
  assert.equal(result.observations[0].excluded_reason, "ordinary-choice-is-insufficient-value-evidence");
  fixture.database.close();
});

test("supersedes only when the subject explicitly changes the current value", async () => {
  const fixture = setup({ withCurrent: true });
  const record = fixture.add({
    id: "changed-priority",
    content: "用户明确说现在不再把守信置于自身安全之前。",
    sourceContent: "我以前什么承诺都硬撑，现在改了，安全比守信优先。",
  });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    stance: "deprioritizes",
    valueLabel: "守信",
    evidenceType: "reasoned_priority",
    stateTime: "current",
    revisionCue: "changed",
    currentStatePresent: true,
    relation: "replaces",
    scopeOverlap: "exact",
  }));
  assert.equal(result.observations[0].qualification, "qualified");
  assert.equal(result.actionPreviews[0].action, "supersede");
  assert.equal(fixture.repository.getMemory(fixture.current.memory.id).status, "active");
  fixture.database.close();
});

test("keeps a scoped exception as narrowing rather than reversing the broad value", async () => {
  const fixture = setup({ withCurrent: true });
  const record = fixture.add({
    id: "safety-exception",
    content: "用户澄清涉及安全时不会优先守信。",
    sourceContent: "守信还是重要，但涉及安全的承诺不能硬撑。",
  });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    stance: "deprioritizes",
    scopeLabel: "涉及人身安全的承诺",
    evidenceType: "reasoned_priority",
    revisionCue: "clarified",
    currentStatePresent: true,
    relation: "narrows",
    scopeOverlap: "partial",
  }));
  assert.equal(result.observations[0].qualification, "qualified");
  assert.equal(result.actionPreviews[0].action, "narrow_scope");
  assert.notEqual(result.actionPreviews[0].action, "supersede");
  fixture.database.close();
});

test("does not turn the Agent's personality summary into the user's value", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "agent-value-inference",
    content: "Agent 推测用户把守信看得很重。",
    sourceContent: "我觉得用户是个特别重承诺的人。",
    sourceSpeaker: "Agent",
    speakerRole: "agent",
    speakerKey: "agent-test",
  });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    attribution: "model_inference",
  }));
  assert.equal(result.observations[0].qualification, "unresolved");
  assert.equal(
    result.observations[0].excluded_reason,
    "value-is-not-the-holder-direct-expression-or-choice",
  );
  fixture.database.close();
});

test("keeps a provider failure as audit only and writes no merged value evidence", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "value-provider-failure",
    content: "用户明确说守信对自己很重要。",
    sourceContent: "守信对我很重要。",
  });
  const analyzers = analyzersFor(record);
  analyzers.evidenceBasis = async () => {
    throw new Error("provider unavailable");
  };
  const result = await evaluate(fixture, record, analyzers);
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.failedRoles, ["evidenceBasis"]);
  assert.deepEqual(result.observations, []);
  fixture.database.close();
});

test("rejects a current-state comparison that invents an absent value", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "invented-current-value",
    content: "用户明确说守信对自己很重要。",
    sourceContent: "守信对我很重要。",
  });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    currentStatePresent: true,
    relation: "supports",
    scopeOverlap: "exact",
  }));
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.failedRoles, ["currentRelation"]);
  assert.deepEqual(result.observations, []);
  fixture.database.close();
});

test("rejects a shared value holder instead of blending two people", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "shared-value",
    content: "一方声称双方都看重守信。",
    sourceContent: "我们都把守信放第一。",
  });
  await assert.rejects(() => evaluate(fixture, record, analyzersFor(record), {
    subjectRole: "shared",
    subjectKey: "user+agent-test",
  }), /individual fixed subject/u);
  fixture.database.close();
});

test("compares a reported value only against the reported current layer", async () => {
  const fixture = setup({ withCurrent: true, currentRepresentationLayer: "established" });
  const record = fixture.add({
    id: "reported-layer-value",
    content: "用户明确说守信对自己很重要。",
    sourceContent: "对我来说守信很重要。",
  });
  const result = await evaluate(fixture, record, analyzersFor(record), {
    currentRepresentationLayer: "reported",
  });
  assert.equal(result.snapshot.currentState, null);
  assert.equal(result.snapshot.target.currentRepresentationLayer, "reported");
  assert.equal(result.observations[0].scope.currentRepresentationLayer, "reported");
  fixture.database.close();
});
