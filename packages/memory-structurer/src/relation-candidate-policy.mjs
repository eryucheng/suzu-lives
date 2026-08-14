function clean(value) {
  return String(value ?? "").trim();
}

export function enforceRelationCandidatePolicy(candidate, snapshot, {
  requiredTriggerMemoryIds = [],
  requiredHistoricalMemoryIds = [],
  requireRetrospectiveParticipation = false,
} = {}) {
  const relation = clean(candidate?.relation);
  const fromMemoryId = clean(candidate?.fromMemoryId);
  const toMemoryId = clean(candidate?.toMemoryId);
  if (relation !== "causes") {
    throw new Error("Relation candidate must use the causes relation.");
  }
  if (!fromMemoryId || !toMemoryId || fromMemoryId === toMemoryId) {
    throw new Error("Relation candidate requires two distinct directed endpoints.");
  }
  const memories = new Map(snapshot.memories.map((memory) => [memory.id, memory]));
  const from = memories.get(fromMemoryId);
  const to = memories.get(toMemoryId);
  if (!from || !to) {
    throw new Error("Every relation endpoint must come from the bounded snapshot.");
  }
  const availableSourceIds = new Set(snapshot.sourceRecords.map((source) => source.id));
  const evidenceSourceIds = [...new Set(
    (Array.isArray(candidate?.evidenceSourceIds) ? candidate.evidenceSourceIds : [])
      .map(clean)
      .filter(Boolean),
  )];
  if (!evidenceSourceIds.length
    || evidenceSourceIds.some((sourceId) => !availableSourceIds.has(sourceId))) {
    throw new Error("Relation evidence must come from the bounded source records.");
  }
  const fromSources = new Set(from.sourceIds);
  const toSources = new Set(to.sourceIds);
  if (!evidenceSourceIds.some((sourceId) => fromSources.has(sourceId))
    || !evidenceSourceIds.some((sourceId) => toSources.has(sourceId))) {
    throw new Error("Relation evidence must cover both endpoints in the bounded snapshot.");
  }
  if (!clean(candidate?.rationale)) {
    throw new Error("Relation candidate requires a reviewable rationale.");
  }
  if (requireRetrospectiveParticipation) {
    const triggers = new Set(
      (Array.isArray(requiredTriggerMemoryIds) ? requiredTriggerMemoryIds : []).map(clean).filter(Boolean),
    );
    const historical = new Set(
      (Array.isArray(requiredHistoricalMemoryIds) ? requiredHistoricalMemoryIds : []).map(clean).filter(Boolean),
    );
    const endpoints = new Set([fromMemoryId, toMemoryId]);
    if (!triggers.size || !historical.size) {
      throw new Error("Retrospective relation policy requires trigger and historical partitions.");
    }
    if (![...triggers].some((id) => endpoints.has(id))
      || ![...historical].some((id) => endpoints.has(id))) {
      throw new Error("Retrospective relation proposal must connect a trigger memory with a historical memory.");
    }
  }
  return {
    ...candidate,
    relation,
    fromMemoryId,
    toMemoryId,
    evidenceSourceIds,
  };
}
