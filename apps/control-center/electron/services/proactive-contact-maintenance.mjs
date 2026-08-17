import { createScheduleTask, listScheduleTasks } from "@suzu-lives/task-scheduler";

export const PROACTIVE_CHAIN_DESCRIPTION = "链式主动关心";
export const PROACTIVE_CHAIN_PLANNING_DESCRIPTION = "安排下次主动关心";
export const PROACTIVE_CHAIN_INITIAL_DELAY = "1m";
export const PROACTIVE_CHAIN_PLANNING_DELAY = "1m";
export const PROACTIVE_CHAIN_RECOVERY_DELAY = "2h";
export const PROACTIVE_CHAIN_TASK_PROMPT = "执行一次主动关心判断。";
export const PROACTIVE_CHAIN_PLANNING_TASK_PROMPT = "这是内部任务：安排下一次主动关心。";
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

export function proactiveCheckTaskPrompt(value) {
  const instructions = clean(value) || "根据时间和前面聊的内容判断要不要主动联系对方。";
  return [
    "这是链式主动关心的判断阶段（A）。",
    instructions,
    "请把判断过程留在思考中。最终只写对方应该看到的话；如不需要联系，最终只输出精确的 NO_REPLY。",
    "本轮不要创建、修改或删除自动任务；软件会在本轮结束后单独安排下一次主动关心。",
  ].join("\n");
}

export function proactivePlanningTaskPrompt() {
  return [
    "这是链式主动关心的内部安排阶段（B）。",
    "不要向用户发送消息，也不要解释本轮安排。",
    "根据当前时间、最近对话和相处节奏，使用系统提供的 schedule add 命令创建且只创建一条下一次“链式主动关心”判断任务。",
    "创建完成后只输出精确的 NO_REPLY。",
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
  const covered = new Set();
  for (const target of targets) {
    const key = proactiveContactScopeKey(target);
    const hasScheduledPlan = existing.some((task) => isActiveProactiveChainWork(task, target));
    let hasQueuedTurn = false;
    if (!hasScheduledPlan) {
      try { hasQueuedTurn = hasPendingScheduledTurn({ contactId: target.contactId }) === true; } catch { /* A transient chat lookup must not prevent plan recovery. */ }
    }
    if (hasScheduledPlan || hasQueuedTurn) {
      covered.add(key);
    }
  }

  const created = [];
  const delay = clean(nextTaskDelay) || PROACTIVE_CHAIN_INITIAL_DELAY;
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
