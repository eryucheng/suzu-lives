import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createSuzuAgentLifecycle } from "@suzu-lives/agent-lifecycle";
import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";
import {
  createVisualReferenceLibrary,
  resolveAgentVisualReferenceLibraryRoot,
} from "@suzu-lives/visual-reference-library";
import { createCapabilityRegistry, createCapabilityRuntime } from "../electron/services/capability-registry.mjs";
import { resolveImageGenerationVisualReferenceRegistryPath } from "../electron/services/agent-image-generation-skill.mjs";
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

test("Agent Core chat forwards the canonical event order for text and tools", async () => {
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

  const accepted = await chat.send({ content: "帮我查一下" });
  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: accepted.requestId });
  runtime.emit({
    type: "assistant-delta",
    sessionId: "contact-session",
    turnId: accepted.requestId,
    text: "我先查一下。",
    data: { coreSequence: 31, coreTime: 31_000, step: 1 },
  });
  runtime.emit({
    type: "tool-started",
    sessionId: "contact-session",
    turnId: accepted.requestId,
    toolName: "weather",
    data: { callId: "weather-call", coreSequence: 32, coreTime: 32_000, step: 1 },
  });
  runtime.emit({
    type: "tool-completed",
    sessionId: "contact-session",
    turnId: accepted.requestId,
    toolName: "weather",
    data: { callId: "weather-call", coreSequence: 33, coreTime: 33_000, step: 1, result: "晴" },
  });
  runtime.emit({
    type: "assistant-delta",
    sessionId: "contact-session",
    turnId: accepted.requestId,
    text: "查完了。",
    data: { coreSequence: 34, coreTime: 34_000, step: 2 },
  });
  runtime.emit({
    type: "assistant-completed",
    sessionId: "contact-session",
    turnId: accepted.requestId,
    text: "我先查一下。查完了。",
    data: { assistantMessageCount: 2, coreSequence: 35, coreTime: 35_000, step: 2 },
  });
  await flush();

  const presentation = events.filter((event) => ["reply-stream", "tool", "reply", "turn-complete"].includes(event.type));
  assert.deepEqual(presentation.map((event) => [event.type, event.phase || "", event.coreSequence]), [
    ["reply-stream", "", 31],
    ["tool", "started", 32],
    ["tool", "completed", 33],
    ["reply-stream", "", 34],
    ["reply", "", 35],
    ["turn-complete", "", 35],
  ]);
  const tool = presentation.find((event) => event.type === "tool" && event.phase === "started");
  assert.equal(tool?.callId, "weather-call");
  assert.equal(tool?.coreStep, 1);
  chat.dispose();
});

test("Agent Core chat preserves a QQ return route only in transport metadata", async () => {
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
  const route = {
    mode: "reply",
    channel: "qq",
    connectionId: "qq-connection-1",
    replyMessageId: "qq-message-1",
  };

  const accepted = await chat.sendToSession({
    content: "来自 QQ 的消息",
    contactId: "contact-suzu",
    sessionId: "contact-session",
    projectRoot,
    deliveryRoute: route,
  });
  assert.equal(runtime.calls.sendTurn[0].input.includes("qq-connection-1"), false);
  assert.equal(runtime.calls.sendTurn[0].input.includes("qq-message-1"), false);
  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: accepted.requestId });
  runtime.emit({ type: "assistant-completed", sessionId: "contact-session", turnId: accepted.requestId, text: "我在。" });
  await flush();

  const reply = events.find((event) => event.type === "agent-reply");
  assert.deepEqual(reply?.deliveryRoute, route);
  assert.equal(reply?.deliverToWechat, false);
  assert.deepEqual(events.find((event) => event.type === "turn-complete")?.deliveryRoute, route);
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
  const usageCalls = [];
  const chat = createConversationChatService({
    settingsService: { load: () => ({}) },
    reader: fakeReader(projectRoot),
    runtime,
    usageLedger: { record: async (value) => { usageCalls.push(value); } },
  });

  runtime.emit({
    type: "lifecycle-request",
    requestId: "software-context-1",
    lifecycleEvent: "ContextCollect",
    data: { sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID, coreTurn: 1, step: 1 },
  });
  runtime.emit({
    type: "model-usage",
    sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
    turnId: "software-turn-1",
    data: {
      coreSequence: 1,
      model: "deepseek-v4-flash",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  });
  await flush();
  assert.deepEqual(runtime.calls.respondLifecycleRequest, []);
  assert.deepEqual(usageCalls, []);
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
    scheduleSource: "proactive-contact",
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

test("Agent Core chat does not append the terminal assistant step twice in a multi-step reply", async () => {
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
      async prepareTurn() { return { id: "memory-multi-step" }; },
      async completeTurn(turn, value) { memoryCalls.push({ turn, value }); },
      async abortTurn() {},
    },
    onEvent: (event) => events.push(event),
  });

  const accepted = await chat.send({ content: "处理这个文件" });
  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: accepted.requestId });
  runtime.emit({ type: "assistant-delta", sessionId: "contact-session", turnId: accepted.requestId, text: "我先检查。" });
  runtime.emit({ type: "assistant-delta", sessionId: "contact-session", turnId: accepted.requestId, text: "检查完成。" });
  runtime.emit({ type: "assistant-delta", sessionId: "contact-session", turnId: accepted.requestId, text: "结果已经保存。" });
  runtime.emit({
    type: "assistant-completed",
    sessionId: "contact-session",
    turnId: accepted.requestId,
    text: "结果已经保存。",
    data: { assistantMessageCount: 3 },
  });
  await flush();

  const reply = events.find((event) => event.type === "reply" && event.done === true);
  assert.equal(reply?.content, "我先检查。检查完成。结果已经保存。");
  assert.equal(reply?.assistantMessageCount, 3);
  assert.equal(events.find((event) => event.type === "agent-reply")?.content, "结果已经保存。");
  assert.equal(memoryCalls[0]?.value?.assistantText, "我先检查。检查完成。结果已经保存。");
  chat.dispose();
});

test("a call-ended internal task only exposes its final non-silent reply", async () => {
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

  const accepted = await chat.sendTaskToSession({
    taskContext: { id: "call-ended", text: "【通话已结束】" },
    contactId: "contact-suzu",
    sessionId: "contact-session",
    projectRoot,
    kind: "call-ended",
    requestId: "call-ended-turn",
    outputPolicy: "external",
  });
  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: accepted.requestId });
  runtime.emit({ type: "assistant-reasoning-delta", sessionId: "contact-session", turnId: accepted.requestId, text: "判断是否需要补一句。" });
  runtime.emit({ type: "assistant-delta", sessionId: "contact-session", turnId: accepted.requestId, text: "怎么突然挂了？" });
  runtime.emit({ type: "assistant-completed", sessionId: "contact-session", turnId: accepted.requestId, text: "怎么突然挂了？" });
  await flush();

  assert.equal(events.some((event) => event.type === "thinking"), false);
  assert.equal(events.some((event) => event.type === "reply-stream"), false);
  assert.deepEqual(
    events.filter((event) => event.type === "reply").map((event) => [event.kind, event.content, event.done]),
    [["call-ended", "怎么突然挂了？", true]],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "agent-reply").map((event) => [event.kind, event.content]),
    [["call-ended", "怎么突然挂了？"]],
  );
  chat.dispose();
});

test("a call-ended internal task hides a terminal NO_REPLY", async () => {
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

  const accepted = await chat.sendTaskToSession({
    taskContext: { id: "call-ended", text: "【通话已结束】" },
    contactId: "contact-suzu",
    sessionId: "contact-session",
    projectRoot,
    kind: "call-ended",
    requestId: "call-ended-no-reply",
    outputPolicy: "external",
  });
  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: accepted.requestId });
  runtime.emit({ type: "assistant-delta", sessionId: "contact-session", turnId: accepted.requestId, text: "NO_" });
  runtime.emit({ type: "assistant-completed", sessionId: "contact-session", turnId: accepted.requestId, text: "NO_REPLY" });
  await flush();

  assert.equal(events.some((event) => ["thinking", "reply-stream", "reply", "agent-reply"].includes(event.type)), false);
  assert.equal(events.find((event) => event.type === "turn-complete")?.requestId, accepted.requestId);
  chat.dispose();
});

test("an internal task provides its instruction at the opening model step and stays off every reply transport", async () => {
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
  }, { id: "task-context", order: -110 });
  lifecycle.on("DynamicContextCollect", (payload) => ({
    id: `time:${payload.step}`,
    kind: "time-awareness",
    text: `当前内部步骤 ${payload.step}`,
  }), { id: "time-awareness", order: -100 });
  const chat = createConversationChatService({
    settingsService: { load: () => ({}) },
    reader: fakeReader(projectRoot),
    runtime,
    lifecycle,
    onEvent: (event) => events.push(event),
  });
  const internalEvents = [];
  const unsubscribe = chat.subscribe((event) => internalEvents.push(event));

  const accepted = await chat.sendTaskToSession({
    contactId: "contact-suzu",
    sessionId: "contact-session",
    projectRoot,
    requestId: "internal-task",
    scheduleSource: "internal-task",
    outputPolicy: "silent",
    resultChannel: "internal",
    taskContext: { id: "internal-task", text: "整理本轮内部检查。" },
  });
  assert.equal(runtime.calls.sendTurn.length, 0);
  assert.deepEqual(runtime.calls.sendTask, [{
    sessionId: "contact-session",
    turnId: "internal-task",
    task: { id: "internal-task", outputPolicy: "silent" },
    placement: "queue",
  }]);
  assert.equal(lifecycleEvents.some(([name]) => name === "UserPromptSubmit"), false);
  assert.equal(lifecycleEvents.find(([name]) => name === "TurnQueued")?.[1].taskContext?.text, "整理本轮内部检查。");

  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: accepted.requestId });
  runtime.emit({
    type: "lifecycle-request",
    requestId: "task-context-1",
    lifecycleEvent: "DynamicContextCollect",
    data: { sessionId: "contact-session", coreTurn: 3, step: 1 },
  });
  await flush();
  assert.deepEqual(runtime.calls.respondLifecycleRequest.at(-1).result.blocks.map((block) => [block.kind, block.text]), [
    ["automation-task", "整理本轮内部检查。"],
    ["time-awareness", "当前内部步骤 1"],
  ]);
  runtime.emit({
    type: "lifecycle-request",
    requestId: "task-context-2",
    lifecycleEvent: "DynamicContextCollect",
    data: { sessionId: "contact-session", coreTurn: 3, step: 2 },
  });
  await flush();
  assert.deepEqual(runtime.calls.respondLifecycleRequest.at(-1).result.blocks.map((block) => [block.kind, block.text]), [
    ["time-awareness", "当前内部步骤 2"],
  ]);
  assert.equal(lifecycleEvents.filter(([name]) => name === "DynamicContextCollect").at(-1)?.[1].taskContext, undefined);
  runtime.emit({ type: "assistant-delta", sessionId: "contact-session", turnId: accepted.requestId, text: "内部安排完成。" });
  runtime.emit({ type: "assistant-completed", sessionId: "contact-session", turnId: accepted.requestId, text: "完成" });
  await flush();

  assert.equal(events.some((event) => ["reply", "reply-stream", "agent-reply", "tool"].includes(event.type)), false);
  assert.equal(events.some((event) => event.type === "internal-result"), false);
  assert.equal(internalEvents.find((event) => event.type === "internal-result")?.content, "完成");
  assert.equal(events.find((event) => event.type === "turn-complete")?.requestId, accepted.requestId);
  unsubscribe();
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
    scheduleSource: "proactive-contact",
    outputPolicy: "silent",
    taskContext: { id: "stuck-task", text: "内部任务" },
  });
  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: task.requestId });
  await flush();

  const queued = await chat.send({ content: "请继续正常聊天", queued: true });
  assert.equal(queued.queued, true);
  assert.equal(runtime.calls.sendTurn.length, 0);

  runtime.emit({
    type: "turn-failed",
    sessionId: "contact-session",
    turnId: task.requestId,
    error: "session persistence failed",
  });
  await waitFor(() => runtime.calls.sendTurn.length === 1);

  assert.equal(events.find((event) => event.type === "error" && event.requestId === task.requestId)?.message, "session persistence failed");
  assert.equal(runtime.calls.sendTurn[0].input, "请继续正常聊天");
  chat.dispose();
});

test("Agent Core capability calls without an active conversation turn return a concrete reason", async () => {
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
    requestId: "capability-without-turn",
    lifecycleEvent: "CapabilityExecute",
    data: {
      sessionId: "missing-session",
      capabilityId: "web-browser",
      action: "open",
    },
  });
  await flush();

  assert.deepEqual(runtime.calls.respondLifecycleRequest, [{
    requestId: "capability-without-turn",
    result: {
      status: "turn-unavailable",
      error: {
        code: "CAPABILITY_TURN_UNAVAILABLE",
        message: "当前能力请求没有对应的活动对话轮次，未执行。",
      },
    },
  }]);
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

test("Agent Core exposes enabled product abilities as concise Skills and loads one action contract on demand", async () => {
  const root = await temporaryRoot();
  const projectRoot = path.join(root, "contact");
  const dataRoot = path.join(root, "data");
  const source = path.join(root, "reference.png");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(path.join(projectRoot, ".suzu-lives"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, ".suzu-lives", "contact.json"), JSON.stringify({
    id: "contact-22222222-2222-2222-2222-222222222222",
    agentId: "agent-conversation-image-skill-test",
  }));
  await fs.writeFile(source, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]));
  const referenceLibrary = createVisualReferenceLibrary({
    libraryRoot: resolveAgentVisualReferenceLibraryRoot(resolveAgentDataRoot({ dataRoot, projectRoot })),
  });
  await referenceLibrary.add({ source, id: "home.kitchen", role: "location", description: "暖色厨房" });
  const runtime = createFakeRuntime();
  const calls = [];
  const capabilityRuntime = {
    availableActions(context) {
      calls.push(context);
      return [{
        capabilityId: "image-generation",
        capabilityName: "图像生成",
        capabilityDescription: "生成、编辑图片，并可结合视觉参考。",
        action: "generate",
        actionName: "生成图片",
        actionDescription: "input 必须包含图片提示词，成功后会投放到当前聊天。",
      }];
    },
  };
  const chat = createConversationChatService({
    settingsService: { load: () => ({}), response: () => ({ dataRoot }) },
    reader: fakeReader(projectRoot),
    runtime,
    capabilityRuntime,
  });

  const accepted = await chat.send({ content: "帮我画一张图" });
  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: accepted.requestId });
  runtime.emit({
    type: "lifecycle-request",
    requestId: "capability-skill-catalog",
    lifecycleEvent: "CapabilitySkillCatalog",
    data: { sessionId: "contact-session", coreTurn: 4, step: 1 },
  });
  await flush();
  assert.deepEqual(runtime.calls.respondLifecycleRequest.at(-1), {
    requestId: "capability-skill-catalog",
    result: {
      skills: [{
        name: "suzu-image-generation",
        description: "图像生成：生成、编辑图片，并可结合视觉参考。",
      }],
    },
  });

  runtime.emit({
    type: "lifecycle-request",
    requestId: "capability-skill-read",
    lifecycleEvent: "CapabilitySkillRead",
    data: {
      sessionId: "contact-session",
      coreTurn: 4,
      step: 1,
      name: "suzu-image-generation",
    },
  });
  const loaded = await waitFor(() => runtime.calls.respondLifecycleRequest.find((entry) => entry.requestId === "capability-skill-read"));
  assert.equal(loaded.requestId, "capability-skill-read");
  assert.equal(loaded.result.skill.name, "suzu-image-generation");
  assert.match(loaded.result.skill.content, /capabilityId：`image-generation`/u);
  assert.match(loaded.result.skill.content, /input 必须包含图片提示词/u);
  assert.match(loaded.result.skill.content, /视觉参考注册表/u);
  const referenceRegistryPath = resolveImageGenerationVisualReferenceRegistryPath({ dataRoot, projectRoot });
  assert.ok(loaded.result.skill.content.includes(referenceRegistryPath));
  assert.doesNotMatch(loaded.result.skill.content, /home\.kitchen/u);
  const referenceRegistry = JSON.parse(await fs.readFile(referenceRegistryPath, "utf8"));
  assert.equal(referenceRegistry.references.some((entry) => entry.scope === "contact" && entry.id === "home.kitchen"), true);
  assert.equal(runtime.calls.respondLifecycleRequest[0].result.skills[0].description.includes("input"), false);
  assert.deepEqual(calls, [
    {
      contactId: "contact-suzu",
      coreTurn: 4,
      projectRoot,
      sessionId: "contact-session",
      step: 1,
      turnId: accepted.requestId,
    },
    {
      contactId: "contact-suzu",
      coreTurn: 4,
      projectRoot,
      sessionId: "contact-session",
      step: 1,
      turnId: accepted.requestId,
    },
  ]);
  chat.dispose();
});

test("Agent Core exposes each mail business Skill before the generic mailbox Skill", async () => {
  const root = await temporaryRoot();
  const projectRoot = path.join(root, "contact");
  const dataRoot = path.join(root, "data");
  await fs.mkdir(projectRoot, { recursive: true });
  const configPath = path.join(dataRoot, "automation", "mail-bridge", "config.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({
    agentSkills: [{
      id: "rule-check-in",
      name: "查岗",
      description: "当用户需要确认对方是否在岗时使用。",
      subject: "查岗",
    }],
  }), "utf8");
  const runtime = createFakeRuntime();
  const capabilityRuntime = {
    availableActions() {
      return [{
        capabilityId: "mail-bridge",
        capabilityName: "邮箱通道",
        capabilityDescription: "通过已配置的邮箱发送邮件。",
        action: "send",
        actionName: "发送邮件",
        actionDescription: "input 必须包含邮件正文。",
      }];
    },
  };
  const chat = createConversationChatService({
    settingsService: {
      load: () => ({ dataRoot }),
      response: () => ({ dataRoot }),
    },
    reader: fakeReader(projectRoot),
    runtime,
    capabilityRuntime,
  });

  const accepted = await chat.send({ content: "帮我把明早的待办同步出去" });
  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: accepted.requestId });
  runtime.emit({
    type: "lifecycle-request",
    requestId: "mail-skill-catalog",
    lifecycleEvent: "CapabilitySkillCatalog",
    data: { sessionId: "contact-session", coreTurn: 1, step: 1 },
  });
  const catalog = await waitFor(() => runtime.calls.respondLifecycleRequest.find((result) => result.requestId === "mail-skill-catalog"));
  const businessSkill = catalog.result.skills.find((skill) => skill.name === "suzu-mail-rule-check-in");
  assert.match(businessSkill.description, /^查岗：/u);
  assert.match(businessSkill.description, /主题为“查岗”/u);
  assert.equal(catalog.result.skills.some((skill) => skill.name === "suzu-mail-bridge"), true);

  runtime.emit({
    type: "lifecycle-request",
    requestId: "mail-business-skill-read",
    lifecycleEvent: "CapabilitySkillRead",
    data: {
      sessionId: "contact-session",
      coreTurn: 1,
      step: 1,
      name: "suzu-mail-rule-check-in",
    },
  });
  const businessLoaded = await waitFor(() => runtime.calls.respondLifecycleRequest.find((result) => result.requestId === "mail-business-skill-read"));
  assert.match(businessLoaded.result.skill.content, /# 查岗/u);
  assert.match(businessLoaded.result.skill.content, /suzu-mail-bridge/u);
  assert.match(businessLoaded.result.skill.content, /主题为 "查岗"/u);

  runtime.emit({
    type: "lifecycle-request",
    requestId: "mail-bridge-skill-read",
    lifecycleEvent: "CapabilitySkillRead",
    data: {
      sessionId: "contact-session",
      coreTurn: 1,
      step: 1,
      name: "suzu-mail-bridge",
    },
  });
  const genericLoaded = await waitFor(() => runtime.calls.respondLifecycleRequest.find((result) => result.requestId === "mail-bridge-skill-read"));
  assert.match(genericLoaded.result.skill.content, /邮件业务 Skill/u);
  assert.match(genericLoaded.result.skill.content, /subject: "业务 Skill 指定的主题"/u);
  assert.doesNotMatch(genericLoaded.result.skill.content, /当用户需要确认对方是否在岗/u);
  chat.dispose();
});

test("Agent Core keeps host-managed proactive decisions out of the capability and tool bridges", async () => {
  const root = await temporaryRoot();
  const projectRoot = path.join(root, "contact");
  await fs.mkdir(projectRoot, { recursive: true });
  const runtime = createFakeRuntime();
  const calls = [];
  const capabilityRuntime = {
    availableActions(context) {
      calls.push({ type: "catalog", context });
      return [{ capabilityId: "conversation-attachment", action: "deliver" }];
    },
    async invoke(context) {
      calls.push({ type: "invoke", context });
      return { status: "completed" };
    },
  };
  const chat = createConversationChatService({
    settingsService: { load: () => ({}) },
    reader: fakeReader(projectRoot),
    runtime,
    capabilityRuntime,
  });

  const accepted = await chat.sendTaskToSession({
    taskContext: { id: "proactive-timing", text: "【主动关心 B】\n只输出 JSON。" },
    contactId: "contact-suzu",
    sessionId: "contact-session",
    projectRoot,
    requestId: "proactive-timing-turn",
    scheduleSource: "proactive-contact-timing",
    outputPolicy: "silent",
    resultChannel: "internal",
  });
  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: accepted.requestId });

  runtime.emit({
    type: "lifecycle-request",
    requestId: "proactive-capability-catalog",
    lifecycleEvent: "CapabilityCatalog",
    data: { sessionId: "contact-session", coreTurn: 2, step: 1 },
  });
  await flush();
  assert.deepEqual(runtime.calls.respondLifecycleRequest.at(-1), {
    requestId: "proactive-capability-catalog",
    result: { actions: [] },
  });

  runtime.emit({
    type: "lifecycle-request",
    requestId: "proactive-capability-execute",
    lifecycleEvent: "CapabilityExecute",
    data: {
      sessionId: "contact-session",
      coreTurn: 2,
      step: 1,
      capabilityId: "conversation-attachment",
      action: "deliver",
      input: { items: [] },
    },
  });
  await flush();
  assert.deepEqual(runtime.calls.respondLifecycleRequest.at(-1), {
    requestId: "proactive-capability-execute",
    result: {
      status: "not-available",
      error: {
        code: "PROACTIVE_CONTACT_CAPABILITIES_UNAVAILABLE",
        message: "请返回本轮主动关心任务的结果；软件会处理下一次检查。",
      },
    },
  });

  runtime.emit({
    type: "lifecycle-request",
    requestId: "proactive-tool-use",
    lifecycleEvent: "PreToolUse",
    data: {
      sessionId: "contact-session",
      coreTurn: 2,
      step: 1,
      toolName: "suzu_capability",
    },
  });
  await flush();
  assert.deepEqual(runtime.calls.respondLifecycleRequest.at(-1), {
    requestId: "proactive-tool-use",
    result: {
      decision: {
        kind: "deny",
        reason: "请返回本轮主动关心任务的结果。",
      },
    },
  });
  assert.deepEqual(calls, []);
  chat.dispose();
});

test("Agent Core hides image understanding from a visual model while retaining other actions", async () => {
  const root = await temporaryRoot();
  const projectRoot = path.join(root, "contact");
  await fs.mkdir(projectRoot, { recursive: true });
  const runtime = createFakeRuntime();
  runtime.currentModelCapabilities = async () => ({
    inputModalities: ["text", "image"],
    supportsImageInput: true,
  });
  const capabilityRuntime = {
    availableActions() {
      return [
        { capabilityId: "image-vision", action: "analyze" },
        { capabilityId: "video-understanding", action: "analyze" },
        { capabilityId: "daily-note", action: "create" },
      ];
    },
  };
  const chat = createConversationChatService({
    settingsService: { load: () => ({}) },
    reader: fakeReader(projectRoot),
    runtime,
    capabilityRuntime,
  });

  const accepted = await chat.send({ content: "看看这个附件" });
  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: accepted.requestId });
  runtime.emit({
    type: "lifecycle-request",
    requestId: "visual-capability-catalog",
    lifecycleEvent: "CapabilityCatalog",
    data: { sessionId: "contact-session", coreTurn: 3, step: 1 },
  });
  await flush();

  assert.deepEqual(runtime.calls.respondLifecycleRequest.at(-1), {
    requestId: "visual-capability-catalog",
    result: {
      actions: [
        { capabilityId: "video-understanding", action: "analyze" },
        { capabilityId: "daily-note", action: "create" },
      ],
    },
  });

  runtime.currentModelCapabilities = async () => ({
    inputModalities: ["text"],
    supportsImageInput: false,
  });
  runtime.emit({
    type: "lifecycle-request",
    requestId: "text-capability-catalog",
    lifecycleEvent: "CapabilityCatalog",
    data: { sessionId: "contact-session", coreTurn: 3, step: 2 },
  });
  await flush();

  assert.deepEqual(runtime.calls.respondLifecycleRequest.at(-1), {
    requestId: "text-capability-catalog",
    result: {
      actions: [
        { capabilityId: "image-vision", action: "analyze" },
        { capabilityId: "video-understanding", action: "analyze" },
        { capabilityId: "daily-note", action: "create" },
      ],
    },
  });
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
        actionDescription: "将已有且已确认的本机绝对路径作为附件交付到当前聊天。图像生成和语音消息成功时由软件自动投放；本动作用于其他已有文件。input 必须是 { items: [{ path: \"绝对路径\", kind: \"image\" | \"audio\" | \"file\" }] }；图片支持 AVIF/BMP/GIF/HEIC/ICO/JPG/PNG/SVG/TIFF/WebP，音频仅支持 MP3。动作成功后，附件会出现在当前聊天；已绑定微信的会话会自动转发同一附件。",
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

test("Agent creation capabilities automatically deliver their declared output to the active chat", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "contact");
  const generatedImage = path.join(projectRoot, "generated.png");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(generatedImage, Buffer.from("generated-image"));
  const runtime = createFakeRuntime();
  const events = [];
  const attachmentService = createConversationAttachmentService({ dataRoot });
  const capabilityRuntime = {
    async invoke(request) {
      assert.equal(request.capabilityId, "image-generation");
      assert.equal(request.action, "generate");
      return {
        capabilityId: "image-generation",
        action: "generate",
        resourceId: "agent-action",
        kind: "runtime",
        status: "completed",
        outputDelivery: { kind: "image", pathField: "path" },
        value: {
          status: "ok",
          path: generatedImage,
          model: "fixture-image-model",
          sent: false,
          note: "已生成图片。请使用 conversation-attachment 交付给用户。",
        },
      };
    },
  };
  const chat = createConversationChatService({
    attachmentService,
    capabilityRuntime,
    settingsService: { load: () => ({}) },
    reader: fakeReader(projectRoot),
    runtime,
    onEvent: (event) => events.push(event),
  });

  const accepted = await chat.sendToSession({
    content: "给我画一张图",
    contactId: "contact-suzu",
    sessionId: "contact-session",
    projectRoot,
    deliverToWechat: true,
  });
  runtime.emit({ type: "turn-started", sessionId: "contact-session", turnId: accepted.requestId });
  runtime.emit({
    type: "lifecycle-request",
    requestId: "auto-image-delivery",
    lifecycleEvent: "CapabilityExecute",
    data: {
      sessionId: "contact-session",
      coreTurn: 2,
      step: 1,
      capabilityId: "image-generation",
      action: "generate",
      input: { prompt: "一只猫" },
    },
  });
  const response = await waitFor(() => runtime.calls.respondLifecycleRequest
    .find((item) => item.requestId === "auto-image-delivery"));
  assert.equal(response.result.status, "completed");
  assert.equal(response.result.value.type, "suzu-conversation-attachment");
  assert.equal(response.result.value.items[0].kind, "image");
  assert.match(response.result.value.items[0].path, /[\\/]attachments[\\/]/u);
  assert.equal(Object.hasOwn(response.result.value, "generated"), false);
  const receiptText = JSON.stringify(response.result.value);
  assert.equal(receiptText.includes("请使用 conversation-attachment"), false);
  assert.equal(receiptText.includes('"sent":false'), false);

  // The Core bridge returns `value` as the tool result payload.  Its ordinary
  // completion event therefore drives both the local renderer and linked
  // transport without a second model-selected delivery action.
  runtime.emit({
    type: "tool-completed",
    sessionId: "contact-session",
    turnId: accepted.requestId,
    toolName: "suzu_capability",
    data: { callId: "generated-image", result: JSON.stringify(response.result.value) },
  });
  await flush();
  const media = events.find((event) => event.type === "agent-media");
  assert.equal(media.deliverToWechat, true);
  assert.equal(media.media[0].kind, "image");
  assert.equal(media.media[0].path, response.result.value.items[0].path);
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
  await waitFor(() => usageCalls.length === 1);

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
  await waitFor(() => usageCalls.length === 2);

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
  runtime.currentModelCapabilities = async () => ({
    provider: "deepseek-official",
    model: "deepseek-v4-flash-vision-exp",
    inputModalities: ["text", "image"],
    supportsImageInput: true,
  });
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

test("Agent Core chat reuses saved sticker semantics before optional image understanding", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "contact");
  const image = path.join(root, "sticker.png");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl+jh0AAAAASUVORK5CYII=", "base64"));
  const runtime = createFakeRuntime();
  runtime.currentModelCapabilities = async () => ({
    inputModalities: ["text"],
    model: "text-only-model",
    provider: "text-only-provider",
    supportsImageInput: false,
  });
  const invocations = [];
  const chat = createConversationChatService({
    attachmentService: createConversationAttachmentService({ dataRoot }),
    capabilityRuntime: {
      availableActions: ({ capabilityId }) => [{ capabilityId, action: "analyze" }],
      async invoke(value) {
        invocations.push(value);
        return { status: "completed", value: { answer: "这是一张表情图片。" } };
      },
    },
    settingsService: { load: () => ({}) },
    reader: fakeReader(projectRoot),
    runtime,
  });

  await chat.send({
    media: [{
      kind: "image",
      path: image,
      stickerContext: {
        description: "戴着墨镜露出得意表情，适合表达小得瑟。",
        keywords: ["得意", "墨镜"],
        name: "得意",
      },
    }],
    mediaSource: "sticker",
    memoryText: "用户发送了表情“得意”：戴着墨镜露出得意表情，适合表达小得瑟。",
  });

  const input = runtime.calls.sendTurn[0].input;
  assert.deepEqual(input.map((part) => part.type), ["text"]);
  assert.match(input[0].text, /"source":"sticker"/u);
  assert.match(input[0].text, /戴着墨镜露出得意表情/u);
  assert.match(input[0].text, /以收到表情的方式自然回应/u);
  assert.deepEqual(invocations, []);
  chat.dispose();
});

test("Agent Core chat sends images natively to a visual main model and retains the video fallback", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "contact");
  const image = path.join(root, "reference.png");
  const video = path.join(root, "moment.mp4");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl+jh0AAAAASUVORK5CYII=", "base64"));
  await fs.writeFile(video, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]));
  const runtime = createFakeRuntime();
  runtime.currentModelCapabilities = async () => ({
    provider: "deepseek-official",
    model: "deepseek-v4-flash-vision-exp",
    inputModalities: ["text", "image"],
    supportsImageInput: true,
  });
  const invocations = [];
  const availabilityChecks = [];
  const capabilityRuntime = {
    availableActions: ({ capabilityId }) => {
      availabilityChecks.push(capabilityId);
      return [{ capabilityId, action: "analyze" }];
    },
    async invoke(value) {
      invocations.push(value);
      return { status: "completed", value: { summary: "视频里有人向镜头挥手。" } };
    },
  };
  const chat = createConversationChatService({
    attachmentService: createConversationAttachmentService({ dataRoot }),
    capabilityRuntime,
    settingsService: { load: () => ({}) },
    reader: fakeReader(projectRoot),
    runtime,
  });

  await chat.send({
    content: "这两个媒体是什么？",
    media: [
      { kind: "image", path: image },
      { kind: "file", path: video },
    ],
  });

  const input = runtime.calls.sendTurn[0].input;
  assert.deepEqual(input.map((part) => part.type), ["text", "text", "image", "text"]);
  assert.equal(input[2].mediaType, "image/png");
  assert.equal(input[2].data.length > 0, true);
  assert.match(input[3].text, /<suzu-media-understanding>/u);
  assert.deepEqual(invocations.map((item) => [item.capabilityId, item.action]), [
    ["video-understanding", "analyze"],
  ]);
  assert.deepEqual(availabilityChecks, ["image-vision", "video-understanding"]);
  chat.dispose();
});

test("Agent Core chat falls back only for images the visual main model cannot accept natively", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "contact");
  const nativeImage = path.join(root, "native.png");
  const oversizedImage = path.join(root, "oversized.png");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(nativeImage, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl+jh0AAAAASUVORK5CYII=", "base64"));
  await fs.writeFile(oversizedImage, Buffer.alloc((5 * 1024 * 1024) + 1, 0));
  const runtime = createFakeRuntime();
  runtime.currentModelCapabilities = async () => ({
    provider: "deepseek-official",
    model: "deepseek-v4-flash-vision-exp",
    inputModalities: ["text", "image"],
    supportsImageInput: true,
  });
  const invocations = [];
  const chat = createConversationChatService({
    attachmentService: createConversationAttachmentService({ dataRoot }),
    capabilityRuntime: {
      availableActions: ({ capabilityId }) => [{ capabilityId, action: "analyze" }],
      async invoke(value) {
        invocations.push(value);
        return { status: "completed", value: { answer: "这张较大的图片已由图像理解能力读出内容。" } };
      },
    },
    settingsService: { load: () => ({}) },
    reader: fakeReader(projectRoot),
    runtime,
  });

  await chat.send({
    content: "比较这两张图",
    media: [
      { kind: "image", path: nativeImage },
      { kind: "image", path: oversizedImage },
    ],
  });

  const input = runtime.calls.sendTurn[0].input;
  assert.deepEqual(input.map((part) => part.type), ["text", "text", "image", "text"]);
  assert.equal(input[2].name, "native.png");
  assert.match(input[1].text, /1 张已作为原生视觉输入传入/u);
  assert.match(input[1].text, /1 张会通过已启用的图像理解能力提供识图结果/u);
  assert.match(input[3].text, /较大的图片已由图像理解能力读出内容/u);
  assert.deepEqual(invocations.map((item) => [item.capabilityId, item.action]), [
    ["image-vision", "analyze"],
  ]);
  assert.match(invocations[0].input.path, /[\\/]attachments[\\/]/u);
  chat.dispose();
});

test("Agent Core chat sends images natively when the main model supports them even without the optional fallback", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "contact");
  const image = path.join(root, "reference.png");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl+jh0AAAAASUVORK5CYII=", "base64"));
  const runtime = createFakeRuntime();
  runtime.currentModelCapabilities = async () => ({
    provider: "deepseek-official",
    model: "deepseek-v4-flash-vision-exp",
    inputModalities: ["text", "image"],
    supportsImageInput: true,
  });
  const invocations = [];
  const chat = createConversationChatService({
    attachmentService: createConversationAttachmentService({ dataRoot }),
    capabilityRuntime: {
      availableActions: () => [],
      async invoke(value) { invocations.push(value); return { status: "completed", value: {} }; },
    },
    settingsService: { load: () => ({}) },
    reader: fakeReader(projectRoot),
    runtime,
  });

  await chat.send({ content: "看看这张图", media: [{ kind: "image", path: image }] });

  const input = runtime.calls.sendTurn[0].input;
  assert.deepEqual(input.map((part) => part.type), ["text", "text", "image"]);
  assert.match(input[1].text, /原生视觉输入/u);
  assert.deepEqual(invocations, []);
  chat.dispose();
});

test("Agent Core chat keeps an image local when neither the main model nor the fallback can understand it", async () => {
  const root = await temporaryRoot();
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "contact");
  const image = path.join(root, "reference.png");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl+jh0AAAAASUVORK5CYII=", "base64"));
  const runtime = createFakeRuntime();
  runtime.currentModelCapabilities = async () => ({
    provider: "text-only-provider",
    model: "text-only-model",
    inputModalities: ["text"],
    supportsImageInput: false,
  });
  const chat = createConversationChatService({
    attachmentService: createConversationAttachmentService({ dataRoot }),
    capabilityRuntime: { availableActions: () => [], async invoke() { throw new Error("不应调用图片理解。"); } },
    settingsService: { load: () => ({}) },
    reader: fakeReader(projectRoot),
    runtime,
  });

  await chat.send({ content: "看看这张图", media: [{ kind: "image", path: image }] });

  const input = runtime.calls.sendTurn[0].input;
  assert.deepEqual(input.map((part) => part.type), ["text", "text"]);
  assert.match(input[1].text, /未启用图像理解能力/u);
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

test("Agent Core reader marks abbreviated thinking with an ellipsis", () => {
  const thinking = "思".repeat(20_001);
  const messages = conversationDisplayMessages([{
    event: {
      type: "assistant/message",
      seq: 1,
      time: 1_000,
      surfaceOp: "append",
      data: { message: { id: "assistant-thinking", content: [{ type: "reasoning", text: thinking }] } },
    },
  }]);

  const block = messages[0]?.blocks[0];
  assert.equal(block?.kind, "thinking");
  assert.equal(block?.text.length, 20_000);
  assert.equal(block?.text.endsWith("…"), true);
  assert.doesNotMatch(block?.text || "", /内容已截断/u);
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
    maxMessages: 100,
  });
  await reader.removeContact({ id: "contact-suzu", confirmed: true });
  assert.deepEqual(removals, [{ id: "contact-suzu", confirmed: true }]);
});

test("Agent Core reader adds the final split bubble and timestamp to every roster contact", async () => {
  const first = {
    id: "contact-first",
    name: "第一位",
    projectRoot: "D:\\Contacts\\first",
    sessionId: "session-first",
  };
  const second = {
    id: "contact-second",
    name: "第二位",
    projectRoot: "D:\\Contacts\\second",
    sessionId: "session-second",
  };
  const histories = new Map([
    [first.sessionId, {
      events: [{
        type: "assistant/message",
        seq: 1,
        time: Date.parse("2026-08-28T15:33:00+08:00"),
        surfaceOp: "append",
        data: { message: { id: "assistant-first", content: [{ type: "text", text: "第一句。第二句。最后一句。" }] } },
      }],
      hasMore: false,
    }],
    [second.sessionId, {
      events: [{
        type: "user/message",
        seq: 1,
        time: Date.parse("2026-08-27T10:20:00+08:00"),
        surfaceOp: "append",
        data: { id: "user-second", source: { kind: "user" }, content: [{ type: "text", text: "第二位的最后消息" }] },
      }],
      hasMore: false,
    }],
  ]);
  const historyReads = new Map();
  const reader = createConversationReader({
    runtime: {
      async history({ sessionId }) {
        historyReads.set(sessionId, (historyReads.get(sessionId) || 0) + 1);
        return histories.get(sessionId) || { events: [], hasMore: false };
      },
    },
    settingsService: { load: () => ({ projectRoot: first.projectRoot }) },
    contactProjectsService: {
      async snapshot() {
        return {
          status: "ready",
          contactsRoot: "D:\\Contacts",
          contacts: [first, second],
          activeContact: first,
          preferredContact: first,
        };
      },
    },
    messageDeletionStore: {
      async list() { return { entries: [], revision: "" }; },
      async markDeleted() {},
    },
  });

  const snapshot = await reader.snapshot();
  assert.deepEqual(snapshot.contacts.map((contact) => ({
    id: contact.id,
    preview: contact.lastMessagePreview,
    timestamp: contact.lastMessageAt,
  })), [
    { id: first.id, preview: "最后一句。", timestamp: "2026-08-28T07:33:00.000Z" },
    { id: second.id, preview: "第二位的最后消息", timestamp: "2026-08-27T02:20:00.000Z" },
  ]);
  assert.equal(snapshot.sessions[0]?.preview, "最后一句。");
  assert.equal(historyReads.get(second.sessionId), 1);

  await reader.snapshot();
  assert.equal(historyReads.get(second.sessionId), 1, "unchanged inactive summaries are read only once");

  histories.set(second.sessionId, {
    events: [{
      type: "assistant/message",
      seq: 2,
      time: Date.parse("2026-08-28T16:00:00+08:00"),
      surfaceOp: "append",
      data: { message: { id: "assistant-second", content: [{ type: "text", text: "更新后的第一句。更新后的最后一句。" }] } },
    }],
    hasMore: false,
  });
  assert.equal(reader.invalidateRosterSummary({ sessionId: second.sessionId, projectRoot: second.projectRoot }), true);
  const refreshed = await reader.snapshot();
  assert.equal(refreshed.contacts.find((contact) => contact.id === second.id)?.lastMessagePreview, "更新后的最后一句。");
  assert.equal(historyReads.get(second.sessionId), 2);
});

test("Agent Core reader reads the current page first and accepts an older-history cursor", async () => {
  const projectRoot = "D:\\Contacts\\paged";
  const contact = {
    id: "contact-paged",
    name: "分页联系人",
    projectRoot,
    sessionId: "paged-session",
  };
  const events = Array.from({ length: 800 }, (_value, index) => ({
    type: "user/message",
    seq: index + 1,
    time: (index + 1) * 1_000,
    surfaceOp: "append",
    data: {
      id: `message-${index + 1}`,
      source: { kind: "user" },
      content: [{ type: "text", text: `消息 ${index + 1}` }],
    },
  }));
  const calls = [];
  const reader = createConversationReader({
    runtime: {
      async history({ beforeSeq, maxMessages, ...scope }) {
        calls.push({ beforeSeq, maxMessages, ...scope });
        const eligible = Number.isSafeInteger(beforeSeq)
          ? events.filter((event) => event.seq < beforeSeq)
          : events;
        const start = Math.max(eligible.length - maxMessages, 0);
        return { events: eligible.slice(start), hasMore: start > 0 };
      },
    },
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

  const latest = await reader.snapshot();
  assert.equal(calls[0].maxMessages, 100);
  assert.equal(calls[0].beforeSeq, undefined);
  assert.equal(latest.historyPage.oldestEventSeq, 701);
  assert.equal(latest.historyPage.hasMore, true);
  assert.deepEqual(latest.messages.slice(0, 2).map((message) => message.id), ["message-701", "message-702"]);

  const older = await reader.snapshot({ beforeSeq: latest.historyPage.oldestEventSeq });
  assert.equal(calls[1].maxMessages, 100);
  assert.equal(calls[1].beforeSeq, 701);
  assert.equal(older.historyPage.oldestEventSeq, 601);
  assert.equal(older.historyPage.hasMore, true);
  assert.deepEqual(older.messages.slice(-2).map((message) => message.id), ["message-699", "message-700"]);
});

test("Agent Core reader returns a visible transcript page from a stream-heavy history", async () => {
  const projectRoot = "D:\\Contacts\\stream-heavy";
  const contact = {
    id: "contact-stream-heavy",
    name: "流式联系人",
    projectRoot,
    sessionId: "stream-heavy-session",
  };
  const olderEvents = Array.from({ length: 360 }, (_value, index) => ({
    type: "user/message",
    seq: index + 1,
    time: (index + 1) * 1_000,
    surfaceOp: "append",
    data: {
      id: `older-message-${index + 1}`,
      source: { kind: "user" },
      content: [{ type: "text", text: `较早消息 ${index + 1}` }],
    },
  }));
  const latestEvents = [
    ...Array.from({ length: 356 }, (_value, index) => ({
      type: "assistant/chunk",
      seq: 2_001 + index,
      time: (2_001 + index) * 1_000,
      data: { chunk: `chunk-${index + 1}` },
    })),
    ...Array.from({ length: 4 }, (_value, index) => ({
      type: "assistant/message",
      seq: 2_357 + index,
      time: (2_357 + index) * 1_000,
      surfaceOp: "append",
      data: {
        message: {
          id: `latest-message-${index + 1}`,
          content: [{ type: "text", text: `最新消息 ${index + 1}` }],
        },
      },
    })),
  ];
  const calls = [];
  const reader = createConversationReader({
    runtime: {
      async history({ beforeSeq, maxMessages, ...scope }) {
        calls.push({ beforeSeq, maxMessages, ...scope });
        if (beforeSeq === undefined) return { events: latestEvents, hasMore: true };
        if (beforeSeq === 2_001) return { events: olderEvents, hasMore: false };
        throw new Error(`意外的历史游标：${beforeSeq}`);
      },
    },
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

  const latest = await reader.snapshot();
  assert.deepEqual(calls.map(({ beforeSeq, maxMessages }) => ({ beforeSeq, maxMessages })), [
    { beforeSeq: undefined, maxMessages: 100 },
    { beforeSeq: 2_001, maxMessages: 2_000 },
  ]);
  assert.equal(latest.messages.length, 100);
  assert.equal(latest.messages[0]?.id, "older-message-265");
  assert.equal(latest.messages.at(-1)?.id, "latest-message-4");
  assert.equal(latest.historyPage.oldestEventSeq, 265);
  assert.equal(latest.historyPage.hasMore, true);
});

test("Agent Core reader uses saved display preferences when filling a visible page", async () => {
  const projectRoot = "D:\\Contacts\\hidden-thinking";
  const contact = {
    id: "contact-hidden-thinking",
    name: "隐藏思考联系人",
    projectRoot,
    sessionId: "hidden-thinking-session",
  };
  const olderEvents = Array.from({ length: 100 }, (_value, index) => ({
    type: "user/message",
    seq: 101 + index,
    time: (101 + index) * 1_000,
    surfaceOp: "append",
    data: {
      id: `visible-message-${index + 1}`,
      source: { kind: "user" },
      content: [{ type: "text", text: `可见消息 ${index + 1}` }],
    },
  }));
  const latestEvents = Array.from({ length: 100 }, (_value, index) => ({
    type: "assistant/message",
    seq: 201 + index,
    time: (201 + index) * 1_000,
    surfaceOp: "append",
    data: {
      message: {
        id: `thinking-message-${index + 1}`,
        content: [{ type: "reasoning", text: `思考 ${index + 1}` }],
      },
    },
  }));
  const calls = [];
  const reader = createConversationReader({
    runtime: {
      async history({ beforeSeq, maxMessages, ...scope }) {
        calls.push({ beforeSeq, maxMessages, ...scope });
        if (beforeSeq === undefined) return { events: latestEvents, hasMore: true };
        if (beforeSeq === 201) return { events: olderEvents, hasMore: false };
        throw new Error(`意外的历史游标：${beforeSeq}`);
      },
    },
    settingsService: { load: () => ({ projectRoot, conversationPreferences: { thinking: false } }) },
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

  const latest = await reader.snapshot();
  assert.deepEqual(calls.map(({ beforeSeq, maxMessages }) => ({ beforeSeq, maxMessages })), [
    { beforeSeq: undefined, maxMessages: 100 },
    { beforeSeq: 201, maxMessages: 2_000 },
  ]);
  assert.equal(latest.messages.length, 200);
  assert.equal(latest.historyPage.oldestEventSeq, 101);
  assert.equal(latest.historyPage.hasMore, false);
});

test("Agent Core reader hides internal contact checks without hiding proactive replies", async () => {
  const projectRoot = "D:\\Contacts\\scheduled-turns";
  const contactTask = [
    "<suzu-schedule-task>",
    "任务说明：主动关心",
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
      id: "contact-input", source: { kind: "user" }, content: [{ type: "text", text: contactTask }],
    } },
    { type: "assistant/message", seq: 4, time: 4_000, surfaceOp: "append", data: {
      message: { id: "proactive-reply", content: [{ type: "text", text: "晚上好，记得吃饭呀。" }] },
    } },
    { type: "user/message", seq: 5, time: 5_000, surfaceOp: "append", data: {
      id: "silent-contact-input", source: { kind: "user" }, content: [{ type: "text", text: contactTask }],
    } },
    { type: "assistant/message", seq: 6, time: 6_000, surfaceOp: "append", data: {
      message: { id: "silent-contact-reply", content: [{ type: "text", text: "NO_REPLY" }] },
    } },
    { type: "user/message", seq: 7, time: 7_000, surfaceOp: "append", data: {
      id: "user-after", source: { kind: "user" }, content: [{ type: "text", text: "我回来啦。" }],
    } },
    { type: "assistant/message", seq: 8, time: 8_000, surfaceOp: "append", data: {
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
  assert.equal((await reader.search("主动关心")).matches.length, 0);
  assert.equal((await reader.search("NO_REPLY")).matches.length, 0);
  assert.equal((await reader.search("晚上好")).matches.length, 1);
});

test("Agent Core reader hides an entire silent automatic turn with intermediate tools", () => {
  const checkTask = [
    "<suzu-schedule-task>",
    "任务说明：主动关心",
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

test("reader renders a direct voice result from any local path without an attachment receipt", () => {
  const voicePath = "D:\\voice-output\\voice-from-tts.mp3";
  const result = {
    status: "ok",
    type: "suzu-voice-audio",
    mediaKind: "audio",
    fileName: "voice-from-tts.mp3",
    savedPath: voicePath,
  };
  const messages = conversationDisplayMessages([{
    event: {
      type: "tool/result",
      seq: 5,
      time: 5_000,
      surfaceOp: "append",
      data: { message: { content: [{ type: "text", text: JSON.stringify(result) }] } },
    },
  }], 500, { dataRoot: "D:\\Suzu Lives\\data" });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, "assistant");
  assert.deepEqual(messages[0].blocks, [{
    kind: "media",
    mediaKind: "audio",
    fileName: "voice-from-tts.mp3",
    filePath: voicePath,
    fileUrl: "file:///D:/voice-output/voice-from-tts.mp3",
    size: 0,
  }]);
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

test("Agent Core reader shows recorded dynamic diagnostics when the display switch is enabled", () => {
  const entries = [
    { event: { type: "user/message", seq: 1, time: 1_000, surfaceOp: "append", data: {
      id: "dynamic-delivery-rule",
      source: {
        kind: "plugin",
        plugin: "suzu-lifecycle-bridge",
        form: "snapshot",
        sections: [{
          id: "attachment-delivery",
          kind: "delivery",
          source: "conversation-attachment",
          text: "生成文件后使用附件交付动作。",
          display: { category: "delivery", context: true, label: "聊天附件交付", transcript: false },
        }],
      },
      content: [{ type: "text", text: "动态上下文" }],
    } } },
    { event: { type: "user/message", seq: 2, time: 2_000, surfaceOp: "append", data: {
      id: "person-message",
      source: { kind: "user" },
      content: [{ type: "text", text: "帮我看看这个文件。" }],
    } } },
    { event: { type: "assistant/message", seq: 3, time: 3_000, surfaceOp: "append", data: {
      message: { id: "agent-reply", content: [{ type: "text", text: "我来看看。" }] },
    } } },
    { event: { type: "assistant/message", seq: 4, time: 4_000, surfaceOp: { op: "replace", start: 1, end: 1 }, sourceEventSeqs: [1], data: {
      message: { content: [] },
    } } },
  ];

  assert.deepEqual(
    conversationDisplayMessages(entries, 500, { includeDynamicContext: true }).map((message) => [message.kind, message.id, message.blocks[0]?.text]),
    [
      ["dynamic-context", "dynamic-delivery-rule:dynamic-context", "【聊天附件交付】\n生成文件后使用附件交付动作。"],
      ["user", "person-message", "帮我看看这个文件。"],
      ["assistant", "agent-reply", "我来看看。"],
    ],
  );
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
