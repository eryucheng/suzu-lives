import { createHash } from "node:crypto";

import { DIRECT_INGESTION_MEMORY_KINDS } from "@suzu-lives/memory-core";

export const CONSOLIDATION_POLICY_VERSION = "consolidation-plan-v1";

const DEFAULT_RELATIONS = Object.freeze([
  "associated_with",
  "shares_entity",
  "same_thread",
  "timeline_next",
  "part_of_episode",
  "supports_topic",
]);

const RELATION_PRIORITY = Object.freeze({
  same_thread: 1,
  part_of_episode: 1,
  supports_topic: 0.95,
  shares_entity: 0.9,
  associated_with: 0.8,
  timeline_next: 0.75,
});

function clean(value) {
  return String(value ?? "").trim();
}

function bounded(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function orderingTime(memory) {
  for (const value of [memory.event_start, memory.known_at, memory.recorded_at]) {
    const timestamp = Date.parse(value || "");
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return Number.NEGATIVE_INFINITY;
}

function edgeStrength(edge) {
  return Math.max(0, Number(edge.weight || 0))
    * Math.max(0, Number(edge.confidence || 0))
    * Number(RELATION_PRIORITY[edge.relation] || 0);
}

export function planMemoryConsolidation({
  repository,
  agentId,
  triggerMemoryIds = [],
  maximumCandidates = 24,
  maximumDepth = 2,
  minimumEdgeWeight = 0.65,
  relations = DEFAULT_RELATIONS,
  policyVersion = CONSOLIDATION_POLICY_VERSION,
  metadata = {},
} = {}) {
  if (!repository) throw new Error("Memory consolidation planning requires a repository.");
  const normalizedAgentId = clean(agentId);
  const triggerIds = [...new Set(
    (Array.isArray(triggerMemoryIds) ? triggerMemoryIds : []).map(clean).filter(Boolean),
  )].sort();
  if (!normalizedAgentId || !triggerIds.length) {
    throw new Error("Memory consolidation planning requires agentId and trigger memories.");
  }
  const triggers = triggerIds.map((id) => repository.getMemory(id));
  if (triggers.some((memory) => (
    !memory
    || memory.agent_id !== normalizedAgentId
    || memory.status !== "active"
    || !DIRECT_INGESTION_MEMORY_KINDS.includes(memory.kind)
  ))) {
    throw new Error("Every consolidation trigger must be an active direct memory for the same Agent.");
  }
  const requestedCandidateLimit = Number(maximumCandidates);
  const candidateLimit = Number.isFinite(requestedCandidateLimit)
    ? Math.min(100, Math.max(0, Math.trunc(requestedCandidateLimit)))
    : 24;
  const depthLimit = Math.min(4, Math.max(1, Math.trunc(Number(maximumDepth) || 2)));
  const minimumWeight = bounded(minimumEdgeWeight, 0.65, 0, 1);
  const allowedRelations = [...new Set(
    (Array.isArray(relations) ? relations : []).map(clean).filter((value) => DEFAULT_RELATIONS.includes(value)),
  )].sort();
  if (!allowedRelations.length) {
    throw new Error("Memory consolidation planning requires at least one safe relation.");
  }
  const graph = repository.expand(normalizedAgentId, triggerIds, {
    maxDepth: depthLimit,
    maxNodes: triggerIds.length + Math.max(candidateLimit * 4, 20),
    minimumWeight,
    relations: allowedRelations,
  });
  const triggerSet = new Set(triggerIds);
  const candidates = graph.nodes
    .filter((memory) => (
      !triggerSet.has(memory.id)
      && memory.status === "active"
      && DIRECT_INGESTION_MEMORY_KINDS.includes(memory.kind)
    ))
    .map((memory) => {
      const incident = graph.edges.filter((edge) => (
        edge.from_memory_id === memory.id || edge.to_memory_id === memory.id
      ));
      const reasons = [...new Set(incident.map((edge) => edge.relation))].sort();
      const strongestEdge = incident.reduce(
        (maximum, edge) => Math.max(maximum, edgeStrength(edge)),
        0,
      );
      return {
        memory,
        depth: Number(memory.depth || 0),
        score: strongestEdge / Math.max(1, Number(memory.depth || 1)),
        reasons,
      };
    })
    .sort((left, right) => (
      left.depth - right.depth
      || right.score - left.score
      || Number(right.memory.importance) - Number(left.memory.importance)
      || orderingTime(right.memory) - orderingTime(left.memory)
      || left.memory.id.localeCompare(right.memory.id)
    ))
    .slice(0, candidateLimit);
  const candidateIds = candidates.map((candidate) => candidate.memory.id);
  const selectedIds = new Set([...triggerIds, ...candidateIds]);
  const graphEdgeIds = graph.edges
    .filter((edge) => (
      selectedIds.has(edge.from_memory_id) && selectedIds.has(edge.to_memory_id)
    ))
    .map((edge) => edge.id)
    .sort();
  const candidateReasons = Object.fromEntries(candidates.map((candidate) => [
    candidate.memory.id,
    {
      depth: candidate.depth,
      score: Number(candidate.score.toFixed(6)),
      relations: candidate.reasons,
    },
  ]));
  const normalizedPolicyVersion = clean(policyVersion) || CONSOLIDATION_POLICY_VERSION;
  const input = {
    triggerIds,
    candidateIds,
    candidateReasons,
    graphEdgeIds,
    selectionPolicy: {
      maximumCandidates: candidateLimit,
      maximumDepth: depthLimit,
      minimumEdgeWeight: minimumWeight,
      relations: allowedRelations,
    },
  };
  const inputHash = stableHash(input);
  const id = `consolidation-run-${createHash("sha256")
    .update(`${normalizedAgentId}\u001f${normalizedPolicyVersion}\u001f${inputHash}`)
    .digest("hex")
    .slice(0, 24)}`;
  return repository.recordConsolidationRun({
    id,
    agentId: normalizedAgentId,
    policyVersion: normalizedPolicyVersion,
    triggerIds,
    candidateIds,
    candidateReasons,
    graphEdgeIds,
    inputHash,
    metadata: {
      selectionPolicy: input.selectionPolicy,
      ...metadata,
    },
  });
}
