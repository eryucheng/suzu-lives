import {
  BIG_NEURON_KINDS,
  DIRECT_INGESTION_MEMORY_KINDS,
} from "@suzu-lives/memory-core";

function clean(value) {
  return String(value ?? "").trim();
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
}

function clip(value, maximum) {
  const text = clean(value);
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

function actorView(repository, memoryId) {
  return repository.listMemoryRoles(memoryId).map((role) => ({
    role: role.role,
    actorRole: role.actor_role,
    actorKey: role.actor_key,
    isPrimary: Boolean(role.is_primary),
    confidence: Number(role.confidence),
  }));
}

function entityView(repository, memoryId) {
  return repository.listMemoryEntities(memoryId).map((entity) => ({
    id: entity.id,
    kind: entity.kind,
    name: entity.canonical_name,
    role: entity.link_role,
  }));
}

function memoryView(repository, memory, maximumContentChars) {
  return {
    id: memory.id,
    kind: memory.kind,
    layer: memory.layer,
    title: clip(memory.title, 160),
    content: clip(memory.content, maximumContentChars),
    subjectRole: memory.subject_role,
    subjectKey: memory.subject_key,
    reality: memory.reality,
    temporalState: memory.temporal_state,
    eventDate: memory.event_date,
    eventStart: memory.event_start,
    eventEnd: memory.event_end,
    knownAt: memory.known_at,
    confidence: Number(memory.confidence),
    importance: Number(memory.importance),
    actorRoles: actorView(repository, memory.id),
    entities: entityView(repository, memory.id),
  };
}

function containerView(repository, memory, maximumContentChars, maximumMemberIds) {
  const members = memory.kind === "episode"
    ? repository.listEpisodeMembers({
      agentId: memory.agent_id,
      episodeId: memory.id,
      statuses: ["active", "superseded", "disputed", "archived"],
    })
    : repository.listTopicMembers({
      agentId: memory.agent_id,
      topicId: memory.id,
      statuses: ["active", "superseded", "disputed", "archived"],
    });
  return {
    ...memoryView(repository, memory, maximumContentChars),
    memberIds: members.slice(0, maximumMemberIds).map((member) => member.id),
    memberCount: members.length,
    memberIdsTruncated: members.length > maximumMemberIds,
  };
}

function checkedMemory(repository, agentId, id, label) {
  const memory = repository.getMemory(id);
  if (!memory || memory.agent_id !== agentId) {
    throw new Error(`${label} memory must exist for the same Agent: ${id}`);
  }
  return memory;
}

export function buildStructureSnapshot({
  repository,
  agentId,
  batchId = "",
  memoryIds = [],
  nearbyContainerIds = [],
  maxMemories = 40,
  maxContainers = 12,
  maxMemberIdsPerContainer = 30,
  maxContentChars = 700,
  maxSnapshotChars = 32_000,
  retrospective = null,
} = {}) {
  if (!repository) throw new Error("Structure snapshot requires a repository.");
  const normalizedAgentId = clean(agentId);
  if (!normalizedAgentId) throw new Error("Structure snapshot requires agentId.");
  const requestedIds = uniqueStrings(memoryIds);
  const memoryLimit = Math.min(100, Math.max(1, Math.trunc(Number(maxMemories) || 40)));
  const containerLimit = Math.min(50, Math.max(0, Math.trunc(Number(maxContainers) || 12)));
  const memberLimit = Math.min(200, Math.max(0, Math.trunc(Number(maxMemberIdsPerContainer) || 30)));
  const perMemoryLimit = Math.min(4000, Math.max(100, Math.trunc(Number(maxContentChars) || 700)));
  const characterLimit = Math.min(200_000, Math.max(4_000, Math.trunc(Number(maxSnapshotChars) || 32_000)));
  const excluded = [];
  const current = [];
  for (const id of requestedIds.slice(0, memoryLimit)) {
    const memory = checkedMemory(repository, normalizedAgentId, id, "Current batch");
    if (memory.status !== "active" || !DIRECT_INGESTION_MEMORY_KINDS.includes(memory.kind)) {
      excluded.push({ id, reason: memory.status !== "active" ? "not-active" : "not-direct-memory" });
      continue;
    }
    current.push(memory);
  }

  const candidateIds = [];
  const addCandidate = (id) => {
    const normalized = clean(id);
    if (normalized && !candidateIds.includes(normalized)) candidateIds.push(normalized);
  };
  for (const id of uniqueStrings(nearbyContainerIds)) {
    const memory = checkedMemory(repository, normalizedAgentId, id, "Nearby container");
    if (memory.status === "active" && BIG_NEURON_KINDS.includes(memory.kind)) addCandidate(id);
  }
  if (current.length && containerLimit) {
    const graph = repository.expand(normalizedAgentId, current.map((memory) => memory.id), {
      maxDepth: 1,
      maxNodes: current.length + containerLimit,
      relations: ["part_of_episode", "supports_topic"],
    });
    for (const memory of graph.nodes) {
      if (memory.status === "active" && BIG_NEURON_KINDS.includes(memory.kind)) addCandidate(memory.id);
    }
    for (const memory of current) {
      for (const entity of repository.listMemoryEntities(memory.id)) {
        for (const related of repository.listEntityMemories({
          agentId: normalizedAgentId,
          entityId: entity.id,
        })) {
          if (related.status === "active" && BIG_NEURON_KINDS.includes(related.kind)) {
            addCandidate(related.id);
          }
          if (candidateIds.length >= containerLimit) break;
        }
        if (candidateIds.length >= containerLimit) break;
      }
      if (candidateIds.length >= containerLimit) break;
    }
    if (candidateIds.length < containerLimit) {
      const relatedGraph = repository.expand(
        normalizedAgentId,
        current.map((memory) => memory.id),
        {
          maxDepth: 1,
          maxNodes: current.length + (containerLimit * 3),
          relations: ["associated_with", "same_thread", "shares_entity"],
        },
      );
      const relatedIds = relatedGraph.nodes
        .filter((memory) => (
          memory.status === "active"
          && !BIG_NEURON_KINDS.includes(memory.kind)
          && !current.some((item) => item.id === memory.id)
        ))
        .map((memory) => memory.id);
      if (relatedIds.length) {
        const containers = repository.expand(normalizedAgentId, relatedIds, {
          maxDepth: 1,
          maxNodes: relatedIds.length + containerLimit,
          relations: ["part_of_episode", "supports_topic"],
        });
        for (const memory of containers.nodes) {
          if (memory.status === "active" && BIG_NEURON_KINDS.includes(memory.kind)) {
            addCandidate(memory.id);
          }
          if (candidateIds.length >= containerLimit) break;
        }
      }
    }
  }

  let retrospectiveContext = null;
  if (retrospective) {
    const triggerMemoryIds = uniqueStrings(retrospective.triggerMemoryIds);
    const historicalMemoryIds = uniqueStrings(retrospective.historicalMemoryIds);
    const currentIds = new Set(current.map((memory) => memory.id));
    if (!triggerMemoryIds.length || !historicalMemoryIds.length
      || [...triggerMemoryIds, ...historicalMemoryIds].some((id) => !currentIds.has(id))
      || triggerMemoryIds.some((id) => historicalMemoryIds.includes(id))) {
      throw new Error("Retrospective structure context must partition current memories into trigger and historical IDs.");
    }
    retrospectiveContext = { triggerMemoryIds, historicalMemoryIds };
  }
  const snapshot = {
    schemaVersion: 1,
    batchId: clean(batchId),
    currentMemories: current.map((memory) => memoryView(repository, memory, perMemoryLimit)),
    candidateContainers: candidateIds.slice(0, containerLimit).map((id) => (
      containerView(repository, repository.getMemory(id), perMemoryLimit, memberLimit)
    )),
    retrospectiveContext,
    inputPolicy: {
      includesRawUtterances: false,
      includesSourceRecords: false,
      includesFilesystemPaths: false,
      currentBatchOnly: true,
      candidateContainersAreBounded: true,
    },
    omitted: {
      requestedMemories: requestedIds.length,
      currentMemoriesExcluded: excluded,
      currentMemoriesTruncated: Math.max(0, requestedIds.length - memoryLimit),
      candidateContainersTruncated: Math.max(0, candidateIds.length - containerLimit),
    },
  };
  if (JSON.stringify(snapshot).length > characterLimit) {
    throw new Error(`Structure snapshot exceeds the ${characterLimit}-character privacy budget.`);
  }
  return snapshot;
}
