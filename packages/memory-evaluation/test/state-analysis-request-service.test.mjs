import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryRepository,
  openMemoryDatabase,
} from "@suzu-lives/memory-core";

import {
  processPendingStateAnalysisRequests,
  processStateAnalysisRequest,
} from "../src/index.mjs";

function setupRequest({
  evidenceMode = "explicit",
  representationLayer = "reported",
  database: existingDatabase = null,
  repository: existingRepository = null,
  suffix = "1",
  targetLabel = "解谜游戏",
  createdAt = "2026-07-11T02:01:00.000Z",
  stateFamily = "preference",
  targetSpec = {},
} = {}) {
  const database = existingDatabase || openMemoryDatabase(":memory:");
  const repository = existingRepository || new MemoryRepository(database);
  const source = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "transcript-message",
    externalId: `message-preference-${suffix}`,
    occurredAt: "2026-07-10T12:00:00.000Z",
    knownAt: "2026-07-10T12:00:00.000Z",
    recordedAt: "2026-07-11T02:00:00.000Z",
    speaker: "用户",
    content: `我一直很喜欢${targetLabel}，这个可以记住。`,
  });
  const memory = repository.upsertMemory({
    id: `utterance-preference-${suffix}`,
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: `我一直很喜欢${targetLabel}，这个可以记住。`,
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    evidenceMode: "imported",
    temporalState: "historical",
    eventStart: "2026-07-10T12:00:00.000Z",
    knownAt: "2026-07-10T12:00:00.000Z",
    recordedAt: "2026-07-11T02:00:00.000Z",
    actorRoles: [{
      role: "speaker",
      actorRole: "user",
      actorKey: "user",
      isPrimary: true,
      confidence: 1,
    }],
  });
  repository.linkSource(memory.id, source.id, "verbatim", {
    authority: "verbatim_record",
    sourceTrust: 1,
    evidenceStrength: 1,
  });
  const request = repository.recordStateAnalysisRequest({
    agentId: "agent-test",
    batchId: `compaction-boundary-${suffix}`,
    candidateIndex: Number(suffix) || 0,
    stateFamily,
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: `user:preference:target-${suffix}`,
    targetLabel,
    targetSpec,
    representationLayer,
    evidenceMode,
    memoryIds: [memory.id],
    sourceIds: [source.id],
    metadata: { subjectName: "用户" },
    createdAt,
  });
  return { database, repository, source, memory, request };
}

function directGoalGenerator(fixture) {
  return async ({ analyzerRole }) => {
    const common = {
      memoryId: fixture.memory.id,
      sourceIds: [fixture.source.id],
      confidence: 0.98,
      rationale: "原话直接支持该字段。",
    };
    const outputs = {
      "target-intent": { analyses: [{
        ...common,
        targetMatch: "exact",
        goalText: fixture.request.target_label,
        intentionLevel: "plan",
        specificity: "actionable",
      }] },
      "holder-responsibility": { analyses: [{
        ...common,
        holderMatch: "yes",
        attribution: "explicit_self_statement",
        responsibility: "subject",
        agency: "self_chosen",
        acceptsResponsibility: "yes",
      }] },
      "lifecycle": { analyses: [{
        ...common,
        lifecycle: "active",
        completionBasis: "none",
        timeReference: "",
      }] },
      "current-relation": { analyses: [{
        ...common,
        currentStatePresent: false,
        relation: "no_current_state",
      }] },
    };
    return {
      output: outputs[analyzerRole],
      model: `test-${analyzerRole}`,
      metadata: { provider: "test" },
    };
  };
}

function directConditionGenerator(fixture) {
  return async ({ analyzerRole }) => {
    assert.equal(analyzerRole, "condition-evidence");
    return {
      output: { analyses: [{
        memoryId: fixture.memory.id,
        sourceIds: [fixture.source.id],
        confidence: 0.98,
        rationale: "原话直接报告当前现实条件。",
        targetMatch: "exact",
        matchedLabel: fixture.request.target_label,
        conditionPresence: "present",
        conditionKind: "work",
        effect: "constrains",
        temporality: "current",
        evidenceBasis: "explicit_self_report",
        scopeLabel: fixture.request.target_label,
        revisionCue: "none",
      }] },
      model: "test-condition-evidence",
      metadata: { provider: "test" },
    };
  };
}

function directPreferenceGenerator(fixture, { failRole = "" } = {}) {
  return async ({ analyzerRole }) => {
    if (analyzerRole === failRole) throw new Error("temporary-provider-failure");
    const common = {
      memoryId: fixture.memory.id,
      sourceIds: [fixture.source.id],
      confidence: 0.98,
      rationale: "原话直接支持该字段。",
    };
    const outputs = {
      "object-grounding": {
        analyses: [{ ...common, targetMatch: "exact", matchedLabel: fixture.request.target_label }],
      },
      "explicit-expression": {
        analyses: [{
          ...common,
          expressionType: "likes",
          directness: "explicit_self_statement",
        }],
      },
      "behavior-conditions": { analyses: [] },
      "sharing-affect": { analyses: [] },
      "time-scope": {
        analyses: [{
          ...common,
          stateTime: "current",
          occurrencePattern: "repeated",
          scopeKind: "category",
          scopeLabel: fixture.request.target_label,
          contextLabel: "",
          revisionCue: "none",
        }],
      },
    };
    return {
      output: outputs[analyzerRole],
      model: `test-${analyzerRole}`,
      metadata: { provider: "test" },
    };
  };
}

test("processes a request-bound utterance into a pending reported preference proposal", async () => {
  const fixture = setupRequest();
  const beforeNodes = Number(
    fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count,
  );
  const result = await processStateAnalysisRequest({
    repository: fixture.repository,
    agentId: "agent-test",
    requestId: fixture.request.id,
    generator: directPreferenceGenerator(fixture),
  });
  assert.equal(result.status, "proposal-pending");
  assert.equal(result.request.status, "completed");
  assert.equal(result.review.status, "ready");
  assert.equal(result.review.representationLayer, "reported");
  assert.equal(result.proposal.review_state, "pending");
  assert.equal(result.proposal.state_family, "preference");
  assert.equal(result.proposal.representation_layer, "reported");
  assert.equal(result.proposal.metadata.stateAnalysisRequestId, fixture.request.id);
  assert.equal(fixture.repository.listStateAnalysisRequests("agent-test", {
    statuses: ["pending"],
  }).length, 0);
  assert.equal(fixture.repository.listReportedStateProposals("agent-test", {
    reviewStates: ["pending"],
    stateFamily: "preference",
  }).length, 1);
  assert.equal(
    Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    beforeNodes,
  );
  fixture.database.close();
});

test("processes a request-bound explicit goal without rewriting the utterance provenance", async () => {
  const fixture = setupRequest({
    stateFamily: "goal",
    targetLabel: "整理并发布记忆系统",
  });
  const result = await processStateAnalysisRequest({
    repository: fixture.repository,
    agentId: "agent-test",
    requestId: fixture.request.id,
    generator: directGoalGenerator(fixture),
  });
  assert.equal(result.status, "proposal-pending");
  assert.equal(result.request.status, "completed");
  assert.equal(result.review.status, "ready");
  assert.equal(result.proposal.state_family, "goal");
  assert.equal(result.proposal.representation_layer, "reported");
  assert.equal(result.proposal.review_state, "pending");
  assert.equal(fixture.repository.getMemory(fixture.memory.id).evidence_mode, "imported");
  fixture.database.close();
});

test("processes a request-bound explicit condition through the family-specific review", async () => {
  const fixture = setupRequest({
    stateFamily: "condition",
    targetLabel: "最近需要持续加班",
  });
  const result = await processStateAnalysisRequest({
    repository: fixture.repository,
    agentId: "agent-test",
    requestId: fixture.request.id,
    generator: directConditionGenerator(fixture),
  });
  assert.equal(result.status, "proposal-pending");
  assert.equal(result.review.status, "ready");
  assert.equal(result.proposal.state_family, "condition");
  assert.equal(result.proposal.representation_layer, "reported");
  assert.equal(fixture.repository.getMemory(fixture.memory.id).evidence_mode, "imported");
  fixture.database.close();
});

test("leaves a request pending when its family still lacks required structured target fields", async () => {
  const fixture = setupRequest({
    stateFamily: "identity",
    targetLabel: "当前职业",
  });
  let calls = 0;
  const result = await processStateAnalysisRequest({
    repository: fixture.repository,
    agentId: "agent-test",
    requestId: fixture.request.id,
    generator: async () => {
      calls += 1;
      return { output: { analyses: [] } };
    },
  });
  assert.equal(result.status, "unsupported");
  assert.equal(result.request.status, "pending");
  assert.equal(calls, 0);
  fixture.database.close();
});

test("dispatches every label-complete reported family without inventing missing evidence", async () => {
  for (const stateFamily of [
    "goal",
    "value",
    "capability",
    "self_concept",
    "condition",
    "habit",
    "disposition",
  ]) {
    const fixture = setupRequest({
      stateFamily,
      targetLabel: `测试目标-${stateFamily}`,
    });
    let calls = 0;
    const result = await processStateAnalysisRequest({
      repository: fixture.repository,
      agentId: "agent-test",
      requestId: fixture.request.id,
      generator: async ({ analyzerRole }) => {
        calls += 1;
        return {
          output: { analyses: [] },
          model: `test-${analyzerRole}`,
          metadata: { provider: "test" },
        };
      },
    });
    assert.equal(result.status, "completed-without-proposal", stateFamily);
    assert.equal(result.request.status, "completed", stateFamily);
    assert.equal(result.review.status, "skipped", stateFamily);
    assert.ok(calls > 0, stateFamily);
    assert.equal(fixture.repository.listReportedStateProposals("agent-test").length, 0);
    fixture.database.close();
  }
});

test("dispatches structured-target reported families without inventing missing evidence", async () => {
  for (const [stateFamily, targetSpec] of Object.entries({
    identity: {
      identityField: "occupation",
      fieldCardinality: "multi_item",
    },
    belief: {
      objectRole: "world",
      objectKey: "",
      objectLabel: "鱼是否好吃",
    },
    relationship: {
      counterpartRole: "agent",
      counterpartKey: "agent-test",
      counterpartLabel: "Agent",
      direction: "holder_to_counterpart",
    },
    affective_association: {
      triggerRole: "other",
      triggerKey: "place:science-museum",
      triggerLabel: "科技馆",
    },
  })) {
    const fixture = setupRequest({
      stateFamily,
      targetLabel: `测试目标-${stateFamily}`,
      targetSpec,
    });
    let calls = 0;
    const result = await processStateAnalysisRequest({
      repository: fixture.repository,
      agentId: "agent-test",
      requestId: fixture.request.id,
      generator: async ({ analyzerRole }) => {
        calls += 1;
        return {
          output: { analyses: [] },
          model: `test-${analyzerRole}`,
          metadata: { provider: "test" },
        };
      },
    });
    assert.equal(result.status, "completed-without-proposal", stateFamily);
    assert.equal(result.request.status, "completed", stateFamily);
    assert.equal(result.review.status, "skipped", stateFamily);
    assert.ok(calls > 0, stateFamily);
    assert.equal(fixture.repository.listReportedStateProposals("agent-test").length, 0);
    fixture.database.close();
  }
});

test("processes only the explicitly bounded number of supported pending requests", async () => {
  const first = setupRequest({
    suffix: "1",
    createdAt: "2026-07-11T02:01:00.000Z",
  });
  const second = setupRequest({
    database: first.database,
    repository: first.repository,
    suffix: "2",
    targetLabel: "科幻小说",
    createdAt: "2026-07-11T02:02:00.000Z",
  });
  const fixtures = new Map([
    [first.request.id, first],
    [second.request.id, second],
  ]);
  const result = await processPendingStateAnalysisRequests({
    repository: first.repository,
    agentId: "agent-test",
    maxRequests: 1,
    generator: (input) => directPreferenceGenerator(fixtures.get(input.stateAnalysisRequestId))(input),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.selected, 1);
  assert.equal(result.counts["proposal-pending"], 1);
  assert.equal(first.repository.getStateAnalysisRequest("agent-test", first.request.id).status, "completed");
  assert.equal(first.repository.getStateAnalysisRequest("agent-test", second.request.id).status, "pending");
  first.database.close();
});

test("continues a bounded batch after a retryable provider failure", async () => {
  const first = setupRequest({
    suffix: "1",
    createdAt: "2026-07-11T02:01:00.000Z",
  });
  const second = setupRequest({
    database: first.database,
    repository: first.repository,
    suffix: "2",
    targetLabel: "科幻小说",
    createdAt: "2026-07-11T02:02:00.000Z",
  });
  setupRequest({
    database: first.database,
    repository: first.repository,
    suffix: "3",
    targetLabel: "散步",
    evidenceMode: "observed",
    representationLayer: "inferred",
    createdAt: "2026-07-11T02:03:00.000Z",
  });
  const fixtures = new Map([
    [first.request.id, first],
    [second.request.id, second],
  ]);
  const result = await processPendingStateAnalysisRequests({
    repository: first.repository,
    agentId: "agent-test",
    maxRequests: 10,
    generator: (input) => directPreferenceGenerator(
      fixtures.get(input.stateAnalysisRequestId),
      { failRole: input.stateAnalysisRequestId === first.request.id ? "time-scope" : "" },
    )(input),
  });
  assert.equal(result.status, "partial-failure");
  assert.equal(result.selected, 2);
  assert.equal(result.counts["retryable-failure"], 1);
  assert.equal(result.counts["proposal-pending"], 1);
  assert.equal(first.repository.getStateAnalysisRequest("agent-test", first.request.id).status, "pending");
  assert.equal(first.repository.getStateAnalysisRequest("agent-test", second.request.id).status, "completed");
  assert.equal(first.repository.listStateAnalysisRequests("agent-test", {
    statuses: ["pending"],
    representationLayer: "inferred",
  }).length, 1);
  first.database.close();
});

test("keeps a request pending when one required specialist fails", async () => {
  const fixture = setupRequest();
  const result = await processStateAnalysisRequest({
    repository: fixture.repository,
    agentId: "agent-test",
    requestId: fixture.request.id,
    generator: directPreferenceGenerator(fixture, { failRole: "time-scope" }),
  });
  assert.equal(result.status, "retryable-failure");
  assert.equal(result.request.status, "pending");
  assert.deepEqual(result.evaluation.failedRoles, ["timeScope"]);
  assert.equal(fixture.repository.listReportedStateProposals("agent-test").length, 0);
  fixture.database.close();
});

test("does not consume an inferred preference request with the reported-only processor", async () => {
  const fixture = setupRequest({ evidenceMode: "observed", representationLayer: "inferred" });
  let calls = 0;
  const result = await processStateAnalysisRequest({
    repository: fixture.repository,
    agentId: "agent-test",
    requestId: fixture.request.id,
    generator: async () => {
      calls += 1;
      return { output: { analyses: [] } };
    },
  });
  assert.equal(result.status, "unsupported");
  assert.equal(result.request.status, "pending");
  assert.equal(calls, 0);
  fixture.database.close();
});
