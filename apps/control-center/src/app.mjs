import { fileName } from "./core/formatters.mjs";
import { getAgentProfile, profileInitial } from "./core/identity.mjs";
import { isReady, state } from "./core/state.mjs";
import { renderAdmin, renderCapabilities, bindAgentEvents, loadAgentRuntimeConfig, loadClaudeCodeApi, loadApiServices, loadCapabilities } from "./features/agent/index.mjs";
import { bindSettingsEvents, renderSettings } from "./features/settings/index.mjs";
import { bindOnboardingEvents, renderOnboarding, resolveOnboardingStep, shouldShowOnboarding } from "./features/onboarding/index.mjs";
import { bindConversationEvents, renderConversation, renderRelationshipOverview, startConversationPolling, stopConversationPolling } from "./features/conversation/index.mjs";
import { bindRelationshipSettingsEvents, loadRelationshipFiles, renderRelationshipSettings } from "./features/relationship-settings/index.mjs";
import { bindCreateEvents, loadVisualReferences, renderCreate } from "./features/create/index.mjs";
import { bindDrawingEvents, loadDrawing, renderDrawing } from "./features/create/drawing.mjs";
import { bindCreateOverviewEvents, renderCreateOverview } from "./features/create/overview.mjs";
import { bindVoiceDesignEvents, loadVoiceDesign, renderVoiceDesign } from "./features/create/audio.mjs";
import { bindMemoryEvents, renderMemory } from "./features/memory/index.mjs";
import { bindShellEvents, initializeShellIcons, renderShellView } from "./features/shell/index.mjs";
import { bindUsageEvents } from "./features/usage/index.mjs";

const api = window.suzuConsole;
const content = document.querySelector("#content");
const notice = document.querySelector("#notice");
const loading = document.querySelector("#loading");
const loadingText = document.querySelector("#loadingText");
const projectName = document.querySelector("#projectName");
const agentAvatarImage = document.querySelector("#agentAvatarImage");
const agentAvatarInitial = document.querySelector("#agentAvatarInitial");
const shellViews = new Set(["today", "relationships", "plans", "create", "capabilities", "actions", "settings"]);

document.documentElement.dataset.theme = new URLSearchParams(window.location.search).get("theme") === "light" ? "light" : "dark";

function setLoading(active, text = "正在读取本地状态…") {
  loading.classList.toggle("hidden", !active);
  loadingText.textContent = text;
}

function setNotice(message = "") {
  notice.textContent = message;
  notice.classList.toggle("hidden", !message);
}

function applyTheme() {
  document.documentElement.dataset.theme = state.settings?.theme === "light" ? "light" : "dark";
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
  if (view === "create" && state.createPage === "visual") loadDrawing(context);
  if (view === "create" && state.createPage === "audio") loadVoiceDesign(context);
  if (view === "capabilities") loadCapabilities(context);
  if (view === "plans") loadSchedules();
  if (view === "today") refreshTodayCalendar();
  if (view === "admin" && state.adminTab === "claude-code") loadClaudeCodeApi(context);
  if (view === "admin" && state.adminTab === "api-services") loadApiServices(context);
  if (view === "admin" && state.adminTab === "runtime") loadAgentRuntimeConfig(context);
}

function setRelationshipPage(page) {
  const nextPage = ["overview", "conversation", "memory", "settings"].includes(page) ? page : "overview";
  stopConversationPolling();
  if (nextPage === "memory") {
    state.memoryViewMode = state.memoryStatus?.status === "ready" ? "brain" : "library";
    state.memoryEditMode = false;
    state.memoryEditing = null;
    state.memoryBrainSelectedId = "";
    state.memoryAttributionProposals = null;
    state.memoryStructureProposals = null;
    state.memoryAttributionLoading = false;
    state.memoryAttributionError = "";
    state.memoryAttributionResolvingId = "";
    state.memoryStructureLoading = false;
    state.memoryStructureError = "";
    state.memoryStructureResolvingId = "";
  }
  state.relationshipPage = nextPage;
  render();
  if (nextPage === "conversation") startConversationPolling(context);
  if (nextPage === "settings") loadRelationshipFiles(context);
}
function setCreatePage(page) {
  if (!["overview", "visual", "audio"].includes(page)) return;
  state.createPage = page;
  render();
  if (page === "visual") loadDrawing(context);
  if (page === "audio") loadVoiceDesign(context);
}

function setAdminTab(tab) {
  state.adminTab = ["overview", "agent", "claude-code", "runtime", "api-services", "usage"].includes(tab) ? tab : "overview";
  if (state.adminTab !== "runtime") state.runtimeSection = "overview";
}

function setRuntimeSection(section) {
  state.runtimeSection = ["overview", "claude"].includes(section) ? section : "overview";
}

function setCapabilityPage(page, category = "", abilityId = "") {
  if (page === "overview") {
    state.capabilityPage = "overview";
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
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
  const root = state.data?.projectRoot || state.settings?.projectRoot || "";
  const profile = getAgentProfile(state.settings);
  projectName.textContent = profile.displayName || (root ? fileName(root) : "未选择");
  agentAvatarImage.src = profile.avatarDataUrl || "";
  agentAvatarImage.classList.toggle("hidden", !profile.avatarDataUrl);
  agentAvatarInitial.classList.toggle("hidden", Boolean(profile.avatarDataUrl));
  agentAvatarInitial.textContent = profileInitial(profile, root ? fileName(root) : "S");
  document.querySelector(".agent-selector").classList.toggle("connected", isReady());
}

function openOnboarding() {
  state.onboardingOpen = true;
  state.onboardingStep = resolveOnboardingStep(state);
  state.onboardingError = "";
  render();
}

const context = { api, applyTheme, loadAgentRuntimeConfig, loadClaudeCodeApi, loadApiServices, loadSchedules, openOnboarding, refreshData, refreshTodayCalendar, render, setAdminTab, setCapabilityPage, setCreatePage, setNotice, setRelationshipPage, setRuntimeSection, setSettingsTab, setView, state };

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

function renderRelationshipPage() {
  if (state.relationshipPage === "conversation") return renderConversation(context);
  if (state.relationshipPage === "memory") return renderMemory(context);
  if (state.relationshipPage === "settings") return renderRelationshipSettings(context);
  return renderRelationshipOverview(context);
}

function render() {
  updateShell();
  setNotice(state.data?.status === "needs-project" ? "" : state.data?.warning || "");
  content.classList.toggle("content--conversation", state.view === "relationships" && state.relationshipPage === "conversation");
  const page = state.view === "admin"
    ? renderAdmin(context)
    : state.view === "capabilities"
      ? renderCapabilities(context)
    : state.view === "settings"
      ? renderSettings(context)
    : state.view === "relationships"
      ? renderRelationshipPage()
      : state.view === "create"
        ? state.createPage === "visual"
          ? renderDrawing(context)
          : state.createPage === "audio"
            ? renderVoiceDesign(context)
            : renderCreateOverview(context)
        : renderShellView(state.view, context);
  content.innerHTML = `${page}${renderOnboarding(context)}`;
  if (state.view === "relationships") {
    bindConversationEvents(context);
    if (state.relationshipPage === "memory") bindMemoryEvents(context);
    if (state.relationshipPage === "settings") bindRelationshipSettingsEvents(context);
  }
  if (state.view === "create" && state.createPage === "overview") bindCreateOverviewEvents(context);
  if (state.view === "create" && state.createPage === "visual") bindDrawingEvents(context);
  if (state.view === "create" && state.createPage === "audio") bindVoiceDesignEvents(context);
  if (state.view === "admin" || state.view === "capabilities") {
    bindAgentEvents(context);
    if (state.view === "admin") bindUsageEvents(context);
  } else if (state.view === "settings") {
    bindSettingsEvents(context);
    bindAgentEvents(context);
  } else {
    bindShellEvents(context);
  }
  bindOnboardingEvents(context);
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
      api.memory.status(),
      api.todayCalendar.snapshot(),
      api.agentRuntime.claudeCodeApiSnapshot().catch(() => null),
      apiServicesSnapshot,
    ]);
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
  document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  document.querySelector("#refreshButton").addEventListener("click", refreshData);
  document.querySelector("#approvalButton").addEventListener("click", () => setView("actions"));
  document.querySelector("#agentSelector").addEventListener("click", () => {
    setAdminTab("agent");
    setView("admin");
  });
  document.querySelector(".global-command").addEventListener("click", () => setNotice("“问 Suzu 或搜索”入口正在准备中，当前不会发送或检索任何数据。"));
}

initializeShellIcons();
bindStaticShellEvents();
refreshData();
