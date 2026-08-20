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

function safeToolNames(turn) {
  const source = turn?.toolNames instanceof Set
    ? [...turn.toolNames]
    : Array.isArray(turn?.toolNames) ? turn.toolNames : [];
  return source.map(clean).filter(Boolean).slice(0, 100);
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
 * Records only live public Agent Core event data into Suzu's own ledger. It never
 * scans the execution kernel's storage files. The registry-owned usage adapter is the single
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
    const data = agentEventData(event);
    const sequence = Number(data.coreSequence);
    const recordId = scope.sessionId && Number.isSafeInteger(sequence) && sequence >= 0
      ? `agent-core:${scope.sessionId}:${sequence}`
      : "";
    if (!recordId) return Object.freeze({ status: "invalid-agent-usage" });
    if (recorded.has(recordId) || recording.has(recordId)) {
      return Object.freeze({ status: "duplicate", id: recordId });
    }
    recording.add(recordId);
    try {
      const contact = await scopeFor({ event, turn });
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
      const result = await capabilityRuntime.recordUsage({
        capabilityId: "conversation-model",
        ledgerPath,
        event: ledgerEvent,
      });
      recorded.add(recordId);
      return Object.freeze({ status: "recorded", id: recordId, result });
    } catch (error) {
      throw error;
    } finally {
      recording.delete(recordId);
      if (recorded.size > MAX_RECORDED_EVENT_IDS) recorded.clear();
    }
  };

  return Object.freeze({ record });
}
