import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const GENERATOR_VERSION = 2;
const DEFAULT_MAX_EVENTS = 12;
const DEFAULT_MAX_EVENT_CHARS = 1200;
const MAX_TITLE_CHARS = 120;
const VALID_STATUSES = new Set(["ongoing", "resolved", "unknown"]);

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function cleanText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function truncateCodePoints(value, maximum) {
  const characters = Array.from(value);
  return characters.length <= maximum ? value : characters.slice(0, maximum).join("");
}

function normalizedRef(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/^\[|\]$/gu, "")
    .replace(/^#/u, "")
    .toUpperCase();
}

function normalizedTimestamp(value) {
  if (!value) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function normalizedEventDate(value) {
  const text = cleanText(value).toLowerCase();
  if (!text || text === "unknown" || text === "未知") return { valid: true, value: null };
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) return { valid: false, value: null };
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    return { valid: false, value: null };
  }
  return { valid: true, value: text };
}

function sourceRefs(candidate) {
  const value = candidate?.source_refs
    ?? candidate?.sourceRefs
    ?? candidate?.sources
    ?? candidate?.source_ids;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(/[\s,，]+/u).filter(Boolean);
  return [];
}

function candidateList(candidates) {
  if (Array.isArray(candidates)) return candidates;
  if (Array.isArray(candidates?.events)) return candidates.events;
  return [];
}

function stableEventId(event) {
  const canonical = JSON.stringify({
    memory_type: "event",
    title: event.title || "",
    text: event.text,
    event_date: event.event_date,
    status: event.status,
    source_ids: event.source_ids,
  });
  return `event:${crypto.createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function readJsonLines(eventsPath) {
  if (!fs.existsSync(eventsPath)) return [];
  const events = [];
  const lines = fs.readFileSync(eventsPath, "utf8").split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event === "object") events.push(event);
    } catch (error) {
      throw new Error(`events.jsonl 第 ${index + 1} 行不是有效 JSON：${error.message}`);
    }
  }
  return events;
}

/** Read the derived event store. The file is never treated as source-of-truth memory. */
export function readEvents(eventsPath) {
  if (!eventsPath) throw new Error("eventsPath 不能为空");
  return readJsonLines(path.resolve(eventsPath));
}

/**
 * Convert the LLM's compact event candidates into deterministic event records.
 *
 * Each archived message can expose a short `memory_ref` such as M0001. A
 * candidate is rejected in full when any source ref is missing or unknown;
 * this prevents generated events from claiming evidence outside the supplied
 * compaction batch.
 */
export function normalizeGeneratedEvents(candidates, archivedMessages, options = {}) {
  const maxEvents = positiveInteger(options.maxEvents, DEFAULT_MAX_EVENTS);
  const maxEventChars = positiveInteger(options.maxEventChars, DEFAULT_MAX_EVENT_CHARS);
  const compactionBatchUuid = cleanText(options.compactionBatchUuid);
  const inputCandidates = candidateList(candidates);
  if (inputCandidates.length && !compactionBatchUuid) {
    throw new Error("compactionBatchUuid 不能为空");
  }

  const messages = Array.isArray(archivedMessages) ? archivedMessages : [];
  const byRef = new Map();
  for (let order = 0; order < messages.length; order += 1) {
    const message = messages[order];
    if (!message?.id) continue;
    const aliases = [message.memory_ref, message.id];
    for (const alias of aliases) {
      const ref = normalizedRef(alias);
      if (ref && !byRef.has(ref)) byRef.set(ref, { message, order });
    }
  }

  const normalized = [];
  const seenIds = new Set();
  for (const candidate of inputCandidates) {
    if (normalized.length >= maxEvents) break;
    const text = truncateCodePoints(cleanText(candidate?.text), maxEventChars);
    if (!text) continue;
    if (!(Object.hasOwn(candidate || {}, "event_date") || Object.hasOwn(candidate || {}, "eventDate"))) continue;
    const eventDate = normalizedEventDate(candidate?.event_date ?? candidate?.eventDate);
    if (!eventDate.valid) continue;

    const refs = [...new Set(sourceRefs(candidate).map(normalizedRef).filter(Boolean))];
    if (!refs.length || refs.some((ref) => !byRef.has(ref))) continue;
    const sources = refs
      .map((ref) => byRef.get(ref))
      .sort((left, right) => left.order - right.order)
      .map(({ message }) => message);

    const sourceIds = [...new Set(sources.map((item) => String(item.id)).filter(Boolean))];
    if (!sourceIds.length) continue;
    const sourceUuids = [...new Set(sources
      .map((item) => item.source_uuid)
      .filter(Boolean)
      .map(String))];
    const timestamps = sources
      .map((item) => normalizedTimestamp(item.timestamp))
      .filter(Boolean)
      .sort();
    const status = VALID_STATUSES.has(candidate?.status) ? candidate.status : "unknown";
    const title = truncateCodePoints(cleanText(candidate?.title), MAX_TITLE_CHARS);
    const event = {
      id: "",
      memory_type: "event",
      text,
      ...(title ? { title } : {}),
      event_date: eventDate.value,
      source_start_timestamp: timestamps[0] || null,
      source_end_timestamp: timestamps.at(-1) || null,
      status,
      source_ids: sourceIds,
      source_uuids: sourceUuids,
      compaction_batch_uuid: compactionBatchUuid,
      generator_version: GENERATOR_VERSION,
    };
    event.id = stableEventId(event);
    if (seenIds.has(event.id)) continue;
    seenIds.add(event.id);
    normalized.push(event);
  }
  return normalized;
}

function acquireLock(lockPath) {
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      return fs.openSync(lockPath, "wx");
    } catch (error) {
      if (error.code !== "EEXIST" || Date.now() >= deadline) {
        throw new Error(`无法锁定事件库：${error.message}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

/**
 * Stage an idempotent append. commit() takes an exclusive sibling lock, reads
 * the latest file again, and only appends ids that are still absent.
 */
export function prepareEventAppend(events, eventsPath) {
  if (!eventsPath) throw new Error("eventsPath 不能为空");
  const resolvedPath = path.resolve(eventsPath);
  const staged = [];
  const stagedIds = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    const eventDate = normalizedEventDate(event?.event_date);
    if (
      !event?.id
      || event.memory_type !== "event"
      || !event.text
      || !VALID_STATUSES.has(event.status)
      || !Array.isArray(event.source_ids)
      || !event.source_ids.length
      || !Array.isArray(event.source_uuids)
      || !(Object.hasOwn(event, "event_date") && eventDate.valid && eventDate.value === event.event_date)
      || !(Object.hasOwn(event, "source_start_timestamp")
        && (event.source_start_timestamp === null || typeof event.source_start_timestamp === "string"))
      || !(Object.hasOwn(event, "source_end_timestamp")
        && (event.source_end_timestamp === null || typeof event.source_end_timestamp === "string"))
      || !event.compaction_batch_uuid
      || event.generator_version !== GENERATOR_VERSION
    ) continue;
    if (stagedIds.has(event.id)) continue;
    stagedIds.add(event.id);
    staged.push(event);
  }
  const existingIds = new Set(readJsonLines(resolvedPath).map((item) => item?.id).filter(Boolean));
  const initiallyMissing = staged.filter((event) => !existingIds.has(event.id));
  const stagedResult = {
    eventsPath: resolvedPath,
    added: initiallyMissing.length,
    totalKnown: existingIds.size + initiallyMissing.length,
  };

  return {
    ...stagedResult,
    commit() {
      if (!staged.length) return stagedResult;
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      const lockPath = `${resolvedPath}.lock`;
      const lock = acquireLock(lockPath);
      try {
        const current = readJsonLines(resolvedPath);
        const currentIds = new Set(current.map((item) => item?.id).filter(Boolean));
        const accepted = staged.filter((event) => !currentIds.has(event.id));
        if (accepted.length) {
          const existingText = fs.existsSync(resolvedPath) ? fs.readFileSync(resolvedPath, "utf8") : "";
          const separator = existingText && !/\r?\n$/u.test(existingText) ? "\n" : "";
          const payload = `${separator}${accepted.map((event) => JSON.stringify(event)).join("\n")}\n`;
          fs.appendFileSync(resolvedPath, payload, "utf8");
        }
        return {
          eventsPath: resolvedPath,
          added: accepted.length,
          totalKnown: currentIds.size + accepted.length,
        };
      } finally {
        fs.closeSync(lock);
        fs.unlinkSync(lockPath);
      }
    },
  };
}
