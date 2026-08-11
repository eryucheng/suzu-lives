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
  assert.equal(JSON.parse(socket.sent[0]).type, "session.update");
  assert.equal(JSON.parse(socket.sent[0]).session.turn_detection, null);

  const audio = new Int16Array([0, 1, -1, 2048]);
  assert.deepEqual(service.pushAudio({ callId: started.callId, senderId: "renderer-1", audio: audio.buffer }), { accepted: true });
  assert.equal(JSON.parse(socket.sent[1]).type, "input_audio_buffer.append");
  assert.deepEqual(service.commitAudio({ callId: started.callId, senderId: "renderer-1" }), { accepted: true, committed: true });
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

  const initialSocket = socket;
  initialSocket.close();
  await flush();
  await flush();
  assert.notEqual(socket, initialSocket);
  assert.ok(events.some((event) => event.type === "call-state" && event.state === "connecting"));

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
    service.commitAudio({ callId: started.callId, senderId: "renderer-1" }),
    { accepted: false, committed: false, reason: "inactive" },
  );
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
