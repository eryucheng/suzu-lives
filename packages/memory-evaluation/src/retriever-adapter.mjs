import {
  openMemoryDatabase,
} from "@suzu-lives/memory-core";
import {
  retrieveMemories,
} from "@suzu-lives/memory-retriever";

function clean(value) {
  return String(value ?? "").trim();
}

function uniqueIds(result) {
  return [...new Set([
    result?.graph?.seedId,
    ...(result?.graph?.selectedMemoryIds || []),
    ...(result?.graph?.evidenceMemoryIds || []),
    ...(result?.candidates || []).map((candidate) => candidate.memoryId),
    ...(result?.fragments || []).flatMap((fragment) => (
      fragment.memoryIds || [fragment.memoryId]
    )),
  ].map(clean).filter(Boolean))];
}

function observeMemories(databasePath, agentId, ids) {
  if (!ids.length) return [];
  const database = openMemoryDatabase(databasePath, { readOnly: true });
  try {
    const placeholders = ids.map(() => "?").join(", ");
    return database.prepare(`
      SELECT
        id,
        kind,
        layer,
        subject_role,
        subject_key,
        reality,
        evidence_mode,
        temporal_state,
        status,
        event_date,
        event_start,
        event_end,
        valid_from,
        valid_to
      FROM memory_nodes
      WHERE agent_id = ? AND id IN (${placeholders})
    `).all(agentId, ...ids).map((row) => ({
      id: row.id,
      kind: row.kind,
      layer: row.layer,
      subjectRole: row.subject_role,
      subjectKey: row.subject_key,
      reality: row.reality,
      evidenceMode: row.evidence_mode,
      temporalState: row.temporal_state,
      status: row.status,
      eventDate: row.event_date,
      eventStart: row.event_start,
      eventEnd: row.event_end,
      validFrom: row.valid_from,
      validTo: row.valid_to,
    }));
  } finally {
    database.close();
  }
}

export function createCurrentRetrieverExecutor({
  databasePath,
  agentId,
  embeddingProvider = null,
  usageLedgerPath = "",
  options = {},
  defaultNow = null,
} = {}) {
  const normalizedDatabasePath = clean(databasePath);
  const normalizedAgentId = clean(agentId);
  if (!normalizedDatabasePath) throw new Error("createCurrentRetrieverExecutor 需要 databasePath。");
  if (!normalizedAgentId) throw new Error("createCurrentRetrieverExecutor 需要 agentId。");
  return async (testCase) => {
    const executionNow = testCase.now || defaultNow || new Date();
    const result = await retrieveMemories({
      databasePath: normalizedDatabasePath,
      agentId: normalizedAgentId,
      query: testCase.query,
      anchorMemoryIds: testCase.anchorMemoryIds || [],
      now: executionNow,
      embeddingProvider,
      usageLedgerPath,
      options,
    });
    return {
      ...result,
      observedMemories: observeMemories(
        normalizedDatabasePath,
        normalizedAgentId,
        uniqueIds(result),
      ),
    };
  };
}
