import { useEffect, useState } from "react";
import { Button, Empty, GlassPanel, PageHeader, Select, Status, Switch } from "suzu-design-system";
import { imageGenerationAdapterDefinition, imageGenerationAdapterSupportsConnection, IMAGE_GENERATION_ADAPTER_OPTIONS, normalizeImageGenerationAdapter } from "@suzu-lives/image-workbench/image-generation-adapters";
import { imageReferenceAdapterOptions, imageReferenceCapability, normalizeImageReferenceAdapter } from "@suzu-lives/image-workbench/image-reference-adapters";
import { normalizeVisionAdapter, VISION_ADAPTER_OPTIONS, visionAdapterDefinition, visionAdapterSupportsConnection } from "@suzu-lives/media-understanding/vision-adapters";
import { normalizeVideoAdapter, VIDEO_ADAPTER_OPTIONS, videoAdapterDefinition, videoAdapterSupportsConnection } from "@suzu-lives/media-understanding/video-adapters";
import { TTS_ADAPTER_OPTIONS, ttsAdapterDefinition, ttsAdapterLabel } from "@suzu-lives/voice-message/tts-adapters";

import { API_BINDINGS } from "../features/agent/runtime.mjs";
import {
  CAPABILITY_CATEGORIES,
  capabilityCategory,
  capabilityVisibleInCatalog,
  createQQConnectionCapability,
  createWechatConnectionCapability,
  QQ_DELIVERY_OPTIONS,
  QQ_TEXT_SEGMENTATION_OPTIONS,
  qqConnectionSettings,
  WECHAT_DELIVERY_OPTIONS,
  WECHAT_TEXT_SEGMENTATION_OPTIONS,
  wechatConnectionSettings,
} from "../features/capabilities/overview.mjs";
import { ApiConnectionPicker } from "./api-connections-ui.jsx";
import { CreateStudioDialog } from "./create-studio-dialog.jsx";
import { PageScaffold } from "./page-scaffold.jsx";

const EXTERNAL_TYPE_LABELS = Object.freeze({
  cli: "CLI（预留）",
  mcp: "MCP",
  skill: "Skill",
});
const CONTACT_SCOPED_CAPABILITY_IDS = new Set(["image-vision", "video-understanding", "image-generation", "voice-message", "web-browser", "mail-bridge", "agent-journal", "proactive-contact"]);

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

function ChoiceSelect({ name, onChange = null, options, value }) {
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
      <Select className="capability-select-react" fullWidth onChange={(next) => {
        setSelected(next);
        onChange?.(next);
      }} options={choices} value={selected} />
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

function ApiBinding({ actions, apiServices, bindingId, connectionFilter = null }) {
  const item = API_BINDINGS.find((candidate) => candidate.id === bindingId);
  if (!item) return null;
  const connections = Array.isArray(apiServices?.connections) ? apiServices.connections : [];
  const bindings = apiServices?.bindings && typeof apiServices.bindings === "object" ? apiServices.bindings : {};
  const available = connections.filter((connection) => (
    item.types.includes(connection.type)
    && (typeof connectionFilter !== "function" || connectionFilter(connection))
  ));
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
  if (contact?.voiceProfileId) {
    const profile = choices.find((item) => item.selection === "profile" && item.id === contact.voiceProfileId);
    return profile?.name || "已选音色不可用";
  }
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
    if (!choice) return;
    setSaving(true);
    setFeedback(`正在为“${contact.name}”保存音色…`);
    try {
      const next = await voiceDesign.saveContactVoice(choice.selection === "profile" ? {
        contactId: contact.id,
        voiceProfileId: choice.id,
      } : {
        contactId: contact.id,
        customVoiceId: choice.id || "",
        customAdapterId: choice.customAdapterId || "",
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
        <div className="voice-settings-copy"><p>选择一位联系人，再为 ta 设置保存过的音色。每个人的设置互不影响。</p></div>
        {feedback ? <div className="voice-settings-copy"><p>{feedback}</p></div> : null}
        {loading ? <div className="voice-history-empty voice-contact-empty">正在读取可用音色…</div> : contacts.length ? <div className="voice-contact-list">{contacts.map((item) => <article className="voice-contact-row" key={item.id}><div><strong>{item.name}</strong><small>{voiceChoiceLabel(item, choices)}</small></div><button className="secondary-button" onClick={() => setSelectedContactId(item.id)} type="button">配置音色</button></article>)}</div> : <div className="voice-history-empty voice-contact-empty">还没有联系人。请先在“关系”中创建联系人。</div>}
        <div className="voice-form-actions voice-contact-dialog-actions"><button className="secondary-button" onClick={close} type="button">关闭</button></div>
      </> : contact ? <>
        <SettingsDialogHeader onClose={close} title={`为“${contact.name}”配置音色`}>联系人</SettingsDialogHeader>
        <div className="voice-settings-copy"><p>{`这里列出已保存的音色；保存后只影响“${contact.name}”。`}</p></div>
        {feedback ? <div className="voice-settings-copy"><p>{feedback}</p></div> : null}
        {choices.length ? <form className="voice-form voice-contact-config-form" onSubmit={save}><div className="voice-contact-choice-list">{choices.map((item) => { const selected = item.selection === "profile" ? contact.voiceProfileId === item.id : item.id ? contact.adapter === item.adapter && item.id === contact.customVoiceId && item.customAdapterId === contact.customAdapterId && item.voiceId === contact.voiceId : contact.adapter === item.adapter && item.voiceId === contact.voiceId; return <label className="voice-contact-choice" key={item.key}><input defaultChecked={selected} name="voiceSelection" required type="radio" value={item.key} /><span><strong>{item.name}</strong><small>{selected ? `${contact.name}正在使用` : item.kindLabel}</small></span></label>; })}</div><div className="voice-form-actions"><button className="secondary-button" disabled={saving} onClick={() => setSelectedContactId("")} type="button">返回联系人列表</button><button className="primary-button" disabled={saving}>{saving ? "正在保存…" : "使用这个音色"}</button></div></form> : <><div className="voice-history-empty voice-contact-empty">还没有可用音色。请先在“语音消息”设置中添加语音适配器和音色。</div><div className="voice-form-actions voice-contact-dialog-actions"><button className="secondary-button" onClick={() => setSelectedContactId("")} type="button">返回联系人列表</button></div></>}
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

export function CapabilityCategoryPage({ actions = {}, capabilitySnapshot, categoryId, qqSnapshot, wechatSnapshot }) {
  const category = categoryFor(categoryId);
  const builtIn = Array.isArray(capabilitySnapshot?.capabilities) ? capabilitySnapshot.capabilities : [];
  const connections = capabilitySnapshot ? [createWechatConnectionCapability(wechatSnapshot), createQQConnectionCapability(qqSnapshot)] : [];
  const members = [...builtIn, ...connections]
    .filter(capabilityVisibleInCatalog)
    .filter((capability) => capabilityCategory(capability) === category.id);
  return (
    <PageScaffold
      className="capabilities-react-page capabilities-react-page--inner"
      header={(
        <PageHeader
          action={<Button onClick={actions.returnToOverview} type="button" variant="secondary">返回能力</Button>}
          eyebrow={"CAPABILITIES / " + category.label.toUpperCase()}
          subtitle={category.detail}
          title={category.label}
        />
      )}
    >
      <section aria-label={category.label + "能力"} className="capability-entry-react-grid">
        {members.map((capability) => (
          <CapabilityEntryCard
            capability={capability}
            key={capability.id}
            onOpen={() => actions.openDetail?.(category.id, capability.id)}
          />
        ))}
      </section>
    </PageScaffold>
  );
}

const IMAGE_GENERATION_CUSTOM_PROTOCOL_PREFIX = "custom:";

function imageGenerationProtocolSelection(value) {
  const selected = String(value || "").trim();
  if (selected.startsWith(IMAGE_GENERATION_CUSTOM_PROTOCOL_PREFIX)) {
    return {
      adapter: "custom-http-image",
      customAdapterId: selected.slice(IMAGE_GENERATION_CUSTOM_PROTOCOL_PREFIX.length),
    };
  }
  return {
    adapter: normalizeImageGenerationAdapter(selected),
    customAdapterId: "",
  };
}

function ImageGenerationSettings({ actions, apiServices, capability, contactsSnapshot }) {
  const settings = savedSettings(capability);
  const configuredAdapter = normalizeImageGenerationAdapter(settings.adapter);
  const configuredReferenceAdapter = normalizeImageReferenceAdapter(settings.referenceAdapter);
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const customAdapters = Array.isArray(settings.customAdapters) ? settings.customAdapters : [];
  const configuredCustomAdapterId = String(settings.customAdapterId || "").trim().toLowerCase();
  const configuredCustomAdapter = customAdapters.find((protocol) => protocol.id === configuredCustomAdapterId) || null;
  const unavailableConfiguredProtocol = configuredAdapter === "custom-http-image" && configuredCustomAdapterId && !configuredCustomAdapter;
  const configuredProtocol = configuredAdapter === "custom-http-image" && configuredCustomAdapter
    ? `${IMAGE_GENERATION_CUSTOM_PROTOCOL_PREFIX}${configuredCustomAdapter.id}`
    : unavailableConfiguredProtocol
      ? `${IMAGE_GENERATION_CUSTOM_PROTOCOL_PREFIX}${configuredCustomAdapterId}`
      : configuredAdapter;
  const [protocol, setProtocol] = useState(configuredProtocol);
  const [referenceAdapter, setReferenceAdapter] = useState(configuredReferenceAdapter);
  const selectedProtocol = imageGenerationProtocolSelection(protocol);
  const adapter = selectedProtocol.adapter;
  const connections = Array.isArray(apiServices?.connections) ? apiServices.connections : [];
  const bindings = apiServices?.bindings && typeof apiServices.bindings === "object" ? apiServices.bindings : {};
  const selectedConnection = connections.find((connection) => connection.id === bindings["image-workbench"]) || null;
  const activeCustomAdapter = adapter === "custom-http-image"
    ? customAdapters.find((protocolItem) => protocolItem.id === selectedProtocol.customAdapterId) || null
    : null;
  const adapterOptions = IMAGE_GENERATION_ADAPTER_OPTIONS
    .filter((option) => option.value !== "custom-http-image")
    .map((option) => [option.value, option.label]);
  const protocolOptions = [
    ...(unavailableConfiguredProtocol ? [[configuredProtocol, "已不可用的自定义协议"]] : []),
    ...adapterOptions,
    ...customAdapters.map((item) => [`${IMAGE_GENERATION_CUSTOM_PROTOCOL_PREFIX}${item.id}`, item.name]),
  ];
  const referenceAdapterOptions = imageReferenceAdapterOptions({ imageGenerationAdapter: adapter, connectionType: selectedConnection?.type });
  const activeReferenceAdapter = referenceAdapterOptions.some(([id]) => id === referenceAdapter) ? referenceAdapter : "none";
  const referenceCapability = imageReferenceCapability({
    connection: selectedConnection || {},
    customImageGenerationAdapter: activeCustomAdapter,
    imageGenerationAdapter: adapter,
    referenceImageAdapter: activeReferenceAdapter,
    referenceImageModel: activeReferenceAdapter === configuredReferenceAdapter ? settings.referenceModel : selectedConnection?.model || "",
  });

  useEffect(() => {
    setProtocol(configuredProtocol);
  }, [configuredProtocol]);

  useEffect(() => {
    setReferenceAdapter(configuredReferenceAdapter);
  }, [configuredReferenceAdapter]);

  return (
    <>
      <CapabilitySettingsForm abilityId="image-generation" actions={actions}>
        <SettingSurface description="选择图片生成服务的请求协议和 API。" eyebrow="图片生成" title="请求设置">
          <FormGrid>
            <div className="capability-form-field image-vision-protocol-field">
              <span>请求协议</span>
              <div className="image-vision-protocol-field__controls">
                <ChoiceSelect name="imageGenerationProtocol" onChange={setProtocol} options={protocolOptions} value={protocol} />
                <Button onClick={() => setCustomDialogOpen(true)} type="button" variant="secondary">新增自定义协议</Button>
              </div>
              <input name="adapter" type="hidden" value={adapter} />
              <input name="customAdapterId" type="hidden" value={selectedProtocol.customAdapterId} />
              <small>{unavailableConfiguredProtocol ? "当前自定义协议已不可用，请选择其他协议后保存。" : adapter === "custom-http-image" ? "请求格式保存在所选协议中；API Key 继续使用下方选择的 API 连接。" : imageGenerationAdapterDefinition(adapter)?.detail || "选择图片生成服务使用的请求格式。"}</small>
            </div>
            <div className="capability-form-field image-vision-protocol-field">
              <span>参考图适配器</span>
              <ChoiceSelect name="referenceAdapter" onChange={setReferenceAdapter} options={referenceAdapterOptions} value={activeReferenceAdapter} />
              <small>{referenceCapability.supported ? `将按“${referenceCapability.adapterLabel}”向模型“${referenceCapability.model}”发送参考图；请先以服务商文档确认该模型支持这种格式。保存后会锁定这个模型名，模型或协议变更时会自动禁用参考图。` : referenceCapability.reason}</small>
            </div>
            <ApiBinding actions={actions} apiServices={apiServices} bindingId="image-generation" connectionFilter={(connection) => imageGenerationAdapterSupportsConnection(adapter, connection.type)} />
          </FormGrid>
        </SettingSurface>
      </CapabilitySettingsForm>
      <ContactDeliverySettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} description="所选联系人会通过 Suzu Agent Core 使用这套生图设置。" emptyDescription="先创建联系人，再选择允许哪些联系人使用图像生成。" />
      <CustomImageGenerationAdapterDialog imageGenerationDesign={actions.imageGenerationDesign} onClose={() => setCustomDialogOpen(false)} open={customDialogOpen} />
    </>
  );
}

const CUSTOM_TTS_RESPONSE_OPTIONS = Object.freeze([
  { label: "JSON 中的 Base64 音频", value: "json-base64" },
  { label: "JSON 中的音频下载地址", value: "json-url" },
  { label: "直接返回音频文件", value: "binary" },
]);

function CustomTtsAdapterDialog({ onClose, onSaved, open, voiceDesign }) {
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [responseMode, setResponseMode] = useState("json-base64");
  const close = () => { if (!saving) onClose?.(); };
  const save = async (event) => {
    event.preventDefault();
    if (saving || typeof voiceDesign?.saveCustomTtsAdapter !== "function") return;
    const form = new FormData(event.currentTarget);
    setSaving(true);
    setFeedback("");
    try {
      const next = await voiceDesign.saveCustomTtsAdapter({
        audioPath: form.get("audioPath"),
        baseUrl: form.get("baseUrl"),
        endpointPath: form.get("endpointPath"),
        name: form.get("name"),
        outputFormat: form.get("outputFormat"),
        requestBody: form.get("requestBody"),
        requestHeaders: form.get("requestHeaders"),
        responseMode,
      });
      onSaved?.(next);
      onClose?.();
    } catch (error) {
      setFeedback(error?.message || "自定义协议没有保存，请检查填写内容。 ");
    } finally {
      setSaving(false);
    }
  };
  return (
    <CreateStudioDialog ariaLabel="新增自定义协议" onClose={close} open={open}>
      <SettingsDialogHeader onClose={close} title="新增自定义协议">语音适配器</SettingsDialogHeader>
      <div className="voice-settings-copy"><p>这里保存未内置服务的请求与返回格式。新建语音适配器时可从“请求协议”中选择它，再绑定 API 连接。Headers 和请求 JSON 可使用 {"{{apiKey}}"}、{"{{model}}"}、{"{{voice}}"}、{"{{text}}"}；请求路径还可使用 {"{{voice}}"}。</p></div>
      {feedback ? <div className="voice-settings-copy"><p>{feedback}</p></div> : null}
      <form className="voice-form voice-contact-config-form" onSubmit={save}>
        <label>协议备注名<input autoFocus disabled={saving} maxLength="80" name="name" required /></label>
        <label>服务地址<input disabled={saving} maxLength="500" name="baseUrl" required /></label>
        <label>请求路径<input defaultValue="/chat/completions" disabled={saving} maxLength="300" name="endpointPath" required /></label>
        <label>请求 Headers（JSON）<textarea defaultValue={'{"Authorization":"Bearer {{apiKey}}","Content-Type":"application/json"}'} disabled={saving} maxLength="8000" name="requestHeaders" required /></label>
        <label>请求 JSON<textarea defaultValue={'{\n  "model": "{{model}}",\n  "input": "{{text}}",\n  "voice": "{{voice}}"\n}'} disabled={saving} maxLength="24000" name="requestBody" required /></label>
        <label>音频返回方式<input name="responseMode" type="hidden" value={responseMode} /><Select className="create-select-react" disabled={saving} fullWidth onChange={setResponseMode} options={CUSTOM_TTS_RESPONSE_OPTIONS} value={responseMode} /></label>
        {responseMode !== "binary" ? <label>音频返回位置<input defaultValue="data" disabled={saving} maxLength="300" name="audioPath" required /></label> : <input name="audioPath" type="hidden" value="" />}
        <label>音频格式<input defaultValue="mp3" disabled={saving} maxLength="12" name="outputFormat" placeholder="mp3" required /></label>
        <div className="voice-form-actions"><button className="secondary-button" disabled={saving} onClick={close} type="button">取消</button><button className="primary-button" disabled={saving}>{saving ? "正在保存…" : "保存协议"}</button></div>
      </form>
    </CreateStudioDialog>
  );
}

const CUSTOM_IMAGE_RESPONSE_OPTIONS = Object.freeze([
  { label: "JSON 中的图片下载地址", value: "json-url" },
  { label: "JSON 中的 Base64 图片", value: "json-base64" },
  { label: "直接返回图片文件", value: "binary" },
]);

function CustomImageGenerationAdapterDialog({ imageGenerationDesign, onClose, onSaved, open }) {
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [responseMode, setResponseMode] = useState("json-url");
  const close = () => { if (!saving) onClose?.(); };
  const save = async (event) => {
    event.preventDefault();
    if (saving || typeof imageGenerationDesign?.saveCustomAdapter !== "function") return;
    const form = new FormData(event.currentTarget);
    setSaving(true);
    setFeedback("");
    try {
      const next = await imageGenerationDesign.saveCustomAdapter({
        baseUrl: form.get("baseUrl"),
        endpointPath: form.get("endpointPath"),
        imagePath: form.get("imagePath"),
        name: form.get("name"),
        requestBody: form.get("requestBody"),
        requestHeaders: form.get("requestHeaders"),
        responseMode,
      });
      onSaved?.(next);
      onClose?.();
    } catch (error) {
      setFeedback(error?.message || "自定义图像协议没有保存，请检查填写内容。 ");
    } finally {
      setSaving(false);
    }
  };
  return (
    <CreateStudioDialog ariaLabel="新增自定义图像协议" onClose={close} open={open}>
      <SettingsDialogHeader onClose={close} title="新增自定义图像协议">图像生成</SettingsDialogHeader>
      <div className="voice-settings-copy"><p>这里保存未内置服务的地址、请求格式和图片返回方式。API Key 仍由已选 API 连接保存。Headers 和请求 JSON 可使用 {"{{apiKey}}"}、{"{{model}}"}、{"{{prompt}}"}、{"{{size}}"}、{"{{referenceImages}}"}；参考图变量会替换为 Data URL 数组。</p></div>
      {feedback ? <div className="voice-settings-copy"><p>{feedback}</p></div> : null}
      <form className="voice-form voice-contact-config-form" onSubmit={save}>
        <label>协议备注名<input autoFocus disabled={saving} maxLength="80" name="name" required /></label>
        <label>服务地址<input disabled={saving} maxLength="500" name="baseUrl" required /></label>
        <label>请求路径<input defaultValue="/images/generations" disabled={saving} maxLength="300" name="endpointPath" required /></label>
        <label>请求 Headers（JSON）<textarea defaultValue={'{"Authorization":"Bearer {{apiKey}}","Content-Type":"application/json"}'} disabled={saving} maxLength="8000" name="requestHeaders" required /></label>
        <label>请求 JSON<textarea defaultValue={'{\n  "model": "{{model}}",\n  "prompt": "{{prompt}}",\n  "size": "{{size}}",\n  "n": 1\n}'} disabled={saving} maxLength="24000" name="requestBody" required /></label>
        <label>图片返回方式<input name="responseMode" type="hidden" value={responseMode} /><Select className="create-select-react" disabled={saving} fullWidth onChange={setResponseMode} options={CUSTOM_IMAGE_RESPONSE_OPTIONS} value={responseMode} /></label>
        {responseMode !== "binary" ? <label>图片返回位置<input defaultValue="data[0].url" disabled={saving} maxLength="300" name="imagePath" required /></label> : <input name="imagePath" type="hidden" value="" />}
        <div className="voice-form-actions"><button className="secondary-button" disabled={saving} onClick={close} type="button">取消</button><button className="primary-button" disabled={saving}>{saving ? "正在保存…" : "保存协议"}</button></div>
      </form>
    </CreateStudioDialog>
  );
}

function CustomVisionAdapterDialog({ imageVisionDesign, onClose, onSaved, open }) {
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const close = () => { if (!saving) onClose?.(); };
  const save = async (event) => {
    event.preventDefault();
    if (saving || typeof imageVisionDesign?.saveCustomAdapter !== "function") return;
    const form = new FormData(event.currentTarget);
    setSaving(true);
    setFeedback("");
    try {
      const next = await imageVisionDesign.saveCustomAdapter({
        baseUrl: form.get("baseUrl"),
        endpointPath: form.get("endpointPath"),
        name: form.get("name"),
        requestBody: form.get("requestBody"),
        requestHeaders: form.get("requestHeaders"),
        responseTextPath: form.get("responseTextPath"),
      });
      onSaved?.(next);
      onClose?.();
    } catch (error) {
      setFeedback(error?.message || "自定义视觉协议没有保存，请检查填写内容。 ");
    } finally {
      setSaving(false);
    }
  };
  return (
    <CreateStudioDialog ariaLabel="新增自定义视觉协议" onClose={close} open={open}>
      <SettingsDialogHeader onClose={close} title="新增自定义视觉协议">图像理解</SettingsDialogHeader>
      <div className="voice-settings-copy"><p>这里保存未内置服务的地址、请求格式和文字返回位置。API Key 仍由已选 API 连接保存。Headers 和请求 JSON 可使用 {"{{apiKey}}"}、{"{{model}}"}、{"{{question}}"}、{"{{systemPrompt}}"}、{"{{detail}}"}、{"{{imageDataUrl}}"}、{"{{imageBase64}}"}、{"{{imageMimeType}}"}。</p></div>
      {feedback ? <div className="voice-settings-copy"><p>{feedback}</p></div> : null}
      <form className="voice-form voice-contact-config-form" onSubmit={save}>
        <label>协议备注名<input autoFocus disabled={saving} maxLength="80" name="name" required /></label>
        <label>服务地址<input disabled={saving} maxLength="500" name="baseUrl" required /></label>
        <label>请求路径<input defaultValue="/chat/completions" disabled={saving} maxLength="300" name="endpointPath" required /></label>
        <label>请求 Headers（JSON）<textarea defaultValue={'{"Authorization":"Bearer {{apiKey}}","Content-Type":"application/json"}'} disabled={saving} maxLength="8000" name="requestHeaders" required /></label>
        <label>请求 JSON<textarea defaultValue={'{\n  "model": "{{model}}",\n  "messages": [\n    { "role": "system", "content": "{{systemPrompt}}" },\n    {\n      "role": "user",\n      "content": [\n        { "type": "text", "text": "{{question}}" },\n        { "type": "image_url", "image_url": { "url": "{{imageDataUrl}}", "detail": "{{detail}}" } }\n      ]\n    }\n  ]\n}'} disabled={saving} maxLength="24000" name="requestBody" required /></label>
        <label>文字返回位置<input defaultValue="choices[0].message.content" disabled={saving} maxLength="300" name="responseTextPath" required /></label>
        <div className="voice-form-actions"><button className="secondary-button" disabled={saving} onClick={close} type="button">取消</button><button className="primary-button" disabled={saving}>{saving ? "正在保存…" : "保存协议"}</button></div>
      </form>
    </CreateStudioDialog>
  );
}

function CustomVideoAdapterDialog({ onClose, onSaved, open, videoUnderstandingDesign }) {
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const close = () => { if (!saving) onClose?.(); };
  const save = async (event) => {
    event.preventDefault();
    if (saving || typeof videoUnderstandingDesign?.saveCustomAdapter !== "function") return;
    const form = new FormData(event.currentTarget);
    setSaving(true);
    setFeedback("");
    try {
      const next = await videoUnderstandingDesign.saveCustomAdapter({
        baseUrl: form.get("baseUrl"),
        endpointPath: form.get("endpointPath"),
        name: form.get("name"),
        requestBody: form.get("requestBody"),
        requestHeaders: form.get("requestHeaders"),
        responseTextPath: form.get("responseTextPath"),
      });
      onSaved?.(next);
      onClose?.();
    } catch (error) {
      setFeedback(error?.message || "自定义视频协议没有保存，请检查填写内容。 ");
    } finally {
      setSaving(false);
    }
  };
  return (
    <CreateStudioDialog ariaLabel="新增自定义视频协议" onClose={close} open={open}>
      <SettingsDialogHeader onClose={close} title="新增自定义视频协议">视频理解</SettingsDialogHeader>
      <div className="voice-settings-copy"><p>这里保存未内置服务的地址、请求格式和文字返回位置。API Key 仍由已选 API 连接保存。Headers 和请求 JSON 可使用 {"{{apiKey}}"}、{"{{model}}"}、{"{{question}}"}、{"{{systemPrompt}}"}、{"{{videoDataUrl}}"}、{"{{videoBase64}}"}、{"{{videoMimeType}}"}、{"{{fps}}"}、{"{{maxOutputTokens}}"}、{"{{temperature}}"}。</p></div>
      {feedback ? <div className="voice-settings-copy"><p>{feedback}</p></div> : null}
      <form className="voice-form voice-contact-config-form" onSubmit={save}>
        <label>协议备注名<input autoFocus disabled={saving} maxLength="80" name="name" required /></label>
        <label>服务地址<input disabled={saving} maxLength="500" name="baseUrl" required /></label>
        <label>请求路径<input defaultValue="/chat/completions" disabled={saving} maxLength="300" name="endpointPath" required /></label>
        <label>请求 Headers（JSON）<textarea defaultValue={'{"Authorization":"Bearer {{apiKey}}","Content-Type":"application/json"}'} disabled={saving} maxLength="8000" name="requestHeaders" required /></label>
        <label>请求 JSON<textarea defaultValue={'{\n  "model": "{{model}}",\n  "messages": [\n    { "role": "system", "content": "{{systemPrompt}}" },\n    {\n      "role": "user",\n      "content": [\n        { "type": "text", "text": "{{question}}" },\n        { "type": "video_url", "video_url": { "url": "{{videoDataUrl}}" } }\n      ]\n    }\n  ]\n}'} disabled={saving} maxLength="24000" name="requestBody" required /></label>
        <label>文字返回位置<input defaultValue="choices[0].message.content" disabled={saving} maxLength="300" name="responseTextPath" required /></label>
        <div className="voice-form-actions"><button className="secondary-button" disabled={saving} onClick={close} type="button">取消</button><button className="primary-button" disabled={saving}>{saving ? "正在保存…" : "保存协议"}</button></div>
      </form>
    </CreateStudioDialog>
  );
}

const VOICE_SERVICE_CUSTOM_PROTOCOL_PREFIX = "custom:";
const VOICE_SERVICE_PROTOCOL_OPTIONS = Object.freeze(TTS_ADAPTER_OPTIONS
  .filter((option) => option.value !== "custom-http-tts")
  .map((option) => ({ label: option.label, value: option.value })));

function voiceServiceProtocolSelection(value) {
  const selected = String(value || "").trim();
  if (selected.startsWith(VOICE_SERVICE_CUSTOM_PROTOCOL_PREFIX)) {
    return {
      adapter: "custom-http-tts",
      customAdapterId: selected.slice(VOICE_SERVICE_CUSTOM_PROTOCOL_PREFIX.length),
    };
  }
  return {
    adapter: selected || "dashscope-qwen",
    customAdapterId: "",
  };
}

function voiceServiceTypeLabel(adapter, customProtocol = null) {
  return adapter === "custom-http-tts" ? customProtocol?.name || "自定义协议" : ttsAdapterLabel(adapter);
}

function compatibleVoiceApiConnections(apiConnections, adapter) {
  const types = ttsAdapterDefinition(adapter)?.connectionTypes || [];
  return (Array.isArray(apiConnections) ? apiConnections : []).filter((connection) => (
    connection?.type === "tts-api" || types.includes(connection?.type)
  ));
}

function VoiceServiceDialog({ apiConnections, customProtocols, onClose, onOpenApiServices, onOpenCustomProtocol, onSaved, open, service, voiceDesign }) {
  const [protocol, setProtocol] = useState("dashscope-qwen");
  const [connectionId, setConnectionId] = useState("");
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [feedback, setFeedback] = useState("");
  const [saving, setSaving] = useState(false);
  const editing = Boolean(service?.id);
  const savedCustomProtocols = Array.isArray(customProtocols) ? customProtocols : [];
  const configuredAdapter = service?.adapter || "dashscope-qwen";
  const configuredCustomProtocolId = String(service?.customAdapterId || "").trim().toLowerCase();
  const configuredCustomProtocol = savedCustomProtocols.find((item) => String(item.id || "").trim().toLowerCase() === configuredCustomProtocolId) || null;
  const unavailableConfiguredProtocol = configuredAdapter === "custom-http-tts" && !configuredCustomProtocol;
  const configuredProtocol = configuredAdapter === "custom-http-tts" && configuredCustomProtocol
    ? `${VOICE_SERVICE_CUSTOM_PROTOCOL_PREFIX}${configuredCustomProtocol.id}`
    : unavailableConfiguredProtocol
      ? configuredCustomProtocolId ? `${VOICE_SERVICE_CUSTOM_PROTOCOL_PREFIX}${configuredCustomProtocolId}` : configuredAdapter
      : configuredAdapter;
  const selectedProtocol = voiceServiceProtocolSelection(protocol);
  const serviceType = selectedProtocol.adapter;
  const customProtocolId = selectedProtocol.customAdapterId;
  const availableConnections = compatibleVoiceApiConnections(apiConnections, serviceType);
  const protocolOptions = [
    ...(unavailableConfiguredProtocol ? [{ label: "已不可用的自定义协议", value: configuredProtocol }] : []),
    ...VOICE_SERVICE_PROTOCOL_OPTIONS,
    ...savedCustomProtocols.map((item) => ({ label: item.name, value: `${VOICE_SERVICE_CUSTOM_PROTOCOL_PREFIX}${item.id}` })),
  ];

  useEffect(() => {
    if (!open) return;
    setProtocol(configuredProtocol);
    setConnectionId(service?.connectionId || "");
    setName(service?.name || "");
    setModel(service?.model || ttsAdapterDefinition(configuredAdapter)?.defaultModel || "");
    setFeedback("");
  }, [configuredAdapter, configuredProtocol, open, service]);

  useEffect(() => {
    if (!open) return;
    if (!availableConnections.some((connection) => connection.id === connectionId)) {
      setConnectionId(availableConnections[0]?.id || "");
    }
  }, [availableConnections, connectionId, open]);

  const changeProtocol = (nextProtocol) => {
    const next = voiceServiceProtocolSelection(nextProtocol);
    setProtocol(nextProtocol);
    setModel(ttsAdapterDefinition(next.adapter)?.defaultModel || "");
  };
  const close = () => { if (!saving) onClose?.(); };
  const save = async (event) => {
    event.preventDefault();
    if (saving || typeof voiceDesign?.saveService !== "function") return;
    setSaving(true);
    setFeedback("");
    try {
      const next = await voiceDesign.saveService({
        ...(service?.id ? { id: service.id } : {}),
        adapter: serviceType,
        connectionId,
        customAdapterId: serviceType === "custom-http-tts" ? customProtocolId : "",
        model,
        name,
      });
      onSaved?.(next);
      onClose?.();
    } catch (error) {
      setFeedback(error?.message || "语音适配器没有保存，请检查填写内容。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <CreateStudioDialog ariaLabel={editing ? "编辑语音适配器" : "新增语音适配器"} onClose={close} open={open}>
      <SettingsDialogHeader onClose={close} title={editing ? "编辑语音适配器" : "新增语音适配器"}>语音适配器</SettingsDialogHeader>
      <div className="voice-settings-copy"><p>一个语音适配器对应一套请求协议、一条已保存的 API 连接和默认模型。音色会引用这项适配器，联系人只需要选择音色。</p></div>
      {feedback ? <div className="voice-settings-copy"><p>{feedback}</p></div> : null}
      <form className="voice-form voice-contact-config-form" onSubmit={save}>
        <label>适配器备注名<input autoFocus disabled={saving} maxLength="80" onChange={(event) => setName(event.target.value)} required value={name} /></label>
        <label className="voice-service-protocol-field"><span>请求协议</span><div className="voice-service-protocol-field__controls"><Select className="create-select-react" disabled={saving} fullWidth onChange={changeProtocol} options={protocolOptions} value={protocol} /><Button onClick={() => onOpenCustomProtocol?.()} type="button" variant="secondary">新增自定义协议</Button></div><small>{unavailableConfiguredProtocol ? "当前自定义协议已不可用，请选择其他协议后保存。" : serviceType === "custom-http-tts" ? "请求格式保存在所选协议中；API Key 继续使用下方选择的 API 连接。" : ttsAdapterDefinition(serviceType)?.detail || "选择语音适配器使用的请求格式。"}</small></label>
        <label>API 连接<Select className="create-select-react" disabled={saving || !availableConnections.length} fullWidth onChange={setConnectionId} options={availableConnections.length ? availableConnections.map((connection) => ({ label: `${connection.name}${connection.configured ? "" : "（未填写 Key）"}`, value: connection.id })) : [{ label: "没有兼容的已保存 API", value: "" }]} value={connectionId} /></label>
        {!availableConnections.length ? <div className="voice-form-actions"><button className="secondary-button" disabled={saving} onClick={() => onOpenApiServices?.()} type="button">前往 API 设置</button></div> : null}
        <label>默认模型<input disabled={saving} maxLength="160" onChange={(event) => setModel(event.target.value)} placeholder="可留空" value={model} /></label>
        <div className="voice-form-actions"><button className="secondary-button" disabled={saving} onClick={close} type="button">取消</button><button className="primary-button" disabled={saving || !connectionId || (serviceType === "custom-http-tts" && !customProtocolId)}>{saving ? "正在保存…" : editing ? "保存修改" : "保存语音适配器"}</button></div>
      </form>
    </CreateStudioDialog>
  );
}

function VoiceProfileDialog({ onClose, onSaved, open, profile, services, voiceDesign }) {
  const [serviceId, setServiceId] = useState("");
  const [name, setName] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [model, setModel] = useState("");
  const [feedback, setFeedback] = useState("");
  const [saving, setSaving] = useState(false);
  const editing = Boolean(profile?.id);
  const serviceOptions = (Array.isArray(services) ? services : []).map((service) => ({
    label: `${service.name} · ${voiceServiceTypeLabel(service.adapter)}`,
    value: service.id,
  }));
  const selectedService = (Array.isArray(services) ? services : []).find((service) => service.id === serviceId) || null;

  useEffect(() => {
    if (!open) return;
    setServiceId(profile?.serviceId || services?.[0]?.id || "");
    setName(profile?.name || "");
    setVoiceId(profile?.voiceId || "");
    setModel(profile?.model || "");
    setFeedback("");
  }, [open, profile, services]);

  const close = () => { if (!saving) onClose?.(); };
  const save = async (event) => {
    event.preventDefault();
    if (saving || typeof voiceDesign?.saveProfile !== "function") return;
    setSaving(true);
    setFeedback("");
    try {
      const next = await voiceDesign.saveProfile({
        ...(profile?.id ? { id: profile.id } : {}),
        model,
        name,
        serviceId,
        voiceId,
      });
      onSaved?.(next);
      onClose?.();
    } catch (error) {
      setFeedback(error?.message || "音色没有保存，请检查填写内容。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <CreateStudioDialog ariaLabel={editing ? "编辑音色" : "新增音色"} onClose={close} open={open}>
      <SettingsDialogHeader onClose={close} title={editing ? "编辑音色" : "新增音色"}>音色</SettingsDialogHeader>
      <div className="voice-settings-copy"><p>音色属于一个语音适配器。联系人选中它后，会自动使用该适配器的 API 连接、协议和模型。</p></div>
      {feedback ? <div className="voice-settings-copy"><p>{feedback}</p></div> : null}
      <form className="voice-form voice-contact-config-form" onSubmit={save}>
        <label>声音备注名<input autoFocus disabled={saving} maxLength="80" onChange={(event) => setName(event.target.value)} required value={name} /></label>
        <label>语音适配器<Select className="create-select-react" disabled={saving || !serviceOptions.length} fullWidth onChange={setServiceId} options={serviceOptions.length ? serviceOptions : [{ label: "请先新增语音适配器", value: "" }]} value={serviceId} /></label>
        <label>音色 ID<input disabled={saving} maxLength="200" onChange={(event) => setVoiceId(event.target.value)} placeholder="填写服务商提供的 voice ID" required value={voiceId} /></label>
        <label>模型（可选）<input disabled={saving} maxLength="160" onChange={(event) => setModel(event.target.value)} placeholder={selectedService?.model || "留空时使用语音适配器的默认模型"} value={model} /></label>
        <div className="voice-form-actions"><button className="secondary-button" disabled={saving} onClick={close} type="button">取消</button><button className="primary-button" disabled={saving || !serviceId}>{saving ? "正在保存…" : editing ? "保存修改" : "保存音色"}</button></div>
      </form>
    </CreateStudioDialog>
  );
}

function VoiceMessageSettings({ actions, apiServices, capability, contactsSnapshot }) {
  const [voiceDialogOpen, setVoiceDialogOpen] = useState(false);
  const [serviceDraft, setServiceDraft] = useState(null);
  const [profileDraft, setProfileDraft] = useState(null);
  const [customProtocolOpen, setCustomProtocolOpen] = useState(false);
  const [voiceSnapshot, setVoiceSnapshot] = useState(null);
  const [voiceError, setVoiceError] = useState("");
  const [deletingServiceId, setDeletingServiceId] = useState("");
  const [deletingProfileId, setDeletingProfileId] = useState("");
  const [deletingLegacyVoiceId, setDeletingLegacyVoiceId] = useState("");

  const refreshVoice = async () => {
    try {
      const next = await actions.voiceDesign?.snapshot();
      setVoiceSnapshot(next || null);
      setVoiceError("");
    } catch (error) {
      setVoiceError(error?.message || "无法读取语音设置。");
    }
  };
  useEffect(() => { void refreshVoice(); }, []);

  const voiceServices = Array.isArray(voiceSnapshot?.voiceServices) ? voiceSnapshot.voiceServices : [];
  const voiceProfiles = Array.isArray(voiceSnapshot?.voiceProfiles) ? voiceSnapshot.voiceProfiles : [];
  const legacyVoices = Array.isArray(voiceSnapshot?.customVoices) ? voiceSnapshot.customVoices : [];
  const customProtocols = Array.isArray(voiceSnapshot?.customTtsAdapters) ? voiceSnapshot.customTtsAdapters : [];
  const apiConnections = Array.isArray(apiServices?.connections) ? apiServices.connections : [];
  const apiBindings = apiServices?.bindings && typeof apiServices.bindings === "object" ? apiServices.bindings : {};
  const asrConnections = apiConnections.filter((connection) => (API_BINDINGS.find((item) => item.id === "realtime-asr")?.types || []).includes(connection.type));
  const connectionNames = new Map(apiConnections.map((connection) => [connection.id, connection.name]));

  const updateSnapshot = (next) => {
    if (next?.status) setVoiceSnapshot(next);
  };
  const deleteService = async (service) => {
    if (!service?.id || deletingServiceId) return;
    setDeletingServiceId(service.id);
    setVoiceError("");
    try {
      updateSnapshot(await actions.voiceDesign?.deleteService({ id: service.id }));
    } catch (error) {
      setVoiceError(error?.message || "删除语音适配器失败，请稍后重试。");
    } finally {
      setDeletingServiceId("");
    }
  };
  const deleteProfile = async (profile) => {
    if (!profile?.id || deletingProfileId) return;
    setDeletingProfileId(profile.id);
    setVoiceError("");
    try {
      updateSnapshot(await actions.voiceDesign?.deleteProfile({ id: profile.id }));
    } catch (error) {
      setVoiceError(error?.message || "删除音色失败，请稍后重试。");
    } finally {
      setDeletingProfileId("");
    }
  };
  const deleteLegacyVoice = async (voice) => {
    if (!voice?.id || deletingLegacyVoiceId) return;
    setDeletingLegacyVoiceId(voice.id);
    setVoiceError("");
    try {
      updateSnapshot(await actions.voiceDesign?.deleteCustomVoice({
        id: voice.id,
        source: voice.source || "",
        sourceContactId: voice.sourceContactId || "",
      }));
    } catch (error) {
      setVoiceError(error?.message || "删除音色失败，请稍后重试。");
    } finally {
      setDeletingLegacyVoiceId("");
    }
  };
  return (
    <>
      <SettingSurface
        action={<Button onClick={() => setServiceDraft({})} type="button" variant="secondary">新建语音适配器</Button>}
        description="每项语音适配器单独选择请求协议、API 连接和默认模型，可以同时保留多个适配器。"
        eyebrow="VOICE ADAPTERS"
        title="语音适配器"
      >
        {voiceError ? <p className="voice-settings-copy">{voiceError}</p> : null}
        {voiceServices.length ? <div className="voice-candidate-list">{voiceServices.map((service) => (
          <article className="voice-candidate" key={service.id}>
            <div className="voice-candidate-copy">
              <span className="reference-kicker">{voiceServiceTypeLabel(service.adapter, customProtocols.find((protocol) => String(protocol.id || "").trim().toLowerCase() === String(service.customAdapterId || "").trim().toLowerCase()))}</span>
              <h3>{service.name}</h3>
              <p>{connectionNames.get(service.connectionId) || "已移除的 API 连接"}{service.model ? ` · 模型 ${service.model}` : ""}</p>
            </div>
            <div className="voice-candidate-actions">
              <button className="secondary-button" onClick={() => setServiceDraft(service)} type="button">编辑</button>
              <button className="danger-button" disabled={deletingServiceId === service.id} onClick={() => void deleteService(service)} type="button">{deletingServiceId === service.id ? "正在删除…" : "删除"}</button>
            </div>
          </article>
        ))}</div> : <Empty className="capability-inline-empty" description="先新建一项语音适配器，并选择它使用的 API 连接。" title="暂无语音适配器" />}
      </SettingSurface>
      <SettingSurface
        action={<div className="voice-candidate-actions"><Button onClick={() => setVoiceDialogOpen(true)} type="button" variant="secondary">配置联系人音色</Button><Button onClick={() => setProfileDraft({})} type="button" variant="secondary">新建音色</Button></div>}
        description="音色绑定到一项语音适配器；联系人只需选择音色，不需要再分别配置 API。"
        eyebrow="VOICES"
        title="音色"
      >
        {voiceProfiles.length || legacyVoices.length ? <div className="voice-candidate-list">
          {voiceProfiles.map((profile) => (
            <article className="voice-candidate" key={profile.id}>
              <div className="voice-candidate-copy">
                <span className="reference-kicker">{profile.serviceName ? `${profile.serviceName} · ${voiceServiceTypeLabel(profile.adapter)}` : "语音适配器不可用"}</span>
                <h3>{profile.name}</h3>
                <p>{profile.model ? `模型 ${profile.model}` : "使用适配器默认模型"} · 音色 {profile.voiceId}</p>
              </div>
              <div className="voice-candidate-actions">
                <button className="secondary-button" onClick={() => setProfileDraft(profile)} type="button">编辑</button>
                <button className="danger-button" disabled={deletingProfileId === profile.id} onClick={() => void deleteProfile(profile)} type="button">{deletingProfileId === profile.id ? "正在删除…" : "删除"}</button>
              </div>
            </article>
          ))}
          {legacyVoices.map((voice) => (
            <article className="voice-candidate" key={voice.key}>
              <div className="voice-candidate-copy">
                <span className="reference-kicker">之前保存的音色 · {voice.kindLabel}</span>
                <h3>{voice.name}</h3>
                <p>{voice.model ? `模型 ${voice.model}` : "使用旧版默认模型"} · 音色 {voice.voiceId}</p>
              </div>
              <div className="voice-candidate-actions">
                <button className="danger-button" disabled={deletingLegacyVoiceId === voice.id} onClick={() => void deleteLegacyVoice(voice)} type="button">{deletingLegacyVoiceId === voice.id ? "正在删除…" : "删除"}</button>
              </div>
            </article>
          ))}
        </div> : <Empty className="capability-inline-empty" description="先创建语音适配器，再新增它可用的音色。" title="暂无音色" />}
      </SettingSurface>
      <SettingSurface description="语音通话时用这条 API 把声音转写为文字。" eyebrow="VOICE INPUT" title="语音输入">
        <ApiConnectionPicker
          connections={asrConnections}
          onManage={actions.openApiServices}
          onSelect={(connectionId) => actions.selectApiBinding?.("realtime-asr", connectionId)}
          selectedId={apiBindings["realtime-asr"] || ""}
          title="为语音识别选择 API"
        />
      </SettingSurface>
      <CapabilitySettingsForm abilityId="voice-message" actions={actions} submitLabel="保存灵敏度">
        <SettingSurface description="说话能量阈值越小越灵敏；静音判定帧数越多，一句话要停顿更久才算说完。" eyebrow="CALL" title="通话灵敏度">
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
      <ContactDeliverySettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} description="所选联系人可以调用语音消息，并使用各自选择的音色。" emptyDescription="先创建联系人，再选择允许哪些联系人使用语音消息。" />
      <VoiceContactConfigDialog onClose={() => setVoiceDialogOpen(false)} open={voiceDialogOpen} voiceDesign={actions.voiceDesign} />
      <VoiceServiceDialog apiConnections={apiConnections} customProtocols={customProtocols} onClose={() => setServiceDraft(null)} onOpenApiServices={actions.openApiServices} onOpenCustomProtocol={() => setCustomProtocolOpen(true)} onSaved={updateSnapshot} open={Boolean(serviceDraft)} service={serviceDraft?.id ? serviceDraft : null} voiceDesign={actions.voiceDesign} />
      <VoiceProfileDialog onClose={() => setProfileDraft(null)} onSaved={updateSnapshot} open={Boolean(profileDraft)} profile={profileDraft?.id ? profileDraft : null} services={voiceServices} voiceDesign={actions.voiceDesign} />
      <CustomTtsAdapterDialog onClose={() => setCustomProtocolOpen(false)} onSaved={updateSnapshot} open={customProtocolOpen} voiceDesign={actions.voiceDesign} />
    </>
  );
}

const IMAGE_VISION_CUSTOM_PROTOCOL_PREFIX = "custom:";
const VIDEO_UNDERSTANDING_CUSTOM_PROTOCOL_PREFIX = "custom:";

function imageVisionProtocolSelection(value) {
  const selected = String(value || "").trim();
  if (selected.startsWith(IMAGE_VISION_CUSTOM_PROTOCOL_PREFIX)) {
    return {
      adapter: "custom-http-vision",
      customAdapterId: selected.slice(IMAGE_VISION_CUSTOM_PROTOCOL_PREFIX.length),
    };
  }
  return {
    adapter: normalizeVisionAdapter(selected, { fallback: "openai-chat-completions" }),
    customAdapterId: "",
  };
}

function videoUnderstandingProtocolSelection(value) {
  const selected = String(value || "").trim();
  if (selected.startsWith(VIDEO_UNDERSTANDING_CUSTOM_PROTOCOL_PREFIX)) {
    return {
      adapter: "custom-http-video",
      customAdapterId: selected.slice(VIDEO_UNDERSTANDING_CUSTOM_PROTOCOL_PREFIX.length),
    };
  }
  return {
    adapter: normalizeVideoAdapter(selected, { fallback: "dashscope-openai-video" }),
    customAdapterId: "",
  };
}

function ImageVisionSettings({ actions, apiServices, capability, contactsSnapshot }) {
  const settings = savedSettings(capability);
  const vision = settings.vision || {};
  const configuredAdapter = normalizeVisionAdapter(vision.adapter, { fallback: "openai-chat-completions" });
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const customAdapters = Array.isArray(vision.customAdapters) ? vision.customAdapters : [];
  const configuredCustomAdapterId = String(vision.customAdapterId || "").trim().toLowerCase();
  const configuredCustomAdapter = customAdapters.find((protocol) => protocol.id === configuredCustomAdapterId) || null;
  const unavailableConfiguredProtocol = configuredAdapter === "custom-http-vision" && configuredCustomAdapterId && !configuredCustomAdapter;
  const configuredProtocol = configuredAdapter === "custom-http-vision" && configuredCustomAdapter
    ? `${IMAGE_VISION_CUSTOM_PROTOCOL_PREFIX}${configuredCustomAdapter.id}`
    : unavailableConfiguredProtocol
      ? `${IMAGE_VISION_CUSTOM_PROTOCOL_PREFIX}${configuredCustomAdapterId}`
      : configuredAdapter;
  const [protocol, setProtocol] = useState(configuredProtocol);
  const selectedProtocol = imageVisionProtocolSelection(protocol);
  const adapter = selectedProtocol.adapter;
  const adapterOptions = VISION_ADAPTER_OPTIONS
    .filter((option) => option.value !== "custom-http-vision")
    .map((option) => [option.value, option.label]);
  const protocolOptions = [
    ...(unavailableConfiguredProtocol ? [[configuredProtocol, "已不可用的自定义协议"]] : []),
    ...adapterOptions,
    ...customAdapters.map((item) => [`${IMAGE_VISION_CUSTOM_PROTOCOL_PREFIX}${item.id}`, item.name]),
  ];

  useEffect(() => {
    setProtocol(configuredProtocol);
  }, [configuredProtocol]);

  return (
    <>
      <CapabilitySettingsForm abilityId="image-vision" actions={actions}>
        <SettingSurface description="选择图片理解请求格式和使用的 API。主模型本身支持视觉时，聊天会直接使用主模型，不受这里限制。" eyebrow="图像理解" title="请求方式">
          <FormGrid>
            <div className="capability-form-field image-vision-protocol-field">
              <span>请求协议</span>
              <div className="image-vision-protocol-field__controls">
                <ChoiceSelect name="imageVisionProtocol" onChange={setProtocol} options={protocolOptions} value={protocol} />
                <Button onClick={() => setCustomDialogOpen(true)} type="button" variant="secondary">新增自定义协议</Button>
              </div>
              <input name="adapter" type="hidden" value={adapter} />
              <input name="customAdapterId" type="hidden" value={selectedProtocol.customAdapterId} />
              <small>{unavailableConfiguredProtocol ? "当前自定义协议已不可用，请选择其他协议后保存。" : adapter === "custom-http-vision" ? "请求格式保存在所选协议中；API Key 继续使用下方选择的 API 连接。" : visionAdapterDefinition(adapter)?.detail || "选择图片理解服务使用的请求格式。"}</small>
            </div>
            <ApiBinding actions={actions} apiServices={apiServices} bindingId="image-vision" connectionFilter={(connection) => visionAdapterSupportsConnection(adapter, connection.type)} />
          </FormGrid>
        </SettingSurface>
      </CapabilitySettingsForm>
      <ContactDeliverySettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} description="为联系人启用后，Suzu 会在需要时使用这里的 API 读取图片内容。" emptyDescription="先创建联系人，再选择哪些联系人可以使用图像理解。" />
      <CustomVisionAdapterDialog imageVisionDesign={actions.imageVisionDesign} onClose={() => setCustomDialogOpen(false)} open={customDialogOpen} />
    </>
  );
}

function VideoUnderstandingSettings({ actions, apiServices, capability, contactsSnapshot }) {
  const settings = savedSettings(capability);
  const video = settings.video || {};
  const configuredAdapter = normalizeVideoAdapter(video.adapter, { fallback: "dashscope-openai-video" });
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const customAdapters = Array.isArray(video.customAdapters) ? video.customAdapters : [];
  const configuredCustomAdapterId = String(video.customAdapterId || "").trim().toLowerCase();
  const configuredCustomAdapter = customAdapters.find((protocol) => protocol.id === configuredCustomAdapterId) || null;
  const unavailableConfiguredProtocol = configuredAdapter === "custom-http-video" && configuredCustomAdapterId && !configuredCustomAdapter;
  const configuredProtocol = configuredAdapter === "custom-http-video" && configuredCustomAdapter
    ? `${VIDEO_UNDERSTANDING_CUSTOM_PROTOCOL_PREFIX}${configuredCustomAdapter.id}`
    : unavailableConfiguredProtocol
      ? `${VIDEO_UNDERSTANDING_CUSTOM_PROTOCOL_PREFIX}${configuredCustomAdapterId}`
      : configuredAdapter;
  const [protocol, setProtocol] = useState(configuredProtocol);
  const selectedProtocol = videoUnderstandingProtocolSelection(protocol);
  const adapter = selectedProtocol.adapter;
  const adapterOptions = VIDEO_ADAPTER_OPTIONS
    .filter((option) => option.value !== "custom-http-video")
    .map((option) => [option.value, option.label]);
  const protocolOptions = [
    ...(unavailableConfiguredProtocol ? [[configuredProtocol, "已不可用的自定义协议"]] : []),
    ...adapterOptions,
    ...customAdapters.map((item) => [`${VIDEO_UNDERSTANDING_CUSTOM_PROTOCOL_PREFIX}${item.id}`, item.name]),
  ];

  useEffect(() => {
    setProtocol(configuredProtocol);
  }, [configuredProtocol]);

  return (
    <>
      <CapabilitySettingsForm abilityId="video-understanding" actions={actions}>
        <SettingSurface description="选择完整视频输入的请求格式和使用的 API。" eyebrow="理解视频" title="请求方式">
          <FormGrid>
            <div className="capability-form-field video-understanding-protocol-field">
              <span>请求协议</span>
              <div className="video-understanding-protocol-field__controls">
                <ChoiceSelect name="videoUnderstandingProtocol" onChange={setProtocol} options={protocolOptions} value={protocol} />
                <Button onClick={() => setCustomDialogOpen(true)} type="button" variant="secondary">新增自定义协议</Button>
              </div>
              <input name="adapter" type="hidden" value={adapter} />
              <input name="customAdapterId" type="hidden" value={selectedProtocol.customAdapterId} />
              <small>{unavailableConfiguredProtocol ? "当前自定义协议已不可用，请选择其他协议后保存。" : adapter === "custom-http-video" ? "请求格式保存在所选协议中；API Key 继续使用下方选择的 API 连接。" : videoAdapterDefinition(adapter)?.detail || "选择视频理解服务使用的请求格式。"}</small>
            </div>
            <ApiBinding actions={actions} apiServices={apiServices} bindingId="video-understanding" connectionFilter={(connection) => videoAdapterSupportsConnection(adapter, connection.type)} />
          </FormGrid>
        </SettingSurface>
      </CapabilitySettingsForm>
      <ContactDeliverySettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} description="所选联系人会通过 Suzu Agent Core 使用这里的视频读取偏好与 API。" emptyDescription="先创建联系人，再选择允许哪些联系人使用视频理解。" />
      <CustomVideoAdapterDialog onClose={() => setCustomDialogOpen(false)} open={customDialogOpen} videoUnderstandingDesign={actions.videoUnderstandingDesign} />
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
      <SettingSurface description="每位已启用的联系人都通过同一个 Suzu 专用浏览器操作任意已登录网页。网站登录态保存在本机专用 profile，与联系人工作目录分开。" eyebrow="WEB BROWSER" title="专用浏览器">
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
          <SettingSurface action={submitButton} description="每次检查时，Suzu 先判断此刻是否联系，再依据相处节奏给出下一次检查时间；软件会按该时间安排下一次检查。这里用于补充这段关系的联系语气、节奏与边界。" eyebrow="主动关心" title="联系判断">
            <AsyncSwitchRow
              checked={capability.enabled === true && autoMaintain}
              description="软件启动或为联系人启用后会安排第一次联系判断；之后由 Suzu 的时间判断决定下一次检查。"
              disabled={capability.enabled !== true}
              label="自动安排联系检查"
              onChange={(enabled) => actions.saveSettings?.("proactive-contact", { autoMaintain: enabled })}
            />
            <FormGrid>
              <FormField className="capability-form-field--wide" label="主动关心补充原则"><textarea defaultValue={settings.contactPrompt || ""} maxLength="12000" name="contactPrompt" /></FormField>
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
        <SettingSurface description="每天由软件创建一次内部回合，让对应 Agent 回顾当天值得留下的事。日记独立保存在本机，供关系页按联系人浏览，并与聊天、微信和长期记忆分开管理。" eyebrow="AGENT JOURNAL" title="每天写日记">
          <FormGrid>
            <FormField hint="日记在软件运行时按设定时间写入；默认是每天 00:02。" label="记录时间"><input defaultValue={settings.time || "00:02"} name="time" required type="time" /></FormField>
          </FormGrid>
        </SettingSurface>
      </CapabilitySettingsForm>
      <ContactDeliverySettings actions={actions} capability={capability} contactsSnapshot={contactsSnapshot} description="打开后，这位联系人的 Agent 会在设定时间写当天的日记；可以同时开启多个联系人。日记可在“关系 → 查看日记”中浏览。" emptyDescription="先创建联系人，再选择哪些 Agent 需要每天写日记。" />
    </>
  );
}

function MailAgentSkillDialog({ actions, onClose, open, skill }) {
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const editing = Boolean(skill?.id);
  const close = () => { if (!saving) onClose?.(); };
  const save = async (event) => {
    event.preventDefault();
    if (saving || typeof actions.saveSettings !== "function") return;
    setSaving(true);
    setFeedback("");
    try {
      const result = await actions.saveSettings("mail-bridge", formValue(event.currentTarget));
      if (result?.ok) onClose?.();
      else setFeedback(result?.error?.message || "邮件业务 Skill 没有保存，请检查填写内容。 ");
    } catch (error) {
      setFeedback(error?.message || "邮件业务 Skill 没有保存，请稍后重试。 ");
    } finally {
      setSaving(false);
    }
  };
  return (
    <CreateStudioDialog ariaLabel={editing ? "编辑邮件业务 Skill" : "新增邮件业务 Skill"} className="mail-bridge-config-dialog" onClose={close} open={open}>
      <SettingsDialogHeader onClose={close} title={editing ? "编辑邮件业务 Skill" : "新增邮件业务 Skill"}>邮件业务</SettingsDialogHeader>
      <div className="voice-settings-copy"><p>这项 Skill 会出现在 Agent 的技能目录中：它先告诉 Agent 什么时候需要发邮件、发什么主题；发送方式则由“邮箱通道” Skill 提供。</p></div>
      {feedback ? <div className="voice-settings-copy"><p>{feedback}</p></div> : null}
      <form className="mail-bridge-config-form" onSubmit={save}>
        <input defaultValue={skill?.id || ""} name="mailSkillId" type="hidden" />
        <FormGrid>
          <FormField hint="例如：查岗、日报、提醒。这个名称会直接显示在 Agent 的技能目录中。" label="Skill 名称"><input autoFocus defaultValue={skill?.name || ""} disabled={saving} maxLength="100" name="mailSkillName" required /></FormField>
          <FormField hint="例如：查岗。Agent 发这类邮件时会使用这个主题。" label="邮件主题"><input defaultValue={skill?.subject || ""} disabled={saving} maxLength="200" name="mailSkillSubject" required /></FormField>
          <FormField className="capability-form-field--wide" hint="写清这项 Skill 在什么情况下使用、要让收件方做什么；不要写邮箱地址或服务器参数。" label="何时使用"><textarea defaultValue={skill?.description || ""} disabled={saving} maxLength="4000" name="mailSkillDescription" required /></FormField>
        </FormGrid>
        <footer className="mail-bridge-config-form__actions"><Button disabled={saving} onClick={close} type="button" variant="secondary">取消</Button><Button disabled={saving} type="submit">{saving ? "正在保存…" : editing ? "保存修改" : "新增邮件 Skill"}</Button></footer>
      </form>
    </CreateStudioDialog>
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
      <div className="voice-settings-copy"><p>这里仅设置本机用于收发的邮箱。Agent 要发什么类型的邮件、使用什么主题，请在“邮件业务 Skill”中设置；授权码不会写进页面或能力快照。</p></div>
      {feedback ? <div className="voice-settings-copy"><p>{feedback}</p></div> : null}
      <form className="mail-bridge-config-form" onSubmit={save}>
        <div className="capability-form-grid-react">
          <FormField label="发件邮箱"><input defaultValue={configuration.sender || ""} maxLength="320" name="sender" required type="email" /></FormField>
          <FormField hint="Agent 发出的邮件都会投递到这个地址。" label="投递收件邮箱"><input defaultValue={configuration.recipient || ""} maxLength="320" name="recipient" required type="email" /></FormField>
          <FormField label="收信邮箱"><input defaultValue={configuration.username || ""} maxLength="320" name="username" required type="email" /></FormField>
          <FormField hint="只有这个主题的邮件会作为回信投递给已勾选的联系人。" label="接收回信的主题"><input defaultValue={configuration.feedbackSubject || "Suzu"} maxLength="200" name="feedbackSubject" required /></FormField>
          <FormField className="capability-form-field--wide" hint="每行一个地址；只有这些地址发来的邮件会被当作回信。" label="允许接收回信的发件人"><textarea defaultValue={allowedSenders} maxLength="9600" name="allowedSenders" required /></FormField>
          <FormField className="capability-form-field--wide" hint="例如 SUZU_MAIL_PASSWORD。实际授权码只由本机进程从这个环境变量读取。" label="邮箱授权码环境变量"><input defaultValue={configuration.passwordEnv || "SUZU_MAIL_PASSWORD"} maxLength="128" name="passwordEnv" required /></FormField>
        </div>
        <details className="mail-bridge-config-form__advanced">
          <summary>高级服务器设置</summary>
          <p>常见邮箱可保持默认值；只有邮箱服务商提供了不同服务器或端口时才需要修改。</p>
          <FormGrid>
            <FormField label="发信服务器"><input defaultValue={configuration.smtpHost || "smtp.163.com"} maxLength="320" name="smtpHost" required /></FormField>
            <FormField label="发信端口"><input defaultValue={configuration.smtpPort ?? 465} max="65535" min="1" name="smtpPort" required type="number" /></FormField>
            <FormField label="收信服务器"><input defaultValue={configuration.imapHost || "imap.163.com"} maxLength="320" name="imapHost" required /></FormField>
            <FormField label="收信端口"><input defaultValue={configuration.imapPort ?? 993} max="65535" min="1" name="imapPort" required type="number" /></FormField>
            <FormField className="capability-form-field--wide" label="收件箱名称"><input defaultValue={configuration.mailbox || "INBOX"} maxLength="160" name="mailbox" required /></FormField>
          </FormGrid>
        </details>
        <footer className="mail-bridge-config-form__actions"><Button disabled={saving} onClick={close} type="button" variant="secondary">取消</Button><Button disabled={saving} type="submit">{saving ? "正在保存…" : "保存邮箱通道"}</Button></footer>
      </form>
    </CreateStudioDialog>
  );
}

function MailBridgeSettings({ actions, capability, contactsSnapshot }) {
  const [configOpen, setConfigOpen] = useState(false);
  const [skillDraft, setSkillDraft] = useState(null);
  const [removingSkillId, setRemovingSkillId] = useState("");
  const [feedback, setFeedback] = useState("");
  const settings = savedSettings(capability);
  const configuration = settings.configuration || {};
  const agentSkills = Array.isArray(configuration.agentSkills) ? configuration.agentSkills : [];
  const connectionStatus = settings.saved
    ? "邮箱连接已保存。软件会从本机环境变量读取授权码。"
    : "还没有完成邮箱连接；先配置连接后才能实际收发邮件。";
  const removeSkill = async (skill) => {
    if (!skill?.id || removingSkillId || typeof actions.saveSettings !== "function") return;
    setRemovingSkillId(skill.id);
    setFeedback("");
    try {
      const result = await actions.saveSettings("mail-bridge", { removeMailSkillId: skill.id });
      if (!result?.ok) setFeedback(result?.error?.message || "邮件业务 Skill 没有删除，请稍后重试。 ");
    } catch (error) {
      setFeedback(error?.message || "邮件业务 Skill 没有删除，请稍后重试。 ");
    } finally {
      setRemovingSkillId("");
    }
  };
  return (
    <>
      <SettingSurface action={<Button onClick={() => setSkillDraft({})} type="button">新增邮件 Skill</Button>} description="每条业务 Skill 都会出现在 Agent 的技能目录中。Agent 先读它，知道何时发哪封邮件；再读取邮箱通道，按指定主题投递。" eyebrow="MAIL SKILLS" title="邮件业务 Skill">
        {feedback ? <div className="voice-settings-copy"><p>{feedback}</p></div> : null}
        {agentSkills.length ? <div className="mail-agent-skill-list">{agentSkills.map((skill) => <article className="mail-agent-skill" key={skill.id}><div className="mail-agent-skill__copy"><strong>{skill.name}</strong><p>{skill.description}</p><small>{`邮件主题：${skill.subject}`}</small></div><div className="mail-agent-skill__actions"><Button disabled={Boolean(removingSkillId)} onClick={() => setSkillDraft(skill)} type="button" variant="secondary">编辑</Button><Button disabled={Boolean(removingSkillId)} onClick={() => removeSkill(skill)} type="button" variant="danger">{removingSkillId === skill.id ? "正在删除…" : "删除"}</Button></div></article>)}</div> : <Empty description="新增一条业务动作，例如“查岗”。它会告诉 Agent 何时发信，以及该用什么主题。" title="还没有邮件业务 Skill" />}
      </SettingSurface>
      <SettingSurface action={<Button onClick={() => setConfigOpen(true)} type="button" variant="secondary">配置邮箱连接</Button>} description={connectionStatus} eyebrow="MAIL CONNECTION" title="本地邮箱收发" />
      <ContactDeliverySettings actions={actions} capability={capability} description="勾选后，对应联系人可以使用这里的邮件业务 Skill，也会接收符合回信设置的邮件；可以同时选择多个联系人。" contactsSnapshot={contactsSnapshot} />
      <MailAgentSkillDialog actions={actions} key={skillDraft?.id || "new"} onClose={() => setSkillDraft(null)} open={skillDraft !== null} skill={skillDraft} />
      <MailBridgeConfigDialog actions={actions} capability={capability} onClose={() => setConfigOpen(false)} open={configOpen} />
    </>
  );
}

function WechatSettings({ actions, wechatSnapshot }) {
  const settings = wechatConnectionSettings(wechatSnapshot);
  return (
    <section className="capability-settings-stack">
      <SettingSurface description="选择已连接微信要接收的消息类型。" eyebrow="WECHAT" title="投送到微信的内容">
        <div className="capability-delivery-grid">
          {WECHAT_DELIVERY_OPTIONS.map(([key, label, description]) => <AsyncSwitchRow checked={settings.delivery[key] === true} description={description} key={key} label={label} onChange={(enabled) => actions.saveWechatSettings?.({ delivery: { ...settings.delivery, [key]: enabled } })} />)}
        </div>
      </SettingSurface>
      <SettingSurface description="一段回复需要投递为多条微信消息时，按此方式决定拆分位置；超过微信单条长度上限时仍会继续自动拆分。" eyebrow="MESSAGE FORMAT" title="回复分段方式">
        <FormGrid>
          <FormField hint="空行分段会保留同一段内的完整内容；句子分段会按句号、问号和感叹号分别投递。" label="分段方式">
            <ChoiceSelect name="wechatTextSegmentation" onChange={(textSegmentation) => actions.saveWechatSettings?.({ textSegmentation })} options={WECHAT_TEXT_SEGMENTATION_OPTIONS} value={settings.textSegmentation} />
          </FormField>
        </FormGrid>
      </SettingSurface>
    </section>
  );
}

function qqBotStatusLabel(bot) {
  if (!bot?.configured) return "尚未配置机器人";
  if (bot.status === "connected") return "机器人已连接";
  if (bot.status === "connecting") return "正在连接机器人";
  if (bot.status === "attention") return "机器人需要处理";
  return "机器人设置已保存";
}

function QQSettings({ actions, qqSnapshot }) {
  const settings = qqConnectionSettings(qqSnapshot);
  const bot = settings.bot;
  const [appId, setAppId] = useState(bot.appId || "");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setAppId(bot.appId || "");
  }, [bot.appId]);
  const saveBot = async (event) => {
    event.preventDefault();
    if (saving || typeof actions.configureQqBot !== "function") return;
    setSaving(true);
    setError("");
    try {
      await actions.configureQqBot({ appId, clientSecret });
      setClientSecret("");
    } catch (nextError) {
      setError(nextError?.message || "QQ 机器人设置没有保存。 ");
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="capability-settings-stack">
      <SettingSurface description="这台设备通过一个 QQ 机器人接收和发送私聊消息。软件已预置机器人时无需填写；使用自己的机器人时，凭证会以系统加密方式保留在本机。" eyebrow="QQ BOT" title="QQ 机器人">
        <Status label={qqBotStatusLabel(bot)} tone={bot.status === "connected" ? "success" : bot.configured ? "muted" : "warning"} />
        {bot.lastError ? <p className="capability-settings-note">{bot.lastError}</p> : null}
        <form className="capability-settings-form-react" onSubmit={saveBot}>
          <FormGrid>
            <FormField className="capability-form-field--wide" hint="在 QQ 开放平台创建机器人的接入信息中查看。" label="AppID"><input autoComplete="off" disabled={saving} maxLength="128" onChange={(event) => setAppId(event.target.value)} required value={appId} /></FormField>
            <FormField className="capability-form-field--wide" hint={bot.configured ? "留空会保留当前 AppSecret。" : "仅保存在本机的系统加密存储中。"} label="AppSecret"><input autoComplete="new-password" disabled={saving} maxLength="500" onChange={(event) => setClientSecret(event.target.value)} placeholder={bot.configured ? "已保存" : "填写 AppSecret"} required={!bot.configured} type="password" value={clientSecret} /></FormField>
            <p className="capability-form-note">连接联系人时，请前往「对话」，打开想连接的联系人设置，在「QQ 连接」中生成并复制绑定码，再用 QQ 将绑定码发送给机器人即可。</p>
          </FormGrid>
          {error ? <p className="capability-settings-note">{error}</p> : null}
          <footer className="capability-settings-form-react__footer"><Button disabled={saving} type="submit" variant="secondary">{saving ? "正在保存…" : "保存机器人"}</Button></footer>
        </form>
      </SettingSurface>
      <SettingSurface description="选择已连接 QQ 要接收的消息类型。联系人从 QQ 发来消息时，回复只会回到 QQ。" eyebrow="QQ" title="投送到 QQ 的内容">
        <div className="capability-delivery-grid">
          {QQ_DELIVERY_OPTIONS.map(([key, label, description]) => <AsyncSwitchRow checked={settings.delivery[key] === true} description={description} key={key} label={label} onChange={(enabled) => actions.saveQqSettings?.({ delivery: { ...settings.delivery, [key]: enabled } })} />)}
        </div>
      </SettingSurface>
      <SettingSurface description="一段回复需要投递为多条 QQ 消息时，按此方式决定拆分位置。" eyebrow="MESSAGE FORMAT" title="回复分段方式">
        <FormGrid>
          <FormField hint="空行分段会保留同一段内的完整内容；句子分段会按句号、问号和感叹号分别投递。" label="分段方式">
            <ChoiceSelect name="qqTextSegmentation" onChange={(textSegmentation) => actions.saveQqSettings?.({ textSegmentation })} options={QQ_TEXT_SEGMENTATION_OPTIONS} value={settings.textSegmentation} />
          </FormField>
        </FormGrid>
      </SettingSurface>
    </section>
  );
}

function GenericCapabilitySettings() {
  return <SettingSurface description="当前没有需要单独调整的选项。" eyebrow="能力资料" title="这项能力已准备好" />;
}

function CapabilitySettings({ actions, apiServices, capability, contactsSnapshot, qqSnapshot, wechatSnapshot }) {
  if (capability.id === "wechat-connection") return <WechatSettings actions={actions} wechatSnapshot={wechatSnapshot} />;
  if (capability.id === "qq-connection") return <QQSettings actions={actions} qqSnapshot={qqSnapshot} />;
  if (capability.id === "image-generation") return <ImageGenerationSettings actions={actions} apiServices={apiServices} capability={capability} contactsSnapshot={contactsSnapshot} />;
  if (capability.id === "voice-message") return <VoiceMessageSettings actions={actions} apiServices={apiServices} capability={capability} contactsSnapshot={contactsSnapshot} />;
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
  qqSnapshot,
  wechatSnapshot,
}) {
  const category = categoryFor(categoryId);
  const title = capability.name;
  const subtitle = capability.description;
  const back = <Button onClick={() => actions.returnToCategory?.(category.id)} type="button" variant="secondary">返回{category.label}</Button>;
  const detailAction = CONTACT_SCOPED_CAPABILITY_IDS.has(capability.id)
      ? back
      : <div className="capability-detail-header-actions"><CapabilityHeaderToggle actions={actions} capability={capability} />{back}</div>;
  if (["wechat-connection", "qq-connection"].includes(capability.id)) {
    return (
      <PageScaffold
        canvasClassName="page-canvas--stack"
        className="capabilities-react-page capabilities-react-page--inner"
        header={<PageHeader action={back} eyebrow={"CAPABILITIES / " + category.label} subtitle={subtitle} title={title} />}
      >
        {capability.id === "qq-connection" ? <QQSettings actions={actions} qqSnapshot={qqSnapshot} /> : <WechatSettings actions={actions} wechatSnapshot={wechatSnapshot} />}
      </PageScaffold>
    );
  }
  return (
    <PageScaffold
      canvasClassName="page-canvas--stack"
      className="capabilities-react-page capabilities-react-page--inner"
      header={<PageHeader action={detailAction} eyebrow={"CAPABILITIES / " + category.label} subtitle={subtitle} title={title} />}
    >
      <CapabilitySettings actions={actions} apiServices={apiServices} capability={capability} contactsSnapshot={contactsSnapshot} qqSnapshot={qqSnapshot} wechatSnapshot={wechatSnapshot} />
    </PageScaffold>
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
        <div><strong>Agent Core 登记</strong><p>{capability.enabled ? "这项外部能力已登记到 Suzu 管理的 Agent Core。" : "启用后，Skill 会放入受管技能目录，MCP 会作为 Agent Core 工具连接。"}</p></div>
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
    <>
      <PageScaffold
        canvasClassName="page-canvas--stack"
        className="capabilities-react-page capabilities-react-page--inner"
        header={<PageHeader action={<Button onClick={actions.returnToOverview} type="button" variant="secondary">返回能力</Button>} eyebrow="CAPABILITIES / EXTERNAL" subtitle="外部 Skill 与 MCP 会以 Agent Core 方式安装到 Suzu 的运行时，可供所有联系人使用。" title="外部能力" />}
      >
        <SettingSurface description={runtimeHome || "Agent Core 会在首次使用时创建。"} eyebrow="全局运行时" title="Suzu Agent Core">
          <div className="capability-inline-action-react"><p>导入阶段会读取本地 suzu-capability.json 并显示静态检查结果。启用 MCP 后，Agent Core 会在下一次聊天时按清单启动它。</p><Button disabled={importing} onClick={importManifest} type="button" variant="secondary">{importing ? "正在导入…" : "导入 suzu-capability.json"}</Button></div>
        </SettingSurface>
        {capabilities.length ? <section className="external-capability-list">{capabilities.map((capability) => <ExternalCapabilityCard actions={actions} capability={capability} key={capability.id} onRemove={setRemoving} />)}</section> : <GlassPanel as="section" className="capability-empty-panel" intensity="soft"><Empty description="导入本地 suzu-capability.json 后，这里会显示 Skill/MCP 的静态诊断与 Agent Core 登记状态。" title="还没有外部能力" /></GlassPanel>}
      </PageScaffold>
      <CreateStudioDialog ariaLabel="移除外部能力" className="capability-remove-dialog" onClose={() => setRemoving(null)} open={Boolean(removing)}>
        <header><div><span>EXTERNAL CAPABILITY</span><h2>移除外部能力？</h2></div><button aria-label="关闭" className="suzu-close-button" onClick={() => setRemoving(null)} type="button">×</button></header>
        <p>{`“${removing?.name || "这项外部能力"}”会清理所有由 Suzu 登记的 Skill 与 MCP 条目；若检测到手动修改会中止并保留文件。`}</p>
        <footer><Button disabled={removingPending} onClick={() => setRemoving(null)} type="button" variant="secondary">取消</Button><Button disabled={removingPending} onClick={remove} type="button" variant="danger">{removingPending ? "正在移除…" : "移除能力"}</Button></footer>
      </CreateStudioDialog>
    </>
  );
}
