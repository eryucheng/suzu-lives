import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendUsageEvent } from "@suzu-lives/cost-ledger";

import {
  GOAL_ANALYZERS,
  buildGoalGenerationInput,
  parseGoalGeneration,
} from "./goal-contracts.mjs";
import { buildPreferenceEvidenceSnapshot } from "./preference-snapshot.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_DIRECTORY = path.join(PACKAGE_ROOT, "resources");
const GOAL_MEMORY_KINDS = new Set(["plan", "commitment", "open_loop"]);

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

function stableBatchId({
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  currentRepresentationLayer,
  memoryIds,
}) {
  const signature = [
    clean(agentId), clean(subjectRole), clean(subjectKey),
    clean(canonicalKey).toLocaleLowerCase("en-US"),
    clean(currentRepresentationLayer),
    uniqueStrings(memoryIds).sort().join("\u001f"),
  ].join("\u001e");
  return `goal-analysis-${createHash("sha256").update(signature).digest("hex").slice(0, 24)}`;
}

function currentStateView(
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  representationLayer = "",
) {
  const current = repository.getCurrentCanonicalMemory({
    agentId, subjectRole, subjectKey, canonicalKey, representationLayer, stateFamily: "goal",
  });
  if (!current) return null;
  if (!GOAL_MEMORY_KINDS.has(current.kind)) {
    throw new Error("Goal canonicalKey currently resolves to a non-goal memory kind.");
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
  if (role === "holder-responsibility" && analysis.attribution === "explicit_self_statement") {
    if (!targetHasRole(memory, target, new Set(["speaker"]), { allowPrimary: false })) {
      throw new Error("Explicit goal self statement requires the fixed subject as speaker.");
    }
    return;
  }
  if (!targetHasRole(memory, target, new Set(["subject", "speaker", "participant", "experiencer"]))) {
    throw new Error("Goal analysis does not identify the fixed goal holder.");
  }
}

function enforceAnalysisBoundary(role, analysis, snapshot) {
  const memory = snapshot.memories.find((item) => item.id === analysis.memoryId);
  if (!memory) throw new Error("Goal analysis memory must come from the bounded snapshot.");
  const availableSourceIds = new Set(memory.sourceIds);
  if (analysis.sourceIds.some((sourceId) => !availableSourceIds.has(sourceId))) {
    throw new Error("Goal analysis source must directly support its selected memory.");
  }
  assertSubjectBoundary(role, analysis, memory, snapshot.target);
  if (role === "current-relation") {
    const hasCurrent = Boolean(snapshot.currentState);
    if (analysis.currentStatePresent !== hasCurrent) {
      throw new Error("Goal current-state presence does not match the read-only snapshot.");
    }
    if (hasCurrent && analysis.relation === "no_current_state") {
      throw new Error("Goal relation cannot omit an available current state.");
    }
    if (!hasCurrent && analysis.relation !== "no_current_state") {
      throw new Error("Goal relation invented a current state.");
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
      feature: `memory-goal-${definition.role}`,
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
  const input = buildGoalGenerationInput(snapshot, definition);
  let generation = null;
  try {
    generation = await generator({
      input,
      systemPrompt,
      schema: definition.schema,
      schemaName: definition.schemaName,
      stateFamily: "goal",
      analyzerRole: definition.role,
    });
    const parsed = parseGoalGeneration(definition.role, generation?.output, { maximumAnalyses });
    const accepted = [];
    const rejected = [];
    const seen = new Set();
    for (const [index, candidate] of parsed.analyses.entries()) {
      try {
        if (seen.has(candidate.memoryId)) {
          throw new Error("A goal analyzer can analyze each memory at most once.");
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

function goalGate({ target, holder, lifecycle, relation, currentState }) {
  if (!target) return { qualification: "unresolved", reason: "missing-goal-target-analysis" };
  if (target.targetMatch === "none") return { qualification: "excluded", reason: "goal-target-does-not-match" };
  if (target.targetMatch === "contextual") return { qualification: "excluded", reason: "goal-target-is-context-only" };
  if (target.targetMatch === "unknown") return { qualification: "unresolved", reason: "goal-target-match-unknown" };
  if (target.targetMatch === "broader_category") {
    return { qualification: "unresolved", reason: "goal-target-is-broader-than-fixed-key" };
  }
  if (target.intentionLevel === "wish") return { qualification: "excluded", reason: "wish-is-not-a-current-goal" };
  if (target.intentionLevel === "considering") {
    return { qualification: "unresolved", reason: "consideration-is-not-a-decision" };
  }
  if (target.intentionLevel === "external_requirement") {
    return { qualification: "excluded", reason: "external-requirement-belongs-to-condition" };
  }
  if (target.intentionLevel === "no_goal") return { qualification: "excluded", reason: "memory-does-not-express-a-goal" };
  if (target.intentionLevel === "unknown" || !target.goalText) {
    return { qualification: "unresolved", reason: "goal-intent-unknown" };
  }
  if (!holder) return { qualification: "unresolved", reason: "missing-goal-holder-analysis" };
  if (holder.holderMatch === "no" || holder.responsibility === "other") {
    return { qualification: "excluded", reason: "goal-belongs-to-another-holder" };
  }
  if (holder.holderMatch === "unknown" || holder.responsibility === "unknown") {
    return { qualification: "unresolved", reason: "goal-holder-or-responsibility-unknown" };
  }
  if (holder.attribution === "quoted_or_roleplay") {
    return { qualification: "excluded", reason: "goal-is-quoted-or-roleplay" };
  }
  if (holder.attribution !== "explicit_self_statement") {
    return { qualification: "unresolved", reason: "goal-holder-is-not-direct-self-expression" };
  }
  if (holder.agency === "external_requirement") {
    if (holder.acceptsResponsibility === "no") {
      return { qualification: "excluded", reason: "subject-did-not-accept-external-requirement" };
    }
    if (holder.acceptsResponsibility !== "yes") {
      return { qualification: "unresolved", reason: "external-responsibility-acceptance-unknown" };
    }
  }
  if (!lifecycle) return { qualification: "unresolved", reason: "missing-goal-lifecycle-analysis" };
  if (lifecycle.lifecycle === "unknown") {
    return { qualification: "unresolved", reason: "goal-lifecycle-unknown" };
  }
  if (lifecycle.lifecycle === "completed"
    && !["explicit_self_report", "direct_result"].includes(lifecycle.completionBasis)) {
    return { qualification: "unresolved", reason: "goal-completion-not-directly-proven" };
  }
  if (["cancelled", "abandoned"].includes(lifecycle.lifecycle)
    && !["explicit_self_report", "direct_cancellation"].includes(lifecycle.completionBasis)) {
    return { qualification: "unresolved", reason: "goal-cancellation-not-directly-proven" };
  }
  if (!relation) return { qualification: "unresolved", reason: "missing-goal-current-relation-analysis" };
  if (Boolean(currentState) !== relation.currentStatePresent) {
    return { qualification: "unresolved", reason: "goal-current-state-presence-conflict" };
  }
  const requiredLifecycle = {
    completes: new Set(["completed"]),
    cancels: new Set(["cancelled", "abandoned"]),
    pauses: new Set(["paused", "blocked"]),
    resumes: new Set(["active", "in_progress"]),
    progress_update: new Set(["active", "in_progress", "blocked"]),
  }[relation.relation];
  if (requiredLifecycle && !requiredLifecycle.has(lifecycle.lifecycle)) {
    return { qualification: "unresolved", reason: "goal-relation-conflicts-with-lifecycle" };
  }
  if (currentState && lifecycle.lifecycle === "completed" && relation.relation !== "completes") {
    return { qualification: "unresolved", reason: "completed-goal-requires-completes-relation" };
  }
  if (currentState && ["cancelled", "abandoned"].includes(lifecycle.lifecycle)
    && relation.relation !== "cancels") {
    return { qualification: "unresolved", reason: "cancelled-goal-requires-cancels-relation" };
  }
  if (currentState && relation.relation === "unknown") {
    return { qualification: "unresolved", reason: "goal-current-relation-unknown" };
  }
  if (currentState && relation.relation === "unrelated") {
    return { qualification: "excluded", reason: "goal-is-unrelated-to-current-canonical-state" };
  }
  return null;
}

function proposedKind(intentionLevel) {
  if (intentionLevel === "commitment") return "commitment";
  if (intentionLevel === "open_loop") return "open_loop";
  return "plan";
}

function directionFor(relation, currentState) {
  if (!currentState || relation?.relation === "no_current_state") return "support";
  if (["completes", "cancels", "replaces", "conflict"].includes(relation?.relation)) return "opposition";
  if (relation?.relation === "unrelated" || relation?.relation === "unknown") return "neutral";
  return "support";
}

function signalFor(target, lifecycle) {
  if (lifecycle?.lifecycle === "completed") return "goal_completed";
  if (["cancelled", "abandoned"].includes(lifecycle?.lifecycle)) return "goal_cancelled";
  if (lifecycle?.lifecycle === "paused") return "goal_paused";
  if (lifecycle?.lifecycle === "blocked") return "goal_blocked";
  return {
    intention: "goal_intention",
    plan: "goal_plan",
    commitment: "goal_commitment",
    open_loop: "goal_open_loop",
    wish: "goal_wish",
    considering: "goal_considering",
    external_requirement: "external_requirement",
    no_goal: "no_goal",
    unknown: "goal_unknown",
  }[target?.intentionLevel] || "goal_unknown";
}

function actionPreview({ qualification, target, lifecycle, relation, currentState }) {
  const base = {
    action: "no_conclusion",
    proposedKind: target ? proposedKind(target.intentionLevel) : "",
    reason: qualification === "qualified" ? "no-safe-goal-action" : "evidence-not-qualified",
    automaticStateWriteAllowed: false,
  };
  if (qualification !== "qualified" || !target || !lifecycle || !relation) return base;
  if (lifecycle.lifecycle === "historical") {
    return { ...base, reason: "historical-goal-evidence-does-not-change-current-state" };
  }
  if (!currentState) {
    if (["active", "in_progress", "blocked", "paused", "future"].includes(lifecycle.lifecycle)) {
      return { ...base, action: "create", reason: "direct-active-goal-without-existing-state" };
    }
    return { ...base, reason: "closed-or-historical-goal-does-not-create-current-state" };
  }
  return {
    no_current_state: base,
    same_goal: { ...base, action: "reinforce", reason: "same-goal-without-state-change" },
    progress_update: { ...base, action: "progress_update", reason: "direct-progress-on-current-goal" },
    pauses: { ...base, action: "pause", reason: "current-goal-paused-or-blocked" },
    resumes: { ...base, action: "resume", reason: "current-goal-resumed" },
    completes: { ...base, action: "complete", reason: "completion-directly-proven" },
    cancels: { ...base, action: "cancel", reason: "cancellation-directly-proven" },
    narrower_step: { ...base, action: "progress_update", reason: "new-item-is-a-step-not-a-replacement" },
    broader_goal: { ...base, action: "review_required", reason: "broader-goal-cannot-replace-current-automatically" },
    replaces: { ...base, action: "supersede", reason: "new-goal-explicitly-replaces-current" },
    conflict: { ...base, action: "review_required", reason: "conflicting-goal-state" },
    unrelated: base,
    unknown: base,
  }[relation.relation] || base;
}

function mergeGoalAnalyses({ evaluation, persistEvidenceLedger }) {
  const maps = Object.fromEntries(
    Object.entries(evaluation.analyses).map(([key, items]) => [key, byMemory(items)]),
  );
  const memoryIds = uniqueStrings(Object.values(evaluation.analyses).flat().map((item) => item.memoryId));
  const observations = [];
  const previews = [];
  for (const memoryId of memoryIds) {
    const memory = evaluation.snapshot.memories.find((item) => item.id === memoryId);
    const target = maps.targetIntent?.get(memoryId) || null;
    const holder = maps.holderResponsibility?.get(memoryId) || null;
    const lifecycle = maps.lifecycle?.get(memoryId) || null;
    const relation = maps.currentRelation?.get(memoryId) || null;
    const gate = goalGate({ target, holder, lifecycle, relation, currentState: evaluation.snapshot.currentState });
    const qualification = gate?.qualification || "qualified";
    const claimedDirection = directionFor(relation, evaluation.snapshot.currentState);
    const analyses = [target, holder, lifecycle, relation].filter(Boolean);
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
        stateFamily: "goal",
        subjectRole: evaluation.snapshot.target.subjectRole,
        subjectKey: evaluation.snapshot.target.subjectKey,
        canonicalKey: evaluation.snapshot.target.canonicalKey,
        memoryId,
        evidenceGroupId: memory.evidenceGroupId,
        contextId: memory.contextId,
        signal: signalFor(target, lifecycle),
        claimedDirection,
        effectiveDirection: qualification === "qualified" ? claimedDirection : "neutral",
        qualification,
        confidence: Math.min(...analyses.map((item) => item.confidence)),
        origin: "llm",
        scope: {
          goalLabel: evaluation.snapshot.target.goalLabel,
          targetMatch: target?.targetMatch || "unknown",
          intentionLevel: target?.intentionLevel || "unknown",
          lifecycle: lifecycle?.lifecycle || "unknown",
          currentRelation: relation?.relation || "unknown",
          currentRepresentationLayer: evaluation.snapshot.target.currentRepresentationLayer,
        },
        payloadSchemaVersion: "goal-merged-evidence-v1",
        payload: { target, holder, lifecycle, relation },
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
        qualification, target, lifecycle, relation, currentState: evaluation.snapshot.currentState,
      }),
    });
  }
  return { observations, previews };
}

export async function evaluateGoalEvidence({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  goalLabel,
  currentRepresentationLayer = "",
  memoryIds = [],
  analyzers = {},
  usageLedgerPath = "",
  promptDirectory = DEFAULT_PROMPT_DIRECTORY,
  snapshotOptions = {},
  maximumAnalyses = 60,
  persistEvidenceLedger = true,
} = {}) {
  if (!repository) throw new Error("Goal evaluation requires a repository.");
  if (clean(subjectRole) === "shared") {
    throw new Error("Goal evaluation currently requires an individual fixed subject; shared commitments need bilateral review.");
  }
  if (!clean(goalLabel)) throw new Error("Goal evaluation requires a readable goalLabel.");
  for (const key of Object.keys(GOAL_ANALYZERS)) {
    if (typeof analyzers[key] !== "function") throw new Error(`Goal evaluation requires analyzers.${key}.`);
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
    repository, agentId, subjectRole, subjectKey, canonicalKey,
    memoryIds: normalizedMemoryIds,
    ...snapshotOptions,
  });
  const snapshot = {
    ...baseSnapshot,
    agentId: clean(agentId),
    target: {
      ...baseSnapshot.target,
      stateFamily: "goal",
      goalLabel: clean(goalLabel),
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
      sharedCommitmentsRequireSeparateBilateralReview: true,
    },
  };
  const snapshotLimit = Math.min(250_000, Math.max(4_000, Math.trunc(Number(snapshotOptions.maxSnapshotChars) || 64_000)));
  if (JSON.stringify(snapshot).length > snapshotLimit) {
    throw new Error(`Goal evidence snapshot exceeds the ${snapshotLimit}-character privacy budget.`);
  }
  if (!snapshot.memories.length) {
    return {
      status: "skipped",
      reason: "no-eligible-memories-with-direct-sources",
      batchId,
      snapshot,
      runs: {}, analyses: {}, rejected: {}, observations: [], actionPreviews: [],
      failedRoles: [], warnings: [], automaticStateWriteAllowed: false,
    };
  }

  const definitions = Object.entries(GOAL_ANALYZERS);
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
      stateFamily: "goal",
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
      costAmount: Number(invocation.generation?.costAmount ?? invocation.generation?.metadata?.costAmount ?? 0) || 0,
      costCurrency: clean(invocation.generation?.costCurrency ?? invocation.generation?.metadata?.costCurrency),
      requestId: clean(invocation.generation?.requestId),
      durationMs: Math.max(0, Math.trunc(Number(invocation.generation?.durationMs) || 0)),
      errorMessage: invocation.error,
      metadata: {
        goalLabel: clean(goalLabel),
        currentRepresentationLayer: snapshot.target.currentRepresentationLayer,
        automaticStateWriteAllowed: false,
      },
    });
    analyses[key] = invocation.analyses;
    rejected[key] = invocation.rejected;
  }
  const failedRoles = definitions
    .map(([key]) => key)
    .filter((key) => ["failed", "rejected"].includes(runs[key].status));
  let merged = { observations: [], previews: [] };
  if (!failedRoles.length) {
    merged = repository.transaction(() => mergeGoalAnalyses({
      evaluation: { repository, batchId, snapshot, runs, analyses },
      persistEvidenceLedger,
    }));
  }
  const hasAnyAnalysis = Object.values(analyses).some((items) => items.length);
  return {
    status: failedRoles.length ? "incomplete" : hasAnyAnalysis ? "analyzed" : "abstained",
    reason: failedRoles.length ? "required-goal-analyzer-failed-or-rejected" : "",
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
