import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";

import { registerVoiceDesignIpc } from "../electron/ipc/voice-design-ipc.mjs";

test("custom audio keeps only adapter parameters and uses the selected shared API", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-custom-audio-ipc-data-"));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-custom-audio-ipc-project-"));
  const settings = { agentId: "agent-custom-audio", projectRoot };
  const handlers = new Map();
  registerVoiceDesignIpc({
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    settingsService: {
      load: () => settings,
      response: () => ({ dataRoot }),
    },
    connectionsService: {
      resolveNamedApiConnection: async () => ({
        key: "shared-openai-key",
        name: "我的 TTS",
        type: "openai-compatible",
        baseUrl: "https://tts.example.test/v1",
        model: "tts-1",
      }),
    },
  });

  const snapshot = await handlers.get("voice-design:save-custom-audio")(null, {
    name: "Suzu 电话声",
    adapter: "openai-speech",
    model: "tts-1",
    voiceId: "nova",
  });
  assert.equal(snapshot.customVoices.length, 1);
  assert.equal(snapshot.customVoices[0].adapter, "openai-speech");
  assert.equal(JSON.stringify(snapshot).includes("shared-openai-key"), false);
  const stored = JSON.parse(await fs.readFile(path.join(dataRoot, "voice-message", "custom-voices.json"), "utf8"));
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.voices[0].apiKey, undefined);
  assert.equal(stored.voices[0].adapter, "openai-speech");
  await assert.rejects(
    () => handlers.get("voice-design:save-custom-audio")(null, {
      name: "不兼容的 MiniMax",
      adapter: "minimax-speech",
      voiceId: "minimax-voice-id",
    }),
    /不能使用当前选择的 API/u,
  );
});

test("a DashScope CosyVoice sound saved through the old OpenAI default is stored with the DashScope adapter", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-dashscope-cosyvoice-auto-adapter-data-"));
  const handlers = new Map();
  registerVoiceDesignIpc({
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    settingsService: {
      load: () => ({ agentId: "", projectRoot: "" }),
      response: () => ({ dataRoot }),
    },
    connectionsService: {
      resolveNamedApiConnection: async () => ({
        key: "shared-dashscope-key",
        name: "百炼 TTS",
        type: "tts-api",
        baseUrl: "https://dashscope.aliyuncs.com/api/v1",
        model: "",
      }),
    },
  });

  const snapshot = await handlers.get("voice-design:save-custom-audio")(null, {
    name: "Suzu 百炼电话声",
    adapter: "openai-speech",
    model: "cosyvoice-v3.5-plus",
    voiceId: "cosyvoice-v3.5-plus-bailian-suzu",
  });
  assert.equal(snapshot.customVoices[0].adapter, "dashscope-cosyvoice");
  const stored = JSON.parse(await fs.readFile(path.join(dataRoot, "voice-message", "custom-voices.json"), "utf8"));
  assert.equal(stored.voices[0].adapter, "dashscope-cosyvoice");
  assert.equal(JSON.stringify(stored).includes("shared-dashscope-key"), false);
});

test("Xiaomi MiMo TTS sound uses the selected shared connection and stores its explicit adapter", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-xiaomi-mimo-voice-ipc-data-"));
  const handlers = new Map();
  registerVoiceDesignIpc({
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    settingsService: {
      load: () => ({ agentId: "", projectRoot: "" }),
      response: () => ({ dataRoot }),
    },
    connectionsService: {
      resolveNamedApiConnection: async () => ({
        key: "shared-mimo-key",
        name: "我的 MiMo",
        type: "tts-api",
        baseUrl: "https://api.xiaomimimo.com/v1",
        model: "",
      }),
    },
  });

  const snapshot = await handlers.get("voice-design:save-custom-audio")(null, {
    name: "MiMo 默认音色",
    adapter: "xiaomi-mimo-tts",
    voiceId: "mimo_default",
  });
  assert.equal(snapshot.customVoices[0].adapter, "xiaomi-mimo-tts");
  assert.equal(snapshot.customVoices[0].model, "mimo-v2.5-tts");
  assert.equal(JSON.stringify(snapshot).includes("shared-mimo-key"), false);

  await assert.rejects(
    () => handlers.get("voice-design:save-custom-audio")(null, {
      name: "错误的 MiMo 模型",
      adapter: "xiaomi-mimo-tts",
      model: "mimo-v2.5",
      voiceId: "mimo_default",
    }),
    /mimo-v2\.5-tts/u,
  );
});

test("contact voice configuration lists every contact and writes the selected custom voice to the chosen contact only", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-contact-voice-library-data-"));
  const source = { id: "contact-source", name: "Suzu", agentId: "agent-source-contact" };
  const target = { id: "contact-target", name: "小林", agentId: "agent-target-contact" };
  const targetRoot = resolveAgentDataRoot({ dataRoot, agentId: target.agentId });
  const settings = { agentId: "", projectRoot: "" };
  const handlers = new Map();
  let selectedVoiceConnection = {
    key: "shared-minimax-key",
    name: "MiniMax 语音",
    type: "generic-api",
    baseUrl: "https://api.minimax.io/v1",
    model: "speech-2.8-hd",
  };
  registerVoiceDesignIpc({
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    settingsService: {
      load: () => settings,
      response: () => ({ dataRoot }),
    },
    connectionsService: {
      resolveNamedApiConnection: async () => selectedVoiceConnection,
    },
    contactProjectsService: { snapshot: async () => ({ contacts: [source, target] }) },
  });

  const initial = await handlers.get("voice-design:snapshot")();
  assert.equal(initial.status, "ready");
  assert.deepEqual(initial.contacts.map((contact) => contact.name), ["Suzu", "小林"]);
  assert.deepEqual(initial.assignableVoices, []);

  const afterCustom = await handlers.get("voice-design:save-custom-audio")(null, {
    name: "电话声",
    adapter: "minimax-speech",
    model: "speech-2.8-hd",
    voiceId: "minimax-voice-library",
  });
  const minimax = afterCustom.assignableVoices.find((voice) => voice.adapter === "minimax-speech");
  assert.ok(minimax);
  assert.equal(minimax.source, "global");
  assert.equal(JSON.stringify(afterCustom).includes("shared-minimax-key"), false);
  await handlers.get("voice-design:save-contact-voice")(null, {
    contactId: target.id,
    adapter: "minimax-speech",
    voiceId: minimax.voiceId,
    customVoiceId: minimax.id,
    sourceContactId: minimax.sourceContactId,
  });
  const targetConfig = JSON.parse(await fs.readFile(path.join(targetRoot, "voice-message", "config.json"), "utf8"));
  assert.equal(targetConfig.adapter, "minimax-speech");
  assert.equal(targetConfig.customVoiceSource, "global");
  assert.equal(targetConfig.customVoiceId, minimax.id);

  const sourceConfig = await fs.readFile(path.join(resolveAgentDataRoot({ dataRoot, agentId: source.agentId }), "voice-message", "config.json"), "utf8").catch(() => "");
  assert.equal(sourceConfig, "");

  selectedVoiceConnection = {
    key: "shared-dashscope-key",
    name: "百炼语音",
    type: "dashscope",
    baseUrl: "https://dashscope.aliyuncs.com/api/v1",
    model: "cosyvoice-v3.5-plus",
  };
  const afterAlibabaClone = await handlers.get("voice-design:save-custom-audio")(null, {
    name: "Suzu 复刻",
    adapter: "dashscope-cosyvoice",
    voiceId: "cosyvoice-v3.5-plus-suzu-voice",
  });
  const cosyvoiceClone = afterAlibabaClone.assignableVoices.find((voice) => voice.adapter === "dashscope-cosyvoice" && voice.id);
  assert.ok(cosyvoiceClone);
  await handlers.get("voice-design:save-contact-voice")(null, {
    contactId: target.id,
    adapter: "dashscope-cosyvoice",
    voiceId: cosyvoiceClone.voiceId,
    customVoiceId: cosyvoiceClone.id,
    sourceContactId: cosyvoiceClone.sourceContactId,
  });
  const cosyvoiceCloneConfig = JSON.parse(await fs.readFile(path.join(targetRoot, "voice-message", "config.json"), "utf8"));
  assert.equal(cosyvoiceCloneConfig.adapter, "dashscope-cosyvoice");
  assert.equal(cosyvoiceCloneConfig.customVoiceSource, "global");
  assert.equal(cosyvoiceCloneConfig.customVoiceId, cosyvoiceClone.id);
});

test("custom voice deletion refuses in-use voices and removes unused ones", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-delete-voice-ipc-data-"));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-delete-voice-ipc-project-"));
  const settings = { agentId: "", projectRoot: "" };
  const contact = { id: "contact-voice", name: "小张", agentId: "agent-voice" };
  const contactRoot = resolveAgentDataRoot({ dataRoot, agentId: contact.agentId });
  const handlers = new Map();
  registerVoiceDesignIpc({
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    settingsService: {
      load: () => settings,
      response: () => ({ dataRoot }),
    },
    connectionsService: {
      resolveNamedApiConnection: async () => ({
        key: "shared-minimax-key",
        name: "MiniMax 语音",
        type: "generic-api",
        baseUrl: "https://api.minimax.io/v1",
        model: "speech-2.8-hd",
      }),
    },
    contactProjectsService: { snapshot: async () => ({ contacts: [contact] }) },
  });

  const afterCustom = await handlers.get("voice-design:save-custom-audio")(null, {
    name: "电话声",
    adapter: "minimax-speech",
    model: "speech-2.8-hd",
    voiceId: "minimax-voice-delete",
  });
  const voice = afterCustom.assignableVoices[0];
  assert.ok(voice);

  await handlers.get("voice-design:save-contact-voice")(null, {
    contactId: contact.id,
    adapter: "minimax-speech",
    voiceId: voice.voiceId,
    customVoiceId: voice.id,
    sourceContactId: voice.sourceContactId,
  });
  await assert.rejects(
    () => handlers.get("voice-design:delete-custom-voice")(null, { id: voice.id, source: voice.source, sourceContactId: voice.sourceContactId }),
    /正在供/u,
  );

  const replacement = await handlers.get("voice-design:save-custom-audio")(null, {
    name: "备用声音",
    adapter: "minimax-speech",
    model: "speech-2.8-hd",
    voiceId: "minimax-voice-other",
  });
  const replacementVoice = replacement.assignableVoices.find((item) => item.voiceId === "minimax-voice-other");
  assert.ok(replacementVoice);
  await handlers.get("voice-design:save-contact-voice")(null, {
    contactId: contact.id,
    adapter: "minimax-speech",
    voiceId: replacementVoice.voiceId,
    customVoiceId: replacementVoice.id,
    sourceContactId: replacementVoice.sourceContactId,
  });

  const afterDelete = await handlers.get("voice-design:delete-custom-voice")(null, { id: voice.id, source: voice.source, sourceContactId: voice.sourceContactId });
  assert.equal(afterDelete.customVoices.find((item) => item.id === voice.id), undefined);
  const contactConfig = JSON.parse(await fs.readFile(path.join(contactRoot, "voice-message", "config.json"), "utf8"));
  assert.equal(contactConfig.customVoiceId, replacementVoice.id);
});

test("a custom TTS adapter stays local, can create a voice, and cannot be removed while that voice exists", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-custom-tts-adapter-ipc-data-"));
  const handlers = new Map();
  registerVoiceDesignIpc({
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    settingsService: {
      load: () => ({ agentId: "", projectRoot: "" }),
      response: () => ({ dataRoot }),
    },
    connectionsService: {
      resolveNamedApiConnection: async () => ({
        key: "custom-tts-api-key",
        name: "我的自定义语音",
        type: "tts-api",
        baseUrl: "",
        model: "mimo-v2.5-tts",
      }),
    },
  });

  const withAdapter = await handlers.get("voice-design:save-custom-tts-adapter")(null, {
    name: "本机 MiMo 请求格式",
    baseUrl: "https://tts.example.test/v1",
    endpointPath: "/chat/completions",
    requestHeaders: JSON.stringify({ "api-key": "{{apiKey}}" }),
    requestBody: JSON.stringify({
      model: "{{model}}",
      messages: [{ role: "assistant", content: "{{text}}" }],
      audio: { format: "wav", voice: "{{voice}}" },
    }),
    responseMode: "json-base64",
    audioPath: "choices[0].message.audio.data",
    outputFormat: "wav",
  });
  assert.equal(withAdapter.customTtsAdapters.length, 1);
  assert.equal(withAdapter.customTtsAdapters[0].name, "本机 MiMo 请求格式");
  assert.equal(JSON.stringify(withAdapter).includes("api-key"), false);
  const adapter = withAdapter.customTtsAdapters[0];

  const withVoice = await handlers.get("voice-design:save-custom-audio")(null, {
    name: "本机 MiMo 音色",
    adapter: "custom-http-tts",
    customAdapterId: adapter.id,
    model: "mimo-v2.5-tts",
    voiceId: "mimo_default",
  });
  const voice = withVoice.customVoices[0];
  assert.equal(voice.adapter, "custom-http-tts");
  assert.equal(voice.customAdapterId, adapter.id);
  const storedVoiceDocument = JSON.parse(await fs.readFile(path.join(dataRoot, "voice-message", "custom-voices.json"), "utf8"));
  assert.equal(storedVoiceDocument.voices[0].customAdapterId, adapter.id);
  assert.equal(JSON.stringify(storedVoiceDocument).includes("custom-tts-api-key"), false);

  await assert.rejects(
    () => handlers.get("voice-design:delete-custom-tts-adapter")(null, { id: adapter.id }),
    /仍被/u,
  );
  await handlers.get("voice-design:delete-custom-voice")(null, {
    id: voice.id,
    source: voice.source,
    sourceContactId: voice.sourceContactId,
  });
  const empty = await handlers.get("voice-design:delete-custom-tts-adapter")(null, { id: adapter.id });
  assert.equal(empty.customTtsAdapters.length, 0);
});

test("voice services bind a saved API, while contacts only retain their selected voice", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-voice-service-library-data-"));
  const contact = { id: "contact-voice-service", name: "小林", agentId: "agent-voice-service" };
  const contactRoot = resolveAgentDataRoot({ dataRoot, agentId: contact.agentId });
  const handlers = new Map();
  const connections = new Map([
    ["api-elevenlabs", {
      id: "api-elevenlabs",
      key: "elevenlabs-test-key",
      name: "ElevenLabs 账户",
      type: "tts-api",
      baseUrl: "",
      model: "",
    }],
  ]);
  registerVoiceDesignIpc({
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    settingsService: {
      load: () => ({ agentId: "", projectRoot: "" }),
      response: () => ({ dataRoot }),
    },
    connectionsService: {
      resolveApiConnectionById: async (id) => connections.get(id) || null,
    },
    contactProjectsService: { snapshot: async () => ({ contacts: [contact] }) },
  });

  const withService = await handlers.get("voice-design:save-service")(null, {
    name: "ElevenLabs 英文语音",
    adapter: "elevenlabs-speech",
    connectionId: "api-elevenlabs",
  });
  const service = withService.voiceServices[0];
  assert.ok(service);
  assert.equal(service.connectionId, "api-elevenlabs");
  assert.equal(service.adapter, "elevenlabs-speech");
  assert.equal(service.model, "eleven_multilingual_v2");
  assert.equal(JSON.stringify(withService).includes("elevenlabs-test-key"), false);

  const withProfile = await handlers.get("voice-design:save-profile")(null, {
    name: "Narrator",
    serviceId: service.id,
    voiceId: "voice-id-123",
  });
  const profile = withProfile.voiceProfiles[0];
  assert.ok(profile);
  assert.equal(profile.serviceId, service.id);
  assert.equal(profile.serviceName, service.name);

  await fs.mkdir(path.join(contactRoot, "voice-message"), { recursive: true });
  await fs.writeFile(path.join(contactRoot, "voice-message", "config.json"), JSON.stringify({
    schemaVersion: 5,
    adapter: "minimax-speech",
    voiceId: "old-voice",
    model: "old-model",
    tts: { adapter: "minimax-speech", maxTextLength: 120, voiceId: "old-voice" },
  }), "utf8");
  await handlers.get("voice-design:save-contact-voice")(null, {
    contactId: contact.id,
    voiceProfileId: profile.id,
  });
  const stored = JSON.parse(await fs.readFile(path.join(contactRoot, "voice-message", "config.json"), "utf8"));
  assert.deepEqual(stored, {
    schemaVersion: 6,
    voiceProfileId: profile.id,
    tts: { maxTextLength: 120 },
  });

  await assert.rejects(
    () => handlers.get("voice-design:delete-profile")(null, { id: profile.id }),
    /正在供/u,
  );
  await assert.rejects(
    () => handlers.get("voice-design:delete-service")(null, { id: service.id }),
    /仍有/u,
  );
});

test("a custom protocol can be used by a new voice service without using the legacy global binding", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "suzu-custom-voice-service-data-"));
  const handlers = new Map();
  registerVoiceDesignIpc({
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    settingsService: {
      load: () => ({ agentId: "", projectRoot: "" }),
      response: () => ({ dataRoot }),
    },
    connectionsService: {
      resolveApiConnectionById: async (id) => id === "api-custom" ? {
        id,
        key: "custom-service-key",
        name: "我的语音接口",
        type: "tts-api",
        baseUrl: "",
        model: "",
      } : null,
    },
  });

  const withProtocol = await handlers.get("voice-design:save-custom-tts-adapter")(null, {
    name: "供应商 JSON 协议",
    baseUrl: "https://voice.example.test/v1",
    endpointPath: "/speech",
    requestHeaders: JSON.stringify({ Authorization: "Bearer {{apiKey}}" }),
    requestBody: JSON.stringify({ model: "{{model}}", text: "{{text}}", voice: "{{voice}}" }),
    responseMode: "binary",
    audioPath: "",
    outputFormat: "mp3",
  });
  const protocol = withProtocol.customTtsAdapters[0];
  assert.ok(protocol);

  const withService = await handlers.get("voice-design:save-service")(null, {
    name: "供应商语音",
    adapter: "custom-http-tts",
    connectionId: "api-custom",
    customAdapterId: protocol.id,
    model: "speech-v1",
  });
  const service = withService.voiceServices[0];
  assert.equal(service.customAdapterId, protocol.id);
  assert.equal(service.connectionId, "api-custom");
  assert.equal(JSON.stringify(withService).includes("custom-service-key"), false);
});
