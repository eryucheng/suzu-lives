import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Avatar, Banner, Button, Dialog, Drawer, Empty, GlassPanel, Input, PageHeader, Select, Status, Tabs } from "suzu-design-system";

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
import { SUZU_ADMIN_TABS } from "../core/chat-first.mjs";
import { dateTime, localDateTimeInput, money, startOfTodayInput } from "../core/formatters.mjs";
import { getIdentity, profileInitial } from "../core/identity.mjs";
import { TEXT_MODEL_PROVIDERS } from "../features/agent/runtime.mjs";
import { usageAmountLabel, usageCostLabel } from "../features/usage/usage-display.mjs";
import { usageHistoryRows } from "../features/usage/usage-history.mjs";

import { PageScaffold } from "./page-scaffold.jsx";
import "./admin-page.css";

const ADMIN_TAB_LABELS = Object.freeze({
  agent: "我",
  usage: "用量与成本",
});

const ADMIN_TABS = SUZU_ADMIN_TABS.map((value) => ({ label: ADMIN_TAB_LABELS[value], value }));

const OWNER_GENDER_OPTIONS = [
  { label: "未设置", value: "" },
  { label: "女性", value: "female" },
  { label: "男性", value: "male" },
];

// Cost records use different units across text, audio, and image providers.
// Keep the user-created model contract explicit so the ledger can validate and
// price an unfamiliar model without guessing how it bills.
const CUSTOM_PRICE_TEMPLATES = Object.freeze([
  Object.freeze({
    value: "text",
    label: "文本模型 · 输入 / 输出 Token",
    hint: "适用于大多数聊天、推理与文本生成模型。",
    rateDefinitions: Object.freeze({
      inputTokens: Object.freeze({ label: "输入", unitLabel: "元 / 百万 Token", per: 1_000_000 }),
      outputTextTokens: Object.freeze({ label: "输出", unitLabel: "元 / 百万 Token", per: 1_000_000 }),
    }),
  }),
  Object.freeze({
    value: "text-cache",
    label: "文本模型 · 未缓存 / 缓存 / 输出 Token",
    hint: "调用记录包含缓存命中与未命中 Token 时使用。",
    rateDefinitions: Object.freeze({
      inputUncachedTokens: Object.freeze({ label: "未缓存输入", unitLabel: "元 / 百万 Token", per: 1_000_000 }),
      inputCachedTokens: Object.freeze({ label: "缓存命中输入", unitLabel: "元 / 百万 Token", per: 1_000_000 }),
      outputTextTokens: Object.freeze({ label: "输出", unitLabel: "元 / 百万 Token", per: 1_000_000 }),
    }),
  }),
  Object.freeze({
    value: "embedding",
    label: "向量模型 · 输入 Token",
    hint: "适用于 Embedding、检索向量等只按输入 Token 计费的模型。",
    rateDefinitions: Object.freeze({
      inputTokens: Object.freeze({ label: "输入", unitLabel: "元 / 百万 Token", per: 1_000_000 }),
    }),
  }),
  Object.freeze({
    value: "characters",
    label: "语音合成 · 输入字符",
    hint: "适用于按文本字符数计费的语音合成模型。",
    rateDefinitions: Object.freeze({
      inputCharacters: Object.freeze({ label: "输入字符", unitLabel: "元 / 万字符", per: 10_000 }),
    }),
  }),
  Object.freeze({
    value: "audio-seconds",
    label: "语音识别 · 输入音频时长",
    hint: "适用于按输入音频秒数计费的模型。",
    rateDefinitions: Object.freeze({
      inputAudioSeconds: Object.freeze({ label: "输入音频时长", unitLabel: "元 / 秒", per: 1 }),
    }),
  }),
  Object.freeze({
    value: "image-request",
    label: "图片生成 · 按请求次数",
    hint: "仅用于调用流水已经记录“图片请求”次数的来源。",
    rateDefinitions: Object.freeze({
      imageRequests: Object.freeze({ label: "图片请求", unitLabel: "元 / 次", per: 1 }),
    }),
  }),
]);

function clean(value) {
  return String(value ?? "").trim();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function customPriceTemplate(value) {
  return CUSTOM_PRICE_TEMPLATES.find((item) => item.value === value) || CUSTOM_PRICE_TEMPLATES[0];
}

function newCustomPriceDraft() {
  const template = customPriceTemplate();
  return {
    modelId: "",
    label: "",
    provider: "",
    template: template.value,
    effectiveFrom: startOfTodayInput(),
    rates: Object.fromEntries(Object.keys(template.rateDefinitions).map((key) => [key, ""])),
  };
}

function validProvider(value) {
  return Object.hasOwn(TEXT_MODEL_PROVIDERS, value) ? value : "deepseek";
}

function agentProvider(value) {
  return TEXT_MODEL_PROVIDERS[validProvider(value)] || TEXT_MODEL_PROVIDERS.deepseek;
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
      setPending(false);
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
    } finally {
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
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <AdminPanel className="admin-identity-panel">
        <PanelHeading description="聊天中显示的我的身份。" eyebrow="IDENTITY" title="我" />
        <div className="admin-identity-card">
          <div className="admin-identity-card__avatar-column">
            <Avatar className="admin-identity-card__avatar" fallback={profileInitial(owner, "我")} name={owner.displayName || "我"} size="xl" src={owner.avatarDataUrl || undefined} />
            <div className="admin-identity-card__avatar-actions">
              <Button disabled={pending} onClick={() => fileRef.current?.click()} size="md" type="button" variant="secondary">选择头像</Button>
              {owner.avatarDataUrl ? <Button disabled={pending} onClick={removeAvatar} size="md" type="button" variant="ghost">移除头像</Button> : null}
            </div>
          </div>
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
            <div className="admin-identity-card__footer">
              <Button disabled={pending} onClick={saveProfile} size="md" type="button" variant="primary">保存资料</Button>
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

function modelConnectionDraft(config = {}) {
  const providerId = validProvider(config.providerId);
  const provider = agentProvider(providerId);
  return {
    apiKey: "",
    baseUrl: clean(config.baseUrl) || provider.baseUrl || "",
    model: clean(config.model) || provider.model || "",
    provider: providerId,
    protocol: clean(config.protocol) || provider.protocol || "anthropic-messages",
  };
}

function AgentModelList({ disabled = false, models, onChange, onPickerClose, onPickerOpen, pickerOpen, value }) {
  const candidates = [...new Set(list(models).map(clean).filter(Boolean))];
  const choose = (candidate) => {
    if (disabled || !onChange) return;
    onChange(candidate);
    onPickerClose?.();
  };
  return (
    <div className="admin-model-picker">
      <Input
        disabled={disabled || !onChange}
        maxLength="200"
        onChange={(event) => onChange?.(event.target.value)}
        placeholder="填写服务商实际支持的模型标识"
        value={value}
      />
      {candidates.length ? (
        <>
          <div className="admin-model-picker__actions">
            <Button aria-haspopup="dialog" disabled={disabled || !onChange} onClick={() => onPickerOpen?.()} size="md" type="button" variant="secondary">从已获取模型中选择</Button>
            <p className="admin-model-picker__hint">已读取 {candidates.length} 个候选模型；也可以直接填写服务商文档中的模型标识。</p>
          </div>
          <Drawer onClose={() => onPickerClose?.()} open={Boolean(pickerOpen)} title="选择主模型">
            <div className="admin-model-picker__drawer">
              <p>从当前服务读取到的候选模型。选中后会填入主模型输入框，仍可手动修改。</p>
              <div className="admin-model-picker__list">
                {candidates.map((candidate) => {
                  const selected = candidate === clean(value);
                  return (
                    <article className={`admin-model-picker__row${selected ? " is-selected" : ""}`} key={candidate}>
                      <div>
                        <strong>{candidate}</strong>
                        <span>{selected ? "当前主模型" : "选择后会填入主模型"}</span>
                      </div>
                      <Button aria-pressed={selected} disabled={disabled || !onChange} onClick={() => choose(candidate)} size="sm" type="button" variant={selected ? "primary" : "secondary"}>{selected ? "正在使用" : "使用"}</Button>
                    </article>
                  );
                })}
              </div>
            </div>
          </Drawer>
        </>
      ) : null}
    </div>
  );
}

const MODEL_PROTOCOL_OPTIONS = Object.freeze([
  { label: "Anthropic Messages", value: "anthropic-messages" },
  { label: "OpenAI Chat Completions", value: "openai-completions" },
  { label: "OpenAI Responses", value: "openai-responses" },
]);

export function AgentModelSettings({ actions, config, initialModels = [], initialNotice = "" }) {
  const [draft, setDraft] = useState(() => modelConnectionDraft(config));
  const [models, setModels] = useState(() => list(initialModels));
  const [message, setMessage] = useState(initialNotice);
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);

  useEffect(() => {
    setDraft(modelConnectionDraft(config));
    setModels(list(initialModels));
    setMessage(initialNotice);
    setError("");
    setModelPickerOpen(false);
  }, [config, initialModels, initialNotice]);

  const change = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const changeProvider = (nextProviderId) => {
    const next = agentProvider(nextProviderId);
    setDraft((current) => ({
      ...current,
      provider: nextProviderId,
      baseUrl: next.baseUrl || "",
      model: next.model || "",
      protocol: next.protocol || "anthropic-messages",
    }));
    setModels([]);
    setModelPickerOpen(false);
    setMessage("");
    setError("");
  };

  const fetchModels = async () => {
    if (!actions?.fetchModels || pending) return;
    setPending("models");
    setError("");
    try {
      const result = await actions.fetchModels(draft);
      const nextModels = list(result?.models);
      setModels(nextModels);
      setModelPickerOpen(nextModels.length > 0);
      setMessage(clean(result?.message) || "模型列表已更新。");
    } catch (fetchError) {
      setModelPickerOpen(false);
      setMessage("");
      setError(clean(fetchError?.message) || "无法获取模型列表。");
    } finally {
      setPending("");
    }
  };

  const save = async (event) => {
    event.preventDefault();
    if (!actions?.saveModelConfiguration || pending) return;
    setPending("save");
    setError("");
    try {
      await actions.saveModelConfiguration(draft);
    } catch (saveError) {
      setError(clean(saveError?.message) || "无法保存主模型连接。");
    } finally {
      setPending("");
    }
  };

  const stateReady = config?.status === "ready";
  const status = <Status label={stateReady ? "已配置" : "等待填写"} tone={stateReady ? "success" : "muted"} />;

  return (
    <AdminPanel className="admin-agent-model-panel">
      <PanelHeading
        description="配置 Suzu Agent 使用的文本模型。密钥由本机凭据存储管理，不会写入其他工具的配置文件。"
        eyebrow="MAIN MODEL"
        status={status}
        title="主模型连接"
      />
      <form className="admin-form" onSubmit={save}>
        <section className="admin-form-section">
          <div className="admin-form-section__heading">
            <h3>使用哪个服务</h3>
            <p>DeepSeek 走原生适配器；其他服务走多提供商适配器。切换服务只更新当前选用的服务配置。</p>
          </div>
          <div className="admin-form-grid">
            <Field label="服务">
              <Select disabled={Boolean(pending)} fullWidth onChange={changeProvider} options={Object.entries(TEXT_MODEL_PROVIDERS).map(([id, item]) => ({ label: item.label, value: id }))} value={draft.provider} />
            </Field>
            <Field className="admin-field--wide" hint="使用服务商兼容地址；只接受 HTTPS，本机回环地址可用 HTTP。" label="服务地址">
              <Input disabled={Boolean(pending)} maxLength="500" onChange={(event) => change("baseUrl", event.target.value)} value={draft.baseUrl} />
            </Field>
            <Field label="接口协议">
              {draft.provider === "deepseek"
                ? <Input disabled value="OpenAI Chat Completions（原生）" />
                : <Select disabled={Boolean(pending)} fullWidth onChange={(value) => change("protocol", value)} options={MODEL_PROTOCOL_OPTIONS} value={draft.protocol} />}
            </Field>
            <Field label="API Key">
              <Input autoComplete="new-password" disabled={Boolean(pending)} maxLength="1000" onChange={(event) => change("apiKey", event.target.value)} placeholder={config?.hasApiKey ? "当前服务已保存；重新填写才会替换" : "保存服务时填写"} type="password" value={draft.apiKey} />
            </Field>
          </div>
        </section>

        <section className="admin-form-section">
          <div className="admin-form-section__heading">
            <h3>使用的模型</h3>
            <p>保存后会成为 Suzu Agent 的默认文本模型。支持目录读取的服务可拉取候选；其余服务直接按文档填写即可。</p>
          </div>
          <div className="admin-form-grid">
            <Field className="admin-field--wide" label="主模型">
              <AgentModelList
                disabled={Boolean(pending)}
                models={models}
                onChange={(value) => change("model", value)}
                onPickerClose={() => setModelPickerOpen(false)}
                onPickerOpen={() => setModelPickerOpen(true)}
                pickerOpen={modelPickerOpen}
                value={draft.model}
              />
            </Field>
          </div>
          <div className="admin-form-inline-actions">
            <Button disabled={Boolean(pending)} onClick={fetchModels} size="md" type="button" variant="secondary">{pending === "models" ? "正在获取…" : "获取模型列表"}</Button>
            {message ? <p>{message}</p> : null}
          </div>
        </section>

        <footer className="admin-form-footer">
          <Button disabled={Boolean(pending)} size="md" type="submit">{pending === "save" ? "正在保存…" : "保存主模型连接"}</Button>
        </footer>
        <InlineError>{error}</InlineError>
      </form>
    </AdminPanel>
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

function CustomPriceModelDialog({ onClose, onCreate }) {
  const [draft, setDraft] = useState(newCustomPriceDraft);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const template = customPriceTemplate(draft.template);

  const change = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const chooseTemplate = (value) => {
    const next = customPriceTemplate(value);
    setDraft((current) => ({
      ...current,
      template: next.value,
      rates: Object.fromEntries(Object.keys(next.rateDefinitions).map((key) => [key, current.rates[key] ?? ""])),
    }));
  };
  const create = async () => {
    const modelId = clean(draft.modelId).toLowerCase();
    const effectiveDate = new Date(draft.effectiveFrom);
    if (!modelId) {
      setError("请填写调用记录中实际返回的模型标识。");
      return;
    }
    if (!Number.isFinite(effectiveDate.getTime())) {
      setError("请填写有效的价格生效时间。");
      return;
    }
    const rates = {};
    for (const key of Object.keys(template.rateDefinitions)) {
      const raw = String(draft.rates[key] ?? "").trim();
      const value = Number(raw);
      if (!raw || !Number.isFinite(value) || value < 0) {
        setError("请填写每一项大于或等于 0 的单价。");
        return;
      }
      rates[key] = value;
    }
    if (!onCreate || pending) return;
    setPending(true);
    setError("");
    try {
      await onCreate({
        modelId,
        label: clean(draft.label) || modelId,
        provider: clean(draft.provider) || "自定义服务商",
        rateDefinitions: template.rateDefinitions,
        effectiveFrom: effectiveDate.toISOString(),
        rates,
      });
      onClose();
    } catch (createError) {
      setError(clean(createError?.message) || "无法新建模型价格。");
      setPending(false);
    }
  };
  const footer = <div className="admin-dialog-actions"><Button disabled={pending} onClick={onClose} type="button" variant="secondary">取消</Button><Button disabled={pending} onClick={() => void create()} type="button">{pending ? "正在创建…" : "创建模型价格"}</Button></div>;

  return (
    <Dialog footer={footer} onClose={pending ? () => {} : onClose} open title="新建模型价格">
      <div className="admin-custom-price-dialog">
        <form className="admin-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <p className="admin-dialog-copy">模型标识必须和调用流水里的 model 完全一致。创建后，过去和之后的调用都会按各自发生时间对应的价格计算。</p>
          <section className="admin-form-section">
            <div className="admin-form-grid">
              <Field label="模型标识"><Input autoComplete="off" disabled={pending} maxLength="200" onChange={(event) => change("modelId", event.target.value)} placeholder="例如 gpt-4.1-mini" spellCheck={false} value={draft.modelId} /></Field>
              <Field label="显示名称（可选）"><Input disabled={pending} maxLength="120" onChange={(event) => change("label", event.target.value)} placeholder="例如 GPT-4.1 mini" value={draft.label} /></Field>
              <Field label="服务商（可选）"><Input disabled={pending} maxLength="120" onChange={(event) => change("provider", event.target.value)} placeholder="例如 OpenAI" value={draft.provider} /></Field>
              <Field hint={template.hint} label="计费方式"><Select disabled={pending} fullWidth onChange={chooseTemplate} options={CUSTOM_PRICE_TEMPLATES.map((item) => ({ label: item.label, value: item.value }))} value={template.value} /></Field>
            </div>
          </section>
          <section className="admin-form-section">
            <div className="admin-form-section__heading"><h3>单价</h3><p>人民币；填写服务商公布的对应计费单位。</p></div>
            <div className="admin-price-rate-grid">
              {Object.entries(template.rateDefinitions).map(([key, definition]) => <Field key={key} label={definition.label}><Input disabled={pending} min="0" onChange={(event) => setDraft((current) => ({ ...current, rates: { ...current.rates, [key]: event.target.value } }))} placeholder="0" step="any" type="number" value={draft.rates[key] ?? ""} /><small>{definition.unitLabel}</small></Field>)}
            </div>
            <Field label="生效时间"><Input disabled={pending} onChange={(event) => change("effectiveFrom", event.target.value)} type="datetime-local" value={draft.effectiveFrom} /></Field>
          </section>
          <InlineError>{error}</InlineError>
        </form>
      </div>
    </Dialog>
  );
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
      <thead><tr><th>时间</th><th>联系人</th><th>来源</th><th>类型</th><th>模型</th><th>用量</th><th>估算费用</th></tr></thead>
      <tbody>
        {events.length ? events.map((event, index) => (
          <tr key={(event.contactId || "contact") + ":" + (event.id || event.requestId || event.timestamp || "event") + "-" + index}>
            <td>{dateTime(event.timestamp)}</td>
            <td><Status label={event.contactName || "未归属联系人"} tone="muted" /></td>
            <td>{event.source}</td>
            <td>{event.feature}</td>
            <td>{event.model || "未知"}</td>
            <td>{usageAmountLabel(event.units)}</td>
            <td>{usageCostLabel(event)}</td>
          </tr>
        )) : <tr><td colSpan="7"><div className="admin-empty-copy">没有符合条件的已识别调用。</div></td></tr>}
      </tbody>
    </table>
  );
}

function ConversationCostList({ conversations }) {
  return conversations.length ? <div className="admin-conversation-list">{conversations.map((item, index) => <article key={(item.contactId || "contact") + ":" + (item.turnId || item.firstAt || "conversation") + "-" + index}><div><strong>{item.prompt}</strong><p><Status label={item.contactName || "未归属联系人"} tone="muted" /> · {dateTime(item.firstAt)}{item.tools?.length ? " · 工具：" + item.tools.join("、") : ""}</p></div><span>{item.requestCount} 次请求</span><b>{money(item.amountCny)}</b></article>)}</div> : <p className="admin-empty-copy">还没有可以归属到会话轮次的费用。</p>;
}

const USAGE_HISTORY_TABS = Object.freeze([
  { label: "按日", value: "daily" },
  { label: "按月", value: "monthly" },
]);

function usageHistoryLabel(period, key) {
  if (period === "monthly") {
    const [year, month] = key.split("-");
    return `${year}年${Number(month)}月`;
  }
  const date = new Date(`${key}T12:00:00`);
  return new Intl.DateTimeFormat("zh-CN", { day: "numeric", month: "long", weekday: "short" }).format(date);
}

function usageHistoryDetail(item) {
  if (!item.requestCount) return "没有已识别调用";
  return `${item.requestCount} 次已识别调用${item.unknownRequestCount ? ` · ${item.unknownRequestCount} 次暂未计价` : ""}`;
}

function usageHistoryColumnLabel(period, key) {
  const parts = key.split("-");
  if (period === "monthly") return `${Number(parts[1])}月`;
  return `${Number(parts[1])}/${Number(parts[2])}`;
}

function UsageHistoryChart({ period, rows }) {
  const latestKey = rows[0]?.key || "";
  const [selectedKey, setSelectedKey] = useState(latestKey);
  useEffect(() => setSelectedKey(latestKey), [latestKey, period]);
  const selected = rows.find((item) => item.key === selectedKey) || rows[0];
  if (!selected) return null;

  const peak = Math.max(0, ...rows.map((item) => Number(item.amountCny) || 0));
  const columns = [...rows].reverse();
  const selectedAmount = Number(selected.amountCny) || 0;
  const isMonthly = period === "monthly";

  return (
    <div className="admin-usage-history-chart">
      <header className="admin-usage-history-chart__summary">
        <div>
          <span>{isMonthly ? "选中月份" : "选中日期"}</span>
          <strong>{usageHistoryLabel(period, selected.key)}</strong>
          <p>{usageHistoryDetail(selected)}</p>
        </div>
        <strong>{money(selectedAmount)}</strong>
      </header>
      <div className="admin-usage-history-chart__scroll">
        <div className="admin-usage-history-chart__plot" role="group" style={{ "--usage-history-column-count": columns.length }}>
          {columns.map((item) => {
            const amount = Number(item.amountCny) || 0;
            const height = peak > 0 && amount > 0 ? Math.max(3, (amount / peak) * 100) : 0;
            const active = item.key === selected.key;
            const label = usageHistoryLabel(period, item.key);
            const detail = usageHistoryDetail(item);
            return (
              <button
                aria-label={`${label}，${money(amount)}，${detail}`}
                aria-pressed={active}
                className={`admin-usage-history-chart__column${active ? " is-active" : ""}`}
                key={item.key}
                onClick={() => setSelectedKey(item.key)}
                onFocus={() => setSelectedKey(item.key)}
                onMouseEnter={() => setSelectedKey(item.key)}
                title={`${label} · ${money(amount)} · ${detail}`}
                type="button"
              >
                <span className="admin-usage-history-chart__rail"><span style={{ height: `${height}%` }} /></span>
                <span className="admin-usage-history-chart__label">{usageHistoryColumnLabel(period, item.key)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function UsageHistoryPage({ data, onBack, onPeriodChange, period }) {
  const rows = usageHistoryRows(data?.summary, { anchor: data?.today, period });
  const isMonthly = period === "monthly";

  return (
    <section className="admin-usage-history-page">
      <PanelHeading
        actions={<Button onClick={onBack} size="md" type="button" variant="secondary">返回费用与统计</Button>}
        description={isMonthly ? "按近 12 个月对比费用，柱高代表金额；没有调用的月份也会显示。" : "按近 14 天对比费用，柱高代表金额；没有调用的日期也会显示。"}
        eyebrow="COST HISTORY"
        title="费用趋势"
      />
      <Tabs active={period} className="admin-usage-history-tabs" items={USAGE_HISTORY_TABS} onChange={onPeriodChange} size="md" />
      <AdminPanel className="admin-usage-history-panel">
        <UsageHistoryChart period={period} rows={rows} />
      </AdminPanel>
    </section>
  );
}

function modelKey(value) {
  return clean(value).replace(/\[[^\]]+\]$/u, "").toLowerCase();
}

function UsageSettings({ actions, data }) {
  const ready = data?.status === "ready";
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [sourceScopeOpen, setSourceScopeOpen] = useState(false);
  const [allUsageOpen, setAllUsageOpen] = useState(false);
  const [allConversationCostsOpen, setAllConversationCostsOpen] = useState(false);
  const [customPriceOpen, setCustomPriceOpen] = useState(false);
  const [historyPeriod, setHistoryPeriod] = useState("");
  const summary = usageSummary(data);
  const events = list(data?.events);
  const filtered = usageEvents(data, filter, query);
  const recentEvents = filtered.slice(-20).reverse();
  const allFilteredEvents = filtered.slice().reverse();
  const visibleConversationCosts = summary.conversations.slice(0, 20);
  const sourceNames = [...new Set(events.map((event) => event.source).filter(Boolean))];
  const prices = list(data?.priceCatalog?.models);
  const pricedModelKeys = new Set(prices.flatMap((model) => [modelKey(model.modelId), modelKey(model.label)]).filter(Boolean));
  const seenModelEntries = [];
  const seenModelIndex = new Map();
  for (const event of events) {
    const name = clean(event.model);
    if (!name) continue;
    const key = modelKey(name);
    if (seenModelIndex.has(key)) continue;
    seenModelIndex.set(key, true);
    seenModelEntries.push({ name, covered: pricedModelKeys.has(key) });
  }
  const coveredModelCount = seenModelEntries.filter((entry) => entry.covered).length;

  if (!ready) {
    return <Empty action={<Button onClick={actions?.openConversation}>前往会话</Button>} className="admin-usage-empty" description="创建并选择联系人后，Suzu 才能显示费用统计范围和调用流水。" title="等待本地费用数据" />;
  }

  if (historyPeriod) {
    return <UsageHistoryPage data={data} onBack={() => setHistoryPeriod("")} onPeriodChange={setHistoryPeriod} period={historyPeriod} />;
  }

  return (
    <section className="admin-usage-page">
      <section className="admin-usage-summary">
        <AdminPanel className="admin-usage-summary-card"><button aria-label="查看按日费用趋势" className="admin-usage-summary-card__action" onClick={() => setHistoryPeriod("daily")} type="button"><span className="admin-kicker">TODAY</span><strong>{money(summary.today.amountCny)}</strong><p>{summary.today.requestCount} 次已识别调用</p></button></AdminPanel>
        <AdminPanel className="admin-usage-summary-card"><button aria-label="查看按月费用趋势" className="admin-usage-summary-card__action" onClick={() => setHistoryPeriod("monthly")} type="button"><span className="admin-kicker">MONTH</span><strong>{money(summary.month.amountCny)}</strong><p>按当前价格规则估算</p></button></AdminPanel>
        <AdminPanel className="admin-usage-source-card">
          <span className="admin-kicker">模型价格</span>
          <strong>{coveredModelCount} / {seenModelEntries.length}</strong>
          <p>出现过的模型 · 已登记价格</p>
          <button aria-haspopup="dialog" aria-label="查看模型价格登记情况" className="admin-usage-source-card__trigger" onClick={() => setSourceScopeOpen(true)} type="button" />
        </AdminPanel>
      </section>

      <Dialog onClose={() => setSourceScopeOpen(false)} open={sourceScopeOpen} title="模型价格覆盖">
        <div className="admin-source-scope-dialog">
          <p className="admin-dialog-copy">流水里出现过的模型；没有登记价格的模型不会计入金额，请在下方“模型价格”里为它新建价格。</p>
          <div className="admin-source-list">
            {seenModelEntries.length ? seenModelEntries.map((entry, index) => <article key={entry.name + "-" + index}><div><strong>{entry.name}</strong><p>{entry.covered ? "按当前价格规则估算" : "未登记价格，未计入金额"}</p></div><Status label={entry.covered ? "已登记" : "未登记"} tone={entry.covered ? "success" : "warning"} /></article>) : <p className="admin-empty-copy">还没有出现过的模型。</p>}
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

      <AdminPanel className="admin-price-intro">
        <PanelHeading actions={<Button onClick={() => setCustomPriceOpen(true)} size="md" type="button">新建模型价格</Button>} description="内置价格可直接调整；其他模型可按实际返回的 model 名称自行建立映射。" title="模型价格" />
      </AdminPanel>
      <section className="admin-price-list">
        {prices.map((model) => <PriceModelCard actions={actions} key={model.modelId} model={model} />)}
      </section>
      {customPriceOpen ? <CustomPriceModelDialog onClose={() => setCustomPriceOpen(false)} onCreate={actions?.createPriceModel} /> : null}
    </section>
  );
}

export function AdminPage({ actions = {}, snapshot = {} }) {
  const tab = ADMIN_TABS.some((item) => item.value === snapshot.tab) ? snapshot.tab : "agent";
  const settings = snapshot.settings || {};

  return (
    <PageScaffold
      canvasClassName="page-canvas--stack"
      className="admin-react-page"
      header={<PageHeader eyebrow="MANAGE" subtitle="管理我的资料与用量。" title="管理" />}
    >
      <Tabs active={tab} className="admin-page-tabs" items={ADMIN_TABS} onChange={actions.setTab} size="md" />
      <section aria-label={ADMIN_TABS.find((item) => item.value === tab)?.label || "管理"} className="admin-page-body">
        {tab === "agent" ? <IdentitySettings actions={actions} settings={settings} /> : null}
        {tab === "usage" ? <UsageSettings actions={actions} data={snapshot.data} /> : null}
      </section>
    </PageScaffold>
  );
}
