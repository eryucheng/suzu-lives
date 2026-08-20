import {
  createScheduleTask,
  listScheduleTasks,
  removeScheduleTask,
  setScheduleTaskEnabled,
} from "@suzu-lives/task-scheduler";

export const DEFAULT_AGENT_JOURNAL_TIME = "00:02";
export const AGENT_JOURNAL_DESCRIPTION = "Agent 每日写日记";

function clean(value) {
  return String(value ?? "").trim();
}

export function agentJournalTime(value, fallback = DEFAULT_AGENT_JOURNAL_TIME) {
  const source = clean(value);
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(source) ? source : fallback;
}

export function agentJournalCron(value = DEFAULT_AGENT_JOURNAL_TIME) {
  const [hours, minutes] = agentJournalTime(value).split(":").map(Number);
  return `${minutes} ${hours} * * *`;
}

export function isManagedAgentJournalTask(value) {
  const task = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const target = task.target && typeof task.target === "object" && !Array.isArray(task.target) ? task.target : {};
  return task.source === "system"
    && task.kind === "cron"
    && target.type === "operation"
    && target.name === "agent-journal";
}

/**
 * Keep one daily journal trigger that the application owns.  The schedule is
 * intentionally shared by enabled contacts: one cron tick fans out to each
 * selected Agent and never creates a task per contact.
 */
export async function syncAgentJournalSchedule({ dataRoot, hasEnabledContacts = false, time = DEFAULT_AGENT_JOURNAL_TIME } = {}) {
  const managed = (await listScheduleTasks({ dataRoot })).filter(isManagedAgentJournalTask);
  if (hasEnabledContacts !== true) {
    await Promise.all(managed.map((task) => removeScheduleTask({ dataRoot, id: task.id })));
    return { status: managed.length ? "removed" : "idle", task: null };
  }

  const cron = agentJournalCron(time);
  const [primary, ...duplicates] = managed;
  await Promise.all(duplicates.map((task) => removeScheduleTask({ dataRoot, id: task.id })));
  if (primary) {
    if (primary.cron !== cron) {
      await removeScheduleTask({ dataRoot, id: primary.id });
    } else {
      const task = primary.enabled === false
        ? await setScheduleTaskEnabled({ dataRoot, id: primary.id, enabled: true })
        : primary;
      if (task) return { status: primary.enabled === false ? "enabled" : "ready", task };
    }
  }

  const task = await createScheduleTask({
    dataRoot,
    cron,
    exec: "agent-journal",
    description: AGENT_JOURNAL_DESCRIPTION,
    source: "system",
  });
  return { status: primary ? "rescheduled" : "created", task };
}
