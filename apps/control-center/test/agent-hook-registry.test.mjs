import assert from "node:assert/strict";
import test from "node:test";

import { createSuzuAgentLifecycle } from "@suzu-lives/agent-lifecycle";
import {
  createDefaultSuzuAgentHookModules,
  mountSuzuAgentHooks,
  registerSuzuAgentHooks,
  SuzuAgentHookRegistryError,
} from "../electron/services/agent-hook-registry.mjs";

test("agent hook registry mounts each optional hook by its own declared lifecycle event and detaches it", async () => {
  const lifecycle = createSuzuAgentLifecycle();
  let disposed = 0;
  const registry = mountSuzuAgentHooks({
    agentLifecycle: lifecycle,
    hookModules: [{
      id: "temporary-context",
      lifecycleEvent: "DynamicContextCollect",
      order: -20,
      policy: "observe",
      timeoutMs: 250,
      handler: () => ({ id: "temporary-context:one", kind: "temporary", text: "本轮资料" }),
      dispose: () => { disposed += 1; },
    }],
  });

  assert.deepEqual(registry.hooks, [{
    id: "temporary-context",
    lifecycleEvent: "DynamicContextCollect",
    order: -20,
    policy: "observe",
    timeoutMs: 250,
  }]);
  assert.equal((await lifecycle.collectDynamicContext()).blocks.length, 1);
  assert.equal((await lifecycle.collectContext()).blocks.length, 0);
  assert.equal(registry.dispose(), true);
  assert.equal(registry.dispose(), false);
  assert.equal(disposed, 1);
  assert.equal((await lifecycle.collectDynamicContext()).blocks.length, 0);
});

test("agent hook registry rolls back earlier registrations when a later module cannot mount", async () => {
  const lifecycle = createSuzuAgentLifecycle();
  let disposed = 0;
  assert.throws(() => mountSuzuAgentHooks({
    agentLifecycle: lifecycle,
    hookModules: [{
      id: "first",
      lifecycleEvent: "DynamicContextCollect",
      handler: () => null,
      dispose: () => { disposed += 1; },
    }, {
      id: "bad-event",
      lifecycleEvent: "NotARealLifecycleEvent",
      handler: () => null,
      dispose: () => { disposed += 1; },
    }],
  }), (error) => error?.code === "UNKNOWN_EVENT");
  assert.equal((await lifecycle.collectDynamicContext()).blocks.length, 0);
  assert.equal(disposed, 2);
});

test("default registry contains the time-awareness module and permits an intentionally empty registry", () => {
  const modules = createDefaultSuzuAgentHookModules({ dataRoot: "D:\\Temp\\suzu-lives-agent-hook-registry" });
  assert.deepEqual(modules.map(({ handler: _handler, ...mount }) => mount), [{
    id: "time-awareness",
    lifecycleEvent: "DynamicContextCollect",
    order: -100,
    policy: "observe",
    timeoutMs: 3_000,
  }]);
  const lifecycle = createSuzuAgentLifecycle();
  const registry = registerSuzuAgentHooks({ agentLifecycle: lifecycle, hookModules: [] });
  assert.deepEqual(registry.hooks, []);
  assert.equal(registry.dispose(), true);
});

test("default registry mounts memory recall independently when the memory runtime is available", async () => {
  const modules = createDefaultSuzuAgentHookModules({
    dataRoot: "D:\\Temp\\suzu-lives-agent-hook-registry",
    memoryRuntime: {
      recallForTurn: async () => ({
        contextText: "长期记忆片段",
        memoryContext: { status: "ready", traceId: "trace-1" },
      }),
    },
  });
  assert.deepEqual(modules.map(({ handler: _handler, ...mount }) => mount), [{
    id: "time-awareness",
    lifecycleEvent: "DynamicContextCollect",
    order: -100,
    policy: "observe",
    timeoutMs: 3_000,
  }, {
    id: "memory-recall",
    lifecycleEvent: "DynamicContextCollect",
    order: -80,
    policy: "observe",
    timeoutMs: 10_000,
  }]);
  const lifecycle = createSuzuAgentLifecycle();
  const registry = mountSuzuAgentHooks({ agentLifecycle: lifecycle, hookModules: modules });
  const context = await lifecycle.collectDynamicContext({
    projectRoot: "D:\\Agents\\suzu",
    sessionId: "session-suzu",
    turnId: "turn-1",
    userText: "还记得吗？",
  });
  assert.deepEqual(context.blocks.map((block) => block.kind), ["memory-recall"]);
  assert.equal(registry.dispose(), true);
});

test("agent hook registry rejects malformed modules before mounting", () => {
  const lifecycle = createSuzuAgentLifecycle();
  let disposed = 0;
  assert.throws(
    () => mountSuzuAgentHooks({
      agentLifecycle: lifecycle,
      hookModules: [{
        id: "first-created-module",
        lifecycleEvent: "DynamicContextCollect",
        handler: () => null,
        dispose: () => { disposed += 1; },
      }, {
        id: "missing-handler",
        lifecycleEvent: "DynamicContextCollect",
      }],
    }),
    (error) => error instanceof SuzuAgentHookRegistryError && error.code === "HOOK_HANDLER_REQUIRED",
  );
  assert.equal(disposed, 1);
});
