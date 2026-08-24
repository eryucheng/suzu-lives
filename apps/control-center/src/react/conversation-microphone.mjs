// One canonical capture profile for every feature that sends live microphone
// audio. Chromium/Electron applies its WebRTC audio-processing pipeline to
// this capture stream before it reaches either ASR or a future peer call.
export const WEBRTC_MICROPHONE_AUDIO_CONSTRAINTS = Object.freeze({
  autoGainControl: true,
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
});

function requestedConstraints() {
  return {
    audio: { ...WEBRTC_MICROPHONE_AUDIO_CONSTRAINTS },
  };
}

function firstAudioTrack(stream) {
  const audioTracks = stream?.getAudioTracks?.() || [];
  if (audioTracks[0]) return audioTracks[0];
  return (stream?.getTracks?.() || []).find((track) => track?.kind === "audio") || null;
}

function booleanSetting(settings, name) {
  return typeof settings?.[name] === "boolean" ? settings[name] : null;
}

function positiveNumberSetting(settings, name) {
  const value = Number(settings?.[name]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Browsers choose the effective device configuration. Keep the reported values
 * separate from the requested profile so diagnostics remain truthful.
 */
export function readWebRtcMicrophoneProcessing(track) {
  let settings = null;
  try {
    settings = track?.getSettings?.() || null;
  } catch {
    settings = null;
  }
  return {
    actual: {
      autoGainControl: booleanSetting(settings, "autoGainControl"),
      channelCount: positiveNumberSetting(settings, "channelCount"),
      echoCancellation: booleanSetting(settings, "echoCancellation"),
      noiseSuppression: booleanSetting(settings, "noiseSuppression"),
      sampleRate: positiveNumberSetting(settings, "sampleRate"),
    },
    requested: { ...WEBRTC_MICROPHONE_AUDIO_CONSTRAINTS },
  };
}

/**
 * Open one Chromium WebRTC-processed microphone stream. Consumers own the
 * returned capture and release it with stopWebRtcMicrophoneCapture.
 */
export async function acquireWebRtcMicrophoneCapture({ mediaDevices = globalThis.navigator?.mediaDevices } = {}) {
  if (!mediaDevices?.getUserMedia) throw new Error("当前环境无法读取麦克风。");
  const stream = await mediaDevices.getUserMedia(requestedConstraints());
  const track = firstAudioTrack(stream);
  if (!track) {
    stopWebRtcMicrophoneCapture({ stream });
    throw new Error("麦克风没有返回可用的音频轨道。");
  }
  return {
    processing: readWebRtcMicrophoneProcessing(track),
    stream,
    track,
  };
}

export function stopWebRtcMicrophoneCapture(capture) {
  const stream = capture?.stream || capture;
  for (const track of stream?.getTracks?.() || []) {
    try { track.stop?.(); } catch { /* The track may already have ended. */ }
  }
}
