import { SuzuAgentRuntimeError } from "./runtime-error.mjs";
import { isSuzuAgentPermissionMode } from "./permission-modes.mjs";

export { SuzuAgentRuntimeError };
export {
  DEFAULT_SUZU_AGENT_PERMISSION_MODE,
  SUZU_AGENT_PERMISSION_MODES,
  isSuzuAgentPermissionMode,
  normalizeSuzuAgentPermissionMode,
} from "./permission-modes.mjs";

const MAX_IDENTIFIER_LENGTH = 256;
const EVENT_STREAM_OPEN_TIMEOUT_MS = 10_000;

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function identifier(value, label) {
  const normalized = clean(value);
  if (!normalized || normalized.length > MAX_IDENTIFIER_LENGTH || /[\r\n\0]/u.test(normalized)) {
    throw new SuzuAgentRuntimeError("INVALID_IDENTIFIER", `${label}无效。`);
  }
  return normalized;
}

function optionalText(value) {
  return typeof value === "string" ? value : "";
}

function deferred() {
  let settled = false;
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
    reject(error) {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}

function assertApi(api) {
  const source = plainObject(api);
  const required = [
    [source.sessions, "create"],
    [source.sessions, "prompt"],
    [source.sessions, "cancel"],
    [source.sessions, "history"],
    [source.events, "mux"],
    [source.events, "host"],
  ];
  if (typeof source.respond !== "function" || required.some(([owner, method]) => typeof owner?.[method] !== "function")) {
    throw new SuzuAgentRuntimeError("AGENT_CORE_API_CONTRACT_INVALID", "Suzu Agent Core 控制面缺少必要方法。 ");
  }
  return source;
}

function unwrapRpc(response, operation) {
  const result = plainObject(response).result;
  if (result?.ok === true) return result.value;
  const error = plainObject(result?.error);
  throw new SuzuAgentRuntimeError(
    "AGENT_CORE_RPC_REJECTED",
    clean(error.message) || `Suzu Agent Core 拒绝了${operation}。`,
    { details: { operation, code: clean(error.code), error } },
  );
}

function promptContent(input) {
  if (typeof input === "string" && input.trim()) {
    return [{ type: "text", text: input }];
  }
  if (Array.isArray(input) && input.length > 0) {
    const parts = input.map((part) => {
      const candidate = plainObject(part);
      if (candidate.type === "text" && typeof candidate.text === "string" && candidate.text.trim()) {
        return { type: "text", text: candidate.text };
      }
      if (
        candidate.type === "image"
        && new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]).has(clean(candidate.mediaType))
        && typeof candidate.data === "string"
        && candidate.data.trim()
      ) {
        return {
          type: "image",
          mediaType: clean(candidate.mediaType),
          data: candidate.data,
          ...(clean(candidate.name) ? { name: clean(candidate.name) } : {}),
        };
      }
      return null;
    });
    if (parts.every(Boolean)) return parts;
  }
  throw new SuzuAgentRuntimeError(
    "AGENT_CORE_INPUT_UNSUPPORTED",
    "Suzu Agent Core 消息只接受文本和 PNG、JPEG、WebP、GIF 图片内容。",
  );
}

function textFromMessage(message) {
  const content = Array.isArray(plainObject(message).content) ? message.content : [];
  return content
    .filter((block) => plainObject(block).type === "text")
    .map((block) => optionalText(block.text))
    .join("");
}

function reasonMessage(reason) {
  const value = plainObject(reason);
  if (value.kind === "error") return clean(plainObject(value.error).message) || "Agent Core 模型调用失败。";
  if (value.kind === "blocked") return "Agent Core 轮次被阻塞。";
  if (value.kind === "max-tokens") return "模型输出达到长度限制。";
  if (value.kind === "interrupted") return "Agent Core 会话在完成前被中断。";
  return "Agent Core 轮次未能正常完成。";
}

function coreEventData(event, extra = {}) {
  const source = plainObject(event);
  return {
    coreSequence: Number.isInteger(source.seq) ? source.seq : null,
    coreTime: Number.isFinite(source.time) ? source.time : null,
    ...extra,
  };
}

function reportedUsage(value) {
  const usage = plainObject(value);
  return Object.keys(usage).length ? usage : null;
}

function streamErrorMessage(error, stream) {
  const suffix = clean(error?.message || error) || "连接意外关闭。";
  return `Agent Core ${stream} 事件流不可用：${suffix}`;
}

/**
 * Implements Suzu's neutral AgentRuntime driver contract over the private
 * Node IPC control plane. It intentionally supports only FIFO prompts at this
 * stage; steering and queue edits require a durable inbox-item mapping that
 * is not guessed or fabricated here.
 */
export function createSuzuAgentRuntimeDriver({
  api,
  createRuntimeSessionId = (suzuSessionId) => suzuSessionId,
} = {}) {
  const coreApi = assertApi(api);
  if (typeof createRuntimeSessionId !== "function") {
    throw new SuzuAgentRuntimeError("ID_FACTORY_INVALID", "Agent Core 会话标识生成器无效。 ");
  }

  const listeners = new Set();
  const sessions = new Map();
  const streamControllers = [];
  const streamTasks = [];
  let streamReadyTask = null;
  let closed = false;

  const assertOpen = () => {
    if (closed) throw new SuzuAgentRuntimeError("RUNTIME_CLOSED", "Agent Core 运行时已经关闭。 ");
  };

  const emit = (event) => {
    const immutable = Object.freeze({
      type: clean(event.type),
      runtimeSessionId: identifier(event.runtimeSessionId, "Agent Core 会话标识"),
      turnId: clean(event.turnId),
      approvalId: clean(event.approvalId),
      text: optionalText(event.text),
      toolName: clean(event.toolName),
      error: clean(event.error),
      data: plainObject(event.data),
    });
    for (const listener of listeners) {
      try { listener(immutable); } catch { /* A product observer cannot break the runtime. */ }
    }
  };

  const emitUnavailable = (record, error, stream) => {
    emit({
      type: "runtime-unavailable",
      runtimeSessionId: record.runtimeSessionId,
      turnId: record.activeTurn?.turnId || "",
      approvalId: "",
      text: "",
      toolName: "",
      error: streamErrorMessage(error, stream),
      data: { stream },
    });
  };

  const activeTurnFor = (record, coreTurn) => record.coreTurns.get(coreTurn) || null;

  const eventTurn = (record, data) => {
    const turn = Number(plainObject(data).turn);
    return Number.isInteger(turn) ? activeTurnFor(record, turn) : null;
  };

  const handleSessionEvent = (record, event, view) => {
    const source = plainObject(event);
    const data = plainObject(source.data);
    const type = clean(source.type);

    if (type === "turn/start") {
      const coreTurn = Number(data.turn);
      if (!Number.isInteger(coreTurn) || record.coreTurns.has(coreTurn)) return;
      const pendingIndex = record.pendingTurns.findIndex((turn) => turn.state === "submitting" || turn.state === "accepted");
      if (pendingIndex < 0) return;
      const turn = record.pendingTurns.splice(pendingIndex, 1)[0];
      turn.state = "running";
      turn.coreTurn = coreTurn;
      record.activeTurn = turn;
      record.coreTurns.set(coreTurn, turn);
      emit({
        type: "turn-started",
        runtimeSessionId: record.runtimeSessionId,
        turnId: turn.turnId,
        approvalId: "",
        text: "",
        toolName: "",
        error: "",
        data: coreEventData(source, { coreTurn }),
      });
      return;
    }

    if (type === "compaction/start" || type === "compaction/end") {
      const compactionTurn = Number.isInteger(data.turn) ? data.turn : null;
      const turn = compactionTurn === null ? record.activeTurn : activeTurnFor(record, compactionTurn);
      const failed = type === "compaction/end" && Boolean(clean(data.error));
      emit({
        type: type === "compaction/start"
          ? "compaction-started"
          : failed
            ? "compaction-failed"
            : "compaction-completed",
        runtimeSessionId: record.runtimeSessionId,
        turnId: turn?.turnId || "",
        approvalId: "",
        text: "",
        toolName: "",
        error: failed ? clean(data.error) : "",
        data: coreEventData(source, {
          compactionId: clean(data.compactionId),
          coreTurn: compactionTurn,
          sourceCommandId: clean(data.sourceCommandId),
        }),
      });
      return;
    }

    if (type === "compaction/summary") {
      const compactionTurn = Number.isInteger(data.turn) ? data.turn : null;
      const turn = compactionTurn === null ? record.activeTurn : activeTurnFor(record, compactionTurn);
      const usage = reportedUsage(data.usage);
      if (!usage) return;
      emit({
        type: "model-usage",
        runtimeSessionId: record.runtimeSessionId,
        turnId: turn?.turnId || "",
        approvalId: "",
        text: "",
        toolName: "",
        error: "",
        data: coreEventData(source, {
          purpose: "compaction",
          usage,
          provider: clean(data.provider),
          model: clean(data.model),
          compactionId: clean(data.compactionId),
          coreTurn: compactionTurn,
        }),
      });
      return;
    }

    const turn = eventTurn(record, data);
    if (!turn) return;
    const coreTurn = Number(data.turn);

    if (type === "assistant/chunk") {
      const chunk = plainObject(data.chunk);
      if (chunk.type === "reasoning-delta" && optionalText(chunk.text)) {
        emit({
          type: "assistant-reasoning-delta",
          runtimeSessionId: record.runtimeSessionId,
          turnId: turn.turnId,
          approvalId: "",
          text: chunk.text,
          toolName: "",
          error: "",
          data: coreEventData(source, { coreTurn, step: Number(data.step), blockIndex: Number(chunk.index) }),
        });
        return;
      }
      if (chunk.type !== "text-delta" || !optionalText(chunk.text)) return;
      turn.streamedText += chunk.text;
      emit({
        type: "assistant-delta",
        runtimeSessionId: record.runtimeSessionId,
        turnId: turn.turnId,
        approvalId: "",
        text: chunk.text,
        toolName: "",
        error: "",
        data: coreEventData(source, { coreTurn, step: Number(data.step), blockIndex: Number(chunk.index) }),
      });
      return;
    }

    if (type === "assistant/message") {
      const finalText = textFromMessage(data.message);
      if (finalText) turn.lastAssistantText = finalText;
      const usage = reportedUsage(data.usage);
      if (usage) {
        const messageSource = plainObject(plainObject(data.message).source);
        emit({
          type: "model-usage",
          runtimeSessionId: record.runtimeSessionId,
          turnId: turn.turnId,
          approvalId: "",
          text: "",
          toolName: "",
          error: "",
          data: coreEventData(source, {
            purpose: "agent-step",
            usage,
            provider: clean(messageSource.provider),
            model: clean(messageSource.model),
            coreTurn,
            step: Number(data.step),
          }),
        });
      }
      return;
    }

    if (type === "tool/call") {
      const callId = clean(data.callId);
      const toolName = clean(data.name) || "tool";
      if (callId) record.calls.set(callId, { turnId: turn.turnId, toolName });
      emit({
        type: "tool-started",
        runtimeSessionId: record.runtimeSessionId,
        turnId: turn.turnId,
        approvalId: "",
        text: "",
        toolName,
        error: "",
        data: coreEventData(source, {
          coreTurn,
          step: Number(data.step),
          callId,
          arguments: optionalText(data.arguments),
          view: plainObject(view),
        }),
      });
      return;
    }

    if (type === "tool/result") {
      const message = plainObject(data.message);
      const block = Array.isArray(message.content) ? plainObject(message.content[0]) : {};
      const callId = clean(plainObject(message.source).callId || block.toolCallId);
      const call = record.calls.get(callId);
      const failed = Boolean(data.error) || block.isError === true;
      emit({
        type: failed ? "tool-failed" : "tool-completed",
        runtimeSessionId: record.runtimeSessionId,
        turnId: call?.turnId || turn.turnId,
        approvalId: "",
        text: "",
        toolName: call?.toolName || "tool",
        error: failed ? clean(plainObject(data.error).code) || "Agent Core 工具执行失败。" : "",
        data: coreEventData(source, {
          coreTurn,
          step: Number(data.step),
          callId,
          result: block.content,
          view: plainObject(view),
        }),
      });
      return;
    }

    if (type !== "turn/end") return;
    const reason = plainObject(data.reason);
    const outcome = clean(reason.kind);
    const terminalData = coreEventData(source, { coreTurn, reason });
    if (outcome === "completed") {
      emit({
        type: "assistant-completed",
        runtimeSessionId: record.runtimeSessionId,
        turnId: turn.turnId,
        approvalId: "",
        text: turn.lastAssistantText || turn.streamedText,
        toolName: "",
        error: "",
        data: terminalData,
      });
    } else if (outcome === "aborted" || outcome === "interrupted") {
      emit({
        type: "turn-cancelled",
        runtimeSessionId: record.runtimeSessionId,
        turnId: turn.turnId,
        approvalId: "",
        text: "",
        toolName: "",
        error: "",
        data: terminalData,
      });
    } else {
      emit({
        type: "turn-failed",
        runtimeSessionId: record.runtimeSessionId,
        turnId: turn.turnId,
        approvalId: "",
        text: "",
        toolName: "",
        error: reasonMessage(reason),
        data: terminalData,
      });
    }
    turn.state = "finished";
    record.coreTurns.delete(coreTurn);
    if (record.activeTurn === turn) record.activeTurn = null;
    for (const [approvalId, approval] of record.approvals) {
      if (approval.turnId === turn.turnId) record.approvals.delete(approvalId);
    }
  };

  const handleMuxFrame = (envelope) => {
    const payload = plainObject(plainObject(envelope).payload);
    const runtimeSessionId = clean(payload.sessionId);
    const record = sessions.get(runtimeSessionId);
    if (!record) return;

    if (payload.type === "session/event") {
      handleSessionEvent(record, payload.event, payload.view);
      return;
    }
    if (payload.type === "approval/requested") {
      const approvalId = clean(payload.approvalId);
      if (!approvalId) return;
      const call = record.calls.get(clean(payload.callId));
      const turnId = call?.turnId || record.activeTurn?.turnId || "";
      record.approvals.set(approvalId, {
        approvalId,
        rpcId: clean(plainObject(envelope).rpcId),
        turnId,
        task: null,
      });
      emit({
        type: "tool-approval-requested",
        runtimeSessionId,
        turnId,
        approvalId,
        text: "",
        toolName: clean(payload.toolName) || call?.toolName || "tool",
        error: "",
        data: { callId: clean(payload.callId), reason: optionalText(payload.reason) },
      });
      return;
    }
    if (payload.type === "approval/resolved") {
      const approvalId = clean(payload.approvalId);
      const approval = record.approvals.get(approvalId);
      emit({
        type: "tool-approval-resolved",
        runtimeSessionId,
        turnId: approval?.turnId || record.activeTurn?.turnId || "",
        approvalId,
        text: "",
        toolName: clean(payload.toolName) || "tool",
        error: "",
        data: {
          callId: clean(payload.callId),
          decision: clean(payload.decision),
        },
      });
      record.approvals.delete(approvalId);
      return;
    }
    if (payload.type === "stream/error") emitUnavailable(record, plainObject(payload.error).message, "mux");
  };

  const handleHostFrame = (envelope) => {
    const payload = plainObject(plainObject(envelope).payload);
    const record = sessions.get(clean(payload.sessionId));
    if (!record) return;
    if (payload.type === "host/agent-error") emitUnavailable(record, payload.message, "host");
    if (payload.type === "host/session-removed") {
      emitUnavailable(record, "Agent Core 会话已被运行时移除。", "host");
    }
    if (payload.type === "stream/error") emitUnavailable(record, plainObject(payload.error).message, "host");
  };

  const consume = async (stream, controller, handleFrame, { onOpen = () => {}, onUnavailable = () => {} } = {}) => {
    let opened = false;
    const markOpen = () => {
      if (opened) return;
      opened = true;
      onOpen();
    };
    const reportUnavailable = (error) => {
      if (!opened) onUnavailable(error);
      if (closed || controller.signal.aborted) return;
      for (const record of sessions.values()) emitUnavailable(record, error, stream);
    };
    try {
      const iterable = stream === "mux"
        ? coreApi.events.mux({}, controller.signal, markOpen)
        : coreApi.events.host({}, controller.signal, markOpen);
      for await (const frame of iterable) handleFrame(frame);
      reportUnavailable("事件流意外结束。");
    } catch (error) {
      reportUnavailable(error);
    }
  };

  const ensureStreams = async () => {
    if (streamReadyTask) return streamReadyTask;
    const muxController = new AbortController();
    const hostController = new AbortController();
    streamControllers.push(muxController, hostController);
    const muxReady = deferred();
    const hostReady = deferred();
    streamTasks.push(
      consume("mux", muxController, handleMuxFrame, {
        onOpen: () => muxReady.resolve(),
        onUnavailable: (error) => muxReady.reject(error),
      }),
      consume("host", hostController, handleHostFrame, {
        onOpen: () => hostReady.resolve(),
        onUnavailable: (error) => hostReady.reject(error),
      }),
    );
    let clearOpenTimeout = () => {};
    const timeout = new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new SuzuAgentRuntimeError("AGENT_CORE_EVENT_STREAM_TIMEOUT", `Agent Core 实时事件流未能在 ${EVENT_STREAM_OPEN_TIMEOUT_MS}ms 内建立。`)),
        EVENT_STREAM_OPEN_TIMEOUT_MS,
      );
      clearOpenTimeout = () => clearTimeout(timer);
    });
    streamReadyTask = Promise.race([Promise.all([muxReady.promise, hostReady.promise]), timeout])
      .finally(clearOpenTimeout)
      .catch((error) => {
        muxController.abort();
        hostController.abort();
        if (error instanceof SuzuAgentRuntimeError) throw error;
        throw new SuzuAgentRuntimeError(
          "AGENT_CORE_EVENT_STREAM_UNAVAILABLE",
          `无法连接 Agent Core 实时事件流：${errorMessage(error, "未知错误。")}`,
          { cause: error },
        );
      });
    return streamReadyTask;
  };

  const recordFor = (runtimeSessionId) => {
    const record = sessions.get(identifier(runtimeSessionId, "Agent Core 会话标识"));
    if (!record) throw new SuzuAgentRuntimeError("SESSION_NOT_FOUND", "Agent Core 会话不存在。 ");
    return record;
  };

  return Object.freeze({
    async createSession({ sessionId, cwd = "", presentation = {} } = {}) {
      assertOpen();
      const suzuSessionId = identifier(sessionId, "Suzu 会话标识");
      const requestedRuntimeSessionId = identifier(createRuntimeSessionId(suzuSessionId), "Agent Core 会话标识");
      const existing = sessions.get(requestedRuntimeSessionId);
      await ensureStreams();
      const preset = clean(plainObject(presentation).agentPreset);
      const permissionMode = clean(plainObject(presentation).permissionMode);
      if (permissionMode && !isSuzuAgentPermissionMode(permissionMode)) {
        throw new SuzuAgentRuntimeError("INVALID_PERMISSION_MODE", "Suzu Agent 审批模式无效。 ");
      }
      const value = unwrapRpc(await coreApi.sessions.create({
        sessionId: requestedRuntimeSessionId,
        ...(clean(cwd) ? { cwd: clean(cwd) } : {}),
        ...(preset ? { agentPreset: preset } : {}),
        ...(permissionMode ? { permissionMode } : {}),
      }), "创建会话");
      const runtimeSessionId = identifier(plainObject(value).sessionId, "Agent Core 会话标识");
      if (existing) {
        if (existing.runtimeSessionId !== runtimeSessionId) {
          throw new SuzuAgentRuntimeError("SESSION_CONFLICT", "Agent Core 返回的会话标识与已打开会话不一致。 ");
        }
        return { runtimeSessionId, created: false };
      }
      if (sessions.has(runtimeSessionId)) {
        throw new SuzuAgentRuntimeError("SESSION_CONFLICT", "Agent Core 返回的会话标识已被占用。 ");
      }
      sessions.set(runtimeSessionId, {
        runtimeSessionId,
        pendingTurns: [],
        coreTurns: new Map(),
        calls: new Map(),
        approvals: new Map(),
        activeTurn: null,
        promptTail: Promise.resolve(),
      });
      return { runtimeSessionId, created: true };
    },

    async sendTurn({ runtimeSessionId, turnId, input, placement = "queue" } = {}) {
      assertOpen();
      const record = recordFor(runtimeSessionId);
      if (clean(placement) !== "queue") {
        throw new SuzuAgentRuntimeError(
          "AGENT_RUNTIME_STEER_NOT_READY",
          "Agent Core 的中途引导和排队编辑需要稳定的 inbox 标识映射，当前阶段尚未启用。",
        );
      }
      const turn = {
        turnId: identifier(turnId, "Suzu 轮次标识"),
        state: "submitting",
        coreTurn: null,
        streamedText: "",
        lastAssistantText: "",
      };
      record.pendingTurns.push(turn);
      const submit = record.promptTail.then(async () => {
        const value = unwrapRpc(await coreApi.sessions.prompt({
          sessionId: record.runtimeSessionId,
          mode: "queue",
          content: promptContent(input),
        }), "发送消息");
        if (plainObject(value).accepted !== true) {
          throw new SuzuAgentRuntimeError("AGENT_CORE_PROMPT_REJECTED", "Agent Core 没有接受这条消息。 ");
        }
        // The execution kernel may publish turn/start before the prompt receipt resolves.
        // Do not regress that already-mapped running turn back to accepted, or
        // a visible tool call could no longer be stopped.
        if (turn.state === "submitting") turn.state = "accepted";
        return { accepted: true, queued: true };
      });
      record.promptTail = submit.catch(() => undefined);
      try {
        return await submit;
      } catch (error) {
        const index = record.pendingTurns.indexOf(turn);
        if (index >= 0) record.pendingTurns.splice(index, 1);
        throw error;
      }
    },

    async cancelTurn({ runtimeSessionId, turnId } = {}) {
      assertOpen();
      const record = recordFor(runtimeSessionId);
      const requestedTurnId = identifier(turnId, "Suzu 轮次标识");
      const turn = [...record.coreTurns.values()].find((item) => item.turnId === requestedTurnId);
      if (!turn || turn.state !== "running") {
        throw new SuzuAgentRuntimeError(
          "AGENT_RUNTIME_TURN_NOT_ACTIVE",
          "Agent Core 当前只能可靠取消已开始的轮次；尚未开始的排队消息不能被错误地当作已取消。",
        );
      }
      const value = unwrapRpc(await coreApi.sessions.cancel({ sessionId: record.runtimeSessionId }), "取消轮次");
      if (plainObject(value).accepted !== true) {
        throw new SuzuAgentRuntimeError("AGENT_CORE_CANCEL_REJECTED", "Agent Core 没有接受取消请求。 ");
      }
      return { accepted: true };
    },

    async resolveApproval({ runtimeSessionId, approvalId, decision } = {}) {
      assertOpen();
      const record = recordFor(runtimeSessionId);
      const normalizedApprovalId = identifier(approvalId, "审批标识");
      const approval = record.approvals.get(normalizedApprovalId);
      if (!approval || !approval.rpcId) return { accepted: false, expired: true };
      const outcome = clean(decision);
      if (outcome !== "allowed-once" && outcome !== "rejected") {
        throw new SuzuAgentRuntimeError("INVALID_APPROVAL_DECISION", "审批决定无效。 ");
      }
      if (approval.task) return approval.task;
      approval.task = (async () => {
        const receipt = await coreApi.respond({
          type: "client-response",
          rpcId: approval.rpcId,
          result: {
            ok: true,
            value: {
              sessionId: record.runtimeSessionId,
              approvalId: normalizedApprovalId,
              outcome,
            },
          },
        });
        if (plainObject(receipt).accepted === true) return { accepted: true };
        record.approvals.delete(normalizedApprovalId);
        return { accepted: false, expired: true };
      })().catch((error) => {
        approval.task = null;
        throw error;
      });
      return approval.task;
    },

    async resumeSession({ runtimeSessionId } = {}) {
      assertOpen();
      const record = recordFor(runtimeSessionId);
      const value = unwrapRpc(await coreApi.sessions.history({
        sessionId: record.runtimeSessionId,
        maxMessages: 1,
      }), "读取会话历史");
      return plainObject(value);
    },

    subscribe(listener) {
      if (typeof listener !== "function") {
        throw new SuzuAgentRuntimeError("INVALID_LISTENER", "Agent Core 事件订阅者无效。 ");
      }
      assertOpen();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async close() {
      if (closed) return;
      closed = true;
      for (const controller of streamControllers) controller.abort();
      await Promise.allSettled(streamTasks);
      listeners.clear();
      sessions.clear();
    },
  });
}

export {
  createSuzuAgentCoreSupervisor,
  resolveEmbeddedSuzuAgentHost,
  resolveEmbeddedSuzuAgentModuleLoader,
} from "./supervisor.mjs";
