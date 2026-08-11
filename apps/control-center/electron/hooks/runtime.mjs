import fs from "node:fs";
import path from "node:path";

import { resolveAgentConversationDataRoot, stableAgentId } from "@suzu-lives/agent-registry";

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const PUBLIC_DATES = new Map([["01-01", "元旦"], ["05-01", "劳动节"], ["10-01", "国庆节"]]);
const DEFAULT_TIME_AWARENESS_INTERVAL_MINUTES = 10;
const MIN_TIME_AWARENESS_INTERVAL_MINUTES = 1;
const MAX_TIME_AWARENESS_INTERVAL_MINUTES = 24 * 60;
const TIME_AWARENESS_STATE_FILE = "time-awareness.json";
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function clean(value) { return String(value ?? "").trim(); }
function pad(value) { return String(value).padStart(2, "0"); }
function globalCalendarPath(dataRoot) {
  const root = clean(dataRoot);
  return root ? path.join(path.resolve(root), "calendar", "calendar.local.json") : "";
}
function timeAwarenessConfigPath(dataRoot) {
  const root = clean(dataRoot);
  return root ? path.join(path.resolve(root), "capabilities", "time-awareness", "config.json") : "";
}
function timeAwarenessIntervalMs(dataRoot) {
  const defaultInterval = DEFAULT_TIME_AWARENESS_INTERVAL_MINUTES * 60 * 1_000;
  const configPath = timeAwarenessConfigPath(dataRoot);
  if (!configPath) return defaultInterval;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/u, ""));
    const minutes = Number(parsed?.intervalMinutes);
    if (!Number.isInteger(minutes) || minutes < MIN_TIME_AWARENESS_INTERVAL_MINUTES || minutes > MAX_TIME_AWARENESS_INTERVAL_MINUTES) {
      return defaultInterval;
    }
    return minutes * 60 * 1_000;
  } catch {
    return defaultInterval;
  }
}
function sessionId(value) { const id = clean(value); return SESSION_ID.test(id) ? id : ""; }
function timeAwarenessStatePath(dataRoot, agentId, id) {
  return path.join(resolveAgentConversationDataRoot({ dataRoot, agentId, sessionId: id }), TIME_AWARENESS_STATE_FILE);
}

function readLastInjectedAt(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
    const recorded = new Date(parsed?.lastInjectedAt);
    return Number.isFinite(recorded.getTime()) ? recorded : null;
  } catch {
    return null;
  }
}

function injectedWithinInterval(filePath, now, intervalMs) {
  const last = readLastInjectedAt(filePath);
  if (!last) return false;
  const elapsed = now.getTime() - last.getTime();
  return elapsed >= 0 && elapsed <= intervalMs;
}

function writeLastInjectedAt(filePath, now) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, lastInjectedAt: now.toISOString() })}\n`, { encoding: "utf8", flag: "wx" });
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* The temporary file may already be gone. */ }
    throw error;
  }
}

function readContactEvents(filePath, now, agentId) {
  const owner = clean(agentId);
  if (!owner) return [];
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "")); } catch { return []; }
  if (!Array.isArray(parsed?.events)) return [];
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const recurring = date.slice(5);
  return parsed.events
    .filter((event) => event && typeof event === "object" && event.enabled !== false)
    .filter((event) => clean(event.agentId) === owner)
    .filter((event) => clean(event.date) === date || clean(event.date) === recurring)
    .map((event) => clean(event.name).slice(0, 120))
    .filter(Boolean);
}

export function timeAwarenessContext({ now = new Date(), calendarPath = "", agentId = "" } = {}) {
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.getTime())) throw new Error("当前时间无效。");
  const dateKey = `${pad(current.getMonth() + 1)}-${pad(current.getDate())}`;
  const names = [...new Set([PUBLIC_DATES.get(dateKey), ...readContactEvents(calendarPath, current, agentId)].filter(Boolean))];
  const base = `你知道现在是${current.getMonth() + 1}月${current.getDate()}日 ${WEEKDAYS[current.getDay()]} ${pad(current.getHours())}:${pad(current.getMinutes())}。`;
  if (!names.length) return base;
  return `${base}今天是${names.map((name, index) => index ? `也是${name}` : name).join("，")}。`;
}

function hookOutput(context) {
  return context ? {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  } : {};
}

function parsedArguments(values) {
  const role = values[0]; const options = {};
  for (let index = 1; index < values.length; index += 1) {
    const key = values[index]; const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("Hook 参数无效。");
    options[key.slice(2)] = value; index += 1;
  }
  return { role, options };
}

export async function runProjectHook({ args = [], input = "", now = new Date() } = {}) {
  let event;
  try { event = JSON.parse(String(input || "")); } catch { return {}; }
  let command;
  try { command = parsedArguments(args); } catch { return {}; }
  if (command.role !== "time-awareness") return {};
  const root = clean(command.options["project-root"]);
  const softwareDataRoot = clean(command.options["data-root"]);
  if (!root || !softwareDataRoot) return {};
  try {
    const current = now instanceof Date ? new Date(now.getTime()) : new Date(now);
    if (!Number.isFinite(current.getTime())) return {};
    const agentId = stableAgentId(root);
    const id = sessionId(event?.session_id);
    const statePath = id ? timeAwarenessStatePath(softwareDataRoot, agentId, id) : "";
    if (statePath && injectedWithinInterval(statePath, current, timeAwarenessIntervalMs(softwareDataRoot))) return {};
    const context = timeAwarenessContext({
      now: current,
      agentId,
      calendarPath: globalCalendarPath(softwareDataRoot),
    });
    // The cache only suppresses duplicate reminders. If the private state cannot
    // be written, preserve the prior behavior and still provide fresh time.
    if (statePath) {
      try { writeLastInjectedAt(statePath, current); } catch { /* Fail open. */ }
    }
    return hookOutput(context);
  } catch {
    return {};
  }
}

export async function runProjectHookCli({ args = process.argv.slice(3), stdin = process.stdin, stdout = process.stdout } = {}) {
  let input = "";
  try {
    for await (const chunk of stdin) input += chunk;
    const result = await runProjectHook({ args, input });
    if (result.forwardedOutput) stdout.write(result.forwardedOutput);
    else if (Object.keys(result).length) stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    // Command hooks must fail open and keep stdout clean on every error path.
  }
}
