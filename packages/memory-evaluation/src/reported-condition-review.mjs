import { buildCanonicalStateEvidenceSnapshot } from "./canonical-state-snapshot.mjs";
import {
  normalizeReportedClaim,
  selectLatestReportedCandidate,
} from "./reported-state-review-core.mjs";

const SUBJECT_ROLES = new Set(["user", "agent", "other"]);
const CURRENT_TIMES = new Set(["current", "temporary"]);
const CHANGE_CUES = new Set(["started", "ended", "changed", "denies_prior_state"]);
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
    || !["present", "absent"].includes(analysis?.conditionPresence)
    || analysis?.evidenceBasis !== "explicit_self_report"
    || !CURRENT_TIMES.has(analysis?.temporality)
    || !clean(analysis?.scopeLabel)) {
    return null;
  }
  const scope = {
    targetMatch: analysis.targetMatch,
    matchedLabel: clean(analysis.matchedLabel),
    scopeLabel: clean(analysis.scopeLabel),
  };
  return {
    observation,
    analysis,
    presence: analysis.conditionPresence,
    scope,
    claimKey: normalized([
      analysis.conditionPresence,
      analysis.conditionKind,
      analysis.effect,
      analysis.temporality,
      scope.targetMatch,
      scope.matchedLabel,
      scope.scopeLabel,
    ].join("\u001f")),
    observedAt: observation.observedAt,
  };
}

function currentClaim(repository, snapshot) {
  if (!snapshot.currentState) return null;
  const memory = repository.getMemory(snapshot.currentState.id);
  const stored = memory?.metadata?.reportedCondition || memory?.metadata?.conditionClaim || null;
  if (!stored || clean(stored.presence) !== "present") return null;
  const scope = stored.scope && typeof stored.scope === "object" ? stored.scope : stored;
  const targetMatch = clean(scope.targetMatch);
  const matchedLabel = clean(scope.matchedLabel);
  const scopeLabel = clean(scope.scopeLabel);
  if (!Object.hasOwn(TARGET_RANK, targetMatch) || !matchedLabel || !scopeLabel) return null;
  return {
    presence: "present",
    conditionKind: clean(stored.conditionKind),
    effect: clean(stored.effect),
    temporality: clean(stored.temporality),
    scope: { targetMatch, matchedLabel, scopeLabel },
  };
}

function sameScope(left, right) {
  return left.targetMatch === right.targetMatch
    && normalized(left.matchedLabel) === normalized(right.matchedLabel)
    && normalized(left.scopeLabel) === normalized(right.scopeLabel);
}

function isNarrowerScope(candidate, current) {
  const candidateRank = TARGET_RANK[candidate.targetMatch] ?? 99;
  const currentRank = TARGET_RANK[current.targetMatch] ?? 99;
  if (candidateRank > currentRank) return false;
  if (candidateRank < currentRank) return true;
  if (normalized(candidate.matchedLabel) !== normalized(current.matchedLabel)) return false;
  return normalized(candidate.scopeLabel) !== normalized(current.scopeLabel);
}

function actionAgainstCurrent(candidate, current) {
  const cue = candidate.analysis.revisionCue;
  const sameDefinition = candidate.presence === current.presence
    && clean(candidate.analysis.conditionKind) === current.conditionKind
    && clean(candidate.analysis.effect) === current.effect
    && sameScope(candidate.scope, current.scope);
  if (sameDefinition) return "reinforce";
  if (candidate.presence === "present" && cue === "clarified"
    && isNarrowerScope(candidate.scope, current.scope)) return "narrow_scope";
  if (candidate.presence === "absent" && cue === "ended"
    && sameScope(candidate.scope, current.scope)) return "end";
  if (candidate.presence === "absent" && cue === "denies_prior_state"
    && sameScope(candidate.scope, current.scope)) return "correct_attribution";
  if (candidate.presence === "present" && cue === "changed") return "supersede";
  return "review_required";
}

function proposedState(candidate, snapshot) {
  return {
    kind: "fact",
    stateFamily: "condition",
    representationLayer: "reported",
    subjectRole: snapshot.target.subjectRole,
    subjectKey: snapshot.target.subjectKey,
    canonicalKey: snapshot.target.canonicalKey,
    evidenceMode: "explicit",
    temporalState: "current",
    statePhase: "active",
    validFrom: candidate.observedAt,
    conditionClaim: {
      presence: candidate.presence,
      conditionKind: candidate.analysis.conditionKind,
      effect: candidate.analysis.effect,
      temporality: candidate.analysis.temporality,
      scope: candidate.scope,
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
    automaticEstablishedConditionWriteAllowed: false,
    automaticPreferenceWriteAllowed: false,
    automaticHabitWriteAllowed: false,
    automaticDispositionWriteAllowed: false,
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

export function reviewReportedConditionState({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  subjectLabel,
  conditionLabel,
  snapshotOptions = {},
} = {}) {
  if (!SUBJECT_ROLES.has(clean(subjectRole))) {
    throw new Error("Reported condition review requires one fixed personal subject.");
  }
  const baseResult = buildCanonicalStateEvidenceSnapshot({
    repository,
    agentId,
    stateFamily: "condition",
    subjectRole,
    subjectKey,
    canonicalKey,
    subjectLabel,
    stateLabel: conditionLabel,
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
      reason: "no-qualified-direct-current-condition-report",
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
    return reviewRequired(snapshot, "current-reported-condition-lacks-structured-claim-metadata", selection);
  }
  if (!existing && selected.presence !== "present") {
    return reviewRequired(snapshot, "absent-condition-cannot-create-a-current-state", selection);
  }
  const action = existing ? actionAgainstCurrent(selected, existing) : "create";
  if (action === "review_required") {
    return reviewRequired(snapshot, "latest-condition-report-does-not-prove-a-safe-transition", selection);
  }
  return {
    status: "ready",
    reason: "",
    representationLayer: "reported",
    action,
    currentStateId: snapshot.currentState?.id || "",
    proposedState: ["end", "correct_attribution"].includes(action)
      ? null
      : proposedState(selected, snapshot),
    selectedObservationId: selected.observation.id,
    consideredObservationIds: selection.ordered.map((candidate) => candidate.observation.id),
    snapshot,
    truthBoundary: {
      holderConditionReportIsRecorded: true,
      externalVerificationStatus: "unverified",
      preferenceStatus: "not-inferred",
      habitStatus: "not-inferred",
      dispositionStatus: "not-inferred",
      establishedConditionIsUnaffected: true,
    },
    ...flags(),
  };
}
