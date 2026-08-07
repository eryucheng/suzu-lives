import { escapeHtml } from "../../core/formatters.mjs";
import { pageIntro, status } from "../../components/panel.mjs";

const languages = [["zh", "中文"], ["en", "英语"], ["de", "德语"], ["it", "意大利语"], ["pt", "葡萄牙语"], ["es", "西班牙语"], ["ja", "日语"], ["ko", "韩语"], ["fr", "法语"], ["ru", "俄语"]];
const state = { snapshot: null, loading: false, feedback: "" };

function option(value, label, selected) { return '<option value="' + value + '"' + (value === selected ? " selected" : "") + ">" + label + "</option>"; }
function config() { return state.snapshot?.config || { designModel: "", targetModel: "", namePrefix: "", language: "zh", sampleRate: 24000, responseFormat: "wav" }; }
function inactive() { return state.snapshot?.status !== "ready"; }
function candidateCard(item) {
  return '<article class="voice-candidate"><div><span class="reference-kicker">' + escapeHtml(item.preferredName || "候选音色") + "</span><h3>" + escapeHtml(item.voiceId) + '</h3><p>' + escapeHtml(item.targetModel) + " · " + escapeHtml(item.language) + " · " + escapeHtml(item.createdAt || "刚刚创建") + '</p><details class="voice-candidate-details"><summary>查看设计记录</summary><dl><div><dt>设计模型</dt><dd>' + escapeHtml(item.designModel || "未记录") + '</dd></div><div><dt>响应格式</dt><dd>' + escapeHtml(item.responseFormat || "未记录") + '</dd></div><div><dt>声音描述</dt><dd>' + escapeHtml(item.voicePrompt || "旧记录未保存") + '</dd></div><div><dt>试听文本</dt><dd>' + escapeHtml(item.previewText || "旧记录未保存") + '</dd></div></dl></details></div><div class="voice-candidate-actions">' + (item.previewAvailable ? '<button class="secondary-button" data-play-voice="' + escapeHtml(item.id) + '">试听</button>' : '<span class="voice-no-preview">无试听音频</span>') + '<button class="secondary-button" data-copy-voice="' + escapeHtml(item.voiceId) + '">复制 voiceId</button><button class="secondary-button" data-copy-target="' + escapeHtml(item.targetModel) + '">复制目标模型</button></div></article>';
}
function configurationForm() {
  const value = config();
  const unavailable = inactive();
  const connection = state.snapshot?.connection || {};
  return '<dialog id="voiceSettingsDialog" class="create-settings-dialog" aria-labelledby="voiceSettingsTitle"><div class="create-settings-dialog__surface"><header class="create-settings-dialog__header"><div><span class="reference-kicker">音色设置</span><h2 id="voiceSettingsTitle">模型、语言与输出</h2></div><button type="button" class="create-settings-close suzu-close-button" data-close-voice-settings aria-label="关闭音色设置" title="关闭音色设置"><span aria-hidden="true">×</span></button></header><div class="voice-settings-body"><section class="voice-connection-panel"><div class="voice-section-head"><div><span class="reference-kicker">声音 API</span><h2>DashScope</h2><p>要更换声音 API 时，在管理 → API 中选择即可。</p></div>' + status(connection.configured ? "已准备" : "需要先设置 API", connection.configured ? "ready" : "warning") + '</div><div class="voice-connection-actions"><button class="secondary-button" data-open-api-services>管理 API</button></div></section><div class="voice-settings-copy"><span class="reference-kicker">声音参数</span><h2>Qwen Voice Design</h2><p>在需要时调整模型、语言和输出格式。</p></div><form id="voiceConfigForm" class="voice-form"><label>设计模型<input name="designModel" value="' + escapeHtml(value.designModel) + '" required maxlength="160" ' + (unavailable ? "disabled" : "") + '></label><label>目标 TTS 模型<input name="targetModel" value="' + escapeHtml(value.targetModel) + '" required maxlength="160" ' + (unavailable ? "disabled" : "") + '></label><label>名称前缀<input name="namePrefix" value="' + escapeHtml(value.namePrefix) + '" required maxlength="32" ' + (unavailable ? "disabled" : "") + '></label><label>语言<select name="language" ' + (unavailable ? "disabled" : "") + '>' + languages.map(([id, label]) => option(id, label, value.language)).join("") + '</select></label><label>采样率<input name="sampleRate" type="number" min="8000" max="96000" value="' + escapeHtml(value.sampleRate) + '" required ' + (unavailable ? "disabled" : "") + '></label><label>响应格式<input name="responseFormat" value="' + escapeHtml(value.responseFormat) + '" required maxlength="12" ' + (unavailable ? "disabled" : "") + '></label><div class="voice-form-actions"><button class="secondary-button" ' + (unavailable ? "disabled" : "") + '>保存设置</button></div></form></div></div></dialog>';
}
function designForm() {
  const unavailable = inactive();
  const noKey = !state.snapshot?.connection?.configured;
  const disabled = unavailable || noKey;
  const info = unavailable ? "选择联系人后，即可开始创建候选。" : noKey ? "先在 管理 → API 添加声音 API，再开始设计。" : "写下声音特征和一段试听文本，比较不同的声音方向。";
  return '<section class="voice-design-panel"><div class="voice-section-head"><div><span class="reference-kicker">声音方向</span><h2>创建试听候选</h2><p>' + escapeHtml(info) + '</p></div>' + status(unavailable ? "需要联系人" : noKey ? "需要声音服务" : "可以开始", unavailable || noKey ? "warning" : "ready") + '</div><form id="voiceCreateForm" class="voice-form voice-design-form"><label class="wide">声音描述<textarea name="voicePrompt" maxlength="2048" required placeholder="描述声音特点、表达方式和不希望出现的倾向。" ' + (disabled ? "disabled" : "") + '></textarea><small>最多 2048 字</small></label><label class="wide">试听文本<textarea name="previewText" maxlength="1024" required placeholder="用于每个候选的试听文本。" ' + (disabled ? "disabled" : "") + '></textarea><small>最多 1024 字</small></label><label>本次候选数<input name="count" type="number" min="1" max="20" value="1" required ' + (disabled ? "disabled" : "") + '></label><div class="voice-form-actions"><button class="primary-button" ' + (disabled ? "disabled" : "") + '>创建候选</button></div></form><p class="voice-note">创建后可在候选区试听、回看设计记录，并复制需要的音色标识。</p></section>';
}
function history() {
  const candidates = state.snapshot?.candidates || [];
  return '<section class="voice-history"><div class="voice-section-head"><div><span class="reference-kicker">候选历史</span><h2>已保存的音色</h2><p>从这里回听、回看并挑选下一步要使用的声音。</p></div>' + status(candidates.length ? String(candidates.length) + " 项" : "尚无候选", candidates.length ? "ready" : "muted") + '</div>' + (candidates.length ? '<div class="voice-candidate-list">' + candidates.map(candidateCard).join("") + "</div>" : '<div class="voice-history-empty">还没有已保存的候选。创建后，它们会在这里等待你试听和比较。</div>') + "</section>";
}

export function renderVoiceDesign() {
  const feedback = state.feedback ? '<div class="reference-feedback">' + escapeHtml(state.feedback) + "</div>" : "";
  const actions = '<div class="create-subpage-actions"><button type="button" class="create-settings-button" data-open-voice-settings aria-label="音色设置" title="音色设置"><span aria-hidden="true">⚙</span></button><button class="secondary-button" data-return-create>返回创作</button></div>';
  return pageIntro("CREATE / AUDIO", "音色设计", "把声音方向变成可试听、可比较的候选。", actions) + feedback + '<section class="voice-workspace">' + designForm() + history() + "</section>" + configurationForm();
}
export async function loadVoiceDesign(context) {
  if (state.loading) return;
  state.loading = true;
  try { state.snapshot = await context.api.voiceDesign.snapshot(); context.render(); } catch (error) { state.feedback = "读取音色设计状态失败：" + (error?.message || error); context.render(); } finally { state.loading = false; }
}
async function refresh(context, task, message) {
  try { await task(); state.feedback = message || ""; await loadVoiceDesign(context); } catch (error) { state.feedback = error?.message || String(error); context.render(); }
}
export function bindVoiceDesignEvents(context) {
  document.querySelector("[data-return-create]")?.addEventListener("click", () => context.setCreatePage("overview"));
  const settingsDialog = document.querySelector("#voiceSettingsDialog");
  document.querySelector("[data-open-voice-settings]")?.addEventListener("click", () => settingsDialog?.showModal());
  document.querySelector("[data-close-voice-settings]")?.addEventListener("click", () => settingsDialog?.close());
  document.querySelector("#voiceConfigForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    refresh(context, () => context.api.voiceDesign.saveSettings({ designModel: form.get("designModel"), targetModel: form.get("targetModel"), namePrefix: form.get("namePrefix"), language: form.get("language"), sampleRate: Number(form.get("sampleRate")), responseFormat: form.get("responseFormat") }), "设置已保存。");
  });
  document.querySelector("[data-open-api-services]")?.addEventListener("click", () => {
    context.setAdminTab("api-services");
    context.setView("admin");
  });
  document.querySelector("#voiceCreateForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    refresh(context, () => context.api.voiceDesign.create({ voicePrompt: form.get("voicePrompt"), previewText: form.get("previewText"), count: Number(form.get("count")) }), "候选已创建并记录到统一用量流水。");
  });
  document.querySelectorAll("[data-copy-voice]").forEach((button) => button.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(button.dataset.copyVoice); state.feedback = "voiceId 已复制。"; } catch { state.feedback = "无法访问剪贴板，请手动复制 voiceId。"; }
    context.render();
  }));
  document.querySelectorAll("[data-copy-target]").forEach((button) => button.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(button.dataset.copyTarget); state.feedback = "目标模型已复制。"; } catch { state.feedback = "无法访问剪贴板，请手动复制目标模型。"; }
    context.render();
  }));
  document.querySelectorAll("[data-play-voice]").forEach((button) => button.addEventListener("click", () => refresh(context, async () => {
    const dataUrl = await context.api.voiceDesign.preview(button.dataset.playVoice);
    if (!dataUrl) throw new Error("该候选没有可用试听音频。");
    const audio = new Audio(dataUrl);
    await audio.play();
  }, "")));
}
