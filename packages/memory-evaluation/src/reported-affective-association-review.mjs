import { buildCanonicalStateEvidenceSnapshot } from "./canonical-state-snapshot.mjs";
import {
  normalizeReportedClaim,
  selectLatestReportedCandidate,
} from "./reported-state-review-core.mjs";

const SUBJECT_ROLES = new Set(["user", "agent", "other"]);
const TARGET_MATCHES = new Set(["exact", "subcategory"]);
const ASSOCIATION_TYPES = new Set(["explicit_trigger_link", "repeated_pattern"]);
const CHANGE_CUES = new Set([
  "strengthened",
  "weakened",
  "extinguished",
  "emotion_changed",
  "clarified",
  "denies_prior_state",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function normalized(value) {
  return normalizeReportedClaim(value);
}

function candidateFromObservation(observation) {
  const trigger = observation.analysis?.trigger;
  const experiencer = observation.analysis?.experiencer;
  const basis = observation.analysis?.basis;
  const time = observation.analysis?.time;
  const relation = observation.analysis?.relation;
  if (observation.qualification !== "qualified"
    || observation.memory?.evidenceMode !== "explicit"
    || observation.scope?.currentRepresentationLayer !== "reported"
    || !TARGET_MATCHES.has(trigger?.targetMatch)
    || !clean(trigger?.triggerType)
    || trigger?.triggerType === "unknown"
    || !clean(trigger?.triggerLabel)
    || !clean(trigger?.emotionLabel)
    || !["positive", "negative", "mixed", "neutral"].includes(trigger?.valence)
    || !["low", "medium", "high"].includes(trigger?.intensity)
    || experiencer?.experiencerMatch !== "yes"
    || experiencer?.attribution !== "explicit_self_report"
    || !ASSOCIATION_TYPES.has(basis?.associationType)
    || basis?.causality !== "explicit"
    || time?.stateTime !== "current"
    || !relation
    || relation.currentStatePresent !== Boolean(observation.scope?.currentRelation !== "no_current_state")) {
    return null;
  }
  const triggerClaim = {
    role: clean(observation.scope?.triggerRole),
    key: clean(observation.scope?.triggerKey),
    type: clean(trigger.triggerType),
    label: clean(trigger.triggerLabel),
    targetMatch: trigger.targetMatch,
  };
  const emotion = {
    label: clean(trigger.emotionLabel),
    valence: trigger.valence,
    intensity: trigger.intensity,
  };
  if (!triggerClaim.role || !triggerClaim.key) return null;
  return {
    observation,
    trigger,
    experiencer,
    basis,
    time,
    relation,
    triggerClaim,
    emotion,
    claimKey: normalized([
      triggerClaim.role,
      triggerClaim.key,
      triggerClaim.type,
      triggerClaim.label,
      emotion.label,
      emotion.valence,
      emotion.intensity,
    ].join("\u001f")),
    observedAt: observation.observedAt,
  };
}

function currentClaim(repository, snapshot) {
  if (!snapshot.currentState) return null;
  const memory = repository.getMemory(snapshot.currentState.id);
  const stored = memory?.metadata?.reportedAffectiveAssociation
    || memory?.metadata?.affectiveClaim
    || null;
  const trigger = stored?.trigger;
  const emotion = stored?.emotion;
  if (!trigger || !emotion
    || !clean(trigger.role)
    || !clean(trigger.key)
    || !clean(trigger.type)
    || !clean(trigger.label)
    || !clean(emotion.label)
    || !["positive", "negative", "mixed", "neutral"].includes(clean(emotion.valence))
    || !["low", "medium", "high"].includes(clean(emotion.intensity))) {
    return null;
  }
  return {
    trigger: {
      role: clean(trigger.role),
      key: clean(trigger.key),
      type: clean(trigger.type),
      label: clean(trigger.label),
      targetMatch: clean(trigger.targetMatch),
    },
    emotion: {
      label: clean(emotion.label),
      valence: clean(emotion.valence),
      intensity: clean(emotion.intensity),
    },
  };
}

function sameClaim(candidate, current) {
  return normalized(candidate.triggerClaim.role) === normalized(current.trigger.role)
    && normalized(candidate.triggerClaim.key) === normalized(current.trigger.key)
    && normalized(candidate.triggerClaim.type) === normalized(current.trigger.type)
    && normalized(candidate.triggerClaim.label) === normalized(current.trigger.label)
    && normalized(candidate.emotion.label) === normalized(current.emotion.label)
    && candidate.emotion.valence === current.emotion.valence
    && candidate.emotion.intensity === current.emotion.intensity;
}

function actionAgainstCurrent(candidate, current) {
  const cue = candidate.time.changeCue;
  const relation = candidate.relation.relation;
  if (["equivalent", "supports"].includes(relation) && sameClaim(candidate, current)) return "reinforce";
  if (relation === "narrows" && cue === "clarified") return "narrow_scope";
  if (relation === "emotion_changed" && cue === "emotion_changed") return "supersede";
  if (relation === "intensity_up" && cue === "strengthened") return "supersede";
  if (relation === "intensity_down" && cue === "weakened") return "supersede";
  if (relation === "retires" && cue === "extinguished") return "retire";
  if (relation === "same_scope_conflict" && cue === "denies_prior_state") {
    return "correct_attribution";
  }
  return "review_required";
}

function proposedState(candidate, snapshot) {
  return {
    kind: "belief_state",
    stateFamily: "affective_association",
    representationLayer: "reported",
    subjectRole: snapshot.target.subjectRole,
    subjectKey: snapshot.target.subjectKey,
    canonicalKey: snapshot.target.canonicalKey,
    evidenceMode: "explicit",
    temporalState: "current",
    statePhase: "active",
    validFrom: candidate.observedAt,
    affectiveClaim: {
      trigger: candidate.triggerClaim,
      emotion: candidate.emotion,
      recurrence: candidate.basis.recurrence,
      holderStatementStatus: "directly-reported",
      crossTimeStability: "unverified",
      activationBiasStatus: "disabled",
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
    automaticEstablishedAssociationWriteAllowed: false,
    automaticActivationBiasWriteAllowed: false,
    automaticPreferenceWriteAllowed: false,
    automaticRelationshipWriteAllowed: false,
    activationBiasAllowed: false,
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

export function reviewReportedAffectiveAssociationState({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  subjectLabel,
  associationLabel,
  snapshotOptions = {},
} = {}) {
  if (!SUBJECT_ROLES.has(clean(subjectRole))) {
    throw new Error("Reported affective association review requires one fixed personal subject.");
  }
  const baseResult = buildCanonicalStateEvidenceSnapshot({
    repository,
    agentId,
    stateFamily: "affective_association",
    subjectRole,
    subjectKey,
    canonicalKey,
    subjectLabel,
    stateLabel: associationLabel,
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
      reason: "no-qualified-direct-current-affective-association-report",
      snapshot,
      representationLayer: "reported",
      ...flags(),
    };
  }
  const selection = selectLatestReportedCandidate(candidates, {
    hasCurrentState: Boolean(snapshot.currentState),
    isExplicitChange: (candidate) => CHANGE_CUES.has(candidate.time.changeCue),
  });
  if (selection.status === "review_required") {
    return reviewRequired(snapshot, selection.reason, selection);
  }
  const selected = selection.selected;
  const existing = currentClaim(repository, snapshot);
  if (snapshot.currentState && !existing) {
    return reviewRequired(
      snapshot,
      "current-reported-affective-association-lacks-structured-claim-metadata",
      selection,
    );
  }
  if (!existing && ["extinguished", "denies_prior_state"].includes(selected.time.changeCue)) {
    return reviewRequired(
      snapshot,
      "closed-or-corrective-affective-report-cannot-create-a-current-state",
      selection,
    );
  }
  const action = existing ? actionAgainstCurrent(selected, existing) : "create";
  if (action === "review_required") {
    return reviewRequired(
      snapshot,
      "latest-affective-report-does-not-prove-a-safe-transition",
      selection,
    );
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
      holderAffectiveAssociationReportIsRecorded: true,
      crossTimeStability: "unverified",
      activationBiasStatus: "disabled",
      establishedAssociationIsUnaffected: true,
      preferenceStatus: "not-inferred",
      relationshipStatus: "not-inferred",
    },
    ...flags(),
  };
}
