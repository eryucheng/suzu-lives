import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildDisplayMessages, JsonlTail, readTranscriptWindow, searchTranscript } from "@suzu-lives/conversation-reader";
import { DEFAULT_CLAUDE_PERMISSION_MODE, normalizeClaudePermissionMode } from "./claude-permission-mode.mjs";

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

function projectScopeKey(value) {
  const source = clean(value);
  if (!source || !path.isAbsolute(source)) return "";
  const resolved = path.resolve(source);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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

/** Returns every legacy and current Claude transcript directory for one project. */
export function claudeProjectDirectoryCandidates({ projectRoot, homeDirectory = os.homedir() } = {}) {
  const root = clean(projectRoot);
  if (!root) return [];
  const projectsRoot = path.join(path.resolve(clean(homeDirectory) || os.homedir()), ".claude", "projects");
  return candidateProjectKeys(path.resolve(root)).map((key) => path.join(projectsRoot, key));
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
    hidden: contact.hidden === true,
    muted: contact.muted === true,
    pinned: contact.pinned === true,
    unread: contact.unread === true,
    approvalMode: normalizeClaudePermissionMode(contact.approvalMode),
    longTermMemoryEnabled: contact.longTermMemoryEnabled !== false,
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
  const candidates = claudeProjectDirectoryCandidates({ projectRoot: absoluteRoot, homeDirectory });
  for (const directory of candidates) {
    if (await directoryExists(fsOps, directory)) {
      return { status: "ready", projectRoot: absoluteRoot, projectDir: directory, exists: true };
    }
  }
  return {
    status: "ready",
    projectRoot: absoluteRoot,
    projectDir: candidates[0] || path.join(path.resolve(homeDirectory), ".claude", "projects", encodeClaudeProjectKey(absoluteRoot)),
    exists: false,
  };
}

export function createConversationReader({
  contactProjectsService = null,
  onContactCreated = null,
  settingsService,
  fsOps = fs,
  homeDirectory = os.homedir(),
} = {}) {
  if (!settingsService?.load) throw new ConversationReaderError("会话读取需要软件设置服务。");

  let activePath = "";
  let activeProjectRoot = "";
  let selectionVersion = 0;
  let tail = null;
  const drafts = new Map();
  const summaries = new Map();

  const markSelectionChanged = () => {
    selectionVersion += 1;
  };

  const listSessions = async (location, { includeSessionId = "" } = {}) => {
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
    const ordered = candidates.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
    const visible = ordered.slice(0, MAX_SESSION_FILES);
    const fixedId = clean(includeSessionId);
    const fixed = isSessionId(fixedId) ? ordered.find((session) => session.id === fixedId) || null : null;
    if (fixed && !visible.some((session) => session.id === fixed.id)) visible.push(fixed);
    return Promise.all(visible.map(async ({ id, filePath, stat }) => {
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
      selectionVersion += 1;
    }
    const activeContactSessionId = clean(contacts.activeContact?.sessionId);
    const native = await listSessions(location, { includeSessionId: activeContactSessionId });
    const fixedNative = native.filter((session) => session.id === activeContactSessionId);
    for (const session of fixedNative) drafts.delete(session.id);
    const localDrafts = [...drafts.values()]
      .filter((session) => session.projectRoot === location.projectRoot && session.id === activeContactSessionId)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return {
      settings,
      ...location,
      contacts: Array.isArray(contacts.contacts) ? contacts.contacts.map(publicContact).filter(Boolean) : [],
      contactsRoot: clean(contacts.contactsRoot),
      activeContact: publicContact(contacts.activeContact),
      activeContactSessionId,
      preferredContactId: clean(contacts.preferredContact?.id),
      sessions: [...localDrafts, ...fixedNative],
    };
  };

  const currentSession = (currentCatalog) => {
    const sessionId = clean(currentCatalog?.activeContactSessionId);
    return isSessionId(sessionId)
      ? currentCatalog.sessions.find((session) => session.id === sessionId) || null
      : null;
  };

  const createDraft = async (providedCatalog = null) => {
    const currentCatalog = providedCatalog || await catalog();
    if (!currentCatalog.projectRoot) throw new ConversationReaderError("请先选择 Claude 工作目录。");
    const id = clean(currentCatalog.activeContactSessionId);
    if (!isSessionId(id)) throw new ConversationReaderError("当前联系人尚未绑定 Claude 会话。 ");
    const existing = currentCatalog.sessions.find((session) => session.id === id) || null;
    if (existing) {
      markSelectionChanged();
      return existing;
    }
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
    markSelectionChanged();
    return draft;
  };

  const context = async () => {
    const currentCatalog = await catalog();
    const contactsVersion = JSON.stringify(currentCatalog.contacts.map((contact) => [
      clean(contact?.id),
      clean(contact?.name),
      clean(contact?.agentId),
      contact?.hidden === true,
      contact?.pinned === true,
      contact?.unread === true,
      contact?.muted === true,
      normalizeClaudePermissionMode(contact?.approvalMode),
      contact?.longTermMemoryEnabled !== false,
    ]));
    if (!currentCatalog.projectRoot) {
      return {
        status: "missing",
        settings: currentCatalog.settings,
        contacts: currentCatalog.contacts,
        contactsRoot: currentCatalog.contactsRoot,
        activeContact: currentCatalog.activeContact,
        preferredContactId: currentCatalog.preferredContactId,
        projectRoot: "",
        projectDir: "",
        sessions: [],
        session: null,
        sessionId: "",
        fileName: "",
        filePath: "",
        records: [],
        version: `missing:${selectionVersion}:${contactsVersion}`,
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
        preferredContactId: currentCatalog.preferredContactId,
        projectRoot: currentCatalog.projectRoot,
        projectDir: currentCatalog.projectDir,
        sessions: currentCatalog.sessions,
        session,
        sessionId: session?.id || "",
        fileName: "",
        filePath: "",
        records: [],
        version: `${selectionVersion}:${session?.id || "none"}:0:${catalogVersion}:${contactsVersion}`,
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
        preferredContactId: currentCatalog.preferredContactId,
        projectRoot: currentCatalog.projectRoot,
        projectDir: currentCatalog.projectDir,
        sessions: currentCatalog.sessions,
        session,
        sessionId: session.id,
        fileName: path.basename(session.filePath),
        filePath: session.filePath,
        records: [],
        version: `${selectionVersion}:${session.id}:missing:${catalogVersion}:${contactsVersion}`,
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
      preferredContactId: currentCatalog.preferredContactId,
      projectRoot: currentCatalog.projectRoot,
      projectDir: currentCatalog.projectDir,
      sessions: currentCatalog.sessions,
      session,
      sessionId: session.id,
      fileName: path.basename(session.filePath),
      filePath: session.filePath,
      records: [...tail.records],
      version: `${selectionVersion}:${session.id}:${tail.version}:${catalogVersion}:${contactsVersion}`,
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
      preferredContactId: current.preferredContactId,
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

  const create = async () => { throw new ConversationReaderError("每个联系人只保留一个 Claude 会话；如需新对话，请新建联系人。 "); };

  const createContact = async ({ name } = {}) => {
    if (!contactProjectsService?.create) throw new ConversationReaderError("当前版本未接入联系人项目服务。 ");
    const created = await contactProjectsService.create({ name });
    if (typeof onContactCreated === "function" && created?.createdContact) {
      // A contact remains usable even when an optional default Skill cannot be
      // written (for example, a user-owned conflicting Skill already exists).
      await Promise.resolve(onContactCreated(created.createdContact)).catch(() => undefined);
    }
    return snapshot();
  };

  const selectContact = async ({ id } = {}) => {
    if (!contactProjectsService?.select) throw new ConversationReaderError("当前版本未接入联系人项目服务。 ");
    const selected = await contactProjectsService.select({ id });
    if (selected?.activeContact?.unread === true && contactProjectsService.updatePresentation) {
      await contactProjectsService.updatePresentation({ id: selected.activeContact.id, unread: false });
    }
    return snapshot();
  };

  const setPreferredContact = async ({ id } = {}) => {
    if (!contactProjectsService?.setPreferred) throw new ConversationReaderError("当前版本未接入联系人项目服务。 ");
    await contactProjectsService.setPreferred({ id });
    return snapshot();
  };

  const renameContact = async ({ id, name } = {}) => {
    if (!contactProjectsService?.rename) throw new ConversationReaderError("当前版本未接入联系人项目服务。 ");
    await contactProjectsService.rename({ id, name });
    return snapshot();
  };

  const updateContactPresentation = async (value = {}) => {
    if (!contactProjectsService?.updatePresentation) throw new ConversationReaderError("当前版本未接入联系人项目服务。 ");
    await contactProjectsService.updatePresentation(value);
    return snapshot();
  };

  const removeContact = async (value = {}) => {
    if (!contactProjectsService?.remove) throw new ConversationReaderError("当前版本未接入联系人项目服务。 ");
    await contactProjectsService.remove(value);
    return snapshot();
  };

  /** Lists every contact's one fixed Claude session without changing the active chat. */
  const compactorSnapshot = async () => {
    if (!contactProjectsService?.snapshot) throw new ConversationReaderError("当前版本未接入联系人项目服务。 ");
    const contactsSnapshot = await contactProjectsService.snapshot();
    const contacts = Array.isArray(contactsSnapshot?.contacts) ? contactsSnapshot.contacts : [];
    const catalog = [];
    for (const contact of contacts) {
      const projectRoot = clean(contact?.projectRoot);
      if (!projectRoot) continue;
      const location = await locateClaudeProjectDirectory({
        projectRoot,
        fsOps,
        homeDirectory,
      });
      const fixedSessionId = clean(contact?.sessionId);
      const sessions = isSessionId(fixedSessionId)
        ? (await listSessions(location, { includeSessionId: fixedSessionId }))
          .filter((session) => session.id === fixedSessionId)
        : [];
      catalog.push({
        ...publicContact(contact),
        sessions: sessions.map(publicSession),
      });
    }
    return {
      status: clean(contactsSnapshot?.status) || "missing",
      activeContact: publicContact(contactsSnapshot?.activeContact),
      preferredContactId: clean(contactsSnapshot?.preferredContact?.id),
      activeSessionId: clean(contactsSnapshot?.activeContact?.sessionId),
      contacts: catalog,
    };
  };

  /**
   * Resolves a persisted Claude session from an owned contact project without
   * accepting a renderer-provided project path or changing the active contact.
   */
  const resolveCompactorSession = async ({ contactId } = {}) => {
    if (!contactProjectsService?.snapshot) throw new ConversationReaderError("当前版本未接入联系人项目服务。 ");
    const id = clean(contactId);
    const contactsSnapshot = await contactProjectsService.snapshot();
    const contact = Array.isArray(contactsSnapshot?.contacts)
      ? contactsSnapshot.contacts.find((item) => clean(item?.id) === id) || null
      : null;
    if (!contact?.projectRoot) throw new ConversationReaderError("所选联系人不存在或无法读取。 ");
    const location = await locateClaudeProjectDirectory({
      projectRoot: contact.projectRoot,
      fsOps,
      homeDirectory,
    });
    const fixedSessionId = clean(contact.sessionId);
    if (!isSessionId(fixedSessionId)) throw new ConversationReaderError("所选联系人尚未绑定 Claude 会话。 ");
    const session = (await listSessions(location, { includeSessionId: fixedSessionId }))
      .find((item) => item.id === fixedSessionId) || null;
    if (!session?.filePath) throw new ConversationReaderError("所选 Claude 会话不存在或还没有可压缩的聊天记录。 ");
    return {
      id: session.id,
      projectRoot: location.projectRoot,
      transcriptPath: session.filePath,
      hasTranscript: true,
      contact: publicContact(contact),
    };
  };

  /**
   * Resolves a compactor scope emitted by the local chat runtime. The runtime
   * still has to match one owned contact project; it cannot point compaction at
   * an arbitrary local transcript.
   */
  const resolveCompactorSessionForRuntime = async ({ sessionId, projectRoot } = {}) => {
    if (!contactProjectsService?.snapshot) throw new ConversationReaderError("当前版本未接入联系人项目服务。 ");
    const nativeSessionId = clean(sessionId);
    const runtimeProject = projectScopeKey(projectRoot);
    if (!isSessionId(nativeSessionId) || !runtimeProject) {
      throw new ConversationReaderError("自动压缩范围无效。 ");
    }
    const contactsSnapshot = await contactProjectsService.snapshot();
    const contact = Array.isArray(contactsSnapshot?.contacts)
      ? contactsSnapshot.contacts.find((item) => (
        projectScopeKey(item?.projectRoot) === runtimeProject
        && clean(item?.sessionId) === nativeSessionId
      )) || null
      : null;
    if (!contact?.id) throw new ConversationReaderError("自动压缩目标不属于任何联系人。 ");
    return resolveCompactorSession({ contactId: contact.id });
  };

  const ensureActiveSession = async () => {
    const currentCatalog = await catalog();
    const session = currentSession(currentCatalog) || await createDraft(currentCatalog);
    return {
      id: session.id,
      projectRoot: currentCatalog.projectRoot,
      hasTranscript: Boolean(session.filePath),
      approvalMode: normalizeClaudePermissionMode(currentCatalog.activeContact?.approvalMode),
    };
  };

  /** Resolve the fixed conversation owned by a contact without changing the active contact. */
  const resolveContactSession = async (contactId) => {
    if (!contactProjectsService?.snapshot) throw new ConversationReaderError("当前版本未接入联系人项目服务。 ");
    const id = clean(contactId);
    const contacts = await contactProjectsService.snapshot();
    const contact = Array.isArray(contacts?.contacts)
      ? contacts.contacts.find((item) => clean(item?.id) === id) || null
      : null;
    if (!contact?.projectRoot) throw new ConversationReaderError("所选联系人不存在或无法读取。 ");
    const location = await locateClaudeProjectDirectory({
      projectRoot: contact.projectRoot,
      fsOps,
      homeDirectory,
    });
    const sessionId = clean(contact.sessionId);
    if (!isSessionId(sessionId)) throw new ConversationReaderError("所选联系人尚未绑定 Claude 会话。 ");
    const sessions = await listSessions(location, { includeSessionId: sessionId });
    const session = sessions.find((item) => item.id === sessionId) || null;
    return {
      contactId: contact.id,
      id: sessionId,
      projectRoot: location.projectRoot,
      hasTranscript: Boolean(session?.filePath),
      approvalMode: normalizeClaudePermissionMode(contact.approvalMode),
    };
  };

  /** Maps an internal runtime session back to its owning fixed contact. */
  const contactIdForSession = async ({ sessionId, projectRoot } = {}) => {
    if (!contactProjectsService?.snapshot) return "";
    const nativeSessionId = clean(sessionId);
    const scope = projectScopeKey(projectRoot);
    if (!isSessionId(nativeSessionId) || !scope) return "";
    const contacts = await contactProjectsService.snapshot();
    const contact = Array.isArray(contacts?.contacts)
      ? contacts.contacts.find((item) => (
        clean(item?.sessionId) === nativeSessionId
        && projectScopeKey(item?.projectRoot) === scope
      )) || null
      : null;
    return clean(contact?.id);
  };

  const approvalModeForSession = async ({ sessionId, projectRoot } = {}) => {
    if (!contactProjectsService?.snapshot) return DEFAULT_CLAUDE_PERMISSION_MODE;
    const nativeSessionId = clean(sessionId);
    const scope = projectScopeKey(projectRoot);
    if (!isSessionId(nativeSessionId) || !scope) return DEFAULT_CLAUDE_PERMISSION_MODE;
    const contacts = await contactProjectsService.snapshot();
    const contact = Array.isArray(contacts?.contacts)
      ? contacts.contacts.find((item) => (
        clean(item?.sessionId) === nativeSessionId
        && projectScopeKey(item?.projectRoot) === scope
      )) || null
      : null;
    return normalizeClaudePermissionMode(contact?.approvalMode);
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
      throw new ConversationReaderError("当前联系人没有可定位的聊天记录。");
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

  const updateContactApprovalMode = async (value = {}) => {
    if (!contactProjectsService?.updateApprovalMode) throw new ConversationReaderError("当前版本未接入联系人审批模式服务。 ");
    await contactProjectsService.updateApprovalMode(value);
    return snapshot();
  };

  const updateContactLongTermMemoryEnabled = async (value = {}) => {
    if (!contactProjectsService?.updateLongTermMemoryEnabled) throw new ConversationReaderError("当前版本未接入联系人长期记忆服务。 ");
    await contactProjectsService.updateLongTermMemoryEnabled(value);
    return snapshot();
  };

  return { approvalModeForSession, compactorSnapshot, contactIdForSession, context, create, createContact, ensureActiveSession, focus, removeContact, renameContact, resolveCompactorSession, resolveCompactorSessionForRuntime, resolveContactSession, search, selectContact, setPreferredContact, snapshot, updateContactApprovalMode, updateContactLongTermMemoryEnabled, updateContactPresentation };
}
