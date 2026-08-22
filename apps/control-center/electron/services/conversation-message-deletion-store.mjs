import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const METADATA_DIRECTORY = ".suzu-lives";
const STORE_FILENAME = "conversation-deletions.json";
const STORE_VERSION = 1;
const MAX_DELETION_RECORDS = 10_000;
const MAX_MESSAGE_ID_LENGTH = 256;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export class ConversationMessageDeletionStoreError extends Error {
  constructor(message, { cause, code = "CONVERSATION_DELETION_STORE_ERROR" } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ConversationMessageDeletionStoreError";
    this.code = code;
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function requiredProjectRoot(value) {
  const root = clean(value);
  if (!root || !path.isAbsolute(root)) {
    throw new ConversationMessageDeletionStoreError("联系人工作目录无效。", { code: "WORKSPACE_REQUIRED" });
  }
  return path.resolve(root);
}

function requiredSessionId(value) {
  const sessionId = clean(value);
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new ConversationMessageDeletionStoreError("会话标识无效。", { code: "SESSION_REQUIRED" });
  }
  return sessionId;
}

function requiredEventSequence(value) {
  const eventSeq = Number(value);
  if (!Number.isSafeInteger(eventSeq) || eventSeq < 0) {
    throw new ConversationMessageDeletionStoreError("要删除的消息标识无效。", { code: "MESSAGE_DELETE_INPUT_INVALID" });
  }
  return eventSeq;
}

function recordTimestamp(value, now) {
  const candidate = clean(value);
  if (Number.isFinite(Date.parse(candidate))) return candidate;
  const date = now();
  const normalized = date instanceof Date ? date : new Date(date);
  return Number.isFinite(normalized.getTime()) ? normalized.toISOString() : new Date().toISOString();
}

function storePath(projectRoot) {
  return path.join(requiredProjectRoot(projectRoot), METADATA_DIRECTORY, STORE_FILENAME);
}

function normalizedRecord(value, now) {
  const source = plainObject(value);
  const eventSeq = requiredEventSequence(source.eventSeq);
  const messageId = clean(source.messageId);
  if (messageId.length > MAX_MESSAGE_ID_LENGTH) {
    throw new ConversationMessageDeletionStoreError("消息标识过长。", { code: "MESSAGE_DELETE_INPUT_INVALID" });
  }
  return Object.freeze({
    eventSeq,
    ...(messageId ? { messageId } : {}),
    deletedAt: recordTimestamp(source.deletedAt, now),
  });
}

function emptyDocument(sessionId) {
  return {
    version: STORE_VERSION,
    sessionId,
    messages: [],
  };
}

function normalizedDocument(value, sessionId, now) {
  if (value === null || value === undefined) return emptyDocument(sessionId);
  const source = plainObject(value);
  if (source.version !== STORE_VERSION || !Array.isArray(source.messages)) {
    throw new ConversationMessageDeletionStoreError("消息删除记录格式不受当前版本支持。", { code: "DELETION_STORE_INVALID" });
  }
  const storedSessionId = clean(source.sessionId);
  if (storedSessionId !== sessionId) {
    throw new ConversationMessageDeletionStoreError("消息删除记录不属于当前会话。", { code: "DELETION_STORE_SESSION_MISMATCH" });
  }
  if (source.messages.length > MAX_DELETION_RECORDS) {
    throw new ConversationMessageDeletionStoreError("消息删除记录数量超过安全上限。", { code: "DELETION_STORE_TOO_LARGE" });
  }
  const recordsBySequence = new Map();
  for (const value of source.messages) {
    const record = normalizedRecord(value, now);
    if (recordsBySequence.has(record.eventSeq)) {
      throw new ConversationMessageDeletionStoreError("消息删除记录存在重复项。", { code: "DELETION_STORE_INVALID" });
    }
    recordsBySequence.set(record.eventSeq, record);
  }
  return {
    version: STORE_VERSION,
    sessionId,
    messages: [...recordsBySequence.values()].sort((left, right) => left.eventSeq - right.eventSeq),
  };
}

async function readDocument(fsOps, target, sessionId, now) {
  let raw;
  try {
    raw = await fsOps.readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyDocument(sessionId);
    throw new ConversationMessageDeletionStoreError("无法读取消息删除记录。", {
      cause: error,
      code: "DELETION_STORE_READ_FAILED",
    });
  }
  try {
    return normalizedDocument(JSON.parse(raw), sessionId, now);
  } catch (error) {
    if (error instanceof ConversationMessageDeletionStoreError) throw error;
    throw new ConversationMessageDeletionStoreError("消息删除记录不是有效 JSON。", {
      cause: error,
      code: "DELETION_STORE_INVALID",
    });
  }
}

async function writeDocumentAtomic(fsOps, target, document) {
  const directory = path.dirname(target);
  await fsOps.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${STORE_FILENAME}.suzu-${randomUUID()}.tmp`);
  try {
    await fsOps.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await fsOps.rename(temporary, target);
  } catch (error) {
    await fsOps.unlink(temporary).catch(() => undefined);
    throw new ConversationMessageDeletionStoreError("无法保存消息删除记录。", {
      cause: error,
      code: "DELETION_STORE_WRITE_FAILED",
    });
  }
}

/**
 * Suzu-owned visibility state for deleted conversation entries.  It stays next
 * to the contact metadata rather than being appended to Agent Core's durable
 * session, so deleting a rendered message never changes the raw event log or
 * its storage encoding.
 */
export function createConversationMessageDeletionStore({ fsOps = fs, now = () => new Date() } = {}) {
  const list = async ({ projectRoot, sessionId } = {}) => {
    const root = requiredProjectRoot(projectRoot);
    const id = requiredSessionId(sessionId);
    const document = await readDocument(fsOps, storePath(root), id, now);
    return Object.freeze({
      entries: Object.freeze(document.messages.map((entry) => Object.freeze({ ...entry }))),
      revision: document.messages.map((entry) => `${entry.eventSeq}:${entry.deletedAt}`).join(","),
    });
  };

  const markDeleted = async ({ projectRoot, sessionId, eventSeq, messageId = "" } = {}) => {
    const root = requiredProjectRoot(projectRoot);
    const id = requiredSessionId(sessionId);
    const sequence = requiredEventSequence(eventSeq);
    const normalizedMessageId = clean(messageId);
    if (normalizedMessageId.length > MAX_MESSAGE_ID_LENGTH) {
      throw new ConversationMessageDeletionStoreError("消息标识过长。", { code: "MESSAGE_DELETE_INPUT_INVALID" });
    }
    const target = storePath(root);
    const document = await readDocument(fsOps, target, id, now);
    const existing = document.messages.find((entry) => entry.eventSeq === sequence) || null;
    if (existing) return Object.freeze({ added: false, entry: Object.freeze({ ...existing }) });
    if (document.messages.length >= MAX_DELETION_RECORDS) {
      throw new ConversationMessageDeletionStoreError("消息删除记录数量超过安全上限。", { code: "DELETION_STORE_TOO_LARGE" });
    }
    const entry = normalizedRecord({
      eventSeq: sequence,
      ...(normalizedMessageId ? { messageId: normalizedMessageId } : {}),
    }, now);
    const next = {
      ...document,
      messages: [...document.messages, entry].sort((left, right) => left.eventSeq - right.eventSeq),
    };
    await writeDocumentAtomic(fsOps, target, next);
    return Object.freeze({ added: true, entry });
  };

  return Object.freeze({ list, markDeleted });
}
