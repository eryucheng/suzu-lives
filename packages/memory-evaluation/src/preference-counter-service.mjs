import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendUsageEvent } from "@suzu-lives/cost-ledger";

import {
  buildPreferenceCounterMatchGenerationInput,
  parsePreferenceCounterMatchGeneration,
  PREFERENCE_COUNTER_MATCH_CONTRACT,
} from "./preference-counter-contract.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_DIRECTORY = path.join(PACKAGE_ROOT, "resources");

function clean(value) {
  return String(value ?? "").trim();
}

function clip(value, maximum) {
  const text = clean(value);
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
}

function stableBatchId({ agentId, currentStateId, observationIds }) {
  const signature = [
    clean(agentId),
    clean(currentStateId),
    uniqueStrings(observationIds).sort().join("\u001f"),
  ].join("\u001e");
  return `preference-counter-${createHash("sha256").update(signature).digest("hex").slice(0, 24)}`;
}

function sourceView(source, maximumChars) {
  return {
    id: source.id,
    sourceKind: source.source_kind,
    occurredAt: source.occurred_at,
    knownAt: source.known_at,
    speaker: source.speaker,
    content: clip(source.content, maximumChars),
  };
}

function currentStateView(current, objectLabel) {
  const scope = current.metadata?.preferenceScope;
  const scopeLabel = clean(current.metadata?.preferenceScopeLabel);
  const scopeKnown = Boolean(
    scope && typeof scope === "object" && !Array.isArray(scope) && Object.keys(scope).length,
  );
  return {
    id: current.id,
    kind: current.kind,
    content: clip(current.content, 1000),
    objectLabel: clean(objectLabel),
    stateLevel: clean(current.metadata?.preferenceStateLevel) || "unknown",
    scope: scopeKnown ? scope : {},
    scopeLabel,
    scopeKnown,
    knownAt: current.known_at,
    validFrom: current.valid_from,
    validTo: current.valid_to,
  };
}

export function buildPreferenceCounterMatchSnapshot({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  objectLabel,
  observationIds = [],
  currentStateId = "",
  maxCandidates = 30,
  maxMemoryContentChars = 900,
  maxSourceContentChars = 1200,
  maxSnapshotChars = 64_000,
} = {}) {
  if (!repository) throw new Error("Preference counter snapshot requires a repository.");
  const normalizedAgentId = clean(agentId);
  const normalizedSubjectRole = clean(subjectRole);
  const normalizedSubjectKey = clean(subjectKey);
  const normalizedCanonicalKey = clean(canonicalKey).toLocaleLowerCase("en-US");
  const normalizedObjectLabel = clean(objectLabel);
  if (!normalizedAgentId || !["user", "agent", "shared", "other"].includes(normalizedSubjectRole)
    || !normalizedSubjectKey || !normalizedCanonicalKey || !normalizedObjectLabel) {
    throw new Error("Preference counter snapshot target is incomplete.");
  }
  const current = repository.getCurrentCanonicalMemory({
    agentId: normalizedAgentId,
    subjectRole: normalizedSubjectRole,
    subjectKey: normalizedSubjectKey,
    canonicalKey: normalizedCanonicalKey,
    stateFamily: "preference",
  });
  if (!current) {
    return {
      status: "skipped",
      reason: "no-current-preference-state",
      snapshot: null,
    };
  }
  if (clean(currentStateId) && clean(currentStateId) !== current.id) {
    throw new Error("Preference counter snapshot does not target the current canonical state.");
  }
  const requestedIds = uniqueStrings(observationIds);
  if (!requestedIds.length) {
    throw new Error("Preference counter snapshot requires explicit observationIds.");
  }
  const candidateLimit = Math.min(60, Math.max(1, Math.trunc(Number(maxCandidates) || 30)));
  if (requestedIds.length > candidateLimit) {
    throw new Error(`Preference counter snapshot exceeds the ${candidateLimit}-candidate limit.`);
  }
  const memoryCharLimit = Math.min(4000, Math.max(100, Math.trunc(Number(maxMemoryContentChars) || 900)));
  const sourceCharLimit = Math.min(6000, Math.max(100, Math.trunc(Number(maxSourceContentChars) || 1200)));
  const candidates = requestedIds.map((observationId) => {
    const observation = repository.getStateEvidenceObservation(normalizedAgentId, observationId);
    if (!observation || observation.lifecycle !== "current") {
      throw new Error("Preference counter observation must be current and belong to the same Agent.");
    }
    if (observation.state_family !== "preference"
      || observation.subject_role !== normalizedSubjectRole
      || observation.subject_key !== normalizedSubjectKey
      || observation.canonical_key !== normalizedCanonicalKey) {
      throw new Error("Preference counter observation target does not match the current state.");
    }
    if (observation.claimed_direction !== "opposition"
      || observation.effective_direction !== "neutral"
      || observation.qualification !== "unresolved"
      || observation.excluded_reason !== "counter-match-required") {
      throw new Error("Preference counter observation is not awaiting counter matching.");
    }
    const memory = repository.getMemory(observation.memory_id);
    const detail = repository.getMemoryDetail(normalizedAgentId, observation.memory_id);
    if (!memory || !detail || memory.status === "deleted") {
      throw new Error("Preference counter evidence memory is unavailable.");
    }
    const sources = new Map(detail.sources.map((source) => [source.id, source]));
    if (observation.sourceIds.some((sourceId) => !sources.has(sourceId))) {
      throw new Error("Preference counter observation references an unavailable source.");
    }
    return {
      observationId: observation.id,
      memoryId: memory.id,
      sourceIds: observation.sourceIds,
      signal: observation.signal,
      claimedDirection: observation.claimed_direction,
      scope: observation.scope,
      observedAt: observation.observed_at,
      memory: {
        kind: memory.kind,
        content: clip(memory.content, memoryCharLimit),
        eventDate: memory.event_date,
        eventStart: memory.event_start,
        eventEnd: memory.event_end,
        knownAt: memory.known_at,
      },
      specialistAnalysis: {
        objectGrounding: observation.payload?.objectGrounding || null,
        explicitExpression: observation.payload?.explicitExpression || null,
        behaviorConditions: observation.payload?.behaviorConditions || null,
        timeScope: observation.payload?.timeScope || null,
      },
      sources: observation.sourceIds.map((sourceId) => sourceView(sources.get(sourceId), sourceCharLimit)),
    };
  });
  const snapshot = {
    schemaVersion: 1,
    agentId: normalizedAgentId,
    target: {
      subjectRole: normalizedSubjectRole,
      subjectKey: normalizedSubjectKey,
      canonicalKey: normalizedCanonicalKey,
      objectLabel: normalizedObjectLabel,
    },
    currentState: currentStateView(current, normalizedObjectLabel),
    candidates,
    inputPolicy: {
      targetAndCurrentStateAreCodeFixed: true,
      candidatesAreExplicitAndBounded: true,
      sourcesMustAlreadySupportCandidateMemory: true,
      modelCannotWriteOrChangePreferenceState: true,
    },
  };
  const snapshotLimit = Math.min(250_000, Math.max(4_000, Math.trunc(Number(maxSnapshotChars) || 64_000)));
  if (JSON.stringify(snapshot).length > snapshotLimit) {
    throw new Error(`Preference counter snapshot exceeds the ${snapshotLimit}-character limit.`);
  }
  return { status: "ready", reason: "", snapshot };
}

function enforceAnalysisBoundary(analysis, snapshot) {
  const candidate = snapshot.candidates.find((item) => item.observationId === analysis.observationId);
  if (!candidate || candidate.memoryId !== analysis.memoryId) {
    throw new Error("Counter analysis must target a candidate from the bounded snapshot.");
  }
  const availableSources = new Set(candidate.sourceIds);
  if (analysis.sourceIds.some((sourceId) => !availableSources.has(sourceId))) {
    throw new Error("Counter analysis source must directly support its candidate memory.");
  }
  if (analysis.relation === "same_scope_conflict") {
    if (!snapshot.currentState.scopeKnown) {
      throw new Error("Same-scope conflict cannot be asserted while current scope is unknown.");
    }
    if (analysis.scopeOverlap !== "exact"
      || analysis.temporalRelation !== "overlaps_current") {
      throw new Error("Same-scope conflict requires exact scope and current temporal overlap.");
    }
  }
  if (analysis.relation === "subcategory_exception" && analysis.scopeOverlap !== "subset") {
    throw new Error("Subcategory exception requires subset scope.");
  }
  if (analysis.relation === "historical_only"
    && analysis.temporalRelation !== "predates_current") {
    throw new Error("Historical-only evidence must predate the current state.");
  }
  return { candidate, analysis };
}

function resolutionFor(analysis) {
  if (analysis.relation === "same_scope_conflict") {
    return { qualification: "qualified", effectiveDirection: "opposition", reason: "" };
  }
  if (analysis.relation === "unknown") {
    return {
      qualification: "unresolved",
      effectiveDirection: "neutral",
      reason: "counter-match-unknown",
    };
  }
  return {
    qualification: "excluded",
    effectiveDirection: "neutral",
    reason: `counter-${analysis.relation}`,
  };
}

async function appendCounterUsage({ usageLedgerPath, generation, agentId, batchId }) {
  if (!clean(usageLedgerPath) || !generation?.model || !generation?.usage) return "";
  try {
    await appendUsageEvent(path.resolve(usageLedgerPath), {
      agentId,
      provider: generation.metadata?.provider || "",
      model: generation.model,
      source: "memory-evaluation",
      feature: "memory-preference-counter-match",
      requestId: generation.requestId || "",
      usage: generation.usage,
      metadata: {
        batchId,
        durationMs: Number(generation.durationMs || 0),
        ...generation.metadata,
      },
    });
    return "";
  } catch (error) {
    return `费用流水写入失败：${error.message}`;
  }
}

export async function evaluatePreferenceCounterEvidence({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  objectLabel,
  observationIds = [],
  currentStateId = "",
  generator,
  usageLedgerPath = "",
  promptDirectory = DEFAULT_PROMPT_DIRECTORY,
  maximumAnalyses = 40,
  snapshotOptions = {},
} = {}) {
  if (!repository) throw new Error("Preference counter evaluation requires a repository.");
  if (typeof generator !== "function") {
    throw new Error("Preference counter evaluation requires a generator.");
  }
  const built = buildPreferenceCounterMatchSnapshot({
    repository,
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    objectLabel,
    observationIds,
    currentStateId,
    ...snapshotOptions,
  });
  if (built.status === "skipped") {
    return {
      status: "skipped",
      reason: built.reason,
      snapshot: null,
      run: null,
      analyses: [],
      observations: [],
      automaticMemoryWriteAllowed: false,
    };
  }
  const { snapshot } = built;
  const batchId = stableBatchId({
    agentId: snapshot.agentId,
    currentStateId: snapshot.currentState.id,
    observationIds: snapshot.candidates.map((item) => item.observationId),
  });
  const systemPrompt = fs.readFileSync(
    path.join(path.resolve(promptDirectory), PREFERENCE_COUNTER_MATCH_CONTRACT.promptFile),
    "utf8",
  ).replace(/^\uFEFF/u, "").trim();
  const input = buildPreferenceCounterMatchGenerationInput(snapshot);
  let generation = null;
  let analyses = [];
  const rejected = [];
  let errorMessage = "";
  try {
    generation = await generator({
      input,
      systemPrompt,
      schema: PREFERENCE_COUNTER_MATCH_CONTRACT.schema,
      schemaName: PREFERENCE_COUNTER_MATCH_CONTRACT.schemaName,
      analyzerRole: PREFERENCE_COUNTER_MATCH_CONTRACT.role,
    });
    const parsed = parsePreferenceCounterMatchGeneration(generation?.output, { maximumAnalyses });
    const seen = new Set();
    for (const [index, item] of parsed.analyses.entries()) {
      try {
        if (seen.has(item.observationId)) {
          throw new Error("Counter matcher can analyze each observation at most once.");
        }
        const accepted = enforceAnalysisBoundary(item, snapshot);
        seen.add(item.observationId);
        analyses.push(accepted);
      } catch (error) {
        rejected.push({ index, observationId: item.observationId, error: error.message });
      }
    }
  } catch (error) {
    errorMessage = error.message;
  }
  const sourceIds = uniqueStrings(snapshot.candidates.flatMap((item) => item.sourceIds)).sort();
  const memoryIds = uniqueStrings([
    snapshot.currentState.id,
    ...snapshot.candidates.map((item) => item.memoryId),
  ]).sort();
  const status = errorMessage
    ? "failed"
    : analyses.length ? "completed"
      : rejected.length ? "rejected" : "abstained";
  const run = repository.recordStateAnalysisRun({
    agentId: snapshot.agentId,
    batchId,
    stateFamily: "preference",
    analyzerRole: PREFERENCE_COUNTER_MATCH_CONTRACT.role,
    subjectRole: snapshot.target.subjectRole,
    subjectKey: snapshot.target.subjectKey,
    canonicalKey: snapshot.target.canonicalKey,
    provider: clean(generation?.metadata?.provider) || "unreported",
    model: clean(generation?.model) || "unreported",
    promptVersion: PREFERENCE_COUNTER_MATCH_CONTRACT.promptVersion,
    schemaVersion: PREFERENCE_COUNTER_MATCH_CONTRACT.schemaName,
    inputHash: createHash("sha256").update(input).digest("hex"),
    status,
    memoryIds,
    sourceIds,
    output: generation?.output ?? {},
    rejected,
    usage: generation?.usage || {},
    costAmount: Number(generation?.costAmount ?? generation?.metadata?.costAmount ?? 0) || 0,
    costCurrency: clean(generation?.costCurrency ?? generation?.metadata?.costCurrency),
    requestId: clean(generation?.requestId),
    durationMs: Math.max(0, Math.trunc(Number(generation?.durationMs) || 0)),
    errorMessage,
    metadata: {
      currentStateId: snapshot.currentState.id,
      candidateObservationIds: snapshot.candidates.map((item) => item.observationId),
      automaticMemoryWriteAllowed: false,
    },
  });
  const warning = await appendCounterUsage({
    usageLedgerPath,
    generation,
    agentId: snapshot.agentId,
    batchId,
  });
  const observations = status === "completed" ? repository.transaction(() => analyses.map((item) => {
    const resolution = resolutionFor(item.analysis);
    const previous = repository.getStateEvidenceObservation(
      snapshot.agentId,
      item.candidate.observationId,
    );
    if (!previous || previous.lifecycle !== "current") {
      throw new Error("Counter evidence changed before the match result was recorded.");
    }
    return repository.recordStateEvidenceObservation({
      agentId: snapshot.agentId,
      batchId,
      stateFamily: "preference",
      subjectRole: previous.subject_role,
      subjectKey: previous.subject_key,
      canonicalKey: previous.canonical_key,
      memoryId: previous.memory_id,
      evidenceGroupId: previous.evidence_group_id,
      contextId: previous.context_id,
      signal: previous.signal,
      claimedDirection: previous.claimed_direction,
      effectiveDirection: resolution.effectiveDirection,
      qualification: resolution.qualification,
      confidence: Math.min(Number(previous.confidence), item.analysis.confidence),
      origin: "llm",
      scope: previous.scope,
      payloadSchemaVersion: "preference-counter-matched-v1",
      payload: {
        ...previous.payload,
        counterMatch: {
          currentStateId: snapshot.currentState.id,
          relation: item.analysis.relation,
          scopeOverlap: item.analysis.scopeOverlap,
          temporalRelation: item.analysis.temporalRelation,
          confidence: item.analysis.confidence,
          rationale: item.analysis.rationale,
        },
      },
      excludedReason: resolution.reason,
      sourceIds: previous.sourceIds,
      analysisRunIds: [run.id],
      observedAt: previous.observed_at,
    });
  })) : [];
  const matchedIds = new Set(analyses.map((item) => item.analysis.observationId));
  const missingObservationIds = snapshot.candidates
    .map((item) => item.observationId)
    .filter((id) => !matchedIds.has(id));
  return {
    status: status === "completed" && !rejected.length && !missingObservationIds.length
      ? "matched" : "incomplete",
    reason: errorMessage || (missingObservationIds.length
      ? "counter-matcher-did-not-resolve-all-candidates"
      : rejected.length ? "counter-matcher-results-rejected" : ""),
    batchId,
    snapshot,
    run,
    analyses: analyses.map((item) => item.analysis),
    rejected,
    missingObservationIds,
    observations,
    warnings: warning ? [warning] : [],
    automaticMemoryWriteAllowed: false,
  };
}
