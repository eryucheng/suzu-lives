import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

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
  const source = `${event.contactId}:${event.date}:${event.name}:${event.type}:${index}`;
  return `legacy-${createHash("sha256").update(source).digest("hex").slice(0, 18)}`;
}

function normalizedStoredEvent(value, index) {
  const source = plainObject(value);
  const date = validDate(source.date);
  const name = clean(source.name).replace(/[\r\n\t]+/gu, " ").slice(0, 80);
  const contactId = clean(source.contactId);
  const agentId = clean(source.agentId);
  if (!date || !name || !contactId || !agentId) return null;
  const type = EVENT_TYPES.has(clean(source.type)) ? clean(source.type) : "纪念日";
  const id = EVENT_ID.test(clean(source.id)) ? clean(source.id) : fallbackId({ contactId, date, name, type }, index);
  return { id, contactId, agentId, date, name, type, enabled: source.enabled !== false, source: "personal", editable: true };
}

function publicEvents() {
  return publicCalendarEvents().map((event) => ({ ...event, enabled: true, source: "holiday", editable: false }));
}

function compareEvents(left, right) {
  return left.date.localeCompare(right.date, "zh-CN")
    || (left.source === right.source ? 0 : left.source === "holiday" ? -1 : 1)
    || left.name.localeCompare(right.name, "zh-CN");
}

function calendarFile(dataRoot) {
  const root = clean(dataRoot);
  if (!root) return "";
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, "calendar", "calendar.local.json");
  return below(resolvedRoot, target) ? target : "";
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

async function ensureDirectory(dataRoot) {
  const root = path.resolve(dataRoot);
  await fs.mkdir(root, { recursive: true });
  const parent = path.join(root, "calendar");
  try {
    const stat = await fs.lstat(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("纪念日数据目录不可用，未写入。");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.mkdir(parent, { recursive: false });
  }
}

async function writeCalendar(filePath, dataRoot, events) {
  await ensureDirectory(dataRoot);
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("纪念日数据文件不可用，未写入。");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const value = { events: events.map(({ id, contactId, agentId, date, name, type, enabled }) => ({ id, contactId, agentId, date, name, type, enabled })) };
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

function inputEvent(value, current = null, contact = null) {
  const source = plainObject(value);
  const contactId = clean(contact?.id);
  const agentId = clean(contact?.agentId);
  if (!contactId || !agentId) throw new Error("所选联系人不存在或不可用。 ");
  const fullDate = validDate(source.date);
  if (!fullDate || !EXACT_DATE.test(fullDate)) throw new Error("请选择一个有效日期。");
  const date = boolean(source.repeat, false) ? fullDate.slice(5) : fullDate;
  const type = EVENT_TYPES.has(clean(source.type)) ? clean(source.type) : "纪念日";
  return {
    id: current?.id || (EVENT_ID.test(clean(source.id)) ? clean(source.id) : generatedId(fullDate)),
    contactId,
    agentId,
    date,
    name: normalizedName(source.name),
    type,
    enabled: boolean(source.enabled, true),
    source: "personal",
    editable: true,
  };
}

function dataRootFor(settingsService) {
  const settings = plainObject(settingsService.load?.());
  const response = plainObject(settingsService.response?.(settings));
  return clean(response.dataRoot || settings.dataRoot);
}

function defaultContactId(contactsSnapshot, contacts) {
  const candidates = [
    clean(contactsSnapshot?.activeContact?.id),
    clean(contactsSnapshot?.preferredContact?.id),
    ...contacts.map((contact) => clean(contact?.id)),
  ];
  return candidates.find((id) => contacts.some((contact) => clean(contact?.id) === id)) || "";
}

async function contactCatalog(contactProjectsService) {
  const contactsSnapshot = await contactProjectsService.snapshot();
  const contacts = Array.isArray(contactsSnapshot?.contacts) ? contactsSnapshot.contacts : [];
  return {
    contactsSnapshot,
    contacts,
    byId: new Map(contacts.map((contact) => [clean(contact?.id), contact]).filter(([id]) => id)),
  };
}

function publicContactCalendar(contact) {
  return {
    id: clean(contact?.id),
    name: clean(contact?.name) || "未命名联系人",
  };
}

function ownedEvent(catalog, event) {
  const contact = catalog.byId.get(clean(event.contactId)) || null;
  const { agentId: _agentId, ...publicEvent } = event;
  return {
    ...publicEvent,
    contactName: clean(contact?.name) || "已移除联系人",
    editable: Boolean(contact && clean(contact.agentId) === clean(event.agentId)),
  };
}

async function calendarContext({ contactProjectsService, settingsService }) {
  const dataRoot = dataRootFor(settingsService);
  return {
    catalog: dataRoot ? await contactCatalog(contactProjectsService) : { contactsSnapshot: null, contacts: [], byId: new Map() },
    dataRoot,
    filePath: calendarFile(dataRoot),
  };
}

async function writableContext(contactId, dependencies) {
  const id = clean(contactId);
  if (!id) throw new Error("请选择要保存日期的联系人。 ");
  const context = await calendarContext(dependencies);
  if (!context.dataRoot || !context.filePath) throw new Error("Suzu Lives 数据目录不可用。 ");
  const contact = context.catalog.byId.get(id) || null;
  if (!contact) throw new Error("所选联系人不存在或不可用。 ");
  return { ...context, contact };
}

export function createTodayCalendarService({ contactProjectsService, settingsService } = {}) {
  if (!settingsService?.load || !contactProjectsService?.snapshot) {
    throw new Error("今天日历需要软件设置和联系人项目服务。");
  }

  const snapshot = async () => {
    const context = await calendarContext({ contactProjectsService, settingsService });
    const stored = await readCalendar(context.filePath);
    const contacts = context.catalog.contacts.map(publicContactCalendar).filter((contact) => contact.id);
    const personal = stored.events.map((event) => ownedEvent(context.catalog, event));
    const hasContacts = clean(context.catalog.contactsSnapshot?.status) === "ready" && contacts.length > 0;
    return {
      status: stored.status === "invalid" ? "invalid" : hasContacts ? "ready" : "needs-agent",
      events: [...publicEvents(), ...personal].sort(compareEvents),
      contacts,
      defaultContactId: defaultContactId(context.catalog.contactsSnapshot, context.catalog.contacts),
      canEdit: stored.status === "ready" && hasContacts,
    };
  };

  const saveEvent = async (value) => {
    const context = await writableContext(value?.contactId, { contactProjectsService, settingsService });
    const current = await readCalendar(context.filePath);
    if (current.status === "invalid") throw new Error("纪念日数据无法读取，未覆盖原有内容。");
    const requestedId = clean(value?.id);
    const existing = current.events.find((event) => event.id === requestedId && event.contactId === context.contact.id) || null;
    const next = inputEvent(value, existing, context.contact);
    const events = existing
      ? current.events.map((event) => event.id === existing.id && event.contactId === context.contact.id ? next : event)
      : [...current.events, next];
    await writeCalendar(context.filePath, context.dataRoot, events);
    return snapshot();
  };

  const removeEvent = async ({ contactId, id } = {}) => {
    const context = await writableContext(contactId, { contactProjectsService, settingsService });
    const current = await readCalendar(context.filePath);
    if (current.status === "invalid") throw new Error("纪念日数据无法读取，未覆盖原有内容。");
    const eventId = clean(id);
    const target = current.events.find((event) => event.id === eventId && event.contactId === context.contact.id);
    if (!target) throw new Error("找不到这项纪念日，未修改数据。");
    await writeCalendar(context.filePath, context.dataRoot, current.events.filter((event) => event !== target));
    return snapshot();
  };

  const removeContact = async ({ contactId } = {}) => {
    const id = clean(contactId);
    if (!id) throw new Error("要删除的联系人无效。 ");
    const dataRoot = dataRootFor(settingsService);
    const filePath = calendarFile(dataRoot);
    if (!dataRoot || !filePath) return { removed: 0 };
    const current = await readCalendar(filePath);
    if (current.status === "invalid") throw new Error("纪念日数据无法读取，未覆盖原有内容。");
    const events = current.events.filter((event) => clean(event.contactId) !== id);
    const removed = current.events.length - events.length;
    if (removed) await writeCalendar(filePath, dataRoot, events);
    return { removed };
  };

  return { snapshot, saveEvent, removeContact, removeEvent };
}
