export const MEMORY_RECALL_HOOK_MOUNT = Object.freeze({
  id: "memory-recall",
  lifecycleEvent: "DynamicContextCollect",
  order: -80,
  policy: "observe",
  timeoutMs: 10_000,
});

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function identifiers(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(clean)
    .filter(Boolean))].slice(0, 100);
}

/**
 * Turns the existing local memory service's retrieval result into a current
 * Agent Core request-only context block. The service caches one retrieval per Suzu
 * turn; when Agent Core needs a later model step, this Hook can reuse that result
 * without asking the embedding/retrieval providers again.
 */
export function createMemoryRecallContextHook({ memoryRuntime = null } = {}) {
  const collect = async (payload = {}) => {
    if (typeof memoryRuntime?.recallForTurn !== "function") return null;
    const source = plainObject(payload);
    const sessionId = clean(source.sessionId);
    const turnId = clean(source.turnId);
    const projectRoot = clean(source.projectRoot);
    const userText = clean(source.userText);
    if (!sessionId || !turnId || !projectRoot || !userText) return null;

    let recalled;
    try {
      recalled = await memoryRuntime.recallForTurn({
        sessionId,
        turnId,
        projectRoot,
        userText,
      });
    } catch {
      // Memory recall is additive. Its own availability must never block a
      // normal companion turn.
      return null;
    }
    const result = plainObject(recalled);
    const memoryContext = plainObject(result.memoryContext);
    const text = clean(result.contextText);
    if (!text) return null;
    const traceId = clean(memoryContext.traceId);
    const memoryIds = identifiers(memoryContext?.fragments?.flatMap((fragment) => (
      Array.isArray(fragment?.memoryIds) ? fragment.memoryIds : [fragment?.memoryId]
    )));
    return Object.freeze({
      id: `memory-recall:${turnId}:${traceId || "context"}`,
      kind: "memory-recall",
      display: Object.freeze({
        category: "memory",
        context: true,
        label: "记忆召回",
        transcript: false,
      }),
      priority: MEMORY_RECALL_HOOK_MOUNT.order,
      metadata: Object.freeze({
        fragmentCount: Array.isArray(memoryContext.fragments) ? memoryContext.fragments.length : 0,
        memoryIds,
        query: clean(memoryContext.query),
        retrievalStatus: clean(memoryContext.status) || "ready",
        traceId,
      }),
      source: "suzu-memory",
      text,
    });
  };

  return Object.freeze({ collect });
}
