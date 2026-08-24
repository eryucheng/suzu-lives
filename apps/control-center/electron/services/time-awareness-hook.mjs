import fs from "node:fs/promises";
import path from "node:path";

import {
  resolveAgentConversationDataRoot,
  stableAgentId,
} from "@suzu-lives/agent-registry";

export const DEFAULT_TIME_AWARENESS_INTERVAL_MINUTES = 10;
export const MIN_TIME_AWARENESS_INTERVAL_MINUTES = 1;
export const MAX_TIME_AWARENESS_INTERVAL_MINUTES = 24 * 60;
/**
 * The only mounting decision for this capability. Future context providers
 * declare the same shape, so changing their lifecycle does not require
 * touching the Agent Core bridge or the renderer.
 */
export const TIME_AWARENESS_HOOK_MOUNT = Object.freeze({
  id: "time-awareness",
  lifecycleEvent: "DynamicContextCollect",
  order: -100,
  policy: "observe",
  timeoutMs: 3_000,
});

const CONTACT_ID = /^contact-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const STATE_FILE_NAME = "time-awareness.json";
const DAY_NOTICE_INTERVAL_MILLISECONDS = 6 * 60 * 60 * 1_000;
const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const TIME_PART_FORMATTERS = new Map();
const VALID_TIME_ZONES = new Set(["UTC"]);
const INVALID_TIME_ZONES = new Set();
const PUBLIC_DATES = new Map([
  ["01-01", "元旦"],
  ["05-01", "劳动节"],
  ["10-01", "国庆节"],
]);

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function supportedTimeZone(value) {
  const zone = clean(value);
  if (!zone) return "";
  if (VALID_TIME_ZONES.has(zone)) return zone;
  if (INVALID_TIME_ZONES.has(zone)) return "";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone }).format(0);
    VALID_TIME_ZONES.add(zone);
    return zone;
  } catch {
    INVALID_TIME_ZONES.add(zone);
    return "";
  }
}

function detectSystemTimeZone() {
  try {
    return supportedTimeZone(new Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return "";
  }
}

function configuredTimeZone(value) {
  return supportedTimeZone(plainObject(value).timeZone);
}

function timePartFormatter(timeZone) {
  const zone = supportedTimeZone(timeZone) || "UTC";
  let formatter = TIME_PART_FORMATTERS.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      calendar: "gregory",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      numberingSystem: "latn",
      timeZone: zone,
      year: "numeric",
    });
    TIME_PART_FORMATTERS.set(zone, formatter);
  }
  return formatter;
}

function localTimeParts(value, timeZone) {
  const current = asDate(value);
  if (!current) return null;
  try {
    const parts = Object.fromEntries(timePartFormatter(timeZone)
      .formatToParts(current)
      .filter((part) => ["year", "month", "day", "hour", "minute"].includes(part.type))
      .map((part) => [part.type, part.value]));
    const year = Number(parts.year);
    const month = Number(parts.month);
    const day = Number(parts.day);
    const hour = Number(parts.hour);
    const minute = Number(parts.minute);
    if (![year, month, day, hour, minute].every(Number.isSafeInteger)) return null;
    return Object.freeze({
      year,
      month,
      day,
      hour,
      minute,
      weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    });
  } catch {
    return null;
  }
}

function localDateKey(value) {
  return `${value.year}-${pad(value.month)}-${pad(value.day)}`;
}

function absoluteDirectory(value) {
  const source = clean(value);
  return source && path.isAbsolute(source) ? path.resolve(source) : "";
}

function validContactId(value) {
  const id = clean(value);
  return CONTACT_ID.test(id) ? id : "";
}

function validSessionId(value) {
  const id = clean(value);
  return SESSION_ID.test(id) ? id : "";
}

function asDate(value) {
  const current = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(current.getTime()) ? current : null;
}

function intervalMinutes(value) {
  const candidate = Number(value);
  if (!Number.isSafeInteger(candidate)
    || candidate < MIN_TIME_AWARENESS_INTERVAL_MINUTES
    || candidate > MAX_TIME_AWARENESS_INTERVAL_MINUTES) {
    return DEFAULT_TIME_AWARENESS_INTERVAL_MINUTES;
  }
  return candidate;
}

function timeConfigPath(dataRoot) {
  return path.join(dataRoot, "capabilities", "time-awareness", "config.json");
}

function calendarPath(dataRoot) {
  return path.join(dataRoot, "calendar", "calendar.local.json");
}

function statePath({ dataRoot, projectRoot, sessionId }) {
  const agentId = stableAgentId(projectRoot);
  if (!agentId) return "";
  return path.join(resolveAgentConversationDataRoot({
    dataRoot,
    agentId,
    projectRoot,
    sessionId,
  }), STATE_FILE_NAME);
}

async function readJson(fsOps, filePath, fallback = {}) {
  try {
    const stat = await fsOps.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return fallback;
    const text = await fsOps.readFile(filePath, "utf8");
    const parsed = JSON.parse(String(text).replace(/^\uFEFF/u, ""));
    return plainObject(parsed);
  } catch {
    return fallback;
  }
}

async function writeJsonAtomically(fsOps, filePath, value) {
  const directory = path.dirname(filePath);
  await fsOps.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await fsOps.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
    await fsOps.rename(temporary, filePath);
  } catch (error) {
    try { await fsOps.unlink(temporary); } catch { /* The temporary file may already be gone. */ }
    throw error;
  }
}

/**
 * The application time zone is selected once when Suzu Lives first starts and
 * then remains part of product configuration. Dynamic context reads this
 * persisted value instead of repeatedly asking the operating system which
 * time zone it currently reports.
 */
export async function ensureTimeAwarenessConfig({
  dataRoot,
  detectTimeZone = detectSystemTimeZone,
  fsOps = fs,
} = {}) {
  const root = absoluteDirectory(dataRoot);
  if (!root) return Object.freeze({ timeZone: "UTC" });
  const filePath = timeConfigPath(root);
  const existing = await readJson(fsOps, filePath, {});
  const saved = configuredTimeZone(existing);
  if (saved) return Object.freeze({ ...existing, timeZone: saved });

  const detected = typeof detectTimeZone === "function" ? detectTimeZone() : detectTimeZone;
  const timeZone = supportedTimeZone(detected) || "UTC";
  const next = { ...existing, timeZone };
  try {
    await writeJsonAtomically(fsOps, filePath, next);
  } catch {
    // The first request still receives the in-memory selection. A later start
    // can persist it if the data directory was temporarily unavailable.
  }
  return Object.freeze(next);
}

export async function configuredTimeAwarenessTimeZone(options = {}) {
  const config = await ensureTimeAwarenessConfig(options);
  return configuredTimeZone(config) || "UTC";
}

function injectedWithinInterval(value, now, milliseconds) {
  const last = asDate(value?.lastInjectedAt);
  if (!last) return false;
  const elapsed = now.getTime() - last.getTime();
  // Preserve the old wording and behavior: inject again only after the
  // configured interval has elapsed, not exactly at its boundary.
  return elapsed >= 0 && elapsed <= milliseconds;
}

function dayNoticeIsDue(value, now, dateKey) {
  if (clean(value?.lastDayNoticeDate) !== dateKey) return true;
  const last = asDate(value?.lastDayNoticeAt);
  if (!last) return true;
  const elapsed = now.getTime() - last.getTime();
  return elapsed < 0 || elapsed >= DAY_NOTICE_INTERVAL_MILLISECONDS;
}

function openingTaskContext(payload) {
  return Boolean(clean(plainObject(payload?.taskContext).text));
}

function persistedState(value, { current, dateKey, includeDayNotice } = {}) {
  const previousNoticeAt = asDate(value?.lastDayNoticeAt);
  const previousNoticeDate = clean(value?.lastDayNoticeDate);
  const next = {
    version: 2,
    lastInjectedAt: current.toISOString(),
  };
  if (previousNoticeAt && previousNoticeDate) {
    next.lastDayNoticeAt = previousNoticeAt.toISOString();
    next.lastDayNoticeDate = previousNoticeDate;
  }
  if (includeDayNotice) {
    next.lastDayNoticeAt = current.toISOString();
    next.lastDayNoticeDate = dateKey;
  }
  return next;
}

async function currentCalendarEvents(fsOps, filePath, dateKey, agentId) {
  if (!agentId) return [];
  const calendar = await readJson(fsOps, filePath, {});
  if (!Array.isArray(calendar.events)) return [];
  const date = clean(dateKey);
  const recurringDate = date.slice(5);
  return calendar.events
    .filter((event) => plainObject(event).enabled !== false)
    .filter((event) => clean(event.agentId) === agentId)
    .filter((event) => clean(event.date) === date || clean(event.date) === recurringDate)
    .map((event) => clean(event.name).slice(0, 120))
    .filter(Boolean);
}

async function timeAwarenessDetails({
  fsOps = fs,
  dataRoot,
  now = new Date(),
  projectRoot,
  timeZone = "UTC",
} = {}) {
  const root = absoluteDirectory(dataRoot);
  const workspace = absoluteDirectory(projectRoot);
  const current = asDate(now);
  if (!root || !workspace || !current) return null;
  const agentId = stableAgentId(workspace);
  const localTime = localTimeParts(current, timeZone);
  if (!localTime) return null;
  const dateKey = localDateKey(localTime);
  const publicDateKey = dateKey.slice(5);
  const dayNoticeNames = [...new Set([
    PUBLIC_DATES.get(publicDateKey),
    ...(await currentCalendarEvents(fsOps, calendarPath(root), dateKey, agentId)),
  ].filter(Boolean))];
  return {
    current,
    dateKey,
    dayNoticeNames,
    localTime,
  };
}

function renderTimeAwarenessText({ dayNoticeNames = [], localTime } = {}) {
  if (!localTime) return "";
  const base = `你知道现在是${localTime.month}月${localTime.day}日 ${WEEKDAYS[localTime.weekday]} ${pad(localTime.hour)}:${pad(localTime.minute)}。`;
  if (!dayNoticeNames.length) return base;
  return `${base}今天是${dayNoticeNames.map((name, index) => index ? `也是${name}` : name).join("，")}。`;
}

export async function timeAwarenessText({
  fsOps = fs,
  dataRoot,
  now = new Date(),
  projectRoot,
  includeDayNotice = true,
} = {}) {
  const timeZone = await configuredTimeAwarenessTimeZone({ dataRoot, fsOps });
  const details = await timeAwarenessDetails({ fsOps, dataRoot, now, projectRoot, timeZone });
  if (!details) return "";
  return renderTimeAwarenessText({
    dayNoticeNames: includeDayNotice ? details.dayNoticeNames : [],
    localTime: details.localTime,
  });
}

/**
 * Product-owned dynamic time context provider for the real Agent Core `agent/pre-step`
 * lifecycle seam. Its block is visible to the current model request only; the
 * bridge removes it from later Agent Core model history after that request finishes.
 */
export function createTimeAwarenessContextHook({
  dataRoot,
  fsOps = fs,
  now = () => new Date(),
} = {}) {
  const root = absoluteDirectory(dataRoot);
  const pendingByStatePath = new Map();
  // Start the one-time configuration write as soon as the application mounts
  // the capability. Every later collection only reads this persisted choice.
  const timeConfiguration = root
    ? ensureTimeAwarenessConfig({ dataRoot: root, fsOps })
    : Promise.resolve(Object.freeze({ timeZone: "UTC" }));

  const serialize = async (filePath, operation) => {
    const previous = pendingByStatePath.get(filePath) || Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    const retained = task.catch(() => undefined);
    pendingByStatePath.set(filePath, retained);
    try {
      return await task;
    } finally {
      if (pendingByStatePath.get(filePath) === retained) pendingByStatePath.delete(filePath);
    }
  };

  const collect = async (payload = {}) => {
    const source = plainObject(payload);
    const contactId = validContactId(source.contactId);
    const projectRoot = absoluteDirectory(source.projectRoot);
    const sessionId = validSessionId(source.sessionId);
    if (!root || !contactId || !projectRoot || !sessionId) return null;
    const persistedStatePath = statePath({ dataRoot: root, projectRoot, sessionId });
    if (!persistedStatePath) return null;

    return serialize(persistedStatePath, async () => {
      const initializedConfig = await timeConfiguration;
      const config = await readJson(fsOps, timeConfigPath(root), initializedConfig);
      const timeZone = configuredTimeZone(config)
        || configuredTimeZone(initializedConfig)
        || "UTC";
      const current = asDate(typeof now === "function" ? now() : now);
      if (!current) return null;
      const interval = intervalMinutes(config.intervalMinutes);
      const state = await readJson(fsOps, persistedStatePath, {});
      const taskOpening = openingTaskContext(source);
      if (!taskOpening && injectedWithinInterval(state, current, interval * 60 * 1_000)) return null;
      const details = await timeAwarenessDetails({
        dataRoot: root,
        fsOps,
        now: current,
        projectRoot,
        timeZone,
      });
      if (!details) return null;
      const includeDayNotice = details.dayNoticeNames.length > 0
        && dayNoticeIsDue(state, current, details.dateKey);
      const text = renderTimeAwarenessText({
        dayNoticeNames: includeDayNotice ? details.dayNoticeNames : [],
        localTime: details.localTime,
      });
      if (!text) return null;
      try {
        await writeJsonAtomically(fsOps, persistedStatePath, persistedState(state, {
          current,
          dateKey: details.dateKey,
          includeDayNotice,
        }));
      } catch { /* A later collection will refresh the current time. */ }
      return Object.freeze({
        id: `time-awareness:${sessionId}`,
        kind: "time-awareness",
        display: Object.freeze({
          category: "time",
          context: true,
          label: "时间感知",
          transcript: false,
        }),
        priority: -100,
        metadata: Object.freeze({
          intervalMinutes: interval,
          observedAt: current.toISOString(),
          ...(includeDayNotice ? { dayNotice: true } : {}),
          ...(taskOpening ? { trigger: "task" } : {}),
        }),
        text,
      });
    });
  };

  return Object.freeze({ collect });
}
