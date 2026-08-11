import { createScheduleTask, listScheduleTasks } from "@suzu-lives/task-scheduler";

export const PROACTIVE_CHAIN_DESCRIPTION = "链式主动关心";

function clean(value) {
  return String(value ?? "").trim();
}

export function proactiveContactScopeKey({ contactId } = {}) {
  const id = clean(contactId);
  return /^contact-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id) ? id : "";
}

function enabledScopes(value) {
  const result = [];
  const seen = new Set();
  for (const entry of Array.isArray(value) ? value : []) {
    const key = proactiveContactScopeKey({ contactId: entry });
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({ contactId: key });
  }
  return result;
}

export function isActiveProactiveChainTask(task, scope) {
  return task?.kind === "once"
    && task?.enabled === true
    && task?.source === "agent"
    && clean(task?.description) === PROACTIVE_CHAIN_DESCRIPTION
    && task?.target?.type === "conversation"
    && proactiveContactScopeKey(task.target) === proactiveContactScopeKey(scope);
}

/** Ensures the selected opted-in contact(s) have one pending Agent-owned chain task. */
export async function maintainProactiveContactChains({ dataRoot, scope = null, settings = {}, now = new Date() } = {}) {
  if (settings?.autoMaintain !== true) return [];
  const requestedScopeKey = scope ? proactiveContactScopeKey(scope) : "";
  if (scope && !requestedScopeKey) return [];
  const targets = enabledScopes(settings.enabledContactIds)
    .filter((target) => !requestedScopeKey || proactiveContactScopeKey(target) === requestedScopeKey);
  if (!targets.length) return [];

  const existing = await listScheduleTasks({ dataRoot });
  const covered = new Set();
  for (const target of targets) {
    const key = proactiveContactScopeKey(target);
    if (existing.some((task) => isActiveProactiveChainTask(task, target))) {
      covered.add(key);
    }
  }

  const created = [];
  for (const target of targets) {
    if (covered.has(proactiveContactScopeKey(target))) continue;
    created.push(await createScheduleTask({
      dataRoot,
      delay: "1m",
      prompt: clean(settings.chainPrompt),
      contactId: target.contactId,
      description: PROACTIVE_CHAIN_DESCRIPTION,
      source: "agent",
      now,
    }));
  }
  return created;
}
