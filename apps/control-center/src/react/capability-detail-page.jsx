import { useEffect, useState } from "react";
import { Button, Empty, GlassPanel, PageHeader, Select, Status, Switch } from "suzu-design-system";

import { API_BINDINGS } from "../features/agent/runtime.mjs";
import {
  CAPABILITY_CATEGORIES,
  capabilityCategory,
  createWechatConnectionCapability,
  WECHAT_DELIVERY_OPTIONS,
  wechatConnectionSettings,
} from "../features/capabilities/overview.mjs";
import { CreateStudioDialog } from "./create-studio-dialog.jsx";

const EXTERNAL_TYPE_LABELS = Object.freeze({
  cli: "CLI（预留）",
  mcp: "MCP",
  skill: "Skill",
});
const CONTACT_SCOPED_CAPABILITY_IDS = new Set(["time-awareness", "image-vision", "video-understanding", "image-generation", "phone-camera", "voice-message", "site-automation", "iphone-bridge", "proactive-contact", "traveling-merchant"]);

function savedSettings(capability) {
  return capability?.savedSettings && typeof capability.savedSettings === "object"
    ? capability.savedSettings
    : {};
}

function capabilitySites(capability) {
  const sites = savedSettings(capability).sites;
  return Array.isArray(sites) ? sites : [];
}

function categoryFor(categoryId) {
  return CAPABILITY_CATEGORIES.find((category) => category.id === categoryId) || CAPABILITY_CATEGORIES[0];
}

function formValue(form) {
  const value = Object.fromEntries(new FormData(form).entries());
  form.querySelectorAll('input[type="checkbox"][name]').forEach((input) => {
    value[input.name] = input.checked;
  });
  return value;
}

function externalStatus(capability) {
  if (capability?.status === "registered") return ["已登记", "success"];
  if (capability?.status === "partial") return ["登记不完整", "warning"];
  if (capability?.status === "error") return ["需要处理", "warning"];
  return ["未登记", "muted"];
}

function externalTypeLabel(type) {
  return EXTERNAL_TYPE_LABELS[type] || type;
}

function SettingSurface({ action = null, children, className = "", description, eyebrow, title }) {
  return (
    <section className={["capability-settings-surface", className].join(" ").trim()}>
      {title ? (
        <header className="capability-settings-surface__heading">
          {eyebrow ? <span>{eyebrow}</span> : null}
          {action ? <div className="capability-settings-surface__title-row"><h2>{title}</h2>{action}</div> : <h2>{title}</h2>}
          {description ? <p>{description}</p> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

function FormGrid({ children, className = "" }) {
  return <div className={["capability-form-grid-react", className].join(" ").trim()}>{children}</div>;
}

function FormField({ children, className = "", hint, label }) {
  return (
    <label className={["capability-form-field", className].join(" ").trim()}>
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function ChoiceSelect({ name, options, value }) {
  const choices = options.map(([choiceValue, label]) => ({ label, value: String(choiceValue) }));
  const preferred = String(value ?? "");
  const initial = choices.some((choice) => choice.value === preferred) ? preferred : choices[0]?.value || "";
  const [selected, setSelected] = useState(initial);

  useEffect(() => {
    setSelected(initial);
  }, [initial]);

  return (
    <>
      <input name={name} type="hidden" value={selected} />
      <Select className="capability-select-react" fullWidth onChange={setSelected} options={choices} value={selected} />
    </>
  );
}

function CheckboxField({ defaultChecked, label, name }) {
  return (
    <label className="capability-checkbox-field">
      <input defaultChecked={defaultChecked} name={name} type="checkbox" />
      <span>{label}</span>
    </label>
  );
}

function AsyncSwitchRow({ checked, description, disabled = false, label, onChange }) {
  const [pending, setPending] = useState(false);
  const toggle = async (event) => {
    setPending(true);
    try {
      await onChange?.(event.target.checked);
    } finally {
      setPending(false);
    }
  };
  return (
    <label className="capability-switch-row">
      <span><strong>{label}</strong>{description ? <small>{description}</small> : null}</span>
      <Switch checked={checked} disabled={disabled || pending} onChange={toggle} />
    </label>
  );
}

function CapabilitySettingsForm({ abilityId, actions, children, submitLabel = "保存" }) {
  const [pending, setPending] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setPending(true);
    try {
      await actions.saveSettings?.(abilityId, formValue(event.currentTarget));
    } finally {
      setPending(false);
    }
  };
  const submitButton = submitLabel
    ? <Button disabled={pending} type="submit" variant="secondary">{pending ? "正在保存…" : submitLabel}</Button>
    : null;
  const renderInPlace = typeof children === "function";
  return (
    <form className="capability-settings-form-react" onSubmit={submit}>
      {renderInPlace ? children({ submitButton }) : children}
      {!renderInPlace && submitButton ? <footer className="capability-settings-form-react__footer">{submitButton}</footer> : null}
    </form>
  );
}

function ApiBinding({ actions, apiServices, bindingId }) {
  const item = API_BINDINGS.find((candidate) => candidate.id === bindingId);
  const [pending, setPending] = useState(false);
  if (!item) return null;
  const connections = Array.isArray(apiServices?.connections) ? apiServices.connections : [];
  const bindings = apiServices?.bindings && typeof apiServices.bindings === "object" ? apiServices.bindings : {};
  const available = connections.filter((connection) => item.types.includes(connection.type));
  const selectedId = item.selected(bindings);
  const selected = available.some((connection) => connection.id === selectedId) ? selectedId : "";
  const change = async (id) => {
    if (!id) return;
    setPending(true);
    try {
      await actions.selectApiBinding?.(item.id, id);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="capability-api-binding-react">
      <div><strong>使用的 API</strong><small>{item.detail}</small></div>
      <div className="capability-api-binding-react__actions">
        <Select className="capability-api-binding-react__select capability-select-react" disabled={!available.length || pending} onChange={change} options={available.map((connection) => ({ label: connection.name, value: connection.id }))} placeholder={available.length ? "选择 API" : "还没有可用 API"} value={selected} />
        <Button onClick={actions.openApiServices} type="button" variant="secondary">管理 API</Button>
      </div>
    </div>
  );
}

function ContactDeliverySettings({ actions, capability, description, contactsSnapshot, emptyDescription = "先在对话中创建联系人，再回来选择要接收这项能力的对象。" }) {
  const settings = savedSettings(capability);
  const contacts = Array.isArray(contactsSnapshot?.contacts) ? contactsSnapshot.contacts : [];
  const enabledContacts = new Set(Array.isArray(settings.enabledContactIds) ? settings.enabledContactIds : []);
  return (
    <SettingSurface className="capability-contact-delivery-settings" description={description} eyebrow="联系人范围" title="在哪些联系人中启用">
      {contacts.length ? (
        <div className="capability-session-list">
          {contacts.map((contact) => {
            const active = enabledContacts.has(contact.id);
            return (
              <AsyncSwitchRow
                checked={active}
                key={contact.id}
                label={contact.name || "未命名联系人"}
                onChange={(contactEnabled) => actions.setContactEnabled?.(capability.id, contact.id, contactEnabled)}
              />
            );
          })}
        </div>
      ) : <Empty className="capability-inline-empty" description={emptyDescription} title="还没有联系人" />}
    </SettingSurface>
  );
}

function voiceChoiceLabel(contact, choices) {
  if (!contact?.voiceId) return "尚未配置";
  const choice = choices.find((item) => (
    item.provider === contact.provider
    && item.voiceId === contact.voiceId
    && (!item.id || item.id === contact.customVoiceId)
  ));
  return choice?.name || (contact.provider === "minimax" ? "MiniMax 自定义音频" : contact.provider === "cosyvoice" ? "阿里百炼 CosyVoice 复刻音色" : "已保存的百炼音色");
}

function SettingsDialogHeader({ children, onClose, title }) {
  return <header className="create-settings-dialog__header"><div><span className="reference-kicker">{children}</span><h2>{title}</h2></div><button aria-label={`关闭${title}`} className="create-settings-close suzu-close-button" onClick={onClose} type="button"><span aria-hidden="true">×</span></button></header>;
}

function VoiceContactConfigDialog({ onClose, open, voiceDesign }) {
  const [snapshot, setSnapshot] = useState(null);
  const [selectedContactId, setSelectedContactId] = useState("");
  const [feedback, setFeedback] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setSelectedContactId("");
      setFeedback("");
      return undefined;
    }
    if (typeof voiceDesign?.snapshot !== "function") {
      setSnapshot(null);
      setFeedback("当前无法读取联系人音色。");
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setFeedback("");
    void (async () => {
      try {
        const next = await voiceDesign.snapshot();
        if (!cancelled) setSnapshot(next || null);
      } catch (error) {
        if (!cancelled) setFeedback(error?.message || "读取联系人音色失败。");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, voiceDesign]);

  const contacts = Array.isArray(snapshot?.contacts) ? snapshot.contacts : [];
  const choices = Array.isArray(snapshot?.assignableVoices) ? snapshot.assignableVoices : [];
  const contact = contacts.find((item) => item.id === selectedContactId) || null;
  const close = () => { if (!saving) onClose?.(); };
  const save = async (event) => {
    event.preventDefault();
    if (!contact || saving || typeof voiceDesign?.saveContactVoice !== "function") return;
    const key = new FormData(event.currentTarget).get("voiceSelection");
    const choice = choices.find((item) => item.key === key);
    if (!choice?.voiceId || !choice.provider) return;
    setSaving(true);
    setFeedback(`正在为“${contact.name}”保存音色…`);
    try {
      const next = await voiceDesign.saveContactVoice({
        contactId: contact.id,
        customVoiceId: choice.id || "",
        provider: choice.provider,
        sourceCandidateId: choice.sourceCandidateId || "",
        sourceContactId: choice.sourceContactId || "",
        voiceId: choice.voiceId,
      });
      if (next?.status) setSnapshot(next);
      onClose?.();
    } catch (error) {
      setFeedback(error?.message || "配置联系人音色失败，请稍后重试。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <CreateStudioDialog ariaLabel="配置联系人音色" onClose={close} open={open}>
      {!selectedContactId ? <>
        <SettingsDialogHeader onClose={close} title="配置联系人音色">联系人</SettingsDialogHeader>
        <div className="voice-settings-copy"><p>选择一位联系人，再为他或她设置保存过的音色。每个人的设置互不影响。</p></div>
        {feedback ? <div className="voice-settings-copy"><p>{feedback}</p></div> : null}
        {loading ? <div className="voice-history-empty voice-contact-empty">正在读取可用音色…</div> : contacts.length ? <div className="voice-contact-list">{contacts.map((item) => <article className="voice-contact-row" key={item.id}><div><strong>{item.name}</strong><small>{voiceChoiceLabel(item, choices)}</small></div><button className="secondary-button" onClick={() => setSelectedContactId(item.id)} type="button">配置音色</button></article>)}</div> : <div className="voice-history-empty voice-contact-empty">还没有联系人。请先在“关系”中创建联系人。</div>}
        <div className="voice-form-actions voice-contact-dialog-actions"><button className="secondary-button" onClick={close} type="button">关闭</button></div>
      </> : contact ? <>
        <SettingsDialogHeader onClose={close} title={`为“${contact.name}”配置音色`}>联系人</SettingsDialogHeader>
        <div className="voice-settings-copy"><p>{`这里列出已保留的百炼音色，以及本机音色库中的 MiniMax 和阿里百炼复刻音色；保存后只影响“${contact.name}”。`}</p></div>
        {feedback ? <div className="voice-settings-copy"><p>{feedback}</p></div> : null}
        {choices.length ? <form className="voice-form voice-contact-config-form" onSubmit={save}><div className="voice-contact-choice-list">{choices.map((item) => { const selected = item.id ? contact.provider === item.provider && item.id === contact.customVoiceId && item.voiceId === contact.voiceId : contact.provider === item.provider && item.voiceId === contact.voiceId; return <label className="voice-contact-choice" key={item.key}><input defaultChecked={selected} name="voiceSelection" required type="radio" value={item.key} /><span><strong>{item.name}</strong><small>{selected ? `${contact.name}正在使用` : item.kindLabel}</small></span></label>; })}</div><div className="voice-form-actions"><button className="secondary-button" disabled={saving} onClick={() => setSelectedContactId("")} type="button">返回联系人列表</button><button className="primary-button" disabled={saving}>{saving ? "正在保存…" : "使用这个音色"}</button></div></form> : <><div className="voice-history-empty voice-contact-empty">先在创作 → 音色设计中保留一个候选音色，或添加 MiniMax、阿里百炼复刻声音。</div><div className="voice-form-actions voice-contact-dialog-actions"><button className="secondary-button" onClick={() => setSelectedContactId("")} type="button">返回联系人列表</button></div></>}
      </> : null}
    </CreateStudioDialog>
  );
}

function CapabilityHeaderToggle({ actions, capability }) {
  const enabled = capability.enabled === true;
  const disabled = capability.canToggle !== true;
  const [pending, setPending] = useState(false);
  const label = (enabled ? "关闭" : "开启") + capability.name;
  const toggle = async (event) => {
    setPending(true);
    try {
      await actions.setCapabilityActive?.(capability.id, event.target.checked);
    } finally {
      setPending(false);
    }
  };
  return (
    <Switch
      aria-label={label}
      checked={enabled}
      disabled={disabled || pending}
      onChange={toggle}
      title={disabled ? capability.toggleReason || capability.addReason || "当前无法切换" : label}
    />
  );
}

function CapabilityEntryCard({ capability, onOpen }) {
  const enabled = capability.enabled === true;
  return (
    <GlassPanel as="article" className="capability-entry-react-card" intensity="soft">
      <button aria-label={"打开" + capability.name + "设置"} className="capability-entry-react-card__action" onClick={onOpen} type="button">
        <div className="capability-entry-react-card__top"><Status label={enabled ? "已开启" : "未开启"} tone={enabled ? "success" : "muted"} /></div>
        <div><h2>{capability.name}</h2><p>{capability.description}</p></div>
        <span>查看与设置</span>
      </button>
    </GlassPanel>
  );
}

export function CapabilityCategoryPage({ actions = {}, capabilitySnapshot, categoryId, wechatSnapshot }) {
  const category = categoryFor(categoryId);
  const builtIn = Array.isArray(capabilitySnapshot?.capabilities) ? capabilitySnapshot.capabilities : [];
  const wechat = capabilitySnapshot ? [createWechatConnectionCapability(wechatSnapshot)] : [];
  const members = [...builtIn, ...wechat].filter((capability) => capabilityCategory(capability) === category.id);
  return (
    <div className="capabilities-react-page capabilities-react-page--inner">
      <PageHeader
        action={<Button onClick={actions.returnToOverview} type="button" variant="secondary">返回能力</Button>}
        eyebrow={"CAPABILITIES / " + category.label.toUpperCase()}
        subtitle={category.detail}
        title={category.label}
      />
      <section aria-label={category.label + "能力"} className="capability-entry-react-grid">
        {members.map((capability) => (
          <CapabilityEntryCard
            capability={capability}
            key={capability.id}
            onOpen={() => actions.openDetail?.(category.id, capability.id)}
          />
        ))}
      </section>
    </div>
  );
}

function ImageGenerationSettings({ actions, apiServices, capability, contactsSnapshot }) {
  const settings = savedSettings(capability);
  const comfy = settings.comfyui || {};
  return (
    <>
    <CapabilitySettingsForm abilityId="image-generation" actions={actions}>
      <SettingSurface description="云端 API 适合日常使用；本机绘画只在你本机运行 ComfyUI 时启用。" eyebrow="图片生成" title="出图方式">
        <FormGrid>
          <FormField label="默认方式"><ChoiceSelect name="defaultBackend" options={[["api", "云端 API"], ["comfyui", "本机 ComfyUI"]]} value={settings.defaultBackend || "api"} /></FormField>
          <ApiBinding actions={actions} apiServices={apiServices} bindingId="image-generation" />
        </FormGrid>
      </SettingSurface>
      <SettingSurface description="只在默认方式选择本机 ComfyUI 时调整。" eyebrow="本机绘画" title="ComfyUI 设置">
        <FormGrid>
          <FormField className="capability-form-field--wide" label="ComfyUI 地址"><input defaultValue={comfy.baseUrl || "http://127.0.0.1:8188"} maxLength="500" name="comfyBaseUrl" /></FormField>
          <FormField label="最长等待（秒）"><input defaultValue={comfy.timeoutSeconds ?? 600} max="600" min="1" name="comfyTimeoutSeconds" type="number" /></FormField>
          <FormField label="进度间隔（秒）"><input defaultValue={comfy.pollIntervalSeconds ?? 1} max="30" min="0.1" name="comfyPollIntervalSeconds" step="0.1" type="number" /></FormField>
          <FormField className="capability-form-field--wide" label="默认工作流（可选）"><input defaultValue={comfy.defaultWorkflow || ""} maxLength="200" name="comfyDefaultWorkflow" placeholder="留空时由任务自行选择" /></FormField>
        </FormGrid>
      </SettingSurface>
    </CapabilitySettingsForm>
      <ContactDeliverySettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} description="打开后，只向该联系人的 Claude 项目登记图像生成 Skill。关闭不会删除全局出图设置或已有图片。" emptyDescription="先创建联系人，再选择允许哪些联系人使用图像生成。" />
    </>
  );
}

function PhoneCameraSettings({ actions, apiServices, capability, contactsSnapshot }) {
  const settings = savedSettings(capability);
  const sizes = settings.sizeByShot || {};
  const references = settings.references || {};
  const prompt = settings.prompt || {};
  return (
    <>
    <CapabilitySettingsForm abilityId="phone-camera" actions={actions}>
      <SettingSurface description="这些偏好会附在已有拍摄规则上，不会替换后置、自拍或镜前的基础画面逻辑。" eyebrow="手机拍照式图片" title="画面偏好">
        <FormGrid>
          <FormField label="默认方式"><ChoiceSelect name="defaultBackend" options={[["api", "云端 API"], ["comfyui", "本机 ComfyUI"]]} value={settings.defaultBackend || "api"} /></FormField>
          <ApiBinding actions={actions} apiServices={apiServices} bindingId="image-generation" />
          <FormField label="后置画面尺寸"><input defaultValue={sizes.rear || "1536x1024"} maxLength="20" name="rearSize" placeholder="1536x1024" /></FormField>
          <FormField label="自拍画面尺寸"><input defaultValue={sizes.selfie || "1024x1536"} maxLength="20" name="selfieSize" placeholder="1024x1536" /></FormField>
          <FormField label="镜前画面尺寸"><input defaultValue={sizes.mirror || "1024x1536"} maxLength="20" name="mirrorSize" placeholder="1024x1536" /></FormField>
          <FormField label="最多参考图"><input defaultValue={references.maxImages ?? 8} max="16" min="1" name="maxImages" type="number" /></FormField>
          <FormField className="capability-form-field--wide" label="画面前置提示"><textarea defaultValue={prompt.prefix || ""} maxLength="12000" name="promptPrefix" placeholder="例如：人物保持自然生活感，避免精致棚拍。" /></FormField>
          <FormField className="capability-form-field--wide" label="画面补充提示"><textarea defaultValue={prompt.suffix || ""} maxLength="12000" name="promptSuffix" placeholder="例如：服装与环境以当前视觉参考为准。" /></FormField>
        </FormGrid>
      </SettingSurface>
    </CapabilitySettingsForm>
      <ContactDeliverySettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} description="打开后，只向该联系人的 Claude 项目登记手机拍照式生图 Skill。关闭不会删除全局画面偏好或已有图片。" emptyDescription="先创建联系人，再选择允许哪些联系人使用手机拍照式生图。" />
    </>
  );
}

function VoiceMessageSettings({ actions, apiServices, capability, contactsSnapshot }) {
  const [voiceDialogOpen, setVoiceDialogOpen] = useState(false);
  return (
    <>
    <SettingSurface description="API 用于文字转语音；每位联系人的音色和允许范围都单独保存。" eyebrow="声音" title="发送语音">
        <FormGrid>
          <ApiBinding actions={actions} apiServices={apiServices} bindingId="sound" />
        </FormGrid>
        <div className="capability-inline-action-react"><div><strong>为联系人配置音色</strong><p>直接在这里选择联系人和已保存的声音。</p></div><Button onClick={() => setVoiceDialogOpen(true)} type="button" variant="secondary">配置联系人音色</Button></div>
    </SettingSurface>
      <ContactDeliverySettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} description="打开后，只向该联系人的 Claude 项目登记发送语音 Skill。关闭不会删除该联系人的音色设置。" emptyDescription="先创建联系人，再选择允许哪些联系人使用语音消息。" />
      <VoiceContactConfigDialog onClose={() => setVoiceDialogOpen(false)} open={voiceDialogOpen} voiceDesign={actions.voiceDesign} />
    </>
  );
}

function ImageVisionSettings({ actions, apiServices, capability, contactsSnapshot }) {
  const settings = savedSettings(capability);
  const provider = settings.provider || {};
  const vision = settings.vision || {};
  return (
    <>
      <CapabilitySettingsForm abilityId="image-vision" actions={actions}>
        <SettingSurface description="选择用于图片理解的 API，再决定需要多细地读取图片。" eyebrow="理解图片" title="读取偏好">
          <FormGrid>
            <ApiBinding actions={actions} apiServices={apiServices} bindingId="image-vision" />
            <FormField className="capability-form-field--wide" label="模型"><input defaultValue={provider.model || ""} maxLength="200" name="model" placeholder="从 API 服务说明中填写模型名" /></FormField>
            <FormField className="capability-form-field--wide" label="图片读取精度"><ChoiceSelect name="detail" options={[["auto", "自动"], ["low", "快速"], ["high", "细看"]]} value={vision.detail || "auto"} /></FormField>
            <FormField label="等待时间（秒）"><input defaultValue={vision.timeoutSeconds ?? 90} max="600" min="5" name="timeoutSeconds" type="number" /></FormField>
            <FormField label="最长回复（tokens）"><input defaultValue={vision.maxOutputTokens ?? 800} max="32000" min="32" name="maxOutputTokens" type="number" /></FormField>
          </FormGrid>
        </SettingSurface>
        <SettingSurface description="只有图片过大或细节不足时才需要调整。" eyebrow="图片处理" title="处理细节">
          <FormGrid>
            <FormField label="最大图片大小（字节）"><input defaultValue={vision.maxImageBytes ?? 1572864} max="26214400" min="262144" name="maxImageBytes" type="number" /></FormField>
            <FormField label="最长边（像素）"><input defaultValue={vision.maxEdge ?? 1600} max="8192" min="256" name="maxEdge" type="number" /></FormField>
            <FormField label="压缩质量"><input defaultValue={vision.jpegQuality ?? 90} max="100" min="1" name="jpegQuality" type="number" /></FormField>
            <CheckboxField defaultChecked={vision.retryOnRefusal !== false} label="遇到拒答时尝试一次兼容处理" name="retryOnRefusal" />
          </FormGrid>
        </SettingSurface>
      </CapabilitySettingsForm>
      <ContactDeliverySettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} description="打开后，只向该联系人的 Claude 项目登记图像理解 Skill。登记本身不会调用模型或产生费用；只有 Agent 实际分析图片时才会请求配置的 API。" emptyDescription="先创建联系人，再选择允许哪些联系人使用图像理解。" />
    </>
  );
}

function VideoUnderstandingSettings({ actions, apiServices, capability, contactsSnapshot }) {
  const settings = savedSettings(capability);
  const provider = settings.provider || {};
  const video = settings.video || {};
  return (
    <>
      <CapabilitySettingsForm abilityId="video-understanding" actions={actions}>
        <SettingSurface description="选择视频理解的 API，并设置每秒取样的画面数量。" eyebrow="理解视频" title="读取偏好">
          <FormGrid>
            <ApiBinding actions={actions} apiServices={apiServices} bindingId="video-understanding" />
            <FormField className="capability-form-field--wide" label="模型"><input defaultValue={provider.model || ""} maxLength="200" name="model" placeholder="从 API 服务说明中填写模型名" /></FormField>
            <FormField className="capability-form-field--wide" label="取样速度"><ChoiceSelect name="fps" options={[["0.5", "节省：每 2 秒 1 帧"], ["1", "平衡：每秒 1 帧"], ["2", "细看：每秒 2 帧"]]} value={String(video.fps ?? 1)} /></FormField>
            <CheckboxField defaultChecked={video.cacheEnabled !== false} label="保留本地缓存，加快同一视频的再次理解" name="cacheEnabled" />
          </FormGrid>
        </SettingSurface>
        <SettingSurface description="设置处理速度、回复长度和本机工具。" eyebrow="视频处理" title="处理细节">
          <FormGrid>
            <FormField label="等待时间（秒）"><input defaultValue={video.timeoutSeconds ?? 240} max="3600" min="5" name="timeoutSeconds" type="number" /></FormField>
            <FormField label="最长回复（tokens）"><input defaultValue={video.maxOutputTokens ?? 350} max="32000" min="32" name="maxOutputTokens" type="number" /></FormField>
            <FormField label="表达随机度"><input defaultValue={video.temperature ?? 0.2} max="2" min="0" name="temperature" step="0.1" type="number" /></FormField>
            <FormField label="最大处理大小（字节）"><input defaultValue={video.maxBinaryBytes ?? 7000000} max="536870912" min="1048576" name="maxBinaryBytes" type="number" /></FormField>
            <FormField label="FFmpeg 命令"><input defaultValue={video.ffmpegPath || "ffmpeg"} maxLength="300" name="ffmpegPath" /></FormField>
            <FormField label="FFprobe 命令"><input defaultValue={video.ffprobePath || "ffprobe"} maxLength="300" name="ffprobePath" /></FormField>
          </FormGrid>
        </SettingSurface>
      </CapabilitySettingsForm>
      <ContactDeliverySettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} description="打开后，只向该联系人的 Claude 项目登记视频理解 Skill。登记本身不会调用模型或产生费用；只有 Agent 实际分析视频时才会请求配置的 API。" emptyDescription="先创建联系人，再选择允许哪些联系人使用视频理解。" />
    </>
  );
}

function TimeAwarenessSettings({ actions, capability, contactsSnapshot }) {
  const settings = savedSettings(capability);
  return (
    <>
      <CapabilitySettingsForm abilityId="time-awareness" actions={actions}>
        <SettingSurface description="同一 Claude 会话超过这个间隔后，才会将新的本机时间作为本轮额外上下文注入。" eyebrow="时间间隔" title="多久感知一次">
          <FormGrid>
            <FormField hint="默认 10 分钟；可设为 1 到 1440 分钟。" label="间隔（分钟）"><input defaultValue={settings.intervalMinutes ?? 10} max="1440" min="1" name="intervalMinutes" type="number" /></FormField>
          </FormGrid>
        </SettingSurface>
      </CapabilitySettingsForm>
      <ContactDeliverySettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} description="打开后，Suzu 会在该联系人的 Claude 项目中安装时间 Hook；关闭时只移除这一位联系人的 Hook。" emptyDescription="先创建联系人，再选择在哪些联系人中启用时间感知。" />
    </>
  );
}

function SiteAutomationOverview({ actions, capability, contactsSnapshot }) {
  const settings = savedSettings(capability);
  const sites = Array.isArray(settings.sites) ? settings.sites : [];
  const configuration = settings.configuration || {};
  return (
    <>
      <SettingSurface description="每个网站单独管理，所有联系人共用这套设置。新增网站后会自动出现在这里，不需要再造一套能力页面。" eyebrow="网页自动化" title="已接入的网站">
        {sites.length ? <div className="capability-site-grid">{sites.map((site) => {
          const enabledActions = (site.actions || []).filter((action) => action.enabled !== false).length;
          return <button className="capability-site-card" key={site.id} onClick={() => actions.openSite?.(site.id)} type="button"><Status label={site.enabled !== false ? "已启用" : "已关闭"} tone={site.enabled !== false ? "success" : "muted"} /><strong>{site.name}</strong><span>{enabledActions + " / " + (site.actions || []).length + " 个动作可用"}</span></button>;
        })}</div> : <Empty className="capability-inline-empty" description="接入新的站点适配器后，它会出现在这里。" title="还没有接入网站" />}
      </SettingSurface>
      <CapabilitySettingsForm abilityId="site-automation" actions={actions}>
        <SettingSurface description="网页浏览和各网站动作共用 Suzu Lives 的专用浏览器；登录状态不会显示在这里。" eyebrow="网页自动化" title="浏览器与连接">
          <FormGrid>
            <FormField className="capability-form-field--wide" label="浏览器连接地址"><input defaultValue={configuration.cdpUrl || "http://127.0.0.1:9222"} maxLength="500" name="cdpUrl" /></FormField>
            <FormField label="页面操作等待（毫秒）"><input defaultValue={configuration.timeoutMs ?? 10000} max="120000" min="1000" name="timeoutMs" type="number" /></FormField>
            <FormField label="打开页面等待（毫秒）"><input defaultValue={configuration.navigationTimeoutMs ?? 25000} max="180000" min="1000" name="navigationTimeoutMs" type="number" /></FormField>
            <CheckboxField defaultChecked={configuration.autoStartBrowser !== false} label="需要时启动专用浏览器" name="autoStartBrowser" />
            <FormField className="capability-form-field--wide" label="Python 命令"><input defaultValue={configuration.pythonCommand || "python"} maxLength="300" name="pythonCommand" /></FormField>
          </FormGrid>
        </SettingSurface>
      </CapabilitySettingsForm>
      <ContactDeliverySettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} description="打开后，才向这位联系人的 Claude 项目登记网页自动化 Skill。关闭后，该联系人不能再使用专用浏览器或已接入的网站动作；浏览器登录状态和网站动作设置会保留。" emptyDescription="先创建联系人，再选择允许哪些联系人使用网页自动化。" />
    </>
  );
}

function actionGroups(site) {
  const groups = new Map();
  for (const action of site.actions || []) {
    const group = action.group || "其他";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(action);
  }
  return [...groups.entries()];
}

function SiteAutomationSiteSettings({ actions, site }) {
  return (
    <section className="capability-site-detail">
      <SettingSurface description={"关闭网站后，" + site.name + " 的所有动作都会停止；单个动作的开关会保留，重新启用网站时继续生效。"} eyebrow="网页自动化 / 已接入网站" title={site.name}>
        <AsyncSwitchRow checked={site.enabled !== false} label={site.enabled !== false ? "网站已启用" : "网站已关闭"} onChange={(siteEnabled) => actions.setSiteEnabled?.(site.id, siteEnabled)} />
      </SettingSurface>
      <SettingSurface description="每一项都会在真实的站点适配器入口处校验；关闭后，Agent 直接调用也会被拒绝。" eyebrow="动作节点" title={"允许 " + site.name + " 做什么"}>
        <div className="capability-site-action-groups">
          {actionGroups(site).map(([group, items]) => (
            <section className="capability-site-action-group" key={group}>
              <h3>{group}</h3>
              {items.map((action) => <AsyncSwitchRow checked={action.enabled !== false} description={action.description || ""} key={action.id} label={action.label || action.id} onChange={(actionEnabled) => actions.setSiteAction?.(site.id, action.id, actionEnabled)} />)}
            </section>
          ))}
        </div>
      </SettingSurface>
    </section>
  );
}

function ProactiveContactSettings({ actions, capability, contactsSnapshot }) {
  const settings = savedSettings(capability);
  const autoMaintain = settings.autoMaintain !== false;
  return (
    <>
      <CapabilitySettingsForm abilityId="proactive-contact" actions={actions}>
        {({ submitButton }) => (
          <SettingSurface action={submitButton} description="A 只判断要不要联系；它结束后，软件会交给 B 让 Agent 自己安排下一次 A。可以按你的相处方式修改判断提示词。" eyebrow="主动关心" title="触发提示词">
            <AsyncSwitchRow
              checked={capability.enabled === true && autoMaintain}
              description="软件启动或开启联系人时会补上第一条 A；之后由 A → B → 下一条 A 自己闭环。"
              disabled={capability.enabled !== true}
              label="自动链式唤醒"
              onChange={(enabled) => actions.saveSettings?.("proactive-contact", { autoMaintain: enabled })}
            />
            <FormGrid>
              <FormField className="capability-form-field--wide" label="A · 是否主动联系提示词"><textarea defaultValue={settings.chainPrompt || ""} maxLength="12000" name="chainPrompt" /></FormField>
              <FormField className="capability-form-field--wide" label="临时回访提示词"><textarea defaultValue={settings.followUpPrompt || ""} maxLength="12000" name="followUpPrompt" /></FormField>
            </FormGrid>
          </SettingSurface>
        )}
      </CapabilitySettingsForm>
      <ContactDeliverySettings actions={actions} capability={capability} description="打开后，对应联系人的定时任务才会触发；可以同时开启多个联系人。" contactsSnapshot={contactsSnapshot} />
    </>
  );
}

function TravelingMerchantSettings({ actions, capability, contactsSnapshot }) {
  const settings = savedSettings(capability);
  const items = Array.isArray(settings.wantedItems) ? settings.wantedItems.join("\n") : "";
  return (
    <>
      <CapabilitySettingsForm abilityId="traveling-merchant" actions={actions}>
        <SettingSurface description="输入想买的物品；检测到其中任意一项时，会按你的通知文案提醒。" eyebrow="远行商人" title="关注与提醒">
          <FormGrid>
            <FormField className="capability-form-field--wide" label="关注的物品"><textarea defaultValue={items} maxLength="8000" name="wantedItems" placeholder={"棱镜球\n炫彩蛋"} /></FormField>
            <FormField className="capability-form-field--wide" label="发现物品时的提醒"><input defaultValue={settings.notificationTemplate || "远行商人这轮有：{items}，快去买"} maxLength="1200" name="notificationTemplate" /></FormField>
            <CheckboxField defaultChecked={settings.notifyOnError !== false} label="检查失败时也提醒我" name="notifyOnError" />
            <FormField className="capability-form-field--wide" label="失败提醒"><input defaultValue={settings.errorNotificationTemplate || "远行商人监控这轮检查失败了：{error}"} maxLength="1200" name="errorNotificationTemplate" /></FormField>
          </FormGrid>
        </SettingSurface>
        <SettingSurface description="设置读取的网址、等待时间与重试次数。" eyebrow="读取网页" title="网页与检查节奏">
          <FormGrid>
            <FormField className="capability-form-field--wide" label="页面地址"><input defaultValue={settings.url || ""} maxLength="500" name="url" /></FormField>
            <FormField label="网页等待（秒）"><input defaultValue={settings.requestTimeoutSeconds ?? 15} max="120" min="3" name="requestTimeoutSeconds" type="number" /></FormField>
            <FormField label="重试次数"><input defaultValue={settings.maxAttempts ?? 3} max="10" min="1" name="maxAttempts" type="number" /></FormField>
            <FormField label="重试间隔（秒）"><input defaultValue={settings.retryDelaySeconds ?? 20} max="300" min="0" name="retryDelaySeconds" type="number" /></FormField>
          </FormGrid>
          <div className="capability-inline-action-react"><p>需要确认时，可以直接打开正在读取的网页。</p><Button onClick={actions.openTravelingMerchantPage} type="button" variant="secondary">打开网页</Button></div>
        </SettingSurface>
      </CapabilitySettingsForm>
      <ContactDeliverySettings actions={actions} capability={capability} description="打开后，联系人会收到商人命中或已开启的失败提醒；可以同时开启多个联系人。网页只抓取一次，再分别投递。" contactsSnapshot={contactsSnapshot} />
    </>
  );
}

function IphoneBridgeConfigDialog({ actions, capability, onClose, open }) {
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const configuration = savedSettings(capability).configuration || {};
  const allowedSenders = Array.isArray(configuration.allowedSenders) ? configuration.allowedSenders.join("\n") : "";
  const close = () => { if (!saving) onClose?.(); };
  const save = async (event) => {
    event.preventDefault();
    if (saving || typeof actions.saveSettings !== "function") return;
    setSaving(true);
    setFeedback("");
    try {
      const result = await actions.saveSettings("iphone-bridge", formValue(event.currentTarget));
      if (result?.ok) onClose?.();
      else setFeedback(result?.error?.message || "邮件连接没有保存，请检查填写内容。 ");
    } catch (error) {
      setFeedback(error?.message || "邮件连接没有保存，请稍后重试。 ");
    } finally {
      setSaving(false);
    }
  };
  return (
    <CreateStudioDialog ariaLabel="配置 iPhone 邮件连接" className="iphone-bridge-config-dialog" onClose={close} open={open}>
      <SettingsDialogHeader onClose={close} title="配置 iPhone 邮件连接">iPhone 互通</SettingsDialogHeader>
      <div className="voice-settings-copy"><p>填写已在 iPhone 快捷指令中使用的收发邮箱。授权码不写进页面或配置快照：请先把它放到操作系统环境变量，再在这里填写变量名。</p></div>
      {feedback ? <div className="voice-settings-copy"><p>{feedback}</p></div> : null}
      <form className="iphone-bridge-config-form" onSubmit={save}>
        <div className="capability-form-grid-react">
          <FormField label="SMTP 服务器"><input defaultValue={configuration.smtpHost || "smtp.163.com"} maxLength="320" name="smtpHost" required /></FormField>
          <FormField label="SMTP 端口"><input defaultValue={configuration.smtpPort ?? 465} max="65535" min="1" name="smtpPort" required type="number" /></FormField>
          <FormField label="发件邮箱"><input defaultValue={configuration.sender || ""} maxLength="320" name="sender" required type="email" /></FormField>
          <FormField label="iPhone 快捷指令邮箱"><input defaultValue={configuration.recipient || ""} maxLength="320" name="recipient" required type="email" /></FormField>
          <FormField label="IMAP 服务器"><input defaultValue={configuration.imapHost || "imap.163.com"} maxLength="320" name="imapHost" required /></FormField>
          <FormField label="IMAP 端口"><input defaultValue={configuration.imapPort ?? 993} max="65535" min="1" name="imapPort" required type="number" /></FormField>
          <FormField label="反馈邮箱账号"><input defaultValue={configuration.username || ""} maxLength="320" name="username" required type="email" /></FormField>
          <FormField label="收件箱"><input defaultValue={configuration.mailbox || "INBOX"} maxLength="160" name="mailbox" required /></FormField>
          <FormField className="capability-form-field--wide" hint="每行一个地址；只有这些地址发来的反馈会交给 Agent。" label="允许的反馈发件人"><textarea defaultValue={allowedSenders} maxLength="9600" name="allowedSenders" required /></FormField>
          <FormField className="capability-form-field--wide" hint="例如 SUZU_IPHONE_MAIL_PASSWORD。实际授权码只由本机进程从这个环境变量读取。" label="邮箱授权码环境变量"><input defaultValue={configuration.passwordEnv || "SUZU_IPHONE_MAIL_PASSWORD"} maxLength="128" name="passwordEnv" required /></FormField>
          <FormField label="反馈邮件主题"><input defaultValue={configuration.feedbackSubject || "查岗"} maxLength="200" name="feedbackSubject" required /></FormField>
          <FormField className="capability-form-field--wide" hint="可用变量：{{content}}、{{subject}}、{{from}}、{{receivedAt}}、{{attachments}}。" label="交给 Agent 的反馈提示词"><textarea defaultValue={configuration.feedbackPrompt || "这是来自 iPhone 的反馈（{{subject}}，来自 {{from}}，{{receivedAt}}）：\n{{content}}\n{{attachments}}"} maxLength="12000" name="feedbackPrompt" required /></FormField>
        </div>
        <footer className="iphone-bridge-config-form__actions"><Button disabled={saving} onClick={close} type="button" variant="secondary">取消</Button><Button disabled={saving} type="submit">{saving ? "正在保存…" : "保存邮件连接"}</Button></footer>
      </form>
    </CreateStudioDialog>
  );
}

function IphoneBridgeSettings({ actions, capability, contactsSnapshot }) {
  const [configOpen, setConfigOpen] = useState(false);
  const settings = savedSettings(capability);
  const status = settings.saved
    ? "全局邮件连接参数已保存。软件运行时会读取授权码环境变量，并把反馈直接投递到下方勾选的联系人。"
    : "先配置全局邮件连接，再选择要接收 iPhone 反馈的联系人。";
  return (
    <>
      <SettingSurface action={<Button onClick={() => setConfigOpen(true)} type="button" variant="secondary">配置邮件连接</Button>} description={status} eyebrow="iPhone 反馈" title="本地直接接收" />
      <ContactDeliverySettings actions={actions} capability={capability} description="可以同时勾选多个联系人；打开后会向该联系人的 Claude 项目登记 iPhone Skill，一封手机反馈也会分别排进所有已勾选联系人的对话。" contactsSnapshot={contactsSnapshot} />
      <IphoneBridgeConfigDialog actions={actions} capability={capability} onClose={() => setConfigOpen(false)} open={configOpen} />
    </>
  );
}

function WechatSettings({ actions, wechatSnapshot }) {
  const settings = wechatConnectionSettings(wechatSnapshot);
  const status = settings.enabled
    ? "软件正在维护已绑定会话的微信长连接；每个聊天可在“··· → 设置”里扫码或断开。"
    : "关闭后会停止所有微信收发，但不会删除已绑定会话；再次开启即可恢复。";
  return (
    <section className="capability-settings-stack">
      <SettingSurface description={status} eyebrow="行动 / 软件连接" title="连接微信">
        <AsyncSwitchRow checked={settings.enabled} label={settings.enabled ? "微信连接已开启" : "微信连接已关闭"} onChange={(enabled) => actions.saveWechatSettings?.({ enabled })} />
      </SettingSurface>
      <SettingSurface description="这组设置独立于聊天页面的显示设置。默认发送 Agent 的最终回复和审批提示；收到提示后可在微信回复“允许”或“拒绝”。" eyebrow="DELIVERY" title="投递到微信的内容">
        <div className="capability-delivery-grid">
          {WECHAT_DELIVERY_OPTIONS.map(([key, label, description]) => <AsyncSwitchRow checked={settings.delivery[key] === true} description={description} key={key} label={label} onChange={(enabled) => actions.saveWechatSettings?.({ delivery: { ...settings.delivery, [key]: enabled } })} />)}
        </div>
      </SettingSurface>
      <SettingSurface description={"已有 " + settings.linkedContacts.toLocaleString("zh-CN") + " 位联系人连接。每个二维码只路由到生成它的联系人固定对话，可以用不同微信号绑定不同联系人。"} eyebrow="SCOPE" title="按联系人绑定" />
    </section>
  );
}

function GenericCapabilitySettings() {
  return <SettingSurface description="当前没有需要单独调整的选项。" eyebrow="能力资料" title="这项能力已准备好" />;
}

function CapabilitySettings({ actions, apiServices, capability, contactsSnapshot, siteId, wechatSnapshot }) {
  if (capability.id === "wechat-connection") return <WechatSettings actions={actions} wechatSnapshot={wechatSnapshot} />;
  if (capability.id === "image-generation") return <ImageGenerationSettings actions={actions} apiServices={apiServices} capability={capability} contactsSnapshot={contactsSnapshot} />;
  if (capability.id === "phone-camera") return <PhoneCameraSettings actions={actions} apiServices={apiServices} capability={capability} contactsSnapshot={contactsSnapshot} />;
  if (capability.id === "voice-message") return <VoiceMessageSettings actions={actions} apiServices={apiServices} capability={capability} contactsSnapshot={contactsSnapshot} />;
  if (capability.id === "time-awareness") return <TimeAwarenessSettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} />;
  if (capability.id === "image-vision") return <ImageVisionSettings actions={actions} apiServices={apiServices} capability={capability} contactsSnapshot={contactsSnapshot} />;
  if (capability.id === "video-understanding") return <VideoUnderstandingSettings actions={actions} apiServices={apiServices} capability={capability} contactsSnapshot={contactsSnapshot} />;
  if (capability.id === "site-automation") {
    const site = capabilitySites(capability).find((item) => item.id === siteId);
    return site ? <SiteAutomationSiteSettings actions={actions} site={site} /> : <SiteAutomationOverview actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} />;
  }
  if (capability.id === "iphone-bridge") return <IphoneBridgeSettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} />;
  if (capability.id === "proactive-contact") return <ProactiveContactSettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} />;
  if (capability.id === "traveling-merchant") return <TravelingMerchantSettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} />;
  return <GenericCapabilitySettings />;
}

export function CapabilityDetailPage({
  actions = {},
  apiServices,
  capability,
  categoryId,
  contactsSnapshot,
  siteId,
  wechatSnapshot,
}) {
  const category = categoryFor(categoryId);
  const selectedSite = capability.id === "site-automation"
    ? capabilitySites(capability).find((site) => site.id === siteId)
    : null;
  const title = selectedSite?.name || capability.name;
  const subtitle = selectedSite
    ? "设置这个网站允许 Agent 使用的动作。"
    : capability.description;
  const back = selectedSite
    ? <Button onClick={actions.returnToSites} type="button" variant="secondary">返回网页自动化</Button>
    : <Button onClick={() => actions.returnToCategory?.(category.id)} type="button" variant="secondary">返回{category.label}</Button>;
  const detailAction = selectedSite
    ? back
    : CONTACT_SCOPED_CAPABILITY_IDS.has(capability.id)
      ? back
    : <div className="capability-detail-header-actions"><CapabilityHeaderToggle actions={actions} capability={capability} />{back}</div>;
  if (capability.id === "wechat-connection") {
    return (
      <div className="capabilities-react-page capabilities-react-page--inner">
        <PageHeader action={back} eyebrow="CAPABILITIES / 行动" subtitle={subtitle} title={title} />
        <WechatSettings actions={actions} wechatSnapshot={wechatSnapshot} />
      </div>
    );
  }
  return (
    <div className="capabilities-react-page capabilities-react-page--inner">
      <PageHeader action={detailAction} eyebrow={"CAPABILITIES / " + category.label} subtitle={subtitle} title={title} />
      <CapabilitySettings actions={actions} apiServices={apiServices} capability={capability} contactsSnapshot={contactsSnapshot} siteId={siteId} wechatSnapshot={wechatSnapshot} />
    </div>
  );
}

function ExternalCapabilityCard({ actions, capability, onRemove }) {
  const [label, tone] = externalStatus(capability);
  const types = Array.isArray(capability.types) ? capability.types : [];
  const diagnostics = Array.isArray(capability.diagnostics) ? capability.diagnostics : [];
  const source = capability.source || {};
  return (
    <GlassPanel as="article" className="external-capability-card" intensity="soft">
      <header className="external-capability-card__header">
        <div><span>EXTERNAL / {types.map(externalTypeLabel).join(" + ") || "CAPABILITY"}</span><h2>{capability.name || capability.id}</h2><p>{capability.description || "没有提供能力说明。"}</p></div>
        <Status label={label} tone={tone} />
      </header>
      <div className="external-capability-card__facts">
        <div><span>版本</span><strong>{capability.version || "—"}</strong></div>
        <div><span>本地来源</span><strong>{source.manifestPath || "来源路径不可用"}</strong></div>
      </div>
      <div className="external-capability-card__host">
        <div><strong>Claude Code 项目登记</strong><p>{capability.enabled ? "Skill 和 MCP 的受管条目已写入当前项目；Claude Code 仍会按自己的批准流程决定何时连接或运行。" : "启用只会安全写入当前项目的受管 Skill/MCP 配置。"}</p></div>
        <div className="external-capability-card__actions">
          <Button disabled={capability.canEnable !== true} onClick={() => actions.setExternalEnabled?.(capability.id, true)} type="button" variant="secondary">{capability.enabled ? "再次启用以更新登记" : "启用并登记"}</Button>
          <Button disabled={capability.canDisable !== true} onClick={() => actions.setExternalEnabled?.(capability.id, false)} type="button" variant="secondary">停用</Button>
          <Button onClick={() => onRemove(capability)} type="button" variant="danger">移除</Button>
        </div>
      </div>
      {diagnostics.length ? <section className="external-capability-card__diagnostics"><h3>静态检查</h3><ul>{diagnostics.map((diagnostic, index) => <li key={diagnostic.code || diagnostic.message || index}>{diagnostic.message || diagnostic.code || "未知诊断"}</li>)}</ul></section> : null}
    </GlassPanel>
  );
}

export function ExternalCapabilitiesPage({ actions = {}, externalSnapshot }) {
  const [removing, setRemoving] = useState(null);
  const [removingPending, setRemovingPending] = useState(false);
  const [importing, setImporting] = useState(false);
  const snapshot = externalSnapshot || { projectRoot: "", capabilities: [] };
  const capabilities = Array.isArray(snapshot.capabilities) ? snapshot.capabilities : [];
  const project = String(snapshot.projectRoot || "").trim();
  const importManifest = async () => {
    setImporting(true);
    try {
      await actions.importExternal?.();
    } finally {
      setImporting(false);
    }
  };
  const remove = async () => {
    if (!removing) return;
    setRemovingPending(true);
    try {
      await actions.removeExternal?.(removing.id);
      setRemoving(null);
    } finally {
      setRemovingPending(false);
    }
  };
  return (
    <div className="capabilities-react-page capabilities-react-page--inner">
      <PageHeader action={<Button onClick={actions.returnToOverview} type="button" variant="secondary">返回能力</Button>} eyebrow="CAPABILITIES / EXTERNAL" subtitle="导入用户明确选择的本地清单。当前仅安装到所选的 Claude Code 项目。" title="外部能力" />
      <SettingSurface description={project || "仍可导入并查看清单；启用前需要先选择项目。"} eyebrow="导入" title={project ? "已选择 Claude Code 项目" : "尚未选择 Claude Code 项目"}>
        <div className="capability-inline-action-react"><p>导入只读取本地 suzu-capability.json；不会下载或运行第三方代码。</p><Button disabled={importing} onClick={importManifest} type="button" variant="secondary">{importing ? "正在导入…" : "导入 suzu-capability.json"}</Button></div>
      </SettingSurface>
      {capabilities.length ? <section className="external-capability-list">{capabilities.map((capability) => <ExternalCapabilityCard actions={actions} capability={capability} key={capability.id} onRemove={setRemoving} />)}</section> : <GlassPanel as="section" className="capability-empty-panel" intensity="soft"><Empty description="选择本地 suzu-capability.json 后，这里会显示静态诊断和所选项目中的登记状态。" title="还没有外部能力" /></GlassPanel>}
      <CreateStudioDialog ariaLabel="移除外部能力" className="capability-remove-dialog" onClose={() => setRemoving(null)} open={Boolean(removing)}>
        <header><div><span>EXTERNAL CAPABILITY</span><h2>移除外部能力？</h2></div><button aria-label="关闭" className="suzu-close-button" onClick={() => setRemoving(null)} type="button">×</button></header>
        <p>{`“${removing?.name || "这项外部能力"}”会先尝试清理所有由 Suzu Lives 登记的项目条目；任何冲突、项目缺失或手动修改都会中止并保留文件。`}</p>
        <footer><Button disabled={removingPending} onClick={() => setRemoving(null)} type="button" variant="secondary">取消</Button><Button disabled={removingPending} onClick={remove} type="button" variant="danger">{removingPending ? "正在移除…" : "移除能力"}</Button></footer>
      </CreateStudioDialog>
    </div>
  );
}
