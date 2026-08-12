import { useState } from "react";
import { Button, GlassPanel, PageHeader, Status, Tabs } from "suzu-design-system";

import "./settings-page.css";

const SETTINGS_TABS = [
  { label: "常规", value: "general" },
  { label: "数据", value: "data" },
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

function GeneralSettings({ onOpenOnboarding, onThemeChange, pending, settings }) {
  const completed = settings.onboardingCompleted === true;
  const theme = settings.theme === "light" ? "light" : "dark";
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

function DataSettings({ onChangeDataLocation, onOpenDirectory, onRemovePreviousCopy, onSelectWorkspace, pending, settings }) {
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

export function SettingsPage({ actions = {}, snapshot = {} }) {
  const settings = snapshot.settings || {};
  const tab = snapshot.tab === "data" ? "data" : "general";
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
      <PageHeader eyebrow="SETTINGS" subtitle="调整软件外观与数据存储。" title="设置" />
      <Tabs active={tab} className="settings-page-tabs" items={SETTINGS_TABS} onChange={actions.setTab} size="md" />
      <section className="settings-page-body" aria-label={tab === "data" ? "数据设置" : "常规设置"}>
        {tab === "data" ? (
          <DataSettings
            onChangeDataLocation={() => run("data-location", actions.changeDataLocation)}
            onOpenDirectory={(path) => run("open-directory", () => actions.openDirectory?.(path))}
            onRemovePreviousCopy={() => run("old-copy", actions.removePreviousCopy)}
            onSelectWorkspace={() => run("workspace", actions.selectWorkspace)}
            pending={pending}
            settings={settings}
          />
        ) : (
          <GeneralSettings
            onOpenOnboarding={() => run("onboarding", actions.openOnboarding)}
            onThemeChange={(theme) => run("theme", () => actions.changeTheme?.(theme))}
            pending={Boolean(pending)}
            settings={settings}
          />
        )}
      </section>
    </div>
  );
}
