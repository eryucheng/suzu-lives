import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendUsageEvent } from "@suzu-lives/cost-ledger";

import {
  BEHAVIOR_STATE_ANALYZERS,
  buildBehaviorStateGenerationInput,
  parseBehaviorStateGeneration,
} from "./behavior-state-contracts.mjs";
import { buildPreferenceEvidenceSnapshot } from "./preference-snapshot.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_DIRECTORY = path.join(PACKAGE_ROOT, "resources");

function clean(value) {
  return String(value ?? "").trim();
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
}

function normalizeTarget(stateFamily, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const canonicalKey = clean(value.canonicalKey).toLocaleLowerCase("en-US");
  const conceptLabel = clean(value.conceptLabel);
  if (!canonicalKey || !conceptLabel) {
    throw new Error(`${stateFamily} target requires canonicalKey and conceptLabel.`);
  }
  return {
    stateFamily,
    canonicalKey,
    conceptLabel,
    currentRepresentationLayer: clean(value.currentRepresentationLayer),
  };
}

function stableBatchId({ agentId, subjectRole, subjectKey, targets, memoryIds }) {
  const targetSignature = Object.entries(targets)
    .map(([key, target]) => `${key}:${target.canonicalKey}`)
    .sort()
    .join("\u001f");
  const signature = [
    clean(agentId),
    clean(subjectRole),
    clean(subjectKey),
    targetSignature,
    uniqueStrings(memoryIds).sort().join("\u001f"),
  ].join("\u001e");
  return `behavior-states-${createHash("sha256").update(signature).digest("hex").slice(0, 24)}`;
}

function targetHasRole(memory, target, allowedRoles, { allowPrimary = true } = {}) {
  if (allowPrimary
    && memory.subjectRole === target.subjectRole
    && memory.subjectKey === target.subjectKey) return true;
  return memory.actorRoles.some((role) => (
    allowedRoles.has(role.role)
    && role.actorRole === target.subjectRole
    && role.actorKey === target.subjectKey
  ));
}

function assertSubjectBoundary(stateFamily, analysis, memory, target) {
  const selfReported = stateFamily === "disposition"
    ? analysis.evidenceType === "explicit_self_description"
    : analysis.evidenceBasis === "explicit_self_report";
  if (selfReported) {
    if (!targetHasRole(memory, target, new Set(["speaker"]), { allowPrimary: false })) {
      throw new Error(`${stateFamily} self report requires the fixed subject as speaker.`);
    }
    return;
  }
  if (!targetHasRole(memory, target, new Set(["subject", "experiencer", "behavior_actor"]))) {
    throw new Error(`${stateFamily} evidence does not identify the fixed subject as experiencer.`);
  }
}

function enforceAnalysisBoundary(stateFamily, analysis, snapshot) {
  const memory = snapshot.memories.find((item) => item.id === analysis.memoryId);
  if (!memory) throw new Error("Behavior state analysis memory must come from the bounded snapshot.");
  const availableSourceIds = new Set(memory.sourceIds);
  if (analysis.sourceIds.some((sourceId) => !availableSourceIds.has(sourceId))) {
    throw new Error("Behavior state analysis source must directly support its selected memory.");
  }
  assertSubjectBoundary(stateFamily, analysis, memory, snapshot.target);
  return analysis;
}

async function appendAnalyzerUsage({ usageLedgerPath, generation, definition, agentId, batchId }) {
  if (!clean(usageLedgerPath) || !generation?.model || !generation?.usage) return "";
  try {
    await appendUsageEvent(path.resolve(usageLedgerPath), {
      agentId,
      provider: generation.metadata?.provider || "",
      model: generation.model,
      source: "memory-evaluation",
      feature: `memory-${definition.stateFamily}-evidence`,
      requestId: generation.requestId || "",
      usage: generation.usage,
      metadata: {
        batchId,
        analyzerRole: definition.role,
        durationMs: Number(generation.durationMs || 0),
        ...generation.metadata,
      },
    });
    return "";
  } catch (error) {
    return `费用流水写入失败：${error.message}`;
  }
}

async function invokeAnalyzer({ definition, generator, snapshot, promptDirectory, maximumAnalyses }) {
  const systemPrompt = fs.readFileSync(
    path.join(path.resolve(promptDirectory), definition.promptFile),
    "utf8",
  ).replace(/^\uFEFF/u, "").trim();
  const input = buildBehaviorStateGenerationInput(snapshot, definition);
  let generation = null;
  try {
    generation = await generator({
      input,
      systemPrompt,
      schema: definition.schema,
      schemaName: definition.schemaName,
      stateFamily: definition.stateFamily,
      analyzerRole: definition.role,
    });
    const parsed = parseBehaviorStateGeneration(definition.stateFamily, generation?.output, {
      maximumAnalyses,
    });
    const accepted = [];
    const rejected = [];
    const seen = new Set();
    for (const [index, candidate] of parsed.analyses.entries()) {
      try {
        if (seen.has(candidate.memoryId)) {
          throw new Error("A behavior state analyzer can analyze each memory at most once.");
        }
        accepted.push(enforceAnalysisBoundary(
          definition.stateFamily,
          candidate,
          snapshot,
        ));
        seen.add(candidate.memoryId);
      } catch (error) {
        rejected.push({ index, memoryId: candidate.memoryId, error: error.message });
      }
    }
    return {
      definition,
      input,
      generation,
      analyses: accepted,
      rejected,
      status: accepted.length ? "completed" : rejected.length ? "rejected" : "abstained",
      error: "",
    };
  } catch (error) {
    return {
      definition,
      input,
      generation,
      analyses: [],
      rejected: [],
      status: "failed",
      error: error.message,
    };
  }
}

function targetGate(analysis) {
  if (analysis.targetMatch === "none") {
    return { qualification: "excluded", reason: "target-does-not-match" };
  }
  if (analysis.targetMatch === "contextual") {
    return { qualification: "excluded", reason: "target-is-context-only" };
  }
  if (analysis.targetMatch === "unknown") {
    return { qualification: "unresolved", reason: "target-match-unknown" };
  }
  if (analysis.targetMatch === "broader_category") {
    return { qualification: "unresolved", reason: "target-scope-is-broader" };
  }
  return null;
}

function conditionGate(analysis) {
  const common = targetGate(analysis);
  if (common) return common;
  if (analysis.conditionPresence === "unknown") {
    return { qualification: "unresolved", reason: "condition-presence-unknown" };
  }
  if (["inferred", "unknown", "reported_by_other"].includes(analysis.evidenceBasis)) {
    return { qualification: "unresolved", reason: "condition-evidence-not-direct" };
  }
  if (analysis.temporality === "future") {
    return { qualification: "unresolved", reason: "future-condition-is-not-current" };
  }
  if (analysis.temporality === "unknown") {
    return { qualification: "unresolved", reason: "condition-time-unknown" };
  }
  return null;
}

function habitGate(analysis) {
  const common = targetGate(analysis);
  if (common) return common;
  if (analysis.patternType === "single") {
    return { qualification: "excluded", reason: "single-occurrence-is-not-a-habit" };
  }
  if (analysis.patternType === "none") {
    return { qualification: "excluded", reason: "no-habit-pattern" };
  }
  if (analysis.patternType === "unknown") {
    return { qualification: "unresolved", reason: "habit-pattern-unknown" };
  }
  if (["inferred", "unknown", "reported_by_other"].includes(analysis.evidenceBasis)) {
    return { qualification: "unresolved", reason: "habit-evidence-not-direct" };
  }
  if (analysis.timeState === "unknown") {
    return { qualification: "unresolved", reason: "habit-time-unknown" };
  }
  return null;
}

function dispositionGate(analysis, {
  distinctContextCount = 0,
  distinctSituationCount = 0,
} = {}) {
  const common = targetGate(analysis);
  if (common) return common;
  if (analysis.tendencyPresence === "unknown") {
    return { qualification: "unresolved", reason: "disposition-presence-unknown" };
  }
  if (analysis.timeState === "unknown") {
    return { qualification: "unresolved", reason: "disposition-time-unknown" };
  }
  if (analysis.evidenceType === "explicit_self_description") return null;
  if (analysis.evidenceType === "single_response") {
    return { qualification: "excluded", reason: "single-response-is-not-a-disposition" };
  }
  if (analysis.evidenceType === "repeated_single_context") {
    return { qualification: "excluded", reason: "single-context-pattern-is-not-cross-context" };
  }
  if (["third_party_description", "inferred", "unknown"].includes(analysis.evidenceType)) {
    return { qualification: "unresolved", reason: "disposition-evidence-not-direct" };
  }
  if (analysis.evidenceType === "repeated_cross_context") {
    if (analysis.crossContext !== "yes") {
      return { qualification: "unresolved", reason: "cross-context-coverage-not-proven" };
    }
    if (distinctContextCount < 2 || distinctSituationCount < 2) {
      return { qualification: "unresolved", reason: "cross-context-coverage-not-code-verifiable" };
    }
    if (analysis.externalConstraint === "present") {
      return { qualification: "excluded", reason: "pattern-explained-by-external-constraint" };
    }
    if (analysis.externalConstraint !== "absent") {
      return { qualification: "unresolved", reason: "external-constraint-unknown" };
    }
    return null;
  }
  return { qualification: "unresolved", reason: "disposition-evidence-type-unknown" };
}

function claimedDirection(stateFamily, analysis) {
  if (stateFamily === "condition") {
    if (analysis.conditionPresence === "present") return "support";
    if (analysis.conditionPresence === "absent") return "opposition";
    return "neutral";
  }
  if (stateFamily === "habit") {
    if (["repeated", "habitual"].includes(analysis.patternType)) return "support";
    if (["interrupted", "stopped"].includes(analysis.patternType)) return "opposition";
    return "neutral";
  }
  if (analysis.tendencyPresence === "present") return "support";
  if (analysis.tendencyPresence === "absent") return "opposition";
  return "neutral";
}

function signalFor(stateFamily, analysis) {
  if (stateFamily === "condition") {
    return {
      present: "condition_present",
      absent: "condition_absent",
      unknown: "condition_unknown",
    }[analysis.conditionPresence];
  }
  if (stateFamily === "habit") {
    return {
      single: "single_occurrence",
      repeated: "repeated_pattern",
      habitual: "habitual_pattern",
      interrupted: "pattern_interrupted",
      stopped: "pattern_stopped",
      none: "no_habit_pattern",
      unknown: "habit_unknown",
    }[analysis.patternType];
  }
  if (analysis.tendencyPresence === "absent") return "disposition_absent";
  return {
    explicit_self_description: "explicit_disposition",
    repeated_cross_context: "cross_context_tendency",
    repeated_single_context: "single_context_tendency",
    single_response: "single_response",
    third_party_description: "third_party_description",
    inferred: "inferred_disposition",
    unknown: "disposition_unknown",
  }[analysis.evidenceType];
}

function scopeFor(stateFamily, analysis) {
  if (stateFamily === "condition") {
    return {
      matchedLabel: analysis.matchedLabel,
      conditionKind: analysis.conditionKind,
      scopeLabel: analysis.scopeLabel,
      temporality: analysis.temporality,
    };
  }
  if (stateFamily === "habit") {
    return {
      matchedLabel: analysis.matchedLabel,
      regularity: analysis.regularity,
      contextLabel: analysis.contextLabel,
      timeState: analysis.timeState,
      constraint: analysis.constraint,
    };
  }
  return {
    matchedLabel: analysis.matchedLabel,
    situationLabel: analysis.situationLabel,
    responseLabel: analysis.responseLabel,
    timeState: analysis.timeState,
    crossContext: analysis.crossContext,
  };
}

function gateFor(stateFamily, analysis, options = {}) {
  if (stateFamily === "condition") return conditionGate(analysis);
  if (stateFamily === "habit") return habitGate(analysis);
  return dispositionGate(analysis, options);
}

function recordObservations({ repository, batchId, invocation, snapshot, run }) {
  if (run.status !== "completed") return [];
  const dispositionCoverage = new Map();
  if (invocation.definition.stateFamily === "disposition") {
    for (const analysis of invocation.analyses) {
      if (analysis.evidenceType !== "repeated_cross_context") continue;
      if (!["exact", "subcategory"].includes(analysis.targetMatch)
        || analysis.crossContext !== "yes"
        || analysis.externalConstraint !== "absent"
        || analysis.timeState === "unknown") continue;
      const memory = snapshot.memories.find((item) => item.id === analysis.memoryId);
      const responseLabel = clean(analysis.responseLabel).toLocaleLowerCase("en-US");
      if (!responseLabel) continue;
      const key = `${analysis.tendencyPresence}\u001f${responseLabel}`;
      const coverage = dispositionCoverage.get(key) || { contextIds: new Set(), situations: new Set() };
      if (clean(memory?.contextId)) coverage.contextIds.add(clean(memory.contextId));
      if (clean(analysis.situationLabel)) {
        coverage.situations.add(clean(analysis.situationLabel).toLocaleLowerCase("en-US"));
      }
      dispositionCoverage.set(key, coverage);
    }
  }
  return invocation.analyses.map((analysis) => {
    const memory = snapshot.memories.find((item) => item.id === analysis.memoryId);
    const dispositionKey = `${analysis.tendencyPresence}\u001f${clean(analysis.responseLabel).toLocaleLowerCase("en-US")}`;
    const coverage = dispositionCoverage.get(dispositionKey);
    const gate = gateFor(invocation.definition.stateFamily, analysis, {
      distinctContextCount: coverage?.contextIds.size || 0,
      distinctSituationCount: coverage?.situations.size || 0,
    });
    const qualification = gate?.qualification || "qualified";
    const direction = claimedDirection(invocation.definition.stateFamily, analysis);
    return repository.recordStateEvidenceObservation({
      agentId: snapshot.agentId,
      batchId,
      stateFamily: invocation.definition.stateFamily,
      subjectRole: snapshot.target.subjectRole,
      subjectKey: snapshot.target.subjectKey,
      canonicalKey: snapshot.target.canonicalKey,
      memoryId: analysis.memoryId,
      evidenceGroupId: memory.evidenceGroupId,
      contextId: memory.contextId,
      signal: signalFor(invocation.definition.stateFamily, analysis),
      claimedDirection: direction,
      effectiveDirection: qualification === "qualified" ? direction : "neutral",
      qualification,
      confidence: analysis.confidence,
      origin: "llm",
      scope: {
        ...scopeFor(invocation.definition.stateFamily, analysis),
        currentRepresentationLayer: clean(snapshot.target.currentRepresentationLayer),
      },
      payloadSchemaVersion: invocation.definition.schemaName,
      payload: analysis,
      excludedReason: gate?.reason || "",
      sourceIds: analysis.sourceIds,
      analysisRunIds: [run.id],
      observedAt: memory.eventStart || memory.eventDate || memory.knownAt,
    });
  });
}

export async function evaluateBehaviorStateEvidence({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  memoryIds = [],
  targets = {},
  analyzers = {},
  usageLedgerPath = "",
  promptDirectory = DEFAULT_PROMPT_DIRECTORY,
  snapshotOptions = {},
  maximumAnalyses = 60,
  persistEvidenceLedger = true,
} = {}) {
  if (!repository) throw new Error("Behavior state evaluation requires a repository.");
  const selectedTargets = {};
  for (const stateFamily of Object.keys(BEHAVIOR_STATE_ANALYZERS)) {
    const target = normalizeTarget(stateFamily, targets[stateFamily]);
    if (!target) continue;
    if (typeof analyzers[stateFamily] !== "function") {
      throw new Error(`Behavior state evaluation requires analyzers.${stateFamily}.`);
    }
    selectedTargets[stateFamily] = target;
  }
  if (!Object.keys(selectedTargets).length) {
    throw new Error("Behavior state evaluation requires at least one fixed family target.");
  }
  const normalizedMemoryIds = uniqueStrings(memoryIds);
  const firstTarget = Object.values(selectedTargets)[0];
  const baseSnapshot = buildPreferenceEvidenceSnapshot({
    repository,
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey: firstTarget.canonicalKey,
    memoryIds: normalizedMemoryIds,
    ...snapshotOptions,
  });
  const batchId = stableBatchId({
    agentId,
    subjectRole,
    subjectKey,
    targets: selectedTargets,
    memoryIds: normalizedMemoryIds,
  });
  const snapshots = Object.fromEntries(Object.entries(selectedTargets).map(([stateFamily, target]) => [
    stateFamily,
    {
      ...baseSnapshot,
      agentId: clean(agentId),
      target: {
        ...baseSnapshot.target,
        stateFamily,
        canonicalKey: target.canonicalKey,
        conceptLabel: target.conceptLabel,
        currentRepresentationLayer: target.currentRepresentationLayer,
      },
    },
  ]));
  if (!baseSnapshot.memories.length) {
    return {
      status: "skipped",
      reason: "no-eligible-memories-with-direct-sources",
      batchId,
      snapshots,
      runs: {},
      analyses: {},
      observations: {},
      rejected: {},
      failedFamilies: [],
      warnings: [],
      automaticStateProposalAllowed: false,
    };
  }

  const invocations = await Promise.all(Object.keys(selectedTargets).map(async (stateFamily) => {
    const definition = BEHAVIOR_STATE_ANALYZERS[stateFamily];
    const invocation = await invokeAnalyzer({
      definition,
      generator: analyzers[stateFamily],
      snapshot: snapshots[stateFamily],
      promptDirectory,
      maximumAnalyses,
    });
    return [stateFamily, invocation];
  }));

  const runs = {};
  const analyses = {};
  const rejected = {};
  const observations = {};
  const warnings = [];
  for (const [stateFamily, invocation] of invocations) {
    const snapshot = snapshots[stateFamily];
    const sourceIds = uniqueStrings(snapshot.memories.flatMap((memory) => memory.sourceIds)).sort();
    const warning = await appendAnalyzerUsage({
      usageLedgerPath,
      generation: invocation.generation,
      definition: invocation.definition,
      agentId: clean(agentId),
      batchId,
    });
    if (warning) warnings.push(warning);
    runs[stateFamily] = repository.recordStateAnalysisRun({
      agentId: clean(agentId),
      batchId,
      stateFamily,
      analyzerRole: invocation.definition.role,
      subjectRole: snapshot.target.subjectRole,
      subjectKey: snapshot.target.subjectKey,
      canonicalKey: snapshot.target.canonicalKey,
      provider: clean(invocation.generation?.metadata?.provider) || "unreported",
      model: clean(invocation.generation?.model) || "unreported",
      promptVersion: invocation.definition.promptVersion,
      schemaVersion: invocation.definition.schemaName,
      inputHash: createHash("sha256").update(invocation.input).digest("hex"),
      status: invocation.status,
      memoryIds: snapshot.memories.map((memory) => memory.id),
      sourceIds,
      output: invocation.generation?.output ?? {},
      rejected: invocation.rejected,
      usage: invocation.generation?.usage || {},
      costAmount: Number(
        invocation.generation?.costAmount ?? invocation.generation?.metadata?.costAmount ?? 0,
      ) || 0,
      costCurrency: clean(
        invocation.generation?.costCurrency ?? invocation.generation?.metadata?.costCurrency,
      ),
      requestId: clean(invocation.generation?.requestId),
      durationMs: Math.max(0, Math.trunc(Number(invocation.generation?.durationMs) || 0)),
      errorMessage: invocation.error,
      metadata: {
        conceptLabel: selectedTargets[stateFamily].conceptLabel,
        currentRepresentationLayer: selectedTargets[stateFamily].currentRepresentationLayer,
        automaticStateProposalAllowed: false,
        evidenceObservationWriteAllowed: Boolean(persistEvidenceLedger),
      },
    });
    analyses[stateFamily] = invocation.analyses;
    rejected[stateFamily] = invocation.rejected;
  }

  if (persistEvidenceLedger) {
    repository.transaction(() => {
      for (const [stateFamily, invocation] of invocations) {
        observations[stateFamily] = recordObservations({
          repository,
          batchId,
          invocation,
          snapshot: snapshots[stateFamily],
          run: runs[stateFamily],
        });
      }
    });
  } else {
    for (const stateFamily of Object.keys(selectedTargets)) observations[stateFamily] = [];
  }

  const failedFamilies = Object.keys(selectedTargets)
    .filter((stateFamily) => ["failed", "rejected"].includes(runs[stateFamily].status));
  const hasAnyAnalysis = Object.values(analyses).some((items) => items.length);
  return {
    status: failedFamilies.length ? "incomplete" : hasAnyAnalysis ? "analyzed" : "abstained",
    reason: failedFamilies.length ? "one-or-more-family-analyzers-failed-or-rejected" : "",
    batchId,
    snapshots,
    runs,
    analyses,
    observations,
    rejected,
    failedFamilies,
    warnings,
    automaticStateProposalAllowed: false,
  };
}
