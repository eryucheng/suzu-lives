import { dialog, ipcMain, nativeImage, safeStorage, shell } from "electron";
import path from "node:path";

import { createCapabilitiesService, packagedCliCommand, registerCapabilitiesIpc } from "./capabilities-ipc.mjs";
import { registerConversationCompactorIpc } from "./conversation-compactor-ipc.mjs";
import { createExternalCapabilitiesIpcService, registerExternalCapabilitiesIpc } from "./external-capabilities-ipc.mjs";
import { registerConversationIpc } from "./conversation-ipc.mjs";
import { registerWechatIpc } from "./wechat-ipc.mjs";
import { createConnectionsService, registerConnectionsIpc } from "./connections-ipc.mjs";
import { registerLedgerIpc } from "./ledger-ipc.mjs";
import { registerImageWorkbenchIpc } from "./image-workbench-ipc.mjs";
import { registerMemoryIpc } from "./memory-ipc.mjs";
import { createLongTermMemoryService } from "../services/long-term-memory-service.mjs";
import { createConversationCompactorService } from "../services/conversation-compactor-service.mjs";
import { createRelationshipFilesService, registerRelationshipFilesIpc } from "../services/relationship-files.mjs";
import { createSettingsService, registerSettingsIpc } from "./settings-ipc.mjs";
import { registerVisualReferencesIpc } from "./visual-references-ipc.mjs";
import { registerVoiceDesignIpc } from "./voice-design-ipc.mjs";
import { registerTodayCalendarIpc } from "./today-calendar-ipc.mjs";
import { createProjectHooksService } from "../services/project-hooks.mjs";
import { createAgentRuntimeConfigService, registerAgentRuntimeConfigIpc } from "../services/agent-runtime-config.mjs";
import { createTodayCalendarService } from "../services/today-calendar.mjs";
import { createWeChatLinkService } from "../services/wechat-link.mjs";
import { createIphoneFeedbackLinkService } from "../services/iphone-feedback-link.mjs";
import { createContactProjectsService } from "../services/contact-projects.mjs";
import {
  isActiveProactiveChainTask,
  maintainProactiveContactChains,
  proactiveContactScopeKey,
} from "../services/proactive-contact-maintenance.mjs";
import { runScheduledScript, validateScheduledScriptPath } from "../services/scheduled-script.mjs";
import { ensureSuzuClaudeProjectSettings } from "@suzu-lives/claude-integration";
import {
  createScheduleRunner,
  createScheduleTask,
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

function scheduledTaskContent(task) {
  return [
    "<suzu-schedule-task>",
    `任务说明：${clean(task?.description) || "自动任务"}`,
    "这是 Suzu 自动任务触发，不是用户发来的新消息。请处理下方任务；如无需对用户可见的回复，只输出精确的 NO_REPLY。",
    "",
    clean(task?.target?.prompt),
    "</suzu-schedule-task>",
  ].join("\n");
}

export function registerIpcHandlers({ app, appUpdateService = null, dataStorageService, getMainWindow, settingsService, wechatAttachmentCli = "", cliLauncherCommand = "", claudeWorkspaceDirectories = [] }) {
  const currentCliLauncher = clean(cliLauncherCommand) || (app.isPackaged ? packagedCliCommand(app.getPath("exe")) : "");
  const dataRoot = settingsService.response(settingsService.load()).dataRoot;
  let removeContactAssociations = async () => undefined;
  let wechatService = null;
  const contactProjectsService = createContactProjectsService({
    settingsService,
    dataRoot,
    onBeforeRemove: (contact) => removeContactAssociations(contact),
    ensureClaudeProjectSettings: ({ projectRoot, previousProjectDefaults }) => {
      if (!currentCliLauncher) return { status: "development" };
      return ensureSuzuClaudeProjectSettings({
        projectRoot,
        launcher: { command: currentCliLauncher, available: true },
        previousProjectDefaults,
        projectDefaults: settingsService.load()?.claudeProjectDefaults,
        toolPermissions: settingsService.load()?.claudeToolPermissions,
        workspaceDirectories: claudeWorkspaceDirectories,
      });
    },
  });
  const initialClaudeSettingsSync = contactProjectsService.syncClaudeProjectSettings();
  void initialClaudeSettingsSync.catch(() => undefined);
  const connectionsService = createConnectionsService({ safeStorage, settingsService });
  const externalCapabilitiesService = createExternalCapabilitiesIpcService({ settingsService });
  const agentRuntimeConfigService = createAgentRuntimeConfigService();
  const memoryService = createLongTermMemoryService({
    connectionsService,
    contactProjectsService,
    settingsService,
    textModelConnectionResolver: () => agentRuntimeConfigService.resolveClaudeCodeGenerationConnection(),
  });
  const todayCalendarService = createTodayCalendarService({ contactProjectsService, settingsService });
  const relationshipFilesService = createRelationshipFilesService({ settingsService });
  const projectHooksService = createProjectHooksService({
    settingsService,
    executablePath: app.getPath("exe"),
    packaged: app.isPackaged,
  });
  let iphoneFeedbackService = null;
  let conversation = null;
  let requestProactiveContactMaintenance = () => undefined;
  const capabilitiesService = createCapabilitiesService({
    contactProjectsService,
    settingsService,
    packaged: app.isPackaged,
    executablePath: app.getPath("exe"),
    launcherCommand: currentCliLauncher,
    projectHooksService,
    onIphoneFeedbackChange: () => iphoneFeedbackService?.restart(),
    onProactiveContactMaintenanceRequested: (request) => requestProactiveContactMaintenance(request),
    resolveContactSession: (contactId) => {
      if (typeof conversation?.reader?.resolveContactSession !== "function") {
        throw new Error("当前软件无法解析联系人的会话。 ");
      }
      return conversation.reader.resolveContactSession(contactId);
    },
  });
  void initialClaudeSettingsSync
    .catch(() => undefined)
    .then(() => capabilitiesService.refreshManagedRegistrations())
    .catch(() => undefined);
  registerSettingsIpc({
    app,
    appUpdateService,
    contactProjectsService,
    dataStorageService,
    dialog,
    getMainWindow,
    ipcMain,
    shell,
    settingsService,
  });
  registerAgentRuntimeConfigIpc({ ipcMain, agentRuntimeConfigService });
  registerLedgerIpc({ contactProjectsService, ipcMain, settingsService });
  registerTodayCalendarIpc({ ipcMain, todayCalendarService });
  registerCapabilitiesIpc({ ipcMain, capabilitiesService });
  registerExternalCapabilitiesIpc({ dialog, getMainWindow, ipcMain, externalCapabilitiesService });
  registerRelationshipFilesIpc({ ipcMain, relationshipFilesService });
  conversation = registerConversationIpc({
    app,
    contactProjectsService,
    connectionsService,
    ipcMain,
    memoryRuntime: memoryService,
    settingsService,
    shell,
    wechatAttachmentCli,
    claudeWorkspaceDirectories,
    initializeContactCapabilities: (contact) => capabilitiesService.initializeDefaultContactCapabilities(contact),
    proactiveContactSettings: () => capabilitiesService.proactiveContactSettings(),
    isProactiveContactEnabled: ({ contactId }) => capabilitiesService.isCompanionContactEnabled({
      abilityId: "proactive-contact", contactId,
    }),
  });
  memoryService.setConversationReader(conversation.reader);
  void memoryService.resumeExistingMaintenance().catch(() => undefined);
  const conversationCompactorService = createConversationCompactorService({
    reader: conversation.reader,
    settingsService,
  });
  registerConversationCompactorIpc({ ipcMain, compactorService: conversationCompactorService });
  const unsubscribeCompactorAuto = conversation.chat.subscribe((event) => {
    if (event?.type !== "turn-complete") return;
    // Token-triggered compaction is still executed by the shared scheduler;
    // the completed local turn only asks it to enqueue a scoped one-shot job.
    void conversationCompactorService.enqueueTokenAuto({
      projectRoot: event.projectRoot,
      sessionId: event.sessionId,
    }).catch(() => undefined);
  });
  const removeScheduledContactTasks = async (contact) => {
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
    await capabilitiesService.removeContact({ contactId });
    await removeScheduledContactTasks(contact);
    await todayCalendarService.removeContact({ contactId });
    if (typeof wechatService?.removeContact === "function") {
      await wechatService.removeContact({ contactId });
    }
  };
  iphoneFeedbackService = createIphoneFeedbackLinkService({
    chat: conversation.chat,
    settingsProvider: () => settingsService.response(settingsService.load()),
    configuredTargets: () => capabilitiesService.enabledIphoneBridgeSessions(),
    packaged: app.isPackaged,
  });
  const scheduleSnapshot = async () => {
    const contactSnapshot = await contactProjectsService.snapshot();
    const contacts = (Array.isArray(contactSnapshot?.contacts) ? contactSnapshot.contacts : [])
      .flatMap((contact) => {
        const id = clean(contact?.id);
        const name = clean(contact?.name);
        return id && name ? [{ id, name }] : [];
      });
    const contactById = new Map(contacts.map((contact) => [contact.id, contact]));
    const tasks = (await listScheduleTasks({ dataRoot }))
      .filter((task) => !(
        task.source === "system"
        && task.target?.type === "operation"
        && task.target?.name === "conversation-compactor"
      ))
      .map((task) => {
        const summary = scheduleTaskSummary(task);
        if (summary.target?.type !== "conversation") return summary;
        const target = { ...summary.target, prompt: clean(task.target?.prompt) };
        const contact = contactById.get(clean(summary.target.contactId));
        return contact
          ? { ...summary, target: { ...target, contact: { id: contact.id, name: contact.name } } }
          : { ...summary, target };
      });
    return {
      contacts: contacts.map(({ id, name }) => ({ id, name })),
      contactsStatus: clean(contactSnapshot?.status) || "needs-root",
      tasks,
    };
  };
  ipcMain.handle("schedule:snapshot", scheduleSnapshot);
  ipcMain.handle("schedule:select-script", async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: "选择系统定时脚本",
      properties: ["openFile"],
      filters: [{ name: "支持的脚本", extensions: ["cmd", "bat", "py"] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const selected = await validateScheduledScriptPath(result.filePaths[0]);
    return { canceled: false, fileName: path.basename(selected.scriptPath), scriptPath: selected.scriptPath };
  });
  ipcMain.handle("schedule:create", async (_event, value) => {
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
  ipcMain.handle("schedule:set-enabled", async (_event, value) => {
    const input = plainObject(value);
    const task = await setScheduleTaskEnabled({
      dataRoot,
      id: clean(input.id),
      enabled: input.enabled,
    });
    if (!task) throw new Error("要更新的计划不存在。 ");
    return { task: scheduleTaskSummary(task), snapshot: await scheduleSnapshot() };
  });
  ipcMain.handle("schedule:remove", async (_event, value) => {
    const input = plainObject(value);
    if (input.confirmed !== true) throw new Error("删除计划前需要明确确认。 ");
    const removed = await removeScheduleTask({ dataRoot, id: clean(input.id) });
    return { removed, snapshot: await scheduleSnapshot() };
  });
  let proactiveMaintenanceStopped = false;
  let proactiveMaintenance = Promise.resolve();
  const delayedProactiveMaintenanceChecks = new Map();
  const checkProactiveContactChains = ({ scope = null, now = new Date() } = {}) => {
    const next = proactiveMaintenance
      .catch(() => undefined)
      .then(() => {
        if (proactiveMaintenanceStopped) return [];
        return maintainProactiveContactChains({
          dataRoot,
          now,
          scope,
          settings: capabilitiesService.proactiveContactSettings(),
        });
      });
    proactiveMaintenance = next;
    return next;
  };
  const scheduleProactiveContactChainCheck = ({ scope = null, delayMs = 60_000 } = {}) => {
    if (proactiveMaintenanceStopped) return;
    const target = scope ? { contactId: clean(scope.contactId) } : null;
    const key = target ? proactiveContactScopeKey(target) : "all";
    if (target && !key) return;
    const timeout = Number.isSafeInteger(delayMs) && delayMs >= 0 ? delayMs : 60_000;
    const prior = delayedProactiveMaintenanceChecks.get(key);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => {
      delayedProactiveMaintenanceChecks.delete(key);
      void checkProactiveContactChains({ scope: target }).catch(() => undefined);
    }, timeout);
    timer?.unref?.();
    delayedProactiveMaintenanceChecks.set(key, timer);
  };
  requestProactiveContactMaintenance = scheduleProactiveContactChainCheck;
  const scheduleRunner = createScheduleRunner({
    dataRoot,
    onConversationTask: async (task) => {
      const contactId = clean(task.target.contactId);
      if (!contactId) return undefined;
      if (task.source !== "manual" && !capabilitiesService.isCompanionContactEnabled({
        abilityId: "proactive-contact",
        contactId,
      })) return undefined;
      const target = await conversation.reader.resolveContactSession(contactId);
      const result = await conversation.chat.sendToSession({
        content: scheduledTaskContent(task),
        contactId,
        sessionId: target.id,
        projectRoot: target.projectRoot,
        hasTranscript: target.hasTranscript === true,
        kind: "schedule",
      });
      if (isActiveProactiveChainTask(task, { contactId })) {
        scheduleProactiveContactChainCheck({ scope: { contactId } });
      }
      return result;
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
    },
  });
  app?.once?.("before-quit", () => {
    unsubscribeCompactorAuto();
    proactiveMaintenanceStopped = true;
    for (const timer of delayedProactiveMaintenanceChecks.values()) clearTimeout(timer);
    delayedProactiveMaintenanceChecks.clear();
    scheduleRunner.stop();
  });
  void scheduleRunner.start()
    .then(() => checkProactiveContactChains())
    .catch(() => undefined);
  app?.once?.("before-quit", () => iphoneFeedbackService?.dispose());
  app?.once?.("before-quit", () => memoryService.dispose());
  void iphoneFeedbackService.start().catch(() => undefined);
  wechatService = createWeChatLinkService({
    chat: conversation.chat,
    dataRoot,
    reader: conversation.reader,
  });
  registerWechatIpc({ app, ipcMain, wechatService });
  void wechatService.start().catch(() => undefined);
  registerConnectionsIpc({ ipcMain, connectionsService });
  registerImageWorkbenchIpc({ connectionsService, ipcMain, nativeImage, settingsService });
  registerVisualReferencesIpc({ contactProjectsService, dialog, getMainWindow, ipcMain, nativeImage, settingsService });
  registerVoiceDesignIpc({ connectionsService, contactProjectsService, ipcMain, settingsService });
  registerMemoryIpc({ dialog, getMainWindow, ipcMain, memoryService });
}
