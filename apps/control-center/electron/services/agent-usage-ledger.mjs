import { readUsageEvents } from "@suzu-lives/cost-ledger";

const MAX_RECORDED_EVENT_IDS = 20_000;

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function validDate(value, fallback) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback().toISOString();
}

function agentEventScope(event, turn) {
  const source = plainObject(event);
  return {
    sessionId: clean(source.sessionId || source.runtimeSessionId || turn?.sessionId),
    projectRoot: clean(source.projectRoot || turn?.projectRoot),
  };
}

function agentEventData(event) {
  return plainObject(plainObject(event).data);
}

function historyEvent(entry) {
  const source = plainObject(entry);
  const wrapped = plainObject(source.event);
  return Object.keys(wrapped).length ? wrapped : source;
}

function safeToolNames(turn) {
  const source = turn?.toolNames instanceof Set
    ? [...turn.toolNames]
    : Array.isArray(turn?.toolNames) ? turn.toolNames : [];
  return source.map(clean).filter(Boolean).slice(0, 100);
}

function historicalUsageEvent(entry, scope) {
  const source = historyEvent(entry);
  const data = plainObject(source.data);
  const sequence = Number(source.seq);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || !scope.sessionId) return null;

  const eventData = {
    coreSequence: sequence,
    ...(Number.isFinite(Number(source.time)) ? { coreTime: Number(source.time) } : {}),
  };
  if (source.type === "assistant/message") {
    const messageSource = plainObject(plainObject(data.message).source);
    const usage = plainObject(data.usage);
    const provider = clean(messageSource.provider);
    const model = clean(messageSource.model);
    if (!Object.keys(usage).length || !model) return null;
    return {
      runtimeSessionId: scope.sessionId,
      data: {
        ...eventData,
        purpose: "agent-step",
        usage,
        provider,
        model,
        ...(Number.isInteger(data.turn) ? { coreTurn: data.turn } : {}),
        ...(Number.isInteger(data.step) ? { step: data.step } : {}),
      },
    };
  }
  if (source.type === "compaction/summary") {
    const usage = plainObject(data.usage);
    const provider = clean(data.provider);
    const model = clean(data.model);
    if (!Object.keys(usage).length || !model) return null;
    return {
      runtimeSessionId: scope.sessionId,
      data: {
        ...eventData,
        purpose: "compaction",
        usage,
        provider,
        model,
        compactionId: clean(data.compactionId),
        ...(Number.isInteger(data.turn) ? { coreTurn: data.turn } : {}),
      },
    };
  }
  return null;
}

function trustedContactScope(contact = {}) {
  const source = plainObject(contact);
  return {
    contactId: clean(source.contactId || source.id),
    agentId: clean(source.agentId),
    projectRoot: clean(source.projectRoot),
    sessionId: clean(source.sessionId || source.runtimeSessionId),
  };
}

function completedUsageWrite(result) {
  return Array.isArray(result) && result.some((item) => clean(item?.status) === "completed");
}

/**
 * The selected execution kernel's public TokenUsage shape is camel-cased and has separate cache-read
 * and cache-write counters.  Suzu's bill catalog has uncached and cache-hit
 * price columns, so cache writes are accounted with uncached input while the
 * original counters remain in event metadata for inspection.
 */
export function agentUsageUnits(value = {}) {
  const usage = plainObject(value);
  const inputTokens = nonNegativeNumber(usage.inputTokens);
  const cacheReadTokens = nonNegativeNumber(usage.cacheReadTokens);
  const cacheWriteTokens = nonNegativeNumber(usage.cacheWriteTokens);
  const outputTokens = nonNegativeNumber(usage.outputTokens);
  return Object.freeze({
    ...(inputTokens + cacheWriteTokens > 0 ? { inputUncachedTokens: inputTokens + cacheWriteTokens } : {}),
    ...(cacheReadTokens > 0 ? { inputCachedTokens: cacheReadTokens } : {}),
    ...(outputTokens > 0 ? { outputTextTokens: outputTokens } : {}),
  });
}

function modelUsageEvent({ event, scope, contact, turn, now }) {
  const data = agentEventData(event);
  const usage = plainObject(data.usage);
  const model = clean(data.model);
  const sequence = Number(data.coreSequence);
  if (!scope.sessionId || !Number.isSafeInteger(sequence) || sequence < 0 || !model || !Object.keys(usage).length) return null;
  const purpose = clean(data.purpose) || "agent-step";
  const coreTurn = Number.isInteger(data.coreTurn) ? data.coreTurn : null;
  const step = Number.isInteger(data.step) ? data.step : null;
  const timestamp = validDate(Number.isFinite(Number(data.coreTime)) ? Number(data.coreTime) : undefined, now);
  const requestId = `agent-core:${scope.sessionId}:${sequence}`;
  const units = agentUsageUnits(usage);
  return Object.freeze({
    id: requestId,
    timestamp,
    agentId: clean(contact.agentId),
    provider: clean(data.provider) || "Agent Core",
    model,
    source: purpose === "compaction" ? "Suzu 对话压缩" : "Suzu 对话",
    feature: purpose === "compaction" ? "agent-compaction" : "agent-chat",
    requestId,
    usage,
    units,
    metadata: Object.freeze({
      runtime: "agent-core",
      purpose,
      sessionId: scope.sessionId,
      coreSequence: sequence,
      ...(coreTurn === null ? {} : { coreTurn }),
      ...(step === null ? {} : { step }),
      ...(clean(data.compactionId) ? { compactionId: clean(data.compactionId) } : {}),
      ...(clean(turn?.requestId) ? { turnId: clean(turn.requestId) } : {}),
      ...(clean(turn?.userText) ? { turnPrompt: clean(turn.userText).slice(0, 180) } : {}),
      ...(safeToolNames(turn).length ? { toolNames: safeToolNames(turn) } : {}),
      ...(nonNegativeNumber(usage.cacheReadTokens) ? { cacheReadTokens: nonNegativeNumber(usage.cacheReadTokens) } : {}),
      ...(nonNegativeNumber(usage.cacheWriteTokens) ? { cacheWriteTokens: nonNegativeNumber(usage.cacheWriteTokens) } : {}),
      ...(nonNegativeNumber(usage.reasoningTokens) ? { reasoningTokens: nonNegativeNumber(usage.reasoningTokens) } : {}),
    }),
  });
}

/**
 * Records public Agent Core event data supplied by the live runtime or the
 * reader's history API into Suzu's own ledger. It never opens execution-kernel
 * storage files itself. The registry-owned usage adapter remains the single
 * write path, just like image generation and later product capabilities.
 */
export function createAgentUsageLedger({
  capabilityRuntime = null,
  reader = null,
  settingsService = null,
  now = () => new Date(),
} = {}) {
  const recorded = new Set();
  const recording = new Set();
  const knownIdsByLedgerPath = new Map();

  const knownIdsFor = async (ledgerPath) => {
    const key = clean(ledgerPath);
    const existing = knownIdsByLedgerPath.get(key);
    if (existing) return await existing;
    const loading = readUsageEvents(key)
      .then((stored) => new Set((Array.isArray(stored?.events) ? stored.events : [])
        .map((entry) => clean(entry?.id || entry?.requestId))
        .filter(Boolean)))
      .catch(() => new Set());
    knownIdsByLedgerPath.set(key, loading);
    const ids = await loading;
    knownIdsByLedgerPath.set(key, ids);
    return ids;
  };

  const recordResolvedUsage = async ({ event, scope, contact, turn = null } = {}) => {
    const data = agentEventData(event);
    const sequence = Number(data.coreSequence);
    const recordId = scope.sessionId && Number.isSafeInteger(sequence) && sequence >= 0
      ? `agent-core:${scope.sessionId}:${sequence}`
      : "";
    if (!recordId) return Object.freeze({ status: "invalid-agent-usage" });
    if (recorded.has(recordId)) {
      return Object.freeze({ status: "duplicate", id: recordId });
    }
    // A reader refresh can race the live event by a few milliseconds.  It must
    // retry later instead of treating an unfinished write as a durable record.
    if (recording.has(recordId)) return Object.freeze({ status: "recording", id: recordId });
    recording.add(recordId);
    try {
      if (!contact?.agentId || !contact?.projectRoot) {
        return Object.freeze({ status: "contact-unavailable", id: recordId });
      }
      const settings = settingsService.load() || {};
      const ledgerPath = clean(settingsService.usageLedgerPath({
        ...settings,
        agentId: contact.agentId,
        projectRoot: contact.projectRoot,
      }));
      const ledgerEvent = modelUsageEvent({ event, scope, contact, turn, now });
      if (!ledgerPath || !ledgerEvent) return Object.freeze({ status: "invalid-agent-usage", id: recordId });
      const knownIds = await knownIdsFor(ledgerPath);
      if (knownIds.has(recordId)) {
        recorded.add(recordId);
        return Object.freeze({ status: "duplicate", id: recordId });
      }
      const result = await capabilityRuntime.recordUsage({
        capabilityId: "conversation-model",
        ledgerPath,
        event: ledgerEvent,
      });
      if (!completedUsageWrite(result)) {
        return Object.freeze({ status: "ledger-not-written", id: recordId, result });
      }
      knownIds.add(recordId);
      recorded.add(recordId);
      return Object.freeze({ status: "recorded", id: recordId, result });
    } finally {
      recording.delete(recordId);
      if (recorded.size > MAX_RECORDED_EVENT_IDS) recorded.clear();
    }
  };

  const scopeFor = async ({ event, turn } = {}) => {
    const scope = agentEventScope(event, turn);
    if (clean(turn?.contactId) && typeof reader?.resolveContactSession === "function") {
      const contact = await reader.resolveContactSession(turn.contactId);
      return {
        contactId: clean(contact?.contactId || turn.contactId),
        agentId: clean(contact?.agentId),
        projectRoot: clean(contact?.projectRoot || scope.projectRoot),
        sessionId: clean(contact?.id || scope.sessionId),
      };
    }
    if (scope.sessionId && typeof reader?.resolveCompactorSessionForRuntime === "function") {
      const contact = await reader.resolveCompactorSessionForRuntime(scope);
      return {
        contactId: clean(contact?.contactId),
        agentId: clean(contact?.agentId),
        projectRoot: clean(contact?.projectRoot || scope.projectRoot),
        sessionId: clean(contact?.id || scope.sessionId),
      };
    }
    return null;
  };

  const record = async ({ event, turn = null } = {}) => {
    if (typeof capabilityRuntime?.recordUsage !== "function"
      || typeof settingsService?.load !== "function"
      || typeof settingsService?.usageLedgerPath !== "function") {
      return Object.freeze({ status: "ledger-unavailable" });
    }
    const scope = agentEventScope(event, turn);
    const contact = await scopeFor({ event, turn });
    return recordResolvedUsage({ event, scope, contact, turn });
  };

  /**
   * Live model-usage notifications are the fast path.  The same source data is
   * also durable in Agent Core's session log, so reconcile it when the reader
   * opens a conversation.  This repairs an interrupted Electron process or a
   * previous build that rendered the usage but failed before writing Suzu's
   * own ledger.  Event ids use the immutable Core sequence and are checked
   * against the persisted ledger before appending.
   */
  const reconcile = async ({ contact, events = [] } = {}) => {
    if (typeof capabilityRuntime?.recordUsage !== "function"
      || typeof settingsService?.load !== "function"
      || typeof settingsService?.usageLedgerPath !== "function") {
      return Object.freeze({ completed: false, status: "ledger-unavailable", scanned: 0, recorded: 0, duplicates: 0 });
    }
    const trusted = trustedContactScope(contact);
    if (!trusted.agentId || !trusted.projectRoot || !trusted.sessionId) {
      return Object.freeze({ completed: false, status: "contact-unavailable", scanned: 0, recorded: 0, duplicates: 0 });
    }
    const scope = { sessionId: trusted.sessionId, projectRoot: trusted.projectRoot };
    let scanned = 0;
    let recordedCount = 0;
    let duplicates = 0;
    let skipped = 0;
    for (const entry of Array.isArray(events) ? events : []) {
      const event = historicalUsageEvent(entry, scope);
      if (!event) continue;
      scanned += 1;
      const result = await recordResolvedUsage({ event, scope, contact: trusted });
      if (result.status === "recorded") recordedCount += 1;
      else if (result.status === "duplicate") duplicates += 1;
      else skipped += 1;
    }
    return Object.freeze({
      completed: skipped === 0,
      status: skipped === 0 ? "completed" : "incomplete",
      scanned,
      recorded: recordedCount,
      duplicates,
      skipped,
    });
  };

  return Object.freeze({ record, reconcile });
}
