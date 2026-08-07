function clean(value) {
  return String(value ?? "").trim();
}

function datePart(value) {
  const text = clean(value);
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) return text;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : "";
}

function temporalEvidence(memory) {
  return datePart(memory.eventDate) || datePart(memory.eventStart) || datePart(memory.knownAt);
}

function deriveEpisodeBoundary(members) {
  const dates = members.flatMap((memory) => [
    datePart(memory.eventDate),
    datePart(memory.eventStart),
    datePart(memory.eventEnd),
  ]).filter(Boolean).sort();
  const starts = members.map((memory) => clean(memory.eventStart))
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort();
  const endpoints = members.flatMap((memory) => [memory.eventEnd, memory.eventStart])
    .map(clean)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort();
  const eventStart = starts[0] || null;
  const latest = endpoints.at(-1) || null;
  return {
    eventDate: dates[0] || null,
    eventStart,
    eventEnd: eventStart && latest && Date.parse(latest) > Date.parse(eventStart) ? latest : null,
  };
}

export function enforceStructureCandidatePolicy(candidate, snapshot, {
  minimumTopicEvidenceDates = 2,
  minimumEpisodeTimedMembers = 2,
  requiredTriggerMemoryIds = [],
  requiredHistoricalMemoryIds = [],
  requireRetrospectiveParticipation = false,
} = {}) {
  const currentById = new Map(snapshot.currentMemories.map((memory) => [memory.id, memory]));
  const containerById = new Map(snapshot.candidateContainers.map((memory) => [memory.id, memory]));
  const memberIds = [...new Set(
    (Array.isArray(candidate.memberIds) ? candidate.memberIds : []).map(clean).filter(Boolean),
  )];
  if (!memberIds.length || memberIds.some((id) => !currentById.has(id))) {
    throw new Error("Every structure member must come from currentMemories in this bounded snapshot.");
  }
  const operation = clean(candidate.operation);
  const kind = clean(candidate.kind);
  const enforceRetrospectiveParticipation = (value) => {
    if (!requireRetrospectiveParticipation) return value;
    const members = new Set(value.memberIds);
    const triggerIds = new Set(
      (Array.isArray(requiredTriggerMemoryIds) ? requiredTriggerMemoryIds : []).map(clean).filter(Boolean),
    );
    const historicalIds = new Set(
      (Array.isArray(requiredHistoricalMemoryIds) ? requiredHistoricalMemoryIds : []).map(clean).filter(Boolean),
    );
    if (!triggerIds.size || !historicalIds.size) {
      throw new Error("Retrospective structure policy requires trigger and historical partitions.");
    }
    if (![...triggerIds].some((id) => members.has(id))) {
      throw new Error("Retrospective structure proposal must include a trigger memory.");
    }
    if (value.operation === "create" && ![...historicalIds].some((id) => members.has(id))) {
      throw new Error("Retrospective structure creation must include a historical memory.");
    }
    return value;
  };
  if (operation === "attach") {
    const target = containerById.get(clean(candidate.targetMemoryId));
    if (!target || target.kind !== kind) {
      throw new Error("Attach target must be a matching candidateContainer in this bounded snapshot.");
    }
    return enforceRetrospectiveParticipation({ ...candidate, memberIds });
  }
  if (operation !== "create") {
    throw new Error("Structure operation must be create or attach.");
  }
  if (clean(candidate.targetMemoryId)) {
    throw new Error("Create proposal cannot name a targetMemoryId.");
  }
  if (memberIds.length < 2) {
    throw new Error("Create proposal requires at least two current memories.");
  }
  const members = memberIds.map((id) => currentById.get(id));
  if (kind === "episode") {
    const timedMembers = members.filter((memory) => (
      datePart(memory.eventDate) || datePart(memory.eventStart)
    ));
    const minimum = Math.max(2, Math.trunc(Number(minimumEpisodeTimedMembers) || 2));
    if (timedMembers.length < minimum) {
      throw new Error(`Episode creation requires at least ${minimum} time-bearing current memories.`);
    }
    return enforceRetrospectiveParticipation({
      ...candidate,
      memberIds,
      ...deriveEpisodeBoundary(timedMembers),
    });
  }
  if (kind === "topic") {
    const evidenceDates = new Set(members.map(temporalEvidence).filter(Boolean));
    const minimum = Math.max(2, Math.trunc(Number(minimumTopicEvidenceDates) || 2));
    if (evidenceDates.size < minimum) {
      throw new Error(`Topic creation requires evidence from at least ${minimum} distinct dates.`);
    }
    return enforceRetrospectiveParticipation({
      ...candidate,
      memberIds,
      eventDate: null,
      eventStart: null,
      eventEnd: null,
    });
  }
  throw new Error("Structure kind must be episode or topic.");
}
