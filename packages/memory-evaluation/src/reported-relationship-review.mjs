import { buildCanonicalStateEvidenceSnapshot } from "./canonical-state-snapshot.mjs";
import {
  normalizeReportedClaim,
  selectLatestReportedCandidate,
} from "./reported-state-review-core.mjs";

const SUBJECT_ROLES = new Set(["user", "agent", "other"]);
const ACTIVE_TIMES = new Set(["current", "temporary"]);
const ACTIVE_DURATIONS = new Set(["ongoing", "temporary", "one_time"]);
const SCOPED_RELATION_TYPES = new Set(["boundary", "permission"]);

function clean(value) {
  return String(value ?? "").trim();
}

function sameActor(leftRole, leftKey, rightRole, rightKey) {
  return clean(leftRole) === clean(rightRole) && clean(leftKey) === clean(rightKey);
}

function candidateFromObservation(observation, currentStatePresent) {
  const grounding = observation.analysis?.grounding;
  const perspective = observation.analysis?.perspective;
  const scopeTime = observation.analysis?.scopeTime;
  const relation = observation.analysis?.relation;
  const comparisonLayer = clean(observation.scope?.currentRepresentationLayer);
  const isExplicitRevocation = grounding?.polarity === "withdraws"
    && scopeTime?.revocationCue === "explicit"
    && relation?.relation === "revokes";
  if (observation.qualification !== "qualified"
    || observation.memory?.evidenceMode !== "explicit"
    || comparisonLayer !== "reported"
    || !["exact", "subcategory"].includes(grounding?.targetMatch)
    || !clean(grounding?.relationType)
    || grounding.relationType === "unknown"
    || !clean(grounding?.relationLabel)
    || (SCOPED_RELATION_TYPES.has(grounding.relationType) && !clean(grounding.scopeLabel))
    || (grounding.polarity === "conditional" && !clean(grounding.conditionLabel))
    || perspective?.holderMatch !== "yes"
    || perspective?.counterpartMatch !== "yes"
    || perspective?.direction !== "holder_to_counterpart"
    || perspective?.attribution !== "explicit_self_statement"
    || !ACTIVE_TIMES.has(scopeTime?.stateTime)
    || (!ACTIVE_DURATIONS.has(scopeTime?.duration) && !isExplicitRevocation)
    || Boolean(relation?.currentStatePresent) !== currentStatePresent) {
    return null;
  }
  if (!currentStatePresent && relation?.relation !== "no_current_state") return null;
  if (currentStatePresent
    && ["no_current_state", "unrelated", "unknown"].includes(relation?.relation)) {
    return null;
  }
  return {
    observation,
    grounding,
    perspective,
    scopeTime,
    relation,
    claimKey: normalizeReportedClaim([
      grounding.relationType,
      grounding.polarity,
      grounding.relationLabel,
      grounding.scopeLabel,
      grounding.conditionLabel,
      scopeTime.duration,
    ].join("\u001f")),
    observedAt: observation.observedAt,
  };
}

function actionAgainstCurrent(candidate) {
  const relation = candidate.relation.relation;
  if (["equivalent", "supports"].includes(relation)) return "reinforce";
  if (relation === "narrows") return "narrow_scope";
  if (relation === "replaces") return "supersede";
  if (relation === "revokes"
    && candidate.grounding.polarity === "withdraws"
    && candidate.scopeTime.revocationCue === "explicit"
    && candidate.relation.scopeOverlap === "exact") {
    return "revoke";
  }
  return "review_required";
}

function proposedState(candidate, snapshot, counterpart) {
  return {
    kind: "relationship",
    stateFamily: "relationship",
    representationLayer: "reported",
    subjectRole: snapshot.target.subjectRole,
    subjectKey: snapshot.target.subjectKey,
    canonicalKey: snapshot.target.canonicalKey,
    evidenceMode: "explicit",
    temporalState: "current",
    statePhase: "active",
    validFrom: candidate.observedAt,
    counterpart,
    relationshipView: {
      relationType: candidate.grounding.relationType,
      polarity: candidate.grounding.polarity,
      label: clean(candidate.grounding.relationLabel),
      scopeLabel: clean(candidate.grounding.scopeLabel),
      conditionLabel: clean(candidate.grounding.conditionLabel),
      duration: candidate.scopeTime.duration,
      holderViewStatus: "directly-reported",
      truthStatus: "unverified",
      sharedConfirmation: "unconfirmed",
      runtimeAuthority: "none",
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
    automaticSharedRelationshipWriteAllowed: false,
    automaticCounterpartFactWriteAllowed: false,
    automaticCounterpartDispositionWriteAllowed: false,
    automaticOtherHolderStateWriteAllowed: false,
    automaticRuntimePermissionChangeAllowed: false,
  };
}

function reviewRequired(snapshot, reason, selection) {
  return {
    status: "review_required",
    reason,
    representationLayer: "reported",
    action: "review_required",
    proposedState: null,
    selectedObservationId: selection.selected?.observation.id || "",
    consideredObservationIds: selection.ordered.map((candidate) => candidate.observation.id),
    snapshot,
    ...flags(),
  };
}

export function reviewReportedRelationshipState({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  counterpartRole,
  counterpartKey,
  counterpartLabel,
  canonicalKey,
  subjectLabel,
  relationshipLabel,
  snapshotOptions = {},
} = {}) {
  const normalizedSubjectRole = clean(subjectRole);
  const normalizedCounterpartRole = clean(counterpartRole);
  const normalizedCounterpartKey = clean(counterpartKey);
  const normalizedCounterpartLabel = clean(counterpartLabel);
  if (!SUBJECT_ROLES.has(normalizedSubjectRole)) {
    throw new Error("Reported relationship review requires one fixed personal holder.");
  }
  if (!SUBJECT_ROLES.has(normalizedCounterpartRole)
    || !normalizedCounterpartKey || !normalizedCounterpartLabel) {
    throw new Error("Reported relationship review requires one fixed counterpart.");
  }
  if (sameActor(subjectRole, subjectKey, counterpartRole, counterpartKey)) {
    throw new Error("Reported relationship holder and counterpart must be different actors.");
  }
  const baseResult = buildCanonicalStateEvidenceSnapshot({
    repository,
    agentId,
    stateFamily: "relationship",
    subjectRole,
    subjectKey,
    canonicalKey,
    subjectLabel,
    stateLabel: relationshipLabel,
    ...snapshotOptions,
    currentRepresentationLayer: "reported",
  });
  if (baseResult.status === "skipped") {
    return { ...baseResult, representationLayer: "reported", ...flags() };
  }
  const snapshot = baseResult.snapshot;
  const candidates = snapshot.observations
    .map((observation) => candidateFromObservation(observation, Boolean(snapshot.currentState)))
    .filter(Boolean);
  if (!candidates.length) {
    return {
      status: "skipped",
      reason: "no-qualified-layer-aligned-direct-relationship-view",
      snapshot,
      representationLayer: "reported",
      ...flags(),
    };
  }
  const selection = selectLatestReportedCandidate(candidates, {
    hasCurrentState: Boolean(snapshot.currentState),
    isExplicitChange: (candidate) => (
      candidate.relation.relation === "replaces"
      || (candidate.relation.relation === "revokes"
        && candidate.scopeTime.revocationCue === "explicit")
    ),
  });
  if (selection.status === "review_required") {
    return reviewRequired(snapshot, selection.reason, selection);
  }
  const selected = selection.selected;
  if (!snapshot.currentState && selected.grounding.polarity === "withdraws") {
    return reviewRequired(
      snapshot,
      "relationship-withdrawal-cannot-revoke-a-missing-reported-state",
      selection,
    );
  }
  const action = snapshot.currentState ? actionAgainstCurrent(selected) : "create";
  if (action === "review_required") {
    return reviewRequired(
      snapshot,
      "latest-relationship-view-does-not-prove-a-safe-transition",
      selection,
    );
  }
  const counterpart = {
    role: normalizedCounterpartRole,
    key: normalizedCounterpartKey,
    label: normalizedCounterpartLabel,
  };
  return {
    status: "ready",
    reason: "",
    representationLayer: "reported",
    action,
    currentStateId: snapshot.currentState?.id || "",
    proposedState: action === "revoke" ? null : proposedState(selected, snapshot, counterpart),
    selectedObservationId: selected.observation.id,
    consideredObservationIds: selection.ordered.map((candidate) => candidate.observation.id),
    snapshot,
    truthBoundary: {
      holderViewIsRecorded: true,
      counterpartQualityTruth: "unverified",
      sharedRelationshipStatus: "unconfirmed",
      otherHolderViewIsUnaffected: true,
      establishedRelationshipStateIsUnaffected: true,
      runtimePermissionEffect: "none",
    },
    ...flags(),
  };
}
