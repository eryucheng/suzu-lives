import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";

import { createCapabilitiesService } from "../electron/ipc/capabilities-ipc.mjs";

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("capability status preserves a selected custom HTTP TTS adapter", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-capability-custom-tts-"));
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "project");
  const agentId = "agent-custom-tts";
  const agentRoot = resolveAgentDataRoot({ dataRoot, agentId });
  const adapterId = "custom-tts-12345678";
  const voiceId = "voice-custom";
  const customVoiceId = "voice-12345678";
  await fs.mkdir(projectRoot, { recursive: true });
  await writeJson(path.join(dataRoot, "voice-message", "custom-tts-adapters.json"), {
    schemaVersion: 1,
    adapters: [{
      id: adapterId,
      name: "本机 JSON TTS",
      endpointPath: "/v1/tts",
      requestHeaders: { Authorization: "Bearer {{apiKey}}" },
      requestBody: { input: "{{text}}", voice: "{{voice}}" },
      responseMode: "json-base64",
      audioPath: "audio.data",
      outputFormat: "mp3",
    }],
  });
  await writeJson(path.join(agentRoot, "voice-message", "custom-voices.json"), {
    schemaVersion: 2,
    voices: [{
      id: customVoiceId,
      name: "自定义声音",
      adapter: "custom-http-tts",
      customAdapterId: adapterId,
      voiceId,
      model: "optional-model",
    }],
  });
  await writeJson(path.join(agentRoot, "voice-message", "config.json"), {
    schemaVersion: 5,
    adapter: "custom-http-tts",
    customAdapterId: adapterId,
    customVoiceId,
    voiceId,
  });

  const service = createCapabilitiesService({
    settingsService: {
      load: () => ({ dataRoot, agentId, projectRoot }),
      response: () => ({ dataRoot }),
    },
  });
  const voiceSettings = service.snapshot().capabilities.find((capability) => capability.id === "voice-message")?.savedSettings;
  assert.equal(voiceSettings.selectionSource, "contact");
  assert.equal(voiceSettings.voiceAdapter, "custom-http-tts");
  assert.equal(voiceSettings.customAdapterId, adapterId);
  assert.equal(voiceSettings.customVoiceId, customVoiceId);

  await fs.unlink(path.join(dataRoot, "voice-message", "custom-tts-adapters.json"));
  const missingAdapterSettings = service.snapshot().capabilities.find((capability) => capability.id === "voice-message")?.savedSettings;
  assert.equal(missingAdapterSettings.selectionSource, "invalid-contact");
});

test("capability status recognizes a profile-selected voice without requiring a legacy candidate", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-capability-voice-profile-"));
  const dataRoot = path.join(root, "data");
  const projectRoot = path.join(root, "project");
  const agentId = "agent-voice-profile";
  const agentRoot = resolveAgentDataRoot({ dataRoot, agentId });
  await fs.mkdir(projectRoot, { recursive: true });
  await writeJson(path.join(dataRoot, "voice-message", "voice-services.json"), {
    schemaVersion: 1,
    services: [{
      id: "service-elevenlabs",
      name: "ElevenLabs 英文语音",
      adapter: "elevenlabs-speech",
      connectionId: "connection-elevenlabs",
      model: "eleven_multilingual_v2",
      createdAt: "2026-08-23T00:00:00.000Z",
    }],
  });
  await writeJson(path.join(dataRoot, "voice-message", "voice-profiles.json"), {
    schemaVersion: 1,
    profiles: [{
      id: "profile-elevenlabs",
      serviceId: "service-elevenlabs",
      name: "Narrator",
      voiceId: "voice-id-123",
      model: "",
      createdAt: "2026-08-23T00:00:00.000Z",
    }],
  });
  await writeJson(path.join(agentRoot, "voice-message", "config.json"), {
    schemaVersion: 6,
    voiceProfileId: "profile-elevenlabs",
  });

  const service = createCapabilitiesService({
    settingsService: {
      load: () => ({ dataRoot, agentId, projectRoot }),
      response: () => ({ dataRoot }),
    },
  });
  const voiceSettings = service.snapshot().capabilities.find((capability) => capability.id === "voice-message")?.savedSettings;
  assert.equal(voiceSettings.selectionSource, "profile");
  assert.equal(voiceSettings.voiceProfileId, "profile-elevenlabs");
  assert.equal(voiceSettings.voiceAdapter, "elevenlabs-speech");
  assert.equal(voiceSettings.voiceId, "voice-id-123");
});
