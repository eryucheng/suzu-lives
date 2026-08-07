import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readUsageEvents } from "@suzu-lives/cost-ledger";
import { MemoryRepository, openMemoryDatabase } from "@suzu-lives/memory-core";

import {
  buildPreferenceEvidenceSnapshot,
  evaluatePreferenceEvidenceTarget,
  proposePreferenceStateFromEvaluation,
} from "../src/index.mjs";

const policy = Object.freeze({
  version: "preference-evidence-test-v1",
  signalWeights: Object.freeze({
    active_choice: 0.7,
    repeated_behavior: 0.6,
    active_sharing: 0.5,
    counter_behavior: 0.6,
  }),
  opportunityCostMultipliers: Object.freeze({
    none: 1,
    low: 1.05,
    medium: 1.2,
    high: 1.4,
    unknown: 0.8,
  }),
  minimumConfidence: 0.6,
  minimumStableSupportScore: 1.3,
  minimumStableIndependentSupport: 3,
  minimumStableDistinctDays: 2,
  minimumStableDistinctContexts: 2,
  minimumChoiceEvidenceForStable: 1,
  minimumSelectionEvidence: 2,
  minimumSelectionContexts: 2,
  minimumToleranceEvidence: 2,
  minimumToleranceContexts: 2,
  maximumContributionPerDay: 1,
  maximumOppositionRatio: 0.25,
});

function fixture() {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const definitions = [
    {
      id: "overtime-1",
      kind: "event",
      content: "用户这周再次加班。",
      source: "为了拿工资和赶完项目，我今天又得加班。",
      eventStart: "2026-07-01T12:00:00.000Z",
    },
    {
      id: "puzzle-1",
      kind: "event",
      content: "用户在自由晚上主动选择玩解谜游戏。",
      source: "今晚没别的事，我想继续玩那个解谜游戏。",
      eventStart: "2026-07-02T12:00:00.000Z",
    },
    {
      id: "puzzle-2",
      kind: "event",
      content: "用户周末又主动寻找新的解谜游戏。",
      source: "周末我又找了一个新的解谜游戏，别的娱乐先不玩了。",
      eventStart: "2026-07-09T03:00:00.000Z",
    },
    {
      id: "puzzle-3",
      kind: "event",
      content: "用户旅行空闲时仍主动玩解谜游戏。",
      source: "在外面休息的时候我还是选了解谜游戏。",
      eventStart: "2026-07-16T03:00:00.000Z",
    },
    {
      id: "explicit-puzzle",
      kind: "preference",
      content: "用户明确表示喜欢解谜游戏。",
      source: "我就是很喜欢解谜游戏。",
      eventStart: "2026-07-20T03:00:00.000Z",
      actorRoles: [
        { role: "speaker", actorRole: "user", actorKey: "user" },
        { role: "preference_holder", actorRole: "user", actorKey: "user" },
      ],
    },
    {
      id: "agent-puzzle",
      kind: "event",
      content: "Agent玩了解谜游戏。",
      source: "我去玩了一会解谜游戏。",
      eventStart: "2026-07-21T03:00:00.000Z",
      subjectRole: "agent",
      subjectKey: "agent-test",
    },
    {
      id: "roleplay-puzzle",
      kind: "event",
      content: "角色扮演中的人物喜欢解谜游戏。",
      source: "在这段角色扮演里，我最喜欢解谜游戏。",
      eventStart: "2026-07-22T03:00:00.000Z",
      reality: "roleplay",
    },
  ];
  for (const definition of definitions) {
    const source = repository.upsertSource({
      agentId: "agent-test",
      sourceKind: "conversation",
      externalId: `source-${definition.id}`,
      occurredAt: definition.eventStart,
      speaker: definition.subjectRole === "agent" ? "Assistant" : "User",
      content: definition.source,
      metadata: { forbiddenPath: "C:/private/transcript.jsonl" },
    });
    repository.upsertMemory({
      id: definition.id,
      agentId: "agent-test",
      kind: definition.kind,
      layer: definition.kind === "preference" ? "semantic" : "episodic",
      content: definition.content,
      subjectRole: definition.subjectRole || "user",
      subjectKey: definition.subjectKey || "user",
      reality: definition.reality || "real",
      eventStart: definition.eventStart,
      actorRoles: definition.actorRoles || [],
      metadata: { forbiddenPath: "D:/private/memory.jsonl" },
    });
    repository.linkSource(definition.id, source.id, "evidence");
  }
  repository.upsertMemory({
    id: "missing-source",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "没有原始来源的行为不能交给标注器。",
    subjectRole: "user",
    subjectKey: "user",
  });
  const episode = repository.upsertEpisode({
    id: "episode-puzzle-evening",
    agentId: "agent-test",
    title: "同一次解谜讨论",
    content: "同一次现实情境中的两条解谜记忆。",
    eventStart: "2026-07-02T12:00:00.000Z",
  });
  repository.linkMemoryToEpisode({
    agentId: "agent-test",
    memoryId: "puzzle-1",
    episodeId: episode.id,
  });
  return { database, repository, episode };
}

function label(memoryId, signal, overrides = {}) {
  return {
    memoryId,
    sourceIds: [`src-conversation-source-${memoryId}`],
    signal,
    confidence: 0.9,
    agency: "self_initiated",
    constraint: "none",
    alternatives: "available",
    instrumentalGoal: "none",
    opportunityCost: "medium",
    topicInitiation: "self_initiated",
    affectiveExpression: "positive",
    canDecline: true,
    rationale: "原始来源直接支持该标注。",
    ...overrides,
  };
}

function sourceId(repository, memoryId) {
  return repository.getMemoryDetail("agent-test", memoryId).sources[0].id;
}

function generatedLabel(repository, memoryId, signal, overrides = {}) {
  return label(memoryId, signal, {
    sourceIds: [sourceId(repository, memoryId)],
    ...overrides,
  });
}

test("builds a bounded target-specific snapshot with code-derived groups", () => {
  const { database, repository, episode } = fixture();
  const snapshot = buildPreferenceEvidenceSnapshot({
    repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    memoryIds: ["puzzle-1", "puzzle-2", "roleplay-puzzle", "missing-source"],
  });
  assert.deepEqual(snapshot.memories.map((memory) => memory.id), ["puzzle-1", "puzzle-2"]);
  assert.equal(snapshot.target.subjectKey, "user");
  assert.equal(snapshot.target.canonicalKey, "user:preference:puzzle-games");
  assert.equal(snapshot.memories[0].evidenceGroupId, `episode:${episode.id}`);
  assert.equal(snapshot.memories[0].contextId, `episode:${episode.id}`);
  assert.match(snapshot.memories[1].evidenceGroupId, /^sources:/u);
  assert.match(snapshot.memories[1].contextId, /^day:2026-07-09$/u);
  assert.deepEqual(snapshot.omitted.memoriesExcluded, [
    { id: "roleplay-puzzle", reason: "reality-not-real" },
    { id: "missing-source", reason: "missing-direct-source" },
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), /private[\\/]transcript|private[\\/]memory/u);
  assert.equal(snapshot.inputPolicy.modelCanWriteMemory, false);
  database.close();
});

test("evaluates three audited free-time choices without writing memory", async () => {
  const { database, repository } = fixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-preference-evidence-"));
  const ledgerPath = path.join(directory, "usage.jsonl");
  const beforeNodes = Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  let received = null;
  const result = await evaluatePreferenceEvidenceTarget({
    repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    memoryIds: ["puzzle-1", "puzzle-2", "puzzle-3"],
    policy,
    usageLedgerPath: ledgerPath,
    generator: async (request) => {
      received = request;
      return {
        output: {
          evidence: [
            generatedLabel(repository, "puzzle-1", "active_choice"),
            generatedLabel(repository, "puzzle-2", "repeated_behavior", {
              opportunityCost: "high",
            }),
            generatedLabel(repository, "puzzle-3", "active_choice"),
          ],
        },
        model: "fake-preference-model",
        usage: { input_tokens: 200, output_tokens: 80 },
        requestId: "fake-preference-request",
        durationMs: 15,
        metadata: { provider: "test-provider" },
      };
    },
  });
  assert.equal(result.status, "evaluated");
  assert.equal(result.labels.length, 3);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.preview.status, "stable-preference-review");
  assert.equal(result.preview.proposedKind, "derived_hypothesis");
  assert.equal(result.automaticMemoryWriteAllowed, false);
  assert.equal(result.evidenceLedger.analysisRun.state_family, "preference");
  assert.equal(result.evidenceLedger.analysisRun.analyzer_role, "preference-evidence-monolith");
  assert.equal(result.evidenceLedger.observations.length, 3);
  assert.equal(result.evidenceLedger.observations.every((item) => (
    item.qualification === "qualified" && item.effective_direction === "support"
  )), true);
  assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count), beforeNodes);
  assert.equal(received.schemaName, "memory-preference-evidence-v1");
  assert.equal(received.schema.type, "object");
  assert.match(received.input, /今晚没别的事/u);
  const ledger = await readUsageEvents(ledgerPath);
  assert.equal(ledger.events.length, 1);
  assert.equal(ledger.events[0].feature, "memory-preference-evidence");
  database.close();
});

test("turns an evaluated selection tendency into a pending state proposal without writing memory", async () => {
  const { database, repository } = fixture();
  const evaluation = await evaluatePreferenceEvidenceTarget({
    repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    memoryIds: ["puzzle-1", "puzzle-2"],
    policy,
    generator: async () => ({
      output: {
        evidence: [
          generatedLabel(repository, "puzzle-1", "active_choice"),
          generatedLabel(repository, "puzzle-2", "repeated_behavior"),
        ],
      },
    }),
  });
  assert.equal(evaluation.preview.status, "selection-tendency");
  const beforeNodes = Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const persisted = proposePreferenceStateFromEvaluation(repository, {
    agentId: "agent-test",
    evaluation,
    subjectLabel: "用户",
    objectLabel: "解谜游戏",
  });
  assert.equal(persisted.status, "pending");
  assert.equal(persisted.proposal.proposed_level, "selection_tendency");
  assert.equal(persisted.proposal.transition, "create");
  assert.equal(persisted.proposal.evidence.length, 2);
  assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count), beforeNodes);
  database.close();
});

test("keeps constrained overtime as behavior even when the model labels repetition", async () => {
  const { database, repository } = fixture();
  const result = await evaluatePreferenceEvidenceTarget({
    repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:overtime",
    memoryIds: ["overtime-1"],
    policy,
    generator: async () => ({
      output: {
        evidence: [generatedLabel(repository, "overtime-1", "repeated_behavior", {
          constraint: "work",
          instrumentalGoal: "income",
          opportunityCost: "high",
        })],
      },
    }),
  });
  assert.equal(result.labels.length, 1);
  assert.equal(result.preview.status, "behavior-only");
  assert.equal(result.preview.supportScore, 0);
  assert.equal(result.preview.ignoredEvidence[0].ignoredReason, "blocked-by-work-constraint");
  assert.equal(result.evidenceLedger.observations[0].claimed_direction, "support");
  assert.equal(result.evidenceLedger.observations[0].effective_direction, "neutral");
  assert.equal(result.evidenceLedger.observations[0].qualification, "excluded");
  assert.equal(result.evidenceLedger.observations[0].excluded_reason, "blocked-by-work-constraint");
  database.close();
});

test("keeps unknown alternatives from becoming voluntary choice evidence", async () => {
  const { database, repository } = fixture();
  const result = await evaluatePreferenceEvidenceTarget({
    repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    memoryIds: ["puzzle-1"],
    policy,
    generator: async () => ({
      output: {
        evidence: [generatedLabel(repository, "puzzle-1", "active_choice", {
          alternatives: "unknown",
        })],
      },
    }),
  });
  assert.equal(result.labels.length, 1);
  assert.equal(result.preview.status, "behavior-only");
  assert.equal(result.preview.supportScore, 0);
  assert.equal(result.preview.ignoredEvidence[0].ignoredReason, "no-verified-alternative-choice");
  database.close();
});

test("accepts direct explicit preference only with holder roles and direct sources", async () => {
  const { database, repository } = fixture();
  const result = await evaluatePreferenceEvidenceTarget({
    repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    memoryIds: ["explicit-puzzle", "puzzle-1"],
    policy,
    generator: async () => ({
      output: {
        evidence: [
          generatedLabel(repository, "explicit-puzzle", "explicit_preference", {
            agency: "unknown",
            constraint: "unknown",
            alternatives: "unknown",
            instrumentalGoal: "unknown",
            opportunityCost: "unknown",
            topicInitiation: "unknown",
            affectiveExpression: "positive",
            canDecline: false,
          }),
          generatedLabel(repository, "puzzle-1", "explicit_preference"),
        ],
      },
    }),
  });
  assert.equal(result.labels.length, 1);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].error, /direct preference memory/u);
  assert.equal(result.preview.status, "direct-preference");
  assert.equal(result.preview.proposedKind, "preference");
  database.close();
});

test("rejects invented memories, foreign sources, duplicate labels, and holder mismatches", async () => {
  const { database, repository } = fixture();
  const result = await evaluatePreferenceEvidenceTarget({
    repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    memoryIds: ["puzzle-1", "puzzle-2", "agent-puzzle"],
    policy,
    generator: async () => ({
      output: {
        evidence: [
          generatedLabel(repository, "puzzle-1", "active_choice"),
          generatedLabel(repository, "puzzle-1", "repeated_behavior"),
          label("invented-memory", "active_choice", {
            sourceIds: [sourceId(repository, "puzzle-1")],
          }),
          generatedLabel(repository, "puzzle-2", "active_choice", {
            sourceIds: [sourceId(repository, "puzzle-1")],
          }),
          generatedLabel(repository, "agent-puzzle", "active_choice"),
        ],
      },
    }),
  });
  assert.equal(result.labels.length, 1);
  assert.equal(result.rejected.length, 4);
  assert.match(result.rejected[0].error, /at most one/u);
  assert.match(result.rejected[1].error, /bounded snapshot/u);
  assert.match(result.rejected[2].error, /directly support/u);
  assert.match(result.rejected[3].error, /fixed holder/u);
  database.close();
});

test("allows the generator to abstain without fabricating a preference", async () => {
  const { database, repository } = fixture();
  const result = await evaluatePreferenceEvidenceTarget({
    repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    memoryIds: ["puzzle-1"],
    policy,
    generator: async () => ({ output: { evidence: [] } }),
  });
  assert.equal(result.status, "abstained");
  assert.equal(result.labels.length, 0);
  assert.equal(result.preview.status, "behavior-only");
  assert.equal(result.preview.proposedKind, "");
  assert.equal(result.evidenceLedger.analysisRun.status, "abstained");
  assert.equal(result.evidenceLedger.observations.length, 0);
  database.close();
});

test("keeps repeated semantic evidence idempotent while auditing each model call", async () => {
  const { database, repository } = fixture();
  const request = {
    repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    memoryIds: ["puzzle-1"],
    policy,
    generator: async () => ({
      output: { evidence: [generatedLabel(repository, "puzzle-1", "active_choice")] },
      model: "fake-model",
      metadata: { provider: "fake-provider" },
    }),
  };
  const first = await evaluatePreferenceEvidenceTarget(request);
  const second = await evaluatePreferenceEvidenceTarget(request);
  assert.notEqual(first.evidenceLedger.analysisRun.id, second.evidenceLedger.analysisRun.id);
  const observations = repository.listStateEvidenceObservations("agent-test", {
    stateFamily: "preference",
    canonicalKey: "user:preference:puzzle-games",
    lifecycles: ["current", "superseded"],
  });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].analysisRunIds.length, 2);
  assert.equal(repository.listStateAnalysisRuns("agent-test", {
    stateFamily: "preference",
  }).length, 2);
  database.close();
});
