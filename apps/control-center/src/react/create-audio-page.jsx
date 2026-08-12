import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader, Select, Status } from "suzu-design-system";

import { CreateStudioDialog } from "./create-studio-dialog.jsx";

const LANGUAGES = Object.freeze([[
  "zh", "中文",
], ["en", "英语"], ["de", "德语"], ["it", "意大利语"], ["pt", "葡萄牙语"], ["es", "西班牙语"], ["ja", "日语"], ["ko", "韩语"], ["fr", "法语"], ["ru", "俄语"]]);
const LANGUAGE_OPTIONS = Object.freeze(LANGUAGES.map(([value, label]) => ({ label, value })));
const CUSTOM_AUDIO_PROVIDER_OPTIONS = Object.freeze([
  { label: "MiniMax", value: "minimax" },
  { label: "阿里百炼（CosyVoice v3.5 Plus 复刻）", value: "cosyvoice" },
]);
const EMPTY_CONFIG = Object.freeze({ designModel: "", language: "zh", namePrefix: "", responseFormat: "wav", sampleRate: 24000, targetModel: "" });
const EMPTY_DRAFT = Object.freeze({ count: 1, previewText: "", voicePrompt: "" });

function clean(value) {
  return String(value ?? "").trim();
}

function candidateName(item) {
  return item?.displayName || "未命名音色";
}

function FormSelect({ defaultValue, disabled = false, name, options, placeholder = "请选择" }) {
  const [value, setValue] = useState(String(defaultValue ?? ""));
  return (
    <>
      <input disabled={disabled} name={name} type="hidden" value={value} />
      <Select className="create-select-react" disabled={disabled} fullWidth onChange={setValue} options={options} placeholder={placeholder} value={value} />
    </>
  );
}

function dateLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚创建";
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function previewObjectUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(String(dataUrl || ""));
  if (!match) throw new Error("试听音频格式无效。");
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: match[1] }));
}

function unreadableCredential(connection) {
  return ["unreadable", "invalid", "encryption-unavailable"].includes(connection?.credentialStatus);
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

function VoiceCandidate({ busy, candidate, onDelete, onPlay, onRename, onRetain, previewing, usage = [] }) {
  const retained = candidate.retained === true;
  const inUse = usage.length > 0;
  const description = inUse
    ? `${usage.join("、")}正在使用，先换另一个音色后才能删除。`
    : retained
      ? "这个声音已经可以配置给联系人。"
      : "先试听；喜欢后保留，才会出现在联系人配置里。";
  return (
    <article className={`voice-candidate${retained ? " retained" : ""}`}>
      <div className="voice-candidate-copy">
        <span className="reference-kicker">{inUse ? "使用中" : retained ? "已保留" : "试听候选"}</span>
        <h3>{candidateName(candidate)}</h3>
        <p>{description} · {dateLabel(candidate.createdAt)}</p>
      </div>
      <div className="voice-candidate-actions">
        <div className="voice-candidate-actions__main">
          <button className="secondary-button" disabled={!candidate.previewAvailable || busy || previewing} onClick={onPlay} type="button">{previewing ? "正在试听…" : "试听"}</button>
          <button className={retained ? "secondary-button" : "primary-button"} disabled={busy || retained} onClick={onRetain} type="button">{busy ? "正在保存…" : retained ? "已保留" : "保留音色"}</button>
        </div>
        <div className="voice-candidate-actions__manage">
          <button className="secondary-button" disabled={busy} onClick={onRename} type="button">修改音色名称</button>
          <button className="danger-button" disabled={busy || inUse} onClick={onDelete} title={inUse ? "有联系人正在使用此音色，先换一个音色后才能删除" : undefined} type="button">删除</button>
        </div>
      </div>
    </article>
  );
}

function DialogHeader({ children, onClose, title }) {
  return <header className="create-settings-dialog__header"><div><span className="reference-kicker">{children}</span><h2>{title}</h2></div><button aria-label={`关闭${title}`} className="create-settings-close suzu-close-button" onClick={onClose} type="button"><span aria-hidden="true">×</span></button></header>;
}

export function CreateAudioPage({ actions = {}, api }) {
  const [snapshot, setSnapshot] = useState(null);
  const [feedback, setFeedback] = useState("");
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [settingsDraft, setSettingsDraft] = useState(EMPTY_CONFIG);
  const [creating, setCreating] = useState(false);
  const [mutatingId, setMutatingId] = useState("");
  const [previewingId, setPreviewingId] = useState("");
  const [assigningVoiceId, setAssigningVoiceId] = useState("");
  const [savingCustomAudio, setSavingCustomAudio] = useState(false);
  const [dialog, setDialog] = useState({ type: "" });
  const activeAudioRef = useRef(null);
  const activeAudioUrlRef = useRef("");

  const load = useCallback(async () => {
    try {
      setSnapshot(await api.voiceDesign.snapshot());
    } catch (error) {
      setFeedback(`读取音色设计状态失败：${error?.message || error}`);
    }
  }, [api]);

  const useSnapshot = useCallback(async (value) => {
    if (value?.status) setSnapshot(value);
    else await load();
  }, [load]);

  const stopActivePreview = useCallback(() => {
    activeAudioRef.current?.pause?.();
    if (activeAudioUrlRef.current) URL.revokeObjectURL(activeAudioUrlRef.current);
    activeAudioRef.current = null;
    activeAudioUrlRef.current = "";
  }, []);

  useEffect(() => {
    void load();
    return stopActivePreview;
  }, [load, stopActivePreview]);

  const config = snapshot?.config || EMPTY_CONFIG;
  const connection = snapshot?.connection || {};
  const unavailable = snapshot?.status !== "ready";
  const noKey = !connection.configured;
  const keyUnreadable = unreadableCredential(connection);
  const candidates = snapshot?.candidates || [];
  const contacts = snapshot?.contacts || [];
  const choices = snapshot?.assignableVoices || [];
  const contact = contacts.find((item) => item.id === dialog.contactId) || null;

  const connectionCopy = connection.configured
    ? "当前 API 已准备好创建音色。"
    : keyUnreadable
      ? "已绑定阿里百炼，但保存的 Key 无法由当前软件读取。请重新填写并保存 Key。"
      : "请在管理 → API 中为声音保存可用的阿里百炼 Key。";
  const creationInfo = unavailable
    ? "选择联系人后，即可开始创建候选。"
    : noKey && keyUnreadable
      ? "已绑定阿里百炼，但保存的 Key 无法读取。重新保存 Key 后即可创建；你现在仍可先填写声音描述。"
      : noKey
        ? "请先在 管理 → API 为声音保存可用的阿里百炼 Key；你现在仍可先填写声音描述。"
        : creating
          ? "正在向声音服务创建候选。这通常需要几十秒，请勿重复点击。"
          : "写下声音特征和一段试听文本，比较不同的声音方向。";

  const createCandidates = async (event) => {
    event.preventDefault();
    if (creating) return;
    setCreating(true);
    setFeedback(`正在创建 ${draft.count} 个候选，服务处理可能需要几十秒，请勿重复点击。`);
    try {
      await useSnapshot(await api.voiceDesign.create(draft));
      setFeedback("候选已创建。现在可以逐个试听、保留，再配置给联系人。");
    } catch (error) {
      setFeedback(error?.message || "创建候选失败，请稍后重试。");
    } finally {
      setCreating(false);
    }
  };

  const previewCandidate = async (id) => {
    if (previewingId) return;
    setPreviewingId(id);
    setFeedback("正在加载试听…");
    try {
      const dataUrl = await api.voiceDesign.preview(id);
      if (!dataUrl) throw new Error("该候选没有可用试听音频。");
      stopActivePreview();
      const objectUrl = previewObjectUrl(dataUrl);
      const audio = new Audio(objectUrl);
      activeAudioRef.current = audio;
      activeAudioUrlRef.current = objectUrl;
      audio.addEventListener("ended", () => {
        if (activeAudioRef.current !== audio) return;
        URL.revokeObjectURL(objectUrl);
        activeAudioRef.current = null;
        activeAudioUrlRef.current = "";
      }, { once: true });
      await audio.play();
      setFeedback("正在试听。");
    } catch {
      stopActivePreview();
      setFeedback("这段音色暂时无法试听，请稍后重试。");
    } finally {
      setPreviewingId("");
    }
  };

  const retainCandidate = async (id) => {
    if (mutatingId) return;
    setMutatingId(id);
    setFeedback("正在保留这个音色…");
    try {
      await useSnapshot(await api.voiceDesign.retainCandidate(id));
      setFeedback("音色已保留。现在可点右上角“配置联系人音色”。");
    } catch (error) {
      setFeedback(error?.message || "保留音色失败，请稍后重试。");
    } finally {
      setMutatingId("");
    }
  };

  const renameCandidate = async (event) => {
    event.preventDefault();
    const id = dialog.candidateId;
    if (!id || mutatingId) return;
    const name = new FormData(event.currentTarget).get("name");
    setMutatingId(id);
    try {
      await useSnapshot(await api.voiceDesign.renameCandidate({ id, name }));
      setDialog({ type: "" });
      setFeedback("音色名称已修改。");
    } catch (error) {
      setFeedback(error?.message || "修改音色名称失败，请稍后重试。");
    } finally {
      setMutatingId("");
    }
  };

  const deleteCandidate = async () => {
    const id = dialog.candidateId;
    if (!id || mutatingId) return;
    setMutatingId(id);
    setFeedback("正在删除这个候选…");
    try {
      await useSnapshot(await api.voiceDesign.deleteCandidate(id));
      setDialog({ type: "" });
      setFeedback("候选已删除。");
    } catch (error) {
      setFeedback(error?.message || "删除候选失败，请稍后重试。");
    } finally {
      setMutatingId("");
    }
  };

  const saveSettings = async (event) => {
    event.preventDefault();
    try {
      await useSnapshot(await api.voiceDesign.saveSettings({ ...settingsDraft, sampleRate: Number(settingsDraft.sampleRate) }));
      setDialog({ type: "" });
      setFeedback("设置已保存。");
    } catch (error) {
      setFeedback(error?.message || String(error));
    }
  };

  const saveContactVoice = async (event) => {
    event.preventDefault();
    if (!contact || assigningVoiceId) return;
    const key = new FormData(event.currentTarget).get("voiceSelection");
    const choice = choices.find((item) => item.key === key);
    if (!choice?.voiceId || !choice.provider) return;
    setAssigningVoiceId(choice.key);
    setFeedback(`正在为“${contact.name}”保存音色…`);
    try {
      await useSnapshot(await api.voiceDesign.saveContactVoice({
        contactId: contact.id,
        customVoiceId: choice.id || "",
        provider: choice.provider,
        sourceCandidateId: choice.sourceCandidateId || "",
        sourceContactId: choice.sourceContactId || "",
        voiceId: choice.voiceId,
      }));
      setDialog({ type: "" });
      setFeedback(`已为“${contact.name}”配置音色。其他联系人的声音不会受影响。`);
    } catch (error) {
      setFeedback(error?.message || "配置联系人音色失败，请稍后重试。");
    } finally {
      setAssigningVoiceId("");
    }
  };

  const saveCustomAudio = async (event) => {
    event.preventDefault();
    if (savingCustomAudio) return;
    const form = new FormData(event.currentTarget);
    const input = { apiKey: form.get("apiKey"), name: form.get("name"), provider: form.get("provider"), voiceId: form.get("voiceId") };
    const providerLabel = input.provider === "cosyvoice" ? "阿里百炼 CosyVoice 复刻音色" : "MiniMax 自定义音频";
    setSavingCustomAudio(true);
    setFeedback(`正在保存${providerLabel}…`);
    try {
      await useSnapshot(await api.voiceDesign.saveCustomAudio(input));
      setDialog({ type: "contacts" });
      setFeedback("自定义音频已保存。现在可为任意联系人配置它。");
    } catch (error) {
      setFeedback(error?.message || "保存自定义音频失败，请稍后重试。");
    } finally {
      setSavingCustomAudio(false);
    }
  };

  const selectedCandidate = useMemo(() => candidates.find((item) => item.id === dialog.candidateId) || null, [candidates, dialog.candidateId]);
  const stateLabel = unavailable ? "需要联系人" : noKey && keyUnreadable ? "密钥需要重存" : noKey ? "需要声音 API" : creating ? "正在创建" : "可以开始";
  const stateTone = unavailable || noKey ? "warning" : creating ? "muted" : "success";

  return (
    <>
      <PageHeader
        action={<div className="create-subpage-actions"><button className="secondary-button" onClick={actions.returnToOverview} type="button">返回创作</button><button className="secondary-button voice-contact-config-button" disabled={!contacts.length} onClick={() => setDialog({ type: "contacts" })} type="button">配置联系人音色</button><button aria-label="音色设置" className="create-settings-button" onClick={() => { setSettingsDraft({ ...config }); setDialog({ type: "settings" }); }} title="音色设置" type="button"><span aria-hidden="true">⚙</span></button></div>}
        className="create-studio-page-header"
        eyebrow="CREATE / AUDIO"
        subtitle="把声音方向变成可试听、可比较、可配置给联系人的候选。"
        title="音色设计"
      />
      {feedback ? <div className="reference-feedback" role="status">{feedback}</div> : null}
      <section className="voice-workspace">
        <section className="voice-design-panel">
          <div className="voice-section-head"><div><span className="reference-kicker">声音方向</span><h2>创建试听候选</h2><p>{creationInfo}</p></div><Status label={stateLabel} tone={stateTone} /></div>
          <form className="voice-form voice-design-form" onSubmit={createCandidates}>
            <label className="wide">声音描述<textarea disabled={unavailable || creating} maxLength="2048" name="voicePrompt" onChange={(event) => setDraft((previous) => ({ ...previous, voicePrompt: event.target.value }))} placeholder="描述声音特点、表达方式和不希望出现的倾向。" required value={draft.voicePrompt} /><small>最多 2048 字</small></label>
            <label className="wide">试听文本<textarea disabled={unavailable || creating} maxLength="1024" name="previewText" onChange={(event) => setDraft((previous) => ({ ...previous, previewText: event.target.value }))} placeholder="用于每个候选的试听文本。" required value={draft.previewText} /><small>最多 1024 字</small></label>
            <label>本次候选数<input disabled={unavailable || creating} max="20" min="1" name="count" onChange={(event) => setDraft((previous) => ({ ...previous, count: Number(event.target.value) }))} required type="number" value={draft.count} /></label>
            <div className="voice-form-actions">{unavailable ? <button className="primary-button" disabled>创建候选</button> : noKey ? <button className="secondary-button" onClick={actions.openApiServices} type="button">{keyUnreadable ? "重新保存阿里百炼 Key" : "配置声音 API"}</button> : <button className="primary-button" disabled={creating}>{creating ? "正在创建，请稍候…" : "创建候选"}</button>}</div>
          </form>
          <p className="voice-note">创建完成后，先试听，再保留喜欢的音色；最后点右上角为联系人配置。</p>
        </section>
        <section className="voice-history">
          <div className="voice-section-head"><div><span className="reference-kicker">候选历史</span><h2>音色候选</h2><p>试听、保留和配置状态都留在这里，方便连续比较。</p></div><Status label={candidates.length ? `${candidates.length} 项 · 已保留 ${candidates.filter((item) => item.retained).length}` : "尚无候选"} tone={candidates.length ? "success" : "muted"} /></div>
          {candidates.length ? <div className="voice-candidate-list">{candidates.map((candidate) => <VoiceCandidate busy={mutatingId === candidate.id} candidate={candidate} key={candidate.id} onDelete={() => setDialog({ type: "delete", candidateId: candidate.id })} onPlay={() => void previewCandidate(candidate.id)} onRename={() => setDialog({ type: "rename", candidateId: candidate.id })} onRetain={() => void retainCandidate(candidate.id)} previewing={previewingId === candidate.id} usage={candidate.voiceId ? snapshot?.usageByVoiceId?.[candidate.voiceId] || [] : []} />)}</div> : <div className="voice-history-empty">还没有候选。创建后先试听，满意再保留给联系人使用。</div>}
        </section>
      </section>

      <CreateStudioDialog ariaLabel="音色设置" onClose={() => setDialog({ type: "" })} open={dialog.type === "settings"}>
        <DialogHeader onClose={() => setDialog({ type: "" })} title="模型、语言与输出">音色设置</DialogHeader>
        <div className="voice-settings-body">
          <section className="voice-connection-panel"><div className="voice-section-head"><div><span className="reference-kicker">声音 API</span><h2>DashScope</h2><p>{connectionCopy}</p></div><Status label={connection.configured ? "已准备" : keyUnreadable ? "密钥需要重存" : "需要先设置 API"} tone={connection.configured ? "success" : "warning"} /></div><div className="voice-connection-actions"><button className="secondary-button" onClick={() => setDialog({ type: "custom" })} type="button">自定义音频</button><button className="secondary-button" onClick={actions.openApiServices} type="button">{keyUnreadable ? "重新保存 API Key" : "管理 API"}</button></div></section>
          <div className="voice-settings-copy"><span className="reference-kicker">声音参数</span><h2>Qwen Voice Design</h2><p>在需要时调整模型、语言和输出格式。</p></div>
          <form className="voice-form" onSubmit={saveSettings}>
            <label>设计模型<input disabled={unavailable} maxLength="160" onChange={(event) => setSettingsDraft((previous) => ({ ...previous, designModel: event.target.value }))} required value={settingsDraft.designModel} /></label>
            <label>目标 TTS 模型<input disabled={unavailable} maxLength="160" onChange={(event) => setSettingsDraft((previous) => ({ ...previous, targetModel: event.target.value }))} required value={settingsDraft.targetModel} /></label>
            <label>名称前缀<input disabled={unavailable} maxLength="32" onChange={(event) => setSettingsDraft((previous) => ({ ...previous, namePrefix: event.target.value }))} required value={settingsDraft.namePrefix} /></label>
            <label>语言<Select className="create-select-react" disabled={unavailable} fullWidth onChange={(language) => setSettingsDraft((previous) => ({ ...previous, language }))} options={LANGUAGE_OPTIONS} value={settingsDraft.language} /></label>
            <label>采样率<input disabled={unavailable} max="96000" min="8000" onChange={(event) => setSettingsDraft((previous) => ({ ...previous, sampleRate: event.target.value }))} required type="number" value={settingsDraft.sampleRate} /></label>
            <label>响应格式<input disabled={unavailable} maxLength="12" onChange={(event) => setSettingsDraft((previous) => ({ ...previous, responseFormat: event.target.value }))} required value={settingsDraft.responseFormat} /></label>
            <div className="voice-form-actions"><button className="secondary-button" disabled={unavailable}>保存设置</button></div>
          </form>
        </div>
      </CreateStudioDialog>

      <CreateStudioDialog ariaLabel="修改音色名称" onClose={() => setDialog({ type: "" })} open={dialog.type === "rename" && Boolean(selectedCandidate)}>
        <DialogHeader onClose={() => setDialog({ type: "" })} title="修改音色名称">音色名称</DialogHeader>
        {selectedCandidate ? <form className="voice-form voice-rename-form" onSubmit={renameCandidate}><label>名称<input autoFocus defaultValue={candidateName(selectedCandidate)} maxLength="80" name="name" required /></label><p className="voice-note">这个名称只在 Suzu 中展示，方便你和联系人识别。</p><div className="voice-form-actions"><button className="secondary-button" onClick={() => setDialog({ type: "" })} type="button">取消</button><button className="primary-button" disabled={Boolean(mutatingId)}>保存名称</button></div></form> : null}
      </CreateStudioDialog>

      <CreateStudioDialog ariaLabel="删除候选" onClose={() => setDialog({ type: "" })} open={dialog.type === "delete" && Boolean(selectedCandidate)}>
        <DialogHeader onClose={() => setDialog({ type: "" })} title={`删除“${candidateName(selectedCandidate)}”？`}>候选管理</DialogHeader>
        <div className="voice-settings-copy"><p>这会从 Suzu 移除该候选和它的本地试听文件；阿里百炼中的云端音色不会被删除。</p></div><div className="voice-form-actions"><button className="secondary-button" onClick={() => setDialog({ type: "" })} type="button">取消</button><button className="danger-button" disabled={Boolean(mutatingId)} onClick={() => void deleteCandidate()} type="button">删除候选</button></div>
      </CreateStudioDialog>

      <CreateStudioDialog ariaLabel="配置联系人音色" onClose={() => setDialog({ type: "" })} open={dialog.type === "contacts" || dialog.type === "contact-choice"}>
        {dialog.type === "contacts" ? <><DialogHeader onClose={() => setDialog({ type: "" })} title="配置联系人音色">联系人</DialogHeader><div className="voice-settings-copy"><p>选择一位联系人，再为他或她设置保存过的音色。每个人的设置互不影响。</p></div>{contacts.length ? <div className="voice-contact-list">{contacts.map((item) => <article className="voice-contact-row" key={item.id}><div><strong>{item.name}</strong><small>{voiceChoiceLabel(item, choices)}</small></div><button className="secondary-button" onClick={() => setDialog({ type: "contact-choice", contactId: item.id })} type="button">配置音色</button></article>)}</div> : <div className="voice-history-empty voice-contact-empty">还没有联系人。请先在“关系”中创建联系人。</div>}<div className="voice-form-actions voice-contact-dialog-actions"><button className="secondary-button" onClick={() => setDialog({ type: "" })} type="button">关闭</button></div></> : contact ? <><DialogHeader onClose={() => setDialog({ type: "" })} title={`为“${contact.name}”配置音色`}>联系人</DialogHeader><div className="voice-settings-copy"><p>{`这里列出已保留的百炼音色，以及本机音色库中的 MiniMax 和阿里百炼复刻音色；保存后只影响“${contact.name}”。`}</p></div>{choices.length ? <form className="voice-form voice-contact-config-form" onSubmit={saveContactVoice}><div className="voice-contact-choice-list">{choices.map((item) => { const selected = item.id ? contact.provider === item.provider && item.id === contact.customVoiceId && item.voiceId === contact.voiceId : contact.provider === item.provider && item.voiceId === contact.voiceId; return <label className="voice-contact-choice" key={item.key}><input defaultChecked={selected} name="voiceSelection" required type="radio" value={item.key} /><span><strong>{item.name}</strong><small>{selected ? `${contact.name}正在使用` : item.kindLabel}</small></span></label>; })}</div><div className="voice-form-actions"><button className="secondary-button" onClick={() => setDialog({ type: "contacts" })} type="button">返回联系人列表</button><button className="primary-button" disabled={Boolean(assigningVoiceId)}>{assigningVoiceId ? "正在保存…" : "使用这个音色"}</button></div></form> : <><div className="voice-history-empty voice-contact-empty">先保留一个候选音色，或点音色设置里的“自定义音频”添加 MiniMax 或阿里百炼复刻声音。</div><div className="voice-form-actions voice-contact-dialog-actions"><button className="secondary-button" onClick={() => setDialog({ type: "contacts" })} type="button">返回联系人列表</button></div></>}</> : null}
      </CreateStudioDialog>

      <CreateStudioDialog ariaLabel="自定义音频" onClose={() => { if (!savingCustomAudio) setDialog({ type: "settings" }); }} open={dialog.type === "custom"}>
        <DialogHeader onClose={() => { if (!savingCustomAudio) setDialog({ type: "settings" }); }} title="添加一个声音">自定义音频</DialogHeader>
        <div className="voice-settings-copy custom-audio-copy"><p>开发版会把这一条声音的 Key 直接保存在本机音色库中；保存后可配置给任意联系人。</p></div>
        <form className="voice-form voice-contact-config-form" onSubmit={saveCustomAudio}><label>声音备注名<input autoFocus disabled={savingCustomAudio} maxLength="80" name="name" placeholder="例如：Suzu 的电话声" required /></label><label>厂家<FormSelect defaultValue="minimax" disabled={savingCustomAudio} name="provider" options={CUSTOM_AUDIO_PROVIDER_OPTIONS} /></label><label>音色 ID<input disabled={savingCustomAudio} maxLength="200" name="voiceId" placeholder="填写复刻后得到的 voice ID" required /></label><label>API Key<input autoComplete="off" disabled={savingCustomAudio} maxLength="4096" name="apiKey" placeholder="填写所选厂家的 API Key" required type="password" /></label><p className="voice-note">阿里百炼 CosyVoice 复刻音色会使用 cosyvoice-v3.5-plus 合成；复刻时和合成时必须是同一个模型。</p><div className="voice-form-actions"><button className="secondary-button" disabled={savingCustomAudio} onClick={() => setDialog({ type: "settings" })} type="button">取消</button><button className="primary-button" disabled={savingCustomAudio}>{savingCustomAudio ? "正在保存…" : "保存自定义音频"}</button></div></form>
      </CreateStudioDialog>
    </>
  );
}
