import assert from "node:assert/strict";
import test from "node:test";

import { simulatePreferenceFormation } from "../src/index.mjs";

const policy = Object.freeze({
  version: "preference-test-v2",
  signalWeights: Object.freeze({
    active_choice: 0.7,
    repeated_behavior: 0.6,
    active_sharing: 0.5,
    counter_behavior: 0.6,
  }),
  opportunityCostMultipliers: Object.freeze({
    none: 1,
    low: 1.05,
    medium: 1.2,
    high: 1.4,
    unknown: 0.8,
  }),
  minimumConfidence: 0.6,
  minimumStableSupportScore: 1.3,
  minimumStableIndependentSupport: 3,
  minimumStableDistinctDays: 2,
  minimumStableDistinctContexts: 2,
  minimumChoiceEvidenceForStable: 1,
  minimumSelectionEvidence: 2,
  minimumSelectionContexts: 2,
  minimumToleranceEvidence: 2,
  minimumToleranceContexts: 2,
  maximumContributionPerDay: 1,
  maximumOppositionRatio: 0.25,
});

function preview(evidence, overrides = {}) {
  return simulatePreferenceFormation({
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    evidence,
    policy,
    ...overrides,
  });
}

function item(memoryId, signal, eventTime, overrides = {}) {
  return {
    memoryId,
    signal,
    subjectRole: "user",
    subjectKey: "user",
    evidenceGroupId: `group-${memoryId}`,
    contextId: `context-${memoryId}`,
    eventTime,
    confidence: 0.9,
    agency: "self_initiated",
    constraint: "none",
    alternatives: "available",
    instrumentalGoal: "none",
    opportunityCost: "low",
    topicInitiation: "self_initiated",
    affectiveExpression: "positive",
    canDecline: true,
    ...overrides,
  };
}

test("requires a complete versioned policy and an identified holder", () => {
  assert.throws(() => simulatePreferenceFormation({
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:test",
    evidence: [],
  }), /has no defaults/u);
  assert.throws(() => preview([], { subjectKey: "" }), /identified holder/u);
  assert.throws(() => preview([], {
    policy: {
      ...policy,
      opportunityCostMultipliers: undefined,
    },
  }), /requires opportunityCostMultipliers/u);
  assert.throws(() => preview([], {
    policy: { ...policy, minimumStableIndependentSupport: 1 },
  }), /at least 2/u);
});

test("treats an explicit first-person preference as direct evidence but never auto-writes it", () => {
  const result = preview([
    item("explicit-puzzle", "explicit_preference", "2026-07-12T10:00:00.000Z"),
  ]);
  assert.equal(result.status, "direct-preference");
  assert.equal(result.claimLevel, "explicit_preference_state");
  assert.deepEqual(result.reasons, ["explicit-preference-statement"]);
  assert.equal(result.proposedKind, "preference");
  assert.equal(result.automaticMemoryWriteAllowed, false);
  assert.equal(result.automaticPreferencePromotionAllowed, false);
});

test("routes conflicting explicit preference states to temporal resolution", () => {
  const result = preview([
    item("liked-before", "explicit_preference", "2026-07-01T10:00:00.000Z"),
    item("reject-now", "explicit_rejection", "2026-07-20T10:00:00.000Z"),
  ]);
  assert.equal(result.status, "state-change-review-required");
  assert.equal(result.claimLevel, "preference_state_change");
  assert.equal(result.proposedKind, "preference");
  assert.equal(result.automaticMemoryWriteAllowed, false);
});

test("does not infer liking overtime from frequent constrained work", () => {
  const result = preview([
    item("overtime-1", "repeated_behavior", "2026-07-01T12:00:00.000Z", {
      constraint: "work",
      instrumentalGoal: "income",
      opportunityCost: "high",
    }),
    item("overtime-2", "repeated_behavior", "2026-07-08T12:00:00.000Z", {
      constraint: "work",
      instrumentalGoal: "avoid_penalty",
      opportunityCost: "high",
    }),
    item("overtime-3", "repeated_behavior", "2026-07-15T12:00:00.000Z", {
      constraint: "work",
      instrumentalGoal: "income",
      opportunityCost: "high",
    }),
  ]);
  assert.equal(result.status, "behavior-only");
  assert.equal(result.claimLevel, "behavior_pattern");
  assert.equal(result.supportScore, 0);
  assert.equal(result.ignoredEvidence.length, 3);
  assert.ok(result.ignoredEvidence.every((entry) => entry.ignoredReason === "blocked-by-work-constraint"));
});

test("separates workplace exposure from voluntary situational tolerance", () => {
  const passive = preview([
    item("watermelon-served-1", "passive_exposure", "2026-07-01T04:00:00.000Z", {
      agency: "passive",
      constraint: "institutional",
      alternatives: "unavailable",
      instrumentalGoal: "other",
      opportunityCost: "none",
      canDecline: false,
    }),
    item("watermelon-served-2", "passive_exposure", "2026-07-08T04:00:00.000Z", {
      agency: "passive",
      constraint: "institutional",
      alternatives: "unavailable",
      instrumentalGoal: "other",
      opportunityCost: "none",
      canDecline: false,
    }),
  ]);
  assert.equal(passive.status, "behavior-only");
  assert.equal(passive.toleranceEvidenceCount, 0);

  const voluntary = preview([
    item("watermelon-accepted-1", "voluntary_acceptance", "2026-07-15T04:00:00.000Z", {
      agency: "accepted",
      opportunityCost: "none",
      contextId: "work-break-room-a",
    }),
    item("watermelon-accepted-2", "voluntary_acceptance", "2026-07-22T04:00:00.000Z", {
      agency: "accepted",
      opportunityCost: "none",
      contextId: "work-break-room-b",
    }),
  ]);
  assert.equal(voluntary.status, "situational-tolerance");
  assert.equal(voluntary.claimLevel, "situational_tolerance");
  assert.equal(voluntary.supportScore, 0);
  assert.equal(voluntary.proposedKind, "derived_hypothesis");
});

test("recognizes repeated free-time choices with alternatives and opportunity cost as a reviewable stable preference", () => {
  const result = preview([
    item("puzzle-evening-1", "active_choice", "2026-07-01T12:00:00.000Z", {
      contextId: "free-evening-home",
      opportunityCost: "medium",
    }),
    item("puzzle-weekend", "repeated_behavior", "2026-07-08T03:00:00.000Z", {
      contextId: "free-weekend-home",
      opportunityCost: "high",
    }),
    item("puzzle-evening-2", "active_choice", "2026-07-15T12:00:00.000Z", {
      contextId: "free-evening-travel",
      opportunityCost: "medium",
    }),
  ]);
  assert.equal(result.status, "stable-preference-review");
  assert.equal(result.claimLevel, "inferred_stable_preference");
  assert.equal(result.proposedKind, "derived_hypothesis");
  assert.equal(result.independentSupport, 3);
  assert.equal(result.distinctSupportDays, 3);
  assert.equal(result.distinctSupportContexts, 3);
  assert.equal(result.choiceEvidenceCount, 3);
  assert.equal(result.automaticPreferencePromotionAllowed, false);
});

test("uses self-initiated positive sharing as interest evidence but not as stable preference by itself", () => {
  const result = preview([
    item("share-puzzle-1", "active_sharing", "2026-07-02T11:00:00.000Z", {
      contextId: "chat-friend-a",
      opportunityCost: "medium",
    }),
    item("share-puzzle-2", "active_sharing", "2026-07-09T11:00:00.000Z", {
      contextId: "chat-friend-b",
      topicInitiation: "unprompted_return",
      opportunityCost: "medium",
    }),
  ]);
  assert.equal(result.status, "selection-tendency");
  assert.equal(result.claimLevel, "contextual_selection_tendency");
  assert.equal(result.choiceEvidenceCount, 0);
  assert.ok(result.reasons.includes("insufficient-active-choice-evidence"));
});

test("does not count prompted, task-required, or affectively neutral sharing as interest", () => {
  const result = preview([
    item("prompted-share", "active_sharing", "2026-07-02T11:00:00.000Z", {
      topicInitiation: "prompted",
    }),
    item("work-explanation", "active_sharing", "2026-07-09T11:00:00.000Z", {
      topicInitiation: "task_required",
      constraint: "work",
      instrumentalGoal: "task_completion",
    }),
    item("neutral-share", "active_sharing", "2026-07-16T11:00:00.000Z", {
      affectiveExpression: "neutral",
    }),
  ]);
  assert.equal(result.status, "behavior-only");
  assert.equal(result.supportScore, 0);
  assert.deepEqual(result.ignoredEvidence.map((entry) => entry.ignoredReason), [
    "sharing-was-prompted-or-required",
    "sharing-was-prompted-or-required",
    "sharing-lacks-positive-affective-evidence",
  ]);
});

test("requires a real alternative instead of treating constrained repetition as a choice", () => {
  const result = preview([
    item("only-option-1", "active_choice", "2026-07-01T10:00:00.000Z", {
      alternatives: "unavailable",
    }),
    item("unknown-option-2", "repeated_behavior", "2026-07-08T10:00:00.000Z", {
      alternatives: "unknown",
    }),
  ]);
  assert.equal(result.status, "behavior-only");
  assert.equal(result.supportScore, 0);
  assert.ok(result.ignoredEvidence.every((entry) => entry.ignoredReason === "no-verified-alternative-choice"));
});

test("prevents one evidence group or one busy day from manufacturing stability", () => {
  const sameGroup = "same-conversation";
  const result = preview([
    item("choice-1", "active_choice", "2026-07-01T10:00:00.000Z", {
      evidenceGroupId: sameGroup,
      contextId: "chat-a",
    }),
    item("choice-2", "active_choice", "2026-07-01T10:05:00.000Z", {
      evidenceGroupId: sameGroup,
      contextId: "chat-a",
    }),
    item("choice-duplicate-next-day", "active_choice", "2026-07-02T10:05:00.000Z", {
      evidenceGroupId: sameGroup,
      contextId: "chat-a",
    }),
    item("choice-3", "active_choice", "2026-07-01T11:00:00.000Z", {
      contextId: "chat-b",
    }),
  ]);
  assert.notEqual(result.status, "stable-preference-review");
  assert.equal(result.distinctSupportDays, 1);
  assert.ok(result.supportScore <= policy.maximumContributionPerDay);
});

test("rejects evidence belonging to another subject", () => {
  assert.throws(() => preview([
    item("agent-choice", "active_choice", "2026-07-01T10:00:00.000Z", {
      subjectRole: "agent",
      subjectKey: "agent-test",
    }),
  ]), /different subject/u);
});
