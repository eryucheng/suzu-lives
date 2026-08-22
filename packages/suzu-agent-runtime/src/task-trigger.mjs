export const SUZU_AGENT_TASK_TRIGGER_PLUGIN = "suzu-lifecycle-bridge";
export const SUZU_AGENT_TASK_TRIGGER_FORM = "task-trigger";
export const SUZU_AGENT_TASK_OUTPUT_POLICIES = Object.freeze(["external", "silent"]);

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function normalizeSuzuAgentTaskOutputPolicy(value, fallback = "external") {
  const candidate = clean(value);
  if (SUZU_AGENT_TASK_OUTPUT_POLICIES.includes(candidate)) return candidate;
  return SUZU_AGENT_TASK_OUTPUT_POLICIES.includes(fallback) ? fallback : "external";
}

/**
 * The Core needs one inbox item to wake an idle Agent.  This marker carries no
 * task body: the product supplies that body through DynamicContextCollect for
 * this one request, then the lifecycle bridge removes the marker before it can
 * become conversation history.
 */
export function isSuzuAgentTaskTrigger(message) {
  const source = plainObject(message?.source);
  return source.kind === "plugin"
    && source.plugin === SUZU_AGENT_TASK_TRIGGER_PLUGIN
    && source.form === SUZU_AGENT_TASK_TRIGGER_FORM;
}
