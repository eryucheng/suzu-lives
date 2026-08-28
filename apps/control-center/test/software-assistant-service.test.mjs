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

function createFakeRuntime({
  historyEvents = [],
  historyResponder = null,
  transientResponder = null,
} = {}) {
  const listeners = new Set();
  const state = { historyEvents };
  const calls = {
    cancelTurn: [],
    ensureSession: [],
    history: [],
    purgeSession: [],
    respondLifecycleRequest: [],
    runTransientInference: [],
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
      async runTransientInference(value) {
        calls.runTransientInference.push(value);
        if (typeof transientResponder === "function") return transientResponder(value);
        return { available: false, reason: "test-visual-unavailable" };
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

test("software assistant keeps per-turn context empty and serves software status and page search on demand", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "Suzu Lives");
  const fake = createFakeRuntime();
  const settings = createSettings({ theme: "light" });
  const service = createSoftwareAssistantService({
    applicationPath: "D:\\Apps\\Suzu Lives\\app",
    applicationStatus: () => ({ status: "available", version: "0.3.1", availableVersion: "0.4.0" }),
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
    presentation: { agentPreset: SUZU_SOFTWARE_ASSISTANT_AGENT_PRESET, reasoningEffort: "high" },
  });
  assert.deepEqual(fake.calls.history[0], {
    sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
    cwd: workspaceDirectory,
    presentation: { agentPreset: SUZU_SOFTWARE_ASSISTANT_AGENT_PRESET, reasoningEffort: "high" },
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
  await waitFor(() => responseById(fake.calls, "context-live-state"), "空 DynamicContextCollect 响应");
  const dynamic = responseById(fake.calls, "context-live-state").result;
  assert.deepEqual(dynamic, { blocks: [] });

  fake.emit({
    type: "lifecycle-request",
    requestId: "user-facing-status",
    lifecycleEvent: "SoftwareAssistantStatus",
    data: { sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID },
  });
  await waitFor(() => responseById(fake.calls, "user-facing-status"), "软件状态响应");
  const status = responseById(fake.calls, "user-facing-status").result.content;
  assert.match(status, /^主题：浅色$/mu);
  assert.match(status, /^版本：0\.3\.1$/mu);
  assert.match(status, /^更新：发现新版本 0\.4\.0$/mu);
  assert.match(status, new RegExp(`^数据目录：${dataRoot.replaceAll("\\", "\\\\")}$`, "mu"));
  assert.match(status, /^程序位置：D:\\Apps\\Suzu Lives\\app$/mu);
  assert.doesNotMatch(status, /主模型|内置软件能力|已登记的软件入口|voice-message/u);
  assert.doesNotMatch(status, /# Suzu Lives 使用说明/u);
  assert.doesNotMatch(status, /secret-dsh-key/u);

  fake.emit({
    type: "lifecycle-request",
    requestId: "page-search-wallpaper",
    lifecycleEvent: "SoftwareAssistantPageSearch",
    data: { sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID, query: "壁纸" },
  });
  await waitFor(() => responseById(fake.calls, "page-search-wallpaper"), "页面查询响应");
  assert.deepEqual(responseById(fake.calls, "page-search-wallpaper").result, {
    status: "completed",
    content: "相关页面：\n- 壁纸（wallpaper）：设置 · 壁纸",
    data: {
      query: "壁纸",
      results: [{ id: "wallpaper", title: "壁纸", detail: "设置 · 壁纸" }],
    },
  });
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

test("software assistant reapplies its saved reasoning effort before the next task", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fake = createFakeRuntime();
  const settings = createSettings({ theme: "light", softwareAssistantReasoningEffort: "low" });
  const service = createSoftwareAssistantService({
    dataRoot: path.join(root, "Suzu Lives"),
    runtime: fake.runtime,
    settingsService: settings.service,
  });

  await service.snapshot();
  assert.equal(fake.calls.ensureSession.at(-1)?.presentation?.reasoningEffort, "low");

  await settings.service.update({ softwareAssistantReasoningEffort: "max" });
  await service.send({ content: "检查一下设置" });
  assert.equal(fake.calls.ensureSession.at(-1)?.presentation?.reasoningEffort, "max");
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
  assert.deepEqual(responseById(fake.calls, "unknown-action").result, {
    status: "invalid-request",
    content: "软件动作尚未登记。",
    data: null,
  });
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
        personaContent: "# 玛琪玛\n\n## 角色核心\n\n冷静、善于观察，习惯用简短而从容的语句掌握谈话节奏。",
        relationshipContent: "# 相处情境\n\n玛琪玛与用户已经熟识，会自然关心用户的生活，也会保持她一贯的从容和掌控感。",
      },
    },
  });
  await waitFor(() => responseById(fake.calls, "create-contact-makima"), "新建联系人动作响应");

  assert.deepEqual(calls.createContact, [{ name: "玛琪玛" }]);
  assert.deepEqual(calls.saveRelationshipFile, [
    {
      contactId: "contact-makima",
      path: "persona.md",
      content: "# 玛琪玛\n\n## 角色核心\n\n冷静、善于观察，习惯用简短而从容的语句掌握谈话节奏。",
    },
    {
      contactId: "contact-makima",
      path: "SUZU.md",
      content: "# 相处情境\n\n玛琪玛与用户已经熟识，会自然关心用户的生活，也会保持她一贯的从容和掌控感。",
    },
  ]);
  assert.deepEqual(responseById(fake.calls, "create-contact-makima").result, {
    status: "completed",
    content: "已新建联系人“玛琪玛”，并写入角色设定、相处情境。",
    data: {
      contactId: "contact-makima",
      name: "玛琪玛",
      personaSaved: true,
      relationshipSaved: true,
      userSaved: false,
      savedSections: ["persona", "relationship"],
      errors: [],
      destinationId: "conversation",
    },
  });
  assert.ok(events.some((event) => event.type === "contact-created" && event.contactId === "contact-makima"));
  assert.ok(events.some((event) => event.type === "navigate" && event.destinationId === "conversation"));

  fake.emit({
    type: "lifecycle-request",
    requestId: "create-contact-basic",
    lifecycleEvent: "SoftwareAssistantAction",
    data: {
      sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
      action: "create-contact",
      input: { name: "临时联系人" },
    },
  });
  await waitFor(() => responseById(fake.calls, "create-contact-basic"), "基础联系人创建响应");
  assert.deepEqual(responseById(fake.calls, "create-contact-basic").result, {
    status: "completed",
    content: "已新建联系人“临时联系人”。",
    data: {
      contactId: "contact-makima",
      name: "临时联系人",
      personaSaved: false,
      relationshipSaved: false,
      userSaved: false,
      savedSections: [],
      errors: [],
      destinationId: "conversation",
    },
  });
  assert.deepEqual(calls.createContact, [{ name: "玛琪玛" }, { name: "临时联系人" }]);
  service.dispose();
});

test("software assistant finds, reads, and updates an existing contact through stable product services", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "contacts", "contact-makima");
  let contactName = "玛琪玛";
  const calls = {
    readRelationshipFiles: [],
    renameContact: [],
    saveRelationshipFile: [],
    updateContactLongTermMemoryEnabled: [],
    updateContactPermissionMode: [],
    updateContactPresentation: [],
    updateContactReasoningEffort: [],
  };
  const contactSnapshot = async () => ({
    status: "ready",
    contacts: [{
      id: "contact-makima",
      name: contactName,
      agentId: "agent-makima",
      sessionId: "session-makima",
      projectRoot,
      pinned: false,
      muted: false,
      longTermMemoryEnabled: true,
      permissionMode: "danger-full-access",
      reasoningEffort: "off",
    }],
    activeContact: { id: "contact-makima" },
    preferredContact: { id: "contact-makima" },
    hiddenContactCount: 1,
  });
  const fake = createFakeRuntime();
  const service = createSoftwareAssistantService({
    contactSnapshot,
    dataRoot: path.join(root, "Suzu Lives"),
    readRelationshipFiles: async (value) => {
      calls.readRelationshipFiles.push(value);
      return {
        status: "ready",
        files: [
          { path: "SUZU.md", exists: true, content: "相处规则" },
          { path: "persona.md", exists: true, content: "旧人设" },
          { path: "user.md", exists: false, content: "" },
        ],
      };
    },
    renameContact: async (value) => { calls.renameContact.push(value); contactName = value.name; },
    runtime: fake.runtime,
    saveRelationshipFile: async (value) => { calls.saveRelationshipFile.push(value); },
    settingsService: createSettings().service,
    updateContactLongTermMemoryEnabled: async (value) => { calls.updateContactLongTermMemoryEnabled.push(value); },
    updateContactPermissionMode: async (value) => { calls.updateContactPermissionMode.push(value); },
    updateContactPresentation: async (value) => { calls.updateContactPresentation.push(value); },
    updateContactReasoningEffort: async (value) => { calls.updateContactReasoningEffort.push(value); },
  });
  const events = [];
  service.subscribe((event) => events.push(event));

  fake.emit({
    type: "lifecycle-request",
    requestId: "search-contact-makima",
    lifecycleEvent: "SoftwareAssistantContactSearch",
    data: { sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID, query: "玛琪" },
  });
  await waitFor(() => responseById(fake.calls, "search-contact-makima"), "联系人查询响应");
  const searchResult = responseById(fake.calls, "search-contact-makima").result;
  assert.equal(searchResult.status, "completed");
  assert.deepEqual(searchResult.data.contacts[0], {
    contactId: "contact-makima",
    name: "玛琪玛",
    agentId: "agent-makima",
    sessionId: "session-makima",
    active: true,
    preferred: true,
    pinned: false,
    muted: false,
    longTermMemoryEnabled: true,
    permissionMode: "danger-full-access",
    reasoningEffort: "off",
    locations: {
      projectRoot,
      relationshipFiles: {
        relationship: path.join(projectRoot, "SUZU.md"),
        persona: path.join(projectRoot, "persona.md"),
        user: path.join(projectRoot, "user.md"),
      },
    },
  });
  assert.equal(searchResult.data.hiddenContactCount, 1);

  fake.emit({
    type: "lifecycle-request",
    requestId: "read-contact-makima",
    lifecycleEvent: "SoftwareAssistantContactRead",
    data: {
      sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
      input: { contactName: "玛琪玛", section: "persona" },
    },
  });
  await waitFor(() => responseById(fake.calls, "read-contact-makima"), "联系人资料读取响应");
  assert.deepEqual(calls.readRelationshipFiles, [{ contactId: "contact-makima" }]);
  assert.deepEqual(responseById(fake.calls, "read-contact-makima").result.data.files, [{
    section: "persona",
    path: "persona.md",
    exists: true,
    content: "旧人设",
    truncated: false,
  }]);

  fake.emit({
    type: "lifecycle-request",
    requestId: "update-contact-makima",
    lifecycleEvent: "SoftwareAssistantContactUpdate",
    data: {
      sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
      input: {
        contactName: "玛琪玛",
        newName: "玛奇玛",
        relationshipContent: "新的相处规则",
        personaContent: "新人设",
        userContent: "用户资料",
        pinned: true,
        muted: true,
        longTermMemoryEnabled: false,
        permissionMode: "workspace-write",
        reasoningEffort: "high",
      },
    },
  });
  await waitFor(() => responseById(fake.calls, "update-contact-makima"), "联系人资料更新响应");
  assert.deepEqual(calls.renameContact, [{ id: "contact-makima", name: "玛奇玛" }]);
  assert.deepEqual(calls.saveRelationshipFile, [
    { contactId: "contact-makima", path: "SUZU.md", content: "新的相处规则" },
    { contactId: "contact-makima", path: "persona.md", content: "新人设" },
    { contactId: "contact-makima", path: "user.md", content: "用户资料" },
  ]);
  assert.deepEqual(calls.updateContactPresentation, [{ id: "contact-makima", pinned: true, muted: true }]);
  assert.deepEqual(calls.updateContactLongTermMemoryEnabled, [{ id: "contact-makima", enabled: false }]);
  assert.deepEqual(calls.updateContactPermissionMode, [{ id: "contact-makima", permissionMode: "workspace-write" }]);
  assert.deepEqual(calls.updateContactReasoningEffort, [{ id: "contact-makima", reasoningEffort: "high" }]);
  assert.deepEqual(responseById(fake.calls, "update-contact-makima").result, {
    status: "completed",
    content: "已更新联系人“玛奇玛”的资料。",
    data: {
      contact: {
        contactId: "contact-makima",
        name: "玛奇玛",
        agentId: "agent-makima",
        sessionId: "session-makima",
        active: true,
        preferred: true,
        pinned: false,
        muted: false,
        longTermMemoryEnabled: true,
        permissionMode: "danger-full-access",
        reasoningEffort: "off",
        locations: {
          projectRoot,
          relationshipFiles: {
            relationship: path.join(projectRoot, "SUZU.md"),
            persona: path.join(projectRoot, "persona.md"),
            user: path.join(projectRoot, "user.md"),
          },
        },
      },
      updatedFields: ["name", "relationship", "persona", "user", "presentation", "longTermMemoryEnabled", "permissionMode", "reasoningEffort"],
      errors: [],
    },
  });
  assert.ok(events.some((event) => event.type === "contact-updated" && event.contactId === "contact-makima"));
  service.dispose();
});

test("software assistant returns Bangumi character material from the avatar identity lookup", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fake = createFakeRuntime();
  const fetchCalls = [];
  const service = createSoftwareAssistantService({
    dataRoot: path.join(root, "Suzu Lives"),
    runtime: fake.runtime,
    settingsService: createSettings().service,
    fetchImpl: async (url, options = {}) => {
      const requestUrl = String(url);
      fetchCalls.push(requestUrl);
      if (requestUrl.startsWith("https://api.bgm.tv/v0/search/characters")) {
        return {
          ok: true,
          async json() {
            return { data: [{
              id: 71337,
              name: "マキマ",
              summary: "公安对魔特异四课的恶魔猎人。",
              gender: "female",
              images: { large: "https://lain.bgm.tv/pic/crt/l/makima.jpg" },
              infobox: [{ key: "简体中文名", value: "玛奇玛" }],
              stat: { collects: 650 },
            }] };
          },
        };
      }
      if (requestUrl === "https://api.bgm.tv/v0/characters/71337/subjects") {
        return { ok: true, async json() { return [{ name: "チェンソーマン", name_cn: "电锯人" }]; } };
      }
      if (requestUrl === "https://graphql.anilist.co") {
        const variables = JSON.parse(options.body).variables;
        return {
          ok: true,
          async json() {
            return { data: { Page: { characters: variables.search === "マキマ" ? [{
              id: 137080,
              name: { full: "Makima", native: "マキマ", alternative: [] },
              image: { large: "https://s4.anilist.co/file/anilistcdn/character/large/makima-profile.png" },
              favourites: 22818,
              siteUrl: "https://anilist.co/character/137080",
              media: { nodes: [{ title: { english: "Chainsaw Man", romaji: "Chainsaw Man", native: "チェンソーマン" } }] },
            }] : [] } } };
          },
        };
      }
      throw new Error(`不应访问的地址：${requestUrl}`);
    },
  });

  fake.emit({
    type: "lifecycle-request",
    requestId: "lookup-makima-profile",
    lifecycleEvent: "SoftwareAssistantAction",
    data: {
      sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
      action: "lookup-character-profile",
      input: { query: "玛奇玛" },
    },
  });
  await waitFor(() => responseById(fake.calls, "lookup-makima-profile"), "角色资料响应");

  const result = responseById(fake.calls, "lookup-makima-profile").result;
  assert.equal(result.status, "completed");
  assert.equal(result.content, "已整理“玛奇玛”的公开角色资料。");
  assert.equal(Object.hasOwn(result.data, "status"), false);
  assert.equal(result.data.candidateId, "bangumi:71337");
  assert.equal(result.data.profile.source, "Bangumi");
  assert.equal(result.data.profile.summary, "公安对魔特异四课的恶魔猎人。");
  assert.deepEqual(result.data.profile.relatedWorks, ["电锯人", "チェンソーマン"]);
  assert.equal(fetchCalls.some((url) => url.startsWith("https://zh.moegirl.org.cn")), false);
  service.dispose();
});

test("software assistant resolves a Chinese character and downloads the matching AniList portrait", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "Suzu Lives");
  const avatarBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const portraitUrl = "https://s4.anilist.co/file/anilistcdn/character/large/makima.png";
  const fetchCalls = [];
  const fake = createFakeRuntime();
  const service = createSoftwareAssistantService({
    dataRoot,
    runtime: fake.runtime,
    settingsService: createSettings().service,
    fetchImpl: async (url, options = {}) => {
      const requestUrl = String(url);
      fetchCalls.push({ url: requestUrl, options });
      if (requestUrl.startsWith("https://api.bgm.tv/v0/search/characters")) {
        return {
          ok: true,
          async json() {
            return {
              data: [{
                id: 71337,
                name: "マキマ",
                summary: "公安对魔特异四课的恶魔猎人。",
                images: { large: "https://lain.bgm.tv/pic/crt/l/makima.jpg" },
                infobox: [{ key: "简体中文名", value: "玛奇玛" }],
                stat: { collects: 650 },
              }],
            };
          },
        };
      }
      if (requestUrl === "https://api.bgm.tv/v0/characters/71337/subjects") {
        return { ok: true, async json() { return [{ name: "チェンソーマン", name_cn: "链锯人" }]; } };
      }
      if (requestUrl === "https://graphql.anilist.co") {
        const search = JSON.parse(options.body).variables.search;
        return {
          ok: true,
          async json() {
            return {
              data: {
                Page: {
                  characters: search === "マキマ" ? [{
                    id: 137080,
                    name: { full: "Makima", native: "マキマ", alternative: [] },
                    image: { large: portraitUrl },
                    favourites: 22818,
                    siteUrl: "https://anilist.co/character/137080",
                    media: {
                      nodes: [{ title: { english: "Chainsaw Man", romaji: "Chainsaw Man", native: "チェンソーマン" } }],
                    },
                  }] : [],
                },
              },
            };
          },
        };
      }
      if (requestUrl === portraitUrl) {
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
  await waitFor(() => responseById(fake.calls, "lookup-makima-avatar"), "角色头像检索响应");

  const result = responseById(fake.calls, "lookup-makima-avatar").result;
  assert.equal(result.status, "completed");
  assert.equal(result.content, "已找到“玛奇玛”的头像预览。");
  assert.deepEqual({
    source: result.data.source,
    resolverSource: result.data.resolverSource,
    title: result.data.title,
    sourceUrl: result.data.sourceUrl,
    characterSourceUrl: result.data.characterSourceUrl,
    candidateId: result.data.candidateId,
    mimeType: result.data.mimeType,
  }, {
    source: "AniList",
    resolverSource: "Bangumi",
    title: "玛奇玛",
    sourceUrl: "https://anilist.co/character/137080",
    characterSourceUrl: "https://bgm.tv/character/71337",
    candidateId: "bangumi:71337",
    mimeType: "image/png",
  });
  assert.equal(path.dirname(result.data.avatarPath), path.join(dataRoot, "software-assistant", "workspace", "avatar-previews"));
  assert.equal(result.data.profile.source, "Bangumi");
  assert.equal(result.data.profile.summary, "公安对魔特异四课的恶魔猎人。");
  assert.deepEqual(result.data.profile.relatedWorks, ["链锯人", "チェンソーマン"]);
  assert.deepEqual(await fs.readFile(result.data.avatarPath), avatarBytes);
  assert.equal(fetchCalls.length, 5);
  assert.ok(fetchCalls.some((call) => call.url.startsWith("https://api.bgm.tv/v0/search/characters")));
  assert.ok(fetchCalls.some((call) => call.url === "https://api.bgm.tv/v0/characters/71337/subjects"));
  assert.ok(fetchCalls.some((call) => call.url === portraitUrl));
  assert.equal(fetchCalls.some((call) => call.url.startsWith("https://zh.moegirl.org.cn")), false);
  service.dispose();
});

test("character lookup can download, visually crop, and apply an avatar in one software action", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const avatarBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const portraitUrl = "https://s4.anilist.co/file/anilistcdn/character/large/makima-auto.png";
  const fake = createFakeRuntime({
    transientResponder: async () => ({
      available: true,
      result: {
        ok: true,
        output: { left: 0, top: 0, right: 1, bottom: 1, confidence: 0.99 },
      },
    }),
  });
  const settings = createSettings({
    identity: {
      owner: { displayName: "我", avatarDataUrl: "" },
      defaultAgent: { displayName: "Suzu", avatarDataUrl: "" },
      agents: { "agent-makima": { displayName: "玛奇玛", avatarDataUrl: "" } },
    },
  });
  const service = createSoftwareAssistantService({
    contactSnapshot: async () => ({
      status: "ready",
      contacts: [{ id: "contact-makima", name: "玛奇玛", agentId: "agent-makima" }],
    }),
    dataRoot: path.join(root, "Suzu Lives"),
    fetchImpl: async (url, options = {}) => {
      const requestUrl = String(url);
      if (requestUrl.startsWith("https://api.bgm.tv/v0/search/characters")) {
        return { ok: true, async json() { return { data: [] }; } };
      }
      if (requestUrl === "https://graphql.anilist.co") {
        assert.equal(JSON.parse(options.body).variables.search, "Makima");
        return {
          ok: true,
          async json() {
            return {
              data: {
                Page: {
                  characters: [{
                    id: 137080,
                    name: { full: "Makima", native: "マキマ", alternative: [] },
                    image: { large: portraitUrl },
                    favourites: 22818,
                    siteUrl: "https://anilist.co/character/137080",
                    media: { nodes: [] },
                  }],
                },
              },
            };
          },
        };
      }
      if (requestUrl === portraitUrl) {
        return {
          ok: true,
          headers: { get: () => String(avatarBytes.length) },
          async arrayBuffer() {
            return avatarBytes.buffer.slice(avatarBytes.byteOffset, avatarBytes.byteOffset + avatarBytes.byteLength);
          },
        };
      }
      throw new Error(`unexpected request ${requestUrl}`);
    },
    runtime: fake.runtime,
    settingsService: settings.service,
  });

  fake.emit({
    type: "lifecycle-request",
    requestId: "lookup-and-apply-makima-avatar",
    lifecycleEvent: "SoftwareAssistantAction",
    data: {
      sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
      action: "lookup-contact-avatar",
      input: { query: "Makima", contactId: "contact-makima" },
    },
  });
  await waitFor(() => responseById(fake.calls, "lookup-and-apply-makima-avatar"), "角色头像自动设置响应");

  const result = responseById(fake.calls, "lookup-and-apply-makima-avatar").result;
  assert.equal(result.status, "completed");
  assert.equal(result.content, "已为联系人“玛奇玛”找到并设置“Makima”头像。");
  assert.equal(result.data.applied, true);
  assert.equal(result.data.source, "AniList");
  assert.equal(result.data.contactId, "contact-makima");
  assert.equal(result.data.cropStrategy, "subject-box");
  assert.equal(fake.calls.runTransientInference.length, 1);
  assert.match(settings.calls[0].identity.agents["agent-makima"].avatarDataUrl, /^data:image\/png;base64,/u);
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
      cropStrategy: "portrait-bias",
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

test("software assistant uses one-shot visual framing while normalizing WebP avatars", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const avatarPath = path.join(root, "rin.webp");
  const avatarBytes = Buffer.from(
    "UklGRjoAAABXRUJQVlA4IC4AAACwAQCdASoIAAkAAUAmJaACdLoABdQAAP7xTa/9lY/9Kx/6Vj9kj/cGZ9XX+AAA",
    "base64",
  );
  await fs.writeFile(avatarPath, avatarBytes);

  const fake = createFakeRuntime({
    transientResponder: async () => ({
      available: true,
      result: {
        ok: true,
        output: { left: 0.15, top: 0.05, right: 0.85, bottom: 0.65, confidence: 0.9 },
      },
    }),
  });
  const settings = createSettings({
    identity: {
      owner: { displayName: "我", avatarDataUrl: "", gender: "", signature: "" },
      defaultAgent: { displayName: "Suzu", avatarDataUrl: "" },
      agents: { "agent-rin": { displayName: "远坂凛", avatarDataUrl: "" } },
    },
  });
  const service = createSoftwareAssistantService({
    contactSnapshot: async () => ({
      status: "ready",
      contacts: [{ id: "contact-rin", name: "远坂凛", agentId: "agent-rin" }],
    }),
    dataRoot: path.join(root, "Suzu Lives"),
    runtime: fake.runtime,
    settingsService: settings.service,
  });

  fake.emit({
    type: "lifecycle-request",
    requestId: "set-rin-webp-avatar",
    lifecycleEvent: "SoftwareAssistantAction",
    data: {
      sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
      action: "set-contact-avatar",
      input: { contactId: "contact-rin", avatarPath },
    },
  });
  await waitFor(() => responseById(fake.calls, "set-rin-webp-avatar"), "WebP 联系人头像动作响应");

  assert.deepEqual(responseById(fake.calls, "set-rin-webp-avatar").result, {
    status: "completed",
    content: "已为联系人“远坂凛”设置头像。",
    data: {
      contactId: "contact-rin",
      name: "远坂凛",
      agentId: "agent-rin",
      mimeType: "image/png",
      cropStrategy: "subject-box",
    },
  });
  const savedAvatar = settings.calls[0].identity.agents["agent-rin"].avatarDataUrl;
  assert.match(savedAvatar, /^data:image\/png;base64,/u);
  assert.notEqual(savedAvatar, `data:image/webp;base64,${avatarBytes.toString("base64")}`);
  assert.equal(fake.calls.runTransientInference.length, 1);
  assert.equal(fake.calls.runTransientInference[0].taskId, "avatar.crop.v1");
  assert.equal(fake.calls.runTransientInference[0].content[1].mediaType, "image/webp");
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

test("software assistant configures the main model and named APIs through product services", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const secret = "sk-local-test-secret";
  const fake = createFakeRuntime();
  const calls = { mainModel: [], apiConnection: [] };
  let connections = [];
  const service = createSoftwareAssistantService({
    apiConnectionsSnapshot: async () => ({ connections, bindings: {} }),
    dataRoot: path.join(root, "Suzu Lives"),
    mainModelSnapshot: async () => ({
      status: "ready",
      providerId: "deepseek",
      provider: "DeepSeek",
      protocol: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      models: ["deepseek-v4-flash", "deepseek-v4-pro"],
      hasApiKey: true,
      apiKeyWritable: true,
    }),
    runtime: fake.runtime,
    saveApiConnection: async (value) => {
      calls.apiConnection.push(value);
      const connection = {
        id: value.id || "deepseek",
        name: value.name,
        type: value.type,
        service: "OpenAI Compatible",
        baseUrl: value.baseUrl,
        model: value.model,
        configured: true,
        credentialStatus: "ready",
      };
      connections = [connection];
      return { connections, bindings: {} };
    },
    saveMainModelConfiguration: async (value) => {
      calls.mainModel.push(value);
      return {
        status: "ready",
        providerId: "deepseek",
        provider: "DeepSeek",
        protocol: "openai-completions",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        models: ["deepseek-v4-flash", "deepseek-v4-pro"],
        hasApiKey: true,
        apiKeyWritable: true,
      };
    },
    settingsService: createSettings().service,
  });
  const events = [];
  service.subscribe((event) => events.push(event));

  for (const request of [
    { requestId: "read-main-model", lifecycleEvent: "SoftwareAssistantMainModelStatus", data: {} },
    { requestId: "save-main-model", lifecycleEvent: "SoftwareAssistantMainModelSave", data: { input: { provider: "deepseek", apiKey: secret } } },
    { requestId: "search-api-before-save", lifecycleEvent: "SoftwareAssistantApiConnectionSearch", data: { query: "DeepSeek" } },
    { requestId: "save-api-without-model", lifecycleEvent: "SoftwareAssistantApiConnectionSave", data: { input: { provider: "deepseek", apiKey: secret } } },
    { requestId: "save-api", lifecycleEvent: "SoftwareAssistantApiConnectionSave", data: { input: { provider: "deepseek", apiKey: secret, model: "deepseek-v4-flash" } } },
  ]) {
    fake.emit({
      type: "lifecycle-request",
      requestId: request.requestId,
      lifecycleEvent: request.lifecycleEvent,
      data: { sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID, ...request.data },
    });
    await waitFor(() => responseById(fake.calls, request.requestId), `${request.requestId} 响应`);
  }

  assert.equal(calls.mainModel[0].apiKey, secret);
  assert.deepEqual(calls.apiConnection, [{
    name: "DeepSeek",
    type: "openai-compatible",
    apiKey: secret,
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-v4-flash",
  }]);
  assert.equal(responseById(fake.calls, "save-api-without-model").result.status, "needs-input");
  assert.deepEqual(responseById(fake.calls, "save-api").result.data.connection, connections[0]);
  assert.doesNotMatch(JSON.stringify(fake.calls.respondLifecycleRequest), /sk-local-test-secret/u);
  assert.ok(events.some((event) => event.type === "main-model-changed" && event.model === "deepseek-v4-flash"));
  assert.ok(events.some((event) => event.type === "api-connections-changed" && event.connectionId === "deepseek"));
  service.dispose();
});

test("software assistant preserves an existing aliased main model when rotating its API key", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const secret = "sk-rotated-local-secret";
  const fake = createFakeRuntime();
  const calls = [];
  const currentModel = {
    status: "ready",
    providerId: "custom",
    providerRoute: "suzu-openai",
    provider: "OpenAI",
    protocol: "openai-responses",
    baseUrl: "https://proxy.example/v1",
    model: "gpt-5.6-terra",
    models: ["gpt-5.6-terra"],
    hasApiKey: true,
    apiKeyWritable: true,
  };
  const service = createSoftwareAssistantService({
    dataRoot: path.join(root, "Suzu Lives"),
    mainModelSnapshot: async () => currentModel,
    runtime: fake.runtime,
    saveMainModelConfiguration: async (value) => {
      calls.push(value);
      return currentModel;
    },
    settingsService: createSettings().service,
  });

  fake.emit({
    type: "lifecycle-request",
    requestId: "rotate-main-model-key",
    lifecycleEvent: "SoftwareAssistantMainModelSave",
    data: {
      sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
      input: { provider: "openai", apiKey: secret },
    },
  });
  await waitFor(() => responseById(fake.calls, "rotate-main-model-key"), "主模型 Key 更新响应");

  assert.deepEqual(calls, [{
    provider: "custom",
    route: "suzu-openai",
    apiKey: secret,
  }]);
  assert.equal(responseById(fake.calls, "rotate-main-model-key").result.status, "completed");
  assert.doesNotMatch(JSON.stringify(fake.calls.respondLifecycleRequest), /sk-rotated-local-secret/u);
  service.dispose();
});
