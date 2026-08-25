import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

import { resolveAgentConversationDataRoot } from "@suzu-lives/agent-registry";
import { hasBoundaryNoReply, isExactNoReply } from "../../shared/agent-reply-markers.mjs";
import { parseSuzuConversationCommand } from "../../shared/conversation-command.mjs";

const DEFAULT_API_BASE_URL = "https://api.bot.qq.com";
const QQ_GATEWAY_INTENT = 1 << 25; // GROUP_AND_C2C_EVENT, required for C2C_MESSAGE_CREATE.
const QQ_GATEWAY_OP = Object.freeze({
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
});
const MAX_INBOUND_TEXT_LENGTH = 20_000;
const MAX_RECENT_MESSAGE_IDS = 160;
const MAX_QQ_TEXT_RUNES = 4_000;
const MAX_QQ_AGENT_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_QQ_INBOUND_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_QQ_INBOUND_MEDIA_ITEMS = 24;
const BINDING_CODE_TTL_MS = 10 * 60 * 1_000;
const TOKEN_REFRESH_SKEW_MS = 60 * 1_000;
const MAX_GATEWAY_RECONNECTS = 100;
const GATEWAY_RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const INTERNAL_SCHEDULE_MARKER = /<\/?suzu-schedule-task\b[^>]*>|<!--\s*suzu-lives:display-system\s*-->/iu;
const LEADING_REASONING_BLOCK = /^\s*<(?:think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*?<\/(?:think|thinking|analysis|reasoning)\s*>\s*/iu;
const REASONING_TAG = /<\/?(?:think|thinking|analysis|reasoning)\b[^>]*>/iu;

export const QQ_TEXT_SEGMENTATION = Object.freeze({
  PARAGRAPH: "paragraph",
  SENTENCE: "sentence",
});
export const DEFAULT_QQ_TEXT_SEGMENTATION = QQ_TEXT_SEGMENTATION.PARAGRAPH;
export const DEFAULT_QQ_DELIVERY = Object.freeze({
  agent: true,
  proactive: true,
  attachments: false,
  permissions: true,
  tools: false,
  thinking: false,
  system: false,
  tokens: false,
});

export class QQLinkError extends Error {
  constructor(message) {
    super(message);
    this.name = "QQLinkError";
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nowIso(now = () => new Date()) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function normalizedContactId(value) {
  const id = clean(value);
  if (!/^contact-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) throw new QQLinkError("联系人标识无效。 ");
  return id;
}

function normalizedSessionId(value) {
  const id = clean(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) throw new QQLinkError("Agent Core 会话标识无效。 ");
  return id;
}

function normalizedAppId(value) {
  const id = clean(value);
  if (!id) throw new QQLinkError("请填写 QQ 机器人的 AppID。 ");
  if (!/^[A-Za-z0-9_-]{3,128}$/u.test(id)) throw new QQLinkError("QQ AppID 格式无效。 ");
  return id;
}

function normalizedGatewayUrl(value) {
  const source = clean(value);
  let parsed;
  try { parsed = new URL(source); }
  catch { throw new QQLinkError("QQ 没有返回有效的 WebSocket 地址。 "); }
  if (parsed.protocol !== "wss:") throw new QQLinkError("QQ WebSocket 地址必须使用 WSS。 ");
  return parsed.toString();
}

function masked(value) {
  const text = clean(value);
  if (!text) return "";
  return text.length <= 8 ? "••••" : `••••${text.slice(-4)}`;
}

function normalizeDelivery(value = {}) {
  const input = plainObject(value);
  return Object.fromEntries(Object.entries(DEFAULT_QQ_DELIVERY).map(([key, fallback]) => [key, input[key] === undefined ? fallback : input[key] === true]));
}

function normalizeTextSegmentation(value) {
  return clean(value) === QQ_TEXT_SEGMENTATION.SENTENCE
    ? QQ_TEXT_SEGMENTATION.SENTENCE
    : DEFAULT_QQ_TEXT_SEGMENTATION;
}

function normalizeReplyRoute(value) {
  const route = plainObject(value);
  if (clean(route.mode) !== "reply" || clean(route.channel).toLowerCase() !== "qq") return null;
  const connectionId = clean(route.connectionId);
  const replyMessageId = clean(route.replyMessageId);
  return connectionId && replyMessageId ? { connectionId, replyMessageId } : null;
}

function isQqEligibleEvent(event = {}) {
  if (event.displayAsSystem === true) return false;
  const route = plainObject(event.deliveryRoute);
  if (clean(route.mode) === "proactive") {
    return event.kind === "schedule" && clean(event.scheduleSource) === "proactive-contact";
  }
  return Boolean(normalizeReplyRoute(route));
}

function publicAgentReply(value, { scheduled = false } = {}) {
  const source = clean(value);
  if (!source || (scheduled ? hasBoundaryNoReply(source) : isExactNoReply(source)) || INTERNAL_SCHEDULE_MARKER.test(source)) return "";
  const visible = source.replace(LEADING_REASONING_BLOCK, "").trim();
  return REASONING_TAG.test(visible) || /^NO_REPLY$/iu.test(visible) ? "" : visible;
}

function permissionDecision(value) {
  const text = clean(value);
  if (text === "允许") return "allow";
  if (text === "拒绝") return "deny";
  return "";
}

function permissionNotice(event = {}) {
  const toolName = clean(event.toolName) || "Agent Core 工具";
  const preview = clean(event.preview).slice(0, 1_200);
  return [
    `Agent Core 正在等待工具权限：${toolName}`,
    preview ? `操作摘要：${preview}` : "",
    "回复“允许”或“拒绝”处理。",
  ].filter(Boolean).join("\n");
}

function chunks(value, maximum = MAX_QQ_TEXT_RUNES) {
  const characters = Array.from(String(value ?? ""));
  const result = [];
  for (let index = 0; index < characters.length; index += maximum) result.push(characters.slice(index, index + maximum).join(""));
  return result;
}

function splitQqSentences(paragraph) {
  const output = [];
  const characters = Array.from(String(paragraph ?? ""));
  const ending = new Set(["。", "！", "？", "!", "?", ".", "…"]);
  const trailing = new Set([...ending, "\"", "'", "”", "’", ")", "）", "]", "】", "》"]);
  let current = "";
  let sentenceEnded = false;
  const flush = () => {
    const value = current.trim();
    if (value) output.push(value);
    current = "";
    sentenceEnded = false;
  };
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    const previous = characters[index - 1] || "";
    const next = characters[index + 1] || "";
    const decimalPoint = character === "." && /\d/u.test(previous) && /\d/u.test(next);
    if (sentenceEnded && !trailing.has(character)) flush();
    current += character;
    if (!decimalPoint && ending.has(character)) sentenceEnded = true;
  }
  flush();
  return output;
}

/** Split an outbound QQ text reply before applying a conservative message-size boundary. */
export function splitQqText(value, { textSegmentation = DEFAULT_QQ_TEXT_SEGMENTATION } = {}) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  const paragraphs = text.split(/\r?\n[\t ]*\r?\n+/u).map((item) => item.trim()).filter(Boolean);
  const segments = normalizeTextSegmentation(textSegmentation) === QQ_TEXT_SEGMENTATION.SENTENCE
    ? paragraphs.flatMap(splitQqSentences)
    : paragraphs;
  return segments.flatMap((segment) => chunks(segment));
}

function emptyPublicStore() {
  return {
    version: 1,
    bot: { appId: "" },
    delivery: { ...DEFAULT_QQ_DELIVERY },
    textSegmentation: DEFAULT_QQ_TEXT_SEGMENTATION,
    gateway: { sessionId: "", lastSeq: null },
    bindings: [],
  };
}

function emptyCredentialStore() {
  return { version: 1, encryptedClientSecret: "" };
}

function normalizeBinding(value) {
  const raw = plainObject(value);
  const id = clean(raw.id);
  const contactId = clean(raw.contactId);
  const userOpenId = clean(raw.userOpenId);
  if (!id || !contactId || !userOpenId) return null;
  try {
    return {
      id: id.slice(0, 160),
      contactId: normalizedContactId(contactId),
      userOpenId: userOpenId.slice(0, 400),
      enabled: raw.enabled !== false,
      recentMessageIds: Array.isArray(raw.recentMessageIds)
        ? [...new Set(raw.recentMessageIds.map((item) => clean(item).slice(0, 700)).filter(Boolean))].slice(-MAX_RECENT_MESSAGE_IDS)
        : [],
      createdAt: clean(raw.createdAt),
      updatedAt: clean(raw.updatedAt),
      lastError: clean(raw.lastError).slice(0, 700),
      lastReceivedAt: clean(raw.lastReceivedAt),
      lastSentAt: clean(raw.lastSentAt),
    };
  } catch {
    return null;
  }
}

function normalizePublicStore(value) {
  const raw = plainObject(value);
  const bot = plainObject(raw.bot);
  const gateway = plainObject(raw.gateway);
  let appId = "";
  try { appId = clean(bot.appId) ? normalizedAppId(bot.appId) : ""; } catch { /* Drop a malformed saved AppID. */ }
  const lastSeq = Number(gateway.lastSeq);
  return {
    version: 1,
    bot: { appId },
    delivery: normalizeDelivery(raw.delivery),
    textSegmentation: normalizeTextSegmentation(raw.textSegmentation),
    gateway: {
      sessionId: clean(gateway.sessionId).slice(0, 500),
      lastSeq: Number.isSafeInteger(lastSeq) && lastSeq >= 0 ? lastSeq : null,
    },
    bindings: (Array.isArray(raw.bindings) ? raw.bindings : []).map(normalizeBinding).filter(Boolean).slice(0, 80),
  };
}

function normalizeCredentialStore(value) {
  const raw = plainObject(value);
  return {
    version: 1,
    encryptedClientSecret: clean(raw.encryptedClientSecret).slice(0, 100_000),
  };
}

async function readJson(fsOps, target, fallback) {
  try { return JSON.parse(await fsOps.readFile(target, "utf8")); } catch { return fallback; }
}

async function writeJsonAtomic(fsOps, target, value) {
  await fsOps.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.suzu-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  await fsOps.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try { await fsOps.rename(temporary, target); }
  catch (error) { await fsOps.unlink(temporary).catch(() => undefined); throw error; }
}

async function responseJson(response, label) {
  let body = "";
  try { body = await response?.text?.(); } catch { /* The HTTP status is still useful. */ }
  if (!response?.ok) {
    let detail = clean(body);
    try {
      const parsed = JSON.parse(body);
      detail = clean(parsed?.message ?? parsed?.msg ?? parsed?.error ?? detail);
    } catch { /* Keep the original response body. */ }
    throw new QQLinkError(`QQ ${label} 请求失败（HTTP ${response?.status ?? "未知"}）：${detail.slice(0, 300) || "请稍后重试。"}`);
  }
  try { return JSON.parse(body); }
  catch { throw new QQLinkError(`QQ ${label} 返回了无效数据。`); }
}

function safeAttachmentUrl(value) {
  const source = clean(value);
  if (!source) return "";
  try {
    const parsed = new URL(source);
    return parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function messageIndex(message = {}) {
  const ext = Array.isArray(message?.message_scene?.ext) ? message.message_scene.ext : [];
  return ext.map((item) => clean(item)).find((item) => item.startsWith("msg_idx=")) || "";
}

function inboundMessageKey(message = {}, userOpenId = "") {
  return [clean(userOpenId), clean(message?.id), messageIndex(message), clean(message?.timestamp)].join("|");
}

function inboundText(message = {}) {
  const direct = clean(message?.content);
  if (direct) return direct.slice(0, MAX_INBOUND_TEXT_LENGTH);
  const elements = Array.isArray(message?.msg_elements) ? message.msg_elements : [];
  return elements.map((item) => clean(item?.content)).filter(Boolean).join("\n").slice(0, MAX_INBOUND_TEXT_LENGTH);
}

function inboundAttachments(message = {}) {
  const direct = Array.isArray(message?.attachments) ? message.attachments : [];
  const elements = Array.isArray(message?.msg_elements) ? message.msg_elements : [];
  return [...direct, ...elements.flatMap((item) => Array.isArray(item?.attachments) ? item.attachments : [])].slice(0, MAX_QQ_INBOUND_MEDIA_ITEMS);
}

function inboundAttachmentKind(attachment = {}) {
  const mime = clean(attachment?.content_type).toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime === "voice" || mime.startsWith("audio/")) return "audio";
  return mime ? "file" : "";
}

function fileName(value, fallback = "attachment.bin") {
  const name = path.basename(clean(value)).replace(/[\r\n]/gu, "").slice(0, 300);
  return name || fallback;
}

function safeFileName(value, fallback = "file") {
  const name = fileName(value, fallback)
    .replace(/[\\/:*?"<>|]/gu, "_")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return name || fallback;
}

function extensionForMime(mimeType) {
  return {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "audio/wav": ".wav",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
  }[clean(mimeType).toLowerCase()] || "";
}

function mediaFileType(kind) {
  if (kind === "image") return 1;
  if (kind === "audio") return 3;
  return 4;
}

function mediaLabel(kind) {
  return kind === "image" ? "图片" : kind === "audio" ? "语音" : "文件";
}

function bindingCode() {
  return `SUZU-${randomBytes(5).toString("hex").toUpperCase()}`;
}

function normalizedBindingCode(value) {
  return clean(value).toUpperCase();
}

function codeFromMessage(value) {
  const candidate = normalizedBindingCode(value).replace(/\s+/gu, "");
  return /^SUZU-[A-F0-9]{10}$/u.test(candidate) ? candidate : "";
}

function readSecret(encrypted, safeStorage) {
  const value = clean(encrypted);
  if (!value) return { secret: "", status: "missing" };
  if (!safeStorage?.isEncryptionAvailable?.()) return { secret: "", status: "encryption-unavailable" };
  try {
    const secret = clean(safeStorage.decryptString(Buffer.from(value, "base64")));
    return { secret, status: secret ? "ready" : "invalid" };
  } catch {
    return { secret: "", status: "unreadable" };
  }
}

/**
 * QQ C2C connector. The QQ account mapping and all return-channel metadata
 * live in the desktop product process; Agent Core only receives normal
 * conversation input and never sees a transport selector.
 */
export function createQQLinkService({
  chat,
  dataRoot,
  fetchImpl = globalThis.fetch,
  fsOps = fs,
  now = () => new Date(),
  reader,
  safeStorage = null,
  WebSocketImpl = WebSocket,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (!chat?.sendToSession || !chat?.steer || !chat?.stop || !chat?.subscribe) throw new QQLinkError("QQ 连接需要本机 Agent Core 会话服务。 ");
  if (!reader?.resolveContactSession || !reader?.contactIdForSession) throw new QQLinkError("QQ 连接需要联系人会话读取服务。 ");
  if (!clean(dataRoot) || !path.isAbsolute(clean(dataRoot))) throw new QQLinkError("无法定位 Suzu Lives 软件数据目录。 ");
  if (typeof fetchImpl !== "function") throw new QQLinkError("当前运行环境无法访问 QQ 机器人服务。 ");
  if (typeof WebSocketImpl !== "function") throw new QQLinkError("当前运行环境无法建立 QQ WebSocket 连接。 ");

  const root = path.join(path.resolve(dataRoot), "qq-link");
  const publicPath = path.join(root, "connections.json");
  const credentialPath = path.join(root, "credentials.json");
  let publicStore = emptyPublicStore();
  let credentialStore = emptyCredentialStore();
  let loaded = false;
  let loadPromise = null;
  let persistChain = Promise.resolve();
  let disposed = false;
  const listeners = new Set();
  const attempts = new Map();
  const deliveryChains = new Map();
  const replySequences = new Map();
  let tokenCache = null;
  let tokenPromise = null;
  let gatewaySocket = null;
  let gatewayStarting = null;
  let gatewayHeartbeat = null;
  let gatewayReconnectTimer = null;
  let gatewayGeneration = 0;
  let reconnectAttempt = 0;
  const gatewayRuntime = {
    status: "not-configured",
    lastError: "",
    connectedAt: "",
  };

  const emit = (event) => {
    const payload = { ...event, timestamp: event?.timestamp || nowIso(now) };
    for (const listener of listeners) {
      try { listener(payload); } catch { /* A renderer observer cannot control transport state. */ }
    }
  };

  const ensureLoaded = async () => {
    if (loaded) return;
    if (!loadPromise) {
      loadPromise = Promise.all([
        readJson(fsOps, publicPath, emptyPublicStore()),
        readJson(fsOps, credentialPath, emptyCredentialStore()),
      ]).then(([storedPublic, storedCredentials]) => {
        publicStore = normalizePublicStore(storedPublic);
        credentialStore = normalizeCredentialStore(storedCredentials);
        loaded = true;
      });
    }
    await loadPromise;
  };

  const persist = async () => {
    await ensureLoaded();
    persistChain = persistChain.catch(() => undefined).then(async () => {
      await writeJsonAtomic(fsOps, publicPath, publicStore);
      await writeJsonAtomic(fsOps, credentialPath, credentialStore);
    });
    return persistChain;
  };

  const botCredentials = () => {
    const state = readSecret(credentialStore.encryptedClientSecret, safeStorage);
    return {
      appId: clean(publicStore.bot.appId),
      clientSecret: state.secret,
      credentialStatus: state.status,
    };
  };

  const botIsConfigured = () => {
    const credentials = botCredentials();
    return Boolean(credentials.appId && credentials.clientSecret);
  };

  const publicBot = () => {
    const credentials = botCredentials();
    const configured = Boolean(credentials.appId && credentials.clientSecret);
    return {
      appId: publicStore.bot.appId,
      configured,
      credentialStatus: credentials.credentialStatus,
      status: configured ? gatewayRuntime.status : "not-configured",
      lastError: gatewayRuntime.lastError,
      connectedAt: gatewayRuntime.connectedAt,
    };
  };

  const publicBinding = (binding) => binding ? {
    id: binding.id,
    contactId: binding.contactId,
    userOpenId: masked(binding.userOpenId),
    enabled: binding.enabled !== false,
    status: binding.enabled === false
      ? "paused"
      : gatewayRuntime.status === "connected"
        ? "connected"
        : binding.lastError || gatewayRuntime.lastError
          ? "attention"
          : "saved",
    lastError: binding.lastError || "",
    lastReceivedAt: binding.lastReceivedAt || "",
    lastSentAt: binding.lastSentAt || "",
    createdAt: binding.createdAt || "",
  } : null;

  const findBindingForContact = (contactId) => publicStore.bindings.find((item) => item.contactId === clean(contactId)) || null;
  const findBindingById = (id) => publicStore.bindings.find((item) => item.id === clean(id)) || null;
  const findBindingByOpenId = (userOpenId) => publicStore.bindings.find((item) => item.userOpenId === clean(userOpenId)) || null;
  const scopeForContact = async (contactId) => reader.resolveContactSession(normalizedContactId(contactId));

  const setGatewayError = (message, { emitEvent = true } = {}) => {
    gatewayRuntime.lastError = clean(message).slice(0, 700);
    if (botIsConfigured()) gatewayRuntime.status = "attention";
    if (emitEvent) emit({ type: "gateway-error", message: gatewayRuntime.lastError });
  };

  const clearGatewayHeartbeat = () => {
    if (gatewayHeartbeat !== null) clearIntervalImpl(gatewayHeartbeat);
    gatewayHeartbeat = null;
  };

  const clearGatewayReconnect = () => {
    if (gatewayReconnectTimer !== null) clearTimeoutImpl(gatewayReconnectTimer);
    gatewayReconnectTimer = null;
  };

  const closeGatewaySocket = () => {
    const socket = gatewaySocket;
    gatewaySocket = null;
    clearGatewayHeartbeat();
    try { socket?.close?.(); } catch { /* Connection teardown is best effort. */ }
  };

  const resetGatewaySession = () => {
    publicStore.gateway = { sessionId: "", lastSeq: null };
  };

  const stopGateway = ({ clearSession = false, status = "stopped" } = {}) => {
    gatewayGeneration += 1;
    // A credential change may happen while token/gateway discovery is still
    // pending. Let the new configuration start immediately; the generation
    // guard below prevents the old request from attaching a socket later.
    gatewayStarting = null;
    clearGatewayReconnect();
    closeGatewaySocket();
    if (clearSession) resetGatewaySession();
    if (!disposed) gatewayRuntime.status = botIsConfigured() ? status : "not-configured";
  };

  const getAccessToken = async ({ force = false } = {}) => {
    const credentials = botCredentials();
    if (!credentials.appId || !credentials.clientSecret) {
      throw new QQLinkError("QQ 机器人尚未配置。请先填写 AppID 和 AppSecret。 ");
    }
    const currentTime = now().getTime();
    if (!force && tokenCache?.token && currentTime < tokenCache.expiresAt) return tokenCache.token;
    if (!force && tokenPromise) return tokenPromise;
    const request = (async () => {
      const response = await fetchImpl(`${DEFAULT_API_BASE_URL}/app/getAppAccessToken`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: credentials.appId, clientSecret: credentials.clientSecret }),
      });
      const data = await responseJson(response, "access token");
      const token = clean(data?.access_token);
      const expiresIn = Number(data?.expires_in);
      if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new QQLinkError("QQ 没有返回可用的访问凭证。 ");
      tokenCache = {
        token,
        expiresAt: now().getTime() + Math.max(30_000, expiresIn * 1_000 - TOKEN_REFRESH_SKEW_MS),
      };
      return token;
    })();
    tokenPromise = request;
    try { return await request; }
    finally { if (tokenPromise === request) tokenPromise = null; }
  };

  const qqApi = async (pathname, { method = "GET", body = null, token = "" } = {}) => {
    const accessToken = clean(token) || await getAccessToken();
    const url = new URL(pathname.replace(/^\/+/, ""), `${DEFAULT_API_BASE_URL}/`);
    const response = await fetchImpl(url.toString(), {
      method,
      headers: {
        Authorization: `QQBot ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "suzu-lives-qq/1.0",
      },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
    });
    return responseJson(response, pathname);
  };

  const sendGatewayPayload = (socket, payload) => {
    try {
      const open = Number(socket?.OPEN ?? WebSocketImpl.OPEN ?? 1);
      if (socket?.readyState !== undefined && socket.readyState !== open) return false;
      socket?.send?.(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  };

  const scheduleGatewayReconnect = (delay = null) => {
    if (disposed || !botIsConfigured() || gatewayReconnectTimer !== null) return;
    if (reconnectAttempt >= MAX_GATEWAY_RECONNECTS) {
      setGatewayError("QQ 连接多次重试仍未恢复，请检查机器人状态和网络。 ");
      return;
    }
    const fallback = GATEWAY_RECONNECT_DELAYS[Math.min(reconnectAttempt, GATEWAY_RECONNECT_DELAYS.length - 1)];
    const wait = Number.isFinite(delay) ? Math.max(1_000, delay) : fallback;
    reconnectAttempt += 1;
    gatewayReconnectTimer = setTimeoutImpl(() => {
      gatewayReconnectTimer = null;
      void ensureGateway().catch((error) => {
        setGatewayError(clean(error?.message) || "QQ 连接恢复失败。 ");
        scheduleGatewayReconnect();
      });
    }, wait);
    gatewayReconnectTimer?.unref?.();
  };

  const persistGatewaySession = () => persist().catch(() => undefined);

  const handleGatewayDispatch = async (payload) => {
    const eventType = clean(payload?.t);
    const data = plainObject(payload?.d);
    if (eventType === "READY") {
      publicStore.gateway.sessionId = clean(data?.session_id).slice(0, 500);
      gatewayRuntime.status = "connected";
      gatewayRuntime.lastError = "";
      gatewayRuntime.connectedAt = nowIso(now);
      reconnectAttempt = 0;
      await persistGatewaySession();
      emit({ type: "gateway-connected" });
      return;
    }
    if (eventType === "RESUMED") {
      gatewayRuntime.status = "connected";
      gatewayRuntime.lastError = "";
      gatewayRuntime.connectedAt = gatewayRuntime.connectedAt || nowIso(now);
      reconnectAttempt = 0;
      await persistGatewaySession();
      emit({ type: "gateway-resumed" });
      return;
    }
    if (eventType === "C2C_MESSAGE_CREATE") {
      await handleInboundMessage(data);
    }
  };

  const attachGatewaySocket = (socket, token, generation) => {
    socket.on?.("open", () => {
      if (disposed || generation !== gatewayGeneration || gatewaySocket !== socket) return;
      gatewayRuntime.status = "connecting";
      gatewayRuntime.lastError = "";
      emit({ type: "gateway-connecting" });
    });
    socket.on?.("message", (message) => {
      if (disposed || generation !== gatewayGeneration || gatewaySocket !== socket) return;
      void (async () => {
        let payload;
        try { payload = JSON.parse(Buffer.isBuffer(message) ? message.toString("utf8") : String(message)); }
        catch { throw new QQLinkError("QQ Gateway 返回了无效消息。 "); }
        if (Number.isSafeInteger(payload?.s) && payload.s >= 0) {
          publicStore.gateway.lastSeq = payload.s;
          void persistGatewaySession();
        }
        if (payload?.op === QQ_GATEWAY_OP.HELLO) {
          const interval = Number(payload?.d?.heartbeat_interval);
          if (!Number.isFinite(interval) || interval < 1_000) throw new QQLinkError("QQ Gateway 没有返回有效心跳周期。 ");
          clearGatewayHeartbeat();
          const resume = clean(publicStore.gateway.sessionId) && Number.isSafeInteger(publicStore.gateway.lastSeq);
          const login = resume
            ? {
              op: QQ_GATEWAY_OP.RESUME,
              d: {
                token: `QQBot ${token}`,
                session_id: publicStore.gateway.sessionId,
                seq: publicStore.gateway.lastSeq,
              },
            }
            : {
              op: QQ_GATEWAY_OP.IDENTIFY,
              d: {
                token: `QQBot ${token}`,
                intents: QQ_GATEWAY_INTENT,
                shard: [0, 1],
                properties: { $os: process.platform, $browser: "suzu-lives", $device: "suzu-lives" },
              },
            };
          if (!sendGatewayPayload(socket, login)) throw new QQLinkError("QQ Gateway 登录消息未能发送。 ");
          gatewayHeartbeat = setIntervalImpl(() => {
            sendGatewayPayload(socket, { op: QQ_GATEWAY_OP.HEARTBEAT, d: publicStore.gateway.lastSeq });
          }, interval);
          gatewayHeartbeat?.unref?.();
          return;
        }
        if (payload?.op === QQ_GATEWAY_OP.DISPATCH) {
          await handleGatewayDispatch(payload);
          return;
        }
        if (payload?.op === QQ_GATEWAY_OP.RECONNECT) {
          closeGatewaySocket();
          scheduleGatewayReconnect();
          return;
        }
        if (payload?.op === QQ_GATEWAY_OP.INVALID_SESSION) {
          if (payload?.d !== true) {
            resetGatewaySession();
            tokenCache = null;
            await persistGatewaySession();
          }
          closeGatewaySocket();
          scheduleGatewayReconnect(3_000);
        }
      })().catch((error) => {
        setGatewayError(clean(error?.message) || "QQ Gateway 消息处理失败。 ");
      });
    });
    socket.on?.("error", (error) => {
      if (disposed || generation !== gatewayGeneration || gatewaySocket !== socket) return;
      setGatewayError(clean(error?.message) || "QQ Gateway 连接异常。 ");
    });
    socket.on?.("close", (code) => {
      if (generation !== gatewayGeneration || gatewaySocket !== socket) return;
      gatewaySocket = null;
      clearGatewayHeartbeat();
      if (disposed || !botIsConfigured()) return;
      const closeCode = Number(code);
      if ([4914, 4915].includes(closeCode)) {
        const message = closeCode === 4914
          ? "QQ 机器人当前只能连接沙箱环境，请检查机器人发布状态。"
          : "QQ 机器人已被平台限制，暂时无法连接。";
        setGatewayError(message);
        return;
      }
      if ([4006, 4007].includes(closeCode)) {
        resetGatewaySession();
        void persistGatewaySession();
      }
      if (closeCode === 4004) tokenCache = null;
      gatewayRuntime.status = "attention";
      scheduleGatewayReconnect(closeCode === 4008 ? 60_000 : null);
      emit({ type: "gateway-disconnected", code: closeCode });
    });
  };

  const connectGateway = async () => {
    await ensureLoaded();
    if (disposed || !botIsConfigured()) {
      gatewayRuntime.status = "not-configured";
      return false;
    }
    if (gatewaySocket) return true;
    const generation = gatewayGeneration;
    gatewayRuntime.status = "connecting";
    gatewayRuntime.lastError = "";
    emit({ type: "gateway-connecting" });
    try {
      const token = await getAccessToken();
      if (disposed || generation !== gatewayGeneration) return false;
      const gateway = await qqApi("/gateway", { token });
      const url = normalizedGatewayUrl(gateway?.url);
      if (disposed || generation !== gatewayGeneration) return false;
      const socket = new WebSocketImpl(url, { headers: { "User-Agent": "suzu-lives-qq/1.0" } });
      if (disposed || generation !== gatewayGeneration) {
        try { socket.close?.(); } catch { /* The caller changed configuration while connecting. */ }
        return false;
      }
      gatewaySocket = socket;
      attachGatewaySocket(socket, token, generation);
      return true;
    } catch (error) {
      if (!disposed && generation === gatewayGeneration) setGatewayError(clean(error?.message) || "QQ 连接启动失败。 ");
      throw error;
    }
  };

  const ensureGateway = async () => {
    if (gatewaySocket || !botIsConfigured()) return Boolean(gatewaySocket);
    if (!gatewayStarting) {
      const request = connectGateway();
      gatewayStarting = request;
      request.finally(() => { if (gatewayStarting === request) gatewayStarting = null; }).catch(() => undefined);
    }
    return gatewayStarting;
  };

  const nextReplySequence = (bindingId, messageId) => {
    const key = `${clean(bindingId)}|${clean(messageId)}`;
    const current = plainObject(replySequences.get(key));
    const next = Math.max(1, Math.min(65_535, Number(current.next) || 1));
    replySequences.set(key, { next: next >= 65_535 ? 1 : next + 1, expiresAt: now().getTime() + 60 * 60 * 1_000 });
    for (const [candidate, value] of replySequences) if (Number(value?.expiresAt) <= now().getTime()) replySequences.delete(candidate);
    return next;
  };

  const sendText = async (binding, content, { replyMessageId = "" } = {}) => {
    const text = clean(content);
    if (!text) return;
    const target = clean(binding?.userOpenId);
    if (!target) throw new QQLinkError("QQ 联系人标识不可用。 ");
    const messageId = clean(replyMessageId);
    const body = {
      msg_type: 0,
      content: text,
      ...(messageId ? { msg_id: messageId, msg_seq: nextReplySequence(binding.id, messageId) } : {}),
    };
    await qqApi(`/v2/users/${encodeURIComponent(target)}/messages`, { method: "POST", body });
    binding.lastSentAt = nowIso(now);
    binding.lastError = "";
    await persist();
  };

  const sendMedia = async (binding, media, { replyMessageId = "" } = {}) => {
    const source = plainObject(media);
    const kind = clean(source.kind).toLowerCase();
    if (!new Set(["image", "audio", "file"]).has(kind)) throw new QQLinkError("Agent 返回的 QQ 附件类型无效。 ");
    const data = Buffer.isBuffer(source.data) ? source.data : Buffer.from(source.data || []);
    if (!data.length) throw new QQLinkError(`要投递的${mediaLabel(kind)}为空。 `);
    if (data.length > MAX_QQ_AGENT_MEDIA_BYTES) {
      throw new QQLinkError(`要投递的${mediaLabel(kind)}超过 ${MAX_QQ_AGENT_MEDIA_BYTES >> 20} MiB 上限。 `);
    }
    const target = clean(binding?.userOpenId);
    if (!target) throw new QQLinkError("QQ 联系人标识不可用。 ");
    const fileType = mediaFileType(kind);
    const upload = await qqApi(`/v2/users/${encodeURIComponent(target)}/files`, {
      method: "POST",
      body: {
        file_type: fileType,
        file_data: data.toString("base64"),
        srv_send_msg: false,
        ...(fileType === 4 ? { file_name: safeFileName(source.fileName, "suzu-file") } : {}),
      },
    });
    const fileInfo = clean(upload?.file_info);
    if (!fileInfo) throw new QQLinkError("QQ 没有返回可用的媒体文件信息。 ");
    const messageId = clean(replyMessageId);
    await qqApi(`/v2/users/${encodeURIComponent(target)}/messages`, {
      method: "POST",
      body: {
        msg_type: 7,
        media: { file_info: fileInfo },
        ...(messageId ? { msg_id: messageId, msg_seq: nextReplySequence(binding.id, messageId) } : {}),
      },
    });
    binding.lastSentAt = nowIso(now);
    binding.lastError = "";
    await persist();
  };

  const deliverText = async (binding, text, options = {}) => {
    for (const segment of splitQqText(text, { textSegmentation: publicStore.textSegmentation })) await sendText(binding, segment, options);
  };

  const queueTask = (binding, task) => {
    const prior = deliveryChains.get(binding.id) || Promise.resolve();
    const next = prior.catch(() => undefined).then(task);
    deliveryChains.set(binding.id, next);
    next.then(
      () => { if (deliveryChains.get(binding.id) === next) deliveryChains.delete(binding.id); },
      () => { if (deliveryChains.get(binding.id) === next) deliveryChains.delete(binding.id); },
    );
    return next;
  };

  const queueDelivery = (binding, text, options = {}) => queueTask(binding, () => deliverText(binding, text, options));

  const inboundMediaDirectory = (session, key) => path.join(
    resolveAgentConversationDataRoot({
      dataRoot,
      projectRoot: clean(session?.projectRoot),
      sessionId: normalizedSessionId(session?.id),
    }),
    "inbound",
    "qq",
    Buffer.from(key).toString("base64url").slice(0, 80),
  );

  const cacheInboundMedia = async (session, key, index, { kind, data, fileName: originalName, mimeType }) => {
    const content = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
    if (!content.length) throw new QQLinkError("QQ 媒体文件为空。 ");
    const directory = inboundMediaDirectory(session, key);
    const prefix = `${String(index + 1).padStart(2, "0")}-`;
    const extension = extensionForMime(mimeType);
    const savedName = kind === "image"
      ? `${prefix}qq-image${extension || ".jpg"}`
      : `${prefix}${fileName(originalName, `qq-${kind}${extension}`)}`;
    const target = path.join(directory, savedName);
    await fsOps.mkdir(directory, { recursive: true });
    await fsOps.writeFile(target, content);
    return {
      kind,
      path: target,
      fileName: savedName.slice(prefix.length),
      mimeType: clean(mimeType) || "application/octet-stream",
      size: content.length,
      data: content,
    };
  };

  const collectInboundMedia = async (session, message, key) => {
    const result = [];
    for (const attachment of inboundAttachments(message)) {
      if (result.length >= MAX_QQ_INBOUND_MEDIA_ITEMS) break;
      const kind = inboundAttachmentKind(attachment);
      if (!kind) continue;
      const voiceUrl = kind === "audio" ? safeAttachmentUrl(attachment?.voice_wav_url) : "";
      const url = voiceUrl || safeAttachmentUrl(attachment?.url);
      if (!url) continue;
      try {
        const response = await fetchImpl(url, { method: "GET" });
        if (!response?.ok) continue;
        const data = Buffer.from(await response.arrayBuffer());
        if (!data.length || data.length > MAX_QQ_INBOUND_MEDIA_BYTES) continue;
        const originalMime = clean(attachment?.content_type).toLowerCase();
        const mimeType = voiceUrl ? "audio/wav" : originalMime || "application/octet-stream";
        const fallbackName = kind === "audio" ? `qq-voice${extensionForMime(mimeType) || ".wav"}` : `qq-${kind}${extensionForMime(mimeType)}`;
        result.push(await cacheInboundMedia(session, key, result.length, {
          kind,
          data,
          fileName: clean(attachment?.filename) || fallbackName,
          mimeType,
        }));
      } catch {
        // A bad QQ attachment must not stop the text portion from reaching the Agent.
      }
    }
    return result;
  };

  const readAgentMedia = async (entry) => {
    const source = plainObject(entry);
    const kind = clean(source.kind).toLowerCase();
    const sourcePath = clean(source.path);
    if (!new Set(["image", "audio", "file"]).has(kind) || !sourcePath || !path.isAbsolute(sourcePath)) {
      throw new QQLinkError("Agent 返回的本地附件无效。 ");
    }
    const resolved = path.resolve(sourcePath);
    let stat;
    try { stat = await fsOps.stat(resolved); }
    catch { throw new QQLinkError(`找不到 Agent 要投递的文件：${resolved}`); }
    if (!stat.isFile()) throw new QQLinkError(`Agent 要投递的路径不是普通文件：${resolved}`);
    if (stat.size <= 0) throw new QQLinkError(`Agent 要投递的文件为空：${resolved}`);
    if (stat.size > MAX_QQ_AGENT_MEDIA_BYTES) {
      throw new QQLinkError(`Agent 要投递的文件超过 ${MAX_QQ_AGENT_MEDIA_BYTES >> 20} MiB：${resolved}`);
    }
    let data;
    try { data = await fsOps.readFile(resolved); }
    catch { throw new QQLinkError(`无法读取 Agent 要投递的文件：${resolved}`); }
    return { kind, data, fileName: path.basename(resolved) };
  };

  const commandResponse = async (binding, message, replyMessageId) => {
    try { await queueDelivery(binding, message, { replyMessageId }); }
    catch (error) {
      binding.lastError = clean(error?.message) || "无法回传 QQ 命令结果。 ";
      await persist();
      emit({ type: "error", bindingId: binding.id, contactId: binding.contactId, message: binding.lastError });
    }
  };

  const expireAttempts = () => {
    const currentTime = now().getTime();
    for (const [contactId, attempt] of attempts) if (attempt.expiresAt <= currentTime) attempts.delete(contactId);
  };

  const completeBinding = async (attempt, { userOpenId, messageId, messageKey }) => {
    const priorForUser = findBindingByOpenId(userOpenId);
    const priorForContact = findBindingForContact(attempt.contactId);
    for (const prior of [priorForUser, priorForContact]) {
      if (!prior) continue;
      deliveryChains.delete(prior.id);
      for (const key of replySequences.keys()) if (key.startsWith(`${prior.id}|`)) replySequences.delete(key);
    }
    publicStore.bindings = publicStore.bindings.filter((binding) => (
      binding.userOpenId !== userOpenId && binding.contactId !== attempt.contactId
    ));
    const binding = {
      id: randomUUID(),
      contactId: attempt.contactId,
      userOpenId,
      enabled: true,
      recentMessageIds: messageKey ? [messageKey] : [],
      createdAt: nowIso(now),
      updatedAt: nowIso(now),
      lastError: "",
      lastReceivedAt: nowIso(now),
      lastSentAt: "",
    };
    publicStore.bindings.push(binding);
    attempts.delete(attempt.contactId);
    await persist();
    emit({ type: "connected", bindingId: binding.id, contactId: binding.contactId });
    await commandResponse(binding, "已连接到这位联系人。之后发给机器人的消息都会进入这段对话。", messageId);
    return binding;
  };

  const handleInboundMessage = async (message) => {
    const author = plainObject(message?.author);
    const userOpenId = clean(author?.user_openid ?? author?.id).slice(0, 400);
    const messageId = clean(message?.id).slice(0, 700);
    if (!userOpenId || !messageId) return;
    expireAttempts();
    const text = inboundText(message);
    const requestedCode = codeFromMessage(text);
    const attempt = requestedCode
      ? [...attempts.values()].find((item) => item.code === requestedCode && item.expiresAt > now().getTime()) || null
      : null;
    const key = inboundMessageKey(message, userOpenId);
    if (attempt) {
      await completeBinding(attempt, { userOpenId, messageId, messageKey: key });
      return;
    }
    const binding = findBindingByOpenId(userOpenId);
    if (!binding || binding.enabled === false || binding.recentMessageIds.includes(key)) return;
    try {
      const session = await scopeForContact(binding.contactId);
      const media = await collectInboundMedia(session, message, key);
      if (!text && !media.length) return;
      const command = parseSuzuConversationCommand(text);
      const permission = media.length === 0 && publicStore.delivery.permissions === true ? permissionDecision(text) : "";
      if (permission && typeof chat.respondPermissionForSession === "function") {
        const result = chat.respondPermissionForSession({
          behavior: permission,
          sessionId: session.id,
          projectRoot: session.projectRoot,
        });
        if (result?.accepted) {
          const action = result.behavior === "allow" ? "已允许" : "已拒绝";
          await commandResponse(binding, `${action}工具权限：${clean(result.toolName) || "Agent Core 工具"}。`, messageId);
        } else if (result?.reason === "multiple-pending-permissions") {
          await commandResponse(binding, "当前有多条等待确认的工具请求，请回到桌面端分别处理。", messageId);
        } else {
          await commandResponse(binding, "当前没有等待确认的工具请求。", messageId);
        }
      } else if (command.action === "notice") {
        await commandResponse(binding, command.message, messageId);
      } else if (command.action === "stop") {
        const result = chat.stop({ sessionId: session.id, projectRoot: session.projectRoot });
        await commandResponse(binding, clean(result?.message) || "正在停止当前 Agent Core 任务。", messageId);
      } else if (command.action === "steer") {
        const result = await chat.steer({
          content: command.content,
          sessionId: session.id,
          projectRoot: session.projectRoot,
          hasTranscript: session.hasTranscript === true,
        });
        await commandResponse(binding, clean(result?.message) || "引导已送达。", messageId);
      } else {
        const requestId = `qq-${randomUUID()}`;
        const request = {
          content: command.content,
          sessionId: session.id,
          projectRoot: session.projectRoot,
          hasTranscript: session.hasTranscript === true,
          kind: "message",
          deliveryRoute: {
            mode: "reply",
            channel: "qq",
            connectionId: binding.id,
            replyMessageId: messageId,
          },
          requestId,
        };
        if (media.length) request.media = media;
        await chat.sendToSession(request);
      }
      binding.recentMessageIds = [...binding.recentMessageIds, key].slice(-MAX_RECENT_MESSAGE_IDS);
      binding.lastReceivedAt = nowIso(now);
      binding.lastError = "";
      binding.updatedAt = nowIso(now);
      await persist();
      emit({ type: "received", bindingId: binding.id, contactId: binding.contactId });
    } catch (error) {
      const messageText = clean(error?.message) || "无法处理这条 QQ 消息。 ";
      binding.lastError = messageText;
      await persist();
      await commandResponse(binding, `这条消息没有送达：${messageText}`, messageId);
      emit({ type: "error", bindingId: binding.id, contactId: binding.contactId, message: messageText });
    }
  };

  const handleChatEvent = (event) => {
    if (disposed || !event?.sessionId || !isQqEligibleEvent(event)) return;
    const projectRoot = clean(event.projectRoot);
    if (!projectRoot) return;
    void (async () => {
      const contactId = await reader.contactIdForSession({ sessionId: event.sessionId, projectRoot });
      if (!contactId) return;
      const route = plainObject(event.deliveryRoute);
      const isProactiveContact = clean(route.mode) === "proactive"
        || (event.kind === "schedule" && clean(event.scheduleSource) === "proactive-contact");
      if (isProactiveContact && publicStore.delivery.proactive !== true) return;
      const replyRoute = normalizeReplyRoute(route);
      const bindings = publicStore.bindings.filter((binding) => (
        binding.contactId === contactId
        && binding.enabled !== false
        && (!replyRoute || binding.id === replyRoute.connectionId)
      ));
      if (!bindings.length) return;
      if (event.type === "turn-complete") return;
      if (event.kind === "schedule" && !["agent-reply", "agent-media"].includes(event.type)) return;
      const replyMessageId = replyRoute?.replyMessageId || "";
      if (event.type === "agent-media") {
        const media = Array.isArray(event.media) ? event.media : [];
        if (!media.length) return;
        for (const binding of bindings) {
          void queueTask(binding, async () => {
            for (const entry of media) await sendMedia(binding, await readAgentMedia(entry), { replyMessageId });
          }).catch(async (error) => {
            binding.lastError = clean(error?.message) || "QQ 文件发送失败。 ";
            await persist().catch(() => undefined);
            emit({ type: "error", bindingId: binding.id, contactId: binding.contactId, message: binding.lastError });
          });
        }
        return;
      }
      for (const binding of bindings) {
        let content = "";
        let allowed = false;
        if (event.type === "agent-reply") {
          allowed = publicStore.delivery.agent === true;
          content = publicAgentReply(event.content, { scheduled: event.kind === "schedule" });
        } else if (event.type === "attachment") {
          allowed = publicStore.delivery.attachments === true;
          content = clean(event.content);
        } else if (event.type === "tool") {
          allowed = publicStore.delivery.tools === true;
          content = clean(event.content);
        } else if (event.type === "permission") {
          allowed = publicStore.delivery.permissions === true;
          content = permissionNotice(event);
        } else if (event.type === "thinking") {
          allowed = publicStore.delivery.thinking === true;
          content = clean(event.content);
        } else if (event.type === "usage") {
          allowed = publicStore.delivery.tokens === true;
          content = clean(event.content);
        } else if (["error", "turn-stopped"].includes(event.type)) {
          allowed = publicStore.delivery.system === true;
          content = clean(event.message);
        }
        if (!allowed || !content) continue;
        void queueDelivery(binding, content, { replyMessageId }).catch(async (error) => {
          binding.lastError = clean(error?.message) || "QQ 消息发送失败。 ";
          await persist().catch(() => undefined);
          emit({ type: "error", bindingId: binding.id, contactId: binding.contactId, message: binding.lastError });
        });
      }
    })().catch(() => undefined);
  };

  const unsubscribeChat = chat.subscribe(handleChatEvent);

  const begin = async ({ contactId } = {}) => {
    await ensureLoaded();
    const id = normalizedContactId(contactId);
    await scopeForContact(id);
    if (!botIsConfigured()) throw new QQLinkError("请先在“连接 QQ”里配置机器人，再连接联系人。 ");
    try { await ensureGateway(); }
    catch (error) { throw new QQLinkError(clean(error?.message) || "QQ 机器人暂时无法连接。 "); }
    const attempt = {
      id: randomUUID(),
      contactId: id,
      code: bindingCode(),
      expiresAt: now().getTime() + BINDING_CODE_TTL_MS,
    };
    attempts.set(id, attempt);
    emit({ type: "binding-code", attemptId: attempt.id, contactId: id });
    return snapshot({ contactId: id });
  };

  const snapshot = async ({ contactId = "" } = {}) => {
    await ensureLoaded();
    expireAttempts();
    const id = clean(contactId);
    let binding = null;
    let attempt = null;
    if (id) {
      await scopeForContact(id);
      binding = findBindingForContact(id);
      attempt = attempts.get(id) || null;
    }
    return {
      bot: publicBot(),
      delivery: { ...publicStore.delivery },
      textSegmentation: publicStore.textSegmentation,
      linkedContacts: publicStore.bindings.length,
      contact: publicBinding(binding),
      pendingBinding: attempt ? {
        id: attempt.id,
        code: attempt.code,
        expiresAt: new Date(attempt.expiresAt).toISOString(),
      } : null,
    };
  };

  const configure = async (value = {}) => {
    await ensureLoaded();
    const input = plainObject(value);
    const current = botCredentials();
    const appId = normalizedAppId(input.appId ?? publicStore.bot.appId);
    const clientSecret = clean(input.clientSecret);
    if (!clientSecret && !current.clientSecret) throw new QQLinkError("请填写 QQ 机器人的 AppSecret。 ");
    if ((clientSecret || !current.clientSecret) && !safeStorage?.isEncryptionAvailable?.()) {
      throw new QQLinkError("当前系统无法加密保存 QQ AppSecret。 ");
    }
    const appChanged = publicStore.bot.appId && publicStore.bot.appId !== appId;
    stopGateway({ clearSession: true, status: "connecting" });
    publicStore.bot = { appId };
    if (clientSecret) credentialStore.encryptedClientSecret = safeStorage.encryptString(clientSecret).toString("base64");
    if (appChanged) {
      const removed = [...publicStore.bindings];
      publicStore.bindings = [];
      attempts.clear();
      deliveryChains.clear();
      replySequences.clear();
      for (const binding of removed) emit({ type: "disconnected", bindingId: binding.id, contactId: binding.contactId });
    }
    tokenCache = null;
    await persist();
    try { await ensureGateway(); }
    catch (error) {
      gatewayRuntime.lastError = clean(error?.message) || "QQ 机器人配置已保存，但暂时无法连接。 ";
      emit({ type: "gateway-error", message: gatewayRuntime.lastError });
    }
    emit({ type: "bot-configured" });
    return snapshot();
  };

  const saveSettings = async (value = {}) => {
    await ensureLoaded();
    const input = plainObject(value);
    if (input.delivery !== undefined) publicStore.delivery = normalizeDelivery(input.delivery);
    if (input.textSegmentation !== undefined) publicStore.textSegmentation = normalizeTextSegmentation(input.textSegmentation);
    await persist();
    emit({ type: "settings" });
    return snapshot();
  };

  const setContactEnabled = async ({ contactId, enabled } = {}) => {
    await ensureLoaded();
    const id = normalizedContactId(contactId);
    await scopeForContact(id);
    const binding = findBindingForContact(id);
    if (!binding) throw new QQLinkError("这位联系人还没有 QQ 连接。 ");
    binding.enabled = enabled === true;
    binding.updatedAt = nowIso(now);
    await persist();
    if (binding.enabled) void ensureGateway().catch((error) => setGatewayError(clean(error?.message) || "QQ 连接恢复失败。 "));
    emit({ type: "status", bindingId: binding.id, contactId: binding.contactId });
    return snapshot({ contactId: id });
  };

  const removeContact = async ({ contactId } = {}) => {
    await ensureLoaded();
    const id = normalizedContactId(contactId);
    attempts.delete(id);
    const bindings = publicStore.bindings.filter((binding) => binding.contactId === id);
    if (!bindings.length) return { removed: 0 };
    for (const binding of bindings) {
      deliveryChains.delete(binding.id);
      for (const key of replySequences.keys()) if (key.startsWith(`${binding.id}|`)) replySequences.delete(key);
    }
    publicStore.bindings = publicStore.bindings.filter((binding) => binding.contactId !== id);
    await persist();
    for (const binding of bindings) emit({ type: "disconnected", bindingId: binding.id, contactId: id });
    return { removed: bindings.length };
  };

  const disconnect = async ({ confirmed, contactId } = {}) => {
    if (confirmed !== true) throw new QQLinkError("断开 QQ 连接需要明确确认。 ");
    await ensureLoaded();
    const id = normalizedContactId(contactId);
    await scopeForContact(id);
    attempts.delete(id);
    const binding = findBindingForContact(id);
    if (!binding) return snapshot({ contactId: id });
    deliveryChains.delete(binding.id);
    for (const key of replySequences.keys()) if (key.startsWith(`${binding.id}|`)) replySequences.delete(key);
    publicStore.bindings = publicStore.bindings.filter((item) => item.id !== binding.id);
    await persist();
    emit({ type: "disconnected", bindingId: binding.id, contactId: binding.contactId });
    return snapshot({ contactId: id });
  };

  const start = async () => {
    await ensureLoaded();
    if (!botIsConfigured()) {
      gatewayRuntime.status = "not-configured";
      return snapshot();
    }
    try { await ensureGateway(); }
    catch (error) { setGatewayError(clean(error?.message) || "QQ 连接启动失败。 "); }
    return snapshot();
  };

  return {
    begin,
    configure,
    disconnect,
    removeContact,
    saveSettings,
    setContactEnabled,
    snapshot,
    start,
    subscribe: (listener) => {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      disposed = true;
      attempts.clear();
      deliveryChains.clear();
      replySequences.clear();
      stopGateway({ status: "stopped" });
      unsubscribeChat?.();
      listeners.clear();
    },
  };
}
