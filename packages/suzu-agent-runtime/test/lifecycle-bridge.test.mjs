import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createSuzuAgentLifecycleBridge,
  createSuzuAgentLifecycleBridgeTransport,
} from "../src/lifecycle-bridge.mjs";
import { SUZU_AGENT_LIFECYCLE_IPC_PROTOCOL } from "../src/lifecycle-ipc.mjs";

function createParentChannel(onRequest) {
  const processRef = new EventEmitter();
  processRef.connected = true;
  processRef.pid = 55221;
  processRef.sent = [];
  processRef.send = (message) => {
    processRef.sent.push(message);
    if (message.kind === "request") {
      queueMicrotask(() => processRef.emit("message", {
        protocol: SUZU_AGENT_LIFECYCLE_IPC_PROTOCOL,
        kind: "response",
        requestId: message.requestId,
        result: onRequest(message),
      }));
    }
    return true;
  };
  return processRef;
}

function createContext() {
  const listeners = new Map();
  return {
    listeners,
    on(event, callback, options) {
      listeners.set(event, { callback, options });
      return () => listeners.delete(event);
    },
  };
}

function createPublishingSession(ctx, {
  id = "session-compatibility",
  provider = "deepseek",
  model = "deepseek-chat",
} = {}) {
  const events = [];
  const surfaceNodes = [];
  const appended = [];
  let publishing = false;
  const session = {
    id,
    events,
    surface: { nodes: surfaceNodes },
    requestHeader: () => ({ config: { provider, model } }),
    append(type, data, options = {}) {
      assert.equal(publishing, false, "a compatibility repair must not reenter Session.append()");
      const event = {
        type,
        seq: events.length,
        time: events.length,
        data,
        ...(options.surfaceOp === undefined ? {} : { surfaceOp: options.surfaceOp }),
        ...(options.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: options.sourceEventSeqs }),
      };
      if (options.surfaceOp === "append") {
        surfaceNodes.push(event.seq);
      } else if (options.surfaceOp?.op === "replace") {
        const start = surfaceNodes.indexOf(options.surfaceOp.start);
        const end = surfaceNodes.indexOf(options.surfaceOp.end);
        assert.ok(start >= 0 && end >= start, "replacement must target an active surface event");
        const shadowedSurfaceNodes = surfaceNodes.slice(start, end + 1);
        const sourceEventSeqs = new Set(options.sourceEventSeqs);
        for (const sequence of shadowedSurfaceNodes) {
          assert.ok(sourceEventSeqs.has(sequence), `replacement must include shadowed surface event ${sequence} in sourceEventSeqs`);
        }
        surfaceNodes.splice(start, end - start + 1, event.seq);
      }
      events.push(event);
      appended.push(event);
      publishing = true;
      try {
        ctx.listeners.get("session/event")?.callback(session, event);
      } finally {
        publishing = false;
      }
      return event;
    },
  };
  return { appended, events, session, surfaceNodes };
}

async function flushDeferredSessionWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

test("bridge injects durable and dynamic blocks through the Agent Core pre-step seam", async () => {
  const channel = createParentChannel((request) => {
    assert.deepEqual(request.payload, { sessionId: "session-1", coreTurn: 4, step: 2 });
    if (request.event === "ContextCollect") {
      return { blocks: [{
        id: "memory-1",
        kind: "memory",
        display: { category: "memory", context: true, label: "记忆召回", transcript: false },
        priority: 5,
        source: "memory",
        text: "用户今天想散步。",
      }] };
    }
    if (request.event === "DynamicContextCollect") {
      return { blocks: [{
        id: "time-1",
        kind: "time-awareness",
        display: { category: "time", context: true, label: "时间感知", transcript: false },
        priority: -100,
        source: "time",
        text: "你知道现在是10月1日 星期二 10:00。",
      }] };
    }
    assert.fail(`unexpected bridge request: ${request.event}`);
  });
  const transport = createSuzuAgentLifecycleBridgeTransport({ processRef: channel, requestTimeoutMs: 50 });
  const created = [];
  const bridge = createSuzuAgentLifecycleBridge({
    transport,
    createMessage(input) {
      created.push(input);
      return { ...input, id: `injected-${created.length}`, role: "user" };
    },
  });
  const ctx = createContext();
  bridge.apply(ctx, { timeoutMs: 50 });

  const outcome = await ctx.listeners.get("agent/pre-step").callback({
    agent: { id: "session-1" },
    turn: 4,
    step: 2,
    signal: { aborted: false },
  }, async () => ({ kind: "enter", messages: [{
    id: "prompt",
    role: "user",
    source: { kind: "user" },
    content: [{ type: "text", text: "你好" }],
  }] }));

  assert.equal(ctx.listeners.get("agent/pre-step").options.prepend, true);
  assert.equal(outcome.kind, "enter");
  assert.equal(outcome.messages.length, 3);
  assert.equal(created[0].content[0].text, "用户今天想散步。");
  assert.deepEqual(created[0].source, {
    kind: "plugin",
    plugin: "suzu-lifecycle-bridge",
    form: "recall",
    block: {
      id: "memory-1",
      kind: "memory",
      display: { category: "memory", context: true, label: "记忆召回", transcript: false },
      metadata: {},
      priority: 5,
      source: "memory",
    },
  });
  assert.match(created[1].content[0].text, /仅供本次模型请求使用/u);
  assert.deepEqual(created[1].source, {
    kind: "plugin",
    plugin: "suzu-lifecycle-bridge",
    form: "snapshot",
    sections: [{
      name: "time-1",
      text: "你知道现在是10月1日 星期二 10:00。",
      id: "time-1",
      kind: "time-awareness",
      display: { category: "time", context: true, label: "时间感知", transcript: false },
      metadata: {},
      priority: -100,
      source: "time",
    }],
  });
  assert.deepEqual(outcome.messages.map((message) => message.id), ["injected-2", "prompt", "injected-1"]);
  assert.equal(channel.sent.some((message) => message.kind === "event" && message.event === "ContextInjected"), true);
  assert.equal(channel.sent.some((message) => message.kind === "event" && message.event === "DynamicContextInjected"), true);
  transport.dispose();
});

test("bridge removes dynamic context from the next model history after a successful request", async () => {
  const channel = createParentChannel((request) => {
    if (request.event === "ContextCollect") return { blocks: [] };
    if (request.event === "DynamicContextCollect") {
      return { blocks: [{ id: "time-1", kind: "time-awareness", text: "你知道现在是10月1日 星期二 10:00。" }] };
    }
    assert.fail(`unexpected bridge request: ${request.event}`);
  });
  const transport = createSuzuAgentLifecycleBridgeTransport({ processRef: channel, requestTimeoutMs: 50 });
  const responseMessages = [];
  const bridge = createSuzuAgentLifecycleBridge({
    transport,
    createMessage(input) {
      return { ...input, id: "dynamic-message-1", role: "user" };
    },
    createResponseMessage(input) {
      responseMessages.push(input);
      return { ...input, id: "dynamic-cleanup-1", role: "assistant" };
    },
    isAgentLoopCall: () => true,
  });
  const ctx = createContext();
  bridge.apply(ctx, { timeoutMs: 50 });

  const events = [{ type: "step/start", seq: 0, time: 0, data: { turn: 4, step: 2 } }];
  const surfaceNodes = [];
  const appended = [];
  const session = {
    id: "session-cleanup",
    events,
    surface: { nodes: surfaceNodes },
    requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
    append(type, data, options) {
      const event = {
        type,
        seq: events.length,
        time: events.length,
        data,
        surfaceOp: options.surfaceOp,
        sourceEventSeqs: options.sourceEventSeqs,
      };
      events.push(event);
      appended.push(event);
      if (options.surfaceOp === "append") {
        surfaceNodes.push(event.seq);
      } else {
        const start = surfaceNodes.indexOf(options.surfaceOp.start);
        const end = surfaceNodes.indexOf(options.surfaceOp.end);
        surfaceNodes.splice(start, end - start + 1, event.seq);
      }
      return event;
    },
  };

  const outcome = await ctx.listeners.get("agent/pre-step").callback({
    agent: { id: session.id, session },
    turn: 4,
    step: 2,
    signal: { aborted: false },
  }, async () => ({ kind: "enter", messages: [] }));
  const dynamicEvent = {
    type: "user/message",
    seq: 1,
    time: 1,
    data: outcome.messages[0],
    surfaceOp: "append",
  };
  events.push(dynamicEvent);
  surfaceNodes.push(dynamicEvent.seq);
  ctx.listeners.get("session/event").callback(session, dynamicEvent);

  const options = Object.freeze({
    sessionId: session.id,
    provider: "deepseek",
    model: "deepseek-chat",
    messages: Object.freeze([]),
  });
  assert.deepEqual(ctx.listeners.get("llm/stream").options, { global: true });
  async function* successfulStream() {
    yield { type: "finish", reason: { kind: "stop" } };
  }
  const chunks = [];
  for await (const chunk of ctx.listeners.get("llm/stream").callback(options, () => successfulStream())) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, [{ type: "finish", reason: { kind: "stop" } }]);
  assert.deepEqual(responseMessages, [{
    content: [],
    source: { provider: "deepseek", model: "deepseek-chat" },
  }]);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].type, "assistant/message");
  assert.deepEqual(appended[0].surfaceOp, { op: "replace", start: 1, end: 1 });
  assert.deepEqual(appended[0].sourceEventSeqs, [1]);
  assert.deepEqual(surfaceNodes, [2]);
  assert.equal(channel.sent.some((message) => message.kind === "event" && message.event === "DynamicContextExpired"), true);
  transport.dispose();
});

test("bridge injects an internal task only for its current turn and removes a silent task surface before the next user turn", async () => {
  const channel = createParentChannel((request) => {
    if (request.event === "ContextCollect") return { blocks: [] };
    if (request.event === "DynamicContextCollect") {
      return { blocks: [{
        id: "automation-task:task-turn",
        kind: "automation-task",
        text: "这是本轮自动任务：安排下一次主动关心。",
      }] };
    }
    assert.fail(`unexpected bridge request: ${request.event}`);
  });
  const transport = createSuzuAgentLifecycleBridgeTransport({ processRef: channel, requestTimeoutMs: 50 });
  const created = [];
  const bridge = createSuzuAgentLifecycleBridge({
    transport,
    createMessage(input) {
      created.push(input);
      return { ...input, id: `message-${created.length}`, role: "user" };
    },
  });
  const ctx = createContext();
  bridge.apply(ctx, { timeoutMs: 50 });
  const { events, session, surfaceNodes } = createPublishingSession(ctx, { id: "task-session" });
  session.append("turn/start", { turn: 12 });
  session.append("step/start", { turn: 12, step: 1 });

  const trigger = {
    id: "task-trigger",
    role: "user",
    content: [],
    source: {
      kind: "plugin",
      plugin: "suzu-lifecycle-bridge",
      form: "task-trigger",
      outputPolicy: "silent",
    },
  };
  const outcome = await ctx.listeners.get("agent/pre-step").callback({
    agent: { id: session.id, session },
    turn: 12,
    step: 1,
    signal: { aborted: false },
  }, async () => ({ kind: "enter", messages: [trigger] }));

  assert.equal(outcome.messages.some((message) => message === trigger), false);
  assert.equal(outcome.messages.length, 1);
  assert.match(created[0].content[0].text, /安排下一次主动关心/u);
  assert.match(created[0].content[0].text, /不是用户新消息/u);

  const dynamic = session.append("user/message", outcome.messages[0], { surfaceOp: "append" });
  const reply = session.append("assistant/message", {
    turn: 12,
    step: 1,
    message: {
      id: "silent-task-reply",
      role: "assistant",
      content: [{ type: "text", text: "内部安排完成。" }],
      source: { kind: "model", provider: "deepseek", model: "deepseek-chat" },
    },
  }, { surfaceOp: "append" });
  session.append("turn/end", { turn: 12, reason: { kind: "completed" } });
  await flushDeferredSessionWork();

  const cleanup = events.at(-1);
  assert.equal(cleanup.type, "user/message");
  assert.deepEqual(cleanup.surfaceOp, { op: "replace", start: dynamic.seq, end: reply.seq });
  assert.deepEqual(cleanup.sourceEventSeqs, [dynamic.seq, reply.seq]);
  assert.equal(cleanup.data.source.kind, "plugin");
  assert.equal(cleanup.data.source.plugin, "suzu-lifecycle-bridge");
  assert.equal(cleanup.data.source.form, "task-cleanup");
  assert.deepEqual(surfaceNodes, [cleanup.seq]);
  transport.dispose();
});

test("bridge also removes an external task when its terminal result is NO_REPLY", async () => {
  const channel = createParentChannel((request) => {
    if (request.event === "ContextCollect") return { blocks: [] };
    if (request.event === "DynamicContextCollect") {
      return { blocks: [{ id: "task-check", kind: "automation-task", text: "判断是否主动关心。" }] };
    }
    assert.fail(`unexpected bridge request: ${request.event}`);
  });
  const transport = createSuzuAgentLifecycleBridgeTransport({ processRef: channel, requestTimeoutMs: 50 });
  const bridge = createSuzuAgentLifecycleBridge({
    transport,
    createMessage: (input) => ({ ...input, id: "dynamic-check", role: "user" }),
  });
  const ctx = createContext();
  bridge.apply(ctx, { timeoutMs: 50 });
  const { events, session, surfaceNodes } = createPublishingSession(ctx, { id: "task-no-reply" });
  session.append("turn/start", { turn: 13 });
  session.append("step/start", { turn: 13, step: 1 });
  const outcome = await ctx.listeners.get("agent/pre-step").callback({
    agent: { id: session.id, session },
    turn: 13,
    step: 1,
    signal: { aborted: false },
  }, async () => ({ kind: "enter", messages: [{
    id: "task-trigger",
    role: "user",
    content: [],
    source: { kind: "plugin", plugin: "suzu-lifecycle-bridge", form: "task-trigger", outputPolicy: "external" },
  }] }));
  const dynamic = session.append("user/message", outcome.messages[0], { surfaceOp: "append" });
  const noReply = session.append("assistant/message", {
    turn: 13,
    step: 1,
    message: {
      id: "check-no-reply",
      role: "assistant",
      content: [{ type: "text", text: "NO_REPLYNO_REPLY" }],
      source: { kind: "model", provider: "deepseek", model: "deepseek-chat" },
    },
  }, { surfaceOp: "append" });
  session.append("turn/end", { turn: 13, reason: { kind: "completed" } });
  await flushDeferredSessionWork();

  const cleanup = events.at(-1);
  assert.equal(cleanup.data.source.form, "task-cleanup");
  assert.deepEqual(cleanup.surfaceOp, { op: "replace", start: dynamic.seq, end: noReply.seq });
  assert.deepEqual(cleanup.sourceEventSeqs, [dynamic.seq, noReply.seq]);
  assert.deepEqual(surfaceNodes, [cleanup.seq]);
  transport.dispose();
});

test("bridge repairs a legacy B task from active model surface before it reads the next human message", async () => {
  const channel = createParentChannel((request) => {
    if (request.event === "ContextCollect" || request.event === "DynamicContextCollect") return { blocks: [] };
    assert.fail(`unexpected bridge request: ${request.event}`);
  });
  const transport = createSuzuAgentLifecycleBridgeTransport({ processRef: channel, requestTimeoutMs: 50 });
  const bridge = createSuzuAgentLifecycleBridge({ transport });
  const ctx = createContext();
  bridge.apply(ctx, { timeoutMs: 50 });
  const { events, session, surfaceNodes } = createPublishingSession(ctx, { id: "legacy-task-session" });
  session.append("turn/start", { turn: 9 });
  const legacyPrompt = [
    "<suzu-schedule-task>",
    "这是链式主动关心的内部安排阶段（B）。",
    "<!-- suzu-lives:display-system -->",
    "</suzu-schedule-task>",
  ].join("\n");
  const legacyInput = session.append("user/message", {
    id: "legacy-b-input",
    role: "user",
    content: [{ type: "text", text: legacyPrompt }],
    source: { kind: "user" },
  }, { surfaceOp: "append" });
  const legacyReply = session.append("assistant/message", {
    turn: 9,
    step: 1,
    message: {
      id: "legacy-b-reply",
      role: "assistant",
      content: [{ type: "text", text: "NO_REPLY" }],
      source: { kind: "model", provider: "deepseek", model: "deepseek-chat" },
    },
  }, { surfaceOp: "append" });
  session.append("turn/end", { turn: 9, reason: { kind: "completed" } });

  const outcome = await ctx.listeners.get("agent/pre-step").callback({
    agent: { id: session.id, session },
    turn: 10,
    step: 1,
    signal: { aborted: false },
  }, async () => ({ kind: "enter", messages: [{
    id: "real-user-message",
    role: "user",
    content: [{ type: "text", text: "不要" }],
    source: { kind: "user" },
  }] }));

  assert.equal(outcome.messages.at(-1).id, "real-user-message");
  const cleanup = events.at(-1);
  assert.equal(cleanup.type, "user/message");
  assert.deepEqual(cleanup.surfaceOp, { op: "replace", start: legacyInput.seq, end: legacyReply.seq });
  assert.deepEqual(cleanup.sourceEventSeqs, [legacyInput.seq, legacyReply.seq]);
  assert.equal(cleanup.data.source.form, "task-cleanup");
  assert.deepEqual(surfaceNodes, [cleanup.seq]);
  transport.dispose();
});

test("bridge asks PreToolUse at the real pre-body tool seam and honors a denial", async () => {
  const channel = createParentChannel((request) => {
    assert.equal(request.event, "PreToolUse");
    assert.equal(request.payload.sessionId, "session-2");
    assert.equal(request.payload.toolName, "pwsh");
    return { decision: { kind: "deny", reason: "这个 Hook 明确拒绝了调用" } };
  });
  const transport = createSuzuAgentLifecycleBridgeTransport({ processRef: channel, requestTimeoutMs: 50 });
  const bridge = createSuzuAgentLifecycleBridge({ transport, createMessage: (input) => input });
  const ctx = createContext();
  bridge.apply(ctx, { timeoutMs: 50 });
  let reachedProvider = false;

  const outcome = await ctx.listeners.get("tools/pre-execute").callback({
    agent: { id: "session-2" },
    arguments: { command: "Get-ChildItem" },
    callId: "call-1",
    rootCallId: "call-1",
    name: "pwsh",
  }, async () => {
    reachedProvider = true;
    return { kind: "allow" };
  });

  assert.equal(ctx.listeners.get("tools/pre-execute").options.prepend, true);
  assert.equal(reachedProvider, true);
  assert.deepEqual(outcome, { kind: "deny", reason: "这个 Hook 明确拒绝了调用" });
  transport.dispose();
});

test("bridge transport answers a parent-owned product command without treating it as a lifecycle Hook", async () => {
  const channel = createParentChannel(() => ({}));
  const transport = createSuzuAgentLifecycleBridgeTransport({ processRef: channel, requestTimeoutMs: 50 });
  const detach = transport.handleCommand("StructuredGenerate", async (payload) => ({
    ok: true,
    echoedInput: payload.input,
  }));

  channel.emit("message", {
    protocol: SUZU_AGENT_LIFECYCLE_IPC_PROTOCOL,
    kind: "command",
    requestId: "structured-1",
    event: "StructuredGenerate",
    payload: { input: "只返回 JSON" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(channel.sent.at(-1), {
    protocol: SUZU_AGENT_LIFECYCLE_IPC_PROTOCOL,
    kind: "response",
    requestId: "structured-1",
    result: { ok: true, echoedInput: "只返回 JSON" },
  });
  assert.equal(detach(), true);
  transport.dispose();
});

test("bridge durably retains streamed text and reasoning before an aborted Agent Core turn closes", async () => {
  const channel = createParentChannel(() => ({ blocks: [] }));
  const transport = createSuzuAgentLifecycleBridgeTransport({ processRef: channel, requestTimeoutMs: 50 });
  const bridge = createSuzuAgentLifecycleBridge({
    transport,
    isAgentLoopCall: () => true,
  });
  const ctx = createContext();
  bridge.apply(ctx, { timeoutMs: 50 });
  const { events, session } = createPublishingSession(ctx, { id: "session-aborted" });
  session.append("turn/start", { turn: 8 });
  session.append("step/start", { turn: 8, step: 3 });

  const controller = new AbortController();
  async function* source() {
    yield { type: "block-start", index: 0, blockType: "reasoning" };
    yield { type: "reasoning-delta", index: 0, text: "先想一想" };
    yield { type: "block-start", index: 1, blockType: "text" };
    yield { type: "text-delta", index: 1, text: "已经说出的回答" };
    yield { type: "usage", usage: { inputTokens: 7, outputTokens: 4 } };
    yield { type: "text-delta", index: 1, text: "不应被读取" };
  }

  const stream = ctx.listeners.get("llm/stream").callback({
    sessionId: session.id,
    signal: controller.signal,
  }, () => source());

  await assert.rejects(async () => {
    for await (const chunk of stream) {
      session.append("assistant/chunk", { turn: 8, step: 3, chunk });
      if (chunk.type === "usage") {
        controller.abort();
        throw new Error("cancelled by the agent loop");
      }
    }
  }, /cancelled by the agent loop/u);

  const partial = events.at(-1);
  assert.equal(partial.type, "assistant/message");
  assert.equal(partial.data.interrupted, true);
  assert.deepEqual(partial.data.message.content, [
    { type: "reasoning", text: "先想一想" },
    { type: "text", text: "已经说出的回答" },
  ]);
  assert.deepEqual(partial.data.usage, { inputTokens: 7, outputTokens: 4 });
  assert.deepEqual(partial.sourceEventSeqs, [2, 3, 4, 5, 6]);

  session.append("step/end", { turn: 8, step: 3 });
  session.append("turn/end", { turn: 8, reason: { kind: "aborted", reason: { kind: "user" } } });
  await flushDeferredSessionWork();
  assert.equal(events.filter((event) => event.type === "assistant/message").length, 1);
  transport.dispose();
});

test("bridge removes stale replay metadata after max tokens drops a tool call", async () => {
  const channel = createParentChannel(() => ({ blocks: [] }));
  const transport = createSuzuAgentLifecycleBridgeTransport({ processRef: channel, requestTimeoutMs: 50 });
  const bridge = createSuzuAgentLifecycleBridge({ transport });
  const ctx = createContext();
  bridge.apply(ctx, { timeoutMs: 50 });
  const { events, session, surfaceNodes } = createPublishingSession(ctx, { id: "session-max-tokens" });
  session.append("turn/start", { turn: 9 });
  session.append("step/start", { turn: 9, step: 1 });
  session.append("assistant/chunk", {
    turn: 9,
    step: 1,
    chunk: { type: "text-delta", index: 0, text: "保留的文字" },
  });
  session.append("assistant/chunk", {
    turn: 9,
    step: 1,
    chunk: { type: "tool-call-delta", index: 1, id: "call-1", name: "pwsh", argumentsDelta: "{}" },
  });
  session.append("assistant/chunk", {
    turn: 9,
    step: 1,
    chunk: { type: "finish", reason: { kind: "max-tokens" } },
  });
  const dynamicSnapshot = session.append("user/message", {
    id: "dynamic-context-before-repair",
    role: "user",
    content: [{ type: "text", text: "仅本轮上下文" }],
    source: { kind: "plugin", plugin: "suzu-lifecycle-bridge" },
  }, { surfaceOp: "append" });
  session.append("assistant/message", {
    turn: 9,
    step: 1,
    message: {
      id: "dynamic-context-expired",
      role: "assistant",
      content: [],
      source: { kind: "model", provider: "deepseek", model: "deepseek-chat" },
    },
  }, {
    surfaceOp: { op: "replace", start: dynamicSnapshot.seq, end: dynamicSnapshot.seq },
    sourceEventSeqs: [dynamicSnapshot.seq],
  });
  const original = session.append("assistant/message", {
    turn: 9,
    step: 1,
    message: {
      id: "assistant-before-repair",
      role: "assistant",
      content: [{ type: "text", text: "保留的文字" }],
      source: {
        kind: "model",
        provider: "deepseek",
        model: "deepseek-chat",
        replayState: {
          version: 1,
          blocks: [{ type: "text" }, { type: "tool-call" }],
        },
      },
    },
    usage: { inputTokens: 11, outputTokens: 5 },
  }, {
    surfaceOp: "append",
    sourceEventSeqs: [2, 3, 4],
  });

  await flushDeferredSessionWork();
  const repaired = events.at(-1);
  assert.equal(repaired.type, "assistant/message");
  assert.deepEqual(repaired.surfaceOp, { op: "replace", start: original.seq, end: original.seq });
  assert.deepEqual(repaired.sourceEventSeqs, [original.seq]);
  assert.equal(repaired.data.message.source.replayState, undefined);
  assert.deepEqual(repaired.data.message.content, [{ type: "text", text: "保留的文字" }]);
  assert.equal("usage" in repaired.data, false);
  assert.equal(surfaceNodes.at(-1), repaired.seq);
  transport.dispose();
});
