import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createScheduleRunner,
  createScheduleTask,
  cronMatches,
  listScheduleHistory,
  listScheduleTasks,
  parseCronExpression,
  removeScheduleTask,
  runScheduleCli,
  scheduleTasksDirectory,
  setScheduleTaskEnabled,
} from "../src/index.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("one-shot schedule tasks persist below the Suzu data root and use the selected contact", async () => {
  const root = await temporaryDirectory("suzu-schedule-once-");
  const now = new Date("2026-08-05T10:00:00+08:00");
  const task = await createScheduleTask({
    dataRoot: root,
    delay: "45m",
    prompt: "45 分钟后自然回访。",
    contactId: "contact-follow-up",
    description: "临时回访",
    now,
  });

  assert.equal(task.kind, "once");
  assert.equal(task.dueAt, "2026-08-05T02:45:00.000Z");
  assert.equal(task.target.contactId, "contact-follow-up");
  assert.equal((await listScheduleTasks({ dataRoot: root })).length, 1);
  assert.equal(path.dirname(path.join(scheduleTasksDirectory(root), `${task.id}.json`)), scheduleTasksDirectory(root));
  assert.equal(await removeScheduleTask({ dataRoot: root, id: task.id }), true);
  assert.deepEqual(await listScheduleTasks({ dataRoot: root }), []);
});

test("cron expressions match in local time", () => {
  const cron = parseCronExpression("2 8,12,16,20 * * *");
  assert.equal(cronMatches(cron, new Date(2026, 7, 5, 8, 2)), true);
  assert.equal(cronMatches(cron, new Date(2026, 7, 5, 8, 3)), false);
  assert.equal(cronMatches("*/15 9-17 * * 1-5", new Date(2026, 7, 5, 9, 15)), true);
});

test("schedule CLI keeps delay and cron under one command with parameters", async () => {
  const root = await temporaryDirectory("suzu-schedule-cli-");
  const now = new Date("2026-08-05T10:00:00+08:00");
  const created = await runScheduleCli([
    "add", "--data-root", root, "--delay", "5m", "--contact-id", "contact-cli",
    "--prompt", "稍后回访", "--desc", "临时回访",
  ], { now });
  assert.equal(created.status, "ok");
  assert.equal(created.task.kind, "once");
  const cron = await runScheduleCli([
    "add", "--data-root", root, "--cron", "2 8,12,16,20 * * *", "--contact-id", "contact-cli", "--prompt", "每天问候", "--desc", "每日问候",
  ], { now });
  assert.equal(cron.task.kind, "cron");
  const listed = await runScheduleCli(["list", "--data-root", root]);
  assert.equal(listed.tasks.length, 2);
  const removed = await runScheduleCli(["remove", created.task.id, "--data-root", root]);
  assert.equal(removed.removed, true);
  await assert.rejects(
    () => runScheduleCli(["add", "--data-root", root, "--cron", "2 8,12,16,20 * * *", "--exec", "traveling-merchant", "--desc", "旧能力"], { now }),
    /内置操作与触发方式无效/u,
  );
});

test("manual plans can target a daily contact or a local system script and be closed without deleting", async () => {
  const root = await temporaryDirectory("suzu-schedule-manual-");
  const scriptPath = path.join(root, "scripts", "daily.py");
  const contact = await createScheduleTask({
    dataRoot: root,
    cron: "30 9 * * *",
    prompt: "每天早上问候一下。",
    contactId: "contact-daily",
    source: "manual",
  });
  const script = await createScheduleTask({
    dataRoot: root,
    delay: "5m",
    scriptPath,
    source: "manual",
  });

  assert.equal(contact.kind, "cron");
  assert.equal(contact.source, "manual");
  assert.equal(contact.target.type, "conversation");
  assert.equal(contact.target.contactId, "contact-daily");
  assert.equal(script.target.type, "script");
  assert.equal(script.target.scriptPath, path.resolve(scriptPath));

  const closed = await setScheduleTaskEnabled({ dataRoot: root, id: script.id, enabled: false });
  assert.equal(closed.enabled, false);
  const stored = (await listScheduleTasks({ dataRoot: root })).find((task) => task.id === script.id);
  assert.equal(stored?.enabled, false);
});

test("internal compactor operations keep their session scope and use the matching timer kind", async () => {
  const root = await temporaryDirectory("suzu-schedule-compactor-");
  const projectRoot = path.join(root, "contact-suzu");
  const timeTask = await createScheduleTask({
    dataRoot: root,
    cron: "30 9 * * *",
    exec: "conversation-compactor",
    operationTrigger: "time",
    projectRoot,
    sessionId: "session-suzu",
    source: "system",
  });
  const tokenTask = await createScheduleTask({
    dataRoot: root,
    delay: "1s",
    exec: "conversation-compactor",
    operationTrigger: "token",
    projectRoot,
    sessionId: "session-suzu",
    source: "system",
  });

  assert.deepEqual(timeTask.target, {
    type: "operation",
    name: "conversation-compactor",
    trigger: "time",
    projectRoot: path.resolve(projectRoot),
    sessionId: "session-suzu",
  });
  assert.equal(tokenTask.kind, "once");
  assert.equal(tokenTask.target.trigger, "token");
  await assert.rejects(
    createScheduleTask({
      dataRoot: root,
      cron: "30 9 * * *",
      exec: "conversation-compactor",
      operationTrigger: "token",
      projectRoot,
      sessionId: "session-suzu",
      source: "system",
    }),
    /触发方式无效/u,
  );
});

test("daily Agent journal operations are software-owned cron tasks", async () => {
  const root = await temporaryDirectory("suzu-schedule-agent-journal-");
  const task = await createScheduleTask({
    dataRoot: root,
    cron: "2 0 * * *",
    exec: "agent-journal",
    description: "Agent 每日写日记",
    source: "system",
  });
  assert.equal(task.kind, "cron");
  assert.deepEqual(task.target, { type: "operation", name: "agent-journal" });
  await assert.rejects(
    createScheduleTask({
      dataRoot: root,
      cron: "2 0 * * *",
      exec: "agent-journal",
      source: "manual",
    }),
    /写日记的自动任务只能由 Suzu 内部创建/u,
  );
});

test("runner keeps a closed task stored and does not execute it", async () => {
  const root = await temporaryDirectory("suzu-schedule-closed-");
  let current = new Date("2026-08-05T10:00:00+08:00");
  const task = await createScheduleTask({
    dataRoot: root,
    delay: "1m",
    prompt: "这条关闭计划不应执行。",
    contactId: "contact-closed",
    now: current,
  });
  await setScheduleTaskEnabled({ dataRoot: root, id: task.id, enabled: false });
  const delivered = [];
  const runner = createScheduleRunner({
    dataRoot: root,
    intervalMs: 1_000,
    now: () => current,
    onConversationTask: async (scheduled) => delivered.push(scheduled.target.prompt),
  });

  await runner.start();
  current = new Date("2026-08-05T10:01:00+08:00");
  await runner.poll();
  assert.deepEqual(delivered, []);
  assert.equal((await listScheduleTasks({ dataRoot: root })).some((item) => item.id === task.id), true);
  runner.stop();
});

test("runner executes future tasks only while Suzu is running and does not catch up after startup", async () => {
  const root = await temporaryDirectory("suzu-schedule-runner-");
  let current = new Date(2026, 7, 5, 10, 0);
  const delivered = [];
  const operations = [];
  const expired = await createScheduleTask({
    dataRoot: root,
    delay: "1m",
    prompt: "已经错过",
    contactId: "contact-expired",
    now: new Date(2026, 7, 5, 9, 0),
  });
  await createScheduleTask({
    dataRoot: root,
    delay: "1m",
    prompt: "未来任务",
    contactId: "contact-future",
    now: current,
  });
  await createScheduleTask({
    dataRoot: root,
    cron: "2 10 * * *",
    exec: "agent-journal",
    now: new Date(2026, 7, 5, 9, 0),
    source: "system",
  });
  const runner = createScheduleRunner({
    dataRoot: root,
    now: () => current,
    intervalMs: 1_000,
    onConversationTask: async (task) => delivered.push(task.target.prompt),
    onOperationTask: async (task) => operations.push(task.target.name),
  });
  await runner.start();
  assert.equal((await listScheduleTasks({ dataRoot: root })).some((task) => task.id === expired.id), false);
  assert.deepEqual(delivered, []);
  assert.deepEqual(operations, []);

  current = new Date(2026, 7, 5, 10, 1);
  await runner.poll();
  assert.deepEqual(delivered, ["未来任务"]);

  current = new Date(2026, 7, 5, 10, 2);
  await runner.poll();
  assert.deepEqual(operations, ["agent-journal"]);
  await runner.poll();
  assert.deepEqual(operations, ["agent-journal"]);
  runner.stop();
});

test("runner keeps a local history for triggered plans, including plans accepted by the conversation queue", async () => {
  const root = await temporaryDirectory("suzu-schedule-history-");
  let current = new Date(2026, 7, 5, 10, 0);
  const conversation = await createScheduleTask({
    dataRoot: root,
    delay: "1m",
    prompt: "早上问候一下。",
    contactId: "contact-history",
    description: "早安提醒",
    now: current,
  });
  const operation = await createScheduleTask({
    dataRoot: root,
    cron: "2 10 * * *",
    exec: "agent-journal",
    description: "Agent 日记",
    now: current,
    source: "system",
  });
  const runner = createScheduleRunner({
    dataRoot: root,
    intervalMs: 1_000,
    now: () => current,
    onConversationTask: async () => ({ accepted: true, queued: true }),
    onOperationTask: async () => undefined,
  });

  await runner.start();
  current = new Date(2026, 7, 5, 10, 1);
  await runner.poll();
  current = new Date(2026, 7, 5, 10, 2);
  await runner.poll();

  const history = await listScheduleHistory({ dataRoot: root });
  assert.equal(history.length, 2);
  assert.equal(history[0].task.id, operation.id);
  assert.equal(history[0].status, "completed");
  assert.equal(history[1].task.id, conversation.id);
  assert.equal(history[1].status, "queued");
  assert.equal(history[1].task.description, "早安提醒");
  assert.equal(history[1].task.target.prompt, "早上问候一下。");
  assert.ok(history.every((entry) => entry.finishedAt));
  runner.stop();
});
