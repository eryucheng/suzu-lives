import assert from "node:assert/strict";
import test from "node:test";

import {
  createMemoryRecallContextHook,
  MEMORY_RECALL_HOOK_MOUNT,
} from "../electron/services/memory-recall-hook.mjs";

test("memory recall declares a request-only dynamic lifecycle mount", () => {
  assert.deepEqual(MEMORY_RECALL_HOOK_MOUNT, {
    id: "memory-recall",
    lifecycleEvent: "DynamicContextCollect",
    order: -80,
    policy: "observe",
    timeoutMs: 10_000,
  });
});

test("memory recall turns the existing per-turn retrieval into a hidden queryable context block", async () => {
  const calls = [];
  const hook = createMemoryRecallContextHook({
    memoryRuntime: {
      async recallForTurn(value) {
        calls.push(value);
        return {
          contextText: "这是以前说过的旅行计划。",
          memoryContext: {
            fragments: [{ memoryIds: ["memory-1", "memory-2"] }],
            query: "还记得旅行计划吗？",
            status: "ready",
            traceId: "trace-1",
          },
        };
      },
    },
  });

  const block = await hook.collect({
    contactId: "contact-suzu",
    projectRoot: "D:\\Agents\\suzu",
    sessionId: "session-suzu",
    turnId: "turn-1",
    userText: "还记得旅行计划吗？",
  });

  assert.deepEqual(calls, [{
    projectRoot: "D:\\Agents\\suzu",
    sessionId: "session-suzu",
    turnId: "turn-1",
    userText: "还记得旅行计划吗？",
  }]);
  assert.equal(block?.id, "memory-recall:turn-1:trace-1");
  assert.equal(block?.kind, "memory-recall");
  assert.equal(block?.text, "这是以前说过的旅行计划。");
  assert.deepEqual(block?.display, {
    category: "memory",
    context: true,
    label: "记忆召回",
    transcript: false,
  });
  assert.deepEqual(block?.metadata, {
    fragmentCount: 1,
    memoryIds: ["memory-1", "memory-2"],
    query: "还记得旅行计划吗？",
    retrievalStatus: "ready",
    traceId: "trace-1",
  });
});

test("memory recall fails open when the current turn has no usable context", async () => {
  const noContext = createMemoryRecallContextHook({
    memoryRuntime: {
      recallForTurn: async () => ({ contextText: "", memoryContext: { status: "no-match" } }),
    },
  });
  assert.equal(await noContext.collect({
    projectRoot: "D:\\Agents\\suzu",
    sessionId: "session-suzu",
    turnId: "turn-1",
    userText: "你好",
  }), null);

  const unavailable = createMemoryRecallContextHook({
    memoryRuntime: {
      recallForTurn: async () => { throw new Error("memory unavailable"); },
    },
  });
  assert.equal(await unavailable.collect({
    projectRoot: "D:\\Agents\\suzu",
    sessionId: "session-suzu",
    turnId: "turn-1",
    userText: "你好",
  }), null);
});
