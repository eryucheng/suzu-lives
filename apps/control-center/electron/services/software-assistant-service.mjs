import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  SUZU_AGENT_PERMISSION_MODES,
  SUZU_AGENT_REASONING_EFFORTS,
} from "@suzu-lives/suzu-agent-runtime";
import { DEFAULT_SUZU_SOFTWARE_ASSISTANT_COMPACTION_PROMPT } from "@suzu-lives/suzu-agent-runtime/software-assistant-compaction-prompt";
import { formatErrorForDisplay } from "@suzu-lives/suzu-agent-runtime/error-detail";
import { normalizeSquareAvatarImage } from "@suzu-lives/suzu-agent-runtime/avatar-image";
import {
  DEFAULT_SUZU_COMPACTION_RETAIN_TOKENS,
  DEFAULT_SUZU_COMPACTION_TOKEN_THRESHOLD,
} from "@suzu-lives/suzu-agent-runtime/compaction-defaults";

import { SUZU_SOFTWARE_ASSISTANT_AGENT_PRESET } from "./suzu-agent-runtime.mjs";
import {
  characterAvatarProviderOrigins,
  resolveCharacterAvatar,
} from "./character-avatar-provider.mjs";
import { resolveCharacterProfile } from "./character-profile-provider.mjs";
import { inferContactAvatarCrop } from "./contact-avatar-cropping.mjs";
import { conversationDisplayMessages } from "./conversation-reader.mjs";
import { completedConversationReplyPrefix } from "../../shared/conversation-reply-segmentation.mjs";
import {
  getSuzuSearchItem,
  searchSuzuSearchItems,
} from "../../src/core/suzu-search.mjs";
import { apiConnectionEndpointPreset } from "../../src/features/api-connections/catalog.mjs";

export const SUZU_SOFTWARE_ASSISTANT_SESSION_ID = "suzu-software-assistant";
export const SUZU_SOFTWARE_ASSISTANT_AGENT_ID = "suzu-software-assistant";
export const SUZU_SOFTWARE_ASSISTANT_NAME = "suzu助手";
const MAX_HISTORY_MESSAGES = 300;
const MAX_USAGE_HISTORY_MESSAGES = 2_000;
const MAX_MESSAGE_LENGTH = 12_000;
const MAX_STREAMED_TEXT_LENGTH = 100_000;
const MAX_AVATAR_DATA_URL_LENGTH = 2_800_000;
const MAX_AVATAR_FILE_BYTES = 2_000_000;
const MAX_CHARACTER_AVATAR_QUERY_LENGTH = 120;
const MAX_PAGE_SEARCH_QUERY_LENGTH = 120;
const PAGE_SEARCH_RESULT_LIMIT = 5;
const MAX_CONTACT_SEARCH_QUERY_LENGTH = 120;
const MAX_API_CONNECTION_SEARCH_QUERY_LENGTH = 120;
const CONTACT_SEARCH_RESULT_LIMIT = 12;
const MAX_CONTACT_FILE_RESULT_LENGTH = 24_000;
const CONTACT_RELATIONSHIP_SECTIONS = Object.freeze({
  relationship: "SUZU.md",
  persona: "persona.md",
  user: "user.md",
});
const MOEGIRLPEDIA_API_ORIGIN = "https://zh.moegirl.org.cn";
const MOEGIRLPEDIA_IMAGE_ORIGIN = "https://storage.moegirl.org.cn";
const MOEGIRLPEDIA_SEARCH_RESULT_LIMIT = 8;
const MOEGIRLPEDIA_VISIBLE_CANDIDATE_LIMIT = 4;
const REMOTE_AVATAR_REQUEST_TIMEOUT_MS = 6_000;
const REMOTE_AVATAR_IMAGE_ORIGINS = new Set([
  characterAvatarProviderOrigins.anilistImage,
  characterAvatarProviderOrigins.bangumiImage,
  MOEGIRLPEDIA_IMAGE_ORIGIN,
]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAIN_MODEL_PROVIDER_ALIASES = Object.freeze({
  openai: Object.freeze({
    provider: "custom",
    route: "suzu-openai",
    providerLabel: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6",
    protocol: "openai-responses",
    supportsImageInput: true,
  }),
  zhipu: Object.freeze({
    provider: "custom",
    route: "suzu-zhipu",
    providerLabel: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-5.2",
    protocol: "openai-completions",
  }),
  ollama: Object.freeze({
    provider: "custom",
    route: "suzu-ollama",
    providerLabel: "本地 Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    protocol: "openai-completions",
  }),
  moonshot: Object.freeze({ provider: "kimi-api" }),
  tongyi: Object.freeze({ provider: "bailian-payg" }),
  dashscope: Object.freeze({ provider: "bailian-payg" }),
  bailian: Object.freeze({ provider: "bailian-payg" }),
});
const API_CONNECTION_CUSTOM_PROVIDERS = Object.freeze({
  "custom-openai": Object.freeze({ type: "openai-compatible", label: "OpenAI 兼容 API", baseUrl: "" }),
  "tts-api": Object.freeze({ type: "tts-api", label: "TTS API", baseUrl: "" }),
  "asr-api": Object.freeze({ type: "asr-api", label: "ASR API", baseUrl: "" }),
  "generic-api": Object.freeze({ type: "generic-api", label: "通用 API", baseUrl: "" }),
});

class SoftwareAssistantServiceError extends Error {
  constructor(message, { cause, code = "SOFTWARE_ASSISTANT_ERROR" } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SoftwareAssistantServiceError";
    this.code = code;
  }
}

export { SoftwareAssistantServiceError };

function clean(value) {
  return String(value ?? "").trim();
}

function errorMessage(error, fallback) {
  return formatErrorForDisplay(error, { fallback });
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function hasOwn(value, key) {
  return Object.hasOwn(plainObject(value), key);
}

function contactLocations(value) {
  const contact = plainObject(value);
  const projectRoot = clean(contact.projectRoot);
  return {
    projectRoot,
    relationshipFiles: Object.fromEntries(Object.entries(CONTACT_RELATIONSHIP_SECTIONS).map(([section, fileName]) => ([
      section,
      projectRoot ? path.join(projectRoot, fileName) : "",
    ]))),
  };
}

function contactSummary(value, snapshot = {}) {
  const contact = plainObject(value);
  const contactId = clean(contact.id);
  return {
    contactId,
    name: clean(contact.name),
    agentId: clean(contact.agentId),
    sessionId: clean(contact.sessionId),
    active: contactId === clean(snapshot?.activeContact?.id),
    preferred: contactId === clean(snapshot?.preferredContact?.id),
    pinned: contact.pinned === true,
    muted: contact.muted === true,
    longTermMemoryEnabled: contact.longTermMemoryEnabled !== false,
    permissionMode: clean(contact.permissionMode),
    reasoningEffort: clean(contact.reasoningEffort),
    locations: contactLocations(contact),
  };
}

function boundedContactFile(value) {
  const file = plainObject(value);
  const content = String(file.content ?? "");
  const truncated = content.length > MAX_CONTACT_FILE_RESULT_LENGTH;
  return {
    path: clean(file.path),
    exists: file.exists === true,
    content: truncated ? `${content.slice(0, MAX_CONTACT_FILE_RESULT_LENGTH - 1)}…` : content,
    truncated,
  };
}

function avatarMimeType(value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array ? Buffer.from(value) : Buffer.alloc(0);
  if (bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 12
    && bytes.toString("ascii", 0, 4) === "RIFF"
    && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return "";
}

function avatarFileExtension(mimeType) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "";
}

function normalizedSearchText(value) {
  return clean(value).replace(/[\s\u3000]+/gu, "").toLocaleLowerCase();
}

function normalizedEndpointText(value) {
  return clean(value).replace(/\/+$/u, "").toLocaleLowerCase();
}

function mainModelPublicSnapshot(value) {
  const snapshot = plainObject(value);
  return {
    status: clean(snapshot.status),
    providerId: clean(snapshot.providerId),
    provider: clean(snapshot.provider),
    protocol: clean(snapshot.protocol),
    baseUrl: clean(snapshot.baseUrl),
    model: clean(snapshot.model),
    models: (Array.isArray(snapshot.models) ? snapshot.models : []).map(clean).filter(Boolean),
    hasApiKey: snapshot.hasApiKey === true,
    apiKeyWritable: snapshot.apiKeyWritable !== false,
  };
}

function apiConnectionPublicSummary(value) {
  const connection = plainObject(value);
  return {
    id: clean(connection.id),
    name: clean(connection.name),
    type: clean(connection.type),
    service: clean(connection.service),
    baseUrl: clean(connection.baseUrl),
    model: clean(connection.model),
    configured: connection.configured === true,
    credentialStatus: clean(connection.credentialStatus),
  };
}

function apiConnectionProvider(value) {
  const id = clean(value).toLowerCase();
  const preset = apiConnectionEndpointPreset(id);
  if (preset) return { id, type: preset.type, label: preset.label, baseUrl: preset.baseUrl };
  const custom = API_CONNECTION_CUSTOM_PROVIDERS[id];
  return custom ? { id, ...custom } : null;
}

function urlAtOrigin(value, origin) {
  try {
    const url = new URL(clean(value));
    return url.protocol === "https:" && url.origin === origin ? url.toString() : "";
  } catch {
    return "";
  }
}

function moegirlpediaApiUrl(parameters) {
  const url = new URL("/api.php", MOEGIRLPEDIA_API_ORIGIN);
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
  }
  return url.toString();
}

function moegirlpediaCandidates(value) {
  const query = plainObject(plainObject(value).query);
  const pages = Array.isArray(query.pages) ? query.pages : [];
  return pages
    .map((entry) => plainObject(entry))
    .sort((left, right) => Number(left.index ?? Number.MAX_SAFE_INTEGER) - Number(right.index ?? Number.MAX_SAFE_INTEGER))
    .map((page) => {
      const title = clean(page.title);
      const sourceUrl = urlAtOrigin(page.fullurl || page.canonicalurl, MOEGIRLPEDIA_API_ORIGIN);
      const thumbnail = plainObject(page.thumbnail);
      const thumbnailUrl = urlAtOrigin(thumbnail.source, MOEGIRLPEDIA_IMAGE_ORIGIN);
      if (!title || !sourceUrl || !thumbnailUrl) return null;
      return Object.freeze({ title, sourceUrl, thumbnailUrl });
    })
    .filter(Boolean);
}

async function fetchMoegirlpediaResponse(fetchImpl, url, accept) {
  if (typeof fetchImpl !== "function") {
    throw new SoftwareAssistantServiceError("当前版本没有可用的萌娘百科联网接口。", { code: "MOEGIRLPEDIA_FETCH_UNAVAILABLE" });
  }
  const signal = typeof globalThis.AbortSignal?.timeout === "function"
    ? globalThis.AbortSignal.timeout(REMOTE_AVATAR_REQUEST_TIMEOUT_MS)
    : undefined;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        accept,
        "user-agent": "Suzu-Lives/0.3 contact-avatar lookup",
      },
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw new SoftwareAssistantServiceError("无法连接萌娘百科。", {
      cause: error,
      code: "MOEGIRLPEDIA_FETCH_FAILED",
    });
  }
  if (response?.ok !== true) {
    throw new SoftwareAssistantServiceError("萌娘百科暂时没有返回可用结果。", { code: "MOEGIRLPEDIA_RESPONSE_INVALID" });
  }
  return response;
}

async function fetchMoegirlpediaJson(fetchImpl, url) {
  const response = await fetchMoegirlpediaResponse(fetchImpl, url, "application/json");
  try {
    return await response.json();
  } catch (error) {
    throw new SoftwareAssistantServiceError("萌娘百科返回的数据无法读取。", {
      cause: error,
      code: "MOEGIRLPEDIA_JSON_INVALID",
    });
  }
}

async function downloadRemoteAvatarPreview({
  fetchImpl,
  fsOps,
  imageUrl,
  sourceSlug = "character",
  targetDirectory,
}) {
  let imageOrigin = "";
  try { imageOrigin = new URL(clean(imageUrl)).origin; } catch { imageOrigin = ""; }
  const safeUrl = REMOTE_AVATAR_IMAGE_ORIGINS.has(imageOrigin)
    ? urlAtOrigin(imageUrl, imageOrigin)
    : "";
  if (!safeUrl || !REMOTE_AVATAR_IMAGE_ORIGINS.has(imageOrigin)) {
    throw new SoftwareAssistantServiceError("头像来源地址无效。", { code: "REMOTE_AVATAR_URL_INVALID" });
  }
  if (typeof fetchImpl !== "function") {
    throw new SoftwareAssistantServiceError("当前版本没有可用的头像联网接口。", { code: "REMOTE_AVATAR_FETCH_UNAVAILABLE" });
  }
  const signal = typeof globalThis.AbortSignal?.timeout === "function"
    ? globalThis.AbortSignal.timeout(REMOTE_AVATAR_REQUEST_TIMEOUT_MS)
    : undefined;
  let response;
  try {
    response = await fetchImpl(safeUrl, {
      headers: {
        accept: "image/avif,image/webp,image/png,image/jpeg",
        "user-agent": "Suzu-Lives/0.3.2 (contact-avatar)",
      },
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw new SoftwareAssistantServiceError("头像预览无法下载。", {
      cause: error,
      code: "REMOTE_AVATAR_FETCH_FAILED",
    });
  }
  if (response?.ok !== true) {
    throw new SoftwareAssistantServiceError("头像来源暂时没有返回可用图片。", { code: "REMOTE_AVATAR_RESPONSE_INVALID" });
  }
  const contentLength = clean(response.headers?.get?.("content-length"));
  if (contentLength && Number(contentLength) > MAX_AVATAR_FILE_BYTES) {
    throw new SoftwareAssistantServiceError("头像预览超过 2 MB。", { code: "REMOTE_AVATAR_TOO_LARGE" });
  }
  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new SoftwareAssistantServiceError("头像预览无法读取。", {
      cause: error,
      code: "REMOTE_AVATAR_READ_FAILED",
    });
  }
  if (bytes.length > MAX_AVATAR_FILE_BYTES) {
    throw new SoftwareAssistantServiceError("头像预览超过 2 MB。", { code: "REMOTE_AVATAR_TOO_LARGE" });
  }
  const mimeType = avatarMimeType(bytes);
  const extension = avatarFileExtension(mimeType);
  if (!extension) {
    throw new SoftwareAssistantServiceError("头像预览不是受支持的图片格式。", { code: "REMOTE_AVATAR_INVALID" });
  }
  await fsOps.mkdir(targetDirectory, { recursive: true });
  const safeSlug = clean(sourceSlug).toLocaleLowerCase().replace(/[^a-z0-9-]+/gu, "-") || "character";
  const avatarPath = path.join(targetDirectory, `${safeSlug}-${randomUUID()}.${extension}`);
  await fsOps.writeFile(avatarPath, bytes);
  return { avatarPath, mimeType };
}

async function downloadMoegirlpediaThumbnail({ fetchImpl, fsOps, targetDirectory, thumbnailUrl }) {
  return downloadRemoteAvatarPreview({
    fetchImpl,
    fsOps,
    imageUrl: thumbnailUrl,
    sourceSlug: "moegirlpedia",
    targetDirectory,
  });
}

function identityWithAgentAvatar(settings, agentId, avatarDataUrl) {
  const identity = plainObject(settings?.identity);
  const agents = plainObject(identity.agents);
  const currentProfile = plainObject(agents[agentId]);
  const fallbackProfile = plainObject(identity.defaultAgent);
  return {
    owner: { ...plainObject(identity.owner) },
    defaultAgent: { ...fallbackProfile },
    agents: {
      ...agents,
      [agentId]: {
        ...(Object.keys(currentProfile).length ? currentProfile : fallbackProfile),
        avatarDataUrl,
      },
    },
  };
}

function requiredDirectory(value, label) {
  const source = clean(value);
  if (!source || !path.isAbsolute(source)) {
    throw new SoftwareAssistantServiceError(`${label}必须是绝对目录。`, { code: "WORKSPACE_INVALID" });
  }
  return path.resolve(source);
}

function optionalAbsolutePath(value) {
  const source = clean(value);
  return source && path.isAbsolute(source) ? path.resolve(source) : "";
}

function bounded(value, limit = MAX_STREAMED_TEXT_LENGTH) {
  const text = String(value ?? "");
  const suffix = "…";
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - suffix.length))}${suffix}` : text;
}

function mergeFullText(previous, next) {
  const current = bounded(previous);
  const candidate = bounded(next);
  if (!candidate) return current;
  if (!current || candidate.startsWith(current)) return candidate;
  if (current.startsWith(candidate)) return current;
  if (current.endsWith(candidate)) return current;
  return bounded(`${current}${candidate}`);
}

function completedAssistantMessageCount(event) {
  const value = Number(event?.data?.assistantMessageCount);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function visibleMessages(events) {
  return conversationDisplayMessages(events, MAX_HISTORY_MESSAGES)
    // Product work should remain inspectable in this chat, including native
    // tool calls and results. They are rendered with the normal conversation
    // detail cards instead of being folded into the final answer.
    .filter((message) => ["user", "assistant", "system"].includes(clean(message?.kind)));
}

function historyEventSequence(entry) {
  const source = plainObject(entry);
  const wrapped = plainObject(source.event);
  const sequence = Number(Object.keys(wrapped).length ? wrapped.seq : source.seq);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}

function oldestHistorySequence(events) {
  const sequences = (Array.isArray(events) ? events : [])
    .map(historyEventSequence)
    .filter((sequence) => sequence !== null);
  return sequences.length ? Math.min(...sequences) : null;
}

function updateStatusText(value) {
  const source = plainObject(value);
  const status = clean(source.status).toLowerCase();
  const availableVersion = clean(source.availableVersion);
  if (status === "available") return availableVersion ? `发现新版本 ${availableVersion}` : "发现新版本";
  if (status === "downloaded") return availableVersion ? `新版本 ${availableVersion} 已下载` : "新版本已下载";
  if (status === "installing") return "正在安装更新";
  if (status === "current") return "已是最新版本";
  if (status === "ready") return "可检查更新";
  if (status === "development") return "开发环境";
  if (status === "manual") return "当前构建使用手动更新";
  if (status === "unavailable") return "当前构建未启用自动更新";
  if (status === "error") return "更新服务状态异常";
  return "";
}

/** Resolves the managed workspace for the product helper. */
export function resolveSoftwareAssistantWorkspace(dataRoot) {
  return path.join(requiredDirectory(dataRoot, "Suzu 软件数据目录"), "software-assistant", "workspace");
}

/** Returns the stable non-contact owner used by the unified cost ledger. */
export function softwareAssistantUsageSubject(dataRoot) {
  return Object.freeze({
    agentId: SUZU_SOFTWARE_ASSISTANT_AGENT_ID,
    projectRoot: resolveSoftwareAssistantWorkspace(dataRoot),
    sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
    subjectId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
    subjectName: SUZU_SOFTWARE_ASSISTANT_NAME,
    subjectType: "system-assistant",
  });
}

/**
 * A dedicated conversation service for the built-in product helper. It keeps
 * a fixed session and workspace, and receives live product state per request.
 * Its normal local tools may still inspect a local file when the user asks it
 * to diagnose that specific data, just like any other local Agent.
 */
export function createSoftwareAssistantService({
  apiConnectionsSnapshot = null,
  applicationStatus = null,
  applicationPath = "",
  contactSnapshot = null,
  createContact = null,
  dataRoot,
  mainModelSnapshot = null,
  readRelationshipFiles = null,
  renameContact = null,
  runtime,
  saveApiConnection = null,
  saveMainModelConfiguration = null,
  saveRelationshipFile = null,
  settingsService,
  updateContactLongTermMemoryEnabled = null,
  updateContactPermissionMode = null,
  updateContactPresentation = null,
  updateContactReasoningEffort = null,
  usageLedger = null,
  fsOps = fs,
  fetchImpl = globalThis.fetch,
  onEvent = () => {},
} = {}) {
  if (typeof runtime?.ensureSession !== "function" || typeof runtime?.history !== "function" || typeof runtime?.sendTurn !== "function" || typeof runtime?.cancelTurn !== "function" || typeof runtime?.purgeSession !== "function" || typeof runtime?.respondLifecycleRequest !== "function" || typeof runtime?.subscribe !== "function") {
    throw new SoftwareAssistantServiceError("软件助手需要完整的 Agent Core 会话运行时。", { code: "RUNTIME_REQUIRED" });
  }
  if (!settingsService?.load || !settingsService?.update) {
    throw new SoftwareAssistantServiceError("软件助手需要软件设置服务。", { code: "SETTINGS_REQUIRED" });
  }
  if (!fsOps?.mkdir) {
    throw new SoftwareAssistantServiceError("软件助手需要本机文件接口。", { code: "FILESYSTEM_REQUIRED" });
  }
  if ((contactSnapshot !== null && typeof contactSnapshot !== "function")
    || (createContact !== null && typeof createContact !== "function")
    || (readRelationshipFiles !== null && typeof readRelationshipFiles !== "function")
    || (renameContact !== null && typeof renameContact !== "function")
    || (updateContactLongTermMemoryEnabled !== null && typeof updateContactLongTermMemoryEnabled !== "function")
    || (updateContactPermissionMode !== null && typeof updateContactPermissionMode !== "function")
    || (updateContactPresentation !== null && typeof updateContactPresentation !== "function")
    || (updateContactReasoningEffort !== null && typeof updateContactReasoningEffort !== "function")
    || (saveRelationshipFile !== null && typeof saveRelationshipFile !== "function")) {
    throw new SoftwareAssistantServiceError("软件助手的联系人操作接口无效。", { code: "CONTACT_ACTIONS_INVALID" });
  }
  if (applicationStatus !== null && typeof applicationStatus !== "function") {
    throw new SoftwareAssistantServiceError("软件助手的软件状态接口无效。", { code: "APPLICATION_STATUS_INVALID" });
  }
  if ((apiConnectionsSnapshot !== null && typeof apiConnectionsSnapshot !== "function")
    || (mainModelSnapshot !== null && typeof mainModelSnapshot !== "function")
    || (saveApiConnection !== null && typeof saveApiConnection !== "function")
    || (saveMainModelConfiguration !== null && typeof saveMainModelConfiguration !== "function")) {
    throw new SoftwareAssistantServiceError("软件助手的模型与 API 配置接口无效。", { code: "MODEL_API_ACTIONS_INVALID" });
  }
  if (usageLedger !== null
    && (typeof usageLedger?.record !== "function" || typeof usageLedger?.reconcile !== "function")) {
    throw new SoftwareAssistantServiceError("软件助手的费用记录接口无效。", { code: "USAGE_LEDGER_INVALID" });
  }

  const dataDirectory = requiredDirectory(dataRoot, "Suzu 软件数据目录");
  const workspaceDirectory = resolveSoftwareAssistantWorkspace(dataDirectory);
  const usageSubject = softwareAssistantUsageSubject(dataDirectory);
  const installedApplicationPath = optionalAbsolutePath(applicationPath);
  const presentation = Object.freeze({ agentPreset: SUZU_SOFTWARE_ASSISTANT_AGENT_PRESET });
  const subscribers = new Set();
  const activeTurns = new Map();
  const pendingTurns = [];
  let pumpTurns = () => undefined;
  let preparation = null;
  let usageHistoryReconciliation = null;
  let usageHistoryFullyReconciled = false;
  let disposed = false;

  const emit = (event) => {
    const payload = Object.freeze({
      sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
      timestamp: new Date().toISOString(),
      ...plainObject(event),
    });
    try { onEvent(payload); } catch { /* The main IPC sender is optional. */ }
    for (const listener of subscribers) {
      try { listener(payload); } catch { /* One observer cannot stop Agent Core. */ }
    }
    return payload;
  };

  const scope = () => ({
    sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
    cwd: workspaceDirectory,
    presentation,
  });

  const prepareWorkspace = async () => {
    if (preparation) return preparation;
    preparation = (async () => {
      await fsOps.mkdir(workspaceDirectory, { recursive: true });
    })().catch((error) => {
      preparation = null;
      throw error;
    });
    return preparation;
  };

  const ensureSession = async () => {
    if (disposed) throw new SoftwareAssistantServiceError("软件助手已经停止。", { code: "SERVICE_STOPPED" });
    await prepareWorkspace();
    return runtime.ensureSession(scope());
  };

  const currentStatus = async () => {
    const settings = plainObject(settingsService.load());
    const theme = settings.theme === "dark" ? "深色" : "浅色";
    let appStatus = {};
    try {
      appStatus = plainObject(await applicationStatus?.());
    } catch {
      appStatus = {};
    }
    const version = clean(appStatus.version);
    const update = updateStatusText(appStatus);
    const lines = [`主题：${theme}`];
    if (version) lines.push(`版本：${version}`);
    if (update) lines.push(`更新：${update}`);
    lines.push(`数据目录：${dataDirectory}`);
    if (installedApplicationPath) lines.push(`程序位置：${installedApplicationPath}`);
    return lines.join("\n");
  };

  const readMainModel = async () => {
    if (typeof mainModelSnapshot !== "function") {
      return { status: "unavailable", content: "当前版本没有连接主模型配置读取功能。", data: null };
    }
    try {
      const model = mainModelPublicSnapshot(await mainModelSnapshot());
      return {
        status: "completed",
        content: [
          `主模型服务：${model.provider || model.providerId || "未配置"}`,
          `模型：${model.model || "未选择"}`,
          `连接状态：${model.hasApiKey ? "密钥已保存" : "未保存密钥"}`,
        ].join("\n"),
        data: { model },
      };
    } catch (error) {
      return { status: "failed", content: `无法读取主模型配置：${errorMessage(error, "未知错误。")}`, data: null };
    }
  };

  const saveMainModel = async (input) => {
    if (typeof saveMainModelConfiguration !== "function") {
      return { status: "unavailable", content: "当前版本没有连接主模型配置保存功能。", data: null };
    }
    const body = plainObject(input);
    const requestedProvider = clean(body.provider).toLowerCase();
    const supportedProviders = new Set([
      "deepseek", "minimax", "bailian-coding", "bailian-payg", "kimi", "kimi-api", "custom",
      ...Object.keys(MAIN_MODEL_PROVIDER_ALIASES),
    ]);
    if (!supportedProviders.has(requestedProvider)) {
      return { status: "invalid-request", content: "主模型厂商标识无效。", data: null };
    }
    for (const field of ["apiKey", "baseUrl", "model", "protocol", "providerLabel", "route"]) {
      if (hasOwn(body, field) && typeof body[field] !== "string") {
        return { status: "invalid-request", content: `${field} 必须是文本。`, data: null };
      }
    }
    const alias = MAIN_MODEL_PROVIDER_ALIASES[requestedProvider] || {};
    let preservesExistingAlias = false;
    if (clean(alias.route) && typeof mainModelSnapshot === "function") {
      try {
        const current = plainObject(await mainModelSnapshot());
        preservesExistingAlias = clean(current.providerRoute) === clean(alias.route);
      } catch {
        preservesExistingAlias = false;
      }
    }
    const value = preservesExistingAlias
      ? { provider: clean(alias.provider), route: clean(alias.route) }
      : { ...alias, provider: clean(alias.provider) || requestedProvider };
    for (const field of ["apiKey", "baseUrl", "model", "protocol", "providerLabel", "route"]) {
      if (hasOwn(body, field) && clean(body[field])) value[field] = clean(body[field]);
    }
    if (requestedProvider === "ollama" && !clean(value.apiKey)) value.apiKey = "ollama";
    if (typeof body.supportsImageInput === "boolean") value.supportsImageInput = body.supportsImageInput;
    try {
      const model = mainModelPublicSnapshot(await saveMainModelConfiguration(value));
      emit({ type: "main-model-changed", providerId: model.providerId, model: model.model });
      return {
        status: "completed",
        content: `已保存主模型“${model.provider || model.providerId} · ${model.model}”。`,
        data: { model },
      };
    } catch (error) {
      return { status: "failed", content: `无法保存主模型：${errorMessage(error, "未知错误。")}`, data: null };
    }
  };

  const readApiConnectionCatalog = async () => {
    if (typeof apiConnectionsSnapshot !== "function") {
      throw new SoftwareAssistantServiceError("当前版本没有连接 API 配置读取功能。", { code: "API_CONNECTIONS_UNAVAILABLE" });
    }
    const snapshot = plainObject(await apiConnectionsSnapshot());
    return {
      snapshot,
      connections: (Array.isArray(snapshot.connections) ? snapshot.connections : [])
        .map(apiConnectionPublicSummary)
        .filter((connection) => connection.id && connection.name),
    };
  };

  const searchApiConnections = async ({ query } = {}) => {
    const requestedQuery = clean(query);
    if (requestedQuery.length > MAX_API_CONNECTION_SEARCH_QUERY_LENGTH) {
      return {
        status: "invalid-request",
        content: `API 连接查询不能超过 ${MAX_API_CONNECTION_SEARCH_QUERY_LENGTH} 个字符。`,
        data: { connections: [] },
      };
    }
    let catalog;
    try {
      catalog = await readApiConnectionCatalog();
    } catch (error) {
      return {
        status: error?.code === "API_CONNECTIONS_UNAVAILABLE" ? "unavailable" : "failed",
        content: `无法读取 API 连接：${errorMessage(error, "未知错误。")}`,
        data: { connections: [] },
      };
    }
    const normalizedQuery = normalizedSearchText(requestedQuery);
    const connections = catalog.connections.filter((connection) => {
      if (!normalizedQuery) return true;
      return [connection.id, connection.name, connection.type, connection.service, connection.baseUrl, connection.model]
        .some((value) => normalizedSearchText(value).includes(normalizedQuery));
    });
    if (!connections.length) {
      return {
        status: "not-found",
        content: requestedQuery ? `没有找到与“${requestedQuery}”匹配的 API 连接。` : "当前还没有保存 API 连接。",
        data: { connections: [] },
      };
    }
    return {
      status: "completed",
      content: [
        "已保存的 API 连接：",
        ...connections.map((connection) => `- ${connection.name}（${connection.id}）：${connection.service || connection.type}${connection.model ? ` · ${connection.model}` : ""}`),
      ].join("\n"),
      data: { connections },
    };
  };

  const saveApiConnectionAction = async (input) => {
    if (typeof saveApiConnection !== "function") {
      return { status: "unavailable", content: "当前版本没有连接 API 配置保存功能。", data: null };
    }
    const body = plainObject(input);
    const provider = apiConnectionProvider(body.provider);
    if (!provider) return { status: "invalid-request", content: "API 厂商或服务类型无效。", data: null };
    for (const field of ["connectionId", "name", "apiKey", "baseUrl", "model"]) {
      if (hasOwn(body, field) && typeof body[field] !== "string") {
        return { status: "invalid-request", content: `${field} 必须是文本。`, data: null };
      }
    }
    let catalog;
    try {
      catalog = await readApiConnectionCatalog();
    } catch (error) {
      return { status: "failed", content: `无法读取 API 连接：${errorMessage(error, "未知错误。")}`, data: null };
    }
    const connectionId = clean(body.connectionId);
    const requestedName = clean(body.name);
    const defaultName = requestedName || provider.label;
    let current = null;
    if (connectionId) {
      current = catalog.connections.find((connection) => connection.id === connectionId) || null;
      if (!current) return { status: "not-found", content: `找不到 API 连接 ID“${connectionId}”。`, data: null };
    } else {
      current = catalog.connections.find((connection) => (
        normalizedSearchText(connection.name) === normalizedSearchText(defaultName)
      )) || null;
      if (!current && !requestedName && provider.baseUrl) {
        const matches = catalog.connections.filter((connection) => (
          connection.type === provider.type
          && normalizedEndpointText(connection.baseUrl) === normalizedEndpointText(provider.baseUrl)
        ));
        if (matches.length > 1) {
          return {
            status: "needs-confirmation",
            content: `有多条 ${provider.label} 连接，请确认要更新的连接 ID。`,
            data: { candidates: matches },
          };
        }
        current = matches[0] || null;
      }
    }

    const name = requestedName || current?.name || provider.label;
    const baseUrl = clean(body.baseUrl) || current?.baseUrl || provider.baseUrl;
    const model = clean(body.model) || current?.model || "";
    let apiKey = clean(body.apiKey);
    if (!current && provider.id === "ollama" && !apiKey) apiKey = "ollama";
    if (!current && !apiKey) {
      return { status: "invalid-request", content: `新建“${name}”还需要 API Key。`, data: null };
    }
    if (!current && ["openai-compatible", "asr-api"].includes(provider.type) && !model) {
      return {
        status: "needs-input",
        content: `新建“${name}”还需要默认模型。请提供模型标识，或说明准备把它用于哪项能力。`,
        data: { provider: provider.id, name, requiredField: "model" },
      };
    }
    if (["openai-compatible", "asr-api"].includes(provider.type) && !baseUrl) {
      return {
        status: "needs-input",
        content: `新建“${name}”还需要服务地址。`,
        data: { provider: provider.id, name, requiredField: "baseUrl" },
      };
    }

    const value = {
      ...(current?.id ? { id: current.id } : {}),
      name,
      type: provider.type,
      ...(apiKey ? { apiKey } : {}),
      ...(provider.type !== "tts-api" ? { baseUrl } : {}),
      ...(model ? { model } : {}),
    };
    try {
      const savedSnapshot = plainObject(await saveApiConnection(value));
      const savedConnections = (Array.isArray(savedSnapshot.connections) ? savedSnapshot.connections : [])
        .map(apiConnectionPublicSummary);
      const saved = savedConnections.find((connection) => (
        (current?.id && connection.id === current.id)
        || normalizedSearchText(connection.name) === normalizedSearchText(name)
      )) || null;
      emit({ type: "api-connections-changed", connectionId: saved?.id || current?.id || "" });
      return {
        status: "completed",
        content: `已保存 API 连接“${saved?.name || name}”${saved?.model ? `，默认模型为 ${saved.model}` : ""}。`,
        data: { connection: saved },
      };
    } catch (error) {
      return { status: "failed", content: `无法保存 API 连接：${errorMessage(error, "未知错误。")}`, data: null };
    }
  };

  const searchPages = ({ query } = {}) => {
    const requestedQuery = clean(query);
    if (!requestedQuery) {
      return {
        status: "invalid-request",
        content: "请提供要查找的页面、功能或设置。",
        data: { results: [] },
      };
    }
    if (requestedQuery.length > MAX_PAGE_SEARCH_QUERY_LENGTH) {
      return {
        status: "invalid-request",
        content: `页面查询不能超过 ${MAX_PAGE_SEARCH_QUERY_LENGTH} 个字符。`,
        data: { results: [] },
      };
    }
    const results = searchSuzuSearchItems(requestedQuery, { limit: PAGE_SEARCH_RESULT_LIMIT })
      .map(({ detail, id, title }) => ({ detail, id, title }));
    if (!results.length) {
      return {
        status: "not-found",
        content: `没有找到与“${requestedQuery}”匹配的软件页面。`,
        data: { query: requestedQuery, results },
      };
    }
    return {
      status: "completed",
      content: [
        "相关页面：",
        ...results.map((entry) => `- ${entry.title}（${entry.id}）：${entry.detail}`),
      ].join("\n"),
      data: { query: requestedQuery, results },
    };
  };

  const readContactCatalog = async () => {
    if (typeof contactSnapshot !== "function") {
      throw new SoftwareAssistantServiceError("当前版本没有连接联系人资料读取功能。", { code: "CONTACTS_UNAVAILABLE" });
    }
    const snapshot = plainObject(await contactSnapshot());
    const contacts = (Array.isArray(snapshot.contacts) ? snapshot.contacts : [])
      .map((contact) => plainObject(contact))
      .filter((contact) => contact.hidden !== true && clean(contact.id) && clean(contact.name));
    return { snapshot, contacts };
  };

  const resolveContactTarget = async (input, purpose) => {
    const body = plainObject(input);
    const requestedContactId = clean(body.contactId);
    const requestedContactName = clean(body.contactName);
    if (!requestedContactId && !requestedContactName) {
      return {
        result: {
          status: "invalid-request",
          content: `${purpose}需要提供 contactId 或 contactName。`,
          data: null,
        },
      };
    }
    if (requestedContactId.length > MAX_CONTACT_SEARCH_QUERY_LENGTH
      || requestedContactName.length > MAX_CONTACT_SEARCH_QUERY_LENGTH) {
      return {
        result: {
          status: "invalid-request",
          content: `联系人名称或 ID 不能超过 ${MAX_CONTACT_SEARCH_QUERY_LENGTH} 个字符。`,
          data: null,
        },
      };
    }

    let catalog;
    try {
      catalog = await readContactCatalog();
    } catch (error) {
      return {
        result: {
          status: error?.code === "CONTACTS_UNAVAILABLE" ? "unavailable" : "failed",
          content: `无法读取联系人：${errorMessage(error, "未知错误。")}`,
          data: null,
        },
      };
    }
    const matches = requestedContactId
      ? catalog.contacts.filter((contact) => clean(contact.id) === requestedContactId)
      : catalog.contacts.filter((contact) => normalizedSearchText(contact.name) === normalizedSearchText(requestedContactName));
    if (!matches.length) {
      return {
        result: {
          status: "not-found",
          content: requestedContactId
            ? `找不到联系人 ID“${requestedContactId}”。`
            : `找不到联系人“${requestedContactName}”。`,
          data: null,
        },
      };
    }
    if (matches.length > 1) {
      const matchedName = clean(matches[0].name) || requestedContactName;
      return {
        result: {
          status: "needs-confirmation",
          content: `有多位联系人名为“${matchedName}”；请确认联系人 ID 后再${purpose}。`,
          data: {
            candidates: matches.map((contact) => ({
              contactId: clean(contact.id),
              name: clean(contact.name),
            })),
          },
        },
      };
    }
    return { ...catalog, contact: matches[0] };
  };

  const searchContacts = async ({ query } = {}) => {
    const requestedQuery = clean(query);
    if (requestedQuery.length > MAX_CONTACT_SEARCH_QUERY_LENGTH) {
      return {
        status: "invalid-request",
        content: `联系人查询不能超过 ${MAX_CONTACT_SEARCH_QUERY_LENGTH} 个字符。`,
        data: { contacts: [] },
      };
    }
    let catalog;
    try {
      catalog = await readContactCatalog();
    } catch (error) {
      return {
        status: error?.code === "CONTACTS_UNAVAILABLE" ? "unavailable" : "failed",
        content: `无法读取联系人：${errorMessage(error, "未知错误。")}`,
        data: { contacts: [] },
      };
    }
    const normalizedQuery = normalizedSearchText(requestedQuery);
    const ranked = catalog.contacts
      .map((contact) => {
        const id = normalizedSearchText(contact.id);
        const name = normalizedSearchText(contact.name);
        let rank = 0;
        if (normalizedQuery) {
          if (id === normalizedQuery) rank = 5;
          else if (name === normalizedQuery) rank = 4;
          else if (name.startsWith(normalizedQuery)) rank = 3;
          else if (name.includes(normalizedQuery)) rank = 2;
          else if (id.includes(normalizedQuery)) rank = 1;
          else return null;
        }
        return { contact, rank };
      })
      .filter(Boolean)
      .sort((left, right) => right.rank - left.rank
        || clean(left.contact.name).localeCompare(clean(right.contact.name), "zh-CN")
        || clean(left.contact.id).localeCompare(clean(right.contact.id)))
      .slice(0, CONTACT_SEARCH_RESULT_LIMIT)
      .map(({ contact }) => contactSummary(contact, catalog.snapshot));
    if (!ranked.length) {
      return {
        status: "not-found",
        content: requestedQuery ? `没有找到与“${requestedQuery}”匹配的可见联系人。` : "当前没有可见联系人。",
        data: {
          query: requestedQuery,
          contacts: [],
          hiddenContactCount: Number(catalog.snapshot.hiddenContactCount) || 0,
        },
      };
    }
    return {
      status: "completed",
      content: [
        requestedQuery ? `与“${requestedQuery}”匹配的联系人：` : "当前可见联系人：",
        ...ranked.map((contact) => `- ${contact.name}（${contact.contactId}）`),
      ].join("\n"),
      data: {
        query: requestedQuery,
        contacts: ranked,
        hiddenContactCount: Number(catalog.snapshot.hiddenContactCount) || 0,
      },
    };
  };

  const readContact = async (input) => {
    const body = plainObject(input);
    const section = clean(body.section) || "all";
    if (section !== "all" && !Object.hasOwn(CONTACT_RELATIONSHIP_SECTIONS, section)) {
      return {
        status: "invalid-request",
        content: "联系人资料 section 只能是 all、relationship、persona 或 user。",
        data: null,
      };
    }
    const resolved = await resolveContactTarget(body, "读取联系人资料");
    if (resolved.result) return resolved.result;
    if (typeof readRelationshipFiles !== "function") {
      return {
        status: "unavailable",
        content: "当前版本没有连接联系人相处资料读取功能。",
        data: { contact: contactSummary(resolved.contact, resolved.snapshot), files: [] },
      };
    }

    let relationshipSnapshot;
    try {
      relationshipSnapshot = plainObject(await readRelationshipFiles({ contactId: clean(resolved.contact.id) }));
    } catch (error) {
      return {
        status: "failed",
        content: `无法读取联系人“${clean(resolved.contact.name)}”的相处资料：${errorMessage(error, "未知错误。")}`,
        data: { contact: contactSummary(resolved.contact, resolved.snapshot), files: [] },
      };
    }
    const filesByPath = new Map((Array.isArray(relationshipSnapshot.files) ? relationshipSnapshot.files : [])
      .map((file) => [clean(file?.path).toLocaleLowerCase(), file]));
    const requestedSections = section === "all" ? Object.keys(CONTACT_RELATIONSHIP_SECTIONS) : [section];
    const files = requestedSections.map((requestedSection) => ({
      section: requestedSection,
      ...boundedContactFile(filesByPath.get(CONTACT_RELATIONSHIP_SECTIONS[requestedSection].toLocaleLowerCase()) || {
        path: CONTACT_RELATIONSHIP_SECTIONS[requestedSection],
        exists: false,
        content: "",
      }),
    }));
    return {
      status: "completed",
      content: `已读取联系人“${clean(resolved.contact.name)}”的${section === "all" ? "标准资料" : CONTACT_RELATIONSHIP_SECTIONS[section]}。`,
      data: {
        contact: contactSummary(resolved.contact, resolved.snapshot),
        section,
        files,
      },
    };
  };

  const updateContact = async (input) => {
    const body = plainObject(input);
    const textFields = ["relationshipContent", "personaContent", "userContent"];
    for (const field of textFields) {
      if (hasOwn(body, field) && typeof body[field] !== "string") {
        return { status: "invalid-request", content: `${field} 必须是文本。`, data: null };
      }
    }
    for (const field of ["pinned", "muted", "longTermMemoryEnabled"]) {
      if (hasOwn(body, field) && typeof body[field] !== "boolean") {
        return { status: "invalid-request", content: `${field} 必须是布尔值。`, data: null };
      }
    }
    if (hasOwn(body, "newName") && !clean(body.newName)) {
      return { status: "invalid-request", content: "新的联系人名称不能为空。", data: null };
    }
    if (hasOwn(body, "permissionMode") && !SUZU_AGENT_PERMISSION_MODES.includes(clean(body.permissionMode))) {
      return { status: "invalid-request", content: "联系人审批模式无效。", data: null };
    }
    if (hasOwn(body, "reasoningEffort") && !SUZU_AGENT_REASONING_EFFORTS.includes(clean(body.reasoningEffort))) {
      return { status: "invalid-request", content: "联系人思考强度无效。", data: null };
    }
    const updateFields = [
      "newName",
      ...textFields,
      "pinned",
      "muted",
      "longTermMemoryEnabled",
      "permissionMode",
      "reasoningEffort",
    ].filter((field) => hasOwn(body, field));
    if (!updateFields.length) {
      return { status: "invalid-request", content: "请提供至少一项要更新的联系人资料。", data: null };
    }
    const resolved = await resolveContactTarget(body, "更新联系人资料");
    if (resolved.result) return resolved.result;
    const contactId = clean(resolved.contact.id);
    const originalName = clean(resolved.contact.name);
    const updatedFields = [];
    const errors = [];
    const runUpdate = async (field, handler, unavailableMessage) => {
      if (typeof handler !== "function") {
        errors.push({ field, message: unavailableMessage });
        return;
      }
      try {
        await handler();
        updatedFields.push(field);
      } catch (error) {
        errors.push({ field, message: errorMessage(error, "未知错误。") });
      }
    };

    if (hasOwn(body, "newName")) {
      await runUpdate("name", typeof renameContact === "function" ? () => renameContact({ id: contactId, name: clean(body.newName) }) : null, "当前版本没有连接联系人备注更新功能。");
    }
    const relationshipUpdates = [
      ["relationshipContent", "relationship", "SUZU.md"],
      ["personaContent", "persona", "persona.md"],
      ["userContent", "user", "user.md"],
    ];
    for (const [inputField, resultField, fileName] of relationshipUpdates) {
      if (!hasOwn(body, inputField)) continue;
      await runUpdate(resultField, typeof saveRelationshipFile === "function"
        ? () => saveRelationshipFile({ contactId, path: fileName, content: body[inputField] })
        : null, "当前版本没有连接联系人相处资料更新功能。");
    }
    const presentation = {};
    for (const field of ["pinned", "muted"]) {
      if (hasOwn(body, field)) presentation[field] = body[field];
    }
    if (Object.keys(presentation).length) {
      await runUpdate("presentation", typeof updateContactPresentation === "function"
        ? () => updateContactPresentation({ id: contactId, ...presentation })
        : null, "当前版本没有连接联系人显示设置功能。");
    }
    if (hasOwn(body, "longTermMemoryEnabled")) {
      await runUpdate("longTermMemoryEnabled", typeof updateContactLongTermMemoryEnabled === "function"
        ? () => updateContactLongTermMemoryEnabled({ id: contactId, enabled: body.longTermMemoryEnabled })
        : null, "当前版本没有连接联系人长期记忆设置功能。");
    }
    if (hasOwn(body, "permissionMode")) {
      await runUpdate("permissionMode", typeof updateContactPermissionMode === "function"
        ? () => updateContactPermissionMode({ id: contactId, permissionMode: clean(body.permissionMode) })
        : null, "当前版本没有连接联系人审批模式设置功能。");
    }
    if (hasOwn(body, "reasoningEffort")) {
      await runUpdate("reasoningEffort", typeof updateContactReasoningEffort === "function"
        ? () => updateContactReasoningEffort({ id: contactId, reasoningEffort: clean(body.reasoningEffort) })
        : null, "当前版本没有连接联系人思考强度设置功能。");
    }

    let latestContact = resolved.contact;
    let latestSnapshot = resolved.snapshot;
    if (updatedFields.length) {
      try {
        const refreshed = await readContactCatalog();
        latestSnapshot = refreshed.snapshot;
        latestContact = refreshed.contacts.find((contact) => clean(contact.id) === contactId) || latestContact;
      } catch { /* The confirmed writes remain valid if a refresh fails. */ }
      emit({ type: "contact-updated", contactId, contactName: clean(latestContact.name) || clean(body.newName) || originalName, updatedFields });
    }
    const latestName = clean(latestContact.name) || clean(body.newName) || originalName;
    const status = errors.length ? (updatedFields.length ? "partial" : "failed") : "completed";
    return {
      status,
      content: status === "completed"
        ? `已更新联系人“${latestName}”的资料。`
        : status === "partial"
          ? `已更新联系人“${latestName}”的部分资料；${errors.map((entry) => `${entry.field}：${entry.message}`).join("；")}`
          : `联系人“${originalName}”的资料未能更新：${errors.map((entry) => `${entry.field}：${entry.message}`).join("；")}`,
      data: {
        contact: contactSummary(latestContact, latestSnapshot),
        updatedFields,
        errors,
      },
    };
  };

  const respond = async (requestId, result) => {
    try {
      return await runtime.respondLifecycleRequest({ requestId, result });
    } catch {
      return false;
    }
  };

  const performAction = async ({ action, input }) => {
    const body = plainObject(input);
    if (action === "navigate") {
      const destinationId = clean(body.destinationId);
      const entry = getSuzuSearchItem(destinationId);
      if (!entry) return {
        status: "invalid-request",
        content: "页面入口 ID 不存在。",
        data: null,
      };
      emit({ type: "navigate", destinationId: entry.id });
      return {
        status: "completed",
        content: `已打开“${entry.title}”。`,
        data: { destinationId: entry.id },
      };
    }
    if (action === "set-theme") {
      const theme = clean(body.theme).toLowerCase();
      if (!new Set(["light", "dark"]).has(theme)) {
        return {
          status: "invalid-request",
          content: "主题只能是 light 或 dark。",
          data: null,
        };
      }
      await settingsService.update({ theme });
      emit({ type: "theme-changed", theme });
      return {
        status: "completed",
        content: theme === "dark" ? "已切换为深色主题。" : "已切换为浅色主题。",
        data: { theme },
      };
    }
    if (action === "lookup-character-profile") {
      const candidateId = clean(body.candidateId);
      const query = clean(body.query);
      if (!query && !candidateId) {
        return {
          status: "invalid-request",
          content: "查找角色资料需要提供角色名 query 或已确认的 candidateId。",
          data: null,
        };
      }
      if (query.length > MAX_CHARACTER_AVATAR_QUERY_LENGTH) {
        return {
          status: "invalid-request",
          content: `角色名不能超过 ${MAX_CHARACTER_AVATAR_QUERY_LENGTH} 个字符。`,
          data: null,
        };
      }
      let resolved;
      try {
        resolved = await resolveCharacterProfile({ candidateId, fetchImpl, query });
      } catch (error) {
        return {
          status: "unavailable",
          content: `角色资料服务暂时不可用：${errorMessage(error, "网络请求失败。")}`,
          data: null,
        };
      }
      if (resolved.status === "invalid-candidate" || resolved.status === "invalid-query") {
        return {
          status: "invalid-request",
          content: resolved.status === "invalid-candidate"
            ? "candidateId 无效；请使用查询结果中返回的候选 ID。"
            : "角色名不能为空。",
          data: null,
        };
      }
      if (resolved.status === "needs-confirmation") {
        return {
          status: "needs-confirmation",
          content: `找到了多个可能的“${query}”；请根据角色名称和关联作品确认候选。`,
          data: { query, candidates: resolved.candidates },
        };
      }
      if (resolved.status === "unavailable") {
        return {
          status: "unavailable",
          content: "Bangumi 当前没有返回可用的角色资料。",
          data: null,
        };
      }
      if (resolved.status !== "matched") {
        return {
          status: "not-found",
          content: `没有找到“${query || candidateId}”的可用角色资料。`,
          data: null,
        };
      }
      const { status: _resolvedStatus, ...profileData } = resolved;
      return {
        status: "completed",
        content: `已整理“${clean(resolved.displayName) || clean(resolved.character?.title) || query}”的公开角色资料。`,
        data: profileData,
      };
    }
    if (action === "lookup-contact-avatar") {
      const candidateId = clean(body.candidateId);
      const requestedTitle = clean(body.title);
      const query = clean(body.query) || requestedTitle;
      if (!query && !candidateId) {
        return {
          status: "invalid-request",
          content: "查找角色头像需要提供角色名 query 或已确认的 candidateId。",
          data: null,
        };
      }
      if (query.length > MAX_CHARACTER_AVATAR_QUERY_LENGTH || requestedTitle.length > MAX_CHARACTER_AVATAR_QUERY_LENGTH) {
        return {
          status: "invalid-request",
          content: `角色名不能超过 ${MAX_CHARACTER_AVATAR_QUERY_LENGTH} 个字符。`,
          data: null,
        };
      }
      if (typeof fsOps?.writeFile !== "function") {
        return {
          status: "unavailable",
          content: "当前版本没有连接头像预览保存功能。",
          data: null,
        };
      }

      let lookupData = null;
      let providerStatus = "not-found";
      let providerError = "";
      try {
        const resolved = await resolveCharacterAvatar({ candidateId, fetchImpl, query });
        providerStatus = clean(resolved.status);
        if (resolved.status === "invalid-candidate") {
          return {
            status: "invalid-request",
            content: "candidateId 无效；请使用查询结果中返回的候选 ID。",
            data: null,
          };
        }
        if (resolved.status === "needs-confirmation") {
          return {
            status: "needs-confirmation",
            content: `找到了多个可能的“${query}”；请根据角色和关联作品确认候选。`,
            data: {
              query,
              candidates: resolved.candidates,
            },
          };
        }
        if (resolved.status === "matched") {
          let selectedPortrait = null;
          let downloaded = null;
          for (const portrait of [resolved.portrait, resolved.fallbackPortrait].filter(Boolean)) {
            try {
              downloaded = await downloadRemoteAvatarPreview({
                fetchImpl,
                fsOps,
                imageUrl: portrait.imageUrl,
                sourceSlug: clean(portrait.source).toLocaleLowerCase(),
                targetDirectory: path.join(workspaceDirectory, "avatar-previews"),
              });
              selectedPortrait = portrait;
              break;
            } catch (error) {
              providerError = errorMessage(error, "头像图片下载失败。");
            }
          }
          if (downloaded && selectedPortrait) {
            const characterProfile = plainObject(resolved.character.profile);
            lookupData = {
              source: selectedPortrait.source,
              resolverSource: resolved.character.source,
              title: resolved.character.title,
              portraitTitle: selectedPortrait.title,
              sourceUrl: selectedPortrait.sourceUrl,
              characterSourceUrl: resolved.character.sourceUrl,
              candidateId: resolved.character.candidateId,
              relatedWorks: resolved.character.relatedWorks,
              avatarPath: downloaded.avatarPath,
              mimeType: downloaded.mimeType,
              ...(clean(characterProfile.source) === "Bangumi" ? {
                profile: {
                  source: "Bangumi",
                  sourceUrl: clean(characterProfile.sourceUrl) || clean(resolved.character.sourceUrl),
                  summary: clean(characterProfile.summary),
                  aliases: Array.isArray(resolved.character.aliases) ? resolved.character.aliases : [],
                  relatedWorks: Array.isArray(resolved.character.relatedWorks) ? resolved.character.relatedWorks : [],
                  attributes: Array.isArray(characterProfile.attributes) ? characterProfile.attributes : [],
                },
              } : {}),
            };
          } else if (providerError) {
            providerStatus = "unavailable";
          }
        }
      } catch (error) {
        providerStatus = "unavailable";
        providerError = errorMessage(error, "角色头像服务暂时不可用。");
      }

      // The existing public wiki lookup remains a final compatibility source
      // when neither structured character provider produced a usable image.
      if (!lookupData && query) {
        let candidates = [];
        try {
          const apiUrl = requestedTitle
            ? moegirlpediaApiUrl({
              action: "query",
              format: "json",
              formatversion: 2,
              titles: requestedTitle,
              prop: "pageimages|info",
              pithumbsize: 512,
              inprop: "url",
            })
            : moegirlpediaApiUrl({
              action: "query",
              format: "json",
              formatversion: 2,
              generator: "search",
              gsrsearch: query,
              gsrlimit: MOEGIRLPEDIA_SEARCH_RESULT_LIMIT,
              gsrnamespace: 0,
              prop: "pageimages|info",
              pithumbsize: 512,
              inprop: "url",
            });
          candidates = moegirlpediaCandidates(await fetchMoegirlpediaJson(fetchImpl, apiUrl));
        } catch (error) {
          providerStatus = "unavailable";
          providerError ||= errorMessage(error, "网络请求失败。");
        }

        let selected = requestedTitle ? candidates[0] : candidates.find((candidate) => (
          normalizedSearchText(candidate.title) === normalizedSearchText(query)
        ));
        if (!selected && candidates.length === 1) selected = candidates[0];
        if (!selected && candidates.length > 1) {
          return {
            status: "needs-confirmation",
            content: `找到了多个可能的“${query}”；请确认要使用的角色条目。`,
            data: {
              query,
              candidates: candidates.slice(0, MOEGIRLPEDIA_VISIBLE_CANDIDATE_LIMIT).map((candidate) => ({
                title: candidate.title,
                source: "萌娘百科",
                sourceUrl: candidate.sourceUrl,
              })),
            },
          };
        }
        if (selected) {
          try {
            const downloaded = await downloadMoegirlpediaThumbnail({
              fetchImpl,
              fsOps,
              targetDirectory: path.join(workspaceDirectory, "avatar-previews"),
              thumbnailUrl: selected.thumbnailUrl,
            });
            lookupData = {
              source: "萌娘百科",
              resolverSource: "萌娘百科",
              title: selected.title,
              portraitTitle: selected.title,
              sourceUrl: selected.sourceUrl,
              characterSourceUrl: selected.sourceUrl,
              candidateId: "",
              relatedWorks: [],
              avatarPath: downloaded.avatarPath,
              mimeType: downloaded.mimeType,
            };
          } catch (error) {
            providerStatus = "unavailable";
            providerError ||= errorMessage(error, "头像预览下载失败。");
          }
        }
      }

      if (!lookupData) {
        const unavailable = providerStatus === "unavailable";
        return {
          status: unavailable ? "unavailable" : "not-found",
          content: unavailable
            ? `角色头像服务暂时不可用：${providerError || "网络请求失败。"}`
            : `没有找到“${query || candidateId}”的可用角色头像。`,
          data: null,
        };
      }

      if (!clean(body.contactId) && !clean(body.contactName)) {
        return {
          status: "completed",
          content: `已找到“${lookupData.title}”的头像预览。`,
          data: lookupData,
        };
      }

      const applied = await performAction({
        action: "set-contact-avatar",
        input: {
          avatarPath: lookupData.avatarPath,
          ...(clean(body.contactId) ? { contactId: clean(body.contactId) } : {}),
          ...(clean(body.contactName) ? { contactName: clean(body.contactName) } : {}),
        },
      });
      if (applied.status !== "completed") {
        return {
          ...applied,
          data: {
            lookup: lookupData,
            apply: applied.data,
          },
        };
      }
      return {
        status: "completed",
        content: `已为联系人“${applied.data.name}”找到并设置“${lookupData.title}”头像。`,
        data: {
          ...lookupData,
          sourceMimeType: lookupData.mimeType,
          ...applied.data,
          applied: true,
        },
      };
    }
    if (action === "set-contact-avatar") {
      const avatarPath = clean(body.avatarPath);
      if (!avatarPath || !path.isAbsolute(avatarPath)) {
        return {
          status: "invalid-request",
          content: "设置联系人头像需要提供已下载图片的绝对路径 avatarPath。",
          data: null,
        };
      }
      const resolved = await resolveContactTarget(body, "设置头像");
      if (resolved.result) return resolved.result;
      const contact = resolved.contact;
      const contactId = clean(contact.id);
      const contactName = clean(contact.name) || clean(body.contactName);
      const agentId = clean(contact.agentId);
      if (!contactId || !agentId) {
        return {
          status: "failed",
          content: "联系人缺少固定存储身份，当前无法保存头像。",
          data: null,
        };
      }
      if (typeof fsOps?.stat !== "function" || typeof fsOps?.readFile !== "function") {
        return {
          status: "unavailable",
          content: "当前版本没有连接头像文件读取功能。",
          data: null,
        };
      }

      let avatarBytes;
      try {
        const resolvedAvatarPath = path.resolve(avatarPath);
        const stat = await fsOps.stat(resolvedAvatarPath);
        if (!stat.isFile()) {
          return {
            status: "invalid-request",
            content: "avatarPath 必须指向一个图片文件。",
            data: null,
          };
        }
        if (stat.size > MAX_AVATAR_FILE_BYTES) {
          return {
            status: "invalid-request",
            content: "头像图片过大；请换用不超过 2 MB 的 PNG、JPEG 或 WebP 图片。",
            data: null,
          };
        }
        avatarBytes = await fsOps.readFile(resolvedAvatarPath);
      } catch (error) {
        return {
          status: "failed",
          content: `无法读取头像图片：${errorMessage(error, "未知错误。")}`,
          data: null,
        };
      }
      if (!(Buffer.isBuffer(avatarBytes) || avatarBytes instanceof Uint8Array)
        || avatarBytes.length > MAX_AVATAR_FILE_BYTES) {
        return {
          status: "invalid-request",
          content: "头像图片过大；请换用不超过 2 MB 的 PNG、JPEG 或 WebP 图片。",
          data: null,
        };
      }
      const mimeType = avatarMimeType(avatarBytes);
      if (!mimeType) {
        return {
          status: "invalid-request",
          content: "头像图片格式无法识别；请选择 PNG、JPEG 或 WebP 图片。",
          data: null,
        };
      }
      const cropDecision = await inferContactAvatarCrop({
        data: avatarBytes,
        fileName: path.basename(avatarPath),
        mimeType,
        runtime,
      });
      const cropBox = cropDecision.available && cropDecision.confidence >= 0.35
        ? cropDecision.box
        : null;
      let normalizedAvatar;
      try {
        const normalized = await normalizeSquareAvatarImage(avatarBytes, { cropBox });
        normalizedAvatar = {
          avatarDataUrl: `data:${normalized.mimeType};base64,${Buffer.from(normalized.bytes).toString("base64")}`,
          cropStrategy: normalized.strategy,
          mimeType: normalized.mimeType,
        };
      } catch (error) {
        return {
          status: "invalid-request",
          content: errorMessage(error, "头像图片无法处理。"),
          data: null,
        };
      }
      const avatarDataUrl = normalizedAvatar.avatarDataUrl;
      if (avatarDataUrl.length > MAX_AVATAR_DATA_URL_LENGTH) {
        return {
          status: "invalid-request",
          content: "头像图片过大；请换用不超过 2 MB 的 PNG、JPEG 或 WebP 图片。",
          data: null,
        };
      }

      try {
        const identity = identityWithAgentAvatar(settingsService.load(), agentId, avatarDataUrl);
        const updatedSettings = await settingsService.update({ identity });
        const persistedSettings = plainObject(updatedSettings);
        const persistedIdentity = plainObject(persistedSettings.identity);
        const persistedAgents = plainObject(persistedIdentity.agents);
        if (String(plainObject(persistedAgents[agentId]).avatarDataUrl || "") !== avatarDataUrl) {
          return {
            status: "failed",
            content: "联系人头像未能写入设置。",
            data: null,
          };
        }
      } catch (error) {
        return {
          status: "failed",
          content: `无法保存联系人头像：${errorMessage(error, "未知错误。")}`,
          data: null,
        };
      }
      emit({ type: "contact-avatar-changed", contactId, contactName, agentId });
      return {
        status: "completed",
        content: `已为联系人“${contactName}”设置头像。`,
        data: {
          contactId,
          name: contactName,
          agentId,
          mimeType: normalizedAvatar.mimeType,
          cropStrategy: normalizedAvatar.cropStrategy,
        },
      };
    }
    if (action === "create-contact") {
      const name = clean(body.name);
      const contactTextFields = ["personaContent", "relationshipContent", "userContent"];
      for (const field of contactTextFields) {
        if (hasOwn(body, field) && typeof body[field] !== "string") {
          return { status: "invalid-request", content: `${field} 必须是文本。`, data: null };
        }
      }
      const personaContent = typeof body.personaContent === "string" ? body.personaContent : "";
      const relationshipContent = typeof body.relationshipContent === "string" ? body.relationshipContent : "";
      const userContent = typeof body.userContent === "string" ? body.userContent : "";
      const requestedFiles = [
        ...(clean(personaContent) ? [{ section: "persona", path: "persona.md", content: personaContent }] : []),
        ...(clean(userContent) ? [{ section: "user", path: "user.md", content: userContent }] : []),
        ...(clean(relationshipContent) ? [{ section: "relationship", path: "SUZU.md", content: relationshipContent }] : []),
      ];
      if (!name) {
        return {
          status: "invalid-request",
          content: "新建联系人需要提供联系人名称。",
          data: null,
        };
      }
      if (typeof createContact !== "function") {
        return {
          status: "unavailable",
          content: "当前版本没有连接联系人创建功能。",
          data: null,
        };
      }
      if (requestedFiles.length && typeof saveRelationshipFile !== "function") {
        return {
          status: "unavailable",
          content: "当前版本没有连接联系人相处设定功能。",
          data: null,
        };
      }

      let created;
      try {
        created = await createContact({ name });
      } catch (error) {
        return {
          status: "failed",
          content: `无法新建联系人：${errorMessage(error, "未知错误。")}`,
          data: null,
        };
      }
      const createdContact = plainObject(created?.createdContact);
      const contactId = clean(createdContact.id);
      const contact = plainObject((Array.isArray(created?.contacts) ? created.contacts : [])
        .find((item) => clean(plainObject(item).id) === contactId));
      const contactName = clean(contact.name) || name;
      if (!contactId) {
        return {
          status: "failed",
          content: "联系人已创建，但当前无法确认新联系人的状态。",
          data: { name: contactName },
        };
      }

      const announceContact = () => {
        emit({ type: "contact-created", contactId, contactName });
        emit({ type: "navigate", destinationId: "conversation" });
      };
      const savedSections = [];
      const errors = [];
      for (const file of requestedFiles) {
        try {
          await saveRelationshipFile({ contactId, path: file.path, content: file.content });
          savedSections.push(file.section);
        } catch (error) {
          errors.push({ section: file.section, message: errorMessage(error, "未知错误。") });
        }
      }
      announceContact();
      const sectionLabels = { persona: "角色设定", relationship: "相处情境", user: "用户资料" };
      const savedDescription = savedSections.map((section) => sectionLabels[section]).join("、");
      return {
        status: errors.length ? "partial" : "completed",
        content: errors.length
          ? `已新建联系人“${contactName}”，部分资料保存失败：${errors.map((entry) => `${sectionLabels[entry.section]}：${entry.message}`).join("；")}`
          : savedDescription
            ? `已新建联系人“${contactName}”，并写入${savedDescription}。`
            : `已新建联系人“${contactName}”。`,
        data: {
          contactId,
          name: contactName,
          personaSaved: savedSections.includes("persona"),
          relationshipSaved: savedSections.includes("relationship"),
          userSaved: savedSections.includes("user"),
          savedSections,
          errors,
          destinationId: "conversation",
        },
      };
    }
    return {
      status: "invalid-request",
      content: "软件动作尚未登记。",
      data: null,
    };
  };

  const handleLifecycleRequest = async (event) => {
    const source = plainObject(event);
    const data = plainObject(source.data);
    if (clean(data.sessionId) !== SUZU_SOFTWARE_ASSISTANT_SESSION_ID) return;
    const requestId = clean(source.requestId);
    if (!requestId) return;
    const lifecycleEvent = clean(source.lifecycleEvent);
    if (lifecycleEvent === "ContextCollect") {
      await respond(requestId, { blocks: [] });
      return;
    }
    if (lifecycleEvent === "DynamicContextCollect") {
      await respond(requestId, { blocks: [] });
      return;
    }
    if (lifecycleEvent === "CompactionSettings") {
      await respond(requestId, {
        available: true,
        prompt: DEFAULT_SUZU_SOFTWARE_ASSISTANT_COMPACTION_PROMPT,
        automatic: {
          enabled: true,
          tokenThreshold: DEFAULT_SUZU_COMPACTION_TOKEN_THRESHOLD,
          retainTokens: DEFAULT_SUZU_COMPACTION_RETAIN_TOKENS,
        },
        manual: { retainTokens: DEFAULT_SUZU_COMPACTION_RETAIN_TOKENS },
      });
      return;
    }
    if (lifecycleEvent === "PreToolUse") {
      await respond(requestId, { decision: { kind: "allow" } });
      return;
    }
    if (lifecycleEvent === "SoftwareAssistantStatus") {
      await respond(requestId, { content: await currentStatus() });
      return;
    }
    if (lifecycleEvent === "SoftwareAssistantPageSearch") {
      await respond(requestId, searchPages({ query: data.query }));
      return;
    }
    if (lifecycleEvent === "SoftwareAssistantMainModelStatus") {
      await respond(requestId, await readMainModel());
      return;
    }
    if (lifecycleEvent === "SoftwareAssistantMainModelSave") {
      await respond(requestId, await saveMainModel(data.input));
      return;
    }
    if (lifecycleEvent === "SoftwareAssistantApiConnectionSearch") {
      await respond(requestId, await searchApiConnections({ query: data.query }));
      return;
    }
    if (lifecycleEvent === "SoftwareAssistantApiConnectionSave") {
      await respond(requestId, await saveApiConnectionAction(data.input));
      return;
    }
    if (lifecycleEvent === "SoftwareAssistantContactSearch") {
      await respond(requestId, await searchContacts({ query: data.query }));
      return;
    }
    if (lifecycleEvent === "SoftwareAssistantContactRead") {
      await respond(requestId, await readContact(data.input));
      return;
    }
    if (lifecycleEvent === "SoftwareAssistantContactUpdate") {
      await respond(requestId, await updateContact(data.input));
      return;
    }
    if (lifecycleEvent === "SoftwareAssistantAction") {
      let result;
      try {
        result = await performAction({ action: clean(data.action), input: data.input });
      } catch (error) {
        result = {
          status: "failed",
          content: `软件动作执行失败：${errorMessage(error, "未知错误。")}`,
          data: null,
        };
      }
      await respond(requestId, result);
    }
  };

  const finishTurn = async (turn, event = {}) => {
    if (!turn || turn.finished) return;
    turn.finished = true;
    activeTurns.delete(turn.requestId);
    if (turn.usageTasks?.length) await Promise.allSettled(turn.usageTasks);
    if (event.error) {
      emit({ type: "error", requestId: turn.requestId, message: clean(event.error) || "软件助手没有完成这次回复。" });
      if (!disposed) void pumpTurns();
      return;
    }
    if (event.stopped) {
      emit({ type: "turn-stopped", requestId: turn.requestId, message: "已停止当前回复。" });
      if (!disposed) void pumpTurns();
      return;
    }
    emit({ type: "turn-complete", requestId: turn.requestId });
    if (!disposed) void pumpTurns();
  };

  const requestCancellation = async (turn) => {
    if (!turn || turn.finished || turn.cancelTask || turn.state !== "running") return;
    turn.cancelTask = Promise.resolve(runtime.cancelTurn({
      sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
      turnId: turn.requestId,
    }))
      .catch((error) => {
        if (!turn.finished) finishTurn(turn, {
          error: `无法停止当前回复：${errorMessage(error, "停止失败。")}`,
        });
      })
      .finally(() => { turn.cancelTask = null; });
    await turn.cancelTask;
  };

  const emitReplyStream = (turn) => {
    const content = completedConversationReplyPrefix(turn.text);
    if (!content || content === turn.streamedReplyContent) return;
    turn.streamedReplyContent = content;
    emit({ type: "reply-stream", requestId: turn.requestId, content });
  };

  const handleRuntimeEvent = (event) => {
    const source = plainObject(event);
    if (source.type === "lifecycle-request") {
      void handleLifecycleRequest(source);
      return;
    }
    if (clean(source.sessionId) !== SUZU_SOFTWARE_ASSISTANT_SESSION_ID) return;
    const type = clean(source.type);
    const turn = activeTurns.get(clean(source.turnId));
    if (type === "model-usage") {
      const task = Promise.resolve(usageLedger?.record({
        event: source,
        subject: usageSubject,
        turn: turn || null,
      })).catch(() => undefined);
      if (turn && !turn.finished) turn.usageTasks.push(task);
      return;
    }
    if (!turn || turn.finished) return;
    if (type === "turn-started") {
      turn.state = "running";
      emit({ type: "turn-started", requestId: turn.requestId });
      if (turn.cancelRequested) void requestCancellation(turn);
      return;
    }
    if (type === "tool-started") {
      turn.toolNames.add(clean(source.toolName) || "Suzu 工具");
      return;
    }
    if (type === "assistant-reasoning-delta") {
      emit({ type: "thinking", requestId: turn.requestId });
      return;
    }
    if (type === "assistant-delta") {
      turn.text = bounded(`${turn.text}${String(source.text || "")}`);
      emitReplyStream(turn);
      return;
    }
    if (type === "assistant-completed") {
      turn.text = mergeFullText(turn.text, source.text);
      if (turn.text) {
        emit({
          type: "reply",
          requestId: turn.requestId,
          content: turn.text,
          done: true,
          assistantMessageCount: completedAssistantMessageCount(source),
        });
      }
      void finishTurn(turn);
      return;
    }
    if (type === "turn-cancelled") {
      void finishTurn(turn, { stopped: true });
      return;
    }
    if (["turn-failed", "runtime-unavailable"].includes(type)) {
      void finishTurn(turn, { error: clean(source.error) });
    }
  };

  const submitTurn = async (turn) => {
    activeTurns.set(turn.requestId, turn);
    try {
      const result = await runtime.sendTurn({
        sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
        turnId: turn.requestId,
        input: turn.input,
        placement: "queue",
      });
      if (result?.accepted !== true) {
        throw new SoftwareAssistantServiceError("Agent Core 没有接受这条软件助手消息。", { code: "TURN_NOT_ACCEPTED" });
      }
      if (!turn.finished && turn.state === "submitting") turn.state = "submitted";
      if (turn.cancelRequested) void requestCancellation(turn);
      return result;
    } catch (error) {
      if (!turn.finished) {
        await finishTurn(turn, { error: `无法发送给软件助手：${errorMessage(error, "未知错误。")}` });
      }
      throw error;
    }
  };

  pumpTurns = async () => {
    if (disposed || activeTurns.size) return;
    const next = pendingTurns.shift();
    if (!next) return;
    try {
      await submitTurn(next);
    } catch {
      // submitTurn has already emitted the visible error and will advance the queue.
    }
  };

  const unsubscribeRuntime = runtime.subscribe(handleRuntimeEvent);

  const reconcileUsagePage = async (events) => {
    const result = await usageLedger?.reconcile({
      events: Array.isArray(events) ? events : [],
      subject: usageSubject,
    });
    return result?.completed !== false;
  };

  const reconcileUsageHistory = async (latestHistory) => {
    if (!usageLedger) return;
    const latestEvents = Array.isArray(latestHistory?.events) ? latestHistory.events : [];
    if (!await reconcileUsagePage(latestEvents)) return;
    if (usageHistoryFullyReconciled) return;
    if (latestHistory?.hasMore !== true) {
      usageHistoryFullyReconciled = true;
      return;
    }
    if (!usageHistoryReconciliation) {
      usageHistoryReconciliation = (async () => {
        let beforeSeq = oldestHistorySequence(latestEvents);
        const visitedCursors = new Set();
        while (Number.isSafeInteger(beforeSeq) && !visitedCursors.has(beforeSeq)) {
          visitedCursors.add(beforeSeq);
          const history = await runtime.history({
            ...scope(),
            beforeSeq,
            maxMessages: MAX_USAGE_HISTORY_MESSAGES,
          });
          const events = Array.isArray(history?.events) ? history.events : [];
          if (!await reconcileUsagePage(events)) return false;
          if (history?.hasMore !== true) {
            usageHistoryFullyReconciled = true;
            return true;
          }
          const nextBeforeSeq = oldestHistorySequence(events);
          if (!Number.isSafeInteger(nextBeforeSeq) || nextBeforeSeq >= beforeSeq) return false;
          beforeSeq = nextBeforeSeq;
        }
        return false;
      })().finally(() => {
        usageHistoryReconciliation = null;
      });
    }
    await usageHistoryReconciliation;
  };

  const snapshot = async () => {
    try {
      await ensureSession();
      const history = await runtime.history({ ...scope(), maxMessages: MAX_HISTORY_MESSAGES });
      const events = Array.isArray(history?.events) ? history.events : [];
      await reconcileUsageHistory(history).catch(() => undefined);
      return Object.freeze({
        status: "ready",
        sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
        workspaceDirectory,
        messages: visibleMessages(events),
        running: activeTurns.size > 0 || pendingTurns.length > 0,
      });
    } catch (error) {
      return Object.freeze({
        status: "unavailable",
        sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
        workspaceDirectory,
        messages: [],
        running: activeTurns.size > 0 || pendingTurns.length > 0,
        error: errorMessage(error, "软件助手暂时无法启动。"),
      });
    }
  };

  const send = async ({ content } = {}) => {
    if (disposed) throw new SoftwareAssistantServiceError("软件助手已经停止。", { code: "SERVICE_STOPPED" });
    const text = clean(content);
    if (!text) throw new SoftwareAssistantServiceError("请输入要问 Suzu 的内容。", { code: "EMPTY_MESSAGE" });
    if (text.length > MAX_MESSAGE_LENGTH) throw new SoftwareAssistantServiceError("这条问题太长，请拆成更短的几条。", { code: "MESSAGE_TOO_LONG" });
    await ensureSession();
    const requestId = `suzu-software-${randomUUID()}`;
    const turn = {
      cancelRequested: false,
      cancelTask: null,
      finished: false,
      input: text,
      projectRoot: workspaceDirectory,
      requestId,
      sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
      state: "submitting",
      streamedReplyContent: "",
      text: "",
      toolNames: new Set(),
      usageTasks: [],
      userText: text,
    };
    const active = [...activeTurns.values()][0] || null;
    const steering = Boolean(active || pendingTurns.length);
    if (steering) {
      // Match the normal chat: a direct follow-up becomes the next turn and
      // interrupts the current one as soon as Agent Core reports it running.
      pendingTurns.unshift(turn);
      if (active && !active.finished) {
        active.cancelRequested = true;
        void requestCancellation(active);
      }
      void pumpTurns();
      return Object.freeze({
        accepted: true,
        queued: true,
        requestId,
        sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
        steering: true,
      });
    }
    try {
      await submitTurn(turn);
      return Object.freeze({
        accepted: true,
        queued: false,
        requestId,
        sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
        steering: false,
      });
    } catch (error) {
      throw new SoftwareAssistantServiceError(`无法发送给软件助手：${errorMessage(error, "未知错误。")}`, {
        cause: error,
        code: clean(error?.code) || "SEND_FAILED",
      });
    }
  };

  const stop = async ({ requestId = "" } = {}) => {
    const requested = clean(requestId);
    const queuedIndex = requested ? pendingTurns.findIndex((item) => item.requestId === requested) : -1;
    if (queuedIndex >= 0) {
      const [queued] = pendingTurns.splice(queuedIndex, 1);
      emit({ type: "turn-stopped", requestId: queued.requestId, message: "已从等待中的引导里移除。" });
      return { accepted: true, stopped: true, requestId: queued.requestId };
    }
    const turn = requested ? activeTurns.get(requested) : [...activeTurns.values()][0];
    if (!turn || turn.finished) return { accepted: true, stopped: false, message: "当前没有正在处理的问题。" };
    turn.cancelRequested = true;
    await requestCancellation(turn);
    return { accepted: true, stopped: true, requestId: turn.requestId };
  };

  // The product helper uses one fixed session. Keep its workspace while
  // clearing the native Agent Core transcript before the next question.
  const clearHistory = async () => {
    if (disposed) throw new SoftwareAssistantServiceError("软件助手已经停止。", { code: "SERVICE_STOPPED" });
    if (activeTurns.size || pendingTurns.length) {
      throw new SoftwareAssistantServiceError("Suzu 正在处理当前问题，请结束后再清空记录。", { code: "TURN_ACTIVE" });
    }
    try {
      await runtime.purgeSession({
        sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
        cwd: workspaceDirectory,
        imageAttachmentIds: [],
        protectedImageAttachmentIds: [],
      });
    } catch (error) {
      throw new SoftwareAssistantServiceError(
        `无法清空问 Suzu 的记录：${errorMessage(error, "未知错误。")}`,
        { cause: error, code: clean(error?.code) || "CLEAR_HISTORY_FAILED" },
      );
    }
    emit({ type: "history-cleared" });
    return Object.freeze({
      accepted: true,
      cleared: true,
      sessionId: SUZU_SOFTWARE_ASSISTANT_SESSION_ID,
    });
  };

  return Object.freeze({
    clearHistory,
    snapshot,
    send,
    stop,
    subscribe(listener) {
      if (typeof listener !== "function") throw new SoftwareAssistantServiceError("软件助手订阅者无效。", { code: "INVALID_LISTENER" });
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    dispose() {
      if (disposed) return false;
      disposed = true;
      try { unsubscribeRuntime?.(); } catch { /* Shared Agent Core runtime closes elsewhere. */ }
      activeTurns.clear();
      pendingTurns.splice(0);
      subscribers.clear();
      return true;
    },
  });
}
