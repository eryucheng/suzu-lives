import { createHash, randomUUID } from "node:crypto";

import {
  MEMORY_ACTOR_ROLES,
  MEMORY_STATE_FAMILIES,
  MEMORY_STATE_FAMILY_STORAGE_VALUES,
  MEMORY_STATE_PHASES,
  REPRESENTATION_LAYERS,
  REPORTED_STATE_PROPOSAL_ACTIONS,
  RETRIEVAL_FEEDBACK_SIGNALS,
  SOURCE_AUTHORITIES,
  SUBJECT_ROLES,
  TEMPORAL_STATES,
  isMemoryKindAllowedForStateFamily,
  isReportedStateActionAllowedForFamily,
  isStatefulMemoryKind,
} from "./ontology.mjs";
import {
  NON_STATE_SCOPE_KEY,
  ROOT_STATE_SCOPE_KEY,
  isValidStateScopeKey,
  reportedStateScopeKeyFromDraft,
} from "./state-scope.mjs";
import { normalizeStateAnalysisTargetSpec } from "./state-analysis-target.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function json(value, fallback) {
  return JSON.stringify(value ?? fallback);
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]),
  );
}

function canonicalJson(value, fallback) {
  return JSON.stringify(canonicalJsonValue(value ?? fallback));
}

function canonicalHash(value) {
  return createHash("sha256").update(canonicalJson(value, {})).digest("hex");
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function bounded(value, fallback, minimum = 0, maximum = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function unitInterval(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`${name} must be between 0 and 1.`);
  }
  return number;
}

function cleanStringList(values) {
  return [...new Set(
    (Array.isArray(values) ? values : []).map(clean).filter(Boolean),
  )];
}

function stableId(prefix, ...parts) {
  const hash = createHash("sha256")
    .update(parts.map((part) => clean(part)).join("\u001f"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}-${hash}`;
}

function validIsoDate(value) {
  const text = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function validTimestamp(value) {
  return Number.isFinite(Date.parse(clean(value)));
}

function normalizeTimeWindow(windowStart = "", windowEnd = "") {
  const rawStart = clean(windowStart);
  const rawEnd = clean(windowEnd);
  if (rawStart && !validTimestamp(rawStart)) throw new Error("windowStart is not a valid timestamp.");
  if (rawEnd && !validTimestamp(rawEnd)) throw new Error("windowEnd is not a valid timestamp.");
  const start = rawStart ? new Date(rawStart).toISOString() : "";
  const end = rawEnd ? new Date(rawEnd).toISOString() : "";
  if (start && end && start >= end) throw new Error("windowStart must be before windowEnd.");
  return { start, end };
}

function normalizeNode(row) {
  if (!row) return null;
  return {
    ...row,
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeSource(row) {
  if (!row) return null;
  return {
    ...row,
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeEvidenceSource(row) {
  if (!row) return null;
  return {
    ...normalizeSource(row),
    source_trust: Number(row.source_trust),
    evidence_strength: Number(row.evidence_strength),
    evidenceMetadata: parseJson(row.link_metadata_json, {}),
  };
}

function normalizeMemoryRole(row) {
  if (!row) return null;
  return {
    ...row,
    is_primary: Boolean(row.is_primary),
    confidence: Number(row.confidence),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeEntity(row) {
  if (!row) return null;
  return {
    ...row,
    aliases: parseJson(row.aliases_json, []),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizedEntityName(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function entityNameKey(value) {
  return normalizedEntityName(value).toLocaleLowerCase("zh-CN");
}

function normalizeIngestionDecision(row) {
  if (!row) return null;
  return {
    ...row,
    reasonCodes: parseJson(row.reason_codes_json, []),
    candidate: parseJson(row.candidate_json, {}),
    sourceRefs: parseJson(row.source_refs_json, []),
    sourceIds: parseJson(row.source_ids_json, []),
    resolvedCandidate: parseJson(row.resolved_candidate_json, {}),
  };
}

function normalizeSubjectAttributionProposal(row, sourceIds = []) {
  if (!row) return null;
  return {
    ...row,
    confidence: Number(row.confidence),
    actorRoles: parseJson(row.actor_roles_json, []),
    allowedActors: parseJson(row.allowed_actors_json, []),
    sourceIds,
  };
}

function normalizeStateAnalysisRequest(row, memoryIds = [], sourceIds = []) {
  if (!row) return null;
  return {
    ...row,
    metadata: parseJson(row.metadata_json, {}),
    targetSpec: parseJson(row.target_spec_json, {}),
    memoryIds,
    sourceIds,
  };
}

function normalizeRetrievalTrace(row) {
  if (!row) return null;
  return {
    ...row,
    seedIds: parseJson(row.seed_ids_json, []),
    selectedIds: parseJson(row.selected_ids_json, []),
    paths: parseJson(row.paths_json, []),
    matchedEntityIds: parseJson(row.matched_entity_ids_json, []),
    context_chars: Number(row.context_chars),
    candidate_count: Number(row.candidate_count),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeRetrievalFeedback(row) {
  if (!row) return null;
  return {
    ...row,
    targetMemoryIds: parseJson(row.target_memory_ids_json, []),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeRetrievalUsageRequest(row) {
  if (!row) return null;
  return {
    ...row,
    result: parseJson(row.result_json, {}),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeRetrievalUsageAnalysisRun(row) {
  if (!row) return null;
  return {
    ...row,
    output: parseJson(row.output_json, {}),
    usage: parseJson(row.usage_json, {}),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeAffectiveActivationDecision(row) {
  if (!row) return null;
  return {
    ...row,
    memoryId: clean(row.memory_id),
    policyVersion: clean(row.policy_version),
    enabled: Boolean(row.enabled),
  };
}

function normalizeStructureProposal(row) {
  if (!row) return null;
  return {
    ...row,
    operation: clean(row.operation) || "create",
    targetMemoryId: clean(row.target_memory_id),
    memberIds: parseJson(row.member_ids_json, []),
    actorRoles: parseJson(row.actor_roles_json, []),
    confidence: Number(row.confidence),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeRelationProposal(row, evidence = []) {
  if (!row) return null;
  return {
    ...row,
    weight: Number(row.weight),
    confidence: Number(row.confidence),
    metadata: parseJson(row.metadata_json, {}),
    evidence: evidence.map((item) => ({
      ...normalizeSource(item),
      endpointCoverage: item.endpoint_coverage,
    })),
  };
}

function normalizePreferenceStateProposal(row, evidence = []) {
  if (!row) return null;
  return {
    ...row,
    previousMemoryId: clean(row.previous_memory_id),
    resultMemoryId: clean(row.result_memory_id),
    representationLayer: clean(row.representation_layer) || "inferred",
    stateScopeKey: clean(row.state_scope_key) || ROOT_STATE_SCOPE_KEY,
    scope: parseJson(row.scope_json, {}),
    confidence: Number(row.confidence),
    metrics: parseJson(row.metrics_json, {}),
    metadata: parseJson(row.metadata_json, {}),
    evidence: evidence.map((item) => ({
      memoryId: item.memory_id,
      evidenceGroupId: item.evidence_group_id,
      contextId: item.context_id,
      signal: item.signal,
      direction: item.direction,
      confidence: Number(item.confidence),
      sourceIds: parseJson(item.source_ids_json, []),
      evidenceSnapshotHash: clean(item.evidence_snapshot_hash),
      label: parseJson(item.label_json, {}),
      createdAt: item.created_at,
    })),
  };
}

function normalizeStatePromotionProposal(row) {
  if (!row) return null;
  return {
    ...row,
    sourceMemoryId: clean(row.source_memory_id),
    resultMemoryId: clean(row.result_memory_id),
    stateScopeKey: clean(row.state_scope_key) || ROOT_STATE_SCOPE_KEY,
    confidence: Number(row.confidence),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeStateAnalysisRun(row, memoryIds = [], sourceIds = []) {
  if (!row) return null;
  return {
    ...row,
    memoryIds,
    sourceIds,
    output: parseJson(row.output_json, {}),
    rejected: parseJson(row.rejected_json, []),
    usage: parseJson(row.usage_json, {}),
    costAmount: Number(row.cost_amount),
    durationMs: Number(row.duration_ms),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeStateEvidenceObservation(row, sourceIds = [], analysisRunIds = []) {
  if (!row) return null;
  return {
    ...row,
    sourceIds,
    analysisRunIds,
    supersedesObservationId: clean(row.supersedes_observation_id),
    confidence: Number(row.confidence),
    scope: parseJson(row.scope_json, {}),
    payload: parseJson(row.payload_json, {}),
  };
}

function normalizeReportedStateProposal(row, observations = []) {
  if (!row) return null;
  return {
    ...row,
    previousMemoryId: clean(row.previous_memory_id),
    resultMemoryId: clean(row.result_memory_id),
    targetScopeKey: clean(row.target_scope_key) || ROOT_STATE_SCOPE_KEY,
    proposedScopeKey: clean(row.proposed_scope_key) || ROOT_STATE_SCOPE_KEY,
    draft: parseJson(row.draft_json, {}),
    metadata: parseJson(row.metadata_json, {}),
    selectedObservationId: observations.find((item) => item.evidence_role === "selected")
      ?.observation_id || "",
    consideredObservationIds: [...observations]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((item) => item.observation_id),
  };
}

function normalizeConsolidationRun(row) {
  if (!row) return null;
  return {
    ...row,
    triggerIds: parseJson(row.trigger_ids_json, []),
    candidateIds: parseJson(row.candidate_ids_json, []),
    candidateReasons: parseJson(row.candidate_reasons_json, {}),
    graphEdgeIds: parseJson(row.graph_edge_ids_json, []),
    structureProposalIds: parseJson(row.structure_proposal_ids_json, []),
    relationProposalIds: parseJson(row.relation_proposal_ids_json, []),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeAccessibilityState(row) {
  if (!row) return null;
  return {
    ...row,
    value: Number(row.value),
  };
}

function normalizeEdgeRelationUtilityState(row) {
  if (!row) return null;
  return {
    ...row,
    value: Number(row.value),
  };
}

function normalizePlasticityShadowChange(row) {
  if (!row) return null;
  return {
    ...row,
    blocked: Boolean(row.blocked),
    currentValue: Number(row.current_value),
    decayedValue: Number(row.decayed_value),
    positiveStep: Number(row.positive_step),
    negativeStep: Number(row.negative_step),
    proposedValue: Number(row.proposed_value),
    targetPolicyVersion: row.target_policy_version || "",
    baseState: {
      exists: Boolean(row.base_state_exists),
      value: row.base_state_value === null ? null : Number(row.base_state_value),
      policyVersion: row.base_state_policy_version || "",
      observationWindowId: row.base_state_observation_window_id || "",
      appliedAt: row.base_state_applied_at || null,
    },
    evidence: parseJson(row.evidence_json, {}),
  };
}

function normalizePlasticityShadowRun(row, changes = []) {
  if (!row) return null;
  return {
    ...row,
    candidateCount: Number(row.candidate_count),
    metadata: parseJson(row.metadata_json, {}),
    changes,
  };
}

function normalizePlasticityApplicationChange(row) {
  if (!row) return null;
  return {
    ...row,
    previousExists: Boolean(row.previous_exists),
    previousValue: row.previous_value === null ? null : Number(row.previous_value),
    appliedValue: Number(row.applied_value),
  };
}

function normalizePlasticityApplication(row, changes = []) {
  if (!row) return null;
  return {
    ...row,
    appliedCount: Number(row.applied_count),
    skippedCount: Number(row.skipped_count),
    changes,
  };
}

function sameNumericValue(left, right) {
  return Math.abs(Number(left) - Number(right)) <= 1e-12;
}

function normalizeEdge(row) {
  if (!row) return null;
  return {
    ...row,
    weight: Number(row.weight),
    confidence: Number(row.confidence),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function nodeSnapshot(node) {
  if (!node) return {};
  const {
    metadata_json: _metadataJson,
    ...snapshot
  } = node;
  return snapshot;
}

export class MemoryRepository {
  constructor(database) {
    this.database = database;
    this.transactionDepth = 0;
  }

  transaction(callback) {
    const depth = this.transactionDepth;
    const savepoint = `memory_nested_${depth}`;
    this.database.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    try {
      const result = callback();
      this.transactionDepth -= 1;
      this.database.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      this.transactionDepth -= 1;
      if (depth === 0) {
        this.database.exec("ROLLBACK");
      } else {
        this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      throw error;
    }
  }

  upsertSource({
    id = "",
    agentId,
    sourceKind,
    sourceLocator = "",
    externalId,
    occurredAt = null,
    knownAt = occurredAt,
    recordedAt = nowIso(),
    speaker = "",
    content,
    metadata = {},
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedKind = clean(sourceKind);
    const normalizedExternalId = clean(externalId);
    const normalizedContent = String(content ?? "");
    if (!normalizedAgentId || !normalizedKind || !normalizedExternalId) {
      throw new Error("Source requires agentId, sourceKind, and externalId.");
    }
    if (!normalizedContent.trim()) throw new Error("Source content cannot be empty.");

    const sourceId = clean(id) || stableId(
      "src",
      normalizedAgentId,
      normalizedKind,
      normalizedExternalId,
    );
    const createdAt = nowIso();
    const contentHash = createHash("sha256").update(normalizedContent).digest("hex");
    this.database.prepare(`
      INSERT INTO source_records (
        id, agent_id, source_kind, source_locator, external_id,
        occurred_at, known_at, recorded_at, speaker, content, content_hash,
        metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, source_kind, external_id) DO UPDATE SET
        source_locator = excluded.source_locator,
        occurred_at = excluded.occurred_at,
        known_at = excluded.known_at,
        recorded_at = excluded.recorded_at,
        speaker = excluded.speaker,
        content = excluded.content,
        content_hash = excluded.content_hash,
        metadata_json = excluded.metadata_json
    `).run(
      sourceId,
      normalizedAgentId,
      normalizedKind,
      clean(sourceLocator),
      normalizedExternalId,
      occurredAt || null,
      knownAt || occurredAt || recordedAt,
      recordedAt,
      clean(speaker),
      normalizedContent,
      contentHash,
      json(metadata, {}),
      createdAt,
    );
    return this.getSourceByExternalId(
      normalizedAgentId,
      normalizedKind,
      normalizedExternalId,
    );
  }

  getSource(id) {
    return normalizeSource(
      this.database.prepare("SELECT * FROM source_records WHERE id = ?").get(id),
    );
  }

  getSourceByExternalId(agentId, sourceKind, externalId) {
    return normalizeSource(this.database.prepare(`
      SELECT * FROM source_records
      WHERE agent_id = ? AND source_kind = ? AND external_id = ?
    `).get(agentId, sourceKind, externalId));
  }

  upsertMemory({
    id = "",
    agentId,
    kind,
    layer,
    title = "",
    content,
    subjectRole = "unknown",
    subjectKey = "",
    canonicalKey = "",
    reality = "real",
    evidenceMode = "imported",
    representationLayer = "unspecified",
    stateFamily = "",
    statePhase = "",
    stateScopeKey = "",
    temporalState = "historical",
    revisionAction = "add",
    eventDate = null,
    eventStart = null,
    eventEnd = null,
    knownAt = null,
    validFrom = null,
    validTo = null,
    recordedAt = nowIso(),
    status = "active",
    confidence = 1,
    importance = 0.5,
    perspective = "",
    actorRoles = [],
    metadata = {},
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedKind = clean(kind);
    const normalizedLayer = clean(layer);
    const normalizedContent = String(content ?? "");
    const normalizedRepresentationLayer = clean(representationLayer) || "unspecified";
    const stateful = isStatefulMemoryKind(normalizedKind);
    const normalizedStateFamily = clean(stateFamily)
      || (stateful ? "unspecified" : "not_applicable");
    const normalizedStatePhase = clean(statePhase)
      || (stateful ? "unspecified" : "not_applicable");
    const normalizedStateScopeKey = clean(stateScopeKey)
      || (stateful ? ROOT_STATE_SCOPE_KEY : NON_STATE_SCOPE_KEY);
    if (!normalizedAgentId || !normalizedKind || !normalizedLayer) {
      throw new Error("Memory requires agentId, kind, and layer.");
    }
    if (!normalizedContent.trim()) throw new Error("Memory content cannot be empty.");
    if (!REPRESENTATION_LAYERS.includes(normalizedRepresentationLayer)) {
      throw new Error("Memory representationLayer is invalid.");
    }
    if (!MEMORY_STATE_FAMILY_STORAGE_VALUES.includes(normalizedStateFamily)) {
      throw new Error("Memory stateFamily is invalid.");
    }
    if (!MEMORY_STATE_PHASES.includes(normalizedStatePhase)) {
      throw new Error("Memory statePhase is invalid.");
    }
    if (!isValidStateScopeKey(normalizedStateScopeKey)) {
      throw new Error("Memory stateScopeKey is invalid.");
    }
    if (!stateful && (normalizedStateFamily !== "not_applicable"
      || normalizedStatePhase !== "not_applicable"
      || normalizedStateScopeKey !== NON_STATE_SCOPE_KEY)) {
      throw new Error("Non-state memory cannot carry stateFamily or statePhase or stateScopeKey.");
    }
    if (stateful && normalizedStateFamily === "not_applicable") {
      throw new Error("Stateful memory cannot use a not_applicable stateFamily.");
    }
    if (stateful && normalizedStatePhase === "not_applicable") {
      throw new Error("Stateful memory cannot use a not_applicable statePhase.");
    }
    if (stateful && normalizedStateScopeKey === NON_STATE_SCOPE_KEY) {
      throw new Error("Stateful memory cannot use a not_applicable stateScopeKey.");
    }
    if (stateful && normalizedStateFamily !== "unspecified"
      && !isMemoryKindAllowedForStateFamily(normalizedKind, normalizedStateFamily)) {
      throw new Error(`Memory kind ${normalizedKind} is not allowed for stateFamily ${normalizedStateFamily}.`);
    }

    const memoryId = clean(id) || `mem-${randomUUID()}`;
    const existingMemory = this.getMemory(memoryId);
    if (existingMemory && existingMemory.agent_id !== normalizedAgentId) {
      throw new Error("Memory id already belongs to another Agent.");
    }
    if (existingMemory && existingMemory.state_scope_key !== normalizedStateScopeKey) {
      throw new Error("A memory node cannot change its state scope identity.");
    }
    const timestamp = nowIso();
    this.database.prepare(`
      INSERT INTO memory_nodes (
        id, agent_id, kind, layer, title, content, event_date, event_start, event_end,
        known_at, recorded_at, status, confidence, importance, perspective,
        metadata_json, created_at, updated_at, subject_role, subject_key,
        canonical_key, reality, evidence_mode, representation_layer, state_family, state_phase,
        state_scope_key,
        temporal_state, revision_action,
        valid_from, valid_to
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        layer = excluded.layer,
        title = excluded.title,
        content = excluded.content,
        event_date = excluded.event_date,
        event_start = excluded.event_start,
        event_end = excluded.event_end,
        known_at = excluded.known_at,
        recorded_at = excluded.recorded_at,
        status = excluded.status,
        confidence = excluded.confidence,
        importance = excluded.importance,
        perspective = excluded.perspective,
        metadata_json = excluded.metadata_json,
        subject_role = excluded.subject_role,
        subject_key = excluded.subject_key,
        canonical_key = excluded.canonical_key,
        reality = excluded.reality,
        evidence_mode = excluded.evidence_mode,
        representation_layer = excluded.representation_layer,
        state_family = excluded.state_family,
        state_phase = excluded.state_phase,
        state_scope_key = excluded.state_scope_key,
        temporal_state = excluded.temporal_state,
        revision_action = excluded.revision_action,
        valid_from = excluded.valid_from,
        valid_to = excluded.valid_to,
        updated_at = excluded.updated_at
    `).run(
      memoryId,
      normalizedAgentId,
      normalizedKind,
      normalizedLayer,
      clean(title),
      normalizedContent,
      eventDate || null,
      eventStart || null,
      eventEnd || null,
      knownAt || recordedAt,
      recordedAt,
      status,
      bounded(confidence, 1),
      bounded(importance, 0.5),
      clean(perspective),
      json(metadata, {}),
      timestamp,
      timestamp,
      clean(subjectRole) || "unknown",
      clean(subjectKey),
      clean(canonicalKey),
      clean(reality) || "real",
      clean(evidenceMode) || "imported",
      normalizedRepresentationLayer,
      normalizedStateFamily,
      normalizedStatePhase,
      normalizedStateScopeKey,
      clean(temporalState) || "historical",
      clean(revisionAction) || "add",
      validFrom || null,
      validTo || null,
    );
    this.syncPrimarySubjectRole({
      memoryId,
      agentId: normalizedAgentId,
      actorRole: clean(subjectRole) || "unknown",
      actorKey: clean(subjectKey),
    });
    for (const role of Array.isArray(actorRoles) ? actorRoles : []) {
      this.upsertMemoryRole({
        memoryId,
        agentId: normalizedAgentId,
        ...role,
      });
    }
    this.syncSearch(memoryId);
    return this.getMemory(memoryId);
  }

  getMemory(id) {
    return normalizeNode(
      this.database.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(id),
    );
  }

  upsertEpisode({
    agentId,
    eventDate = null,
    eventStart = null,
    eventEnd = null,
    evidenceMode = "manual",
    temporalState = eventEnd ? "completed" : "historical",
    ...memory
  }) {
    const normalizedDate = clean(eventDate);
    const normalizedStart = clean(eventStart);
    const normalizedEnd = clean(eventEnd);
    if (!normalizedDate && !normalizedStart) {
      throw new Error("Episode requires eventDate or eventStart.");
    }
    if (normalizedDate && !validIsoDate(normalizedDate)) {
      throw new Error("Episode eventDate must be a valid YYYY-MM-DD date.");
    }
    if (normalizedStart && !validTimestamp(normalizedStart)) {
      throw new Error("Episode eventStart must be a valid timestamp.");
    }
    if (normalizedEnd && !validTimestamp(normalizedEnd)) {
      throw new Error("Episode eventEnd must be a valid timestamp.");
    }
    if (normalizedEnd && !normalizedStart) {
      throw new Error("Episode eventEnd requires eventStart.");
    }
    if (normalizedStart && normalizedEnd && Date.parse(normalizedEnd) < Date.parse(normalizedStart)) {
      throw new Error("Episode eventEnd cannot be before eventStart.");
    }
    return this.upsertMemory({
      ...memory,
      agentId,
      kind: "episode",
      layer: "episodic",
      eventDate: normalizedDate || null,
      eventStart: normalizedStart || null,
      eventEnd: normalizedEnd || null,
      evidenceMode: clean(evidenceMode) || "manual",
      temporalState: clean(temporalState) || "historical",
    });
  }

  upsertTopic({
    agentId,
    eventDate = null,
    eventStart = null,
    eventEnd = null,
    evidenceMode = "manual",
    temporalState = "timeless",
    ...memory
  }) {
    if (clean(eventDate) || clean(eventStart) || clean(eventEnd)) {
      throw new Error("Topic cannot carry event time; link time-bearing memories instead.");
    }
    return this.upsertMemory({
      ...memory,
      agentId,
      kind: "topic",
      layer: "semantic",
      eventDate: null,
      eventStart: null,
      eventEnd: null,
      evidenceMode: clean(evidenceMode) || "manual",
      temporalState: clean(temporalState) || "timeless",
    });
  }

  linkMemoryToEpisode({
    agentId,
    memoryId,
    episodeId,
    weight = 0.95,
    confidence = 1,
    provenance = "manual-structure",
    metadata = {},
  }) {
    return this.linkMemoryContainer({
      agentId,
      memoryId,
      containerId: episodeId,
      containerKind: "episode",
      relation: "part_of_episode",
      weight,
      confidence,
      provenance,
      metadata,
    });
  }

  linkMemoryToTopic({
    agentId,
    memoryId,
    topicId,
    weight = 0.9,
    confidence = 1,
    provenance = "manual-structure",
    metadata = {},
  }) {
    return this.linkMemoryContainer({
      agentId,
      memoryId,
      containerId: topicId,
      containerKind: "topic",
      relation: "supports_topic",
      weight,
      confidence,
      provenance,
      metadata,
    });
  }

  linkMemoryContainer({
    agentId,
    memoryId,
    containerId,
    containerKind,
    relation,
    weight,
    confidence,
    provenance,
    metadata,
  }) {
    const normalizedAgentId = clean(agentId);
    const source = this.getMemory(clean(memoryId));
    const container = this.getMemory(clean(containerId));
    if (!normalizedAgentId || !source || source.agent_id !== normalizedAgentId) {
      throw new Error("Membership source must exist for this Agent.");
    }
    if (!container || container.agent_id !== normalizedAgentId) {
      throw new Error("Membership target must exist for this Agent.");
    }
    if (source.status === "deleted" || container.status === "deleted") {
      throw new Error("Deleted memories cannot participate in active membership.");
    }
    if (container.kind !== containerKind) {
      throw new Error(`Membership target must be a ${containerKind} node.`);
    }
    if (containerKind === "episode" && ["episode", "topic", "topic_or_episode"].includes(source.kind)) {
      throw new Error("Only concrete memories can be members of an episode.");
    }
    if (containerKind === "topic" && ["topic", "topic_or_episode"].includes(source.kind)) {
      throw new Error("A topic cannot support another topic in the current model.");
    }
    return this.upsertEdge({
      agentId: normalizedAgentId,
      fromMemoryId: source.id,
      toMemoryId: container.id,
      relation,
      direction: "directed",
      weight,
      confidence,
      provenance,
      metadata,
    });
  }

  listEpisodeMembers({ agentId, episodeId, statuses = ["active"] }) {
    return this.listContainerMembers({
      agentId,
      containerId: episodeId,
      containerKind: "episode",
      relation: "part_of_episode",
      statuses,
    });
  }

  listTopicMembers({ agentId, topicId, statuses = ["active"] }) {
    return this.listContainerMembers({
      agentId,
      containerId: topicId,
      containerKind: "topic",
      relation: "supports_topic",
      statuses,
    });
  }

  expandEpisodeToMemories({ agentId, episodeId, memoryIds = [] }) {
    const normalizedAgentId = clean(agentId);
    const episode = this.getMemory(clean(episodeId));
    if (!normalizedAgentId || !episode || episode.agent_id !== normalizedAgentId) {
      throw new Error("Episode expansion target must exist for this Agent.");
    }
    if (episode.kind !== "episode" || episode.status === "deleted") {
      throw new Error("Episode expansion target must be a non-deleted episode.");
    }
    const members = cleanStringList(memoryIds).map((id) => this.getMemory(id));
    if (members.some((memory) => !memory || memory.agent_id !== normalizedAgentId)) {
      throw new Error("Episode expansion members must exist for the same Agent.");
    }
    if (members.some((memory) => (
      memory.status === "deleted"
      || ["episode", "topic", "topic_or_episode"].includes(memory.kind)
    ))) {
      throw new Error("Episode expansion accepts only non-deleted concrete memories.");
    }

    const memories = [episode, ...members];
    const exactStarts = memories.map((memory) => clean(memory.event_start)).filter(validTimestamp);
    const exactEnds = memories.flatMap((memory) => [memory.event_end, memory.event_start])
      .map(clean)
      .filter(validTimestamp);
    const calendarDates = memories.flatMap((memory) => [
      clean(memory.event_date),
      validTimestamp(memory.event_start) ? new Date(memory.event_start).toISOString().slice(0, 10) : "",
      validTimestamp(memory.event_end) ? new Date(memory.event_end).toISOString().slice(0, 10) : "",
    ]).filter(validIsoDate);
    const eventDate = calendarDates.sort()[0] || null;
    const eventStart = exactStarts.sort()[0] || null;
    const latestExact = exactEnds.sort().at(-1) || null;
    const eventEnd = eventStart && latestExact && Date.parse(latestExact) > Date.parse(eventStart)
      ? latestExact
      : clean(episode.event_end) || null;
    if (eventStart && eventEnd && Date.parse(eventEnd) < Date.parse(eventStart)) {
      throw new Error("Expanded episode boundary is invalid.");
    }

    this.database.prepare(`
      UPDATE memory_nodes
      SET event_date = ?, event_start = ?, event_end = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND kind = 'episode' AND status <> 'deleted'
    `).run(
      eventDate,
      eventStart,
      eventEnd,
      nowIso(),
      normalizedAgentId,
      episode.id,
    );
    return this.getMemory(episode.id);
  }

  listContainerMembers({
    agentId,
    containerId,
    containerKind,
    relation,
    statuses = ["active"],
  }) {
    const normalizedAgentId = clean(agentId);
    const container = this.getMemory(clean(containerId));
    if (!normalizedAgentId || !container || container.agent_id !== normalizedAgentId) {
      throw new Error("Membership target must exist for this Agent.");
    }
    if (container.kind !== containerKind) {
      throw new Error(`Membership target must be a ${containerKind} node.`);
    }
    const normalizedStatuses = [...new Set(
      (Array.isArray(statuses) ? statuses : [statuses]).map(clean).filter(Boolean),
    )];
    if (!normalizedStatuses.length) return [];
    const edges = this.database.prepare(`
      SELECT edge.*
      FROM memory_edges AS edge
      JOIN memory_nodes AS member ON member.id = edge.from_memory_id
      WHERE edge.agent_id = ? AND edge.to_memory_id = ? AND edge.relation = ?
        AND member.agent_id = ?
        AND member.status IN (${normalizedStatuses.map(() => "?").join(", ")})
      ORDER BY COALESCE(member.event_start, member.event_date, member.recorded_at) ASC,
        member.id ASC
    `).all(
      normalizedAgentId,
      container.id,
      relation,
      normalizedAgentId,
      ...normalizedStatuses,
    ).map(normalizeEdge);
    return edges.map((edge) => ({
      ...this.getMemory(edge.from_memory_id),
      membership: edge,
    }));
  }

  unlinkMemoryFromEpisode({ agentId, memoryId, episodeId }) {
    return this.unlinkMemoryContainer({
      agentId,
      memoryId,
      containerId: episodeId,
      relation: "part_of_episode",
    });
  }

  unlinkMemoryFromTopic({ agentId, memoryId, topicId }) {
    return this.unlinkMemoryContainer({
      agentId,
      memoryId,
      containerId: topicId,
      relation: "supports_topic",
    });
  }

  unlinkMemoryContainer({ agentId, memoryId, containerId, relation }) {
    return Number(this.database.prepare(`
      DELETE FROM memory_edges
      WHERE agent_id = ? AND from_memory_id = ? AND to_memory_id = ? AND relation = ?
    `).run(
      clean(agentId),
      clean(memoryId),
      clean(containerId),
      clean(relation),
    ).changes || 0);
  }

  recordStructureProposal({
    id,
    agentId,
    batchId = "",
    operation = "create",
    targetMemoryId = null,
    kind,
    title = "",
    content,
    subjectRole = "unknown",
    subjectKey = "",
    eventDate = null,
    eventStart = null,
    eventEnd = null,
    memberIds = [],
    actorRoles = [],
    confidence = 0.5,
    rationale = "",
    provenance = "",
    proposalHash,
    metadata = {},
    createdAt = nowIso(),
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedOperation = clean(operation) || "create";
    const normalizedTargetMemoryId = clean(targetMemoryId) || null;
    const normalizedKind = clean(kind);
    const normalizedContent = clean(content);
    const normalizedProposalHash = clean(proposalHash);
    const proposalId = clean(id);
    if (
      !proposalId
      || !normalizedAgentId
      || !["create", "attach"].includes(normalizedOperation)
      || !["episode", "topic"].includes(normalizedKind)
      || !normalizedContent
      || !normalizedProposalHash
    ) {
      throw new Error("Structure proposal record is incomplete.");
    }
    const idOwner = this.database.prepare(`
      SELECT agent_id FROM memory_structure_proposals WHERE id = ?
    `).get(proposalId);
    if (idOwner && idOwner.agent_id !== normalizedAgentId) {
      throw new Error("Structure proposal id already belongs to another Agent.");
    }
    const timestamp = clean(createdAt) || nowIso();
    const insertion = this.database.prepare(`
      INSERT INTO memory_structure_proposals (
        id, agent_id, batch_id, operation, target_memory_id, kind, title, content,
        subject_role, subject_key, event_date, event_start, event_end,
        member_ids_json, actor_roles_json, confidence, rationale, provenance,
        proposal_hash, review_state, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      ON CONFLICT(agent_id, proposal_hash) DO NOTHING
    `).run(
      proposalId,
      normalizedAgentId,
      clean(batchId),
      normalizedOperation,
      normalizedTargetMemoryId,
      normalizedKind,
      clean(title),
      normalizedContent,
      clean(subjectRole) || "unknown",
      clean(subjectKey),
      clean(eventDate) || null,
      clean(eventStart) || null,
      clean(eventEnd) || null,
      json(memberIds, []),
      json(actorRoles, []),
      bounded(confidence, 0.5),
      clean(rationale),
      clean(provenance),
      normalizedProposalHash,
      json(metadata, {}),
      timestamp,
      timestamp,
    );
    const proposal = normalizeStructureProposal(this.database.prepare(`
      SELECT * FROM memory_structure_proposals
      WHERE agent_id = ? AND proposal_hash = ?
    `).get(normalizedAgentId, normalizedProposalHash));
    return {
      ...proposal,
      wasInserted: Number(insertion.changes || 0) === 1,
    };
  }

  getStructureProposal(agentId, proposalId) {
    return normalizeStructureProposal(this.database.prepare(`
      SELECT * FROM memory_structure_proposals WHERE agent_id = ? AND id = ?
    `).get(clean(agentId), clean(proposalId)));
  }

  listStructureProposals(agentId, {
    reviewStates = [],
    batchId = "",
    limit = 100,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listStructureProposals requires agentId.");
    const states = [...new Set(
      (Array.isArray(reviewStates) ? reviewStates : [reviewStates]).map(clean).filter(Boolean),
    )];
    if (states.some((state) => !["pending", "accepted", "dismissed"].includes(state))) {
      throw new Error("Unknown structure proposal review state.");
    }
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (states.length) {
      clauses.push(`review_state IN (${states.map(() => "?").join(", ")})`);
      parameters.push(...states);
    }
    if (clean(batchId)) {
      clauses.push("batch_id = ?");
      parameters.push(clean(batchId));
    }
    return this.database.prepare(`
      SELECT * FROM memory_structure_proposals
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(
      ...parameters,
      Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100))),
    ).map(normalizeStructureProposal);
  }

  resolveStructureProposal({
    agentId,
    proposalId,
    resolution,
    resultMemoryId = null,
    resolvedBy = "human",
    note = "",
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedResolution = clean(resolution);
    const proposal = this.getStructureProposal(normalizedAgentId, proposalId);
    if (!proposal) throw new Error("Structure proposal does not exist for this Agent.");
    if (proposal.review_state !== "pending") {
      throw new Error(`Structure proposal is already ${proposal.review_state}.`);
    }
    if (!["accepted", "dismissed"].includes(normalizedResolution)) {
      throw new Error(`Unknown structure proposal resolution: ${normalizedResolution || "(empty)"}.`);
    }
    const normalizedMemoryId = clean(resultMemoryId) || null;
    if (normalizedResolution === "accepted") {
      const memory = this.getMemory(normalizedMemoryId);
      if (!memory || memory.agent_id !== normalizedAgentId || memory.kind !== proposal.kind) {
        throw new Error("Accepted structure proposal requires a matching result memory.");
      }
    } else if (normalizedMemoryId) {
      throw new Error("Dismissed structure proposal cannot reference a result memory.");
    }
    const resolvedAt = nowIso();
    const resolutionResult = this.database.prepare(`
      UPDATE memory_structure_proposals
      SET review_state = ?, result_memory_id = ?, resolution_note = ?, resolved_by = ?,
          resolved_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND review_state = 'pending'
    `).run(
      normalizedResolution,
      normalizedMemoryId,
      clean(note),
      clean(resolvedBy) || "human",
      resolvedAt,
      resolvedAt,
      normalizedAgentId,
      proposal.id,
    );
    if (Number(resolutionResult.changes || 0) !== 1) {
      throw new Error("Structure proposal changed while it was being resolved.");
    }
    return this.getStructureProposal(normalizedAgentId, proposal.id);
  }

  recordRelationProposal({
    id,
    agentId,
    batchId = "",
    relation,
    fromMemoryId,
    toMemoryId,
    weight = 0.5,
    confidence = 0.5,
    rationale = "",
    provenance = "",
    proposalHash,
    evidence = [],
    metadata = {},
    createdAt = nowIso(),
  }) {
    const proposalId = clean(id);
    const normalizedAgentId = clean(agentId);
    const normalizedRelation = clean(relation);
    const normalizedFromMemoryId = clean(fromMemoryId);
    const normalizedToMemoryId = clean(toMemoryId);
    const normalizedProposalHash = clean(proposalHash);
    if (
      !proposalId
      || !normalizedAgentId
      || normalizedRelation !== "causes"
      || !normalizedFromMemoryId
      || !normalizedToMemoryId
      || normalizedFromMemoryId === normalizedToMemoryId
      || !normalizedProposalHash
    ) {
      throw new Error("Relation proposal record is incomplete.");
    }
    const endpoints = this.database.prepare(`
      SELECT id FROM memory_nodes
      WHERE agent_id = ? AND id IN (?, ?) AND status <> 'deleted'
    `).all(normalizedAgentId, normalizedFromMemoryId, normalizedToMemoryId);
    if (endpoints.length !== 2) {
      throw new Error("Relation proposal endpoints must exist for the same Agent.");
    }
    const normalizedEvidence = (Array.isArray(evidence) ? evidence : []).map((item) => ({
      sourceId: clean(item?.sourceId ?? item?.source_id),
      endpointCoverage: clean(item?.endpointCoverage ?? item?.endpoint_coverage),
    }));
    if (!normalizedEvidence.length
      || normalizedEvidence.some((item) => (
        !item.sourceId || !["from", "to", "both"].includes(item.endpointCoverage)
      ))) {
      throw new Error("Relation proposal requires validated source evidence.");
    }
    const uniqueEvidence = new Map();
    for (const item of normalizedEvidence) uniqueEvidence.set(item.sourceId, item);
    const sources = this.database.prepare(`
      SELECT id FROM source_records
      WHERE agent_id = ? AND id IN (${[...uniqueEvidence].map(() => "?").join(", ")})
    `).all(normalizedAgentId, ...uniqueEvidence.keys());
    if (sources.length !== uniqueEvidence.size) {
      throw new Error("Relation proposal evidence must belong to the same Agent.");
    }
    const idOwner = this.database.prepare(`
      SELECT agent_id FROM memory_relation_proposals WHERE id = ?
    `).get(proposalId);
    if (idOwner && idOwner.agent_id !== normalizedAgentId) {
      throw new Error("Relation proposal id already belongs to another Agent.");
    }
    const timestamp = clean(createdAt) || nowIso();
    return this.transaction(() => {
      const insertion = this.database.prepare(`
        INSERT INTO memory_relation_proposals (
          id, agent_id, batch_id, relation, from_memory_id, to_memory_id,
          direction, weight, confidence, rationale, provenance, proposal_hash,
          review_state, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'directed', ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        ON CONFLICT(agent_id, proposal_hash) DO NOTHING
      `).run(
        proposalId,
        normalizedAgentId,
        clean(batchId),
        normalizedRelation,
        normalizedFromMemoryId,
        normalizedToMemoryId,
        bounded(weight, 0.5),
        bounded(confidence, 0.5),
        clean(rationale),
        clean(provenance),
        normalizedProposalHash,
        json(metadata, {}),
        timestamp,
        timestamp,
      );
      const stored = this.database.prepare(`
        SELECT id FROM memory_relation_proposals
        WHERE agent_id = ? AND proposal_hash = ?
      `).get(normalizedAgentId, normalizedProposalHash);
      if (Number(insertion.changes || 0) === 1) {
        const insertEvidence = this.database.prepare(`
          INSERT INTO memory_relation_proposal_evidence (
            proposal_id, agent_id, source_id, endpoint_coverage, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `);
        for (const item of uniqueEvidence.values()) {
          insertEvidence.run(
            stored.id,
            normalizedAgentId,
            item.sourceId,
            item.endpointCoverage,
            timestamp,
          );
        }
      }
      return {
        ...this.getRelationProposal(normalizedAgentId, stored.id),
        wasInserted: Number(insertion.changes || 0) === 1,
      };
    });
  }

  getRelationProposal(agentId, proposalId) {
    const normalizedAgentId = clean(agentId);
    const row = this.database.prepare(`
      SELECT * FROM memory_relation_proposals WHERE agent_id = ? AND id = ?
    `).get(normalizedAgentId, clean(proposalId));
    if (!row) return null;
    const evidence = this.database.prepare(`
      SELECT source.*, evidence.endpoint_coverage
      FROM memory_relation_proposal_evidence AS evidence
      JOIN source_records AS source ON source.id = evidence.source_id
      WHERE evidence.agent_id = ? AND evidence.proposal_id = ?
      ORDER BY source.occurred_at ASC, source.recorded_at ASC, source.id ASC
    `).all(normalizedAgentId, row.id);
    return normalizeRelationProposal(row, evidence);
  }

  listRelationProposals(agentId, {
    reviewStates = [],
    batchId = "",
    limit = 100,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listRelationProposals requires agentId.");
    const states = cleanStringList(Array.isArray(reviewStates) ? reviewStates : [reviewStates]);
    if (states.some((state) => !["pending", "accepted", "dismissed", "revoked"].includes(state))) {
      throw new Error("Unknown relation proposal review state.");
    }
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (states.length) {
      clauses.push(`review_state IN (${states.map(() => "?").join(", ")})`);
      parameters.push(...states);
    }
    if (clean(batchId)) {
      clauses.push("batch_id = ?");
      parameters.push(clean(batchId));
    }
    const rows = this.database.prepare(`
      SELECT id FROM memory_relation_proposals
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(
      ...parameters,
      Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100))),
    );
    return rows.map((row) => this.getRelationProposal(normalizedAgentId, row.id));
  }

  resolveRelationProposal({
    agentId,
    proposalId,
    resolution,
    resultEdgeId = null,
    resultEdgeUpdatedAt = null,
    resolvedBy = "human",
    note = "",
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedResolution = clean(resolution);
    const proposal = this.getRelationProposal(normalizedAgentId, proposalId);
    if (!proposal) throw new Error("Relation proposal does not exist for this Agent.");
    if (proposal.review_state !== "pending") {
      throw new Error(`Relation proposal is already ${proposal.review_state}.`);
    }
    if (!["accepted", "dismissed"].includes(normalizedResolution)) {
      throw new Error(`Unknown relation proposal resolution: ${normalizedResolution || "(empty)"}.`);
    }
    const normalizedEdgeId = clean(resultEdgeId) || null;
    const normalizedEdgeUpdatedAt = clean(resultEdgeUpdatedAt) || null;
    if (normalizedResolution === "accepted") {
      const edge = normalizedEdgeId ? this.getEdge(normalizedAgentId, normalizedEdgeId) : null;
      if (!edge
        || edge.from_memory_id !== proposal.from_memory_id
        || edge.to_memory_id !== proposal.to_memory_id
        || edge.relation !== proposal.relation
        || edge.updated_at !== normalizedEdgeUpdatedAt) {
        throw new Error("Accepted relation proposal requires the exact resulting edge version.");
      }
    } else if (normalizedEdgeId || normalizedEdgeUpdatedAt) {
      throw new Error("Dismissed relation proposal cannot reference a result edge.");
    }
    const resolvedAt = nowIso();
    const result = this.database.prepare(`
      UPDATE memory_relation_proposals
      SET review_state = ?, result_edge_id = ?, result_edge_updated_at = ?,
          resolution_note = ?, resolved_by = ?, resolved_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND review_state = 'pending'
    `).run(
      normalizedResolution,
      normalizedEdgeId,
      normalizedEdgeUpdatedAt,
      clean(note),
      clean(resolvedBy) || "human",
      resolvedAt,
      resolvedAt,
      normalizedAgentId,
      proposal.id,
    );
    if (Number(result.changes || 0) !== 1) {
      throw new Error("Relation proposal changed while it was being resolved.");
    }
    return this.getRelationProposal(normalizedAgentId, proposal.id);
  }

  revokeRelationProposal({
    agentId,
    proposalId,
    revokedBy = "human",
    note = "",
  }) {
    const normalizedAgentId = clean(agentId);
    const proposal = this.getRelationProposal(normalizedAgentId, proposalId);
    if (!proposal) throw new Error("Relation proposal does not exist for this Agent.");
    if (proposal.review_state !== "accepted") {
      throw new Error(`Only an accepted relation proposal can be revoked; it is ${proposal.review_state}.`);
    }
    const edge = this.getEdge(normalizedAgentId, proposal.result_edge_id);
    if (!edge || edge.updated_at !== proposal.result_edge_updated_at) {
      throw new Error("Accepted relation edge has changed and cannot be revoked safely.");
    }
    const revokedAt = nowIso();
    return this.transaction(() => {
      const deletion = this.database.prepare(`
        DELETE FROM memory_edges
        WHERE agent_id = ? AND id = ? AND updated_at = ?
      `).run(normalizedAgentId, edge.id, proposal.result_edge_updated_at);
      if (Number(deletion.changes || 0) !== 1) {
        throw new Error("Accepted relation edge changed while it was being revoked.");
      }
      const update = this.database.prepare(`
        UPDATE memory_relation_proposals
        SET review_state = 'revoked', revoked_by = ?, revocation_note = ?,
            revoked_at = ?, updated_at = ?
        WHERE agent_id = ? AND id = ? AND review_state = 'accepted'
      `).run(
        clean(revokedBy) || "human",
        clean(note),
        revokedAt,
        revokedAt,
        normalizedAgentId,
        proposal.id,
      );
      if (Number(update.changes || 0) !== 1) {
        throw new Error("Relation proposal changed while it was being revoked.");
      }
      return this.getRelationProposal(normalizedAgentId, proposal.id);
    });
  }

  recordStateAnalysisRequest({
    id = "",
    agentId,
    batchId,
    candidateIndex,
    stateFamily,
    subjectRole,
    subjectKey,
    canonicalKey,
    targetLabel,
    targetSpec = {},
    representationLayer,
    evidenceMode,
    memoryIds = [],
    sourceIds = [],
    status = "pending",
    metadata = {},
    createdAt = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedBatchId = clean(batchId);
    const normalizedCandidateIndex = Number(candidateIndex);
    const normalizedFamily = clean(stateFamily);
    const normalizedSubjectRole = clean(subjectRole);
    const normalizedSubjectKey = clean(subjectKey);
    const normalizedCanonicalKey = clean(canonicalKey).toLocaleLowerCase("en-US");
    const normalizedTargetLabel = clean(targetLabel);
    const normalizedTargetSpec = normalizeStateAnalysisTargetSpec(
      normalizedFamily,
      targetSpec,
      { allowEmpty: true },
    );
    const normalizedLayer = clean(representationLayer);
    const normalizedEvidenceMode = clean(evidenceMode);
    const normalizedStatus = clean(status);
    const normalizedMemoryIds = cleanStringList(memoryIds);
    const normalizedSourceIds = cleanStringList(sourceIds);
    const timestamp = clean(createdAt);
    if (!normalizedAgentId || !normalizedBatchId
      || !Number.isInteger(normalizedCandidateIndex) || normalizedCandidateIndex < 0
      || !MEMORY_STATE_FAMILIES.includes(normalizedFamily)
      || !["user", "agent", "shared", "other"].includes(normalizedSubjectRole)
      || !normalizedSubjectKey || !normalizedCanonicalKey || !normalizedTargetLabel
      || !["reported", "inferred"].includes(normalizedLayer)
      || !["explicit", "observed", "inferred"].includes(normalizedEvidenceMode)
      || !["pending", "blocked"].includes(normalizedStatus)
      || !normalizedMemoryIds.length || !normalizedSourceIds.length
      || !validTimestamp(timestamp)) {
      throw new Error("State analysis request is incomplete.");
    }
    if ((normalizedEvidenceMode === "explicit") !== (normalizedLayer === "reported")) {
      throw new Error("State analysis request representation layer does not match its evidence mode.");
    }
    for (const memoryId of normalizedMemoryIds) {
      const memory = this.getMemory(memoryId);
      if (!memory || memory.agent_id !== normalizedAgentId || memory.status === "deleted") {
        throw new Error("State analysis request memory must belong to the same Agent and be available.");
      }
    }
    const linkedSources = new Set(this.database.prepare(`
      SELECT DISTINCT source_id FROM memory_sources
      WHERE memory_id IN (${normalizedMemoryIds.map(() => "?").join(", ")})
    `).all(...normalizedMemoryIds).map((row) => row.source_id));
    if (normalizedSourceIds.some((sourceId) => !linkedSources.has(sourceId))) {
      throw new Error("State analysis request source must support one of its input memories.");
    }
    const inputHash = canonicalHash({
      agentId: normalizedAgentId,
      stateFamily: normalizedFamily,
      subjectRole: normalizedSubjectRole,
      subjectKey: normalizedSubjectKey,
      canonicalKey: normalizedCanonicalKey,
      targetLabel: normalizedTargetLabel,
      targetSpec: normalizedTargetSpec,
      representationLayer: normalizedLayer,
      evidenceMode: normalizedEvidenceMode,
      memoryIds: [...normalizedMemoryIds].sort(),
      sourceIds: [...normalizedSourceIds].sort(),
    });
    const existingByInput = this.database.prepare(`
      SELECT id FROM memory_state_analysis_requests
      WHERE agent_id = ? AND input_hash = ?
    `).get(normalizedAgentId, inputHash);
    if (existingByInput) {
      return { ...this.getStateAnalysisRequest(normalizedAgentId, existingByInput.id), wasInserted: false };
    }
    const existingAtCandidate = this.database.prepare(`
      SELECT id, input_hash FROM memory_state_analysis_requests
      WHERE agent_id = ? AND batch_id = ? AND candidate_index = ?
    `).get(normalizedAgentId, normalizedBatchId, normalizedCandidateIndex);
    if (existingAtCandidate) {
      const existing = this.getStateAnalysisRequest(normalizedAgentId, existingAtCandidate.id);
      const sameRequest = existing
        && existing.state_family === normalizedFamily
        && existing.subject_role === normalizedSubjectRole
        && existing.subject_key === normalizedSubjectKey
        && existing.canonical_key === normalizedCanonicalKey
        && existing.target_label === normalizedTargetLabel
        && canonicalJson(existing.targetSpec, {}) === canonicalJson(normalizedTargetSpec, {})
        && existing.representation_layer === normalizedLayer
        && existing.evidence_mode === normalizedEvidenceMode
        && canonicalJson([...existing.memoryIds].sort(), [])
          === canonicalJson([...normalizedMemoryIds].sort(), [])
        && canonicalJson([...existing.sourceIds].sort(), [])
          === canonicalJson([...normalizedSourceIds].sort(), []);
      if (sameRequest) return { ...existing, wasInserted: false };
      throw new Error("State analysis request candidate already exists with different contents.");
    }
    const requestId = clean(id) || stableId(
      "state-request",
      normalizedAgentId,
      normalizedBatchId,
      normalizedCandidateIndex,
    );
    const owner = this.database.prepare(`
      SELECT agent_id FROM memory_state_analysis_requests WHERE id = ?
    `).get(requestId);
    if (owner && owner.agent_id !== normalizedAgentId) {
      throw new Error("State analysis request id already belongs to another Agent.");
    }
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO memory_state_analysis_requests (
          id, agent_id, batch_id, candidate_index, state_family,
          subject_role, subject_key, canonical_key, target_label,
          target_spec_json,
          representation_layer, evidence_mode, status, input_hash,
          metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        requestId,
        normalizedAgentId,
        normalizedBatchId,
        normalizedCandidateIndex,
        normalizedFamily,
        normalizedSubjectRole,
        normalizedSubjectKey,
        normalizedCanonicalKey,
        normalizedTargetLabel,
        canonicalJson(normalizedTargetSpec, {}),
        normalizedLayer,
        normalizedEvidenceMode,
        normalizedStatus,
        inputHash,
        canonicalJson(metadata, {}),
        new Date(timestamp).toISOString(),
        new Date(timestamp).toISOString(),
      );
      const insertMemory = this.database.prepare(`
        INSERT INTO memory_state_analysis_request_memories (
          request_id, agent_id, memory_id, ordinal
        ) VALUES (?, ?, ?, ?)
      `);
      normalizedMemoryIds.forEach((memoryId, ordinal) => {
        insertMemory.run(requestId, normalizedAgentId, memoryId, ordinal);
      });
      const insertSource = this.database.prepare(`
        INSERT INTO memory_state_analysis_request_sources (
          request_id, agent_id, source_id, ordinal
        ) VALUES (?, ?, ?, ?)
      `);
      normalizedSourceIds.forEach((sourceId, ordinal) => {
        insertSource.run(requestId, normalizedAgentId, sourceId, ordinal);
      });
      return { ...this.getStateAnalysisRequest(normalizedAgentId, requestId), wasInserted: true };
    });
  }

  getStateAnalysisRequest(agentId, requestId) {
    const normalizedAgentId = clean(agentId);
    const normalizedRequestId = clean(requestId);
    const row = this.database.prepare(`
      SELECT * FROM memory_state_analysis_requests WHERE agent_id = ? AND id = ?
    `).get(normalizedAgentId, normalizedRequestId);
    if (!row) return null;
    const memoryIds = this.database.prepare(`
      SELECT memory_id FROM memory_state_analysis_request_memories
      WHERE agent_id = ? AND request_id = ? ORDER BY ordinal ASC
    `).all(normalizedAgentId, normalizedRequestId).map((item) => item.memory_id);
    const sourceIds = this.database.prepare(`
      SELECT source_id FROM memory_state_analysis_request_sources
      WHERE agent_id = ? AND request_id = ? ORDER BY ordinal ASC
    `).all(normalizedAgentId, normalizedRequestId).map((item) => item.source_id);
    return normalizeStateAnalysisRequest(row, memoryIds, sourceIds);
  }

  listStateAnalysisRequests(agentId, {
    statuses = [],
    stateFamily = "",
    stateFamilies = [],
    representationLayer = "",
    evidenceMode = "",
    batchId = "",
    limit = 100,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listStateAnalysisRequests requires agentId.");
    const normalizedStatuses = cleanStringList(Array.isArray(statuses) ? statuses : [statuses]);
    if (normalizedStatuses.some((item) => (
      !["pending", "completed", "blocked", "failed", "cancelled"].includes(item)
    ))) throw new Error("Unknown state analysis request status.");
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    const normalizedFamilies = cleanStringList(
      Array.isArray(stateFamilies) ? stateFamilies : [stateFamilies],
    );
    if (clean(stateFamily) && normalizedFamilies.length) {
      throw new Error("Filter state analysis requests by stateFamily or stateFamilies, not both.");
    }
    if (normalizedFamilies.some((item) => !MEMORY_STATE_FAMILIES.includes(item))) {
      throw new Error("Unknown state analysis request family.");
    }
    if (clean(stateFamily)) {
      if (!MEMORY_STATE_FAMILIES.includes(clean(stateFamily))) {
        throw new Error("Unknown state analysis request family.");
      }
      clauses.push("state_family = ?");
      parameters.push(clean(stateFamily));
    } else if (normalizedFamilies.length) {
      clauses.push(`state_family IN (${normalizedFamilies.map(() => "?").join(", ")})`);
      parameters.push(...normalizedFamilies);
    }
    if (clean(representationLayer)) {
      if (!["reported", "inferred", "established"].includes(clean(representationLayer))) {
        throw new Error("Unknown state analysis request representation layer.");
      }
      clauses.push("representation_layer = ?");
      parameters.push(clean(representationLayer));
    }
    if (clean(evidenceMode)) {
      if (!["explicit", "observed", "inferred"].includes(clean(evidenceMode))) {
        throw new Error("Unknown state analysis request evidence mode.");
      }
      clauses.push("evidence_mode = ?");
      parameters.push(clean(evidenceMode));
    }
    if (clean(batchId)) {
      clauses.push("batch_id = ?");
      parameters.push(clean(batchId));
    }
    if (normalizedStatuses.length) {
      clauses.push(`status IN (${normalizedStatuses.map(() => "?").join(", ")})`);
      parameters.push(...normalizedStatuses);
    }
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100)));
    const rows = this.database.prepare(`
      SELECT id FROM memory_state_analysis_requests
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ASC, candidate_index ASC LIMIT ?
    `).all(...parameters, maximum);
    return rows.map((row) => this.getStateAnalysisRequest(normalizedAgentId, row.id));
  }

  resolveStateAnalysisRequest({
    agentId,
    requestId,
    status,
    analysisBatchId = "",
    errorMessage = "",
    metadata = {},
    resolvedAt = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedRequestId = clean(requestId);
    const normalizedStatus = clean(status);
    const timestamp = clean(resolvedAt);
    if (!normalizedAgentId || !normalizedRequestId
      || !["completed", "blocked", "failed", "cancelled"].includes(normalizedStatus)
      || !validTimestamp(timestamp)) {
      throw new Error("Resolving a state analysis request requires a final status and valid time.");
    }
    const current = this.getStateAnalysisRequest(normalizedAgentId, normalizedRequestId);
    if (!current) throw new Error("State analysis request was not found.");
    if (current.status !== "pending") {
      const same = current.status === normalizedStatus
        && current.analysis_batch_id === clean(analysisBatchId)
        && current.error_message === clean(errorMessage);
      if (same) return { ...current, wasUpdated: false };
      throw new Error("State analysis request is already resolved.");
    }
    this.database.prepare(`
      UPDATE memory_state_analysis_requests
      SET status = ?, analysis_batch_id = ?, error_message = ?, metadata_json = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND status = 'pending'
    `).run(
      normalizedStatus,
      clean(analysisBatchId),
      clean(errorMessage),
      canonicalJson({ ...current.metadata, ...metadata }, {}),
      new Date(timestamp).toISOString(),
      normalizedAgentId,
      normalizedRequestId,
    );
    return { ...this.getStateAnalysisRequest(normalizedAgentId, normalizedRequestId), wasUpdated: true };
  }

  recordStateAnalysisRun({
    id = randomUUID(),
    agentId,
    batchId = "",
    stateFamily,
    analyzerRole,
    subjectRole,
    subjectKey,
    canonicalKey,
    provider = "",
    model = "",
    promptVersion,
    schemaVersion,
    inputHash,
    status,
    memoryIds = [],
    sourceIds = [],
    output = {},
    rejected = [],
    usage = {},
    costAmount = 0,
    costCurrency = "",
    requestId = "",
    durationMs = 0,
    errorMessage = "",
    metadata = {},
    createdAt = nowIso(),
  } = {}) {
    const runId = clean(id);
    const normalizedAgentId = clean(agentId);
    const normalizedFamily = clean(stateFamily);
    const normalizedRole = clean(analyzerRole);
    const normalizedSubjectRole = clean(subjectRole);
    const normalizedSubjectKey = clean(subjectKey);
    const normalizedCanonicalKey = clean(canonicalKey).toLocaleLowerCase("en-US");
    const normalizedPromptVersion = clean(promptVersion);
    const normalizedSchemaVersion = clean(schemaVersion);
    const normalizedInputHash = clean(inputHash);
    const normalizedStatus = clean(status);
    const normalizedMemoryIds = cleanStringList(memoryIds);
    const normalizedSourceIds = cleanStringList(sourceIds);
    const normalizedDurationMs = Math.trunc(Number(durationMs));
    const normalizedCostAmount = Number(costAmount);
    const timestamp = clean(createdAt);
    if (
      !runId || !normalizedAgentId || !MEMORY_STATE_FAMILIES.includes(normalizedFamily) || !normalizedRole
      || !["user", "agent", "shared", "other"].includes(normalizedSubjectRole)
      || !normalizedSubjectKey || !normalizedCanonicalKey
      || !normalizedPromptVersion || !normalizedSchemaVersion || !normalizedInputHash
      || !["completed", "abstained", "rejected", "failed"].includes(normalizedStatus)
      || !normalizedMemoryIds.length || !normalizedSourceIds.length
      || !Number.isFinite(normalizedDurationMs) || normalizedDurationMs < 0
      || !Number.isFinite(normalizedCostAmount) || normalizedCostAmount < 0
      || !validTimestamp(timestamp)
    ) {
      throw new Error("State analysis run record is incomplete.");
    }
    for (const memoryId of normalizedMemoryIds) {
      const memory = this.getMemory(memoryId);
      if (!memory || memory.agent_id !== normalizedAgentId || memory.status === "deleted") {
        throw new Error("State analysis run memory must belong to the same Agent and be available.");
      }
    }
    const linkedSources = new Set(this.database.prepare(`
      SELECT DISTINCT source_id FROM memory_sources
      WHERE memory_id IN (${normalizedMemoryIds.map(() => "?").join(", ")})
    `).all(...normalizedMemoryIds).map((row) => row.source_id));
    if (normalizedSourceIds.some((sourceId) => !linkedSources.has(sourceId))) {
      throw new Error("State analysis run source must support one of its input memories.");
    }
    const owner = this.database.prepare(`
      SELECT agent_id FROM memory_state_analysis_runs WHERE id = ?
    `).get(runId);
    if (owner && owner.agent_id !== normalizedAgentId) {
      throw new Error("State analysis run id already belongs to another Agent.");
    }
    const existing = this.getStateAnalysisRun(normalizedAgentId, runId);
    if (existing) {
      const same = existing.state_family === normalizedFamily
        && existing.analyzer_role === normalizedRole
        && existing.subject_role === normalizedSubjectRole
        && existing.subject_key === normalizedSubjectKey
        && existing.canonical_key === normalizedCanonicalKey
        && existing.prompt_version === normalizedPromptVersion
        && existing.schema_version === normalizedSchemaVersion
        && existing.input_hash === normalizedInputHash
        && existing.status === normalizedStatus
        && canonicalJson(existing.memoryIds, []) === canonicalJson(normalizedMemoryIds, [])
        && canonicalJson(existing.sourceIds, []) === canonicalJson(normalizedSourceIds, [])
        && canonicalJson(existing.output, {}) === canonicalJson(output, {})
        && canonicalJson(existing.rejected, []) === canonicalJson(rejected, []);
      if (!same) throw new Error("State analysis run id already exists with different contents.");
      return { ...existing, wasInserted: false };
    }
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO memory_state_analysis_runs (
          id, agent_id, batch_id, state_family, analyzer_role,
          subject_role, subject_key, canonical_key, provider, model,
          prompt_version, schema_version, input_hash, status, output_json,
          rejected_json, usage_json, cost_amount, cost_currency, request_id,
          duration_ms, error_message, metadata_json, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        runId,
        normalizedAgentId,
        clean(batchId),
        normalizedFamily,
        normalizedRole,
        normalizedSubjectRole,
        normalizedSubjectKey,
        normalizedCanonicalKey,
        clean(provider),
        clean(model),
        normalizedPromptVersion,
        normalizedSchemaVersion,
        normalizedInputHash,
        normalizedStatus,
        canonicalJson(output, {}),
        canonicalJson(rejected, []),
        canonicalJson(usage, {}),
        normalizedCostAmount,
        clean(costCurrency),
        clean(requestId),
        normalizedDurationMs,
        clean(errorMessage),
        canonicalJson(metadata, {}),
        new Date(timestamp).toISOString(),
      );
      const insertMemory = this.database.prepare(`
        INSERT INTO memory_state_analysis_run_memories (
          analysis_run_id, agent_id, memory_id, ordinal
        ) VALUES (?, ?, ?, ?)
      `);
      normalizedMemoryIds.forEach((memoryId, index) => {
        insertMemory.run(runId, normalizedAgentId, memoryId, index);
      });
      const insertSource = this.database.prepare(`
        INSERT INTO memory_state_analysis_run_sources (
          analysis_run_id, agent_id, source_id, ordinal
        ) VALUES (?, ?, ?, ?)
      `);
      normalizedSourceIds.forEach((sourceId, index) => {
        insertSource.run(runId, normalizedAgentId, sourceId, index);
      });
      return { ...this.getStateAnalysisRun(normalizedAgentId, runId), wasInserted: true };
    });
  }

  getStateAnalysisRun(agentId, analysisRunId) {
    const normalizedAgentId = clean(agentId);
    const normalizedRunId = clean(analysisRunId);
    const row = this.database.prepare(`
      SELECT * FROM memory_state_analysis_runs WHERE agent_id = ? AND id = ?
    `).get(normalizedAgentId, normalizedRunId);
    if (!row) return null;
    const memoryIds = this.database.prepare(`
      SELECT memory_id FROM memory_state_analysis_run_memories
      WHERE agent_id = ? AND analysis_run_id = ? ORDER BY ordinal ASC
    `).all(normalizedAgentId, normalizedRunId).map((item) => item.memory_id);
    const sourceIds = this.database.prepare(`
      SELECT source_id FROM memory_state_analysis_run_sources
      WHERE agent_id = ? AND analysis_run_id = ? ORDER BY ordinal ASC
    `).all(normalizedAgentId, normalizedRunId).map((item) => item.source_id);
    return normalizeStateAnalysisRun(row, memoryIds, sourceIds);
  }

  listStateAnalysisRuns(agentId, {
    stateFamily = "",
    analyzerRole = "",
    canonicalKey = "",
    batchId = "",
    statuses = [],
    limit = 100,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listStateAnalysisRuns requires agentId.");
    const normalizedStatuses = cleanStringList(Array.isArray(statuses) ? statuses : [statuses]);
    if (normalizedStatuses.some((item) => !["completed", "abstained", "rejected", "failed"].includes(item))) {
      throw new Error("Unknown state analysis run status.");
    }
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    const filters = [
      ["state_family", clean(stateFamily)],
      ["analyzer_role", clean(analyzerRole)],
      ["canonical_key", clean(canonicalKey).toLocaleLowerCase("en-US")],
      ["batch_id", clean(batchId)],
    ];
    for (const [column, value] of filters) {
      if (!value) continue;
      clauses.push(`${column} = ?`);
      parameters.push(value);
    }
    if (normalizedStatuses.length) {
      clauses.push(`status IN (${normalizedStatuses.map(() => "?").join(", ")})`);
      parameters.push(...normalizedStatuses);
    }
    const rows = this.database.prepare(`
      SELECT id FROM memory_state_analysis_runs
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(...parameters, Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100))));
    return rows.map((row) => this.getStateAnalysisRun(normalizedAgentId, row.id));
  }

  recordStateEvidenceObservation({
    id = randomUUID(),
    agentId,
    batchId = "",
    stateFamily,
    subjectRole,
    subjectKey,
    canonicalKey,
    memoryId,
    evidenceGroupId,
    contextId = "",
    signal,
    claimedDirection,
    effectiveDirection,
    qualification,
    confidence = 0.5,
    origin = "llm",
    scope = {},
    payloadSchemaVersion,
    payload = {},
    excludedReason = "",
    sourceIds = [],
    analysisRunIds = [],
    observedAt = "",
    createdAt = nowIso(),
  } = {}) {
    const observationId = clean(id);
    const normalizedAgentId = clean(agentId);
    const normalizedFamily = clean(stateFamily);
    const normalizedSubjectRole = clean(subjectRole);
    const normalizedSubjectKey = clean(subjectKey);
    const normalizedCanonicalKey = clean(canonicalKey).toLocaleLowerCase("en-US");
    const normalizedMemoryId = clean(memoryId);
    const normalizedGroupId = clean(evidenceGroupId);
    const normalizedSignal = clean(signal);
    const normalizedClaimedDirection = clean(claimedDirection);
    const normalizedEffectiveDirection = clean(effectiveDirection);
    const normalizedQualification = clean(qualification);
    const normalizedOrigin = clean(origin);
    const normalizedPayloadSchemaVersion = clean(payloadSchemaVersion);
    const normalizedExcludedReason = clean(excludedReason);
    const normalizedSourceIds = cleanStringList(sourceIds).sort();
    const normalizedRunIds = cleanStringList(analysisRunIds).sort();
    const timestamp = clean(createdAt);
    const memory = this.getMemory(normalizedMemoryId);
    const normalizedObservedAt = clean(observedAt)
      || memory?.known_at || memory?.event_start || memory?.recorded_at || "";
    if (
      !observationId || !normalizedAgentId || !MEMORY_STATE_FAMILIES.includes(normalizedFamily)
      || !["user", "agent", "shared", "other"].includes(normalizedSubjectRole)
      || !normalizedSubjectKey || !normalizedCanonicalKey || !normalizedMemoryId
      || !normalizedGroupId || !normalizedSignal
      || !["support", "opposition", "neutral"].includes(normalizedClaimedDirection)
      || !["support", "opposition", "neutral"].includes(normalizedEffectiveDirection)
      || !["qualified", "excluded", "unresolved"].includes(normalizedQualification)
      || !["llm", "deterministic", "manual", "imported"].includes(normalizedOrigin)
      || !normalizedPayloadSchemaVersion || !normalizedSourceIds.length
      || !validTimestamp(normalizedObservedAt) || !validTimestamp(timestamp)
    ) {
      throw new Error("State evidence observation record is incomplete.");
    }
    if (normalizedQualification !== "qualified" && normalizedEffectiveDirection !== "neutral") {
      throw new Error("Excluded or unresolved state evidence cannot affect a state direction.");
    }
    if (normalizedQualification === "excluded" && !normalizedExcludedReason) {
      throw new Error("Excluded state evidence requires a reason.");
    }
    if (normalizedQualification === "qualified" && normalizedExcludedReason) {
      throw new Error("Qualified state evidence cannot carry an exclusion reason.");
    }
    if (normalizedOrigin === "llm" && !normalizedRunIds.length) {
      throw new Error("LLM state evidence requires at least one analysis run.");
    }
    if (!memory || memory.agent_id !== normalizedAgentId || memory.status === "deleted") {
      throw new Error("State evidence memory must belong to the same Agent and be available.");
    }
    const memoryDetail = this.getMemoryDetail(normalizedAgentId, normalizedMemoryId);
    const targetIsPrimarySubject = memory.subject_role === normalizedSubjectRole
      && memory.subject_key === normalizedSubjectKey;
    const targetHasStructuredRole = memoryDetail?.roles.some((role) => (
      role.actor_role === normalizedSubjectRole && role.actor_key === normalizedSubjectKey
    ));
    if (!targetIsPrimarySubject && !targetHasStructuredRole) {
      throw new Error("State evidence memory does not identify the evaluated subject.");
    }
    const linkedSourceIds = new Set(memoryDetail?.sources.map((item) => item.id) || []);
    if (normalizedSourceIds.some((sourceId) => !linkedSourceIds.has(sourceId))) {
      throw new Error("State evidence source must already support its evidence memory.");
    }
    for (const runId of normalizedRunIds) {
      const run = this.getStateAnalysisRun(normalizedAgentId, runId);
      if (!run || run.state_family !== normalizedFamily
        || run.subject_role !== normalizedSubjectRole
        || run.subject_key !== normalizedSubjectKey
        || run.canonical_key !== normalizedCanonicalKey
        || run.status !== "completed"
        || !run.memoryIds.includes(normalizedMemoryId)
        || normalizedSourceIds.some((sourceId) => !run.sourceIds.includes(sourceId))) {
        throw new Error("State evidence analysis run does not cover the same target and sources.");
      }
    }
    const normalizedConfidence = unitInterval(confidence, "state evidence confidence");
    const hash = createHash("sha256").update(canonicalJson({
      agentId: normalizedAgentId,
      stateFamily: normalizedFamily,
      subjectRole: normalizedSubjectRole,
      subjectKey: normalizedSubjectKey,
      canonicalKey: normalizedCanonicalKey,
      memoryId: normalizedMemoryId,
      evidenceGroupId: normalizedGroupId,
      contextId: clean(contextId),
      signal: normalizedSignal,
      claimedDirection: normalizedClaimedDirection,
      effectiveDirection: normalizedEffectiveDirection,
      qualification: normalizedQualification,
      confidence: normalizedConfidence,
      origin: normalizedOrigin,
      scope,
      payloadSchemaVersion: normalizedPayloadSchemaVersion,
      payload,
      excludedReason: normalizedExcludedReason,
      sourceIds: normalizedSourceIds,
      observedAt: new Date(normalizedObservedAt).toISOString(),
    }, {})).digest("hex");
    const owner = this.database.prepare(`
      SELECT agent_id FROM memory_state_evidence_observations WHERE id = ?
    `).get(observationId);
    if (owner && owner.agent_id !== normalizedAgentId) {
      throw new Error("State evidence observation id already belongs to another Agent.");
    }
    return this.transaction(() => {
      const duplicate = this.database.prepare(`
        SELECT id FROM memory_state_evidence_observations
        WHERE agent_id = ? AND observation_hash = ?
      `).get(normalizedAgentId, hash);
      if (duplicate) {
        const linkRun = this.database.prepare(`
          INSERT OR IGNORE INTO memory_state_observation_runs (
            observation_id, analysis_run_id, agent_id, created_at
          ) VALUES (?, ?, ?, ?)
        `);
        for (const runId of normalizedRunIds) {
          linkRun.run(duplicate.id, runId, normalizedAgentId, new Date(timestamp).toISOString());
        }
        return {
          ...this.getStateEvidenceObservation(normalizedAgentId, duplicate.id),
          wasInserted: false,
        };
      }
      if (owner) {
        throw new Error("State evidence observation id already exists with different contents.");
      }
      const previous = this.database.prepare(`
        SELECT id FROM memory_state_evidence_observations
        WHERE agent_id = ? AND state_family = ? AND subject_role = ?
          AND subject_key = ? AND canonical_key = ? AND memory_id = ?
          AND lifecycle = 'current'
      `).get(
        normalizedAgentId,
        normalizedFamily,
        normalizedSubjectRole,
        normalizedSubjectKey,
        normalizedCanonicalKey,
        normalizedMemoryId,
      );
      const normalizedTimestamp = new Date(timestamp).toISOString();
      if (previous) {
        const update = this.database.prepare(`
          UPDATE memory_state_evidence_observations
          SET lifecycle = 'superseded', updated_at = ?
          WHERE agent_id = ? AND id = ? AND lifecycle = 'current'
        `).run(normalizedTimestamp, normalizedAgentId, previous.id);
        if (Number(update.changes || 0) !== 1) {
          throw new Error("State evidence observation changed while being superseded.");
        }
      }
      this.database.prepare(`
        INSERT INTO memory_state_evidence_observations (
          id, agent_id, batch_id, state_family, subject_role, subject_key,
          canonical_key, memory_id, evidence_group_id, context_id, signal,
          claimed_direction, effective_direction, qualification, confidence,
          origin, scope_json, payload_schema_version, payload_json, excluded_reason,
          observation_hash, lifecycle, supersedes_observation_id, observed_at,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'current', ?, ?, ?, ?
        )
      `).run(
        observationId,
        normalizedAgentId,
        clean(batchId),
        normalizedFamily,
        normalizedSubjectRole,
        normalizedSubjectKey,
        normalizedCanonicalKey,
        normalizedMemoryId,
        normalizedGroupId,
        clean(contextId),
        normalizedSignal,
        normalizedClaimedDirection,
        normalizedEffectiveDirection,
        normalizedQualification,
        normalizedConfidence,
        normalizedOrigin,
        canonicalJson(scope, {}),
        normalizedPayloadSchemaVersion,
        canonicalJson(payload, {}),
        normalizedExcludedReason,
        hash,
        previous?.id || null,
        new Date(normalizedObservedAt).toISOString(),
        normalizedTimestamp,
        normalizedTimestamp,
      );
      const insertSource = this.database.prepare(`
        INSERT INTO memory_state_observation_sources (
          observation_id, agent_id, source_id, created_at
        ) VALUES (?, ?, ?, ?)
      `);
      for (const sourceId of normalizedSourceIds) {
        insertSource.run(observationId, normalizedAgentId, sourceId, normalizedTimestamp);
      }
      const insertRun = this.database.prepare(`
        INSERT INTO memory_state_observation_runs (
          observation_id, analysis_run_id, agent_id, created_at
        ) VALUES (?, ?, ?, ?)
      `);
      for (const runId of normalizedRunIds) {
        insertRun.run(observationId, runId, normalizedAgentId, normalizedTimestamp);
      }
      return {
        ...this.getStateEvidenceObservation(normalizedAgentId, observationId),
        wasInserted: true,
      };
    });
  }

  getStateEvidenceObservation(agentId, observationId) {
    const normalizedAgentId = clean(agentId);
    const normalizedObservationId = clean(observationId);
    const row = this.database.prepare(`
      SELECT * FROM memory_state_evidence_observations WHERE agent_id = ? AND id = ?
    `).get(normalizedAgentId, normalizedObservationId);
    if (!row) return null;
    const sourceIds = this.database.prepare(`
      SELECT source_id FROM memory_state_observation_sources
      WHERE agent_id = ? AND observation_id = ? ORDER BY source_id ASC
    `).all(normalizedAgentId, normalizedObservationId).map((item) => item.source_id);
    const analysisRunIds = this.database.prepare(`
      SELECT analysis_run_id FROM memory_state_observation_runs
      WHERE agent_id = ? AND observation_id = ? ORDER BY analysis_run_id ASC
    `).all(normalizedAgentId, normalizedObservationId).map((item) => item.analysis_run_id);
    return normalizeStateEvidenceObservation(row, sourceIds, analysisRunIds);
  }

  listStateEvidenceObservations(agentId, {
    stateFamily = "",
    subjectRole = "",
    subjectKey = "",
    canonicalKey = "",
    memoryId = "",
    qualifications = [],
    lifecycles = ["current"],
    limit = 200,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listStateEvidenceObservations requires agentId.");
    const normalizedQualifications = cleanStringList(
      Array.isArray(qualifications) ? qualifications : [qualifications],
    );
    const normalizedLifecycles = cleanStringList(
      Array.isArray(lifecycles) ? lifecycles : [lifecycles],
    );
    if (normalizedQualifications.some((item) => !["qualified", "excluded", "unresolved"].includes(item))) {
      throw new Error("Unknown state evidence qualification.");
    }
    if (normalizedLifecycles.some((item) => !["current", "superseded", "withdrawn"].includes(item))) {
      throw new Error("Unknown state evidence lifecycle.");
    }
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    const filters = [
      ["state_family", clean(stateFamily)],
      ["subject_role", clean(subjectRole)],
      ["subject_key", clean(subjectKey)],
      ["canonical_key", clean(canonicalKey).toLocaleLowerCase("en-US")],
      ["memory_id", clean(memoryId)],
    ];
    for (const [column, value] of filters) {
      if (!value) continue;
      clauses.push(`${column} = ?`);
      parameters.push(value);
    }
    if (normalizedQualifications.length) {
      clauses.push(`qualification IN (${normalizedQualifications.map(() => "?").join(", ")})`);
      parameters.push(...normalizedQualifications);
    }
    if (normalizedLifecycles.length) {
      clauses.push(`lifecycle IN (${normalizedLifecycles.map(() => "?").join(", ")})`);
      parameters.push(...normalizedLifecycles);
    }
    const rows = this.database.prepare(`
      SELECT id FROM memory_state_evidence_observations
      WHERE ${clauses.join(" AND ")}
      ORDER BY observed_at DESC, created_at DESC, id DESC LIMIT ?
    `).all(...parameters, Math.min(1000, Math.max(1, Math.trunc(Number(limit) || 200))));
    return rows.map((row) => this.getStateEvidenceObservation(normalizedAgentId, row.id));
  }

  withdrawStateEvidenceObservation({ agentId, observationId } = {}) {
    const normalizedAgentId = clean(agentId);
    const observation = this.getStateEvidenceObservation(normalizedAgentId, observationId);
    if (!observation) throw new Error("State evidence observation does not exist for this Agent.");
    if (observation.lifecycle !== "current") {
      throw new Error(`Only current state evidence can be withdrawn; it is ${observation.lifecycle}.`);
    }
    const timestamp = nowIso();
    const result = this.database.prepare(`
      UPDATE memory_state_evidence_observations
      SET lifecycle = 'withdrawn', updated_at = ?
      WHERE agent_id = ? AND id = ? AND lifecycle = 'current'
    `).run(timestamp, normalizedAgentId, observation.id);
    if (Number(result.changes || 0) !== 1) {
      throw new Error("State evidence observation changed while being withdrawn.");
    }
    return this.getStateEvidenceObservation(normalizedAgentId, observation.id);
  }

  recordReportedStateProposal({
    id = "",
    agentId,
    batchId = "",
    stateFamily,
    subjectRole,
    subjectKey,
    canonicalKey,
    action,
    previousMemoryId = null,
    targetScopeKey = ROOT_STATE_SCOPE_KEY,
    proposedState = null,
    reviewVersion,
    inputHash,
    selectedObservationId,
    consideredObservationIds = [],
    metadata = {},
    createdAt = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedFamily = clean(stateFamily);
    const normalizedSubjectRole = clean(subjectRole);
    const normalizedSubjectKey = clean(subjectKey);
    const normalizedCanonicalKey = clean(canonicalKey).toLocaleLowerCase("en-US");
    const normalizedAction = clean(action);
    const normalizedPreviousMemoryId = clean(previousMemoryId) || null;
    const normalizedTargetScopeKey = clean(targetScopeKey) || ROOT_STATE_SCOPE_KEY;
    const normalizedReviewVersion = clean(reviewVersion);
    const normalizedInputHash = clean(inputHash);
    const normalizedSelectedObservationId = clean(selectedObservationId);
    const normalizedConsideredObservationIds = cleanStringList(consideredObservationIds);
    const stateDraftActions = new Set([
      "create", "reinforce", "narrow_scope", "add_scoped_exception",
      "supersede", "pause", "resume",
    ]);
    const draft = proposedState && typeof proposedState === "object" && !Array.isArray(proposedState)
      ? canonicalJsonValue(proposedState)
      : null;
    if (!normalizedAgentId || !MEMORY_STATE_FAMILIES.includes(normalizedFamily)
      || !SUBJECT_ROLES.includes(normalizedSubjectRole) || !normalizedSubjectKey
      || !normalizedCanonicalKey || !REPORTED_STATE_PROPOSAL_ACTIONS.includes(normalizedAction)
      || !normalizedReviewVersion || !normalizedInputHash || !normalizedSelectedObservationId) {
      throw new Error("Reported state proposal is incomplete.");
    }
    if (!isValidStateScopeKey(normalizedTargetScopeKey)
      || normalizedTargetScopeKey === NON_STATE_SCOPE_KEY) {
      throw new Error("Reported state proposal target scope is invalid.");
    }
    if (!isReportedStateActionAllowedForFamily(normalizedAction, normalizedFamily)) {
      throw new Error("Reported state proposal action is invalid for its state family.");
    }
    if (!normalizedConsideredObservationIds.includes(normalizedSelectedObservationId)) {
      throw new Error("Selected reported-state observation must be included in considered observations.");
    }
    if (normalizedAction === "create" && normalizedPreviousMemoryId) {
      throw new Error("Reported state create proposal cannot reference a previous state.");
    }
    if (normalizedAction === "create" && normalizedTargetScopeKey !== ROOT_STATE_SCOPE_KEY) {
      throw new Error("Reported state create proposal must target the root scope.");
    }
    if (normalizedAction !== "create" && !normalizedPreviousMemoryId) {
      throw new Error("Reported state transition proposal requires the exact previous state.");
    }
    if (stateDraftActions.has(normalizedAction) !== Boolean(draft)) {
      throw new Error(stateDraftActions.has(normalizedAction)
        ? `Reported state ${normalizedAction} proposal requires a normalized state draft.`
        : `Reported state ${normalizedAction} proposal must not carry a replacement state draft.`);
    }

    let proposedKind = "";
    let statePhase = "unspecified";
    let temporalState = "unknown";
    if (draft) {
      proposedKind = clean(draft.kind);
      statePhase = clean(draft.statePhase) || "unspecified";
      temporalState = clean(draft.temporalState) || "unknown";
      if (clean(draft.stateFamily) !== normalizedFamily
        || clean(draft.representationLayer) !== "reported"
        || clean(draft.subjectRole) !== normalizedSubjectRole
        || clean(draft.subjectKey) !== normalizedSubjectKey
        || clean(draft.canonicalKey).toLocaleLowerCase("en-US") !== normalizedCanonicalKey) {
        throw new Error("Reported state draft does not match the fixed proposal target.");
      }
      if (!proposedKind || !isMemoryKindAllowedForStateFamily(proposedKind, normalizedFamily)) {
        throw new Error("Reported state draft kind is invalid for its state family.");
      }
      if (!MEMORY_STATE_PHASES.includes(statePhase) || statePhase === "not_applicable") {
        throw new Error("Reported state draft has an invalid state phase.");
      }
      if (!TEMPORAL_STATES.includes(temporalState)) {
        throw new Error("Reported state draft has an invalid temporal state.");
      }
      if (!validTimestamp(draft.validFrom)) {
        throw new Error("Reported state draft requires a valid validity start.");
      }
      if (normalizedAction === "pause" && statePhase !== "paused") {
        throw new Error("Reported state pause draft must use the paused state phase.");
      }
      if (normalizedAction === "resume" && statePhase !== "active") {
        throw new Error("Reported state resume draft must use the active state phase.");
      }
    }

    const normalizedProposedScopeKey = normalizedAction === "add_scoped_exception"
      ? reportedStateScopeKeyFromDraft(normalizedFamily, draft)
      : normalizedTargetScopeKey;
    if (!isValidStateScopeKey(normalizedProposedScopeKey)
      || normalizedProposedScopeKey === NON_STATE_SCOPE_KEY) {
      throw new Error("Reported state proposal result scope is invalid.");
    }
    if (normalizedAction === "add_scoped_exception"
      && (normalizedTargetScopeKey !== ROOT_STATE_SCOPE_KEY
        || normalizedProposedScopeKey === normalizedTargetScopeKey)) {
      throw new Error("Scoped reported-state exceptions require a root target and a distinct local scope.");
    }

    const currentState = this.getCurrentCanonicalMemory({
      agentId: normalizedAgentId,
      subjectRole: normalizedSubjectRole,
      subjectKey: normalizedSubjectKey,
      canonicalKey: normalizedCanonicalKey,
      representationLayer: "reported",
      stateFamily: normalizedFamily,
      stateScopeKey: normalizedTargetScopeKey,
    });
    if ((currentState?.id || null) !== normalizedPreviousMemoryId) {
      throw new Error("Reported state changed after review; rebuild the proposal from current evidence.");
    }

    const observations = normalizedConsideredObservationIds.map((observationId, ordinal) => {
      const observation = this.getStateEvidenceObservation(normalizedAgentId, observationId);
      if (!observation || observation.lifecycle !== "current"
        || observation.state_family !== normalizedFamily
        || observation.subject_role !== normalizedSubjectRole
        || observation.subject_key !== normalizedSubjectKey
        || observation.canonical_key !== normalizedCanonicalKey
        || clean(observation.scope?.currentRepresentationLayer) !== "reported") {
        throw new Error("Reported state proposal observation is outside the reviewed target or layer.");
      }
      const memoryId = clean(observation.memory_id || observation.memoryId);
      const detail = this.getMemoryDetail(normalizedAgentId, memoryId);
      if (!detail || detail.memory.status === "deleted") {
        throw new Error("Reported state proposal observation lost its evidence memory.");
      }
      const sourceById = new Map(detail.sources.map((source) => [source.id, source]));
      if (!observation.sourceIds.length
        || observation.sourceIds.some((sourceId) => !sourceById.has(sourceId))) {
        throw new Error("Reported state proposal observation lost its direct evidence source.");
      }
      const sourceFingerprints = [...observation.sourceIds].sort().map((sourceId) => {
        const source = sourceById.get(sourceId);
        return {
          id: sourceId,
          fingerprint: canonicalHash({
            id: source.id,
            agentId: source.agent_id,
            sourceKind: source.source_kind,
            externalId: source.external_id,
            occurredAt: source.occurred_at,
            knownAt: source.known_at,
            speaker: source.speaker,
            content: source.content,
          }),
        };
      });
      return {
        id: observation.id,
        evidenceRole: observation.id === normalizedSelectedObservationId ? "selected" : "considered",
        ordinal,
        snapshot: {
          observationId: observation.id,
          observationHash: clean(observation.observation_hash),
          memoryId,
          memoryFingerprint: canonicalHash({
            id: detail.memory.id,
            title: detail.memory.title,
            content: detail.memory.content,
            subjectRole: detail.memory.subject_role,
            subjectKey: detail.memory.subject_key,
            knownAt: detail.memory.known_at,
            eventStart: detail.memory.event_start,
            roles: detail.roles.map((role) => ({
              role: role.role,
              actorRole: role.actor_role,
              actorKey: role.actor_key,
              isPrimary: role.is_primary,
            })),
          }),
          sourceFingerprints,
        },
      };
    });

    const selected = observations.find((observation) => observation.evidenceRole === "selected");
    const selectedMemory = this.getMemory(selected?.snapshot.memoryId);
    if (!selected || !selectedMemory) {
      throw new Error("Reported state proposal cannot snapshot its selected evidence.");
    }
    const evidenceSnapshot = {
      version: "reported-state-evidence-snapshot-v1",
      selectedContent: selectedMemory.content,
      observations: observations.map((observation) => observation.snapshot),
    };
    const proposalMetadata = canonicalJsonValue({
      ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}),
      reportedStateEvidenceSnapshot: evidenceSnapshot,
    });

    const normalizedCreatedAt = new Date(createdAt).toISOString();
    const proposalHash = createHash("sha256").update(canonicalJson({
      agentId: normalizedAgentId,
      stateFamily: normalizedFamily,
      subjectRole: normalizedSubjectRole,
      subjectKey: normalizedSubjectKey,
      canonicalKey: normalizedCanonicalKey,
      representationLayer: "reported",
      targetScopeKey: normalizedTargetScopeKey,
      proposedScopeKey: normalizedProposedScopeKey,
      action: normalizedAction,
      previousMemoryId: normalizedPreviousMemoryId,
      proposedState: draft || {},
      reviewVersion: normalizedReviewVersion,
      inputHash: normalizedInputHash,
      observations,
      evidenceSnapshot,
    }, {})).digest("hex");
    const proposalId = clean(id) || stableId(
      "reported-state-proposal",
      normalizedAgentId,
      proposalHash,
    );
    const existingOwner = this.database.prepare(`
      SELECT agent_id FROM memory_reported_state_proposals WHERE id = ?
    `).get(proposalId);
    if (existingOwner && existingOwner.agent_id !== normalizedAgentId) {
      throw new Error("Reported state proposal id already belongs to another Agent.");
    }

    return this.transaction(() => {
      const insertion = this.database.prepare(`
        INSERT OR IGNORE INTO memory_reported_state_proposals (
          id, agent_id, batch_id, state_family, subject_role, subject_key,
          canonical_key, representation_layer, target_scope_key, proposed_scope_key,
          action, previous_memory_id,
          proposed_kind, state_phase, temporal_state, draft_json,
          review_version, input_hash, proposal_hash, review_state,
          metadata_json, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, 'reported', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'pending', ?, ?, ?
        )
      `).run(
        proposalId,
        normalizedAgentId,
        clean(batchId),
        normalizedFamily,
        normalizedSubjectRole,
        normalizedSubjectKey,
        normalizedCanonicalKey,
        normalizedTargetScopeKey,
        normalizedProposedScopeKey,
        normalizedAction,
        normalizedPreviousMemoryId,
        proposedKind,
        statePhase,
        temporalState,
        canonicalJson(draft || {}, {}),
        normalizedReviewVersion,
        normalizedInputHash,
        proposalHash,
        canonicalJson(proposalMetadata, {}),
        normalizedCreatedAt,
        normalizedCreatedAt,
      );
      const stored = this.database.prepare(`
        SELECT id, proposal_hash FROM memory_reported_state_proposals
        WHERE agent_id = ? AND proposal_hash = ?
      `).get(normalizedAgentId, proposalHash);
      if (!stored) throw new Error("Reported state proposal could not be stored.");
      if (existingOwner && stored.id !== proposalId) {
        throw new Error("Reported state proposal id already exists with different contents.");
      }
      if (Number(insertion.changes || 0) === 1) {
        const insertObservation = this.database.prepare(`
          INSERT INTO memory_reported_state_proposal_observations (
            proposal_id, agent_id, observation_id, evidence_role, ordinal, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const observation of observations) {
          insertObservation.run(
            stored.id,
            normalizedAgentId,
            observation.id,
            observation.evidenceRole,
            observation.ordinal,
            normalizedCreatedAt,
          );
        }
      }
      return {
        ...this.getReportedStateProposal(normalizedAgentId, stored.id),
        wasInserted: Number(insertion.changes || 0) === 1,
      };
    });
  }

  getReportedStateProposal(agentId, proposalId) {
    const normalizedAgentId = clean(agentId);
    const row = this.database.prepare(`
      SELECT * FROM memory_reported_state_proposals WHERE agent_id = ? AND id = ?
    `).get(normalizedAgentId, clean(proposalId));
    if (!row) return null;
    const observations = this.database.prepare(`
      SELECT observation_id, evidence_role, ordinal
      FROM memory_reported_state_proposal_observations
      WHERE agent_id = ? AND proposal_id = ?
      ORDER BY ordinal ASC, observation_id ASC
    `).all(normalizedAgentId, row.id);
    return normalizeReportedStateProposal(row, observations);
  }

  listReportedStateProposals(agentId, {
    reviewStates = [],
    stateFamily = "",
    canonicalKey = "",
    limit = 100,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listReportedStateProposals requires agentId.");
    const states = cleanStringList(Array.isArray(reviewStates) ? reviewStates : [reviewStates]);
    if (states.some((state) => !["pending", "accepted", "dismissed"].includes(state))) {
      throw new Error("Unknown reported state proposal review state.");
    }
    const normalizedFamily = clean(stateFamily);
    if (normalizedFamily && !MEMORY_STATE_FAMILIES.includes(normalizedFamily)) {
      throw new Error("Unknown reported state proposal family.");
    }
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (states.length) {
      clauses.push(`review_state IN (${states.map(() => "?").join(", ")})`);
      parameters.push(...states);
    }
    if (normalizedFamily) {
      clauses.push("state_family = ?");
      parameters.push(normalizedFamily);
    }
    if (clean(canonicalKey)) {
      clauses.push("canonical_key = ?");
      parameters.push(clean(canonicalKey).toLocaleLowerCase("en-US"));
    }
    const rows = this.database.prepare(`
      SELECT id FROM memory_reported_state_proposals
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(...parameters, Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100))));
    return rows.map((row) => this.getReportedStateProposal(normalizedAgentId, row.id));
  }

  resolveReportedStateProposalRecord({
    agentId,
    proposalId,
    resolution,
    resultMemoryId = null,
    resolvedBy = "human",
    note = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedResolution = clean(resolution);
    const proposal = this.getReportedStateProposal(normalizedAgentId, proposalId);
    if (!proposal) throw new Error("Reported state proposal does not exist for this Agent.");
    if (proposal.review_state !== "pending") {
      throw new Error(`Reported state proposal is already ${proposal.review_state}.`);
    }
    if (!["accepted", "dismissed"].includes(normalizedResolution)) {
      throw new Error(`Unknown reported state proposal resolution: ${normalizedResolution || "(empty)"}.`);
    }
    const normalizedMemoryId = clean(resultMemoryId) || null;
    if (normalizedResolution === "accepted") {
      const memory = this.getMemory(normalizedMemoryId);
      if (!memory || memory.agent_id !== normalizedAgentId
        || memory.subject_role !== proposal.subject_role
        || memory.subject_key !== proposal.subject_key
        || memory.canonical_key !== proposal.canonical_key
        || memory.representation_layer !== "reported"
        || memory.state_family !== proposal.state_family
        || memory.state_scope_key !== proposal.proposed_scope_key) {
        throw new Error("Accepted reported state proposal requires its exact resulting state memory.");
      }
      const sameMemoryActions = new Set([
        "reinforce", "progress_update", "complete", "cancel", "end", "retire",
        "interrupt", "stop", "revoke", "correct_attribution",
      ]);
      const replacementActions = new Set(["narrow_scope", "supersede", "pause", "resume"]);
      if (sameMemoryActions.has(proposal.action) && memory.id !== proposal.previousMemoryId) {
        throw new Error("This reported state action must resolve against the reviewed current state.");
      }
      if (proposal.action === "create" && proposal.previousMemoryId) {
        throw new Error("A reported state create proposal cannot replace a previous state.");
      }
      if (replacementActions.has(proposal.action) && memory.id === proposal.previousMemoryId) {
        throw new Error("This reported state action requires a new resulting state memory.");
      }
      if (proposal.action === "add_scoped_exception") {
        const root = this.getMemory(proposal.previousMemoryId);
        const edge = root && this.findEdge({
          agentId: normalizedAgentId,
          fromMemoryId: memory.id,
          toMemoryId: root.id,
          relation: "scoped_exception_to",
        });
        if (!root || root.status !== "active"
          || root.state_scope_key !== proposal.target_scope_key
          || proposal.target_scope_key !== ROOT_STATE_SCOPE_KEY
          || proposal.proposed_scope_key === ROOT_STATE_SCOPE_KEY
          || memory.id === root.id
          || !edge) {
          throw new Error("Scoped reported-state acceptance requires an active root and its explicit scope edge.");
        }
      }
    } else if (normalizedMemoryId) {
      throw new Error("Dismissed reported state proposal cannot reference a result memory.");
    }
    const resolvedAt = nowIso();
    const result = this.database.prepare(`
      UPDATE memory_reported_state_proposals
      SET review_state = ?, result_memory_id = ?, resolution_note = ?, resolved_by = ?,
          resolved_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND review_state = 'pending'
    `).run(
      normalizedResolution,
      normalizedMemoryId,
      clean(note),
      clean(resolvedBy) || "human",
      resolvedAt,
      resolvedAt,
      normalizedAgentId,
      proposal.id,
    );
    if (Number(result.changes || 0) !== 1) {
      throw new Error("Reported state proposal changed while it was being resolved.");
    }
    return this.getReportedStateProposal(normalizedAgentId, proposal.id);
  }

  dismissReportedStateProposal({
    agentId,
    proposalId,
    resolvedBy = "human",
    note = "",
  } = {}) {
    return this.resolveReportedStateProposalRecord({
      agentId,
      proposalId,
      resolution: "dismissed",
      resolvedBy,
      note,
    });
  }

  recordPreferenceStateProposal({
    id,
    agentId,
    batchId = "",
    subjectRole,
    subjectKey,
    canonicalKey,
    subjectLabel,
    objectLabel,
    scopeLabel = "",
    scope = {},
    representationLayer = "inferred",
    stateScopeKey = ROOT_STATE_SCOPE_KEY,
    previousMemoryId = null,
    proposedLevel,
    transition,
    proposedKind,
    title = "",
    content,
    evidenceReviewMode = "bounded",
    confidence = 0.5,
    knownAt,
    validFrom,
    policyVersion,
    previewStatus,
    metrics = {},
    rationale = "",
    provenance = "",
    proposalHash,
    evidence = [],
    metadata = {},
    createdAt = nowIso(),
  }) {
    const proposalId = clean(id);
    const normalizedAgentId = clean(agentId);
    const normalizedSubjectRole = clean(subjectRole);
    const normalizedSubjectKey = clean(subjectKey);
    const normalizedCanonicalKey = clean(canonicalKey).toLocaleLowerCase("en-US");
    const normalizedRepresentationLayer = clean(representationLayer) || "inferred";
    const normalizedStateScopeKey = clean(stateScopeKey) || ROOT_STATE_SCOPE_KEY;
    const normalizedPreviousMemoryId = clean(previousMemoryId) || null;
    const normalizedLevel = clean(proposedLevel);
    const normalizedTransition = clean(transition);
    const normalizedKind = clean(proposedKind);
    const normalizedReviewMode = clean(evidenceReviewMode) || "bounded";
    const normalizedKnownAt = clean(knownAt);
    const normalizedValidFrom = clean(validFrom);
    const normalizedPolicyVersion = clean(policyVersion);
    const normalizedPreviewStatus = clean(previewStatus);
    const normalizedContent = clean(content);
    const normalizedProposalHash = clean(proposalHash);
    if (
      !proposalId || !normalizedAgentId
      || !["user", "agent", "shared", "other"].includes(normalizedSubjectRole)
      || !normalizedSubjectKey || !normalizedCanonicalKey
      || !clean(subjectLabel) || !clean(objectLabel)
      || !["reported", "inferred", "established"].includes(normalizedRepresentationLayer)
      || !isValidStateScopeKey(normalizedStateScopeKey)
      || normalizedStateScopeKey === NON_STATE_SCOPE_KEY
      || ![
        "situational_tolerance", "selection_tendency", "stable_preference",
        "direct_preference", "explicit_rejection", "no_conclusion",
      ].includes(normalizedLevel)
      || ![
        "create", "reinforce", "promote", "downgrade", "narrow_scope",
        "replace_explicit", "challenge",
      ].includes(normalizedTransition)
      || !["derived_hypothesis", "preference"].includes(normalizedKind)
      || !["bounded", "full_canonical"].includes(normalizedReviewMode)
      || !normalizedKnownAt || !validTimestamp(normalizedKnownAt)
      || !normalizedValidFrom || !validTimestamp(normalizedValidFrom)
      || !normalizedPolicyVersion || !normalizedPreviewStatus
      || !normalizedContent || !normalizedProposalHash
    ) {
      throw new Error("Preference state proposal record is incomplete.");
    }
    if (["downgrade", "narrow_scope"].includes(normalizedTransition)
      && normalizedReviewMode !== "full_canonical") {
      throw new Error("Preference downgrade and scope narrowing require a full canonical evidence review.");
    }
    const expectedRepresentationLayer = ["direct_preference", "explicit_rejection"]
      .includes(normalizedLevel) ? "reported" : "inferred";
    if (normalizedRepresentationLayer !== expectedRepresentationLayer) {
      throw new Error("Preference proposal level does not match its representation layer.");
    }
    if (normalizedPreviousMemoryId) {
      const previous = this.getMemory(normalizedPreviousMemoryId);
      if (!previous || previous.agent_id !== normalizedAgentId
        || previous.subject_role !== normalizedSubjectRole
        || previous.subject_key !== normalizedSubjectKey
        || previous.canonical_key !== normalizedCanonicalKey
        || previous.representation_layer !== normalizedRepresentationLayer
        || previous.state_family !== "preference"
        || previous.state_scope_key !== normalizedStateScopeKey) {
        throw new Error("Preference state proposal previous memory must match its exact state identity.");
      }
    }
    const normalizedEvidence = (Array.isArray(evidence) ? evidence : []).map((item) => ({
      memoryId: clean(item?.memoryId ?? item?.memory_id),
      evidenceGroupId: clean(item?.evidenceGroupId ?? item?.evidence_group_id),
      contextId: clean(item?.contextId ?? item?.context_id),
      signal: clean(item?.signal),
      direction: clean(item?.direction),
      confidence: unitInterval(item?.confidence, "preference evidence confidence"),
      sourceIds: cleanStringList(item?.sourceIds ?? item?.source_ids).sort(),
      evidenceSnapshotHash: clean(
        item?.evidenceSnapshotHash ?? item?.evidence_snapshot_hash,
      ),
      label: item?.label && typeof item.label === "object" && !Array.isArray(item.label)
        ? item.label
        : {},
    }));
    if (!normalizedEvidence.length
      || normalizedEvidence.some((item) => (
        !item.memoryId || !item.evidenceGroupId || !item.signal
        || !/^[0-9a-f]{64}$/u.test(item.evidenceSnapshotHash)
        || !["support", "opposition", "neutral"].includes(item.direction)
      ))) {
      throw new Error("Preference state proposal requires normalized evidence.");
    }
    const uniqueEvidence = new Map();
    for (const item of normalizedEvidence) {
      if (uniqueEvidence.has(item.memoryId)) {
        throw new Error("Preference state proposal cannot repeat an evidence memory.");
      }
      uniqueEvidence.set(item.memoryId, item);
      const memory = this.getMemory(item.memoryId);
      if (!memory || memory.agent_id !== normalizedAgentId || memory.status === "deleted") {
        throw new Error("Preference evidence memory must belong to the same Agent and be available.");
      }
      const linkedSourceIds = new Set(
        this.getMemoryDetail(normalizedAgentId, item.memoryId)?.sources.map((source) => source.id) || [],
      );
      if (item.sourceIds.some((sourceId) => !linkedSourceIds.has(sourceId))) {
        throw new Error("Preference evidence source must already support its evidence memory.");
      }
    }
    const owner = this.database.prepare(`
      SELECT agent_id FROM memory_preference_state_proposals WHERE id = ?
    `).get(proposalId);
    if (owner && owner.agent_id !== normalizedAgentId) {
      throw new Error("Preference state proposal id already belongs to another Agent.");
    }
    const timestamp = clean(createdAt) || nowIso();
    return this.transaction(() => {
      const insertion = this.database.prepare(`
        INSERT INTO memory_preference_state_proposals (
          id, agent_id, batch_id, subject_role, subject_key, canonical_key,
          subject_label, object_label, scope_label, scope_json,
          representation_layer, state_scope_key, previous_memory_id,
          proposed_level, transition, proposed_kind, title, content,
          evidence_review_mode, confidence, known_at, valid_from, policy_version,
          preview_status, metrics_json, rationale, provenance, proposal_hash,
          review_state, metadata_json, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'pending', ?, ?, ?
        )
        ON CONFLICT(agent_id, proposal_hash) DO NOTHING
      `).run(
        proposalId,
        normalizedAgentId,
        clean(batchId),
        normalizedSubjectRole,
        normalizedSubjectKey,
        normalizedCanonicalKey,
        clean(subjectLabel),
        clean(objectLabel),
        clean(scopeLabel),
        json(scope, {}),
        normalizedRepresentationLayer,
        normalizedStateScopeKey,
        normalizedPreviousMemoryId,
        normalizedLevel,
        normalizedTransition,
        normalizedKind,
        clean(title),
        normalizedContent,
        normalizedReviewMode,
        unitInterval(confidence, "preference proposal confidence"),
        new Date(normalizedKnownAt).toISOString(),
        new Date(normalizedValidFrom).toISOString(),
        normalizedPolicyVersion,
        normalizedPreviewStatus,
        json(metrics, {}),
        clean(rationale),
        clean(provenance),
        normalizedProposalHash,
        json(metadata, {}),
        timestamp,
        timestamp,
      );
      const stored = this.database.prepare(`
        SELECT id FROM memory_preference_state_proposals
        WHERE agent_id = ? AND proposal_hash = ?
      `).get(normalizedAgentId, normalizedProposalHash);
      if (Number(insertion.changes || 0) === 1) {
        const insertEvidence = this.database.prepare(`
          INSERT INTO memory_preference_proposal_evidence (
            proposal_id, agent_id, memory_id, evidence_group_id, context_id,
            signal, direction, confidence, source_ids_json, evidence_snapshot_hash,
            label_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const item of uniqueEvidence.values()) {
          insertEvidence.run(
            stored.id,
            normalizedAgentId,
            item.memoryId,
            item.evidenceGroupId,
            item.contextId,
            item.signal,
            item.direction,
            item.confidence,
            json(item.sourceIds, []),
            item.evidenceSnapshotHash,
            json(item.label, {}),
            timestamp,
          );
        }
      }
      return {
        ...this.getPreferenceStateProposal(normalizedAgentId, stored.id),
        wasInserted: Number(insertion.changes || 0) === 1,
      };
    });
  }

  getPreferenceStateProposal(agentId, proposalId) {
    const normalizedAgentId = clean(agentId);
    const row = this.database.prepare(`
      SELECT * FROM memory_preference_state_proposals WHERE agent_id = ? AND id = ?
    `).get(normalizedAgentId, clean(proposalId));
    if (!row) return null;
    const evidence = this.database.prepare(`
      SELECT * FROM memory_preference_proposal_evidence
      WHERE agent_id = ? AND proposal_id = ?
      ORDER BY direction ASC, evidence_group_id ASC, memory_id ASC
    `).all(normalizedAgentId, row.id);
    return normalizePreferenceStateProposal(row, evidence);
  }

  listPreferenceStateProposals(agentId, {
    reviewStates = [],
    canonicalKey = "",
    limit = 100,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listPreferenceStateProposals requires agentId.");
    const states = cleanStringList(Array.isArray(reviewStates) ? reviewStates : [reviewStates]);
    if (states.some((state) => !["pending", "accepted", "dismissed"].includes(state))) {
      throw new Error("Unknown preference state proposal review state.");
    }
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (states.length) {
      clauses.push(`review_state IN (${states.map(() => "?").join(", ")})`);
      parameters.push(...states);
    }
    if (clean(canonicalKey)) {
      clauses.push("canonical_key = ?");
      parameters.push(clean(canonicalKey).toLocaleLowerCase("en-US"));
    }
    const rows = this.database.prepare(`
      SELECT id FROM memory_preference_state_proposals
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...parameters, Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100))));
    return rows.map((row) => this.getPreferenceStateProposal(normalizedAgentId, row.id));
  }

  resolvePreferenceStateProposal({
    agentId,
    proposalId,
    resolution,
    resultMemoryId = null,
    resolvedBy = "human",
    note = "",
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedResolution = clean(resolution);
    const proposal = this.getPreferenceStateProposal(normalizedAgentId, proposalId);
    if (!proposal) throw new Error("Preference state proposal does not exist for this Agent.");
    if (proposal.review_state !== "pending") {
      throw new Error(`Preference state proposal is already ${proposal.review_state}.`);
    }
    if (!["accepted", "dismissed"].includes(normalizedResolution)) {
      throw new Error(`Unknown preference state proposal resolution: ${normalizedResolution || "(empty)"}.`);
    }
    const normalizedMemoryId = clean(resultMemoryId) || null;
    if (normalizedResolution === "accepted") {
      const memory = this.getMemory(normalizedMemoryId);
      if (!memory || memory.agent_id !== normalizedAgentId
        || memory.subject_role !== proposal.subject_role
        || memory.subject_key !== proposal.subject_key
        || memory.canonical_key !== proposal.canonical_key
        || memory.representation_layer !== proposal.representation_layer
        || memory.state_family !== "preference"
        || memory.state_scope_key !== proposal.state_scope_key
        || clean(memory.metadata?.preferenceStateLevel) !== proposal.proposed_level) {
        throw new Error("Accepted preference state proposal requires its exact resulting state memory.");
      }
      if (["challenge", "reinforce"].includes(proposal.transition)
        && memory.id !== proposal.previousMemoryId) {
        throw new Error("Accepted preference challenge or reinforcement must remain attached to the reviewed current state.");
      }
    } else if (normalizedMemoryId) {
      throw new Error("Dismissed preference state proposal cannot reference a result memory.");
    }
    const resolvedAt = nowIso();
    const result = this.database.prepare(`
      UPDATE memory_preference_state_proposals
      SET review_state = ?, result_memory_id = ?, resolution_note = ?, resolved_by = ?,
          resolved_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND review_state = 'pending'
    `).run(
      normalizedResolution,
      normalizedMemoryId,
      clean(note),
      clean(resolvedBy) || "human",
      resolvedAt,
      resolvedAt,
      normalizedAgentId,
      proposal.id,
    );
    if (Number(result.changes || 0) !== 1) {
      throw new Error("Preference state proposal changed while it was being resolved.");
    }
    return this.getPreferenceStateProposal(normalizedAgentId, proposal.id);
  }

  recordStatePromotionProposal({
    id,
    agentId,
    stateFamily,
    subjectRole,
    subjectKey,
    canonicalKey,
    stateScopeKey = ROOT_STATE_SCOPE_KEY,
    sourceMemoryId,
    proposedKind,
    title = "",
    content,
    confidence = 0.5,
    knownAt,
    validFrom,
    policyVersion,
    sourceSnapshotHash,
    proposalHash,
    metadata = {},
    createdAt = nowIso(),
  } = {}) {
    const proposalId = clean(id);
    const normalizedAgentId = clean(agentId);
    const normalizedFamily = clean(stateFamily);
    const normalizedSubjectRole = clean(subjectRole);
    const normalizedSubjectKey = clean(subjectKey);
    const normalizedCanonicalKey = clean(canonicalKey).toLocaleLowerCase("en-US");
    const normalizedStateScopeKey = clean(stateScopeKey) || ROOT_STATE_SCOPE_KEY;
    const normalizedSourceMemoryId = clean(sourceMemoryId);
    const normalizedKind = clean(proposedKind);
    const normalizedContent = clean(content);
    const normalizedKnownAt = clean(knownAt);
    const normalizedValidFrom = clean(validFrom);
    const normalizedPolicyVersion = clean(policyVersion);
    const normalizedSourceSnapshotHash = clean(sourceSnapshotHash);
    const normalizedProposalHash = clean(proposalHash);
    if (!proposalId || !normalizedAgentId || !MEMORY_STATE_FAMILIES.includes(normalizedFamily)
      || !SUBJECT_ROLES.includes(normalizedSubjectRole) || !normalizedSubjectKey
      || !normalizedCanonicalKey || !isValidStateScopeKey(normalizedStateScopeKey)
      || normalizedStateScopeKey === NON_STATE_SCOPE_KEY || !normalizedSourceMemoryId
      || !normalizedKind || !isMemoryKindAllowedForStateFamily(normalizedKind, normalizedFamily)
      || !normalizedContent || !validTimestamp(normalizedKnownAt)
      || !validTimestamp(normalizedValidFrom) || !normalizedPolicyVersion
      || !/^[0-9a-f]{64}$/u.test(normalizedSourceSnapshotHash)
      || !/^[0-9a-f]{64}$/u.test(normalizedProposalHash)) {
      throw new Error("State promotion proposal record is incomplete.");
    }
    const source = this.getMemory(normalizedSourceMemoryId);
    if (!source || source.agent_id !== normalizedAgentId || source.status !== "active"
      || source.subject_role !== normalizedSubjectRole || source.subject_key !== normalizedSubjectKey
      || source.canonical_key !== normalizedCanonicalKey || source.state_family !== normalizedFamily
      || source.representation_layer !== "inferred"
      || source.state_scope_key !== normalizedStateScopeKey) {
      throw new Error("State promotion source must be the exact active inferred state.");
    }
    const established = this.getCurrentCanonicalMemory({
      agentId: normalizedAgentId,
      subjectRole: normalizedSubjectRole,
      subjectKey: normalizedSubjectKey,
      canonicalKey: normalizedCanonicalKey,
      representationLayer: "established",
      stateFamily: normalizedFamily,
      stateScopeKey: normalizedStateScopeKey,
    });
    if (established) {
      throw new Error("State promotion target already has an established current state.");
    }
    const owner = this.database.prepare(`
      SELECT agent_id FROM memory_state_promotion_proposals WHERE id = ?
    `).get(proposalId);
    if (owner && owner.agent_id !== normalizedAgentId) {
      throw new Error("State promotion proposal id already belongs to another Agent.");
    }
    const timestamp = new Date(createdAt).toISOString();
    const insertion = this.database.prepare(`
      INSERT INTO memory_state_promotion_proposals (
        id, agent_id, state_family, subject_role, subject_key, canonical_key,
        state_scope_key, source_memory_id, source_representation_layer,
        target_representation_layer, proposed_kind, title, content, confidence,
        known_at, valid_from, policy_version, source_snapshot_hash, proposal_hash,
        review_state, metadata_json, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, 'inferred', 'established', ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'pending', ?, ?, ?
      )
      ON CONFLICT(agent_id, proposal_hash) DO NOTHING
    `).run(
      proposalId,
      normalizedAgentId,
      normalizedFamily,
      normalizedSubjectRole,
      normalizedSubjectKey,
      normalizedCanonicalKey,
      normalizedStateScopeKey,
      normalizedSourceMemoryId,
      normalizedKind,
      clean(title),
      normalizedContent,
      unitInterval(confidence, "state promotion confidence"),
      new Date(normalizedKnownAt).toISOString(),
      new Date(normalizedValidFrom).toISOString(),
      normalizedPolicyVersion,
      normalizedSourceSnapshotHash,
      normalizedProposalHash,
      canonicalJson(metadata, {}),
      timestamp,
      timestamp,
    );
    const stored = this.database.prepare(`
      SELECT id FROM memory_state_promotion_proposals
      WHERE agent_id = ? AND proposal_hash = ?
    `).get(normalizedAgentId, normalizedProposalHash);
    return {
      ...this.getStatePromotionProposal(normalizedAgentId, stored.id),
      wasInserted: Number(insertion.changes || 0) === 1,
    };
  }

  getStatePromotionProposal(agentId, proposalId) {
    return normalizeStatePromotionProposal(this.database.prepare(`
      SELECT * FROM memory_state_promotion_proposals WHERE agent_id = ? AND id = ?
    `).get(clean(agentId), clean(proposalId)));
  }

  listStatePromotionProposals(agentId, {
    reviewStates = [],
    stateFamily = "",
    canonicalKey = "",
    limit = 100,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listStatePromotionProposals requires agentId.");
    const states = cleanStringList(Array.isArray(reviewStates) ? reviewStates : [reviewStates]);
    if (states.some((state) => !["pending", "accepted", "dismissed", "revoked"].includes(state))) {
      throw new Error("Unknown state promotion proposal review state.");
    }
    const normalizedFamily = clean(stateFamily);
    if (normalizedFamily && !MEMORY_STATE_FAMILIES.includes(normalizedFamily)) {
      throw new Error("Unknown state promotion proposal family.");
    }
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (states.length) {
      clauses.push(`review_state IN (${states.map(() => "?").join(", ")})`);
      parameters.push(...states);
    }
    if (normalizedFamily) {
      clauses.push("state_family = ?");
      parameters.push(normalizedFamily);
    }
    if (clean(canonicalKey)) {
      clauses.push("canonical_key = ?");
      parameters.push(clean(canonicalKey).toLocaleLowerCase("en-US"));
    }
    const rows = this.database.prepare(`
      SELECT id FROM memory_state_promotion_proposals
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(...parameters, Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100))));
    return rows.map((row) => this.getStatePromotionProposal(normalizedAgentId, row.id));
  }

  resolveStatePromotionProposalRecord({
    agentId,
    proposalId,
    resolution,
    resultMemoryId = null,
    resolvedBy = "human",
    note = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const proposal = this.getStatePromotionProposal(normalizedAgentId, proposalId);
    if (!proposal) throw new Error("State promotion proposal does not exist for this Agent.");
    if (proposal.review_state !== "pending") {
      throw new Error(`State promotion proposal is already ${proposal.review_state}.`);
    }
    const normalizedResolution = clean(resolution);
    if (!["accepted", "dismissed"].includes(normalizedResolution)) {
      throw new Error("Unknown state promotion proposal resolution.");
    }
    const normalizedResultMemoryId = clean(resultMemoryId) || null;
    if (normalizedResolution === "accepted") {
      const result = this.getMemory(normalizedResultMemoryId);
      if (!result || result.agent_id !== normalizedAgentId
        || result.subject_role !== proposal.subject_role
        || result.subject_key !== proposal.subject_key
        || result.canonical_key !== proposal.canonical_key
        || result.state_family !== proposal.state_family
        || result.state_scope_key !== proposal.state_scope_key
        || result.representation_layer !== "established"
        || result.status !== "active") {
        throw new Error("Accepted state promotion requires its exact established result.");
      }
    } else if (normalizedResultMemoryId) {
      throw new Error("Dismissed state promotion cannot reference a result memory.");
    }
    const timestamp = nowIso();
    const update = this.database.prepare(`
      UPDATE memory_state_promotion_proposals
      SET review_state = ?, result_memory_id = ?, resolution_note = ?, resolved_by = ?,
          resolved_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND review_state = 'pending'
    `).run(
      normalizedResolution,
      normalizedResultMemoryId,
      clean(note),
      clean(resolvedBy) || "human",
      timestamp,
      timestamp,
      normalizedAgentId,
      proposal.id,
    );
    if (Number(update.changes || 0) !== 1) {
      throw new Error("State promotion proposal changed while being resolved.");
    }
    return this.getStatePromotionProposal(normalizedAgentId, proposal.id);
  }

  revokeStatePromotionProposalRecord({
    agentId,
    proposalId,
    revokedBy = "human",
    note = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const proposal = this.getStatePromotionProposal(normalizedAgentId, proposalId);
    if (!proposal) throw new Error("State promotion proposal does not exist for this Agent.");
    if (proposal.review_state !== "accepted") {
      throw new Error(`Only an accepted state promotion can be revoked; it is ${proposal.review_state}.`);
    }
    const timestamp = nowIso();
    const update = this.database.prepare(`
      UPDATE memory_state_promotion_proposals
      SET review_state = 'revoked', revoked_by = ?, revocation_note = ?,
          revoked_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND review_state = 'accepted'
    `).run(
      clean(revokedBy) || "human",
      clean(note),
      timestamp,
      timestamp,
      normalizedAgentId,
      proposal.id,
    );
    if (Number(update.changes || 0) !== 1) {
      throw new Error("State promotion proposal changed while being revoked.");
    }
    return this.getStatePromotionProposal(normalizedAgentId, proposal.id);
  }

  recordConsolidationRun({
    id,
    agentId,
    policyVersion,
    triggerIds = [],
    candidateIds = [],
    candidateReasons = {},
    graphEdgeIds = [],
    inputHash,
    metadata = {},
    createdAt = nowIso(),
  }) {
    const runId = clean(id);
    const normalizedAgentId = clean(agentId);
    const normalizedPolicyVersion = clean(policyVersion);
    const normalizedInputHash = clean(inputHash);
    const normalizedTriggers = cleanStringList(triggerIds).sort();
    const normalizedCandidates = cleanStringList(candidateIds).sort();
    const normalizedEdges = cleanStringList(graphEdgeIds).sort();
    if (!runId || !normalizedAgentId || !normalizedPolicyVersion
      || !normalizedInputHash || !normalizedTriggers.length) {
      throw new Error("Consolidation run record is incomplete.");
    }
    const triggerSet = new Set(normalizedTriggers);
    if (normalizedCandidates.some((id) => triggerSet.has(id))) {
      throw new Error("Consolidation candidates cannot repeat trigger memories.");
    }
    const memoryIds = [...normalizedTriggers, ...normalizedCandidates];
    if (memoryIds.length) {
      const rows = this.database.prepare(`
        SELECT id FROM memory_nodes
        WHERE agent_id = ? AND status <> 'deleted'
          AND id IN (${memoryIds.map(() => "?").join(", ")})
      `).all(normalizedAgentId, ...memoryIds);
      if (rows.length !== memoryIds.length) {
        throw new Error("Every consolidation memory must exist for the same Agent.");
      }
    }
    if (normalizedEdges.length) {
      const rows = this.database.prepare(`
        SELECT id FROM memory_edges
        WHERE agent_id = ? AND id IN (${normalizedEdges.map(() => "?").join(", ")})
      `).all(normalizedAgentId, ...normalizedEdges);
      if (rows.length !== normalizedEdges.length) {
        throw new Error("Every consolidation graph edge must belong to the same Agent.");
      }
    }
    const normalizedReasons = candidateReasons && typeof candidateReasons === "object"
      && !Array.isArray(candidateReasons) ? candidateReasons : {};
    if (Object.keys(normalizedReasons).some((id) => !normalizedCandidates.includes(id))) {
      throw new Error("Consolidation reasons can reference only selected candidates.");
    }
    const owner = this.database.prepare(`
      SELECT agent_id FROM memory_consolidation_runs WHERE id = ?
    `).get(runId);
    if (owner && owner.agent_id !== normalizedAgentId) {
      throw new Error("Consolidation run id already belongs to another Agent.");
    }
    const timestamp = clean(createdAt) || nowIso();
    const insertion = this.database.prepare(`
      INSERT INTO memory_consolidation_runs (
        id, agent_id, policy_version, trigger_ids_json, candidate_ids_json,
        candidate_reasons_json, graph_edge_ids_json, input_hash, status,
        metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?)
      ON CONFLICT(agent_id, policy_version, input_hash) DO NOTHING
    `).run(
      runId,
      normalizedAgentId,
      normalizedPolicyVersion,
      json(normalizedTriggers, []),
      json(normalizedCandidates, []),
      json(normalizedReasons, {}),
      json(normalizedEdges, []),
      normalizedInputHash,
      json(metadata, {}),
      timestamp,
      timestamp,
    );
    const stored = this.database.prepare(`
      SELECT id FROM memory_consolidation_runs
      WHERE agent_id = ? AND policy_version = ? AND input_hash = ?
    `).get(normalizedAgentId, normalizedPolicyVersion, normalizedInputHash);
    return {
      ...this.getConsolidationRun(normalizedAgentId, stored.id),
      wasInserted: Number(insertion.changes || 0) === 1,
    };
  }

  getConsolidationRun(agentId, runId) {
    return normalizeConsolidationRun(this.database.prepare(`
      SELECT * FROM memory_consolidation_runs WHERE agent_id = ? AND id = ?
    `).get(clean(agentId), clean(runId)));
  }

  listConsolidationRuns(agentId, { statuses = [], limit = 100, order = "desc" } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listConsolidationRuns requires agentId.");
    const normalizedOrder = clean(order).toLowerCase();
    if (!["asc", "desc"].includes(normalizedOrder)) {
      throw new Error("Consolidation run order must be asc or desc.");
    }
    const normalizedStatuses = cleanStringList(Array.isArray(statuses) ? statuses : [statuses]);
    const allowed = new Set(["planned", "running", "completed", "no_proposals", "failed", "cancelled"]);
    if (normalizedStatuses.some((status) => !allowed.has(status))) {
      throw new Error("Unknown consolidation run status.");
    }
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (normalizedStatuses.length) {
      clauses.push(`status IN (${normalizedStatuses.map(() => "?").join(", ")})`);
      parameters.push(...normalizedStatuses);
    }
    return this.database.prepare(`
      SELECT * FROM memory_consolidation_runs
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ${normalizedOrder.toUpperCase()}, id ${normalizedOrder.toUpperCase()}
      LIMIT ?
    `).all(
      ...parameters,
      Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100))),
    ).map(normalizeConsolidationRun);
  }

  claimConsolidationRun({ agentId, runId }) {
    const normalizedAgentId = clean(agentId);
    const run = this.getConsolidationRun(normalizedAgentId, runId);
    if (!run) throw new Error("Consolidation run does not exist for this Agent.");
    if (run.status !== "planned") {
      throw new Error(`Consolidation run is already ${run.status}.`);
    }
    const timestamp = nowIso();
    const result = this.database.prepare(`
      UPDATE memory_consolidation_runs
      SET status = 'running', updated_at = ?
      WHERE agent_id = ? AND id = ? AND status = 'planned'
    `).run(timestamp, normalizedAgentId, run.id);
    if (Number(result.changes || 0) !== 1) {
      throw new Error("Consolidation run changed while it was being claimed.");
    }
    return this.getConsolidationRun(normalizedAgentId, run.id);
  }

  finishConsolidationRun({
    agentId,
    runId,
    status,
    structureProposalIds = [],
    relationProposalIds = [],
    errorMessage = "",
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedStatus = clean(status);
    if (!["completed", "no_proposals", "failed", "cancelled"].includes(normalizedStatus)) {
      throw new Error("A consolidation run can finish only with a terminal status.");
    }
    const run = this.getConsolidationRun(normalizedAgentId, runId);
    if (!run) throw new Error("Consolidation run does not exist for this Agent.");
    if (run.status !== "running") {
      throw new Error(`Consolidation run is already ${run.status}.`);
    }
    const structureIds = cleanStringList(structureProposalIds);
    const relationIds = cleanStringList(relationProposalIds);
    if (normalizedStatus === "completed" && !structureIds.length && !relationIds.length) {
      throw new Error("Completed consolidation run requires at least one proposal.");
    }
    if (["no_proposals", "cancelled"].includes(normalizedStatus)
      && (structureIds.length || relationIds.length)) {
      throw new Error(`${normalizedStatus} consolidation run cannot reference proposals.`);
    }
    if (structureIds.length) {
      const rows = this.database.prepare(`
        SELECT id FROM memory_structure_proposals
        WHERE agent_id = ? AND id IN (${structureIds.map(() => "?").join(", ")})
      `).all(normalizedAgentId, ...structureIds);
      if (rows.length !== structureIds.length) {
        throw new Error("Consolidation structure proposals must belong to the same Agent.");
      }
    }
    if (relationIds.length) {
      const rows = this.database.prepare(`
        SELECT id FROM memory_relation_proposals
        WHERE agent_id = ? AND id IN (${relationIds.map(() => "?").join(", ")})
      `).all(normalizedAgentId, ...relationIds);
      if (rows.length !== relationIds.length) {
        throw new Error("Consolidation relation proposals must belong to the same Agent.");
      }
    }
    const timestamp = nowIso();
    const result = this.database.prepare(`
      UPDATE memory_consolidation_runs
      SET status = ?, structure_proposal_ids_json = ?, relation_proposal_ids_json = ?,
          error_message = ?, completed_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND status = 'running'
    `).run(
      normalizedStatus,
      json(structureIds, []),
      json(relationIds, []),
      clean(errorMessage),
      timestamp,
      timestamp,
      normalizedAgentId,
      run.id,
    );
    if (Number(result.changes || 0) !== 1) {
      throw new Error("Consolidation run changed while it was being finished.");
    }
    return this.getConsolidationRun(normalizedAgentId, run.id);
  }

  upsertMemoryRole({
    memoryId,
    agentId,
    role,
    actorRole,
    actorKey = "",
    isPrimary = false,
    confidence = 1,
    provenance = "",
    metadata = {},
  }) {
    const normalizedMemoryId = clean(memoryId);
    const normalizedAgentId = clean(agentId);
    const normalizedRole = clean(role);
    const normalizedActorRole = clean(actorRole);
    const normalizedActorKey = clean(actorKey);
    const memory = this.getMemory(normalizedMemoryId);
    if (!memory || memory.agent_id !== normalizedAgentId) {
      throw new Error("Memory role requires an existing memory for the same Agent.");
    }
    if (!MEMORY_ACTOR_ROLES.includes(normalizedRole)) {
      throw new Error(`Unknown memory actor role: ${normalizedRole || "(empty)"}.`);
    }
    if (!SUBJECT_ROLES.includes(normalizedActorRole)) {
      throw new Error(`Unknown actor identity role: ${normalizedActorRole || "(empty)"}.`);
    }
    if (!["world", "unknown"].includes(normalizedActorRole) && !normalizedActorKey) {
      throw new Error("Memory actor role requires actorKey.");
    }
    const timestamp = nowIso();
    this.database.prepare(`
      INSERT INTO memory_actor_roles (
        memory_id, agent_id, role, actor_role, actor_key,
        is_primary, confidence, provenance, metadata_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id, role, actor_role, actor_key) DO UPDATE SET
        is_primary = excluded.is_primary,
        confidence = excluded.confidence,
        provenance = excluded.provenance,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      normalizedMemoryId,
      normalizedAgentId,
      normalizedRole,
      normalizedActorRole,
      normalizedActorKey,
      isPrimary ? 1 : 0,
      bounded(confidence, 1),
      clean(provenance),
      json(metadata, {}),
      timestamp,
      timestamp,
    );
    return normalizeMemoryRole(this.database.prepare(`
      SELECT * FROM memory_actor_roles
      WHERE memory_id = ? AND role = ? AND actor_role = ? AND actor_key = ?
    `).get(normalizedMemoryId, normalizedRole, normalizedActorRole, normalizedActorKey));
  }

  syncPrimarySubjectRole({ memoryId, agentId, actorRole, actorKey = "" }) {
    this.database.prepare(`
      DELETE FROM memory_actor_roles
      WHERE memory_id = ? AND role = 'subject' AND is_primary = 1
    `).run(memoryId);
    if (!SUBJECT_ROLES.includes(actorRole) || actorRole === "unknown") return null;
    return this.upsertMemoryRole({
      memoryId,
      agentId,
      role: "subject",
      actorRole,
      actorKey,
      isPrimary: true,
      confidence: 1,
      provenance: "memory-node-subject",
    });
  }

  listMemoryRoles(memoryId) {
    return this.database.prepare(`
      SELECT * FROM memory_actor_roles
      WHERE memory_id = ?
      ORDER BY is_primary DESC, role ASC, actor_role ASC, actor_key ASC
    `).all(memoryId).map(normalizeMemoryRole);
  }

  deleteMemoryRoles({
    agentId,
    memoryId,
    role = "",
    actorRole = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedMemoryId = clean(memoryId);
    if (!normalizedAgentId || !normalizedMemoryId) {
      throw new Error("Deleting memory roles requires agentId and memoryId.");
    }
    const memory = this.getMemory(normalizedMemoryId);
    if (!memory || memory.agent_id !== normalizedAgentId) {
      throw new Error("Memory roles can only be deleted from the same Agent.");
    }
    const clauses = ["agent_id = ?", "memory_id = ?"];
    const parameters = [normalizedAgentId, normalizedMemoryId];
    if (clean(role)) {
      clauses.push("role = ?");
      parameters.push(clean(role));
    }
    if (clean(actorRole)) {
      clauses.push("actor_role = ?");
      parameters.push(clean(actorRole));
    }
    return Number(this.database.prepare(`
      DELETE FROM memory_actor_roles WHERE ${clauses.join(" AND ")}
    `).run(...parameters).changes || 0);
  }

  recordIngestionDecision({
    id = "",
    agentId,
    batchId,
    candidateIndex,
    decision,
    resultStatus,
    reasonCodes = [],
    candidate = {},
    sourceRefs = [],
    sourceIds = [],
    knownAt = null,
    memoryId = null,
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedBatchId = clean(batchId);
    const normalizedDecision = clean(decision);
    const normalizedResultStatus = clean(resultStatus);
    const index = Number(candidateIndex);
    if (!normalizedAgentId || !normalizedBatchId || !Number.isInteger(index) || index < 0) {
      throw new Error("Ingestion decision requires agentId, batchId, and candidateIndex.");
    }
    if (!["store", "review", "reject"].includes(normalizedDecision)) {
      throw new Error(`Unknown ingestion decision: ${normalizedDecision || "(empty)"}.`);
    }
    if (!normalizedResultStatus) throw new Error("Ingestion decision requires resultStatus.");
    const normalizedMemoryId = clean(memoryId) || null;
    if (normalizedMemoryId) {
      const memory = this.getMemory(normalizedMemoryId);
      if (!memory || memory.agent_id !== normalizedAgentId) {
        throw new Error("Ingestion decision memory must belong to the same Agent.");
      }
    }
    const decisionId = clean(id) || stableId(
      "ingest",
      normalizedAgentId,
      normalizedBatchId,
      index,
    );
    const timestamp = nowIso();
    this.database.prepare(`
      INSERT INTO memory_ingestion_decisions (
        id, agent_id, batch_id, candidate_index, decision,
        result_status, review_state, reason_codes_json,
        candidate_json, source_refs_json, source_ids_json,
        known_at, memory_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, batch_id, candidate_index) DO NOTHING
    `).run(
      decisionId,
      normalizedAgentId,
      normalizedBatchId,
      index,
      normalizedDecision,
      normalizedResultStatus,
      normalizedDecision === "review" ? "pending" : "not_applicable",
      json(Array.isArray(reasonCodes) ? reasonCodes.map(clean).filter(Boolean) : [], []),
      json(candidate && typeof candidate === "object" ? candidate : {}, {}),
      json(Array.isArray(sourceRefs) ? sourceRefs.map(clean).filter(Boolean) : [], []),
      json(Array.isArray(sourceIds) ? sourceIds.map(clean).filter(Boolean) : [], []),
      clean(knownAt) || null,
      normalizedMemoryId,
      timestamp,
      timestamp,
    );
    return normalizeIngestionDecision(this.database.prepare(`
      SELECT * FROM memory_ingestion_decisions
      WHERE agent_id = ? AND batch_id = ? AND candidate_index = ?
    `).get(normalizedAgentId, normalizedBatchId, index));
  }

  listIngestionDecisions(agentId, {
    batchId = "",
    reviewState = "",
    limit = 100,
  } = {}) {
    const clauses = ["agent_id = ?"];
    const parameters = [clean(agentId)];
    if (!parameters[0]) throw new Error("listIngestionDecisions requires agentId.");
    if (clean(batchId)) {
      clauses.push("batch_id = ?");
      parameters.push(clean(batchId));
    }
    if (clean(reviewState)) {
      clauses.push("review_state = ?");
      parameters.push(clean(reviewState));
    }
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100)));
    return this.database.prepare(`
      SELECT * FROM memory_ingestion_decisions
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, candidate_index ASC
      LIMIT ?
    `).all(...parameters, maximum).map(normalizeIngestionDecision);
  }

  getIngestionDecision(agentId, decisionId) {
    return normalizeIngestionDecision(this.database.prepare(`
      SELECT * FROM memory_ingestion_decisions
      WHERE agent_id = ? AND id = ?
    `).get(clean(agentId), clean(decisionId)));
  }

  resolveIngestionDecision({
    agentId,
    decisionId,
    resolution,
    memoryId = null,
    resolvedCandidate = {},
    note = "",
    resolvedBy = "human",
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedDecisionId = clean(decisionId);
    const normalizedResolution = clean(resolution);
    if (!normalizedAgentId || !normalizedDecisionId) {
      throw new Error("Resolving an ingestion decision requires agentId and decisionId.");
    }
    if (!["accepted", "dismissed"].includes(normalizedResolution)) {
      throw new Error(`Unknown ingestion resolution: ${normalizedResolution || "(empty)"}.`);
    }
    const existing = this.getIngestionDecision(normalizedAgentId, normalizedDecisionId);
    if (!existing) throw new Error("Ingestion decision does not exist for this Agent.");
    if (existing.review_state !== "pending") {
      throw new Error(`Ingestion decision is already ${existing.review_state}.`);
    }
    const normalizedMemoryId = clean(memoryId) || null;
    if (normalizedResolution === "accepted") {
      if (!normalizedMemoryId) throw new Error("Accepted ingestion decision requires memoryId.");
      const memory = this.getMemory(normalizedMemoryId);
      if (!memory || memory.agent_id !== normalizedAgentId) {
        throw new Error("Accepted memory must belong to the same Agent.");
      }
    } else if (normalizedMemoryId) {
      throw new Error("Dismissed ingestion decision cannot link a memory.");
    }
    const timestamp = nowIso();
    const result = this.database.prepare(`
      UPDATE memory_ingestion_decisions
      SET review_state = ?, memory_id = ?, resolved_candidate_json = ?,
          resolution_note = ?, resolved_by = ?, resolved_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND review_state = 'pending'
    `).run(
      normalizedResolution,
      normalizedMemoryId,
      json(resolvedCandidate && typeof resolvedCandidate === "object" ? resolvedCandidate : {}, {}),
      clean(note),
      clean(resolvedBy) || "human",
      timestamp,
      timestamp,
      normalizedAgentId,
      normalizedDecisionId,
    );
    if (Number(result.changes) !== 1) {
      throw new Error("Ingestion decision changed before it could be resolved.");
    }
    return this.getIngestionDecision(normalizedAgentId, normalizedDecisionId);
  }

  recordSubjectAttributionProposal({
    id = "",
    agentId,
    memoryId,
    proposedSubjectRole,
    proposedSubjectKey = "",
    actorRoles = [],
    allowedActors = [],
    sourceIds = [],
    sourceSnapshotHash,
    proposalHash = "",
    policyVersion,
    confidence,
    rationale,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedMemoryId = clean(memoryId);
    const normalizedSubjectRole = clean(proposedSubjectRole);
    const normalizedSubjectKey = clean(proposedSubjectKey);
    const normalizedSourceIds = cleanStringList(sourceIds);
    const normalizedPolicyVersion = clean(policyVersion);
    const normalizedRationale = clean(rationale);
    const normalizedSnapshotHash = clean(sourceSnapshotHash);
    if (!normalizedAgentId || !normalizedMemoryId) {
      throw new Error("Subject attribution proposal requires agentId and memoryId.");
    }
    const memory = this.getMemory(normalizedMemoryId);
    if (!memory || memory.agent_id !== normalizedAgentId) {
      throw new Error("Subject attribution target must exist for the same Agent.");
    }
    if (!["user", "agent", "shared", "other", "world"].includes(normalizedSubjectRole)) {
      throw new Error("Subject attribution proposal requires a concrete subject role.");
    }
    if (normalizedSubjectRole !== "world" && !normalizedSubjectKey) {
      throw new Error("Subject attribution proposal requires proposedSubjectKey.");
    }
    if (!normalizedSourceIds.length || normalizedSnapshotHash.length !== 64) {
      throw new Error("Subject attribution proposal requires an evidence snapshot.");
    }
    if (!normalizedPolicyVersion || !normalizedRationale) {
      throw new Error("Subject attribution proposal requires policyVersion and rationale.");
    }
    const evidenceRows = this.database.prepare(`
      SELECT source.id
      FROM memory_sources AS link
      JOIN source_records AS source ON source.id = link.source_id
      WHERE link.memory_id = ? AND source.agent_id = ?
    `).all(normalizedMemoryId, normalizedAgentId);
    const linkedSources = new Set(evidenceRows.map((row) => row.id));
    if (normalizedSourceIds.some((sourceId) => !linkedSources.has(sourceId))) {
      throw new Error("Subject attribution evidence must already be linked to the target memory.");
    }
    const normalizedRoles = Array.isArray(actorRoles) ? actorRoles : [];
    const normalizedAllowedActors = Array.isArray(allowedActors) ? allowedActors : [];
    const normalizedProposalHash = clean(proposalHash) || canonicalHash({
      agentId: normalizedAgentId,
      memoryId: normalizedMemoryId,
      proposedSubjectRole: normalizedSubjectRole,
      proposedSubjectKey: normalizedSubjectKey,
      actorRoles: normalizedRoles,
      allowedActors: normalizedAllowedActors,
      sourceIds: normalizedSourceIds,
      sourceSnapshotHash: normalizedSnapshotHash,
      policyVersion: normalizedPolicyVersion,
    });
    if (normalizedProposalHash.length !== 64) {
      throw new Error("Subject attribution proposalHash must be a SHA-256 hash.");
    }
    const proposalId = clean(id) || `subject-attribution-${randomUUID()}`;
    const timestamp = nowIso();
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO memory_subject_attribution_proposals (
          id, memory_id, agent_id, proposed_subject_role, proposed_subject_key,
          actor_roles_json, allowed_actors_json, source_snapshot_hash,
          proposal_hash, policy_version, confidence, rationale,
          review_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        ON CONFLICT(agent_id, proposal_hash) DO NOTHING
      `).run(
        proposalId,
        normalizedMemoryId,
        normalizedAgentId,
        normalizedSubjectRole,
        normalizedSubjectKey,
        canonicalJson(normalizedRoles, []),
        canonicalJson(normalizedAllowedActors, []),
        normalizedSnapshotHash,
        normalizedProposalHash,
        normalizedPolicyVersion,
        unitInterval(confidence, "Subject attribution confidence"),
        normalizedRationale,
        timestamp,
        timestamp,
      );
      const stored = this.database.prepare(`
        SELECT id FROM memory_subject_attribution_proposals
        WHERE agent_id = ? AND proposal_hash = ?
      `).get(normalizedAgentId, normalizedProposalHash);
      const insertEvidence = this.database.prepare(`
        INSERT OR IGNORE INTO memory_subject_attribution_proposal_evidence (
          proposal_id, agent_id, source_id, ordinal
        ) VALUES (?, ?, ?, ?)
      `);
      normalizedSourceIds.forEach((sourceId, ordinal) => {
        insertEvidence.run(stored.id, normalizedAgentId, sourceId, ordinal);
      });
    });
    return this.database.prepare(`
      SELECT id FROM memory_subject_attribution_proposals
      WHERE agent_id = ? AND proposal_hash = ?
    `).get(normalizedAgentId, normalizedProposalHash)?.id;
  }

  getSubjectAttributionProposal(agentId, proposalId) {
    const normalizedAgentId = clean(agentId);
    const normalizedProposalId = clean(proposalId);
    const row = this.database.prepare(`
      SELECT * FROM memory_subject_attribution_proposals
      WHERE agent_id = ? AND id = ?
    `).get(normalizedAgentId, normalizedProposalId);
    if (!row) return null;
    const sourceIds = this.database.prepare(`
      SELECT source_id FROM memory_subject_attribution_proposal_evidence
      WHERE agent_id = ? AND proposal_id = ?
      ORDER BY ordinal ASC
    `).all(normalizedAgentId, normalizedProposalId).map((item) => item.source_id);
    return normalizeSubjectAttributionProposal(row, sourceIds);
  }

  listSubjectAttributionProposals(agentId, {
    reviewStates = [],
    memoryId = "",
    limit = 100,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listSubjectAttributionProposals requires agentId.");
    const states = cleanStringList(reviewStates);
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (states.length) {
      clauses.push(`review_state IN (${states.map(() => "?").join(", ")})`);
      parameters.push(...states);
    }
    if (clean(memoryId)) {
      clauses.push("memory_id = ?");
      parameters.push(clean(memoryId));
    }
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100)));
    return this.database.prepare(`
      SELECT id FROM memory_subject_attribution_proposals
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...parameters, maximum).map((row) => (
      this.getSubjectAttributionProposal(normalizedAgentId, row.id)
    ));
  }

  resolveSubjectAttributionProposalRecord({
    agentId,
    proposalId,
    resolution,
    resolvedBy = "human",
    note = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedProposalId = clean(proposalId);
    const normalizedResolution = clean(resolution);
    if (!normalizedAgentId || !normalizedProposalId) {
      throw new Error("Resolving subject attribution requires agentId and proposalId.");
    }
    if (!["accepted", "dismissed"].includes(normalizedResolution)) {
      throw new Error("Subject attribution resolution must be accepted or dismissed.");
    }
    const timestamp = nowIso();
    const result = this.database.prepare(`
      UPDATE memory_subject_attribution_proposals
      SET review_state = ?, resolved_by = ?, resolution_note = ?,
          resolved_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND review_state = 'pending'
    `).run(
      normalizedResolution,
      clean(resolvedBy) || "human",
      clean(note),
      timestamp,
      timestamp,
      normalizedAgentId,
      normalizedProposalId,
    );
    if (Number(result.changes || 0) !== 1) {
      throw new Error("Subject attribution proposal changed before it could be resolved.");
    }
    return this.getSubjectAttributionProposal(normalizedAgentId, normalizedProposalId);
  }

  recordRetrievalTrace({
    id = "",
    agentId,
    queryText = "",
    recallIntent = "",
    chainMode = "",
    resultStatus,
    retrievalMode = "",
    seedIds = [],
    selectedIds = [],
    paths = [],
    matchedEntityIds = [],
    contextChars = 0,
    candidateCount = 0,
    vectorStatus = "",
    metadata = {},
    createdAt = "",
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedStatus = clean(resultStatus);
    if (!normalizedAgentId || !normalizedStatus) {
      throw new Error("Retrieval trace requires agentId and resultStatus.");
    }
    const normalizedQuery = clean(queryText);
    const traceId = clean(id) || `trace-${randomUUID()}`;
    const timestamp = clean(createdAt) || nowIso();
    this.database.prepare(`
      INSERT INTO memory_retrieval_traces (
        id, agent_id, query_text, query_hash, recall_intent, chain_mode,
        result_status, retrieval_mode, seed_ids_json, selected_ids_json,
        paths_json, matched_entity_ids_json, context_chars, candidate_count,
        vector_status, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      traceId,
      normalizedAgentId,
      normalizedQuery,
      createHash("sha256").update(normalizedQuery).digest("hex"),
      clean(recallIntent),
      clean(chainMode),
      normalizedStatus,
      clean(retrievalMode),
      json(cleanStringList(seedIds), []),
      json(cleanStringList(selectedIds), []),
      json(Array.isArray(paths) ? paths : [], []),
      json(cleanStringList(matchedEntityIds), []),
      Math.max(0, Math.trunc(Number(contextChars) || 0)),
      Math.max(0, Math.trunc(Number(candidateCount) || 0)),
      clean(vectorStatus),
      json(metadata && typeof metadata === "object" ? metadata : {}, {}),
      timestamp,
    );
    return this.getRetrievalTrace(normalizedAgentId, traceId);
  }

  getRetrievalTrace(agentId, traceId) {
    return normalizeRetrievalTrace(this.database.prepare(`
      SELECT * FROM memory_retrieval_traces
      WHERE agent_id = ? AND id = ?
    `).get(clean(agentId), clean(traceId)));
  }

  listRetrievalTraces(agentId, {
    resultStatus = "",
    limit = 100,
    offset = 0,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listRetrievalTraces requires agentId.");
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (clean(resultStatus)) {
      clauses.push("result_status = ?");
      parameters.push(clean(resultStatus));
    }
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100)));
    const skip = Math.max(0, Math.trunc(Number(offset) || 0));
    return this.database.prepare(`
      SELECT * FROM memory_retrieval_traces
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...parameters, maximum, skip).map(normalizeRetrievalTrace);
  }

  recordRetrievalFeedback({
    id = "",
    agentId,
    traceId,
    signal,
    targetMemoryIds = [],
    note = "",
    metadata = {},
    createdAt = "",
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedTraceId = clean(traceId);
    const normalizedSignal = clean(signal);
    if (!normalizedAgentId || !normalizedTraceId || !normalizedSignal) {
      throw new Error("Retrieval feedback requires agentId, traceId, and signal.");
    }
    if (!RETRIEVAL_FEEDBACK_SIGNALS.includes(normalizedSignal)) {
      throw new Error(`Unknown retrieval feedback signal: ${normalizedSignal}.`);
    }
    if (!this.getRetrievalTrace(normalizedAgentId, normalizedTraceId)) {
      throw new Error("Retrieval trace does not exist for this Agent.");
    }
    const normalizedTargetIds = cleanStringList(targetMemoryIds);
    if (normalizedTargetIds.some((memoryId) => {
      const memory = this.getMemory(memoryId);
      return !memory || memory.agent_id !== normalizedAgentId;
    })) {
      throw new Error("Retrieval feedback targets must exist for the same Agent.");
    }
    const feedbackId = clean(id) || `feedback-${randomUUID()}`;
    this.database.prepare(`
      INSERT INTO memory_retrieval_feedback (
        id, trace_id, agent_id, signal, target_memory_ids_json,
        note, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      feedbackId,
      normalizedTraceId,
      normalizedAgentId,
      normalizedSignal,
      json(normalizedTargetIds, []),
      clean(note),
      json(metadata && typeof metadata === "object" ? metadata : {}, {}),
      clean(createdAt) || nowIso(),
    );
    return normalizeRetrievalFeedback(this.database.prepare(`
      SELECT * FROM memory_retrieval_feedback WHERE id = ?
    `).get(feedbackId));
  }

  listRetrievalFeedback(agentId, traceId) {
    const normalizedAgentId = clean(agentId);
    const normalizedTraceId = clean(traceId);
    if (!normalizedAgentId || !normalizedTraceId) {
      throw new Error("listRetrievalFeedback requires agentId and traceId.");
    }
    return this.database.prepare(`
      SELECT * FROM memory_retrieval_feedback
      WHERE agent_id = ? AND trace_id = ?
      ORDER BY created_at ASC
    `).all(normalizedAgentId, normalizedTraceId).map(normalizeRetrievalFeedback);
  }

  findLatestUnboundRetrievalTrace(agentId, sessionId) {
    const normalizedAgentId = clean(agentId);
    const normalizedSessionId = clean(sessionId);
    if (!normalizedAgentId || !normalizedSessionId) {
      throw new Error("Finding an unbound retrieval trace requires agentId and sessionId.");
    }
    return normalizeRetrievalTrace(this.database.prepare(`
      SELECT trace.*
      FROM memory_retrieval_traces AS trace
      WHERE trace.agent_id = ?
        AND trace.result_status = 'ready'
        AND json_array_length(trace.selected_ids_json) > 0
        AND COALESCE(
          json_extract(trace.metadata_json, '$.runtimeSessionKey'),
          json_extract(trace.metadata_json, '$.runtimeSessionId')
        ) = ?
        AND NOT EXISTS (
          SELECT 1 FROM memory_retrieval_usage_requests AS request
          WHERE request.agent_id = trace.agent_id AND request.trace_id = trace.id
        )
      ORDER BY trace.created_at DESC, trace.id DESC
      LIMIT 1
    `).get(normalizedAgentId, normalizedSessionId));
  }

  setRetrievalSessionHead({ agentId, sessionId, traceId = "", updatedAt = "" } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedSessionId = clean(sessionId);
    const normalizedTraceId = clean(traceId);
    if (!normalizedAgentId || !normalizedSessionId) {
      throw new Error("Retrieval session head requires agentId and sessionId.");
    }
    if (!normalizedTraceId) {
      this.database.prepare(`
        DELETE FROM memory_retrieval_session_heads WHERE agent_id = ? AND session_id = ?
      `).run(normalizedAgentId, normalizedSessionId);
      return null;
    }
    const trace = this.getRetrievalTrace(normalizedAgentId, normalizedTraceId);
    if (!trace || trace.result_status !== "ready" || !trace.selectedIds.length) {
      throw new Error("Retrieval session head requires a ready trace with selected memories.");
    }
    const traceSessionId = clean(
      trace.metadata?.runtimeSessionKey || trace.metadata?.runtimeSessionId,
    );
    if (traceSessionId && traceSessionId !== normalizedSessionId) {
      throw new Error("Retrieval session head does not match its trace session.");
    }
    this.database.prepare(`
      INSERT INTO memory_retrieval_session_heads (agent_id, session_id, trace_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id, session_id) DO UPDATE SET
        trace_id = excluded.trace_id,
        updated_at = excluded.updated_at
    `).run(
      normalizedAgentId,
      normalizedSessionId,
      normalizedTraceId,
      clean(updatedAt) || nowIso(),
    );
    return this.getRetrievalSessionHead(normalizedAgentId, normalizedSessionId);
  }

  getRetrievalSessionHead(agentId, sessionId) {
    const normalizedAgentId = clean(agentId);
    const normalizedSessionId = clean(sessionId);
    if (!normalizedAgentId || !normalizedSessionId) return null;
    const row = this.database.prepare(`
      SELECT * FROM memory_retrieval_session_heads
      WHERE agent_id = ? AND session_id = ?
    `).get(normalizedAgentId, normalizedSessionId);
    return row ? { ...row } : null;
  }

  bindRetrievalUsageResponse({
    agentId,
    sessionId,
    responseText,
    metadata = {},
    createdAt = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedSessionId = clean(sessionId);
    if (!normalizedAgentId || !normalizedSessionId) {
      throw new Error("Binding retrieval usage requires agentId and sessionId.");
    }
    return this.transaction(() => {
      const head = this.getRetrievalSessionHead(normalizedAgentId, normalizedSessionId);
      if (!head) return null;
      const request = this.recordRetrievalUsageRequest({
        agentId: normalizedAgentId,
        traceId: head.trace_id,
        sessionId: normalizedSessionId,
        responseText,
        metadata,
        createdAt,
      });
      this.setRetrievalSessionHead({
        agentId: normalizedAgentId,
        sessionId: normalizedSessionId,
        traceId: "",
      });
      return request;
    });
  }

  recordRetrievalUsageRequest({
    id = "",
    agentId,
    traceId,
    sessionId,
    responseText,
    metadata = {},
    createdAt = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedTraceId = clean(traceId);
    const normalizedSessionId = clean(sessionId);
    const normalizedResponse = clean(responseText);
    if (!normalizedAgentId || !normalizedTraceId || !normalizedSessionId || !normalizedResponse) {
      throw new Error("Retrieval usage request requires agentId, traceId, sessionId, and responseText.");
    }
    const trace = this.getRetrievalTrace(normalizedAgentId, normalizedTraceId);
    if (!trace || trace.result_status !== "ready" || !trace.selectedIds.length) {
      throw new Error("Retrieval usage request requires a ready trace with selected memories.");
    }
    const traceSessionId = clean(
      trace.metadata?.runtimeSessionKey || trace.metadata?.runtimeSessionId,
    );
    if (traceSessionId && traceSessionId !== normalizedSessionId) {
      throw new Error("Retrieval usage request session does not match its trace.");
    }
    const responseHash = createHash("sha256").update(normalizedResponse).digest("hex");
    const existing = normalizeRetrievalUsageRequest(this.database.prepare(`
      SELECT * FROM memory_retrieval_usage_requests
      WHERE agent_id = ? AND trace_id = ?
    `).get(normalizedAgentId, normalizedTraceId));
    if (existing) {
      if (existing.session_id !== normalizedSessionId || existing.response_hash !== responseHash) {
        throw new Error("Retrieval trace is already bound to a different response.");
      }
      return { ...existing, wasInserted: false };
    }
    const requestId = clean(id) || stableId(
      "retrieval-usage-request",
      normalizedAgentId,
      normalizedTraceId,
    );
    const timestamp = clean(createdAt) || nowIso();
    this.database.prepare(`
      INSERT INTO memory_retrieval_usage_requests (
        id, trace_id, agent_id, session_id, response_text, response_hash,
        status, result_json, error_message, metadata_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', '{}', '', ?, ?, ?)
    `).run(
      requestId,
      normalizedTraceId,
      normalizedAgentId,
      normalizedSessionId,
      normalizedResponse,
      responseHash,
      canonicalJson(metadata, {}),
      timestamp,
      timestamp,
    );
    return { ...this.getRetrievalUsageRequest(normalizedAgentId, requestId), wasInserted: true };
  }

  getRetrievalUsageRequest(agentId, requestId) {
    return normalizeRetrievalUsageRequest(this.database.prepare(`
      SELECT * FROM memory_retrieval_usage_requests
      WHERE agent_id = ? AND id = ?
    `).get(clean(agentId), clean(requestId)));
  }

  listRetrievalUsageRequests(agentId, {
    statuses = [],
    sessionId = "",
    limit = 100,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listRetrievalUsageRequests requires agentId.");
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    const normalizedStatuses = cleanStringList(statuses);
    if (normalizedStatuses.length) {
      clauses.push(`status IN (${normalizedStatuses.map(() => "?").join(", ")})`);
      parameters.push(...normalizedStatuses);
    }
    if (clean(sessionId)) {
      clauses.push("session_id = ?");
      parameters.push(clean(sessionId));
    }
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100)));
    return this.database.prepare(`
      SELECT * FROM memory_retrieval_usage_requests
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(...parameters, maximum).map(normalizeRetrievalUsageRequest);
  }

  recordRetrievalUsageAnalysisRun({
    id = "",
    agentId,
    requestId,
    traceId,
    provider = "",
    model = "",
    promptVersion,
    schemaVersion,
    inputHash,
    status,
    output = {},
    usage = {},
    requestExternalId = "",
    durationMs = 0,
    errorMessage = "",
    metadata = {},
    createdAt = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedRequestId = clean(requestId);
    const normalizedTraceId = clean(traceId);
    const normalizedStatus = clean(status);
    const normalizedInputHash = clean(inputHash);
    if (!normalizedAgentId || !normalizedRequestId || !normalizedTraceId
      || !clean(promptVersion) || !clean(schemaVersion)
      || normalizedInputHash.length !== 64
      || !["completed", "rejected", "failed"].includes(normalizedStatus)) {
      throw new Error("Retrieval usage analysis run is incomplete.");
    }
    const request = this.getRetrievalUsageRequest(normalizedAgentId, normalizedRequestId);
    if (!request || request.trace_id !== normalizedTraceId) {
      throw new Error("Retrieval usage analysis run does not match its request.");
    }
    const runId = clean(id) || `retrieval-usage-run-${randomUUID()}`;
    this.database.prepare(`
      INSERT INTO memory_retrieval_usage_analysis_runs (
        id, request_id, trace_id, agent_id, provider, model,
        prompt_version, schema_version, input_hash, status,
        output_json, usage_json, request_external_id, duration_ms,
        error_message, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      normalizedRequestId,
      normalizedTraceId,
      normalizedAgentId,
      clean(provider),
      clean(model),
      clean(promptVersion),
      clean(schemaVersion),
      normalizedInputHash,
      normalizedStatus,
      canonicalJson(output, {}),
      canonicalJson(usage, {}),
      clean(requestExternalId),
      Math.max(0, Math.trunc(Number(durationMs) || 0)),
      clean(errorMessage),
      canonicalJson(metadata, {}),
      clean(createdAt) || nowIso(),
    );
    return normalizeRetrievalUsageAnalysisRun(this.database.prepare(`
      SELECT * FROM memory_retrieval_usage_analysis_runs WHERE id = ?
    `).get(runId));
  }

  resolveRetrievalUsageRequest({
    agentId,
    requestId,
    status,
    result = {},
    errorMessage = "",
    resolvedAt = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedRequestId = clean(requestId);
    const normalizedStatus = clean(status);
    if (!normalizedAgentId || !normalizedRequestId
      || !["completed", "blocked", "cancelled"].includes(normalizedStatus)) {
      throw new Error("Resolving retrieval usage request requires a terminal status.");
    }
    const timestamp = clean(resolvedAt) || nowIso();
    const update = this.database.prepare(`
      UPDATE memory_retrieval_usage_requests
      SET status = ?, result_json = ?, error_message = ?, resolved_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND status = 'pending'
    `).run(
      normalizedStatus,
      canonicalJson(result, {}),
      clean(errorMessage),
      timestamp,
      timestamp,
      normalizedAgentId,
      normalizedRequestId,
    );
    if (Number(update.changes || 0) !== 1) {
      throw new Error("Retrieval usage request is missing or no longer pending.");
    }
    return this.getRetrievalUsageRequest(normalizedAgentId, normalizedRequestId);
  }

  listMemoryRetrievalStats(agentId, {
    memoryIds = [],
    limit = 200,
    requireComplete = false,
    windowStart = "",
    windowEnd = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listMemoryRetrievalStats requires agentId.");
    const requestedIds = cleanStringList(memoryIds);
    const window = normalizeTimeWindow(windowStart, windowEnd);
    const traceClauses = ["trace.agent_id = ?", "trace.result_status = 'ready'"];
    const traceParameters = [normalizedAgentId];
    if (window.start) {
      traceClauses.push("trace.created_at >= ?");
      traceParameters.push(window.start);
    }
    if (window.end) {
      traceClauses.push("trace.created_at < ?");
      traceParameters.push(window.end);
    }
    if (requestedIds.length) {
      traceClauses.push(`node.id IN (${requestedIds.map(() => "?").join(", ")})`);
      traceParameters.push(...requestedIds);
    }
    const feedbackClauses = ["feedback.agent_id = ?"];
    const feedbackParameters = [normalizedAgentId];
    if (window.start) {
      feedbackClauses.push("feedback.created_at >= ?");
      feedbackParameters.push(window.start);
    }
    if (window.end) {
      feedbackClauses.push("feedback.created_at < ?");
      feedbackParameters.push(window.end);
    }
    if (requestedIds.length) {
      feedbackClauses.push(`node.id IN (${requestedIds.map(() => "?").join(", ")})`);
      feedbackParameters.push(...requestedIds);
    }
    const selectedRows = this.database.prepare(`
      SELECT item.value AS memory_id, COUNT(DISTINCT trace.id) AS selected_count,
             MAX(trace.created_at) AS last_selected_at
      FROM memory_retrieval_traces AS trace
      JOIN json_each(trace.selected_ids_json) AS item
      JOIN memory_nodes AS node ON node.id = item.value AND node.agent_id = trace.agent_id
      WHERE ${traceClauses.join(" AND ")}
      GROUP BY item.value
    `).all(...traceParameters);
    const seedRows = this.database.prepare(`
      SELECT item.value AS memory_id, COUNT(DISTINCT trace.id) AS seed_count,
             MAX(trace.created_at) AS last_seeded_at
      FROM memory_retrieval_traces AS trace
      JOIN json_each(trace.seed_ids_json) AS item
      JOIN memory_nodes AS node ON node.id = item.value AND node.agent_id = trace.agent_id
      WHERE ${traceClauses.join(" AND ")}
      GROUP BY item.value
    `).all(...traceParameters);
    const feedbackRows = this.database.prepare(`
      SELECT item.value AS memory_id, feedback.signal,
             COUNT(DISTINCT feedback.id) AS signal_count,
             MAX(feedback.created_at) AS last_feedback_at
      FROM memory_retrieval_feedback AS feedback
      JOIN json_each(feedback.target_memory_ids_json) AS item
      JOIN memory_nodes AS node ON node.id = item.value AND node.agent_id = feedback.agent_id
      WHERE ${feedbackClauses.join(" AND ")}
      GROUP BY item.value, feedback.signal
    `).all(...feedbackParameters);
    const stats = new Map();
    const ensure = (memoryId) => {
      if (!stats.has(memoryId)) {
        stats.set(memoryId, {
          memoryId,
          selectedCount: 0,
          seedCount: 0,
          lastSelectedAt: null,
          lastSeededAt: null,
          lastFeedbackAt: null,
          feedback: Object.fromEntries(RETRIEVAL_FEEDBACK_SIGNALS.map((signal) => [signal, 0])),
        });
      }
      return stats.get(memoryId);
    };
    if (requestedIds.length) {
      const existing = this.database.prepare(`
        SELECT id FROM memory_nodes
        WHERE agent_id = ? AND id IN (${requestedIds.map(() => "?").join(", ")})
      `).all(normalizedAgentId, ...requestedIds);
      for (const row of existing) ensure(row.id);
    }
    for (const row of selectedRows) {
      const item = ensure(row.memory_id);
      item.selectedCount = Number(row.selected_count || 0);
      item.lastSelectedAt = row.last_selected_at || null;
    }
    for (const row of seedRows) {
      const item = ensure(row.memory_id);
      item.seedCount = Number(row.seed_count || 0);
      item.lastSeededAt = row.last_seeded_at || null;
    }
    for (const row of feedbackRows) {
      const item = ensure(row.memory_id);
      item.feedback[row.signal] = Number(row.signal_count || 0);
      if (!item.lastFeedbackAt || row.last_feedback_at > item.lastFeedbackAt) {
        item.lastFeedbackAt = row.last_feedback_at || null;
      }
    }
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 200)));
    const values = [...stats.values()]
      .sort((left, right) => (
        String(right.lastSelectedAt || "").localeCompare(String(left.lastSelectedAt || ""))
        || right.selectedCount - left.selectedCount
        || left.memoryId.localeCompare(right.memoryId)
      ));
    if (requireComplete && values.length > maximum) {
      throw new Error(`Memory retrieval stats exceed the complete-result limit of ${maximum}.`);
    }
    return values.slice(0, maximum);
  }

  listEdgeRetrievalStats(agentId, {
    edgeIds = [],
    limit = 200,
    windowStart = "",
    windowEnd = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listEdgeRetrievalStats requires agentId.");
    const requestedIds = cleanStringList(edgeIds);
    const window = normalizeTimeWindow(windowStart, windowEnd);
    const traceClauses = ["trace.agent_id = ?", "trace.result_status = 'ready'"];
    const traceParameters = [normalizedAgentId];
    if (window.start) {
      traceClauses.push("trace.created_at >= ?");
      traceParameters.push(window.start);
    }
    if (window.end) {
      traceClauses.push("trace.created_at < ?");
      traceParameters.push(window.end);
    }
    if (requestedIds.length) {
      traceClauses.push(`stored_edge.id IN (${requestedIds.map(() => "?").join(", ")})`);
      traceParameters.push(...requestedIds);
    }
    const feedbackClauses = ["feedback.agent_id = ?"];
    const feedbackParameters = [normalizedAgentId];
    if (window.start) {
      feedbackClauses.push("feedback.created_at >= ?");
      feedbackParameters.push(window.start);
    }
    if (window.end) {
      feedbackClauses.push("feedback.created_at < ?");
      feedbackParameters.push(window.end);
    }
    if (requestedIds.length) {
      feedbackClauses.push(`stored_edge.id IN (${requestedIds.map(() => "?").join(", ")})`);
      feedbackParameters.push(...requestedIds);
    }
    const traversalRows = this.database.prepare(`
      SELECT stored_edge.id AS edge_id,
             stored_edge.from_memory_id, stored_edge.to_memory_id, stored_edge.relation,
             COUNT(DISTINCT trace.id) AS traversed_count,
             MAX(trace.created_at) AS last_traversed_at
      FROM memory_retrieval_traces AS trace
      JOIN json_each(trace.paths_json) AS selected_path ON 1 = 1
      JOIN json_each(selected_path.value, '$.edges') AS path_edge ON 1 = 1
      JOIN memory_edges AS stored_edge
        ON stored_edge.id = json_extract(path_edge.value, '$.edgeId')
       AND stored_edge.agent_id = trace.agent_id
      WHERE ${traceClauses.join(" AND ")}
      GROUP BY stored_edge.id
    `).all(...traceParameters);
    const feedbackRows = this.database.prepare(`
      SELECT stored_edge.id AS edge_id, feedback.signal,
             COUNT(DISTINCT feedback.id) AS signal_count,
             MAX(feedback.created_at) AS last_feedback_at
      FROM memory_retrieval_feedback AS feedback
      JOIN memory_retrieval_traces AS trace
        ON trace.id = feedback.trace_id AND trace.agent_id = feedback.agent_id
      JOIN json_each(feedback.target_memory_ids_json) AS target_memory ON 1 = 1
      JOIN json_each(trace.paths_json) AS selected_path
        ON json_extract(selected_path.value, '$.memoryId') = target_memory.value
      JOIN json_each(selected_path.value, '$.edges') AS path_edge ON 1 = 1
      JOIN memory_edges AS stored_edge
        ON stored_edge.id = json_extract(path_edge.value, '$.edgeId')
       AND stored_edge.agent_id = feedback.agent_id
      WHERE ${feedbackClauses.join(" AND ")}
      GROUP BY stored_edge.id, feedback.signal
    `).all(...feedbackParameters);
    const stats = new Map();
    const ensure = ({
      edge_id: edgeId,
      from_memory_id: fromMemoryId = "",
      to_memory_id: toMemoryId = "",
      relation = "",
    }) => {
      if (!stats.has(edgeId)) {
        stats.set(edgeId, {
          edgeId,
          fromMemoryId,
          toMemoryId,
          relation,
          traversedCount: 0,
          lastTraversedAt: null,
          lastFeedbackAt: null,
          feedback: Object.fromEntries(RETRIEVAL_FEEDBACK_SIGNALS.map((signal) => [signal, 0])),
        });
      }
      return stats.get(edgeId);
    };
    if (requestedIds.length) {
      const existing = this.database.prepare(`
        SELECT id AS edge_id, from_memory_id, to_memory_id, relation
        FROM memory_edges
        WHERE agent_id = ? AND id IN (${requestedIds.map(() => "?").join(", ")})
      `).all(normalizedAgentId, ...requestedIds);
      for (const row of existing) ensure(row);
    }
    for (const row of traversalRows) {
      const item = ensure(row);
      item.traversedCount = Number(row.traversed_count || 0);
      item.lastTraversedAt = row.last_traversed_at || null;
    }
    for (const row of feedbackRows) {
      const item = ensure(row);
      item.feedback[row.signal] = Number(row.signal_count || 0);
      if (!item.lastFeedbackAt || row.last_feedback_at > item.lastFeedbackAt) {
        item.lastFeedbackAt = row.last_feedback_at || null;
      }
    }
    return [...stats.values()]
      .sort((left, right) => (
        String(right.lastTraversedAt || "").localeCompare(String(left.lastTraversedAt || ""))
        || right.traversedCount - left.traversedCount
        || left.edgeId.localeCompare(right.edgeId)
      ))
      .slice(0, Math.min(500, Math.max(1, Math.trunc(Number(limit) || 200))));
  }

  listEdgeRetrievalStatsByView(agentId, {
    edgeIds = [],
    intentViews = [],
    limit = 500,
    requireComplete = false,
    windowStart = "",
    windowEnd = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listEdgeRetrievalStatsByView requires agentId.");
    const requestedIds = cleanStringList(edgeIds);
    const requestedViews = cleanStringList(intentViews);
    const window = normalizeTimeWindow(windowStart, windowEnd);
    const viewExpression = "COALESCE(NULLIF(json_extract(path_edge.value, '$.relationView'), ''), 'unknown')";
    const buildConditions = (timeAlias) => {
      const clauses = [`${timeAlias}.agent_id = ?`];
      const parameters = [normalizedAgentId];
      if (timeAlias === "trace") clauses.push("trace.result_status = 'ready'");
      if (window.start) {
        clauses.push(`${timeAlias}.created_at >= ?`);
        parameters.push(window.start);
      }
      if (window.end) {
        clauses.push(`${timeAlias}.created_at < ?`);
        parameters.push(window.end);
      }
      if (requestedIds.length) {
        clauses.push(`stored_edge.id IN (${requestedIds.map(() => "?").join(", ")})`);
        parameters.push(...requestedIds);
      }
      if (requestedViews.length) {
        clauses.push(`${viewExpression} IN (${requestedViews.map(() => "?").join(", ")})`);
        parameters.push(...requestedViews);
      }
      return { clauses, parameters };
    };
    const traversalFilter = buildConditions("trace");
    const feedbackFilter = buildConditions("feedback");
    const traversalRows = this.database.prepare(`
      SELECT stored_edge.id AS edge_id,
             stored_edge.from_memory_id, stored_edge.to_memory_id, stored_edge.relation,
             ${viewExpression} AS intent_view,
             COUNT(DISTINCT trace.id) AS traversed_count,
             MAX(trace.created_at) AS last_traversed_at
      FROM memory_retrieval_traces AS trace
      JOIN json_each(trace.paths_json) AS selected_path ON 1 = 1
      JOIN json_each(selected_path.value, '$.edges') AS path_edge ON 1 = 1
      JOIN memory_edges AS stored_edge
        ON stored_edge.id = json_extract(path_edge.value, '$.edgeId')
       AND stored_edge.agent_id = trace.agent_id
      WHERE ${traversalFilter.clauses.join(" AND ")}
      GROUP BY stored_edge.id, intent_view
    `).all(...traversalFilter.parameters);
    const feedbackRows = this.database.prepare(`
      SELECT stored_edge.id AS edge_id,
             stored_edge.from_memory_id, stored_edge.to_memory_id, stored_edge.relation,
             ${viewExpression} AS intent_view, feedback.signal,
             COUNT(DISTINCT feedback.id) AS signal_count,
             MAX(feedback.created_at) AS last_feedback_at
      FROM memory_retrieval_feedback AS feedback
      JOIN memory_retrieval_traces AS trace
        ON trace.id = feedback.trace_id AND trace.agent_id = feedback.agent_id
      JOIN json_each(feedback.target_memory_ids_json) AS target_memory ON 1 = 1
      JOIN json_each(trace.paths_json) AS selected_path
        ON json_extract(selected_path.value, '$.memoryId') = target_memory.value
      JOIN json_each(selected_path.value, '$.edges') AS path_edge ON 1 = 1
      JOIN memory_edges AS stored_edge
        ON stored_edge.id = json_extract(path_edge.value, '$.edgeId')
       AND stored_edge.agent_id = feedback.agent_id
      WHERE ${feedbackFilter.clauses.join(" AND ")}
      GROUP BY stored_edge.id, intent_view, feedback.signal
    `).all(...feedbackFilter.parameters);
    const stats = new Map();
    const ensure = (row) => {
      const key = `${row.edge_id}\u001f${row.intent_view}`;
      if (!stats.has(key)) {
        stats.set(key, {
          edgeId: row.edge_id,
          fromMemoryId: row.from_memory_id || "",
          toMemoryId: row.to_memory_id || "",
          relation: row.relation || "",
          intentView: row.intent_view,
          traversedCount: 0,
          lastTraversedAt: null,
          lastFeedbackAt: null,
          feedback: Object.fromEntries(RETRIEVAL_FEEDBACK_SIGNALS.map((signal) => [signal, 0])),
        });
      }
      return stats.get(key);
    };
    if (requestedIds.length && requestedViews.length) {
      const existing = this.database.prepare(`
        SELECT id AS edge_id, from_memory_id, to_memory_id, relation
        FROM memory_edges
        WHERE agent_id = ? AND id IN (${requestedIds.map(() => "?").join(", ")})
      `).all(normalizedAgentId, ...requestedIds);
      for (const row of existing) {
        for (const intentView of requestedViews) ensure({ ...row, intent_view: intentView });
      }
    }
    for (const row of traversalRows) {
      const item = ensure(row);
      item.traversedCount = Number(row.traversed_count || 0);
      item.lastTraversedAt = row.last_traversed_at || null;
    }
    for (const row of feedbackRows) {
      const item = ensure(row);
      item.feedback[row.signal] = Number(row.signal_count || 0);
      if (!item.lastFeedbackAt || row.last_feedback_at > item.lastFeedbackAt) {
        item.lastFeedbackAt = row.last_feedback_at || null;
      }
    }
    const maximum = Math.min(2000, Math.max(1, Math.trunc(Number(limit) || 500)));
    const values = [...stats.values()]
      .sort((left, right) => (
        String(right.lastTraversedAt || "").localeCompare(String(left.lastTraversedAt || ""))
        || right.traversedCount - left.traversedCount
        || left.edgeId.localeCompare(right.edgeId)
        || left.intentView.localeCompare(right.intentView)
      ));
    if (requireComplete && values.length > maximum) {
      throw new Error(`Edge retrieval stats exceed the complete-result limit of ${maximum}.`);
    }
    return values.slice(0, maximum);
  }

  getMemoryAccessibilityState(agentId, memoryId) {
    return normalizeAccessibilityState(this.database.prepare(`
      SELECT * FROM memory_accessibility_state
      WHERE agent_id = ? AND memory_id = ?
    `).get(clean(agentId), clean(memoryId)));
  }

  listMemoryAccessibilityStates(agentId, { policyVersions = [] } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listMemoryAccessibilityStates requires agentId.");
    const versions = cleanStringList(policyVersions);
    if (!versions.length) return [];
    return this.database.prepare(`
      SELECT * FROM memory_accessibility_state
      WHERE agent_id = ? AND policy_version IN (${versions.map(() => "?").join(", ")})
      ORDER BY memory_id ASC
    `).all(normalizedAgentId, ...versions).map(normalizeAccessibilityState);
  }

  getEdgeRelationUtilityState(agentId, edgeId, intentView) {
    return normalizeEdgeRelationUtilityState(this.database.prepare(`
      SELECT * FROM memory_edge_relation_utility_state
      WHERE agent_id = ? AND edge_id = ? AND intent_view = ?
    `).get(clean(agentId), clean(edgeId), clean(intentView)));
  }

  getPlasticityShadowRun(agentId, runId) {
    const normalizedAgentId = clean(agentId);
    const normalizedRunId = clean(runId);
    if (!normalizedAgentId || !normalizedRunId) return null;
    const row = this.database.prepare(`
      SELECT * FROM memory_plasticity_shadow_runs
      WHERE agent_id = ? AND id = ?
    `).get(normalizedAgentId, normalizedRunId);
    if (!row) return null;
    const changes = this.database.prepare(`
      SELECT * FROM memory_plasticity_shadow_changes
      WHERE agent_id = ? AND run_id = ?
      ORDER BY target_type ASC, target_id ASC, intent_view ASC
    `).all(normalizedAgentId, normalizedRunId).map(normalizePlasticityShadowChange);
    return normalizePlasticityShadowRun(row, changes);
  }

  listPlasticityShadowRuns(agentId, { limit = 50, offset = 0 } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listPlasticityShadowRuns requires agentId.");
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 50)));
    const skip = Math.max(0, Math.trunc(Number(offset) || 0));
    return this.database.prepare(`
      SELECT * FROM memory_plasticity_shadow_runs
      WHERE agent_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(normalizedAgentId, maximum, skip)
      .map((row) => normalizePlasticityShadowRun(row));
  }

  recordPlasticityShadowRun({
    id = "",
    agentId,
    policyVersion,
    observationWindowId,
    windowStart,
    windowEnd,
    inputHash,
    changes = [],
    metadata = {},
    createdAt = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedPolicyVersion = clean(policyVersion);
    const normalizedWindowId = clean(observationWindowId);
    const normalizedInputHash = clean(inputHash).toLowerCase();
    const window = normalizeTimeWindow(windowStart, windowEnd);
    if (!normalizedAgentId || !normalizedPolicyVersion || !normalizedWindowId) {
      throw new Error("Plasticity shadow run requires agentId, policyVersion, and observationWindowId.");
    }
    if (!window.start || !window.end) {
      throw new Error("Plasticity shadow run requires a complete observation window.");
    }
    if (!/^[a-f0-9]{64}$/u.test(normalizedInputHash)) {
      throw new Error("Plasticity shadow run requires a SHA-256 inputHash.");
    }
    if (!Array.isArray(changes)) throw new Error("Plasticity shadow changes must be an array.");
    const existing = this.database.prepare(`
      SELECT * FROM memory_plasticity_shadow_runs
      WHERE agent_id = ? AND policy_version = ? AND observation_window_id = ?
    `).get(normalizedAgentId, normalizedPolicyVersion, normalizedWindowId);
    if (existing) {
      if (existing.input_hash !== normalizedInputHash
        || existing.window_start !== window.start
        || existing.window_end !== window.end) {
        throw new Error("Plasticity observation window was already recorded with different input.");
      }
      return {
        ...this.getPlasticityShadowRun(normalizedAgentId, existing.id),
        wasInserted: false,
      };
    }
    const allowedDirections = new Set(["increase", "decrease", "hold"]);
    const preparedChanges = changes.map((change, index) => {
      const targetType = clean(change?.targetType);
      const targetId = clean(change?.targetId);
      const learningTarget = clean(change?.learningTarget);
      const intentView = clean(change?.intentView);
      const evidenceClass = clean(change?.evidenceClass);
      const evidenceTier = clean(change?.evidenceTier);
      const candidateDirection = clean(change?.candidateDirection);
      const targetPolicyVersion = clean(change?.targetPolicyVersion);
      const baseState = change?.baseState && typeof change.baseState === "object"
        && !Array.isArray(change.baseState) ? change.baseState : {};
      const baseStateExists = Boolean(baseState.exists);
      const baseStateAppliedAt = clean(baseState.appliedAt);
      if (!["memory", "edge"].includes(targetType) || !targetId) {
        throw new Error(`Plasticity shadow change ${index} has an invalid target.`);
      }
      if (!["accessibility", "relation-utility", "manual-review"].includes(learningTarget)) {
        throw new Error(`Plasticity shadow change ${index} has an invalid learning target.`);
      }
      if ((targetType === "memory" && intentView)
        || (targetType === "edge" && !intentView)) {
        throw new Error(`Plasticity shadow change ${index} has an invalid intent view.`);
      }
      if (!evidenceClass || !evidenceTier || !allowedDirections.has(candidateDirection)) {
        throw new Error(`Plasticity shadow change ${index} has incomplete evidence classification.`);
      }
      if (!targetPolicyVersion) {
        throw new Error(`Plasticity shadow change ${index} requires targetPolicyVersion.`);
      }
      if (baseStateAppliedAt && !validTimestamp(baseStateAppliedAt)) {
        throw new Error(`Plasticity shadow change ${index} has an invalid base state timestamp.`);
      }
      const targetExists = targetType === "memory"
        ? this.database.prepare(`
          SELECT 1 FROM memory_nodes WHERE agent_id = ? AND id = ?
        `).get(normalizedAgentId, targetId)
        : this.database.prepare(`
          SELECT 1 FROM memory_edges WHERE agent_id = ? AND id = ?
        `).get(normalizedAgentId, targetId);
      if (!targetExists) {
        throw new Error(`Plasticity shadow change ${index} target is not owned by this Agent.`);
      }
      return {
        id: stableId(
          "plasticity-change",
          normalizedAgentId,
          normalizedPolicyVersion,
          normalizedWindowId,
          targetType,
          targetId,
          learningTarget,
          intentView,
        ),
        targetType,
        targetId,
        learningTarget,
        intentView,
        evidenceClass,
        evidenceTier,
        candidateDirection,
        targetPolicyVersion,
        baseState: {
          exists: baseStateExists,
          value: baseStateExists
            ? unitInterval(baseState.value, `changes[${index}].baseState.value`)
            : null,
          policyVersion: baseStateExists ? clean(baseState.policyVersion) : "",
          observationWindowId: baseStateExists ? clean(baseState.observationWindowId) : "",
          appliedAt: baseStateExists && baseStateAppliedAt
            ? new Date(baseStateAppliedAt).toISOString()
            : null,
        },
        currentValue: unitInterval(change.currentValue, `changes[${index}].currentValue`),
        decayedValue: unitInterval(change.decayedValue, `changes[${index}].decayedValue`),
        positiveStep: unitInterval(change.positiveStep, `changes[${index}].positiveStep`),
        negativeStep: unitInterval(change.negativeStep, `changes[${index}].negativeStep`),
        proposedValue: unitInterval(change.proposedValue, `changes[${index}].proposedValue`),
        blocked: Boolean(change.blocked),
        blockReason: clean(change.blockReason),
        evidence: change.evidence && typeof change.evidence === "object"
          && !Array.isArray(change.evidence) ? change.evidence : {},
      };
    });
    const runId = clean(id) || `plasticity-shadow-${randomUUID()}`;
    const timestamp = clean(createdAt) || nowIso();
    if (!validTimestamp(timestamp)) throw new Error("Plasticity shadow createdAt is invalid.");
    const normalizedCreatedAt = new Date(timestamp).toISOString();
    if (normalizedCreatedAt < window.end) {
      throw new Error("Plasticity shadow observation window has not closed yet.");
    }
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO memory_plasticity_shadow_runs (
          id, agent_id, policy_version, observation_window_id,
          window_start, window_end, input_hash, candidate_count,
          metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        normalizedAgentId,
        normalizedPolicyVersion,
        normalizedWindowId,
        window.start,
        window.end,
        normalizedInputHash,
        preparedChanges.length,
        json(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}, {}),
        normalizedCreatedAt,
      );
      const insertChange = this.database.prepare(`
        INSERT INTO memory_plasticity_shadow_changes (
          id, run_id, agent_id, target_type, target_id, learning_target,
          intent_view, evidence_class, evidence_tier, candidate_direction,
          current_value, decayed_value, positive_step, negative_step,
          proposed_value, blocked, block_reason, evidence_json, created_at,
          target_policy_version, base_state_exists, base_state_policy_version,
          base_state_observation_window_id, base_state_applied_at, base_state_value
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const change of preparedChanges) {
        insertChange.run(
          change.id,
          runId,
          normalizedAgentId,
          change.targetType,
          change.targetId,
          change.learningTarget,
          change.intentView,
          change.evidenceClass,
          change.evidenceTier,
          change.candidateDirection,
          change.currentValue,
          change.decayedValue,
          change.positiveStep,
          change.negativeStep,
          change.proposedValue,
          change.blocked ? 1 : 0,
          change.blockReason,
          json(change.evidence, {}),
          normalizedCreatedAt,
          change.targetPolicyVersion,
          change.baseState.exists ? 1 : 0,
          change.baseState.policyVersion,
          change.baseState.observationWindowId,
          change.baseState.appliedAt,
          change.baseState.value,
        );
      }
      return {
        ...this.getPlasticityShadowRun(normalizedAgentId, runId),
        wasInserted: true,
      };
    });
  }

  getPlasticityApplication(agentId, applicationId) {
    const normalizedAgentId = clean(agentId);
    const normalizedApplicationId = clean(applicationId);
    if (!normalizedAgentId || !normalizedApplicationId) return null;
    const row = this.database.prepare(`
      SELECT * FROM memory_plasticity_applications
      WHERE agent_id = ? AND id = ?
    `).get(normalizedAgentId, normalizedApplicationId);
    if (!row) return null;
    const changes = this.database.prepare(`
      SELECT * FROM memory_plasticity_application_changes
      WHERE agent_id = ? AND application_id = ?
      ORDER BY target_type ASC, target_id ASC, intent_view ASC
    `).all(normalizedAgentId, normalizedApplicationId)
      .map(normalizePlasticityApplicationChange);
    return normalizePlasticityApplication(row, changes);
  }

  listPlasticityApplications(agentId, { limit = 50, offset = 0 } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listPlasticityApplications requires agentId.");
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 50)));
    const skip = Math.max(0, Math.trunc(Number(offset) || 0));
    return this.database.prepare(`
      SELECT * FROM memory_plasticity_applications
      WHERE agent_id = ?
      ORDER BY applied_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(normalizedAgentId, maximum, skip)
      .map((row) => normalizePlasticityApplication(row));
  }

  applyPlasticityShadowRun({
    agentId,
    runId,
    expectedInputHash,
    actor,
    reason = "",
    appliedAt = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedRunId = clean(runId);
    const normalizedInputHash = clean(expectedInputHash).toLowerCase();
    const normalizedActor = clean(actor);
    if (!normalizedAgentId || !normalizedRunId || !normalizedActor) {
      throw new Error("Applying plasticity requires agentId, runId, and an explicit actor.");
    }
    if (!/^[a-f0-9]{64}$/u.test(normalizedInputHash)) {
      throw new Error("Applying plasticity requires the expected SHA-256 input hash.");
    }
    const run = this.getPlasticityShadowRun(normalizedAgentId, normalizedRunId);
    if (!run) throw new Error("Plasticity shadow run does not exist for this Agent.");
    if (run.input_hash !== normalizedInputHash) {
      throw new Error("Plasticity shadow input hash does not match the explicit approval.");
    }
    const existing = this.database.prepare(`
      SELECT * FROM memory_plasticity_applications
      WHERE agent_id = ? AND run_id = ?
    `).get(normalizedAgentId, normalizedRunId);
    if (existing) {
      if (existing.input_hash !== normalizedInputHash) {
        throw new Error("Plasticity application exists with a different input hash.");
      }
      if (existing.status === "rolled_back") {
        throw new Error("A rolled-back plasticity run cannot be silently reapplied.");
      }
      return {
        ...this.getPlasticityApplication(normalizedAgentId, existing.id),
        wasApplied: false,
      };
    }
    const timestamp = clean(appliedAt) || nowIso();
    if (!validTimestamp(timestamp)) throw new Error("Plasticity appliedAt is invalid.");
    const normalizedAppliedAt = new Date(timestamp).toISOString();
    if (normalizedAppliedAt < run.window_end) {
      throw new Error("Plasticity cannot be applied before its observation window closes.");
    }
    const applicable = run.changes.filter((change) => (
      !change.blocked
      && ((change.target_type === "memory" && change.learning_target === "accessibility")
        || (change.target_type === "edge" && change.learning_target === "relation-utility"))
    ));
    if (!applicable.length) {
      throw new Error("Plasticity shadow run has no unblocked state changes to apply.");
    }
    const applicationId = stableId(
      "plasticity-application",
      normalizedAgentId,
      normalizedRunId,
      normalizedInputHash,
    );
    return this.transaction(() => {
      const snapshots = applicable.map((change, index) => {
        if (!change.targetPolicyVersion) {
          throw new Error(`Plasticity change ${index} has no target policy version.`);
        }
        const state = change.target_type === "memory"
          ? this.getMemoryAccessibilityState(normalizedAgentId, change.target_id)
          : this.getEdgeRelationUtilityState(
            normalizedAgentId,
            change.target_id,
            change.intent_view,
          );
        const expected = change.baseState || { exists: false, value: null };
        if (Boolean(state) !== Boolean(expected.exists)) {
          throw new Error(`Plasticity target ${change.target_id} changed after shadow evaluation.`);
        }
        if (state) {
          const actualAppliedAt = state.last_applied_at || null;
          if (!sameNumericValue(state.value, expected.value)
            || state.policy_version !== expected.policyVersion
            || state.last_observation_window_id !== expected.observationWindowId
            || actualAppliedAt !== expected.appliedAt) {
            throw new Error(`Plasticity target ${change.target_id} changed after shadow evaluation.`);
          }
        }
        const target = change.target_type === "memory"
          ? this.database.prepare(`
            SELECT status FROM memory_nodes WHERE agent_id = ? AND id = ?
          `).get(normalizedAgentId, change.target_id)
          : this.database.prepare(`
            SELECT 1 AS exists_flag FROM memory_edges WHERE agent_id = ? AND id = ?
          `).get(normalizedAgentId, change.target_id);
        if (!target || (change.target_type === "memory" && target.status !== "active")) {
          throw new Error(`Plasticity target ${change.target_id} is no longer active.`);
        }
        return { change, state };
      });
      this.database.prepare(`
        INSERT INTO memory_plasticity_applications (
          id, run_id, agent_id, input_hash, status, applied_count, skipped_count,
          applied_by, application_reason, applied_at
        ) VALUES (?, ?, ?, ?, 'applied', ?, ?, ?, ?, ?)
      `).run(
        applicationId,
        normalizedRunId,
        normalizedAgentId,
        normalizedInputHash,
        snapshots.length,
        run.changes.length - snapshots.length,
        normalizedActor,
        clean(reason),
        normalizedAppliedAt,
      );
      const insertAudit = this.database.prepare(`
        INSERT INTO memory_plasticity_application_changes (
          id, application_id, shadow_change_id, agent_id, target_type, target_id,
          intent_view, target_policy_version, previous_exists, previous_value,
          previous_policy_version, previous_observation_window_id, previous_applied_at,
          applied_value, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const { change, state } of snapshots) {
        insertAudit.run(
          stableId("plasticity-applied-change", applicationId, change.id),
          applicationId,
          change.id,
          normalizedAgentId,
          change.target_type,
          change.target_id,
          change.intent_view,
          change.targetPolicyVersion,
          state ? 1 : 0,
          state?.value ?? null,
          state?.policy_version || "",
          state?.last_observation_window_id || "",
          state?.last_applied_at || null,
          change.proposedValue,
          normalizedAppliedAt,
        );
        if (change.target_type === "memory") {
          this.database.prepare(`
            INSERT INTO memory_accessibility_state (
              memory_id, agent_id, value, policy_version,
              last_observation_window_id, last_applied_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(memory_id) DO UPDATE SET
              value = excluded.value,
              policy_version = excluded.policy_version,
              last_observation_window_id = excluded.last_observation_window_id,
              last_applied_at = excluded.last_applied_at,
              updated_at = excluded.updated_at
          `).run(
            change.target_id,
            normalizedAgentId,
            change.proposedValue,
            change.targetPolicyVersion,
            run.observation_window_id,
            normalizedAppliedAt,
            normalizedAppliedAt,
            normalizedAppliedAt,
          );
        } else {
          this.database.prepare(`
            INSERT INTO memory_edge_relation_utility_state (
              edge_id, agent_id, intent_view, value, policy_version,
              last_observation_window_id, last_applied_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(edge_id, intent_view) DO UPDATE SET
              value = excluded.value,
              policy_version = excluded.policy_version,
              last_observation_window_id = excluded.last_observation_window_id,
              last_applied_at = excluded.last_applied_at,
              updated_at = excluded.updated_at
          `).run(
            change.target_id,
            normalizedAgentId,
            change.intent_view,
            change.proposedValue,
            change.targetPolicyVersion,
            run.observation_window_id,
            normalizedAppliedAt,
            normalizedAppliedAt,
            normalizedAppliedAt,
          );
        }
      }
      return {
        ...this.getPlasticityApplication(normalizedAgentId, applicationId),
        wasApplied: true,
      };
    });
  }

  rollbackPlasticityApplication({
    agentId,
    applicationId,
    actor,
    reason,
    rolledBackAt = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedApplicationId = clean(applicationId);
    const normalizedActor = clean(actor);
    const normalizedReason = clean(reason);
    if (!normalizedAgentId || !normalizedApplicationId || !normalizedActor || !normalizedReason) {
      throw new Error("Rolling back plasticity requires agentId, applicationId, actor, and reason.");
    }
    const application = this.getPlasticityApplication(
      normalizedAgentId,
      normalizedApplicationId,
    );
    if (!application) throw new Error("Plasticity application does not exist for this Agent.");
    if (application.status === "rolled_back") {
      return { ...application, wasRolledBack: false };
    }
    const timestamp = clean(rolledBackAt) || nowIso();
    if (!validTimestamp(timestamp)) throw new Error("Plasticity rolledBackAt is invalid.");
    const normalizedRolledBackAt = new Date(timestamp).toISOString();
    if (normalizedRolledBackAt < application.applied_at) {
      throw new Error("Plasticity rollback cannot predate its application.");
    }
    const run = this.getPlasticityShadowRun(normalizedAgentId, application.run_id);
    if (!run) throw new Error("Plasticity shadow run is missing for this application.");
    return this.transaction(() => {
      for (const change of application.changes) {
        const state = change.target_type === "memory"
          ? this.getMemoryAccessibilityState(normalizedAgentId, change.target_id)
          : this.getEdgeRelationUtilityState(
            normalizedAgentId,
            change.target_id,
            change.intent_view,
          );
        if (!state
          || !sameNumericValue(state.value, change.appliedValue)
          || state.policy_version !== change.target_policy_version
          || state.last_observation_window_id !== run.observation_window_id
          || state.last_applied_at !== application.applied_at) {
          throw new Error(`Plasticity target ${change.target_id} has a later state and cannot be rolled back.`);
        }
      }
      for (const change of application.changes) {
        if (!change.previousExists) {
          if (change.target_type === "memory") {
            this.database.prepare(`
              DELETE FROM memory_accessibility_state
              WHERE agent_id = ? AND memory_id = ?
            `).run(normalizedAgentId, change.target_id);
          } else {
            this.database.prepare(`
              DELETE FROM memory_edge_relation_utility_state
              WHERE agent_id = ? AND edge_id = ? AND intent_view = ?
            `).run(normalizedAgentId, change.target_id, change.intent_view);
          }
          continue;
        }
        if (change.target_type === "memory") {
          this.database.prepare(`
            UPDATE memory_accessibility_state
            SET value = ?, policy_version = ?, last_observation_window_id = ?,
                last_applied_at = ?, updated_at = ?
            WHERE agent_id = ? AND memory_id = ?
          `).run(
            change.previousValue,
            change.previous_policy_version,
            change.previous_observation_window_id,
            change.previous_applied_at,
            normalizedRolledBackAt,
            normalizedAgentId,
            change.target_id,
          );
        } else {
          this.database.prepare(`
            UPDATE memory_edge_relation_utility_state
            SET value = ?, policy_version = ?, last_observation_window_id = ?,
                last_applied_at = ?, updated_at = ?
            WHERE agent_id = ? AND edge_id = ? AND intent_view = ?
          `).run(
            change.previousValue,
            change.previous_policy_version,
            change.previous_observation_window_id,
            change.previous_applied_at,
            normalizedRolledBackAt,
            normalizedAgentId,
            change.target_id,
            change.intent_view,
          );
        }
      }
      this.database.prepare(`
        UPDATE memory_plasticity_applications
        SET status = 'rolled_back', rolled_back_by = ?, rollback_reason = ?, rolled_back_at = ?
        WHERE agent_id = ? AND id = ? AND status = 'applied'
      `).run(
        normalizedActor,
        normalizedReason,
        normalizedRolledBackAt,
        normalizedAgentId,
        normalizedApplicationId,
      );
      return {
        ...this.getPlasticityApplication(normalizedAgentId, normalizedApplicationId),
        wasRolledBack: true,
      };
    });
  }

  recordAffectiveActivationDecision({
    id = "",
    agentId,
    memoryId,
    enabled,
    policyVersion,
    actor,
    reason,
    createdAt = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedMemoryId = clean(memoryId);
    const normalizedPolicyVersion = clean(policyVersion);
    const normalizedActor = clean(actor);
    const normalizedReason = clean(reason);
    if (!normalizedAgentId || !normalizedMemoryId || !normalizedPolicyVersion
      || !normalizedActor || !normalizedReason || typeof enabled !== "boolean") {
      throw new Error("Affective activation decision requires memory, enabled, policy, actor, and reason.");
    }
    const memory = this.getMemory(normalizedMemoryId);
    if (!memory || memory.agent_id !== normalizedAgentId
      || memory.state_family !== "affective_association"
      || !["reported", "established"].includes(memory.representation_layer)) {
      throw new Error("Affective activation decision requires an affective state for the same Agent.");
    }
    if (enabled) {
      const claim = memory.metadata?.reportedStateDraft?.affectiveClaim
        || memory.metadata?.affectiveClaim
        || null;
      if (memory.status !== "active" || memory.temporal_state !== "current"
        || !clean(claim?.trigger?.key) || !clean(claim?.trigger?.label)
        || !clean(claim?.emotion?.label)
        || !["positive", "negative", "mixed", "neutral"].includes(clean(claim?.emotion?.valence))
        || !["low", "medium", "high"].includes(clean(claim?.emotion?.intensity))) {
        throw new Error("Only a current structured affective state can be enabled for activation.");
      }
      const current = this.getCurrentCanonicalMemory({
        agentId: normalizedAgentId,
        subjectRole: memory.subject_role,
        subjectKey: memory.subject_key,
        canonicalKey: memory.canonical_key,
        representationLayer: memory.representation_layer,
        stateFamily: "affective_association",
        stateScopeKey: memory.state_scope_key,
      });
      if (current?.id !== memory.id) {
        throw new Error("Only the current affective state can be enabled for activation.");
      }
    }
    const timestamp = new Date(clean(createdAt));
    if (!Number.isFinite(timestamp.getTime())) {
      throw new Error("Affective activation decision createdAt is invalid.");
    }
    const decisionId = clean(id) || `affective-activation-${randomUUID()}`;
    this.database.prepare(`
      INSERT INTO memory_affective_activation_decisions (
        id, memory_id, agent_id, enabled, policy_version, actor, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decisionId,
      normalizedMemoryId,
      normalizedAgentId,
      enabled ? 1 : 0,
      normalizedPolicyVersion,
      normalizedActor,
      normalizedReason,
      timestamp.toISOString(),
    );
    return normalizeAffectiveActivationDecision(this.database.prepare(`
      SELECT * FROM memory_affective_activation_decisions
      WHERE agent_id = ? AND id = ?
    `).get(normalizedAgentId, decisionId));
  }

  listAffectiveActivationDecisions(agentId, { memoryId = "", limit = 100 } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listAffectiveActivationDecisions requires agentId.");
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (clean(memoryId)) {
      clauses.push("memory_id = ?");
      parameters.push(clean(memoryId));
    }
    return this.database.prepare(`
      SELECT * FROM memory_affective_activation_decisions
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(
      ...parameters,
      Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100))),
    ).map(normalizeAffectiveActivationDecision);
  }

  listEnabledAffectiveActivations(agentId, {
    policyVersions = [],
    representationLayers = [],
    subjectRole = "",
    subjectKey = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listEnabledAffectiveActivations requires agentId.");
    const policies = cleanStringList(policyVersions);
    const layers = cleanStringList(representationLayers);
    if (!policies.length || !layers.length) return [];
    if (layers.some((layer) => !["reported", "established"].includes(layer))) {
      throw new Error("Affective activation representation layer must be reported or established.");
    }
    const clauses = [
      "decision.agent_id = ?",
      "decision.enabled = 1",
      `decision.policy_version IN (${policies.map(() => "?").join(", ")})`,
      `memory.representation_layer IN (${layers.map(() => "?").join(", ")})`,
      "memory.state_family = 'affective_association'",
      "memory.status = 'active'",
      "memory.temporal_state = 'current'",
    ];
    const parameters = [normalizedAgentId, ...policies, ...layers];
    if (clean(subjectRole)) {
      clauses.push("memory.subject_role = ?");
      parameters.push(clean(subjectRole));
    }
    if (clean(subjectKey)) {
      clauses.push("memory.subject_key = ?");
      parameters.push(clean(subjectKey));
    }
    return this.database.prepare(`
      SELECT decision.id AS decision_id
      FROM memory_affective_activation_decisions AS decision
      JOIN memory_nodes AS memory
        ON memory.id = decision.memory_id AND memory.agent_id = decision.agent_id
      WHERE ${clauses.join(" AND ")}
        AND NOT EXISTS (
          SELECT 1 FROM memory_affective_activation_decisions AS newer
          WHERE newer.agent_id = decision.agent_id
            AND newer.memory_id = decision.memory_id
            AND (
              newer.created_at > decision.created_at
              OR (newer.created_at = decision.created_at AND newer.id > decision.id)
            )
        )
      ORDER BY decision.created_at DESC, decision.id DESC
    `).all(...parameters).map(({ decision_id: decisionId }) => {
      const decision = normalizeAffectiveActivationDecision(this.database.prepare(`
        SELECT * FROM memory_affective_activation_decisions
        WHERE agent_id = ? AND id = ?
      `).get(normalizedAgentId, decisionId));
      return { decision, memory: this.getMemory(decision.memoryId) };
    });
  }

  listMemories(agentId, {
    query = "",
    statuses = ["active"],
    kinds = [],
    limit = 50,
    offset = 0,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listMemories 需要 agentId。");
    const normalizedStatuses = [...new Set(
      (Array.isArray(statuses) ? statuses : [statuses]).map(clean).filter(Boolean),
    )];
    const normalizedKinds = [...new Set(
      (Array.isArray(kinds) ? kinds : [kinds]).map(clean).filter(Boolean),
    )];
    const maximum = Math.min(200, Math.max(1, Math.trunc(Number(limit) || 50)));
    const skip = Math.max(0, Math.trunc(Number(offset) || 0));
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (normalizedStatuses.length) {
      clauses.push(`status IN (${normalizedStatuses.map(() => "?").join(", ")})`);
      parameters.push(...normalizedStatuses);
    }
    if (normalizedKinds.length) {
      clauses.push(`kind IN (${normalizedKinds.map(() => "?").join(", ")})`);
      parameters.push(...normalizedKinds);
    }
    const text = clean(query);
    if (text) {
      clauses.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')");
      const pattern = `%${text.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      parameters.push(pattern, pattern);
    }
    const rows = this.database.prepare(`
      SELECT * FROM memory_nodes
      WHERE ${clauses.join(" AND ")}
      ORDER BY
        CASE status WHEN 'active' THEN 0 WHEN 'deleted' THEN 2 ELSE 1 END,
        COALESCE(event_date, event_start, recorded_at) DESC,
        updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...parameters, maximum, skip).map(normalizeNode);
    const total = Number(this.database.prepare(`
      SELECT COUNT(*) AS count FROM memory_nodes
      WHERE ${clauses.join(" AND ")}
    `).get(...parameters).count || 0);
    return {
      items: rows,
      total,
      limit: maximum,
      offset: skip,
    };
  }

  getMemoryDetail(agentId, memoryId) {
    const memory = this.getMemory(memoryId);
    if (!memory || memory.agent_id !== clean(agentId)) return null;
    return {
      memory,
      sources: this.database.prepare(`
        SELECT source.*, link.relation, link.authority,
               link.source_trust, link.evidence_strength,
               link.provenance AS evidence_provenance,
               link.metadata_json AS link_metadata_json,
               link.updated_at AS evidence_updated_at
        FROM memory_sources AS link
        JOIN source_records AS source ON source.id = link.source_id
        WHERE link.memory_id = ?
        ORDER BY source.occurred_at ASC, source.recorded_at ASC
      `).all(memoryId).map(normalizeEvidenceSource),
      roles: this.listMemoryRoles(memoryId),
      entities: this.listMemoryEntities(memoryId),
      edges: this.database.prepare(`
        SELECT * FROM memory_edges
        WHERE agent_id = ? AND (from_memory_id = ? OR to_memory_id = ?)
        ORDER BY updated_at DESC
      `).all(agentId, memoryId, memoryId).map(normalizeEdge),
      mutations: this.database.prepare(`
        SELECT * FROM memory_mutations
        WHERE agent_id = ? AND memory_id = ?
        ORDER BY created_at DESC, rowid DESC
      `).all(agentId, memoryId).map((row) => ({
        ...row,
        before: parseJson(row.before_json, {}),
        after: parseJson(row.after_json, {}),
      })),
    };
  }

  recordMutation({
    agentId,
    memoryId,
    action,
    actor = "human",
    reason = "",
    before,
    after,
  }) {
    const mutationId = `mutation-${randomUUID()}`;
    this.database.prepare(`
      INSERT INTO memory_mutations (
        id, agent_id, memory_id, action, actor, reason,
        before_json, after_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mutationId,
      clean(agentId),
      clean(memoryId),
      clean(action),
      clean(actor) || "human",
      clean(reason),
      json(nodeSnapshot(before), {}),
      json(nodeSnapshot(after), {}),
      nowIso(),
    );
    return mutationId;
  }

  editMemoryManually({
    agentId,
    memoryId,
    patch = {},
    actor = "human",
    reason = "",
  }) {
    const before = this.getMemory(memoryId);
    if (!before || before.agent_id !== clean(agentId)) throw new Error("没有找到要编辑的记忆。");
    const content = Object.hasOwn(patch, "content") ? String(patch.content ?? "") : before.content;
    if (!content.trim()) throw new Error("记忆正文不能为空。");
    const eventDate = Object.hasOwn(patch, "eventDate")
      ? clean(patch.eventDate) || null
      : before.event_date;
    if (eventDate && !/^\d{4}-\d{2}-\d{2}$/u.test(eventDate)) {
      throw new Error("事件日期必须为空或 YYYY-MM-DD。");
    }
    let after;
    this.transaction(() => {
      after = this.upsertMemory({
        id: before.id,
        agentId: before.agent_id,
        kind: clean(patch.kind) || before.kind,
        layer: clean(patch.layer) || before.layer,
        title: Object.hasOwn(patch, "title") ? patch.title : before.title,
        content,
        subjectRole: clean(patch.subjectRole) || before.subject_role,
        subjectKey: Object.hasOwn(patch, "subjectKey") ? patch.subjectKey : before.subject_key,
        canonicalKey: Object.hasOwn(patch, "canonicalKey") ? patch.canonicalKey : before.canonical_key,
        reality: clean(patch.reality) || before.reality,
        evidenceMode: "manual",
        representationLayer: Object.hasOwn(patch, "representationLayer")
          ? patch.representationLayer
          : before.representation_layer,
        stateFamily: Object.hasOwn(patch, "stateFamily")
          ? patch.stateFamily
          : before.state_family,
        statePhase: Object.hasOwn(patch, "statePhase")
          ? patch.statePhase
          : before.state_phase,
        stateScopeKey: before.state_scope_key,
        temporalState: clean(patch.temporalState) || before.temporal_state,
        revisionAction: before.revision_action,
        eventDate,
        eventStart: Object.hasOwn(patch, "eventStart") ? patch.eventStart || null : before.event_start,
        eventEnd: Object.hasOwn(patch, "eventEnd") ? patch.eventEnd || null : before.event_end,
        knownAt: Object.hasOwn(patch, "knownAt") ? patch.knownAt || null : before.known_at,
        validFrom: before.valid_from,
        validTo: before.valid_to,
        recordedAt: before.recorded_at,
        status: before.status,
        confidence: Object.hasOwn(patch, "confidence") ? patch.confidence : before.confidence,
        importance: Object.hasOwn(patch, "importance") ? patch.importance : before.importance,
        perspective: Object.hasOwn(patch, "perspective") ? patch.perspective : before.perspective,
        metadata: {
          ...before.metadata,
          manuallyEdited: true,
        },
      });
      this.database.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memoryId);
      this.database.prepare(`
        DELETE FROM memory_edges
        WHERE agent_id = ? AND provenance = 'association-builder-v1'
          AND (from_memory_id = ? OR to_memory_id = ?)
      `).run(agentId, memoryId, memoryId);
      this.recordMutation({
        agentId,
        memoryId,
        action: "edit",
        actor,
        reason,
        before,
        after,
      });
    });
    return after;
  }

  setMemoryDeleted({
    agentId,
    memoryId,
    deleted = true,
    actor = "human",
    reason = "",
  }) {
    const before = this.getMemory(memoryId);
    if (!before || before.agent_id !== clean(agentId)) throw new Error("没有找到要修改的记忆。");
    const targetStatus = deleted ? "deleted" : "active";
    if (before.status === targetStatus) return before;
    let after;
    this.transaction(() => {
      after = this.updateMemoryStatus(memoryId, targetStatus);
      if (deleted) {
        this.database.prepare(`
          DELETE FROM memory_edges
          WHERE agent_id = ? AND provenance = 'association-builder-v1'
            AND (from_memory_id = ? OR to_memory_id = ?)
        `).run(agentId, memoryId, memoryId);
      }
      this.recordMutation({
        agentId,
        memoryId,
        action: deleted ? "delete" : "restore",
        actor,
        reason,
        before,
        after,
      });
    });
    return after;
  }

  findCanonicalMemories({
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    representationLayer = "",
    stateFamily = "",
    stateScopeKey = "",
    statuses = ["active"],
  }) {
    const normalizedStatuses = [...new Set(statuses.map(clean).filter(Boolean))];
    const normalizedRepresentationLayer = clean(representationLayer);
    const normalizedStateFamily = clean(stateFamily);
    const normalizedStateScopeKey = clean(stateScopeKey)
      || (normalizedStateFamily && normalizedStateFamily !== NON_STATE_SCOPE_KEY
        ? ROOT_STATE_SCOPE_KEY
        : normalizedStateFamily === NON_STATE_SCOPE_KEY ? NON_STATE_SCOPE_KEY : "");
    if (normalizedRepresentationLayer && !REPRESENTATION_LAYERS.includes(normalizedRepresentationLayer)) {
      throw new Error("Canonical memory representationLayer is invalid.");
    }
    if (normalizedStateFamily && !MEMORY_STATE_FAMILY_STORAGE_VALUES.includes(normalizedStateFamily)) {
      throw new Error("Canonical memory stateFamily is invalid.");
    }
    if (normalizedStateScopeKey && !isValidStateScopeKey(normalizedStateScopeKey)) {
      throw new Error("Canonical memory stateScopeKey is invalid.");
    }
    if (!normalizedStatuses.length) return [];
    const representationFilter = normalizedRepresentationLayer ? "AND representation_layer = ?" : "";
    const stateFamilyFilter = normalizedStateFamily ? "AND state_family = ?" : "";
    const stateScopeFilter = normalizedStateScopeKey ? "AND state_scope_key = ?" : "";
    return this.database.prepare(`
      SELECT * FROM memory_nodes
      WHERE agent_id = ?
        AND subject_role = ?
        AND subject_key = ?
        AND canonical_key = ?
        ${representationFilter}
        ${stateFamilyFilter}
        ${stateScopeFilter}
        AND status IN (${normalizedStatuses.map(() => "?").join(", ")})
      ORDER BY updated_at DESC
    `).all(
      agentId,
      subjectRole,
      subjectKey,
      canonicalKey,
      ...(normalizedRepresentationLayer ? [normalizedRepresentationLayer] : []),
      ...(normalizedStateFamily ? [normalizedStateFamily] : []),
      ...(normalizedStateScopeKey ? [normalizedStateScopeKey] : []),
      ...normalizedStatuses,
    ).map(normalizeNode);
  }

  listEntities(agentId, { kind = "" } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedKind = clean(kind).toLocaleLowerCase("en-US");
    const rows = normalizedKind
      ? this.database.prepare(`
        SELECT * FROM entities
        WHERE agent_id = ? AND kind = ?
        ORDER BY canonical_name ASC, id ASC
      `).all(normalizedAgentId, normalizedKind)
      : this.database.prepare(`
        SELECT * FROM entities
        WHERE agent_id = ?
        ORDER BY kind ASC, canonical_name ASC, id ASC
      `).all(normalizedAgentId);
    return rows.map(normalizeEntity);
  }

  getEntity(agentId, entityId) {
    return normalizeEntity(this.database.prepare(`
      SELECT * FROM entities WHERE agent_id = ? AND id = ?
    `).get(clean(agentId), clean(entityId)));
  }

  findEntityByName({ agentId, kind, name }) {
    const key = entityNameKey(name);
    if (!key) return null;
    const matches = this.listEntities(agentId, { kind }).filter((entity) => (
      [entity.canonical_name, ...entity.aliases].some((label) => entityNameKey(label) === key)
    ));
    if (matches.length > 1) {
      throw new Error(`Entity name is ambiguous for this Agent: ${normalizedEntityName(name)}`);
    }
    return matches[0] || null;
  }

  upsertEntity({
    id = "",
    agentId,
    kind,
    canonicalName,
    aliases = [],
    metadata = {},
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedKind = clean(kind).toLocaleLowerCase("en-US");
    const normalizedCanonicalName = normalizedEntityName(canonicalName);
    if (!normalizedAgentId || !normalizedKind || !normalizedCanonicalName) {
      throw new Error("Entity requires agentId, kind, and canonicalName.");
    }
    const requestedId = clean(id);
    const byId = requestedId ? this.getEntity(normalizedAgentId, requestedId) : null;
    const byName = this.findEntityByName({
      agentId: normalizedAgentId,
      kind: normalizedKind,
      name: normalizedCanonicalName,
    });
    if (byId && byName && byId.id !== byName.id) {
      throw new Error("Entity id and canonical name resolve to different existing entities.");
    }
    const existing = byId || byName;
    const normalizedAliases = (Array.isArray(aliases) ? aliases : [])
      .map(normalizedEntityName)
      .filter(Boolean);
    for (const alias of normalizedAliases) {
      const conflict = this.findEntityByName({
        agentId: normalizedAgentId,
        kind: normalizedKind,
        name: alias,
      });
      if (conflict && conflict.id !== existing?.id) {
        throw new Error(`Entity alias already belongs to another entity: ${alias}`);
      }
    }
    const entityId = existing?.id || requestedId || stableId(
      "entity",
      normalizedAgentId,
      normalizedKind,
      entityNameKey(normalizedCanonicalName),
    );
    const storedCanonicalName = existing?.canonical_name || normalizedCanonicalName;
    const canonicalKey = entityNameKey(storedCanonicalName);
    const mergedAliases = [
      ...(existing?.aliases || []),
      ...(existing && entityNameKey(normalizedCanonicalName) !== canonicalKey
        ? [normalizedCanonicalName]
        : []),
      ...normalizedAliases,
    ].filter((alias, index, values) => (
      entityNameKey(alias) !== canonicalKey
      && values.findIndex((candidate) => entityNameKey(candidate) === entityNameKey(alias)) === index
    ));
    const timestamp = nowIso();
    this.database.prepare(`
      INSERT INTO entities (
        id, agent_id, kind, canonical_name, aliases_json,
        metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        canonical_name = excluded.canonical_name,
        aliases_json = excluded.aliases_json,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      entityId,
      normalizedAgentId,
      normalizedKind,
      storedCanonicalName,
      json(mergedAliases, []),
      json({ ...(existing?.metadata || {}), ...metadata }, {}),
      existing?.created_at || timestamp,
      timestamp,
    );
    return this.getEntity(normalizedAgentId, entityId);
  }

  linkMemoryEntity({ memoryId, entityId, role = "about" }) {
    const memory = this.getMemory(memoryId);
    if (!memory) throw new Error("Memory entity link requires an existing memory.");
    const entity = this.getEntity(memory.agent_id, entityId);
    if (!entity) throw new Error("Memory entity link requires an entity from the same Agent.");
    const normalizedRole = clean(role) || "about";
    this.database.prepare(`
      INSERT INTO memory_entities (memory_id, entity_id, role, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(memory_id, entity_id, role) DO NOTHING
    `).run(memory.id, entity.id, normalizedRole, nowIso());
    return this.listMemoryEntities(memory.id).find((item) => (
      item.id === entity.id && item.link_role === normalizedRole
    ));
  }

  unlinkMemoryEntity({ memoryId, entityId, role = "about" }) {
    return Number(this.database.prepare(`
      DELETE FROM memory_entities
      WHERE memory_id = ? AND entity_id = ? AND role = ?
    `).run(clean(memoryId), clean(entityId), clean(role) || "about").changes || 0);
  }

  listMemoryEntities(memoryId) {
    return this.database.prepare(`
      SELECT entity.*, link.role AS link_role, link.created_at AS linked_at
      FROM memory_entities AS link
      JOIN entities AS entity ON entity.id = link.entity_id
      WHERE link.memory_id = ?
      ORDER BY link.role ASC, entity.canonical_name ASC, entity.id ASC
    `).all(clean(memoryId)).map(normalizeEntity);
  }

  listEntityMemories({ agentId, entityId, statuses = ["active"] }) {
    const normalizedStatuses = [...new Set(statuses.map(clean).filter(Boolean))];
    if (!normalizedStatuses.length) return [];
    return this.database.prepare(`
      SELECT memory.*, link.role AS entity_role
      FROM memory_entities AS link
      JOIN memory_nodes AS memory ON memory.id = link.memory_id
      WHERE memory.agent_id = ? AND link.entity_id = ?
        AND memory.status IN (${normalizedStatuses.map(() => "?").join(", ")})
      ORDER BY COALESCE(memory.event_start, memory.known_at, memory.recorded_at) DESC,
        memory.updated_at DESC
    `).all(
      clean(agentId),
      clean(entityId),
      ...normalizedStatuses,
    ).map(normalizeNode);
  }

  getCurrentCanonicalMemory({
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    representationLayer = "",
    stateFamily = "",
    stateScopeKey = ROOT_STATE_SCOPE_KEY,
  }) {
    const normalizedRepresentationLayer = clean(representationLayer);
    const normalizedStateFamily = clean(stateFamily);
    const normalizedStateScopeKey = clean(stateScopeKey) || ROOT_STATE_SCOPE_KEY;
    if (normalizedRepresentationLayer && !REPRESENTATION_LAYERS.includes(normalizedRepresentationLayer)) {
      throw new Error("Current canonical memory representationLayer is invalid.");
    }
    if (normalizedStateFamily && !MEMORY_STATE_FAMILY_STORAGE_VALUES.includes(normalizedStateFamily)) {
      throw new Error("Current canonical memory stateFamily is invalid.");
    }
    if (!isValidStateScopeKey(normalizedStateScopeKey)
      || normalizedStateScopeKey === NON_STATE_SCOPE_KEY) {
      throw new Error("Current canonical memory stateScopeKey is invalid.");
    }
    const representationFilter = normalizedRepresentationLayer ? "AND representation_layer = ?" : "";
    const stateFamilyFilter = normalizedStateFamily ? "AND state_family = ?" : "";
    return normalizeNode(this.database.prepare(`
      SELECT * FROM memory_nodes
      WHERE agent_id = ?
        AND subject_role = ?
        AND subject_key = ?
        AND canonical_key = ?
        ${representationFilter}
        ${stateFamilyFilter}
        AND state_scope_key = ?
        AND status = 'active'
      ORDER BY COALESCE(valid_from, known_at, event_start, recorded_at) DESC,
        updated_at DESC
      LIMIT 1
    `).get(
      agentId,
      subjectRole,
      subjectKey,
      canonicalKey,
      ...(normalizedRepresentationLayer ? [normalizedRepresentationLayer] : []),
      ...(normalizedStateFamily ? [normalizedStateFamily] : []),
      normalizedStateScopeKey,
    ));
  }

  listCanonicalStateHistory({
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    representationLayer = "",
    stateFamily = "",
    stateScopeKey = ROOT_STATE_SCOPE_KEY,
    includeDeleted = false,
  }) {
    const normalizedRepresentationLayer = clean(representationLayer);
    const normalizedStateFamily = clean(stateFamily);
    const normalizedStateScopeKey = clean(stateScopeKey) || ROOT_STATE_SCOPE_KEY;
    if (normalizedRepresentationLayer && !REPRESENTATION_LAYERS.includes(normalizedRepresentationLayer)) {
      throw new Error("Canonical history representationLayer is invalid.");
    }
    if (normalizedStateFamily && !MEMORY_STATE_FAMILY_STORAGE_VALUES.includes(normalizedStateFamily)) {
      throw new Error("Canonical history stateFamily is invalid.");
    }
    if (!isValidStateScopeKey(normalizedStateScopeKey)
      || normalizedStateScopeKey === NON_STATE_SCOPE_KEY) {
      throw new Error("Canonical history stateScopeKey is invalid.");
    }
    const statusFilter = includeDeleted ? "" : "AND status <> 'deleted'";
    const representationFilter = normalizedRepresentationLayer ? "AND representation_layer = ?" : "";
    const stateFamilyFilter = normalizedStateFamily ? "AND state_family = ?" : "";
    return this.database.prepare(`
      SELECT * FROM memory_nodes
      WHERE agent_id = ?
        AND subject_role = ?
        AND subject_key = ?
        AND canonical_key = ?
        ${representationFilter}
        ${stateFamilyFilter}
        AND state_scope_key = ?
        ${statusFilter}
      ORDER BY COALESCE(valid_from, known_at, event_start, recorded_at) DESC,
        updated_at DESC
    `).all(
      agentId,
      subjectRole,
      subjectKey,
      canonicalKey,
      ...(normalizedRepresentationLayer ? [normalizedRepresentationLayer] : []),
      ...(normalizedStateFamily ? [normalizedStateFamily] : []),
      normalizedStateScopeKey,
    ).map(normalizeNode);
  }

  listCurrentScopedExceptions({ agentId, rootMemoryId } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedRootMemoryId = clean(rootMemoryId);
    const root = this.getMemory(normalizedRootMemoryId);
    if (!root || root.agent_id !== normalizedAgentId
      || root.status !== "active"
      || root.state_scope_key !== ROOT_STATE_SCOPE_KEY) {
      return [];
    }
    return this.database.prepare(`
      SELECT exception.*
      FROM memory_edges AS edge
      JOIN memory_nodes AS exception
        ON exception.agent_id = edge.agent_id AND exception.id = edge.from_memory_id
      WHERE edge.agent_id = ?
        AND edge.to_memory_id = ?
        AND edge.relation = 'scoped_exception_to'
        AND exception.status = 'active'
        AND exception.state_scope_key LIKE 'scope:%'
        AND exception.subject_role = ?
        AND exception.subject_key = ?
        AND exception.canonical_key = ?
        AND exception.representation_layer = ?
        AND exception.state_family = ?
      ORDER BY COALESCE(exception.valid_from, exception.known_at, exception.recorded_at) DESC,
        exception.updated_at DESC, exception.id ASC
    `).all(
      normalizedAgentId,
      root.id,
      root.subject_role,
      root.subject_key,
      root.canonical_key,
      root.representation_layer,
      root.state_family,
    ).map(normalizeNode);
  }

  updateMemoryStatus(id, status) {
    const changed = this.database.prepare(`
      UPDATE memory_nodes SET status = ?, updated_at = ? WHERE id = ?
    `).run(status, nowIso(), id);
    if (Number(changed.changes || 0) > 0) this.syncSearch(id);
    return this.getMemory(id);
  }

  closeCurrentMemoryState({ agentId, memoryId, validTo }) {
    const normalizedAgentId = clean(agentId);
    const normalizedMemoryId = clean(memoryId);
    const normalizedValidTo = clean(validTo);
    const memory = this.getMemory(normalizedMemoryId);
    if (!memory || memory.agent_id !== normalizedAgentId) {
      throw new Error("Closing a memory state requires a memory from the same Agent.");
    }
    if (memory.status !== "active") {
      throw new Error("Only an active current memory state can be closed.");
    }
    if (!validTimestamp(normalizedValidTo)) {
      throw new Error("Closing a memory state requires a valid validTo timestamp.");
    }
    const timestamp = new Date(normalizedValidTo).toISOString();
    if (memory.valid_from && timestamp < memory.valid_from) {
      throw new Error("A memory state cannot close before its validity begins.");
    }
    const result = this.database.prepare(`
      UPDATE memory_nodes
      SET status = 'superseded', temporal_state = 'historical', valid_to = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND status = 'active'
    `).run(timestamp, nowIso(), normalizedAgentId, normalizedMemoryId);
    if (Number(result.changes || 0) !== 1) {
      throw new Error("Current memory state changed while it was being closed.");
    }
    this.syncSearch(normalizedMemoryId);
    return this.getMemory(normalizedMemoryId);
  }

  closeReportedMemoryState({
    agentId,
    memoryId,
    stateFamily,
    statePhase,
    temporalState,
    status = "superseded",
    validTo,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedMemoryId = clean(memoryId);
    const normalizedFamily = clean(stateFamily);
    const normalizedPhase = clean(statePhase);
    const normalizedTemporalState = clean(temporalState);
    const normalizedStatus = clean(status);
    const normalizedValidTo = clean(validTo);
    const memory = this.getMemory(normalizedMemoryId);
    if (!memory || memory.agent_id !== normalizedAgentId
      || memory.representation_layer !== "reported"
      || memory.state_family !== normalizedFamily) {
      throw new Error("Closing a reported state requires the exact reviewed memory target.");
    }
    if (memory.status !== "active") {
      throw new Error("Only an active reported state can be closed.");
    }
    if (!MEMORY_STATE_PHASES.includes(normalizedPhase)
      || ["not_applicable", "unspecified", "active", "paused"].includes(normalizedPhase)) {
      throw new Error("Closing a reported state requires a terminal state phase.");
    }
    if (!TEMPORAL_STATES.includes(normalizedTemporalState)
      || ["current", "planned", "in_progress", "timeless", "unknown"].includes(normalizedTemporalState)) {
      throw new Error("Closing a reported state requires a terminal temporal state.");
    }
    if (!["superseded", "disputed"].includes(normalizedStatus)) {
      throw new Error("Closing a reported state requires a historical or disputed status.");
    }
    if (!validTimestamp(normalizedValidTo)) {
      throw new Error("Closing a reported state requires a valid validity end.");
    }
    const timestamp = new Date(normalizedValidTo).toISOString();
    if (memory.valid_from && timestamp < memory.valid_from) {
      throw new Error("A reported state cannot close before its validity begins.");
    }
    const result = this.database.prepare(`
      UPDATE memory_nodes
      SET status = ?, temporal_state = ?, state_phase = ?, valid_to = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND status = 'active'
        AND representation_layer = 'reported' AND state_family = ?
    `).run(
      normalizedStatus,
      normalizedTemporalState,
      normalizedPhase,
      timestamp,
      nowIso(),
      normalizedAgentId,
      normalizedMemoryId,
      normalizedFamily,
    );
    if (Number(result.changes || 0) !== 1) {
      throw new Error("Reported state changed while it was being closed.");
    }
    this.syncSearch(normalizedMemoryId);
    return this.getMemory(normalizedMemoryId);
  }

  upsertEmbedding({
    memoryId,
    model,
    vector,
    contentHash = "",
  }) {
    const normalizedMemoryId = clean(memoryId);
    const normalizedModel = clean(model);
    const values = vector instanceof Float32Array
      ? vector
      : Float32Array.from(Array.isArray(vector) ? vector : []);
    if (!normalizedMemoryId || !this.getMemory(normalizedMemoryId)) {
      throw new Error("Embedding requires an existing memoryId.");
    }
    if (!normalizedModel) throw new Error("Embedding requires model.");
    if (!values.length) throw new Error("Embedding vector cannot be empty.");
    const blob = Buffer.from(
      values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength),
    );
    this.database.prepare(`
      INSERT INTO memory_embeddings (
        memory_id, model, dimensions, content_hash, vector, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id, model) DO UPDATE SET
        dimensions = excluded.dimensions,
        content_hash = excluded.content_hash,
        vector = excluded.vector,
        created_at = excluded.created_at
    `).run(
      normalizedMemoryId,
      normalizedModel,
      values.length,
      clean(contentHash),
      blob,
      nowIso(),
    );
    return {
      memoryId: normalizedMemoryId,
      model: normalizedModel,
      dimensions: values.length,
      contentHash: clean(contentHash),
    };
  }

  listEmbeddings(agentId, model, {
    includeArchived = false,
  } = {}) {
    const statusClause = includeArchived
      ? "node.status <> 'deleted'"
      : "node.status = 'active'";
    return this.database.prepare(`
      SELECT embedding.memory_id, embedding.model, embedding.dimensions,
             embedding.content_hash, embedding.vector, node.kind,
             node.layer, node.importance, node.recorded_at
      FROM memory_embeddings AS embedding
      JOIN memory_nodes AS node ON node.id = embedding.memory_id
      WHERE node.agent_id = ? AND embedding.model = ? AND ${statusClause}
    `).all(agentId, model).map((row) => ({
      ...row,
      vector: new Float32Array(
        row.vector.buffer.slice(
          row.vector.byteOffset,
          row.vector.byteOffset + row.vector.byteLength,
        ),
      ),
      importance: Number(row.importance),
    }));
  }

  linkSource(memoryId, sourceId, relation = "evidence", {
    authority = "unknown",
    sourceTrust = 0.5,
    evidenceStrength = 1,
    provenance = "",
    metadata = {},
  } = {}) {
    const normalizedAuthority = clean(authority) || "unknown";
    if (!SOURCE_AUTHORITIES.includes(normalizedAuthority)) {
      throw new Error(`Unknown source authority: ${normalizedAuthority}.`);
    }
    const timestamp = nowIso();
    this.database.prepare(`
      INSERT INTO memory_sources (
        memory_id, source_id, relation, authority,
        source_trust, evidence_strength, provenance,
        metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id, source_id, relation) DO UPDATE SET
        authority = excluded.authority,
        source_trust = excluded.source_trust,
        evidence_strength = excluded.evidence_strength,
        provenance = excluded.provenance,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      memoryId,
      sourceId,
      clean(relation) || "evidence",
      normalizedAuthority,
      bounded(sourceTrust, 0.5),
      bounded(evidenceStrength, 1),
      clean(provenance),
      json(metadata, {}),
      timestamp,
      timestamp,
    );
  }

  getEdge(agentId, edgeId) {
    return normalizeEdge(this.database.prepare(`
      SELECT * FROM memory_edges WHERE agent_id = ? AND id = ?
    `).get(clean(agentId), clean(edgeId)));
  }

  findEdge({ agentId, fromMemoryId, toMemoryId, relation }) {
    return normalizeEdge(this.database.prepare(`
      SELECT * FROM memory_edges
      WHERE agent_id = ? AND from_memory_id = ? AND to_memory_id = ? AND relation = ?
    `).get(
      clean(agentId),
      clean(fromMemoryId),
      clean(toMemoryId),
      clean(relation),
    ));
  }

  upsertEdge({
    id = "",
    agentId,
    fromMemoryId,
    toMemoryId,
    relation,
    direction = "directed",
    weight = 0.5,
    confidence = 1,
    provenance = "",
    metadata = {},
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedFromMemoryId = clean(fromMemoryId);
    const normalizedToMemoryId = clean(toMemoryId);
    const normalizedRelation = clean(relation);
    if (!normalizedAgentId || !normalizedFromMemoryId || !normalizedToMemoryId || !normalizedRelation) {
      throw new Error("Edge requires agentId, fromMemoryId, toMemoryId, and relation.");
    }
    if (normalizedFromMemoryId === normalizedToMemoryId) {
      throw new Error("Memory edge cannot point to itself.");
    }
    const endpointCount = Number(this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM memory_nodes
      WHERE agent_id = ? AND id IN (?, ?)
    `).get(
      normalizedAgentId,
      normalizedFromMemoryId,
      normalizedToMemoryId,
    ).count || 0);
    if (endpointCount !== 2) {
      throw new Error("Memory edge endpoints must exist for the same Agent.");
    }

    const edgeId = clean(id) || stableId(
      "edge",
      normalizedAgentId,
      normalizedFromMemoryId,
      normalizedToMemoryId,
      normalizedRelation,
    );
    const timestamp = nowIso();
    this.database.prepare(`
      INSERT INTO memory_edges (
        id, agent_id, from_memory_id, to_memory_id, relation, direction,
        weight, confidence, provenance, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, from_memory_id, to_memory_id, relation) DO UPDATE SET
        direction = excluded.direction,
        weight = excluded.weight,
        confidence = excluded.confidence,
        provenance = excluded.provenance,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      edgeId,
      normalizedAgentId,
      normalizedFromMemoryId,
      normalizedToMemoryId,
      normalizedRelation,
      direction,
      bounded(weight, 0.5),
      bounded(confidence, 1),
      clean(provenance),
      json(metadata, {}),
      timestamp,
      timestamp,
    );
    return normalizeEdge(this.database.prepare(`
      SELECT * FROM memory_edges
      WHERE agent_id = ? AND from_memory_id = ? AND to_memory_id = ? AND relation = ?
    `).get(
      normalizedAgentId,
      normalizedFromMemoryId,
      normalizedToMemoryId,
      normalizedRelation,
    ));
  }

  syncSearch(memoryId) {
    const memory = this.getMemory(memoryId);
    if (!memory) return;
    this.database.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(memoryId);
    if (memory.status === "deleted") return;
    this.database.prepare(`
      INSERT INTO memory_fts (memory_id, agent_id, title, content)
      VALUES (?, ?, ?, ?)
    `).run(memory.id, memory.agent_id, memory.title, memory.content);
  }

  search(agentId, query, {
    limit = 10,
    includeArchived = false,
    kinds = [],
    layers = [],
  } = {}) {
    const text = clean(query);
    if (!text) return [];
    const maximum = Math.min(100, Math.max(1, Math.trunc(limit)));
    const statusClause = includeArchived
      ? "node.status <> 'deleted'"
      : "node.status = 'active'";
    const normalizedKinds = [...new Set(kinds.map(clean).filter(Boolean))];
    const normalizedLayers = [...new Set(layers.map(clean).filter(Boolean))];
    const kindClause = normalizedKinds.length
      ? `AND node.kind IN (${normalizedKinds.map(() => "?").join(", ")})`
      : "";
    const layerClause = normalizedLayers.length
      ? `AND node.layer IN (${normalizedLayers.map(() => "?").join(", ")})`
      : "";
    const filters = [...normalizedKinds, ...normalizedLayers];
    try {
      const matches = this.database.prepare(`
        SELECT node.*, bm25(memory_fts) AS search_rank
        FROM memory_fts
        JOIN memory_nodes AS node ON node.id = memory_fts.memory_id
        WHERE memory_fts MATCH ?
          AND memory_fts.agent_id = ?
          AND ${statusClause}
          ${kindClause}
          ${layerClause}
        ORDER BY search_rank ASC, node.importance DESC
        LIMIT ?
      `).all(`"${text.replaceAll('"', '""')}"`, agentId, ...filters, maximum)
        .map((row) => ({
          ...normalizeNode(row),
          search_rank: Number(row.search_rank),
        }));
      if (matches.length) return matches;
    } catch {
      // Short queries and builds without the preferred tokenizer use LIKE below.
    }
    const pattern = `%${text.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    return this.database.prepare(`
      SELECT node.*, 0 AS search_rank
      FROM memory_nodes AS node
      WHERE node.agent_id = ?
        AND ${statusClause}
        ${kindClause}
        ${layerClause}
        AND (node.title LIKE ? ESCAPE '\\' OR node.content LIKE ? ESCAPE '\\')
      ORDER BY node.importance DESC, node.recorded_at DESC
      LIMIT ?
    `).all(agentId, ...filters, pattern, pattern, maximum).map(normalizeNode);
  }

  expand(agentId, seedIds, {
    maxDepth = 2,
    maxNodes = 30,
    minimumWeight = 0,
    relations = [],
    traversal = "both",
    includeDeleted = false,
  } = {}) {
    const requestedSeeds = [...new Set(seedIds.map(clean).filter(Boolean))];
    const nodeStatus = this.database.prepare(`
      SELECT status FROM memory_nodes WHERE agent_id = ? AND id = ?
    `);
    const nodeAllowed = (id) => {
      const row = nodeStatus.get(agentId, id);
      return Boolean(row && (includeDeleted || row.status !== "deleted"));
    };
    const seeds = requestedSeeds.filter(nodeAllowed);
    const depthLimit = Math.min(8, Math.max(0, Math.trunc(maxDepth)));
    const nodeLimit = Math.min(500, Math.max(seeds.length, Math.trunc(maxNodes)));
    const relationSet = new Set(relations.map(clean).filter(Boolean));
    const visited = new Map(seeds.map((id) => [id, 0]));
    const queue = [...seeds];
    const traversedEdges = [];

    const outgoing = this.database.prepare(`
      SELECT * FROM memory_edges
      WHERE agent_id = ? AND from_memory_id = ? AND weight >= ?
      ORDER BY weight DESC, updated_at DESC
    `);
    const incoming = this.database.prepare(`
      SELECT * FROM memory_edges
      WHERE agent_id = ? AND to_memory_id = ? AND weight >= ?
      ORDER BY weight DESC, updated_at DESC
    `);

    while (queue.length && visited.size < nodeLimit) {
      const current = queue.shift();
      const depth = visited.get(current);
      if (depth >= depthLimit) continue;

      const candidates = [];
      if (traversal !== "incoming") {
        candidates.push(...outgoing.all(agentId, current, bounded(minimumWeight, 0)));
      }
      if (traversal !== "outgoing") {
        candidates.push(...incoming.all(agentId, current, bounded(minimumWeight, 0)));
      }
      for (const row of candidates) {
        const edge = normalizeEdge(row);
        if (relationSet.size && !relationSet.has(edge.relation)) continue;
        const neighbor = edge.from_memory_id === current
          ? edge.to_memory_id
          : edge.from_memory_id;
        if (!nodeAllowed(neighbor)) continue;
        traversedEdges.push(edge);
        if (visited.has(neighbor)) continue;
        visited.set(neighbor, depth + 1);
        queue.push(neighbor);
        if (visited.size >= nodeLimit) break;
      }
    }

    const nodes = [...visited.entries()]
      .map(([id, depth]) => ({ ...this.getMemory(id), depth }))
      .filter((node) => node.id);
    return {
      nodes,
      edges: [...new Map(traversedEdges.map((edge) => [edge.id, edge])).values()],
    };
  }
}
