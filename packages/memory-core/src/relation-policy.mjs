import { createHash } from "node:crypto";

function clean(value) {
  return String(value ?? "").trim();
}

function bounded(value, fallback, minimum = 0, maximum = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function validateEndpoint(repository, agentId, memoryId, label) {
  const memory = repository.getMemory(clean(memoryId));
  if (!memory || memory.agent_id !== agentId || memory.status === "deleted") {
    throw new Error(`${label} relation endpoint must exist for the same Agent.`);
  }
  return memory;
}

function validateEvidence(repository, {
  agentId,
  fromMemoryId,
  toMemoryId,
  evidenceSourceIds,
}) {
  const sourceIds = [...new Set(
    (Array.isArray(evidenceSourceIds) ? evidenceSourceIds : [])
      .map(clean)
      .filter(Boolean),
  )].sort();
  if (!sourceIds.length) {
    throw new Error("A causal relation proposal requires original source evidence.");
  }
  const fromSources = new Set(
    repository.getMemoryDetail(agentId, fromMemoryId)?.sources.map((source) => source.id) || [],
  );
  const toSources = new Set(
    repository.getMemoryDetail(agentId, toMemoryId)?.sources.map((source) => source.id) || [],
  );
  let coversFrom = false;
  let coversTo = false;
  const evidence = sourceIds.map((sourceId) => {
    const source = repository.getSource(sourceId);
    if (!source || source.agent_id !== agentId) {
      throw new Error("Relation evidence must belong to the same Agent.");
    }
    const from = fromSources.has(sourceId);
    const to = toSources.has(sourceId);
    if (!from && !to) {
      throw new Error("Relation evidence must already support at least one proposed endpoint.");
    }
    coversFrom ||= from;
    coversTo ||= to;
    return {
      sourceId,
      endpointCoverage: from && to ? "both" : from ? "from" : "to",
    };
  });
  if (!coversFrom || !coversTo) {
    throw new Error("Causal relation evidence must cover both proposed endpoints.");
  }
  return evidence;
}

function normalizeCandidate(repository, input = {}) {
  if (!repository) throw new Error("Relation proposal requires a repository.");
  const agentId = clean(input.agentId);
  const relation = clean(input.relation);
  const fromMemoryId = clean(input.fromMemoryId ?? input.from_memory_id);
  const toMemoryId = clean(input.toMemoryId ?? input.to_memory_id);
  if (!agentId || relation !== "causes" || !fromMemoryId || !toMemoryId) {
    throw new Error("Relation proposal requires agentId, causes relation, and two endpoints.");
  }
  if (fromMemoryId === toMemoryId) {
    throw new Error("A causal relation cannot point to itself.");
  }
  validateEndpoint(repository, agentId, fromMemoryId, "Cause");
  validateEndpoint(repository, agentId, toMemoryId, "Effect");
  const evidence = validateEvidence(repository, {
    agentId,
    fromMemoryId,
    toMemoryId,
    evidenceSourceIds: input.evidenceSourceIds ?? input.evidence_source_ids,
  });
  const rationale = clean(input.rationale);
  if (!rationale) {
    throw new Error("Causal relation proposal requires a reviewable rationale.");
  }
  return {
    agentId,
    batchId: clean(input.batchId),
    relation,
    fromMemoryId,
    toMemoryId,
    weight: bounded(input.weight, 0.5),
    confidence: bounded(input.confidence, 0.5),
    rationale,
    provenance: clean(input.provenance) || "relation-proposal-v1",
    evidence,
    metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? input.metadata
      : {},
    createdAt: clean(input.createdAt) || new Date().toISOString(),
  };
}

function candidateHash(candidate) {
  return createHash("sha256").update(JSON.stringify({
    relation: candidate.relation,
    fromMemoryId: candidate.fromMemoryId,
    toMemoryId: candidate.toMemoryId,
    evidenceSourceIds: candidate.evidence.map((item) => item.sourceId).sort(),
  })).digest("hex");
}

export function proposeMemoryRelation(repository, input = {}) {
  const candidate = normalizeCandidate(repository, input);
  const proposalHash = candidateHash(candidate);
  const id = clean(input.id) || `relation-proposal-${createHash("sha256")
    .update(`${candidate.agentId}\u001f${proposalHash}`)
    .digest("hex")
    .slice(0, 24)}`;
  return repository.recordRelationProposal({
    ...candidate,
    id,
    proposalHash,
  });
}

export function resolveMemoryRelationProposal(repository, {
  agentId,
  proposalId,
  action,
  resolvedBy = "human",
  note = "",
} = {}) {
  if (!repository) throw new Error("Resolving a relation proposal requires a repository.");
  const normalizedAgentId = clean(agentId);
  const normalizedAction = clean(action);
  const proposal = repository.getRelationProposal(normalizedAgentId, proposalId);
  if (!proposal) throw new Error("Relation proposal does not exist for this Agent.");
  if (proposal.review_state !== "pending") {
    throw new Error(`Relation proposal is already ${proposal.review_state}.`);
  }
  if (!["accept", "dismiss"].includes(normalizedAction)) {
    throw new Error(`Unknown relation proposal action: ${normalizedAction || "(empty)"}.`);
  }
  if (normalizedAction === "dismiss") {
    return repository.transaction(() => ({
      status: "dismissed",
      proposal: repository.resolveRelationProposal({
        agentId: normalizedAgentId,
        proposalId: proposal.id,
        resolution: "dismissed",
        resolvedBy,
        note,
      }),
      edge: null,
    }));
  }

  normalizeCandidate(repository, {
    agentId: normalizedAgentId,
    relation: proposal.relation,
    fromMemoryId: proposal.from_memory_id,
    toMemoryId: proposal.to_memory_id,
    evidenceSourceIds: proposal.evidence.map((source) => source.id),
    weight: proposal.weight,
    confidence: proposal.confidence,
    rationale: proposal.rationale,
  });
  return repository.transaction(() => {
    const existing = repository.findEdge({
      agentId: normalizedAgentId,
      fromMemoryId: proposal.from_memory_id,
      toMemoryId: proposal.to_memory_id,
      relation: proposal.relation,
    });
    if (existing) {
      throw new Error("The proposed causal edge already exists and will not be overwritten.");
    }
    const edge = repository.upsertEdge({
      agentId: normalizedAgentId,
      fromMemoryId: proposal.from_memory_id,
      toMemoryId: proposal.to_memory_id,
      relation: proposal.relation,
      direction: "directed",
      weight: proposal.weight,
      confidence: proposal.confidence,
      provenance: "accepted-relation-proposal-v1",
      metadata: {
        relationProposalId: proposal.id,
        evidenceSourceIds: proposal.evidence.map((source) => source.id),
        rationale: proposal.rationale,
      },
    });
    return {
      status: "accepted",
      proposal: repository.resolveRelationProposal({
        agentId: normalizedAgentId,
        proposalId: proposal.id,
        resolution: "accepted",
        resultEdgeId: edge.id,
        resultEdgeUpdatedAt: edge.updated_at,
        resolvedBy,
        note,
      }),
      edge,
    };
  });
}

export function revokeMemoryRelationProposal(repository, {
  agentId,
  proposalId,
  revokedBy = "human",
  note = "",
} = {}) {
  if (!repository) throw new Error("Revoking a relation proposal requires a repository.");
  return repository.revokeRelationProposal({
    agentId,
    proposalId,
    revokedBy,
    note,
  });
}
