import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  SuzuAgentRuntimeError,
  createSuzuAgentRuntimeDriver,
} from "../src/index.mjs";

function ok(value) {
  return { rpcId: "rpc-response", result: { ok: true, value } };
}

function createAsyncQueue() {
  const values = [];
  const waiters = [];
  let done = false;
  return {
    push(value) {
      if (done) throw new Error("stream already closed");
      const waiter = waiters.shift();
      if (waiter) waiter({ done: false, value });
      else values.push(value);
    },
    close() {
      done = true;
      while (waiters.length) waiters.shift()({ done: true, value: undefined });
    },
    async *iterate() {
      while (true) {
        if (values.length) {
          yield values.shift();
          continue;
        }
        if (done) return;
        const next = await new Promise((resolve) => waiters.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    },
  };
}

function createFakeAgentCoreApi() {
  const mux = createAsyncQueue();
  const host = createAsyncQueue();
  let beforePromptResponse = null;
  const calls = {
    create: [],
    prompt: [],
    cancel: [],
    history: [],
    respond: [],
  };
  const api = {
    sessions: {
      async create(request) {
        calls.create.push(request);
        return ok({ sessionId: request.sessionId });
      },
      async prompt(request) {
        calls.prompt.push(request);
        await beforePromptResponse?.(request);
        return ok({ accepted: true });
      },
      async cancel(request) {
        calls.cancel.push(request);
        return ok({ accepted: true });
      },
      async history(request) {
        calls.history.push(request);
        return ok({ events: [], hasMore: false });
      },
    },
    events: {
      mux(_payload, _signal, onOpen) { onOpen?.(); return mux.iterate(); },
      host(_payload, _signal, onOpen) { onOpen?.(); return host.iterate(); },
    },
    async respond(message) {
      calls.respond.push(message);
      return { accepted: true };
    },
  };
  return {
    api,
    calls,
    emitMux(payload, rpcId = "server-rpc") { mux.push({ rpcId, payload }); },
    emitHost(payload, rpcId = "host-rpc") { host.push({ rpcId, payload }); },
    setBeforePromptResponse(handler) { beforePromptResponse = handler; },
    close() { mux.close(); host.close(); },
  };
}

async function flushEvents() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

const resources = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map(async ({ driver, fake }) => {
    fake.close();
    await driver.close();
  }));
});

function setup() {
  const fake = createFakeAgentCoreApi();
  const driver = createSuzuAgentRuntimeDriver({ api: fake.api });
  resources.push({ driver, fake });
  return { driver, fake };
}

async function createSession(driver) {
  return driver.createSession({
    sessionId: "suzu-session-1",
    cwd: "D:\\Temp\\suzu-agent-core-test-cwd",
    presentation: { agentPreset: "standard" },
  });
}

test("Agent Core driver maps one public FIFO text turn into neutral stream events", async () => {
  const { driver, fake } = setup();
  const events = [];
  driver.subscribe((event) => events.push(event));
  const created = await createSession(driver);
  assert.deepEqual(created, { runtimeSessionId: "suzu-session-1", created: true });
  assert.deepEqual(fake.calls.create[0], {
    sessionId: "suzu-session-1",
    cwd: "D:\\Temp\\suzu-agent-core-test-cwd",
    agentPreset: "standard",
  });

  await driver.sendTurn({ runtimeSessionId: created.runtimeSessionId, turnId: "turn-1", input: "你好" });
  assert.deepEqual(fake.calls.prompt[0], {
    sessionId: "suzu-session-1",
    mode: "queue",
    content: [{ type: "text", text: "你好" }],
  });

  fake.emitMux({ type: "session/event", sessionId: "suzu-session-1", event: { type: "turn/start", seq: 1, time: 1, data: { turn: 7 } } });
  fake.emitMux({ type: "session/event", sessionId: "suzu-session-1", event: { type: "assistant/chunk", seq: 2, time: 2, data: { turn: 7, step: 1, chunk: { type: "reasoning-delta", index: 0, text: "先想一想" } } } });
  fake.emitMux({ type: "session/event", sessionId: "suzu-session-1", event: { type: "assistant/chunk", seq: 3, time: 3, data: { turn: 7, step: 1, chunk: { type: "text-delta", index: 1, text: "你" } } } });
  fake.emitMux({ type: "session/event", sessionId: "suzu-session-1", event: { type: "assistant/message", seq: 4, time: 4, data: { turn: 7, step: 1, message: { source: { provider: "DeepSeek", model: "deepseek-v4-flash" }, content: [{ type: "text", text: "你好，世界" }] }, usage: { inputTokens: 11, cacheReadTokens: 3, outputTokens: 5 } } } });
  fake.emitMux({ type: "session/event", sessionId: "suzu-session-1", event: { type: "turn/end", seq: 5, time: 5, data: { turn: 7, reason: { kind: "completed" } } } });
  await flushEvents();

  assert.deepEqual(events.map(({ type, turnId, text }) => ({ type, turnId, text })), [
    { type: "turn-started", turnId: "turn-1", text: "" },
    { type: "assistant-reasoning-delta", turnId: "turn-1", text: "先想一想" },
    { type: "assistant-delta", turnId: "turn-1", text: "你" },
    { type: "model-usage", turnId: "turn-1", text: "" },
    { type: "assistant-completed", turnId: "turn-1", text: "你好，世界" },
  ]);
  assert.deepEqual(events.find((event) => event.type === "model-usage")?.data, {
    coreSequence: 4,
    coreTime: 4,
    purpose: "agent-step",
    usage: { inputTokens: 11, cacheReadTokens: 3, outputTokens: 5 },
    provider: "DeepSeek",
    model: "deepseek-v4-flash",
    coreTurn: 7,
    step: 1,
  });
});

test("Agent Core driver reapplies a contact permission preset when its existing session is reopened", async () => {
  const { driver, fake } = setup();
  const first = await driver.createSession({
    sessionId: "permission-session",
    cwd: "D:\\Temp\\suzu-agent-core-test-cwd",
    presentation: { agentPreset: "standard", permissionMode: "read-only" },
  });
  const reopened = await driver.createSession({
    sessionId: "permission-session",
    cwd: "D:\\Temp\\suzu-agent-core-test-cwd",
    presentation: { agentPreset: "standard", permissionMode: "danger-full-access" },
  });

  assert.deepEqual(first, { runtimeSessionId: "permission-session", created: true });
  assert.deepEqual(reopened, { runtimeSessionId: "permission-session", created: false });
  assert.deepEqual(fake.calls.create, [
    {
      sessionId: "permission-session",
      cwd: "D:\\Temp\\suzu-agent-core-test-cwd",
      agentPreset: "standard",
      permissionMode: "read-only",
    },
    {
      sessionId: "permission-session",
      cwd: "D:\\Temp\\suzu-agent-core-test-cwd",
      agentPreset: "standard",
      permissionMode: "danger-full-access",
    },
  ]);
});

test("Agent Core driver forwards validated native image prompt parts unchanged", async () => {
  const { driver, fake } = setup();
  const { runtimeSessionId } = await createSession(driver);
  await driver.sendTurn({
    runtimeSessionId,
    turnId: "turn-image",
    input: [
      { type: "text", text: "看一下这张图" },
      { type: "image", mediaType: "image/png", data: "aW1hZ2U=", name: "reference.png" },
    ],
  });
  assert.deepEqual(fake.calls.prompt[0], {
    sessionId: runtimeSessionId,
    mode: "queue",
    content: [
      { type: "text", text: "看一下这张图" },
      { type: "image", mediaType: "image/png", data: "aW1hZ2U=", name: "reference.png" },
    ],
  });
});

test("Agent Core driver preserves approval rpcId and tool correlation", async () => {
  const { driver, fake } = setup();
  const events = [];
  driver.subscribe((event) => events.push(event));
  const { runtimeSessionId } = await createSession(driver);
  await driver.sendTurn({ runtimeSessionId, turnId: "turn-tool", input: "执行一下" });

  fake.emitMux({ type: "session/event", sessionId: runtimeSessionId, event: { type: "turn/start", seq: 1, time: 1, data: { turn: 8 } } });
  fake.emitMux({ type: "session/event", sessionId: runtimeSessionId, event: { type: "tool/call", seq: 2, time: 2, data: { turn: 8, step: 1, callId: "call-1", name: "filesystem", arguments: "{\"path\":\"a.txt\"}" } } });
  fake.emitMux({ type: "approval/requested", sessionId: runtimeSessionId, approvalId: "approval-1", toolName: "filesystem", callId: "call-1", reason: "需要写入" }, "approval-rpc-1");
  await flushEvents();

  const approval = events.find((event) => event.type === "tool-approval-requested");
  assert.equal(approval.turnId, "turn-tool");
  assert.equal(approval.toolName, "filesystem");
  assert.equal(approval.approvalId, "approval-1");

  assert.deepEqual(await driver.resolveApproval({ runtimeSessionId, approvalId: "approval-1", decision: "allowed-once" }), { accepted: true });
  assert.deepEqual(fake.calls.respond[0], {
    type: "client-response",
    rpcId: "approval-rpc-1",
    result: {
      ok: true,
      value: {
        sessionId: runtimeSessionId,
        approvalId: "approval-1",
        outcome: "allowed-once",
      },
    },
  });

  fake.emitMux({ type: "session/event", sessionId: runtimeSessionId, event: { type: "tool/result", seq: 3, time: 3, data: { turn: 8, step: 1, message: { source: { callId: "call-1" }, content: [{ type: "tool-result", toolCallId: "call-1", content: "ok", isError: false }] } } } });
  await flushEvents();
  const completion = events.find((event) => event.type === "tool-completed");
  assert.equal(completion.turnId, "turn-tool");
  assert.equal(completion.toolName, "filesystem");
});

test("Agent Core driver exposes approval resolution and durable compaction outcomes", async () => {
  const { driver, fake } = setup();
  const events = [];
  driver.subscribe((event) => events.push(event));
  const { runtimeSessionId } = await createSession(driver);
  await driver.sendTurn({ runtimeSessionId, turnId: "turn-lifecycle", input: "整理上下文" });

  fake.emitMux({ type: "session/event", sessionId: runtimeSessionId, event: { type: "turn/start", seq: 1, time: 1, data: { turn: 12 } } });
  fake.emitMux({ type: "approval/requested", sessionId: runtimeSessionId, approvalId: "approval-2", toolName: "pwsh", callId: "call-2", reason: "需要确认" }, "approval-rpc-2");
  fake.emitMux({ type: "approval/resolved", sessionId: runtimeSessionId, approvalId: "approval-2", toolName: "pwsh", callId: "call-2", decision: "allowed-once" });
  fake.emitMux({ type: "session/event", sessionId: runtimeSessionId, event: { type: "compaction/start", seq: 2, time: 2, data: { compactionId: "compact-1", turn: 12 } } });
  fake.emitMux({ type: "session/event", sessionId: runtimeSessionId, event: { type: "compaction/summary", seq: 3, time: 3, data: { compactionId: "compact-1", turn: 12, provider: "DeepSeek", model: "deepseek-v4-flash", usage: { inputTokens: 13, outputTokens: 7 } } } });
  fake.emitMux({ type: "session/event", sessionId: runtimeSessionId, event: { type: "compaction/end", seq: 4, time: 4, data: { compactionId: "compact-1", turn: 12 } } });
  fake.emitMux({ type: "session/event", sessionId: runtimeSessionId, event: { type: "compaction/start", seq: 5, time: 5, data: { compactionId: "compact-2", turn: 12 } } });
  fake.emitMux({ type: "session/event", sessionId: runtimeSessionId, event: { type: "compaction/end", seq: 6, time: 6, data: { compactionId: "compact-2", turn: 12, error: "summary failed" } } });
  await flushEvents();

  assert.deepEqual(events.map((event) => [event.type, event.turnId, event.approvalId, event.data.compactionId, event.error]), [
    ["turn-started", "turn-lifecycle", "", undefined, ""],
    ["tool-approval-requested", "turn-lifecycle", "approval-2", undefined, ""],
    ["tool-approval-resolved", "turn-lifecycle", "approval-2", undefined, ""],
    ["compaction-started", "turn-lifecycle", "", "compact-1", ""],
    ["model-usage", "turn-lifecycle", "", "compact-1", ""],
    ["compaction-completed", "turn-lifecycle", "", "compact-1", ""],
    ["compaction-started", "turn-lifecycle", "", "compact-2", ""],
    ["compaction-failed", "turn-lifecycle", "", "compact-2", "summary failed"],
  ]);
  assert.deepEqual(events.find((event) => event.type === "model-usage")?.data, {
    coreSequence: 3,
    coreTime: 3,
    purpose: "compaction",
    usage: { inputTokens: 13, outputTokens: 7 },
    provider: "DeepSeek",
    model: "deepseek-v4-flash",
    compactionId: "compact-1",
    coreTurn: 12,
  });
});

test("Agent Core driver only cancels a mapped active turn and forwards the public cancel call", async () => {
  const { driver, fake } = setup();
  const events = [];
  driver.subscribe((event) => events.push(event));
  const { runtimeSessionId } = await createSession(driver);
  await driver.sendTurn({ runtimeSessionId, turnId: "turn-cancel", input: "请停止" });
  await assert.rejects(
    driver.cancelTurn({ runtimeSessionId, turnId: "turn-cancel" }),
    (error) => error instanceof SuzuAgentRuntimeError && error.code === "AGENT_RUNTIME_TURN_NOT_ACTIVE",
  );

  fake.emitMux({ type: "session/event", sessionId: runtimeSessionId, event: { type: "turn/start", seq: 1, time: 1, data: { turn: 9 } } });
  await flushEvents();
  assert.deepEqual(await driver.cancelTurn({ runtimeSessionId, turnId: "turn-cancel" }), { accepted: true });
  assert.deepEqual(fake.calls.cancel, [{ sessionId: runtimeSessionId }]);
  fake.emitMux({ type: "session/event", sessionId: runtimeSessionId, event: { type: "turn/end", seq: 2, time: 2, data: { turn: 9, reason: { kind: "aborted", reason: { kind: "user" } } } } });
  await flushEvents();
  assert.equal(events.at(-1).type, "turn-cancelled");
});

test("Agent Core driver preserves a turn that starts before the prompt receipt", async () => {
  const { driver, fake } = setup();
  const { runtimeSessionId } = await createSession(driver);
  fake.setBeforePromptResponse(async () => {
    fake.emitMux({ type: "session/event", sessionId: runtimeSessionId, event: { type: "turn/start", seq: 1, time: 1, data: { turn: 10 } } });
    await flushEvents();
  });

  await driver.sendTurn({ runtimeSessionId, turnId: "turn-race", input: "请执行" });
  assert.deepEqual(await driver.cancelTurn({ runtimeSessionId, turnId: "turn-race" }), { accepted: true });
  assert.deepEqual(fake.calls.cancel, [{ sessionId: runtimeSessionId }]);
});

test("Agent Core driver reports history and refuses unfinished steer semantics", async () => {
  const { driver, fake } = setup();
  const { runtimeSessionId } = await createSession(driver);
  assert.deepEqual(await driver.resumeSession({ runtimeSessionId }), { events: [], hasMore: false });
  assert.deepEqual(fake.calls.history, [{ sessionId: runtimeSessionId, maxMessages: 1 }]);
  await assert.rejects(
    driver.sendTurn({ runtimeSessionId, turnId: "steer-1", input: "插话", placement: "steer" }),
    (error) => error instanceof SuzuAgentRuntimeError && error.code === "AGENT_RUNTIME_STEER_NOT_READY",
  );
});
