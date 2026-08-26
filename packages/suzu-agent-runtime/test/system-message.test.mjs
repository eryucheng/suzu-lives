import assert from "node:assert/strict";
import test from "node:test";

import {
  SYSTEM_MESSAGE_PLACEMENTS,
  createSystemMessage,
  createSystemMessageInjection,
  projectSystemMessageInjections,
} from "../src/index.mjs";

test("createSystemMessage preserves Core message identity, cloning, and freezing semantics with a system role", () => {
  const input = {
    role: "user",
    content: [{ type: "text", text: "执行内部任务。" }],
    source: { kind: "plugin", plugin: "test" },
  };

  const message = createSystemMessage(input);
  input.content[0].text = "已修改输入";

  assert.equal(message.role, "system");
  assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  assert.equal(message.content[0].text, "执行内部任务。");
  assert.equal(Object.isFrozen(message), true);
  assert.equal(Object.isFrozen(message.content), true);
  assert.equal(Object.isFrozen(message.content[0]), true);
  assert.equal(Object.isFrozen(message.source), true);
});

test("system message injections preserve explicit prompt and history-tail placement", () => {
  const promptMessage = createSystemMessage({
    content: [{ type: "text", text: "本轮遵循结构化输出。" }],
    source: { kind: "plugin", plugin: "test" },
  });
  const tailMessage = createSystemMessage({
    content: [{ type: "text", text: "检查当前自动任务。" }],
    source: { kind: "plugin", plugin: "test" },
  });
  const history = [{ id: "history-user", role: "user", content: [], source: { kind: "plugin", plugin: "test" } }];

  const projection = projectSystemMessageInjections({
    system: "基础提示",
    messages: history,
  }, [
    createSystemMessageInjection({
      message: promptMessage,
      placement: SYSTEM_MESSAGE_PLACEMENTS.PROMPT,
    }),
    createSystemMessageInjection({
      message: tailMessage,
      placement: SYSTEM_MESSAGE_PLACEMENTS.HISTORY_TAIL,
    }),
  ]);

  assert.equal(projection.system, "基础提示\n\n本轮遵循结构化输出。");
  assert.deepEqual(projection.messages, [history[0], tailMessage]);
  assert.equal(projection.messages.at(-1).role, "system");
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(projection.messages), true);
});
