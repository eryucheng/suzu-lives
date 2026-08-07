import {
  EVIDENCE_MODES,
  MEMORY_ACTOR_ROLES,
  MEMORY_KIND_DEFINITIONS,
  MEMORY_KINDS,
  MEMORY_STATE_FAMILY_STORAGE_VALUES,
  MEMORY_STATE_PHASES,
  REALITY_STATES,
  REPRESENTATION_LAYERS,
  REVISION_ACTIONS,
  SOURCE_AUTHORITIES,
  SUBJECT_ROLES,
  TEMPORAL_STATES,
  isMemoryKindAllowedForStateFamily,
  isStatefulMemoryKind,
  memoryLayerForKind,
} from "./ontology.mjs";
import {
  NON_STATE_SCOPE_KEY,
  ROOT_STATE_SCOPE_KEY,
  isValidStateScopeKey,
} from "./state-scope.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function oneOf(value, allowed, fallback) {
  const normalized = clean(value);
  return allowed.includes(normalized) ? normalized : fallback;
}

function bounded(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

function validCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function normalizedDate(value, issues, field) {
  const text = clean(value);
  if (!text) return null;
  if (validCalendarDate(text)) return text;
  issues.push(`invalid-${field}`);
  return null;
}

function normalizedTimestamp(value, issues = null, field = "timestamp") {
  const text = clean(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isFinite(date.getTime())) return date.toISOString();
  if (issues) issues.push(`invalid-${field}`);
  return null;
}

function normalizedContentKey(value) {
  return clean(value).toLocaleLowerCase("zh-CN").replace(/\s+/gu, " ");
}

function normalizeActorRoles(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    role: oneOf(item?.role, MEMORY_ACTOR_ROLES, ""),
    actorRole: oneOf(item?.actorRole, SUBJECT_ROLES, "unknown"),
    actorKey: clean(item?.actorKey),
    isPrimary: Boolean(item?.isPrimary),
    confidence: bounded(item?.confidence, 1),
    provenance: clean(item?.provenance),
    metadata: item?.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
      ? { ...item.metadata }
      : {},
  }));
}

function actorMatchesSubject(actor, subjectRole, subjectKey) {
  return actor.actorRole === subjectRole && actor.actorKey === subjectKey;
}

function ensureStateHolderRole(actorRoles, {
  kind,
  subjectRole,
  subjectKey,
  confidence,
}) {
  const holderRole = kind === "belief_state"
    ? "belief_holder"
    : kind === "preference" ? "preference_holder" : "";
  if (!holderRole || ["unknown", "world"].includes(subjectRole)) return actorRoles;
  if (actorRoles.some((actor) => (
    actor.role === holderRole && actorMatchesSubject(actor, subjectRole, subjectKey)
  ))) return actorRoles;
  return [...actorRoles, {
    role: holderRole,
    actorRole: subjectRole,
    actorKey: subjectKey,
    isPrimary: true,
    confidence,
    provenance: "memory-policy-kind-subject",
    metadata: {},
  }];
}

function normalizeEvidenceLinks(input, evidenceMode) {
  const defaults = (Array.isArray(input.sourceIds) ? input.sourceIds : []).map((sourceId) => ({
    sourceId,
    relation: "evidence",
    authority: evidenceMode === "imported" ? "legacy_unknown" : "unknown",
    sourceTrust: evidenceMode === "inferred" ? 0.5 : 0.9,
    evidenceStrength: 1,
    provenance: "",
    metadata: {},
  }));
  const provided = Array.isArray(input.evidenceLinks) ? input.evidenceLinks : [];
  const unique = new Map();
  for (const item of [...defaults, ...provided]) {
    const sourceId = clean(item?.sourceId);
    const relation = clean(item?.relation) || "evidence";
    if (!sourceId) continue;
    unique.set(`${sourceId}\u001f${relation}`, {
      sourceId,
      relation,
      authority: oneOf(item?.authority, SOURCE_AUTHORITIES, "unknown"),
      sourceTrust: bounded(item?.sourceTrust, 0.5),
      evidenceStrength: bounded(item?.evidenceStrength, 1),
      provenance: clean(item?.provenance),
      metadata: item?.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
        ? { ...item.metadata }
        : {},
    });
  }
  return [...unique.values()];
}

export function normalizeMemoryCandidate(input = {}, {
  agentId = input.agentId,
  recordedAt = new Date().toISOString(),
} = {}) {
  const kind = oneOf(input.kind, MEMORY_KINDS, "");
  const evidenceMode = oneOf(input.evidenceMode, EVIDENCE_MODES, "inferred");
  let confidence = bounded(input.confidence, evidenceMode === "inferred" ? 0.5 : 0.9);
  if (evidenceMode === "inferred") confidence = Math.min(confidence, 0.65);
  const evidenceLinks = normalizeEvidenceLinks(input, evidenceMode);
  const normalizationIssues = Array.isArray(input.normalizationIssues)
    ? input.normalizationIssues.map(clean).filter(Boolean)
    : [];
  const subjectRole = oneOf(input.subjectRole, SUBJECT_ROLES, "unknown");
  const subjectKey = clean(input.subjectKey);
  const eventDate = normalizedDate(input.eventDate, normalizationIssues, "event-date");
  const eventStart = normalizedTimestamp(input.eventStart, normalizationIssues, "event-start");
  const eventEnd = normalizedTimestamp(input.eventEnd, normalizationIssues, "event-end");
  const knownAt = normalizedTimestamp(input.knownAt, normalizationIssues, "known-at");
  const validFrom = normalizedTimestamp(input.validFrom, normalizationIssues, "valid-from");
  const validTo = normalizedTimestamp(input.validTo, normalizationIssues, "valid-to");
  const normalizedRecordedAt = normalizedTimestamp(recordedAt, normalizationIssues, "recorded-at")
    || new Date().toISOString();
  const actorRoles = ensureStateHolderRole(normalizeActorRoles(input.actorRoles), {
    kind,
    subjectRole,
    subjectKey,
    confidence,
  });
  const stateful = isStatefulMemoryKind(kind);

  const candidate = {
    id: clean(input.id),
    agentId: clean(agentId),
    kind,
    layer: memoryLayerForKind(kind),
    title: clean(input.title),
    content: clean(input.content),
    subjectRole,
    subjectKey,
    canonicalKey: clean(input.canonicalKey).toLocaleLowerCase("en-US"),
    representationLayer: oneOf(input.representationLayer, REPRESENTATION_LAYERS, "unspecified"),
    stateFamily: oneOf(
      input.stateFamily,
      MEMORY_STATE_FAMILY_STORAGE_VALUES,
      stateful ? "unspecified" : "not_applicable",
    ),
    statePhase: oneOf(
      input.statePhase,
      MEMORY_STATE_PHASES,
      stateful ? "unspecified" : "not_applicable",
    ),
    stateScopeKey: clean(input.stateScopeKey)
      || (stateful ? ROOT_STATE_SCOPE_KEY : NON_STATE_SCOPE_KEY),
    reality: oneOf(input.reality, REALITY_STATES, "unknown"),
    evidenceMode,
    temporalState: oneOf(input.temporalState, TEMPORAL_STATES, "unknown"),
    revisionAction: oneOf(input.revisionAction, REVISION_ACTIONS, "add"),
    eventDate,
    eventStart,
    eventEnd,
    knownAt,
    validFrom,
    validTo,
    recordedAt: normalizedRecordedAt,
    confidence,
    importance: bounded(input.importance, 0.5),
    perspective: clean(input.perspective),
    sourceIds: [...new Set(evidenceLinks.map((link) => link.sourceId))],
    evidenceLinks,
    actorRoles,
    normalizationIssues: [...new Set(normalizationIssues)],
    metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? { ...input.metadata }
      : {},
  };
  if (isStatefulMemoryKind(kind) && !candidate.validFrom) {
    candidate.validFrom = ["fact", "relationship"].includes(kind)
      ? candidate.eventStart || candidate.knownAt || candidate.recordedAt
      : candidate.knownAt || candidate.recordedAt;
  }
  return candidate;
}

export function assessMemoryCandidate(candidate) {
  const reasons = [];
  const reviewReasons = [];
  reasons.push(...(Array.isArray(candidate.normalizationIssues)
    ? candidate.normalizationIssues
    : []));
  if (!candidate.agentId) reasons.push("missing-agent-id");
  if (!isValidStateScopeKey(candidate.stateScopeKey)) reasons.push("invalid-state-scope-key");
  if (isStatefulMemoryKind(candidate.kind) && candidate.stateScopeKey === NON_STATE_SCOPE_KEY) {
    reasons.push("stateful-memory-needs-state-scope-key");
  }
  if (!isStatefulMemoryKind(candidate.kind) && candidate.stateScopeKey !== NON_STATE_SCOPE_KEY) {
    reasons.push("non-state-memory-cannot-have-state-scope-key");
  }
  if (!MEMORY_KIND_DEFINITIONS[candidate.kind]) reasons.push("unknown-memory-kind");
  if (!candidate.content) reasons.push("missing-content");
  if (!candidate.layer) reasons.push("missing-memory-layer");

  if (candidate.kind !== "utterance" && candidate.subjectRole === "unknown") {
    reviewReasons.push("unknown-subject");
  }
  if (candidate.subjectRole !== "world" && candidate.subjectRole !== "unknown" && !candidate.subjectKey) {
    reasons.push("missing-subject-key");
  }
  if (isStatefulMemoryKind(candidate.kind) && !candidate.canonicalKey) {
    reasons.push("missing-canonical-key");
  }
  if (!isStatefulMemoryKind(candidate.kind)
    && (candidate.stateFamily !== "not_applicable" || candidate.statePhase !== "not_applicable")) {
    reasons.push("non-state-memory-has-state-contract");
  }
  if (isStatefulMemoryKind(candidate.kind) && candidate.stateFamily === "not_applicable") {
    reasons.push("stateful-memory-has-no-state-family");
  }
  if (isStatefulMemoryKind(candidate.kind) && candidate.statePhase === "not_applicable") {
    reasons.push("stateful-memory-has-no-state-phase");
  }
  if (isStatefulMemoryKind(candidate.kind) && candidate.stateFamily !== "unspecified"
    && !isMemoryKindAllowedForStateFamily(candidate.kind, candidate.stateFamily)) {
    reasons.push("state-family-kind-mismatch");
  }
  if (
    candidate.kind === "reflection"
    && !["agent", "shared"].includes(candidate.subjectRole)
  ) {
    reasons.push("reflection-must-belong-to-agent-or-shared");
  }
  for (const actor of candidate.actorRoles) {
    if (!actor.role) reasons.push("unknown-memory-actor-role");
    if (actor.actorRole === "unknown") reasons.push("unknown-memory-actor");
    if (!["world", "unknown"].includes(actor.actorRole) && !actor.actorKey) {
      reasons.push("missing-memory-actor-key");
    }
    if (
      actor.role === "subject"
      && !actorMatchesSubject(actor, candidate.subjectRole, candidate.subjectKey)
    ) reasons.push("actor-subject-conflicts-with-primary-subject");
  }

  const holderRole = candidate.kind === "belief_state"
    ? "belief_holder"
    : candidate.kind === "preference" ? "preference_holder" : "";
  if (holderRole && candidate.actorRoles.some((actor) => (
    actor.role === holderRole
    && !actorMatchesSubject(actor, candidate.subjectRole, candidate.subjectKey)
  ))) reviewReasons.push("holder-conflicts-with-subject");

  if (candidate.eventStart && candidate.eventEnd && candidate.eventEnd < candidate.eventStart) {
    reasons.push("event-end-before-event-start");
  }
  if (candidate.validFrom && candidate.validTo && candidate.validTo < candidate.validFrom) {
    reasons.push("valid-to-before-valid-from");
  }
  if (candidate.temporalState === "in_progress" && candidate.eventEnd) {
    reviewReasons.push("in-progress-memory-has-event-end");
  }
  if (candidate.revisionAction === "complete" && candidate.temporalState !== "completed") {
    reviewReasons.push("completed-revision-requires-completed-state");
  }
  if (candidate.revisionAction === "cancel" && candidate.temporalState !== "cancelled") {
    reviewReasons.push("cancel-revision-requires-cancelled-state");
  }

  if (
    isStatefulMemoryKind(candidate.kind)
    && candidate.evidenceMode === "inferred"
  ) {
    reviewReasons.push("inferred-stateful-memory");
  }
  if (
    candidate.kind !== "reflection"
    && !["manual", "imported"].includes(candidate.evidenceMode)
    && candidate.sourceIds.length === 0
  ) {
    reviewReasons.push("missing-source-evidence");
  }
  if (candidate.kind !== "utterance" && candidate.reality === "unknown") {
    reviewReasons.push("unknown-reality");
  }
  if (candidate.kind !== "utterance" && candidate.temporalState === "unknown") {
    reviewReasons.push("unknown-temporal-state");
  }

  if (reasons.length) return { decision: "reject", reasons: [...new Set(reasons)] };
  if (reviewReasons.length) return { decision: "review", reasons: [...new Set(reviewReasons)] };
  return { decision: "store", reasons: [] };
}

function nodeAsCandidate(node) {
  return {
    id: node.id,
    agentId: node.agent_id,
    kind: node.kind,
    layer: node.layer,
    title: node.title,
    content: node.content,
    eventDate: node.event_date,
    eventStart: node.event_start,
    eventEnd: node.event_end,
    knownAt: node.known_at,
    recordedAt: node.recorded_at,
    status: node.status,
    confidence: node.confidence,
    importance: node.importance,
    perspective: node.perspective,
    subjectRole: node.subject_role,
    subjectKey: node.subject_key,
    canonicalKey: node.canonical_key,
    reality: node.reality,
    evidenceMode: node.evidence_mode,
    representationLayer: node.representation_layer,
    stateFamily: node.state_family,
    statePhase: node.state_phase,
    stateScopeKey: node.state_scope_key,
    temporalState: node.temporal_state,
    revisionAction: node.revision_action,
    validFrom: node.valid_from,
    validTo: node.valid_to,
    metadata: node.metadata,
  };
}

function writeCandidate(repository, candidate, status = "active") {
  const memory = repository.upsertMemory({ ...candidate, status });
  for (const link of candidate.evidenceLinks) {
    if (repository.getSource(link.sourceId)) {
      repository.linkSource(memory.id, link.sourceId, link.relation, link);
    }
  }
  return memory;
}

const CHANGE_RELATIONS = Object.freeze({
  update: "supersedes",
  correct: "corrects",
  contradict: "contradicts",
  complete: "completes",
  cancel: "cancels",
});

const CLOSES_PREVIOUS_VALIDITY = new Set(["update", "complete", "cancel"]);

function knowledgeOrderTime(memory) {
  return clean(memory.known_at ?? memory.knownAt)
    || clean(memory.recorded_at ?? memory.recordedAt);
}

function validityStart(memory) {
  return clean(memory.valid_from ?? memory.validFrom);
}

export function applyMemoryCandidate(repository, input, options = {}) {
  const candidate = normalizeMemoryCandidate(input, options);
  const assessment = assessMemoryCandidate(candidate);
  if (assessment.decision !== "store") {
    return {
      status: assessment.decision,
      reasons: assessment.reasons,
      candidate,
      memory: null,
    };
  }

  const existing = candidate.canonicalKey
    ? repository.findCanonicalMemories({
      agentId: candidate.agentId,
      subjectRole: candidate.subjectRole,
      subjectKey: candidate.subjectKey,
      canonicalKey: candidate.canonicalKey,
      representationLayer: candidate.representationLayer,
      stateFamily: candidate.stateFamily,
      stateScopeKey: candidate.stateScopeKey,
      statuses: ["active", "disputed"],
    })
    : [];
  const exact = existing.find(
    (memory) => normalizedContentKey(memory.content) === normalizedContentKey(candidate.content),
  );

  if (exact) {
    const reinforced = repository.upsertMemory({
      ...nodeAsCandidate(exact),
      confidence: Math.max(exact.confidence, candidate.confidence),
      importance: Math.max(exact.importance, candidate.importance),
      revisionAction: "reinforce",
      actorRoles: candidate.actorRoles,
      metadata: { ...exact.metadata, ...candidate.metadata },
    });
    for (const link of candidate.evidenceLinks) {
      if (repository.getSource(link.sourceId)) {
        repository.linkSource(reinforced.id, link.sourceId, link.relation, link);
      }
    }
    return {
      status: "reinforced",
      reasons: [],
      candidate,
      memory: reinforced,
    };
  }

  if (
    existing.length
    && ["add", "reinforce"].includes(candidate.revisionAction)
  ) {
    return {
      status: "review",
      reasons: ["same-key-different-content-needs-explicit-change"],
      candidate,
      memory: null,
      existing,
    };
  }

  if (existing.length && CHANGE_RELATIONS[candidate.revisionAction]) {
    const candidateKnowledgeTime = knowledgeOrderTime(candidate);
    const newerExisting = existing.filter((memory) => (
      knowledgeOrderTime(memory)
      && candidateKnowledgeTime
      && knowledgeOrderTime(memory) > candidateKnowledgeTime
    ));
    if (newerExisting.length) {
      return {
        status: "review",
        reasons: ["state-change-older-than-current-state"],
        candidate,
        memory: null,
        existing: newerExisting,
      };
    }
    if (CLOSES_PREVIOUS_VALIDITY.has(candidate.revisionAction)) {
      const laterValidity = existing.filter((memory) => (
        validityStart(memory)
        && candidate.validFrom
        && validityStart(memory) > candidate.validFrom
      ));
      if (laterValidity.length) {
        return {
          status: "review",
          reasons: ["state-validity-precedes-current-state"],
          candidate,
          memory: null,
          existing: laterValidity,
        };
      }
    }
  }

  const relation = CHANGE_RELATIONS[candidate.revisionAction] || "";
  const incomingStatus = candidate.revisionAction === "contradict"
    ? "disputed"
    : "active";
  const memory = repository.transaction(() => {
    const created = writeCandidate(repository, candidate, incomingStatus);
    for (const previous of existing) {
      if (CLOSES_PREVIOUS_VALIDITY.has(candidate.revisionAction) && candidate.validFrom) {
        repository.upsertMemory({
          ...nodeAsCandidate(previous),
          validTo: candidate.validFrom,
        });
      }
      repository.updateMemoryStatus(
        previous.id,
        candidate.revisionAction === "contradict" ? "disputed" : "superseded",
      );
      if (relation) {
        repository.upsertEdge({
          agentId: candidate.agentId,
          fromMemoryId: created.id,
          toMemoryId: previous.id,
          relation,
          direction: relation === "contradicts" ? "undirected" : "directed",
          weight: 1,
          confidence: candidate.confidence,
          provenance: "memory-policy-v1",
        });
      }
    }
    return repository.getMemory(created.id);
  });

  return {
    status: existing.length ? candidate.revisionAction : "created",
    reasons: [],
    candidate,
    memory,
    previous: existing,
  };
}

export function resolveMemoryIngestionReview(repository, {
  agentId,
  decisionId,
  action,
  candidate = null,
  note = "",
  resolvedBy = "human",
  recordedAt = new Date().toISOString(),
} = {}) {
  const normalizedAgentId = clean(agentId);
  const normalizedDecisionId = clean(decisionId);
  const normalizedAction = clean(action);
  if (!normalizedAgentId || !normalizedDecisionId) {
    throw new Error("Resolving a memory review requires agentId and decisionId.");
  }
  if (!["accept", "dismiss"].includes(normalizedAction)) {
    throw new Error(`Unknown memory review action: ${normalizedAction || "(empty)"}.`);
  }
  const decision = repository.getIngestionDecision(normalizedAgentId, normalizedDecisionId);
  if (!decision) throw new Error("Memory review does not exist for this Agent.");
  if (decision.review_state !== "pending") {
    throw new Error(`Memory review is already ${decision.review_state}.`);
  }
  if (normalizedAction === "dismiss") {
    return repository.transaction(() => ({
      status: "dismissed",
      decision: repository.resolveIngestionDecision({
        agentId: normalizedAgentId,
        decisionId: normalizedDecisionId,
        resolution: "dismissed",
        note,
        resolvedBy,
      }),
      memory: null,
      reasons: [],
    }));
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Accepting a memory review requires a corrected candidate object.");
  }
  const sourceIds = Array.isArray(candidate.sourceIds)
    ? candidate.sourceIds
    : decision.sourceIds;
  const evidenceLinks = Array.isArray(candidate.evidenceLinks)
    ? candidate.evidenceLinks
    : sourceIds.map((sourceId) => ({
      sourceId,
      relation: "evidence",
      authority: "manual",
      sourceTrust: 1,
      evidenceStrength: 1,
      provenance: "human-ingestion-review",
    }));
  const reviewedCandidate = {
    ...candidate,
    agentId: normalizedAgentId,
    evidenceMode: "manual",
    knownAt: candidate.knownAt || decision.known_at || null,
    sourceIds,
    evidenceLinks,
    metadata: {
      ...(candidate.metadata && typeof candidate.metadata === "object" ? candidate.metadata : {}),
      ingestionDecisionId: normalizedDecisionId,
      reviewedBy: clean(resolvedBy) || "human",
    },
  };
  return repository.transaction(() => {
    const result = applyMemoryCandidate(repository, reviewedCandidate, {
      agentId: normalizedAgentId,
      recordedAt,
    });
    if (!result.memory) {
      return {
        status: "needs-correction",
        decision: repository.getIngestionDecision(normalizedAgentId, normalizedDecisionId),
        memory: null,
        reasons: result.reasons,
        candidate: result.candidate,
      };
    }
    const resolved = repository.resolveIngestionDecision({
      agentId: normalizedAgentId,
      decisionId: normalizedDecisionId,
      resolution: "accepted",
      memoryId: result.memory.id,
      resolvedCandidate: result.candidate,
      note,
      resolvedBy,
    });
    return {
      status: "accepted",
      decision: resolved,
      memory: result.memory,
      memoryWriteStatus: result.status,
      reasons: [],
    };
  });
}
