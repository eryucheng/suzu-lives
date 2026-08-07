import { buildCanonicalStateEvidenceSnapshot } from "./canonical-state-snapshot.mjs";
import {
  normalizeReportedClaim,
  selectLatestReportedCandidate,
} from "./reported-state-review-core.mjs";

const SUBJECT_ROLES = new Set(["user", "agent", "other"]);
const POSITIVE_PROFICIENCY = new Set(["novice", "basic", "competent", "advanced", "expert"]);
const EXPLICIT_CHANGES = new Set(["improved", "declined", "lost"]);

function clean(value) {
  return String(value ?? "").trim();
}

function candidateFromObservation(observation, currentStatePresent) {
  const skill = observation.analysis?.skill;
  const holder = observation.analysis?.holder;
  const performance = observation.analysis?.performance;
  const conditions = observation.analysis?.conditions;
  const timeRelation = observation.analysis?.timeRelation;
  const retiresCurrent = timeRelation?.relation === "retires" && timeRelation?.changeCue === "lost";
  if (observation.qualification !== "qualified"
    || observation.memory?.evidenceMode !== "explicit"
    || observation.scope?.currentRepresentationLayer !== "reported"
    || !["exact", "subcategory"].includes(skill?.targetMatch)
    || !clean(skill?.skillLabel)
    || !clean(skill?.scopeLabel)
    || holder?.holderMatch !== "yes"
    || holder?.attribution !== "explicit_self_statement"
    || performance?.evidenceType !== "self_report"
    || (!POSITIVE_PROFICIENCY.has(performance?.proficiencyClaim) && !retiresCurrent)
    || timeRelation?.stateTime !== "current"
    || Boolean(timeRelation?.currentStatePresent) !== currentStatePresent) {
    return null;
  }
  if (!currentStatePresent && timeRelation.relation !== "no_current_state") return null;
  if (currentStatePresent
    && ["no_current_state", "unrelated", "unknown"].includes(timeRelation.relation)) {
    return null;
  }
  return {
    observation,
    skill,
    holder,
    performance,
    conditions,
    timeRelation,
    claimKey: normalizeReportedClaim([
      skill.skillLabel,
      skill.scopeLabel,
      performance.proficiencyClaim,
      conditions?.independence,
      conditions?.dependencyLabel,
    ].join("\u001f")),
    observedAt: observation.observedAt,
  };
}

function actionAgainstCurrent(candidate) {
  const relation = candidate.timeRelation.relation;
  const cue = candidate.timeRelation.changeCue;
  if (["equivalent", "supports"].includes(relation)) return "reinforce";
  if (relation === "narrows") return "narrow_scope";
  if (relation === "proficiency_up") return cue === "improved" ? "supersede" : "review_required";
  if (relation === "proficiency_down") return cue === "declined" ? "supersede" : "review_required";
  if (relation === "retires") return cue === "lost" ? "retire" : "review_required";
  return "review_required";
}

function proposedState(candidate, snapshot) {
  return {
    kind: "fact",
    stateFamily: "capability",
    representationLayer: "reported",
    subjectRole: snapshot.target.subjectRole,
    subjectKey: snapshot.target.subjectKey,
    canonicalKey: snapshot.target.canonicalKey,
    evidenceMode: "explicit",
    temporalState: "current",
    statePhase: "active",
    validFrom: candidate.observedAt,
    capabilityClaim: {
      skillLabel: clean(candidate.skill.skillLabel),
      scopeLabel: clean(candidate.skill.scopeLabel),
      taskDifficulty: candidate.skill.taskDifficulty,
      claimedProficiency: candidate.performance.proficiencyClaim,
      independence: candidate.conditions?.independence || "not_applicable",
      dependencyLabel: clean(candidate.conditions?.dependencyLabel),
      repeatability: candidate.conditions?.repeatability || "not_applicable",
      conditionLabel: clean(candidate.conditions?.conditionLabel),
      verificationStatus: "unverified",
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
    automaticVerifiedCapabilityWriteAllowed: false,
    automaticProficiencyPromotionAllowed: false,
    automaticPerformanceEvidenceWriteAllowed: false,
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

export function reviewReportedCapabilityState({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  subjectLabel,
  capabilityLabel,
  snapshotOptions = {},
} = {}) {
  if (!SUBJECT_ROLES.has(clean(subjectRole))) {
    throw new Error("Reported capability review requires one fixed personal subject.");
  }
  const baseResult = buildCanonicalStateEvidenceSnapshot({
    repository,
    agentId,
    stateFamily: "capability",
    subjectRole,
    subjectKey,
    canonicalKey,
    subjectLabel,
    stateLabel: capabilityLabel,
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
      reason: "no-qualified-direct-current-capability-claim",
      snapshot,
      representationLayer: "reported",
      ...flags(),
    };
  }
  const selection = selectLatestReportedCandidate(candidates, {
    hasCurrentState: Boolean(snapshot.currentState),
    isExplicitChange: (candidate) => EXPLICIT_CHANGES.has(candidate.timeRelation.changeCue),
  });
  if (selection.status === "review_required") {
    return reviewRequired(snapshot, selection.reason, selection);
  }
  const selected = selection.selected;
  if (!snapshot.currentState && selected.timeRelation.changeCue === "lost") {
    return reviewRequired(snapshot, "capability-loss-cannot-retire-a-missing-reported-state", selection);
  }
  const action = snapshot.currentState ? actionAgainstCurrent(selected) : "create";
  if (action === "review_required") {
    return reviewRequired(snapshot, "latest-capability-claim-does-not-prove-a-safe-transition", selection);
  }
  return {
    status: "ready",
    reason: "",
    representationLayer: "reported",
    action,
    currentStateId: snapshot.currentState?.id || "",
    proposedState: action === "retire" ? null : proposedState(selected, snapshot),
    selectedObservationId: selected.observation.id,
    consideredObservationIds: selection.ordered.map((candidate) => candidate.observation.id),
    snapshot,
    truthBoundary: {
      subjectClaimIsRecorded: true,
      proficiencyVerification: "unverified",
      demonstratedPerformanceStatus: "not-evaluated",
      establishedCapabilityStateIsUnaffected: true,
    },
    ...flags(),
  };
}
