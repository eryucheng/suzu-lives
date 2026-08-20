import assert from "node:assert/strict";
import test from "node:test";

import {
  SUZU_AGENT_LIFECYCLE_EVENTS,
  SuzuAgentLifecycleError,
  createSuzuAgentLifecycle,
} from "../src/index.mjs";

test("Suzu lifecycle runs hooks deterministically and isolates observer failures", async () => {
  const calls = [];
  const failures = [];
  const lifecycle = createSuzuAgentLifecycle({
    onError: (failure) => failures.push(failure),
  });
  lifecycle.on("TurnStarting", () => calls.push("later"), { id: "later", order: 10 });
  lifecycle.on("TurnStarting", () => calls.push("first"), { id: "first", order: -5 });
  lifecycle.on("TurnStarting", () => { throw new Error("旁路失败"); }, { id: "observer" });

  const result = await lifecycle.dispatch("TurnStarting", { turnId: "turn-1" });
  assert.deepEqual(calls, ["first", "later"]);
  assert.deepEqual(result.failures, [{
    event: "TurnStarting",
    hookId: "observer",
    message: "旁路失败",
    policy: "observe",
  }]);
  assert.deepEqual(failures, result.failures);
});

test("critical lifecycle hooks fail closed and later hooks do not run", async () => {
  const lifecycle = createSuzuAgentLifecycle();
  let reachedLaterHook = false;
  lifecycle.on("TurnStarting", () => { throw new Error("全局设定无法同步"); }, {
    id: "global-instructions",
    policy: "critical",
  });
  lifecycle.on("TurnStarting", () => { reachedLaterHook = true; }, { id: "later" });

  await assert.rejects(
    lifecycle.dispatch("TurnStarting", { turnId: "turn-2" }),
    (error) => error instanceof SuzuAgentLifecycleError
      && error.code === "CRITICAL_HOOK_FAILED"
      && /全局设定无法同步/u.test(error.message),
  );
  assert.equal(reachedLaterHook, false);
});

test("context collection preserves registered order and has an explicit bounded contract", async () => {
  const lifecycle = createSuzuAgentLifecycle();
  lifecycle.on("ContextCollect", () => ({
    blocks: [{ id: "global", kind: "instructions", priority: 0, text: "全局 Suzu 设定" }],
  }), { id: "instructions", order: -10 });
  lifecycle.on("ContextCollect", () => [
    { kind: "relationship", priority: 10, text: "当前关系上下文" },
    "本轮可选补充",
  ], { id: "relationship" });

  const context = await lifecycle.collectContext({ turnId: "turn-3" });
  assert.deepEqual(context.blocks.map((block) => [block.id, block.kind, block.source, block.text]), [
    ["global", "instructions", "instructions", "全局 Suzu 设定"],
    ["relationship:1", "relationship", "relationship", "当前关系上下文"],
    ["relationship:2", "context", "relationship", "本轮可选补充"],
  ]);
});

test("dynamic context collection has the same block contract without invoking durable collectors", async () => {
  const lifecycle = createSuzuAgentLifecycle();
  let durableCollectorRan = false;
  lifecycle.on("ContextCollect", () => { durableCollectorRan = true; }, { id: "durable" });
  lifecycle.on("DynamicContextCollect", () => ({
    id: "current-time",
    kind: "time-awareness",
    display: { category: "time", context: true, label: "时间感知", transcript: false },
    text: "你知道现在是10月1日 星期二 10:00。",
  }), { id: "time-awareness" });

  const context = await lifecycle.collectDynamicContext({ turnId: "turn-4" });
  assert.equal(durableCollectorRan, false);
  assert.deepEqual(context.blocks.map((block) => [block.id, block.kind, block.source]), [
    ["current-time", "time-awareness", "time-awareness"],
  ]);
  assert.deepEqual(context.blocks[0].display, { category: "time", context: true, label: "时间感知", transcript: false });
});

test("timed-out observer hooks are reported without blocking the turn", async () => {
  const lifecycle = createSuzuAgentLifecycle({ defaultTimeoutMs: 10 });
  lifecycle.on("AssistantDelta", () => new Promise(() => {}), { id: "slow" });
  const result = await lifecycle.dispatch("AssistantDelta", { text: "hi" });
  assert.equal(result.failures[0].hookId, "slow");
  assert.equal(result.failures[0].policy, "observe");
  assert.match(result.failures[0].message, /10ms/u);
});

test("all Hook names use one formal PascalCase vocabulary", () => {
  assert.equal(SUZU_AGENT_LIFECYCLE_EVENTS.includes("PreToolUse"), true);
  assert.equal(SUZU_AGENT_LIFECYCLE_EVENTS.includes("ContextCollect"), true);
  assert.equal(SUZU_AGENT_LIFECYCLE_EVENTS.includes("DynamicContextCollect"), true);
  assert.equal(SUZU_AGENT_LIFECYCLE_EVENTS.includes("DynamicContextExpired"), true);
  assert.equal(SUZU_AGENT_LIFECYCLE_EVENTS.some((event) => event.includes(".") || event.startsWith("suzu.")), false);
});

test("PreToolUse decisions are deterministic and cannot undo a denial", async () => {
  const lifecycle = createSuzuAgentLifecycle();
  lifecycle.on("PreToolUse", () => ({ kind: "allow" }), { id: "allow", order: -10 });
  lifecycle.on("PreToolUse", () => ({ kind: "ask", reason: "需要确认" }), { id: "ask" });
  lifecycle.on("PreToolUse", () => ({ kind: "deny", reason: "当前操作不允许" }), { id: "deny", order: 10 });
  lifecycle.on("PreToolUse", () => ({ kind: "allow" }), { id: "too-late", order: 20 });

  const outcome = await lifecycle.decide("PreToolUse", { toolName: "pwsh" });
  assert.deepEqual(outcome.decision, { kind: "deny", reason: "当前操作不允许" });
  assert.deepEqual(outcome.decisions.map((entry) => entry.hookId), ["allow", "ask", "deny", "too-late"]);
});
