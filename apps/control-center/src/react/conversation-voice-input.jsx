import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { downsamplePcm16, inputEnergy } from "./conversation-call-utils.mjs";

const VOICE_CAPTURE_WARMUP_SECONDS = 0.6;
const VOICE_ENERGY_THRESHOLD = 0.025;
const VOICE_SILENCE_FRAME_COUNT = 9;

function clean(value) {
  return String(value ?? "").trim();
}

function createAudioState(token) {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) throw new Error("当前运行环境不支持麦克风录音。 ");
  return {
    audioContext: new AudioContextConstructor({ latencyHint: "interactive" }),
    captureReadyAt: 0,
    hasSpoken: false,
    processor: null,
    sendingUtterance: false,
    silentGain: null,
    silenceFrames: 0,
    source: null,
    stream: null,
    token,
    voiceEnergyThreshold: VOICE_ENERGY_THRESHOLD,
    voiceSilenceFrames: VOICE_SILENCE_FRAME_COUNT,
  };
}

const EMPTY_VOICE_INPUT_CONTROL = Object.freeze({
  active: false,
  available: false,
  label: "语音输入",
  toggle: async () => false,
});

/**
 * The composer only captures one short utterance.  The process keeps the
 * recognized text in the ordinary draft instead of directly creating an Agent
 * turn, so it behaves like typing and remains reviewable before sending.
 */
export function useConversationVoiceInput({
  active = false,
  api = null,
  onError = () => {},
  onStart = () => {},
  onTranscript = () => {},
  scopeKey = "",
} = {}) {
  const [input, setInput] = useState(null);
  const apiRef = useRef(api);
  const audioRef = useRef(null);
  const inputRef = useRef(null);
  const onErrorRef = useRef(onError);
  const onStartRef = useRef(onStart);
  const onTranscriptRef = useRef(onTranscript);

  useLayoutEffect(() => {
    if (api) apiRef.current = api;
    onErrorRef.current = onError;
    onStartRef.current = onStart;
    onTranscriptRef.current = onTranscript;
  }, [api, onError, onStart, onTranscript]);

  const replaceInput = useCallback((next) => {
    inputRef.current = next;
    setInput(next);
  }, []);

  const patchInput = useCallback((patch) => {
    const previous = inputRef.current;
    if (!previous) return null;
    const next = typeof patch === "function" ? patch(previous) : { ...previous, ...patch };
    if (!next || next === previous) return previous;
    replaceInput(next);
    return next;
  }, [replaceInput]);

  const isCurrentInput = useCallback((token) => inputRef.current?.token === token, []);

  const reportError = useCallback((message) => {
    const text = clean(message);
    if (text) onErrorRef.current?.(text);
  }, []);

  const disposeAudio = useCallback(async (token = null) => {
    const audio = audioRef.current;
    if (!audio || (token && audio.token !== token)) return null;
    try { audio.processor && (audio.processor.onaudioprocess = null); } catch { /* A closed processor needs no work. */ }
    try { audio.processor?.disconnect?.(); } catch { /* A disconnected node needs no work. */ }
    try { audio.source?.disconnect?.(); } catch { /* A disconnected node needs no work. */ }
    try { audio.silentGain?.disconnect?.(); } catch { /* A disconnected node needs no work. */ }
    for (const track of audio.stream?.getTracks?.() || []) track.stop();
    if (audioRef.current === audio) audioRef.current = null;
    try { await audio.audioContext?.close?.(); } catch { /* The renderer may already be shutting down. */ }
    return audio;
  }, []);

  const stopRemote = useCallback(async (inputId) => {
    const voiceApi = apiRef.current?.conversation?.voiceInput;
    if (!inputId || typeof voiceApi?.stop !== "function") return false;
    try {
      await voiceApi.stop({ inputId });
      return true;
    } catch {
      return false;
    }
  }, []);

  const cancelCurrentInput = useCallback(async () => {
    const current = inputRef.current;
    if (!current) return false;
    const token = current.token;
    const inputId = current.id;
    patchInput({ phase: "cancelling" });
    await disposeAudio(token);
    await stopRemote(inputId);
    if (isCurrentInput(token)) replaceInput(null);
    return true;
  }, [disposeAudio, isCurrentInput, patchInput, replaceInput, stopRemote]);

  const finishRecording = useCallback(async ({ commit = true } = {}) => {
    const current = inputRef.current;
    if (!current) return false;
    if (current.phase !== "recording") return cancelCurrentInput();
    const token = current.token;
    const inputId = current.id;
    const audio = audioRef.current;
    const hasSpoken = Boolean(audio?.hasSpoken);
    patchInput({ phase: commit ? "transcribing" : "cancelling" });
    await disposeAudio(token);
    if (!commit || !hasSpoken) {
      await stopRemote(inputId);
      if (isCurrentInput(token)) replaceInput(null);
      if (commit && !hasSpoken) reportError("没有识别到声音，请靠近麦克风后再试。 ");
      return false;
    }
    const voiceApi = apiRef.current?.conversation?.voiceInput;
    if (typeof voiceApi?.commit !== "function") {
      await stopRemote(inputId);
      if (isCurrentInput(token)) replaceInput(null);
      reportError("当前版本没有加载语音输入功能。 ");
      return false;
    }
    try {
      const result = await voiceApi.commit({ inputId });
      if (!result?.accepted || !result?.committed) throw new Error("这段语音没有成功提交。 ");
      return true;
    } catch (error) {
      await stopRemote(inputId);
      if (isCurrentInput(token)) replaceInput(null);
      reportError(`无法识别这段语音：${error?.message || error}`);
      return false;
    }
  }, [cancelCurrentInput, disposeAudio, isCurrentInput, patchInput, replaceInput, reportError, stopRemote]);

  const startMicrophone = useCallback(async (token, inputId) => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前环境无法读取麦克风。 ");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    const audio = audioRef.current;
    const current = inputRef.current;
    if (!audio || audio.token !== token || !current || current.token !== token || current.id !== inputId) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    audio.stream = stream;
    // Desktop gain control can briefly spike when a stream opens.  Ignore that
    // warm-up pulse rather than treating it as the user's sentence.
    audio.captureReadyAt = audio.audioContext.currentTime + VOICE_CAPTURE_WARMUP_SECONDS;
    audio.source = audio.audioContext.createMediaStreamSource(stream);
    audio.processor = audio.audioContext.createScriptProcessor(2048, 1, 1);
    audio.silentGain = audio.audioContext.createGain();
    audio.silentGain.gain.value = 0;
    audio.source.connect(audio.processor);
    audio.processor.connect(audio.silentGain);
    audio.silentGain.connect(audio.audioContext.destination);
    audio.processor.onaudioprocess = (event) => {
      const currentInput = inputRef.current;
      if (!currentInput || currentInput.token !== token || currentInput.id !== inputId || audioRef.current !== audio) return;
      if (audio.audioContext.currentTime < audio.captureReadyAt) return;
      const samples = event.inputBuffer.getChannelData(0);
      const energy = inputEnergy(samples);
      if (energy >= audio.voiceEnergyThreshold) {
        audio.hasSpoken = true;
        audio.sendingUtterance = true;
        audio.silenceFrames = 0;
        const pcm = downsamplePcm16(samples, audio.audioContext.sampleRate, 16_000);
        if (pcm.length) {
          const payload = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
          apiRef.current?.conversation?.voiceInput?.audio?.({ inputId, audio: payload });
        }
        return;
      }
      if (!audio.sendingUtterance) return;
      audio.silenceFrames += 1;
      if (audio.silenceFrames < audio.voiceSilenceFrames) return;
      audio.sendingUtterance = false;
      void finishRecording({ commit: true });
    };
  }, [finishRecording]);

  const start = useCallback(async () => {
    if (!active) return false;
    const existing = inputRef.current;
    if (existing) return finishRecording({ commit: existing.phase === "recording" });
    const voiceApi = apiRef.current?.conversation?.voiceInput;
    if (typeof voiceApi?.start !== "function") {
      reportError("当前版本没有加载语音输入功能。 ");
      return false;
    }
    onStartRef.current?.();
    const token = Symbol("conversation-voice-input");
    let audio;
    try {
      audio = createAudioState(token);
      await audio.audioContext.resume?.();
    } catch (error) {
      reportError(`无法初始化录音：${error?.message || error}`);
      return false;
    }
    audioRef.current = audio;
    replaceInput({ id: "", phase: "starting", preview: "", token });
    try {
      const result = await voiceApi.start();
      if (!isCurrentInput(token)) {
        const returnedInputId = clean(result?.inputId);
        if (returnedInputId) await stopRemote(returnedInputId);
        return false;
      }
      const inputId = clean(result?.inputId);
      if (!inputId) throw new Error("语音输入服务没有返回识别标识。 ");
      const threshold = Number(result?.voiceEnergyThreshold);
      const frames = Number(result?.voiceSilenceFrames);
      if (Number.isFinite(threshold) && threshold >= 0.001 && threshold <= 1) audio.voiceEnergyThreshold = threshold;
      if (Number.isFinite(frames) && frames >= 1 && frames <= 120) audio.voiceSilenceFrames = Math.round(frames);
      patchInput((previous) => ({ ...previous, id: inputId, phase: "starting" }));
      await startMicrophone(token, inputId);
      if (!isCurrentInput(token)) return false;
      patchInput({ phase: "recording" });
      return true;
    } catch (error) {
      const current = inputRef.current;
      if (current?.token === token && current.id) await stopRemote(current.id);
      await disposeAudio(token);
      if (isCurrentInput(token)) replaceInput(null);
      reportError(`无法开始语音输入：${error?.message || error}`);
      return false;
    }
  }, [active, disposeAudio, finishRecording, isCurrentInput, patchInput, replaceInput, reportError, startMicrophone, stopRemote]);

  const handleVoiceInputEvent = useCallback((event) => {
    const current = inputRef.current;
    if (!current || !current.id || clean(event?.inputId) !== current.id) return;
    const token = current.token;
    if (event.type === "voice-input-transcript") {
      const text = clean(event.text);
      if (!text) return;
      if (event.final === true) {
        onTranscriptRef.current?.(text);
        void disposeAudio(token);
        if (isCurrentInput(token)) replaceInput(null);
      } else {
        patchInput({ preview: text, phase: current.phase === "recording" ? "recording" : "transcribing" });
      }
      return;
    }
    if (event.type === "voice-input-error") {
      reportError(clean(event.message) || "语音输入出了点问题。 ");
      void disposeAudio(token);
      if (isCurrentInput(token)) replaceInput(null);
      return;
    }
    if (event.type === "voice-input-ended" && current.phase !== "cancelling") {
      void disposeAudio(token);
      if (isCurrentInput(token)) replaceInput(null);
    }
  }, [disposeAudio, isCurrentInput, patchInput, replaceInput, reportError]);

  useEffect(() => {
    if (!active || typeof api?.conversation?.onEvent !== "function") return undefined;
    return api.conversation.onEvent(handleVoiceInputEvent);
  }, [active, api, handleVoiceInputEvent]);

  useEffect(() => {
    if (!active) void cancelCurrentInput();
  }, [active, cancelCurrentInput]);

  useEffect(() => () => {
    void cancelCurrentInput();
  }, [cancelCurrentInput, scopeKey]);

  if (!active) return EMPTY_VOICE_INPUT_CONTROL;
  const phase = clean(input?.phase);
  return {
    active: Boolean(input),
    available: typeof api?.conversation?.voiceInput?.start === "function",
    label: phase === "recording" ? "正在聆听，点击结束" : phase === "transcribing" ? "正在识别，点击取消" : "语音输入",
    toggle: start,
  };
}
