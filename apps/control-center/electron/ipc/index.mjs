import { clipboard, dialog, ipcMain, nativeImage, safeStorage, shell } from "electron";
import path from "node:path";

import { appendUsageEvent } from "@suzu-lives/cost-ledger";
import { stopWebBrowser } from "@suzu-lives/web-browser";
import { createCapabilitiesService, registerCapabilitiesIpc } from "./capabilities-ipc.mjs";
import { registerAgentJournalIpc } from "./agent-journal-ipc.mjs";
import { registerConversationCompactorIpc } from "./conversation-compactor-ipc.mjs";
import { createExternalCapabilitiesIpcService, registerExternalCapabilitiesIpc } from "./external-capabilities-ipc.mjs";
import { registerConversationIpc } from "./conversation-ipc.mjs";
import { registerSoftwareAssistantIpc } from "./software-assistant-ipc.mjs";
import { registerWechatIpc } from "./wechat-ipc.mjs";
import { registerQQIpc } from "./qq-ipc.mjs";
import { createConnectionsService, registerConnectionsIpc } from "./connections-ipc.mjs";
import { registerLedgerIpc } from "./ledger-ipc.mjs";
import { registerImageWorkbenchIpc } from "./image-workbench-ipc.mjs";
import { registerMemoryIpc } from "./memory-ipc.mjs";
import { createLongTermMemoryService } from "../services/long-term-memory-service.mjs";
import { createAgentJournalService, localJournalDate } from "../services/agent-journal-service.mjs";
import { createRelationshipFilesService, registerRelationshipFilesIpc } from "../services/relationship-files.mjs";
import { createSettingsService, registerSettingsIpc } from "./settings-ipc.mjs";
import { registerVisualReferencesIpc } from "./visual-references-ipc.mjs";
import { registerVoiceDesignIpc } from "./voice-design-ipc.mjs";
import { registerTodayCalendarIpc } from "./today-calendar-ipc.mjs";
import { createAgentRuntimeConfigService, registerAgentRuntimeConfigIpc } from "../services/agent-runtime-config-service.mjs";
import { createCapabilityAccessPolicy } from "../services/capability-access-policy.mjs";
import { createCapabilityRegistry, createCapabilityRuntime } from "../services/capability-registry.mjs";
import { createAgentCapabilityAdapters } from "../services/agent-capability-adapters.mjs";
import { createAgentVoiceCallCapabilityAdapter } from "../services/agent-voice-call-capability.mjs";
import { createEmojiStickerAgentCapabilityAdapter } from "../services/emoji-sticker-agent-capability.mjs";
import {
  createBuiltinEmojiStickerLibrary,
  resolveBuiltinEmojiStickerAssetsRoot,
} from "../services/builtin-emoji-sticker-library.mjs";
import { createEmojiStickerCatalog } from "../services/emoji-sticker-catalog.mjs";
import {
  createEmojiStickerLibrary,
  resolveEmojiStickerLibraryRoot,
} from "../services/emoji-sticker-library.mjs";
import { eraseContactAgentConversation } from "../services/agent-contact-cleanup.mjs";
import { createTodayCalendarService } from "../services/today-calendar.mjs";
import { createWeChatLinkService } from "../services/wechat-link.mjs";
import { createQQLinkService } from "../services/qq-link.mjs";
import { createMailFeedbackLinkService } from "../services/mail-feedback-link.mjs";
import { createContactProjectsService, visibleContactProjectsSnapshot } from "../services/contact-projects.mjs";
import {
  createSoftwareAssistantService,
  softwareAssistantUsageSubject,
} from "../services/software-assistant-service.mjs";
import { withDetailedIpcErrors } from "./ipc-error-boundary.mjs";
import {
  ensureTimeAwarenessConfig,
} from "../services/time-awareness-hook.mjs";
import {
  isActiveProactiveContactTask,
  isProactiveContactTask,
  isRetiredProactiveContactTask,
  maintainProactiveContactChecks,
  proactiveContactScopeKey,
  proactiveContactTaskPurpose,
  proactiveContactTaskPrompt,
  proactiveContactTimingDecision,
  proactiveContactTimingTaskPrompt,
  PROACTIVE_CONTACT_INITIAL_DELAY,
  PROACTIVE_CONTACT_RECOVERY_DELAY,
  PROACTIVE_CONTACT_TIMING_TURN_SOURCE,
  PROACTIVE_CONTACT_TURN_SOURCE,
  scheduleNextProactiveContactCheck,
} from "../services/proactive-contact-maintenance.mjs";
import { runScheduledScript, validateScheduledScriptPath } from "../services/scheduled-script.mjs";
import { syncAgentJournalSchedule } from "../services/agent-journal-schedule.mjs";
import {
  createScheduleRunner,
  createScheduleTask,
  listScheduleHistory,
  listScheduleTasks,
  removeScheduleTask,
  scheduleTaskSummary,
  setScheduleTaskEnabled,
} from "@suzu-lives/task-scheduler";

export { createSettingsService };

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function projectScopeKey(value) {
  const source = clean(value);
  if (!source || !path.isAbsolute(source)) return "";
  const resolved = path.resolve(source);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function proactiveContactTaskPhase(task, contactId) {
  const scope = { contactId };
  if (isActiveProactiveContactTask(task, scope)) return "contact";
  return "";
}

function proactiveContactRequestId(task, phase) {
  const id = clean(task?.id);
  return id && phase ? `suzu-${phase}-${id}` : "";
}

function proactiveContactTimingRequestId(task) {
  const id = clean(task?.id);
  return id ? `suzu-timing-${id}` : "";
}

function scheduleDurationPart(value, label, maximum) {
  const source = clean(value);
  if (!/^\d+$/u.test(source)) throw new Error(`${label}必须是非负整数。`);
  const number = Number(source);
  if (!Number.isSafeInteger(number) || number > maximum) throw new Error(`${label}超出可用范围。`);
  return number;
}

function scheduleDelay(value = {}) {
  const hours = scheduleDurationPart(value.hours, "小时", 8_760);
  const minutes = scheduleDurationPart(value.minutes, "分钟", 59);
  const totalMinutes = hours * 60 + minutes;
  if (!totalMinutes) throw new Error("一次性计划至少要设置 1 分钟后。 ");
  return `${totalMinutes}m`;
}

function dailyCron(value) {
  const source = clean(value);
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(source);
  if (!match) throw new Error("请设置每天的触发时间。 ");
  return `${Number(match[2])} ${Number(match[1])} * * *`;
}

function scheduledTaskContent(task, { prompt = "", displayAsSystem = false } = {}) {
  return [
    "<suzu-schedule-task>",
    `任务说明：${clean(task?.description) || "自动任务"}`,
    "这是 Suzu 自动任务触发，不是用户发来的新消息。请处理下方任务；如无需对用户可见的回复，只输出精确的 NO_REPLY。",
    ...(displayAsSystem ? ["<!-- suzu-lives:display-system -->"] : []),
    "",
    clean(prompt) || clean(task?.target?.prompt),
    "</suzu-schedule-task>",
  ].join("\n");
}

function agentJournalTaskPrompt(date) {
  return [
    "这是一项只在本机保存的 Agent 日记任务，不是用户发来的消息。",
    `请以你自己的第一人称，为 ${date} 写一则简短日记，记录今天和用户之间值得记下的事情、感受、约定或未完事项。`,
    "只输出日记正文：不要加标题，不要向用户说话，不要提及自动任务、系统或提示词，也不要输出 NO_REPLY。即使当天没有特别事件，也请诚实写下简短的一句回顾。",
  ].join("\n");
}

export function registerIpcHandlers({ app, appUpdateService = null, dataStorageService, getMainWindow, releaseAnnouncementService = null, settingsService }) {
  const rendererIpcMain = withDetailedIpcErrors(ipcMain);
  const dataRoot = settingsService.response(settingsService.load()).dataRoot;
  const builtinEmojiStickerLibrary = createBuiltinEmojiStickerLibrary({
    assetsRoot: resolveBuiltinEmojiStickerAssetsRoot(app.getAppPath()),
  });
  const emojiStickerCatalog = createEmojiStickerCatalog({
    builtinLibrary: builtinEmojiStickerLibrary,
    customLibrary: () => createEmojiStickerLibrary({
      libraryRoot: resolveEmojiStickerLibraryRoot(settingsService.response(settingsService.load()).dataRoot),
    }),
  });
  const softwareAssistantSubject = softwareAssistantUsageSubject(dataRoot);
  let removeContactAssociations = async () => undefined;
  let removeScheduledContactTasks = async () => ({ removed: 0 });
  let wechatService = null;
  let qqService = null;
  const contactProjectsService = createContactProjectsService({
    settingsService,
    dataRoot,
    onBeforeRemove: (contact) => removeContactAssociations(contact),
  });
  const connectionsService = createConnectionsService({ safeStorage, settingsService });
  const externalCapabilitiesService = createExternalCapabilitiesIpcService({
    settingsService,
    runtime: () => conversation?.agentRuntime || null,
  });
  // The config service shares the exact Agent Core child process owned by the
  // conversation runtime. Its closure is resolved only when a renderer calls
  // the public configuration IPC, after `conversation` has been initialized.
  const agentRuntimeConfigService = createAgentRuntimeConfigService({
    runtime: () => conversation?.agentRuntime || null,
  });
  const memoryService = createLongTermMemoryService({
    connectionsService,
    contactProjectsService,
    settingsService,
  });
  const todayCalendarService = createTodayCalendarService({ contactProjectsService, settingsService });
  const relationshipFilesService = createRelationshipFilesService({ contactProjectsService, settingsService });
  const agentJournalService = createAgentJournalService({ contactProjectsService, settingsService });
  // Memory recall is mounted once in the in-process Agent Core lifecycle registry.
  // Both global and per-contact settings are read when the Hook collects, so
  // changing either setting requires no project file mutation or reinstall.
  const syncMemoryRecallHooks = async () => ({ status: "ready", runtime: "agent-lifecycle", contacts: [], errors: [] });
  let mailFeedbackService = null;
  let conversation = null;
  let requestAgentJournalScheduleSync = async () => undefined;
  let requestProactiveContactMaintenance = async () => undefined;
  const agentVoiceCallCapability = createAgentVoiceCallCapabilityAdapter({
    voiceCallService: () => conversation?.call || null,
  });
  const capabilityRegistry = createCapabilityRegistry();
  const capabilityAccessPolicy = createCapabilityAccessPolicy({
    capabilityRegistry,
    settingsService,
  });
  let capabilityRuntime = null;
  const agentCapabilityAdapters = createAgentCapabilityAdapters({
    connectionsService,
    contactProjectsService,
    recordCapabilityUsage: (input) => {
      if (!capabilityRuntime) throw new Error("Agent 能力运行时尚未初始化。 ");
      return capabilityRuntime.recordUsage(input);
    },
    settingsService,
  });
  const emojiStickerAgentCapability = createEmojiStickerAgentCapabilityAdapter({
    catalog: emojiStickerCatalog,
    deliver: (request) => {
      const delivery = conversation?.attachmentService;
      if (typeof delivery?.deliver !== "function") {
        throw new Error("表情暂时无法投放到聊天。");
      }
      return delivery.deliver(request);
    },
  });
  capabilityRuntime = createCapabilityRuntime({
    canInvoke: ({ capability, action, context }) => capabilityAccessPolicy.canInvoke({ capability, action, context }),
    registry: capabilityRegistry,
    adapters: {
      ...agentCapabilityAdapters,
      "emoji-sticker": emojiStickerAgentCapability,
      "agent-journal-schedule": () => requestAgentJournalScheduleSync(),
      "agent-journal-storage": ({ context }) => agentJournalService.removeContact({ contactId: clean(context.contactId) }),
      "conversation-attachment": ({ context }) => {
        const delivery = conversation?.attachmentService;
        if (typeof delivery?.deliver !== "function") {
          throw new Error("当前 Agent 聊天附件交付服务尚未就绪。 ");
        }
        return delivery.deliver({
          input: context.input,
          projectRoot: clean(context.projectRoot),
          sessionId: clean(context.sessionId),
        });
      },
      "contact-scheduled-task-cleanup": ({ context }) => removeScheduledContactTasks(context.contact),
      "cost-ledger": ({ capability, context }) => {
        const ledgerPath = clean(context.ledgerPath);
        const event = plainObject(context.event);
        if (!ledgerPath || !Object.keys(event).length) {
          throw new Error(`能力 ${capability.id} 的账单记录缺少流水路径或事件。`);
        }
        return appendUsageEvent(ledgerPath, {
          ...event,
          metadata: {
            ...plainObject(event.metadata),
            capabilityId: capability.id,
          },
        });
      },
      "mail-feedback-link": () => mailFeedbackService?.restart(),
      "proactive-contact-maintenance": ({ context }) => requestProactiveContactMaintenance({ scope: context.scope || null }),
      "realtime-voice-call": agentVoiceCallCapability,
    },
  });
  const capabilitiesService = createCapabilitiesService({
    capabilityRegistry,
    capabilityRuntime,
    connectionsService,
    contactProjectsService,
    settingsService,
    resolveContactSession: (contactId) => {
      if (typeof conversation?.reader?.resolveContactSession !== "function") {
        throw new Error("当前软件无法解析联系人的会话。 ");
      }
      return conversation.reader.resolveContactSession(contactId);
    },
  });
  registerSettingsIpc({
    app,
    appUpdateService,
    contactProjectsService,
    dataStorageService,
    dialog,
    getMainWindow,
    ipcMain: rendererIpcMain,
    onMemoryRecallEnabledChanged: ({ enabled }) => syncMemoryRecallHooks({ enabled }),
    releaseAnnouncementService,
    shell,
    settingsService,
  });
  registerAgentRuntimeConfigIpc({ ipcMain: rendererIpcMain, agentRuntimeConfigService });
  registerLedgerIpc({
    contactProjectsService,
    ipcMain: rendererIpcMain,
    settingsService,
    usageSubjects: [softwareAssistantSubject],
  });
  registerTodayCalendarIpc({ ipcMain: rendererIpcMain, todayCalendarService });
  registerCapabilitiesIpc({ ipcMain: rendererIpcMain, capabilitiesService });
  registerExternalCapabilitiesIpc({ dialog, getMainWindow, ipcMain: rendererIpcMain, externalCapabilitiesService });
  registerRelationshipFilesIpc({ ipcMain: rendererIpcMain, relationshipFilesService });
  registerAgentJournalIpc({ agentJournalService, ipcMain: rendererIpcMain });
  conversation = registerConversationIpc({
    app,
    clipboard,
    contactProjectsService,
    connectionsService,
    dialog,
    getMainWindow,
    ipcMain: rendererIpcMain,
    capabilityRegistry,
    capabilityRuntime,
    memoryRuntime: memoryService,
    nativeImage,
    emojiStickerCatalog,
    settingsService,
    shell,
    initializeContactCapabilities: async (contact) => {
      await capabilitiesService.initializeDefaultContactCapabilities(contact);
    },
    onContactLongTermMemoryEnabledChanged: () => syncMemoryRecallHooks(),
  });
  memoryService.setConversationReader(conversation.reader);
  // The memory database remains an independent local subsystem. Its optional
  // structured extraction calls the already-owned Agent Core model through a private
  // child-process bridge, never by copying credentials into this process.
  memoryService.setStructuredGenerationRuntime(conversation.agentRuntime);
  const softwareAssistantService = createSoftwareAssistantService({
    apiConnectionsSnapshot: () => connectionsService.apiServicesSnapshot(),
    applicationPath: typeof app?.getAppPath === "function" ? app.getAppPath() : "",
    applicationStatus: () => (
      typeof appUpdateService?.status === "function"
        ? appUpdateService.status()
        : { version: typeof app?.getVersion === "function" ? app.getVersion() : "" }
    ),
    contactSnapshot: () => (
      typeof contactProjectsService.visibleSnapshot === "function"
        ? contactProjectsService.visibleSnapshot()
        : contactProjectsService.snapshot().then(visibleContactProjectsSnapshot)
    ),
    createContact: (value) => conversation.reader.createContact(value),
    dataRoot,
    mainModelSnapshot: () => agentRuntimeConfigService.runtimeSnapshot(),
    readRelationshipFiles: (value) => relationshipFilesService.snapshotForContact(value),
    renameContact: (value) => conversation.reader.renameContact(value),
    runtime: conversation.agentRuntime,
    saveApiConnection: (value) => connectionsService.saveNamedApiConnection(value),
    saveMainModelConfiguration: (value) => agentRuntimeConfigService.saveModelConfiguration(value),
    saveRelationshipFile: (value) => relationshipFilesService.saveForContact(value),
    settingsService,
    updateContactLongTermMemoryEnabled: (value) => conversation.reader.updateContactLongTermMemoryEnabled(value),
    updateContactPermissionMode: (value) => conversation.reader.updateContactPermissionMode(value),
    updateContactPresentation: (value) => conversation.reader.updateContactPresentation(value),
    updateContactReasoningEffort: (value) => conversation.reader.updateContactReasoningEffort(value),
    usageLedger: conversation.usageLedger,
  });
  registerSoftwareAssistantIpc({ app, ipcMain: rendererIpcMain, softwareAssistantService });
  const conversationCompactorService = conversation.compactor;
  registerConversationCompactorIpc({
    ipcMain: rendererIpcMain,
    compactorService: conversationCompactorService,
  });
  // Automatic compaction is now a real Agent Core pre-step component. There is no
  // separate Electron timer to clean up: this noop keeps the existing orderly
  // shutdown shape without reviving the old JSONL scheduler.
  const unsubscribeCompactorAuto = () => {};
  removeScheduledContactTasks = async (contact) => {
    const contactId = clean(contact?.id);
    const contactProjectRoot = projectScopeKey(contact?.projectRoot);
    if (!contactId || !contactProjectRoot) return { removed: 0 };
    const tasks = await listScheduleTasks({ dataRoot });
    const targets = tasks.filter((task) => {
      const target = plainObject(task?.target);
      if (clean(target.contactId) === contactId) return true;
      return projectScopeKey(target.projectRoot) === contactProjectRoot;
    });
    for (const task of targets) await removeScheduleTask({ dataRoot, id: clean(task?.id) });
    return { removed: targets.length };
  };
  removeContactAssociations = async (contact) => {
    const contactId = clean(contact?.id);
    if (!contactId) throw new Error("要删除的联系人无效。 ");
    await eraseContactAgentConversation({ contact, contactProjectsService, conversation });
    if (typeof memoryService?.forgetContact === "function") {
      await memoryService.forgetContact({
        agentId: clean(contact?.agentId),
        sessionId: clean(contact?.sessionId),
      });
    }
    await capabilitiesService.removeContact({ contactId, contact });
    await todayCalendarService.removeContact({ contactId });
    if (typeof wechatService?.removeContact === "function") {
      await wechatService.removeContact({ contactId });
    }
    if (typeof qqService?.removeContact === "function") {
      await qqService.removeContact({ contactId });
    }
  };
  mailFeedbackService = createMailFeedbackLinkService({
    chat: conversation.chat,
    settingsProvider: () => settingsService.response(settingsService.load()),
    configuredTargets: () => capabilitiesService.enabledMailBridgeSessions(),
    packaged: app.isPackaged,
  });
  const scheduleSnapshot = async () => {
    const contactSnapshot = typeof contactProjectsService.visibleSnapshot === "function"
      ? await contactProjectsService.visibleSnapshot()
      : visibleContactProjectsSnapshot(await contactProjectsService.snapshot());
    const contacts = (Array.isArray(contactSnapshot?.contacts) ? contactSnapshot.contacts : [])
      .flatMap((contact) => {
        const id = clean(contact?.id);
        const name = clean(contact?.name);
        return id && name ? [{ id, name }] : [];
      });
    const contactById = new Map(contacts.map((contact) => [contact.id, contact]));
    const isVisibleConversationTask = (task) => (
      task?.target?.type !== "conversation"
      || contactById.has(clean(task?.target?.contactId))
    );
    const isInternalCompactor = (task) => (
      task?.source === "system"
      && task.target?.type === "operation"
      && task.target?.name === "conversation-compactor"
    );
    const presentTask = (summary, rawTask = null) => {
      if (summary?.target?.type !== "conversation") return summary;
      const target = {
        ...summary.target,
        prompt: clean(rawTask?.target?.prompt ?? summary.target?.prompt),
      };
      const contact = contactById.get(clean(summary.target.contactId));
      return contact
        ? { ...summary, target: { ...target, contact: { id: contact.id, name: contact.name } } }
        : { ...summary, target };
    };
    const [storedTasks, storedHistory] = await Promise.all([
      listScheduleTasks({ dataRoot }),
      listScheduleHistory({ dataRoot, limit: 100 }),
    ]);
    const proactiveSettings = capabilitiesService.proactiveContactSettings();
    const nextProactiveTaskByContact = new Map();
    for (const task of storedTasks) {
      const contactId = proactiveContactScopeKey(task?.target);
      if (!contactId || !isActiveProactiveContactTask(task, { contactId })) continue;
      const prior = nextProactiveTaskByContact.get(contactId);
      if (!prior || Date.parse(task.dueAt) < Date.parse(prior.dueAt)) nextProactiveTaskByContact.set(contactId, task);
    }
    const presentStoredTask = (task) => {
      const summary = presentTask(scheduleTaskSummary(task), task);
      const contactId = proactiveContactScopeKey(task?.target);
      return contactId && isProactiveContactTask(task, { contactId })
        ? { ...summary, systemKind: "proactive-contact" }
        : summary;
    };
    const tasks = storedTasks
      .filter((task) => !isInternalCompactor(task) && isVisibleConversationTask(task))
      .map(presentStoredTask);
    const history = storedHistory
      .filter((entry) => !isInternalCompactor(entry?.task) && isVisibleConversationTask(entry?.task))
      .map((entry) => ({ ...entry, task: presentTask(entry.task) }));
    return {
      contacts: contacts.map(({ id, name }) => ({ id, name })),
      contactsStatus: clean(contactSnapshot?.status) || "needs-root",
      history,
      proactiveContact: {
        autoMaintain: proactiveSettings?.autoMaintain === true,
        contacts: contacts.map(({ id, name }) => ({
          id,
          name,
          enabled: proactiveSettings?.enabledContactIds?.includes(id) === true,
          dueAt: clean(nextProactiveTaskByContact.get(id)?.dueAt),
        })),
      },
      tasks,
    };
  };
  rendererIpcMain.handle("schedule:snapshot", scheduleSnapshot);
  rendererIpcMain.handle("schedule:select-script", async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: "选择系统定时脚本",
      properties: ["openFile"],
      filters: [{ name: "支持的脚本", extensions: ["cmd", "bat", "py"] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const selected = await validateScheduledScriptPath(result.filePaths[0]);
    return { canceled: false, fileName: path.basename(selected.scriptPath), scriptPath: selected.scriptPath };
  });
  rendererIpcMain.handle("schedule:create", async (_event, value) => {
    const input = plainObject(value);
    const scheduleType = clean(input.scheduleType).toLowerCase();
    const targetType = clean(input.targetType).toLowerCase();
    const timing = scheduleType === "once"
      ? { delay: scheduleDelay(input) }
      : scheduleType === "daily"
        ? { cron: dailyCron(input.time) }
        : null;
    if (!timing) throw new Error("计划类型无效。 ");
    const common = {
      dataRoot,
      description: clean(input.description),
      source: "manual",
      ...timing,
    };
    let task;
    if (targetType === "contact") {
      const contactId = clean(input.contactId);
      await conversation.reader.resolveContactSession(contactId);
      task = await createScheduleTask({
        ...common,
        prompt: clean(input.prompt),
        contactId,
      });
    } else if (targetType === "system") {
      const selected = await validateScheduledScriptPath(input.scriptPath);
      task = await createScheduleTask({ ...common, scriptPath: selected.scriptPath });
    } else {
      throw new Error("计划主体无效。 ");
    }
    return { task: scheduleTaskSummary(task), snapshot: await scheduleSnapshot() };
  });
  rendererIpcMain.handle("schedule:set-enabled", async (_event, value) => {
    const input = plainObject(value);
    const task = await setScheduleTaskEnabled({
      dataRoot,
      id: clean(input.id),
      enabled: input.enabled,
    });
    if (!task) throw new Error("要更新的计划不存在。 ");
    return { task: scheduleTaskSummary(task), snapshot: await scheduleSnapshot() };
  });
  rendererIpcMain.handle("schedule:remove", async (_event, value) => {
    const input = plainObject(value);
    if (input.confirmed !== true) throw new Error("删除计划前需要明确确认。 ");
    const removed = await removeScheduleTask({ dataRoot, id: clean(input.id) });
    return { removed, snapshot: await scheduleSnapshot() };
  });
  let proactiveMaintenanceStopped = false;
  let proactiveMaintenance = Promise.resolve();
  let proactiveContactTransition = Promise.resolve();
  const checkProactiveContactChecks = ({
    scope = null,
    now = new Date(),
    nextTaskDelay = PROACTIVE_CONTACT_INITIAL_DELAY,
  } = {}) => {
    const next = proactiveMaintenance
      .catch(() => undefined)
      .then(() => queueProactiveContactTransition(() => {
        if (proactiveMaintenanceStopped) return [];
        return maintainProactiveContactChecks({
          dataRoot,
          hasPendingScheduledTurn: ({ contactId }) => (
            conversation.chat.hasPendingTurn?.({
              contactId,
              kind: "schedule",
              scheduleSource: PROACTIVE_CONTACT_TURN_SOURCE,
            }) === true
            || conversation.chat.hasPendingTurn?.({
              contactId,
              kind: "schedule",
              scheduleSource: PROACTIVE_CONTACT_TIMING_TURN_SOURCE,
            }) === true
          ),
          now,
          nextTaskDelay,
          scope,
          settings: capabilitiesService.proactiveContactSettings(),
        });
      }));
    proactiveMaintenance = next;
    return next;
  };
  requestProactiveContactMaintenance = ({ scope = null } = {}) => checkProactiveContactChecks({ scope });
  const proactiveContactEnabled = (contactId) => {
    const id = proactiveContactScopeKey({ contactId });
    if (!id) return false;
    const settings = capabilitiesService.proactiveContactSettings();
    return settings?.autoMaintain === true
      && settings.enabledContactIds?.includes(id) === true
      && capabilitiesService.isCompanionContactEnabled({ abilityId: "proactive-contact", contactId: id }) === true;
  };
  function queueProactiveContactTransition(operation) {
    const next = proactiveContactTransition
      .catch(() => undefined)
      .then(() => proactiveMaintenanceStopped ? undefined : operation());
    proactiveContactTransition = next;
    return next;
  }
  const createProactiveContactRecovery = async (contactId) => {
    if (!proactiveContactEnabled(contactId)) return null;
    return scheduleNextProactiveContactCheck({
      dataRoot,
      contactId,
      delay: PROACTIVE_CONTACT_RECOVERY_DELAY,
    });
  };
  const proactiveContactRequests = new Map();
  const startProactiveContactTimingTurn = async ({ contactId, task } = {}) => {
    if (!proactiveContactEnabled(contactId)) return null;
    const requestId = proactiveContactTimingRequestId(task);
    if (!requestId) throw new Error("主动关心缺少任务标识。 ");
    const target = await conversation.reader.resolveContactSession(contactId);
    proactiveContactRequests.set(requestId, {
      contactId,
      content: "",
      phase: "timing",
      task,
    });
    try {
      const result = await conversation.chat.sendTaskToSession({
        taskContext: {
          id: `${clean(task?.id)}-timing`,
          text: proactiveContactTimingTaskPrompt(),
        },
        contactId,
        sessionId: target.id,
        projectRoot: target.projectRoot,
        hasTranscript: target.hasTranscript === true,
        kind: "schedule",
        scheduleSource: PROACTIVE_CONTACT_TIMING_TURN_SOURCE,
        requestId,
        deliverToWechat: false,
        outputPolicy: "silent",
        resultChannel: "internal",
      });
      if (result?.accepted !== true) {
        proactiveContactRequests.delete(requestId);
        await createProactiveContactRecovery(contactId);
      }
      return result;
    } catch (error) {
      proactiveContactRequests.delete(requestId);
      await createProactiveContactRecovery(contactId);
      throw error;
    }
  };
  const unsubscribeProactiveContactTurns = conversation.chat.subscribe((event) => {
    const requestId = clean(event?.requestId);
    const request = proactiveContactRequests.get(requestId);
    if (!request) return;
    if (event?.type === "internal-result" && request.phase === "timing") {
      request.content = clean(event.content);
      return;
    }
    if (!["turn-complete", "turn-stopped", "error"].includes(event?.type)) return;
    proactiveContactRequests.delete(requestId);
    void queueProactiveContactTransition(async () => {
      if (!proactiveContactEnabled(request.contactId)) return;
      if (event.type === "turn-complete" && request.phase === "contact") {
        await startProactiveContactTimingTurn(request);
        return;
      }
      if (event.type === "turn-complete" && request.phase === "timing") {
        const decision = proactiveContactTimingDecision(request.content);
        if (decision) {
          await scheduleNextProactiveContactCheck({
            dataRoot,
            contactId: request.contactId,
            delay: decision.delay,
            nextCheckPurpose: decision.nextCheckPurpose,
          });
          return;
        }
      }
      await createProactiveContactRecovery(request.contactId);
    }).catch(() => undefined);
  });
  const agentJournalRequests = new Map();
  const unsubscribeAgentJournalTurns = conversation.chat.subscribe((event) => {
    const requestId = clean(event?.requestId);
    const request = agentJournalRequests.get(requestId);
    if (!request) return;
    // Agent Core keeps scheduled replies out of the live stream and emits
    // `agent-reply`, which the product-owned journal writer consumes.
    if ((event?.type === "reply" && event?.done === true) || event?.type === "agent-reply") {
      request.content = clean(event.content);
      return;
    }
    if (!["turn-complete", "turn-stopped", "error"].includes(event?.type)) return;
    agentJournalRequests.delete(requestId);
    if (event.type !== "turn-complete" || !request.content || request.content === "NO_REPLY") return;
    void agentJournalService.record({
      contactId: request.contactId,
      content: request.content,
      date: request.date,
      sessionId: request.sessionId,
    }).catch(() => undefined);
  });
  const syncEnabledAgentJournalSchedule = async () => {
    const targets = await capabilitiesService.enabledCompanionSessions("agent-journal");
    const settings = capabilitiesService.agentJournalSettings();
    return syncAgentJournalSchedule({
      dataRoot,
      hasEnabledContacts: targets.length > 0,
      time: settings.time,
    });
  };
  requestAgentJournalScheduleSync = syncEnabledAgentJournalSchedule;
  const scheduleRunner = createScheduleRunner({
    dataRoot,
    onConversationTask: async (task) => {
      const contactId = clean(task.target.contactId);
      if (!contactId) return undefined;
      const phase = proactiveContactTaskPhase(task, contactId);
      if (isRetiredProactiveContactTask(task, { contactId })) return undefined;
      if (isProactiveContactTask(task, { contactId }) && !phase) return undefined;
      if (phase && !proactiveContactEnabled(contactId)) return undefined;
      const agentCreatedSchedule = clean(task.source) === "agent";
      const scheduleSource = phase === "contact"
        ? PROACTIVE_CONTACT_TURN_SOURCE
        : agentCreatedSchedule
          ? "agent-schedule"
          : "";
      const requestId = proactiveContactRequestId(task, phase);
      const target = await conversation.reader.resolveContactSession(contactId);
      if (phase) {
        proactiveContactRequests.set(requestId, { contactId, content: "", phase, task });
        try {
          const result = await conversation.chat.sendTaskToSession({
            taskContext: {
              id: task.id,
              text: proactiveContactTaskPrompt({
                nextCheckPurpose: proactiveContactTaskPurpose(task),
              }),
            },
            contactId,
            sessionId: target.id,
            projectRoot: target.projectRoot,
            hasTranscript: target.hasTranscript === true,
            kind: "schedule",
            scheduleSource,
            requestId,
            // Proactive contact is product-owned broadcast delivery. The Agent
            // only produces the reply; each connected transport decides how
            // to deliver it from this internal route.
            deliveryRoute: { mode: "proactive" },
            deliverToWechat: true,
            outputPolicy: "external",
          });
          if (result?.accepted !== true) {
            proactiveContactRequests.delete(requestId);
            void queueProactiveContactTransition(() => createProactiveContactRecovery(contactId)).catch(() => undefined);
          }
          return result;
        } catch (error) {
          proactiveContactRequests.delete(requestId);
          void queueProactiveContactTransition(() => createProactiveContactRecovery(contactId)).catch(() => undefined);
          throw error;
        }
      }
      return conversation.chat.sendToSession({
        content: scheduledTaskContent(task),
        contactId,
        sessionId: target.id,
        projectRoot: target.projectRoot,
        hasTranscript: target.hasTranscript === true,
        kind: "schedule",
        scheduleSource,
        requestId,
        deliverToWechat: agentCreatedSchedule,
      });
    },
    onOperationTask: async (task) => {
      if (task.target.type === "script") {
        await runScheduledScript(task.target.scriptPath);
        return;
      }
      if (task.target.name === "conversation-compactor") {
        await conversationCompactorService.runScheduledAutomaticTask(task);
        return;
      }
      if (task.target.name === "agent-journal") {
        const targets = await capabilitiesService.enabledCompanionSessions("agent-journal");
        if (!targets.length) return;
        const date = localJournalDate();
        const deliveries = await Promise.allSettled(targets.map(async (target) => {
          const requestId = `suzu-agent-journal-${task.id}-${date}-${target.contactId}`;
          agentJournalRequests.set(requestId, {
            contactId: target.contactId,
            content: "",
            date,
            sessionId: target.sessionId,
          });
          try {
            const result = await conversation.chat.sendToSession({
              content: scheduledTaskContent(task, {
                displayAsSystem: true,
                prompt: agentJournalTaskPrompt(date),
              }),
              contactId: target.contactId,
              sessionId: target.sessionId,
              projectRoot: target.projectRoot,
              hasTranscript: target.hasTranscript === true,
              kind: "schedule",
              scheduleSource: "agent-journal",
              requestId,
              displayAsSystem: true,
              deliverToWechat: false,
            });
            if (result?.accepted !== true) agentJournalRequests.delete(requestId);
            return result;
          } catch (error) {
            agentJournalRequests.delete(requestId);
            throw error;
          }
        }));
        const failed = deliveries.find((delivery) => delivery.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        return;
      }
    },
  });
  let backgroundStartup = null;
  let memoryRecovery = null;
  let memoryRecoveryTimer = null;
  app?.once?.("before-quit", () => {
    unsubscribeCompactorAuto();
    unsubscribeProactiveContactTurns();
    unsubscribeAgentJournalTurns();
    proactiveMaintenanceStopped = true;
    proactiveContactRequests.clear();
    agentJournalRequests.clear();
    scheduleRunner.stop();
    if (memoryRecoveryTimer) {
      clearTimeout(memoryRecoveryTimer);
      memoryRecoveryTimer = null;
    }
    // 退出时停掉 Agent Core 子进程，避免关掉软件后进程残留（残留会挡住重装/卸载）。
    void conversation?.agentRuntime?.close?.().catch?.(() => undefined);
    // 退出时停掉专用浏览器进程。
    void stopWebBrowser({ dataRoot }).catch(() => undefined);
  });
  app?.once?.("before-quit", () => mailFeedbackService?.dispose());
  app?.once?.("before-quit", () => memoryService.dispose());
  wechatService = createWeChatLinkService({
    chat: conversation.chat,
    dataRoot,
    reader: conversation.reader,
  });
  registerWechatIpc({ app, ipcMain: rendererIpcMain, wechatService });
  qqService = createQQLinkService({
    chat: conversation.chat,
    dataRoot,
    reader: conversation.reader,
    safeStorage,
  });
  registerQQIpc({ app, ipcMain: rendererIpcMain, qqService });
  const scheduleMemoryRecovery = () => {
    if (memoryRecovery || memoryRecoveryTimer) return;
    // Database recovery can touch every contact. Give the shell time to stay
    // interactive before beginning that non-urgent maintenance pass.
    memoryRecoveryTimer = setTimeout(() => {
      memoryRecoveryTimer = null;
      memoryRecovery = memoryService.resumeExistingMaintenance().catch(() => undefined);
    }, 1_500);
  };
  const startBackgroundServices = () => {
    if (backgroundStartup) return backgroundStartup;
    backgroundStartup = Promise.all([
      // This writes the installation-time time-zone choice once. Individual
      // turns only read that stored value; they never rediscover it.
      ensureTimeAwarenessConfig({ dataRoot }).catch(() => undefined),
      capabilitiesService.refreshManagedRegistrations().catch(() => undefined),
      Promise.all([
        capabilityRuntime.sync({ capabilityId: "agent-journal", reason: "startup" }),
        capabilityRuntime.sync({ capabilityId: "proactive-contact", reason: "startup" }),
      ])
        .catch(() => undefined)
        .then(() => scheduleRunner.start())
        .then(() => checkProactiveContactChecks())
        .catch(() => undefined),
      mailFeedbackService.start().catch(() => undefined),
      wechatService.start().catch(() => undefined),
      qqService.start().catch(() => undefined),
    ]).then(() => undefined);
    scheduleMemoryRecovery();
    return backgroundStartup;
  };
  rendererIpcMain.handle("app-lifecycle:renderer-ready", (event) => {
    if (event.sender !== getMainWindow()?.webContents) return { accepted: false };
    void startBackgroundServices();
    return { accepted: true };
  });
  registerConnectionsIpc({ ipcMain: rendererIpcMain, connectionsService });
  registerImageWorkbenchIpc({
    connectionsService,
    ipcMain: rendererIpcMain,
    nativeImage,
    settingsService,
    recordCapabilityUsage: (input) => capabilityRuntime.recordUsage(input),
  });
  registerVisualReferencesIpc({ contactProjectsService, dialog, getMainWindow, ipcMain: rendererIpcMain, nativeImage, settingsService });
  registerVoiceDesignIpc({ connectionsService, contactProjectsService, ipcMain: rendererIpcMain, settingsService });
  registerMemoryIpc({ dialog, getMainWindow, ipcMain: rendererIpcMain, memoryService });
}
