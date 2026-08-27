import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_PRICE_CATALOG,
  calculateCost,
  createPriceCatalog,
  priceCatalogView,
  readUsageEvents,
  readUsageSummary,
  rebuildUsageSummary,
  resolveCatalogModel,
} from "@suzu-lives/cost-ledger";

export const PRICE_CATALOG = DEFAULT_PRICE_CATALOG;

const TIME_ZONE = "Asia/Shanghai";
const MAX_EVENTS = 12_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

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

function existsDirectory(directory) {
  try {
    return Boolean(directory && fs.statSync(directory).isDirectory());
  } catch {
    return false;
  }
}

function usageScope(value = {}, defaultType = "usage") {
  const subjectId = clean(value.subjectId || value.contactId);
  const subjectName = clean(value.subjectName || value.contactName);
  const subjectType = clean(value.subjectType) || defaultType;
  const projectRoot = clean(value.projectRoot);
  const sessionId = clean(value.sessionId);
  if (!subjectId || !subjectName || !projectRoot || !SESSION_ID_PATTERN.test(sessionId)) return null;
  const isContact = subjectType === "contact";
  return {
    subjectId,
    subjectName,
    subjectType,
    contactId: isContact ? clean(value.contactId || subjectId) : "",
    contactName: isContact ? clean(value.contactName || subjectName) : "",
    projectRoot: path.resolve(projectRoot),
    sessionId,
    usageLedgerPath: clean(value.usageLedgerPath),
  };
}

function contactScope(value = {}) {
  return usageScope({ ...value, subjectType: "contact" }, "contact");
}

function normalizedScopes(contactScopes = [], usageScopes = []) {
  const byId = new Map();
  for (const scope of [
    ...(Array.isArray(contactScopes) ? contactScopes.map(contactScope) : []),
    ...(Array.isArray(usageScopes) ? usageScopes.map((value) => usageScope(value)) : []),
  ].filter(Boolean)) {
    byId.set(scope.subjectId, scope);
  }
  return [...byId.values()];
}

function subjectEventFields(subject) {
  return {
    subjectId: clean(subject?.subjectId),
    subjectName: clean(subject?.subjectName) || "未归属计费主体",
    subjectType: clean(subject?.subjectType) || "usage",
    contactId: clean(subject?.contactId),
    contactName: clean(subject?.contactName),
  };
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

function modelProvider(catalog, model) {
  return resolveCatalogModel(catalog, model)?.model?.provider || "未知供应商";
}

function withUnitTotals(units = {}) {
  const normalized = { ...units };
  const detailedInputTokens =
    Number(units.inputUncachedTokens || 0)
    + Number(units.inputCachedTokens || 0)
    + Number(units.inputCacheWriteTokens || 0)
    + Number(units.inputCacheWrite1hTokens || 0)
    + Number(units.inputTextImageVideoTokens || 0)
    + Number(units.inputAudioTokens || 0);
  const inputTokens = detailedInputTokens || Number(units.inputTokens || 0);
  const outputTokens =
    Number(units.outputTextTokens || 0)
    + Number(units.outputAudioTokens || 0)
    + Number(units.outputTokens || 0);
  if (inputTokens > 0) normalized.totalInputTokens = inputTokens;
  if (inputTokens + outputTokens > 0) normalized.totalTokens = inputTokens + outputTokens;
  return normalized;
}

function pricedUsage({
  catalog,
  model,
  usage,
  units,
  timestamp,
  customRevisions,
}) {
  const calculated = calculateCost({
    catalog,
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

async function scanVideoCache(projectRoot, catalog, customRevisions, contact) {
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
      catalog,
      model,
      usage: record.usage,
      timestamp,
      customRevisions,
    });
    result.events.push({
      id: `video:${clean(contact?.subjectId)}:${identity}`,
      timestamp,
      date: dateKey(timestamp),
      ...subjectEventFields(contact),
      source: "视频理解",
      feature: "视频分析",
      provider: modelProvider(catalog, model),
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

async function scanUnifiedLedger(ledgerPath, catalog, customRevisions, contact) {
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
    result.events.push(presentLedgerEvent(event, catalog, customRevisions, contact));
  }
  return result;
}

function presentLedgerEvent(event, catalog, customRevisions, contact) {
  const identity = clean(event?.id) || clean(event?.requestId);
  const cost = pricedUsage({
    catalog,
    model: event?.model,
    usage: event?.usage,
    units: event?.units,
    timestamp: event?.timestamp,
    customRevisions,
  });
  return {
    id: `ledger:${clean(contact?.subjectId)}:${identity}`,
    timestamp: clean(event?.timestamp),
    date: dateKey(event?.timestamp),
    ...subjectEventFields(contact),
    source: clean(event?.source || event?.feature || "统一流水"),
    feature: clean(event?.feature || "API 调用"),
    provider: clean(event?.provider) || modelProvider(catalog, event?.model),
    model: clean(event?.model),
    requestId: clean(event?.requestId),
    turnId: clean(event?.metadata?.turnId),
    turnPrompt: clean(event?.metadata?.turnPrompt || event?.feature).slice(0, 180),
    toolNames: Array.isArray(event?.metadata?.toolNames)
      ? event.metadata.toolNames.map(clean).filter(Boolean)
      : [],
    amountCny: cost.amountCny,
    costStatus: cost.status,
    priceRevision: cost.price,
    units: cost.units,
    metadata: event?.metadata || {},
  };
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
  const detailedInputTokens =
    Number(event.units?.inputUncachedTokens || 0)
    + Number(event.units?.inputCachedTokens || 0)
    + Number(event.units?.inputCacheWriteTokens || 0)
    + Number(event.units?.inputCacheWrite1hTokens || 0)
    + Number(event.units?.inputTextImageVideoTokens || 0)
    + Number(event.units?.inputAudioTokens || 0);
  total.inputTokens += Number(event.units?.totalInputTokens || 0)
    || detailedInputTokens
    || Number(event.units?.inputTokens || 0);
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
      const subjectId = clean(event.subjectId || event.contactId);
      const conversationKey = `${subjectId || "unassigned"}:${event.turnId}`;
      const conversation = conversationMap.get(conversationKey) || {
        subjectId,
        subjectName: clean(event.subjectName || event.contactName) || "未归属计费主体",
        subjectType: clean(event.subjectType) || "usage",
        contactId: clean(event.contactId),
        contactName: clean(event.contactName),
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
      conversationMap.set(conversationKey, conversation);
    }
  }

  const daily = [...dailyMap.values()].sort((left, right) => left.date.localeCompare(right.date));
  const sources = [...sourceMap.values()].sort((left, right) => right.amountCny - left.amountCny);
  const conversations = [...conversationMap.values()]
    .map((item) => ({ ...item, tools: [...item.tools] }))
    .sort((left, right) => right.amountCny - left.amountCny);
  return { all, today: todayTotal, month: monthTotal, daily, sources, conversations };
}

function sourceStatus(scans = []) {
  const ledgerEvents = scans.flatMap((scan) => Array.isArray(scan.ledger?.events) ? scan.ledger.events : []);
  const videoEvents = scans.flatMap((scan) => Array.isArray(scan.video?.events) ? scan.video.events : []);
  const subjectCount = new Set(scans.map((scan) => clean(scan.subjectId)).filter(Boolean)).size;
  const firstSourcePath = (key) => scans.map((scan) => clean(scan[key]?.path)).find(Boolean) || "";
  const eventCount = (matches, extraEvents = []) => {
    const identities = new Set();
    for (const event of [...ledgerEvents, ...extraEvents]) {
      if (!matches(event || {})) continue;
      const localIdentity = clean(event.requestId) || clean(event.id) || [
        clean(event.timestamp),
        clean(event.source),
        clean(event.feature),
        clean(event.model),
      ].join(":");
      identities.add(`${clean(event.subjectId || event.contactId)}:${localIdentity}`);
    }
    return identities.size;
  };
  const connected = ({ id, name, count, sourcePath = firstSourcePath("ledger") }) => ({
    id,
    name,
    status: "ready",
    detail: `${subjectCount} 个计费主体${count ? `，已记录 ${count} 次调用。` : "，已接入；等待首次调用记录。"}`,
    path: sourcePath,
    tracked: true,
  });
  return [
    connected({
      id: "unified-ledger",
      name: "统一计费流水",
      count: ledgerEvents.length,
    }),
    connected({
      id: "agent-core-session-meter",
      name: "Agent Core 会话费用",
      count: eventCount((event) => ["agent-chat", "agent-compaction"].includes(clean(event.feature))),
    }),
    connected({
      id: "video-understanding",
      name: "视频理解",
      count: eventCount((event) => clean(event.source) === "视频理解" || clean(event.feature) === "video-understanding", videoEvents),
      sourcePath: firstSourcePath("video") || firstSourcePath("ledger"),
    }),
    connected({
      id: "image-vision",
      name: "图片理解",
      count: eventCount((event) => clean(event.source) === "图片识别" || clean(event.feature) === "image-vision"),
    }),
    connected({
      id: "image-generation",
      name: "图片生成",
      count: eventCount((event) => clean(event.source) === "图片生成" || clean(event.feature).startsWith("image-")),
    }),
    connected({
      id: "tts",
      name: "语音合成",
      count: eventCount((event) => clean(event.source) === "语音合成" || ["voice-message-tts", "realtime-voice-call-tts"].includes(clean(event.feature))),
    }),
    connected({
      id: "realtime-asr",
      name: "实时语音识别",
      count: eventCount((event) => clean(event.feature) === "realtime-voice-call-asr"),
    }),
    connected({
      id: "compactor",
      name: "记忆整理",
      count: eventCount((event) => ["memory-compactor", "memory-structurer"].includes(clean(event.source))),
    }),
    connected({
      id: "memory-vector",
      name: "记忆向量",
      count: eventCount((event) => ["memory-embedding-indexer", "memory-retriever"].includes(clean(event.source)) || clean(event.feature).endsWith("-embedding")),
    }),
    connected({
      id: "memory-analysis",
      name: "记忆分析",
      count: eventCount((event) => clean(event.source) === "memory-evaluation"),
    }),
  ];
}

function mergeEvents(...eventGroups) {
  const byIdentity = new Map();
  for (const events of eventGroups) {
    for (const event of events) {
      if (!event?.timestamp) continue;
      const scope = clean(event.subjectId || event.contactId) || "unassigned";
      const identity = event.requestId
        ? `request:${scope}:${event.model}:${event.requestId}`
        : `event:${scope}:${event.id}`;
      byIdentity.set(identity, event);
    }
  }
  return [...byIdentity.values()]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-MAX_EVENTS);
}

async function readTodayUnifiedLedgerSummary(ledgerPath, catalog, customRevisions, contact, today) {
  const stored = await readUsageSummary(ledgerPath, { timeZone: TIME_ZONE });
  const needsRefresh = stored.status === "stale"
    || (stored.status === "missing" && Number(stored.ledgerByteLength || 0) > 0);
  const present = (event) => presentLedgerEvent(event, catalog, customRevisions, contact);
  return {
    ...stored,
    needsRefresh,
    todayEvents: Array.isArray(stored.days?.[today]) ? stored.days[today].map(present) : [],
    recentEvents: Array.isArray(stored.recentEvents) ? stored.recentEvents.map(present) : [],
  };
}

/**
 * Lightweight data for the home dashboard.  It reads compact per-ledger
 * summaries only; detailed history and legacy video-cache recovery stay in
 * scanCostLedger and run when the user opens the usage page.
 */
export async function readTodayCostLedger(settings = {}, { contactScopes = [], usageScopes = [] } = {}) {
  const startedAt = Date.now();
  const catalog = createPriceCatalog({ customPriceModels: settings.customPriceModels || [] });
  const customRevisions = settings.priceRevisions || [];
  const today = dateKey(new Date());
  const subjects = normalizedScopes(contactScopes, usageScopes);
  if (!subjects.length) {
    return {
      status: "needs-project",
      today,
      contactScopes: [],
      usageScopes: [],
      events: [],
      summary: { today: emptyTotal() },
      needsRefresh: false,
      warning: "没有可统计的计费主体。",
    };
  }
  const ledgers = await Promise.all(subjects.map((subject) => readTodayUnifiedLedgerSummary(
    subject.usageLedgerPath,
    catalog,
    customRevisions,
    subject,
    today,
  )));
  const todayEvents = mergeEvents(...ledgers.map((ledger) => ledger.todayEvents));
  const recentEvents = mergeEvents(...ledgers.map((ledger) => ledger.recentEvents));
  const totals = summarize(todayEvents, today);
  const needsRefresh = ledgers.some((ledger) => ledger.needsRefresh);
  return {
    status: needsRefresh ? "warming" : "ready",
    contactScopes: subjects
      .filter((subject) => subject.subjectType === "contact")
      .map((subject) => ({ contactId: subject.contactId, contactName: subject.contactName })),
    usageScopes: subjects.map((subject) => ({
      subjectId: subject.subjectId,
      subjectName: subject.subjectName,
      subjectType: subject.subjectType,
    })),
    today,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    events: recentEvents,
    summary: {
      all: totals.today,
      today: totals.today,
      month: totals.today,
      daily: [{ date: today, ...totals.today }],
      sources: [],
      conversations: [],
    },
    needsRefresh,
    warning: "",
  };
}

/**
 * One-time repair path for old JSONL files that predate the summary sidecar.
 * It is intentionally separate from readTodayCostLedger so opening the app
 * never performs an unbounded scan merely to paint the home screen.
 */
export async function warmTodayCostLedger(settings = {}, { contactScopes = [], usageScopes = [] } = {}) {
  const subjects = normalizedScopes(contactScopes, usageScopes);
  await Promise.all(subjects.map(async (subject) => {
    const current = await readUsageSummary(subject.usageLedgerPath, { timeZone: TIME_ZONE });
    const requiresRebuild = current.status === "stale"
      || (current.status === "missing" && Number(current.ledgerByteLength || 0) > 0);
    if (!requiresRebuild) return null;
    return rebuildUsageSummary(subject.usageLedgerPath, { timeZone: TIME_ZONE });
  }));
  return readTodayCostLedger(settings, { contactScopes, usageScopes });
}

export async function scanCostLedger(settings = {}, { contactScopes = [], usageScopes = [] } = {}) {
  const startedAt = Date.now();
  const catalog = createPriceCatalog({ customPriceModels: settings.customPriceModels || [] });
  const customRevisions = settings.priceRevisions || [];
  const today = dateKey(new Date());
  const priceCatalog = priceCatalogView({
    catalog,
    customRevisions,
  });
  const subjects = normalizedScopes(contactScopes, usageScopes);
  if (!subjects.length) {
    return {
      status: "needs-project",
      today,
      contactScopes: [],
      usageScopes: [],
      priceCatalog,
      warning: "没有可统计的计费主体。",
    };
  }

  const scans = await Promise.all(subjects.map(async (subject) => {
    const [video, ledger] = await Promise.all([
      scanVideoCache(subject.projectRoot, catalog, customRevisions, subject),
      scanUnifiedLedger(subject.usageLedgerPath, catalog, customRevisions, subject),
    ]);
    return { ...subject, video, ledger };
  }));
  const events = mergeEvents(...scans.flatMap((scan) => [scan.video.events, scan.ledger.events]));
  const agentCoreEvents = events.filter((event) => ["agent-chat", "agent-compaction"].includes(clean(event.feature)));
  const summary = summarize(events, today);
  const sum = (key, field) => scans.reduce((total, scan) => total + Number(scan[key]?.[field] || 0), 0);
  return {
    status: "ready",
    contactScopes: scans
      .filter((scan) => scan.subjectType === "contact")
      .map((scan) => ({ contactId: scan.contactId, contactName: scan.contactName })),
    usageScopes: scans.map((scan) => ({
      subjectId: scan.subjectId,
      subjectName: scan.subjectName,
      subjectType: scan.subjectType,
    })),
    today,
    currentMonth: monthKey(new Date()),
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    events,
    summary,
    sources: sourceStatus(scans),
    diagnostics: {
      transcript: {
        status: "ready",
        scannedRecords: agentCoreEvents.length,
        malformedLines: 0,
        duplicateUsageRecords: 0,
      },
      video: {
        scannedFiles: sum("video", "scannedFiles"),
        duplicateRequests: sum("video", "duplicateRequests"),
      },
      ledger: {
        scannedLines: sum("ledger", "scannedLines"),
        malformedLines: sum("ledger", "malformedLines"),
        duplicateRequests: sum("ledger", "duplicateRequests"),
      },
    },
    priceCatalog,
    warning: "",
  };
}
