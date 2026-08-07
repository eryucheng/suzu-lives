import assert from "node:assert/strict";
import test from "node:test";

import {
  isAutomationPrompt,
  isOperationalText,
  standardizeCompactedPrefix,
  visibleAssistantTexts,
} from "../src/conversation.mjs";

function entry({
  uuid,
  parentUuid = null,
  type,
  role,
  content,
  stopReason = null,
}) {
  return {
    index: Number(uuid.replace(/\D/gu, "")) || 0,
    record: {
      uuid,
      parentUuid,
      type,
      message: {
        role,
        content,
        stop_reason: stopReason,
      },
    },
  };
}

test("recognizes legacy proactive prompts by their complete workflow semantics", () => {
  assert.equal(isAutomationPrompt([
    "你现在是某个角色。这是链式主动关心机制的第N次触发。",
    "如果没必要就 NO_REPLY。",
    "用 timer add 设置下一次触发。",
  ].join("\n")), true);
  assert.equal(isAutomationPrompt([
    "检查当前时间和上文的对话内容，判断是否应该主动给某人发消息。",
    "如果觉得没必要就保持沉默直接 NO_REPLY。",
  ].join("\n")), true);
  assert.equal(isAutomationPrompt("我正在讨论主动关心机制，但现在不执行任务。"), false);
});

test("removes a complete legacy automation turn without dropping the next real turn", () => {
  const messages = standardizeCompactedPrefix({
    prefix: [
      entry({
        uuid: "u1",
        type: "user",
        role: "user",
        content: "检查当前时间和上文的对话内容，判断是否应该主动给某人发消息；没有必要就 NO_REPLY。",
      }),
      entry({
        uuid: "a2",
        parentUuid: "u1",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "内部判断过程不应归档。" }],
      }),
      entry({
        uuid: "u3",
        parentUuid: "a2",
        type: "user",
        role: "user",
        content: "我今天去了科技馆。",
      }),
      entry({
        uuid: "a4",
        parentUuid: "u3",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "你看了什么展览？" }],
      }),
    ],
  });
  assert.deepEqual(messages.map((item) => item.text), [
    "我今天去了科技馆。",
    "你看了什么展览？",
  ]);
});

test("treats fixed attachment bridge text and damaged NO_REPLY as operational", () => {
  assert.equal(isOperationalText("NO_REPLY</tool>"), true);
  assert.equal(isOperationalText([
    "Please analyze the attached image(s).",
    "",
    "(Images also saved locally: C:\\agent\\attachments\\image.jpg)",
  ].join("\n")), true);
  assert.equal(isOperationalText("Please analyze this image carefully."), false);
});

test("removes English tool-planning leaks only when the record actually stops for a tool", () => {
  const planning = entry({
    uuid: "a1",
    type: "assistant",
    role: "assistant",
    stopReason: "tool_use",
    // Claude JSONL may put the text preamble and the subsequent tool call in
    // separate physical records, while retaining stop_reason=tool_use here.
    content: [{ type: "text", text: "I need to initialize the list before the argument loop." }],
  });
  const ordinary = entry({
    uuid: "a2",
    type: "assistant",
    role: "assistant",
    content: [{ type: "text", text: "I need to tell you something important." }],
  });
  assert.deepEqual(visibleAssistantTexts(planning), []);
  assert.deepEqual(visibleAssistantTexts(ordinary), ["I need to tell you something important."]);
});
