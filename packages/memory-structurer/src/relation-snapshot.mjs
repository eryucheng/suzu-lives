import { DIRECT_INGESTION_MEMORY_KINDS } from "@suzu-lives/memory-core";

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

export function buildRelationSnapshot({
  repository,
  agentId,
  batchId = "",
  memoryIds = [],
  maxMemories = 32,
  maxSourcesPerMemory = 6,
  maxMemoryContentChars = 600,
  maxSourceContentChars = 900,
  maxSnapshotChars = 48_000,
  retrospective = null,
} = {}) {
  if (!repository) throw new Error("Relation snapshot requires a repository.");
  const normalizedAgentId = clean(agentId);
  if (!normalizedAgentId) throw new Error("Relation snapshot requires agentId.");
  const requestedIds = uniqueStrings(memoryIds);
  const memoryLimit = Math.min(80, Math.max(2, Math.trunc(Number(maxMemories) || 32)));
  const sourceLimit = Math.min(20, Math.max(1, Math.trunc(Number(maxSourcesPerMemory) || 6)));
  const memoryCharLimit = Math.min(4000, Math.max(100, Math.trunc(Number(maxMemoryContentChars) || 600)));
  const sourceCharLimit = Math.min(6000, Math.max(100, Math.trunc(Number(maxSourceContentChars) || 900)));
  const snapshotCharLimit = Math.min(250_000, Math.max(4_000, Math.trunc(Number(maxSnapshotChars) || 48_000)));
  const sourceRecords = new Map();
  const excluded = [];
  const memories = [];
  for (const id of requestedIds.slice(0, memoryLimit)) {
    const memory = repository.getMemory(id);
    if (!memory || memory.agent_id !== normalizedAgentId) {
      throw new Error(`Relation snapshot memory must exist for the same Agent: ${id}`);
    }
    if (memory.status !== "active" || !DIRECT_INGESTION_MEMORY_KINDS.includes(memory.kind)) {
      excluded.push({ id, reason: memory.status !== "active" ? "not-active" : "not-direct-memory" });
      continue;
    }
    const detail = repository.getMemoryDetail(normalizedAgentId, id);
    const sources = detail.sources.slice(0, sourceLimit);
    for (const source of sources) {
      if (!sourceRecords.has(source.id)) {
        sourceRecords.set(source.id, {
          id: source.id,
          sourceKind: source.source_kind,
          occurredAt: source.occurred_at,
          knownAt: source.known_at,
          recordedAt: source.recorded_at,
          speaker: source.speaker,
          content: clip(source.content, sourceCharLimit),
        });
      }
    }
    memories.push({
      id: memory.id,
      kind: memory.kind,
      layer: memory.layer,
      title: clip(memory.title, 160),
      content: clip(memory.content, memoryCharLimit),
      subjectRole: memory.subject_role,
      subjectKey: memory.subject_key,
      reality: memory.reality,
      temporalState: memory.temporal_state,
      eventDate: memory.event_date,
      eventStart: memory.event_start,
      eventEnd: memory.event_end,
      knownAt: memory.known_at,
      sourceIds: sources.map((source) => source.id),
      sourcesTruncated: detail.sources.length > sourceLimit,
    });
  }
  let retrospectiveContext = null;
  if (retrospective) {
    const triggerMemoryIds = uniqueStrings(retrospective.triggerMemoryIds);
    const historicalMemoryIds = uniqueStrings(retrospective.historicalMemoryIds);
    const currentIds = new Set(memories.map((memory) => memory.id));
    if (!triggerMemoryIds.length || !historicalMemoryIds.length
      || [...triggerMemoryIds, ...historicalMemoryIds].some((id) => !currentIds.has(id))
      || triggerMemoryIds.some((id) => historicalMemoryIds.includes(id))) {
      throw new Error("Retrospective relation context must partition snapshot memories into trigger and historical IDs.");
    }
    retrospectiveContext = { triggerMemoryIds, historicalMemoryIds };
  }
  const snapshot = {
    schemaVersion: 1,
    batchId: clean(batchId),
    memories,
    sourceRecords: [...sourceRecords.values()],
    retrospectiveContext,
    inputPolicy: {
      candidateEndpointsAreBounded: true,
      sourceIdsMustAlreadySupportAnEndpoint: true,
      includesFilesystemPaths: false,
      includesSourceMetadata: false,
      modelCannotWriteEdges: true,
    },
    omitted: {
      requestedMemories: requestedIds.length,
      memoriesExcluded: excluded,
      memoriesTruncated: Math.max(0, requestedIds.length - memoryLimit),
    },
  };
  if (JSON.stringify(snapshot).length > snapshotCharLimit) {
    throw new Error(`Relation snapshot exceeds the ${snapshotCharLimit}-character privacy budget.`);
  }
  return snapshot;
}
