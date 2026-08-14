import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendUsageEvent } from "@suzu-lives/cost-ledger";

import {
  BELIEF_ANALYZERS,
  buildBeliefGenerationInput,
  parseBeliefGeneration,
} from "./belief-contracts.mjs";
import { buildPreferenceEvidenceSnapshot } from "./preference-snapshot.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_DIRECTORY = path.join(PACKAGE_ROOT, "resources");

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
  return `belief-analysis-${createHash("sha256").update(signature).digest("hex").slice(0, 24)}`;
}

function currentStateView(repository, agentId, subjectRole, subjectKey, canonicalKey, representationLayer) {
  const current = repository.getCurrentCanonicalMemory({
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    representationLayer,
    stateFamily: "belief",
  });
  if (!current) return null;
  const detail = repository.getMemoryDetail(agentId, current.id);
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
    roles: detail.roles.map((role) => ({
      role: role.role,
      actorRole: role.actor_role,
      actorKey: role.actor_key,
    })),
    sourceIds: detail.sources
      .filter((source) => source.relation === "evidence")
      .map((source) => source.id),
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
      throw new Error("Explicit belief self statement requires the fixed subject as speaker.");
    }
    return;
  }
  if (!targetHasRole(memory, target, new Set([
    "subject", "speaker", "belief_holder", "experiencer",
  ]))) {
    throw new Error("Belief analysis does not identify the fixed belief holder.");
  }
}

function enforceAnalysisBoundary(role, analysis, snapshot) {
  const memory = snapshot.memories.find((item) => item.id === analysis.memoryId);
  if (!memory) throw new Error("Belief analysis memory must come from the bounded snapshot.");
  const availableSourceIds = new Set(memory.sourceIds);
  if (analysis.sourceIds.some((sourceId) => !availableSourceIds.has(sourceId))) {
    throw new Error("Belief analysis source must directly support its selected memory.");
  }
  assertSubjectBoundary(role, analysis, memory, snapshot.target);
  if (role === "current-relation") {
    const hasCurrent = Boolean(snapshot.currentState);
    if (analysis.currentStatePresent !== hasCurrent) {
      throw new Error("Belief current-state presence does not match the read-only snapshot.");
    }
    if (hasCurrent && analysis.relation === "no_current_state") {
      throw new Error("Belief relation cannot omit an available current state.");
    }
    if (!hasCurrent && analysis.relation !== "no_current_state") {
      throw new Error("Belief relation invented a current state.");
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
      feature: `memory-belief-${definition.role}`,
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
  const input = buildBeliefGenerationInput(snapshot, definition);
  let generation = null;
  try {
    generation = await generator({
      input,
      systemPrompt,
      schema: definition.schema,
      schemaName: definition.schemaName,
      stateFamily: "belief",
      analyzerRole: definition.role,
    });
    const parsed = parseBeliefGeneration(definition.role, generation?.output, {
      maximumAnalyses,
    });
    const accepted = [];
    const rejected = [];
    const seen = new Set();
    for (const [index, candidate] of parsed.analyses.entries()) {
      try {
        if (seen.has(candidate.memoryId)) {
          throw new Error("A belief analyzer can analyze each memory at most once.");
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

function beliefGate({ proposition, holder, time, relation, currentState }) {
  if (!proposition) return { qualification: "unresolved", reason: "missing-proposition-analysis" };
  if (proposition.targetMatch === "none") {
    return { qualification: "excluded", reason: "belief-topic-does-not-match" };
  }
  if (proposition.targetMatch === "contextual") {
    return { qualification: "excluded", reason: "belief-topic-is-context-only" };
  }
  if (proposition.targetMatch === "unknown") {
    return { qualification: "unresolved", reason: "belief-topic-match-unknown" };
  }
  if (proposition.targetMatch === "broader_category") {
    return { qualification: "unresolved", reason: "belief-topic-is-broader-than-target" };
  }
  if (proposition.stance === "no_claim") {
    return { qualification: "excluded", reason: "memory-does-not-express-a-belief" };
  }
  if (proposition.stance === "unknown" || !proposition.claimText) {
    return { qualification: "unresolved", reason: "belief-claim-unknown" };
  }
  if (!holder) return { qualification: "unresolved", reason: "missing-holder-analysis" };
  if (holder.holderMatch === "no") {
    return { qualification: "excluded", reason: "belief-belongs-to-another-holder" };
  }
  if (holder.holderMatch === "unknown") {
    return { qualification: "unresolved", reason: "belief-holder-unknown" };
  }
  if (["quoted_or_roleplay", "no_holder"].includes(holder.attribution)) {
    return { qualification: "excluded", reason: "belief-is-quoted-roleplay-or-unheld" };
  }
  if (holder.attribution !== "explicit_self_statement") {
    return { qualification: "unresolved", reason: "belief-holder-is-not-direct-self-expression" };
  }
  if (!time) return { qualification: "unresolved", reason: "missing-belief-time-analysis" };
  if (time.stateTime === "future") {
    return { qualification: "excluded", reason: "future-belief-is-not-held-state" };
  }
  if (time.stateTime === "unknown") {
    return { qualification: "unresolved", reason: "belief-time-unknown" };
  }
  if (!relation) return { qualification: "unresolved", reason: "missing-current-relation-analysis" };
  if (Boolean(currentState) !== relation.currentStatePresent) {
    return { qualification: "unresolved", reason: "current-state-presence-conflict" };
  }
  if (currentState && ["unknown"].includes(relation.relation)) {
    return { qualification: "unresolved", reason: "belief-current-relation-unknown" };
  }
  if (currentState && relation.relation === "unrelated") {
    return { qualification: "excluded", reason: "belief-is-unrelated-to-current-canonical-state" };
  }
  return null;
}

function directionFor(relation, currentState) {
  if (!currentState || relation?.relation === "no_current_state") return "support";
  if (["equivalent", "supports", "broadens"].includes(relation?.relation)) return "support";
  if (["narrows", "partial_exception", "same_scope_conflict", "retracts"].includes(relation?.relation)) {
    return "opposition";
  }
  return "neutral";
}

function signalFor(proposition) {
  return {
    asserts: "belief_assertion",
    denies: "belief_denial",
    uncertain: "belief_uncertainty",
    mixed: "belief_mixed",
    no_claim: "no_belief_claim",
    unknown: "belief_unknown",
  }[proposition?.stance] || "belief_unknown";
}

function actionPreview({ qualification, proposition, holder, time, relation, currentState }) {
  const base = {
    action: "no_conclusion",
    reason: qualification === "qualified" ? "no-safe-state-action" : "evidence-not-qualified",
    automaticStateWriteAllowed: false,
  };
  if (qualification !== "qualified" || !proposition || !holder || !time || !relation) return base;
  if (!currentState) {
    if (["current", "timeless"].includes(time.stateTime)) {
      return { ...base, action: "create", reason: "direct-current-belief-without-existing-state" };
    }
    return { ...base, reason: "historical-belief-does-not-create-a-current-state" };
  }
  if (!["current", "timeless"].includes(time.stateTime)) {
    return { ...base, reason: "non-current-evidence-does-not-change-current-state" };
  }
  if (["equivalent", "supports"].includes(relation.relation)) {
    return { ...base, action: "reinforce", reason: "new-evidence-matches-current-belief" };
  }
  if (["narrows", "partial_exception"].includes(relation.relation)) {
    if (["changed_mind", "revises_scope"].includes(time.revisionCue)) {
      return { ...base, action: "narrow_scope", reason: "explicit-scope-revision-or-partial-exception" };
    }
    return { ...base, action: "contradict", reason: "scope-challenge-without-explicit-revision" };
  }
  if (relation.relation === "broadens") {
    if (["changed_mind", "revises_scope"].includes(time.revisionCue)) {
      return { ...base, action: "supersede", reason: "explicitly-broadened-current-belief" };
    }
    return { ...base, action: "contradict", reason: "broader-claim-without-explicit-revision" };
  }
  if (["same_scope_conflict", "retracts"].includes(relation.relation)) {
    if (time.revisionCue === "denies_prior_holding") {
      return { ...base, action: "correct_attribution", reason: "holder-denies-ever-holding-recorded-belief" };
    }
    if (["changed_mind", "retracts_current"].includes(time.revisionCue)) {
      return { ...base, action: "supersede", reason: "explicit-current-belief-change" };
    }
    return { ...base, action: "contradict", reason: "same-scope-conflict-without-change-proof" };
  }
  return base;
}

function mergeBeliefAnalyses({ evaluation, persistEvidenceLedger }) {
  const maps = Object.fromEntries(
    Object.entries(evaluation.analyses).map(([key, items]) => [key, byMemory(items)]),
  );
  const memoryIds = uniqueStrings(Object.values(evaluation.analyses).flat().map((item) => item.memoryId));
  const observations = [];
  const previews = [];
  for (const memoryId of memoryIds) {
    const memory = evaluation.snapshot.memories.find((item) => item.id === memoryId);
    const proposition = maps.propositionGrounding?.get(memoryId) || null;
    const holder = maps.holderAttribution?.get(memoryId) || null;
    const time = maps.timeRevision?.get(memoryId) || null;
    const relation = maps.currentRelation?.get(memoryId) || null;
    const gate = beliefGate({
      proposition,
      holder,
      time,
      relation,
      currentState: evaluation.snapshot.currentState,
    });
    const qualification = gate?.qualification || "qualified";
    const claimedDirection = directionFor(relation, evaluation.snapshot.currentState);
    const sourceIds = uniqueStrings([proposition, holder, time, relation]
      .filter(Boolean)
      .flatMap((item) => item.sourceIds)).sort();
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
        stateFamily: "belief",
        subjectRole: evaluation.snapshot.target.subjectRole,
        subjectKey: evaluation.snapshot.target.subjectKey,
        canonicalKey: evaluation.snapshot.target.canonicalKey,
        memoryId,
        evidenceGroupId: memory.evidenceGroupId,
        contextId: memory.contextId,
        signal: signalFor(proposition),
        claimedDirection,
        effectiveDirection: qualification === "qualified" ? claimedDirection : "neutral",
        qualification,
        confidence: Math.min(...[proposition, holder, time, relation]
          .filter(Boolean)
          .map((item) => item.confidence)),
        origin: "llm",
        scope: {
          topicLabel: evaluation.snapshot.target.topicLabel,
          targetMatch: proposition?.targetMatch || "unknown",
          quantifier: proposition?.quantifier || "unknown",
          stateTime: time?.stateTime || "unknown",
          currentRelation: relation?.relation || "unknown",
          scopeOverlap: relation?.scopeOverlap || "unknown",
          currentRepresentationLayer: evaluation.snapshot.target.currentRepresentationLayer,
        },
        payloadSchemaVersion: "belief-merged-evidence-v1",
        payload: { proposition, holder, time, relation },
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
        proposition,
        holder,
        time,
        relation,
        currentState: evaluation.snapshot.currentState,
      }),
    });
  }
  return { observations, previews };
}

export async function evaluateBeliefEvidence({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  topicLabel,
  memoryIds = [],
  analyzers = {},
  usageLedgerPath = "",
  promptDirectory = DEFAULT_PROMPT_DIRECTORY,
  snapshotOptions = {},
  maximumAnalyses = 60,
  persistEvidenceLedger = true,
  currentRepresentationLayer = "",
} = {}) {
  if (!repository) throw new Error("Belief evaluation requires a repository.");
  if (!clean(topicLabel)) throw new Error("Belief evaluation requires a readable topicLabel.");
  for (const key of Object.keys(BELIEF_ANALYZERS)) {
    if (typeof analyzers[key] !== "function") {
      throw new Error(`Belief evaluation requires analyzers.${key}.`);
    }
  }
  const normalizedMemoryIds = uniqueStrings(memoryIds);
  const batchId = stableBatchId({ agentId, subjectRole, subjectKey, canonicalKey,
    currentRepresentationLayer, memoryIds: normalizedMemoryIds });
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
      stateFamily: "belief",
      topicLabel: clean(topicLabel),
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
    },
  };
  const snapshotLimit = Math.min(250_000, Math.max(
    4_000,
    Math.trunc(Number(snapshotOptions.maxSnapshotChars) || 64_000),
  ));
  if (JSON.stringify(snapshot).length > snapshotLimit) {
    throw new Error(`Belief evidence snapshot exceeds the ${snapshotLimit}-character privacy budget.`);
  }
  if (!snapshot.memories.length) {
    return {
      status: "skipped",
      reason: "no-eligible-memories-with-direct-sources",
      batchId,
      snapshot,
      runs: {},
      analyses: {},
      observations: [],
      actionPreviews: [],
      failedRoles: [],
      warnings: [],
      automaticStateWriteAllowed: false,
    };
  }

  const definitions = Object.entries(BELIEF_ANALYZERS);
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
      stateFamily: "belief",
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
        topicLabel: clean(topicLabel),
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

  const evaluation = {
    repository,
    batchId,
    snapshot,
    runs,
    analyses,
  };
  let merged = { observations: [], previews: [] };
  if (!failedRoles.length) {
    merged = repository.transaction(() => mergeBeliefAnalyses({
      evaluation,
      persistEvidenceLedger,
    }));
  }
  const hasAnyAnalysis = Object.values(analyses).some((items) => items.length);
  return {
    status: failedRoles.length ? "incomplete" : hasAnyAnalysis ? "analyzed" : "abstained",
    reason: failedRoles.length ? "required-belief-analyzer-failed-or-rejected" : "",
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
