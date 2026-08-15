import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendUsageEvent } from "@suzu-lives/cost-ledger";

import {
  buildSessionCompactionInput,
  parseSessionCompaction,
  SESSION_COMPACTION_SCHEMA,
} from "./session-summary.mjs";
import {
  appendCompactRecords,
  buildCompactRecords,
  chooseCompactionPlan,
  chooseTokenTailCompactionPlan,
  parseJsonlText,
  reconstructLogicalContext,
} from "./transcript.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_PATH = path.join(PACKAGE_ROOT, "resources", "system-prompt.md");
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function clean(value) {
  return String(value ?? "").trim();
}

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, filePath);
}

function writeJsonAtomic(filePath, value) {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function resolvePaths({
  softwareDataDirectory,
  agentId,
  usageLedgerPath,
  sessionId = "",
}) {
  const dataRoot = path.resolve(clean(softwareDataDirectory));
  const agentRoot = path.join(dataRoot, "agents", agentId);
  const compactorRoot = path.join(agentRoot, "memory", "compactor");
  const normalizedSessionId = clean(sessionId);
  if (normalizedSessionId && !SESSION_ID_PATTERN.test(normalizedSessionId)) {
    throw new Error("runCompaction 的 sessionId 无效。 ");
  }
  const sessionRoot = normalizedSessionId
    ? path.join(compactorRoot, "sessions", normalizedSessionId)
    : compactorRoot;
  return {
    dataRoot,
    agentRoot,
    usageLedgerPath: usageLedgerPath
      ? path.resolve(usageLedgerPath)
      : path.join(agentRoot, "cost-ledger", "events.jsonl"),
    sessionId: normalizedSessionId,
    workDirectory: path.join(sessionRoot, "work"),
    backupDirectory: path.join(sessionRoot, "backups"),
  };
}

export async function runCompaction({
  transcriptPath,
  agentId,
  softwareDataDirectory,
  usageLedgerPath = "",
  memoryOwner = "我",
  userName = "对方",
  rules = {},
  boundaryContextMessages = 20,
  generator = null,
  dryRun = false,
  now = new Date(),
  sessionId = "",
  summaryOverride = "",
  systemPrompt = "",
  systemPromptPath = DEFAULT_PROMPT_PATH,
  strategy = "default",
  minimumContextTokens = 0,
} = {}) {
  const normalizedAgentId = clean(agentId);
  if (!normalizedAgentId) throw new Error("runCompaction 需要 agentId。");
  if (!clean(softwareDataDirectory)) throw new Error("runCompaction 需要 softwareDataDirectory。");
  const requestedTranscriptPath = clean(transcriptPath);
  if (!requestedTranscriptPath) throw new Error("runCompaction 需要 transcriptPath。");
  const normalizedTranscriptPath = path.resolve(requestedTranscriptPath);
  if (!fs.existsSync(normalizedTranscriptPath)) {
    throw new Error(`会话 JSONL 不存在：${normalizedTranscriptPath}`);
  }
  const executionTime = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(executionTime.getTime())) throw new Error("now 不是有效时间。");

  const paths = resolvePaths({
    softwareDataDirectory,
    agentId: normalizedAgentId,
    usageLedgerPath,
    sessionId,
  });
  fs.mkdirSync(paths.workDirectory, { recursive: true });

  const originalText = fs.readFileSync(normalizedTranscriptPath, "utf8");
  const entries = parseJsonlText(originalText, normalizedTranscriptPath);
  const context = reconstructLogicalContext(entries);
  const selectedStrategy = clean(strategy).toLowerCase() || "default";
  if (!new Set(["default", "token-tail"]).has(selectedStrategy)) {
    throw new Error("runCompaction 的 strategy 无效。 ");
  }
  const plan = selectedStrategy === "token-tail"
    ? chooseTokenTailCompactionPlan(context, { ...rules, minimumContextTokens })
    : chooseCompactionPlan(context, executionTime, rules);
  if (plan.action === "skip") {
    const report = {
      status: "skipped",
      transcriptPath: normalizedTranscriptPath,
      ...(paths.sessionId ? { sessionId: paths.sessionId } : {}),
      ...plan,
      checkedAt: executionTime.toISOString(),
    };
    writeJsonAtomic(path.join(paths.workDirectory, "last-run.json"), report);
    return report;
  }

  const { input, messages } = buildSessionCompactionInput({
    plan,
    memoryOwner,
    userName,
    boundaryContextMessages,
  });
  writeFileAtomic(path.join(paths.workDirectory, "last-input.md"), input);

  if (dryRun) {
    const report = {
      status: "dry-run",
      transcriptPath: normalizedTranscriptPath,
      ...(paths.sessionId ? { sessionId: paths.sessionId } : {}),
      mode: plan.mode,
      currentTokens: plan.currentTokens,
      headUuid: plan.head.record.uuid,
      headTimestamp: plan.head.record.timestamp,
      currentTailUuid: context.currentTail.record.uuid,
      prefixRecords: plan.prefix.length,
      messagesToCompact: messages.length,
      preservedRecords: plan.preservedLogical.length,
      inputChars: input.length,
      checkedAt: executionTime.toISOString(),
    };
    writeJsonAtomic(path.join(paths.workDirectory, "last-run.json"), report);
    return report;
  }

  let generation;
  if (clean(summaryOverride)) {
    generation = {
      output: parseSessionCompaction({ summary: summaryOverride }),
      usage: {},
      model: "",
      requestId: "",
      durationMs: 0,
      metadata: { source: "override" },
    };
  } else {
    if (typeof generator !== "function") {
      throw new Error("实际压缩需要 generator，或提供 summaryOverride 进行本地模拟。");
    }
    const selectedSystemPrompt = clean(systemPrompt) || fs.readFileSync(systemPromptPath, "utf8").trim();
    generation = await generator({
      input,
      systemPrompt: selectedSystemPrompt,
      schema: SESSION_COMPACTION_SCHEMA,
      schemaName: "conversation-compaction-v1",
    });
    generation.output = parseSessionCompaction(generation.output);
  }

  const built = buildCompactRecords(
    entries,
    context,
    plan,
    { memoryOwner, userName },
    generation.output.summary,
    executionTime,
    Number(generation.durationMs || 0),
  );
  const compactWrite = appendCompactRecords({
    transcriptPath: normalizedTranscriptPath,
    originalText,
    boundary: built.boundary,
    summary: built.summary,
    backupDirectory: paths.backupDirectory,
    now: executionTime,
  });

  const warnings = [];
  if (generation.model && generation.usage && Object.keys(generation.usage).length) {
    try {
      await appendUsageEvent(paths.usageLedgerPath, {
        timestamp: executionTime.toISOString(),
        agentId: normalizedAgentId,
        provider: generation.metadata?.provider || "",
        model: generation.model,
        source: "memory-compactor",
        feature: "conversation-compaction",
        requestId: generation.requestId || "",
        usage: generation.usage,
        metadata: {
          durationMs: Number(generation.durationMs || 0),
          boundaryUuid: built.boundary.uuid,
          ...generation.metadata,
        },
      });
    } catch (error) {
      warnings.push(`费用流水写入失败：${error.message}`);
    }
  }

  writeFileAtomic(
    path.join(paths.workDirectory, "latest-summary.md"),
    `${generation.output.summary}\n`,
  );
  const report = {
    status: "written",
    transcriptPath: normalizedTranscriptPath,
    ...(paths.sessionId ? { sessionId: paths.sessionId } : {}),
    backupPath: compactWrite.backupPath,
    mode: plan.mode,
    currentTokens: plan.currentTokens,
    headUuid: plan.head.record.uuid,
    headTimestamp: plan.head.record.timestamp,
    tailUuid: context.currentTail.record.uuid,
    preservedRecords: built.preserved.length,
    summarizedRecords: plan.prefix.length,
    messagesCompacted: messages.length,
    boundaryUuid: built.boundary.uuid,
    summaryUuid: built.summary.uuid,
    summaryChars: generation.output.summary.length,
    usageRecorded: Boolean(
      generation.model && generation.usage && Object.keys(generation.usage).length,
    ),
    warnings,
    writtenAt: executionTime.toISOString(),
  };
  writeJsonAtomic(path.join(paths.workDirectory, "last-run.json"), report);
  return report;
}

function importTimestamp(date) {
  return date.toISOString().replace(/[:.]/gu, "-");
}

function samePath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function rewriteImportedTranscript(sourceText, entries, { sessionId, projectRoot }) {
  const entriesByIndex = new Map(entries.map((entry) => [entry.index, entry]));
  const lineEnding = sourceText.includes("\r\n") ? "\r\n" : "\n";
  const lines = sourceText.split(/\r?\n/u);
  return lines.map((line, index) => {
    const entry = entriesByIndex.get(index);
    if (!entry) return line;
    const record = { ...entry.record };
    if (typeof record.sessionId === "string") record.sessionId = sessionId;
    if (projectRoot && typeof record.cwd === "string") record.cwd = projectRoot;
    return JSON.stringify(record);
  }).join(lineEnding);
}

function importedSummaryText(context) {
  const record = [...context.logical].reverse().find((entry) => entry.record?.isCompactSummary)?.record;
  return typeof record?.message?.content === "string" ? record.message.content.trim() : "";
}

function replaceTranscriptFile({ backupDirectory, importedText, now, originalText, transcriptPath }) {
  if (fs.readFileSync(transcriptPath, "utf8") !== originalText) {
    throw new Error("导入期间当前会话 JSONL 发生了变化；本次未替换。 ");
  }
  fs.mkdirSync(backupDirectory, { recursive: true });
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const backupPath = path.join(
    backupDirectory,
    `${path.basename(transcriptPath)}.pre-import-${importTimestamp(now)}.bak`,
  );
  const stagedPath = `${transcriptPath}.suzu-import-${suffix}.tmp`;
  const retiredPath = `${transcriptPath}.suzu-import-retired-${suffix}.tmp`;
  fs.writeFileSync(backupPath, originalText, { encoding: "utf8", flag: "wx" });
  fs.writeFileSync(stagedPath, importedText, { encoding: "utf8", flag: "wx" });
  let retired = false;
  try {
    if (fs.readFileSync(transcriptPath, "utf8") !== originalText) {
      throw new Error("导入期间当前会话 JSONL 发生了变化；本次未替换。 ");
    }
    fs.renameSync(transcriptPath, retiredPath);
    retired = true;
    try {
      fs.renameSync(stagedPath, transcriptPath);
    } catch (error) {
      if (!fs.existsSync(transcriptPath)) fs.renameSync(retiredPath, transcriptPath);
      throw error;
    }
  } finally {
    fs.rmSync(stagedPath, { force: true });
  }

  try {
    const writtenText = fs.readFileSync(transcriptPath, "utf8");
    if (writtenText !== importedText) {
      throw new Error(`导入后当前会话 JSONL 又发生了变化；安全备份位于 ${backupPath}。`);
    }
    try {
      reconstructLogicalContext(parseJsonlText(writtenText, transcriptPath));
    } catch (error) {
      fs.copyFileSync(backupPath, transcriptPath);
      throw new Error(`导入后的 JSONL 校验失败，已从备份恢复：${error.message}`);
    }
  } finally {
    if (retired) fs.rmSync(retiredPath, { force: true });
  }
  return { backupPath };
}

/**
 * Replaces the current contact transcript with a selected native Claude JSONL.
 * The source UUID chain stays intact; only the session/project scope is rebound
 * so later --resume calls continue using the current contact's fixed session.
 */
export async function importConversationHistory({
  sourceTranscriptPath,
  transcriptPath,
  agentId,
  softwareDataDirectory,
  targetProjectRoot = "",
  now = new Date(),
  sessionId = "",
} = {}) {
  const normalizedAgentId = clean(agentId);
  if (!normalizedAgentId) throw new Error("importConversationHistory 需要 agentId。 ");
  if (!clean(softwareDataDirectory)) throw new Error("importConversationHistory 需要 softwareDataDirectory。 ");
  const targetSessionId = clean(sessionId);
  if (!SESSION_ID_PATTERN.test(targetSessionId)) {
    throw new Error("importConversationHistory 的目标 sessionId 无效。 ");
  }
  const requestedSourcePath = clean(sourceTranscriptPath);
  const requestedTargetPath = clean(transcriptPath);
  if (!requestedSourcePath) throw new Error("importConversationHistory 需要 sourceTranscriptPath。 ");
  if (!requestedTargetPath) throw new Error("importConversationHistory 需要 transcriptPath。 ");
  const normalizedSourcePath = path.resolve(requestedSourcePath);
  const normalizedTargetPath = path.resolve(requestedTargetPath);
  if (!fs.existsSync(normalizedSourcePath)) {
    throw new Error(`导入来源 JSONL 不存在：${normalizedSourcePath}`);
  }
  if (!fs.existsSync(normalizedTargetPath)) {
    throw new Error(`当前会话 JSONL 不存在：${normalizedTargetPath}`);
  }
  if (samePath(fs.realpathSync(normalizedSourcePath), fs.realpathSync(normalizedTargetPath))) {
    throw new Error("不能把当前会话 JSONL 导入到自身。 ");
  }
  const executionTime = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(executionTime.getTime())) throw new Error("now 不是有效时间。 ");
  const projectRoot = clean(targetProjectRoot);
  if (projectRoot && !path.isAbsolute(projectRoot)) {
    throw new Error("importConversationHistory 的目标项目目录无效。 ");
  }

  const paths = resolvePaths({
    softwareDataDirectory,
    agentId: normalizedAgentId,
    sessionId: targetSessionId,
  });
  fs.mkdirSync(paths.workDirectory, { recursive: true });
  const sourceText = fs.readFileSync(normalizedSourcePath, "utf8");
  const sourceEntries = parseJsonlText(sourceText, normalizedSourcePath);
  const sourceContext = reconstructLogicalContext(sourceEntries);
  if (!sourceEntries.some((entry) => typeof entry.record?.sessionId === "string" && entry.record.sessionId)) {
    throw new Error("导入文件不是带会话标识的 Claude JSONL。 ");
  }
  const importedText = rewriteImportedTranscript(sourceText, sourceEntries, {
    sessionId: targetSessionId,
    projectRoot: projectRoot ? path.resolve(projectRoot) : "",
  });
  const importedEntries = parseJsonlText(importedText, normalizedSourcePath);
  const importedContext = reconstructLogicalContext(importedEntries);
  if (importedContext.currentTail?.record?.sessionId !== targetSessionId) {
    throw new Error("导入 JSONL 无法绑定到当前联系人的会话。 ");
  }
  if (importedEntries.some((entry) => (
    typeof entry.record?.sessionId === "string" && entry.record.sessionId !== targetSessionId
  ))) {
    throw new Error("导入 JSONL 无法绑定到当前联系人的会话。 ");
  }

  const originalText = fs.readFileSync(normalizedTargetPath, "utf8");
  const replacement = replaceTranscriptFile({
    backupDirectory: paths.backupDirectory,
    importedText,
    now: executionTime,
    originalText,
    transcriptPath: normalizedTargetPath,
  });
  const summary = importedSummaryText(importedContext);
  writeFileAtomic(path.join(paths.workDirectory, "latest-summary.md"), summary ? `${summary}\n` : "");
  const report = {
    status: "imported",
    transcriptPath: normalizedTargetPath,
    sourceFileName: path.basename(normalizedSourcePath),
    sessionId: targetSessionId,
    backupPath: replacement.backupPath,
    mode: "replace",
    sourceRecords: sourceContext.logical.filter((entry) => entry.record.uuid).length,
    importedRecords: importedEntries.filter((entry) => entry.record.uuid).length,
    writtenAt: executionTime.toISOString(),
  };
  writeJsonAtomic(path.join(paths.workDirectory, "last-run.json"), report);
  writeJsonAtomic(path.join(paths.workDirectory, "last-import.json"), report);
  return report;
}
