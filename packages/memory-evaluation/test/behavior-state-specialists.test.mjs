import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryRepository,
  openMemoryDatabase,
} from "@suzu-lives/memory-core";

import {
  evaluateBehaviorStateEvidence,
} from "../src/index.mjs";

function setup() {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const add = ({
    id,
    content,
    sourceContent,
    occurredAt = "2026-07-10T12:00:00.000Z",
    roles = [],
  }) => {
    const source = repository.upsertSource({
      agentId: "agent-test",
      sourceKind: "conversation",
      externalId: `source-${id}`,
      occurredAt,
      speaker: "User",
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
  const overtime = add({
    id: "overtime",
    content: "用户因为最近项目要求而每天加班。",
    sourceContent: "最近这个项目要求我每天都得加班。",
    roles: [
      { role: "speaker", actorRole: "user", actorKey: "user", isPrimary: true },
      { role: "experiencer", actorRole: "user", actorKey: "user" },
    ],
  });
  const silence = add({
    id: "single-silence",
    content: "用户在这次争吵后沉默了一会。",
    sourceContent: "这次吵完我先不说话了。",
    occurredAt: "2026-07-11T12:00:00.000Z",
    roles: [{ role: "experiencer", actorRole: "user", actorKey: "user", isPrimary: true }],
  });
  const workResearch = add({
    id: "work-research",
    content: "做项目方案选择时，用户先查资料再决定。",
    sourceContent: "这次项目选方案，我先把资料查清楚再定。",
    occurredAt: "2026-07-12T12:00:00.000Z",
    roles: [{ role: "experiencer", actorRole: "user", actorKey: "user", isPrimary: true }],
  });
  const healthResearch = add({
    id: "health-research",
    content: "选择体检方案时，用户先查资料再决定。",
    sourceContent: "体检方案我也先查资料，弄明白再选。",
    occurredAt: "2026-07-15T12:00:00.000Z",
    roles: [{ role: "experiencer", actorRole: "user", actorKey: "user", isPrimary: true }],
  });
  return { database, repository, overtime, silence, workResearch, healthResearch };
}

function common(record, overrides = {}) {
  return {
    memoryId: record.memory.id,
    sourceIds: [record.source.id],
    targetMatch: "exact",
    matchedLabel: "测试目标",
    confidence: 0.9,
    rationale: "来源直接支持该标注。",
    ...overrides,
  };
}

function overtimeTargets() {
  return {
    condition: {
      canonicalKey: "user:condition:project-overtime-requirement",
      conceptLabel: "项目加班要求",
    },
    habit: {
      canonicalKey: "user:habit:daily-overtime",
      conceptLabel: "每天加班",
    },
    disposition: {
      canonicalKey: "user:disposition:work-devotion",
      conceptLabel: "倾向牺牲生活投入工作",
    },
  };
}

function overtimeAnalyzers(fixture, overrides = {}) {
  return {
    condition: async () => ({
      output: { analyses: [{
        ...common(fixture.overtime, { matchedLabel: "项目加班要求" }),
        conditionPresence: "present",
        conditionKind: "work",
        effect: "constrains",
        temporality: "temporary",
        evidenceBasis: "explicit_self_report",
        scopeLabel: "最近的项目期间",
        revisionCue: "none",
      }] },
      model: "condition-test",
      metadata: { provider: "test" },
    }),
    habit: async () => ({
      output: { analyses: [{
        ...common(fixture.overtime, { matchedLabel: "每天加班" }),
        patternType: "habitual",
        regularity: "daily",
        timeState: "current",
        evidenceBasis: "explicit_self_report",
        constraint: "work",
        contextLabel: "最近的项目期间",
        revisionCue: "none",
      }] },
      model: "habit-test",
      metadata: { provider: "test" },
    }),
    disposition: async () => ({
      output: { analyses: [{
        ...common(fixture.overtime, { matchedLabel: "工作投入" }),
        tendencyPresence: "present",
        evidenceType: "repeated_single_context",
        crossContext: "no",
        externalConstraint: "present",
        timeState: "current",
        situationLabel: "同一个工作项目",
        responseLabel: "每天加班",
        revisionCue: "none",
      }] },
      model: "disposition-test",
      metadata: { provider: "test" },
    }),
    ...overrides,
  };
}

test("routes constrained overtime into condition and habit without inventing a disposition", async () => {
  const fixture = setup();
  const before = Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const result = await evaluateBehaviorStateEvidence({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    memoryIds: [fixture.overtime.memory.id],
    targets: overtimeTargets(),
    analyzers: overtimeAnalyzers(fixture),
  });
  assert.equal(result.status, "analyzed");
  assert.deepEqual(result.failedFamilies, []);
  assert.equal(result.observations.condition[0].qualification, "qualified");
  assert.equal(result.observations.condition[0].effective_direction, "support");
  assert.equal(result.observations.habit[0].qualification, "qualified");
  assert.equal(result.observations.habit[0].effective_direction, "support");
  assert.equal(result.observations.habit[0].scope.constraint, "work");
  assert.equal(result.observations.disposition[0].qualification, "excluded");
  assert.equal(result.observations.disposition[0].effective_direction, "neutral");
  assert.equal(
    result.observations.disposition[0].excluded_reason,
    "single-context-pattern-is-not-cross-context",
  );
  assert.equal(
    Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    before,
  );
  fixture.database.close();
});

test("keeps a one-off stress response out of disposition state", async () => {
  const fixture = setup();
  const result = await evaluateBehaviorStateEvidence({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    memoryIds: [fixture.silence.memory.id],
    targets: {
      disposition: {
        canonicalKey: "user:disposition:withdraw-before-discussion",
        conceptLabel: "冲突后先独处再沟通",
      },
    },
    analyzers: {
      disposition: async () => ({ output: { analyses: [{
        ...common(fixture.silence, { matchedLabel: "冲突后沉默" }),
        tendencyPresence: "present",
        evidenceType: "single_response",
        crossContext: "no",
        externalConstraint: "unknown",
        timeState: "current",
        situationLabel: "这一次争吵",
        responseLabel: "暂时沉默",
        revisionCue: "none",
      }] } }),
    },
  });
  assert.equal(result.observations.disposition[0].qualification, "excluded");
  assert.equal(
    result.observations.disposition[0].excluded_reason,
    "single-response-is-not-a-disposition",
  );
  fixture.database.close();
});

test("requires code-verifiable distinct contexts before accepting a cross-context tendency", async () => {
  const fixture = setup();
  const records = [fixture.workResearch, fixture.healthResearch];
  const result = await evaluateBehaviorStateEvidence({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    memoryIds: records.map((item) => item.memory.id),
    targets: {
      disposition: {
        canonicalKey: "user:disposition:research-before-decisions",
        conceptLabel: "做决定前先研究",
      },
    },
    analyzers: {
      disposition: async () => ({ output: { analyses: records.map((record, index) => ({
        ...common(record, { matchedLabel: "做决定前先研究" }),
        tendencyPresence: "present",
        evidenceType: "repeated_cross_context",
        crossContext: "yes",
        externalConstraint: "absent",
        timeState: "current",
        situationLabel: index === 0 ? "工作方案选择" : "个人健康选择",
        responseLabel: "先查资料再决定",
        revisionCue: "none",
      })) } }),
    },
  });
  assert.equal(result.status, "analyzed");
  assert.equal(result.observations.disposition.length, 2);
  assert.ok(result.observations.disposition.every((item) => (
    item.qualification === "qualified" && item.effective_direction === "support"
  )));
  fixture.database.close();
});

test("does not accept two dates in the same stated situation as cross-context evidence", async () => {
  const fixture = setup();
  const records = [fixture.workResearch, fixture.healthResearch];
  const result = await evaluateBehaviorStateEvidence({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    memoryIds: records.map((item) => item.memory.id),
    targets: {
      disposition: {
        canonicalKey: "user:disposition:research-before-decisions",
        conceptLabel: "做决定前先研究",
      },
    },
    analyzers: {
      disposition: async () => ({ output: { analyses: records.map((record) => ({
        ...common(record, { matchedLabel: "做决定前先研究" }),
        tendencyPresence: "present",
        evidenceType: "repeated_cross_context",
        crossContext: "yes",
        externalConstraint: "absent",
        timeState: "current",
        situationLabel: "工作项目",
        responseLabel: "先查资料再决定",
        revisionCue: "none",
      })) } }),
    },
  });
  assert.ok(result.observations.disposition.every((item) => (
    item.qualification === "unresolved"
    && item.excluded_reason === "cross-context-coverage-not-code-verifiable"
  )));
  fixture.database.close();
});

test("keeps successful family evidence when another provider call fails", async () => {
  const fixture = setup();
  const result = await evaluateBehaviorStateEvidence({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    memoryIds: [fixture.overtime.memory.id],
    targets: overtimeTargets(),
    analyzers: overtimeAnalyzers(fixture, {
      disposition: async () => {
        throw new Error("provider unavailable");
      },
    }),
  });
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.failedFamilies, ["disposition"]);
  assert.equal(result.runs.disposition.status, "failed");
  assert.equal(result.observations.condition.length, 1);
  assert.equal(result.observations.habit.length, 1);
  assert.deepEqual(result.observations.disposition, []);
  fixture.database.close();
});

test("rejects a source citation borrowed from another bounded memory", async () => {
  const fixture = setup();
  const result = await evaluateBehaviorStateEvidence({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    memoryIds: [fixture.overtime.memory.id, fixture.silence.memory.id],
    targets: {
      condition: {
        canonicalKey: "user:condition:project-overtime-requirement",
        conceptLabel: "项目加班要求",
      },
    },
    analyzers: {
      condition: async () => ({ output: { analyses: [{
        ...common(fixture.overtime),
        sourceIds: [fixture.silence.source.id],
        conditionPresence: "present",
        conditionKind: "work",
        effect: "constrains",
        temporality: "temporary",
        evidenceBasis: "direct_observation",
        scopeLabel: "项目期间",
        revisionCue: "none",
      }] } }),
    },
  });
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.failedFamilies, ["condition"]);
  assert.equal(result.runs.condition.status, "rejected");
  assert.match(result.rejected.condition[0].error, /directly support/u);
  assert.deepEqual(result.observations.condition, []);
  fixture.database.close();
});
