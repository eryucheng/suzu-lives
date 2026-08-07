import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendUsageEvent } from "@suzu-lives/cost-ledger";

import {
  VALUE_ANALYZERS,
  buildValueGenerationInput,
  parseValueGeneration,
} from "./value-contracts.mjs";
import { buildPreferenceEvidenceSnapshot } from "./preference-snapshot.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_DIRECTORY = path.join(PACKAGE_ROOT, "resources");
const VALUE_MEMORY_KINDS = new Set(["belief_state", "derived_hypothesis"]);

function clean(value) {
  return String(value ?? "").trim();
}

function clip(value, maximum = 1200) {
  const text = clean(value);
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
}

function stableBatchId({ agentId, subjectRole, subjectKey, canonicalKey, currentRepresentationLayer, memoryIds }) {
  const signature = [
    clean(agentId),
    clean(subjectRole),
    clean(subjectKey),
    clean(canonicalKey).toLocaleLowerCase("en-US"),
    clean(currentRepresentationLayer),
    uniqueStrings(memoryIds).sort().join("\u001f"),
  ].join("\u001e");
  return `value-analysis-${createHash("sha256").update(signature).digest("hex").slice(0, 24)}`;
}

function currentStateView(repository, agentId, subjectRole, subjectKey, canonicalKey, representationLayer) {
  const current = repository.getCurrentCanonicalMemory({
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    representationLayer,
    stateFamily: "value",
  });
  if (!current) return null;
  if (!VALUE_MEMORY_KINDS.has(current.kind)) {
    throw new Error("Value canonicalKey currently resolves to a non-value-compatible memory kind.");
  }
  return {
    id: current.id,
    kind: current.kind,
    content: clip(current.content),
    subjectRole: current.subject_role,
    subjectKey: current.subject_key,
    canonicalKey: current.canonical_key,
    representationLayer: current.representation_layer,
    temporalState: current.temporal_state,
    knownAt: current.known_at,
    validFrom: current.valid_from,
    validTo: current.valid_to,
  };
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

function assertSubjectBoundary(role, analysis, memory, target) {
  if (role === "holder-attribution" && analysis.attribution === "explicit_self_statement") {
    if (!targetHasRole(memory, target, new Set(["speaker"]), { allowPrimary: false })) {
      throw new Error("Explicit value self statement requires the fixed subject as speaker.");
    }
    return;
  }
  if (!targetHasRole(
    memory,
    target,
    new Set(["subject", "speaker", "participant", "experiencer"]),
  )) {
    throw new Error("Value analysis does not identify the fixed value holder.");
  }
}

function enforceAnalysisBoundary(role, analysis, snapshot) {
  const memory = snapshot.memories.find((item) => item.id === analysis.memoryId);
  if (!memory) throw new Error("Value analysis memory must come from the bounded snapshot.");
  const availableSourceIds = new Set(memory.sourceIds);
  if (analysis.sourceIds.some((sourceId) => !availableSourceIds.has(sourceId))) {
    throw new Error("Value analysis source must directly support its selected memory.");
  }
  assertSubjectBoundary(role, analysis, memory, snapshot.target);
  if (role === "current-relation") {
    const hasCurrent = Boolean(snapshot.currentState);
    if (analysis.currentStatePresent !== hasCurrent) {
      throw new Error("Value current-state presence does not match the read-only snapshot.");
    }
    if (hasCurrent && analysis.relation === "no_current_state") {
      throw new Error("Value relation cannot omit an available current state.");
    }
    if (!hasCurrent && analysis.relation !== "no_current_state") {
      throw new Error("Value relation invented a current state.");
    }
  }
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
      feature: `memory-value-${definition.role}`,
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

async function invokeAnalyzer({ definition, generator, snapshot, promptDirectory, maximumAnalyses }) {
  const systemPrompt = fs.readFileSync(
    path.join(path.resolve(promptDirectory), definition.promptFile),
    "utf8",
  ).replace(/^\uFEFF/u, "").trim();
  const input = buildValueGenerationInput(snapshot, definition);
  let generation = null;
  try {
    generation = await generator({
      input,
      systemPrompt,
      schema: definition.schema,
      schemaName: definition.schemaName,
      stateFamily: "value",
      analyzerRole: definition.role,
    });
    const parsed = parseValueGeneration(definition.role, generation?.output, { maximumAnalyses });
    const accepted = [];
    const rejected = [];
    const seen = new Set();
    for (const [index, candidate] of parsed.analyses.entries()) {
      try {
        if (seen.has(candidate.memoryId)) {
          throw new Error("A value analyzer can analyze each memory at most once.");
        }
        accepted.push(enforceAnalysisBoundary(definition.role, candidate, snapshot));
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

function byMemory(items) {
  return new Map((Array.isArray(items) ? items : []).map((item) => [item.memoryId, item]));
}

function costlyChoiceGate(basis) {
  if (basis.protectedValueMatch === "no") {
    return { qualification: "excluded", reason: "choice-does-not-protect-the-fixed-value" };
  }
  if (basis.protectedValueMatch === "unknown") {
    return { qualification: "unresolved", reason: "protected-value-match-unknown" };
  }
  if (basis.agency === "constrained") {
    return { qualification: "excluded", reason: "choice-is-constrained" };
  }
  if (basis.agency === "unknown") {
    return { qualification: "unresolved", reason: "choice-agency-unknown" };
  }
  if (basis.alternatives === "absent") {
    return { qualification: "excluded", reason: "choice-had-no-real-alternative" };
  }
  if (basis.alternatives === "unknown") {
    return { qualification: "unresolved", reason: "choice-alternatives-unknown" };
  }
  if (basis.costType === "none") {
    return { qualification: "excluded", reason: "choice-had-no-identifiable-cost" };
  }
  if (basis.costType === "unknown") {
    return { qualification: "unresolved", reason: "choice-cost-unknown" };
  }
  return null;
}

function valueGate({ target, holder, basis, time, relation, currentState }) {
  if (!target) return { qualification: "unresolved", reason: "missing-value-target-analysis" };
  if (["none", "contextual"].includes(target.targetMatch)) {
    return { qualification: "excluded", reason: "memory-does-not-express-the-fixed-value" };
  }
  if (["unknown", "broader_category"].includes(target.targetMatch)) {
    return { qualification: "unresolved", reason: "value-target-is-not-exact-enough" };
  }
  if (target.stance === "no_value") {
    return { qualification: "excluded", reason: "memory-does-not-express-a-value-position" };
  }
  if (target.stance === "mentions") {
    return { qualification: "unresolved", reason: "value-is-only-mentioned" };
  }
  if (target.stance === "unknown" || !target.valueLabel) {
    return { qualification: "unresolved", reason: "value-stance-is-unknown" };
  }

  if (!holder) return { qualification: "unresolved", reason: "missing-value-holder-analysis" };
  if (holder.holderMatch === "no") {
    return { qualification: "excluded", reason: "value-belongs-to-another-holder" };
  }
  if (holder.holderMatch === "unknown") {
    return { qualification: "unresolved", reason: "value-holder-unknown" };
  }
  if (holder.attribution === "quoted_or_roleplay") {
    return { qualification: "excluded", reason: "value-is-quoted-or-roleplay" };
  }
  if (holder.attribution !== "explicit_self_statement") {
    return { qualification: "unresolved", reason: "value-is-not-the-holder-direct-expression-or-choice" };
  }

  if (!basis) return { qualification: "unresolved", reason: "missing-value-evidence-basis-analysis" };
  if (["constrained_behavior", "instrumental_behavior"].includes(basis.evidenceType)) {
    return { qualification: "excluded", reason: "behavior-is-constrained-or-instrumental" };
  }
  if (["slogan_or_aspiration", "no_tradeoff"].includes(basis.evidenceType)) {
    return { qualification: "excluded", reason: "slogan-or-no-tradeoff-is-not-value-evidence" };
  }
  if (basis.evidenceType === "ordinary_choice") {
    return { qualification: "unresolved", reason: "ordinary-choice-is-insufficient-value-evidence" };
  }
  if (basis.evidenceType === "unknown") {
    return { qualification: "unresolved", reason: "value-evidence-basis-unknown" };
  }
  if (basis.evidenceType === "costly_choice") {
    const gate = costlyChoiceGate(basis);
    if (gate) return gate;
  } else if (basis.protectedValueMatch === "no") {
    return { qualification: "excluded", reason: "principle-does-not-match-the-fixed-value" };
  } else if (basis.protectedValueMatch === "unknown") {
    return { qualification: "unresolved", reason: "principle-value-match-unknown" };
  }

  if (!time) return { qualification: "unresolved", reason: "missing-value-time-analysis" };
  if (time.stateTime === "future") {
    return { qualification: "excluded", reason: "future-aspiration-is-not-current-value-evidence" };
  }
  if (time.stateTime === "unknown" || time.revisionCue === "unknown") {
    return { qualification: "unresolved", reason: "value-time-or-revision-unknown" };
  }

  if (!relation) return { qualification: "unresolved", reason: "missing-value-current-relation-analysis" };
  if (Boolean(currentState) !== relation.currentStatePresent) {
    return { qualification: "unresolved", reason: "value-current-state-presence-conflict" };
  }
  if (relation.relation === "unknown") {
    return { qualification: "unresolved", reason: "value-current-relation-unknown" };
  }
  if (currentState && relation.relation === "unrelated") {
    return { qualification: "excluded", reason: "value-is-unrelated-to-current-canonical-state" };
  }
  if (currentState
    && ["narrows", "broadens", "same_scope_conflict", "replaces"].includes(relation.relation)
    && ["none", "unknown"].includes(relation.scopeOverlap)) {
    return { qualification: "unresolved", reason: "value-scope-overlap-is-not-proven" };
  }
  if (relation.relation === "replaces" && time.revisionCue !== "changed") {
    return { qualification: "unresolved", reason: "value-replacement-needs-explicit-change" };
  }
  return null;
}

function directionFor(target, relation, currentState) {
  if (["rejects", "deprioritizes"].includes(target?.stance)) return "opposition";
  if (!currentState || relation?.relation === "no_current_state") return "support";
  if (["narrows", "same_scope_conflict", "replaces"].includes(relation?.relation)) {
    return "opposition";
  }
  if (["unrelated", "unknown"].includes(relation?.relation)) return "neutral";
  return "support";
}

function signalFor(target, basis) {
  if (["rejects", "deprioritizes"].includes(target?.stance)) return "value_counter_evidence";
  return {
    explicit_principle: "value_principle_evidence",
    reasoned_priority: "value_priority_evidence",
    costly_choice: "value_costly_choice_evidence",
    ordinary_choice: "value_ordinary_choice",
    constrained_behavior: "value_constrained_behavior",
    instrumental_behavior: "value_instrumental_behavior",
    slogan_or_aspiration: "value_slogan_or_aspiration",
    no_tradeoff: "value_no_tradeoff",
    unknown: "value_unknown",
  }[basis?.evidenceType] || "value_unknown";
}

function actionPreview({ qualification, time, relation, currentState }) {
  const base = {
    action: "no_conclusion",
    proposedKind: "derived_hypothesis",
    reason: qualification === "qualified" ? "no-safe-value-action" : "evidence-not-qualified",
    automaticStateWriteAllowed: false,
  };
  if (qualification !== "qualified" || !time || !relation) return base;
  if (["historical", "temporary", "future"].includes(time.stateTime)) {
    return { ...base, reason: "non-current-value-evidence-does-not-change-current-state" };
  }
  if (!currentState) {
    return {
      ...base,
      action: "accumulate_evidence",
      reason: "single-value-evidence-needs-later-canonical-aggregation",
    };
  }
  return {
    no_current_state: base,
    equivalent: { ...base, action: "reinforce", reason: "same-value-evidence-supports-current-state" },
    supports: { ...base, action: "reinforce", reason: "new-evidence-supports-current-value" },
    narrows: { ...base, action: "narrow_scope", reason: "direct-evidence-narrows-current-value-scope" },
    broadens: { ...base, action: "review_required", reason: "broader-value-scope-needs-review" },
    same_scope_conflict: { ...base, action: "contradict", reason: "same-scope-value-conflict" },
    replaces: { ...base, action: "supersede", reason: "subject-explicitly-changed-current-value" },
    unrelated: base,
    unknown: base,
  }[relation.relation] || base;
}

function mergeValueAnalyses({ evaluation, persistEvidenceLedger }) {
  const maps = Object.fromEntries(
    Object.entries(evaluation.analyses).map(([key, items]) => [key, byMemory(items)]),
  );
  const memoryIds = uniqueStrings(Object.values(evaluation.analyses).flat().map((item) => item.memoryId));
  const observations = [];
  const previews = [];
  for (const memoryId of memoryIds) {
    const memory = evaluation.snapshot.memories.find((item) => item.id === memoryId);
    const target = maps.targetStance?.get(memoryId) || null;
    const holder = maps.holderAttribution?.get(memoryId) || null;
    const basis = maps.evidenceBasis?.get(memoryId) || null;
    const time = maps.timeRevision?.get(memoryId) || null;
    const relation = maps.currentRelation?.get(memoryId) || null;
    const gate = valueGate({
      target,
      holder,
      basis,
      time,
      relation,
      currentState: evaluation.snapshot.currentState,
    });
    const qualification = gate?.qualification || "qualified";
    const claimedDirection = directionFor(target, relation, evaluation.snapshot.currentState);
    const analyses = [target, holder, basis, time, relation].filter(Boolean);
    const sourceIds = uniqueStrings(analyses.flatMap((item) => item.sourceIds)).sort();
    const analysisRunIds = Object.entries(maps)
      .filter(([, map]) => map.has(memoryId))
      .map(([key]) => evaluation.runs[key])
      .filter((run) => run?.status === "completed")
      .map((run) => run.id)
      .sort();
    let observation = null;
    if (persistEvidenceLedger && sourceIds.length && analysisRunIds.length) {
      observation = evaluation.repository.recordStateEvidenceObservation({
        agentId: evaluation.snapshot.agentId,
        batchId: evaluation.batchId,
        stateFamily: "value",
        subjectRole: evaluation.snapshot.target.subjectRole,
        subjectKey: evaluation.snapshot.target.subjectKey,
        canonicalKey: evaluation.snapshot.target.canonicalKey,
        memoryId,
        evidenceGroupId: memory.evidenceGroupId,
        contextId: memory.contextId,
        signal: signalFor(target, basis),
        claimedDirection,
        effectiveDirection: qualification === "qualified" ? claimedDirection : "neutral",
        qualification,
        confidence: Math.min(...analyses.map((item) => item.confidence)),
        origin: "llm",
        scope: {
          valueLabel: evaluation.snapshot.target.valueLabel,
          targetMatch: target?.targetMatch || "unknown",
          stance: target?.stance || "unknown",
          scopeLabel: target?.scopeLabel || "",
          evidenceType: basis?.evidenceType || "unknown",
          stateTime: time?.stateTime || "unknown",
          currentRelation: relation?.relation || "unknown",
          scopeOverlap: relation?.scopeOverlap || "unknown",
          currentRepresentationLayer: evaluation.snapshot.target.currentRepresentationLayer,
        },
        payloadSchemaVersion: "value-merged-evidence-v1",
        payload: { target, holder, basis, time, relation },
        excludedReason: gate?.reason || "",
        sourceIds,
        analysisRunIds,
        observedAt: memory.eventStart || memory.eventDate || memory.knownAt,
      });
      observations.push(observation);
    }
    previews.push({
      memoryId,
      observationId: observation?.id || "",
      qualification,
      gateReason: gate?.reason || "",
      ...actionPreview({
        qualification,
        time,
        relation,
        currentState: evaluation.snapshot.currentState,
      }),
    });
  }
  return { observations, previews };
}

export async function evaluateValueEvidence({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  valueLabel,
  memoryIds = [],
  analyzers = {},
  usageLedgerPath = "",
  promptDirectory = DEFAULT_PROMPT_DIRECTORY,
  snapshotOptions = {},
  maximumAnalyses = 60,
  persistEvidenceLedger = true,
  currentRepresentationLayer = "",
} = {}) {
  if (!repository) throw new Error("Value evaluation requires a repository.");
  if (clean(subjectRole) === "shared") {
    throw new Error("Value evaluation currently requires an individual fixed subject.");
  }
  if (!clean(valueLabel)) throw new Error("Value evaluation requires a readable valueLabel.");
  for (const key of Object.keys(VALUE_ANALYZERS)) {
    if (typeof analyzers[key] !== "function") {
      throw new Error(`Value evaluation requires analyzers.${key}.`);
    }
  }
  const normalizedMemoryIds = uniqueStrings(memoryIds);
  const batchId = stableBatchId({
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    currentRepresentationLayer,
    memoryIds: normalizedMemoryIds,
  });
  const baseSnapshot = buildPreferenceEvidenceSnapshot({
    repository,
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    memoryIds: normalizedMemoryIds,
    ...snapshotOptions,
  });
  const snapshot = {
    ...baseSnapshot,
    agentId: clean(agentId),
    target: {
      ...baseSnapshot.target,
      stateFamily: "value",
      valueLabel: clean(valueLabel),
      currentRepresentationLayer: clean(currentRepresentationLayer),
    },
    currentState: currentStateView(
      repository,
      clean(agentId),
      baseSnapshot.target.subjectRole,
      baseSnapshot.target.subjectKey,
      baseSnapshot.target.canonicalKey,
      clean(currentRepresentationLayer),
    ),
    inputPolicy: {
      ...baseSnapshot.inputPolicy,
      currentStateIsReadOnly: true,
      currentStateLayerIsFixedByCaller: Boolean(clean(currentRepresentationLayer)),
      modelCanChooseStateAction: false,
      singleEvidenceCannotCreateStableValue: true,
      costlyChoiceNeedsAgencyAlternativesAndCost: true,
    },
  };
  const snapshotLimit = Math.min(250_000, Math.max(
    4_000,
    Math.trunc(Number(snapshotOptions.maxSnapshotChars) || 64_000),
  ));
  if (JSON.stringify(snapshot).length > snapshotLimit) {
    throw new Error(`Value evidence snapshot exceeds the ${snapshotLimit}-character privacy budget.`);
  }
  if (!snapshot.memories.length) {
    return {
      status: "skipped",
      reason: "no-eligible-memories-with-direct-sources",
      batchId,
      snapshot,
      runs: {},
      analyses: {},
      rejected: {},
      observations: [],
      actionPreviews: [],
      failedRoles: [],
      warnings: [],
      automaticStateWriteAllowed: false,
    };
  }

  const definitions = Object.entries(VALUE_ANALYZERS);
  const invocations = await Promise.all(definitions.map(async ([key, definition]) => [
    key,
    await invokeAnalyzer({
      definition,
      generator: analyzers[key],
      snapshot,
      promptDirectory,
      maximumAnalyses,
    }),
  ]));
  const sourceIds = uniqueStrings(snapshot.memories.flatMap((memory) => memory.sourceIds)).sort();
  const runs = {};
  const analyses = {};
  const rejected = {};
  const warnings = [];
  for (const [key, invocation] of invocations) {
    const warning = await appendAnalyzerUsage({
      usageLedgerPath,
      generation: invocation.generation,
      definition: invocation.definition,
      agentId: clean(agentId),
      batchId,
    });
    if (warning) warnings.push(warning);
    runs[key] = repository.recordStateAnalysisRun({
      agentId: clean(agentId),
      batchId,
      stateFamily: "value",
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
        valueLabel: clean(valueLabel),
        currentRepresentationLayer: clean(currentRepresentationLayer),
        automaticStateWriteAllowed: false,
      },
    });
    analyses[key] = invocation.analyses;
    rejected[key] = invocation.rejected;
  }
  const failedRoles = definitions
    .map(([key]) => key)
    .filter((key) => ["failed", "rejected"].includes(runs[key].status));

  const evaluation = { repository, batchId, snapshot, runs, analyses };
  let merged = { observations: [], previews: [] };
  if (!failedRoles.length) {
    merged = repository.transaction(() => mergeValueAnalyses({
      evaluation,
      persistEvidenceLedger,
    }));
  }
  const hasAnyAnalysis = Object.values(analyses).some((items) => items.length);
  return {
    status: failedRoles.length ? "incomplete" : hasAnyAnalysis ? "analyzed" : "abstained",
    reason: failedRoles.length ? "required-value-analyzer-failed-or-rejected" : "",
    batchId,
    snapshot,
    runs,
    analyses,
    rejected,
    observations: merged.observations,
    actionPreviews: merged.previews,
    failedRoles,
    warnings,
    automaticStateWriteAllowed: false,
  };
}
