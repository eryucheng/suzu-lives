import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";
import { appendUsageEvent } from "@suzu-lives/cost-ledger";
import { createVoiceCandidates, DEFAULT_VOICE_DESIGN_CONFIG, deleteVoiceCandidate, readCandidates, readPreview, renameVoiceCandidate, retainVoiceCandidate, validateVoiceDesignConfig, validateVoiceDesignSettings } from "@suzu-lives/voice-design";

const CUSTOM_VOICE_FILE = "custom-voices.json";
const MINIMAX_TTS_MODEL = "speech-2.8-hd";
const COSYVOICE_CLONE_TTS_MODEL = "cosyvoice-v3.5-plus";
const MAX_CUSTOM_VOICES = 100;

function clean(value) { return String(value ?? "").trim(); }
function plainObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function boundedText(value, label, maximum) {
  const result = clean(value);
  if (result.length > maximum) throw new Error(`${label}不能超过 ${maximum} 个字符。`);
  return result;
}
function existsDirectory(value) { try { return Boolean(value && fs.statSync(value).isDirectory()); } catch { return false; } }
function requireAgent(settings) {
  if (!settings.agentId || !settings.projectRoot || !existsDirectory(settings.projectRoot)) throw new Error("请先选择有效的 Claude 项目目录，再配置或创建音色。");
}
function dataRootFor(settingsService, settings = settingsService.load()) {
  const dataRoot = clean(settingsService.response(settings).dataRoot);
  if (!dataRoot) throw new Error("无法定位 Suzu Lives 的本机数据目录。 ");
  return path.resolve(dataRoot);
}
function pathsFor(settingsService) {
  const settings = settingsService.load();
  requireAgent(settings);
  const dataRoot = dataRootFor(settingsService, settings);
  const agentRoot = resolveAgentDataRoot({ dataRoot, agentId: settings.agentId });
  const root = path.join(agentRoot, "voice-design");
  return { settings, agentRoot, root, configPath: path.join(root, "config.json"), ledgerPath: settingsService.usageLedgerPath(settings) };
}
async function readJson(filePath, fallback = {}) { try { return JSON.parse(await fsp.readFile(filePath, "utf8")); } catch { return fallback; } }
async function writeJsonAtomic(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = filePath + ".tmp";
  await fsp.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fsp.rename(temporary, filePath);
}
function customVoicesPath(agentRoot) { return path.join(agentRoot, "voice-message", CUSTOM_VOICE_FILE); }
function isCustomVoiceProvider(value) { return value === "minimax" || value === "cosyvoice"; }
function customVoiceProviderLabel(provider) { return provider === "cosyvoice" ? "阿里百炼 CosyVoice 复刻音色" : "MiniMax 自定义音频"; }
function customVoiceModel(provider, value) { return clean(value) || (provider === "cosyvoice" ? COSYVOICE_CLONE_TTS_MODEL : MINIMAX_TTS_MODEL); }
function normalizedCustomVoices(value) {
  const document = plainObject(value);
  const voices = [];
  const seen = new Set();
  for (const item of (Array.isArray(document.voices) ? document.voices : []).slice(0, MAX_CUSTOM_VOICES)) {
    const source = plainObject(item);
    const id = clean(source.id);
    const name = clean(source.name);
    const provider = clean(source.provider).toLowerCase();
    const voiceId = clean(source.voiceId);
    const apiKey = clean(source.apiKey);
    if (!id || !name || !isCustomVoiceProvider(provider) || !voiceId || !apiKey || seen.has(id)) continue;
    seen.add(id);
    voices.push({
      id,
      name,
      provider,
      voiceId,
      apiKey,
      model: customVoiceModel(provider, source.model),
      createdAt: clean(source.createdAt),
    });
  }
  return voices;
}
async function readCustomVoices(agentRoot) {
  return normalizedCustomVoices(await readJson(customVoicesPath(agentRoot), { schemaVersion: 1, voices: [] }));
}
async function writeCustomVoices(agentRoot, voices) {
  await writeJsonAtomic(customVoicesPath(agentRoot), { schemaVersion: 1, voices });
}
function publicCustomVoices(voices) {
  return voices.map(({ id, name, provider, voiceId, model, createdAt }) => ({ id, name, provider, voiceId, model, createdAt }));
}
function candidateName(candidate) {
  return clean(candidate?.displayName) || clean(candidate?.preferredName) || "未命名音色";
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
async function qwenVoiceChoices(dataRoot, contacts) {
  const rows = await Promise.all(contacts.map(async (contact) => ({
    contact,
    candidates: await readCandidates(path.join(rootForAgent(dataRoot, contact.agentId), "voice-design")),
  })));
  return rows.flatMap(({ contact, candidates }) => candidates
    .filter((candidate) => candidate.retained && clean(candidate.id) && clean(candidate.voiceId))
    .map((candidate) => ({
      key: `qwen:${contact.id}:${candidate.id}`,
      provider: "qwen",
      voiceId: candidate.voiceId,
      name: candidateName(candidate),
      kindLabel: `百炼音色 · 来自 ${contact.name}`,
      sourceContactId: contact.id,
      sourceAgentId: contact.agentId,
      sourceCandidateId: candidate.id,
    })));
}
async function customVoiceChoices(dataRoot, contacts) {
  const result = [];
  const seen = new Set();
  for (const voice of publicCustomVoices(await readCustomVoices(dataRoot))) {
    if (seen.has(voice.id)) continue;
    seen.add(voice.id);
    result.push({
      ...voice,
      key: `${voice.provider}:global:${voice.id}`,
      kindLabel: customVoiceProviderLabel(voice.provider),
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
        key: `${voice.provider}:${contact.id}:${voice.id}`,
        kindLabel: `${customVoiceProviderLabel(voice.provider)} · 来自 ${contact.name}`,
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
function configuredProvider(value) {
  const config = plainObject(value);
  const tts = plainObject(config.tts);
  const provider = clean(config.provider || tts.provider).toLowerCase();
  if (provider === "minimax") return "minimax";
  if (provider === "cosyvoice") return "cosyvoice";
  return "qwen";
}
function configuredCustomVoice(value) {
  const config = plainObject(value);
  const tts = plainObject(config.tts);
  return clean(config.customVoiceId || tts.customVoiceId);
}
function withoutVoiceSelection(value) {
  const config = plainObject(value);
  const {
    voiceId: _voiceId,
    voice: _voice,
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
async function storedSettings(configPath) {
  const stored = await readJson(configPath);
  let settings;
  try { settings = validateVoiceDesignSettings(stored); } catch { settings = validateVoiceDesignSettings(DEFAULT_VOICE_DESIGN_CONFIG); }
  return settings;
}
function capabilityConfig(settings, connection) { return validateVoiceDesignConfig({ ...settings, baseUrl: connection.baseUrl }); }
async function snapshot(settingsService, connectionsService, contactProjectsService) {
  const settings = settingsService.load();
  const dataRoot = dataRootFor(settingsService, settings);
  const contacts = await contactsFor(contactProjectsService);
  const [qwenChoices, customChoices, connection] = await Promise.all([
    qwenVoiceChoices(dataRoot, contacts),
    customVoiceChoices(dataRoot, contacts),
    connectionsService.dashScopeSnapshot(),
  ]);
  const selections = await Promise.all(contacts.map(async (contact) => {
    const value = await readJson(path.join(rootForAgent(dataRoot, contact.agentId), "voice-message", "config.json"));
    return {
      ...contact,
      provider: configuredProvider(value),
      voiceId: configuredVoice(value),
      customVoiceId: configuredCustomVoice(value),
    };
  }));
  const usageByVoiceId = {};
  for (const contact of selections) {
    if (!contact.customVoiceId && contact.provider !== "minimax" && contact.voiceId) {
      usageByVoiceId[contact.voiceId] = [...(usageByVoiceId[contact.voiceId] || []), contact.name];
    }
  }
  const active = Boolean(settings.agentId && settings.projectRoot && existsDirectory(settings.projectRoot));
  const values = active ? pathsFor(settingsService) : null;
  const stored = values ? await storedSettings(values.configPath) : validateVoiceDesignSettings(DEFAULT_VOICE_DESIGN_CONFIG);
  const candidates = values ? await readCandidates(values.root) : [];
  const contactVoice = values ? await readJson(path.join(values.agentRoot, "voice-message", "config.json")) : {};
  const contactProvider = configuredProvider(contactVoice);
  return {
    status: active ? "ready" : "needs-project",
    config: stored,
    connection,
    candidates,
    customVoices: customChoices,
    assignableVoices: [...qwenChoices, ...customChoices],
    contacts: selections,
    usageByVoiceId,
    selectedVoiceId: typeof contactVoice.voiceId === "string" ? contactVoice.voiceId.trim() : "",
    selectedVoiceProvider: contactProvider,
    selectedCustomVoiceId: typeof contactVoice.customVoiceId === "string" ? contactVoice.customVoiceId.trim() : "",
  };
}

export function registerVoiceDesignIpc({ connectionsService, contactProjectsService = null, ipcMain, settingsService }) {
  ipcMain.handle("voice-design:snapshot", () => snapshot(settingsService, connectionsService, contactProjectsService));
  ipcMain.handle("voice-design:save-settings", async (_event, value) => {
    const values = pathsFor(settingsService);
    const settings = validateVoiceDesignSettings(value);
    await writeJsonAtomic(values.configPath, settings);
    return snapshot(settingsService, connectionsService, contactProjectsService);
  });
  ipcMain.handle("voice-design:save-custom-audio", async (_event, value) => {
    const dataRoot = dataRootFor(settingsService);
    const input = plainObject(value);
    const name = boundedText(input.name, "声音备注名", 80);
    const requestedProvider = clean(input.provider).toLowerCase();
    const provider = requestedProvider === "cosyvoice" ? "cosyvoice" : requestedProvider;
    const voiceId = boundedText(input.voiceId, "音色 ID", 200);
    const apiKey = boundedText(input.apiKey, "API Key", 4096);
    if (!name) throw new Error("请填写声音备注名。 ");
    if (!isCustomVoiceProvider(provider)) throw new Error("当前只支持 MiniMax 或阿里百炼复刻音色。 ");
    if (!voiceId) throw new Error(`请填写${customVoiceProviderLabel(provider)}的音色 ID。 `);
    if (!apiKey) throw new Error(`请填写${customVoiceProviderLabel(provider)}的 API Key。 `);
    const voices = await readCustomVoices(dataRoot);
    if (voices.length >= MAX_CUSTOM_VOICES) throw new Error(`自定义音频不能超过 ${MAX_CUSTOM_VOICES} 条。`);
    voices.unshift({
      id: randomUUID(),
      name,
      provider,
      voiceId,
      apiKey,
      model: customVoiceModel(provider),
      createdAt: new Date().toISOString(),
    });
    await writeCustomVoices(dataRoot, voices);
    return snapshot(settingsService, connectionsService, contactProjectsService);
  });
  ipcMain.handle("voice-design:save-contact-voice", async (_event, value) => {
    const input = plainObject(value);
    const dataRoot = dataRootFor(settingsService);
    const contacts = await contactsFor(contactProjectsService);
    const contactId = boundedText(input.contactId, "联系人", 100);
    const contact = contacts.find((item) => item.id === contactId);
    if (!contact) throw new Error("请选择联系人列表中的一位联系人。 ");
    const provider = clean(input.provider).toLowerCase();
    const voiceId = boundedText(input.voiceId, "音色", 200);
    if (!voiceId) throw new Error("请选择一个音色。 ");
    const configPath = path.join(rootForAgent(dataRoot, contact.agentId), "voice-message", "config.json");
    const existing = await readJson(configPath);
    const customVoiceId = boundedText(input.customVoiceId, "自定义音频", 100);
    const sourceContactId = boundedText(input.sourceContactId, "音色来源", 100);
    if (customVoiceId) {
      const selected = (await customVoiceChoices(dataRoot, contacts)).find((item) => (
        item.id === customVoiceId
        && item.provider === provider
        && item.voiceId === voiceId
        && item.sourceContactId === sourceContactId
      ));
      if (!selected) throw new Error(`所选${customVoiceProviderLabel(provider)}已经不可用；请刷新后重新选择。 `);
      await writeJsonAtomic(configPath, {
        ...withoutVoiceSelection(existing),
        schemaVersion: 3,
        provider,
        voiceId,
        customVoiceId,
        customVoiceSource: selected.source,
        ...(selected.source === "contact" ? { customVoiceSourceAgentId: selected.sourceAgentId } : {}),
      });
    } else if (provider === "qwen") {
      const sourceCandidateId = boundedText(input.sourceCandidateId, "候选音色", 100);
      const selected = (await qwenVoiceChoices(dataRoot, contacts)).find((item) => (
        item.sourceContactId === sourceContactId
        && item.sourceCandidateId === sourceCandidateId
        && item.voiceId === voiceId
      ));
      if (!selected) throw new Error("所选百炼音色已经不可用；请刷新后重新选择。 ");
      await writeJsonAtomic(configPath, {
        ...withoutVoiceSelection(existing),
        schemaVersion: 3,
        provider: "qwen",
        voiceId,
        sourceAgentId: selected.sourceAgentId,
        sourceCandidateId: selected.sourceCandidateId,
      });
    } else {
      throw new Error("请先选择一个已保存的 MiniMax 或阿里百炼复刻音色。 ");
    }
    return snapshot(settingsService, connectionsService, contactProjectsService);
  });
  ipcMain.handle("voice-design:create", async (_event, input) => {
    const values = pathsFor(settingsService);
    const stored = await storedSettings(values.configPath);
    const connection = await connectionsService.resolveDashScope();
    if (!connection.key) {
      if (["unreadable", "invalid", "encryption-unavailable"].includes(connection.credentialStatus)) {
        throw new Error("声音 API 已绑定，但保存的阿里百炼 Key 无法读取。请前往 管理 → API，编辑“阿里百炼”并重新填写、保存 API Key。");
      }
      throw new Error("未配置 DashScope 连接。请前往 管理 → API 与服务 保存 API Key，或设置 DASHSCOPE_API_KEY。");
    }
    const config = capabilityConfig(stored, connection);
    await createVoiceCandidates({
      root: values.root,
      config,
      input,
      apiKey: connection.key,
      onSuccess: async (item) => appendUsageEvent(values.ledgerPath, {
        agentId: values.settings.agentId,
        provider: "阿里云百炼",
        model: item.request.model || config.designModel,
        source: "音色设计",
        feature: "voice-design",
        requestId: item.request.requestId,
        usage: item.request.usage,
        units: { generatedVoices: 1 },
        metadata: { targetModel: config.targetModel, language: config.language, previewCharacters: item.input.previewText.length },
      }),
    });
    return snapshot(settingsService, connectionsService, contactProjectsService);
  });
  ipcMain.handle("voice-design:rename-candidate", async (_event, value) => {
    const values = pathsFor(settingsService);
    await renameVoiceCandidate(values.root, value);
    return snapshot(settingsService, connectionsService, contactProjectsService);
  });
  ipcMain.handle("voice-design:retain-candidate", async (_event, id) => {
    const values = pathsFor(settingsService);
    await retainVoiceCandidate(values.root, id);
    return snapshot(settingsService, connectionsService, contactProjectsService);
  });
  ipcMain.handle("voice-design:delete-candidate", async (_event, id) => {
    const values = pathsFor(settingsService);
    const candidate = (await readCandidates(values.root)).find((item) => item.id === String(id ?? "").trim());
    if (!candidate) throw new Error("找不到这个音色候选。");
    const contacts = await contactsFor(contactProjectsService);
    const dataRoot = dataRootFor(settingsService);
    const users = (await Promise.all(contacts.map(async (contact) => ({
      contact,
      config: await readJson(path.join(rootForAgent(dataRoot, contact.agentId), "voice-message", "config.json")),
    })))).filter(({ config }) => !configuredCustomVoice(config) && configuredProvider(config) !== "minimax" && candidate.voiceId && candidate.voiceId === configuredVoice(config));
    if (users.length) {
      const labels = users.slice(0, 3).map(({ contact }) => contact.name).join("、");
      throw new Error(`这个音色正在供 ${labels}${users.length > 3 ? "等" : ""}${users.length} 位联系人使用。请先为他们换一个音色，再删除。`);
    }
    if (!contacts.length) {
      const contactVoice = await readJson(path.join(values.agentRoot, "voice-message", "config.json"));
      if (!configuredCustomVoice(contactVoice) && configuredProvider(contactVoice) !== "minimax" && candidate.voiceId && candidate.voiceId === configuredVoice(contactVoice)) {
        throw new Error("这个音色正在被联系人使用。请先换一个音色，再删除。");
      }
    }
    await deleteVoiceCandidate(values.root, id);
    return snapshot(settingsService, connectionsService, contactProjectsService);
  });
  ipcMain.handle("voice-design:preview", async (_event, id) => {
    const values = pathsFor(settingsService);
    const preview = await readPreview(values.root, id);
    if (!preview) return null;
    const mime = preview.responseFormat === "wav" ? "audio/wav" : preview.responseFormat === "mp3" ? "audio/mpeg" : "audio/" + preview.responseFormat;
    return "data:" + mime + ";base64," + preview.data;
  });
}
