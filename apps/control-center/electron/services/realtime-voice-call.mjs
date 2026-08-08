import { randomUUID } from "node:crypto";

import WebSocket from "ws";

import { resolveDirectVoiceRuntime, synthesizeDirectVoiceAudio } from "@suzu-lives/voice-message/direct-voice-message";

const DEFAULT_ASR_MODEL = "qwen3-asr-flash-realtime";
const MAX_AUDIO_CHUNK_BYTES = 48 * 1024;
const MAX_TRANSCRIPT_LENGTH = 4_000;
const CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_DELAYS_MS = Object.freeze([500, 1_200, 2_500]);

function clean(value) {
  return String(value ?? "").trim();
}

function bounded(value, maximum) {
  return String(value ?? "").slice(0, maximum);
}

function sameProjectRoot(left, right) {
  const normalize = (value) => clean(value).replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
  const first = normalize(left);
  const second = normalize(right);
  return Boolean(first && second && first === second);
}

function audioBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.alloc(0);
}

function audioMime(format) {
  const normalized = clean(format).toLowerCase();
  if (normalized === "wav") return "audio/wav";
  if (normalized === "ogg") return "audio/ogg";
  return "audio/mpeg";
}

function ttsErrorMessage(error) {
  const message = clean(error?.message || error);
  return message || "语音合成暂时不可用。";
}

/**
 * DashScope accepts the generic public endpoint as well as a workspace-hosted
 * endpoint.  Deriving the host from the already configured DashScope URL keeps
 * voice calls on the same regional endpoint as the rest of Suzu.
 */
export function realtimeAsrWebSocketUrl(baseUrl = "", model = DEFAULT_ASR_MODEL) {
  let parsed = null;
  try { parsed = new URL(clean(baseUrl)); } catch { /* Use the public China endpoint below. */ }
  const protocol = parsed?.protocol === "http:" ? "ws:" : "wss:";
  const host = parsed?.host || "dashscope.aliyuncs.com";
  return `${protocol}//${host}/api-ws/v1/realtime?model=${encodeURIComponent(clean(model) || DEFAULT_ASR_MODEL)}&heartbeat=true`;
}

/**
 * Keeps synthesis ahead of playback without speaking partial words.  Unlike
 * AIRI's example we do not place <break/> in the saved Claude reply: Suzu
 * derives naturally speakable clauses from streamed punctuation instead.
 */
export function takeCallSpeechSegments(value, { flush = false } = {}) {
  let remaining = String(value ?? "").replace(/<break\s*\/?>/giu, " ");
  const segments = [];
  const punctuated = /[。！？!?；;…]+(?:[”’）】》〉]*\s*)/u;
  while (remaining) {
    const match = punctuated.exec(remaining);
    if (!match) break;
    const end = (match.index || 0) + match[0].length;
    const candidate = remaining.slice(0, end).trim();
    remaining = remaining.slice(end);
    if (candidate) segments.push(candidate);
  }
  // A very long clause sounds slower than one short pause.  Split only after
  // enough text has arrived, and prefer a natural comma boundary.
  if (!flush && remaining.length >= 96) {
    const soft = [...remaining.matchAll(/[，、,]/gu)].find((match) => (match.index || 0) >= 24);
    const end = soft ? (soft.index || 0) + soft[0].length : 80;
    const candidate = remaining.slice(0, end).trim();
    if (candidate) segments.push(candidate);
    remaining = remaining.slice(end);
  }
  if (flush && clean(remaining)) {
    segments.push(clean(remaining));
    remaining = "";
  }
  return { remaining, segments };
}

export class RealtimeVoiceCallError extends Error {
  constructor(message) {
    super(message);
    this.name = "RealtimeVoiceCallError";
  }
}

export function createRealtimeVoiceCallService({
  chat,
  connectionsService,
  dataRootProvider = null,
  fetchImpl = globalThis.fetch,
  ledgerPathProvider = null,
  onEvent = () => {},
  reader,
  resolveVoiceRuntime = resolveDirectVoiceRuntime,
  reconnectDelaysMs = DEFAULT_RECONNECT_DELAYS_MS,
  settingsService,
  synthesizeVoice = synthesizeDirectVoiceAudio,
  webSocketFactory = (url, options) => new WebSocket(url, options),
} = {}) {
  if (!chat?.sendToSession || !chat?.subscribe || !chat?.stop) {
    throw new RealtimeVoiceCallError("实时通话需要可持续的 Suzu 对话服务。");
  }
  if (!reader?.ensureActiveSession || !reader?.snapshot) {
    throw new RealtimeVoiceCallError("实时通话需要当前联系人的会话信息。");
  }
  if (!connectionsService?.resolveDashScope) {
    throw new RealtimeVoiceCallError("实时通话需要百炼连接服务。");
  }
  if (!settingsService?.load) {
    throw new RealtimeVoiceCallError("实时通话需要软件设置服务。");
  }

  let activeCall = null;
  let disposed = false;
  const emit = typeof onEvent === "function" ? onEvent : () => {};
  const reconnectDelays = (Array.isArray(reconnectDelaysMs) ? reconnectDelaysMs : DEFAULT_RECONNECT_DELAYS_MS)
    .map((value) => Math.max(0, Number(value) || 0))
    .filter((value) => Number.isFinite(value));

  const emitCall = (call, type, payload = {}) => {
    try {
      emit({
        type,
        callId: call.id,
        sessionId: call.session.id,
        projectRoot: call.session.projectRoot,
        timestamp: new Date().toISOString(),
        ...payload,
      });
    } catch { /* A renderer must not disturb a local call. */ }
  };

  // Audio capture can deliver one final frame after the renderer has hung up.
  // Treat that frame as inactive instead of dereferencing a cleared call.
  const callIsActive = (call) => Boolean(call) && activeCall === call && !call.closed && !disposed;

  const clearReplyAudio = (call) => {
    call.generation += 1;
    call.nextAudioIndex = 0;
    for (const controller of call.ttsControllers.values()) controller.abort();
    call.ttsControllers.clear();
    call.replyStates.clear();
    call.requestIds.clear();
    emitCall(call, "call-clear-audio", {});
  };

  const stopCallTurns = async (call, requestIds = [...call.requestIds]) => {
    const ids = [...requestIds];
    await Promise.allSettled(ids.map((requestId) => chat.stop({
      sessionId: call.session.id,
      projectRoot: call.session.projectRoot,
      requestId,
    })));
  };

  const interruptResponse = async (call, { announce = false } = {}) => {
    if (!callIsActive(call)) return;
    const requestIds = [...call.requestIds];
    clearReplyAudio(call);
    if (requestIds.length) {
      await Promise.allSettled(requestIds.map((requestId) => chat.stop({
        sessionId: call.session.id,
        projectRoot: call.session.projectRoot,
        requestId,
      })));
    }
    if (announce) emitCall(call, "call-state", { state: "listening", label: "正在听你说…" });
  };

  const queueSpeech = (call, requestId, text) => {
    const spoken = clean(text);
    if (!spoken || !callIsActive(call)) return;
    const generation = call.generation;
    const index = call.nextAudioIndex++;
    const key = `${generation}:${index}`;
    const controller = new AbortController();
    call.ttsControllers.set(key, controller);
    void synthesizeVoice({
      text: spoken,
      runtime: call.voiceRuntime,
      fetchImpl,
      ledgerPath: call.ledgerPath,
      agentId: call.agentId,
      feature: "realtime-voice-call-tts",
      abortSignal: controller.signal,
    }).then((result) => {
      if (!callIsActive(call) || generation !== call.generation || controller.signal.aborted) return;
      const audio = Buffer.from(result.audio || []);
      if (!audio.length) throw new RealtimeVoiceCallError("语音合成返回了空音频。");
      emitCall(call, "call-audio", {
        index,
        requestId,
        text: spoken,
        mimeType: audioMime(result.format),
        audioBase64: audio.toString("base64"),
      });
      emitCall(call, "call-state", { state: "speaking", label: "正在说话…" });
    }).catch((error) => {
      if (!callIsActive(call) || generation !== call.generation || controller.signal.aborted || error?.code === "tts_aborted") return;
      emitCall(call, "call-error", { message: `无法合成这句语音：${ttsErrorMessage(error)}` });
      // Keep later clauses playable if this one provider request failed.  The
      // renderer preserves order, so it needs an explicit gap marker here.
      emitCall(call, "call-audio-skip", { index, requestId });
    }).finally(() => {
      call.ttsControllers.delete(key);
    });
  };

  const receiveChatEvent = (event) => {
    const call = activeCall;
    if (!callIsActive(call) || event?.kind !== "call") return;
    if (clean(event.sessionId) !== call.session.id || !sameProjectRoot(event.projectRoot, call.session.projectRoot)) return;
    const requestId = clean(event.requestId);
    const reply = call.replyStates.get(requestId);
    if (!reply) return;
    if (event.type === "error") {
      call.replyStates.delete(requestId);
      call.requestIds.delete(requestId);
      emitCall(call, "call-error", { message: `通话回复失败：${clean(event.message) || "未知错误"}` });
      return;
    }
    if (event.type === "turn-stopped") {
      call.replyStates.delete(requestId);
      call.requestIds.delete(requestId);
      return;
    }
    if (event.type !== "reply-stream" && event.type !== "reply") return;
    const content = bounded(event.content, 200_000);
    if (!content) return;
    let delta = content;
    if (content.startsWith(reply.fullText)) delta = content.slice(reply.fullText.length);
    else if (reply.fullText.startsWith(content)) return;
    reply.fullText = content;
    const parsed = takeCallSpeechSegments(`${reply.remaining}${delta}`, { flush: event.type === "reply" || event.done === true });
    reply.remaining = parsed.remaining;
    for (const sentence of parsed.segments) queueSpeech(call, requestId, sentence);
    if (event.type === "reply" || event.done === true) {
      call.replyStates.delete(requestId);
      call.requestIds.delete(requestId);
    }
  };

  const unsubscribeChat = chat.subscribe(receiveChatEvent);

  const sendTranscript = async (call, transcript) => {
    const text = bounded(clean(transcript), MAX_TRANSCRIPT_LENGTH);
    if (!text || !callIsActive(call)) return;
    // The ASR speech-start event normally performs this cancellation first.
    // Repeat it defensively in case a provider only emits a final transcript.
    if (call.requestIds.size || call.replyStates.size || call.ttsControllers.size) {
      await interruptResponse(call);
      if (!callIsActive(call)) return;
    }
    const generation = call.generation;
    // Register the request before starting Claude.  Claude can emit its first
    // streamed token immediately after the child process starts, before the
    // async enqueue call resolves.
    const requestId = `suzu-call-${randomUUID()}`;
    call.requestIds.add(requestId);
    call.replyStates.set(requestId, { fullText: "", remaining: "" });
    emitCall(call, "call-transcript", { text, final: true });
    emitCall(call, "call-state", { state: "thinking", label: "正在想怎么回答…" });
    try {
      const result = await chat.sendToSession({
        content: text,
        sessionId: call.session.id,
        projectRoot: call.session.projectRoot,
        hasTranscript: call.session.hasTranscript,
        kind: "call",
        requestId,
      });
      if (!callIsActive(call) || generation !== call.generation) {
        await chat.stop({ sessionId: call.session.id, projectRoot: call.session.projectRoot, requestId }).catch(() => undefined);
        return;
      }
      if (clean(result?.requestId) !== requestId) throw new RealtimeVoiceCallError("Suzu 没有建立本次通话回复。");
    } catch (error) {
      call.replyStates.delete(requestId);
      call.requestIds.delete(requestId);
      if (!callIsActive(call) || generation !== call.generation) return;
      emitCall(call, "call-error", { message: `无法开始回复：${ttsErrorMessage(error)}` });
    }
  };

  const handleAsrMessage = (call, raw) => {
    if (!callIsActive(call)) return;
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    const type = clean(message?.type);
    if (type === "input_audio_buffer.speech_started") {
      void interruptResponse(call, { announce: true });
      return;
    }
    if (["conversation.item.input_audio_transcription.text", "conversation.item.input_audio_transcription.delta"].includes(type)) {
      const text = bounded(clean(`${message.text || message.delta || ""}${message.stash || ""}` || message.transcript), MAX_TRANSCRIPT_LENGTH);
      if (text) emitCall(call, "call-transcript", { text, final: false });
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const text = bounded(clean(message.transcript || message.text), MAX_TRANSCRIPT_LENGTH);
      if (text) void sendTranscript(call, text);
      return;
    }
    if (type === "error") {
      const detail = clean(message.error?.message || message.message || message.error?.code);
      emitCall(call, "call-error", { message: `语音识别连接出错：${detail || "未知错误"}` });
      return;
    }
    if (type === "conversation.item.input_audio_transcription.failed") {
      const detail = clean(message.error?.message || message.error?.code || message.message);
      emitCall(call, "call-error", { message: `语音识别失败：${detail || "未知错误"}` });
      return;
    }
    if (type === "session.finished") {
      try { call.socket?.close?.(); } catch { /* The session is already done. */ }
    }
  };

  const scheduleAsrReconnect = (call, reason = "") => {
    if (!callIsActive(call) || call.closing || !call.started || call.reconnectTimer) return;
    const attempt = Number(call.reconnectAttempts) || 0;
    if (attempt >= reconnectDelays.length) {
      emitCall(call, "call-error", { message: `语音识别连接已断开${reason ? `：${reason}` : ""}。请挂断后重新拨打。` });
      return;
    }
    const delay = reconnectDelays[attempt];
    call.reconnectAttempts = attempt + 1;
    call.asrReady = false;
    emitCall(call, "call-state", { state: "connecting", label: "语音识别连接中断，正在恢复…" });
    try { call.socket?.close?.(); } catch { /* A broken socket may already be gone. */ }
    call.reconnectTimer = setTimeout(async () => {
      call.reconnectTimer = null;
      if (!callIsActive(call) || call.closing) return;
      try {
        await connectAsr(call);
        call.reconnectAttempts = 0;
      } catch (error) {
        scheduleAsrReconnect(call, ttsErrorMessage(error));
      }
    }, delay);
  };

  const connectAsr = (call) => new Promise((resolve, reject) => {
    let settled = false;
    let timeout = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      callback(value);
    };
    let socket;
    try {
      socket = webSocketFactory(call.asrUrl, {
        headers: {
          Authorization: `Bearer ${call.asrApiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });
    } catch (error) {
      reject(new RealtimeVoiceCallError(`无法连接语音识别服务：${ttsErrorMessage(error)}`));
      return;
    }
    call.socket = socket;
    timeout = setTimeout(() => {
      try { socket.close?.(); } catch { /* Best effort while connecting. */ }
      finish(reject, new RealtimeVoiceCallError("语音识别连接超时。"));
    }, CONNECT_TIMEOUT_MS);
    socket.on("open", () => {
      if (!callIsActive(call)) {
        try { socket.close?.(); } catch { /* A hung-up call has no socket. */ }
        return;
      }
      try {
        // The renderer already has a lightweight speech/silence detector.  Let
        // it commit each utterance explicitly: a noisy microphone can otherwise
        // keep server VAD open forever and never produce a final transcript.
        call.hasBufferedAudio = false;
        socket.send(JSON.stringify({
          event_id: `session-${randomUUID()}`,
          type: "session.update",
          session: {
            modalities: ["text"],
            input_audio_format: "pcm",
            sample_rate: 16000,
            input_audio_transcription: { language: "zh" },
            turn_detection: null,
          },
        }));
        call.asrReady = true;
        emitCall(call, "call-state", { state: "listening", label: "正在听你说…" });
        finish(resolve, undefined);
      } catch (error) {
        finish(reject, new RealtimeVoiceCallError(`无法启动语音识别：${ttsErrorMessage(error)}`));
      }
    });
    socket.on("message", (value) => handleAsrMessage(call, value));
    socket.on("error", (error) => {
      if (!settled) {
        finish(reject, new RealtimeVoiceCallError(`语音识别连接失败：${ttsErrorMessage(error)}`));
        return;
      }
      if (callIsActive(call) && call.started) scheduleAsrReconnect(call, ttsErrorMessage(error));
    });
    socket.on("close", (code, reason) => {
      if (!settled) {
        finish(reject, new RealtimeVoiceCallError(`语音识别连接已关闭（${code || "未知"}）：${clean(reason) || "未建立通话"}`));
        return;
      }
      if (callIsActive(call) && !call.closing && call.started) scheduleAsrReconnect(call, `连接关闭（${code || "未知"}）`);
    });
  });

  const start = async ({ senderId = "" } = {}) => {
    if (disposed) throw new RealtimeVoiceCallError("实时通话服务已经停止。 ");
    if (activeCall && !activeCall.closed) throw new RealtimeVoiceCallError("已有一通语音通话正在进行。 ");
    const [snapshot, session, dashScope] = await Promise.all([
      reader.snapshot(),
      reader.ensureActiveSession(),
      connectionsService.resolveDashScope(),
    ]);
    const contact = snapshot?.activeContact || {};
    const agentId = clean(contact.agentId);
    if (!agentId) throw new RealtimeVoiceCallError("请先新建或选择一位联系人，再开始语音通话。 ");
    if (!session?.id || !session?.projectRoot) throw new RealtimeVoiceCallError("当前联系人还没有可用的 Claude 会话。 ");
    const settings = settingsService.load() || {};
    const dataRoot = typeof dataRootProvider === "function"
      ? clean(dataRootProvider(settings))
      : clean(settingsService.response?.(settings)?.dataRoot);
    const ledgerPath = typeof ledgerPathProvider === "function"
      ? clean(ledgerPathProvider(settings))
      : clean(settingsService.usageLedgerPath?.(settings));
    if (!dataRoot || !ledgerPath) throw new RealtimeVoiceCallError("无法定位 Suzu 的语音配置或用量账本。 ");
    const voiceRuntime = resolveVoiceRuntime({
      dataRoot,
      agentId,
      apiKeyOverride: clean(dashScope?.key),
      baseUrlOverride: clean(dashScope?.baseUrl),
      environment: process.env,
    });
    const asrApiKey = clean(dashScope?.key) || (voiceRuntime.tts.provider === "cosyvoice" ? clean(voiceRuntime.tts.apiKey) : "");
    if (!asrApiKey) {
      throw new RealtimeVoiceCallError("语音通话需要阿里百炼 API Key 才能实时识别你说的话；请在 管理 → API 中配置阿里百炼。 ");
    }
    const call = {
      agentId,
      asrApiKey,
      asrReady: false,
      asrUrl: realtimeAsrWebSocketUrl(dashScope?.baseUrl),
      closed: false,
      closing: false,
      generation: 0,
      hasBufferedAudio: false,
      id: `call-${randomUUID()}`,
      ledgerPath,
      nextAudioIndex: 0,
      ownerSenderId: clean(senderId),
      reconnectAttempts: 0,
      reconnectTimer: null,
      replyStates: new Map(),
      requestIds: new Set(),
      session: {
        id: clean(session.id),
        projectRoot: clean(session.projectRoot),
        hasTranscript: session.hasTranscript === true,
      },
      socket: null,
      started: false,
      ttsControllers: new Map(),
      voiceRuntime,
    };
    activeCall = call;
    try {
      await connectAsr(call);
      call.started = true;
      return {
        callId: call.id,
        contactName: clean(contact.name) || "联系人",
        provider: call.voiceRuntime.tts.provider,
      };
    } catch (error) {
      call.closed = true;
      if (activeCall === call) activeCall = null;
      try { call.socket?.close?.(); } catch { /* Connection setup already failed. */ }
      throw error;
    }
  };

  const pushAudio = ({ callId, senderId = "", audio } = {}) => {
    const call = activeCall;
    if (!callIsActive(call) || clean(callId) !== call.id) return { accepted: false, reason: "inactive" };
    if (call.ownerSenderId && clean(senderId) && call.ownerSenderId !== clean(senderId)) return { accepted: false, reason: "owner" };
    const pcm = audioBuffer(audio);
    if (!call.asrReady || !pcm.length || pcm.length > MAX_AUDIO_CHUNK_BYTES || pcm.length % 2 !== 0) {
      return { accepted: false, reason: "audio" };
    }
    if (call.socket?.readyState !== WebSocket.OPEN) return { accepted: false, reason: "socket" };
    try {
      call.socket.send(JSON.stringify({
        event_id: `audio-${randomUUID()}`,
        type: "input_audio_buffer.append",
        audio: pcm.toString("base64"),
      }));
      call.hasBufferedAudio = true;
      return { accepted: true };
    } catch (error) {
      emitCall(call, "call-error", { message: `无法发送麦克风音频：${ttsErrorMessage(error)}` });
      return { accepted: false, reason: "send" };
    }
  };

  const commitAudio = ({ callId, senderId = "" } = {}) => {
    const call = activeCall;
    if (!callIsActive(call) || clean(callId) !== call.id) return { accepted: false, committed: false, reason: "inactive" };
    if (call.ownerSenderId && clean(senderId) && call.ownerSenderId !== clean(senderId)) return { accepted: false, committed: false, reason: "owner" };
    if (!call.asrReady || !call.hasBufferedAudio) return { accepted: false, committed: false, reason: "audio" };
    if (call.socket?.readyState !== WebSocket.OPEN) return { accepted: false, committed: false, reason: "socket" };
    try {
      call.socket.send(JSON.stringify({
        event_id: `commit-${randomUUID()}`,
        type: "input_audio_buffer.commit",
      }));
      call.hasBufferedAudio = false;
      return { accepted: true, committed: true };
    } catch (error) {
      emitCall(call, "call-error", { message: `无法提交这句话：${ttsErrorMessage(error)}` });
      return { accepted: false, committed: false, reason: "send" };
    }
  };

  const interrupt = async ({ callId, senderId = "" } = {}) => {
    const call = activeCall;
    if (!callIsActive(call) || clean(callId) !== call.id) return { accepted: false, interrupted: false };
    if (call.ownerSenderId && clean(senderId) && call.ownerSenderId !== clean(senderId)) return { accepted: false, interrupted: false };
    await interruptResponse(call, { announce: true });
    return { accepted: true, interrupted: true };
  };

  const stop = async ({ callId, senderId = "" } = {}) => {
    const call = activeCall;
    if (!call || clean(callId) !== call.id) return { accepted: true, stopped: false };
    if (call.ownerSenderId && clean(senderId) && call.ownerSenderId !== clean(senderId)) return { accepted: false, stopped: false };
    call.closing = true;
    if (call.reconnectTimer) clearTimeout(call.reconnectTimer);
    call.reconnectTimer = null;
    const requestIds = [...call.requestIds];
    clearReplyAudio(call);
    await stopCallTurns(call, requestIds);
    try {
      if (call.socket?.readyState === WebSocket.OPEN) call.socket.send(JSON.stringify({ type: "session.finish", event_id: `finish-${randomUUID()}` }));
      call.socket?.close?.();
    } catch { /* Closing an already closed ASR socket is harmless. */ }
    call.closed = true;
    if (activeCall === call) activeCall = null;
    emitCall(call, "call-ended", {});
    return { accepted: true, stopped: true };
  };

  const dispose = () => {
    disposed = true;
    const call = activeCall;
    if (call) {
      call.closing = true;
      if (call.reconnectTimer) clearTimeout(call.reconnectTimer);
      call.reconnectTimer = null;
      clearReplyAudio(call);
      try { call.socket?.close?.(); } catch { /* The process is exiting. */ }
      call.closed = true;
    }
    activeCall = null;
    unsubscribeChat?.();
  };

  return { commitAudio, dispose, interrupt, pushAudio, start, stop };
}
