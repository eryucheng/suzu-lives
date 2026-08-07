import assert from "node:assert/strict";
import test from "node:test";

import { renderProactiveContactSkill } from "../src/index.mjs";

test("proactive-contact uses the scoped Suzu schedule command in its thin owned Skill", () => {
  const skill = renderProactiveContactSkill();

  assert.match(skill, /当前会话系统提示中的 schedule add 命令> --delay Xm --prompt "<系统提示中的链式主动关心提示词>"/u);
  assert.match(skill, /--desc "链式主动关心"/u);
  assert.match(skill, /系统提示中的临时回访提示词/u);
  assert.match(skill, /当前会话系统提示中的 schedule list 命令/u);
  assert.match(skill, /当前会话系统提示中的 schedule remove 命令/u);
  assert.match(skill, /精确的 NO_REPLY/u);
  assert.doesNotMatch(skill, /D:\\Apps|config\.local|registry\.local|ling/iu);
});
