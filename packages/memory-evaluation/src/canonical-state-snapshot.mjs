import { MEMORY_STATE_FAMILIES } from "@suzu-lives/memory-core";

function clean(value) {
  return String(value ?? "").trim();
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  const candidate = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  return Math.min(maximum, Math.max(minimum, candidate));
}

function requireCompleteText(value, maximum, label) {
  const text = String(value ?? "");
  if (text.length > maximum) {
    throw new Error(`${label} exceeds the complete ${maximum}-character budget.`);
  }
  return text;
}

function groupObservations(observations, key) {
  const groups = new Map();
  const ungroupedObservationIds = [];
  for (const observation of observations) {
    const groupId = clean(observation[key]);
    if (!groupId) {
      ungroupedObservationIds.push(observation.id);
      continue;
    }
    const group = groups.get(groupId) || {
      id: groupId,
      observationIds: [],
      memoryIds: [],
      sourceIds: [],
      qualifications: [],
      effectiveDirections: [],
      observedAt: [],
    };
    group.observationIds.push(observation.id);
    group.memoryIds.push(observation.memory_id);
    group.sourceIds.push(...observation.sourceIds);
    group.qualifications.push(observation.qualification);
    group.effectiveDirections.push(observation.effective_direction);
    group.observedAt.push(observation.observed_at);
    groups.set(groupId, group);
  }
  return {
    groups: [...groups.values()].map((group) => {
      const times = uniqueStrings(group.observedAt).sort();
      return {
        id: group.id,
        observationIds: uniqueStrings(group.observationIds).sort(),
        memoryIds: uniqueStrings(group.memoryIds).sort(),
        sourceIds: uniqueStrings(group.sourceIds).sort(),
        qualifications: uniqueStrings(group.qualifications).sort(),
        effectiveDirections: uniqueStrings(group.effectiveDirections).sort(),
        earliestObservedAt: times[0] || "",
        latestObservedAt: times.at(-1) || "",
      };
    }).sort((left, right) => left.id.localeCompare(right.id)),
    ungroupedObservationIds: uniqueStrings(ungroupedObservationIds).sort(),
  };
}

function buildObservationView(repository, agentId, observation, limits, requestLane = null) {
  const memory = repository.getMemory(observation.memory_id);
  const detail = repository.getMemoryDetail(agentId, observation.memory_id);
  if (!memory || !detail || memory.status === "deleted") {
    throw new Error("Canonical state review observation memory is unavailable.");
  }
  const sources = new Map(detail.sources.map((source) => [source.id, source]));
  if (observation.sourceIds.some((sourceId) => !sources.has(sourceId))) {
    throw new Error("Canonical state review observation source is unavailable.");
  }
  const requestBoundExplicit = Boolean(requestLane
    && requestLane.observationIds.has(observation.id)
    && requestLane.memoryIds.has(observation.memory_id)
    && observation.sourceIds.every((sourceId) => requestLane.sourceIds.has(sourceId)));
  return {
    id: observation.id,
    observationHash: observation.observation_hash,
    memoryId: observation.memory_id,
    sourceIds: [...observation.sourceIds],
    signal: observation.signal,
    claimedDirection: observation.claimed_direction,
    effectiveDirection: observation.effective_direction,
    qualification: observation.qualification,
    confidence: Number(observation.confidence),
    subjectRole: observation.subject_role,
    subjectKey: observation.subject_key,
    evidenceGroupId: observation.evidence_group_id,
    contextId: observation.context_id,
    scope: observation.scope,
    excludedReason: observation.excluded_reason,
    observedAt: observation.observed_at,
    origin: observation.origin,
    payloadSchemaVersion: observation.payload_schema_version,
    memory: {
      id: memory.id,
      kind: memory.kind,
      content: requireCompleteText(
        memory.content,
        limits.maxMemoryContentChars,
        `Memory ${memory.id}`,
      ),
      eventDate: memory.event_date,
      eventStart: memory.event_start,
      eventEnd: memory.event_end,
      knownAt: memory.known_at,
      recordedAt: memory.recorded_at,
      temporalState: memory.temporal_state,
      evidenceMode: requestBoundExplicit ? "explicit" : memory.evidence_mode,
      storedEvidenceMode: memory.evidence_mode,
      requestBoundExplicit,
    },
    sources: observation.sourceIds.map((sourceId) => {
      const source = sources.get(sourceId);
      return {
        id: source.id,
        occurredAt: source.occurred_at,
        knownAt: source.known_at,
        speaker: source.speaker,
        content: requireCompleteText(
          source.content,
          limits.maxSourceContentChars,
          `Source ${source.id}`,
        ),
      };
    }),
    analysis: observation.payload,
    analysisRunIds: [...observation.analysisRunIds],
  };
}

function countBy(values, allowed) {
  return Object.fromEntries(allowed.map((value) => [
    value,
    values.filter((candidate) => candidate === value).length,
  ]));
}

export function buildCanonicalStateEvidenceSnapshot({
  repository,
  agentId,
  stateFamily,
  subjectRole,
  subjectKey,
  canonicalKey,
  currentRepresentationLayer = "",
  subjectLabel,
  stateLabel,
  analysisRequestId = "",
  analysisRequestObservationIds = [],
  maxObservations = 400,
  maxMemoryContentChars = 4000,
  maxSourceContentChars = 8000,
  maxCurrentStateContentChars = 4000,
  maxSnapshotChars = 500_000,
} = {}) {
  if (!repository) throw new Error("Canonical state review requires a repository.");
  const normalizedAgentId = clean(agentId);
  const normalizedStateFamily = clean(stateFamily);
  const normalizedSubjectRole = clean(subjectRole);
  const normalizedSubjectKey = clean(subjectKey);
  const normalizedCanonicalKey = clean(canonicalKey).toLocaleLowerCase("en-US");
  const normalizedCurrentRepresentationLayer = clean(currentRepresentationLayer);
  if (!normalizedAgentId || !MEMORY_STATE_FAMILIES.includes(normalizedStateFamily)
    || !["user", "agent", "shared", "other"].includes(normalizedSubjectRole)
    || !normalizedSubjectKey || !normalizedCanonicalKey || !clean(subjectLabel) || !clean(stateLabel)) {
    throw new Error("Canonical state review target is incomplete.");
  }

  let requestLane = null;
  if (clean(analysisRequestId)) {
    const request = repository.getStateAnalysisRequest(
      normalizedAgentId,
      clean(analysisRequestId),
    );
    if (!request
      || !["pending", "completed"].includes(request.status)
      || request.state_family !== normalizedStateFamily
      || request.subject_role !== normalizedSubjectRole
      || request.subject_key !== normalizedSubjectKey
      || request.canonical_key !== normalizedCanonicalKey
      || normalizedCurrentRepresentationLayer !== "reported"
      || request.representation_layer !== "reported"
      || request.evidence_mode !== "explicit") {
      throw new Error("Canonical state review analysis request does not match its fixed target.");
    }
    const observationIds = new Set(uniqueStrings(analysisRequestObservationIds));
    if (!observationIds.size) {
      throw new Error("Canonical state review request lane requires explicit observation IDs.");
    }
    requestLane = {
      requestId: request.id,
      observationIds,
      memoryIds: new Set(request.memoryIds),
      sourceIds: new Set(request.sourceIds),
    };
  }

  // expand() is deliberately capped at 500 nodes. Keeping this at 499 lets us
  // detect both observation and current-evidence saturation without pretending
  // a truncated graph is complete.
  const observationLimit = boundedInteger(maxObservations, 400, 1, 499);
  const observations = repository.listStateEvidenceObservations(normalizedAgentId, {
    stateFamily: normalizedStateFamily,
    subjectRole: normalizedSubjectRole,
    subjectKey: normalizedSubjectKey,
    canonicalKey: normalizedCanonicalKey,
    representationLayer: normalizedCurrentRepresentationLayer,
    lifecycles: ["current"],
    limit: observationLimit + 1,
  });
  if (observations.length > observationLimit) {
    throw new Error(`Canonical state review exceeds the complete ${observationLimit}-observation budget.`);
  }
  if (!observations.length) {
    return { status: "skipped", reason: "no-current-state-evidence", snapshot: null };
  }

  const current = repository.getCurrentCanonicalMemory({
    agentId: normalizedAgentId,
    subjectRole: normalizedSubjectRole,
    subjectKey: normalizedSubjectKey,
    canonicalKey: normalizedCanonicalKey,
    representationLayer: normalizedCurrentRepresentationLayer,
    stateFamily: normalizedStateFamily,
  });
  let currentStateEvidenceMemoryIds = [];
  if (current) {
    const graph = repository.expand(normalizedAgentId, [current.id], {
      maxDepth: 1,
      maxNodes: 500,
      relations: ["supported_by", "challenged_by"],
      traversal: "outgoing",
    });
    if (graph.nodes.length >= 500) {
      throw new Error("Current state evidence graph reaches the complete 500-node safety limit.");
    }
    currentStateEvidenceMemoryIds = uniqueStrings(graph.edges
      .filter((edge) => edge.from_memory_id === current.id)
      .map((edge) => edge.to_memory_id)).sort();
    if (!currentStateEvidenceMemoryIds.length) {
      throw new Error("Current canonical state has no auditable evidence edges; migrate it before full review.");
    }
    const observedMemoryIds = new Set(observations.map((observation) => observation.memory_id));
    const missing = currentStateEvidenceMemoryIds.filter((memoryId) => !observedMemoryIds.has(memoryId));
    if (missing.length) {
      throw new Error(`Canonical state evidence ledger is incomplete for current state memories: ${missing.join(", ")}`);
    }
  }

  const limits = {
    maxMemoryContentChars: boundedInteger(maxMemoryContentChars, 4000, 100, 100_000),
    maxSourceContentChars: boundedInteger(maxSourceContentChars, 8000, 100, 200_000),
  };
  const views = observations.map((observation) => buildObservationView(
    repository,
    normalizedAgentId,
    observation,
    limits,
    requestLane,
  ));
  const evidenceGroups = groupObservations(observations, "evidence_group_id");
  const contextGroups = groupObservations(observations, "context_id");
  const qualified = observations.filter((observation) => observation.qualification === "qualified");
  const qualifiedDirectional = qualified.filter((observation) => (
    ["support", "opposition"].includes(observation.effective_direction)
  ));
  const snapshot = {
    schemaVersion: 1,
    agentId: normalizedAgentId,
    target: {
      stateFamily: normalizedStateFamily,
      subjectRole: normalizedSubjectRole,
      subjectKey: normalizedSubjectKey,
      canonicalKey: normalizedCanonicalKey,
      currentRepresentationLayer: normalizedCurrentRepresentationLayer,
      subjectLabel: clean(subjectLabel),
      stateLabel: clean(stateLabel),
    },
    currentState: current ? {
      id: current.id,
      kind: current.kind,
      content: requireCompleteText(
        current.content,
        boundedInteger(maxCurrentStateContentChars, 4000, 100, 100_000),
        `Current state ${current.id}`,
      ),
      scope: current.metadata?.scope || current.metadata?.preferenceScope || {},
      knownAt: current.known_at,
      validFrom: current.valid_from,
      validTo: current.valid_to,
      temporalState: current.temporal_state,
      evidenceMode: current.evidence_mode,
      representationLayer: current.representation_layer,
    } : null,
    observations: views,
    groups: {
      evidence: evidenceGroups.groups,
      context: contextGroups.groups,
      observationsWithoutContext: contextGroups.ungroupedObservationIds,
    },
    requiredQualifiedObservationIds: qualified.map((observation) => observation.id).sort(),
    qualifiedDirectionalObservationIds: qualifiedDirectional.map((observation) => observation.id).sort(),
    completeness: {
      currentObservationCount: observations.length,
      qualificationCounts: countBy(
        observations.map((observation) => observation.qualification),
        ["qualified", "excluded", "unresolved"],
      ),
      effectiveDirectionCounts: countBy(
        observations.map((observation) => observation.effective_direction),
        ["support", "opposition", "neutral"],
      ),
      uniqueEvidenceGroupCount: evidenceGroups.groups.length,
      uniqueContextCount: contextGroups.groups.length,
      uniqueMemoryCount: uniqueStrings(observations.map((observation) => observation.memory_id)).length,
      uniqueSourceCount: uniqueStrings(observations.flatMap((observation) => observation.sourceIds)).length,
      currentStateEvidenceMemoryIds,
      currentStateEvidenceCovered: current ? true : null,
      silentlyTruncated: false,
    },
    synthesisEligibility: qualifiedDirectional.length ? "family-policy-required" : "evidence-only",
    inputPolicy: {
      targetIsFixedByCaller: true,
      familyIsolationIsRequired: true,
      allCurrentObservationsAreIncluded: true,
      excludedAndUnresolvedAreVisible: true,
      evidenceGroupsAreNotVotes: true,
      familyThresholdsAreNotApplied: true,
      modelCannotWriteMemoryOrProposals: true,
      currentStateLayerIsFixedByCaller: Boolean(normalizedCurrentRepresentationLayer),
      requestBoundExplicitLane: requestLane ? {
        requestId: requestLane.requestId,
        observationIds: [...requestLane.observationIds].sort(),
      } : null,
    },
  };
  const charLimit = boundedInteger(maxSnapshotChars, 500_000, 20_000, 2_000_000);
  if (JSON.stringify(snapshot).length > charLimit) {
    throw new Error(`Canonical state review exceeds the complete ${charLimit}-character budget.`);
  }
  return { status: "ready", reason: "", snapshot };
}
