import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createRealtimeVoiceCallService,
  realtimeAsrWebSocketUrl,
  takeCallSpeechSegments,
} from "../electron/services/realtime-voice-call.mjs";

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate, attempts = 24) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.fail("等待异步通话操作超时。 ");
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    queueMicrotask(() => this.emit("open"));
  }

  send(value) {
    this.sent.push(String(value));
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from(""));
  }
}

test("realtime call uses the configured contact voice and streams ASR audio", async () => {
  const events = [];
  const ledgerEvents = [];
  const sentTurns = [];
  const stoppedTurns = [];
  let chatSubscriber = null;
  let socket = null;
  let runtimeSeen = null;
  const chat = {
    sendToSession: async (value) => {
      sentTurns.push(value);
      return { accepted: true, requestId: value.requestId, sessionId: value.sessionId };
    },
    stop: async (value) => {
      stoppedTurns.push(value);
      return { accepted: true, stopped: true };
    },
    subscribe: (callback) => {
      chatSubscriber = callback;
      return () => { chatSubscriber = null; };
    },
  };
  const service = createRealtimeVoiceCallService({
    chat,
    connectionsService: { resolveDashScope: async () => ({ key: "dashscope-key", baseUrl: "https://dashscope.aliyuncs.com/api/v1" }) },
    dataRootProvider: () => "D:/suzu-data",
    ledgerPathProvider: () => "D:/suzu-data/usage.json",
    appendLedger: async (ledgerPath, event) => ledgerEvents.push({ ledgerPath, event }),
    onEvent: (event) => events.push(event),
    reader: {
      snapshot: async () => ({ activeContact: { agentId: "agent-suzu", name: "Suzu" } }),
      ensureActiveSession: async () => ({ id: "session-suzu", projectRoot: "D:/project", hasTranscript: true }),
    },
    reconnectDelaysMs: [0],
    resolveVoiceRuntime: ({ agentId }) => ({
      agentId,
      tts: { provider: "minimax", apiKey: "minimax-key", voiceId: "voice-suzu", model: "speech-2.8" },
    }),
    settingsService: { load: () => ({}) },
    synthesizeVoice: async (value) => {
      runtimeSeen = value.runtime;
      return { audio: Buffer.from("voice-bytes"), format: "mp3" };
    },
    webSocketFactory: () => {
      socket = new FakeSocket();
      return socket;
    },
  });

  const started = await service.start({ senderId: "renderer-1" });
  assert.match(started.callId, /^call-/u);
  assert.equal(started.contactName, "Suzu");
  assert.equal(socket, null);

  const audio = new Int16Array([0, 1, -1, 2048]);
  assert.deepEqual(service.pushAudio({ callId: started.callId, senderId: "renderer-1", audio: audio.buffer }), { accepted: true });
  assert.deepEqual(await service.commitAudio({ callId: started.callId, senderId: "renderer-1" }), { accepted: true, committed: true });
  assert.ok(socket);
  assert.equal(JSON.parse(socket.sent[0]).type, "session.update");
  assert.equal(JSON.parse(socket.sent[0]).session.turn_detection, null);
  assert.equal(JSON.parse(socket.sent[1]).type, "input_audio_buffer.append");
  assert.equal(JSON.parse(socket.sent[2]).type, "input_audio_buffer.commit");

  socket.emit("message", Buffer.from(JSON.stringify({
    type: "conversation.item.input_audio_transcription.text",
    text: "你",
    stash: "好",
  })));
  assert.equal(events.at(-1).text, "你好");

  socket.emit("message", Buffer.from(JSON.stringify({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "你好，能听见吗？",
  })));
  await flush();
  assert.equal(sentTurns.length, 1);
  assert.equal(sentTurns[0].kind, "call");
  assert.equal(sentTurns[0].content, "你好，能听见吗？");
  assert.equal(sentTurns[0].deliverToWechat, false);
  assert.match(sentTurns[0].requestId, /^suzu-call-/u);
  assert.equal(ledgerEvents.length, 1);
  assert.equal(ledgerEvents[0].ledgerPath, "D:/suzu-data/usage.json");
  assert.equal(ledgerEvents[0].event.feature, "realtime-voice-call-asr");
  assert.equal(ledgerEvents[0].event.units.inputAudioSeconds, audio.byteLength / 32_000);

  chatSubscriber({
    type: "reply-stream",
    kind: "call",
    requestId: sentTurns[0].requestId,
    sessionId: "session-suzu",
    projectRoot: "D:/project",
    content: "当然能听见。今天过得怎么样？",
  });
  await flush();
  assert.equal(runtimeSeen.tts.voiceId, "voice-suzu");
  const voice = events.find((event) => event.type === "call-audio");
  assert.ok(voice);
  assert.equal(voice.index, 0);
  assert.equal(voice.audioBase64, Buffer.from("voice-bytes").toString("base64"));

  assert.deepEqual(service.pushAudio({ callId: started.callId, senderId: "renderer-1", audio: audio.buffer }), { accepted: true });
  socket.emit("message", Buffer.from(JSON.stringify({ type: "input_audio_buffer.speech_started" })));
  await flush();
  assert.ok(events.some((event) => event.type === "call-clear-audio"));
  assert.equal(stoppedTurns.at(-1).requestId, sentTurns[0].requestId);

  const stopsBeforeHangup = stoppedTurns.length;
  const stopped = await service.stop({ callId: started.callId, senderId: "renderer-1" });
  assert.deepEqual(stopped, { accepted: true, stopped: true });
  assert.equal(stoppedTurns.length, stopsBeforeHangup);
  assert.ok(events.some((event) => event.type === "call-ended"));
  assert.deepEqual(
    service.pushAudio({
      callId: started.callId,
      senderId: "renderer-1",
      audio: new Int16Array([0]).buffer,
    }),
    { accepted: false, reason: "inactive" },
  );
  assert.deepEqual(
    await service.commitAudio({ callId: started.callId, senderId: "renderer-1" }),
    { accepted: false, committed: false, reason: "inactive" },
  );
});

test("a connected call asks Claude for one greeting, speaks it, and lets the first utterance interrupt it", async () => {
  const events = [];
  const sentTurns = [];
  const stoppedTurns = [];
  const spoken = [];
  let chatSubscriber = null;
  const chat = {
    sendToSession: async (value) => {
      sentTurns.push(value);
      return { accepted: true, requestId: value.requestId, sessionId: value.sessionId };
    },
    stop: async (value) => {
      stoppedTurns.push(value);
      return { accepted: true, stopped: true };
    },
    subscribe: (callback) => {
      chatSubscriber = callback;
      return () => { chatSubscriber = null; };
    },
  };
  const service = createRealtimeVoiceCallService({
    chat,
    connectionsService: { resolveDashScope: async () => ({ key: "dashscope-key", baseUrl: "https://dashscope.aliyuncs.com/api/v1" }) },
    dataRootProvider: () => "D:/suzu-data",
    ledgerPathProvider: () => "D:/suzu-data/usage.json",
    onEvent: (event) => events.push(event),
    reader: {
      snapshot: async () => ({ activeContact: { agentId: "agent-suzu", name: "Suzu" } }),
      ensureActiveSession: async () => ({ id: "session-suzu", projectRoot: "D:/project", hasTranscript: true }),
    },
    resolveVoiceRuntime: ({ agentId }) => ({
      agentId,
      tts: { provider: "minimax", apiKey: "minimax-key", voiceId: "voice-suzu", model: "speech-2.8" },
    }),
    settingsService: { load: () => ({}) },
    synthesizeVoice: async ({ text }) => {
      spoken.push(text);
      return { audio: Buffer.from("voice-bytes"), format: "mp3" };
    },
  });

  const started = await service.start({ senderId: "renderer-1", initiator: "agent" });
  const opening = await service.open({ callId: started.callId, senderId: "renderer-1" });
  assert.deepEqual(opening, { accepted: true, opened: true });
  assert.equal(sentTurns.length, 1);
  assert.equal(sentTurns[0].kind, "call-open");
  assert.equal(sentTurns[0].content, "");
  assert.equal(sentTurns[0].callDirection, "agent");
  assert.equal(sentTurns[0].deliverToWechat, false);
  assert.match(sentTurns[0].requestId, /^suzu-call-open-/u);
  assert.deepEqual(
    await service.open({ callId: started.callId, senderId: "renderer-1" }),
    { accepted: true, opened: false, reason: "opened" },
  );

  chatSubscriber({
    type: "reply-stream",
    kind: "call-open",
    requestId: sentTurns[0].requestId,
    sessionId: "session-suzu",
    projectRoot: "D:/project",
    content: "喂，我在。",
  });
  await flush();
  assert.deepEqual(spoken, ["喂，我在。"]);
  assert.ok(events.some((event) => event.type === "call-audio" && event.text === "喂，我在。"));

  assert.deepEqual(
    await service.interrupt({ callId: started.callId, senderId: "renderer-1" }),
    { accepted: true, interrupted: true },
  );
  assert.equal(stoppedTurns.at(-1).requestId, sentTurns[0].requestId);
  await service.stop({ callId: started.callId, senderId: "renderer-1" });
});

test("call speech queues clauses so the next synthesis starts while the prior audio can play", async () => {
  const events = [];
  const pendingSynthesis = [];
  const requestStarts = [];
  const sentTurns = [];
  const startedSynthesis = [];
  const waits = [];
  let clock = 0;
  let chatSubscriber = null;
  const chat = {
    sendToSession: async (value) => {
      sentTurns.push(value);
      return { accepted: true, requestId: value.requestId, sessionId: value.sessionId };
    },
    stop: async () => ({ accepted: true, stopped: true }),
    subscribe: (callback) => {
      chatSubscriber = callback;
      return () => { chatSubscriber = null; };
    },
  };
  const service = createRealtimeVoiceCallService({
    chat,
    connectionsService: { resolveDashScope: async () => ({ key: "dashscope-key" }) },
    dataRootProvider: () => "D:/suzu-data",
    ledgerPathProvider: () => "D:/suzu-data/usage.json",
    now: () => clock,
    onEvent: (event) => events.push(event),
    reader: {
      snapshot: async () => ({ activeContact: { agentId: "agent-suzu", name: "Suzu" } }),
      ensureActiveSession: async () => ({ id: "session-suzu", projectRoot: "D:/project", hasTranscript: true }),
    },
    resolveVoiceRuntime: ({ agentId }) => ({
      agentId,
      tts: { provider: "cosyvoice", apiKey: "dashscope-key", voice: "voice-suzu", model: "cosyvoice-v3.5-plus" },
    }),
    settingsService: { load: () => ({}) },
    sleep: async (delay, signal) => {
      waits.push(delay);
      clock += delay;
      return !signal?.aborted;
    },
    synthesizeVoice: ({ text }) => new Promise((resolve) => {
      requestStarts.push(clock);
      startedSynthesis.push(text);
      pendingSynthesis.push(resolve);
    }),
  });

  const started = await service.start({ senderId: "renderer-1" });
  await service.open({ callId: started.callId, senderId: "renderer-1" });
  chatSubscriber({
    type: "reply",
    kind: "call-open",
    requestId: sentTurns[0].requestId,
    sessionId: "session-suzu",
    projectRoot: "D:/project",
    content: "第一句。第二句。第三句。",
  });
  await waitFor(() => startedSynthesis.length === 1);
  assert.deepEqual(startedSynthesis, ["第一句。"]);

  pendingSynthesis.shift()({ audio: Buffer.from("first"), format: "mp3" });
  await waitFor(() => startedSynthesis.length === 2);
  assert.deepEqual(startedSynthesis, ["第一句。", "第二句。"]);

  pendingSynthesis.shift()({ audio: Buffer.from("second"), format: "mp3" });
  await waitFor(() => startedSynthesis.length === 3);
  assert.deepEqual(startedSynthesis, ["第一句。", "第二句。", "第三句。"]);

  pendingSynthesis.shift()({ audio: Buffer.from("third"), format: "mp3" });
  await waitFor(() => events.filter((event) => event.type === "call-audio").length === 3);
  assert.deepEqual(events.filter((event) => event.type === "call-audio").map((event) => event.index), [0, 1, 2]);
  assert.deepEqual(requestStarts, [0, 350, 700]);
  assert.deepEqual(waits, [350, 350]);
  await service.stop({ callId: started.callId, senderId: "renderer-1" });
});

test("CosyVoice retries a rate limit and reports an exhausted clause as a chat system message", async () => {
  const events = [];
  const requestStarts = [];
  const sentTurns = [];
  const waits = [];
  let attempts = 0;
  let clock = 0;
  let chatSubscriber = null;
  const chat = {
    sendToSession: async (value) => {
      sentTurns.push(value);
      return { accepted: true, requestId: value.requestId, sessionId: value.sessionId };
    },
    stop: async () => ({ accepted: true, stopped: true }),
    subscribe: (callback) => {
      chatSubscriber = callback;
      return () => { chatSubscriber = null; };
    },
  };
  const service = createRealtimeVoiceCallService({
    chat,
    connectionsService: { resolveDashScope: async () => ({ key: "dashscope-key" }) },
    dataRootProvider: () => "D:/suzu-data",
    ledgerPathProvider: () => "D:/suzu-data/usage.json",
    now: () => clock,
    onEvent: (event) => events.push(event),
    reader: {
      snapshot: async () => ({ activeContact: { agentId: "agent-suzu", name: "Suzu" } }),
      ensureActiveSession: async () => ({ id: "session-suzu", projectRoot: "D:/project", hasTranscript: true }),
    },
    resolveVoiceRuntime: ({ agentId }) => ({
      agentId,
      tts: { provider: "cosyvoice", apiKey: "dashscope-key", voice: "voice-suzu", model: "cosyvoice-v3.5-plus" },
    }),
    settingsService: { load: () => ({}) },
    sleep: async (delay, signal) => {
      waits.push(delay);
      clock += delay;
      return !signal?.aborted;
    },
    synthesizeVoice: async () => {
      attempts += 1;
      requestStarts.push(clock);
      const error = new Error("CosyVoice HTTP 429: Throttling.RateQuota");
      error.code = "tts_http_error";
      throw error;
    },
  });

  const started = await service.start({ senderId: "renderer-1" });
  await service.open({ callId: started.callId, senderId: "renderer-1" });
  chatSubscriber({
    type: "reply",
    kind: "call-open",
    requestId: sentTurns[0].requestId,
    sessionId: "session-suzu",
    projectRoot: "D:/project",
    content: "第一句。",
  });

  await waitFor(() => events.some((event) => event.type === "call-audio-skip"));
  assert.equal(attempts, 3);
  assert.deepEqual(requestStarts, [0, 900, 2_700]);
  assert.deepEqual(waits, [900, 1_800]);
  assert.equal(events.some((event) => event.type === "call-error"), false);
  assert.deepEqual(
    events.filter((event) => event.type === "call-system-message").map((event) => event.message),
    ["通话系统：语音服务繁忙，已跳过这一句语音。"],
  );
  assert.equal(events.filter((event) => event.type === "call-audio-skip").length, 1);
  await service.stop({ callId: started.callId, senderId: "renderer-1" });
});

test("call helpers keep the configured endpoint and speakable clauses", () => {
  assert.equal(
    realtimeAsrWebSocketUrl("https://dashscope.aliyuncs.com/api/v1", "qwen3-asr-flash-realtime"),
    "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime&heartbeat=true",
  );
  assert.equal(
    realtimeAsrWebSocketUrl("http://localhost:8080/api/v1", "model-a"),
    "ws://localhost:8080/api-ws/v1/realtime?model=model-a&heartbeat=true",
  );
  assert.deepEqual(takeCallSpeechSegments("第一句。第二句还没说完"), {
    remaining: "第二句还没说完",
    segments: ["第一句。"],
  });
  assert.deepEqual(takeCallSpeechSegments("第二句还没说完", { flush: true }), {
    remaining: "",
    segments: ["第二句还没说完"],
  });
});
