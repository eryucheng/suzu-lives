import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";
import { normalizeTtsAdapter, resolveTtsAdapterForService, ttsAdapterDefinition, ttsAdapterLabel, ttsAdapterSupportsConnection } from "@suzu-lives/voice-message/tts-adapters";

const CUSTOM_VOICE_FILE = "custom-voices.json";
const MAX_CUSTOM_VOICES = 100;

function clean(value) { return String(value ?? "").trim(); }
function plainObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function boundedText(value, label, maximum) {
  const result = clean(value);
  if (result.length > maximum) throw new Error(`${label}不能超过 ${maximum} 个字符。`);
  return result;
}
function dataRootFor(settingsService, settings = settingsService.load()) {
  const dataRoot = clean(settingsService.response(settings).dataRoot);
  if (!dataRoot) throw new Error("无法定位 Suzu Lives 的本机数据目录。 ");
  return path.resolve(dataRoot);
}
async function readJson(filePath, fallback = {}) { try { return JSON.parse(await fsp.readFile(filePath, "utf8")); } catch { return fallback; } }
async function writeJsonAtomic(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = filePath + ".tmp";
  await fsp.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fsp.rename(temporary, filePath);
}
function customVoicesPath(agentRoot) { return path.join(agentRoot, "voice-message", CUSTOM_VOICE_FILE); }
function customVoiceAdapter(value) { return normalizeTtsAdapter(value); }
function customVoiceAdapterLabel(adapter) { return ttsAdapterLabel(adapter); }
function customVoiceModel(adapter, value) { return clean(value) || ttsAdapterDefinition(adapter)?.defaultModel || ""; }
function normalizedCustomVoices(value) {
  const document = plainObject(value);
  const voices = [];
  const seen = new Set();
  for (const item of (Array.isArray(document.voices) ? document.voices : []).slice(0, MAX_CUSTOM_VOICES)) {
    const source = plainObject(item);
    const id = clean(source.id);
    const name = clean(source.name);
    const adapter = customVoiceAdapter(source.adapter || source.provider);
    const voiceId = clean(source.voiceId);
    if (!id || !name || !adapter || !voiceId || seen.has(id)) continue;
    seen.add(id);
    voices.push({
      id,
      name,
      adapter,
      voiceId,
      model: customVoiceModel(adapter, source.model),
      createdAt: clean(source.createdAt),
    });
  }
  return voices;
}
async function readCustomVoices(agentRoot) {
  return normalizedCustomVoices(await readJson(customVoicesPath(agentRoot), { schemaVersion: 1, voices: [] }));
}
async function writeCustomVoices(agentRoot, voices) {
  await writeJsonAtomic(customVoicesPath(agentRoot), { schemaVersion: 2, voices });
}
function publicCustomVoices(voices) {
  return voices.map(({ id, name, adapter, voiceId, model, createdAt }) => ({ id, name, adapter, voiceId, model, createdAt }));
}
function publicContacts(value) {
  const contacts = [];
  for (const item of (Array.isArray(value) ? value : []).slice(0, 160)) {
    const source = plainObject(item);
    const id = clean(source.id);
    const agentId = clean(source.agentId);
    const name = clean(source.name) || "未命名联系人";
    if (!id || !agentId || contacts.some((contact) => contact.id === id)) continue;
    contacts.push({ id, agentId, name });
  }
  return contacts;
}
async function contactsFor(contactProjectsService) {
  if (!contactProjectsService?.snapshot) return [];
  try {
    return publicContacts((await contactProjectsService.snapshot())?.contacts);
  } catch {
    return [];
  }
}
function rootForAgent(dataRoot, agentId) {
  return resolveAgentDataRoot({ dataRoot, agentId });
}
async function customVoiceChoices(dataRoot, contacts) {
  const result = [];
  const seen = new Set();
  for (const voice of publicCustomVoices(await readCustomVoices(dataRoot))) {
    if (seen.has(voice.id)) continue;
    seen.add(voice.id);
    result.push({
      ...voice,
      key: `${voice.adapter}:global:${voice.id}`,
      kindLabel: customVoiceAdapterLabel(voice.adapter),
      source: "global",
      sourceContactId: "",
      sourceAgentId: "",
    });
  }
  const local = await Promise.all(contacts.map(async (contact) => ({
    contact,
    voices: publicCustomVoices(await readCustomVoices(rootForAgent(dataRoot, contact.agentId))),
  })));
  for (const { contact, voices } of local) {
    for (const voice of voices) {
      if (seen.has(voice.id)) continue;
      seen.add(voice.id);
      result.push({
        ...voice,
        key: `${voice.adapter}:${contact.id}:${voice.id}`,
        kindLabel: `${customVoiceAdapterLabel(voice.adapter)} · 来自 ${contact.name}`,
        source: "contact",
        sourceContactId: contact.id,
        sourceAgentId: contact.agentId,
      });
    }
  }
  return result;
}
function configuredVoice(value) {
  const config = plainObject(value);
  const tts = plainObject(config.tts);
  return clean(config.voiceId || config.voice || tts.voiceId || tts.voice_id || tts.voice);
}
function configuredAdapter(value) {
  const config = plainObject(value);
  const tts = plainObject(config.tts);
  return customVoiceAdapter(config.adapter || tts.adapter || config.provider || tts.provider) || "dashscope-qwen";
}
function configuredCustomVoice(value) {
  const config = plainObject(value);
  const tts = plainObject(config.tts);
  return clean(config.customVoiceId || tts.customVoiceId);
}
function withoutVoiceSelection(value) {
  const config = plainObject(value);
  const tts = plainObject(config.tts);
  const {
    voiceId: _voiceId,
    voice: _voice,
    adapter: _adapter,
    provider: _provider,
    customVoiceId: _customVoiceId,
    sourceAgentId: _sourceAgentId,
    sourceCandidateId: _sourceCandidateId,
    customVoiceSource: _customVoiceSource,
    customVoiceSourceAgentId: _customVoiceSourceAgentId,
    ...rest
  } = config;
  return rest;
}
async function snapshot(settingsService, contactProjectsService) {
  const dataRoot = dataRootFor(settingsService);
  const contacts = await contactsFor(contactProjectsService);
  const customChoices = await customVoiceChoices(dataRoot, contacts);
  const selections = await Promise.all(contacts.map(async (contact) => {
    const value = await readJson(path.join(rootForAgent(dataRoot, contact.agentId), "voice-message", "config.json"));
    return {
      ...contact,
      adapter: configuredAdapter(value),
      voiceId: configuredVoice(value),
      customVoiceId: configuredCustomVoice(value),
    };
  }));
  return {
    status: "ready",
    customVoices: customChoices,
    assignableVoices: customChoices,
    contacts: selections,
  };
}

export function registerVoiceDesignIpc({ connectionsService, contactProjectsService = null, ipcMain, settingsService }) {
  ipcMain.handle("voice-design:snapshot", () => snapshot(settingsService, contactProjectsService));
  ipcMain.handle("voice-design:save-custom-audio", async (_event, value) => {
    const dataRoot = dataRootFor(settingsService);
    const input = plainObject(value);
    const name = boundedText(input.name, "声音备注名", 80);
    const configuredAdapter = customVoiceAdapter(input.adapter || input.provider);
    const voiceId = boundedText(input.voiceId, "音色 ID", 200);
    const model = boundedText(input.model, "TTS 模型", 160);
    if (!name) throw new Error("请填写声音备注名。 ");
    if (!configuredAdapter) throw new Error("请选择受支持的语音接口适配器。 ");
    if (!voiceId) throw new Error(`请填写${customVoiceAdapterLabel(configuredAdapter)}的音色 ID。 `);
    const connection = await connectionsService.resolveNamedApiConnection?.("voice-message");
    if (!connection?.key) throw new Error("请先在“能力 → 语音消息”选择并配置一个 API。 ");
    const adapter = resolveTtsAdapterForService({
      adapter: configuredAdapter,
      baseUrl: connection.baseUrl,
      model,
      voiceId,
    }) || configuredAdapter;
    if (!ttsAdapterSupportsConnection(adapter, connection.type)) {
      throw new Error(`${customVoiceAdapterLabel(adapter)}不能使用当前选择的 API；请为“语音消息”选择兼容的 API 后再保存。`);
    }
    const voices = await readCustomVoices(dataRoot);
    if (voices.length >= MAX_CUSTOM_VOICES) throw new Error(`自定义音频不能超过 ${MAX_CUSTOM_VOICES} 条。`);
    voices.unshift({
      id: randomUUID(),
      name,
      adapter,
      voiceId,
      model: customVoiceModel(adapter, model),
      createdAt: new Date().toISOString(),
    });
    await writeCustomVoices(dataRoot, voices);
    return snapshot(settingsService, contactProjectsService);
  });
  ipcMain.handle("voice-design:save-contact-voice", async (_event, value) => {
    const input = plainObject(value);
    const dataRoot = dataRootFor(settingsService);
    const contacts = await contactsFor(contactProjectsService);
    const contactId = boundedText(input.contactId, "联系人", 100);
    const contact = contacts.find((item) => item.id === contactId);
    if (!contact) throw new Error("请选择联系人列表中的一位联系人。 ");
    const adapter = customVoiceAdapter(input.adapter || input.provider);
    const voiceId = boundedText(input.voiceId, "音色", 200);
    if (!voiceId) throw new Error("请选择一个音色。 ");
    if (!adapter) throw new Error("所选音色的接口适配器不可用。 ");
    const configPath = path.join(rootForAgent(dataRoot, contact.agentId), "voice-message", "config.json");
    const existing = await readJson(configPath);
    const customVoiceId = boundedText(input.customVoiceId, "自定义音频", 100);
    const sourceContactId = boundedText(input.sourceContactId, "音色来源", 100);
    const selected = (await customVoiceChoices(dataRoot, contacts)).find((item) => (
      item.id === customVoiceId
      && item.adapter === adapter
      && item.voiceId === voiceId
      && item.sourceContactId === sourceContactId
    ));
    if (!selected) throw new Error(`所选${customVoiceAdapterLabel(adapter)}已经不可用；请刷新后重新选择。 `);
    await writeJsonAtomic(configPath, {
      ...withoutVoiceSelection(existing),
      schemaVersion: 4,
      adapter,
      voiceId,
      customVoiceId,
      customVoiceSource: selected.source,
      ...(selected.source === "contact" ? { customVoiceSourceAgentId: selected.sourceAgentId } : {}),
    });
    return snapshot(settingsService, contactProjectsService);
  });
  ipcMain.handle("voice-design:delete-custom-voice", async (_event, value) => {
    const input = plainObject(value);
    const id = boundedText(input.id, "音色", 100);
    if (!id) throw new Error("请选择要删除的音色。 ");
    const dataRoot = dataRootFor(settingsService);
    const contacts = await contactsFor(contactProjectsService);
    const choices = await customVoiceChoices(dataRoot, contacts);
    const choice = choices.find((item) => (
      item.id === id
      && item.source === clean(input.source).toLowerCase()
      && clean(item.sourceContactId) === clean(input.sourceContactId)
    ));
    if (!choice) throw new Error("找不到这个音色。 ");
    const users = (await Promise.all(contacts.map(async (contact) => ({
      contact,
      config: await readJson(path.join(rootForAgent(dataRoot, contact.agentId), "voice-message", "config.json")),
    })))).filter(({ config }) => (
      configuredCustomVoice(config) === id
      && configuredAdapter(config) === choice.adapter
      && configuredVoice(config) === choice.voiceId
    ));
    if (users.length) {
      const labels = users.slice(0, 3).map(({ contact }) => contact.name).join("、");
      throw new Error(`这个音色正在供 ${labels}${users.length > 3 ? "等" : ""}${users.length} 位联系人使用。请先为他们换一个音色，再删除。`);
    }
    const voices = await readCustomVoices(choice.source === "global" ? dataRoot : rootForAgent(dataRoot, choice.sourceContactId));
    await writeCustomVoices(choice.source === "global" ? dataRoot : rootForAgent(dataRoot, choice.sourceContactId), voices.filter((item) => item.id !== id));
    return snapshot(settingsService, contactProjectsService);
  });
}
