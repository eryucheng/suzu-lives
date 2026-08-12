import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { registerConversationCallEndHandler } from "./conversation-call-coordinator.mjs";
import {
  callStatusLabel,
  cleanCallText,
  downsamplePcm16,
  inputEnergy,
} from "./conversation-call-utils.mjs";

const ConversationCallContext = createContext(null);
const VOICE_ENERGY_THRESHOLD = 0.025;
const VOICE_CAPTURE_WARMUP_SECONDS = 0.6;
// ScriptProcessor emits roughly one frame every 40–45 ms on desktop.  Nine
// quiet frames therefore make a short pause the end of the current sentence.
const VOICE_SILENCE_FRAME_COUNT = 9;

const EMPTY_CALL_CONTROL = Object.freeze({
  active: false,
  available: false,
  call: null,
  end: async () => false,
  open: async () => false,
  startError: "",
});

function createAudioState(token) {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) throw new Error("当前运行环境不支持实时音频。 ");
  return {
    audioContext: new AudioContextConstructor({ latencyHint: "interactive" }),
    captureReadyAt: 0,
    commitPending: false,
    currentSource: null,
    epoch: 0,
    hasSpoken: false,
    lastInterruptAt: 0,
    nextIndex: 0,
    pending: new Map(),
    processor: null,
    sendingUtterance: false,
    silentGain: null,
    silenceFrames: 0,
    source: null,
    skipped: new Set(),
    stream: null,
    token,
  };
}

function base64ToAudioBuffer(value) {
  const source = String(value || "");
  const binary = window.atob(source);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function callIdentity(snapshot) {
  const contact = snapshot?.call?.contact || {};
  return {
    avatar: contact.avatar || null,
    contactName: cleanCallText(contact.name) || "联系人",
  };
}

export function useConversationCall() {
  return useContext(ConversationCallContext) || EMPTY_CALL_CONTROL;
}

export function ConversationCallProvider({ active = false, api = null, snapshot = null, children }) {
  const [call, setCall] = useState(null);
  const [startError, setStartError] = useState("");
  const apiRef = useRef(api);
  const audioRef = useRef(null);
  const callRef = useRef(null);
  const partialRenderRef = useRef({ lastRenderAt: 0, pending: null, timer: null });
  const playNextAudioRef = useRef(() => {});
  const snapshotRef = useRef(snapshot);

  useLayoutEffect(() => {
    if (api) apiRef.current = api;
    snapshotRef.current = snapshot;
  }, [api, snapshot]);

  const replaceCall = useCallback((next) => {
    callRef.current = next;
    setCall(next);
  }, []);

  const patchCall = useCallback((patch) => {
    const previous = callRef.current;
    if (!previous) return null;
    const next = typeof patch === "function" ? patch(previous) : { ...previous, ...patch };
    if (!next || next === previous) return previous;
    replaceCall(next);
    return next;
  }, [replaceCall]);

  const isCurrentCall = useCallback((token) => callRef.current?.token === token, []);

  const clearPartialTranscriptRender = useCallback(() => {
    const state = partialRenderRef.current;
    if (state.timer) window.clearTimeout(state.timer);
    state.timer = null;
    state.pending = null;
  }, []);

  const stopPlayback = useCallback((audio = audioRef.current) => {
    if (!audio) return;
    audio.epoch += 1;
    audio.pending.clear();
    audio.skipped.clear();
    audio.nextIndex = 0;
    const source = audio.currentSource;
    audio.currentSource = null;
    try { source?.stop?.(); } catch { /* The source may already have ended. */ }
  }, []);

  const disposeAudio = useCallback(async (token = null) => {
    const audio = audioRef.current;
    if (!audio || (token && audio.token !== token)) return;
    stopPlayback(audio);
    try { audio.processor?.disconnect?.(); } catch { /* A disconnected node needs no work. */ }
    try { audio.source?.disconnect?.(); } catch { /* A disconnected node needs no work. */ }
    try { audio.silentGain?.disconnect?.(); } catch { /* A disconnected node needs no work. */ }
    for (const track of audio.stream?.getTracks?.() || []) track.stop();
    if (audioRef.current === audio) audioRef.current = null;
    try { await audio.audioContext?.close?.(); } catch { /* The renderer may already be shutting down. */ }
  }, [stopPlayback]);

  const playNextAudio = useCallback((token) => {
    const audio = audioRef.current;
    if (!audio || audio.token !== token || audio.currentSource) return;
    while (audio.skipped.delete(audio.nextIndex)) audio.nextIndex += 1;
    if (!audio.pending.has(audio.nextIndex)) return;
    const buffer = audio.pending.get(audio.nextIndex);
    audio.pending.delete(audio.nextIndex);
    audio.nextIndex += 1;
    const source = audio.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audio.audioContext.destination);
    audio.currentSource = source;
    source.onended = () => {
      if (audio.currentSource !== source) return;
      audio.currentSource = null;
      playNextAudioRef.current(token);
      const current = callRef.current;
      if (!audio.currentSource && !audio.pending.size && current?.token === token && current.phase === "speaking") {
        patchCall({ phase: "listening", label: "正在听你说…" });
      }
    };
    source.start();
  }, [patchCall]);

  playNextAudioRef.current = playNextAudio;

  const schedulePartialTranscriptRender = useCallback((token, text) => {
    const state = partialRenderRef.current;
    const render = () => {
      state.timer = null;
      const pending = state.pending;
      state.pending = null;
      if (!pending || !isCurrentCall(pending.token)) return;
      state.lastRenderAt = Date.now();
      patchCall({ partialTranscript: pending.text });
    };
    const now = Date.now();
    if (now - state.lastRenderAt >= 120) {
      state.pending = { token, text };
      render();
      return;
    }
    state.pending = { token, text };
    if (!state.timer) state.timer = window.setTimeout(render, 120 - (now - state.lastRenderAt));
  }, [isCurrentCall, patchCall]);

  const receiveAudio = useCallback(async (event) => {
    const current = callRef.current;
    const audio = audioRef.current;
    if (!current || !audio || audio.token !== current.token || cleanCallText(event?.callId) !== current.id) return;
    const index = Number(event.index);
    if (!Number.isSafeInteger(index) || index < 0) return;
    const token = current.token;
    const epoch = audio.epoch;
    try {
      const input = base64ToAudioBuffer(event.audioBase64);
      const decoded = await audio.audioContext.decodeAudioData(input);
      if (!isCurrentCall(token) || audioRef.current !== audio || audio.epoch !== epoch) return;
      audio.pending.set(index, decoded);
      patchCall({ phase: "speaking", label: "正在说话…" });
      playNextAudioRef.current(token);
    } catch (error) {
      if (!isCurrentCall(token) || audioRef.current !== audio) return;
      audio.skipped.add(index);
      playNextAudioRef.current(token);
      patchCall({ error: `无法播放这段语音：${error?.message || error}` });
    }
  }, [isCurrentCall, patchCall]);

  const interruptFromSpeech = useCallback(async (token) => {
    const current = callRef.current;
    const audio = audioRef.current;
    if (!current || !audio || current.token !== token || audio.token !== token || !current.id) return;
    if (current.phase !== "speaking" && current.phase !== "thinking") return;
    const now = Date.now();
    if (now - audio.lastInterruptAt < 600) return;
    audio.lastInterruptAt = now;
    stopPlayback(audio);
    patchCall({ phase: "listening", label: "正在听你说…" });
    try {
      await apiRef.current?.conversation?.call?.interrupt?.({ callId: current.id });
    } catch (error) {
      if (isCurrentCall(token)) patchCall({ error: `无法打断回复：${error?.message || error}` });
    }
  }, [isCurrentCall, patchCall, stopPlayback]);

  const commitUtterance = useCallback(async (token) => {
    const current = callRef.current;
    const audio = audioRef.current;
    if (!current || !audio || current.token !== token || audio.token !== token || !current.id || !audio.hasSpoken || audio.commitPending) return;
    const callApi = apiRef.current?.conversation?.call;
    if (!callApi?.commit) {
      patchCall({ error: "当前版本没有加载语音断句功能。" });
      return;
    }
    audio.hasSpoken = false;
    audio.commitPending = true;
    patchCall({ phase: "thinking", label: "正在理解你说的话…" });
    try {
      const result = await callApi.commit({ callId: current.id });
      if (!result?.accepted || !result?.committed) throw new Error("本句音频没有成功提交。");
    } catch (error) {
      if (isCurrentCall(token)) patchCall({
        error: `无法提交这句话：${error?.message || error}`,
        phase: "listening",
        label: "正在听你说…",
      });
    } finally {
      if (audioRef.current === audio) audio.commitPending = false;
    }
  }, [isCurrentCall, patchCall]);

  const updateVoiceActivity = useCallback((token, energy) => {
    const current = callRef.current;
    const audio = audioRef.current;
    if (!current || !audio || current.token !== token || audio.token !== token) return "";
    if (energy >= VOICE_ENERGY_THRESHOLD) {
      audio.silenceFrames = 0;
      if (!audio.sendingUtterance) {
        audio.sendingUtterance = true;
        audio.hasSpoken = true;
        void interruptFromSpeech(token);
        return "started";
      }
      return "active";
    }
    if (!audio.sendingUtterance) return "";
    audio.silenceFrames += 1;
    if (audio.silenceFrames >= VOICE_SILENCE_FRAME_COUNT) {
      audio.sendingUtterance = false;
      return "ended";
    }
    return "";
  }, [interruptFromSpeech]);

  const startMicrophone = useCallback(async (token, callId) => {
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
    const current = callRef.current;
    if (!audio || audio.token !== token || !current || current.token !== token || current.id !== callId) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    audio.stream = stream;
    // Windows' capture pipeline can emit a short gain-control transient right
    // after a stream opens.  Do not treat that startup pulse as a sentence.
    audio.captureReadyAt = audio.audioContext.currentTime + VOICE_CAPTURE_WARMUP_SECONDS;
    audio.source = audio.audioContext.createMediaStreamSource(stream);
    // 2,048 frames keeps capture chunks around 40–45 ms on the usual desktop
    // sample rates, short enough for a conversational turn without flooding IPC.
    audio.processor = audio.audioContext.createScriptProcessor(2048, 1, 1);
    audio.silentGain = audio.audioContext.createGain();
    audio.silentGain.gain.value = 0;
    audio.source.connect(audio.processor);
    audio.processor.connect(audio.silentGain);
    audio.silentGain.connect(audio.audioContext.destination);
    audio.processor.onaudioprocess = (event) => {
      const activeCall = callRef.current;
      if (!activeCall || activeCall.token !== token || activeCall.id !== callId || audioRef.current !== audio) return;
      if (audio.audioContext.currentTime < audio.captureReadyAt) return;
      const input = event.inputBuffer.getChannelData(0);
      const energy = inputEnergy(input);
      const voiceTransition = updateVoiceActivity(token, energy);
      if (energy >= VOICE_ENERGY_THRESHOLD) {
        const pcm = downsamplePcm16(input, audio.audioContext.sampleRate, 16000);
        if (pcm.length) {
          const payload = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
          apiRef.current?.conversation?.call?.audio?.({ callId, audio: payload });
        }
      }
      if (voiceTransition === "ended") {
        void commitUtterance(token);
      }
    };
  }, [commitUtterance, updateVoiceActivity]);

  const end = useCallback(async () => {
    const current = callRef.current;
    if (!current || current.ending) return false;
    const token = current.token;
    patchCall({ ending: true, phase: "ending", label: "正在挂断…" });
    try {
      if (current.id) await apiRef.current?.conversation?.call?.stop?.({ callId: current.id });
    } catch (error) {
      if (isCurrentCall(token)) patchCall({ error: `无法挂断通话：${error?.message || error}` });
    } finally {
      clearPartialTranscriptRender();
      await disposeAudio(token);
      if (isCurrentCall(token)) replaceCall(null);
    }
    return true;
  }, [clearPartialTranscriptRender, disposeAudio, isCurrentCall, patchCall, replaceCall]);

  const start = useCallback(async () => {
    const existing = callRef.current;
    if (existing) return true;
    const callApi = apiRef.current?.conversation?.call;
    if (!callApi?.start) {
      setStartError("当前版本没有加载实时语音通话。");
      return false;
    }
    const token = Symbol("conversation-call");
    let audio;
    try {
      audio = createAudioState(token);
      await audio.audioContext.resume?.();
    } catch (error) {
      setStartError(`无法初始化通话音频：${error?.message || error}`);
      return false;
    }
    audioRef.current = audio;
    const identity = callIdentity(snapshotRef.current);
    replaceCall({
      ...identity,
      ending: false,
      error: "",
      id: "",
      label: "正在接通…",
      lastTranscript: "",
      partialTranscript: "",
      phase: "connecting",
      token,
    });
    setStartError("");
    try {
      const result = await callApi.start();
      if (!isCurrentCall(token)) {
        const returnedCallId = cleanCallText(result?.callId);
        if (returnedCallId && typeof callApi.stop === "function") await callApi.stop({ callId: returnedCallId }).catch(() => undefined);
        return false;
      }
      const callId = cleanCallText(result?.callId);
      if (!callId) throw new Error("通话服务没有返回通话标识。 ");
      patchCall((current) => ({
        ...current,
        contactName: cleanCallText(result?.contactName) || current.contactName,
        id: callId,
      }));
      await startMicrophone(token, callId);
      if (!isCurrentCall(token)) return false;
      patchCall({ phase: "listening", label: "正在听你说…" });
      return true;
    } catch (error) {
      const current = callRef.current;
      if (current?.token === token && current.id && typeof callApi.stop === "function") await callApi.stop({ callId: current.id }).catch(() => undefined);
      await disposeAudio(token);
      if (isCurrentCall(token)) {
        replaceCall(null);
        setStartError(`无法开始语音通话：${error?.message || error}`);
      }
      return false;
    }
  }, [disposeAudio, isCurrentCall, patchCall, replaceCall, startMicrophone]);

  const handleCallEvent = useCallback((event) => {
    const current = callRef.current;
    if (!current || !current.id || cleanCallText(event?.callId) !== current.id) return;
    const token = current.token;
    if (event.type === "call-state") {
      patchCall((previous) => ({
        ...previous,
        error: cleanCallText(event.state) === "speaking" ? previous.error : "",
        label: cleanCallText(event.label) || previous.label,
        phase: cleanCallText(event.state) || previous.phase,
      }));
      return;
    }
    if (event.type === "call-transcript") {
      const text = cleanCallText(event.text);
      if (event.final) {
        clearPartialTranscriptRender();
        patchCall({ lastTranscript: text, partialTranscript: "" });
      } else {
        schedulePartialTranscriptRender(token, text);
      }
      return;
    }
    if (event.type === "call-clear-audio") {
      stopPlayback();
      patchCall({ phase: "listening", label: "正在听你说…" });
      return;
    }
    if (event.type === "call-audio") {
      void receiveAudio(event);
      return;
    }
    if (event.type === "call-audio-skip") {
      const audio = audioRef.current;
      const index = Number(event.index);
      if (audio?.token === token && Number.isSafeInteger(index) && index >= 0) {
        audio.skipped.add(index);
        playNextAudioRef.current(token);
      }
      return;
    }
    if (event.type === "call-error") {
      patchCall({ phase: "error", error: cleanCallText(event.message) || "通话出了点问题。" });
      return;
    }
    if (event.type === "call-ended") {
      clearPartialTranscriptRender();
      void disposeAudio(token);
      if (isCurrentCall(token)) replaceCall(null);
    }
  }, [clearPartialTranscriptRender, disposeAudio, isCurrentCall, patchCall, replaceCall, schedulePartialTranscriptRender, stopPlayback, receiveAudio]);

  useEffect(() => {
    if (!active || typeof api?.conversation?.onEvent !== "function") return undefined;
    return api.conversation.onEvent(handleCallEvent);
  }, [active, api, handleCallEvent]);

  useEffect(() => {
    if (!active) {
      setStartError("");
      void end();
    }
  }, [active, end]);

  useEffect(() => registerConversationCallEndHandler(end), [end]);

  useEffect(() => () => {
    clearPartialTranscriptRender();
    void end();
  }, [clearPartialTranscriptRender, end]);

  const value = useMemo(() => ({
    active: Boolean(call),
    available: Boolean(snapshot?.call?.available),
    call: call ? {
      ...call,
      status: callStatusLabel(call),
      transcript: cleanCallText(call.partialTranscript) || cleanCallText(call.lastTranscript),
      transcriptLabel: call.partialTranscript ? "你正在说" : "你说",
    } : null,
    end,
    open: start,
    startError,
  }), [call, end, snapshot?.call?.available, start, startError]);

  return <ConversationCallContext.Provider value={value}>{children}</ConversationCallContext.Provider>;
}
