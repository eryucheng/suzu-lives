import { state } from "./core/state.mjs";
import { CLAUDE_CODE_API_PROVIDERS, loadClaudeCodeApi, loadApiServices, loadCapabilities } from "./features/agent/runtime.mjs";
import { resolveOnboardingStep, shouldShowOnboarding } from "./features/onboarding/index.mjs";
import { conversationReactSnapshot, createConversationReactActions, isScheduledAgentReply, startConversationPolling, stopConversationPolling } from "./features/conversation/index.mjs";
import { loadRelationshipFiles, selectRelationshipContact } from "./features/relationship-settings/index.mjs";
import { getAgentProfile, getIdentity } from "./core/identity.mjs";
import { getSuzuSearchItem } from "./core/suzu-search.mjs";
import { renderAppWorkspace, setGlobalNotice } from "./react/app-shell.jsx";
import { endActiveConversationCall } from "./react/conversation-call-coordinator.mjs";

const api = window.suzuConsole;
const loading = document.querySelector("#loading");
const loadingText = document.querySelector("#loadingText");
const shellViews = new Set(["today", "relationships", "plans", "create", "capabilities", "settings"]);
const CAPABILITY_SETTINGS_LABELS = Object.freeze({
  "image-generation": "图片生成设置",
  "image-vision": "图片理解设置",
  "phone-camera": "手机拍照设置",
  "proactive-contact": "主动关心设置",
  "time-awareness": "时间感知设置",
  "video-understanding": "视频理解设置",
  "voice-message": "语音设置",
});
const GLOBAL_NOTICE_TIMEOUT_MS = 6_000;
const INCOMING_CONVERSATION_NOTICE_TIMEOUT_MS = 6_000;

let globalNoticeTimeout = null;
let incomingConversationNoticeTimeout = null;
let settingsContactsRequest = 0;
let appUpdateRequest = 0;
let systemStatusRequest = 0;

document.documentElement.dataset.theme = new URLSearchParams(window.location.search).get("theme") === "dark" ? "dark" : "light";

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
  const theme = state.settings?.theme === "dark" ? "dark" : "light";
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
  }
  render();
  if (view === "settings" && state.settingsTab === "privacy") void loadSettingsContacts();
  if (view === "settings") void loadAppUpdateStatus();
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
  if (nextPage === "conversation") clearIncomingConversationNotice();
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
  state.settingsTab = ["general", "data", "privacy"].includes(tab) ? tab : "general";
  if (state.settingsTab === "privacy") void loadSettingsContacts();
}

function openSuzuSearchItem(value) {
  const entry = getSuzuSearchItem(typeof value === "string" ? value : value?.id);
  const target = entry?.target || {};
  const view = String(target.view || "");
  if (!view) return;

  if (view === "relationships") {
    setView("relationships");
    if (target.relationshipPage) setRelationshipPage(target.relationshipPage);
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

function appUpdateMessage(result, fallback) {
  return String(result?.message || "").trim() || fallback;
}

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
    const snapshot = await api.conversation?.snapshot?.();
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
    const snapshot = await api.conversation.updateContactPresentation({ id: contactId, hidden: false });
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

const context = { api, applyTheme, loadClaudeCodeApi, loadApiServices, loadSchedules, openOnboarding, refreshData, refreshTodayCalendar, render, setAdminTab, setCapabilityPage, setCreatePage, setNotice, setRelationshipPage, setSettingsTab, setView, state };

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
  if (contactId && typeof api.conversation?.snapshot === "function") {
    try {
      const snapshot = await api.conversation.snapshot();
      const contacts = Array.isArray(snapshot?.contacts) ? snapshot.contacts : [];
      contact = contacts.find((item) => String(item?.id || "").trim() === contactId) || null;
      activeContactId = String(snapshot?.activeContact?.id || "").trim();
    } catch {
      // A notification remains useful even if the contact list is momentarily unavailable.
    }
  }
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
    contactId,
    preview,
    senderName: String(profile?.displayName || "Suzu").trim() || "Suzu",
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
    await endActiveConversationCall();
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
    void showIncomingConversationNotice(event);
  });
  // This also records the renderer as the event recipient in the main process,
  // so scheduled replies can arrive while another page is open.
  void api.conversation.snapshot?.().catch(() => undefined);
}

observeIncomingConversationMessages();

async function refreshTodayCalendar() {
  try {
    state.todayCalendar = await api.todayCalendar.snapshot();
  } catch (error) {
    state.todayCalendar = { status: "invalid", events: [], canEdit: false, message: error?.message || String(error) };
  }
  if (state.view === "today") render();
}

function setTodayMonth(value) {
  const month = String(value || "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(month)) return;
  state.todayMonth = month;
  render();
}

function selectTodayDate(value) {
  const date = String(value || "");
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u.test(date)) return;
  const check = new Date(`${date}T12:00:00`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== date) return;
  state.todaySelectedDate = date;
  state.todayMonth = date.slice(0, 7);
  render();
}

function goToToday() {
  const today = new Date();
  state.todaySelectedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  state.todayMonth = state.todaySelectedDate.slice(0, 7);
  render();
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
    state.todayCalendar = await api.todayCalendar.saveEvent(value || {});
    state.todayEventEditor = null;
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
    state.todayCalendar = await api.todayCalendar.removeEvent({ contactId: ownerId, id: eventId });
    state.todayEventEditor = null;
    setNotice("纪念日已删除。");
    render();
  } catch (error) {
    setNotice(error?.message || String(error));
  }
}

function openTodayConversation() {
  setView("relationships");
  setRelationshipPage("conversation");
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

async function selectConversationCompactorImportJsonl() {
  return api.conversationCompactor.selectImportJsonl();
}

async function importConversationCompactorJsonl(value) {
  const snapshot = await api.conversationCompactor.importJsonl(value);
  state.conversationCompactorSnapshot = snapshot;
  state.conversationCompactorLoading = false;
  state.conversationCompactorError = "";
  setNotice("历史 JSONL 已替换当前联系人的会话记录，并完成会话绑定。 ");
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
    state.view === "relationships" && state.relationshipPage === "memory" ? "content--memory" : "",
  ].filter(Boolean).join(" ");
}

function routeForCurrentView() {
  if (state.view === "today") {
    return {
      kind: "today",
      props: {
        actions: {
          closeEditor: closeTodayEventEditor,
          editEvent: editTodayEvent,
          goToday: goToToday,
          openConversation: openTodayConversation,
          openEditor: openTodayEventEditor,
          openUsage: openTodayUsage,
          removeEvent: removeTodayEvent,
          saveEvent: saveTodayEvent,
          selectDate: selectTodayDate,
          setMonth: setTodayMonth,
        },
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
          openVisual: () => openCapabilityCreatePage("visual"),
          openApiServices: openCapabilityApiServices,
          returnToCategory: (category) => setCapabilityPage("category", category),
          returnToOverview: () => setCapabilityPage("overview"),
          setCapabilityActive,
          saveSettings: saveCapabilitySettings,
          setContactEnabled: setCapabilityContactEnabled,
          voiceDesign: api.voiceDesign,
          saveWechatSettings,
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
          checkForUpdate: checkAppUpdate,
          checkSystemStatus,
          downloadUpdate: downloadAppUpdate,
          installUpdate: installAppUpdate,
          openDirectory: openSettingsDirectory,
          openOnboarding,
          removePreviousCopy: removeSettingsPreviousCopy,
          restoreHiddenContact,
          selectWorkspace: selectSettingsWorkspace,
          setTab: (tab) => {
            setSettingsTab(tab);
            render();
          },
        },
        snapshot: {
          contacts: state.settingsContacts,
          contactsLoading: state.settingsContactsLoading,
          appUpdate: state.appUpdate,
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
          importJsonl: importConversationCompactorJsonl,
          run: runConversationCompactor,
          save: saveConversationCompactorSettings,
          selectImportJsonl: selectConversationCompactorImportJsonl,
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
    actions: { answerIncomingVoiceCall, declineIncomingVoiceCall, navigate: setView, openSuzuSearchItem },
    activeView: state.view,
    contentClassName: contentClassName(),
    conversationUnread: state.conversationUnread,
    incomingConversationNotice: state.incomingConversationNotice,
    incomingVoiceCall: state.incomingVoiceCall,
    notice: currentGlobalNotice(),
    onboarding: onboardingWorkspace(),
    route: routeForCurrentView(),
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

refreshData();
