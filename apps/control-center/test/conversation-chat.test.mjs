import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createSuzuAgentLifecycle } from "@suzu-lives/agent-lifecycle";
import { createCapabilityRegistry, createCapabilityRuntime } from "../electron/services/capability-registry.mjs";
import { createConversationChatService } from "../electron/services/conversation-chat.mjs";
import { createConversationAttachmentService } from "../electron/services/conversation-attachment-service.mjs";
import {
  createConversationReader,
  conversationContextRecords,
  conversationDisplayMessages,
} from "../electron/services/conversation-reader.mjs";
import { resolveSuzuAgentRuntimePaths } from "../electron/services/suzu-agent-runtime.mjs";
import { SUZU_SOFTWARE_ASSISTANT_SESSION_ID } from "../electron/services/software-assistant-service.mjs";

async function temporaryRoot() {
  const root = process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp";
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, "suzu-lives-agent-core-chat-"));
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(check, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = check();
    if (value) return value;
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("等待异步 Agent Core 桥接结果超时。 ");
}

function createFakeRuntime({ history = { events: [], hasMore: false } } = {}) {
  const listeners = new Set();
  const calls = {
    cancelTurn: [],
    ensureSession: [],
    history: [],
    respondLifecycleRequest: [],
    resolveApproval: [],
    sendTask: [],
    sendTurn: [],
    close: 0,
  };
  return {
    calls,
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    async ensureSession(value) {
      calls.ensureSession.push(value);
      return { sessionId: value.sessionId, runtimeSessionId: value.sessionId, created: true };
    },
    async sendTurn(value) {
      calls.sendTurn.push(value);
      return { accepted: true, turnId: value.turnId, queued: true };
    },
    async sendTask(value) {
      calls.sendTask.push(value);
      return { accepted: true, turnId: value.turnId, queued: true };
    },
    async cancelTurn(value) {
      calls.cancelTurn.push(value);
      return { accepted: true };
    },
    async resolveApproval(value) {
      calls.resolveApproval.push(value);
      return { accepted: true };
    },
    async respondLifecycleRequest(value) {
      calls.respondLifecycleRequest.push(value);
      return true;
    },
    async history(value) {
      calls.history.push(value);
      return history;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() { calls.close += 1; },
  };
}

function fakeReader(projectRoot) {
  return {
    async ensureActiveSession() {
      return { id: "contact-session", projectRoot, hasTranscript: false, approvalMode: "default" };
    },
    async contactIdForSession() { return "contact-suzu"; },
  };
}

test("Agent Core chat keeps Suzu's queue, stream, memory, and terminal event contract", async () => {
  const root = await temporaryRoot();
  const projectRoot = path.join(root, "contact");
  await fs.mkdir(projectRoot, { recursive: true });
  const runtime = createFakeRuntime();
  const events = [];
  const memoryCalls = [];
  const chat = createConversationChatService({
    settingsService: { load: () => ({}) },
    reader: fakeReader(projectRoot),
    runtime,
    memoryRuntime: {
      async prepareTurn(value) { memoryCalls.push({ type: "prepare", value }); return { id: "memory-1" }; },
      async completeTurn(turn, value) { memoryCalls.push({ type: "complete", turn, value }); },
      async abortTurn(turn) { memoryCalls.push({ type: "abort", turn }); },
    },
    onEvent: (event) => events.push(event),
  });

  const accepted = await chat.send({ content: "你好" });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.queued, false);
  assert.deepEqual(runtime.calls.ensureSession[0], {
    sessionId: "contact-session",
    contactId: "contact-suzu",
    cwd: projectRoot,
  });
  assert.deepEqual(runtime.calls.sendTurn[0], {
    sessionId: "contact-session",
    turnId: accepted.requestId,
    input: "你好",
    placement: "queue",
  });
  assert.equal(events.find((event) => event.type === "turn-start")?.requestId, accepted.requestId);

  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: accepted.requestId });
  runtime.emit({ type: "assistant-reasoning-delta", sessionId: "contact-session", turnId: accepted.requestId, text: "先想一想" });
  runtime.emit({ type: "assistant-delta", sessionId: "contact-session", turnId: accepted.requestId, text: "你" });
  runtime.emit({ type: "assistant-delta", sessionId: "contact-session", turnId: accepted.requestId, text: "好，我在。" });
  runtime.emit({ type: "assistant-delta", sessionId: "contact-session", turnId: accepted.requestId, text: "还有半句" });
  runtime.emit({ type: "assistant-completed", sessionId: "contact-session", turnId: accepted.requestId, text: "你好，我在。还有半句" });
  await flush();

  assert.deepEqual(events.filter((event) => event.type === "reply-stream").map((event) => event.content), ["你好，我在。"]);
  assert.equal(events.find((event) => event.type === "thinking")?.requestId, accepted.requestId);
  assert.equal(events.find((event) => event.type === "thinking")?.sessionId, "contact-session");
  assert.equal(events.find((event) => event.type === "reply" && event.done)?.content, "你好，我在。还有半句");
  assert.equal(events.find((event) => event.type === "agent-reply")?.content, "你好，我在。还有半句");
  assert.equal(events.find((event) => event.type === "turn-complete")?.requestId, accepted.requestId);
  assert.deepEqual(memoryCalls.map((item) => item.type), ["prepare", "complete"]);
  assert.equal(memoryCalls[1].value.assistantText, "你好，我在。还有半句");
  chat.dispose();
});

test("Agent Core chat keeps an internal journal turn system-marked and local-only", async () => {
  const root = await temporaryRoot();
  const projectRoot = path.join(root, "contact");
  await fs.mkdir(projectRoot, { recursive: true });
  const runtime = createFakeRuntime();
  const events = [];
  const chat = createConversationChatService({
    settingsService: { load: () => ({}) },
    reader: fakeReader(projectRoot),
    runtime,
    onEvent: (event) => events.push(event),
  });

  const accepted = await chat.sendToSession({
    content: "<suzu-schedule-task>\\n日记\\n</suzu-schedule-task>",
    contactId: "contact-suzu",
    sessionId: "contact-session",
    projectRoot,
    kind: "schedule",
    requestId: "journal-turn",
    scheduleSource: "agent-journal",
    displayAsSystem: true,
    deliverToWechat: false,
  });
  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: accepted.requestId });
  runtime.emit({ type: "assistant-delta", sessionId: "contact-session", turnId: accepted.requestId, text: "今天和你一起完成了同步。" });
  runtime.emit({ type: "assistant-completed", sessionId: "contact-session", turnId: accepted.requestId, text: "今天和你一起完成了同步。" });
  await flush();

  assert.equal(events.some((event) => event.type === "reply" || event.type === "reply-stream"), false);
  const agentReply = events.find((event) => event.type === "agent-reply");
  assert.equal(agentReply?.requestId, "journal-turn");
  assert.equal(agentReply?.sessionId, "contact-session");
  assert.equal(agentReply?.projectRoot, projectRoot);
  assert.equal(agentReply?.kind, "schedule");
  assert.equal(agentReply?.content, "今天和你一起完成了同步。");
  assert.equal(agentReply?.contactId, "contact-suzu");
  assert.equal(agentReply?.displayAsSystem, true);
  assert.equal(agentReply?.deliverToWechat, false);
  assert.equal(agentReply?.scheduleSource, "agent-journal");
  assert.ok(agentReply?.timestamp);
  assert.equal(events.find((event) => event.type === "turn-complete")?.displayAsSystem, true);
  assert.equal(events.find((event) => event.type === "turn-complete")?.deliverToWechat, false);
  chat.dispose();
});

test("Agent Core chat emits one formal lifecycle and answers real bridge requests", async () => {
  const root = await temporaryRoot();
  const projectRoot = path.join(root, "contact");
  await fs.mkdir(projectRoot, { recursive: true });
  const runtime = createFakeRuntime();
  const events = [];
  const received = [];
  const compactorCalls = [];
  const lifecycle = createSuzuAgentLifecycle();
  lifecycle.on("ContextCollect", (payload) => {
    received.push(["ContextCollect", payload.turnId, payload.coreTurn, payload.step]);
    return { id: "future-memory", kind: "memory", text: "这是未来记忆 Hook 的输出" };
  }, { id: "future-memory" });
  lifecycle.on("DynamicContextCollect", (payload) => {
    received.push(["DynamicContextCollect", payload.turnId, payload.coreTurn, payload.step]);
    return { id: "current-time", kind: "time-awareness", text: "你知道现在是10月1日 星期二 10:00。" };
  }, { id: "time-awareness" });
  lifecycle.on("TurnStarting", (payload) => {
    received.push(["TurnStarting", payload.userText]);
  }, { id: "turn-starting" });
  lifecycle.on("PreToolUse", (payload) => {
    received.push(["PreToolUse", payload.toolName]);
    return { kind: "allow" };
  }, { id: "tool-policy" });
  for (const event of ["UserPromptSubmit", "TurnQueued", "ContactActivated", "SessionStart", "TurnStarted", "ContextInjected", "DynamicContextInjected", "DynamicContextExpired", "AssistantDelta", "ToolStarted", "PostToolUse", "PreCompact", "PostCompact", "Stop"]) {
    lifecycle.on(event, (payload) => received.push([event, payload.toolName || payload.delta || payload.assistantText || payload.sessionId]), { id: event });
  }
  const chat = createConversationChatService({
    settingsService: { load: () => ({}) },
    reader: fakeReader(projectRoot),
    runtime,
    lifecycle,
    compactor: {
      async settingsForRuntime(value) {
        compactorCalls.push(value);
        return {
          available: true,
          prompt: "自定义摘要提示词",
          automatic: { enabled: true, tokenThreshold: 15_000, retainTokens: 5_000 },
          manual: { retainTokens: 5_000 },
        };
      },
    },
    onEvent: (event) => events.push(event),
  });

  const accepted = await chat.send({ content: "只把这句话交给模型" });
  assert.equal(runtime.calls.sendTurn[0].input, "只把这句话交给模型");
  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: accepted.requestId });
  runtime.emit({
    type: "lifecycle-request",
    requestId: "context-1",
    lifecycleEvent: "ContextCollect",
    data: { sessionId: "contact-session", coreTurn: 1, step: 1 },
  });
  await flush();
  assert.equal(runtime.calls.respondLifecycleRequest[0].requestId, "context-1");
  assert.equal(runtime.calls.respondLifecycleRequest[0].result.blocks[0].id, "future-memory");
  runtime.emit({
    type: "lifecycle-event",
    lifecycleEvent: "ContextInjected",
    data: {
      sessionId: "contact-session",
      coreTurn: 1,
      step: 1,
      blocks: runtime.calls.respondLifecycleRequest[0].result.blocks,
    },
  });
  runtime.emit({
    type: "lifecycle-request",
    requestId: "dynamic-context-1",
    lifecycleEvent: "DynamicContextCollect",
    data: { sessionId: "contact-session", coreTurn: 1, step: 1 },
  });
  await flush();
  assert.equal(runtime.calls.respondLifecycleRequest[1].requestId, "dynamic-context-1");
  assert.equal(runtime.calls.respondLifecycleRequest[1].result.blocks[0].id, "current-time");
  runtime.emit({
    type: "lifecycle-event",
    lifecycleEvent: "DynamicContextInjected",
    data: {
      sessionId: "contact-session",
      coreTurn: 1,
      step: 1,
      blocks: runtime.calls.respondLifecycleRequest[1].result.blocks,
    },
  });
  runtime.emit({
    type: "lifecycle-event",
    lifecycleEvent: "DynamicContextExpired",
    data: {
      sessionId: "contact-session",
      coreTurn: 1,
      step: 1,
      blocks: runtime.calls.respondLifecycleRequest[1].result.blocks,
    },
  });
  runtime.emit({
    type: "lifecycle-request",
    requestId: "tool-1",
    lifecycleEvent: "PreToolUse",
    data: { sessionId: "contact-session", callId: "call-1", toolName: "future-capability", arguments: { value: 1 } },
  });
  await flush();
  assert.deepEqual(runtime.calls.respondLifecycleRequest[2], {
    requestId: "tool-1",
    result: { decision: { kind: "allow" } },
  });
  runtime.emit({
    type: "lifecycle-request",
    requestId: "compaction-settings-1",
    lifecycleEvent: "CompactionSettings",
    data: { sessionId: "contact-session" },
  });
  await flush();
  assert.deepEqual(compactorCalls, [{ sessionId: "contact-session", projectRoot: "" }]);
  assert.deepEqual(runtime.calls.respondLifecycleRequest[3], {
    requestId: "compaction-settings-1",
    result: {
      available: true,
      prompt: "自定义摘要提示词",
      automatic: { enabled: true, tokenThreshold: 15_000, retainTokens: 5_000 },
      manual: { retainTokens: 5_000 },
    },
  });
  runtime.emit({ type: "compaction-started", sessionId: "contact-session", turnId: accepted.requestId, data: { compactionId: "compact-1", coreTurn: 1 } });
  runtime.emit({ type: "compaction-completed", sessionId: "contact-session", turnId: accepted.requestId, data: { compactionId: "compact-1", coreTurn: 1 } });
  runtime.emit({ type: "assistant-delta", sessionId: "contact-session", turnId: accepted.requestId, text: "收到" });
  runtime.emit({ type: "tool-started", sessionId: "contact-session", turnId: accepted.requestId, toolName: "future-capability", data: { callId: "call-1" } });
  runtime.emit({ type: "tool-completed", sessionId: "contact-session", turnId: accepted.requestId, toolName: "future-capability", data: { callId: "call-1" } });
  runtime.emit({ type: "assistant-completed", sessionId: "contact-session", turnId: accepted.requestId, text: "收到啦" });
  await flush();

  assert.ok(received.some(([event, value]) => event === "TurnStarting" && value === "只把这句话交给模型"));
  assert.ok(received.some(([event]) => event === "UserPromptSubmit"));
  assert.ok(received.some(([event]) => event === "TurnQueued"));
  assert.ok(received.some(([event]) => event === "ContactActivated"));
  assert.ok(received.some(([event]) => event === "SessionStart"));
  assert.ok(received.some(([event]) => event === "ContextCollect"));
  assert.ok(received.some(([event]) => event === "ContextInjected"));
  assert.ok(received.some(([event]) => event === "DynamicContextCollect"));
  assert.ok(received.some(([event]) => event === "DynamicContextInjected"));
  assert.ok(received.some(([event]) => event === "DynamicContextExpired"));
  assert.ok(received.some(([event, value]) => event === "PreToolUse" && value === "future-capability"));
  assert.ok(received.some(([event, value]) => event === "AssistantDelta" && value === "收到"));
  assert.ok(received.some(([event, value]) => event === "ToolStarted" && value === "future-capability"));
  assert.ok(received.some(([event, value]) => event === "PostToolUse" && value === "future-capability"));
  assert.ok(received.some(([event]) => event === "PreCompact"));
  assert.ok(received.some(([event]) => event === "PostCompact"));
  assert.ok(received.some(([event, value]) => event === "Stop" && value === "收到啦"));
  const toolEvent = events.find((event) => event.type === "tool" && event.phase === "started");
  assert.equal(toolEvent?.requestId, accepted.requestId);
  assert.equal(toolEvent?.toolName, "future-capability");
  assert.equal(toolEvent?.content, "工具调用：future-capability");
  chat.dispose();
  lifecycle.close();
});

test("contact chat leaves the built-in software assistant lifecycle to its isolated service", async () => {
  const root = await temporaryRoot();
  const projectRoot = path.join(root, "contact");
  await fs.mkdir(projectRoot, { recursive: true });
  const runtime = createFakeRuntime();
  const chat = createConversationChatService({
    settingsService: { load: () => ({}) },
    reader: fakeReader(projectRoot),
    runtime,
  });

  runtime.emit({
    type: "lifecycle-request",
    requestId: "software-context-1",
    lifecycleEvent: "ContextCollect",
    data: { sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID, coreTurn: 1, step: 1 },
  });
  await flush();
  assert.deepEqual(runtime.calls.respondLifecycleRequest, []);
  chat.dispose();
});

test("Agent Core chat keeps a scheduled NO_REPLY terminal even after an internal streamed step", async () => {
  const root = await temporaryRoot();
  const projectRoot = path.join(root, "contact");
  await fs.mkdir(projectRoot, { recursive: true });
  const runtime = createFakeRuntime();
  const events = [];
  const chat = createConversationChatService({
    settingsService: { load: () => ({}) },
    reader: fakeReader(projectRoot),
    runtime,
    onEvent: (event) => events.push(event),
  });

  const accepted = await chat.sendToSession({
    content: "<suzu-schedule-task>主动关心判断</suzu-schedule-task>",
    contactId: "contact-suzu",
    sessionId: "contact-session",
    projectRoot,
    kind: "schedule",
    requestId: "proactive-silent-turn",
    scheduleSource: "proactive-chain",
    deliverToWechat: true,
  });
  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: accepted.requestId });
  runtime.emit({ type: "assistant-delta", sessionId: "contact-session", turnId: accepted.requestId, text: "这是给工具的内部安排。" });
  runtime.emit({ type: "assistant-completed", sessionId: "contact-session", turnId: accepted.requestId, text: "NO_REPLYNO_REPLY" });
  await flush();

  assert.equal(events.some((event) => event.type === "agent-reply"), false);
  assert.equal(events.find((event) => event.type === "turn-complete")?.requestId, accepted.requestId);
  chat.dispose();
});

test("internal scheduled work supplies its body through dynamic context and keeps a silent B phase off every reply transport", async () => {
  const root = await temporaryRoot();
  const projectRoot = path.join(root, "contact");
  await fs.mkdir(projectRoot, { recursive: true });
  const runtime = createFakeRuntime();
  const events = [];
  const lifecycleEvents = [];
  const lifecycle = createSuzuAgentLifecycle();
  lifecycle.on("UserPromptSubmit", (payload) => lifecycleEvents.push(["UserPromptSubmit", payload]), { id: "user-submit" });
  lifecycle.on("TurnQueued", (payload) => lifecycleEvents.push(["TurnQueued", payload]), { id: "task-queued" });
  lifecycle.on("TurnStarting", (payload) => lifecycleEvents.push(["TurnStarting", payload]), { id: "task-start" });
  lifecycle.on("DynamicContextCollect", (payload) => {
    lifecycleEvents.push(["DynamicContextCollect", payload]);
    if (!payload.taskContext?.text) return null;
    return {
      id: `task:${payload.turnId}`,
      kind: "automation-task",
      text: payload.taskContext.text,
    };
  }, { id: "task-context" });
  const chat = createConversationChatService({
    settingsService: { load: () => ({}) },
    reader: fakeReader(projectRoot),
    runtime,
    lifecycle,
    onEvent: (event) => events.push(event),
  });

  const accepted = await chat.sendTaskToSession({
    contactId: "contact-suzu",
    sessionId: "contact-session",
    projectRoot,
    requestId: "proactive-b",
    scheduleSource: "proactive-chain-planning",
    outputPolicy: "silent",
    taskContext: { id: "schedule-b", text: "安排下一次主动关心。" },
  });
  assert.equal(runtime.calls.sendTurn.length, 0);
  assert.deepEqual(runtime.calls.sendTask, [{
    sessionId: "contact-session",
    turnId: "proactive-b",
    task: { id: "schedule-b", outputPolicy: "silent" },
    placement: "queue",
  }]);
  assert.equal(lifecycleEvents.some(([name]) => name === "UserPromptSubmit"), false);
  assert.equal(lifecycleEvents.find(([name]) => name === "TurnQueued")?.[1].taskContext?.text, "安排下一次主动关心。");

  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: accepted.requestId });
  runtime.emit({
    type: "lifecycle-request",
    requestId: "task-context-1",
    lifecycleEvent: "DynamicContextCollect",
    data: { sessionId: "contact-session", coreTurn: 3, step: 1 },
  });
  await flush();
  assert.equal(runtime.calls.respondLifecycleRequest.at(-1).result.blocks[0].text, "安排下一次主动关心。");
  runtime.emit({ type: "tool-started", sessionId: "contact-session", turnId: accepted.requestId, toolName: "schedule" });
  runtime.emit({ type: "assistant-delta", sessionId: "contact-session", turnId: accepted.requestId, text: "内部安排完成。" });
  runtime.emit({ type: "assistant-completed", sessionId: "contact-session", turnId: accepted.requestId, text: "完成" });
  await flush();

  assert.equal(events.some((event) => ["reply", "reply-stream", "agent-reply", "tool"].includes(event.type)), false);
  assert.equal(events.find((event) => event.type === "turn-complete")?.requestId, accepted.requestId);
  chat.dispose();
  lifecycle.close();
});

test("a failed internal task releases its conversation queue for the next message", async () => {
  const root = await temporaryRoot();
  const projectRoot = path.join(root, "contact");
  await fs.mkdir(projectRoot, { recursive: true });
  const runtime = createFakeRuntime();
  const events = [];
  const chat = createConversationChatService({
    settingsService: { load: () => ({}) },
    reader: fakeReader(projectRoot),
    runtime,
    onEvent: (event) => events.push(event),
  });

  const task = await chat.sendTaskToSession({
    contactId: "contact-suzu",
    sessionId: "contact-session",
    projectRoot,
    requestId: "stuck-internal-task",
    scheduleSource: "proactive-chain",
    outputPolicy: "silent",
    taskContext: { id: "stuck-task", text: "内部任务" },
  });
  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: task.requestId });
  await flush();

  const queued = await chat.send({ content: "请继续正常聊天", queued: true });
  assert.equal(queued.queued, true);
  assert.equal(runtime.calls.sendTurn.length, 0);

  runtime.emit({
    type: "runtime-unavailable",
    sessionId: "contact-session",
    turnId: task.requestId,
    error: "Agent Core host 事件流不可用：session persistence failed",
  });
  await waitFor(() => runtime.calls.sendTurn.length === 1);

  assert.equal(events.find((event) => event.type === "error" && event.requestId === task.requestId)?.message, "Agent Core host 事件流不可用：session persistence failed");
  assert.equal(runtime.calls.sendTurn[0].input, "请继续正常聊天");
  chat.dispose();
});

test("Agent Core chat answers capability catalog and action bridge requests through the product runtime", async () => {
  const root = await temporaryRoot();
  const projectRoot = path.join(root, "contact");
  await fs.mkdir(projectRoot, { recursive: true });
  const runtime = createFakeRuntime();
  const calls = [];
  const capabilityRuntime = {
    availableActions(context) {
      calls.push({ type: "catalog", context });
      return [{
        capabilityId: "daily-note",
        action: "create",
        actionDescription: "写一条今日记录。",
      }];
    },
    async invoke(context) {
      calls.push({ type: "invoke", context });
      return { status: "completed", value: { entryId: "entry-1" } };
    },
  };
  const chat = createConversationChatService({
    settingsService: { load: () => ({}) },
    reader: fakeReader(projectRoot),
    runtime,
    capabilityRuntime,
  });

  const accepted = await chat.send({ content: "记一下今天的事" });
  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: accepted.requestId });
  runtime.emit({
    type: "lifecycle-request",
    requestId: "capability-catalog-1",
    lifecycleEvent: "CapabilityCatalog",
    data: { sessionId: "contact-session", coreTurn: 7, step: 2 },
  });
  await flush();
  assert.deepEqual(runtime.calls.respondLifecycleRequest.at(-1), {
    requestId: "capability-catalog-1",
    result: {
      actions: [{
        capabilityId: "daily-note",
        action: "create",
        actionDescription: "写一条今日记录。",
      }],
    },
  });
  runtime.emit({
    type: "lifecycle-request",
    requestId: "capability-execute-1",
    lifecycleEvent: "CapabilityExecute",
    data: {
      sessionId: "contact-session",
      coreTurn: 7,
      step: 2,
      capabilityId: "daily-note",
      action: "create",
      input: { text: "今天和 Suzu 散步了。" },
    },
  });
  await flush();
  assert.deepEqual(runtime.calls.respondLifecycleRequest.at(-1), {
    requestId: "capability-execute-1",
    result: { status: "completed", value: { entryId: "entry-1" } },
  });
  assert.deepEqual(calls, [
    {
      type: "catalog",
      context: {
        contactId: "contact-suzu",
        coreTurn: 7,
        projectRoot,
        sessionId: "contact-session",
        step: 2,
        turnId: accepted.requestId,
      },
    },
    {
      type: "invoke",
      context: {
        action: "create",
        capabilityId: "daily-note",
        contactId: "contact-suzu",
        coreTurn: 7,
        input: { text: "今天和 Suzu 散步了。" },
        projectRoot,
        sessionId: "contact-session",
        step: 2,
        turnId: accepted.requestId,
      },
    },
  ]);
  runtime.emit({ type: "assistant-completed", sessionId: "contact-session", turnId: accepted.requestId, text: "已经记下啦。" });
  await flush();
  chat.dispose();
});

test("Agent Core capability bridge gives Agent-created files the durable chat-attachment receipt", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "contact");
  const generatedFile = path.join(projectRoot, "agent-report.txt");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(generatedFile, "这是 Suzu 写好的报告。", "utf8");
  const attachmentService = createConversationAttachmentService({ dataRoot });
  const capabilityRuntime = createCapabilityRuntime({
    registry: createCapabilityRegistry(),
    adapters: {
      "conversation-attachment": ({ context }) => attachmentService.deliver({
        input: context.input,
        projectRoot: context.projectRoot,
        sessionId: context.sessionId,
      }),
    },
  });
  const runtime = createFakeRuntime();
  const chat = createConversationChatService({
    settingsService: { load: () => ({}) },
    reader: fakeReader(projectRoot),
    runtime,
    capabilityRuntime,
  });

  const accepted = await chat.send({ content: "把报告发给我" });
  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: accepted.requestId });
  runtime.emit({
    type: "lifecycle-request",
    requestId: "attachment-catalog",
    lifecycleEvent: "CapabilityCatalog",
    data: { sessionId: "contact-session", coreTurn: 2, step: 3 },
  });
  await flush();
  assert.deepEqual(runtime.calls.respondLifecycleRequest.at(-1), {
    requestId: "attachment-catalog",
    result: {
      actions: [{
        capabilityId: "conversation-attachment",
        capabilityName: "聊天附件交付",
        capabilityDescription: "将 Agent 已生成的本地图片、音频或文件作为聊天附件交付给用户。",
        resourceId: "agent-delivery",
        resourceKind: "runtime",
        driver: "conversation-attachment",
        action: "deliver",
        actionDescription: "将已生成或已确认的本机绝对路径交付到当前聊天。input 必须是 { items: [{ path: \"绝对路径\", kind: \"image\" | \"audio\" | \"file\" }] }；图片支持 AVIF/BMP/GIF/HEIC/ICO/JPG/PNG/SVG/TIFF/WebP，音频仅支持 MP3。动作成功后，附件会出现在当前聊天；已绑定微信的会话会自动转发同一附件。",
        actionName: "发送聊天附件",
      }],
    },
  });
  runtime.emit({
    type: "lifecycle-request",
    requestId: "attachment-deliver",
    lifecycleEvent: "CapabilityExecute",
    data: {
      sessionId: "contact-session",
      coreTurn: 2,
      step: 3,
      capabilityId: "conversation-attachment",
      action: "deliver",
      input: { items: [{ kind: "file", path: generatedFile }] },
    },
  });
  const delivered = await waitFor(() => runtime.calls.respondLifecycleRequest.find((item) => item.requestId === "attachment-deliver"));
  assert.equal(delivered.requestId, "attachment-deliver");
  assert.equal(delivered.result.status, "completed");
  assert.equal(delivered.result.value.type, "suzu-conversation-attachment");
  assert.equal(delivered.result.value.items[0].kind, "file");
  assert.match(delivered.result.value.items[0].path, /[\\/]attachments[\\/]/u);
  assert.equal(await fs.readFile(delivered.result.value.items[0].path, "utf8"), "这是 Suzu 写好的报告。");
  chat.dispose();
});

test("Agent Core forwards a completed attachment receipt to the existing linked-transport event exactly once", async () => {
  const root = await temporaryRoot();
  const projectRoot = path.join(root, "contact");
  const cachedFile = path.join(root, "data", "agents", "agent-suzu", "conversations", "contact-session", "attachments", "report.txt");
  await fs.mkdir(projectRoot, { recursive: true });
  const runtime = createFakeRuntime();
  const events = [];
  const chat = createConversationChatService({
    settingsService: { load: () => ({}) },
    reader: fakeReader(projectRoot),
    runtime,
    onEvent: (event) => events.push(event),
  });

  const accepted = await chat.sendToSession({
    content: "请把报告发来",
    contactId: "contact-suzu",
    sessionId: "contact-session",
    projectRoot,
    deliverToWechat: true,
  });
  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: accepted.requestId });
  const receipt = {
    status: "ok",
    type: "suzu-conversation-attachment",
    receiptId: "attachment-bridge-1",
    items: [{ kind: "file", path: cachedFile, fileName: "report.txt", size: 12 }],
  };
  // This is the public Agent Core runtime shape: tool/result forwards the first
  // tool-result block's content as data.result.
  const result = JSON.stringify(receipt);
  runtime.emit({
    type: "tool-completed",
    sessionId: "contact-session",
    turnId: accepted.requestId,
    toolName: "suzu_capability",
    data: { callId: "attachment-call", result },
  });
  // A stream/replay duplicate must not upload or deliver the same file twice.
  runtime.emit({
    type: "tool-completed",
    sessionId: "contact-session",
    turnId: accepted.requestId,
    toolName: "suzu_capability",
    data: { callId: "attachment-call", result },
  });
  // A forged receipt from an ordinary shell/tool result must not become a
  // cross-transport attachment event.
  runtime.emit({
    type: "tool-completed",
    sessionId: "contact-session",
    turnId: accepted.requestId,
    toolName: "pwsh",
    data: { callId: "forged-call", result },
  });
  await flush();

  const mediaEvents = events.filter((event) => event.type === "agent-media");
  assert.equal(mediaEvents.length, 1);
  assert.deepEqual(mediaEvents[0].media, [{
    kind: "file",
    path: path.resolve(cachedFile),
    fileName: "report.txt",
    size: 12,
  }]);
  assert.equal(mediaEvents[0].deliverToWechat, true);
  chat.dispose();
});

test("Agent Core chat records public model usage into the contact's unified ledger through the registry", async () => {
  const root = await temporaryRoot();
  const projectRoot = path.join(root, "contact");
  await fs.mkdir(projectRoot, { recursive: true });
  const runtime = createFakeRuntime();
  const usageCalls = [];
  const reader = {
    ...fakeReader(projectRoot),
    async resolveContactSession(contactId) {
      return { contactId, id: "contact-session", projectRoot, agentId: "agent-suzu" };
    },
    async resolveCompactorSessionForRuntime({ sessionId }) {
      return { contactId: "contact-suzu", id: sessionId, projectRoot, agentId: "agent-suzu" };
    },
  };
  const chat = createConversationChatService({
    settingsService: {
      load: () => ({ dataRoot: root }),
      usageLedgerPath: ({ agentId, projectRoot: scope }) => path.join(scope, agentId, "ledger.jsonl"),
    },
    reader,
    runtime,
    capabilityRuntime: {
      async recordUsage(value) {
        usageCalls.push(value);
        return [{ status: "completed" }];
      },
    },
  });

  const accepted = await chat.send({ content: "你好" });
  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: accepted.requestId });
  runtime.emit({ type: "tool-started", sessionId: "contact-session", turnId: accepted.requestId, toolName: "calendar" });
  runtime.emit({
    type: "model-usage",
    runtimeSessionId: "contact-session",
    turnId: accepted.requestId,
    data: {
      coreSequence: 4,
      coreTime: 1_000,
      purpose: "agent-step",
      provider: "DeepSeek",
      model: "deepseek-v4-flash",
      usage: { inputTokens: 100, cacheReadTokens: 20, outputTokens: 30 },
      coreTurn: 1,
      step: 1,
    },
  });
  runtime.emit({ type: "assistant-completed", sessionId: "contact-session", turnId: accepted.requestId, text: "你好呀。" });
  await flush();

  runtime.emit({
    type: "model-usage",
    runtimeSessionId: "contact-session",
    data: {
      coreSequence: 9,
      coreTime: 2_000,
      purpose: "compaction",
      provider: "DeepSeek",
      model: "deepseek-v4-flash",
      usage: { inputTokens: 80, outputTokens: 10 },
      compactionId: "compact-1",
      coreTurn: 1,
    },
  });
  await flush();

  assert.equal(usageCalls.length, 2);
  assert.equal(usageCalls[0].capabilityId, "conversation-model");
  assert.equal(usageCalls[0].ledgerPath, path.join(projectRoot, "agent-suzu", "ledger.jsonl"));
  assert.deepEqual(usageCalls[0].event, {
    id: "agent-core:contact-session:4",
    timestamp: "1970-01-01T00:00:01.000Z",
    agentId: "agent-suzu",
    provider: "DeepSeek",
    model: "deepseek-v4-flash",
    source: "Suzu 对话",
    feature: "agent-chat",
    requestId: "agent-core:contact-session:4",
    usage: { inputTokens: 100, cacheReadTokens: 20, outputTokens: 30 },
    units: { inputUncachedTokens: 100, inputCachedTokens: 20, outputTextTokens: 30 },
    metadata: {
      runtime: "agent-core",
      purpose: "agent-step",
      sessionId: "contact-session",
      coreSequence: 4,
      coreTurn: 1,
      step: 1,
      turnId: accepted.requestId,
      turnPrompt: "你好",
      toolNames: ["calendar"],
      cacheReadTokens: 20,
    },
  });
  assert.equal(usageCalls[1].event.feature, "agent-compaction");
  assert.equal(usageCalls[1].event.metadata.compactionId, "compact-1");
  chat.dispose();
});

test("Agent Core chat cancels only a running public turn and removes product-queued work locally", async () => {
  const root = await temporaryRoot();
  const projectRoot = path.join(root, "contact");
  await fs.mkdir(projectRoot, { recursive: true });
  const runtime = createFakeRuntime();
  const events = [];
  const lifecycleEvents = [];
  const lifecycle = createSuzuAgentLifecycle();
  lifecycle.on("StopRequested", (payload) => lifecycleEvents.push(["StopRequested", payload.turnId, payload.reason]), { id: "stop-requested" });
  lifecycle.on("Stop", (payload) => lifecycleEvents.push(["Stop", payload.turnId, payload.outcome]), { id: "stop" });
  const chat = createConversationChatService({ settingsService: { load: () => ({}) }, reader: fakeReader(projectRoot), runtime, lifecycle, onEvent: (event) => events.push(event) });

  const first = await chat.send({ content: "第一条" });
  const second = await chat.send({ content: "第二条" });
  assert.equal(second.queued, true);
  const removed = await chat.stop({ sessionId: "contact-session", projectRoot, requestId: second.requestId });
  assert.equal(removed.stopped, true);
  assert.equal(runtime.calls.sendTurn.length, 1);
  assert.match(events.find((event) => event.requestId === second.requestId && event.type === "turn-stopped")?.message || "", /队列/u);

  const stopping = await chat.stop({ sessionId: "contact-session", projectRoot, requestId: first.requestId });
  assert.equal(stopping.stopped, true);
  assert.equal(runtime.calls.cancelTurn.length, 0);
  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: first.requestId });
  await flush();
  assert.deepEqual(runtime.calls.cancelTurn, [{ sessionId: "contact-session", turnId: first.requestId }]);
  runtime.emit({ type: "turn-cancelled", sessionId: "contact-session", turnId: first.requestId });
  await flush();
  assert.equal(events.find((event) => event.requestId === first.requestId && event.type === "turn-stopped")?.message, "已停止当前 Agent 任务。");
  assert.deepEqual(lifecycleEvents, [
    ["StopRequested", first.requestId, "user"],
    ["StopRequested", second.requestId, "removed-from-queue"],
    ["Stop", first.requestId, "cancelled"],
  ]);
  chat.dispose();
  lifecycle.close();
});

test("steer follows the same interruption path as a direct message", async () => {
  const root = await temporaryRoot();
  const projectRoot = path.join(root, "contact");
  await fs.mkdir(projectRoot, { recursive: true });
  const runtime = createFakeRuntime();
  const chat = createConversationChatService({ settingsService: { load: () => ({}) }, reader: fakeReader(projectRoot), runtime });

  const first = await chat.send({ content: "先处理这件事" });
  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: first.requestId });
  await flush();

  const steered = await chat.steer({ content: "改为处理这件事" });
  assert.equal(steered.accepted, true);
  assert.equal(steered.delivered, true);
  assert.equal(steered.message, "已收到新消息，正在按新要求继续。");
  await flush();
  assert.deepEqual(runtime.calls.cancelTurn, [{ sessionId: "contact-session", turnId: first.requestId }]);

  runtime.emit({ type: "turn-cancelled", sessionId: "contact-session", turnId: first.requestId });
  await waitFor(() => runtime.calls.sendTurn.length === 2);
  assert.equal(runtime.calls.sendTurn.length, 2);
  assert.equal(runtime.calls.sendTurn[1].input, "改为处理这件事");
  chat.dispose();
});

test("Agent Core chat bridges tool approvals and sends image attachments through the native input contract", async () => {
  const root = await temporaryRoot();
  const projectRoot = path.join(root, "contact");
  const image = path.join(root, "reference.png");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl+jh0AAAAASUVORK5CYII=", "base64"));
  const runtime = createFakeRuntime();
  const events = [];
  const lifecycleEvents = [];
  const lifecycle = createSuzuAgentLifecycle();
  lifecycle.on("PermissionRequest", (payload) => lifecycleEvents.push(["PermissionRequest", payload.approvalId, payload.toolName]), { id: "permission-request" });
  lifecycle.on("PermissionResolved", (payload) => lifecycleEvents.push(["PermissionResolved", payload.approvalId, payload.behavior]), { id: "permission-resolved" });
  const chat = createConversationChatService({
    attachmentService: createConversationAttachmentService({ dataRoot: path.join(root, "data") }),
    settingsService: { load: () => ({}) },
    reader: fakeReader(projectRoot),
    runtime,
    lifecycle,
    onEvent: (event) => events.push(event),
  });
  const accepted = await chat.send({ content: "整理文件", media: [{ kind: "image", path: image }] });
  assert.deepEqual(runtime.calls.sendTurn[0].input.map((part) => part.type), ["text", "text", "image"]);
  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: accepted.requestId });
  runtime.emit({
    type: "tool-approval-requested",
    sessionId: "contact-session",
    turnId: accepted.requestId,
    approvalId: "approval-7",
    toolName: "filesystem",
    data: { reason: "需要写入文件" },
  });
  await flush();
  const permission = events.find((event) => event.type === "permission");
  assert.equal(permission.toolName, "filesystem");
  assert.match(permission.preview, /写入/u);
  await chat.respondPermission({ requestId: permission.requestId, behavior: "allow" });
  await flush();
  assert.deepEqual(runtime.calls.resolveApproval, [{
    sessionId: "contact-session",
    approvalId: "approval-7",
    decision: "allowed-once",
  }]);
  assert.deepEqual(lifecycleEvents, [
    ["PermissionRequest", "approval-7", "filesystem"],
    ["PermissionResolved", "approval-7", "allow"],
  ]);
  chat.dispose();
  lifecycle.close();
});

test("Agent Core chat sends enabled image and video understanding results to the main model instead of native media", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "contact");
  const image = path.join(root, "reference.png");
  const video = path.join(root, "moment.mp4");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl+jh0AAAAASUVORK5CYII=", "base64"));
  await fs.writeFile(video, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]));
  const runtime = createFakeRuntime();
  const invocations = [];
  const capabilityRuntime = {
    availableActions({ capabilityId, contactId, projectRoot: scope, sessionId }) {
      assert.equal(contactId, "contact-suzu");
      assert.equal(scope, projectRoot);
      assert.equal(sessionId, "contact-session");
      return [{ capabilityId, action: "analyze" }];
    },
    async invoke(value) {
      invocations.push(value);
      return value.capabilityId === "image-vision"
        ? { status: "completed", value: { answer: "图片里有一只橘猫。" } }
        : { status: "completed", value: { summary: "视频里有人向镜头挥手。" } };
    },
  };
  const chat = createConversationChatService({
    attachmentService: createConversationAttachmentService({ dataRoot }),
    capabilityRuntime,
    settingsService: { load: () => ({}) },
    reader: fakeReader(projectRoot),
    runtime,
  });

  const accepted = await chat.send({
    content: "这两个媒体是什么？",
    media: [
      { kind: "image", path: image },
      { kind: "file", path: video },
    ],
  });

  assert.deepEqual(accepted.media.map((item) => item.kind), ["image", "file"]);
  assert.equal(runtime.calls.sendTurn.length, 1);
  const input = runtime.calls.sendTurn[0].input;
  assert.deepEqual(input.map((part) => part.type), ["text", "text", "text"]);
  assert.equal(input.some((part) => part.type === "image"), false);
  assert.match(input[1].text, /已启用的图像理解能力/u);
  assert.match(input[2].text, /<suzu-media-understanding>/u);
  assert.match(input[2].text, /图片里有一只橘猫/u);
  assert.match(input[2].text, /视频里有人向镜头挥手/u);
  assert.deepEqual(invocations.map((item) => [item.capabilityId, item.action]), [
    ["image-vision", "analyze"],
    ["video-understanding", "analyze"],
  ]);
  assert.match(invocations[0].input.path, /[\\/]attachments[\\/]/u);
  assert.match(invocations[1].input.source, /[\\/]attachments[\\/]/u);

  const messages = conversationDisplayMessages([{
    event: {
      type: "user/message",
      seq: 1,
      time: 1_000,
      surfaceOp: "append",
      data: {
        id: "user-media-understanding",
        source: { kind: "user" },
        content: input,
      },
    },
  }], 500, { dataRoot });
  assert.deepEqual(messages[0].blocks.map((block) => block.kind), ["text", "media", "media"]);
  assert.equal(messages[0].blocks.some((block) => String(block.text || "").includes("suzu-media-understanding")), false);
  chat.dispose();
});

test("Agent Core chat does not submit the main-model turn when enabled media understanding fails", async () => {
  const root = await temporaryRoot();
  const projectRoot = path.join(root, "contact");
  const image = path.join(root, "reference.png");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl+jh0AAAAASUVORK5CYII=", "base64"));
  const runtime = createFakeRuntime();
  const chat = createConversationChatService({
    attachmentService: createConversationAttachmentService({ dataRoot: path.join(root, "data") }),
    capabilityRuntime: {
      availableActions: ({ capabilityId }) => [{ capabilityId, action: "analyze" }],
      async invoke() {
        return { status: "failed", error: { code: "VISION_UNAVAILABLE", message: "图像服务暂时不可用。" } };
      },
    },
    settingsService: { load: () => ({}) },
    reader: fakeReader(projectRoot),
    runtime,
  });

  await assert.rejects(
    chat.send({ content: "看看图片", media: [{ kind: "image", path: image }] }),
    (error) => error?.code === "VISION_UNAVAILABLE" && /图片理解失败：图像服务暂时不可用/u.test(error.message),
  );
  assert.equal(runtime.calls.sendTurn.length, 0);
  chat.dispose();
});

test("Agent Core reader renders the full append-only human transcript after model-surface replacement, searches, and focuses", async () => {
  const projectRoot = "D:\\Contacts\\suzu";
  const history = {
    events: [
      { event: { type: "user/message", seq: 1, time: 1_000, surfaceOp: "append", data: { id: "user-1", source: { kind: "user" }, content: [{ type: "text", text: "旧问题" }] } } },
      { event: { type: "assistant/message", seq: 2, time: 2_000, surfaceOp: "append", data: { message: { id: "assistant-1", content: [{ type: "text", text: "旧回答" }] }, usage: { inputTokens: 3, outputTokens: 2 } } } },
      { event: { type: "user/message", seq: 3, time: 3_000, surfaceOp: { op: "replace", start: 1, end: 2 }, data: { id: "summary-1", source: { kind: "user" }, content: [{ type: "text", text: "压缩后的摘要" }] } } },
      { event: { type: "assistant/message", seq: 4, time: 4_000, surfaceOp: "append", data: { message: { id: "assistant-2", content: [{ type: "reasoning", text: "思考中" }, { type: "text", text: "新的回答" }, { type: "tool-call", name: "read", arguments: "{\"path\":\"a.txt\"}" }] }, usage: { inputTokens: 3, outputTokens: 2 } } } },
    ],
    hasMore: false,
  };
  assert.deepEqual(conversationDisplayMessages(history.events).map((item) => item.id), ["user-1", "assistant-1", "assistant-2"]);
  const runtime = createFakeRuntime({ history });
  const contact = {
    id: "contact-suzu",
    name: "Suzu",
    agentId: "agent-suzu",
    projectRoot,
    sessionId: "contact-session",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    approvalMode: "default",
    longTermMemoryEnabled: true,
  };
  const contacts = {
    status: "ready",
    contactsRoot: "D:\\Contacts",
    contacts: [contact],
    activeContact: contact,
    preferredContact: contact,
  };
  const removals = [];
  const reader = createConversationReader({
    runtime,
    settingsService: { load: () => ({ projectRoot }) },
    contactProjectsService: {
      async snapshot() { return contacts; },
      async updatePresentation() {},
      async updateApprovalMode() {},
      async updateLongTermMemoryEnabled() {},
      async remove(value) { removals.push(value); },
    },
  });
  const snapshot = await reader.snapshot();
  assert.equal(snapshot.activeSessionId, "contact-session");
  assert.equal(snapshot.historyBackend, "agent-core");
  assert.equal(snapshot.contactDeletion?.available, true);
  assert.deepEqual(snapshot.messages.map((item) => item.id), ["user-1", "assistant-1", "assistant-2"]);
  assert.equal(snapshot.messages[2].usage.input, 3);
  assert.equal(snapshot.messages[2].usage.output, 2);
  assert.equal(snapshot.messages[2].usage.total, 5);
  assert.equal(snapshot.messages[2].blocks.some((block) => block.kind === "tool_use"), true);
  const search = await reader.search("新的回答");
  assert.equal(search.matches.length, 1);
  const focus = await reader.focus({ messageId: "assistant-2" });
  assert.equal(focus.focusMessageId, "assistant-2");
  assert.deepEqual(runtime.calls.history[0], {
    sessionId: "contact-session",
    contactId: "contact-suzu",
    cwd: projectRoot,
    maxMessages: 600,
  });
  await reader.removeContact({ id: "contact-suzu", confirmed: true });
  assert.deepEqual(removals, [{ id: "contact-suzu", confirmed: true }]);
});

test("Agent Core reader hides internal scheduled task turns without hiding proactive replies", async () => {
  const projectRoot = "D:\\Contacts\\scheduled-turns";
  const planningTask = [
    "<suzu-schedule-task>",
    "任务说明：安排下次主动关心",
    "这是 Suzu 自动任务触发，不是用户发来的新消息。",
    "<!-- suzu-lives:display-system -->",
    "",
    "这是链式主动关心的内部安排阶段。",
    "</suzu-schedule-task>",
  ].join("\\n");
  const checkTask = [
    "<suzu-schedule-task>",
    "任务说明：判断是否主动关心",
    "这是 Suzu 自动任务触发，不是用户发来的新消息。",
    "</suzu-schedule-task>",
  ].join("\\n");
  const events = [
    { type: "user/message", seq: 1, time: 1_000, surfaceOp: "append", data: {
      id: "user-before", source: { kind: "user" }, content: [{ type: "text", text: "今天怎么样？" }],
    } },
    { type: "assistant/message", seq: 2, time: 2_000, surfaceOp: "append", data: {
      message: { id: "assistant-before", content: [{ type: "text", text: "挺好的，谢谢你。" }] },
    } },
    { type: "user/message", seq: 3, time: 3_000, surfaceOp: "append", data: {
      id: "planning-input", source: { kind: "user" }, content: [{ type: "text", text: planningTask }],
    } },
    { type: "tool/result", seq: 4, time: 4_000, surfaceOp: "append", data: {
      message: { content: [{ type: "text", text: "已建立下一次链式主动关心任务。" }] },
    } },
    { type: "assistant/message", seq: 5, time: 5_000, surfaceOp: "append", data: {
      message: { id: "planning-reply", content: [{ type: "text", text: "NO_REPLY" }] },
    } },
    { type: "user/message", seq: 6, time: 6_000, surfaceOp: "append", data: {
      id: "check-input", source: { kind: "user" }, content: [{ type: "text", text: checkTask }],
    } },
    { type: "assistant/message", seq: 7, time: 7_000, surfaceOp: "append", data: {
      message: { id: "proactive-reply", content: [{ type: "text", text: "晚上好，记得吃饭呀。" }] },
    } },
    { type: "user/message", seq: 8, time: 8_000, surfaceOp: "append", data: {
      id: "silent-check-input", source: { kind: "user" }, content: [{ type: "text", text: checkTask }],
    } },
    { type: "assistant/message", seq: 9, time: 9_000, surfaceOp: "append", data: {
      message: { id: "silent-check-reply", content: [{ type: "text", text: "NO_REPLY" }] },
    } },
    { type: "user/message", seq: 10, time: 10_000, surfaceOp: "append", data: {
      id: "user-after", source: { kind: "user" }, content: [{ type: "text", text: "我回来啦。" }],
    } },
    { type: "assistant/message", seq: 11, time: 11_000, surfaceOp: "append", data: {
      message: { id: "assistant-after", content: [{ type: "text", text: "欢迎回来。" }] },
    } },
  ];

  assert.deepEqual(conversationDisplayMessages(events).map((message) => [message.id, message.blocks[0]?.text]), [
    ["user-before", "今天怎么样？"],
    ["assistant-before", "挺好的，谢谢你。"],
    ["proactive-reply", "晚上好，记得吃饭呀。"],
    ["user-after", "我回来啦。"],
    ["assistant-after", "欢迎回来。"],
  ]);

  const contact = {
    id: "contact-scheduled",
    name: "Suzu",
    projectRoot,
    sessionId: "scheduled-session",
  };
  const reader = createConversationReader({
    runtime: createFakeRuntime({ history: { events, hasMore: false } }),
    settingsService: { load: () => ({ projectRoot }) },
    contactProjectsService: {
      async snapshot() {
        return {
          status: "ready",
          contactsRoot: "D:\\Contacts",
          contacts: [contact],
          activeContact: contact,
          preferredContact: contact,
        };
      },
    },
  });
  const snapshot = await reader.snapshot();
  assert.deepEqual(snapshot.messages.map((message) => message.id), [
    "user-before",
    "assistant-before",
    "proactive-reply",
    "user-after",
    "assistant-after",
  ]);
  assert.equal((await reader.search("链式主动关心")).matches.length, 0);
  assert.equal((await reader.search("NO_REPLY")).matches.length, 0);
  assert.equal((await reader.search("晚上好")).matches.length, 1);
});

test("Agent Core reader hides an entire silent proactive turn with intermediate tools", () => {
  const checkTask = [
    "<suzu-schedule-task>",
    "任务说明：链式主动关心",
    "这是 Suzu 自动任务触发，不是用户发来的新消息。",
    "</suzu-schedule-task>",
  ].join("\n");
  const events = [
    { type: "user/message", seq: 1, time: 1_000, surfaceOp: "append", data: {
      id: "schedule-input", source: { kind: "user" }, content: [{ type: "text", text: checkTask }],
    } },
    { type: "assistant/message", seq: 2, time: 2_000, surfaceOp: "append", data: {
      turn: 4, step: 1, message: { id: "internal-step", content: [{ type: "text", text: "先检查一下任务链。" }] },
    } },
    { type: "tool/result", seq: 3, time: 3_000, surfaceOp: "append", data: {
      turn: 4, step: 1, message: { content: [{ type: "text", text: "任务已检查。" }] },
    } },
    { type: "assistant/message", seq: 4, time: 4_000, surfaceOp: "append", data: {
      turn: 4, step: 2, message: {
        id: "silent-final",
        content: [
          { type: "reasoning", text: "当前不应重复打扰对方。" },
          { type: "text", text: "NO_REPLYNO_REPLY" },
        ],
      },
    } },
    { type: "turn/end", seq: 5, time: 5_000, data: { turn: 4, reason: { kind: "completed" } } },
    { type: "user/message", seq: 6, time: 6_000, surfaceOp: "append", data: {
      id: "user-after", source: { kind: "user" }, content: [{ type: "text", text: "我回来啦。" }],
    } },
  ];

  assert.deepEqual(conversationDisplayMessages(events).map((message) => message.id), ["user-after"]);
});

test("Agent Core reader keeps direct Core history when switching contacts and projects call transcripts", async () => {
  const first = {
    id: "contact-first",
    name: "一号",
    projectRoot: "D:\\Contacts\\first",
    sessionId: "session-first",
  };
  const second = {
    id: "contact-second",
    name: "二号",
    projectRoot: "D:\\Contacts\\second",
    sessionId: "session-second",
  };
  const callMarker = [
    "这是一次实时语音通话的转写。",
    "<suzu-voice-call-turn>",
    JSON.stringify({ source: "suzu-live-call", transcript: "你好，能听见吗？" }),
    "</suzu-voice-call-turn>",
  ].join("\n");
  const histories = new Map([
    [first.sessionId, {
      events: [
        {
          type: "user/message",
          seq: 4,
          time: 4_000,
          surfaceOp: "append",
          data: { id: "first-user", source: { kind: "user" }, content: [{ type: "text", text: "普通聊天还在吗？" }] },
        },
        {
          type: "assistant/message",
          seq: 5,
          time: 5_000,
          surfaceOp: "append",
          data: { message: { id: "first-answer", content: [{ type: "text", text: "还在。" }] } },
        },
        {
          type: "user/message",
          seq: 6,
          time: 6_000,
          surfaceOp: "append",
          data: { id: "call-user", source: { kind: "user" }, content: [{ type: "text", text: callMarker }] },
        },
        {
          type: "assistant/message",
          seq: 7,
          time: 7_000,
          surfaceOp: "append",
          data: { message: { id: "call-answer", content: [{ type: "text", text: "能听见，我在。" }] } },
        },
      ],
      hasMore: false,
    }],
    [second.sessionId, { events: [], hasMore: false }],
  ]);
  let active = first;
  const contacts = {
    async select({ id }) {
      active = id === second.id ? second : first;
      return this.snapshot();
    },
    async snapshot() {
      return {
        status: "ready",
        contactsRoot: "D:\\Contacts",
        contacts: [first, second],
        activeContact: active,
        preferredContact: first,
      };
    },
  };
  const reader = createConversationReader({
    runtime: {
      async history({ sessionId }) { return histories.get(sessionId) || { events: [], hasMore: false }; },
    },
    settingsService: { load: () => ({ projectRoot: active.projectRoot }) },
    contactProjectsService: contacts,
  });

  const firstSnapshot = await reader.snapshot();
  assert.deepEqual(firstSnapshot.messages.map((message) => [message.kind, message.blocks[0]?.text]), [
    ["user", "普通聊天还在吗？"],
    ["assistant", "还在。"],
    ["system", "通话 · 我：你好，能听见吗？"],
    ["system", "通话 · 对方：能听见，我在。"],
  ]);

  const secondSnapshot = await reader.selectContact({ id: second.id });
  assert.equal(secondSnapshot.activeContact.id, second.id);
  assert.deepEqual(secondSnapshot.messages, []);

  const returnedSnapshot = await reader.selectContact({ id: first.id });
  assert.equal(returnedSnapshot.activeContact.id, first.id);
  assert.deepEqual(returnedSnapshot.messages.map((message) => message.id), ["first-user", "first-answer", "call-user", "call-answer"]);
});

test("Agent Core reader keeps the roster and contact switch usable when one stored history cannot be opened", async () => {
  const healthy = {
    id: "contact-healthy",
    name: "可用联系人",
    projectRoot: "D:\\Contacts\\healthy",
    sessionId: "session-healthy",
  };
  const damaged = {
    id: "contact-damaged",
    name: "损坏联系人",
    projectRoot: "D:\\Contacts\\damaged",
    sessionId: "session-damaged",
  };
  let active = healthy;
  const contacts = {
    async select({ id }) {
      active = id === damaged.id ? damaged : healthy;
      return this.snapshot();
    },
    async snapshot() {
      return {
        status: "ready",
        contactsRoot: "D:\\Contacts",
        contacts: [healthy, damaged],
        activeContact: active,
        preferredContact: healthy,
      };
    },
  };
  const reader = createConversationReader({
    runtime: {
      async history({ sessionId }) {
        if (sessionId === damaged.sessionId) {
          const error = new Error('stored session "session-damaged" failed validation');
          error.code = "AGENT_SESSION_INVALID";
          throw error;
        }
        return { events: [], hasMore: false };
      },
    },
    settingsService: { load: () => ({ projectRoot: active.projectRoot }) },
    contactProjectsService: contacts,
  });

  const snapshot = await reader.selectContact({ id: damaged.id });
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.activeContact.id, damaged.id);
  assert.deepEqual(snapshot.contacts.map((contact) => contact.id), [healthy.id, damaged.id]);
  assert.equal(snapshot.history.status, "unavailable");
  assert.equal(snapshot.history.code, "AGENT_SESSION_INVALID");
  assert.match(snapshot.error, /聊天记录暂不可用/u);
  assert.deepEqual(snapshot.messages, []);

  const returned = await reader.selectContact({ id: healthy.id });
  assert.equal(returned.activeContact.id, healthy.id);
  assert.equal(returned.history.status, "ready");
});

test("DSH reader renders cached conversation media instead of a placeholder image block", () => {
  const dataRoot = "D:\\Suzu Lives\\dsh\\data";
  const imagePath = path.join(dataRoot, "agents", "agent-a", "conversations", "session-a", "attachments", "photo.png");
  const manifest = [
    "<conversation-media>",
    JSON.stringify({ version: 1, items: [{ kind: "image", fileName: "photo.png", mimeType: "image/png", path: imagePath, size: 123 }]}),
    "</conversation-media>",
  ].join("\n");
  const messages = conversationDisplayMessages([{
    event: {
      type: "user/message",
      seq: 1,
      time: 1_000,
      surfaceOp: "append",
      data: {
        id: "user-media",
        source: { kind: "user" },
        content: [
          { type: "text", text: "看看这张图" },
          { type: "text", text: manifest },
          { type: "image", attachment: { attachmentId: "sha256:test" } },
        ],
      },
    },
  }], 500, { dataRoot });
  assert.deepEqual(messages[0].blocks.map((block) => block.kind), ["text", "media"]);
  assert.equal(messages[0].blocks[1].mediaKind, "image");
  assert.equal(messages[0].blocks[1].fileName, "photo.png");
  assert.match(messages[0].blocks[1].fileUrl, /^file:/u);
});

test("DSH reader renders an Agent attachment receipt as Suzu's image, audio, and file cards", () => {
  const dataRoot = "D:\\Suzu Lives\\dsh\\data";
  const attachmentRoot = path.join(dataRoot, "agents", "agent-a", "conversations", "session-a", "attachments");
  const receipt = {
    status: "ok",
    type: "suzu-conversation-attachment",
    receiptId: "attachment-agent-output",
    items: [
      { kind: "image", fileName: "generated.png", path: path.join(attachmentRoot, "generated.png"), size: 123 },
      { kind: "audio", fileName: "voice.mp3", path: path.join(attachmentRoot, "voice.mp3"), size: 456 },
      { kind: "file", fileName: "report.txt", path: path.join(attachmentRoot, "report.txt"), size: 789 },
    ],
  };
  const messages = conversationDisplayMessages([{
    event: {
      type: "tool/result",
      seq: 4,
      time: 4_000,
      surfaceOp: "append",
      data: { message: { content: [{ type: "text", text: JSON.stringify(receipt) }] } },
    },
  }], 500, { dataRoot });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, "assistant");
  assert.deepEqual(messages[0].blocks.map((block) => block.mediaKind), ["image", "audio", "file"]);
  assert.ok(messages[0].blocks.every((block) => block.fileUrl.startsWith("file:")));
});

test("DSH reader keeps plugin context queryable according to each block's display fields", async () => {
  const projectRoot = "D:\\Contacts\\context-trace";
  const entries = [
    { event: { type: "step/start", seq: 10, time: 10_000, data: { turn: 3, step: 2 } } },
    { event: {
      type: "user/message",
      seq: 11,
      time: 11_000,
      surfaceOp: "append",
      data: {
        id: "dynamic-1",
        source: {
          kind: "plugin",
          plugin: "suzu-lifecycle-bridge",
          form: "snapshot",
          sections: [
            {
              name: "time-1",
              kind: "time-awareness",
              source: "time-awareness",
              text: "现在是 10:00。",
              display: { category: "time", context: true, label: "时间感知", transcript: false },
            },
            {
              name: "notice-1",
              kind: "notice",
              source: "notice",
              text: "这一条可以显示为系统提示。",
              display: { category: "notice", context: false, label: "提示", transcript: true },
            },
          ],
        },
        content: [{ type: "text", text: "动态上下文" }],
      },
    } },
    { event: { type: "user/message", seq: 12, time: 12_000, surfaceOp: "append", data: {
      id: "user-2",
      source: { kind: "user" },
      content: [{ type: "text", text: "晚上吃什么？" }],
    } } },
    { event: { type: "user/message", seq: 13, time: 13_000, surfaceOp: "append", data: {
      id: "recall-1",
      source: {
        kind: "plugin",
        plugin: "suzu-lifecycle-bridge",
        form: "recall",
        block: {
          id: "memory-7",
          kind: "memory",
          source: "memory-retriever",
          metadata: { memoryId: "7" },
          priority: 8,
          display: { category: "memory", context: true, label: "记忆召回", transcript: false },
        },
      },
      content: [{ type: "text", text: "用户喜欢烤肉。" }],
    } } },
    { event: {
      type: "assistant/message",
      seq: 14,
      time: 14_000,
      surfaceOp: { op: "replace", start: 11, end: 11 },
      sourceEventSeqs: [11],
      data: { message: { content: [] } },
    } },
  ];

  assert.deepEqual(conversationDisplayMessages(entries).map((message) => [message.kind, message.label, message.blocks[0]?.text]), [
    ["system", "提示", "这一条可以显示为系统提示。"],
    ["user", "", "晚上吃什么？"],
  ]);
  const records = conversationContextRecords(entries);
  assert.deepEqual(records.map((record) => ({
    messageId: record.messageId,
    scope: record.scope,
    status: record.status,
    blocks: record.blocks.map((block) => [block.id, block.display.category, block.display.transcript, block.text]),
  })), [
    {
      messageId: "user-2",
      scope: "dynamic",
      status: "expired",
      blocks: [["time-1", "time", false, "现在是 10:00。"]],
    },
    {
      messageId: "user-2",
      scope: "durable",
      status: "recorded",
      blocks: [["memory-7", "memory", false, "用户喜欢烤肉。"]],
    },
  ]);

  const contact = {
    id: "contact-suzu",
    name: "Suzu",
    projectRoot,
    sessionId: "context-session",
  };
  const reader = createConversationReader({
    runtime: createFakeRuntime({ history: { events: entries, hasMore: false } }),
    settingsService: { load: () => ({ projectRoot }) },
    contactProjectsService: {
      async snapshot() {
        return {
          status: "ready",
          contactsRoot: "D:\\Contacts",
          contacts: [contact],
          activeContact: contact,
          preferredContact: contact,
        };
      },
    },
  });
  const snapshot = await reader.snapshot();
  assert.deepEqual(snapshot.context, { available: true, count: 2 });
  const trace = await reader.contextTrace({ category: "memory", query: "烤肉" });
  assert.equal(trace.matchedRecords, 1);
  assert.deepEqual(trace.records[0]?.blocks.map((block) => block.id), ["memory-7"]);
});

test("DSH reader ignores a stale active contact and does not start DSH for an empty catalog", async () => {
  const runtime = createFakeRuntime();
  const reader = createConversationReader({
    runtime,
    settingsService: { load: () => ({}) },
    contactProjectsService: {
      async snapshot() {
        return {
          status: "ready",
          contactsRoot: "D:\\Contacts",
          contacts: [],
          activeContact: {
            id: "removed-contact",
            name: "旧联系人",
            projectRoot: "D:\\Contacts\\removed-contact",
            sessionId: "old-session",
          },
          preferredContact: null,
        };
      },
    },
  });

  const snapshot = await reader.snapshot();
  assert.equal(snapshot.activeContact, null);
  assert.equal(snapshot.status, "missing");
  assert.deepEqual(snapshot.sessions, []);
  assert.deepEqual(runtime.calls.history, []);
});

test("DSH runtime storage keeps durable state separate from explicit D temp", () => {
  const paths = resolveSuzuAgentRuntimePaths({
    dataRoot: "D:\\SuzuData",
    temporaryDirectory: "D:\\Temp\\suzu-lives-test-runtime",
  });
  assert.equal(paths.runtimeHome, path.join("D:\\SuzuData", "agent-runtime", "core"));
  assert.equal(paths.temporaryDirectory, "D:\\Temp\\suzu-lives-test-runtime");
  assert.equal(paths.fallbackTemporaryDirectory, path.join("D:\\SuzuData", "temporary", "agent-core"));
  assert.equal(paths.coreProcessHome, path.join("D:\\SuzuData", "agent-runtime", "core-process-home"));
  assert.equal(paths.coreAgentsHome, path.join("D:\\SuzuData", "agent-runtime", "core-agents"));
  assert.equal(paths.coreAppData, path.join("D:\\SuzuData", "agent-runtime", "core-process-home", "AppData", "Roaming"));
  assert.equal(paths.coreLocalAppData, path.join("D:\\SuzuData", "agent-runtime", "core-process-home", "AppData", "Local"));
});
