import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";
import {
  CUSTOM_TTS_ADAPTER_SCHEMA_VERSION,
  MAX_CUSTOM_TTS_ADAPTERS,
  customTtsAdaptersPath,
  findCustomTtsAdapter,
  normalizeCustomTtsAdapter,
  normalizeCustomTtsAdapters,
  publicCustomTtsAdapter,
} from "@suzu-lives/voice-message/custom-tts-adapters";
import { normalizeTtsAdapter, resolveTtsAdapterForService, ttsAdapterDefinition, ttsAdapterEndpointCompatibilityError, ttsAdapterLabel, ttsAdapterModelCompatibilityError, ttsAdapterSupportsConnection, ttsAdapterVoiceCompatibilityError } from "@suzu-lives/voice-message/tts-adapters";
import {
  MAX_VOICE_PROFILES,
  MAX_VOICE_SERVICES,
  VOICE_PROFILE_SCHEMA_VERSION,
  VOICE_SERVICE_SCHEMA_VERSION,
  findVoiceService,
  normalizeVoiceProfile,
  normalizeVoiceService,
  publicVoiceProfile,
  publicVoiceService,
  readVoiceProfiles,
  readVoiceServices,
  resolveVoiceProfile,
  voiceProfilesPath,
  voiceServicesPath,
} from "@suzu-lives/voice-message/voice-services";

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
async function readCustomTtsAdapters(dataRoot) {
  return normalizeCustomTtsAdapters(await readJson(customTtsAdaptersPath(dataRoot), { schemaVersion: CUSTOM_TTS_ADAPTER_SCHEMA_VERSION, adapters: [] }));
}
async function writeCustomTtsAdapters(dataRoot, adapters) {
  await writeJsonAtomic(customTtsAdaptersPath(dataRoot), { schemaVersion: CUSTOM_TTS_ADAPTER_SCHEMA_VERSION, adapters });
}
async function writeVoiceServices(dataRoot, services) {
  await writeJsonAtomic(voiceServicesPath(dataRoot), { schemaVersion: VOICE_SERVICE_SCHEMA_VERSION, services });
}
async function writeVoiceProfiles(dataRoot, profiles) {
  await writeJsonAtomic(voiceProfilesPath(dataRoot), { schemaVersion: VOICE_PROFILE_SCHEMA_VERSION, profiles });
}
function customVoiceAdapter(value) { return normalizeTtsAdapter(value); }
function customVoiceAdapterLabel(adapter) { return ttsAdapterLabel(adapter); }
function customVoiceModel(adapter, value) { return clean(value) || ttsAdapterDefinition(adapter)?.defaultModel || ""; }
function normalizedCustomAdapterId(value) { return clean(value).toLowerCase(); }
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
    const customAdapterId = normalizedCustomAdapterId(source.customAdapterId);
    if (!id || !name || !adapter || !voiceId || (adapter === "custom-http-tts" && !customAdapterId) || seen.has(id)) continue;
    seen.add(id);
    voices.push({
      id,
      name,
      adapter,
      voiceId,
      customAdapterId,
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
  return voices.map(({ id, name, adapter, voiceId, customAdapterId, model, createdAt }) => ({ id, name, adapter, voiceId, customAdapterId, model, createdAt }));
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
function customVoiceKindLabel(voice, customTtsAdapters) {
  if (voice.adapter !== "custom-http-tts") return customVoiceAdapterLabel(voice.adapter);
  const customAdapter = customTtsAdapters.find((item) => item.id === voice.customAdapterId);
  return customAdapter ? `自定义协议 · ${customAdapter.name}` : "自定义协议不可用";
}
function customVoiceCanBeSelected(voice, customTtsAdapters) {
  return voice.adapter !== "custom-http-tts" || customTtsAdapters.some((item) => item.id === voice.customAdapterId);
}
async function customVoiceChoices(dataRoot, contacts, customTtsAdapters = null) {
  const adapters = Array.isArray(customTtsAdapters) ? customTtsAdapters : await readCustomTtsAdapters(dataRoot);
  const result = [];
  const seen = new Set();
  for (const voice of publicCustomVoices(await readCustomVoices(dataRoot))) {
    if (seen.has(voice.id)) continue;
    seen.add(voice.id);
    result.push({
      ...voice,
      key: `${voice.adapter}:global:${voice.id}`,
      kindLabel: customVoiceKindLabel(voice, adapters),
      selectable: customVoiceCanBeSelected(voice, adapters),
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
        kindLabel: `${customVoiceKindLabel(voice, adapters)} · 来自 ${contact.name}`,
        selectable: customVoiceCanBeSelected(voice, adapters),
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
function configuredVoiceProfile(value) {
  const config = plainObject(value);
  const tts = plainObject(config.tts);
  return clean(config.voiceProfileId || tts.voiceProfileId).toLowerCase();
}
function configuredCustomAdapterId(value) {
  const config = plainObject(value);
  const tts = plainObject(config.tts);
  return normalizedCustomAdapterId(config.customAdapterId || tts.customAdapterId);
}
function withoutVoiceSelection(value) {
  const config = plainObject(value);
  const tts = plainObject(config.tts);
  const {
    apiKey: _apiKey,
    voiceId: _voiceId,
    voice: _voice,
    voiceProfileId: _voiceProfileId,
    adapter: _adapter,
    provider: _provider,
    model: _model,
    baseUrl: _baseUrl,
    base_url: _baseUrlSnakeCase,
    key: _key,
    customVoiceId: _customVoiceId,
    customAdapterId: _customAdapterId,
    sourceAgentId: _sourceAgentId,
    sourceCandidateId: _sourceCandidateId,
    customVoiceSource: _customVoiceSource,
    customVoiceSourceAgentId: _customVoiceSourceAgentId,
    tts: _tts,
    ...rest
  } = config;
  const {
    apiKey: _ttsApiKey,
    voiceId: _ttsVoiceId,
    voice_id: _ttsVoiceIdSnakeCase,
    voice: _ttsVoice,
    voiceProfileId: _ttsVoiceProfileId,
    adapter: _ttsAdapter,
    provider: _ttsProvider,
    model: _ttsModel,
    baseUrl: _ttsBaseUrl,
    base_url: _ttsBaseUrlSnakeCase,
    key: _ttsKey,
    customVoiceId: _ttsCustomVoiceId,
    customAdapterId: _ttsCustomAdapterId,
    sourceAgentId: _ttsSourceAgentId,
    sourceCandidateId: _ttsSourceCandidateId,
    customVoiceSource: _ttsCustomVoiceSource,
    customVoiceSourceAgentId: _ttsCustomVoiceSourceAgentId,
    ...restTts
  } = tts;
  return {
    ...rest,
    ...(Object.keys(restTts).length ? { tts: restTts } : {}),
  };
}

function voiceServiceCanBeSelected(service, customTtsAdapters) {
  return service.adapter !== "custom-http-tts" || customTtsAdapters.some((item) => item.id === service.customAdapterId);
}

function voiceProfileChoices(services, profiles, customTtsAdapters) {
  const serviceById = new Map(services.map((service) => [service.id, service]));
  return profiles.map((profile) => {
    const service = serviceById.get(profile.serviceId);
    const selectable = Boolean(service) && voiceServiceCanBeSelected(service, customTtsAdapters);
    return {
      ...publicVoiceProfile(profile, service || null),
      adapter: service?.adapter || "",
      key: `profile:${profile.id}`,
      kindLabel: service ? `${service.name} · ${ttsAdapterLabel(service.adapter)}` : "语音服务不可用",
      selectable,
      selection: "profile",
    };
  });
}

async function snapshot(settingsService, contactProjectsService) {
  const dataRoot = dataRootFor(settingsService);
  const contacts = await contactsFor(contactProjectsService);
  const customTtsAdapters = await readCustomTtsAdapters(dataRoot);
  const voiceServices = readVoiceServices(dataRoot);
  const voiceProfiles = readVoiceProfiles(dataRoot);
  const profileChoices = voiceProfileChoices(voiceServices, voiceProfiles, customTtsAdapters);
  const customChoices = await customVoiceChoices(dataRoot, contacts, customTtsAdapters);
  const assignableVoices = [...profileChoices, ...customChoices].filter((item) => item.selectable !== false);
  const selections = await Promise.all(contacts.map(async (contact) => {
    const value = await readJson(path.join(rootForAgent(dataRoot, contact.agentId), "voice-message", "config.json"));
    return {
      ...contact,
      adapter: configuredAdapter(value),
      voiceId: configuredVoice(value),
      voiceProfileId: configuredVoiceProfile(value),
      customVoiceId: configuredCustomVoice(value),
      customAdapterId: configuredCustomAdapterId(value),
    };
  }));
  return {
    status: "ready",
    voiceServices: voiceServices.map(publicVoiceService),
    voiceProfiles: profileChoices,
    customVoices: customChoices,
    assignableVoices,
    customTtsAdapters: customTtsAdapters.map(publicCustomTtsAdapter),
    contacts: selections,
  };
}

export function registerVoiceDesignIpc({ connectionsService, contactProjectsService = null, ipcMain, settingsService }) {
  ipcMain.handle("voice-design:snapshot", () => snapshot(settingsService, contactProjectsService));
  const selectedApiConnection = async (connectionId) => {
    if (typeof connectionsService?.resolveApiConnectionById !== "function") {
      throw new Error("当前无法读取已保存的 API 连接。请更新 Suzu Lives 后重试。 ");
    }
    const connection = await connectionsService.resolveApiConnectionById(connectionId);
    if (!connection) throw new Error("找不到所选 API 连接。请先到 设置 → API 中新建或检查它。 ");
    return connection;
  };
  const checkedVoiceService = async (value, { current = null } = {}) => {
    const dataRoot = dataRootFor(settingsService);
    const service = normalizeVoiceService({
      ...plainObject(current),
      ...plainObject(value),
      id: clean(value?.id || current?.id) || randomUUID(),
      createdAt: clean(current?.createdAt) || clean(value?.createdAt) || new Date().toISOString(),
    });
    const connection = await selectedApiConnection(service.connectionId);
    if (!ttsAdapterSupportsConnection(service.adapter, connection.type)) {
      throw new Error(`${ttsAdapterLabel(service.adapter)}不能使用所选 API 连接；请换一个连接或服务类型。`);
    }
    const customAdapter = service.adapter === "custom-http-tts" ? findCustomTtsAdapter(dataRoot, service.customAdapterId) : null;
    if (service.adapter === "custom-http-tts" && !customAdapter) {
      throw new Error("请选择已保存的自定义协议。 ");
    }
    const serviceBaseUrl = service.adapter === "custom-http-tts"
      ? clean(customAdapter?.baseUrl || connection.baseUrl)
      : clean(ttsAdapterDefinition(service.adapter)?.defaultBaseUrl || connection.baseUrl);
    if (!serviceBaseUrl) {
      throw new Error(service.adapter === "custom-http-tts" ? "自定义协议需要填写服务地址。" : `${ttsAdapterLabel(service.adapter)}没有内置服务地址。`);
    }
    const endpointError = ttsAdapterEndpointCompatibilityError({ adapter: service.adapter, baseUrl: serviceBaseUrl });
    if (endpointError) throw new Error(endpointError);
    const modelError = ttsAdapterModelCompatibilityError({ adapter: service.adapter, model: service.model });
    if (modelError) throw new Error(modelError);
    return service;
  };
  ipcMain.handle("voice-design:save-service", async (_event, value) => {
    const dataRoot = dataRootFor(settingsService);
    const services = readVoiceServices(dataRoot);
    const requestedId = clean(plainObject(value).id).toLowerCase();
    const current = requestedId ? services.find((item) => item.id === requestedId) : null;
    if (requestedId && !current) throw new Error("找不到要编辑的语音服务。 ");
    if (!current && services.length >= MAX_VOICE_SERVICES) throw new Error(`语音服务不能超过 ${MAX_VOICE_SERVICES} 个。`);
    const service = await checkedVoiceService(value, { current });
    const duplicate = services.find((item) => item.id !== service.id && item.name.localeCompare(service.name, "zh-CN", { sensitivity: "accent" }) === 0);
    if (duplicate) throw new Error("已经有同名的语音服务。请换一个备注名。 ");
    const next = current ? services.map((item) => item.id === current.id ? service : item) : [service, ...services];
    await writeVoiceServices(dataRoot, next);
    return snapshot(settingsService, contactProjectsService);
  });
  ipcMain.handle("voice-design:delete-service", async (_event, value) => {
    const dataRoot = dataRootFor(settingsService);
    const id = clean(plainObject(value).id).toLowerCase();
    const services = readVoiceServices(dataRoot);
    const service = services.find((item) => item.id === id);
    if (!service) throw new Error("找不到这个语音服务。 ");
    const profiles = readVoiceProfiles(dataRoot);
    const references = profiles.filter((item) => item.serviceId === service.id);
    if (references.length) {
      throw new Error(`这个语音服务仍有 ${references.length} 个音色。请先删除或迁移这些音色。`);
    }
    await writeVoiceServices(dataRoot, services.filter((item) => item.id !== service.id));
    return snapshot(settingsService, contactProjectsService);
  });
  ipcMain.handle("voice-design:save-profile", async (_event, value) => {
    const dataRoot = dataRootFor(settingsService);
    const profiles = readVoiceProfiles(dataRoot);
    const requestedId = clean(plainObject(value).id).toLowerCase();
    const current = requestedId ? profiles.find((item) => item.id === requestedId) : null;
    if (requestedId && !current) throw new Error("找不到要编辑的音色。 ");
    if (!current && profiles.length >= MAX_VOICE_PROFILES) throw new Error(`音色不能超过 ${MAX_VOICE_PROFILES} 个。`);
    const profile = normalizeVoiceProfile({
      ...plainObject(current),
      ...plainObject(value),
      id: clean(value?.id || current?.id) || randomUUID(),
      createdAt: clean(current?.createdAt) || clean(value?.createdAt) || new Date().toISOString(),
    });
    const service = findVoiceService(dataRoot, profile.serviceId);
    if (!service) throw new Error("请选择一个可用的语音服务。 ");
    if (service.adapter === "custom-http-tts" && !findCustomTtsAdapter(dataRoot, service.customAdapterId)) {
      throw new Error("该语音服务使用的自定义协议已经不可用。 ");
    }
    const model = profile.model || service.model;
    const modelError = ttsAdapterModelCompatibilityError({ adapter: service.adapter, model });
    if (modelError) throw new Error(modelError);
    const voiceError = ttsAdapterVoiceCompatibilityError({ adapter: service.adapter, model, voiceId: profile.voiceId });
    if (voiceError) throw new Error(voiceError);
    const duplicate = profiles.find((item) => item.id !== profile.id && item.name.localeCompare(profile.name, "zh-CN", { sensitivity: "accent" }) === 0);
    if (duplicate) throw new Error("已经有同名的音色。请换一个备注名。 ");
    const next = current ? profiles.map((item) => item.id === current.id ? profile : item) : [profile, ...profiles];
    await writeVoiceProfiles(dataRoot, next);
    return snapshot(settingsService, contactProjectsService);
  });
  ipcMain.handle("voice-design:delete-profile", async (_event, value) => {
    const dataRoot = dataRootFor(settingsService);
    const id = clean(plainObject(value).id).toLowerCase();
    const profiles = readVoiceProfiles(dataRoot);
    const profile = profiles.find((item) => item.id === id);
    if (!profile) throw new Error("找不到这个音色。 ");
    const contacts = await contactsFor(contactProjectsService);
    const users = (await Promise.all(contacts.map(async (contact) => ({
      contact,
      config: await readJson(path.join(rootForAgent(dataRoot, contact.agentId), "voice-message", "config.json")),
    })))).filter(({ config }) => configuredVoiceProfile(config) === profile.id);
    if (users.length) {
      const labels = users.slice(0, 3).map(({ contact }) => contact.name).join("、");
      throw new Error(`这个音色正在供 ${labels}${users.length > 3 ? "等" : ""}${users.length} 位联系人使用。请先为他们换一个音色，再删除。`);
    }
    await writeVoiceProfiles(dataRoot, profiles.filter((item) => item.id !== profile.id));
    return snapshot(settingsService, contactProjectsService);
  });
  ipcMain.handle("voice-design:save-custom-tts-adapter", async (_event, value) => {
    const dataRoot = dataRootFor(settingsService);
    const adapters = await readCustomTtsAdapters(dataRoot);
    if (adapters.length >= MAX_CUSTOM_TTS_ADAPTERS) throw new Error(`自定义 TTS 适配器不能超过 ${MAX_CUSTOM_TTS_ADAPTERS} 个。`);
    const adapter = normalizeCustomTtsAdapter({
      ...plainObject(value),
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    }, { requireBaseUrl: true });
    if (adapters.some((item) => item.name.localeCompare(adapter.name, "zh-CN", { sensitivity: "accent" }) === 0)) {
      throw new Error("已经有同名的自定义 TTS 适配器。请换一个备注名。 ");
    }
    await writeCustomTtsAdapters(dataRoot, [adapter, ...adapters]);
    return snapshot(settingsService, contactProjectsService);
  });
  ipcMain.handle("voice-design:delete-custom-tts-adapter", async (_event, value) => {
    const dataRoot = dataRootFor(settingsService);
    const id = normalizedCustomAdapterId(plainObject(value).id);
    if (!id) throw new Error("请选择要删除的自定义 TTS 适配器。 ");
    const adapters = await readCustomTtsAdapters(dataRoot);
    const adapter = adapters.find((item) => item.id === id);
    if (!adapter) throw new Error("找不到这个自定义 TTS 适配器。 ");
    const serviceReferences = readVoiceServices(dataRoot).filter((item) => item.adapter === "custom-http-tts" && item.customAdapterId === id);
    if (serviceReferences.length) {
      const labels = serviceReferences.slice(0, 3).map((item) => item.name).join("、");
      throw new Error(`这个自定义协议仍被语音服务“${labels}${serviceReferences.length > 3 ? "等" : ""}”使用。请先调整或删除对应服务。`);
    }
    const contacts = await contactsFor(contactProjectsService);
    const libraries = [
      { label: "全局音色", voices: await readCustomVoices(dataRoot) },
      ...await Promise.all(contacts.map(async (contact) => ({
        label: `“${contact.name}”的音色`,
        voices: await readCustomVoices(rootForAgent(dataRoot, contact.agentId)),
      }))),
    ];
    const references = libraries.filter(({ voices }) => voices.some((voice) => voice.adapter === "custom-http-tts" && voice.customAdapterId === id));
    if (references.length) {
      const labels = references.slice(0, 3).map(({ label }) => label).join("、");
      throw new Error(`这个自定义协议仍被${labels}${references.length > 3 ? "等" : ""}${references.length}处音色使用。请先删除或替换对应音色。`);
    }
    await writeCustomTtsAdapters(dataRoot, adapters.filter((item) => item.id !== id));
    return snapshot(settingsService, contactProjectsService);
  });
  ipcMain.handle("voice-design:save-custom-audio", async (_event, value) => {
    const dataRoot = dataRootFor(settingsService);
    const input = plainObject(value);
    const name = boundedText(input.name, "声音备注名", 80);
    const configuredAdapter = customVoiceAdapter(input.adapter || input.provider);
    const configuredCustomAdapterId = normalizedCustomAdapterId(input.customAdapterId);
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
    const customTtsAdapters = await readCustomTtsAdapters(dataRoot);
    if (adapter === "custom-http-tts" && !customTtsAdapters.some((item) => item.id === configuredCustomAdapterId)) {
      throw new Error("请选择已保存的自定义 TTS 适配器。 ");
    }
    const resolvedModel = customVoiceModel(adapter, model);
    if (!ttsAdapterSupportsConnection(adapter, connection.type)) {
      throw new Error(`${customVoiceAdapterLabel(adapter)}不能使用当前选择的 API；请为“语音消息”选择兼容的 API 后再保存。`);
    }
    const modelCompatibilityError = ttsAdapterModelCompatibilityError({ adapter, model: resolvedModel });
    if (modelCompatibilityError) throw new Error(modelCompatibilityError);
    const voices = await readCustomVoices(dataRoot);
    if (voices.length >= MAX_CUSTOM_VOICES) throw new Error(`自定义音频不能超过 ${MAX_CUSTOM_VOICES} 条。`);
    voices.unshift({
      id: randomUUID(),
      name,
      adapter,
      voiceId,
      ...(adapter === "custom-http-tts" ? { customAdapterId: configuredCustomAdapterId } : {}),
      model: resolvedModel,
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
    const voiceProfileId = clean(input.voiceProfileId).toLowerCase();
    const configPath = path.join(rootForAgent(dataRoot, contact.agentId), "voice-message", "config.json");
    const existing = await readJson(configPath);
    if (voiceProfileId) {
      const selectedProfile = resolveVoiceProfile(dataRoot, voiceProfileId);
      if (!selectedProfile) throw new Error("所选音色已经不可用；请刷新后重新选择。 ");
      await writeJsonAtomic(configPath, {
        ...withoutVoiceSelection(existing),
        schemaVersion: 6,
        voiceProfileId: selectedProfile.profile.id,
      });
      return snapshot(settingsService, contactProjectsService);
    }
    const adapter = customVoiceAdapter(input.adapter || input.provider);
    const voiceId = boundedText(input.voiceId, "音色", 200);
    if (!voiceId) throw new Error("请选择一个音色。 ");
    if (!adapter) throw new Error("所选音色的接口适配器不可用。 ");
    const customVoiceId = boundedText(input.customVoiceId, "自定义音频", 100);
    const customAdapterId = normalizedCustomAdapterId(input.customAdapterId);
    const sourceContactId = boundedText(input.sourceContactId, "音色来源", 100);
    const customTtsAdapters = await readCustomTtsAdapters(dataRoot);
    const selected = (await customVoiceChoices(dataRoot, contacts, customTtsAdapters)).find((item) => (
      item.id === customVoiceId
      && item.adapter === adapter
      && item.voiceId === voiceId
      && item.customAdapterId === customAdapterId
      && item.sourceContactId === sourceContactId
      && item.selectable !== false
    ));
    if (!selected) throw new Error(`所选${customVoiceAdapterLabel(adapter)}已经不可用；请刷新后重新选择。 `);
    await writeJsonAtomic(configPath, {
      ...withoutVoiceSelection(existing),
      schemaVersion: 5,
      adapter,
      voiceId,
      customVoiceId,
      ...(selected.customAdapterId ? { customAdapterId: selected.customAdapterId } : {}),
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
      && configuredCustomAdapterId(config) === choice.customAdapterId
    ));
    if (users.length) {
      const labels = users.slice(0, 3).map(({ contact }) => contact.name).join("、");
      throw new Error(`这个音色正在供 ${labels}${users.length > 3 ? "等" : ""}${users.length} 位联系人使用。请先为他们换一个音色，再删除。`);
    }
    const voiceRoot = choice.source === "global" ? dataRoot : rootForAgent(dataRoot, choice.sourceAgentId);
    const voices = await readCustomVoices(voiceRoot);
    await writeCustomVoices(voiceRoot, voices.filter((item) => item.id !== id));
    return snapshot(settingsService, contactProjectsService);
  });
}
