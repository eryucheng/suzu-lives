import {
  PREFERENCE_EVIDENCE_ENUMS,
  PREFERENCE_EVIDENCE_SIGNALS,
} from "./preference-contract.mjs";

const SCORED_SIGNALS = Object.freeze([
  "active_choice",
  "repeated_behavior",
  "active_sharing",
  "counter_behavior",
]);

const BEHAVIOR_SIGNALS = new Set([
  "active_choice",
  "repeated_behavior",
  "active_sharing",
  "voluntary_acceptance",
  "counter_behavior",
  "single_occurrence",
  "passive_exposure",
]);

const CHOICE_SIGNALS = new Set(["active_choice", "repeated_behavior"]);
const SUPPORT_SIGNALS = new Set(["active_choice", "repeated_behavior", "active_sharing"]);
const ACTIVE_AGENCY = new Set(["self_initiated", "voluntary_continuation"]);
const ACCEPTING_AGENCY = new Set(["accepted", "voluntary_continuation"]);
const ACTIVE_TOPIC_INITIATION = new Set(["self_initiated", "unprompted_return"]);

function clean(value) {
  return String(value ?? "").trim();
}

function finite(value, name) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) throw new Error(`${name} must be a finite number.`);
  return normalized;
}

function nonNegative(value, name) {
  const normalized = finite(value, name);
  if (normalized < 0) throw new Error(`${name} must be non-negative.`);
  return normalized;
}

function ratio(value, name) {
  const normalized = finite(value, name);
  if (normalized < 0 || normalized > 1) throw new Error(`${name} must be between 0 and 1.`);
  return normalized;
}

function integer(value, name, minimum = 0) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}.`);
  }
  return normalized;
}

function enumValue(value, name, allowed) {
  const normalized = clean(value) || "unknown";
  if (!allowed.includes(normalized)) {
    throw new Error(`${name} has an unknown value: ${normalized}.`);
  }
  return normalized;
}

function normalizePolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("preference formation policy is required; the simulator has no defaults.");
  }
  const version = clean(policy.version);
  if (!version) throw new Error("preference formation policy version is required.");
  if (!policy.signalWeights || typeof policy.signalWeights !== "object"
    || Array.isArray(policy.signalWeights)) {
    throw new Error("preference formation policy requires signalWeights.");
  }
  if (!policy.opportunityCostMultipliers
    || typeof policy.opportunityCostMultipliers !== "object"
    || Array.isArray(policy.opportunityCostMultipliers)) {
    throw new Error("preference formation policy requires opportunityCostMultipliers.");
  }
  const signalWeights = Object.fromEntries(SCORED_SIGNALS.map((signal) => [
    signal,
    nonNegative(policy.signalWeights[signal], `policy.signalWeights.${signal}`),
  ]));
  const opportunityCostMultipliers = Object.fromEntries(
    PREFERENCE_EVIDENCE_ENUMS.opportunityCost.map((level) => [
      level,
      nonNegative(
        policy.opportunityCostMultipliers[level],
        `policy.opportunityCostMultipliers.${level}`,
      ),
    ]),
  );
  return {
    version,
    signalWeights,
    opportunityCostMultipliers,
    minimumConfidence: ratio(policy.minimumConfidence, "policy.minimumConfidence"),
    minimumStableSupportScore: nonNegative(
      policy.minimumStableSupportScore,
      "policy.minimumStableSupportScore",
    ),
    minimumStableIndependentSupport: integer(
      policy.minimumStableIndependentSupport,
      "policy.minimumStableIndependentSupport",
      2,
    ),
    minimumStableDistinctDays: integer(
      policy.minimumStableDistinctDays,
      "policy.minimumStableDistinctDays",
      2,
    ),
    minimumStableDistinctContexts: integer(
      policy.minimumStableDistinctContexts,
      "policy.minimumStableDistinctContexts",
      2,
    ),
    minimumChoiceEvidenceForStable: integer(
      policy.minimumChoiceEvidenceForStable,
      "policy.minimumChoiceEvidenceForStable",
      1,
    ),
    minimumSelectionEvidence: integer(
      policy.minimumSelectionEvidence,
      "policy.minimumSelectionEvidence",
      1,
    ),
    minimumSelectionContexts: integer(
      policy.minimumSelectionContexts,
      "policy.minimumSelectionContexts",
      1,
    ),
    minimumToleranceEvidence: integer(
      policy.minimumToleranceEvidence,
      "policy.minimumToleranceEvidence",
      1,
    ),
    minimumToleranceContexts: integer(
      policy.minimumToleranceContexts,
      "policy.minimumToleranceContexts",
      1,
    ),
    maximumContributionPerDay: nonNegative(
      policy.maximumContributionPerDay,
      "policy.maximumContributionPerDay",
    ),
    maximumOppositionRatio: ratio(
      policy.maximumOppositionRatio,
      "policy.maximumOppositionRatio",
    ),
  };
}

function dayOf(value) {
  const text = clean(value);
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) return text;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : "";
}

function behaviorGate(item) {
  if (item.signal === "single_occurrence") return "non-qualifying-single-occurrence";
  if (item.signal === "passive_exposure") return "non-qualifying-passive-exposure";
  if (item.signal === "agent_guess") return "non-qualifying-agent-guess";
  if (item.signal === "voluntary_acceptance") {
    if (!ACCEPTING_AGENCY.has(item.agency)) return "acceptance-was-not-voluntary";
    if (item.constraint !== "none") return `blocked-by-${item.constraint}-constraint`;
    if (item.instrumentalGoal !== "none") return "blocked-by-instrumental-goal";
    if (!item.canDecline) return "acceptance-could-not-be-declined";
    return "";
  }
  if (item.signal === "active_sharing") {
    if (!ACTIVE_AGENCY.has(item.agency)) return "sharing-was-not-self-directed";
    if (!ACTIVE_TOPIC_INITIATION.has(item.topicInitiation)) return "sharing-was-prompted-or-required";
    if (item.constraint !== "none") return `blocked-by-${item.constraint}-constraint`;
    if (item.instrumentalGoal !== "none") return "blocked-by-instrumental-goal";
    if (item.affectiveExpression !== "positive") return "sharing-lacks-positive-affective-evidence";
    return "";
  }
  if (CHOICE_SIGNALS.has(item.signal)) {
    if (!ACTIVE_AGENCY.has(item.agency)) return "behavior-was-not-self-directed";
    if (item.constraint !== "none") return `blocked-by-${item.constraint}-constraint`;
    if (item.instrumentalGoal !== "none") return "blocked-by-instrumental-goal";
    if (item.alternatives !== "available") return "no-verified-alternative-choice";
    return "";
  }
  if (item.signal === "counter_behavior") {
    if (!ACTIVE_AGENCY.has(item.agency)) return "counter-behavior-was-not-self-directed";
    if (item.constraint !== "none") return `counter-behavior-blocked-by-${item.constraint}-constraint`;
    if (item.instrumentalGoal !== "none") return "counter-behavior-blocked-by-instrumental-goal";
    return "";
  }
  return "";
}

function normalizeEvidence(evidence, subjectRole, subjectKey, minimumConfidence) {
  if (!Array.isArray(evidence)) throw new Error("preference evidence must be an array.");
  const seen = new Set();
  return evidence.map((item, index) => {
    const memoryId = clean(item?.memoryId);
    const signal = clean(item?.signal);
    const evidenceSubjectRole = clean(item?.subjectRole);
    const evidenceSubjectKey = clean(item?.subjectKey);
    const evidenceGroupId = clean(item?.evidenceGroupId);
    if (!memoryId || !evidenceGroupId) {
      throw new Error(`preference evidence ${index} requires memoryId and evidenceGroupId.`);
    }
    if (seen.has(memoryId)) throw new Error(`preference evidence repeats memoryId: ${memoryId}`);
    seen.add(memoryId);
    if (!PREFERENCE_EVIDENCE_SIGNALS.includes(signal)) {
      throw new Error(`preference evidence ${index} has an unknown signal: ${signal || "(empty)"}.`);
    }
    if (evidenceSubjectRole !== subjectRole || evidenceSubjectKey !== subjectKey) {
      throw new Error(`preference evidence ${memoryId} belongs to a different subject.`);
    }
    const confidence = ratio(item?.confidence, `evidence[${index}].confidence`);
    const contextId = clean(item?.contextId);
    if (BEHAVIOR_SIGNALS.has(signal) && !contextId) {
      throw new Error(`behavioral preference evidence ${memoryId} requires contextId.`);
    }
    const normalized = {
      memoryId,
      signal,
      subjectRole: evidenceSubjectRole,
      subjectKey: evidenceSubjectKey,
      evidenceGroupId,
      contextId,
      day: dayOf(item?.eventTime ?? item?.knownAt),
      confidence,
      agency: enumValue(item?.agency, `evidence[${index}].agency`, PREFERENCE_EVIDENCE_ENUMS.agency),
      constraint: enumValue(item?.constraint, `evidence[${index}].constraint`, PREFERENCE_EVIDENCE_ENUMS.constraint),
      alternatives: enumValue(
        item?.alternatives,
        `evidence[${index}].alternatives`,
        PREFERENCE_EVIDENCE_ENUMS.alternatives,
      ),
      instrumentalGoal: enumValue(
        item?.instrumentalGoal,
        `evidence[${index}].instrumentalGoal`,
        PREFERENCE_EVIDENCE_ENUMS.instrumentalGoal,
      ),
      opportunityCost: enumValue(
        item?.opportunityCost,
        `evidence[${index}].opportunityCost`,
        PREFERENCE_EVIDENCE_ENUMS.opportunityCost,
      ),
      topicInitiation: enumValue(
        item?.topicInitiation,
        `evidence[${index}].topicInitiation`,
        PREFERENCE_EVIDENCE_ENUMS.topicInitiation,
      ),
      affectiveExpression: enumValue(
        item?.affectiveExpression,
        `evidence[${index}].affectiveExpression`,
        PREFERENCE_EVIDENCE_ENUMS.affectiveExpression,
      ),
      canDecline: item?.canDecline === true,
      ignoredReason: "",
    };
    normalized.ignoredReason = confidence < minimumConfidence
      ? "below-minimum-confidence"
      : behaviorGate(normalized);
    return normalized;
  });
}

function scoreEvidence(items, policy) {
  const strongestByGroup = new Map();
  for (const item of items) {
    if (item.ignoredReason) continue;
    const multiplier = policy.opportunityCostMultipliers[item.opportunityCost] ?? 0;
    const contribution = policy.signalWeights[item.signal] * item.confidence * multiplier;
    const existing = strongestByGroup.get(item.evidenceGroupId);
    if (!existing || contribution > existing.contribution) {
      strongestByGroup.set(item.evidenceGroupId, { ...item, contribution });
    }
  }
  const byDay = new Map();
  for (const item of strongestByGroup.values()) {
    const day = item.day || "unknown-day";
    const group = byDay.get(day) || [];
    group.push(item);
    byDay.set(day, group);
  }
  let score = 0;
  for (const group of byDay.values()) {
    score += Math.min(
      policy.maximumContributionPerDay,
      group.reduce((sum, item) => sum + item.contribution, 0),
    );
  }
  return {
    score,
    contributions: [...strongestByGroup.values()].sort((left, right) => (
      left.day.localeCompare(right.day)
      || left.contextId.localeCompare(right.contextId)
      || left.evidenceGroupId.localeCompare(right.evidenceGroupId)
      || left.memoryId.localeCompare(right.memoryId)
    )),
  };
}

function strongestToleranceEvidence(items) {
  const strongestByGroup = new Map();
  for (const item of items) {
    if (item.ignoredReason) continue;
    const existing = strongestByGroup.get(item.evidenceGroupId);
    if (!existing || item.confidence > existing.confidence) {
      strongestByGroup.set(item.evidenceGroupId, item);
    }
  }
  return [...strongestByGroup.values()];
}

function setSize(items, field) {
  return new Set(items.map((item) => item[field]).filter(Boolean)).size;
}

export function simulatePreferenceFormation({
  subjectRole,
  subjectKey,
  canonicalKey,
  evidence,
  policy,
} = {}) {
  const normalizedSubjectRole = clean(subjectRole);
  const normalizedSubjectKey = clean(subjectKey);
  const normalizedCanonicalKey = clean(canonicalKey).toLocaleLowerCase("en-US");
  if (!["user", "agent", "shared", "other"].includes(normalizedSubjectRole)
    || !normalizedSubjectKey || !normalizedCanonicalKey) {
    throw new Error("preference preview requires an identified holder and canonicalKey.");
  }
  const normalizedPolicy = normalizePolicy(policy);
  const normalizedEvidence = normalizeEvidence(
    evidence,
    normalizedSubjectRole,
    normalizedSubjectKey,
    normalizedPolicy.minimumConfidence,
  );
  const explicitSupport = normalizedEvidence.some((item) => (
    item.signal === "explicit_preference" && !item.ignoredReason
  ));
  const explicitOpposition = normalizedEvidence.some((item) => (
    item.signal === "explicit_rejection" && !item.ignoredReason
  ));
  const support = scoreEvidence(
    normalizedEvidence.filter((item) => SUPPORT_SIGNALS.has(item.signal)),
    normalizedPolicy,
  );
  const opposition = scoreEvidence(
    normalizedEvidence.filter((item) => item.signal === "counter_behavior"),
    normalizedPolicy,
  );
  const tolerance = strongestToleranceEvidence(
    normalizedEvidence.filter((item) => item.signal === "voluntary_acceptance"),
  );
  const independentSupport = setSize(support.contributions, "evidenceGroupId");
  const distinctSupportDays = setSize(support.contributions, "day");
  const distinctSupportContexts = setSize(support.contributions, "contextId");
  const choiceEvidenceCount = support.contributions.filter((item) => (
    CHOICE_SIGNALS.has(item.signal)
  )).length;
  const selectionEvidenceCount = support.contributions.length;
  const selectionContextCount = distinctSupportContexts;
  const toleranceEvidenceCount = setSize(tolerance, "evidenceGroupId");
  const toleranceContextCount = setSize(tolerance, "contextId");
  const oppositionRatio = support.score > 0
    ? opposition.score / support.score
    : opposition.score > 0 ? 1 : 0;
  const stableFailures = [];
  if (support.score < normalizedPolicy.minimumStableSupportScore) {
    stableFailures.push("support-score-below-stable-policy");
  }
  if (independentSupport < normalizedPolicy.minimumStableIndependentSupport) {
    stableFailures.push("insufficient-independent-support");
  }
  if (distinctSupportDays < normalizedPolicy.minimumStableDistinctDays) {
    stableFailures.push("insufficient-distinct-support-days");
  }
  if (distinctSupportContexts < normalizedPolicy.minimumStableDistinctContexts) {
    stableFailures.push("insufficient-distinct-support-contexts");
  }
  if (choiceEvidenceCount < normalizedPolicy.minimumChoiceEvidenceForStable) {
    stableFailures.push("insufficient-active-choice-evidence");
  }

  let status = "behavior-only";
  let claimLevel = "behavior_pattern";
  let reasons = ["no-qualified-preference-inference"];
  let proposedKind = "";
  if (explicitSupport && explicitOpposition) {
    status = "state-change-review-required";
    claimLevel = "preference_state_change";
    reasons = ["explicit-support-and-rejection-require-temporal-resolution"];
    proposedKind = "preference";
  } else if (explicitOpposition) {
    status = "direct-rejection";
    claimLevel = "explicit_preference_state";
    reasons = ["explicit-rejection-statement"];
    proposedKind = "preference";
  } else if (explicitSupport) {
    status = "direct-preference";
    claimLevel = "explicit_preference_state";
    reasons = ["explicit-preference-statement"];
    proposedKind = "preference";
  } else if (opposition.score > 0 && support.score === 0) {
    status = "behavioral-opposition";
    claimLevel = "behavioral_avoidance";
    reasons = ["qualified-counter-behavior-without-support"];
    proposedKind = "derived_hypothesis";
  } else if (oppositionRatio > normalizedPolicy.maximumOppositionRatio) {
    status = "conflicting-evidence";
    claimLevel = "unresolved_preference_evidence";
    reasons = ["opposition-ratio-exceeds-policy"];
  } else if (!stableFailures.length) {
    status = "stable-preference-review";
    claimLevel = "inferred_stable_preference";
    reasons = ["cross-context-voluntary-choice-evidence"];
    proposedKind = "derived_hypothesis";
  } else if (
    selectionEvidenceCount >= normalizedPolicy.minimumSelectionEvidence
    && selectionContextCount >= normalizedPolicy.minimumSelectionContexts
  ) {
    status = "selection-tendency";
    claimLevel = "contextual_selection_tendency";
    reasons = ["qualified-voluntary-interest-evidence", ...stableFailures];
    proposedKind = "derived_hypothesis";
  } else if (
    toleranceEvidenceCount >= normalizedPolicy.minimumToleranceEvidence
    && toleranceContextCount >= normalizedPolicy.minimumToleranceContexts
  ) {
    status = "situational-tolerance";
    claimLevel = "situational_tolerance";
    reasons = ["voluntary-acceptance-with-decline-option"];
    proposedKind = "derived_hypothesis";
  } else {
    reasons = [...new Set([
      ...reasons,
      ...stableFailures,
      ...normalizedEvidence.map((item) => item.ignoredReason).filter(Boolean),
    ])];
  }
  return {
    subjectRole: normalizedSubjectRole,
    subjectKey: normalizedSubjectKey,
    canonicalKey: normalizedCanonicalKey,
    policyVersion: normalizedPolicy.version,
    status,
    claimLevel,
    reasons,
    evidence: normalizedEvidence,
    supportScore: support.score,
    oppositionScore: opposition.score,
    oppositionRatio,
    independentSupport,
    distinctSupportDays,
    distinctSupportContexts,
    choiceEvidenceCount,
    selectionEvidenceCount,
    toleranceEvidenceCount,
    supportContributions: support.contributions,
    oppositionContributions: opposition.contributions,
    toleranceContributions: tolerance,
    ignoredEvidence: normalizedEvidence.filter((item) => item.ignoredReason),
    proposedKind,
    automaticMemoryWriteAllowed: false,
    automaticPreferencePromotionAllowed: false,
  };
}
