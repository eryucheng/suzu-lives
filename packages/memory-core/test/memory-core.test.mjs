import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  databaseInfo,
  MemoryRepository,
  isStateAnalysisTargetComplete,
  normalizeStateAnalysisTargetSpec,
  openMemoryDatabase,
  proposeMemoryRelation,
  proposeMemoryStructure,
  rebuildAssociationGraph,
  resolveMemoryRelationProposal,
  resolveMemoryStructureProposal,
  revokeMemoryRelationProposal,
  SCHEMA_VERSION,
  updateAssociationGraph,
} from "../src/index.mjs";
import { MIGRATIONS } from "../src/schema.mjs";
import { createHash } from "node:crypto";

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("creates a versioned SQLite memory database with Chinese search", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const info = databaseInfo(database);
  assert.equal(info.schemaVersion, SCHEMA_VERSION);
  assert.match(info.searchTokenizer, /^(trigram|unicode61)$/u);

  repository.upsertMemory({
    id: "museum",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "科技馆",
    content: "周六一起去了上海科技馆，看了机器人展览。",
  });
  repository.upsertMemory({
    id: "breakfast",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "早餐",
    content: "早上吃了面包。",
  });

  assert.equal(repository.search("agent-test", "科技馆")[0].id, "museum");
  assert.equal(
    repository.search("agent-test", "科技馆", { layers: ["episodic"] })[0].id,
    "museum",
  );
  assert.equal(repository.search("agent-test", "面")[0].id, "breakfast");
  database.close();
});

test("keeps event, known, and recorded time separate from actor and evidence roles", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const source = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: "message-1",
    occurredAt: "2026-07-01T02:00:00.000Z",
    knownAt: "2026-07-03T03:00:00.000Z",
    recordedAt: "2026-07-04T04:00:00.000Z",
    speaker: "User",
    content: "我七月一日去了科技馆。",
  });
  const memory = repository.upsertMemory({
    id: "tri-time-event",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户七月一日去了科技馆。",
    subjectRole: "user",
    subjectKey: "user",
    eventStart: "2026-07-01T02:00:00.000Z",
    knownAt: "2026-07-03T03:00:00.000Z",
    recordedAt: "2026-07-04T04:00:00.000Z",
    confidence: 0.72,
    actorRoles: [
      {
        role: "experiencer",
        actorRole: "user",
        actorKey: "user",
        confidence: 1,
        provenance: "test",
      },
      {
        role: "observer",
        actorRole: "agent",
        actorKey: "agent-test",
        confidence: 1,
        provenance: "test",
      },
    ],
  });
  repository.linkSource(memory.id, source.id, "evidence", {
    authority: "subject_firsthand",
    sourceTrust: 0.9,
    evidenceStrength: 0.85,
    provenance: "test",
  });

  const detail = repository.getMemoryDetail("agent-test", memory.id);
  assert.equal(detail.memory.event_start, "2026-07-01T02:00:00.000Z");
  assert.equal(detail.memory.known_at, "2026-07-03T03:00:00.000Z");
  assert.equal(detail.memory.recorded_at, "2026-07-04T04:00:00.000Z");
  assert.equal(detail.memory.confidence, 0.72);
  assert.equal(detail.sources[0].known_at, "2026-07-03T03:00:00.000Z");
  assert.equal(detail.sources[0].authority, "subject_firsthand");
  assert.equal(detail.sources[0].source_trust, 0.9);
  assert.equal(detail.sources[0].evidence_strength, 0.85);
  assert.deepEqual(
    detail.roles.map((role) => `${role.role}:${role.actor_role}:${role.actor_key}`).sort(),
    [
      "experiencer:user:user",
      "observer:agent:agent-test",
      "subject:user:user",
    ],
  );
  database.close();
});

test("keeps state discovery as an idempotent analysis request instead of a personality node", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const source = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: "preference-message-1",
    occurredAt: "2026-07-01T02:00:00.000Z",
    knownAt: "2026-07-01T02:00:00.000Z",
    recordedAt: "2026-07-01T02:01:00.000Z",
    speaker: "User",
    content: "我很喜欢解谜游戏。",
  });
  repository.upsertMemory({
    id: "preference-utterance-1",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "我很喜欢解谜游戏。",
    subjectRole: "user",
    subjectKey: "user",
  });
  repository.linkSource("preference-utterance-1", source.id, "verbatim", {
    authority: "verbatim_record",
    sourceTrust: 1,
    evidenceStrength: 1,
  });
  const input = {
    agentId: "agent-test",
    batchId: "batch-1",
    candidateIndex: 0,
    stateFamily: "preference",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "preference.game.puzzle",
    targetLabel: "解谜游戏",
    representationLayer: "reported",
    evidenceMode: "explicit",
    memoryIds: ["preference-utterance-1"],
    sourceIds: [source.id],
    createdAt: "2026-07-01T02:02:00.000Z",
  };
  const first = repository.recordStateAnalysisRequest(input);
  const repeated = repository.recordStateAnalysisRequest({
    ...input,
    batchId: "batch-2",
    candidateIndex: 3,
  });
  assert.equal(first.wasInserted, true);
  assert.equal(repeated.wasInserted, false);
  assert.equal(repeated.id, first.id);
  database.prepare(`
    UPDATE memory_state_analysis_requests
    SET input_hash = '0000000000000000000000000000000000000000000000000000000000000000'
    WHERE id = ?
  `).run(first.id);
  const replayAfterMigration = repository.recordStateAnalysisRequest(input);
  assert.equal(replayAfterMigration.wasInserted, false);
  assert.equal(replayAfterMigration.id, first.id);
  assert.equal(first.status, "pending");
  assert.equal(first.representation_layer, "reported");
  assert.deepEqual(first.memoryIds, ["preference-utterance-1"]);
  assert.deepEqual(first.sourceIds, [source.id]);
  assert.equal(repository.listMemories("agent-test", { kinds: ["preference"] }).total, 0);
  assert.equal(repository.listStateAnalysisRequests("agent-test", {
    statuses: ["pending"],
  }).length, 1);
  assert.equal(repository.listStateAnalysisRequests("agent-test", {
    statuses: ["pending"],
    stateFamily: "preference",
    representationLayer: "reported",
    evidenceMode: "explicit",
  }).length, 1);
  assert.equal(repository.listStateAnalysisRequests("agent-test", {
    statuses: ["pending"],
    stateFamilies: ["preference", "goal"],
    representationLayer: "reported",
    evidenceMode: "explicit",
  }).length, 1);
  assert.equal(repository.listStateAnalysisRequests("agent-test", {
    statuses: ["pending"],
    representationLayer: "inferred",
  }).length, 0);
  const completed = repository.resolveStateAnalysisRequest({
    agentId: "agent-test",
    requestId: first.id,
    status: "completed",
    analysisBatchId: "analysis-batch-1",
    resolvedAt: "2026-07-01T02:03:00.000Z",
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.analysis_batch_id, "analysis-batch-1");
  assert.equal(repository.listStateAnalysisRequests("agent-test", {
    statuses: ["pending"],
  }).length, 0);
  database.close();
});

test("validates structured analysis targets and keeps them immutable", () => {
  const identityTarget = {
    identityField: "occupation",
    fieldCardinality: "multi_item",
  };
  assert.deepEqual(
    normalizeStateAnalysisTargetSpec("identity", identityTarget, { allowEmpty: false }),
    identityTarget,
  );
  assert.equal(isStateAnalysisTargetComplete("identity", identityTarget), true);
  assert.equal(isStateAnalysisTargetComplete("identity", {}), false);
  assert.equal(isStateAnalysisTargetComplete("preference", {}), true);
  assert.throws(
    () => normalizeStateAnalysisTargetSpec("identity", "occupation"),
    /targetSpec is invalid/u,
  );
  assert.throws(
    () => normalizeStateAnalysisTargetSpec("relationship", {
      counterpartRole: "agent",
      counterpartKey: "agent-test",
      counterpartLabel: "Agent",
      direction: "counterpart_to_holder",
    }),
    /targetSpec is invalid/u,
  );

  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const source = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: "identity-message-1",
    occurredAt: "2026-07-01T02:00:00.000Z",
    knownAt: "2026-07-01T02:00:00.000Z",
    recordedAt: "2026-07-01T02:01:00.000Z",
    speaker: "User",
    content: "我的职业是产品经理。",
  });
  repository.upsertMemory({
    id: "identity-utterance-1",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "我的职业是产品经理。",
    subjectRole: "user",
    subjectKey: "user",
  });
  repository.linkSource("identity-utterance-1", source.id, "verbatim", {
    authority: "verbatim_record",
    sourceTrust: 1,
    evidenceStrength: 1,
  });
  const requestInput = {
    agentId: "agent-test",
    batchId: "identity-batch-1",
    candidateIndex: 0,
    stateFamily: "identity",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "identity.occupation.product-manager",
    targetLabel: "产品经理",
    targetSpec: identityTarget,
    representationLayer: "reported",
    evidenceMode: "explicit",
    memoryIds: ["identity-utterance-1"],
    sourceIds: [source.id],
    createdAt: "2026-07-01T02:02:00.000Z",
  };
  const request = repository.recordStateAnalysisRequest(requestInput);
  assert.deepEqual(request.targetSpec, identityTarget);
  assert.throws(
    () => repository.recordStateAnalysisRequest({
      ...requestInput,
      targetSpec: {
        identityField: "employer",
        fieldCardinality: "multi_item",
      },
    }),
    /candidate already exists with different contents/u,
  );
  database.close();
});

test("keeps reported and established current states in separate representation layers", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const common = {
    agentId: "agent-test",
    kind: "fact",
    layer: "semantic",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "capability:node-scripts",
    temporalState: "current",
    status: "active",
    stateFamily: "capability",
    statePhase: "active",
  };
  repository.upsertMemory({
    ...common,
    id: "reported-node-capability",
    content: "用户说自己会写 Node.js 脚本。",
    evidenceMode: "explicit",
    representationLayer: "reported",
    validFrom: "2026-07-01T08:00:00.000Z",
  });
  repository.upsertMemory({
    ...common,
    id: "established-node-capability",
    content: "多次直接表现支持用户能够编写 Node.js 脚本。",
    evidenceMode: "observed",
    representationLayer: "established",
    validFrom: "2026-07-02T08:00:00.000Z",
  });

  assert.equal(repository.getCurrentCanonicalMemory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "capability:node-scripts",
    representationLayer: "reported",
  }).id, "reported-node-capability");
  assert.equal(repository.getCurrentCanonicalMemory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "capability:node-scripts",
    representationLayer: "established",
  }).id, "established-node-capability");
  assert.deepEqual(repository.listCanonicalStateHistory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "capability:node-scripts",
    representationLayer: "reported",
  }).map((memory) => memory.id), ["reported-node-capability"]);
  assert.equal(repository.getMemory("reported-node-capability").representation_layer, "reported");
  assert.equal(repository.getMemory("reported-node-capability").state_family, "capability");
  assert.equal(repository.getMemory("reported-node-capability").state_phase, "active");
  assert.throws(() => repository.getCurrentCanonicalMemory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "capability:node-scripts",
    representationLayer: "guessed",
  }), /representationLayer is invalid/u);
  database.close();
});

test("stores state family and domain phase without guessing legacy or non-state meanings", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const event = repository.upsertMemory({
    id: "ordinary-event",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户今天去了科技馆。",
  });
  const legacyLikeFact = repository.upsertMemory({
    id: "legacy-like-fact",
    agentId: "agent-test",
    kind: "fact",
    layer: "semantic",
    content: "旧调用方没有提供状态家族。",
  });
  assert.equal(event.state_family, "not_applicable");
  assert.equal(event.state_phase, "not_applicable");
  assert.equal(legacyLikeFact.state_family, "unspecified");
  assert.equal(legacyLikeFact.state_phase, "unspecified");

  const common = {
    agentId: "agent-test",
    kind: "fact",
    layer: "semantic",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "shared-key",
    representationLayer: "established",
    temporalState: "current",
    status: "active",
  };
  repository.upsertMemory({
    ...common,
    id: "identity-state",
    content: "这是身份状态。",
    stateFamily: "identity",
    statePhase: "active",
  });
  repository.upsertMemory({
    ...common,
    id: "capability-state",
    content: "这是能力状态。",
    stateFamily: "capability",
    statePhase: "paused",
  });

  assert.equal(repository.getCurrentCanonicalMemory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "shared-key",
    representationLayer: "established",
    stateFamily: "identity",
  }).id, "identity-state");
  assert.equal(repository.getCurrentCanonicalMemory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "shared-key",
    representationLayer: "established",
    stateFamily: "capability",
  }).id, "capability-state");
  assert.deepEqual(repository.findCanonicalMemories({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "shared-key",
    representationLayer: "established",
    stateFamily: "capability",
  }).map((memory) => memory.id), ["capability-state"]);
  assert.deepEqual(repository.listCanonicalStateHistory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "shared-key",
    representationLayer: "established",
    stateFamily: "identity",
  }).map((memory) => memory.id), ["identity-state"]);

  const edited = repository.editMemoryManually({
    agentId: "agent-test",
    memoryId: "capability-state",
    patch: { content: "人工修正了能力状态正文。" },
    actor: "human:test",
    reason: "验证状态契约保持不变",
  });
  assert.equal(edited.representation_layer, "established");
  assert.equal(edited.state_family, "capability");
  assert.equal(edited.state_phase, "paused");

  assert.throws(() => repository.upsertMemory({
    id: "invalid-event-state",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "普通事件不能伪装成人物状态。",
    stateFamily: "identity",
  }), /Non-state memory cannot carry stateFamily or statePhase/u);
  assert.throws(() => repository.upsertMemory({
    id: "invalid-fact-state",
    agentId: "agent-test",
    kind: "fact",
    layer: "semantic",
    content: "状态节点不能标记为不适用。",
    stateFamily: "not_applicable",
  }), /Stateful memory cannot use a not_applicable stateFamily/u);
  assert.throws(() => repository.upsertMemory({
    id: "invalid-family-kind-pair",
    agentId: "agent-test",
    kind: "belief_state",
    layer: "semantic",
    content: "能力家族不能伪装成观念状态节点。",
    stateFamily: "capability",
    statePhase: "active",
  }), /Memory kind belief_state is not allowed for stateFamily capability/u);
  assert.throws(() => repository.getCurrentCanonicalMemory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "shared-key",
    stateFamily: "guessed",
  }), /stateFamily is invalid/u);
  database.close();
});

test("keeps causal relations as evidence-backed review proposals until explicit acceptance", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const causeSource = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: "cause-source",
    speaker: "User",
    content: "因为下起大雨，我决定取消出门。",
  });
  const effectSource = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: "effect-source",
    speaker: "User",
    content: "我把今天的出门计划取消了。",
  });
  const unrelatedSource = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: "unrelated-source",
    speaker: "User",
    content: "晚饭吃了面。",
  });
  repository.upsertMemory({
    id: "heavy-rain",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "当天突然下起大雨。",
    subjectRole: "world",
  });
  repository.upsertMemory({
    id: "cancel-outing",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户取消了当天的出门计划。",
    subjectRole: "user",
    subjectKey: "user",
  });
  repository.linkSource("heavy-rain", causeSource.id, "evidence");
  repository.linkSource("cancel-outing", effectSource.id, "evidence");

  assert.throws(() => proposeMemoryRelation(repository, {
    agentId: "agent-test",
    relation: "associated_with",
    fromMemoryId: "heavy-rain",
    toMemoryId: "cancel-outing",
    evidenceSourceIds: [causeSource.id, effectSource.id],
    rationale: "模型只看出相关性。",
  }), /causes relation/u);
  assert.throws(() => proposeMemoryRelation(repository, {
    agentId: "agent-test",
    relation: "causes",
    fromMemoryId: "heavy-rain",
    toMemoryId: "cancel-outing",
    evidenceSourceIds: [unrelatedSource.id],
    rationale: "无关原文不能充当因果证据。",
  }), /support at least one proposed endpoint/u);

  const proposal = proposeMemoryRelation(repository, {
    agentId: "agent-test",
    batchId: "relation-batch-1",
    relation: "causes",
    fromMemoryId: "heavy-rain",
    toMemoryId: "cancel-outing",
    evidenceSourceIds: [causeSource.id, effectSource.id],
    confidence: 0.83,
    rationale: "原话明确说明大雨是取消出门的原因。",
  });
  assert.equal(proposal.review_state, "pending");
  assert.equal(repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: "heavy-rain",
    toMemoryId: "cancel-outing",
    relation: "causes",
  }), null);
  assert.deepEqual(
    proposal.evidence.map((source) => source.endpointCoverage).sort(),
    ["from", "to"],
  );
  const duplicate = proposeMemoryRelation(repository, {
    agentId: "agent-test",
    batchId: "relation-batch-2",
    relation: "causes",
    fromMemoryId: "heavy-rain",
    toMemoryId: "cancel-outing",
    evidenceSourceIds: [effectSource.id, causeSource.id],
    confidence: 0.9,
    rationale: "相同端点与证据只是重复候选。",
  });
  assert.equal(duplicate.id, proposal.id);
  assert.equal(duplicate.wasInserted, false);

  const accepted = resolveMemoryRelationProposal(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    action: "accept",
    resolvedBy: "human:test",
    note: "原文足以证明。",
  });
  assert.equal(accepted.proposal.review_state, "accepted");
  assert.equal(accepted.edge.relation, "causes");
  assert.deepEqual(
    accepted.edge.metadata.evidenceSourceIds.sort(),
    [causeSource.id, effectSource.id].sort(),
  );
  const revoked = revokeMemoryRelationProposal(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    revokedBy: "human:test",
    note: "撤销误接受。",
  });
  assert.equal(revoked.review_state, "revoked");
  assert.equal(repository.getEdge("agent-test", accepted.edge.id), null);
  database.close();
});

test("rejects cross-Agent causal evidence and rolls back a failed acceptance atomically", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const source = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: "shared-causal-statement",
    content: "因为闹钟没响，所以用户迟到了。",
  });
  const foreignSource = repository.upsertSource({
    agentId: "agent-foreign",
    sourceKind: "conversation",
    externalId: "foreign-causal-statement",
    content: "另一个 Agent 的原始信息。",
  });
  for (const [id, content] of [
    ["alarm-failed", "闹钟没有响。"],
    ["arrived-late", "用户迟到了。"],
  ]) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content,
      subjectRole: id === "alarm-failed" ? "world" : "user",
      subjectKey: id === "alarm-failed" ? "" : "user",
    });
    repository.linkSource(id, source.id, "evidence");
  }
  repository.upsertMemory({
    id: "foreign-effect",
    agentId: "agent-foreign",
    kind: "event",
    layer: "episodic",
    content: "另一个 Agent 的事件。",
  });
  repository.linkSource("foreign-effect", foreignSource.id, "evidence");
  assert.throws(() => proposeMemoryRelation(repository, {
    agentId: "agent-test",
    relation: "causes",
    fromMemoryId: "alarm-failed",
    toMemoryId: "foreign-effect",
    evidenceSourceIds: [source.id, foreignSource.id],
    rationale: "不能跨 Agent 连图。",
  }), /same Agent/u);

  const proposal = proposeMemoryRelation(repository, {
    agentId: "agent-test",
    relation: "causes",
    fromMemoryId: "alarm-failed",
    toMemoryId: "arrived-late",
    evidenceSourceIds: [source.id],
    rationale: "同一条原话直接表达了原因与结果。",
  });
  const originalResolve = repository.resolveRelationProposal.bind(repository);
  repository.resolveRelationProposal = () => {
    throw new Error("simulated relation resolution failure");
  };
  assert.throws(() => resolveMemoryRelationProposal(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    action: "accept",
  }), /simulated relation resolution failure/u);
  repository.resolveRelationProposal = originalResolve;
  assert.equal(repository.getRelationProposal("agent-test", proposal.id).review_state, "pending");
  assert.equal(repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: "alarm-failed",
    toMemoryId: "arrived-late",
    relation: "causes",
  }), null);
  database.close();
});

test("stores retrieval traces and append-only feedback outside personality memories", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  repository.upsertMemory({
    id: "trace-memory",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户去了科技馆。",
  });
  const trace = repository.recordRetrievalTrace({
    id: "trace-test",
    agentId: "agent-test",
    queryText: "还记得科技馆吗",
    recallIntent: "event",
    chainMode: "none",
    resultStatus: "ready",
    retrievalMode: "lexical",
    seedIds: ["trace-memory"],
    selectedIds: ["trace-memory"],
    paths: [{ memoryId: "trace-memory", score: 1 }],
    matchedEntityIds: ["place-museum"],
    contextChars: 120,
    candidateCount: 1,
    vectorStatus: "not-run",
    metadata: { disclosureLevel: "event" },
    createdAt: "2026-08-01T01:00:00.000Z",
  });
  assert.equal(trace.query_text, "还记得科技馆吗");
  assert.equal(trace.query_hash.length, 64);
  assert.notEqual(trace.query_hash, trace.query_text);
  assert.deepEqual(trace.seedIds, ["trace-memory"]);
  assert.deepEqual(trace.selectedIds, ["trace-memory"]);
  assert.deepEqual(trace.matchedEntityIds, ["place-museum"]);
  assert.equal(trace.context_chars, 120);
  assert.equal(trace.metadata.disclosureLevel, "event");

  repository.recordRetrievalFeedback({
    id: "feedback-used",
    agentId: "agent-test",
    traceId: trace.id,
    signal: "used",
    targetMemoryIds: ["trace-memory"],
    createdAt: "2026-08-01T01:01:00.000Z",
  });
  repository.recordRetrievalFeedback({
    id: "feedback-corrected",
    agentId: "agent-test",
    traceId: trace.id,
    signal: "corrected",
    note: "用户指出事件主体不对。",
    createdAt: "2026-08-01T01:02:00.000Z",
  });
  assert.deepEqual(
    repository.listRetrievalFeedback("agent-test", trace.id)
      .map((value) => value.signal),
    ["used", "corrected"],
  );
  const memoryBeforeStats = repository.getMemoryDetail("agent-test", "trace-memory").memory;
  assert.deepEqual(repository.listMemoryRetrievalStats("agent-test", {
    memoryIds: ["trace-memory"],
  }), [{
    memoryId: "trace-memory",
    selectedCount: 1,
    seedCount: 1,
    lastSelectedAt: "2026-08-01T01:00:00.000Z",
    lastSeededAt: "2026-08-01T01:00:00.000Z",
    lastFeedbackAt: "2026-08-01T01:01:00.000Z",
    feedback: {
      used: 1,
      helpful: 0,
      irrelevant: 0,
      incorrect: 0,
      missed: 0,
      corrected: 0,
    },
  }]);
  assert.deepEqual(
    repository.getMemoryDetail("agent-test", "trace-memory").memory,
    memoryBeforeStats,
  );
  assert.deepEqual(repository.listMemoryRetrievalStats("other-agent", {
    memoryIds: ["trace-memory"],
  }), []);
  assert.deepEqual(repository.listMemoryRetrievalStats("agent-test", {
    memoryIds: ["trace-memory"],
    windowStart: "2026-08-01T01:00:00.000Z",
    windowEnd: "2026-08-01T01:00:30.000Z",
  })[0], {
    memoryId: "trace-memory",
    selectedCount: 1,
    seedCount: 1,
    lastSelectedAt: "2026-08-01T01:00:00.000Z",
    lastSeededAt: "2026-08-01T01:00:00.000Z",
    lastFeedbackAt: null,
    feedback: {
      used: 0,
      helpful: 0,
      irrelevant: 0,
      incorrect: 0,
      missed: 0,
      corrected: 0,
    },
  });
  assert.equal(repository.listMemoryRetrievalStats("agent-test", {
    memoryIds: ["trace-memory"],
    windowStart: "2026-08-02T00:00:00.000Z",
    windowEnd: "2026-08-03T00:00:00.000Z",
  })[0].selectedCount, 0);
  assert.throws(() => repository.listMemoryRetrievalStats("agent-test", {
    windowStart: "2026-08-03T00:00:00.000Z",
    windowEnd: "2026-08-02T00:00:00.000Z",
  }), /windowStart must be before windowEnd/u);
  assert.equal(repository.listRetrievalTraces("agent-test").length, 1);
  assert.equal(repository.listRetrievalTraces("other-agent").length, 0);
  assert.throws(() => repository.recordRetrievalFeedback({
    agentId: "other-agent",
    traceId: trace.id,
    signal: "used",
  }), /does not exist for this Agent/u);
  assert.throws(() => repository.recordRetrievalFeedback({
    agentId: "agent-test",
    traceId: trace.id,
    signal: "model-seemed-happy",
  }), /Unknown retrieval feedback signal/u);
  repository.upsertMemory({
    id: "foreign-feedback-memory",
    agentId: "other-agent",
    kind: "event",
    layer: "episodic",
    content: "其他 Agent 的事件。",
  });
  assert.throws(() => repository.recordRetrievalFeedback({
    agentId: "agent-test",
    traceId: trace.id,
    signal: "incorrect",
    targetMemoryIds: ["foreign-feedback-memory"],
  }), /same Agent/u);
  assert.equal(repository.listMemories("agent-test").total, 1);
  database.close();
});

test("binds one final response to one retrieval trace without pretending it was used", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  repository.upsertMemory({
    id: "usage-memory",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户去了科技馆。",
  });
  const trace = repository.recordRetrievalTrace({
    id: "usage-trace",
    agentId: "agent-test",
    queryText: "还记得科技馆吗",
    recallIntent: "event",
    resultStatus: "ready",
    seedIds: ["usage-memory"],
    selectedIds: ["usage-memory"],
    metadata: { runtimeSessionId: "session-test" },
    createdAt: "2026-08-01T01:00:00.000Z",
  });
  assert.equal(
    repository.findLatestUnboundRetrievalTrace("agent-test", "session-test").id,
    trace.id,
  );
  repository.setRetrievalSessionHead({
    agentId: "agent-test",
    sessionId: "session-test",
    traceId: trace.id,
  });
  assert.equal(repository.getRetrievalSessionHead("agent-test", "session-test").trace_id, trace.id);
  const request = repository.bindRetrievalUsageResponse({
    agentId: "agent-test",
    sessionId: "session-test",
    responseText: "记得，你去了科技馆。",
    metadata: { source: "claude-stop-hook" },
    createdAt: "2026-08-01T01:01:00.000Z",
  });
  assert.equal(request.wasInserted, true);
  assert.equal(request.status, "pending");
  assert.equal(request.response_hash.length, 64);
  assert.equal(repository.getRetrievalSessionHead("agent-test", "session-test"), null);
  assert.equal(repository.findLatestUnboundRetrievalTrace("agent-test", "session-test"), null);
  const replay = repository.recordRetrievalUsageRequest({
    agentId: "agent-test",
    traceId: trace.id,
    sessionId: "session-test",
    responseText: "记得，你去了科技馆。",
  });
  assert.equal(replay.wasInserted, false);
  assert.throws(() => repository.recordRetrievalUsageRequest({
    agentId: "agent-test",
    traceId: trace.id,
    sessionId: "session-test",
    responseText: "这是另一条回复。",
  }), /different response/u);
  const run = repository.recordRetrievalUsageAnalysisRun({
    agentId: "agent-test",
    requestId: request.id,
    traceId: trace.id,
    provider: "test",
    model: "test-model",
    promptVersion: "retrieval-usage-v1",
    schemaVersion: "retrieval-usage-v1",
    inputHash: request.response_hash,
    status: "completed",
    output: { analyses: [{ memoryId: "usage-memory", usage: "used" }] },
    usage: { input_tokens: 10, output_tokens: 4 },
  });
  assert.equal(run.status, "completed");
  const resolved = repository.resolveRetrievalUsageRequest({
    agentId: "agent-test",
    requestId: request.id,
    status: "completed",
    result: { usedMemoryIds: ["usage-memory"] },
    resolvedAt: "2026-08-01T01:02:00.000Z",
  });
  assert.equal(resolved.status, "completed");
  assert.deepEqual(resolved.result.usedMemoryIds, ["usage-memory"]);
  assert.equal(repository.listRetrievalFeedback("agent-test", trace.id).length, 0);
  database.close();
});

test("aggregates edge retrieval use without rewriting edges or crossing Agents", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  for (const [id, content] of [
    ["edge-source", "用户去了科技馆。"],
    ["edge-target", "用户后来参观了航天展。"],
    ["edge-unused-target", "用户还看过一次天文展。"],
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
    id: "edge-used",
    agentId: "agent-test",
    fromMemoryId: "edge-source",
    toMemoryId: "edge-target",
    relation: "semantic",
    weight: 0.7,
    confidence: 0.8,
  });
  repository.upsertEdge({
    id: "edge-unused",
    agentId: "agent-test",
    fromMemoryId: "edge-source",
    toMemoryId: "edge-unused-target",
    relation: "semantic",
    weight: 0.4,
    confidence: 0.6,
  });
  const trace = repository.recordRetrievalTrace({
    id: "edge-trace",
    agentId: "agent-test",
    queryText: "还记得科技馆和航天展吗",
    resultStatus: "ready",
    seedIds: ["edge-source"],
    selectedIds: ["edge-source", "edge-target"],
    paths: [{
      memoryId: "edge-target",
      score: 0.8,
      edges: [{
        edgeId: "edge-used",
        relation: "semantic",
        fromMemoryId: "edge-source",
        toMemoryId: "edge-target",
        relationView: "associative",
      }],
    }],
    createdAt: "2026-08-01T02:00:00.000Z",
  });
  repository.recordRetrievalFeedback({
    id: "edge-feedback-helpful",
    agentId: "agent-test",
    traceId: trace.id,
    signal: "helpful",
    targetMemoryIds: ["edge-target"],
    createdAt: "2026-08-01T02:01:00.000Z",
  });
  repository.recordRetrievalFeedback({
    id: "edge-feedback-seed",
    agentId: "agent-test",
    traceId: trace.id,
    signal: "irrelevant",
    targetMemoryIds: ["edge-source"],
    createdAt: "2026-08-01T02:02:00.000Z",
  });
  const edgeBeforeStats = database.prepare(`
    SELECT * FROM memory_edges WHERE id = ?
  `).get("edge-used");
  assert.deepEqual(repository.listEdgeRetrievalStats("agent-test", {
    edgeIds: ["edge-used", "edge-unused"],
  }), [{
    edgeId: "edge-used",
    fromMemoryId: "edge-source",
    toMemoryId: "edge-target",
    relation: "semantic",
    traversedCount: 1,
    lastTraversedAt: "2026-08-01T02:00:00.000Z",
    lastFeedbackAt: "2026-08-01T02:01:00.000Z",
    feedback: {
      used: 0,
      helpful: 1,
      irrelevant: 0,
      incorrect: 0,
      missed: 0,
      corrected: 0,
    },
  }, {
    edgeId: "edge-unused",
    fromMemoryId: "edge-source",
    toMemoryId: "edge-unused-target",
    relation: "semantic",
    traversedCount: 0,
    lastTraversedAt: null,
    lastFeedbackAt: null,
    feedback: {
      used: 0,
      helpful: 0,
      irrelevant: 0,
      incorrect: 0,
      missed: 0,
      corrected: 0,
    },
  }]);
  assert.deepEqual(
    database.prepare(`SELECT * FROM memory_edges WHERE id = ?`).get("edge-used"),
    edgeBeforeStats,
  );
  assert.deepEqual(repository.listEdgeRetrievalStats("other-agent", {
    edgeIds: ["edge-used"],
  }), []);
  assert.deepEqual(repository.listEdgeRetrievalStatsByView("agent-test", {
    edgeIds: ["edge-used"],
    intentViews: ["associative"],
    windowStart: "2026-08-01T02:00:00.000Z",
    windowEnd: "2026-08-01T02:02:00.000Z",
  }), [{
    edgeId: "edge-used",
    fromMemoryId: "edge-source",
    toMemoryId: "edge-target",
    relation: "semantic",
    intentView: "associative",
    traversedCount: 1,
    lastTraversedAt: "2026-08-01T02:00:00.000Z",
    lastFeedbackAt: "2026-08-01T02:01:00.000Z",
    feedback: {
      used: 0,
      helpful: 1,
      irrelevant: 0,
      incorrect: 0,
      missed: 0,
      corrected: 0,
    },
  }]);
  const emptyViewWindow = repository.listEdgeRetrievalStatsByView("agent-test", {
    edgeIds: ["edge-used"],
    intentViews: ["associative"],
    windowStart: "2026-08-02T00:00:00.000Z",
    windowEnd: "2026-08-03T00:00:00.000Z",
  })[0];
  assert.equal(emptyViewWindow.traversedCount, 0);
  assert.equal(emptyViewWindow.feedback.helpful, 0);
  database.close();
});

test("records idempotent plasticity shadow runs without changing learned state", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  repository.upsertMemory({
    id: "shadow-source",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户去了科技馆。",
  });
  repository.upsertMemory({
    id: "shadow-target",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户后来参观航天展。",
  });
  repository.upsertEdge({
    id: "shadow-edge",
    agentId: "agent-test",
    fromMemoryId: "shadow-source",
    toMemoryId: "shadow-target",
    relation: "semantic",
  });
  const inputHash = createHash("sha256").update("shadow-input").digest("hex");
  const payload = {
    agentId: "agent-test",
    policyVersion: "shadow-policy-v1",
    observationWindowId: "2026-08-01-day",
    windowStart: "2026-08-01T00:00:00.000Z",
    windowEnd: "2026-08-02T00:00:00.000Z",
    inputHash,
    createdAt: "2026-08-02T00:05:00.000Z",
    changes: [{
      targetType: "memory",
      targetId: "shadow-target",
      learningTarget: "accessibility",
      evidenceClass: "confirmed-helpful",
      evidenceTier: "verified",
      candidateDirection: "increase",
      targetPolicyVersion: "memory-shadow-policy-v1",
      baseState: { exists: false, value: null },
      currentValue: 0.5,
      decayedValue: 0.49,
      positiveStep: 0.08,
      negativeStep: 0,
      proposedValue: 0.57,
      blocked: false,
      evidence: { feedback: { helpful: 1 } },
    }, {
      targetType: "edge",
      targetId: "shadow-edge",
      learningTarget: "relation-utility",
      intentView: "associative",
      evidenceClass: "use-confirmed",
      evidenceTier: "weak",
      candidateDirection: "increase",
      targetPolicyVersion: "edge-shadow-policy-v1",
      baseState: { exists: false, value: null },
      currentValue: 0.5,
      decayedValue: 0.49,
      positiveStep: 0.02,
      negativeStep: 0,
      proposedValue: 0.51,
      blocked: false,
      evidence: { feedback: { used: 1 } },
    }],
  };
  const first = repository.recordPlasticityShadowRun(payload);
  assert.equal(first.wasInserted, true);
  assert.equal(first.candidateCount, 2);
  assert.equal(first.changes.length, 2);
  assert.equal(first.changes[0].blocked, false);
  assert.equal(repository.getMemoryAccessibilityState("agent-test", "shadow-target"), null);
  assert.equal(repository.getEdgeRelationUtilityState(
    "agent-test",
    "shadow-edge",
    "associative",
  ), null);
  assert.equal(Number(database.prepare(`
    SELECT COUNT(*) AS count FROM memory_accessibility_state
  `).get().count), 0);
  assert.equal(Number(database.prepare(`
    SELECT COUNT(*) AS count FROM memory_edge_relation_utility_state
  `).get().count), 0);

  const replay = repository.recordPlasticityShadowRun(payload);
  assert.equal(replay.wasInserted, false);
  assert.equal(replay.id, first.id);
  assert.equal(repository.listPlasticityShadowRuns("agent-test").length, 1);
  assert.equal(repository.listPlasticityShadowRuns("other-agent").length, 0);
  assert.equal(repository.getPlasticityShadowRun("other-agent", first.id), null);
  assert.throws(() => repository.recordPlasticityShadowRun({
    ...payload,
    inputHash: createHash("sha256").update("different-input").digest("hex"),
  }), /already recorded with different input/u);
  assert.throws(() => repository.recordPlasticityShadowRun({
    ...payload,
    policyVersion: "shadow-policy-v2",
    observationWindowId: "foreign-target",
    changes: [{
      ...payload.changes[0],
      targetId: "missing-memory",
    }],
  }), /not owned by this Agent/u);
  assert.equal(repository.listPlasticityShadowRuns("agent-test").length, 1);
  database.close();
});

test("applies and rolls back an explicitly approved plasticity run atomically", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  for (const [id, content] of [
    ["apply-source", "用户去了科技馆。"],
    ["apply-target", "用户后来参观航天展。"],
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
    id: "apply-edge",
    agentId: "agent-test",
    fromMemoryId: "apply-source",
    toMemoryId: "apply-target",
    relation: "semantic",
    weight: 0.73,
  });
  const inputHash = createHash("sha256").update("apply-input").digest("hex");
  const run = repository.recordPlasticityShadowRun({
    agentId: "agent-test",
    policyVersion: "memory:m1;edge:e1",
    observationWindowId: "apply-window",
    windowStart: "2026-08-01T00:00:00.000Z",
    windowEnd: "2026-08-02T00:00:00.000Z",
    inputHash,
    createdAt: "2026-08-02T00:05:00.000Z",
    changes: [{
      targetType: "memory",
      targetId: "apply-target",
      learningTarget: "accessibility",
      evidenceClass: "confirmed-helpful",
      evidenceTier: "verified",
      candidateDirection: "increase",
      targetPolicyVersion: "m1",
      baseState: { exists: false, value: null },
      currentValue: 0.5,
      decayedValue: 0.49,
      positiveStep: 0.08,
      negativeStep: 0,
      proposedValue: 0.57,
      blocked: false,
      evidence: { feedback: { helpful: 1 } },
    }, {
      targetType: "edge",
      targetId: "apply-edge",
      learningTarget: "relation-utility",
      intentView: "associative",
      evidenceClass: "use-confirmed",
      evidenceTier: "weak",
      candidateDirection: "increase",
      targetPolicyVersion: "e1",
      baseState: { exists: false, value: null },
      currentValue: 0.4,
      decayedValue: 0.39,
      positiveStep: 0.02,
      negativeStep: 0,
      proposedValue: 0.41,
      blocked: false,
      evidence: { feedback: { used: 1 } },
    }, {
      targetType: "memory",
      targetId: "apply-source",
      learningTarget: "manual-review",
      evidenceClass: "content-review-required",
      evidenceTier: "blocked",
      candidateDirection: "hold",
      targetPolicyVersion: "m1",
      baseState: { exists: false, value: null },
      currentValue: 0.5,
      decayedValue: 0.5,
      positiveStep: 0,
      negativeStep: 0,
      proposedValue: 0.5,
      blocked: true,
      blockReason: "content-review-required",
      evidence: { feedback: { corrected: 1 } },
    }],
  });
  assert.throws(() => repository.applyPlasticityShadowRun({
    agentId: "agent-test",
    runId: run.id,
    expectedInputHash: createHash("sha256").update("wrong").digest("hex"),
    actor: "human:test",
  }), /does not match/u);
  assert.throws(() => repository.applyPlasticityShadowRun({
    agentId: "agent-other",
    runId: run.id,
    expectedInputHash: inputHash,
    actor: "human:test",
  }), /does not exist for this Agent/u);

  const applied = repository.applyPlasticityShadowRun({
    agentId: "agent-test",
    runId: run.id,
    expectedInputHash: inputHash,
    actor: "human:test",
    reason: "固定评测通过后人工批准。",
    appliedAt: "2026-08-02T00:10:00.000Z",
  });
  assert.equal(applied.wasApplied, true);
  assert.equal(applied.status, "applied");
  assert.equal(applied.appliedCount, 2);
  assert.equal(applied.skippedCount, 1);
  assert.equal(applied.changes.length, 2);
  assert.equal(repository.getMemoryAccessibilityState(
    "agent-test",
    "apply-target",
  ).value, 0.57);
  assert.deepEqual(
    repository.listMemoryAccessibilityStates("agent-test", { policyVersions: ["m1"] })
      .map((state) => [state.memory_id, state.value]),
    [["apply-target", 0.57]],
  );
  assert.deepEqual(
    repository.listMemoryAccessibilityStates("agent-test", { policyVersions: ["other"] }),
    [],
  );
  assert.equal(repository.getEdgeRelationUtilityState(
    "agent-test",
    "apply-edge",
    "associative",
  ).value, 0.41);
  assert.equal(repository.getMemoryAccessibilityState(
    "agent-test",
    "apply-source",
  ), null);
  assert.equal(Number(database.prepare(`
    SELECT weight FROM memory_edges WHERE id = 'apply-edge'
  `).get().weight), 0.73);
  assert.equal(repository.getMemory("apply-target").content, "用户后来参观航天展。");
  const replay = repository.applyPlasticityShadowRun({
    agentId: "agent-test",
    runId: run.id,
    expectedInputHash: inputHash,
    actor: "human:test",
  });
  assert.equal(replay.wasApplied, false);
  assert.equal(replay.id, applied.id);

  assert.throws(() => repository.rollbackPlasticityApplication({
    agentId: "agent-test",
    applicationId: applied.id,
    actor: "human:test",
  }), /actor, and reason/u);
  const rolledBack = repository.rollbackPlasticityApplication({
    agentId: "agent-test",
    applicationId: applied.id,
    actor: "human:test",
    reason: "回滚验证。",
    rolledBackAt: "2026-08-02T00:20:00.000Z",
  });
  assert.equal(rolledBack.wasRolledBack, true);
  assert.equal(rolledBack.status, "rolled_back");
  assert.equal(repository.getMemoryAccessibilityState(
    "agent-test",
    "apply-target",
  ), null);
  assert.equal(repository.getEdgeRelationUtilityState(
    "agent-test",
    "apply-edge",
    "associative",
  ), null);
  assert.equal(repository.rollbackPlasticityApplication({
    agentId: "agent-test",
    applicationId: applied.id,
    actor: "human:test",
    reason: "重复回滚检查。",
  }).wasRolledBack, false);
  assert.throws(() => repository.applyPlasticityShadowRun({
    agentId: "agent-test",
    runId: run.id,
    expectedInputHash: inputHash,
    actor: "human:test",
  }), /cannot be silently reapplied/u);
  database.close();
});

test("rejects stale shadow state before applying any plasticity target", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  repository.upsertMemory({
    id: "stale-memory",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用于验证影子快照冲突。",
  });
  const inputHash = createHash("sha256").update("stale-input").digest("hex");
  const run = repository.recordPlasticityShadowRun({
    agentId: "agent-test",
    policyVersion: "memory:m1;edge:e1",
    observationWindowId: "stale-window",
    windowStart: "2026-08-01T00:00:00.000Z",
    windowEnd: "2026-08-02T00:00:00.000Z",
    inputHash,
    createdAt: "2026-08-02T00:05:00.000Z",
    changes: [{
      targetType: "memory",
      targetId: "stale-memory",
      learningTarget: "accessibility",
      evidenceClass: "exposure-only",
      evidenceTier: "weak",
      candidateDirection: "increase",
      targetPolicyVersion: "m1",
      baseState: { exists: false, value: null },
      currentValue: 0.5,
      decayedValue: 0.49,
      positiveStep: 0.01,
      negativeStep: 0,
      proposedValue: 0.5,
      blocked: false,
      evidence: { exposureCount: 1 },
    }],
  });
  database.prepare(`
    INSERT INTO memory_accessibility_state (
      memory_id, agent_id, value, policy_version,
      last_observation_window_id, last_applied_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "stale-memory",
    "agent-test",
    0.8,
    "external-policy",
    "external-window",
    "2026-08-02T00:06:00.000Z",
    "2026-08-02T00:06:00.000Z",
    "2026-08-02T00:06:00.000Z",
  );
  assert.throws(() => repository.applyPlasticityShadowRun({
    agentId: "agent-test",
    runId: run.id,
    expectedInputHash: inputHash,
    actor: "human:test",
    appliedAt: "2026-08-02T00:10:00.000Z",
  }), /changed after shadow evaluation/u);
  assert.equal(repository.listPlasticityApplications("agent-test").length, 0);
  assert.equal(repository.getMemoryAccessibilityState(
    "agent-test",
    "stale-memory",
  ).value, 0.8);
  database.close();
});

test("rolls back plasticity only from the latest applied target state", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  repository.upsertMemory({
    id: "ordered-memory",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用于验证按顺序回滚。",
  });
  const recordRun = ({
    windowId,
    policyVersion,
    inputText,
    windowStart,
    windowEnd,
    createdAt,
    baseState,
    currentValue,
    proposedValue,
  }) => {
    const inputHash = createHash("sha256").update(inputText).digest("hex");
    const run = repository.recordPlasticityShadowRun({
      agentId: "agent-test",
      policyVersion: `memory:${policyVersion};edge:e1`,
      observationWindowId: windowId,
      windowStart,
      windowEnd,
      inputHash,
      createdAt,
      changes: [{
        targetType: "memory",
        targetId: "ordered-memory",
        learningTarget: "accessibility",
        evidenceClass: "confirmed-helpful",
        evidenceTier: "verified",
        candidateDirection: "increase",
        targetPolicyVersion: policyVersion,
        baseState,
        currentValue,
        decayedValue: currentValue,
        positiveStep: Math.max(0, proposedValue - currentValue),
        negativeStep: 0,
        proposedValue,
        blocked: false,
        evidence: { feedback: { helpful: 1 } },
      }],
    });
    return { run, inputHash };
  };
  const first = recordRun({
    windowId: "ordered-window-1",
    policyVersion: "m1",
    inputText: "ordered-input-1",
    windowStart: "2026-08-01T00:00:00.000Z",
    windowEnd: "2026-08-02T00:00:00.000Z",
    createdAt: "2026-08-02T00:05:00.000Z",
    baseState: { exists: false, value: null },
    currentValue: 0.5,
    proposedValue: 0.6,
  });
  const firstApplication = repository.applyPlasticityShadowRun({
    agentId: "agent-test",
    runId: first.run.id,
    expectedInputHash: first.inputHash,
    actor: "human:test",
    appliedAt: "2026-08-02T00:10:00.000Z",
  });
  const firstState = repository.getMemoryAccessibilityState(
    "agent-test",
    "ordered-memory",
  );
  const second = recordRun({
    windowId: "ordered-window-2",
    policyVersion: "m2",
    inputText: "ordered-input-2",
    windowStart: "2026-08-02T00:00:00.000Z",
    windowEnd: "2026-08-03T00:00:00.000Z",
    createdAt: "2026-08-03T00:05:00.000Z",
    baseState: {
      exists: true,
      value: firstState.value,
      policyVersion: firstState.policy_version,
      observationWindowId: firstState.last_observation_window_id,
      appliedAt: firstState.last_applied_at,
    },
    currentValue: 0.6,
    proposedValue: 0.7,
  });
  const secondApplication = repository.applyPlasticityShadowRun({
    agentId: "agent-test",
    runId: second.run.id,
    expectedInputHash: second.inputHash,
    actor: "human:test",
    appliedAt: "2026-08-03T00:10:00.000Z",
  });
  assert.equal(repository.getMemoryAccessibilityState(
    "agent-test",
    "ordered-memory",
  ).value, 0.7);
  assert.throws(() => repository.rollbackPlasticityApplication({
    agentId: "agent-test",
    applicationId: firstApplication.id,
    actor: "human:test",
    reason: "不允许越过后续应用。",
    rolledBackAt: "2026-08-03T00:20:00.000Z",
  }), /later state/u);
  assert.equal(repository.rollbackPlasticityApplication({
    agentId: "agent-test",
    applicationId: secondApplication.id,
    actor: "human:test",
    reason: "先撤销最新窗口。",
    rolledBackAt: "2026-08-03T00:20:00.000Z",
  }).wasRolledBack, true);
  const restored = repository.getMemoryAccessibilityState("agent-test", "ordered-memory");
  assert.equal(restored.value, 0.6);
  assert.equal(restored.policy_version, "m1");
  assert.equal(restored.last_observation_window_id, "ordered-window-1");
  assert.equal(repository.rollbackPlasticityApplication({
    agentId: "agent-test",
    applicationId: firstApplication.id,
    actor: "human:test",
    reason: "再撤销上一窗口。",
    rolledBackAt: "2026-08-03T00:30:00.000Z",
  }).wasRolledBack, true);
  assert.equal(repository.getMemoryAccessibilityState(
    "agent-test",
    "ordered-memory",
  ), null);
  database.close();
});

test("keeps affective activation as a separate append-only human decision", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const memory = repository.upsertMemory({
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
    validFrom: "2026-08-03T08:00:00.000Z",
    metadata: {
      reportedStateDraft: {
        affectiveClaim: {
          trigger: { role: "other", key: "place:science-museum", label: "科技馆" },
          emotion: { label: "开心", valence: "positive", intensity: "high" },
        },
      },
    },
  });
  const enabled = repository.recordAffectiveActivationDecision({
    agentId: "agent-test",
    memoryId: memory.id,
    enabled: true,
    policyVersion: "human-affective-v1",
    actor: "human:test",
    reason: "用户明确允许这条联结只影响联想顺序。",
    createdAt: "2026-08-03T09:00:00.000Z",
  });
  assert.equal(enabled.enabled, true);
  assert.equal(repository.listEnabledAffectiveActivations("agent-test", {
    policyVersions: ["human-affective-v1"],
    representationLayers: ["reported"],
    subjectRole: "user",
    subjectKey: "user",
  })[0].memory.id, memory.id);
  assert.deepEqual(repository.listEnabledAffectiveActivations("agent-test", {
    policyVersions: ["another-policy"],
    representationLayers: ["reported"],
  }), []);

  const disabled = repository.recordAffectiveActivationDecision({
    agentId: "agent-test",
    memoryId: memory.id,
    enabled: false,
    policyVersion: "human-affective-v1",
    actor: "human:test",
    reason: "用户撤销这条联结的激活权限。",
    createdAt: "2026-08-03T10:00:00.000Z",
  });
  assert.equal(disabled.enabled, false);
  assert.equal(repository.listAffectiveActivationDecisions("agent-test", {
    memoryId: memory.id,
  }).length, 2);
  assert.deepEqual(repository.listEnabledAffectiveActivations("agent-test", {
    policyVersions: ["human-affective-v1"],
    representationLayers: ["reported"],
  }), []);
  assert.throws(() => repository.recordAffectiveActivationDecision({
    agentId: "agent-test",
    memoryId: memory.id,
    enabled: true,
    policyVersion: "human-affective-v1",
    actor: "human:test",
    reason: "",
  }), /requires memory, enabled, policy, actor, and reason/u);
  database.close();
});

test("resolves entity aliases without merging ambiguous names", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const memory = repository.upsertMemory({
    id: "museum-visit",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户去了上海科技馆。",
  });
  const museum = repository.upsertEntity({
    agentId: "agent-test",
    kind: "place",
    canonicalName: "上海科技馆",
    aliases: ["科技馆", " Shanghai Science Museum "],
    metadata: { city: "上海" },
  });
  const resolved = repository.upsertEntity({
    agentId: "agent-test",
    kind: "place",
    canonicalName: "科技馆",
  });
  assert.equal(resolved.id, museum.id);
  assert.equal(resolved.canonical_name, "上海科技馆");
  assert.deepEqual(resolved.aliases.sort(), ["Shanghai Science Museum", "科技馆"].sort());
  assert.throws(() => repository.upsertEntity({
    agentId: "agent-test",
    kind: "place",
    canonicalName: "浦东科技馆",
    aliases: ["科技馆"],
  }), /alias already belongs/u);

  repository.linkMemoryEntity({
    memoryId: memory.id,
    entityId: museum.id,
    role: "location",
  });
  assert.equal(repository.getMemoryDetail("agent-test", memory.id).entities[0].id, museum.id);
  assert.equal(repository.getMemoryDetail("agent-test", memory.id).entities[0].link_role, "location");
  assert.equal(repository.listEntityMemories({
    agentId: "agent-test",
    entityId: museum.id,
  })[0].id, memory.id);

  const otherAgentEntity = repository.upsertEntity({
    agentId: "other-agent",
    kind: "place",
    canonicalName: "上海科技馆",
  });
  assert.notEqual(otherAgentEntity.id, museum.id);
  assert.throws(() => repository.linkMemoryEntity({
    memoryId: memory.id,
    entityId: otherAgentEntity.id,
  }), /same Agent/u);
  database.close();
});

test("migrates a schema v3 database without guessing missing identity", () => {
  const root = temporaryDirectory("suzu-memory-schema-v3-");
  const databasePath = path.join(root, "memory.db");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  for (const migration of MIGRATIONS.filter((item) => item.version <= 3)) {
    legacy.exec(migration.sql);
    legacy.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(migration.version, migration.name, "2026-07-31T00:00:00.000Z");
  }
  legacy.prepare(`
    INSERT INTO memory_nodes (
      id, agent_id, kind, layer, title, content,
      recorded_at, status, confidence, importance, perspective,
      metadata_json, created_at, updated_at,
      subject_role, subject_key, canonical_key, reality,
      evidence_mode, temporal_state, revision_action
    ) VALUES (?, ?, ?, ?, '', ?, ?, 'active', 1, 0.5, '', '{}', ?, ?, ?, ?, '', 'real', 'imported', 'historical', 'add')
  `).run(
    "legacy-user-fact",
    "agent-test",
    "event",
    "episodic",
    "用户去过科技馆。",
    "2026-07-04T04:00:00.000Z",
    "2026-07-04T04:00:00.000Z",
    "2026-07-04T04:00:00.000Z",
    "user",
    "user",
  );
  legacy.prepare(`
    INSERT INTO memory_nodes (
      id, agent_id, kind, layer, title, content,
      recorded_at, status, confidence, importance, perspective,
      metadata_json, created_at, updated_at,
      subject_role, subject_key, canonical_key, reality,
      evidence_mode, temporal_state, revision_action
    ) VALUES (?, ?, ?, ?, '', ?, ?, 'active', 1, 0.5, '', '{}', ?, ?, 'unknown', '', '', 'real', 'imported', 'historical', 'add')
  `).run(
    "legacy-unknown-event",
    "agent-test",
    "event",
    "episodic",
    "主体无法确定的旧事件。",
    "2026-07-05T04:00:00.000Z",
    "2026-07-05T04:00:00.000Z",
    "2026-07-05T04:00:00.000Z",
  );
  legacy.prepare(`
    INSERT INTO source_records (
      id, agent_id, source_kind, source_locator, external_id,
      occurred_at, recorded_at, speaker, content, content_hash,
      metadata_json, created_at
    ) VALUES (?, ?, 'conversation', '', ?, ?, ?, ?, ?, ?, '{}', ?)
  `).run(
    "legacy-source-user-utterance",
    "agent-test",
    "legacy-message-1",
    "2026-07-06T04:00:00.000Z",
    "2026-07-06T04:05:00.000Z",
    "User",
    "我刚刚去了科技馆。",
    "legacy-content-hash",
    "2026-07-06T04:05:00.000Z",
  );
  legacy.prepare(`
    INSERT INTO memory_nodes (
      id, agent_id, kind, layer, title, content,
      recorded_at, status, confidence, importance, perspective,
      metadata_json, created_at, updated_at,
      subject_role, subject_key, canonical_key, reality,
      evidence_mode, temporal_state, revision_action
    ) VALUES (?, ?, 'utterance', 'episodic', '', ?, ?, 'active', 1, 0.5, '', '{}', ?, ?, 'user', 'user', '', 'real', 'explicit', 'historical', 'add')
  `).run(
    "legacy-user-utterance",
    "agent-test",
    "我刚刚去了科技馆。",
    "2026-07-06T04:05:00.000Z",
    "2026-07-06T04:05:00.000Z",
    "2026-07-06T04:05:00.000Z",
  );
  legacy.prepare(`
    INSERT INTO memory_sources (memory_id, source_id, relation, created_at)
    VALUES (?, ?, 'verbatim', ?)
  `).run(
    "legacy-user-utterance",
    "legacy-source-user-utterance",
    "2026-07-06T04:05:00.000Z",
  );
  legacy.close();

  const migrated = openMemoryDatabase(databasePath);
  assert.equal(databaseInfo(migrated).schemaVersion, SCHEMA_VERSION);
  assert.equal(
    migrated.prepare("SELECT known_at FROM memory_nodes WHERE id = 'legacy-user-fact'").get().known_at,
    "2026-07-04T04:00:00.000Z",
  );
  assert.equal(
    Number(migrated.prepare(`
      SELECT COUNT(*) AS count FROM memory_actor_roles
      WHERE memory_id = 'legacy-user-fact' AND role = 'subject'
        AND actor_role = 'user' AND actor_key = 'user'
    `).get().count),
    1,
  );
  assert.equal(
    Number(migrated.prepare(`
      SELECT COUNT(*) AS count FROM memory_actor_roles
      WHERE memory_id = 'legacy-unknown-event'
    `).get().count),
    0,
  );
  assert.equal(
    migrated.prepare(`
      SELECT known_at FROM source_records
      WHERE id = 'legacy-source-user-utterance'
    `).get().known_at,
    "2026-07-06T04:00:00.000Z",
  );
  assert.equal(
    Number(migrated.prepare(`
      SELECT COUNT(*) AS count FROM memory_actor_roles
      WHERE memory_id = 'legacy-user-utterance' AND role = 'speaker'
        AND actor_role = 'user' AND actor_key = 'user'
    `).get().count),
    1,
  );
  const migratedEvidence = migrated.prepare(`
    SELECT authority, source_trust, evidence_strength
    FROM memory_sources
    WHERE memory_id = 'legacy-user-utterance'
      AND source_id = 'legacy-source-user-utterance'
      AND relation = 'verbatim'
  `).get();
  assert.equal(migratedEvidence.authority, "verbatim_record");
  assert.equal(migratedEvidence.source_trust, 1);
  assert.equal(migratedEvidence.evidence_strength, 1);
  migrated.close();
});

test("upgrades an existing schema v5 review queue without losing pending decisions", () => {
  const root = temporaryDirectory("suzu-memory-schema-v5-");
  const databasePath = path.join(root, "memory.db");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  for (const migration of MIGRATIONS.filter((item) => item.version <= 5)) {
    legacy.exec(migration.sql);
    legacy.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(migration.version, migration.name, "2026-08-01T00:00:00.000Z");
  }
  legacy.prepare(`
    INSERT INTO memory_ingestion_decisions (
      id, agent_id, batch_id, candidate_index, decision,
      result_status, review_state, reason_codes_json,
      candidate_json, source_refs_json, memory_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, 0, 'review', 'review', 'pending', ?, ?, ?, NULL, ?, ?)
  `).run(
    "legacy-review",
    "agent-test",
    "legacy-batch",
    '["unknown-subject"]',
    '{"kind":"event"}',
    '["M0001"]',
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
  );
  legacy.close();

  const migrated = openMemoryDatabase(databasePath);
  assert.equal(databaseInfo(migrated).schemaVersion, SCHEMA_VERSION);
  const decision = new MemoryRepository(migrated)
    .getIngestionDecision("agent-test", "legacy-review");
  assert.equal(decision.review_state, "pending");
  assert.deepEqual(decision.reasonCodes, ["unknown-subject"]);
  assert.deepEqual(decision.sourceIds, []);
  assert.deepEqual(decision.resolvedCandidate, {});
  assert.equal(decision.resolved_at, null);
  migrated.close();
});

test("upgrades schema v10 shadow audits without treating incomplete legacy rows as applicable", () => {
  const root = temporaryDirectory("suzu-memory-schema-v10-");
  const databasePath = path.join(root, "memory.db");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec("PRAGMA foreign_keys = ON");
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  for (const migration of MIGRATIONS.filter((item) => item.version <= 10)) {
    legacy.exec(migration.sql);
    legacy.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(migration.version, migration.name, "2026-08-02T00:00:00.000Z");
  }
  legacy.prepare(`
    INSERT INTO memory_nodes (
      id, agent_id, kind, layer, content, recorded_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "legacy-shadow-memory",
    "agent-test",
    "event",
    "episodic",
    "旧版影子候选。",
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
  );
  const inputHash = createHash("sha256").update("legacy-shadow-input").digest("hex");
  legacy.prepare(`
    INSERT INTO memory_plasticity_shadow_runs (
      id, agent_id, policy_version, observation_window_id,
      window_start, window_end, input_hash, candidate_count,
      metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, '{}', ?)
  `).run(
    "legacy-shadow-run",
    "agent-test",
    "legacy-combined-policy",
    "legacy-window",
    "2026-08-01T00:00:00.000Z",
    "2026-08-02T00:00:00.000Z",
    inputHash,
    "2026-08-02T00:05:00.000Z",
  );
  legacy.prepare(`
    INSERT INTO memory_plasticity_shadow_changes (
      id, run_id, agent_id, target_type, target_id, learning_target,
      intent_view, evidence_class, evidence_tier, candidate_direction,
      current_value, decayed_value, positive_step, negative_step,
      proposed_value, blocked, block_reason, evidence_json, created_at
    ) VALUES (?, ?, ?, 'memory', ?, 'accessibility', '', ?, ?, ?, ?, ?, ?, ?, ?, 0, '', '{}', ?)
  `).run(
    "legacy-shadow-change",
    "legacy-shadow-run",
    "agent-test",
    "legacy-shadow-memory",
    "exposure-only",
    "weak",
    "increase",
    0.5,
    0.49,
    0.01,
    0,
    0.5,
    "2026-08-02T00:05:00.000Z",
  );
  legacy.close();

  const migrated = openMemoryDatabase(databasePath);
  assert.equal(databaseInfo(migrated).schemaVersion, SCHEMA_VERSION);
  const repository = new MemoryRepository(migrated);
  const run = repository.getPlasticityShadowRun("agent-test", "legacy-shadow-run");
  assert.equal(run.changes[0].targetPolicyVersion, "");
  assert.equal(run.changes[0].baseState.exists, false);
  assert.throws(() => repository.applyPlasticityShadowRun({
    agentId: "agent-test",
    runId: run.id,
    expectedInputHash: inputHash,
    actor: "human:test",
    appliedAt: "2026-08-02T00:10:00.000Z",
  }), /no target policy version/u);
  assert.equal(repository.listPlasticityApplications("agent-test").length, 0);
  migrated.close();
});

test("upgrades schema v16 without guessing state families from legacy content", () => {
  const root = temporaryDirectory("suzu-memory-schema-v16-");
  const databasePath = path.join(root, "memory.db");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec("PRAGMA foreign_keys = ON");
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  for (const migration of MIGRATIONS.filter((item) => item.version <= 16)) {
    legacy.exec(migration.sql);
    legacy.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(migration.version, migration.name, "2026-08-02T00:00:00.000Z");
  }
  const insertLegacyNode = legacy.prepare(`
    INSERT INTO memory_nodes (
      id, agent_id, kind, layer, content, recorded_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertLegacyNode.run(
    "legacy-event-with-preference-word",
    "agent-test",
    "event",
    "episodic",
    "用户说过自己喜欢围棋，但这仍然只是一条旧事件。",
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
  );
  insertLegacyNode.run(
    "legacy-stateful-fact",
    "agent-test",
    "fact",
    "semantic",
    "用户会写 Node.js 脚本。",
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
  );
  legacy.close();

  const migrated = openMemoryDatabase(databasePath);
  assert.equal(databaseInfo(migrated).schemaVersion, SCHEMA_VERSION);
  const repository = new MemoryRepository(migrated);
  const event = repository.getMemory("legacy-event-with-preference-word");
  const stateful = repository.getMemory("legacy-stateful-fact");
  assert.equal(event.state_family, "not_applicable");
  assert.equal(event.state_phase, "not_applicable");
  assert.equal(stateful.state_family, "unspecified");
  assert.equal(stateful.state_phase, "unspecified");
  migrated.close();
});

test("upgrades schema v18 with deterministic root scopes and preserves pending proposals", () => {
  const root = temporaryDirectory("suzu-memory-schema-v18-");
  const databasePath = path.join(root, "memory.db");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec("PRAGMA foreign_keys = ON");
  legacy.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  for (const migration of MIGRATIONS.filter((item) => item.version <= 18)) {
    legacy.exec(migration.sql);
    legacy.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(migration.version, migration.name, "2026-08-02T00:00:00.000Z");
  }
  const insertNode = legacy.prepare(`
    INSERT INTO memory_nodes (
      id, agent_id, kind, layer, content, recorded_at, created_at, updated_at,
      subject_role, subject_key, canonical_key, representation_layer,
      state_family, state_phase, temporal_state
    ) VALUES (?, 'agent-test', ?, ?, ?, '2026-08-02T00:00:00.000Z',
      '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z',
      ?, ?, ?, ?, ?, ?, ?)
  `);
  insertNode.run(
    "v18-event",
    "event",
    "episodic",
    "一条普通事件。",
    "user",
    "user",
    "",
    "unspecified",
    "not_applicable",
    "not_applicable",
    "historical",
  );
  insertNode.run(
    "v18-reported-belief",
    "belief_state",
    "semantic",
    "用户报告自己喜欢安静的雨天。",
    "user",
    "user",
    "user:belief:rain",
    "reported",
    "belief",
    "active",
    "current",
  );
  legacy.prepare(`
    INSERT INTO memory_reported_state_proposals (
      id, agent_id, state_family, subject_role, subject_key, canonical_key,
      action, previous_memory_id, proposed_kind, state_phase, temporal_state,
      draft_json, review_version, input_hash, proposal_hash, metadata_json,
      created_at, updated_at
    ) VALUES (
      'v18-pending', 'agent-test', 'belief', 'user', 'user', 'user:belief:rain',
      'reinforce', 'v18-reported-belief', 'belief_state', 'active', 'current',
      '{}', 'legacy-review-v1', 'legacy-input', 'legacy-proposal', '{}',
      '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'
    )
  `).run();
  legacy.close();

  const migrated = openMemoryDatabase(databasePath);
  assert.equal(databaseInfo(migrated).schemaVersion, SCHEMA_VERSION);
  const repository = new MemoryRepository(migrated);
  assert.equal(repository.getMemory("v18-event").state_scope_key, "not_applicable");
  assert.equal(repository.getMemory("v18-reported-belief").state_scope_key, "root");
  const proposal = repository.getReportedStateProposal("agent-test", "v18-pending");
  assert.equal(proposal.targetScopeKey, "root");
  assert.equal(proposal.proposedScopeKey, "root");
  assert.equal(proposal.review_state, "pending");
  migrated.close();
});

test("expands a typed memory graph without crossing Agent boundaries", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  for (const id of ["plan", "visit", "robots", "other-agent"]) {
    repository.upsertMemory({
      id,
      agentId: id === "other-agent" ? "agent-other" : "agent-test",
      kind: "event",
      layer: "episodic",
      content: `memory ${id}`,
    });
  }
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "plan",
    toMemoryId: "visit",
    relation: "led_to",
    weight: 0.9,
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "visit",
    toMemoryId: "robots",
    relation: "about_same_topic",
    direction: "undirected",
    weight: 0.8,
  });

  const result = repository.expand("agent-test", ["plan"], {
    maxDepth: 2,
    maxNodes: 10,
  });
  assert.deepEqual(
    result.nodes.map((node) => node.id).sort(),
    ["plan", "robots", "visit"],
  );
  assert.equal(result.edges.length, 2);
  database.close();
});

test("builds semantic and directional timeline links between event memories", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  for (const value of [
    {
      id: "museum-visit",
      content: "去了科技馆看机器人展。",
      eventDate: "2026-07-01",
      vector: [1, 0],
    },
    {
      id: "museum-followup",
      content: "后来继续聊科技馆里的机器人。",
      eventDate: "2026-07-05",
      vector: [0.98, 0.2],
    },
    {
      id: "unrelated-breakfast",
      content: "早餐吃了面包。",
      eventDate: "2026-07-06",
      vector: [0, 1],
    },
  ]) {
    repository.upsertMemory({
      id: value.id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content: value.content,
      eventDate: value.eventDate,
    });
    repository.upsertEmbedding({
      memoryId: value.id,
      model: "embedding-test",
      vector: value.vector,
    });
  }
  const first = rebuildAssociationGraph({ repository, agentId: "agent-test" });
  const second = rebuildAssociationGraph({ repository, agentId: "agent-test" });
  assert.equal(first.associationEdges, 1);
  assert.equal(first.timelineEdges, 1);
  assert.equal(second.totalEdges, first.totalEdges);
  assert.equal(
    Number(database.prepare(`
      SELECT COUNT(*) AS count FROM memory_edges
      WHERE relation = 'associated_with'
        AND (
          (from_memory_id = 'museum-visit' AND to_memory_id = 'museum-followup')
          OR
          (from_memory_id = 'museum-followup' AND to_memory_id = 'museum-visit')
        )
    `).get().count),
    1,
  );
  assert.equal(
    database.prepare(`
      SELECT to_memory_id FROM memory_edges
      WHERE from_memory_id = 'museum-visit' AND relation = 'timeline_next'
    `).get().to_memory_id,
    "museum-followup",
  );
  database.close();
});

test("connects memories through a shared entity without building a full clique", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const entity = repository.upsertEntity({
    agentId: "agent-test",
    kind: "place",
    canonicalName: "上海科技馆",
    aliases: ["科技馆"],
  });
  for (const [index, id] of ["museum-early", "museum-middle", "museum-late"].entries()) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content: `脱敏事件 ${index + 1}。`,
      recordedAt: `2026-07-0${index + 1}T08:00:00.000Z`,
    });
    repository.linkMemoryEntity({ memoryId: id, entityId: entity.id, role: "location" });
    if (index === 1) {
      repository.linkMemoryEntity({ memoryId: id, entityId: entity.id, role: "about" });
    }
  }
  const result = rebuildAssociationGraph({ repository, agentId: "agent-test" });
  assert.equal(result.entityEdges, 2);
  assert.equal(
    Number(database.prepare(`
      SELECT COUNT(*) AS count FROM memory_edges WHERE relation = 'shares_entity'
    `).get().count),
    2,
  );
  const edge = database.prepare(`
    SELECT * FROM memory_edges WHERE relation = 'shares_entity' ORDER BY id LIMIT 1
  `).get();
  const metadata = JSON.parse(edge.metadata_json);
  assert.equal(metadata.entities[0].entityId, entity.id);
  assert.equal(metadata.entities[0].canonicalName, "上海科技馆");
  database.close();
});

test("updates associations incrementally for a newly written event", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  repository.upsertMemory({
    id: "museum-before",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "去了科技馆看机器人展。",
    eventDate: "2026-07-01",
  });
  repository.upsertEmbedding({
    memoryId: "museum-before",
    model: "embedding-test",
    vector: [1, 0],
  });
  repository.upsertMemory({
    id: "museum-after",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "后来又聊起科技馆机器人展。",
    eventDate: "2026-07-03",
  });
  repository.upsertEmbedding({
    memoryId: "museum-after",
    model: "embedding-test",
    vector: [0.99, 0.1],
  });
  const result = updateAssociationGraph({
    repository,
    agentId: "agent-test",
    memoryIds: ["museum-after"],
  });
  assert.equal(result.memoriesConsidered, 1);
  assert.equal(result.associationEdges, 1);
  assert.equal(result.timelineEdges, 1);
  assert.equal(
    database.prepare(`
      SELECT to_memory_id FROM memory_edges
      WHERE from_memory_id = 'museum-before' AND relation = 'timeline_next'
    `).get().to_memory_id,
    "museum-after",
  );
  database.close();
});

test("keeps automatic threads event-only and makes incremental insertion match a rebuild", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  for (const value of [
    { id: "thread-old", eventStart: "2026-07-01T08:00:00.000Z" },
    { id: "thread-new", eventStart: "2026-07-03T08:00:00.000Z" },
  ]) {
    repository.upsertMemory({
      id: value.id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content: `事件线程 ${value.id}`,
      canonicalKey: "trip:science-museum",
      eventStart: value.eventStart,
      recordedAt: value.id === "thread-old"
        ? "2026-07-20T08:00:00.000Z"
        : "2026-07-10T08:00:00.000Z",
    });
  }
  for (const value of [
    { id: "state-reported", representationLayer: "reported", validFrom: "2026-07-01T00:00:00.000Z" },
    { id: "state-inferred", representationLayer: "inferred", validFrom: "2026-07-02T00:00:00.000Z" },
  ]) {
    repository.upsertMemory({
      id: value.id,
      agentId: "agent-test",
      kind: "preference",
      layer: "semantic",
      content: `偏好状态 ${value.id}`,
      subjectRole: "user",
      subjectKey: "user:owner",
      canonicalKey: "preference:fish",
      representationLayer: value.representationLayer,
      stateFamily: "preference",
      statePhase: "active",
      temporalState: "current",
      validFrom: value.validFrom,
      eventStart: value.validFrom,
    });
  }

  rebuildAssociationGraph({ repository, agentId: "agent-test" });
  assert.deepEqual(database.prepare(`
    SELECT from_memory_id, to_memory_id
    FROM memory_edges
    WHERE provenance = 'association-builder-v1' AND relation = 'same_thread'
    ORDER BY from_memory_id, to_memory_id
  `).all().map((row) => [row.from_memory_id, row.to_memory_id]), [
    ["thread-old", "thread-new"],
  ]);

  repository.upsertMemory({
    id: "thread-middle",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "事件线程 thread-middle",
    canonicalKey: "trip:science-museum",
    eventStart: "2026-07-02T08:00:00.000Z",
    recordedAt: "2026-07-21T08:00:00.000Z",
  });
  const incremental = updateAssociationGraph({
    repository,
    agentId: "agent-test",
    memoryIds: ["thread-middle"],
  });
  assert.equal(incremental.threadEdges, 2);
  const incrementalEdges = database.prepare(`
    SELECT from_memory_id, to_memory_id
    FROM memory_edges
    WHERE provenance = 'association-builder-v1' AND relation = 'same_thread'
    ORDER BY from_memory_id, to_memory_id
  `).all().map((row) => [row.from_memory_id, row.to_memory_id]);
  assert.deepEqual(incrementalEdges, [
    ["thread-middle", "thread-new"],
    ["thread-old", "thread-middle"],
  ]);

  rebuildAssociationGraph({ repository, agentId: "agent-test" });
  assert.deepEqual(database.prepare(`
    SELECT from_memory_id, to_memory_id
    FROM memory_edges
    WHERE provenance = 'association-builder-v1' AND relation = 'same_thread'
    ORDER BY from_memory_id, to_memory_id
  `).all().map((row) => [row.from_memory_id, row.to_memory_id]), incrementalEdges);
  database.close();
});

test("orders shared-entity adjacency by state validity instead of import time", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const entity = repository.upsertEntity({
    agentId: "agent-test",
    kind: "person",
    canonicalName: "用户",
  });
  for (const value of [
    { id: "z-old", validFrom: "2026-07-01T00:00:00.000Z", recordedAt: "2026-07-30T00:00:00.000Z" },
    { id: "a-middle", validFrom: "2026-07-10T00:00:00.000Z", recordedAt: "2026-07-01T00:00:00.000Z" },
    { id: "m-new", validFrom: "2026-07-20T00:00:00.000Z", recordedAt: "2026-07-10T00:00:00.000Z" },
  ]) {
    repository.upsertMemory({
      id: value.id,
      agentId: "agent-test",
      kind: "preference",
      layer: "semantic",
      content: `状态 ${value.id}`,
      subjectRole: "user",
      subjectKey: "user:owner",
      canonicalKey: `preference:${value.id}`,
      representationLayer: "inferred",
      stateFamily: "preference",
      statePhase: "active",
      temporalState: "current",
      validFrom: value.validFrom,
      recordedAt: value.recordedAt,
    });
    repository.linkMemoryEntity({ memoryId: value.id, entityId: entity.id, role: "subject" });
  }

  rebuildAssociationGraph({ repository, agentId: "agent-test" });
  assert.deepEqual(database.prepare(`
    SELECT from_memory_id, to_memory_id
    FROM memory_edges
    WHERE provenance = 'association-builder-v1' AND relation = 'shares_entity'
    ORDER BY from_memory_id, to_memory_id
  `).all().map((row) => [row.from_memory_id, row.to_memory_id]), [
    ["a-middle", "m-new"],
    ["a-middle", "z-old"],
  ]);
  database.close();
});

test("rebuilds shared-entity adjacency when an incremental memory enters the middle", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const entity = repository.upsertEntity({
    agentId: "agent-test",
    kind: "place",
    canonicalName: "科技馆",
  });
  for (const value of [
    { id: "entity-old", eventDate: "2026-07-01" },
    { id: "entity-new", eventDate: "2026-07-03" },
  ]) {
    repository.upsertMemory({
      id: value.id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content: `实体链 ${value.id}`,
      eventDate: value.eventDate,
    });
    repository.linkMemoryEntity({ memoryId: value.id, entityId: entity.id, role: "location" });
  }
  rebuildAssociationGraph({ repository, agentId: "agent-test" });

  repository.upsertMemory({
    id: "entity-middle",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "实体链 entity-middle",
    eventDate: "2026-07-02",
  });
  repository.linkMemoryEntity({
    memoryId: "entity-middle",
    entityId: entity.id,
    role: "location",
  });
  updateAssociationGraph({
    repository,
    agentId: "agent-test",
    memoryIds: ["entity-middle"],
  });

  assert.deepEqual(database.prepare(`
    SELECT from_memory_id, to_memory_id
    FROM memory_edges
    WHERE provenance = 'association-builder-v1' AND relation = 'shares_entity'
    ORDER BY from_memory_id, to_memory_id
  `).all().map((row) => [row.from_memory_id, row.to_memory_id]), [
    ["entity-middle", "entity-new"],
    ["entity-middle", "entity-old"],
  ]);
  database.close();
});

test("enforces a real degree cap on automatic semantic associations", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  for (let index = 0; index < 6; index += 1) {
    const id = `dense-event-${index}`;
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content: `共同主题事件 ${index}`,
      eventDate: `2026-07-${String(index + 1).padStart(2, "0")}`,
    });
    repository.upsertEmbedding({
      memoryId: id,
      model: "embedding-test",
      vector: [1, 0],
    });
  }

  const result = rebuildAssociationGraph({
    repository,
    agentId: "agent-test",
    options: { maximumAssociationsPerNode: 2 },
  });
  const maximumDegree = Number(database.prepare(`
    SELECT MAX(degree) AS maximum_degree
    FROM (
      SELECT memory_id, COUNT(*) AS degree
      FROM (
        SELECT from_memory_id AS memory_id
        FROM memory_edges
        WHERE provenance = 'association-builder-v1' AND relation = 'associated_with'
        UNION ALL
        SELECT to_memory_id AS memory_id
        FROM memory_edges
        WHERE provenance = 'association-builder-v1' AND relation = 'associated_with'
      )
      GROUP BY memory_id
    )
  `).get().maximum_degree || 0);
  assert.ok(result.associationEdges > 0);
  assert.ok(maximumDegree <= 2);
  database.close();
});

test("keeps structured states out of automatic semantic and timeline edges", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  for (const id of ["event-about-fish", "state-about-fish"]) {
    const stateful = id.startsWith("state");
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: stateful ? "preference" : "event",
      layer: stateful ? "semantic" : "episodic",
      content: "很喜欢吃鱼。",
      subjectRole: stateful ? "user" : "unknown",
      subjectKey: stateful ? "user:owner" : "",
      canonicalKey: stateful ? "preference:fish" : "event:fish",
      representationLayer: stateful ? "reported" : "unspecified",
      stateFamily: stateful ? "preference" : "not_applicable",
      statePhase: stateful ? "active" : "not_applicable",
      temporalState: stateful ? "current" : "historical",
      validFrom: stateful ? "2026-07-01T00:00:00.000Z" : null,
      eventDate: "2026-07-01",
    });
    repository.upsertEmbedding({
      memoryId: id,
      model: "embedding-test",
      vector: [1, 0],
    });
  }

  rebuildAssociationGraph({ repository, agentId: "agent-test" });
  assert.equal(Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_edges
    WHERE provenance = 'association-builder-v1'
      AND relation IN ('associated_with', 'timeline_next')
      AND (from_memory_id = 'state-about-fish' OR to_memory_id = 'state-about-fish')
  `).get().count), 0);
  database.close();
});

test("prunes legacy automatic association overflow during an incremental update", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const oldIds = ["legacy-a", "legacy-b", "legacy-c", "legacy-d"];
  for (const id of [...oldIds, "a-new-seed"]) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content: `同一主题 ${id}`,
      eventDate: "2026-07-01",
    });
    repository.upsertEmbedding({
      memoryId: id,
      model: "embedding-test",
      vector: [1, 0],
    });
  }
  for (let left = 0; left < oldIds.length; left += 1) {
    for (let right = left + 1; right < oldIds.length; right += 1) {
      repository.upsertEdge({
        agentId: "agent-test",
        fromMemoryId: oldIds[left],
        toMemoryId: oldIds[right],
        relation: "associated_with",
        direction: "undirected",
        weight: 0.7,
        confidence: 0.7,
        provenance: "association-builder-v1",
      });
    }
  }

  const result = updateAssociationGraph({
    repository,
    agentId: "agent-test",
    memoryIds: ["a-new-seed"],
    options: { maximumAssociationsPerNode: 2 },
  });
  const maximumDegree = Number(database.prepare(`
    SELECT MAX(degree) AS maximum_degree
    FROM (
      SELECT memory_id, COUNT(*) AS degree
      FROM (
        SELECT from_memory_id AS memory_id
        FROM memory_edges
        WHERE provenance = 'association-builder-v1' AND relation = 'associated_with'
        UNION ALL
        SELECT to_memory_id AS memory_id
        FROM memory_edges
        WHERE provenance = 'association-builder-v1' AND relation = 'associated_with'
      )
      GROUP BY memory_id
    )
  `).get().maximum_degree || 0);
  assert.ok(result.prunedAssociationEdges > 0);
  assert.ok(maximumDegree <= 2);
  database.close();
});

test("supports audited manual edits, soft deletion, and restoration", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  repository.upsertMemory({
    id: "manual-memory",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "错误地点",
    content: "去了错误的地点。",
    eventDate: "2026-07-01",
  });
  repository.upsertMemory({
    id: "related-memory",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "一条相关记忆。",
  });
  repository.upsertEmbedding({
    memoryId: "manual-memory",
    model: "embedding-test",
    vector: [1, 0],
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "manual-memory",
    toMemoryId: "related-memory",
    relation: "associated_with",
    direction: "undirected",
    provenance: "association-builder-v1",
  });

  const edited = repository.editMemoryManually({
    agentId: "agent-test",
    memoryId: "manual-memory",
    patch: {
      title: "正确地点",
      content: "那天实际去了水族馆。",
      eventDate: "2026-07-02",
    },
    actor: "human:test",
    reason: "原地点有误",
  });
  assert.equal(edited.title, "正确地点");
  assert.equal(edited.event_date, "2026-07-02");
  assert.equal(edited.evidence_mode, "manual");
  assert.equal(repository.search("agent-test", "水族馆")[0].id, "manual-memory");
  assert.equal(
    Number(database.prepare(`
      SELECT COUNT(*) AS count FROM memory_embeddings
      WHERE memory_id = 'manual-memory'
    `).get().count),
    0,
  );
  assert.equal(
    Number(database.prepare(`
      SELECT COUNT(*) AS count FROM memory_edges
      WHERE provenance = 'association-builder-v1'
        AND (from_memory_id = 'manual-memory' OR to_memory_id = 'manual-memory')
    `).get().count),
    0,
  );
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "related-memory",
    toMemoryId: "manual-memory",
    relation: "supported_by",
    provenance: "human-test",
  });

  repository.setMemoryDeleted({
    agentId: "agent-test",
    memoryId: "manual-memory",
    deleted: true,
    actor: "human:test",
  });
  assert.equal(repository.search("agent-test", "水族馆").length, 0);
  assert.deepEqual(
    repository.expand("agent-test", ["related-memory"]).nodes.map((node) => node.id),
    ["related-memory"],
  );
  assert.equal(repository.listMemories("agent-test").items.length, 1);
  assert.equal(
    repository.listMemories("agent-test", { statuses: ["deleted"] }).items[0].id,
    "manual-memory",
  );

  repository.setMemoryDeleted({
    agentId: "agent-test",
    memoryId: "manual-memory",
    deleted: false,
    actor: "human:test",
  });
  assert.equal(repository.search("agent-test", "水族馆")[0].id, "manual-memory");
  const detail = repository.getMemoryDetail("agent-test", "manual-memory");
  assert.deepEqual(
    detail.mutations.map((mutation) => mutation.action),
    ["restore", "delete", "edit"],
  );
  assert.equal(detail.mutations[2].before.content, "去了错误的地点。");
  assert.equal(detail.mutations[2].after.content, "那天实际去了水族馆。");
  assert.equal(repository.getMemoryDetail("agent-other", "manual-memory"), null);
  database.close();
});

test("models episodes and topics as overlapping big neurons with Agent isolation", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const museum = repository.upsertMemory({
    id: "member-museum",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户参观了科技馆。",
    eventStart: "2026-07-11T03:00:00.000Z",
  });
  const dinner = repository.upsertMemory({
    id: "member-dinner",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "两个人后来一起吃了晚饭。",
    eventStart: "2026-07-11T10:00:00.000Z",
  });
  const weekend = repository.upsertEpisode({
    id: "episode-weekend",
    agentId: "agent-test",
    title: "周末出行",
    content: "同一次周末出行中的连续经历。",
    eventStart: "2026-07-11T03:00:00.000Z",
    eventEnd: "2026-07-11T12:00:00.000Z",
  });
  const summer = repository.upsertEpisode({
    id: "episode-summer",
    agentId: "agent-test",
    title: "夏日活动",
    content: "这个夏天的重要外出活动。",
    eventDate: "2026-07-11",
  });
  const science = repository.upsertTopic({
    id: "topic-science",
    agentId: "agent-test",
    title: "科学展览",
    content: "与科学展览和科技体验有关的长期主题。",
  });
  const sharedTime = repository.upsertTopic({
    id: "topic-shared-time",
    agentId: "agent-test",
    title: "共同外出",
    content: "双方共同外出经历形成的长期主题。",
  });

  repository.linkMemoryToEpisode({
    agentId: "agent-test",
    memoryId: museum.id,
    episodeId: weekend.id,
  });
  repository.linkMemoryToEpisode({
    agentId: "agent-test",
    memoryId: dinner.id,
    episodeId: weekend.id,
  });
  repository.linkMemoryToEpisode({
    agentId: "agent-test",
    memoryId: museum.id,
    episodeId: summer.id,
  });
  repository.linkMemoryToTopic({
    agentId: "agent-test",
    memoryId: museum.id,
    topicId: science.id,
  });
  repository.linkMemoryToTopic({
    agentId: "agent-test",
    memoryId: museum.id,
    topicId: sharedTime.id,
  });
  repository.linkMemoryToTopic({
    agentId: "agent-test",
    memoryId: weekend.id,
    topicId: sharedTime.id,
  });

  assert.equal(weekend.kind, "episode");
  assert.equal(weekend.layer, "episodic");
  assert.equal(science.kind, "topic");
  assert.equal(science.layer, "semantic");
  assert.deepEqual(
    repository.listEpisodeMembers({
      agentId: "agent-test",
      episodeId: weekend.id,
    }).map((memory) => memory.id),
    [museum.id, dinner.id],
  );
  assert.deepEqual(
    repository.listTopicMembers({
      agentId: "agent-test",
      topicId: sharedTime.id,
    }).map((memory) => memory.id).sort(),
    [museum.id, weekend.id].sort(),
  );
  assert.equal(
    repository.listEpisodeMembers({
      agentId: "agent-test",
      episodeId: summer.id,
    })[0].membership.relation,
    "part_of_episode",
  );
  assert.equal(
    repository.listTopicMembers({
      agentId: "agent-test",
      topicId: science.id,
    })[0].membership.relation,
    "supports_topic",
  );
  rebuildAssociationGraph({ repository, agentId: "agent-test" });
  assert.equal(Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_edges AS edge
    JOIN memory_nodes AS source ON source.id = edge.from_memory_id
    JOIN memory_nodes AS target ON target.id = edge.to_memory_id
    WHERE edge.provenance = 'association-builder-v1'
      AND (
        source.kind IN ('episode', 'topic', 'topic_or_episode')
        OR target.kind IN ('episode', 'topic', 'topic_or_episode')
      )
  `).get().count), 0);

  const otherTopic = repository.upsertTopic({
    id: "other-agent-topic",
    agentId: "agent-other",
    content: "另一个 Agent 的主题。",
  });
  assert.throws(() => repository.linkMemoryToTopic({
    agentId: "agent-test",
    memoryId: museum.id,
    topicId: otherTopic.id,
  }), /for this Agent/u);
  assert.throws(() => repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: museum.id,
    toMemoryId: otherTopic.id,
    relation: "associated_with",
  }), /same Agent/u);
  assert.throws(() => repository.upsertMemory({
    id: museum.id,
    agentId: "agent-other",
    kind: "event",
    layer: "episodic",
    content: "不得覆盖另一个 Agent 的节点。",
  }), /another Agent/u);

  assert.equal(repository.unlinkMemoryFromTopic({
    agentId: "agent-test",
    memoryId: museum.id,
    topicId: science.id,
  }), 1);
  assert.equal(repository.listTopicMembers({
    agentId: "agent-test",
    topicId: science.id,
  }).length, 0);
  database.close();
});

test("rejects ambiguous episode time and event time on semantic topics", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  assert.throws(() => repository.upsertEpisode({
    agentId: "agent-test",
    content: "没有时间边界的事件簇。",
  }), /requires eventDate or eventStart/u);
  assert.throws(() => repository.upsertEpisode({
    agentId: "agent-test",
    content: "倒置时间的事件簇。",
    eventStart: "2026-07-12T03:00:00.000Z",
    eventEnd: "2026-07-11T03:00:00.000Z",
  }), /cannot be before/u);
  assert.throws(() => repository.upsertEpisode({
    agentId: "agent-test",
    content: "不存在的日期。",
    eventDate: "2026-02-30",
  }), /valid YYYY-MM-DD/u);
  assert.throws(() => repository.upsertTopic({
    agentId: "agent-test",
    content: "主题不冒充事件。",
    eventDate: "2026-07-11",
  }), /cannot carry event time/u);
  database.close();
});

test("keeps structural proposals pending until an explicit acceptance", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  for (const [id, content, eventStart] of [
    ["proposal-museum", "用户参观了科技馆。", "2026-07-11T03:00:00.000Z"],
    ["proposal-dinner", "两个人随后一起吃了晚饭。", "2026-07-11T10:00:00.000Z"],
  ]) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content,
      eventStart,
    });
  }
  const proposal = proposeMemoryStructure(repository, {
    agentId: "agent-test",
    batchId: "batch-1",
    kind: "episode",
    title: "周末出行",
    content: "同一次周末出行中的连续经历。",
    subjectRole: "shared",
    subjectKey: "agent-test:user",
    eventStart: "2026-07-11T03:00:00.000Z",
    eventEnd: "2026-07-11T12:00:00.000Z",
    memberIds: ["proposal-museum", "proposal-dinner"],
    actorRoles: [{
      role: "participant",
      actorRole: "user",
      actorKey: "user",
      confidence: 1,
    }],
    confidence: 0.86,
    rationale: "两个事件时间连续并且来自同一次外出。",
  });
  const duplicate = proposeMemoryStructure(repository, {
    agentId: "agent-test",
    batchId: "batch-2",
    kind: "episode",
    title: "周末出行",
    content: "同一次周末出行中的连续经历。",
    subjectRole: "shared",
    subjectKey: "agent-test:user",
    eventStart: "2026-07-11T03:00:00.000Z",
    eventEnd: "2026-07-11T12:00:00.000Z",
    memberIds: ["proposal-dinner", "proposal-museum"],
    actorRoles: [{
      role: "participant",
      actorRole: "user",
      actorKey: "user",
      confidence: 1,
    }],
    confidence: 0.86,
    rationale: "重复提议不应新建第二条。",
  });
  assert.equal(duplicate.id, proposal.id);
  assert.equal(proposal.wasInserted, true);
  assert.equal(duplicate.wasInserted, false);
  assert.equal(proposal.review_state, "pending");
  assert.equal(repository.listStructureProposals("agent-test", {
    reviewStates: ["pending"],
  }).length, 1);
  assert.equal(repository.listMemories("agent-test", { kinds: ["episode"] }).total, 0);

  const accepted = resolveMemoryStructureProposal(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    action: "accept",
    resolvedBy: "human:test",
    note: "确认属于同一次出行。",
  });
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.memory.kind, "episode");
  assert.equal(accepted.members.length, 2);
  assert.equal(accepted.proposal.result_memory_id, accepted.memory.id);
  assert.equal(accepted.proposal.resolved_by, "human:test");
  assert.equal(accepted.proposal.resolution_note, "确认属于同一次出行。");
  assert.deepEqual(
    repository.listMemoryRoles(accepted.memory.id).map((role) => role.role).sort(),
    ["participant", "subject"],
  );
  assert.throws(() => resolveMemoryStructureProposal(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    action: "accept",
  }), /already accepted/u);
  database.close();
});

test("audits dismissed proposals and rolls back a failed structural acceptance", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  for (const [id, agentId] of [
    ["rollback-a", "agent-test"],
    ["rollback-b", "agent-test"],
    ["foreign-member", "agent-other"],
  ]) {
    repository.upsertMemory({
      id,
      agentId,
      kind: "event",
      layer: "episodic",
      content: `候选成员 ${id}。`,
    });
  }
  assert.throws(() => proposeMemoryStructure(repository, {
    agentId: "agent-test",
    kind: "topic",
    content: "跨 Agent 的非法主题。",
    memberIds: ["rollback-a", "foreign-member"],
  }), /same Agent/u);

  const dismissed = proposeMemoryStructure(repository, {
    agentId: "agent-test",
    kind: "topic",
    content: "后来确认不应建立的主题。",
    memberIds: ["rollback-a", "rollback-b"],
  });
  const dismissal = resolveMemoryStructureProposal(repository, {
    agentId: "agent-test",
    proposalId: dismissed.id,
    action: "dismiss",
    resolvedBy: "human:test",
    note: "只是偶然同时提到。",
  });
  assert.equal(dismissal.proposal.review_state, "dismissed");
  assert.equal(repository.listMemories("agent-test", { kinds: ["topic"] }).total, 0);

  const rollback = proposeMemoryStructure(repository, {
    agentId: "agent-test",
    kind: "episode",
    content: "用于验证失败回滚的事件簇。",
    eventDate: "2026-07-11",
    memberIds: ["rollback-a", "rollback-b"],
  });
  const originalLink = repository.linkMemoryToEpisode.bind(repository);
  let links = 0;
  repository.linkMemoryToEpisode = (input) => {
    links += 1;
    if (links === 2) throw new Error("simulated membership failure");
    return originalLink(input);
  };
  assert.throws(() => resolveMemoryStructureProposal(repository, {
    agentId: "agent-test",
    proposalId: rollback.id,
    action: "accept",
  }), /simulated membership failure/u);
  repository.linkMemoryToEpisode = originalLink;
  assert.equal(repository.getStructureProposal("agent-test", rollback.id).review_state, "pending");
  assert.equal(repository.listMemories("agent-test", { kinds: ["episode"] }).total, 0);

  repository.setMemoryDeleted({
    agentId: "agent-test",
    memoryId: "rollback-b",
    deleted: true,
  });
  assert.throws(() => resolveMemoryStructureProposal(repository, {
    agentId: "agent-test",
    proposalId: rollback.id,
    action: "accept",
  }), /Deleted memories/u);
  assert.equal(repository.getStructureProposal("agent-test", rollback.id).review_state, "pending");
  database.close();
});

test("attaches new members to existing big neurons without rewriting them", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  for (const [id, content, eventStart] of [
    ["attach-early", "上午出发去科技馆。", "2026-07-11T02:00:00.000Z"],
    ["attach-middle", "在科技馆参观航天展。", "2026-07-11T05:00:00.000Z"],
    ["attach-late", "晚上聊起航天展。", "2026-07-11T12:00:00.000Z"],
  ]) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content,
      eventStart,
    });
  }
  const episode = repository.upsertEpisode({
    id: "existing-episode",
    agentId: "agent-test",
    title: "科技馆之行",
    content: "一次已经存在的科技馆出行。",
    eventStart: "2026-07-11T05:00:00.000Z",
  });
  repository.linkMemoryToEpisode({
    agentId: "agent-test",
    memoryId: "attach-middle",
    episodeId: episode.id,
  });
  const topic = repository.upsertTopic({
    id: "existing-topic",
    agentId: "agent-test",
    title: "航天兴趣",
    content: "与航天有关的长期兴趣线索。",
  });
  repository.linkMemoryToTopic({
    agentId: "agent-test",
    memoryId: "attach-middle",
    topicId: topic.id,
  });

  const episodeProposal = proposeMemoryStructure(repository, {
    agentId: "agent-test",
    operation: "attach",
    targetMemoryId: episode.id,
    kind: "episode",
    content: "模型试图改写的内容不会被采用。",
    memberIds: ["attach-middle", "attach-early", "attach-late"],
    confidence: 0.82,
  });
  assert.equal(episodeProposal.operation, "attach");
  assert.equal(episodeProposal.targetMemoryId, episode.id);
  assert.equal(episodeProposal.content, episode.content);
  assert.deepEqual(episodeProposal.memberIds.sort(), ["attach-early", "attach-late"]);
  const episodeResult = resolveMemoryStructureProposal(repository, {
    agentId: "agent-test",
    proposalId: episodeProposal.id,
    action: "accept",
  });
  assert.equal(episodeResult.memory.id, episode.id);
  assert.equal(episodeResult.memory.content, episode.content);
  assert.equal(episodeResult.memory.event_start, "2026-07-11T02:00:00.000Z");
  assert.equal(episodeResult.memory.event_end, "2026-07-11T12:00:00.000Z");
  assert.deepEqual(episodeResult.addedMemberIds.sort(), ["attach-early", "attach-late"]);
  assert.equal(repository.listEpisodeMembers({
    agentId: "agent-test",
    episodeId: episode.id,
  }).length, 3);

  const topicProposal = proposeMemoryStructure(repository, {
    agentId: "agent-test",
    operation: "attach",
    targetMemoryId: topic.id,
    kind: "topic",
    memberIds: ["attach-late"],
  });
  const topicResult = resolveMemoryStructureProposal(repository, {
    agentId: "agent-test",
    proposalId: topicProposal.id,
    action: "accept",
  });
  assert.equal(topicResult.memory.id, topic.id);
  assert.deepEqual(topicResult.addedMemberIds, ["attach-late"]);
  assert.equal(repository.listTopicMembers({
    agentId: "agent-test",
    topicId: topic.id,
  }).length, 2);
  assert.throws(() => proposeMemoryStructure(repository, {
    agentId: "agent-test",
    operation: "attach",
    targetMemoryId: topic.id,
    kind: "topic",
    memberIds: ["attach-middle", "attach-late"],
  }), /at least one new member/u);
  assert.throws(() => proposeMemoryStructure(repository, {
    agentId: "agent-test",
    operation: "attach",
    targetMemoryId: episode.id,
    kind: "topic",
    memberIds: ["attach-late"],
  }), /active topic/u);
  database.close();
});
