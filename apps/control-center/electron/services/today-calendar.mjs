import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";
import { publicCalendarEvents } from "./public-calendar-events.mjs";

const EVENT_TYPES = new Set(["纪念日", "生日", "日程", "其他"]);
const EVENT_ID = /^[a-z0-9][a-z0-9_-]{0,119}$/iu;
const YEARLY_DATE = /^(\d{2})-(\d{2})$/u;
const EXACT_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype ? value : {};
}

function below(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validDate(value) {
  const date = clean(value);
  const yearly = date.match(YEARLY_DATE);
  const exact = date.match(EXACT_DATE);
  if (!yearly && !exact) return "";
  const year = exact ? Number(exact[1]) : 2000;
  const month = exact ? Number(exact[2]) : Number(yearly[1]);
  const day = exact ? Number(exact[3]) : Number(yearly[2]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return "";
  return date;
}

function normalizedName(value) {
  const name = clean(value).replace(/[\r\n\t]+/gu, " ");
  if (!name || name.length > 80) throw new Error("纪念日名称需要为 1 到 80 个字符。");
  return name;
}

function generatedId(seed = "") {
  const suffix = createHash("sha256").update(`${seed}:${randomBytes(12).toString("hex")}`).digest("hex").slice(0, 18);
  return `event-${suffix}`;
}

function fallbackId(event, index) {
  const source = `${event.date}:${event.name}:${event.type}:${index}`;
  return `legacy-${createHash("sha256").update(source).digest("hex").slice(0, 18)}`;
}

function normalizedStoredEvent(value, index) {
  const source = plainObject(value);
  const date = validDate(source.date);
  const name = clean(source.name).replace(/[\r\n\t]+/gu, " ").slice(0, 80);
  if (!date || !name) return null;
  const type = EVENT_TYPES.has(clean(source.type)) ? clean(source.type) : "纪念日";
  const id = EVENT_ID.test(clean(source.id)) ? clean(source.id) : fallbackId({ date, name, type }, index);
  return { id, date, name, type, enabled: source.enabled !== false, source: "personal", editable: true };
}

function publicEvents() {
  return publicCalendarEvents().map((event) => ({ ...event, enabled: true, source: "holiday", editable: false }));
}

function compareEvents(left, right) {
  return left.date.localeCompare(right.date, "zh-CN")
    || (left.source === right.source ? 0 : left.source === "holiday" ? -1 : 1)
    || left.name.localeCompare(right.name, "zh-CN");
}

async function ordinaryDirectory(directory) {
  try {
    const stat = await fs.lstat(directory);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch {
    return false;
  }
}

async function calendarFile(context) {
  if (!context) return "";
  const agentRoot = path.resolve(context.agentRoot);
  const target = path.resolve(agentRoot, "time-awareness", "calendar.local.json");
  return below(agentRoot, target) ? target : "";
}

async function readCalendar(filePath) {
  if (!filePath) return { status: "needs-agent", events: [] };
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return { status: "invalid", events: [] };
    const source = JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
    if (!plainObject(source) || !Array.isArray(source.events)) return { status: "invalid", events: [] };
    return { status: "ready", events: source.events.map(normalizedStoredEvent).filter(Boolean) };
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "ready", events: [] };
    return { status: "invalid", events: [] };
  }
}

async function ensureDirectory(agentRoot) {
  const root = path.resolve(agentRoot);
  await fs.mkdir(root, { recursive: true });
  const parent = path.join(root, "time-awareness");
  try {
    const stat = await fs.lstat(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("纪念日数据目录不可用，未写入。");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.mkdir(parent, { recursive: false });
  }
}

async function writeCalendar(filePath, events) {
  const root = path.dirname(path.dirname(filePath));
  await ensureDirectory(root);
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("纪念日数据文件不可用，未写入。");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const value = { events: events.map(({ id, date, name, type, enabled }) => ({ id, date, name, type, enabled })) };
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function boolean(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === "true" || value === "on" || value === 1 || value === "1";
}

function inputEvent(value, current = null) {
  const source = plainObject(value);
  const fullDate = validDate(source.date);
  if (!fullDate || !EXACT_DATE.test(fullDate)) throw new Error("请选择一个有效日期。");
  const date = boolean(source.repeat, false) ? fullDate.slice(5) : fullDate;
  const type = EVENT_TYPES.has(clean(source.type)) ? clean(source.type) : "纪念日";
  return {
    id: current?.id || (EVENT_ID.test(clean(source.id)) ? clean(source.id) : generatedId(fullDate)),
    date,
    name: normalizedName(source.name),
    type,
    enabled: boolean(source.enabled, true),
    source: "personal",
    editable: true,
  };
}

function contextFor(settingsService) {
  const settings = plainObject(settingsService.load?.());
  const response = plainObject(settingsService.response?.(settings));
  const dataRoot = clean(response.dataRoot || settings.dataRoot);
  const agentId = clean(settings.agentId);
  if (!clean(settings.projectRoot) || !dataRoot || !agentId) return null;
  return { agentRoot: resolveAgentDataRoot({ dataRoot, agentId }) };
}

export function createTodayCalendarService({ settingsService } = {}) {
  if (!settingsService?.load) throw new Error("今天日历需要软件设置服务。");

  const snapshot = async () => {
    const context = contextFor(settingsService);
    const filePath = await calendarFile(context);
    const personal = await readCalendar(filePath);
    const status = personal.status;
    return {
      status,
      events: [...publicEvents(), ...personal.events].sort(compareEvents),
      canEdit: status === "ready",
    };
  };

  const saveEvent = async (value) => {
    const context = contextFor(settingsService);
    const filePath = await calendarFile(context);
    if (!filePath) throw new Error("请先选择当前 Agent 的工作目录。");
    const current = await readCalendar(filePath);
    if (current.status === "invalid") throw new Error("纪念日数据无法读取，未覆盖原有内容。");
    const requestedId = clean(value?.id);
    const existing = current.events.find((event) => event.id === requestedId) || null;
    const next = inputEvent(value, existing);
    const events = existing
      ? current.events.map((event) => event.id === existing.id ? next : event)
      : [...current.events, next];
    await writeCalendar(filePath, events);
    return snapshot();
  };

  const removeEvent = async (id) => {
    const context = contextFor(settingsService);
    const filePath = await calendarFile(context);
    if (!filePath) throw new Error("请先选择当前 Agent 的工作目录。");
    const current = await readCalendar(filePath);
    if (current.status === "invalid") throw new Error("纪念日数据无法读取，未覆盖原有内容。");
    const eventId = clean(id);
    const target = current.events.find((event) => event.id === eventId);
    if (!target) throw new Error("找不到这项纪念日，未修改数据。");
    await writeCalendar(filePath, current.events.filter((event) => event.id !== eventId));
    return snapshot();
  };

  return { snapshot, saveEvent, removeEvent };
}
