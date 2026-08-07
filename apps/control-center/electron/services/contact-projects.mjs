import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { stableAgentId } from "@suzu-lives/agent-registry";

const CONTACT_FILE = "CLAUDE.md";
const CONTACT_METADATA_DIRECTORY = ".suzu-lives";
const CONTACT_METADATA_FILE = "contact.json";
const CONTACT_ID_PATTERN = /^contact-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const MAX_CONTACTS = 160;
const MAX_CONTACT_NAME_LENGTH = 80;

export class ContactProjectsError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContactProjectsError";
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function directChild(root, name) {
  const target = path.resolve(root, name);
  if (!samePath(path.dirname(target), root)) throw new ContactProjectsError("联系人目录不能指向项目目录之外。 ");
  return target;
}

export function normalizeContactName(value) {
  const name = clean(value);
  if (!name) throw new ContactProjectsError("请填写联系人备注。 ");
  if (name.length > MAX_CONTACT_NAME_LENGTH) throw new ContactProjectsError(`联系人备注不能超过 ${MAX_CONTACT_NAME_LENGTH} 个字符。`);
  return name;
}

function normalizeContactId(value) {
  const id = clean(value).toLowerCase();
  if (!CONTACT_ID_PATTERN.test(id)) throw new ContactProjectsError("联系人内部目录标识无效。 ");
  return id;
}

async function ordinaryDirectory(fsOps, directory, message) {
  const target = path.resolve(clean(directory));
  let stat;
  try { stat = await fsOps.lstat(target); }
  catch { throw new ContactProjectsError(message); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ContactProjectsError(message);
  return fsOps.realpath(target);
}

async function ordinaryFile(fsOps, filePath) {
  try {
    const stat = await fsOps.lstat(filePath);
    return !stat.isSymbolicLink() && stat.isFile();
  } catch {
    return false;
  }
}

async function contactMetadata(fsOps, projectRoot) {
  const directory = path.join(projectRoot, CONTACT_METADATA_DIRECTORY);
  let directoryStat;
  try { directoryStat = await fsOps.lstat(directory); }
  catch { return null; }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) return null;
  const filePath = path.join(directory, CONTACT_METADATA_FILE);
  if (!(await ordinaryFile(fsOps, filePath))) return null;
  let raw;
  try { raw = JSON.parse(await fsOps.readFile(filePath, "utf8")); }
  catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  try {
    return { id: normalizeContactId(raw.id), name: normalizeContactName(raw.name) };
  } catch {
    return null;
  }
}

async function contactAt(fsOps, root, value) {
  let id;
  try { id = normalizeContactId(value); }
  catch { return null; }
  const projectRoot = directChild(root, id);
  let stat;
  try { stat = await fsOps.lstat(projectRoot); }
  catch { return null; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
  const realProjectRoot = await fsOps.realpath(projectRoot);
  if (!samePath(path.dirname(realProjectRoot), root)) return null;
  if (!(await ordinaryFile(fsOps, path.join(realProjectRoot, CONTACT_FILE)))) return null;
  const metadata = await contactMetadata(fsOps, realProjectRoot);
  if (!metadata || metadata.id !== id) return null;
  return {
    id,
    name: metadata.name,
    agentId: stableAgentId(realProjectRoot),
    projectRoot: realProjectRoot,
    updatedAt: stat.mtime instanceof Date ? stat.mtime.toISOString() : "",
  };
}

async function writeTextAtomic(fsOps, target, value) {
  await fsOps.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.suzu-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  await fsOps.writeFile(temporary, value, { encoding: "utf8", flag: "wx" });
  try { await fsOps.rename(temporary, target); }
  catch (error) { await fsOps.unlink(temporary).catch(() => undefined); throw error; }
}

function initialClaudeFile(name) {
  return `# ${name}\n`;
}

/**
 * Owns the contact catalogue below a user-selected root. A contact's visible
 * remark is project metadata; its Claude project folder is a generated ID so
 * duplicate remarks cannot share a native Claude history directory.
 */
export function createContactProjectsService({
  settingsService,
  ensureClaudeProjectSettings = null,
  fsOps = fs,
  createContactId = () => `contact-${randomUUID()}`,
} = {}) {
  if (!settingsService?.load || !settingsService?.save) {
    throw new ContactProjectsError("联系人项目服务需要软件设置服务。 ");
  }

  const contactsRoot = async () => {
    const configured = clean(settingsService.load()?.contactsRoot);
    if (!configured) throw new ContactProjectsError("请先在设置中选择联系人项目目录。 ");
    return ordinaryDirectory(fsOps, configured, "联系人项目目录不存在或不是普通文件夹。 ");
  };

  const list = async (root) => {
    let entries;
    try { entries = await fsOps.readdir(root, { withFileTypes: true }); }
    catch { throw new ContactProjectsError("无法读取联系人项目目录。 "); }
    const contacts = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || contacts.length >= MAX_CONTACTS) continue;
      const contact = await contactAt(fsOps, root, entry.name);
      if (contact) contacts.push(contact);
    }
    return contacts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name, "zh-CN"));
  };

  const ensureProjectSettings = async (projectRoot) => {
    if (typeof ensureClaudeProjectSettings !== "function") return { status: "not-configured" };
    try {
      return await ensureClaudeProjectSettings({ projectRoot });
    } catch (error) {
      throw new ContactProjectsError(`无法写入联系人 Claude 项目设置：${clean(error?.message) || "未知错误"}`);
    }
  };

  const syncClaudeProjectSettings = async () => {
    const configured = clean(settingsService.load()?.contactsRoot);
    if (!configured) return { status: "not-configured", contacts: [], errors: [] };
    const root = await contactsRoot();
    const contacts = await list(root);
    if (typeof ensureClaudeProjectSettings !== "function") return { status: "not-configured", contacts: [], errors: [] };
    const results = [];
    const errors = [];
    for (const contact of contacts) {
      try {
        results.push({ id: contact.id, projectRoot: contact.projectRoot, ...(await ensureProjectSettings(contact.projectRoot)) });
      } catch (error) {
        errors.push({ id: contact.id, projectRoot: contact.projectRoot, message: clean(error?.message) || "未知错误" });
      }
    }
    return { status: errors.length ? "partial" : "synced", contacts: results, errors };
  };

  const snapshot = async () => {
    const settings = settingsService.load();
    if (!clean(settings.contactsRoot)) {
      return { status: "needs-root", contactsRoot: "", contacts: [], activeContact: null };
    }
    const root = await contactsRoot();
    const contacts = await list(root);
    const selectedRoot = clean(settings.projectRoot);
    const activeContact = selectedRoot
      ? contacts.find((contact) => samePath(contact.projectRoot, selectedRoot)) || null
      : null;
    return { status: "ready", contactsRoot: root, contacts, activeContact };
  };

  const selectRoot = async (directory) => {
    const root = await ordinaryDirectory(fsOps, directory, "选择的联系人项目目录不可用。 ");
    const settings = settingsService.load();
    settingsService.save({ ...settings, contactsRoot: root, projectRoot: "", conversationSessionId: "" });
    await syncClaudeProjectSettings();
    return snapshot();
  };

  const select = async ({ id } = {}) => {
    const root = await contactsRoot();
    const contact = await contactAt(fsOps, root, id);
    if (!contact) throw new ContactProjectsError("所选联系人不存在或不是由 Suzu 创建的 Claude 项目。 ");
    await ensureProjectSettings(contact.projectRoot);
    const settings = settingsService.load();
    settingsService.save({ ...settings, projectRoot: contact.projectRoot, conversationSessionId: "" });
    return snapshot();
  };

  const create = async ({ name } = {}) => {
    const root = await contactsRoot();
    const normalizedName = normalizeContactName(name);
    let id = "";
    let projectRoot = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = normalizeContactId(createContactId());
      const candidateRoot = directChild(root, candidate);
      try {
        await fsOps.mkdir(candidateRoot, { recursive: false });
        id = candidate;
        projectRoot = await fsOps.realpath(candidateRoot);
        break;
      } catch (error) {
        if (error?.code === "EEXIST") continue;
        throw new ContactProjectsError(`无法创建联系人项目目录：${clean(error?.message) || "未知错误"}`);
      }
    }
    if (!projectRoot) throw new ContactProjectsError("无法生成未占用的联系人项目目录。 ");
    try {
      await writeTextAtomic(fsOps, path.join(projectRoot, CONTACT_FILE), initialClaudeFile(normalizedName));
    } catch (error) {
      throw new ContactProjectsError(`无法初始化 CLAUDE.md：${clean(error?.message) || "未知错误"}`);
    }
    try {
      await writeTextAtomic(fsOps, path.join(projectRoot, CONTACT_METADATA_DIRECTORY, CONTACT_METADATA_FILE), `${JSON.stringify({
        version: 1,
        id,
        name: normalizedName,
        createdAt: new Date().toISOString(),
      }, null, 2)}\n`);
    } catch (error) {
      throw new ContactProjectsError(`无法保存联系人备注：${clean(error?.message) || "未知错误"}`);
    }
    await ensureProjectSettings(projectRoot);
    const settings = settingsService.load();
    settingsService.save({ ...settings, projectRoot, conversationSessionId: "" });
    return snapshot();
  };

  return { create, select, selectRoot, snapshot, syncClaudeProjectSettings };
}
