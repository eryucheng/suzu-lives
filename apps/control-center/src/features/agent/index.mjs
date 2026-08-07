import { escapeHtml } from "../../core/formatters.mjs";
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
} from "../../core/avatar-file.mjs";
import { getIdentity, profileInitial } from "../../core/identity.mjs";
import { isReady } from "../../core/state.mjs";
import { card, emptyBlock, pageIntro, status } from "../../components/panel.mjs";
import { icons } from "../shell/index.mjs";
import { bindManagedAgentRuntimeSettingsEvents, renderManagedAgentRuntimeSettings } from "../settings/index.mjs";
import { renderUsage } from "../usage/index.mjs";

function avatarPreview(profile, fallback) {
  if (profile.avatarDataUrl) return `<img src="${escapeHtml(profile.avatarDataUrl)}" alt="${escapeHtml(profile.displayName)} 的头像">`;
  return `<span>${escapeHtml(profileInitial(profile, fallback))}</span>`;
}

function profileEditor({ description, profile, target, title }) {
  return `<article class="identity-card" data-identity-target="${escapeHtml(target)}"><div class="identity-avatar">${avatarPreview(profile, title)}</div><div class="identity-copy"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p><label class="identity-name-field"><span>显示名</span><input class="setting-input" data-identity-name value="${escapeHtml(profile.displayName)}" maxlength="60"></label><div class="identity-actions"><label class="secondary-button avatar-file-button">选择头像<input type="file" accept="image/png,image/jpeg,image/webp" data-avatar-file hidden></label><button class="secondary-button" data-save-identity>保存名称</button>${profile.avatarDataUrl ? '<button class="text-button" data-remove-avatar>移除头像</button>' : ""}</div></div></article>`;
}

function cloneIdentity(settings) {
  const identity = getIdentity(settings);
  return {
    owner: { ...identity.owner },
    defaultAgent: { ...identity.defaultAgent },
    agents: Object.fromEntries(Object.entries(identity.agents || {}).map(([id, profile]) => [id, { ...profile }])),
  };
}

function profileForTarget(identity, target) {
  if (target === "owner") return identity.owner;
  if (target === "defaultAgent") return identity.defaultAgent;
  const agentId = target.slice("agent:".length);
  return identity.agents[agentId] || { ...identity.defaultAgent };
}

function setProfileForTarget(identity, target, profile) {
  if (target === "owner") identity.owner = profile;
  else if (target === "defaultAgent") identity.defaultAgent = profile;
  else identity.agents[target.slice("agent:".length)] = profile;
  return identity;
}

function identityAvatarCropDialog(state) {
  const crop = state.identityAvatarCrop;
  if (!crop?.source) return "";
  const layout = avatarCropLayout(crop);
  const zoom = Math.round(layout.zoom * 100);
  return `<div class="identity-avatar-crop-overlay" data-identity-avatar-crop-backdrop>
    <section class="identity-avatar-crop-dialog" id="identityAvatarCrop" role="dialog" aria-modal="true" aria-labelledby="identityAvatarCropTitle">
      <header><div><span>MY AVATAR</span><h2 id="identityAvatarCropTitle">裁剪头像</h2></div><button type="button" class="suzu-close-button" data-close-identity-avatar-crop aria-label="取消裁剪">×</button></header>
      <p>拖动图片调整位置；方框内的正方形区域会作为头像保存。</p>
      <div class="identity-avatar-crop-dialog__stage" data-identity-avatar-crop-stage aria-label="头像裁剪区域">
        <img data-identity-avatar-crop-image src="${escapeHtml(crop.source)}" alt="正在裁剪的我的头像" draggable="false" style="width:${layout.displayWidth}px;height:${layout.displayHeight}px;transform:translate(${layout.offsetX}px, ${layout.offsetY}px)">
        <span class="identity-avatar-crop-dialog__frame" aria-hidden="true"></span>
      </div>
      <label class="identity-avatar-crop-dialog__zoom"><span>缩放</span><input type="range" min="${AVATAR_CROP_MIN_ZOOM}" max="${AVATAR_CROP_MAX_ZOOM}" step="0.01" value="${layout.zoom}" data-identity-avatar-crop-zoom><output data-identity-avatar-crop-zoom-value>${zoom}%</output></label>
      <footer><button type="button" class="text-button" data-close-identity-avatar-crop>取消</button><button type="button" class="primary-button" data-confirm-identity-avatar-crop>确认使用</button></footer>
    </section>
  </div>`;
}

function renderIdentitySettings(settings, state) {
  const identity = getIdentity(settings);
  return `<section class="identity-section"><div class="identity-heading"><div><h2>身份与头像</h2><p>支持 PNG、JPEG、WebP。</p></div></div><div class="identity-grid identity-grid--owner">${profileEditor({ title: "我", description: "聊天中显示的我的身份。", profile: identity.owner, target: "owner" })}</div>${identityAvatarCropDialog(state)}</section>`;
}

function adminTabs(activeTab) {
  const tabs = [["overview", "概览"], ["agent", "我"], ["claude-code", "Claude Code"], ["runtime", "连接与运行"], ["api-services", "API"], ["usage", "用量与成本"]];
  return `<div class="admin-tabs">${tabs.map(([id, label]) => `<button class="admin-tab ${activeTab === id ? "active" : ""}" data-admin-tab="${id}">${label}</button>`).join("")}</div>`;
}

export const CLAUDE_CODE_API_PROVIDERS = Object.freeze({
  deepseek: {
    label: "DeepSeek", baseUrl: "https://api.deepseek.com/anthropic",
    models: { model: "deepseek-v4-pro[1m]", sonnet: "deepseek-v4-pro[1m]", opus: "deepseek-v4-pro[1m]", haiku: "deepseek-v4-flash", subagent: "deepseek-v4-flash", effort: "max" },
  },
  minimax: {
    label: "MiniMax（中国区）", baseUrl: "https://api.minimaxi.com/anthropic",
    models: { model: "MiniMax-M2.7", sonnet: "MiniMax-M2.7", opus: "MiniMax-M2.7", haiku: "MiniMax-M2.7", subagent: "MiniMax-M2.7" },
  },
  "bailian-coding": {
    label: "阿里百炼（Coding Plan）", baseUrl: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    models: { model: "qwen3.8-max-preview", sonnet: "qwen3.8-max-preview", opus: "qwen3.8-max-preview", haiku: "qwen3.6-flash", subagent: "qwen3.7-max" },
  },
  "bailian-payg": {
    label: "阿里百炼（按量）", baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    models: { model: "qwen3.8-max-preview", sonnet: "qwen3.8-max-preview", opus: "qwen3.8-max-preview", haiku: "qwen3.6-flash", subagent: "qwen3.7-max" },
  },
  kimi: {
    label: "Kimi Code", baseUrl: "https://api.kimi.com/coding/",
    models: { model: "kimi-for-coding", sonnet: "kimi-for-coding", opus: "kimi-for-coding", haiku: "kimi-for-coding", subagent: "kimi-for-coding", effort: "high" },
  },
  custom: { label: "自定义", baseUrl: "", models: {} },
});

function claudeCodeApiProviderOptions(activeId) {
  return Object.entries(CLAUDE_CODE_API_PROVIDERS).map(([id, provider]) => `<option value="${id}" ${activeId === id ? "selected" : ""}>${escapeHtml(provider.label)}</option>`).join("");
}

function claudeCodeApiModelOptions(current, models) {
  const options = [...new Set([current, ...(Array.isArray(models) ? models : [])].filter(Boolean))];
  return options.map((model) => `<option value="${escapeHtml(model)}"></option>`).join("");
}

const CAPABILITY_CATEGORIES = [
  { id: "create", label: "创作", detail: "图片、声音与视觉资料" },
  { id: "perceive", label: "感知", detail: "图片、视频、网页与时间" },
  { id: "act", label: "行动", detail: "现实中的工具与联系" },
  { id: "companion", label: "陪伴", detail: "日常互动与游戏" },
];

const WECHAT_DELIVERY_OPTIONS = [
  ["agent", "Agent 的说话内容", "最终回复，默认投递"],
  ["attachments", "Hook / 上下文", "当前会话流出现这类记录时投递"],
  ["tools", "工具调用", "工具调用与权限等待"],
  ["thinking", "思考内容", "仅在你明确需要时投递"],
  ["system", "系统消息", "停止、错误和系统状态"],
  ["tokens", "Token 用量", "本次回复的用量摘要"],
];

function wechatSnapshot(state) {
  const raw = state.wechatSnapshot && typeof state.wechatSnapshot === "object" ? state.wechatSnapshot : {};
  const delivery = raw.delivery && typeof raw.delivery === "object" ? raw.delivery : {};
  return {
    enabled: raw.enabled === true,
    linkedSessions: Number(raw.linkedSessions) || 0,
    delivery: Object.fromEntries(WECHAT_DELIVERY_OPTIONS.map(([key]) => [key, delivery[key] === undefined ? key === "agent" : delivery[key] === true])),
  };
}

function wechatConnectionCapability(state) {
  const current = wechatSnapshot(state);
  return {
    id: "wechat-connection",
    name: "连接微信",
    description: "把指定对话连接到手机微信；不创建 Claude Skill，也不依赖外部桥接器。",
    category: "act",
    enabled: current.enabled,
    softwareConnector: true,
  };
}

function renderWechatConnectionDetail(state) {
  const current = wechatSnapshot(state);
  const statusLabel = current.enabled ? "已开启" : "未开启";
  const stateCopy = current.enabled
    ? "软件正在维护已绑定会话的微信长连接；每个聊天可在“··· → 设置”里扫码或断开。"
    : "关闭后会停止所有微信收发，但不会删除已绑定会话；再次开启即可恢复。";
  return `<article class="capability-detail capability-detail--focus"><header class="capability-detail__header"><div><span class="reference-kicker">行动 / 软件连接</span><h2>连接微信</h2><p>微信文字会进入所绑定的本机 Claude 会话；每个二维码只连接当前会话。</p></div>${status(statusLabel, current.enabled ? "ready" : "muted")}</header><div class="capability-detail__switch"><div><strong>启用微信连接</strong><p>${escapeHtml(stateCopy)}</p></div><label class="capability-toggle"><input type="checkbox" data-toggle-wechat-connection ${current.enabled ? "checked" : ""} aria-label="${current.enabled ? "关闭" : "开启"}连接微信"><span aria-hidden="true"></span></label></div><div class="capability-detail__content"><section class="capability-setting-section"><header><span class="reference-kicker">DELIVERY</span><h3>投递到微信的内容</h3><p>这组设置独立于聊天页面的显示设置。默认只发送 Agent 的最终回复；工具权限始终需要回到桌面端确认。</p></header><div class="capability-form-grid">${WECHAT_DELIVERY_OPTIONS.map(([key, label, detail]) => `<label class="capability-checkbox"><input type="checkbox" data-wechat-delivery="${escapeHtml(key)}" ${current.delivery[key] ? "checked" : ""}><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small></span></label>`).join("")}</div></section><section class="capability-info-section"><div><span class="reference-kicker">SCOPE</span><h3>按会话绑定</h3><p>当前有 ${current.linkedSessions.toLocaleString("zh-CN")} 条会话连接。每个二维码只路由到生成它的联系人项目和 Claude 会话，可以用不同微信号绑定不同对话。</p></div></section></div></article>`;
}

function capabilityPresentation(capability) {
  return { category: "act", ...capability };
}

function capabilityCategory(capability) {
  return capabilityPresentation(capability).category;
}

function capabilitySettings(capability) {
  return capability.savedSettings || {};
}

function capabilitySettingSection(kicker, title, description, content) {
  return `<section class="capability-setting-section"><header><span class="reference-kicker">${escapeHtml(kicker)}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p></header>${content}</section>`;
}

function capabilityInfoSection(kicker, title, description, action = "") {
  return `<section class="capability-info-section"><div><span class="reference-kicker">${escapeHtml(kicker)}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p></div>${action}</section>`;
}

function renderCapabilityApiBinding(state, bindingId) {
  const item = API_BINDINGS.find((candidate) => candidate.id === bindingId);
  if (!item) return "";
  const services = state.apiServices || { connections: [], bindings: {} };
  const connections = services.connections || [];
  const bindings = services.bindings || {};
  return `<div class="capability-api-binding"><div><span>使用的 API</span><small>${escapeHtml(item.detail)}</small></div><div class="capability-api-binding__control">${renderApiBindingPicker(state, item, connections, bindings)}<button type="button" class="text-button" data-open-admin="api-services">管理 API</button></div></div>`;
}

function settingsForm(id, body, submitLabel) {
  const footer = submitLabel ? `<footer><button class="primary-button">${escapeHtml(submitLabel)}</button></footer>` : "";
  return `<form class="capability-settings-form capability-settings-form--full" data-capability-settings-form="${escapeHtml(id)}">${body}${footer}</form>`;
}

function companionScopeKey(sessionId, projectRoot) {
  const id = String(sessionId || "").trim();
  const root = String(projectRoot || "").trim().replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
  return id && root ? `${root}\u0000${id}` : "";
}

function renderSessionDeliverySettings(capability, state, detail) {
  const saved = capabilitySettings(capability);
  const snapshot = state.companionSessions || {};
  const projectRoot = String(snapshot.projectRoot || "");
  const enabled = new Set((Array.isArray(saved.enabledSessions) ? saved.enabledSessions : [])
    .map((session) => companionScopeKey(session?.sessionId, session?.projectRoot))
    .filter(Boolean));
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const body = sessions.length
    ? `<div class="capability-form-grid">${sessions.map((session) => {
      const key = companionScopeKey(session.id, projectRoot);
      const active = enabled.has(key);
      return `<label class="capability-checkbox wide"><input type="checkbox" data-session-delivery-enabled="${escapeHtml(capability.id)}" data-session-delivery-id="${escapeHtml(session.id)}" ${active ? "checked" : ""}><span><strong>${escapeHtml(session.title || "未命名对话")}</strong><small>${escapeHtml(session.preview || session.id)}</small></span></label>`;
    }).join("")}</div>`
    : `<p class="capability-setting-empty">当前联系人还没有可选择的 Claude 会话。</p>`;
  return capabilitySettingSection("会话范围", "在哪些会话中启用", detail, body);
}

function renderProactiveContactSettings(capability, state) {
  const saved = capabilitySettings(capability);
  return settingsForm("proactive-contact", `${capabilitySettingSection("主动关心", "触发提示词", "这两段文字会在对应自动任务触发时交给 Agent；可以按你的相处方式修改。", `<div class="capability-form-grid"><label class="wide"><span>链式主动关心提示词</span><textarea name="chainPrompt" maxlength="12000">${escapeHtml(saved.chainPrompt || "")}</textarea></label><label class="wide"><span>临时回访提示词</span><textarea name="followUpPrompt" maxlength="12000">${escapeHtml(saved.followUpPrompt || "")}</textarea></label></div>`)}${renderSessionDeliverySettings(capability, state, "打开后，当前会话的定时任务才会触发；可以同时开启多个会话。")}`, "保存主动关心设置");
}

function renderImageGenerationSettings(capability, state) {
  const saved = capabilitySettings(capability);
  const comfy = saved.comfyui || {};
  return settingsForm("image-generation", `${capabilitySettingSection("图片生成", "出图方式", "云端 API 适合日常使用；本机绘画只在你本机运行 ComfyUI 时启用。", `<label><span>默认方式</span>${runtimeChoice("defaultBackend", saved.defaultBackend || "api", [["api", "云端 API"], ["comfyui", "本机 ComfyUI"]])}</label>${renderCapabilityApiBinding(state, "image-generation")}`)}<details class="capability-advanced"><summary><span>本机绘画设置</span><small>只在默认使用 ComfyUI 时调整</small></summary><div class="capability-form-grid"><label class="wide"><span>ComfyUI 地址</span><input name="comfyBaseUrl" value="${escapeHtml(comfy.baseUrl || "http://127.0.0.1:8188")}" maxlength="500"></label><label><span>最长等待（秒）</span><input name="comfyTimeoutSeconds" type="number" min="1" max="600" value="${escapeHtml(comfy.timeoutSeconds ?? 600)}"></label><label><span>进度间隔（秒）</span><input name="comfyPollIntervalSeconds" type="number" min="0.1" max="30" step="0.1" value="${escapeHtml(comfy.pollIntervalSeconds ?? 1)}"></label><label class="wide"><span>默认工作流（可选）</span><input name="comfyDefaultWorkflow" value="${escapeHtml(comfy.defaultWorkflow || "")}" maxlength="200" placeholder="留空时由任务自行选择"></label></div></details>`, "保存图片生成设置");
}

function renderPhoneCameraSettings(capability, state) {
  const saved = capabilitySettings(capability);
  const sizes = saved.sizeByShot || {};
  const references = saved.references || {};
  const prompt = saved.prompt || {};
  return settingsForm("phone-camera", `${capabilitySettingSection("手机拍照式图片", "画面偏好", "这些偏好会附在已有拍摄规则上，不会替换后置、自拍或镜前的基础画面逻辑。", `<label><span>默认方式</span>${runtimeChoice("defaultBackend", saved.defaultBackend || "api", [["api", "云端 API"], ["comfyui", "本机 ComfyUI"]])}</label>${renderCapabilityApiBinding(state, "image-generation")}<div class="capability-form-grid"><label><span>后置画面尺寸</span><input name="rearSize" value="${escapeHtml(sizes.rear || "1536x1024")}" maxlength="20" placeholder="1536x1024"></label><label><span>自拍画面尺寸</span><input name="selfieSize" value="${escapeHtml(sizes.selfie || "1024x1536")}" maxlength="20" placeholder="1024x1536"></label><label><span>镜前画面尺寸</span><input name="mirrorSize" value="${escapeHtml(sizes.mirror || "1024x1536")}" maxlength="20" placeholder="1024x1536"></label><label><span>最多参考图</span><input name="maxImages" type="number" min="1" max="16" value="${escapeHtml(references.maxImages ?? 8)}"></label><label class="wide"><span>画面前置提示</span><textarea name="promptPrefix" maxlength="12000" placeholder="例如：人物保持自然生活感，避免精致棚拍。">${escapeHtml(prompt.prefix || "")}</textarea></label><label class="wide"><span>画面补充提示</span><textarea name="promptSuffix" maxlength="12000" placeholder="例如：服装与环境以当前视觉参考为准。">${escapeHtml(prompt.suffix || "")}</textarea></label></div>`)} `, "保存手机拍照设置");
}

function renderImageVisionSettings(capability, state) {
  const saved = capabilitySettings(capability);
  const provider = saved.provider || {};
  const vision = saved.vision || {};
  return settingsForm("image-vision", `${capabilitySettingSection("理解图片", "读取偏好", "选择用于图片理解的 API，再决定需要多细地读取图片。", `${renderCapabilityApiBinding(state, "image-vision")}<div class="capability-form-grid"><label class="wide"><span>模型</span><input name="model" value="${escapeHtml(provider.model || "")}" maxlength="200" placeholder="从 API 服务说明中填写模型名"></label><label class="wide"><span>图片读取精度</span>${runtimeChoice("detail", vision.detail || "auto", [["auto", "自动"], ["low", "快速"], ["high", "细看"]])}</label><label><span>等待时间（秒）</span><input name="timeoutSeconds" type="number" min="5" max="600" value="${escapeHtml(vision.timeoutSeconds ?? 90)}"></label><label><span>最长回复（tokens）</span><input name="maxOutputTokens" type="number" min="32" max="32000" value="${escapeHtml(vision.maxOutputTokens ?? 800)}"></label></div>`)}<details class="capability-advanced"><summary><span>图片处理细节</span><small>只有图片过大或细节不足时才需要调整</small></summary><div class="capability-form-grid"><label><span>最大图片大小（字节）</span><input name="maxImageBytes" type="number" min="262144" max="26214400" value="${escapeHtml(vision.maxImageBytes ?? 1572864)}"></label><label><span>最长边（像素）</span><input name="maxEdge" type="number" min="256" max="8192" value="${escapeHtml(vision.maxEdge ?? 1600)}"></label><label><span>压缩质量</span><input name="jpegQuality" type="number" min="1" max="100" value="${escapeHtml(vision.jpegQuality ?? 90)}"></label><label class="capability-checkbox"><input name="retryOnRefusal" type="checkbox" ${vision.retryOnRefusal !== false ? "checked" : ""}><span>遇到拒答时尝试一次兼容处理</span></label></div></details>`, "保存图片理解设置");
}

function renderVideoUnderstandingSettings(capability, state) {
  const saved = capabilitySettings(capability);
  const provider = saved.provider || {};
  const video = saved.video || {};
  return settingsForm("video-understanding", `${capabilitySettingSection("理解视频", "读取偏好", "选择视频理解的 API，并设置每秒取样的画面数量。", `${renderCapabilityApiBinding(state, "video-understanding")}<div class="capability-form-grid"><label class="wide"><span>模型</span><input name="model" value="${escapeHtml(provider.model || "")}" maxlength="200" placeholder="从 API 服务说明中填写模型名"></label><label class="wide"><span>取样速度</span>${runtimeChoice("fps", String(video.fps ?? 1), [["0.5", "节省：每 2 秒 1 帧"], ["1", "平衡：每秒 1 帧"], ["2", "细看：每秒 2 帧"]])}</label><label class="capability-checkbox"><input name="cacheEnabled" type="checkbox" ${video.cacheEnabled !== false ? "checked" : ""}><span>保留本地缓存，加快同一视频的再次理解</span></label></div>`)}<details class="capability-advanced"><summary><span>视频处理细节</span><small>速度、回复长度和本机工具</small></summary><div class="capability-form-grid"><label><span>等待时间（秒）</span><input name="timeoutSeconds" type="number" min="5" max="3600" value="${escapeHtml(video.timeoutSeconds ?? 240)}"></label><label><span>最长回复（tokens）</span><input name="maxOutputTokens" type="number" min="32" max="32000" value="${escapeHtml(video.maxOutputTokens ?? 350)}"></label><label><span>表达随机度</span><input name="temperature" type="number" min="0" max="2" step="0.1" value="${escapeHtml(video.temperature ?? 0.2)}"></label><label><span>最大处理大小（字节）</span><input name="maxBinaryBytes" type="number" min="1048576" max="536870912" value="${escapeHtml(video.maxBinaryBytes ?? 7000000)}"></label><label><span>FFmpeg 命令</span><input name="ffmpegPath" value="${escapeHtml(video.ffmpegPath || "ffmpeg")}" maxlength="300"></label><label><span>FFprobe 命令</span><input name="ffprobePath" value="${escapeHtml(video.ffprobePath || "ffprobe")}" maxlength="300"></label></div></details>`, "保存视频理解设置");
}

function renderVoiceMessageSettings(capability, state) {
  const saved = capabilitySettings(capability);
  const candidates = Array.isArray(saved.candidates) ? saved.candidates : [];
  const voiceOptions = [["", "请选择当前联系人的声音"], ...candidates.map((candidate) => [candidate.voiceId, candidate.preferredName || candidate.voiceId])];
  const diagnostic = saved.voiceDiagnostic ? `<p class="capability-setting-empty">${escapeHtml(saved.voiceDiagnostic)}</p>` : "";
  const scope = saved.selectionSource === "contact"
    ? "这项选择只属于当前联系人；切换联系人后会显示其自己的选择。"
    : "API 连接与发送超时在本机共享；音色选择只属于当前联系人。";
  return settingsForm("voice-message", `${capabilitySettingSection("声音", "发送语音", "音色设计、已选音色和语音发送都按当前联系人对应；语音会在当前 Suzu 会话中作为可播放 MP3 显示，绑定微信时会作为 MP3 文件投递。", `${renderCapabilityApiBinding(state, "sound")}${diagnostic}<div class="capability-form-grid"><label class="wide"><span>当前联系人的发送音色</span>${runtimeChoice("voiceId", saved.voiceId || "", voiceOptions)}<small>${escapeHtml(scope)}</small></label></div><div class="capability-inline-action"><div><strong>想要新声音？</strong><small>先在当前联系人的音色设计里创建并保存候选，它会出现在这里。</small></div><button type="button" class="secondary-button" data-open-capability-settings="audio">打开音色设计</button></div>`)}<details class="capability-advanced"><summary><span>共享发送细节</span><small>适用于本机所有联系人，通常保持默认即可</small></summary><div class="capability-form-grid"><label><span>共享等待时间（毫秒）</span><input name="timeoutMs" type="number" min="1000" max="600000" value="${escapeHtml(saved.timeoutMs ?? 30000)}"></label></div></details>`, "保存当前联系人语音设置");
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

function renderSiteAutomationBrowserSettings(capability) {
  const configuration = capabilitySettings(capability).configuration || {};
  return settingsForm("site-automation", `<details class="capability-advanced"><summary><span>浏览器设置</span><small>通常不需要调整</small></summary>${capabilitySettingSection("网页自动化", "浏览器连接", "各网站共用 Suzu Lives 的专用浏览器；登录状态不会显示在这里。", `<div class="capability-form-grid"><label class="wide"><span>浏览器连接地址</span><input name="cdpUrl" value="${escapeHtml(configuration.cdpUrl || "http://127.0.0.1:9222")}" maxlength="500"></label><label><span>页面操作等待（毫秒）</span><input name="timeoutMs" type="number" min="1000" max="120000" value="${escapeHtml(configuration.timeoutMs ?? 10000)}"></label><label><span>打开页面等待（毫秒）</span><input name="navigationTimeoutMs" type="number" min="1000" max="180000" value="${escapeHtml(configuration.navigationTimeoutMs ?? 25000)}"></label><label class="capability-checkbox"><input name="autoStartBrowser" type="checkbox" ${configuration.autoStartBrowser !== false ? "checked" : ""}><span>需要时启动专用浏览器</span></label></div>`)}<details class="capability-advanced"><summary><span>本机运行工具</span><small>只在 Python 不在系统默认位置时调整</small></summary><div class="capability-form-grid"><label class="wide"><span>Python 命令</span><input name="pythonCommand" value="${escapeHtml(configuration.pythonCommand || "python")}" maxlength="300"></label></div></details><footer><button class="secondary-button">保存浏览器设置</button></footer></details>`, "");
}

function renderSiteAutomationOverview(capability) {
  const sites = Array.isArray(capabilitySettings(capability).sites) ? capabilitySettings(capability).sites : [];
  const cards = sites.map((site) => {
    const enabledActions = (site.actions || []).filter((action) => action.enabled !== false).length;
    return `<button type="button" class="site-automation-site-card" data-open-site-automation-site="${escapeHtml(site.id)}"><span class="site-automation-site-card__top">${status(site.enabled !== false ? "已启用" : "已关闭", site.enabled !== false ? "ready" : "muted")}</span><span class="site-automation-site-card__copy"><span class="reference-kicker">已接入网站</span><strong>${escapeHtml(site.name)}</strong><small>${enabledActions} / ${(site.actions || []).length} 个动作可用</small></span><span class="site-automation-site-card__enter">配置动作 <b aria-hidden="true">→</b></span></button>`;
  }).join("");
  return `${capabilitySettingSection("网页自动化", "已接入的网站", "每个网站单独管理。新增网站后会自动出现在这里，不需要再造一套能力页面。", cards ? `<div class="site-automation-site-grid">${cards}</div>` : emptyBlock(icons.sliders, "还没有接入网站", "接入新的站点适配器后，它会出现在这里。"))}${renderSiteAutomationBrowserSettings(capability)}`;
}

function renderSiteAutomationSiteSettings(capability, site) {
  const actionSections = actionGroups(site).map(([group, actions]) => `<section class="site-automation-action-group"><h4>${escapeHtml(group)}</h4><div class="site-automation-action-list">${actions.map((action) => `<article class="site-automation-action"><div><div class="site-automation-action__meta">${status(action.mutating ? "会执行操作" : "只读取", action.mutating ? "muted" : "ready")}</div><h5>${escapeHtml(action.label || action.id)}</h5><p>${escapeHtml(action.description || "")}</p></div><label class="capability-toggle"><input type="checkbox" data-site-action-enabled="${escapeHtml(site.id)}" data-site-action="${escapeHtml(action.id)}" ${action.enabled !== false ? "checked" : ""} aria-label="${escapeHtml(`${action.enabled !== false ? "关闭" : "开启"}${site.name}的${action.label || action.id}`)}"><span aria-hidden="true"></span></label></article>`).join("")}</div></section>`).join("");
  return `<section class="site-automation-site-settings"><div class="site-automation-site-settings__head"><div><span class="reference-kicker">网页自动化 / 已接入网站</span><h3>${escapeHtml(site.name)}</h3><p>关闭网站后，${escapeHtml(site.name)} 的所有动作都会停止；单个动作的开关会保留，重新启用网站时继续生效。</p></div><label class="capability-toggle"><input type="checkbox" data-site-enabled="${escapeHtml(site.id)}" ${site.enabled !== false ? "checked" : ""} aria-label="${escapeHtml(`${site.enabled !== false ? "关闭" : "开启"}${site.name}`)}"><span aria-hidden="true"></span></label></div><section class="site-automation-actions"><header><div><span class="reference-kicker">动作节点</span><h4>允许 ${escapeHtml(site.name)} 做什么</h4><p>每一项都会在真实的站点适配器入口处校验；关闭后，Agent 直接调用也会被拒绝。</p></div></header>${actionSections}</section></section>`;
}

function renderSiteAutomationSettings(capability, state) {
  const sites = Array.isArray(capabilitySettings(capability).sites) ? capabilitySettings(capability).sites : [];
  const selected = sites.find((site) => site.id === state.siteAutomationSelectedSiteId);
  return selected ? renderSiteAutomationSiteSettings(capability, selected) : renderSiteAutomationOverview(capability);
}

function renderTravelingMerchantSettings(capability, state) {
  const saved = capabilitySettings(capability);
  const items = Array.isArray(saved.wantedItems) ? saved.wantedItems.join("\n") : "";
  return settingsForm("traveling-merchant", `${capabilitySettingSection("远行商人", "关注与提醒", "输入想买的物品；检测到其中任意一项时，会按你的通知文案提醒。", `<div class="capability-form-grid"><label class="wide"><span>关注的物品</span><textarea name="wantedItems" maxlength="8000" placeholder="棱镜球&#10;炫彩蛋">${escapeHtml(items)}</textarea></label><label class="wide"><span>发现物品时的提醒</span><input name="notificationTemplate" value="${escapeHtml(saved.notificationTemplate || "远行商人这轮有：{items}，快去买")}" maxlength="1200"></label><label class="capability-checkbox"><input name="notifyOnError" type="checkbox" ${saved.notifyOnError !== false ? "checked" : ""}><span>检查失败时也提醒我</span></label><label class="wide"><span>失败提醒</span><input name="errorNotificationTemplate" value="${escapeHtml(saved.errorNotificationTemplate || "远行商人监控这轮检查失败了：{error}")}" maxlength="1200"></label></div>`)}${renderSessionDeliverySettings(capability, state, "打开后，这个会话会收到商人命中或已开启的失败提醒；可以同时开启多个会话。网页只抓取一次，再分别投递。 ")}${capabilityInfoSection("读取网页", "当前读取网页", saved.url || "尚未设置页面地址", '<button type="button" class="secondary-button" data-open-traveling-merchant-page>打开当前读取网页</button>')}<details class="capability-advanced"><summary><span>检查节奏</span><small>网站地址、超时与重试</small></summary><div class="capability-form-grid"><label class="wide"><span>页面地址</span><input name="url" value="${escapeHtml(saved.url || "")}" maxlength="500"></label><label><span>网页等待（秒）</span><input name="requestTimeoutSeconds" type="number" min="3" max="120" value="${escapeHtml(saved.requestTimeoutSeconds ?? 15)}"></label><label><span>重试次数</span><input name="maxAttempts" type="number" min="1" max="10" value="${escapeHtml(saved.maxAttempts ?? 3)}"></label><label><span>重试间隔（秒）</span><input name="retryDelaySeconds" type="number" min="0" max="300" value="${escapeHtml(saved.retryDelaySeconds ?? 20)}"></label></div></details>`, "保存远行商人设置");
}

function renderIphoneBridgeSettings(capability, state) {
  const saved = capabilitySettings(capability);
  const status = saved.saved
    ? "邮件连接已配置。本地接收器会在软件运行时直接把反馈投递到下方勾选的会话。"
    : "请先在能力页完成 iPhone 邮件连接设置，然后再选择接收会话。";
  return `${capabilityInfoSection("iPhone 反馈", "本地直接接收", status)}${renderSessionDeliverySettings(capability, state, "可以同时勾选多个会话；一封手机反馈会分别排进每个会话。这里只决定接收范围。")}`;
}

function renderCapabilitySetting(capability, state) {
  if (capability.id === "image-generation") return renderImageGenerationSettings(capability, state);
  if (capability.id === "phone-camera") return renderPhoneCameraSettings(capability, state);
  if (capability.id === "visual-reference-manager") return capabilityInfoSection("视觉资料", "在视觉工作台整理参考", "把参考图、描述和分类放在视觉工作台中；图片生成会直接使用这里的资料。", '<button type="button" class="secondary-button" data-open-capability-settings="visual">打开视觉工作台</button>');
  if (capability.id === "voice-message") return renderVoiceMessageSettings(capability, state);
  if (capability.id === "image-vision") return renderImageVisionSettings(capability, state);
  if (capability.id === "video-understanding") return renderVideoUnderstandingSettings(capability, state);
  if (capability.id === "web-browser") return capabilityInfoSection("专用浏览器", "在独立浏览器中完成登录", "这项能力会使用当前联系人的专用浏览器资料。首次登录后，Agent 才能在已授权的网站里继续操作。");
  if (capability.id === "site-automation") return renderSiteAutomationSettings(capability, state);
  if (capability.id === "iphone-bridge") return renderIphoneBridgeSettings(capability, state);
  if (capability.id === "proactive-contact") return renderProactiveContactSettings(capability, state);
  if (capability.id === "traveling-merchant") return renderTravelingMerchantSettings(capability, state);
  return capabilityInfoSection("能力资料", "这项能力已准备好", "当前没有需要单独调整的选项。");
}

function renderCapabilityDetail(capability, state, { showHeader = true, showSwitch = true } = {}) {
  const enabled = capability.enabled === true;
  const switchDisabled = capability.canToggle !== true;
  const stateCopy = enabled
    ? "当前联系人可以在新的会话中使用它。"
    : "关闭后，当前联系人不会使用它；已有设置和资料会保留。";
  const header = showHeader ? `<header class="capability-detail__header"><div><span class="reference-kicker">${escapeHtml(CAPABILITY_CATEGORIES.find((item) => item.id === capabilityCategory(capability))?.label || "能力")}</span><h2>${escapeHtml(capability.name)}</h2><p>${escapeHtml(capability.description)}</p></div>${status(enabled ? "已开启" : "未开启", enabled ? "ready" : "muted")}</header>` : "";
  const abilitySwitch = showSwitch ? `<div class="capability-detail__switch"><div><strong>使用这项能力</strong><p>${escapeHtml(stateCopy)}</p>${switchDisabled ? `<small>${escapeHtml(capability.toggleReason || capability.addReason || "先创建并选择联系人。")}</small>` : ""}</div><label class="capability-toggle"><input type="checkbox" data-toggle-capability="${escapeHtml(capability.id)}" ${enabled ? "checked" : ""} ${switchDisabled ? "disabled" : ""} aria-label="${escapeHtml(`${enabled ? "关闭" : "开启"}${capability.name}`)}"><span aria-hidden="true"></span></label></div>` : "";
  return `<article class="capability-detail ${showHeader ? "" : "capability-detail--focus"}">${header}${abilitySwitch}<div class="capability-detail__content">${renderCapabilitySetting(capability, state)}</div></article>`;
}

function renderCapabilityEntry(capability) {
  const enabled = capability.enabled === true;
  return `<button type="button" class="capability-entry-card" data-open-capability="${escapeHtml(capability.id)}" data-capability-category="${escapeHtml(capabilityCategory(capability))}"><span class="capability-entry-card__top">${status(enabled ? "已开启" : "未开启", enabled ? "ready" : "muted")}</span><span class="capability-entry-card__copy"><strong>${escapeHtml(capability.name)}</strong><small>${escapeHtml(capability.description)}</small></span><span class="capability-entry-card__enter">查看与设置 <b aria-hidden="true">→</b></span></button>`;
}

function renderCapabilityCategoryCard(category, capabilities) {
  const members = capabilities.filter((capability) => capabilityCategory(capability) === category.id);
  const enabled = members.filter((capability) => capability.enabled === true).length;
  return `<button type="button" class="capability-space-card capability-space-card--${escapeHtml(category.id)}" data-open-capability-category="${escapeHtml(category.id)}"><span class="capability-space-card__top"><span class="capability-space-card__symbol" aria-hidden="true">${category.id === "create" ? "◌" : category.id === "perceive" ? "◈" : category.id === "act" ? "↗" : "✦"}</span>${status(`${enabled} / ${members.length} 已开启`, enabled ? "ready" : "muted")}</span><span class="capability-space-card__copy"><span class="reference-kicker">${escapeHtml(category.id.toUpperCase())}</span><strong>${escapeHtml(category.label)}</strong><small>${escapeHtml(category.detail)}</small></span><span class="capability-space-card__enter">进入 <b aria-hidden="true">→</b></span></button>`;
}

function externalCapabilityStatus(capability) {
  if (capability.status === "registered") return ["已登记", "ready"];
  if (capability.status === "partial") return ["登记不完整", "muted"];
  if (capability.status === "error") return ["需要处理", "muted"];
  return ["未登记", "muted"];
}

function externalCapabilityTypeLabel(type) {
  return ({ skill: "Skill", mcp: "MCP", cli: "CLI（预留）" })[type] || type;
}

function renderExternalCapabilityCard(capability) {
  const [stateLabel, stateTone] = externalCapabilityStatus(capability);
  const diagnostics = Array.isArray(capability.diagnostics) ? capability.diagnostics : [];
  const types = Array.isArray(capability.types) ? capability.types : [];
  const source = capability.source || {};
  const enableLabel = capability.enabled ? "再次启用以更新登记" : "启用并登记到当前联系人";
  const enableDisabled = capability.canEnable !== true ? "disabled" : "";
  const disableDisabled = capability.canDisable !== true ? "disabled" : "";
  return `<article class="capability-detail capability-detail--focus"><header class="capability-detail__header"><div><span class="reference-kicker">EXTERNAL / ${escapeHtml(types.map(externalCapabilityTypeLabel).join(" + ") || "CAPABILITY")}</span><h2>${escapeHtml(capability.name || capability.id)}</h2><p>${escapeHtml(capability.description || "没有提供能力说明。")}</p></div>${status(stateLabel, stateTone)}</header><div class="capability-detail__content">${capabilitySettingSection("清单", "版本与来源", "导入时会保存一份清单副本；不会下载或执行其中的第三方代码。", `<div class="capability-form-grid"><div><span>版本</span><strong>${escapeHtml(capability.version || "—")}</strong></div><div class="wide"><span>本地来源</span><small>${escapeHtml(source.manifestPath || "来源路径不可用")}</small></div></div>`)}${capabilitySettingSection("当前宿主", "Claude Code 项目登记", "这是当前的 Claude Code 安装器。清单本身不依赖 Claude，未来可由其他 Agent runtime 安装；“已登记”不表示程序已经运行。", `<div class="capability-inline-action"><div><strong>${escapeHtml(stateLabel)}</strong><small>${escapeHtml(capability.enabled ? "Skill 和 MCP 的受管条目已写入当前项目；Claude Code 仍会按自己的批准流程决定何时连接或运行。" : "启用只会安全写入当前项目的受管 Skill/MCP 配置。")}</small></div><button type="button" class="secondary-button" data-enable-external-capability="${escapeHtml(capability.id)}" ${enableDisabled}>${escapeHtml(enableLabel)}</button><button type="button" class="text-button" data-disable-external-capability="${escapeHtml(capability.id)}" ${disableDisabled}>停用</button></div>`)}${diagnostics.length ? capabilitySettingSection("诊断", "静态检查", "只检查本地文件、登记状态与配置形状，不会启动命令或联网。", `<ul class="capability-setting-empty">${diagnostics.map((diagnostic) => `<li>${escapeHtml(diagnostic.message || diagnostic.code || "未知诊断")}</li>`).join("")}</ul>`) : ""}${capabilityInfoSection("移除", "从 Suzu Lives 移除", "会先从所有已登记项目删除仅属于 Suzu Lives 的条目；任何冲突、项目缺失或手动修改都会中止并保留文件。", `<button type="button" class="text-button" data-remove-external-capability="${escapeHtml(capability.id)}">移除</button>`)}</div></article>`;
}

function renderExternalCapabilities(state) {
  const snapshot = state.externalCapabilities || { projectRoot: "", capabilities: [] };
  const capabilities = Array.isArray(snapshot.capabilities) ? snapshot.capabilities : [];
  const project = String(snapshot.projectRoot || "").trim();
  const action = `<div class="capability-page-actions"><button type="button" class="secondary-button" data-return-capabilities>返回能力</button></div>`;
  const intro = pageIntro("CAPABILITIES / EXTERNAL", "外部能力", "导入用户明确选择的本地清单。当前仅安装到所选联系人的 Claude Code 项目；不会运行或下载第三方代码。", action);
  const importAction = `<div class="capability-inline-action"><div><strong>${project ? "当前联系人项目已选择" : "尚未选择联系人项目"}</strong><small>${escapeHtml(project || "仍可导入并查看清单；启用前需要先选择联系人。")}</small></div><button type="button" class="primary-button" data-import-external-capability>导入 suzu-capability.json</button></div>`;
  if (!capabilities.length) return `${intro}<section class="capability-detail capability-detail--focus">${importAction}${emptyBlock(icons.sliders, "还没有外部能力", "选择本地 suzu-capability.json 后，这里会显示静态诊断和当前联系人中的登记状态。")}</section>`;
  return `${intro}<section class="capability-detail capability-detail--focus">${importAction}</section><section class="capability-detail-page">${capabilities.map(renderExternalCapabilityCard).join("")}</section>`;
}

export function renderCapabilities({ state }) {
  const snapshot = state.capabilitySnapshot;
  const intro = pageIntro("CAPABILITIES", "能力", "从一个方向进入，再为每项能力单独设置。 ");
  if (state.capabilityPage === "external") return renderExternalCapabilities(state);
  if (!snapshot) return `${intro}${emptyBlock(icons.sliders, "正在读取能力", "这里会显示当前联系人可以使用的能力。")}`;
  const capabilities = [...(snapshot.capabilities || []), wechatConnectionCapability(state)];
  const categoryIds = new Set(capabilities.map(capabilityCategory));
  const categories = CAPABILITY_CATEGORIES.filter((category) => categoryIds.has(category.id));
  if (!categories.length) return `${intro}${emptyBlock(icons.sliders, "还没有能力", "创建并选择联系人后，这里会显示可用能力。")}`;
  if (state.capabilityPage !== "category" && state.capabilityPage !== "detail") {
    const external = state.externalCapabilities;
    const externalCount = Array.isArray(external?.capabilities) ? external.capabilities.length : 0;
    const externalEntry = `<section class="capability-detail capability-detail--focus"><div class="capability-inline-action"><div><span class="reference-kicker">EXTERNAL</span><strong>外部能力</strong><small>${externalCount ? `已导入 ${externalCount} 项本地能力；可查看诊断并登记到当前联系人。` : "导入一个本地 suzu-capability.json，接入 Skill 或 MCP。"}</small></div><button type="button" class="secondary-button" data-open-external-capabilities>打开外部能力</button></div></section>`;
    return `${intro}<section class="capability-space-grid">${categories.map((category) => renderCapabilityCategoryCard(category, capabilities)).join("")}</section>${externalEntry}`;
  }
  const activeCategory = categories.some((category) => category.id === state.capabilityCategory) ? state.capabilityCategory : categories[0].id;
  const visible = capabilities.filter((capability) => capabilityCategory(capability) === activeCategory);
  const category = categories.find((item) => item.id === activeCategory) || categories[0];
  const categoryAction = '<button type="button" class="secondary-button" data-return-capabilities>返回能力</button>';
  const categoryIntro = pageIntro(`CAPABILITIES / ${category.label}`, category.label, category.detail, categoryAction);
  if (state.capabilityPage === "category") {
    return `${categoryIntro}<section class="capability-entry-grid">${visible.map(renderCapabilityEntry).join("")}</section>`;
  }
  const selected = visible.find((capability) => capability.id === state.capabilitySelectedId) || visible[0];
  if (!selected) return `${categoryIntro}${emptyBlock(icons.sliders, "这个分类还没有能力", "返回能力页后可以选择其他方向。", categoryAction)}`;
  if (selected.id === "wechat-connection") {
    const detailAction = `<div class="capability-page-actions">${status(selected.enabled ? "已开启" : "未开启", selected.enabled ? "ready" : "muted")}<button type="button" class="secondary-button" data-return-capability-category="${escapeHtml(activeCategory)}">返回${escapeHtml(category.label)}</button></div>`;
    const detailIntro = pageIntro(`CAPABILITIES / ${category.label}`, selected.name, selected.description, detailAction);
    return `${detailIntro}<section class="capability-detail-page">${renderWechatConnectionDetail(state)}</section>`;
  }
  const selectedSite = selected.id === "site-automation"
    ? (selected.savedSettings?.sites || []).find((site) => site.id === state.siteAutomationSelectedSiteId)
    : null;
  const detailAction = `<div class="capability-page-actions">${status(selectedSite ? (selectedSite.enabled !== false ? "已启用" : "已关闭") : (selected.enabled ? "已开启" : "未开启"), selectedSite ? (selectedSite.enabled !== false ? "ready" : "muted") : (selected.enabled ? "ready" : "muted"))}<button type="button" class="secondary-button" ${selectedSite ? "data-return-site-automation-sites" : `data-return-capability-category="${escapeHtml(activeCategory)}"`}>${selectedSite ? "返回网页自动化" : `返回${escapeHtml(category.label)}`}</button></div>`;
  const detailIntro = pageIntro(selectedSite ? `CAPABILITIES / ${category.label} / 网页自动化` : `CAPABILITIES / ${category.label}`, selectedSite?.name || selected.name, selectedSite ? "设置这个网站允许 Agent 使用的动作。" : selected.description, detailAction);
  return `${detailIntro}<section class="capability-detail-page">${renderCapabilityDetail(selected, state, { showHeader: false, showSwitch: !selectedSite })}</section>`;
}

function renderAdminOverview() {
  const ready = isReady();
  return `<section class="feature-grid">${card("我", "设置我在聊天中的显示名和头像。", `<div class="module-state">${status("可设置", "ready")}<p>这项设置会用于聊天中“我”的显示。</p><button class="secondary-button" data-open-admin="agent">设置我的身份</button></div>`)}${card("用量与成本", "已支持的费用记录和价格编辑。", `<div class="module-state">${status(ready ? "可查看" : "等待创建", ready ? "ready" : "muted")}<p>没有记录不等于没有费用；这里只汇总能够识别的来源。</p><button class="secondary-button" data-open-admin="usage">打开用量与成本</button></div>`)}</section>`;
}

function renderAgentSettings({ state }) {
  return renderIdentitySettings(state.settings || {}, state);
}

function renderClaudeCodeApi({ state }) {
  const config = state.claudeCodeApi || {};
  const providerId = CLAUDE_CODE_API_PROVIDERS[config.providerId] ? config.providerId : "deepseek";
  const provider = CLAUDE_CODE_API_PROVIDERS[providerId];
  const custom = providerId === "custom";
  const model = config.model || provider.models?.model || "";
  const models = state.claudeCodeModels || [];
  const message = state.claudeCodeModelNotice || "";
  const statusLabel = config.status === "ready" ? "已配置" : "等待填写";
  const statusTone = config.status === "ready" ? "ready" : "muted";
  const modelHelp = config.hasApiKey
    ? "已保存密钥；留空不会覆盖。点“获取模型列表”才会向当前服务请求。"
    : "填写并保存 API Key 后，Claude Code 才会使用这项服务。";
  return `<section class="runtime-settings claude-code-api-page"><header class="runtime-settings__intro"><span class="reference-kicker">CLAUDE CODE</span><h2>Claude Code API</h2><p>配置本机 Claude Code 的文字模型服务。密钥只保存到这台电脑的 Claude 配置里，不会回显到页面。</p></header><section class="runtime-config-card runtime-config-card--detail"><header><div><span class="reference-kicker">TEXT MODEL</span><h2>${escapeHtml(provider.label)}</h2><p>${escapeHtml(modelHelp)}</p></div>${status(statusLabel, statusTone)}</header><form id="claudeCodeApiForm" class="runtime-config-form"><section class="runtime-config-form__section runtime-config-form__section--surface"><div class="runtime-section-heading"><div><h3>使用哪个服务</h3><p>选择后会自动填入官方兼容地址；只有“自定义”需要自己输入地址。</p></div></div><div class="runtime-config-form__grid"><label><span>服务</span><select name="provider" data-claude-api-provider>${claudeCodeApiProviderOptions(providerId)}</select></label><label class="wide"><span>服务地址</span><input name="baseUrl" value="${escapeHtml(config.baseUrl || provider.baseUrl)}" maxlength="500" ${custom ? "" : "readonly"} data-claude-api-base-url><small data-claude-api-base-copy>${custom ? "填写服务商给出的 Anthropic 兼容地址。" : "内置地址；切换到自定义后才可以修改。"}</small></label><label><span>API Key</span><input name="apiKey" type="password" autocomplete="new-password" maxlength="1000" placeholder="${config.hasApiKey ? "已保存；重新填写才会替换" : "保存服务时填写"}"></label><label class="runtime-checkbox"><input name="skipOnboarding" type="checkbox" ${config.skipOnboarding !== false ? "checked" : ""}><span>跳过 Claude Code 首次登录确认</span></label></div></section><section class="runtime-config-form__section runtime-config-form__section--surface"><div class="runtime-section-heading"><div><h3>使用的模型</h3><p>可以直接输入模型名，或点击获取后从当前服务返回的列表中选择。</p></div></div><div class="runtime-config-form__grid"><label class="wide"><span>主模型</span><input name="model" list="claudeCodeApiModels" value="${escapeHtml(model)}" maxlength="200" placeholder="例如：deepseek-v4-pro[1m]" data-claude-api-model><datalist id="claudeCodeApiModels">${claudeCodeApiModelOptions(model, models)}</datalist></label></div><div class="claude-api-model-actions"><button type="button" class="secondary-button" data-fetch-claude-code-models>获取模型列表</button>${message ? `<p>${escapeHtml(message)}</p>` : ""}</div></section><details class="runtime-config-form__advanced"><summary><span>更多模型与兼容设置</span><small>只有服务商要求不同模型映射时再调整</small></summary><div class="runtime-config-form__grid"><label><span>Sonnet 映射</span><input name="sonnetModel" value="${escapeHtml(config.sonnetModel || model)}" maxlength="200"></label><label><span>Opus 映射</span><input name="opusModel" value="${escapeHtml(config.opusModel || model)}" maxlength="200"></label><label><span>Haiku 映射</span><input name="haikuModel" value="${escapeHtml(config.haikuModel || model)}" maxlength="200"></label><label><span>子 Agent 模型</span><input name="subagentModel" value="${escapeHtml(config.subagentModel || config.haikuModel || model)}" maxlength="200"></label><label><span>默认思考强度</span>${runtimeChoice("effortLevel", config.effortLevel || "", [["", "沿用服务默认"], ["low", "低"], ["medium", "中"], ["high", "高"], ["max", "最高"]])}</label><label data-claude-api-auth-mode ${custom ? "" : "hidden"}><span>密钥传递方式</span><select name="authMode"><option value="auth-token" ${config.authMode !== "api-key" ? "selected" : ""}>Authorization Bearer</option><option value="api-key" ${config.authMode === "api-key" ? "selected" : ""}>x-api-key</option></select></label><label class="wide" data-claude-api-custom-model-list ${custom ? "" : "hidden"}><span>模型列表地址（可选）</span><input name="modelListUrl" maxlength="500" placeholder="留空时按服务地址自动推导"><small>只用于点击“获取模型列表”，不会写入 Claude Code 配置。</small></label></div></details><footer><button class="primary-button">保存 Claude Code API</button></footer></form></section></section>`;
}

function runtimeChoice(name, value, options) {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}"><div class="runtime-choice" data-runtime-choice="${escapeHtml(name)}">${options.map(([id, label]) => `<button type="button" class="runtime-choice__option ${value === id ? "active" : ""}" data-runtime-choice-value="${escapeHtml(id)}">${escapeHtml(label)}</button>`).join("")}</div>`;
}

function listFieldValue(value) {
  return Array.isArray(value) ? value.join("\n") : "";
}

function claudeModelSlot(name, value) {
  return `<fieldset class="runtime-model-slot"><legend>${escapeHtml(name)}</legend><label><span>模型标识</span><input name="${escapeHtml(value.key)}Model" value="${escapeHtml(value.model || "")}" maxlength="200" placeholder="服务实际使用的模型名"></label><label><span>显示名称</span><input name="${escapeHtml(value.key)}ModelName" value="${escapeHtml(value.name || "")}" maxlength="200" placeholder="会话中显示的名称"></label></fieldset>`;
}

function renderClaudeRuntime(claude) {
  if (claude?.status === "needs-project") return `<section class="runtime-config-card"><header><div><span class="reference-kicker">CLAUDE CODE</span><h2>Claude Code</h2><p>先在会话中创建并选择联系人，软件才知道要编辑哪一份项目配置。</p></div></header><button class="secondary-button" data-open-contact-conversation>前往会话</button></section>`;
  if (!claude || ["invalid", "unavailable"].includes(claude.status)) return `<section class="runtime-config-card"><header><div><span class="reference-kicker">CLAUDE CODE</span><h2>Claude Code</h2><p>${escapeHtml(claude?.message || "暂时无法读取这份配置。")}</p></div></header></section>`;
  const config = claude.settings || {};
  const textService = config.textService || {};
  const sourceCopy = claude.deviceExists
    ? "文字模型服务沿用这台电脑的 Claude Code 设置；当前联系人只管理项目工具规则，已有设置会保留。"
    : claude.exists
      ? "这页管理当前联系人的 Claude 设置，已有项目设置会保留。"
      : "保存后会在这台电脑和当前联系人项目创建所需的 Claude Code 设置。";
  return `<section class="runtime-config-card runtime-config-card--detail"><header><div><span class="reference-kicker">CLAUDE CODE</span><h2>Claude Code</h2><p>${sourceCopy}</p></div>${status(claude.exists ? "已连接" : "准备设置", claude.exists ? "ready" : "muted")}</header><form id="claudeRuntimeConfigForm" class="runtime-config-form"><section class="runtime-config-form__section runtime-config-form__section--surface"><div class="runtime-section-heading"><div><h3>日常偏好</h3><p>影响 Claude Code 在当前联系人项目中的默认行为。</p></div></div><div class="runtime-config-form__grid"><label class="runtime-checkbox"><input name="alwaysThinkingEnabled" type="checkbox" ${config.alwaysThinkingEnabled ? "checked" : ""}><span>始终开启深度思考</span></label><label class="runtime-checkbox"><input name="includeCoAuthoredBy" type="checkbox" ${config.includeCoAuthoredBy ? "checked" : ""}><span>提交时包含 Claude 协作署名</span></label></div></section><section class="runtime-config-form__section runtime-config-form__section--surface"><div class="runtime-section-heading"><div><h3>文本模型服务</h3><p>只在当前 Claude Code 使用自定义服务或模型别名时调整；访问令牌不会回显。</p></div></div><div class="runtime-config-form__grid"><label class="wide"><span>服务地址</span><input name="baseUrl" value="${escapeHtml(textService.baseUrl || "")}" maxlength="500" placeholder="留空时沿用已有服务"></label><label><span>访问令牌</span><input name="authToken" type="password" autocomplete="new-password" maxlength="1000" placeholder="${textService.hasAuthToken ? "已保存；重新填写才会替换" : "按需要填写"}"></label><label class="runtime-checkbox"><input name="clearAuthToken" type="checkbox"><span>移除已保存的访问令牌</span></label></div><div class="runtime-model-grid">${claudeModelSlot("Sonnet", { key: "sonnet", ...(textService.sonnet || {}) })}${claudeModelSlot("Opus", { key: "opus", ...(textService.opus || {}) })}${claudeModelSlot("Haiku", { key: "haiku", ...(textService.haiku || {}) })}</div></section><details class="runtime-config-form__advanced"><summary><span>工具与网络规则</span><small>只有明确需要固定规则时才调整</small></summary><div class="runtime-config-form__grid"><label class="wide"><span>默认允许的工具</span><textarea name="allowedTools" maxlength="50000" placeholder="每行一个，例如：Read&#10;Grep">${escapeHtml(listFieldValue(config.allowedTools))}</textarea></label><label class="wide"><span>始终禁止的工具</span><textarea name="deniedTools" maxlength="50000" placeholder="每行一个，例如：Read(./.env)">${escapeHtml(listFieldValue(config.deniedTools))}</textarea></label><label class="runtime-checkbox wide"><input name="skipWebFetchPreflight" type="checkbox" ${config.skipWebFetchPreflight ? "checked" : ""}><span>跳过 Web Fetch 的预检</span></label></div></details><footer><button class="primary-button">保存 Claude Code 设置</button></footer></form></section>`;
}

function runtimeOverviewCard({ id, kicker, title, copy, stateLabel, stateTone }) {
  return `<button type="button" class="runtime-connection-card" data-open-runtime-section="${escapeHtml(id)}"><span class="runtime-connection-card__symbol" aria-hidden="true">${id === "claude" ? "✦" : "↗"}</span><span class="runtime-connection-card__copy"><span class="reference-kicker">${escapeHtml(kicker)}</span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(copy)}</small></span>${status(stateLabel, stateTone)}<span class="runtime-connection-card__enter">查看设置 <b aria-hidden="true">→</b></span></button>`;
}

function renderRuntimeSettings({ state }) {
  const snapshot = state.agentRuntime;
  const section = state.runtimeSection || "overview";
  const intro = `<header class="runtime-settings__intro"><span class="reference-kicker">RUNTIME</span><h2>连接与运行</h2><p>管理所有联系人的默认运行规则，以及当前联系人项目的 Claude Code 设置；密钥不会在页面显示。</p></header>`;
  if (section === "claude") return `<section class="runtime-settings">${intro}<div class="runtime-detail-head"><button type="button" class="text-button" data-return-runtime-overview>← 返回连接概览</button></div>${renderClaudeRuntime(snapshot?.claude)}</section>`;
  const defaults = renderManagedAgentRuntimeSettings({ state });
  if (!snapshot) return `<section class="runtime-settings">${intro}${defaults}${emptyBlock(icons.sliders, "正在读取当前联系人配置", "选择一位联系人后，可以查看并调整它的 Claude Code 设置。")}</section>`;
  const claude = snapshot.claude || {};
  const claudeReady = claude.status === "ready" || claude.status === "available";
  return `<section class="runtime-settings">${intro}${defaults}<div class="runtime-connection-grid">${runtimeOverviewCard({ id: "claude", kicker: "CLAUDE CODE", title: "Claude Code", copy: claudeReady ? "本机文字模型与当前联系人的工具权限。" : "选择联系人后，可以查看并调整当前项目。", stateLabel: claudeReady ? "已连接" : "需要设置", stateTone: claudeReady ? "ready" : "muted" })}</div></section>`;
}

const API_BINDINGS = [
  { id: "image-generation", label: "生图", detail: "视觉工作台、Agent 生图与手机拍照式生图", types: ["dashscope"], selected: (bindings) => bindings["image-workbench"] || "" },
  { id: "image-vision", label: "理解图像", detail: "图片理解能力", types: ["openai-compatible", "dashscope", "generic-api"], selected: (bindings) => bindings["image-vision"] || "" },
  { id: "sound", label: "声音", detail: "音色设计与文字转语音", types: ["dashscope"], selected: (bindings) => bindings["voice-design"] || bindings["voice-message"] || "" },
  { id: "video-understanding", label: "理解视频", detail: "视频理解能力", types: ["openai-compatible", "dashscope", "generic-api"], selected: (bindings) => bindings["video-understanding"] || "" },
  { id: "memory-embedding", label: "记忆向量", detail: "用于长期记忆的语义召回；百炼连接默认使用 text-embedding-v4（1024 维）", types: ["openai-compatible", "dashscope"], selected: (bindings) => bindings["memory-embedding"] || "" },
];

function apiBindingOptions(connections, item, selectedId) {
  const available = connections.filter((connection) => item.types.includes(connection.type));
  const options = item.defaultsToAgent
    ? [{ id: "", name: "Claude Code 文字模型", detail: "沿用日常对话使用的 API" }, ...available]
    : available;
  return options.map((connection) => ({
    ...connection,
    selected: connection.id === selectedId,
  }));
}

function renderApiBindingPicker(state, item, connections, bindings) {
  const selectedId = item.selected(bindings);
  const options = apiBindingOptions(connections, item, selectedId);
  const selected = options.find((option) => option.selected);
  const open = state.apiBindingPickerOpen === item.id;
  const disabled = !options.length;
  const currentLabel = selected?.name || (disabled ? "还没有可用 API" : "选择 API");
  const menuId = `api-binding-menu-${item.id}`;
  return `<div class="api-binding-picker" data-api-binding="${escapeHtml(item.id)}" data-api-binding-picker="${escapeHtml(item.id)}"><button type="button" class="api-binding-picker__trigger" data-open-api-binding="${escapeHtml(item.id)}" aria-haspopup="listbox" aria-expanded="${open ? "true" : "false"}" aria-controls="${menuId}" ${disabled ? "disabled" : ""}><span>${escapeHtml(currentLabel)}</span><span class="api-binding-picker__chevron" aria-hidden="true">⌄</span></button><div id="${menuId}" class="api-binding-picker__menu ${open ? "open" : ""}" role="listbox" aria-label="${escapeHtml(item.label)}使用的 API">${options.map((option) => `<button type="button" class="api-binding-picker__option ${option.selected ? "selected" : ""}" role="option" aria-selected="${option.selected ? "true" : "false"}" data-select-api-binding="${escapeHtml(item.id)}" data-api-connection-id="${escapeHtml(option.id)}"><span>${escapeHtml(option.name)}</span>${option.detail ? `<small>${escapeHtml(option.detail)}</small>` : ""}</button>`).join("")}</div></div>`;
}

function apiUsage(connection, bindings) {
  const usedBy = API_BINDINGS.filter((item) => item.selected(bindings) === connection.id).map((item) => item.label);
  return usedBy.length ? `用于 ${usedBy.join("、")}` : "暂未分配";
}

function renderApiConnectionManagerRow(connection, bindings) {
  return `<article class="api-connection-manager__row"><div><strong>${escapeHtml(connection.name)}</strong><p>${escapeHtml(apiUsage(connection, bindings))}</p></div><div class="api-connection-manager__actions"><button class="secondary-button" data-edit-api-connection="${escapeHtml(connection.id)}">编辑</button><button class="text-button" data-remove-api-connection="${escapeHtml(connection.id)}">移除</button></div></article>`;
}

function renderApiConnectionManager(state, connections, bindings) {
  if (!state.apiConnectionManagerOpen || state.apiConnectionEditorOpen) return "";
  const content = connections.length
    ? `<div class="api-connection-manager__list">${connections.map((item) => renderApiConnectionManagerRow(item, bindings)).join("")}</div>`
    : '<div class="api-connection-manager__empty"><strong>还没有添加 API</strong><p>添加后，就能在功能列表里选择它。</p></div>';
  return `<div class="api-connection-overlay"><aside class="api-connection-sheet api-connection-manager" role="dialog" aria-modal="true" aria-labelledby="apiConnectionManagerTitle"><header class="api-connection-sheet__header"><div><span class="reference-kicker">API</span><h2 id="apiConnectionManagerTitle">API 管理</h2><p>在这里添加、修改或移除 API。它们会出现在功能的选择框中。</p></div><button type="button" class="api-connection-sheet__close suzu-close-button" data-close-api-manager aria-label="关闭" title="关闭">×</button></header>${content}<footer class="api-connection-sheet__actions"><button class="primary-button" data-new-api-connection>添加 API</button></footer></aside></div>`;
}

function defaultApiConnection() {
  return { type: "dashscope", name: "阿里百炼", baseUrl: "", model: "", generationEndpoint: "/images/generations", editEndpoint: "/images/edits", quality: "", outputFormat: "", inputFidelity: "", extraBody: {}, editExtraBody: {}, timeoutMs: 180000 };
}

function renderApiConnectionEditor(state, connections) {
  const editing = connections.find((item) => item.id === state.apiConnectionEditingId) || null;
  if (!state.apiConnectionEditorOpen && !editing) return "";
  const value = editing || defaultApiConnection();
  const isDashScope = value.type === "dashscope";
  const imageApi = value.type === "openai-compatible";
  const formTitle = editing ? `编辑 ${escapeHtml(editing.name)}` : "添加 API";
  const formHint = editing ? "密钥留空会保留当前保存的值。" : "阿里百炼只需填写 API Key；保存后在功能列表选择要使用它的能力。";
  return `<div class="api-connection-overlay"><aside class="api-connection-sheet" role="dialog" aria-modal="true" aria-labelledby="apiConnectionEditorTitle"><header class="api-connection-sheet__header"><div><span class="reference-kicker">API</span><h2 id="apiConnectionEditorTitle">${formTitle}</h2><p>${formHint}</p></div><button type="button" class="api-connection-sheet__close suzu-close-button" data-cancel-api-edit aria-label="关闭" title="关闭">×</button></header><form id="namedApiConnectionForm" class="api-connection-form"><input type="hidden" name="id" value="${escapeHtml(editing?.id || "")}"><div class="api-connection-form__grid"><label class="wide" data-api-name-field ${isDashScope ? "hidden" : ""}><span>API 名称</span><input name="name" value="${escapeHtml(value.name)}" ${isDashScope ? "" : "required"} maxlength="80" placeholder="例如：智创、阿里百炼"></label><label data-api-type-field><span>服务商</span><select name="type"><option value="dashscope" ${isDashScope ? "selected" : ""}>阿里百炼</option><option value="openai-compatible" ${imageApi ? "selected" : ""}>OpenAI 兼容（多数图像 API）</option><option value="generic-api" ${value.type === "generic-api" ? "selected" : ""}>其他 API</option></select></label><label data-api-key-field><span>密钥</span><input name="apiKey" type="password" autocomplete="new-password" maxlength="512" placeholder="${editing ? "留空则保留当前密钥" : "新建时必填"}"></label><label class="wide" data-api-base-url ${isDashScope ? "hidden" : ""}><span data-api-base-url-label>${imageApi ? "服务地址" : "服务地址（可选）"}</span><input name="baseUrl" value="${escapeHtml(value.baseUrl)}" maxlength="500" ${isDashScope ? "disabled" : ""} placeholder="${imageApi ? "填写完整 Base URL" : "可留空，使用服务默认地址"}"><small data-api-base-url-hint>${imageApi ? "图像服务需要填写完整 Base URL。" : "通常可留空；只有服务商要求时才填写。"}</small></label><label class="wide" data-api-image-field ${imageApi ? "" : "hidden"}><span>图像模型</span><input name="model" value="${escapeHtml(value.model)}" maxlength="160" placeholder="例如：模型名称"></label></div><details class="api-advanced-settings" data-api-image-field ${imageApi ? "" : "hidden"}><summary><span>进阶设置</span><small>只有 API 文档要求时才需要修改</small></summary><p>通常保留原值即可；这里用于兼容有特殊要求的图像 API。</p><div class="api-connection-form__grid api-connection-form__grid--advanced"><label><span>生成地址</span><input name="generationEndpoint" value="${escapeHtml(value.generationEndpoint)}" maxlength="300"></label><label><span>编辑地址</span><input name="editEndpoint" value="${escapeHtml(value.editEndpoint)}" maxlength="300"></label><label><span>质量（可选）</span><input name="quality" value="${escapeHtml(value.quality)}" maxlength="120"></label><label><span>输出格式（可选）</span><input name="outputFormat" value="${escapeHtml(value.outputFormat)}" maxlength="120"></label><label><span>参考保真（可选）</span><input name="inputFidelity" value="${escapeHtml(value.inputFidelity)}" maxlength="120"></label><label><span>请求超时（毫秒）</span><input name="timeoutMs" type="number" min="1000" max="600000" value="${escapeHtml(value.timeoutMs || 180000)}"></label><label class="wide"><span>生成附加参数 JSON</span><textarea name="extraBody" maxlength="50000" spellcheck="false">${escapeHtml(JSON.stringify(value.extraBody || {}, null, 2))}</textarea></label><label class="wide"><span>编辑附加参数 JSON</span><textarea name="editExtraBody" maxlength="50000" spellcheck="false">${escapeHtml(JSON.stringify(value.editExtraBody || {}, null, 2))}</textarea></label></div></details><footer class="api-connection-sheet__actions"><button type="button" class="secondary-button" data-cancel-api-edit>取消</button><button class="primary-button">${editing ? "保存修改" : "保存 API"}</button></footer></form></aside></div>`;
}

function renderApiBindings(state, connections, bindings) {
  return `<section class="api-bindings-section"><header class="api-section-heading"><div><span class="reference-kicker">功能</span><h2>为功能选择 API</h2><p>日常文字对话使用 Claude Code 的文字模型；只有图片、声音、视频和记忆处理需要在这里指定 API。</p></div></header><div class="api-binding-list">${API_BINDINGS.map((item) => `<article class="api-binding-row"><div><h3>${escapeHtml(item.label)}</h3><p>${escapeHtml(item.detail)}</p></div>${renderApiBindingPicker(state, item, connections, bindings)}</article>`).join("")}</div></section>`;
}

function renderComfyuiSettings(comfy) {
  const ready = comfy.workflows?.some((item) => item.enabled);
  return `<section class="api-local-engine"><details><summary><div><span class="reference-kicker">本机绘画</span><h2>ComfyUI</h2><p>它独立于云端 API；只在你使用本机出图时需要设置。</p></div>${status(ready ? "可用" : "尚未设置", ready ? "ready" : "muted")}</summary><form id="comfyuiConnectionForm" class="api-local-engine__form"><label><span>ComfyUI 地址</span><input name="baseUrl" value="${escapeHtml(comfy.baseUrl || "http://127.0.0.1:8188")}" required maxlength="500"></label><label><span>最长等待时间（毫秒）</span><input name="timeoutMs" type="number" min="1000" max="600000" value="${escapeHtml(comfy.timeoutMs || 600000)}"></label><label><span>查看进度的间隔（毫秒）</span><input name="pollIntervalMs" type="number" min="100" max="30000" value="${escapeHtml(comfy.pollIntervalMs || 1000)}"></label><label class="wide"><span>工作流清单（高级 JSON，可选）</span><textarea name="registry" maxlength="500000" placeholder="留空会保留目前的工作流清单。"></textarea></label><div class="api-local-engine__actions"><button class="secondary-button">保存 ComfyUI 设置</button></div></form></details></section>`;
}

export function renderApiServices({ state }) {
  const snapshot = state.apiServices || { connections: [], bindings: {}, comfy: { baseUrl: "http://127.0.0.1:8188", workflows: [] } };
  const connections = snapshot.connections || [];
  const bindings = snapshot.bindings || {};
  const comfy = snapshot.comfy || { baseUrl: "http://127.0.0.1:8188", workflows: [] };
  const canContinueOnboarding = state.settings?.onboardingCompleted !== true
    && connections.some((connection) => connection?.configured === true);
  return `<section class="api-services api-services-page"><header class="api-services-hero"><div><span class="reference-kicker">API</span><h2>功能使用的 API</h2><p>给需要图片、声音和理解能力的功能选择 API。添加或修改 API 时，再打开管理。</p></div><div class="api-services-hero__actions">${canContinueOnboarding ? '<button class="secondary-button" data-continue-onboarding>继续首次设置</button>' : ""}<button class="secondary-button" data-open-api-manager>管理 API</button></div></header>${renderApiBindings(state, connections, bindings)}${renderComfyuiSettings(comfy)}${renderApiConnectionManager(state, connections, bindings)}${renderApiConnectionEditor(state, connections)}</section>`;
}

function renderAdminContent(context) {
  const { state } = context;
  if (state.adminTab === "overview") return renderAdminOverview(context);
  if (state.adminTab === "agent") return renderAgentSettings(context);
  if (state.adminTab === "claude-code") return renderClaudeCodeApi(context);
  if (state.adminTab === "runtime") return renderRuntimeSettings(context);
  if (state.adminTab === "api-services") return renderApiServices(context);
  if (state.adminTab === "usage") return renderUsage(context);
  return renderAdminOverview(context);
}

export function renderAdmin(context) {
  return `${pageIntro("MANAGE", "管理", "管理我的身份、Claude Code、API 和用量。")}${adminTabs(context.state.adminTab)}${renderAdminContent(context)}`;
}

export async function loadApiServices(context) {
  try { context.state.apiServices = await context.api.connections.apiServicesSnapshot(); }
  catch (error) { context.setNotice(error?.message || "无法读取 API 设置。"); }
  context.render();
}

export async function loadAgentRuntimeConfig(context) {
  try { context.state.agentRuntime = await context.api.agentRuntime.snapshot(); }
  catch (error) { context.setNotice(error?.message || "无法读取连接与运行设置。"); }
  context.render();
}

export async function loadClaudeCodeApi(context) {
  try { context.state.claudeCodeApi = await context.api.agentRuntime.claudeCodeApiSnapshot(); }
  catch (error) { context.setNotice(error?.message || "无法读取 Claude Code API 设置。"); }
  context.render();
}

export async function loadCapabilities(context) {
  try {
    const defaults = await context.api.capabilities.initializeDefaults();
    if (defaults?.ok) {
      context.state.capabilitySnapshot = defaults.value.snapshot;
      const unresolved = defaults.value.errors || [];
      if (defaults.value.initialized && unresolved.length) context.setNotice(`已默认开启可安全加入的能力；${unresolved.length} 项保留了已有同名文件。`);
    } else if (defaults?.error) context.setNotice(defaults.error.message || "无法初始化默认能力。");
    if (!context.state.capabilitySnapshot) context.state.capabilitySnapshot = await context.api.capabilities.snapshot();
    try { context.state.externalCapabilities = await context.api.externalCapabilities?.snapshot?.(); }
    catch (error) { context.setNotice(error?.message || "内置能力已读取，但暂时无法读取外部能力。 "); }
    try { context.state.apiServices = await context.api.connections.apiServicesSnapshot(); }
    catch (error) { context.setNotice(error?.message || "能力已读取，但暂时无法读取 API 选择。 "); }
    try { context.state.wechatSnapshot = await context.api.wechat?.snapshot?.(); }
    catch (error) { context.setNotice(error?.message || "能力已读取，但暂时无法读取微信连接状态。 "); }
    try {
      const conversation = await context.api.conversation.snapshot();
      context.state.companionSessions = {
        projectRoot: conversation?.projectRoot || "",
        sessions: Array.isArray(conversation?.sessions) ? conversation.sessions : [],
      };
    } catch (error) { context.setNotice(error?.message || "能力已读取，但暂时无法读取会话范围。 "); }
  }
  catch (error) { context.setNotice(error?.message || "无法读取能力清单。"); }
  context.render();
}

function requestExtraJson(value, label) {
  const text = String(value ?? "").trim();
  if (!text) return {};
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error(label + "必须是有效 JSON 对象。"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(label + "必须是 JSON 对象。");
  return parsed;
}

function loadIdentityAvatarCropSource(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => {
      const imageWidth = Number(image.naturalWidth || image.width);
      const imageHeight = Number(image.naturalHeight || image.height);
      if (!Number.isFinite(imageWidth) || imageWidth <= 0 || !Number.isFinite(imageHeight) || imageHeight <= 0) {
        reject(new Error("无法读取这张图片的尺寸。"));
        return;
      }
      resolve({ imageWidth, imageHeight });
    }, { once: true });
    image.addEventListener("error", () => reject(new Error("无法打开这张图片。")), { once: true });
    image.src = source;
  });
}

function applyIdentityAvatarCropPreview(state) {
  const crop = state.identityAvatarCrop;
  const image = document.querySelector("[data-identity-avatar-crop-image]");
  const range = document.querySelector("[data-identity-avatar-crop-zoom]");
  const output = document.querySelector("[data-identity-avatar-crop-zoom-value]");
  if (!crop || !image) return;
  const layout = avatarCropLayout(crop);
  image.style.width = `${layout.displayWidth}px`;
  image.style.height = `${layout.displayHeight}px`;
  image.style.transform = `translate(${layout.offsetX}px, ${layout.offsetY}px)`;
  if (range) range.value = String(layout.zoom);
  if (output) output.textContent = `${Math.round(layout.zoom * 100)}%`;
}

function fitIdentityAvatarCropToStage(state, stage) {
  const crop = state.identityAvatarCrop;
  const bounds = stage?.getBoundingClientRect?.();
  const width = Math.round(Number(bounds?.width) || 0);
  const height = Math.round(Number(bounds?.height) || 0);
  if (!crop || width < 1 || height < 1) return;
  if (crop.viewportWidth !== width || crop.viewportHeight !== height) {
    state.identityAvatarCrop = resizeAvatarCropViewport(crop, width, height);
  }
  applyIdentityAvatarCropPreview(state);
}

function croppedIdentityAvatarDataUrl(state) {
  const crop = state.identityAvatarCrop;
  const image = document.querySelector("[data-identity-avatar-crop-image]");
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

function bindIdentityAvatarCropEvents({ render, saveIdentity, setNotice, state }) {
  const stage = document.querySelector("[data-identity-avatar-crop-stage]");
  if (!stage || !state.identityAvatarCrop) return;
  fitIdentityAvatarCropToStage(state, stage);
  let drag = null;
  const finishDrag = (event) => {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    try { stage.releasePointerCapture(drag.pointerId); } catch { /* A released pointer needs no further work. */ }
    drag = null;
    stage.classList.remove("is-dragging");
  };
  stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !state.identityAvatarCrop) return;
    event.preventDefault();
    drag = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add("is-dragging");
  });
  stage.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId || !state.identityAvatarCrop) return;
    state.identityAvatarCrop = moveAvatarCrop(state.identityAvatarCrop, event.clientX - drag.clientX, event.clientY - drag.clientY);
    drag = { ...drag, clientX: event.clientX, clientY: event.clientY };
    applyIdentityAvatarCropPreview(state);
  });
  stage.addEventListener("pointerup", finishDrag);
  stage.addEventListener("pointercancel", finishDrag);
  document.querySelector("[data-identity-avatar-crop-zoom]")?.addEventListener("input", (event) => {
    if (!state.identityAvatarCrop) return;
    state.identityAvatarCrop = setAvatarCropZoom(state.identityAvatarCrop, event.currentTarget.value);
    applyIdentityAvatarCropPreview(state);
  });
  document.querySelectorAll("[data-close-identity-avatar-crop]").forEach((button) => button.addEventListener("click", () => {
    state.identityAvatarCrop = null;
    render();
  }));
  document.querySelector("[data-identity-avatar-crop-backdrop]")?.addEventListener("click", (event) => {
    if (event.target !== event.currentTarget) return;
    state.identityAvatarCrop = null;
    render();
  });
  document.querySelector("[data-confirm-identity-avatar-crop]")?.addEventListener("click", async () => {
    const crop = state.identityAvatarCrop;
    if (!crop) return;
    try {
      const avatarDataUrl = croppedIdentityAvatarDataUrl(state);
      state.identityAvatarCrop = null;
      await saveIdentity(crop.target, { avatarDataUrl });
      setNotice("头像已保存。");
    } catch (error) {
      state.identityAvatarCrop = crop;
      setNotice(error?.message || "无法保存该头像。");
      render();
    }
  });
}

export function bindAgentEvents({ api, applyTheme, openOnboarding, refreshData, render, setAdminTab, setCapabilityPage, setCreatePage, setNotice, setRelationshipPage, setRuntimeSection, setView, state }) {
  const saveIdentity = async (target, changes) => {
    const identity = cloneIdentity(state.settings);
    const profile = { ...profileForTarget(identity, target), ...changes };
    state.settings = await api.settings.update({ identity: setProfileForTarget(identity, target, profile) });
    render();
  };
  bindIdentityAvatarCropEvents({ render, saveIdentity, setNotice, state });
  if (state.view === "admin") bindManagedAgentRuntimeSettingsEvents({ api, refreshData, render, setNotice, state });
  document.querySelectorAll("[data-admin-tab]").forEach((button) => button.addEventListener("click", async () => {
    setAdminTab(button.dataset.adminTab);
    render();
    if (button.dataset.adminTab === "claude-code") await loadClaudeCodeApi({ api, render, setNotice, state });
    if (button.dataset.adminTab === "api-services") await loadApiServices({ api, render, setNotice, state });
    if (button.dataset.adminTab === "runtime") await loadAgentRuntimeConfig({ api, render, setNotice, state });
  }));
  document.querySelectorAll("[data-open-admin]").forEach((button) => button.addEventListener("click", async () => {
    setAdminTab(button.dataset.openAdmin);
    if (button.dataset.openAdmin === "runtime") setRuntimeSection("overview");
    setView("admin");
    if (button.dataset.openAdmin === "runtime") await loadAgentRuntimeConfig({ api, render, setNotice, state });
  }));
  document.querySelectorAll("[data-open-contact-conversation]").forEach((button) => button.addEventListener("click", () => {
    setView("relationships");
    setRelationshipPage("conversation");
  }));
  document.querySelectorAll("[data-open-runtime-section]").forEach((button) => button.addEventListener("click", () => {
    setAdminTab("runtime");
    setRuntimeSection(button.dataset.openRuntimeSection);
    setView("admin");
  }));
  document.querySelectorAll("[data-return-runtime-overview]").forEach((button) => button.addEventListener("click", () => {
    setRuntimeSection("overview");
    render();
  }));
  document.querySelectorAll("[data-runtime-choice]").forEach((group) => group.querySelectorAll("[data-runtime-choice-value]").forEach((button) => button.addEventListener("click", () => {
    const field = group.parentElement?.querySelector(`input[name="${group.dataset.runtimeChoice}"]`);
    if (!field) return;
    field.value = button.dataset.runtimeChoiceValue;
    group.querySelectorAll("[data-runtime-choice-value]").forEach((item) => item.classList.toggle("active", item === button));
  })));
  document.querySelector("#claudeRuntimeConfigForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      state.agentRuntime = await api.agentRuntime.saveClaude({
        allowedTools: form.get("allowedTools"), deniedTools: form.get("deniedTools"), preserveTextService: true,
        alwaysThinkingEnabled: form.get("alwaysThinkingEnabled") === "on",
        includeCoAuthoredBy: form.get("includeCoAuthoredBy") === "on",
        skipWebFetchPreflight: form.get("skipWebFetchPreflight") === "on",
      });
      setNotice("Claude Code 设置已保存。");
    } catch (error) { setNotice(error?.message || "无法保存 Claude Code 设置。"); }
    render();
  });
  const claudeCodeApiForm = document.querySelector("#claudeCodeApiForm");
  if (claudeCodeApiForm) {
    const apiCard = claudeCodeApiForm.closest(".runtime-config-card");
    const apiCardTitle = apiCard?.querySelector(":scope > header h2");
    const apiCardDescription = apiCard?.querySelector(":scope > header p");
    const providerField = claudeCodeApiForm.querySelector("[data-claude-api-provider]");
    const baseUrlField = claudeCodeApiForm.querySelector("[data-claude-api-base-url]");
    const baseUrlCopy = claudeCodeApiForm.querySelector("[data-claude-api-base-copy]");
    const setField = (name, value = "") => {
      const field = claudeCodeApiForm.elements.namedItem(name);
      if (field) field.value = value;
    };
    const applyProvider = (reset = false) => {
      const providerId = providerField?.value || "deepseek";
      const provider = CLAUDE_CODE_API_PROVIDERS[providerId] || CLAUDE_CODE_API_PROVIDERS.custom;
      const custom = providerId === "custom";
      const models = provider.models || {};
      if (apiCardTitle) apiCardTitle.textContent = provider.label;
      if (apiCardDescription) apiCardDescription.textContent = custom
        ? "填写并保存 API Key 后，Claude Code 才会使用这项服务。"
        : `填写并保存 ${provider.label} 的 API Key 后，Claude Code 才会使用这项服务。`;
      if (baseUrlField) {
        baseUrlField.readOnly = !custom;
        if (reset || !baseUrlField.value) baseUrlField.value = provider.baseUrl || "";
      }
      if (baseUrlCopy) baseUrlCopy.textContent = custom ? "填写服务商给出的 Anthropic 兼容地址。" : "内置地址；切换到自定义后才可以修改。";
      claudeCodeApiForm.querySelectorAll("[data-claude-api-auth-mode], [data-claude-api-custom-model-list]").forEach((item) => { item.hidden = !custom; });
      if (!reset) return;
      setField("model", models.model || "");
      setField("sonnetModel", models.sonnet || models.model || "");
      setField("opusModel", models.opus || models.model || "");
      setField("haikuModel", models.haiku || models.model || "");
      setField("subagentModel", models.subagent || models.haiku || models.model || "");
      setField("effortLevel", models.effort || "");
      state.claudeCodeModels = [];
      state.claudeCodeModelNotice = "";
    };
    providerField?.addEventListener("change", () => applyProvider(true));
    applyProvider(!state.claudeCodeApi?.model);
    claudeCodeApiForm.querySelector("[data-fetch-claude-code-models]")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const form = new FormData(claudeCodeApiForm);
      button.disabled = true;
      try {
        const response = await api.agentRuntime.fetchClaudeCodeModels({
          provider: form.get("provider"), baseUrl: form.get("baseUrl"), apiKey: form.get("apiKey"),
          authMode: form.get("authMode"), modelListUrl: form.get("modelListUrl"),
        });
        state.claudeCodeModels = response.models || [];
        state.claudeCodeModelNotice = response.message || "模型列表已更新。";
        const list = claudeCodeApiForm.querySelector("#claudeCodeApiModels");
        if (list) list.innerHTML = claudeCodeApiModelOptions(form.get("model"), state.claudeCodeModels);
        const actions = claudeCodeApiForm.querySelector(".claude-api-model-actions");
        let message = actions?.querySelector("p");
        if (actions && !message) { message = document.createElement("p"); actions.append(message); }
        if (message) message.textContent = state.claudeCodeModelNotice;
      } catch (error) {
        state.claudeCodeModelNotice = error?.message || "无法获取模型列表。";
        const actions = claudeCodeApiForm.querySelector(".claude-api-model-actions");
        let message = actions?.querySelector("p");
        if (actions && !message) { message = document.createElement("p"); actions.append(message); }
        if (message) message.textContent = state.claudeCodeModelNotice;
      } finally { button.disabled = false; }
    });
    claudeCodeApiForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        state.claudeCodeApi = await api.agentRuntime.saveClaudeCodeApi({
          provider: form.get("provider"), baseUrl: form.get("baseUrl"), apiKey: form.get("apiKey"), authMode: form.get("authMode"),
          model: form.get("model"), sonnetModel: form.get("sonnetModel"), opusModel: form.get("opusModel"),
          haikuModel: form.get("haikuModel"), subagentModel: form.get("subagentModel"), effortLevel: form.get("effortLevel"),
          skipOnboarding: form.get("skipOnboarding") === "on",
        });
        state.claudeCodeModelNotice = state.claudeCodeApi.status === "ready"
          ? "已保存。新开的 Claude Code 会话会使用这项服务。"
          : "已保存首次确认设置；填写 API Key 后再保存服务。";
        setNotice(state.claudeCodeModelNotice);
      } catch (error) { setNotice(error?.message || "无法保存 Claude Code API 设置。"); }
      render();
    });
  }
  document.querySelectorAll("[data-open-api-manager]").forEach((button) => button.addEventListener("click", () => {
    state.apiConnectionManagerOpen = true;
    state.apiConnectionEditorOpen = false;
    state.apiConnectionEditingId = "";
    render();
  }));
  document.querySelectorAll("[data-continue-onboarding]").forEach((button) => button.addEventListener("click", async () => {
    try {
      state.settings = await api.settings.update({ onboardingMultimodalCompleted: true });
      openOnboarding();
    } catch (error) { setNotice(error?.message || "无法继续首次设置。"); }
  }));
  document.querySelectorAll("[data-close-api-manager]").forEach((button) => button.addEventListener("click", () => {
    state.apiConnectionManagerOpen = false;
    render();
  }));
  document.querySelectorAll("[data-new-api-connection]").forEach((button) => button.addEventListener("click", () => {
    state.apiConnectionEditingId = "";
    state.apiConnectionManagerOpen = false;
    state.apiConnectionEditorOpen = true;
    render();
  }));
  const namedApiForm = document.querySelector("#namedApiConnectionForm");
  if (namedApiForm) {
    const typeField = namedApiForm.querySelector('[name="type"]');
    const nameField = namedApiForm.querySelector('[name="name"]');
    const nameBlock = namedApiForm.querySelector("[data-api-name-field]");
    const imageOnlyFields = ["model", "generationEndpoint", "editEndpoint", "quality", "outputFormat", "inputFidelity", "extraBody", "editExtraBody", "timeoutMs"];
    const imageOnlyBlocks = namedApiForm.querySelectorAll("[data-api-image-field]");
    const baseUrlBlock = namedApiForm.querySelector("[data-api-base-url]");
    const baseUrl = namedApiForm.querySelector('[name="baseUrl"]');
    const baseUrlLabel = namedApiForm.querySelector("[data-api-base-url-label]");
    const baseUrlHint = namedApiForm.querySelector("[data-api-base-url-hint]");
    const applyConnectionType = () => {
      const type = typeField?.value || "dashscope";
      const dashscope = type === "dashscope";
      const imageApi = type === "openai-compatible";
      nameBlock?.toggleAttribute("hidden", dashscope);
      if (nameField) {
        if (dashscope && !nameField.value.trim()) nameField.value = "阿里百炼";
        nameField.required = !dashscope;
      }
      imageOnlyBlocks.forEach((block) => block.toggleAttribute("hidden", !imageApi));
      for (const name of imageOnlyFields) {
        const field = namedApiForm.querySelector(`[name="${name}"]`);
        if (field) field.disabled = !imageApi;
      }
      baseUrlBlock?.toggleAttribute("hidden", dashscope);
      if (baseUrl) {
        baseUrl.disabled = dashscope;
        baseUrl.required = imageApi;
        baseUrl.placeholder = imageApi ? "填写完整 Base URL" : "可留空，使用服务默认地址";
      }
      if (baseUrlLabel) baseUrlLabel.textContent = imageApi ? "服务地址" : "服务地址（可选）";
      if (baseUrlHint) baseUrlHint.textContent = imageApi ? "图像服务需要填写完整 Base URL。" : "通常可留空；只有服务商要求时才填写。";
    };
    applyConnectionType();
    typeField?.addEventListener("change", applyConnectionType);
  }
  document.querySelector("#namedApiConnectionForm")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try {
      state.apiServices = await api.connections.saveNamedApiConnection({ id: form.get("id"), name: form.get("name"), type: form.get("type"), baseUrl: form.get("baseUrl"), model: form.get("model"), apiKey: form.get("apiKey"), generationEndpoint: form.get("generationEndpoint"), editEndpoint: form.get("editEndpoint"), quality: form.get("quality"), outputFormat: form.get("outputFormat"), inputFidelity: form.get("inputFidelity"), extraBody: requestExtraJson(form.get("extraBody"), "生成附加参数 JSON"), editExtraBody: requestExtraJson(form.get("editExtraBody"), "编辑附加参数 JSON"), timeoutMs: Number(form.get("timeoutMs")) });
      if (state.apiServices.connections?.some((connection) => connection?.configured === true)) {
        state.settings = await api.settings.update({ onboardingMultimodalCompleted: true });
      }
      state.apiConnectionEditingId = "";
      state.apiConnectionEditorOpen = false;
      setNotice("API 已保存。");
      render();
    } catch (error) { setNotice(error?.message || "无法保存 API。"); }
  });
  document.querySelectorAll("[data-edit-api-connection]").forEach((button) => button.addEventListener("click", () => { state.apiConnectionManagerOpen = false; state.apiConnectionEditingId = button.dataset.editApiConnection; state.apiConnectionEditorOpen = true; render(); }));
  document.querySelectorAll("[data-cancel-api-edit]").forEach((button) => button.addEventListener("click", () => { state.apiConnectionEditingId = ""; state.apiConnectionEditorOpen = false; render(); }));
  document.querySelectorAll("[data-remove-api-connection]").forEach((button) => button.addEventListener("click", async () => {
    const connection = state.apiServices?.connections?.find((item) => item.id === button.dataset.removeApiConnection);
    if (!window.confirm(`移除“${connection?.name || "这个 API"}”？已选用它的功能会改为未选择。`)) return;
    try { state.apiServices = await api.connections.removeNamedApiConnection(button.dataset.removeApiConnection); state.apiConnectionEditingId = ""; state.apiConnectionEditorOpen = false; setNotice("API 已移除。"); }
    catch (error) { setNotice(error?.message || "无法移除 API。"); }
    render();
  }));
  document.querySelectorAll("[data-open-api-binding]").forEach((button) => button.addEventListener("click", () => {
    const next = button.dataset.openApiBinding;
    state.apiBindingPickerOpen = state.apiBindingPickerOpen === next ? "" : next;
    render();
  }));
  document.querySelectorAll("[data-select-api-binding]").forEach((button) => button.addEventListener("click", async () => {
    try {
      state.apiServices = await api.connections.bindNamedApiConnection(button.dataset.selectApiBinding, button.dataset.apiConnectionId);
      state.apiBindingPickerOpen = "";
      setNotice("功能使用的 API 已更新。");
    } catch (error) { setNotice(error?.message || "无法更新功能使用的 API。"); }
    render();
  }));
  const setCapabilityActive = async (abilityId, enabled) => {
    const ability = state.capabilitySnapshot?.capabilities?.find((item) => item.id === abilityId);
    const abilityName = ability?.name || "这项能力";
    const response = await api.capabilities.setActive(abilityId, enabled);
    if (response?.ok) {
      const result = response.value;
      state.capabilitySnapshot = result.snapshot;
      setNotice(enabled ? `“${abilityName}”已开启。` : `“${abilityName}”已关闭。`);
    } else {
      const error = response?.error || { message: "无法更新这项能力。" };
      if (error.code === "skill-conflict") setNotice("当前联系人已有同名能力文件，Suzu Lives 没有改动它。");
      else setNotice(error.message || "无法更新这项能力。");
    }
    render();
  };
  document.querySelectorAll("[data-toggle-capability]").forEach((input) => input.addEventListener("change", () => {
    setCapabilityActive(input.dataset.toggleCapability, input.checked);
  }));
  document.querySelector("[data-open-external-capabilities]")?.addEventListener("click", () => {
    state.capabilityPage = "external";
    state.capabilitySelectedId = "";
    state.siteAutomationSelectedSiteId = "";
    render();
  });
  document.querySelector("[data-import-external-capability]")?.addEventListener("click", async () => {
    if (!api.externalCapabilities?.importManifest) return;
    try {
      const response = await api.externalCapabilities.importManifest();
      if (!response?.ok) throw response?.error || new Error("无法导入外部能力。 ");
      state.externalCapabilities = response.value.snapshot;
      if (!response.value.canceled) setNotice(response.value.created ? "外部能力清单已导入；尚未运行任何第三方代码。" : "外部能力清单已更新；需要时可再次启用以更新当前联系人中的登记。");
    } catch (error) { setNotice(error?.message || "无法导入外部能力清单。 "); }
    render();
  });
  const setExternalCapabilityEnabled = async (id, enabled) => {
    if (!api.externalCapabilities?.setEnabled) return;
    try {
      const response = await api.externalCapabilities.setEnabled(id, enabled);
      if (!response?.ok) throw response?.error || new Error("无法更新外部能力。 ");
      state.externalCapabilities = response.value.snapshot;
      setNotice(enabled ? "外部能力已登记到当前联系人；这不会在 Suzu Lives 中运行第三方代码。" : "外部能力已从当前联系人取消登记。 ");
    } catch (error) { setNotice(error?.message || "无法更新外部能力。 "); }
    render();
  };
  document.querySelectorAll("[data-enable-external-capability]").forEach((button) => button.addEventListener("click", () => {
    setExternalCapabilityEnabled(button.dataset.enableExternalCapability, true);
  }));
  document.querySelectorAll("[data-disable-external-capability]").forEach((button) => button.addEventListener("click", () => {
    setExternalCapabilityEnabled(button.dataset.disableExternalCapability, false);
  }));
  document.querySelectorAll("[data-remove-external-capability]").forEach((button) => button.addEventListener("click", async () => {
    const capability = state.externalCapabilities?.capabilities?.find((item) => item.id === button.dataset.removeExternalCapability);
    if (!window.confirm(`移除“${capability?.name || "这项外部能力"}”？它会先尝试清理所有由 Suzu Lives 登记的项目条目。`)) return;
    try {
      const response = await api.externalCapabilities?.remove?.(button.dataset.removeExternalCapability, true);
      if (!response?.ok) throw response?.error || new Error("无法移除外部能力。 ");
      state.externalCapabilities = response.value.snapshot;
      setNotice("外部能力已从 Suzu Lives 移除。 ");
    } catch (error) { setNotice(error?.message || "无法移除外部能力。 "); }
    render();
  }));
  document.querySelector("[data-toggle-wechat-connection]")?.addEventListener("change", async (event) => {
    if (!api.wechat?.saveSettings) return;
    const input = event.currentTarget;
    try {
      state.wechatSnapshot = await api.wechat.saveSettings({ enabled: input.checked });
      setNotice(input.checked ? "微信连接已开启；现在可以在任一会话的“··· → 设置”里生成二维码。" : "微信连接已关闭；已有绑定会保留，重新开启后可恢复。 ");
    } catch (error) { setNotice(error?.message || "无法更新微信连接。 "); }
    render();
  });
  document.querySelectorAll("[data-wechat-delivery]").forEach((input) => input.addEventListener("change", async () => {
    if (!api.wechat?.saveSettings) return;
    const key = input.dataset.wechatDelivery;
    const current = wechatSnapshot(state);
    if (!Object.hasOwn(current.delivery, key)) return;
    try {
      state.wechatSnapshot = await api.wechat.saveSettings({ delivery: { ...current.delivery, [key]: input.checked } });
      setNotice("微信投递设置已保存。 ");
    } catch (error) { setNotice(error?.message || "无法保存微信投递设置。 "); }
    render();
  }));
  document.querySelector("[data-open-traveling-merchant-page]")?.addEventListener("click", async () => {
    try {
      const response = await api.capabilities.openTravelingMerchantPage();
      setNotice(response?.ok ? "已打开远行商人当前读取网页。" : response?.error?.message || "无法打开远行商人网页。 ");
    } catch (error) { setNotice(error?.message || "无法打开远行商人网页。 "); }
    render();
  });
  document.querySelectorAll("[data-session-delivery-enabled]").forEach((input) => input.addEventListener("change", async () => {
    const capabilityId = input.dataset.sessionDeliveryEnabled;
    const sessionId = input.dataset.sessionDeliveryId;
    try {
      const response = await api.capabilities.saveSettings(capabilityId, { sessionId, sessionEnabled: input.checked });
      if (response?.ok) {
        state.capabilitySnapshot = response.value;
        setNotice(input.checked ? "这个会话已启用该投递能力。" : "这个会话已关闭该投递能力。 ");
      } else setNotice(response?.error?.message || "无法更新会话开关。 ");
    } catch (error) { setNotice(error?.message || "无法更新会话开关。 "); }
    render();
  }));
  document.querySelectorAll("[data-capability-settings-form]").forEach((formElement) => formElement.addEventListener("submit", async (event) => {
    event.preventDefault();
    const capabilityId = event.currentTarget.dataset.capabilitySettingsForm;
    const form = new FormData(event.currentTarget);
    const value = Object.fromEntries(form.entries());
    event.currentTarget.querySelectorAll('input[type="checkbox"][name]').forEach((input) => { value[input.name] = input.checked; });
    const labels = {
      "image-generation": "图片生成设置",
      "phone-camera": "手机拍照设置",
      "image-vision": "图片理解设置",
      "video-understanding": "视频理解设置",
      "voice-message": "语音设置",
      "site-automation": "网页自动化设置",
      "proactive-contact": "主动关心设置",
      "traveling-merchant": "远行商人设置",
    };
    try {
      const response = await api.capabilities.saveSettings(capabilityId, value);
      if (response?.ok) {
        state.capabilitySnapshot = response.value;
        setNotice(`${labels[capabilityId] || "能力设置"}已保存。`);
      } else setNotice(response?.error?.message || "无法保存能力设置。");
    } catch (error) { setNotice(error?.message || "无法保存能力设置。"); }
    render();
  }));
  const saveSiteAutomationControl = async (value, successMessage) => {
    try {
      const response = await api.capabilities.saveSettings("site-automation", value);
      if (response?.ok) {
        state.capabilitySnapshot = response.value;
        setNotice(successMessage);
      } else setNotice(response?.error?.message || "无法更新网页自动化设置。");
    } catch (error) { setNotice(error?.message || "无法更新网页自动化设置。"); }
    render();
  };
  document.querySelectorAll("[data-open-site-automation-site]").forEach((button) => button.addEventListener("click", () => {
    state.siteAutomationSelectedSiteId = button.dataset.openSiteAutomationSite;
    render();
  }));
  document.querySelectorAll("[data-return-site-automation-sites]").forEach((button) => button.addEventListener("click", () => {
    state.siteAutomationSelectedSiteId = "";
    render();
  }));
  document.querySelectorAll("[data-site-enabled]").forEach((input) => input.addEventListener("change", () => {
    saveSiteAutomationControl({ siteId: input.dataset.siteEnabled, siteEnabled: input.checked }, input.checked ? "这个网站已启用。" : "这个网站已关闭。");
  }));
  document.querySelectorAll("[data-site-action-enabled]").forEach((input) => input.addEventListener("change", () => {
    saveSiteAutomationControl({ siteId: input.dataset.siteActionEnabled, action: input.dataset.siteAction, actionEnabled: input.checked }, input.checked ? "网站动作已启用。" : "网站动作已关闭。");
  }));
  document.querySelectorAll("[data-open-capability-category]").forEach((button) => button.addEventListener("click", () => {
    setCapabilityPage("category", button.dataset.openCapabilityCategory);
  }));
  document.querySelectorAll("[data-open-capability]").forEach((button) => button.addEventListener("click", () => {
    setCapabilityPage("detail", button.dataset.capabilityCategory, button.dataset.openCapability);
  }));
  document.querySelectorAll("[data-return-capabilities]").forEach((button) => button.addEventListener("click", () => {
    setCapabilityPage("overview");
  }));
  document.querySelectorAll("[data-return-capability-category]").forEach((button) => button.addEventListener("click", () => {
    setCapabilityPage("category", button.dataset.returnCapabilityCategory);
  }));
  document.querySelectorAll("[data-open-capability-settings]").forEach((button) => button.addEventListener("click", async () => {
    const route = button.dataset.openCapabilitySettings;
    if (route === "api") {
      state.apiBindingPickerOpen = "";
      setAdminTab("api-services");
      setView("admin");
      await loadApiServices({ api, setNotice, state });
      render();
      return;
    }
    if (route === "visual") {
      setView("create");
      setCreatePage?.("visual");
      return;
    }
    if (route === "audio") {
      setView("create");
      setCreatePage?.("audio");
    }
  }));
  document.querySelector("#comfyuiConnectionForm")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); try { const comfy = await api.connections.saveComfyui({ baseUrl: form.get("baseUrl"), timeoutMs: Number(form.get("timeoutMs")), pollIntervalMs: Number(form.get("pollIntervalMs")), registry: form.get("registry") }); state.apiServices = { ...(state.apiServices || {}), comfy }; setNotice("ComfyUI 设置已保存。"); } catch (error) { setNotice(error?.message || "无法保存 ComfyUI 设置。"); } render();
  });
  document.querySelectorAll("[data-save-identity]").forEach((button) => button.addEventListener("click", async () => {
    const card = button.closest("[data-identity-target]");
    await saveIdentity(card.dataset.identityTarget, { displayName: card.querySelector("[data-identity-name]").value });
  }));
  document.querySelectorAll("[data-avatar-file]").forEach((input) => input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    const card = input.closest("[data-identity-target]");
    input.value = "";
    try {
      const source = await readAvatarFile(file);
      const dimensions = await loadIdentityAvatarCropSource(source);
      state.identityAvatarCrop = { target: card.dataset.identityTarget, ...createSquareAvatarCrop({ source, ...dimensions }) };
      render();
    } catch (error) {
      setNotice(error?.message || "无法读取这张头像。");
    }
  }));
  document.querySelectorAll("[data-remove-avatar]").forEach((button) => button.addEventListener("click", async () => {
    const card = button.closest("[data-identity-target]");
    await saveIdentity(card.dataset.identityTarget, { avatarDataUrl: "" });
  }));
  document.querySelector("#chooseProject")?.addEventListener("click", async () => {
    const result = await api.settings.selectProject();
    state.settings = { ...state.settings, ...result.settings };
    result.canceled ? render() : await refreshData();
  });
  document.querySelectorAll("[data-theme-choice]").forEach((button) => button.addEventListener("click", async () => {
    state.settings = await api.settings.update({ theme: button.dataset.themeChoice });
    applyTheme();
    render();
  }));
  document.querySelector("[data-show-path]")?.addEventListener("click", (event) => api.settings.showItemInFolder(event.currentTarget.dataset.showPath));
}
