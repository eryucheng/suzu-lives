import assert from "node:assert/strict";
import test from "node:test";

import { standardizeCompactedPrefix } from "../memory/rag/ingest.mjs";

function entry(index, record) {
  return { index, line: index + 1, record };
}

test("RAG 入库同时保留双方文本并过滤运行噪声", () => {
  const prefix = [
    entry(0, {
      uuid: "user-1",
      timestamp: "2026-07-01T08:00:00.000Z",
      type: "user",
      message: {
        role: "user",
        content: "<system-reminder>运行时提示</system-reminder>周六一起去看海。\ntest\n\nContext:\n```json\n{\"uid\":123}\n```\n发自我的 iPhone",
      },
    }),
    entry(1, {
      uuid: "assistant-1",
      timestamp: "2026-07-01T08:00:05.000Z",
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "不应入库" },
          { type: "text", text: "好，我会带上蓝色保温杯。" },
          { type: "tool_use", name: "timer", input: {} },
        ],
      },
    }),
    entry(2, {
      uuid: "auto-1",
      timestamp: "2026-07-01T09:00:00.000Z",
      type: "user",
      message: { role: "user", content: "链式关心。当前时间 09:00" },
    }),
    entry(3, {
      uuid: "auto-answer-1",
      timestamp: "2026-07-01T09:00:03.000Z",
      type: "assistant",
      message: { role: "assistant", content: "NO_REPLY" },
    }),
  ];

  const messages = standardizeCompactedPrefix({
    prefix,
    userName: "用户",
    memoryOwner: "Agent",
  });

  assert.deepEqual(messages.map(({ role, speaker, text }) => ({ role, speaker, text })), [
    { role: "user", speaker: "用户", text: "周六一起去看海。" },
    { role: "assistant", speaker: "Agent", text: "好，我会带上蓝色保温杯。" },
  ]);
});

test("旧版主动关心提示和 API 错误不会进入 RAG", () => {
  const prefix = [
    entry(0, {
      uuid: "legacy-auto",
      timestamp: "2026-07-01T08:00:00.000Z",
      type: "user",
      message: { role: "user", content: "根据时间和前面聊的内容判断要不要给用户发消息" },
    }),
    entry(1, {
      uuid: "legacy-auto-answer",
      timestamp: "2026-07-01T08:00:01.000Z",
      type: "assistant",
      message: { role: "assistant", content: "该主动关心了" },
    }),
    entry(2, {
      uuid: "normal-user",
      timestamp: "2026-07-01T09:00:00.000Z",
      type: "user",
      message: { role: "user", content: "今天喝了拿铁" },
    }),
    entry(3, {
      uuid: "api-error",
      timestamp: "2026-07-01T09:00:01.000Z",
      type: "assistant",
      message: { role: "assistant", content: "API Error: 402 Insufficient Balance" },
    }),
    entry(4, {
      uuid: "task-notification",
      timestamp: "2026-07-01T09:00:02.000Z",
      type: "user",
      message: { role: "user", content: "<task-notification><result>工具输出</result></task-notification>" },
    }),
  ];

  const messages = standardizeCompactedPrefix({ prefix, userName: "用户", memoryOwner: "Agent" });
  assert.deepEqual(messages.map((item) => item.text), ["今天喝了拿铁"]);
});
