import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { listSiteAutomationSites } from "@suzu-lives/browser-automation";
import { claudeAgentAbilityCatalog, inspectClaudeRegistration, removeClaudeRegistration, travelingMerchantDefaultConfig, writeClaudeRegistration } from "@suzu-lives/claude-integration";
import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";

const COMPANION_CONTACT_ID = /^contact-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_COMPANION_CONTACTS = 160;
const TIME_AWARENESS_ID = "time-awareness";
const TIME_AWARENESS_CONFIG_PATH = ["capabilities", TIME_AWARENESS_ID, "config.json"];
const CONTACT_SCOPED_AGENT_CAPABILITY_IDS = new Set(["image-generation", "phone-camera", "voice-message", "image-vision", "video-understanding", "site-automation", "iphone-bridge"]);
const CONTACT_SCOPED_AUTOMATION_CAPABILITY_IDS = new Set(["proactive-contact", "traveling-merchant"]);
const DEFAULT_CONTACT_SCOPED_AGENT_CAPABILITY_IDS = new Set(["image-vision", "video-understanding"]);
const DEFAULT_TIME_AWARENESS_INTERVAL_MINUTES = 10;
const MIN_TIME_AWARENESS_INTERVAL_MINUTES = 1;
const MAX_TIME_AWARENESS_INTERVAL_MINUTES = 24 * 60;
const DEFAULT_IPHONE_BRIDGE_SMTP_HOST = "smtp.163.com";
const DEFAULT_IPHONE_BRIDGE_IMAP_HOST = "imap.163.com";
const DEFAULT_IPHONE_BRIDGE_PASSWORD_ENV = "SUZU_IPHONE_MAIL_PASSWORD";
const DEFAULT_IPHONE_BRIDGE_FEEDBACK_SUBJECT = "查岗";
const DEFAULT_IPHONE_BRIDGE_FEEDBACK_PROMPT = "这是来自 iPhone 的反馈（{{subject}}，来自 {{from}}，{{receivedAt}}）：\n{{content}}\n{{attachments}}";
const HIDDEN_CONTACT_DEFAULT_ABILITY_IDS = Object.freeze(["visual-reference-manager", "voice-call"]);
const MANAGED_REGISTRATION_VERSION = 7;
const DEFAULT_PROACTIVE_CHAIN_PROMPT = "根据时间和前面聊的内容判断要不要主动联系对方。把判断过程写在思考中；要联系就正常发，不联系就只输出 NO_REPLY。";
const DEFAULT_PROACTIVE_FOLLOW_UP_PROMPT = "临时回访：用户在 TIME 提到 EVENT。先检查当前会话里是否已经有结果；已经有结果就只输出 NO_REPLY；还没有结果就自然地关心或询问。不要提及自动任务、回访任务或系统机制。这是一次性回访，不要设置下一次自动任务。";

function clean(value) {
  return String(value ?? "").trim();
}

function managedClaudeRegistrationAbilityIds() {
  return [...new Set([
    ...claudeAgentAbilityCatalog().map((capability) => capability.id),
    ...HIDDEN_CONTACT_DEFAULT_ABILITY_IDS,
  ])].filter((abilityId) => !isContactScopedAutomationCapability(abilityId));
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype ? value : {};
}

function absoluteProjectRoot(value) {
  const source = clean(value);
  return source && path.isAbsolute(source) ? path.resolve(source) : "";
}

function normalizedCompanionContactIds(value) {
  const contacts = [];
  const seen = new Set();
  for (const entry of (Array.isArray(value) ? value : []).slice(0, MAX_COMPANION_CONTACTS)) {
    const id = clean(entry);
    if (!COMPANION_CONTACT_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    contacts.push(id);
  }
  return contacts;
}

function companionContactIds(value) {
  return normalizedCompanionContactIds(plainObject(value).enabledContactIds);
}

function companionContactEnabled(value, contactId) {
  const id = clean(contactId);
  return Boolean(COMPANION_CONTACT_ID.test(id) && companionContactIds(value).includes(id));
}

function withCompanionContact(value, contactId, enabled) {
  const id = clean(contactId);
  if (!COMPANION_CONTACT_ID.test(id)) throw new Error("要设置的联系人无效。 ");
  const current = companionContactIds(value);
  const next = current.filter((item) => item !== id);
  if (enabled) next.push(id);
  return next;
}

function proactiveContactSettings(value) {
  const source = plainObject(value);
  return {
    saved: Object.keys(source).length > 0,
    chainPrompt: clean(source.chainPrompt) || DEFAULT_PROACTIVE_CHAIN_PROMPT,
    followUpPrompt: clean(source.followUpPrompt) || DEFAULT_PROACTIVE_FOLLOW_UP_PROMPT,
    autoMaintain: source.autoMaintain !== false,
    enabledContactIds: companionContactIds(source),
  };
}

function timeAwarenessSettings(value) {
  const source = plainObject(value);
  return {
    saved: Object.keys(source).length > 0,
    intervalMinutes: numberOrFallback(source.intervalMinutes, {
      minimum: MIN_TIME_AWARENESS_INTERVAL_MINUTES,
      maximum: MAX_TIME_AWARENESS_INTERVAL_MINUTES,
      fallback: DEFAULT_TIME_AWARENESS_INTERVAL_MINUTES,
      integer: true,
    }),
    enabledContactIds: companionContactIds(source),
  };
}

function iphoneBridgeSettings(value) {
  const source = plainObject(value);
  const mail = plainObject(source.mail);
  const outbound = plainObject(source.outbound);
  const allowedSenders = Array.isArray(mail.allowedSenders)
    ? mail.allowedSenders.map((item) => publicText(item, 320)).filter(Boolean).slice(0, 30)
    : [];
  const routes = Array.isArray(source.routes) ? source.routes.map((item) => plainObject(item)) : [];
  const route = routes.find((item) => item.enabled !== false && clean(item.subject) && clean(item.promptTemplate)) || {};
  const credentialConfigured = Boolean(
    clean(mail.password)
    || clean(mail.passwordEnv)
    || clean(outbound.password)
    || clean(outbound.passwordEnv),
  );
  const saved = Boolean(
    clean(mail.imapHost)
    && clean(mail.username)
    && allowedSenders.length
    && credentialConfigured
    && clean(outbound.sender || mail.username)
    && clean(outbound.recipient)
    && clean(route.subject)
    && clean(route.promptTemplate),
  );
  return {
    saved,
    configuration: {
      smtpHost: publicText(outbound.smtpHost || mail.smtpHost || DEFAULT_IPHONE_BRIDGE_SMTP_HOST, 320),
      smtpPort: numberOrFallback(outbound.smtpPort ?? mail.smtpPort, { minimum: 1, maximum: 65535, fallback: 465, integer: true }),
      sender: publicText(outbound.sender || mail.username, 320),
      recipient: publicText(outbound.recipient, 320),
      imapHost: publicText(mail.imapHost || DEFAULT_IPHONE_BRIDGE_IMAP_HOST, 320),
      imapPort: numberOrFallback(mail.imapPort, { minimum: 1, maximum: 65535, fallback: 993, integer: true }),
      username: publicText(mail.username, 320),
      mailbox: publicText(mail.mailbox || "INBOX", 160),
      allowedSenders,
      passwordEnv: publicText(outbound.passwordEnv || mail.passwordEnv, 128),
      credentialConfigured,
      feedbackSubject: publicText(route.subject || DEFAULT_IPHONE_BRIDGE_FEEDBACK_SUBJECT, 200),
      feedbackPrompt: publicText(route.promptTemplate || DEFAULT_IPHONE_BRIDGE_FEEDBACK_PROMPT, 12000),
    },
  };
}

function contactScopedAgentCapabilitySettings(value) {
  const source = plainObject(value);
  return {
    enabledContactIds: companionContactIds(source),
    knownContactIds: normalizedCompanionContactIds(source.knownContactIds),
  };
}

function isContactScopedAgentCapability(abilityId) {
  return CONTACT_SCOPED_AGENT_CAPABILITY_IDS.has(clean(abilityId));
}

function isContactScopedAutomationCapability(abilityId) {
  return CONTACT_SCOPED_AUTOMATION_CAPABILITY_IDS.has(clean(abilityId));
}

function isContactScopedCapability(abilityId) {
  const id = clean(abilityId);
  return id === TIME_AWARENESS_ID || isContactScopedAgentCapability(id) || isContactScopedAutomationCapability(id);
}

function contactScopedCapabilityConfigPath(abilityId) {
  const id = clean(abilityId);
  if (id === "iphone-bridge") return ["automation", "iphone-bridge", "config.json"];
  return isContactScopedAgentCapability(id) ? ["capabilities", id, "config.json"] : null;
}

function trackCompanionContact(value, contactId) {
  const id = clean(contactId);
  if (!COMPANION_CONTACT_ID.test(id)) throw new Error("要设置的联系人无效。 ");
  const current = normalizedCompanionContactIds(value);
  if (current.includes(id)) return current;
  if (current.length >= MAX_COMPANION_CONTACTS) throw new Error("联系人数量已达到上限。 ");
  return [...current, id];
}

function siteAutomationCatalog() {
  try {
    return listSiteAutomationSites();
  } catch {
    return [];
  }
}

function siteAutomationSettings(raw) {
  const sites = plainObject(raw.sites);
  return siteAutomationCatalog().map((site) => {
    const control = plainObject(sites[site.id]);
    const actions = plainObject(control.actions);
    return {
      ...site,
      enabled: control.enabled !== false,
      actions: site.actions.map((action) => ({ ...action, enabled: actions[action.id] !== false })),
    };
  });
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function publicJson(dataRoot, segments) {
  const root = clean(dataRoot);
  if (!root) return {};
  try {
    const resolvedRoot = path.resolve(root);
    const target = path.resolve(resolvedRoot, ...segments);
    if (!inside(resolvedRoot, target)) return {};
    const stat = fsSync.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) return {};
    return plainObject(JSON.parse(fsSync.readFileSync(target, "utf8")));
  } catch {
    return {};
  }
}

function boundedText(value, label, maximum = 12000) {
  const result = String(value ?? "").trim();
  if (result.length > maximum) throw new Error(`${label}不能超过 ${maximum} 个字符。`);
  return result;
}

function requiredText(value, label, maximum = 12000) {
  const result = boundedText(value, label, maximum);
  if (!result) throw new Error(`${label}不能为空。`);
  return result;
}

function environmentVariableName(value) {
  const result = requiredText(value, "邮箱授权码环境变量", 128);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(result)) {
    throw new Error("邮箱授权码环境变量只能使用字母、数字和下划线，且不能以数字开头。 ");
  }
  return result;
}

function oneOf(value, allowed, fallback, label) {
  const result = clean(value) || fallback;
  if (!allowed.includes(result)) throw new Error(`${label}无效。`);
  return result;
}

function choiceOrFallback(value, allowed, fallback) {
  const result = clean(value);
  return allowed.includes(result) ? result : fallback;
}

function boundedNumber(value, label, { minimum, maximum, fallback, integer = false } = {}) {
  const raw = clean(value);
  const result = raw ? Number(raw) : fallback;
  if (!Number.isFinite(result) || result < minimum || result > maximum || (integer && !Number.isInteger(result))) {
    throw new Error(`${label}必须在 ${minimum} 到 ${maximum} 之间。`);
  }
  return result;
}

function numberOrFallback(value, { minimum, maximum, fallback, integer = false } = {}) {
  const raw = clean(value);
  const result = raw ? Number(raw) : fallback;
  if (!Number.isFinite(result) || result < minimum || result > maximum || (integer && !Number.isInteger(result))) return fallback;
  return result;
}

function boundedBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === "true" || value === "on" || value === 1 || value === "1";
}

function httpUrl(value, label, fallback = "") {
  const result = clean(value) || fallback;
  try {
    const parsed = new URL(result);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new Error("unsupported protocol");
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    throw new Error(`${label}必须是 http 或 https 地址。`);
  }
}

function imageSize(value, label, fallback) {
  const result = clean(value) || fallback;
  if (!/^[1-9]\d{2,4}x[1-9]\d{2,4}$/u.test(result)) throw new Error(`${label}需要使用“宽x高”的尺寸格式。`);
  return result;
}

function sizeOrFallback(value, fallback) {
  const result = clean(value);
  return /^[1-9]\d{2,4}x[1-9]\d{2,4}$/u.test(result) ? result : fallback;
}

function publicText(value, maximum = 200) {
  return clean(value).slice(0, maximum);
}

function publicJsonLines(rootValue, segments, limit = 30) {
  const root = clean(rootValue);
  if (!root) return [];
  try {
    const resolvedRoot = path.resolve(root);
    const target = path.resolve(resolvedRoot, ...segments);
    if (!inside(resolvedRoot, target)) return [];
    const stat = fsSync.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) return [];
    return fsSync.readFileSync(target, "utf8").split(/\r?\n/u).filter(Boolean).slice(-limit).map((line) => {
      try { return plainObject(JSON.parse(line)); } catch { return {}; }
    });
  } catch {
    return [];
  }
}

function publicVoiceCandidates(agentRoot) {
  return publicJsonLines(agentRoot, ["voice-design", "candidates.jsonl"], 200)
    .map((candidate) => ({
      id: publicText(candidate.id, 100),
      voiceId: publicText(candidate.voiceId, 200),
      preferredName: publicText(candidate.preferredName, 80),
      targetModel: publicText(candidate.targetModel, 200),
      createdAt: publicText(candidate.createdAt, 100),
    }))
    .filter((candidate) => candidate.id && candidate.voiceId)
    .reverse();
}

function publicCustomVoices(agentRoot) {
  const document = agentRoot ? publicJson(agentRoot, ["voice-message", "custom-voices.json"]) : {};
  const voices = [];
  const seen = new Set();
  for (const value of (Array.isArray(document.voices) ? document.voices : []).slice(0, 100)) {
    const voice = plainObject(value);
    const id = publicText(voice.id, 100);
    const name = publicText(voice.name, 80);
    const provider = clean(voice.provider).toLowerCase();
    const voiceId = publicText(voice.voiceId, 200);
    if (!id || !name || provider !== "minimax" || !voiceId || seen.has(id)) continue;
    seen.add(id);
    voices.push({
      id,
      name,
      provider,
      voiceId,
      model: publicText(voice.model, 160) || "speech-2.8-hd",
      createdAt: publicText(voice.createdAt, 100),
    });
  }
  return voices;
}

function existingDirectory(value) {
  const target = clean(value);
  if (!target) return false;
  try {
    const stat = fsSync.lstatSync(target);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch {
    return false;
  }
}

function currentVoiceAgentRoot(settings, dataRoot) {
  const agentId = clean(settings?.agentId);
  const projectRoot = absoluteProjectRoot(settings?.projectRoot);
  if (!agentId || !projectRoot || !existingDirectory(projectRoot) || !clean(dataRoot)) return "";
  return resolveAgentDataRoot({ dataRoot, agentId });
}

function configuredVoiceId(value) {
  const config = plainObject(value);
  const tts = plainObject(config.tts);
  return clean(config.voiceId || config.voice || tts.voiceId || tts.voice_id || tts.voice);
}

function configuredVoiceProvider(value) {
  const config = plainObject(value);
  const tts = plainObject(config.tts);
  return clean(config.provider || tts.provider).toLowerCase() === "minimax" ? "minimax" : "qwen";
}

function configuredCustomVoiceId(value) {
  const config = plainObject(value);
  const tts = plainObject(config.tts);
  return clean(config.customVoiceId || tts.customVoiceId);
}

function voiceMessageSettings({ dataRoot, agentRoot, voiceDesign, candidates, customVoices }) {
  const shared = publicJson(dataRoot, ["capabilities", "voice-message", "config.json"]);
  const scope = contactScopedAgentCapabilitySettings(shared);
  const contact = agentRoot ? publicJson(agentRoot, ["voice-message", "config.json"]) : {};
  const contactVoiceId = configuredVoiceId(contact);
  const contactProvider = configuredVoiceProvider(contact);
  const contactCustomVoiceId = configuredCustomVoiceId(contact);
  const availableVoiceIds = new Set(candidates.map((candidate) => candidate.voiceId));
  let voiceId = "";
  let voiceProvider = "qwen";
  let customVoiceId = "";
  let selectionSource = "missing";
  let diagnostic = "";
  if (!agentRoot) {
    selectionSource = "missing-contact";
    diagnostic = "请先选择可用项目，才能查看或保存音色。";
  } else if (contactVoiceId) {
    if (contactProvider === "minimax") {
      const selected = customVoices.find((item) => item.id === contactCustomVoiceId && item.voiceId === contactVoiceId);
      if (selected) {
        voiceId = contactVoiceId;
        voiceProvider = "minimax";
        customVoiceId = selected.id;
        selectionSource = "contact";
      } else {
        selectionSource = "invalid-contact";
        diagnostic = "当前项目保存的 MiniMax 自定义音色不存在；发送会被安全拒绝，请重新选择。";
      }
    } else if (availableVoiceIds.has(contactVoiceId)) {
      voiceId = contactVoiceId;
      selectionSource = "contact";
    } else {
      selectionSource = "invalid-contact";
        diagnostic = "当前项目保存的音色不在候选库中；发送会被安全拒绝，请重新选择。";
    }
  } else if (!candidates.length && !customVoices.length) {
    diagnostic = "当前项目还没有可用音色；请先在音色设计中创建并保存候选，或添加自定义音频。";
  } else {
    diagnostic = "当前联系人尚未选择音色；请点击“配置联系人音色”后再发送。";
  }
  return {
    saved: Object.keys(shared).length > 0 || Object.keys(contact).length > 0 || Object.keys(voiceDesign).length > 0 || candidates.length > 0 || customVoices.length > 0,
    voiceId,
    voiceProvider,
    customVoiceId,
    timeoutMs: numberOrFallback(shared.timeoutMs, { minimum: 1000, maximum: 600000, fallback: 30000, integer: true }),
    candidates,
    customVoices,
    enabledContactIds: scope.enabledContactIds,
    selectionSource,
    voiceDiagnostic: diagnostic,
    canSelectVoice: Boolean(agentRoot) && (candidates.length > 0 || customVoices.length > 0),
  };
}

function normalizedLines(value, label, { maximum = 80, itemMaximum = 160 } = {}) {
  const items = (Array.isArray(value) ? value : String(value ?? "").split(/\r?\n|,/u))
    .map((item) => boundedText(item, label, itemMaximum))
    .filter(Boolean);
  const unique = [...new Set(items)];
  if (unique.length > maximum) throw new Error(`${label}不能超过 ${maximum} 项。`);
  return unique;
}

async function writeJsonBelow(rootValue, segments, value) {
  const root = clean(rootValue);
  if (!root) throw new Error("无法定位 Suzu Lives 软件数据目录。 ");
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  if (!inside(resolvedRoot, target)) throw new Error("能力设置路径无效。 ");
  await fs.mkdir(resolvedRoot, { recursive: true });
  let current = resolvedRoot;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("能力设置目录不安全。 ");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await fs.mkdir(current, { recursive: false });
    }
  }
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("能力设置文件不安全。 ");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try { await fs.rename(temporary, target); }
  catch (error) { await fs.unlink(temporary).catch(() => undefined); throw error; }
}

function savedCapabilitySettings(settings, dataRoot) {
  const imageVision = publicJson(dataRoot, ["capabilities", "image-vision", "config.json"]);
  const videoUnderstanding = publicJson(dataRoot, ["capabilities", "video-understanding", "config.json"]);
  const timeAwareness = publicJson(dataRoot, TIME_AWARENESS_CONFIG_PATH);
  const visionProvider = plainObject(imageVision.openai);
  const vision = plainObject(imageVision.vision);
  const videoProvider = plainObject(videoUnderstanding.provider);
  const video = plainObject(videoUnderstanding.video);
  const imageVisionScope = contactScopedAgentCapabilitySettings(imageVision);
  const videoUnderstandingScope = contactScopedAgentCapabilitySettings(videoUnderstanding);
  const imageGeneration = publicJson(dataRoot, ["capabilities", "image-generation", "config.json"]);
  const imageGenerationScope = contactScopedAgentCapabilitySettings(imageGeneration);
  const imageComfyui = plainObject(imageGeneration.comfyui);
  const voiceAgentRoot = currentVoiceAgentRoot(settings, dataRoot);
  const voiceDesign = voiceAgentRoot ? publicJson(voiceAgentRoot, ["voice-design", "config.json"]) : {};
  const iphoneBridge = publicJson(dataRoot, ["automation", "iphone-bridge", "config.json"]);
  const iphoneBridgeState = iphoneBridgeSettings(iphoneBridge);
  const phoneCamera = publicJson(dataRoot, ["capabilities", "phone-camera", "config.json"]);
  const phoneCameraScope = contactScopedAgentCapabilitySettings(phoneCamera);
  const phoneSizes = plainObject(phoneCamera.size_by_shot);
  const phoneReferences = plainObject(phoneCamera.references);
  const siteAutomation = publicJson(dataRoot, ["capabilities", "site-automation", "config.json"]);
  const siteAutomationScope = contactScopedAgentCapabilitySettings(siteAutomation);
  const browserRuntime = publicJson(dataRoot, ["capabilities", "web-browser", "runtime.json"]);
  const proactiveContact = publicJson(dataRoot, ["automation", "proactive-contact", "config.json"]);
  const merchant = publicJson(dataRoot, ["automation", "traveling-merchant", "config.json"]);
  const phonePrompt = plainObject(phoneCamera.prompt);
  const candidates = voiceAgentRoot ? publicVoiceCandidates(voiceAgentRoot) : [];
  const customVoices = voiceAgentRoot ? publicCustomVoices(voiceAgentRoot) : [];
  const voiceMessage = voiceMessageSettings({ dataRoot, agentRoot: voiceAgentRoot, voiceDesign, candidates, customVoices });
  return {
    "image-generation": {
      saved: Object.keys(imageGeneration).length > 0 || imageGenerationScope.knownContactIds.length > 0,
      enabledContactIds: imageGenerationScope.enabledContactIds,
      defaultBackend: choiceOrFallback(imageGeneration.default_backend ?? imageGeneration.defaultBackend, ["api", "comfyui"], "api"),
      comfyui: {
        baseUrl: clean(imageComfyui.base_url ?? imageComfyui.baseUrl) || "http://127.0.0.1:8188",
        timeoutSeconds: numberOrFallback(imageComfyui.timeout_seconds ?? (Number(imageComfyui.timeoutMs) ? Number(imageComfyui.timeoutMs) / 1000 : ""), { minimum: 1, maximum: 600, fallback: 600, integer: true }),
        pollIntervalSeconds: numberOrFallback(imageComfyui.poll_interval_seconds ?? (Number(imageComfyui.pollIntervalMs) ? Number(imageComfyui.pollIntervalMs) / 1000 : ""), { minimum: 0.1, maximum: 30, fallback: 1 }),
        defaultWorkflow: clean(imageComfyui.default_workflow ?? imageComfyui.defaultWorkflow),
      },
    },
    "image-vision": {
      saved: Boolean(clean(visionProvider.base_url) || clean(visionProvider.model) || imageVisionScope.knownContactIds.length),
      provider: { baseUrl: clean(visionProvider.base_url), model: clean(visionProvider.model) },
      enabledContactIds: imageVisionScope.enabledContactIds,
      vision: {
        detail: choiceOrFallback(vision.detail, ["auto", "low", "high"], "auto"),
        timeoutSeconds: numberOrFallback(vision.timeout_seconds, { minimum: 5, maximum: 600, fallback: 90, integer: true }),
        maxOutputTokens: numberOrFallback(vision.max_output_tokens, { minimum: 32, maximum: 32000, fallback: 800, integer: true }),
        maxImageBytes: numberOrFallback(vision.max_image_bytes, { minimum: 262144, maximum: 25 * 1024 * 1024, fallback: 1572864, integer: true }),
        maxEdge: numberOrFallback(vision.max_edge, { minimum: 256, maximum: 8192, fallback: 1600, integer: true }),
        jpegQuality: numberOrFallback(vision.jpeg_quality, { minimum: 1, maximum: 100, fallback: 90, integer: true }),
        retryOnRefusal: boundedBoolean(vision.retry_on_refusal, true),
      },
    },
    "video-understanding": {
      saved: Boolean(clean(videoProvider.base_url) || clean(videoProvider.model) || videoUnderstandingScope.knownContactIds.length),
      provider: { baseUrl: clean(videoProvider.base_url), model: clean(videoProvider.model) },
      enabledContactIds: videoUnderstandingScope.enabledContactIds,
      video: {
        fps: numberOrFallback(video.fps, { minimum: 0.1, maximum: 10, fallback: 1 }),
        timeoutSeconds: numberOrFallback(video.timeout_seconds, { minimum: 5, maximum: 3600, fallback: 240, integer: true }),
        maxOutputTokens: numberOrFallback(video.max_output_tokens, { minimum: 32, maximum: 32000, fallback: 350, integer: true }),
        temperature: numberOrFallback(video.temperature, { minimum: 0, maximum: 2, fallback: 0.2 }),
        maxBinaryBytes: numberOrFallback(video.max_binary_bytes, { minimum: 1024 * 1024, maximum: 512 * 1024 * 1024, fallback: 7000000, integer: true }),
        cacheEnabled: boundedBoolean(video.cache_enabled, true),
        ffmpegPath: clean(video.ffmpeg_path) || "ffmpeg",
        ffprobePath: clean(video.ffprobe_path) || "ffprobe",
      },
    },
    [TIME_AWARENESS_ID]: timeAwarenessSettings(timeAwareness),
    "voice-message": {
      ...voiceMessage,
    },
    "iphone-bridge": {
      ...iphoneBridgeState,
      enabledContactIds: companionContactIds(iphoneBridge),
    },
    "phone-camera": {
      saved: Object.keys(phoneCamera).length > 0 || phoneCameraScope.knownContactIds.length > 0,
      enabledContactIds: phoneCameraScope.enabledContactIds,
      defaultBackend: choiceOrFallback(phoneCamera.default_backend, ["api", "comfyui"], "api"),
      sizeByShot: {
        rear: sizeOrFallback(phoneSizes.rear, "1536x1024"),
        selfie: sizeOrFallback(phoneSizes.selfie, "1024x1536"),
        mirror: sizeOrFallback(phoneSizes.mirror, "1024x1536"),
      },
      references: { maxImages: numberOrFallback(phoneReferences.max_images, { minimum: 1, maximum: 16, fallback: 8, integer: true }) },
      prompt: { prefix: clean(phonePrompt.prefix), suffix: clean(phonePrompt.suffix) },
    },
    "proactive-contact": proactiveContactSettings(proactiveContact),
    "site-automation": {
      saved: Object.keys(siteAutomation).length > 0 || Object.keys(browserRuntime).length > 0 || siteAutomationScope.knownContactIds.length > 0,
      enabledContactIds: siteAutomationScope.enabledContactIds,
      sites: siteAutomationSettings(siteAutomation),
      browser: { status: clean(browserRuntime.status), browser: clean(browserRuntime.browser) },
      configuration: {
        cdpUrl: clean(siteAutomation.cdpUrl) || "http://127.0.0.1:9222",
        timeoutMs: numberOrFallback(siteAutomation.timeoutMs, { minimum: 1000, maximum: 120000, fallback: 10000, integer: true }),
        navigationTimeoutMs: numberOrFallback(siteAutomation.navigationTimeoutMs, { minimum: 1000, maximum: 180000, fallback: 25000, integer: true }),
        autoStartBrowser: boundedBoolean(siteAutomation.autoStartBrowser, true),
        pythonCommand: clean(siteAutomation.pythonCommand) || "python",
      },
    },
    "traveling-merchant": {
      saved: Object.keys(merchant).length > 0,
      wantedItems: Array.isArray(merchant.wantedItems) ? merchant.wantedItems.map((item) => clean(item)).filter(Boolean) : [],
      url: clean(merchant.url),
      notificationTemplate: clean(merchant.notificationTemplate) || "远行商人这轮有：{items}，快去买",
      notifyOnError: boundedBoolean(merchant.notifyOnError, true),
      errorNotificationTemplate: clean(merchant.errorNotificationTemplate) || "远行商人监控这轮检查失败了：{error}",
      requestTimeoutSeconds: numberOrFallback(merchant.requestTimeoutSeconds, { minimum: 3, maximum: 120, fallback: 15, integer: true }),
      maxAttempts: numberOrFallback(merchant.maxAttempts, { minimum: 1, maximum: 10, fallback: 3, integer: true }),
      retryDelaySeconds: numberOrFallback(merchant.retryDelaySeconds, { minimum: 0, maximum: 300, fallback: 20, integer: true }),
      enabledContactIds: companionContactIds(merchant),
    },
  };
}

export async function capabilityIpcResult(action) {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: clean(error?.code),
        message: clean(error?.message) || "能力操作未完成。",
      },
    };
  }
}

function safeCommand(value) {
  const command = clean(value || "suzu-lives");
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(command) ? command : "suzu-lives";
}

export function packagedCliCommand(executablePath) {
  const executable = clean(executablePath);
  if (!path.isAbsolute(executable) || !/\.exe$/iu.test(executable) || /[\r\n"]/u.test(executable)) throw new Error("无法定位打包后的 Suzu Lives CLI EXE。 ");
  return `"${executable}" --suzu-lives-cli`;
}

export function commandExists(command) {
  const executable = safeCommand(command);
  const probe = process.platform === "win32" ? "where.exe" : "which";
  try {
    return spawnSync(probe, [executable], { stdio: "ignore", windowsHide: true }).status === 0;
  } catch {
    return false;
  }
}

export function createCapabilitiesService({
  contactProjectsService = null,
  settingsService,
  existsCommand = commandExists,
  packaged = false,
  executablePath = "",
  launcherCommand = "",
  openExternal = null,
  projectHooksService = null,
  onIphoneFeedbackChange = null,
  onProactiveContactMaintenanceRequested = null,
  onTravelingMerchantScheduleSyncRequested = null,
  resolveContactSession = null,
} = {}) {
  if (!settingsService || typeof settingsService.load !== "function") throw new Error("能力服务需要软件设置服务。");
  let timeAwarenessUpdate = Promise.resolve();
  const queueTimeAwarenessUpdate = (operation) => {
    const next = timeAwarenessUpdate.catch(() => undefined).then(operation);
    timeAwarenessUpdate = next.catch(() => undefined);
    return next;
  };
  const stableLauncher = () => {
    const currentLauncher = clean(launcherCommand);
    if (currentLauncher) {
      return { command: currentLauncher, available: true, reason: "使用当前正在运行的 Suzu Lives CLI。" };
    }
    if (packaged) {
      const command = packagedCliCommand(executablePath);
      return { command, available: true, reason: "使用当前打包的 Suzu Lives EXE 的无窗口 Agent CLI。移动 portable EXE 后请在软件中重新注册能力以更新引用。" };
    }
    const command = safeCommand(process.env.SUZU_LIVES_COMMAND || "suzu-lives");
    const available = existsCommand(command) === true;
    return {
      command,
      available,
      reason: available ? "稳定启动命令可用。" : `未在当前系统 PATH 中找到 ${command}。`,
    };
  };
  const capabilityDataRoot = (settings) => clean(settingsService.response?.(settings)?.dataRoot || settings?.dataRoot);
  const companionConfig = (abilityId, settings = settingsService.load()) => {
    const dataRoot = capabilityDataRoot(settings);
    if (abilityId === "proactive-contact") return publicJson(dataRoot, ["automation", "proactive-contact", "config.json"]);
    if (abilityId === "traveling-merchant") return publicJson(dataRoot, ["automation", "traveling-merchant", "config.json"]);
    if (abilityId === "iphone-bridge") return publicJson(dataRoot, ["automation", "iphone-bridge", "config.json"]);
    throw new Error("这项能力不支持联系人投递设置。 ");
  };
  const writeProactiveContactSettings = async (dataRoot, existing, next) => {
    await writeJsonBelow(dataRoot, ["automation", "proactive-contact", "config.json"], {
      ...existing,
      chainPrompt: next.chainPrompt,
      followUpPrompt: next.followUpPrompt,
      autoMaintain: next.autoMaintain,
      enabledContactIds: next.enabledContactIds,
    });
  };
  const companionTargets = async () => {
    if (!contactProjectsService?.snapshot) return { status: "unavailable", contacts: [] };
    const snapshot = await contactProjectsService.snapshot();
    const contacts = Array.isArray(snapshot?.contacts) ? snapshot.contacts : [];
    return {
      status: clean(snapshot?.status) || "needs-root",
      contacts: contacts.flatMap((contact) => {
        const id = clean(contact?.id);
        if (!COMPANION_CONTACT_ID.test(id)) return [];
        return [{ id, name: clean(contact?.name) || "未命名联系人" }];
      }),
    };
  };
  const companionContactForInput = async (input) => {
    const contactId = clean(input.contactId);
    if (!contactId) throw new Error("请选择要投递的联系人。 ");
    const targets = await companionTargets();
    const contact = targets.contacts.find((item) => item.id === contactId);
    if (!contact) throw new Error("所选联系人不存在或无法读取。 ");
    return contact.id;
  };
  const contactProjectForInput = async (input, capabilityName) => {
    const contactId = clean(input.contactId);
    if (!contactId) throw new Error(`请选择要启用${capabilityName}的联系人。 `);
    if (!contactProjectsService?.snapshot) throw new Error("当前软件无法读取联系人项目。 ");
    const catalog = await contactProjectsService.snapshot();
    const contact = (Array.isArray(catalog?.contacts) ? catalog.contacts : []).find((item) => clean(item?.id) === contactId);
    const projectRoot = absoluteProjectRoot(contact?.projectRoot);
    if (!contact || !COMPANION_CONTACT_ID.test(contactId) || !projectRoot) {
      throw new Error("所选联系人不存在或无法读取其 Claude 项目。 ");
    }
    return { id: contactId, projectRoot };
  };
  const allContactProjects = async () => {
    if (!contactProjectsService?.snapshot) return [];
    try {
      const catalog = await contactProjectsService.snapshot();
      return (Array.isArray(catalog?.contacts) ? catalog.contacts : []).flatMap((contact) => {
        const id = clean(contact?.id);
        const projectRoot = absoluteProjectRoot(contact?.projectRoot);
        return COMPANION_CONTACT_ID.test(id) && projectRoot ? [{ id, projectRoot }] : [];
      });
    } catch {
      return [];
    }
  };
  const writeTimeAwarenessSettings = async ({ dataRoot, existing, intervalMinutes, enabledContactIds } = {}) => {
    const current = timeAwarenessSettings(existing);
    const nextIntervalMinutes = intervalMinutes === undefined
      ? current.intervalMinutes
      : boundedNumber(intervalMinutes, "时间感知间隔", {
        minimum: MIN_TIME_AWARENESS_INTERVAL_MINUTES,
        maximum: MAX_TIME_AWARENESS_INTERVAL_MINUTES,
        fallback: current.intervalMinutes,
        integer: true,
      });
    const nextContactIds = enabledContactIds === undefined
      ? current.enabledContactIds
      : normalizedCompanionContactIds(enabledContactIds);
    await writeJsonBelow(dataRoot, TIME_AWARENESS_CONFIG_PATH, {
      ...plainObject(existing),
      version: 1,
      intervalMinutes: nextIntervalMinutes,
      enabledContactIds: nextContactIds,
    });
  };
  const writeContactScopedAgentCapabilitySettings = async ({ abilityId, dataRoot, existing, enabledContactIds, knownContactIds } = {}) => {
    const configPath = contactScopedCapabilityConfigPath(abilityId);
    if (!configPath) throw new Error("这项能力不支持联系人范围设置。 ");
    const current = contactScopedAgentCapabilitySettings(existing);
    const nextEnabledContactIds = enabledContactIds === undefined
      ? current.enabledContactIds
      : normalizedCompanionContactIds(enabledContactIds);
    const nextKnownContactIds = knownContactIds === undefined
      ? current.knownContactIds
      : normalizedCompanionContactIds(knownContactIds);
    await writeJsonBelow(dataRoot, configPath, {
      ...plainObject(existing),
      enabledContactIds: nextEnabledContactIds,
      knownContactIds: nextKnownContactIds,
    });
  };
  const enabledCompanionContactIds = (abilityId) => companionContactIds(companionConfig(clean(abilityId)));
  const isCompanionContactEnabled = ({ abilityId, contactId } = {}) => (
    companionContactEnabled(companionConfig(clean(abilityId)), contactId)
  );
  const enabledCompanionSessions = async (abilityId) => {
    if (typeof resolveContactSession !== "function") return [];
    const contactIds = enabledCompanionContactIds(abilityId);
    const resolved = await Promise.allSettled(contactIds.map(async (contactId) => {
      const target = await resolveContactSession(contactId);
      const sessionId = clean(target?.id);
      const projectRoot = absoluteProjectRoot(target?.projectRoot);
      return sessionId && projectRoot ? {
        contactId,
        sessionId,
        projectRoot,
        hasTranscript: target?.hasTranscript === true,
      } : null;
    }));
    return resolved.flatMap((item) => item.status === "fulfilled" && item.value ? [item.value] : []);
  };
  const getProactiveContactSettings = () => proactiveContactSettings(companionConfig("proactive-contact"));
  const enabledIphoneBridgeSessions = async () => {
    const settings = settingsService.load();
    if (!iphoneBridgeSettings(companionConfig("iphone-bridge", settings)).saved) return [];
    return enabledCompanionSessions("iphone-bridge");
  };
  const notifyIphoneFeedbackChange = () => {
    if (typeof onIphoneFeedbackChange !== "function") return;
    Promise.resolve(onIphoneFeedbackChange()).catch(() => undefined);
  };
  const requestProactiveContactMaintenance = ({ scope = null } = {}) => {
    if (typeof onProactiveContactMaintenanceRequested !== "function") return;
    try {
      Promise.resolve(onProactiveContactMaintenanceRequested({ scope })).catch(() => undefined);
    } catch {
      // A local chain seed must never make an already-saved setting fail.
    }
  };
  const syncTravelingMerchantSchedule = async () => {
    if (typeof onTravelingMerchantScheduleSyncRequested !== "function") return;
    await onTravelingMerchantScheduleSyncRequested();
  };
  const snapshot = () => {
    const settings = settingsService.load();
    const launcher = stableLauncher();
    const projectRoot = clean(settings?.projectRoot);
    const dataRoot = capabilityDataRoot(settings);
    const savedSettings = savedCapabilitySettings(settings, dataRoot);
    return {
      projectRoot,
      launcher,
      capabilities: claudeAgentAbilityCatalog().map((capability) => {
        const contactScoped = isContactScopedCapability(capability.id);
        const enabledContactIds = Array.isArray(savedSettings[capability.id]?.enabledContactIds)
          ? savedSettings[capability.id].enabledContactIds
          : [];
        const current = contactScoped ? null : inspectClaudeRegistration({ projectRoot, abilityId: capability.id });
        const added = contactScoped ? enabledContactIds.length > 0 : current?.registered === true;
        return {
          ...capability,
          added,
          enabled: added,
          canToggle: !contactScoped && Boolean(projectRoot) && launcher.available === true,
          toggleReason: contactScoped
            ? "请在详情中选择允许使用这项能力的联系人。"
            : !projectRoot
              ? "先在“当前 Agent”中选择工作目录。"
              : !launcher.available
                ? "当前软件还没有准备好切换这项能力。"
                : "",
          savedSettings: savedSettings[capability.id] || { saved: false },
          canAdd: !contactScoped && !added && Boolean(projectRoot) && launcher.available === true,
          addReason: added
            ? contactScoped ? "已为至少一位联系人启用。" : "已加入当前 Agent。"
            : contactScoped
              ? "请在详情中选择联系人。"
              : !projectRoot
                ? "先在“当前 Agent”中选择工作目录。"
                : !launcher.available
                  ? "当前软件还未准备好添加能力。"
                  : "可以添加到当前 Agent。",
        };
      }),
    };
  };
  const assertTimeAwarenessHookService = () => {
    if (!projectHooksService?.installTimeAwareness || !projectHooksService?.uninstallTimeAwareness) {
      throw new Error("当前软件未接入时间感知 Hook 安装器。 ");
    }
  };
  const installTimeAwarenessForProject = async (projectRoot) => {
    assertTimeAwarenessHookService();
    const settings = settingsService.load();
    const launcher = stableLauncher();
    const root = absoluteProjectRoot(projectRoot);
    if (!root) throw new Error("请先选择有效的联系人 Claude 项目。 ");
    const wasRegistered = inspectClaudeRegistration({ projectRoot: root, abilityId: TIME_AWARENESS_ID }).registered === true;
    const registration = await writeClaudeRegistration({
      projectRoot: root,
      abilityId: TIME_AWARENESS_ID,
      launcher,
      toolPermissions: settings?.claudeToolPermissions,
    });
    try {
      await projectHooksService.installTimeAwareness({ projectRoot: root });
    } catch (error) {
      if (!wasRegistered) await removeClaudeRegistration({ projectRoot: root, abilityId: TIME_AWARENESS_ID }).catch(() => undefined);
      throw error;
    }
    return registration;
  };
  const uninstallTimeAwarenessForProject = async (projectRoot) => {
    assertTimeAwarenessHookService();
    const root = absoluteProjectRoot(projectRoot);
    if (!root) throw new Error("请先选择有效的联系人 Claude 项目。 ");
    const timeHookWasInstalled = projectHooksService.inspectTimeAwareness
      ? (await projectHooksService.inspectTimeAwareness({ projectRoot: root })).installed === true
      : false;
    await projectHooksService.uninstallTimeAwareness({ projectRoot: root });
    try {
      return await removeClaudeRegistration({ projectRoot: root, abilityId: TIME_AWARENESS_ID });
    } catch (error) {
      if (timeHookWasInstalled) await projectHooksService.installTimeAwareness({ projectRoot: root }).catch(() => undefined);
      throw error;
    }
  };
  const setContactScopedAgentCapabilityEnabled = async ({ abilityId, contact, enabled } = {}) => {
    const capabilityId = clean(abilityId);
    const configPath = contactScopedCapabilityConfigPath(capabilityId);
    const contactId = clean(contact?.id);
    const projectRoot = absoluteProjectRoot(contact?.projectRoot);
    if (!configPath || !COMPANION_CONTACT_ID.test(contactId) || !projectRoot) {
      throw new Error("联系人能力范围无效。 ");
    }
    const settings = settingsService.load();
    const dataRoot = capabilityDataRoot(settings);
    if (!dataRoot) throw new Error("无法定位 Suzu Lives 软件数据目录。 ");
    const result = enabled === true
      ? await writeClaudeRegistration({
        projectRoot,
        abilityId: capabilityId,
        launcher: stableLauncher(),
        toolPermissions: settings?.claudeToolPermissions,
      })
      : await removeClaudeRegistration({ projectRoot, abilityId: capabilityId });
    const existing = publicJson(dataRoot, configPath);
    await writeContactScopedAgentCapabilitySettings({
      abilityId: capabilityId,
      dataRoot,
      existing,
      enabledContactIds: withCompanionContact(existing, contactId, enabled === true),
      knownContactIds: trackCompanionContact(contactScopedAgentCapabilitySettings(existing).knownContactIds, contactId),
    });
    if (capabilityId === "iphone-bridge") notifyIphoneFeedbackChange();
    return { result, snapshot: snapshot() };
  };
  const registerAbility = async (abilityId) => {
    const settings = settingsService.load();
    const capabilityId = clean(abilityId);
    if (isContactScopedCapability(capabilityId)) {
      throw new Error("请在能力详情中选择要启用的联系人。 ");
    }
    const registration = await writeClaudeRegistration({
      projectRoot: clean(settings?.projectRoot), abilityId: capabilityId, launcher: stableLauncher(), toolPermissions: settings?.claudeToolPermissions,
    });
    return { registration, snapshot: snapshot() };
  };
  const initializeDefaultContactCapabilities = async (contact) => {
    const contactId = clean(contact?.id);
    const projectRoot = absoluteProjectRoot(contact?.projectRoot);
    const settings = settingsService.load();
    const dataRoot = capabilityDataRoot(settings);
    const launcher = stableLauncher();
    if (!COMPANION_CONTACT_ID.test(contactId) || !projectRoot || !dataRoot || launcher.available !== true) {
      return { initialized: false, errors: [] };
    }
    const errors = [];
    for (const abilityId of DEFAULT_CONTACT_SCOPED_AGENT_CAPABILITY_IDS) {
      const configPath = contactScopedCapabilityConfigPath(abilityId);
      const existing = publicJson(dataRoot, configPath);
      const current = contactScopedAgentCapabilitySettings(existing);
      if (current.knownContactIds.includes(contactId)) continue;
      try {
        await writeClaudeRegistration({
          projectRoot,
          abilityId,
          launcher,
          toolPermissions: settings?.claudeToolPermissions,
        });
        await writeContactScopedAgentCapabilitySettings({
          abilityId,
          dataRoot,
          existing,
          enabledContactIds: withCompanionContact(existing, contactId, true),
          knownContactIds: trackCompanionContact(current.knownContactIds, contactId),
        });
      } catch (error) {
        errors.push({ id: abilityId, contactId, code: clean(error?.code), message: clean(error?.message) || "无法默认开启。" });
      }
    }
    for (const abilityId of HIDDEN_CONTACT_DEFAULT_ABILITY_IDS) {
      if (inspectClaudeRegistration({ projectRoot, abilityId }).registered === true) continue;
      try {
        await writeClaudeRegistration({
          projectRoot,
          abilityId,
          launcher,
          toolPermissions: settings?.claudeToolPermissions,
        });
      } catch (error) {
        errors.push({ id: abilityId, contactId, code: clean(error?.code), message: clean(error?.message) || "无法完成默认登记。" });
      }
    }
    return { initialized: true, errors };
  };
  const managedRegistrationsMarker = (settings) => {
    const dataRoot = capabilityDataRoot(settings);
    return dataRoot ? publicJson(dataRoot, ["capabilities", "managed-registrations-v1.json"]) : {};
  };
  const registrationRefreshRequired = (marker, launcher) => (
    marker.registrationVersion !== MANAGED_REGISTRATION_VERSION || clean(marker.launcherCommand) !== launcher.command
  );
  const refreshManagedRegistrations = async () => {
    const settings = settingsService.load();
    const dataRoot = capabilityDataRoot(settings);
    const launcher = stableLauncher();
    if (!dataRoot || launcher.available !== true) {
      return { refreshed: false, errors: [], snapshot: snapshot() };
    }
    const marker = managedRegistrationsMarker(settings);
    if (!registrationRefreshRequired(marker, launcher)) {
      return { refreshed: false, errors: [], snapshot: snapshot() };
    }
    const errors = [];
    const contacts = await allContactProjects();
    const timeSettings = timeAwarenessSettings(publicJson(dataRoot, TIME_AWARENESS_CONFIG_PATH));
    for (const contact of contacts) {
      if (timeSettings.enabledContactIds.includes(contact.id)) {
        try {
          await installTimeAwarenessForProject(contact.projectRoot);
        } catch (error) {
          errors.push({ id: TIME_AWARENESS_ID, contactId: contact.id, code: clean(error?.code), message: clean(error?.message) || "无法更新时间感知 Hook。" });
        }
      }
      for (const capabilityId of managedClaudeRegistrationAbilityIds()) {
        // This Skill does not contain a launcher, and refreshing it would also
        // reinstall its Hook. The project settings sync already updates its CLI
        // permission when needed.
        if (capabilityId === TIME_AWARENESS_ID) continue;
        const registration = inspectClaudeRegistration({ projectRoot: contact.projectRoot, abilityId: capabilityId });
        if (registration.registered !== true && !HIDDEN_CONTACT_DEFAULT_ABILITY_IDS.includes(capabilityId)) continue;
        try {
          await writeClaudeRegistration({
            projectRoot: contact.projectRoot,
            abilityId: capabilityId,
            launcher,
            toolPermissions: settings?.claudeToolPermissions,
          });
        } catch (error) {
          errors.push({ id: capabilityId, contactId: contact.id, code: clean(error?.code), message: clean(error?.message) || "无法更新受管注册。" });
        }
      }
    }
    if (!errors.length) {
      await writeJsonBelow(dataRoot, ["capabilities", "managed-registrations-v1.json"], {
        ...marker,
        version: 1,
        registrationVersion: MANAGED_REGISTRATION_VERSION,
        launcherCommand: launcher.command,
        registrationsRefreshedAt: new Date().toISOString(),
      });
    }
    return { refreshed: true, errors, snapshot: snapshot() };
  };
  const saveSettings = async ({ id, value } = {}) => {
    const capabilityId = clean(id);
    const input = plainObject(value);
    const settings = settingsService.load();
    const dataRoot = capabilityDataRoot(settings);
    if (!dataRoot) throw new Error("无法定位 Suzu Lives 软件数据目录。 ");
    if (capabilityId === TIME_AWARENESS_ID) {
      return queueTimeAwarenessUpdate(async () => {
        const existing = publicJson(dataRoot, TIME_AWARENESS_CONFIG_PATH);
        if (Object.hasOwn(input, "contactId") || Object.hasOwn(input, "contactEnabled")) {
          if (!Object.hasOwn(input, "contactEnabled")) throw new Error("联系人开关状态无效。 ");
          const contact = await contactProjectForInput(input, "时间感知");
          const contactEnabled = boundedBoolean(input.contactEnabled, false);
          if (contactEnabled) await installTimeAwarenessForProject(contact.projectRoot);
          else await uninstallTimeAwarenessForProject(contact.projectRoot);
          await writeTimeAwarenessSettings({
            dataRoot,
            existing,
            enabledContactIds: withCompanionContact(existing, contact.id, contactEnabled),
          });
          return snapshot();
        }
        await writeTimeAwarenessSettings({
          dataRoot,
          existing,
          intervalMinutes: boundedNumber(input.intervalMinutes, "时间感知间隔", {
            minimum: MIN_TIME_AWARENESS_INTERVAL_MINUTES,
            maximum: MAX_TIME_AWARENESS_INTERVAL_MINUTES,
            fallback: timeAwarenessSettings(existing).intervalMinutes,
            integer: true,
          }),
        });
        return snapshot();
      });
    }
    if (isContactScopedAgentCapability(capabilityId) && (Object.hasOwn(input, "contactId") || Object.hasOwn(input, "contactEnabled"))) {
      if (!Object.hasOwn(input, "contactEnabled")) throw new Error("联系人开关状态无效。 ");
      const name = ({
        "image-generation": "图像生成",
        "phone-camera": "手机拍照式生图",
        "voice-message": "语音消息",
        "image-vision": "图像理解",
        "video-understanding": "视频理解",
        "site-automation": "网页自动化",
        "iphone-bridge": "iPhone 互通",
      })[capabilityId] || "联系人能力";
      const contact = await contactProjectForInput(input, name);
      const result = await setContactScopedAgentCapabilityEnabled({
        abilityId: capabilityId,
        contact,
        enabled: boundedBoolean(input.contactEnabled, false),
      });
      return result.snapshot;
    }
    if (capabilityId === "image-generation") {
      const existing = publicJson(dataRoot, ["capabilities", "image-generation", "config.json"]);
      const comfyui = plainObject(existing.comfyui);
      await writeJsonBelow(dataRoot, ["capabilities", "image-generation", "config.json"], {
        ...existing,
        default_backend: oneOf(input.defaultBackend, ["api", "comfyui"], "api", "图片生成方式"),
        comfyui: {
          ...comfyui,
          base_url: httpUrl(input.comfyBaseUrl, "ComfyUI 地址", clean(comfyui.base_url ?? comfyui.baseUrl) || "http://127.0.0.1:8188"),
          timeout_seconds: boundedNumber(input.comfyTimeoutSeconds, "ComfyUI 等待时间", { minimum: 1, maximum: 600, fallback: 600, integer: true }),
          poll_interval_seconds: boundedNumber(input.comfyPollIntervalSeconds, "ComfyUI 进度间隔", { minimum: 0.1, maximum: 30, fallback: 1 }),
          default_workflow: boundedText(input.comfyDefaultWorkflow, "默认 ComfyUI 工作流", 200),
        },
      });
      return snapshot();
    }
    if (capabilityId === "phone-camera") {
      const existing = publicJson(dataRoot, ["capabilities", "phone-camera", "config.json"]);
      const prompt = plainObject(existing.prompt);
      const sizes = plainObject(existing.size_by_shot);
      const references = plainObject(existing.references);
      await writeJsonBelow(dataRoot, ["capabilities", "phone-camera", "config.json"], {
        ...existing,
        default_backend: oneOf(input.defaultBackend, ["api", "comfyui"], "api", "自拍图片生成方式"),
        size_by_shot: {
          ...sizes,
          rear: imageSize(input.rearSize, "后置画面尺寸", "1536x1024"),
          selfie: imageSize(input.selfieSize, "自拍画面尺寸", "1024x1536"),
          mirror: imageSize(input.mirrorSize, "镜前画面尺寸", "1024x1536"),
        },
        references: {
          ...references,
          max_images: boundedNumber(input.maxImages, "参考图数量", { minimum: 1, maximum: 16, fallback: 8, integer: true }),
        },
        prompt: {
          ...prompt,
          prefix: boundedText(input.promptPrefix, "自拍补充提示词"),
          suffix: boundedText(input.promptSuffix, "自拍补充提示词"),
        },
      });
      return snapshot();
    }
    if (capabilityId === "image-vision") {
      const existing = publicJson(dataRoot, ["capabilities", "image-vision", "config.json"]);
      const provider = plainObject(existing.openai);
      const vision = plainObject(existing.vision);
      await writeJsonBelow(dataRoot, ["capabilities", "image-vision", "config.json"], {
        ...existing,
        openai: {
          ...provider,
          model: boundedText(input.model || provider.model, "图像理解模型", 200),
        },
        vision: {
          ...vision,
          detail: oneOf(input.detail, ["auto", "low", "high"], "auto", "图片读取精度"),
          timeout_seconds: boundedNumber(input.timeoutSeconds, "图片理解等待时间", { minimum: 5, maximum: 600, fallback: 90, integer: true }),
          max_output_tokens: boundedNumber(input.maxOutputTokens, "图片理解输出长度", { minimum: 32, maximum: 32000, fallback: 800, integer: true }),
          max_image_bytes: boundedNumber(input.maxImageBytes, "图片大小上限", { minimum: 262144, maximum: 25 * 1024 * 1024, fallback: 1572864, integer: true }),
          max_edge: boundedNumber(input.maxEdge, "图片边长上限", { minimum: 256, maximum: 8192, fallback: 1600, integer: true }),
          jpeg_quality: boundedNumber(input.jpegQuality, "图片压缩质量", { minimum: 1, maximum: 100, fallback: 90, integer: true }),
          retry_on_refusal: boundedBoolean(input.retryOnRefusal, true),
        },
      });
      return snapshot();
    }
    if (capabilityId === "video-understanding") {
      const existing = publicJson(dataRoot, ["capabilities", "video-understanding", "config.json"]);
      const provider = plainObject(existing.provider);
      const video = plainObject(existing.video);
      await writeJsonBelow(dataRoot, ["capabilities", "video-understanding", "config.json"], {
        ...existing,
        provider: {
          ...provider,
          model: boundedText(input.model || provider.model, "视频理解模型", 200),
        },
        video: {
          ...video,
          fps: boundedNumber(input.fps, "视频采样帧率", { minimum: 0.1, maximum: 10, fallback: 1 }),
          timeout_seconds: boundedNumber(input.timeoutSeconds, "视频理解等待时间", { minimum: 5, maximum: 3600, fallback: 240, integer: true }),
          max_output_tokens: boundedNumber(input.maxOutputTokens, "视频理解输出长度", { minimum: 32, maximum: 32000, fallback: 350, integer: true }),
          temperature: boundedNumber(input.temperature, "视频理解随机度", { minimum: 0, maximum: 2, fallback: 0.2 }),
          max_binary_bytes: boundedNumber(input.maxBinaryBytes, "视频大小上限", { minimum: 1024 * 1024, maximum: 512 * 1024 * 1024, fallback: 7000000, integer: true }),
          cache_enabled: boundedBoolean(input.cacheEnabled, true),
          ffmpeg_path: boundedText(input.ffmpegPath || video.ffmpeg_path || "ffmpeg", "FFmpeg 命令", 300),
          ffprobe_path: boundedText(input.ffprobePath || video.ffprobe_path || "ffprobe", "FFprobe 命令", 300),
        },
      });
      return snapshot();
    }
    if (capabilityId === "voice-message") {
      const agentRoot = currentVoiceAgentRoot(settings, dataRoot);
      if (!agentRoot) throw new Error("请先选择可用项目，再保存音色。 ");
      const voiceId = boundedText(input.voiceId, "音色", 200);
      if (!voiceId) throw new Error("请选择一个已保存音色。 ");
      const contact = publicJson(agentRoot, ["voice-message", "config.json"]);
      const provider = clean(input.provider).toLowerCase() || "qwen";
      let nextContact;
      if (provider === "minimax") {
        const customVoiceId = boundedText(input.customVoiceId, "自定义音频", 100);
        const customVoice = publicCustomVoices(agentRoot).find((item) => item.id === customVoiceId && item.voiceId === voiceId);
        if (!customVoice) throw new Error("所选 MiniMax 自定义音色不属于当前项目，请重新选择。 ");
        nextContact = {
          ...contact,
          schemaVersion: 2,
          provider: "minimax",
          voiceId,
          customVoiceId: customVoice.id,
        };
      } else if (provider === "qwen" || provider === "dashscope") {
        const candidates = publicVoiceCandidates(agentRoot);
        if (!candidates.some((candidate) => candidate.voiceId === voiceId)) {
          throw new Error("所选音色不属于当前项目的候选库，请重新选择。 ");
        }
        const { customVoiceId: _customVoiceId, provider: _provider, ...contactWithoutCustomVoice } = contact;
        nextContact = {
          ...contactWithoutCustomVoice,
          schemaVersion: 1,
          voiceId,
        };
      } else {
        throw new Error("当前只支持 Qwen 候选音色或 MiniMax 自定义音色。 ");
      }
      await writeJsonBelow(agentRoot, ["voice-message", "config.json"], {
        ...nextContact,
      });
      const shared = publicJson(dataRoot, ["capabilities", "voice-message", "config.json"]);
      const currentTimeout = numberOrFallback(shared.timeoutMs, { minimum: 1000, maximum: 600000, fallback: 30000, integer: true });
      const nextTimeout = boundedNumber(input.timeoutMs, "语音发送等待时间", { minimum: 1000, maximum: 600000, fallback: currentTimeout, integer: true });
      if (nextTimeout !== currentTimeout) {
        await writeJsonBelow(dataRoot, ["capabilities", "voice-message", "config.json"], {
          ...shared,
          timeoutMs: nextTimeout,
        });
      }
      return snapshot();
    }
    if (capabilityId === "iphone-bridge") {
      const existing = publicJson(dataRoot, ["automation", "iphone-bridge", "config.json"]);
      const existingMail = plainObject(existing.mail);
      const existingOutbound = plainObject(existing.outbound);
      const { password: _mailPassword, ...mailWithoutPassword } = existingMail;
      const { password: _outboundPassword, ...outboundWithoutPassword } = existingOutbound;
      const passwordEnv = environmentVariableName(input.passwordEnv || existingOutbound.passwordEnv || existingMail.passwordEnv || DEFAULT_IPHONE_BRIDGE_PASSWORD_ENV);
      const feedbackSubject = requiredText(input.feedbackSubject, "反馈邮件主题", 200);
      const feedbackPrompt = requiredText(input.feedbackPrompt, "反馈提示词", 12000);
      const allowedSenders = normalizedLines(input.allowedSenders, "允许的反馈发件人", { maximum: 30, itemMaximum: 320 });
      if (!allowedSenders.length) throw new Error("至少填写一个允许的反馈发件人。 ");
      const existingRoutes = Array.isArray(existing.routes) ? existing.routes.map((item) => plainObject(item)) : [];
      const currentRoute = existingRoutes.find((route) => clean(route.subject) === feedbackSubject) || {};
      const otherRoutes = existingRoutes.filter((route) => clean(route.subject) !== feedbackSubject);
      await writeJsonBelow(dataRoot, ["automation", "iphone-bridge", "config.json"], {
        ...existing,
        mail: {
          ...mailWithoutPassword,
          imapHost: requiredText(input.imapHost || existingMail.imapHost || DEFAULT_IPHONE_BRIDGE_IMAP_HOST, "IMAP 服务器", 320),
          imapPort: boundedNumber(input.imapPort, "IMAP 端口", { minimum: 1, maximum: 65535, fallback: 993, integer: true }),
          username: requiredText(input.username || existingMail.username, "反馈邮箱账号", 320),
          mailbox: requiredText(input.mailbox || existingMail.mailbox || "INBOX", "收件箱", 160),
          allowedSenders,
          passwordEnv,
        },
        outbound: {
          ...outboundWithoutPassword,
          smtpHost: requiredText(input.smtpHost || existingOutbound.smtpHost || existingMail.smtpHost || DEFAULT_IPHONE_BRIDGE_SMTP_HOST, "SMTP 服务器", 320),
          smtpPort: boundedNumber(input.smtpPort, "SMTP 端口", { minimum: 1, maximum: 65535, fallback: 465, integer: true }),
          sender: requiredText(input.sender || existingOutbound.sender || existingMail.username, "发件邮箱", 320),
          recipient: requiredText(input.recipient || existingOutbound.recipient, "iPhone 快捷指令邮箱", 320),
          passwordEnv,
        },
        routes: [...otherRoutes, {
          ...currentRoute,
          enabled: true,
          subject: feedbackSubject,
          promptTemplate: feedbackPrompt,
        }],
      });
      notifyIphoneFeedbackChange();
      return snapshot();
    }
    if (capabilityId === "site-automation") {
      const existing = publicJson(dataRoot, ["capabilities", "site-automation", "config.json"]);
      const requestedSiteId = clean(input.siteId).toLowerCase();
      if (requestedSiteId) {
        const site = siteAutomationCatalog().find((item) => item.id === requestedSiteId);
        if (!site) throw new Error("该网站尚未接入网页自动化。 ");
        const sites = plainObject(existing.sites);
        const currentSite = plainObject(sites[site.id]);
        const currentActions = plainObject(currentSite.actions);
        let nextSite;
        if (Object.hasOwn(input, "siteEnabled")) {
          nextSite = {
            ...currentSite,
            enabled: boundedBoolean(input.siteEnabled, true),
            actions: currentActions,
          };
        } else {
          const actionId = clean(input.action).toLowerCase();
          if (!site.actions.some((action) => action.id === actionId)) {
            throw new Error("该动作不属于这个已接入的网站。 ");
          }
          if (!Object.hasOwn(input, "actionEnabled")) throw new Error("动作开关状态无效。 ");
          nextSite = {
            ...currentSite,
            actions: {
              ...currentActions,
              [actionId]: boundedBoolean(input.actionEnabled, true),
            },
          };
        }
        await writeJsonBelow(dataRoot, ["capabilities", "site-automation", "config.json"], {
          ...existing,
          sites: { ...sites, [site.id]: nextSite },
        });
        return snapshot();
      }
      await writeJsonBelow(dataRoot, ["capabilities", "site-automation", "config.json"], {
        ...existing,
        cdpUrl: httpUrl(input.cdpUrl, "浏览器连接地址", clean(existing.cdpUrl) || "http://127.0.0.1:9222"),
        timeoutMs: boundedNumber(input.timeoutMs, "页面操作等待时间", { minimum: 1000, maximum: 120000, fallback: 10000, integer: true }),
        navigationTimeoutMs: boundedNumber(input.navigationTimeoutMs, "页面打开等待时间", { minimum: 1000, maximum: 180000, fallback: 25000, integer: true }),
        autoStartBrowser: boundedBoolean(input.autoStartBrowser, true),
        pythonCommand: boundedText(input.pythonCommand || existing.pythonCommand || "python", "Python 命令", 300),
      });
      return snapshot();
    }
    if (capabilityId === "proactive-contact") {
      const existing = publicJson(dataRoot, ["automation", "proactive-contact", "config.json"]);
      const current = proactiveContactSettings(existing);
      if (Object.hasOwn(input, "autoMaintain")) {
        const autoMaintain = boundedBoolean(input.autoMaintain, false);
        await writeProactiveContactSettings(dataRoot, existing, {
          ...current,
          autoMaintain,
        });
        if (autoMaintain) requestProactiveContactMaintenance();
        return snapshot();
      }
      if (Object.hasOwn(input, "contactId") || Object.hasOwn(input, "contactEnabled")) {
        if (!Object.hasOwn(input, "contactEnabled")) throw new Error("联系人开关状态无效。 ");
        const contactId = await companionContactForInput(input);
        const contactEnabled = boundedBoolean(input.contactEnabled, false);
        await writeProactiveContactSettings(dataRoot, existing, {
          ...current,
          enabledContactIds: withCompanionContact(existing, contactId, contactEnabled),
        });
        if (contactEnabled && current.autoMaintain) requestProactiveContactMaintenance({ scope: { contactId } });
        return snapshot();
      }
      await writeProactiveContactSettings(dataRoot, existing, {
        ...current,
        chainPrompt: boundedText(input.chainPrompt || current.chainPrompt, "链式主动关心提示词", 12000),
        followUpPrompt: boundedText(input.followUpPrompt || current.followUpPrompt, "临时回访提示词", 12000),
      });
      return snapshot();
    }
    if (capabilityId === "traveling-merchant") {
      const existing = publicJson(dataRoot, ["automation", "traveling-merchant", "config.json"]);
      const defaults = travelingMerchantDefaultConfig();
      if (Object.hasOwn(input, "contactId") || Object.hasOwn(input, "contactEnabled")) {
        if (!Object.hasOwn(input, "contactEnabled")) throw new Error("联系人开关状态无效。 ");
        const contactId = await companionContactForInput(input);
        const enabledContactIds = withCompanionContact(existing, contactId, boundedBoolean(input.contactEnabled, false));
        await writeJsonBelow(dataRoot, ["automation", "traveling-merchant", "config.json"], {
          ...defaults,
          ...existing,
          enabledContactIds,
        });
        await syncTravelingMerchantSchedule();
        return snapshot();
      }
      const wantedItems = normalizedLines(input.wantedItems, "关注物品", { maximum: 50, itemMaximum: 120 });
      if (!wantedItems.length) throw new Error("至少保留一项关注物品。 ");
      await writeJsonBelow(dataRoot, ["automation", "traveling-merchant", "config.json"], {
        ...defaults,
        ...existing,
        url: httpUrl(input.url, "远行商人页面地址", clean(existing.url || defaults.url)),
        wantedItems,
        notificationTemplate: boundedText(input.notificationTemplate || existing.notificationTemplate || defaults.notificationTemplate, "物品提醒文案", 1200),
        notifyOnError: boundedBoolean(input.notifyOnError, true),
        errorNotificationTemplate: boundedText(input.errorNotificationTemplate || existing.errorNotificationTemplate || defaults.errorNotificationTemplate, "失败提醒文案", 1200),
        requestTimeoutSeconds: boundedNumber(input.requestTimeoutSeconds, "网页等待时间", { minimum: 3, maximum: 120, fallback: 15, integer: true }),
        maxAttempts: boundedNumber(input.maxAttempts, "重试次数", { minimum: 1, maximum: 10, fallback: 3, integer: true }),
        retryDelaySeconds: boundedNumber(input.retryDelaySeconds, "重试间隔", { minimum: 0, maximum: 300, fallback: 20, integer: true }),
        enabledContactIds: companionContactIds(existing),
      });
      await syncTravelingMerchantSchedule();
      return snapshot();
    }
    throw new Error("这项能力目前没有可保存的设置。 ");
  };
  const removeContact = async ({ contactId } = {}) => {
    const id = clean(contactId);
    if (!COMPANION_CONTACT_ID.test(id)) throw new Error("要删除的联系人无效。 ");
    const settings = settingsService.load();
    const dataRoot = capabilityDataRoot(settings);
    if (!dataRoot) return { updated: 0 };
    const candidates = [
      TIME_AWARENESS_CONFIG_PATH,
      ["automation", "proactive-contact", "config.json"],
      ["automation", "traveling-merchant", "config.json"],
      ...[...CONTACT_SCOPED_AGENT_CAPABILITY_IDS]
        .map((abilityId) => contactScopedCapabilityConfigPath(abilityId))
        .filter(Boolean),
    ];
    const configPaths = candidates.filter((segments, index, all) => (
      all.findIndex((entry) => entry.join("/") === segments.join("/")) === index
    ));
    let updated = 0;
    let iphoneBridgeUpdated = false;
    let travelingMerchantUpdated = false;
    for (const segments of configPaths) {
      const existing = publicJson(dataRoot, segments);
      const next = { ...existing };
      let changed = false;
      for (const key of ["enabledContactIds", "knownContactIds"]) {
        if (!Array.isArray(existing[key]) || !existing[key].some((entry) => clean(entry) === id)) continue;
        next[key] = existing[key].filter((entry) => clean(entry) !== id);
        changed = true;
      }
      if (!changed) continue;
      await writeJsonBelow(dataRoot, segments, next);
      updated += 1;
      if (segments.join("/") === "automation/iphone-bridge/config.json") iphoneBridgeUpdated = true;
      if (segments.join("/") === "automation/traveling-merchant/config.json") travelingMerchantUpdated = true;
    }
    if (iphoneBridgeUpdated) notifyIphoneFeedbackChange();
    if (travelingMerchantUpdated) await syncTravelingMerchantSchedule();
    return { updated };
  };
  const openTravelingMerchantPage = async () => {
    if (typeof openExternal !== "function") throw new Error("当前环境无法打开网页。 ");
    const settings = settingsService.load();
    const defaults = travelingMerchantDefaultConfig();
    const merchant = companionConfig("traveling-merchant", settings);
    const url = httpUrl(merchant.url, "远行商人页面地址", defaults.url);
    await openExternal(url);
    return { url };
  };
  return {
    snapshot,
    companionTargets,
    initializeDefaultContactCapabilities,
    removeContact,
    refreshManagedRegistrations,
    saveSettings,
    proactiveContactSettings: getProactiveContactSettings,
    enabledCompanionContactIds,
    enabledCompanionSessions,
    isCompanionContactEnabled,
    enabledIphoneBridgeSessions,
    openTravelingMerchantPage,
    register: async (abilityId) => registerAbility(abilityId),
    setActive: async ({ id, enabled } = {}) => {
      if (typeof enabled !== "boolean") throw new Error("能力开关状态无效。 ");
      const capabilityId = clean(id);
      if (enabled) {
        const result = await registerAbility(capabilityId);
        return { ...result, enabled: true, snapshot: snapshot() };
      }
      if (isContactScopedCapability(capabilityId)) {
        throw new Error("请在能力详情中选择要关闭的联系人。 ");
      }
      const settings = settingsService.load();
      const removed = await removeClaudeRegistration({ projectRoot: clean(settings?.projectRoot), abilityId: capabilityId });
      return { removed, enabled: false, snapshot: snapshot() };
    },
  };
}

export function registerCapabilitiesIpc({ ipcMain, capabilitiesService }) {
  ipcMain.handle("capabilities:snapshot", () => capabilitiesService.snapshot());
  ipcMain.handle("capabilities:companion-targets", () => capabilitiesService.companionTargets());
  ipcMain.handle("capabilities:save-settings", (_event, value) => capabilityIpcResult(() => capabilitiesService.saveSettings(value)));
  ipcMain.handle("capabilities:open-traveling-merchant-page", () => capabilityIpcResult(() => capabilitiesService.openTravelingMerchantPage()));
  // Electron 只会向渲染层返回 IPC handler 的消息，因此同时返回稳定错误码。
  ipcMain.handle("capabilities:register", (_event, abilityId) => capabilityIpcResult(() => capabilitiesService.register(abilityId)));
  ipcMain.handle("capabilities:set-active", (_event, value) => capabilityIpcResult(() => capabilitiesService.setActive(value)));
}
