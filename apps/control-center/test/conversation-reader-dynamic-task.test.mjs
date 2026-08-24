import assert from "node:assert/strict";
import test from "node:test";

import { conversationContextRecords, conversationDisplayMessages } from "../electron/services/conversation-reader.mjs";
import { filterConversationItems } from "../src/features/conversation/index.mjs";

function dynamicTaskInput({ id, outputPolicy, scheduleSource = "", taskContextId = id, turnKind = "", additionalSections = [] }) {
  return {
    type: "user/message",
    surfaceOp: "append",
    data: {
      id,
      role: "user",
      content: [{ type: "text", text: "仅供本次模型请求使用的实时背景资料。" }],
      source: {
        kind: "plugin",
        plugin: "suzu-lifecycle-bridge",
        form: "snapshot",
        sections: [{
          id: `${taskContextId}:task`,
          kind: "automation-task",
          text: "这是 Suzu 自动任务触发，不是用户发来的新消息。",
          metadata: { outputPolicy, ...(scheduleSource ? { scheduleSource } : {}), ...(turnKind ? { turnKind } : {}) },
        }, ...additionalSections],
      },
    },
  };
}

test("reader returns the post-hangup task reply to ordinary chat", () => {
  const events = [
    {
      type: "user/message",
      seq: 1,
      time: 1_000,
      surfaceOp: "append",
      data: {
        id: "call-transcript",
        role: "user",
        content: [{
          type: "text",
          text: '<suzu-voice-call-turn>\n{"source":"suzu-live-call","transcript":"那我先挂了"}\n</suzu-voice-call-turn>',
        }],
        source: { kind: "user" },
      },
    },
    { ...assistantMessage("call-reply", [{ type: "text", text: "好，晚点见。" }]), seq: 2, time: 2_000 },
    { type: "turn/end", seq: 3, time: 3_000, data: { turn: 1 } },
    {
      ...dynamicTaskInput({
        id: "call-ended-task",
        outputPolicy: "external",
        turnKind: "call-ended",
      }),
      seq: 4,
      time: 4_000,
    },
    { ...assistantMessage("post-hangup-reply", [{ type: "text", text: "我会记得刚才说的事。" }]), seq: 5, time: 5_000 },
    { type: "turn/end", seq: 6, time: 6_000, data: { turn: 2 } },
  ];

  assert.deepEqual(conversationDisplayMessages(events).map((message) => [
    message.kind,
    message.blocks.map((block) => block.text).join("\n"),
  ]), [
    ["system", "通话 · 我：那我先挂了"],
    ["system", "通话 · 对方：好，晚点见。"],
    ["assistant", "我会记得刚才说的事。"],
  ]);
});

function assistantMessage(id, content) {
  return {
    type: "assistant/message",
    surfaceOp: "append",
    data: {
      message: {
        id,
        role: "assistant",
        content,
      },
    },
  };
}

test("reader exposes dynamic automation snapshots only through the opt-in diagnostic message kind", () => {
  const events = [
    {
      type: "user/message",
      seq: 1,
      time: 1_000,
      surfaceOp: "append",
      data: {
        id: "human-before",
        role: "user",
        content: [{ type: "text", text: "你好" }],
        source: { kind: "user" },
      },
    },
    { ...dynamicTaskInput({ id: "check-task", outputPolicy: "external", scheduleSource: "proactive-contact" }), seq: 2, time: 2_000 },
    {
      ...assistantMessage("check-no-reply", [
        { type: "reasoning", text: "当前不应重复打扰用户。" },
        { type: "text", text: "NO_REPLY" },
      ]),
      seq: 3,
      time: 3_000,
    },
    { type: "turn/end", seq: 4, time: 4_000, data: { turn: 1 } },
    { ...dynamicTaskInput({ id: "journal-task", outputPolicy: "silent" }), seq: 5, time: 5_000 },
    {
      ...assistantMessage("journal-reply", [{ type: "text", text: "今日日记已写入。" }]),
      seq: 6,
      time: 6_000,
    },
    { type: "turn/end", seq: 7, time: 7_000, data: { turn: 2 } },
    { ...dynamicTaskInput({ id: "proactive-task", outputPolicy: "external" }), seq: 8, time: 8_000 },
    {
      ...assistantMessage("proactive-reply", [{ type: "text", text: "晚上好，今天过得怎么样？" }]),
      seq: 9,
      time: 9_000,
    },
    { type: "turn/end", seq: 10, time: 10_000, data: { turn: 3 } },
    {
      type: "user/message",
      seq: 11,
      time: 11_000,
      surfaceOp: "append",
      data: {
        id: "human-after",
        role: "user",
        content: [{ type: "text", text: "我回来啦" }],
        source: { kind: "user" },
      },
    },
  ];

  const defaultMessages = conversationDisplayMessages(events);
  assert.equal(defaultMessages.some((message) => message.kind === "dynamic-context"), false);
  assert.deepEqual(defaultMessages.filter((message) => message.kind === "system").map((message) => [
    message.label,
    message.blocks[0]?.text,
  ]), [["主动关心", "当前不应重复打扰用户。\nNO_REPLY"]]);

  const messages = conversationDisplayMessages(events, 500, { includeDynamicContext: true });

  assert.deepEqual(messages.filter((message) => message.kind !== "dynamic-context").map((message) => [
    message.id,
    message.blocks.map((block) => block.text).join("\n"),
  ]), [
    ["human-before", "你好"],
    ["check-no-reply:system", "当前不应重复打扰用户。\nNO_REPLY"],
    ["proactive-reply", "晚上好，今天过得怎么样？"],
    ["human-after", "我回来啦"],
  ]);
  assert.deepEqual(messages.filter((message) => message.kind === "dynamic-context").map((message) => [
    message.id,
    message.blocks[0]?.text,
  ]), [
    ["check-task:dynamic-context", "【automation-task】\n这是 Suzu 自动任务触发，不是用户发来的新消息。"],
    ["journal-task:dynamic-context", "【automation-task】\n这是 Suzu 自动任务触发，不是用户发来的新消息。"],
    ["proactive-task:dynamic-context", "【automation-task】\n这是 Suzu 自动任务触发，不是用户发来的新消息。"],
  ]);
  assert.equal(filterConversationItems(messages, { dynamicContext: false }).some((message) => message.kind === "dynamic-context"), false);
  assert.equal(filterConversationItems(messages, { dynamicContext: true }).filter((message) => message.kind === "dynamic-context").length, 3);
  assert.equal(filterConversationItems(messages, { dynamicContext: true, system: false }).some((message) => message.kind === "system"), false);
  assert.equal(filterConversationItems(messages, { dynamicContext: false, system: true }).filter((message) => message.kind === "system").length, 1);
});

test("reader keeps cleaned proactive context and NO_REPLY available through their display switches", () => {
  const events = [
    { type: "step/start", seq: 1, time: 1_000, data: { turn: 1, step: 1 } },
    {
      ...dynamicTaskInput({
        id: "proactive-cleaned",
        outputPolicy: "external",
        scheduleSource: "proactive-contact",
      }),
      seq: 2,
      time: 2_000,
    },
    {
      ...assistantMessage("proactive-cleaned-result", [
        { type: "text", text: "NO_REPLY（现在不适合打扰）" },
      ]),
      seq: 3,
      time: 3_000,
    },
    { type: "turn/end", seq: 4, time: 4_000, data: { turn: 1 } },
    {
      type: "user/message",
      seq: 5,
      time: 5_000,
      surfaceOp: { op: "replace", start: 2, end: 3 },
      sourceEventSeqs: [2, 3],
      data: {
        id: "proactive-cleanup",
        role: "user",
        content: [],
        source: {
          kind: "plugin",
          plugin: "suzu-lifecycle-bridge",
          form: "task-cleanup",
        },
      },
    },
  ];

  const hiddenContext = conversationDisplayMessages(events);
  assert.deepEqual(hiddenContext.map((message) => [message.kind, message.blocks[0]?.text]), [
    ["system", "NO_REPLY（现在不适合打扰）"],
  ]);

  const visibleContext = conversationDisplayMessages(events, 500, { includeDynamicContext: true });
  assert.deepEqual(visibleContext.map((message) => [message.kind, message.blocks[0]?.text]), [
    ["dynamic-context", "【automation-task】\n这是 Suzu 自动任务触发，不是用户发来的新消息。"],
    ["system", "NO_REPLY（现在不适合打扰）"],
  ]);
});

test("reader keeps a completed silent task hidden when its opening snapshot is outside the history page", () => {
  const events = [
    {
      ...assistantMessage("proactive-b-delay", [{ type: "text", text: '{"delayMinutes":60}' }]),
      seq: 42,
      time: 42_000,
    },
    {
      type: "user/message",
      seq: 43,
      time: 43_000,
      surfaceOp: { op: "replace", start: 41, end: 42 },
      sourceEventSeqs: [41, 42],
      data: {
        id: "proactive-b-cleanup",
        role: "user",
        content: [],
        source: {
          kind: "plugin",
          plugin: "suzu-lifecycle-bridge",
          form: "task-cleanup",
        },
      },
    },
    {
      type: "user/message",
      seq: 44,
      time: 44_000,
      surfaceOp: "append",
      data: {
        id: "human-after-b",
        role: "user",
        content: [{ type: "text", text: "我回来啦" }],
        source: { kind: "user" },
      },
    },
  ];

  assert.deepEqual(conversationDisplayMessages(events).map((message) => message.id), ["human-after-b"]);
});

test("reader represents one automatic task across its model steps while preserving step-scoped diagnostics", () => {
  const events = [
    { type: "step/start", seq: 1, time: 500, data: { turn: 1, step: 1 } },
    {
      ...dynamicTaskInput({
        id: "automatic-step-one",
        taskContextId: "automatic-turn",
        outputPolicy: "external",
        additionalSections: [{
          id: "time-step-one",
          kind: "time-awareness",
          text: "当前时间：10:00。",
        }],
      }),
      seq: 2,
      time: 1_000,
    },
    {
      ...assistantMessage("automatic-working", [{ type: "text", text: "先检查当前状态。" }]),
      seq: 3,
      time: 1_500,
    },
    { type: "step/start", seq: 4, time: 1_750, data: { turn: 1, step: 2 } },
    {
      ...dynamicTaskInput({
        id: "automatic-step-two",
        taskContextId: "automatic-turn",
        outputPolicy: "external",
        additionalSections: [{
          id: "time-step-two",
          kind: "time-awareness",
          text: "当前时间：10:01。",
        }],
      }),
      seq: 5,
      time: 2_000,
    },
    {
      ...assistantMessage("automatic-final", [{ type: "text", text: "当前处理完成。" }]),
      seq: 6,
      time: 2_500,
    },
    { type: "turn/end", seq: 7, time: 3_000, data: { turn: 1 } },
    { type: "step/start", seq: 8, time: 3_500, data: { turn: 2, step: 1 } },
    {
      ...dynamicTaskInput({
        id: "automatic-follow-up",
        taskContextId: "automatic-follow-up-turn",
        outputPolicy: "external",
        additionalSections: [{
          id: "time-next-run",
          kind: "time-awareness",
          text: "当前时间：11:00。",
        }],
      }),
      seq: 9,
      time: 4_000,
    },
    {
      ...assistantMessage("automatic-follow-up-final", [{ type: "text", text: "后续处理完成。" }]),
      seq: 10,
      time: 4_500,
    },
    { type: "turn/end", seq: 11, time: 5_000, data: { turn: 2 } },
  ];

  assert.deepEqual(conversationDisplayMessages(events).map((message) => [
    message.id,
    message.blocks.map((block) => block.text).join("\n"),
  ]), [
    ["automatic-final", "当前处理完成。"],
    ["automatic-follow-up-final", "后续处理完成。"],
  ]);

  const diagnostics = conversationDisplayMessages(events, 500, { includeDynamicContext: true })
    .filter((message) => message.kind === "dynamic-context");
  assert.deepEqual(diagnostics.map((message) => [message.id, message.blocks[0]?.text]), [
    [
      "automatic-step-one:dynamic-context",
      "【automation-task】\n这是 Suzu 自动任务触发，不是用户发来的新消息。\n\n【time-awareness】\n当前时间：10:00。",
    ],
    ["automatic-step-two:dynamic-context", "【time-awareness】\n当前时间：10:01。"],
    [
      "automatic-follow-up:dynamic-context",
      "【automation-task】\n这是 Suzu 自动任务触发，不是用户发来的新消息。\n\n【time-awareness】\n当前时间：11:00。",
    ],
  ]);

  const records = conversationContextRecords(events);
  assert.deepEqual(records.map((record) => record.blocks.map((block) => [block.kind, block.text])), [
    [
      ["automation-task", "这是 Suzu 自动任务触发，不是用户发来的新消息。"],
      ["time-awareness", "当前时间：10:00。"],
    ],
    [["time-awareness", "当前时间：10:01。"]],
    [
      ["automation-task", "这是 Suzu 自动任务触发，不是用户发来的新消息。"],
      ["time-awareness", "当前时间：11:00。"],
    ],
  ]);
});
