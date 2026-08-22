import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";
import { normalizeTtsAdapter, ttsAdapterLabel } from "@suzu-lives/voice-message/tts-adapters";
import { DEFAULT_AGENT_JOURNAL_TIME } from "../services/agent-journal-schedule.mjs";
import { createCapabilityRegistry } from "../services/capability-registry.mjs";

const COMPANION_CONTACT_ID = /^contact-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_COMPANION_CONTACTS = 160;
const TIME_AWARENESS_ID = "time-awareness";
const DEFAULT_CAPABILITY_REGISTRY = createCapabilityRegistry();
const TIME_AWARENESS_CONFIG_PATH = DEFAULT_CAPABILITY_REGISTRY.configPath(TIME_AWARENESS_ID);
const DEFAULT_TIME_AWARENESS_INTERVAL_MINUTES = 10;
const MIN_TIME_AWARENESS_INTERVAL_MINUTES = 1;
const MAX_TIME_AWARENESS_INTERVAL_MINUTES = 24 * 60;
const MAIL_BRIDGE_ID = "mail-bridge";
const WEB_BROWSER_ID = "web-browser";
const DEFAULT_MAIL_BRIDGE_SMTP_HOST = "smtp.163.com";
const DEFAULT_MAIL_BRIDGE_IMAP_HOST = "imap.163.com";
const DEFAULT_MAIL_BRIDGE_PASSWORD_ENV = "SUZU_MAIL_PASSWORD";
const DEFAULT_MAIL_BRIDGE_ROUTE_SUBJECT = "Suzu";
const DEFAULT_MAIL_BRIDGE_ROUTE_PROMPT = "这是收到的一封邮件（{{subject}}，来自 {{from}}，{{receivedAt}}）：\n{{content}}\n{{attachments}}";
const DEFAULT_PROACTIVE_CHAIN_PROMPT = "根据时间和前面聊的内容判断要不要主动联系对方。把判断过程写在思考中；要联系就正常发，不联系就只输出 NO_REPLY。";
const DEFAULT_PROACTIVE_FOLLOW_UP_PROMPT = "临时回访：用户在 TIME 提到 EVENT。先检查当前会话里是否已经有结果；已经有结果就只输出 NO_REPLY；还没有结果就自然地关心或询问。不要提及自动任务、回访任务或系统机制。这是一次性回访，不要设置下一次自动任务。";
function clean(value) {
  return String(value ?? "").trim();
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

function agentJournalSettings(value) {
  const source = plainObject(value);
  const time = clean(source.time);
  return {
    saved: Object.keys(source).length > 0,
    enabledContactIds: companionContactIds(source),
    time: /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time) ? time : DEFAULT_AGENT_JOURNAL_TIME,
  };
}

function journalTime(value) {
  const time = clean(value);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time)) throw new Error("请设置每天写日记的时间。 ");
  return time;
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
    defaultEnabled: !Object.hasOwn(source, "enabledContactIds"),
  };
}

function mailBridgeSettings(value) {
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
      smtpHost: publicText(outbound.smtpHost || mail.smtpHost || DEFAULT_MAIL_BRIDGE_SMTP_HOST, 320),
      smtpPort: numberOrFallback(outbound.smtpPort ?? mail.smtpPort, { minimum: 1, maximum: 65535, fallback: 465, integer: true }),
      sender: publicText(outbound.sender || mail.username, 320),
      recipient: publicText(outbound.recipient, 320),
      imapHost: publicText(mail.imapHost || DEFAULT_MAIL_BRIDGE_IMAP_HOST, 320),
      imapPort: numberOrFallback(mail.imapPort, { minimum: 1, maximum: 65535, fallback: 993, integer: true }),
      username: publicText(mail.username, 320),
      mailbox: publicText(mail.mailbox || "INBOX", 160),
      allowedSenders,
      passwordEnv: publicText(outbound.passwordEnv || mail.passwordEnv, 128),
      credentialConfigured,
      routeSubject: publicText(route.subject || DEFAULT_MAIL_BRIDGE_ROUTE_SUBJECT, 200),
      routePrompt: publicText(route.promptTemplate || DEFAULT_MAIL_BRIDGE_ROUTE_PROMPT, 12000),
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

function trackCompanionContact(value, contactId) {
  const id = clean(contactId);
  if (!COMPANION_CONTACT_ID.test(id)) throw new Error("要设置的联系人无效。 ");
  const current = normalizedCompanionContactIds(value);
  if (current.includes(id)) return current;
  if (current.length >= MAX_COMPANION_CONTACTS) throw new Error("联系人数量已达到上限。 ");
  return [...current, id];
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

function localCdpUrl(value, label, fallback = "") {
  const result = httpUrl(value, label, fallback);
  const hostname = new URL(result).hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(hostname)) {
    throw new Error(`${label}只能连接本机的 Suzu 专用浏览器。`);
  }
  if (!new URL(result).port) throw new Error(`${label}必须包含浏览器调试端口。`);
  return result;
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
    const adapter = normalizeTtsAdapter(voice.adapter || voice.provider);
    const voiceId = publicText(voice.voiceId, 200);
    if (!id || !name || !adapter || !voiceId || seen.has(id)) continue;
    seen.add(id);
    voices.push({
      id,
      name,
      adapter,
      voiceId,
      model: publicText(voice.model, 160),
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

function configuredVoiceAdapter(value) {
  const config = plainObject(value);
  const tts = plainObject(config.tts);
  return normalizeTtsAdapter(config.adapter || tts.adapter || config.provider || tts.provider, { fallback: "dashscope-qwen" });
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
  const contactAdapter = configuredVoiceAdapter(contact);
  const contactCustomVoiceId = configuredCustomVoiceId(contact);
  const availableVoiceIds = new Set(candidates.map((candidate) => candidate.voiceId));
  let voiceId = "";
  let voiceAdapter = "dashscope-qwen";
  let customVoiceId = "";
  let selectionSource = "missing";
  let diagnostic = "";
  if (!agentRoot) {
    selectionSource = "missing-contact";
    diagnostic = "请先选择可用项目，才能查看或保存音色。";
  } else if (contactVoiceId) {
    if (contactCustomVoiceId) {
      const selected = customVoices.find((item) => (
        item.id === contactCustomVoiceId
        && item.adapter === contactAdapter
        && item.voiceId === contactVoiceId
      ));
      if (selected) {
        voiceId = contactVoiceId;
        voiceAdapter = contactAdapter;
        customVoiceId = selected.id;
        selectionSource = "contact";
      } else {
        selectionSource = "invalid-contact";
        diagnostic = `当前项目保存的${ttsAdapterLabel(contactAdapter)}自定义音色不存在；发送会被拒绝，请重新选择。`;
      }
    } else if (contactAdapter === "dashscope-qwen" && availableVoiceIds.has(contactVoiceId)) {
      voiceId = contactVoiceId;
      voiceAdapter = contactAdapter;
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
    voiceAdapter,
    customVoiceId,
    timeoutMs: numberOrFallback(shared.timeoutMs, { minimum: 1000, maximum: 600000, fallback: 30000, integer: true }),
    voiceEnergyThreshold: numberOrFallback(shared.voiceEnergyThreshold, { minimum: 0.001, maximum: 1, fallback: 0.025 }),
    voiceSilenceFrames: numberOrFallback(shared.voiceSilenceFrames, { minimum: 1, maximum: 120, fallback: 9, integer: true }),
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
  const vision = plainObject(imageVision.vision);
  const video = plainObject(videoUnderstanding.video);
  const imageVisionScope = contactScopedAgentCapabilitySettings(imageVision);
  const videoUnderstandingScope = contactScopedAgentCapabilitySettings(videoUnderstanding);
  const imageGeneration = publicJson(dataRoot, ["capabilities", "image-generation", "config.json"]);
  const imageGenerationScope = contactScopedAgentCapabilitySettings(imageGeneration);
  const imageComfyui = plainObject(imageGeneration.comfyui);
  const voiceAgentRoot = currentVoiceAgentRoot(settings, dataRoot);
  const voiceDesign = voiceAgentRoot ? publicJson(voiceAgentRoot, ["voice-design", "config.json"]) : {};
  const mailBridge = publicJson(dataRoot, ["automation", "mail-bridge", "config.json"]);
  const mailBridgeState = mailBridgeSettings(mailBridge);
  const phoneCamera = publicJson(dataRoot, ["capabilities", "phone-camera", "config.json"]);
  const phoneCameraScope = contactScopedAgentCapabilitySettings(phoneCamera);
  const phoneSizes = plainObject(phoneCamera.size_by_shot);
  const phoneReferences = plainObject(phoneCamera.references);
  const webBrowser = publicJson(dataRoot, ["capabilities", "web-browser", "config.json"]);
  const webBrowserScope = contactScopedAgentCapabilitySettings(webBrowser);
  const browserRuntime = publicJson(dataRoot, ["capabilities", "web-browser", "runtime.json"]);
  const agentJournal = publicJson(dataRoot, ["automation", "agent-journal", "config.json"]);
  const proactiveContact = publicJson(dataRoot, ["automation", "proactive-contact", "config.json"]);
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
      saved: Boolean(Object.keys(vision).length || imageVisionScope.knownContactIds.length),
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
      saved: Boolean(Object.keys(video).length || videoUnderstandingScope.knownContactIds.length),
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
    [MAIL_BRIDGE_ID]: {
      ...mailBridgeState,
      enabledContactIds: companionContactIds(mailBridge),
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
    "agent-journal": agentJournalSettings(agentJournal),
    "proactive-contact": proactiveContactSettings(proactiveContact),
    [WEB_BROWSER_ID]: {
      saved: Object.keys(webBrowser).length > 0 || Object.keys(browserRuntime).length > 0 || webBrowserScope.knownContactIds.length > 0,
      enabledContactIds: webBrowserScope.enabledContactIds,
      browser: { status: clean(browserRuntime.status), browser: clean(browserRuntime.browser) },
      configuration: {
        cdpUrl: clean(webBrowser.cdpUrl) || "http://127.0.0.1:9222",
        timeoutMs: numberOrFallback(webBrowser.timeoutMs, { minimum: 1000, maximum: 120000, fallback: 10000, integer: true }),
        navigationTimeoutMs: numberOrFallback(webBrowser.navigationTimeoutMs, { minimum: 1000, maximum: 180000, fallback: 25000, integer: true }),
        autoStartBrowser: boundedBoolean(webBrowser.autoStartBrowser, true),
        executablePath: clean(webBrowser.executablePath),
      },
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

export function createCapabilitiesService({
  capabilityRegistry = DEFAULT_CAPABILITY_REGISTRY,
  capabilityRuntime = null,
  contactProjectsService = null,
  settingsService,
  resolveContactSession = null,
} = {}) {
  if (!settingsService || typeof settingsService.load !== "function") throw new Error("能力服务需要软件设置服务。");
  if (!capabilityRegistry || typeof capabilityRegistry.catalog !== "function" || typeof capabilityRegistry.configPath !== "function") {
    throw new Error("能力服务需要能力注册表。");
  }
  if (capabilityRuntime && (typeof capabilityRuntime.sync !== "function" || typeof capabilityRuntime.removeContact !== "function")) {
    throw new Error("能力服务收到的能力运行时无效。");
  }
  const registry = capabilityRegistry;
  const timeAwarenessConfigPath = registry.configPath(TIME_AWARENESS_ID) || TIME_AWARENESS_CONFIG_PATH;
  let timeAwarenessUpdate = Promise.resolve();
  const queueTimeAwarenessUpdate = (operation) => {
    const next = timeAwarenessUpdate.catch(() => undefined).then(operation);
    timeAwarenessUpdate = next.catch(() => undefined);
    return next;
  };
  const capabilityDataRoot = (settings) => clean(settingsService.response?.(settings)?.dataRoot || settings?.dataRoot);
  const companionConfig = (abilityId, settings = settingsService.load()) => {
    const dataRoot = capabilityDataRoot(settings);
    const id = clean(abilityId);
    const configPath = registry.configPath(id);
    if (registry.isContactScoped(id) && configPath) return publicJson(dataRoot, configPath);
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
  const writeAgentJournalSettings = async (dataRoot, existing, next) => {
    await writeJsonBelow(dataRoot, ["automation", "agent-journal", "config.json"], {
      ...existing,
      enabledContactIds: next.enabledContactIds,
      time: next.time,
      version: 1,
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
      throw new Error("所选联系人不存在或无法读取其 Suzu 联系人工作区。 ");
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
    await writeJsonBelow(dataRoot, timeAwarenessConfigPath, {
      ...plainObject(existing),
      version: 1,
      intervalMinutes: nextIntervalMinutes,
      enabledContactIds: nextContactIds,
    });
  };
  const writeContactScopedAgentCapabilitySettings = async ({ abilityId, dataRoot, existing, enabledContactIds, knownContactIds } = {}) => {
    const configPath = registry.configPath(abilityId);
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
  const enabledMailBridgeSessions = async () => {
    const settings = settingsService.load();
    if (!mailBridgeSettings(companionConfig(MAIL_BRIDGE_ID, settings)).saved) return [];
    return enabledCompanionSessions(MAIL_BRIDGE_ID);
  };
  const syncCapability = async (capabilityId, context = {}) => {
    if (!capabilityRuntime) return [];
    return capabilityRuntime.sync({ capabilityId, ...plainObject(context) });
  };
  const synchronizedSnapshot = async (capabilityId, context = {}) => {
    await syncCapability(capabilityId, context);
    return snapshot();
  };
  const removeCapabilityContactResources = async (context = {}) => {
    if (!capabilityRuntime) return [];
    return capabilityRuntime.removeContact(plainObject(context));
  };
  const snapshot = () => {
    const settings = settingsService.load();
    const projectRoot = clean(settings?.projectRoot);
    const dataRoot = capabilityDataRoot(settings);
    const savedSettings = savedCapabilitySettings(settings, dataRoot);
    return {
      runtime: "agent-core",
      projectRoot,
      capabilities: registry.catalog().map((capability) => {
        const contactScoped = registry.isContactScoped(capability.id);
        const enabledContactIds = Array.isArray(savedSettings[capability.id]?.enabledContactIds)
          ? savedSettings[capability.id].enabledContactIds
          : [];
        const added = contactScoped && enabledContactIds.length > 0;
        const runtimeStatus = registry.runtimeStatus(capability.id);
        return {
          ...capability,
          added,
          enabled: added,
          runtimeStatus,
          canToggle: false,
          toggleReason: contactScoped
            ? "请在详情中选择允许使用这项能力的联系人。"
            : "这项能力由 Suzu 运行时直接提供。",
          savedSettings: savedSettings[capability.id] || { saved: false },
          canAdd: false,
          addReason: added
            ? contactScoped ? "已为至少一位联系人启用。" : "已加入当前 Agent。"
            : contactScoped
              ? "请在详情中选择联系人。"
              : "这项能力由 Suzu 运行时直接提供。",
        };
      }),
    };
  };
  const initializeDefaultContactCapabilities = async (contact) => {
    const contactId = clean(contact?.id);
    if (!COMPANION_CONTACT_ID.test(contactId)) {
      return {
        initialized: false,
        contactId,
        status: "ready",
        errors: [],
      };
    }
    const settings = settingsService.load();
    const dataRoot = capabilityDataRoot(settings);
    if (!dataRoot) {
      return {
        initialized: false,
        contactId,
        status: "needs-root",
        errors: [],
      };
    }
    const existing = publicJson(dataRoot, ["automation", "proactive-contact", "config.json"]);
    const current = proactiveContactSettings(existing);
    await writeProactiveContactSettings(dataRoot, existing, {
      ...current,
      enabledContactIds: withCompanionContact(existing, contactId, true),
    });
    await syncCapability("proactive-contact", {
      reason: "contact-created",
      scope: current.autoMaintain ? { contactId } : null,
    });
    return {
      initialized: true,
      contactId,
      status: "ready",
      errors: [],
    };
  };
  const refreshManagedRegistrations = async () => {
    const settings = settingsService.load();
    const dataRoot = capabilityDataRoot(settings);
    if (!dataRoot) return { refreshed: false, status: "needs-root", errors: [], snapshot: snapshot() };
    const existing = publicJson(dataRoot, ["automation", "proactive-contact", "config.json"]);
    if (Object.hasOwn(plainObject(existing), "enabledContactIds")) {
      return { refreshed: false, status: "ready", errors: [], snapshot: snapshot() };
    }
    const targets = await companionTargets();
    const enabledContactIds = targets.contacts.map((contact) => contact.id);
    if (!enabledContactIds.length) return { refreshed: false, status: "ready", errors: [], snapshot: snapshot() };
    const current = proactiveContactSettings(existing);
    await writeProactiveContactSettings(dataRoot, existing, {
      ...current,
      enabledContactIds,
    });
    await syncCapability("proactive-contact", { reason: "default-contact-migration" });
    return { refreshed: true, status: "ready", errors: [], snapshot: snapshot() };
  };
  const saveSettings = async ({ id, value } = {}) => {
    const capabilityId = clean(id);
    const input = plainObject(value);
    const settings = settingsService.load();
    const dataRoot = capabilityDataRoot(settings);
    if (!dataRoot) throw new Error("无法定位 Suzu Lives 软件数据目录。 ");
    if (capabilityId === TIME_AWARENESS_ID) {
      return queueTimeAwarenessUpdate(async () => {
        const existing = publicJson(dataRoot, timeAwarenessConfigPath);
        const current = timeAwarenessSettings(existing);
        let enabledContactIds;
        if (Object.hasOwn(input, "contactId") || Object.hasOwn(input, "contactEnabled")) {
          if (!Object.hasOwn(input, "contactEnabled")) throw new Error("联系人开关状态无效。 ");
          if (typeof input.contactEnabled !== "boolean") throw new Error("联系人开关状态无效。 ");
          const contactId = await companionContactForInput(input);
          enabledContactIds = withCompanionContact(current, contactId, input.contactEnabled);
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
          enabledContactIds,
        });
        await syncCapability(capabilityId, { reason: "settings-saved" });
        return snapshot();
      });
    }
    if (Object.hasOwn(input, "contactId") || Object.hasOwn(input, "contactEnabled")) {
      if (!Object.hasOwn(input, "contactEnabled") || typeof input.contactEnabled !== "boolean") {
        throw new Error("联系人开关状态无效。 ");
      }
      // A Agent Core bridge action is installed once in the product runtime, while
      // its availability remains per-contact without making a capability
      // globally available.
      const hasAgentAction = typeof registry.agentActions === "function"
        && registry.agentActions({ capabilityId }).length > 0;
      if (registry.isContactScoped(capabilityId) && hasAgentAction) {
        const contactId = await companionContactForInput(input);
        const existing = publicJson(dataRoot, registry.configPath(capabilityId));
        const current = contactScopedAgentCapabilitySettings(existing);
        const contactEnabled = input.contactEnabled;
        await writeContactScopedAgentCapabilitySettings({
          abilityId: capabilityId,
          dataRoot,
          existing,
          enabledContactIds: withCompanionContact(existing, contactId, contactEnabled),
          knownContactIds: contactEnabled
            ? trackCompanionContact(current.knownContactIds, contactId)
            : current.knownContactIds,
        });
        return synchronizedSnapshot(capabilityId, {
          reason: "contact-setting-saved",
          contactId,
          contactEnabled,
        });
      }
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
      return synchronizedSnapshot(capabilityId, { reason: "settings-saved" });
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
      return synchronizedSnapshot(capabilityId, { reason: "settings-saved" });
    }
    if (capabilityId === "image-vision") {
      const existing = publicJson(dataRoot, ["capabilities", "image-vision", "config.json"]);
      const vision = plainObject(existing.vision);
      const { openai: _legacyProvider, ...rest } = existing;
      await writeJsonBelow(dataRoot, ["capabilities", "image-vision", "config.json"], {
        ...rest,
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
      return synchronizedSnapshot(capabilityId, { reason: "settings-saved" });
    }
    if (capabilityId === "video-understanding") {
      const existing = publicJson(dataRoot, ["capabilities", "video-understanding", "config.json"]);
      const video = plainObject(existing.video);
      const { provider: _legacyProvider, ...rest } = existing;
      await writeJsonBelow(dataRoot, ["capabilities", "video-understanding", "config.json"], {
        ...rest,
        video: {
          ...video,
          fps: boundedNumber(input.fps, "视频模型读取帧率", { minimum: 0.1, maximum: 10, fallback: 1 }),
          timeout_seconds: boundedNumber(input.timeoutSeconds, "视频理解等待时间", { minimum: 5, maximum: 3600, fallback: 240, integer: true }),
          max_output_tokens: boundedNumber(input.maxOutputTokens, "视频理解输出长度", { minimum: 32, maximum: 32000, fallback: 350, integer: true }),
          temperature: boundedNumber(input.temperature, "视频理解随机度", { minimum: 0, maximum: 2, fallback: 0.2 }),
          max_binary_bytes: boundedNumber(input.maxBinaryBytes, "视频大小上限", { minimum: 1024 * 1024, maximum: 512 * 1024 * 1024, fallback: 7000000, integer: true }),
          cache_enabled: boundedBoolean(input.cacheEnabled, true),
          ffmpeg_path: boundedText(input.ffmpegPath || video.ffmpeg_path || "ffmpeg", "FFmpeg 命令", 300),
          ffprobe_path: boundedText(input.ffprobePath || video.ffprobe_path || "ffprobe", "FFprobe 命令", 300),
        },
      });
      return synchronizedSnapshot(capabilityId, { reason: "settings-saved" });
    }
    if (capabilityId === "voice-message") {
      const shared = publicJson(dataRoot, ["capabilities", "voice-message", "config.json"]);
      const currentTimeout = numberOrFallback(shared.timeoutMs, { minimum: 1000, maximum: 600000, fallback: 30000, integer: true });
      const nextTimeout = boundedNumber(input.timeoutMs, "语音发送等待时间", { minimum: 1000, maximum: 600000, fallback: currentTimeout, integer: true });
      const currentThreshold = numberOrFallback(shared.voiceEnergyThreshold, { minimum: 0.001, maximum: 1, fallback: 0.025 });
      const nextThreshold = boundedNumber(input.voiceEnergyThreshold, "说话能量阈值", { minimum: 0.001, maximum: 1, fallback: currentThreshold });
      const currentFrames = numberOrFallback(shared.voiceSilenceFrames, { minimum: 1, maximum: 120, fallback: 9, integer: true });
      const nextFrames = boundedNumber(input.voiceSilenceFrames, "静音判定帧数", { minimum: 1, maximum: 120, fallback: currentFrames, integer: true });
      if (nextTimeout !== currentTimeout || nextThreshold !== currentThreshold || nextFrames !== currentFrames) {
        await writeJsonBelow(dataRoot, ["capabilities", "voice-message", "config.json"], {
          ...shared,
          timeoutMs: nextTimeout,
          voiceEnergyThreshold: nextThreshold,
          voiceSilenceFrames: nextFrames,
        });
      }
      if (clean(input.voiceId)) {
        const agentRoot = currentVoiceAgentRoot(settings, dataRoot);
        if (!agentRoot) throw new Error("请先选择可用项目，再保存音色。 ");
        const voiceId = boundedText(input.voiceId, "音色", 200);
        const contact = publicJson(agentRoot, ["voice-message", "config.json"]);
        const adapter = normalizeTtsAdapter(input.adapter || input.provider, { fallback: "dashscope-qwen" });
        let nextContact;
        if (!adapter) throw new Error("请选择受支持的语音接口适配器。 ");
        if (clean(input.customVoiceId)) {
          const customVoiceId = boundedText(input.customVoiceId, "自定义音频", 100);
          const customVoice = publicCustomVoices(agentRoot).find((item) => (
            item.id === customVoiceId && item.adapter === adapter && item.voiceId === voiceId
          ));
          if (!customVoice) throw new Error(`所选${ttsAdapterLabel(adapter)}自定义音色不属于当前项目，请重新选择。 `);
          nextContact = {
            ...contact,
            schemaVersion: 4,
            adapter,
            voiceId,
            customVoiceId: customVoice.id,
          };
        } else if (adapter === "dashscope-qwen") {
          const candidates = publicVoiceCandidates(agentRoot);
          if (!candidates.some((candidate) => candidate.voiceId === voiceId)) {
            throw new Error("所选音色不属于当前项目的候选库，请重新选择。 ");
          }
          const { customVoiceId: _customVoiceId, provider: _provider, adapter: _adapter, ...contactWithoutCustomVoice } = contact;
          nextContact = {
            ...contactWithoutCustomVoice,
            schemaVersion: 4,
            adapter,
            voiceId,
          };
        } else {
          throw new Error("当前适配器需要先选择一个已保存的自定义音色。 ");
        }
        await writeJsonBelow(agentRoot, ["voice-message", "config.json"], {
          ...nextContact,
        });
      }
      return synchronizedSnapshot(capabilityId, { reason: "settings-saved" });
    }
    if (capabilityId === MAIL_BRIDGE_ID) {
      const existing = publicJson(dataRoot, ["automation", "mail-bridge", "config.json"]);
      const existingMail = plainObject(existing.mail);
      const existingOutbound = plainObject(existing.outbound);
      const { password: _mailPassword, ...mailWithoutPassword } = existingMail;
      const { password: _outboundPassword, ...outboundWithoutPassword } = existingOutbound;
      const passwordEnv = environmentVariableName(input.passwordEnv || existingOutbound.passwordEnv || existingMail.passwordEnv || DEFAULT_MAIL_BRIDGE_PASSWORD_ENV);
      const routeSubject = requiredText(input.routeSubject ?? input.feedbackSubject, "邮件主题路由", 200);
      const routePrompt = requiredText(input.routePrompt ?? input.feedbackPrompt, "邮件投递提示词", 12000);
      const allowedSenders = normalizedLines(input.allowedSenders, "允许的邮件发件人", { maximum: 30, itemMaximum: 320 });
      if (!allowedSenders.length) throw new Error("至少填写一个允许的邮件发件人。 ");
      const existingRoutes = Array.isArray(existing.routes) ? existing.routes.map((item) => plainObject(item)) : [];
      const currentRoute = existingRoutes.find((route) => clean(route.subject) === routeSubject) || {};
      const otherRoutes = existingRoutes.filter((route) => clean(route.subject) !== routeSubject);
      await writeJsonBelow(dataRoot, ["automation", "mail-bridge", "config.json"], {
        ...existing,
        mail: {
          ...mailWithoutPassword,
          imapHost: requiredText(input.imapHost || existingMail.imapHost || DEFAULT_MAIL_BRIDGE_IMAP_HOST, "IMAP 服务器", 320),
          imapPort: boundedNumber(input.imapPort, "IMAP 端口", { minimum: 1, maximum: 65535, fallback: 993, integer: true }),
          username: requiredText(input.username || existingMail.username, "收信邮箱账号", 320),
          mailbox: requiredText(input.mailbox || existingMail.mailbox || "INBOX", "收件箱", 160),
          allowedSenders,
          passwordEnv,
        },
        outbound: {
          ...outboundWithoutPassword,
          smtpHost: requiredText(input.smtpHost || existingOutbound.smtpHost || existingMail.smtpHost || DEFAULT_MAIL_BRIDGE_SMTP_HOST, "SMTP 服务器", 320),
          smtpPort: boundedNumber(input.smtpPort, "SMTP 端口", { minimum: 1, maximum: 65535, fallback: 465, integer: true }),
          sender: requiredText(input.sender || existingOutbound.sender || existingMail.username, "发件邮箱", 320),
          recipient: requiredText(input.recipient || existingOutbound.recipient, "默认收件邮箱", 320),
          passwordEnv,
        },
        routes: [...otherRoutes, {
          ...currentRoute,
          enabled: true,
          subject: routeSubject,
          promptTemplate: routePrompt,
        }],
      });
      return synchronizedSnapshot(capabilityId, { reason: "settings-saved" });
    }
    if (capabilityId === WEB_BROWSER_ID) {
      const existing = publicJson(dataRoot, ["capabilities", "web-browser", "config.json"]);
      const executablePath = boundedText(input.executablePath ?? existing.executablePath, "浏览器可执行文件", 1000);
      if (executablePath && !path.isAbsolute(executablePath)) throw new Error("浏览器可执行文件必须是绝对路径。 ");
      await writeJsonBelow(dataRoot, ["capabilities", "web-browser", "config.json"], {
        ...existing,
        cdpUrl: localCdpUrl(input.cdpUrl, "浏览器连接地址", clean(existing.cdpUrl) || "http://127.0.0.1:9222"),
        timeoutMs: boundedNumber(input.timeoutMs, "页面操作等待时间", { minimum: 1000, maximum: 120000, fallback: 10000, integer: true }),
        navigationTimeoutMs: boundedNumber(input.navigationTimeoutMs, "页面打开等待时间", { minimum: 1000, maximum: 180000, fallback: 25000, integer: true }),
        autoStartBrowser: boundedBoolean(input.autoStartBrowser, true),
        executablePath,
      });
      return synchronizedSnapshot(capabilityId, { reason: "settings-saved" });
    }
    if (capabilityId === "agent-journal") {
      const existing = publicJson(dataRoot, ["automation", "agent-journal", "config.json"]);
      const current = agentJournalSettings(existing);
      if (Object.hasOwn(input, "contactId") || Object.hasOwn(input, "contactEnabled")) {
        if (!Object.hasOwn(input, "contactEnabled")) throw new Error("联系人开关状态无效。 ");
        const contactId = await companionContactForInput(input);
        await writeAgentJournalSettings(dataRoot, existing, {
          ...current,
          enabledContactIds: withCompanionContact(existing, contactId, boundedBoolean(input.contactEnabled, false)),
        });
        return synchronizedSnapshot(capabilityId, { reason: "contact-setting-saved", scope: { contactId } });
      }
      await writeAgentJournalSettings(dataRoot, existing, {
        ...current,
        time: journalTime(input.time || current.time),
      });
      return synchronizedSnapshot(capabilityId, { reason: "settings-saved" });
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
        return synchronizedSnapshot(capabilityId, { reason: "settings-saved" });
      }
      if (Object.hasOwn(input, "contactId") || Object.hasOwn(input, "contactEnabled")) {
        if (!Object.hasOwn(input, "contactEnabled")) throw new Error("联系人开关状态无效。 ");
        const contactId = await companionContactForInput(input);
        const contactEnabled = boundedBoolean(input.contactEnabled, false);
        await writeProactiveContactSettings(dataRoot, existing, {
          ...current,
          enabledContactIds: withCompanionContact(existing, contactId, contactEnabled),
        });
        return synchronizedSnapshot(capabilityId, {
          reason: "contact-setting-saved",
          scope: contactEnabled && current.autoMaintain ? { contactId } : null,
        });
      }
      await writeProactiveContactSettings(dataRoot, existing, {
        ...current,
        chainPrompt: boundedText(input.chainPrompt || current.chainPrompt, "链式主动关心提示词", 12000),
        followUpPrompt: boundedText(input.followUpPrompt || current.followUpPrompt, "临时回访提示词", 12000),
      });
      return synchronizedSnapshot(capabilityId, { reason: "settings-saved" });
    }
    throw new Error("这项能力目前没有可保存的设置。 ");
  };
  const removeContact = async ({ contactId, contact = null } = {}) => {
    const id = clean(contactId);
    if (!COMPANION_CONTACT_ID.test(id)) throw new Error("要删除的联系人无效。 ");
    const settings = settingsService.load();
    const dataRoot = capabilityDataRoot(settings);
    if (!dataRoot) {
      await removeCapabilityContactResources({ contactId: id, contact });
      return { updated: 0 };
    }
    const configEntries = registry.contactConfigEntries();
    let updated = 0;
    const changedCapabilities = new Set();
    for (const entry of configEntries) {
      const existing = publicJson(dataRoot, entry.path);
      const next = { ...existing };
      let changed = false;
      for (const key of entry.contactFields) {
        if (!Array.isArray(existing[key]) || !existing[key].some((entry) => clean(entry) === id)) continue;
        next[key] = existing[key].filter((entry) => clean(entry) !== id);
        changed = true;
      }
      if (!changed) continue;
      await writeJsonBelow(dataRoot, entry.path, next);
      updated += 1;
      changedCapabilities.add(entry.capabilityId);
    }
    for (const capabilityId of changedCapabilities) {
      await syncCapability(capabilityId, { reason: "contact-removed", contactId: id });
    }
    await removeCapabilityContactResources({ contactId: id, contact });
    return { updated };
  };
  return {
    snapshot,
    companionTargets,
    initializeDefaultContactCapabilities,
    removeContact,
    refreshManagedRegistrations,
    saveSettings,
    agentJournalSettings: () => agentJournalSettings(companionConfig("agent-journal")),
    proactiveContactSettings: getProactiveContactSettings,
    enabledCompanionContactIds,
    enabledCompanionSessions,
    isCompanionContactEnabled,
    enabledMailBridgeSessions,
    register: async (abilityId) => {
      const capabilityId = clean(abilityId);
      if (!registry.get(capabilityId)) throw new Error("要登记的能力不存在。 ");
      return { registered: false, status: "managed-by-settings", snapshot: snapshot() };
    },
    setActive: async ({ id, enabled } = {}) => {
      if (typeof enabled !== "boolean") throw new Error("能力开关状态无效。 ");
      const capabilityId = clean(id);
      if (!registry.get(capabilityId)) throw new Error("要设置的能力不存在。 ");
      throw new Error("请在能力详情中选择允许使用这项能力的联系人。 ");
    },
  };
}

export function registerCapabilitiesIpc({ ipcMain, capabilitiesService }) {
  ipcMain.handle("capabilities:snapshot", () => capabilitiesService.snapshot());
  ipcMain.handle("capabilities:companion-targets", () => capabilitiesService.companionTargets());
  ipcMain.handle("capabilities:save-settings", (_event, value) => capabilityIpcResult(() => capabilitiesService.saveSettings(value)));
  // Electron 只会向渲染层返回 IPC handler 的消息，因此同时返回稳定错误码。
  ipcMain.handle("capabilities:register", (_event, abilityId) => capabilityIpcResult(() => capabilitiesService.register(abilityId)));
  ipcMain.handle("capabilities:set-active", (_event, value) => capabilityIpcResult(() => capabilitiesService.setActive(value)));
}
