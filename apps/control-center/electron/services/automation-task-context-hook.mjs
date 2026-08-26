/**
 * Product-owned context for an internal, scheduled Agent turn.  The task body
 * is deliberately not sent as a user message: the lifecycle bridge places
 * this block into the current model request and removes it afterwards.
 */
export const AUTOMATION_TASK_CONTEXT_HOOK_MOUNT = Object.freeze({
  id: "automation-task-context",
  lifecycleEvent: "DynamicContextCollect",
  order: -110,
  policy: "observe",
  timeoutMs: 3_000,
});

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Supplies an internal task only when the product explicitly opened such a
 * turn. Normal human messages never carry taskContext, so this Hook is inert
 * for ordinary conversation.
 */
export function createAutomationTaskContextHook() {
  const collect = (payload = {}) => {
    const source = plainObject(payload);
    const task = plainObject(source.taskContext);
    const text = clean(task.text);
    const turnId = clean(source.turnId);
    if (!text || !turnId) return null;
    const taskId = clean(task.id);
    const outputPolicy = clean(source.outputPolicy) || "external";
    const turnKind = clean(source.kind);
    return Object.freeze({
      id: `automation-task:${turnId}`,
      kind: "automation-task",
      source: "suzu-runtime",
      display: Object.freeze({
        category: "automation",
        context: true,
        label: "自动任务",
        transcript: false,
      }),
      priority: AUTOMATION_TASK_CONTEXT_HOOK_MOUNT.order,
      metadata: Object.freeze({
        ...(taskId ? { taskId } : {}),
        ...(clean(source.scheduleSource) ? { scheduleSource: clean(source.scheduleSource) } : {}),
        ...(turnKind ? { turnKind } : {}),
        outputPolicy,
      }),
      text,
    });
  };
  return Object.freeze({ collect });
}
