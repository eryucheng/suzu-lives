import { state } from "./core/state.mjs";
import { TEXT_MODEL_PROVIDERS, ensureAgentRuntimeConfig, loadAgentRuntimeConfig, loadApiServices, loadCapabilities } from "./features/agent/runtime.mjs";
import { hasPersonaContent, mainModelIsReady, resolveOnboardingStep, shouldShowOnboarding } from "./features/onboarding/index.mjs";
import { conversationReactSnapshot, createConversationReactActions, isScheduledAgentReply, startConversationPolling, stopConversationPolling } from "./features/conversation/index.mjs";
import {
  loadRelationshipFiles,
  selectRelationshipContact,
} from "./features/relationship-settings/index.mjs";
import {
  SUZU_ADMIN_TABS,
  getDeferredCapabilityView,
  normalizeSuzuNavigationView,
  resolveSuzuRelationshipPage,
} from "./core/chat-first.mjs";
import { contactAvatarSource } from "./core/contact-avatar.mjs";
import { getAgentProfile, getIdentity } from "./core/identity.mjs";
import { getSuzuSearchItem } from "./core/suzu-search.mjs";
import { renderAppWorkspace, setGlobalNotice } from "./react/app-shell.jsx";
import { hasActiveConversationCall } from "./react/conversation-call-coordinator.mjs";
import { PRODUCT_FEATURES } from "../shared/product-features.mjs";

const api = window.suzuConsole;
const loading = document.querySelector("#loading");
const loadingText = document.querySelector("#loadingText");
const shellViews = new Set(["today", "relationships", "plans", "create", "capabilities", "settings"]);
const createPages = new Set(["overview", "visual", ...(PRODUCT_FEATURES.customEmojiStickers ? ["stickers"] : [])]);
const CAPABILITY_SETTINGS_LABELS = Object.freeze({
  "image-generation": "图片生成设置",
  "image-vision": "图片理解设置",
  "proactive-contact": "主动关心设置",
  "web-browser": "网页自动化设置",
  "video-understanding": "视频理解设置",
  "voice-message": "语音设置",
});
const GLOBAL_NOTICE_TIMEOUT_MS = 5_000;
const INCOMING_CONVERSATION_NOTICE_TIMEOUT_MS = 5_000;

let globalNoticeTimeout = null;
let incomingConversationNoticeTimeout = null;
let settingsContactsRequest = 0;
let appUpdateRequest = 0;
let systemStatusRequest = 0;

document.documentElement.dataset.theme = new URLSearchParams(window.location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.uiStyle = "classic";

function setLoading(active, text = "正在读取本地状态…") {
  loadingText.textContent = text;
  if (active) {
    loading.classList.remove("hidden");
    loading.setAttribute("aria-busy", "true");
    loading.removeAttribute("aria-hidden");
    return;
  }
  loading.classList.add("hidden");
  loading.setAttribute("aria-busy", "false");
  loading.setAttribute("aria-hidden", "true");
}

function setNotice(message = "") {
  const notice = String(message || "");
  state.globalNotice = notice;
  if (globalNoticeTimeout) {
    window.clearTimeout(globalNoticeTimeout);
    globalNoticeTimeout = null;
  }
  setGlobalNotice(currentGlobalNotice());
  if (!notice) return;
  globalNoticeTimeout = window.setTimeout(() => {
    globalNoticeTimeout = null;
    if (state.globalNotice !== notice) return;
    state.globalNotice = "";
    setGlobalNotice(currentGlobalNotice());
  }, GLOBAL_NOTICE_TIMEOUT_MS);
}

function currentAppearance() {
  const requestedStyleId = state.settings?.appearance?.styleId === "wallpaper-glass" ? "wallpaper-glass" : "classic";
  const wallpaper = state.settings?.appearance?.wallpaper || null;
  const wallpaperReady = wallpaper?.status === "ready" && Boolean(wallpaper.url);
  const wallpaperFailed = wallpaperReady && state.wallpaperRuntimeError === wallpaper.url;
  return {
    requestedStyleId,
    styleId: requestedStyleId === "wallpaper-glass" && wallpaperReady && !wallpaperFailed ? "wallpaper-glass" : "classic",
    wallpaper: wallpaperReady ? wallpaper : null,
  };
}

function applyAppearance() {
  document.documentElement.dataset.uiStyle = currentAppearance().styleId;
}

function applyTheme() {
  const theme = state.settings?.theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  applyAppearance();
  void api.windowChrome?.applyTheme(theme).catch(() => undefined);
}

function setView(view) {
  const nextView = normalizeSuzuNavigationView(view);
  if (nextView === "conversation") {
    setRelationshipPage("conversation");
    return;
  }
  if (nextView === "relationship-settings") {
    setRelationshipPage("settings");
    return;
  }
  if (nextView === "relationships") {
    setRelationshipPage("overview");
    return;
  }

  const unavailable = getDeferredCapabilityView(nextView);
  if (unavailable) {
    if (state.view === "relationships") stopConversationPolling();
    state.view = nextView;
    state.unavailableFeature = unavailable;
    render();
    return;
  }

  if (!shellViews.has(nextView) && nextView !== "admin") return;
  if (state.view === "relationships" && nextView !== "relationships") stopConversationPolling();
  state.view = nextView;
  state.unavailableFeature = null;
  // 侧边栏进入时回到该页面的首页，与 v1 行为一致。
  if (nextView === "create") state.createPage = "overview";
  if (nextView === "capabilities") {
    state.capabilityPage = "overview";
    state.capabilityCategory = "";
    state.capabilitySelectedId = "";
  }
  render();
  if (nextView === "today") void refreshTodayCalendar();
  if (nextView === "today") void loadTodayUsageSummary();
  if (nextView === "plans") void loadSchedules();
  if (nextView === "capabilities") void loadCapabilities(context);
  if (nextView === "settings" && state.settingsTab === "api") void loadApiServices(context);
  if (nextView === "settings" && state.settingsTab === "main-model") void loadAgentRuntimeConfig(context);
  if (nextView === "settings" && state.settingsTab === "privacy") void loadSettingsContacts();
  if (nextView === "settings") void loadAppUpdateStatus();
  if (nextView === "admin" && state.adminTab === "usage") void loadUsageLedger();
}

function setRelationshipPage(page) {
  const resolution = resolveSuzuRelationshipPage(page);
  const nextPage = resolution.page;
  stopConversationPolling();
  state.view = "relationships";
  state.relationshipPage = nextPage;
  state.unavailableFeature = resolution.unavailable;
  if (nextPage === "conversation") clearIncomingConversationNotice();
  render();
  if (nextPage === "conversation") startConversationPolling(context);
  if (nextPage === "overview") void loadMemoryScope();
  if (nextPage === "settings") loadRelationshipFiles(context);
  if (nextPage === "memory") void loadMemoryScope();
  if (nextPage === "compactor") void loadConversationCompactor();
  if (nextPage === "journal") void loadAgentJournal();
}

let memoryScopeRequest = 0;

async function loadMemoryScope(contactId = state.memoryContactId) {
  const request = ++memoryScopeRequest;
  state.memoryContactSwitching = true;
  if (state.view === "relationships" && state.relationshipPage === "memory") render();
  try {
    const memory = await api.memory.status({ contactId });
    if (request !== memoryScopeRequest) return null;
    state.memoryStatus = memory;
    state.memoryContactId = String(memory?.selectedContactId || "");
    state.memoryContactSwitching = false;
    if (state.view === "relationships" && state.relationshipPage === "memory") render();
    return memory;
  } catch (error) {
    if (request !== memoryScopeRequest) return null;
    state.memoryContactSwitching = false;
    setNotice(`无法读取联系人记忆：${error?.message || error}`);
    if (state.view === "relationships" && state.relationshipPage === "memory") render();
    return null;
  }
}

async function refreshMemoryScope() {
  const contactId = String(state.memoryContactId || "");
  const memory = await api.memory.status({ contactId });
  state.memoryStatus = memory;
  state.memoryContactId = String(memory?.selectedContactId || "");
  if (state.view === "relationships" && state.relationshipPage === "memory") render();
  return memory;
}

async function setMemoryRecallEnabled(enabled) {
  state.settings = await api.settings.update({ memoryRecallEnabled: Boolean(enabled) });
  render();
  return state.settings;
}

async function setShellSidebarWidth(width) {
  if (typeof api.settings?.update !== "function") return state.settings;
  try {
    state.settings = await api.settings.update({ shellSidebarWidth: width });
  } catch (error) {
    setNotice(`无法保存侧边栏宽度：${error?.message || error}`);
    render();
    return state.settings;
  }
  render();
  return state.settings;
}

async function setSoftwareAssistantPanelWidth(width) {
  if (typeof api.settings?.update !== "function") return state.settings;
  try {
    state.settings = await api.settings.update({ softwareAssistantPanelWidth: width });
  } catch (error) {
    setNotice(`无法保存 Suzu 面板宽度：${error?.message || error}`);
    render();
    return state.settings;
  }
  render();
  return state.settings;
}

async function setSoftwareAssistantReasoningEffort(reasoningEffort) {
  if (typeof api.settings?.update !== "function") throw new Error("当前版本无法保存 Suzu 思考强度。");
  try {
    state.settings = await api.settings.update({ softwareAssistantReasoningEffort: reasoningEffort });
  } catch (error) {
    setNotice(`无法保存 Suzu 思考强度：${error?.message || error}`);
    render();
    throw error;
  }
  render();
  return state.settings;
}

function setCreatePage(page) {
  if (!createPages.has(page)) return;
  state.createPage = page;
  render();
}

function setAdminTab(tab) {
  state.adminTab = SUZU_ADMIN_TABS.includes(tab) ? tab : "agent";
}

function setCapabilityPage(page, category = "", abilityId = "") {
  if (page === "overview") {
    state.capabilityPage = "overview";
    state.capabilitySelectedId = "";
    render();
    return;
  }
  if (page === "external") {
    state.capabilityPage = "external";
    state.capabilitySelectedId = "";
    render();
    return;
  }
  const validCategories = new Set(["create", "perceive", "act", "companion"]);
  if (!validCategories.has(category)) return;
  state.capabilityCategory = category;
  state.capabilitySelectedId = abilityId;
  state.capabilityPage = page === "detail" ? "detail" : "category";
  render();
}

function setSettingsTab(tab) {
  state.settingsTab = ["general", "wallpaper", "main-model", "api", "data", "privacy"].includes(tab) ? tab : "general";
  if (state.settingsTab === "api" && state.view === "settings") void loadApiServices(context);
  if (state.settingsTab === "main-model" && state.view === "settings") void loadAgentRuntimeConfig(context);
  if (state.settingsTab === "privacy") void loadSettingsContacts();
}

function openSuzuSearchItem(value) {
  const entry = getSuzuSearchItem(typeof value === "string" ? value : value?.id);
  const target = entry?.target || {};
  const view = String(target.view || "");
  if (!view) return;

  if (view === "relationships") {
    setRelationshipPage(target.relationshipPage || "conversation");
    return;
  }
  if (view === "settings") {
    setSettingsTab(target.settingsTab);
    setView("settings");
    return;
  }
  if (view === "admin") {
    setAdminTab(target.adminTab);
    setView("admin");
    return;
  }
  if (view === "create") {
    setView("create");
    if (target.createPage) setCreatePage(target.createPage);
    return;
  }
  if (view === "capabilities") {
    setView("capabilities");
    if (target.capabilityPage) {
      setCapabilityPage(target.capabilityPage, target.capabilityCategory, target.capabilityId);
    }
    return;
  }
  setView(view);
}

function observeSoftwareAssistantActions() {
  if (typeof api.softwareAssistant?.onEvent !== "function") return;
  api.softwareAssistant.onEvent((event) => {
    if (event?.type === "navigate") {
      openSuzuSearchItem(event.destinationId);
      return;
    }
    if (event?.type === "api-connections-changed") {
      void api.connections.apiServicesSnapshot()
        .then((snapshot) => { state.apiServices = snapshot; render(); })
        .catch((error) => setNotice(`API 已保存，但界面未能立即刷新：${error?.message || error}`));
      return;
    }
    if (event?.type === "main-model-changed") {
      void api.agentRuntime.snapshot()
        .then((snapshot) => { state.agentRuntime = snapshot; render(); })
        .catch((error) => setNotice(`主模型已保存，但界面未能立即刷新：${error?.message || error}`));
      return;
    }
    if (event?.type !== "theme-changed" && event?.type !== "contact-avatar-changed") return;
    void api.settings.get()
      .then((settings) => {
        state.settings = settings;
        if (event?.type === "theme-changed") applyTheme();
        render();
      })
      .catch((error) => setNotice(`设置已保存，但界面未能立即刷新：${error?.message || error}`));
  });
}

observeSoftwareAssistantActions();

async function refreshOnboardingPersona() {
  if (!String(state.settings?.projectRoot || "").trim() || typeof api.relationshipFiles?.snapshot !== "function") {
    state.onboardingPersonaReady = false;
    return false;
  }
  try {
    state.onboardingPersonaReady = hasPersonaContent(await api.relationshipFiles.snapshot());
  } catch {
    state.onboardingPersonaReady = false;
  }
  return state.onboardingPersonaReady;
}

async function prepareOnboarding({ open = false, allowCompleted = false } = {}) {
  if (!allowCompleted && !shouldShowOnboarding(state.settings)) {
    state.onboardingOpen = false;
    state.onboardingInitialized = true;
    return false;
  }
  if (mainModelIsReady(state.agentRuntime) && String(state.settings?.projectRoot || "").trim()) {
    await refreshOnboardingPersona();
  } else {
    state.onboardingPersonaReady = false;
  }
  state.onboardingStep = resolveOnboardingStep(state);
  state.onboardingError = "";
  state.onboardingInitialized = true;
  if (open) state.onboardingOpen = true;
  return true;
}

async function openOnboarding() {
  // A completed installation does not need to wake Agent Core merely to draw
  // the first window. Load the model state only when the setup flow is opened.
  if (!state.agentRuntime) await loadAgentRuntimeConfig(context);
  await prepareOnboarding({ open: true, allowCompleted: true });
  render();
}

function closeOnboarding() {
  state.onboardingOpen = false;
  state.onboardingError = "";
  render();
}

function setOnboardingStep(step) {
  const next = ["main-model", "contact", "persona", "ready"].includes(step)
    ? step
    : resolveOnboardingStep(state);
  state.onboardingStep = next;
  state.onboardingError = "";
  render();
}

function setOnboardingError(error) {
  state.onboardingError = String(error?.message || error || "").trim() || "暂时无法完成这一步。";
  render();
}

function continueOnboarding(step) {
  if (step === "contact" && !mainModelIsReady(state.agentRuntime)) {
    setOnboardingError("请先保存可用的主模型配置。");
    return;
  }
  setOnboardingStep(step);
}

async function saveOnboardingMainModel({ apiKey = "", baseUrl = "", model = "", protocol = "", provider = "", supportsImageInput = false } = {}) {
  try {
    state.agentRuntime = await api.agentRuntime.saveModelConfiguration({
      apiKey,
      baseUrl,
      model,
      protocol,
      provider,
      supportsImageInput,
    });
    if (!mainModelIsReady(state.agentRuntime)) throw new Error("主模型还没有可用的 API Key。请填写后再保存。");
    state.onboardingStep = "contact";
    state.onboardingOpen = true;
    state.onboardingError = "";
    render();
    return state.agentRuntime;
  } catch (error) {
    setOnboardingError(error);
    return null;
  }
}

function openOnboardingContactCreate() {
  state.onboardingOpen = false;
  state.onboardingStep = "contact";
  state.onboardingError = "";
  setRelationshipPage("conversation");
}

function advanceOnboardingAfterContact() {
  if (!shouldShowOnboarding(state.settings) || state.onboardingStep !== "contact") return;
  state.onboardingPersonaReady = false;
  state.onboardingStep = "persona";
  state.onboardingOpen = true;
  state.onboardingError = "";
}

function openOnboardingPersonaSetup() {
  state.onboardingOpen = false;
  state.onboardingStep = "persona";
  state.relationshipFilePath = "persona.md";
  state.onboardingError = "";
  setRelationshipPage("settings");
}

async function completeOnboarding() {
  try {
    state.settings = await api.settings.update({ onboardingCompleted: true });
    state.onboardingOpen = false;
    state.onboardingError = "";
    setRelationshipPage("conversation");
  } catch (error) {
    setOnboardingError(error);
  }
}

function onboardingWorkspace() {
  if (!state.onboardingOpen) return null;
  const step = ["main-model", "contact", "persona", "ready"].includes(state.onboardingStep)
    ? state.onboardingStep
    : resolveOnboardingStep(state);
  const configuration = state.agentRuntime || {};
  const providerId = TEXT_MODEL_PROVIDERS[configuration.providerId] ? configuration.providerId : "deepseek";
  const provider = TEXT_MODEL_PROVIDERS[providerId];
  const ready = mainModelIsReady(configuration);
  return {
    actions: {
      back: setOnboardingStep,
      close: closeOnboarding,
      complete: completeOnboarding,
      continue: continueOnboarding,
      openContactCreate: openOnboardingContactCreate,
      openPersonaSetup: openOnboardingPersonaSetup,
      saveMainModel: saveOnboardingMainModel,
    },
    snapshot: {
      error: state.onboardingError,
      step,
      textModel: {
        baseUrl: String(configuration.baseUrl || provider.baseUrl || ""),
        model: String(configuration.model || provider.model || ""),
        providerId,
        providers: Object.entries(TEXT_MODEL_PROVIDERS).map(([id, item]) => ({
          baseUrl: item.baseUrl,
          id,
          label: item.label,
          model: item.model,
          protocol: item.protocol,
        })),
        protocol: String(configuration.protocol || provider.protocol || "anthropic-messages"),
        ready,
        supportsImageInput: configuration.supportsImageInput === true,
      },
    },
  };
}

async function changeSettingsTheme(theme) {
  if (!["light", "dark"].includes(theme)) return;
  state.settings = await api.settings.update({ theme });
  applyTheme();
  render();
}

async function changeSettingsDataLocation() {
  try {
    const result = await api.settings.changeDataLocation();
    if (result?.status === "unchanged") setNotice("当前数据已经在这个位置，无需迁移。");
  } catch (error) {
    setNotice(`无法更换数据位置：${error?.message || error}`);
  }
}

function appUpdateMessage(result, fallback) {
  return String(result?.message || "").trim() || fallback;
}

function appUpdateNeedsAttention(update = state.appUpdate) {
  return ["available", "downloaded"].includes(String(update?.status || "").trim().toLowerCase());
}

function observeAppUpdateStatus() {
  if (typeof api.settings?.onAppUpdateStatus !== "function") return;
  api.settings.onAppUpdateStatus((result) => {
    if (!result || typeof result !== "object") return;
    state.appUpdate = result;
    render();
  });
}

observeAppUpdateStatus();

async function loadAppUpdateStatus() {
  const request = ++appUpdateRequest;
  if (typeof api.settings?.appUpdateStatus !== "function") return;
  try {
    const result = await api.settings.appUpdateStatus();
    if (request !== appUpdateRequest || state.view !== "settings") return;
    state.appUpdate = result;
  } catch (error) {
    if (request !== appUpdateRequest || state.view !== "settings") return;
    state.appUpdate = {
      status: "error",
      message: `无法读取更新状态：${error?.message || error}`,
    };
  }
  if (request === appUpdateRequest && state.view === "settings") render();
}

async function runAppUpdateAction(method, fallback) {
  const action = api.settings?.[method];
  if (typeof action !== "function") return;
  const request = ++appUpdateRequest;
  try {
    const result = await action();
    if (request !== appUpdateRequest) return;
    state.appUpdate = result;
    setNotice(appUpdateMessage(result, fallback));
  } catch (error) {
    if (request !== appUpdateRequest) return;
    setNotice(`${fallback}：${error?.message || error}`);
  }
  if (request === appUpdateRequest && state.view === "settings") render();
}

function checkAppUpdate() {
  return runAppUpdateAction("checkForUpdate", "无法检查更新");
}

function downloadAppUpdate() {
  return runAppUpdateAction("downloadUpdate", "无法下载更新");
}

function installAppUpdate() {
  return runAppUpdateAction("installUpdate", "无法安装更新");
}

function openReleaseAnnouncement() {
  if (!state.releaseAnnouncement?.announcement) return;
  state.releaseAnnouncementOpen = true;
  render();
}

async function acknowledgeReleaseAnnouncement() {
  if (!state.releaseAnnouncement?.announcement) return;
  state.releaseAnnouncementOpen = false;
  render();
  try {
    if (typeof api.settings?.acknowledgeReleaseAnnouncement !== "function") return;
    state.releaseAnnouncement = await api.settings.acknowledgeReleaseAnnouncement();
  } catch (error) {
    state.releaseAnnouncementOpen = true;
    setNotice(`无法确认更新公告：${error?.message || error}`);
  }
  render();
}

async function removeSettingsPreviousCopy() {
  try {
    const result = await api.settings.removePreviousDataCopy();
    if (result?.settings) state.settings = result.settings;
    render();
    if (result?.status === "removed") setNotice("旧位置的数据副本已清理。");
  } catch (error) {
    setNotice(`无法清理旧数据副本：${error?.message || error}`);
    render();
  }
}

async function openSettingsDirectory(targetPath) {
  const path = String(targetPath || "").trim();
  if (!path) return;
  await api.settings.showItemInFolder(path);
}

async function checkSystemStatus() {
  const request = ++systemStatusRequest;
  if (typeof api.settings?.systemStatus !== "function") return;
  try {
    const result = await api.settings.systemStatus();
    if (request !== systemStatusRequest) return;
    state.systemStatus = result;
  } catch (error) {
    if (request !== systemStatusRequest) return;
    state.systemStatus = { error: `无法完成系统状态检查：${error?.message || error}` };
  }
  if (request === systemStatusRequest && state.view === "settings" && state.settingsTab === "data") render();
}

async function loadSettingsContacts() {
  const request = ++settingsContactsRequest;
  state.settingsContactsLoading = true;
  if (state.view === "settings" && state.settingsTab === "privacy") render();
  try {
    if (typeof api.settings?.hiddenContacts !== "function") throw new Error("当前版本无法读取隐藏联系人。");
    const snapshot = await api.settings.hiddenContacts();
    if (request !== settingsContactsRequest) return;
    state.settingsContacts = {
      contacts: Array.isArray(snapshot?.contacts) ? snapshot.contacts : [],
      status: String(snapshot?.status || "missing").trim() || "missing",
    };
  } catch (error) {
    if (request !== settingsContactsRequest) return;
    state.settingsContacts = {
      contacts: [],
      error: error?.message || String(error),
      status: "unavailable",
    };
  } finally {
    if (request !== settingsContactsRequest) return;
    state.settingsContactsLoading = false;
    if (state.view === "settings" && state.settingsTab === "privacy") render();
  }
}

async function restoreHiddenContact(id) {
  const contactId = String(id || "").trim();
  if (!contactId || typeof api.conversation?.updateContactPresentation !== "function") return;
  const request = ++settingsContactsRequest;
  state.settingsContactsLoading = false;
  const contact = (Array.isArray(state.settingsContacts?.contacts) ? state.settingsContacts.contacts : [])
    .find((item) => String(item?.id || "").trim() === contactId) || null;
  const name = String(contact?.name || "这位联系人").trim() || "这位联系人";
  try {
    await api.conversation.updateContactPresentation({ id: contactId, hidden: false });
    const snapshot = await api.settings.hiddenContacts();
    if (request !== settingsContactsRequest) return;
    state.settingsContacts = {
      contacts: Array.isArray(snapshot?.contacts) ? snapshot.contacts : [],
      status: String(snapshot?.status || "missing").trim() || "missing",
    };
    setNotice(`已恢复“${name}”到对话页。`);
  } catch (error) {
    if (request !== settingsContactsRequest) return;
    setNotice(`无法恢复联系人：${error?.message || error}`);
  }
  if (request === settingsContactsRequest && state.view === "settings" && state.settingsTab === "privacy") render();
}

function selectAdminTab(tab) {
  setAdminTab(tab);
  render();
  if (state.adminTab === "usage") void loadUsageLedger();
}

async function saveAdminIdentity(changes) {
  const identity = getIdentity(state.settings);
  state.settings = await api.settings.update({
    identity: {
      ...identity,
      agents: { ...(identity.agents || {}) },
      defaultAgent: { ...(identity.defaultAgent || {}) },
      owner: { ...(identity.owner || {}), ...changes },
    },
  });
  setNotice(state.settings.ownerProfileTitleSync?.status === "partial"
    ? "身份已保存；部分“关于我”资料标题未能同步。"
    : "身份已保存。");
  render();
  return state.settings;
}

async function updateAdminSettings(patch) {
  state.settings = await api.settings.update(patch);
  render();
  return state.settings;
}

async function fetchAdminAgentModels(value = {}) {
  const result = await api.agentRuntime.fetchModels(value);
  state.agentModels = result?.models || [];
  state.agentModelNotice = result?.message || "";
  return result;
}

async function saveAdminModelConfiguration(value) {
  state.agentRuntime = await api.agentRuntime.saveModelConfiguration(value);
  state.agentModelNotice = state.agentRuntime.status === "ready"
    ? "已保存。下一次 Suzu 回复会使用这项服务。"
    : "已保存设置；填写 API Key 后再保存服务。";
  setNotice(state.agentModelNotice);
  render();
  return state.agentRuntime;
}

function openConversationFromAdmin() {
  setView("relationships");
  setRelationshipPage("conversation");
}

async function continueAdminOnboarding() {
  state.settings = await api.settings.update({ onboardingMultimodalCompleted: true });
  await openOnboarding();
}

async function saveApiConnection(value) {
  state.apiServices = await api.connections.saveNamedApiConnection(value);
  setNotice("API 已保存。");
  render();
  return state.apiServices;
}

async function removeApiConnection(id) {
  state.apiServices = await api.connections.removeNamedApiConnection(id);
  setNotice("API 已移除。");
  render();
  return state.apiServices;
}

async function saveAdminPrice({ effectiveFrom, modelId, rates }) {
  const existing = Array.isArray(state.settings?.priceRevisions) ? state.settings.priceRevisions : [];
  state.settings = await api.settings.update({
    priceRevisions: [
      ...existing.filter((item) => !(item.modelId === modelId && item.effectiveFrom === effectiveFrom)),
      { id: "custom:" + modelId + ":" + effectiveFrom, modelId, effectiveFrom, label: "软件内自定义价格", rates },
    ],
  });
  await refreshData();
}

async function resetAdminPrice(modelId) {
  state.settings = await api.settings.update({
    priceRevisions: (state.settings?.priceRevisions || []).filter((item) => item.modelId !== modelId),
  });
  await refreshData();
}

function capabilityName(abilityId) {
  return state.capabilitySnapshot?.capabilities?.find((ability) => ability.id === abilityId)?.name || "这项能力";
}

async function setCapabilityActive(abilityId, enabled) {
  try {
    const response = await api.capabilities.setActive(abilityId, enabled);
    if (response?.ok) {
      state.capabilitySnapshot = response.value.snapshot;
      setNotice(enabled ? `“${capabilityName(abilityId)}”已开启。` : `“${capabilityName(abilityId)}”已关闭。`);
    } else {
      const error = response?.error || { message: "无法更新这项能力。" };
      setNotice(error.code === "skill-conflict"
        ? "当前联系人已有同名能力文件，Suzu Lives 没有改动它。"
        : error.message || "无法更新这项能力。");
    }
  } catch (error) {
    setNotice(error?.message || "无法更新这项能力。");
  }
  render();
}

async function saveCapabilitySettings(abilityId, value) {
  try {
    const response = await api.capabilities.saveSettings(abilityId, value);
    if (response?.ok) {
      state.capabilitySnapshot = response.value;
      setNotice(`${CAPABILITY_SETTINGS_LABELS[abilityId] || "能力设置"}已保存。`);
      render();
      return { ok: true, value: response.value };
    } else {
      const error = response?.error || { message: "无法保存能力设置。" };
      setNotice(error.message || "无法保存能力设置。");
      render();
      return { ok: false, error };
    }
  } catch (error) {
    const result = { code: "", message: error?.message || "无法保存能力设置。" };
    setNotice(result.message);
    render();
    return { ok: false, error: result };
  }
}

async function saveImageGenerationCustomAdapter(value) {
  try {
    const response = await api.capabilities.saveImageGenerationCustomAdapter(value);
    if (response?.ok) {
      state.capabilitySnapshot = response.value;
      setNotice("自定义图像协议已保存。");
      render();
      return response.value;
    }
    throw new Error(response?.error?.message || "无法保存自定义图像协议。");
  } catch (error) {
    setNotice(error?.message || "无法保存自定义图像协议。");
    render();
    throw error;
  }
}

async function deleteImageGenerationCustomAdapter(value) {
  try {
    const response = await api.capabilities.deleteImageGenerationCustomAdapter(value);
    if (response?.ok) {
      state.capabilitySnapshot = response.value;
      setNotice("自定义图像协议已删除。");
      render();
      return response.value;
    }
    throw new Error(response?.error?.message || "无法删除自定义图像协议。");
  } catch (error) {
    setNotice(error?.message || "无法删除自定义图像协议。");
    render();
    throw error;
  }
}

async function saveImageVisionCustomAdapter(value) {
  try {
    const response = await api.capabilities.saveImageVisionCustomAdapter(value);
    if (response?.ok) {
      state.capabilitySnapshot = response.value;
      setNotice("自定义视觉协议已保存。");
      render();
      return response.value;
    }
    throw new Error(response?.error?.message || "无法保存自定义视觉协议。");
  } catch (error) {
    setNotice(error?.message || "无法保存自定义视觉协议。");
    render();
    throw error;
  }
}

async function deleteImageVisionCustomAdapter(value) {
  try {
    const response = await api.capabilities.deleteImageVisionCustomAdapter(value);
    if (response?.ok) {
      state.capabilitySnapshot = response.value;
      setNotice("自定义视觉协议已删除。");
      render();
      return response.value;
    }
    throw new Error(response?.error?.message || "无法删除自定义视觉协议。");
  } catch (error) {
    setNotice(error?.message || "无法删除自定义视觉协议。");
    render();
    throw error;
  }
}

async function saveVideoUnderstandingCustomAdapter(value) {
  try {
    const response = await api.capabilities.saveVideoUnderstandingCustomAdapter(value);
    if (response?.ok) {
      state.capabilitySnapshot = response.value;
      setNotice("自定义视频协议已保存。");
      render();
      return response.value;
    }
    throw new Error(response?.error?.message || "无法保存自定义视频协议。");
  } catch (error) {
    setNotice(error?.message || "无法保存自定义视频协议。");
    render();
    throw error;
  }
}

async function deleteVideoUnderstandingCustomAdapter(value) {
  try {
    const response = await api.capabilities.deleteVideoUnderstandingCustomAdapter(value);
    if (response?.ok) {
      state.capabilitySnapshot = response.value;
      setNotice("自定义视频协议已删除。");
      render();
      return response.value;
    }
    throw new Error(response?.error?.message || "无法删除自定义视频协议。");
  } catch (error) {
    setNotice(error?.message || "无法删除自定义视频协议。");
    render();
    throw error;
  }
}

async function setCapabilityContactEnabled(abilityId, contactId, contactEnabled) {
  try {
    const response = await api.capabilities.saveSettings(abilityId, { contactId, contactEnabled });
    if (response?.ok) {
      state.capabilitySnapshot = response.value;
      const name = capabilityName(abilityId);
      setNotice(contactEnabled ? `“${name}”已在这位联系人中开启。` : `“${name}”已在这位联系人中关闭。`);
    } else {
      setNotice(response?.error?.message || "无法更新会话开关。");
    }
  } catch (error) {
    setNotice(error?.message || "无法更新会话开关。");
  }
  render();
}

async function saveWechatSettings(value) {
  const next = value && typeof value === "object" ? value : {};
  try {
    state.wechatSnapshot = await api.wechat.saveSettings(next);
    setNotice("微信投递设置已保存。");
  } catch (error) {
    setNotice(error?.message || "无法保存微信投递设置。");
  }
  render();
}

async function saveQqSettings(value) {
  const next = value && typeof value === "object" ? value : {};
  try {
    state.qqSnapshot = await api.qq.saveSettings(next);
    setNotice("QQ 投递设置已保存。 ");
  } catch (error) {
    setNotice(error?.message || "无法保存 QQ 投递设置。 ");
  }
  render();
}

async function configureQqBot(value) {
  const next = value && typeof value === "object" ? value : {};
  try {
    state.qqSnapshot = await api.qq.configure(next);
    setNotice(state.qqSnapshot?.bot?.status === "connected" ? "QQ 机器人已连接。" : "QQ 机器人设置已保存，正在连接。 ");
    return state.qqSnapshot;
  } catch (error) {
    setNotice(error?.message || "无法保存 QQ 机器人设置。 ");
    throw error;
  } finally {
    render();
  }
}

async function changeSettingsAppearanceStyle(styleId) {
  if (!["classic", "wallpaper-glass"].includes(styleId)) return;
  state.wallpaperRuntimeError = "";
  state.settings = await api.settings.update({ appearance: { styleId } });
  applyAppearance();
  if (styleId === "wallpaper-glass" && currentAppearance().styleId !== "wallpaper-glass") {
    setNotice("选择一张图片或一个视频后即可启用壁纸玻璃样式。");
  }
  render();
}

async function chooseSettingsWallpaper() {
  try {
    const result = await api.settings.chooseWallpaper();
    if (result?.status !== "selected" || !result.settings) return result;
    state.wallpaperRuntimeError = "";
    state.settings = result.settings;
    applyAppearance();
    setNotice("自定义壁纸已应用。");
    render();
    return result;
  } catch (error) {
    setNotice(`无法应用壁纸：${error?.message || error}`);
    return null;
  }
}

async function selectSettingsWallpaperSource(sourceType) {
  try {
    return await api.settings.selectWallpaperSource(sourceType);
  } catch (error) {
    setNotice(`无法选择壁纸来源：${error?.message || error}`);
    throw error;
  }
}

async function discardSettingsWallpaperSource(selectionId) {
  if (!selectionId || typeof api.settings?.discardWallpaperSource !== "function") return null;
  return api.settings.discardWallpaperSource(selectionId).catch(() => null);
}

async function importSettingsWallpaper(value) {
  try {
    const result = await api.settings.importWallpaper(value);
    if (!result?.settings) return result;
    state.wallpaperRuntimeError = "";
    state.settings = result.settings;
    applyAppearance();
    const name = String(result.wallpaper?.name || value?.name || "这张壁纸");
    setNotice(result.applied ? `“${name}”已加入壁纸库并应用。` : `“${name}”已加入壁纸库，当前格式已完成识别。`);
    render();
    return result;
  } catch (error) {
    setNotice(`无法导入壁纸：${error?.message || error}`);
    throw error;
  }
}

async function selectSettingsWallpaper(folderName) {
  try {
    const result = await api.settings.selectWallpaper(folderName);
    if (!result?.settings) return result;
    state.wallpaperRuntimeError = "";
    state.settings = result.settings;
    applyAppearance();
    setNotice(`已应用“${result.wallpaper?.name || folderName}”。`);
    render();
    return result;
  } catch (error) {
    setNotice(`无法应用壁纸：${error?.message || error}`);
    throw error;
  }
}

async function updateSettingsWallpaper(value) {
  try {
    const result = await api.settings.updateWallpaper(value);
    if (!result?.settings) return result;
    state.wallpaperRuntimeError = "";
    state.settings = result.settings;
    applyAppearance();
    setNotice(`已更新“${result.wallpaper?.name || value?.name || value?.folderName}”。`);
    render();
    return result;
  } catch (error) {
    setNotice(`无法更新壁纸：${error?.message || error}`);
    throw error;
  }
}

async function removeSettingsWallpaper(folderName) {
  try {
    const selectedFolder = String(state.settings?.appearance?.wallpaper?.folderName || "");
    const removingActive = state.settings?.appearance?.styleId === "wallpaper-glass"
      && selectedFolder.toLocaleLowerCase() === String(folderName || "").toLocaleLowerCase();
    if (removingActive) {
      const cleared = await api.settings.clearWallpaper();
      if (cleared?.settings) {
        state.settings = cleared.settings;
        state.wallpaperRuntimeError = "";
        applyAppearance();
        render();
        await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
      }
    }
    const result = await api.settings.removeWallpaper(folderName);
    if (!result?.settings) return result;
    state.wallpaperRuntimeError = "";
    state.settings = result.settings;
    applyAppearance();
    setNotice(`已从壁纸库删除“${result.removed || folderName}”。`);
    render();
    return result;
  } catch (error) {
    setNotice(`无法删除壁纸：${error?.message || error}`);
    throw error;
  }
}

async function clearSettingsWallpaper() {
  try {
    const result = await api.settings.clearWallpaper();
    if (!result?.settings) return result;
    state.wallpaperRuntimeError = "";
    state.settings = result.settings;
    applyAppearance();
    setNotice("已停用壁纸并恢复经典样式，壁纸仍保留在壁纸库中。");
    render();
    return result;
  } catch (error) {
    setNotice(`无法清除壁纸：${error?.message || error}`);
    return null;
  }
}

function reportWallpaperError(url) {
  const wallpaperUrl = String(url || "");
  if (!wallpaperUrl || wallpaperUrl !== state.settings?.appearance?.wallpaper?.url) return;
  state.wallpaperRuntimeError = wallpaperUrl;
  applyAppearance();
  setNotice("壁纸文件暂时无法显示，已切换到经典样式。");
  render();
}

async function selectCapabilityApiBinding(bindingId, connectionId) {
  try {
    state.apiServices = await api.connections.bindNamedApiConnection(bindingId, connectionId);
    setNotice("功能使用的 API 已更新。");
    render();
    return state.apiServices;
  } catch (error) {
    setNotice(error?.message || "无法更新功能使用的 API。");
    render();
    throw error;
  }
}

async function createAdminPriceModel(value) {
  const modelId = String(value?.modelId || "").trim().toLowerCase();
  if (!modelId) throw new Error("请填写实际返回的模型标识。");
  const existing = Array.isArray(state.settings?.customPriceModels) ? state.settings.customPriceModels : [];
  if (existing.some((item) => String(item?.modelId || "").trim().toLowerCase() === modelId)) {
    throw new Error("这个模型已经有自定义价格，可以直接在它的价格卡片中调整。");
  }
  const settings = await api.settings.update({ customPriceModels: [...existing, value] });
  if (!settings.customPriceModels?.some((item) => item?.modelId === modelId)) {
    throw new Error("模型标识或计费字段无效，也可能与内置价格表重复。");
  }
  state.settings = settings;
  await refreshData();
  setNotice("已添加自定义模型价格。");
}

function openApiConnectionsSettings() {
  setSettingsTab("api");
  setView("settings");
}

function openCapabilityCreatePage(page) {
  setView("create");
  setCreatePage(page);
}

async function importExternalCapability() {
  try {
    const response = await api.externalCapabilities.importManifest();
    if (!response?.ok) throw response?.error || new Error("无法导入外部能力。");
    state.externalCapabilities = response.value.snapshot;
    if (!response.value.canceled) {
      setNotice(response.value.created
        ? "外部能力清单已导入；尚未运行任何第三方代码。"
        : "外部能力清单已更新；需要时可再次启用以更新 Agent Core 登记。");
    }
  } catch (error) {
    setNotice(error?.message || "无法导入外部能力清单。");
  }
  render();
}

async function setExternalCapabilityEnabled(id, enabled) {
  try {
    const response = await api.externalCapabilities.setEnabled(id, enabled);
    if (!response?.ok) throw response?.error || new Error("无法更新外部能力。");
    state.externalCapabilities = response.value.snapshot;
    setNotice(enabled
      ? "外部能力已登记到 Suzu Agent Core；下一次聊天会使用新配置。"
      : "外部能力已从 Suzu Agent Core 取消登记。");
  } catch (error) {
    setNotice(error?.message || "无法更新外部能力。");
  }
  render();
}

async function removeExternalCapability(id) {
  try {
    const response = await api.externalCapabilities.remove(id, true);
    if (!response?.ok) throw response?.error || new Error("无法移除外部能力。");
    state.externalCapabilities = response.value.snapshot;
    setNotice("外部能力已从 Suzu Lives 移除。");
  } catch (error) {
    setNotice(error?.message || "无法移除外部能力。");
  }
  render();
}

const context = { api, applyTheme, loadAgentRuntimeConfig, loadSchedules, onContactCreated: advanceOnboardingAfterContact, refreshData, refreshTodayCalendar, refreshUsageLedger: loadUsageLedger, render, setAdminTab, setCapabilityPage, setCreatePage, setNotice, setRelationshipPage, setSettingsTab, setView, state };

function conversationInterfaceIsOpen() {
  return state.view === "relationships" && state.relationshipPage === "conversation";
}

function clearIncomingConversationNotice() {
  state.conversationUnread = false;
  state.incomingConversationNotice = null;
  if (incomingConversationNoticeTimeout) window.clearTimeout(incomingConversationNoticeTimeout);
  incomingConversationNoticeTimeout = null;
}

async function showIncomingConversationNotice(event) {
  if (!isScheduledAgentReply(event)) return;
  const contactId = String(event?.contactId || "").trim();
  const conversationOpen = conversationInterfaceIsOpen();
  let contact = null;
  let activeContactId = "";
  let contactCatalogLoaded = false;
  if (contactId && typeof api.conversation?.snapshot === "function") {
    try {
      const snapshot = await api.conversation.snapshot();
      contactCatalogLoaded = true;
      const contacts = Array.isArray(snapshot?.contacts) ? snapshot.contacts : [];
      contact = contacts.find((item) => String(item?.id || "").trim() === contactId) || null;
      activeContactId = String(snapshot?.activeContact?.id || "").trim();
    } catch {
      // A notification remains useful even if the contact list is momentarily unavailable.
    }
  }
  if (contactCatalogLoaded && contactId && !contact) return;
  const shouldMarkUnread = !conversationOpen || !contactId || contactId !== activeContactId;
  if (shouldMarkUnread) {
    state.conversationUnread = true;
    if (contact && typeof api.conversation?.updateContactPresentation === "function") {
      try {
        await api.conversation.updateContactPresentation({ id: contactId, unreadIncrement: 1 });
      } catch {
        // Do not suppress an incoming-message signal if only its saved badge fails.
      }
    }
  }
  if (contact?.muted === true || conversationOpen) {
    if (shouldMarkUnread) render();
    return;
  }
  const profile = getAgentProfile(state.settings);
  const preview = String(event.content).replace(/\s+/gu, " ").trim().slice(0, 160);
  if (!preview) return;
  state.incomingConversationNotice = {
    avatar: contactAvatarSource(contact, state.settings),
    contactId,
    preview,
    senderName: String(contact?.name || profile?.displayName || "Suzu").trim() || "Suzu",
  };
  if (incomingConversationNoticeTimeout) window.clearTimeout(incomingConversationNoticeTimeout);
  incomingConversationNoticeTimeout = window.setTimeout(() => {
    incomingConversationNoticeTimeout = null;
    state.incomingConversationNotice = null;
    render();
  }, INCOMING_CONVERSATION_NOTICE_TIMEOUT_MS);
  render();
}

async function showIncomingVoiceCall(event) {
  if (event?.type !== "call-request") return;
  const requestId = String(event?.requestId || "").trim();
  const contactId = String(event?.contactId || "").trim();
  if (!requestId || !contactId || state.incomingVoiceCall || state.pendingIncomingVoiceCall) return;
  let contact = null;
  try {
    const snapshot = await api.conversation?.snapshot?.();
    const contacts = Array.isArray(snapshot?.contacts) ? snapshot.contacts : [];
    contact = contacts.find((item) => String(item?.id || "").trim() === contactId) || null;
  } catch {
    // A call request cannot safely target an unknown contact.
  }
  if (!contact) return;
  const identity = getIdentity(state.settings);
  const profile = identity.agents?.[String(contact.agentId || "").trim()] || identity.defaultAgent || getAgentProfile(state.settings);
  state.conversationUnread = true;
  const contactUnreadCount = Number.isSafeInteger(contact.unreadCount) && contact.unreadCount >= 0 ? contact.unreadCount : 0;
  if (contactUnreadCount < 1 && typeof api.conversation?.updateContactPresentation === "function") {
    try {
      await api.conversation.updateContactPresentation({ id: contactId, unreadCount: 1 });
    } catch {
      // A visible incoming call remains useful if saving its badge fails.
    }
  }
  state.incomingVoiceCall = {
    avatar: String(profile?.avatarDataUrl || "").trim(),
    contactId,
    reason: String(event?.reason || "").replace(/\s+/gu, " ").trim().slice(0, 160),
    requestId,
    senderName: String(contact.name || profile?.displayName || "Suzu").trim() || "Suzu",
  };
  render();
}

async function answerIncomingVoiceCall(requestId) {
  const incoming = state.incomingVoiceCall;
  if (!incoming || String(incoming.requestId || "") !== String(requestId || "")) return;
  state.incomingVoiceCall = { ...incoming, phase: "answering" };
  render();
  try {
    if (typeof api.conversation?.selectContact !== "function") throw new Error("当前版本无法切换联系人。");
    if (hasActiveConversationCall()) {
      state.incomingVoiceCall = { ...incoming, phase: "ringing" };
      setNotice("请先挂断当前语音通话，再接听新的来电。");
      return;
    }
    await api.conversation.selectContact({ id: incoming.contactId });
    if (typeof api.settings?.get === "function") state.settings = await api.settings.get().catch(() => state.settings);
    state.pendingIncomingVoiceCall = incoming;
    if (state.view !== "relationships") setView("relationships");
    setRelationshipPage("conversation");
  } catch (error) {
    state.pendingIncomingVoiceCall = null;
    state.incomingVoiceCall = { ...incoming, phase: "ringing" };
    setNotice(`无法接听来电：${error?.message || error}`);
    render();
  }
}

function declineIncomingVoiceCall(requestId) {
  if (!state.incomingVoiceCall || String(state.incomingVoiceCall.requestId || "") !== String(requestId || "")) return;
  state.incomingVoiceCall = null;
  if (typeof api.conversation?.call?.dismissRequest === "function") {
    void api.conversation.call.dismissRequest({ requestId }).catch(() => undefined);
  }
  render();
}

function cancelIncomingVoiceCall(requestId) {
  const matchesIncoming = String(state.incomingVoiceCall?.requestId || "") === String(requestId || "");
  const matchesPending = String(state.pendingIncomingVoiceCall?.requestId || "") === String(requestId || "");
  if (!matchesIncoming && !matchesPending) return;
  if (matchesIncoming) state.incomingVoiceCall = null;
  if (matchesPending) state.pendingIncomingVoiceCall = null;
  render();
}

function consumeIncomingVoiceCall(requestId) {
  if (!state.pendingIncomingVoiceCall || String(state.pendingIncomingVoiceCall.requestId || "") !== String(requestId || "")) return;
  state.pendingIncomingVoiceCall = null;
  if (String(state.incomingVoiceCall?.requestId || "") === String(requestId || "")) state.incomingVoiceCall = null;
  render();
}

function observeIncomingConversationMessages() {
  if (typeof api.conversation?.onEvent !== "function") return;
  api.conversation.onEvent((event) => {
    if (event?.type === "call-request") {
      void showIncomingVoiceCall(event);
      return;
    }
    if (event?.type === "call-request-cancelled") {
      cancelIncomingVoiceCall(event?.requestId);
      return;
    }
    void showIncomingConversationNotice(event);
  });
  // Register the renderer without opening a contact session or reading its
  // transcript. Scheduled replies can still arrive while another page is open.
  void api.conversation.registerEventRecipient?.().catch(() => undefined);
}

observeIncomingConversationMessages();

let todayCalendarRefreshId = 0;
let todayStartupSnapshotRequest = 0;
let rendererStartupReadySent = false;

function notifyMainAfterFirstPaint() {
  if (rendererStartupReadySent) return;
  rendererStartupReadySent = true;
  if (typeof api.appLifecycle?.rendererReady !== "function") return;
  void api.appLifecycle.rendererReady().catch(() => undefined);
}

function scheduleTodaySnapshotsAfterFirstPaint() {
  const request = ++todayStartupSnapshotRequest;
  const load = () => {
    if (request === todayStartupSnapshotRequest && state.view === "today") {
      void refreshTodayCalendar();
      void loadTodayUsageSummary();
    }
    notifyMainAfterFirstPaint();
  };
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => window.requestAnimationFrame(load));
  } else {
    window.setTimeout(load, 0);
  }
}

function visibleCalendarYear() {
  const month = String(state.todayMonth || "");
  const match = month.match(/^(\d{4})-(0[1-9]|1[0-2])$/u);
  if (match) return Number(match[1]);
  const selected = String(state.todaySelectedDate || "");
  const selectedMatch = selected.match(/^(\d{4})-/u);
  return selectedMatch ? Number(selectedMatch[1]) : new Date().getFullYear();
}

async function refreshTodayCalendar() {
  const refreshId = ++todayCalendarRefreshId;
  const year = visibleCalendarYear();
  try {
    const calendar = await api.todayCalendar.snapshot({ year });
    if (refreshId !== todayCalendarRefreshId) return;
    state.todayCalendar = calendar;
  } catch (error) {
    if (refreshId !== todayCalendarRefreshId) return;
    state.todayCalendar = { status: "invalid", events: [], canEdit: false, message: error?.message || String(error) };
  }
  if (state.view === "today") render();
}

function setTodayMonth(value) {
  const month = String(value || "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(month)) return;
  state.todayMonth = month;
  render();
  void refreshTodayCalendar();
}

function selectTodayDate(value) {
  const date = String(value || "");
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u.test(date)) return;
  const check = new Date(`${date}T12:00:00`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== date) return;
  state.todaySelectedDate = date;
  state.todayMonth = date.slice(0, 7);
  render();
  void refreshTodayCalendar();
}

function goToToday() {
  const today = new Date();
  state.todaySelectedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  state.todayMonth = state.todaySelectedDate.slice(0, 7);
  render();
  void refreshTodayCalendar();
}

function openTodayEventEditor() {
  if (state.todayCalendar?.canEdit !== true) return;
  state.todayEventEditor = { event: null };
  render();
}

function editTodayEvent({ id = "", contactId = "" } = {}) {
  const eventId = String(id || "");
  const ownerId = String(contactId || "");
  const event = (state.todayCalendar?.events || []).find((candidate) => (
    candidate.id === eventId && candidate.contactId === ownerId && candidate.editable
  ));
  if (!event) return;
  state.todayEventEditor = { event };
  render();
}

function closeTodayEventEditor() {
  if (!state.todayEventEditor) return;
  state.todayEventEditor = null;
  render();
}

async function saveTodayEvent(value) {
  try {
    await api.todayCalendar.saveEvent(value || {});
    state.todayEventEditor = null;
    await refreshTodayCalendar();
    setNotice("纪念日已保存。");
    render();
  } catch (error) {
    setNotice(error?.message || String(error));
  }
}

async function removeTodayEvent({ id = "", contactId = "", name = "这项纪念日" } = {}) {
  const eventId = String(id || "");
  const ownerId = String(contactId || "");
  const eventName = String(name || "这项纪念日");
  if (!eventId || !ownerId || !window.confirm(`删除“${eventName}”？`)) return;
  try {
    await api.todayCalendar.removeEvent({ contactId: ownerId, id: eventId });
    state.todayEventEditor = null;
    await refreshTodayCalendar();
    setNotice("纪念日已删除。");
    render();
  } catch (error) {
    setNotice(error?.message || String(error));
  }
}

function openTodayJournal() {
  setView("relationships");
  setRelationshipPage("journal");
}

function openTodayUsage() {
  setAdminTab("usage");
  setView("admin");
}

async function loadSchedules() {
  try {
    state.scheduleSnapshot = await api.schedule.snapshot();
  } catch (error) {
    state.scheduleSnapshot = { tasks: [] };
    setNotice(error?.message || "无法读取自动任务。 ");
  }
  if (state.view === "plans") render();
}

async function loadUsageLedger() {
  try {
    state.data = await api.ledger.scan();
  } catch (error) {
    state.data = { status: "needs-project", warning: `无法读取费用统计：${error?.message || error}` };
  }
  if (state.view === "admin" && state.adminTab === "usage") render();
}

let todayUsageRequest = 0;
let todayUsageWarmScheduled = false;

function scheduleTodayUsageWarm() {
  if (todayUsageWarmScheduled || typeof api.ledger?.warmTodaySummary !== "function") return;
  todayUsageWarmScheduled = true;
  const work = async () => {
    try {
      if (state.view !== "today" || state.todayUsage?.needsRefresh !== true) return;
      const summary = await api.ledger.warmTodaySummary();
      if (state.view !== "today") return;
      state.todayUsage = summary;
      render();
    } catch {
      // The compact sidecar is a performance cache.  A failed rebuild leaves
      // the durable JSONL untouched and can retry from a later home visit.
    } finally {
      todayUsageWarmScheduled = false;
    }
  };
  // Existing JSONL ledgers need one migration pass before they have a compact
  // dashboard summary. Keep that repair well after the first screen, so an
  // old account never pays its historical scan while the app is opening.
  window.setTimeout(() => {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(() => { void work(); }, { timeout: 15_000 });
      return;
    }
    void work();
  }, 1_500);
}

async function loadTodayUsageSummary() {
  const request = ++todayUsageRequest;
  try {
    if (typeof api.ledger?.todaySummary !== "function") {
      state.todayUsage = { status: "needs-project", events: [], summary: { today: {} }, warning: "费用摘要服务不可用。" };
      return state.todayUsage;
    }
    const summary = await api.ledger.todaySummary();
    if (request !== todayUsageRequest) return null;
    state.todayUsage = summary;
    if (state.todayUsage?.needsRefresh === true) scheduleTodayUsageWarm();
    return summary;
  } catch (error) {
    if (request !== todayUsageRequest) return null;
    state.todayUsage = { status: "needs-project", events: [], summary: { today: {} }, warning: `无法读取今日费用摘要：${error?.message || error}` };
    return state.todayUsage;
  } finally {
    if (request === todayUsageRequest && state.view === "today") render();
  }
}

async function updateSchedule(request) {
  const result = await request();
  if (result?.snapshot) state.scheduleSnapshot = result.snapshot;
  return result;
}

async function createSchedulePlan(value) {
  return updateSchedule(() => api.schedule.create(value));
}

async function setSchedulePlanEnabled(value) {
  return updateSchedule(() => api.schedule.setEnabled(value));
}

async function removeSchedulePlan(value) {
  return updateSchedule(() => api.schedule.remove(value));
}

async function updatePlannedProactiveContactSettings(value) {
  const response = await api.capabilities.saveSettings("proactive-contact", value);
  if (!response?.ok) throw new Error(response?.error?.message || "无法更新主动关心设置。");
  state.capabilitySnapshot = response.value;
  state.scheduleSnapshot = await api.schedule.snapshot();
  return { snapshot: state.scheduleSnapshot };
}

async function setPlannedProactiveContactAutoMaintain(enabled) {
  if (typeof enabled !== "boolean") throw new Error("主动关心总开关状态无效。");
  return updatePlannedProactiveContactSettings({ autoMaintain: enabled });
}

async function setPlannedProactiveContactEnabled({ contactId = "", enabled } = {}) {
  if (!String(contactId).trim() || typeof enabled !== "boolean") {
    throw new Error("联系人主动关心设置无效。");
  }
  return updatePlannedProactiveContactSettings({ contactEnabled: enabled, contactId });
}

async function saveRelationshipFile({ content = "", path = "" } = {}) {
  const filePath = String(path ?? "").trim();
  if (!filePath) return null;
  const snapshot = await api.relationshipFiles.save({ content, path: filePath });
  state.relationshipFiles = snapshot;
  state.relationshipFilePath = filePath;
  state.relationshipFilesError = "";
  const isPersona = filePath.replaceAll("\\", "/").toLowerCase() === "persona.md";
  if (isPersona && String(content).trim() && shouldShowOnboarding(state.settings) && state.onboardingStep === "persona") {
    state.onboardingPersonaReady = true;
    state.onboardingStep = "ready";
    state.onboardingOpen = true;
    state.onboardingError = "";
  }
  setNotice("已保存相处资料。");
  render();
  return snapshot;
}

async function createRelationshipFile({ content = "", path = "" } = {}) {
  const filePath = String(path ?? "").trim();
  const snapshot = await api.relationshipFiles.create({ content, path: filePath });
  state.relationshipFiles = snapshot;
  state.relationshipFilePath = filePath.replaceAll("\\", "/");
  state.relationshipFilesError = "";
  setNotice("已添加相处资料。");
  render();
  return snapshot;
}

function selectRelationshipFile(path) {
  const filePath = String(path ?? "").trim();
  if (!filePath) return;
  state.relationshipFilePath = filePath;
  state.relationshipFilesError = "";
  render();
}

let conversationCompactorRequest = 0;

async function loadConversationCompactor({ contactId = "" } = {}) {
  const request = ++conversationCompactorRequest;
  state.conversationCompactorLoading = true;
  state.conversationCompactorError = "";
  if (state.view === "relationships" && state.relationshipPage === "compactor") render();
  try {
    const snapshot = await api.conversationCompactor.snapshot({ contactId });
    if (request !== conversationCompactorRequest) return null;
    state.conversationCompactorSnapshot = snapshot;
    state.conversationCompactorLoading = false;
    if (state.view === "relationships" && state.relationshipPage === "compactor") render();
    return snapshot;
  } catch (error) {
    if (request !== conversationCompactorRequest) return null;
    state.conversationCompactorLoading = false;
    state.conversationCompactorError = error?.message || "无法读取记忆压缩器。";
    if (state.view === "relationships" && state.relationshipPage === "compactor") render();
    return null;
  }
}

async function saveConversationCompactorSettings(value = {}) {
  state.conversationCompactorLoading = true;
  state.conversationCompactorError = "";
  if (state.view === "relationships" && state.relationshipPage === "compactor") render();
  try {
    const snapshot = await api.conversationCompactor.save(value);
    state.conversationCompactorSnapshot = snapshot;
    state.conversationCompactorLoading = false;
    state.conversationCompactorError = "";
    setNotice("压缩设置已保存。");
    if (state.view === "relationships" && state.relationshipPage === "compactor") render();
    return snapshot;
  } catch (error) {
    state.conversationCompactorLoading = false;
    state.conversationCompactorError = error?.message || "无法保存压缩设置。";
    if (state.view === "relationships" && state.relationshipPage === "compactor") render();
    return null;
  }
}

async function runConversationCompactor(value = {}) {
  state.conversationCompactorLoading = true;
  state.conversationCompactorError = "";
  if (state.view === "relationships" && state.relationshipPage === "compactor") render();
  try {
    const snapshot = await api.conversationCompactor.run(value);
    state.conversationCompactorSnapshot = snapshot;
    state.conversationCompactorLoading = false;
    state.conversationCompactorError = "";
    setNotice("已完成本次对话压缩。");
    if (state.view === "relationships" && state.relationshipPage === "compactor") render();
    return snapshot;
  } catch (error) {
    state.conversationCompactorLoading = false;
    state.conversationCompactorError = error?.message || "无法压缩当前对话。";
    if (state.view === "relationships" && state.relationshipPage === "compactor") render();
    return null;
  }
}

let agentJournalRequest = 0;

async function loadAgentJournal({ contactId = "" } = {}) {
  const request = ++agentJournalRequest;
  state.agentJournalLoading = true;
  state.agentJournalError = "";
  if (state.view === "relationships" && state.relationshipPage === "journal") render();
  try {
    const snapshot = await api.agentJournal.snapshot({ contactId });
    if (request !== agentJournalRequest) return null;
    state.agentJournalSnapshot = snapshot;
    state.agentJournalLoading = false;
    if (state.view === "relationships" && state.relationshipPage === "journal") render();
    return snapshot;
  } catch (error) {
    if (request !== agentJournalRequest) return null;
    state.agentJournalLoading = false;
    state.agentJournalError = error?.message || "无法读取 Agent 日记。";
    if (state.view === "relationships" && state.relationshipPage === "journal") render();
    return null;
  }
}

async function selectAgentJournalContact(value = {}) {
  return loadAgentJournal({ contactId: String(value?.contactId || "") });
}

function currentGlobalNotice() {
  const warning = state.data?.status === "needs-project" ? "" : String(state.data?.warning || "");
  return state.globalNotice || warning;
}

function contentClassName() {
  return [
    state.view === "relationships" && state.relationshipPage === "conversation" ? "content--conversation" : "",
    state.view === "today" ? "content--today" : "",
    state.view === "settings" ? "content--settings" : "",
    state.view === "admin" ? "content--admin" : "",
    state.view === "relationships" && state.relationshipPage === "settings" ? "content--relationship-settings" : "",
    state.view === "relationships" && state.relationshipPage === "compactor" ? "content--conversation-compactor" : "",
    state.view === "relationships" && state.relationshipPage === "memory" ? "content--memory" : "",
    state.view === "relationships" && state.relationshipPage === "journal" ? "content--agent-journal" : "",
  ].filter(Boolean).join(" ");
}

function routeForCurrentView() {
  const unavailable = state.unavailableFeature || getDeferredCapabilityView(state.view);
  if (unavailable) {
    return {
      kind: "unavailable",
      props: unavailable,
    };
  }

  if (state.view === "today") {
    return {
      kind: "today",
      props: {
        actions: {
          closeEditor: closeTodayEventEditor,
          editEvent: editTodayEvent,
          goToday: goToToday,
          openJournal: openTodayJournal,
          openEditor: openTodayEventEditor,
          openUsage: openTodayUsage,
          removeEvent: removeTodayEvent,
          saveEvent: saveTodayEvent,
          selectDate: selectTodayDate,
          setMonth: setTodayMonth,
        },
        snapshot: {
          calendar: state.todayCalendar,
          data: state.todayUsage,
          editor: state.todayEventEditor,
          month: state.todayMonth,
          selectedDate: state.todaySelectedDate,
        },
      },
    };
  }

  if (state.view === "create") {
    if (state.createPage === "visual") {
      return {
        kind: "create-visual",
        props: { actions: { returnToOverview: () => setCreatePage("overview") }, api },
      };
    }
    if (PRODUCT_FEATURES.customEmojiStickers && state.createPage === "stickers") {
      return {
        kind: "create-stickers",
        props: { actions: { returnToOverview: () => setCreatePage("overview") }, api },
      };
    }
    return {
      kind: "create",
      props: {
        actions: {
          openSpace: (page) => setCreatePage(page),
          openVisual: () => setCreatePage("visual"),
          ...(PRODUCT_FEATURES.customEmojiStickers ? { openStickers: () => setCreatePage("stickers") } : {}),
        },
      },
    };
  }

  if (state.view === "capabilities") {
    return {
      kind: "capabilities",
      props: {
        actions: {
          openCategory: (category) => setCapabilityPage("category", category),
          openDetail: (category, abilityId) => setCapabilityPage("detail", category, abilityId),
          openExternal: () => setCapabilityPage("external"),
          openVisual: () => openCapabilityCreatePage("visual"),
          openApiServices: openApiConnectionsSettings,
          returnToCategory: (category) => setCapabilityPage("category", category),
          returnToOverview: () => setCapabilityPage("overview"),
          setCapabilityActive,
          saveSettings: saveCapabilitySettings,
          setContactEnabled: setCapabilityContactEnabled,
          imageGenerationDesign: {
            saveCustomAdapter: saveImageGenerationCustomAdapter,
            deleteCustomAdapter: deleteImageGenerationCustomAdapter,
          },
          imageVisionDesign: {
            saveCustomAdapter: saveImageVisionCustomAdapter,
            deleteCustomAdapter: deleteImageVisionCustomAdapter,
          },
          videoUnderstandingDesign: {
            saveCustomAdapter: saveVideoUnderstandingCustomAdapter,
            deleteCustomAdapter: deleteVideoUnderstandingCustomAdapter,
          },
          voiceDesign: api.voiceDesign,
          saveWechatSettings,
          saveQqSettings,
          configureQqBot,
          selectApiBinding: selectCapabilityApiBinding,
          importExternal: importExternalCapability,
          setExternalEnabled: setExternalCapabilityEnabled,
          removeExternal: removeExternalCapability,
        },
        snapshot: {
          apiServices: state.apiServices,
          capabilitySnapshot: state.capabilitySnapshot,
          categoryId: state.capabilityCategory,
          externalCapabilities: state.externalCapabilities,
          page: state.capabilityPage,
          selectedId: state.capabilitySelectedId,
          contactsSnapshot: state.companionContacts,
          wechatSnapshot: state.wechatSnapshot,
          qqSnapshot: state.qqSnapshot,
        },
      },
    };
  }

  if (state.view === "settings") {
    return {
      kind: "settings",
      props: {
        actions: {
          changeAppearanceStyle: changeSettingsAppearanceStyle,
          changeDataLocation: changeSettingsDataLocation,
          changeTheme: changeSettingsTheme,
          chooseWallpaper: chooseSettingsWallpaper,
          clearWallpaper: clearSettingsWallpaper,
          discardWallpaperSource: discardSettingsWallpaperSource,
          importWallpaper: importSettingsWallpaper,
          removeWallpaper: removeSettingsWallpaper,
          selectWallpaper: selectSettingsWallpaper,
          selectWallpaperSource: selectSettingsWallpaperSource,
          updateWallpaper: updateSettingsWallpaper,
          checkForUpdate: checkAppUpdate,
          checkSystemStatus,
          downloadUpdate: downloadAppUpdate,
          fetchModels: fetchAdminAgentModels,
          installUpdate: installAppUpdate,
          openOnboarding,
          openReleaseAnnouncement,
          openDirectory: openSettingsDirectory,
          removeApiConnection,
          removePreviousCopy: removeSettingsPreviousCopy,
          restoreHiddenContact,
          saveApiConnection,
          saveModelConfiguration: saveAdminModelConfiguration,
          setTab: (tab) => {
            setSettingsTab(tab);
            render();
          },
        },
        snapshot: {
          contacts: state.settingsContacts,
          contactsLoading: state.settingsContactsLoading,
          appUpdate: state.appUpdate,
          releaseAnnouncement: state.releaseAnnouncement,
          apiServices: state.apiServices,
          agentModelNotice: state.agentModelNotice,
          agentModels: state.agentModels,
          agentRuntime: state.agentRuntime,
          systemStatus: state.systemStatus,
          settings: state.settings,
          tab: state.settingsTab,
        },
      },
    };
  }

  if (state.view === "plans") {
    return {
      kind: "plans",
      props: {
        actions: {
          create: createSchedulePlan,
          remove: removeSchedulePlan,
          selectScript: () => api.schedule.selectScript(),
          setEnabled: setSchedulePlanEnabled,
          setProactiveContactAutoMaintain: setPlannedProactiveContactAutoMaintain,
          setProactiveContactEnabled: setPlannedProactiveContactEnabled,
        },
        snapshot: state.scheduleSnapshot,
      },
    };
  }

  if (state.view === "admin") {
    return {
      kind: "admin",
      props: {
        actions: {
          createPriceModel: createAdminPriceModel,
          openConversation: openConversationFromAdmin,
          resetPrice: resetAdminPrice,
          saveIdentity: saveAdminIdentity,
          savePrice: saveAdminPrice,
          setTab: selectAdminTab,
          updateSettings: updateAdminSettings,
        },
        snapshot: {
          data: state.data,
          settings: state.settings,
          tab: state.adminTab,
        },
      },
    };
  }

  if (state.view === "relationships" && state.relationshipPage === "settings") {
    return {
      kind: "relationship-settings",
      props: {
        actions: {
          createFile: createRelationshipFile,
          returnToOverview: () => setRelationshipPage("overview"),
          saveFile: saveRelationshipFile,
          selectContact: (id) => selectRelationshipContact(context, id),
          selectFile: selectRelationshipFile,
        },
        snapshot: {
          contacts: state.relationshipContacts,
          error: state.relationshipFilesError,
          files: state.relationshipFiles,
          selectedPath: state.relationshipFilePath,
          settings: state.settings,
        },
      },
    };
  }

  if (state.view === "relationships" && state.relationshipPage === "conversation") {
    return {
      kind: "conversation",
      props: {
        actions: {
          ...createConversationReactActions(context),
          consumeIncomingVoiceCall,
        },
        api,
        incomingCall: state.pendingIncomingVoiceCall,
        snapshot: conversationReactSnapshot(context),
      },
    };
  }

  if (state.view === "relationships" && state.relationshipPage === "compactor") {
    return {
      kind: "conversation-compactor",
      props: {
        actions: {
          returnToOverview: () => setRelationshipPage("overview"),
          run: runConversationCompactor,
          save: saveConversationCompactorSettings,
          selectContact: (contactId) => loadConversationCompactor({ contactId }),
        },
        error: state.conversationCompactorError,
        loading: state.conversationCompactorLoading,
        settings: state.settings,
        snapshot: state.conversationCompactorSnapshot,
      },
    };
  }

  if (state.view === "relationships" && state.relationshipPage === "journal") {
    return {
      kind: "agent-journal",
      props: {
        actions: {
          refresh: loadAgentJournal,
          returnToOverview: () => setRelationshipPage("overview"),
          selectContact: selectAgentJournalContact,
        },
        error: state.agentJournalError,
        loading: state.agentJournalLoading,
        settings: state.settings,
        snapshot: state.agentJournalSnapshot,
      },
    };
  }

  if (state.view === "relationships" && state.relationshipPage === "memory") {
    return {
      kind: "memory",
      props: {
        actions: {
          openApiServices: openApiConnectionsSettings,
          refreshStatus: refreshMemoryScope,
          returnToOverview: () => setRelationshipPage("overview"),
          selectApiBinding: selectCapabilityApiBinding,
          selectContact: loadMemoryScope,
          setNotice,
          setRecallEnabled: setMemoryRecallEnabled,
        },
        api,
        loading: state.memoryContactSwitching,
        snapshot: {
          apiServices: state.apiServices,
          memory: state.memoryStatus,
          settings: state.settings,
        },
      },
    };
  }

  return {
    kind: "relationships",
    props: {
      actions: {
        openConversation: () => setRelationshipPage("conversation"),
        openCompactor: () => setRelationshipPage("compactor"),
        openJournal: () => setRelationshipPage("journal"),
        openMemory: () => setRelationshipPage("memory"),
        openSettings: () => setRelationshipPage("settings"),
      },
      snapshot: { memory: state.memoryStatus },
    },
  };
}

function buildWorkspace() {
  return {
    actions: { acknowledgeReleaseAnnouncement, answerIncomingVoiceCall, declineIncomingVoiceCall, navigate: setView, openSuzuSearchItem, reportWallpaperError, setShellSidebarWidth, setSoftwareAssistantPanelWidth, setSoftwareAssistantReasoningEffort },
    activeView: state.view,
    appearance: currentAppearance(),
    contentClassName: contentClassName(),
    conversationUnread: state.conversationUnread,
    incomingConversationNotice: state.incomingConversationNotice,
    incomingVoiceCall: state.incomingVoiceCall,
    notice: currentGlobalNotice(),
    onboarding: onboardingWorkspace(),
    owner: getIdentity(state.settings).owner,
    appUpdateAttention: appUpdateNeedsAttention(),
    releaseAnnouncement: state.releaseAnnouncement,
    releaseAnnouncementOpen: state.releaseAnnouncementOpen,
    route: routeForCurrentView(),
    shellSidebarWidth: state.settings?.shellSidebarWidth,
    softwareAssistantPanelWidth: state.settings?.softwareAssistantPanelWidth,
    softwareAssistantReasoningEffort: state.settings?.softwareAssistantReasoningEffort,
  };
}

function render() {
  const workspace = buildWorkspace();
  renderAppWorkspace(workspace);
}

async function refreshData() {
  setLoading(true);
  try {
    state.settings = await api.settings.get();
    applyTheme();
    // Every page keeps its own snapshot.  The home dashboard asks only for its
    // compact summaries after its first paint; complete ledgers and other
    // page-specific data are loaded only when their page is opened.
    state.data = null;
    state.todayUsage = null;
    state.memoryStatus = null;
    state.todayCalendar = null;
    state.apiServices = null;
    state.memoryContactId = "";
    const releaseAnnouncementSnapshot = typeof api.settings?.releaseAnnouncementStatus === "function"
      ? api.settings.releaseAnnouncementStatus().catch(() => null)
      : Promise.resolve(null);
    const appUpdateSnapshot = typeof api.settings?.appUpdateStatus === "function"
      ? api.settings.appUpdateStatus().catch(() => null)
      : Promise.resolve(null);
    // Prime the runtime's selected-model capability cache once during every
    // application start. Subsequent refreshes reuse state.agentRuntime; model
    // saves return a fresh snapshot and replace this cached value.
    const agentRuntimeSnapshot = ensureAgentRuntimeConfig(context).catch(() => null);
    const [agentRuntime, releaseAnnouncement, initialAppUpdate] = await Promise.all([
      agentRuntimeSnapshot,
      releaseAnnouncementSnapshot,
      appUpdateSnapshot,
    ]);
    state.agentRuntime = agentRuntime;
    state.releaseAnnouncement = releaseAnnouncement;
    if (!appUpdateNeedsAttention()) state.appUpdate = initialAppUpdate;
    state.releaseAnnouncementOpen = state.releaseAnnouncement?.pending === true;
    if (!state.onboardingInitialized) await prepareOnboarding({ open: true });
  } catch (error) {
    state.data = { status: "needs-project", warning: `读取失败：${error?.message || error}` };
  } finally {
    setLoading(false);
    render();
    if (state.view === "today") scheduleTodaySnapshotsAfterFirstPaint();
  }
}

refreshData();
