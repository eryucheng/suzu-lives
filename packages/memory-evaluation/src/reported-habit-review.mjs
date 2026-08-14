import { buildCanonicalStateEvidenceSnapshot } from "./canonical-state-snapshot.mjs";
import {
  normalizeReportedClaim,
  selectLatestReportedCandidate,
} from "./reported-state-review-core.mjs";

const SUBJECT_ROLES = new Set(["user", "agent", "other"]);
const ACTIVE_PATTERNS = new Set(["repeated", "habitual"]);
const CLOSED_PATTERNS = new Set(["interrupted", "stopped"]);
const CURRENT_TIMES = new Set(["current", "changed"]);
const CHANGE_CUES = new Set(["changed", "interrupted", "stopped", "denies_prior_state"]);
const TARGET_RANK = Object.freeze({ subcategory: 0, exact: 1 });

function clean(value) {
  return String(value ?? "").trim();
}

function normalized(value) {
  return normalizeReportedClaim(value);
}

function candidateFromObservation(observation) {
  const analysis = observation.analysis;
  if (observation.qualification !== "qualified"
    || observation.memory?.evidenceMode !== "explicit"
    || !["exact", "subcategory"].includes(analysis?.targetMatch)
    || !clean(analysis?.matchedLabel)
    || (!ACTIVE_PATTERNS.has(analysis?.patternType) && !CLOSED_PATTERNS.has(analysis?.patternType))
    || analysis?.evidenceBasis !== "explicit_self_report"
    || !CURRENT_TIMES.has(analysis?.timeState)) {
    return null;
  }
  const scope = {
    targetMatch: analysis.targetMatch,
    matchedLabel: clean(analysis.matchedLabel),
    contextLabel: clean(analysis.contextLabel),
  };
  return {
    observation,
    analysis,
    scope,
    claimKey: normalized([
      analysis.patternType,
      analysis.regularity,
      analysis.constraint,
      scope.targetMatch,
      scope.matchedLabel,
      scope.contextLabel,
    ].join("\u001f")),
    observedAt: observation.observedAt,
  };
}

function currentClaim(repository, snapshot) {
  if (!snapshot.currentState) return null;
  const memory = repository.getMemory(snapshot.currentState.id);
  const stored = memory?.metadata?.reportedHabit || memory?.metadata?.habitClaim || null;
  if (!stored || !ACTIVE_PATTERNS.has(clean(stored.patternType))) return null;
  const scope = stored.scope && typeof stored.scope === "object" ? stored.scope : stored;
  const targetMatch = clean(scope.targetMatch);
  const matchedLabel = clean(scope.matchedLabel);
  if (!Object.hasOwn(TARGET_RANK, targetMatch) || !matchedLabel) return null;
  return {
    patternType: clean(stored.patternType),
    regularity: clean(stored.regularity),
    constraint: clean(stored.constraint),
    scope: {
      targetMatch,
      matchedLabel,
      contextLabel: clean(scope.contextLabel),
    },
  };
}

function sameScope(left, right) {
  return left.targetMatch === right.targetMatch
    && normalized(left.matchedLabel) === normalized(right.matchedLabel)
    && normalized(left.contextLabel) === normalized(right.contextLabel);
}

function isNarrowerScope(candidate, current) {
  const candidateRank = TARGET_RANK[candidate.targetMatch] ?? 99;
  const currentRank = TARGET_RANK[current.targetMatch] ?? 99;
  if (candidateRank > currentRank) return false;
  if (candidateRank < currentRank) return true;
  if (normalized(candidate.matchedLabel) !== normalized(current.matchedLabel)) return false;
  return !normalized(current.contextLabel) && Boolean(normalized(candidate.contextLabel));
}

function actionAgainstCurrent(candidate, current) {
  const cue = candidate.analysis.revisionCue;
  if (ACTIVE_PATTERNS.has(candidate.analysis.patternType)) {
    const sameDefinition = candidate.analysis.patternType === current.patternType
      && clean(candidate.analysis.regularity) === current.regularity
      && clean(candidate.analysis.constraint) === current.constraint
      && sameScope(candidate.scope, current.scope);
    if (sameDefinition) return "reinforce";
    if (cue === "clarified" && isNarrowerScope(candidate.scope, current.scope)) return "narrow_scope";
    if (cue === "changed") return "supersede";
    return "review_required";
  }
  if (!sameScope(candidate.scope, current.scope)) return "review_required";
  if (candidate.analysis.patternType === "interrupted" && cue === "interrupted") return "interrupt";
  if (candidate.analysis.patternType === "stopped" && cue === "stopped") return "stop";
  if (cue === "denies_prior_state") return "correct_attribution";
  return "review_required";
}

function proposedState(candidate, snapshot) {
  return {
    kind: "belief_state",
    stateFamily: "habit",
    representationLayer: "reported",
    subjectRole: snapshot.target.subjectRole,
    subjectKey: snapshot.target.subjectKey,
    canonicalKey: snapshot.target.canonicalKey,
    evidenceMode: "explicit",
    temporalState: "current",
    statePhase: "active",
    validFrom: candidate.observedAt,
    habitClaim: {
      patternType: candidate.analysis.patternType,
      regularity: candidate.analysis.regularity,
      constraint: candidate.analysis.constraint,
      scope: candidate.scope,
      holderStatementStatus: "directly-reported",
      observedRegularityStatus: "unverified",
      preferenceStatus: "not-inferred",
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
    automaticEstablishedHabitWriteAllowed: false,
    automaticPreferenceWriteAllowed: false,
    automaticDispositionWriteAllowed: false,
    automaticBehaviorEvidenceWriteAllowed: false,
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

export function reviewReportedHabitState({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  subjectLabel,
  habitLabel,
  snapshotOptions = {},
} = {}) {
  if (!SUBJECT_ROLES.has(clean(subjectRole))) {
    throw new Error("Reported habit review requires one fixed personal subject.");
  }
  const baseResult = buildCanonicalStateEvidenceSnapshot({
    repository,
    agentId,
    stateFamily: "habit",
    subjectRole,
    subjectKey,
    canonicalKey,
    subjectLabel,
    stateLabel: habitLabel,
    ...snapshotOptions,
    currentRepresentationLayer: "reported",
  });
  if (baseResult.status === "skipped") {
    return { ...baseResult, representationLayer: "reported", ...flags() };
  }
  const snapshot = baseResult.snapshot;
  const candidates = snapshot.observations.map(candidateFromObservation).filter(Boolean);
  if (!candidates.length) {
    return {
      status: "skipped",
      reason: "no-qualified-direct-current-habit-report",
      snapshot,
      representationLayer: "reported",
      ...flags(),
    };
  }
  const selection = selectLatestReportedCandidate(candidates, {
    hasCurrentState: Boolean(snapshot.currentState),
    isExplicitChange: (candidate) => CHANGE_CUES.has(candidate.analysis.revisionCue),
  });
  if (selection.status === "review_required") {
    return reviewRequired(snapshot, selection.reason, selection);
  }
  const selected = selection.selected;
  const existing = currentClaim(repository, snapshot);
  if (snapshot.currentState && !existing) {
    return reviewRequired(snapshot, "current-reported-habit-lacks-structured-claim-metadata", selection);
  }
  if (!existing && !ACTIVE_PATTERNS.has(selected.analysis.patternType)) {
    return reviewRequired(snapshot, "closed-habit-report-cannot-create-a-current-state", selection);
  }
  const action = existing ? actionAgainstCurrent(selected, existing) : "create";
  if (action === "review_required") {
    return reviewRequired(snapshot, "latest-habit-report-does-not-prove-a-safe-transition", selection);
  }
  return {
    status: "ready",
    reason: "",
    representationLayer: "reported",
    action,
    currentStateId: snapshot.currentState?.id || "",
    proposedState: ["interrupt", "stop", "correct_attribution"].includes(action)
      ? null
      : proposedState(selected, snapshot),
    selectedObservationId: selected.observation.id,
    consideredObservationIds: selection.ordered.map((candidate) => candidate.observation.id),
    snapshot,
    truthBoundary: {
      holderHabitReportIsRecorded: true,
      observedRegularityStatus: "unverified",
      preferenceStatus: "not-inferred",
      dispositionStatus: "not-inferred",
      establishedHabitIsUnaffected: true,
    },
    ...flags(),
  };
}
