import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  prepareHistoryAppend,
  standardizeCompactedPrefix,
  visibleUserText,
} from "../rag/ingest.mjs";
import { syncIndexFromHistory } from "../rag/build-index.mjs";
import {
  normalizeGeneratedEvents,
  prepareEventAppend,
} from "../rag/events.mjs";
import { loadRagConfig } from "../rag/retrieve.mjs";

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_CONFIG_PATH = path.join(SCRIPT_DIR, "config.local.json");
const EXAMPLE_CONFIG_PATH = path.join(SCRIPT_DIR, "config.example.json");
const WORK_DIR = path.join(SCRIPT_DIR, "work");
const BACKUP_DIR = path.join(SCRIPT_DIR, "backups");

export const DEFAULT_RULES = Object.freeze({
  minimumHoursSinceLastCompaction: 24,
  recentRawHoursToKeep: 24,
  contextTokensTrigger: 15_000,
  recentRawTokensToKeep: 5_000,
});

function normalizeRules(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const rules = {};
  for (const [key, fallback] of Object.entries(DEFAULT_RULES)) {
    const number = Number(source[key] ?? fallback);
    if (!Number.isFinite(number) || number <= 0) {
      throw new Error(`config.json 中 rules.${key} 必须是大于0的数字`);
    }
    rules[key] = number;
  }
  return rules;
}

function parseArgs(argv) {
  const result = new Map();
  for (const value of argv) {
    if (!value.startsWith("--")) continue;
    const [key, ...rest] = value.slice(2).split("=");
    result.set(key, rest.length ? rest.join("=") : "true");
  }
  return result;
}

function resolveLocal(target) {
  if (!target) return "";
  return path.isAbsolute(target) ? path.normalize(target) : path.resolve(SCRIPT_DIR, target);
}

function omitUndefined(value) {
  if (Array.isArray(value)) return value.map(omitUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, omitUndefined(item)]),
  );
}

function selectConfigPath(configOverride = "") {
  if (configOverride) return resolveLocal(configOverride);
  if (process.env.MEMORY_COMPACTOR_CONFIG) return path.resolve(process.env.MEMORY_COMPACTOR_CONFIG);
  if (fs.existsSync(LOCAL_CONFIG_PATH)) return LOCAL_CONFIG_PATH;
  return EXAMPLE_CONFIG_PATH;
}

function readConfig(transcriptOverride = "", configOverride = "") {
  const configPath = selectConfigPath(configOverride);
  if (!fs.existsSync(configPath)) throw new Error(`找不到配置文件：${configPath}`);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const configuredTranscript = transcriptOverride || config.transcriptPath;
  if (!configuredTranscript || configuredTranscript.includes("请把")) {
    throw new Error("请复制 config.example.json 为 config.local.json，并填写 transcriptPath");
  }
  config.transcriptPath = resolveLocal(configuredTranscript);
  config.promptFile = resolveLocal(config.promptFile || "prompt.md");
  config.claudeCommand = config.claudeCommand || "claude";
  config.claudeArgs = Array.isArray(config.claudeArgs) ? config.claudeArgs.map(String) : [];
  config.llmEnv = config.llmEnv && typeof config.llmEnv === "object" ? config.llmEnv : {};
  config.rules = normalizeRules(config.rules);
  config.boundaryContextMessages = Number(config.boundaryContextMessages ?? 20);
  if (!Number.isInteger(config.boundaryContextMessages) || config.boundaryContextMessages < 0) {
    throw new Error("config.json 中 boundaryContextMessages 必须是大于或等于0的整数");
  }
  return config;
}

export function parseJsonlText(text, source = "transcript") {
  const entries = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim()) continue;
    try {
      entries.push({ record: JSON.parse(raw), line: index + 1, index, raw });
    } catch (error) {
      throw new Error(`${source}:${index + 1} 不是有效JSON：${error.message}`);
    }
  }
  if (!entries.length) throw new Error(`${source} 没有有效记录`);
  return entries;
}

function byUuid(entries) {
  return new Map(entries.filter((entry) => entry.record.uuid).map((entry) => [entry.record.uuid, entry]));
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
    const summary = anchorUuid ? uuidMap.get(anchorUuid) : entries.slice(index + 1).find((item) => item.record.isCompactSummary);
    if (!summary?.record?.isCompactSummary) continue;
    return { boundary: entry, summary, metadata };
  }
  return null;
}

export function reconstructLogicalContext(entries) {
  const uuidMap = byUuid(entries);
  const leafUuid = newestLeafUuid(entries, uuidMap);
  if (!leafUuid) throw new Error("找不到当前会话叶子UUID");
  const physicalChain = chainToRoot(leafUuid, uuidMap);
  const leaf = uuidMap.get(leafUuid);
  const sessionId = leaf?.record?.sessionId;
  const chronologicalSession = entries.filter((entry) => (
    entry.record.uuid
      && (!sessionId || entry.record.sessionId === sessionId)
  ));
  const physicalRoot = physicalChain[0];
  const physicalChainIsComplete = Boolean(
    physicalRoot
      && (!physicalRoot.record.parentUuid || uuidMap.has(physicalRoot.record.parentUuid)),
  );
  const compact = latestCompact(entries, uuidMap);
  if (!compact) {
    // cc-connect 历史可能被人工清理过，导致当前叶子的 parentUuid 链在中途断开。
    // 此时不能只取断点后的几条记录；同一 session 的文件顺序才是可恢复的完整历史。
    const logical = physicalChainIsComplete ? physicalChain : chronologicalSession;
    return {
      compact: null,
      logical,
      currentTail: logical.at(-1),
      uuidMap,
    };
  }

  const preservedIds = compact.metadata.preservedMessages?.uuids || [];
  const preserved = preservedIds.map((uuid) => uuidMap.get(uuid)).filter(Boolean);
  const preservedTailUuid = compact.metadata.preservedSegment?.tailUuid || preserved.at(-1)?.record.uuid;
  let appended = [];

  if (leafUuid !== compact.summary.record.uuid && preservedTailUuid) {
    const tailIndex = physicalChain.findIndex((entry) => entry.record.uuid === preservedTailUuid);
    if (tailIndex >= 0) appended = physicalChain.slice(tailIndex + 1);
    else {
      const anchorIndex = physicalChain.findIndex((entry) => entry.record.uuid === compact.summary.record.uuid);
      if (anchorIndex >= 0) appended = physicalChain.slice(anchorIndex + 1);
      else {
        // 与无 compact 时相同，允许从被人工清理后留下的顺序记录恢复。
        appended = chronologicalSession.filter((entry) => entry.index > compact.summary.index);
      }
    }
  }

  const logical = [compact.summary, ...preserved, ...appended]
    .filter((entry, index, array) => array.findIndex((other) => other.record.uuid === entry.record.uuid) === index);
  return {
    compact,
    logical,
    currentTail: appended.at(-1) || preserved.at(-1) || compact.summary,
    uuidMap,
  };
}

function isHumanUser(entry) {
  return Boolean(visibleUserText(entry));
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

function estimateTextTokens(text) {
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
  if (!record.message) return 4;
  return 8 + estimateTextTokens(JSON.stringify(record.message));
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

export function chooseCompactionPlan(context, now = new Date(), ruleOverrides = {}) {
  const { logical, compact } = context;
  const rules = normalizeRules(ruleOverrides);
  const minimumIntervalMs = rules.minimumHoursSinceLastCompaction * 60 * 60 * 1000;
  const recentRawWindowMs = rules.recentRawHoursToKeep * 60 * 60 * 1000;
  const lastTimestamp = compact ? Date.parse(compact.boundary.record.timestamp || "") : Number.NEGATIVE_INFINITY;
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
        reason: `距离上次处理不足${rules.minimumHoursSinceLastCompaction}小时，当前上下文 ${currentTokens} tokens 未超过${rules.contextTokensTrigger}`,
        currentTokens,
      };
    }
    mode = "token-tail";
    headIndex = chooseTokenHead(logical, rules.recentRawTokensToKeep);
  }

  if (headIndex < 0) return { action: "skip", reason: "找不到可作为保留起点的完整用户消息", currentTokens };
  const prefix = logical.slice(0, headIndex);
  const preservedLogical = logical.slice(headIndex).filter((entry) => !entry.record.isCompactSummary);
  if (!prefix.length) return { action: "skip", reason: "切点以前没有可压缩内容", currentTokens };
  if (!preservedLogical.length) return { action: "skip", reason: "切点以后没有可保留原文", currentTokens };

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

function previousMemoryBody(entries) {
  const record = [...entries].reverse().find((entry) => entry.record.isCompactSummary)?.record;
  const content = typeof record?.message?.content === "string" ? record.message.content.trim() : "";
  if (!content) return "";
  const match = content.match(/<first_person_memory>\s*([\s\S]*?)\s*<\/first_person_memory>/iu);
  return (match?.[1] || content).trim();
}

function formatSummaryMessages(messages, maxMessages = Number.POSITIVE_INFINITY, includeMemoryRefs = false) {
  return messages.slice(0, maxMessages).map((message) => (
    `${includeMemoryRefs ? `[${message.memory_ref}] ` : ""}[${message.timestamp || ""}] ${message.role === "assistant" ? "我" : "对方"}：${message.text}`
  )).join("\n\n");
}

export function assignMemoryRefs(messages = []) {
  return messages.map((message, index) => ({
    ...message,
    memory_ref: `M${String(index + 1).padStart(4, "0")}`,
  }));
}

export function buildLlmInput(config, plan, archivedMessages = null) {
  const rawStandardized = archivedMessages || standardizeCompactedPrefix({
    prefix: plan.prefix,
    userName: config.userName,
    memoryOwner: config.memoryOwner,
  });
  const standardized = assignMemoryRefs(rawStandardized);
  const existingMemory = previousMemoryBody(plan.prefix);
  const conversation = formatSummaryMessages(standardized, Number.POSITIVE_INFINITY, true);
  const boundaryReference = formatSummaryMessages(
    standardizeCompactedPrefix({
      prefix: plan.preservedLogical || [],
      userName: config.userName,
      memoryOwner: config.memoryOwner,
    }),
    Number(config.boundaryContextMessages ?? 20),
  );
  const parts = [
    `记忆拥有者：${config.memoryOwner || "我"}`,
    `对方名字：${config.userName || "对方"}`,
    `本次切分模式：${plan.mode}`,
  ];
  if (existingMemory) parts.push("", "【既有记忆摘要】", "", existingMemory);
  if (conversation) parts.push("", "【需要合并进长期/中期记忆的真实对话】", "", conversation);
  if (boundaryReference) {
    parts.push(
      "",
      "【切点后的衔接参考：不属于摘要范围】",
      "下面内容会由程序作为近期原文完整保留。只能用来判断切点处的事情是否仍在进行；不得把仅在这里发生的进展或结果提前写进摘要。",
      "",
      boundaryReference,
    );
  }
  parts.push(
    "",
    "【输出要求】",
    "只输出一个 JSON 对象，格式为 {\"summary\":\"...\",\"events\":[{\"title\":\"...\",\"text\":\"...\",\"event_date\":\"YYYY-MM-DD|unknown\",\"status\":\"ongoing|resolved|unknown\",\"source_refs\":[\"M0001\"]}]}。summary 是更新后的连续第一人称摘要；events 只能引用带 M0001 这类短编号的本批真实对话。切点后的衔接参考没有编号，绝不能成为事件来源。",
  );
  return parts.join("\n").trim() + "\n";
}

function loadInheritedClaudeEnv() {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  if (!fs.existsSync(settingsPath)) return {};
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return settings.env && typeof settings.env === "object" ? settings.env : {};
  } catch (error) {
    throw new Error(`无法读取 ${settingsPath} 的env：${error.message}`);
  }
}

function stripJsonCodeFence(value) {
  const text = String(value || "").trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return (fenced?.[1] || text).trim();
}

export function parseGeneratedMemoryResult(value) {
  const text = stripJsonCodeFence(value);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`一次性LLM的 result 不是有效JSON：${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("一次性LLM的 result 必须是JSON对象");
  }
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== "events" || keys[1] !== "summary") {
    throw new Error("一次性LLM的 result 只能包含 summary 和 events");
  }
  if (typeof parsed.summary !== "string" || !parsed.summary.trim()) {
    throw new Error("一次性LLM返回了空摘要");
  }
  if (!Array.isArray(parsed.events)) {
    throw new Error("一次性LLM的 events 必须是数组");
  }
  for (const [index, event] of parsed.events.entries()) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new Error(`一次性LLM的 events[${index}] 必须是对象`);
    }
    const eventKeys = Object.keys(event).sort();
    const expected = ["event_date", "source_refs", "status", "text", "title"];
    if (eventKeys.length !== expected.length || eventKeys.some((key, keyIndex) => key !== expected[keyIndex])) {
      throw new Error(`一次性LLM的 events[${index}] 字段必须且只能是 title、text、event_date、status、source_refs`);
    }
    for (const field of ["title", "text", "status"]) {
      if (typeof event[field] !== "string" || !event[field].trim()) {
        throw new Error(`一次性LLM的 events[${index}].${field} 必须是非空字符串`);
      }
    }
    if (!["ongoing", "resolved", "unknown"].includes(event.status)) {
      throw new Error(`一次性LLM的 events[${index}].status 只能是 ongoing、resolved 或 unknown`);
    }
    const eventDate = typeof event.event_date === "string" ? event.event_date : "";
    const parsedEventDate = /^\d{4}-\d{2}-\d{2}$/u.test(eventDate)
      ? new Date(`${eventDate}T00:00:00.000Z`)
      : null;
    if (
      !(/^(?:\d{4}-\d{2}-\d{2}|unknown)$/u.test(eventDate))
      || (parsedEventDate
        && (Number.isNaN(parsedEventDate.getTime()) || parsedEventDate.toISOString().slice(0, 10) !== eventDate))
    ) {
      throw new Error(`一次性LLM的 events[${index}].event_date 必须是有效的 YYYY-MM-DD 或 unknown`);
    }
    if (!Array.isArray(event.source_refs) || !event.source_refs.length) {
      throw new Error(`一次性LLM的 events[${index}].source_refs 必须是非空数组`);
    }
    if (event.source_refs.some((ref) => typeof ref !== "string" || !/^M\d{4}$/u.test(ref))) {
      throw new Error(`一次性LLM的 events[${index}].source_refs 只能包含 M0001 形式的短编号`);
    }
  }
  return {
    summary: parsed.summary.trim(),
    events: parsed.events,
  };
}

function runOneShotLlm(config, input, prompt) {
  const inherited = config.inheritClaudeSettingsEnv === false ? {} : loadInheritedClaudeEnv();
  const env = { ...process.env, ...inherited, ...config.llmEnv };
  if (!env.ANTHROPIC_API_KEY && env.ANTHROPIC_AUTH_TOKEN) env.ANTHROPIC_API_KEY = env.ANTHROPIC_AUTH_TOKEN;

  const cliArgs = [
    ...config.claudeArgs,
    "-p",
    "--bare",
    "--tools", "",
    "--max-turns", "1",
    "--no-session-persistence",
    "--output-format", "json",
    "--system-prompt", prompt,
  ];
  if (config.model) cliArgs.push("--model", String(config.model));

  const startedAt = Date.now();
  const result = spawnSync(config.claudeCommand, cliArgs, {
    cwd: SCRIPT_DIR,
    env,
    input,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw new Error(`无法启动一次性LLM：${result.error.message}`);
  if (result.status !== 0) throw new Error(`一次性LLM失败（${result.status}）：\n${result.stderr || result.stdout}`);

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`一次性LLM没有返回有效JSON：${error.message}\n${result.stdout.slice(0, 2000)}`);
  }
  if (typeof parsed.result !== "string" || !parsed.result.trim()) {
    throw new Error("一次性LLM没有返回有效的 result 文本");
  }
  const memory = parseGeneratedMemoryResult(parsed.result);
  return { ...memory, durationMs: Date.now() - startedAt };
}

function preservedRecords(context, headUuid) {
  const headIndex = context.logical.findIndex((entry) => entry.record.uuid === headUuid);
  if (headIndex < 0) throw new Error("在当前逻辑上下文中找不到选定head，拒绝写入");
  const preserved = context.logical.slice(headIndex).filter((entry) => (
    entry.record.uuid && !entry.record.isCompactSummary
  ));
  if (!preserved.length || preserved[0].record.uuid !== headUuid) {
    throw new Error("无法从选定head构造保留记录，拒绝写入");
  }
  return preserved;
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

function summaryWrapper(config, body) {
  return [
    "This session is being continued from a user-managed memory checkpoint.",
    `以下是${config.memoryOwner || "记忆拥有者"}自己的第一人称长期/中期记忆。“我”指${config.memoryOwner || "记忆拥有者"}，“${config.userName || "对方"}”指对方。`,
    "",
    "<first_person_memory>",
    body.trim(),
    "</first_person_memory>",
    "",
    "本记忆之后保留的是未经摘要的最近原始对话；发生冲突时，以较新的原始对话为准。",
    "直接延续当前关系和话题，不要提及压缩、摘要、JSONL、上下文刷新或重新加载。",
  ].join("\n");
}

export function buildCompactRecords(entries, context, plan, config, summaryBody, now, durationMs = 0) {
  const preserved = preservedRecords(context, plan.head.record.uuid);
  const boundaryUuid = crypto.randomUUID();
  const anchorUuid = crypto.randomUUID();
  const timestamp = now.toISOString();
  const template = context.currentTail || entries.at(-1);
  const shared = commonFields(template);
  if (!shared.sessionId) throw new Error("模板记录没有sessionId");

  const preservedIds = preserved.map((entry) => entry.record.uuid);
  const messagesSummarized = plan.prefix.filter((entry) => entry.record.uuid).length;
  const wrappedSummary = summaryWrapper(config, summaryBody);
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
    summarizeMetadata: {
      messagesSummarized,
      direction: "up_to",
    },
    uuid: anchorUuid,
    timestamp,
  });
  return { boundary, summary, preserved, wrappedSummary };
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function appendWithBackup(transcriptPath, originalText, boundary, summary) {
  if (fs.readFileSync(transcriptPath, "utf8") !== originalText) {
    throw new Error("摘要生成期间主会话 JSONL 发生了变化；本次未写入，请停止聊天后重新运行");
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backupPath = path.join(BACKUP_DIR, `${path.basename(transcriptPath)}.${timestampForFile()}.bak`);
  fs.copyFileSync(transcriptPath, backupPath);
  const prefix = originalText.endsWith("\n") || originalText.endsWith("\r") ? "" : os.EOL;
  const addition = `${prefix}${JSON.stringify(boundary)}${os.EOL}${JSON.stringify(summary)}${os.EOL}`;
  const expectedText = `${originalText}${addition}`;

  try {
    fs.appendFileSync(transcriptPath, addition, "utf8");
    const writtenText = fs.readFileSync(transcriptPath, "utf8");
    if (writtenText !== expectedText) throw new Error("写入后文件内容与预期不一致");
    const verification = parseJsonlText(writtenText, transcriptPath);
    const lastTwo = verification.slice(-2).map((entry) => entry.record);
    if (lastTwo[0]?.uuid !== boundary.uuid || lastTwo[1]?.uuid !== summary.uuid || !lastTwo[1]?.isCompactSummary) {
      throw new Error("追加后的最后两条记录校验失败");
    }
  } catch (error) {
    const currentText = fs.readFileSync(transcriptPath, "utf8");
    if (currentText === originalText || currentText === expectedText) {
      fs.copyFileSync(backupPath, transcriptPath);
      throw new Error(`写入失败，已从备份恢复：${error.message}`);
    }
    throw new Error(`写入失败且主会话同时发生了变化，未自动覆盖；备份位于 ${backupPath}：${error.message}`);
  }
  return { backupPath, expectedText };
}

function rollbackCompactWrite(transcriptPath, expectedText, backupPath, cause) {
  const currentText = fs.readFileSync(transcriptPath, "utf8");
  if (currentText !== expectedText) {
    throw new Error(`RAG 归档失败，且主会话随后又发生了变化，无法安全回滚；备份位于 ${backupPath}：${cause.message}`);
  }
  fs.copyFileSync(backupPath, transcriptPath);
  throw new Error(`RAG 归档失败，主会话 compact 已从备份回滚：${cause.message}`);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = readConfig(args.get("transcript") || "", args.get("config") || "");
  if (!fs.existsSync(config.transcriptPath)) throw new Error(`JSONL不存在：${config.transcriptPath}`);
  if (!fs.existsSync(config.promptFile)) throw new Error(`摘要提示词不存在：${config.promptFile}`);

  const originalText = fs.readFileSync(config.transcriptPath, "utf8");
  const entries = parseJsonlText(originalText, config.transcriptPath);
  const context = reconstructLogicalContext(entries);
  const now = args.has("now") ? new Date(args.get("now")) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error("--now 不是有效时间");
  const plan = chooseCompactionPlan(context, now, config.rules);

  fs.mkdirSync(WORK_DIR, { recursive: true });
  if (plan.action === "skip") {
    const report = { status: "skipped", transcriptPath: config.transcriptPath, ...plan, checkedAt: now.toISOString() };
    writeJson(path.join(WORK_DIR, "last-run.json"), report);
    console.log(plan.reason);
    return report;
  }

  const archivedMessages = standardizeCompactedPrefix({
    prefix: plan.prefix,
    userName: config.userName,
    memoryOwner: config.memoryOwner,
  });
  const referencedArchivedMessages = assignMemoryRefs(archivedMessages);
  const input = buildLlmInput(config, plan, referencedArchivedMessages);
  if (args.get("dry-run") === "true") {
    const report = {
      status: "dry-run",
      transcriptPath: config.transcriptPath,
      mode: plan.mode,
      currentTokens: plan.currentTokens,
      headUuid: plan.head.record.uuid,
      headTimestamp: plan.head.record.timestamp,
      currentTailUuid: context.currentTail.record.uuid,
      prefixRecords: plan.prefix.length,
      inputChars: input.length,
      checkedAt: now.toISOString(),
    };
    writeJson(path.join(WORK_DIR, "last-run.json"), report);
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  let summaryBody;
  let generatedEvents = [];
  let durationMs = 0;
  if (args.has("summary-file")) {
    const summaryPath = resolveLocal(args.get("summary-file"));
    summaryBody = fs.readFileSync(summaryPath, "utf8").trim();
    if (!summaryBody) throw new Error(`摘要文件为空：${summaryPath}`);
  } else {
    const prompt = fs.readFileSync(config.promptFile, "utf8").trim();
    const result = runOneShotLlm(config, input, prompt);
    summaryBody = result.summary;
    generatedEvents = result.events;
    durationMs = result.durationMs;
  }
  const built = buildCompactRecords(entries, context, plan, config, summaryBody, now, durationMs);
  const stagedRag = prepareHistoryAppend(archivedMessages);
  const compactWrite = appendWithBackup(config.transcriptPath, originalText, built.boundary, built.summary);
  let rag;
  try {
    rag = stagedRag.commit();
  } catch (error) {
    rollbackCompactWrite(
      config.transcriptPath,
      compactWrite.expectedText,
      compactWrite.backupPath,
      error,
    );
  }
  let eventMemoriesAdded = 0;
  let eventMemoryWarning = "";
  if (generatedEvents.length) {
    try {
      const ragConfig = loadRagConfig();
      const eventGeneration = ragConfig.eventGeneration || {};
      if (eventGeneration.enabled !== false) {
        const maxEvents = eventGeneration.maxEventsPerCompaction ?? eventGeneration.maxEvents;
        const normalizedEvents = normalizeGeneratedEvents(generatedEvents, referencedArchivedMessages, {
          maxEvents,
          maxEventChars: eventGeneration.maxEventChars,
          compactionBatchUuid: built.boundary.uuid,
        });
        const stagedEvents = prepareEventAppend(normalizedEvents, ragConfig.eventsPath);
        const eventResult = stagedEvents.commit();
        eventMemoriesAdded = Number(eventResult?.added || 0);
        const consideredCount = Number.isInteger(Number(maxEvents)) && Number(maxEvents) > 0
          ? Math.min(generatedEvents.length, Number(maxEvents))
          : generatedEvents.length;
        if (normalizedEvents.length < consideredCount) {
          eventMemoryWarning = `${consideredCount - normalizedEvents.length} 条事件候选因来源引用或内容校验失败而未写入`;
        }
      }
    } catch (error) {
      // 事件记忆是可重新生成的派生数据，失败不能撤销已经完成的 compact 和原文归档。
      eventMemoryWarning = error.message;
    }
  }
  const summaryCopyPath = path.join(WORK_DIR, "latest-summary.md");
  let summaryCopyWarning = "";
  try {
    fs.writeFileSync(summaryCopyPath, `${summaryBody.trim()}\n`, "utf8");
  } catch (error) {
    summaryCopyWarning = error.message;
  }
  let embeddingIndex = { status: "disabled" };
  try {
    const ragConfig = loadRagConfig();
    if (ragConfig.embedding.enabled) {
      embeddingIndex = await syncIndexFromHistory(ragConfig.configPath);
    }
  } catch (error) {
    // 向量层只是辅助召回，失败不能回滚已经完成的压缩和原文入库。
    embeddingIndex = { status: "error", warning: error.message };
  }
  const report = {
    status: "written",
    transcriptPath: config.transcriptPath,
    backupPath: compactWrite.backupPath,
    mode: plan.mode,
    currentTokens: plan.currentTokens,
    headUuid: plan.head.record.uuid,
    headTimestamp: plan.head.record.timestamp,
    tailUuid: built.boundary.compactMetadata.preservedSegment.tailUuid,
    preservedRecords: built.preserved.length,
    summarizedRecords: plan.prefix.length,
    boundaryUuid: built.boundary.uuid,
    summaryUuid: built.summary.uuid,
    summaryChars: built.wrappedSummary.length,
    summaryCopyPath: summaryCopyWarning ? null : summaryCopyPath,
    summaryCopyWarning: summaryCopyWarning || undefined,
    ragMessagesAdded: rag.added,
    eventMemoriesAdded,
    eventMemoryWarning: eventMemoryWarning || undefined,
    embeddingIndex,
    writtenAt: now.toISOString(),
  };
  writeJson(path.join(WORK_DIR, "last-run.json"), report);
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  });
}
