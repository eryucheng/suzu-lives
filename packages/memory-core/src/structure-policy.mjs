import { createHash } from "node:crypto";

import {
  MEMORY_ACTOR_ROLES,
  SUBJECT_ROLES,
} from "./ontology.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function bounded(value, fallback, minimum = 0, maximum = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
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

function normalizeActorRoles(values) {
  const roles = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const role = clean(value?.role);
    const actorRole = clean(value?.actorRole ?? value?.actor_role);
    const actorKey = clean(value?.actorKey ?? value?.actor_key);
    if (!MEMORY_ACTOR_ROLES.includes(role)) {
      throw new Error(`Unknown memory actor role: ${role || "(empty)"}.`);
    }
    if (!SUBJECT_ROLES.includes(actorRole)) {
      throw new Error(`Unknown actor identity role: ${actorRole || "(empty)"}.`);
    }
    if (!["world", "unknown"].includes(actorRole) && !actorKey) {
      throw new Error("Memory actor role requires actorKey.");
    }
    const key = `${role}\u001f${actorRole}\u001f${actorKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    roles.push({
      role,
      actorRole,
      actorKey,
      isPrimary: Boolean(value?.isPrimary ?? value?.is_primary),
      confidence: bounded(value?.confidence, 1),
      provenance: clean(value?.provenance),
      metadata: value?.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
        ? value.metadata
        : {},
    });
  }
  return roles.sort((left, right) => (
    left.role.localeCompare(right.role)
    || left.actorRole.localeCompare(right.actorRole)
    || left.actorKey.localeCompare(right.actorKey)
  ));
}

function validateMembers(repository, {
  agentId,
  kind,
  memberIds,
  minimum = 2,
  targetMemoryId = "",
}) {
  const ids = [...new Set(
    (Array.isArray(memberIds) ? memberIds : []).map(clean).filter(Boolean),
  )];
  if (ids.length < minimum) {
    throw new Error(`A structure proposal requires at least ${minimum} distinct member${minimum === 1 ? "" : "s"}.`);
  }
  if (clean(targetMemoryId) && ids.includes(clean(targetMemoryId))) {
    throw new Error("A structure target cannot also be one of its members.");
  }
  const members = ids.map((id) => repository.getMemory(id));
  if (members.some((memory) => !memory || memory.agent_id !== agentId)) {
    throw new Error("Every proposed member must exist for the same Agent.");
  }
  if (members.some((memory) => memory.status === "deleted")) {
    throw new Error("Deleted memories cannot become structure proposal members.");
  }
  if (
    kind === "episode"
    && members.some((memory) => ["episode", "topic", "topic_or_episode"].includes(memory.kind))
  ) {
    throw new Error("An episode proposal can contain only concrete memories.");
  }
  if (
    kind === "topic"
    && members.some((memory) => ["topic", "topic_or_episode"].includes(memory.kind))
  ) {
    throw new Error("A topic proposal cannot contain another topic.");
  }
  return members;
}

function existingMembershipIds(repository, { agentId, kind, targetMemoryId }) {
  if (!clean(targetMemoryId)) return new Set();
  const statuses = ["active", "superseded", "disputed", "archived"];
  const members = kind === "episode"
    ? repository.listEpisodeMembers({ agentId, episodeId: targetMemoryId, statuses })
    : repository.listTopicMembers({ agentId, topicId: targetMemoryId, statuses });
  return new Set(members.map((memory) => memory.id));
}

function validateAttachTarget(repository, { agentId, kind, targetMemoryId }) {
  const target = repository.getMemory(clean(targetMemoryId));
  if (!target || target.agent_id !== agentId) {
    throw new Error("Attach proposal target must exist for the same Agent.");
  }
  if (target.status !== "active" || target.kind !== kind) {
    throw new Error(`Attach proposal target must be an active ${kind} node.`);
  }
  return target;
}

function normalizeProposal(repository, input = {}) {
  if (!repository) throw new Error("Structure proposal requires a repository.");
  const agentId = clean(input.agentId);
  const operation = clean(input.operation) || "create";
  const targetMemoryId = clean(input.targetMemoryId ?? input.target_memory_id);
  const kind = clean(input.kind);
  if (!agentId || !["create", "attach"].includes(operation) || !["episode", "topic"].includes(kind)) {
    throw new Error("Structure proposal requires agentId, create/attach operation, and episode/topic kind.");
  }
  if (operation === "create" && targetMemoryId) {
    throw new Error("Create proposal cannot reference an existing target.");
  }
  if (operation === "attach" && !targetMemoryId) {
    throw new Error("Attach proposal requires targetMemoryId.");
  }

  const target = operation === "attach"
    ? validateAttachTarget(repository, { agentId, kind, targetMemoryId })
    : null;
  let memberIds = [...new Set(
    (Array.isArray(input.memberIds) ? input.memberIds : []).map(clean).filter(Boolean),
  )];
  validateMembers(repository, {
    agentId,
    kind,
    memberIds,
    minimum: operation === "attach" ? 1 : 2,
    targetMemoryId,
  });
  if (target) {
    const existing = existingMembershipIds(repository, { agentId, kind, targetMemoryId });
    memberIds = memberIds.filter((id) => !existing.has(id));
    if (!memberIds.length) {
      throw new Error("Attach proposal must add at least one new member.");
    }
  }
  const content = target ? target.content : clean(input.content);
  const subjectRole = target ? target.subject_role : clean(input.subjectRole) || "unknown";
  const subjectKey = target ? target.subject_key : clean(input.subjectKey);
  const eventDate = target ? clean(target.event_date) : clean(input.eventDate);
  const eventStart = target ? clean(target.event_start) : clean(input.eventStart);
  const eventEnd = target ? clean(target.event_end) : clean(input.eventEnd);
  const actorRoles = target
    ? normalizeActorRoles(repository.listMemoryRoles(target.id))
    : normalizeActorRoles(input.actorRoles);
  if (!content) throw new Error("Structure proposal content cannot be empty.");
  if (!SUBJECT_ROLES.includes(subjectRole)) {
    throw new Error(`Unknown structure subject role: ${subjectRole}.`);
  }
  if (!["world", "unknown"].includes(subjectRole) && !subjectKey) {
    throw new Error("Structure proposal subject requires subjectKey.");
  }
  if (kind === "episode") {
    if (!eventDate && !eventStart) {
      throw new Error("Episode proposal requires eventDate or eventStart.");
    }
    if (eventDate && !validIsoDate(eventDate)) {
      throw new Error("Episode proposal eventDate must be a valid YYYY-MM-DD date.");
    }
    if (eventStart && !validTimestamp(eventStart)) {
      throw new Error("Episode proposal eventStart must be a valid timestamp.");
    }
    if (eventEnd && !validTimestamp(eventEnd)) {
      throw new Error("Episode proposal eventEnd must be a valid timestamp.");
    }
    if (eventEnd && !eventStart) {
      throw new Error("Episode proposal eventEnd requires eventStart.");
    }
    if (eventStart && eventEnd && Date.parse(eventEnd) < Date.parse(eventStart)) {
      throw new Error("Episode proposal eventEnd cannot be before eventStart.");
    }
  } else if (eventDate || eventStart || eventEnd) {
    throw new Error("Topic proposal cannot carry event time.");
  }
  return {
    agentId,
    batchId: clean(input.batchId),
    operation,
    targetMemoryId: target?.id || "",
    kind,
    title: target ? target.title : clean(input.title),
    content,
    subjectRole,
    subjectKey,
    eventDate: eventDate || null,
    eventStart: eventStart || null,
    eventEnd: eventEnd || null,
    memberIds,
    actorRoles,
    confidence: bounded(input.confidence, 0.5),
    rationale: clean(input.rationale),
    provenance: clean(input.provenance) || "structure-proposal-v1",
    metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? input.metadata
      : {},
    createdAt: clean(input.createdAt) || new Date().toISOString(),
  };
}

function proposalHash(candidate) {
  return createHash("sha256").update(JSON.stringify({
    operation: candidate.operation,
    targetMemoryId: candidate.targetMemoryId,
    kind: candidate.kind,
    title: candidate.title,
    content: candidate.content,
    subjectRole: candidate.subjectRole,
    subjectKey: candidate.subjectKey,
    eventDate: candidate.eventDate,
    eventStart: candidate.eventStart,
    eventEnd: candidate.eventEnd,
    memberIds: [...candidate.memberIds].sort(),
    actorRoles: candidate.actorRoles.map((actor) => ({
      role: actor.role,
      actorRole: actor.actorRole,
      actorKey: actor.actorKey,
      isPrimary: actor.isPrimary,
    })),
  })).digest("hex");
}

export function proposeMemoryStructure(repository, input = {}) {
  const candidate = normalizeProposal(repository, input);
  const hash = proposalHash(candidate);
  const id = clean(input.id) || `structure-proposal-${createHash("sha256")
    .update(`${candidate.agentId}\u001f${hash}`)
    .digest("hex")
    .slice(0, 24)}`;
  return repository.recordStructureProposal({
    ...candidate,
    id,
    proposalHash: hash,
  });
}

export function resolveMemoryStructureProposal(repository, {
  agentId,
  proposalId,
  action,
  resolvedBy = "human",
  note = "",
} = {}) {
  if (!repository) throw new Error("Resolving a structure proposal requires a repository.");
  const normalizedAgentId = clean(agentId);
  const normalizedAction = clean(action);
  const proposal = repository.getStructureProposal(normalizedAgentId, proposalId);
  if (!proposal) throw new Error("Structure proposal does not exist for this Agent.");
  if (proposal.review_state !== "pending") {
    throw new Error(`Structure proposal is already ${proposal.review_state}.`);
  }
  if (!["accept", "dismiss"].includes(normalizedAction)) {
    throw new Error(`Unknown structure proposal action: ${normalizedAction || "(empty)"}.`);
  }
  if (normalizedAction === "dismiss") {
    return repository.transaction(() => ({
      status: "dismissed",
      proposal: repository.resolveStructureProposal({
        agentId: normalizedAgentId,
        proposalId: proposal.id,
        resolution: "dismissed",
        resolvedBy,
        note,
      }),
      memory: null,
      members: [],
    }));
  }

  const target = proposal.operation === "attach"
    ? validateAttachTarget(repository, {
      agentId: normalizedAgentId,
      kind: proposal.kind,
      targetMemoryId: proposal.targetMemoryId,
    })
    : null;
  const members = validateMembers(repository, {
    agentId: normalizedAgentId,
    kind: proposal.kind,
    memberIds: proposal.memberIds,
    minimum: proposal.operation === "attach" ? 1 : 2,
    targetMemoryId: proposal.targetMemoryId,
  });
  return repository.transaction(() => {
    const common = {
      agentId: normalizedAgentId,
      title: proposal.title,
      content: proposal.content,
      subjectRole: proposal.subject_role,
      subjectKey: proposal.subject_key,
      actorRoles: proposal.actorRoles,
      confidence: proposal.confidence,
      evidenceMode: "manual",
      metadata: {
        ...proposal.metadata,
        structureProposalId: proposal.id,
        structureProposalProvenance: proposal.provenance,
        structureProposalRationale: proposal.rationale,
      },
    };
    let memory = target || (proposal.kind === "episode"
      ? repository.upsertEpisode({
        ...common,
        eventDate: proposal.event_date,
        eventStart: proposal.event_start,
        eventEnd: proposal.event_end,
      })
      : repository.upsertTopic(common));
    const existing = target
      ? existingMembershipIds(repository, {
        agentId: normalizedAgentId,
        kind: proposal.kind,
        targetMemoryId: target.id,
      })
      : new Set();
    const addedMemberIds = [];
    for (const member of members) {
      if (existing.has(member.id)) continue;
      const linkOptions = {
        agentId: normalizedAgentId,
        memoryId: member.id,
        confidence: proposal.confidence,
        provenance: proposal.provenance,
        metadata: { structureProposalId: proposal.id },
      };
      if (proposal.kind === "episode") {
        repository.linkMemoryToEpisode({ ...linkOptions, episodeId: memory.id });
      } else {
        repository.linkMemoryToTopic({ ...linkOptions, topicId: memory.id });
      }
      addedMemberIds.push(member.id);
    }
    if (target && proposal.kind === "episode") {
      memory = repository.expandEpisodeToMemories({
        agentId: normalizedAgentId,
        episodeId: target.id,
        memoryIds: members.map((member) => member.id),
      });
    }
    const resolved = repository.resolveStructureProposal({
      agentId: normalizedAgentId,
      proposalId: proposal.id,
      resolution: "accepted",
      resultMemoryId: memory.id,
      resolvedBy,
      note,
    });
    return {
      status: "accepted",
      proposal: resolved,
      memory: repository.getMemory(memory.id),
      addedMemberIds,
      members: proposal.kind === "episode"
        ? repository.listEpisodeMembers({ agentId: normalizedAgentId, episodeId: memory.id })
        : repository.listTopicMembers({ agentId: normalizedAgentId, topicId: memory.id }),
    };
  });
}
