import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { issueCapabilityInvocationAuthorization, setCapabilityEnabled } from "@suzu-lives/capability-registry";
import { listSiteAutomationSites } from "@suzu-lives/browser-automation";
import { claudeAgentAbilityCatalog, inspectClaudeRegistration, removeClaudeRegistration, travelingMerchantDefaultConfig, writeClaudeRegistration } from "@suzu-lives/claude-integration";
import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";

const COMPANION_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_COMPANION_SESSIONS = 160;
const DEFAULT_PROACTIVE_CHAIN_PROMPT = "根据时间和前面聊的内容判断要不要主动联系对方，要发就正常发，不发就沉默，然后记得要设置下一次自动任务";
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

function companionScopeKey({ sessionId, projectRoot } = {}) {
  const id = clean(sessionId);
  const root = absoluteProjectRoot(projectRoot);
  if (!COMPANION_SESSION_ID.test(id) || !root) return "";
  return `${process.platform === "win32" ? root.toLowerCase() : root}\u0000${id}`;
}

function normalizedCompanionSessions(value) {
  const sessions = [];
  const seen = new Set();
  for (const entry of (Array.isArray(value) ? value : []).slice(0, MAX_COMPANION_SESSIONS)) {
    const sessionId = clean(entry?.sessionId);
    const projectRoot = absoluteProjectRoot(entry?.projectRoot);
    const key = companionScopeKey({ sessionId, projectRoot });
    if (!key || seen.has(key)) continue;
    seen.add(key);
    sessions.push({ sessionId, projectRoot });
  }
  return sessions;
}

function companionSessions(value) {
  return normalizedCompanionSessions(plainObject(value).enabledSessions);
}

function companionSessionEnabled(value, scope) {
  const key = companionScopeKey(scope);
  return Boolean(key && companionSessions(value).some((item) => companionScopeKey(item) === key));
}

function withCompanionSession(value, scope, enabled) {
  const key = companionScopeKey(scope);
  if (!key) throw new Error("要设置的 Claude 会话无效。 ");
  const current = companionSessions(value);
  const next = current.filter((item) => companionScopeKey(item) !== key);
  if (enabled) next.push({ sessionId: clean(scope.sessionId), projectRoot: absoluteProjectRoot(scope.projectRoot) });
  return next;
}

function proactiveContactSettings(value) {
  const source = plainObject(value);
  return {
    saved: Object.keys(source).length > 0,
    chainPrompt: clean(source.chainPrompt) || DEFAULT_PROACTIVE_CHAIN_PROMPT,
    followUpPrompt: clean(source.followUpPrompt) || DEFAULT_PROACTIVE_FOLLOW_UP_PROMPT,
    enabledSessions: companionSessions(source),
  };
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
  return publicJsonLines(agentRoot, ["voice-design", "candidates.jsonl"], 40)
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
  const visionProvider = plainObject(imageVision.openai);
  const vision = plainObject(imageVision.vision);
  const videoProvider = plainObject(videoUnderstanding.provider);
  const video = plainObject(videoUnderstanding.video);
  const agentId = clean(settings?.agentId);
  const agentRoot = agentId && clean(dataRoot) ? resolveAgentDataRoot({ dataRoot, agentId }) : "";
  const imageGeneration = agentRoot ? publicJson(agentRoot, ["image-generation", "config.json"]) : {};
  const imageComfyui = plainObject(imageGeneration.comfyui);
  const visualReferences = agentRoot ? publicJson(agentRoot, ["visual-references", "manifest.json"]) : {};
  const voiceDesign = agentRoot ? publicJson(agentRoot, ["voice-design", "config.json"]) : {};
  const voiceMessage = publicJson(dataRoot, ["capabilities", "voice-message", "config.json"]);
  const iphoneBridge = agentRoot ? publicJson(agentRoot, ["iphone-bridge", "feedback_config.json"]) : {};
  const iphoneFeedback = publicJson(dataRoot, ["automation", "iphone-bridge", "config.json"]);
  const phoneCamera = agentRoot ? publicJson(agentRoot, ["phone-camera", "config.json"]) : {};
  const phoneSizes = plainObject(phoneCamera.size_by_shot);
  const phoneReferences = plainObject(phoneCamera.references);
  const siteAutomation = agentRoot ? publicJson(agentRoot, ["site-automation", "config.json"]) : {};
  const browserRuntime = agentRoot ? publicJson(agentRoot, ["web-browser", "runtime.json"]) : {};
  const proactiveContact = publicJson(dataRoot, ["automation", "proactive-contact", "config.json"]);
  const merchant = publicJson(dataRoot, ["automation", "traveling-merchant", "config.json"]);
  const phonePrompt = plainObject(phoneCamera.prompt);
  const candidates = agentRoot ? publicVoiceCandidates(agentRoot) : [];
  return {
    "image-generation": {
      saved: Object.keys(imageGeneration).length > 0,
      defaultBackend: choiceOrFallback(imageGeneration.default_backend ?? imageGeneration.defaultBackend, ["api", "comfyui"], "api"),
      comfyui: {
        baseUrl: clean(imageComfyui.base_url ?? imageComfyui.baseUrl) || "http://127.0.0.1:8188",
        timeoutSeconds: numberOrFallback(imageComfyui.timeout_seconds ?? (Number(imageComfyui.timeoutMs) ? Number(imageComfyui.timeoutMs) / 1000 : ""), { minimum: 1, maximum: 600, fallback: 600, integer: true }),
        pollIntervalSeconds: numberOrFallback(imageComfyui.poll_interval_seconds ?? (Number(imageComfyui.pollIntervalMs) ? Number(imageComfyui.pollIntervalMs) / 1000 : ""), { minimum: 0.1, maximum: 30, fallback: 1 }),
        defaultWorkflow: clean(imageComfyui.default_workflow ?? imageComfyui.defaultWorkflow),
      },
    },
    "visual-reference-manager": { saved: Object.keys(visualReferences).length > 0 },
    "image-vision": {
      saved: Boolean(clean(visionProvider.base_url) || clean(visionProvider.model)),
      provider: { baseUrl: clean(visionProvider.base_url), model: clean(visionProvider.model) },
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
      saved: Boolean(clean(videoProvider.base_url) || clean(videoProvider.model)),
      provider: { baseUrl: clean(videoProvider.base_url), model: clean(videoProvider.model) },
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
    "voice-message": {
      saved: Object.keys(voiceMessage).length > 0 || Object.keys(voiceDesign).length > 0 || candidates.length > 0,
      voiceId: clean(voiceMessage.voiceId),
      timeoutMs: numberOrFallback(voiceMessage.timeoutMs, { minimum: 1000, maximum: 600000, fallback: 30000, integer: true }),
      candidates,
    },
    "iphone-bridge": {
      saved: Object.keys(iphoneBridge).length > 0,
      enabledSessions: companionSessions(iphoneFeedback),
    },
    "phone-camera": {
      saved: Object.keys(phoneCamera).length > 0,
      defaultBackend: choiceOrFallback(phoneCamera.default_backend, ["api", "comfyui"], "api"),
      sizeByShot: {
        rear: sizeOrFallback(phoneSizes.rear, "1536x1024"),
        selfie: sizeOrFallback(phoneSizes.selfie, "1024x1536"),
        mirror: sizeOrFallback(phoneSizes.mirror, "1024x1536"),
      },
      references: { maxImages: numberOrFallback(phoneReferences.max_images, { minimum: 1, maximum: 16, fallback: 8, integer: true }) },
      prompt: { prefix: clean(phonePrompt.prefix), suffix: clean(phonePrompt.suffix) },
    },
    "web-browser": { saved: Object.keys(browserRuntime).length > 0, runtime: { status: clean(browserRuntime.status), browser: clean(browserRuntime.browser) } },
    "proactive-contact": proactiveContactSettings(proactiveContact),
    "site-automation": {
      saved: Object.keys(siteAutomation).length > 0,
      sites: siteAutomationSettings(siteAutomation),
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
      enabledSessions: companionSessions(merchant),
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
  settingsService,
  existsCommand = commandExists,
  packaged = false,
  executablePath = "",
  openExternal = null,
  projectHooksService = null,
  onIphoneFeedbackChange = null,
} = {}) {
  if (!settingsService || typeof settingsService.load !== "function") throw new Error("能力服务需要软件设置服务。");
  const stableLauncher = () => {
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
    throw new Error("这项能力不支持会话投递设置。 ");
  };
  const companionScope = ({ sessionId, projectRoot = "" } = {}, settings = settingsService.load()) => {
    const scope = {
      sessionId: clean(sessionId),
      projectRoot: absoluteProjectRoot(projectRoot) || absoluteProjectRoot(settings?.projectRoot),
    };
    if (!companionScopeKey(scope)) throw new Error("要设置的 Claude 会话无效。 ");
    return scope;
  };
  const enabledCompanionSessions = (abilityId) => companionSessions(companionConfig(abilityId));
  const isCompanionSessionEnabled = ({ abilityId, sessionId, projectRoot } = {}) => (
    companionSessionEnabled(companionConfig(clean(abilityId)), companionScope({ sessionId, projectRoot }))
  );
  const getProactiveContactSettings = () => proactiveContactSettings(companionConfig("proactive-contact"));
  const enabledIphoneBridgeSessions = () => {
    const settings = settingsService.load();
    if (!inspectClaudeRegistration({ projectRoot: clean(settings?.projectRoot), abilityId: "iphone-bridge" }).registered) return [];
    return companionSessions(companionConfig("iphone-bridge", settings));
  };
  const notifyIphoneFeedbackChange = () => {
    if (typeof onIphoneFeedbackChange !== "function") return;
    Promise.resolve(onIphoneFeedbackChange()).catch(() => undefined);
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
        const current = inspectClaudeRegistration({ projectRoot, abilityId: capability.id });
        const added = current.registered === true;
        return {
          ...capability,
          added,
          enabled: added,
          canToggle: Boolean(projectRoot) && launcher.available === true,
          toggleReason: !projectRoot
            ? "先在“当前 Agent”中选择工作目录。"
            : !launcher.available
              ? "当前软件还没有准备好切换这项能力。"
              : "",
          savedSettings: savedSettings[capability.id] || { saved: false },
          canAdd: !added && Boolean(projectRoot) && launcher.available === true,
          addReason: added
            ? "已加入当前 Agent。"
            : !projectRoot
              ? "先在“当前 Agent”中选择工作目录。"
              : !launcher.available
                ? "当前软件还未准备好添加能力。"
                : "可以添加到当前 Agent。",
        };
      }),
    };
  };
  const registerAbility = async (abilityId) => {
    const settings = settingsService.load();
    const launcher = stableLauncher();
    const isTimeAwareness = clean(abilityId) === "time-awareness";
    if (isTimeAwareness && (!projectHooksService?.installTimeAwareness || !projectHooksService?.uninstallTimeAwareness)) {
      throw new Error("当前软件未接入时间感知 Hook 安装器。 ");
    }
    const wasRegistered = isTimeAwareness
      ? inspectClaudeRegistration({ projectRoot: clean(settings?.projectRoot), abilityId }).registered === true
      : false;
    const registration = await writeClaudeRegistration({
      projectRoot: clean(settings?.projectRoot), abilityId, launcher, toolPermissions: settings?.claudeToolPermissions,
    });
    if (isTimeAwareness) {
      try {
        await projectHooksService.installTimeAwareness();
      } catch (error) {
        if (!wasRegistered) await removeClaudeRegistration({ projectRoot: clean(settings?.projectRoot), abilityId }).catch(() => undefined);
        throw error;
      }
    }
    if (abilityId === "iphone-bridge") notifyIphoneFeedbackChange();
    return { registration, snapshot: snapshot() };
  };
  const capabilityAgentRoot = (settings) => {
    const dataRoot = capabilityDataRoot(settings);
    const agentId = clean(settings?.agentId);
    return dataRoot && agentId ? resolveAgentDataRoot({ dataRoot, agentId }) : "";
  };
  const defaultsMarker = (settings) => {
    const root = capabilityAgentRoot(settings);
    return root ? publicJson(root, ["capabilities", "defaults-v1.json"]) : {};
  };
  const initializeDefaults = async () => {
    const settings = settingsService.load();
    const launcher = stableLauncher();
    const projectRoot = clean(settings?.projectRoot);
    const agentRoot = capabilityAgentRoot(settings);
    if (!projectRoot || !agentRoot || launcher.available !== true) return { initialized: false, errors: [], snapshot: snapshot() };
    const marker = defaultsMarker(settings);
    if (marker.initialized === true) return { initialized: false, errors: [], snapshot: snapshot() };
    const errors = [];
    for (const capability of claudeAgentAbilityCatalog()) {
      if (inspectClaudeRegistration({ projectRoot, abilityId: capability.id }).registered === true) continue;
      try { await registerAbility(capability.id); }
      catch (error) { errors.push({ id: capability.id, code: clean(error?.code), message: clean(error?.message) || "无法默认开启。" }); }
    }
    // 用户已有的同名 Skill 不会被覆盖；只在其他可恢复错误存在时重试初始化。
    const retryNeeded = errors.some((error) => error.code !== "skill-conflict");
    await writeJsonBelow(agentRoot, ["capabilities", "defaults-v1.json"], {
      version: 2,
      initialized: !retryNeeded,
      initializedAt: new Date().toISOString(),
      unresolved: errors.map(({ id, code }) => ({ id, code })),
    });
    return { initialized: true, errors, snapshot: snapshot() };
  };
  const saveSettings = async ({ id, value } = {}) => {
    const capabilityId = clean(id);
    const input = plainObject(value);
    const settings = settingsService.load();
    const dataRoot = capabilityDataRoot(settings);
    if (!dataRoot) throw new Error("无法定位 Suzu Lives 软件数据目录。 ");
    if (capabilityId === "image-generation") {
      const agentRoot = capabilityAgentRoot(settings);
      if (!agentRoot) throw new Error("请先选择当前 Agent 的工作目录。 ");
      const existing = publicJson(agentRoot, ["image-generation", "config.json"]);
      const comfyui = plainObject(existing.comfyui);
      await writeJsonBelow(agentRoot, ["image-generation", "config.json"], {
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
      const agentRoot = capabilityAgentRoot(settings);
      if (!agentRoot) throw new Error("请先选择当前 Agent 的工作目录。 ");
      const existing = publicJson(agentRoot, ["phone-camera", "config.json"]);
      const prompt = plainObject(existing.prompt);
      const sizes = plainObject(existing.size_by_shot);
      const references = plainObject(existing.references);
      await writeJsonBelow(agentRoot, ["phone-camera", "config.json"], {
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
      const existing = publicJson(dataRoot, ["capabilities", "voice-message", "config.json"]);
      await writeJsonBelow(dataRoot, ["capabilities", "voice-message", "config.json"], {
        ...existing,
        voiceId: boundedText(input.voiceId, "音色", 200),
        timeoutMs: boundedNumber(input.timeoutMs, "语音发送等待时间", { minimum: 1000, maximum: 600000, fallback: 30000, integer: true }),
      });
      return snapshot();
    }
    if (capabilityId === "iphone-bridge") {
      if (!Object.hasOwn(input, "sessionId") && !Object.hasOwn(input, "sessionEnabled")) {
        throw new Error("iPhone 互通目前只需要设置投递会话。 ");
      }
      if (!Object.hasOwn(input, "sessionEnabled")) throw new Error("会话开关状态无效。 ");
      const scope = companionScope({ sessionId: input.sessionId }, settings);
      const existing = companionConfig("iphone-bridge", settings);
      await writeJsonBelow(dataRoot, ["automation", "iphone-bridge", "config.json"], {
        ...existing,
        enabledSessions: withCompanionSession(existing, scope, boundedBoolean(input.sessionEnabled, false)),
      });
      notifyIphoneFeedbackChange();
      return snapshot();
    }
    if (capabilityId === "site-automation") {
      const agentRoot = capabilityAgentRoot(settings);
      if (!agentRoot) throw new Error("请先选择当前 Agent 的工作目录。 ");
      const existing = publicJson(agentRoot, ["site-automation", "config.json"]);
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
        await writeJsonBelow(agentRoot, ["site-automation", "config.json"], {
          ...existing,
          sites: { ...sites, [site.id]: nextSite },
        });
        return snapshot();
      }
      await writeJsonBelow(agentRoot, ["site-automation", "config.json"], {
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
      if (Object.hasOwn(input, "sessionId") || Object.hasOwn(input, "sessionEnabled")) {
        if (!Object.hasOwn(input, "sessionEnabled")) throw new Error("会话开关状态无效。 ");
        const scope = companionScope({ sessionId: input.sessionId }, settings);
        await writeJsonBelow(dataRoot, ["automation", "proactive-contact", "config.json"], {
          ...existing,
          chainPrompt: current.chainPrompt,
          followUpPrompt: current.followUpPrompt,
          enabledSessions: withCompanionSession(existing, scope, boundedBoolean(input.sessionEnabled, false)),
        });
        return snapshot();
      }
      await writeJsonBelow(dataRoot, ["automation", "proactive-contact", "config.json"], {
        ...existing,
        chainPrompt: boundedText(input.chainPrompt || current.chainPrompt, "链式主动关心提示词", 12000),
        followUpPrompt: boundedText(input.followUpPrompt || current.followUpPrompt, "临时回访提示词", 12000),
        enabledSessions: current.enabledSessions,
      });
      return snapshot();
    }
    if (capabilityId === "traveling-merchant") {
      const existing = publicJson(dataRoot, ["automation", "traveling-merchant", "config.json"]);
      const defaults = travelingMerchantDefaultConfig();
      if (Object.hasOwn(input, "sessionId") || Object.hasOwn(input, "sessionEnabled")) {
        if (!Object.hasOwn(input, "sessionEnabled")) throw new Error("会话开关状态无效。 ");
        const scope = companionScope({ sessionId: input.sessionId }, settings);
        await writeJsonBelow(dataRoot, ["automation", "traveling-merchant", "config.json"], {
          ...defaults,
          ...existing,
          enabledSessions: withCompanionSession(existing, scope, boundedBoolean(input.sessionEnabled, false)),
        });
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
        enabledSessions: companionSessions(existing),
      });
      return snapshot();
    }
    throw new Error("这项能力目前没有可保存的设置。 ");
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
    initializeDefaults,
    saveSettings,
    proactiveContactSettings: getProactiveContactSettings,
    enabledCompanionSessions,
    isCompanionSessionEnabled,
    enabledIphoneBridgeSessions,
    openTravelingMerchantPage,
    register: async (abilityId) => registerAbility(abilityId),
    setActive: async ({ id, enabled } = {}) => {
      if (typeof enabled !== "boolean") throw new Error("能力开关状态无效。 ");
      if (enabled) return { ...(await registerAbility(id)), enabled: true };
      const settings = settingsService.load();
      const isTimeAwareness = clean(id) === "time-awareness";
      if (isTimeAwareness && (!projectHooksService?.installTimeAwareness || !projectHooksService?.uninstallTimeAwareness)) {
        throw new Error("当前软件未接入时间感知 Hook 安装器。 ");
      }
      const timeHookWasInstalled = isTimeAwareness && projectHooksService.inspectTimeAwareness
        ? (await projectHooksService.inspectTimeAwareness()).installed === true
        : false;
      if (isTimeAwareness) await projectHooksService.uninstallTimeAwareness();
      let removed;
      try {
        removed = await removeClaudeRegistration({ projectRoot: clean(settings?.projectRoot), abilityId: id });
      } catch (error) {
        if (isTimeAwareness && timeHookWasInstalled) await projectHooksService.installTimeAwareness().catch(() => undefined);
        throw error;
      }
      if (clean(id) === "iphone-bridge") notifyIphoneFeedbackChange();
      return { removed, enabled: false, snapshot: snapshot() };
    },
    enable: (abilityId) => {
      const settings = settingsService.load();
      const dataRoot = capabilityDataRoot(settings);
      if (!dataRoot) throw new Error("无法定位 Suzu Lives 软件数据目录，因此没有启用能力。");
      setCapabilityEnabled({ id: abilityId, dataRoot, enabled: true });
      return snapshot();
    },
    issueAuthorization: (value = {}) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("能力授权请求必须是对象。 ");
      const settings = settingsService.load();
      const dataRoot = capabilityDataRoot(settings);
      if (!dataRoot) throw new Error("无法定位 Suzu Lives 软件数据目录，因此不会签发能力授权。 ");
      return issueCapabilityInvocationAuthorization({
        id: value.id,
        request: value.request,
        dataRoot,
        ttlMs: value.ttlMs,
      });
    },
  };
}

export function registerCapabilitiesIpc({ ipcMain, capabilitiesService }) {
  ipcMain.handle("capabilities:snapshot", () => capabilitiesService.snapshot());
  ipcMain.handle("capabilities:initialize-defaults", () => capabilityIpcResult(() => capabilitiesService.initializeDefaults()));
  ipcMain.handle("capabilities:save-settings", (_event, value) => capabilityIpcResult(() => capabilitiesService.saveSettings(value)));
  ipcMain.handle("capabilities:open-traveling-merchant-page", () => capabilityIpcResult(() => capabilitiesService.openTravelingMerchantPage()));
  // Electron 只会向渲染层返回 IPC handler 的消息，因此同时返回稳定错误码。
  ipcMain.handle("capabilities:register", (_event, abilityId) => capabilityIpcResult(() => capabilitiesService.register(abilityId)));
  ipcMain.handle("capabilities:set-active", (_event, value) => capabilityIpcResult(() => capabilitiesService.setActive(value)));
  ipcMain.handle("capabilities:enable", (_event, abilityId) => capabilitiesService.enable(abilityId));
  // No renderer/preload method exposes this yet. A future management UI must
  // call this only after recording an explicit user confirmation.
  ipcMain.handle("capabilities:issue-authorization", (_event, value) => capabilitiesService.issueAuthorization(value));
}
