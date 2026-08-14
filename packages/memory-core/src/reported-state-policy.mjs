import { createHash } from "node:crypto";

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

function iso(value, label) {
  const parsed = new Date(clean(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Reported state ${label} is not a valid timestamp.`);
  }
  return parsed.toISOString();
}

const NEW_STATE_ACTIONS = new Set([
  "create", "narrow_scope", "supersede", "pause", "resume",
]);

const SAME_STATE_ACTIONS = new Set(["reinforce", "progress_update"]);

const TERMINAL_ACTIONS = Object.freeze({
  complete: Object.freeze({ statePhase: "completed", temporalState: "completed" }),
  cancel: Object.freeze({ statePhase: "cancelled", temporalState: "cancelled" }),
  end: Object.freeze({ statePhase: "ended", temporalState: "historical" }),
  retire: Object.freeze({ statePhase: "retired", temporalState: "historical" }),
  interrupt: Object.freeze({ statePhase: "interrupted", temporalState: "historical" }),
  stop: Object.freeze({ statePhase: "ended", temporalState: "historical" }),
  revoke: Object.freeze({ statePhase: "ended", temporalState: "historical" }),
});

function memoryLayer(stateFamily) {
  if (stateFamily === "goal") return "prospective";
  if (stateFamily === "relationship") return "relational";
  return "semantic";
}

function currentState(repository, proposal) {
  const current = repository.getCurrentCanonicalMemory({
    agentId: proposal.agent_id,
    subjectRole: proposal.subject_role,
    subjectKey: proposal.subject_key,
    canonicalKey: proposal.canonical_key,
    representationLayer: "reported",
    stateFamily: proposal.state_family,
    stateScopeKey: proposal.target_scope_key,
  });
  if ((current?.id || "") !== proposal.previousMemoryId) {
    throw new Error("Reported state changed after the proposal was reviewed.");
  }
  return current;
}

function reviewedEvidence(repository, proposal) {
  const evidenceSnapshot = proposal.metadata?.reportedStateEvidenceSnapshot;
  if (evidenceSnapshot?.version !== "reported-state-evidence-snapshot-v1"
    || !clean(evidenceSnapshot.selectedContent)
    || !Array.isArray(evidenceSnapshot.observations)) {
    throw new Error("Reported state proposal does not contain an immutable evidence snapshot.");
  }
  const snapshotByObservationId = new Map(
    evidenceSnapshot.observations.map((item) => [clean(item.observationId), item]),
  );
  let selected = null;
  for (const observationId of proposal.consideredObservationIds) {
    const observation = repository.getStateEvidenceObservation(proposal.agent_id, observationId);
    if (!observation || observation.lifecycle !== "current"
      || observation.state_family !== proposal.state_family
      || observation.subject_role !== proposal.subject_role
      || observation.subject_key !== proposal.subject_key
      || observation.canonical_key !== proposal.canonical_key
      || clean(observation.scope?.currentRepresentationLayer) !== "reported") {
      throw new Error("Reported state proposal evidence changed or crossed its reviewed target.");
    }
    const memoryId = clean(observation.memory_id || observation.memoryId);
    const detail = repository.getMemoryDetail(proposal.agent_id, memoryId);
    if (!detail || detail.memory.status === "deleted") {
      throw new Error("Reported state proposal evidence memory is no longer available.");
    }
    const linkedSourceIds = new Set(detail.sources.map((source) => source.id));
    if (!observation.sourceIds.length
      || observation.sourceIds.some((sourceId) => !linkedSourceIds.has(sourceId))) {
      throw new Error("Reported state proposal evidence sources changed after review.");
    }
    const recordedSnapshot = snapshotByObservationId.get(observation.id);
    if (!recordedSnapshot
      || clean(recordedSnapshot.observationHash) !== clean(observation.observation_hash)
      || clean(recordedSnapshot.memoryId) !== memoryId
      || clean(recordedSnapshot.memoryFingerprint) !== canonicalHash({
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
      })) {
      throw new Error("Reported state proposal evidence memory changed after review.");
    }
    const recordedSourceFingerprints = new Map(
      (recordedSnapshot.sourceFingerprints || []).map((item) => [clean(item.id), clean(item.fingerprint)]),
    );
    for (const sourceId of [...observation.sourceIds].sort()) {
      const source = detail.sources.find((item) => item.id === sourceId);
      const fingerprint = canonicalHash({
        id: source.id,
        agentId: source.agent_id,
        sourceKind: source.source_kind,
        externalId: source.external_id,
        occurredAt: source.occurred_at,
        knownAt: source.known_at,
        speaker: source.speaker,
        content: source.content,
      });
      if (recordedSourceFingerprints.get(sourceId) !== fingerprint) {
        throw new Error("Reported state proposal evidence source changed after review.");
      }
    }
    if (observation.id === proposal.selectedObservationId) {
      if (observation.qualification !== "qualified") {
        throw new Error("Reported state proposal selected evidence is no longer qualified.");
      }
      selected = { observation, detail, contentSnapshot: evidenceSnapshot.selectedContent };
    }
  }
  if (!selected) throw new Error("Reported state proposal lost its selected evidence.");
  const draft = proposal.draft || {};
  if (NEW_STATE_ACTIONS.has(proposal.action) || proposal.action === "reinforce") {
    const selectedMemoryId = clean(selected.observation.memory_id || selected.observation.memoryId);
    if (!Array.isArray(draft.evidenceObservationIds)
      || !draft.evidenceObservationIds.includes(selected.observation.id)
      || !Array.isArray(draft.evidenceMemoryIds)
      || !draft.evidenceMemoryIds.includes(selectedMemoryId)
      || !Array.isArray(draft.evidenceSourceIds)
      || selected.observation.sourceIds.some((sourceId) => !draft.evidenceSourceIds.includes(sourceId))) {
      throw new Error("Reported state draft does not preserve its selected evidence chain.");
    }
  }
  return selected;
}

function actorRoles(proposal) {
  const roles = [{
    role: "subject",
    actorRole: proposal.subject_role,
    actorKey: proposal.subject_key,
    isPrimary: true,
    confidence: 1,
    provenance: "accepted-reported-state-proposal-v1",
    metadata: { reportedStateProposalId: proposal.id },
  }];
  if (proposal.proposed_kind === "belief_state") {
    roles.push({
      ...roles[0],
      role: "belief_holder",
    });
  } else if (proposal.proposed_kind === "preference") {
    roles.push({
      ...roles[0],
      role: "preference_holder",
    });
  }
  const counterpart = proposal.draft?.counterpart;
  if (proposal.state_family === "relationship"
    && clean(counterpart?.role) && clean(counterpart?.key)) {
    roles.push({
      role: "participant",
      actorRole: clean(counterpart.role),
      actorKey: clean(counterpart.key),
      isPrimary: false,
      confidence: 1,
      provenance: "accepted-reported-state-proposal-v1",
      metadata: {
        reportedStateProposalId: proposal.id,
        label: clean(counterpart.label),
      },
    });
  }
  return roles;
}

function materializeState(repository, proposal, evidence) {
  const validityStart = iso(proposal.draft.validFrom, "validity start");
  const memoryId = `reported-state-${createHash("sha256")
    .update(`${proposal.agent_id}\u001f${proposal.id}`)
    .digest("hex")
    .slice(0, 24)}`;
  const stateLabel = clean(proposal.metadata?.target?.stateLabel);
  return repository.upsertMemory({
    id: memoryId,
    agentId: proposal.agent_id,
    kind: proposal.proposed_kind,
    layer: memoryLayer(proposal.state_family),
    title: stateLabel,
    content: evidence.contentSnapshot,
    subjectRole: proposal.subject_role,
    subjectKey: proposal.subject_key,
    canonicalKey: proposal.canonical_key,
    reality: "real",
    evidenceMode: "explicit",
    representationLayer: "reported",
    stateFamily: proposal.state_family,
    stateScopeKey: proposal.proposed_scope_key,
    statePhase: proposal.state_phase,
    temporalState: proposal.temporal_state,
    revisionAction: ["create", "add_scoped_exception"].includes(proposal.action)
      ? "add"
      : "update",
    knownAt: evidence.detail.memory.known_at || evidence.observation.observed_at,
    validFrom: validityStart,
    status: "active",
    confidence: bounded(evidence.observation.confidence, 0.75),
    importance: 0.6,
    actorRoles: actorRoles(proposal),
    metadata: {
      reportedStateProposalId: proposal.id,
      reportedStateAction: proposal.action,
      reportedStateReviewVersion: proposal.review_version,
      reportedStateInputHash: proposal.input_hash,
      reportedStateDraft: proposal.draft,
      truthBoundary: proposal.metadata?.truthBoundary || {},
    },
  });
}

function attachSelectedEvidence(repository, proposal, targetMemory, evidence, {
  challenged = false,
} = {}) {
  const sourceById = new Map(evidence.detail.sources.map((source) => [source.id, source]));
  for (const sourceId of evidence.observation.sourceIds) {
    const source = sourceById.get(sourceId);
    repository.linkSource(targetMemory.id, sourceId, `reported_state_${proposal.action}`, {
      authority: clean(source?.authority) || "subject_firsthand",
      sourceTrust: bounded(source?.source_trust, 0.8),
      evidenceStrength: bounded(evidence.observation.confidence, 0.75),
      provenance: "accepted-reported-state-proposal-v1",
      metadata: {
        reportedStateProposalId: proposal.id,
        stateFamily: proposal.state_family,
        action: proposal.action,
        observationId: evidence.observation.id,
      },
    });
  }
  if (targetMemory.id !== evidence.detail.memory.id) {
    repository.upsertEdge({
      agentId: proposal.agent_id,
      fromMemoryId: targetMemory.id,
      toMemoryId: evidence.detail.memory.id,
      relation: challenged ? "challenged_by" : "supported_by",
      direction: "directed",
      weight: challenged ? 0.8 : 0.9,
      confidence: bounded(evidence.observation.confidence, 0.75),
      provenance: "accepted-reported-state-proposal-v1",
      metadata: {
        reportedStateProposalId: proposal.id,
        stateFamily: proposal.state_family,
        action: proposal.action,
        observationId: evidence.observation.id,
      },
    });
  }
}

function finish(repository, proposal, memory, resolvedBy, note, status, previous = null) {
  return {
    status,
    proposal: repository.resolveReportedStateProposalRecord({
      agentId: proposal.agent_id,
      proposalId: proposal.id,
      resolution: "accepted",
      resultMemoryId: memory.id,
      resolvedBy,
      note,
    }),
    memory: repository.getMemory(memory.id),
    previous: previous ? repository.getMemory(previous.id) : null,
  };
}

function rejectUnsafeRootTransition(repository, proposal, current) {
  if (!current || current.state_scope_key !== "root") return;
  const changesRootLifecycle = NEW_STATE_ACTIONS.has(proposal.action)
    || Boolean(TERMINAL_ACTIONS[proposal.action])
    || proposal.action === "correct_attribution";
  if (!changesRootLifecycle) return;
  const exceptions = repository.listCurrentScopedExceptions({
    agentId: proposal.agent_id,
    rootMemoryId: current.id,
  });
  if (exceptions.length) {
    throw new Error(
      "Reported root state has active scoped exceptions and requires explicit scope reconciliation before transition.",
    );
  }
}

export function resolveReportedStateProposal(repository, {
  agentId,
  proposalId,
  action,
  resolvedBy = "human",
  note = "",
} = {}) {
  if (!repository) throw new Error("Resolving a reported state proposal requires a repository.");
  const normalizedAgentId = clean(agentId);
  const normalizedAction = clean(action);
  const proposal = repository.getReportedStateProposal(normalizedAgentId, proposalId);
  if (!proposal) throw new Error("Reported state proposal does not exist for this Agent.");
  if (proposal.review_state !== "pending") {
    throw new Error(`Reported state proposal is already ${proposal.review_state}.`);
  }
  if (!["accept", "dismiss"].includes(normalizedAction)) {
    throw new Error(`Unknown reported state proposal action: ${normalizedAction || "(empty)"}.`);
  }
  if (normalizedAction === "dismiss") {
    return repository.transaction(() => ({
      status: "dismissed",
      proposal: repository.dismissReportedStateProposal({
        agentId: normalizedAgentId,
        proposalId: proposal.id,
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
    const current = currentState(repository, proposal);
    const evidence = reviewedEvidence(repository, proposal);

    if (proposal.action === "create") {
      const memory = materializeState(repository, proposal, evidence);
      attachSelectedEvidence(repository, proposal, memory, evidence);
      return finish(repository, proposal, memory, resolvedBy, note, "created");
    }

    if (!current) throw new Error("Reported state transition lost its reviewed current state.");

    if (proposal.action === "add_scoped_exception") {
      const existingException = repository.getCurrentCanonicalMemory({
        agentId: normalizedAgentId,
        subjectRole: proposal.subject_role,
        subjectKey: proposal.subject_key,
        canonicalKey: proposal.canonical_key,
        representationLayer: "reported",
        stateFamily: proposal.state_family,
        stateScopeKey: proposal.proposed_scope_key,
      });
      if (existingException) {
        throw new Error("This reported-state scope already has a current exception; rebuild against that scope.");
      }
      const memory = materializeState(repository, proposal, evidence);
      attachSelectedEvidence(repository, proposal, memory, evidence);
      repository.upsertEdge({
        agentId: normalizedAgentId,
        fromMemoryId: memory.id,
        toMemoryId: current.id,
        relation: "scoped_exception_to",
        direction: "directed",
        weight: 1,
        confidence: bounded(evidence.observation.confidence, 0.75),
        provenance: "accepted-reported-state-proposal-v1",
        metadata: {
          reportedStateProposalId: proposal.id,
          stateFamily: proposal.state_family,
          targetScopeKey: proposal.target_scope_key,
          proposedScopeKey: proposal.proposed_scope_key,
        },
      });
      return finish(
        repository,
        proposal,
        memory,
        resolvedBy,
        note,
        "scoped-exception-added",
        current,
      );
    }

    rejectUnsafeRootTransition(repository, proposal, current);

    if (SAME_STATE_ACTIONS.has(proposal.action)) {
      attachSelectedEvidence(repository, proposal, current, evidence);
      return finish(
        repository,
        proposal,
        current,
        resolvedBy,
        note,
        proposal.action === "reinforce" ? "reinforced" : "progress-recorded",
        current,
      );
    }

    if (NEW_STATE_ACTIONS.has(proposal.action)) {
      const memory = materializeState(repository, proposal, evidence);
      attachSelectedEvidence(repository, proposal, memory, evidence);
      repository.closeCurrentMemoryState({
        agentId: normalizedAgentId,
        memoryId: current.id,
        validTo: proposal.draft.validFrom,
      });
      repository.upsertEdge({
        agentId: normalizedAgentId,
        fromMemoryId: memory.id,
        toMemoryId: current.id,
        relation: "supersedes",
        direction: "directed",
        weight: 1,
        confidence: bounded(evidence.observation.confidence, 0.75),
        provenance: "accepted-reported-state-proposal-v1",
        metadata: {
          reportedStateProposalId: proposal.id,
          transition: proposal.action,
        },
      });
      return finish(repository, proposal, memory, resolvedBy, note, proposal.action, current);
    }

    const terminal = TERMINAL_ACTIONS[proposal.action];
    if (terminal) {
      attachSelectedEvidence(repository, proposal, current, evidence);
      const closed = repository.closeReportedMemoryState({
        agentId: normalizedAgentId,
        memoryId: current.id,
        stateFamily: proposal.state_family,
        statePhase: terminal.statePhase,
        temporalState: terminal.temporalState,
        status: "superseded",
        validTo: evidence.observation.observed_at,
      });
      return finish(repository, proposal, closed, resolvedBy, note, proposal.action, current);
    }

    if (proposal.action === "correct_attribution") {
      attachSelectedEvidence(repository, proposal, current, evidence, { challenged: true });
      const corrected = repository.closeReportedMemoryState({
        agentId: normalizedAgentId,
        memoryId: current.id,
        stateFamily: proposal.state_family,
        statePhase: "retired",
        temporalState: "historical",
        status: "disputed",
        validTo: evidence.observation.observed_at,
      });
      return finish(repository, proposal, corrected, resolvedBy, note, "attribution-corrected", current);
    }

    throw new Error(`Reported state proposal action is not accepted yet: ${proposal.action}.`);
  });
}
