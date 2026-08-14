import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryRepository,
  openMemoryDatabase,
} from "@suzu-lives/memory-core";

import {
  processPendingRetrievalUsageRequests,
  processRetrievalUsageRequest,
} from "../src/index.mjs";

function fixture({ suffix = "1", database = null, repository = null } = {}) {
  const currentDatabase = database || openMemoryDatabase(":memory:");
  const currentRepository = repository || new MemoryRepository(currentDatabase);
  const ids = [`usage-memory-${suffix}-a`, `usage-memory-${suffix}-b`];
  currentRepository.upsertMemory({
    id: ids[0],
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "科技馆",
    content: "用户去了科技馆并看了机器人展。",
    subjectRole: "user",
    subjectKey: "user",
  });
  currentRepository.upsertMemory({
    id: ids[1],
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "晚饭",
    content: "用户那天晚上吃了面。",
    subjectRole: "user",
    subjectKey: "user",
  });
  const trace = currentRepository.recordRetrievalTrace({
    id: `usage-trace-${suffix}`,
    agentId: "agent-test",
    queryText: "还记得科技馆吗",
    recallIntent: "event",
    resultStatus: "ready",
    seedIds: [ids[0]],
    selectedIds: ids,
    metadata: { runtimeSessionKey: `session-${suffix}` },
  });
  currentRepository.setRetrievalSessionHead({
    agentId: "agent-test",
    sessionId: `session-${suffix}`,
    traceId: trace.id,
  });
  const request = currentRepository.bindRetrievalUsageResponse({
    agentId: "agent-test",
    sessionId: `session-${suffix}`,
    responseText: "记得，你去了科技馆并看了机器人展。",
  });
  return { database: currentDatabase, repository: currentRepository, ids, trace, request };
}

test("turns only response-grounded use into append-only used feedback", async () => {
  const value = fixture();
  const beforeNodes = Number(value.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const result = await processRetrievalUsageRequest({
    repository: value.repository,
    agentId: "agent-test",
    requestId: value.request.id,
    generator: async () => ({
      output: { analyses: [
        { memoryId: value.ids[0], usage: "used", rationale: "回复复述了科技馆和机器人展。" },
        { memoryId: value.ids[1], usage: "not_used", rationale: "回复没有提到晚饭。" },
      ] },
      provider: "test",
      model: "test-model",
      usage: { input_tokens: 100, output_tokens: 30 },
      requestId: "provider-request-1",
      metadata: { provider: "test" },
    }),
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.request.result.usedMemoryIds, [value.ids[0]]);
  assert.deepEqual(result.request.result.notUsedMemoryIds, [value.ids[1]]);
  assert.deepEqual(result.request.result.uncertainMemoryIds, []);
  assert.equal(result.feedback.signal, "used");
  assert.deepEqual(result.feedback.targetMemoryIds, [value.ids[0]]);
  assert.equal(value.repository.listRetrievalFeedback("agent-test", value.trace.id).length, 1);
  assert.equal(
    Number(value.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    beforeNodes,
  );
  value.database.close();
});

test("keeps uncertain or not-used classifications out of negative feedback", async () => {
  const value = fixture();
  const result = await processRetrievalUsageRequest({
    repository: value.repository,
    agentId: "agent-test",
    requestId: value.request.id,
    generator: async () => ({
      output: { analyses: [
        { memoryId: value.ids[0], usage: "uncertain", rationale: "回复过短，无法确认依赖。" },
        { memoryId: value.ids[1], usage: "not_used", rationale: "回复未涉及晚饭。" },
      ] },
      model: "test-model",
      metadata: { provider: "test" },
    }),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.feedback, null);
  assert.equal(value.repository.listRetrievalFeedback("agent-test", value.trace.id).length, 0);
  value.database.close();
});

test("keeps malformed usage analysis pending and continues a bounded batch", async () => {
  const first = fixture({ suffix: "1" });
  const second = fixture({ suffix: "2", database: first.database, repository: first.repository });
  const result = await processPendingRetrievalUsageRequests({
    repository: first.repository,
    agentId: "agent-test",
    maxRequests: 2,
    generator: async ({ input }) => {
      const snapshot = JSON.parse(input);
      if (snapshot.trace.id === first.trace.id) {
        return {
          output: { analyses: [{
            memoryId: first.ids[0],
            usage: "used",
            rationale: "故意漏掉另一条。",
          }] },
          model: "test-model",
          metadata: { provider: "test" },
        };
      }
      return {
        output: { analyses: snapshot.trace.selectedMemoryIds.map((memoryId) => ({
          memoryId,
          usage: "uncertain",
          rationale: "无法可靠确认。",
        })) },
        model: "test-model",
        metadata: { provider: "test" },
      };
    },
  });
  assert.equal(result.status, "partial-failure");
  assert.equal(result.counts["retryable-failure"], 1);
  assert.equal(result.counts.completed, 1);
  assert.equal(first.repository.getRetrievalUsageRequest("agent-test", first.request.id).status, "pending");
  assert.equal(first.repository.getRetrievalUsageRequest("agent-test", second.request.id).status, "completed");
  assert.equal(Number(first.database.prepare(`
    SELECT COUNT(*) AS count FROM memory_retrieval_usage_analysis_runs
  `).get().count), 2);
  first.database.close();
});
