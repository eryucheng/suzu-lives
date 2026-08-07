import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildDisplayMessages, JsonlTail, readTranscriptWindow, searchTranscript } from "@suzu-lives/conversation-reader";

const MAX_MESSAGES = 500;
const MAX_RECORDS = 2500;
const MAX_SESSION_FILES = 160;
const MAX_SUMMARY_BYTES = 128 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export class ConversationReaderError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConversationReaderError";
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function compactText(value, limit = 60) {
  const text = clean(value).replace(/\s+/gu, " ");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function isSessionId(value) {
  return SESSION_ID_PATTERN.test(clean(value));
}

function isoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function contentText(content) {
  if (typeof content === "string") return compactText(content, 80);
  if (!Array.isArray(content)) return "";
  return compactText(content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n"), 80);
}

function candidateProjectKeys(projectRoot) {
  const absolute = path.resolve(projectRoot);
  const forward = absolute.replaceAll("\\", "/");
  return [...new Set([
    encodeClaudeProjectKey(absolute),
    absolute.replaceAll(path.sep, "-"),
    absolute.replace(/[\\/:]/gu, "-"),
    absolute.replace(/[\\/:_]/gu, "-"),
    forward.replaceAll("/", "-"),
  ].map(clean).filter(Boolean))];
}

async function directoryExists(fsOps, targetPath) {
  try {
    return (await fsOps.stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

async function fileStat(fsOps, targetPath) {
  try {
    const stat = await fsOps.stat(targetPath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

async function sessionSummary(fsOps, filePath) {
  let handle = null;
  try {
    handle = await fsOps.open(filePath, "r");
    const buffer = Buffer.alloc(MAX_SUMMARY_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/gu);
    for (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record?.type !== "user") continue;
      const text = contentText(record?.message?.content);
      if (text) return text;
    }
  } catch {
    return "";
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  return "";
}

function publicSession(session) {
  return {
    id: session.id,
    title: session.title,
    preview: session.preview,
    updatedAt: session.updatedAt,
    ...(session.createdAt ? { createdAt: session.createdAt } : {}),
    ...(session.draft ? { draft: true } : {}),
  };
}

function publicContact(contact) {
  if (!contact || typeof contact !== "object") return null;
  return {
    id: clean(contact.id),
    name: clean(contact.name),
    agentId: clean(contact.agentId),
    ...(clean(contact.updatedAt) ? { updatedAt: clean(contact.updatedAt) } : {}),
  };
}

/**
 * Mirrors Claude Code's project-directory derivation. The native history is
 * always scoped to the active working directory; it never scans unrelated
 * Claude projects or a user-selected arbitrary JSONL path.
 */
export function encodeClaudeProjectKey(projectRoot) {
  const source = path.resolve(clean(projectRoot)).replaceAll("\\", "/");
  return Array.from(source, (character) => {
    const codePoint = character.codePointAt(0) || 0;
    return ["/", ":", "_", " ", "~", ".", "@"].includes(character) || codePoint > 127 ? "-" : character;
  }).join("");
}

export async function locateClaudeProjectDirectory({
  projectRoot,
  fsOps = fs,
  homeDirectory = os.homedir(),
} = {}) {
  const root = clean(projectRoot);
  if (!root) return { status: "missing-project", projectRoot: "", projectDir: "", exists: false };
  const absoluteRoot = path.resolve(root);
  const projectsRoot = path.join(homeDirectory, ".claude", "projects");
  const candidates = candidateProjectKeys(absoluteRoot);
  for (const key of candidates) {
    const directory = path.join(projectsRoot, key);
    if (await directoryExists(fsOps, directory)) {
      return { status: "ready", projectRoot: absoluteRoot, projectDir: directory, exists: true };
    }
  }
  return {
    status: "ready",
    projectRoot: absoluteRoot,
    projectDir: path.join(projectsRoot, encodeClaudeProjectKey(absoluteRoot)),
    exists: false,
  };
}

export function createConversationReader({
  contactProjectsService = null,
  settingsService,
  fsOps = fs,
  homeDirectory = os.homedir(),
  createSessionId = randomUUID,
} = {}) {
  if (!settingsService?.load) throw new ConversationReaderError("会话读取需要软件设置服务。");

  let activePath = "";
  let activeProjectRoot = "";
  let selectionVersion = 0;
  let selectedSessionId = "";
  let tail = null;
  const drafts = new Map();
  const summaries = new Map();

  const persistSelection = (settings, sessionId) => {
    selectedSessionId = sessionId;
    selectionVersion += 1;
    if (typeof settingsService.save === "function") settingsService.save({ ...settings, conversationSessionId: sessionId });
  };

  const listSessions = async (location) => {
    if (!location.exists) return [];
    let entries;
    try { entries = await fsOps.readdir(location.projectDir, { withFileTypes: true }); }
    catch { return []; }
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const id = entry.name.slice(0, -".jsonl".length);
      if (!isSessionId(id)) continue;
      const filePath = path.join(location.projectDir, entry.name);
      const stat = await fileStat(fsOps, filePath);
      if (!stat) continue;
      candidates.push({ id, filePath, stat });
    }
    const ordered = candidates
      .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)
      .slice(0, MAX_SESSION_FILES);
    return Promise.all(ordered.map(async ({ id, filePath, stat }) => {
      const signature = `${stat.size}:${stat.mtimeMs}`;
      const cached = summaries.get(filePath);
      const preview = cached?.signature === signature ? cached.preview : await sessionSummary(fsOps, filePath);
      summaries.set(filePath, { signature, preview });
      return {
        id,
        filePath,
        signature,
        title: preview || "未命名对话",
        preview: preview || "还没有可展示的消息",
        updatedAt: isoDate(stat.mtime),
        createdAt: isoDate(stat.birthtime),
        draft: false,
      };
    }));
  };

  const catalog = async () => {
    const settings = settingsService.load();
    const contacts = await contactProjectsService.snapshot();
    // A contact is the only owner of a Claude project. When no contacts root
    // is selected, do not reopen a historic direct project.
    const selectedProjectRoot = contacts.status === "ready"
      ? clean(contacts.activeContact?.projectRoot)
      : "";
    const location = await locateClaudeProjectDirectory({
      projectRoot: selectedProjectRoot,
      fsOps,
      homeDirectory,
    });
    if (location.projectRoot !== activeProjectRoot) {
      activeProjectRoot = location.projectRoot;
      activePath = "";
      tail = null;
      drafts.clear();
      selectedSessionId = clean(settings.conversationSessionId);
      selectionVersion += 1;
    }
    const native = await listSessions(location);
    for (const session of native) drafts.delete(session.id);
    const localDrafts = [...drafts.values()]
      .filter((session) => session.projectRoot === location.projectRoot)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return {
      settings,
      ...location,
      contacts: Array.isArray(contacts.contacts) ? contacts.contacts.map(publicContact).filter(Boolean) : [],
      contactsRoot: clean(contacts.contactsRoot),
      activeContact: publicContact(contacts.activeContact),
      sessions: [...localDrafts, ...native],
    };
  };

  const currentSession = (currentCatalog) => {
    const wanted = selectedSessionId || clean(currentCatalog.settings.conversationSessionId);
    return currentCatalog.sessions.find((session) => session.id === wanted) || currentCatalog.sessions[0] || null;
  };

  const createDraft = async (providedCatalog = null) => {
    const currentCatalog = providedCatalog || await catalog();
    if (!currentCatalog.projectRoot) throw new ConversationReaderError("请先选择 Claude 工作目录。");
    let id = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = clean(createSessionId());
      if (isSessionId(candidate) && !currentCatalog.sessions.some((session) => session.id === candidate)) {
        id = candidate;
        break;
      }
    }
    if (!id) throw new ConversationReaderError("无法创建新的 Claude 会话标识。");
    const now = new Date().toISOString();
    const draft = {
      id,
      projectRoot: currentCatalog.projectRoot,
      filePath: "",
      signature: `draft:${now}`,
      title: "新对话",
      preview: "还没有消息",
      updatedAt: now,
      createdAt: now,
      draft: true,
    };
    drafts.set(id, draft);
    persistSelection(currentCatalog.settings, id);
    return draft;
  };

  const context = async () => {
    const currentCatalog = await catalog();
    if (!currentCatalog.projectRoot) {
      return {
        status: "missing",
        settings: currentCatalog.settings,
        contacts: currentCatalog.contacts,
        contactsRoot: currentCatalog.contactsRoot,
        activeContact: currentCatalog.activeContact,
        projectRoot: "",
        projectDir: "",
        sessions: [],
        session: null,
        sessionId: "",
        fileName: "",
        filePath: "",
        records: [],
        version: `missing:${selectionVersion}`,
        pollIntervalMs: 2000,
      };
    }
    const session = currentSession(currentCatalog);
    const catalogVersion = currentCatalog.sessions.map((item) => `${item.id}:${item.signature}`).join("|");
    if (!session || !session.filePath) {
      return {
        status: "ready",
        settings: currentCatalog.settings,
        contacts: currentCatalog.contacts,
        contactsRoot: currentCatalog.contactsRoot,
        activeContact: currentCatalog.activeContact,
        projectRoot: currentCatalog.projectRoot,
        projectDir: currentCatalog.projectDir,
        sessions: currentCatalog.sessions,
        session,
        sessionId: session?.id || "",
        fileName: "",
        filePath: "",
        records: [],
        version: `${selectionVersion}:${session?.id || "none"}:0:${catalogVersion}`,
        pollIntervalMs: 2000,
        updatedAt: new Date().toISOString(),
      };
    }
    if (!tail || activePath !== session.filePath) {
      activePath = session.filePath;
      tail = new JsonlTail(session.filePath, MAX_RECORDS);
    }
    try {
      await tail.refresh();
    } catch {
      activePath = "";
      tail = null;
      return {
        status: "ready",
        settings: currentCatalog.settings,
        contacts: currentCatalog.contacts,
        contactsRoot: currentCatalog.contactsRoot,
        activeContact: currentCatalog.activeContact,
        projectRoot: currentCatalog.projectRoot,
        projectDir: currentCatalog.projectDir,
        sessions: currentCatalog.sessions,
        session,
        sessionId: session.id,
        fileName: path.basename(session.filePath),
        filePath: session.filePath,
        records: [],
        version: `${selectionVersion}:${session.id}:missing:${catalogVersion}`,
        pollIntervalMs: 2000,
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      status: "ready",
      settings: currentCatalog.settings,
      contacts: currentCatalog.contacts,
      contactsRoot: currentCatalog.contactsRoot,
      activeContact: currentCatalog.activeContact,
      projectRoot: currentCatalog.projectRoot,
      projectDir: currentCatalog.projectDir,
      sessions: currentCatalog.sessions,
      session,
      sessionId: session.id,
      fileName: path.basename(session.filePath),
      filePath: session.filePath,
      records: [...tail.records],
      version: `${selectionVersion}:${session.id}:${tail.version}:${catalogVersion}`,
      scannedRecords: tail.scannedRecords,
      malformedLines: tail.malformedLines,
      pollIntervalMs: 2000,
      updatedAt: new Date().toISOString(),
    };
  };

  const snapshot = async () => {
    const current = await context();
    return {
      status: current.status,
      contactsRoot: current.contactsRoot,
      contacts: current.contacts,
      activeContact: current.activeContact,
      projectRoot: current.projectRoot,
      projectDir: current.projectDir,
      sessions: current.sessions.map(publicSession),
      activeSessionId: current.sessionId,
      fileName: current.fileName,
      version: current.version,
      messages: current.status === "ready" ? buildDisplayMessages(current.records, MAX_MESSAGES) : [],
      scannedRecords: current.scannedRecords || 0,
      malformedLines: current.malformedLines || 0,
      pollIntervalMs: current.pollIntervalMs,
      updatedAt: current.updatedAt || "",
    };
  };

  const select = async (sessionId) => {
    const id = clean(sessionId);
    const currentCatalog = await catalog();
    if (!isSessionId(id) || !currentCatalog.sessions.some((session) => session.id === id)) {
      throw new ConversationReaderError("所选 Claude 会话不存在于当前工作目录。");
    }
    persistSelection(currentCatalog.settings, id);
    return snapshot();
  };

  const create = async () => {
    await createDraft();
    return snapshot();
  };

  const createContact = async ({ name } = {}) => {
    if (!contactProjectsService?.create) throw new ConversationReaderError("当前版本未接入联系人项目服务。 ");
    await contactProjectsService.create({ name });
    return snapshot();
  };

  const selectContact = async ({ id } = {}) => {
    if (!contactProjectsService?.select) throw new ConversationReaderError("当前版本未接入联系人项目服务。 ");
    await contactProjectsService.select({ id });
    return snapshot();
  };

  const ensureActiveSession = async () => {
    const currentCatalog = await catalog();
    const session = currentSession(currentCatalog) || await createDraft(currentCatalog);
    return {
      id: session.id,
      projectRoot: currentCatalog.projectRoot,
      hasTranscript: Boolean(session.filePath),
    };
  };

  /** Resolve a selected session without letting a renderer choose its working directory. */
  const resolveSession = async (sessionId) => {
    const id = clean(sessionId);
    const currentCatalog = await catalog();
    const session = currentCatalog.sessions.find((item) => item.id === id) || null;
    if (!isSessionId(id) || !session || !currentCatalog.projectRoot) {
      throw new ConversationReaderError("所选 Claude 会话不存在于当前工作目录。");
    }
    return {
      id: session.id,
      projectRoot: currentCatalog.projectRoot,
      hasTranscript: Boolean(session.filePath),
    };
  };

  const search = async (query) => {
    const current = await context();
    if (current.status !== "ready") return { status: "missing", query: String(query || ""), matches: [] };
    if (!current.filePath) return {
      status: "ready",
      activeSessionId: current.sessionId,
      query: String(query || "").trim(),
      scannedRecords: 0,
      malformedLines: 0,
      matchedRecords: 0,
      truncated: false,
      matches: [],
    };
    return {
      status: "ready",
      activeSessionId: current.sessionId,
      fileName: current.fileName,
      ...(await searchTranscript(current.filePath, query, 100)),
    };
  };

  const focus = async ({ lineNumber, messageId } = {}) => {
    const current = await context();
    if (current.status !== "ready" || !current.filePath) {
      throw new ConversationReaderError("当前会话没有可定位的聊天记录。");
    }
    const result = await readTranscriptWindow(current.filePath, lineNumber, { before: 28, after: 28 });
    return {
      status: "ready",
      activeSessionId: current.sessionId,
      fileName: current.fileName,
      focusMessageId: clean(messageId),
      ...result,
    };
  };

  return { context, create, createContact, ensureActiveSession, focus, resolveSession, search, select, selectContact, snapshot };
}
