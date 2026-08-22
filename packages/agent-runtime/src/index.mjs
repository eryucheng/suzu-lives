import { randomUUID } from "node:crypto";

const RUNTIME_EVENT_TYPES = new Set([
  "turn-started",
  "assistant-reasoning-delta",
  "assistant-delta",
  "assistant-completed",
  "turn-failed",
  "turn-cancelled",
  "tool-approval-requested",
  "tool-approval-resolved",
  "tool-started",
  "tool-completed",
  "tool-failed",
  // Model use is emitted by the selected execution driver for every assistant
  // response (and native compaction).  It is not a renderer event, but it
  // must pass through the product runtime so the unified cost ledger can
  // durably record the same usage that the conversation UI displays.
  "model-usage",
  "compaction-started",
  "compaction-completed",
  "compaction-failed",
  "session-recovered",
  "runtime-unavailable",
  "runtime-restarted",
]);

const TERMINAL_TURN_EVENTS = new Set([
  "assistant-completed",
  "turn-failed",
  "turn-cancelled",
]);

export class AgentRuntimeError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "AgentRuntimeError";
    this.code = code;
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stableIdentifier(value, label) {
  const identifier = clean(value);
  if (!identifier || identifier.length > 256 || /[\r\n\0]/u.test(identifier)) {
    throw new AgentRuntimeError("INVALID_IDENTIFIER", `${label}无效。`);
  }
  return identifier;
}

function turnInput(value) {
  if (typeof value === "string") {
    const text = value.trim();
    if (text) return text;
  }
  if (Array.isArray(value) && value.length > 0) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  throw new AgentRuntimeError("INVALID_TURN_INPUT", "消息不能为空。 ");
}

function runtimeEvent(value) {
  const source = plainObject(value);
  const type = clean(source.type);
  if (!RUNTIME_EVENT_TYPES.has(type)) {
    throw new AgentRuntimeError("INVALID_RUNTIME_EVENT", "运行时发出了未知事件。 ");
  }
  const runtimeSessionId = stableIdentifier(source.runtimeSessionId, "运行时会话标识");
  return {
    type,
    runtimeSessionId,
    turnId: clean(source.turnId),
    approvalId: clean(source.approvalId),
    text: typeof source.text === "string" ? source.text : "",
    toolName: clean(source.toolName),
    error: clean(source.error),
    data: plainObject(source.data),
  };
}

function assertDriver(driver) {
  const source = plainObject(driver);
  for (const method of ["createSession", "sendTurn", "sendTask", "cancelTurn", "resolveApproval", "resumeSession", "subscribe", "close"]) {
    if (typeof source[method] !== "function") {
      throw new AgentRuntimeError("DRIVER_CONTRACT_INVALID", `运行时驱动缺少 ${method}()。`);
    }
  }
  return source;
}

function acceptedResult(value, operation) {
  const result = plainObject(value);
  if (result.accepted !== true) {
    throw new AgentRuntimeError("DRIVER_REJECTED", `运行时拒绝了${operation}。`);
  }
  return result;
}

function errorMessage(error, fallback) {
  return clean(error?.message || error) || fallback;
}

function generatedId(prefix, createId) {
  const candidate = clean(createId(prefix));
  return stableIdentifier(candidate || `${prefix}-${randomUUID()}`, "Suzu 标识");
}

/**
 * Creates Suzu's provider-neutral runtime facade.
 *
 * The driver is deliberately narrower than a product API. It owns one concrete
 * agent runtime; this facade owns Suzu session IDs, monotonic event
 * sequences, and idempotent product actions. Driver events must use the
 * documented shape consumed by `runtimeEvent()`.
 */
export function createAgentRuntime({ driver, createId = (prefix) => `${prefix}-${randomUUID()}` } = {}) {
  const runtimeDriver = assertDriver(driver);
  if (typeof createId !== "function") throw new AgentRuntimeError("ID_FACTORY_INVALID", "运行时标识生成器无效。 ");

  const sessions = new Map();
  const sessionsByRuntimeId = new Map();
  const sessionCreations = new Map();
  const listeners = new Set();
  let closed = false;
  let closeTask = null;

  const assertOpen = () => {
    if (closed) throw new AgentRuntimeError("RUNTIME_CLOSED", "Agent 运行时已经关闭。 ");
  };

  const recordFor = (sessionId) => {
    const record = sessions.get(stableIdentifier(sessionId, "Suzu 会话标识"));
    if (!record) throw new AgentRuntimeError("SESSION_NOT_FOUND", "Suzu 会话不存在。 ");
    return record;
  };

  const publish = (record, event) => {
    const published = Object.freeze({
      type: event.type,
      sessionId: record.sessionId,
      runtimeSessionId: record.runtimeSessionId,
      turnId: event.turnId,
      approvalId: event.approvalId,
      sequence: ++record.sequence,
      text: event.text,
      toolName: event.toolName,
      error: event.error,
      data: event.data,
    });
    for (const listener of listeners) {
      try { listener(published); } catch { /* A UI observer must not stop the runtime. */ }
    }
    return published;
  };

  const receiveDriverEvent = (value) => {
    let event;
    try { event = runtimeEvent(value); } catch { return false; }
    const record = sessionsByRuntimeId.get(event.runtimeSessionId);
    // An Agent Core host can publish events for sessions Suzu does not own. They must
    // never bleed into another contact's event stream.
    if (!record) return false;
    const turn = event.turnId ? record.turns.get(event.turnId) : null;
    if (event.type === "turn-started" && turn) turn.state = "running";
    if (TERMINAL_TURN_EVENTS.has(event.type) && turn) turn.state = "finished";
    if (event.type === "tool-approval-requested" && event.approvalId) {
      record.approvals.set(event.approvalId, { approvalId: event.approvalId, state: "pending", task: null, result: null });
    }
    if (event.type === "tool-approval-resolved" && event.approvalId) {
      record.approvals.delete(event.approvalId);
    }
    if (event.type === "tool-completed" || event.type === "tool-failed") {
      if (event.approvalId) record.approvals.delete(event.approvalId);
    }
    publish(record, event);
    return true;
  };

  const unsubscribe = runtimeDriver.subscribe(receiveDriverEvent);
  if (typeof unsubscribe !== "function") {
    throw new AgentRuntimeError("DRIVER_CONTRACT_INVALID", "运行时驱动的 subscribe() 必须返回取消订阅函数。 ");
  }

  const callDriver = async (record, operation, action, { turnId = "" } = {}) => {
    try {
      return await action();
    } catch (error) {
      publish(record, {
        type: "runtime-unavailable",
        runtimeSessionId: record.runtimeSessionId,
        turnId,
        approvalId: "",
        text: "",
        toolName: "",
        error: errorMessage(error, `${operation}失败。`),
        data: { operation },
      });
      throw new AgentRuntimeError("RUNTIME_UNAVAILABLE", `Agent 运行时${operation}失败：${errorMessage(error, "未知错误。")}`, { cause: error });
    }
  };

  const createSession = async ({ sessionId = "", contactId = "", cwd = "", presentation = {} } = {}) => {
    assertOpen();
    const suzuSessionId = sessionId ? stableIdentifier(sessionId, "Suzu 会话标识") : generatedId("session", createId);
    const existing = sessions.get(suzuSessionId);
    if (existing) return { sessionId: existing.sessionId, runtimeSessionId: existing.runtimeSessionId, created: false };
    const pending = sessionCreations.get(suzuSessionId);
    if (pending) {
      const record = await pending;
      return { sessionId: record.sessionId, runtimeSessionId: record.runtimeSessionId, created: false };
    }
    // UI snapshots and a user turn can request the same persistent contact
    // session at once. The core correctly returns the same runtime ID, so keep
    // one product-side creation task instead of mistaking that ID for a second
    // Suzu session after both requests resolve.
    const creation = (async () => {
      const created = plainObject(await runtimeDriver.createSession({
        sessionId: suzuSessionId,
        contactId: clean(contactId),
        cwd: clean(cwd),
        presentation: plainObject(presentation),
      }));
      const runtimeSessionId = stableIdentifier(created.runtimeSessionId, "运行时会话标识");
      if (sessionsByRuntimeId.has(runtimeSessionId)) {
        throw new AgentRuntimeError("SESSION_CONFLICT", "运行时返回了已经由其他 Suzu 会话占用的会话标识。 ");
      }
      const record = {
        sessionId: suzuSessionId,
        runtimeSessionId,
        contactId: clean(contactId),
        cwd: clean(cwd),
        sequence: 0,
        turns: new Map(),
        approvals: new Map(),
      };
      sessions.set(suzuSessionId, record);
      sessionsByRuntimeId.set(runtimeSessionId, record);
      return record;
    })().finally(() => sessionCreations.delete(suzuSessionId));
    sessionCreations.set(suzuSessionId, creation);
    const record = await creation;
    return { sessionId: record.sessionId, runtimeSessionId: record.runtimeSessionId, created: true };
  };

  const sendTurn = async ({ sessionId, input, placement = "queue", turnId = "", metadata = {} } = {}) => {
    assertOpen();
    const record = recordFor(sessionId);
    const normalizedPlacement = clean(placement) || "queue";
    if (!new Set(["queue", "steer"]).has(normalizedPlacement)) {
      throw new AgentRuntimeError("INVALID_TURN_PLACEMENT", "消息投递位置无效。 ");
    }
    const suzuTurnId = turnId ? stableIdentifier(turnId, "Suzu 轮次标识") : generatedId("turn", createId);
    if (record.turns.has(suzuTurnId)) {
      throw new AgentRuntimeError("TURN_CONFLICT", "Suzu 轮次标识已经存在。 ");
    }
    const turn = { turnId: suzuTurnId, state: "submitting", cancelTask: null };
    record.turns.set(suzuTurnId, turn);
    try {
      const result = acceptedResult(await callDriver(record, "发送消息", () => runtimeDriver.sendTurn({
        runtimeSessionId: record.runtimeSessionId,
        turnId: suzuTurnId,
        input: turnInput(input),
        placement: normalizedPlacement,
        metadata: plainObject(metadata),
      }), { turnId: suzuTurnId }), "发送消息");
      // A concrete runtime can publish turn-started before its enqueue receipt
      // resolves. Preserve that running state so a following human message can
      // still interrupt the active task.
      if (turn.state === "submitting") turn.state = "accepted";
      return { accepted: true, sessionId: record.sessionId, runtimeSessionId: record.runtimeSessionId, turnId: suzuTurnId, queued: result.queued === true };
    } catch (error) {
      record.turns.delete(suzuTurnId);
      throw error;
    }
  };

  /**
   * Wakes a provider-owned task turn without serializing the task body as a
   * user message. The product injects that body through a one-turn dynamic
   * context hook after the runtime has started the turn.
   */
  const sendTask = async ({ sessionId, task = {}, placement = "queue", turnId = "", metadata = {} } = {}) => {
    assertOpen();
    const record = recordFor(sessionId);
    const normalizedPlacement = clean(placement) || "queue";
    if (normalizedPlacement !== "queue") {
      throw new AgentRuntimeError("INVALID_TASK_PLACEMENT", "内部任务只能按顺序投递。 ");
    }
    const suzuTurnId = turnId ? stableIdentifier(turnId, "Suzu 轮次标识") : generatedId("task", createId);
    if (record.turns.has(suzuTurnId)) {
      throw new AgentRuntimeError("TURN_CONFLICT", "Suzu 轮次标识已经存在。 ");
    }
    const turn = { turnId: suzuTurnId, state: "submitting", cancelTask: null };
    record.turns.set(suzuTurnId, turn);
    try {
      const result = acceptedResult(await callDriver(record, "投递内部任务", () => runtimeDriver.sendTask({
        runtimeSessionId: record.runtimeSessionId,
        turnId: suzuTurnId,
        task: plainObject(task),
        placement: normalizedPlacement,
        metadata: plainObject(metadata),
      }), { turnId: suzuTurnId }), "投递内部任务");
      if (turn.state === "submitting") turn.state = "accepted";
      return { accepted: true, sessionId: record.sessionId, runtimeSessionId: record.runtimeSessionId, turnId: suzuTurnId, queued: result.queued === true };
    } catch (error) {
      record.turns.delete(suzuTurnId);
      throw error;
    }
  };

  const cancelTurn = async ({ sessionId, turnId } = {}) => {
    assertOpen();
    const record = recordFor(sessionId);
    const suzuTurnId = stableIdentifier(turnId, "Suzu 轮次标识");
    const turn = record.turns.get(suzuTurnId);
    if (!turn) throw new AgentRuntimeError("TURN_NOT_FOUND", "Suzu 轮次不存在。 ");
    if (turn.state === "finished") return { accepted: true, alreadyFinished: true, turnId: suzuTurnId };
    if (turn.cancelTask) return turn.cancelTask;
    turn.cancelTask = callDriver(record, "取消轮次", async () => {
      const result = acceptedResult(await runtimeDriver.cancelTurn({ runtimeSessionId: record.runtimeSessionId, turnId: suzuTurnId }), "取消轮次");
      return { accepted: true, alreadyFinished: result.alreadyFinished === true, turnId: suzuTurnId };
    }, { turnId: suzuTurnId }).catch((error) => {
      turn.cancelTask = null;
      throw error;
    });
    return turn.cancelTask;
  };

  const resolveApproval = async ({ sessionId, approvalId, decision } = {}) => {
    assertOpen();
    const record = recordFor(sessionId);
    const id = stableIdentifier(approvalId, "审批标识");
    const normalizedDecision = clean(decision);
    if (!new Set(["allowed-once", "rejected"]).has(normalizedDecision)) {
      throw new AgentRuntimeError("INVALID_APPROVAL_DECISION", "审批决定无效。 ");
    }
    const approval = record.approvals.get(id);
    if (!approval) return { accepted: false, expired: true, approvalId: id };
    if (approval.task) return approval.task;
    if (approval.state !== "pending") return approval.result || { accepted: false, expired: true, approvalId: id };
    approval.task = callDriver(record, "回复审批", async () => {
      const result = plainObject(await runtimeDriver.resolveApproval({
        runtimeSessionId: record.runtimeSessionId,
        approvalId: id,
        decision: normalizedDecision,
      }));
      approval.result = result.accepted === true
        ? { accepted: true, expired: false, approvalId: id, decision: normalizedDecision }
        : { accepted: false, expired: true, approvalId: id };
      approval.state = approval.result.accepted ? "resolved" : "expired";
      return approval.result;
    }).catch((error) => {
      approval.task = null;
      throw error;
    });
    return approval.task;
  };

  const resumeSession = async ({ sessionId } = {}) => {
    assertOpen();
    const record = recordFor(sessionId);
    const snapshot = await callDriver(record, "恢复会话", () => runtimeDriver.resumeSession({ runtimeSessionId: record.runtimeSessionId }));
    publish(record, {
      type: "session-recovered",
      runtimeSessionId: record.runtimeSessionId,
      turnId: "",
      approvalId: "",
      text: "",
      toolName: "",
      error: "",
      data: { snapshot: plainObject(snapshot) },
    });
    return { sessionId: record.sessionId, runtimeSessionId: record.runtimeSessionId, snapshot };
  };

  const closeRuntime = async () => {
    if (closeTask) return closeTask;
    closed = true;
    closeTask = (async () => {
      try { unsubscribe(); } catch { /* Driver cleanup is best effort. */ }
      await runtimeDriver.close();
      listeners.clear();
    })();
    return closeTask;
  };

  return Object.freeze({
    createSession,
    sendTurn,
    sendTask,
    cancelTurn,
    resolveApproval,
    resumeSession,
    closeRuntime,
    subscribe(listener) {
      if (typeof listener !== "function") throw new AgentRuntimeError("INVALID_LISTENER", "运行时订阅者无效。 ");
      assertOpen();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

/**
 * Controllable in-memory driver for product tests. It has no model, filesystem,
 * process, or network behavior; tests explicitly emit the runtime events they
 * need to exercise.
 */
export function createFakeAgentRuntimeDriver() {
  const listeners = new Set();
  const calls = {
    createSession: [],
    sendTurn: [],
    sendTask: [],
    cancelTurn: [],
    resolveApproval: [],
    resumeSession: [],
    close: 0,
  };
  return {
    calls,
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    async createSession(request) {
      calls.createSession.push(request);
      return { runtimeSessionId: `fake-runtime-${request.sessionId}` };
    },
    async sendTurn(request) {
      calls.sendTurn.push(request);
      return { accepted: true, queued: request.placement === "queue" };
    },
    async sendTask(request) {
      calls.sendTask.push(request);
      return { accepted: true, queued: request.placement === "queue" };
    },
    async cancelTurn(request) {
      calls.cancelTurn.push(request);
      return { accepted: true };
    },
    async resolveApproval(request) {
      calls.resolveApproval.push(request);
      return { accepted: true };
    },
    async resumeSession(request) {
      calls.resumeSession.push(request);
      return { restored: true };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      calls.close += 1;
    },
  };
}
