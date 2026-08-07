import { createHash } from "node:crypto";

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

function dayOf(value) {
  const text = clean(value);
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) return text;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : "";
}

function stableSourceGroup(sourceIds) {
  const signature = [...sourceIds].sort().join("\u001f");
  return `sources:${createHash("sha256").update(signature).digest("hex").slice(0, 24)}`;
}

function episodeIdsForMemory(repository, agentId, memoryId) {
  const graph = repository.expand(agentId, [memoryId], {
    maxDepth: 1,
    maxNodes: 20,
    relations: ["part_of_episode"],
  });
  return graph.nodes
    .filter((memory) => memory.id !== memoryId && memory.kind === "episode" && memory.status === "active")
    .map((memory) => memory.id)
    .sort();
}

function contextIdentity(memory, sources, episodeIds) {
  if (episodeIds.length) {
    const id = `episode:${episodeIds[0]}`;
    return { evidenceGroupId: id, contextId: id, contextBasis: "reviewed-episode" };
  }
  const sourceIds = sources.map((source) => source.id).sort();
  const evidenceGroupId = sourceIds.length ? stableSourceGroup(sourceIds) : `memory:${memory.id}`;
  const contextDay = dayOf(
    memory.event_date
      || memory.event_start
      || sources.find((source) => source.occurred_at)?.occurred_at
      || sources.find((source) => source.known_at)?.known_at,
  );
  return {
    evidenceGroupId,
    contextId: contextDay ? `day:${contextDay}` : "",
    contextBasis: contextDay ? "natural-day" : "unknown",
  };
}

function unifyEpisodeContextGroups(memories) {
  const parent = new Map(memories.map((memory) => [memory.id, memory.id]));
  const find = (id) => {
    const current = parent.get(id);
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  const firstMemoryByEpisode = new Map();
  for (const memory of memories) {
    for (const episodeId of memory.episodeIds) {
      const first = firstMemoryByEpisode.get(episodeId);
      if (first) union(first, memory.id);
      else firstMemoryByEpisode.set(episodeId, memory.id);
    }
  }
  const episodesByRoot = new Map();
  for (const memory of memories) {
    if (!memory.episodeIds.length) continue;
    const root = find(memory.id);
    const episodeIds = episodesByRoot.get(root) || new Set();
    memory.episodeIds.forEach((episodeId) => episodeIds.add(episodeId));
    episodesByRoot.set(root, episodeIds);
  }
  for (const memory of memories) {
    if (!memory.episodeIds.length) continue;
    const sharedEpisodes = [...episodesByRoot.get(find(memory.id))].sort();
    const id = `episode:${sharedEpisodes[0]}`;
    memory.evidenceGroupId = id;
    memory.contextId = id;
    memory.contextBasis = "reviewed-episode";
  }
}

function roleView(role) {
  return {
    role: role.role,
    actorRole: role.actor_role,
    actorKey: role.actor_key,
    isPrimary: Boolean(role.is_primary),
    confidence: Number(role.confidence),
  };
}

export function buildPreferenceEvidenceSnapshot({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  memoryIds = [],
  maxMemories = 40,
  maxSourcesPerMemory = 8,
  maxMemoryContentChars = 700,
  maxSourceContentChars = 1000,
  maxSnapshotChars = 64_000,
  allowUtteranceEvidence = false,
  allowedSourceIds = [],
} = {}) {
  if (!repository) throw new Error("Preference evidence snapshot requires a repository.");
  const normalizedAgentId = clean(agentId);
  const normalizedSubjectRole = clean(subjectRole);
  const normalizedSubjectKey = clean(subjectKey);
  const normalizedCanonicalKey = clean(canonicalKey).toLocaleLowerCase("en-US");
  if (!normalizedAgentId || !["user", "agent", "shared", "other"].includes(normalizedSubjectRole)
    || !normalizedSubjectKey || !normalizedCanonicalKey) {
    throw new Error("Preference evidence snapshot requires an Agent, identified holder, and canonicalKey.");
  }

  const requestedIds = uniqueStrings(memoryIds);
  const memoryLimit = Math.min(100, Math.max(1, Math.trunc(Number(maxMemories) || 40)));
  const sourceLimit = Math.min(20, Math.max(1, Math.trunc(Number(maxSourcesPerMemory) || 8)));
  const memoryCharLimit = Math.min(4000, Math.max(100, Math.trunc(Number(maxMemoryContentChars) || 700)));
  const sourceCharLimit = Math.min(6000, Math.max(100, Math.trunc(Number(maxSourceContentChars) || 1000)));
  const snapshotCharLimit = Math.min(250_000, Math.max(4_000, Math.trunc(Number(maxSnapshotChars) || 64_000)));
  const sourceRecords = new Map();
  const sourceBoundary = new Set(uniqueStrings(allowedSourceIds));
  const memories = [];
  const excluded = [];

  for (const id of requestedIds.slice(0, memoryLimit)) {
    const memory = repository.getMemory(id);
    if (!memory || memory.agent_id !== normalizedAgentId) {
      throw new Error(`Preference snapshot memory must exist for the same Agent: ${id}`);
    }
    if (memory.status !== "active") {
      excluded.push({ id, reason: "not-active" });
      continue;
    }
    const requestBoundUtterance = allowUtteranceEvidence && memory.kind === "utterance";
    if (!DIRECT_INGESTION_MEMORY_KINDS.includes(memory.kind) && !requestBoundUtterance) {
      excluded.push({ id, reason: "not-direct-memory" });
      continue;
    }
    if (memory.reality !== "real") {
      excluded.push({ id, reason: "reality-not-real" });
      continue;
    }
    const detail = repository.getMemoryDetail(normalizedAgentId, id);
    const acceptedSourceRelation = requestBoundUtterance ? "verbatim" : "evidence";
    const sources = detail.sources
      .filter((source) => source.relation === acceptedSourceRelation)
      .filter((source) => !sourceBoundary.size || sourceBoundary.has(source.id))
      .slice(0, sourceLimit);
    if (!sources.length) {
      excluded.push({ id, reason: "missing-direct-source" });
      continue;
    }
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
    const episodeIds = episodeIdsForMemory(repository, normalizedAgentId, memory.id);
    const identity = contextIdentity(memory, sources, episodeIds);
    memories.push({
      id: memory.id,
      kind: memory.kind,
      title: clip(memory.title, 160),
      content: clip(memory.content, memoryCharLimit),
      subjectRole: memory.subject_role,
      subjectKey: memory.subject_key,
      reality: memory.reality,
      evidenceMode: memory.evidence_mode,
      temporalState: memory.temporal_state,
      eventDate: memory.event_date,
      eventStart: memory.event_start,
      eventEnd: memory.event_end,
      knownAt: memory.known_at,
      actorRoles: detail.roles.map(roleView),
      sourceIds: sources.map((source) => source.id),
      sourcesTruncated: detail.sources
        .filter((source) => source.relation === acceptedSourceRelation).length > sourceLimit,
      episodeIds,
      ...identity,
    });
  }

  unifyEpisodeContextGroups(memories);
  const snapshot = {
    schemaVersion: 1,
    target: {
      subjectRole: normalizedSubjectRole,
      subjectKey: normalizedSubjectKey,
      canonicalKey: normalizedCanonicalKey,
    },
    memories,
    sourceRecords: [...sourceRecords.values()],
    inputPolicy: {
      targetIsFixedByCaller: true,
      candidateMemoriesAreBounded: true,
      sourceIdsMustAlreadySupportMemory: true,
      evidenceAndContextGroupsAreCodeDerived: true,
      includesFilesystemPaths: false,
      includesSourceMetadata: false,
      modelCanWriteMemory: false,
      requestBoundUtteranceEvidence: Boolean(allowUtteranceEvidence),
      sourceIdsAreCallerBounded: sourceBoundary.size > 0,
    },
    omitted: {
      requestedMemories: requestedIds.length,
      memoriesExcluded: excluded,
      memoriesTruncated: Math.max(0, requestedIds.length - memoryLimit),
    },
  };
  if (JSON.stringify(snapshot).length > snapshotCharLimit) {
    throw new Error(`Preference evidence snapshot exceeds the ${snapshotCharLimit}-character privacy budget.`);
  }
  return snapshot;
}
