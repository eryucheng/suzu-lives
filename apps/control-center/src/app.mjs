import { state } from "./core/state.mjs";
import { CLAUDE_CODE_API_PROVIDERS, loadClaudeCodeApi, loadApiServices, loadCapabilities } from "./features/agent/index.mjs";
import { resolveOnboardingStep, shouldShowOnboarding } from "./features/onboarding/index.mjs";
import { conversationReactSnapshot, createConversationReactActions, startConversationPolling, stopConversationPolling } from "./features/conversation/index.mjs";
import { loadRelationshipFiles, selectRelationshipContact } from "./features/relationship-settings/index.mjs";
import { getIdentity } from "./core/identity.mjs";
import { renderAppWorkspace, setGlobalNotice } from "./react/app-shell.jsx";

const api = window.suzuConsole;
const loading = document.querySelector("#loading");
const loadingText = document.querySelector("#loadingText");
const shellViews = new Set(["today", "relationships", "plans", "create", "capabilities", "settings"]);
const CAPABILITY_SETTINGS_LABELS = Object.freeze({
  "image-generation": "图片生成设置",
  "image-vision": "图片理解设置",
  "phone-camera": "手机拍照设置",
  "proactive-contact": "主动关心设置",
  "site-automation": "网页自动化设置",
  "time-awareness": "时间感知设置",
  "traveling-merchant": "远行商人设置",
  "video-understanding": "视频理解设置",
  "voice-message": "语音设置",
});
const GLOBAL_NOTICE_TIMEOUT_MS = 6_000;

let globalNoticeTimeout = null;

document.documentElement.dataset.theme = new URLSearchParams(window.location.search).get("theme") === "light" ? "light" : "dark";

function setLoading(active, text = "正在读取本地状态…") {
  loading.classList.toggle("hidden", !active);
  loadingText.textContent = text;
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

function applyTheme() {
  const theme = state.settings?.theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  void api.windowChrome?.applyTheme(theme).catch(() => undefined);
}

function setView(view) {
  if (!shellViews.has(view) && view !== "admin") return;
  if (view === "relationships" && state.view === "relationships") {
    stopConversationPolling();
    state.relationshipPage = "overview";
    render();
    return;
  }
  if (view === "create" && state.view === "create") {
    state.createPage = "overview";
    render();
    return;
  }
  if (view === "capabilities" && state.view === "capabilities") {
    state.capabilityPage = "overview";
    state.capabilitySelectedId = "";
    state.siteAutomationSelectedSiteId = "";
    render();
    return;
  }
  const enteringRelationships = state.view !== "relationships" && view === "relationships";
  const enteringCreate = state.view !== "create" && view === "create";
  const enteringCapabilities = state.view !== "capabilities" && view === "capabilities";
  if (state.view === "relationships" && view !== "relationships") stopConversationPolling();
  state.view = view;
  if (enteringRelationships) state.relationshipPage = "overview";
  if (enteringCreate) state.createPage = "overview";
  if (enteringCapabilities) {
    state.capabilityPage = "overview";
    state.capabilitySelectedId = "";
    state.siteAutomationSelectedSiteId = "";
  }
  render();
  if (view === "capabilities") loadCapabilities(context);
  if (view === "plans") loadSchedules();
  if (view === "today") refreshTodayCalendar();
  if (view === "admin" && state.adminTab === "claude-code") loadClaudeCodeApi(context);
  if (view === "admin" && state.adminTab === "api-services") loadApiServices(context);
}

function setRelationshipPage(page) {
  const nextPage = ["overview", "conversation", "memory", "settings", "compactor"].includes(page) ? page : "overview";
  stopConversationPolling();
  state.relationshipPage = nextPage;
  render();
  if (nextPage === "conversation") startConversationPolling(context);
  if (nextPage === "settings") loadRelationshipFiles(context);
  if (nextPage === "memory") void loadMemoryScope();
  if (nextPage === "compactor") void loadConversationCompactor();
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
function setCreatePage(page) {
  if (!["overview", "visual", "audio"].includes(page)) return;
  state.createPage = page;
  render();
}

function setAdminTab(tab) {
  state.adminTab = ["agent", "claude-code", "runtime", "api-services", "usage"].includes(tab) ? tab : "agent";
}

function setCapabilityPage(page, category = "", abilityId = "") {
  if (page === "overview") {
    state.capabilityPage = "overview";
    state.capabilitySelectedId = "";
    state.siteAutomationSelectedSiteId = "";
    render();
    return;
  }
  if (page === "external") {
    state.capabilityPage = "external";
    state.capabilitySelectedId = "";
    state.siteAutomationSelectedSiteId = "";
    render();
    return;
  }
  const validCategories = new Set(["create", "perceive", "act", "companion"]);
  if (!validCategories.has(category)) return;
  state.capabilityCategory = category;
  state.capabilitySelectedId = abilityId;
  if (abilityId !== "site-automation") state.siteAutomationSelectedSiteId = "";
  state.capabilityPage = page === "detail" ? "detail" : "category";
  render();
}

function setSettingsTab(tab) {
  state.settingsTab = ["general", "data"].includes(tab) ? tab : "general";
}

function updateShell() {
  window.dispatchEvent(new CustomEvent("suzu-shell:view-change", { detail: { view: state.view } }));
}

function openOnboarding() {
  state.onboardingOpen = true;
  state.onboardingStep = resolveOnboardingStep(state);
  state.onboardingError = "";
  render();
}

function closeOnboarding() {
  state.onboardingOpen = false;
  state.onboardingError = "";
  render();
}

function setOnboardingStep(step) {
  const next = ["text-model", "multimodal", "projects", "contact"].includes(step)
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

async function continueOnboarding(step) {
  if (state.onboardingStep === "multimodal" && step === "projects") {
    try {
      state.settings = await api.settings.update({ onboardingMultimodalCompleted: true });
    } catch (error) {
      setOnboardingError(error);
      return;
    }
  }
  setOnboardingStep(step);
}

async function saveOnboardingTextModel({ apiKey = "", provider = "" } = {}) {
  try {
    state.claudeCodeApi = await api.agentRuntime.saveClaudeCodeApi({
      provider,
      apiKey,
      authMode: "auth-token",
      skipOnboarding: true,
    });
    if (state.claudeCodeApi?.status !== "ready") throw new Error("文字模型还没有可用的 API Key。请填写后再保存。");
    state.onboardingStep = "multimodal";
    state.onboardingError = "";
    render();
  } catch (error) {
    setOnboardingError(error);
  }
}

function openOnboardingApiServices() {
  state.onboardingOpen = false;
  state.onboardingStep = "multimodal";
  state.onboardingError = "";
  setAdminTab("api-services");
  setView("admin");
}

async function selectOnboardingContactsRoot() {
  try {
    const result = await api.settings.selectProject();
    if (result?.canceled || !result?.settings) {
      render();
      return;
    }
    state.settings = { ...state.settings, ...result.settings };
    state.onboardingStep = "contact";
    state.onboardingError = "";
    render();
  } catch (error) {
    setOnboardingError(error);
  }
}

async function completeOnboarding() {
  try {
    state.settings = await api.settings.update({ onboardingCompleted: true });
    state.onboardingOpen = false;
    state.onboardingError = "";
    setView("relationships");
    setRelationshipPage("conversation");
  } catch (error) {
    setOnboardingError(error);
  }
}

async function createOnboardingContact(name) {
  const value = String(name || "").trim();
  if (!value) return;
  try {
    await api.conversation.createContact({ name: value });
    state.settings = await api.settings.get();
    await completeOnboarding();
  } catch (error) {
    setOnboardingError(error);
  }
}

function onboardingWorkspace() {
  if (!state.onboardingOpen) return null;
  const step = ["text-model", "multimodal", "projects", "contact"].includes(state.onboardingStep)
    ? state.onboardingStep
    : resolveOnboardingStep(state);
  const configuration = state.claudeCodeApi || {};
  const providerId = CLAUDE_CODE_API_PROVIDERS[configuration.providerId] ? configuration.providerId : "deepseek";
  const provider = CLAUDE_CODE_API_PROVIDERS[providerId];
  const ready = configuration.status === "ready" && configuration.hasApiKey;
  return {
    actions: {
      back: setOnboardingStep,
      close: closeOnboarding,
      complete: completeOnboarding,
      continue: continueOnboarding,
      createContact: createOnboardingContact,
      openApiServices: openOnboardingApiServices,
      saveTextModel: saveOnboardingTextModel,
      selectContactsRoot: selectOnboardingContactsRoot,
    },
    snapshot: {
      contactsRoot: String(state.settings?.contactsRoot || "").trim(),
      error: state.onboardingError,
      hasContact: Boolean(String(state.settings?.projectRoot || "").trim()),
      step,
      textModel: {
        copy: ready
          ? `已配置 ${provider.label}。可以直接继续，或重新填写密钥来更新这个服务。`
          : "保存后，Suzu 和这台电脑上新开的 Claude Code 终端会使用同一文字模型服务。",
        providerId,
        providers: Object.entries(CLAUDE_CODE_API_PROVIDERS)
          .filter(([id]) => id !== "custom")
          .map(([id, item]) => ({ id, label: item.label })),
        ready,
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

async function selectSettingsWorkspace() {
  try {
    const result = await api.settings.selectProject();
    if (!result?.canceled && result?.settings) {
      state.settings = { ...state.settings, ...result.settings };
      await refreshData();
      return;
    }
    render();
  } catch (error) {
    setNotice(`无法选择 Agent 工作目录：${error?.message || error}`);
    render();
  }
}

async function changeSettingsDataLocation() {
  try {
    const result = await api.settings.changeDataLocation();
    if (result?.status === "unchanged") setNotice("当前数据已经在这个位置，无需迁移。");
  } catch (error) {
    setNotice(`无法更换数据位置：${error?.message || error}`);
  }
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

function selectAdminTab(tab) {
  setAdminTab(tab);
  render();
  if (tab === "claude-code") void loadClaudeCodeApi(context);
  if (tab === "api-services") void loadApiServices(context);
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
  setNotice("身份已保存。");
  render();
  return state.settings;
}

async function updateAdminSettings(patch) {
  state.settings = await api.settings.update(patch);
  render();
  return state.settings;
}

async function fetchAdminClaudeCodeModels(value) {
  const result = await api.agentRuntime.fetchClaudeCodeModels(value);
  state.claudeCodeModels = result?.models || [];
  state.claudeCodeModelNotice = result?.message || "";
  return result;
}

async function saveAdminClaudeCodeApi(value) {
  state.claudeCodeApi = await api.agentRuntime.saveClaudeCodeApi(value);
  state.claudeCodeModelNotice = state.claudeCodeApi.status === "ready"
    ? "已保存。新开的 Claude Code 会话会使用这项服务。"
    : "已保存首次确认设置；填写 API Key 后再保存服务。";
  setNotice(state.claudeCodeModelNotice);
  render();
  return state.claudeCodeApi;
}

function openConversationFromAdmin() {
  setView("relationships");
  setRelationshipPage("conversation");
}

async function continueAdminOnboarding() {
  state.settings = await api.settings.update({ onboardingMultimodalCompleted: true });
  openOnboarding();
}

async function saveAdminApiConnection(value) {
  state.apiServices = await api.connections.saveNamedApiConnection(value);
  if (state.apiServices.connections?.some((connection) => connection?.configured === true)) {
    state.settings = await api.settings.update({ onboardingMultimodalCompleted: true });
  }
  setNotice("API 已保存。");
  render();
  return state.apiServices;
}

async function removeAdminApiConnection(id) {
  state.apiServices = await api.connections.removeNamedApiConnection(id);
  setNotice("API 已移除。");
  render();
  return state.apiServices;
}

async function bindAdminApiConnection(feature, connectionId) {
  state.apiServices = await api.connections.bindNamedApiConnection(feature, connectionId);
  setNotice("功能使用的 API 已更新。");
  render();
  return state.apiServices;
}

async function saveAdminComfyui(value) {
  const comfy = await api.connections.saveComfyui(value);
  state.apiServices = { ...(state.apiServices || {}), comfy };
  setNotice("ComfyUI 设置已保存。");
  render();
  return comfy;
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
    } else {
      setNotice(response?.error?.message || "无法保存能力设置。");
    }
  } catch (error) {
    setNotice(error?.message || "无法保存能力设置。");
  }
  render();
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
    if (typeof next.enabled === "boolean") {
      setNotice(next.enabled
        ? "微信连接已开启；现在可以在任一会话的“··· → 设置”里生成二维码。"
        : "微信连接已关闭；已有绑定会保留，重新开启后可恢复。");
    } else {
      setNotice("微信投递设置已保存。");
    }
  } catch (error) {
    setNotice(error?.message || (typeof next.enabled === "boolean" ? "无法更新微信连接。" : "无法保存微信投递设置。"));
  }
  render();
}

async function saveSiteAutomationControl(value, successMessage) {
  try {
    const response = await api.capabilities.saveSettings("site-automation", value);
    if (response?.ok) {
      state.capabilitySnapshot = response.value;
      setNotice(successMessage);
    } else {
      setNotice(response?.error?.message || "无法更新网页自动化设置。");
    }
  } catch (error) {
    setNotice(error?.message || "无法更新网页自动化设置。");
  }
  render();
}

function openCapabilitySite(siteId) {
  state.siteAutomationSelectedSiteId = String(siteId || "");
  render();
}

function returnToCapabilitySites() {
  state.siteAutomationSelectedSiteId = "";
  render();
}

async function selectCapabilityApiBinding(bindingId, connectionId) {
  try {
    state.apiServices = await api.connections.bindNamedApiConnection(bindingId, connectionId);
    setNotice("功能使用的 API 已更新。");
  } catch (error) {
    setNotice(error?.message || "无法更新功能使用的 API。");
  }
  render();
}

function openCapabilityApiServices() {
  state.apiBindingPickerOpen = "";
  setAdminTab("api-services");
  setView("admin");
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
        : "外部能力清单已更新；需要时可再次启用以更新当前联系人中的登记。");
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
      ? "外部能力已登记到当前联系人；这不会在 Suzu Lives 中运行第三方代码。"
      : "外部能力已从当前联系人取消登记。");
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

async function openTravelingMerchantPage() {
  try {
    const response = await api.capabilities.openTravelingMerchantPage();
    setNotice(response?.ok ? "已打开远行商人当前读取网页。" : response?.error?.message || "无法打开远行商人网页。");
  } catch (error) {
    setNotice(error?.message || "无法打开远行商人网页。");
  }
  render();
}

const context = { api, applyTheme, loadClaudeCodeApi, loadApiServices, loadSchedules, openOnboarding, refreshData, refreshTodayCalendar, render, setAdminTab, setCapabilityPage, setCreatePage, setNotice, setRelationshipPage, setSettingsTab, setView, state };

async function refreshTodayCalendar() {
  try {
    state.todayCalendar = await api.todayCalendar.snapshot();
  } catch (error) {
    state.todayCalendar = { status: "invalid", events: [], canEdit: false, message: error?.message || String(error) };
  }
  if (state.view === "today") render();
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

async function saveRelationshipFile({ content = "", path = "" } = {}) {
  const filePath = String(path ?? "").trim();
  if (!filePath) return null;
  const snapshot = await api.relationshipFiles.save({ content, path: filePath });
  state.relationshipFiles = snapshot;
  state.relationshipFilePath = filePath;
  state.relationshipFilesError = "";
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

async function selectConversationCompactorContact(value = {}) {
  return loadConversationCompactor({
    contactId: String(value?.contactId || ""),
  });
}

async function saveConversationCompactorSettings(value) {
  const snapshot = await api.conversationCompactor.save(value);
  state.conversationCompactorSnapshot = snapshot;
  state.conversationCompactorLoading = false;
  state.conversationCompactorError = "";
  setNotice(Object.hasOwn(value || {}, "automatic") ? "这条会话的自动压缩设置已保存。" : "这条会话的摘要提示词已保存。 ");
  if (state.view === "relationships" && state.relationshipPage === "compactor") render();
  return snapshot;
}

async function runConversationCompactor(value) {
  const snapshot = await api.conversationCompactor.run(value);
  state.conversationCompactorSnapshot = snapshot;
  state.conversationCompactorLoading = false;
  state.conversationCompactorError = "";
  setNotice(snapshot?.lastRun?.status === "written" ? "这条会话已完成手动压缩。" : "这条会话没有可压缩的较早记录。 ");
  if (state.view === "relationships" && state.relationshipPage === "compactor") render();
  return snapshot;
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
  ].filter(Boolean).join(" ");
}

function routeForCurrentView() {
  if (state.view === "today") {
    return {
      kind: "today",
      props: {
        snapshot: {
          calendar: state.todayCalendar,
          data: state.data,
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
    if (state.createPage === "audio") {
      return {
        kind: "create-audio",
        props: {
          actions: {
            openApiServices: () => {
              setAdminTab("api-services");
              setView("admin");
            },
            returnToOverview: () => setCreatePage("overview"),
          },
          api,
        },
      };
    }
    return {
      kind: "create",
      props: {
        actions: {
          openAudio: () => setCreatePage("audio"),
          openVisual: () => setCreatePage("visual"),
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
          openSite: openCapabilitySite,
          openTravelingMerchantPage,
          openVisual: () => openCapabilityCreatePage("visual"),
          openAudio: () => openCapabilityCreatePage("audio"),
          openApiServices: openCapabilityApiServices,
          returnToCategory: (category) => setCapabilityPage("category", category),
          returnToOverview: () => setCapabilityPage("overview"),
          returnToSites: returnToCapabilitySites,
          setCapabilityActive,
          saveSettings: saveCapabilitySettings,
          setContactEnabled: setCapabilityContactEnabled,
          saveWechatSettings,
          setSiteEnabled: (siteId, siteEnabled) => saveSiteAutomationControl(
            { siteId, siteEnabled },
            siteEnabled ? "这个网站已启用。" : "这个网站已关闭。",
          ),
          setSiteAction: (siteId, action, actionEnabled) => saveSiteAutomationControl(
            { siteId, action, actionEnabled },
            actionEnabled ? "网站动作已启用。" : "网站动作已关闭。",
          ),
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
          siteId: state.siteAutomationSelectedSiteId,
          wechatSnapshot: state.wechatSnapshot,
        },
      },
    };
  }

  if (state.view === "settings") {
    return {
      kind: "settings",
      props: {
        actions: {
          changeDataLocation: changeSettingsDataLocation,
          changeTheme: changeSettingsTheme,
          openDirectory: openSettingsDirectory,
          openOnboarding,
          removePreviousCopy: removeSettingsPreviousCopy,
          selectWorkspace: selectSettingsWorkspace,
          setTab: (tab) => {
            setSettingsTab(tab);
            render();
          },
        },
        snapshot: { settings: state.settings, tab: state.settingsTab },
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
          bindApi: bindAdminApiConnection,
          continueOnboarding: continueAdminOnboarding,
          fetchClaudeCodeModels: fetchAdminClaudeCodeModels,
          openConversation: openConversationFromAdmin,
          removeApiConnection: removeAdminApiConnection,
          resetPrice: resetAdminPrice,
          saveApiConnection: saveAdminApiConnection,
          saveClaudeCodeApi: saveAdminClaudeCodeApi,
          saveComfyui: saveAdminComfyui,
          saveIdentity: saveAdminIdentity,
          savePrice: saveAdminPrice,
          setTab: selectAdminTab,
          updateSettings: updateAdminSettings,
        },
        snapshot: {
          apiServices: state.apiServices,
          claudeCodeApi: state.claudeCodeApi,
          claudeCodeModelNotice: state.claudeCodeModelNotice,
          claudeCodeModels: state.claudeCodeModels,
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
        actions: createConversationReactActions(context),
        api,
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
          selectContact: selectConversationCompactorContact,
        },
        error: state.conversationCompactorError,
        loading: state.conversationCompactorLoading,
        snapshot: state.conversationCompactorSnapshot,
      },
    };
  }

  if (state.view === "relationships" && state.relationshipPage === "memory") {
    return {
      kind: "memory",
      props: {
        actions: {
          refreshStatus: refreshMemoryScope,
          returnToOverview: () => setRelationshipPage("overview"),
          selectContact: loadMemoryScope,
          setNotice,
          setRecallEnabled: setMemoryRecallEnabled,
        },
        api,
        loading: state.memoryContactSwitching,
        snapshot: {
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
        openMemory: () => setRelationshipPage("memory"),
        openSettings: () => setRelationshipPage("settings"),
      },
      snapshot: { memory: state.memoryStatus },
    },
  };
}

function buildWorkspace() {
  return {
    contentClassName: contentClassName(),
    notice: currentGlobalNotice(),
    onboarding: onboardingWorkspace(),
    route: routeForCurrentView(),
  };
}

function render() {
  updateShell();
  const workspace = buildWorkspace();
  renderAppWorkspace(workspace);
}

async function refreshData() {
  setLoading(true);
  try {
    state.settings = await api.settings.get();
    applyTheme();
    const needsOnboardingApiSnapshot = state.settings?.onboardingCompleted !== true
      && !String(state.settings?.contactsRoot || "").trim();
    const apiServicesSnapshot = needsOnboardingApiSnapshot
      ? api.connections.apiServicesSnapshot().catch(() => state.apiServices)
      : Promise.resolve(state.apiServices);
    [state.data, state.memoryStatus, state.todayCalendar, state.claudeCodeApi, state.apiServices] = await Promise.all([
      api.ledger.scan(),
      api.memory.status({ contactId: state.memoryContactId }),
      api.todayCalendar.snapshot(),
      api.agentRuntime.claudeCodeApiSnapshot().catch(() => null),
      apiServicesSnapshot,
    ]);
    state.memoryContactId = String(state.memoryStatus?.selectedContactId || "");
    if (!state.onboardingInitialized) {
      state.onboardingInitialized = true;
      if (shouldShowOnboarding(state.settings)) {
        state.onboardingOpen = true;
        state.onboardingStep = resolveOnboardingStep(state);
      }
    }
  } catch (error) {
    state.data = { status: "needs-project", warning: `读取失败：${error?.message || error}` };
  } finally {
    setLoading(false);
    render();
  }
}

function bindStaticShellEvents() {
  window.addEventListener("suzu-shell:navigate", (event) => setView(event.detail?.view));
  window.addEventListener("suzu-today:set-month", (event) => {
    const month = String(event.detail?.month || "");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(month)) return;
    state.todayMonth = month;
    render();
  });
  window.addEventListener("suzu-today:select-date", (event) => {
    const date = String(event.detail?.date || "");
    if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u.test(date)) return;
    const check = new Date(`${date}T12:00:00`);
    if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== date) return;
    state.todaySelectedDate = date;
    state.todayMonth = date.slice(0, 7);
    render();
  });
  window.addEventListener("suzu-today:go-today", () => {
    const today = new Date();
    state.todaySelectedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    state.todayMonth = state.todaySelectedDate.slice(0, 7);
    render();
  });
  window.addEventListener("suzu-today:open-editor", () => {
    if (state.todayCalendar?.canEdit !== true) return;
    state.todayEventEditor = { event: null };
    render();
  });
  window.addEventListener("suzu-today:edit-event", (event) => {
    const id = String(event.detail?.id || "");
    const contactId = String(event.detail?.contactId || "");
    const item = (state.todayCalendar?.events || []).find((candidate) => (
      candidate.id === id && candidate.contactId === contactId && candidate.editable
    ));
    if (!item) return;
    state.todayEventEditor = { event: item };
    render();
  });
  window.addEventListener("suzu-today:close-editor", () => {
    if (!state.todayEventEditor) return;
    state.todayEventEditor = null;
    render();
  });
  window.addEventListener("suzu-today:save-event", async (event) => {
    try {
      state.todayCalendar = await api.todayCalendar.saveEvent(event.detail || {});
      state.todayEventEditor = null;
      setNotice("纪念日已保存。");
      render();
    } catch (error) {
      setNotice(error?.message || String(error));
    }
  });
  window.addEventListener("suzu-today:remove-event", async (event) => {
    const id = String(event.detail?.id || "");
    const contactId = String(event.detail?.contactId || "");
    const name = String(event.detail?.name || "这项纪念日");
    if (!id || !contactId || !window.confirm(`删除“${name}”？`)) return;
    try {
      state.todayCalendar = await api.todayCalendar.removeEvent({ contactId, id });
      state.todayEventEditor = null;
      setNotice("纪念日已删除。");
      render();
    } catch (error) {
      setNotice(error?.message || String(error));
    }
  });
  window.addEventListener("suzu-today:open-conversation", () => {
    setView("relationships");
    setRelationshipPage("conversation");
  });
  window.addEventListener("suzu-today:open-usage", () => {
    setAdminTab("usage");
    setView("admin");
  });
}

bindStaticShellEvents();
refreshData();
