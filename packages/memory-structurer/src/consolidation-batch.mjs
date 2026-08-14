import { runMemoryConsolidation } from "./consolidation-service.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function boundedMaximum(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("Memory consolidation batch maximumRuns must be an integer from 1 to 100.");
  }
  return parsed;
}

/**
 * Processes only already-planned runs, oldest first. This function is a
 * bounded single-worker operation; it does not schedule itself or accept any
 * generated proposal.
 */
export async function processPlannedConsolidationRuns({
  repository,
  agentId,
  generator,
  maximumRuns,
  usageLedgerPath = "",
} = {}) {
  if (!repository) throw new Error("Memory consolidation batch requires a repository.");
  const normalizedAgentId = clean(agentId);
  if (!normalizedAgentId) throw new Error("Memory consolidation batch requires agentId.");
  if (typeof generator !== "function") {
    throw new Error("Memory consolidation batch requires a generator function.");
  }
  const limit = boundedMaximum(maximumRuns);
  const selected = repository.listConsolidationRuns(normalizedAgentId, {
    statuses: ["planned"],
    limit,
    order: "asc",
  });
  const results = [];
  for (const run of selected) {
    try {
      const result = await runMemoryConsolidation({
        repository,
        agentId: normalizedAgentId,
        runId: run.id,
        structureGenerator: generator,
        relationGenerator: generator,
        structureOptions: { usageLedgerPath: clean(usageLedgerPath) },
        relationOptions: { usageLedgerPath: clean(usageLedgerPath) },
      });
      results.push({
        runId: run.id,
        status: result.status,
        structureProposalCount: result.run.structureProposalIds.length,
        relationProposalCount: result.run.relationProposalIds.length,
        error: clean(result.error),
      });
    } catch (error) {
      results.push({
        runId: run.id,
        status: "failed-to-run",
        structureProposalCount: 0,
        relationProposalCount: 0,
        error: clean(error?.message || error),
      });
    }
  }
  const counts = results.reduce((summary, result) => {
    summary[result.status] = (summary[result.status] || 0) + 1;
    return summary;
  }, {});
  return {
    status: results.some((result) => ["failed", "failed-to-run"].includes(result.status))
      ? "completed-with-failures"
      : "completed",
    selected: selected.length,
    counts,
    results,
  };
}
