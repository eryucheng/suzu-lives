import { createHash } from "node:crypto";

import {
  MEMORY_ACTOR_ROLES,
  SUBJECT_ROLES,
} from "./ontology.mjs";

export const SUBJECT_ATTRIBUTION_POLICY_VERSION = "legacy-subject-attribution-v1";

function clean(value) {
  return String(value ?? "").trim();
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]),
  );
}

function canonicalHash(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(value)))
    .digest("hex");
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
}

function boundedConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error("Subject attribution confidence must be between 0 and 1.");
  }
  return number;
}

function normalizeActor(actor, label = "Allowed actor") {
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
    throw new Error(`${label} must be an object.`);
  }
  const role = clean(actor.role || actor.actorRole);
  const key = clean(actor.key || actor.actorKey);
  if (!SUBJECT_ROLES.includes(role) || role === "unknown") {
    throw new Error(`${label} requires a concrete role.`);
  }
  if (role !== "world" && !key) {
    throw new Error(`${label} requires a stable key.`);
  }
  return {
    role,
    key,
    name: clean(actor.name || actor.label),
  };
}

function normalizeAllowedActors(actors) {
  const normalized = (Array.isArray(actors) ? actors : []).map((actor, index) => (
    normalizeActor(actor, `Allowed actor ${index}`)
  ));
  const unique = new Map(normalized.map((actor) => [`${actor.role}\u001f${actor.key}`, actor]));
  if (!unique.size) throw new Error("Subject attribution requires allowedActors.");
  return [...unique.values()].sort((left, right) => (
    `${left.role}\u001f${left.key}`.localeCompare(`${right.role}\u001f${right.key}`)
  ));
}

function actorIsAllowed(actor, allowedActors) {
  return allowedActors.some((allowed) => allowed.role === actor.role && allowed.key === actor.key);
}

function sourceView(source, maximumContentChars) {
  const content = clean(source.content);
  return {
    id: source.id,
    kind: source.source_kind,
    occurredAt: source.occurred_at,
    knownAt: source.known_at,
    speaker: clean(source.speaker),
    content: content.length <= maximumContentChars
      ? content
      : `${content.slice(0, Math.max(0, maximumContentChars - 1))}…`,
    contentHash: source.content_hash,
  };
}

export function buildSubjectAttributionSnapshot({
  repository,
  agentId,
  memoryId,
  allowedActors,
  maximumSources = 24,
  maximumSourceChars = 1200,
  maximumSnapshotChars = 36_000,
} = {}) {
  if (!repository) throw new Error("Subject attribution snapshot requires a repository.");
  const normalizedAgentId = clean(agentId);
  const normalizedMemoryId = clean(memoryId);
  if (!normalizedAgentId || !normalizedMemoryId) {
    throw new Error("Subject attribution snapshot requires agentId and memoryId.");
  }
  const detail = repository.getMemoryDetail(normalizedAgentId, normalizedMemoryId);
  if (!detail) throw new Error("Subject attribution target does not exist for this Agent.");
  if (detail.memory.subject_role !== "unknown") {
    throw new Error("Subject attribution only accepts memories whose subject is unknown.");
  }
  if (!["event", "fact", "reflection", "plan", "commitment", "open_loop"].includes(detail.memory.kind)) {
    throw new Error("Subject attribution only accepts concrete legacy memories.");
  }
  const sourceLimit = Math.min(100, Math.max(1, Math.trunc(Number(maximumSources) || 24)));
  if (!detail.sources.length) throw new Error("Subject attribution requires linked source evidence.");
  if (detail.sources.length > sourceLimit) {
    throw new Error(`Subject attribution source count exceeds the ${sourceLimit}-source review bound.`);
  }
  const perSourceLimit = Math.min(8000, Math.max(160, Math.trunc(Number(maximumSourceChars) || 1200)));
  const actors = normalizeAllowedActors(allowedActors);
  const sources = detail.sources.map((source) => sourceView(source, perSourceLimit));
  const currentRoles = detail.roles.map((role) => ({
    role: role.role,
    actorRole: role.actor_role,
    actorKey: role.actor_key,
    isPrimary: Boolean(role.is_primary),
    confidence: Number(role.confidence),
  }));
  const fingerprint = {
    memory: {
      id: detail.memory.id,
      kind: detail.memory.kind,
      title: detail.memory.title,
      content: detail.memory.content,
      subjectRole: detail.memory.subject_role,
      subjectKey: detail.memory.subject_key,
      eventDate: detail.memory.event_date,
      eventStart: detail.memory.event_start,
      eventEnd: detail.memory.event_end,
      knownAt: detail.memory.known_at,
      status: detail.memory.status,
    },
    currentRoles,
    sources: sources.map((source) => ({
      id: source.id,
      speaker: source.speaker,
      contentHash: source.contentHash,
      occurredAt: source.occurredAt,
      knownAt: source.knownAt,
    })),
    allowedActors: actors,
  };
  const snapshot = {
    schemaVersion: 1,
    policyVersion: SUBJECT_ATTRIBUTION_POLICY_VERSION,
    memory: fingerprint.memory,
    currentRoles,
    sources,
    allowedActors: actors,
    sourceSnapshotHash: canonicalHash(fingerprint),
    inputPolicy: {
      linkedSourcesOnly: true,
      fixedActorSet: true,
      speakerIsNotAutomaticallySubject: true,
      canAbstain: true,
      changesMemoryOnlyAfterHumanReview: true,
    },
  };
  const characterLimit = Math.min(200_000, Math.max(4_000, Math.trunc(
    Number(maximumSnapshotChars) || 36_000,
  )));
  if (JSON.stringify(snapshot).length > characterLimit) {
    throw new Error(`Subject attribution snapshot exceeds the ${characterLimit}-character privacy budget.`);
  }
  return snapshot;
}

function normalizeProposedRoles(actorRoles, snapshot) {
  const sourceIds = new Set(snapshot.sources.map((source) => source.id));
  const normalized = (Array.isArray(actorRoles) ? actorRoles : []).map((role, index) => {
    if (!role || typeof role !== "object" || Array.isArray(role)) {
      throw new Error(`Subject attribution actor role ${index} must be an object.`);
    }
    const relationship = clean(role.role);
    if (!MEMORY_ACTOR_ROLES.includes(relationship) || relationship === "subject") {
      throw new Error(`Subject attribution actor role ${index} is not supported.`);
    }
    const actor = normalizeActor({
      role: role.actorRole,
      key: role.actorKey,
    }, `Subject attribution actor role ${index}`);
    if (!actorIsAllowed(actor, snapshot.allowedActors)) {
      throw new Error(`Subject attribution actor role ${index} is outside allowedActors.`);
    }
    const evidenceSourceIds = uniqueStrings(role.sourceIds);
    if (!evidenceSourceIds.length || evidenceSourceIds.some((id) => !sourceIds.has(id))) {
      throw new Error(`Subject attribution actor role ${index} requires linked source evidence.`);
    }
    return {
      role: relationship,
      actorRole: actor.role,
      actorKey: actor.key,
      isPrimary: Boolean(role.isPrimary),
      confidence: boundedConfidence(role.confidence),
      sourceIds: evidenceSourceIds,
    };
  });
  const identities = new Set();
  for (const role of normalized) {
    const identity = `${role.role}\u001f${role.actorRole}\u001f${role.actorKey}`;
    if (identities.has(identity)) throw new Error("Subject attribution actor roles must be unique.");
    identities.add(identity);
  }
  return normalized;
}

export function proposeMemorySubjectAttribution(repository, {
  agentId,
  memoryId,
  allowedActors,
  candidate,
  policyVersion = SUBJECT_ATTRIBUTION_POLICY_VERSION,
  snapshotOptions = {},
} = {}) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Subject attribution candidate must be an object.");
  }
  const snapshot = buildSubjectAttributionSnapshot({
    repository,
    agentId,
    memoryId,
    allowedActors,
    ...snapshotOptions,
  });
  const subject = normalizeActor({
    role: candidate.subjectRole,
    key: candidate.subjectKey,
  }, "Proposed subject");
  if (!actorIsAllowed(subject, snapshot.allowedActors)) {
    throw new Error("Proposed subject is outside allowedActors.");
  }
  const actorRoles = normalizeProposedRoles(candidate.actorRoles, snapshot);
  const sourceIds = uniqueStrings([
    ...(Array.isArray(candidate.sourceIds) ? candidate.sourceIds : []),
    ...actorRoles.flatMap((role) => role.sourceIds),
  ]);
  const availableSourceIds = new Set(snapshot.sources.map((source) => source.id));
  if (!sourceIds.length || sourceIds.some((sourceId) => !availableSourceIds.has(sourceId))) {
    throw new Error("Proposed subject requires linked source evidence.");
  }
  const rationale = clean(candidate.rationale);
  if (!rationale) throw new Error("Subject attribution candidate requires rationale.");
  const proposalHash = canonicalHash({
    agentId: clean(agentId),
    memoryId: clean(memoryId),
    subject,
    actorRoles,
    sourceIds,
    sourceSnapshotHash: snapshot.sourceSnapshotHash,
    policyVersion: clean(policyVersion),
  });
  const proposalId = repository.recordSubjectAttributionProposal({
    agentId,
    memoryId,
    proposedSubjectRole: subject.role,
    proposedSubjectKey: subject.key,
    actorRoles,
    allowedActors: snapshot.allowedActors,
    sourceIds,
    sourceSnapshotHash: snapshot.sourceSnapshotHash,
    proposalHash,
    policyVersion,
    confidence: boundedConfidence(candidate.confidence),
    rationale,
  });
  return repository.getSubjectAttributionProposal(clean(agentId), proposalId);
}

export function resolveMemorySubjectAttribution(repository, {
  agentId,
  proposalId,
  action,
  resolvedBy = "human",
  note = "",
} = {}) {
  const normalizedAgentId = clean(agentId);
  const normalizedProposalId = clean(proposalId);
  const normalizedAction = clean(action);
  if (!normalizedAgentId || !normalizedProposalId) {
    throw new Error("Resolving subject attribution requires agentId and proposalId.");
  }
  if (!["accept", "dismiss"].includes(normalizedAction)) {
    throw new Error("Subject attribution action must be accept or dismiss.");
  }
  const proposal = repository.getSubjectAttributionProposal(
    normalizedAgentId,
    normalizedProposalId,
  );
  if (!proposal) throw new Error("Subject attribution proposal does not exist for this Agent.");
  if (proposal.review_state !== "pending") {
    throw new Error(`Subject attribution proposal is already ${proposal.review_state}.`);
  }
  if (normalizedAction === "dismiss") {
    return {
      status: "dismissed",
      proposal: repository.resolveSubjectAttributionProposalRecord({
        agentId: normalizedAgentId,
        proposalId: normalizedProposalId,
        resolution: "dismissed",
        resolvedBy,
        note,
      }),
      memory: null,
    };
  }

  const currentSnapshot = buildSubjectAttributionSnapshot({
    repository,
    agentId: normalizedAgentId,
    memoryId: proposal.memory_id,
    allowedActors: proposal.allowedActors,
    maximumSources: 100,
    maximumSourceChars: 8000,
    maximumSnapshotChars: 200_000,
  });
  if (currentSnapshot.sourceSnapshotHash !== proposal.source_snapshot_hash) {
    throw new Error("Subject attribution evidence changed after review; rebuild the proposal.");
  }
  let memory;
  let resolvedProposal;
  repository.transaction(() => {
    memory = repository.editMemoryManually({
      agentId: normalizedAgentId,
      memoryId: proposal.memory_id,
      patch: {
        subjectRole: proposal.proposed_subject_role,
        subjectKey: proposal.proposed_subject_key,
      },
      actor: clean(resolvedBy) || "human",
      reason: clean(note) || "Accepted reviewed legacy subject attribution.",
    });
    for (const role of proposal.actorRoles) {
      repository.deleteMemoryRoles({
        agentId: normalizedAgentId,
        memoryId: proposal.memory_id,
        role: role.role,
        actorRole: "unknown",
      });
      repository.upsertMemoryRole({
        memoryId: proposal.memory_id,
        agentId: normalizedAgentId,
        role: role.role,
        actorRole: role.actorRole,
        actorKey: role.actorKey,
        isPrimary: role.isPrimary,
        confidence: role.confidence,
        provenance: "human-reviewed-subject-attribution-v1",
        metadata: { evidenceSourceIds: role.sourceIds },
      });
    }
    resolvedProposal = repository.resolveSubjectAttributionProposalRecord({
      agentId: normalizedAgentId,
      proposalId: normalizedProposalId,
      resolution: "accepted",
      resolvedBy,
      note,
    });
  });
  return { status: "accepted", proposal: resolvedProposal, memory };
}
