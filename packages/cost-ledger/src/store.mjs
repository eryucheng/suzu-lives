import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

import {
  DEFAULT_PRICE_CATALOG,
  resolveCatalogModel,
} from "./catalog.mjs";
import { normalizeUsage } from "./calculator.mjs";

const USAGE_SUMMARY_SCHEMA_VERSION = 1;
const DEFAULT_SUMMARY_TIME_ZONE = "Asia/Shanghai";
const DEFAULT_SUMMARY_DAY_COUNT = 8;
const DEFAULT_RECENT_EVENT_LIMIT = 24;
const usageWriteQueues = new Map();

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function validTimestamp(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString();
}

function isUsageEvent(value) {
  return value?.schemaVersion === 1
    && clean(value.id)
    && clean(value.timestamp)
    && clean(value.model);
}

function usageEventIdentity(event) {
  return clean(event?.id)
    || clean(event?.requestId)
    || [
      clean(event?.timestamp),
      clean(event?.model),
      clean(event?.feature),
    ].join(":");
}

function timeZoneDateKey(value, timeZone = DEFAULT_SUMMARY_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${byType.year}-${byType.month}-${byType.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function summaryDayKeys({
  dayCount = DEFAULT_SUMMARY_DAY_COUNT,
  now = new Date(),
  timeZone = DEFAULT_SUMMARY_TIME_ZONE,
} = {}) {
  const count = Number.isSafeInteger(dayCount) && dayCount > 0 ? dayCount : DEFAULT_SUMMARY_DAY_COUNT;
  const result = new Set();
  for (let offset = 0; offset < count; offset += 1) {
    result.add(timeZoneDateKey(new Date(now.getTime() - offset * 86_400_000), timeZone));
  }
  result.delete("");
  return result;
}

function usageSummaryPath(ledgerPath) {
  const destination = path.resolve(ledgerPath);
  const extension = path.extname(destination);
  const basename = extension ? path.basename(destination, extension) : path.basename(destination);
  return path.join(path.dirname(destination), `${basename}.summary.json`);
}

function normalizeStoredSummary(value, {
  dayCount = DEFAULT_SUMMARY_DAY_COUNT,
  now = new Date(),
  recentLimit = DEFAULT_RECENT_EVENT_LIMIT,
  timeZone = DEFAULT_SUMMARY_TIME_ZONE,
} = {}) {
  if (!value || value.schemaVersion !== USAGE_SUMMARY_SCHEMA_VERSION) return null;
  const ledgerByteLength = Number(value.ledgerByteLength);
  if (!Number.isSafeInteger(ledgerByteLength) || ledgerByteLength < 0) return null;
  const retainedDays = summaryDayKeys({ dayCount, now, timeZone });
  const days = {};
  for (const [date, events] of Object.entries(plainObject(value.days))) {
    if (!retainedDays.has(date)) continue;
    const unique = new Map();
    for (const event of Array.isArray(events) ? events : []) {
      if (!isUsageEvent(event)) continue;
      unique.set(usageEventIdentity(event), event);
    }
    days[date] = [...unique.values()].sort((left, right) => clean(left.timestamp).localeCompare(clean(right.timestamp)));
  }
  const recent = new Map();
  for (const event of Array.isArray(value.recentEvents) ? value.recentEvents : []) {
    if (!isUsageEvent(event)) continue;
    recent.set(usageEventIdentity(event), event);
  }
  const recentEvents = [...recent.values()]
    .sort((left, right) => clean(left.timestamp).localeCompare(clean(right.timestamp)))
    .slice(-Math.max(1, Number(recentLimit) || DEFAULT_RECENT_EVENT_LIMIT));
  return {
    schemaVersion: USAGE_SUMMARY_SCHEMA_VERSION,
    ledgerByteLength,
    updatedAt: clean(value.updatedAt),
    days,
    recentEvents,
  };
}

function appendSnapshotEvent(snapshot, event, {
  dayCount = DEFAULT_SUMMARY_DAY_COUNT,
  now = new Date(),
  recentLimit = DEFAULT_RECENT_EVENT_LIMIT,
  timeZone = DEFAULT_SUMMARY_TIME_ZONE,
} = {}) {
  const retainedDays = summaryDayKeys({ dayCount, now, timeZone });
  const days = {};
  for (const [date, entries] of Object.entries(plainObject(snapshot?.days))) {
    if (!retainedDays.has(date)) continue;
    days[date] = Array.isArray(entries) ? [...entries] : [];
  }
  const day = timeZoneDateKey(event.timestamp, timeZone);
  if (retainedDays.has(day)) {
    const indexed = new Map((days[day] || []).map((entry) => [usageEventIdentity(entry), entry]));
    indexed.set(usageEventIdentity(event), event);
    days[day] = [...indexed.values()].sort((left, right) => clean(left.timestamp).localeCompare(clean(right.timestamp)));
  }
  const recent = new Map((Array.isArray(snapshot?.recentEvents) ? snapshot.recentEvents : [])
    .map((entry) => [usageEventIdentity(entry), entry]));
  recent.set(usageEventIdentity(event), event);
  return {
    schemaVersion: USAGE_SUMMARY_SCHEMA_VERSION,
    ledgerByteLength: Number(snapshot?.ledgerByteLength) || 0,
    updatedAt: new Date().toISOString(),
    days,
    recentEvents: [...recent.values()]
      .sort((left, right) => clean(left.timestamp).localeCompare(clean(right.timestamp)))
      .slice(-Math.max(1, Number(recentLimit) || DEFAULT_RECENT_EVENT_LIMIT)),
  };
}

async function readStoredSummary(summaryPath, options = {}) {
  try {
    const text = await fsp.readFile(summaryPath, "utf8");
    return normalizeStoredSummary(JSON.parse(text.replace(/^\uFEFF/u, "")), options);
  } catch {
    return null;
  }
}

async function writeStoredSummary(summaryPath, snapshot) {
  const temporaryPath = `${summaryPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, "utf8");
    await fsp.rename(temporaryPath, summaryPath);
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function queueUsageWrite(destination, work) {
  const previous = usageWriteQueues.get(destination) || Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  usageWriteQueues.set(destination, next);
  void next.finally(() => {
    if (usageWriteQueues.get(destination) === next) usageWriteQueues.delete(destination);
  }).catch(() => undefined);
  return next;
}

async function appendToStoredSummary(destination, event, {
  afterByteLength,
  beforeByteLength,
  dayCount,
  now,
  recentLimit,
  timeZone,
} = {}) {
  const summaryPath = usageSummaryPath(destination);
  const options = { dayCount, now, recentLimit, timeZone };
  let snapshot = await readStoredSummary(summaryPath, options);
  if (!snapshot) {
    // A newly-created ledger can be indexed from its first record.  For an
    // existing historical ledger, wait for the explicit lazy rebuild so this
    // sidecar never pretends that it contains records it has not seen.
    if (beforeByteLength !== 0) return false;
    snapshot = {
      schemaVersion: USAGE_SUMMARY_SCHEMA_VERSION,
      ledgerByteLength: 0,
      updatedAt: "",
      days: {},
      recentEvents: [],
    };
  }
  if (snapshot.ledgerByteLength !== beforeByteLength) return false;
  const next = appendSnapshotEvent(snapshot, event, options);
  next.ledgerByteLength = afterByteLength;
  await writeStoredSummary(summaryPath, next);
  return true;
}

export function createUsageEvent(input = {}, catalog = DEFAULT_PRICE_CATALOG) {
  const model = clean(input.model);
  const feature = clean(input.feature);
  if (!model) throw new TypeError("model is required");
  if (!feature) throw new TypeError("feature is required");
  const usage = plainObject(input.usage);
  const units = Object.keys(plainObject(input.units)).length
    ? plainObject(input.units)
    : normalizeUsage(model, usage);
  const catalogModel = resolveCatalogModel(catalog, model);
  return {
    schemaVersion: 1,
    id: clean(input.id) || randomUUID(),
    timestamp: validTimestamp(input.timestamp),
    agentId: clean(input.agentId),
    provider: clean(input.provider) || catalogModel?.model?.provider || "",
    model,
    source: clean(input.source) || feature,
    feature,
    requestId: clean(input.requestId),
    usage,
    units: Object.fromEntries(
      Object.entries(units)
        .map(([key, value]) => [key, Number(value)])
        .filter(([, value]) => Number.isFinite(value) && value >= 0),
    ),
    metadata: plainObject(input.metadata),
  };
}

export async function appendUsageEvent(ledgerPath, input, catalog = DEFAULT_PRICE_CATALOG) {
  const destination = path.resolve(ledgerPath);
  const event = createUsageEvent(input, catalog);
  return queueUsageWrite(destination, async () => {
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    let beforeByteLength = 0;
    try {
      beforeByteLength = (await fsp.stat(destination)).size;
    } catch {
      beforeByteLength = 0;
    }
    await fsp.appendFile(destination, `${JSON.stringify(event)}\n`, "utf8");
    let afterByteLength = beforeByteLength;
    try {
      afterByteLength = (await fsp.stat(destination)).size;
    } catch {
      // The durable event is already written.  A later lazy rebuild can repair
      // the derived summary if a transient stat failure prevented this update.
    }
    await appendToStoredSummary(destination, event, {
      afterByteLength,
      beforeByteLength,
    }).catch(() => undefined);
    return event;
  });
}

/**
 * Reads the compact, derived sidecar that powers lightweight dashboards.  It
 * never scans the append-only ledger; callers can decide when a stale sidecar
 * should be rebuilt without making application startup pay that cost.
 */
export async function readUsageSummary(ledgerPath, options = {}) {
  const destination = path.resolve(ledgerPath);
  const summaryPath = usageSummaryPath(destination);
  const result = {
    status: "missing",
    path: destination,
    summaryPath,
    ledgerByteLength: 0,
    updatedAt: "",
    days: {},
    recentEvents: [],
  };
  let ledger;
  try {
    ledger = await fsp.stat(destination);
    if (!ledger.isFile()) return result;
  } catch {
    return result;
  }
  result.ledgerByteLength = ledger.size;
  const snapshot = await readStoredSummary(summaryPath, options);
  if (!snapshot) return result;
  if (snapshot.ledgerByteLength !== ledger.size) return { ...result, status: "stale" };
  return {
    ...result,
    status: "ready",
    updatedAt: snapshot.updatedAt,
    days: snapshot.days,
    recentEvents: snapshot.recentEvents,
  };
}

/**
 * Rebuilds the compact sidecar from the durable JSONL ledger.  This is an
 * explicit maintenance operation for first-run migration and repair, never a
 * hidden prerequisite for reading the home dashboard.
 */
export async function rebuildUsageSummary(ledgerPath, {
  dayCount = DEFAULT_SUMMARY_DAY_COUNT,
  now = new Date(),
  recentLimit = DEFAULT_RECENT_EVENT_LIMIT,
  timeZone = DEFAULT_SUMMARY_TIME_ZONE,
} = {}) {
  const destination = path.resolve(ledgerPath);
  const summaryPath = usageSummaryPath(destination);
  const options = { dayCount, now, recentLimit, timeZone };
  const result = {
    status: "missing",
    path: destination,
    summaryPath,
    scannedLines: 0,
    malformedLines: 0,
    ledgerByteLength: 0,
    updatedAt: "",
    days: {},
    recentEvents: [],
  };
  let before;
  try {
    before = await fsp.stat(destination);
    if (!before.isFile()) return result;
  } catch {
    return result;
  }
  result.ledgerByteLength = before.size;
  const retainedDays = summaryDayKeys(options);
  const snapshot = {
    schemaVersion: USAGE_SUMMARY_SCHEMA_VERSION,
    ledgerByteLength: before.size,
    updatedAt: new Date().toISOString(),
    days: {},
    recentEvents: [],
  };
  const input = fs.createReadStream(destination, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const value = line.trim().replace(/^\uFEFF/u, "");
    if (!value) continue;
    result.scannedLines += 1;
    try {
      const event = JSON.parse(value);
      if (!isUsageEvent(event)) {
        result.malformedLines += 1;
        continue;
      }
      const day = timeZoneDateKey(event.timestamp, timeZone);
      if (retainedDays.has(day)) {
        const indexed = new Map((snapshot.days[day] || []).map((entry) => [usageEventIdentity(entry), entry]));
        indexed.set(usageEventIdentity(event), event);
        snapshot.days[day] = [...indexed.values()]
          .sort((left, right) => clean(left.timestamp).localeCompare(clean(right.timestamp)));
      }
      const recent = new Map(snapshot.recentEvents.map((entry) => [usageEventIdentity(entry), entry]));
      recent.set(usageEventIdentity(event), event);
      snapshot.recentEvents = [...recent.values()]
        .sort((left, right) => clean(left.timestamp).localeCompare(clean(right.timestamp)))
        .slice(-Math.max(1, Number(recentLimit) || DEFAULT_RECENT_EVENT_LIMIT));
    } catch {
      result.malformedLines += 1;
    }
  }
  let after;
  try {
    after = await fsp.stat(destination);
  } catch {
    return { ...result, status: "stale" };
  }
  if (after.size !== before.size) return { ...result, status: "stale", ledgerByteLength: after.size };
  await writeStoredSummary(summaryPath, snapshot);
  return {
    ...result,
    status: "ready",
    updatedAt: snapshot.updatedAt,
    days: snapshot.days,
    recentEvents: snapshot.recentEvents,
  };
}

export async function readUsageEvents(ledgerPath, { limit = 50_000 } = {}) {
  const result = {
    status: "missing",
    path: path.resolve(ledgerPath),
    scannedLines: 0,
    malformedLines: 0,
    events: [],
  };
  try {
    if (!(await fsp.stat(result.path)).isFile()) return result;
  } catch {
    return result;
  }

  const input = fs.createReadStream(result.path, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const value = line.trim().replace(/^\uFEFF/u, "");
    if (!value) continue;
    result.scannedLines += 1;
    try {
      const event = JSON.parse(value);
      if (isUsageEvent(event)) {
        result.events.push(event);
        if (result.events.length > limit) result.events.shift();
      } else {
        result.malformedLines += 1;
      }
    } catch {
      result.malformedLines += 1;
    }
  }
  result.status = "ready";
  return result;
}
