import { createHash } from "node:crypto";

import {
  NON_STATE_SCOPE_KEY,
  ROOT_STATE_SCOPE_KEY,
  isValidStateScopeKey,
} from "./state-scope.mjs";

const LEVELS = Object.freeze([
  "situational_tolerance",
  "selection_tendency",
  "stable_preference",
  "direct_preference",
  "explicit_rejection",
  "no_conclusion",
]);

const POSITIVE_LEVEL_RANK = Object.freeze({
  no_conclusion: 0,
  situational_tolerance: 1,
  selection_tendency: 2,
  stable_preference: 3,
  direct_preference: 4,
});

const DIRECT_LEVELS = new Set(["direct_preference", "explicit_rejection"]);
const CHALLENGE_PREVIEWS = new Set([
  "conflicting-evidence",
  "state-change-review-required",
]);
const SUPPORT_SIGNALS = new Set([
  "explicit_preference",
  "active_choice",
  "repeated_behavior",
  "active_sharing",
  "voluntary_acceptance",
]);
const OPPOSITION_SIGNALS = new Set(["explicit_rejection", "counter_behavior"]);

function clean(value) {
  return String(value ?? "").trim();
}

function bounded(value, fallback = 0.5) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  );
}

function canonicalHash(value) {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

function cleanStringList(values) {
  return [...new Set(
    (Array.isArray(values) ? values : []).map(clean).filter(Boolean),
  )];
}

function validTimestamp(value) {
  return Number.isFinite(Date.parse(clean(value)));
}

function latestTimestamp(values, fallback = new Date().toISOString()) {
  const timestamps = values.map(clean).filter(validTimestamp).map((value) => new Date(value).toISOString());
  return timestamps.sort().at(-1) || fallback;
}

function stateKind(level) {
  return DIRECT_LEVELS.has(level) ? "preference" : "derived_hypothesis";
}

function representationLayerForLevel(level) {
  return DIRECT_LEVELS.has(level) ? "reported" : "inferred";
}

function inferredLevel(memory) {
  const stored = clean(memory?.metadata?.preferenceStateLevel);
  if (LEVELS.includes(stored)) return stored;
  if (memory?.kind === "preference") {
    return memory.evidence_mode === "explicit" ? "direct_preference" : "stable_preference";
  }
  return "";
}

function directionForEvidence(item) {
  if (clean(item?.ignoredReason)) return "neutral";
  const explicit = clean(item?.direction);
  if (["support", "opposition", "neutral"].includes(explicit)) return explicit;
  const signal = clean(item?.signal);
  if (SUPPORT_SIGNALS.has(signal)) return "support";
  if (OPPOSITION_SIGNALS.has(signal)) return "opposition";
  return "neutral";
}

function preferenceEvidenceSnapshot(repository, { agentId, memoryId, sourceIds }) {
  const detail = repository.getMemoryDetail(agentId, memoryId);
  if (!detail?.memory) throw new Error(`Preference proposal evidence ${memoryId} is unavailable.`);
  const sources = new Map(detail.sources.map((source) => [source.id, source]));
  if (sourceIds.some((sourceId) => !sources.has(sourceId))) {
    throw new Error(`Preference proposal evidence ${memoryId} references an unrelated source.`);
  }
  const memory = detail.memory;
  return canonicalHash({
    memory: {
      id: memory.id,
      agentId: memory.agent_id,
      kind: memory.kind,
      content: memory.content,
      subjectRole: memory.subject_role,
      subjectKey: memory.subject_key,
      canonicalKey: memory.canonical_key,
      reality: memory.reality,
      evidenceMode: memory.evidence_mode,
      representationLayer: memory.representation_layer,
      stateFamily: memory.state_family,
      temporalState: memory.temporal_state,
      eventStart: memory.event_start,
      eventEnd: memory.event_end,
      knownAt: memory.known_at,
      validFrom: memory.valid_from,
      validTo: memory.valid_to,
      status: memory.status,
    },
    roles: detail.roles.map((role) => ({
      role: role.role,
      actorRole: role.actor_role,
      actorKey: role.actor_key,
      isPrimary: role.is_primary,
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    sources: sourceIds.map((sourceId) => {
      const source = sources.get(sourceId);
      return {
        id: source.id,
        sourceKind: source.source_kind,
        externalId: source.external_id,
        occurredAt: source.occurred_at,
        knownAt: source.known_at,
        speaker: source.speaker,
        content: source.content,
        authority: source.authority,
        sourceTrust: source.source_trust,
        evidenceStrength: source.evidence_strength,
      };
    }).sort((left, right) => left.id.localeCompare(right.id)),
  });
}

function normalizeEvidence(repository, { agentId, subjectRole, subjectKey, evidence }) {
  const seen = new Set();
  return (Array.isArray(evidence) ? evidence : []).map((item, index) => {
    const memoryId = clean(item?.memoryId ?? item?.memory_id);
    const memory = repository.getMemory(memoryId);
    if (!memoryId || !memory || memory.agent_id !== agentId || memory.status === "deleted") {
      throw new Error(`Preference proposal evidence ${index} must exist for the same Agent.`);
    }
    if (memory.subject_role !== subjectRole || memory.subject_key !== subjectKey) {
      throw new Error(`Preference proposal evidence ${memoryId} belongs to a different subject.`);
    }
    if (seen.has(memoryId)) {
      throw new Error(`Preference proposal evidence repeats memoryId: ${memoryId}`);
    }
    seen.add(memoryId);
    const evidenceGroupId = clean(item?.evidenceGroupId ?? item?.evidence_group_id);
    const signal = clean(item?.signal);
    const sourceIds = cleanStringList(item?.sourceIds ?? item?.source_ids).sort();
    if (!evidenceGroupId || !signal || !sourceIds.length) {
      throw new Error(`Preference proposal evidence ${memoryId} requires a group, signal, and direct sources.`);
    }
    const evidenceSnapshotHash = preferenceEvidenceSnapshot(repository, {
      agentId,
      memoryId,
      sourceIds,
    });
    return {
      memoryId,
      evidenceGroupId,
      contextId: clean(item?.contextId ?? item?.context_id),
      signal,
      direction: directionForEvidence(item),
      confidence: bounded(item?.confidence, 0.5),
      sourceIds,
      evidenceSnapshotHash,
      knownAt: memory.known_at || memory.event_start || memory.recorded_at,
      label: { ...object(item) },
    };
  });
}

function transitionFor({ currentLevel, proposedLevel, previewStatus, evidenceReviewMode, scopeChange }) {
  if (!currentLevel) return "create";
  if (CHALLENGE_PREVIEWS.has(previewStatus)) return "challenge";
  if (previewStatus === "behavioral-opposition" && evidenceReviewMode !== "full_canonical") {
    return "challenge";
  }
  if (DIRECT_LEVELS.has(proposedLevel)) {
    return proposedLevel === currentLevel ? "reinforce" : "replace_explicit";
  }
  if (DIRECT_LEVELS.has(currentLevel)) return "challenge";
  if (proposedLevel === currentLevel) {
    if (scopeChange === "narrower") {
      return evidenceReviewMode === "full_canonical" ? "narrow_scope" : "challenge";
    }
    return "reinforce";
  }
  const currentRank = POSITIVE_LEVEL_RANK[currentLevel];
  const proposedRank = POSITIVE_LEVEL_RANK[proposedLevel];
  if (!Number.isFinite(currentRank) || !Number.isFinite(proposedRank)) return "challenge";
  if (proposedRank > currentRank) return "promote";
  return evidenceReviewMode === "full_canonical" ? "downgrade" : "challenge";
}

function formatState({ level, subjectLabel, objectLabel, scopeLabel }) {
  const scope = clean(scopeLabel) ? `在${clean(scopeLabel)}中` : "";
  const holder = clean(subjectLabel);
  const target = clean(objectLabel);
  const title = `${holder}对${target}的偏好认识`;
  const contentByLevel = {
    situational_tolerance: `${holder}${scope}对${target}表现为可以接受，但现有证据不足以说明喜欢。`,
    selection_tendency: `${holder}${scope}表现出对${target}的选择倾向。`,
    stable_preference: `${holder}${scope}对${target}表现出稳定偏好。`,
    direct_preference: `${holder}明确表示${scope}喜欢${target}。`,
    explicit_rejection: `${holder}明确表示${scope}不喜欢${target}。`,
    no_conclusion: `目前没有足够证据判断${holder}${scope}是否偏好${target}。`,
  };
  return { title, content: contentByLevel[level] };
}

function proposalHash(candidate) {
  return canonicalHash({
    agentId: candidate.agentId,
    subjectRole: candidate.subjectRole,
    subjectKey: candidate.subjectKey,
    canonicalKey: candidate.canonicalKey,
    representationLayer: candidate.representationLayer,
    stateScopeKey: candidate.stateScopeKey,
    previousMemoryId: candidate.previousMemoryId,
    subjectLabel: candidate.subjectLabel,
    objectLabel: candidate.objectLabel,
    scopeLabel: candidate.scopeLabel,
    proposedLevel: candidate.proposedLevel,
    transition: candidate.transition,
    scope: candidate.scope,
    evidenceReviewMode: candidate.evidenceReviewMode,
    policyVersion: candidate.policyVersion,
    evidence: candidate.evidence.map((item) => ({
      memoryId: item.memoryId,
      evidenceGroupId: item.evidenceGroupId,
      contextId: item.contextId,
      signal: item.signal,
      direction: item.direction,
      confidence: item.confidence,
      sourceIds: item.sourceIds,
      evidenceSnapshotHash: item.evidenceSnapshotHash,
      agency: item.label.agency,
      constraint: item.label.constraint,
      alternatives: item.label.alternatives,
      instrumentalGoal: item.label.instrumentalGoal,
      opportunityCost: item.label.opportunityCost,
      topicInitiation: item.label.topicInitiation,
      affectiveExpression: item.label.affectiveExpression,
      canDecline: item.label.canDecline,
      ignoredReason: item.label.ignoredReason,
    })),
    metadata: candidate.metadata,
  });
}

function validateStateEvidence({ proposedLevel, transition, evidence }) {
  const support = evidence.filter((item) => item.direction === "support");
  const opposition = evidence.filter((item) => item.direction === "opposition");
  if (transition === "challenge") {
    if (!opposition.length) {
      throw new Error("A preference challenge requires opposition evidence.");
    }
    return;
  }
  if (["direct_preference"].includes(proposedLevel)
    && !support.some((item) => item.signal === "explicit_preference")) {
    throw new Error("A direct preference proposal requires explicit preference evidence.");
  }
  if (proposedLevel === "explicit_rejection"
    && !opposition.some((item) => item.signal === "explicit_rejection")) {
    throw new Error("An explicit rejection proposal requires explicit rejection evidence.");
  }
  if (["situational_tolerance", "selection_tendency", "stable_preference"].includes(proposedLevel)
    && !support.length) {
    throw new Error("A positive preference state proposal requires supporting evidence.");
  }
}

export function proposePreferenceState(repository, input = {}) {
  if (!repository) throw new Error("Preference state proposal requires a repository.");
  const agentId = clean(input.agentId);
  const subjectRole = clean(input.subjectRole);
  const subjectKey = clean(input.subjectKey);
  const canonicalKey = clean(input.canonicalKey).toLocaleLowerCase("en-US");
  const proposedLevel = clean(input.proposedLevel);
  const subjectLabel = clean(input.subjectLabel);
  const objectLabel = clean(input.objectLabel);
  const policyVersion = clean(input.policyVersion);
  const previewStatus = clean(input.previewStatus);
  const evidenceReviewMode = clean(input.evidenceReviewMode) || "bounded";
  const expectedRepresentationLayer = representationLayerForLevel(proposedLevel);
  const representationLayer = clean(input.representationLayer) || expectedRepresentationLayer;
  const stateScopeKey = clean(input.stateScopeKey) || ROOT_STATE_SCOPE_KEY;
  if (!agentId || !["user", "agent", "shared", "other"].includes(subjectRole)
    || !subjectKey || !canonicalKey || !LEVELS.includes(proposedLevel)
    || !subjectLabel || !objectLabel || !policyVersion || !previewStatus
    || !["bounded", "full_canonical"].includes(evidenceReviewMode)
    || representationLayer !== expectedRepresentationLayer
    || !isValidStateScopeKey(stateScopeKey) || stateScopeKey === NON_STATE_SCOPE_KEY) {
    throw new Error("Preference state proposal target is incomplete.");
  }
  if (representationLayer === "established") {
    throw new Error("Established preference requires the dedicated cross-layer promotion policy.");
  }
  const current = repository.getCurrentCanonicalMemory({
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    representationLayer,
    stateFamily: "preference",
    stateScopeKey,
  });
  const requestedPreviousMemoryId = clean(input.previousMemoryId);
  if (requestedPreviousMemoryId && requestedPreviousMemoryId !== current?.id) {
    throw new Error("Preference state proposal does not target the current canonical state.");
  }
  const evidence = normalizeEvidence(repository, {
    agentId,
    subjectRole,
    subjectKey,
    evidence: input.evidence,
  });
  if (!evidence.length) throw new Error("Preference state proposal requires evidence.");
  const currentLevel = inferredLevel(current);
  const transition = transitionFor({
    currentLevel,
    proposedLevel,
    previewStatus,
    evidenceReviewMode,
    scopeChange: clean(input.scopeChange),
  });
  const expectedTransition = clean(input.expectedTransition);
  if (expectedTransition && transition !== expectedTransition) {
    throw new Error(
      `Preference transition changed after review: expected ${expectedTransition}, got ${transition}.`,
    );
  }
  if (["challenge", "reinforce", "promote", "downgrade", "narrow_scope", "replace_explicit"]
    .includes(transition) && !current) {
    throw new Error(`Preference transition ${transition} requires a current state.`);
  }
  if (["downgrade", "narrow_scope"].includes(transition)
    && evidenceReviewMode !== "full_canonical") {
    throw new Error("Preference downgrade requires a full canonical evidence review.");
  }
  validateStateEvidence({ proposedLevel, transition, evidence });
  const timestamps = evidence.map((item) => item.knownAt);
  const knownAt = latestTimestamp([input.knownAt, ...timestamps]);
  const validFrom = latestTimestamp([input.validFrom, knownAt], knownAt);
  if (current?.valid_from && validFrom < current.valid_from) {
    throw new Error("Preference proposal cannot predate the current state validity.");
  }
  const proposedKind = stateKind(proposedLevel);
  const scope = object(input.scope);
  const formatted = formatState({
    level: proposedLevel,
    subjectLabel,
    objectLabel,
    scopeLabel: input.scopeLabel,
  });
  const confidenceFallback = evidence.length
    ? evidence.reduce((sum, item) => sum + item.confidence, 0) / evidence.length
    : 0.5;
  const confidence = proposedKind === "derived_hypothesis"
    ? Math.min(0.65, bounded(input.confidence, confidenceFallback))
    : bounded(input.confidence, confidenceFallback);
  const candidate = {
    agentId,
    batchId: clean(input.batchId),
    subjectRole,
    subjectKey,
    canonicalKey,
    subjectLabel,
    objectLabel,
    scopeLabel: clean(input.scopeLabel),
    scope,
    representationLayer,
    stateScopeKey,
    previousMemoryId: current?.id || null,
    proposedLevel,
    transition,
    proposedKind,
    title: formatted.title,
    content: formatted.content,
    evidenceReviewMode,
    confidence,
    knownAt,
    validFrom,
    policyVersion,
    previewStatus,
    metrics: object(input.metrics),
    rationale: clean(input.rationale),
    provenance: clean(input.provenance) || "preference-state-proposal-v1",
    evidence,
    metadata: object(input.metadata),
    createdAt: clean(input.createdAt) || new Date().toISOString(),
  };
  const hash = proposalHash(candidate);
  const id = clean(input.id) || `preference-proposal-${createHash("sha256")
    .update(`${agentId}\u001f${hash}`)
    .digest("hex")
    .slice(0, 24)}`;
  return repository.recordPreferenceStateProposal({
    ...candidate,
    id,
    proposalHash: hash,
  });
}

function currentStateForProposal(repository, proposal) {
  const current = repository.getCurrentCanonicalMemory({
    agentId: proposal.agent_id,
    subjectRole: proposal.subject_role,
    subjectKey: proposal.subject_key,
    canonicalKey: proposal.canonical_key,
    representationLayer: proposal.representation_layer,
    stateFamily: "preference",
    stateScopeKey: proposal.state_scope_key,
  });
  if ((current?.id || "") !== (proposal.previousMemoryId || "")) {
    throw new Error("Preference state changed after proposal creation; review it again.");
  }
  return current;
}

function validateCanonicalReviewSnapshot(repository, proposal) {
  const review = proposal.metadata?.canonicalReview;
  if (!review) return;
  if (proposal.representation_layer !== "inferred"
    || proposal.state_scope_key !== ROOT_STATE_SCOPE_KEY
    || review.representationLayer !== "inferred"
    || review.stateScopeKey !== ROOT_STATE_SCOPE_KEY
    || review.establishedPromotionAllowed !== false) {
    throw new Error("Canonical preference review crossed its approved representation boundary.");
  }
  const observationSnapshots = Array.isArray(review.observationSnapshots)
    ? review.observationSnapshots
    : [];
  if (!observationSnapshots.length
    || observationSnapshots.some((item) => (
      !clean(item?.id) || !/^[0-9a-f]{64}$/u.test(clean(item?.hash))
    ))) {
    throw new Error("Canonical preference review snapshot is incomplete; review it again.");
  }
  const currentObservations = repository.listStateEvidenceObservations(proposal.agent_id, {
    stateFamily: "preference",
    subjectRole: proposal.subject_role,
    subjectKey: proposal.subject_key,
    canonicalKey: proposal.canonical_key,
    lifecycles: ["current"],
    limit: 1000,
  });
  const expectedIds = observationSnapshots.map((item) => clean(item.id)).sort();
  const currentIds = currentObservations.map((item) => item.id).sort();
  if (JSON.stringify(currentIds) !== JSON.stringify(expectedIds)) {
    throw new Error("Preference evidence set changed after canonical review; review it again.");
  }
  const currentById = new Map(currentObservations.map((item) => [item.id, item]));
  if (observationSnapshots.some((item) => (
    currentById.get(clean(item.id))?.observation_hash !== clean(item.hash)
  ))) {
    throw new Error("Preference evidence observation changed after canonical review; review it again.");
  }
  for (const [role, runId] of [
    ["preference-state-synthesizer", clean(review.synthesisRunId)],
    ["preference-state-critic", clean(review.criticRunId)],
  ]) {
    const run = runId ? repository.getStateAnalysisRun(proposal.agent_id, runId) : null;
    if (!run || run.status !== "completed" || run.state_family !== "preference"
      || run.analyzer_role !== role || run.subject_role !== proposal.subject_role
      || run.subject_key !== proposal.subject_key
      || run.canonical_key !== proposal.canonical_key) {
      throw new Error("Canonical preference review audit run is unavailable; review it again.");
    }
  }
}

function attachEvidence(repository, proposal, targetMemory) {
  for (const item of proposal.evidence) {
    const currentSnapshotHash = preferenceEvidenceSnapshot(repository, {
      agentId: proposal.agent_id,
      memoryId: item.memoryId,
      sourceIds: item.sourceIds,
    });
    if (!item.evidenceSnapshotHash || currentSnapshotHash !== item.evidenceSnapshotHash) {
      throw new Error("Preference proposal evidence changed after review; review it again.");
    }
    if (item.direction === "neutral" || item.memoryId === targetMemory.id) continue;
    const relation = item.direction === "support" ? "supported_by" : "challenged_by";
    const evidenceDetail = repository.getMemoryDetail(proposal.agent_id, item.memoryId);
    const sources = new Map((evidenceDetail?.sources || []).map((source) => [source.id, source]));
    for (const sourceId of item.sourceIds) {
      const source = sources.get(sourceId);
      repository.linkSource(targetMemory.id, sourceId, `preference_${item.direction}`, {
        authority: clean(source?.authority) || "model_inference",
        sourceTrust: bounded(source?.source_trust, 0.5),
        evidenceStrength: bounded(item.confidence, 0.5),
        provenance: "accepted-preference-state-proposal-v1",
        metadata: {
          preferenceProposalId: proposal.id,
          evidenceMemoryId: item.memoryId,
          signal: item.signal,
          direction: item.direction,
        },
      });
    }
    repository.upsertEdge({
      agentId: proposal.agent_id,
      fromMemoryId: targetMemory.id,
      toMemoryId: item.memoryId,
      relation,
      direction: "directed",
      weight: item.direction === "support" ? 0.85 : 0.7,
      confidence: item.confidence,
      provenance: "accepted-preference-state-proposal-v1",
      metadata: {
        preferenceProposalId: proposal.id,
        signal: item.signal,
        evidenceGroupId: item.evidenceGroupId,
        contextId: item.contextId,
      },
    });
  }
}

export function resolvePreferenceStateProposal(repository, {
  agentId,
  proposalId,
  action,
  resolvedBy = "human",
  note = "",
} = {}) {
  if (!repository) throw new Error("Resolving a preference state proposal requires a repository.");
  const normalizedAgentId = clean(agentId);
  const normalizedAction = clean(action);
  const proposal = repository.getPreferenceStateProposal(normalizedAgentId, proposalId);
  if (!proposal) throw new Error("Preference state proposal does not exist for this Agent.");
  if (proposal.review_state !== "pending") {
    throw new Error(`Preference state proposal is already ${proposal.review_state}.`);
  }
  if (!["accept", "dismiss"].includes(normalizedAction)) {
    throw new Error(`Unknown preference state proposal action: ${normalizedAction || "(empty)"}.`);
  }
  if (normalizedAction === "dismiss") {
    return repository.transaction(() => ({
      status: "dismissed",
      proposal: repository.resolvePreferenceStateProposal({
        agentId: normalizedAgentId,
        proposalId: proposal.id,
        resolution: "dismissed",
        resolvedBy,
        note,
      }),
      memory: null,
      previous: proposal.previousMemoryId
        ? repository.getMemory(proposal.previousMemoryId)
        : null,
    }));
  }

  return repository.transaction(() => {
    const current = currentStateForProposal(repository, proposal);
    validateCanonicalReviewSnapshot(repository, proposal);
    if (current && !["challenge", "reinforce"].includes(proposal.transition)
      && repository.listCurrentScopedExceptions({
        agentId: normalizedAgentId,
        rootMemoryId: current.id,
      }).length) {
      throw new Error("Preference root state has active scoped exceptions; reattach them before replacing it.");
    }
    if (proposal.transition === "challenge") {
      attachEvidence(repository, proposal, current);
      return {
        status: "challenge-accepted",
        proposal: repository.resolvePreferenceStateProposal({
          agentId: normalizedAgentId,
          proposalId: proposal.id,
          resolution: "accepted",
          resultMemoryId: current.id,
          resolvedBy,
          note,
        }),
        memory: current,
        previous: current,
      };
    }
    if (proposal.transition === "reinforce") {
      attachEvidence(repository, proposal, current);
      return {
        status: "reinforced",
        proposal: repository.resolvePreferenceStateProposal({
          agentId: normalizedAgentId,
          proposalId: proposal.id,
          resolution: "accepted",
          resultMemoryId: current.id,
          resolvedBy,
          note,
        }),
        memory: current,
        previous: current,
      };
    }

    const memoryId = `preference-state-${createHash("sha256")
      .update(`${normalizedAgentId}\u001f${proposal.id}`)
      .digest("hex")
      .slice(0, 24)}`;
    const memory = repository.upsertMemory({
      id: memoryId,
      agentId: normalizedAgentId,
      kind: proposal.proposed_kind,
      layer: "semantic",
      title: proposal.title,
      content: proposal.content,
      subjectRole: proposal.subject_role,
      subjectKey: proposal.subject_key,
      canonicalKey: proposal.canonical_key,
      reality: "real",
      evidenceMode: DIRECT_LEVELS.has(proposal.proposed_level) ? "explicit" : "inferred",
      representationLayer: proposal.representation_layer,
      stateFamily: "preference",
      stateScopeKey: proposal.state_scope_key,
      statePhase: "active",
      temporalState: "current",
      revisionAction: current ? "update" : "add",
      knownAt: proposal.known_at,
      validFrom: proposal.valid_from,
      status: "active",
      confidence: proposal.proposed_kind === "derived_hypothesis"
        ? Math.min(0.65, proposal.confidence)
        : proposal.confidence,
      importance: 0.6,
      actorRoles: [{
        role: "preference_holder",
        actorRole: proposal.subject_role,
        actorKey: proposal.subject_key,
        isPrimary: true,
        confidence: proposal.confidence,
        provenance: "accepted-preference-state-proposal-v1",
        metadata: { preferenceProposalId: proposal.id },
      }],
      metadata: {
        ...proposal.metadata,
        preferenceStateLevel: proposal.proposed_level,
        preferenceScope: proposal.scope,
        preferenceScopeLabel: proposal.scope_label,
        preferenceProposalId: proposal.id,
        preferencePolicyVersion: proposal.policy_version,
        preferencePreviewStatus: proposal.preview_status,
        preferenceTransition: proposal.transition,
        preferenceMetrics: proposal.metrics,
      },
    });
    attachEvidence(repository, proposal, memory);
    if (current) {
      repository.closeCurrentMemoryState({
        agentId: normalizedAgentId,
        memoryId: current.id,
        validTo: proposal.valid_from,
      });
      repository.upsertEdge({
        agentId: normalizedAgentId,
        fromMemoryId: memory.id,
        toMemoryId: current.id,
        relation: "supersedes",
        direction: "directed",
        weight: 1,
        confidence: proposal.confidence,
        provenance: "accepted-preference-state-proposal-v1",
        metadata: {
          preferenceProposalId: proposal.id,
          transition: proposal.transition,
        },
      });
    }
    return {
      status: proposal.transition,
      proposal: repository.resolvePreferenceStateProposal({
        agentId: normalizedAgentId,
        proposalId: proposal.id,
        resolution: "accepted",
        resultMemoryId: memory.id,
        resolvedBy,
        note,
      }),
      memory: repository.getMemory(memory.id),
      previous: current ? repository.getMemory(current.id) : null,
    };
  });
}

export const PREFERENCE_STATE_LEVELS = LEVELS;
