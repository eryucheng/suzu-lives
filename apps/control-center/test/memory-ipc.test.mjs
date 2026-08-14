import assert from "node:assert/strict";
import test from "node:test";

import { registerMemoryIpc } from "../electron/ipc/memory-ipc.mjs";

test("memory IPC requires the embedded service and forwards React memory actions by contact", async () => {
  const handlers = new Map();
  const calls = [];
  const ipcMain = {
    handle(channel, callback) {
      handlers.set(channel, callback);
    },
  };
  const memoryService = {
    status(scope) { calls.push(["status", scope]); return {}; },
    search(query, scope) { calls.push(["search", query, scope]); return {}; },
    brainGraph(scope) { calls.push(["brain", scope]); return {}; },
    list(filters) { calls.push(["list", filters]); return {}; },
    detail(memoryId, scope) { calls.push(["detail", memoryId, scope]); return {}; },
    edit(memoryId, patch, reason, scope) { calls.push(["edit", memoryId, patch, reason, scope]); return {}; },
    remove(memoryId, reason, scope) { calls.push(["remove", memoryId, reason, scope]); return {}; },
    restore(memoryId, reason, scope) { calls.push(["restore", memoryId, reason, scope]); return {}; },
    reviewOverview(filters) { calls.push(["overview", filters]); return {}; },
    reviewProposal(payload) { calls.push(["proposal", payload]); return {}; },
    resolveReview(payload) { calls.push(["resolve", payload]); return {}; },
    retryLongTermExtractionReview(payload) { calls.push(["retry-long-term-extraction", payload]); return {}; },
    revokeReviewRelation(payload) { calls.push(["revoke", payload]); return {}; },
    recoverReviewInputBatch(payload) { calls.push(["recover", payload]); return {}; },
    createReviewBackup(scope) { calls.push(["backup", scope]); return {}; },
    inspectReviewBackup(payload) { calls.push(["inspect-backup", payload]); return {}; },
    restoreReviewBackup(payload) { calls.push(["restore-backup", payload]); return {}; },
    inspectMemoryImport(payload) { calls.push(["inspect-import", payload]); return {}; },
    importMemoryDatabase(payload) { calls.push(["import-database", payload]); return {}; },
  };

  assert.throws(
    () => registerMemoryIpc({ ipcMain: { handle() {} } }),
    /嵌入式长期记忆服务/u,
  );
  registerMemoryIpc({
    ipcMain,
    memoryService,
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: ["C:/tmp/memory-backup.db"] }),
    },
  });

  const contactId = "contact-suzu";
  await handlers.get("memory:status")(null, { contactId });
  await handlers.get("memory:search")(null, { query: "晚饭", contactId });
  await handlers.get("memory:brain-graph")(null, { contactId });
  await handlers.get("memory:list")(null, { contactId, limit: 20 });
  await handlers.get("memory:detail")(null, { memoryId: "memory-1", contactId });
  await handlers.get("memory:edit")(null, { memoryId: "memory-1", patch: { title: "新标题" }, reason: "修正", contactId });
  await handlers.get("memory:delete")(null, { memoryId: "memory-1", reason: "重复", contactId });
  await handlers.get("memory:restore")(null, { memoryId: "memory-1", reason: "恢复", contactId });
  await handlers.get("memory:review-overview")(null, { contactId, reviewStates: ["pending"] });
  await handlers.get("memory:review-proposal")(null, { type: "relation", proposalId: "review-1", contactId });
  await handlers.get("memory:resolve-review")(null, { type: "structure", proposalId: "review-2", action: "accept", note: "确认", contactId });
  await handlers.get("memory:retry-long-term-extraction-review")(null, { proposalId: "review-2a", note: "重试", contactId });
  await handlers.get("memory:revoke-review-relation")(null, { proposalId: "review-3", note: "撤销", contactId });
  await handlers.get("memory:recover-review-input-batch")(null, { batchId: "batch-1", force: true, contactId });
  await handlers.get("memory:create-review-backup")(null, { contactId });
  await handlers.get("memory:select-review-backup")(null);
  await handlers.get("memory:select-import-database")(null);
  await handlers.get("memory:inspect-review-backup")(null, { sourcePath: "C:/tmp/memory-backup.db", contactId });
  await handlers.get("memory:inspect-import-database")(null, { sourcePath: "C:/tmp/memory-import.db", contactId });
  await handlers.get("memory:restore-review-backup")(null, { sourcePath: "C:/tmp/memory-backup.db", contactId });
  await handlers.get("memory:import-database")(null, { sourcePath: "C:/tmp/memory-import.db", contactId });

  assert.deepEqual(calls, [
    ["status", { contactId }],
    ["search", "晚饭", { contactId }],
    ["brain", { contactId }],
    ["list", { contactId, limit: 20 }],
    ["detail", "memory-1", { contactId }],
    ["edit", "memory-1", { title: "新标题" }, "修正", { contactId }],
    ["remove", "memory-1", "重复", { contactId }],
    ["restore", "memory-1", "恢复", { contactId }],
    ["overview", { contactId, reviewStates: ["pending"] }],
    ["proposal", { type: "relation", proposalId: "review-1", contactId }],
    ["resolve", { type: "structure", proposalId: "review-2", action: "accept", note: "确认", contactId }],
    ["retry-long-term-extraction", { proposalId: "review-2a", note: "重试", contactId }],
    ["revoke", { proposalId: "review-3", note: "撤销", contactId }],
    ["recover", { batchId: "batch-1", force: true, contactId }],
    ["backup", { contactId }],
    ["inspect-backup", { sourcePath: "C:/tmp/memory-backup.db", contactId }],
    ["inspect-import", { sourcePath: "C:/tmp/memory-import.db", contactId }],
    ["restore-backup", { sourcePath: "C:/tmp/memory-backup.db", contactId }],
    ["import-database", { sourcePath: "C:/tmp/memory-import.db", contactId }],
  ]);
});
