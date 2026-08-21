import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  ConversationVoiceInputError,
  createConversationVoiceInputService,
} from "../electron/services/conversation-voice-input.mjs";

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

test("composer voice input uses only the configured ASR connection and returns a draft transcript", async () => {
  const events = [];
  const ledgerEvents = [];
  let socket = null;
  let socketUrl = "";
  const service = createConversationVoiceInputService({
    appendLedger: async (ledgerPath, event) => ledgerEvents.push({ event, ledgerPath }),
    connectionsService: {
      resolveNamedApiConnection: async (feature) => {
        assert.equal(feature, "realtime-asr");
        return {
          baseUrl: "https://regional-asr.example.test/api/v1",
          key: "asr-key",
          model: "qwen3-asr-custom-realtime",
          name: "我的实时识别",
          type: "dashscope",
        };
      },
    },
    onEvent: (event) => events.push(event),
    reader: {
      snapshot: async () => ({ activeContact: { agentId: "agent-suzu" } }),
    },
    settingsService: {
      load: () => ({}),
      response: () => ({ dataRoot: "D:/suzu-data", usageLedgerPath: "D:/suzu-data/usage.json" }),
    },
    webSocketFactory: (url) => {
      socketUrl = url;
      socket = new FakeSocket();
      return socket;
    },
  });

  const started = await service.start({ senderId: "renderer-1" });
  assert.match(started.inputId, /^voice-input-/u);
  assert.equal(started.voiceEnergyThreshold, 0.025);
  assert.equal(started.voiceSilenceFrames, 9);

  const audio = new Int16Array([0, 1, -1, 2048]);
  assert.deepEqual(service.pushAudio({ audio: audio.buffer, inputId: started.inputId, senderId: "renderer-1" }), { accepted: true });
  assert.deepEqual(await service.commit({ inputId: started.inputId, senderId: "renderer-1" }), { accepted: true, committed: true });
  assert.ok(socket);
  assert.equal(socketUrl, "wss://regional-asr.example.test/api-ws/v1/realtime?model=qwen3-asr-custom-realtime&heartbeat=true");
  assert.equal(JSON.parse(socket.sent[0]).type, "session.update");
  assert.equal(JSON.parse(socket.sent[0]).session.turn_detection, null);
  assert.equal(JSON.parse(socket.sent[1]).type, "input_audio_buffer.append");
  assert.equal(JSON.parse(socket.sent[2]).type, "input_audio_buffer.commit");

  socket.emit("message", Buffer.from(JSON.stringify({
    type: "conversation.item.input_audio_transcription.text",
    text: "今",
    stash: "天好",
  })));
  assert.deepEqual(events.at(-1), {
    final: false,
    inputId: started.inputId,
    text: "今天好",
    timestamp: events.at(-1).timestamp,
    type: "voice-input-transcript",
  });

  socket.emit("message", Buffer.from(JSON.stringify({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "今天好吗？",
  })));
  await flush();
  const final = events.find((event) => event.type === "voice-input-transcript" && event.final === true);
  assert.equal(final?.text, "今天好吗？");
  assert.equal(ledgerEvents.length, 1);
  assert.equal(ledgerEvents[0].ledgerPath, "D:/suzu-data/usage.json");
  assert.equal(ledgerEvents[0].event.feature, "conversation-voice-input-asr");
  assert.equal(ledgerEvents[0].event.agentId, "agent-suzu");
  assert.equal(ledgerEvents[0].event.provider, "我的实时识别");
  assert.equal(ledgerEvents[0].event.model, "qwen3-asr-custom-realtime");
  assert.equal(ledgerEvents[0].event.units.inputAudioSeconds, audio.byteLength / 32_000);
  assert.deepEqual(await service.stop({ inputId: started.inputId, senderId: "renderer-1" }), { accepted: true, stopped: false });
});

test("composer voice input gives a direct configuration error when ASR is not selected", async () => {
  const service = createConversationVoiceInputService({
    connectionsService: { resolveNamedApiConnection: async () => null },
  });
  await assert.rejects(
    () => service.start(),
    (error) => error instanceof ConversationVoiceInputError && /ASR API/u.test(error.message),
  );
});
