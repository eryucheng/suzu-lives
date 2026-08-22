import { createScheduleTask, listScheduleTasks, removeScheduleTask } from "@suzu-lives/task-scheduler";

export const PROACTIVE_CHAIN_DESCRIPTION = "链式主动关心";
export const PROACTIVE_CHAIN_PLANNING_DESCRIPTION = "安排下次主动关心";
export const PROACTIVE_CHAIN_INITIAL_DELAY = "1m";
export const PROACTIVE_CHAIN_PLANNING_DELAY = "1m";
export const PROACTIVE_CHAIN_RECOVERY_DELAY = "2h";
export const PROACTIVE_CHAIN_TASK_PROMPT = "运行主动关心 A：判断此刻是否适合联系对方。";
export const PROACTIVE_CHAIN_PLANNING_TASK_PROMPT = "运行主动关心 B：安排下一次 A 判断。";
export const PROACTIVE_CHAIN_TURN_SOURCE = "proactive-chain";
export const PROACTIVE_CHAIN_PLANNING_TURN_SOURCE = "proactive-chain-planning";

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
    && ["agent", "system"].includes(task?.source)
    && clean(task?.description) === PROACTIVE_CHAIN_DESCRIPTION
    && task?.target?.type === "conversation"
    && proactiveContactScopeKey(task.target) === proactiveContactScopeKey(scope);
}

export function isActiveProactiveChainPlanningTask(task, scope) {
  return task?.kind === "once"
    && task?.enabled === true
    && task?.source === "system"
    && clean(task?.description) === PROACTIVE_CHAIN_PLANNING_DESCRIPTION
    && task?.target?.type === "conversation"
    && proactiveContactScopeKey(task.target) === proactiveContactScopeKey(scope);
}

export function isActiveProactiveChainWork(task, scope) {
  return isActiveProactiveChainTask(task, scope)
    || isActiveProactiveChainPlanningTask(task, scope);
}

function isCurrentProactiveChainWork(task, scope) {
  if (isActiveProactiveChainTask(task, scope)) {
    return clean(task?.target?.prompt) === PROACTIVE_CHAIN_TASK_PROMPT;
  }
  if (isActiveProactiveChainPlanningTask(task, scope)) {
    return clean(task?.target?.prompt) === PROACTIVE_CHAIN_PLANNING_TASK_PROMPT;
  }
  return false;
}

function delayUntilTask(task, { now, fallback }) {
  const dueAt = Date.parse(clean(task?.dueAt));
  const current = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(dueAt) || !Number.isFinite(current) || dueAt <= current) return fallback;
  return `${Math.max(1, Math.ceil((dueAt - current) / 60_000))}m`;
}

async function normalizeProactiveChainTasks({ dataRoot, existing, targets, now, fallbackDelay }) {
  const replacements = [];
  for (const target of targets) {
    const active = existing.filter((task) => isActiveProactiveChainWork(task, target));
    const needsReplacement = active.length > 1
      || (active.length === 1 && !isCurrentProactiveChainWork(active[0], target));
    if (!needsReplacement) continue;

    const firstDue = active
      .slice()
      .sort((left, right) => Date.parse(clean(left?.dueAt)) - Date.parse(clean(right?.dueAt)))[0];
    for (const task of active) {
      await removeScheduleTask({ dataRoot, id: clean(task?.id) });
    }
    replacements.push(await createProactiveChainTask({
      dataRoot,
      contactId: target.contactId,
      delay: delayUntilTask(firstDue, { now, fallback: fallbackDelay }),
      now,
    }));
  }
  return replacements;
}

export function proactiveCheckTaskPrompt(value) {
  const instructions = clean(value) || "在自然合适的时候关心对方，保持真诚、克制和贴合关系的语气。";
  return [
    "【主动关心 A｜联系判断】",
    "这是软件安排的一次联系判断。结合当前时间、最近互动和联系人设定，判断现在是否值得由你主动联系对方。",
    "本次相处原则：",
    instructions,
    "本轮只交付判断结果：适合联系时，写一条自然、完整、可直接送达给对方的消息；暂不适合时，只输出精确的 NO_REPLY。",
    "A 只负责判断和回复，不调用 schedule add。下一次判断由 B 在本轮结束后安排。",
  ].join("\n");
}

export function proactivePlanningTaskPrompt() {
  return [
    "【主动关心 B｜下次判断安排】",
    "这是在 A 完成后运行的内部安排。结合当前时间、最近互动和相处节奏，为当前联系人安排下一次 A 判断。",
    "使用系统提供的 schedule add 命令创建一条一次性任务，并保留系统提供的当前联系人范围参数。参数为：",
    `--delay <Xm 或 Xh> --prompt \"${PROACTIVE_CHAIN_TASK_PROMPT}\" --desc \"${PROACTIVE_CHAIN_DESCRIPTION}\"`,
    "选择从此刻开始的合适时长。成功创建这一条任务后，结束本轮。",
  ].join("\n");
}

export async function createProactiveChainTask({
  dataRoot,
  contactId,
  delay = PROACTIVE_CHAIN_INITIAL_DELAY,
  now = new Date(),
  source = "system",
} = {}) {
  return createScheduleTask({
    dataRoot,
    delay: clean(delay) || PROACTIVE_CHAIN_INITIAL_DELAY,
    prompt: PROACTIVE_CHAIN_TASK_PROMPT,
    contactId: proactiveContactScopeKey({ contactId }),
    description: PROACTIVE_CHAIN_DESCRIPTION,
    source,
    now,
  });
}

export async function createProactiveChainPlanningTask({
  dataRoot,
  contactId,
  delay = PROACTIVE_CHAIN_PLANNING_DELAY,
  now = new Date(),
} = {}) {
  return createScheduleTask({
    dataRoot,
    delay: clean(delay) || PROACTIVE_CHAIN_PLANNING_DELAY,
    prompt: PROACTIVE_CHAIN_PLANNING_TASK_PROMPT,
    contactId: proactiveContactScopeKey({ contactId }),
    description: PROACTIVE_CHAIN_PLANNING_DESCRIPTION,
    source: "system",
    now,
  });
}

/** Ensures the selected opted-in contact(s) have one pending Agent-owned chain task. */
export async function maintainProactiveContactChains({
  dataRoot,
  scope = null,
  settings = {},
  now = new Date(),
  nextTaskDelay = PROACTIVE_CHAIN_INITIAL_DELAY,
  hasPendingScheduledTurn = () => false,
} = {}) {
  if (settings?.autoMaintain !== true) return [];
  const requestedScopeKey = scope ? proactiveContactScopeKey(scope) : "";
  if (scope && !requestedScopeKey) return [];
  const targets = enabledScopes(settings.enabledContactIds)
    .filter((target) => !requestedScopeKey || proactiveContactScopeKey(target) === requestedScopeKey);
  if (!targets.length) return [];

  const existing = await listScheduleTasks({ dataRoot });
  const delay = clean(nextTaskDelay) || PROACTIVE_CHAIN_INITIAL_DELAY;
  const repaired = await normalizeProactiveChainTasks({
    dataRoot,
    existing,
    targets,
    now,
    fallbackDelay: delay,
  });
  const normalized = repaired.length ? await listScheduleTasks({ dataRoot }) : existing;
  const covered = new Set();
  for (const target of targets) {
    const key = proactiveContactScopeKey(target);
    const hasScheduledPlan = normalized.some((task) => isActiveProactiveChainWork(task, target));
    let hasQueuedTurn = false;
    if (!hasScheduledPlan) {
      try { hasQueuedTurn = hasPendingScheduledTurn({ contactId: target.contactId }) === true; } catch { /* A transient chat lookup must not prevent plan recovery. */ }
    }
    if (hasScheduledPlan || hasQueuedTurn) {
      covered.add(key);
    }
  }

  const created = [...repaired];
  for (const target of targets) {
    if (covered.has(proactiveContactScopeKey(target))) continue;
    created.push(await createProactiveChainTask({
      dataRoot,
      delay,
      contactId: target.contactId,
      now,
    }));
  }
  return created;
}
