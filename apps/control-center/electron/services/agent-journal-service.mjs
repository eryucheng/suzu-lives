import fs from "node:fs/promises";
import path from "node:path";

const CONTACT_ID = /^contact-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const JOURNAL_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_CONTENT_LENGTH = 24_000;
const MAX_ENTRIES = 5_000;

export class AgentJournalError extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentJournalError";
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function validContactId(value) {
  const id = clean(value);
  return CONTACT_ID.test(id) ? id : "";
}

function validDate(value) {
  const date = clean(value);
  if (!JOURNAL_DATE.test(date)) return "";
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);
  return Number.isFinite(parsed.getTime())
    && parsed.getFullYear() === year
    && parsed.getMonth() === month - 1
    && parsed.getDate() === day
    ? date
    : "";
}

function timestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function normalizedEntry(value) {
  const source = plainObject(value);
  const date = validDate(source.date);
  const content = clean(source.content);
  if (!date || !content) return null;
  return {
    content: content.slice(0, MAX_CONTENT_LENGTH),
    createdAt: clean(source.createdAt).slice(0, 80),
    date,
    sessionId: clean(source.sessionId).slice(0, 160),
    updatedAt: clean(source.updatedAt).slice(0, 80),
  };
}

function normalizedDocument(value, contactId) {
  const source = plainObject(value);
  const deduplicated = new Map();
  for (const candidate of Array.isArray(source.entries) ? source.entries : []) {
    const entry = normalizedEntry(candidate);
    if (!entry) continue;
    const current = deduplicated.get(entry.date);
    if (!current || String(entry.updatedAt || entry.createdAt) >= String(current.updatedAt || current.createdAt)) {
      deduplicated.set(entry.date, entry);
    }
  }
  const entries = [...deduplicated.values()]
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, MAX_ENTRIES);
  return { contactId, entries, version: 1 };
}

function dataRootFor(settingsService) {
  const settings = settingsService.load() || {};
  const response = typeof settingsService.response === "function" ? settingsService.response(settings) : settings;
  const dataRoot = clean(response?.dataRoot || settings?.dataRoot);
  if (!dataRoot || !path.isAbsolute(dataRoot)) throw new AgentJournalError("无法定位 Suzu Lives 软件数据目录。 ");
  return path.resolve(dataRoot);
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function ensureDirectory(fsOps, root, segments) {
  let current = root;
  await fsOps.mkdir(root, { recursive: true });
  const rootStat = await fsOps.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new AgentJournalError("日记数据目录不安全。 ");
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await fsOps.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AgentJournalError("日记数据目录不安全。 ");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await fsOps.mkdir(current, { recursive: false });
    }
  }
  return current;
}

function entryPath(root, contactId) {
  const target = path.resolve(root, "automation", "agent-journal", "entries", `${contactId}.json`);
  if (!inside(root, target)) throw new AgentJournalError("日记文件路径无效。 ");
  return target;
}

async function readDocument(fsOps, target, contactId) {
  try {
    const stat = await fsOps.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new AgentJournalError("日记文件不安全。 ");
    return normalizedDocument(JSON.parse(await fsOps.readFile(target, "utf8")), contactId);
  } catch (error) {
    if (error?.code === "ENOENT") return normalizedDocument({}, contactId);
    if (error instanceof AgentJournalError) throw error;
    return normalizedDocument({}, contactId);
  }
}

async function writeDocument(fsOps, root, contactId, document) {
  const directory = await ensureDirectory(fsOps, root, ["automation", "agent-journal", "entries"]);
  const target = entryPath(root, contactId);
  try {
    const stat = await fsOps.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new AgentJournalError("日记文件不安全。 ");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = path.join(directory, `.${contactId}.${process.pid}.${Date.now()}.tmp`);
  await fsOps.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await fsOps.rename(temporary, target);
  } catch (error) {
    await fsOps.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function publicContact(value) {
  const id = validContactId(value?.id);
  return id ? { id, name: clean(value?.name) || "未命名联系人" } : null;
}

/**
 * The diary is application-owned data. It intentionally stays separate from
 * long-term memory and conversation compaction: the Agent only supplies the
 * prose, while this service records and presents it locally by contact.
 */
export function createAgentJournalService({
  contactProjectsService,
  fsOps = fs,
  now = () => new Date(),
  settingsService,
} = {}) {
  if (!contactProjectsService?.snapshot) throw new AgentJournalError("Agent 日记需要联系人项目服务。 ");
  if (!settingsService?.load) throw new AgentJournalError("Agent 日记需要软件设置服务。 ");
  const writes = new Map();

  const queueWrite = (contactId, operation) => {
    const previous = writes.get(contactId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    writes.set(contactId, next.catch(() => undefined));
    return next;
  };

  const contacts = async () => {
    const snapshot = await contactProjectsService.snapshot();
    return (Array.isArray(snapshot?.contacts) ? snapshot.contacts : [])
      .map(publicContact)
      .filter(Boolean);
  };

  const snapshot = async ({ contactId = "" } = {}) => {
    const catalog = await contacts();
    const requested = validContactId(contactId);
    const selected = catalog.find((contact) => contact.id === requested) || catalog[0] || null;
    if (!selected) return { contacts: [], entries: [], selectedContact: null, selectedContactId: "", status: "ready" };
    const root = dataRootFor(settingsService);
    const document = await readDocument(fsOps, entryPath(root, selected.id), selected.id);
    return {
      contacts: catalog,
      entries: document.entries,
      selectedContact: selected,
      selectedContactId: selected.id,
      status: "ready",
    };
  };

  const record = async ({ contactId, content, date, sessionId = "" } = {}) => {
    const id = validContactId(contactId);
    const entryDate = validDate(date);
    const body = clean(content);
    if (!id) throw new AgentJournalError("要写入日记的联系人无效。 ");
    if (!entryDate) throw new AgentJournalError("日记日期无效。 ");
    if (!body) return { saved: false, reason: "empty" };
    if (body.length > MAX_CONTENT_LENGTH) throw new AgentJournalError(`日记正文不能超过 ${MAX_CONTENT_LENGTH.toLocaleString("zh-CN")} 个字符。`);
    return queueWrite(id, async () => {
      const catalog = await contacts();
      if (!catalog.some((contact) => contact.id === id)) return { saved: false, reason: "contact-missing" };
      const root = dataRootFor(settingsService);
      const existing = await readDocument(fsOps, entryPath(root, id), id);
      const occurredAt = timestamp(now());
      const entry = {
        content: body,
        createdAt: existing.entries.find((item) => item.date === entryDate)?.createdAt || occurredAt,
        date: entryDate,
        sessionId: clean(sessionId).slice(0, 160),
        updatedAt: occurredAt,
      };
      const entries = [entry, ...existing.entries.filter((item) => item.date !== entryDate)]
        .sort((left, right) => right.date.localeCompare(left.date))
        .slice(0, MAX_ENTRIES);
      const document = { contactId: id, entries, version: 1 };
      await writeDocument(fsOps, root, id, document);
      return { entry, saved: true };
    });
  };

  const removeContact = async ({ contactId } = {}) => {
    const id = validContactId(contactId);
    if (!id) throw new AgentJournalError("要删除的联系人无效。 ");
    const root = dataRootFor(settingsService);
    const target = entryPath(root, id);
    try {
      const stat = await fsOps.lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new AgentJournalError("日记文件不安全。 ");
      await fsOps.unlink(target);
      return { removed: true };
    } catch (error) {
      if (error?.code === "ENOENT") return { removed: false };
      throw error;
    }
  };

  return { record, removeContact, snapshot };
}

export function localJournalDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new AgentJournalError("日记记录时间无效。 ");
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
