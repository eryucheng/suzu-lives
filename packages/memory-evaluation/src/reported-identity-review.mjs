import { buildCanonicalStateEvidenceSnapshot } from "./canonical-state-snapshot.mjs";
import {
  normalizeReportedClaim,
  selectLatestReportedCandidate,
} from "./reported-state-review-core.mjs";

const SUBJECT_ROLES = new Set(["user", "agent", "other"]);
const CARDINALITIES = new Set(["single", "multi_item", "sequence"]);
const CHANGE_CUES = new Set(["started", "changed", "ended", "clarified", "denies_prior_state"]);

function clean(value) {
  return String(value ?? "").trim();
}

function normalized(value) {
  return normalizeReportedClaim(value);
}

function candidateFromObservation(observation) {
  const field = observation.analysis?.field;
  const subject = observation.analysis?.subject;
  const boundary = observation.analysis?.boundary;
  const time = observation.analysis?.time;
  const relation = observation.analysis?.relation;
  const cardinality = clean(observation.scope?.fieldCardinality);
  if (observation.qualification !== "qualified"
    || observation.memory?.evidenceMode !== "explicit"
    || observation.scope?.currentRepresentationLayer !== "reported"
    || !["exact", "subcategory"].includes(field?.targetMatch)
    || !clean(field?.identityField)
    || !clean(field?.valueText)
    || !["asserts", "denies"].includes(field?.statementPolarity)
    || subject?.subjectMatch !== "yes"
    || subject?.attribution !== "explicit_self_report"
    || boundary?.classification !== "identity_fact"
    || boundary?.sensitivity === "credential"
    || !["current", "timeless"].includes(time?.factTime)
    || !relation
    || !CARDINALITIES.has(cardinality)) {
    return null;
  }
  const scope = {
    valueScope: clean(field.valueScope),
  };
  return {
    observation,
    field,
    subject,
    boundary,
    time,
    relation,
    cardinality,
    scope,
    claimKey: normalized([
      field.identityField,
      field.statementPolarity,
      field.valueText,
      scope.valueScope,
    ].join("\u001f")),
    observedAt: observation.observedAt,
  };
}

function currentClaim(repository, snapshot) {
  if (!snapshot.currentState) return null;
  const memory = repository.getMemory(snapshot.currentState.id);
  const stored = memory?.metadata?.reportedIdentity || memory?.metadata?.identityClaim || null;
  if (!stored || !clean(stored.identityField) || !clean(stored.valueText)
    || !CARDINALITIES.has(clean(stored.fieldCardinality))) {
    return null;
  }
  return {
    identityField: clean(stored.identityField),
    valueText: clean(stored.valueText),
    fieldCardinality: clean(stored.fieldCardinality),
    scope: {
      valueScope: clean(stored.scope?.valueScope ?? stored.valueScope),
    },
  };
}

function sameClaim(candidate, current) {
  return candidate.field.identityField === current.identityField
    && normalized(candidate.field.valueText) === normalized(current.valueText)
    && normalized(candidate.scope.valueScope) === normalized(current.scope.valueScope)
    && candidate.cardinality === current.fieldCardinality;
}

function actionAgainstCurrent(candidate, current) {
  const relation = candidate.relation.relation;
  const cue = candidate.time.revisionCue;
  if (["equivalent", "supports"].includes(relation) && sameClaim(candidate, current)) {
    return "reinforce";
  }
  if (relation === "narrows" && cue === "clarified") return "narrow_scope";
  if (relation === "value_changed" && cue === "changed"
    && ["single", "sequence"].includes(candidate.cardinality)) return "supersede";
  if (relation === "retires" && cue === "ended") return "retire";
  if (relation === "same_scope_conflict" && cue === "denies_prior_state") {
    return "correct_attribution";
  }
  return "review_required";
}

function proposedState(candidate, snapshot) {
  return {
    kind: "fact",
    stateFamily: "identity",
    representationLayer: "reported",
    subjectRole: snapshot.target.subjectRole,
    subjectKey: snapshot.target.subjectKey,
    canonicalKey: snapshot.target.canonicalKey,
    evidenceMode: "explicit",
    temporalState: candidate.time.factTime === "timeless" ? "timeless" : "current",
    statePhase: "active",
    validFrom: candidate.observedAt,
    identityClaim: {
      identityField: candidate.field.identityField,
      identityLabel: clean(candidate.observation.scope?.identityLabel),
      valueText: candidate.field.valueText,
      fieldCardinality: candidate.cardinality,
      scope: candidate.scope,
      sensitivity: candidate.boundary.sensitivity,
      holderStatementStatus: "directly-reported",
      externalVerificationStatus: "unverified",
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
    automaticEstablishedIdentityWriteAllowed: false,
    automaticExternalAccountSyncAllowed: false,
    automaticCredentialWriteAllowed: false,
    automaticSelfConceptWriteAllowed: false,
    automaticRelationshipWriteAllowed: false,
    automaticConditionWriteAllowed: false,
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

export function reviewReportedIdentityState({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  subjectLabel,
  identityLabel,
  snapshotOptions = {},
} = {}) {
  if (!SUBJECT_ROLES.has(clean(subjectRole))) {
    throw new Error("Reported identity review requires one fixed personal subject.");
  }
  const baseResult = buildCanonicalStateEvidenceSnapshot({
    repository,
    agentId,
    stateFamily: "identity",
    subjectRole,
    subjectKey,
    canonicalKey,
    subjectLabel,
    stateLabel: identityLabel,
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
      reason: "no-qualified-direct-current-identity-report",
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
    return reviewRequired(snapshot, "current-reported-identity-lacks-structured-claim-metadata", selection);
  }
  if (!existing && (selected.field.statementPolarity === "denies"
    || ["ended", "denies_prior_state"].includes(selected.time.revisionCue))) {
    return reviewRequired(snapshot, "closed-or-corrective-identity-report-cannot-create-current-state", selection);
  }
  const action = existing ? actionAgainstCurrent(selected, existing) : "create";
  if (action === "review_required") {
    const reason = selected.relation.relation === "additional_value"
      ? "multi-value-identity-item-requires-a-value-scoped-canonical-key"
      : "latest-identity-report-does-not-prove-a-safe-transition";
    return reviewRequired(snapshot, reason, selection);
  }
  return {
    status: "ready",
    reason: "",
    representationLayer: "reported",
    action,
    currentStateId: snapshot.currentState?.id || "",
    proposedState: ["retire", "correct_attribution"].includes(action)
      ? null
      : proposedState(selected, snapshot),
    selectedObservationId: selected.observation.id,
    consideredObservationIds: selection.ordered.map((candidate) => candidate.observation.id),
    snapshot,
    truthBoundary: {
      holderIdentityReportIsRecorded: true,
      externalVerificationStatus: "unverified",
      establishedIdentityIsUnaffected: true,
      selfConceptStatus: "not-inferred",
      relationshipStatus: "not-inferred",
      conditionStatus: "not-inferred",
      credentialStorageStatus: "forbidden",
    },
    ...flags(),
  };
}
