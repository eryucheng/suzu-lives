import { buildCanonicalStateEvidenceSnapshot } from "./canonical-state-snapshot.mjs";
import {
  normalizeReportedClaim,
  selectLatestReportedCandidate,
} from "./reported-state-review-core.mjs";

const SUBJECT_ROLES = new Set(["user", "agent", "other"]);
const GOAL_INTENTIONS = new Set(["intention", "plan", "commitment", "open_loop"]);
const OPEN_LIFECYCLES = new Set(["active", "in_progress", "blocked", "paused", "future"]);
const CLOSED_LIFECYCLES = new Set(["completed", "cancelled", "abandoned"]);

function clean(value) {
  return String(value ?? "").trim();
}

function candidateFromObservation(observation, currentStatePresent) {
  const target = observation.analysis?.target;
  const holder = observation.analysis?.holder;
  const lifecycle = observation.analysis?.lifecycle;
  const relation = observation.analysis?.relation;
  const comparisonLayer = clean(observation.scope?.currentRepresentationLayer);
  if (observation.qualification !== "qualified"
    || observation.memory?.evidenceMode !== "explicit"
    || comparisonLayer !== "reported"
    || !["exact", "subcategory"].includes(target?.targetMatch)
    || !clean(target?.goalText)
    || !GOAL_INTENTIONS.has(target?.intentionLevel)
    || holder?.holderMatch !== "yes"
    || holder?.attribution !== "explicit_self_statement"
    || holder?.responsibility !== "subject"
    || holder?.acceptsResponsibility !== "yes"
    || !["self_chosen", "external_requirement"].includes(holder?.agency)
    || (!OPEN_LIFECYCLES.has(lifecycle?.lifecycle)
      && !CLOSED_LIFECYCLES.has(lifecycle?.lifecycle))
    || (lifecycle?.lifecycle === "completed"
      && lifecycle?.completionBasis !== "explicit_self_report")
    || (["cancelled", "abandoned"].includes(lifecycle?.lifecycle)
      && !["explicit_self_report", "direct_cancellation"].includes(lifecycle?.completionBasis))
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
    target,
    holder,
    lifecycle,
    relation,
    claimKey: normalizeReportedClaim([
      target.goalText,
      target.intentionLevel,
      holder.responsibility,
      holder.agency,
    ].join("\u001f")),
    observedAt: observation.observedAt,
  };
}

function proposedKind(intentionLevel) {
  if (intentionLevel === "commitment") return "commitment";
  if (intentionLevel === "open_loop") return "open_loop";
  return "plan";
}

function temporalStateForLifecycle(lifecycle) {
  if (lifecycle === "future") return "planned";
  if (lifecycle === "in_progress") return "in_progress";
  if (lifecycle === "completed") return "completed";
  if (["cancelled", "abandoned"].includes(lifecycle)) return "cancelled";
  if (lifecycle === "historical") return "historical";
  if (["active", "blocked", "paused"].includes(lifecycle)) return "current";
  return "unknown";
}

function statePhaseForLifecycle(lifecycle) {
  if (lifecycle === "blocked") return "interrupted";
  if (lifecycle === "paused") return "paused";
  if (lifecycle === "completed") return "completed";
  if (["cancelled", "abandoned"].includes(lifecycle)) return "cancelled";
  if (lifecycle === "historical") return "ended";
  if (["active", "future", "in_progress"].includes(lifecycle)) return "active";
  return "unspecified";
}

function actionAgainstCurrent(candidate) {
  const relation = candidate.relation.relation;
  if (relation === "same_goal") return "reinforce";
  if (["progress_update", "narrower_step"].includes(relation)) return "progress_update";
  if (relation === "pauses") return "pause";
  if (relation === "resumes") return "resume";
  if (relation === "completes"
    && candidate.lifecycle.lifecycle === "completed"
    && candidate.lifecycle.completionBasis === "explicit_self_report") {
    return "complete";
  }
  if (relation === "cancels"
    && ["cancelled", "abandoned"].includes(candidate.lifecycle.lifecycle)
    && ["explicit_self_report", "direct_cancellation"].includes(
      candidate.lifecycle.completionBasis,
    )) {
    return "cancel";
  }
  if (relation === "replaces") return "supersede";
  return "review_required";
}

function proposedState(candidate, snapshot) {
  return {
    kind: proposedKind(candidate.target.intentionLevel),
    stateFamily: "goal",
    representationLayer: "reported",
    subjectRole: snapshot.target.subjectRole,
    subjectKey: snapshot.target.subjectKey,
    canonicalKey: snapshot.target.canonicalKey,
    evidenceMode: "explicit",
    temporalState: temporalStateForLifecycle(candidate.lifecycle.lifecycle),
    statePhase: statePhaseForLifecycle(candidate.lifecycle.lifecycle),
    validFrom: candidate.observedAt,
    goalClaim: {
      text: clean(candidate.target.goalText),
      intentionLevel: candidate.target.intentionLevel,
      specificity: candidate.target.specificity,
      responsibility: candidate.holder.responsibility,
      agency: candidate.holder.agency,
      lifecycle: candidate.lifecycle.lifecycle,
      timeReference: clean(candidate.lifecycle.timeReference),
      holderStatementStatus: "directly-reported",
      executionStatus: "unverified",
      completionStatus: "not-established",
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
    automaticExecutionFactWriteAllowed: false,
    automaticCompletionFactWriteAllowed: false,
    automaticCapabilityWriteAllowed: false,
    automaticSharedCommitmentWriteAllowed: false,
    automaticReminderOrTaskCreationAllowed: false,
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

export function reviewReportedGoalState({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  subjectLabel,
  goalLabel,
  snapshotOptions = {},
} = {}) {
  if (!SUBJECT_ROLES.has(clean(subjectRole))) {
    throw new Error("Reported goal review requires one fixed personal subject.");
  }
  const baseResult = buildCanonicalStateEvidenceSnapshot({
    repository,
    agentId,
    stateFamily: "goal",
    subjectRole,
    subjectKey,
    canonicalKey,
    subjectLabel,
    stateLabel: goalLabel,
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
      reason: "no-qualified-layer-aligned-direct-goal-statement",
      snapshot,
      representationLayer: "reported",
      ...flags(),
    };
  }
  const selection = selectLatestReportedCandidate(candidates, {
    hasCurrentState: Boolean(snapshot.currentState),
    isExplicitChange: (candidate) => candidate.relation.relation === "replaces",
  });
  if (selection.status === "review_required") {
    return reviewRequired(snapshot, selection.reason, selection);
  }
  const selected = selection.selected;
  if (!snapshot.currentState) {
    if (selected.target.targetMatch !== "exact" || !OPEN_LIFECYCLES.has(selected.lifecycle.lifecycle)) {
      return reviewRequired(
        snapshot,
        "closed-or-partial-goal-cannot-create-a-reported-current-state",
        selection,
      );
    }
  }
  const action = snapshot.currentState ? actionAgainstCurrent(selected) : "create";
  if (action === "review_required") {
    return reviewRequired(
      snapshot,
      "latest-goal-statement-does-not-prove-a-safe-transition",
      selection,
    );
  }
  const stateActions = new Set(["create", "reinforce", "pause", "resume", "supersede"]);
  return {
    status: "ready",
    reason: "",
    representationLayer: "reported",
    action,
    currentStateId: snapshot.currentState?.id || "",
    proposedState: stateActions.has(action) ? proposedState(selected, snapshot) : null,
    selectedObservationId: selected.observation.id,
    consideredObservationIds: selection.ordered.map((candidate) => candidate.observation.id),
    snapshot,
    truthBoundary: {
      holderGoalStatementIsRecorded: true,
      executionStatus: "unverified",
      completionFactStatus: action === "complete" ? "self-reported-only" : "not-established",
      capabilityToComplete: "not-evaluated",
      establishedExecutionStateIsUnaffected: true,
      sharedCommitmentStatus: "unconfirmed",
    },
    ...flags(),
  };
}
