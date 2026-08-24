import { createScheduleTask, listScheduleTasks, removeScheduleTask } from "@suzu-lives/task-scheduler";

export const PROACTIVE_CONTACT_DESCRIPTION = "主动关心";
export const PROACTIVE_CONTACT_INITIAL_DELAY = "1m";
export const PROACTIVE_CONTACT_RECOVERY_DELAY = "2h";
export const PROACTIVE_CONTACT_TASK_PROMPT = "运行主动关心：判断此刻是否适合联系对方。";
export const PROACTIVE_CONTACT_TURN_SOURCE = "proactive-contact";
export const PROACTIVE_CONTACT_TIMING_TURN_SOURCE = "proactive-contact-timing";
export const PROACTIVE_CONTACT_MIN_DELAY_MINUTES = 15;
export const PROACTIVE_CONTACT_MAX_DELAY_MINUTES = 720;

const RETIRED_PROACTIVE_TASKS = new Map([
  ["链式主动关心", new Set([
    "运行主动关心 A：判断此刻是否适合联系对方。",
    "运行主动关心 A：判断此刻是否适合联系对方。（恢复保障）",
  ])],
  ["安排下次主动关心", new Set([
    "运行主动关心 B：安排下一次 A 判断。",
  ])],
]);
function clean(value) {
  return String(value ?? "").trim();
}

export function isProactiveContactTurnSource(value) {
  const source = clean(value);
  return source === PROACTIVE_CONTACT_TURN_SOURCE
    || source === PROACTIVE_CONTACT_TIMING_TURN_SOURCE;
}

function taskDueAt(task) {
  const dueAt = Date.parse(clean(task?.dueAt));
  return Number.isFinite(dueAt) ? dueAt : Number.POSITIVE_INFINITY;
}

function taskCreatedAt(task) {
  const createdAt = Date.parse(clean(task?.createdAt));
  return Number.isFinite(createdAt) ? createdAt : Number.NEGATIVE_INFINITY;
}

function sortByDueAt(left, right) {
  return taskDueAt(left) - taskDueAt(right)
    || taskCreatedAt(left) - taskCreatedAt(right)
    || clean(left?.id).localeCompare(clean(right?.id));
}

function sortByNewest(left, right) {
  return taskCreatedAt(right) - taskCreatedAt(left)
    || taskDueAt(left) - taskDueAt(right)
    || clean(left?.id).localeCompare(clean(right?.id));
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

function hasProactiveTaskShape(task, scope) {
  return task?.kind === "once"
    && ["agent", "system"].includes(task?.source)
    && task?.target?.type === "conversation"
    && proactiveContactScopeKey(task.target) === proactiveContactScopeKey(scope);
}

/** A pending contact decision created by the host scheduler. */
export function isActiveProactiveContactTask(task, scope) {
  return isProactiveContactTask(task, scope)
    && task?.enabled === true;
}

export function isProactiveContactTask(task, scope) {
  return hasProactiveTaskShape(task, scope)
    && task?.source === "system"
    && clean(task?.description) === PROACTIVE_CONTACT_DESCRIPTION
    && clean(task?.target?.prompt) === PROACTIVE_CONTACT_TASK_PROMPT;
}

export function isRetiredProactiveContactTask(task, scope) {
  if (!hasProactiveTaskShape(task, scope)) return false;
  const description = clean(task?.description);
  const prompt = clean(task?.target?.prompt);
  return RETIRED_PROACTIVE_TASKS.get(description)?.has(prompt) === true;
}

function preferredTask(tasks) {
  const current = tasks.filter((task) => isActiveProactiveContactTask(task, { contactId: task?.target?.contactId }));
  if (current.length) return current.slice().sort(sortByNewest)[0];
  return tasks.slice().sort(sortByDueAt)[0] || null;
}

function delayUntilTask(task, { now, fallback }) {
  const dueAt = taskDueAt(task);
  const current = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(dueAt) || !Number.isFinite(current) || dueAt <= current) return fallback;
  return `${Math.max(1, Math.ceil((dueAt - current) / 60_000))}m`;
}

export function proactiveContactTaskPrompt() {
  return [
    "【主动关心 A】",
    "依据当前时间和最近的互动频率，判断现在是否主动联系对方。",
    "要联系就发消息；否则输出 NO_REPLY。",
  ].join("\n");
}

export function proactiveContactTimingTaskPrompt() {
  return [
    "【主动关心 B】",
    "任务：提供下一次检查间隔。",
    "参考：当前时间、最近互动和相处节奏。",
    `结果格式：{\"delayMinutes\": <${PROACTIVE_CONTACT_MIN_DELAY_MINUTES}–${PROACTIVE_CONTACT_MAX_DELAY_MINUTES} 的整数>}。`,
    "软件会依据这个值创建下一次主动关心任务。",
    '{"delayMinutes":42}',
  ].join("\n");
}

export function proactiveContactNextCheckDelay(value) {
  const text = clean(value);
  if (!text) return "";
  let decision;
  try { decision = JSON.parse(text); } catch { return ""; }
  const delayMinutes = decision?.delayMinutes;
  if (!Number.isSafeInteger(delayMinutes)) return "";
  if (delayMinutes < PROACTIVE_CONTACT_MIN_DELAY_MINUTES || delayMinutes > PROACTIVE_CONTACT_MAX_DELAY_MINUTES) return "";
  return `${delayMinutes}m`;
}

export async function createProactiveContactTask({
  dataRoot,
  contactId,
  delay = PROACTIVE_CONTACT_INITIAL_DELAY,
  now = new Date(),
} = {}) {
  const id = proactiveContactScopeKey({ contactId });
  if (!id) throw new Error("主动关心缺少有效联系人。 ");
  return createScheduleTask({
    dataRoot,
    delay: clean(delay) || PROACTIVE_CONTACT_INITIAL_DELAY,
    prompt: PROACTIVE_CONTACT_TASK_PROMPT,
    contactId: id,
    description: PROACTIVE_CONTACT_DESCRIPTION,
    source: "system",
    now,
  });
}

/**
 * Writes the next check before removing the current product-managed work. A process
 * interruption therefore still leaves a pending check for maintenance to keep.
 */
export async function scheduleNextProactiveContactCheck({
  dataRoot,
  contactId,
  delay = PROACTIVE_CONTACT_RECOVERY_DELAY,
  now = new Date(),
} = {}) {
  const id = proactiveContactScopeKey({ contactId });
  if (!id) throw new Error("主动关心缺少有效联系人。 ");
  const scope = { contactId: id };
  const existing = await listScheduleTasks({ dataRoot });
  const active = existing.filter((task) => isProactiveContactTask(task, scope));
  const next = await createProactiveContactTask({ dataRoot, contactId: id, delay, now });
  await Promise.all(active.map((task) => removeScheduleTask({ dataRoot, id: clean(task?.id) })));
  return next;
}

/** Keeps exactly one pending contact decision for a selected contact. */
export async function ensureProactiveContactTask({
  dataRoot,
  contactId,
  delay = PROACTIVE_CONTACT_INITIAL_DELAY,
  now = new Date(),
} = {}) {
  const scope = { contactId };
  const active = (await listScheduleTasks({ dataRoot })).filter((task) => isActiveProactiveContactTask(task, scope));
  if (active.length === 1) return active[0];
  return scheduleNextProactiveContactCheck({ dataRoot, contactId, delay, now });
}

async function normalizeCurrentProactiveContactTasks({ dataRoot, existing, targets, now, fallbackDelay }) {
  const replacements = [];
  for (const target of targets) {
    const active = existing.filter((task) => isProactiveContactTask(task, target));
    const preferred = preferredTask(active);
    const needsReplacement = active.length > 1
      || (active.length === 1 && !isActiveProactiveContactTask(active[0], target));
    if (!needsReplacement) continue;
    for (const task of active) {
      await removeScheduleTask({ dataRoot, id: clean(task?.id) });
    }
    replacements.push(await createProactiveContactTask({
      dataRoot,
      contactId: target.contactId,
      delay: delayUntilTask(preferred, { now, fallback: fallbackDelay }),
      now,
    }));
  }
  return replacements;
}

/** Ensures every selected contact has one pending host-managed contact check. */
export async function maintainProactiveContactChecks({
  dataRoot,
  scope = null,
  settings = {},
  now = new Date(),
  nextTaskDelay = PROACTIVE_CONTACT_INITIAL_DELAY,
  hasPendingScheduledTurn = () => false,
} = {}) {
  const requestedScopeKey = scope ? proactiveContactScopeKey(scope) : "";
  if (scope && !requestedScopeKey) return [];
  const existing = await listScheduleTasks({ dataRoot });
  const retired = existing.filter((task) => {
    const taskContactId = proactiveContactScopeKey(task?.target);
    return taskContactId && isRetiredProactiveContactTask(task, { contactId: taskContactId });
  });
  await Promise.all(retired.map((task) => removeScheduleTask({ dataRoot, id: clean(task?.id) })));
  const available = retired.length ? await listScheduleTasks({ dataRoot }) : existing;
  const targets = enabledScopes(settings.enabledContactIds)
    .filter((target) => !requestedScopeKey || proactiveContactScopeKey(target) === requestedScopeKey);
  const targetIds = new Set(targets.map((target) => proactiveContactScopeKey(target)));
  const staleWork = available.filter((task) => {
    const taskContactId = proactiveContactScopeKey(task?.target);
    if (!taskContactId || !isProactiveContactTask(task, { contactId: taskContactId })) return false;
    if (requestedScopeKey && taskContactId !== requestedScopeKey) return false;
    return settings?.autoMaintain !== true || !targetIds.has(taskContactId);
  });
  await Promise.all(staleWork.map((task) => removeScheduleTask({ dataRoot, id: clean(task?.id) })));
  if (settings?.autoMaintain !== true || !targets.length) return [];

  const current = (retired.length || staleWork.length) ? await listScheduleTasks({ dataRoot }) : available;
  const delay = clean(nextTaskDelay) || PROACTIVE_CONTACT_INITIAL_DELAY;
  const repaired = await normalizeCurrentProactiveContactTasks({
    dataRoot,
    existing: current,
    targets,
    now,
    fallbackDelay: delay,
  });
  const normalized = repaired.length ? await listScheduleTasks({ dataRoot }) : current;
  const covered = new Set();
  for (const target of targets) {
    const key = proactiveContactScopeKey(target);
    const hasScheduledCheck = normalized.some((task) => isActiveProactiveContactTask(task, target));
    let hasQueuedTurn = false;
    if (!hasScheduledCheck) {
      try { hasQueuedTurn = hasPendingScheduledTurn({ contactId: target.contactId }) === true; } catch { /* A transient chat lookup must not prevent plan recovery. */ }
    }
    if (hasScheduledCheck || hasQueuedTurn) covered.add(key);
  }

  const created = [...repaired];
  for (const target of targets) {
    if (covered.has(proactiveContactScopeKey(target))) continue;
    created.push(await createProactiveContactTask({
      dataRoot,
      delay,
      contactId: target.contactId,
      now,
    }));
  }
  return created;
}
