import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import WebSocket from "ws";

import { appendUsageEvent } from "@suzu-lives/cost-ledger";
import { resolveDirectVoiceRuntime, synthesizeDirectVoiceAudio } from "@suzu-lives/voice-message/direct-voice-message";

const DEFAULT_ASR_MODEL = "qwen3-asr-flash-realtime";
const MAX_AUDIO_CHUNK_BYTES = 48 * 1024;
const MAX_TRANSCRIPT_LENGTH = 4_000;
const MAX_QUEUED_AUDIO_BYTES = 256 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_DELAYS_MS = Object.freeze([500, 1_200, 2_500]);
// CosyVoice accepts at most three submissions per second.  Leave a small
// margin so the next clause can be prepared during playback without causing
// a burst at the provider boundary.
const COSYVOICE_TTS_MIN_REQUEST_INTERVAL_MS = 350;
const TTS_RATE_LIMIT_RETRY_DELAYS_MS = Object.freeze([900, 1_800]);

function clean(value) {
  return String(value ?? "").trim();
}

function callInitiator(value) {
  return clean(value).toLowerCase() === "agent" ? "agent" : "user";
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

function pcmEnergy(value) {
  const pcm = Buffer.isBuffer(value) ? value : audioBuffer(value);
  if (!pcm.length || pcm.length % 2 !== 0) return 0;
  let total = 0;
  const sampleCount = pcm.length / 2;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset) / 32_768;
    total += sample * sample;
  }
  return Math.sqrt(total / sampleCount);
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

function isCosyVoiceRuntime(runtime) {
  const adapter = clean(runtime?.tts?.adapter || runtime?.tts?.provider).toLowerCase();
  return adapter === "dashscope-cosyvoice" || adapter === "cosyvoice";
}

function isTtsRateLimited(error) {
  const detail = `${clean(error?.code)} ${clean(error?.message || error)}`.toLowerCase();
  return detail.includes("throttling.ratequota") || detail.includes("rate limit") || /\b429\b/u.test(detail);
}

function ttsHttpStatus(error) {
  const match = /\bHTTP\s+([1-5]\d{2})\b/iu.exec(clean(error?.message || error));
  return match?.[1] || "";
}

function ttsFailureSystemMessage(error) {
  if (isTtsRateLimited(error)) return "通话系统：语音服务繁忙，已跳过这一句语音。";
  const code = clean(error?.code).toLowerCase();
  if (code === "tts_timeout") return "通话系统：语音合成请求超时，已跳过这一句。请检查网络或稍后重试。";
  if (code === "tts_network_error") return "通话系统：无法连接语音服务，已跳过这一句。请检查“语音消息”的服务地址和网络。";
  if (code === "tts_http_error") {
    const status = ttsHttpStatus(error);
    return `通话系统：语音服务拒绝了这句合成${status ? `（HTTP ${status}）` : ""}，已跳过。请检查“语音消息”的模型、音色和接口类型。`;
  }
  if (code === "tts_response_invalid") return "通话系统：语音服务返回了无法播放的内容，已跳过这一句。请检查“语音消息”的接口类型和模型。";
  return "通话系统：这句语音暂时无法合成，已跳过。";
}

function waitForCallTts(delayMs, signal) {
  const delay = Math.max(0, Number(delayMs) || 0);
  if (signal?.aborted) return Promise.resolve(false);
  if (!delay) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    timer = setTimeout(() => finish(true), delay);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
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
 * AIRI's example we do not place <break/> in the saved Agent Core reply: Suzu
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
  appendLedger = appendUsageEvent,
  fetchImpl = globalThis.fetch,
  ledgerPathProvider = null,
  now = () => Date.now(),
  onEvent = () => {},
  reader,
  resolveVoiceRuntime = resolveDirectVoiceRuntime,
  reconnectDelaysMs = DEFAULT_RECONNECT_DELAYS_MS,
  settingsService,
  sleep = waitForCallTts,
  synthesizeVoice = synthesizeDirectVoiceAudio,
  webSocketFactory = (url, options) => new WebSocket(url, options),
} = {}) {
  if (!chat?.sendToSession || !chat?.subscribe || !chat?.stop) {
    throw new RealtimeVoiceCallError("实时通话需要可持续的 Suzu 对话服务。");
  }
  if (!reader?.ensureActiveSession || !reader?.snapshot) {
    throw new RealtimeVoiceCallError("实时通话需要当前联系人的会话信息。");
  }
  if (!connectionsService?.resolveNamedApiConnection) {
    throw new RealtimeVoiceCallError("实时通话需要统一 API 连接服务。");
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
  const timeNow = typeof now === "function" ? now : () => Date.now();
  const pause = typeof sleep === "function" ? sleep : waitForCallTts;
  let nextCosyVoiceTtsStartAt = 0;

  const currentTime = () => {
    const value = Number(timeNow());
    return Number.isFinite(value) ? value : Date.now();
  };

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
    call.ttsQueue.length = 0;
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

  const canSpeakQueuedJob = (call, job) => (
    callIsActive(call)
    && job.generation === call.generation
    && !job.controller.signal.aborted
  );

  const reserveTtsRequest = async (call, job) => {
    if (!canSpeakQueuedJob(call, job) || !isCosyVoiceRuntime(call.voiceRuntime)) return canSpeakQueuedJob(call, job);
    const delay = Math.max(0, nextCosyVoiceTtsStartAt - currentTime());
    if (delay > 0) {
      const completed = await pause(delay, job.controller.signal);
      if (completed === false || !canSpeakQueuedJob(call, job)) return false;
    }
    const startedAt = currentTime();
    nextCosyVoiceTtsStartAt = Math.max(startedAt, nextCosyVoiceTtsStartAt) + COSYVOICE_TTS_MIN_REQUEST_INTERVAL_MS;
    return canSpeakQueuedJob(call, job);
  };

  const synthesizeQueuedSpeech = async (call, job) => {
    let retry = 0;
    while (canSpeakQueuedJob(call, job)) {
      const reserved = await reserveTtsRequest(call, job);
      if (!reserved) return null;
      try {
        return await synthesizeVoice({
          text: job.spoken,
          runtime: call.voiceRuntime,
          fetchImpl,
          ledgerPath: call.ledgerPath,
          agentId: call.agentId,
          feature: "realtime-voice-call-tts",
          abortSignal: job.controller.signal,
        });
      } catch (error) {
        if (!isTtsRateLimited(error) || retry >= TTS_RATE_LIMIT_RETRY_DELAYS_MS.length) throw error;
        const delay = TTS_RATE_LIMIT_RETRY_DELAYS_MS[retry++];
        const completed = await pause(delay, job.controller.signal);
        if (completed === false || !canSpeakQueuedJob(call, job)) return null;
      }
    }
    return null;
  };

  const resumeListeningWhenSpeechIsIdle = (call) => {
    if (
      !callIsActive(call)
      || call.ttsQueue.length
      || call.requestIds.size
      || call.replyStates.size
    ) return;
    emitCall(call, "call-state", { state: "listening", label: "正在听你说…" });
  };

  const drainSpeechQueue = async (call) => {
    if (call.ttsDraining) return;
    call.ttsDraining = true;
    try {
      while (call.ttsQueue.length) {
        const job = call.ttsQueue.shift();
        if (!job || !canSpeakQueuedJob(call, job)) {
          if (job) call.ttsControllers.delete(job.key);
          continue;
        }
        let emittedAudio = false;
        try {
          const result = await synthesizeQueuedSpeech(call, job);
          if (!result || !canSpeakQueuedJob(call, job)) continue;
          const audio = Buffer.from(result.audio || []);
          if (!audio.length) throw new RealtimeVoiceCallError("语音合成返回了空音频。");
          emitCall(call, "call-audio", {
            index: job.index,
            requestId: job.requestId,
            text: job.spoken,
            mimeType: audioMime(result.format),
            audioBase64: audio.toString("base64"),
          });
          emittedAudio = true;
          emitCall(call, "call-state", { state: "speaking", label: "正在说话…" });
        } catch (error) {
          if (!canSpeakQueuedJob(call, job) || error?.code === "tts_aborted") continue;
          // A skipped clause should not turn the whole call bar into an error.
          // The chat page renders this with its existing hidden-by-default
          // system-message treatment instead.
          emitCall(call, "call-system-message", {
            index: job.index,
            message: ttsFailureSystemMessage(error),
            requestId: job.requestId,
          });
          // Keep later clauses playable if this one provider request failed.
          // The renderer preserves order, so it needs an explicit gap marker.
          emitCall(call, "call-audio-skip", { index: job.index, requestId: job.requestId });
        } finally {
          call.ttsControllers.delete(job.key);
          // A greeting can be entirely skipped when the configured TTS rejects
          // it.  That must leave the microphone usable rather than pinning the
          // call UI in its dialing/thinking state forever.
          if (!emittedAudio) resumeListeningWhenSpeechIsIdle(call);
        }
      }
    } finally {
      call.ttsDraining = false;
      if (callIsActive(call) && call.ttsQueue.length) void drainSpeechQueue(call);
    }
  };

  const queueSpeech = (call, requestId, text) => {
    const spoken = clean(text);
    if (!spoken || !callIsActive(call)) return;
    const generation = call.generation;
    const index = call.nextAudioIndex++;
    const key = `${generation}:${index}`;
    const controller = new AbortController();
    call.ttsControllers.set(key, controller);
    call.ttsQueue.push({
      controller,
      generation,
      index,
      key,
      requestId,
      spoken,
    });
    void drainSpeechQueue(call);
  };

  const receiveChatEvent = (event) => {
    const call = activeCall;
    if (!callIsActive(call) || !["call", "call-open"].includes(clean(event?.kind))) return;
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

  const open = async ({ callId, senderId = "" } = {}) => {
    const call = activeCall;
    if (!callIsActive(call) || clean(callId) !== call.id) return { accepted: false, opened: false, reason: "inactive" };
    if (call.ownerSenderId && clean(senderId) && call.ownerSenderId !== clean(senderId)) return { accepted: false, opened: false, reason: "owner" };
    if (call.opening || call.opened) return { accepted: true, opened: false, reason: "opened" };

    call.opening = true;
    const generation = call.generation;
    const requestId = `suzu-call-open-${randomUUID()}`;
    call.requestIds.add(requestId);
    call.replyStates.set(requestId, { fullText: "", remaining: "" });
    emitCall(call, "call-state", { state: "thinking", label: "正在接通…" });
    try {
      const result = await chat.sendToSession({
        content: "",
        contactId: call.contactId,
        sessionId: call.session.id,
        projectRoot: call.session.projectRoot,
        hasTranscript: call.session.hasTranscript,
        kind: "call-open",
        callDirection: call.initiator,
        deliverToWechat: false,
        requestId,
      });
      if (!callIsActive(call) || generation !== call.generation) {
        await chat.stop({ sessionId: call.session.id, projectRoot: call.session.projectRoot, requestId }).catch(() => undefined);
        return { accepted: false, opened: false, reason: "interrupted" };
      }
      if (clean(result?.requestId) !== requestId) throw new RealtimeVoiceCallError("Suzu 没有建立本次通话问候。 ");
      call.opened = true;
      return { accepted: true, opened: true };
    } catch (error) {
      call.replyStates.delete(requestId);
      call.requestIds.delete(requestId);
      if (!callIsActive(call) || generation !== call.generation) return { accepted: false, opened: false, reason: "interrupted" };
      emitCall(call, "call-error", { message: `无法开始通话问候：${ttsErrorMessage(error)}` });
      return { accepted: false, opened: false, reason: "reply" };
    } finally {
      call.opening = false;
    }
  };

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
    // Register the request before starting Agent Core.  Agent Core can emit its first
    // streamed token immediately after the session starts, before the
    // async enqueue call resolves.
    const requestId = `suzu-call-${randomUUID()}`;
    call.requestIds.add(requestId);
    call.replyStates.set(requestId, { fullText: "", remaining: "" });
    emitCall(call, "call-transcript", { text, final: true });
    emitCall(call, "call-state", { state: "thinking", label: "正在想怎么回答…" });
    try {
      const result = await chat.sendToSession({
        content: text,
        contactId: call.contactId,
        sessionId: call.session.id,
        projectRoot: call.session.projectRoot,
        hasTranscript: call.session.hasTranscript,
        kind: "call",
        deliverToWechat: false,
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

  const recordAsrUsage = async (call, message, transcript, utterance) => {
    if (!utterance?.audioBytes) return;
    await appendLedger(call.ledgerPath, {
      agentId: call.agentId,
      provider: call.asrProvider,
      model: call.asrModel,
      source: "实时语音识别",
      feature: "realtime-voice-call-asr",
      requestId: clean(message.item_id || message.event_id) || `asr-${randomUUID()}`,
      timestamp: utterance.timestamp,
      units: {
        inputAudioSeconds: utterance.audioBytes / (16_000 * 2),
      },
      metadata: {
        language: clean(message.language) || "zh",
        transcriptCharacters: [...clean(transcript)].length,
      },
    });
  };

  const handleAsrMessage = (call, raw) => {
    if (!callIsActive(call)) return;
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    const type = clean(message?.type);
    if (type === "input_audio_buffer.speech_started") {
      if (!call.hasBufferedAudio) return;
      void interruptResponse(call, { announce: true });
      return;
    }
    if (["conversation.item.input_audio_transcription.text", "conversation.item.input_audio_transcription.delta"].includes(type)) {
      // A transcript only belongs in the conversation after this process has
      // explicitly committed a locally gated utterance.  Ignore anything the
      // provider may emit while merely opening a realtime session.
      if (!call.asrUtterances.length) return;
      const text = bounded(clean(`${message.text || message.delta || ""}${message.stash || ""}` || message.transcript), MAX_TRANSCRIPT_LENGTH);
      if (text) emitCall(call, "call-transcript", { text, final: false });
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const utterance = call.asrUtterances.shift();
      if (!utterance) return;
      const text = bounded(clean(message.transcript || message.text), MAX_TRANSCRIPT_LENGTH);
      void recordAsrUsage(call, message, text, utterance).catch((error) => {
        if (callIsActive(call)) emitCall(call, "call-error", { message: `无法记录语音识别用量：${ttsErrorMessage(error)}` });
      });
      if (text) void sendTranscript(call, text);
      return;
    }
    if (type === "error") {
      const detail = clean(message.error?.message || message.message || message.error?.code);
      emitCall(call, "call-error", { message: `语音识别连接出错：${detail || "未知错误"}` });
      return;
    }
    if (type === "conversation.item.input_audio_transcription.failed") {
      const utterance = call.asrUtterances.shift();
      if (!utterance) return;
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
    // With no locally accepted audio there is nothing to recover.  Leave ASR
    // closed until a later above-threshold frame starts the next utterance.
    if (!call.hasBufferedAudio && !call.asrQueuedAudio.length) return;
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
      const recovered = await ensureAsrReady(call);
      if (recovered) {
        call.reconnectAttempts = 0;
        return;
      }
      scheduleAsrReconnect(call, reason || "无法重新建立连接");
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
      if (!callIsActive(call) || call.closing) {
        try { socket.close?.(); } catch { /* A hung-up call has no socket. */ }
        return;
      }
      try {
        // The renderer already has a lightweight speech/silence detector.  Let
        // it commit each utterance explicitly: a noisy microphone can otherwise
        // keep server VAD open forever and never produce a final transcript.
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
      call.asrReady = false;
      if (!settled) {
        finish(reject, new RealtimeVoiceCallError(`语音识别连接失败：${ttsErrorMessage(error)}`));
        return;
      }
      if (callIsActive(call) && call.started) scheduleAsrReconnect(call, ttsErrorMessage(error));
    });
    socket.on("close", (code, reason) => {
      call.asrReady = false;
      if (call.socket === socket) call.socket = null;
      if (!settled) {
        finish(reject, new RealtimeVoiceCallError(`语音识别连接已关闭（${code || "未知"}）：${clean(reason) || "未建立通话"}`));
        return;
      }
      if (callIsActive(call) && !call.closing && call.started) scheduleAsrReconnect(call, `连接关闭（${code || "未知"}）`);
    });
  });

  const flushQueuedAudio = (call) => {
    if (!callIsActive(call) || call.closing) return false;
    if (!call.asrReady || !call.asrQueuedAudio.length) return true;
    if (call.socket?.readyState !== WebSocket.OPEN) return false;
    try {
      while (call.asrQueuedAudio.length) {
        const pcm = call.asrQueuedAudio[0];
        call.socket.send(JSON.stringify({
          event_id: `audio-${randomUUID()}`,
          type: "input_audio_buffer.append",
          audio: pcm.toString("base64"),
        }));
        call.asrQueuedAudio.shift();
        call.asrQueuedAudioBytes = Math.max(0, call.asrQueuedAudioBytes - pcm.length);
      }
      return true;
    } catch (error) {
      call.asrReady = false;
      emitCall(call, "call-error", { message: `无法发送麦克风音频：${ttsErrorMessage(error)}` });
      return false;
    }
  };

  const ensureAsrReady = (call) => {
    if (!callIsActive(call) || call.closing) return Promise.resolve(false);
    if (call.asrReady && call.socket?.readyState === WebSocket.OPEN) return Promise.resolve(flushQueuedAudio(call));
    call.asrReady = false;
    if (call.asrConnecting) return call.asrConnecting;
    const connecting = connectAsr(call)
      .then(() => flushQueuedAudio(call))
      .catch((error) => {
        if (callIsActive(call)) emitCall(call, "call-error", { message: `无法连接语音识别服务：${ttsErrorMessage(error)}` });
        return false;
      })
      .finally(() => {
        if (call.asrConnecting === connecting) call.asrConnecting = null;
      });
    call.asrConnecting = connecting;
    return connecting;
  };

  const start = async ({ senderId = "", initiator = "user" } = {}) => {
    if (disposed) throw new RealtimeVoiceCallError("实时通话服务已经停止。 ");
    if (activeCall && !activeCall.closed) throw new RealtimeVoiceCallError("已有一通语音通话正在进行。 ");
    const [snapshot, session, voiceConnection, asrConnection] = await Promise.all([
      reader.snapshot(),
      reader.ensureActiveSession(),
      connectionsService.resolveNamedApiConnection("voice-message"),
      connectionsService.resolveNamedApiConnection("realtime-asr"),
    ]);
    const contact = snapshot?.activeContact || {};
    const agentId = clean(contact.agentId);
    if (!agentId) throw new RealtimeVoiceCallError("请先新建或选择一位联系人，再开始语音通话。 ");
    if (!session?.id || !session?.projectRoot) throw new RealtimeVoiceCallError("当前联系人还没有可用的 Agent Core 会话。 ");
    const settings = settingsService.load() || {};
    const dataRoot = typeof dataRootProvider === "function"
      ? clean(dataRootProvider(settings))
      : clean(settingsService.response?.(settings)?.dataRoot);
    const ledgerPath = typeof ledgerPathProvider === "function"
      ? clean(ledgerPathProvider(settings))
      : clean(settingsService.usageLedgerPath?.(settings));
    if (!dataRoot || !ledgerPath) throw new RealtimeVoiceCallError("无法定位 Suzu 的语音配置或用量账本。 ");
    let voiceEnergyThreshold = 0.025;
    let voiceSilenceFrames = 9;
    try {
      const shared = JSON.parse(fs.readFileSync(path.join(dataRoot, "capabilities", "voice-message", "config.json"), "utf8"));
      const threshold = Number(shared.voiceEnergyThreshold);
      if (Number.isFinite(threshold) && threshold >= 0.001 && threshold <= 1) voiceEnergyThreshold = threshold;
      const frames = Number(shared.voiceSilenceFrames);
      if (Number.isFinite(frames) && frames >= 1 && frames <= 120) voiceSilenceFrames = Math.round(frames);
    } catch { /* 没有共享语音设置时使用默认阈值。 */ }
    const selectedVoiceConnection = voiceConnection;
    if (!selectedVoiceConnection?.key) {
      throw new RealtimeVoiceCallError("语音通话需要“语音消息”API；请先在 设置 → API 中选择并配置它。 ");
    }
    const voiceRuntime = resolveVoiceRuntime({
      dataRoot,
      agentId,
      apiKeyOverride: clean(selectedVoiceConnection?.key),
      baseUrlOverride: clean(selectedVoiceConnection?.baseUrl),
      modelOverride: clean(selectedVoiceConnection?.model),
      connectionName: clean(selectedVoiceConnection?.name || selectedVoiceConnection?.provider),
      connectionType: clean(selectedVoiceConnection?.type),
      environment: process.env,
    });
    const selectedAsrConnection = asrConnection;
    const asrApiKey = clean(selectedAsrConnection?.key);
    if (!asrApiKey) {
      throw new RealtimeVoiceCallError("语音通话需要识别 API Key 才能实时识别你说的话；请在设置 → API 中为“实时语音识别”选择并配置连接。 ");
    }
    const asrModel = clean(selectedAsrConnection?.model);
    if (!asrModel && clean(selectedAsrConnection?.type).toLowerCase() !== "dashscope") {
      throw new RealtimeVoiceCallError("语音识别连接没有填写模型；请在 设置 → API 中为“实时语音识别”所选连接填写识别模型。");
    }
    const resolvedAsrModel = asrModel || DEFAULT_ASR_MODEL;
    const callId = `call-${randomUUID()}`;
    const call = {
      agentId,
      asrApiKey,
      asrConnecting: null,
      asrModel: resolvedAsrModel,
      asrProvider: clean(selectedAsrConnection?.name || selectedAsrConnection?.provider) || "阿里云百炼",
      asrReady: false,
      asrPendingAudioBytes: 0,
      asrQueuedAudio: [],
      asrQueuedAudioBytes: 0,
      asrUtterances: [],
      asrUrl: realtimeAsrWebSocketUrl(selectedAsrConnection?.baseUrl, resolvedAsrModel),
      closed: false,
      closing: false,
      contactId: clean(contact.id),
      generation: 0,
      hasBufferedAudio: false,
      id: callId,
      initiator: callInitiator(initiator),
      ledgerPath,
      nextAudioIndex: 0,
      opened: false,
      opening: false,
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
      asrEnergyThreshold: voiceEnergyThreshold,
      ttsControllers: new Map(),
      ttsDraining: false,
      ttsQueue: [],
      voiceRuntime,
    };
    activeCall = call;
    call.started = true;
    return {
      callId: call.id,
      contactName: clean(contact.name) || "联系人",
      provider: call.voiceRuntime.tts.adapter || call.voiceRuntime.tts.provider,
      voiceEnergyThreshold,
      voiceSilenceFrames,
    };
  };

  const pushAudio = ({ callId, senderId = "", audio } = {}) => {
    const call = activeCall;
    if (!callIsActive(call) || clean(callId) !== call.id) return { accepted: false, reason: "inactive" };
    if (call.ownerSenderId && clean(senderId) && call.ownerSenderId !== clean(senderId)) return { accepted: false, reason: "owner" };
    const pcm = audioBuffer(audio);
    if (!pcm.length || pcm.length > MAX_AUDIO_CHUNK_BYTES || pcm.length % 2 !== 0) {
      return { accepted: false, reason: "audio" };
    }
    const energy = pcmEnergy(pcm);
    if (energy < call.asrEnergyThreshold) return { accepted: false, reason: "quiet" };
    if (call.asrQueuedAudioBytes + pcm.length > MAX_QUEUED_AUDIO_BYTES) {
      emitCall(call, "call-error", { message: "说话音频积压过多，请停顿后再试。" });
      return { accepted: false, reason: "queue" };
    }
    // This queue contains only frames that passed the RMS threshold.  It lets
    // the first voiced frame create the websocket without ever opening ASR for
    // a silent call.
    call.asrQueuedAudio.push(pcm);
    call.asrQueuedAudioBytes += pcm.length;
    call.asrPendingAudioBytes += pcm.length;
    call.hasBufferedAudio = true;
    if (call.asrReady) {
      if (!flushQueuedAudio(call)) scheduleAsrReconnect(call, "无法发送麦克风音频");
    } else {
      void ensureAsrReady(call);
    }
    return { accepted: true };
  };

  const commitAudio = async ({ callId, senderId = "" } = {}) => {
    const call = activeCall;
    if (!callIsActive(call) || clean(callId) !== call.id) return { accepted: false, committed: false, reason: "inactive" };
    if (call.ownerSenderId && clean(senderId) && call.ownerSenderId !== clean(senderId)) return { accepted: false, committed: false, reason: "owner" };
    if (!call.hasBufferedAudio) return { accepted: false, committed: false, reason: "audio" };
    const ready = await ensureAsrReady(call);
    if (!ready || !callIsActive(call) || call.closing) return { accepted: false, committed: false, reason: "socket" };
    if (call.asrQueuedAudio.length) return { accepted: false, committed: false, reason: "audio" };
    if (call.socket?.readyState !== WebSocket.OPEN) return { accepted: false, committed: false, reason: "socket" };
    try {
      call.socket.send(JSON.stringify({
        event_id: `commit-${randomUUID()}`,
        type: "input_audio_buffer.commit",
      }));
      call.asrUtterances.push({
        audioBytes: call.asrPendingAudioBytes,
        timestamp: new Date().toISOString(),
      });
      call.asrPendingAudioBytes = 0;
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
    call.asrPendingAudioBytes = 0;
    call.asrQueuedAudio.length = 0;
    call.asrQueuedAudioBytes = 0;
    call.asrUtterances.length = 0;
    call.hasBufferedAudio = false;
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
      call.asrPendingAudioBytes = 0;
      call.asrQueuedAudio.length = 0;
      call.asrQueuedAudioBytes = 0;
      call.asrUtterances.length = 0;
      call.hasBufferedAudio = false;
      if (call.reconnectTimer) clearTimeout(call.reconnectTimer);
      call.reconnectTimer = null;
      clearReplyAudio(call);
      try { call.socket?.close?.(); } catch { /* The process is exiting. */ }
      call.closed = true;
    }
    activeCall = null;
    unsubscribeChat?.();
  };

  return { commitAudio, dispose, interrupt, open, pushAudio, start, stop };
}
