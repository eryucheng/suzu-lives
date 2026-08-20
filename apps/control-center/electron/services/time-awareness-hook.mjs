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
const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
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

function includesContact(value, contactId) {
  return Array.isArray(value) && value.some((candidate) => clean(candidate) === contactId);
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

function injectedWithinInterval(value, now, milliseconds) {
  const last = asDate(value?.lastInjectedAt);
  if (!last) return false;
  const elapsed = now.getTime() - last.getTime();
  // Preserve the old wording and behavior: inject again only after the
  // configured interval has elapsed, not exactly at its boundary.
  return elapsed >= 0 && elapsed <= milliseconds;
}

async function currentCalendarEvents(fsOps, filePath, now, agentId) {
  if (!agentId) return [];
  const calendar = await readJson(fsOps, filePath, {});
  if (!Array.isArray(calendar.events)) return [];
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const recurringDate = date.slice(5);
  return calendar.events
    .filter((event) => plainObject(event).enabled !== false)
    .filter((event) => clean(event.agentId) === agentId)
    .filter((event) => clean(event.date) === date || clean(event.date) === recurringDate)
    .map((event) => clean(event.name).slice(0, 120))
    .filter(Boolean);
}

export async function timeAwarenessText({
  fsOps = fs,
  dataRoot,
  now = new Date(),
  projectRoot,
} = {}) {
  const root = absoluteDirectory(dataRoot);
  const workspace = absoluteDirectory(projectRoot);
  const current = asDate(now);
  if (!root || !workspace || !current) return "";
  const agentId = stableAgentId(workspace);
  const dateKey = `${pad(current.getMonth() + 1)}-${pad(current.getDate())}`;
  const names = [...new Set([
    PUBLIC_DATES.get(dateKey),
    ...(await currentCalendarEvents(fsOps, calendarPath(root), current, agentId)),
  ].filter(Boolean))];
  const base = `你知道现在是${current.getMonth() + 1}月${current.getDate()}日 ${WEEKDAYS[current.getDay()]} ${pad(current.getHours())}:${pad(current.getMinutes())}。`;
  if (!names.length) return base;
  return `${base}今天是${names.map((name, index) => index ? `也是${name}` : name).join("，")}。`;
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
      const config = await readJson(fsOps, timeConfigPath(root), {});
      // 未配置过联系人范围时默认对全部联系人启用；一旦显式配置过，按配置生效。
      const hasExplicitScope = Object.hasOwn(config, "enabledContactIds");
      const enabled = hasExplicitScope ? includesContact(config.enabledContactIds, contactId) : true;
      if (!enabled) return null;
      const current = asDate(typeof now === "function" ? now() : now);
      if (!current) return null;
      const interval = intervalMinutes(config.intervalMinutes);
      const state = await readJson(fsOps, persistedStatePath, {});
      if (injectedWithinInterval(state, current, interval * 60 * 1_000)) return null;
      const text = await timeAwarenessText({
        dataRoot: root,
        fsOps,
        now: current,
        projectRoot,
      });
      if (!text) return null;
      // State only prevents duplicates. A local persistence failure must not
      // make the agent lose a legitimate current-time reminder.
      try {
        await writeJsonAtomically(fsOps, persistedStatePath, {
          version: 1,
          lastInjectedAt: current.toISOString(),
        });
      } catch { /* The next request may repeat the time, which is preferable to silence. */ }
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
        }),
        text,
      });
    });
  };

  return Object.freeze({ collect });
}
