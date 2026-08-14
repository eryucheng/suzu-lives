import { escapeHtml } from "../../core/formatters.mjs";
import { pageIntro } from "../../components/panel.mjs";

function settingRow(title, help, value, action, trusted = false) {
  return `<article class="setting-row"><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(help)}</p></div><div class="setting-value" title="${trusted ? "" : escapeHtml(value)}">${trusted ? value : escapeHtml(value)}</div>${action}</article>`;
}

function settingsTabs(activeTab) {
  const tabs = [["general", "常规"], ["data", "数据"]];
  return `<div class="admin-tabs" aria-label="设置分类">${tabs.map(([id, label]) => `<button class="admin-tab ${activeTab === id ? "active" : ""}" data-settings-tab="${id}">${label}</button>`).join("")}</div>`;
}

function agentWorkspaceRow(settings) {
  return settingRow("Agent 工作目录", "新建联系人时，Suzu 会在这个目录下自动创建独立 Claude 项目。", settings.contactsRoot || "尚未选择", '<button class="secondary-button" data-select-contact-projects-root>选择目录</button>');
}

export function renderManagedAgentRuntimeSettings({ state }) {
  const settings = state.settings || {};
  const claudeToolPermissions = settings.claudeToolPermissions || {};
  const permissionControls = [["read", "允许读取文件"], ["webFetch", "允许网页抓取"], ["webSearch", "允许网页搜索"]]
    .map(([key, label]) => `<label class="settings-permission-check"><input type="checkbox" data-claude-tool-permission="${key}" ${claudeToolPermissions[key] !== false ? "checked" : ""}><span>${label}</span></label>`)
    .join("");
  const claudeRuntimeFeatures = settings.claudeRuntimeFeatures || {};
  const runtimeFeatureControls = [["subagents", "允许子 Agent"], ["taskList", "允许任务清单"], ["backgroundTasks", "允许后台任务"], ["nativeCron", "允许 Claude 原生 Cron"], ["askUserQuestion", "允许选择题追问"]]
    .map(([key, label]) => `<label class="settings-permission-check"><input type="checkbox" data-claude-runtime-feature="${key}" ${claudeRuntimeFeatures[key] === true ? "checked" : ""}><span>${label}</span></label>`)
    .join("");
  const baseCapabilityStates = [["读取文件", claudeToolPermissions.read !== false], ["查找文件", true], ["搜索文件内容", true], ["修改文件", true], ["新建或覆盖文件", true], ["执行终端命令", true], ["网页抓取", claudeToolPermissions.webFetch !== false], ["网页搜索", claudeToolPermissions.webSearch !== false]]
    .map(([label, enabled]) => `<span class="settings-permission-check"><span>${label}</span><em>${enabled ? "已开启" : "已关闭"}</em></span>`)
    .join("");
  const runtimeCapabilities = `<details><summary>点击展开查看</summary><div class="settings-permission-options">${baseCapabilityStates}</div><div class="settings-permission-options">${runtimeFeatureControls}</div></details>`;
  return `<section class="runtime-global-settings"><header class="runtime-global-settings__intro"><span class="reference-kicker">AGENT DEFAULTS</span><h2>默认运行规则</h2><p>这些设置会作为所有联系人项目的默认运行规则。</p></header><section class="settings-list">${settingRow("Claude 工具权限", "所有联系人项目的默认允许项；修改后会同步写入每个联系人的 Claude 设置。", `<span class="settings-permission-options">${permissionControls}</span>`, "", true)}${settingRow("Claude 内建能力", "点击查看当前 Suzu 对话可用的基础工具，以及按需开启的扩展能力。", runtimeCapabilities, "", true)}</section></section>`;
}

function renderGeneral({ state }) {
  const settings = state.settings || {};
  return `<section class="settings-list">${settingRow("首次设置", settings.onboardingCompleted === true ? "已经完成初次设置；需要时可以重新查看文字模型、多模态 API 和联系人步骤。" : "还没有完成初次设置；可以继续配置文字模型并创建联系人。", settings.onboardingCompleted === true ? "已完成" : "待完成", '<button class="secondary-button" data-open-onboarding>打开引导</button>')}${settingRow("外观", "选择软件的显示风格，会自动保留到下次打开。", `<span class="theme-options"><button class="theme-choice ${settings.theme !== "dark" ? "active" : ""}" data-theme-choice="light">浅色</button><button class="theme-choice ${settings.theme === "dark" ? "active" : ""}" data-theme-choice="dark">深色</button></span>`, "", true)}</section>`;
}

function renderData({ state }) {
  const settings = state.settings || {};
  const storage = settings.dataStorage || {};
  const dataRoot = storage.dataRoot || settings.dataRoot || "等待初始化";
  const previousDataRoot = storage.previousDataRoot || "";
  const failedMigration = storage.failedMigration;
  const previousCopy = previousDataRoot
    ? settingRow("旧位置的安全副本", "确认新位置可用后再清理，避免迁移意外造成数据丢失。", previousDataRoot, `<span class="storage-actions"><button class="secondary-button" data-show-path="${escapeHtml(previousDataRoot)}">打开旧位置</button><button class="secondary-button" data-remove-previous-data-copy>清理旧副本</button></span>`)
    : "";
  const migrationFailure = failedMigration
    ? `<section class="settings-transfer settings-transfer--warning"><div><span class="reference-kicker">迁移未完成</span><h2>数据仍保留在原位置</h2><p>${escapeHtml(failedMigration.message || "请重新选择一个新的保存位置。")}</p></div></section>`
    : "";
  return `<section class="settings-list">${settingRow("数据存储位置", "设置、API 连接、Agent 数据、生成内容和本地缓存都会保存在这里。", dataRoot, `<span class="storage-actions"><button class="secondary-button" data-show-path="${escapeHtml(dataRoot)}">打开位置</button><button class="primary-button" data-change-data-location>更换位置</button></span>`)}${agentWorkspaceRow(settings)}</section>${previousCopy ? `<section class="settings-list settings-list--followup">${previousCopy}</section>` : ""}${migrationFailure}`;
}

export function renderSettings(context) {
  const tab = ["general", "data"].includes(context.state.settingsTab) ? context.state.settingsTab : "general";
  const body = tab === "data" ? renderData(context) : renderGeneral(context);
  return `${pageIntro("SETTINGS", "设置", "调整软件外观与数据存储。")}${settingsTabs(tab)}${body}`;
}

export function bindManagedAgentRuntimeSettingsEvents(context) {
  document.querySelectorAll("[data-settings-tab]").forEach((button) => button.addEventListener("click", () => {
    context.setSettingsTab(button.dataset.settingsTab);
    context.render();
  }));
  document.querySelector("[data-select-contact-projects-root]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await context.api.settings.selectProject();
      if (!result?.canceled && result?.settings) {
        context.state.settings = { ...context.state.settings, ...result.settings };
        await context.refreshData();
      } else {
        context.render();
      }
    } catch (error) {
      context.setNotice(`无法选择 Agent 工作目录：${error?.message || error}`);
      button.disabled = false;
    }
  });
  document.querySelector("[data-open-onboarding]")?.addEventListener("click", () => context.openOnboarding?.());
  document.querySelectorAll("[data-claude-tool-permission]").forEach((input) => input.addEventListener("change", async (event) => {
    const control = event.currentTarget;
    const key = control.dataset.claudeToolPermission;
    if (!["read", "webFetch", "webSearch"].includes(key)) return;
    const current = context.state.settings?.claudeToolPermissions || {};
    const next = {
      read: current.read !== false,
      webFetch: current.webFetch !== false,
      webSearch: current.webSearch !== false,
      [key]: control.checked,
    };
    control.disabled = true;
    try {
      context.state.settings = await context.api.settings.update({ claudeToolPermissions: next });
      context.render();
    } catch (error) {
      context.setNotice(`无法更新 Claude 工具权限：${error?.message || error}`);
      control.disabled = false;
    }
  }));
  document.querySelectorAll("[data-claude-runtime-feature]").forEach((input) => input.addEventListener("change", async (event) => {
    const control = event.currentTarget;
    const key = control.dataset.claudeRuntimeFeature;
    if (!["subagents", "taskList", "backgroundTasks", "nativeCron", "askUserQuestion"].includes(key)) return;
    const current = context.state.settings?.claudeRuntimeFeatures || {};
    const next = {
      subagents: current.subagents === true,
      taskList: current.taskList === true,
      backgroundTasks: current.backgroundTasks === true,
      nativeCron: current.nativeCron === true,
      askUserQuestion: current.askUserQuestion === true,
      [key]: control.checked,
    };
    control.disabled = true;
    try {
      context.state.settings = await context.api.settings.update({ claudeRuntimeFeatures: next });
      context.render();
    } catch (error) {
      context.setNotice(`无法更新 Claude 内建能力：${error?.message || error}`);
      control.disabled = false;
    }
  }));
  document.querySelector("[data-change-data-location]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await context.api.settings.changeDataLocation();
      if (result?.status === "unchanged") context.setNotice("当前数据已经在这个位置，无需迁移。");
    } catch (error) {
      context.setNotice(`无法更换数据位置：${error?.message || error}`);
      button.disabled = false;
    }
  });
  document.querySelector("[data-remove-previous-data-copy]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await context.api.settings.removePreviousDataCopy();
      if (result?.settings) context.state.settings = result.settings;
      context.render();
      if (result?.status === "removed") context.setNotice("旧位置的数据副本已清理。");
    } catch (error) {
      context.setNotice(`无法清理旧数据副本：${error?.message || error}`);
      button.disabled = false;
    }
  });
}

export function bindSettingsEvents(context) {
  bindManagedAgentRuntimeSettingsEvents(context);
}
