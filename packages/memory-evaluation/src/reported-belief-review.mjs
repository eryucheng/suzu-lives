import { buildCanonicalStateEvidenceSnapshot } from "./canonical-state-snapshot.mjs";
import {
  normalizeReportedClaim,
  selectLatestReportedCandidate,
} from "./reported-state-review-core.mjs";

const SUBJECT_ROLES = new Set(["user", "agent", "shared", "other"]);
const OBJECT_ROLES = new Set(["user", "agent", "other", "world"]);
const CURRENT_TIMES = new Set(["current", "timeless"]);
const CHANGE_CUES = new Set(["changed_mind", "revises_scope", "retracts_current"]);

function clean(value) {
  return String(value ?? "").trim();
}

function candidateFromObservation(observation, currentStatePresent) {
  const proposition = observation.analysis?.proposition;
  const holder = observation.analysis?.holder;
  const time = observation.analysis?.time;
  const relation = observation.analysis?.relation;
  if (observation.qualification !== "qualified"
    || observation.memory?.evidenceMode !== "explicit"
    || observation.scope?.currentRepresentationLayer !== "reported"
    || proposition?.targetMatch !== "exact"
    || !clean(proposition?.claimText)
    || holder?.holderMatch !== "yes"
    || holder?.attribution !== "explicit_self_statement"
    || !CURRENT_TIMES.has(time?.stateTime)
    || Boolean(relation?.currentStatePresent) !== currentStatePresent) {
    return null;
  }
  if (!currentStatePresent && relation?.relation !== "no_current_state") return null;
  if (currentStatePresent && ["no_current_state", "unrelated", "unknown"].includes(relation?.relation)) {
    return null;
  }
  return {
    observation,
    proposition,
    holder,
    time,
    relation,
    claimKey: normalizeReportedClaim(proposition.claimText),
    observedAt: observation.observedAt,
  };
}

function actionAgainstCurrent(candidate) {
  const relation = candidate.relation.relation;
  const cue = candidate.time.revisionCue;
  if (["equivalent", "supports"].includes(relation)) return "reinforce";
  if (["narrows", "partial_exception"].includes(relation)) {
    return ["changed_mind", "revises_scope"].includes(cue) ? "narrow_scope" : "review_required";
  }
  if (relation === "broadens") {
    return ["changed_mind", "revises_scope"].includes(cue) ? "supersede" : "review_required";
  }
  if (["same_scope_conflict", "retracts"].includes(relation)) {
    if (cue === "denies_prior_holding") return "correct_attribution";
    return ["changed_mind", "retracts_current"].includes(cue) ? "supersede" : "review_required";
  }
  return "review_required";
}

function reportedState(candidate, snapshot, propositionTarget) {
  return {
    kind: "belief_state",
    stateFamily: "belief",
    representationLayer: "reported",
    subjectRole: snapshot.target.subjectRole,
    subjectKey: snapshot.target.subjectKey,
    canonicalKey: snapshot.target.canonicalKey,
    evidenceMode: "explicit",
    temporalState: "current",
    statePhase: "active",
    validFrom: candidate.observedAt,
    proposition: {
      text: clean(candidate.proposition.claimText),
      stance: candidate.proposition.stance,
      claimKind: candidate.proposition.claimKind,
      quantifier: candidate.proposition.quantifier,
      truthStatus: "unverified",
    },
    propositionTarget,
    scope: candidate.observation.scope,
    evidenceObservationIds: [candidate.observation.id],
    evidenceMemoryIds: [candidate.observation.memoryId],
    evidenceSourceIds: [...candidate.observation.sourceIds],
  };
}

function reviewResult(snapshot, reason, details = {}) {
  return {
    status: "review_required",
    reason,
    representationLayer: "reported",
    action: "review_required",
    proposedState: null,
    ...details,
    automaticStateWriteAllowed: false,
    automaticTargetFactWriteAllowed: false,
    automaticTargetDispositionWriteAllowed: false,
  };
}

export function reviewReportedBeliefState({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  subjectLabel,
  topicLabel,
  objectRole,
  objectKey,
  objectLabel,
  snapshotOptions = {},
} = {}) {
  const normalizedObjectRole = clean(objectRole);
  const normalizedObjectKey = clean(objectKey);
  const normalizedObjectLabel = clean(objectLabel);
  if (!SUBJECT_ROLES.has(clean(subjectRole)) || !OBJECT_ROLES.has(normalizedObjectRole)
    || (normalizedObjectRole !== "world" && !normalizedObjectKey) || !normalizedObjectLabel) {
    throw new Error("Reported belief review requires a fixed holder and proposition target.");
  }
  const baseResult = buildCanonicalStateEvidenceSnapshot({
    repository,
    agentId,
    stateFamily: "belief",
    subjectRole,
    subjectKey,
    canonicalKey,
    subjectLabel,
    stateLabel: topicLabel,
    ...snapshotOptions,
    currentRepresentationLayer: "reported",
  });
  if (baseResult.status === "skipped") {
    return {
      ...baseResult,
      representationLayer: "reported",
      automaticStateWriteAllowed: false,
      automaticTargetFactWriteAllowed: false,
      automaticTargetDispositionWriteAllowed: false,
    };
  }
  const snapshot = baseResult.snapshot;
  const propositionTarget = {
    role: normalizedObjectRole,
    key: normalizedObjectKey,
    label: normalizedObjectLabel,
  };
  const candidates = snapshot.observations
    .map((observation) => candidateFromObservation(observation, Boolean(snapshot.currentState)))
    .filter(Boolean);
  if (!candidates.length) {
    return {
      status: "skipped",
      reason: "no-qualified-direct-current-belief",
      snapshot,
      representationLayer: "reported",
      automaticStateWriteAllowed: false,
      automaticTargetFactWriteAllowed: false,
      automaticTargetDispositionWriteAllowed: false,
    };
  }

  const selection = selectLatestReportedCandidate(candidates, {
    hasCurrentState: Boolean(snapshot.currentState),
    isExplicitChange: (candidate) => CHANGE_CUES.has(candidate.time.revisionCue),
  });
  if (selection.status === "review_required") {
    const reason = selection.reason === "simultaneous-direct-state-conflict"
      ? "simultaneous-direct-belief-conflict"
      : "multiple-unresolved-direct-beliefs-without-change-cue";
    return reviewResult(snapshot, reason, {
      snapshot,
      selectedObservationId: selection.selected?.observation.id || "",
      consideredObservationIds: selection.ordered.map((candidate) => candidate.observation.id),
    });
  }
  const selected = selection.selected;
  const action = snapshot.currentState ? actionAgainstCurrent(selected) : "create";
  if (action === "review_required") {
    return reviewResult(snapshot, "latest-direct-belief-does-not-prove-a-safe-transition", {
      snapshot,
      selectedObservationId: selected.observation.id,
      consideredObservationIds: selection.ordered.map((candidate) => candidate.observation.id),
    });
  }
  const proposedState = action === "correct_attribution"
    ? null
    : reportedState(selected, snapshot, propositionTarget);
  return {
    status: "ready",
    reason: "",
    representationLayer: "reported",
    action,
    currentStateId: snapshot.currentState?.id || "",
    proposedState,
    selectedObservationId: selected.observation.id,
    consideredObservationIds: selection.ordered.map((candidate) => candidate.observation.id),
    snapshot,
    truthBoundary: {
      holderExpressionIsRecorded: true,
      propositionTruth: "unverified",
      propositionTargetIsNotTheHolderUnlessExplicitlyConfigured: (
        propositionTarget.role !== snapshot.target.subjectRole
        || propositionTarget.key !== snapshot.target.subjectKey
      ),
    },
    automaticStateWriteAllowed: false,
    automaticTargetFactWriteAllowed: false,
    automaticTargetDispositionWriteAllowed: false,
  };
}
