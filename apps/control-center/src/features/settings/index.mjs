import { escapeHtml } from "../../core/formatters.mjs";
import { pageIntro } from "../../components/panel.mjs";

function settingRow(title, help, value, action, trusted = false) {
  return `<article class="setting-row"><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(help)}</p></div><div class="setting-value" title="${trusted ? "" : escapeHtml(value)}">${trusted ? value : escapeHtml(value)}</div>${action}</article>`;
}

function settingsTabs(activeTab) {
  const tabs = [["general", "常规"], ["data", "数据"]];
  return `<div class="admin-tabs" aria-label="设置分类">${tabs.map(([id, label]) => `<button class="admin-tab ${activeTab === id ? "active" : ""}" data-settings-tab="${id}">${label}</button>`).join("")}</div>`;
}

export function renderManagedAgentRuntimeSettings({ state }) {
  return `<section class="runtime-global-settings"><header class="runtime-global-settings__intro"><span class="reference-kicker">COMPANION RUNTIME</span><h2>陪伴运行能力</h2><p>当前 Suzu 使用自己的陪伴 Agent Core：能自然对话，也能直接使用本机已有的能力。</p></header><section class="settings-list">${settingRow("已启用", "Windows 可使用 PowerShell、文件工具和后台任务；现有 Suzu CLI、已启用的图像/视频理解、图像生成和语音能力都可按联系人配置调用，调用与结果会显示在对话里。", "PowerShell · 文件 · CLI · 媒体能力", "")}${settingRow("当前尚未接入", "浏览器、子 Agent 和游戏控制还没有接入此 profile；它们会在真正可用后明确显示。", "等待插件", "")}</section></section>`;
}

function renderGeneral({ state }) {
  const settings = state.settings || {};
  return `<section class="settings-list">${settingRow("外观", "选择软件的显示风格，会自动保留到下次打开。", `<span class="theme-options"><button class="theme-choice ${settings.theme !== "dark" ? "active" : ""}" data-theme-choice="light">浅色</button><button class="theme-choice ${settings.theme === "dark" ? "active" : ""}" data-theme-choice="dark">深色</button></span>`, "", true)}</section>`;
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
  return `<section class="settings-list">${settingRow("数据存储位置", "设置、API 连接、Agent 数据、生成内容和本地缓存都会保存在这里。", dataRoot, `<span class="storage-actions"><button class="secondary-button" data-show-path="${escapeHtml(dataRoot)}">打开位置</button><button class="primary-button" data-change-data-location>更换位置</button></span>`)}</section>${previousCopy ? `<section class="settings-list settings-list--followup">${previousCopy}</section>` : ""}${migrationFailure}`;
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
