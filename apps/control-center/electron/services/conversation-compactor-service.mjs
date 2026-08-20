import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_SUZU_COMPACTION_PROMPT } from "@suzu-lives/suzu-agent-runtime/companion-compaction-prompt";

const MAX_PROMPT_LENGTH = 24_000;
const MAX_SUMMARY_LENGTH = 48_000;
const DEFAULT_TOKEN_THRESHOLD = 15_000;
const DEFAULT_RETAIN_TOKENS = 5_000;
const HISTORY_PAGE_SIZE = 600;

export class ConversationCompactorError extends Error {
  constructor(message, { cause, code = "AGENT_CONVERSATION_COMPACTOR_ERROR" } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ConversationCompactorError";
    this.code = code;
  }
}


function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function publicContact(value) {
  const source = plainObject(value);
  return { id: clean(source.id), name: clean(source.name) };
}

function timestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function positiveInteger(value, label) {
  const candidate = Number(value);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new ConversationCompactorError(`${label}必须是大于 0 的整数。`, { code: "INVALID_COMPACTOR_SETTING" });
  }
  return candidate;
}

function storedPositiveInteger(value, fallback) {
  const candidate = Number(value);
  return Number.isSafeInteger(candidate) && candidate > 0 ? candidate : fallback;
}

function storedPrompt(value) {
  return String(value ?? "").trim().slice(0, MAX_PROMPT_LENGTH);
}

function prompt(value) {
  const result = String(value ?? "").trim();
  if (result.length > MAX_PROMPT_LENGTH) {
    throw new ConversationCompactorError(`压缩提示词不能超过 ${MAX_PROMPT_LENGTH.toLocaleString("zh-CN")} 个字符。`, {
      code: "PROMPT_TOO_LONG",
    });
  }
  return result;
}

function normalizedSettings(value = {}) {
  const source = plainObject(value);
  const automatic = plainObject(source.automatic);
  const manual = plainObject(source.manual);
  return {
    version: 1,
    prompt: storedPrompt(source.prompt),
    automatic: {
      enabled: automatic.enabled === true,
      tokenThreshold: storedPositiveInteger(automatic.tokenThreshold, DEFAULT_TOKEN_THRESHOLD),
      retainTokens: storedPositiveInteger(automatic.retainTokens, DEFAULT_RETAIN_TOKENS),
    },
    manual: {
      retainTokens: storedPositiveInteger(manual.retainTokens, DEFAULT_RETAIN_TOKENS),
    },
    updatedAt: clean(source.updatedAt).slice(0, 80),
  };
}

function submittedSettings(value, saved, now) {
  const source = plainObject(value);
  let automatic = { ...normalizedSettings(saved).automatic };
  let manual = { ...normalizedSettings(saved).manual };
  if (Object.hasOwn(source, "automatic")) {
    if (!source.automatic || typeof source.automatic !== "object" || Array.isArray(source.automatic)) {
      throw new ConversationCompactorError("自动压缩设置无效。", { code: "INVALID_COMPACTOR_SETTING" });
    }
    const input = source.automatic;
    automatic = {
      enabled: Object.hasOwn(input, "enabled") ? input.enabled === true : automatic.enabled,
      tokenThreshold: Object.hasOwn(input, "tokenThreshold")
        ? positiveInteger(input.tokenThreshold, "Token 触发阈值")
        : automatic.tokenThreshold,
      retainTokens: Object.hasOwn(input, "retainTokens")
        ? positiveInteger(input.retainTokens, "自动压缩保留 Token")
        : automatic.retainTokens,
    };
  }
  if (Object.hasOwn(source, "manual")) {
    if (!source.manual || typeof source.manual !== "object" || Array.isArray(source.manual)) {
      throw new ConversationCompactorError("手动压缩设置无效。", { code: "INVALID_COMPACTOR_SETTING" });
    }
    const input = source.manual;
    manual = {
      retainTokens: Object.hasOwn(input, "retainTokens")
        ? positiveInteger(input.retainTokens, "手动压缩保留 Token")
        : manual.retainTokens,
    };
  }
  if (automatic.retainTokens >= automatic.tokenThreshold) {
    throw new ConversationCompactorError("自动压缩保留 Token 必须小于触发阈值。", { code: "INVALID_COMPACTOR_SETTING" });
  }
  return {
    version: 1,
    prompt: Object.hasOwn(source, "prompt") ? prompt(source.prompt) : storedPrompt(saved.prompt),
    automatic,
    manual,
    updatedAt: timestamp(now),
  };
}

function displaySettings(value) {
  const saved = normalizedSettings(value);
  return {
    ...saved,
    prompt: saved.prompt || DEFAULT_SUZU_COMPACTION_PROMPT,
  };
}

function settingsPath(session) {
  const root = clean(session?.projectRoot);
  if (!root || !path.isAbsolute(root)) {
    throw new ConversationCompactorError("无法确认这位联系人的 Agent 工作目录。", { code: "WORKSPACE_REQUIRED" });
  }
  return path.join(path.resolve(root), ".suzu-lives", "compactor.json");
}

async function readSettings(fsOps, target) {
  try {
    return normalizedSettings(JSON.parse(await fsOps.readFile(target, "utf8")));
  } catch {
    return normalizedSettings();
  }
}

async function writeJsonAtomic(fsOps, target, value) {
  await fsOps.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.suzu-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  await fsOps.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await fsOps.rename(temporary, target);
  } catch (error) {
    await fsOps.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function eventFor(entry) {
  return plainObject(plainObject(entry).event);
}

function summaryText(value) {
  const text = (Array.isArray(value) ? value : [])
    .filter((block) => plainObject(block).type === "text")
    .map((block) => String(plainObject(block).text ?? ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  return text.length > MAX_SUMMARY_LENGTH ? `${text.slice(0, MAX_SUMMARY_LENGTH)}…` : text;
}

function isoTime(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? new Date(number).toISOString() : "";
}

function isRawConversationEvent(event) {
  const source = plainObject(event);
  if (source.surfaceOp !== "append") return false;
  if (source.type === "assistant/message") {
    return Array.isArray(plainObject(source.data).message?.content)
      && plainObject(source.data).message.content.length > 0;
  }
  if (source.type !== "user/message") return false;
  const data = plainObject(source.data);
  const nested = plainObject(data.message);
  const message = Object.keys(nested).length ? nested : data;
  return clean(plainObject(message.source).kind) === "user";
}

function compactionDiagnostics(entries) {
  const attempts = new Map();
  let latest = null;
  let latestSummary = "";
  let rawMessages = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const event = eventFor(entry);
    if (isRawConversationEvent(event)) rawMessages += 1;
    const data = plainObject(event.data);
    const compactionId = clean(data.compactionId);
    if (event.type === "compaction/start" && compactionId) {
      const record = {
        compactionId,
        status: "running",
        startedAt: isoTime(event.time),
        completedAt: "",
        messagesCompacted: 0,
        shadowedTokenCount: 0,
        error: "",
      };
      attempts.set(compactionId, record);
      latest = record;
      continue;
    }
    if (event.type === "compaction/summary" && compactionId) {
      const record = attempts.get(compactionId) || {
        compactionId,
        status: "running",
        startedAt: "",
        completedAt: "",
        messagesCompacted: 0,
        shadowedTokenCount: 0,
        error: "",
      };
      record.messagesCompacted = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : 0;
      record.shadowedTokenCount = Number(data.shadowedTokenCount) || 0;
      attempts.set(compactionId, record);
      latest = record;
      latestSummary = summaryText(data.summary) || latestSummary;
      continue;
    }
    if (event.type === "compaction/end" && compactionId) {
      const record = attempts.get(compactionId) || {
        compactionId,
        status: "running",
        startedAt: "",
        completedAt: "",
        messagesCompacted: 0,
        shadowedTokenCount: 0,
        error: "",
      };
      record.error = clean(data.error);
      record.status = record.error ? "failed" : "completed";
      record.completedAt = isoTime(event.time);
      attempts.set(compactionId, record);
      latest = record;
    }
  }
  return {
    hasTranscript: rawMessages > 0,
    latestSummary,
    lastRun: latest ? { ...latest } : null,
  };
}

function scopeKey(scope) {
  const root = clean(scope?.session?.projectRoot).replaceAll("\\", "/").toLowerCase();
  return `${root}\u0000${clean(scope?.session?.id)}`;
}

/**
 * Desktop settings and diagnostics for Suzu's native Agent Core compaction module.
 * The service deliberately does not read, import, or mutate external transcripts.
 */
export function createConversationCompactorService({
  reader,
  runtime,
  fsOps = fs,
  now = () => new Date(),
} = {}) {
  if (typeof reader?.compactorSnapshot !== "function"
    || typeof reader?.resolveCompactorSession !== "function"
    || typeof reader?.resolveCompactorSessionForRuntime !== "function") {
    throw new ConversationCompactorError("Agent 记忆压缩器需要联系人会话读取服务。", { code: "READER_REQUIRED" });
  }
  if (typeof runtime?.history !== "function" || typeof runtime?.runCompaction !== "function") {
    throw new ConversationCompactorError("Agent 记忆压缩器需要原生会话运行时。", { code: "RUNTIME_REQUIRED" });
  }
  if (!fsOps?.mkdir || !fsOps?.readFile || !fsOps?.rename || !fsOps?.unlink || !fsOps?.writeFile) {
    throw new ConversationCompactorError("Agent 记忆压缩器文件接口无效。", { code: "FILESYSTEM_REQUIRED" });
  }

  const activeRuns = new Map();

  const selectedScope = async ({ contactId = "" } = {}) => {
    const source = await reader.compactorSnapshot();
    const catalog = (Array.isArray(source?.contacts) ? source.contacts : [])
      .map((contact) => ({
        ...publicContact(contact),
        sessions: Array.isArray(contact?.sessions) ? contact.sessions : [],
      }))
      .filter((contact) => contact.id);
    const requested = clean(contactId);
    const active = clean(source?.activeContact?.id);
    const contact = catalog.find((item) => item.id === requested)
      || catalog.find((item) => item.id === active)
      || catalog[0]
      || null;
    const contacts = catalog.map((item) => ({
      id: item.id,
      name: item.name,
      hasConversation: item.sessions.length > 0,
    }));
    if (!contact) return { contacts, contact: null, session: null, source };
    const session = await reader.resolveCompactorSession({ contactId: contact.id });
    return { contacts, contact: publicContact(contact), session, source };
  };

  const historyFor = async (scope) => {
    try {
      return await runtime.history({
        sessionId: scope.session.id,
        contactId: scope.contact.id,
        cwd: scope.session.projectRoot,
        maxMessages: HISTORY_PAGE_SIZE,
      });
    } catch (error) {
      return { events: [], hasMore: false, error: clean(error?.message) || "无法读取 Agent 会话历史。" };
    }
  };

  const snapshot = async ({ contactId = "" } = {}) => {
    const selected = await selectedScope({ contactId });
    const activeContact = publicContact(selected.source?.activeContact);
    if (!selected.session || !selected.contact) {
      return {
        status: clean(selected.source?.status) || "missing",
        runtime: "agent-core",
        activeContact,
        contacts: selected.contacts,
        selectedContactId: "",
        selectedContact: null,
        selectedConversation: null,
        settings: displaySettings(),
        lastRun: null,
        latestSummary: "",
      };
    }
    const configPath = settingsPath(selected.session);
    const [settings, history] = await Promise.all([
      readSettings(fsOps, configPath),
      historyFor(selected),
    ]);
    const diagnostics = compactionDiagnostics(history.events);
    return {
      status: clean(selected.source?.status) || "ready",
      runtime: "agent-core",
      activeContact,
      contacts: selected.contacts,
      selectedContactId: selected.contact.id,
      selectedContact: selected.contact,
      selectedConversation: {
        contactId: selected.contact.id,
        contactName: selected.contact.name || "联系人",
        title: "固定对话",
        hasTranscript: diagnostics.hasTranscript,
      },
      settings: displaySettings(settings),
      lastRun: diagnostics.lastRun,
      latestSummary: diagnostics.latestSummary,
      ...(clean(history.error) ? { historyError: clean(history.error) } : {}),
    };
  };

  const scopeFor = async ({ contactId = "" } = {}) => {
    const selected = await selectedScope({ contactId });
    if (!selected.session || !selected.contact) {
      throw new ConversationCompactorError("请先选择要整理对话的联系人。", { code: "CONTACT_REQUIRED" });
    }
    return selected;
  };

  const queueRun = (scope, operation) => {
    const key = scopeKey(scope);
    const previous = activeRuns.get(key) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    activeRuns.set(key, current);
    return current.finally(() => {
      if (activeRuns.get(key) === current) activeRuns.delete(key);
    });
  };

  const save = async ({ contactId = "", ...value } = {}) => {
    const scope = await scopeFor({ contactId });
    const configPath = settingsPath(scope.session);
    const saved = await readSettings(fsOps, configPath);
    const next = submittedSettings(value, saved, now);
    await writeJsonAtomic(fsOps, configPath, next);
    return snapshot({ contactId: scope.contact.id });
  };

  const run = async ({ contactId = "", manual, retainTokens } = {}) => {
    const scope = await scopeFor({ contactId });
    const before = await historyFor(scope);
    const beforeDiagnostics = compactionDiagnostics(before.events);
    if (!beforeDiagnostics.hasTranscript) {
      throw new ConversationCompactorError("当前会话还没有可压缩的聊天记录。", { code: "NO_COMPACTABLE_HISTORY" });
    }
    const configPath = settingsPath(scope.session);
    const saved = await readSettings(fsOps, configPath);
    const manualPatch = manual === undefined && retainTokens === undefined
      ? undefined
      : manual === undefined
        ? { retainTokens }
        : manual;
    const next = manualPatch === undefined
      ? saved
      : submittedSettings({ manual: manualPatch }, saved, now);
    if (next !== saved) await writeJsonAtomic(fsOps, configPath, next);
    const result = await queueRun(scope, async () => runtime.runCompaction({
      sessionId: scope.session.id,
      contactId: scope.contact.id,
      cwd: scope.session.projectRoot,
    }));
    if (plainObject(result).completed !== true || !clean(result.compactionId)) {
      throw new ConversationCompactorError("Suzu Agent 没有写入可确认的压缩记录；当前对话可能没有可压缩的旧内容。", {
        code: "AGENT_COMPACTION_NOT_COMPLETED",
      });
    }
    const completed = await snapshot({ contactId: scope.contact.id });
    const lastRun = plainObject(completed.lastRun);
    if (lastRun.status !== "completed" || clean(lastRun.compactionId) !== clean(result.compactionId)) {
      throw new ConversationCompactorError("Suzu Agent 已返回压缩完成，但会话历史中没有对应的已完成记录。", {
        code: "AGENT_COMPACTION_RECORD_MISSING",
      });
    }
    return completed;
  };

  const settingsForRuntime = async ({ sessionId, projectRoot = "" } = {}) => {
    const session = await reader.resolveCompactorSessionForRuntime({ sessionId, projectRoot });
    const settings = await readSettings(fsOps, settingsPath(session));
    return {
      available: true,
      prompt: settings.prompt || DEFAULT_SUZU_COMPACTION_PROMPT,
      automatic: { ...settings.automatic },
      manual: { ...settings.manual },
    };
  };

  return Object.freeze({
    run,
    save,
    settingsForRuntime,
    snapshot,
  });
}
