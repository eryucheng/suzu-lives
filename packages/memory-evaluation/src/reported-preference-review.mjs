import { buildCanonicalStateEvidenceSnapshot } from "./canonical-state-snapshot.mjs";
import {
  normalizeReportedClaim,
  selectLatestReportedCandidate,
} from "./reported-state-review-core.mjs";

const SUBJECT_ROLES = new Set(["user", "agent", "other"]);
const CURRENT_TIMES = new Set(["current", "timeless"]);
const DIRECT_EXPRESSIONS = new Set(["likes", "prefers", "dislikes"]);
const EXPLICIT_SIGNALS = new Set(["explicit_preference", "explicit_rejection"]);
const CHANGE_CUES = new Set(["changed", "denies_prior_state"]);
const SCOPE_RANK = Object.freeze({
  exact_object: 0,
  context_only: 0,
  subcategory: 1,
  category: 2,
  unknown: 99,
});

function clean(value) {
  return String(value ?? "").trim();
}

function normalized(value) {
  return normalizeReportedClaim(value);
}

function polarityForExpression(expressionType) {
  return expressionType === "dislikes" ? "negative" : "positive";
}

function hasVerifiedExplicitLane(repository, snapshot, observation) {
  if (observation.memory?.evidenceMode === "explicit") return true;
  const reference = observation.analysis?.analysisRequest;
  if (!clean(reference?.id)
    || reference.evidenceMode !== "explicit"
    || reference.representationLayer !== "reported") return false;
  const request = repository.getStateAnalysisRequest(snapshot.agentId, reference.id);
  return Boolean(request
    && ["pending", "completed"].includes(request.status)
    && request.state_family === "preference"
    && request.subject_role === snapshot.target.subjectRole
    && request.subject_key === snapshot.target.subjectKey
    && request.canonical_key === snapshot.target.canonicalKey
    && request.representation_layer === "reported"
    && request.evidence_mode === "explicit"
    && request.memoryIds.includes(observation.memory.id)
    && observation.sourceIds.every((sourceId) => request.sourceIds.includes(sourceId)));
}

function candidateFromObservation(repository, snapshot, observation) {
  const object = observation.analysis?.objectGrounding;
  const explicit = observation.analysis?.explicitExpression;
  const time = observation.analysis?.timeScope;
  const selected = observation.analysis?.selectedSignals;
  const explicitSignal = clean(selected?.explicitSignal);
  if (observation.qualification !== "qualified"
    || !hasVerifiedExplicitLane(repository, snapshot, observation)
    || !["exact", "subcategory"].includes(object?.targetMatch)
    || !DIRECT_EXPRESSIONS.has(explicit?.expressionType)
    || explicit?.directness !== "explicit_self_statement"
    || !CURRENT_TIMES.has(time?.stateTime)
    || !EXPLICIT_SIGNALS.has(explicitSignal)
    || clean(selected?.signal) !== explicitSignal
    || !clean(time?.scopeLabel)) {
    return null;
  }
  const polarity = polarityForExpression(explicit.expressionType);
  if ((polarity === "positive" && explicitSignal !== "explicit_preference")
    || (polarity === "negative" && explicitSignal !== "explicit_rejection")) {
    return null;
  }
  const scope = {
    kind: clean(time.scopeKind),
    label: clean(time.scopeLabel),
    context: clean(time.contextLabel),
  };
  return {
    observation,
    object,
    explicit,
    time,
    selected,
    polarity,
    scope,
    claimKey: normalized([polarity, scope.kind, scope.label, scope.context].join("\u001f")),
    observedAt: observation.observedAt,
  };
}

function currentClaim(repository, snapshot) {
  if (!snapshot.currentState) return null;
  const memory = repository.getMemory(snapshot.currentState.id);
  const stored = memory?.metadata?.reportedPreference
    || memory?.metadata?.preferenceClaim
    || null;
  if (!stored || !["positive", "negative"].includes(clean(stored.polarity))) return null;
  const scope = stored.scope && typeof stored.scope === "object"
    ? stored.scope
    : stored;
  const kind = clean(scope.kind || scope.scopeKind);
  const label = clean(scope.label || scope.scopeLabel);
  if (!kind || !label || !Object.hasOwn(SCOPE_RANK, kind)) return null;
  return {
    polarity: clean(stored.polarity),
    scope: {
      kind,
      label,
      context: clean(scope.context || scope.contextLabel),
    },
  };
}

function sameScope(left, right) {
  return left.kind === right.kind
    && normalized(left.label) === normalized(right.label)
    && normalized(left.context) === normalized(right.context);
}

function isNarrowerScope(candidate, current) {
  const candidateRank = SCOPE_RANK[candidate.kind] ?? 99;
  const currentRank = SCOPE_RANK[current.kind] ?? 99;
  if (candidateRank > currentRank) return false;
  if (candidateRank < currentRank) return true;
  if (normalized(candidate.label) !== normalized(current.label)) return false;
  return !normalized(current.context) && Boolean(normalized(candidate.context));
}

function actionAgainstCurrent(candidate, current) {
  const cue = candidate.time.revisionCue;
  const samePolarity = candidate.polarity === current.polarity;
  if (samePolarity && sameScope(candidate.scope, current.scope)) return "reinforce";
  if (cue === "clarified" && isNarrowerScope(candidate.scope, current.scope)) {
    return samePolarity ? "narrow_scope" : "add_scoped_exception";
  }
  if (!samePolarity && cue === "changed") return "supersede";
  if (!samePolarity && cue === "denies_prior_state") return "correct_attribution";
  return "review_required";
}

function proposedState(candidate, snapshot) {
  return {
    kind: "preference",
    stateFamily: "preference",
    representationLayer: "reported",
    subjectRole: snapshot.target.subjectRole,
    subjectKey: snapshot.target.subjectKey,
    canonicalKey: snapshot.target.canonicalKey,
    evidenceMode: "explicit",
    temporalState: "current",
    statePhase: "active",
    validFrom: candidate.observedAt,
    preferenceClaim: {
      objectLabel: clean(candidate.object.matchedLabel) || candidate.scope.label,
      polarity: candidate.polarity,
      expressionType: candidate.explicit.expressionType,
      scope: candidate.scope,
      holderStatementStatus: "directly-reported",
      crossContextStability: "unverified",
      behavioralSupportStatus: "not-evaluated",
    },
    scope: candidate.observation.scope,
    evidenceObservationIds: [candidate.observation.id],
    evidenceMemoryIds: [candidate.observation.memoryId],
    evidenceSourceIds: [...candidate.observation.sourceIds],
  };
}

function flags() {
  return {
    automaticStateWriteAllowed: false,
    automaticStablePreferenceWriteAllowed: false,
    automaticSelectionTendencyWriteAllowed: false,
    automaticBehaviorEvidenceWriteAllowed: false,
    automaticGoalWriteAllowed: false,
  };
}

function reviewRequired(snapshot, reason, selection) {
  return {
    status: "review_required",
    reason,
    representationLayer: "reported",
    action: "review_required",
    proposedState: null,
    selectedObservationId: selection?.selected?.observation.id || "",
    consideredObservationIds: selection?.ordered?.map((candidate) => candidate.observation.id) || [],
    snapshot,
    ...flags(),
  };
}

export function reviewReportedPreferenceState({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  subjectLabel,
  objectLabel,
  snapshotOptions = {},
} = {}) {
  if (!SUBJECT_ROLES.has(clean(subjectRole))) {
    throw new Error("Reported preference review requires one fixed personal subject.");
  }
  const baseResult = buildCanonicalStateEvidenceSnapshot({
    repository,
    agentId,
    stateFamily: "preference",
    subjectRole,
    subjectKey,
    canonicalKey,
    subjectLabel,
    stateLabel: objectLabel,
    ...snapshotOptions,
    currentRepresentationLayer: "reported",
  });
  if (baseResult.status === "skipped") {
    return { ...baseResult, representationLayer: "reported", ...flags() };
  }
  const snapshot = baseResult.snapshot;
  const candidates = snapshot.observations
    .map((observation) => candidateFromObservation(repository, snapshot, observation))
    .filter(Boolean);
  if (!candidates.length) {
    return {
      status: "skipped",
      reason: "no-qualified-direct-current-preference-expression",
      snapshot,
      representationLayer: "reported",
      ...flags(),
    };
  }
  const selection = selectLatestReportedCandidate(candidates, {
    hasCurrentState: Boolean(snapshot.currentState),
    isExplicitChange: (candidate) => CHANGE_CUES.has(candidate.time.revisionCue),
  });
  if (selection.status === "review_required") {
    return reviewRequired(snapshot, selection.reason, selection);
  }
  const selected = selection.selected;
  const existing = currentClaim(repository, snapshot);
  if (snapshot.currentState && !existing) {
    return reviewRequired(
      snapshot,
      "current-reported-preference-lacks-structured-claim-metadata",
      selection,
    );
  }
  const action = existing ? actionAgainstCurrent(selected, existing) : "create";
  if (action === "review_required") {
    return reviewRequired(
      snapshot,
      "latest-direct-preference-does-not-prove-a-safe-transition",
      selection,
    );
  }
  const proposed = action === "correct_attribution" ? null : proposedState(selected, snapshot);
  return {
    status: "ready",
    reason: "",
    representationLayer: "reported",
    action,
    currentStateId: snapshot.currentState?.id || "",
    proposedState: proposed,
    selectedObservationId: selected.observation.id,
    consideredObservationIds: selection.ordered.map((candidate) => candidate.observation.id),
    snapshot,
    truthBoundary: {
      holderPreferenceExpressionIsRecorded: true,
      crossContextPreferenceStability: "unverified",
      behavioralSelectionTendencyIsUnaffected: true,
      establishedPreferenceIsUnaffected: true,
      scopedExceptionPreservesBroaderHistory: action === "add_scoped_exception",
    },
    ...flags(),
  };
}
