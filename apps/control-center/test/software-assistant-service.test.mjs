import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { DEFAULT_SUZU_SOFTWARE_ASSISTANT_COMPACTION_PROMPT } from "@suzu-lives/suzu-agent-runtime/software-assistant-compaction-prompt";

import {
  SUZU_SOFTWARE_ASSISTANT_AGENT_ID,
  SUZU_SOFTWARE_ASSISTANT_NAME,
  SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
  createSoftwareAssistantService,
  resolveSoftwareAssistantWorkspace,
  softwareAssistantUsageSubject,
} from "../electron/services/software-assistant-service.mjs";
import { createSettingsService } from "../electron/ipc/settings-ipc.mjs";
import { SUZU_SOFTWARE_ASSISTANT_AGENT_PRESET } from "../electron/services/suzu-agent-runtime.mjs";

const ASYNC_WAIT_INTERVAL_MS = 5;
const ASYNC_WAIT_TIMEOUT_MS = 2_000;

async function temporaryRoot() {
  const root = process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp";
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, "suzu-software-assistant-"));
}

async function waitFor(check, label) {
  const deadline = Date.now() + ASYNC_WAIT_TIMEOUT_MS;
  do {
    if (check()) return;
    // Filesystem and settings work complete through I/O callbacks. Yielding
    // with a timer gives those callbacks a chance to run; counting immediate
    // turns instead makes this test depend on machine speed.
    await new Promise((resolve) => setTimeout(resolve, ASYNC_WAIT_INTERVAL_MS));
  } while (Date.now() < deadline);
  if (check()) return;
  assert.fail(`等待 ${label} 超时（${ASYNC_WAIT_TIMEOUT_MS} ms）。`);
}

function createFakeRuntime({ historyEvents = [], historyResponder = null } = {}) {
  const listeners = new Set();
  const state = { historyEvents };
  const calls = {
    cancelTurn: [],
    ensureSession: [],
    history: [],
    purgeSession: [],
    respondLifecycleRequest: [],
    sendTurn: [],
  };
  return {
    calls,
    runtime: {
      async ensureSession(value) {
        calls.ensureSession.push(value);
        return { created: calls.ensureSession.length === 1, runtimeSessionId: value.sessionId, sessionId: value.sessionId };
      },
      async history(value) {
        calls.history.push(value);
        if (typeof historyResponder === "function") return historyResponder(value);
        return { events: state.historyEvents, hasMore: false };
      },
      async sendTurn(value) {
        calls.sendTurn.push(value);
        return { accepted: true, turnId: value.turnId };
      },
      async cancelTurn(value) {
        calls.cancelTurn.push(value);
        return { accepted: true };
      },
      async purgeSession(value) {
        calls.purgeSession.push(value);
        state.historyEvents = [];
        return { sessionDirectoryRemoved: true };
      },
      async respondLifecycleRequest(value) {
        calls.respondLifecycleRequest.push(value);
        return true;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    setHistoryEvents(events) {
      state.historyEvents = Array.isArray(events) ? events : [];
    },
  };
}

function createSettings(initial = { theme: "light" }) {
  let settings = { ...initial };
  const calls = [];
  return {
    calls,
    service: {
      load() { return { ...settings }; },
      async update(next) {
        calls.push(next);
        settings = { ...settings, ...next };
        return { ...settings };
      },
    },
  };
}

function responseById(calls, requestId) {
  return calls.respondLifecycleRequest.find((entry) => entry.requestId === requestId) || null;
}

test("software assistant accepts the real product settings service during desktop startup", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fake = createFakeRuntime();
  const settingsService = createSettingsService({ app: { getPath: () => root } });
  const service = createSoftwareAssistantService({
    dataRoot: path.join(root, "Suzu Lives"),
    runtime: fake.runtime,
    settingsService,
  });

  await assert.doesNotReject(service.snapshot());
  assert.equal(settingsService.update({ theme: "dark", ignored: true }).theme, "dark");
  assert.equal(Object.hasOwn(settingsService.load(), "ignored"), false);
  service.dispose();
});

test("software assistant uses a fixed Agent Core session with a live software-state block", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "Suzu Lives");
  const fake = createFakeRuntime();
  const settings = createSettings({ theme: "light" });
  const service = createSoftwareAssistantService({
    applicationPath: "D:\\Apps\\Suzu Lives\\app",
    dataRoot,
    runtime: fake.runtime,
    settingsService: settings.service,
  });

  const snapshot = await service.snapshot();
  const workspaceDirectory = resolveSoftwareAssistantWorkspace(dataRoot);
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.sessionId, SUZU_SOFTWARE_ASSISTANT_SESSION_ID);
  assert.equal(snapshot.workspaceDirectory, workspaceDirectory);
  assert.deepEqual(snapshot.messages, []);
  await assert.doesNotReject(fs.stat(workspaceDirectory));
  assert.deepEqual(fake.calls.ensureSession[0], {
    sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
    cwd: workspaceDirectory,
    presentation: { agentPreset: SUZU_SOFTWARE_ASSISTANT_AGENT_PRESET },
  });
  assert.deepEqual(fake.calls.history[0], {
    sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
    cwd: workspaceDirectory,
    presentation: { agentPreset: SUZU_SOFTWARE_ASSISTANT_AGENT_PRESET },
    maxMessages: 300,
  });
  assert.equal("contactId" in fake.calls.ensureSession[0], false);

  fake.emit({
    type: "lifecycle-request",
    requestId: "context-empty",
    lifecycleEvent: "ContextCollect",
    data: { sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID },
  });
  await waitFor(() => responseById(fake.calls, "context-empty"), "空 ContextCollect 响应");
  assert.deepEqual(responseById(fake.calls, "context-empty").result, { blocks: [] });

  fake.emit({
    type: "lifecycle-request",
    requestId: "context-live-state",
    lifecycleEvent: "DynamicContextCollect",
    data: { sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID },
  });
  await waitFor(() => responseById(fake.calls, "context-live-state"), "动态软件状态响应");
  const dynamic = responseById(fake.calls, "context-live-state").result;
  assert.equal(dynamic.blocks.length, 1);
  assert.equal(dynamic.blocks[0].id, "software-assistant:runtime-state");
  assert.equal(dynamic.blocks[0].display.transcript, false);
  assert.match(dynamic.blocks[0].text, /当前外观：浅色主题/u);
  assert.match(dynamic.blocks[0].text, /主模型使用“设置 → 主模型”中已保存的全局默认连接/u);
  assert.match(dynamic.blocks[0].text, /此状态摘要不展开服务商、模型标识或连接详情/u);
  assert.match(dynamic.blocks[0].text, /内置软件能力按联系人分别启用/u);
  assert.match(dynamic.blocks[0].text, /外部 Skill\/MCP 登记到全局 Agent Core，供所有联系人共享/u);
  assert.match(dynamic.blocks[0].text, /此状态摘要不枚举具体能力配置/u);
  assert.match(dynamic.blocks[0].text, /软件本体\/源码位置：D:\\Apps\\Suzu Lives\\app/u);
  assert.match(dynamic.blocks[0].text, /本机文件、搜索和 PowerShell 工具/u);
  assert.match(dynamic.blocks[0].text, /联系人资料、相处设定、长期记忆和联系人聊天记录按用户明确的排查范围读取/u);
  assert.match(dynamic.blocks[0].text, /依据用户目标加载对应的产品使用 Skill/u);
  assert.doesNotMatch(dynamic.blocks[0].text, /软件说明书/u);
  assert.doesNotMatch(dynamic.blocks[0].text, /secret-dsh-key/u);

  fake.emit({
    type: "lifecycle-request",
    requestId: "user-facing-status",
    lifecycleEvent: "SoftwareAssistantStatus",
    data: { sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID },
  });
  await waitFor(() => responseById(fake.calls, "user-facing-status"), "软件状态响应");
  const status = responseById(fake.calls, "user-facing-status").result.content;
  assert.match(status, /已登记的软件入口（打开页面时使用括号中的 ID）/u);
  assert.match(status, /- 语音消息（voice-message）：能力 · TTS、ASR、音色与语音通话设置。/u);
  assert.match(status, /- 图像理解（image-vision）：能力 · 图片理解 API 与读取偏好。/u);
  assert.doesNotMatch(status, /# Suzu Lives 使用说明/u);
  assert.match(DEFAULT_SUZU_SOFTWARE_ASSISTANT_COMPACTION_PROMPT, /可续接的工作记录/u);
  assert.match(DEFAULT_SUZU_SOFTWARE_ASSISTANT_COMPACTION_PROMPT, /## 已完成的操作/u);
  assert.doesNotMatch(DEFAULT_SUZU_SOFTWARE_ASSISTANT_COMPACTION_PROMPT, /以“我”的第一人称/u);

  fake.emit({
    type: "lifecycle-request",
    requestId: "assistant-compaction",
    lifecycleEvent: "CompactionSettings",
    data: { sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID },
  });
  await waitFor(() => responseById(fake.calls, "assistant-compaction"), "软件助手压缩配置响应");
  assert.deepEqual(responseById(fake.calls, "assistant-compaction").result, {
    available: true,
    prompt: DEFAULT_SUZU_SOFTWARE_ASSISTANT_COMPACTION_PROMPT,
    automatic: { enabled: true, tokenThreshold: 32_000, retainTokens: 8_000 },
    manual: { retainTokens: 8_000 },
  });
  service.dispose();
});

test("software assistant records live and historical model usage under the suzu助手 billing subject", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "Suzu Lives");
  const historyEvents = [{
    type: "assistant/message",
    seq: 4,
    time: 1_000,
    data: {
      turn: 1,
      step: 1,
      message: { source: { provider: "DeepSeek", model: "deepseek-v4-flash" } },
      usage: { inputTokens: 10, outputTokens: 2 },
    },
  }];
  const fake = createFakeRuntime({ historyEvents });
  const usageCalls = { record: [], reconcile: [] };
  const usageLedger = {
    async record(value) {
      usageCalls.record.push(value);
      return { status: "recorded" };
    },
    async reconcile(value) {
      usageCalls.reconcile.push(value);
      return { status: "completed" };
    },
  };
  const service = createSoftwareAssistantService({
    dataRoot,
    runtime: fake.runtime,
    settingsService: createSettings().service,
    usageLedger,
  });

  await service.snapshot();
  const expectedSubject = softwareAssistantUsageSubject(dataRoot);
  assert.deepEqual(usageCalls.reconcile, [{ events: historyEvents, subject: expectedSubject }]);
  assert.equal(expectedSubject.agentId, SUZU_SOFTWARE_ASSISTANT_AGENT_ID);
  assert.equal(expectedSubject.subjectName, SUZU_SOFTWARE_ASSISTANT_NAME);

  const sent = await service.send({ content: "帮我检查费用设置" });
  fake.emit({ type: "turn-started", sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID, turnId: sent.requestId });
  fake.emit({ type: "tool-started", sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID, turnId: sent.requestId, toolName: "read_file" });
  fake.emit({
    type: "model-usage",
    sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
    turnId: sent.requestId,
    data: {
      coreSequence: 8,
      model: "deepseek-v4-flash",
      provider: "DeepSeek",
      purpose: "agent-step",
      usage: { inputTokens: 100, outputTokens: 20 },
    },
  });
  fake.emit({ type: "assistant-completed", sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID, turnId: sent.requestId, text: "检查完成。" });
  await waitFor(() => usageCalls.record.length === 1, "软件助手费用写入");

  assert.equal(usageCalls.record[0].subject.subjectName, "suzu助手");
  assert.equal(usageCalls.record[0].turn.userText, "帮我检查费用设置");
  assert.deepEqual([...usageCalls.record[0].turn.toolNames], ["read_file"]);
  service.dispose();
});

test("software assistant reconciles every historical usage page while keeping the visible page bounded", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "Suzu Lives");
  const latestEvents = [{ event: { type: "assistant/message", seq: 901, data: {} } }];
  const middleEvents = [{ event: { type: "assistant/message", seq: 401, data: {} } }];
  const oldestEvents = [{ event: { type: "assistant/message", seq: 1, data: {} } }];
  const fake = createFakeRuntime({
    historyResponder({ beforeSeq }) {
      if (beforeSeq === undefined) return { events: latestEvents, hasMore: true };
      if (beforeSeq === 901) return { events: middleEvents, hasMore: true };
      if (beforeSeq === 401) return { events: oldestEvents, hasMore: false };
      assert.fail(`未预期的历史游标：${beforeSeq}`);
    },
  });
  const reconciledPages = [];
  const service = createSoftwareAssistantService({
    dataRoot,
    runtime: fake.runtime,
    settingsService: createSettings().service,
    usageLedger: {
      async record() { return { status: "recorded" }; },
      async reconcile({ events }) {
        reconciledPages.push(events);
        return { completed: true };
      },
    },
  });

  await service.snapshot();

  assert.deepEqual(reconciledPages, [latestEvents, middleEvents, oldestEvents]);
  assert.deepEqual(fake.calls.history.map(({ beforeSeq, maxMessages }) => ({ beforeSeq, maxMessages })), [
    { beforeSeq: undefined, maxMessages: 300 },
    { beforeSeq: 901, maxMessages: 2_000 },
    { beforeSeq: 401, maxMessages: 2_000 },
  ]);

  await service.snapshot();
  assert.equal(fake.calls.history.length, 4);
  assert.deepEqual(reconciledPages[3], latestEvents);
  service.dispose();
});

test("software assistant clears only its fixed helper session while retaining its workspace", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "Suzu Lives");
  const fake = createFakeRuntime({
    historyEvents: [{
      type: "user/message",
      seq: 1,
      data: {
        id: "prior-question",
        source: { kind: "user" },
        content: [{ type: "text", text: "之前问过的问题" }],
      },
    }],
  });
  const settings = createSettings();
  const service = createSoftwareAssistantService({
    dataRoot,
    runtime: fake.runtime,
    settingsService: settings.service,
  });
  const events = [];
  service.subscribe((event) => events.push(event));

  await service.snapshot();
  const workspaceDirectory = resolveSoftwareAssistantWorkspace(dataRoot);
  const result = await service.clearHistory();

  assert.deepEqual(result, {
    accepted: true,
    cleared: true,
    sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
  });
  assert.deepEqual(fake.calls.purgeSession, [{
    sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
    cwd: workspaceDirectory,
    imageAttachmentIds: [],
    protectedImageAttachmentIds: [],
  }]);
  assert.equal("contactId" in fake.calls.purgeSession[0], false);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "history-cleared");
  assert.equal(events[0]?.sessionId, SUZU_SOFTWARE_ASSISTANT_SESSION_ID);
  assert.deepEqual((await service.snapshot()).messages, []);
  await assert.doesNotReject(fs.stat(workspaceDirectory));
  service.dispose();
});

test("software assistant does not clear its record while a reply is active", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fake = createFakeRuntime();
  const settings = createSettings();
  const service = createSoftwareAssistantService({
    dataRoot: path.join(root, "Suzu Lives"),
    runtime: fake.runtime,
    settingsService: settings.service,
  });

  await service.send({ content: "还在吗" });
  await assert.rejects(service.clearHistory(), (error) => error?.code === "TURN_ACTIVE");
  assert.deepEqual(fake.calls.purgeSession, []);
  service.dispose();
});

test("software assistant snapshot retains native tool calls and results for the chat transcript", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fake = createFakeRuntime({
    historyEvents: [
      {
        type: "user/message",
        seq: 1,
        time: 1_000,
        surfaceOp: "append",
        data: {
          id: "question",
          source: { kind: "user" },
          content: [{ type: "text", text: "帮我确认联系人目录" }],
        },
      },
      {
        type: "assistant/message",
        seq: 2,
        time: 2_000,
        surfaceOp: "append",
        data: {
          message: {
            id: "tool-call",
            content: [{ type: "tool-call", name: "pwsh", arguments: "{\"command\":\"Get-ChildItem\"}" }],
          },
        },
      },
      {
        type: "tool/result",
        seq: 3,
        time: 3_000,
        surfaceOp: "append",
        data: {
          message: {
            source: { callId: "call-1" },
            content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "已读取联系人目录" }], isError: false }],
          },
        },
      },
    ],
  });
  const settings = createSettings();
  const service = createSoftwareAssistantService({
    dataRoot: path.join(root, "Suzu Lives"),
    runtime: fake.runtime,
    settingsService: settings.service,
  });

  const snapshot = await service.snapshot();

  assert.deepEqual(snapshot.messages.map((message) => message.kind), ["user", "assistant", "system"]);
  assert.equal(snapshot.messages[1].blocks[0]?.kind, "tool_use");
  assert.equal(snapshot.messages[1].blocks[0]?.name, "pwsh");
  assert.equal(snapshot.messages[2].blocks[0]?.kind, "tool_result");
  assert.match(snapshot.messages[2].blocks[0]?.detail || "", /已读取联系人目录/u);
  service.dispose();
});

test("software assistant streams its own conversation and performs only registered product actions", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fake = createFakeRuntime();
  const settings = createSettings({ theme: "light" });
  const service = createSoftwareAssistantService({
    dataRoot: path.join(root, "Suzu Lives"),
    runtime: fake.runtime,
    settingsService: settings.service,
  });
  const events = [];
  service.subscribe((event) => events.push(event));

  const sent = await service.send({ content: "帮我切换夜间模式" });
  assert.equal(sent.accepted, true);
  assert.equal(fake.calls.sendTurn.length, 1);
  assert.deepEqual({
    sessionId: fake.calls.sendTurn[0].sessionId,
    input: fake.calls.sendTurn[0].input,
    placement: fake.calls.sendTurn[0].placement,
  }, {
    sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
    input: "帮我切换夜间模式",
    placement: "queue",
  });

  fake.emit({ type: "assistant-delta", sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID, turnId: sent.requestId, text: "已为你" });
  fake.emit({ type: "assistant-delta", sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID, turnId: sent.requestId, text: "切换为深色主题。下一步" });
  fake.emit({ type: "assistant-completed", sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID, turnId: sent.requestId, text: "已为你切换为深色主题。下一步已经完成。" });
  assert.deepEqual(events.filter((event) => event.requestId === sent.requestId).map((event) => [event.type, event.content]), [
    ["reply-stream", "已为你切换为深色主题。"],
    ["reply", "已为你切换为深色主题。下一步已经完成。"],
    ["turn-complete", undefined],
  ]);

  fake.emit({
    type: "lifecycle-request",
    requestId: "set-dark-theme",
    lifecycleEvent: "SoftwareAssistantAction",
    data: { sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID, action: "set-theme", input: { theme: "dark" } },
  });
  await waitFor(() => responseById(fake.calls, "set-dark-theme"), "主题动作响应");
  assert.deepEqual(settings.calls, [{ theme: "dark" }]);
  assert.deepEqual(responseById(fake.calls, "set-dark-theme").result, {
    status: "completed",
    content: "已切换为深色主题。",
    data: { theme: "dark" },
  });
  assert.ok(events.some((event) => event.type === "theme-changed" && event.theme === "dark"));

  fake.emit({
    type: "lifecycle-request",
    requestId: "open-api-connections",
    lifecycleEvent: "SoftwareAssistantAction",
    data: { sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID, action: "navigate", input: { destinationId: "api-connections" } },
  });
  await waitFor(() => responseById(fake.calls, "open-api-connections"), "导航动作响应");
  assert.deepEqual(responseById(fake.calls, "open-api-connections").result, {
    status: "completed",
    content: "已打开“API 连接”。",
    data: { destinationId: "api-connections" },
  });
  assert.ok(events.some((event) => event.type === "navigate" && event.destinationId === "api-connections"));

  fake.emit({
    type: "lifecycle-request",
    requestId: "open-voice-message",
    lifecycleEvent: "SoftwareAssistantAction",
    data: { sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID, action: "navigate", input: { destinationId: "voice-message" } },
  });
  await waitFor(() => responseById(fake.calls, "open-voice-message"), "能力细页导航动作响应");
  assert.deepEqual(responseById(fake.calls, "open-voice-message").result, {
    status: "completed",
    content: "已打开“语音消息”。",
    data: { destinationId: "voice-message" },
  });
  assert.ok(events.some((event) => event.type === "navigate" && event.destinationId === "voice-message"));

  fake.emit({
    type: "lifecycle-request",
    requestId: "unknown-action",
    lifecycleEvent: "SoftwareAssistantAction",
    data: { sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID, action: "unknown-action", input: {} },
  });
  await waitFor(() => responseById(fake.calls, "unknown-action"), "非法动作响应");
  assert.equal(responseById(fake.calls, "unknown-action").result.status, "invalid-request");
  service.dispose();
});

test("software assistant marks a multi-step terminal reply without duplicating its final step", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fake = createFakeRuntime();
  const service = createSoftwareAssistantService({
    dataRoot: path.join(root, "Suzu Lives"),
    runtime: fake.runtime,
    settingsService: createSettings().service,
  });
  const events = [];
  service.subscribe((event) => events.push(event));

  const sent = await service.send({ content: "检查设置" });
  fake.emit({ type: "assistant-delta", sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID, turnId: sent.requestId, text: "我先检查。" });
  fake.emit({ type: "assistant-delta", sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID, turnId: sent.requestId, text: "设置正常。" });
  fake.emit({
    type: "assistant-completed",
    sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
    turnId: sent.requestId,
    text: "设置正常。",
    data: { assistantMessageCount: 2 },
  });

  const reply = events.find((event) => event.type === "reply");
  assert.equal(reply?.content, "我先检查。设置正常。");
  assert.equal(reply?.assistantMessageCount, 2);
  service.dispose();
});

test("software assistant accepts a direct follow-up as a steer while a reply is running", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fake = createFakeRuntime();
  const settings = createSettings();
  const service = createSoftwareAssistantService({
    dataRoot: path.join(root, "Suzu Lives"),
    runtime: fake.runtime,
    settingsService: settings.service,
  });

  const first = await service.send({ content: "帮我检查当前设置" });
  fake.emit({ type: "turn-started", sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID, turnId: first.requestId });

  const guide = await service.send({ content: "先不要检查设置，改为打开深色主题" });
  assert.equal(guide.accepted, true);
  assert.equal(guide.steering, true);
  assert.equal(guide.queued, true);
  assert.deepEqual(fake.calls.cancelTurn, [{ sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID, turnId: first.requestId }]);
  assert.equal(fake.calls.sendTurn.length, 1);

  fake.emit({ type: "turn-cancelled", sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID, turnId: first.requestId });
  await waitFor(() => fake.calls.sendTurn.length === 2, "引导消息开始发送");
  assert.equal(fake.calls.sendTurn[1].input, "先不要检查设置，改为打开深色主题");
  service.dispose();
});

test("software assistant creates a contact through the product contact and relationship services", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fake = createFakeRuntime();
  const settings = createSettings();
  const calls = { createContact: [], saveRelationshipFile: [] };
  const service = createSoftwareAssistantService({
    dataRoot: path.join(root, "Suzu Lives"),
    runtime: fake.runtime,
    settingsService: settings.service,
    createContact: async ({ name }) => {
      calls.createContact.push({ name });
      return {
        createdContact: {
          id: "contact-makima",
        },
        contacts: [{
          id: "contact-makima",
          name,
        }, {
          id: "contact-current",
          name: "当前打开的其他联系人",
        }],
        activeContact: {
          id: "contact-current",
          name: "当前打开的其他联系人",
        },
      };
    },
    saveRelationshipFile: async (value) => {
      calls.saveRelationshipFile.push(value);
      return { status: "ready" };
    },
  });
  const events = [];
  service.subscribe((event) => events.push(event));

  fake.emit({
    type: "lifecycle-request",
    requestId: "create-contact-makima",
    lifecycleEvent: "SoftwareAssistantAction",
    data: {
      sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
      action: "create-contact",
      input: {
        name: "玛琪玛",
        personaContent: "# 玛琪玛\n\n## 身份\n\n我是你的贴身陪伴者。",
      },
    },
  });
  await waitFor(() => responseById(fake.calls, "create-contact-makima"), "新建联系人动作响应");

  assert.deepEqual(calls.createContact, [{ name: "玛琪玛" }]);
  assert.deepEqual(calls.saveRelationshipFile, [{
    contactId: "contact-makima",
    path: "persona.md",
    content: "# 玛琪玛\n\n## 身份\n\n我是你的贴身陪伴者。",
  }]);
  assert.deepEqual(responseById(fake.calls, "create-contact-makima").result, {
    status: "completed",
    content: "已新建联系人“玛琪玛”，并写入人设。",
    data: {
      contactId: "contact-makima",
      name: "玛琪玛",
      personaSaved: true,
      destinationId: "conversation",
    },
  });
  assert.ok(events.some((event) => event.type === "contact-created" && event.contactId === "contact-makima"));
  assert.ok(events.some((event) => event.type === "navigate" && event.destinationId === "conversation"));
  service.dispose();
});

test("software assistant fetches a known character avatar preview only from Moegirlpedia", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "Suzu Lives");
  const avatarBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const thumbnailUrl = "https://storage.moegirl.org.cn/moegirl/commons/makima-preview.png";
  const fetchCalls = [];
  const fake = createFakeRuntime();
  const service = createSoftwareAssistantService({
    dataRoot,
    runtime: fake.runtime,
    settingsService: createSettings().service,
    fetchImpl: async (url) => {
      const requestUrl = String(url);
      fetchCalls.push(requestUrl);
      if (requestUrl.startsWith("https://zh.moegirl.org.cn/api.php?")) {
        return {
          ok: true,
          async json() {
            return {
              query: {
                pages: [{
                  index: 1,
                  title: "玛奇玛",
                  fullurl: "https://zh.moegirl.org.cn/%E7%8E%9B%E5%A5%87%E7%8E%9B",
                  thumbnail: { source: thumbnailUrl },
                }],
              },
            };
          },
        };
      }
      if (requestUrl === thumbnailUrl) {
        return {
          ok: true,
          headers: { get(name) { return String(name).toLocaleLowerCase() === "content-length" ? String(avatarBytes.length) : null; } },
          async arrayBuffer() {
            return avatarBytes.buffer.slice(avatarBytes.byteOffset, avatarBytes.byteOffset + avatarBytes.byteLength);
          },
        };
      }
      throw new Error(`不应访问的地址：${requestUrl}`);
    },
  });

  fake.emit({
    type: "lifecycle-request",
    requestId: "lookup-makima-avatar",
    lifecycleEvent: "SoftwareAssistantAction",
    data: {
      sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
      action: "lookup-contact-avatar",
      input: { query: "玛奇玛" },
    },
  });
  await waitFor(() => responseById(fake.calls, "lookup-makima-avatar"), "萌娘百科头像检索响应");

  const result = responseById(fake.calls, "lookup-makima-avatar").result;
  assert.equal(result.status, "completed");
  assert.equal(result.content, "已从萌娘百科找到“玛奇玛”的头像预览。");
  assert.deepEqual({
    source: result.data.source,
    title: result.data.title,
    sourceUrl: result.data.sourceUrl,
    mimeType: result.data.mimeType,
  }, {
    source: "萌娘百科",
    title: "玛奇玛",
    sourceUrl: "https://zh.moegirl.org.cn/%E7%8E%9B%E5%A5%87%E7%8E%9B",
    mimeType: "image/png",
  });
  assert.equal(path.dirname(result.data.avatarPath), path.join(dataRoot, "software-assistant", "workspace", "avatar-previews"));
  assert.deepEqual(await fs.readFile(result.data.avatarPath), avatarBytes);
  assert.equal(fetchCalls.length, 2);
  const apiUrl = new URL(fetchCalls[0]);
  assert.equal(apiUrl.origin, "https://zh.moegirl.org.cn");
  assert.equal(apiUrl.pathname, "/api.php");
  assert.equal(apiUrl.searchParams.get("generator"), "search");
  assert.equal(apiUrl.searchParams.get("gsrsearch"), "玛奇玛");
  assert.equal(fetchCalls[1], thumbnailUrl);
  service.dispose();
});

test("software assistant saves a downloaded image as the uniquely named contact avatar", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const avatarPath = path.join(root, "makima.png");
  const avatarBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await fs.writeFile(avatarPath, avatarBytes);

  const fake = createFakeRuntime();
  const settings = createSettings({
    theme: "light",
    identity: {
      owner: { displayName: "我", avatarDataUrl: "", gender: "female", signature: "保留" },
      defaultAgent: { displayName: "Suzu", avatarDataUrl: "" },
      agents: {
        "agent-makima": { displayName: "玛琪玛", avatarDataUrl: "data:image/png;base64,T0xE" },
        "agent-other": { displayName: "其他联系人", avatarDataUrl: "data:image/png;base64,T1RIRVI=" },
      },
    },
  });
  const service = createSoftwareAssistantService({
    contactSnapshot: async () => ({
      status: "ready",
      contacts: [
        { id: "contact-makima", name: "玛琪玛", agentId: "agent-makima" },
        { id: "contact-other", name: "其他联系人", agentId: "agent-other" },
      ],
    }),
    dataRoot: path.join(root, "Suzu Lives"),
    runtime: fake.runtime,
    settingsService: settings.service,
  });
  const events = [];
  service.subscribe((event) => events.push(event));

  fake.emit({
    type: "lifecycle-request",
    requestId: "set-makima-avatar",
    lifecycleEvent: "SoftwareAssistantAction",
    data: {
      sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
      action: "set-contact-avatar",
      input: { contactName: "玛琪玛", avatarPath },
    },
  });
  await waitFor(() => responseById(fake.calls, "set-makima-avatar"), "联系人头像动作响应");

  assert.deepEqual(responseById(fake.calls, "set-makima-avatar").result, {
    status: "completed",
    content: "已为联系人“玛琪玛”设置头像。",
    data: {
      contactId: "contact-makima",
      name: "玛琪玛",
      agentId: "agent-makima",
      mimeType: "image/png",
    },
  });
  assert.deepEqual(settings.calls, [{
    identity: {
      owner: { displayName: "我", avatarDataUrl: "", gender: "female", signature: "保留" },
      defaultAgent: { displayName: "Suzu", avatarDataUrl: "" },
      agents: {
        "agent-makima": {
          displayName: "玛琪玛",
          avatarDataUrl: `data:image/png;base64,${avatarBytes.toString("base64")}`,
        },
        "agent-other": { displayName: "其他联系人", avatarDataUrl: "data:image/png;base64,T1RIRVI=" },
      },
    },
  }]);
  assert.ok(events.some((event) => (
    event.type === "contact-avatar-changed"
    && event.contactId === "contact-makima"
    && event.agentId === "agent-makima"
  )));
  service.dispose();
});

test("software assistant requires a contact ID when an avatar target name is ambiguous", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fake = createFakeRuntime();
  const settings = createSettings();
  const service = createSoftwareAssistantService({
    contactSnapshot: async () => ({
      status: "ready",
      contacts: [
        { id: "contact-suzu-a", name: "Suzu", agentId: "agent-suzu-a" },
        { id: "contact-suzu-b", name: "Suzu", agentId: "agent-suzu-b" },
      ],
    }),
    dataRoot: path.join(root, "Suzu Lives"),
    runtime: fake.runtime,
    settingsService: settings.service,
  });

  fake.emit({
    type: "lifecycle-request",
    requestId: "set-ambiguous-avatar",
    lifecycleEvent: "SoftwareAssistantAction",
    data: {
      sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
      action: "set-contact-avatar",
      input: { contactName: "suzu", avatarPath: path.join(root, "not-read.png") },
    },
  });
  await waitFor(() => responseById(fake.calls, "set-ambiguous-avatar"), "同名联系人头像动作响应");

  assert.deepEqual(responseById(fake.calls, "set-ambiguous-avatar").result, {
    status: "needs-confirmation",
    content: "有多位联系人名为“Suzu”；请确认联系人 ID 后再设置头像。",
    data: {
      candidates: [
        { contactId: "contact-suzu-a", name: "Suzu" },
        { contactId: "contact-suzu-b", name: "Suzu" },
      ],
    },
  });
  assert.deepEqual(settings.calls, []);
  service.dispose();
});

test("software assistant reports failure when the avatar is not present after the settings update", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const avatarPath = path.join(root, "avatar.png");
  await fs.writeFile(avatarPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const fake = createFakeRuntime();
  const unchangedSettings = {
    identity: {
      owner: { displayName: "我", avatarDataUrl: "", gender: "", signature: "" },
      defaultAgent: { displayName: "Suzu", avatarDataUrl: "" },
      agents: {},
    },
  };
  const service = createSoftwareAssistantService({
    contactSnapshot: async () => ({
      status: "ready",
      contacts: [{ id: "contact-suzu", name: "Suzu", agentId: "agent-suzu" }],
    }),
    dataRoot: path.join(root, "Suzu Lives"),
    runtime: fake.runtime,
    settingsService: {
      load: () => unchangedSettings,
      update: async () => unchangedSettings,
    },
  });
  const events = [];
  service.subscribe((event) => events.push(event));

  fake.emit({
    type: "lifecycle-request",
    requestId: "set-avatar-with-dropped-update",
    lifecycleEvent: "SoftwareAssistantAction",
    data: {
      sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
      action: "set-contact-avatar",
      input: { contactId: "contact-suzu", avatarPath },
    },
  });
  await waitFor(() => responseById(fake.calls, "set-avatar-with-dropped-update"), "头像保存确认响应");

  assert.deepEqual(responseById(fake.calls, "set-avatar-with-dropped-update").result, {
    status: "failed",
    content: "联系人头像未能写入设置。",
    data: null,
  });
  assert.equal(events.some((event) => event.type === "contact-avatar-changed"), false);
  service.dispose();
});
