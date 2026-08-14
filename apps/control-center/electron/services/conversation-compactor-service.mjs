import fs from "node:fs/promises";
import path from "node:path";

import {
  resolveAgentConversationDataRoot,
  resolveAgentDataRoot,
  stableAgentId,
} from "@suzu-lives/agent-registry";
import {
  DEFAULT_COMPACTION_RULES,
  chooseTokenTailCompactionPlan,
  createClaudeCliGenerator,
  importConversationHistory,
  parseJsonlText,
  reconstructLogicalContext,
  runCompaction,
} from "@suzu-lives/memory-compactor";
import {
  createScheduleTask,
  listScheduleTasks,
  removeScheduleTask,
} from "@suzu-lives/task-scheduler";

const MAX_PROMPT_LENGTH = 24_000;
const MAX_SUMMARY_LENGTH = 48_000;
const MAX_WARNING_LENGTH = 600;
const DEFAULT_AUTOMATIC_TIME = "09:00";
const AUTOMATIC_TRIGGERS = new Set(["time", "token"]);
const COMPACTOR_OPERATION = "conversation-compactor";

export class ConversationCompactorError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConversationCompactorError";
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function timestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function prompt(value) {
  const result = String(value ?? "").trim();
  if (result.length > MAX_PROMPT_LENGTH) {
    throw new ConversationCompactorError(`压缩提示词不能超过 ${MAX_PROMPT_LENGTH} 个字符。`);
  }
  return result;
}

function storedPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new ConversationCompactorError(`${label}必须是大于 0 的整数。`);
  }
  return number;
}

function storedTime(value) {
  const source = clean(value);
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(source) ? source : DEFAULT_AUTOMATIC_TIME;
}

function timeOfDay(value) {
  const source = clean(value);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(source)) {
    throw new ConversationCompactorError("固定压缩时间无效。 ");
  }
  return source;
}

function storedTrigger(value) {
  const source = clean(value).toLowerCase();
  return AUTOMATIC_TRIGGERS.has(source) ? source : "token";
}

function automaticTrigger(value) {
  const source = clean(value).toLowerCase();
  if (!AUTOMATIC_TRIGGERS.has(source)) {
    throw new ConversationCompactorError("自动压缩触发方式无效。 ");
  }
  return source;
}

function booleanSetting(value, label) {
  if (typeof value !== "boolean") throw new ConversationCompactorError(`${label}无效。 `);
  return value;
}

function normalizedSettings(value) {
  const source = plainObject(value);
  const automatic = plainObject(source.automatic);
  const manual = plainObject(source.manual);
  const defaultRetainTokens = DEFAULT_COMPACTION_RULES.recentRawTokensToKeep;
  return {
    version: 2,
    prompt: String(source.prompt ?? "").trim().slice(0, MAX_PROMPT_LENGTH),
    automatic: {
      enabled: automatic.enabled === true,
      trigger: storedTrigger(automatic.trigger),
      time: storedTime(automatic.time),
      tokenThreshold: storedPositiveInteger(
        automatic.tokenThreshold,
        DEFAULT_COMPACTION_RULES.contextTokensTrigger,
      ),
      retainTokens: storedPositiveInteger(automatic.retainTokens, defaultRetainTokens),
    },
    manual: {
      retainTokens: storedPositiveInteger(manual.retainTokens, defaultRetainTokens),
    },
    updatedAt: clean(source.updatedAt).slice(0, 80),
  };
}

function submittedSettings(value, saved, now) {
  const source = plainObject(value);
  let automatic = saved.automatic;
  let manual = saved.manual;
  if (Object.hasOwn(source, "automatic")) {
    if (!isPlainObject(source.automatic)) throw new ConversationCompactorError("自动压缩设置无效。 ");
    const input = source.automatic;
    automatic = {
      enabled: Object.hasOwn(input, "enabled") ? booleanSetting(input.enabled, "自动压缩开关") : saved.automatic.enabled,
      trigger: Object.hasOwn(input, "trigger") ? automaticTrigger(input.trigger) : saved.automatic.trigger,
      time: Object.hasOwn(input, "time") ? timeOfDay(input.time) : saved.automatic.time,
      tokenThreshold: Object.hasOwn(input, "tokenThreshold")
        ? positiveInteger(input.tokenThreshold, "Token 触发阈值")
        : saved.automatic.tokenThreshold,
      retainTokens: Object.hasOwn(input, "retainTokens")
        ? positiveInteger(input.retainTokens, "自动压缩保留 Token")
        : saved.automatic.retainTokens,
    };
  }
  if (Object.hasOwn(source, "manual")) {
    if (!isPlainObject(source.manual)) throw new ConversationCompactorError("手动压缩设置无效。 ");
    const input = source.manual;
    manual = {
      retainTokens: Object.hasOwn(input, "retainTokens")
        ? positiveInteger(input.retainTokens, "手动压缩保留 Token")
        : saved.manual.retainTokens,
    };
  }
  return {
    version: 2,
    prompt: Object.hasOwn(source, "prompt") ? prompt(source.prompt) : saved.prompt,
    automatic,
    manual,
    updatedAt: timestamp(now),
  };
}

async function readJson(fsOps, target) {
  try {
    return normalizedSettings(JSON.parse(await fsOps.readFile(target, "utf8")));
  } catch {
    return normalizedSettings();
  }
}

async function readText(fsOps, target, maximum = MAX_SUMMARY_LENGTH) {
  try {
    const value = await fsOps.readFile(target, "utf8");
    const source = String(value || "").trim();
    return source.length > maximum ? `${source.slice(0, maximum)}…` : source;
  } catch {
    return "";
  }
}

async function readReport(fsOps, target) {
  try {
    const source = plainObject(JSON.parse(await fsOps.readFile(target, "utf8")));
    const status = clean(source.status);
    if (!status) return null;
    const warnings = Array.isArray(source.warnings)
      ? source.warnings.map((item) => clean(item).slice(0, MAX_WARNING_LENGTH)).filter(Boolean).slice(0, 8)
      : [];
    return {
      status,
      mode: clean(source.mode),
      reason: clean(source.reason),
      checkedAt: clean(source.checkedAt),
      writtenAt: clean(source.writtenAt),
      currentTokens: Number.isFinite(Number(source.currentTokens)) ? Number(source.currentTokens) : 0,
      messagesToCompact: Number.isFinite(Number(source.messagesToCompact)) ? Number(source.messagesToCompact) : 0,
      messagesCompacted: Number.isFinite(Number(source.messagesCompacted)) ? Number(source.messagesCompacted) : 0,
      summaryChars: Number.isFinite(Number(source.summaryChars)) ? Number(source.summaryChars) : 0,
      sourceFileName: clean(source.sourceFileName),
      warnings,
    };
  } catch {
    return null;
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

function dataRootFor(settingsService) {
  const settings = settingsService.load() || {};
  const dataRoot = clean(settingsService.response(settings)?.dataRoot);
  if (!dataRoot || !path.isAbsolute(dataRoot)) {
    throw new ConversationCompactorError("无法定位 Suzu Lives 软件数据目录。 ");
  }
  return { dataRoot: path.resolve(dataRoot), settings };
}

function projectScopeKey(value) {
  const source = clean(value);
  if (!source || !path.isAbsolute(source)) return "";
  const resolved = path.resolve(source);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sessionPaths(dataRoot, session) {
  const projectRoot = clean(session?.projectRoot);
  const sessionId = clean(session?.id);
  const agentId = stableAgentId(projectRoot);
  if (!agentId || !sessionId) {
    throw new ConversationCompactorError("Claude 会话或项目目录无效。 ");
  }
  try {
    const conversationDirectory = resolveAgentConversationDataRoot({ dataRoot, projectRoot, sessionId });
    const agentDirectory = resolveAgentDataRoot({ dataRoot, agentId });
    const workDirectory = path.join(agentDirectory, "memory", "compactor", "sessions", sessionId, "work");
    return {
      agentId,
      configPath: path.join(conversationDirectory, "compactor.json"),
      latestSummaryPath: path.join(workDirectory, "latest-summary.md"),
      reportPath: path.join(workDirectory, "last-run.json"),
    };
  } catch {
    throw new ConversationCompactorError("Claude 会话或项目目录无效。 ");
  }
}

function publicSession(value) {
  const source = plainObject(value);
  return {
    id: clean(source.id),
    title: clean(source.title) || "未命名对话",
    preview: clean(source.preview),
    updatedAt: clean(source.updatedAt),
    draft: source.draft === true,
  };
}

function publicContact(value) {
  const source = plainObject(value);
  return {
    id: clean(source.id),
    name: clean(source.name),
  };
}

function dailyCron(value) {
  const [hours, minutes] = timeOfDay(value).split(":").map(Number);
  return `${minutes} ${hours} * * *`;
}

function scopeKey(scope) {
  return `${projectScopeKey(scope?.session?.projectRoot)}\u0000${clean(scope?.session?.id)}`;
}

function isCompactorTaskForScope(task, scope) {
  const target = plainObject(task?.target);
  return task?.source === "system"
    && target.type === "operation"
    && target.name === COMPACTOR_OPERATION
    && clean(target.sessionId) === clean(scope?.session?.id)
    && projectScopeKey(target.projectRoot) === projectScopeKey(scope?.session?.projectRoot);
}

/**
 * Owns the desktop-only settings and diagnostics around the existing
 * memory-compactor. Prompts, automatic rules, reports, and backups are all
 * scoped to one contact plus one native Claude session.
 */
export function createConversationCompactorService({
  createGeneratorImpl = createClaudeCliGenerator,
  createScheduleTaskImpl = createScheduleTask,
  fsOps = fs,
  importConversationHistoryImpl = importConversationHistory,
  listScheduleTasksImpl = listScheduleTasks,
  now = () => new Date(),
  reader,
  removeScheduleTaskImpl = removeScheduleTask,
  runCompactionImpl = runCompaction,
  settingsService,
} = {}) {
  if (!reader?.compactorSnapshot || !reader?.resolveCompactorSession) {
    throw new ConversationCompactorError("记忆压缩器需要原生 Claude 会话读取服务。 ");
  }
  if (!settingsService?.load || !settingsService?.response) {
    throw new ConversationCompactorError("记忆压缩器需要软件设置服务。 ");
  }
  if (typeof runCompactionImpl !== "function") {
    throw new ConversationCompactorError("记忆压缩器没有可用的压缩执行器。 ");
  }
  if (typeof importConversationHistoryImpl !== "function") {
    throw new ConversationCompactorError("记忆压缩器没有可用的历史导入器。 ");
  }

  const activeRuns = new Map();

  const selectedSession = async ({ contactId = "" } = {}) => {
    const source = await reader.compactorSnapshot();
    const catalog = (Array.isArray(source?.contacts) ? source.contacts : [])
      .map((contact) => ({
        ...publicContact(contact),
        sessions: (Array.isArray(contact?.sessions) ? contact.sessions : [])
          .map(publicSession)
          .filter((item) => item.id),
      }))
      .filter((contact) => contact.id);
    const contacts = catalog.map(({ id, name, sessions }) => ({
      id,
      name,
      hasConversation: sessions.length > 0,
    }));
    const requestedContactId = clean(contactId);
    const activeContactId = clean(source?.activeContact?.id);
    const selectedCatalogContact = catalog.find((contact) => contact.id === requestedContactId)
      || catalog.find((contact) => contact.id === activeContactId)
      || catalog[0]
      || null;
    const selectedContact = publicContact(selectedCatalogContact);
    const selected = selectedCatalogContact?.sessions[0] || null;
    return { contacts, selected, selectedContact, source };
  };

  const scopeFromSession = (session) => {
    const { dataRoot, settings } = dataRootFor(settingsService);
    const paths = sessionPaths(dataRoot, session);
    return { dataRoot, paths, session, settings };
  };

  const scopeFor = async ({ contactId } = {}) => (
    scopeFromSession(await reader.resolveCompactorSession({ contactId }))
  );

  const scopeForRuntime = async ({ sessionId, projectRoot } = {}) => {
    if (typeof reader.resolveCompactorSessionForRuntime !== "function") {
      throw new ConversationCompactorError("记忆压缩器无法验证自动任务会话范围。 ");
    }
    return scopeFromSession(await reader.resolveCompactorSessionForRuntime({ sessionId, projectRoot }));
  };

  const runScoped = (scope, operation) => {
    const key = scopeKey(scope);
    if (!key) throw new ConversationCompactorError("Claude 会话或项目目录无效。 ");
    const previous = activeRuns.get(key) || Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    activeRuns.set(key, next);
    return next.finally(() => {
      if (activeRuns.get(key) === next) activeRuns.delete(key);
    });
  };

  const reconcileAutomaticSchedule = async (scope, settings) => {
    const tasks = await listScheduleTasksImpl({ dataRoot: scope.dataRoot });
    const related = tasks.filter((task) => isCompactorTaskForScope(task, scope));
    const automatic = settings.automatic;
    const wantedCron = automatic.enabled && automatic.trigger === "time"
      ? dailyCron(automatic.time)
      : "";
    let kept = null;
    for (const task of related) {
      const retain = wantedCron
        && !kept
        && task.kind === "cron"
        && task.enabled === true
        && task.target.trigger === "time"
        && task.cron === wantedCron;
      if (retain) {
        kept = task;
      } else {
        await removeScheduleTaskImpl({ dataRoot: scope.dataRoot, id: task.id });
      }
    }
    if (!wantedCron || kept) return kept;
    const contactName = clean(scope.session.contact?.name) || "联系人";
    return createScheduleTaskImpl({
      dataRoot: scope.dataRoot,
      cron: wantedCron,
      description: `自动压缩：${contactName}`,
      exec: COMPACTOR_OPERATION,
      operationTrigger: "time",
      projectRoot: scope.session.projectRoot,
      sessionId: scope.session.id,
      source: "system",
    });
  };

  const compactionInput = ({ dryRun, minimumContextTokens = 0, retainTokens, saved, scope }) => {
    const contactName = clean(scope.session.contact?.name) || "联系人";
    const userName = clean(scope.settings?.identity?.owner?.displayName) || "我";
    const input = {
      agentId: scope.paths.agentId,
      dryRun: dryRun === true,
      memoryOwner: contactName,
      minimumContextTokens,
      rules: { recentRawTokensToKeep: retainTokens },
      sessionId: scope.session.id,
      softwareDataDirectory: scope.dataRoot,
      strategy: "token-tail",
      transcriptPath: scope.session.transcriptPath,
      userName,
    };
    if (dryRun !== true) {
      input.generator = createGeneratorImpl();
      if (saved.prompt) input.systemPrompt = saved.prompt;
    }
    return input;
  };

  const importHistoryInput = ({ scope, sourcePath }) => ({
      agentId: scope.paths.agentId,
      sessionId: scope.session.id,
      softwareDataDirectory: scope.dataRoot,
      sourceTranscriptPath: sourcePath,
      targetProjectRoot: scope.session.projectRoot,
      transcriptPath: scope.session.transcriptPath,
  });

  const runWithSettings = async ({ dryRun = false, minimumContextTokens = 0, retainTokens, saved, scope }) => {
    if (scope.session.hasTranscript !== true) {
      throw new ConversationCompactorError("当前会话还没有可压缩的聊天记录。 ");
    }
    return runCompactionImpl(compactionInput({
      dryRun,
      minimumContextTokens,
      retainTokens,
      saved,
      scope,
    }));
  };

  const snapshot = async ({ contactId = "" } = {}) => {
    const { contacts, selected, selectedContact, source } = await selectedSession({ contactId });
    const activeContact = publicContact(source?.activeContact);
    if (!selected) {
      return {
        status: clean(source?.status) || "missing",
        activeContact,
        contacts,
        selectedContactId: selectedContact?.id || "",
        selectedContact: selectedContact || null,
        selectedConversation: null,
        settings: normalizedSettings(),
        lastRun: null,
        latestSummary: "",
      };
    }
    const scope = await scopeFor({ contactId: selectedContact.id });
    const [settings, lastRun, latestSummary] = await Promise.all([
      readJson(fsOps, scope.paths.configPath),
      readReport(fsOps, scope.paths.reportPath),
      readText(fsOps, scope.paths.latestSummaryPath),
    ]);
    return {
      status: clean(source?.status) || "ready",
      activeContact,
      contacts,
      selectedContactId: selectedContact.id,
      selectedContact,
      selectedConversation: {
        contactId: selectedContact.id,
        contactName: selectedContact.name,
        title: selected.title || "固定 Claude 对话",
        hasTranscript: scope.session.hasTranscript === true,
      },
      settings,
      lastRun,
      latestSummary,
    };
  };

  const save = async ({ contactId, ...value } = {}) => {
    const scope = await scopeFor({ contactId });
    const saved = await readJson(fsOps, scope.paths.configPath);
    const entry = submittedSettings(value, saved, now);
    await writeJsonAtomic(fsOps, scope.paths.configPath, entry);
    await reconcileAutomaticSchedule(scope, entry);
    return snapshot({ contactId: scope.session.contact?.id });
  };

  const runManual = async ({ contactId, retainTokens } = {}, { dryRun = false } = {}) => {
    const scope = await scopeFor({ contactId });
    const saved = await readJson(fsOps, scope.paths.configPath);
    const nextRetainTokens = retainTokens === undefined
      ? saved.manual.retainTokens
      : positiveInteger(retainTokens, "手动压缩保留 Token");
    if (nextRetainTokens !== saved.manual.retainTokens) {
      await writeJsonAtomic(fsOps, scope.paths.configPath, {
        ...saved,
        manual: { retainTokens: nextRetainTokens },
        updatedAt: timestamp(now),
      });
    }
    await runScoped(scope, () => runWithSettings({
      dryRun,
      retainTokens: nextRetainTokens,
      saved,
      scope,
    }));
    return snapshot({ contactId: scope.session.contact?.id });
  };

  const importHistory = async ({ contactId, sourcePath } = {}) => {
    const source = clean(sourcePath);
    if (!source || path.extname(source).toLowerCase() !== ".jsonl") {
      throw new ConversationCompactorError("请选择 Claude 会话 JSONL 文件。 ");
    }
    const scope = await scopeFor({ contactId });
    if (scope.session.hasTranscript !== true) {
      throw new ConversationCompactorError("先在当前联系人对话中发送一条消息，再导入历史 JSONL。 ");
    }
    await runScoped(scope, () => importConversationHistoryImpl(importHistoryInput({
      scope,
      sourcePath: path.resolve(source),
    })));
    return snapshot({ contactId: scope.session.contact?.id });
  };

  const enqueueTokenAuto = async ({ sessionId, projectRoot } = {}) => {
    const scope = await scopeForRuntime({ sessionId, projectRoot });
    const saved = await readJson(fsOps, scope.paths.configPath);
    if (!saved.automatic.enabled || saved.automatic.trigger !== "token" || scope.session.hasTranscript !== true) {
      return { scheduled: false };
    }
    const transcript = await fsOps.readFile(scope.session.transcriptPath, "utf8");
    const context = reconstructLogicalContext(parseJsonlText(transcript, scope.session.transcriptPath));
    const plan = chooseTokenTailCompactionPlan(context, {
      minimumContextTokens: saved.automatic.tokenThreshold,
      recentRawTokensToKeep: saved.automatic.retainTokens,
    });
    if (plan.action !== "compact") return { scheduled: false };
    const tasks = await listScheduleTasksImpl({ dataRoot: scope.dataRoot });
    if (tasks.some((task) => isCompactorTaskForScope(task, scope) && task.target.trigger === "token")) {
      return { scheduled: false };
    }
    const task = await createScheduleTaskImpl({
      dataRoot: scope.dataRoot,
      delay: "1s",
      description: `自动压缩：${clean(scope.session.contact?.name) || "联系人"}`,
      exec: COMPACTOR_OPERATION,
      operationTrigger: "token",
      projectRoot: scope.session.projectRoot,
      sessionId: scope.session.id,
      source: "system",
    });
    return { scheduled: true, taskId: task.id };
  };

  const runScheduledAutomaticTask = async (task) => {
    const target = plainObject(task?.target);
    if (target.type !== "operation" || target.name !== COMPACTOR_OPERATION) {
      throw new ConversationCompactorError("自动压缩任务无效。 ");
    }
    const trigger = automaticTrigger(target.trigger);
    const scope = await scopeForRuntime({
      projectRoot: target.projectRoot,
      sessionId: target.sessionId,
    });
    const saved = await readJson(fsOps, scope.paths.configPath);
    if (!saved.automatic.enabled || saved.automatic.trigger !== trigger) {
      return { status: "skipped", reason: "自动压缩设置已变更。" };
    }
    return runScoped(scope, () => runWithSettings({
      minimumContextTokens: trigger === "token" ? saved.automatic.tokenThreshold : 0,
      retainTokens: saved.automatic.retainTokens,
      saved,
      scope,
    }));
  };

  return {
    check: (value = {}) => runManual(value, { dryRun: true }),
    enqueueTokenAuto,
    importHistory,
    run: (value = {}) => runManual(value),
    runScheduledAutomaticTask,
    save,
    snapshot,
  };
}
