import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendUsageEvent } from "@suzu-lives/cost-ledger";

import { buildCanonicalStateEvidenceSnapshot } from "./canonical-state-snapshot.mjs";
import { simulatePreferenceFormation } from "./preference-simulator.mjs";
import {
  buildPreferenceStateCriticInput,
  buildPreferenceStateSynthesisInput,
  parsePreferenceStateCritic,
  parsePreferenceStateSynthesis,
  PREFERENCE_REVIEW_CONTRACTS,
} from "./preference-review-contracts.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_DIRECTORY = path.join(PACKAGE_ROOT, "resources");

function clean(value) {
  return String(value ?? "").trim();
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
}

function currentLevel(memory) {
  const stored = clean(memory?.metadata?.preferenceStateLevel);
  if (stored) return stored;
  if (memory?.kind === "preference") {
    return memory.evidence_mode === "explicit" ? "direct_preference" : "stable_preference";
  }
  return "";
}

function previewLevel(preview) {
  return {
    "situational-tolerance": "situational_tolerance",
    "selection-tendency": "selection_tendency",
    "stable-preference-review": "stable_preference",
  }[preview?.status] || "";
}

function allowedReviewLevels(preview, current) {
  const levels = new Set();
  const existing = currentLevel(current);
  const proposed = previewLevel(preview);
  if (existing) levels.add(existing);
  if (proposed) levels.add(proposed);
  if (!existing && !proposed) levels.add("no_conclusion");
  if (existing && ["behavioral-opposition", "behavior-only"].includes(preview?.status)) {
    levels.add("no_conclusion");
  }
  if (preview?.status === "state-change-review-required" && !existing) {
    levels.add("no_conclusion");
  }
  return [...levels];
}

function allowedReviewActions({ preview, current, observations }) {
  const actions = new Set(["review_required"]);
  const existing = currentLevel(current);
  const proposed = previewLevel(preview);
  if (!current) {
    if (proposed) actions.add("create");
    else actions.add("no_conclusion");
    return [...actions];
  }
  actions.add("maintain");
  if (proposed && proposed === existing) actions.add("reinforce");
  if (["behavioral-opposition", "behavior-only"].includes(preview?.status)) {
    actions.add("downgrade");
  }
  if (proposed && proposed !== existing) {
    if (proposed === "explicit_rejection" || existing === "explicit_rejection") {
      actions.add("replace_explicit");
    } else {
      const rank = {
        no_conclusion: 0,
        situational_tolerance: 1,
        selection_tendency: 2,
        stable_preference: 3,
        direct_preference: 4,
        explicit_rejection: 4,
      };
      if ((rank[proposed] ?? -1) > (rank[existing] ?? -1)) actions.add("promote");
      if ((rank[proposed] ?? -1) < (rank[existing] ?? -1)) actions.add("downgrade");
    }
  }
  if (observations.some((item) => [
    "counter-subcategory_exception", "counter-context_exception",
  ].includes(item.excludedReason ?? item.excluded_reason))) {
    actions.add("narrow_scope");
  }
  return [...actions];
}

function labelFromObservation(observation) {
  const source = observation.analysis?.legacySimulation || observation.analysis || {};
  return {
    memoryId: observation.memoryId,
    signal: observation.signal,
    subjectRole: observation.subjectRole,
    subjectKey: observation.subjectKey,
    evidenceGroupId: observation.evidenceGroupId,
    contextId: observation.contextId,
    eventTime: observation.observedAt,
    knownAt: observation.observedAt,
    confidence: Number(observation.confidence),
    agency: clean(source.agency) || "unknown",
    constraint: clean(source.constraint) || "unknown",
    alternatives: clean(source.alternatives) || "unknown",
    instrumentalGoal: clean(source.instrumentalGoal) || "unknown",
    opportunityCost: clean(source.opportunityCost) || "unknown",
    topicInitiation: clean(source.topicInitiation) || "unknown",
    affectiveExpression: clean(source.affectiveExpression) || "unknown",
    canDecline: source.canDecline === true,
  };
}

export function buildPreferenceCanonicalReviewSnapshot({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  subjectLabel,
  objectLabel,
  policy,
  maxObservations = 400,
  maxMemoryContentChars = 700,
  maxSourceContentChars = 900,
  maxSnapshotChars = 240_000,
} = {}) {
  const baseResult = buildCanonicalStateEvidenceSnapshot({
    repository,
    agentId,
    stateFamily: "preference",
    subjectRole,
    subjectKey,
    canonicalKey,
    currentRepresentationLayer: "inferred",
    subjectLabel,
    stateLabel: objectLabel,
    maxObservations,
    maxMemoryContentChars,
    maxSourceContentChars,
    maxCurrentStateContentChars: 1000,
    maxSnapshotChars,
  });
  if (baseResult.status === "skipped") return baseResult;
  const base = baseResult.snapshot;
  const normalizedAgentId = base.agentId;
  const normalizedSubjectRole = base.target.subjectRole;
  const normalizedSubjectKey = base.target.subjectKey;
  const normalizedCanonicalKey = base.target.canonicalKey;
  const observations = base.observations;
  const current = base.currentState ? repository.getMemory(base.currentState.id) : null;
  const effective = observations.filter((item) => (
    item.qualification === "qualified"
    && ["support", "opposition"].includes(item.effectiveDirection)
  ));
  if (!effective.length) {
    return { status: "skipped", reason: "no-qualified-directional-evidence", snapshot: null };
  }
  const preview = simulatePreferenceFormation({
    subjectRole: normalizedSubjectRole,
    subjectKey: normalizedSubjectKey,
    canonicalKey: normalizedCanonicalKey,
    evidence: effective.map(labelFromObservation),
    policy,
  });
  if (["direct-preference", "direct-rejection"].includes(preview.status)) {
    return {
      status: "skipped",
      reason: "explicit-preference-requires-reported-state-review",
      snapshot: null,
    };
  }
  const allowedLevels = allowedReviewLevels(preview, current);
  const snapshot = {
    schemaVersion: 1,
    agentId: normalizedAgentId,
    target: {
      subjectRole: normalizedSubjectRole,
      subjectKey: normalizedSubjectKey,
      canonicalKey: normalizedCanonicalKey,
      subjectLabel: base.target.subjectLabel,
      objectLabel: base.target.stateLabel,
      representationLayer: "inferred",
      stateScopeKey: "root",
    },
    currentState: current ? {
      id: current.id,
      level: currentLevel(current) || "unknown",
      content: base.currentState.content,
      scope: current.metadata?.preferenceScope || {},
      scopeLabel: clean(current.metadata?.preferenceScopeLabel),
      knownAt: current.known_at,
      validFrom: current.valid_from,
      validTo: current.valid_to,
      representationLayer: current.representation_layer,
      stateScopeKey: current.state_scope_key,
    } : null,
    deterministicPreview: preview,
    allowedLevels,
    allowedActions: allowedReviewActions({ preview, current, observations }),
    requiredDecisionObservationIds: effective.map((item) => item.id).sort(),
    observations,
    groups: base.groups,
    completeness: {
      currentObservationCount: observations.length,
      qualifiedDirectionalCount: effective.length,
      excludedCount: observations.filter((item) => item.qualification === "excluded").length,
      unresolvedCount: observations.filter((item) => item.qualification === "unresolved").length,
      currentStateEvidenceMemoryIds: base.completeness.currentStateEvidenceMemoryIds,
      currentStateEvidenceCovered: base.completeness.currentStateEvidenceCovered,
      silentlyTruncated: false,
    },
    inputPolicy: {
      targetIsFixedByCaller: true,
      allCurrentObservationsAreIncluded: true,
      deterministicPreviewCannotBeChangedByModel: true,
      modelCannotWriteMemoryOrProposals: true,
      sourceAndMemoryContentAreComplete: true,
    },
  };
  const charLimit = Math.min(1_000_000, Math.max(20_000, Math.trunc(Number(maxSnapshotChars) || 240_000)));
  if (JSON.stringify(snapshot).length > charLimit) {
    throw new Error(`Preference canonical review exceeds the complete ${charLimit}-character budget.`);
  }
  return { status: "ready", reason: "", snapshot };
}

function validateSynthesis(synthesis, snapshot) {
  if (!snapshot.allowedLevels.includes(synthesis.proposedLevel)) {
    throw new Error("State synthesis proposed a level outside the deterministic allowance.");
  }
  if (!snapshot.allowedActions.includes(synthesis.action)) {
    throw new Error("State synthesis proposed an action outside the deterministic allowance.");
  }
  const required = new Set(snapshot.requiredDecisionObservationIds);
  const seen = new Set();
  const observations = new Map(snapshot.observations.map((item) => [item.id, item]));
  for (const decision of synthesis.evidenceDecisions) {
    if (!required.has(decision.observationId)) {
      throw new Error("State synthesis cited an observation outside the required qualified set.");
    }
    if (seen.has(decision.observationId)) {
      throw new Error("State synthesis repeated an observation decision.");
    }
    seen.add(decision.observationId);
    const observation = observations.get(decision.observationId);
    if (decision.treatment === "positive_preference_evidence"
      && observation.effectiveDirection !== "support") {
      throw new Error("State synthesis treated non-support evidence as positive preference evidence.");
    }
    if (decision.treatment === "negative_preference_evidence"
      && observation.effectiveDirection !== "opposition") {
      throw new Error("State synthesis treated non-opposition evidence as negative preference evidence.");
    }
  }
  if (seen.size !== required.size) {
    throw new Error("State synthesis omitted qualified evidence observations.");
  }
  const hasUncertain = synthesis.evidenceDecisions.some((item) => item.treatment === "uncertain");
  if (hasUncertain && !["maintain", "review_required"].includes(synthesis.action)) {
    throw new Error("State synthesis cannot change state while qualified evidence remains uncertain.");
  }
  if (synthesis.action === "narrow_scope" && synthesis.scopeChange !== "narrow") {
    throw new Error("Scope narrowing requires scopeChange=narrow.");
  }
  if (synthesis.scopeChange === "narrow" && synthesis.action !== "narrow_scope") {
    throw new Error("scopeChange=narrow requires the narrow_scope action.");
  }
  if (["create", "narrow_scope", "replace_explicit"].includes(synthesis.action)
    && (!synthesis.scope.kind || !synthesis.scope.label)) {
    throw new Error("A created or changed preference state requires an explicit scope.");
  }
  if (["maintain", "reinforce"].includes(synthesis.action)
    && synthesis.proposedLevel !== snapshot.currentState?.level) {
    throw new Error("Maintaining or reinforcing must preserve the current level.");
  }
  const rank = {
    no_conclusion: 0,
    situational_tolerance: 1,
    selection_tendency: 2,
    stable_preference: 3,
    direct_preference: 4,
    explicit_rejection: 4,
  };
  const currentStateLevel = snapshot.currentState?.level || "";
  if (["promote", "downgrade", "replace_explicit"].includes(synthesis.action)
    && (!currentStateLevel || synthesis.proposedLevel === currentStateLevel)) {
    throw new Error("A state-changing action must select a different level from the current state.");
  }
  if (synthesis.action === "promote"
    && (rank[synthesis.proposedLevel] ?? -1) <= (rank[currentStateLevel] ?? -1)) {
    throw new Error("Promotion must select a higher supported preference level.");
  }
  if (synthesis.action === "downgrade"
    && (rank[synthesis.proposedLevel] ?? -1) >= (rank[currentStateLevel] ?? -1)) {
    throw new Error("Downgrade must select a lower supported preference level.");
  }
  if (synthesis.action === "replace_explicit"
    && synthesis.proposedLevel !== "explicit_rejection"
    && currentStateLevel !== "explicit_rejection") {
    throw new Error("Explicit replacement requires a polarity-changing explicit rejection state.");
  }
  const positiveCount = synthesis.evidenceDecisions
    .filter((item) => item.treatment === "positive_preference_evidence").length;
  const negativeCount = synthesis.evidenceDecisions
    .filter((item) => item.treatment === "negative_preference_evidence").length;
  if (["create", "promote", "reinforce"].includes(synthesis.action)
    && synthesis.proposedLevel !== "explicit_rejection" && positiveCount === 0) {
    throw new Error("A positive preference change requires positive preference evidence.");
  }
  if (["create", "promote", "replace_explicit"].includes(synthesis.action)
    && synthesis.proposedLevel === "explicit_rejection" && negativeCount === 0) {
    throw new Error("An explicit rejection state requires negative preference evidence.");
  }
  return synthesis;
}

function validateCritic(critic, snapshot, synthesis) {
  const validIds = new Set(snapshot.observations.map((item) => item.id));
  for (const issue of critic.issues) {
    if (issue.observationIds.some((id) => !validIds.has(id))) {
      throw new Error("State critic cited an observation outside the bounded review snapshot.");
    }
  }
  if (critic.verdict === "approve_shadow"
    && critic.issues.some((issue) => issue.severity === "critical")) {
    throw new Error("State critic cannot approve while reporting a critical issue.");
  }
  if (critic.verdict === "approve_shadow"
    && synthesis.evidenceDecisions.some((item) => item.treatment === "uncertain")) {
    throw new Error("State critic cannot approve a synthesis with unresolved qualified evidence.");
  }
  return critic;
}

function auditContext(snapshot) {
  const memoryIds = uniqueStrings([
    snapshot.currentState?.id,
    ...snapshot.observations.map((item) => item.memoryId),
  ]).sort();
  const sourceIds = uniqueStrings(snapshot.observations.flatMap((item) => item.sourceIds)).sort();
  return { memoryIds, sourceIds };
}

async function appendReviewUsage({ usageLedgerPath, generation, agentId, batchId, role }) {
  if (!clean(usageLedgerPath) || !generation?.model || !generation?.usage) return "";
  try {
    await appendUsageEvent(path.resolve(usageLedgerPath), {
      agentId,
      provider: generation.metadata?.provider || "",
      model: generation.model,
      source: "memory-evaluation",
      feature: `memory-${role}`,
      requestId: generation.requestId || "",
      usage: generation.usage,
      metadata: { batchId, durationMs: Number(generation.durationMs || 0), ...generation.metadata },
    });
    return "";
  } catch (error) {
    return `费用流水写入失败：${error.message}`;
  }
}

function recordReviewRun(repository, {
  contract,
  snapshot,
  batchId,
  input,
  generation,
  status,
  rejected = [],
  errorMessage = "",
  metadata = {},
}) {
  const { memoryIds, sourceIds } = auditContext(snapshot);
  return repository.recordStateAnalysisRun({
    agentId: snapshot.agentId,
    batchId,
    stateFamily: "preference",
    analyzerRole: contract.role,
    subjectRole: snapshot.target.subjectRole,
    subjectKey: snapshot.target.subjectKey,
    canonicalKey: snapshot.target.canonicalKey,
    provider: clean(generation?.metadata?.provider) || "unreported",
    model: clean(generation?.model) || "unreported",
    promptVersion: contract.promptVersion,
    schemaVersion: contract.schemaName,
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
    metadata: { automaticMemoryWriteAllowed: false, ...metadata },
  });
}

export async function reviewPreferenceCanonicalState({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  subjectLabel,
  objectLabel,
  policy,
  synthesizer,
  critic,
  usageLedgerPath = "",
  promptDirectory = DEFAULT_PROMPT_DIRECTORY,
  snapshotOptions = {},
} = {}) {
  if (!repository) throw new Error("Preference state review requires a repository.");
  if (typeof synthesizer !== "function" || typeof critic !== "function") {
    throw new Error("Preference state review requires separate synthesizer and critic generators.");
  }
  const built = buildPreferenceCanonicalReviewSnapshot({
    repository,
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    subjectLabel,
    objectLabel,
    policy,
    ...snapshotOptions,
  });
  if (built.status === "skipped") {
    return {
      status: "skipped",
      reason: built.reason,
      snapshot: null,
      synthesis: null,
      critique: null,
      runs: {},
      automaticMemoryWriteAllowed: false,
    };
  }
  const { snapshot } = built;
  const batchId = `preference-review-${createHash("sha256")
    .update(JSON.stringify({
      agentId: snapshot.agentId,
      canonicalKey: snapshot.target.canonicalKey,
      representationLayer: snapshot.target.representationLayer,
      stateScopeKey: snapshot.target.stateScopeKey,
      observationIds: snapshot.observations.map((item) => item.id).sort(),
      policyVersion: snapshot.deterministicPreview.policyVersion,
    }))
    .digest("hex").slice(0, 24)}`;
  const synthesisContract = PREFERENCE_REVIEW_CONTRACTS.synthesizer;
  const synthesisPrompt = fs.readFileSync(
    path.join(path.resolve(promptDirectory), synthesisContract.promptFile),
    "utf8",
  ).replace(/^\uFEFF/u, "").trim();
  const synthesisInput = buildPreferenceStateSynthesisInput(snapshot);
  let synthesisGeneration = null;
  let synthesis = null;
  let synthesisError = "";
  let synthesisRejected = [];
  try {
    synthesisGeneration = await synthesizer({
      input: synthesisInput,
      systemPrompt: synthesisPrompt,
      schema: synthesisContract.schema,
      schemaName: synthesisContract.schemaName,
      analyzerRole: synthesisContract.role,
    });
    synthesis = validateSynthesis(
      parsePreferenceStateSynthesis(synthesisGeneration?.output),
      snapshot,
    );
  } catch (error) {
    synthesisError = error.message;
    synthesisRejected = [{ error: error.message }];
  }
  const synthesisRun = recordReviewRun(repository, {
    contract: synthesisContract,
    snapshot,
    batchId,
    input: synthesisInput,
    generation: synthesisGeneration,
    status: synthesis ? "completed" : synthesisGeneration ? "rejected" : "failed",
    rejected: synthesisRejected,
    errorMessage: synthesisError,
  });
  const warnings = [];
  const synthesisWarning = await appendReviewUsage({
    usageLedgerPath,
    generation: synthesisGeneration,
    agentId: snapshot.agentId,
    batchId,
    role: "preference-state-synthesizer",
  });
  if (synthesisWarning) warnings.push(synthesisWarning);
  if (!synthesis) {
    return {
      status: "incomplete",
      reason: "state-synthesis-failed-or-rejected",
      batchId,
      snapshot,
      synthesis: null,
      critique: null,
      runs: { synthesizer: synthesisRun },
      warnings,
      automaticMemoryWriteAllowed: false,
    };
  }
  const criticContract = PREFERENCE_REVIEW_CONTRACTS.critic;
  const criticPrompt = fs.readFileSync(
    path.join(path.resolve(promptDirectory), criticContract.promptFile),
    "utf8",
  ).replace(/^\uFEFF/u, "").trim();
  const criticInput = buildPreferenceStateCriticInput(snapshot, synthesis);
  let criticGeneration = null;
  let critique = null;
  let criticError = "";
  let criticRejected = [];
  try {
    criticGeneration = await critic({
      input: criticInput,
      systemPrompt: criticPrompt,
      schema: criticContract.schema,
      schemaName: criticContract.schemaName,
      analyzerRole: criticContract.role,
    });
    critique = validateCritic(parsePreferenceStateCritic(criticGeneration?.output), snapshot, synthesis);
  } catch (error) {
    criticError = error.message;
    criticRejected = [{ error: error.message }];
  }
  const criticRun = recordReviewRun(repository, {
    contract: criticContract,
    snapshot,
    batchId,
    input: criticInput,
    generation: criticGeneration,
    status: critique ? "completed" : criticGeneration ? "rejected" : "failed",
    rejected: criticRejected,
    errorMessage: criticError,
    metadata: { synthesisRunId: synthesisRun.id },
  });
  const criticWarning = await appendReviewUsage({
    usageLedgerPath,
    generation: criticGeneration,
    agentId: snapshot.agentId,
    batchId,
    role: "preference-state-critic",
  });
  if (criticWarning) warnings.push(criticWarning);
  if (!critique) {
    return {
      status: "incomplete",
      reason: "state-critic-failed-or-rejected",
      batchId,
      snapshot,
      synthesis,
      critique: null,
      runs: { synthesizer: synthesisRun, critic: criticRun },
      warnings,
      automaticMemoryWriteAllowed: false,
    };
  }
  const status = {
    approve_shadow: "approved-shadow",
    revise: "revision-required",
    human_review: "human-review-required",
  }[critique.verdict];
  return {
    status,
    reason: "",
    batchId,
    snapshot,
    synthesis,
    critique,
    runs: { synthesizer: synthesisRun, critic: criticRun },
    warnings,
    pendingProposal: null,
    automaticMemoryWriteAllowed: false,
  };
}
