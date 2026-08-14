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

function count(value) {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

function normalizePolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("plasticity policy is required; the simulator has no defaults.");
  }
  const version = String(policy.version || "").trim();
  if (!version) throw new Error("plasticity policy version is required.");
  const floor = finite(policy.floor, "policy.floor");
  const ceiling = finite(policy.ceiling, "policy.ceiling");
  if (floor < 0 || ceiling > 1 || floor >= ceiling) {
    throw new Error("plasticity policy requires 0 <= floor < ceiling <= 1.");
  }
  const halfLifeDays = nonNegative(policy.halfLifeDays, "policy.halfLifeDays");
  if (halfLifeDays === 0) throw new Error("policy.halfLifeDays must be greater than zero.");
  return {
    version,
    floor,
    ceiling,
    halfLifeDays,
    exposureGain: nonNegative(policy.exposureGain, "policy.exposureGain"),
    usedGain: nonNegative(policy.usedGain, "policy.usedGain"),
    helpfulGain: nonNegative(policy.helpfulGain, "policy.helpfulGain"),
    missedGain: nonNegative(policy.missedGain, "policy.missedGain"),
    irrelevantPenalty: nonNegative(policy.irrelevantPenalty, "policy.irrelevantPenalty"),
    maximumPositiveStep: nonNegative(
      policy.maximumPositiveStep,
      "policy.maximumPositiveStep",
    ),
    maximumNegativeStep: nonNegative(
      policy.maximumNegativeStep,
      "policy.maximumNegativeStep",
    ),
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function simulatePlasticityTransition({
  currentValue,
  preview,
  elapsedDays,
  observationWindowId,
  policy,
} = {}) {
  const windowId = String(observationWindowId || "").trim();
  if (!windowId) {
    throw new Error("observationWindowId is required to identify the incremental evidence window.");
  }
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) {
    throw new Error("plasticity preview is required.");
  }
  const normalizedPolicy = normalizePolicy(policy);
  const normalizedCurrent = clamp(
    finite(currentValue, "currentValue"),
    normalizedPolicy.floor,
    normalizedPolicy.ceiling,
  );
  const normalizedElapsedDays = nonNegative(elapsedDays, "elapsedDays");
  const blocked = preview.evidenceTier === "blocked"
    || preview.learningTarget === "manual-review";
  if (blocked) {
    return {
      targetType: String(preview.targetType || "").trim(),
      targetId: String(preview.targetId || "").trim(),
      learningTarget: preview.learningTarget || "manual-review",
      observationWindowId: windowId,
      policyVersion: normalizedPolicy.version,
      currentValue: normalizedCurrent,
      decayedValue: normalizedCurrent,
      positiveStep: 0,
      negativeStep: 0,
      proposedValue: normalizedCurrent,
      blocked: true,
      blockReason: preview.evidenceClass || "manual-review",
      automaticAdjustmentAllowed: false,
    };
  }
  const feedback = preview.evidence?.feedback || {};
  const exposureCount = count(preview.evidence?.exposureCount);
  const decayFactor = 0.5 ** (normalizedElapsedDays / normalizedPolicy.halfLifeDays);
  const decayedValue = normalizedPolicy.floor
    + (normalizedCurrent - normalizedPolicy.floor) * decayFactor;
  const positiveStep = Math.min(
    normalizedPolicy.maximumPositiveStep,
    exposureCount * normalizedPolicy.exposureGain
      + count(feedback.used) * normalizedPolicy.usedGain
      + count(feedback.helpful) * normalizedPolicy.helpfulGain
      + count(feedback.missed) * normalizedPolicy.missedGain,
  );
  const negativeStep = Math.min(
    normalizedPolicy.maximumNegativeStep,
    count(feedback.irrelevant) * normalizedPolicy.irrelevantPenalty,
  );
  const proposedValue = clamp(
    decayedValue + positiveStep - negativeStep,
    normalizedPolicy.floor,
    normalizedPolicy.ceiling,
  );
  return {
    targetType: String(preview.targetType || "").trim(),
    targetId: String(preview.targetId || "").trim(),
    learningTarget: String(preview.learningTarget || "").trim(),
    observationWindowId: windowId,
    policyVersion: normalizedPolicy.version,
    currentValue: normalizedCurrent,
    decayedValue,
    positiveStep,
    negativeStep,
    proposedValue,
    blocked: false,
    blockReason: "",
    automaticAdjustmentAllowed: false,
  };
}
