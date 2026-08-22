import fs from "node:fs";
import path from "node:path";

import { findCustomTtsAdapter } from "./custom-tts-adapters.mjs";
import { normalizeTtsAdapter, ttsAdapterDefinition, ttsAdapterLabel } from "./tts-adapters.mjs";

export const VOICE_SERVICE_FILE = "voice-services.json";
export const VOICE_PROFILE_FILE = "voice-profiles.json";
export const VOICE_SERVICE_SCHEMA_VERSION = 1;
export const VOICE_PROFILE_SCHEMA_VERSION = 1;
export const MAX_VOICE_SERVICES = 40;
export const MAX_VOICE_PROFILES = 160;

const ID = /^[a-z0-9][a-z0-9-]{7,99}$/u;
const MAX_NAME_LENGTH = 80;
const MAX_CONNECTION_ID_LENGTH = 80;
const MAX_MODEL_LENGTH = 160;
const MAX_VOICE_ID_LENGTH = 200;

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function boundedText(value, label, maximum, { required = false } = {}) {
  const result = clean(value);
  if (required && !result) throw new Error(`${label}不能为空。`);
  if (result.length > maximum) throw new Error(`${label}不能超过 ${maximum} 个字符。`);
  return result;
}

function normalizedId(value, label, { required = true } = {}) {
  const id = clean(value).toLowerCase();
  if (!id && !required) return "";
  if (!ID.test(id)) throw new Error(`${label}无效。`);
  return id;
}

function documentAt(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
  } catch {
    return {};
  }
}

export function voiceServicesPath(dataRoot) {
  const root = clean(dataRoot);
  if (!root) throw new Error("缺少本机数据目录。 ");
  return path.join(path.resolve(root), "voice-message", VOICE_SERVICE_FILE);
}

export function voiceProfilesPath(dataRoot) {
  const root = clean(dataRoot);
  if (!root) throw new Error("缺少本机数据目录。 ");
  return path.join(path.resolve(root), "voice-message", VOICE_PROFILE_FILE);
}

/**
 * A voice service owns a request protocol and one saved API connection.  It
 * intentionally contains no credential: credentials remain in the named API
 * connection store, while contacts only point at a voice profile.
 */
export function normalizeVoiceService(value, { requireId = true } = {}) {
  const source = plainObject(value);
  const adapter = normalizeTtsAdapter(source.adapter || source.protocol);
  if (!adapter) throw new Error("请选择受支持的语音服务类型。 ");
  const definition = ttsAdapterDefinition(adapter);
  const customAdapterId = normalizedId(source.customAdapterId, "自定义协议标识", { required: adapter === "custom-http-tts" });
  if (adapter !== "custom-http-tts" && customAdapterId) {
    throw new Error("内置语音服务不能引用自定义协议。 ");
  }
  return Object.freeze({
    ...(requireId ? { id: normalizedId(source.id, "语音服务标识") } : (clean(source.id) ? { id: normalizedId(source.id, "语音服务标识") } : {})),
    name: boundedText(source.name, "语音服务名称", MAX_NAME_LENGTH, { required: true }),
    adapter,
    connectionId: boundedText(source.connectionId, "API 连接", MAX_CONNECTION_ID_LENGTH, { required: true }),
    model: boundedText(source.model || definition?.defaultModel, "默认模型", MAX_MODEL_LENGTH),
    ...(customAdapterId ? { customAdapterId } : {}),
    createdAt: boundedText(source.createdAt, "创建时间", 100),
  });
}

export function normalizeVoiceServices(value) {
  const source = plainObject(value);
  const services = [];
  const seen = new Set();
  for (const item of (Array.isArray(source.services) ? source.services : []).slice(0, MAX_VOICE_SERVICES)) {
    try {
      const service = normalizeVoiceService(item);
      if (seen.has(service.id)) continue;
      seen.add(service.id);
      services.push(service);
    } catch {
      // An invalid local record must not hide usable services.
    }
  }
  return services;
}

export function normalizeVoiceProfile(value, { requireId = true } = {}) {
  const source = plainObject(value);
  return Object.freeze({
    ...(requireId ? { id: normalizedId(source.id, "音色标识") } : (clean(source.id) ? { id: normalizedId(source.id, "音色标识") } : {})),
    serviceId: normalizedId(source.serviceId, "语音服务标识"),
    name: boundedText(source.name, "音色名称", MAX_NAME_LENGTH, { required: true }),
    voiceId: boundedText(source.voiceId, "音色 ID", MAX_VOICE_ID_LENGTH, { required: true }),
    model: boundedText(source.model, "音色模型", MAX_MODEL_LENGTH),
    createdAt: boundedText(source.createdAt, "创建时间", 100),
  });
}

export function normalizeVoiceProfiles(value) {
  const source = plainObject(value);
  const profiles = [];
  const seen = new Set();
  for (const item of (Array.isArray(source.profiles) ? source.profiles : []).slice(0, MAX_VOICE_PROFILES)) {
    try {
      const profile = normalizeVoiceProfile(item);
      if (seen.has(profile.id)) continue;
      seen.add(profile.id);
      profiles.push(profile);
    } catch {
      // An invalid local record must not hide usable voices.
    }
  }
  return profiles;
}

export function readVoiceServices(dataRoot) {
  return normalizeVoiceServices(documentAt(voiceServicesPath(dataRoot)));
}

export function readVoiceProfiles(dataRoot) {
  return normalizeVoiceProfiles(documentAt(voiceProfilesPath(dataRoot)));
}

export function findVoiceService(dataRoot, id) {
  const identity = clean(id).toLowerCase();
  return readVoiceServices(dataRoot).find((item) => item.id === identity) || null;
}

export function findVoiceProfile(dataRoot, id) {
  const identity = clean(id).toLowerCase();
  return readVoiceProfiles(dataRoot).find((item) => item.id === identity) || null;
}

export function resolveVoiceProfile(dataRoot, id) {
  const profile = findVoiceProfile(dataRoot, id);
  if (!profile) return null;
  const service = findVoiceService(dataRoot, profile.serviceId);
  if (!service) return null;
  if (service.adapter === "custom-http-tts" && !findCustomTtsAdapter(dataRoot, service.customAdapterId)) return null;
  return { profile, service };
}

export function publicVoiceService(value) {
  const service = normalizeVoiceService(value);
  return {
    id: service.id,
    name: service.name,
    adapter: service.adapter,
    typeLabel: ttsAdapterLabel(service.adapter),
    connectionId: service.connectionId,
    model: service.model,
    ...(service.customAdapterId ? { customAdapterId: service.customAdapterId } : {}),
    createdAt: service.createdAt,
  };
}

export function publicVoiceProfile(value, service = null) {
  const profile = normalizeVoiceProfile(value);
  return {
    id: profile.id,
    serviceId: profile.serviceId,
    name: profile.name,
    voiceId: profile.voiceId,
    model: profile.model,
    serviceName: clean(service?.name),
    serviceTypeLabel: service ? ttsAdapterLabel(service.adapter) : "",
    createdAt: profile.createdAt,
  };
}

export function voiceServiceDefaultModel(adapter) {
  return clean(ttsAdapterDefinition(adapter)?.defaultModel);
}
