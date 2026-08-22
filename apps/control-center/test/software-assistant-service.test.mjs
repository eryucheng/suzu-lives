import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { DEFAULT_SUZU_SOFTWARE_ASSISTANT_COMPACTION_PROMPT } from "@suzu-lives/suzu-agent-runtime/software-assistant-compaction-prompt";

import {
  SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
  createSoftwareAssistantService,
  resolveSoftwareAssistantManualPath,
  resolveSoftwareAssistantWorkspace,
} from "../electron/services/software-assistant-service.mjs";
import { createSettingsService } from "../electron/ipc/settings-ipc.mjs";
import { SUZU_SOFTWARE_ASSISTANT_AGENT_PRESET } from "../electron/services/suzu-agent-runtime.mjs";

async function temporaryRoot() {
  const root = process.env.SUZU_LIVES_TEST_TEMP || "D:\\Temp";
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, "suzu-software-assistant-"));
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(check, label) {
  for (let count = 0; count < 20; count += 1) {
    if (check()) return;
    await flush();
  }
  assert.fail(`等待 ${label} 超时。`);
}

function createFakeRuntime({ historyEvents = [] } = {}) {
  const listeners = new Set();
  const state = { historyEvents };
  const calls = {
    cancelTurn: [],
    ensureSession: [],
    history: [],
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
        return { events: state.historyEvents };
      },
      async sendTurn(value) {
        calls.sendTurn.push(value);
        return { accepted: true, turnId: value.turnId };
      },
      async cancelTurn(value) {
        calls.cancelTurn.push(value);
        return { accepted: true };
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

test("software assistant uses a fixed, non-contact DSH session and injects no memory-recall context", async (t) => {
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
  const manualPath = resolveSoftwareAssistantManualPath(dataRoot);
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.sessionId, SUZU_SOFTWARE_ASSISTANT_SESSION_ID);
  assert.equal(snapshot.workspaceDirectory, workspaceDirectory);
  assert.deepEqual(snapshot.messages, []);
  await assert.doesNotReject(fs.stat(workspaceDirectory));
  assert.match(await fs.readFile(manualPath, "utf8"), /# Suzu Lives 使用说明/u);
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
  assert.match(dynamic.blocks[0].text, /软件能力按联系人分别安装和启用/u);
  assert.ok(dynamic.blocks[0].text.includes(manualPath));
  assert.match(dynamic.blocks[0].text, /软件本体\/源码位置：D:\\Apps\\Suzu Lives\\app/u);
  assert.match(dynamic.blocks[0].text, /本机文件、搜索和 PowerShell 工具/u);
  assert.match(dynamic.blocks[0].text, /默认不自动读取联系人、相处设定、长期记忆/u);
  assert.doesNotMatch(dynamic.blocks[0].text, /secret-dsh-key/u);

  fake.emit({
    type: "lifecycle-request",
    requestId: "user-facing-manual",
    lifecycleEvent: "SoftwareAssistantManual",
    data: { sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID, query: "怎样配置语音" },
  });
  await waitFor(() => responseById(fake.calls, "user-facing-manual"), "用户说明书响应");
  const manual = responseById(fake.calls, "user-facing-manual").result.content;
  assert.match(manual, /用户当前想做的事：怎样配置语音/u);
  assert.match(manual, /当前软件的可跳转页面（调用 navigate 时只能使用括号内的 ID）/u);
  assert.match(manual, /- 语音消息（voice-message）：能力 · TTS、ASR、音色与语音通话设置。/u);
  assert.match(manual, /## 语音消息与语音通话/u);
  assert.match(manual, /设置 → API/u);
  assert.match(manual, /## 想做什么，去哪里/u);
  assert.match(manual, /主动关心的开关在当前联系人的聊天设置/u);
  assert.match(manual, /日历里的“联系人日期”和节日用于提醒与查看资料/u);
  assert.match(manual, /创造.*视觉工作台/u);
  assert.doesNotMatch(manual, /能力 → 陪伴 → 主动关心/u);
  assert.doesNotMatch(manual, /声音设计/u);
  assert.match(manual, /## 上下文整理（记忆压缩器）/u);
  assert.match(manual, /32,000 Token/u);
  assert.match(manual, /### 外部能力（Skill \/ MCP）/u);
  assert.match(manual, /审批模式/u);
  assert.match(manual, /费用趋势/u);
  assert.match(manual, /对方正在输入…/u);
  assert.match(manual, /若说明书没有覆盖/u);
  assert.match(DEFAULT_SUZU_SOFTWARE_ASSISTANT_COMPACTION_PROMPT, /供后续操作使用的工作记录/u);
  assert.match(DEFAULT_SUZU_SOFTWARE_ASSISTANT_COMPACTION_PROMPT, /## 已完成/u);
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
  fake.emit({ type: "assistant-completed", sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID, turnId: sent.requestId, text: "已为你切换为深色主题。" });
  assert.deepEqual(events.filter((event) => event.requestId === sent.requestId).map((event) => [event.type, event.content]), [
    ["reply-stream", "已为你"],
    ["reply", "已为你切换为深色主题。"],
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
