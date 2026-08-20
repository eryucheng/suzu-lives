import {
  createTimeAwarenessContextHook,
  TIME_AWARENESS_HOOK_MOUNT,
} from "./time-awareness-hook.mjs";
import {
  createMemoryRecallContextHook,
  MEMORY_RECALL_HOOK_MOUNT,
} from "./memory-recall-hook.mjs";

export class SuzuAgentHookRegistryError extends Error {
  constructor(message, { cause, code = "SUZU_AGENT_HOOK_REGISTRY_ERROR" } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SuzuAgentHookRegistryError";
    this.code = code;
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function moduleDefinition(value) {
  const source = plainObject(value);
  const id = clean(source.id);
  const lifecycleEvent = clean(source.lifecycleEvent);
  if (!id) {
    throw new SuzuAgentHookRegistryError("Agent Hook 缺少稳定 ID。", { code: "HOOK_ID_REQUIRED" });
  }
  if (!lifecycleEvent) {
    throw new SuzuAgentHookRegistryError(`Agent Hook ${id} 缺少 lifecycleEvent。`, { code: "HOOK_EVENT_REQUIRED" });
  }
  if (typeof source.handler !== "function") {
    throw new SuzuAgentHookRegistryError(`Agent Hook ${id} 缺少 handler()。`, { code: "HOOK_HANDLER_REQUIRED" });
  }
  if (source.dispose !== undefined && typeof source.dispose !== "function") {
    throw new SuzuAgentHookRegistryError(`Agent Hook ${id} 的 dispose 必须是函数。`, { code: "HOOK_DISPOSE_INVALID" });
  }
  return Object.freeze({
    handler: source.handler,
    id,
    lifecycleEvent,
    order: source.order ?? 0,
    policy: source.policy ?? "observe",
    ...(Object.hasOwn(source, "timeoutMs") ? { timeoutMs: source.timeoutMs } : {}),
    ...(typeof source.dispose === "function" ? { dispose: source.dispose } : {}),
  });
}

function publicMount(value) {
  const mount = plainObject(value);
  return Object.freeze({
    id: mount.id,
    lifecycleEvent: mount.lifecycleEvent,
    order: mount.order,
    policy: mount.policy,
    ...(Object.hasOwn(mount, "timeoutMs") ? { timeoutMs: mount.timeoutMs } : {}),
  });
}

function detachAll(detachers) {
  for (const detach of [...detachers].reverse()) {
    try { detach(); } catch { /* Lifecycle teardown continues for every hook. */ }
  }
}

function disposeAll(hooks) {
  for (const hook of [...hooks].reverse()) {
    try { hook.dispose?.(); } catch { /* A detached optional hook cannot block the rest. */ }
  }
}

/**
 * Optional product hooks live here as small modules. Adding or removing a
 * capability is an entry-level change; the Agent Core bridge and chat service never
 * know which optional hooks are currently present.
 */
export function createDefaultSuzuAgentHookModules({
  dataRoot,
  memoryRuntime = null,
  createMemoryRecallHook = createMemoryRecallContextHook,
  createTimeAwarenessHook = createTimeAwarenessContextHook,
} = {}) {
  if (typeof createTimeAwarenessHook !== "function") {
    throw new SuzuAgentHookRegistryError("时间感知 Hook 工厂无效。", { code: "TIME_AWARENESS_FACTORY_INVALID" });
  }
  const timeAwareness = createTimeAwarenessHook({ dataRoot });
  if (typeof timeAwareness?.collect !== "function") {
    throw new SuzuAgentHookRegistryError("时间感知 Hook 缺少 collect()。", { code: "TIME_AWARENESS_HOOK_INVALID" });
  }
  const modules = [
    Object.freeze({
      ...TIME_AWARENESS_HOOK_MOUNT,
      handler: (payload) => timeAwareness.collect(payload),
    }),
  ];
  if (typeof memoryRuntime?.recallForTurn === "function") {
    if (typeof createMemoryRecallHook !== "function") {
      throw new SuzuAgentHookRegistryError("记忆召回 Hook 工厂无效。", { code: "MEMORY_RECALL_FACTORY_INVALID" });
    }
    const memoryRecall = createMemoryRecallHook({ memoryRuntime });
    if (typeof memoryRecall?.collect !== "function") {
      throw new SuzuAgentHookRegistryError("记忆召回 Hook 缺少 collect()。", { code: "MEMORY_RECALL_HOOK_INVALID" });
    }
    modules.push(Object.freeze({
      ...MEMORY_RECALL_HOOK_MOUNT,
      handler: (payload) => memoryRecall.collect(payload),
    }));
  }
  return Object.freeze(modules);
}

/**
 * Mounts independent product Hook modules and exposes an idempotent teardown.
 * Registration is transactional: an invalid later module removes any earlier
 * listeners before the error reaches the composition root.
 */
export function mountSuzuAgentHooks({ agentLifecycle, hookModules = [] } = {}) {
  if (typeof agentLifecycle?.on !== "function") {
    throw new SuzuAgentHookRegistryError("Agent 生命周期缺少 on()。", { code: "LIFECYCLE_REQUIRED" });
  }
  if (!Array.isArray(hookModules)) {
    throw new SuzuAgentHookRegistryError("Agent Hook 模块必须是数组。", { code: "HOOK_MODULES_INVALID" });
  }
  const hooks = [];
  try {
    for (const hookModule of hookModules) hooks.push(moduleDefinition(hookModule));
  } catch (error) {
    disposeAll(hooks);
    throw error;
  }
  const ids = new Set();
  for (const hook of hooks) {
    if (ids.has(hook.id)) {
      disposeAll(hooks);
      throw new SuzuAgentHookRegistryError(`Agent Hook ID 重复：${hook.id}。`, { code: "DUPLICATE_HOOK_ID" });
    }
    ids.add(hook.id);
  }

  const detachers = [];
  try {
    for (const hook of hooks) {
      const detach = agentLifecycle.on(hook.lifecycleEvent, hook.handler, {
        id: hook.id,
        order: hook.order,
        policy: hook.policy,
        ...(Object.hasOwn(hook, "timeoutMs") ? { timeoutMs: hook.timeoutMs } : {}),
      });
      if (typeof detach !== "function") {
        throw new SuzuAgentHookRegistryError(`Agent 生命周期没有返回 ${hook.id} 的卸载函数。`, {
          code: "HOOK_UNSUBSCRIBE_REQUIRED",
        });
      }
      detachers.push(detach);
    }
  } catch (error) {
    detachAll(detachers);
    disposeAll(hooks);
    throw error;
  }

  let active = true;
  return Object.freeze({
    hooks: Object.freeze(hooks.map(publicMount)),
    dispose() {
      if (!active) return false;
      active = false;
      detachAll(detachers);
      disposeAll(hooks);
      return true;
    },
  });
}

export function registerSuzuAgentHooks({
  agentLifecycle,
  dataRoot,
  memoryRuntime = null,
  hookModules = undefined,
  createDefaultHookModules = createDefaultSuzuAgentHookModules,
} = {}) {
  if (hookModules !== undefined) return mountSuzuAgentHooks({ agentLifecycle, hookModules });
  if (typeof createDefaultHookModules !== "function") {
    throw new SuzuAgentHookRegistryError("默认 Agent Hook 模块工厂无效。", { code: "DEFAULT_HOOK_FACTORY_INVALID" });
  }
  return mountSuzuAgentHooks({
    agentLifecycle,
    hookModules: createDefaultHookModules({ dataRoot, memoryRuntime }),
  });
}
