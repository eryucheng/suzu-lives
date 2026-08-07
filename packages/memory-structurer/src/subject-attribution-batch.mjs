import { proposeSubjectAttributionForMemory } from "./subject-attribution-service.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function explicitLimit(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 100) {
    throw new Error("Subject attribution batch requires maximumMemories from 1 to 100.");
  }
  return number;
}

export async function proposeSubjectAttributionsBatch({
  repository,
  agentId,
  memoryIds = [],
  maximumMemories,
  allowedActors,
  generator,
  usageLedgerPath = "",
  systemPromptPath,
  snapshotOptions = {},
} = {}) {
  if (!repository) throw new Error("Subject attribution batch requires a repository.");
  if (typeof generator !== "function") {
    throw new Error("Subject attribution batch requires a generator function.");
  }
  const limit = explicitLimit(maximumMemories);
  const selectedIds = [...new Set(
    (Array.isArray(memoryIds) ? memoryIds : []).map(clean).filter(Boolean),
  )].slice(0, limit);
  const results = [];
  for (const memoryId of selectedIds) {
    try {
      const result = await proposeSubjectAttributionForMemory({
        repository,
        agentId,
        memoryId,
        allowedActors,
        generator,
        usageLedgerPath,
        systemPromptPath,
        snapshotOptions,
      });
      results.push({ memoryId, status: result.status, proposalId: result.proposal?.id || "" });
    } catch (error) {
      results.push({ memoryId, status: "failed", error: error.message });
    }
  }
  const counts = results.reduce((summary, result) => ({
    ...summary,
    [result.status]: Number(summary[result.status] || 0) + 1,
  }), {});
  return {
    status: results.some((result) => result.status === "failed")
      ? "completed-with-failures"
      : "completed",
    requested: Array.isArray(memoryIds) ? memoryIds.length : 0,
    selected: selectedIds.length,
    truncated: Math.max(0, (Array.isArray(memoryIds) ? memoryIds.length : 0) - selectedIds.length),
    counts,
    results,
  };
}
