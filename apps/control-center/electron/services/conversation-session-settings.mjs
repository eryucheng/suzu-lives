import fs from "node:fs/promises";
import path from "node:path";

import { resolveAgentConversationDataRoot } from "@suzu-lives/agent-registry";

const MAX_NOTE_LENGTH = 2_000;

export class ConversationSessionSettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConversationSessionSettingsError";
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function normalizedEntry(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    version: 1,
    note: String(raw.note ?? "").trim().slice(0, MAX_NOTE_LENGTH),
    updatedAt: clean(raw.updatedAt).slice(0, 80),
  };
}

async function readJson(fsOps, target) {
  try { return normalizedEntry(JSON.parse(await fsOps.readFile(target, "utf8"))); }
  catch { return normalizedEntry(); }
}

async function writeJsonAtomic(fsOps, target, value) {
  await fsOps.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.suzu-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  await fsOps.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try { await fsOps.rename(temporary, target); }
  catch (error) { await fsOps.unlink(temporary).catch(() => undefined); throw error; }
}

function sessionDirectory(dataRoot, session) {
  try {
    return resolveAgentConversationDataRoot({
      dataRoot,
      projectRoot: clean(session?.projectRoot),
      sessionId: clean(session?.id),
    });
  } catch {
    throw new ConversationSessionSettingsError("Claude 会话或项目目录无效。 ");
  }
}

function timestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

/** Local UI data lives below the owning Agent and Claude session. */
export function createConversationSessionSettingsService({
  dataRoot,
  fsOps = fs,
  now = () => new Date(),
  reader,
} = {}) {
  if (!reader?.resolveSession) throw new ConversationSessionSettingsError("会话设置需要原生 Claude 会话读取服务。 ");
  if (!clean(dataRoot) || !path.isAbsolute(clean(dataRoot))) throw new ConversationSessionSettingsError("无法定位 Suzu Lives 软件数据目录。 ");

  const snapshot = async ({ sessionId } = {}) => {
    const session = await reader.resolveSession(sessionId);
    const directory = sessionDirectory(dataRoot, session);
    const entry = await readJson(fsOps, path.join(directory, "session.json"));
    return { sessionId: session.id, note: entry.note, updatedAt: entry.updatedAt };
  };

  const save = async ({ sessionId, note } = {}) => {
    const session = await reader.resolveSession(sessionId);
    const directory = sessionDirectory(dataRoot, session);
    const entry = {
      version: 1,
      note: String(note ?? "").trim().slice(0, MAX_NOTE_LENGTH),
      updatedAt: timestamp(now),
    };
    await writeJsonAtomic(fsOps, path.join(directory, "session.json"), entry);
    return { sessionId: session.id, note: entry.note, updatedAt: entry.updatedAt };
  };

  const mediaDirectory = async ({ sessionId } = {}) => {
    const session = await reader.resolveSession(sessionId);
    const directory = path.join(sessionDirectory(dataRoot, session), "attachments");
    await fsOps.mkdir(directory, { recursive: true });
    return { sessionId: session.id, directory };
  };

  return { mediaDirectory, save, snapshot };
}
