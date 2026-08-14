import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readUsageEvents } from "@suzu-lives/cost-ledger";
import {
  MemoryRepository,
  openMemoryDatabase,
} from "@suzu-lives/memory-core";

import {
  buildRelationSnapshot,
  buildStructureSnapshot,
  planMemoryConsolidation,
  processPlannedConsolidationRuns,
  proposeSubjectAttributionForMemory,
  proposeSubjectAttributionsBatch,
  proposeRelationsForBatch,
  proposeStructuresForBatch,
  runMemoryConsolidation,
} from "../src/index.mjs";

function fixture() {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  for (const [id, content, eventStart] of [
    ["batch-museum", "用户去了科技馆并参观航天展。", "2026-07-11T03:00:00.000Z"],
    ["batch-dinner", "两人从科技馆离开后一起吃晚饭。", "2026-07-11T10:00:00.000Z"],
  ]) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content,
      eventStart,
      metadata: { forbiddenRawPath: "C:/private/transcript.jsonl" },
    });
  }
  repository.upsertMemory({
    id: "raw-utterance",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "绝不能发送给结构生成器的逐字原话。",
  });
  repository.upsertMemory({
    id: "outside-current-batch",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "存在于数据库但不属于当前批次。",
    eventStart: "2026-07-10T03:00:00.000Z",
  });
  const topic = repository.upsertTopic({
    id: "topic-space",
    agentId: "agent-test",
    title: "航天兴趣",
    content: "围绕航天展览和航天内容形成的兴趣主题。",
  });
  repository.linkMemoryToTopic({
    agentId: "agent-test",
    memoryId: "batch-museum",
    topicId: topic.id,
  });
  return { database, repository, topic };
}

function subjectAttributionFixture() {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const source = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: "subject-source-1",
    occurredAt: "2026-07-04T02:00:00.000Z",
    speaker: "User",
    content: "我今天去了科技馆，还看了机器人展。",
    metadata: { privatePath: "C:/private/conversation.jsonl" },
  });
  const memory = repository.upsertMemory({
    id: "legacy-unknown-subject",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "2026年7月4日去科技馆看了机器人展。",
    subjectRole: "unknown",
    evidenceMode: "imported",
  });
  repository.linkSource(memory.id, source.id, "evidence", {
    authority: "legacy_unknown",
    provenance: "test",
  });
  return {
    database,
    repository,
    source,
    memory,
    allowedActors: [
      { role: "user", key: "user", name: "用户" },
      { role: "agent", key: "agent-test", name: "Agent" },
    ],
  };
}

test("creates only a pending bounded subject attribution proposal", async () => {
  const { database, repository, source, memory, allowedActors } = subjectAttributionFixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-subject-attribution-"));
  const ledgerPath = path.join(directory, "cost-ledger", "events.jsonl");
  let received = null;
  const result = await proposeSubjectAttributionForMemory({
    repository,
    agentId: "agent-test",
    memoryId: memory.id,
    allowedActors,
    usageLedgerPath: ledgerPath,
    generator: async (request) => {
      received = request;
      return {
        output: {
          decision: "propose",
          subjectRole: "user",
          subjectKey: "user",
          sourceIds: [source.id],
          actorRoles: [{
            role: "experiencer",
            actorRole: "user",
            actorKey: "user",
            isPrimary: true,
            confidence: 0.98,
            sourceIds: [source.id],
          }],
          confidence: 0.96,
          rationale: "第一人称原话直接说明用户是经历者。",
        },
        model: "fake-model",
        requestId: "request-1",
        usage: { inputTokens: 120, outputTokens: 40 },
        metadata: { provider: "fake-provider" },
      };
    },
  });
  assert.equal(result.status, "proposed");
  assert.equal(result.proposal.review_state, "pending");
  assert.equal(repository.getMemory(memory.id).subject_role, "unknown");
  assert.equal(received.schemaName, "memory-subject-attribution-v1");
  assert.match(received.systemPrompt, /speaker.*不自动等于/u);
  assert.doesNotMatch(received.input, /private\/conversation/u);
  const ledger = await readUsageEvents(ledgerPath);
  assert.equal(ledger.events.length, 1);
  assert.equal(ledger.events[0].feature, "memory-subject-attribution");
  database.close();
});

test("lets the subject attribution specialist abstain without writing a proposal", async () => {
  const { database, repository, memory, allowedActors } = subjectAttributionFixture();
  const result = await proposeSubjectAttributionForMemory({
    repository,
    agentId: "agent-test",
    memoryId: memory.id,
    allowedActors,
    generator: async () => ({
      output: {
        decision: "abstain",
        subjectRole: "",
        subjectKey: "",
        sourceIds: [],
        actorRoles: [],
        confidence: 0.2,
        rationale: "来源中的指代不足以确认事件主人。",
      },
    }),
  });
  assert.equal(result.status, "abstained");
  assert.equal(repository.listSubjectAttributionProposals("agent-test").length, 0);
  assert.equal(repository.getMemory(memory.id).subject_role, "unknown");
  database.close();
});

test("bounds subject attribution batches and isolates a failed memory", async () => {
  const { database, repository, memory, allowedActors } = subjectAttributionFixture();
  const secondSource = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: "subject-source-2",
    speaker: "User",
    content: "我以前反复读过这套科幻小说。",
  });
  const secondMemory = repository.upsertMemory({
    id: "legacy-unknown-reading",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "过去反复阅读过一套科幻小说。",
    subjectRole: "unknown",
    evidenceMode: "imported",
  });
  repository.linkSource(secondMemory.id, secondSource.id, "evidence", {
    authority: "legacy_unknown",
    provenance: "test",
  });
  const generator = async ({ input }) => {
    const snapshot = JSON.parse(input);
    const sourceId = snapshot.sources[0].id;
    return {
      output: {
        decision: "propose",
        subjectRole: "user",
        subjectKey: "user",
        sourceIds: [sourceId],
        actorRoles: [{
          role: "experiencer",
          actorRole: "user",
          actorKey: "user",
          isPrimary: true,
          confidence: 0.9,
          sourceIds: [sourceId],
        }],
        confidence: 0.9,
        rationale: "第一人称直接证据。",
      },
    };
  };
  const result = await proposeSubjectAttributionsBatch({
    repository,
    agentId: "agent-test",
    memoryIds: [memory.id, "missing-memory", secondMemory.id, "truncated-memory"],
    maximumMemories: 3,
    allowedActors,
    generator,
  });
  assert.equal(result.status, "completed-with-failures");
  assert.equal(result.selected, 3);
  assert.equal(result.truncated, 1);
  assert.deepEqual(result.counts, { proposed: 2, failed: 1 });
  assert.equal(repository.listSubjectAttributionProposals("agent-test").length, 2);
  await assert.rejects(() => proposeSubjectAttributionsBatch({
    repository,
    agentId: "agent-test",
    memoryIds: [memory.id],
    maximumMemories: 0,
    allowedActors,
    generator,
  }), /maximumMemories/u);
  database.close();
});

test("builds a bounded proposal snapshot without raw evidence or metadata", () => {
  const { database, repository, topic } = fixture();
  const snapshot = buildStructureSnapshot({
    repository,
    agentId: "agent-test",
    batchId: "batch-1",
    memoryIds: ["batch-museum", "batch-dinner", "raw-utterance"],
    nearbyContainerIds: [topic.id],
  });
  assert.deepEqual(snapshot.currentMemories.map((memory) => memory.id), [
    "batch-museum",
    "batch-dinner",
  ]);
  assert.equal(snapshot.candidateContainers.length, 1);
  assert.equal(snapshot.candidateContainers[0].id, topic.id);
  assert.equal(snapshot.inputPolicy.includesRawUtterances, false);
  assert.match(JSON.stringify(snapshot), /航天兴趣/u);
  assert.doesNotMatch(JSON.stringify(snapshot), /绝不能发送/u);
  assert.doesNotMatch(JSON.stringify(snapshot), /private\/transcript/u);
  assert.throws(() => buildStructureSnapshot({
    repository,
    agentId: "agent-test",
    memoryIds: ["missing-memory"],
  }), /must exist for the same Agent/u);
  database.close();
});

test("records only pending create and attach proposals with metered fake generation", async () => {
  const { database, repository, topic } = fixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-structurer-"));
  const ledgerPath = path.join(directory, "cost-ledger", "events.jsonl");
  let received = null;
  const generator = async (request) => {
    received = request;
    return {
      output: {
        proposals: [
          {
            operation: "attach",
            targetMemoryId: topic.id,
            kind: "topic",
            title: "",
            content: "",
            subjectRole: "unknown",
            subjectKey: "",
            eventDate: null,
            eventStart: null,
            eventEnd: null,
            memberIds: ["batch-museum", "batch-dinner"],
            actorRoles: [],
            confidence: 0.81,
            rationale: "晚饭事件仍属于同一次航天兴趣讨论。",
          },
          {
            operation: "create",
            targetMemoryId: "",
            kind: "episode",
            title: "科技馆之行",
            content: "参观科技馆并在离开后一起吃饭的连续经历。",
            subjectRole: "shared",
            subjectKey: "agent-test:user",
            eventDate: "2026-07-11",
            eventStart: "2026-07-11T03:00:00.000Z",
            eventEnd: "2026-07-11T10:00:00.000Z",
            memberIds: ["batch-museum", "batch-dinner"],
            actorRoles: [],
            confidence: 0.9,
            rationale: "时间连续并且属于同一次出行。",
          },
          {
            operation: "attach",
            targetMemoryId: topic.id,
            kind: "topic",
            title: "",
            content: "",
            subjectRole: "unknown",
            subjectKey: "",
            eventDate: null,
            eventStart: null,
            eventEnd: null,
            memberIds: ["invented-memory-id"],
            actorRoles: [],
            confidence: 0.2,
            rationale: "非法 ID 应被拒绝。",
          },
          {
            operation: "create",
            targetMemoryId: "",
            kind: "episode",
            title: "越界候选",
            content: "不能读取当前批次以外的节点来拼结构。",
            subjectRole: "shared",
            subjectKey: "agent-test:user",
            eventDate: "2026-07-10",
            eventStart: "2026-07-10T03:00:00.000Z",
            eventEnd: "2026-07-11T03:00:00.000Z",
            memberIds: ["outside-current-batch", "batch-museum"],
            actorRoles: [],
            confidence: 0.7,
            rationale: "已知但越界的成员仍应被拒绝。",
          },
        ],
      },
      model: "fake-structure-model",
      usage: { input_tokens: 120, output_tokens: 80 },
      requestId: "fake-request-1",
      durationMs: 25,
      metadata: { provider: "test-provider" },
    };
  };
  const result = await proposeStructuresForBatch({
    repository,
    agentId: "agent-test",
    batchId: "batch-1",
    memoryIds: ["batch-museum", "batch-dinner", "raw-utterance"],
    nearbyContainerIds: [topic.id],
    generator,
    usageLedgerPath: ledgerPath,
  });
  assert.equal(result.status, "proposed");
  assert.equal(result.proposed.length, 2);
  assert.equal(result.duplicates.length, 0);
  assert.equal(result.rejected.length, 2);
  assert.match(result.rejected[0].error, /currentMemories/u);
  assert.match(result.rejected[1].error, /currentMemories/u);
  assert.equal(result.usageRecorded, true);
  assert.equal(repository.listStructureProposals("agent-test", {
    reviewStates: ["pending"],
  }).length, 2);
  assert.equal(repository.listMemories("agent-test", { kinds: ["episode"] }).total, 0);
  assert.equal(repository.listTopicMembers({
    agentId: "agent-test",
    topicId: topic.id,
  }).length, 1);
  assert.equal(received.schemaName, "memory-structure-proposals-v1");
  assert.equal(received.schema.type, "object");
  assert.doesNotMatch(received.input, /绝不能发送/u);

  const duplicateResult = await proposeStructuresForBatch({
    repository,
    agentId: "agent-test",
    batchId: "batch-2",
    memoryIds: ["batch-museum", "batch-dinner"],
    nearbyContainerIds: [topic.id],
    generator,
  });
  assert.equal(duplicateResult.proposed.length, 0);
  assert.equal(duplicateResult.duplicates.length, 2);
  assert.equal(duplicateResult.rejected.length, 2);
  const ledger = await readUsageEvents(ledgerPath);
  assert.equal(ledger.events.length, 1);
  assert.equal(ledger.events[0].feature, "memory-structure-proposal");
  database.close();
});

test("does not write proposals when generation fails", async () => {
  const { database, repository, topic } = fixture();
  await assert.rejects(() => proposeStructuresForBatch({
    repository,
    agentId: "agent-test",
    memoryIds: ["batch-museum", "batch-dinner"],
    nearbyContainerIds: [topic.id],
    generator: async () => {
      throw new Error("simulated provider failure");
    },
  }), /simulated provider failure/u);
  assert.equal(repository.listStructureProposals("agent-test").length, 0);
  database.close();
});

function relationFixture() {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const directSource = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: "rain-cancel-source",
    occurredAt: "2026-07-11T08:00:00.000Z",
    speaker: "User",
    content: "因为突然下大雨，所以我把晚上的出门计划取消了。",
    metadata: { forbiddenPath: "C:/private/transcript.jsonl" },
  });
  const unrelatedSource = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: "unrelated-source",
    speaker: "User",
    content: "今天吃了面。",
  });
  for (const [id, content, source] of [
    ["relation-rain", "当天突然下起大雨。", directSource],
    ["relation-cancel", "用户取消了晚上的出门计划。", directSource],
    ["relation-dinner", "用户当天吃了面。", unrelatedSource],
  ]) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content,
      subjectRole: id === "relation-rain" ? "world" : "user",
      subjectKey: id === "relation-rain" ? "" : "user",
      metadata: { forbiddenPath: "D:/private/memory.jsonl" },
    });
    repository.linkSource(id, source.id, "evidence");
  }
  return { database, repository, directSource, unrelatedSource };
}

test("builds a bounded causal snapshot with source evidence but no paths or metadata", () => {
  const { database, repository, directSource } = relationFixture();
  const snapshot = buildRelationSnapshot({
    repository,
    agentId: "agent-test",
    batchId: "relation-batch",
    memoryIds: ["relation-rain", "relation-cancel"],
  });
  assert.deepEqual(snapshot.memories.map((memory) => memory.id), [
    "relation-rain",
    "relation-cancel",
  ]);
  assert.deepEqual(snapshot.sourceRecords.map((source) => source.id), [directSource.id]);
  assert.match(snapshot.sourceRecords[0].content, /因为突然下大雨/u);
  assert.doesNotMatch(JSON.stringify(snapshot), /private[\\/]transcript|private[\\/]memory/u);
  assert.equal(snapshot.inputPolicy.modelCannotWriteEdges, true);
  database.close();
});

test("turns generated causes into pending proposals without writing graph edges", async () => {
  const { database, repository, directSource, unrelatedSource } = relationFixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-relation-structurer-"));
  const ledgerPath = path.join(directory, "usage.jsonl");
  let received;
  const generator = async (request) => {
    received = request;
    return {
      output: {
        proposals: [
          {
            relation: "causes",
            fromMemoryId: "relation-rain",
            toMemoryId: "relation-cancel",
            evidenceSourceIds: [directSource.id],
            confidence: 0.91,
            rationale: "原话使用因为和所以明确连接了大雨与取消计划。",
          },
          {
            relation: "causes",
            fromMemoryId: "relation-dinner",
            toMemoryId: "relation-cancel",
            evidenceSourceIds: [unrelatedSource.id],
            confidence: 0.2,
            rationale: "把同一天发生的事误当成因果，应由边界策略拒绝。",
          },
          {
            relation: "causes",
            fromMemoryId: "invented-memory",
            toMemoryId: "relation-cancel",
            evidenceSourceIds: [directSource.id],
            confidence: 0.2,
            rationale: "编造端点必须被拒绝。",
          },
        ],
      },
      model: "fake-relation-model",
      usage: { input_tokens: 160, output_tokens: 60 },
      requestId: "fake-relation-request",
      durationMs: 18,
      metadata: { provider: "test-provider" },
    };
  };
  const result = await proposeRelationsForBatch({
    repository,
    agentId: "agent-test",
    batchId: "relation-batch",
    memoryIds: ["relation-rain", "relation-cancel", "relation-dinner"],
    generator,
    usageLedgerPath: ledgerPath,
  });
  assert.equal(result.status, "proposed");
  assert.equal(result.proposed.length, 1);
  assert.equal(result.rejected.length, 2);
  assert.match(result.rejected[0].error, /cover both endpoints/u);
  assert.match(result.rejected[1].error, /bounded snapshot/u);
  assert.equal(repository.listRelationProposals("agent-test", {
    reviewStates: ["pending"],
  }).length, 1);
  assert.equal(repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: "relation-rain",
    toMemoryId: "relation-cancel",
    relation: "causes",
  }), null);
  assert.equal(received.schemaName, "memory-relation-proposals-v1");
  assert.equal(received.schema.type, "object");
  assert.match(received.input, /因为突然下大雨/u);
  const ledger = await readUsageEvents(ledgerPath);
  assert.equal(ledger.events.length, 1);
  assert.equal(ledger.events[0].feature, "memory-relation-proposal");

  const duplicate = await proposeRelationsForBatch({
    repository,
    agentId: "agent-test",
    batchId: "relation-batch-2",
    memoryIds: ["relation-rain", "relation-cancel", "relation-dinner"],
    generator,
  });
  assert.equal(duplicate.proposed.length, 0);
  assert.equal(duplicate.duplicates.length, 1);
  assert.equal(duplicate.rejected.length, 2);
  database.close();
});

test("allows the relation generator to abstain without creating forced memories", async () => {
  const { database, repository } = relationFixture();
  const result = await proposeRelationsForBatch({
    repository,
    agentId: "agent-test",
    memoryIds: ["relation-rain", "relation-cancel"],
    generator: async () => ({ output: { proposals: [] } }),
  });
  assert.equal(result.status, "no-valid-proposals");
  assert.equal(repository.listRelationProposals("agent-test").length, 0);
  database.close();
});

test("plans bounded retrospective consolidation without changing the memory graph", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  for (const [id, content, agentId = "agent-test", kind = "event"] of [
    ["new-trigger", "用户刚明确说自己一直喜欢航天。"],
    ["old-space-museum", "用户以前参观过航天展。"],
    ["old-rocket-search", "用户以前主动搜索过火箭内容。"],
    ["weak-neighbor", "只是很弱的相似内容。"],
    ["raw-old-utterance", "旧对话原话。", "agent-test", "utterance"],
    ["foreign-memory", "另一个 Agent 的记忆。", "agent-foreign"],
  ]) {
    repository.upsertMemory({
      id,
      agentId,
      kind,
      layer: kind === "utterance" ? "evidence" : "episodic",
      content,
    });
  }
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "new-trigger",
    toMemoryId: "old-space-museum",
    relation: "associated_with",
    direction: "undirected",
    weight: 0.92,
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "old-space-museum",
    toMemoryId: "old-rocket-search",
    relation: "same_thread",
    direction: "undirected",
    weight: 0.85,
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "new-trigger",
    toMemoryId: "weak-neighbor",
    relation: "associated_with",
    direction: "undirected",
    weight: 0.4,
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "new-trigger",
    toMemoryId: "raw-old-utterance",
    relation: "same_thread",
    direction: "undirected",
    weight: 0.9,
  });
  const beforeNodes = Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const beforeEdges = Number(database.prepare("SELECT COUNT(*) AS count FROM memory_edges").get().count);
  const plan = planMemoryConsolidation({
    repository,
    agentId: "agent-test",
    triggerMemoryIds: ["new-trigger"],
    maximumCandidates: 4,
  });
  assert.equal(plan.status, "planned");
  assert.deepEqual(plan.triggerIds, ["new-trigger"]);
  assert.deepEqual(plan.candidateIds, ["old-rocket-search", "old-space-museum"].sort());
  assert.deepEqual(plan.candidateReasons["old-space-museum"].relations, [
    "associated_with",
    "same_thread",
  ]);
  assert.ok(plan.candidateReasons["old-rocket-search"].depth >= 1);
  assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count), beforeNodes);
  assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM memory_edges").get().count), beforeEdges);
  assert.equal(repository.listStructureProposals("agent-test").length, 0);
  assert.equal(repository.listRelationProposals("agent-test").length, 0);

  const duplicate = planMemoryConsolidation({
    repository,
    agentId: "agent-test",
    triggerMemoryIds: ["new-trigger"],
    maximumCandidates: 4,
  });
  assert.equal(duplicate.id, plan.id);
  assert.equal(duplicate.wasInserted, false);
  assert.equal(repository.listConsolidationRuns("agent-test").length, 1);
  assert.throws(() => planMemoryConsolidation({
    repository,
    agentId: "agent-test",
    triggerMemoryIds: ["foreign-memory"],
  }), /same Agent/u);
  database.close();
});

test("records an empty consolidation plan without calling a generator or inventing links", async () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  repository.upsertMemory({
    id: "isolated-trigger",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "一条没有既有联系的新记忆。",
  });
  const plan = planMemoryConsolidation({
    repository,
    agentId: "agent-test",
    triggerMemoryIds: ["isolated-trigger"],
  });
  assert.deepEqual(plan.candidateIds, []);
  assert.deepEqual(plan.graphEdgeIds, []);
  let generatorCalls = 0;
  const result = await runMemoryConsolidation({
    repository,
    agentId: "agent-test",
    runId: plan.id,
    structureGenerator: async () => {
      generatorCalls += 1;
      return { output: { proposals: [] } };
    },
  });
  assert.equal(result.status, "no-proposals");
  assert.equal(result.run.status, "no_proposals");
  assert.equal(generatorCalls, 0);
  assert.equal(repository.listConsolidationRuns("agent-test", {
    statuses: ["planned"],
  }).length, 0);
  database.close();
});

test("honors an explicit zero consolidation candidate limit", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  for (const id of ["zero-trigger", "zero-neighbor"]) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content: id,
    });
  }
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "zero-trigger",
    toMemoryId: "zero-neighbor",
    relation: "associated_with",
    direction: "undirected",
    weight: 1,
  });
  const plan = planMemoryConsolidation({
    repository,
    agentId: "agent-test",
    triggerMemoryIds: ["zero-trigger"],
    maximumCandidates: 0,
  });
  assert.deepEqual(plan.candidateIds, []);
  assert.deepEqual(plan.graphEdgeIds, []);
  assert.equal(plan.metadata.selectionPolicy.maximumCandidates, 0);
  database.close();
});

function consolidationFixture() {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const sharedSource = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: "storm-cancel-retrospective-source",
    occurredAt: "2026-07-12T08:30:00.000Z",
    speaker: "User",
    content: "昨晚预报今天有暴雨，早上果然下了大雨，所以我取消了今天的航天展行程。",
  });
  for (const memory of [
    {
      id: "new-cancel",
      content: "用户今天因为暴雨取消了航天展行程。",
      eventStart: "2026-07-12T08:30:00.000Z",
    },
    {
      id: "old-heavy-rain",
      content: "当天早上出现了暴雨。",
      eventStart: "2026-07-12T07:30:00.000Z",
    },
    {
      id: "old-forecast",
      content: "前一晚的天气预报提示次日有暴雨。",
      eventStart: "2026-07-11T20:00:00.000Z",
    },
  ]) {
    repository.upsertMemory({
      ...memory,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      subjectRole: memory.id === "new-cancel" ? "user" : "world",
      subjectKey: memory.id === "new-cancel" ? "user" : "",
    });
    repository.linkSource(memory.id, sharedSource.id, "evidence");
  }
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "new-cancel",
    toMemoryId: "old-heavy-rain",
    relation: "associated_with",
    direction: "undirected",
    weight: 0.94,
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "old-heavy-rain",
    toMemoryId: "old-forecast",
    relation: "same_thread",
    direction: "undirected",
    weight: 0.88,
  });
  const plan = planMemoryConsolidation({
    repository,
    agentId: "agent-test",
    triggerMemoryIds: ["new-cancel"],
    maximumCandidates: 4,
  });
  return { database, repository, plan, sharedSource };
}

function retrospectiveStructureOutput() {
  const base = {
    operation: "create",
    targetMemoryId: "",
    kind: "episode",
    title: "暴雨取消航天展",
    content: "暴雨导致当天的航天展行程被取消。",
    subjectRole: "user",
    subjectKey: "user",
    eventDate: null,
    eventStart: null,
    eventEnd: null,
    actorRoles: [],
    confidence: 0.9,
    rationale: "两条有时间的记忆描述同一次连续事件。",
  };
  return {
    proposals: [
      { ...base, memberIds: ["old-heavy-rain", "new-cancel"] },
      {
        ...base,
        title: "只整理旧记忆",
        content: "这条候选没有包含新记忆。",
        memberIds: ["old-forecast", "old-heavy-rain"],
      },
    ],
  };
}

test("runs retrospective consolidation as reviewable new-old proposals without changing the graph", async () => {
  const { database, repository, plan, sharedSource } = consolidationFixture();
  const beforeNodes = Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const beforeEdges = Number(database.prepare("SELECT COUNT(*) AS count FROM memory_edges").get().count);
  const received = [];
  const result = await runMemoryConsolidation({
    repository,
    agentId: "agent-test",
    runId: plan.id,
    structureGenerator: async (request) => {
      received.push(request.input);
      return { output: retrospectiveStructureOutput() };
    },
    relationGenerator: async (request) => {
      received.push(request.input);
      return {
        output: {
          proposals: [
            {
              relation: "causes",
              fromMemoryId: "old-heavy-rain",
              toMemoryId: "new-cancel",
              evidenceSourceIds: [sharedSource.id],
              confidence: 0.92,
              rationale: "原话明确使用所以说明暴雨导致行程取消。",
            },
            {
              relation: "causes",
              fromMemoryId: "old-forecast",
              toMemoryId: "old-heavy-rain",
              evidenceSourceIds: [sharedSource.id],
              confidence: 0.4,
              rationale: "这条候选只连接旧记忆，应被回顾策略拒绝。",
            },
          ],
        },
      };
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.run.status, "completed");
  assert.equal(result.structure.proposed.length, 1);
  assert.equal(result.structure.rejected.length, 1);
  assert.equal(result.relations.proposed.length, 1);
  assert.equal(result.relations.rejected.length, 1);
  assert.equal(result.run.structureProposalIds.length, 1);
  assert.equal(result.run.relationProposalIds.length, 1);
  assert.ok(received.every((input) => input.includes('"retrospectiveContext"')));
  assert.ok(received.every((input) => input.includes('"triggerMemoryIds"')));
  assert.ok(received.every((input) => input.includes('"historicalMemoryIds"')));
  assert.equal(repository.listStructureProposals("agent-test")[0].review_state, "pending");
  assert.equal(repository.listRelationProposals("agent-test")[0].review_state, "pending");
  assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count), beforeNodes);
  assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM memory_edges").get().count), beforeEdges);
  assert.equal(repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: "old-heavy-rain",
    toMemoryId: "new-cancel",
    relation: "causes",
  }), null);

  let rerunCalls = 0;
  const rerun = await runMemoryConsolidation({
    repository,
    agentId: "agent-test",
    runId: plan.id,
    structureGenerator: async () => {
      rerunCalls += 1;
      return { output: { proposals: [] } };
    },
  });
  assert.equal(rerun.status, "already-finished");
  assert.equal(rerunCalls, 0);
  database.close();
});

test("records partial consolidation proposals when a later generator fails", async () => {
  const { database, repository, plan } = consolidationFixture();
  const beforeEdges = Number(database.prepare("SELECT COUNT(*) AS count FROM memory_edges").get().count);
  const result = await runMemoryConsolidation({
    repository,
    agentId: "agent-test",
    runId: plan.id,
    structureGenerator: async () => ({ output: retrospectiveStructureOutput() }),
    relationGenerator: async () => {
      throw new Error("simulated relation provider failure");
    },
  });
  assert.equal(result.status, "failed");
  assert.match(result.error, /simulated relation provider failure/u);
  assert.equal(result.run.status, "failed");
  assert.equal(result.run.structureProposalIds.length, 1);
  assert.deepEqual(result.run.relationProposalIds, []);
  assert.equal(repository.listStructureProposals("agent-test").length, 1);
  assert.equal(repository.listRelationProposals("agent-test").length, 0);
  assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM memory_edges").get().count), beforeEdges);
  database.close();
});

test("refuses to execute a consolidation run already claimed by another worker", async () => {
  const { database, repository, plan } = consolidationFixture();
  repository.claimConsolidationRun({ agentId: "agent-test", runId: plan.id });
  await assert.rejects(runMemoryConsolidation({
    repository,
    agentId: "agent-test",
    runId: plan.id,
    structureGenerator: async () => ({ output: { proposals: [] } }),
  }), /already running/u);
  assert.equal(repository.getConsolidationRun("agent-test", plan.id).status, "running");
  assert.equal(repository.listStructureProposals("agent-test").length, 0);
  database.close();
});

test("processes a bounded planned batch and isolates one failed run", async () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  for (const id of ["fail-trigger", "fail-history", "ok-trigger", "ok-history"]) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content: `${id} 的直接事件记忆。`,
      eventStart: id.startsWith("fail")
        ? "2026-07-10T08:00:00.000Z"
        : "2026-07-11T08:00:00.000Z",
    });
  }
  for (const prefix of ["fail", "ok"]) {
    repository.upsertEdge({
      agentId: "agent-test",
      fromMemoryId: `${prefix}-trigger`,
      toMemoryId: `${prefix}-history`,
      relation: "associated_with",
      direction: "undirected",
      weight: 1,
    });
  }
  const failedPlan = planMemoryConsolidation({
    repository,
    agentId: "agent-test",
    triggerMemoryIds: ["fail-trigger"],
  });
  const okPlan = planMemoryConsolidation({
    repository,
    agentId: "agent-test",
    triggerMemoryIds: ["ok-trigger"],
  });
  const result = await processPlannedConsolidationRuns({
    repository,
    agentId: "agent-test",
    maximumRuns: 2,
    generator: async ({ input }) => {
      if (input.includes('"fail-trigger"')) throw new Error("simulated provider failure");
      return { output: { proposals: [] } };
    },
  });
  assert.equal(result.status, "completed-with-failures");
  assert.equal(result.selected, 2);
  assert.equal(result.counts.failed, 1);
  assert.equal(result.counts["no-proposals"], 1);
  assert.equal(repository.getConsolidationRun("agent-test", failedPlan.id).status, "failed");
  assert.equal(repository.getConsolidationRun("agent-test", okPlan.id).status, "no_proposals");
  await assert.rejects(processPlannedConsolidationRuns({
    repository,
    agentId: "agent-test",
    maximumRuns: 0,
    generator: async () => ({ output: { proposals: [] } }),
  }), /1 to 100/u);
  database.close();
});
