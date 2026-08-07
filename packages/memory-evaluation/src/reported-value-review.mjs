import { buildCanonicalStateEvidenceSnapshot } from "./canonical-state-snapshot.mjs";
import {
  normalizeReportedClaim,
  selectLatestReportedCandidate,
} from "./reported-state-review-core.mjs";

const SUBJECT_ROLES = new Set(["user", "agent", "other"]);
const VALUE_STANCES = new Set(["protects", "rejects", "deprioritizes"]);
const DECLARATION_BASES = new Set(["explicit_principle", "reasoned_priority"]);

function clean(value) {
  return String(value ?? "").trim();
}

function candidateFromObservation(observation, currentStatePresent) {
  const target = observation.analysis?.target;
  const holder = observation.analysis?.holder;
  const basis = observation.analysis?.basis;
  const time = observation.analysis?.time;
  const relation = observation.analysis?.relation;
  if (observation.qualification !== "qualified"
    || observation.memory?.evidenceMode !== "explicit"
    || observation.scope?.currentRepresentationLayer !== "reported"
    || !["exact", "subcategory"].includes(target?.targetMatch)
    || !VALUE_STANCES.has(target?.stance)
    || !clean(target?.valueLabel)
    || !clean(target?.scopeLabel)
    || holder?.holderMatch !== "yes"
    || holder?.attribution !== "explicit_self_statement"
    || !DECLARATION_BASES.has(basis?.evidenceType)
    || basis?.protectedValueMatch !== "yes"
    || time?.stateTime !== "current"
    || Boolean(relation?.currentStatePresent) !== currentStatePresent) {
    return null;
  }
  if (!currentStatePresent && relation.relation !== "no_current_state") return null;
  if (currentStatePresent
    && ["no_current_state", "unrelated", "unknown"].includes(relation.relation)) {
    return null;
  }
  return {
    observation,
    target,
    holder,
    basis,
    time,
    relation,
    claimKey: normalizeReportedClaim([
      target.valueLabel,
      target.stance,
      target.scopeLabel,
    ].join("\u001f")),
    observedAt: observation.observedAt,
  };
}

function actionAgainstCurrent(candidate) {
  const relation = candidate.relation.relation;
  const cue = candidate.time.revisionCue;
  if (["equivalent", "supports"].includes(relation)) return "reinforce";
  if (relation === "narrows") return cue === "clarified" ? "narrow_scope" : "review_required";
  if (relation === "replaces") return cue === "changed" ? "supersede" : "review_required";
  if (relation === "same_scope_conflict") return cue === "changed" ? "supersede" : "review_required";
  return "review_required";
}

function proposedState(candidate, snapshot) {
  return {
    kind: "belief_state",
    stateFamily: "value",
    representationLayer: "reported",
    subjectRole: snapshot.target.subjectRole,
    subjectKey: snapshot.target.subjectKey,
    canonicalKey: snapshot.target.canonicalKey,
    evidenceMode: "explicit",
    temporalState: "current",
    statePhase: "active",
    validFrom: candidate.observedAt,
    valueClaim: {
      valueLabel: clean(candidate.target.valueLabel),
      stance: candidate.target.stance,
      scopeLabel: clean(candidate.target.scopeLabel),
      declarationBasis: candidate.basis.evidenceType,
      aggregationStatus: "unverified-stability",
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
    automaticStableValueWriteAllowed: false,
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
    selectedObservationId: selection.selected?.observation.id || "",
    consideredObservationIds: selection.ordered.map((candidate) => candidate.observation.id),
    snapshot,
    ...flags(),
  };
}

export function reviewReportedValueState({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  subjectLabel,
  valueLabel,
  snapshotOptions = {},
} = {}) {
  if (!SUBJECT_ROLES.has(clean(subjectRole))) {
    throw new Error("Reported value review requires one fixed personal subject.");
  }
  const baseResult = buildCanonicalStateEvidenceSnapshot({
    repository,
    agentId,
    stateFamily: "value",
    subjectRole,
    subjectKey,
    canonicalKey,
    subjectLabel,
    stateLabel: valueLabel,
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
      reason: "no-qualified-direct-current-value-declaration",
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
    return reviewRequired(snapshot, "latest-value-declaration-does-not-prove-a-safe-transition", selection);
  }
  return {
    status: "ready",
    reason: "",
    representationLayer: "reported",
    action,
    currentStateId: snapshot.currentState?.id || "",
    proposedState: proposedState(selected, snapshot),
    selectedObservationId: selected.observation.id,
    consideredObservationIds: selection.ordered.map((candidate) => candidate.observation.id),
    snapshot,
    truthBoundary: {
      subjectDeclarationIsRecorded: true,
      crossContextStability: "unverified",
      actualTradeoffConsistency: "not-evaluated",
      establishedValueStateIsUnaffected: true,
    },
    ...flags(),
  };
}
