function count(value) {
  const normalized = Math.trunc(Number(value) || 0);
  return Math.max(0, normalized);
}

function feedbackCounts(stats) {
  return {
    used: count(stats?.feedback?.used),
    helpful: count(stats?.feedback?.helpful),
    irrelevant: count(stats?.feedback?.irrelevant),
    incorrect: count(stats?.feedback?.incorrect),
    missed: count(stats?.feedback?.missed),
    corrected: count(stats?.feedback?.corrected),
  };
}

function classifyEvidence({ exposureCount, feedback }) {
  const reviewCount = feedback.incorrect + feedback.corrected;
  const positiveCount = feedback.helpful + feedback.missed;
  const negativeCount = feedback.irrelevant;
  if (reviewCount > 0) {
    return {
      evidenceClass: "content-review-required",
      candidateDirection: "hold",
      evidenceTier: "blocked",
      reasonCodes: ["incorrect-or-corrected-content"],
    };
  }
  if (positiveCount > 0 && negativeCount > 0) {
    return {
      evidenceClass: "conflicting-feedback",
      candidateDirection: "hold",
      evidenceTier: "blocked",
      reasonCodes: ["positive-and-negative-feedback"],
    };
  }
  if (feedback.helpful > 0) {
    return {
      evidenceClass: "confirmed-helpful",
      candidateDirection: "increase",
      evidenceTier: "verified",
      reasonCodes: ["explicit-helpful-feedback"],
    };
  }
  if (feedback.missed > 0) {
    return {
      evidenceClass: "relevant-but-missed",
      candidateDirection: "increase",
      evidenceTier: "verified",
      reasonCodes: ["explicit-missed-feedback"],
    };
  }
  if (feedback.irrelevant > 0) {
    return {
      evidenceClass: "confirmed-irrelevant",
      candidateDirection: "decrease",
      evidenceTier: "verified",
      reasonCodes: ["explicit-irrelevant-feedback"],
    };
  }
  if (feedback.used > 0) {
    return {
      evidenceClass: "use-confirmed",
      candidateDirection: "increase",
      evidenceTier: "weak",
      reasonCodes: ["used-without-outcome-feedback"],
    };
  }
  if (exposureCount > 0) {
    return {
      evidenceClass: "exposure-only",
      candidateDirection: "increase",
      evidenceTier: "weak",
      reasonCodes: ["selected-without-usage-feedback"],
    };
  }
  return {
    evidenceClass: "no-evidence",
    candidateDirection: "hold",
    evidenceTier: "none",
    reasonCodes: [],
  };
}

function preview({ targetType, targetId, exposureCount, stats }) {
  const feedback = feedbackCounts(stats);
  const classification = classifyEvidence({ exposureCount, feedback });
  const blocked = classification.evidenceTier === "blocked";
  return {
    targetType,
    targetId,
    learningTarget: blocked
      ? "manual-review"
      : targetType === "memory"
        ? "accessibility"
        : "relation-utility",
    ...classification,
    automaticAdjustmentAllowed: false,
    evidence: {
      exposureCount,
      feedback,
    },
    invariants: {
      contentEffect: "none",
      confidenceEffect: "none",
      importanceEffect: "none",
      baseEdgeWeightEffect: "none",
      currentRankingEffect: "none",
    },
  };
}

export function previewMemoryPlasticity(stats = {}) {
  return preview({
    targetType: "memory",
    targetId: String(stats?.memoryId || "").trim(),
    exposureCount: count(stats?.selectedCount),
    stats,
  });
}

export function previewEdgePlasticity(stats = {}) {
  return {
    ...preview({
      targetType: "edge",
      targetId: String(stats?.edgeId || "").trim(),
      exposureCount: count(stats?.traversedCount),
      stats,
    }),
    intentView: String(stats?.intentView || "").trim(),
  };
}
