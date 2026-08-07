import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DIRECT_USER_AGENT_DM_TOPOLOGY,
  chooseCompactionPlan,
  buildArchivedUtteranceIdentity,
  MEMORY_COMPACTION_SCHEMA,
  parseGeneratedCompaction,
  parseJsonlText,
  reconstructLogicalContext,
  runMemoryCompactorCli,
  runCompaction,
} from "../src/index.mjs";
import {
  MemoryRepository,
  openMemoryDatabase,
} from "@suzu-lives/memory-core";

test("adds the fixed counterpart only for an explicitly confirmed direct user-agent DM", () => {
  const userUtterance = buildArchivedUtteranceIdentity({
    messageRole: "user",
    agentId: "agent-test",
    conversationTopology: DIRECT_USER_AGENT_DM_TOPOLOGY,
  });
  assert.deepEqual(
    userUtterance.actorRoles.map(({ role, actorRole, actorKey }) => ({ role, actorRole, actorKey })),
    [
      { role: "speaker", actorRole: "user", actorKey: "user" },
      { role: "participant", actorRole: "agent", actorKey: "agent-test" },
    ],
  );

  const assistantUtterance = buildArchivedUtteranceIdentity({
    messageRole: "assistant",
    agentId: "agent-test",
    conversationTopology: DIRECT_USER_AGENT_DM_TOPOLOGY,
  });
  assert.deepEqual(
    assistantUtterance.actorRoles.map(({ role, actorRole, actorKey }) => ({ role, actorRole, actorKey })),
    [
      { role: "speaker", actorRole: "agent", actorKey: "agent-test" },
      { role: "participant", actorRole: "user", actorKey: "user" },
    ],
  );
});

test("does not invent an utterance participant without DM topology or for an unknown role", () => {
  const withoutTopology = buildArchivedUtteranceIdentity({
    messageRole: "user",
    agentId: "agent-test",
  });
  assert.deepEqual(
    withoutTopology.actorRoles.map(({ role, actorRole, actorKey }) => ({ role, actorRole, actorKey })),
    [{ role: "speaker", actorRole: "user", actorKey: "user" }],
  );
  assert.equal(
    buildArchivedUtteranceIdentity({
      messageRole: "user",
      conversationTopology: DIRECT_USER_AGENT_DM_TOPOLOGY,
    }).actorRoles.some((role) => role.role === "participant"),
    false,
  );
  for (const messageRole of ["system", "other", "world", "unknown"]) {
    assert.deepEqual(
      buildArchivedUtteranceIdentity({
        messageRole,
        agentId: "agent-test",
        conversationTopology: DIRECT_USER_AGENT_DM_TOPOLOGY,
      }),
      { subjectRole: "unknown", subjectKey: "", actorRoles: [] },
    );
  }
});

test("keeps structural big-neuron kinds outside direct compactor output", () => {
  const kinds = MEMORY_COMPACTION_SCHEMA.properties.memories.items.properties.kind.enum;
  assert.equal(kinds.includes("event"), true);
  assert.equal(kinds.includes("episode"), false);
  assert.equal(kinds.includes("topic"), false);
  assert.equal(kinds.includes("topic_or_episode"), false);
});

test("reserves manual and imported evidence modes for audited ingestion paths", () => {
  const modes = MEMORY_COMPACTION_SCHEMA.properties.memories.items.properties.evidenceMode.enum;
  assert.deepEqual(modes, ["explicit", "observed", "inferred"]);
});

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function record({
  uuid,
  parentUuid = null,
  type,
  role,
  content,
  timestamp,
  usage = undefined,
}) {
  return {
    parentUuid,
    isSidechain: false,
    userType: "external",
    cwd: "C:\\agent",
    sessionId: "session-test",
    version: "2.0.0",
    type,
    message: {
      role,
      content,
      ...(usage ? { usage } : {}),
    },
    uuid,
    timestamp,
  };
}

function sampleTranscript() {
  return [
    record({
      uuid: "old-user",
      type: "user",
      role: "user",
      content: "我昨天去了科技馆。",
      timestamp: "2026-07-01T08:00:00.000Z",
    }),
    record({
      uuid: "old-agent",
      parentUuid: "old-user",
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "你看了什么展览？" }],
      timestamp: "2026-07-01T08:01:00.000Z",
      usage: { input_tokens: 12_000 },
    }),
    record({
      uuid: "recent-user",
      parentUuid: "old-agent",
      type: "user",
      role: "user",
      content: "刚才说到哪了？",
      timestamp: "2026-07-30T01:00:00.000Z",
    }),
    record({
      uuid: "recent-agent",
      parentUuid: "recent-user",
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "说到你今天的安排。" }],
      timestamp: "2026-07-30T01:01:00.000Z",
      usage: { input_tokens: 20_000 },
    }),
  ];
}

function writeTranscript(filePath, records = sampleTranscript()) {
  fs.writeFileSync(
    filePath,
    `${records.map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8",
  );
}

function generatedCandidate(overrides = {}) {
  const candidate = {
    kind: "event",
    title: "测试候选",
    content: "一条用于验证输入边界的候选记忆。",
    subjectRole: "user",
    subjectName: "User",
    actorRoles: [],
    canonicalKey: "",
    stateFamily: "not_applicable",
    stateLabel: "",
    stateTarget: {
      type: "none",
      identityField: "not_applicable",
      fieldCardinality: "not_applicable",
      objectRole: "not_applicable",
      objectName: "",
      counterpartRole: "not_applicable",
      counterpartName: "",
      direction: "not_applicable",
      triggerRole: "not_applicable",
      triggerName: "",
    },
    reality: "real",
    evidenceMode: "explicit",
    temporalState: "historical",
    revisionAction: "add",
    retentionReason: "significant_event",
    eventDate: "",
    eventStart: "",
    eventEnd: "",
    confidence: 0.9,
    importance: 0.6,
    sourceRefs: ["M0001"],
    ...overrides,
  };
  if (overrides.kind && overrides.stateFamily === undefined) {
    const familyByKind = {
      fact: "identity",
      belief_state: "belief",
      preference: "preference",
      relationship: "relationship",
      plan: "goal",
      commitment: "goal",
      open_loop: "goal",
    };
    candidate.stateFamily = familyByKind[candidate.kind] || "not_applicable";
    candidate.stateLabel = candidate.stateFamily === "not_applicable" ? "" : candidate.title;
    if (candidate.stateFamily !== "not_applicable" && !candidate.canonicalKey) {
      candidate.canonicalKey = `test:${candidate.stateFamily}:${candidate.title}`;
    }
  }
  if (candidate.stateFamily === "identity" && candidate.stateTarget.type === "none") {
    candidate.stateTarget = {
      ...candidate.stateTarget,
      type: "identity",
      identityField: "other",
      fieldCardinality: "single",
    };
  } else if (candidate.stateFamily === "belief" && candidate.stateTarget.type === "none") {
    candidate.stateTarget = {
      ...candidate.stateTarget,
      type: "belief",
      objectRole: "world",
      objectName: candidate.stateLabel || candidate.title,
    };
  } else if (candidate.stateFamily === "relationship" && candidate.stateTarget.type === "none") {
    candidate.stateTarget = {
      ...candidate.stateTarget,
      type: "relationship",
      counterpartRole: "agent",
      counterpartName: "Agent",
      direction: "holder_to_counterpart",
    };
  } else if (candidate.stateFamily === "affective_association" && candidate.stateTarget.type === "none") {
    candidate.stateTarget = {
      ...candidate.stateTarget,
      type: "affective_association",
      triggerRole: "other",
      triggerName: candidate.stateLabel || candidate.title,
    };
  }
  return candidate;
}

test("rejects a blank transcript path instead of resolving the working directory", async () => {
  await assert.rejects(
    runCompaction({
      transcriptPath: " ",
      agentId: "agent-test",
      softwareDataDirectory: temporaryDirectory("suzu-memory-compactor-path-"),
      dryRun: true,
    }),
    /需要 transcriptPath/,
  );
});

test("keeps recent raw dialogue and chooses a complete user boundary", () => {
  const entries = parseJsonlText(
    `${sampleTranscript().map((item) => JSON.stringify(item)).join("\n")}\n`,
  );
  const context = reconstructLogicalContext(entries);
  const plan = chooseCompactionPlan(
    context,
    new Date("2026-07-30T02:00:00.000Z"),
  );
  assert.equal(plan.action, "compact");
  assert.equal(plan.mode, "recent-hours");
  assert.equal(plan.head.record.uuid, "recent-user");
  assert.deepEqual(
    plan.preservedLogical.map((entry) => entry.record.uuid),
    ["recent-user", "recent-agent"],
  );
});

test("writes a simulated checkpoint and archives both speakers into SQLite", async () => {
  const root = temporaryDirectory("suzu-memory-compactor-");
  const transcriptPath = path.join(root, "session.jsonl");
  const softwareDataDirectory = path.join(root, "software-data");
  writeTranscript(transcriptPath);
  const embeddingInputs = [];
  const embeddingProvider = async (text) => {
    const response = await embeddingProvider.embedMany([text]);
    return { ...response, vector: response.vectors[0] };
  };
  embeddingProvider.model = "embedding-test";
  embeddingProvider.dimensions = 3;
  embeddingProvider.embedMany = async (texts) => {
    embeddingInputs.push(...texts);
    return {
      model: "embedding-test",
      vectors: texts.map(() => Float32Array.from([1, 2, 3])),
      usage: { prompt_tokens: texts.length * 10 },
      metadata: { provider: "test" },
    };
  };

  const result = await runCompaction({
    transcriptPath,
    agentId: "agent-test",
    softwareDataDirectory,
    memoryOwner: "Agent",
    userName: "User",
    now: new Date("2026-07-30T02:00:00.000Z"),
    embeddingProvider,
    summaryOverride: "我记得 User 去过科技馆，之后问了他看了什么展览。",
    memoriesOverride: [{
      kind: "event",
      title: "去科技馆",
      content: "User 在 2026 年 7 月 1 日前一天去了科技馆。",
      subjectRole: "user",
      subjectName: "User",
      actorRoles: [{
        role: "experiencer",
        actorRole: "user",
        actorName: "User",
        confidence: 1,
      }],
      canonicalKey: "",
      stateFamily: "not_applicable",
      stateLabel: "",
      stateTarget: generatedCandidate().stateTarget,
      reality: "real",
      evidenceMode: "explicit",
      temporalState: "historical",
      revisionAction: "add",
      retentionReason: "significant_event",
      eventDate: "2026-06-30",
      eventStart: "2026-06-30T00:00:00.000Z",
      eventEnd: "",
      confidence: 0.95,
      importance: 0.7,
      sourceRefs: ["M0001"],
    }],
  });

  assert.equal(result.status, "written");
  assert.equal(result.messagesArchived, 2);
  assert.equal(result.memoriesStored, 1);
  assert.equal(result.embeddingIndex.status, "ready");
  assert.equal(result.embeddingIndex.added, 1);
  assert.equal(embeddingInputs.length, 1);
  assert.doesNotMatch(embeddingInputs[0], /你看了什么展览/u);
  assert.equal(result.consolidationPlan.status, "planned");
  assert.equal(result.consolidationPlan.triggerCount, 1);
  assert.equal(result.consolidationPlan.candidateCount, 0);
  assert.ok(fs.existsSync(result.backupPath));
  const appended = parseJsonlText(fs.readFileSync(transcriptPath, "utf8"));
  assert.equal(appended.at(-2).record.subtype, "compact_boundary");
  assert.equal(appended.at(-1).record.isCompactSummary, true);

  const database = openMemoryDatabase(result.databasePath);
  const repository = new MemoryRepository(database);
  assert.equal(
    Number(database.prepare(`
      SELECT COUNT(*) AS count FROM memory_nodes WHERE kind = 'utterance'
    `).get().count),
    2,
  );
  assert.equal(repository.search("agent-test", "科技馆")[0].subject_role, "user");
  const storedEvent = repository.search("agent-test", "科技馆")
    .find((memory) => memory.kind === "event");
  assert.equal(repository.listEmbeddings("agent-test", "embedding-test").length, 1);
  assert.equal(storedEvent.known_at, "2026-07-01T08:00:00.000Z");
  assert.equal(storedEvent.event_start, "2026-06-30T00:00:00.000Z");
  assert.equal(
    repository.getMemoryDetail("agent-test", storedEvent.id).roles
      .some((role) => role.role === "experiencer" && role.actor_role === "user"),
    true,
  );
  const ingestion = repository.listIngestionDecisions("agent-test", {
    batchId: result.boundaryUuid,
  });
  assert.equal(repository.listConsolidationRuns("agent-test", {
    statuses: ["planned"],
  }).length, 1);
  assert.equal(ingestion.length, 1);
  assert.equal(ingestion[0].decision, "store");
  assert.equal(ingestion[0].candidate.retentionReason, "significant_event");
  assert.equal(
    Number(database.prepare(`
      SELECT COUNT(*) AS count FROM memory_nodes
      WHERE kind = 'utterance' AND subject_role = 'agent'
    `).get().count),
    1,
  );
  assert.equal(
    Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM memory_actor_roles AS roles
      JOIN memory_nodes AS memory ON memory.id = roles.memory_id
      WHERE memory.kind = 'utterance'
        AND roles.role = 'participant'
        AND (
          (memory.subject_role = 'user'
            AND roles.actor_role = 'agent'
            AND roles.actor_key = 'agent-test')
          OR
          (memory.subject_role = 'agent'
            AND roles.actor_role = 'user'
            AND roles.actor_key = 'user')
        )
    `).get().count),
    2,
  );
  database.close();
});

test("does not store an Agent claim as a user fact", async () => {
  const root = temporaryDirectory("suzu-memory-ownership-");
  const transcriptPath = path.join(root, "session.jsonl");
  const records = sampleTranscript();
  records[0].message.content = "你猜我喜欢什么？";
  records[1].message.content = [{ type: "text", text: "你一定喜欢科幻。" }];
  writeTranscript(transcriptPath, records);
  const result = await runCompaction({
    transcriptPath,
    agentId: "agent-test",
    softwareDataDirectory: path.join(root, "software-data"),
    now: new Date("2026-07-30T02:00:00.000Z"),
    summaryOverride: "我猜过对方可能喜欢科幻，但这不是已经确认的事实。",
    memoriesOverride: [{
      kind: "preference",
      title: "科幻偏好",
      content: "用户喜欢科幻。",
      subjectRole: "user",
      subjectName: "User",
      actorRoles: [{
        role: "preference_holder",
        actorRole: "user",
        actorName: "User",
        confidence: 0.9,
      }],
      canonicalKey: "preference.genre.science-fiction",
      stateFamily: "preference",
      stateLabel: "科幻",
      stateTarget: generatedCandidate().stateTarget,
      reality: "real",
      evidenceMode: "explicit",
      temporalState: "current",
      revisionAction: "add",
      retentionReason: "explicit_preference",
      eventDate: "",
      eventStart: "",
      eventEnd: "",
      confidence: 0.9,
      importance: 0.5,
      sourceRefs: ["M0002"],
    }],
  });
  assert.equal(result.memoriesStored, 0);
  assert.equal(result.memoriesForReview, 1);
  assert.deepEqual(
    result.candidateResults[0].reasons,
    ["user-memory-without-user-source"],
  );
  const database = openMemoryDatabase(result.databasePath);
  const repository = new MemoryRepository(database);
  const decisions = repository.listIngestionDecisions("agent-test", {
    batchId: result.boundaryUuid,
  });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision, "review");
  assert.equal(decisions[0].review_state, "pending");
  assert.deepEqual(decisions[0].reasonCodes, ["user-memory-without-user-source"]);
  database.close();
});

test("queues an explicit personal state for specialist analysis without writing it as memory", async () => {
  const root = temporaryDirectory("suzu-memory-compactor-state-request-");
  const transcriptPath = path.join(root, "session.jsonl");
  const softwareDataDirectory = path.join(root, "software-data");
  writeTranscript(transcriptPath);
  const result = await runCompaction({
    transcriptPath,
    agentId: "agent-test",
    softwareDataDirectory,
    now: new Date("2026-07-30T02:00:00.000Z"),
    summaryOverride: "我记得 User 明确说自己喜欢参观科技馆。",
    memoriesOverride: [generatedCandidate({
      kind: "preference",
      title: "科技馆偏好",
      content: "User 明确表示喜欢参观科技馆。",
      canonicalKey: "preference.activity.science-museum",
      stateFamily: "preference",
      stateLabel: "参观科技馆",
      temporalState: "current",
      retentionReason: "explicit_preference",
      sourceRefs: ["M0001"],
    })],
  });
  assert.equal(result.memoriesStored, 0);
  assert.equal(result.stateAnalysisRequestsQueued, 1);
  assert.equal(result.candidateResults[0].status, "analysis_pending");
  const database = openMemoryDatabase(result.databasePath);
  const repository = new MemoryRepository(database);
  assert.equal(repository.listMemories("agent-test", { kinds: ["preference"] }).total, 0);
  const [request] = repository.listStateAnalysisRequests("agent-test", {
    statuses: ["pending"],
  });
  assert.equal(request.id, result.candidateResults[0].stateAnalysisRequestId);
  assert.equal(request.state_family, "preference");
  assert.equal(request.subject_role, "user");
  assert.equal(request.subject_key, "user");
  assert.equal(request.canonical_key, "preference.activity.science-museum");
  assert.equal(request.target_label, "参观科技馆");
  assert.equal(request.representation_layer, "reported");
  assert.equal(request.memoryIds.length, 1);
  assert.equal(request.sourceIds.length, 1);
  database.close();
});

test("persists immutable structured targets for target-sensitive state requests", async () => {
  const root = temporaryDirectory("suzu-memory-compactor-target-spec-");
  const transcriptPath = path.join(root, "session.jsonl");
  const softwareDataDirectory = path.join(root, "software-data");
  writeTranscript(transcriptPath);
  const result = await runCompaction({
    transcriptPath,
    agentId: "agent-test",
    softwareDataDirectory,
    now: new Date("2026-07-30T02:00:00.000Z"),
    summaryOverride: "这一批只验证四类状态目标能够固定进入分析请求。",
    memoriesOverride: [
      generatedCandidate({
        kind: "fact",
        title: "职业身份",
        content: "User 报告自己的职业是产品经理。",
        canonicalKey: "user:identity:occupation:product-manager",
        stateLabel: "产品经理",
        stateTarget: {
          ...generatedCandidate({ kind: "fact" }).stateTarget,
          identityField: "occupation",
          fieldCardinality: "multi_item",
        },
        retentionReason: "identity",
      }),
      generatedCandidate({
        kind: "belief_state",
        title: "鱼的味道观念",
        content: "User 说自己现在觉得有些鱼很好吃。",
        canonicalKey: "user:belief:fish-taste",
        stateLabel: "有些鱼很好吃",
        stateTarget: {
          ...generatedCandidate({ kind: "belief_state" }).stateTarget,
          objectRole: "world",
          objectName: "鱼的味道",
        },
        retentionReason: "explicit_belief",
      }),
      generatedCandidate({
        kind: "relationship",
        title: "对 Agent 的关系理解",
        content: "User 报告自己把 Agent 当作重要的朋友。",
        canonicalKey: "user:relationship:agent-test:important-friend",
        stateLabel: "重要的朋友",
        stateTarget: {
          ...generatedCandidate({ kind: "relationship" }).stateTarget,
          counterpartRole: "agent",
          counterpartName: "Agent",
        },
        retentionReason: "relationship",
      }),
      generatedCandidate({
        kind: "belief_state",
        title: "科技馆带来的开心",
        content: "User 说想到科技馆就会开心。",
        canonicalKey: "user:affective-association:science-museum:happy",
        stateFamily: "affective_association",
        stateLabel: "开心",
        stateTarget: {
          ...generatedCandidate({
            kind: "belief_state",
            stateFamily: "affective_association",
            stateLabel: "开心",
          }).stateTarget,
          triggerRole: "other",
          triggerName: "科技馆",
        },
        retentionReason: "explicit_belief",
      }),
    ],
  });
  assert.equal(result.stateAnalysisRequestsQueued, 4);
  const database = openMemoryDatabase(result.databasePath);
  const repository = new MemoryRepository(database);
  const requests = repository.listStateAnalysisRequests("agent-test", { statuses: ["pending"] });
  assert.deepEqual(requests.map((request) => request.state_family).sort(), [
    "affective_association", "belief", "identity", "relationship",
  ]);
  assert.deepEqual(
    requests.find((request) => request.state_family === "identity").targetSpec,
    { identityField: "occupation", fieldCardinality: "multi_item" },
  );
  assert.deepEqual(
    requests.find((request) => request.state_family === "belief").targetSpec,
    { objectRole: "world", objectKey: "", objectLabel: "鱼的味道" },
  );
  assert.deepEqual(
    requests.find((request) => request.state_family === "relationship").targetSpec,
    {
      counterpartRole: "agent",
      counterpartKey: "agent-test",
      counterpartLabel: "Agent",
      direction: "holder_to_counterpart",
    },
  );
  assert.deepEqual(
    requests.find((request) => request.state_family === "affective_association").targetSpec,
    { triggerRole: "other", triggerKey: "科技馆", triggerLabel: "科技馆" },
  );
  database.close();
});

test("runs structural generation after compaction without auto-accepting its proposal", async () => {
  const root = temporaryDirectory("suzu-memory-compactor-structure-");
  const transcriptPath = path.join(root, "session.jsonl");
  const softwareDataDirectory = path.join(root, "software-data");
  writeTranscript(transcriptPath);
  const result = await runCompaction({
    transcriptPath,
    agentId: "agent-test",
    softwareDataDirectory,
    now: new Date("2026-07-30T02:00:00.000Z"),
    summaryOverride: "记住科技馆对话。",
    memoriesOverride: [
      generatedCandidate({
        title: "参观科技馆",
        content: "用户去科技馆参观。",
        eventDate: "2026-07-01",
        eventStart: "2026-07-01T08:00:00.000Z",
      }),
      generatedCandidate({
        title: "询问展览",
        content: "Agent 询问用户看了什么展览。",
        subjectRole: "agent",
        subjectName: "Agent",
        eventDate: "2026-07-01",
        eventStart: "2026-07-01T08:01:00.000Z",
        sourceRefs: ["M0002"],
      }),
    ],
    structureGenerator: async ({ input, schemaName }) => {
      assert.equal(schemaName, "memory-structure-proposals-v1");
      const snapshot = JSON.parse(input.slice(input.indexOf("{")));
      return {
        output: {
          proposals: [{
            operation: "create",
            targetMemoryId: "",
            kind: "episode",
            title: "科技馆对话",
            content: "参观科技馆并继续讨论展览的一次经历。",
            subjectRole: "shared",
            subjectKey: "agent-test:user",
            eventDate: "2026-07-01",
            eventStart: "2026-07-01T08:00:00.000Z",
            eventEnd: "2026-07-01T08:01:00.000Z",
            memberIds: snapshot.currentMemories.map((memory) => memory.id),
            actorRoles: [],
            confidence: 0.88,
            rationale: "两个记忆属于同一次连续对话。",
          }],
        },
        model: "fake-structure-model",
        usage: {},
      };
    },
  });
  assert.equal(result.structureProposals.status, "proposed");
  assert.equal(result.structureProposals.proposed, 1);
  const database = openMemoryDatabase(result.databasePath);
  const repository = new MemoryRepository(database);
  assert.equal(repository.listStructureProposals("agent-test", {
    reviewStates: ["pending"],
  }).length, 1);
  assert.equal(repository.listMemories("agent-test", { kinds: ["episode"] }).total, 0);
  database.close();
});

test("keeps an explicitly uncertain candidate pending without guessing identity", async () => {
  const root = temporaryDirectory("suzu-memory-uncertain-input-");
  const transcriptPath = path.join(root, "session.jsonl");
  writeTranscript(transcriptPath);
  const result = await runCompaction({
    transcriptPath,
    agentId: "agent-test",
    softwareDataDirectory: path.join(root, "software-data"),
    now: new Date("2026-07-30T02:00:00.000Z"),
    summaryOverride: "我听到了一件与科技馆有关的事，但现有内容不足以确定经历者。",
    memoriesOverride: [{
      kind: "event",
      title: "身份未确定的科技馆事件",
      content: "现有直接证据不足以确定是谁去了科技馆。",
      subjectRole: "unknown",
      subjectName: "",
      actorRoles: [],
      canonicalKey: "",
      stateFamily: "not_applicable",
      stateLabel: "",
      stateTarget: generatedCandidate().stateTarget,
      reality: "unknown",
      evidenceMode: "explicit",
      temporalState: "unknown",
      revisionAction: "add",
      retentionReason: "significant_event",
      eventDate: "",
      eventStart: "",
      eventEnd: "",
      confidence: 0.3,
      importance: 0.5,
      sourceRefs: ["M0001"],
    }],
  });
  assert.equal(result.memoriesStored, 0);
  assert.equal(result.memoriesForReview, 1);
  assert.deepEqual(
    result.candidateResults[0].reasons.sort(),
    ["unknown-reality", "unknown-subject", "unknown-temporal-state"].sort(),
  );
  const database = openMemoryDatabase(result.databasePath);
  const repository = new MemoryRepository(database);
  const [decision] = repository.listIngestionDecisions("agent-test", {
    batchId: result.boundaryUuid,
  });
  assert.equal(decision.decision, "review");
  assert.equal(decision.review_state, "pending");
  assert.equal(decision.candidate.subjectRole, "unknown");
  assert.equal(
    Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes WHERE kind = 'event'").get().count),
    0,
  );
  database.close();
});

test("requires actor holders and shared commitments to match their direct evidence", async () => {
  const root = temporaryDirectory("suzu-memory-evidence-alignment-");
  const transcriptPath = path.join(root, "session.jsonl");
  writeTranscript(transcriptPath);
  const result = await runCompaction({
    transcriptPath,
    agentId: "agent-test",
    softwareDataDirectory: path.join(root, "software-data"),
    now: new Date("2026-07-30T02:00:00.000Z"),
    summaryOverride: "本批候选只用于验证人物角色与证据是否一致。",
    memoriesOverride: [
      generatedCandidate({
        kind: "commitment",
        title: "单方面提议",
        content: "双方已经作出共同约定。",
        subjectRole: "shared",
        subjectName: "",
        temporalState: "planned",
        retentionReason: "commitment",
        sourceRefs: ["M0001"],
      }),
      generatedCandidate({
        kind: "preference",
        title: "持有者冲突",
        content: "Agent 喜欢科幻。",
        subjectRole: "agent",
        subjectName: "Agent",
        actorRoles: [{
          role: "preference_holder",
          actorRole: "user",
          actorName: "User",
          confidence: 1,
        }],
        canonicalKey: "agent:preference:science-fiction",
        temporalState: "current",
        retentionReason: "explicit_preference",
        sourceRefs: ["M0001", "M0002"],
      }),
      generatedCandidate({
        title: "无来源的经历者",
        content: "用户事件中把 Agent 标成了经历者。",
        actorRoles: [{
          role: "experiencer",
          actorRole: "agent",
          actorName: "Agent",
          confidence: 1,
        }],
        sourceRefs: ["M0001"],
      }),
      generatedCandidate({
        kind: "fact",
        title: "准入理由错配",
        content: "用户有一条身份事实。",
        canonicalKey: "user:identity:test",
        retentionReason: "explicit_preference",
      }),
    ],
  });
  assert.equal(result.memoriesStored, 0);
  assert.equal(result.memoriesForReview, 4);
  assert.deepEqual(result.candidateResults.map((item) => item.reasons), [
    ["shared-commitment-without-bilateral-source"],
    ["holder-conflicts-with-subject"],
    ["agent-actor-without-agent-source"],
    ["retention-reason-kind-mismatch"],
  ]);
});

test("rejects impossible calendar dates before they can enter memory policy", () => {
  assert.throws(() => parseGeneratedCompaction({
    summary: "测试日期。",
    memories: [generatedCandidate({ eventDate: "2026-02-30" })],
  }), /有效的 YYYY-MM-DD/u);
});

test("rejects a state target whose family does not match its memory kind", () => {
  assert.throws(() => parseGeneratedCompaction({
    summary: "测试状态家族。",
    memories: [generatedCandidate({
      kind: "preference",
      canonicalKey: "preference.test",
      stateFamily: "capability",
      stateLabel: "测试偏好",
      retentionReason: "explicit_preference",
    })],
  }), /kind 与 stateFamily 不兼容/u);
});

test("rejects model claims of manual or imported evidence provenance", () => {
  for (const evidenceMode of ["manual", "imported"]) {
    assert.throws(() => parseGeneratedCompaction({
      summary: "测试来源模式。",
      memories: [generatedCandidate({ evidenceMode })],
    }), /evidenceMode 无效/u);
  }
});

test("stable CLI dry-run uses the explicit selected transcript", async () => {
  const root = temporaryDirectory("suzu-memory-cli-");
  const projectRoot = path.join(root, "project");
  const transcriptPath = path.join(root, "current.jsonl");
  const dataRoot = path.join(root, "software-data");
  fs.mkdirSync(projectRoot, { recursive: true });
  writeTranscript(transcriptPath);
  let output = "";
  const result = await runMemoryCompactorCli({
    args: [
      "--dry-run", "--project-root", projectRoot, "--transcript", transcriptPath,
      "--data-root", dataRoot, "--now", "2026-07-30T02:00:00.000Z",
    ],
    stdout: { write(chunk) { output += chunk; } },
  });

  assert.equal(result.status, "dry-run");
  assert.equal(result.transcriptPath, transcriptPath);
  assert.equal(JSON.parse(output).transcriptSource, "explicit");
  assert.ok(fs.existsSync(path.join(dataRoot, "agents")));
});

test("stable CLI keeps semantic processing on the current Agent and resolves only embedding", async () => {
  const root = temporaryDirectory("suzu-memory-cli-bindings-");
  const projectRoot = path.join(root, "project");
  const transcriptPath = path.join(root, "current.jsonl");
  const dataRoot = path.join(root, "software-data");
  fs.mkdirSync(projectRoot, { recursive: true });
  writeTranscript(transcriptPath);
  const resolvedKinds = [];
  let agentGeneratorCalls = 0;
  let embeddingOptions = null;
  const embeddingProvider = async () => ({
    vector: Float32Array.from([1, 0, 0]),
    vectors: [Float32Array.from([1, 0, 0])],
    model: "text-embedding-v4",
    usage: {},
  });
  embeddingProvider.embedMany = async (texts) => ({
    vectors: texts.map(() => Float32Array.from([1, 0, 0])),
    model: "text-embedding-v4",
    usage: {},
  });
  embeddingProvider.model = "text-embedding-v4";
  embeddingProvider.dimensions = 1024;

  const result = await runMemoryCompactorCli({
    args: [
      "--project-root", projectRoot, "--transcript", transcriptPath,
      "--data-root", dataRoot, "--now", "2026-07-30T02:00:00.000Z",
    ],
    stdout: { write() {} },
    connectionResolver: async ({ kind }) => {
      resolvedKinds.push(kind);
      if (kind === "memory-embedding") return {
        id: "embedding-test",
        type: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com/api/v1",
        apiKey: "embedding-secret",
        source: "saved",
      };
      return null;
    },
    agentGeneratorFactory: () => {
      agentGeneratorCalls += 1;
      return async () => ({
        output: { summary: "我记得 User 去过科技馆。", memories: [] },
        usage: {},
        model: "current-agent-model",
        requestId: "processing-request",
        durationMs: 1,
        metadata: { provider: "test" },
      });
    },
    embeddingProviderFactory: (options) => {
      embeddingOptions = options;
      return embeddingProvider;
    },
  });

  assert.equal(result.status, "written");
  assert.deepEqual(resolvedKinds, ["memory-embedding"]);
  assert.equal(agentGeneratorCalls, 1);
  assert.equal(embeddingOptions.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(embeddingOptions.model, "text-embedding-v4");
  assert.equal(embeddingOptions.dimensions, 1024);
});
