import { escapeHtml } from "../../core/formatters.mjs";
import { pageIntro, status } from "../../components/panel.mjs";

const languages = [["zh", "中文"], ["en", "英语"], ["de", "德语"], ["it", "意大利语"], ["pt", "葡萄牙语"], ["es", "西班牙语"], ["ja", "日语"], ["ko", "韩语"], ["fr", "法语"], ["ru", "俄语"]];
const state = {
  snapshot: null,
  loading: false,
  feedback: "",
  creating: false,
  previewingId: "",
  mutatingId: "",
  renameId: "",
  deleteId: "",
  configuringContactVoice: false,
  configuringContactId: "",
  configuringCustomAudio: false,
  assigningVoiceId: "",
  savingCustomAudio: false,
  activeAudio: null,
  activeAudioUrl: "",
  draft: { voicePrompt: "", previewText: "", count: 1 },
};

function option(value, label, selected) { return '<option value="' + value + '"' + (value === selected ? " selected" : "") + ">" + label + "</option>"; }
function config() { return state.snapshot?.config || { designModel: "", targetModel: "", namePrefix: "", language: "zh", sampleRate: 24000, responseFormat: "wav" }; }
function inactive() { return state.snapshot?.status !== "ready"; }
function hasContacts() { return Array.isArray(state.snapshot?.contacts) && state.snapshot.contacts.length > 0; }
function candidateName(item) { return item.displayName || "未命名音色"; }
function dateLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚创建";
  return date.getMonth() + 1 + " 月 " + date.getDate() + " 日 " + String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
}
function previewObjectUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(String(dataUrl || ""));
  if (!match) throw new Error("试听音频格式无效。");
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: match[1] }));
}
function stopActivePreview() {
  state.activeAudio?.pause?.();
  if (state.activeAudioUrl) URL.revokeObjectURL(state.activeAudioUrl);
  state.activeAudio = null;
  state.activeAudioUrl = "";
}
function renderKeepingVoiceScroll(context) {
  const content = document.querySelector("#content");
  const candidates = document.querySelector("[data-voice-candidate-list]");
  const contentScrollTop = content?.scrollTop;
  const candidateScrollTop = candidates?.scrollTop;
  context.render();
  const restore = () => {
    const nextContent = document.querySelector("#content");
    const nextCandidates = document.querySelector("[data-voice-candidate-list]");
    if (Number.isFinite(contentScrollTop) && nextContent) nextContent.scrollTop = contentScrollTop;
    if (Number.isFinite(candidateScrollTop) && nextCandidates) nextCandidates.scrollTop = candidateScrollTop;
  };
  restore();
  window.requestAnimationFrame(restore);
}
function candidateCard(item) {
  const busy = state.mutatingId === item.id;
  const previewing = state.previewingId === item.id;
  const retained = item.retained === true;
  const usingContacts = item.voiceId ? state.snapshot?.usageByVoiceId?.[item.voiceId] || [] : [];
  const inUse = usingContacts.length > 0;
  const description = inUse
    ? usingContacts.join("、") + "正在使用，先换另一个音色后才能删除。"
    : retained
      ? "这个声音已经可以配置给联系人。"
      : "先试听；喜欢后保留，才会出现在联系人配置里。";
  return '<article class="voice-candidate' + (retained ? " retained" : "") + '"><div class="voice-candidate-copy"><span class="reference-kicker">' + (inUse ? "使用中" : retained ? "已保留" : "试听候选") + '</span><h3>' + escapeHtml(candidateName(item)) + '</h3><p>' + escapeHtml(description) + " · " + escapeHtml(dateLabel(item.createdAt)) + '</p></div><div class="voice-candidate-actions"><button type="button" class="secondary-button" data-rename-voice="' + escapeHtml(item.id) + '"' + (busy ? " disabled" : "") + '>修改音色名称</button><button type="button" class="secondary-button" data-play-voice="' + escapeHtml(item.id) + '"' + (!item.previewAvailable || busy || previewing ? " disabled" : "") + ">" + (previewing ? "正在试听…" : "试听") + '</button><button type="button" class="' + (retained ? "secondary-button" : "primary-button") + '" data-retain-voice="' + escapeHtml(item.id) + '"' + (busy || retained ? " disabled" : "") + ">" + (busy ? "正在保存…" : retained ? "已保留" : "保留音色") + '</button><button type="button" class="danger-button" data-delete-voice="' + escapeHtml(item.id) + '"' + (busy || inUse ? " disabled" : "") + (inUse ? ' title="有联系人正在使用此音色，先换一个音色后才能删除"' : "") + '>删除</button></div></article>';
}
function configurationForm() {
  const value = config();
  const unavailable = inactive();
  const connection = state.snapshot?.connection || {};
  const keyUnreadable = ["unreadable", "invalid", "encryption-unavailable"].includes(connection.credentialStatus);
  const connectionCopy = connection.configured
    ? "当前 API 已准备好创建音色。"
    : keyUnreadable
      ? "已绑定阿里百炼，但保存的 Key 无法由当前软件读取。请重新填写并保存 Key。"
      : "请在管理 → API 中为声音保存可用的阿里百炼 Key。";
  return '<dialog id="voiceSettingsDialog" class="create-settings-dialog" aria-labelledby="voiceSettingsTitle"><div class="create-settings-dialog__surface"><header class="create-settings-dialog__header"><div><span class="reference-kicker">音色设置</span><h2 id="voiceSettingsTitle">模型、语言与输出</h2></div><button type="button" class="create-settings-close suzu-close-button" data-close-voice-settings aria-label="关闭音色设置" title="关闭音色设置"><span aria-hidden="true">×</span></button></header><div class="voice-settings-body"><section class="voice-connection-panel"><div class="voice-section-head"><div><span class="reference-kicker">声音 API</span><h2>DashScope</h2><p>' + escapeHtml(connectionCopy) + '</p></div>' + status(connection.configured ? "已准备" : keyUnreadable ? "密钥需要重存" : "需要先设置 API", connection.configured ? "ready" : "warning") + '</div><div class="voice-connection-actions"><button type="button" class="secondary-button" data-open-custom-audio>自定义音频</button><button class="secondary-button" data-open-api-services>' + (keyUnreadable ? "重新保存 API Key" : "管理 API") + '</button></div></section><div class="voice-settings-copy"><span class="reference-kicker">声音参数</span><h2>Qwen Voice Design</h2><p>在需要时调整模型、语言和输出格式。</p></div><form id="voiceConfigForm" class="voice-form"><label>设计模型<input name="designModel" value="' + escapeHtml(value.designModel) + '" required maxlength="160" ' + (unavailable ? "disabled" : "") + '></label><label>目标 TTS 模型<input name="targetModel" value="' + escapeHtml(value.targetModel) + '" required maxlength="160" ' + (unavailable ? "disabled" : "") + '></label><label>名称前缀<input name="namePrefix" value="' + escapeHtml(value.namePrefix) + '" required maxlength="32" ' + (unavailable ? "disabled" : "") + '></label><label>语言<select name="language" ' + (unavailable ? "disabled" : "") + '>' + languages.map(([id, label]) => option(id, label, value.language)).join("") + '</select></label><label>采样率<input name="sampleRate" type="number" min="8000" max="96000" value="' + escapeHtml(value.sampleRate) + '" required ' + (unavailable ? "disabled" : "") + '></label><label>响应格式<input name="responseFormat" value="' + escapeHtml(value.responseFormat) + '" required maxlength="12" ' + (unavailable ? "disabled" : "") + '></label><div class="voice-form-actions"><button class="secondary-button" ' + (unavailable ? "disabled" : "") + '>保存设置</button></div></form></div></div></dialog>';
}
function designForm() {
  const unavailable = inactive();
  const connection = state.snapshot?.connection || {};
  const noKey = !connection.configured;
  const keyUnreadable = ["unreadable", "invalid", "encryption-unavailable"].includes(connection.credentialStatus);
  const inputDisabled = unavailable || state.creating;
  const info = unavailable
    ? "选择联系人后，即可开始创建候选。"
    : noKey && keyUnreadable
      ? "已绑定阿里百炼，但保存的 Key 无法读取。重新保存 Key 后即可创建；你现在仍可先填写声音描述。"
      : noKey
        ? "请先在 管理 → API 为声音保存可用的阿里百炼 Key；你现在仍可先填写声音描述。"
        : state.creating
          ? "正在向声音服务创建候选。这通常需要几十秒，请勿重复点击。"
          : "写下声音特征和一段试听文本，比较不同的声音方向。";
  const action = unavailable
    ? '<button class="primary-button" disabled>创建候选</button>'
    : noKey
      ? '<button type="button" class="secondary-button" data-open-api-services>' + (keyUnreadable ? "重新保存阿里百炼 Key" : "配置声音 API") + '</button>'
      : '<button class="primary-button"' + (state.creating ? " disabled" : "") + ">" + (state.creating ? "正在创建，请稍候…" : "创建候选") + "</button>";
  const stateLabel = unavailable ? "需要联系人" : noKey && keyUnreadable ? "密钥需要重存" : noKey ? "需要声音 API" : state.creating ? "正在创建" : "可以开始";
  return '<section class="voice-design-panel"><div class="voice-section-head"><div><span class="reference-kicker">声音方向</span><h2>创建试听候选</h2><p>' + escapeHtml(info) + '</p></div>' + status(stateLabel, unavailable || noKey ? "warning" : state.creating ? "muted" : "ready") + '</div><form id="voiceCreateForm" class="voice-form voice-design-form"><label class="wide">声音描述<textarea name="voicePrompt" maxlength="2048" required placeholder="描述声音特点、表达方式和不希望出现的倾向。" ' + (inputDisabled ? "disabled" : "") + '>' + escapeHtml(state.draft.voicePrompt) + '</textarea><small>最多 2048 字</small></label><label class="wide">试听文本<textarea name="previewText" maxlength="1024" required placeholder="用于每个候选的试听文本。" ' + (inputDisabled ? "disabled" : "") + '>' + escapeHtml(state.draft.previewText) + '</textarea><small>最多 1024 字</small></label><label>本次候选数<input name="count" type="number" min="1" max="20" value="' + escapeHtml(state.draft.count) + '" required ' + (inputDisabled ? "disabled" : "") + '></label><div class="voice-form-actions">' + action + '</div></form><p class="voice-note">创建完成后，先试听，再保留喜欢的音色；最后点右上角为联系人配置。</p></section>';
}
function history() {
  const candidates = state.snapshot?.candidates || [];
  const retainedCount = candidates.filter((item) => item.retained).length;
  return '<section class="voice-history"><div class="voice-section-head"><div><span class="reference-kicker">候选历史</span><h2>已保存的音色</h2><p>这里独立滚动。保留后，才能把声音配置给联系人。</p></div>' + status(candidates.length ? String(candidates.length) + " 项 · 已保留 " + retainedCount : "尚无候选", candidates.length ? "ready" : "muted") + '</div>' + (candidates.length ? '<div class="voice-candidate-list" data-voice-candidate-list>' + candidates.map(candidateCard).join("") + "</div>" : '<div class="voice-history-empty">还没有已保存的候选。创建后，先试听，再保留你喜欢的声音。</div>') + "</section>";
}
function renameDialog() {
  const item = (state.snapshot?.candidates || []).find((candidate) => candidate.id === state.renameId);
  if (!item) return "";
  return '<dialog id="voiceRenameDialog" class="create-settings-dialog voice-rename-dialog" aria-labelledby="voiceRenameTitle"><div class="create-settings-dialog__surface"><header class="create-settings-dialog__header"><div><span class="reference-kicker">音色名称</span><h2 id="voiceRenameTitle">修改音色名称</h2></div><button type="button" class="create-settings-close suzu-close-button" data-close-voice-rename aria-label="关闭修改音色名称"><span aria-hidden="true">×</span></button></header><form id="voiceRenameForm" class="voice-form voice-rename-form" data-candidate-id="' + escapeHtml(item.id) + '"><label>名称<input name="name" value="' + escapeHtml(candidateName(item)) + '" required maxlength="80" autofocus></label><p class="voice-note">这个名称只在 Suzu 中展示，方便你和联系人识别。</p><div class="voice-form-actions"><button type="button" class="secondary-button" data-close-voice-rename>取消</button><button class="primary-button">保存名称</button></div></form></div></dialog>';
}
function deleteDialog() {
  const item = (state.snapshot?.candidates || []).find((candidate) => candidate.id === state.deleteId);
  if (!item) return "";
  return '<dialog id="voiceDeleteDialog" class="create-settings-dialog voice-delete-dialog" aria-labelledby="voiceDeleteTitle"><div class="create-settings-dialog__surface"><header class="create-settings-dialog__header"><div><span class="reference-kicker">候选管理</span><h2 id="voiceDeleteTitle">删除“' + escapeHtml(candidateName(item)) + '”？</h2></div><button type="button" class="create-settings-close suzu-close-button" data-close-voice-delete aria-label="关闭删除候选"><span aria-hidden="true">×</span></button></header><div class="voice-settings-copy"><p>这会从 Suzu 移除该候选和它的本地试听文件；阿里百炼中的云端音色不会被删除。</p></div><div class="voice-form-actions"><button type="button" class="secondary-button" data-close-voice-delete>取消</button><button type="button" class="danger-button" data-confirm-delete-voice="' + escapeHtml(item.id) + '">删除候选</button></div></div></dialog>';
}
function contactVoiceChoices() {
  return Array.isArray(state.snapshot?.assignableVoices) ? state.snapshot.assignableVoices : [];
}
function configuredContact() {
  return (state.snapshot?.contacts || []).find((contact) => contact.id === state.configuringContactId) || null;
}
function contactVoiceLabel(contact) {
  if (!contact?.voiceId) return "尚未配置";
  const choice = contactVoiceChoices().find((item) => (
    item.provider === contact.provider
    && item.voiceId === contact.voiceId
    && (!item.id || item.id === contact.customVoiceId)
  ));
  return choice?.name || (contact.provider === "minimax" ? "MiniMax 自定义音频" : contact.provider === "cosyvoice" ? "阿里百炼 CosyVoice 复刻音色" : "已保存的百炼音色");
}
function contactVoiceDialog() {
  if (!state.configuringContactVoice) return "";
  const contacts = state.snapshot?.contacts || [];
  const contact = configuredContact();
  if (!contact) {
    const rows = contacts.map((item) => '<article class="voice-contact-row"><div><strong>' + escapeHtml(item.name) + '</strong><small>' + escapeHtml(contactVoiceLabel(item)) + '</small></div><button type="button" class="secondary-button" data-configure-contact-voice="' + escapeHtml(item.id) + '">配置音色</button></article>').join("");
    return '<dialog id="voiceContactConfigDialog" class="create-settings-dialog voice-contact-config-dialog" aria-labelledby="voiceContactConfigTitle"><div class="create-settings-dialog__surface"><header class="create-settings-dialog__header"><div><span class="reference-kicker">联系人</span><h2 id="voiceContactConfigTitle">配置联系人音色</h2></div><button type="button" class="create-settings-close suzu-close-button" data-close-contact-voice-config aria-label="关闭联系人音色配置"><span aria-hidden="true">×</span></button></header><div class="voice-settings-copy"><p>选择一位联系人，再为他或她设置保存过的音色。每个人的设置互不影响。</p></div>' + (rows ? '<div class="voice-contact-list">' + rows + '</div>' : '<div class="voice-history-empty voice-contact-empty">还没有联系人。请先在“关系”中创建联系人。</div>') + '<div class="voice-form-actions voice-contact-dialog-actions"><button type="button" class="secondary-button" data-close-contact-voice-config>关闭</button></div></div></dialog>';
  }
  const choices = contactVoiceChoices();
  const selectedVoiceId = contact.voiceId || "";
  const selectedProvider = contact.provider || "qwen";
  const selectedCustomVoiceId = contact.customVoiceId || "";
  const choiceRows = choices.map((item) => {
    const selected = item.id
      ? selectedProvider === item.provider && item.id === selectedCustomVoiceId && item.voiceId === selectedVoiceId
      : selectedProvider === item.provider && item.voiceId === selectedVoiceId;
    return '<label class="voice-contact-choice"><input type="radio" name="voiceSelection" value="' + escapeHtml(item.key) + '"' + (selected ? " checked" : "") + ' required><span><strong>' + escapeHtml(item.name) + '</strong><small>' + (selected ? contact.name + "正在使用" : item.kindLabel) + '</small></span></label>';
  }).join("");
  return '<dialog id="voiceContactConfigDialog" class="create-settings-dialog voice-contact-config-dialog" aria-labelledby="voiceContactConfigTitle"><div class="create-settings-dialog__surface"><header class="create-settings-dialog__header"><div><span class="reference-kicker">联系人</span><h2 id="voiceContactConfigTitle">为“' + escapeHtml(contact.name) + '”配置音色</h2></div><button type="button" class="create-settings-close suzu-close-button" data-close-contact-voice-config aria-label="关闭联系人音色配置"><span aria-hidden="true">×</span></button></header><div class="voice-settings-copy"><p>这里列出已保留的百炼音色，以及本机音色库中的 MiniMax 和阿里百炼复刻音色；保存后只影响“' + escapeHtml(contact.name) + '”。</p></div>' + (choices.length ? '<form id="voiceContactConfigForm" class="voice-form voice-contact-config-form"><div class="voice-contact-choice-list">' + choiceRows + '</div><div class="voice-form-actions"><button type="button" class="secondary-button" data-back-contact-voice-list>返回联系人列表</button><button class="primary-button"' + (state.assigningVoiceId ? " disabled" : "") + ">" + (state.assigningVoiceId ? "正在保存…" : "使用这个音色") + "</button></div></form>" : '<div class="voice-history-empty voice-contact-empty">先保留一个候选音色，或点音色设置里的“自定义音频”添加 MiniMax 或阿里百炼复刻声音。</div><div class="voice-form-actions voice-contact-dialog-actions"><button type="button" class="secondary-button" data-back-contact-voice-list>返回联系人列表</button></div>') + "</div></dialog>";
}
function customAudioDialog() {
  if (!state.configuringCustomAudio) return "";
  return '<dialog id="customAudioDialog" class="create-settings-dialog" aria-labelledby="customAudioTitle"><div class="create-settings-dialog__surface"><header class="create-settings-dialog__header"><div><span class="reference-kicker">自定义音频</span><h2 id="customAudioTitle">添加一个声音</h2></div><button type="button" class="create-settings-close suzu-close-button" data-close-custom-audio aria-label="关闭自定义音频"><span aria-hidden="true">×</span></button></header><div class="voice-settings-copy custom-audio-copy"><p>开发版会把这一条声音的 Key 直接保存在本机音色库中；保存后可配置给任意联系人。</p></div><form id="customAudioForm" class="voice-form voice-contact-config-form"><label>声音备注名<input name="name" required maxlength="80" placeholder="例如：Suzu 的电话声" autofocus ' + (state.savingCustomAudio ? "disabled" : "") + '></label><label>厂家<select name="provider" ' + (state.savingCustomAudio ? "disabled" : "") + '><option value="minimax">MiniMax</option><option value="cosyvoice">阿里百炼（CosyVoice v3.5 Plus 复刻）</option></select></label><label>音色 ID<input name="voiceId" required maxlength="200" placeholder="填写复刻后得到的 voice ID" ' + (state.savingCustomAudio ? "disabled" : "") + '></label><label>API Key<input name="apiKey" type="password" required maxlength="4096" autocomplete="off" placeholder="填写所选厂家的 API Key" ' + (state.savingCustomAudio ? "disabled" : "") + '></label><p class="voice-note">阿里百炼 CosyVoice 复刻音色会使用 cosyvoice-v3.5-plus 合成；复刻时和合成时必须是同一个模型。</p><div class="voice-form-actions"><button type="button" class="secondary-button" data-close-custom-audio ' + (state.savingCustomAudio ? "disabled" : "") + '>取消</button><button class="primary-button"' + (state.savingCustomAudio ? " disabled" : "") + ">" + (state.savingCustomAudio ? "正在保存…" : "保存自定义音频") + "</button></div></form></div></dialog>";
}

export function renderVoiceDesign() {
  const feedback = state.feedback ? '<div class="reference-feedback" role="status">' + escapeHtml(state.feedback) + "</div>" : "";
  const actions = '<div class="create-subpage-actions"><button type="button" class="secondary-button voice-contact-config-button" data-open-contact-voice-config' + (!hasContacts() ? " disabled" : "") + '>配置联系人音色</button><button type="button" class="create-settings-button" data-open-voice-settings aria-label="音色设置" title="音色设置"><span aria-hidden="true">⚙</span></button><button class="secondary-button" data-return-create>返回创作</button></div>';
  return pageIntro("CREATE / AUDIO", "音色设计", "把声音方向变成可试听、可比较、可配置给联系人的候选。", actions) + feedback + '<section class="voice-workspace">' + designForm() + history() + "</section>" + configurationForm() + renameDialog() + deleteDialog() + contactVoiceDialog() + customAudioDialog();
}
export async function loadVoiceDesign(context) {
  if (state.loading) return;
  state.loading = true;
  try { state.snapshot = await context.api.voiceDesign.snapshot(); }
  catch (error) { state.feedback = "读取音色设计状态失败：" + (error?.message || error); }
  finally { state.loading = false; context.render(); }
}
async function refresh(context, task, message) {
  try {
    const nextSnapshot = await task();
    if (nextSnapshot?.status) state.snapshot = nextSnapshot;
    else await loadVoiceDesign(context);
    state.feedback = message || "";
  } catch (error) { state.feedback = error?.message || String(error); }
  context.render();
}
function openDialog(id) {
  const dialog = document.querySelector(id);
  if (dialog && !dialog.open) dialog.showModal();
}
function closeDialog(id) {
  const dialog = document.querySelector(id);
  if (dialog?.open) dialog.close();
}
async function createCandidates(context, input) {
  if (state.creating) return;
  state.creating = true;
  state.draft = input;
  state.feedback = "正在创建 " + input.count + " 个候选，服务处理可能需要几十秒，请勿重复点击。";
  context.render();
  try {
    state.snapshot = await context.api.voiceDesign.create(input);
    state.feedback = "候选已创建。现在可以逐个试听、保留，再配置给联系人。";
  } catch (error) { state.feedback = error?.message || "创建候选失败，请稍后重试。"; }
  finally { state.creating = false; context.render(); }
}
async function retainCandidate(context, id) {
  if (state.mutatingId) return;
  state.mutatingId = id;
  state.feedback = "正在保留这个音色…";
  context.render();
  try {
    state.snapshot = await context.api.voiceDesign.retainCandidate(id);
    state.feedback = "音色已保留。现在可点右上角“配置联系人音色”。";
  } catch (error) { state.feedback = error?.message || "保留音色失败，请稍后重试。"; }
  finally { state.mutatingId = ""; context.render(); }
}
async function renameCandidate(context, id, name) {
  if (state.mutatingId) return;
  state.mutatingId = id;
  try {
    state.snapshot = await context.api.voiceDesign.renameCandidate({ id, name });
    state.renameId = "";
    state.feedback = "音色名称已修改。";
  } catch (error) { state.feedback = error?.message || "修改音色名称失败，请稍后重试。"; }
  finally { state.mutatingId = ""; context.render(); }
}
async function deleteCandidate(context, id) {
  if (state.mutatingId) return;
  state.mutatingId = id;
  state.feedback = "正在删除这个候选…";
  context.render();
  try {
    state.snapshot = await context.api.voiceDesign.deleteCandidate(id);
    state.deleteId = "";
    state.feedback = "候选已删除。";
  } catch (error) { state.feedback = error?.message || "删除候选失败，请稍后重试。"; }
  finally { state.mutatingId = ""; context.render(); }
}
async function previewCandidate(context, id) {
  if (state.previewingId) return;
  state.previewingId = id;
  state.feedback = "正在加载试听…";
  renderKeepingVoiceScroll(context);
  try {
    const dataUrl = await context.api.voiceDesign.preview(id);
    if (!dataUrl) throw new Error("该候选没有可用试听音频。");
    stopActivePreview();
    const objectUrl = previewObjectUrl(dataUrl);
    const audio = new Audio(objectUrl);
    state.activeAudio = audio;
    state.activeAudioUrl = objectUrl;
    audio.addEventListener("ended", () => {
      if (state.activeAudio !== audio) return;
      URL.revokeObjectURL(objectUrl);
      state.activeAudio = null;
      state.activeAudioUrl = "";
    }, { once: true });
    await audio.play();
    state.feedback = "正在试听。";
  } catch {
    stopActivePreview();
    state.feedback = "这段音色暂时无法试听，请稍后重试。";
  } finally { state.previewingId = ""; renderKeepingVoiceScroll(context); }
}
async function configureContactVoice(context, contact, choice) {
  if (!contact?.id || !choice?.voiceId || !choice?.provider) return;
  if (state.assigningVoiceId) return;
  state.assigningVoiceId = choice.key;
  state.feedback = "正在为“" + contact.name + "”保存音色…";
  context.render();
  try {
    state.snapshot = await context.api.voiceDesign.saveContactVoice({
      contactId: contact.id,
      voiceId: choice.voiceId,
      provider: choice.provider,
      customVoiceId: choice.id || "",
      sourceContactId: choice.sourceContactId || "",
      sourceCandidateId: choice.sourceCandidateId || "",
    });
    state.configuringContactVoice = false;
    state.configuringContactId = "";
    state.feedback = "已为“" + contact.name + "”配置音色。其他联系人的声音不会受影响。";
  } catch (error) { state.feedback = error?.message || "配置联系人音色失败，请稍后重试。"; }
  finally { state.assigningVoiceId = ""; context.render(); }
}
async function saveCustomAudio(context, input) {
  if (state.savingCustomAudio) return;
  state.savingCustomAudio = true;
  const providerLabel = input.provider === "cosyvoice" ? "阿里百炼 CosyVoice 复刻音色" : "MiniMax 自定义音频";
  state.feedback = "正在保存" + providerLabel + "…";
  context.render();
  try {
    state.snapshot = await context.api.voiceDesign.saveCustomAudio(input);
    state.configuringCustomAudio = false;
    state.configuringContactVoice = true;
    state.configuringContactId = "";
    state.feedback = "自定义音频已保存。现在可为任意联系人配置它。";
  } catch (error) {
    state.feedback = error?.message || "保存自定义音频失败，请稍后重试。";
  } finally {
    state.savingCustomAudio = false;
    context.render();
    if (state.configuringContactVoice) openDialog("#voiceContactConfigDialog");
  }
}
export function bindVoiceDesignEvents(context) {
  document.querySelector("[data-return-create]")?.addEventListener("click", () => context.setCreatePage("overview"));
  document.querySelector("[data-open-voice-settings]")?.addEventListener("click", () => openDialog("#voiceSettingsDialog"));
  document.querySelector("[data-close-voice-settings]")?.addEventListener("click", () => closeDialog("#voiceSettingsDialog"));
  document.querySelector("[data-open-custom-audio]")?.addEventListener("click", () => {
    state.configuringCustomAudio = true;
    context.render();
    openDialog("#customAudioDialog");
  });
  document.querySelectorAll("[data-close-custom-audio]").forEach((button) => button.addEventListener("click", () => {
    if (state.savingCustomAudio) return;
    state.configuringCustomAudio = false;
    closeDialog("#customAudioDialog");
  }));
  document.querySelector("#customAudioDialog")?.addEventListener("close", () => { if (!state.savingCustomAudio) state.configuringCustomAudio = false; });
  document.querySelector("#customAudioForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    saveCustomAudio(context, { name: form.get("name"), provider: form.get("provider"), voiceId: form.get("voiceId"), apiKey: form.get("apiKey") });
  });
  document.querySelector("#voiceConfigForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    refresh(context, () => context.api.voiceDesign.saveSettings({ designModel: form.get("designModel"), targetModel: form.get("targetModel"), namePrefix: form.get("namePrefix"), language: form.get("language"), sampleRate: Number(form.get("sampleRate")), responseFormat: form.get("responseFormat") }), "设置已保存。");
  });
  document.querySelectorAll("[data-open-api-services]").forEach((button) => button.addEventListener("click", () => {
    context.setAdminTab("api-services");
    context.setView("admin");
  }));
  document.querySelector("#voiceCreateForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    createCandidates(context, { voicePrompt: form.get("voicePrompt"), previewText: form.get("previewText"), count: Number(form.get("count")) });
  });
  document.querySelectorAll("[data-play-voice]").forEach((button) => button.addEventListener("click", () => previewCandidate(context, button.dataset.playVoice)));
  document.querySelectorAll("[data-retain-voice]").forEach((button) => button.addEventListener("click", () => retainCandidate(context, button.dataset.retainVoice)));
  document.querySelectorAll("[data-delete-voice]").forEach((button) => button.addEventListener("click", () => {
    state.deleteId = button.dataset.deleteVoice;
    context.render();
    openDialog("#voiceDeleteDialog");
  }));
  document.querySelectorAll("[data-rename-voice]").forEach((button) => button.addEventListener("click", () => {
    state.renameId = button.dataset.renameVoice;
    context.render();
    openDialog("#voiceRenameDialog");
  }));
  document.querySelectorAll("[data-close-voice-rename]").forEach((button) => button.addEventListener("click", () => {
    state.renameId = "";
    closeDialog("#voiceRenameDialog");
  }));
  document.querySelector("#voiceRenameDialog")?.addEventListener("close", () => { state.renameId = ""; });
  document.querySelector("#voiceRenameForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    renameCandidate(context, event.currentTarget.dataset.candidateId, form.get("name"));
  });
  document.querySelectorAll("[data-close-voice-delete]").forEach((button) => button.addEventListener("click", () => {
    state.deleteId = "";
    context.render();
  }));
  document.querySelector("#voiceDeleteDialog")?.addEventListener("close", () => { state.deleteId = ""; });
  document.querySelector("[data-confirm-delete-voice]")?.addEventListener("click", (event) => deleteCandidate(context, event.currentTarget.dataset.confirmDeleteVoice));
  document.querySelector("[data-open-contact-voice-config]")?.addEventListener("click", () => {
    state.configuringContactVoice = true;
    state.configuringContactId = "";
    context.render();
    openDialog("#voiceContactConfigDialog");
  });
  document.querySelectorAll("[data-configure-contact-voice]").forEach((button) => button.addEventListener("click", () => {
    state.configuringContactId = button.dataset.configureContactVoice || "";
    context.render();
    openDialog("#voiceContactConfigDialog");
  }));
  document.querySelectorAll("[data-back-contact-voice-list]").forEach((button) => button.addEventListener("click", () => {
    state.configuringContactId = "";
    context.render();
    openDialog("#voiceContactConfigDialog");
  }));
  document.querySelectorAll("[data-close-contact-voice-config]").forEach((button) => button.addEventListener("click", () => {
    state.configuringContactVoice = false;
    state.configuringContactId = "";
    closeDialog("#voiceContactConfigDialog");
  }));
  document.querySelector("#voiceContactConfigDialog")?.addEventListener("close", () => {
    state.configuringContactVoice = false;
    state.configuringContactId = "";
  });
  document.querySelector("#voiceContactConfigForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const key = new FormData(event.currentTarget).get("voiceSelection");
    configureContactVoice(context, configuredContact(), contactVoiceChoices().find((item) => item.key === key));
  });
}
