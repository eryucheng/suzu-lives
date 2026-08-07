import { createHash } from "node:crypto";

import { ROOT_STATE_SCOPE_KEY } from "./state-scope.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  );
}

function canonicalHash(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

function bounded(value, fallback = 0.5) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

function integer(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return number;
}

function ratio(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`${name} must be between 0 and 1.`);
  }
  return number;
}

function normalizePreferenceEstablishedPolicy(policy) {
  const value = policy && typeof policy === "object" && !Array.isArray(policy) ? policy : {};
  const normalized = {
    version: clean(value.version),
    minimumConfidence: ratio(value.minimumConfidence, "minimumConfidence"),
    minimumStableSupportScore: Number(value.minimumStableSupportScore),
    minimumIndependentSupport: integer(value.minimumIndependentSupport, "minimumIndependentSupport"),
    minimumDistinctDays: integer(value.minimumDistinctDays, "minimumDistinctDays"),
    minimumDistinctContexts: integer(value.minimumDistinctContexts, "minimumDistinctContexts"),
    minimumChoiceEvidence: integer(value.minimumChoiceEvidence, "minimumChoiceEvidence"),
    maximumOppositionRatio: ratio(value.maximumOppositionRatio, "maximumOppositionRatio"),
  };
  if (!normalized.version
    || !Number.isFinite(normalized.minimumStableSupportScore)
    || normalized.minimumStableSupportScore < 0) {
    throw new Error("Established preference promotion requires an explicit versioned policy.");
  }
  return normalized;
}

function assertPreferencePromotionMetrics(source, policy) {
  const metrics = source.metadata?.preferenceMetrics || {};
  const checks = [
    [Number(source.confidence) >= policy.minimumConfidence, "confidence"],
    [Number(metrics.supportScore || 0) >= policy.minimumStableSupportScore, "support score"],
    [Number(metrics.independentSupport || 0) >= policy.minimumIndependentSupport, "independent support"],
    [Number(metrics.distinctSupportDays || 0) >= policy.minimumDistinctDays, "distinct days"],
    [Number(metrics.distinctSupportContexts || 0) >= policy.minimumDistinctContexts, "distinct contexts"],
    [Number(metrics.choiceEvidenceCount || 0) >= policy.minimumChoiceEvidence, "choice evidence"],
    [Number(metrics.oppositionRatio || 0) <= policy.maximumOppositionRatio, "opposition ratio"],
  ];
  const failed = checks.filter(([passed]) => !passed).map(([, label]) => label);
  if (failed.length) {
    throw new Error(`Preference is not eligible for established promotion: ${failed.join(", ")}.`);
  }
  return metrics;
}

function assertCanonicalReviewStillCurrent(repository, source, canonicalReview) {
  const observationSnapshots = Array.isArray(canonicalReview?.observationSnapshots)
    ? canonicalReview.observationSnapshots
    : [];
  if (!observationSnapshots.length) {
    throw new Error("Established promotion requires a complete canonical review snapshot.");
  }
  const observations = repository.listStateEvidenceObservations(source.agent_id, {
    stateFamily: "preference",
    subjectRole: source.subject_role,
    subjectKey: source.subject_key,
    canonicalKey: source.canonical_key,
    lifecycles: ["current"],
    limit: 1000,
  });
  const expectedIds = observationSnapshots.map((item) => clean(item?.id)).sort();
  const currentIds = observations.map((item) => item.id).sort();
  if (!expectedIds.length || JSON.stringify(expectedIds) !== JSON.stringify(currentIds)) {
    throw new Error("Preference evidence changed after inferred-state review; review it again.");
  }
  const currentById = new Map(observations.map((item) => [item.id, item]));
  if (observationSnapshots.some((item) => (
    currentById.get(clean(item?.id))?.observation_hash !== clean(item?.hash)
  ))) {
    throw new Error("Preference evidence classification changed after inferred-state review.");
  }
}

function preferencePromotionSource(repository, { agentId, sourceMemoryId }) {
  const source = repository.getMemory(clean(sourceMemoryId));
  if (!source || source.agent_id !== clean(agentId) || source.status !== "active"
    || source.representation_layer !== "inferred" || source.state_family !== "preference"
    || source.state_scope_key !== ROOT_STATE_SCOPE_KEY
    || source.metadata?.preferenceStateLevel !== "stable_preference") {
    throw new Error("Established preference promotion requires the active inferred stable preference root.");
  }
  const current = repository.getCurrentCanonicalMemory({
    agentId: source.agent_id,
    subjectRole: source.subject_role,
    subjectKey: source.subject_key,
    canonicalKey: source.canonical_key,
    representationLayer: "inferred",
    stateFamily: "preference",
    stateScopeKey: ROOT_STATE_SCOPE_KEY,
  });
  if (current?.id !== source.id) {
    throw new Error("Established preference promotion source is not the current inferred state.");
  }
  const preferenceProposal = repository.getPreferenceStateProposal(
    source.agent_id,
    source.metadata?.preferenceProposalId,
  );
  const canonicalReview = source.metadata?.canonicalReview;
  if (!preferenceProposal || preferenceProposal.review_state !== "accepted"
    || preferenceProposal.resultMemoryId !== source.id
    || preferenceProposal.evidence_review_mode !== "full_canonical"
    || preferenceProposal.representation_layer !== "inferred"
    || preferenceProposal.provenance !== "approved-canonical-preference-review-v1"
    || !canonicalReview || canonicalReview.establishedPromotionAllowed !== false) {
    throw new Error("Established preference promotion requires an accepted full canonical inferred proposal.");
  }
  assertCanonicalReviewStillCurrent(repository, source, canonicalReview);
  if (repository.listCurrentScopedExceptions({
    agentId: source.agent_id,
    rootMemoryId: source.id,
  }).length) {
    throw new Error("Established preference promotion requires scoped exceptions to be reattached first.");
  }
  return { source, preferenceProposal, canonicalReview };
}

function sourceSnapshot(repository, source) {
  const detail = repository.getMemoryDetail(source.agent_id, source.id);
  const evidenceEdges = detail.edges.filter((edge) => (
    edge.from_memory_id === source.id
    && ["supported_by", "challenged_by"].includes(edge.relation)
  )).map((edge) => ({
    id: edge.id,
    toMemoryId: edge.to_memory_id,
    relation: edge.relation,
    direction: edge.direction,
    weight: Number(edge.weight),
    confidence: Number(edge.confidence),
    provenance: edge.provenance,
    metadata: edge.metadata,
  })).sort((left, right) => left.id.localeCompare(right.id));
  if (!evidenceEdges.some((edge) => edge.relation === "supported_by")) {
    throw new Error("Established preference promotion requires auditable support edges.");
  }
  const targetMemories = evidenceEdges.map((edge) => {
    const memory = repository.getMemory(edge.toMemoryId);
    if (!memory || memory.agent_id !== source.agent_id || memory.status === "deleted") {
      throw new Error("Established preference promotion evidence memory is unavailable.");
    }
    return {
      id: memory.id,
      content: memory.content,
      subjectRole: memory.subject_role,
      subjectKey: memory.subject_key,
      knownAt: memory.known_at,
      eventStart: memory.event_start,
      status: memory.status,
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  return {
    hash: canonicalHash({
      source: {
        id: source.id,
        content: source.content,
        subjectRole: source.subject_role,
        subjectKey: source.subject_key,
        canonicalKey: source.canonical_key,
        representationLayer: source.representation_layer,
        stateFamily: source.state_family,
        stateScopeKey: source.state_scope_key,
        status: source.status,
        validFrom: source.valid_from,
        validTo: source.valid_to,
        confidence: Number(source.confidence),
        metadata: source.metadata,
      },
      sources: detail.sources.map((item) => ({
        id: item.id,
        content: item.content,
        occurredAt: item.occurred_at,
        knownAt: item.known_at,
        speaker: item.speaker,
        authority: item.authority,
        sourceTrust: Number(item.source_trust),
        evidenceStrength: Number(item.evidence_strength),
      })).sort((left, right) => left.id.localeCompare(right.id)),
      evidenceEdges,
      targetMemories,
    }),
    detail,
    evidenceEdges,
  };
}

export function proposePreferenceEstablishedPromotion(repository, {
  agentId,
  sourceMemoryId,
  policy,
  createdAt = new Date().toISOString(),
  metadata = {},
} = {}) {
  if (!repository) throw new Error("Preference established promotion requires a repository.");
  const normalizedPolicy = normalizePreferenceEstablishedPolicy(policy);
  const { source, preferenceProposal, canonicalReview } = preferencePromotionSource(repository, {
    agentId,
    sourceMemoryId,
  });
  const metrics = assertPreferencePromotionMetrics(source, normalizedPolicy);
  const snapshot = sourceSnapshot(repository, source);
  const timestamp = new Date(createdAt).toISOString();
  const candidate = {
    agentId: source.agent_id,
    stateFamily: "preference",
    subjectRole: source.subject_role,
    subjectKey: source.subject_key,
    canonicalKey: source.canonical_key,
    stateScopeKey: source.state_scope_key,
    sourceMemoryId: source.id,
    proposedKind: "preference",
    title: source.title,
    content: source.content,
    confidence: Number(source.confidence),
    knownAt: timestamp,
    validFrom: timestamp,
    policyVersion: normalizedPolicy.version,
    sourceSnapshotHash: snapshot.hash,
    metadata: {
      ...metadata,
      preferenceEstablishedPromotion: {
        policy: normalizedPolicy,
        metrics,
        sourcePreferenceProposalId: preferenceProposal.id,
        canonicalReviewHash: canonicalReview.reviewHash,
        canonicalReviewBatchId: canonicalReview.batchId,
      },
    },
  };
  const proposalHash = canonicalHash(candidate);
  const id = `state-promotion-${createHash("sha256")
    .update(`${source.agent_id}\u001f${proposalHash}`)
    .digest("hex").slice(0, 24)}`;
  return repository.recordStatePromotionProposal({
    ...candidate,
    id,
    proposalHash,
    createdAt: timestamp,
  });
}

function copyPromotionEvidence(repository, proposal, source, result) {
  const snapshot = sourceSnapshot(repository, source);
  if (snapshot.hash !== proposal.source_snapshot_hash) {
    throw new Error("State promotion source changed after review; review it again.");
  }
  for (const linked of snapshot.detail.sources) {
    repository.linkSource(result.id, linked.id, "established_evidence", {
      authority: linked.authority,
      sourceTrust: linked.source_trust,
      evidenceStrength: linked.evidence_strength,
      provenance: "accepted-state-promotion-v1",
      metadata: { statePromotionProposalId: proposal.id },
    });
  }
  for (const edge of snapshot.evidenceEdges) {
    repository.upsertEdge({
      agentId: proposal.agent_id,
      fromMemoryId: result.id,
      toMemoryId: edge.toMemoryId,
      relation: edge.relation,
      direction: edge.direction,
      weight: edge.weight,
      confidence: edge.confidence,
      provenance: "accepted-state-promotion-v1",
      metadata: {
        ...edge.metadata,
        statePromotionProposalId: proposal.id,
        inheritedFromEdgeId: edge.id,
      },
    });
  }
}

export function resolveStatePromotionProposal(repository, {
  agentId,
  proposalId,
  action,
  resolvedBy = "human",
  note = "",
} = {}) {
  if (!repository) throw new Error("Resolving state promotion requires a repository.");
  const normalizedAgentId = clean(agentId);
  const proposal = repository.getStatePromotionProposal(normalizedAgentId, proposalId);
  if (!proposal) throw new Error("State promotion proposal does not exist for this Agent.");
  if (proposal.review_state !== "pending") {
    throw new Error(`State promotion proposal is already ${proposal.review_state}.`);
  }
  if (action === "dismiss") {
    return repository.resolveStatePromotionProposalRecord({
      agentId: normalizedAgentId,
      proposalId: proposal.id,
      resolution: "dismissed",
      resolvedBy,
      note,
    });
  }
  if (action !== "accept") throw new Error("Unknown state promotion action.");
  return repository.transaction(() => {
    const { source } = preferencePromotionSource(repository, {
      agentId: normalizedAgentId,
      sourceMemoryId: proposal.sourceMemoryId,
    });
    const snapshot = sourceSnapshot(repository, source);
    if (snapshot.hash !== proposal.source_snapshot_hash) {
      throw new Error("State promotion source changed after review; review it again.");
    }
    const established = repository.getCurrentCanonicalMemory({
      agentId: normalizedAgentId,
      subjectRole: proposal.subject_role,
      subjectKey: proposal.subject_key,
      canonicalKey: proposal.canonical_key,
      representationLayer: "established",
      stateFamily: proposal.state_family,
      stateScopeKey: proposal.state_scope_key,
    });
    if (established) throw new Error("State promotion target changed after proposal creation.");
    const memoryId = `established-state-${createHash("sha256")
      .update(`${normalizedAgentId}\u001f${proposal.id}`)
      .digest("hex").slice(0, 24)}`;
    const result = repository.upsertMemory({
      id: memoryId,
      agentId: normalizedAgentId,
      kind: proposal.proposed_kind,
      layer: "semantic",
      title: proposal.title,
      content: proposal.content,
      subjectRole: proposal.subject_role,
      subjectKey: proposal.subject_key,
      canonicalKey: proposal.canonical_key,
      reality: source.reality,
      evidenceMode: "inferred",
      representationLayer: "established",
      stateFamily: proposal.state_family,
      statePhase: source.state_phase,
      stateScopeKey: proposal.state_scope_key,
      temporalState: "current",
      revisionAction: "update",
      knownAt: proposal.known_at,
      validFrom: proposal.valid_from,
      status: "active",
      confidence: proposal.confidence,
      importance: source.importance,
      perspective: source.perspective,
      actorRoles: snapshot.detail.roles.map((role) => ({
        role: role.role,
        actorRole: role.actor_role,
        actorKey: role.actor_key,
        isPrimary: role.is_primary,
        confidence: role.confidence,
        provenance: "accepted-state-promotion-v1",
        metadata: role.metadata,
      })),
      metadata: {
        ...source.metadata,
        statePromotionProposalId: proposal.id,
        establishedFromMemoryId: source.id,
        establishedPolicyVersion: proposal.policy_version,
      },
    });
    copyPromotionEvidence(repository, proposal, source, result);
    repository.upsertEdge({
      agentId: normalizedAgentId,
      fromMemoryId: result.id,
      toMemoryId: source.id,
      relation: "established_from",
      direction: "directed",
      weight: 1,
      confidence: proposal.confidence,
      provenance: "accepted-state-promotion-v1",
      metadata: { statePromotionProposalId: proposal.id },
    });
    repository.closeCurrentMemoryState({
      agentId: normalizedAgentId,
      memoryId: source.id,
      validTo: proposal.valid_from,
    });
    const record = repository.resolveStatePromotionProposalRecord({
      agentId: normalizedAgentId,
      proposalId: proposal.id,
      resolution: "accepted",
      resultMemoryId: result.id,
      resolvedBy,
      note,
    });
    return {
      status: "established",
      proposal: record,
      memory: repository.getMemory(result.id),
      source: repository.getMemory(source.id),
    };
  });
}

export function revokeStatePromotionProposal(repository, {
  agentId,
  proposalId,
  revokedBy = "human",
  note,
} = {}) {
  if (!repository) throw new Error("Revoking state promotion requires a repository.");
  const normalizedAgentId = clean(agentId);
  const proposal = repository.getStatePromotionProposal(normalizedAgentId, proposalId);
  if (!proposal || proposal.review_state !== "accepted") {
    throw new Error("Only an accepted state promotion can be revoked.");
  }
  if (!clean(note)) throw new Error("Revoking a state promotion requires a reason.");
  return repository.transaction(() => {
    const result = repository.getMemory(proposal.resultMemoryId);
    const source = repository.getMemory(proposal.sourceMemoryId);
    const currentEstablished = result && repository.getCurrentCanonicalMemory({
      agentId: normalizedAgentId,
      subjectRole: proposal.subject_role,
      subjectKey: proposal.subject_key,
      canonicalKey: proposal.canonical_key,
      representationLayer: "established",
      stateFamily: proposal.state_family,
      stateScopeKey: proposal.state_scope_key,
    });
    const currentInferred = repository.getCurrentCanonicalMemory({
      agentId: normalizedAgentId,
      subjectRole: proposal.subject_role,
      subjectKey: proposal.subject_key,
      canonicalKey: proposal.canonical_key,
      representationLayer: "inferred",
      stateFamily: proposal.state_family,
      stateScopeKey: proposal.state_scope_key,
    });
    const edge = result && source && repository.findEdge({
      agentId: normalizedAgentId,
      fromMemoryId: result.id,
      toMemoryId: source.id,
      relation: "established_from",
    });
    if (!result || currentEstablished?.id !== result.id || currentInferred
      || !source || source.status !== "superseded"
      || source.valid_to !== result.valid_from || !edge
      || repository.listCurrentScopedExceptions({
        agentId: normalizedAgentId,
        rootMemoryId: result.id,
      }).length) {
      throw new Error("State promotion has later changes and cannot be revoked safely.");
    }
    const sourceDetail = repository.getMemoryDetail(normalizedAgentId, source.id);
    repository.closeCurrentMemoryState({
      agentId: normalizedAgentId,
      memoryId: result.id,
      validTo: new Date().toISOString(),
    });
    repository.updateMemoryStatus(result.id, "disputed");
    repository.upsertMemory({
      id: source.id,
      agentId: normalizedAgentId,
      kind: source.kind,
      layer: source.layer,
      title: source.title,
      content: source.content,
      subjectRole: source.subject_role,
      subjectKey: source.subject_key,
      canonicalKey: source.canonical_key,
      reality: source.reality,
      evidenceMode: source.evidence_mode,
      representationLayer: source.representation_layer,
      stateFamily: source.state_family,
      statePhase: source.state_phase,
      stateScopeKey: source.state_scope_key,
      temporalState: "current",
      revisionAction: source.revision_action,
      eventDate: source.event_date,
      eventStart: source.event_start,
      eventEnd: source.event_end,
      knownAt: source.known_at,
      validFrom: source.valid_from,
      validTo: null,
      recordedAt: source.recorded_at,
      status: "active",
      confidence: source.confidence,
      importance: source.importance,
      perspective: source.perspective,
      actorRoles: sourceDetail.roles.map((role) => ({
        role: role.role,
        actorRole: role.actor_role,
        actorKey: role.actor_key,
        isPrimary: role.is_primary,
        confidence: role.confidence,
        provenance: role.provenance,
        metadata: role.metadata,
      })),
      metadata: source.metadata,
    });
    const record = repository.revokeStatePromotionProposalRecord({
      agentId: normalizedAgentId,
      proposalId: proposal.id,
      revokedBy,
      note,
    });
    return {
      status: "revoked",
      proposal: record,
      memory: repository.getMemory(result.id),
      restoredSource: repository.getMemory(source.id),
    };
  });
}

export const PREFERENCE_ESTABLISHED_PROMOTION_POLICY_FIELDS = Object.freeze([
  "version",
  "minimumConfidence",
  "minimumStableSupportScore",
  "minimumIndependentSupport",
  "minimumDistinctDays",
  "minimumDistinctContexts",
  "minimumChoiceEvidence",
  "maximumOppositionRatio",
]);
