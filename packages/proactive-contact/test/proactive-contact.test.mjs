import assert from "node:assert/strict";
import test from "node:test";

import { renderProactiveContactSkill } from "../src/index.mjs";

test("proactive-contact describes the current A/B chain and scoped temporary follow-up commands", () => {
  const skill = renderProactiveContactSkill();

  assert.match(skill, /A → B → 下一条 A/u);
  assert.match(skill, /A 是一次联系判断/u);
  assert.match(skill, /B 负责为当前联系人创建下一次 A/u);
  assert.match(skill, /系统提示中的临时回访提示词/u);
  assert.match(skill, /当前会话系统提示中的 schedule list 命令/u);
  assert.match(skill, /当前会话系统提示中的 schedule remove 命令/u);
  assert.match(skill, /精确的 NO_REPLY/u);
  assert.doesNotMatch(skill, /D:\\Apps|config\.local|registry\.local|ling/iu);
});
