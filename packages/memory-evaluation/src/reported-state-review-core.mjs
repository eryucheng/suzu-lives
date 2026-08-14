function clean(value) {
  return String(value ?? "").trim();
}

export function normalizeReportedClaim(value) {
  return clean(value).toLocaleLowerCase("zh-CN").replace(/\s+/gu, " ");
}

export function selectLatestReportedCandidate(candidates, {
  hasCurrentState = false,
  isExplicitChange = () => false,
} = {}) {
  const ordered = [...candidates].sort((left, right) => (
    right.observedAt.localeCompare(left.observedAt)
    || left.observation.id.localeCompare(right.observation.id)
  ));
  if (!ordered.length) {
    return { status: "skipped", reason: "no-qualified-direct-current-state", selected: null, ordered };
  }
  const latestAt = ordered[0].observedAt;
  const latest = ordered.filter((candidate) => candidate.observedAt === latestAt);
  if (new Set(latest.map((candidate) => candidate.claimKey)).size !== 1) {
    return { status: "review_required", reason: "simultaneous-direct-state-conflict", selected: null, ordered };
  }
  const selected = latest[0];
  if (!hasCurrentState
    && new Set(ordered.map((candidate) => candidate.claimKey)).size > 1
    && !isExplicitChange(selected)) {
    return {
      status: "review_required",
      reason: "multiple-unresolved-direct-states-without-change-cue",
      selected,
      ordered,
    };
  }
  return { status: "ready", reason: "", selected, ordered };
}
