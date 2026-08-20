import { useEffect, useState } from "react";
import { Button, Empty, GlassPanel, PageHeader, Select, Status, Switch } from "suzu-design-system";
import { TTS_ADAPTER_OPTIONS, ttsAdapterLabel } from "@suzu-lives/voice-message/tts-adapters";

import { API_BINDINGS } from "../features/agent/runtime.mjs";
import {
  CAPABILITY_CATEGORIES,
  capabilityCategory,
  createWechatConnectionCapability,
  WECHAT_DELIVERY_OPTIONS,
  wechatConnectionSettings,
} from "../features/capabilities/overview.mjs";
import { ApiConnectionPicker } from "./api-connections-ui.jsx";
import { CreateStudioDialog } from "./create-studio-dialog.jsx";

const EXTERNAL_TYPE_LABELS = Object.freeze({
  cli: "CLI（预留）",
  mcp: "MCP",
  skill: "Skill",
});
const CONTACT_SCOPED_CAPABILITY_IDS = new Set(["time-awareness", "image-vision", "video-understanding", "image-generation", "phone-camera", "voice-message", "web-browser", "mail-bridge", "agent-journal", "proactive-contact"]);

function savedSettings(capability) {
  return capability?.savedSettings && typeof capability.savedSettings === "object"
    ? capability.savedSettings
    : {};
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
  if (!item) return null;
  const connections = Array.isArray(apiServices?.connections) ? apiServices.connections : [];
  const bindings = apiServices?.bindings && typeof apiServices.bindings === "object" ? apiServices.bindings : {};
  const available = connections.filter((connection) => item.types.includes(connection.type));
  const selectedId = item.selected(bindings);
  const selected = available.some((connection) => connection.id === selectedId) ? selectedId : "";
  return (
    <div className="capability-api-binding-react">
      <div><strong>使用的 API</strong><small>{item.detail}</small></div>
      <div className="capability-api-binding-react__actions">
        <ApiConnectionPicker
          connections={available}
          detail={item.detail}
          onManage={actions.openApiServices}
          onSelect={(connectionId) => actions.selectApiBinding?.(item.id, connectionId)}
          selectedId={selected}
          title={`为${item.label}选择 API`}
        />
      </div>
    </div>
  );
}

function ContactDeliverySettings({ actions, capability, contactsSnapshot, defaultEnabled = false, description, emptyDescription = "先在对话中创建联系人，再回来选择要接收这项能力的对象。" }) {
  const settings = savedSettings(capability);
  const contacts = Array.isArray(contactsSnapshot?.contacts) ? contactsSnapshot.contacts : [];
  const enabledContacts = new Set(Array.isArray(settings.enabledContactIds) ? settings.enabledContactIds : []);
  const effectiveDescription = defaultEnabled
    ? `${description} 未配置时默认对全部联系人启用；勾选后会按选择生效。`
    : description;
  return (
    <SettingSurface className="capability-contact-delivery-settings" description={effectiveDescription} eyebrow="联系人范围" title="在哪些联系人中启用">
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
    item.adapter === contact.adapter
    && item.voiceId === contact.voiceId
    && (!item.id || item.id === contact.customVoiceId)
  ));
  return choice?.name || ttsAdapterLabel(contact?.adapter || "dashscope-qwen");
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
    if (!choice?.voiceId || !choice.adapter) return;
    setSaving(true);
    setFeedback(`正在为“${contact.name}”保存音色…`);
    try {
      const next = await voiceDesign.saveContactVoice({
        contactId: contact.id,
        customVoiceId: choice.id || "",
        adapter: choice.adapter,
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
        <div className="voice-settings-copy"><p>{`这里列出已保存的音色；保存后只影响“${contact.name}”。`}</p></div>
        {feedback ? <div className="voice-settings-copy"><p>{feedback}</p></div> : null}
        {choices.length ? <form className="voice-form voice-contact-config-form" onSubmit={save}><div className="voice-contact-choice-list">{choices.map((item) => { const selected = item.id ? contact.adapter === item.adapter && item.id === contact.customVoiceId && item.voiceId === contact.voiceId : contact.adapter === item.adapter && item.voiceId === contact.voiceId; return <label className="voice-contact-choice" key={item.key}><input defaultChecked={selected} name="voiceSelection" required type="radio" value={item.key} /><span><strong>{item.name}</strong><small>{selected ? `${contact.name}正在使用` : item.kindLabel}</small></span></label>; })}</div><div className="voice-form-actions"><button className="secondary-button" disabled={saving} onClick={() => setSelectedContactId("")} type="button">返回联系人列表</button><button className="primary-button" disabled={saving}>{saving ? "正在保存…" : "使用这个音色"}</button></div></form> : <><div className="voice-history-empty voice-contact-empty">还没有可用音色。请先在“语音消息”设置中新增一个音色。</div><div className="voice-form-actions voice-contact-dialog-actions"><button className="secondary-button" onClick={() => setSelectedContactId("")} type="button">返回联系人列表</button></div></>}
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
      <ContactDeliverySettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} description="所选联系人会通过 Suzu Agent Core 使用这套生图设置。" emptyDescription="先创建联系人，再选择允许哪些联系人使用图像生成。" />
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
      <ContactDeliverySettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} description="所选联系人会通过 Suzu Agent Core 使用这套画面偏好。" emptyDescription="先创建联系人，再选择允许哪些联系人使用手机拍照式生图。" />
    </>
  );
}

function VoiceMessageSettings({ actions, apiServices, capability, contactsSnapshot }) {
  const [voiceDialogOpen, setVoiceDialogOpen] = useState(false);
  const [voiceCreateOpen, setVoiceCreateOpen] = useState(false);
  const [voiceSnapshot, setVoiceSnapshot] = useState(null);
  const [voiceError, setVoiceError] = useState("");
  const [customAdapter, setCustomAdapter] = useState("openai-speech");
  const [savingCustomAudio, setSavingCustomAudio] = useState(false);
  const [deletingVoiceId, setDeletingVoiceId] = useState("");

  useEffect(() => { void refreshVoice(); }, []);
  const refreshVoice = async () => {
    try {
      setVoiceSnapshot(await actions.voiceDesign?.snapshot());
      setVoiceError("");
    } catch (error) {
      setVoiceError(error?.message || "无法读取音色设置。");
    }
  };
  const customVoices = Array.isArray(voiceSnapshot?.customVoices) ? voiceSnapshot.customVoices : [];
  const saveCustomAudio = async (event) => {
    event.preventDefault();
    if (savingCustomAudio) return;
    const form = new FormData(event.currentTarget);
    setSavingCustomAudio(true);
    setVoiceError("");
    try {
      const next = await actions.voiceDesign?.saveCustomAudio({
        adapter: customAdapter,
        model: form.get("model"),
        name: form.get("name"),
        voiceId: form.get("voiceId"),
      });
      if (next?.status) setVoiceSnapshot(next);
      setVoiceCreateOpen(false);
    } catch (error) {
      setVoiceError(error?.message || "保存音色失败，请稍后重试。");
    } finally {
      setSavingCustomAudio(false);
    }
  };
  const deleteCustomVoice = async (voice) => {
    if (!voice?.id || deletingVoiceId) return;
    setDeletingVoiceId(voice.id);
    setVoiceError("");
    try {
      const next = await actions.voiceDesign?.deleteCustomVoice({
        id: voice.id,
        source: voice.source || "",
        sourceContactId: voice.sourceContactId || "",
      });
      if (next?.status) setVoiceSnapshot(next);
    } catch (error) {
      setVoiceError(error?.message || "删除音色失败，请稍后重试。");
    } finally {
      setDeletingVoiceId("");
    }
  };
  const apiConnections = Array.isArray(apiServices?.connections) ? apiServices.connections : [];
  const apiBindings = apiServices?.bindings && typeof apiServices.bindings === "object" ? apiServices.bindings : {};
  const connectionsFor = (bindingId) => {
    const types = API_BINDINGS.find((item) => item.id === bindingId)?.types || [];
    return apiConnections.filter((item) => types.includes(item.type));
  };
  return (
    <>
    <SettingSurface
      action={<Button onClick={() => setVoiceDialogOpen(true)} type="button" variant="secondary">配置联系人音色</Button>}
      description="文字转语音与通话识别使用的 API。"
      eyebrow="声音"
      title="发送语音"
    >
        <div className="voice-binding-pair">
          <div className="voice-binding-pair__item">
            <span className="voice-binding-pair__label">TTS API</span>
            <ApiConnectionPicker
              connections={connectionsFor("voice-message")}
              onManage={actions.openApiServices}
              onSelect={(connectionId) => actions.selectApiBinding?.("voice-message", connectionId)}
              selectedId={apiBindings["voice-message"] || ""}
              title="为文字转语音选择 API"
            />
          </div>
          <div className="voice-binding-pair__item">
            <span className="voice-binding-pair__label">ASR API</span>
            <ApiConnectionPicker
              connections={connectionsFor("realtime-asr")}
              onManage={actions.openApiServices}
              onSelect={(connectionId) => actions.selectApiBinding?.("realtime-asr", connectionId)}
              selectedId={apiBindings["realtime-asr"] || ""}
              title="为语音识别选择 API"
            />
          </div>
        </div>
    </SettingSurface>
    <CapabilitySettingsForm abilityId="voice-message" actions={actions} submitLabel="保存灵敏度">
      <SettingSurface description="说话能量阈值越小越灵敏；静音判定帧数越多，一句话要停顿更久才算说完。" eyebrow="声音" title="通话灵敏度">
        <FormGrid>
          <FormField hint="建议 0.010～0.060；环境安静可以调低，有背景音可以调高。" label="说话能量阈值">
            <input defaultValue={savedSettings(capability).voiceEnergyThreshold ?? 0.025} max="1" min="0.001" name="voiceEnergyThreshold" step="0.001" type="number" />
          </FormField>
          <FormField hint="默认 9 帧（约 0.4 秒停顿）。" label="静音判定帧数">
            <input defaultValue={savedSettings(capability).voiceSilenceFrames ?? 9} max="120" min="1" name="voiceSilenceFrames" step="1" type="number" />
          </FormField>
        </FormGrid>
      </SettingSurface>
    </CapabilitySettingsForm>
    <SettingSurface
      action={<Button onClick={() => setVoiceCreateOpen(true)} type="button" variant="secondary">新增音色</Button>}
      description="Agent 发语音消息和电话都会使用这里的声音。"
      eyebrow="声音"
      title="音色"
    >
        {voiceError ? <p className="voice-settings-copy">{voiceError}</p> : null}
        {customVoices.length ? <div className="voice-candidate-list">{customVoices.map((voice) => (
          <article className="voice-candidate" key={voice.key}>
            <div className="voice-candidate-copy">
              <span className="reference-kicker">{voice.kindLabel}</span>
              <h3>{voice.name}</h3>
              <p>{voice.model ? `模型 ${voice.model}` : "使用默认模型"} · 音色 {voice.voiceId}</p>
            </div>
            <div className="voice-candidate-actions">
              <button className="danger-button" disabled={deletingVoiceId === voice.id} onClick={() => void deleteCustomVoice(voice)} type="button">{deletingVoiceId === voice.id ? "正在删除…" : "删除"}</button>
            </div>
          </article>
        ))}</div> : <Empty className="capability-inline-empty" description="还没有音色。新增后可为联系人配置。" title="暂无音色" />}
    </SettingSurface>
      <ContactDeliverySettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} description="所选联系人会通过 Suzu Agent Core 使用各自保存的音色设置。" emptyDescription="先创建联系人，再选择允许哪些联系人使用语音消息。" />
      <VoiceContactConfigDialog onClose={() => setVoiceDialogOpen(false)} open={voiceDialogOpen} voiceDesign={actions.voiceDesign} />
      <CreateStudioDialog ariaLabel="新增音色" onClose={() => { if (!savingCustomAudio) setVoiceCreateOpen(false); }} open={voiceCreateOpen}>
        <SettingsDialogHeader onClose={() => { if (!savingCustomAudio) setVoiceCreateOpen(false); }} title="新增音色">音色</SettingsDialogHeader>
        <div className="voice-settings-copy"><p>填写声音的模型与音色 ID。若已选择百炼地址且模型或音色 ID 为 CosyVoice / Qwen TTS，Suzu 会自动使用百炼协议；其他服务再按其文档选择适配器。</p></div>
        <form className="voice-form voice-contact-config-form" onSubmit={saveCustomAudio}>
          <label>声音备注名<input autoFocus disabled={savingCustomAudio} maxLength="80" name="name" placeholder="例如：Suzu 的电话声" required /></label>
          <label>接口适配器（其他服务用）<Select className="create-select-react" disabled={savingCustomAudio} fullWidth onChange={setCustomAdapter} options={TTS_ADAPTER_OPTIONS} value={customAdapter} /></label>
          <label>模型<input disabled={savingCustomAudio} maxLength="160" name="model" placeholder="留空时使用适配器默认模型" /></label>
          <label>音色 ID<input disabled={savingCustomAudio} maxLength="200" name="voiceId" placeholder="填写服务商提供的 voice ID" required /></label>
          <div className="voice-form-actions"><button className="secondary-button" disabled={savingCustomAudio} onClick={() => setVoiceCreateOpen(false)} type="button">取消</button><button className="primary-button" disabled={savingCustomAudio}>{savingCustomAudio ? "正在保存…" : "保存音色"}</button></div>
        </form>
      </CreateStudioDialog>
    </>
  );
}

function ImageVisionSettings({ actions, apiServices, capability, contactsSnapshot }) {
  const settings = savedSettings(capability);
  const vision = settings.vision || {};
  return (
    <>
      <CapabilitySettingsForm abilityId="image-vision" actions={actions}>
        <SettingSurface description="选择已在设置中保存的图片理解 API；模型、地址和 Key 均由该 API 连接统一管理。" eyebrow="理解图片" title="读取偏好">
          <FormGrid>
            <ApiBinding actions={actions} apiServices={apiServices} bindingId="image-vision" />
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
      <ContactDeliverySettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} description="所选联系人会通过 Suzu Agent Core 使用这里的图片读取偏好与 API。" emptyDescription="先创建联系人，再选择允许哪些联系人使用图像理解。" />
    </>
  );
}

function VideoUnderstandingSettings({ actions, apiServices, capability, contactsSnapshot }) {
  const settings = savedSettings(capability);
  const video = settings.video || {};
  return (
    <>
      <CapabilitySettingsForm abilityId="video-understanding" actions={actions}>
        <SettingSurface description="选择已在设置中保存的视频理解 API，并设置模型读取完整视频时的时间密度。视频会作为视频输入直接交给模型；这里不做本地抽帧理解。" eyebrow="理解视频" title="读取偏好">
          <FormGrid>
            <ApiBinding actions={actions} apiServices={apiServices} bindingId="video-understanding" />
            <FormField className="capability-form-field--wide" label="模型读取密度"><ChoiceSelect name="fps" options={[["0.5", "节省：约每 2 秒读取一次"], ["1", "平衡：约每秒读取一次"], ["2", "细看：约每秒读取两次"]]} value={String(video.fps ?? 1)} /></FormField>
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
      <ContactDeliverySettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} description="所选联系人会通过 Suzu Agent Core 使用这里的视频读取偏好与 API。" emptyDescription="先创建联系人，再选择允许哪些联系人使用视频理解。" />
    </>
  );
}

function TimeAwarenessSettings({ actions, capability, contactsSnapshot }) {
  const settings = savedSettings(capability);
  return (
    <>
      <CapabilitySettingsForm abilityId="time-awareness" actions={actions}>
        <SettingSurface description="同一对话超过这个间隔后，时间感知会把新的本机时间作为本轮额外上下文注入。" eyebrow="时间间隔" title="多久感知一次">
          <FormGrid>
            <FormField hint="默认 10 分钟；可设为 1 到 1440 分钟。" label="间隔（分钟）"><input defaultValue={settings.intervalMinutes ?? 10} max="1440" min="1" name="intervalMinutes" type="number" /></FormField>
          </FormGrid>
        </SettingSurface>
      </CapabilitySettingsForm>
      <ContactDeliverySettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} defaultEnabled={settings.defaultEnabled === true} description="所选联系人会按这里的间隔获得本机时间上下文。" emptyDescription="先创建联系人，再选择在哪些联系人中启用时间感知。" />
    </>
  );
}

function WebBrowserSettings({ actions, capability, contactsSnapshot }) {
  const settings = savedSettings(capability);
  const configuration = settings.configuration || {};
  const browser = settings.browser || {};
  const running = browser.status === "ready";
  return (
    <>
      <SettingSurface description="每位已启用的联系人都通过同一个 Suzu 专用浏览器操作任意已登录网页。网站登录态只保存在本机 profile，不会写进联系人工作目录。" eyebrow="WEB BROWSER" title="专用浏览器">
        <Status label={running ? "浏览器正在运行" : "浏览器尚未启动"} tone={running ? "success" : "muted"} />
        {browser.browser ? <p className="capability-settings-note">{browser.browser}</p> : null}
      </SettingSurface>
      <CapabilitySettingsForm abilityId="web-browser" actions={actions}>
        <SettingSurface description="Suzu 会在需要时启动自己的浏览器窗口；可先登录网站，之后 Agent 能直接使用同一登录态。" eyebrow="WEB BROWSER" title="连接与运行">
          <FormGrid>
            <FormField className="capability-form-field--wide" hint="默认 http://127.0.0.1:9222，只能连接本机的 Suzu 专用浏览器。" label="浏览器连接地址"><input defaultValue={configuration.cdpUrl || "http://127.0.0.1:9222"} maxLength="500" name="cdpUrl" /></FormField>
            <FormField className="capability-form-field--wide" hint="留空会自动寻找 Chrome，找不到时再填写 chrome.exe 或 msedge.exe 的绝对路径。" label="浏览器可执行文件（可选）"><input defaultValue={configuration.executablePath || ""} maxLength="1000" name="executablePath" placeholder="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" /></FormField>
            <FormField label="页面操作等待（毫秒）"><input defaultValue={configuration.timeoutMs ?? 10000} max="120000" min="1000" name="timeoutMs" type="number" /></FormField>
            <FormField label="打开页面等待（毫秒）"><input defaultValue={configuration.navigationTimeoutMs ?? 25000} max="180000" min="1000" name="navigationTimeoutMs" type="number" /></FormField>
            <CheckboxField defaultChecked={configuration.autoStartBrowser !== false} label="需要时启动专用浏览器" name="autoStartBrowser" />
          </FormGrid>
        </SettingSurface>
      </CapabilitySettingsForm>
      <SettingSurface description="Agent 可打开、读取、截图、点击、填写、按键、滚动、等待、上传、下载，以及执行页面脚本。下载和截图会返回本机路径，可继续走现有聊天附件发送。" eyebrow="ACTIONS" title="通用网页操作" />
      <ContactDeliverySettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} description="启用后，这位联系人可通过 Suzu Agent Core 直接操作 Suzu 专用浏览器中的任意网页。" emptyDescription="先创建联系人，再选择允许哪些联系人使用网页自动化。" />
    </>
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

function AgentJournalSettings({ actions, capability, contactsSnapshot }) {
  const settings = savedSettings(capability);
  return (
    <>
      <CapabilitySettingsForm abilityId="agent-journal" actions={actions} submitLabel="保存日记时间">
        <SettingSurface description="每天由软件创建一次内部回合，让对应 Agent 回顾当天值得留下的事。日记单独保存在本机，不会作为普通聊天消息或微信消息发送，也不会进入长期记忆。" eyebrow="AGENT JOURNAL" title="每天写日记">
          <FormGrid>
            <FormField hint="软件未运行时不会补写；默认是每天 00:02。" label="记录时间"><input defaultValue={settings.time || "00:02"} name="time" required type="time" /></FormField>
          </FormGrid>
        </SettingSurface>
      </CapabilitySettingsForm>
      <ContactDeliverySettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} description="打开后，这位联系人的 Agent 会在设定时间写当天的日记；可以同时开启多个联系人。日记可在“关系 → 查看日记”中浏览。" emptyDescription="先创建联系人，再选择哪些 Agent 需要每天写日记。" />
    </>
  );
}

function MailBridgeConfigDialog({ actions, capability, onClose, open }) {
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
      const result = await actions.saveSettings("mail-bridge", formValue(event.currentTarget));
      if (result?.ok) onClose?.();
      else setFeedback(result?.error?.message || "邮件连接没有保存，请检查填写内容。 ");
    } catch (error) {
      setFeedback(error?.message || "邮件连接没有保存，请稍后重试。 ");
    } finally {
      setSaving(false);
    }
  };
  return (
    <CreateStudioDialog ariaLabel="配置邮箱通道" className="mail-bridge-config-dialog" onClose={close} open={open}>
      <SettingsDialogHeader onClose={close} title="配置邮箱通道">邮箱通道</SettingsDialogHeader>
      <div className="voice-settings-copy"><p>填写用于发送和接收邮件的邮箱。收件方可以是任何外部自动化或邮箱；授权码不写进页面或配置快照：请先把它放到操作系统环境变量，再在这里填写变量名。</p></div>
      {feedback ? <div className="voice-settings-copy"><p>{feedback}</p></div> : null}
      <form className="mail-bridge-config-form" onSubmit={save}>
        <div className="capability-form-grid-react">
          <FormField label="SMTP 服务器"><input defaultValue={configuration.smtpHost || "smtp.163.com"} maxLength="320" name="smtpHost" required /></FormField>
          <FormField label="SMTP 端口"><input defaultValue={configuration.smtpPort ?? 465} max="65535" min="1" name="smtpPort" required type="number" /></FormField>
          <FormField label="发件邮箱"><input defaultValue={configuration.sender || ""} maxLength="320" name="sender" required type="email" /></FormField>
          <FormField label="默认收件邮箱"><input defaultValue={configuration.recipient || ""} maxLength="320" name="recipient" required type="email" /></FormField>
          <FormField label="IMAP 服务器"><input defaultValue={configuration.imapHost || "imap.163.com"} maxLength="320" name="imapHost" required /></FormField>
          <FormField label="IMAP 端口"><input defaultValue={configuration.imapPort ?? 993} max="65535" min="1" name="imapPort" required type="number" /></FormField>
          <FormField label="收信邮箱账号"><input defaultValue={configuration.username || ""} maxLength="320" name="username" required type="email" /></FormField>
          <FormField label="收件箱"><input defaultValue={configuration.mailbox || "INBOX"} maxLength="160" name="mailbox" required /></FormField>
          <FormField className="capability-form-field--wide" hint="每行一个地址；只有这些地址发来的邮件会按下面的主题路由交给 Agent。" label="允许的邮件发件人"><textarea defaultValue={allowedSenders} maxLength="9600" name="allowedSenders" required /></FormField>
          <FormField className="capability-form-field--wide" hint="例如 SUZU_MAIL_PASSWORD。实际授权码只由本机进程从这个环境变量读取。" label="邮箱授权码环境变量"><input defaultValue={configuration.passwordEnv || "SUZU_MAIL_PASSWORD"} maxLength="128" name="passwordEnv" required /></FormField>
          <FormField label="邮件主题路由"><input defaultValue={configuration.routeSubject || "Suzu"} maxLength="200" name="routeSubject" required /></FormField>
          <FormField className="capability-form-field--wide" hint="可用变量：{{content}}、{{subject}}、{{from}}、{{receivedAt}}、{{attachments}}。" label="交给 Agent 的邮件提示词"><textarea defaultValue={configuration.routePrompt || "这是收到的一封邮件（{{subject}}，来自 {{from}}，{{receivedAt}}）：\n{{content}}\n{{attachments}}"} maxLength="12000" name="routePrompt" required /></FormField>
        </div>
        <footer className="mail-bridge-config-form__actions"><Button disabled={saving} onClick={close} type="button" variant="secondary">取消</Button><Button disabled={saving} type="submit">{saving ? "正在保存…" : "保存邮箱通道"}</Button></footer>
      </form>
    </CreateStudioDialog>
  );
}

function MailBridgeSettings({ actions, capability, contactsSnapshot }) {
  const [configOpen, setConfigOpen] = useState(false);
  const settings = savedSettings(capability);
  const status = settings.saved
    ? "全局邮箱通道已保存。软件运行时会读取授权码环境变量，并把符合主题路由的邮件直接投递到下方勾选的联系人。"
    : "先配置全局邮箱通道，再选择要接收路由邮件的联系人。";
  return (
    <>
      <SettingSurface action={<Button onClick={() => setConfigOpen(true)} type="button" variant="secondary">配置邮箱通道</Button>} description={status} eyebrow="MAIL BRIDGE" title="本地邮件收发" />
      <ContactDeliverySettings actions={actions} capability={capability} description="可以同时勾选多个联系人；一封符合主题路由的邮件会分别排进所有已勾选联系人的对话。" contactsSnapshot={contactsSnapshot} />
      <MailBridgeConfigDialog actions={actions} capability={capability} onClose={() => setConfigOpen(false)} open={configOpen} />
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

function CapabilitySettings({ actions, apiServices, capability, contactsSnapshot, wechatSnapshot }) {
  if (capability.id === "wechat-connection") return <WechatSettings actions={actions} wechatSnapshot={wechatSnapshot} />;
  if (capability.id === "image-generation") return <ImageGenerationSettings actions={actions} apiServices={apiServices} capability={capability} contactsSnapshot={contactsSnapshot} />;
  if (capability.id === "phone-camera") return <PhoneCameraSettings actions={actions} apiServices={apiServices} capability={capability} contactsSnapshot={contactsSnapshot} />;
  if (capability.id === "voice-message") return <VoiceMessageSettings actions={actions} apiServices={apiServices} capability={capability} contactsSnapshot={contactsSnapshot} />;
  if (capability.id === "time-awareness") return <TimeAwarenessSettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} />;
  if (capability.id === "image-vision") return <ImageVisionSettings actions={actions} apiServices={apiServices} capability={capability} contactsSnapshot={contactsSnapshot} />;
  if (capability.id === "video-understanding") return <VideoUnderstandingSettings actions={actions} apiServices={apiServices} capability={capability} contactsSnapshot={contactsSnapshot} />;
  if (capability.id === "web-browser") return <WebBrowserSettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} />;
  if (capability.id === "mail-bridge") return <MailBridgeSettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} />;
  if (capability.id === "agent-journal") return <AgentJournalSettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} />;
  if (capability.id === "proactive-contact") return <ProactiveContactSettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} />;
  return <GenericCapabilitySettings />;
}

export function CapabilityDetailPage({
  actions = {},
  apiServices,
  capability,
  categoryId,
  contactsSnapshot,
  wechatSnapshot,
}) {
  const category = categoryFor(categoryId);
  const title = capability.name;
  const subtitle = capability.description;
  const back = <Button onClick={() => actions.returnToCategory?.(category.id)} type="button" variant="secondary">返回{category.label}</Button>;
  const detailAction = CONTACT_SCOPED_CAPABILITY_IDS.has(capability.id)
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
      <CapabilitySettings actions={actions} apiServices={apiServices} capability={capability} contactsSnapshot={contactsSnapshot} wechatSnapshot={wechatSnapshot} />
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
        <div><strong>Agent Core 登记</strong><p>{capability.enabled ? "这项外部能力已登记到 Suzu 管理的 Agent Core。" : "启用后，Skill 会放入受管技能目录，MCP 会作为 Agent Core 工具连接。不会写入旧版项目文件。"}</p></div>
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
  const runtimeHome = String(snapshot.runtimeHome || snapshot.projectRoot || "").trim();
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
      <PageHeader action={<Button onClick={actions.returnToOverview} type="button" variant="secondary">返回能力</Button>} eyebrow="CAPABILITIES / EXTERNAL" subtitle="外部 Skill 与 MCP 会以 Agent Core 方式安装到 Suzu 的运行时，可供所有联系人使用。" title="外部能力" />
      <SettingSurface description={runtimeHome || "Agent Core 会在首次使用时创建。"} eyebrow="全局运行时" title="Suzu Agent Core">
        <div className="capability-inline-action-react"><p>导入只读取本地 suzu-capability.json；不会下载或运行第三方代码。启用 MCP 后，Agent Core 会在下一次聊天时按清单启动它。</p><Button disabled={importing} onClick={importManifest} type="button" variant="secondary">{importing ? "正在导入…" : "导入 suzu-capability.json"}</Button></div>
      </SettingSurface>
      {capabilities.length ? <section className="external-capability-list">{capabilities.map((capability) => <ExternalCapabilityCard actions={actions} capability={capability} key={capability.id} onRemove={setRemoving} />)}</section> : <GlassPanel as="section" className="capability-empty-panel" intensity="soft"><Empty description="导入本地 suzu-capability.json 后，这里会显示 Skill/MCP 的静态诊断与 Agent Core 登记状态。" title="还没有外部能力" /></GlassPanel>}
      <CreateStudioDialog ariaLabel="移除外部能力" className="capability-remove-dialog" onClose={() => setRemoving(null)} open={Boolean(removing)}>
        <header><div><span>EXTERNAL CAPABILITY</span><h2>移除外部能力？</h2></div><button aria-label="关闭" className="suzu-close-button" onClick={() => setRemoving(null)} type="button">×</button></header>
        <p>{`“${removing?.name || "这项外部能力"}”会清理所有由 Suzu 登记的 Skill 与 MCP 条目；若检测到手动修改会中止并保留文件。`}</p>
        <footer><Button disabled={removingPending} onClick={() => setRemoving(null)} type="button" variant="secondary">取消</Button><Button disabled={removingPending} onClick={remove} type="button" variant="danger">{removingPending ? "正在移除…" : "移除能力"}</Button></footer>
      </CreateStudioDialog>
    </div>
  );
}
