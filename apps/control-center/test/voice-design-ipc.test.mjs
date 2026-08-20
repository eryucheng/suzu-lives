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
