import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import WebSocket from "ws";

import { appendUsageEvent } from "@suzu-lives/cost-ledger";
import { DEFAULT_REALTIME_ASR_MODEL, realtimeAsrWebSocketUrl } from "./realtime-asr.mjs";

const CONNECT_TIMEOUT_MS = 15_000;
const MAX_AUDIO_CHUNK_BYTES = 48 * 1024;
const MAX_QUEUED_AUDIO_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_LENGTH = 4_000;

function clean(value) {
  return String(value ?? "").trim();
}

function bounded(value, maximum) {
  return String(value ?? "").slice(0, maximum);
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

function errorMessage(error) {
  return clean(error?.message || error) || "未知错误";
}

function voiceCaptureSettings(dataRoot = "") {
  let voiceEnergyThreshold = 0.025;
  let voiceSilenceFrames = 9;
  const root = clean(dataRoot);
  if (!root) return { voiceEnergyThreshold, voiceSilenceFrames };
  try {
    const shared = JSON.parse(fs.readFileSync(path.join(root, "capabilities", "voice-message", "config.json"), "utf8"));
    const threshold = Number(shared.voiceEnergyThreshold);
    if (Number.isFinite(threshold) && threshold >= 0.001 && threshold <= 1) voiceEnergyThreshold = threshold;
    const frames = Number(shared.voiceSilenceFrames);
    if (Number.isFinite(frames) && frames >= 1 && frames <= 120) voiceSilenceFrames = Math.round(frames);
  } catch { /* No shared voice tuning uses the conversational defaults. */ }
  return { voiceEnergyThreshold, voiceSilenceFrames };
}

function resolvedSettings(settingsService) {
  const settings = settingsService?.load?.() || {};
  try {
    return settingsService?.response?.(settings) || settings;
  } catch {
    return settings;
  }
}

export class ConversationVoiceInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConversationVoiceInputError";
  }
}

/**
 * A short, ASR-only capture session for the chat composer.  It deliberately
 * does not create an Agent turn or a TTS runtime: the resulting text is handed
 * back to the renderer so the user can review it in the normal input field.
 */
export function createConversationVoiceInputService({
  appendLedger = appendUsageEvent,
  connectionsService,
  dataRootProvider = null,
  ledgerPathProvider = null,
  onEvent = () => {},
  reader = null,
  settingsService = null,
  webSocketFactory = (url, options) => new WebSocket(url, options),
} = {}) {
  if (!connectionsService?.resolveNamedApiConnection) {
    throw new ConversationVoiceInputError("语音输入需要统一 API 连接服务。");
  }

  let activeInput = null;
  let disposed = false;
  const emit = typeof onEvent === "function" ? onEvent : () => {};

  const inputIsActive = (input) => Boolean(input) && activeInput === input && !input.closed && !disposed;

  const emitInput = (input, type, payload = {}) => {
    try {
      emit({
        type,
        inputId: input.id,
        timestamp: new Date().toISOString(),
        ...payload,
      });
    } catch { /* A renderer event must not interrupt local transcription. */ }
  };

  const finishInput = (input, { emitEnded = true, reason = "" } = {}) => {
    if (!input || input.closed) return false;
    input.closed = true;
    input.closing = true;
    input.asrPendingAudioBytes = 0;
    input.asrQueuedAudio.length = 0;
    input.asrQueuedAudioBytes = 0;
    input.asrUtterances.length = 0;
    try {
      if (input.socket?.readyState === WebSocket.OPEN) {
        input.socket.send(JSON.stringify({ type: "session.finish", event_id: `finish-${randomUUID()}` }));
      }
      input.socket?.close?.();
    } catch { /* The recognition socket may already be gone. */ }
    input.socket = null;
    if (activeInput === input) activeInput = null;
    if (emitEnded) emitInput(input, "voice-input-ended", { reason: clean(reason) });
    return true;
  };

  const recordAsrUsage = async (input, message, transcript, utterance) => {
    if (!input.ledgerPath || !utterance?.audioBytes) return;
    await appendLedger(input.ledgerPath, {
      agentId: input.agentId,
      provider: input.asrProvider,
      model: input.asrModel,
      source: "实时语音识别",
      feature: "conversation-voice-input-asr",
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

  const handleAsrMessage = (input, raw) => {
    if (!inputIsActive(input)) return;
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    const type = clean(message?.type);
    if (["conversation.item.input_audio_transcription.text", "conversation.item.input_audio_transcription.delta"].includes(type)) {
      if (!input.asrUtterances.length) return;
      const text = bounded(clean(`${message.text || message.delta || ""}${message.stash || ""}` || message.transcript), MAX_TRANSCRIPT_LENGTH);
      if (text) emitInput(input, "voice-input-transcript", { final: false, text });
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const utterance = input.asrUtterances.shift();
      if (!utterance) return;
      const text = bounded(clean(message.transcript || message.text), MAX_TRANSCRIPT_LENGTH);
      void recordAsrUsage(input, message, text, utterance).catch((error) => {
        emitInput(input, "voice-input-error", { message: `无法记录语音识别用量：${errorMessage(error)}` });
      });
      if (text) {
        emitInput(input, "voice-input-transcript", { final: true, text });
        finishInput(input, { reason: "completed" });
      } else {
        emitInput(input, "voice-input-error", { message: "没有识别到可用文字，请靠近麦克风后再试。" });
        finishInput(input, { reason: "empty" });
      }
      return;
    }
    if (type === "conversation.item.input_audio_transcription.failed") {
      if (!input.asrUtterances.length) return;
      const detail = clean(message.error?.message || message.error?.code || message.message);
      emitInput(input, "voice-input-error", { message: `语音识别失败：${detail || "未知错误"}` });
      finishInput(input, { reason: "failed" });
      return;
    }
    if (type === "error") {
      const detail = clean(message.error?.message || message.error?.code || message.message);
      emitInput(input, "voice-input-error", { message: `语音识别连接出错：${detail || "未知错误"}` });
      finishInput(input, { reason: "error" });
      return;
    }
    if (type === "session.finished") finishInput(input, { reason: "finished" });
  };

  const flushQueuedAudio = (input) => {
    if (!inputIsActive(input) || input.closing) return false;
    if (!input.asrReady || !input.asrQueuedAudio.length) return true;
    if (input.socket?.readyState !== WebSocket.OPEN) return false;
    try {
      while (input.asrQueuedAudio.length) {
        const pcm = input.asrQueuedAudio[0];
        input.socket.send(JSON.stringify({
          event_id: `audio-${randomUUID()}`,
          type: "input_audio_buffer.append",
          audio: pcm.toString("base64"),
        }));
        input.asrQueuedAudio.shift();
        input.asrQueuedAudioBytes = Math.max(0, input.asrQueuedAudioBytes - pcm.length);
      }
      return true;
    } catch (error) {
      input.asrReady = false;
      emitInput(input, "voice-input-error", { message: `无法发送麦克风音频：${errorMessage(error)}` });
      finishInput(input, { reason: "audio-send-failed" });
      return false;
    }
  };

  const connectAsr = (input) => new Promise((resolve, reject) => {
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
      socket = webSocketFactory(input.asrUrl, {
        headers: {
          Authorization: `Bearer ${input.asrApiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });
    } catch (error) {
      reject(new ConversationVoiceInputError(`无法连接语音识别服务：${errorMessage(error)}`));
      return;
    }
    input.socket = socket;
    timeout = setTimeout(() => {
      try { socket.close?.(); } catch { /* Best effort while connecting. */ }
      finish(reject, new ConversationVoiceInputError("语音识别连接超时。"));
    }, CONNECT_TIMEOUT_MS);
    socket.on("open", () => {
      if (!inputIsActive(input) || input.closing) {
        try { socket.close?.(); } catch { /* A cancelled capture has no socket. */ }
        return;
      }
      try {
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
        input.asrReady = true;
        finish(resolve, undefined);
      } catch (error) {
        finish(reject, new ConversationVoiceInputError(`无法启动语音识别：${errorMessage(error)}`));
      }
    });
    socket.on("message", (value) => handleAsrMessage(input, value));
    socket.on("error", (error) => {
      input.asrReady = false;
      if (!settled) {
        finish(reject, new ConversationVoiceInputError(`语音识别连接失败：${errorMessage(error)}`));
        return;
      }
      if (inputIsActive(input) && !input.closing) {
        emitInput(input, "voice-input-error", { message: `语音识别连接出错：${errorMessage(error)}` });
        finishInput(input, { reason: "socket-error" });
      }
    });
    socket.on("close", (code, reason) => {
      input.asrReady = false;
      if (input.socket === socket) input.socket = null;
      if (!settled) {
        finish(reject, new ConversationVoiceInputError(`语音识别连接已关闭（${code || "未知"}）：${clean(reason) || "未建立识别"}`));
        return;
      }
      if (inputIsActive(input) && !input.closing) {
        emitInput(input, "voice-input-error", { message: `语音识别连接已断开（${code || "未知"}）。` });
        finishInput(input, { reason: "socket-closed" });
      }
    });
  });

  const ensureAsrReady = (input) => {
    if (!inputIsActive(input) || input.closing) return Promise.resolve(false);
    if (input.asrReady && input.socket?.readyState === WebSocket.OPEN) return Promise.resolve(flushQueuedAudio(input));
    input.asrReady = false;
    if (input.asrConnecting) return input.asrConnecting;
    const connecting = connectAsr(input)
      .then(() => flushQueuedAudio(input))
      .catch((error) => {
        if (inputIsActive(input)) {
          emitInput(input, "voice-input-error", { message: `无法连接语音识别服务：${errorMessage(error)}` });
          finishInput(input, { reason: "connect-failed" });
        }
        return false;
      })
      .finally(() => {
        if (input.asrConnecting === connecting) input.asrConnecting = null;
      });
    input.asrConnecting = connecting;
    return connecting;
  };

  const start = async ({ senderId = "" } = {}) => {
    if (disposed) throw new ConversationVoiceInputError("语音输入服务已经停止。 ");
    if (activeInput && !activeInput.closed) throw new ConversationVoiceInputError("当前正在进行语音输入。 ");
    const [connection, snapshot] = await Promise.all([
      connectionsService.resolveNamedApiConnection("realtime-asr"),
      reader?.snapshot?.() || Promise.resolve(null),
    ]);
    const asrApiKey = clean(connection?.key);
    if (!asrApiKey) {
      throw new ConversationVoiceInputError("语音输入需要识别 API Key；请在 能力 → 语音消息 中为“ASR API”选择并配置连接。 ");
    }
    const requestedModel = clean(connection?.model);
    if (!requestedModel && clean(connection?.type).toLowerCase() !== "dashscope") {
      throw new ConversationVoiceInputError("语音识别连接没有填写模型；请在“ASR API”所选连接填写识别模型。 ");
    }
    const settings = resolvedSettings(settingsService);
    const dataRoot = typeof dataRootProvider === "function"
      ? clean(dataRootProvider(settings))
      : clean(settings.dataRoot);
    const ledgerPath = typeof ledgerPathProvider === "function"
      ? clean(ledgerPathProvider(settings))
      : clean(settings.usageLedgerPath);
    const capture = voiceCaptureSettings(dataRoot);
    const asrModel = requestedModel || DEFAULT_REALTIME_ASR_MODEL;
    const input = {
      agentId: clean(snapshot?.activeContact?.agentId),
      asrApiKey,
      asrConnecting: null,
      asrModel,
      asrPendingAudioBytes: 0,
      asrProvider: clean(connection?.name || connection?.provider) || "阿里云百炼",
      asrQueuedAudio: [],
      asrQueuedAudioBytes: 0,
      asrReady: false,
      asrUrl: realtimeAsrWebSocketUrl(connection?.baseUrl, asrModel),
      asrUtterances: [],
      closed: false,
      closing: false,
      committed: false,
      commitPending: false,
      id: `voice-input-${randomUUID()}`,
      ledgerPath,
      ownerSenderId: clean(senderId),
      socket: null,
      voiceEnergyThreshold: capture.voiceEnergyThreshold,
      voiceSilenceFrames: capture.voiceSilenceFrames,
    };
    activeInput = input;
    return {
      inputId: input.id,
      voiceEnergyThreshold: input.voiceEnergyThreshold,
      voiceSilenceFrames: input.voiceSilenceFrames,
    };
  };

  const pushAudio = ({ audio, inputId, senderId = "" } = {}) => {
    const input = activeInput;
    if (!inputIsActive(input) || clean(inputId) !== input.id) return { accepted: false, reason: "inactive" };
    if (input.ownerSenderId && clean(senderId) && input.ownerSenderId !== clean(senderId)) return { accepted: false, reason: "owner" };
    if (input.committed || input.commitPending) return { accepted: false, reason: "committed" };
    const pcm = audioBuffer(audio);
    if (!pcm.length || pcm.length > MAX_AUDIO_CHUNK_BYTES || pcm.length % 2 !== 0) return { accepted: false, reason: "audio" };
    if (pcmEnergy(pcm) < input.voiceEnergyThreshold) return { accepted: false, reason: "quiet" };
    if (input.asrQueuedAudioBytes + pcm.length > MAX_QUEUED_AUDIO_BYTES) {
      emitInput(input, "voice-input-error", { message: "说话音频积压过多，请停顿后再试。" });
      finishInput(input, { reason: "queue-full" });
      return { accepted: false, reason: "queue" };
    }
    input.asrQueuedAudio.push(pcm);
    input.asrQueuedAudioBytes += pcm.length;
    input.asrPendingAudioBytes += pcm.length;
    if (input.asrReady) flushQueuedAudio(input);
    else void ensureAsrReady(input);
    return { accepted: true };
  };

  const commit = async ({ inputId, senderId = "" } = {}) => {
    const input = activeInput;
    if (!inputIsActive(input) || clean(inputId) !== input.id) return { accepted: false, committed: false, reason: "inactive" };
    if (input.ownerSenderId && clean(senderId) && input.ownerSenderId !== clean(senderId)) return { accepted: false, committed: false, reason: "owner" };
    if (input.committed || input.commitPending) return { accepted: false, committed: false, reason: "committed" };
    if (!input.asrPendingAudioBytes) return { accepted: false, committed: false, reason: "audio" };
    input.commitPending = true;
    try {
      const ready = await ensureAsrReady(input);
      if (!ready || !inputIsActive(input) || input.closing) return { accepted: false, committed: false, reason: "socket" };
      if (input.asrQueuedAudio.length || input.socket?.readyState !== WebSocket.OPEN) return { accepted: false, committed: false, reason: "audio" };
      input.socket.send(JSON.stringify({
        event_id: `commit-${randomUUID()}`,
        type: "input_audio_buffer.commit",
      }));
      input.asrUtterances.push({
        audioBytes: input.asrPendingAudioBytes,
        timestamp: new Date().toISOString(),
      });
      input.asrPendingAudioBytes = 0;
      input.committed = true;
      return { accepted: true, committed: true };
    } catch (error) {
      if (inputIsActive(input)) {
        emitInput(input, "voice-input-error", { message: `无法提交这段语音：${errorMessage(error)}` });
        finishInput(input, { reason: "commit-failed" });
      }
      return { accepted: false, committed: false, reason: "send" };
    } finally {
      input.commitPending = false;
    }
  };

  const stop = async ({ inputId, senderId = "" } = {}) => {
    const input = activeInput;
    if (!input || clean(inputId) !== input.id) return { accepted: true, stopped: false };
    if (input.ownerSenderId && clean(senderId) && input.ownerSenderId !== clean(senderId)) return { accepted: false, stopped: false };
    return { accepted: true, stopped: finishInput(input, { reason: "cancelled" }) };
  };

  const dispose = () => {
    disposed = true;
    if (activeInput) finishInput(activeInput, { emitEnded: false, reason: "disposed" });
  };

  return { commit, dispose, pushAudio, start, stop };
}
