import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { resolveTranscriptPath } from "@suzu-lives/agent-registry";
import {
  DEFAULT_PRICE_CATALOG,
  calculateCost,
  priceCatalogView,
  readUsageEvents,
  resolveCatalogModel,
} from "@suzu-lives/cost-ledger";

export const PRICE_CATALOG = DEFAULT_PRICE_CATALOG;

const TIME_ZONE = "Asia/Shanghai";
const MAX_EVENTS = 12_000;
const META_PROMPT = /^(?:<system-reminder>|你知道现在是|你想起了之前的片段|你想起了之前|下面是与眼前话题|Context:|Skill root)/iu;

function clean(value) {
  return String(value ?? "").trim();
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
  } catch {
    return fallback;
  }
}

function existsFile(filePath) {
  try {
    return Boolean(filePath && fs.statSync(filePath).isFile());
  } catch {
    return false;
  }
}

function existsDirectory(directory) {
  try {
    return Boolean(directory && fs.statSync(directory).isDirectory());
  } catch {
    return false;
  }
}

function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function monthKey(value) {
  return dateKey(value).slice(0, 7);
}

function visibleText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text")
    .map((block) => clean(block.text))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function promptPreview(record) {
  if (record?.type !== "user" || record?.message?.role !== "user") return "";
  const text = visibleText(record.message.content);
  if (!text || META_PROMPT.test(text)) return "";
  return text.replace(/\s+/gu, " ").slice(0, 180);
}

function assistantShape(record) {
  const content = Array.isArray(record?.message?.content) ? record.message.content : [];
  const toolNames = content
    .filter((block) => block?.type === "tool_use")
    .map((block) => clean(block.name))
    .filter(Boolean);
  const hasText = content.some((block) => block?.type === "text" && clean(block.text));
  return {
    kind: toolNames.length ? "工具循环" : hasText ? "回复" : "模型调用",
    toolNames,
  };
}

function modelProvider(model) {
  return resolveCatalogModel(PRICE_CATALOG, model)?.model?.provider || "未知供应商";
}

function withUnitTotals(units = {}) {
  const normalized = { ...units };
  const inputTokens =
    Number(units.inputUncachedTokens || 0)
    + Number(units.inputCachedTokens || 0)
    + Number(units.inputTextImageVideoTokens || 0)
    + Number(units.inputAudioTokens || 0)
    + Number(units.inputTokens || 0);
  const outputTokens =
    Number(units.outputTextTokens || 0)
    + Number(units.outputAudioTokens || 0)
    + Number(units.outputTokens || 0);
  if (inputTokens > 0) normalized.totalInputTokens = inputTokens;
  if (inputTokens + outputTokens > 0) normalized.totalTokens = inputTokens + outputTokens;
  return normalized;
}

function pricedUsage({
  model,
  usage,
  units,
  timestamp,
  customRevisions,
}) {
  const calculated = calculateCost({
    catalog: PRICE_CATALOG,
    customRevisions,
    model,
    usage,
    units,
    timestamp,
  });
  return {
    ...calculated,
    units: withUnitTotals(calculated.units),
  };
}

export { resolveTranscriptPath };

async function scanTranscript(transcriptPath, customRevisions) {
  const result = {
    status: "missing",
    path: transcriptPath || "",
    scannedRecords: 0,
    malformedLines: 0,
    duplicateUsageRecords: 0,
    events: [],
    warning: "",
  };
  if (!existsFile(transcriptPath)) {
    result.warning = "没有找到主会话 JSONL。";
    return result;
  }

  const records = [];
  const input = fs.createReadStream(transcriptPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const value = line.trim().replace(/^\uFEFF/u, "");
    if (!value) continue;
    try {
      records.push(JSON.parse(value));
      result.scannedRecords += 1;
    } catch {
      result.malformedLines += 1;
    }
  }

  const seen = new Set();
  let activeTurn = { id: "", prompt: "未识别的会话轮次", timestamp: "" };
  for (const record of records) {
    const preview = promptPreview(record);
    if (preview) {
      activeTurn = {
        id: clean(record.uuid) || `user:${record.timestamp || result.scannedRecords}`,
        prompt: preview,
        timestamp: clean(record.timestamp),
      };
    }
    const usage = record?.message?.usage;
    if (record?.type !== "assistant" || !usage) continue;
    const identity = clean(record.uuid || record.message?.id);
    if (!identity) continue;
    if (seen.has(identity)) {
      result.duplicateUsageRecords += 1;
      continue;
    }
    seen.add(identity);
    const model = clean(record.message?.model);
    const cost = pricedUsage({
      model,
      usage,
      timestamp: record.timestamp,
      customRevisions,
    });
    const shape = assistantShape(record);
    result.events.push({
      id: `transcript:${identity}`,
      timestamp: clean(record.timestamp),
      date: dateKey(record.timestamp),
      source: "主会话",
      feature: shape.kind,
      provider: modelProvider(model),
      model,
      requestId: clean(record.message?.id),
      turnId: activeTurn.id,
      turnPrompt: activeTurn.prompt,
      toolNames: shape.toolNames,
      amountCny: cost.amountCny,
      costStatus: cost.status,
      priceRevision: cost.price,
      units: cost.units || {
        inputCacheMissTokens: Number(usage.input_tokens || 0),
        inputCacheHitTokens: Number(usage.cache_read_input_tokens || 0),
        outputTokens: Number(usage.output_tokens || 0),
      },
    });
  }
  result.status = "ready";
  result.path = path.resolve(transcriptPath);
  return result;
}

async function listJsonFiles(directory) {
  if (!existsDirectory(directory)) return [];
  const files = [];
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listJsonFiles(filePath));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) files.push(filePath);
  }
  return files;
}

async function scanVideoCache(projectRoot, customRevisions) {
  const directory = path.join(
    projectRoot,
    "scripts",
    "abilities",
    "video-understanding",
    "runtime",
    "cache",
  );
  const result = {
    status: existsDirectory(directory) ? "ready" : "missing",
    path: directory,
    scannedFiles: 0,
    duplicateRequests: 0,
    events: [],
    warning: "",
  };
  if (result.status === "missing") {
    result.warning = "没有找到视频理解缓存；这不代表没有产生过视频费用。";
    return result;
  }

  const seen = new Set();
  for (const filePath of await listJsonFiles(directory)) {
    result.scannedFiles += 1;
    const record = readJson(filePath, null);
    if (!record || record.status !== "ok" || !record.usage) continue;
    const requestId = clean(record.requestId);
    const identity = requestId || clean(record.cacheKey) || path.basename(filePath);
    if (seen.has(identity)) {
      result.duplicateRequests += 1;
      continue;
    }
    seen.add(identity);
    const stat = await fsp.stat(filePath);
    const timestamp = stat.mtime.toISOString();
    const model = clean(record.responseModel || record.model);
    const cost = pricedUsage({
      model,
      usage: record.usage,
      timestamp,
      customRevisions,
    });
    result.events.push({
      id: `video:${identity}`,
      timestamp,
      date: dateKey(timestamp),
      source: "视频理解",
      feature: clean(record.source).startsWith("douyin:") ? "抖音视频" : "视频分析",
      provider: modelProvider(model),
      model,
      requestId,
      turnId: "",
      turnPrompt: clean(record.source || "视频理解调用").slice(0, 180),
      toolNames: [],
      amountCny: cost.amountCny,
      costStatus: cost.status,
      priceRevision: cost.price,
      units: cost.units || record.usage,
      media: {
        durationSeconds: Number(record.durationSeconds || 0),
        fps: Number(record.fps || 0),
      },
    });
  }
  return result;
}

async function scanUnifiedLedger(ledgerPath, customRevisions) {
  const stored = await readUsageEvents(ledgerPath, { limit: MAX_EVENTS });
  const result = {
    ...stored,
    duplicateRequests: 0,
    warning: "",
    events: [],
  };
  if (stored.status === "missing") {
    result.warning = "统一流水已启用，尚未有功能写入调用记录。";
    return result;
  }

  const seen = new Set();
  for (const event of stored.events) {
    const identity = clean(event.id) || clean(event.requestId);
    if (!identity || seen.has(identity)) {
      result.duplicateRequests += 1;
      continue;
    }
    seen.add(identity);
    const cost = pricedUsage({
      model: event.model,
      usage: event.usage,
      units: event.units,
      timestamp: event.timestamp,
      customRevisions,
    });
    result.events.push({
      id: `ledger:${identity}`,
      timestamp: clean(event.timestamp),
      date: dateKey(event.timestamp),
      source: clean(event.source || event.feature || "统一流水"),
      feature: clean(event.feature || "API 调用"),
      provider: clean(event.provider) || modelProvider(event.model),
      model: clean(event.model),
      requestId: clean(event.requestId),
      turnId: clean(event.metadata?.turnId),
      turnPrompt: clean(event.metadata?.turnPrompt || event.feature).slice(0, 180),
      toolNames: Array.isArray(event.metadata?.toolNames)
        ? event.metadata.toolNames.map(clean).filter(Boolean)
        : [],
      amountCny: cost.amountCny,
      costStatus: cost.status,
      priceRevision: cost.price,
      units: cost.units,
      metadata: event.metadata || {},
    });
  }
  return result;
}

function emptyTotal() {
  return {
    amountCny: 0,
    requestCount: 0,
    knownRequestCount: 0,
    unknownRequestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function addEvent(total, event) {
  total.requestCount += 1;
  if (Number.isFinite(event.amountCny)) {
    total.amountCny += event.amountCny;
    total.knownRequestCount += 1;
  } else {
    total.unknownRequestCount += 1;
  }
  total.inputTokens +=
    Number(event.units?.totalInputTokens || 0)
    || (
      Number(event.units?.inputUncachedTokens || 0)
      + Number(event.units?.inputCachedTokens || 0)
      + Number(event.units?.inputTextImageVideoTokens || 0)
      + Number(event.units?.inputAudioTokens || 0)
      + Number(event.units?.inputTokens || 0)
    );
  total.outputTokens +=
    Number(event.units?.outputTokens || 0)
    + Number(event.units?.outputTextTokens || 0)
    + Number(event.units?.outputAudioTokens || 0);
}

function summarize(events, today) {
  const dailyMap = new Map();
  const sourceMap = new Map();
  const conversationMap = new Map();
  const all = emptyTotal();
  const todayTotal = emptyTotal();
  const monthTotal = emptyTotal();
  const currentMonth = today.slice(0, 7);

  for (const event of events) {
    addEvent(all, event);
    if (event.date === today) addEvent(todayTotal, event);
    if (event.date.startsWith(currentMonth)) addEvent(monthTotal, event);

    const daily = dailyMap.get(event.date) || { date: event.date, ...emptyTotal() };
    addEvent(daily, event);
    dailyMap.set(event.date, daily);

    const source = sourceMap.get(event.source) || { source: event.source, ...emptyTotal() };
    addEvent(source, event);
    sourceMap.set(event.source, source);

    if (event.turnId) {
      const conversation = conversationMap.get(event.turnId) || {
        turnId: event.turnId,
        prompt: event.turnPrompt || "未识别的会话轮次",
        firstAt: event.timestamp,
        lastAt: event.timestamp,
        tools: new Set(),
        ...emptyTotal(),
      };
      addEvent(conversation, event);
      conversation.lastAt = event.timestamp;
      for (const tool of event.toolNames || []) conversation.tools.add(tool);
      conversationMap.set(event.turnId, conversation);
    }
  }

  const daily = [...dailyMap.values()].sort((left, right) => left.date.localeCompare(right.date));
  const sources = [...sourceMap.values()].sort((left, right) => right.amountCny - left.amountCny);
  const conversations = [...conversationMap.values()]
    .map((item) => ({ ...item, tools: [...item.tools] }))
    .sort((left, right) => right.amountCny - left.amountCny);
  return { all, today: todayTotal, month: monthTotal, daily, sources, conversations };
}

function sourceStatus(transcript, video, ledger) {
  const ledgerEvents = Array.isArray(ledger.events) ? ledger.events : [];
  const instrumented = (name, features, emptyDetail) => {
    const featureSet = new Set(features);
    const count = ledgerEvents.filter((event) => featureSet.has(event.feature)).length;
    return {
      name,
      status: "ready",
      detail: count ? `${count} 次统一流水记录` : emptyDetail,
      path: ledger.path,
      tracked: true,
    };
  };
  return [
    {
      id: "unified-ledger",
      name: "统一计费流水",
      status: ledger.status,
      detail: ledger.status === "ready"
        ? `${ledger.events.length} 次统一记录`
        : ledger.warning,
      path: ledger.path,
      tracked: true,
    },
    {
      id: "main-transcript",
      name: "主会话",
      status: transcript.status,
      detail: transcript.status === "ready"
        ? `${transcript.events.length} 次模型请求`
        : transcript.warning,
      path: transcript.path,
      tracked: true,
    },
    {
      id: "video-understanding",
      name: "视频理解",
      status: video.status,
      detail: video.status === "ready" ? `${video.events.length} 次历史请求` : video.warning,
      path: video.path,
      tracked: true,
    },
    {
      id: "rag",
      ...instrumented(
        "RAG 向量",
        ["rag-embedding-index", "rag-embedding-query"],
        "已接入；下一次建库或召回后开始记录。",
      ),
    },
    {
      id: "image-vision",
      ...instrumented(
        "图片识别",
        ["image-vision"],
        "已接入；下一次识图后开始记录。",
      ),
    },
    {
      id: "image-generation",
      ...instrumented(
        "图片生成",
        ["image-generation", "image-edit"],
        "已接入；未配置单价的模型会保留调用量并显示未知金额。",
      ),
    },
    {
      id: "tts",
      ...instrumented(
        "语音合成",
        ["voice-message-tts"],
        "已接入；下一次成功合成后按字符数记录。",
      ),
    },
    {
      id: "compactor",
      ...instrumented(
        "记忆压缩器",
        ["memory-compaction"],
        "已接入；下一次压缩后开始记录，失败但已产生 usage 的请求也会保留。",
      ),
    },
    {
      id: "voice-design",
      ...instrumented(
        "音色设计",
        ["voice-design"],
        "已接入；未配置单价时保留调用量并显示未知金额。",
      ),
    },
  ];
}

function mergeEvents(...eventGroups) {
  const byIdentity = new Map();
  for (const events of eventGroups) {
    for (const event of events) {
      if (!event?.timestamp) continue;
      const identity = event.requestId
        ? `request:${event.model}:${event.requestId}`
        : `event:${event.id}`;
      byIdentity.set(identity, event);
    }
  }
  return [...byIdentity.values()]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-MAX_EVENTS);
}

export async function scanCostLedger(settings = {}, { homeDirectory } = {}) {
  const startedAt = Date.now();
  const projectRoot = clean(settings.projectRoot);
  const customRevisions = settings.priceRevisions || [];
  const usageLedgerPath = clean(settings.usageLedgerPath);
  const today = dateKey(new Date());
  const priceCatalog = priceCatalogView({
    catalog: PRICE_CATALOG,
    customRevisions,
  });
  if (!projectRoot || !existsDirectory(projectRoot)) {
    return {
      status: "needs-project",
      projectRoot,
      transcriptPath: "",
      today,
      usageLedgerPath,
      priceCatalog,
      warning: "请选择有效的 Agent 工作目录。",
    };
  }

  const transcriptResolution = await resolveTranscriptPath(projectRoot, { homeDirectory });
  const [transcript, video, ledger] = await Promise.all([
    scanTranscript(transcriptResolution.path, customRevisions),
    scanVideoCache(projectRoot, customRevisions),
    scanUnifiedLedger(usageLedgerPath, customRevisions),
  ]);
  const events = mergeEvents(transcript.events, video.events, ledger.events);
  const summary = summarize(events, today);
  return {
    status: "ready",
    projectRoot: path.resolve(projectRoot),
    transcriptPath: transcript.path,
    transcriptSource: transcriptResolution.source,
    usageLedgerPath,
    today,
    currentMonth: monthKey(new Date()),
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    events,
    summary,
    sources: sourceStatus(transcript, video, ledger),
    diagnostics: {
      transcript: {
        scannedRecords: transcript.scannedRecords,
        malformedLines: transcript.malformedLines,
        duplicateUsageRecords: transcript.duplicateUsageRecords,
      },
      video: {
        scannedFiles: video.scannedFiles,
        duplicateRequests: video.duplicateRequests,
      },
      ledger: {
        scannedLines: ledger.scannedLines,
        malformedLines: ledger.malformedLines,
        duplicateRequests: ledger.duplicateRequests,
      },
    },
    priceCatalog,
    warning: transcript.status !== "ready"
      ? "主会话尚未接入；当前总额不包含 DeepSeek 对话费用。"
      : "",
  };
}
