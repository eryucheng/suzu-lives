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
  parseJsonlText,
  reconstructLogicalContext,
} from "./transcript.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_PATH = path.join(PACKAGE_ROOT, "resources", "system-prompt.md");

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
}) {
  const dataRoot = path.resolve(clean(softwareDataDirectory));
  const agentRoot = path.join(dataRoot, "agents", agentId);
  const compactorRoot = path.join(agentRoot, "memory", "compactor");
  return {
    dataRoot,
    agentRoot,
    usageLedgerPath: usageLedgerPath
      ? path.resolve(usageLedgerPath)
      : path.join(agentRoot, "cost-ledger", "events.jsonl"),
    workDirectory: path.join(compactorRoot, "work"),
    backupDirectory: path.join(compactorRoot, "backups"),
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
  summaryOverride = "",
  systemPromptPath = DEFAULT_PROMPT_PATH,
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
  });
  fs.mkdirSync(paths.workDirectory, { recursive: true });

  const originalText = fs.readFileSync(normalizedTranscriptPath, "utf8");
  const entries = parseJsonlText(originalText, normalizedTranscriptPath);
  const context = reconstructLogicalContext(entries);
  const plan = chooseCompactionPlan(context, executionTime, rules);
  if (plan.action === "skip") {
    const report = {
      status: "skipped",
      transcriptPath: normalizedTranscriptPath,
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
    const systemPrompt = fs.readFileSync(systemPromptPath, "utf8").trim();
    generation = await generator({
      input,
      systemPrompt,
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
