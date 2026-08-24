import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireWebRtcMicrophoneCapture,
  readWebRtcMicrophoneProcessing,
  stopWebRtcMicrophoneCapture,
  WEBRTC_MICROPHONE_AUDIO_CONSTRAINTS,
} from "../src/react/conversation-microphone.mjs";

test("the shared microphone capture requests Chromium WebRTC processing and retains reported settings", async () => {
  let constraints = null;
  let stopped = 0;
  const track = {
    getSettings: () => ({
      autoGainControl: true,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      sampleRate: 48000,
    }),
    kind: "audio",
    stop: () => { stopped += 1; },
  };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };

  const capture = await acquireWebRtcMicrophoneCapture({
    mediaDevices: {
      getUserMedia: async (next) => {
        constraints = next;
        return stream;
      },
    },
  });

  assert.deepEqual(constraints, { audio: { ...WEBRTC_MICROPHONE_AUDIO_CONSTRAINTS } });
  assert.equal(capture.stream, stream);
  assert.equal(capture.track, track);
  assert.deepEqual(capture.processing.actual, {
    autoGainControl: true,
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    sampleRate: 48000,
  });
  stopWebRtcMicrophoneCapture(capture);
  assert.equal(stopped, 1);
});

test("reported microphone processing leaves unsupported settings unknown", () => {
  assert.deepEqual(readWebRtcMicrophoneProcessing({ getSettings: () => ({ channelCount: 2 }) }), {
    actual: {
      autoGainControl: null,
      channelCount: 2,
      echoCancellation: null,
      noiseSuppression: null,
      sampleRate: null,
    },
    requested: { ...WEBRTC_MICROPHONE_AUDIO_CONSTRAINTS },
  });
});

test("a capture without an audio track is stopped and rejected", async () => {
  let stopped = 0;
  const stream = {
    getAudioTracks: () => [],
    getTracks: () => [{ kind: "video", stop: () => { stopped += 1; } }],
  };
  await assert.rejects(
    () => acquireWebRtcMicrophoneCapture({ mediaDevices: { getUserMedia: async () => stream } }),
    /音频轨道/u,
  );
  assert.equal(stopped, 1);
});
