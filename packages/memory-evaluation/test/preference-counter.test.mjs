import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryRepository,
  openMemoryDatabase,
} from "@suzu-lives/memory-core";

import {
  evaluatePreferenceCounterEvidence,
  evaluatePreferenceEvidenceSpecialists,
  mergePreferenceSpecialistEvidence,
} from "../src/index.mjs";

const policy = Object.freeze({
  version: "preference-counter-test-v1",
  signalWeights: {
    active_choice: 1,
    repeated_behavior: 0.7,
    active_sharing: 0.6,
    counter_behavior: 1,
  },
  opportunityCostMultipliers: {
    none: 1,
    low: 1,
    medium: 1.2,
    high: 1.5,
    unknown: 1,
  },
  minimumConfidence: 0.6,
  minimumStableSupportScore: 2,
  minimumStableIndependentSupport: 2,
  minimumStableDistinctDays: 2,
  minimumStableDistinctContexts: 2,
  minimumChoiceEvidenceForStable: 1,
  minimumSelectionEvidence: 1,
  minimumSelectionContexts: 1,
  minimumToleranceEvidence: 1,
  minimumToleranceContexts: 1,
  maximumContributionPerDay: 2,
  maximumOppositionRatio: 0.5,
});

function setup({
  canonicalKey = "user:preference:puzzle-games",
  objectLabel = "解谜游戏",
  currentScope = { kind: "category", label: "解谜游戏", context: "" },
  currentValidFrom = "2026-07-10T00:00:00.000Z",
  evidenceContent = "用户明确说现在不喜欢解谜游戏。",
  sourceContent = "我现在不喜欢解谜游戏了。",
  evidenceAt = "2026-07-20T12:00:00.000Z",
} = {}) {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const current = repository.upsertMemory({
    id: "current-preference",
    agentId: "agent-test",
    kind: "preference",
    layer: "semantic",
    content: `用户当前喜欢${objectLabel}。`,
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey,
    stateFamily: "preference",
    statePhase: "active",
    reality: "real",
    evidenceMode: "explicit",
    temporalState: "current",
    knownAt: currentValidFrom,
    validFrom: currentValidFrom,
    status: "active",
    metadata: {
      preferenceStateLevel: "direct_preference",
      preferenceScope: currentScope,
      preferenceScopeLabel: currentScope.label || objectLabel,
    },
  });
  const source = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: "counter-source",
    occurredAt: evidenceAt,
    knownAt: evidenceAt,
    speaker: "User",
    content: sourceContent,
  });
  const evidence = repository.upsertMemory({
    id: "counter-memory",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: evidenceContent,
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    evidenceMode: "explicit",
    temporalState: "current",
    eventStart: evidenceAt,
    knownAt: evidenceAt,
    actorRoles: [
      { role: "speaker", actorRole: "user", actorKey: "user", isPrimary: true },
      { role: "experiencer", actorRole: "user", actorKey: "user" },
      { role: "preference_holder", actorRole: "user", actorKey: "user" },
    ],
  });
  repository.linkSource(evidence.id, source.id, "evidence", {
    authority: "subject_firsthand",
    sourceTrust: 0.95,
    evidenceStrength: 1,
    provenance: "test",
  });
  return { database, repository, current, evidence, source, canonicalKey, objectLabel };
}

function common(fixture) {
  return {
    memoryId: fixture.evidence.id,
    sourceIds: [fixture.source.id],
    confidence: 0.94,
    rationale: "主体直接表达",
  };
}

function analyzers(fixture, {
  targetMatch = "exact",
  matchedLabel = fixture.objectLabel,
  expressionType = "dislikes",
  directness = "explicit_self_statement",
  behavior = null,
  stateTime = "current",
  scopeKind = "category",
  scopeLabel = fixture.objectLabel,
  contextLabel = "",
  revisionCue = "none",
} = {}) {
  return {
    objectGrounding: async () => ({
      output: { analyses: [{ ...common(fixture), targetMatch, matchedLabel }] },
      model: "object-test",
    }),
    explicitExpression: async () => ({
      output: { analyses: expressionType ? [{
        ...common(fixture), expressionType, directness,
      }] : [] },
      model: "explicit-test",
    }),
    behaviorConditions: async () => ({
      output: { analyses: behavior ? [{ ...common(fixture), ...behavior }] : [] },
      model: "behavior-test",
    }),
    sharingAffect: async () => ({ output: { analyses: [] }, model: "sharing-test" }),
    timeScope: async () => ({
      output: { analyses: [{
        ...common(fixture),
        stateTime,
        occurrencePattern: "single",
        scopeKind,
        scopeLabel,
        contextLabel,
        revisionCue,
      }] },
      model: "time-test",
    }),
  };
}

async function mergeCounter(fixture, analyzerOverrides = {}) {
  const evaluation = await evaluatePreferenceEvidenceSpecialists({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: fixture.canonicalKey,
    objectLabel: fixture.objectLabel,
    memoryIds: [fixture.evidence.id],
    analyzers: analyzers(fixture, analyzerOverrides),
  });
  return mergePreferenceSpecialistEvidence(fixture.repository, { evaluation, policy });
}

test("defers new opposition while a current preference exists and activates only an exact current conflict", async () => {
  const fixture = setup();
  const merged = await mergeCounter(fixture);
  assert.equal(merged.observations[0].qualification, "unresolved");
  assert.equal(merged.observations[0].effective_direction, "neutral");
  assert.equal(merged.observations[0].excluded_reason, "counter-match-required");

  const result = await evaluatePreferenceCounterEvidence({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: fixture.canonicalKey,
    objectLabel: fixture.objectLabel,
    observationIds: [merged.observations[0].id],
    generator: async () => ({
      output: { analyses: [{
        observationId: merged.observations[0].id,
        memoryId: fixture.evidence.id,
        sourceIds: [fixture.source.id],
        relation: "same_scope_conflict",
        scopeOverlap: "exact",
        temporalRelation: "overlaps_current",
        confidence: 0.93,
        rationale: "当前明确表达与当前同范围偏好相反",
      }] },
      model: "counter-test",
      metadata: { provider: "test" },
    }),
  });
  assert.equal(result.status, "matched");
  assert.equal(result.observations[0].qualification, "qualified");
  assert.equal(result.observations[0].effective_direction, "opposition");
  assert.equal(result.observations[0].payload.counterMatch.currentStateId, fixture.current.id);
  assert.equal(
    fixture.repository.getStateEvidenceObservation("agent-test", merged.observations[0].id).lifecycle,
    "superseded",
  );
  fixture.database.close();
});

test("keeps a disliked fish subcategory as a local exception instead of challenging the broad state", async () => {
  const fixture = setup({
    canonicalKey: "user:preference:fish",
    objectLabel: "鱼类食物",
    currentScope: { kind: "category", label: "鱼类食物", context: "" },
    evidenceContent: "用户表示不喜欢清蒸鲫鱼。",
    sourceContent: "我不喜欢清蒸鲫鱼。",
  });
  const merged = await mergeCounter(fixture, {
    targetMatch: "subcategory",
    matchedLabel: "清蒸鲫鱼",
    scopeKind: "subcategory",
    scopeLabel: "清蒸鲫鱼",
  });
  const result = await evaluatePreferenceCounterEvidence({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: fixture.canonicalKey,
    objectLabel: fixture.objectLabel,
    observationIds: [merged.observations[0].id],
    generator: async () => ({ output: { analyses: [{
      observationId: merged.observations[0].id,
      memoryId: fixture.evidence.id,
      sourceIds: [fixture.source.id],
      relation: "subcategory_exception",
      scopeOverlap: "subset",
      temporalRelation: "overlaps_current",
      confidence: 0.96,
      rationale: "只否定鱼类中的一个具体菜品",
    }] } }),
  });
  assert.equal(result.status, "matched");
  assert.equal(result.observations[0].qualification, "excluded");
  assert.equal(result.observations[0].effective_direction, "neutral");
  assert.equal(result.observations[0].excluded_reason, "counter-subcategory_exception");
  fixture.database.close();
});

test("keeps temporary inability to play as a condition rather than preference opposition", async () => {
  const fixture = setup({
    evidenceContent: "用户今天头疼，所以没有玩解谜游戏。",
    sourceContent: "今天头疼，不玩解谜了。",
  });
  const merged = await mergeCounter(fixture, {
    expressionType: null,
    behavior: {
      behaviorType: "avoidance",
      agency: "self_initiated",
      constraint: "none",
      alternatives: "available",
      instrumentalGoal: "none",
      opportunityCost: "low",
      canDecline: "yes",
    },
    scopeKind: "context_only",
    contextLabel: "身体不适",
  });
  const result = await evaluatePreferenceCounterEvidence({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: fixture.canonicalKey,
    objectLabel: fixture.objectLabel,
    observationIds: [merged.observations[0].id],
    generator: async () => ({ output: { analyses: [{
      observationId: merged.observations[0].id,
      memoryId: fixture.evidence.id,
      sourceIds: [fixture.source.id],
      relation: "temporary_condition",
      scopeOverlap: "partial",
      temporalRelation: "overlaps_current",
      confidence: 0.91,
      rationale: "本次没有参与由临时身体状态解释",
    }] } }),
  });
  assert.equal(result.observations[0].qualification, "excluded");
  assert.equal(result.observations[0].excluded_reason, "counter-temporary_condition");
  assert.equal(result.observations[0].effective_direction, "neutral");
  fixture.database.close();
});

test("historical explicit rejection is stopped before counter matching", async () => {
  const fixture = setup({
    evidenceContent: "用户回忆小时候不喜欢解谜游戏。",
    sourceContent: "我小时候其实不喜欢解谜游戏。",
    evidenceAt: "2026-07-20T12:00:00.000Z",
  });
  const merged = await mergeCounter(fixture, { stateTime: "historical" });
  assert.equal(merged.observations[0].qualification, "unresolved");
  assert.equal(merged.observations[0].effective_direction, "neutral");
  assert.equal(merged.observations[0].excluded_reason, "explicit-expression-is-historical");
  assert.equal(
    fixture.repository.getStateEvidenceObservation("another-agent", merged.observations[0].id),
    null,
  );
  fixture.database.close();
});

test("refuses an exact conflict claim when the stored current scope is unknown", async () => {
  const fixture = setup({ currentScope: {} });
  const merged = await mergeCounter(fixture);
  const result = await evaluatePreferenceCounterEvidence({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: fixture.canonicalKey,
    objectLabel: fixture.objectLabel,
    observationIds: [merged.observations[0].id],
    generator: async () => ({ output: { analyses: [{
      observationId: merged.observations[0].id,
      memoryId: fixture.evidence.id,
      sourceIds: [fixture.source.id],
      relation: "same_scope_conflict",
      scopeOverlap: "exact",
      temporalRelation: "overlaps_current",
      confidence: 0.99,
      rationale: "模型声称同范围",
    }] } }),
  });
  assert.equal(result.status, "incomplete");
  assert.equal(result.run.status, "rejected");
  assert.match(result.rejected[0].error, /scope is unknown/u);
  const unchanged = fixture.repository.getStateEvidenceObservation(
    "agent-test",
    merged.observations[0].id,
  );
  assert.equal(unchanged.lifecycle, "current");
  assert.equal(unchanged.qualification, "unresolved");
  fixture.database.close();
});
