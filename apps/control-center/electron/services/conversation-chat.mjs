import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { createSuzuAgentLifecycle } from "@suzu-lives/agent-lifecycle";
import { conversationAttachmentReceipt } from "./conversation-attachment-service.mjs";
import { createAgentUsageLedger } from "./agent-usage-ledger.mjs";
import { SUZU_SOFTWARE_ASSISTANT_SESSION_ID } from "./software-assistant-service.mjs";

const MAX_AGENT_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_AGENT_MEDIA_ITEMS = 24;
const MAX_MESSAGE_LENGTH = 20_000;
const MAX_EVENT_TEXT_LENGTH = 200_000;
const MAX_QUEUED_TURNS = 50;
const SUZU_CAPABILITY_TOOL = "suzu_capability";

export class ConversationChatError extends Error {
  constructor(message, { cause, code = "AGENT_CONVERSATION_CHAT_ERROR" } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ConversationChatError";
    this.code = code;
  }
}


function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function parsedObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const source = clean(value);
  if (!source) return null;
  const candidates = [source];
  const first = source.indexOf("{");
  const last = source.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(source.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Ordinary Agent Core tool output is not a Suzu attachment receipt.
    }
  }
  return null;
}

function agentMediaReceipt(value) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const receipt = agentMediaReceipt(entry);
      if (receipt) return receipt;
    }
    return null;
  }
  const source = plainObject(value);
  for (const candidate of [source.text, source.content, source.data]) {
    if (candidate === undefined || candidate === value) continue;
    const nested = agentMediaReceipt(candidate);
    if (nested) return nested;
  }
  const receipt = plainObject(parsedObject(value));
  if (clean(receipt.status) !== "ok" || clean(receipt.type) !== conversationAttachmentReceipt.type) return null;
  const media = (Array.isArray(receipt.items) ? receipt.items : [])
    .slice(0, MAX_AGENT_MEDIA_ITEMS)
    .flatMap((item) => {
      const entry = plainObject(item);
      const kind = clean(entry.kind).toLowerCase();
      const sourcePath = clean(entry.path);
      const size = Number(entry.size);
      if (!new Set(["image", "audio", "file"]).has(kind) || !sourcePath || !path.isAbsolute(sourcePath)) return [];
      if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_AGENT_MEDIA_BYTES) return [];
      const resolved = path.resolve(sourcePath);
      return [{
        kind,
        path: resolved,
        fileName: path.basename(clean(entry.fileName) || path.basename(resolved)),
        size,
      }];
    });
  return media.length ? {
    receiptId: clean(receipt.receiptId).slice(0, 160),
    media,
  } : null;
}

function bounded(value, limit = MAX_EVENT_TEXT_LENGTH) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}\n[内容已截断]` : text;
}

function errorMessage(error, fallback) {
  return clean(error?.message || error) || fallback;
}

function sameProjectRoot(left, right) {
  const first = clean(left);
  const second = clean(right);
  if (!first || !second) return false;
  const normalizedLeft = path.resolve(first);
  const normalizedRight = path.resolve(second);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function turnKey(sessionId, projectRoot) {
  const id = clean(sessionId);
  const root = clean(projectRoot);
  if (!id || !root) throw new ConversationChatError("指定 Agent 会话时必须同时提供会话标识和工作目录。", { code: "INVALID_SESSION_SCOPE" });
  const normalizedRoot = path.resolve(root);
  const stableRoot = process.platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot;
  return `${stableRoot}\u0000${id}`;
}

function isDirectory(stat) {
  return Boolean(stat?.isDirectory?.());
}

function mergeFullText(previous, next) {
  const current = bounded(previous);
  const candidate = bounded(next);
  if (!candidate) return current;
  if (!current || candidate.startsWith(current)) return candidate;
  if (current.startsWith(candidate)) return current;
  return bounded(`${current}${candidate}`);
}

function noReply(value) {
  return clean(value) === "NO_REPLY";
}

function inputForAgent({ kind, text, callDirection }) {
  if (kind === "call") {
    return [
      "这是一次实时语音通话的转写。请自然、口语化且简短地回应；不要提及转写、内部工具或运行时。",
      `<suzu-voice-call-turn>\n${JSON.stringify({ source: "suzu-live-call", transcript: clean(text) })}\n</suzu-voice-call-turn>`,
    ].join("\n\n");
  }
  if (kind === "call-open") {
    const initiator = clean(callDirection).toLowerCase() === "agent" ? "agent" : "user";
    return [
      `语音通话刚接通，发起方是 ${initiator}。这不是用户说的话；请只用一句自然简短的问候开场。`,
      `<suzu-voice-call-open>\n${JSON.stringify({ initiator })}\n</suzu-voice-call-open>`,
    ].join("\n\n");
  }
  return text;
}

function toolPreview(value) {
  const source = plainObject(value);
  const raw = typeof source.arguments === "string" ? source.arguments : "";
  if (!raw) return "";
  try { return bounded(JSON.stringify(JSON.parse(raw), null, 2), 4_000); }
  catch { return bounded(raw, 4_000); }
}

function lifecycleScope(value = {}) {
  return {
    contactId: clean(value.contactId),
    kind: clean(value.kind),
    projectRoot: clean(value.projectRoot),
    sessionId: clean(value.sessionId),
    turnId: clean(value.requestId || value.turnId),
  };
}

function lifecycleTurnPayload(turn, extra = {}) {
  return {
    ...lifecycleScope(turn),
    ...(clean(turn?.userText) ? { userText: bounded(turn.userText, MAX_MESSAGE_LENGTH) } : {}),
    ...(clean(turn?.text) ? { assistantText: bounded(turn.text) } : {}),
    ...extra,
  };
}

/**
 * Translates the provider-neutral runtime facade back to the existing Suzu
 * renderer / voice / WeChat event contract.  It owns the product queue, so a
 * queued message can still be removed reliably before it reaches Agent Core.
 */
export function createConversationChatService({
  attachmentService = null,
  compactor = null,
  reader,
  runtime,
  settingsService,
  capabilityRuntime = null,
  memoryRuntime = null,
  lifecycle = null,
  fsOps = fs,
  onEvent = () => {},
} = {}) {
  if (!settingsService?.load) throw new ConversationChatError("Agent 聊天需要软件设置服务。", { code: "SETTINGS_REQUIRED" });
  if (!reader?.ensureActiveSession) throw new ConversationChatError("Agent 聊天需要联系人会话读取服务。", { code: "READER_REQUIRED" });
  for (const method of ["ensureSession", "sendTurn", "cancelTurn", "resolveApproval", "subscribe", "close"]) {
    if (typeof runtime?.[method] !== "function") {
      throw new ConversationChatError(`Agent 聊天运行时缺少 ${method}()。`, { code: "RUNTIME_CONTRACT_INVALID" });
    }
  }
  const ownsLifecycle = !lifecycle;
  const agentLifecycle = lifecycle || createSuzuAgentLifecycle();
  for (const method of ["collectContext", "decide", "dispatch", "on"]) {
    if (typeof agentLifecycle?.[method] !== "function") {
      throw new ConversationChatError(`Suzu 生命周期缺少 ${method}()。`, { code: "LIFECYCLE_CONTRACT_INVALID" });
    }
  }
  const agentUsageLedger = createAgentUsageLedger({
    capabilityRuntime,
    reader,
    settingsService,
  });

  let eventSink = typeof onEvent === "function" ? onEvent : () => {};
  const eventSubscribers = new Set();
  const activeTurns = new Map();
  const pendingTurns = new Map();
  const permissionRequests = new Map();
  const startingSessions = new Set();
  const startingTurns = new Map();
  const turnsById = new Map();
  const openedSessions = new Map();
  const activatedContacts = new Set();
  let disposed = false;

  const dispatchLifecycle = (event, payload) => {
    void Promise.resolve(agentLifecycle.dispatch(event, payload)).catch(() => undefined);
  };

  const turnForRuntimeSession = (sessionId, preferredTurnId = "") => {
    const requestedTurnId = clean(preferredTurnId);
    if (requestedTurnId) {
      const matching = turnsById.get(requestedTurnId);
      if (matching && matching.sessionId === clean(sessionId) && !matching.finished) return matching;
    }
    const matching = [...activeTurns.values()].filter((turn) => turn.sessionId === clean(sessionId) && !turn.finished);
    return matching.length === 1 ? matching[0] : null;
  };

  const lifecyclePayloadForRuntimeSession = (sessionId, { turnId = "", ...extra } = {}) => {
    const turn = turnForRuntimeSession(sessionId, turnId);
    if (turn) return lifecycleTurnPayload(turn, extra);
    const opened = [...openedSessions.values()].filter((scope) => scope.sessionId === clean(sessionId));
    return {
      ...(opened.length === 1 ? opened[0] : { sessionId: clean(sessionId) }),
      ...extra,
    };
  };

  const emit = (payload) => {
    try { eventSink(payload); } catch { /* A UI listener cannot interrupt Agent Core. */ }
    for (const listener of eventSubscribers) {
      try { listener(payload); } catch { /* Secondary transports are isolated. */ }
    }
  };

  const queueFor = (sessionId, projectRoot) => {
    const key = turnKey(sessionId, projectRoot);
    let queue = pendingTurns.get(key);
    if (!queue) {
      queue = [];
      pendingTurns.set(key, queue);
    }
    return queue;
  };

  const emitQueue = (sessionId, projectRoot) => {
    const queue = pendingTurns.get(turnKey(sessionId, projectRoot)) || [];
    emit({
      type: "queue",
      sessionId,
      projectRoot: clean(projectRoot),
      items: queue.map((item, index) => ({ requestId: item.requestId, position: index + 1, kind: item.kind })),
      timestamp: new Date().toISOString(),
    });
  };

  const hasPendingTurn = ({ contactId, kind = "", scheduleSource = "" } = {}) => {
    const expectedContactId = clean(contactId);
    const expectedKind = clean(kind);
    const expectedScheduleSource = clean(scheduleSource);
    if (!expectedContactId) return false;
    const matches = (turn) => (
      clean(turn?.contactId) === expectedContactId
      && (!expectedKind || clean(turn?.kind) === expectedKind)
      && (!expectedScheduleSource || clean(turn?.scheduleSource) === expectedScheduleSource)
      && turn?.finished !== true
    );
    if ([...activeTurns.values()].some(matches)) return true;
    if ([...startingTurns.values()].some(matches)) return true;
    return [...pendingTurns.values()].some((queue) => queue.some(matches));
  };

  const removePermissionRequests = (turn) => {
    for (const [requestId, permission] of permissionRequests) {
      if (permission.turn === turn) permissionRequests.delete(requestId);
    }
  };

  // A turn can be local-only (for example, the internal planning half of a
  // proactive-contact chain) or rendered as a conversation-system entry.
  // Keep that presentation data with every event derived from the turn so
  // external transports never have to infer it from prompt text.
  const eventPresentation = (turn) => ({
    ...(turn?.displayAsSystem === true ? { displayAsSystem: true } : {}),
    ...(turn?.deliverToWechat === false ? { deliverToWechat: false } : {}),
  });

  const emitReply = (turn, type, done = false) => {
    if (!turn.text || (turn.kind === "schedule" && noReply(turn.text))) return;
    emit({
      type,
      requestId: turn.requestId,
      sessionId: turn.sessionId,
      projectRoot: turn.projectRoot,
      kind: turn.kind,
      content: turn.text,
      done,
      ...eventPresentation(turn),
      timestamp: new Date().toISOString(),
    });
  };

  const emitAgentReply = (turn) => {
    if (!turn.text || (turn.kind === "schedule" && noReply(turn.text))) return;
    emit({
      type: "agent-reply",
      requestId: turn.requestId,
      sessionId: turn.sessionId,
      projectRoot: turn.projectRoot,
      kind: turn.kind,
      content: turn.text,
      ...(clean(turn.contactId) ? { contactId: turn.contactId } : {}),
      ...eventPresentation(turn),
      timestamp: new Date().toISOString(),
    });
  };

  // This transport event is emitted after an Agent attachment is delivered.
  // The linked WeChat bridge
  // already consumes it, while the local chat continues to render the durable
  // receipt from Agent Core session history.
  const emitAgentMedia = (turn, receipt) => {
    const source = plainObject(receipt);
    const media = Array.isArray(source.media) ? source.media : [];
    if (!media.length) return;
    const key = clean(source.receiptId) || media.map((item) => `${item.kind}\u0000${item.path}\u0000${item.size}`).join("\u0001");
    if (!key || turn.agentMediaReceipts.has(key)) return;
    turn.agentMediaReceipts.add(key);
    emit({
      type: "agent-media",
      requestId: turn.requestId,
      sessionId: turn.sessionId,
      projectRoot: turn.projectRoot,
      kind: turn.kind,
      media,
      ...eventPresentation(turn),
      timestamp: new Date().toISOString(),
    });
  };

  const emitTool = (turn, { phase = "completed", toolName = "", content = "" } = {}) => {
    const text = clean(content);
    if (!text) return;
    emit({
      type: "tool",
      phase: clean(phase) || "completed",
      requestId: turn.requestId,
      sessionId: turn.sessionId,
      projectRoot: turn.projectRoot,
      kind: turn.kind,
      toolName: clean(toolName) || "Suzu 工具",
      content: text,
      ...eventPresentation(turn),
      timestamp: new Date().toISOString(),
    });
  };

  let pumpSession = () => undefined;

  const finishTurn = async (turn, { error = "", interrupted = false } = {}) => {
    if (!turn || turn.finished) return;
    turn.finished = true;
    activeTurns.delete(turn.key);
    turnsById.delete(turn.requestId);
    removePermissionRequests(turn);
    if (turn.memoryTurn) {
      try {
        if (interrupted || error || !clean(turn.text)) {
          await memoryRuntime?.abortTurn?.(turn.memoryTurn);
        } else {
          await memoryRuntime?.completeTurn?.(turn.memoryTurn, {
            assistantText: turn.text,
            occurredAt: new Date().toISOString(),
          });
        }
      } catch {
        // Local memory archival must not rewrite the model outcome.
      }
    }
    await Promise.allSettled(turn.usageTasks || []);
    if (interrupted) {
      emit({
        type: "turn-stopped",
        requestId: turn.requestId,
        sessionId: turn.sessionId,
        projectRoot: turn.projectRoot,
        kind: turn.kind,
        message: turn.interruptMessage || "已停止当前 Agent 任务。",
        ...eventPresentation(turn),
        timestamp: new Date().toISOString(),
      });
    } else if (error) {
      emit({
        type: "error",
        requestId: turn.requestId,
        sessionId: turn.sessionId,
        projectRoot: turn.projectRoot,
        kind: turn.kind,
        message: error,
        ...eventPresentation(turn),
        timestamp: new Date().toISOString(),
      });
    } else {
      emit({
        type: "turn-complete",
        requestId: turn.requestId,
        sessionId: turn.sessionId,
        projectRoot: turn.projectRoot,
        kind: turn.kind,
        ...eventPresentation(turn),
        timestamp: new Date().toISOString(),
      });
    }
    dispatchLifecycle("Stop", lifecycleTurnPayload(turn, {
      outcome: interrupted ? "cancelled" : error ? "failed" : "completed",
      ...(error ? { error: bounded(error, 4_000) } : {}),
      ...(Array.isArray(turn.contextBlocks) && turn.contextBlocks.length ? { contextBlocks: turn.contextBlocks } : {}),
      ...(Array.isArray(turn.dynamicContextBlocks) && turn.dynamicContextBlocks.length
        ? { dynamicContextBlocks: turn.dynamicContextBlocks }
        : {}),
    }));
    if (!disposed) void pumpSession(turn.sessionId, turn.projectRoot);
  };

  const requestCancellation = async (turn) => {
    if (!turn || turn.finished || turn.cancelTask || turn.state !== "running") return;
    turn.cancelTask = Promise.resolve(runtime.cancelTurn({ sessionId: turn.sessionId, turnId: turn.requestId }))
      .catch((error) => {
        if (!turn.finished) void finishTurn(turn, { error: `无法停止当前 Agent 任务：${errorMessage(error, "停止失败。")}` });
      })
      .finally(() => { turn.cancelTask = null; });
    await turn.cancelTask;
  };

  const respondLifecycleRequest = async (requestId, result) => {
    if (typeof runtime?.respondLifecycleRequest !== "function") return false;
    try {
      return await runtime.respondLifecycleRequest({ requestId, result });
    } catch {
      return false;
    }
  };

  const handleLifecycleBridge = async (event) => {
    const source = plainObject(event);
    const type = clean(source.type);
    const lifecycleEvent = clean(source.lifecycleEvent);
    const data = plainObject(source.data);
    const sessionId = clean(data.sessionId || source.sessionId);
    const coreTurn = Number.isInteger(data.coreTurn) ? data.coreTurn : null;
    const step = Number.isInteger(data.step) ? data.step : null;
    const turn = turnForRuntimeSession(sessionId, source.turnId);

    // One Agent Core child hosts both normal contact sessions and the built-in
    // product-use assistant. Its lifecycle requests must be answered by that
    // isolated service, never by a contact compactor, memory Hook, or
    // capability runtime merely because they share a process.
    if (sessionId === SUZU_SOFTWARE_ASSISTANT_SESSION_ID) return;

    if (type === "lifecycle-request") {
      const requestId = clean(source.requestId);
      if (!requestId) return;
      // This is intentionally a small configuration query rather than a
      // lifecycle Hook. The compaction module asks at the real execution
      // point, and the parent resolves only the trusted contact that owns this
      // Agent session. It also works for a manual `/compact`, which has no chat
      // turn to look up here.
      if (lifecycleEvent === "CompactionSettings") {
        let result = { available: false };
        try {
          if (typeof compactor?.settingsForRuntime === "function") {
            result = await compactor.settingsForRuntime({
              sessionId,
              projectRoot: clean(data.projectRoot),
            });
          }
        } catch {
          // A missing contact or unreadable local settings file must disable
          // automatic compaction rather than block a normal conversation.
        }
        await respondLifecycleRequest(requestId, result);
        return;
      }
      if (lifecycleEvent === "CapabilityCatalog") {
        let result = { actions: [] };
        if (turn && typeof capabilityRuntime?.availableActions === "function") {
          try {
            result = {
              actions: await capabilityRuntime.availableActions({
                contactId: turn.contactId,
                coreTurn,
                projectRoot: turn.projectRoot,
                sessionId: turn.sessionId,
                step,
                turnId: turn.requestId,
              }),
            };
          } catch {
            // The model can still continue without an optional product action.
          }
        }
        await respondLifecycleRequest(requestId, result);
        return;
      }
      if (lifecycleEvent === "CapabilityExecute") {
        let result = { status: "turn-unavailable" };
        if (turn && typeof capabilityRuntime?.invoke === "function") {
          try {
            result = await capabilityRuntime.invoke({
              action: clean(data.action),
              capabilityId: clean(data.capabilityId),
              contactId: turn.contactId,
              coreTurn,
              ...(Object.hasOwn(data, "input") ? { input: data.input } : {}),
              projectRoot: turn.projectRoot,
              sessionId: turn.sessionId,
              step,
              turnId: turn.requestId,
            });
          } catch (error) {
            result = {
              status: "failed",
              error: {
                code: clean(error?.code) || "CAPABILITY_ACTION_FAILED",
                message: errorMessage(error, "能力动作执行失败。"),
              },
            };
          }
        }
        await respondLifecycleRequest(requestId, result);
        return;
      }
      if (lifecycleEvent === "ContextCollect") {
        let result = { blocks: [] };
        if (turn) {
          try {
            const context = await agentLifecycle.collectContext(lifecycleTurnPayload(turn, { coreTurn, step }));
            turn.contextBlocks = context.blocks;
            result = { blocks: context.blocks };
          } catch (error) {
            dispatchLifecycle("ContextInjectionFailed", lifecycleTurnPayload(turn, {
              coreTurn,
              step,
              error: errorMessage(error, "上下文 Hook 失败。"),
            }));
          }
        }
        await respondLifecycleRequest(requestId, result);
        return;
      }
      if (lifecycleEvent === "DynamicContextCollect") {
        let result = { blocks: [] };
        if (turn) {
          try {
            const context = await agentLifecycle.collectDynamicContext(lifecycleTurnPayload(turn, { coreTurn, step }));
            turn.dynamicContextBlocks = context.blocks;
            result = { blocks: context.blocks };
          } catch (error) {
            dispatchLifecycle("DynamicContextInjectionFailed", lifecycleTurnPayload(turn, {
              coreTurn,
              step,
              error: errorMessage(error, "动态上下文 Hook 失败。"),
            }));
          }
        }
        await respondLifecycleRequest(requestId, result);
        return;
      }
      if (lifecycleEvent === "PreToolUse") {
        let decision = { kind: "allow" };
        if (turn) {
          try {
            const outcome = await agentLifecycle.decide("PreToolUse", lifecycleTurnPayload(turn, {
              arguments: source.data?.arguments,
              callId: clean(data.callId),
              rootCallId: clean(data.rootCallId),
              toolName: clean(data.toolName) || "Suzu 工具",
            }));
            decision = outcome.decision;
          } catch (error) {
            decision = {
              kind: "deny",
              reason: `关键 PreToolUse Hook 失败：${bounded(errorMessage(error, "未知错误。"), 1_000)}`,
            };
          }
        }
        await respondLifecycleRequest(requestId, { decision });
      }
      return;
    }

    if (type !== "lifecycle-event" || !turn) return;
    if (lifecycleEvent === "ContextInjected") {
      dispatchLifecycle("ContextInjected", lifecycleTurnPayload(turn, {
        coreTurn,
        step,
        contextBlocks: Array.isArray(data.blocks) ? data.blocks : turn.contextBlocks,
      }));
    }
    if (lifecycleEvent === "ContextInjectionFailed") {
      dispatchLifecycle("ContextInjectionFailed", lifecycleTurnPayload(turn, {
        coreTurn,
        step,
        error: bounded(clean(data.error) || "Agent Core 没有注入本轮上下文。", 4_000),
      }));
    }
    if (lifecycleEvent === "DynamicContextInjected") {
      const dynamicContextBlocks = Array.isArray(data.blocks) ? data.blocks : turn.dynamicContextBlocks;
      turn.dynamicContextBlocks = dynamicContextBlocks;
      dispatchLifecycle("DynamicContextInjected", lifecycleTurnPayload(turn, {
        coreTurn,
        step,
        dynamicContextBlocks,
      }));
    }
    if (lifecycleEvent === "DynamicContextInjectionFailed") {
      dispatchLifecycle("DynamicContextInjectionFailed", lifecycleTurnPayload(turn, {
        coreTurn,
        step,
        error: bounded(clean(data.error) || "Agent Core 没有注入本轮动态上下文。", 4_000),
      }));
    }
    if (lifecycleEvent === "DynamicContextExpired") {
      dispatchLifecycle("DynamicContextExpired", lifecycleTurnPayload(turn, {
        coreTurn,
        step,
        dynamicContextBlocks: Array.isArray(data.blocks) ? data.blocks : turn.dynamicContextBlocks,
      }));
    }
    if (lifecycleEvent === "DynamicContextCleanupFailed") {
      dispatchLifecycle("DynamicContextCleanupFailed", lifecycleTurnPayload(turn, {
        coreTurn,
        step,
        dynamicContextBlocks: Array.isArray(data.blocks) ? data.blocks : turn.dynamicContextBlocks,
        error: bounded(clean(data.error) || "Agent Core 没有从活动上下文移除本轮动态内容。", 4_000),
      }));
    }
  };

  const handleCompactionEvent = (event) => {
    const source = plainObject(event);
    const type = clean(source.type);
    const lifecycleEvent = type === "compaction-started"
      ? "PreCompact"
      : type === "compaction-completed"
        ? "PostCompact"
        : "CompactFailed";
    dispatchLifecycle(lifecycleEvent, lifecyclePayloadForRuntimeSession(source.sessionId, {
      turnId: clean(source.turnId),
      compactionId: clean(source.data?.compactionId),
      coreTurn: Number.isInteger(source.data?.coreTurn) ? source.data.coreTurn : null,
      ...(clean(source.error) ? { error: bounded(source.error, 4_000) } : {}),
    }));
  };

  const handleRuntimeEvent = (event) => {
    const source = plainObject(event);
    const type = clean(source.type);
    if (type === "lifecycle-request" || type === "lifecycle-event") {
      void handleLifecycleBridge(source);
      return;
    }
    if (["compaction-started", "compaction-completed", "compaction-failed"].includes(type)) {
      handleCompactionEvent(source);
      return;
    }
    if (type === "model-usage") {
      const usageTurn = turnsById.get(clean(source.turnId)) || null;
      const task = Promise.resolve(agentUsageLedger.record({ event: source, turn: usageTurn }))
        .catch(() => undefined);
      if (usageTurn && !usageTurn.finished) usageTurn.usageTasks.push(task);
      return;
    }
    const turn = turnsById.get(clean(source.turnId));
    if (!turn || turn.finished) return;
    if (type === "turn-started") {
      turn.state = "running";
      dispatchLifecycle("TurnStarted", lifecycleTurnPayload(turn, {
        coreTurn: Number.isInteger(source.data?.coreTurn) ? source.data.coreTurn : null,
      }));
      if (turn.cancelRequested) void requestCancellation(turn);
      return;
    }
    if (type === "assistant-reasoning-delta") {
      // Agent Core keeps reasoning separate from visible answer text. The renderer
      // only needs the phase transition (for its WeChat-style title), never
      // the reasoning content itself.
      if (turn.kind !== "schedule" && turn.outputPhase !== "thinking") {
        turn.outputPhase = "thinking";
        emit({
          type: "thinking",
          requestId: turn.requestId,
          sessionId: turn.sessionId,
          projectRoot: turn.projectRoot,
          kind: turn.kind,
          ...eventPresentation(turn),
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }
    if (type === "assistant-delta") {
      turn.outputPhase = "text";
      turn.text = bounded(`${turn.text}${String(source.text || "")}`);
      dispatchLifecycle("AssistantDelta", lifecycleTurnPayload(turn, {
        delta: bounded(String(source.text || "")),
      }));
      if (turn.kind !== "schedule") emitReply(turn, "reply-stream");
      return;
    }
    if (type === "assistant-completed") {
      turn.text = mergeFullText(turn.text, source.text);
      if (turn.text && turn.kind !== "schedule") emitReply(turn, "reply", true);
      emitAgentReply(turn);
      void finishTurn(turn);
      return;
    }
    if (type === "turn-cancelled") {
      void finishTurn(turn, { interrupted: true });
      return;
    }
    if (type === "turn-failed") {
      void finishTurn(turn, { error: clean(source.error) || "Agent Core 没有完成这次回复。" });
      return;
    }
    if (type === "runtime-unavailable") {
      void finishTurn(turn, { error: clean(source.error) || "Agent Core 暂时不可用。" });
      return;
    }
    if (type === "tool-started") {
      turn.toolNames.add(clean(source.toolName) || "Suzu 工具");
      dispatchLifecycle("ToolStarted", lifecycleTurnPayload(turn, {
        callId: clean(source.data?.callId),
        toolName: clean(source.toolName) || "Suzu 工具",
      }));
      const preview = toolPreview(source.data);
      const toolName = clean(source.toolName) || "工具";
      emitTool(turn, {
        phase: "started",
        toolName,
        content: `工具调用：${toolName}${preview ? `\n${preview}` : ""}`,
      });
      return;
    }
    if (type === "tool-completed" || type === "tool-failed") {
      if (type === "tool-completed" && clean(source.toolName) === SUZU_CAPABILITY_TOOL) {
        emitAgentMedia(turn, agentMediaReceipt(source.data?.result));
      }
      dispatchLifecycle(type === "tool-failed" ? "PostToolUseFailure" : "PostToolUse", lifecycleTurnPayload(turn, {
        callId: clean(source.data?.callId),
        toolName: clean(source.toolName) || "Suzu 工具",
        status: type === "tool-failed" ? "failed" : "completed",
        ...(source.data?.result !== undefined ? { result: source.data.result } : {}),
        ...(clean(source.error) ? { error: bounded(source.error, 4_000) } : {}),
      }));
      const result = source.data?.result;
      const suffix = result === undefined || result === "" ? "" : `\n${bounded(typeof result === "string" ? result : JSON.stringify(result, null, 2), 4_000)}`;
      const toolName = clean(source.toolName) || "工具";
      emitTool(turn, {
        phase: type === "tool-failed" ? "failed" : "completed",
        toolName,
        content: `工具结果${type === "tool-failed" ? "（错误）" : ""}：${toolName}${suffix}`,
      });
      return;
    }
    if (type === "tool-approval-requested") {
      const approvalId = clean(source.approvalId);
      if (!approvalId) return;
      const requestId = `${turn.requestId}:approval:${approvalId}`;
      permissionRequests.set(requestId, { approvalId, requestId, turn, toolName: clean(source.toolName) || "Suzu 工具" });
      dispatchLifecycle("PermissionRequest", lifecycleTurnPayload(turn, {
        approvalId,
        callId: clean(source.data?.callId),
        reason: bounded(clean(source.data?.reason) || "Agent Core 请求使用工具。", 4_000),
        toolName: clean(source.toolName) || "Suzu 工具",
      }));
      emit({
        type: "permission",
        requestId,
        sessionId: turn.sessionId,
        projectRoot: turn.projectRoot,
        kind: turn.kind,
        toolName: clean(source.toolName) || "Suzu 工具",
        preview: bounded(clean(source.data?.reason) || "Agent Core 请求使用工具。", 4_000),
        ...eventPresentation(turn),
        timestamp: new Date().toISOString(),
      });
      return;
    }
    if (type === "tool-approval-resolved") {
      const approvalId = clean(source.approvalId);
      const requestId = `${turn.requestId}:approval:${approvalId}`;
      const permission = permissionRequests.get(requestId);
      if (!permission) return;
      permissionRequests.delete(requestId);
      dispatchLifecycle("PermissionResolved", lifecycleTurnPayload(turn, {
        approvalId,
        behavior: clean(source.data?.decision) || "resolved",
        toolName: clean(source.toolName) || permission?.toolName || "Suzu 工具",
      }));
    }
  };

  const unsubscribeRuntime = runtime.subscribe(handleRuntimeEvent);

  const resolveSession = async ({ sessionId, projectRoot, hasTranscript } = {}) => {
    const id = clean(sessionId);
    const root = clean(projectRoot);
    if (!id && !root) return reader.ensureActiveSession();
    if (!id || !root) throw new ConversationChatError("指定 Agent 会话时必须同时提供会话标识和工作目录。", { code: "INVALID_SESSION_SCOPE" });
    return { id, projectRoot: root, hasTranscript: hasTranscript === true };
  };

  const prepareMemoryTurn = async (request) => {
    if (![
      "message",
      "call",
      "call-open",
      "mail-feedback",
    ].includes(request.kind) || !clean(request.memoryText) || typeof memoryRuntime?.prepareTurn !== "function") return null;
    try {
      return await memoryRuntime.prepareTurn({
        occurredAt: request.memoryOccurredAt,
        projectRoot: request.projectRoot,
        sessionId: request.sessionId,
        turnId: request.requestId,
        userText: request.memoryText,
      });
    } catch {
      return null;
    }
  };

  const startTurn = async (request) => {
    if (disposed) return;
    let projectStat;
    try { projectStat = await fsOps.stat(request.projectRoot); }
    catch { throw new ConversationChatError("当前 Agent 工作目录不存在或无法读取。", { code: "WORKSPACE_MISSING" }); }
    if (!isDirectory(projectStat)) throw new ConversationChatError("当前 Agent 工作目录不是文件夹。", { code: "WORKSPACE_INVALID" });

    const lifecycleBase = {
      ...lifecycleScope(request),
      userText: bounded(request.memoryText || request.content, MAX_MESSAGE_LENGTH),
    };
    // The instruction bridge is a critical TurnStarting Hook. Context is not
    // collected here: Agent Core asks at every real `agent/pre-step`, where the
    // lifecycle bridge can actually inject the returned blocks into the model.
    await agentLifecycle.dispatch("TurnStarting", lifecycleBase);

    const memoryTurn = await prepareMemoryTurn(request);
    if (disposed) {
      try { await memoryRuntime?.abortTurn?.(memoryTurn); } catch { /* No running conversation remains. */ }
      return;
    }
    const turn = {
      agentMediaReceipts: new Set(),
      cancelRequested: false,
      cancelTask: null,
      contactId: clean(request.contactId),
      finished: false,
      interruptMessage: "",
      kind: request.kind,
      key: request.key,
      memoryTurn,
      projectRoot: request.projectRoot,
      requestId: request.requestId,
      scheduleSource: clean(request.scheduleSource),
      sessionId: request.sessionId,
      displayAsSystem: request.displayAsSystem === true,
      deliverToWechat: request.deliverToWechat !== false,
      state: "starting",
      text: "",
      toolNames: new Set(),
      usageTasks: [],
      userText: lifecycleBase.userText,
      contextBlocks: [],
      dynamicContextBlocks: [],
    };
    activeTurns.set(turn.key, turn);
    turnsById.set(turn.requestId, turn);
    emit({
      type: "turn-start",
      requestId: turn.requestId,
      sessionId: turn.sessionId,
      projectRoot: turn.projectRoot,
      kind: turn.kind,
      ...eventPresentation(turn),
      timestamp: new Date().toISOString(),
    });
    try {
      await runtime.ensureSession({
        sessionId: turn.sessionId,
        contactId: turn.contactId,
        cwd: turn.projectRoot,
      });
      if (turn.contactId && !activatedContacts.has(turn.key)) {
        activatedContacts.add(turn.key);
        dispatchLifecycle("ContactActivated", lifecycleScope(turn));
      }
      if (!openedSessions.has(turn.key)) {
        const opened = lifecycleScope(turn);
        openedSessions.set(turn.key, opened);
        dispatchLifecycle("SessionStart", { ...opened, source: "product-open" });
      }
      if (turn.cancelRequested) {
        await finishTurn(turn, { interrupted: true });
        return;
      }
      await runtime.sendTurn({
        sessionId: turn.sessionId,
        turnId: turn.requestId,
        input: request.input || inputForAgent({ kind: turn.kind, text: request.content, callDirection: request.callDirection }),
        placement: "queue",
      });
      turn.state = "submitted";
    } catch (error) {
      await finishTurn(turn, { error: `无法发送给 Suzu Agent Core：${errorMessage(error, "未知错误。")}` });
    }
  };

  pumpSession = async (sessionId, projectRoot, { propagateStartError = false } = {}) => {
    const key = turnKey(sessionId, projectRoot);
    if (disposed || activeTurns.has(key) || startingSessions.has(key)) return;
    const queue = pendingTurns.get(key);
    if (!queue?.length) return;
    const request = queue.shift();
    if (!queue.length) pendingTurns.delete(key);
    emitQueue(sessionId, projectRoot);
    startingSessions.add(key);
    startingTurns.set(key, request);
    try {
      await startTurn(request);
    } catch (error) {
      if (propagateStartError) throw error;
      emit({
        type: "error",
        requestId: request.requestId,
        sessionId: request.sessionId,
        projectRoot: request.projectRoot,
        kind: request.kind,
        message: errorMessage(error, "无法启动 Suzu Agent Core。"),
        ...eventPresentation(request),
        timestamp: new Date().toISOString(),
      });
    } finally {
      startingSessions.delete(key);
      if (startingTurns.get(key) === request) startingTurns.delete(key);
      if (!disposed && !activeTurns.has(key)) void pumpSession(sessionId, projectRoot);
    }
  };

  const enqueue = async ({
    content,
    contactId = "",
    kind = "message",
    callDirection = "",
    media = [],
    mediaSource = "",
    memoryText = "",
    requestId = "",
    scheduleSource = "",
    displayAsSystem = false,
    deliverToWechat = false,
    requestQueue = false,
    session: requestedSession = null,
  } = {}) => {
    if (disposed) throw new ConversationChatError("Agent 聊天服务已经停止。", { code: "SERVICE_STOPPED" });
    const suppliedMedia = Array.isArray(media) ? media : [];
    const voiceCallOpening = kind === "call-open";
    const text = clean(content);
    if (!text && !voiceCallOpening && !suppliedMedia.length) throw new ConversationChatError("消息不能为空。", { code: "EMPTY_MESSAGE" });
    if (text.length > MAX_MESSAGE_LENGTH) {
      throw new ConversationChatError(`消息不能超过 ${MAX_MESSAGE_LENGTH.toLocaleString("zh-CN")} 个字符。`, { code: "MESSAGE_TOO_LONG" });
    }
    const session = await resolveSession(requestedSession || {});
    if (!session?.id || !session.projectRoot) throw new ConversationChatError("请先选择 Agent 工作目录。", { code: "SESSION_REQUIRED" });
    let resolvedContactId = clean(contactId);
    if (!resolvedContactId && typeof reader.contactIdForSession === "function") {
      try { resolvedContactId = clean(await reader.contactIdForSession({ sessionId: session.id, projectRoot: session.projectRoot })); } catch { /* Optional relation lookup. */ }
    }
    const queue = queueFor(session.id, session.projectRoot);
    if (queue.length >= MAX_QUEUED_TURNS) {
      throw new ConversationChatError(`当前会话最多只能排队 ${MAX_QUEUED_TURNS} 条消息，请等待部分任务完成后再发送。`, { code: "QUEUE_FULL" });
    }
    let preparedInput = inputForAgent({ kind, text, callDirection });
    let preparedMedia = [];
    let preparedMemoryText = "";
    if (suppliedMedia.length) {
      if (typeof attachmentService?.prepare !== "function") {
        throw new ConversationChatError("图片和文件附件服务尚未就绪。", { code: "ATTACHMENT_SERVICE_REQUIRED" });
      }
      try {
        const prepared = await attachmentService.prepare({
          content: preparedInput,
          media: suppliedMedia,
          mediaSource,
          projectRoot: session.projectRoot,
          sessionId: session.id,
        });
        preparedInput = prepared?.input;
        preparedMedia = Array.isArray(prepared?.media) ? prepared.media : [];
        preparedMemoryText = clean(prepared?.memoryText);
      } catch (error) {
        throw new ConversationChatError(errorMessage(error, "无法准备会话附件。"), {
          cause: error,
          code: clean(error?.code) || "ATTACHMENT_PREPARE_FAILED",
        });
      }
    }
    const request = {
      callDirection: clean(callDirection),
      contactId: resolvedContactId,
      content: text,
      input: preparedInput,
      media: preparedMedia,
      mediaSource: clean(mediaSource),
      displayAsSystem: displayAsSystem === true,
      deliverToWechat: deliverToWechat === true,
      key: turnKey(session.id, session.projectRoot),
      kind,
      memoryOccurredAt: new Date().toISOString(),
      memoryText: clean(memoryText) || preparedMemoryText || text,
      projectRoot: session.projectRoot,
      requestId: clean(requestId) || `suzu-${randomUUID()}`,
      scheduleSource: clean(scheduleSource),
      sessionId: session.id,
    };
    const queued = activeTurns.has(request.key) || startingSessions.has(request.key) || queue.length > 0;
    const queuePosition = queue.length + 1;
    const lifecyclePayload = {
      ...lifecycleScope(request),
      userText: bounded(request.memoryText || request.content, MAX_MESSAGE_LENGTH),
    };
    try {
      await agentLifecycle.dispatch("UserPromptSubmit", lifecyclePayload);
      await agentLifecycle.dispatch("TurnQueued", {
        ...lifecyclePayload,
        queuePosition,
        queued,
      });
    } catch (error) {
      if (!queue.length) pendingTurns.delete(request.key);
      throw error;
    }
    // 默认插队：普通消息到来时打断当前回复，并放到队首优先处理；
    // 请求排队（/suzu queue）或计划任务、引导消息则追加到队尾等待。
    const shouldInterrupt = !requestQueue && ["message", "call", "call-open"].includes(kind);
    const active = activeTurns.get(request.key);
    if (shouldInterrupt && active && !active.finished && active.state === "running") {
      active.cancelRequested = true;
      active.interruptMessage = "已收到新消息，停止当前回复。";
      dispatchLifecycle("StopRequested", lifecycleTurnPayload(active, { reason: "user" }));
      void requestCancellation(active);
      queue.unshift(request);
    } else {
      queue.push(request);
    }
    emitQueue(session.id, session.projectRoot);
    const pumping = pumpSession(session.id, session.projectRoot, { propagateStartError: !queued });
    if (!queued) await pumping;
    return {
      accepted: true,
      queued,
      queuePosition,
      requestId: request.requestId,
      sessionId: request.sessionId,
      media: request.media,
    };
  };

  const send = ({ content, media = [], mediaSource = "", memoryText = "", queued = false } = {}) => (
    enqueue({ content, media, mediaSource, memoryText, deliverToWechat: false, requestQueue: queued })
  );
  const sendToSession = ({ content, contactId = "", sessionId, projectRoot, hasTranscript = false, kind = "message", callDirection = "", media = [], mediaSource = "", memoryText = "", requestId = "", scheduleSource = "", displayAsSystem = false, deliverToWechat = true, queued = false } = {}) => (
    enqueue({ content, contactId, kind, callDirection, media, mediaSource, memoryText, requestId, scheduleSource, displayAsSystem, deliverToWechat, requestQueue: queued, session: { sessionId, projectRoot, hasTranscript } })
  );

  const stop = async ({ sessionId, projectRoot, requestId } = {}) => {
    const id = clean(sessionId);
    if (!id) throw new ConversationChatError("缺少要停止的 Agent 会话标识。", { code: "SESSION_REQUIRED" });
    const root = clean(projectRoot);
    const requestedRequestId = clean(requestId);
    const matches = root
      ? [activeTurns.get(turnKey(id, root))].filter(Boolean)
      : [...activeTurns.values()].filter((item) => item.sessionId === id);
    if (matches.length > 1) throw new ConversationChatError("同名 Agent 会话正在多个工作目录中运行，请从对应会话里停止。", { code: "SESSION_AMBIGUOUS" });
    const turn = requestedRequestId ? matches.find((item) => item.requestId === requestedRequestId) : matches[0];
    if (requestedRequestId && !turn) {
      const queues = root
        ? [pendingTurns.get(turnKey(id, root))].filter(Boolean)
        : [...pendingTurns.values()].filter((queue) => queue.some((item) => item.sessionId === id));
      for (const queue of queues) {
        const index = queue.findIndex((item) => item.requestId === requestedRequestId);
        if (index < 0) continue;
        const [queued] = queue.splice(index, 1);
        if (!queue.length) pendingTurns.delete(queued.key);
        dispatchLifecycle("StopRequested", {
          ...lifecycleScope(queued),
          userText: bounded(queued.memoryText || queued.content, MAX_MESSAGE_LENGTH),
          reason: "removed-from-queue",
        });
        emitQueue(queued.sessionId, queued.projectRoot);
        emit({
          type: "turn-stopped",
          requestId: queued.requestId,
          sessionId: queued.sessionId,
          projectRoot: queued.projectRoot,
          kind: queued.kind,
          message: "已从 Agent 队列中移除这次回复。",
          timestamp: new Date().toISOString(),
        });
        return { accepted: true, stopped: true, sessionId: id, message: "已从队列中移除这次回复。" };
      }
    }
    if (!turn) {
      return {
        accepted: true,
        stopped: false,
        sessionId: id,
        message: requestedRequestId ? "这条回复已经结束或不在当前会话中。" : "当前会话没有正在执行的 Agent 任务。",
      };
    }
    turn.cancelRequested = true;
    turn.interruptMessage = "已停止当前 Agent 任务。";
    dispatchLifecycle("StopRequested", lifecycleTurnPayload(turn, { reason: "user" }));
    if (turn.state === "running") void requestCancellation(turn);
    return { accepted: true, stopped: true, sessionId: id, message: "正在停止当前 Agent 任务。" };
  };

  const steer = async ({ content, sessionId, projectRoot, hasTranscript = false } = {}) => {
    if (disposed) throw new ConversationChatError("Agent 聊天服务已经停止。", { code: "SERVICE_STOPPED" });
    const text = clean(content);
    if (!text) throw new ConversationChatError("消息不能为空。", { code: "EMPTY_MESSAGE" });
    const session = await resolveSession({ sessionId, projectRoot, hasTranscript });
    const active = activeTurns.get(turnKey(session.id, session.projectRoot));
    const request = await enqueue({ content: text, kind: "steer", session });
    return {
      ...request,
      delivered: false,
      message: active && !active.finished
        ? "Agent Core 的中途引导尚未接入；已排在当前回复之后。"
        : "当前没有运行中的任务，已作为一条新消息发送。",
    };
  };

  const respondPermission = async ({ requestId, behavior } = {}) => {
    const id = clean(requestId);
    const permission = permissionRequests.get(id);
    if (!permission || permission.turn.finished) throw new ConversationChatError("这条 Agent 权限请求已经失效。", { code: "APPROVAL_EXPIRED" });
    if (!new Set(["allow", "deny"]).has(clean(behavior))) throw new ConversationChatError("权限选择无效。", { code: "INVALID_APPROVAL" });
    const allow = behavior === "allow";
    const result = await runtime.resolveApproval({
      sessionId: permission.turn.sessionId,
      approvalId: permission.approvalId,
      decision: allow ? "allowed-once" : "rejected",
    });
    if (result?.accepted !== true) throw new ConversationChatError("这条 Agent 权限请求已经失效。", { code: "APPROVAL_EXPIRED" });
    permissionRequests.delete(id);
    dispatchLifecycle("PermissionResolved", lifecycleTurnPayload(permission.turn, {
      approvalId: permission.approvalId,
      behavior: allow ? "allow" : "deny",
      toolName: permission.toolName,
    }));
    emit({
      type: "permission-resolved",
      requestId: id,
      sessionId: permission.turn.sessionId,
      projectRoot: permission.turn.projectRoot,
      behavior: allow ? "allow" : "deny",
      toolName: permission.toolName,
      timestamp: new Date().toISOString(),
    });
    return { accepted: true, requestId: id, behavior: allow ? "allow" : "deny", toolName: permission.toolName };
  };

  const respondPermissionForSession = async ({ sessionId, projectRoot, behavior } = {}) => {
    const key = turnKey(sessionId, projectRoot);
    const pending = [...permissionRequests.values()].filter((permission) => permission.turn.key === key && !permission.turn.finished);
    if (!pending.length) return { accepted: false, reason: "no-pending-permission" };
    if (pending.length > 1) return { accepted: false, reason: "multiple-pending-permissions" };
    return respondPermission({ requestId: pending[0].requestId, behavior });
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try { unsubscribeRuntime?.(); } catch { /* Runtime cleanup continues below. */ }
    pendingTurns.clear();
    startingSessions.clear();
    startingTurns.clear();
    for (const turn of activeTurns.values()) {
      turn.finished = true;
      try {
        const aborting = memoryRuntime?.abortTurn?.(turn.memoryTurn);
        void Promise.resolve(aborting).catch(() => undefined);
      } catch { /* The owned runtime still needs closing. */ }
    }
    activeTurns.clear();
    turnsById.clear();
    permissionRequests.clear();
    for (const opened of openedSessions.values()) dispatchLifecycle("SessionEnd", { ...opened, reason: "service-disposed" });
    openedSessions.clear();
    activatedContacts.clear();
    if (ownsLifecycle) agentLifecycle.close();
    void Promise.resolve(runtime.close()).catch(() => undefined);
  };

  return Object.freeze({
    dispose,
    hasPendingTurn,
    respondPermission,
    respondPermissionForSession,
    send,
    sendToSession,
    setEventSink: (callback) => { eventSink = typeof callback === "function" ? callback : () => {}; },
    subscribe: (callback) => {
      if (typeof callback !== "function") return () => {};
      eventSubscribers.add(callback);
      return () => eventSubscribers.delete(callback);
    },
    steer,
    stop,
  });
}
