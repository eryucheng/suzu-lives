import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryRepository,
  openMemoryDatabase,
} from "@suzu-lives/memory-core";

import {
  evaluatePreferenceEvidenceSpecialists,
  mergePreferenceSpecialistEvidence,
  PREFERENCE_SPECIALIST_ANALYZERS,
} from "../src/index.mjs";

const policy = Object.freeze({
  version: "preference-specialist-test-v1",
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

function setup() {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const add = ({ id, kind = "event", content, sourceContent, roles = [] }) => {
    const source = repository.upsertSource({
      agentId: "agent-test",
      sourceKind: "conversation",
      externalId: `source-${id}`,
      occurredAt: "2026-07-10T12:00:00.000Z",
      speaker: "User",
      content: sourceContent,
    });
    const memory = repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind,
      layer: "semantic",
      content,
      subjectRole: "user",
      subjectKey: "user",
      reality: "real",
      evidenceMode: "explicit",
      temporalState: "current",
      eventStart: kind === "event" ? "2026-07-10T12:00:00.000Z" : null,
      knownAt: "2026-07-10T12:00:00.000Z",
      actorRoles: roles,
    });
    repository.linkSource(memory.id, source.id, "evidence", {
      authority: "subject_firsthand",
      sourceTrust: 0.95,
      evidenceStrength: 1,
      provenance: "test",
    });
    return { memory, source };
  };
  const explicit = add({
    id: "explicit-puzzle",
    kind: "preference",
    content: "用户明确表示喜欢解谜游戏。",
    sourceContent: "我真的很喜欢解谜游戏。",
    roles: [
      { role: "speaker", actorRole: "user", actorKey: "user", isPrimary: true },
      { role: "preference_holder", actorRole: "user", actorKey: "user" },
    ],
  });
  const overtime = add({
    id: "overtime",
    content: "用户因为工作要求每天加班。",
    sourceContent: "项目要求我每天都得加班。",
    roles: [{ role: "experiencer", actorRole: "user", actorKey: "user", isPrimary: true }],
  });
  return { database, repository, explicit, overtime };
}

function common(evidence) {
  return {
    memoryId: evidence.memory.id,
    sourceIds: [evidence.source.id],
    confidence: 0.9,
    rationale: "测试直接证据",
  };
}

function analyzerSet({ explicit, overtime }, overrides = {}) {
  return {
    objectGrounding: async () => ({
      output: {
        analyses: [
          {
            ...common(explicit),
            targetMatch: "exact",
            matchedLabel: "解谜游戏",
          },
          {
            ...common(overtime),
            targetMatch: "none",
            matchedLabel: "加班",
          },
        ],
      },
      model: "test-object-model",
      metadata: { provider: "test" },
    }),
    explicitExpression: async () => ({
      output: {
        analyses: [{
          ...common(explicit),
          expressionType: "likes",
          directness: "explicit_self_statement",
        }],
      },
      model: "test-explicit-model",
      metadata: { provider: "test" },
    }),
    behaviorConditions: async () => ({
      output: {
        analyses: [{
          ...common(overtime),
          behaviorType: "routine",
          agency: "forced",
          constraint: "work",
          alternatives: "unknown",
          instrumentalGoal: "income",
          opportunityCost: "high",
          canDecline: "no",
        }],
      },
      model: "test-behavior-model",
      metadata: { provider: "test" },
    }),
    sharingAffect: async () => ({ output: { analyses: [] }, model: "test-sharing-model" }),
    timeScope: async () => ({
      output: {
        analyses: [
          {
            ...common(explicit),
            stateTime: "current",
            occurrencePattern: "single",
            scopeKind: "category",
            scopeLabel: "解谜游戏",
            contextLabel: "",
            revisionCue: "none",
          },
          {
            ...common(overtime),
            stateTime: "current",
            occurrencePattern: "habitual",
            scopeKind: "context_only",
            scopeLabel: "加班",
            contextLabel: "工作项目",
            revisionCue: "none",
          },
        ],
      },
      model: "test-time-model",
    }),
    ...overrides,
  };
}

test("runs five bounded specialists and audits each call without writing personality memory", async () => {
  const fixture = setup();
  const before = Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const result = await evaluatePreferenceEvidenceSpecialists({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    objectLabel: "解谜游戏",
    memoryIds: [fixture.explicit.memory.id, fixture.overtime.memory.id],
    analyzers: analyzerSet(fixture),
  });
  assert.equal(result.status, "analyzed");
  assert.deepEqual(result.failedRoles, []);
  assert.equal(Object.keys(result.runs).length, Object.keys(PREFERENCE_SPECIALIST_ANALYZERS).length);
  assert.equal(result.runs.explicitExpression.analyzer_role, "explicit-expression");
  assert.equal(result.runs.behaviorConditions.analyzer_role, "behavior-conditions");
  assert.equal(result.runs.sharingAffect.status, "abstained");
  assert.equal(result.analyses.timeScope.length, 2);
  assert.equal(
    Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    before,
  );
  assert.equal(fixture.repository.listStateAnalysisRuns("agent-test", {
    stateFamily: "preference",
    batchId: result.batchId,
  }).length, Object.keys(PREFERENCE_SPECIALIST_ANALYZERS).length);
  fixture.database.close();
});

test("keeps a failed required specialist visible and refuses to call the batch complete", async () => {
  const fixture = setup();
  const result = await evaluatePreferenceEvidenceSpecialists({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    objectLabel: "解谜游戏",
    memoryIds: [fixture.explicit.memory.id, fixture.overtime.memory.id],
    analyzers: analyzerSet(fixture, {
      behaviorConditions: async () => {
        throw new Error("provider unavailable");
      },
    }),
  });
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.failedRoles, ["behaviorConditions"]);
  assert.equal(result.runs.behaviorConditions.status, "failed");
  assert.equal(result.runs.behaviorConditions.error_message, "provider unavailable");
  assert.equal(Object.keys(result.runs).length, Object.keys(PREFERENCE_SPECIALIST_ANALYZERS).length);
  fixture.database.close();
});

test("rejects a specialist citation that belongs to another bounded memory", async () => {
  const fixture = setup();
  const analyzers = analyzerSet(fixture, {
    explicitExpression: async () => ({
      output: {
        analyses: [{
          ...common(fixture.explicit),
          sourceIds: [fixture.overtime.source.id],
          expressionType: "likes",
          directness: "explicit_self_statement",
        }],
      },
    }),
  });
  const result = await evaluatePreferenceEvidenceSpecialists({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    objectLabel: "解谜游戏",
    memoryIds: [fixture.explicit.memory.id, fixture.overtime.memory.id],
    analyzers,
  });
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.failedRoles, ["explicitExpression"]);
  assert.equal(result.runs.explicitExpression.status, "rejected");
  assert.match(result.rejected.explicitExpression[0].error, /directly support/u);
  fixture.database.close();
});

test("merges only object-grounded evidence and keeps unrelated behavior auditable but inert", async () => {
  const fixture = setup();
  const evaluation = await evaluatePreferenceEvidenceSpecialists({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    objectLabel: "解谜游戏",
    memoryIds: [fixture.explicit.memory.id, fixture.overtime.memory.id],
    analyzers: analyzerSet(fixture),
  });
  const merged = mergePreferenceSpecialistEvidence(fixture.repository, { evaluation, policy });
  assert.equal(merged.status, "merged");
  assert.equal(merged.preview.status, "direct-preference");
  assert.equal(merged.labels.length, 1);
  const observations = fixture.repository.listStateEvidenceObservations("agent-test", {
    stateFamily: "preference",
    canonicalKey: "user:preference:puzzle-games",
  });
  assert.equal(observations.length, 2);
  const explicit = observations.find((item) => item.memory_id === fixture.explicit.memory.id);
  const unrelated = observations.find((item) => item.memory_id === fixture.overtime.memory.id);
  assert.equal(explicit.qualification, "qualified");
  assert.equal(explicit.effective_direction, "support");
  assert.equal(unrelated.qualification, "excluded");
  assert.equal(unrelated.effective_direction, "neutral");
  assert.equal(unrelated.excluded_reason, "object-does-not-match-target");
  fixture.database.close();
});

test("allows a direct current preference report without an inferred-preference policy", async () => {
  const fixture = setup();
  const analyzers = analyzerSet(fixture, {
    objectGrounding: async () => ({
      output: { analyses: [{
        ...common(fixture.explicit),
        targetMatch: "exact",
        matchedLabel: "解谜游戏",
      }] },
    }),
    behaviorConditions: async () => ({ output: { analyses: [] } }),
    timeScope: async () => ({
      output: { analyses: [{
        ...common(fixture.explicit),
        stateTime: "current",
        occurrencePattern: "single",
        scopeKind: "category",
        scopeLabel: "解谜游戏",
        contextLabel: "",
        revisionCue: "none",
      }] },
    }),
  });
  const evaluation = await evaluatePreferenceEvidenceSpecialists({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    objectLabel: "解谜游戏",
    memoryIds: [fixture.explicit.memory.id],
    analyzers,
  });
  const merged = mergePreferenceSpecialistEvidence(fixture.repository, { evaluation });
  assert.equal(merged.status, "merged");
  assert.equal(merged.preview, null);
  assert.equal(merged.labels.length, 1);
  assert.equal(merged.labels[0].signal, "explicit_preference");
  assert.equal(merged.observations[0].qualification, "qualified");
  assert.equal(merged.observations[0].effective_direction, "support");
  fixture.database.close();
});

test("keeps behavioral preference evidence unresolved when no versioned policy is supplied", async () => {
  const fixture = setup();
  const analyzers = analyzerSet(fixture, {
    objectGrounding: async () => ({
      output: { analyses: [{
        ...common(fixture.overtime),
        targetMatch: "exact",
        matchedLabel: "加班",
      }] },
    }),
    explicitExpression: async () => ({ output: { analyses: [] } }),
    behaviorConditions: async () => ({
      output: { analyses: [{
        ...common(fixture.overtime),
        behaviorType: "choice",
        agency: "self_initiated",
        constraint: "none",
        alternatives: "available",
        instrumentalGoal: "none",
        opportunityCost: "medium",
        canDecline: "yes",
      }] },
    }),
    sharingAffect: async () => ({ output: { analyses: [] } }),
    timeScope: async () => ({
      output: { analyses: [{
        ...common(fixture.overtime),
        stateTime: "current",
        occurrencePattern: "single",
        scopeKind: "exact_object",
        scopeLabel: "加班",
        contextLabel: "自由时间",
        revisionCue: "none",
      }] },
    }),
  });
  const evaluation = await evaluatePreferenceEvidenceSpecialists({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:overtime",
    objectLabel: "加班",
    memoryIds: [fixture.overtime.memory.id],
    analyzers,
  });
  const merged = mergePreferenceSpecialistEvidence(fixture.repository, { evaluation });
  assert.equal(merged.preview, null);
  assert.equal(merged.labels.length, 0);
  assert.equal(merged.observations[0].qualification, "unresolved");
  assert.equal(merged.observations[0].excluded_reason, "preference-formation-policy-required");
  assert.equal(merged.observations[0].effective_direction, "neutral");
  fixture.database.close();
});

test("keeps constrained routine evidence out of preference state even when the object matches", async () => {
  const fixture = setup();
  const analyzers = analyzerSet(fixture, {
    objectGrounding: async () => ({
      output: { analyses: [{
        ...common(fixture.overtime),
        targetMatch: "exact",
        matchedLabel: "加班",
      }] },
    }),
    explicitExpression: async () => ({ output: { analyses: [] } }),
    sharingAffect: async () => ({ output: { analyses: [] } }),
    timeScope: async () => ({
      output: { analyses: [{
        ...common(fixture.overtime),
        stateTime: "current",
        occurrencePattern: "habitual",
        scopeKind: "context_only",
        scopeLabel: "加班",
        contextLabel: "工作项目",
        revisionCue: "none",
      }] },
    }),
  });
  const evaluation = await evaluatePreferenceEvidenceSpecialists({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:overtime",
    objectLabel: "加班",
    memoryIds: [fixture.overtime.memory.id],
    analyzers,
  });
  const merged = mergePreferenceSpecialistEvidence(fixture.repository, { evaluation, policy });
  assert.equal(merged.preview.status, "behavior-only");
  assert.equal(merged.preview.supportScore, 0);
  assert.equal(merged.observations[0].qualification, "excluded");
  assert.equal(merged.observations[0].excluded_reason, "behavior-was-not-self-directed");
  assert.equal(merged.observations[0].payload.behaviorConditions.constraint, "work");
  assert.equal(merged.observations[0].effective_direction, "neutral");
  fixture.database.close();
});

test("holds a same-memory specialist conflict as unresolved instead of voting", async () => {
  const fixture = setup();
  const analyzers = analyzerSet(fixture, {
    objectGrounding: async () => ({
      output: { analyses: [{
        ...common(fixture.explicit),
        targetMatch: "exact",
        matchedLabel: "解谜游戏",
      }] },
    }),
    behaviorConditions: async () => ({
      output: { analyses: [{
        ...common(fixture.explicit),
        behaviorType: "avoidance",
        agency: "self_initiated",
        constraint: "none",
        alternatives: "available",
        instrumentalGoal: "none",
        opportunityCost: "low",
        canDecline: "yes",
      }] },
    }),
    sharingAffect: async () => ({ output: { analyses: [] } }),
    timeScope: async () => ({
      output: { analyses: [{
        ...common(fixture.explicit),
        stateTime: "current",
        occurrencePattern: "single",
        scopeKind: "exact_object",
        scopeLabel: "解谜游戏",
        contextLabel: "",
        revisionCue: "none",
      }] },
    }),
  });
  const evaluation = await evaluatePreferenceEvidenceSpecialists({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    objectLabel: "解谜游戏",
    memoryIds: [fixture.explicit.memory.id],
    analyzers,
  });
  const merged = mergePreferenceSpecialistEvidence(fixture.repository, { evaluation, policy });
  assert.equal(merged.labels.length, 0);
  assert.equal(merged.observations[0].qualification, "unresolved");
  assert.equal(
    merged.observations[0].excluded_reason,
    "explicit-support-conflicts-with-same-memory-avoidance",
  );
  assert.equal(merged.observations[0].effective_direction, "neutral");
  fixture.database.close();
});
