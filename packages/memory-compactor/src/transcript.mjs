import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isAutomationPrompt,
  visibleAssistantTexts,
  visibleUserText,
} from "./conversation.mjs";

export const DEFAULT_COMPACTION_RULES = Object.freeze({
  minimumHoursSinceLastCompaction: 24,
  recentRawHoursToKeep: 24,
  contextTokensTrigger: 60_000,
  recentRawTokensToKeep: 10_000,
});

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeRules(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(Object.entries(DEFAULT_COMPACTION_RULES).map(([key, fallback]) => {
    const number = Number(source[key] ?? fallback);
    if (!Number.isFinite(number) || number <= 0) {
      throw new Error(`rules.${key} 必须是大于 0 的数字。`);
    }
    return [key, number];
  }));
}

export function parseJsonText(text) {
  return JSON.parse(String(text).replace(/^\uFEFF/u, ""));
}

export function parseJsonlText(text, source = "transcript") {
  const entries = [];
  const lines = String(text).split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim()) continue;
    try {
      entries.push({ record: parseJsonText(raw), line: index + 1, index, raw });
    } catch (error) {
      throw new Error(`${source}:${index + 1} 不是有效 JSON：${error.message}`);
    }
  }
  if (!entries.length) throw new Error(`${source} 没有有效记录。`);
  return entries;
}

function newestLeafUuid(entries, uuidMap) {
  let lastPromptIndex = -1;
  let lastPromptLeaf = "";
  let lastUuidIndex = -1;
  let lastUuid = "";
  for (const entry of entries) {
    const record = entry.record;
    if (record.type === "last-prompt" && record.leafUuid && uuidMap.has(record.leafUuid)) {
      lastPromptIndex = entry.index;
      lastPromptLeaf = record.leafUuid;
    }
    if (record.uuid) {
      lastUuidIndex = entry.index;
      lastUuid = record.uuid;
    }
  }
  return lastPromptIndex > lastUuidIndex ? lastPromptLeaf : lastUuid;
}

function chainToRoot(leafUuid, uuidMap) {
  const reversed = [];
  const seen = new Set();
  let current = uuidMap.get(leafUuid);
  while (current?.record?.uuid && !seen.has(current.record.uuid)) {
    seen.add(current.record.uuid);
    reversed.push(current);
    current = current.record.parentUuid ? uuidMap.get(current.record.parentUuid) : null;
  }
  return reversed.reverse();
}

function latestCompact(entries, uuidMap) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.record.type !== "system" || entry.record.subtype !== "compact_boundary") continue;
    const metadata = entry.record.compactMetadata || {};
    const anchorUuid = metadata.preservedSegment?.anchorUuid || metadata.preservedMessages?.anchorUuid;
    const summary = anchorUuid
      ? uuidMap.get(anchorUuid)
      : entries.slice(index + 1).find((item) => item.record.isCompactSummary);
    if (summary?.record?.isCompactSummary) return { boundary: entry, summary, metadata };
  }
  return null;
}

export function reconstructLogicalContext(entries) {
  const uuidMap = new Map(
    entries.filter((entry) => entry.record.uuid).map((entry) => [entry.record.uuid, entry]),
  );
  const leafUuid = newestLeafUuid(entries, uuidMap);
  if (!leafUuid) throw new Error("找不到当前会话叶子 UUID。");
  const physicalChain = chainToRoot(leafUuid, uuidMap);
  const leaf = uuidMap.get(leafUuid);
  const sessionId = leaf?.record?.sessionId;
  const chronologicalSession = entries.filter((entry) => (
    entry.record.uuid && (!sessionId || entry.record.sessionId === sessionId)
  ));
  const physicalRoot = physicalChain[0];
  const physicalChainIsComplete = Boolean(
    physicalRoot && (!physicalRoot.record.parentUuid || uuidMap.has(physicalRoot.record.parentUuid)),
  );
  const compact = latestCompact(entries, uuidMap);
  if (!compact) {
    const logical = physicalChainIsComplete ? physicalChain : chronologicalSession;
    return { compact: null, logical, currentTail: logical.at(-1), uuidMap };
  }

  const preservedIds = compact.metadata.preservedMessages?.uuids || [];
  const preserved = preservedIds.map((uuid) => uuidMap.get(uuid)).filter(Boolean);
  const preservedTailUuid = compact.metadata.preservedSegment?.tailUuid
    || preserved.at(-1)?.record.uuid;
  let appended = [];
  if (leafUuid !== compact.summary.record.uuid && preservedTailUuid) {
    const tailIndex = physicalChain.findIndex((entry) => entry.record.uuid === preservedTailUuid);
    if (tailIndex >= 0) appended = physicalChain.slice(tailIndex + 1);
    else {
      const anchorIndex = physicalChain.findIndex(
        (entry) => entry.record.uuid === compact.summary.record.uuid,
      );
      if (anchorIndex >= 0) appended = physicalChain.slice(anchorIndex + 1);
      else appended = chronologicalSession.filter((entry) => entry.index > compact.summary.index);
    }
  }
  const logical = [compact.summary, ...preserved, ...appended]
    .filter((entry, index, array) => (
      array.findIndex((other) => other.record.uuid === entry.record.uuid) === index
    ));
  return {
    compact,
    logical,
    currentTail: appended.at(-1) || preserved.at(-1) || compact.summary,
    uuidMap,
  };
}

function contentBlocks(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return Array.isArray(content) ? content : [];
}

export function shouldPreserveLiveRecord(entry) {
  const record = entry?.record || {};
  if (!record.uuid || record.isCompactSummary || record.isMeta) return false;
  if (record.type === "user" && record.message?.role === "user") {
    const blocks = contentBlocks(record.message.content);
    if (blocks.some((block) => block?.type === "tool_result")) return true;
    const text = visibleUserText(entry);
    return Boolean(text) && !isAutomationPrompt(text);
  }
  if (record.type === "assistant" && record.message?.role === "assistant") {
    const blocks = contentBlocks(record.message.content);
    return blocks.some((block) => block?.type === "tool_use")
      || visibleAssistantTexts(entry).length > 0;
  }
  return false;
}

function effectiveInputTokens(usage) {
  if (!usage || typeof usage !== "object") return 0;
  return Number(usage.input_tokens || 0)
    + Number(usage.cache_creation_input_tokens || 0)
    + Number(usage.cache_read_input_tokens || 0);
}

function latestContextTokens(logical, compact) {
  if (compact) {
    for (let index = logical.length - 1; index >= 0; index -= 1) {
      const entry = logical[index];
      if (entry.index <= compact.summary.index) continue;
      const value = effectiveInputTokens(entry.record.message?.usage);
      if (value > 0) return value;
    }
    return Number(compact.metadata?.postTokens || 0);
  }
  for (let index = logical.length - 1; index >= 0; index -= 1) {
    const value = effectiveInputTokens(logical[index].record.message?.usage);
    if (value > 0) return value;
  }
  return 0;
}

export function estimateTextTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const character of String(text || "")) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Extended_Pictographic}/u.test(character)) cjk += 1;
    else other += Buffer.byteLength(character, "utf8") > 1 ? 0.7 : 0.25;
  }
  return Math.max(1, Math.ceil(cjk + other));
}

function estimateRecordTokens(entry) {
  const record = entry.record;
  const payload = record.message ?? record.attachment ?? record.content ?? record;
  return 8 + estimateTextTokens(JSON.stringify(payload));
}

function isHumanUser(entry) {
  const text = visibleUserText(entry);
  return Boolean(text) && !isAutomationPrompt(text);
}

function chooseTimeHead(logical, cutoffMs) {
  return logical.findIndex((entry) => {
    if (!isHumanUser(entry)) return false;
    const timestamp = Date.parse(entry.record.timestamp || "");
    return Number.isFinite(timestamp) && timestamp >= cutoffMs;
  });
}

function chooseTokenHead(logical, targetTokens) {
  let accumulated = 0;
  let targetIndex = logical.length - 1;
  for (let index = logical.length - 1; index >= 0; index -= 1) {
    if (logical[index].record.isCompactSummary) break;
    if (!shouldPreserveLiveRecord(logical[index])) continue;
    accumulated += estimateRecordTokens(logical[index]);
    targetIndex = index;
    if (accumulated >= targetTokens) break;
  }
  for (let index = targetIndex; index >= 0; index -= 1) {
    if (logical[index].record.isCompactSummary) break;
    if (isHumanUser(logical[index])) return index;
  }
  for (let index = targetIndex + 1; index < logical.length; index += 1) {
    if (isHumanUser(logical[index])) return index;
  }
  return -1;
}

function tokenTailPlan({ context, currentTokens, minimumContextTokens, rules }) {
  const { logical } = context;
  if (minimumContextTokens > 0 && currentTokens <= minimumContextTokens) {
    return {
      action: "skip",
      reason: `当前上下文 ${currentTokens} tokens 未超过 ${minimumContextTokens}。`,
      currentTokens,
    };
  }
  const headIndex = chooseTokenHead(logical, rules.recentRawTokensToKeep);
  if (headIndex < 0) {
    return { action: "skip", reason: "找不到可作为保留起点的完整用户消息。", currentTokens };
  }
  const prefix = logical.slice(0, headIndex);
  const preservedLogical = logical.slice(headIndex)
    .filter((entry) => entry.record.uuid && !entry.record.isCompactSummary);
  if (!prefix.length) return { action: "skip", reason: "切点以前没有可压缩内容。", currentTokens };
  if (!preservedLogical.length) {
    return { action: "skip", reason: "切点以后没有可保留原文。", currentTokens };
  }
  return {
    action: "compact",
    mode: "token-tail",
    currentTokens,
    headIndex,
    prefix,
    head: preservedLogical[0],
    logicalTail: preservedLogical.at(-1),
    preservedLogical,
    rules,
  };
}

/**
 * Forces a compaction boundary based on the raw recent token tail instead of
 * the legacy time-window decision. This is used by the desktop manual action
 * and its per-session automation settings; the existing default planner keeps
 * its previous behavior for all other callers.
 */
export function chooseTokenTailCompactionPlan(context, {
  recentRawTokensToKeep,
  minimumContextTokens = 0,
} = {}) {
  const rules = normalizeRules({ recentRawTokensToKeep });
  const threshold = Number(minimumContextTokens);
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new Error("minimumContextTokens 必须是非负数字。 ");
  }
  const currentTokens = latestContextTokens(context.logical, context.compact);
  return tokenTailPlan({
    context,
    currentTokens,
    minimumContextTokens: threshold,
    rules,
  });
}

export function chooseCompactionPlan(context, now = new Date(), ruleOverrides = {}) {
  const { logical, compact } = context;
  const rules = normalizeRules(ruleOverrides);
  const minimumIntervalMs = rules.minimumHoursSinceLastCompaction * 60 * 60 * 1000;
  const recentRawWindowMs = rules.recentRawHoursToKeep * 60 * 60 * 1000;
  const lastTimestamp = compact
    ? Date.parse(compact.boundary.record.timestamp || "")
    : Number.NEGATIVE_INFINITY;
  const elapsed = now.getTime() - lastTimestamp;
  const currentTokens = latestContextTokens(logical, compact);
  let mode;
  let headIndex;
  if (!compact || elapsed >= minimumIntervalMs) {
    mode = "recent-hours";
    headIndex = chooseTimeHead(logical, now.getTime() - recentRawWindowMs);
  } else {
    if (currentTokens <= rules.contextTokensTrigger) {
      return {
        action: "skip",
        reason: `距离上次处理不足 ${rules.minimumHoursSinceLastCompaction} 小时，当前上下文 ${currentTokens} tokens 未超过 ${rules.contextTokensTrigger}。`,
        currentTokens,
      };
    }
    const plan = tokenTailPlan({
      context,
      currentTokens,
      minimumContextTokens: rules.contextTokensTrigger,
      rules,
    });
    if (plan.action === "skip") return plan;
    return { ...plan, elapsedMs: elapsed };
  }
  if (headIndex < 0) {
    return { action: "skip", reason: "找不到可作为保留起点的完整用户消息。", currentTokens };
  }
  const prefix = logical.slice(0, headIndex);
  const preservedLogical = logical.slice(headIndex)
    .filter((entry) => entry.record.uuid && !entry.record.isCompactSummary);
  if (!prefix.length) return { action: "skip", reason: "切点以前没有可压缩内容。", currentTokens };
  if (!preservedLogical.length) {
    return { action: "skip", reason: "切点以后没有可保留原文。", currentTokens };
  }
  return {
    action: "compact",
    mode,
    currentTokens,
    headIndex,
    prefix,
    head: preservedLogical[0],
    logicalTail: preservedLogical.at(-1),
    preservedLogical,
    elapsedMs: elapsed,
    rules,
  };
}

function omitUndefined(value) {
  if (Array.isArray(value)) return value.map(omitUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .map(([key, item]) => [key, omitUndefined(item)]));
}

function commonFields(template) {
  const record = template.record;
  return {
    isSidechain: record.isSidechain ?? false,
    userType: record.userType || "external",
    entrypoint: record.entrypoint,
    cwd: record.cwd,
    sessionId: record.sessionId,
    version: record.version,
    gitBranch: record.gitBranch,
    slug: record.slug,
  };
}

function summaryWrapper({ memoryOwner = "记忆拥有者", userName = "对方" }, body) {
  return [
    "This session is being continued from a user-managed conversation summary.",
    `以下是${memoryOwner}与${userName}此前对话的连续摘要。“我”指${memoryOwner}，“${userName}”指对方。`,
    "",
    "<conversation_summary>",
    clean(body),
    "</conversation_summary>",
    "",
    "本摘要之后保留的是未经压缩的最近原始对话；发生冲突时，以较新的原始对话为准。",
    "直接延续当前关系和话题，不要提及压缩、摘要、JSONL、上下文刷新或重新加载。",
  ].join("\n");
}

function preservedRecords(context, headUuid) {
  const headIndex = context.logical.findIndex((entry) => entry.record.uuid === headUuid);
  if (headIndex < 0) throw new Error("在当前逻辑上下文中找不到选定 head，拒绝写入。");
  const preserved = context.logical.slice(headIndex)
    .filter((entry) => entry.record.uuid && !entry.record.isCompactSummary);
  if (!preserved.length || preserved[0].record.uuid !== headUuid) {
    throw new Error("无法从选定 head 构造保留记录，拒绝写入。");
  }
  return preserved;
}

export function buildCompactRecords(entries, context, plan, identity, summaryBody, now, durationMs = 0) {
  const preserved = preservedRecords(context, plan.head.record.uuid);
  const boundaryUuid = crypto.randomUUID();
  const anchorUuid = crypto.randomUUID();
  const timestamp = now.toISOString();
  const template = context.currentTail || entries.at(-1);
  const shared = commonFields(template);
  if (!shared.sessionId) throw new Error("模板记录没有 sessionId。");
  const preservedIds = preserved.map((entry) => entry.record.uuid);
  const messagesSummarized = plan.prefix.filter((entry) => entry.record.uuid).length;
  const wrappedSummary = summaryWrapper(identity, summaryBody);
  const estimatedPostTokens = estimateTextTokens(wrappedSummary)
    + preserved.reduce((sum, entry) => sum + estimateRecordTokens(entry), 0);
  const boundary = omitUndefined({
    parentUuid: null,
    logicalParentUuid: plan.head.record.parentUuid || null,
    ...shared,
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    isMeta: false,
    timestamp,
    uuid: boundaryUuid,
    level: "info",
    compactMetadata: {
      trigger: "manual",
      preTokens: plan.currentTokens,
      messagesSummarized,
      durationMs,
      postTokens: estimatedPostTokens,
      preservedSegment: {
        headUuid: preservedIds[0],
        anchorUuid,
        tailUuid: preservedIds.at(-1),
      },
      preservedMessages: {
        anchorUuid,
        uuids: preservedIds,
        allUuids: preservedIds,
      },
    },
  });
  const summary = omitUndefined({
    parentUuid: boundaryUuid,
    ...shared,
    promptId: crypto.randomUUID(),
    type: "user",
    message: { role: "user", content: wrappedSummary },
    isCompactSummary: true,
    summarizeMetadata: { messagesSummarized, direction: "up_to" },
    uuid: anchorUuid,
    timestamp,
  });
  return { boundary, summary, preserved, wrappedSummary };
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/gu, "-");
}

export function appendCompactRecords({
  transcriptPath,
  originalText,
  boundary,
  summary,
  backupDirectory,
  now = new Date(),
}) {
  if (fs.readFileSync(transcriptPath, "utf8") !== originalText) {
    throw new Error("摘要生成期间会话 JSONL 发生了变化；本次未写入。");
  }
  fs.mkdirSync(backupDirectory, { recursive: true });
  const backupPath = path.join(
    backupDirectory,
    `${path.basename(transcriptPath)}.${timestampForFile(now)}.bak`,
  );
  fs.copyFileSync(transcriptPath, backupPath);
  const prefix = originalText.endsWith("\n") || originalText.endsWith("\r") ? "" : os.EOL;
  const addition = `${prefix}${JSON.stringify(boundary)}${os.EOL}${JSON.stringify(summary)}${os.EOL}`;
  const expectedText = `${originalText}${addition}`;
  try {
    fs.appendFileSync(transcriptPath, addition, "utf8");
    const writtenText = fs.readFileSync(transcriptPath, "utf8");
    if (writtenText !== expectedText) throw new Error("写入后文件内容与预期不一致。");
    const records = parseJsonlText(writtenText, transcriptPath).slice(-2).map((entry) => entry.record);
    if (
      records[0]?.uuid !== boundary.uuid
      || records[1]?.uuid !== summary.uuid
      || !records[1]?.isCompactSummary
    ) throw new Error("追加后的最后两条记录校验失败。");
  } catch (error) {
    const currentText = fs.readFileSync(transcriptPath, "utf8");
    if (currentText === originalText || currentText === expectedText) {
      fs.copyFileSync(backupPath, transcriptPath);
      throw new Error(`写入失败，已从备份恢复：${error.message}`);
    }
    throw new Error(`写入失败且会话同时发生了变化；备份位于 ${backupPath}：${error.message}`);
  }
  return { backupPath, expectedText };
}

export function rollbackCompactWrite({
  transcriptPath,
  expectedText,
  backupPath,
  cause,
}) {
  const currentText = fs.readFileSync(transcriptPath, "utf8");
  if (currentText !== expectedText) {
    throw new Error(`记忆归档失败，且会话随后发生变化，无法安全回滚；备份位于 ${backupPath}：${cause.message}`);
  }
  fs.copyFileSync(backupPath, transcriptPath);
  throw new Error(`记忆归档失败，会话 compact 已从备份回滚：${cause.message}`);
}
