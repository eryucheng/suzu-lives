import { dialog, ipcMain, nativeImage, safeStorage, shell } from "electron";

import { createCapabilitiesService, packagedCliCommand, registerCapabilitiesIpc } from "./capabilities-ipc.mjs";
import { registerConversationIpc } from "./conversation-ipc.mjs";
import { registerWechatIpc } from "./wechat-ipc.mjs";
import { createConnectionsService, registerConnectionsIpc } from "./connections-ipc.mjs";
import { registerLedgerIpc } from "./ledger-ipc.mjs";
import { registerImageWorkbenchIpc } from "./image-workbench-ipc.mjs";
import { registerMemoryIpc } from "./memory-ipc.mjs";
import { createMemoryService } from "../services/memory-service.mjs";
import { createRelationshipFilesService, registerRelationshipFilesIpc } from "../services/relationship-files.mjs";
import { createSettingsService, registerSettingsIpc } from "./settings-ipc.mjs";
import { registerVisualReferencesIpc } from "./visual-references-ipc.mjs";
import { registerVoiceDesignIpc } from "./voice-design-ipc.mjs";
import { registerTodayCalendarIpc } from "./today-calendar-ipc.mjs";
import { createProjectHooksService, registerProjectHooksIpc } from "../services/project-hooks.mjs";
import { createAgentRuntimeConfigService, registerAgentRuntimeConfigIpc } from "../services/agent-runtime-config.mjs";
import { createTodayCalendarService } from "../services/today-calendar.mjs";
import { createWeChatLinkService } from "../services/wechat-link.mjs";
import { createIphoneFeedbackLinkService } from "../services/iphone-feedback-link.mjs";
import { createContactProjectsService } from "../services/contact-projects.mjs";
import { ensureSuzuClaudeProjectSettings } from "@suzu-lives/claude-integration";
import { createScheduleRunner, listScheduleTasks, scheduleTaskSummary } from "@suzu-lives/task-scheduler";
import { runTravelingMerchant } from "@suzu-lives/traveling-merchant";

export { createSettingsService };

function clean(value) {
  return String(value ?? "").trim();
}

function merchantResult(execution) {
  const source = clean(execution?.stdout);
  if (!source) throw new Error("远行商人执行器没有返回结果。 ");
  let result;
  try { result = JSON.parse(source); }
  catch { throw new Error("远行商人执行器返回的结果格式无效。 "); }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("远行商人执行器返回的结果格式无效。 ");
  }
  return result;
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

function merchantTaskContent(message) {
  return [
    "<suzu-merchant-task>",
    "这是 Suzu 读取远行商人网页后的结果，不是用户发来的新消息。请将下方内容原样作为面向用户的最终回复，不要添加前缀、解释或自动任务说明。",
    "",
    message,
    "</suzu-merchant-task>",
  ].join("\n");
}

export function registerIpcHandlers({ app, dataStorageService, getMainWindow, settingsService, wechatAttachmentCli = "" }) {
  const contactProjectsService = createContactProjectsService({
    settingsService,
    ensureClaudeProjectSettings: ({ projectRoot }) => {
      if (!app.isPackaged) return { status: "development" };
      return ensureSuzuClaudeProjectSettings({
        projectRoot,
        launcher: { command: packagedCliCommand(app.getPath("exe")), available: true },
        toolPermissions: settingsService.load()?.claudeToolPermissions,
      });
    },
  });
  void contactProjectsService.syncClaudeProjectSettings().catch(() => undefined);
  const connectionsService = createConnectionsService({ safeStorage, settingsService });
  const memoryService = createMemoryService({
    settingsService,
    connectionResolver: ({ kind }) => connectionsService.resolveNamedApiConnection(kind),
  });
  const todayCalendarService = createTodayCalendarService({ settingsService });
  const relationshipFilesService = createRelationshipFilesService({ settingsService });
  const agentRuntimeConfigService = createAgentRuntimeConfigService({ settingsService });
  const projectHooksService = createProjectHooksService({
    settingsService,
    executablePath: app.getPath("exe"),
    packaged: app.isPackaged,
  });
  let iphoneFeedbackService = null;
  const capabilitiesService = createCapabilitiesService({
    settingsService,
    packaged: app.isPackaged,
    executablePath: app.getPath("exe"),
    openExternal: (url) => shell.openExternal(url),
    projectHooksService,
    onIphoneFeedbackChange: () => iphoneFeedbackService?.restart(),
  });
  registerSettingsIpc({
    app,
    contactProjectsService,
    dataStorageService,
    dialog,
    getMainWindow,
    ipcMain,
    shell,
    settingsService,
  });
  registerAgentRuntimeConfigIpc({ ipcMain, agentRuntimeConfigService });
  registerLedgerIpc({ ipcMain, settingsService });
  registerTodayCalendarIpc({ ipcMain, todayCalendarService });
  registerCapabilitiesIpc({ ipcMain, capabilitiesService });
  registerRelationshipFilesIpc({ ipcMain, relationshipFilesService });
  registerProjectHooksIpc({ ipcMain, projectHooksService });
  const conversation = registerConversationIpc({
    app,
    contactProjectsService,
    ipcMain,
    settingsService,
    shell,
    wechatAttachmentCli,
    proactiveContactSettings: () => capabilitiesService.proactiveContactSettings(),
    isProactiveContactEnabled: ({ sessionId, projectRoot }) => capabilitiesService.isCompanionSessionEnabled({
      abilityId: "proactive-contact", sessionId, projectRoot,
    }),
    hasTravelingMerchantRecipients: () => capabilitiesService.enabledCompanionSessions("traveling-merchant").length > 0,
  });
  const dataRoot = settingsService.response(settingsService.load()).dataRoot;
  iphoneFeedbackService = createIphoneFeedbackLinkService({
    chat: conversation.chat,
    settingsProvider: () => settingsService.response(settingsService.load()),
    configuredTargets: () => capabilitiesService.enabledIphoneBridgeSessions(),
    packaged: app.isPackaged,
  });
  ipcMain.handle("schedule:snapshot", async () => ({
    tasks: (await listScheduleTasks({ dataRoot })).map((task) => scheduleTaskSummary(task)),
  }));
  const scheduleRunner = createScheduleRunner({
    dataRoot,
    onConversationTask: (task) => {
      if (!capabilitiesService.isCompanionSessionEnabled({
        abilityId: "proactive-contact",
        sessionId: task.target.sessionId,
        projectRoot: task.target.projectRoot,
      })) return undefined;
      return conversation.chat.sendToSession({
        content: scheduledTaskContent(task),
        sessionId: task.target.sessionId,
        projectRoot: task.target.projectRoot,
        hasTranscript: true,
        kind: "schedule",
      });
    },
    onOperationTask: async (task) => {
      if (task.target.name !== "traveling-merchant") return;
      const targets = capabilitiesService.enabledCompanionSessions("traveling-merchant");
      if (!targets.length) return;
      const execution = await runTravelingMerchant(["--data-root", dataRoot]);
      const result = merchantResult(execution);
      const message = clean(result.message);
      if (result.deliveryReady !== true || !message) return;
      const deliveries = await Promise.allSettled(targets.map((target) => conversation.chat.sendToSession({
        content: merchantTaskContent(message),
        sessionId: target.sessionId,
        projectRoot: target.projectRoot,
        hasTranscript: true,
        kind: "schedule",
      })));
      const failed = deliveries.find((delivery) => delivery.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
  });
  app?.once?.("before-quit", () => scheduleRunner.stop());
  void scheduleRunner.start().catch(() => undefined);
  app?.once?.("before-quit", () => iphoneFeedbackService?.dispose());
  void iphoneFeedbackService.start().catch(() => undefined);
  const wechatService = createWeChatLinkService({
    chat: conversation.chat,
    dataRoot,
    reader: conversation.reader,
  });
  registerWechatIpc({ app, ipcMain, wechatService });
  void wechatService.start().catch(() => undefined);
  registerConnectionsIpc({ ipcMain, connectionsService });
  registerImageWorkbenchIpc({ connectionsService, ipcMain, nativeImage, settingsService });
  registerVisualReferencesIpc({ dialog, getMainWindow, ipcMain, nativeImage, settingsService });
  registerVoiceDesignIpc({ connectionsService, ipcMain, settingsService });
  registerMemoryIpc({ ipcMain, settingsService, memoryService });
}
