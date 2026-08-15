import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createScheduleTask, listScheduleTasks, setScheduleTaskEnabled } from "@suzu-lives/task-scheduler";
import {
  isManagedTravelingMerchantTask,
  syncTravelingMerchantSchedule,
  TRAVELING_MERCHANT_CRON,
  TRAVELING_MERCHANT_DESCRIPTION,
} from "../electron/services/traveling-merchant-schedule.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("software creates one merchant monitor while at least one contact is enabled", async () => {
  const dataRoot = await temporaryDirectory("suzu-merchant-schedule-");
  const first = await syncTravelingMerchantSchedule({ dataRoot, hasEnabledContacts: true });
  assert.equal(first.status, "created");
  assert.equal(first.task?.cron, TRAVELING_MERCHANT_CRON);
  assert.equal(first.task?.description, TRAVELING_MERCHANT_DESCRIPTION);
  assert.equal(first.task?.source, "system");
  assert.deepEqual(first.task?.target, { type: "operation", name: "traveling-merchant" });

  const repeated = await syncTravelingMerchantSchedule({ dataRoot, hasEnabledContacts: true });
  assert.equal(repeated.status, "ready");
  assert.equal((await listScheduleTasks({ dataRoot })).filter(isManagedTravelingMerchantTask).length, 1);

  await setScheduleTaskEnabled({ dataRoot, id: first.task.id, enabled: false });
  const restored = await syncTravelingMerchantSchedule({ dataRoot, hasEnabledContacts: true });
  assert.equal(restored.status, "enabled");
  assert.equal(restored.task?.enabled, true);
});

test("software removes only its own merchant monitor after the last recipient is disabled", async () => {
  const dataRoot = await temporaryDirectory("suzu-merchant-schedule-cleanup-");
  await syncTravelingMerchantSchedule({ dataRoot, hasEnabledContacts: true });
  const manual = await createScheduleTask({
    dataRoot,
    cron: "30 9 * * *",
    exec: "traveling-merchant",
    description: "保留的手动计划",
    source: "manual",
  });

  const result = await syncTravelingMerchantSchedule({ dataRoot, hasEnabledContacts: false });
  assert.equal(result.status, "removed");
  const tasks = await listScheduleTasks({ dataRoot });
  assert.equal(tasks.some(isManagedTravelingMerchantTask), false);
  assert.equal(tasks.some((task) => task.id === manual.id), true);
});
