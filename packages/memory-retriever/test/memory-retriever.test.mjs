import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyMemoryCandidate,
  MemoryRepository,
  openMemoryDatabase,
  proposeMemoryRelation,
  resolveMemoryRelationProposal,
  stateScopeKeyFromScope,
} from "@suzu-lives/memory-core";
import {
  classifyChainIntent,
  classifyRepresentationIntent,
  classifyRecallIntent,
  isContinuationQuery,
  retrieveMemories,
  resolveContinuationAnchors,
  resolveQuerySubject,
  resolveTemporalQuery,
} from "../src/index.mjs";

function temporaryDatabase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-retriever-"));
  const databasePath = path.join(root, "memory.db");
  const database = openMemoryDatabase(databasePath);
  return { root, databasePath, database, repository: new MemoryRepository(database) };
}

function explicitPlasticityOptions() {
  return {
    enabled: true,
    configurationVersion: "test-retrieval-plasticity-v1",
    memory: {
      neutralValue: 0.5,
      maximumScoreAdjustment: 0.4,
      allowedPolicyVersions: ["test-memory-policy-v1"],
    },
    edge: {
      neutralValue: 0.5,
      maximumMultiplierAdjustment: 1,
      allowedPolicyVersions: ["test-edge-policy-v1"],
    },
  };
}

function explicitAffectiveBiasOptions() {
  return {
    enabled: true,
    configurationVersion: "test-affective-retrieval-v1",
    subjectRole: "user",
    subjectKey: "user",
    currentEmotion: {
      label: "开心",
      valence: "positive",
      intensity: "high",
    },
    matchMode: "exact-label",
    maximumScoreAdjustment: 0.4,
    allowedPolicyVersions: ["human-affective-v1"],
    allowedRepresentationLayers: ["reported"],
  };
}

function seedMuseumMemory(repository) {
  repository.upsertMemory({
    id: "u-user",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "我上周六去了科技馆。",
    subjectRole: "user",
    subjectKey: "user",
    eventStart: "2026-07-11T03:00:00.000Z",
    recordedAt: "2026-07-11T03:00:00.000Z",
    metadata: { speaker: "User" },
  });
  repository.upsertMemory({
    id: "u-agent",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "你还看了机器人展。",
    subjectRole: "agent",
    subjectKey: "agent-test",
    eventStart: "2026-07-11T03:01:00.000Z",
    recordedAt: "2026-07-11T03:01:00.000Z",
    metadata: { speaker: "Agent" },
  });
  repository.upsertMemory({
    id: "event-museum",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "去科技馆",
    content: "User 上周六去了科技馆并参观机器人展。",
    subjectRole: "user",
    subjectKey: "user",
    eventDate: "2026-07-11",
    recordedAt: "2026-07-11T03:02:00.000Z",
    importance: 0.8,
  });
  for (const id of ["u-user", "u-agent"]) {
    repository.upsertEdge({
      agentId: "agent-test",
      fromMemoryId: "event-museum",
      toMemoryId: id,
      relation: "supported_by",
      direction: "directed",
      weight: 1,
    });
  }
}

test("resolves Chinese relative calendar expressions in code", () => {
  const temporal = resolveTemporalQuery(
    "我上周六去干啥了",
    new Date("2026-07-15T12:00:00+08:00"),
    "Asia/Shanghai",
  );
  assert.equal(temporal.matched, true);
  assert.equal(temporal.startDate, "2026-07-11");
});

test("summarizes an event without dumping its source conversation", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  seedMuseumMemory(repository);
  database.close();
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "记得我之前去科技馆吗",
    now: new Date("2026-07-15T12:00:00+08:00"),
  });
  assert.equal(result.status, "ready");
  assert.equal(result.disclosureLevel, "conclusion");
  assert.equal(result.fragments.length, 1);
  assert.equal(result.fragments[0].memoryId, "event-museum");
  assert.match(result.context, /去了科技馆并参观机器人展/u);
  assert.doesNotMatch(result.context, /相关原话/u);
  assert.deepEqual(result.seedRouting.plannedRoutes, ["lexical", "entity"]);
  assert.deepEqual(result.seedRouting.executedRoutes, ["lexical", "entity"]);
  assert.equal(result.seedRouting.primaryMemoryId, "event-museum");
  assert.equal(result.candidates[0].admission, "independent");
  assert.equal(result.candidates[0].routeMatches[0].route, "lexical");
  assert.deepEqual(result.trace.metadata.seedRouting, result.seedRouting);
  assert.doesNotMatch(JSON.stringify(result.seedRouting), /机器人展/u);
});

test("ordinary recall does not let a stronger raw utterance replace a reviewed memory", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "relationship-state",
    agentId: "agent-test",
    kind: "relationship",
    layer: "semantic",
    title: "用户把 Agent 当成恋人",
    content: "用户明确把 Agent 当成恋人，双方是恋人关系。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user.relationship.agent.lovers",
    representationLayer: "reported",
    stateFamily: "relationship",
    statePhase: "active",
    temporalState: "current",
    validFrom: "2026-07-01T00:00:00.000Z",
    importance: 0.8,
  });
  repository.upsertMemory({
    id: "unrelated-utterance",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "我把模型关系和工具关系都重新考虑了一遍。",
    subjectRole: "agent",
    subjectKey: "agent-test",
    eventStart: "2026-07-02T00:00:00.000Z",
    recordedAt: "2026-07-02T00:00:00.000Z",
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "我们是恋人关系吗",
  });
  assert.equal(result.status, "ready");
  assert.equal(result.seedRouting.primaryMemoryId, "relationship-state");
  assert.doesNotMatch(result.context, /模型关系/u);
});

test("labels the actual epistemic source of a non-state memory", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  const source = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: "observatory-message",
    occurredAt: "2026-07-01T02:00:00.000Z",
    knownAt: "2026-07-01T02:00:00.000Z",
    recordedAt: "2026-07-01T02:00:00.000Z",
    speaker: "User",
    content: "我七月一日去了天文馆。",
  });
  const memory = repository.upsertMemory({
    id: "observatory-event",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户七月一日去了天文馆。",
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    evidenceMode: "explicit",
    eventDate: "2026-07-01",
    recordedAt: "2026-07-01T02:00:00.000Z",
  });
  repository.linkSource(memory.id, source.id, "evidence", {
    authority: "subject_firsthand",
    sourceTrust: 0.9,
    evidenceStrength: 1,
    provenance: "test",
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "记得我七月一日去天文馆吗",
  });
  assert.equal(result.status, "ready");
  assert.match(result.context, /来源性质：主体本人陈述；不等于外部独立核验/u);
});

test("marks imported non-state memory without inventing source authority", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "legacy-aquarium-event",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户以前去过海洋馆。",
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    evidenceMode: "imported",
    temporalState: "historical",
    recordedAt: "2026-06-01T02:00:00.000Z",
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "记得我以前去海洋馆吗",
  });
  assert.equal(result.status, "ready");
  assert.match(result.context, /来源性质：旧资料导入；原有来源分级不完整/u);
});

test("uses a short evidence follow-up to disclose direct sources for the previous focus", async () => {
  assert.equal(isContinuationQuery("有什么依据"), true);
  assert.equal(isContinuationQuery("怎么知道的"), true);
  assert.equal(isContinuationQuery("为什么"), true);
  assert.equal(isContinuationQuery("这导致了什么"), true);
  assert.equal(isContinuationQuery("为什么科技馆后来取消了"), false);

  const { databasePath, database, repository } = temporaryDatabase();
  seedMuseumMemory(repository);
  database.close();
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "有什么依据",
    anchorMemoryIds: ["event-museum"],
  });
  assert.equal(result.status, "ready");
  assert.equal(result.retrievalMode, "continuation");
  assert.equal(result.recallIntent, "evidence");
  assert.equal(result.disclosureLevel, "evidence");
  assert.match(result.context, /去了科技馆并参观机器人展/u);
  assert.match(result.context, /直接依据/u);
  assert.match(result.context, /User：我上周六去了科技馆/u);
  assert.match(result.context, /Agent：你还看了机器人展/u);
  assert.deepEqual(result.fragments[0].evidenceIds, ["u-user", "u-agent"]);
  assert.deepEqual(result.trace.metadata.evidenceMemoryIds, ["u-user", "u-agent"]);
  assert.deepEqual(result.graph.evidenceMemoryIds, ["u-user", "u-agent"]);
  assert.deepEqual(result.seedRouting.plannedRoutes, ["continuation"]);
});

test("separates direct supporting memories from deeper original wording", async () => {
  assert.equal(classifyRecallIntent("你为什么觉得我喜欢解谜游戏"), "evidence");
  assert.equal(
    classifyRepresentationIntent("你为什么觉得我喜欢解谜游戏"),
    "evaluated",
  );
  assert.equal(
    classifyRepresentationIntent("你确定我喜欢解谜游戏吗"),
    "evaluated",
  );
  assert.equal(classifyRecallIntent("有什么反证"), "counterevidence");
  assert.equal(classifyRecallIntent("这个判断可靠吗"), "evidence-review");
  assert.equal(classifyRecallIntent("有没有例外"), "evidence-review");
  assert.equal(isContinuationQuery("这个判断可靠吗"), true);
  assert.deepEqual(classifyChainIntent("你为什么觉得我喜欢解谜游戏"), {
    mode: "none",
    direction: "both",
  });

  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "puzzle-preference",
    agentId: "agent-test",
    kind: "derived_hypothesis",
    layer: "semantic",
    content: "用户对机关解谜游戏有稳定偏好。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:mechanical-puzzles",
    reality: "real",
    evidenceMode: "inferred",
    representationLayer: "inferred",
    stateFamily: "preference",
    statePhase: "active",
    temporalState: "current",
  });
  repository.upsertMemory({
    id: "puzzle-choice-event",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户在空闲时间主动选择玩机关解谜游戏。",
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    evidenceMode: "explicit",
    eventDate: "2026-07-18",
  });
  repository.upsertMemory({
    id: "puzzle-choice-utterance",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "今天空下来我还是想玩机关解谜。",
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    evidenceMode: "imported",
    eventStart: "2026-07-18T10:00:00.000Z",
    metadata: { speaker: "User" },
  });
  for (const [fromMemoryId, toMemoryId] of [
    ["puzzle-preference", "puzzle-choice-event"],
    ["puzzle-choice-event", "puzzle-choice-utterance"],
  ]) {
    repository.upsertEdge({
      agentId: "agent-test",
      fromMemoryId,
      toMemoryId,
      relation: "supported_by",
      direction: "directed",
      weight: 1,
      confidence: 1,
      provenance: "test",
    });
  }
  database.close();

  const directEvidence = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "有什么依据",
    anchorMemoryIds: ["puzzle-preference"],
  });
  assert.equal(directEvidence.status, "ready");
  assert.match(directEvidence.context, /直接依据/u);
  assert.match(directEvidence.context, /主动选择玩机关解谜游戏/u);
  assert.doesNotMatch(directEvidence.context, /今天空下来/u);
  assert.deepEqual(directEvidence.fragments[0].evidenceIds, ["puzzle-choice-event"]);

  const originalWording = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "原话怎么说",
    anchorMemoryIds: ["puzzle-preference"],
  });
  assert.equal(originalWording.status, "ready");
  assert.match(originalWording.context, /相关原话/u);
  assert.match(originalWording.context, /User：今天空下来我还是想玩机关解谜/u);
  assert.doesNotMatch(originalWording.context, /直接依据/u);
  assert.deepEqual(originalWording.fragments[0].evidenceIds, ["puzzle-choice-utterance"]);
});

test("retrieves only explicit challenged-by memories when counterevidence is requested", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "counter-focus",
    agentId: "agent-test",
    kind: "derived_hypothesis",
    layer: "semantic",
    content: "用户可能对机关解谜游戏有稳定偏好。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:mechanical-puzzles",
    representationLayer: "inferred",
    stateFamily: "preference",
    statePhase: "active",
    stateScopeKey: "root",
    temporalState: "current",
  });
  repository.upsertMemory({
    id: "counter-support",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户曾在空闲时主动选择机关解谜游戏。",
    subjectRole: "user",
    subjectKey: "user",
    eventDate: "2026-07-18",
  });
  repository.upsertMemory({
    id: "counter-challenge",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户也曾在有空时明确选择别的活动并拒绝机关解谜游戏。",
    subjectRole: "user",
    subjectKey: "user",
    eventDate: "2026-07-25",
  });
  for (const [toMemoryId, relation] of [
    ["counter-support", "supported_by"],
    ["counter-challenge", "challenged_by"],
  ]) {
    repository.upsertEdge({
      agentId: "agent-test",
      fromMemoryId: "counter-focus",
      toMemoryId,
      relation,
      direction: "directed",
      weight: 1,
    });
  }
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "有什么反证",
    anchorMemoryIds: ["counter-focus"],
  });
  assert.equal(result.status, "ready");
  assert.equal(result.recallIntent, "counterevidence");
  assert.equal(result.chainIntent.mode, "none");
  assert.match(result.context, /相反依据/u);
  assert.match(result.context, /选择别的活动/u);
  assert.doesNotMatch(result.context, /曾在空闲时主动选择机关解谜/u);
  assert.deepEqual(result.fragments[0].evidenceIds, ["counter-challenge"]);
});

test("reviews reliability with the strongest direct support and counterevidence", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "review-focus",
    agentId: "agent-test",
    kind: "derived_hypothesis",
    layer: "semantic",
    content: "系统推断用户对机关解谜游戏有稳定偏好。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:mechanical-puzzles",
    representationLayer: "inferred",
    stateFamily: "preference",
    statePhase: "active",
    stateScopeKey: "root",
    temporalState: "current",
  });
  for (const memory of [
    {
      id: "review-support-strong",
      content: "用户多次在自由时间主动选择机关解谜游戏。",
      eventDate: "2026-07-20",
    },
    {
      id: "review-support-weak",
      content: "用户有一次顺手打开机关解谜游戏。",
      eventDate: "2026-07-24",
    },
    {
      id: "review-counter-strong",
      content: "用户在有真实替代项时明确拒绝机关解谜游戏。",
      eventDate: "2026-07-23",
    },
    {
      id: "review-counter-weak",
      content: "用户有一次暂时没有继续机关解谜游戏。",
      eventDate: "2026-07-25",
    },
  ]) {
    repository.upsertMemory({
      ...memory,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      subjectRole: "user",
      subjectKey: "user",
      eventStart: `${memory.eventDate}T08:00:00.000Z`,
    });
  }
  for (const edge of [
    { toMemoryId: "review-support-strong", relation: "supported_by", weight: 0.9, confidence: 0.9 },
    { toMemoryId: "review-support-weak", relation: "supported_by", weight: 1, confidence: 0.7 },
    { toMemoryId: "review-counter-strong", relation: "challenged_by", weight: 0.8, confidence: 1 },
    { toMemoryId: "review-counter-weak", relation: "challenged_by", weight: 0.95, confidence: 0.7 },
  ]) {
    repository.upsertEdge({
      agentId: "agent-test",
      fromMemoryId: "review-focus",
      direction: "directed",
      provenance: "test",
      ...edge,
    });
  }
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "这个判断可靠吗",
    anchorMemoryIds: ["review-focus"],
  });
  assert.equal(result.status, "ready");
  assert.equal(result.recallIntent, "evidence-review");
  assert.equal(result.chainIntent.mode, "none");
  assert.deepEqual(result.fragments[0].evidenceIds, [
    "review-support-strong",
    "review-counter-strong",
  ]);
  assert.deepEqual(result.graph.supportEvidenceMemoryIds, ["review-support-strong"]);
  assert.deepEqual(result.graph.counterevidenceMemoryIds, ["review-counter-strong"]);
  assert.deepEqual(result.trace.metadata.supportEvidenceMemoryIds, ["review-support-strong"]);
  assert.deepEqual(result.trace.metadata.counterevidenceMemoryIds, ["review-counter-strong"]);
  assert.match(result.context, /最强直接依据/u);
  assert.match(result.context, /多次在自由时间主动选择/u);
  assert.match(result.context, /最强相反依据/u);
  assert.match(result.context, /有真实替代项时明确拒绝/u);
  assert.doesNotMatch(result.context, /顺手打开/u);
  assert.doesNotMatch(result.context, /暂时没有继续/u);
});

test("states when one side of a reliability review has no direct evidence", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "one-sided-review-focus",
    agentId: "agent-test",
    kind: "derived_hypothesis",
    layer: "semantic",
    content: "系统推断用户可能喜欢拼图。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:jigsaw",
    representationLayer: "inferred",
    stateFamily: "preference",
    statePhase: "active",
    stateScopeKey: "root",
    temporalState: "current",
  });
  repository.upsertMemory({
    id: "one-sided-review-support",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户在自由时间主动选择拼图。",
    subjectRole: "user",
    subjectKey: "user",
    eventDate: "2026-07-26",
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "one-sided-review-focus",
    toMemoryId: "one-sided-review-support",
    relation: "supported_by",
    direction: "directed",
    weight: 1,
    confidence: 1,
    provenance: "test",
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "有没有例外",
    anchorMemoryIds: ["one-sided-review-focus"],
  });
  assert.equal(result.status, "ready");
  assert.equal(result.recallIntent, "evidence-review");
  assert.match(result.context, /最强直接依据/u);
  assert.match(result.context, /未找到与这条记忆直接关联的相反依据/u);
  assert.deepEqual(result.graph.supportEvidenceMemoryIds, ["one-sided-review-support"]);
  assert.deepEqual(result.graph.counterevidenceMemoryIds, []);
});

test("does not present a neighboring event's dialogue as direct evidence", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "unsupported-focus",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户曾经考虑去天文馆。",
    subjectRole: "user",
    subjectKey: "user",
  });
  repository.upsertMemory({
    id: "neighbor-event",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户后来去了公园。",
    subjectRole: "user",
    subjectKey: "user",
  });
  repository.upsertMemory({
    id: "neighbor-utterance",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "我后来去了公园。",
    subjectRole: "user",
    subjectKey: "user",
    metadata: { speaker: "User" },
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "unsupported-focus",
    toMemoryId: "neighbor-event",
    relation: "same_thread",
    direction: "directed",
    weight: 1,
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "neighbor-event",
    toMemoryId: "neighbor-utterance",
    relation: "supported_by",
    direction: "directed",
    weight: 1,
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "有什么依据",
    anchorMemoryIds: ["unsupported-focus"],
  });
  assert.equal(result.status, "ready");
  assert.deepEqual(result.fragments[0].evidenceIds, []);
  assert.match(result.context, /未找到与这条记忆直接关联的支持依据/u);
  assert.doesNotMatch(result.context, /我后来去了公园/u);
});

test("keeps current-state correction visible without hiding evidence for the historical focus", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "historical-fish-belief",
    agentId: "agent-test",
    kind: "belief_state",
    layer: "semantic",
    content: `Agent 以前觉得鱼很难吃。${"过去状态补充".repeat(40)}`,
    subjectRole: "agent",
    subjectKey: "agent-test",
    canonicalKey: "agent:belief:food:fish",
    representationLayer: "reported",
    stateFamily: "belief",
    statePhase: "active",
    stateScopeKey: "root",
    temporalState: "historical",
    status: "superseded",
  });
  repository.upsertMemory({
    id: "current-fish-belief",
    agentId: "agent-test",
    kind: "belief_state",
    layer: "semantic",
    content: `Agent 现在知道有些鱼很好吃。${"当前状态补充".repeat(40)}`,
    subjectRole: "agent",
    subjectKey: "agent-test",
    canonicalKey: "agent:belief:food:fish",
    representationLayer: "reported",
    stateFamily: "belief",
    statePhase: "active",
    stateScopeKey: "root",
    temporalState: "current",
  });
  repository.upsertMemory({
    id: "historical-fish-evidence",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: `Agent 当时吃到一道处理失败的鱼菜后明确表达不喜欢。${"证据补充".repeat(40)}`,
    subjectRole: "agent",
    subjectKey: "agent-test",
    eventDate: "2026-07-01",
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "historical-fish-belief",
    toMemoryId: "historical-fish-evidence",
    relation: "supported_by",
    direction: "directed",
    weight: 1,
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "有什么依据",
    anchorMemoryIds: ["historical-fish-belief"],
    options: { maximumContextChars: 420 },
  });
  assert.equal(result.status, "ready");
  assert.match(result.context, /当前状态：Agent 现在知道有些鱼很好吃/u);
  assert.match(result.context, /过去的状态（已被后续更新）：Agent 以前觉得鱼很难吃/u);
  assert.match(result.context, /直接依据/u);
  assert.match(result.context, /处理失败的鱼菜/u);
  assert.equal(result.context.length <= 420, true);
  assert.equal(result.outputBudget.safetyTruncationApplied, false);
  assert.deepEqual(result.fragments[0].evidenceIds, ["historical-fish-evidence"]);
});

test("keeps scoped exceptions visible without hiding evidence for the broad focus", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  const scopeKey = `scope:${"a".repeat(64)}`;
  repository.upsertMemory({
    id: "broad-fish-preference",
    agentId: "agent-test",
    kind: "preference",
    layer: "semantic",
    content: "用户现在总体喜欢吃鱼。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:food:fish",
    representationLayer: "reported",
    stateFamily: "preference",
    statePhase: "active",
    stateScopeKey: "root",
    temporalState: "current",
  });
  repository.upsertMemory({
    id: "fish-preference-exception",
    agentId: "agent-test",
    kind: "preference",
    layer: "semantic",
    content: "用户不喜欢处理不好的腥味鱼。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:food:fish",
    representationLayer: "reported",
    stateFamily: "preference",
    statePhase: "active",
    stateScopeKey: scopeKey,
    temporalState: "current",
  });
  repository.upsertMemory({
    id: "broad-fish-evidence",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户后来主动选择并称赞了两道不同的鱼菜。",
    subjectRole: "user",
    subjectKey: "user",
    eventDate: "2026-07-10",
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "fish-preference-exception",
    toMemoryId: "broad-fish-preference",
    relation: "scoped_exception_to",
    direction: "directed",
    weight: 1,
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "broad-fish-preference",
    toMemoryId: "broad-fish-evidence",
    relation: "supported_by",
    direction: "directed",
    weight: 1,
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "有什么依据",
    anchorMemoryIds: ["broad-fish-preference"],
  });
  assert.equal(result.status, "ready");
  assert.match(result.context, /宽泛状态：用户现在总体喜欢吃鱼/u);
  assert.match(result.context, /局部例外：用户不喜欢处理不好的腥味鱼/u);
  assert.match(result.context, /直接依据/u);
  assert.match(result.context, /主动选择并称赞了两道不同的鱼菜/u);
  assert.deepEqual(result.fragments[0].evidenceIds, ["broad-fish-evidence"]);
});

test("resolves only explicit query subjects and ignores conversational frames", () => {
  const perspective = { addresseeKey: "agent-test" };
  const framed = resolveQuerySubject("你还记得我上周六去了科技馆吗", perspective);
  assert.equal(framed.matched, true);
  assert.equal(framed.mode, "personal");
  assert.equal(framed.role, "user");
  assert.equal(framed.key, "user");
  assert.match(framed.basis, /^我上周六去/u);
  assert.equal(resolveQuerySubject("你以前喜欢围棋吗", perspective).role, "agent");
  assert.equal(resolveQuerySubject("你最喜欢围棋吗", perspective).role, "agent");
  assert.equal(resolveQuerySubject("你最喜欢围棋吗", perspective).focus, "state");
  assert.equal(resolveQuerySubject("我们上次一起去了科技馆", perspective).mode, "shared");
  assert.equal(resolveQuerySubject("你还记得科技馆吗", perspective).matched, false);
  assert.equal(resolveQuerySubject("我妈以前去了科技馆", perspective).matched, false);
  assert.equal(resolveQuerySubject("我说过“你喜欢围棋”吗", perspective).matched, false);
});

test("does not answer a personal state question from an unowned mixed event", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "mixed-ai-conversation",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户谈到人工智能，Agent参与了讨论。",
    subjectRole: "unknown",
    subjectKey: "",
    actorRoles: [{
      role: "participant",
      actorRole: "agent",
      actorKey: "agent-test",
      confidence: 1,
      provenance: "test",
    }],
  });
  repository.upsertMemory({
    id: "agent-ai-utterance",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "人工智能正在改变很多行业。",
    subjectRole: "agent",
    subjectKey: "agent-test",
    actorRoles: [{
      role: "speaker",
      actorRole: "agent",
      actorKey: "agent-test",
      isPrimary: true,
      confidence: 1,
      provenance: "test",
    }],
  });
  database.close();
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "你最喜欢人工智能吗",
  });
  assert.equal(result.status, "no-match");
  assert.equal(
    result.seedRouting.subjectRouting.hardRejectedCandidateIds.includes(
      "mixed-ai-conversation",
    ),
    true,
  );
});

test("hard-gates personal state candidates by the explicitly queried holder", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  const common = {
    agentId: "agent-test",
    kind: "preference",
    layer: "semantic",
    representationLayer: "reported",
    stateFamily: "preference",
    statePhase: "active",
    temporalState: "current",
    evidenceMode: "explicit",
    knownAt: "2026-08-02T08:00:00.000Z",
    validFrom: "2026-08-02T08:00:00.000Z",
  };
  repository.upsertMemory({
    ...common,
    id: "user-go-preference",
    content: "用户明确报告自己喜欢围棋。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:go",
  });
  repository.upsertMemory({
    ...common,
    id: "agent-go-preference",
    content: "Agent明确报告自己喜欢围棋。",
    subjectRole: "agent",
    subjectKey: "agent-test",
    canonicalKey: "agent:preference:go",
  });
  database.close();

  const userRecall = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "我以前喜欢围棋吗",
  });
  assert.equal(userRecall.fragments[0].memoryId, "user-go-preference");
  assert.deepEqual(
    userRecall.seedRouting.subjectRouting.hardRejectedCandidateIds,
    ["agent-go-preference"],
  );
  assert.equal(
    userRecall.candidates[0].routeMatches.some((route) => (
      route.route === "subject" && route.strength === "exact-holder"
    )),
    true,
  );

  const agentRecall = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "你以前喜欢围棋吗",
  });
  assert.equal(agentRecall.fragments[0].memoryId, "agent-go-preference");
  assert.deepEqual(
    agentRecall.seedRouting.subjectRouting.hardRejectedCandidateIds,
    ["user-go-preference"],
  );
});

test("prefers a current structured state over its newer raw utterance", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "user-go-current-state",
    agentId: "agent-test",
    kind: "preference",
    layer: "semantic",
    content: "用户明确报告自己喜欢围棋。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:go",
    representationLayer: "reported",
    stateFamily: "preference",
    statePhase: "active",
    temporalState: "current",
    status: "active",
    evidenceMode: "explicit",
    knownAt: "2026-08-01T08:00:00.000Z",
    validFrom: "2026-08-01T08:00:00.000Z",
    recordedAt: "2026-08-01T08:00:00.000Z",
  });
  repository.upsertMemory({
    id: "user-go-newer-utterance",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "User说自己喜欢围棋。",
    subjectRole: "user",
    subjectKey: "user",
    eventStart: "2026-08-02T08:00:00.000Z",
    recordedAt: "2026-08-02T08:00:00.000Z",
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "我喜欢围棋吗",
  });
  assert.equal(result.fragments[0].memoryId, "user-go-current-state");
  assert.deepEqual(
    result.candidates.slice(0, 2).map((candidate) => candidate.memoryId),
    ["user-go-current-state"],
  );
  assert.doesNotMatch(result.context, /User说自己喜欢围棋/u);
});

test("hard-gates original-wording recall by the explicitly queried speaker", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "user-museum-utterance",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "User说科技馆的机器人展很有意思。",
    subjectRole: "user",
    subjectKey: "user",
  });
  repository.upsertMemory({
    id: "agent-museum-utterance",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "Agent说科技馆的机器人展很有意思。",
    subjectRole: "agent",
    subjectKey: "agent-test",
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "我说过什么关于科技馆的话",
  });
  assert.equal(result.recallIntent, "utterance");
  assert.equal(result.fragments[0].memoryId, "user-museum-utterance");
  assert.deepEqual(
    result.seedRouting.subjectRouting.hardRejectedCandidateIds,
    ["agent-museum-utterance"],
  );

  const agentResult = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "你说过什么关于科技馆的话",
  });
  assert.equal(agentResult.recallIntent, "utterance");
  assert.equal(agentResult.fragments[0].memoryId, "agent-museum-utterance");
  assert.deepEqual(
    agentResult.seedRouting.subjectRouting.hardRejectedCandidateIds,
    ["user-museum-utterance"],
  );
});

test("uses structured event participants without rejecting incomplete multi-person events", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  const linked = repository.upsertMemory({
    id: "shared-fireworks-linked",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "Agent和用户上周一起看了江边烟花。",
    subjectRole: "agent",
    subjectKey: "agent-test",
  });
  repository.upsertMemoryRole({
    memoryId: linked.id,
    agentId: "agent-test",
    role: "participant",
    actorRole: "user",
    actorKey: "user",
  });
  repository.upsertMemory({
    id: "shared-fireworks-incomplete",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "Agent和用户后来还看了另一场烟花。",
    subjectRole: "agent",
    subjectKey: "agent-test",
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "我上周看过江边烟花吗",
  });
  assert.equal(result.status, "ready");
  assert.equal(result.fragments[0].memoryId, linked.id);
  assert.equal(
    result.candidates[0].routeMatches.some((route) => (
      route.route === "subject" && route.strength === "structured-participant"
    )),
    true,
  );
  assert.deepEqual(result.seedRouting.subjectRouting.hardRejectedCandidateIds, []);
});

test("keeps pre-role read-only databases recallable", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  seedMuseumMemory(repository);
  database.exec("DROP TABLE memory_actor_roles;");
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "记得我之前去科技馆吗",
  });
  assert.equal(result.status, "ready");
  assert.equal(result.fragments[0].memoryId, "event-museum");
  assert.equal(result.seedRouting.subjectRouting.query.role, "user");
});

test("keeps learned state inert until retrieval explicitly adopts it", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  seedMuseumMemory(repository);
  database.close();
  const input = {
    databasePath,
    agentId: "agent-test",
    query: "记得我之前去科技馆吗",
    now: new Date("2026-07-15T12:00:00+08:00"),
  };
  const before = await retrieveMemories(input);
  const writable = openMemoryDatabase(databasePath);
  writable.prepare(`
    INSERT INTO memory_accessibility_state (
      memory_id, agent_id, value, policy_version,
      last_observation_window_id, last_applied_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "event-museum",
    "agent-test",
    0,
    "test-inert-policy",
    "test-inert-window",
    "2026-07-15T00:00:00.000Z",
    "2026-07-15T00:00:00.000Z",
    "2026-07-15T00:00:00.000Z",
  );
  writable.close();
  const after = await retrieveMemories(input);
  assert.deepEqual(after.trace.seedIds, before.trace.seedIds);
  assert.deepEqual(after.fragments, before.fragments);
  assert.equal(after.context, before.context);
});

test("uses only explicitly enabled and policy-approved accessibility to rerank admitted seeds", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "museum-older",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "科技馆机器人展",
    content: "用户去了科技馆机器人展。",
    subjectRole: "user",
    subjectKey: "user",
    eventDate: "2026-07-01",
    recordedAt: "2026-07-01T00:00:00.000Z",
  });
  repository.upsertMemory({
    id: "museum-newer",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "科技馆机器人展",
    content: "用户又去了科技馆机器人展。",
    subjectRole: "user",
    subjectKey: "user",
    eventDate: "2026-07-02",
    recordedAt: "2026-07-02T00:00:00.000Z",
  });
  database.prepare(`
    INSERT INTO memory_accessibility_state (
      memory_id, agent_id, value, policy_version,
      last_observation_window_id, last_applied_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "museum-older",
    "agent-test",
    1,
    "test-memory-policy-v1",
    "test-window",
    "2026-07-03T00:00:00.000Z",
    "2026-07-03T00:00:00.000Z",
    "2026-07-03T00:00:00.000Z",
  );
  database.close();

  const baseline = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "科技馆机器人展",
  });
  assert.equal(baseline.fragments[0].memoryId, "museum-newer");

  const learned = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "科技馆机器人展",
    options: { plasticity: explicitPlasticityOptions() },
  });
  assert.equal(learned.fragments[0].memoryId, "museum-older");
  assert.equal(learned.candidates[0].accessibility.policyVersion, "test-memory-policy-v1");
  assert.equal(learned.candidates[0].accessibility.scoreAdjustment, 0.4);
  assert.equal(learned.trace.metadata.plasticity.adjustedCandidateCount, 1);
});

test("applies approved relation utility only to the matching intent view", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  seedMuseumMemory(repository);
  for (const [id, content] of [
    ["association-high", "后来一起聊了航天。"],
    ["association-low", "后来一起吃了点心。"],
  ]) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content,
      subjectRole: "shared",
      subjectKey: "shared:agent-test:user",
      eventDate: "2026-07-12",
      recordedAt: "2026-07-12T00:00:00.000Z",
    });
  }
  const high = repository.upsertEdge({
    id: "association-edge-high",
    agentId: "agent-test",
    fromMemoryId: "event-museum",
    toMemoryId: "association-high",
    relation: "associated_with",
    direction: "undirected",
    weight: 0.9,
  });
  const low = repository.upsertEdge({
    id: "association-edge-low",
    agentId: "agent-test",
    fromMemoryId: "event-museum",
    toMemoryId: "association-low",
    relation: "associated_with",
    direction: "undirected",
    weight: 0.9,
  });
  const insert = database.prepare(`
    INSERT INTO memory_edge_relation_utility_state (
      edge_id, agent_id, intent_view, value, policy_version,
      last_observation_window_id, last_applied_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [edgeId, value] of [[high.id, 1], [low.id, 0]]) {
    insert.run(
      edgeId,
      "agent-test",
      "associative",
      value,
      "test-edge-policy-v1",
      "test-window",
      "2026-07-15T00:00:00.000Z",
      "2026-07-15T00:00:00.000Z",
      "2026-07-15T00:00:00.000Z",
    );
  }
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "科技馆还让你想起什么",
    options: {
      maximumChainMemories: 2,
      plasticity: explicitPlasticityOptions(),
    },
  });
  assert.deepEqual(result.graph.selectedMemoryIds, ["event-museum", "association-high"]);
  const step = result.graph.paths[0].edges[0];
  assert.equal(step.learnedRelationUtility.policyVersion, "test-edge-policy-v1");
  assert.equal(step.learnedRelationUtility.multiplier, 2);
  assert.equal(step.appliedRelationUtility, 2);
  assert.equal(result.trace.metadata.plasticity.adjustedEdgeTraversalCount, 1);
});

test("rejects incomplete plasticity activation instead of inventing defaults", async () => {
  await assert.rejects(
    () => retrieveMemories({
      databasePath: "not-opened.db",
      agentId: "agent-test",
      query: "科技馆",
      options: {
        plasticity: {
          enabled: true,
          configurationVersion: "incomplete",
          memory: {
            neutralValue: 0.5,
            maximumScoreAdjustment: 0.2,
            allowedPolicyVersions: ["memory-policy"],
          },
        },
      },
    }),
    /必须同时提供 memory 与 edge/u,
  );
});

test("uses explicit affective activation only to rerank already-admitted ordinary seeds", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  for (const [id, content, recordedAt] of [
    ["walk-older", "周末散步计划是在河边走一圈。", "2026-07-11T01:00:00.000Z"],
    ["walk-newer", "周末散步计划是在河边走一圈。", "2026-07-11T02:00:00.000Z"],
    ["museum-unrelated", "用户整理了一份完全不同的旧记录。", "2026-07-10T01:00:00.000Z"],
  ]) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content,
      subjectRole: "user",
      subjectKey: "user",
      eventDate: id === "museum-unrelated" ? "2026-07-10" : "2026-07-11",
      recordedAt,
    });
  }
  const museum = repository.upsertEntity({
    id: "place:science-museum",
    agentId: "agent-test",
    kind: "place",
    canonicalName: "上海科技馆",
    aliases: ["科技馆"],
  });
  for (const memoryId of ["walk-older", "museum-unrelated"]) {
    repository.linkMemoryEntity({ memoryId, entityId: museum.id, role: "location" });
  }
  const affectiveState = repository.upsertMemory({
    id: "reported-museum-happiness",
    agentId: "agent-test",
    kind: "belief_state",
    layer: "semantic",
    content: "用户报告想到科技馆会开心。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:affective:science-museum:happy",
    evidenceMode: "explicit",
    representationLayer: "reported",
    stateFamily: "affective_association",
    statePhase: "active",
    temporalState: "current",
    validFrom: "2026-07-11T03:00:00.000Z",
    recordedAt: "2026-07-11T03:00:00.000Z",
    metadata: {
      reportedStateDraft: {
        affectiveClaim: {
          trigger: { role: "other", key: museum.id, label: "科技馆" },
          emotion: { label: "开心", valence: "positive", intensity: "high" },
        },
      },
    },
  });
  repository.recordAffectiveActivationDecision({
    agentId: "agent-test",
    memoryId: affectiveState.id,
    enabled: true,
    policyVersion: "human-affective-v1",
    actor: "human:test",
    reason: "只允许影响已经命中的普通候选排序。",
    createdAt: "2026-07-11T04:00:00.000Z",
  });
  database.close();

  const baseline = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "周末散步计划",
  });
  assert.equal(baseline.fragments[0].memoryId, "walk-newer");
  assert.equal(baseline.trace.metadata.affectiveBias.enabled, false);

  const biased = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "周末散步计划",
    options: { affectiveBias: explicitAffectiveBiasOptions() },
  });
  assert.equal(biased.fragments[0].memoryId, "walk-older");
  assert.equal(biased.candidates[0].affectiveBias.scoreAdjustment, 0.4);
  assert.deepEqual(
    biased.candidates[0].affectiveBias.activationMemoryIds,
    ["reported-museum-happiness"],
  );
  assert.equal(
    biased.candidates.some((candidate) => candidate.memoryId === "museum-unrelated"),
    false,
  );
  assert.equal(biased.trace.metadata.affectiveBias.adjustedCandidateCount, 1);
  assert.equal(JSON.stringify(biased.trace.metadata.affectiveBias).includes("开心"), false);
  assert.equal(JSON.stringify(biased.trace.metadata.affectiveBias).includes("科技馆"), false);

  const temporal = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "我上周六干啥了",
    now: new Date("2026-07-15T12:00:00+08:00"),
    options: { affectiveBias: explicitAffectiveBiasOptions() },
  });
  assert.equal(temporal.fragments[0].memoryId, "walk-newer");
  assert.equal(temporal.trace.metadata.affectiveBias.adjustedCandidateCount, 0);
  assert.equal(temporal.candidates[0].affectiveBias, null);

  const reopened = openMemoryDatabase(databasePath);
  const reopenedRepository = new MemoryRepository(reopened);
  reopenedRepository.recordAffectiveActivationDecision({
    agentId: "agent-test",
    memoryId: affectiveState.id,
    enabled: false,
    policyVersion: "human-affective-v1",
    actor: "human:test",
    reason: "撤销激活权限。",
    createdAt: "2026-07-11T05:00:00.000Z",
  });
  reopened.close();
  const disabled = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "周末散步计划",
    options: { affectiveBias: explicitAffectiveBiasOptions() },
  });
  assert.equal(disabled.fragments[0].memoryId, "walk-newer");
  assert.deepEqual(disabled.trace.metadata.affectiveBias.approvedActivationIds, []);
});

test("rejects incomplete affective bias activation instead of guessing emotion context", async () => {
  await assert.rejects(
    () => retrieveMemories({
      databasePath: "not-opened.db",
      agentId: "agent-test",
      query: "科技馆",
      options: {
        affectiveBias: {
          enabled: true,
          configurationVersion: "incomplete-affective-config",
        },
      },
    }),
    /需要明确的 subjectRole 与 subjectKey/u,
  );
});

test("returns a persistable retrieval trace without writing it by default", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  seedMuseumMemory(repository);
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "记得我之前去科技馆吗",
  });
  assert.equal(result.trace.resultStatus, "ready");
  assert.equal(result.trace.queryText, "记得我之前去科技馆吗");
  assert.deepEqual(result.trace.seedIds, ["event-museum"]);
  assert.deepEqual(result.trace.selectedIds, ["event-museum"]);
  assert.equal(result.trace.contextChars, result.context.length);

  const writable = openMemoryDatabase(databasePath);
  assert.equal(Number(writable.prepare(`
    SELECT COUNT(*) AS count FROM memory_retrieval_traces
  `).get().count), 0);
  const writableRepository = new MemoryRepository(writable);
  const stored = writableRepository.recordRetrievalTrace(result.trace);
  assert.deepEqual(stored.seedIds, ["event-museum"]);
  assert.equal(stored.result_status, "ready");
  assert.deepEqual(stored.metadata.seedRouting, result.seedRouting);
  assert.equal(Number(writable.prepare(`
    SELECT COUNT(*) AS count FROM memory_retrieval_traces
  `).get().count), 1);
  writable.close();
});

test("returns one nearby two-sided exchange when original wording is requested", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  seedMuseumMemory(repository);
  repository.upsertMemory({
    id: "unrelated-wording",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "那句话我已经改过了。",
    subjectRole: "agent",
    subjectKey: "agent-test",
    recordedAt: "2026-07-12T03:00:00.000Z",
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "u-user",
    toMemoryId: "u-agent",
    relation: "followed_by",
    direction: "directed",
    weight: 0.7,
  });
  database.close();
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "科技馆那句话我是怎么说的",
  });
  assert.equal(result.status, "ready");
  assert.equal(result.fragments[0].memoryType, "utterance");
  assert.equal(result.disclosureLevel, "evidence");
  assert.match(result.context, /User：我上周六去了科技馆/u);
  assert.match(result.context, /Agent：你还看了机器人展/u);
});

test("walks a directional event chain only when the query asks what happened later", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  seedMuseumMemory(repository);
  repository.upsertMemory({
    id: "event-dinner",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "参观后的晚饭",
    content: "User 参观结束后去吃了晚饭。",
    subjectRole: "user",
    subjectKey: "user",
    eventDate: "2026-07-11",
    eventStart: "2026-07-11T10:00:00.000Z",
    recordedAt: "2026-07-11T10:00:00.000Z",
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "event-museum",
    toMemoryId: "event-dinner",
    relation: "timeline_next",
    direction: "directed",
    weight: 0.95,
  });
  database.close();
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "科技馆那次后来发生了什么",
  });
  assert.equal(result.status, "ready");
  assert.equal(result.chainIntent.mode, "timeline");
  assert.equal(result.chainIntent.direction, "forward");
  assert.equal(result.disclosureLevel, "related-memories");
  assert.deepEqual(
    result.graph.selectedMemoryIds,
    ["event-museum", "event-dinner"],
  );
  assert.match(result.context, /去了科技馆并参观机器人展/u);
  assert.match(result.context, /参观结束后去吃了晚饭/u);
});

test("does not use a structural topic's record time as an event timeline position", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "voice-topic",
    agentId: "agent-test",
    kind: "topic",
    layer: "semantic",
    title: "语音项目",
    content: "语音项目汇总了多次长期调试。",
    importance: 1,
    recordedAt: "2026-07-20T08:00:00.000Z",
  });
  repository.upsertMemory({
    id: "voice-event-start",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "语音项目开始时先完成了声音合成。",
    eventDate: "2026-07-01",
    eventStart: "2026-07-01T08:00:00.000Z",
    importance: 0.3,
    recordedAt: "2026-07-01T08:00:00.000Z",
  });
  repository.upsertMemory({
    id: "voice-event-result",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "语音项目后来确认只能先发送音频文件。",
    eventDate: "2026-07-02",
    eventStart: "2026-07-02T08:00:00.000Z",
    recordedAt: "2026-07-02T08:00:00.000Z",
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "voice-event-start",
    toMemoryId: "voice-event-result",
    relation: "timeline_next",
    direction: "directed",
    weight: 0.95,
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "voice-topic",
    toMemoryId: "voice-event-result",
    relation: "same_thread",
    direction: "directed",
    weight: 1,
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "语音项目后来发生了什么",
  });
  assert.deepEqual(result.graph.selectedMemoryIds, [
    "voice-event-start",
    "voice-event-result",
  ], JSON.stringify(result, null, 2));
  assert.equal(result.seedRouting.timelineRouting.intent, "forward");
  assert.equal(result.seedRouting.timelineRouting.selectedMemoryId, "voice-event-start");
  assert.deepEqual(
    result.seedRouting.timelineRouting.excludedStructuralMemoryIds,
    ["voice-topic"],
  );

  const topicOnly = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "后来呢",
    anchorMemoryIds: ["voice-topic"],
  });
  assert.deepEqual(topicOnly.graph.selectedMemoryIds, ["voice-topic"]);
  assert.deepEqual(topicOnly.graph.paths, []);
  assert.doesNotMatch(topicOnly.context, /只能先发送音频文件/u);
});

test("uses an explicit continuation anchor for a generic follow-up", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "continuation-start",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户先去了科技馆。",
    eventDate: "2026-07-11",
    eventStart: "2026-07-11T03:00:00.000Z",
  });
  repository.upsertMemory({
    id: "continuation-next",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "从科技馆出来以后两个人一起吃了晚饭。",
    eventDate: "2026-07-11",
    eventStart: "2026-07-11T10:00:00.000Z",
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "continuation-start",
    toMemoryId: "continuation-next",
    relation: "timeline_next",
    direction: "directed",
    weight: 0.95,
  });
  database.close();
  const withoutAnchor = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "然后呢",
  });
  assert.equal(withoutAnchor.status, "skipped");
  const continued = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "然后呢",
    anchorMemoryIds: ["continuation-start"],
  });
  assert.equal(continued.status, "ready");
  assert.equal(continued.retrievalMode, "continuation");
  assert.deepEqual(continued.graph.selectedMemoryIds, [
    "continuation-start",
    "continuation-next",
  ]);
  assert.equal(continued.trace.metadata.focusMemoryId, "continuation-start");
  assert.equal(continued.trace.metadata.continuationMemoryId, "continuation-next");
  assert.deepEqual(continued.trace.metadata.continuationFocuses, {
    version: 1,
    primaryMemoryId: "continuation-start",
    chainMemoryId: "continuation-next",
    representationMemoryIds: [],
    stateMemoryIds: ["continuation-start"],
    scopeMemoryIds: ["continuation-start"],
  });
  assert.deepEqual(
    resolveContinuationAnchors("后来呢", { id: "trace-chain", ...continued.trace }),
    {
      memoryIds: ["continuation-next"],
      focusRole: "chain-tail",
      reason: "timeline-chain-follow-up",
      sourceTraceId: "trace-chain",
    },
  );
  assert.deepEqual(
    resolveContinuationAnchors("有什么依据", { id: "trace-chain", ...continued.trace }),
    {
      memoryIds: ["continuation-start"],
      focusRole: "primary",
      reason: "evidence-primary-follow-up",
      sourceTraceId: "trace-chain",
    },
  );
  assert.deepEqual(resolveContinuationAnchors("后来呢", {
    id: "trace-legacy",
    metadata: {
      continuationMemoryId: "legacy-tail",
      focusMemoryId: "legacy-primary",
    },
    selectedIds: ["legacy-primary", "legacy-tail"],
  }), {
    memoryIds: ["legacy-tail"],
    focusRole: "legacy",
    reason: "legacy-single-focus",
    sourceTraceId: "trace-legacy",
  });
  assert.deepEqual(continued.seedRouting.plannedRoutes, ["continuation"]);
  assert.equal(continued.seedRouting.primaryMemoryId, "continuation-start");
  assert.equal(continued.candidates[0].routeMatches[0].route, "continuation");
});

test("interprets reverse lifecycle edges by chronology instead of storage direction", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "belief-fish-old",
    agentId: "agent-test",
    kind: "belief_state",
    layer: "semantic",
    content: "Agent 以前觉得所有鱼都很难吃。",
    subjectRole: "agent",
    subjectKey: "agent-test",
    canonicalKey: "agent:belief:fish-taste",
    representationLayer: "reported",
    stateFamily: "belief",
    statePhase: "active",
    stateScopeKey: "root",
    temporalState: "historical",
    status: "superseded",
    validFrom: "2026-07-01T08:00:00.000Z",
    validTo: "2026-07-10T08:00:00.000Z",
    recordedAt: "2026-07-20T08:00:00.000Z",
  });
  repository.upsertMemory({
    id: "belief-fish-current",
    agentId: "agent-test",
    kind: "belief_state",
    layer: "semantic",
    content: "Agent 现在知道有些鱼很好吃。",
    subjectRole: "agent",
    subjectKey: "agent-test",
    canonicalKey: "agent:belief:fish-taste",
    representationLayer: "reported",
    stateFamily: "belief",
    statePhase: "active",
    stateScopeKey: "root",
    temporalState: "current",
    status: "active",
    validFrom: "2026-07-10T08:00:00.000Z",
    recordedAt: "2026-07-10T08:00:00.000Z",
  });
  const edge = repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "belief-fish-current",
    toMemoryId: "belief-fish-old",
    relation: "supersedes",
    direction: "directed",
    weight: 1,
    confidence: 1,
    provenance: "test",
  });
  database.close();

  const backward = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "之前呢",
    anchorMemoryIds: ["belief-fish-current"],
  });
  assert.deepEqual(backward.graph.selectedMemoryIds, [
    "belief-fish-old",
    "belief-fish-current",
  ], JSON.stringify(backward, null, 2));
  assert.equal(backward.trace.paths[0].edges[0].edgeId, edge.id);
  assert.equal(backward.trace.paths[0].edges[0].relationView, "timeline");
  assert.match(backward.context, /以前觉得所有鱼都很难吃/u);
  assert.match(backward.context, /状态生效时间/u);
  assert.ok(
    backward.context.indexOf("以前觉得所有鱼都很难吃")
      < backward.context.indexOf("现在知道有些鱼很好吃"),
    backward.context,
  );

  const forward = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "后来呢",
    anchorMemoryIds: ["belief-fish-current"],
  });
  assert.deepEqual(forward.graph.selectedMemoryIds, ["belief-fish-current"]);
  assert.doesNotMatch(forward.context, /以前觉得所有鱼都很难吃/u);

  const legacyDatabase = openMemoryDatabase(databasePath);
  const legacyRepository = new MemoryRepository(legacyDatabase);
  legacyRepository.upsertMemory({
    id: "legacy-fact-old",
    agentId: "agent-test",
    kind: "fact",
    layer: "semantic",
    content: "旧记录把活动地点写成了城东。",
    status: "superseded",
    recordedAt: "2026-07-01T08:00:00.000Z",
  });
  legacyRepository.upsertMemory({
    id: "legacy-fact-new",
    agentId: "agent-test",
    kind: "fact",
    layer: "semantic",
    content: "新记录确认活动地点其实在城西。",
    status: "active",
    recordedAt: "2026-07-02T08:00:00.000Z",
  });
  const correction = legacyRepository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "legacy-fact-new",
    toMemoryId: "legacy-fact-old",
    relation: "corrects",
    direction: "directed",
    weight: 1,
    confidence: 1,
    provenance: "test",
  });
  legacyDatabase.close();
  const correctedForward = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "后来呢",
    anchorMemoryIds: ["legacy-fact-old"],
  });
  assert.deepEqual(correctedForward.graph.selectedMemoryIds, [
    "legacy-fact-old",
    "legacy-fact-new",
  ]);
  assert.deepEqual(correctedForward.trace.paths[0].edges[0], {
    ...correctedForward.trace.paths[0].edges[0],
    edgeId: correction.id,
    fromMemoryId: "legacy-fact-new",
    toMemoryId: "legacy-fact-old",
    traversalFromMemoryId: "legacy-fact-old",
    traversalToMemoryId: "legacy-fact-new",
    chronologyDirection: "forward",
  });
});

test("anchors a forward chain at the earliest strongly matching event", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  for (const value of [
    {
      id: "voice-start",
      content: "开始调试语音功能，已经能够合成声音。",
      eventStart: "2026-07-23T02:00:00.000Z",
    },
    {
      id: "voice-result",
      content: "语音功能最终只能发送音频文件，暂时停止继续调试。",
      eventStart: "2026-07-23T10:00:00.000Z",
    },
  ]) {
    repository.upsertMemory({
      id: value.id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content: value.content,
      eventDate: "2026-07-23",
      eventStart: value.eventStart,
      recordedAt: value.eventStart,
    });
  }
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "voice-start",
    toMemoryId: "voice-result",
    relation: "timeline_next",
    direction: "directed",
    weight: 0.95,
  });
  database.close();
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "语音功能后来怎么样了",
  });
  assert.deepEqual(
    result.graph.selectedMemoryIds,
    ["voice-start", "voice-result"],
  );
});

test("prefers an exact event phrase over a generic first-time mention", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "mutual-like",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "我们第一次明确互相喜欢",
    content: "双方第一次把彼此的喜欢清楚说出来。",
    eventDate: "2026-06-16",
  });
  repository.upsertMemory({
    id: "photo-first",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "第一次展示照片",
    content: "这是第一次给我看他喜欢的照片。",
    eventDate: "2026-07-23",
  });
  database.close();
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "第一次明确互相喜欢",
  });
  assert.equal(result.fragments[0].memoryId, "mutual-like");
});

test("walks semantic links when the query explicitly asks for associations", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  seedMuseumMemory(repository);
  repository.upsertMemory({
    id: "event-robot-talk",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "机器人话题",
    content: "后来又聊起了机器人是否像人一样生活。",
    subjectRole: "shared",
    subjectKey: "shared:agent-test:user",
    eventDate: "2026-07-13",
    recordedAt: "2026-07-13T03:00:00.000Z",
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "event-museum",
    toMemoryId: "event-robot-talk",
    relation: "associated_with",
    direction: "undirected",
    weight: 0.9,
  });
  database.close();
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "科技馆还让你想起什么",
  });
  assert.equal(result.chainIntent.mode, "associative");
  assert.equal(result.graph.selectedMemoryIds.length, 2);
  assert.equal(result.graph.paths[0].edges[0].relationView, "associative");
  assert.equal(result.graph.paths[0].edges[0].relationUtility, 1);
  assert.match(result.context, /机器人是否像人一样生活/u);
});

test("walks an explicit shared-entity link only for associative recall", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "entity-memory-robot",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户在展览里看了机器人。",
    recordedAt: "2026-07-01T08:00:00.000Z",
  });
  repository.upsertMemory({
    id: "entity-memory-lecture",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "后来在同一个场馆参加了一场讲座。",
    recordedAt: "2026-07-05T08:00:00.000Z",
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "entity-memory-robot",
    toMemoryId: "entity-memory-lecture",
    relation: "shares_entity",
    direction: "undirected",
    weight: 0.9,
  });
  database.close();
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "机器人还让你想起什么",
  });
  assert.equal(result.chainIntent.mode, "associative");
  assert.deepEqual(result.graph.selectedMemoryIds, [
    "entity-memory-robot",
    "entity-memory-lecture",
  ]);
  assert.equal(result.graph.paths[0].edges[0].relationView, "associative");
  assert.equal(result.graph.paths[0].edges[0].relationUtility, 0.9);
  assert.match(result.context, /同一个场馆参加了一场讲座/u);
});

test("does not let associative graph expansion reintroduce another holder's state", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "user-puzzle-preference",
    agentId: "agent-test",
    kind: "preference",
    layer: "semantic",
    content: "用户喜欢机关解谜游戏。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:mechanical-puzzles",
    representationLayer: "reported",
    stateFamily: "preference",
    statePhase: "active",
    stateScopeKey: "root",
    temporalState: "current",
  });
  repository.upsertMemory({
    id: "agent-puzzle-preference",
    agentId: "agent-test",
    kind: "preference",
    layer: "semantic",
    content: "Agent 喜欢机关解谜游戏。",
    subjectRole: "agent",
    subjectKey: "agent-test",
    canonicalKey: "agent:preference:mechanical-puzzles",
    representationLayer: "reported",
    stateFamily: "preference",
    statePhase: "active",
    stateScopeKey: "root",
    temporalState: "current",
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "user-puzzle-preference",
    toMemoryId: "agent-puzzle-preference",
    relation: "associated_with",
    direction: "undirected",
    weight: 1,
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "我喜欢机关解谜还让你想起什么",
  });
  assert.equal(result.status, "ready");
  assert.equal(result.chainIntent.mode, "associative");
  assert.deepEqual(result.graph.selectedMemoryIds, ["user-puzzle-preference"]);
  assert.deepEqual(
    result.seedRouting.subjectRouting.hardRejectedGraphMemoryIds,
    ["agent-puzzle-preference"],
  );
  assert.doesNotMatch(result.context, /Agent 喜欢机关解谜游戏/u);
});

test("allocates the context budget across every selected chain memory before final formatting", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  const memories = [
    ["budget-one", "第一节点标记：预算主题。"],
    ["budget-two", "第二节点标记：同一件事的后续片段。"],
    ["budget-three", "第三节点标记：联想到的收尾片段。"],
  ];
  for (const [id, prefix] of memories) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content: `${prefix}${"这是用于验证分段预算的长内容。".repeat(40)}`,
      recordedAt: "2026-07-20T08:00:00.000Z",
    });
  }
  for (const [fromMemoryId, toMemoryId] of [
    ["budget-one", "budget-two"],
    ["budget-two", "budget-three"],
  ]) {
    repository.upsertEdge({
      agentId: "agent-test",
      fromMemoryId,
      toMemoryId,
      relation: "associated_with",
      direction: "undirected",
      weight: 1,
    });
  }
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "预算主题还让你想起什么",
    options: { maximumContextChars: 420 },
  });
  assert.deepEqual(result.graph.selectedMemoryIds, [
    "budget-one",
    "budget-two",
    "budget-three",
  ]);
  assert.match(result.context, /第一节点标记/u);
  assert.match(result.context, /第二节点标记/u);
  assert.match(result.context, /第三节点标记/u);
  assert.equal(result.context.length <= 420, true);
  assert.equal(result.outputBudget.safetyTruncationApplied, false);
  assert.deepEqual(result.trace.metadata.outputBudget, result.outputBudget);
});

test("suppresses arbitrary associative propagation from a high-fanout hub", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "fanout-hub",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户在科技馆参观了机器人展。",
    recordedAt: "2026-07-01T08:00:00.000Z",
  });
  for (let index = 1; index <= 9; index += 1) {
    const id = `fanout-neighbor-${index}`;
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content: `同一地点记录的普通活动 ${index}。`,
      recordedAt: `2026-07-${String(index + 1).padStart(2, "0")}T08:00:00.000Z`,
    });
    repository.upsertEdge({
      agentId: "agent-test",
      fromMemoryId: "fanout-hub",
      toMemoryId: id,
      relation: "shares_entity",
      direction: "undirected",
      weight: 0.9,
    });
  }
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "科技馆还让你想起什么",
  });

  assert.equal(result.status, "ready");
  assert.equal(result.chainIntent.mode, "associative");
  assert.deepEqual(result.graph.selectedMemoryIds, ["fanout-hub"]);
  assert.deepEqual(result.graph.paths, []);
  assert.doesNotMatch(result.context, /普通活动/u);
});

test("keeps mandatory lifecycle propagation outside the ordinary fanout budget", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "mandatory-hub",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户在科技馆完成了一次重要安排。",
    recordedAt: "2026-07-10T08:00:00.000Z",
  });
  repository.upsertMemory({
    id: "mandatory-plan",
    agentId: "agent-test",
    kind: "plan",
    layer: "prospective",
    content: "Agent 曾答应陪用户去科技馆完成这项安排。",
    recordedAt: "2026-07-01T08:00:00.000Z",
  });
  const completionEdge = repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "mandatory-hub",
    toMemoryId: "mandatory-plan",
    relation: "completes",
    direction: "directed",
    weight: 0.9,
  });
  for (let index = 1; index <= 9; index += 1) {
    const id = `mandatory-noise-${index}`;
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content: `同地点的无关记录 ${index}。`,
      recordedAt: `2026-06-${String(index).padStart(2, "0")}T08:00:00.000Z`,
    });
    repository.upsertEdge({
      agentId: "agent-test",
      fromMemoryId: "mandatory-plan",
      toMemoryId: id,
      relation: "shares_entity",
      direction: "undirected",
      weight: 0.9,
    });
    repository.upsertEdge({
      agentId: "agent-test",
      fromMemoryId: "mandatory-hub",
      toMemoryId: id,
      relation: "shares_entity",
      direction: "undirected",
      weight: 0.9,
    });
  }
  database.prepare(`
    INSERT INTO memory_edge_relation_utility_state (
      edge_id, agent_id, intent_view, value, policy_version,
      last_observation_window_id, last_applied_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    completionEdge.id,
    "agent-test",
    "associative",
    0,
    "test-edge-policy-v1",
    "test-window",
    "2026-07-15T00:00:00.000Z",
    "2026-07-15T00:00:00.000Z",
    "2026-07-15T00:00:00.000Z",
  );
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "还有相关的吗",
    anchorMemoryIds: ["mandatory-plan"],
    options: { plasticity: explicitPlasticityOptions() },
  });

  assert.deepEqual(result.graph.selectedMemoryIds, ["mandatory-plan", "mandatory-hub"]);
  assert.equal(result.graph.paths.length, 1);
  assert.equal(result.graph.paths[0].edges[0].relation, "completes");
  assert.equal(result.graph.paths[0].edges[0].propagationPolicy, "mandatory");
  assert.equal(result.graph.paths[0].edges[0].fanout, 9);
  assert.equal(result.graph.paths[0].edges[0].fanoutFactor, 1);
  assert.equal(result.graph.paths[0].edges[0].learnedRelationUtility, null);
  assert.equal(
    result.graph.paths[0].edges[0].appliedRelationUtility,
    result.graph.paths[0].edges[0].relationUtility,
  );
  assert.equal(result.trace.metadata.plasticity.adjustedEdgeTraversalCount, 0);
  assert.match(result.context, /曾答应陪用户去科技馆完成这项安排/u);
  assert.doesNotMatch(result.context, /无关记录/u);

  const reverse = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "还有相关的吗",
    anchorMemoryIds: ["mandatory-hub"],
  });
  assert.deepEqual(reverse.graph.selectedMemoryIds, ["mandatory-hub"]);
  assert.doesNotMatch(reverse.context, /曾答应陪用户/u);
});

test("uses an entity alias as a seed even when the memory text omits the place name", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  const memory = repository.upsertMemory({
    id: "entity-only-seed",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户在那里参加了一次很重要的年度活动。",
    recordedAt: "2026-07-01T08:00:00.000Z",
  });
  const entity = repository.upsertEntity({
    agentId: "agent-test",
    kind: "place",
    canonicalName: "上海科技馆",
    aliases: ["科技馆"],
  });
  repository.linkMemoryEntity({ memoryId: memory.id, entityId: entity.id, role: "location" });
  database.close();
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "还记得上海科技馆吗",
  });
  assert.equal(result.status, "ready");
  assert.equal(result.retrievalMode, "entity-lexical");
  assert.equal(result.fragments[0].memoryId, memory.id);
  assert.equal(result.matchedEntities[0].entityId, entity.id);
  assert.equal(result.candidates[0].entityScore > 0, true);
  assert.equal(
    result.candidates[0].routeMatches.some((route) => (
      route.route === "entity" && route.independentlyAdmissible
    )),
    true,
  );
  assert.equal(result.seedRouting.routeStatus.entity, "matched");
  assert.match(result.context, /参加了一次很重要的年度活动/u);
});

test("converges multiple independently matched clues through a real graph relation", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "converged-museum",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户去了科技馆并参观机器人展。",
    eventStart: "2026-07-11T03:00:00.000Z",
    recordedAt: "2026-07-11T03:00:00.000Z",
  });
  repository.upsertMemory({
    id: "converged-dinner",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "离开展馆后，两个人一起吃了晚饭。",
    eventStart: "2026-07-11T10:00:00.000Z",
    recordedAt: "2026-07-11T10:00:00.000Z",
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "converged-museum",
    toMemoryId: "converged-dinner",
    relation: "timeline_next",
    direction: "directed",
    weight: 0.9,
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "还记得科技馆和那顿晚饭吗",
  });

  assert.equal(result.status, "ready");
  assert.equal(result.chainIntent.mode, "none");
  assert.deepEqual(result.graph.selectedMemoryIds, [
    "converged-museum",
    "converged-dinner",
  ]);
  assert.deepEqual(result.graph.convergedSeeds, {
    memoryIds: ["converged-museum", "converged-dinner"],
    connections: [{
      fromMemoryId: "converged-museum",
      toMemoryId: "converged-dinner",
      relation: "timeline_next",
      viaMemoryId: "",
    }],
  });
  assert.match(result.context, /科技馆并参观机器人展/u);
  assert.match(result.context, /一起吃了晚饭/u);
});

test("combines activation from multiple seeds at their shared graph neighbor", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  for (const memory of [
    {
      id: "field-museum",
      kind: "event",
      layer: "episodic",
      content: "用户去了科技馆。",
      recordedAt: "2026-07-11T03:00:00.000Z",
    },
    {
      id: "field-dinner",
      kind: "event",
      layer: "episodic",
      content: "两个人后来吃了晚饭。",
      recordedAt: "2026-07-11T10:00:00.000Z",
    },
  ]) repository.upsertMemory({ agentId: "agent-test", ...memory });
  repository.upsertEpisode({
    id: "field-weekend",
    agentId: "agent-test",
    content: "这是同一次周末出行中的两个片段。",
    eventStart: "2026-07-11T03:00:00.000Z",
    eventEnd: "2026-07-11T12:00:00.000Z",
    recordedAt: "2026-07-12T08:00:00.000Z",
  });
  for (const fromMemoryId of ["field-museum", "field-dinner"]) {
    repository.linkMemoryToEpisode({
      agentId: "agent-test",
      memoryId: fromMemoryId,
      episodeId: "field-weekend",
      weight: 0.9,
    });
  }
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "还记得科技馆和那顿晚饭吗",
  });

  assert.deepEqual(result.graph.activationField.seedMemoryIds, [
    "field-museum",
    "field-dinner",
  ]);
  assert.deepEqual(result.graph.selectedMemoryIds, [
    "field-museum",
    "field-dinner",
    "field-weekend",
  ]);
  const topicActivation = result.graph.activationField.selected
    .find((value) => value.memoryId === "field-weekend");
  assert.equal(topicActivation.sourceCount, 2);
  const topicPath = result.graph.paths.find((value) => value.memoryId === "field-weekend");
  assert.equal(topicPath.seedContributions.length, 2);
  assert.equal(topicPath.edges[0].relation, "part_of_episode");
  assert.equal(
    topicActivation.activation > Math.max(
      ...topicPath.seedContributions.map((value) => value.score),
    ),
    true,
  );
  assert.match(result.context, /同一次周末出行中的两个片段/u);
});

test("recalls a shared topic without spilling its high-fanout member list", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "topic-primary",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户在科技馆参观了机器人展。",
    recordedAt: "2026-07-01T08:00:00.000Z",
  });
  repository.upsertTopic({
    id: "topic-science-visits",
    agentId: "agent-test",
    content: "这是与科学场馆体验有关的长期主题。",
  });
  repository.linkMemoryToTopic({
    agentId: "agent-test",
    memoryId: "topic-primary",
    topicId: "topic-science-visits",
  });
  for (let index = 1; index <= 9; index += 1) {
    const id = `topic-noise-${index}`;
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content: `主题下的普通活动 ${index}。`,
      recordedAt: `2026-06-${String(index).padStart(2, "0")}T08:00:00.000Z`,
    });
    repository.linkMemoryToTopic({
      agentId: "agent-test",
      memoryId: id,
      topicId: "topic-science-visits",
    });
  }
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "科技馆还让你想起什么",
  });

  assert.deepEqual(result.graph.selectedMemoryIds, [
    "topic-primary",
    "topic-science-visits",
  ]);
  assert.equal(result.graph.paths[0].edges[0].relation, "supports_topic");
  assert.equal(result.graph.paths[0].edges[0].propagationPolicy, "conditional");
  assert.match(result.context, /长期主题/u);
  assert.doesNotMatch(result.context, /普通活动/u);
});

test("bounds activation work even when the reachable graph contains a cycle", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  for (const [id, content] of [
    ["cycle-a", "科技馆里的机器人展。"],
    ["cycle-b", "机器人相关的后续讨论。"],
    ["cycle-c", "另一次相关活动。"],
  ]) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content,
      recordedAt: "2026-07-01T08:00:00.000Z",
    });
  }
  for (const [fromMemoryId, toMemoryId] of [
    ["cycle-a", "cycle-b"],
    ["cycle-b", "cycle-c"],
    ["cycle-c", "cycle-a"],
  ]) {
    repository.upsertEdge({
      agentId: "agent-test",
      fromMemoryId,
      toMemoryId,
      relation: "associated_with",
      direction: "undirected",
      weight: 0.9,
    });
  }
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "科技馆还让你想起什么",
    options: { maximumActivationWork: 1 },
  });

  assert.equal(result.graph.activationField.processedStates, 1);
  assert.equal(result.graph.activationField.truncated, true);
  assert.equal(result.graph.selectedMemoryIds.length <= 3, true);
});

test("does not promote an entity-only neighbor into a converged seed", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  const direct = repository.upsertMemory({
    id: "direct-place-memory",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户去了上海科技馆。",
    recordedAt: "2026-07-01T08:00:00.000Z",
  });
  const entityOnly = repository.upsertMemory({
    id: "entity-only-neighbor",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户在那里参加了一次年度活动。",
    recordedAt: "2026-07-02T08:00:00.000Z",
  });
  const entity = repository.upsertEntity({
    agentId: "agent-test",
    kind: "place",
    canonicalName: "上海科技馆",
    aliases: ["科技馆"],
  });
  repository.linkMemoryEntity({ memoryId: direct.id, entityId: entity.id, role: "location" });
  repository.linkMemoryEntity({ memoryId: entityOnly.id, entityId: entity.id, role: "location" });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: direct.id,
    toMemoryId: entityOnly.id,
    relation: "shares_entity",
    direction: "undirected",
    weight: 0.9,
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "还记得上海科技馆吗",
  });

  assert.equal(result.status, "ready");
  assert.equal(result.fragments[0].memoryId, direct.id);
  assert.equal(result.graph.convergedSeeds, null);
  assert.deepEqual(result.graph.selectedMemoryIds, [direct.id]);
  assert.doesNotMatch(result.context, /年度活动/u);
});

test("uses date filtering without forcing unrelated lexical matches", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  seedMuseumMemory(repository);
  database.close();
  const dated = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "我上周六去干啥了",
    now: new Date("2026-07-15T12:00:00+08:00"),
  });
  assert.equal(dated.status, "ready");
  assert.equal(dated.retrievalMode, "date-filter");
  assert.deepEqual(dated.seedRouting.plannedRoutes, ["temporal"]);
  assert.equal(dated.candidates[0].routeMatches[0].route, "temporal");
  assert.match(dated.context, /科技馆/u);

  const unrelated = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "记得我养过企鹅吗",
    now: new Date("2026-07-15T12:00:00+08:00"),
  });
  assert.equal(unrelated.status, "no-match");
  assert.equal(unrelated.context, "");
  assert.equal(unrelated.trace.resultStatus, "no-match");
  assert.deepEqual(unrelated.trace.selectedIds, []);
});

test("recalls an old belief only with its current replacement", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  const key = "agent:belief:food:fish";
  const historical = applyMemoryCandidate(repository, {
    agentId: "agent-test",
    kind: "belief_state",
    content: "Agent 以前觉得鱼很难吃。",
    subjectRole: "agent",
    subjectKey: "agent-test",
    canonicalKey: key,
    representationLayer: "reported",
    stateFamily: "belief",
    statePhase: "active",
    reality: "real",
    evidenceMode: "manual",
    temporalState: "current",
    knownAt: "2026-07-01T08:00:00.000Z",
  }).memory;
  const current = applyMemoryCandidate(repository, {
    agentId: "agent-test",
    kind: "belief_state",
    content: "Agent 现在知道有些鱼很好吃。",
    subjectRole: "agent",
    subjectKey: "agent-test",
    canonicalKey: key,
    representationLayer: "reported",
    stateFamily: "belief",
    statePhase: "active",
    reality: "real",
    evidenceMode: "manual",
    temporalState: "current",
    revisionAction: "update",
    knownAt: "2026-07-10T08:00:00.000Z",
  }).memory;
  database.close();

  const oldRecall = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "你以前是不是觉得鱼很难吃",
  });
  assert.equal(oldRecall.status, "ready");
  assert.equal(oldRecall.fragments[0].memoryId, historical.id);
  assert.deepEqual(oldRecall.graph.stateCompletion, {
    historicalMemoryId: historical.id,
    currentMemoryId: current.id,
  });
  assert.deepEqual(oldRecall.graph.selectedMemoryIds, [current.id, historical.id]);
  assert.match(oldRecall.context, /当前状态：Agent 现在知道有些鱼很好吃/u);
  assert.match(oldRecall.context, /过去的状态（已被后续更新）：Agent 以前觉得鱼很难吃/u);

  const currentThroughOldWording = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "你觉得鱼很难吃吗",
  });
  assert.equal(currentThroughOldWording.fragments[0].memoryId, current.id);
  assert.equal(currentThroughOldWording.candidates[0].matchedMemoryId, historical.id);
  assert.equal(currentThroughOldWording.candidates[0].admission, "state-forwarded");
  assert.deepEqual(currentThroughOldWording.seedRouting.stateRouting.forwarded, [{
    fromMemoryId: historical.id,
    toMemoryId: current.id,
  }]);
  assert.equal(currentThroughOldWording.graph.stateCompletion, null);
  assert.match(currentThroughOldWording.context, /Agent 现在知道有些鱼很好吃/u);
  assert.doesNotMatch(currentThroughOldWording.context, /Agent 以前觉得鱼很难吃/u);

  const currentRecall = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "现在知道哪些鱼好吃",
  });
  assert.equal(currentRecall.fragments[0].memoryId, current.id);
  assert.equal(currentRecall.graph.stateCompletion, null);
  assert.doesNotMatch(currentRecall.context, /过去的状态/u);
});

test("does not answer a current-state query from an orphaned historical state", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "orphaned-historical-belief",
    agentId: "agent-test",
    kind: "belief_state",
    layer: "semantic",
    content: "Agent过去觉得月亮是奶酪做的。",
    subjectRole: "agent",
    subjectKey: "agent-test",
    canonicalKey: "agent:belief:moon-material",
    representationLayer: "reported",
    stateFamily: "belief",
    statePhase: "active",
    temporalState: "historical",
    status: "superseded",
    evidenceMode: "explicit",
    knownAt: "2026-07-01T08:00:00.000Z",
    validFrom: "2026-07-01T08:00:00.000Z",
    validTo: "2026-07-02T08:00:00.000Z",
  });
  database.close();

  const current = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "你觉得月亮是奶酪做的吗",
  });
  assert.equal(current.status, "no-match");
  assert.deepEqual(
    current.seedRouting.stateRouting.suppressedMemoryIds,
    ["orphaned-historical-belief"],
  );

  const historical = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "你以前觉得月亮是奶酪做的吗",
  });
  assert.equal(historical.status, "ready");
  assert.equal(historical.fragments[0].memoryId, "orphaned-historical-belief");
});

test("labels inferred long-term state as a revocable inference instead of reported speech", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "inferred-puzzle-selection",
    agentId: "agent-test",
    kind: "derived_hypothesis",
    layer: "semantic",
    content: "用户在空闲时间表现出对解谜游戏的选择倾向。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    reality: "real",
    evidenceMode: "inferred",
    representationLayer: "inferred",
    stateFamily: "preference",
    statePhase: "active",
    temporalState: "current",
    validFrom: "2026-07-10T08:00:00.000Z",
    knownAt: "2026-07-10T08:00:00.000Z",
    metadata: { preferenceStateLevel: "selection_tendency" },
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "解谜游戏",
  });
  assert.equal(result.status, "ready");
  assert.match(result.context, /状态性质：基于行为与多条证据的可撤销推断；不是主体原话/u);
  assert.match(result.context, /选择倾向/u);
});

test("returns parallel current representation layers instead of choosing one by score", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "reported-puzzle-preference",
    agentId: "agent-test",
    kind: "preference",
    layer: "semantic",
    content: "用户明确说自己喜欢机关解谜游戏。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:mechanical-puzzles",
    representationLayer: "reported",
    stateFamily: "preference",
    statePhase: "active",
    stateScopeKey: "root",
    temporalState: "current",
    recordedAt: "2026-07-20T08:00:00.000Z",
  });
  repository.upsertMemory({
    id: "inferred-puzzle-preference",
    agentId: "agent-test",
    kind: "derived_hypothesis",
    layer: "semantic",
    content: "根据多次主动选择，系统推断用户对机关解谜游戏有稳定偏好。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:mechanical-puzzles",
    representationLayer: "inferred",
    stateFamily: "preference",
    statePhase: "active",
    stateScopeKey: "root",
    temporalState: "current",
    recordedAt: "2026-07-21T08:00:00.000Z",
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "我喜欢机关解谜游戏吗",
  });
  assert.equal(result.status, "ready");
  assert.deepEqual(result.graph.selectedMemoryIds, [
    "reported-puzzle-preference",
    "inferred-puzzle-preference",
  ]);
  assert.match(result.context, /主体明确表达；不等于外部验证事实/u);
  assert.match(result.context, /可撤销推断；不是主体原话/u);
  assert.match(result.context, /明确说自己喜欢机关解谜/u);
  assert.match(result.context, /多次主动选择/u);
  assert.deepEqual(result.graph.representationCompletion, {
    mode: "parallel-current-representations",
    memoryIds: ["reported-puzzle-preference", "inferred-puzzle-preference"],
  });
  assert.deepEqual(
    result.trace.metadata.representationCompletion,
    result.graph.representationCompletion,
  );
  const reliabilityAnchors = resolveContinuationAnchors(
    "这个判断可靠吗",
    { id: "trace-representations", ...result.trace },
  );
  assert.deepEqual(reliabilityAnchors, {
    memoryIds: ["reported-puzzle-preference", "inferred-puzzle-preference"],
    focusRole: "representation-set",
    reason: "evaluated-representation-follow-up",
    sourceTraceId: "trace-representations",
  });
  const reliability = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "这个判断可靠吗",
    anchorMemoryIds: reliabilityAnchors.memoryIds,
    anchorSelection: reliabilityAnchors,
  });
  assert.equal(reliability.fragments[0].memoryId, "inferred-puzzle-preference");
  assert.deepEqual(reliability.trace.metadata.continuationSelection, {
    focusRole: "representation-set",
    reason: "evaluated-representation-follow-up",
    sourceTraceId: "trace-representations",
  });
  assert.deepEqual(reliability.trace.metadata.continuationFocuses.representationMemoryIds, [
    "reported-puzzle-preference",
    "inferred-puzzle-preference",
  ]);
});

test("routes requests for the agent's judgment to evaluated-state evidence", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "reported-puzzle-preference",
    agentId: "agent-test",
    kind: "preference",
    layer: "semantic",
    content: "用户明确说自己喜欢机关解谜游戏。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:mechanical-puzzles",
    representationLayer: "reported",
    stateFamily: "preference",
    statePhase: "active",
    stateScopeKey: "root",
    temporalState: "current",
    importance: 1,
    recordedAt: "2026-07-22T08:00:00.000Z",
  });
  repository.upsertMemory({
    id: "inferred-puzzle-preference",
    agentId: "agent-test",
    kind: "derived_hypothesis",
    layer: "semantic",
    content: "系统根据多次主动选择推断用户对机关解谜游戏有稳定偏好。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:mechanical-puzzles",
    representationLayer: "inferred",
    stateFamily: "preference",
    statePhase: "active",
    stateScopeKey: "root",
    temporalState: "current",
    importance: 0.82,
    recordedAt: "2026-07-21T08:00:00.000Z",
  });
  repository.upsertMemory({
    id: "reported-puzzle-evidence",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户在一次对话中明确说过自己喜欢机关解谜游戏。",
    subjectRole: "user",
    subjectKey: "user",
    eventDate: "2026-07-20",
    eventStart: "2026-07-20T08:00:00.000Z",
  });
  repository.upsertMemory({
    id: "inferred-puzzle-evidence",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户在多次空闲选择中主动选择机关解谜游戏。",
    subjectRole: "user",
    subjectKey: "user",
    eventDate: "2026-07-21",
    eventStart: "2026-07-21T08:00:00.000Z",
  });
  for (const [fromMemoryId, toMemoryId] of [
    ["reported-puzzle-preference", "reported-puzzle-evidence"],
    ["inferred-puzzle-preference", "inferred-puzzle-evidence"],
  ]) {
    repository.upsertEdge({
      agentId: "agent-test",
      fromMemoryId,
      toMemoryId,
      relation: "supported_by",
      direction: "directed",
      weight: 1,
      confidence: 0.95,
      provenance: "test",
    });
  }
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "你为什么觉得我喜欢机关解谜游戏",
  });
  assert.equal(result.status, "ready");
  assert.equal(result.recallIntent, "evidence");
  assert.equal(
    result.fragments[0].memoryId,
    "inferred-puzzle-preference",
    JSON.stringify(result.seedRouting, null, 2),
  );
  assert.deepEqual(result.fragments[0].evidenceIds, ["inferred-puzzle-evidence"]);
  assert.match(result.context, /多次空闲选择/u);
  assert.doesNotMatch(result.context, /一次对话中明确说过/u);
  assert.deepEqual(result.seedRouting.representationRouting, {
    intent: "evaluated",
    applied: true,
    preferredMemoryId: "inferred-puzzle-preference",
  });

  const reliability = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "你确定我喜欢机关解谜游戏吗",
  });
  assert.equal(reliability.status, "ready");
  assert.equal(reliability.recallIntent, "evidence-review");
  assert.equal(reliability.fragments[0].memoryId, "inferred-puzzle-preference");
  assert.deepEqual(reliability.graph.supportEvidenceMemoryIds, ["inferred-puzzle-evidence"]);
  assert.deepEqual(reliability.graph.counterevidenceMemoryIds, []);
  assert.match(reliability.context, /多次空闲选择/u);
  assert.doesNotMatch(reliability.context, /一次对话中明确说过/u);
  assert.deepEqual(reliability.seedRouting.representationRouting, {
    intent: "evaluated",
    applied: true,
    preferredMemoryId: "inferred-puzzle-preference",
  });
});

test("completes a historical inferred preference with only its linked established state", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  const inferred = repository.upsertMemory({
    id: "historical-inferred-puzzle-preference",
    agentId: "agent-test",
    kind: "derived_hypothesis",
    layer: "semantic",
    content: "过去根据行为推断，用户对机关解谜游戏有稳定偏好。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:mechanical-puzzles",
    reality: "real",
    evidenceMode: "inferred",
    representationLayer: "inferred",
    stateFamily: "preference",
    statePhase: "active",
    temporalState: "current",
    validFrom: "2026-07-10T08:00:00.000Z",
    knownAt: "2026-07-10T08:00:00.000Z",
    metadata: { preferenceStateLevel: "stable_preference" },
  });
  repository.closeCurrentMemoryState({
    agentId: "agent-test",
    memoryId: inferred.id,
    validTo: "2026-08-01T08:00:00.000Z",
  });
  const established = repository.upsertMemory({
    id: "established-puzzle-preference",
    agentId: "agent-test",
    kind: "derived_hypothesis",
    layer: "semantic",
    content: "经专门聚合验证，用户对机关解谜游戏有稳定偏好。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:mechanical-puzzles",
    reality: "real",
    evidenceMode: "inferred",
    representationLayer: "established",
    stateFamily: "preference",
    statePhase: "active",
    temporalState: "current",
    validFrom: "2026-08-01T08:00:00.000Z",
    knownAt: "2026-08-01T08:00:00.000Z",
    metadata: { preferenceStateLevel: "stable_preference" },
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: established.id,
    toMemoryId: inferred.id,
    relation: "established_from",
    direction: "directed",
    weight: 1,
    confidence: 0.9,
    provenance: "test",
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "以前推断的机关解谜游戏偏好",
    anchorMemoryIds: [inferred.id],
  });
  assert.equal(result.status, "ready");
  assert.deepEqual(result.graph.stateCompletion, {
    historicalMemoryId: inferred.id,
    currentMemoryId: established.id,
  });
  assert.match(result.context, /状态性质：经过专门聚合验证；仍保留来源并允许后续修正/u);
  assert.match(result.context, /当前状态：经专门聚合验证/u);
  assert.match(result.context, /过去的状态（已被后续更新）：过去根据行为推断/u);
});

test("skips generic time questions before opening the database", async () => {
  const result = await retrieveMemories({
    databasePath: path.join(os.tmpdir(), "does-not-exist.db"),
    agentId: "agent-test",
    query: "现在几点",
  });
  assert.equal(result.status, "skipped");
  assert.equal(result.context, "");
  assert.equal(result.trace.resultStatus, "skipped");
  assert.equal(result.trace.metadata.skippedReason, "generic-query");
});

test("skips the natural current-time wording before opening the database", async () => {
  const result = await retrieveMemories({
    databasePath: "this-file-must-not-be-opened.db",
    agentId: "agent-test",
    query: "现在几点了",
  });
  assert.equal(result.status, "skipped");
  assert.equal(result.skippedReason, "generic-query");
  assert.equal(result.trace.metadata.affectiveBias.enabled, false);
});

test("can use a matching cached vector when lexical terms are weak", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "quiet-place",
    agentId: "agent-test",
    kind: "fact",
    layer: "semantic",
    content: "楼顶是用户独处时最常去的秘密基地。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "place.private-rooftop",
    importance: 0.7,
  });
  repository.upsertEmbedding({
    memoryId: "quiet-place",
    model: "embedding-test",
    vector: [1, 0],
  });
  database.close();
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "我通常去哪里躲清静",
    embeddingProvider: async () => ({
      vector: new Float32Array([1, 0]),
      model: "embedding-test",
      usage: {},
      metadata: {},
    }),
  });
  assert.equal(result.status, "ready");
  assert.equal(result.retrievalMode, "hybrid");
  assert.equal(result.fragments[0].memoryId, "quiet-place");
  assert.equal(result.seedRouting.routeStatus.vector, "matched");
  assert.equal(
    result.candidates[0].routeMatches.some((route) => (
      route.route === "vector" && route.independentlyAdmissible
    )),
    true,
  );
});

test("requires two weak routes to corroborate instead of adding arbitrary weak scores", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "weak-corroborated",
    agentId: "agent-test",
    kind: "fact",
    layer: "semantic",
    content: "用户把旧票根放在蓝色盒子里。",
    subjectRole: "user",
    subjectKey: "user",
  });
  repository.upsertEmbedding({
    memoryId: "weak-corroborated",
    model: "embedding-test",
    vector: [0.45, Math.sqrt(1 - 0.45 ** 2)],
  });
  database.close();
  const options = {
    minimumLexicalScore: 1,
    strongLexicalScore: 100,
    minimumVectorSimilarity: 0.4,
    strongVectorSimilarity: 0.9,
  };
  const lexicalOnly = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "旧票根在哪里",
    options,
  });
  assert.equal(lexicalOnly.status, "no-match");
  assert.equal(lexicalOnly.seedRouting.routeStatus.lexical, "supporting-only");

  const corroborated = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "旧票根在哪里",
    options,
    embeddingProvider: async () => ({
      vector: new Float32Array([1, 0]),
      model: "embedding-test",
      usage: {},
      metadata: {},
    }),
  });
  assert.equal(corroborated.status, "ready");
  assert.equal(corroborated.candidates[0].memoryId, "weak-corroborated");
  assert.equal(corroborated.candidates[0].admission, "corroborated");
  assert.equal(corroborated.seedRouting.routeStatus.lexical, "matched");
  assert.equal(corroborated.seedRouting.routeStatus.vector, "matched");
  assert.deepEqual(
    corroborated.candidates[0].routeMatches.map((route) => route.route),
    ["lexical", "vector"],
  );
  assert.equal(
    corroborated.candidates[0].routeMatches.every((route) => !route.independentlyAdmissible),
    true,
  );
});

test("bounds convergence-only route audit without hiding its total", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  for (let index = 0; index < 15; index += 1) {
    repository.upsertMemory({
      id: `weak-audit-${index}`,
      agentId: "agent-test",
      kind: "fact",
      layer: "semantic",
      content: `蓝色盒子里的普通票根编号${index}。`,
    });
  }
  database.close();
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "蓝色盒子在哪里",
    options: { strongLexicalScore: 100 },
  });
  assert.equal(result.status, "no-match");
  assert.equal(result.seedRouting.directCandidateCount, 0);
  assert.equal(result.seedRouting.convergenceCandidateCount, 15);
  assert.equal(result.seedRouting.candidates.length, 10);
  assert.equal(result.seedRouting.omittedConvergenceCandidateCount, 5);
});

test("falls back to lexical retrieval when the embedding service is unavailable", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  seedMuseumMemory(repository);
  database.close();
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "记得我之前去科技馆吗",
    embeddingProvider: async () => {
      throw new Error("service offline");
    },
  });
  assert.equal(result.status, "ready");
  assert.equal(result.retrievalMode, "lexical");
  assert.equal(result.vector.status, "error");
  assert.match(result.vector.warning, /已退回文本检索/u);
  assert.equal(result.fragments[0].memoryId, "event-museum");
  assert.equal(result.seedRouting.routeStatus.vector, "error");
  assert.equal(result.seedRouting.routeStatus.lexical, "matched");
});

test("keeps causes edges inert during ordinary recall", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  seedMuseumMemory(repository);
  repository.upsertMemory({
    id: "unrelated-effect",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户后来取消了另一项出门计划。",
    subjectRole: "user",
    subjectKey: "user",
    recordedAt: "2026-07-12T03:00:00.000Z",
  });
  database.close();
  const input = {
    databasePath,
    agentId: "agent-test",
    query: "记得我之前去科技馆吗",
    now: new Date("2026-07-15T12:00:00+08:00"),
  };
  const before = await retrieveMemories(input);
  const writable = openMemoryDatabase(databasePath);
  const writableRepository = new MemoryRepository(writable);
  writableRepository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "event-museum",
    toMemoryId: "unrelated-effect",
    relation: "causes",
    direction: "directed",
    weight: 1,
    confidence: 1,
    provenance: "accepted-relation-proposal-v1",
  });
  writable.close();
  const after = await retrieveMemories(input);
  assert.equal(after.context, before.context);
  assert.deepEqual(after.trace.seedIds, before.trace.seedIds);
  assert.deepEqual(after.trace.selectedIds, before.trace.selectedIds);
  assert.deepEqual(after.graph.selectedMemoryIds, before.graph.selectedMemoryIds);
});

test("walks only reviewed causal edges when the query explicitly asks why", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  const source = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: "rain-caused-cancel",
    occurredAt: "2026-07-11T08:00:00.000Z",
    content: "因为突然下大雨，所以我取消了晚上的出门计划。",
  });
  for (const [id, content, eventStart] of [
    ["causal-rain", "当天突然下起大雨。", "2026-07-11T08:00:00.000Z"],
    ["causal-cancel", "用户取消了晚上的出门计划。", "2026-07-11T08:05:00.000Z"],
    ["causal-dinner", "用户后来在家吃了晚饭。", "2026-07-11T10:00:00.000Z"],
  ]) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content,
      eventStart,
      subjectRole: id === "causal-rain" ? "world" : "user",
      subjectKey: id === "causal-rain" ? "" : "user",
    });
  }
  repository.linkSource("causal-rain", source.id, "evidence");
  repository.linkSource("causal-cancel", source.id, "evidence");
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "causal-cancel",
    toMemoryId: "causal-dinner",
    relation: "timeline_next",
    direction: "directed",
    weight: 1,
  });
  const proposal = proposeMemoryRelation(repository, {
    agentId: "agent-test",
    relation: "causes",
    fromMemoryId: "causal-rain",
    toMemoryId: "causal-cancel",
    evidenceSourceIds: [source.id],
    confidence: 0.95,
    rationale: "原话明确说大雨导致取消计划。",
  });
  const accepted = resolveMemoryRelationProposal(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    action: "accept",
    resolvedBy: "human:test",
  });
  database.close();

  const causal = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "为什么取消晚上的出门计划",
  });
  assert.equal(causal.chainIntent.mode, "causal");
  assert.equal(causal.chainIntent.direction, "backward");
  assert.deepEqual(causal.graph.selectedMemoryIds, ["causal-cancel", "causal-rain"]);
  assert.match(causal.context, /结果：用户取消了晚上的出门计划/u);
  assert.match(causal.context, /有明确关系的原因：当天突然下起大雨/u);
  assert.doesNotMatch(causal.context, /吃了晚饭/u);
  assert.equal(causal.trace.paths.length, 1);
  assert.equal(causal.trace.paths[0].edges[0].edgeId, accepted.edge.id);
  assert.equal(causal.trace.paths[0].edges[0].relationView, "causal");
  assert.ok(causal.graph.edgeIds.includes(accepted.edge.id));

  const forward = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "大雨后来造成了什么",
  });
  assert.equal(forward.chainIntent.mode, "causal");
  assert.equal(forward.chainIntent.direction, "forward");
  assert.deepEqual(forward.graph.selectedMemoryIds, ["causal-rain", "causal-cancel"]);
  assert.match(forward.context, /原因：当天突然下起大雨/u);
  assert.match(forward.context, /有明确关系的后续结果：用户取消了晚上的出门计划/u);
  assert.doesNotMatch(forward.context, /吃了晚饭/u);
  assert.equal(forward.trace.paths[0].edges[0].edgeId, accepted.edge.id);
  assert.equal(forward.trace.paths[0].edges[0].relationView, "causal");

  const ordinary = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "还记得取消晚上的出门计划吗",
  });
  assert.equal(ordinary.chainIntent.mode, "none");
  assert.deepEqual(ordinary.graph.selectedMemoryIds, ["causal-cancel"]);
  assert.doesNotMatch(ordinary.context, /突然下起大雨/u);
});

test("does not treat a direct unreviewed causes edge as accepted causal memory", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  for (const [id, content] of [
    ["unreviewed-cause", "系统出现了一次异常。"],
    ["unreviewed-effect", "任务随后停止了。"],
  ]) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content,
    });
  }
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "unreviewed-cause",
    toMemoryId: "unreviewed-effect",
    relation: "causes",
    direction: "directed",
    weight: 1,
    provenance: "manual-but-not-reviewed",
  });
  database.close();
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "为什么任务随后停止了",
  });
  assert.equal(result.chainIntent.mode, "causal");
  assert.deepEqual(result.graph.selectedMemoryIds, ["unreviewed-effect"]);
  assert.doesNotMatch(result.context, /系统出现了一次异常/u);
});

test("suppresses weak causes behind a reviewed high-fanout effect", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  const source = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "manual-evaluation",
    externalId: "causal-fanout-evidence",
    content: "测试证据明确列出一个主要原因和多个很弱的次要原因。",
  });
  repository.upsertMemory({
    id: "fanout-effect",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "目标任务最终停止。",
  });
  repository.linkSource("fanout-effect", source.id, "evidence");
  const causes = [
    ["fanout-strong-cause", "主要故障直接导致任务停止。", 1],
    ...Array.from({ length: 8 }, (_, index) => [
      `fanout-weak-cause-${index}`,
      `弱相关原因 ${index}。`,
      0.05,
    ]),
  ];
  for (const [id, content, weight] of causes) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content,
    });
    repository.linkSource(id, source.id, "evidence");
    const proposal = proposeMemoryRelation(repository, {
      agentId: "agent-test",
      relation: "causes",
      fromMemoryId: id,
      toMemoryId: "fanout-effect",
      evidenceSourceIds: [source.id],
      weight,
      confidence: 1,
      rationale: "用于验证审核后因果边的扇出预算。",
    });
    resolveMemoryRelationProposal(repository, {
      agentId: "agent-test",
      proposalId: proposal.id,
      action: "accept",
      resolvedBy: "human:test",
    });
  }
  database.close();
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "为什么目标任务最终停止",
  });
  assert.deepEqual(result.graph.selectedMemoryIds, [
    "fanout-effect",
    "fanout-strong-cause",
  ]);
  assert.doesNotMatch(result.context, /弱相关原因/u);
});

test("recalls an active scoped exception only through its explicit broad-state link", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  const canonicalKey = "user:preference:fish";
  const common = {
    agentId: "agent-test",
    kind: "preference",
    layer: "semantic",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey,
    representationLayer: "reported",
    stateFamily: "preference",
    statePhase: "active",
    temporalState: "current",
    evidenceMode: "explicit",
    knownAt: "2026-08-02T08:00:00.000Z",
    validFrom: "2026-08-02T08:00:00.000Z",
  };
  const broad = repository.upsertMemory({
    ...common,
    id: "fish-preference-root",
    content: "用户明确报告自己喜欢鱼类食物。",
  });
  const rawFishScope = stateScopeKeyFromScope({
    kind: "subcategory",
    label: "生鱼",
  });
  const exception = repository.upsertMemory({
    ...common,
    id: "raw-fish-exception",
    content: "用户明确报告自己不喜欢生鱼。",
    stateScopeKey: rawFishScope,
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: exception.id,
    toMemoryId: broad.id,
    relation: "scoped_exception_to",
    direction: "directed",
    weight: 1,
    confidence: 1,
    provenance: "accepted-reported-state-proposal-v1",
  });
  repository.upsertMemory({
    ...common,
    id: "unlinked-fish-soup-scope",
    content: "用户对鱼汤的看法仍未确认。",
    stateScopeKey: stateScopeKeyFromScope({ kind: "dish", label: "鱼汤" }),
  });
  database.close();

  const broadRecall = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "喜欢鱼类食物",
  });
  assert.deepEqual(broadRecall.graph.selectedMemoryIds, [broad.id, exception.id]);
  assert.match(broadRecall.context, /宽泛状态：用户明确报告自己喜欢鱼类食物/u);
  assert.match(broadRecall.context, /局部例外：用户明确报告自己不喜欢生鱼/u);
  assert.doesNotMatch(broadRecall.context, /鱼汤/u);
  assert.equal(broadRecall.graph.scopeCompletion.mode, "root-with-exceptions");

  const exceptionRecall = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "不喜欢生鱼",
  });
  assert.deepEqual(exceptionRecall.graph.selectedMemoryIds, [exception.id, broad.id]);
  assert.match(exceptionRecall.context, /局部例外：用户明确报告自己不喜欢生鱼/u);
  assert.match(exceptionRecall.context, /它所限定的宽泛状态：用户明确报告自己喜欢鱼类食物/u);
  assert.equal(exceptionRecall.graph.scopeCompletion.mode, "exception-with-root");
});
