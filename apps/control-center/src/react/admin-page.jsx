import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Avatar, Banner, Button, Dialog, Empty, GlassPanel, Input, PageHeader, Select, Status, Switch, Tabs, Textarea } from "suzu-design-system";

import {
  AVATAR_CROP_MAX_ZOOM,
  AVATAR_CROP_MIN_ZOOM,
  AVATAR_CROP_OUTPUT_SIZE,
  avatarCropLayout,
  avatarCropSourceRect,
  createSquareAvatarCrop,
  moveAvatarCrop,
  readAvatarFile,
  resizeAvatarCropViewport,
  setAvatarCropZoom,
} from "../core/avatar-file.mjs";
import { compactNumber, dateTime, localDateTimeInput, money, startOfTodayInput } from "../core/formatters.mjs";
import { getIdentity, profileInitial } from "../core/identity.mjs";
import { API_BINDINGS, CLAUDE_CODE_API_PROVIDERS } from "../features/agent/runtime.mjs";

import "./admin-page.css";

const ADMIN_TABS = [
  { label: "我", value: "agent" },
  { label: "Claude Code", value: "claude-code" },
  { label: "连接与运行", value: "runtime" },
  { label: "API", value: "api-services" },
  { label: "用量与成本", value: "usage" },
];

const OWNER_GENDER_OPTIONS = [
  { label: "未设置", value: "" },
  { label: "女性", value: "female" },
  { label: "男性", value: "male" },
];

const CLAUDE_CORE_RUNTIME_FEATURES = [
  { key: "glob", label: "查找文件", description: "按路径模式查找可用工作目录中的文件。" },
  { key: "grep", label: "搜索文件内容", description: "在可用工作目录中搜索文本。" },
  { key: "edit", label: "修改文件", description: "精准修改已有文件。" },
  { key: "write", label: "新建或覆盖文件", description: "创建和写入文件。" },
  { key: "bash", label: "执行终端命令", description: "具体命令仍受项目权限规则约束。" },
];

const CLAUDE_RUNTIME_FEATURES = [
  { key: "subagents", label: "允许子 Agent" },
  { key: "taskList", label: "允许任务清单" },
  { key: "backgroundTasks", label: "允许后台任务" },
  { key: "nativeCron", label: "允许 Claude 原生 Cron" },
  { key: "askUserQuestion", label: "允许选择题追问" },
];

const CLAUDE_BASE_CAPABILITIES = [
  { key: "read", label: "读取文件", description: "读取可用工作目录中的文件。" },
  ...CLAUDE_CORE_RUNTIME_FEATURES,
  { key: "webFetch", label: "网页抓取", description: "读取指定网页内容。" },
  { key: "webSearch", label: "网页搜索", description: "搜索公开网页信息。" },
];

const DEFAULT_API_CONNECTION = Object.freeze({
  baseUrl: "",
  editEndpoint: "/images/edits",
  editExtraBody: {},
  extraBody: {},
  generationEndpoint: "/images/generations",
  id: "",
  inputFidelity: "",
  model: "",
  name: "阿里百炼",
  outputFormat: "",
  quality: "",
  timeoutMs: 180000,
  type: "dashscope",
});

function clean(value) {
  return String(value ?? "").trim();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function validClaudeProvider(value) {
  return Object.hasOwn(CLAUDE_CODE_API_PROVIDERS, value) ? value : "deepseek";
}

function claudeProvider(value) {
  return CLAUDE_CODE_API_PROVIDERS[validClaudeProvider(value)] || CLAUDE_CODE_API_PROVIDERS.deepseek;
}

function Field({ children, className = "", hint = "", label }) {
  return (
    <label className={["admin-field", className].filter(Boolean).join(" ")}>
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function AdminPanel({ children, className = "" }) {
  return <GlassPanel as="section" className={["admin-panel", className].filter(Boolean).join(" ")} intensity="soft">{children}</GlassPanel>;
}

function PanelHeading({ actions = null, description, eyebrow, status = null, title }) {
  return (
    <header className="admin-panel-heading">
      <div>
        {eyebrow ? <span className="admin-kicker">{eyebrow}</span> : null}
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {status || actions ? <div className="admin-panel-heading__actions">{status}{actions}</div> : null}
    </header>
  );
}

function InlineError({ children }) {
  return children ? <p className="admin-inline-error" role="alert">{children}</p> : null;
}

function sourceImageSize(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => {
      const imageWidth = Number(image.naturalWidth || image.width);
      const imageHeight = Number(image.naturalHeight || image.height);
      if (!Number.isFinite(imageWidth) || imageWidth <= 0 || !Number.isFinite(imageHeight) || imageHeight <= 0) {
        reject(new Error("无法读取这张图片的尺寸。"));
        return;
      }
      resolve({ imageHeight, imageWidth });
    }, { once: true });
    image.addEventListener("error", () => reject(new Error("无法打开这张图片。")), { once: true });
    image.src = source;
  });
}

function croppedAvatarDataUrl(crop, image) {
  if (!crop || !image?.naturalWidth || !image?.naturalHeight) throw new Error("头像图片尚未准备好，请稍后重试。");
  const source = avatarCropSourceRect(crop);
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_CROP_OUTPUT_SIZE;
  canvas.height = AVATAR_CROP_OUTPUT_SIZE;
  const drawing = canvas.getContext("2d");
  if (!drawing) throw new Error("当前环境无法裁剪头像。");
  drawing.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/webp", .92);
}

function AvatarCropDialog({ crop, onClose, onSave }) {
  const [draft, setDraft] = useState(crop);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const dragRef = useRef(null);
  const imageRef = useRef(null);
  const stageRef = useRef(null);

  useEffect(() => {
    setDraft(crop);
    setError("");
  }, [crop]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || !crop) return undefined;
    const fit = () => {
      const bounds = stage.getBoundingClientRect();
      const width = Math.round(Number(bounds.width) || 0);
      const height = Math.round(Number(bounds.height) || 0);
      if (width < 1 || height < 1) return;
      setDraft((current) => {
        if (!current || (current.viewportWidth === width && current.viewportHeight === height)) return current;
        return resizeAvatarCropViewport(current, width, height);
      });
    };
    fit();
    const Observer = globalThis.ResizeObserver;
    const observer = typeof Observer === "function" ? new Observer(fit) : null;
    observer?.observe(stage);
    window.addEventListener("resize", fit);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [crop?.source]);

  if (!crop || !draft) return null;
  const layout = avatarCropLayout(draft);

  const beginDrag = (event) => {
    if (event.button !== 0 || pending) return;
    event.preventDefault();
    dragRef.current = { clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is an enhancement; dragging still works without it.
    }
  };

  const moveDrag = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || pending) return;
    setDraft((current) => moveAvatarCrop(current, event.clientX - drag.clientX, event.clientY - drag.clientY));
    dragRef.current = { clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId };
  };

  const finishDrag = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already have been released by the platform.
    }
    dragRef.current = null;
  };

  const save = async () => {
    setPending(true);
    setError("");
    try {
      await onSave?.(croppedAvatarDataUrl(draft, imageRef.current));
    } catch (saveError) {
      setError(clean(saveError?.message) || "无法保存该头像。");
      setPending(false);
    }
  };

  const footer = (
    <div className="admin-dialog-actions">
      <Button disabled={pending} onClick={onClose} type="button" variant="secondary">取消</Button>
      <Button disabled={pending} onClick={save} type="button">{pending ? "正在保存…" : "确认使用"}</Button>
    </div>
  );

  return (
    <Dialog footer={footer} onClose={pending ? () => {} : onClose} open title="裁剪头像">
      <div className="admin-avatar-crop-dialog">
        <p className="admin-dialog-copy">拖动图片调整位置；方框内的正方形区域会作为头像保存。</p>
        <div
          className="admin-avatar-crop-stage"
          onPointerCancel={finishDrag}
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={finishDrag}
          ref={stageRef}
        >
          <img
            alt="正在裁剪的我的头像"
            draggable="false"
            ref={imageRef}
            src={draft.source}
            style={{ height: layout.displayHeight, transform: "translate(" + layout.offsetX + "px, " + layout.offsetY + "px)", width: layout.displayWidth }}
          />
          <span aria-hidden="true" />
        </div>
        <label className="admin-avatar-crop-zoom">
          <span>缩放</span>
          <input
            disabled={pending}
            max={AVATAR_CROP_MAX_ZOOM}
            min={AVATAR_CROP_MIN_ZOOM}
            onChange={(event) => setDraft((current) => setAvatarCropZoom(current, event.target.value))}
            step="0.01"
            type="range"
            value={layout.zoom}
          />
          <output>{Math.round(layout.zoom * 100)}%</output>
        </label>
        <InlineError>{error}</InlineError>
      </div>
    </Dialog>
  );
}

function IdentitySettings({ actions, settings }) {
  const identity = getIdentity(settings);
  const owner = identity?.owner || { avatarDataUrl: "", displayName: "我", gender: "", signature: "" };
  const [name, setName] = useState(owner.displayName || "我");
  const [gender, setGender] = useState(owner.gender || "");
  const [signature, setSignature] = useState(owner.signature || "");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [crop, setCrop] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    setName(owner.displayName || "我");
    setGender(owner.gender || "");
    setSignature(owner.signature || "");
  }, [owner.displayName, owner.gender, owner.signature]);

  const saveProfile = async () => {
    if (!actions?.saveIdentity || pending) return;
    setPending(true);
    setError("");
    try {
      await actions.saveIdentity({ displayName: name, gender, signature });
    } catch (saveError) {
      setError(clean(saveError?.message) || "无法保存资料。");
      setPending(false);
    }
  };

  const selectAvatar = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    try {
      const source = await readAvatarFile(file);
      const dimensions = await sourceImageSize(source);
      setCrop(createSquareAvatarCrop({ source, ...dimensions }));
    } catch (fileError) {
      setError(clean(fileError?.message) || "无法读取这张头像。");
    }
  };

  const saveAvatar = async (avatarDataUrl) => {
    if (!actions?.saveIdentity) return;
    await actions.saveIdentity({ avatarDataUrl });
  };

  const removeAvatar = async () => {
    if (!actions?.saveIdentity || pending) return;
    setPending(true);
    setError("");
    try {
      await actions.saveIdentity({ avatarDataUrl: "" });
    } catch (removeError) {
      setError(clean(removeError?.message) || "无法移除头像。");
      setPending(false);
    }
  };

  return (
    <>
      <AdminPanel className="admin-identity-panel">
        <PanelHeading description="聊天中显示的我的身份。" eyebrow="IDENTITY" title="我" />
        <div className="admin-identity-card">
          <Avatar className="admin-identity-card__avatar" fallback={profileInitial(owner, "我")} name={owner.displayName || "我"} size="xl" src={owner.avatarDataUrl || undefined} />
          <div className="admin-identity-card__body">
            <div className="admin-identity-card__fields">
              <Field label="显示名">
                <Input disabled={pending} maxLength="60" onChange={(event) => setName(event.target.value)} value={name} />
              </Field>
              <Field label="性别">
                <Select disabled={pending} fullWidth onChange={setGender} options={OWNER_GENDER_OPTIONS} value={gender} />
              </Field>
              <Field className="admin-identity-card__signature" label="个性签名">
                <Input disabled={pending} maxLength="120" onChange={(event) => setSignature(event.target.value)} placeholder="写一句介绍自己的话" value={signature} />
              </Field>
            </div>
            <div className="admin-identity-card__actions">
              <Button disabled={pending} onClick={() => fileRef.current?.click()} size="md" type="button" variant="secondary">选择头像</Button>
              <Button disabled={pending} onClick={saveProfile} size="md" type="button" variant="secondary">保存资料</Button>
              {owner.avatarDataUrl ? <Button disabled={pending} onClick={removeAvatar} size="md" type="button" variant="ghost">移除头像</Button> : null}
            </div>
            <input accept="image/png,image/jpeg,image/webp" hidden onChange={selectAvatar} ref={fileRef} type="file" />
            <InlineError>{error}</InlineError>
          </div>
        </div>
      </AdminPanel>
      <AvatarCropDialog crop={crop} onClose={() => setCrop(null)} onSave={saveAvatar} />
    </>
  );
}

function claudeApiDraft(config = {}) {
  const providerId = validClaudeProvider(config.providerId);
  const provider = claudeProvider(providerId);
  const defaults = provider.models || {};
  return {
    apiKey: "",
    authMode: clean(config.authMode) || "auth-token",
    baseUrl: clean(config.baseUrl) || provider.baseUrl || "",
    effortLevel: clean(config.effortLevel) || defaults.effort || "",
    haikuModel: clean(config.haikuModel) || defaults.haiku || defaults.model || "",
    model: clean(config.model) || defaults.model || "",
    modelListUrl: "",
    opusModel: clean(config.opusModel) || defaults.opus || defaults.model || "",
    provider: providerId,
    skipOnboarding: config.skipOnboarding !== false,
    sonnetModel: clean(config.sonnetModel) || defaults.sonnet || defaults.model || "",
    subagentModel: clean(config.subagentModel) || defaults.subagent || defaults.haiku || defaults.model || "",
  };
}

function ClaudeModelCombobox({ disabled, models, onChange, value }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const candidates = list(models);

  useEffect(() => {
    if (!open) return undefined;
    const closeWhenOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeWhenOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const selectModel = (model) => {
    onChange(model);
    setOpen(false);
  };

  return (
    <div className="admin-model-combobox" ref={rootRef}>
      <Input
        aria-autocomplete={candidates.length ? "list" : undefined}
        aria-controls={candidates.length ? "adminClaudeCodeApiModelOptions" : undefined}
        aria-expanded={candidates.length ? open : undefined}
        disabled={disabled}
        maxLength="200"
        onChange={(event) => {
          onChange(event.target.value);
          if (candidates.length) setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && candidates.length) {
            event.preventDefault();
            setOpen(true);
          }
          if (event.key === "Escape") setOpen(false);
        }}
        placeholder="例如：deepseek-v4-pro[1m]"
        role={candidates.length ? "combobox" : undefined}
        value={value}
      />
      {candidates.length ? (
        <button
          aria-controls="adminClaudeCodeApiModelOptions"
          aria-expanded={open}
          aria-label="选择已获取的模型"
          className={["admin-model-combobox__toggle", open ? "is-open" : ""].filter(Boolean).join(" ")}
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4" /></svg>
        </button>
      ) : null}
      {open && candidates.length ? (
        <div className="admin-model-combobox__list" id="adminClaudeCodeApiModelOptions" role="listbox">
          {candidates.map((model) => (
            <button
              aria-selected={model === value}
              className={model === value ? "is-selected" : ""}
              key={model}
              onClick={() => selectModel(model)}
              role="option"
              type="button"
            >
              {model}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ClaudeCodeApiSettings({ actions, config, initialModels = [], initialNotice = "" }) {
  const [draft, setDraft] = useState(() => claudeApiDraft(config));
  const [models, setModels] = useState(() => list(initialModels));
  const [message, setMessage] = useState(initialNotice);
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const provider = claudeProvider(draft.provider);
  const custom = draft.provider === "custom";

  useEffect(() => {
    setDraft(claudeApiDraft(config));
    setModels(list(initialModels));
    setMessage(initialNotice);
    setError("");
  }, [config, initialModels, initialNotice]);

  const change = (key, value) => setDraft((current) => ({ ...current, [key]: value }));

  const chooseProvider = (providerId) => {
    const nextId = validClaudeProvider(providerId);
    const nextProvider = claudeProvider(nextId);
    const defaults = nextProvider.models || {};
    setDraft((current) => ({
      ...current,
      baseUrl: nextProvider.baseUrl || "",
      effortLevel: defaults.effort || "",
      haikuModel: defaults.haiku || defaults.model || "",
      model: defaults.model || "",
      opusModel: defaults.opus || defaults.model || "",
      provider: nextId,
      sonnetModel: defaults.sonnet || defaults.model || "",
      subagentModel: defaults.subagent || defaults.haiku || defaults.model || "",
    }));
    setModels([]);
    setMessage("");
    setError("");
  };

  const fetchModels = async () => {
    if (!actions?.fetchClaudeCodeModels || pending) return;
    setPending("models");
    setError("");
    try {
      const result = await actions.fetchClaudeCodeModels(draft);
      setModels(list(result?.models));
      setMessage(clean(result?.message) || "模型列表已更新。");
    } catch (fetchError) {
      setMessage("");
      setError(clean(fetchError?.message) || "无法获取模型列表。");
    } finally {
      setPending("");
    }
  };

  const save = async (event) => {
    event.preventDefault();
    if (!actions?.saveClaudeCodeApi || pending) return;
    setPending("save");
    setError("");
    try {
      await actions.saveClaudeCodeApi(draft);
    } catch (saveError) {
      setError(clean(saveError?.message) || "无法保存 Claude Code API。");
      setPending("");
    }
  };

  const stateReady = config?.status === "ready";
  const status = <Status label={stateReady ? "已配置" : "等待填写"} tone={stateReady ? "success" : "muted"} />;

  return (
    <AdminPanel className="admin-claude-api-panel">
      <PanelHeading
        description="配置本机 Claude Code 的文字模型服务；长期记忆自动入库和整理会复用这里当前的主模型。"
        eyebrow="CLAUDE CODE"
        status={status}
        title="Claude Code API"
      />
      <form className="admin-form" onSubmit={save}>
        <section className="admin-form-section">
          <div className="admin-form-section__heading">
            <h3>使用哪个服务</h3>
            <p>选择后会自动填入官方兼容地址；只有“自定义”需要自己输入地址。</p>
          </div>
          <div className="admin-form-grid">
            <Field label="服务">
              <Select
                disabled={Boolean(pending)}
                fullWidth
                onChange={chooseProvider}
                options={Object.entries(CLAUDE_CODE_API_PROVIDERS).map(([value, item]) => ({ label: item.label, value }))}
                value={draft.provider}
              />
            </Field>
            <Field className="admin-field--wide" hint={custom ? "填写服务商给出的 Anthropic 兼容地址。" : "内置地址；切换到自定义后才可以修改。"} label="服务地址">
              <Input disabled={Boolean(pending)} maxLength="500" onChange={(event) => change("baseUrl", event.target.value)} readOnly={!custom} value={draft.baseUrl} />
            </Field>
            <Field label="API Key">
              <Input autoComplete="new-password" disabled={Boolean(pending)} maxLength="1000" onChange={(event) => change("apiKey", event.target.value)} placeholder={config?.hasApiKey ? "已保存；重新填写才会替换" : "保存服务时填写"} type="password" value={draft.apiKey} />
            </Field>
            <label className="admin-switch-field">
              <span><strong>跳过 Claude Code 首次登录确认</strong><small>保存后会写入本机用户配置。</small></span>
              <Switch checked={draft.skipOnboarding} disabled={Boolean(pending)} onChange={(event) => change("skipOnboarding", event.target.checked)} />
            </label>
          </div>
        </section>

        <section className="admin-form-section">
          <div className="admin-form-section__heading">
            <h3>使用的模型</h3>
            <p>可以直接输入模型名，或点击获取后从当前服务返回的列表中选择。</p>
          </div>
          <div className="admin-form-grid">
            <Field className="admin-field--wide" label="主模型">
              <ClaudeModelCombobox disabled={Boolean(pending)} models={models} onChange={(model) => change("model", model)} value={draft.model} />
            </Field>
          </div>
          <div className="admin-form-inline-actions">
            <Button disabled={Boolean(pending)} onClick={fetchModels} size="md" type="button" variant="secondary">{pending === "models" ? "正在获取…" : "获取模型列表"}</Button>
            {message ? <p>{message}</p> : null}
          </div>
        </section>

        <details className="admin-advanced">
          <summary><span>更多模型与兼容设置</span><small>只有服务商要求不同模型映射时再调整</small></summary>
          <div className="admin-form-grid">
            <Field label="Sonnet 映射"><Input disabled={Boolean(pending)} maxLength="200" onChange={(event) => change("sonnetModel", event.target.value)} value={draft.sonnetModel} /></Field>
            <Field label="Opus 映射"><Input disabled={Boolean(pending)} maxLength="200" onChange={(event) => change("opusModel", event.target.value)} value={draft.opusModel} /></Field>
            <Field label="Haiku 映射"><Input disabled={Boolean(pending)} maxLength="200" onChange={(event) => change("haikuModel", event.target.value)} value={draft.haikuModel} /></Field>
            <Field label="子 Agent 模型"><Input disabled={Boolean(pending)} maxLength="200" onChange={(event) => change("subagentModel", event.target.value)} value={draft.subagentModel} /></Field>
            <Field label="默认思考强度">
              <Select disabled={Boolean(pending)} fullWidth onChange={(value) => change("effortLevel", value)} options={[{ label: "沿用服务默认", value: "" }, { label: "低", value: "low" }, { label: "中", value: "medium" }, { label: "高", value: "high" }, { label: "最高", value: "max" }]} value={draft.effortLevel} />
            </Field>
            {custom ? (
              <>
                <Field label="密钥传递方式">
                  <Select disabled={Boolean(pending)} fullWidth onChange={(value) => change("authMode", value)} options={[{ label: "Authorization Bearer", value: "auth-token" }, { label: "x-api-key", value: "api-key" }]} value={draft.authMode} />
                </Field>
                <Field className="admin-field--wide" hint="只用于点击“获取模型列表”，不会写入 Claude Code 配置。" label="模型列表地址（可选）">
                  <Input disabled={Boolean(pending)} maxLength="500" onChange={(event) => change("modelListUrl", event.target.value)} value={draft.modelListUrl} />
                </Field>
              </>
            ) : null}
          </div>
        </details>

        <footer className="admin-form-footer">
          <Button disabled={Boolean(pending)} size="md" type="submit">{pending === "save" ? "正在保存…" : "保存 Claude Code API"}</Button>
        </footer>
        <InlineError>{error}</InlineError>
      </form>
    </AdminPanel>
  );
}

function SwitchRow({ checked, description, disabled, label, onChange }) {
  return (
    <label className="admin-switch-row">
      <span><strong>{label}</strong>{description ? <small>{description}</small> : null}</span>
      <Switch checked={checked} disabled={disabled} onChange={onChange} />
    </label>
  );
}

function DefaultRuntimeRules({ actions, settings }) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const toolPermissions = settings?.claudeToolPermissions || {};
  const projectDefaults = settings?.claudeProjectDefaults || {};
  const runtimeFeatures = settings?.claudeRuntimeFeatures || {};
  const defaultProjectRules = {
    allowedTools: list(projectDefaults.allowedTools).join("\n"),
    deniedTools: list(projectDefaults.deniedTools).join("\n"),
    skipWebFetchPreflight: projectDefaults.skipWebFetchPreflight !== false,
  };
  const baseCapabilities = CLAUDE_BASE_CAPABILITIES.map((capability) => ({
    ...capability,
    enabled: capability.key === "read"
      ? toolPermissions.read !== false
      : capability.key === "webFetch"
        ? toolPermissions.webFetch !== false
        : capability.key === "webSearch"
          ? toolPermissions.webSearch !== false
          : runtimeFeatures[capability.key] !== false,
  }));
  const [allowedTools, setAllowedTools] = useState(defaultProjectRules.allowedTools);
  const [deniedTools, setDeniedTools] = useState(defaultProjectRules.deniedTools);

  useEffect(() => {
    setAllowedTools(defaultProjectRules.allowedTools);
    setDeniedTools(defaultProjectRules.deniedTools);
  }, [defaultProjectRules.allowedTools, defaultProjectRules.deniedTools]);

  const run = async (key, task) => {
    if (!task || pending) return;
    setPending(key);
    setError("");
    try {
      await task();
    } catch (updateError) {
      setError(clean(updateError?.message) || "无法更新默认运行规则。");
      setPending("");
    }
  };

  const updatePermission = (key, checked) => {
    const next = {
      read: toolPermissions.read !== false,
      webFetch: toolPermissions.webFetch !== false,
      webSearch: toolPermissions.webSearch !== false,
      [key]: checked,
    };
    run("permission:" + key, () => actions?.updateSettings?.({ claudeToolPermissions: next }));
  };

  const updateFeature = (key, checked) => {
    const next = {
      askUserQuestion: runtimeFeatures.askUserQuestion === true,
      backgroundTasks: runtimeFeatures.backgroundTasks === true,
      bash: runtimeFeatures.bash !== false,
      edit: runtimeFeatures.edit !== false,
      glob: runtimeFeatures.glob !== false,
      grep: runtimeFeatures.grep !== false,
      nativeCron: runtimeFeatures.nativeCron === true,
      subagents: runtimeFeatures.subagents === true,
      taskList: runtimeFeatures.taskList === true,
      write: runtimeFeatures.write !== false,
      [key]: checked,
    };
    run("feature:" + key, () => actions?.updateSettings?.({ claudeRuntimeFeatures: next }));
  };

  const updateBaseCapability = (key, checked) => {
    if (["read", "webFetch", "webSearch"].includes(key)) updatePermission(key, checked);
    else updateFeature(key, checked);
  };

  const updateProjectDefault = (key, value) => {
    const next = { ...defaultProjectRules, allowedTools, deniedTools, [key]: value };
    run("claude-default:" + key, () => actions?.updateSettings?.({ claudeProjectDefaults: next }));
  };

  const saveProjectRules = () => {
    const next = { ...defaultProjectRules, allowedTools, deniedTools };
    run("claude-default:rules", () => actions?.updateSettings?.({ claudeProjectDefaults: next }));
  };

  return (
    <AdminPanel>
      <PanelHeading description="管理 Suzu Lives 的 Claude 工具与运行规则。" eyebrow="AGENT DEFAULTS" title="默认运行规则" />
      <div className="admin-runtime-rules">
        <section className="admin-rule-group">
          <details className="admin-advanced">
            <summary><span>Claude 工具权限</span></summary>
            <section className="admin-capability-section">
              <div className="admin-capability-section__heading"><p>控制 Suzu 中 Claude 的默认允许项。</p></div>
              <div className="admin-switch-list">
                {baseCapabilities.map((capability) => <SwitchRow checked={capability.enabled} description={capability.description} disabled={Boolean(pending)} key={capability.key} label={capability.label} onChange={(event) => updateBaseCapability(capability.key, event.target.checked)} />)}
                <SwitchRow checked={defaultProjectRules.skipWebFetchPreflight} disabled={Boolean(pending)} label="跳过 Web Fetch 的预检" onChange={(event) => updateProjectDefault("skipWebFetchPreflight", event.target.checked)} />
              </div>
              <details className="admin-advanced">
                <summary><span>权限白名单</span></summary>
                <div className="admin-form-grid">
                  <Field className="admin-field--wide" label="白名单"><Textarea disabled={Boolean(pending)} maxLength="50000" onChange={(event) => setAllowedTools(event.target.value)} placeholder={"每行一个，例如：Bash(git status:*)"} value={allowedTools} /></Field>
                  <Field className="admin-field--wide" label="始终禁止的工具"><Textarea disabled={Boolean(pending)} maxLength="50000" onChange={(event) => setDeniedTools(event.target.value)} placeholder={"每行一个，例如：Read(./.env)"} value={deniedTools} /></Field>
                </div>
                <div className="admin-form-footer"><Button disabled={Boolean(pending)} onClick={saveProjectRules} size="md" type="button" variant="secondary">{pending === "claude-default:rules" ? "正在保存…" : "保存权限规则"}</Button></div>
              </details>
            </section>
          </details>
        </section>
        <section className="admin-rule-group">
          <details className="admin-advanced admin-advanced--runtime-features">
            <summary><span>Claude 内建能力</span></summary>
            <section className="admin-capability-section">
              <div className="admin-switch-list">
                {CLAUDE_RUNTIME_FEATURES.map((item) => (
                  <SwitchRow checked={runtimeFeatures[item.key] === true} disabled={Boolean(pending)} key={item.key} label={item.label} onChange={(event) => updateFeature(item.key, event.target.checked)} />
                ))}
              </div>
            </section>
          </details>
        </section>
      </div>
      <InlineError>{error}</InlineError>
    </AdminPanel>
  );
}

function RuntimeSettings({ actions, settings }) {
  return (
    <section className="admin-runtime-page">
      <DefaultRuntimeRules actions={actions} settings={settings} />
    </section>
  );
}

function parseExtraJson(value, label) {
  const text = clean(value);
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(label + "必须是有效 JSON 对象。");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(label + "必须是 JSON 对象。");
  return parsed;
}

function apiConnectionDraft(connection = null) {
  const value = connection || DEFAULT_API_CONNECTION;
  return {
    apiKey: "",
    baseUrl: clean(value.baseUrl),
    editEndpoint: clean(value.editEndpoint) || "/images/edits",
    editExtraBody: JSON.stringify(value.editExtraBody || {}, null, 2),
    extraBody: JSON.stringify(value.extraBody || {}, null, 2),
    generationEndpoint: clean(value.generationEndpoint) || "/images/generations",
    id: clean(value.id),
    inputFidelity: clean(value.inputFidelity),
    model: clean(value.model),
    name: clean(value.name) || "阿里百炼",
    outputFormat: clean(value.outputFormat),
    quality: clean(value.quality),
    timeoutMs: String(value.timeoutMs || 180000),
    type: clean(value.type) || "dashscope",
  };
}

function apiConnectionUsage(connection, bindings) {
  const usedBy = API_BINDINGS.filter((item) => item.selected(bindings) === connection.id).map((item) => item.label);
  return usedBy.length ? "用于 " + usedBy.join("、") : "暂未分配";
}

function ApiBindings({ actions, bindings, connections, onManage }) {
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");

  const bind = async (bindingId, connectionId) => {
    if (!actions?.bindApi || pending) return;
    setPending(bindingId);
    setError("");
    try {
      await actions.bindApi(bindingId, connectionId);
    } catch (bindError) {
      setError(clean(bindError?.message) || "无法更新功能使用的 API。");
      setPending("");
    }
  };

  return (
    <AdminPanel>
      <PanelHeading
        actions={<Button onClick={onManage} size="md" type="button" variant="secondary">管理 API</Button>}
        description="日常文字对话使用 Claude Code 的文字模型；只有图片、声音、视频和记忆处理需要在这里指定 API。"
        eyebrow="功能"
        title="为功能选择 API"
      />
      <div className="admin-api-binding-list">
        {API_BINDINGS.map((item) => {
          const selectedId = item.selected(bindings);
          const available = connections.filter((connection) => item.types.includes(connection.type));
          const options = available.map((connection) => ({ label: connection.name, value: connection.id }));
          return (
            <article className="admin-api-binding-row" key={item.id}>
              <div><h3>{item.label}</h3><p>{item.detail}</p></div>
              <Select disabled={!options.length || Boolean(pending)} fullWidth onChange={(value) => bind(item.id, value)} options={options} placeholder={options.length ? "选择 API" : "还没有可用 API"} value={selectedId} />
            </article>
          );
        })}
      </div>
      <InlineError>{error}</InlineError>
    </AdminPanel>
  );
}

function ApiConnectionManager({ bindings, connections, onClose, onEdit, onNew, onRemove }) {
  const footer = <div className="admin-dialog-actions"><Button onClick={onNew} size="md" type="button">添加 API</Button></div>;
  return (
    <Dialog footer={footer} onClose={onClose} open title="API 管理">
      <div className="admin-api-manager">
        <p className="admin-dialog-copy">在这里添加、修改或移除 API。它们会出现在功能的选择框中。</p>
        {connections.length ? (
          <div className="admin-api-manager__list">
            {connections.map((connection) => (
              <article className="admin-api-manager__row" key={connection.id}>
                <div><strong>{connection.name}</strong><p>{apiConnectionUsage(connection, bindings)}</p></div>
                <div><Button onClick={() => onEdit(connection)} size="md" type="button" variant="secondary">编辑</Button><Button onClick={() => onRemove(connection)} size="md" type="button" variant="ghost">移除</Button></div>
              </article>
            ))}
          </div>
        ) : <Empty className="admin-api-manager__empty" description="添加后，就能在功能列表里选择它。" title="还没有添加 API" />}
      </div>
    </Dialog>
  );
}

function ApiConnectionEditor({ connection, onClose, onSave }) {
  const [draft, setDraft] = useState(() => apiConnectionDraft(connection));
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const dashscope = draft.type === "dashscope";
  const imageApi = draft.type === "openai-compatible";
  const supportsModel = dashscope || imageApi;
  const editing = Boolean(connection?.id);

  useEffect(() => {
    setDraft(apiConnectionDraft(connection));
    setError("");
  }, [connection]);

  const change = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const save = async (event) => {
    event.preventDefault();
    if (!onSave || pending) return;
    setPending(true);
    setError("");
    try {
      await onSave({
        ...draft,
        apiKey: draft.apiKey,
        editExtraBody: parseExtraJson(draft.editExtraBody, "编辑附加参数 JSON"),
        extraBody: parseExtraJson(draft.extraBody, "生成附加参数 JSON"),
        name: dashscope ? "阿里百炼" : draft.name,
        timeoutMs: Number(draft.timeoutMs),
      });
    } catch (saveError) {
      setError(clean(saveError?.message) || "无法保存 API。");
      setPending(false);
    }
  };

  const footer = (
    <div className="admin-dialog-actions">
      <Button disabled={pending} onClick={onClose} type="button" variant="secondary">取消</Button>
      <Button disabled={pending} form="adminApiConnectionForm" type="submit">{pending ? "正在保存…" : editing ? "保存修改" : "保存 API"}</Button>
    </div>
  );

  return (
    <Dialog footer={footer} onClose={pending ? () => {} : onClose} open title={editing ? "编辑 " + connection.name : "添加 API"}>
      <form className="admin-api-editor admin-form" id="adminApiConnectionForm" onSubmit={save}>
        <p className="admin-dialog-copy">{editing ? "密钥留空会保留当前保存的值。" : "阿里百炼只需填写 API Key；保存后在功能列表选择要使用它的能力。"}</p>
        <div className="admin-form-grid">
          {!dashscope ? <Field className="admin-field--wide" label="API 名称"><Input disabled={pending} maxLength="80" onChange={(event) => change("name", event.target.value)} placeholder="例如：智创、阿里百炼" required value={draft.name} /></Field> : null}
          <Field label="服务商">
            <Select disabled={pending} fullWidth onChange={(value) => change("type", value)} options={[{ label: "阿里百炼", value: "dashscope" }, { label: "OpenAI 兼容", value: "openai-compatible" }, { label: "其他 API", value: "generic-api" }]} value={draft.type} />
          </Field>
          <Field label="密钥"><Input autoComplete="new-password" disabled={pending} maxLength="512" onChange={(event) => change("apiKey", event.target.value)} placeholder={editing ? "留空则保留当前密钥" : "新建时必填"} required={!editing} type="password" value={draft.apiKey} /></Field>
          {!dashscope ? <Field className="admin-field--wide" hint={imageApi ? "图像服务需要填写完整 Base URL。" : "通常可留空；只有服务商要求时才填写。"} label={imageApi ? "服务地址" : "服务地址（可选）"}><Input disabled={pending} maxLength="500" onChange={(event) => change("baseUrl", event.target.value)} placeholder={imageApi ? "填写完整 Base URL" : "可留空，使用服务默认地址"} required={imageApi} value={draft.baseUrl} /></Field> : null}
          {supportsModel ? <Field className="admin-field--wide" label="模型"><Input disabled={pending} maxLength="160" onChange={(event) => change("model", event.target.value)} placeholder="例如：模型名称" value={draft.model} /></Field> : null}
        </div>
        {imageApi ? (
          <details className="admin-advanced">
            <summary><span>进阶设置</span><small>只有 API 文档要求时才需要修改</small></summary>
            <p className="admin-advanced-copy">通常保留原值即可；这里用于兼容有特殊要求的图像 API。</p>
            <div className="admin-form-grid">
              <Field label="生成地址"><Input disabled={pending} maxLength="300" onChange={(event) => change("generationEndpoint", event.target.value)} value={draft.generationEndpoint} /></Field>
              <Field label="编辑地址"><Input disabled={pending} maxLength="300" onChange={(event) => change("editEndpoint", event.target.value)} value={draft.editEndpoint} /></Field>
              <Field label="质量（可选）"><Input disabled={pending} maxLength="120" onChange={(event) => change("quality", event.target.value)} value={draft.quality} /></Field>
              <Field label="输出格式（可选）"><Input disabled={pending} maxLength="120" onChange={(event) => change("outputFormat", event.target.value)} value={draft.outputFormat} /></Field>
              <Field label="参考保真（可选）"><Input disabled={pending} maxLength="120" onChange={(event) => change("inputFidelity", event.target.value)} value={draft.inputFidelity} /></Field>
              <Field label="请求超时（毫秒）"><Input disabled={pending} max="600000" min="1000" onChange={(event) => change("timeoutMs", event.target.value)} type="number" value={draft.timeoutMs} /></Field>
              <Field className="admin-field--wide" label="生成附加参数 JSON"><Textarea disabled={pending} maxLength="50000" onChange={(event) => change("extraBody", event.target.value)} spellCheck={false} value={draft.extraBody} /></Field>
              <Field className="admin-field--wide" label="编辑附加参数 JSON"><Textarea disabled={pending} maxLength="50000" onChange={(event) => change("editExtraBody", event.target.value)} spellCheck={false} value={draft.editExtraBody} /></Field>
            </div>
          </details>
        ) : null}
        <InlineError>{error}</InlineError>
      </form>
    </Dialog>
  );
}

function ApiDeleteDialog({ connection, onClose, onConfirm }) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const remove = async () => {
    if (!onConfirm || pending) return;
    setPending(true);
    setError("");
    try {
      await onConfirm(connection.id);
    } catch (removeError) {
      setError(clean(removeError?.message) || "无法移除 API。");
      setPending(false);
    }
  };
  const footer = <div className="admin-dialog-actions"><Button disabled={pending} onClick={onClose} type="button" variant="secondary">取消</Button><Button disabled={pending} onClick={remove} type="button" variant="danger">{pending ? "正在移除…" : "移除"}</Button></div>;
  return <Dialog footer={footer} onClose={pending ? () => {} : onClose} open title="移除 API"><div className="admin-delete-dialog"><p>{`移除“${connection.name || "这个 API"}”？已选用它的功能会改为未选择。`}</p><InlineError>{error}</InlineError></div></Dialog>;
}

function ApiServices({ actions, services }) {
  const snapshot = services || {};
  const connections = list(snapshot.connections);
  const bindings = snapshot.bindings || {};
  const [managerOpen, setManagerOpen] = useState(false);
  const [editing, setEditing] = useState(undefined);
  const [removing, setRemoving] = useState(null);
  const openEditor = (connection) => {
    setManagerOpen(false);
    setEditing(connection || null);
  };

  return (
    <section className="admin-api-page">
      <ApiBindings actions={actions} bindings={bindings} connections={connections} onManage={() => setManagerOpen(true)} />
      {managerOpen ? <ApiConnectionManager bindings={bindings} connections={connections} onClose={() => setManagerOpen(false)} onEdit={openEditor} onNew={() => openEditor(null)} onRemove={(connection) => { setManagerOpen(false); setRemoving(connection); }} /> : null}
      {editing !== undefined ? <ApiConnectionEditor connection={editing} key={editing?.id || "new"} onClose={() => setEditing(undefined)} onSave={actions?.saveApiConnection} /> : null}
      {removing ? <ApiDeleteDialog connection={removing} onClose={() => setRemoving(null)} onConfirm={actions?.removeApiConnection} /> : null}
    </section>
  );
}

function usageSummary(data) {
  const summary = data?.summary || {};
  return {
    conversations: list(summary.conversations),
    month: summary.month || { amountCny: 0, requestCount: 0 },
    today: summary.today || { amountCny: 0, requestCount: 0 },
  };
}

function usageEvents(data, filter, query) {
  const search = clean(query).toLocaleLowerCase("zh-CN");
  return list(data?.events).filter((event) => {
    if (filter !== "all" && event.source !== filter) return false;
    if (!search) return true;
    return [event.contactName, event.source, event.feature, event.model, event.turnPrompt, event.requestId].join("\n").toLocaleLowerCase("zh-CN").includes(search);
  });
}

function PriceModelCard({ actions, model }) {
  const [rates, setRates] = useState(() => ({ ...(model?.rates || {}) }));
  const [effectiveFrom, setEffectiveFrom] = useState(model?.origin === "custom" ? localDateTimeInput(model.effectiveFrom) : startOfTodayInput());
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const definitions = model?.rateDefinitions || {};

  useEffect(() => {
    setRates({ ...(model?.rates || {}) });
    setEffectiveFrom(model?.origin === "custom" ? localDateTimeInput(model.effectiveFrom) : startOfTodayInput());
    setError("");
  }, [model]);

  const save = async () => {
    const date = new Date(effectiveFrom);
    if (!Number.isFinite(date.getTime())) {
      setError("请填写有效的价格生效时间。");
      return;
    }
    const nextRates = {};
    for (const key of Object.keys(definitions)) {
      const value = Number(rates[key]);
      if (!Number.isFinite(value) || value < 0) {
        setError("价格必须是大于或等于 0 的数字。");
        return;
      }
      nextRates[key] = value;
    }
    if (!actions?.savePrice || pending) return;
    setPending(true);
    setError("");
    try {
      await actions.savePrice({ effectiveFrom: date.toISOString(), modelId: model.modelId, rates: nextRates });
    } catch (saveError) {
      setError(clean(saveError?.message) || "无法保存价格。");
      setPending(false);
    }
  };

  const reset = async () => {
    if (!actions?.resetPrice || pending) return;
    setPending(true);
    setError("");
    try {
      await actions.resetPrice(model.modelId);
    } catch (resetError) {
      setError(clean(resetError?.message) || "无法恢复官方默认价格。");
      setPending(false);
    }
  };

  return (
    <AdminPanel className="admin-price-card">
      <PanelHeading description={(model.provider || "未知服务商") + " · " + (model.origin === "custom" ? "当前使用自定义价格" : "当前使用官方默认价")} status={<Status label={model.origin === "custom" ? "自定义" : "官方默认"} tone={model.origin === "custom" ? "success" : "muted"} />} title={model.label || model.modelId} />
      <div className="admin-price-rate-grid">
        {Object.entries(definitions).map(([key, definition]) => (
          <Field key={key} label={definition.label}>
            <Input disabled={pending} min="0" onChange={(event) => setRates((current) => ({ ...current, [key]: event.target.value }))} step="any" type="number" value={rates[key] ?? 0} />
            <small>{definition.unitLabel}</small>
          </Field>
        ))}
      </div>
      <footer className="admin-price-card__footer">
        <Field label="生效时间"><Input disabled={pending} onChange={(event) => setEffectiveFrom(event.target.value)} type="datetime-local" value={effectiveFrom} /></Field>
        <div className="admin-panel-buttons">{model.customRevisionCount ? <Button disabled={pending} onClick={reset} size="md" type="button" variant="secondary">恢复官方默认</Button> : null}<Button disabled={pending} onClick={save} size="md" type="button">{pending ? "正在保存…" : "保存价格"}</Button></div>
      </footer>
      <InlineError>{error}</InlineError>
    </AdminPanel>
  );
}

function UsageEventTable({ events }) {
  return (
    <table className="admin-usage-table">
      <thead><tr><th>时间</th><th>联系人</th><th>来源</th><th>类型</th><th>模型</th><th>Token</th><th>估算费用</th></tr></thead>
      <tbody>
        {events.length ? events.map((event, index) => <tr key={(event.contactId || "contact") + ":" + (event.id || event.requestId || event.timestamp || "event") + "-" + index}><td>{dateTime(event.timestamp)}</td><td><Status label={event.contactName || "未归属联系人"} tone="muted" /></td><td>{event.source}</td><td>{event.feature}</td><td>{event.model || "未知"}</td><td>{compactNumber(event.units?.totalInputTokens || event.units?.totalTokens || 0)}</td><td>{money(event.amountCny)}</td></tr>) : <tr><td colSpan="7"><div className="admin-empty-copy">没有符合条件的已识别调用。</div></td></tr>}
      </tbody>
    </table>
  );
}

function ConversationCostList({ conversations }) {
  return conversations.length ? <div className="admin-conversation-list">{conversations.map((item, index) => <article key={(item.contactId || "contact") + ":" + (item.turnId || item.firstAt || "conversation") + "-" + index}><div><strong>{item.prompt}</strong><p><Status label={item.contactName || "未归属联系人"} tone="muted" /> · {dateTime(item.firstAt)}{item.tools?.length ? " · 工具：" + item.tools.join("、") : ""}</p></div><span>{item.requestCount} 次请求</span><b>{money(item.amountCny)}</b></article>)}</div> : <p className="admin-empty-copy">还没有可以归属到会话轮次的费用。</p>;
}

function UsageSettings({ actions, data }) {
  const ready = data?.status === "ready";
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [sourceScopeOpen, setSourceScopeOpen] = useState(false);
  const [allUsageOpen, setAllUsageOpen] = useState(false);
  const [allConversationCostsOpen, setAllConversationCostsOpen] = useState(false);
  const summary = usageSummary(data);
  const events = list(data?.events);
  const sources = list(data?.sources);
  const filtered = usageEvents(data, filter, query);
  const recentEvents = filtered.slice(-20).reverse();
  const allFilteredEvents = filtered.slice().reverse();
  const visibleConversationCosts = summary.conversations.slice(0, 20);
  const sourceNames = [...new Set(events.map((event) => event.source).filter(Boolean))];
  const prices = list(data?.priceCatalog?.models);

  if (!ready) {
    return <Empty action={<Button onClick={actions?.openConversation}>前往会话</Button>} className="admin-usage-empty" description="创建并选择联系人后，Suzu 才能显示费用统计范围和调用流水。" title="等待本地费用数据" />;
  }

  return (
    <section className="admin-usage-page">
      <section className="admin-usage-summary">
        <AdminPanel><span className="admin-kicker">TODAY</span><strong>{money(summary.today.amountCny)}</strong><p>{summary.today.requestCount} 次已识别调用</p></AdminPanel>
        <AdminPanel><span className="admin-kicker">MONTH</span><strong>{money(summary.month.amountCny)}</strong><p>按当前价格规则估算</p></AdminPanel>
        <AdminPanel className="admin-usage-source-card">
          <span className="admin-kicker">SOURCES</span>
          <strong>{sources.filter((item) => item.tracked && item.status === "ready").length} / {sources.length}</strong>
          <p>全部联系人费用统计范围</p>
          <button aria-haspopup="dialog" aria-label="查看费用统计范围" className="admin-usage-source-card__trigger" onClick={() => setSourceScopeOpen(true)} type="button" />
        </AdminPanel>
      </section>

      <Dialog onClose={() => setSourceScopeOpen(false)} open={sourceScopeOpen} title="费用统计范围">
        <div className="admin-source-scope-dialog">
          <p className="admin-dialog-copy">下面都是已接入费用统计的调用来源；产生调用后会显示记录，已配置价格的模型会显示金额。</p>
          <div className="admin-source-list">
            {sources.length ? sources.map((source) => <article key={source.id || source.name}><div><strong>{source.name}</strong><p>{source.detail}</p></div><Status label="已接入" tone="success" /></article>) : <p className="admin-empty-copy">尚无来源信息。</p>}
          </div>
        </div>
      </Dialog>

      <Dialog onClose={() => setAllUsageOpen(false)} open={allUsageOpen} title="全部花销">
        <div className="admin-usage-all-dialog">
          <p className="admin-dialog-copy">按当前筛选显示 {filtered.length.toLocaleString("zh-CN")} 条调用流水。</p>
          <div className="admin-usage-all-dialog__scroll">
            <UsageEventTable events={allFilteredEvents} />
          </div>
        </div>
      </Dialog>

      <Dialog onClose={() => setAllConversationCostsOpen(false)} open={allConversationCostsOpen} title="全部会话花销">
        <div className="admin-usage-all-dialog">
          <p className="admin-dialog-copy">按费用从高到低显示 {summary.conversations.length.toLocaleString("zh-CN")} 个会话轮次。</p>
          <div className="admin-usage-all-dialog__scroll">
            <ConversationCostList conversations={summary.conversations} />
          </div>
        </div>
      </Dialog>

      <AdminPanel className="admin-usage-ledger">
        <PanelHeading description={"最近扫描于 " + dateTime(data.scannedAt) + "，共 " + events.length.toLocaleString("zh-CN") + " 条已识别记录。"} title="调用流水" />
        <div className="admin-usage-toolbar">
          <div className="admin-filter-list">
            <Button className={filter === "all" ? "is-active" : ""} onClick={() => setFilter("all")} size="sm" type="button" variant="secondary">全部</Button>
            {sourceNames.map((source) => <Button className={filter === source ? "is-active" : ""} key={source} onClick={() => setFilter(source)} size="sm" type="button" variant="secondary">{source}</Button>)}
          </div>
          <Input className="admin-usage-search" onChange={(event) => setQuery(event.target.value)} placeholder="搜索联系人、模型、请求 ID、会话内容" type="search" value={query} />
        </div>
        <div className="admin-table-scroll">
          <UsageEventTable events={recentEvents} />
        </div>
        {filtered.length ? <footer className="admin-usage-ledger__footer"><Button onClick={() => setAllUsageOpen(true)} size="md" type="button" variant="secondary">查看全部花销</Button></footer> : null}
      </AdminPanel>

      <AdminPanel>
        <PanelHeading description="一次用户输入可能触发多次模型请求和工具循环。" title="会话费用" />
        <ConversationCostList conversations={visibleConversationCosts} />
        {summary.conversations.length ? <footer className="admin-usage-ledger__footer"><Button onClick={() => setAllConversationCostsOpen(true)} size="md" type="button" variant="secondary">查看全部会话花销</Button></footer> : null}
      </AdminPanel>

      <section className="admin-price-list">
        {prices.map((model) => <PriceModelCard actions={actions} key={model.modelId} model={model} />)}
      </section>
    </section>
  );
}

export function AdminPage({ actions = {}, snapshot = {} }) {
  const tab = ADMIN_TABS.some((item) => item.value === snapshot.tab) ? snapshot.tab : "agent";
  const settings = snapshot.settings || {};

  return (
    <div className="admin-react-page">
      <PageHeader eyebrow="MANAGE" subtitle="管理我的身份、Claude Code、API 和用量。" title="管理" />
      <Tabs active={tab} className="admin-page-tabs" items={ADMIN_TABS} onChange={actions.setTab} size="md" />
      <section aria-label={ADMIN_TABS.find((item) => item.value === tab)?.label || "管理"} className="admin-page-body">
        {tab === "agent" ? <IdentitySettings actions={actions} settings={settings} /> : null}
        {tab === "claude-code" ? <ClaudeCodeApiSettings actions={actions} config={snapshot.claudeCodeApi || {}} initialModels={snapshot.claudeCodeModels} initialNotice={snapshot.claudeCodeModelNotice} /> : null}
        {tab === "runtime" ? <RuntimeSettings actions={actions} settings={settings} /> : null}
        {tab === "api-services" ? <ApiServices actions={actions} services={snapshot.apiServices} settings={settings} /> : null}
        {tab === "usage" ? <UsageSettings actions={actions} data={snapshot.data} /> : null}
      </section>
    </div>
  );
}
