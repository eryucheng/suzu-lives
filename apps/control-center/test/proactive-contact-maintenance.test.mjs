import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createScheduleTask, listScheduleTasks, setScheduleTaskEnabled } from "@suzu-lives/task-scheduler";
import {
  createProactiveContactTask,
  isActiveProactiveContactTask,
  isProactiveContactTask,
  maintainProactiveContactChecks,
  proactiveContactNextCheckDelay,
  proactiveContactTaskPrompt,
  proactiveContactTimingTaskPrompt,
  PROACTIVE_CONTACT_DESCRIPTION,
  PROACTIVE_CONTACT_INITIAL_DELAY,
  PROACTIVE_CONTACT_RECOVERY_DELAY,
  PROACTIVE_CONTACT_TASK_PROMPT,
  scheduleNextProactiveContactCheck,
} from "../electron/services/proactive-contact-maintenance.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("automatic proactive maintenance seeds one missing contact check per enabled contact", async () => {
  const dataRoot = await temporaryDirectory("suzu-proactive-maintenance-");
  const now = new Date("2026-08-10T10:00:00+08:00");
  const settings = {
    autoMaintain: true,
    contactPrompt: "根据时间自然联系。",
    enabledContactIds: ["contact-first", "contact-second"],
  };

  const created = await maintainProactiveContactChecks({ dataRoot, now, settings });
  assert.equal(created.length, 2);
  assert.deepEqual(created.map((task) => ({
    description: task.description,
    dueAt: task.dueAt,
    prompt: task.target.prompt,
    source: task.source,
  })), [
    {
      description: PROACTIVE_CONTACT_DESCRIPTION,
      dueAt: "2026-08-10T02:01:00.000Z",
      prompt: PROACTIVE_CONTACT_TASK_PROMPT,
      source: "system",
    },
    {
      description: PROACTIVE_CONTACT_DESCRIPTION,
      dueAt: "2026-08-10T02:01:00.000Z",
      prompt: PROACTIVE_CONTACT_TASK_PROMPT,
      source: "system",
    },
  ]);
  assert.equal((await maintainProactiveContactChecks({ dataRoot, now, settings })).length, 0);

  await setScheduleTaskEnabled({ dataRoot, id: created[0].id, enabled: false });
  const restored = await maintainProactiveContactChecks({ dataRoot, now, settings });
  assert.equal(restored.length, 1);
  assert.equal(restored[0].target.contactId, "contact-first");
  const current = await listScheduleTasks({ dataRoot });
  assert.equal(current.filter((task) => task.enabled && task.description === PROACTIVE_CONTACT_DESCRIPTION).length, 2);
  assert.equal(current.filter((task) => isProactiveContactTask(task, { contactId: task.target.contactId })).length, 2);
});

test("automatic proactive maintenance stays idle when the switch is off", async () => {
  const dataRoot = await temporaryDirectory("suzu-proactive-maintenance-off-");
  const settings = {
    autoMaintain: false,
    enabledContactIds: ["contact-off"],
  };
  await createScheduleTask({
    dataRoot,
    delay: "5m",
    prompt: "临时回访",
    contactId: "contact-off",
    description: "临时回访",
  });

  assert.deepEqual(await maintainProactiveContactChecks({ dataRoot, settings }), []);
  assert.equal((await listScheduleTasks({ dataRoot })).length, 1);
});

test("turning proactive contact off removes only its product-managed work", async () => {
  const dataRoot = await temporaryDirectory("suzu-proactive-maintenance-disable-");
  const contactId = "contact-disabled";
  await createProactiveContactTask({ dataRoot, contactId, delay: "2h" });
  await createScheduleTask({
    dataRoot,
    delay: "2h",
    prompt: "保留的手工事项",
    contactId,
    description: "临时回访",
    source: "manual",
  });

  assert.deepEqual(await maintainProactiveContactChecks({
    dataRoot,
    settings: { autoMaintain: false, enabledContactIds: [contactId] },
  }), []);
  const tasks = await listScheduleTasks({ dataRoot });
  assert.equal(tasks.some((task) => isProactiveContactTask(task, { contactId })), false);
  assert.equal(tasks.some((task) => task.description === "临时回访"), true);
});

test("a queued proactive Agent turn covers the contact until its next check is written", async () => {
  const dataRoot = await temporaryDirectory("suzu-proactive-maintenance-queued-");
  const contactId = "contact-queued";
  const settings = {
    autoMaintain: true,
    enabledContactIds: [contactId],
  };
  const checked = [];

  const blocked = await maintainProactiveContactChecks({
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

  const restored = await maintainProactiveContactChecks({
    dataRoot,
    settings,
    hasPendingScheduledTurn: () => false,
  });
  assert.equal(restored.length, 1);
  assert.equal(restored[0].target.contactId, contactId);
});

test("maintenance removes retired A/B task records before scheduling a current contact check", async () => {
  const dataRoot = await temporaryDirectory("suzu-proactive-normalize-");
  const contactId = "contact-normalized";
  const now = new Date("2026-08-10T10:00:00+08:00");
  await createScheduleTask({
    dataRoot,
    delay: "15m",
    prompt: "运行主动关心 B：安排下一次 A 判断。",
    contactId,
    description: "安排下次主动关心",
    source: "agent",
    now,
  });
  await createScheduleTask({
    dataRoot,
    delay: "5m",
    prompt: "保留的手工事项",
    contactId,
    description: "手工计划",
    source: "manual",
    now,
  });

  const created = await maintainProactiveContactChecks({
    dataRoot,
    now,
    settings: { autoMaintain: true, enabledContactIds: [contactId] },
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].target.prompt, PROACTIVE_CONTACT_TASK_PROMPT);
  assert.equal(created[0].dueAt, "2026-08-10T02:01:00.000Z");
  const tasks = await listScheduleTasks({ dataRoot });
  assert.equal(tasks.filter((task) => isProactiveContactTask(task, { contactId })).length, 1);
  assert.equal(tasks.some((task) => task.description === "手工计划"), true);
});

test("the host writes the next contact check from Suzu's validated timing decision", async () => {
  const dataRoot = await temporaryDirectory("suzu-proactive-next-");
  const contactId = "contact-next";
  const now = new Date("2026-08-10T10:00:00+08:00");
  const initial = await createProactiveContactTask({
    dataRoot,
    contactId,
    delay: PROACTIVE_CONTACT_INITIAL_DELAY,
    now,
  });

  const delay = proactiveContactNextCheckDelay('{"delayMinutes":150}');
  assert.equal(delay, "150m");
  const next = await scheduleNextProactiveContactCheck({ dataRoot, contactId, delay, now });
  assert.notEqual(next.id, initial.id);
  assert.equal(next.target.prompt, PROACTIVE_CONTACT_TASK_PROMPT);
  assert.equal(next.dueAt, "2026-08-10T04:30:00.000Z");
  assert.equal((await listScheduleTasks({ dataRoot })).length, 1);
  assert.equal(isActiveProactiveContactTask((await listScheduleTasks({ dataRoot }))[0], { contactId }), true);
});

test("maintenance keeps one current check after an interrupted duplicate write", async () => {
  const dataRoot = await temporaryDirectory("suzu-proactive-duplicate-");
  const contactId = "contact-duplicate";
  const now = new Date("2026-08-10T10:00:00+08:00");
  await createProactiveContactTask({ dataRoot, contactId, delay: "2h", now });
  await createProactiveContactTask({ dataRoot, contactId, delay: "1d", now: new Date("2026-08-10T10:00:01+08:00") });

  const repaired = await maintainProactiveContactChecks({
    dataRoot,
    now: new Date("2026-08-10T10:00:02+08:00"),
    settings: { autoMaintain: true, enabledContactIds: [contactId] },
  });

  assert.equal(repaired.length, 1);
  assert.equal(repaired[0].target.prompt, PROACTIVE_CONTACT_TASK_PROMPT);
  assert.equal(repaired[0].dueAt, "2026-08-11T02:00:02.000Z");
  assert.equal((await listScheduleTasks({ dataRoot })).filter((task) => isActiveProactiveContactTask(task, { contactId })).length, 1);
});

test("the contact prompt defines the contact decision", () => {
  const prompt = proactiveContactTaskPrompt();

  assert.equal(prompt, [
    "【主动关心 A】",
    "依据当前时间和最近的互动频率，判断现在是否主动联系对方。",
    "要联系就发消息；否则输出 NO_REPLY。",
  ].join("\n"));
});

test("the timing prompt defines the next-delay JSON", () => {
  const prompt = proactiveContactTimingTaskPrompt();

  assert.equal(prompt, [
    "【主动关心 B】",
    "任务：提供下一次检查间隔。",
    "参考：当前时间、最近互动和相处节奏。",
    "结果格式：{\"delayMinutes\": <15–720 的整数>}。",
    "软件会依据这个值创建下一次主动关心任务。",
    '{"delayMinutes":42}',
  ].join("\n"));
  assert.equal(proactiveContactNextCheckDelay('{"delayMinutes":15}'), "15m");
  assert.equal(proactiveContactNextCheckDelay('{"delayMinutes":720}'), "720m");
  assert.equal(proactiveContactNextCheckDelay('{"delayMinutes":14}'), "");
  assert.equal(proactiveContactNextCheckDelay('{"delayMinutes":721}'), "");
  assert.equal(proactiveContactNextCheckDelay('{"delayMinutes":"42"}'), "");
  assert.equal(proactiveContactNextCheckDelay('{"nextCheckLocal":"2026-08-10 12:00"}'), "");
  assert.equal(proactiveContactNextCheckDelay("明天下午"), "");
});

test("a missing check can be restored with the recovery delay", async () => {
  const dataRoot = await temporaryDirectory("suzu-proactive-maintenance-interval-");
  const now = new Date("2026-08-10T10:00:00+08:00");
  const settings = {
    autoMaintain: true,
    enabledContactIds: ["contact-interval"],
  };

  const [restored] = await maintainProactiveContactChecks({
    dataRoot,
    now,
    nextTaskDelay: PROACTIVE_CONTACT_RECOVERY_DELAY,
    settings,
  });

  assert.equal(restored.target.contactId, "contact-interval");
  assert.equal(restored.dueAt, "2026-08-10T04:00:00.000Z");
});

test("a targeted maintenance check only follows its own contact", async () => {
  const dataRoot = await temporaryDirectory("suzu-proactive-maintenance-targeted-");
  const target = { contactId: "contact-running" };
  const otherTarget = { contactId: "contact-other" };
  const settings = {
    autoMaintain: true,
    enabledContactIds: [target.contactId, otherTarget.contactId],
  };

  const restored = await maintainProactiveContactChecks({ dataRoot, scope: target, settings });
  assert.equal(restored.length, 1);
  assert.equal(restored[0].target.contactId, target.contactId);
  assert.equal((await listScheduleTasks({ dataRoot })).length, 1);
});
