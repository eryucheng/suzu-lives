import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveAgentConversationDataRoot } from "@suzu-lives/agent-registry";

const MAX_CONVERSATION_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_CONVERSATION_ATTACHMENT_ITEMS = 24;
// These are Agent Core's current local attachment-store defaults.  Keep the product
// boundary aligned with the actual host contract, rather than letting a large
// image get copied and then rejected only after a chat turn has started.
const MAX_AGENT_CORE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AGENT_CORE_IMAGES_PER_MESSAGE = 20;
const CONVERSATION_ATTACHMENT_RECEIPT = "suzu-conversation-attachment";
const MEDIA_MANIFEST_OPEN = "<conversation-media>";
const MEDIA_MANIFEST_CLOSE = "</conversation-media>";
const MEDIA_UNDERSTANDING_CONTEXT_OPEN = "<suzu-media-understanding>";
const MEDIA_UNDERSTANDING_CONTEXT_CLOSE = "</suzu-media-understanding>";

const IMAGE_MIME_BY_EXTENSION = Object.freeze({
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
});
// Agent Core accepts only the compact raster set above as a native visual-model
// input.  Sending an Agent-created attachment back to the person is a
// different operation: Electron can still present a wider local-image set as
// a normal chat attachment.
const AGENT_IMAGE_MIME_BY_EXTENSION = Object.freeze({
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
});
const AGENT_CORE_IMAGE_MEDIA_TYPES = new Set(Object.values(IMAGE_MIME_BY_EXTENSION));
const VIDEO_MIME_BY_EXTENSION = Object.freeze({
  ".3g2": "video/3gpp2",
  ".3gp": "video/3gpp",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".m4v": "video/x-m4v",
  ".m2ts": "video/mp2t",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".mts": "video/mp2t",
  ".ogv": "video/ogg",
  ".ts": "video/mp2t",
  ".webm": "video/webm",
  ".wmv": "video/x-ms-wmv",
});
const AGENT_ATTACHMENT_KINDS = new Set(["audio", "file", "image"]);
const KNOWN_MEDIA_SOURCES = new Set(["mail", "sticker", "wechat"]);

export class ConversationAttachmentError extends Error {
  constructor(message, { cause, code = "CONVERSATION_ATTACHMENT_ERROR" } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ConversationAttachmentError";
    this.code = code;
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function boundedSize(value) {
  return Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_CONVERSATION_ATTACHMENT_BYTES;
}

function safeFileName(value) {
  const original = path.basename(clean(value))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
    .replace(/[. ]+$/u, "")
    .slice(0, 180);
  return original || "attachment.bin";
}

function nativeImageMime(value, fileName) {
  const declared = clean(value).toLowerCase().split(";", 1)[0];
  if (AGENT_CORE_IMAGE_MEDIA_TYPES.has(declared)) return declared;
  return IMAGE_MIME_BY_EXTENSION[path.extname(clean(fileName)).toLowerCase()] || "";
}

function videoMime(value, fileName) {
  const declared = clean(value).toLowerCase().split(";", 1)[0];
  if (declared.startsWith("video/")) return declared;
  return VIDEO_MIME_BY_EXTENSION[path.extname(clean(fileName)).toLowerCase()] || "";
}

function attachmentMime(value, fileName) {
  return nativeImageMime(value, fileName)
    || videoMime(value, fileName)
    || clean(value).toLowerCase().split(";", 1)[0]
    || "application/octet-stream";
}

function mediaSource(value) {
  const source = clean(value).toLowerCase();
  return KNOWN_MEDIA_SOURCES.has(source) ? source : "";
}

function agentAttachmentKind(value) {
  const kind = clean(value).toLowerCase();
  if (!AGENT_ATTACHMENT_KINDS.has(kind)) {
    throw new ConversationAttachmentError("聊天附件类型必须是 image、audio 或 file。", { code: "AGENT_ATTACHMENT_KIND_INVALID" });
  }
  return kind;
}

function agentAttachmentMime(kind, fileName) {
  const extension = path.extname(clean(fileName)).toLowerCase();
  if (kind === "image") {
    const mimeType = AGENT_IMAGE_MIME_BY_EXTENSION[extension] || "";
    if (!mimeType) {
      throw new ConversationAttachmentError("图片附件格式不受支持。", { code: "AGENT_ATTACHMENT_IMAGE_INVALID" });
    }
    return mimeType;
  }
  if (kind === "audio") {
    if (extension !== ".mp3") {
      throw new ConversationAttachmentError("语音附件目前只支持 MP3 文件。", { code: "AGENT_ATTACHMENT_AUDIO_INVALID" });
    }
    return "audio/mpeg";
  }
  return "application/octet-stream";
}

function attachmentDirectory({ dataRoot, projectRoot, sessionId }) {
  const root = clean(dataRoot);
  const project = clean(projectRoot);
  const id = clean(sessionId);
  if (!root || !path.isAbsolute(root)) {
    throw new ConversationAttachmentError("会话附件需要绝对的软件数据目录。", { code: "DATA_ROOT_REQUIRED" });
  }
  if (!project || !path.isAbsolute(project)) {
    throw new ConversationAttachmentError("会话附件需要绝对的联系人工作目录。", { code: "PROJECT_ROOT_REQUIRED" });
  }
  if (!id) throw new ConversationAttachmentError("会话附件缺少会话标识。", { code: "SESSION_REQUIRED" });
  try {
    return path.join(resolveAgentConversationDataRoot({
      dataRoot: path.resolve(root),
      projectRoot: path.resolve(project),
      sessionId: id,
    }), "attachments");
  } catch (error) {
    throw new ConversationAttachmentError(`无法定位当前会话的附件目录：${clean(error?.message) || "目录无效。"}`, {
      cause: error,
      code: "ATTACHMENT_DIRECTORY_INVALID",
    });
  }
}

function cachedFileName(fileName) {
  return `${Date.now()}-${randomUUID()}-${safeFileName(fileName)}`;
}

async function cacheAttachment({ data = null, directory, fileName, fsOps, size, sourcePath = "" }) {
  const target = path.join(directory, cachedFileName(fileName));
  const temporary = `${target}.tmp`;
  try {
    if (data) await fsOps.writeFile(temporary, data);
    else await fsOps.copyFile(sourcePath, temporary);
    const copied = await fsOps.lstat(temporary);
    if (!copied.isFile?.() || copied.size !== size) {
      throw new ConversationAttachmentError("附件在保存时发生变化。", { code: "ATTACHMENT_COPY_CHANGED" });
    }
    await fsOps.rename(temporary, target);
    return target;
  } catch (error) {
    await fsOps.rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof ConversationAttachmentError) throw error;
    throw new ConversationAttachmentError(`无法保存会话附件副本：${clean(error?.message) || "未知错误。"}`, {
      cause: error,
      code: "ATTACHMENT_COPY_FAILED",
    });
  }
}

function binaryData(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

async function inspectPath(sourcePath, fsOps) {
  const source = clean(sourcePath);
  if (!source || !path.isAbsolute(source)) {
    throw new ConversationAttachmentError("附件必须是本机绝对文件路径。", { code: "ATTACHMENT_PATH_INVALID" });
  }
  const resolved = path.resolve(source);
  let stat;
  try {
    stat = await fsOps.lstat(resolved);
  } catch (error) {
    throw new ConversationAttachmentError(`找不到附件：${resolved}`, { cause: error, code: "ATTACHMENT_NOT_FOUND" });
  }
  if (stat.isSymbolicLink?.() || !stat.isFile?.()) {
    throw new ConversationAttachmentError("附件必须是普通文件，不能是目录或链接。", { code: "ATTACHMENT_NOT_REGULAR_FILE" });
  }
  if (!boundedSize(stat.size)) {
    const detail = Number(stat.size) <= 0 ? "附件不能为空。" : `单个附件不能超过 ${MAX_CONVERSATION_ATTACHMENT_BYTES >> 20} MiB。`;
    throw new ConversationAttachmentError(detail, { code: "ATTACHMENT_SIZE_INVALID" });
  }
  return { path: resolved, size: stat.size };
}

function mediaKind(entry, mimeType) {
  const requested = clean(entry.kind).toLowerCase();
  return requested === "image" && AGENT_CORE_IMAGE_MEDIA_TYPES.has(mimeType) ? "image" : "file";
}

function understandingKind({ kind, fileName, mimeType }) {
  if (kind === "image") return "image";
  return videoMime(mimeType, fileName) ? "video" : "";
}

function displayItem({ kind, fileName, filePath, mimeType, size, source }) {
  return Object.freeze({
    kind,
    fileName,
    filePath,
    fileUrl: pathToFileURL(filePath).toString(),
    mimeType,
    size,
    ...(source ? { mediaSource: source } : {}),
  });
}

function promptManifest(items, source, { nativeImages = true } = {}) {
  const files = items.filter((item) => item.kind === "file");
  const images = items.filter((item) => item.kind === "image");
  const note = [
    images.length
      ? nativeImages
        ? `用户附上了 ${images.length} 张图片；图片已作为原生视觉输入传入。`
        : `用户附上了 ${images.length} 张图片；系统会通过已启用的图像理解能力提供识图结果。`
      : "",
    files.length ? `用户附上了 ${files.length} 个本地文件；需要内容时请使用文件工具读取以下缓存路径，不要臆造文件内容。` : "",
  ].filter(Boolean).join(" ");
  return [
    MEDIA_MANIFEST_OPEN,
    JSON.stringify({
      version: 1,
      ...(source ? { source } : {}),
      note,
      items: items.map((item) => ({
        kind: item.kind,
        fileName: item.fileName,
        mimeType: item.mimeType,
        path: item.filePath,
        size: item.size,
      })),
    }),
    MEDIA_MANIFEST_CLOSE,
  ].join("\n");
}

/**
 * Copies user/integration media into the current contact's durable attachment
 * directory, then creates the exact public Agent Core prompt parts. Native Agent Core
 * accepts raster images only; ordinary files stay local and are named in a
 * compact manifest so the existing file tools can inspect them on demand.
 */
export function createConversationAttachmentService({ dataRoot, fsOps = fs } = {}) {
  const root = clean(dataRoot);
  if (!root || !path.isAbsolute(root)) {
    throw new ConversationAttachmentError("会话附件服务需要绝对的软件数据目录。", { code: "DATA_ROOT_REQUIRED" });
  }
  for (const method of ["copyFile", "lstat", "mkdir", "readFile", "rename", "rm", "writeFile"]) {
    if (typeof fsOps?.[method] !== "function") {
      throw new ConversationAttachmentError(`会话附件文件接口缺少 ${method}()。`, { code: "FILESYSTEM_CONTRACT_INVALID" });
    }
  }

  const inspect = async (value = {}) => {
    const entry = plainObject(value);
    const source = await inspectPath(entry.path || entry.source, fsOps);
    const fileName = safeFileName(entry.fileName || path.basename(source.path));
    const mimeType = attachmentMime(entry.mimeType, fileName);
    return Object.freeze({
      fileName,
      kind: mediaKind(entry, mimeType),
      mimeType,
      path: source.path,
      size: source.size,
    });
  };

  const prepare = async ({
    content = "",
    includeNativeImages = true,
    media = [],
    mediaSource: sourceValue = "",
    projectRoot,
    sessionId,
  } = {}) => {
    const entries = Array.isArray(media) ? media : [];
    if (!entries.length) {
      const text = String(content ?? "");
      if (!text.trim()) throw new ConversationAttachmentError("消息不能为空。", { code: "EMPTY_MESSAGE" });
      return Object.freeze({
        input: text,
        media: Object.freeze([]),
        memoryText: clean(text),
      });
    }
    if (entries.length > MAX_CONVERSATION_ATTACHMENT_ITEMS) {
      throw new ConversationAttachmentError(`一次最多发送 ${MAX_CONVERSATION_ATTACHMENT_ITEMS} 个附件。`, { code: "ATTACHMENT_LIMIT_EXCEEDED" });
    }

    const directory = attachmentDirectory({ dataRoot: root, projectRoot, sessionId });
    await fsOps.mkdir(directory, { recursive: true });
    const source = mediaSource(sourceValue);
    const saved = [];
    const nativeImages = includeNativeImages !== false;
    let imageCount = 0;

    for (const rawEntry of entries) {
      const entry = plainObject(rawEntry);
      const data = binaryData(entry.data);
      let sourceInfo = null;
      if (clean(entry.path || entry.source)) sourceInfo = await inspectPath(entry.path || entry.source, fsOps);
      if (!sourceInfo && !data) {
        throw new ConversationAttachmentError("附件缺少可读取的本机文件。", { code: "ATTACHMENT_SOURCE_REQUIRED" });
      }
      const size = sourceInfo?.size ?? data.length;
      if (!boundedSize(size)) {
        const detail = size <= 0 ? "附件不能为空。" : `单个附件不能超过 ${MAX_CONVERSATION_ATTACHMENT_BYTES >> 20} MiB。`;
        throw new ConversationAttachmentError(detail, { code: "ATTACHMENT_SIZE_INVALID" });
      }
      const fileName = safeFileName(entry.fileName || (sourceInfo ? path.basename(sourceInfo.path) : "attachment.bin"));
      const imageMime = nativeImageMime(entry.mimeType, fileName);
      const kind = mediaKind(entry, imageMime);
      if (kind === "image" && nativeImages) {
        imageCount += 1;
        if (imageCount > MAX_AGENT_CORE_IMAGES_PER_MESSAGE) {
          throw new ConversationAttachmentError(`一次最多发送 ${MAX_AGENT_CORE_IMAGES_PER_MESSAGE} 张图片。`, { code: "AGENT_CORE_IMAGE_LIMIT_EXCEEDED" });
        }
        if (size > MAX_AGENT_CORE_IMAGE_BYTES) {
          throw new ConversationAttachmentError(`单张图片不能超过 ${MAX_AGENT_CORE_IMAGE_BYTES >> 20} MiB。`, { code: "AGENT_CORE_IMAGE_TOO_LARGE" });
        }
      }
      const target = await cacheAttachment({
        data,
        directory,
        fileName,
        fsOps,
        size,
        sourcePath: sourceInfo?.path || "",
      });
      const item = displayItem({
        kind,
        fileName,
        filePath: target,
        mimeType: attachmentMime(entry.mimeType, fileName),
        size,
        source,
      });
      saved.push({
        ...item,
        ...(kind === "image" && nativeImages ? { data: await fsOps.readFile(target) } : {}),
        ...(understandingKind(item) ? { understandingKind: understandingKind(item) } : {}),
      });
    }

    const publicMedia = Object.freeze(saved.map(({ data, understandingKind: _understandingKind, ...item }) => Object.freeze(item)));
    const understandingMedia = Object.freeze(saved.flatMap((item) => (
      item.understandingKind
        ? [Object.freeze({
          fileName: item.fileName,
          filePath: item.filePath,
          kind: item.understandingKind,
          mimeType: item.mimeType,
          size: item.size,
        })]
        : []
    )));
    const promptParts = [];
    const text = String(content ?? "");
    if (text.trim()) promptParts.push({ type: "text", text });
    promptParts.push({ type: "text", text: promptManifest(publicMedia, source, { nativeImages }) });
    for (const item of saved) {
      if (!nativeImages || item.kind !== "image") continue;
      promptParts.push({
        type: "image",
        mediaType: item.mimeType,
        data: item.data.toString("base64"),
        name: item.fileName,
      });
    }
    const labels = publicMedia.map((item) => item.fileName).join("、");
    return Object.freeze({
      input: Object.freeze(promptParts.map((part) => Object.freeze({ ...part }))),
      media: publicMedia,
      memoryText: clean(content) || `用户发送了附件：${labels}`,
      understandingMedia,
    });
  };

  /**
   * The product uses a durable `suzu-conversation-attachment` receipt. Let
   * Agent Core's public capability bridge invoke it directly in Electron. The
   * agent supplies only paths it has already created or inspected; the parent
   * supplies the trusted active session scope and returns cached copies.
   */
  const deliver = async ({ input = {}, projectRoot, sessionId } = {}) => {
    const requested = plainObject(input);
    const entries = Array.isArray(requested.items) ? requested.items : [];
    if (!entries.length) {
      throw new ConversationAttachmentError("请至少提供一个要发送到聊天的附件。", { code: "AGENT_ATTACHMENT_REQUIRED" });
    }
    if (entries.length > MAX_CONVERSATION_ATTACHMENT_ITEMS) {
      throw new ConversationAttachmentError(`一次最多发送 ${MAX_CONVERSATION_ATTACHMENT_ITEMS} 个附件。`, { code: "ATTACHMENT_LIMIT_EXCEEDED" });
    }
    const directory = attachmentDirectory({ dataRoot: root, projectRoot, sessionId });
    await fsOps.mkdir(directory, { recursive: true });
    const items = [];
    for (const rawEntry of entries) {
      const entry = plainObject(rawEntry);
      const kind = agentAttachmentKind(entry.kind);
      const source = await inspectPath(entry.path, fsOps);
      const fileName = safeFileName(entry.fileName || path.basename(source.path));
      // The extension must describe the actual generated file, rather than a
      // display-name override supplied by the model. This validates the
      // actual media type while still allowing a
      // friendly fileName in the chat card.
      const mimeType = agentAttachmentMime(kind, source.path);
      const target = await cacheAttachment({
        directory,
        fileName,
        fsOps,
        size: source.size,
        sourcePath: source.path,
      });
      items.push(Object.freeze({
        kind,
        fileName,
        mimeType,
        path: target,
        size: source.size,
      }));
    }
    return Object.freeze({
      status: "ok",
      type: CONVERSATION_ATTACHMENT_RECEIPT,
      receiptId: `attachment-${randomUUID()}`,
      items: Object.freeze(items),
    });
  };

  return Object.freeze({
    deliver,
    inspect,
    prepare,
    limits: Object.freeze({
      maxBytes: MAX_CONVERSATION_ATTACHMENT_BYTES,
      maxImages: MAX_AGENT_CORE_IMAGES_PER_MESSAGE,
      maxImageBytes: MAX_AGENT_CORE_IMAGE_BYTES,
      maxItems: MAX_CONVERSATION_ATTACHMENT_ITEMS,
    }),
  });
}

export const conversationMediaManifest = Object.freeze({
  close: MEDIA_MANIFEST_CLOSE,
  open: MEDIA_MANIFEST_OPEN,
});

export const conversationMediaUnderstandingContext = Object.freeze({
  close: MEDIA_UNDERSTANDING_CONTEXT_CLOSE,
  open: MEDIA_UNDERSTANDING_CONTEXT_OPEN,
});

export const conversationAttachmentReceipt = Object.freeze({
  type: CONVERSATION_ATTACHMENT_RECEIPT,
});
