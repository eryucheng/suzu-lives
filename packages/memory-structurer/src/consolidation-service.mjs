import { proposeRelationsForBatch } from "./relation-service.mjs";
import { proposeStructuresForBatch } from "./service.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function proposalIds(result) {
  return [...new Set([
    ...(result?.proposed || []).map((proposal) => proposal.id),
    ...(result?.duplicates || []).map((proposal) => proposal.id),
  ].filter(Boolean))];
}

export async function runMemoryConsolidation({
  repository,
  agentId,
  runId,
  structureGenerator = null,
  relationGenerator = null,
  structureOptions = {},
  relationOptions = {},
} = {}) {
  if (!repository) throw new Error("Memory consolidation requires a repository.");
  const normalizedAgentId = clean(agentId);
  const normalizedRunId = clean(runId);
  if (!normalizedAgentId || !normalizedRunId) {
    throw new Error("Memory consolidation requires agentId and runId.");
  }
  let run = repository.getConsolidationRun(normalizedAgentId, normalizedRunId);
  if (!run) throw new Error("Consolidation run does not exist for this Agent.");
  if (["completed", "no_proposals", "failed", "cancelled"].includes(run.status)) {
    return { status: "already-finished", run, structure: null, relations: null };
  }
  if (run.status !== "planned") {
    throw new Error(`Consolidation run is already ${run.status}.`);
  }
  run = repository.claimConsolidationRun({
    agentId: normalizedAgentId,
    runId: normalizedRunId,
  });
  if (!run.candidateIds.length) {
    return {
      status: "no-proposals",
      run: repository.finishConsolidationRun({
        agentId: normalizedAgentId,
        runId: run.id,
        status: "no_proposals",
      }),
      structure: null,
      relations: null,
    };
  }
  if (typeof structureGenerator !== "function" && typeof relationGenerator !== "function") {
    const failed = repository.finishConsolidationRun({
      agentId: normalizedAgentId,
      runId: run.id,
      status: "failed",
      errorMessage: "No consolidation generator was configured.",
    });
    return { status: "failed", run: failed, structure: null, relations: null };
  }

  const memoryIds = [...run.triggerIds, ...run.candidateIds];
  const retrospective = {
    triggerMemoryIds: run.triggerIds,
    historicalMemoryIds: run.candidateIds,
  };
  const retrospectivePolicy = {
    requiredTriggerMemoryIds: run.triggerIds,
    requiredHistoricalMemoryIds: run.candidateIds,
    requireRetrospectiveParticipation: true,
  };
  let structure = null;
  let relations = null;
  let structureIds = [];
  let relationIds = [];
  try {
    if (typeof structureGenerator === "function") {
      structure = await proposeStructuresForBatch({
        ...structureOptions,
        repository,
        agentId: normalizedAgentId,
        batchId: `${run.id}:structure`,
        memoryIds,
        generator: structureGenerator,
        snapshotOptions: {
          ...(structureOptions.snapshotOptions || {}),
          retrospective,
        },
        candidatePolicy: {
          ...(structureOptions.candidatePolicy || {}),
          ...retrospectivePolicy,
        },
      });
      structureIds = proposalIds(structure);
    }
    if (typeof relationGenerator === "function") {
      relations = await proposeRelationsForBatch({
        ...relationOptions,
        repository,
        agentId: normalizedAgentId,
        batchId: `${run.id}:relations`,
        memoryIds,
        generator: relationGenerator,
        snapshotOptions: {
          ...(relationOptions.snapshotOptions || {}),
          retrospective,
        },
        candidatePolicy: {
          ...(relationOptions.candidatePolicy || {}),
          ...retrospectivePolicy,
        },
      });
      relationIds = proposalIds(relations);
    }
    const hasProposals = structureIds.length > 0 || relationIds.length > 0;
    const finished = repository.finishConsolidationRun({
      agentId: normalizedAgentId,
      runId: run.id,
      status: hasProposals ? "completed" : "no_proposals",
      structureProposalIds: structureIds,
      relationProposalIds: relationIds,
    });
    return {
      status: hasProposals ? "completed" : "no-proposals",
      run: finished,
      structure,
      relations,
    };
  } catch (error) {
    const failed = repository.finishConsolidationRun({
      agentId: normalizedAgentId,
      runId: run.id,
      status: "failed",
      structureProposalIds: structureIds,
      relationProposalIds: relationIds,
      errorMessage: error.message,
    });
    return {
      status: "failed",
      error: error.message,
      run: failed,
      structure,
      relations,
    };
  }
}
