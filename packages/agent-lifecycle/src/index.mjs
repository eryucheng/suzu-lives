/**
 * The stable lifecycle contract for Suzu agents.
 *
 * These are the only Hook names product extensions use. There is no second
 * provider-facing vocabulary to translate: the Agent Core adapter emits the same
 * names at the matching runtime boundary.
 */

export const SUZU_AGENT_LIFECYCLE_EVENTS = Object.freeze([
  "SessionStart",
  "SessionEnd",
  "ContactActivated",
  "ProfileChanged",
  "InstructionsChanged",
  "UserPromptSubmit",
  "TurnQueued",
  "TurnStarting",
  "TurnStarted",
  "ContextCollect",
  "ContextInjected",
  "ContextInjectionFailed",
  "DynamicContextCollect",
  "DynamicContextInjected",
  "DynamicContextInjectionFailed",
  "DynamicContextExpired",
  "DynamicContextCleanupFailed",
  "AssistantDelta",
  "PreToolUse",
  "ToolStarted",
  "PermissionRequest",
  "PermissionResolved",
  "PostToolUse",
  "PostToolUseFailure",
  "PreCompact",
  "PostCompact",
  "CompactFailed",
  "StopRequested",
  "Stop",
  "SubagentStart",
  "SubagentStop",
]);

const EVENT_NAMES = new Set(SUZU_AGENT_LIFECYCLE_EVENTS);
const DECISION_EVENTS = new Set(["PreToolUse"]);
const DEFAULT_TIMEOUT_MS = 3_000;

export class SuzuAgentLifecycleError extends Error {
  constructor(message, { cause, code = "SUZU_AGENT_LIFECYCLE_ERROR", details = {} } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SuzuAgentLifecycleError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function errorMessage(error) {
  return clean(error?.message || error) || "未知错误。";
}

function eventName(value) {
  const name = clean(value);
  if (!EVENT_NAMES.has(name)) {
    throw new SuzuAgentLifecycleError(`未知的生命周期事件：${name || "(空)"}。`, {
      code: "UNKNOWN_EVENT",
      details: { event: name },
    });
  }
  return name;
}

function listenerId(value, fallback) {
  const id = clean(value) || fallback;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(id)) {
    throw new SuzuAgentLifecycleError("生命周期 Hook 标识只能包含字母、数字、点、下划线、冒号和连字符。", {
      code: "INVALID_HOOK_ID",
      details: { id },
    });
  }
  return id;
}

function finiteOrder(value) {
  return Number.isFinite(value) ? Number(value) : 0;
}

function timeoutMilliseconds(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > 60_000) {
    throw new SuzuAgentLifecycleError("生命周期 Hook 超时时间必须是 0 到 60000 的整数毫秒。", {
      code: "INVALID_TIMEOUT",
      details: { timeoutMs: value },
    });
  }
  return value;
}

function failurePolicy(value) {
  const policy = clean(value) || "observe";
  if (policy !== "observe" && policy !== "critical") {
    throw new SuzuAgentLifecycleError("生命周期 Hook 失败策略只能是 observe 或 critical。", {
      code: "INVALID_FAILURE_POLICY",
      details: { policy },
    });
  }
  return policy;
}

function immutablePayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.freeze({ ...value });
}

function runWithTimeout(callback, payload, timeoutMs, id) {
  const operation = Promise.resolve().then(() => callback(payload));
  if (!timeoutMs) return operation;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new SuzuAgentLifecycleError(`生命周期 Hook ${id} 在 ${timeoutMs}ms 内没有完成。`, {
        code: "HOOK_TIMEOUT",
        details: { hookId: id, timeoutMs },
      }));
    }, timeoutMs);
    timer?.unref?.();
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function contextDisplay(value, kind) {
  const source = value === false
    ? { context: false, transcript: false }
    : value === true
      ? { context: true, transcript: true }
      : plainObject(value);
  const category = clean(source.category) || kind;
  const label = clean(source.label);
  return Object.freeze({
    context: source.context !== false,
    transcript: source.transcript === true,
    ...(category ? { category } : {}),
    ...(label ? { label } : {}),
  });
}

function contextBlock(value, { hookId, index }) {
  const source = typeof value === "string" ? { text: value } : plainObject(value);
  const text = String(source.text ?? "");
  if (!text.trim()) return null;
  const id = clean(source.id) || `${hookId}:${index + 1}`;
  const kind = clean(source.kind) || "context";
  const priority = Number.isFinite(source.priority) ? Number(source.priority) : 0;
  return Object.freeze({
    id,
    kind,
    display: contextDisplay(source.display, kind),
    metadata: Object.freeze({ ...plainObject(source.metadata) }),
    priority,
    source: hookId,
    text,
  });
}

function contextBlocks(result, hookId) {
  if (result === undefined || result === null) return [];
  const candidates = Array.isArray(result)
    ? result
    : Array.isArray(result?.blocks)
      ? result.blocks
      : [result];
  return candidates
    .map((item, index) => contextBlock(item, { hookId, index }))
    .filter(Boolean);
}

function toolDecision(value) {
  const source = plainObject(value);
  const kind = clean(source.kind);
  if (kind === "allow") return Object.freeze({ kind });
  if (kind === "deny") {
    const reason = clean(source.reason);
    return reason ? Object.freeze({ kind, reason }) : null;
  }
  if (kind === "ask") {
    const reason = clean(source.reason);
    return Object.freeze(reason ? { kind, reason } : { kind });
  }
  return null;
}

/**
 * Creates a deterministic hook bus with a single product-level vocabulary.
 *
 * `critical` hooks stop their dispatch on failure; `observe` hooks are
 * reported and isolated. `PreToolUse` additionally supports a monotonic
 * decision return value: `deny` wins, then `ask`, otherwise the default is
 * `allow`. No hook can use a later `allow` to undo a prior denial.
 */
export function createSuzuAgentLifecycle({
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  onError = () => {},
} = {}) {
  const timeout = timeoutMilliseconds(defaultTimeoutMs, DEFAULT_TIMEOUT_MS);
  if (typeof onError !== "function") {
    throw new SuzuAgentLifecycleError("生命周期错误处理器必须是函数。", { code: "INVALID_ERROR_HANDLER" });
  }

  const listeners = new Map(SUZU_AGENT_LIFECYCLE_EVENTS.map((name) => [name, []]));
  let closed = false;
  let sequence = 0;

  const orderedListeners = (event) => [...listeners.get(event)]
    .sort((left, right) => left.order - right.order || left.sequence - right.sequence);

  const reportFailure = (failure) => {
    try { onError(failure); } catch { /* Monitoring must not interrupt the lifecycle. */ }
  };

  const dispatch = async (event, payload = {}) => {
    const name = eventName(event);
    const immutable = immutablePayload(payload);
    const results = [];
    const failures = [];
    for (const listener of orderedListeners(name)) {
      try {
        const value = await runWithTimeout(listener.callback, immutable, listener.timeoutMs, listener.id);
        results.push(Object.freeze({ hookId: listener.id, value }));
      } catch (cause) {
        const failure = Object.freeze({
          event: name,
          hookId: listener.id,
          message: errorMessage(cause),
          policy: listener.policy,
        });
        failures.push(failure);
        reportFailure(failure);
        if (listener.policy === "critical") {
          throw new SuzuAgentLifecycleError(`关键生命周期 Hook ${listener.id} 执行失败：${failure.message}`, {
            cause,
            code: "CRITICAL_HOOK_FAILED",
            details: failure,
          });
        }
      }
    }
    return Object.freeze({
      event: name,
      failures: Object.freeze(failures),
      results: Object.freeze(results),
    });
  };

  const on = (event, callback, {
    id = "",
    order = 0,
    policy = "observe",
    timeoutMs = undefined,
  } = {}) => {
    if (closed) throw new SuzuAgentLifecycleError("生命周期已关闭，不能注册新的 Hook。", { code: "LIFECYCLE_CLOSED" });
    const name = eventName(event);
    if (typeof callback !== "function") {
      throw new SuzuAgentLifecycleError("生命周期 Hook 必须是函数。", { code: "INVALID_HOOK" });
    }
    const entries = listeners.get(name);
    const record = Object.freeze({
      callback,
      id: listenerId(id, `${name}:${sequence + 1}`),
      order: finiteOrder(order),
      policy: failurePolicy(policy),
      sequence: ++sequence,
      timeoutMs: timeoutMilliseconds(timeoutMs, timeout),
    });
    if (entries.some((entry) => entry.id === record.id)) {
      throw new SuzuAgentLifecycleError(`生命周期事件 ${name} 已存在同名 Hook：${record.id}。`, {
        code: "DUPLICATE_HOOK_ID",
        details: { event: name, hookId: record.id },
      });
    }
    entries.push(record);
    let active = true;
    return () => {
      if (!active) return false;
      active = false;
      const index = entries.indexOf(record);
      if (index < 0) return false;
      entries.splice(index, 1);
      return true;
    };
  };

  const collectBlocks = async (event, payload = {}) => {
    const outcome = await dispatch(event, payload);
    const blocks = outcome.results.flatMap(({ hookId, value }) => contextBlocks(value, hookId));
    return Object.freeze({
      blocks: Object.freeze(blocks),
      failures: outcome.failures,
    });
  };

  const collectContext = (payload = {}) => collectBlocks("ContextCollect", payload);

  const collectDynamicContext = (payload = {}) => collectBlocks("DynamicContextCollect", payload);

  const decide = async (event, payload = {}) => {
    const name = eventName(event);
    if (!DECISION_EVENTS.has(name)) {
      throw new SuzuAgentLifecycleError(`${name} 不是可作出决定的生命周期事件。`, {
        code: "EVENT_DOES_NOT_ACCEPT_DECISIONS",
        details: { event: name },
      });
    }
    const outcome = await dispatch(name, payload);
    const decisions = outcome.results
      .map(({ hookId, value }) => ({ hookId, decision: toolDecision(value) }))
      .filter(({ decision }) => decision !== null);
    const denial = decisions.find(({ decision }) => decision.kind === "deny");
    const question = decisions.find(({ decision }) => decision.kind === "ask");
    const decision = denial?.decision || question?.decision || Object.freeze({ kind: "allow" });
    return Object.freeze({
      ...outcome,
      decision,
      decisions: Object.freeze(decisions.map(({ hookId, decision: value }) => Object.freeze({ hookId, decision: value }))),
    });
  };

  return Object.freeze({
    close() {
      if (closed) return false;
      closed = true;
      for (const entries of listeners.values()) entries.length = 0;
      return true;
    },
    collectContext,
    collectDynamicContext,
    decide,
    dispatch,
    on,
  });
}
