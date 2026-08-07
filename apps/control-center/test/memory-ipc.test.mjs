import assert from "node:assert/strict";
import test from "node:test";

import { registerMemoryIpc } from "../electron/ipc/memory-ipc.mjs";

test("memory IPC exposes audited structure proposal listing and resolution", async () => {
  const handlers = new Map();
  const calls = [];
  const ipcMain = {
    handle(channel, callback) {
      handlers.set(channel, callback);
    },
  };
  const memoryService = {
    status: () => ({}),
    search: () => ({}),
    brainGraph: () => ({}),
    list: () => ({}),
    detail: () => ({}),
    edit: () => ({}),
    remove: () => ({}),
    restore: () => ({}),
    structureProposals(filters) {
      calls.push(["list", filters]);
      return [{ id: "proposal-1" }];
    },
    resolveStructure(payload) {
      calls.push(["resolve", payload]);
      return { status: "accepted" };
    },
    subjectAttributionProposals(filters) {
      calls.push(["subject-list", filters]);
      return [{ id: "subject-proposal-1" }];
    },
    resolveSubjectAttribution(payload) {
      calls.push(["subject-resolve", payload]);
      return { status: "dismissed" };
    },
    retrievalTraces(filters) {
      calls.push(["traces", filters]);
      return [{ id: "trace-1" }];
    },
    recordRetrievalFeedback(payload) {
      calls.push(["feedback", payload]);
      return { signal: payload.signal };
    },
    memoryRetrievalStats(filters) {
      calls.push(["stats", filters]);
      return [{ memoryId: "memory-1", selectedCount: 2 }];
    },
    edgeRetrievalStats(filters) {
      calls.push(["edge-stats", filters]);
      return [{ edgeId: "edge-1", traversedCount: 1 }];
    },
    plasticityPreview(filters) {
      calls.push(["plasticity", filters]);
      return { automaticAdjustmentAllowed: false };
    },
  };
  registerMemoryIpc({ ipcMain, memoryService, settingsService: null });
  assert.deepEqual(
    await handlers.get("memory:structure-proposals")(null, { reviewStates: ["pending"] }),
    [{ id: "proposal-1" }],
  );
  assert.deepEqual(
    await handlers.get("memory:resolve-structure")(null, {
      proposalId: "proposal-1",
      action: "accept",
      note: "确认",
    }),
    { status: "accepted" },
  );
  assert.deepEqual(
    await handlers.get("memory:subject-attribution-proposals")(null, {
      reviewStates: ["pending"],
    }),
    [{ id: "subject-proposal-1" }],
  );
  assert.deepEqual(
    await handlers.get("memory:resolve-subject-attribution")(null, {
      proposalId: "subject-proposal-1",
      action: "dismiss",
      note: "来源含混",
    }),
    { status: "dismissed" },
  );
  assert.deepEqual(
    await handlers.get("memory:retrieval-traces")(null, { resultStatus: "ready" }),
    [{ id: "trace-1" }],
  );
  assert.deepEqual(
    await handlers.get("memory:retrieval-feedback")(null, {
      traceId: "trace-1",
      signal: "helpful",
      targetMemoryIds: ["memory-1"],
      note: "有帮助",
    }),
    { signal: "helpful" },
  );
  assert.deepEqual(
    await handlers.get("memory:retrieval-stats")(null, { memoryIds: ["memory-1"] }),
    [{ memoryId: "memory-1", selectedCount: 2 }],
  );
  assert.deepEqual(
    await handlers.get("memory:edge-retrieval-stats")(null, { edgeIds: ["edge-1"] }),
    [{ edgeId: "edge-1", traversedCount: 1 }],
  );
  assert.deepEqual(
    await handlers.get("memory:plasticity-preview")(null, { memoryIds: ["memory-1"] }),
    { automaticAdjustmentAllowed: false },
  );
  assert.deepEqual(calls, [
    ["list", { reviewStates: ["pending"] }],
    ["resolve", { proposalId: "proposal-1", action: "accept", note: "确认" }],
    ["subject-list", { reviewStates: ["pending"] }],
    ["subject-resolve", {
      proposalId: "subject-proposal-1",
      action: "dismiss",
      note: "来源含混",
    }],
    ["traces", { resultStatus: "ready" }],
    ["feedback", {
      traceId: "trace-1",
      signal: "helpful",
      targetMemoryIds: ["memory-1"],
      note: "有帮助",
    }],
    ["stats", { memoryIds: ["memory-1"] }],
    ["edge-stats", { edgeIds: ["edge-1"] }],
    ["plasticity", { memoryIds: ["memory-1"] }],
  ]);
});
