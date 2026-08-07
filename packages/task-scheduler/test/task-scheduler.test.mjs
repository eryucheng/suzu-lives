import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createScheduleRunner,
  createScheduleTask,
  cronMatches,
  listScheduleTasks,
  parseCronExpression,
  removeScheduleTask,
  runScheduleCli,
  scheduleTasksDirectory,
} from "../src/index.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("one-shot schedule tasks persist below the Suzu data root and use the selected conversation scope", async () => {
  const root = await temporaryDirectory("suzu-schedule-once-");
  const projectRoot = path.join(root, "project");
  const now = new Date("2026-08-05T10:00:00+08:00");
  const task = await createScheduleTask({
    dataRoot: root,
    delay: "45m",
    prompt: "45 分钟后自然回访。",
    sessionId: "session-1",
    projectRoot,
    description: "临时回访",
    now,
  });

  assert.equal(task.kind, "once");
  assert.equal(task.dueAt, "2026-08-05T02:45:00.000Z");
  assert.equal(task.target.projectRoot, path.resolve(projectRoot));
  assert.equal((await listScheduleTasks({ dataRoot: root })).length, 1);
  assert.equal(path.dirname(path.join(scheduleTasksDirectory(root), `${task.id}.json`)), scheduleTasksDirectory(root));
  assert.equal(await removeScheduleTask({ dataRoot: root, id: task.id }), true);
  assert.deepEqual(await listScheduleTasks({ dataRoot: root }), []);
});

test("cron accepts the merchant schedule and matches in local time", () => {
  const cron = parseCronExpression("2 8,12,16,20 * * *");
  assert.equal(cronMatches(cron, new Date("2026-08-05T08:02:00+08:00")), true);
  assert.equal(cronMatches(cron, new Date("2026-08-05T08:03:00+08:00")), false);
  assert.equal(cronMatches("*/15 9-17 * * 1-5", new Date("2026-08-05T09:15:00+08:00")), true);
});

test("schedule CLI keeps delay and cron under one command with parameters", async () => {
  const root = await temporaryDirectory("suzu-schedule-cli-");
  const projectRoot = path.join(root, "project");
  const now = new Date("2026-08-05T10:00:00+08:00");
  const created = await runScheduleCli([
    "add", "--data-root", root, "--delay", "5m", "--session-id", "session-2", "--project-root", projectRoot,
    "--prompt", "稍后回访", "--desc", "临时回访",
  ], { now });
  assert.equal(created.status, "ok");
  assert.equal(created.task.kind, "once");
  const cron = await runScheduleCli([
    "add", "--data-root", root, "--cron", "2 8,12,16,20 * * *", "--exec", "traveling-merchant", "--desc", "洛克王国远行商人监控",
  ], { now });
  assert.equal(cron.task.kind, "cron");
  const listed = await runScheduleCli(["list", "--data-root", root]);
  assert.equal(listed.tasks.length, 2);
  const removed = await runScheduleCli(["remove", created.task.id, "--data-root", root]);
  assert.equal(removed.removed, true);
});

test("runner executes future tasks only while Suzu is running and does not catch up after startup", async () => {
  const root = await temporaryDirectory("suzu-schedule-runner-");
  const projectRoot = path.join(root, "project");
  let current = new Date("2026-08-05T10:00:00+08:00");
  const delivered = [];
  const operations = [];
  const expired = await createScheduleTask({
    dataRoot: root,
    delay: "1m",
    prompt: "已经错过",
    sessionId: "session-expired",
    projectRoot,
    now: new Date("2026-08-05T09:00:00+08:00"),
  });
  await createScheduleTask({
    dataRoot: root,
    delay: "1m",
    prompt: "未来任务",
    sessionId: "session-future",
    projectRoot,
    now: current,
  });
  await createScheduleTask({
    dataRoot: root,
    cron: "2 10 * * *",
    exec: "traveling-merchant",
    now: new Date("2026-08-05T09:00:00+08:00"),
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

  current = new Date("2026-08-05T10:01:00+08:00");
  await runner.poll();
  assert.deepEqual(delivered, ["未来任务"]);

  current = new Date("2026-08-05T10:02:00+08:00");
  await runner.poll();
  assert.deepEqual(operations, ["traveling-merchant"]);
  await runner.poll();
  assert.deepEqual(operations, ["traveling-merchant"]);
  runner.stop();
});
