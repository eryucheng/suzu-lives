import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listScheduleTasks, setScheduleTaskEnabled } from "@suzu-lives/task-scheduler";
import {
  AGENT_JOURNAL_DESCRIPTION,
  agentJournalCron,
  isManagedAgentJournalTask,
  syncAgentJournalSchedule,
} from "../electron/services/agent-journal-schedule.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("software maintains one shared daily Agent journal trigger for enabled contacts", async () => {
  const dataRoot = await temporaryDirectory("suzu-agent-journal-schedule-");
  const first = await syncAgentJournalSchedule({ dataRoot, hasEnabledContacts: true });
  assert.equal(first.status, "created");
  assert.equal(first.task?.cron, "2 0 * * *");
  assert.equal(first.task?.description, AGENT_JOURNAL_DESCRIPTION);
  assert.deepEqual(first.task?.target, { type: "operation", name: "agent-journal" });

  await setScheduleTaskEnabled({ dataRoot, id: first.task.id, enabled: false });
  const restored = await syncAgentJournalSchedule({ dataRoot, hasEnabledContacts: true, time: "00:02" });
  assert.equal(restored.status, "enabled");
  assert.equal(restored.task?.enabled, true);
  assert.equal((await listScheduleTasks({ dataRoot })).filter(isManagedAgentJournalTask).length, 1);
});

test("changing daily journal time replaces only the software-owned journal trigger", async () => {
  const dataRoot = await temporaryDirectory("suzu-agent-journal-reschedule-");
  const created = await syncAgentJournalSchedule({ dataRoot, hasEnabledContacts: true, time: "00:02" });
  const rescheduled = await syncAgentJournalSchedule({ dataRoot, hasEnabledContacts: true, time: "21:30" });
  assert.equal(rescheduled.status, "rescheduled");
  assert.notEqual(rescheduled.task?.id, created.task?.id);
  assert.equal(rescheduled.task?.cron, agentJournalCron("21:30"));
  assert.equal((await listScheduleTasks({ dataRoot })).filter(isManagedAgentJournalTask).length, 1);

  const removed = await syncAgentJournalSchedule({ dataRoot, hasEnabledContacts: false });
  assert.equal(removed.status, "removed");
  assert.equal((await listScheduleTasks({ dataRoot })).filter(isManagedAgentJournalTask).length, 0);
});
