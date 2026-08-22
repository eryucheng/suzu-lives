import {
  createAssistantMessage,
  createUserMessage,
  isAgentLoopRequest,
} from "@suzu-lives/suzu-agent-runtime/core/llm";

import {
  SUZU_AGENT_LIFECYCLE_IPC_PROTOCOL,
  normalizeSuzuAgentLifecycleIpcMessage,
} from "./lifecycle-ipc.mjs";
import {
  isSuzuAgentTaskTrigger,
  normalizeSuzuAgentTaskOutputPolicy,
} from "./task-trigger.mjs";

export const name = "suzu-lifecycle-bridge";
export const inject = [];

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DYNAMIC_CONTEXT_INTRO = "以下是仅供本次模型请求使用的实时背景资料，不是用户新消息：";
const LEGACY_SCHEDULE_TASK_OPEN = "<suzu-schedule-task>";
const LEGACY_SCHEDULE_TASK_CLOSE = "</suzu-schedule-task>";
const LEGACY_SILENT_SCHEDULE_MARKER = "<!-- suzu-lives:display-system -->";

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function messageText(message) {
  const content = Array.isArray(plainObject(message).content) ? message.content : [];
  return content
    .filter((block) => plainObject(block).type === "text")
    .map((block) => String(plainObject(block).text ?? ""))
    .join("\n");
}

function isLegacySilentScheduleTask(message) {
  const text = messageText(message);
  return text.includes(LEGACY_SCHEDULE_TASK_OPEN)
    && text.includes(LEGACY_SCHEDULE_TASK_CLOSE)
    && text.includes(LEGACY_SILENT_SCHEDULE_MARKER);
}

function taskOutputPolicy(message) {
  return normalizeSuzuAgentTaskOutputPolicy(plainObject(message?.source).outputPolicy);
}

function automationTaskOutputPolicy(blocks) {
  let found = false;
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const candidate = plainObject(block);
    if (clean(candidate.kind) !== "automation-task") continue;
    found = true;
    if (normalizeSuzuAgentTaskOutputPolicy(plainObject(candidate.metadata).outputPolicy) === "silent") {
      return "silent";
    }
  }
  return found ? "external" : "";
}

function hasTerminalNoReply(value) {
  const text = clean(value);
  return Boolean(text) && /NO_REPLY(?:[\s,，。.!！?？;；、…]*NO_REPLY)*[\s,，。.!！?？;；、…]*$/iu.test(text);
}

function timeoutMilliseconds(value) {
  const candidate = Number(value);
  return Number.isSafeInteger(candidate) && candidate >= 1 && candidate <= 60_000
    ? candidate
    : DEFAULT_REQUEST_TIMEOUT_MS;
}

function serializable(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return "[无法序列化]";
  }
}

function productDecision(value) {
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

function combinePreToolDecisions(provider, product) {
  if (provider?.kind === "deny") return provider;
  if (product?.kind === "deny") return product;
  if (provider?.kind === "ask") return provider;
  if (product?.kind === "ask") return product;
  return Object.freeze({ kind: "allow" });
}

function injectedBlocks(value) {
  const blocks = Array.isArray(plainObject(value).blocks) ? value.blocks : [];
  return blocks.flatMap((candidate, index) => {
    const source = plainObject(candidate);
    const text = String(source.text ?? "");
    if (!text.trim()) return [];
    const kind = clean(source.kind) || "context";
    return [Object.freeze({
      id: clean(source.id) || `context:${index + 1}`,
      kind,
      display: contextDisplay(source.display, kind),
      metadata: Object.freeze({ ...plainObject(source.metadata) }),
      priority: Number.isFinite(source.priority) ? Number(source.priority) : 0,
      source: clean(source.source) || "hook",
      text,
    })];
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

function contextBlockDetails(block) {
  return {
    id: block.id,
    kind: block.kind,
    display: block.display,
    metadata: block.metadata,
    priority: block.priority,
    source: block.source,
  };
}

function contextSnapshotSection(block) {
  return {
    name: block.id,
    text: block.text,
    ...contextBlockDetails(block),
  };
}

function renderDynamicContext(blocks) {
  return [
    DYNAMIC_CONTEXT_INTRO,
    ...blocks.map((block) => `【${block.kind}】\n${block.text}`),
  ].join("\n\n");
}

function isDynamicContextMessage(message) {
  const source = plainObject(message?.source);
  return source.kind === "plugin"
    && source.plugin === name
    && source.form === "snapshot"
    && Array.isArray(source.sections);
}

function persistedAutomationTaskOutputPolicy(message) {
  if (!isDynamicContextMessage(message)) return "";
  return automationTaskOutputPolicy(plainObject(message?.source).sections);
}

function insertBeforeCurrentUserMessage(messages, message) {
  // The selected execution kernel gives direct human input a distinct source from plugin context and tool
  // results. Keep a request-only snapshot immediately before that input, rather
  // than treating it as a trailing follow-up message.
  const currentUserIndex = messages.findIndex((candidate) => (
    plainObject(candidate?.source).kind === "user"
  ));
  if (currentUserIndex < 0) {
    messages.push(message);
    return;
  }
  messages.splice(currentUserIndex, 0, message);
}

function blocksFromDynamicContextMessage(message) {
  const source = plainObject(message?.source);
  const sections = Array.isArray(source.sections) ? source.sections : [];
  return Object.freeze(sections.flatMap((section, index) => {
    const candidate = plainObject(section);
    const text = String(candidate.text ?? "");
    if (!text.trim()) return [];
    return [Object.freeze({
      id: clean(candidate.name) || `dynamic-context:${index + 1}`,
      kind: clean(candidate.kind) || "context",
      display: contextDisplay(candidate.display, clean(candidate.kind) || "context"),
      metadata: Object.freeze({ ...plainObject(candidate.metadata) }),
      priority: Number.isFinite(candidate.priority) ? Number(candidate.priority) : 0,
      source: clean(candidate.source) || name,
      text,
    })];
  }));
}

function latestStepPosition(session) {
  const events = Array.isArray(session?.events) ? session.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "step/start") continue;
    const data = plainObject(event.data);
    if (Number.isInteger(data.turn) && Number.isInteger(data.step)) {
      return Object.freeze({ turn: data.turn, step: data.step });
    }
  }
  return null;
}

function surfaceIncludes(session, sequence) {
  return Number.isInteger(sequence)
    && Array.isArray(session?.surface?.nodes)
    && session.surface.nodes.includes(sequence);
}

function modelProvenance(session, { provider = "", model = "" } = {}) {
  const header = plainObject(session?.requestHeader?.());
  const config = plainObject(header.config);
  return Object.freeze({
    provider: clean(provider) || clean(config.provider) || "runtime",
    model: clean(model) || clean(config.model) || "dynamic-context",
  });
}

function sessionId(agent) {
  return clean(agent?.id || agent?.session?.id);
}

function errorText(error) {
  return clean(error?.message || error) || "桥接失败。";
}

function eventPosition(data) {
  const source = plainObject(data);
  const turn = Number(source.turn);
  const step = Number(source.step);
  return Number.isInteger(turn) && Number.isInteger(step)
    ? Object.freeze({ turn, step })
    : null;
}

function streamPositionKey(turn, step) {
  return Number.isInteger(turn) && Number.isInteger(step)
    ? `${turn}:${step}`
    : "";
}

function createStreamRecord(session, position) {
  return {
    blocks: new Map(),
    chunkSeqs: [],
    finishKind: "",
    order: [],
    sawToolCall: false,
    session,
    step: position.step,
    turn: position.turn,
    usage: undefined,
  };
}

function streamBlock(record, index, blockType = "") {
  const known = record.blocks.get(index);
  if (known) {
    if (!known.blockType && clean(blockType)) known.blockType = clean(blockType);
    return known;
  }
  const block = {
    block: null,
    blockType: clean(blockType),
    text: "",
  };
  record.blocks.set(index, block);
  record.order.push(index);
  return block;
}

function recordAssistantChunk(record, event) {
  if (!record || !Number.isInteger(event?.seq)) return;
  record.chunkSeqs.push(event.seq);
  const chunk = plainObject(plainObject(event.data).chunk);
  const type = clean(chunk.type);
  if (type === "usage") {
    record.usage = chunk.usage;
    return;
  }
  if (type === "finish") {
    record.finishKind = clean(plainObject(chunk.reason).kind);
    return;
  }
  const index = Number(chunk.index);
  if (!Number.isInteger(index) || index < 0) return;
  if (type === "block-start") {
    const blockType = clean(chunk.blockType);
    if (blockType === "tool-call") record.sawToolCall = true;
    streamBlock(record, index, blockType);
    return;
  }
  if (type === "tool-call-delta") {
    record.sawToolCall = true;
    streamBlock(record, index, "tool-call");
    return;
  }
  if (type === "text-delta" || type === "reasoning-delta") {
    const block = streamBlock(record, index, type === "text-delta" ? "text" : "reasoning");
    if (!block.block) block.text += String(chunk.text ?? "");
    return;
  }
  if (type !== "block-end") return;
  const completed = plainObject(chunk.block);
  const blockType = clean(completed.type);
  if (blockType === "tool-call") record.sawToolCall = true;
  const block = streamBlock(record, index, blockType);
  if (!block.block) block.block = completed;
}

function interruptedBlocks(record) {
  if (!record) return [];
  return record.order.flatMap((index) => {
    const partial = record.blocks.get(index);
    if (!partial) return [];
    const completed = plainObject(partial.block);
    const type = clean(completed.type) || clean(partial.blockType);
    if (type !== "text" && type !== "reasoning") return [];
    const text = typeof completed.text === "string" ? completed.text : partial.text;
    return clean(text) ? [{ type, text }] : [];
  });
}

function messageHasReplayState(message) {
  const source = plainObject(message?.source);
  return source.kind === "model" && source.replayState !== undefined;
}

function messageProvenance(message, session) {
  const source = plainObject(message?.source);
  return modelProvenance(session, {
    provider: clean(source.provider),
    model: clean(source.model),
  });
}

/**
 * Small request/reply transport over Node's owned-child IPC channel. When the selected execution kernel
 * is run standalone there is no parent channel; requests then resolve as
 * unavailable and the plugin leaves the selected execution kernel's normal execution path untouched.
 */
export function createSuzuAgentLifecycleBridgeTransport({
  processRef = process,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  const pending = new Map();
  const commandHandlers = new Map();
  const defaultTimeout = timeoutMilliseconds(requestTimeoutMs);
  let sequence = 0;
  let disposed = false;

  const send = (message) => {
    if (disposed || !processRef?.connected || typeof processRef?.send !== "function") return false;
    try {
      return processRef.send(message) !== false;
    } catch {
      return false;
    }
  };

  const settle = (requestId, result) => {
    const record = pending.get(requestId);
    if (!record) return false;
    pending.delete(requestId);
    if (record.timer) clearTimeout(record.timer);
    record.resolve(Object.freeze(result));
    return true;
  };

  const respondToCommand = (requestId, result) => send({
    protocol: SUZU_AGENT_LIFECYCLE_IPC_PROTOCOL,
    kind: "response",
    requestId,
    result: plainObject(result),
  });

  const onMessage = (message) => {
    const envelope = normalizeSuzuAgentLifecycleIpcMessage(message);
    if (!envelope) return;
    if (envelope.kind === "response") {
      settle(envelope.requestId, { available: true, result: envelope.result });
      return;
    }
    if (envelope.kind !== "command") return;
    const handler = commandHandlers.get(envelope.event);
    if (typeof handler !== "function") return;
    void Promise.resolve()
      .then(() => handler(envelope.payload))
      .then((result) => respondToCommand(envelope.requestId, result))
      .catch((error) => respondToCommand(envelope.requestId, {
        ok: false,
        error: {
          code: clean(error?.code) || "AGENT_PRODUCT_COMMAND_FAILED",
          message: errorText(error),
        },
      }));
  };
  processRef?.on?.("message", onMessage);

  const request = async (event, payload = {}, { timeoutMs = defaultTimeout } = {}) => {
    const requestId = `suzu-lifecycle-${processRef?.pid || "agent-core"}-${Date.now()}-${++sequence}`;
    const boundedTimeout = timeoutMilliseconds(timeoutMs);
    return new Promise((resolve) => {
      const timer = boundedTimeout > 0
        ? setTimeout(() => settle(requestId, { available: false, reason: "timeout" }), boundedTimeout)
        : null;
      timer?.unref?.();
      pending.set(requestId, { resolve, timer });
      const accepted = send({
        protocol: SUZU_AGENT_LIFECYCLE_IPC_PROTOCOL,
        kind: "request",
        requestId,
        event: clean(event),
        payload: plainObject(payload),
      });
      if (!accepted) settle(requestId, { available: false, reason: "unavailable" });
    });
  };

  const notify = (event, payload = {}) => send({
    protocol: SUZU_AGENT_LIFECYCLE_IPC_PROTOCOL,
    kind: "event",
    event: clean(event),
    payload: plainObject(payload),
  });

  const handleCommand = (event, handler) => {
    const name = clean(event);
    if (!name || name.length > 128 || /[\r\n\0]/u.test(name)) {
      throw new TypeError("Agent Core product command name is invalid.");
    }
    if (typeof handler !== "function") throw new TypeError("Agent Core product command handler is invalid.");
    if (commandHandlers.has(name)) throw new TypeError(`Agent Core product command is already registered: ${name}`);
    commandHandlers.set(name, handler);
    return () => {
      if (commandHandlers.get(name) !== handler) return false;
      commandHandlers.delete(name);
      return true;
    };
  };

  return Object.freeze({
    dispose() {
      if (disposed) return false;
      disposed = true;
      try { processRef?.off?.("message", onMessage); } catch { /* The child process is already exiting. */ }
      for (const requestId of pending.keys()) settle(requestId, { available: false, reason: "disposed" });
      commandHandlers.clear();
      return true;
    },
    handleCommand,
    notify,
    request,
  });
}

function contextEventPayload({ agent, session, turn, step, blocks = [], error = "" } = {}) {
  return {
    sessionId: clean(session?.id) || sessionId(agent),
    coreTurn: Number.isInteger(turn) ? turn : null,
    step: Number.isInteger(step) ? step : null,
    ...(blocks.length ? { blocks } : {}),
    ...(clean(error) ? { error: clean(error) } : {}),
  };
}

/**
 * Builds the Agent Core-side half of the product lifecycle bridge. `agent/pre-step`
 * is the real model-context seam; `tools/pre-execute` is the real pre-body
 * tool seam. Neither is simulated from later Web stream notifications.
 */
export function createSuzuAgentLifecycleBridge({
  createMessage = createUserMessage,
  createResponseMessage = createAssistantMessage,
  isAgentLoopCall = isAgentLoopRequest,
  transport = createSuzuAgentLifecycleBridgeTransport(),
} = {}) {
  if (typeof createMessage !== "function") throw new TypeError("lifecycle bridge requires createUserMessage().");
  if (typeof createResponseMessage !== "function") throw new TypeError("lifecycle bridge requires createAssistantMessage().");
  if (typeof isAgentLoopCall !== "function") throw new TypeError("lifecycle bridge requires isAgentLoopRequest().");
  if (typeof transport?.request !== "function" || typeof transport?.notify !== "function") {
    throw new TypeError("lifecycle bridge requires request() and notify() transport methods.");
  }

  const preparedDynamicMessages = new Map();
  const dynamicRecordsBySession = new Map();
  const knownSessionsById = new Map();
  const silentTaskRecordsBySession = new Map();
  const streamRecordsBySession = new Map();
  const sessionRepairTails = new Map();

  const rememberSession = (session) => {
    const id = clean(session?.id);
    if (id) knownSessionsById.set(id, session);
    return session;
  };

  const streamRecordsFor = (session, { create = false } = {}) => {
    const id = clean(session?.id);
    if (!id) return null;
    const known = streamRecordsBySession.get(id);
    if (known || !create) return known || null;
    const records = new Map();
    streamRecordsBySession.set(id, records);
    return records;
  };

  const streamRecordFor = (session, position, { create = false } = {}) => {
    const key = streamPositionKey(position?.turn, position?.step);
    if (!key) return null;
    const records = streamRecordsFor(session, { create });
    if (!records) return null;
    const known = records.get(key);
    if (known || !create) return known || null;
    const record = createStreamRecord(session, position);
    records.set(key, record);
    return record;
  };

  const takeStreamRecord = (session, position) => {
    const key = streamPositionKey(position?.turn, position?.step);
    const records = streamRecordsFor(session);
    if (!key || !records) return null;
    const record = records.get(key) || null;
    records.delete(key);
    if (!records.size) streamRecordsBySession.delete(clean(session?.id));
    return record;
  };

  const takeLatestStreamRecordForTurn = (session, turn) => {
    const records = streamRecordsFor(session);
    if (!records || !Number.isInteger(turn)) return null;
    const candidates = [...records.values()]
      .filter((record) => record.turn === turn)
      .sort((left, right) => right.step - left.step);
    for (const record of candidates) records.delete(streamPositionKey(record.turn, record.step));
    if (!records.size) streamRecordsBySession.delete(clean(session?.id));
    return candidates[0] || null;
  };

  const clearStreamRecordsForTurn = (session, turn) => {
    const records = streamRecordsFor(session);
    if (!records || !Number.isInteger(turn)) return;
    for (const [key, record] of records) if (record.turn === turn) records.delete(key);
    if (!records.size) streamRecordsBySession.delete(clean(session?.id));
  };

  const scheduleSessionRepair = (session, repair) => {
    const id = clean(session?.id);
    if (!id || typeof session?.append !== "function" || typeof repair !== "function") return Promise.resolve(false);
    const previous = sessionRepairTails.get(id) || Promise.resolve();
    const operation = previous.then(repair, repair);
    // A compatibility repair must never turn an already-completed model turn
    // into an IPC-visible failure. The original Agent Core event remains durable.
    const settled = operation.catch(() => undefined);
    sessionRepairTails.set(id, settled);
    void settled.finally(() => {
      if (sessionRepairTails.get(id) === settled) sessionRepairTails.delete(id);
    });
    return settled;
  };

  const waitForSessionRepair = async (session) => {
    const pending = sessionRepairTails.get(clean(session?.id));
    if (pending) await pending;
  };

  const taskRecordsFor = (session, { create = false } = {}) => {
    const id = clean(session?.id);
    if (!id) return null;
    const records = silentTaskRecordsBySession.get(id);
    if (records || !create) return records || null;
    const created = new Map();
    silentTaskRecordsBySession.set(id, created);
    return created;
  };

  const rememberTask = (session, turn, outputPolicy = "external") => {
    if (!Number.isInteger(turn) || !Array.isArray(session?.surface?.nodes)) return null;
    const records = taskRecordsFor(session, { create: true });
    if (!records || records.has(turn)) return records?.get(turn) || null;
    const record = Object.freeze({
      session,
      startSurfaceIndex: session.surface.nodes.length,
      turn,
      outputPolicy: normalizeSuzuAgentTaskOutputPolicy(outputPolicy),
    });
    records.set(turn, record);
    return record;
  };

  const takeTask = (session, turn) => {
    const records = taskRecordsFor(session);
    if (!records || !Number.isInteger(turn)) return null;
    const record = records.get(turn) || null;
    if (record) records.delete(turn);
    if (!records.size) silentTaskRecordsBySession.delete(clean(session?.id));
    return record;
  };

  const cleanupMessage = () => createMessage({
    content: [],
    source: {
      kind: "plugin",
      plugin: name,
      form: "task-cleanup",
    },
  });

  const replaceSurfaceRangeWithCleanup = (session, start, end) => {
    if (!surfaceIncludes(session, start) || !surfaceIncludes(session, end)) return false;
    const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
    const startIndex = nodes.indexOf(start);
    const endIndex = nodes.indexOf(end);
    if (startIndex < 0 || endIndex < startIndex) return false;
    session.append("user/message", cleanupMessage(), {
      surfaceOp: { op: "replace", start, end },
    });
    return true;
  };

  const cleanupSilentTask = (record) => {
    const session = rememberSession(record?.session);
    const startIndex = Number(record?.startSurfaceIndex);
    const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
    if (!session || !Number.isSafeInteger(startIndex) || startIndex < 0 || nodes.length <= startIndex) return false;
    return replaceSurfaceRangeWithCleanup(session, nodes[startIndex], nodes.at(-1));
  };

  const taskEndedWithNoReply = (record) => {
    const session = record?.session;
    const startIndex = Number(record?.startSurfaceIndex);
    const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
    const events = Array.isArray(session?.events) ? session.events : [];
    if (!Number.isSafeInteger(startIndex) || startIndex < 0 || nodes.length <= startIndex) return false;
    const bySequence = new Map(events.map((event) => [event?.seq, event]));
    for (let index = nodes.length - 1; index >= startIndex; index -= 1) {
      const event = bySequence.get(nodes[index]);
      if (clean(event?.type) !== "assistant/message") continue;
      return hasTerminalNoReply(messageText(plainObject(event?.data).message));
    }
    return false;
  };

  const repairPersistedAutomationTask = (session) => {
    const events = Array.isArray(session?.events) ? session.events : [];
    const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
    if (!events.length || !nodes.length) return false;
    const bySequence = new Map(events.map((event) => [event?.seq, event]));
    const turnBySequence = new Map();
    const candidates = [];
    let activeTurn = null;
    for (const event of events) {
      const type = clean(event?.type);
      if (type === "turn/start") {
        const turn = Number(plainObject(event.data).turn);
        activeTurn = Number.isInteger(turn) ? turn : null;
      }
      if (Number.isInteger(event?.seq)) turnBySequence.set(event.seq, activeTurn);
      if (type === "user/message" && Number.isInteger(activeTurn)) {
        const legacySilent = isLegacySilentScheduleTask(event.data);
        const dynamicPolicy = persistedAutomationTaskOutputPolicy(event.data);
        if (legacySilent || dynamicPolicy) {
          candidates.push(Object.freeze({
            seq: event.seq,
            turn: activeTurn,
            outputPolicy: legacySilent ? "silent" : dynamicPolicy,
          }));
        }
      }
      if (type === "turn/end") activeTurn = null;
    }
    for (const candidate of candidates) {
      if (!surfaceIncludes(session, candidate.seq)) continue;
      const startIndex = nodes.indexOf(candidate.seq);
      if (startIndex < 0) continue;
      let endIndex = startIndex;
      while (endIndex + 1 < nodes.length && turnBySequence.get(nodes[endIndex + 1]) === candidate.turn) {
        endIndex += 1;
      }
      if (turnBySequence.get(nodes[endIndex]) !== candidate.turn) continue;
      let terminalNoReply = false;
      for (let index = endIndex; index >= startIndex; index -= 1) {
        const event = bySequence.get(nodes[index]);
        if (clean(event?.type) !== "assistant/message") continue;
        terminalNoReply = hasTerminalNoReply(messageText(plainObject(event?.data).message));
        break;
      }
      if (candidate.outputPolicy === "silent" || terminalNoReply) {
        return replaceSurfaceRangeWithCleanup(session, nodes[startIndex], nodes[endIndex]);
      }
    }
    return false;
  };

  const persistInterruptedAssistant = (record) => {
    const session = rememberSession(record?.session);
    const content = interruptedBlocks(record);
    const sources = [...new Set(record?.chunkSeqs || [])];
    if (!session || !content.length || !sources.length || typeof session.append !== "function") return false;
    const message = createResponseMessage({
      content,
      source: modelProvenance(session),
    });
    const data = {
      turn: record.turn,
      step: record.step,
      message,
      interrupted: true,
      ...(record.usage === undefined ? {} : { usage: record.usage }),
    };
    session.append("assistant/message", data, {
      surfaceOp: "append",
      sourceEventSeqs: sources,
    });
    return true;
  };

  const repairMaxTokenReplay = (session, event) => {
    if (!surfaceIncludes(session, event?.seq)) return false;
    const data = plainObject(event?.data);
    const message = plainObject(data.message);
    if (!messageHasReplayState(message)) return false;
    const content = Array.isArray(message.content) ? message.content : [];
    const replacement = createResponseMessage({
      content,
      source: messageProvenance(message, session),
    });
    session.append("assistant/message", {
      turn: data.turn,
      step: data.step,
      message: replacement,
    }, {
      surfaceOp: { op: "replace", start: event.seq, end: event.seq },
      sourceEventSeqs: [event.seq],
    });
    return true;
  };

  const preserveInterruptedStream = (stream, { session, position, signal }) => (async function* preserveInterruptedStreamGenerator() {
    let exhausted = false;
    try {
      for await (const chunk of stream) yield chunk;
      exhausted = true;
    } finally {
      // the selected kernel records the streamed text/reasoning before rethrowing an
      // abort. rc.6 does not. This runs while the agent loop closes its stream,
      // before it writes step/end and turn/end, using only public plugin seams.
      if (!exhausted && signal?.aborted) {
        const record = takeStreamRecord(session, position);
        try { persistInterruptedAssistant(record); } catch { /* The cancelling turn still owns its normal shutdown path. */ }
      }
    }
  }());

  const forgetDynamicRecord = (record) => {
    const key = clean(record?.session?.id);
    if (!key) return;
    const records = dynamicRecordsBySession.get(key) || [];
    const remaining = records.filter((candidate) => candidate !== record);
    if (remaining.length) dynamicRecordsBySession.set(key, remaining);
    else dynamicRecordsBySession.delete(key);
  };

  const activeDynamicRecords = (session) => {
    const key = clean(session?.id);
    if (!key) return [];
    const records = dynamicRecordsBySession.get(key) || [];
    const active = records.filter((record) => surfaceIncludes(session, record.seq));
    if (active.length) dynamicRecordsBySession.set(key, active);
    else dynamicRecordsBySession.delete(key);
    return active;
  };

  const rememberPreparedDynamicMessage = (message, record) => {
    const id = clean(message?.id);
    if (!id) return;
    preparedDynamicMessages.set(id, record);
    while (preparedDynamicMessages.size > 100) {
      const oldest = preparedDynamicMessages.keys().next().value;
      if (oldest === undefined) break;
      preparedDynamicMessages.delete(oldest);
    }
  };

  const expireDynamicRecord = async (record, call = {}) => {
    const session = record?.session;
    if (!session || !surfaceIncludes(session, record.seq)) {
      forgetDynamicRecord(record);
      return false;
    }
    const position = record.position || latestStepPosition(session);
    if (!Number.isInteger(position?.turn) || !Number.isInteger(position?.step)) {
      transport.notify("DynamicContextCleanupFailed", contextEventPayload({
        session,
        blocks: record.blocks,
        error: "找不到动态上下文所属的 Agent Core step，暂时不能从活动上下文移除。",
      }));
      return false;
    }
    try {
      const provenance = modelProvenance(session, call);
      const message = createResponseMessage({
        content: [],
        source: provenance,
      });
      session.append("assistant/message", {
        turn: position.turn,
        step: position.step,
        message,
      }, {
        surfaceOp: { op: "replace", start: record.seq, end: record.seq },
        sourceEventSeqs: [record.seq],
      });
      forgetDynamicRecord(record);
      transport.notify("DynamicContextExpired", contextEventPayload({
        session,
        turn: position.turn,
        step: position.step,
        blocks: record.blocks,
      }));
      return true;
    } catch (error) {
      transport.notify("DynamicContextCleanupFailed", contextEventPayload({
        session,
        turn: position.turn,
        step: position.step,
        blocks: record.blocks,
        error: errorText(error),
      }));
      return false;
    }
  };

  const expireDynamicRecords = async (records, call = {}) => {
    for (const record of records) await expireDynamicRecord(record, call);
  };

  const expireAfterCompletedStream = (stream, expire) => (async function* expireAfterCompletedStreamGenerator() {
    let successful = false;
    try {
      for await (const chunk of stream) {
        if (plainObject(chunk).type === "finish") {
          const kind = clean(plainObject(plainObject(chunk).reason).kind);
          successful = Boolean(kind) && kind !== "error" && kind !== "aborted";
        }
        yield chunk;
      }
    } finally {
      if (successful) await expire();
    }
  }());

  const apply = (ctx, config = {}) => {
    const timeoutMs = timeoutMilliseconds(plainObject(config).timeoutMs);

    ctx.on("session/event", (session, event) => {
      rememberSession(session);
      const data = plainObject(event?.data);
      const streamedPosition = eventPosition(data);

      if (event?.type === "assistant/chunk" && streamedPosition) {
        const record = streamRecordFor(session, streamedPosition, { create: true });
        recordAssistantChunk(record, event);
        return;
      }

      if (event?.type === "assistant/message" && event.surfaceOp === "append" && streamedPosition) {
        const record = takeStreamRecord(session, streamedPosition);
        if (record?.finishKind === "max-tokens" && record.sawToolCall && messageHasReplayState(data.message)) {
          scheduleSessionRepair(session, () => repairMaxTokenReplay(session, event));
        }
        return;
      }

      if (event?.type === "turn/end") {
        const turn = Number(data.turn);
        const task = takeTask(session, turn);
        if (task && (task.outputPolicy === "silent" || taskEndedWithNoReply(task))) {
          // B is operational work, and an A decision with NO_REPLY is also
          // not a conversation message. Remove its entire completed surface
          // before another turn can derive model history from it.
          scheduleSessionRepair(session, () => cleanupSilentTask(task));
        }
        const aborted = clean(plainObject(data.reason).kind) === "aborted";
        const record = aborted
          ? takeLatestStreamRecordForTurn(session, turn)
          : null;
        if (aborted && record) {
          // A cancellation immediately after a stream finishes has no iterator
          // close path to intercept. Defer until Session.append() leaves this
          // observer, then retain the same safe text/reasoning prefix.
          scheduleSessionRepair(session, () => persistInterruptedAssistant(record));
        } else {
          clearStreamRecordsForTurn(session, turn);
        }
        return;
      }

      if (event?.type !== "user/message" || !isDynamicContextMessage(data)) return;
      const id = clean(data.id);
      const prepared = id ? preparedDynamicMessages.get(id) : null;
      if (id) preparedDynamicMessages.delete(id);
      const position = prepared?.position || latestStepPosition(session);
      if (!Number.isInteger(event.seq) || !Number.isInteger(position?.turn) || !Number.isInteger(position?.step)) return;
      const record = Object.freeze({
        blocks: prepared?.blocks || blocksFromDynamicContextMessage(event.data),
        position,
        seq: event.seq,
        session,
      });
      const key = clean(session?.id);
      if (!key) return;
      dynamicRecordsBySession.set(key, [...activeDynamicRecords(session), record]);
    });

    ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
      const session = rememberSession(agent?.session);
      // A queued human message can wake the next Core turn immediately after
      // an internal task ends. Wait for its cleanup before Core derives the
      // durable surface for that human request.
      await waitForSessionRepair(session);
      while (repairPersistedAutomationTask(session)) {
        // A task can outlive an app restart. Repair every persisted internal
        // turn before a later human request derives model context from it.
      }
      await expireDynamicRecords(activeDynamicRecords(session));
      const decision = await next();
      if (decision.kind === "reject" || signal?.aborted) return decision;
      const reply = await transport.request("ContextCollect", contextEventPayload({ agent, turn, step }), { timeoutMs });
      if (!reply.available) {
        transport.notify("ContextInjectionFailed", contextEventPayload({
          agent,
          turn,
          step,
          error: reply.reason || "parent-unavailable",
        }));
        return decision;
      }
      const blocks = injectedBlocks(reply.result);
      const taskTriggers = decision.messages.filter(isSuzuAgentTaskTrigger);
      if (taskTriggers.length) {
        const outputPolicy = taskTriggers.some((message) => taskOutputPolicy(message) === "silent")
          ? "silent"
          : "external";
        rememberTask(session, turn, outputPolicy);
      }
      // A task trigger only wakes Core. Leaving it in `messages` would append
      // it to the session as a faux user entry; task text is injected below as
      // dynamic context for this request alone.
      const messages = decision.messages.filter((message) => !isSuzuAgentTaskTrigger(message));
      if (blocks.length) {
        try {
          messages.push(...blocks.map((block) => createMessage({
            content: [{ type: "text", text: block.text }],
            source: {
              kind: "plugin",
              plugin: name,
              form: "recall",
              block: contextBlockDetails(block),
            },
          })));
          transport.notify("ContextInjected", contextEventPayload({ agent, turn, step, blocks }));
        } catch (error) {
          transport.notify("ContextInjectionFailed", contextEventPayload({
            agent,
            turn,
            step,
            error: errorText(error),
          }));
        }
      }

      const dynamicReply = await transport.request("DynamicContextCollect", contextEventPayload({ agent, turn, step }), { timeoutMs });
      if (!dynamicReply.available) {
        transport.notify("DynamicContextInjectionFailed", contextEventPayload({
          agent,
          turn,
          step,
          error: dynamicReply.reason || "parent-unavailable",
        }));
      } else {
        const dynamicBlocks = injectedBlocks(dynamicReply.result);
        // Real Agent Core removes its empty task trigger from the inbox before
        // this hook returns. The dynamic automation block is therefore the
        // durable source of truth for associating the whole turn with its
        // output policy; relying on decision.messages alone loses that link.
        const dynamicTaskPolicy = automationTaskOutputPolicy(dynamicBlocks);
        if (dynamicTaskPolicy) rememberTask(session, turn, dynamicTaskPolicy);
        if (dynamicBlocks.length) {
          try {
            const dynamicMessage = createMessage({
              content: [{ type: "text", text: renderDynamicContext(dynamicBlocks) }],
              source: {
                kind: "plugin",
                plugin: name,
                form: "snapshot",
                sections: dynamicBlocks.map(contextSnapshotSection),
              },
            });
            rememberPreparedDynamicMessage(dynamicMessage, Object.freeze({
              blocks: dynamicBlocks,
              position: Object.freeze({ turn, step }),
            }));
            insertBeforeCurrentUserMessage(messages, dynamicMessage);
            transport.notify("DynamicContextInjected", contextEventPayload({ agent, turn, step, blocks: dynamicBlocks }));
          } catch (error) {
            transport.notify("DynamicContextInjectionFailed", contextEventPayload({
              agent,
              turn,
              step,
              error: errorText(error),
            }));
          }
        }
      }

      // A task trigger can be removed while one dynamic block is added, leaving
      // the same array length. Compare the actual sequence instead of using
      // length as a proxy, otherwise Core would retain the trigger and drop
      // the dynamic task body.
      const unchanged = messages.length === decision.messages.length
        && messages.every((message, index) => message === decision.messages[index]);
      return unchanged ? decision : { kind: "enter", messages };
    }, { prepend: true });

    ctx.on("llm/stream", (options, next) => {
      if (!isAgentLoopCall(options)) return next();
      const id = clean(options?.sessionId);
      const session = rememberSession(knownSessionsById.get(id)
        || [...dynamicRecordsBySession.values()].flat().find((record) => clean(record.session?.id) === id)?.session);
      const position = latestStepPosition(session);
      const stream = session && position
        ? preserveInterruptedStream(next(), { session, position, signal: options?.signal })
        : next();
      const records = activeDynamicRecords(session);
      if (!records.length) return stream;
      return expireAfterCompletedStream(stream, () => expireDynamicRecords(records, {
        provider: clean(options.provider),
        model: clean(options.model),
      }));
    }, { global: true });

    ctx.on("tools/pre-execute", async (execution, next) => {
      const provider = await next();
      if (provider?.kind === "deny") return provider;
      const reply = await transport.request("PreToolUse", {
        sessionId: sessionId(execution?.agent),
        callId: clean(execution?.callId),
        rootCallId: clean(execution?.rootCallId),
        toolName: clean(execution?.name),
        arguments: serializable(execution?.arguments),
      }, { timeoutMs });
      if (!reply.available) return provider;
      return combinePreToolDecisions(provider, productDecision(plainObject(reply.result).decision));
    }, { prepend: true });
  };

  return Object.freeze({ apply });
}

const defaultBridge = createSuzuAgentLifecycleBridge();

export function apply(ctx, config = {}) {
  return defaultBridge.apply(ctx, config);
}
