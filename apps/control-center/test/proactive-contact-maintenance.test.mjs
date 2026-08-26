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
  proactiveContactTaskPurpose,
  proactiveContactTaskPrompt,
  proactiveContactTimingDecision,
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

  const decision = proactiveContactTimingDecision(JSON.stringify({
    delayMinutes: 150,
    nextCheckPurpose: "等对方忙完后，看看是否适合问问今天过得怎么样。",
  }));
  assert.deepEqual(decision, {
    delay: "150m",
    delayMinutes: 150,
    nextCheckPurpose: "等对方忙完后，看看是否适合问问今天过得怎么样。",
  });
  const next = await scheduleNextProactiveContactCheck({
    dataRoot,
    contactId,
    delay: decision.delay,
    nextCheckPurpose: decision.nextCheckPurpose,
    now,
  });
  assert.notEqual(next.id, initial.id);
  assert.equal(next.target.prompt, [
    PROACTIVE_CONTACT_TASK_PROMPT,
    "下次检查时想关注：等对方忙完后，看看是否适合问问今天过得怎么样。",
  ].join("\n"));
  assert.equal(proactiveContactTaskPurpose(next), decision.nextCheckPurpose);
  assert.equal(next.dueAt, "2026-08-10T04:30:00.000Z");
  assert.equal((await listScheduleTasks({ dataRoot })).length, 1);
  assert.equal(isActiveProactiveContactTask((await listScheduleTasks({ dataRoot }))[0], { contactId }), true);
});

test("maintenance keeps one current check after an interrupted duplicate write", async () => {
  const dataRoot = await temporaryDirectory("suzu-proactive-duplicate-");
  const contactId = "contact-duplicate";
  const now = new Date("2026-08-10T10:00:00+08:00");
  await createProactiveContactTask({ dataRoot, contactId, delay: "2h", now });
  await createProactiveContactTask({
    dataRoot,
    contactId,
    delay: "1d",
    nextCheckPurpose: "明天再看看对方有没有休息好。",
    now: new Date("2026-08-10T10:00:01+08:00"),
  });

  const repaired = await maintainProactiveContactChecks({
    dataRoot,
    now: new Date("2026-08-10T10:00:02+08:00"),
    settings: { autoMaintain: true, enabledContactIds: [contactId] },
  });

  assert.equal(repaired.length, 1);
  assert.equal(proactiveContactTaskPurpose(repaired[0]), "明天再看看对方有没有休息好。");
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
  assert.equal(proactiveContactTaskPrompt({ nextCheckPurpose: "看看对方有没有休息好。" }), [
    "【主动关心 A】",
    "你上次安排这次检查时，想关注的是：看看对方有没有休息好。",
    "依据当前时间和最近的互动频率，判断现在是否主动联系对方。",
    "要联系就发消息；否则输出 NO_REPLY。",
  ].join("\n"));
});

test("the timing prompt keeps the next check's time and purpose together", () => {
  const prompt = proactiveContactTimingTaskPrompt();

  assert.equal(prompt, [
    "【安排下一次主动关心】",
    "请安排下一次再来看看对方的时间，并留下一句到时想关注什么。",
    "时间到了，软件会把这句关注点和届时最新的聊天一起交给你，再由你判断是否适合主动发消息。",
    "请按照你们最近的互动和相处节奏选择间隔：互动正频繁、对方可能需要陪伴时，可以早点再看；刚聊完、对方在忙或正在休息时，可以晚些再看。",
    "只返回一个 JSON 对象：delayMinutes 是 15–720 的整数；nextCheckPurpose 用一句简短的话写清楚那时为什么要再看看对方。",
  ].join("\n"));
  assert.deepEqual(proactiveContactTimingDecision(JSON.stringify({
    delayMinutes: 90,
    nextCheckPurpose: "晚一点看看对方是不是忙完了。",
  })), {
    delay: "90m",
    delayMinutes: 90,
    nextCheckPurpose: "晚一点看看对方是不是忙完了。",
  });
  assert.equal(proactiveContactTimingDecision('{"delayMinutes":90}'), null);
  assert.equal(proactiveContactTimingDecision('{"delayMinutes":90,"nextCheckPurpose":""}'), null);
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
