import { buildCanonicalStateEvidenceSnapshot } from "./canonical-state-snapshot.mjs";
import {
  normalizeReportedClaim,
  selectLatestReportedCandidate,
} from "./reported-state-review-core.mjs";

const SUBJECT_ROLES = new Set(["user", "agent", "other"]);
const HOLDER_ATTRIBUTIONS = new Set(["explicit_self_definition", "explicit_self_reflection"]);
const EXPRESSION_TYPES = new Set(["stable_self_definition", "reflective_reinterpretation"]);

function clean(value) {
  return String(value ?? "").trim();
}

function candidateFromObservation(observation, currentStatePresent) {
  const concept = observation.analysis?.concept;
  const holder = observation.analysis?.holder;
  const stability = observation.analysis?.stability;
  const time = observation.analysis?.time;
  const relation = observation.analysis?.relation;
  if (observation.qualification !== "qualified"
    || observation.memory?.evidenceMode !== "explicit"
    || observation.scope?.currentRepresentationLayer !== "reported"
    || concept?.targetMatch !== "exact"
    || !clean(concept?.conceptLabel)
    || holder?.holderMatch !== "yes"
    || !HOLDER_ATTRIBUTIONS.has(holder?.attribution)
    || !EXPRESSION_TYPES.has(stability?.expressionType)
    || time?.stateTime !== "current"
    || Boolean(relation?.currentStatePresent) !== currentStatePresent) {
    return null;
  }
  if (!currentStatePresent && relation?.relation !== "no_current_state") return null;
  if (currentStatePresent && ["no_current_state", "unrelated", "unknown"].includes(relation?.relation)) {
    return null;
  }
  return {
    observation,
    concept,
    holder,
    stability,
    time,
    relation,
    claimKey: normalizeReportedClaim([
      concept.conceptType,
      concept.conceptLabel,
      concept.scopeLabel,
    ].join("\u001f")),
    observedAt: observation.observedAt,
  };
}

function actionAgainstCurrent(candidate) {
  return {
    equivalent: "reinforce",
    supports: "reinforce",
    narrows: "narrow_scope",
    broadens: "review_required",
    same_scope_conflict: "contradict",
    replaces: "supersede",
    corrects_attribution: "correct_attribution",
  }[candidate.relation.relation] || "review_required";
}

function proposedState(candidate, snapshot) {
  return {
    kind: "belief_state",
    stateFamily: "self_concept",
    representationLayer: "reported",
    subjectRole: snapshot.target.subjectRole,
    subjectKey: snapshot.target.subjectKey,
    canonicalKey: snapshot.target.canonicalKey,
    evidenceMode: "explicit",
    temporalState: "current",
    statePhase: "active",
    validFrom: candidate.observedAt,
    selfUnderstanding: {
      conceptType: candidate.concept.conceptType,
      label: clean(candidate.concept.conceptLabel),
      scopeLabel: clean(candidate.concept.scopeLabel),
      expressionType: candidate.stability.expressionType,
      contextBasis: candidate.stability.contextBasis,
      status: "subjective-current-understanding",
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
    automaticIdentityWriteAllowed: false,
    automaticDispositionWriteAllowed: false,
    automaticPersonalityDiagnosisAllowed: false,
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

export function reviewReportedSelfConceptState({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  subjectLabel,
  selfConceptLabel,
  snapshotOptions = {},
} = {}) {
  if (!SUBJECT_ROLES.has(clean(subjectRole))) {
    throw new Error("Reported self-concept review requires one fixed personal subject.");
  }
  const baseResult = buildCanonicalStateEvidenceSnapshot({
    repository,
    agentId,
    stateFamily: "self_concept",
    subjectRole,
    subjectKey,
    canonicalKey,
    subjectLabel,
    stateLabel: selfConceptLabel,
    ...snapshotOptions,
    currentRepresentationLayer: "reported",
  });
  if (baseResult.status === "skipped") return { ...baseResult, representationLayer: "reported", ...flags() };
  const snapshot = baseResult.snapshot;
  const candidates = snapshot.observations
    .map((observation) => candidateFromObservation(observation, Boolean(snapshot.currentState)))
    .filter(Boolean);
  if (!candidates.length) {
    return {
      status: "skipped",
      reason: "no-qualified-direct-current-self-concept",
      snapshot,
      representationLayer: "reported",
      ...flags(),
    };
  }
  const selection = selectLatestReportedCandidate(candidates, {
    hasCurrentState: Boolean(snapshot.currentState),
    isExplicitChange: (candidate) => candidate.time.revisionCue === "changed",
  });
  if (selection.status === "review_required") {
    return reviewRequired(snapshot, selection.reason, selection);
  }
  const selected = selection.selected;
  const action = snapshot.currentState ? actionAgainstCurrent(selected) : "create";
  if (action === "review_required") {
    return reviewRequired(snapshot, "latest-self-concept-does-not-prove-a-safe-transition", selection);
  }
  const state = action === "correct_attribution" ? null : proposedState(selected, snapshot);
  return {
    status: "ready",
    reason: "",
    representationLayer: "reported",
    action,
    currentStateId: snapshot.currentState?.id || "",
    proposedState: state,
    selectedObservationId: selected.observation.id,
    consideredObservationIds: selection.ordered.map((candidate) => candidate.observation.id),
    snapshot,
    truthBoundary: {
      holderExpressionIsRecorded: true,
      objectiveIdentityStatus: "not-evaluated",
      objectivePersonalityStatus: "unverified",
      crossContextDispositionStatus: "not-evaluated",
    },
    ...flags(),
  };
}
