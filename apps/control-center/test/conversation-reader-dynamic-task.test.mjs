import assert from "node:assert/strict";
import test from "node:test";

import { conversationContextRecords, conversationDisplayMessages } from "../electron/services/conversation-reader.mjs";
import { filterConversationItems } from "../src/features/conversation/index.mjs";

function dynamicTaskInput({ id, outputPolicy, taskContextId = id, additionalSections = [] }) {
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
          metadata: { outputPolicy },
        }, ...additionalSections],
      },
    },
  };
}

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
    { ...dynamicTaskInput({ id: "check-task", outputPolicy: "external" }), seq: 2, time: 2_000 },
    {
      ...assistantMessage("check-no-reply", [
        { type: "reasoning", text: "当前不应重复打扰用户。" },
        { type: "text", text: "NO_REPLY" },
      ]),
      seq: 3,
      time: 3_000,
    },
    { type: "turn/end", seq: 4, time: 4_000, data: { turn: 1 } },
    { ...dynamicTaskInput({ id: "plan-task", outputPolicy: "silent" }), seq: 5, time: 5_000 },
    {
      ...assistantMessage("plan-reply", [{ type: "text", text: "已安排下一次主动关心。" }]),
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

  assert.equal(conversationDisplayMessages(events).some((message) => message.kind === "dynamic-context"), false);

  const messages = conversationDisplayMessages(events, 500, { includeDynamicContext: true });

  assert.deepEqual(messages.filter((message) => message.kind !== "dynamic-context").map((message) => [
    message.id,
    message.blocks.map((block) => block.text).join("\n"),
  ]), [
    ["human-before", "你好"],
    ["proactive-reply", "晚上好，今天过得怎么样？"],
    ["human-after", "我回来啦"],
  ]);
  assert.deepEqual(messages.filter((message) => message.kind === "dynamic-context").map((message) => [
    message.id,
    message.blocks[0]?.text,
  ]), [
    ["check-task:dynamic-context", "【automation-task】\n这是 Suzu 自动任务触发，不是用户发来的新消息。"],
    ["plan-task:dynamic-context", "【automation-task】\n这是 Suzu 自动任务触发，不是用户发来的新消息。"],
    ["proactive-task:dynamic-context", "【automation-task】\n这是 Suzu 自动任务触发，不是用户发来的新消息。"],
  ]);
  assert.equal(filterConversationItems(messages, { dynamicContext: false }).some((message) => message.kind === "dynamic-context"), false);
  assert.equal(filterConversationItems(messages, { dynamicContext: true }).filter((message) => message.kind === "dynamic-context").length, 3);
});

test("reader represents one automatic task across its model steps while preserving step-scoped diagnostics", () => {
  const events = [
    { type: "step/start", seq: 1, time: 500, data: { turn: 1, step: 1 } },
    {
      ...dynamicTaskInput({
        id: "planning-step-one",
        taskContextId: "planning-turn",
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
      ...assistantMessage("planning-working", [{ type: "text", text: "先检查近期对话。" }]),
      seq: 3,
      time: 1_500,
    },
    { type: "step/start", seq: 4, time: 1_750, data: { turn: 1, step: 2 } },
    {
      ...dynamicTaskInput({
        id: "planning-step-two",
        taskContextId: "planning-turn",
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
      ...assistantMessage("planning-final", [{ type: "text", text: "下一次再联系。" }]),
      seq: 6,
      time: 2_500,
    },
    { type: "turn/end", seq: 7, time: 3_000, data: { turn: 1 } },
    { type: "step/start", seq: 8, time: 3_500, data: { turn: 2, step: 1 } },
    {
      ...dynamicTaskInput({
        id: "planning-next-run",
        taskContextId: "planning-turn",
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
      ...assistantMessage("planning-next-final", [{ type: "text", text: "已开始下一轮检查。" }]),
      seq: 10,
      time: 4_500,
    },
    { type: "turn/end", seq: 11, time: 5_000, data: { turn: 2 } },
  ];

  assert.deepEqual(conversationDisplayMessages(events).map((message) => [
    message.id,
    message.blocks.map((block) => block.text).join("\n"),
  ]), [
    ["planning-final", "下一次再联系。"],
    ["planning-next-final", "已开始下一轮检查。"],
  ]);

  const diagnostics = conversationDisplayMessages(events, 500, { includeDynamicContext: true })
    .filter((message) => message.kind === "dynamic-context");
  assert.deepEqual(diagnostics.map((message) => [message.id, message.blocks[0]?.text]), [
    [
      "planning-step-one:dynamic-context",
      "【automation-task】\n这是 Suzu 自动任务触发，不是用户发来的新消息。\n\n【time-awareness】\n当前时间：10:00。",
    ],
    ["planning-step-two:dynamic-context", "【time-awareness】\n当前时间：10:01。"],
    [
      "planning-next-run:dynamic-context",
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
