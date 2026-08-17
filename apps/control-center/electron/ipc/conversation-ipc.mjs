import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { createConversationReader } from "../services/conversation-reader.mjs";
import { createConversationChatService } from "../services/conversation-chat.mjs";
import {
  createEmojiStickerLibrary,
  EMOJI_STICKER_DIALOG_FILTER,
  resolveEmojiStickerLibraryRoot,
} from "../services/emoji-sticker-library.mjs";
import { createConversationSessionSettingsService } from "../services/conversation-session-settings.mjs";
import { createRealtimeVoiceCallService } from "../services/realtime-voice-call.mjs";
import {
  PROACTIVE_CHAIN_DESCRIPTION,
  PROACTIVE_CHAIN_PLANNING_TURN_SOURCE,
  PROACTIVE_CHAIN_TASK_PROMPT,
  PROACTIVE_CHAIN_TURN_SOURCE,
} from "../services/proactive-contact-maintenance.mjs";

const STICKER_SELECTION_TTL_MS = 10 * 60 * 1_000;

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

function contactApprovalModeValue(value) {
  const source = plainObject(value);
  if (Object.hasOwn(source, "sessionId") || Object.hasOwn(source, "projectRoot")) {
    throw new Error("联系人审批模式只接受 contactId。 ");
  }
  return { id: clean(source.id), approvalMode: clean(source.approvalMode) };
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

function quotedArgument(value) {
  const source = clean(value);
  return source && !/["\r\n]/u.test(source) ? `"${source}"` : "";
}

export function registerConversationIpc({
  app,
  contactProjectsService = null,
  connectionsService,
  dialog,
  getMainWindow,
  ipcMain,
  memoryRuntime = null,
  settingsService,
  shell,
  wechatAttachmentCli = "",
  claudeWorkspaceDirectories = [],
  initializeContactCapabilities = null,
  onContactLongTermMemoryEnabledChanged = null,
  proactiveContactSettings = () => ({}),
  isProactiveContactEnabled = () => false,
}) {
  const reader = createConversationReader({ contactProjectsService, onContactCreated: initializeContactCapabilities, settingsService });
  const sessionSettings = createConversationSessionSettingsService({
    dataRoot: settingsService.response(settingsService.load()).dataRoot,
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
  const attachmentCommand = ({ sessionId, projectRoot } = {}) => {
    const invocation = clean(wechatAttachmentCli);
    const dataRoot = clean(settingsService.response(settingsService.load()).dataRoot);
    const rootArgument = quotedArgument(dataRoot);
    const projectArgument = quotedArgument(projectRoot);
    const sessionArgument = quotedArgument(sessionId);
    if (!invocation) return "";
    return rootArgument && projectArgument && sessionArgument
      ? `${invocation} conversation-attachment --data-root ${rootArgument} --project-root ${projectArgument} --session-id ${sessionArgument}`
      : `${invocation} conversation-attachment`;
  };
  const scheduleCommand = async ({ sessionId, projectRoot, scheduleSource = "" } = {}) => {
    const invocation = clean(wechatAttachmentCli);
    const dataRoot = clean(settingsService.response(settingsService.load()).dataRoot);
    const rootArgument = quotedArgument(dataRoot);
    if (!invocation || !rootArgument) return null;
    const source = clean(scheduleSource);
    // A is deliberately a decision-only turn. Only B is allowed to receive
    // the scheduler command that creates the next A task.
    if (source === PROACTIVE_CHAIN_TURN_SOURCE) return null;
    const proactive = proactiveContactSettings() || {};
    const contactId = await reader.contactIdForSession({ sessionId, projectRoot });
    const contactArgument = quotedArgument(contactId);
    const proactiveEnabled = await Promise.resolve(isProactiveContactEnabled({ contactId })) === true;
    return {
      conversationAdd: proactiveEnabled && contactArgument
        ? `${invocation} schedule add --data-root ${rootArgument} --contact-id ${contactArgument}`
        : "",
      list: `${invocation} schedule list --data-root ${rootArgument}`,
      remove: `${invocation} schedule remove <任务ID> --data-root ${rootArgument}`,
      proactiveChainPrompt: clean(proactive.chainPrompt),
      proactiveFollowUpPrompt: clean(proactive.followUpPrompt),
      proactivePlanning: source === PROACTIVE_CHAIN_PLANNING_TURN_SOURCE,
      proactiveChainDescription: PROACTIVE_CHAIN_DESCRIPTION,
      proactiveChainTaskPrompt: PROACTIVE_CHAIN_TASK_PROMPT,
    };
  };
  let sender = null;
  let callSender = null;
  const chat = createConversationChatService({
    agentAttachmentCommand: attachmentCommand,
    agentScheduleCommand: scheduleCommand,
    claudeWorkspaceDirectories,
    suzuCliCommand: wechatAttachmentCli,
    settingsService,
    reader,
    memoryRuntime,
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
  app?.once?.("before-quit", () => {
    call.dispose();
    chat.dispose();
  });
  ipcMain.handle("conversation:snapshot", (event) => {
    sender = event.sender;
    return reader.snapshot();
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
  ipcMain.handle("conversation:focus", (_event, value) => reader.focus(value));
  ipcMain.handle("conversation:open-media-directory", async (event, value) => {
    sender = event.sender;
    if (typeof shell?.openPath !== "function") throw new Error("当前环境无法打开本地文件夹。 ");
    const media = await sessionSettings.mediaDirectory(contactSettingsValue(value));
    const error = await shell.openPath(media.directory);
    if (error) throw new Error(`无法打开联系人媒体目录：${error}`);
    return media;
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
  ipcMain.handle("conversation:update-contact-approval-mode", async (event, value) => {
    sender = event.sender;
    return reader.updateContactApprovalMode(contactApprovalModeValue(value));
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
    return chat.send(value);
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
  return { call, chat, reader, sessionSettings };
}
