import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const TASK_VERSION = 1;
const TASK_ID = /^schedule-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CONTACT_ID = /^contact-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_PROMPT_LENGTH = 20_000;
const MAX_DESCRIPTION_LENGTH = 500;
const OPERATION_NAMES = new Set(["traveling-merchant", "conversation-compactor"]);
const COMPACTOR_TRIGGERS = new Set(["time", "token"]);
const TASK_SOURCES = new Set(["agent", "manual", "system"]);

export class ScheduleError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScheduleError";
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function asDate(value, label = "时间") {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ScheduleError(`${label}无效。`);
  return date;
}

function currentDate(now) {
  return asDate(typeof now === "function" ? now() : now || new Date(), "当前时间");
}

function taskId(value) {
  const id = clean(value);
  if (!TASK_ID.test(id)) throw new ScheduleError("自动任务 ID 无效。 ");
  return id;
}

function requiredText(value, label, limit = MAX_PROMPT_LENGTH) {
  const text = clean(value);
  if (!text) throw new ScheduleError(`${label}不能为空。`);
  if (text.length > limit) throw new ScheduleError(`${label}不能超过 ${limit.toLocaleString("zh-CN")} 个字符。`);
  return text;
}

function absolutePath(value, label) {
  const source = clean(value);
  if (!source || !path.isAbsolute(source)) throw new ScheduleError(`${label}必须是绝对路径。`);
  return path.resolve(source);
}

function sessionId(value) {
  const id = clean(value);
  if (!SESSION_ID.test(id)) throw new ScheduleError("自动任务的 Claude 会话标识无效。 ");
  return id;
}

function contactId(value) {
  const id = clean(value);
  if (!CONTACT_ID.test(id)) throw new ScheduleError("自动任务的联系人标识无效。 ");
  return id;
}

function description(value, fallback) {
  const text = clean(value) || fallback;
  if (text.length > MAX_DESCRIPTION_LENGTH) {
    throw new ScheduleError(`自动任务说明不能超过 ${MAX_DESCRIPTION_LENGTH} 个字符。`);
  }
  return text;
}

function taskEnabled(value) {
  if (value === undefined) return true;
  if (typeof value !== "boolean") throw new ScheduleError("自动任务开关状态无效。 ");
  return value;
}

function taskSource(value) {
  const source = clean(value).toLowerCase() || "agent";
  if (!TASK_SOURCES.has(source)) throw new ScheduleError("自动任务来源无效。 ");
  return source;
}

function conversationTarget(value) {
  if (value?.type !== "conversation") return null;
  if (clean(value.sessionId) || clean(value.projectRoot) || Object.hasOwn(value, "hasTranscript")) {
    throw new ScheduleError("对话自动任务只能指定联系人。 ");
  }
  return {
    type: "conversation",
    contactId: contactId(value.contactId),
    prompt: requiredText(value.prompt, "自动任务提示词"),
  };
}

function scriptTarget(value) {
  if (value?.type !== "script") return null;
  return {
    type: "script",
    scriptPath: absolutePath(value.scriptPath, "自动任务脚本路径"),
  };
}

function operationTarget(value, kind = "") {
  const operation = clean(value?.name).toLowerCase();
  if (value?.type !== "operation" || !OPERATION_NAMES.has(operation)) return null;
  if (operation === "traveling-merchant") {
    if (kind && kind !== "cron") return null;
    return { type: "operation", name: operation };
  }
  const trigger = clean(value?.trigger).toLowerCase();
  if (!COMPACTOR_TRIGGERS.has(trigger)) return null;
  if ((trigger === "time" && kind !== "cron") || (trigger === "token" && kind !== "once")) return null;
  return {
    type: "operation",
    name: operation,
    trigger,
    sessionId: sessionId(value.sessionId),
    projectRoot: absolutePath(value.projectRoot, "自动压缩工作目录"),
  };
}

function normalizedTarget(kind, value) {
  const conversation = conversationTarget(value);
  if (conversation) return conversation;
  const script = scriptTarget(value);
  if (script) return script;
  const operation = operationTarget(value, kind);
  if (operation) return operation;
  throw new ScheduleError(kind === "once" ? "一次性自动任务的执行目标无效。 " : "循环自动任务的执行目标无效。 ");
}

function creationTarget({
  kind,
  prompt,
  scriptPath,
  exec,
  operationTrigger,
  contactId: selectedContactId,
  sessionId: selectedSessionId,
  projectRoot,
  source,
}) {
  const promptSource = clean(prompt);
  const scriptSource = clean(scriptPath);
  const operationSource = clean(exec).toLowerCase();
  const count = [promptSource, scriptSource, operationSource].filter(Boolean).length;
  if (count !== 1) throw new ScheduleError("自动任务必须且只能选择一个执行目标。 ");
  if (promptSource) {
    if (clean(selectedSessionId) || clean(projectRoot)) {
      throw new ScheduleError("对话自动任务只能指定联系人。 ");
    }
    return conversationTarget({
      type: "conversation",
      contactId: selectedContactId,
      prompt: promptSource,
    });
  }
  if (scriptSource) return scriptTarget({ type: "script", scriptPath: scriptSource });
  const operation = operationTarget({
    type: "operation",
    name: operationSource,
    trigger: operationTrigger,
    sessionId: selectedSessionId,
    projectRoot,
  }, kind);
  if (!operation) throw new ScheduleError("--exec 的内置操作与触发方式无效。 ");
  if (operation.name === "conversation-compactor" && source !== "system") {
    throw new ScheduleError("记忆压缩器的自动任务只能由 Suzu 内部创建。 ");
  }
  return operation;
}

export function scheduleTasksDirectory(dataRoot) {
  return path.join(absolutePath(dataRoot, "Suzu 数据目录"), "automation", "schedule", "tasks");
}

export function parseDelay(value) {
  const source = clean(value).toLowerCase();
  const match = /^(\d+)(s|m|h|d)$/u.exec(source);
  if (!match) throw new ScheduleError("--delay 需要正整数并使用 s、m、h 或 d，例如 45m。 ");
  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new ScheduleError("--delay 必须是正整数。 ");
  const multiplier = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds)) throw new ScheduleError("--delay 超出可用范围。 ");
  return { source, milliseconds };
}

function cronNumber(value, minimum, maximum, label) {
  if (!/^\d+$/u.test(value)) throw new ScheduleError(`${label}必须是数字。`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new ScheduleError(`${label}必须在 ${minimum}-${maximum} 范围内。`);
  }
  return number;
}

function cronField(value, minimum, maximum, label) {
  const source = clean(value);
  if (!source) throw new ScheduleError(`${label}不能为空。`);
  const values = new Set();
  for (const part of source.split(",")) {
    if (!part) throw new ScheduleError(`${label}格式无效。`);
    const slash = part.split("/");
    if (slash.length > 2 || !slash[0] || (slash.length === 2 && !slash[1])) {
      throw new ScheduleError(`${label}格式无效。`);
    }
    const step = slash.length === 2 ? cronNumber(slash[1], 1, maximum - minimum + 1, `${label}步长`) : 1;
    const range = slash[0];
    let start;
    let end;
    if (range === "*") {
      start = minimum;
      end = maximum;
    } else if (range.includes("-")) {
      const pieces = range.split("-");
      if (pieces.length !== 2 || !pieces[0] || !pieces[1]) throw new ScheduleError(`${label}范围格式无效。`);
      start = cronNumber(pieces[0], minimum, maximum, label);
      end = cronNumber(pieces[1], minimum, maximum, label);
      if (end < start) throw new ScheduleError(`${label}范围必须从小到大。`);
    } else {
      start = cronNumber(range, minimum, maximum, label);
      end = start;
      if (slash.length === 2) throw new ScheduleError(`${label}的单个数值不能附带步长。`);
    }
    for (let item = start; item <= end; item += step) values.add(item);
  }
  return values;
}

export function parseCronExpression(value) {
  const source = clean(value);
  const fields = source.split(/\s+/u);
  if (fields.length !== 5) throw new ScheduleError("--cron 必须是 5 段 Cron 表达式。 ");
  return {
    source,
    minutes: cronField(fields[0], 0, 59, "Cron 分钟"),
    hours: cronField(fields[1], 0, 23, "Cron 小时"),
    daysOfMonth: cronField(fields[2], 1, 31, "Cron 日"),
    months: cronField(fields[3], 1, 12, "Cron 月"),
    daysOfWeek: cronField(fields[4], 0, 7, "Cron 星期"),
    daysOfMonthWildcard: fields[2] === "*",
    daysOfWeekWildcard: fields[4] === "*",
  };
}

export function cronMatches(expression, value = new Date()) {
  const cron = typeof expression === "string" ? parseCronExpression(expression) : expression;
  const date = asDate(value);
  if (!cron?.minutes?.has(date.getMinutes()) || !cron?.hours?.has(date.getHours()) || !cron?.months?.has(date.getMonth() + 1)) {
    return false;
  }
  const dayOfMonthMatches = cron.daysOfMonth.has(date.getDate());
  const dayOfWeek = date.getDay();
  const dayOfWeekMatches = cron.daysOfWeek.has(dayOfWeek) || (dayOfWeek === 0 && cron.daysOfWeek.has(7));
  if (cron.daysOfMonthWildcard && cron.daysOfWeekWildcard) return true;
  if (cron.daysOfMonthWildcard) return dayOfWeekMatches;
  if (cron.daysOfWeekWildcard) return dayOfMonthMatches;
  return dayOfMonthMatches || dayOfWeekMatches;
}

function minuteKey(value) {
  const date = asDate(value);
  const two = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

function taskFile(dataRoot, id) {
  return path.join(scheduleTasksDirectory(dataRoot), `${taskId(id)}.json`);
}

function validateStoredTask(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!source || source.version !== TASK_VERSION) throw new ScheduleError("自动任务文件格式无效。 ");
  const id = taskId(source.id);
  const kind = clean(source.kind);
  const createdAt = asDate(source.createdAt, "自动任务创建时间").toISOString();
  const taskDescription = description(source.description, kind === "once" ? "一次性自动任务" : "循环自动任务");
  const target = source.target && typeof source.target === "object" && !Array.isArray(source.target) ? source.target : null;
  const enabled = taskEnabled(source.enabled);
  const taskOrigin = taskSource(source.source);
  if (kind === "once") {
    const dueAt = asDate(source.dueAt, "自动任务触发时间").toISOString();
    return {
      version: TASK_VERSION,
      id,
      kind,
      createdAt,
      dueAt,
      enabled,
      source: taskOrigin,
      description: taskDescription,
      target: normalizedTarget(kind, target),
    };
  }
  if (kind === "cron") {
    const cron = parseCronExpression(source.cron).source;
    return {
      version: TASK_VERSION,
      id,
      kind,
      createdAt,
      cron,
      enabled,
      source: taskOrigin,
      description: taskDescription,
      target: normalizedTarget(kind, target),
    };
  }
  throw new ScheduleError("自动任务类型无效。 ");
}

async function writeTask(dataRoot, task) {
  const directory = scheduleTasksDirectory(dataRoot);
  await fs.mkdir(directory, { recursive: true });
  const target = taskFile(dataRoot, task.id);
  const temporary = path.join(directory, `.${task.id}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(task, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readTaskFile(filePath) {
  try {
    const source = await fs.readFile(filePath, "utf8");
    return validateStoredTask(JSON.parse(source));
  } catch {
    return null;
  }
}

export function scheduleTaskSummary(value) {
  const task = validateStoredTask(value);
  return {
    id: task.id,
    kind: task.kind,
    enabled: task.enabled,
    source: task.source,
    description: task.description,
    createdAt: task.createdAt,
    ...(task.kind === "once" ? { dueAt: task.dueAt } : { cron: task.cron }),
    target: task.target.type === "conversation"
      ? {
        type: task.target.type,
        contactId: task.target.contactId,
      }
      : { ...task.target },
  };
}

export async function createScheduleTask({
  dataRoot,
  delay = "",
  cron = "",
  prompt = "",
  exec = "",
  operationTrigger = "",
  scriptPath = "",
  contactId: selectedContactId = "",
  sessionId: selectedSessionId = "",
  projectRoot = "",
  description: taskDescription = "",
  source = "",
  now = new Date(),
} = {}) {
  const delaySource = clean(delay);
  const cronSource = clean(cron);
  if (Boolean(delaySource) === Boolean(cronSource)) {
    throw new ScheduleError("自动任务必须且只能指定 --delay 或 --cron 其中一个。 ");
  }
  const createdAt = currentDate(now);
  const taskOrigin = taskSource(source);
  const id = `schedule-${randomUUID()}`;
  let task;
  if (delaySource) {
    const parsedDelay = parseDelay(delaySource);
    task = {
      version: TASK_VERSION,
      id,
      kind: "once",
      createdAt: createdAt.toISOString(),
      dueAt: new Date(createdAt.getTime() + parsedDelay.milliseconds).toISOString(),
      enabled: true,
      source: taskOrigin,
      description: description(taskDescription, "一次性自动任务"),
      target: creationTarget({
        kind: "once",
        prompt,
        scriptPath,
        exec,
        operationTrigger,
        contactId: selectedContactId,
        sessionId: selectedSessionId,
        projectRoot,
        source: taskOrigin,
      }),
    };
  } else {
    task = {
      version: TASK_VERSION,
      id,
      kind: "cron",
      createdAt: createdAt.toISOString(),
      cron: parseCronExpression(cronSource).source,
      enabled: true,
      source: taskOrigin,
      description: description(taskDescription, "循环自动任务"),
      target: creationTarget({
        kind: "cron",
        prompt,
        scriptPath,
        exec,
        operationTrigger,
        contactId: selectedContactId,
        sessionId: selectedSessionId,
        projectRoot,
        source: taskOrigin,
      }),
    };
  }
  await writeTask(dataRoot, task);
  return task;
}

export async function listScheduleTasks({ dataRoot } = {}) {
  const directory = scheduleTasksDirectory(dataRoot);
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const tasks = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readTaskFile(path.join(directory, entry.name))));
  return tasks
    .filter(Boolean)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export async function removeScheduleTask({ dataRoot, id } = {}) {
  const filePath = taskFile(dataRoot, id);
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function setScheduleTaskEnabled({ dataRoot, id, enabled } = {}) {
  if (typeof enabled !== "boolean") throw new ScheduleError("自动任务开关状态无效。 ");
  const filePath = taskFile(dataRoot, id);
  let source;
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const task = validateStoredTask(JSON.parse(source));
  const next = { ...task, enabled };
  await writeTask(dataRoot, next);
  return next;
}

function parseCliOptions(values) {
  const options = {};
  const positional = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = String(values[index] || "");
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = String(values[index + 1] || "");
    if (!key || !next || next.startsWith("--")) throw new ScheduleError(`选项 ${value} 缺少值。`);
    if (Object.hasOwn(options, key)) throw new ScheduleError(`选项 ${value} 只能指定一次。`);
    options[key] = next;
    index += 1;
  }
  return { options, positional };
}

function assertOnlyOptions(options, allowed) {
  const unknown = Object.keys(options).find((key) => !allowed.has(key));
  if (unknown) throw new ScheduleError(`schedule 不支持选项 --${unknown}。`);
}

function resolvedDataRoot(options, defaultDataRoot) {
  return absolutePath(options["data-root"] || defaultDataRoot, "Suzu 数据目录");
}

export async function runScheduleCli(values = [], { defaultDataRoot = "", now = new Date() } = {}) {
  const action = clean(values[0]).toLowerCase();
  const { options, positional } = parseCliOptions(values.slice(1));
  if (action === "add") {
    assertOnlyOptions(options, new Set(["data-root", "delay", "cron", "prompt", "exec", "contact-id", "desc"]));
    if (positional.length) throw new ScheduleError("schedule add 不接受位置参数。 ");
    const task = await createScheduleTask({
      dataRoot: resolvedDataRoot(options, defaultDataRoot),
      delay: options.delay,
      cron: options.cron,
      prompt: options.prompt,
      exec: options.exec,
      contactId: options["contact-id"],
      description: options.desc,
      now,
    });
    return { status: "ok", action, task: scheduleTaskSummary(task) };
  }
  if (action === "list") {
    assertOnlyOptions(options, new Set(["data-root"]));
    if (positional.length) throw new ScheduleError("schedule list 不接受位置参数。 ");
    const tasks = await listScheduleTasks({ dataRoot: resolvedDataRoot(options, defaultDataRoot) });
    return { status: "ok", action, tasks: tasks.map((task) => scheduleTaskSummary(task)) };
  }
  if (action === "remove") {
    assertOnlyOptions(options, new Set(["data-root"]));
    if (positional.length !== 1) throw new ScheduleError("schedule remove 需要一个自动任务 ID。 ");
    const removed = await removeScheduleTask({ dataRoot: resolvedDataRoot(options, defaultDataRoot), id: positional[0] });
    return { status: "ok", action, id: taskId(positional[0]), removed };
  }
  throw new ScheduleError("schedule 只支持 add、list 或 remove。 ");
}

export function createScheduleRunner({
  dataRoot,
  onConversationTask,
  onOperationTask,
  onError = () => {},
  now = () => new Date(),
  intervalMs = 15_000,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const root = absolutePath(dataRoot, "Suzu 数据目录");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) throw new ScheduleError("自动任务轮询间隔无效。 ");
  let disposed = false;
  let timer = null;
  let polling = null;
  let startedAt = null;
  let startedMinute = "";
  const running = new Set();
  const cronRuns = new Map();

  const reportError = (error, task) => {
    try { onError(error, scheduleTaskSummary(task)); } catch { /* Reporting must not stop other tasks. */ }
  };

  const runTask = async (task) => {
    if (running.has(task.id)) return;
    running.add(task.id);
    try {
      if (task.target.type === "conversation") {
        if (typeof onConversationTask !== "function") throw new ScheduleError("当前 Suzu 未接入会话自动任务执行器。 ");
        await onConversationTask(task);
      } else {
        if (typeof onOperationTask !== "function") throw new ScheduleError("当前 Suzu 未接入自动任务执行器。 ");
        await onOperationTask(task);
      }
    } catch (error) {
      reportError(error, task);
    } finally {
      running.delete(task.id);
    }
  };

  const pollNow = async () => {
    if (disposed || !startedAt) return;
    const current = currentDate(now);
    const currentMinute = minuteKey(current);
    const tasks = await listScheduleTasks({ dataRoot: root });
    const work = [];
    for (const task of tasks) {
      if (!task.enabled) continue;
      if (task.kind === "once") {
        const dueAt = asDate(task.dueAt, "自动任务触发时间");
        if (dueAt.getTime() <= startedAt.getTime()) {
          work.push(removeScheduleTask({ dataRoot: root, id: task.id }).catch((error) => reportError(error, task)));
          continue;
        }
        if (dueAt.getTime() <= current.getTime() && !running.has(task.id)) {
          work.push((async () => {
            const removed = await removeScheduleTask({ dataRoot: root, id: task.id });
            if (removed) await runTask(task);
          })().catch((error) => reportError(error, task)));
        }
        continue;
      }
      const createdMinute = minuteKey(task.createdAt);
      if (currentMinute <= startedMinute || currentMinute <= createdMinute || cronRuns.get(task.id) === currentMinute) continue;
      if (!cronMatches(task.cron, current)) continue;
      cronRuns.set(task.id, currentMinute);
      work.push(runTask(task));
    }
    await Promise.all(work);
  };

  const poll = async () => {
    if (polling) return polling;
    polling = pollNow().finally(() => { polling = null; });
    return polling;
  };

  const start = async () => {
    if (disposed || timer) return;
    startedAt = currentDate(now);
    startedMinute = minuteKey(startedAt);
    await fs.mkdir(scheduleTasksDirectory(root), { recursive: true });
    await poll();
    timer = setIntervalImpl(() => { void poll(); }, intervalMs);
    timer?.unref?.();
  };

  const stop = () => {
    disposed = true;
    if (timer) clearIntervalImpl(timer);
    timer = null;
    running.clear();
  };

  return { poll, start, stop };
}
