import { createHash } from "node:crypto";

import { proposePreferenceState } from "@suzu-lives/memory-core";

function clean(value) {
  return String(value ?? "").trim();
}

function currentLevel(memory) {
  const stored = clean(memory?.metadata?.preferenceStateLevel);
  if (stored) return stored;
  if (memory?.kind === "preference") {
    return memory.evidence_mode === "explicit" ? "direct_preference" : "stable_preference";
  }
  return "";
}

function representationLayerForLevel(level) {
  return ["direct_preference", "explicit_rejection"].includes(clean(level))
    ? "reported"
    : "inferred";
}

function levelForPreview(preview, current, evidenceReviewMode) {
  const direct = {
    "situational-tolerance": "situational_tolerance",
    "selection-tendency": "selection_tendency",
    "stable-preference-review": "stable_preference",
    "direct-preference": "direct_preference",
    "direct-rejection": "explicit_rejection",
  }[preview.status];
  if (direct) return direct;
  if ([
    "conflicting-evidence",
    "state-change-review-required",
  ].includes(preview.status)) {
    return currentLevel(current) || "no_conclusion";
  }
  if (preview.status === "behavioral-opposition") {
    return current && evidenceReviewMode === "full_canonical"
      ? "no_conclusion"
      : currentLevel(current) || "no_conclusion";
  }
  if (preview.status === "behavior-only" && current && evidenceReviewMode === "full_canonical") {
    return "no_conclusion";
  }
  return "";
}

function evidenceForProposal(labels, preview) {
  const evaluated = new Map((preview.evidence || []).map((item) => [item.memoryId, item]));
  return labels.map((label) => ({
    ...label,
    ignoredReason: clean(evaluated.get(label.memoryId)?.ignoredReason),
  }));
}

export function proposePreferenceStateFromEvaluation(repository, {
  agentId,
  evaluation,
  subjectLabel,
  objectLabel,
  scopeLabel = "",
  scope = {},
  evidenceReviewMode = "bounded",
  scopeChange = "",
  confidence,
  metadata = {},
} = {}) {
  if (!repository) throw new Error("Preference persistence requires a repository.");
  if (!evaluation?.preview) {
    return { status: "skipped", reason: "missing-preference-preview", proposal: null };
  }
  const normalizedAgentId = clean(agentId);
  if (!normalizedAgentId) throw new Error("Preference persistence requires agentId.");
  const preview = evaluation.preview;
  const previewLevel = levelForPreview(preview, null, clean(evidenceReviewMode) || "bounded");
  const representationLayer = representationLayerForLevel(previewLevel);
  const current = repository.getCurrentCanonicalMemory({
    agentId: normalizedAgentId,
    subjectRole: preview.subjectRole,
    subjectKey: preview.subjectKey,
    canonicalKey: preview.canonicalKey,
    representationLayer,
    stateFamily: "preference",
  });
  const proposedLevel = levelForPreview(preview, current, clean(evidenceReviewMode) || "bounded");
  if (!proposedLevel) {
    return {
      status: "skipped",
      reason: current ? "preview-does-not-support-state-transition" : "no-persistable-preference-state",
      proposal: null,
    };
  }
  if ([
    "behavioral-opposition",
    "conflicting-evidence",
    "state-change-review-required",
  ].includes(preview.status) && !current) {
    return { status: "skipped", reason: "challenge-has-no-current-state", proposal: null };
  }
  const metrics = {
    supportScore: preview.supportScore,
    oppositionScore: preview.oppositionScore,
    oppositionRatio: preview.oppositionRatio,
    independentSupport: preview.independentSupport,
    distinctSupportDays: preview.distinctSupportDays,
    distinctSupportContexts: preview.distinctSupportContexts,
    choiceEvidenceCount: preview.choiceEvidenceCount,
    selectionEvidenceCount: preview.selectionEvidenceCount,
    toleranceEvidenceCount: preview.toleranceEvidenceCount,
  };
  const proposal = proposePreferenceState(repository, {
    agentId: normalizedAgentId,
    batchId: evaluation.batchId,
    subjectRole: preview.subjectRole,
    subjectKey: preview.subjectKey,
    canonicalKey: preview.canonicalKey,
    subjectLabel,
    objectLabel,
    scopeLabel,
    scope,
    representationLayer,
    previousMemoryId: current?.id,
    proposedLevel,
    previewStatus: preview.status,
    policyVersion: preview.policyVersion,
    evidenceReviewMode,
    scopeChange,
    confidence,
    metrics,
    rationale: (preview.reasons || []).join("; "),
    evidence: evidenceForProposal(evaluation.labels || [], preview),
    metadata: {
      ...metadata,
      evaluationStatus: evaluation.status,
      rejectedEvidenceCount: evaluation.rejected?.length || 0,
    },
  });
  return { status: "pending", reason: "", proposal };
}

const REVIEW_ACTION_TO_TRANSITION = Object.freeze({
  maintain: "reinforce",
  create: "create",
  reinforce: "reinforce",
  promote: "promote",
  downgrade: "downgrade",
  narrow_scope: "narrow_scope",
});

const INFERRED_PREFERENCE_LEVELS = new Set([
  "situational_tolerance",
  "selection_tendency",
  "stable_preference",
  "no_conclusion",
]);

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  );
}

function canonicalHash(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

function assertCanonicalReviewStillCurrent(repository, review) {
  const snapshot = review.snapshot;
  const target = snapshot.target;
  const current = repository.getCurrentCanonicalMemory({
    agentId: snapshot.agentId,
    subjectRole: target.subjectRole,
    subjectKey: target.subjectKey,
    canonicalKey: target.canonicalKey,
    representationLayer: "inferred",
    stateFamily: "preference",
    stateScopeKey: "root",
  });
  if ((current?.id || "") !== (snapshot.currentState?.id || "")) {
    throw new Error("Inferred preference state changed after canonical review; review it again.");
  }
  const currentObservations = repository.listStateEvidenceObservations(snapshot.agentId, {
    stateFamily: "preference",
    subjectRole: target.subjectRole,
    subjectKey: target.subjectKey,
    canonicalKey: target.canonicalKey,
    lifecycles: ["current"],
    limit: 1000,
  });
  const reviewedIds = snapshot.observations.map((item) => item.id).sort();
  const currentIds = currentObservations.map((item) => item.id).sort();
  if (JSON.stringify(currentIds) !== JSON.stringify(reviewedIds)) {
    throw new Error("Preference evidence set changed after canonical review; review it again.");
  }
  const currentById = new Map(currentObservations.map((item) => [item.id, item]));
  for (const observation of snapshot.observations) {
    const currentObservation = currentById.get(observation.id);
    if (!currentObservation
      || currentObservation.observation_hash !== clean(observation.observationHash)) {
      throw new Error("Preference evidence observation changed after canonical review; review it again.");
    }
  }
}

function evidenceFromCanonicalReview(review) {
  const observations = new Map(review.snapshot.observations.map((item) => [item.id, item]));
  return review.synthesis.evidenceDecisions.map((decision) => {
    const observation = observations.get(decision.observationId);
    if (!observation) {
      throw new Error("Canonical preference review cited an observation outside its snapshot.");
    }
    const direction = {
      positive_preference_evidence: "support",
      negative_preference_evidence: "opposition",
      scope_exception: "neutral",
    }[decision.treatment];
    if (!direction) {
      throw new Error("Approved preference review contains unresolved evidence.");
    }
    return {
      ...observation.analysis,
      memoryId: observation.memoryId,
      sourceIds: observation.sourceIds,
      evidenceGroupId: observation.evidenceGroupId,
      contextId: observation.contextId,
      signal: observation.signal,
      direction,
      confidence: observation.confidence,
      ignoredReason: direction === "neutral" ? "canonical-review-scope-exception" : "",
      observationId: observation.id,
      observationHash: observation.observationHash,
      reviewTreatment: decision.treatment,
      reviewRationale: decision.rationale,
    };
  });
}

export function proposePreferenceStateFromCanonicalReview(repository, {
  agentId,
  review,
  metadata = {},
} = {}) {
  if (!repository) throw new Error("Canonical preference persistence requires a repository.");
  if (!review || review.status !== "approved-shadow"
    || review.critique?.verdict !== "approve_shadow"
    || !review.snapshot || !review.synthesis) {
    return {
      status: "skipped",
      reason: "canonical-review-is-not-approved",
      proposal: null,
    };
  }
  const normalizedAgentId = clean(agentId);
  if (!normalizedAgentId || normalizedAgentId !== review.snapshot.agentId) {
    throw new Error("Canonical preference persistence Agent does not match the reviewed snapshot.");
  }
  if (review.snapshot.target.representationLayer !== "inferred"
    || review.snapshot.target.stateScopeKey !== "root") {
    throw new Error("Canonical preference persistence only accepts the inferred root review lane.");
  }
  const proposedLevel = clean(review.synthesis.proposedLevel);
  if (!INFERRED_PREFERENCE_LEVELS.has(proposedLevel)) {
    return {
      status: "skipped",
      reason: "reported-preference-uses-reported-state-review",
      proposal: null,
    };
  }
  const expectedTransition = REVIEW_ACTION_TO_TRANSITION[review.synthesis.action];
  if (!expectedTransition) {
    return {
      status: "skipped",
      reason: "canonical-review-does-not-request-a-state-transition",
      proposal: null,
    };
  }
  assertCanonicalReviewStillCurrent(repository, review);
  const target = review.snapshot.target;
  const evidence = evidenceFromCanonicalReview(review);
  const reviewIdentity = {
    batchId: review.batchId,
    synthesisRunId: review.runs?.synthesizer?.id || "",
    criticRunId: review.runs?.critic?.id || "",
    observationIds: review.snapshot.observations.map((item) => item.id).sort(),
    observationHashes: review.snapshot.observations
      .map((item) => item.observationHash).sort(),
    observationSnapshots: review.snapshot.observations
      .map((item) => ({ id: item.id, hash: item.observationHash }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    synthesis: review.synthesis,
    critique: review.critique,
  };
  const proposal = proposePreferenceState(repository, {
    agentId: normalizedAgentId,
    batchId: review.batchId,
    subjectRole: target.subjectRole,
    subjectKey: target.subjectKey,
    canonicalKey: target.canonicalKey,
    subjectLabel: target.subjectLabel,
    objectLabel: target.objectLabel,
    scopeLabel: review.synthesis.scope.label,
    scope: review.synthesis.scope,
    representationLayer: "inferred",
    stateScopeKey: "root",
    previousMemoryId: review.snapshot.currentState?.id || null,
    proposedLevel,
    previewStatus: review.snapshot.deterministicPreview.status,
    policyVersion: review.snapshot.deterministicPreview.policyVersion,
    evidenceReviewMode: "full_canonical",
    scopeChange: review.synthesis.scopeChange === "narrow" ? "narrower" : "",
    expectedTransition,
    confidence: review.synthesis.confidence,
    metrics: {
      supportScore: review.snapshot.deterministicPreview.supportScore,
      oppositionScore: review.snapshot.deterministicPreview.oppositionScore,
      oppositionRatio: review.snapshot.deterministicPreview.oppositionRatio,
      independentSupport: review.snapshot.deterministicPreview.independentSupport,
      distinctSupportDays: review.snapshot.deterministicPreview.distinctSupportDays,
      distinctSupportContexts: review.snapshot.deterministicPreview.distinctSupportContexts,
      choiceEvidenceCount: review.snapshot.deterministicPreview.choiceEvidenceCount,
      selectionEvidenceCount: review.snapshot.deterministicPreview.selectionEvidenceCount,
      toleranceEvidenceCount: review.snapshot.deterministicPreview.toleranceEvidenceCount,
    },
    rationale: review.synthesis.rationale,
    evidence,
    provenance: "approved-canonical-preference-review-v1",
    metadata: {
      ...metadata,
      canonicalReview: {
        ...reviewIdentity,
        reviewHash: canonicalHash(reviewIdentity),
        representationLayer: "inferred",
        stateScopeKey: "root",
        establishedPromotionAllowed: false,
      },
    },
  });
  return { status: "pending", reason: "", proposal };
}
