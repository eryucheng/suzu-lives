import {
  createScheduleTask,
  listScheduleTasks,
  removeScheduleTask,
  setScheduleTaskEnabled,
} from "@suzu-lives/task-scheduler";

export const TRAVELING_MERCHANT_CRON = "2 8,12,16,20 * * *";
export const TRAVELING_MERCHANT_DESCRIPTION = "洛克王国远行商人监控";

export function isManagedTravelingMerchantTask(value) {
  const task = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const target = task.target && typeof task.target === "object" && !Array.isArray(task.target) ? task.target : {};
  return task.source === "system"
    && task.kind === "cron"
    && target.type === "operation"
    && target.name === "traveling-merchant";
}

/**
 * Keep exactly one software-owned merchant monitor while there is a live
 * recipient. Legacy manual or Agent-created tasks are intentionally left
 * untouched: only the task this software owns is safe to manage here.
 */
export async function syncTravelingMerchantSchedule({ dataRoot, hasEnabledContacts = false } = {}) {
  const managed = (await listScheduleTasks({ dataRoot })).filter(isManagedTravelingMerchantTask);
  if (hasEnabledContacts !== true) {
    await Promise.all(managed.map((task) => removeScheduleTask({ dataRoot, id: task.id })));
    return { status: managed.length ? "removed" : "idle", task: null };
  }

  const [primary, ...duplicates] = managed;
  await Promise.all(duplicates.map((task) => removeScheduleTask({ dataRoot, id: task.id })));
  if (primary) {
    const task = primary.enabled === false
      ? await setScheduleTaskEnabled({ dataRoot, id: primary.id, enabled: true })
      : primary;
    if (task) return { status: primary.enabled === false ? "enabled" : "ready", task };
  }

  const task = await createScheduleTask({
    dataRoot,
    cron: TRAVELING_MERCHANT_CRON,
    exec: "traveling-merchant",
    description: TRAVELING_MERCHANT_DESCRIPTION,
    source: "system",
  });
  return { status: "created", task };
}
