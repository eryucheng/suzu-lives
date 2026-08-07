import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { executeSiteAutomation, executeWebBrowser, planSiteAutomation, resolveDedicatedBrowserRuntime, SITE_ACTION_REGISTRY } from "@suzu-lives/browser-automation";
import { CapabilityExecutionError, consumeCapabilityAuthorization, issueCapabilityAuthorization } from "@suzu-lives/capability-runtime";
import { executeComputerCameraCapture, executeComputerCameraSession, executeIphoneBridgeMessage, planComputerCameraCapture, planIphoneBridgeMessage } from "@suzu-lives/device-bridge";
import { createImageVisionPlan, createVideoUnderstandingPlan, executeImageVision, executeVideoUnderstanding } from "@suzu-lives/media-understanding";
import { executeVoiceMessage, planVoiceMessage } from "@suzu-lives/voice-message";

export class CapabilityRegistryError extends Error {}

const PARTIAL_EXECUTOR = "partial-executor";
const DEFERRED = "deferred";
const SENSITIVE_CONFIGURATION_KEY = /(token|key|secret|password|令牌|密钥|密码)/iu;

function definition(value) {
  return Object.freeze({
    claudeRegistration: true,
    migration: PARTIAL_EXECUTOR,
    executorAttached: true,
    ...value,
    dependencyTypes: Object.freeze([...value.dependencyTypes]),
    configuration: Object.freeze(value.configuration.map((item) => Object.freeze({ ...item }))),
  });
}

export const CAPABILITY_DEFINITIONS = Object.freeze([
  definition({
    id: "computer-camera",
    name: "电脑摄像头",
    description: "通过 Suzu Lives 自有 OpenCV 会话 worker 预热、持续持有、拍摄和确认关闭，并仅把照片与状态写入软件数据目录。",
    packageName: "@suzu-lives/device-bridge",
    dependencyTypes: ["设备", "本地运行时", "权限"],
    configuration: [
      { key: "camera", kind: "device", label: "Suzu Lives 配置的 Python 与 OpenCV 摄像头运行时" },
      { key: "consent", kind: "authorization", label: "每次开启、拍摄或关闭前的单次软件授权", runtimeOnly: true },
    ],
  }),
  definition({
    id: "iphone-bridge",
    name: "iPhone 互通",
    description: "保留未来软件拥有的 iPhone bridge adapter 边界；旧 IMAP/Webhook 协议尚无可发布的安全替代实现。",
    packageName: "@suzu-lives/device-bridge",
    dependencyTypes: ["设备", "受控入站适配器", "权限"],
    configuration: [
      { key: "bridge-protocol", kind: "bridge", label: "已验证的软件 iPhone 入站协议（当前未接入）" },
      { key: "consent", kind: "authorization", label: "每次设备消息操作的单次软件授权", runtimeOnly: true },
    ],
  }),
  definition({
    id: "image-vision",
    name: "图像理解",
    description: "保留 OpenAI-compatible 图像理解请求和软件内结果记录；凭据尚未接入既有安全连接层。",
    packageName: "@suzu-lives/media-understanding",
    dependencyTypes: ["模型连接", "安全凭据来源", "数据访问授权"],
    configuration: [
      { key: "vision-provider", kind: "provider", label: "视觉模型地址与模型名" },
      { key: "secure-credential", kind: "credential", label: "软件管理的安全模型凭据来源（当前未接入）" },
      { key: "image-consent", kind: "authorization", label: "每次图片访问范围的单次软件授权", runtimeOnly: true },
    ],
  }),
  definition({
    id: "video-understanding",
    name: "视频理解",
    description: "保留 FFmpeg/FFprobe 片段准备和 OpenAI-compatible 视频协议；凭据尚未接入既有安全连接层。",
    packageName: "@suzu-lives/media-understanding",
    dependencyTypes: ["模型连接", "安全凭据来源", "本地工具", "数据访问授权"],
    configuration: [
      { key: "video-provider", kind: "provider", label: "视频模型地址与模型名" },
      { key: "ffmpeg", kind: "tool", label: "软件配置的 FFmpeg 与 FFprobe" },
      { key: "secure-credential", kind: "credential", label: "软件管理的安全模型凭据来源（当前未接入）" },
      { key: "video-consent", kind: "authorization", label: "每次视频访问范围的单次软件授权", runtimeOnly: true },
    ],
  }),
  definition({
    id: "voice-message",
    name: "语音消息",
    description: "通过软件管理的声音连接生成 MP3，并由当前 Suzu 会话附件链显示和投递。",
    packageName: "@suzu-lives/voice-message",
    dependencyTypes: ["模型连接", "当前会话附件链"],
    configuration: [
      { key: "tts", kind: "provider", label: "TTS 地址、模型与音色" },
      { key: "secure-credential", kind: "credential", label: "软件管理的安全 TTS 凭据来源（当前未接入）" },
      { key: "conversation", kind: "session", label: "当前 Suzu 会话附件交付入口", runtimeOnly: true },
    ],
  }),
  definition({
    id: "web-browser",
    name: "已登录网页浏览",
    description: "启动并验证 Suzu Lives 自有 Chrome profile 的本机 CDP endpoint；登录只由用户手动完成。",
    packageName: "@suzu-lives/browser-automation",
    dependencyTypes: ["浏览器", "登录状态", "权限"],
    configuration: [
      { key: "chrome", kind: "tool", label: "用户选择的专用 Chrome 可执行文件与本机调试端口" },
      { key: "login", kind: "authorization", label: "用户在专用 profile 中手动登录所需站点", runtimeOnly: true },
    ],
  }),
  definition({
    id: "site-automation",
    name: "站点自动化",
    description: "仅能调用 Suzu Lives 站点动作注册表中明确允许的只读动作，并只连接软件已验证的本机 CDP endpoint。",
    packageName: "@suzu-lives/browser-automation",
    dependencyTypes: ["软件自有浏览器", "站点授权", "权限"],
    configuration: [
      { key: "site", kind: "authorization", label: "用户手动登录后登记并授权的站点" },
      { key: "action-consent", kind: "authorization", label: "每次只读站点操作的单次软件授权", runtimeOnly: true },
    ],
  }),
  definition({
    id: "phone-camera",
    name: "手机拍照式生图",
    description: "依赖图像生成和视觉参考库；当前标准能力页暂不提供独立执行器。",
    packageName: "",
    migration: DEFERRED,
    claudeRegistration: false,
    executorAttached: false,
    dependencyTypes: ["图像生成", "视觉参考"],
    configuration: [
      { key: "image-engine", kind: "provider", label: "图像生成引擎" },
      { key: "references", kind: "data", label: "视觉参考库" },
    ],
  }),
  definition({
    id: "image-generation",
    name: "图像生成",
    description: "图像生成由创作工作台和 Agent 专用接口提供；当前标准能力页暂不提供独立执行器。",
    packageName: "",
    migration: DEFERRED,
    claudeRegistration: false,
    executorAttached: false,
    dependencyTypes: ["图像模型", "工作流"],
    configuration: [
      { key: "image-provider", kind: "provider", label: "图像模型或已登记工作流" },
    ],
  }),
]);

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype ? value : {};
}

function hasText(value) {
  return Boolean(clean(value));
}

function hasHttpUrl(value) {
  try {
    const parsed = new URL(clean(value));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function dataRoot(value) {
  const root = clean(value);
  if (!root) throw new CapabilityRegistryError("缺少 Suzu Lives 软件数据目录。 ");
  return path.resolve(root);
}

function registryPath(root) {
  return path.join(dataRoot(root), "capabilities", "registry.json");
}

function boundedString(value, label, maximum = 500) {
  const text = clean(value);
  if (!text || text.length > maximum) throw new CapabilityRegistryError(`${label}不能为空，且最多 ${maximum} 个字符。`);
  return text;
}

function positivePort(value, label = "浏览器调试端口") {
  const port = value === undefined || value === null || value === "" ? 9222 : Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new CapabilityRegistryError(`${label}必须在 1024 到 65535 之间。`);
  return port;
}

function assertNoSensitiveConfigurationFields(value, location = "configuration") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveConfigurationFields(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_CONFIGURATION_KEY.test(key)) {
      throw new CapabilityRegistryError(`${location}.${key} 不能保存或声明 token/key/secret/password 类字段；请使用软件既有安全连接层。`);
    }
    assertNoSensitiveConfigurationFields(item, `${location}.${key}`);
  }
}

function assertKnownKeys(value, allowed, location) {
  const source = plainObject(value);
  if (source !== value || Array.isArray(value)) throw new CapabilityRegistryError(`${location}必须是 JSON 对象。`);
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) throw new CapabilityRegistryError(`${location}.${key} 不是该能力允许的配置字段。`);
  }
  return source;
}

function normalizedProvider(value, label) {
  const source = assertKnownKeys(value, ["baseUrl", "model"], label);
  const baseUrl = boundedString(source.baseUrl, `${label}.baseUrl`, 2_000);
  if (!hasHttpUrl(baseUrl)) throw new CapabilityRegistryError(`${label}.baseUrl 必须是 http 或 https 地址。`);
  return { baseUrl: baseUrl.replace(/\/+$/u, ""), model: boundedString(source.model, `${label}.model`, 200) };
}

/**
 * A capability record is a deliberately small, per-ability whitelist. The
 * return value is also the only shape allowed to reach registry.json.
 */
export function normalizeCapabilityConfiguration(id, value) {
  const capability = getCapabilityDefinition(id);
  if (!capability || capability.migration === DEFERRED) throw new CapabilityRegistryError("该能力尚未接入软件执行器。 ");
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new CapabilityRegistryError("能力配置必须是 JSON 对象。 ");
  }
  assertNoSensitiveConfigurationFields(value);
  switch (capability.id) {
    case "computer-camera": {
      const source = assertKnownKeys(value, ["pythonCommand"], "computer-camera 配置");
      return { pythonCommand: boundedString(source.pythonCommand, "pythonCommand") };
    }
    case "iphone-bridge":
      assertKnownKeys(value, [], "iphone-bridge 配置");
      return {};
    case "image-vision": {
      const source = assertKnownKeys(value, ["provider"], "image-vision 配置");
      return { provider: normalizedProvider(source.provider, "provider") };
    }
    case "video-understanding": {
      const source = assertKnownKeys(value, ["provider", "ffmpegPath", "ffprobePath"], "video-understanding 配置");
      return {
        provider: normalizedProvider(source.provider, "provider"),
        ffmpegPath: boundedString(source.ffmpegPath, "ffmpegPath"),
        ffprobePath: boundedString(source.ffprobePath, "ffprobePath"),
      };
    }
    case "voice-message": {
      const source = assertKnownKeys(value, ["tts"], "voice-message 配置");
      const ttsSource = assertKnownKeys(source.tts, ["baseUrl", "model", "voice"], "tts");
      const baseUrl = boundedString(ttsSource.baseUrl, "tts.baseUrl", 2_000);
      if (!hasHttpUrl(baseUrl)) throw new CapabilityRegistryError("tts.baseUrl 必须是 http 或 https 地址。 ");
      return {
        tts: {
          baseUrl: baseUrl.replace(/\/+$/u, ""),
          model: boundedString(ttsSource.model, "tts.model", 200),
          voice: boundedString(ttsSource.voice, "tts.voice", 200),
        },
      };
    }
    case "web-browser": {
      const source = assertKnownKeys(value, ["executablePath", "debugPort"], "web-browser 配置");
      return { executablePath: boundedString(source.executablePath, "executablePath", 2_000), debugPort: positivePort(source.debugPort) };
    }
    case "site-automation": {
      const source = assertKnownKeys(value, ["siteId", "siteAuthorized"], "site-automation 配置");
      if (clean(source.siteId).toLowerCase() !== "douyin") throw new CapabilityRegistryError("siteId 当前只能是已登记的 douyin。 ");
      if (source.siteAuthorized !== true) throw new CapabilityRegistryError("siteAuthorized 必须由用户明确确认。 ");
      return { siteId: "douyin", siteAuthorized: true };
    }
    default:
      throw new CapabilityRegistryError("该能力没有可保存的软件配置。 ");
  }
}

function safeStoredConfiguration(id, value) {
  try {
    return { valid: true, configuration: normalizeCapabilityConfiguration(id, value) };
  } catch {
    return { valid: false, configuration: {} };
  }
}

function configurationCheck(abilityId, configuration) {
  const config = plainObject(configuration);
  switch (abilityId) {
    case "computer-camera":
      return { camera: hasText(config.pythonCommand) };
    case "iphone-bridge":
      return { "bridge-protocol": false };
    case "image-vision":
      return { "vision-provider": hasHttpUrl(plainObject(config.provider).baseUrl) && hasText(plainObject(config.provider).model), "secure-credential": false };
    case "video-understanding":
      return {
        "video-provider": hasHttpUrl(plainObject(config.provider).baseUrl) && hasText(plainObject(config.provider).model),
        ffmpeg: hasText(config.ffmpegPath) && hasText(config.ffprobePath),
        "secure-credential": false,
      };
    case "voice-message": {
      const tts = plainObject(config.tts);
      return {
        tts: hasHttpUrl(tts.baseUrl) && hasText(tts.model) && hasText(tts.voice),
        conversation: false,
        "secure-credential": false,
      };
    }
    case "web-browser":
      return { chrome: hasText(config.executablePath) && Number.isInteger(config.debugPort) };
    case "site-automation":
      return { site: clean(config.siteId).toLowerCase() === "douyin" && config.siteAuthorized === true };
    default:
      return {};
  }
}

function safeLauncher(value = {}) {
  const command = clean(value.command || "suzu-lives");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(command)) {
    return { command: "suzu-lives", available: false, reason: "稳定启动命令格式无效。" };
  }
  return { command, available: value.available === true, reason: clean(value.reason) };
}

function configurationState(definitionValue, configuration = {}) {
  const checks = configurationCheck(definitionValue.id, configuration);
  const requirements = definitionValue.configuration.map((item) => {
    const runtimeOnly = item.runtimeOnly === true;
    return { ...item, configured: runtimeOnly ? true : checks[item.key] === true, runtimeOnly };
  });
  const missing = requirements.filter((item) => !item.runtimeOnly && !item.configured).map((item) => ({ key: item.key, kind: item.kind, label: item.label }));
  return {
    configured: missing.length === 0,
    missing,
    runtimeRequirements: requirements.filter((item) => item.runtimeOnly).map((item) => ({ key: item.key, kind: item.kind, label: item.label })),
    requirements,
  };
}

function registrationState(definitionValue, { launcher, projectRoot }) {
  if (!definitionValue.claudeRegistration || !definitionValue.executorAttached || definitionValue.migration === DEFERRED) {
    return { supported: false, canRegister: false, reason: "该能力尚未接入可注册的软件执行器。" };
  }
  if (!clean(projectRoot)) return { supported: true, canRegister: false, reason: "请先在 Suzu Lives 中选择 Claude 项目目录。" };
  if (!launcher.available) return { supported: true, canRegister: false, reason: launcher.reason || `未找到稳定启动命令 ${launcher.command}。` };
  return { supported: true, canRegister: true, reason: "可在用户确认后写入轻量 Claude 注册文件；实际调用仍受状态和单次授权限制。" };
}

function normalizeRegistry(value) {
  const source = plainObject(value);
  const sourceAbilities = plainObject(source.abilities);
  const abilities = {};
  for (const definitionValue of CAPABILITY_DEFINITIONS) {
    const raw = plainObject(sourceAbilities[definitionValue.id]);
    const normalized = safeStoredConfiguration(definitionValue.id, raw.configuration);
    abilities[definitionValue.id] = {
      enabled: normalized.valid && raw.enabled === true,
      configuration: normalized.configuration,
    };
  }
  return { version: 2, abilities };
}

function readRegistry(root) {
  try {
    return normalizeRegistry(JSON.parse(fs.readFileSync(registryPath(root), "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return normalizeRegistry({});
    throw new CapabilityRegistryError("无法读取 Suzu Lives 能力注册状态。 ");
  }
}

function writeRegistry(root, value) {
  const destination = registryPath(root);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(normalizeRegistry(value), null, 2)}\n`, "utf8");
  fs.renameSync(temporary, destination);
}

export function getCapabilityDefinition(id) {
  const normalized = clean(id).toLowerCase();
  return CAPABILITY_DEFINITIONS.find((item) => item.id === normalized) || null;
}

export function createCapabilityStateStore({ dataRoot: root } = {}) {
  const resolvedRoot = dataRoot(root);
  return {
    path: registryPath(resolvedRoot),
    read: () => readRegistry(resolvedRoot),
    get: (id) => {
      const capability = getCapabilityDefinition(id);
      if (!capability) throw new CapabilityRegistryError("未找到该 Suzu Lives 能力。 ");
      return readRegistry(resolvedRoot).abilities[capability.id];
    },
    configure: (id, configuration) => {
      const capability = getCapabilityDefinition(id);
      if (!capability || capability.migration === DEFERRED) throw new CapabilityRegistryError("该能力尚未接入软件执行器。 ");
      const normalized = normalizeCapabilityConfiguration(capability.id, configuration);
      const next = readRegistry(resolvedRoot);
      next.abilities[capability.id].configuration = normalized;
      next.abilities[capability.id].enabled = false;
      writeRegistry(resolvedRoot, next);
      return next.abilities[capability.id];
    },
    setEnabled: (id, enabled) => {
      const capability = getCapabilityDefinition(id);
      if (!capability || capability.migration === DEFERRED || !capability.executorAttached) throw new CapabilityRegistryError("该能力尚未接入可启用的软件执行器。 ");
      const next = readRegistry(resolvedRoot);
      const record = next.abilities[capability.id];
      if (enabled === true) {
        const state = configurationState(capability, record.configuration);
        if (!state.configured) throw new CapabilityRegistryError(`无法启用 ${capability.name}：尚缺 ${state.missing.map((item) => item.label).join("、")}。`);
      }
      record.enabled = enabled === true;
      writeRegistry(resolvedRoot, next);
      return record;
    },
  };
}

export function createCapabilitySnapshot({ projectRoot = "", launcher = {}, dataRoot: root = "", stateStore } = {}) {
  const resolvedLauncher = safeLauncher(launcher);
  let stored = {};
  if (stateStore) stored = stateStore.read().abilities;
  else if (clean(root)) stored = readRegistry(root).abilities;
  return CAPABILITY_DEFINITIONS.map((item) => {
    const record = plainObject(stored[item.id]);
    const configuration = configurationState(item, record.configuration);
    const registration = registrationState(item, { launcher: resolvedLauncher, projectRoot });
    const toggledOn = item.executorAttached === true && record.enabled === true;
    const enabled = toggledOn && configuration.configured;
    const enableState = !item.executorAttached
      ? "not-migrated"
      : !configuration.configured
        ? "not-configured"
        : toggledOn
          ? "enabled-awaiting-dependency-check"
          : "disabled";
    const enableReason = !item.executorAttached
      ? "该能力尚未接入软件执行器，因此不能启用。"
      : !configuration.configured
        ? `尚缺 ${configuration.missing.map((itemValue) => itemValue.label).join("、")}。`
        : toggledOn
          ? "已启用；每次调用仍会先检查本机依赖、受控授权和单次凭证。"
          : "已完成静态配置，但尚未由用户启用。";
    return {
      id: item.id,
      name: item.name,
      description: item.description,
      packageName: item.packageName,
      dependencyTypes: [...item.dependencyTypes],
      dependencies: {
        state: enabled ? "checked-at-invoke" : "not-checked",
        label: enabled ? "将在实际调用前检查" : "能力未启用，尚未检查",
      },
      configuration: {
        state: configuration.configured ? "configured" : "not-configured",
        requirements: configuration.requirements,
        missing: configuration.missing,
        runtimeRequirements: configuration.runtimeRequirements,
      },
      migration: {
        state: item.migration,
        label: item.migration === PARTIAL_EXECUTOR ? "部分接入受控执行器；尚未完成真实 E2E 验证" : "尚未接入软件执行器",
      },
      enabled,
      enableState,
      enableReason,
      registration,
    };
  });
}

function invocationRecord({ id, dataRoot: root, stateStore }) {
  const capability = getCapabilityDefinition(id);
  if (!capability) throw new CapabilityRegistryError("未找到该 Suzu Lives 能力。 ");
  if (capability.migration === DEFERRED || !capability.executorAttached) throw new CapabilityRegistryError("该能力尚未接入可调用的软件执行器。 ");
  const store = stateStore || createCapabilityStateStore({ dataRoot: root });
  const record = store.get(capability.id);
  const configuration = configurationState(capability, record.configuration);
  if (record.enabled !== true) {
    throw new CapabilityExecutionError("CAPABILITY_DISABLED", `${capability.name}未启用，已拒绝调用。`, { abilityId: capability.id });
  }
  if (!configuration.configured) {
    throw new CapabilityExecutionError("CAPABILITY_NOT_CONFIGURED", `${capability.name}尚未完成 Suzu Lives 配置，已拒绝调用。`, { abilityId: capability.id, missing: configuration.missing.map((item) => item.key) });
  }
  return { capability, record, gate: { enabled: true, configured: true }, store };
}

function requestObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new CapabilityRegistryError("调用请求必须是 JSON 对象。 ");
  }
  if (Object.hasOwn(value, "authorize")) {
    throw new CapabilityExecutionError("AUTHORIZATION_CREDENTIAL_REQUIRED", "不接受裸 authorize；实际调用需要 Suzu Lives 签发的一次性授权凭证。 ");
  }
  return value;
}

function boundedRequestText(value, label, maximum) {
  const text = clean(value);
  if (!text || text.length > maximum) throw new CapabilityRegistryError(`${label}不能为空，且最多 ${maximum} 个字符。`);
  return text;
}

function boundedNumber(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER, fallback = 0, integer = false } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum || (integer && !Number.isInteger(number))) {
    throw new CapabilityRegistryError(`${label}必须在 ${minimum} 到 ${maximum} 之间。`);
  }
  return number;
}

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("base64url");
}

function normalizedSiteOptions(action, value) {
  const source = value === undefined ? {} : plainObject(value);
  if (source !== value && value !== undefined) throw new CapabilityRegistryError("站点动作选项必须是 JSON 对象。 ");
  if (action === "read-comments") {
    for (const key of Object.keys(source)) if (key !== "limit") throw new CapabilityRegistryError(`read-comments 不接受选项 ${key}。`);
    return { limit: boundedNumber(source.limit, "评论数量", { minimum: 1, maximum: 50, fallback: 20, integer: true }) };
  }
  if (Object.keys(source).length > 0) throw new CapabilityRegistryError(`${action} 不接受额外站点选项。`);
  return {};
}

/** Creates one canonical action/scope before issue or invoke. */
export function resolveCapabilityInvocationIntent({ id, request = {}, configuration = {} } = {}) {
  const capability = getCapabilityDefinition(id);
  if (!capability || capability.migration === DEFERRED || !capability.executorAttached) throw new CapabilityRegistryError("该能力尚未接入可调用的软件执行器。 ");
  const source = requestObject(request);
  switch (capability.id) {
    case "computer-camera": {
      const operation = clean(source.operation || "capture").toLowerCase();
      const actions = { start: "start-session", capture: "capture", close: "close-session", status: "read-status" };
      if (!Object.hasOwn(actions, operation)) throw new CapabilityRegistryError("电脑摄像头操作只能是 start、capture、close 或 status。 ");
      const cameraIndex = boundedNumber(source.cameraIndex, "摄像头编号", { minimum: 0, maximum: 32, fallback: 0, integer: true });
      const scope = { cameraIndex, operation };
      if (operation === "start") scope.warmupSeconds = boundedNumber(source.warmupSeconds, "摄像头预热时间", { minimum: 0, maximum: 30, fallback: 0.8 });
      return { abilityId: capability.id, action: actions[operation], scope, request: { ...source, operation, cameraIndex } };
    }
    case "iphone-bridge": {
      const operation = clean(source.operation || "send").toLowerCase();
      if (operation !== "send") throw new CapabilityRegistryError("iPhone bridge 当前只定义 send 请求；受控入站适配器尚未接入。 ");
      const topic = boundedRequestText(source.topic, "主题", 120);
      const content = boundedRequestText(source.content, "内容", 4_000);
      return { abilityId: capability.id, action: "send-message", scope: { topicDigest: digest(topic), contentDigest: digest(content) }, request: { ...source, operation, topic, content } };
    }
    case "image-vision": {
      const imagePath = boundedRequestText(source.imagePath, "图片路径", 4_000);
      const question = boundedRequestText(source.question || "请客观说明图片中能直接看到的主要内容。", "问题", 2_000);
      const detail = clean(source.detail || "auto").toLowerCase();
      if (!new Set(["auto", "low", "high"]).has(detail)) throw new CapabilityRegistryError("图片细节级别只能是 auto、low 或 high。 ");
      return { abilityId: capability.id, action: "analyze-image", scope: { imageDigest: digest(path.resolve(imagePath)), questionDigest: digest(question), detail }, request: { ...source, imagePath, question, detail } };
    }
    case "video-understanding": {
      const video = boundedRequestText(source.video, "视频路径或 URL", 4_000);
      const question = boundedRequestText(source.question || "请概括这个片段实际发生了什么。", "问题", 2_000);
      const startSeconds = boundedNumber(source.startSeconds, "开始秒数", { minimum: 0, maximum: 86_400, fallback: 0 });
      const endSeconds = boundedNumber(source.endSeconds, "结束秒数", { minimum: 0, maximum: 86_400, fallback: 0 });
      if (endSeconds && endSeconds <= startSeconds) throw new CapabilityRegistryError("结束秒数必须大于开始秒数。 ");
      const fps = boundedNumber(source.fps, "采样帧率", { minimum: 0.1, maximum: 10, fallback: 1 });
      return { abilityId: capability.id, action: "analyze-video", scope: { videoDigest: digest(video), questionDigest: digest(question), startSeconds, endSeconds: endSeconds || null, fps }, request: { ...source, video, question, startSeconds, endSeconds, fps } };
    }
    case "voice-message": {
      const text = boundedRequestText(source.text, "语音文本", 300);
      const mode = clean(source.mode || "file").toLowerCase();
      if (!new Set(["file", "native"]).has(mode)) throw new CapabilityRegistryError("语音发送模式只能是 file 或 native。 ");
      return { abilityId: capability.id, action: "deliver-voice", scope: { textDigest: digest(text), mode }, request: { ...source, text, mode } };
    }
    case "web-browser": {
      const operation = clean(source.operation || "start").toLowerCase();
      if (operation !== "start") throw new CapabilityRegistryError("web-browser 当前只支持 start 操作。 ");
      const debugPort = positivePort(plainObject(configuration).debugPort);
      return { abilityId: capability.id, action: "start-browser", scope: { debugPort }, request: { ...source, operation } };
    }
    case "site-automation": {
      const siteId = clean(source.siteId || "douyin").toLowerCase();
      const action = clean(source.action || "status").toLowerCase();
      const definitionValue = SITE_ACTION_REGISTRY[siteId]?.[action];
      if (!definitionValue || definitionValue.allowInvoke !== true || definitionValue.risk !== "low") {
        throw new CapabilityExecutionError("SITE_ACTION_NOT_ALLOWED", `Suzu Lives 未登记可调用的低风险站点动作 ${siteId}/${action}，已拒绝授权。`, { siteId, action });
      }
      const options = normalizedSiteOptions(action, source.options);
      return { abilityId: capability.id, action: `site:${action}`, scope: { siteId, action, optionsDigest: digest(JSON.stringify(options)) }, request: { ...source, siteId, action, options } };
    }
    default:
      throw new CapabilityRegistryError("该能力没有可调用的软件执行器。 ");
  }
}

/** Explicitly non-executing inspection/planning mode. */
export function invokeCapabilityPlan({ id, request = {}, dataRoot: root } = {}) {
  const capability = getCapabilityDefinition(id);
  if (!capability) throw new CapabilityRegistryError("未找到该 Suzu Lives 能力。 ");
  if (capability.migration === DEFERRED) throw new CapabilityRegistryError("该能力尚未接入可调用的软件执行器。 ");
  switch (capability.id) {
    case "computer-camera": return planComputerCameraCapture({ dataRoot: root, ...plainObject(request) });
    case "iphone-bridge": return planIphoneBridgeMessage({ dataRoot: root, ...plainObject(request) });
    case "image-vision": return createImageVisionPlan({ dataRoot: root, ...plainObject(request) });
    case "video-understanding": return createVideoUnderstandingPlan({ dataRoot: root, ...plainObject(request) });
    case "voice-message": return planVoiceMessage({ dataRoot: root, ...plainObject(request) });
    case "web-browser": return { status: "requires-browser-configuration", ...resolveDedicatedBrowserRuntime({ dataRoot: root, debugPort: plainObject(request).debugPort }), nextRequirement: "需要用户在 Suzu Lives 中配置专用浏览器并手动完成登录。" };
    case "site-automation": return planSiteAutomation({ dataRoot: root, siteId: plainObject(request).siteId || "douyin", action: plainObject(request).action || "status", options: plainObject(request).options });
    default: throw new CapabilityRegistryError("该能力没有可调用的软件执行器。 ");
  }
}

/** The desktop IPC boundary uses this after an explicit user confirmation. */
export function issueCapabilityInvocationAuthorization({ id, request = {}, dataRoot: root, stateStore, ttlMs, now, fsOps, randomBytes } = {}) {
  const { capability, record } = invocationRecord({ id, dataRoot: root, stateStore });
  const intent = resolveCapabilityInvocationIntent({ id: capability.id, request, configuration: record.configuration });
  return issueCapabilityAuthorization({ dataRoot: root, abilityId: capability.id, action: intent.action, scope: intent.scope, ttlMs, now, fsOps, randomBytes });
}

/**
 * The only mutating/external execution entry. It verifies and atomically
 * consumes the software-issued authorization before an executor receives a
 * private authorization context.
 */
export async function invokeCapability({ id, request = {}, authorizationCredential, dataRoot: root, stateStore, adapters = {}, authorizationNow, authorizationFsOps } = {}) {
  const { capability, record, gate } = invocationRecord({ id, dataRoot: root, stateStore });
  const intent = resolveCapabilityInvocationIntent({ id: capability.id, request, configuration: record.configuration });
  const authorization = consumeCapabilityAuthorization({
    dataRoot: root,
    credential: authorizationCredential,
    abilityId: capability.id,
    action: intent.action,
    scope: intent.scope,
    now: authorizationNow,
    fsOps: authorizationFsOps,
  });
  const shared = { dataRoot: root, gate, configuration: record.configuration, authorization, invocation: intent };
  const executorRequest = intent.request;
  switch (capability.id) {
    case "computer-camera":
      return executorRequest.operation === "start"
        ? executeComputerCameraSession({ ...plainObject(adapters.computerCamera), ...executorRequest, ...shared })
        : executeComputerCameraCapture({ ...plainObject(adapters.computerCamera), ...executorRequest, ...shared });
    case "iphone-bridge":
      return executeIphoneBridgeMessage({ ...plainObject(adapters.iphoneBridge), ...executorRequest, ...shared });
    case "image-vision":
      return executeImageVision({ ...plainObject(adapters.imageVision), ...executorRequest, ...shared });
    case "video-understanding":
      return executeVideoUnderstanding({ ...plainObject(adapters.videoUnderstanding), ...executorRequest, ...shared });
    case "voice-message":
      return executeVoiceMessage({ ...plainObject(adapters.voiceMessage), ...executorRequest, ...shared });
    case "web-browser":
      return executeWebBrowser({ ...plainObject(adapters.webBrowser), ...executorRequest, ...shared });
    case "site-automation":
      return executeSiteAutomation({ ...plainObject(adapters.siteAutomation), ...executorRequest, ...shared });
    default:
      throw new CapabilityRegistryError("该能力没有可调用的软件执行器。 ");
  }
}

export function configureCapability({ id, dataRoot: root, configuration } = {}) {
  return createCapabilityStateStore({ dataRoot: root }).configure(id, configuration);
}

export function setCapabilityEnabled({ id, dataRoot: root, enabled } = {}) {
  return createCapabilityStateStore({ dataRoot: root }).setEnabled(id, enabled);
}
