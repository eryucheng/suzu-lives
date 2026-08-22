import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentRuntimeError,
  createAgentRuntime,
  createFakeAgentRuntimeDriver,
} from "../src/index.mjs";

function fixedIds() {
  let number = 0;
  return (prefix) => `${prefix}-${++number}`;
}

test("maps a Suzu session to one runtime session and emits ordered product events", async () => {
  const driver = createFakeAgentRuntimeDriver();
  const runtime = createAgentRuntime({ driver, createId: fixedIds() });
  const received = [];
  runtime.subscribe((event) => received.push(event));

  const session = await runtime.createSession({ contactId: "contact-1", cwd: "D:\\Suzu\\contact-1" });
  const turn = await runtime.sendTurn({ sessionId: session.sessionId, input: "你好" });

  driver.emit({ type: "turn-started", runtimeSessionId: session.runtimeSessionId, turnId: turn.turnId });
  driver.emit({ type: "assistant-delta", runtimeSessionId: session.runtimeSessionId, turnId: turn.turnId, text: "你好呀" });
  driver.emit({ type: "assistant-completed", runtimeSessionId: session.runtimeSessionId, turnId: turn.turnId, text: "你好呀" });
  driver.emit({ type: "assistant-delta", runtimeSessionId: "unowned-runtime", turnId: turn.turnId, text: "不能泄露" });

  assert.deepEqual(received.map((event) => [event.type, event.sequence, event.sessionId, event.runtimeSessionId, event.turnId, event.text]), [
    ["turn-started", 1, session.sessionId, session.runtimeSessionId, turn.turnId, ""],
    ["assistant-delta", 2, session.sessionId, session.runtimeSessionId, turn.turnId, "你好呀"],
    ["assistant-completed", 3, session.sessionId, session.runtimeSessionId, turn.turnId, "你好呀"],
  ]);
  assert.equal(driver.calls.sendTurn[0].placement, "queue");
  await runtime.closeRuntime();
});

test("passes an internal task through the neutral runtime without creating a text prompt", async () => {
  const driver = createFakeAgentRuntimeDriver();
  const runtime = createAgentRuntime({ driver, createId: fixedIds() });
  const session = await runtime.createSession({ sessionId: "contact-session", cwd: "D:\\Suzu\\contact" });

  const task = await runtime.sendTask({
    sessionId: session.sessionId,
    turnId: "task-1",
    task: { id: "schedule-1", outputPolicy: "silent" },
  });

  assert.equal(task.accepted, true);
  assert.equal(driver.calls.sendTurn.length, 0);
  assert.deepEqual(driver.calls.sendTask, [{
    runtimeSessionId: session.runtimeSessionId,
    turnId: "task-1",
    task: { id: "schedule-1", outputPolicy: "silent" },
    placement: "queue",
    metadata: {},
  }]);
  await runtime.closeRuntime();
});

test("forwards driver model usage so the product can record live Agent costs", async () => {
  const driver = createFakeAgentRuntimeDriver();
  const runtime = createAgentRuntime({ driver, createId: fixedIds() });
  const received = [];
  runtime.subscribe((event) => received.push(event));

  const session = await runtime.createSession({ sessionId: "contact-session", cwd: "D:\\Suzu\\contact" });
  const turn = await runtime.sendTurn({ sessionId: session.sessionId, input: "你好" });
  const usage = {
    coreSequence: 42,
    coreTime: 1_726_000_000_000,
    purpose: "agent-step",
    provider: "DeepSeek",
    model: "deepseek-v4-flash",
    usage: { inputTokens: 100, cacheReadTokens: 20, outputTokens: 30 },
    coreTurn: 1,
    step: 1,
  };

  driver.emit({
    type: "model-usage",
    runtimeSessionId: session.runtimeSessionId,
    turnId: turn.turnId,
    data: usage,
  });

  assert.deepEqual(received, [{
    type: "model-usage",
    sessionId: session.sessionId,
    runtimeSessionId: session.runtimeSessionId,
    turnId: turn.turnId,
    approvalId: "",
    sequence: 1,
    text: "",
    toolName: "",
    error: "",
    data: usage,
  }]);
  await runtime.closeRuntime();
});

test("coalesces concurrent creation requests for one persistent Suzu session", async () => {
  const driver = createFakeAgentRuntimeDriver();
  const runtime = createAgentRuntime({ driver, createId: fixedIds() });

  const [first, second] = await Promise.all([
    runtime.createSession({ sessionId: "contact-session", contactId: "contact-1", cwd: "D:\\Suzu\\contact-1" }),
    runtime.createSession({ sessionId: "contact-session", contactId: "contact-1", cwd: "D:\\Suzu\\contact-1" }),
  ]);

  assert.equal(driver.calls.createSession.length, 1);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.sessionId, "contact-session");
  assert.equal(second.runtimeSessionId, first.runtimeSessionId);
  await runtime.closeRuntime();
});

test("deduplicates repeated cancellation and never reissues a finished turn cancellation", async () => {
  const driver = createFakeAgentRuntimeDriver();
  const runtime = createAgentRuntime({ driver, createId: fixedIds() });
  const session = await runtime.createSession();
  const turn = await runtime.sendTurn({ sessionId: session.sessionId, input: "请稍等" });

  const [first, second] = await Promise.all([
    runtime.cancelTurn({ sessionId: session.sessionId, turnId: turn.turnId }),
    runtime.cancelTurn({ sessionId: session.sessionId, turnId: turn.turnId }),
  ]);
  assert.deepEqual(first, { accepted: true, alreadyFinished: false, turnId: turn.turnId });
  assert.deepEqual(second, first);
  assert.equal(driver.calls.cancelTurn.length, 1);

  driver.emit({ type: "turn-cancelled", runtimeSessionId: session.runtimeSessionId, turnId: turn.turnId });
  assert.deepEqual(
    await runtime.cancelTurn({ sessionId: session.sessionId, turnId: turn.turnId }),
    { accepted: true, alreadyFinished: true, turnId: turn.turnId },
  );
  assert.equal(driver.calls.cancelTurn.length, 1);
  await runtime.closeRuntime();
});

test("deduplicates approval decisions and treats missing approvals as expired", async () => {
  const driver = createFakeAgentRuntimeDriver();
  const runtime = createAgentRuntime({ driver, createId: fixedIds() });
  const session = await runtime.createSession();
  const turn = await runtime.sendTurn({ sessionId: session.sessionId, input: "打开文件" });
  driver.emit({
    type: "tool-approval-requested",
    runtimeSessionId: session.runtimeSessionId,
    turnId: turn.turnId,
    approvalId: "approval-1",
    toolName: "read_file",
  });

  const [first, second] = await Promise.all([
    runtime.resolveApproval({ sessionId: session.sessionId, approvalId: "approval-1", decision: "rejected" }),
    runtime.resolveApproval({ sessionId: session.sessionId, approvalId: "approval-1", decision: "rejected" }),
  ]);
  assert.deepEqual(first, { accepted: true, expired: false, approvalId: "approval-1", decision: "rejected" });
  assert.deepEqual(second, first);
  assert.equal(driver.calls.resolveApproval.length, 1);
  assert.deepEqual(
    await runtime.resolveApproval({ sessionId: session.sessionId, approvalId: "gone", decision: "allowed-once" }),
    { accepted: false, expired: true, approvalId: "gone" },
  );
  await runtime.closeRuntime();
});

test("turn driver failures become a scoped runtime-unavailable event", async () => {
  const driver = createFakeAgentRuntimeDriver();
  driver.sendTurn = async () => { throw new Error("DSH process exited"); };
  const runtime = createAgentRuntime({ driver, createId: fixedIds() });
  const events = [];
  runtime.subscribe((event) => events.push(event));
  const session = await runtime.createSession();

  await assert.rejects(
    runtime.sendTurn({ sessionId: session.sessionId, input: "你好" }),
    (error) => error instanceof AgentRuntimeError && error.code === "RUNTIME_UNAVAILABLE",
  );
  assert.deepEqual(events.map((event) => [event.type, event.sessionId, event.runtimeSessionId, event.data.operation]), [
    ["runtime-unavailable", session.sessionId, session.runtimeSessionId, "发送消息"],
  ]);
  await runtime.closeRuntime();
});

test("validates driver contracts before any product session is created", () => {
  assert.throws(
    () => createAgentRuntime({ driver: {} }),
    (error) => error instanceof AgentRuntimeError && error.code === "DRIVER_CONTRACT_INVALID",
  );
});
