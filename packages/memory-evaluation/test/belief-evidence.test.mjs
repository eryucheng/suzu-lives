import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryRepository,
  openMemoryDatabase,
} from "@suzu-lives/memory-core";

import { evaluateBeliefEvidence } from "../src/index.mjs";

const KEY = "agent:belief:food:fish";

function setup({ withCurrent = false, currentRepresentationLayer = "" } = {}) {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const add = ({
    id,
    content,
    sourceContent,
    occurredAt = "2026-07-10T12:00:00.000Z",
    subjectRole = "agent",
    subjectKey = "agent-test",
    speakerRole = subjectRole,
    speakerKey = subjectKey,
  }) => {
    const source = repository.upsertSource({
      agentId: "agent-test",
      sourceKind: "conversation",
      externalId: `source-${id}`,
      occurredAt,
      speaker: speakerRole === "agent" ? "Agent" : "User",
      content: sourceContent,
    });
    const memory = repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "semantic",
      content,
      subjectRole,
      subjectKey,
      reality: "real",
      evidenceMode: "explicit",
      representationLayer: currentRepresentationLayer,
      temporalState: "current",
      eventStart: occurredAt,
      knownAt: occurredAt,
      actorRoles: [
        { role: "speaker", actorRole: speakerRole, actorKey: speakerKey, isPrimary: speakerRole === subjectRole },
        { role: "belief_holder", actorRole: subjectRole, actorKey: subjectKey },
      ],
    });
    repository.linkSource(memory.id, source.id, "evidence", {
      authority: subjectRole === speakerRole ? "subject_firsthand" : "hearsay",
      sourceTrust: subjectRole === speakerRole ? 0.95 : 0.5,
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
      externalId: "source-current-fish-belief",
      occurredAt: "2026-07-01T08:00:00.000Z",
      speaker: "Agent",
      content: "我觉得所有鱼都很难吃。",
    });
    const memory = repository.upsertMemory({
      id: "current-fish-belief",
      agentId: "agent-test",
      kind: "belief_state",
      layer: "semantic",
      content: "Agent 觉得所有鱼都很难吃。",
      subjectRole: "agent",
      subjectKey: "agent-test",
      canonicalKey: KEY,
      stateFamily: "belief",
      statePhase: "active",
      reality: "real",
      evidenceMode: "explicit",
      temporalState: "current",
      knownAt: "2026-07-01T08:00:00.000Z",
      validFrom: "2026-07-01T08:00:00.000Z",
      actorRoles: [{
        role: "belief_holder",
        actorRole: "agent",
        actorKey: "agent-test",
        isPrimary: true,
      }],
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
  claimText = "有些鱼很好吃",
  stance = "asserts",
  claimKind = "opinion",
  quantifier = "some",
  holderMatch = "yes",
  attribution = "explicit_self_statement",
  stateTime = "current",
  revisionCue = "none",
  currentStatePresent = false,
  relation = "no_current_state",
  scopeOverlap = "none",
} = {}) {
  return {
    propositionGrounding: async () => ({ output: { analyses: [{
      ...common(record), targetMatch, claimText, stance, claimKind, quantifier,
    }] } }),
    holderAttribution: async () => ({ output: { analyses: [{
      ...common(record), holderMatch, attribution,
    }] } }),
    timeRevision: async () => ({ output: { analyses: [{
      ...common(record), stateTime, revisionCue, timeReference: "",
    }] } }),
    currentRelation: async () => ({ output: { analyses: [{
      ...common(record), currentStatePresent, relation, scopeOverlap,
    }] } }),
  };
}

async function evaluate(fixture, record, analyzers, overrides = {}) {
  return evaluateBeliefEvidence({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "agent",
    subjectKey: "agent-test",
    canonicalKey: KEY,
    topicLabel: "对鱼味道的看法",
    memoryIds: [record.memory.id],
    analyzers,
    ...overrides,
  });
}

test("proposes only a shadow create action for a direct current belief", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "first-fish-belief",
    content: "Agent 表示有些鱼很好吃。",
    sourceContent: "我现在觉得有些鱼很好吃。",
  });
  const before = Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const result = await evaluate(fixture, record, analyzersFor(record));
  assert.equal(result.status, "analyzed");
  assert.equal(result.observations[0].qualification, "qualified");
  assert.equal(result.actionPreviews[0].action, "create");
  assert.equal(result.actionPreviews[0].automaticStateWriteAllowed, false);
  assert.equal(result.snapshot.currentState, null);
  assert.equal(
    Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    before,
  );
  fixture.database.close();
});

test("treats a partial exception as scope narrowing instead of reversing a universal belief", async () => {
  const fixture = setup({ withCurrent: true });
  const record = fixture.add({
    id: "fish-exception",
    content: "Agent 吃到一道很好吃的鱼后修正了原来的绝对看法。",
    sourceContent: "我以前觉得所有鱼都难吃，但这道鱼很好吃，看来不能一概而论。",
  });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    claimText: "并非所有鱼都难吃，有些做法很好吃",
    quantifier: "some",
    revisionCue: "revises_scope",
    currentStatePresent: true,
    relation: "partial_exception",
    scopeOverlap: "partial",
  }));
  assert.equal(result.snapshot.currentState.id, fixture.current.memory.id);
  assert.equal(result.observations[0].effective_direction, "opposition");
  assert.equal(result.actionPreviews[0].action, "narrow_scope");
  assert.equal(fixture.repository.getMemory(fixture.current.memory.id).status, "active");
  fixture.database.close();
});

test("keeps a same-scope conflict unresolved when there is no explicit change cue", async () => {
  const fixture = setup({ withCurrent: true });
  const record = fixture.add({
    id: "fish-conflict",
    content: "Agent 说鱼很好吃，但没有说明观念何时改变。",
    sourceContent: "鱼都挺好吃的。",
  });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    claimText: "鱼都很好吃",
    quantifier: "general",
    currentStatePresent: true,
    relation: "same_scope_conflict",
    scopeOverlap: "exact",
  }));
  assert.equal(result.actionPreviews[0].action, "contradict");
  assert.equal(result.actionPreviews[0].reason, "same-scope-conflict-without-change-proof");
  assert.equal(fixture.repository.getMemory(fixture.current.memory.id).status, "active");
  fixture.database.close();
});

test("distinguishes later change of mind from correcting a false holder attribution", async () => {
  const changedFixture = setup({ withCurrent: true });
  const changed = changedFixture.add({
    id: "fish-changed-mind",
    content: "Agent 后来改变了对鱼的看法。",
    sourceContent: "我以前确实觉得鱼难吃，但我现在改观了。",
  });
  const changedResult = await evaluate(changedFixture, changed, analyzersFor(changed, {
    claimText: "现在不再认为鱼都难吃",
    stance: "denies",
    revisionCue: "changed_mind",
    currentStatePresent: true,
    relation: "same_scope_conflict",
    scopeOverlap: "exact",
  }));
  assert.equal(changedResult.actionPreviews[0].action, "supersede");
  changedFixture.database.close();

  const correctionFixture = setup({ withCurrent: true });
  const correction = correctionFixture.add({
    id: "fish-denies-holder",
    content: "Agent 指出旧记录错误归属了自己的看法。",
    sourceContent: "我从来没觉得所有鱼都难吃，那条记录不是我的想法。",
  });
  const correctionResult = await evaluate(correctionFixture, correction, analyzersFor(correction, {
    claimText: "从未认为所有鱼都难吃",
    stance: "denies",
    revisionCue: "denies_prior_holding",
    currentStatePresent: true,
    relation: "same_scope_conflict",
    scopeOverlap: "exact",
  }));
  assert.equal(correctionResult.actionPreviews[0].action, "correct_attribution");
  correctionFixture.database.close();
});

test("keeps model inference about another person's belief unresolved", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "inferred-user-belief",
    content: "Agent 根据行为猜测用户觉得围棋有趣。",
    sourceContent: "他最近聊了几次围棋，我猜他觉得围棋有趣。",
    subjectRole: "user",
    subjectKey: "user",
    speakerRole: "agent",
    speakerKey: "agent-test",
  });
  const result = await evaluateBeliefEvidence({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:belief:go:interesting",
    topicLabel: "对围棋是否有趣的看法",
    memoryIds: [record.memory.id],
    analyzers: analyzersFor(record, {
      claimText: "围棋有趣",
      attribution: "agent_inference",
    }),
  });
  assert.equal(result.observations[0].qualification, "unresolved");
  assert.equal(result.observations[0].effective_direction, "neutral");
  assert.equal(
    result.observations[0].excluded_reason,
    "belief-holder-is-not-direct-self-expression",
  );
  assert.equal(result.actionPreviews[0].action, "no_conclusion");
  fixture.database.close();
});

test("does not turn a historical belief into a new current state", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "historical-fish-belief",
    content: "Agent 过去觉得鱼很难吃。",
    sourceContent: "我以前觉得鱼很难吃。",
  });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    claimText: "鱼很难吃",
    stateTime: "historical",
  }));
  assert.equal(result.observations[0].qualification, "qualified");
  assert.equal(result.actionPreviews[0].action, "no_conclusion");
  assert.equal(result.actionPreviews[0].reason, "historical-belief-does-not-create-a-current-state");
  fixture.database.close();
});

test("rejects a relation analyzer that invents a missing current state", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "invented-current-state",
    content: "Agent 表示有些鱼很好吃。",
    sourceContent: "我觉得有些鱼很好吃。",
  });
  const analyzers = analyzersFor(record, {
    currentStatePresent: true,
    relation: "equivalent",
    scopeOverlap: "exact",
  });
  const result = await evaluate(fixture, record, analyzers);
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.failedRoles, ["currentRelation"]);
  assert.equal(result.runs.currentRelation.status, "rejected");
  assert.deepEqual(result.observations, []);
  fixture.database.close();
});

test("audits partial provider failure without writing a merged belief observation", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "belief-provider-failure",
    content: "Agent 表示有些鱼很好吃。",
    sourceContent: "我觉得有些鱼很好吃。",
  });
  const analyzers = analyzersFor(record);
  analyzers.timeRevision = async () => {
    throw new Error("provider unavailable");
  };
  const result = await evaluate(fixture, record, analyzers);
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.failedRoles, ["timeRevision"]);
  assert.equal(result.runs.timeRevision.status, "failed");
  assert.deepEqual(result.observations, []);
  fixture.database.close();
});

test("compares a reported belief only against the reported current layer", async () => {
  const fixture = setup({ withCurrent: true, currentRepresentationLayer: "established" });
  const record = fixture.add({
    id: "reported-layer-belief",
    content: "Agent 表示有些鱼很好吃。",
    sourceContent: "我现在觉得有些鱼很好吃。",
  });
  const result = await evaluate(fixture, record, analyzersFor(record), {
    currentRepresentationLayer: "reported",
  });
  assert.equal(result.snapshot.currentState, null);
  assert.equal(result.snapshot.target.currentRepresentationLayer, "reported");
  assert.equal(result.observations[0].scope.currentRepresentationLayer, "reported");
  fixture.database.close();
});
