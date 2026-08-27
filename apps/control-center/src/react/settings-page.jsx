import { useState } from "react";
import { Button, Dialog, GlassPanel, Input, PageHeader, Status, Switch, Tabs } from "suzu-design-system";

import { sortSystemStatusSections } from "./system-status-order.mjs";
import { ApiConnectionsSettings } from "./api-connections-ui.jsx";
import { AgentModelSettings } from "./admin-page.jsx";
import { PageScaffold } from "./page-scaffold.jsx";
import "./settings-page.css";

const SETTINGS_TABS = [
  { label: "常规", value: "general" },
  { label: "壁纸", value: "wallpaper" },
  { label: "主模型", value: "main-model" },
  { label: "API", value: "api" },
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

function SoftwareUpdate({ onCheckForUpdate, onDownloadUpdate, onInstallUpdate, onOpenReleaseAnnouncement, pending, releaseAnnouncement, update }) {
  const status = cleanText(update?.status).toLowerCase();
  const attention = ["available", "downloaded"].includes(status);
  const version = cleanText(update?.version);
  const availableVersion = cleanText(update?.availableVersion);
  const copy = cleanText(update?.message) || (version ? `当前版本 v${version}，点击检查更新。` : "点击检查更新。");
  const presentation = {
    available: { action: onDownloadUpdate, button: "发现新版本", label: "可更新", tone: "success" },
    current: { action: onCheckForUpdate, button: "检查更新", label: "已是最新", tone: "success" },
    development: { action: null, button: "开发版不检查", label: "开发构建", tone: "muted" },
    downloaded: { action: onInstallUpdate, button: "重启并安装", label: "等待安装", tone: "success" },
    error: { action: onCheckForUpdate, button: "重新检查", label: "暂时不可用", tone: "warning" },
    manual: { action: null, button: "当前构建不支持", label: "手动更新", tone: "muted" },
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
          {releaseAnnouncement?.announcement ? <Button className="settings-action-button" disabled={Boolean(pending)} onClick={onOpenReleaseAnnouncement} size="md" variant="secondary">查看本次公告</Button> : null}
          <Button className={`settings-action-button${attention ? " settings-update-action--attention" : ""}`} disabled={Boolean(pending) || !presentation.action} onClick={presentation.action || undefined} size="md" variant="secondary">{attention ? <span aria-hidden="true" className="settings-update-attention-dot" /> : null}{busyLabel}</Button>
        </div>
      </div>
    </SettingCard>
  );
}

function wallpaperKindLabel(kind) {
  return {
    application: "应用壁纸",
    image: "图片壁纸",
    scene: "场景壁纸",
    video: "视频壁纸",
    web: "网页壁纸",
  }[cleanText(kind)] || "未识别格式";
}

function wallpaperStatus(item) {
  if (item?.status === "ready") return { label: "可使用", tone: "success" };
  if (item?.status === "invalid") return { label: "配置异常", tone: "danger" };
  if (item?.status === "missing") return { label: "文件缺失", tone: "warning" };
  return { label: "已识别", tone: "muted" };
}

function revealWallpaperVideoFirstFrame(event) {
  const video = event.currentTarget;
  video.pause();
  if (Number.isFinite(video.duration) && video.duration > 0) {
    video.currentTime = Math.min(0.001, video.duration);
  }
}

function WallpaperImportDialog({ onClose, onDiscardSource, onImport, onSelectSource }) {
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState("");
  const [source, setSource] = useState(null);

  const discard = (candidate = source) => {
    const selectionId = cleanText(candidate?.selectionId);
    if (selectionId) void onDiscardSource?.(selectionId);
  };
  const close = () => {
    if (pending) return;
    discard();
    onClose();
  };
  const choose = async (sourceType) => {
    if (pending) return;
    setPending(sourceType);
    setError("");
    try {
      const result = await onSelectSource?.(sourceType);
      if (result?.status !== "selected" || !result.source) return;
      discard();
      setSource(result.source);
      setName(cleanText(result.source.suggestedName));
    } catch (selectionError) {
      setError(cleanText(selectionError?.message) || "无法选择壁纸来源。");
    } finally {
      setPending("");
    }
  };
  const submit = async (event) => {
    event.preventDefault();
    if (!source?.selectionId || pending) return;
    setPending("import");
    setError("");
    try {
      await onImport?.({ name, selectionId: source.selectionId });
      setSource(null);
      onClose();
    } catch (importError) {
      setError(cleanText(importError?.message) || "无法导入壁纸。");
    } finally {
      setPending("");
    }
  };
  const footer = (
    <div className="settings-wallpaper-dialog__actions">
      <Button disabled={Boolean(pending)} onClick={close} variant="secondary">取消</Button>
      <Button disabled={Boolean(pending) || !source || !cleanText(name)} form="wallpaperImportForm" type="submit">{pending === "import" ? "正在复制…" : "添加壁纸"}</Button>
    </div>
  );

  return (
    <Dialog footer={footer} onClose={close} open surface="solid" title="添加壁纸">
      <form className="settings-wallpaper-dialog" id="wallpaperImportForm" onSubmit={submit}>
        <p>选择本机图片、视频，或者一个 Wallpaper Engine 壁纸文件夹。内容会复制到 Suzu Lives 的壁纸库。</p>
        <div className="settings-wallpaper-source-actions">
          <Button disabled={Boolean(pending)} onClick={() => choose("file")} variant="secondary">{pending === "file" ? "正在选择…" : "选择图片或视频"}</Button>
          <Button disabled={Boolean(pending)} onClick={() => choose("directory")} variant="secondary">{pending === "directory" ? "正在选择…" : "选择壁纸文件夹"}</Button>
        </div>
        {source ? (
          <div className="settings-wallpaper-source">
            <div><span>已选择</span><strong title={source.sourceLabel}>{source.sourceLabel}</strong></div>
            <Status label={wallpaperKindLabel(source.detectedKind)} tone={source.detectedStatus === "ready" ? "success" : "muted"} />
          </div>
        ) : <div className="settings-wallpaper-source is-empty">选择来源后即可命名并添加。</div>}
        <label className="settings-wallpaper-name-field">
          <span>壁纸名称</span>
          <Input autoFocus={Boolean(source)} disabled={!source || Boolean(pending)} maxLength="80" onChange={(event) => setName(event.target.value)} placeholder="例如：深海少女" required value={name} />
          <small>名称会直接作为壁纸库中的文件夹名称；同名壁纸需要使用不同名称。</small>
        </label>
        {error ? <p className="settings-wallpaper-dialog__error" role="alert">{error}</p> : null}
      </form>
    </Dialog>
  );
}

function WallpaperRemoveDialog({ item, onClose, onRemove }) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const remove = async () => {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await onRemove?.(item.folderName);
      onClose();
    } catch (removeError) {
      setError(cleanText(removeError?.message) || "无法删除壁纸。");
    } finally {
      setPending(false);
    }
  };
  const footer = <div className="settings-wallpaper-dialog__actions"><Button disabled={pending} onClick={onClose} variant="secondary">取消</Button><Button disabled={pending} onClick={remove} variant="danger">{pending ? "正在删除…" : "删除壁纸"}</Button></div>;
  return <Dialog footer={footer} onClose={pending ? () => {} : onClose} open surface="solid" title="删除壁纸"><div className="settings-wallpaper-remove-dialog"><p>删除“{item.name}”及其复制到壁纸库中的全部文件？</p><span>电脑中原来的图片、视频或 Wallpaper Engine 文件夹不会受到影响。</span>{error ? <p className="settings-wallpaper-dialog__error" role="alert">{error}</p> : null}</div></Dialog>;
}

function WallpaperEditDialog({ item, onClose, onUpdate }) {
  const [error, setError] = useState("");
  const [name, setName] = useState(cleanText(item?.name || item?.folderName));
  const [pending, setPending] = useState(false);
  const [pinned, setPinned] = useState(item?.pinned === true);
  const changed = cleanText(name) !== cleanText(item?.folderName) || pinned !== (item?.pinned === true);
  const close = () => {
    if (!pending) onClose();
  };
  const submit = async (event) => {
    event.preventDefault();
    if (pending || !changed || !cleanText(name)) return;
    setPending(true);
    setError("");
    try {
      await onUpdate?.({ folderName: item.folderName, name, pinned });
      onClose();
    } catch (updateError) {
      setError(cleanText(updateError?.message) || "无法更新壁纸。");
    } finally {
      setPending(false);
    }
  };
  const footer = (
    <div className="settings-wallpaper-dialog__actions">
      <Button disabled={pending} onClick={close} variant="secondary">取消</Button>
      <Button disabled={pending || !changed || !cleanText(name)} form="wallpaperEditForm" type="submit">{pending ? "正在保存…" : "保存修改"}</Button>
    </div>
  );
  return (
    <Dialog footer={footer} onClose={close} open surface="solid" title="编辑壁纸">
      <form className="settings-wallpaper-dialog" id="wallpaperEditForm" onSubmit={submit}>
        <label className="settings-wallpaper-name-field">
          <span>壁纸名称</span>
          <Input autoFocus disabled={pending} maxLength="80" onChange={(event) => setName(event.target.value)} required value={name} />
          <small>保存后会同步修改壁纸库中的文件夹名称。</small>
        </label>
        <div className="settings-wallpaper-pin-field">
          <div><strong>置顶</strong><span>置顶的壁纸会排在壁纸库最前面。</span></div>
          <Switch aria-label="置顶壁纸" checked={pinned} disabled={pending} onChange={(event) => setPinned(event.target.checked)} />
        </div>
        {error ? <p className="settings-wallpaper-dialog__error" role="alert">{error}</p> : null}
      </form>
    </Dialog>
  );
}

function WallpaperLibrary({ appearance, onAdd, onClear, onEdit, onOpenDirectory, onRemove, onSelect, pending }) {
  const items = Array.isArray(appearance?.wallpapers) ? appearance.wallpapers : [];
  const selectedFolder = cleanText(appearance?.wallpaper?.folderName);
  const activeFolder = appearance?.styleId === "wallpaper-glass" ? selectedFolder : "";
  return (
    <div className="settings-wallpaper-library">
      <div className="settings-wallpaper-library__head">
        <div className="settings-card__copy">
          <div className="settings-card__meta"><strong>自定义壁纸</strong><Status label={items.length ? `${items.length} 张` : "空"} tone={items.length ? "success" : "muted"} /></div>
          <span>图片、视频和 Wallpaper Engine 项目统一保存在按名称整理的壁纸文件夹中。</span>
        </div>
        <div className="settings-card__actions">
          {activeFolder ? <Button className="settings-action-button" disabled={Boolean(pending)} onClick={onClear} size="md" variant="secondary">停用壁纸</Button> : null}
          <Button className="settings-action-button" disabled={Boolean(pending)} onClick={onOpenDirectory} size="md" variant="secondary">打开壁纸目录</Button>
          <Button disabled={Boolean(pending)} onClick={onAdd} size="md">添加壁纸</Button>
        </div>
      </div>
      {items.length ? (
        <div className="settings-wallpaper-list">
          {items.map((item) => {
            const status = wallpaperStatus(item);
            const active = Boolean(activeFolder) && activeFolder.toLocaleLowerCase() === cleanText(item.folderName).toLocaleLowerCase();
            return (
              <article className={`settings-wallpaper-item ${active ? "is-active" : ""}`} key={item.folderName}>
                <div className="settings-wallpaper-item__preview">
                  {item.kind === "video" && item.url ? (
                    <video aria-hidden="true" muted onLoadedMetadata={revealWallpaperVideoFirstFrame} playsInline preload="metadata" src={item.url} />
                  ) : item.previewUrl ? <img alt="" draggable="false" src={item.previewUrl} /> : <span>{wallpaperKindLabel(item.kind).slice(0, 1)}</span>}
                </div>
                <div className="settings-wallpaper-item__copy">
                  <div><strong>{item.name}</strong>{item.pinned ? <Status label="置顶" tone="info" /> : null}<Status label={active ? "使用中" : status.label} tone={active ? "success" : status.tone} /></div>
                  <span>{wallpaperKindLabel(item.kind)}</span>
                </div>
                <div className="settings-wallpaper-item__actions">
                  <Button disabled={Boolean(pending) || active || item.status !== "ready"} onClick={() => onSelect(item.folderName)} size="sm" variant="secondary">{active ? "使用中" : item.status === "ready" ? "应用" : "暂不可用"}</Button>
                  <Button disabled={Boolean(pending)} onClick={() => onEdit(item)} size="sm" variant="ghost">编辑</Button>
                  <Button disabled={Boolean(pending)} onClick={() => onRemove(item)} size="sm" variant="ghost">删除</Button>
                </div>
              </article>
            );
          })}
        </div>
      ) : <p className="settings-wallpaper-empty">壁纸库中还没有内容，添加一张图片、视频或 Wallpaper Engine 壁纸文件夹即可开始使用。</p>}
    </div>
  );
}

function GeneralSettings({ appUpdate, onCheckForUpdate, onDownloadUpdate, onInstallUpdate, onOpenOnboarding, onOpenReleaseAnnouncement, onThemeChange, pending, releaseAnnouncement, settings }) {
  const theme = settings.theme === "dark" ? "dark" : "light";
  return (
    <div className="settings-card-stack">
      <SoftwareUpdate
        onCheckForUpdate={onCheckForUpdate}
        onDownloadUpdate={onDownloadUpdate}
        onInstallUpdate={onInstallUpdate}
        onOpenReleaseAnnouncement={onOpenReleaseAnnouncement}
        pending={pending}
        releaseAnnouncement={releaseAnnouncement}
        update={appUpdate}
      />

      <SettingCard>
        <div className="settings-card__layout">
          <div className="settings-card__copy">
            <span className="settings-card__eyebrow">GETTING STARTED</span>
            <h2>首次引导</h2>
            <p>如果此前选择了“稍后设置”，可以从这里继续完成主模型、联系人和人设配置。</p>
          </div>
          <div className="settings-card__actions">
            <Button className="settings-action-button" disabled={Boolean(pending) || !onOpenOnboarding} onClick={onOpenOnboarding} size="md" variant="secondary">打开首次引导</Button>
          </div>
        </div>
      </SettingCard>

      <SettingCard>
        <div className="settings-card__copy settings-appearance-heading">
          <span className="settings-card__eyebrow">APPEARANCE</span>
          <h2>外观</h2>
          <p>设置文字、控件和卡片使用的明暗配色。</p>
        </div>
        <div className="settings-appearance-options">
          <div className="settings-appearance-option">
            <div className="settings-card__copy">
              <strong>界面色调</strong>
              <span>设置文字、控件和卡片的明暗配色。</span>
            </div>
            <div className="settings-card__actions settings-theme-actions" role="group" aria-label="界面色调">
              <Button aria-pressed={theme === "light"} className={`settings-action-button settings-theme-choice ${theme === "light" ? "is-active" : ""}`} disabled={Boolean(pending)} onClick={() => onThemeChange("light")} size="md" variant="secondary">浅色</Button>
              <Button aria-pressed={theme === "dark"} className={`settings-action-button settings-theme-choice ${theme === "dark" ? "is-active" : ""}`} disabled={Boolean(pending)} onClick={() => onThemeChange("dark")} size="md" variant="secondary">深色</Button>
            </div>
          </div>
        </div>
      </SettingCard>
    </div>
  );
}

function WallpaperSettings({ onAppearanceStyleChange, onClearWallpaper, onDiscardWallpaperSource, onImportWallpaper, onOpenWallpaperDirectory, onRemoveWallpaper, onSelectWallpaper, onSelectWallpaperSource, onUpdateWallpaper, pending, settings }) {
  const appearance = settings.appearance || {};
  const styleId = appearance.styleId === "wallpaper-glass" ? "wallpaper-glass" : "classic";
  const [importOpen, setImportOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [removeTarget, setRemoveTarget] = useState(null);
  return (
    <div className="settings-card-stack settings-wallpaper-page">
      <SettingCard>
        <div className="settings-card__copy settings-appearance-heading">
          <span className="settings-card__eyebrow">WALLPAPER</span>
          <h2>壁纸显示</h2>
          <p>选择壁纸玻璃后，导航、页面和卡片会显示为分层玻璃表面。</p>
        </div>
        <div className="settings-appearance-options">
          <div className="settings-appearance-option">
            <div className="settings-card__copy">
              <strong>界面样式</strong>
              <span>经典样式会关闭壁纸背景，已经添加的壁纸仍保留在壁纸库中。</span>
            </div>
            <div className="settings-card__actions settings-theme-actions" role="group" aria-label="壁纸显示样式">
              <Button aria-pressed={styleId === "classic"} className={`settings-action-button settings-theme-choice ${styleId === "classic" ? "is-active" : ""}`} disabled={Boolean(pending)} onClick={() => onAppearanceStyleChange("classic")} size="md" variant="secondary">经典</Button>
              <Button aria-pressed={styleId === "wallpaper-glass"} className={`settings-action-button settings-theme-choice ${styleId === "wallpaper-glass" ? "is-active" : ""}`} disabled={Boolean(pending)} onClick={() => onAppearanceStyleChange("wallpaper-glass")} size="md" variant="secondary">壁纸玻璃</Button>
            </div>
          </div>
        </div>
      </SettingCard>
      <SettingCard className="settings-wallpaper-library-card">
        <WallpaperLibrary
          appearance={appearance}
          onAdd={() => setImportOpen(true)}
          onClear={onClearWallpaper}
          onEdit={setEditTarget}
          onOpenDirectory={onOpenWallpaperDirectory}
          onRemove={setRemoveTarget}
          onSelect={onSelectWallpaper}
          pending={pending}
        />
      </SettingCard>
      {importOpen ? <WallpaperImportDialog onClose={() => setImportOpen(false)} onDiscardSource={onDiscardWallpaperSource} onImport={onImportWallpaper} onSelectSource={onSelectWallpaperSource} /> : null}
      {editTarget ? <WallpaperEditDialog item={editTarget} onClose={() => setEditTarget(null)} onUpdate={onUpdateWallpaper} /> : null}
      {removeTarget ? <WallpaperRemoveDialog item={removeTarget} onClose={() => setRemoveTarget(null)} onRemove={onRemoveWallpaper} /> : null}
    </div>
  );
}

function systemStatusPresentation(snapshot) {
  if (cleanText(snapshot?.error)) return { label: "检查失败", tone: "danger", detail: cleanText(snapshot.error) };
  const summary = snapshot?.summary || null;
  if (!summary) return { label: "尚未检查", tone: "muted", detail: "检查会读取 Suzu 数据、联系人工作区和本机 Agent Core；不会修改或执行任何文件。" };
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
  const sections = sortSystemStatusSections(snapshot?.sections);
  const hasResults = sections.length > 0;
  const [resultsOpen, setResultsOpen] = useState(true);
  const check = async () => {
    await onCheck?.();
    setResultsOpen(true);
  };
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
          {hasResults ? <Button aria-controls="settings-system-status-results" aria-expanded={resultsOpen} className="settings-action-button" disabled={pending} onClick={() => setResultsOpen((open) => !open)} size="md" variant="secondary">{resultsOpen ? "收起检查结果" : "查看检查结果"}</Button> : null}
          <Button className="settings-action-button" disabled={pending} onClick={check} size="md" variant="secondary">{pending ? "正在检查…" : "检查系统状态"}</Button>
        </div>
      </div>
      {hasResults ? <div className="settings-system-status-results" hidden={!resultsOpen} id="settings-system-status-results">{sections.map((section) => {
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

function DataSettings({ onChangeDataLocation, onCheckSystemStatus, onOpenDirectory, onRemovePreviousCopy, pending, settings, systemStatus }) {
  const storage = settings.dataStorage || {};
  const currentDataPath = cleanText(storage.dataRoot || settings.dataRoot);
  const previousDataPath = cleanText(storage.previousDataRoot);
  const failedMigration = storage.failedMigration;
  const storageValue = dataPath(currentDataPath, "等待初始化");
  const hasDataStorage = Boolean(currentDataPath && currentDataPath !== "等待初始化");

  return (
    <div className="settings-card-stack">
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
          <p>隐藏后，各功能页面会收起这位联系人及相关内容；这里保留恢复入口，已有消息、主动关心、记忆和其他资料继续保留。</p>
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
                  <div><strong>{name}</strong><span>已从功能页面隐藏</span></div>
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
  const updateAttention = ["available", "downloaded"].includes(cleanText(snapshot.appUpdate?.status).toLowerCase());
  const tabs = SETTINGS_TABS.map((item) => item.value === "general" && updateAttention
    ? { ...item, label: <span className="settings-tab-label">{item.label}<span aria-hidden="true" className="settings-update-attention-dot" /></span> }
    : item);
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
    <PageScaffold
      canvasClassName="page-canvas--stack"
      className="settings-react-page"
      header={<PageHeader eyebrow="SETTINGS" subtitle="调整软件外观、壁纸、API 连接、数据存储与联系人隐私。" title="设置" />}
    >
      <Tabs active={tab} className="settings-page-tabs" items={tabs} onChange={actions.setTab} size="md" />
      <section className="settings-page-body" aria-label={tab === "wallpaper" ? "壁纸设置" : tab === "api" ? "API 设置" : tab === "main-model" ? "主模型设置" : tab === "data" ? "数据设置" : tab === "privacy" ? "隐私设置" : "常规设置"}>
        {tab === "wallpaper" ? (
          <WallpaperSettings
            onAppearanceStyleChange={(styleId) => run("appearance-style", () => actions.changeAppearanceStyle?.(styleId))}
            onClearWallpaper={() => run("wallpaper-clear", actions.clearWallpaper)}
            onDiscardWallpaperSource={actions.discardWallpaperSource}
            onImportWallpaper={actions.importWallpaper}
            onOpenWallpaperDirectory={() => run("wallpaper-directory", () => actions.openDirectory?.(settings.appearance?.wallpaperDirectory))}
            onRemoveWallpaper={(folderName) => run("wallpaper-remove", () => actions.removeWallpaper?.(folderName))}
            onSelectWallpaper={(folderName) => run("wallpaper-select", () => actions.selectWallpaper?.(folderName))}
            onSelectWallpaperSource={actions.selectWallpaperSource}
            onUpdateWallpaper={(value) => run("wallpaper-update", () => actions.updateWallpaper?.(value))}
            pending={pending}
            settings={settings}
          />
        ) : tab === "data" ? (
          <DataSettings
            onChangeDataLocation={() => run("data-location", actions.changeDataLocation)}
            onCheckSystemStatus={() => run("system-status", actions.checkSystemStatus)}
            onOpenDirectory={(path) => run("open-directory", () => actions.openDirectory?.(path))}
            onRemovePreviousCopy={() => run("old-copy", actions.removePreviousCopy)}
            pending={pending}
            settings={settings}
            systemStatus={snapshot.systemStatus}
          />
        ) : tab === "main-model" ? (
          <AgentModelSettings
            actions={{
              fetchModels: actions.fetchModels,
              saveModelConfiguration: actions.saveModelConfiguration,
            }}
            config={snapshot.agentRuntime || {}}
            initialModels={snapshot.agentModels}
            initialNotice={snapshot.agentModelNotice}
          />
        ) : tab === "api" ? (
          <ApiConnectionsSettings
            actions={{
              removeApiConnection: actions.removeApiConnection,
              saveApiConnection: actions.saveApiConnection,
            }}
            snapshot={snapshot.apiServices}
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
            onOpenOnboarding={actions.openOnboarding}
            onOpenReleaseAnnouncement={() => run("release-announcement", actions.openReleaseAnnouncement)}
            onThemeChange={(theme) => run("theme", () => actions.changeTheme?.(theme))}
            pending={pending}
            releaseAnnouncement={snapshot.releaseAnnouncement}
            settings={settings}
          />
        )}
      </section>
    </PageScaffold>
  );
}
