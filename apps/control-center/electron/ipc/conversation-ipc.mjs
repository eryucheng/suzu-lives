import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createSuzuAgentLifecycle } from "@suzu-lives/agent-lifecycle";
import { createConversationReader } from "../services/conversation-reader.mjs";
import { createConversationChatService } from "../services/conversation-chat.mjs";
import { createAgentUsageLedger } from "../services/agent-usage-ledger.mjs";
import { createConversationAttachmentService } from "../services/conversation-attachment-service.mjs";
import { createConversationCompactorService } from "../services/conversation-compactor-service.mjs";
import { createSuzuAgentRuntime } from "../services/suzu-agent-runtime.mjs";
import { registerSuzuAgentHooks } from "../services/agent-hook-registry.mjs";
import {
  createEmojiStickerLibrary,
  EMOJI_STICKER_DIALOG_FILTER,
  inspectEmojiStickerData,
  resolveEmojiStickerLibraryRoot,
} from "../services/emoji-sticker-library.mjs";
import { createEmojiStickerCatalog } from "../services/emoji-sticker-catalog.mjs";
import { normalizeEmojiStickerMetadata } from "../services/emoji-sticker-metadata.mjs";
import { completeEmojiStickerMetadata } from "../services/emoji-sticker-tagging.mjs";
import { createConversationSessionSettingsService } from "../services/conversation-session-settings.mjs";
import { createRealtimeVoiceCallService } from "../services/realtime-voice-call.mjs";
import { createConversationVoiceInputService } from "../services/conversation-voice-input.mjs";
import { PRODUCT_FEATURES } from "../../shared/product-features.mjs";

const STICKER_SELECTION_TTL_MS = 10 * 60 * 1_000;
const ATTACHMENT_SELECTION_TTL_MS = 10 * 60 * 1_000;
const IMAGE_ATTACHMENT_DIALOG_FILTER = Object.freeze({
  name: "图片",
  extensions: ["png", "jpg", "jpeg", "webp", "gif"],
});
const FILE_ATTACHMENT_DIALOG_FILTER = Object.freeze({
  name: "所有文件",
  extensions: ["*"],
});
const CLIPBOARD_IMAGE_EXTENSION_BY_MIME = Object.freeze({
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
});

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function croppedEmojiStickerImage(value, selection) {
  const source = plainObject(value);
  if (source.data === undefined || source.data === null) {
    throw new Error("缺少裁剪后的表情包图片。");
  }
  const croppedName = `${path.basename(selection.fileName, path.extname(selection.fileName)) || "表情包"}.webp`;
  return inspectEmojiStickerData(source.data, {
    fileName: croppedName,
    mimeType: clean(source.mimeType) || "image/webp",
  });
}

function contactSettingsValue(value) {
  const source = plainObject(value);
  if (Object.hasOwn(source, "sessionId") || Object.hasOwn(source, "projectRoot")) {
    throw new Error("联系人设置只接受 contactId。 ");
  }
  return { contactId: clean(source.contactId) };
}

function contactLongTermMemoryValue(value) {
  const source = plainObject(value);
  if (Object.hasOwn(source, "sessionId") || Object.hasOwn(source, "projectRoot")) {
    throw new Error("联系人长期记忆设置只接受 contactId。 ");
  }
  if (typeof source.enabled !== "boolean") throw new Error("联系人长期记忆开关无效。 ");
  return { id: clean(source.id), enabled: source.enabled };
}

function contactPermissionModeValue(value) {
  const source = plainObject(value);
  if (Object.hasOwn(source, "sessionId") || Object.hasOwn(source, "projectRoot")) {
    throw new Error("联系人审批模式只接受 contactId。 ");
  }
  const id = clean(source.id);
  const permissionMode = clean(source.permissionMode);
  if (!id || !permissionMode) throw new Error("联系人审批模式无效。 ");
  return { id, permissionMode };
}

function contactReasoningEffortValue(value) {
  const source = plainObject(value);
  if (Object.hasOwn(source, "sessionId") || Object.hasOwn(source, "projectRoot")) {
    throw new Error("联系人思考强度只接受 contactId。 ");
  }
  const id = clean(source.id);
  const reasoningEffort = clean(source.reasoningEffort);
  if (!id || !reasoningEffort) throw new Error("联系人思考强度无效。 ");
  return { id, reasoningEffort };
}

function contactPresentationValue(value) {
  const source = plainObject(value);
  if (Object.hasOwn(source, "sessionId") || Object.hasOwn(source, "projectRoot")) {
    throw new Error("联系人显示状态只接受 contactId。 ");
  }
  const result = { id: clean(source.id) };
  if (Object.hasOwn(source, "unread")) throw new Error("联系人未读状态请使用 unreadCount。 ");
  for (const key of ["pinned", "muted", "hidden"]) {
    if (!Object.hasOwn(source, key)) continue;
    if (typeof source[key] !== "boolean") throw new Error("联系人显示状态无效。 ");
    result[key] = source[key];
  }
  for (const key of ["unreadCount", "unreadIncrement"]) {
    if (!Object.hasOwn(source, key)) continue;
    const minimum = key === "unreadIncrement" ? 1 : 0;
    if (!Number.isSafeInteger(source[key]) || source[key] < minimum) throw new Error("联系人未读数无效。 ");
    result[key] = source[key];
  }
  if (Object.hasOwn(result, "unreadCount") && Object.hasOwn(result, "unreadIncrement")) {
    throw new Error("联系人未读状态不能同时指定多个值。 ");
  }
  if (!result.id || Object.keys(result).length === 1) throw new Error("请指定联系人及其显示状态。 ");
  return result;
}

function contextTraceValue(value) {
  const source = plainObject(value);
  if (Object.hasOwn(source, "sessionId") || Object.hasOwn(source, "projectRoot") || Object.hasOwn(source, "contactId")) {
    throw new Error("上下文查询使用当前联系人，不能指定会话或目录。 ");
  }
  const result = {
    category: clean(source.category),
    query: clean(source.query),
  };
  if (Object.hasOwn(source, "limit")) {
    if (!Number.isSafeInteger(source.limit) || source.limit < 1 || source.limit > 600) {
      throw new Error("上下文查询数量无效。 ");
    }
    result.limit = source.limit;
  }
  return result;
}

function contactRemovalValue(value) {
  const source = plainObject(value);
  if (Object.hasOwn(source, "sessionId") || Object.hasOwn(source, "projectRoot")) {
    throw new Error("删除联系人只接受 contactId。 ");
  }
  return { id: clean(source.id), confirmed: source.confirmed === true };
}

function conversationMessageDeletionValue(value) {
  const source = plainObject(value);
  if (Object.hasOwn(source, "sessionId") || Object.hasOwn(source, "projectRoot") || Object.hasOwn(source, "contactId")) {
    throw new Error("删除消息只接受当前联系人中的消息标识。 ");
  }
  const lineNumber = Number(source.lineNumber);
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 0) throw new Error("要删除的消息标识无效。 ");
  return {
    confirmed: source.confirmed === true,
    lineNumber,
    messageId: clean(source.messageId),
  };
}

function callStartValue(value) {
  const source = plainObject(value);
  return { initiator: clean(source.initiator).toLowerCase() === "agent" ? "agent" : "user" };
}

function attachmentPickerValue(value) {
  const kind = clean(plainObject(value).kind).toLowerCase();
  if (!new Set(["file", "image"]).has(kind)) throw new Error("附件类型无效。 ");
  return { kind };
}

function localAttachmentPath(value) {
  const fileUrl = clean(plainObject(value).fileUrl);
  if (!fileUrl) throw new Error("缺少附件文件路径。 ");
  let url;
  let filePath;
  try {
    url = new URL(fileUrl);
    if (url.protocol !== "file:") throw new Error("附件不是本地文件。 ");
    filePath = fileURLToPath(url);
  } catch (error) {
    if (error?.message === "附件不是本地文件。 ") throw error;
    throw new Error("附件路径无效。 ");
  }
  if (!path.isAbsolute(filePath)) throw new Error("附件路径无效。 ");
  if (!existsSync(filePath)) throw new Error("附件文件不存在或已被移动。 ");
  return filePath;
}

function clipboardTextValue(value) {
  const text = String(plainObject(value).text ?? "");
  if (!text.trim()) throw new Error("没有可复制的消息内容。");
  return text;
}

function clipboardImageData(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return null;
}

function clipboardImageSelectionsValue(value, limits = {}) {
  const source = plainObject(value);
  const entries = Array.isArray(source.items) ? source.items : [];
  const maxItems = Math.min(Number(limits.maxItems) || 24, Number(limits.maxImages) || 20);
  const maxImageBytes = Math.min(Number(limits.maxBytes) || 50 * 1024 * 1024, Number(limits.maxImageBytes) || 5 * 1024 * 1024);
  if (!entries.length) throw new Error("剪贴板中没有图片。 ");
  if (entries.length > maxItems) throw new Error(`一次最多粘贴 ${maxItems} 张图片。 `);
  const pastedAt = Date.now();
  return entries.map((entry, index) => {
    const item = plainObject(entry);
    const declaredMimeType = clean(item.mimeType).toLowerCase().split(";", 1)[0];
    const mimeType = declaredMimeType === "image/jpg" ? "image/jpeg" : declaredMimeType;
    const extension = CLIPBOARD_IMAGE_EXTENSION_BY_MIME[mimeType];
    if (!extension) throw new Error("剪贴板图片格式只支持 PNG、JPG、GIF 或 WebP。 ");
    const data = clipboardImageData(item.data);
    if (!data?.length) throw new Error("剪贴板图片内容无效。 ");
    if (data.length > maxImageBytes) throw new Error(`单张图片不能超过 ${Math.floor(maxImageBytes / (1024 * 1024))} MiB。 `);
    return {
      data,
      fileName: `clipboard-image-${pastedAt}-${index + 1}.${extension}`,
      kind: "image",
      mimeType,
      size: data.length,
    };
  });
}

function attachmentSendValue(value) {
  const source = plainObject(value);
  const tokens = Array.isArray(source.attachmentTokens) ? source.attachmentTokens : [];
  if (tokens.length > 24) throw new Error("一次最多发送 24 个附件。 ");
  const attachmentTokens = tokens.map((token) => clean(token)).filter(Boolean);
  if (new Set(attachmentTokens).size !== attachmentTokens.length) throw new Error("附件选择重复。 ");
  if (Object.hasOwn(source, "media")) throw new Error("聊天附件必须先通过本地选择器。 ");
  return {
    content: typeof source.content === "string" ? source.content : "",
    attachmentTokens,
    queued: source.queued === true,
  };
}

export function registerConversationIpc({
  app,
  capabilityRegistry = null,
  capabilityRuntime = null,
  clipboard = null,
  contactProjectsService = null,
  connectionsService,
  dialog,
  emojiStickerCatalog = null,
  getMainWindow,
  ipcMain,
  memoryRuntime = null,
  nativeImage = null,
  settingsService,
  shell,
  initializeContactCapabilities = null,
  onContactLongTermMemoryEnabledChanged = null,
}) {
  const dataRoot = settingsService.response(settingsService.load()).dataRoot;
  const agentRuntime = createSuzuAgentRuntime({
    dataRoot,
    // The host process needs an ordinary cwd of its own, but it must never
    // inherit the application source/package directory. Individual Agent Core
    // sessions still receive their contact projectRoot as their actual cwd.
    workspaceDirectory: path.resolve(dataRoot),
    // The Core child is shared by all contacts.  Resolve the saved mode only
    // when a session is opened, rather than turning it into a process-wide
    // environment value that would leak from one contact into another.
    resolveContactPermissionMode: async ({ contactId } = {}) => {
      const id = clean(contactId);
      if (!id || !contactProjectsService?.snapshot) return "";
      try {
        const snapshot = await contactProjectsService.snapshot();
        const contact = (Array.isArray(snapshot?.contacts) ? snapshot.contacts : [])
          .find((item) => clean(item?.id) === id) || null;
        return clean(contact?.permissionMode);
      } catch {
        // A temporary catalogue read failure must not block a normal chat;
        // the runtime falls back to the product default for this one open.
        return "";
      }
    },
    resolveContactReasoningEffort: async ({ contactId } = {}) => {
      const id = clean(contactId);
      if (!id || !contactProjectsService?.snapshot) return "";
      try {
        const snapshot = await contactProjectsService.snapshot();
        const contact = (Array.isArray(snapshot?.contacts) ? snapshot.contacts : [])
          .find((item) => clean(item?.id) === id) || null;
        return clean(contact?.reasoningEffort);
      } catch {
        return "";
      }
    },
  });
  const attachmentService = createConversationAttachmentService({ dataRoot });
  // Keep product extension points provider-neutral. The Agent Core bridge is
  // registered here, at the composition boundary, rather than making future
  // Suzu hooks depend on vendor composition internals.
  const agentLifecycle = createSuzuAgentLifecycle({
    onError: ({ event, hookId, message, policy }) => {
      console.warn(`[Suzu agent lifecycle] ${policy} hook ${hookId} failed during ${event}: ${message}`);
    },
  });
  const agentHooks = registerSuzuAgentHooks({
    agentLifecycle,
    dataRoot,
    memoryRuntime,
    ...(typeof capabilityRegistry?.createHookModules === "function"
      ? { createDefaultHookModules: (options) => capabilityRegistry.createHookModules(options) }
      : {}),
  });
  agentLifecycle.on("TurnStarting", async (payload) => {
    const result = await agentRuntime.prepareInstructions();
    if (result.changed || result.createdGlobal) {
      void agentLifecycle.dispatch("InstructionsChanged", {
        ...payload,
        bytes: Number(result.bytes) || 0,
        globalPath: result.globalPath,
      }).catch(() => undefined);
    }
    return result;
  }, {
    id: "agent-instruction-bridge",
    order: -1_000,
    policy: "critical",
    timeoutMs: 5_000,
  });
  let usageLedger = null;
  const reader = createConversationReader({
    contactProjectsService,
    dataRoot,
    memoryRuntime,
    onContactCreated: initializeContactCapabilities,
    onAgentUsageEvents: (value) => usageLedger?.reconcile(value) || Object.freeze({
      completed: false,
      status: "ledger-unavailable",
    }),
    runtime: agentRuntime,
    settingsService,
  });
  usageLedger = createAgentUsageLedger({
    capabilityRuntime,
    reader,
    settingsService,
  });
  const compactor = createConversationCompactorService({
    reader,
    runtime: agentRuntime,
  });
  const sessionSettings = createConversationSessionSettingsService({
    dataRoot,
    reader,
  });
  const stickerLibrary = () => createEmojiStickerLibrary({
    libraryRoot: resolveEmojiStickerLibraryRoot(settingsService.response(settingsService.load()).dataRoot),
  });
  const stickerCatalog = emojiStickerCatalog || createEmojiStickerCatalog({ customLibrary: stickerLibrary });
  const stickerSnapshot = async (providedSnapshot = null) => {
    const snapshot = providedSnapshot || await stickerLibrary().snapshot();
    return {
      status: snapshot.status,
      ...(clean(snapshot.addedId) ? { addedId: clean(snapshot.addedId) } : {}),
      ...(clean(snapshot.removedId) ? { removedId: clean(snapshot.removedId) } : {}),
      ...(clean(snapshot.updatedId) ? { updatedId: clean(snapshot.updatedId) } : {}),
      ...(snapshot.tagging ? { tagging: snapshot.tagging } : {}),
      ...(clean(snapshot.message) ? { message: clean(snapshot.message) } : {}),
      items: (Array.isArray(snapshot.items) ? snapshot.items : []).flatMap((item) => {
        try {
          return [{
            builtIn: item.builtIn === true,
            category: clean(item.category),
            categoryId: clean(item.categoryId),
            categoryName: clean(item.categoryName),
            createdAt: clean(item.createdAt),
            fileName: clean(item.fileName),
            fileUrl: pathToFileURL(item.path).toString(),
            id: clean(item.id),
            metadata: normalizeEmojiStickerMetadata(item.metadata),
            mimeType: clean(item.mimeType),
            size: Number(item.size) || 0,
          }];
        } catch {
          return [];
        }
      }),
    };
  };
  const stickerSelections = new Map();
  const discardExpiredStickerSelections = () => {
    const now = Date.now();
    for (const [token, selection] of stickerSelections) {
      if (selection.expiresAt < now) stickerSelections.delete(token);
    }
  };
  const consumeStickerSelection = (value) => {
    discardExpiredStickerSelections();
    const token = clean(value?.selectionToken);
    const selection = stickerSelections.get(token);
    if (!selection || selection.expiresAt < Date.now()) {
      stickerSelections.delete(token);
      throw new Error("所选表情包已失效，请重新选择。");
    }
    return { selection, token };
  };
  const registerStickerIpcHandler = (channel, handler) => {
    if (PRODUCT_FEATURES.customEmojiStickers) ipcMain.handle(channel, handler);
  };
  const registerBuiltinStickerIpcHandler = (channel, handler) => {
    if (PRODUCT_FEATURES.builtinEmojiStickers) ipcMain.handle(channel, handler);
  };
  const registerStickerSendIpcHandler = (channel, handler) => {
    if (PRODUCT_FEATURES.builtinEmojiStickers || PRODUCT_FEATURES.customEmojiStickers) ipcMain.handle(channel, handler);
  };
  const attachmentSelections = new Map();
  const discardExpiredAttachmentSelections = () => {
    const now = Date.now();
    for (const [token, selection] of attachmentSelections) {
      if (selection.expiresAt < now) attachmentSelections.delete(token);
    }
  };
  const consumeAttachmentSelections = (tokens = []) => {
    discardExpiredAttachmentSelections();
    const media = [];
    for (const token of tokens) {
      const selection = attachmentSelections.get(token);
      if (!selection) throw new Error("所选附件已失效，请重新选择。 ");
      media.push(selection.media);
    }
    return media;
  };
  let sender = null;
  let callSender = null;
  let voiceInputSender = null;
  const chat = createConversationChatService({
    attachmentService,
    compactor,
    capabilityRuntime,
    usageLedger,
    settingsService,
    reader,
    runtime: agentRuntime,
    memoryRuntime,
    lifecycle: agentLifecycle,
    onEvent: (payload) => {
      if (sender && !sender.isDestroyed()) sender.send("conversation:event", payload);
    },
  });
  const call = createRealtimeVoiceCallService({
    chat,
    connectionsService,
    reader,
    settingsService,
    onEvent: (payload) => {
      const target = callSender && !callSender.isDestroyed() ? callSender : sender;
      if (target && !target.isDestroyed()) target.send("conversation:event", payload);
    },
  });
  const voiceInput = createConversationVoiceInputService({
    connectionsService,
    reader,
    settingsService,
    onEvent: (payload) => {
      const target = voiceInputSender && !voiceInputSender.isDestroyed() ? voiceInputSender : sender;
      if (target && !target.isDestroyed()) target.send("conversation:event", payload);
      if (payload?.type === "voice-input-ended") voiceInputSender = null;
    },
  });
  app?.once?.("before-quit", () => {
    call.dispose();
    voiceInput.dispose();
    chat.dispose();
    agentHooks.dispose();
    agentLifecycle.close();
  });
  ipcMain.handle("conversation:register-event-recipient", (event) => {
    sender = event.sender;
    return { registered: true };
  });
  ipcMain.handle("conversation:snapshot", (event, value = {}) => {
    sender = event.sender;
    return reader.snapshot(value);
  });
  ipcMain.handle("conversation:select-attachments", async (event, value) => {
    sender = event.sender;
    if (typeof dialog?.showOpenDialog !== "function") throw new Error("当前环境无法选择本地附件。 ");
    const { kind } = attachmentPickerValue(value);
    const result = await dialog.showOpenDialog(getMainWindow?.(), {
      title: kind === "image" ? "选择图片" : "选择文件",
      properties: ["openFile", "multiSelections"],
      filters: [kind === "image" ? IMAGE_ATTACHMENT_DIALOG_FILTER : FILE_ATTACHMENT_DIALOG_FILTER],
    });
    if (result.canceled || !Array.isArray(result.filePaths) || !result.filePaths.length) return { canceled: true, items: [] };
    discardExpiredAttachmentSelections();
    // The single generic picker replaces the separate image button. It still
    // classifies native images as images after selection, so they retain their
    // preview and vision-input behavior instead of degrading into file cards.
    const inspectedKind = kind === "file" ? "auto" : kind;
    const inspected = await Promise.all(result.filePaths.slice(0, 24).map((source) => attachmentService.inspect({ kind: inspectedKind, path: source })));
    const items = inspected.map((item) => {
      const selectionToken = randomUUID();
      attachmentSelections.set(selectionToken, {
        expiresAt: Date.now() + ATTACHMENT_SELECTION_TTL_MS,
        media: item,
      });
      return {
        fileName: item.fileName,
        fileUrl: item.kind === "image" ? pathToFileURL(item.path).toString() : "",
        kind: item.kind,
        mimeType: item.mimeType,
        selectionToken,
        size: item.size,
      };
    });
    return { canceled: false, items };
  });
  ipcMain.handle("conversation:paste-attachments", (event, value) => {
    sender = event.sender;
    discardExpiredAttachmentSelections();
    const pasted = clipboardImageSelectionsValue(value, attachmentService.limits);
    const items = pasted.map((item) => {
      const selectionToken = randomUUID();
      attachmentSelections.set(selectionToken, {
        expiresAt: Date.now() + ATTACHMENT_SELECTION_TTL_MS,
        media: item,
      });
      return {
        fileName: item.fileName,
        kind: item.kind,
        mimeType: item.mimeType,
        selectionToken,
        size: item.size,
      };
    });
    return { canceled: false, items };
  });
  ipcMain.handle("conversation:discard-attachments", (_event, value) => {
    const tokens = Array.isArray(plainObject(value).attachmentTokens) ? plainObject(value).attachmentTokens : [];
    for (const token of tokens) attachmentSelections.delete(clean(token));
    return { discarded: true };
  });
  registerStickerIpcHandler("conversation:emoji-stickers", async (event) => {
    sender = event.sender;
    return stickerSnapshot();
  });
  registerBuiltinStickerIpcHandler("conversation:builtin-emoji-stickers", async (event) => {
    sender = event.sender;
    return stickerSnapshot(await stickerCatalog.builtins());
  });
  registerStickerIpcHandler("conversation:select-emoji-sticker", async (event) => {
    sender = event.sender;
    discardExpiredStickerSelections();
    if (typeof dialog?.showOpenDialog !== "function") throw new Error("当前环境无法选择本地表情包。");
    const result = await dialog.showOpenDialog(getMainWindow?.(), {
      title: "添加收藏表情包",
      properties: ["openFile"],
      filters: [EMOJI_STICKER_DIALOG_FILTER],
    });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    const inspected = await stickerLibrary().inspect(result.filePaths[0]);
    const selectionToken = randomUUID();
    stickerSelections.set(selectionToken, {
      expiresAt: Date.now() + STICKER_SELECTION_TTL_MS,
      fileName: inspected.fileName,
      mimeType: inspected.mimeType,
      source: inspected.source,
    });
    return {
      canceled: false,
      fileName: inspected.fileName,
      fileUrl: pathToFileURL(inspected.source).toString(),
      mimeType: inspected.mimeType,
      selectionToken,
      size: inspected.size,
    };
  });
  registerStickerIpcHandler("conversation:add-emoji-sticker", async (event, value) => {
    sender = event.sender;
    const { selection, token } = consumeStickerSelection(value);
    let saved = false;
    try {
      const source = plainObject(value);
      const hasCroppedData = source.data !== undefined && source.data !== null;
      let image;
      if (hasCroppedData) {
        image = croppedEmojiStickerImage(source, selection);
      } else {
        const inspected = await stickerLibrary().inspect(selection.source);
        image = {
          data: await fs.readFile(inspected.source),
          extension: inspected.extension,
          fileName: inspected.fileName,
          mimeType: inspected.mimeType,
          size: inspected.size,
        };
      }
      const added = await stickerLibrary().add({
        data: image.data,
        fileName: image.fileName,
        metadata: normalizeEmojiStickerMetadata(source.metadata),
        mimeType: image.mimeType,
      });
      saved = true;
      return stickerSnapshot(added);
    } finally {
      if (saved) stickerSelections.delete(token);
    }
  });
  registerStickerIpcHandler("conversation:complete-emoji-sticker", async (event, value) => {
    sender = event.sender;
    const source = plainObject(value);
    const metadata = normalizeEmojiStickerMetadata(source.metadata);
    const selectionToken = clean(source.selectionToken);
    if (selectionToken) {
      const { selection } = consumeStickerSelection(source);
      const image = croppedEmojiStickerImage(source, selection);
      const completed = await completeEmojiStickerMetadata({
        data: image.data,
        fileName: image.fileName,
        metadata,
        mimeType: image.mimeType,
        runtime: agentRuntime,
      });
      return {
        metadata: completed.metadata,
        tagging: { status: completed.inferred ? "completed" : "not-needed" },
      };
    }
    const library = stickerLibrary();
    const sticker = await library.read(clean(source.id));
    const completed = await completeEmojiStickerMetadata({
      data: sticker.data,
      fileName: sticker.fileName,
      metadata,
      mimeType: sticker.mimeType,
      runtime: agentRuntime,
    });
    const next = completed.inferred
      ? await library.update(sticker.id, completed.metadata)
      : await library.snapshot();
    return stickerSnapshot({
      ...next,
      tagging: { status: completed.inferred ? "completed" : "not-needed" },
    });
  });
  registerStickerIpcHandler("conversation:discard-emoji-sticker-selection", (event, value) => {
    sender = event.sender;
    const selectionToken = clean(value?.selectionToken);
    if (selectionToken) stickerSelections.delete(selectionToken);
    return { discarded: true };
  });
  registerStickerIpcHandler("conversation:update-emoji-sticker", async (event, value) => {
    sender = event.sender;
    const source = plainObject(value);
    return stickerSnapshot(await stickerLibrary().update(clean(source.id), source.metadata));
  });
  registerStickerIpcHandler("conversation:remove-emoji-sticker", async (event, value) => {
    sender = event.sender;
    const source = plainObject(value);
    if (source.confirmed !== true) throw new Error("删除表情包前需要确认。 ");
    return stickerSnapshot(await stickerLibrary().remove(clean(source.id)));
  });
  registerStickerSendIpcHandler("conversation:send-emoji-sticker", async (event, value) => {
    sender = event.sender;
    const sticker = await stickerCatalog.read(clean(value?.id));
    const metadata = normalizeEmojiStickerMetadata(sticker.metadata);
    const stickerName = metadata.name || sticker.fileName;
    return chat.send({
      content: "",
      media: [{
        data: sticker.data,
        fileName: sticker.fileName,
        kind: "image",
        mimeType: sticker.mimeType,
        path: sticker.path,
        stickerContext: {
          description: metadata.description,
          keywords: metadata.keywords,
          name: stickerName,
        },
      }],
      mediaSource: "sticker",
      memoryText: metadata.description
        ? `用户发送了表情“${stickerName}”：${metadata.description}`
        : `用户发送了一个表情：${stickerName}`,
    });
  });
  ipcMain.handle("conversation:search", (_event, query) => reader.search(query));
  ipcMain.handle("conversation:context-trace", (_event, value) => reader.contextTrace(contextTraceValue(value)));
  ipcMain.handle("conversation:focus", (_event, value) => reader.focus(value));
  ipcMain.handle("conversation:open-media-directory", async (event, value) => {
    sender = event.sender;
    if (typeof shell?.openPath !== "function") throw new Error("当前环境无法打开本地文件夹。 ");
    const media = await sessionSettings.mediaDirectory(contactSettingsValue(value));
    const error = await shell.openPath(media.directory);
    if (error) throw new Error(`无法打开联系人媒体目录：${error}`);
    return media;
  });
  ipcMain.handle("conversation:open-media-file", async (event, value) => {
    sender = event.sender;
    const filePath = localAttachmentPath(value);
    if (typeof shell?.showItemInFolder === "function") {
      shell.showItemInFolder(filePath);
      return { revealed: true };
    }
    if (typeof shell?.openPath !== "function") throw new Error("当前环境无法打开附件所在位置。 ");
    const error = await shell.openPath(path.dirname(filePath));
    if (error) throw new Error(`无法打开附件所在位置：${error}`);
    return { revealed: true };
  });
  ipcMain.handle("conversation:copy-media-file", async (event, value) => {
    sender = event.sender;
    const filePath = localAttachmentPath(value);
    const writeFiles = clipboard?._writeFilesForTesting;
    if (typeof writeFiles !== "function") throw new Error("当前运行环境无法复制本地文件。 ");
    writeFiles.call(clipboard, [filePath]);
    return { copied: true };
  });
  ipcMain.handle("conversation:copy-message-text", async (event, value) => {
    sender = event.sender;
    if (typeof clipboard?.writeText !== "function") throw new Error("当前运行环境无法复制文字。");
    clipboard.writeText(clipboardTextValue(value));
    return { copied: true };
  });
  ipcMain.handle("conversation:copy-media-image", async (event, value) => {
    sender = event.sender;
    const filePath = localAttachmentPath(value);
    if (typeof nativeImage?.createFromPath !== "function" || typeof clipboard?.writeImage !== "function") {
      throw new Error("当前运行环境无法复制图片。");
    }
    const image = nativeImage.createFromPath(filePath);
    if (!image || typeof image.isEmpty !== "function" || image.isEmpty()) throw new Error("无法读取这张图片。 ");
    clipboard.writeImage(image);
    return { copied: true };
  });
  ipcMain.handle("conversation:create", async (event) => {
    sender = event.sender;
    return reader.create();
  });
  ipcMain.handle("conversation:create-contact", async (event, value) => {
    sender = event.sender;
    return reader.createContact(value);
  });
  ipcMain.handle("conversation:rename-contact", async (event, value) => {
    sender = event.sender;
    return reader.renameContact(value);
  });
  ipcMain.handle("conversation:select-contact", async (event, value) => {
    sender = event.sender;
    return reader.selectContact(value);
  });
  ipcMain.handle("conversation:set-preferred-contact", async (event, value) => {
    sender = event.sender;
    return reader.setPreferredContact(value);
  });
  ipcMain.handle("conversation:update-contact-presentation", async (event, value) => {
    sender = event.sender;
    return reader.updateContactPresentation(contactPresentationValue(value));
  });
  ipcMain.handle("conversation:update-contact-long-term-memory", async (event, value) => {
    sender = event.sender;
    const next = contactLongTermMemoryValue(value);
    const snapshot = await reader.updateContactLongTermMemoryEnabled(next);
    try {
      await onContactLongTermMemoryEnabledChanged?.(next);
    } catch {
      // The stored preference and runtime gate are already active even if the
      // optional project Hook sync cannot finish right now.
    }
    return snapshot;
  });
  ipcMain.handle("conversation:update-contact-permission-mode", async (event, value) => {
    sender = event.sender;
    return reader.updateContactPermissionMode(contactPermissionModeValue(value));
  });
  ipcMain.handle("conversation:update-contact-reasoning-effort", async (event, value) => {
    sender = event.sender;
    return reader.updateContactReasoningEffort(contactReasoningEffortValue(value));
  });
  ipcMain.handle("conversation:remove-contact", async (event, value) => {
    sender = event.sender;
    return reader.removeContact(contactRemovalValue(value));
  });
  ipcMain.handle("conversation:delete-message", async (event, value) => {
    sender = event.sender;
    return reader.deleteMessage(conversationMessageDeletionValue(value));
  });
  ipcMain.handle("conversation:send", async (event, value) => {
    sender = event.sender;
    const request = attachmentSendValue(value);
    const media = consumeAttachmentSelections(request.attachmentTokens);
    try {
      const result = await chat.send({
        content: request.content,
        media,
        mediaSource: "local",
        queued: request.queued === true,
      });
      for (const token of request.attachmentTokens) attachmentSelections.delete(token);
      return result;
    } catch (error) {
      throw error;
    }
  });
  ipcMain.handle("conversation:stop", async (event, value) => {
    sender = event.sender;
    return chat.stop(value);
  });
  ipcMain.handle("conversation:steer", async (event, value) => {
    sender = event.sender;
    return chat.steer(value);
  });
  ipcMain.handle("conversation:respond-permission", async (event, value) => {
    sender = event.sender;
    return chat.respondPermission(value);
  });
  ipcMain.handle("conversation:call-start", async (event, value) => {
    sender = event.sender;
    callSender = event.sender;
    return call.start({ ...callStartValue(value), senderId: String(event.sender.id) });
  });
  ipcMain.handle("conversation:call-dismiss-request", async (event, value) => {
    sender = event.sender;
    return call.dismissAgentCallRequest({ requestId: clean(plainObject(value).requestId) });
  });
  ipcMain.handle("conversation:call-open", async (event, value) => {
    sender = event.sender;
    return call.open({ ...(value && typeof value === "object" ? value : {}), senderId: String(event.sender.id) });
  });
  ipcMain.on("conversation:call-audio", (event, value) => {
    call.pushAudio({ ...(value && typeof value === "object" ? value : {}), senderId: String(event.sender.id) });
  });
  ipcMain.handle("conversation:call-commit", async (event, value) => {
    sender = event.sender;
    return call.commitAudio({ ...(value && typeof value === "object" ? value : {}), senderId: String(event.sender.id) });
  });
  ipcMain.handle("conversation:call-interrupt", async (event, value) => {
    sender = event.sender;
    return call.interrupt({ ...(value && typeof value === "object" ? value : {}), senderId: String(event.sender.id) });
  });
  ipcMain.handle("conversation:call-stop", async (event, value) => {
    sender = event.sender;
    const result = await call.stop({ ...(value && typeof value === "object" ? value : {}), senderId: String(event.sender.id) });
    if (result?.stopped) callSender = null;
    return result;
  });
  ipcMain.handle("conversation:voice-input-start", async (event) => {
    sender = event.sender;
    const result = await voiceInput.start({ senderId: String(event.sender.id) });
    voiceInputSender = event.sender;
    return result;
  });
  ipcMain.on("conversation:voice-input-audio", (event, value) => {
    voiceInput.pushAudio({ ...(value && typeof value === "object" ? value : {}), senderId: String(event.sender.id) });
  });
  ipcMain.handle("conversation:voice-input-commit", async (event, value) => {
    sender = event.sender;
    return voiceInput.commit({ ...(value && typeof value === "object" ? value : {}), senderId: String(event.sender.id) });
  });
  ipcMain.handle("conversation:voice-input-stop", async (event, value) => {
    sender = event.sender;
    const result = await voiceInput.stop({ ...(value && typeof value === "object" ? value : {}), senderId: String(event.sender.id) });
    if (result?.stopped) voiceInputSender = null;
    return result;
  });
  return { agentLifecycle, agentRuntime, attachmentService, call, chat, compactor, reader, sessionSettings, usageLedger, voiceInput };
}
