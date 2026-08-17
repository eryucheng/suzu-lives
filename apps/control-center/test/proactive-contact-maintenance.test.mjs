import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createScheduleTask, listScheduleTasks, setScheduleTaskEnabled } from "@suzu-lives/task-scheduler";
import {
  createProactiveChainPlanningTask,
  isActiveProactiveChainPlanningTask,
  maintainProactiveContactChains,
  PROACTIVE_CHAIN_DESCRIPTION,
  PROACTIVE_CHAIN_PLANNING_DESCRIPTION,
  PROACTIVE_CHAIN_PLANNING_TASK_PROMPT,
  PROACTIVE_CHAIN_RECOVERY_DELAY,
  PROACTIVE_CHAIN_TASK_PROMPT,
  proactiveCheckTaskPrompt,
} from "../electron/services/proactive-contact-maintenance.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("automatic proactive maintenance seeds one missing A task per enabled contact", async () => {
  const dataRoot = await temporaryDirectory("suzu-proactive-maintenance-");
  const now = new Date("2026-08-10T10:00:00+08:00");
  const settings = {
    autoMaintain: true,
    chainPrompt: "根据时间自然联系，并设置下一次任务。",
    enabledContactIds: ["contact-first", "contact-second"],
  };

  const created = await maintainProactiveContactChains({ dataRoot, now, settings });
  assert.equal(created.length, 2);
  assert.deepEqual(created.map((task) => ({
    description: task.description,
    dueAt: task.dueAt,
    prompt: task.target.prompt,
    source: task.source,
  })), [
    {
      description: PROACTIVE_CHAIN_DESCRIPTION,
      dueAt: "2026-08-10T02:01:00.000Z",
      prompt: PROACTIVE_CHAIN_TASK_PROMPT,
      source: "system",
    },
    {
      description: PROACTIVE_CHAIN_DESCRIPTION,
      dueAt: "2026-08-10T02:01:00.000Z",
      prompt: PROACTIVE_CHAIN_TASK_PROMPT,
      source: "system",
    },
  ]);
  assert.equal((await maintainProactiveContactChains({ dataRoot, now, settings })).length, 0);

  await setScheduleTaskEnabled({ dataRoot, id: created[0].id, enabled: false });
  const restored = await maintainProactiveContactChains({ dataRoot, now, settings });
  assert.equal(restored.length, 1);
  assert.equal(restored[0].target.contactId, "contact-first");
  assert.equal((await listScheduleTasks({ dataRoot })).filter((task) => task.enabled && task.description === PROACTIVE_CHAIN_DESCRIPTION).length, 2);
});

test("automatic proactive maintenance stays idle when the switch is off", async () => {
  const dataRoot = await temporaryDirectory("suzu-proactive-maintenance-off-");
  const settings = {
    autoMaintain: false,
    chainPrompt: "不会创建",
    enabledContactIds: ["contact-off"],
  };
  await createScheduleTask({
    dataRoot,
    delay: "5m",
    prompt: "临时回访",
    contactId: "contact-off",
    description: "临时回访",
  });

  assert.deepEqual(await maintainProactiveContactChains({ dataRoot, settings }), []);
  assert.equal((await listScheduleTasks({ dataRoot })).length, 1);
});

test("a queued scheduled turn covers its proactive chain until that turn finishes", async () => {
  const dataRoot = await temporaryDirectory("suzu-proactive-maintenance-queued-");
  const contactId = "contact-queued";
  const settings = {
    autoMaintain: true,
    chainPrompt: "等当前会话完成后再继续。",
    enabledContactIds: [contactId],
  };
  const checked = [];

  const blocked = await maintainProactiveContactChains({
    dataRoot,
    settings,
    hasPendingScheduledTurn: (scope) => {
      checked.push(scope.contactId);
      return scope.contactId === contactId;
    },
  });
  assert.deepEqual(blocked, []);
  assert.deepEqual(checked, [contactId]);
  assert.equal((await listScheduleTasks({ dataRoot })).length, 0);

  const restored = await maintainProactiveContactChains({
    dataRoot,
    settings,
    hasPendingScheduledTurn: () => false,
  });
  assert.equal(restored.length, 1);
  assert.equal(restored[0].target.contactId, contactId);
});

test("an internal B planning task covers the chain until it creates the next A", async () => {
  const dataRoot = await temporaryDirectory("suzu-proactive-planning-");
  const contactId = "contact-planning";
  const now = new Date("2026-08-10T10:00:00+08:00");
  const planning = await createProactiveChainPlanningTask({ dataRoot, contactId, now });

  assert.equal(planning.description, PROACTIVE_CHAIN_PLANNING_DESCRIPTION);
  assert.equal(planning.source, "system");
  assert.equal(planning.target.prompt, PROACTIVE_CHAIN_PLANNING_TASK_PROMPT);
  assert.equal(planning.dueAt, "2026-08-10T02:01:00.000Z");
  assert.equal(isActiveProactiveChainPlanningTask(planning, { contactId }), true);

  const created = await maintainProactiveContactChains({
    dataRoot,
    now,
    settings: {
      autoMaintain: true,
      chainPrompt: "不应在 B 等待时额外创建 A。",
      enabledContactIds: [contactId],
    },
  });
  assert.deepEqual(created, []);
});

test("A prompt keeps the decision in thinking and leaves next scheduling to B", () => {
  const prompt = proactiveCheckTaskPrompt("根据上次聊天判断是否联系。");
  assert.match(prompt, /判断阶段（A）/u);
  assert.match(prompt, /判断过程留在思考/u);
  assert.match(prompt, /不要创建、修改或删除自动任务/u);
  assert.match(prompt, /NO_REPLY/u);
});

test("a missing post-turn chain is restored two hours later", async () => {
  const dataRoot = await temporaryDirectory("suzu-proactive-maintenance-recovery-");
  const now = new Date("2026-08-10T10:00:00+08:00");
  const settings = {
    autoMaintain: true,
    chainPrompt: "当前链没有续约时，稍后再联系。",
    enabledContactIds: ["contact-recovery"],
  };

  const [recovered] = await maintainProactiveContactChains({
    dataRoot,
    now,
    nextTaskDelay: PROACTIVE_CHAIN_RECOVERY_DELAY,
    settings,
  });

  assert.equal(recovered.target.contactId, "contact-recovery");
  assert.equal(recovered.dueAt, "2026-08-10T04:00:00.000Z");
});

test("a targeted maintenance check only follows its own contact", async () => {
  const dataRoot = await temporaryDirectory("suzu-proactive-maintenance-targeted-");
  const target = { contactId: "contact-running" };
  const otherTarget = { contactId: "contact-other" };
  const settings = {
    autoMaintain: true,
    chainPrompt: "继续链式主动关心。",
    enabledContactIds: [target.contactId, otherTarget.contactId],
  };

  const restored = await maintainProactiveContactChains({ dataRoot, scope: target, settings });
  assert.equal(restored.length, 1);
  assert.equal(restored[0].target.contactId, target.contactId);
  assert.equal((await listScheduleTasks({ dataRoot })).length, 1);
});
