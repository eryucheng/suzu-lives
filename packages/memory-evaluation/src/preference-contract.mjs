export const PREFERENCE_EVIDENCE_SIGNALS = Object.freeze([
  "explicit_preference",
  "explicit_rejection",
  "active_choice",
  "repeated_behavior",
  "active_sharing",
  "voluntary_acceptance",
  "counter_behavior",
  "single_occurrence",
  "passive_exposure",
  "agent_guess",
]);

export const PREFERENCE_EVIDENCE_ENUMS = Object.freeze({
  agency: Object.freeze([
    "self_initiated", "voluntary_continuation", "accepted", "passive", "forced", "unknown",
  ]),
  constraint: Object.freeze([
    "none", "survival", "work", "institutional", "social_pressure",
    "resource_limited", "convenience", "unknown",
  ]),
  alternatives: Object.freeze(["available", "unavailable", "unknown"]),
  instrumentalGoal: Object.freeze([
    "none", "income", "task_completion", "avoid_penalty", "obligation", "other", "unknown",
  ]),
  opportunityCost: Object.freeze(["none", "low", "medium", "high", "unknown"]),
  topicInitiation: Object.freeze([
    "self_initiated", "unprompted_return", "prompted", "task_required", "unknown",
  ]),
  affectiveExpression: Object.freeze(["positive", "neutral", "negative", "unknown"]),
});
