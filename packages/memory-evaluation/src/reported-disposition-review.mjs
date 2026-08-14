import { buildCanonicalStateEvidenceSnapshot } from "./canonical-state-snapshot.mjs";
import {
  normalizeReportedClaim,
  selectLatestReportedCandidate,
} from "./reported-state-review-core.mjs";

const SUBJECT_ROLES = new Set(["user", "agent", "other"]);
const CURRENT_TIMES = new Set(["current", "changed"]);
const CHANGE_CUES = new Set(["changed", "denies_prior_state"]);
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
    || !["present", "absent"].includes(analysis?.tendencyPresence)
    || analysis?.evidenceType !== "explicit_self_description"
    || !CURRENT_TIMES.has(analysis?.timeState)
    || !clean(analysis?.responseLabel)) {
    return null;
  }
  const scope = {
    targetMatch: analysis.targetMatch,
    matchedLabel: clean(analysis.matchedLabel),
    situationLabel: clean(analysis.situationLabel),
    responseLabel: clean(analysis.responseLabel),
  };
  return {
    observation,
    analysis,
    presence: analysis.tendencyPresence,
    scope,
    claimKey: normalized([
      analysis.tendencyPresence,
      scope.targetMatch,
      scope.matchedLabel,
      scope.situationLabel,
      scope.responseLabel,
    ].join("\u001f")),
    observedAt: observation.observedAt,
  };
}

function currentClaim(repository, snapshot) {
  if (!snapshot.currentState) return null;
  const memory = repository.getMemory(snapshot.currentState.id);
  const stored = memory?.metadata?.reportedDisposition
    || memory?.metadata?.dispositionClaim
    || null;
  if (!stored || !["present", "absent"].includes(clean(stored.presence))) return null;
  const scope = stored.scope && typeof stored.scope === "object" ? stored.scope : stored;
  const targetMatch = clean(scope.targetMatch);
  const matchedLabel = clean(scope.matchedLabel);
  const responseLabel = clean(scope.responseLabel);
  if (!Object.hasOwn(TARGET_RANK, targetMatch) || !matchedLabel || !responseLabel) return null;
  return {
    presence: clean(stored.presence),
    scope: {
      targetMatch,
      matchedLabel,
      situationLabel: clean(scope.situationLabel),
      responseLabel,
    },
  };
}

function sameScope(left, right) {
  return left.targetMatch === right.targetMatch
    && normalized(left.matchedLabel) === normalized(right.matchedLabel)
    && normalized(left.situationLabel) === normalized(right.situationLabel)
    && normalized(left.responseLabel) === normalized(right.responseLabel);
}

function isNarrowerScope(candidate, current) {
  const candidateRank = TARGET_RANK[candidate.targetMatch] ?? 99;
  const currentRank = TARGET_RANK[current.targetMatch] ?? 99;
  if (candidateRank > currentRank) return false;
  if (candidateRank < currentRank) return true;
  if (normalized(candidate.matchedLabel) !== normalized(current.matchedLabel)
    || normalized(candidate.responseLabel) !== normalized(current.responseLabel)) {
    return false;
  }
  return !normalized(current.situationLabel) && Boolean(normalized(candidate.situationLabel));
}

function actionAgainstCurrent(candidate, current) {
  const cue = candidate.analysis.revisionCue;
  const samePresence = candidate.presence === current.presence;
  if (samePresence && sameScope(candidate.scope, current.scope)) return "reinforce";
  if (cue === "clarified" && isNarrowerScope(candidate.scope, current.scope)) {
    return samePresence ? "narrow_scope" : "add_scoped_exception";
  }
  if (!samePresence && cue === "changed") return "supersede";
  if (!samePresence && cue === "denies_prior_state") return "correct_attribution";
  return "review_required";
}

function proposedState(candidate, snapshot) {
  return {
    kind: "belief_state",
    stateFamily: "disposition",
    representationLayer: "reported",
    subjectRole: snapshot.target.subjectRole,
    subjectKey: snapshot.target.subjectKey,
    canonicalKey: snapshot.target.canonicalKey,
    evidenceMode: "explicit",
    temporalState: "current",
    statePhase: "active",
    validFrom: candidate.observedAt,
    dispositionClaim: {
      presence: candidate.presence,
      scope: candidate.scope,
      holderStatementStatus: "direct-self-description",
      crossContextStatus: "unverified",
      externalConstraintStatus: candidate.analysis.externalConstraint,
      objectiveDispositionStatus: "not-established",
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
    automaticEstablishedDispositionWriteAllowed: false,
    automaticTargetPersonalityWriteAllowed: false,
    automaticBeliefWriteAllowed: false,
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

export function reviewReportedDispositionState({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  subjectLabel,
  dispositionLabel,
  snapshotOptions = {},
} = {}) {
  if (!SUBJECT_ROLES.has(clean(subjectRole))) {
    throw new Error("Reported disposition review requires one fixed personal subject.");
  }
  const baseResult = buildCanonicalStateEvidenceSnapshot({
    repository,
    agentId,
    stateFamily: "disposition",
    subjectRole,
    subjectKey,
    canonicalKey,
    subjectLabel,
    stateLabel: dispositionLabel,
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
      reason: "no-qualified-direct-current-disposition-self-description",
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
    return reviewRequired(
      snapshot,
      "current-reported-disposition-lacks-structured-claim-metadata",
      selection,
    );
  }
  const action = existing ? actionAgainstCurrent(selected, existing) : "create";
  if (action === "review_required") {
    return reviewRequired(
      snapshot,
      "latest-direct-disposition-does-not-prove-a-safe-transition",
      selection,
    );
  }
  return {
    status: "ready",
    reason: "",
    representationLayer: "reported",
    action,
    currentStateId: snapshot.currentState?.id || "",
    proposedState: action === "correct_attribution" ? null : proposedState(selected, snapshot),
    selectedObservationId: selected.observation.id,
    consideredObservationIds: selection.ordered.map((candidate) => candidate.observation.id),
    snapshot,
    truthBoundary: {
      subjectSelfDescriptionIsRecorded: true,
      objectiveDispositionStatus: "not-established",
      crossContextStatus: "unverified",
      thirdPartyJudgmentIsNotSubjectSelfDescription: true,
      establishedDispositionIsUnaffected: true,
      scopedExceptionPreservesBroaderHistory: action === "add_scoped_exception",
    },
    ...flags(),
  };
}
