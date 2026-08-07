function clean(value) {
  return String(value ?? "").trim();
}

const EXPLICIT_SIGNALS = new Set(["explicit_preference", "explicit_rejection"]);
const BEHAVIOR_SIGNALS = new Set([
  "active_choice",
  "repeated_behavior",
  "active_sharing",
  "voluntary_acceptance",
  "counter_behavior",
  "single_occurrence",
  "passive_exposure",
]);

function targetRoleMatches(memory, target, allowedRoles, { allowPrimarySubject = true } = {}) {
  if (allowPrimarySubject
    && memory.subjectRole === target.subjectRole
    && memory.subjectKey === target.subjectKey) {
    return true;
  }
  return memory.actorRoles.some((role) => (
    allowedRoles.has(role.role)
    && role.actorRole === target.subjectRole
    && role.actorKey === target.subjectKey
  ));
}

function assertTargetRole(candidate, memory, target) {
  if (EXPLICIT_SIGNALS.has(candidate.signal)) {
    if (memory.kind !== "preference") {
      throw new Error("Explicit preference evidence must come from a direct preference memory.");
    }
    if (!targetRoleMatches(memory, target, new Set(["speaker", "preference_holder"]), {
      allowPrimarySubject: false,
    })) {
      throw new Error("Explicit preference evidence requires the fixed holder as speaker or preference holder.");
    }
    return;
  }
  if (candidate.signal === "active_sharing") {
    if (!targetRoleMatches(memory, target, new Set(["speaker"]), { allowPrimarySubject: false })) {
      throw new Error("Active sharing evidence requires the fixed holder as speaker.");
    }
    return;
  }
  const allowed = candidate.signal === "passive_exposure"
    ? new Set(["subject", "experiencer", "observer"])
    : new Set(["subject", "experiencer"]);
  if (!targetRoleMatches(memory, target, allowed)) {
    throw new Error("Preference evidence does not identify the fixed holder in the required role.");
  }
}

function evidenceTime(memory, sourceRecords) {
  return clean(
    memory.eventStart
      || memory.eventDate
      || sourceRecords.find((source) => source.occurredAt)?.occurredAt
      || sourceRecords.find((source) => source.knownAt)?.knownAt
      || memory.knownAt,
  );
}

export function enforcePreferenceEvidencePolicy(candidate, snapshot) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Preference evidence candidate must be an object.");
  }
  const memoryId = clean(candidate.memoryId);
  const memories = new Map(snapshot.memories.map((memory) => [memory.id, memory]));
  const memory = memories.get(memoryId);
  if (!memory) {
    throw new Error("Preference evidence memory must come from the bounded snapshot.");
  }
  const sourceIds = [...new Set(
    (Array.isArray(candidate.sourceIds) ? candidate.sourceIds : []).map(clean).filter(Boolean),
  )];
  const availableSourceIds = new Set(memory.sourceIds);
  if (!sourceIds.length || sourceIds.some((sourceId) => !availableSourceIds.has(sourceId))) {
    throw new Error("Preference evidence sources must directly support the selected memory.");
  }
  if (!clean(candidate.rationale)) {
    throw new Error("Preference evidence requires a reviewable rationale.");
  }
  assertTargetRole(candidate, memory, snapshot.target);
  if (BEHAVIOR_SIGNALS.has(candidate.signal) && !memory.contextId) {
    throw new Error("Behavioral preference evidence requires a code-derived auditable context.");
  }
  const sourceMap = new Map(snapshot.sourceRecords.map((source) => [source.id, source]));
  const citedSources = sourceIds.map((sourceId) => sourceMap.get(sourceId)).filter(Boolean);
  if (citedSources.length !== sourceIds.length) {
    throw new Error("Preference evidence sources must exist in the bounded snapshot.");
  }
  return {
    ...candidate,
    memoryId,
    sourceIds,
    subjectRole: snapshot.target.subjectRole,
    subjectKey: snapshot.target.subjectKey,
    evidenceGroupId: memory.evidenceGroupId,
    contextId: memory.contextId,
    eventTime: evidenceTime(memory, citedSources),
    knownAt: memory.knownAt,
    contextBasis: memory.contextBasis,
  };
}
