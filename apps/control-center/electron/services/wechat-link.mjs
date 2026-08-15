import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";

import { resolveAgentConversationDataRoot } from "@suzu-lives/agent-registry";
import { parseSuzuConversationCommand } from "../../shared/conversation-command.mjs";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const CHANNEL_VERSION = "suzu-lives-wechat/1.0";
const MAX_INBOUND_TEXT_LENGTH = 20_000;
const MAX_RECENT_MESSAGE_IDS = 160;
const MAX_WECHAT_TEXT_RUNES = 3800;
const POLL_BACKOFF_MAX_MS = 30_000;
export const MAX_WECHAT_AGENT_MEDIA_BYTES = 50 * 1024 * 1024;
export const MAX_WECHAT_INBOUND_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_WECHAT_INBOUND_MEDIA_ITEMS = 24;

export const DEFAULT_WECHAT_DELIVERY = Object.freeze({
  agent: true,
  attachments: false,
  permissions: true,
  tools: false,
  thinking: false,
  system: false,
  tokens: false,
});

export class WeChatLinkError extends Error {
  constructor(message) {
    super(message);
    this.name = "WeChatLinkError";
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function wechatPermissionDecision(value) {
  const text = clean(value);
  if (text === "允许") return "allow";
  if (text === "拒绝") return "deny";
  return "";
}

function permissionNotice(event = {}) {
  const toolName = clean(event.toolName) || "Claude Code 工具";
  const preview = clean(event.preview).slice(0, 1_200);
  return [
    `Claude Code 正在等待工具权限：${toolName}`,
    preview ? `操作摘要：${preview}` : "",
    "回复“允许”或“拒绝”处理。",
  ].filter(Boolean).join("\n");
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizedBaseUrl(value) {
  const source = clean(value) || DEFAULT_BASE_URL;
  let parsed;
  try { parsed = new URL(source); } catch { throw new WeChatLinkError("微信 iLink 地址无效。"); }
  if (!new Set(["https:", "http:"]).has(parsed.protocol)) throw new WeChatLinkError("微信 iLink 地址必须是 HTTP(S) 地址。");
  return parsed.toString().replace(/\/$/u, "");
}

function uploadUrlFromResponse(response, fileKey) {
  const fullUrl = clean(response?.upload_full_url ?? response?.uploadFullUrl);
  if (fullUrl) {
    try {
      const parsed = new URL(fullUrl);
      if (new Set(["https:", "http:"]).has(parsed.protocol)) return parsed.toString();
    } catch { /* Fall through to the legacy upload URL. */ }
    throw new WeChatLinkError("微信没有返回可用的媒体上传地址。 ");
  }
  const uploadParam = clean(response?.upload_param ?? response?.uploadParam);
  if (!uploadParam) throw new WeChatLinkError("微信没有返回媒体上传参数。 ");
  const url = new URL("upload", `${DEFAULT_CDN_BASE_URL}/`);
  url.searchParams.set("encrypted_query_param", uploadParam);
  url.searchParams.set("filekey", fileKey);
  return url.toString();
}

function encryptAes128Ecb(plaintext, key) {
  try {
    const cipher = createCipheriv("aes-128-ecb", key, null);
    cipher.setAutoPadding(true);
    return Buffer.concat([cipher.update(plaintext), cipher.final()]);
  } catch {
    throw new WeChatLinkError("无法加密微信媒体文件。 ");
  }
}

function decryptAes128Ecb(ciphertext, key) {
  try {
    const decipher = createDecipheriv("aes-128-ecb", key, null);
    decipher.setAutoPadding(true);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new WeChatLinkError("无法解密微信媒体文件。 ");
  }
}

function mediaAesKey(key) {
  return Buffer.from(key.toString("hex"), "utf8").toString("base64");
}

function fileNameForMedia(value) {
  const name = path.basename(clean(value)).replace(/[\r\n]/gu, "").slice(0, 300);
  return name || "attachment.bin";
}

function inboundItems(message = {}) {
  const items = message.item_list ?? message.itemList;
  return Array.isArray(items) ? items : [];
}

function cdnMedia(value) {
  return plainObject(value?.media ?? value?.Media);
}

function mediaEncryptQuery(value) {
  return clean(value?.encrypt_query_param ?? value?.encryptQueryParam);
}

function decodeMediaAesKey(value) {
  const source = clean(value);
  if (!source) return null;
  const decoded = Buffer.from(source, "base64");
  if (decoded.length === 16) return decoded;
  const hex = decoded.toString("utf8");
  if (decoded.length === 32 && /^[0-9a-f]{32}$/iu.test(hex)) return Buffer.from(hex, "hex");
  return null;
}

function imageAesKey(value) {
  const image = plainObject(value);
  const hex = clean(image.aeskey ?? image.aesKeyHex);
  if (/^[0-9a-f]{32}$/iu.test(hex)) return Buffer.from(hex, "hex");
  const media = cdnMedia(image);
  return decodeMediaAesKey(media.aes_key ?? media.aesKey);
}

function detectImageMime(data) {
  const value = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  if (value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) return "image/jpeg";
  if (value.length >= 8 && value.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (value.length >= 6 && ["GIF87a", "GIF89a"].includes(value.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (value.length >= 12 && value.subarray(0, 4).toString("ascii") === "RIFF" && value.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "image/jpeg";
}

function imageExtension(mimeType) {
  return {
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
  }[mimeType] || ".jpg";
}

function inboundCdnUrl(encryptedQueryParam) {
  const url = new URL("download", `${DEFAULT_CDN_BASE_URL}/`);
  url.searchParams.set("encrypted_query_param", encryptedQueryParam);
  return url;
}

function normalizedSessionId(value) {
  const id = clean(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) throw new WeChatLinkError("Claude 会话标识无效。");
  return id;
}

function normalizedContactId(value) {
  const id = clean(value);
  if (!/^contact-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) throw new WeChatLinkError("联系人标识无效。");
  return id;
}

function normalizeDelivery(value = {}) {
  const input = plainObject(value);
  return Object.fromEntries(Object.entries(DEFAULT_WECHAT_DELIVERY).map(([key, fallback]) => [key, input[key] === undefined ? fallback : input[key] === true]));
}

function emptyPublicStore() {
  return { version: 1, enabled: true, delivery: { ...DEFAULT_WECHAT_DELIVERY }, links: [] };
}

function normalizePublicLink(value = {}) {
  const raw = plainObject(value);
  const id = clean(raw.id);
  const contactId = clean(raw.contactId);
  if (!id || !contactId) return null;
  try {
    return {
      id,
      contactId: normalizedContactId(contactId),
      accountId: clean(raw.accountId).slice(0, 300),
      linkedUserId: clean(raw.linkedUserId).slice(0, 300),
      baseUrl: normalizedBaseUrl(raw.baseUrl),
      enabled: raw.enabled !== false,
      cursor: clean(raw.cursor).slice(0, 80_000),
      recentMessageIds: Array.isArray(raw.recentMessageIds)
        ? [...new Set(raw.recentMessageIds.map((item) => clean(item).slice(0, 600)).filter(Boolean))].slice(-MAX_RECENT_MESSAGE_IDS)
        : [],
      createdAt: clean(raw.createdAt),
      updatedAt: clean(raw.updatedAt),
      lastError: clean(raw.lastError).slice(0, 500),
      lastReceivedAt: clean(raw.lastReceivedAt),
      lastSentAt: clean(raw.lastSentAt),
    };
  } catch {
    return null;
  }
}

function normalizePublicStore(value) {
  const raw = plainObject(value);
  return {
    version: 1,
    enabled: raw.enabled !== false,
    delivery: normalizeDelivery(raw.delivery),
    links: (Array.isArray(raw.links) ? raw.links : []).map(normalizePublicLink).filter(Boolean).slice(0, 80),
  };
}

function emptyCredentialStore() {
  return { version: 1, links: {} };
}

function normalizeCredentialStore(value) {
  const raw = plainObject(value);
  const links = {};
  for (const [id, credential] of Object.entries(plainObject(raw.links)).slice(0, 80)) {
    const key = clean(id);
    if (!key) continue;
      const candidate = plainObject(credential);
      links[key] = {
        token: clean(candidate.token).slice(0, 20_000),
        contextToken: clean(candidate.contextToken).slice(0, 80_000),
    };
  }
  return { version: 1, links };
}

function nowIso(now = () => new Date()) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function mask(value) {
  const text = clean(value);
  if (!text) return "";
  return text.length <= 8 ? "••••" : `••••${text.slice(-4)}`;
}

function messageKey(message = {}) {
  return [
    clean(message.from_user_id ?? message.fromUserId),
    clean(message.message_id ?? message.messageId),
    clean(message.seq),
    clean(message.create_time_ms ?? message.createTimeMs),
    clean(message.client_id ?? message.clientId),
  ].join("|");
}

function inboundText(message = {}) {
  const text = inboundItems(message)
    .map((item) => {
      if (Number(item?.type) === 1 || item?.text_item || item?.textItem) {
        return clean(item?.text_item?.text ?? item?.textItem?.text);
      }
      if (Number(item?.type) === 3 || item?.voice_item || item?.voiceItem) {
        return clean(item?.voice_item?.text ?? item?.voiceItem?.text);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
  return text.length > MAX_INBOUND_TEXT_LENGTH ? text.slice(0, MAX_INBOUND_TEXT_LENGTH) : text;
}

function isBotMessage(message = {}) {
  return Number(message.message_type ?? message.messageType) === 2;
}

function uin() {
  const number = Math.floor(Math.random() * 0x1_0000_0000);
  return Buffer.from(String(number)).toString("base64");
}

function chunks(value, maximum = MAX_WECHAT_TEXT_RUNES) {
  const characters = Array.from(String(value ?? ""));
  const result = [];
  for (let index = 0; index < characters.length; index += maximum) result.push(characters.slice(index, index + maximum).join(""));
  return result;
}

/** Split on blank lines before enforcing the remote text-size limit. */
export function splitWechatText(value) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  const paragraphs = text.split(/\r?\n[\t ]*\r?\n+/u).map((item) => item.trim()).filter(Boolean);
  return paragraphs.flatMap((paragraph) => chunks(paragraph));
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

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener?.("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

async function responseJson(response, label) {
  if (!response?.ok) {
    let text = "";
    try { text = await response.text(); } catch { /* Keep the HTTP status even when no body is readable. */ }
    throw new WeChatLinkError(`微信 ${label} 请求失败（HTTP ${response?.status ?? "未知"}）：${String(text || "").slice(0, 240)}`);
  }
  try { return await response.json(); }
  catch { throw new WeChatLinkError(`微信 ${label} 返回了无效数据。`); }
}

function endpoint(baseUrl, pathname, query = null) {
  const url = new URL(pathname.replace(/^\/+/, ""), `${normalizedBaseUrl(baseUrl)}/`);
  if (query) for (const [key, value] of Object.entries(query)) if (clean(value)) url.searchParams.set(key, clean(value));
  return url;
}

async function qrImageDataUrl(value) {
  const source = clean(value);
  if (!source) throw new WeChatLinkError("微信没有返回二维码内容，请重试。");
  try {
    return await QRCode.toDataURL(source, {
      errorCorrectionLevel: "M",
      margin: 2,
      type: "image/png",
      width: 420,
    });
  } catch {
    throw new WeChatLinkError("微信二维码生成失败，请重新生成。");
  }
}

export function createWeChatLinkService({
  chat,
  dataRoot,
  fetchImpl = globalThis.fetch,
  fsOps = fs,
  now = () => new Date(),
  reader,
  sleepImpl = sleep,
} = {}) {
  if (!chat?.sendToSession || !chat?.steer || !chat?.stop || !chat?.subscribe) throw new WeChatLinkError("微信连接需要本机 Claude 会话服务。");
  if (!reader?.resolveContactSession || !reader?.contactIdForSession) throw new WeChatLinkError("微信连接需要联系人会话读取服务。");
  if (!clean(dataRoot) || !path.isAbsolute(clean(dataRoot))) throw new WeChatLinkError("无法定位 Suzu Lives 软件数据目录。");
  if (typeof fetchImpl !== "function") throw new WeChatLinkError("当前运行环境无法访问微信 iLink 服务。");

  const root = path.join(path.resolve(dataRoot), "wechat-link");
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
  const loops = new Map();
  const removedContactIds = new Set();

  const emit = (event) => {
    const payload = { ...event, timestamp: event?.timestamp || nowIso(now) };
    for (const listener of listeners) {
      try { listener(payload); } catch { /* UI observers never control the connector. */ }
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

  const publicLink = (link) => link ? {
    id: link.id,
    contactId: link.contactId,
    accountId: mask(link.accountId),
    linkedUserId: mask(link.linkedUserId),
    enabled: link.enabled !== false,
    status: loops.has(link.id) ? "connected" : (link.lastError ? "attention" : "saved"),
    lastError: link.lastError || "",
    lastReceivedAt: link.lastReceivedAt || "",
    lastSentAt: link.lastSentAt || "",
    createdAt: link.createdAt || "",
  } : null;

  const findLinkForContact = (contactId) => publicStore.links.find((link) => link.contactId === clean(contactId)) || null;
  const findLinkById = (id) => publicStore.links.find((link) => link.id === id) || null;
  const scopeForContact = async (contactId) => reader.resolveContactSession(normalizedContactId(contactId));

  const credentialsFor = (linkId) => {
    const raw = plainObject(credentialStore.links[linkId]);
    return {
      token: clean(raw.token),
      contextToken: clean(raw.contextToken),
    };
  };

  const saveCredentials = (linkId, { token, contextToken } = {}) => {
    const current = plainObject(credentialStore.links[linkId]);
    credentialStore.links[linkId] = {
      token: (token === undefined ? clean(current.token) : clean(token)).slice(0, 20_000),
      contextToken: (contextToken === undefined ? clean(current.contextToken) : clean(contextToken)).slice(0, 80_000),
    };
  };

  const apiGet = async (baseUrl, pathname, query, { headers = {}, signal } = {}) => {
    const response = await fetchImpl(endpoint(baseUrl, pathname, query), { method: "GET", headers, signal });
    return responseJson(response, pathname);
  };

  const apiPost = async (link, pathname, body, { signal } = {}) => {
    const { token } = credentialsFor(link.id);
    if (!token) throw new WeChatLinkError("微信连接凭证不可用，请重新扫码绑定。 ");
    const response = await fetchImpl(endpoint(link.baseUrl, pathname), {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        Authorization: `Bearer ${token}`,
        "X-WECHAT-UIN": uin(),
      },
      body: JSON.stringify(body),
    });
    return responseJson(response, pathname);
  };

  const downloadInboundMedia = async (encryptedQueryParam, aesKey, { signal } = {}) => {
    const response = await fetchImpl(inboundCdnUrl(encryptedQueryParam), { method: "GET", signal });
    if (!response?.ok) {
      let text = "";
      try { text = await response.text(); } catch { /* Preserve the HTTP status when the body cannot be read. */ }
      throw new WeChatLinkError(`微信媒体下载失败（HTTP ${response?.status ?? "未知"}）：${clean(text).slice(0, 240)}`);
    }
    const downloaded = Buffer.from(await response.arrayBuffer());
    if (!downloaded.length) throw new WeChatLinkError("微信返回的媒体文件为空。 ");
    if (downloaded.length > MAX_WECHAT_INBOUND_MEDIA_BYTES) {
      throw new WeChatLinkError(`微信媒体文件超过 ${MAX_WECHAT_INBOUND_MEDIA_BYTES >> 20} MiB 上限。`);
    }
    const data = aesKey ? decryptAes128Ecb(downloaded, aesKey) : downloaded;
    if (!data.length) throw new WeChatLinkError("微信解密后的媒体文件为空。 ");
    if (data.length > MAX_WECHAT_INBOUND_MEDIA_BYTES) {
      throw new WeChatLinkError(`微信媒体文件超过 ${MAX_WECHAT_INBOUND_MEDIA_BYTES >> 20} MiB 上限。`);
    }
    return data;
  };

  const fetchQRCode = async (baseUrl, signal) => {
    const response = await apiGet(baseUrl, "ilink/bot/get_bot_qrcode", { bot_type: "3" }, { signal });
    const qrKey = clean(response?.qrcode);
    const qrContent = clean(response?.qrcode_img_content);
    if (!qrKey || !qrContent) throw new WeChatLinkError("微信没有返回可用二维码，请重试。 ");
    return { qrKey, qrContent, qrImageDataUrl: await qrImageDataUrl(qrContent) };
  };

  const pollQRCode = async (baseUrl, qrKey, signal) => apiGet(baseUrl, "ilink/bot/get_qrcode_status", { qrcode: qrKey }, {
    signal,
    headers: { "iLink-App-ClientVersion": "1" },
  });

  const sendMessageItem = async (link, item, { contextToken = "", signal } = {}) => {
    const token = clean(contextToken) || credentialsFor(link.id).contextToken;
    if (!token) throw new WeChatLinkError("微信会话尚未准备好，请先从已绑定的微信发一条消息。 ");
    const request = (activeToken) => apiPost(link, "ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: link.linkedUserId,
        client_id: `suzu-${randomUUID()}`,
        message_type: 2,
        message_state: 2,
        item_list: [item],
        context_token: activeToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    }, { signal });
    let response = await request(token);
    if (Number(response?.ret) === -2) {
      const refreshedToken = credentialsFor(link.id).contextToken;
      if (!refreshedToken || refreshedToken === token) {
        throw new WeChatLinkError("微信上下文已过期，请先从微信再发送一条消息。 ");
      }
      response = await request(refreshedToken);
    }
    if (Number(response?.ret ?? 0) !== 0) {
      if (Number(response?.ret) === -2) throw new WeChatLinkError("微信上下文已过期，请先从微信再发送一条消息。 ");
      throw new WeChatLinkError(`微信消息发送失败：${clean(response?.errmsg) || `ret=${response?.ret}`}`);
    }
    link.lastSentAt = nowIso(now);
    link.lastError = "";
    await persist();
  };

  const sendText = async (link, text, options = {}) => {
    const content = clean(text);
    if (!content) return;
    return sendMessageItem(link, { type: 1, text_item: { text: content } }, options);
  };

  const uploadMedia = async (link, data, mediaType, { signal } = {}) => {
    const content = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
    if (!content.length) throw new WeChatLinkError("要发送的文件为空。 ");
    if (content.length > MAX_WECHAT_AGENT_MEDIA_BYTES) {
      throw new WeChatLinkError(`要发送的文件超过 ${MAX_WECHAT_AGENT_MEDIA_BYTES >> 20} MiB 上限。`);
    }
    const aesKey = randomBytes(16);
    const fileKey = randomBytes(16).toString("hex");
    const encrypted = encryptAes128Ecb(content, aesKey);
    const upload = await apiPost(link, "ilink/bot/getuploadurl", {
      filekey: fileKey,
      media_type: mediaType,
      to_user_id: link.linkedUserId,
      rawsize: content.length,
      rawfilemd5: createHash("md5").update(content).digest("hex"),
      filesize: encrypted.length,
      no_need_thumb: true,
      aeskey: aesKey.toString("hex"),
      base_info: { channel_version: CHANNEL_VERSION },
    }, { signal });
    if (Number(upload?.ret ?? 0) !== 0) {
      throw new WeChatLinkError(`微信没有接受媒体上传请求：${clean(upload?.errmsg) || `ret=${upload?.ret}`}`);
    }
    const target = uploadUrlFromResponse(upload, fileKey);
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetchImpl(target, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/octet-stream" },
          body: encrypted,
        });
        const status = Number(response?.status ?? 0);
        if (response?.ok === false || (status && (status < 200 || status >= 300))) {
          let body = "";
          try { body = typeof response?.text === "function" ? await response.text() : ""; } catch { /* The status is still useful. */ }
          const detail = clean(body);
          throw new WeChatLinkError(`微信媒体上传失败（HTTP ${status || "未知"}）：${detail.slice(0, 180)}`);
        }
        const encryptedQueryParam = clean(response?.headers?.get?.("x-encrypted-param"));
        if (!encryptedQueryParam) throw new WeChatLinkError("微信媒体上传完成后没有返回下载参数。 ");
        return {
          aesKey,
          encryptedQueryParam,
          rawSize: content.length,
          cipherSize: encrypted.length,
        };
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError instanceof WeChatLinkError) throw lastError;
    throw new WeChatLinkError(`微信媒体上传失败：${clean(lastError?.message) || "网络错误。"}`);
  };

  const sendMedia = async (link, media, options = {}) => {
    const source = plainObject(media);
    const kind = clean(source.kind).toLowerCase();
    const fileName = fileNameForMedia(source.fileName);
    const uploaded = await uploadMedia(link, source.data, kind === "image" ? 1 : 3, options);
    const cdnMedia = {
      encrypt_query_param: uploaded.encryptedQueryParam,
      aes_key: mediaAesKey(uploaded.aesKey),
      encrypt_type: 1,
    };
    const item = kind === "image"
      ? { type: 2, image_item: { media: cdnMedia, mid_size: uploaded.cipherSize } }
      : { type: 4, file_item: { media: cdnMedia, file_name: fileName, len: String(uploaded.rawSize) } };
    await sendMessageItem(link, item, options);
    return { kind, fileName, size: uploaded.rawSize };
  };

  const inboundMediaDirectory = (session, key) => path.join(
    resolveAgentConversationDataRoot({
      dataRoot,
      projectRoot: clean(session?.projectRoot),
      sessionId: normalizedSessionId(session?.id),
    }),
    "inbound",
    createHash("sha256").update(key).digest("hex").slice(0, 32),
  );

  const cacheInboundMedia = async (session, key, index, { kind, data, fileName, mimeType }) => {
    const content = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
    if (!content.length) throw new WeChatLinkError("微信媒体文件为空。 ");
    const directory = inboundMediaDirectory(session, key);
    const prefix = `${String(index + 1).padStart(2, "0")}-`;
    const savedName = kind === "image"
      ? `${prefix}wechat-image${imageExtension(mimeType)}`
      : `${prefix}${fileNameForMedia(fileName)}`;
    const target = path.join(directory, savedName);
    await fsOps.mkdir(directory, { recursive: true });
    await fsOps.writeFile(target, content);
    return {
      kind,
      path: target,
      fileName: savedName.slice(prefix.length),
      mimeType: kind === "image" ? mimeType : "application/octet-stream",
      size: content.length,
      data: content,
    };
  };

  const collectInboundMedia = async (session, message, key, { signal } = {}) => {
    const result = [];
    for (const item of inboundItems(message)) {
      if (result.length >= MAX_WECHAT_INBOUND_MEDIA_ITEMS) break;
      const type = Number(item?.type);
      let kind = "";
      let media = {};
      let aesKey = null;
      let fileName = "";
      if (type === 2 || item?.image_item || item?.imageItem) {
        const image = plainObject(item?.image_item ?? item?.imageItem);
        kind = "image";
        media = cdnMedia(image);
        aesKey = imageAesKey(image);
      } else if (type === 4 || item?.file_item || item?.fileItem) {
        const file = plainObject(item?.file_item ?? item?.fileItem);
        kind = "file";
        media = cdnMedia(file);
        aesKey = decodeMediaAesKey(media.aes_key ?? media.aesKey);
        fileName = clean(file.file_name ?? file.fileName);
        if (!aesKey) continue;
      } else {
        continue;
      }
      const encryptedQueryParam = mediaEncryptQuery(media);
      if (!encryptedQueryParam) continue;
      try {
        const data = await downloadInboundMedia(encryptedQueryParam, aesKey, { signal });
        const mimeType = kind === "image" ? detectImageMime(data) : "application/octet-stream";
        result.push(await cacheInboundMedia(session, key, result.length, {
          kind,
          data,
          fileName,
          mimeType,
        }));
      } catch {
        // A bad attachment must not prevent the text parts of the same WeChat message from arriving.
      }
    }
    return result;
  };

  const readAgentMedia = async (entry) => {
    const source = plainObject(entry);
    const kind = clean(source.kind).toLowerCase();
    const sourcePath = clean(source.path);
    if (!new Set(["image", "audio", "file"]).has(kind) || !sourcePath || !path.isAbsolute(sourcePath)) {
      throw new WeChatLinkError("Agent 返回的本地附件无效。 ");
    }
    const resolved = path.resolve(sourcePath);
    let stat;
    try { stat = await fsOps.stat(resolved); }
    catch { throw new WeChatLinkError(`找不到 Agent 要投递的文件：${resolved}`); }
    if (!stat.isFile()) throw new WeChatLinkError(`Agent 要投递的路径不是普通文件：${resolved}`);
    if (stat.size <= 0) throw new WeChatLinkError(`Agent 要投递的文件为空：${resolved}`);
    if (stat.size > MAX_WECHAT_AGENT_MEDIA_BYTES) {
      throw new WeChatLinkError(`Agent 要投递的文件超过 ${MAX_WECHAT_AGENT_MEDIA_BYTES >> 20} MiB：${resolved}`);
    }
    let data;
    try { data = await fsOps.readFile(resolved); }
    catch { throw new WeChatLinkError(`无法读取 Agent 要投递的文件：${resolved}`); }
    return { kind, data, fileName: path.basename(resolved) };
  };

  const deliverText = async (link, text, options = {}) => {
    for (const segment of splitWechatText(text)) await sendText(link, segment, options);
  };

  const queueTask = (link, task) => {
    const previous = deliveryChains.get(link.id) || Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    deliveryChains.set(link.id, next);
    next.then(
      () => { if (deliveryChains.get(link.id) === next) deliveryChains.delete(link.id); },
      () => { if (deliveryChains.get(link.id) === next) deliveryChains.delete(link.id); },
    );
    return next;
  };

  const queueDelivery = (link, text, options = {}) => queueTask(link, () => deliverText(link, text, options));

  const commandResponse = async (link, message, contextToken) => {
    try { await queueDelivery(link, message, { contextToken }); }
    catch (error) {
      link.lastError = clean(error?.message) || "无法回传微信命令结果。";
      await persist();
      emit({ type: "error", linkId: link.id, contactId: link.contactId, message: link.lastError });
    }
  };

  const runInbound = async (link, message) => {
    if (isBotMessage(message)) return;
    const from = clean(message?.from_user_id ?? message?.fromUserId);
    if (!from || from !== link.linkedUserId) return;
    const key = messageKey(message);
    if (!key || link.recentMessageIds.includes(key)) return;
    const text = inboundText(message);
    const contextToken = clean(message?.context_token ?? message?.contextToken);
    if (contextToken) saveCredentials(link.id, { contextToken });
    const command = parseSuzuConversationCommand(text);
    try {
      const session = await scopeForContact(link.contactId);
      const media = await collectInboundMedia(session, message, key);
      if (!text && !media.length) return;
      const permissionDecision = media.length === 0 && publicStore.delivery.permissions === true
        ? wechatPermissionDecision(text)
        : "";
      if (permissionDecision && typeof chat.respondPermissionForSession === "function") {
        const result = chat.respondPermissionForSession({
          behavior: permissionDecision,
          sessionId: session.id,
          projectRoot: session.projectRoot,
        });
        if (result?.accepted) {
          const action = result.behavior === "allow" ? "已允许" : "已拒绝";
          await commandResponse(link, `${action}工具权限：${clean(result.toolName) || "Claude Code 工具"}。`, contextToken);
        } else if (result?.reason === "multiple-pending-permissions") {
          await commandResponse(link, "当前有多条等待确认的工具请求，请回到桌面端分别处理。", contextToken);
        } else {
          await commandResponse(link, "当前没有等待确认的工具请求。", contextToken);
        }
      } else if (command.action === "notice") {
        await commandResponse(link, command.message, contextToken);
      } else if (command.action === "stop") {
        const result = chat.stop({ sessionId: session.id, projectRoot: session.projectRoot });
        await commandResponse(link, clean(result?.message) || "正在停止当前 Claude Code 任务。", contextToken);
      } else if (command.action === "steer") {
        const result = await chat.steer({
          content: command.content,
          sessionId: session.id,
          projectRoot: session.projectRoot,
          hasTranscript: session.hasTranscript === true,
        });
        await commandResponse(link, clean(result?.message) || "引导已送达。", contextToken);
      } else {
        const request = {
          content: command.content,
          sessionId: session.id,
          projectRoot: session.projectRoot,
          hasTranscript: session.hasTranscript === true,
          kind: "message",
        };
        if (media.length) request.media = media;
        await chat.sendToSession(request);
      }
      link.recentMessageIds = [...link.recentMessageIds, key].slice(-MAX_RECENT_MESSAGE_IDS);
      link.lastReceivedAt = nowIso(now);
      link.lastError = "";
      await persist();
      emit({ type: "received", linkId: link.id, contactId: link.contactId });
    } catch (error) {
      const messageText = clean(error?.message) || "无法处理这条微信消息。";
      link.lastError = messageText;
      await persist();
      await commandResponse(link, `这条消息没有送达：${messageText}`, contextToken);
      emit({ type: "error", linkId: link.id, contactId: link.contactId, message: messageText });
    }
  };

  const startLoop = (linkId) => {
    if (disposed || loops.has(linkId)) return;
    const controller = new AbortController();
    loops.set(linkId, controller);
    void (async () => {
      let backoff = 1_000;
      try {
        while (!disposed && !controller.signal.aborted) {
          await ensureLoaded();
          const link = findLinkById(linkId);
          if (!publicStore.enabled || !link || link.enabled === false) break;
          try {
            const response = await apiPost(link, "ilink/bot/getupdates", {
              get_updates_buf: link.cursor || "",
              base_info: { channel_version: CHANNEL_VERSION },
            }, { signal: controller.signal });
            if (Number(response?.errcode) === -14) {
              link.lastError = "微信连接已过期，请在这位联系人的设置中重新扫码。";
              await persist();
              emit({ type: "expired", linkId: link.id, contactId: link.contactId, message: link.lastError });
              break;
            }
            for (const message of Array.isArray(response?.msgs) ? response.msgs : []) await runInbound(link, message);
            const nextCursor = clean(response?.get_updates_buf);
            if (nextCursor && nextCursor !== link.cursor) {
              link.cursor = nextCursor;
              await persist();
            }
            backoff = 1_000;
          } catch (error) {
            if (controller.signal.aborted) break;
            link.lastError = clean(error?.message) || "微信消息接收失败。";
            await persist();
            emit({ type: "error", linkId: link.id, contactId: link.contactId, message: link.lastError });
            await sleepImpl(backoff, controller.signal);
            backoff = Math.min(POLL_BACKOFF_MAX_MS, backoff * 2);
          }
        }
      } finally {
        if (loops.get(linkId) === controller) loops.delete(linkId);
        emit({ type: "status", linkId, contactId: findLinkById(linkId)?.contactId || "" });
      }
    })();
  };

  const startStoredLoops = async () => {
    await ensureLoaded();
    if (!publicStore.enabled || disposed) return;
    for (const link of publicStore.links) if (link.enabled !== false) startLoop(link.id);
  };

  const stopLoops = () => {
    for (const controller of loops.values()) controller.abort();
    loops.clear();
  };

  const completeAttempt = async (attempt, status) => {
    if (removedContactIds.has(attempt.contactId)) {
      attempts.delete(attempt.id);
      return;
    }
    const token = clean(status?.bot_token ?? status?.botToken);
    const accountId = clean(status?.ilink_bot_id ?? status?.ilinkBotId);
    const linkedUserId = clean(status?.ilink_user_id ?? status?.ilinkUserId);
    if (!token || !accountId || !linkedUserId) throw new WeChatLinkError("微信扫码确认未返回完整绑定信息，请重新生成二维码。 ");
    const baseUrl = normalizedBaseUrl(status?.baseurl ?? status?.base_url ?? status?.baseUrl ?? attempt.baseUrl);
    const link = {
      id: randomUUID(),
      contactId: attempt.contactId,
      accountId,
      linkedUserId,
      baseUrl,
      enabled: true,
      cursor: "",
      recentMessageIds: [],
      createdAt: nowIso(now),
      updatedAt: nowIso(now),
      lastError: "",
      lastReceivedAt: "",
      lastSentAt: "",
    };
    const priorLinks = publicStore.links.filter((item) => item.contactId === attempt.contactId);
    for (const prior of priorLinks) {
      loops.get(prior.id)?.abort();
      delete credentialStore.links[prior.id];
    }
    publicStore.links = publicStore.links.filter((item) => item.contactId !== attempt.contactId);
    publicStore.links.push(link);
    saveCredentials(link.id, { token, contextToken: "" });
    await persist();
    if (publicStore.enabled) startLoop(link.id);
    attempts.delete(attempt.id);
    emit({ type: "connected", linkId: link.id, contactId: link.contactId });
  };

  const runAttempt = async (attempt) => {
    try {
      while (!disposed && !attempt.controller.signal.aborted && Date.now() < attempt.expiresAt) {
        const status = await pollQRCode(attempt.baseUrl, attempt.qrKey, attempt.controller.signal);
        const state = clean(status?.status).toLowerCase();
        if (state === "confirmed") {
          await completeAttempt(attempt, status);
          return;
        }
        if (state === "expired") {
          const next = await fetchQRCode(attempt.baseUrl, attempt.controller.signal);
          attempt.qrKey = next.qrKey;
          attempt.qrImageDataUrl = next.qrImageDataUrl;
          attempt.status = "waiting";
          emit({ type: "qr", attemptId: attempt.id, contactId: attempt.contactId });
        } else {
          const nextStatus = ["scaned", "scanned"].includes(state) ? "scanned" : "waiting";
          if (nextStatus !== attempt.status) {
            attempt.status = nextStatus;
            emit({ type: "qr", attemptId: attempt.id, contactId: attempt.contactId });
          }
        }
        await sleepImpl(1_000, attempt.controller.signal);
      }
      if (!disposed && !attempt.controller.signal.aborted) {
        attempt.status = "expired";
        attempt.error = "等待微信扫码超时，请重新生成二维码。";
        emit({ type: "qr", attemptId: attempt.id, contactId: attempt.contactId });
      }
    } catch (error) {
      if (!attempt.controller.signal.aborted) {
        attempt.status = "error";
        attempt.error = clean(error?.message) || "微信二维码状态读取失败。";
        emit({ type: "qr", attemptId: attempt.id, contactId: attempt.contactId });
      }
    }
  };

  const begin = async ({ contactId } = {}) => {
    await ensureLoaded();
    if (publicStore.enabled !== true) throw new WeChatLinkError("请先在“能力 → 行动”中开启“连接微信”。 ");
    const id = normalizedContactId(contactId);
    removedContactIds.delete(id);
    const session = await scopeForContact(id);
    const oldAttempt = [...attempts.values()].find((item) => item.contactId === id);
    if (oldAttempt) oldAttempt.controller.abort();
    const controller = new AbortController();
    const initial = await fetchQRCode(DEFAULT_BASE_URL, controller.signal);
    const attempt = {
      id: randomUUID(),
      contactId: id,
      sessionId: session.id,
      projectRoot: session.projectRoot,
      baseUrl: DEFAULT_BASE_URL,
      qrKey: initial.qrKey,
      qrImageDataUrl: initial.qrImageDataUrl,
      status: "waiting",
      error: "",
      expiresAt: Date.now() + 8 * 60 * 1_000,
      controller,
    };
    attempts.set(attempt.id, attempt);
    void runAttempt(attempt);
    emit({ type: "qr", attemptId: attempt.id, contactId: id });
    return snapshot({ contactId: id });
  };

  const snapshot = async ({ contactId = "" } = {}) => {
    await ensureLoaded();
    const id = clean(contactId);
    let link = null;
    let attempt = null;
    if (id) {
      await scopeForContact(id);
      link = findLinkForContact(id);
      attempt = [...attempts.values()].find((item) => item.contactId === id) || null;
    }
    return {
      enabled: publicStore.enabled === true,
      delivery: { ...publicStore.delivery },
      linkedContacts: publicStore.links.length,
      contact: publicLink(link),
      pendingQr: attempt ? {
        id: attempt.id,
        status: attempt.status,
        imageDataUrl: attempt.qrImageDataUrl || "",
        error: attempt.error || "",
      } : null,
    };
  };

  const saveSettings = async ({ enabled, delivery } = {}) => {
    await ensureLoaded();
    if (enabled !== undefined) publicStore.enabled = enabled === true;
    if (delivery !== undefined) publicStore.delivery = normalizeDelivery(delivery);
    await persist();
    if (publicStore.enabled) await startStoredLoops();
    else stopLoops();
    emit({ type: "settings" });
    return snapshot();
  };

  const setContactEnabled = async ({ contactId, enabled } = {}) => {
    await ensureLoaded();
    const id = normalizedContactId(contactId);
    await scopeForContact(id);
    const link = findLinkForContact(id);
    if (!link) throw new WeChatLinkError("这位联系人还没有微信连接。 ");
    link.enabled = enabled === true;
    link.updatedAt = nowIso(now);
    await persist();
    if (link.enabled && publicStore.enabled) startLoop(link.id);
    else loops.get(link.id)?.abort();
    emit({ type: "status", linkId: link.id, contactId: link.contactId });
    return snapshot({ contactId: id });
  };

  const removeContact = async ({ contactId } = {}) => {
    await ensureLoaded();
    const id = normalizedContactId(contactId);
    removedContactIds.add(id);
    for (const [attemptId, attempt] of attempts) {
      if (attempt.contactId !== id) continue;
      attempt.controller.abort();
      attempts.delete(attemptId);
    }
    const links = publicStore.links.filter((link) => link.contactId === id);
    for (const link of links) {
      loops.get(link.id)?.abort();
      loops.delete(link.id);
      deliveryChains.delete(link.id);
      delete credentialStore.links[link.id];
    }
    if (!links.length) return { removed: 0 };
    publicStore.links = publicStore.links.filter((link) => link.contactId !== id);
    await persist();
    for (const link of links) emit({ type: "disconnected", linkId: link.id, contactId: id });
    return { removed: links.length };
  };

  const disconnect = async ({ confirmed, contactId } = {}) => {
    if (confirmed !== true) throw new WeChatLinkError("断开微信连接需要明确确认。 ");
    await ensureLoaded();
    const id = normalizedContactId(contactId);
    await scopeForContact(id);
    const link = findLinkForContact(id);
    if (!link) return snapshot({ contactId: id });
    loops.get(link.id)?.abort();
    publicStore.links = publicStore.links.filter((item) => item.id !== link.id);
    delete credentialStore.links[link.id];
    await persist();
    emit({ type: "disconnected", linkId: link.id, contactId: link.contactId });
    return snapshot({ contactId: id });
  };

  const handleChatEvent = (event) => {
    if (disposed || !event?.sessionId) return;
    // A schedule marker is a local conversation-system event.  Its final
    // Agent reply may still be delivered normally, but task state, tool
    // details, errors, and usage must never become a WeChat notification.
    if (event.kind === "schedule" && !["agent-reply", "agent-media"].includes(event.type)) return;
    const projectRoot = clean(event.projectRoot);
    if (!projectRoot) return;
    void (async () => {
      const contactId = await reader.contactIdForSession({ sessionId: event.sessionId, projectRoot });
      if (!contactId || !publicStore.enabled) return;
      const links = publicStore.links.filter((link) => link.contactId === contactId && link.enabled !== false);
      if (!links.length) return;
      if (event.type === "agent-media") {
        const media = Array.isArray(event.media) ? event.media : [];
        if (!media.length) return;
        for (const link of links) {
          void queueTask(link, async () => {
            for (const entry of media) await sendMedia(link, await readAgentMedia(entry));
          }).catch(async (error) => {
            link.lastError = clean(error?.message) || "微信文件发送失败。";
            await persist().catch(() => undefined);
            emit({ type: "error", linkId: link.id, contactId: link.contactId, message: link.lastError });
          });
        }
        return;
      }
      for (const link of links) {
        let content = "";
        let allowed = false;
        if (event.type === "agent-reply") {
          allowed = publicStore.delivery.agent === true;
          content = clean(event.content);
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
        void queueDelivery(link, content).catch(async (error) => {
          link.lastError = clean(error?.message) || "微信消息发送失败。";
          await persist().catch(() => undefined);
          emit({ type: "error", linkId: link.id, contactId: link.contactId, message: link.lastError });
        });
      }
    })().catch(() => undefined);
  };

  const unsubscribeChat = chat.subscribe(handleChatEvent);

  return {
    begin,
    disconnect,
    removeContact,
    dispose: () => {
      disposed = true;
      for (const attempt of attempts.values()) attempt.controller.abort();
      attempts.clear();
      stopLoops();
      unsubscribeChat?.();
      listeners.clear();
    },
    saveSettings,
    setContactEnabled,
    snapshot,
    start: startStoredLoops,
    subscribe: (listener) => {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
