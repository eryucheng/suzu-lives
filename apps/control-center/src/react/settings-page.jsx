import { useState } from "react";
import { Button, GlassPanel, PageHeader, Status, Tabs } from "suzu-design-system";

import "./settings-page.css";

const SETTINGS_TABS = [
  { label: "常规", value: "general" },
  { label: "数据", value: "data" },
  { label: "隐私", value: "privacy" },
];

function cleanText(value) {
  return String(value || "").trim();
}

function dataPath(value, fallback) {
  const path = cleanText(value);
  return path && path !== "等待初始化" ? path : fallback;
}

function SettingCard({ children, className = "" }) {
  return <GlassPanel as="section" className={`settings-card ${className}`.trim()} intensity="soft">{children}</GlassPanel>;
}

function DirectoryCard({ action, configured, description, onOpen, onSelect, pending, title, value }) {
  const changing = configured ? "更换位置" : "选择目录";
  return (
    <SettingCard className="settings-directory-card">
      <div className="settings-card__layout">
        <div className="settings-card__copy">
          <div className="settings-card__meta">
            <span className="settings-card__eyebrow">{action}</span>
            <Status label={configured ? "已设置" : "未设置"} tone={configured ? "success" : "muted"} />
          </div>
          <h2>{title}</h2>
          <p>{description}</p>
          <code className="settings-directory-card__path" title={value}>{value}</code>
        </div>
        <div className="settings-card__actions">
          <Button className="settings-action-button" disabled={!configured || pending} onClick={onOpen} size="md" variant="secondary">打开目录</Button>
          <Button className="settings-action-button" disabled={pending} onClick={onSelect} size="md" variant="secondary">{changing}</Button>
        </div>
      </div>
    </SettingCard>
  );
}

function SoftwareUpdate({ onCheckForUpdate, onDownloadUpdate, onInstallUpdate, pending, update }) {
  const status = cleanText(update?.status).toLowerCase();
  const version = cleanText(update?.version);
  const availableVersion = cleanText(update?.availableVersion);
  const copy = cleanText(update?.message) || (version ? `当前版本 v${version}，点击检查更新。` : "点击检查更新。");
  const presentation = {
    available: { action: onDownloadUpdate, button: "下载更新", label: "可更新", tone: "success" },
    current: { action: onCheckForUpdate, button: "检查更新", label: "已是最新", tone: "success" },
    development: { action: onCheckForUpdate, button: "检查更新", label: "开发构建", tone: "muted" },
    downloaded: { action: onInstallUpdate, button: "重启并安装", label: "等待安装", tone: "success" },
    error: { action: onCheckForUpdate, button: "重新检查", label: "暂时不可用", tone: "warning" },
    manual: { action: onCheckForUpdate, button: "检查更新", label: "手动更新", tone: "muted" },
    ready: { action: onCheckForUpdate, button: "检查更新", label: "可检查", tone: "muted" },
    unavailable: { action: onCheckForUpdate, button: "重新检查", label: "暂未发布", tone: "warning" },
  }[status] || { action: onCheckForUpdate, button: "检查更新", label: "未检查", tone: "muted" };
  const busyLabel = pending === "check-update"
    ? "正在检查…"
    : pending === "download-update"
      ? "正在下载…"
      : pending === "install-update"
        ? "正在安装…"
        : presentation.button;

  return (
    <SettingCard>
      <div className="settings-card__layout">
        <div className="settings-card__copy">
          <div className="settings-card__meta"><span className="settings-card__eyebrow">SOFTWARE</span><Status label={presentation.label} tone={presentation.tone} /></div>
          <h2>软件更新</h2>
          <p>{copy}</p>
          {version ? <span className="settings-update-version">当前版本 v{version}{availableVersion ? ` · 可更新至 v${availableVersion}` : ""}</span> : null}
        </div>
        <div className="settings-card__actions">
          <Button className="settings-action-button" disabled={Boolean(pending)} onClick={presentation.action} size="md" variant="secondary">{busyLabel}</Button>
        </div>
      </div>
    </SettingCard>
  );
}

function GeneralSettings({ appUpdate, onCheckForUpdate, onDownloadUpdate, onInstallUpdate, onOpenOnboarding, onThemeChange, pending, settings }) {
  const completed = settings.onboardingCompleted === true;
  const theme = settings.theme === "dark" ? "dark" : "light";
  return (
    <div className="settings-card-stack">
      <SettingCard>
        <div className="settings-card__layout">
          <div className="settings-card__copy">
            <div className="settings-card__meta"><span className="settings-card__eyebrow">SETUP</span><Status label={completed ? "已完成" : "待完成"} tone={completed ? "success" : "warning"} /></div>
            <h2>首次设置</h2>
            <p>{completed ? "已经完成初次设置；需要时可以重新查看文字模型、多模态 API 和联系人步骤。" : "还没有完成初次设置；可以继续配置文字模型并创建联系人。"}</p>
          </div>
          <div className="settings-card__actions">
            <Button className="settings-action-button" disabled={pending} onClick={onOpenOnboarding} size="md" variant="secondary">打开引导</Button>
          </div>
        </div>
      </SettingCard>

      <SoftwareUpdate
        onCheckForUpdate={onCheckForUpdate}
        onDownloadUpdate={onDownloadUpdate}
        onInstallUpdate={onInstallUpdate}
        pending={pending}
        update={appUpdate}
      />

      <SettingCard>
        <div className="settings-card__layout">
          <div className="settings-card__copy">
            <span className="settings-card__eyebrow">APPEARANCE</span>
            <h2>外观</h2>
            <p>选择软件的显示风格，会自动保留到下次打开。</p>
          </div>
          <div className="settings-card__actions settings-theme-actions" role="group" aria-label="外观">
            <Button aria-pressed={theme === "light"} className={`settings-action-button settings-theme-choice ${theme === "light" ? "is-active" : ""}`} disabled={pending} onClick={() => onThemeChange("light")} size="md" variant="secondary">浅色</Button>
            <Button aria-pressed={theme === "dark"} className={`settings-action-button settings-theme-choice ${theme === "dark" ? "is-active" : ""}`} disabled={pending} onClick={() => onThemeChange("dark")} size="md" variant="secondary">深色</Button>
          </div>
        </div>
      </SettingCard>
    </div>
  );
}

function systemStatusPresentation(snapshot) {
  if (cleanText(snapshot?.error)) return { label: "检查失败", tone: "danger", detail: cleanText(snapshot.error) };
  const summary = snapshot?.summary || null;
  if (!summary) return { label: "尚未检查", tone: "muted", detail: "检查会读取 Suzu 数据、联系人项目和本机 Claude 配置；不会修改或执行任何文件。" };
  if (summary.status === "error") return { label: "发现异常", tone: "danger", detail: `发现 ${summary.errors} 项异常和 ${summary.warnings} 项需要确认的内容。` };
  if (summary.status === "warning") return { label: "需要确认", tone: "warning", detail: `发现 ${summary.warnings} 项需要确认的内容。` };
  return { label: "状态正常", tone: "success", detail: "没有发现受管文件的读取或结构异常。" };
}

function systemStatusState(item) {
  const state = cleanText(item?.state);
  if (state === "error") return { label: "异常", tone: "danger" };
  if (state === "warning") return { label: "需确认", tone: "warning" };
  if (state === "notice") return { label: "外部项", tone: "info" };
  if (state === "missing") return { label: "未创建", tone: "muted" };
  return { label: "正常", tone: "success" };
}

function systemStatusOwnership(item) {
  return {
    managed: "Suzu 管理",
    shared: "共同使用",
    runtime: "运行时数据",
    external: "外部/自定义",
  }[cleanText(item?.ownership)] || "未分类";
}

function formatCheckedAt(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "";
}

function SystemStatusMetadata({ metadata }) {
  const env = metadata?.env || null;
  const hooks = metadata?.hooks || null;
  const mcp = metadata?.mcpServers || null;
  const entries = [];
  if (env?.managedKeys?.length) entries.push(`Suzu 使用的环境键：${env.managedKeys.join("、")}`);
  if (env?.customKeys?.length) entries.push(`外部环境键：${env.customKeys.join("、")}`);
  if (hooks?.events?.length) entries.push(`Hook 事件：${hooks.events.join("、")}`);
  if (mcp?.shown?.length) entries.push(`MCP：${mcp.shown.join("、")}${mcp.truncated ? "等" : ""}`);
  return entries.length ? <ul className="settings-system-status-item__metadata">{entries.map((entry) => <li key={entry}>{entry}</li>)}</ul> : null;
}

function SystemStatusItem({ item }) {
  const state = systemStatusState(item);
  return (
    <article className={`settings-system-status-item is-${cleanText(item?.state) || "ok"}`}>
      <div className="settings-system-status-item__head">
        <div><strong>{cleanText(item?.title) || "未命名项目"}</strong><span>{systemStatusOwnership(item)} · {cleanText(item?.type) || "未知类型"}</span></div>
        <Status label={state.label} tone={state.tone} />
      </div>
      {cleanText(item?.detail) ? <p>{cleanText(item.detail)}</p> : null}
      {cleanText(item?.path) ? <code title={item.path}>{item.path}</code> : null}
      <SystemStatusMetadata metadata={item?.metadata} />
    </article>
  );
}

function SystemStatusCheck({ onCheck, pending, snapshot }) {
  const presentation = systemStatusPresentation(snapshot);
  const summary = snapshot?.summary || null;
  const sections = Array.isArray(snapshot?.sections) ? snapshot.sections : [];
  return (
    <SettingCard className="settings-system-status-card">
      <div className="settings-card__layout">
        <div className="settings-card__copy">
          <div className="settings-card__meta"><span className="settings-card__eyebrow">SYSTEM CHECK</span><Status label={presentation.label} tone={presentation.tone} /></div>
          <h2>系统状态检查</h2>
          <p>{presentation.detail}</p>
          {summary ? <span className="settings-system-status-card__summary">已检查 {summary.total} 项 · Suzu 管理 {summary.managed} 项 · 外部/自定义 {summary.external} 项{formatCheckedAt(snapshot?.checkedAt) ? ` · ${formatCheckedAt(snapshot.checkedAt)}` : ""}</span> : null}
        </div>
        <div className="settings-card__actions">
          <Button className="settings-action-button" disabled={pending} onClick={onCheck} size="md" variant="secondary">{pending ? "正在检查…" : "检查系统状态"}</Button>
        </div>
      </div>
      {sections.length ? <div className="settings-system-status-results">{sections.map((section) => {
        const items = Array.isArray(section?.items) ? section.items : [];
        const attention = items.some((entry) => ["error", "warning", "notice"].includes(cleanText(entry?.state)));
        return (
          <details className="settings-system-status-section" key={cleanText(section?.id) || cleanText(section?.title)} open={attention}>
            <summary><span><strong>{cleanText(section?.title) || "未命名范围"}</strong><small>{cleanText(section?.detail)}</small></span><em>{items.length} 项</em></summary>
            <div className="settings-system-status-list">{items.map((entry) => <SystemStatusItem item={entry} key={cleanText(entry?.id) || `${entry?.path}:${entry?.title}`} />)}</div>
          </details>
        );
      })}</div> : null}
    </SettingCard>
  );
}

function DataSettings({ onChangeDataLocation, onCheckSystemStatus, onOpenDirectory, onRemovePreviousCopy, onSelectWorkspace, pending, settings, systemStatus }) {
  const storage = settings.dataStorage || {};
  const workspacePath = cleanText(settings.contactsRoot);
  const currentDataPath = cleanText(storage.dataRoot || settings.dataRoot);
  const previousDataPath = cleanText(storage.previousDataRoot);
  const failedMigration = storage.failedMigration;
  const workspaceValue = dataPath(workspacePath, "尚未选择");
  const storageValue = dataPath(currentDataPath, "等待初始化");
  const hasWorkspace = Boolean(workspacePath);
  const hasDataStorage = Boolean(currentDataPath && currentDataPath !== "等待初始化");

  return (
    <div className="settings-card-stack">
      <DirectoryCard
        action="WORKSPACE"
        configured={hasWorkspace}
        description="新建联系人时，Suzu 会在这个目录下自动创建独立 Claude 项目。"
        onOpen={() => onOpenDirectory(workspacePath)}
        onSelect={onSelectWorkspace}
        pending={pending === "workspace"}
        title="Agent 工作目录"
        value={workspaceValue}
      />
      <DirectoryCard
        action="STORAGE"
        configured={hasDataStorage}
        description="设置、API 连接、Agent 数据、生成内容和本地缓存都会保存在这里。"
        onOpen={() => onOpenDirectory(currentDataPath)}
        onSelect={onChangeDataLocation}
        pending={pending === "data-location"}
        title="数据存储位置"
        value={storageValue}
      />
      <SystemStatusCheck
        onCheck={() => onCheckSystemStatus?.()}
        pending={pending === "system-status"}
        snapshot={systemStatus}
      />
      {previousDataPath ? (
        <SettingCard className="settings-followup-card">
          <div className="settings-card__layout">
            <div className="settings-card__copy">
              <div className="settings-card__meta"><span className="settings-card__eyebrow">SAFE COPY</span><Status label="待清理" tone="warning" /></div>
              <h2>旧位置的安全副本</h2>
              <p>确认新位置可用后再清理，避免迁移意外造成数据丢失。</p>
              <code className="settings-directory-card__path" title={previousDataPath}>{previousDataPath}</code>
            </div>
            <div className="settings-card__actions">
              <Button className="settings-action-button" disabled={pending === "old-copy"} onClick={() => onOpenDirectory(previousDataPath)} size="md" variant="secondary">打开旧位置</Button>
              <Button className="settings-action-button" disabled={pending === "old-copy"} onClick={onRemovePreviousCopy} size="md" variant="secondary">清理旧副本</Button>
            </div>
          </div>
        </SettingCard>
      ) : null}
      {failedMigration ? (
        <SettingCard className="settings-warning-card">
          <span className="settings-card__eyebrow">迁移未完成</span>
          <h2>数据仍保留在原位置</h2>
          <p>{cleanText(failedMigration.message) || "请重新选择一个新的保存位置。"}</p>
        </SettingCard>
      ) : null}
    </div>
  );
}

function PrivacySettings({ contactsSnapshot, loading, onRestoreContact, pending }) {
  const contacts = Array.isArray(contactsSnapshot?.contacts) ? contactsSnapshot.contacts : [];
  const hiddenContacts = contacts.filter((contact) => contact?.hidden === true);
  const error = cleanText(contactsSnapshot?.error);
  return (
    <div className="settings-card-stack">
      <SettingCard className="settings-privacy-card">
        <div className="settings-card__copy">
          <span className="settings-card__eyebrow">PRIVACY</span>
          <h2>隐藏联系人</h2>
          <p>隐藏只会让联系人不再出现在对话页列表中；消息、主动关心、记忆和其他资料都不会被删除或停用。</p>
        </div>
        {loading ? <p className="settings-privacy-card__status">正在读取隐藏联系人…</p> : null}
        {!loading && error ? <p className="settings-privacy-card__status is-error">无法读取隐藏联系人：{error}</p> : null}
        {!loading && !error && hiddenContacts.length ? (
          <div className="settings-privacy-contact-list">
            {hiddenContacts.map((contact) => {
              const id = cleanText(contact?.id);
              const name = cleanText(contact?.name) || "未命名联系人";
              return (
                <div className="settings-privacy-contact" key={id || name}>
                  <div><strong>{name}</strong><span>已从对话页隐藏</span></div>
                  <Button className="settings-action-button" disabled={Boolean(pending) || !id} onClick={() => onRestoreContact(id)} size="md" variant="secondary">显示联系人</Button>
                </div>
              );
            })}
          </div>
        ) : null}
        {!loading && !error && !hiddenContacts.length ? <p className="settings-privacy-card__status">没有隐藏的联系人。</p> : null}
      </SettingCard>
    </div>
  );
}

export function SettingsPage({ actions = {}, snapshot = {} }) {
  const settings = snapshot.settings || {};
  const tab = SETTINGS_TABS.some((item) => item.value === snapshot.tab) ? snapshot.tab : "general";
  const [pending, setPending] = useState("");
  const run = async (key, action) => {
    if (!action || pending) return;
    setPending(key);
    try {
      await action();
    } finally {
      setPending("");
    }
  };

  return (
    <div className="settings-react-page">
      <PageHeader eyebrow="SETTINGS" subtitle="调整软件外观、数据存储与联系人隐私。" title="设置" />
      <Tabs active={tab} className="settings-page-tabs" items={SETTINGS_TABS} onChange={actions.setTab} size="md" />
      <section className="settings-page-body" aria-label={tab === "data" ? "数据设置" : tab === "privacy" ? "隐私设置" : "常规设置"}>
        {tab === "data" ? (
          <DataSettings
            onChangeDataLocation={() => run("data-location", actions.changeDataLocation)}
            onCheckSystemStatus={() => run("system-status", actions.checkSystemStatus)}
            onOpenDirectory={(path) => run("open-directory", () => actions.openDirectory?.(path))}
            onRemovePreviousCopy={() => run("old-copy", actions.removePreviousCopy)}
            onSelectWorkspace={() => run("workspace", actions.selectWorkspace)}
            pending={pending}
            settings={settings}
            systemStatus={snapshot.systemStatus}
          />
        ) : tab === "privacy" ? (
          <PrivacySettings
            contactsSnapshot={snapshot.contacts}
            loading={snapshot.contactsLoading === true}
            onRestoreContact={(id) => run(`restore-${id}`, () => actions.restoreHiddenContact?.(id))}
            pending={pending}
          />
        ) : (
          <GeneralSettings
            appUpdate={snapshot.appUpdate}
            onCheckForUpdate={() => run("check-update", actions.checkForUpdate)}
            onDownloadUpdate={() => run("download-update", actions.downloadUpdate)}
            onInstallUpdate={() => run("install-update", actions.installUpdate)}
            onOpenOnboarding={() => run("onboarding", actions.openOnboarding)}
            onThemeChange={(theme) => run("theme", () => actions.changeTheme?.(theme))}
            pending={pending}
            settings={settings}
          />
        )}
      </section>
    </div>
  );
}
