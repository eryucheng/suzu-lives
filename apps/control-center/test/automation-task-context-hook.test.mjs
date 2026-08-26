import assert from "node:assert/strict";
import test from "node:test";

import { createAutomationTaskContextHook } from "../electron/services/automation-task-context-hook.mjs";

test("automation task context keeps the originating turn kind for presentation", () => {
  const hook = createAutomationTaskContextHook();
  const context = hook.collect({
    kind: "call-ended",
    outputPolicy: "external",
    taskContext: { id: "hangup-task", text: "【通话已结束】" },
    turnId: "hangup-turn",
  });

  assert.deepEqual(context?.metadata, {
    outputPolicy: "external",
    taskId: "hangup-task",
    turnKind: "call-ended",
  });
  assert.equal(context?.text, "【通话已结束】");
  assert.deepEqual(context?.display, {
    category: "automation",
    context: true,
    label: "自动任务",
    transcript: false,
  });
});
