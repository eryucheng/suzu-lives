import { randomUUID } from "node:crypto";
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
  resolveEmojiStickerLibraryRoot,
} from "../services/emoji-sticker-library.mjs";
import { createConversationSessionSettingsService } from "../services/conversation-session-settings.mjs";
import { createRealtimeVoiceCallService } from "../services/realtime-voice-call.mjs";
import { createConversationVoiceInputService } from "../services/conversation-voice-input.mjs";

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

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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

function callStartValue(value) {
  const source = plainObject(value);
  return { initiator: clean(source.initiator).toLowerCase() === "agent" ? "agent" : "user" };
}

function attachmentPickerValue(value) {
  const kind = clean(plainObject(value).kind).toLowerCase();
  if (!new Set(["file", "image"]).has(kind)) throw new Error("附件类型无效。 ");
  return { kind };
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
  contactProjectsService = null,
  connectionsService,
  dialog,
  getMainWindow,
  ipcMain,
  memoryRuntime = null,
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
  const stickerSnapshot = async (providedSnapshot = null) => {
    const snapshot = providedSnapshot || await stickerLibrary().snapshot();
    return {
      status: snapshot.status,
      ...(clean(snapshot.message) ? { message: clean(snapshot.message) } : {}),
      items: (Array.isArray(snapshot.items) ? snapshot.items : []).flatMap((item) => {
        try {
          return [{
            createdAt: clean(item.createdAt),
            fileName: clean(item.fileName),
            fileUrl: pathToFileURL(item.path).toString(),
            id: clean(item.id),
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
  const consumeStickerSelection = (value) => {
    const token = clean(value?.selectionToken);
    const selection = stickerSelections.get(token);
    if (!selection || selection.expiresAt < Date.now()) {
      stickerSelections.delete(token);
      throw new Error("所选表情包已失效，请重新选择。");
    }
    return { selection, token };
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
  ipcMain.handle("conversation:snapshot", (event) => {
    sender = event.sender;
    return reader.snapshot();
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
    const inspected = await Promise.all(result.filePaths.slice(0, 24).map((source) => attachmentService.inspect({ kind, path: source })));
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
  ipcMain.handle("conversation:discard-attachments", (_event, value) => {
    const tokens = Array.isArray(plainObject(value).attachmentTokens) ? plainObject(value).attachmentTokens : [];
    for (const token of tokens) attachmentSelections.delete(clean(token));
    return { discarded: true };
  });
  ipcMain.handle("conversation:emoji-stickers", async (event) => {
    sender = event.sender;
    return stickerSnapshot();
  });
  ipcMain.handle("conversation:select-emoji-sticker", async (event) => {
    sender = event.sender;
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
      source: inspected.source,
    });
    return {
      canceled: false,
      fileName: inspected.fileName,
      mimeType: inspected.mimeType,
      selectionToken,
      size: inspected.size,
    };
  });
  ipcMain.handle("conversation:add-emoji-sticker", async (event, value) => {
    sender = event.sender;
    const { selection, token } = consumeStickerSelection(value);
    try {
      return stickerSnapshot(await stickerLibrary().add({ source: selection.source }));
    } finally {
      stickerSelections.delete(token);
    }
  });
  ipcMain.handle("conversation:send-emoji-sticker", async (event, value) => {
    sender = event.sender;
    const sticker = await stickerLibrary().read(clean(value?.id));
    return chat.send({
      content: "",
      media: [{
        data: sticker.data,
        fileName: sticker.fileName,
        kind: "image",
        mimeType: sticker.mimeType,
        path: sticker.path,
      }],
      mediaSource: "sticker",
      memoryText: `用户发送了一个表情包：${sticker.fileName}`,
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
    if (typeof shell?.openPath !== "function") throw new Error("当前环境无法打开本地文件。 ");
    const fileUrl = String(value?.fileUrl || "").trim();
    if (!fileUrl) throw new Error("缺少附件文件路径。 ");
    let filePath;
    try {
      filePath = fileURLToPath(fileUrl);
    } catch {
      throw new Error("附件路径无效。 ");
    }
    const error = await shell.openPath(filePath);
    if (error) throw new Error(`无法打开附件：${error}`);
    return { opened: true };
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
  ipcMain.handle("conversation:remove-contact", async (event, value) => {
    sender = event.sender;
    return reader.removeContact(contactRemovalValue(value));
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
  return { agentLifecycle, agentRuntime, attachmentService, call, chat, compactor, reader, sessionSettings, voiceInput };
}
