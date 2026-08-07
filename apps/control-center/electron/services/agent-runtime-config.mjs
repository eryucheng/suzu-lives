import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CLAUDE_CODE_API_PROVIDERS = Object.freeze({
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    modelListUrl: "https://api.deepseek.com/models",
    modelListAuth: "bearer",
    authEnvKey: "ANTHROPIC_AUTH_TOKEN",
    models: {
      model: "deepseek-v4-pro[1m]",
      opus: "deepseek-v4-pro[1m]",
      sonnet: "deepseek-v4-pro[1m]",
      haiku: "deepseek-v4-flash",
      subagent: "deepseek-v4-flash",
      effort: "max",
    },
  },
  minimax: {
    id: "minimax",
    label: "MiniMax（中国区）",
    baseUrl: "https://api.minimaxi.com/anthropic",
    modelListUrl: "https://api.minimaxi.com/anthropic/v1/models",
    modelListAuth: "x-api-key",
    authEnvKey: "ANTHROPIC_AUTH_TOKEN",
    models: {
      model: "MiniMax-M2.7",
      opus: "MiniMax-M2.7",
      sonnet: "MiniMax-M2.7",
      haiku: "MiniMax-M2.7",
      subagent: "MiniMax-M2.7",
      apiTimeoutMs: "3000000",
      disableNonessentialTraffic: "1",
    },
  },
  "bailian-coding": {
    id: "bailian-coding",
    label: "阿里百炼（Coding Plan）",
    baseUrl: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    modelListAuth: "unsupported",
    authEnvKey: "ANTHROPIC_AUTH_TOKEN",
    models: { model: "qwen3.8-max-preview", opus: "qwen3.8-max-preview", sonnet: "qwen3.8-max-preview", haiku: "qwen3.6-flash", subagent: "qwen3.7-max" },
  },
  "bailian-payg": {
    id: "bailian-payg",
    label: "阿里百炼（按量）",
    baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    modelListAuth: "unsupported",
    authEnvKey: "ANTHROPIC_AUTH_TOKEN",
    models: { model: "qwen3.8-max-preview", opus: "qwen3.8-max-preview", sonnet: "qwen3.8-max-preview", haiku: "qwen3.6-flash", subagent: "qwen3.7-max" },
  },
  kimi: {
    id: "kimi",
    label: "Kimi Code",
    baseUrl: "https://api.kimi.com/coding/",
    modelListAuth: "static",
    authEnvKey: "ANTHROPIC_API_KEY",
    staticModels: ["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"],
    models: { model: "kimi-for-coding", opus: "kimi-for-coding", sonnet: "kimi-for-coding", haiku: "kimi-for-coding", subagent: "kimi-for-coding", effort: "high" },
  },
});
const CLAUDE_CODE_API_PROVIDER_IDS = new Set([...Object.keys(CLAUDE_CODE_API_PROVIDERS), "custom"]);
const MANAGED_CLAUDE_API_ENV_KEYS = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL",
  "API_TIMEOUT_MS",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype ? value : {};
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function boundedText(value, label, maximum = 2000) {
  const result = clean(value);
  if (result.length > maximum) throw new Error(`${label}不能超过 ${maximum} 个字符。`);
  return result;
}

function stringList(value, label, { maximum = 120, itemMaximum = 500 } = {}) {
  const source = Array.isArray(value) ? value : String(value ?? "").split(/\r?\n|,/u);
  const items = [];
  const seen = new Set();
  for (const item of source) {
    const normalized = boundedText(item, label, itemMaximum);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      items.push(normalized);
    }
  }
  if (items.length > maximum) throw new Error(`${label}不能超过 ${maximum} 项。`);
  return items;
}

async function regularDirectory(target, label) {
  let stat;
  try { stat = await fs.lstat(target); }
  catch { throw new Error(`${label}不存在或无法读取。`); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label}不是可安全使用的目录。`);
  return fs.realpath(target);
}

async function regularFile(target, label, { required = false } = {}) {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label}不是可安全使用的文件。`);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return false;
    throw error;
  }
}

async function safeClaudeSettingsPath(projectRoot, { create = false } = {}) {
  const root = await regularDirectory(projectRoot, "当前工作目录");
  const claudeRoot = path.join(root, ".claude");
  try {
    const stat = await fs.lstat(claudeRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(".claude 不是可安全使用的目录。 ");
  } catch (error) {
    if (error?.code === "ENOENT" && create) await fs.mkdir(claudeRoot, { recursive: true });
    else if (error?.code === "ENOENT") return { root, settingsPath: path.join(claudeRoot, "settings.json"), exists: false };
    else throw error;
  }
  const settingsPath = path.join(claudeRoot, "settings.json");
  const fileExists = await regularFile(settingsPath, "Claude Code 设置文件");
  return { root, settingsPath, exists: fileExists };
}

async function safeDeviceClaudeSettingsPath(homeDirectory, { create = false } = {}) {
  const root = await regularDirectory(homeDirectory, "本机用户目录");
  const claudeRoot = path.join(root, ".claude");
  try {
    const stat = await fs.lstat(claudeRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("本机 .claude 不是可安全使用的目录。 ");
  } catch (error) {
    if (error?.code === "ENOENT" && create) await fs.mkdir(claudeRoot, { recursive: true });
    else if (error?.code === "ENOENT") return { root, settingsPath: path.join(claudeRoot, "settings.json"), exists: false };
    else throw error;
  }
  const settingsPath = path.join(claudeRoot, "settings.json");
  const fileExists = await regularFile(settingsPath, "本机 Claude Code 设置文件");
  return { root, settingsPath, exists: fileExists };
}

async function safeDeviceClaudeUserConfigPath(homeDirectory) {
  const root = await regularDirectory(homeDirectory, "本机用户目录");
  const configPath = path.join(root, ".claude.json");
  const exists = await regularFile(configPath, "本机 Claude Code 用户配置文件");
  return { root, configPath, exists };
}

async function readJsonObject(target, label) {
  const text = await fs.readFile(target, "utf8");
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/u, ""));
    if (!plainObject(value)) throw new Error();
    return value;
  } catch { throw new Error(`${label}不是有效的 JSON 对象。`); }
}

async function writeAtomically(target, content) {
  const temporary = `${target}.suzu-lives-${process.pid}-${Date.now()}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  try { await fs.rename(temporary, target); }
  catch (error) { await fs.unlink(temporary).catch(() => undefined); throw error; }
}

function endpointUrl(value, label, { allowBlank = false } = {}) {
  const source = boundedText(value, label, 500);
  if (!source && allowBlank) return "";
  if (!source) throw new Error(`${label}不能为空。`);
  let parsed;
  try { parsed = new URL(source); }
  catch { throw new Error(`${label}必须是完整的 HTTP 地址。`); }
  if (parsed.username || parsed.password) throw new Error(`${label}不能包含用户名或密码。`);
  const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname.toLowerCase());
  if (parsed.protocol !== "https:" && !localHttp) throw new Error(`${label}必须使用 HTTPS；本机地址可以使用 HTTP。`);
  return source;
}

function normalizedEndpoint(value) {
  const source = clean(value);
  if (!source) return "";
  try {
    const parsed = new URL(source);
    const pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname}${parsed.search}`;
  } catch { return source.replace(/\/+$/u, "").toLowerCase(); }
}

function claudeCodeApiProvider(providerId) {
  return CLAUDE_CODE_API_PROVIDERS[providerId] || null;
}

function inferClaudeCodeApiProvider(baseUrl) {
  const normalized = normalizedEndpoint(baseUrl);
  for (const provider of Object.values(CLAUDE_CODE_API_PROVIDERS)) {
    if (normalized && normalized === normalizedEndpoint(provider.baseUrl)) return provider.id;
  }
  return "custom";
}

function chosenAuthEnvKey(providerId, authMode) {
  const provider = claudeCodeApiProvider(providerId);
  if (provider) return provider.authEnvKey;
  return authMode === "api-key" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN";
}

function modelValue(value, label, fallback = "") {
  return boundedText(value, label, 200) || fallback;
}

function putEnv(env, key, value) {
  if (clean(value)) env[key] = String(value);
  else delete env[key];
}

function modelListUrlFor({ providerId, baseUrl, modelListUrl }) {
  const provider = claudeCodeApiProvider(providerId);
  if (provider?.modelListAuth === "unsupported" || provider?.modelListAuth === "static") return "";
  if (provider?.modelListUrl) return provider.modelListUrl;
  const explicit = endpointUrl(modelListUrl, "模型列表地址", { allowBlank: true });
  if (explicit) return explicit;
  const source = endpointUrl(baseUrl, "服务地址").replace(/\/+$/u, "");
  if (/\/anthropic$/iu.test(source)) return `${source}/v1/models`;
  if (/\/v1$/iu.test(source)) return `${source}/models`;
  return `${source}/v1/models`;
}

function modelIdsFromPayload(value) {
  const source = plainObject(value);
  const list = Array.isArray(source.data) ? source.data : Array.isArray(source.models) ? source.models : [];
  const ids = [];
  const seen = new Set();
  for (const item of list) {
    const sourceItem = plainObject(item);
    const id = clean(sourceItem.id || sourceItem.model_id || sourceItem.name);
    if (!id || id.length > 200 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= 200) break;
  }
  return ids;
}

function presentClaudeCodeApi({ device = {}, userConfig = {}, settingsExists = false, userConfigExists = false, settingsPath = "", userConfigPath = "" } = {}) {
  const env = plainObject(plainObject(device).env);
  const baseUrl = clean(env.ANTHROPIC_BASE_URL);
  const providerId = baseUrl ? inferClaudeCodeApiProvider(baseUrl) : "";
  const authEnvKey = chosenAuthEnvKey(providerId || "custom", clean(env.ANTHROPIC_API_KEY) ? "api-key" : "auth-token");
  const hasApiKey = Boolean(clean(env.ANTHROPIC_AUTH_TOKEN) || clean(env.ANTHROPIC_API_KEY));
  return {
    status: baseUrl && hasApiKey ? "ready" : "new",
    settingsPath,
    userConfigPath,
    settingsExists,
    userConfigExists,
    providerId,
    baseUrl,
    authMode: authEnvKey === "ANTHROPIC_API_KEY" ? "api-key" : "auth-token",
    hasApiKey,
    model: clean(env.ANTHROPIC_MODEL),
    fableModel: clean(env.ANTHROPIC_DEFAULT_FABLE_MODEL),
    opusModel: clean(env.ANTHROPIC_DEFAULT_OPUS_MODEL),
    sonnetModel: clean(env.ANTHROPIC_DEFAULT_SONNET_MODEL),
    haikuModel: clean(env.ANTHROPIC_DEFAULT_HAIKU_MODEL),
    subagentModel: clean(env.CLAUDE_CODE_SUBAGENT_MODEL),
    effortLevel: clean(env.CLAUDE_CODE_EFFORT_LEVEL),
    skipOnboarding: userConfigExists ? plainObject(userConfig).hasCompletedOnboarding === true : true,
  };
}

function presentClaudeConfig(value = {}) {
  const source = plainObject(value);
  const permissions = plainObject(source.permissions);
  const env = plainObject(source.env);
  return {
    alwaysThinkingEnabled: source.alwaysThinkingEnabled === true,
    includeCoAuthoredBy: source.includeCoAuthoredBy === true,
    skipWebFetchPreflight: source.skipWebFetchPreflight === true,
    allowedTools: stringList(permissions.allow, "允许工具"),
    deniedTools: stringList(permissions.deny, "禁止工具"),
    textService: {
      baseUrl: clean(env.ANTHROPIC_BASE_URL),
      hasAuthToken: Boolean(clean(env.ANTHROPIC_AUTH_TOKEN)),
      sonnet: { model: clean(env.ANTHROPIC_DEFAULT_SONNET_MODEL), name: clean(env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME) },
      opus: { model: clean(env.ANTHROPIC_DEFAULT_OPUS_MODEL), name: clean(env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME) },
      haiku: { model: clean(env.ANTHROPIC_DEFAULT_HAIKU_MODEL), name: clean(env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME) },
    },
  };
}

function mergedClaudeConfig({ device = {}, project = {} } = {}) {
  const deviceConfig = plainObject(device);
  const projectConfig = plainObject(project);
  const deviceEnv = plainObject(deviceConfig.env);
  const projectEnv = plainObject(projectConfig.env);
  return {
    ...deviceConfig,
    ...projectConfig,
    // Claude Code 的文本服务以本机设置为底，项目内的显式 env 仍可覆盖它。
    env: { ...deviceEnv, ...projectEnv },
    // 协作署名是 Claude Code 的本机偏好；旧项目字段只作为没有本机设置时的兼容回退。
    includeCoAuthoredBy: Object.hasOwn(deviceConfig, "includeCoAuthoredBy")
      ? deviceConfig.includeCoAuthoredBy
      : projectConfig.includeCoAuthoredBy,
  };
}

export function createAgentRuntimeConfigService({ settingsService, homeDirectory = os.homedir, fetchImpl = globalThis.fetch } = {}) {
  if (!settingsService || typeof settingsService.load !== "function") throw new Error("运行设置需要软件设置服务。 ");

  const claudeSnapshot = async (settings) => {
    const projectRoot = clean(settings?.projectRoot);
    if (!projectRoot) return { status: "needs-project", path: "", exists: false, settings: presentClaudeConfig() };
    let projectLocation;
    let deviceLocation;
    try {
      [projectLocation, deviceLocation] = await Promise.all([
        safeClaudeSettingsPath(projectRoot),
        safeDeviceClaudeSettingsPath(homeDirectory()),
      ]);
    }
    catch (error) { return { status: "unavailable", path: "", exists: false, message: clean(error?.message), settings: presentClaudeConfig() }; }
    try {
      const [project, device] = await Promise.all([
        projectLocation.exists ? readJsonObject(projectLocation.settingsPath, "项目 Claude Code 设置文件") : {},
        deviceLocation.exists ? readJsonObject(deviceLocation.settingsPath, "本机 Claude Code 设置文件") : {},
      ]);
      const exists = projectLocation.exists || deviceLocation.exists;
      return {
        status: exists ? "ready" : "new",
        path: projectLocation.settingsPath,
        exists,
        projectExists: projectLocation.exists,
        deviceExists: deviceLocation.exists,
        settings: presentClaudeConfig(mergedClaudeConfig({ device, project })),
      };
    } catch (error) {
      return { status: "invalid", path: projectLocation.settingsPath, exists: true, message: clean(error?.message), settings: presentClaudeConfig() };
    }
  };

  const claudeCodeApiSnapshot = async () => {
    let settingsLocation;
    let userConfigLocation;
    try {
      [settingsLocation, userConfigLocation] = await Promise.all([
        safeDeviceClaudeSettingsPath(homeDirectory()),
        safeDeviceClaudeUserConfigPath(homeDirectory()),
      ]);
    } catch (error) {
      return {
        ...presentClaudeCodeApi(),
        status: "unavailable",
        message: clean(error?.message),
      };
    }
    try {
      const [device, userConfig] = await Promise.all([
        settingsLocation.exists ? readJsonObject(settingsLocation.settingsPath, "本机 Claude Code 设置文件") : {},
        userConfigLocation.exists ? readJsonObject(userConfigLocation.configPath, "本机 Claude Code 用户配置文件") : {},
      ]);
      return presentClaudeCodeApi({
        device,
        userConfig,
        settingsExists: settingsLocation.exists,
        userConfigExists: userConfigLocation.exists,
        settingsPath: settingsLocation.settingsPath,
        userConfigPath: userConfigLocation.configPath,
      });
    } catch (error) {
      return {
        ...presentClaudeCodeApi({
          settingsExists: settingsLocation.exists,
          userConfigExists: userConfigLocation.exists,
          settingsPath: settingsLocation.settingsPath,
          userConfigPath: userConfigLocation.configPath,
        }),
        status: "invalid",
        message: clean(error?.message),
      };
    }
  };

  const saveClaudeCodeApi = async (value = {}) => {
    const providerId = clean(value.provider);
    if (providerId && !CLAUDE_CODE_API_PROVIDER_IDS.has(providerId)) throw new Error("所选 Claude Code 服务无效。 ");
    const provider = claudeCodeApiProvider(providerId);
    const authMode = clean(value.authMode) || "auth-token";
    if (!["auth-token", "api-key"].includes(authMode)) throw new Error("API 密钥传递方式无效。 ");
    const authEnvKey = chosenAuthEnvKey(providerId || "custom", authMode);
    const apiKey = boundedText(value.apiKey, "Claude Code API Key", 1000);
    const skipOnboarding = value.skipOnboarding !== false;
    const [settingsLocation, userConfigLocation] = await Promise.all([
      safeDeviceClaudeSettingsPath(homeDirectory()),
      safeDeviceClaudeUserConfigPath(homeDirectory()),
    ]);
    const [currentDevice, currentUserConfig] = await Promise.all([
      settingsLocation.exists ? readJsonObject(settingsLocation.settingsPath, "本机 Claude Code 设置文件") : {},
      userConfigLocation.exists ? readJsonObject(userConfigLocation.configPath, "本机 Claude Code 用户配置文件") : {},
    ]);
    const currentEnv = plainObject(currentDevice.env);
    const currentBaseUrl = clean(currentEnv.ANTHROPIC_BASE_URL);
    const selectedBaseUrl = provider
      ? provider.baseUrl
      : providerId === "custom"
        ? endpointUrl(value.baseUrl, "服务地址", { allowBlank: true })
        : "";
    const changingProvider = Boolean(selectedBaseUrl && currentBaseUrl && normalizedEndpoint(selectedBaseUrl) !== normalizedEndpoint(currentBaseUrl));
    if (changingProvider && !apiKey) throw new Error("更换 Claude Code 服务时，请重新填写该服务的 API Key。 ");
    const sameProvider = Boolean(selectedBaseUrl && currentBaseUrl && normalizedEndpoint(selectedBaseUrl) === normalizedEndpoint(currentBaseUrl));
    const existingKey = clean(currentEnv[authEnvKey]);
    const shouldWriteSettings = Boolean(selectedBaseUrl && (apiKey || sameProvider));
    if (selectedBaseUrl && sameProvider && !apiKey && !existingKey) throw new Error("当前服务没有可沿用的 API Key，请重新填写。 ");

    const nextUserConfig = { ...currentUserConfig };
    if (skipOnboarding) nextUserConfig.hasCompletedOnboarding = true;
    else delete nextUserConfig.hasCompletedOnboarding;
    if (providerId === "kimi") nextUserConfig.penguinModeOrgEnabled = true;

    const writes = [];
    if (shouldWriteSettings) {
      const deviceLocation = settingsLocation.exists ? settingsLocation : await safeDeviceClaudeSettingsPath(homeDirectory(), { create: true });
      const nextDevice = { ...currentDevice };
      const nextEnv = { ...currentEnv };
      for (const key of MANAGED_CLAUDE_API_ENV_KEYS) delete nextEnv[key];
      const oldModels = {
        model: clean(currentEnv.ANTHROPIC_MODEL),
        fable: clean(currentEnv.ANTHROPIC_DEFAULT_FABLE_MODEL),
        opus: clean(currentEnv.ANTHROPIC_DEFAULT_OPUS_MODEL),
        sonnet: clean(currentEnv.ANTHROPIC_DEFAULT_SONNET_MODEL),
        haiku: clean(currentEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL),
        subagent: clean(currentEnv.CLAUDE_CODE_SUBAGENT_MODEL),
        effort: clean(currentEnv.CLAUDE_CODE_EFFORT_LEVEL),
      };
      const defaults = sameProvider ? oldModels : (provider?.models || {});
      const primaryModel = modelValue(value.model, "主模型", defaults.model);
      const fableModel = modelValue(value.fableModel, "Fable 模型", defaults.fable || primaryModel);
      const opusModel = modelValue(value.opusModel, "Opus 模型", defaults.opus || primaryModel);
      const sonnetModel = modelValue(value.sonnetModel, "Sonnet 模型", defaults.sonnet || primaryModel);
      const haikuModel = modelValue(value.haikuModel, "Haiku 模型", defaults.haiku || primaryModel);
      const subagentModel = modelValue(value.subagentModel, "子 Agent 模型", defaults.subagent || haikuModel || primaryModel);
      const effectiveApiKey = apiKey || existingKey;
      putEnv(nextEnv, "ANTHROPIC_BASE_URL", selectedBaseUrl);
      putEnv(nextEnv, authEnvKey, effectiveApiKey);
      putEnv(nextEnv, "ANTHROPIC_MODEL", primaryModel);
      putEnv(nextEnv, "ANTHROPIC_DEFAULT_FABLE_MODEL", fableModel);
      putEnv(nextEnv, "ANTHROPIC_DEFAULT_OPUS_MODEL", opusModel);
      putEnv(nextEnv, "ANTHROPIC_DEFAULT_SONNET_MODEL", sonnetModel);
      putEnv(nextEnv, "ANTHROPIC_DEFAULT_HAIKU_MODEL", haikuModel);
      putEnv(nextEnv, "CLAUDE_CODE_SUBAGENT_MODEL", subagentModel);
      putEnv(nextEnv, "CLAUDE_CODE_EFFORT_LEVEL", modelValue(value.effortLevel, "思考强度", defaults.effort));
      putEnv(nextEnv, "API_TIMEOUT_MS", defaults.apiTimeoutMs || "");
      putEnv(nextEnv, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", defaults.disableNonessentialTraffic || "");
      if (Object.keys(nextEnv).length) nextDevice.env = nextEnv;
      else delete nextDevice.env;
      writes.push(writeAtomically(deviceLocation.settingsPath, `${JSON.stringify(nextDevice, null, 2)}\n`));
    }
    if (skipOnboarding || userConfigLocation.exists || providerId === "kimi") writes.push(writeAtomically(userConfigLocation.configPath, `${JSON.stringify(nextUserConfig, null, 2)}\n`));
    await Promise.all(writes);
    return claudeCodeApiSnapshot();
  };

  const fetchClaudeCodeModels = async (value = {}) => {
    const providerId = clean(value.provider);
    if (!CLAUDE_CODE_API_PROVIDER_IDS.has(providerId)) throw new Error("请先选择 Claude Code 服务。 ");
    const provider = claudeCodeApiProvider(providerId);
    if (provider?.modelListAuth === "unsupported") {
      return { status: "unsupported", models: [], message: "百炼的 Anthropic 兼容端点不提供模型列表；请按你的套餐手工填写模型。" };
    }
    if (provider?.modelListAuth === "static") {
      return { status: "ready", models: provider.staticModels || [], message: "已载入 Kimi Code 当前公开的可选模型；实际可用范围取决于你的套餐。" };
    }
    if (typeof fetchImpl !== "function") throw new Error("当前运行环境无法请求模型列表。 ");
    const [settingsLocation] = await Promise.all([safeDeviceClaudeSettingsPath(homeDirectory())]);
    const currentDevice = settingsLocation.exists ? await readJsonObject(settingsLocation.settingsPath, "本机 Claude Code 设置文件") : {};
    const currentEnv = plainObject(currentDevice.env);
    const authEnvKey = chosenAuthEnvKey(providerId, clean(value.authMode) || "auth-token");
    const apiKey = boundedText(value.apiKey, "Claude Code API Key", 1000) || clean(currentEnv[authEnvKey]);
    if (!apiKey) throw new Error("请先填写 API Key，或先保存已有的 Claude Code API 配置。 ");
    const baseUrl = provider?.baseUrl || endpointUrl(value.baseUrl, "服务地址");
    const modelListUrl = modelListUrlFor({ providerId, baseUrl, modelListUrl: value.modelListUrl });
    const headers = { Accept: "application/json" };
    if (provider?.modelListAuth === "x-api-key" || (!provider && clean(value.authMode) === "api-key")) headers["X-Api-Key"] = apiKey;
    else headers.Authorization = `Bearer ${apiKey}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetchImpl(modelListUrl, { headers, redirect: "error", signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("获取模型列表超时，请稍后重试。 ");
      throw new Error("无法连接到模型列表地址。请检查服务地址和网络。 ");
    } finally { clearTimeout(timeout); }
    if (!response?.ok) throw new Error(`获取模型列表失败（HTTP ${response?.status || "未知"}）。`);
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error("模型列表响应过大，已拒绝读取。 ");
    let payload;
    try { payload = JSON.parse(text); }
    catch { throw new Error("模型列表返回的不是有效 JSON。 "); }
    const models = modelIdsFromPayload(payload);
    if (!models.length) throw new Error("没有从响应中识别到模型名称。 ");
    return { status: "ready", models, message: `已获取 ${models.length} 个模型。` };
  };

  const snapshot = async () => {
    const claude = await claudeSnapshot(settingsService.load());
    return { claude };
  };

  const saveClaude = async (value = {}) => {
    const settings = settingsService.load();
    const projectRoot = clean(settings.projectRoot);
    if (!projectRoot) throw new Error("请先选择当前 Agent 的工作目录。 ");
    const [projectLocation, deviceLocation] = await Promise.all([
      safeClaudeSettingsPath(projectRoot, { create: true }),
      safeDeviceClaudeSettingsPath(homeDirectory(), { create: true }),
    ]);
    const [currentProject, currentDevice] = await Promise.all([
      projectLocation.exists ? readJsonObject(projectLocation.settingsPath, "项目 Claude Code 设置文件") : {},
      deviceLocation.exists ? readJsonObject(deviceLocation.settingsPath, "本机 Claude Code 设置文件") : {},
    ]);
    const nextProject = { ...currentProject };
    const nextDevice = { ...currentDevice };
    const permissions = { ...plainObject(currentProject.permissions) };
    const env = { ...plainObject(currentDevice.env) };
    const preserveTextService = value.preserveTextService === true;
    const allowedTools = stringList(value.allowedTools, "允许工具");
    const deniedTools = stringList(value.deniedTools, "禁止工具");
    const baseUrl = preserveTextService ? "" : boundedText(value.baseUrl, "文本服务地址", 500);
    const sonnetModel = preserveTextService ? "" : boundedText(value.sonnetModel, "Sonnet 模型", 200);
    const sonnetModelName = preserveTextService ? "" : boundedText(value.sonnetModelName, "Sonnet 显示名", 200);
    const opusModel = preserveTextService ? "" : boundedText(value.opusModel, "Opus 模型", 200);
    const opusModelName = preserveTextService ? "" : boundedText(value.opusModelName, "Opus 显示名", 200);
    const haikuModel = preserveTextService ? "" : boundedText(value.haikuModel, "Haiku 模型", 200);
    const haikuModelName = preserveTextService ? "" : boundedText(value.haikuModelName, "Haiku 显示名", 200);
    const authToken = preserveTextService ? "" : boundedText(value.authToken, "文本服务密钥", 1000);
    nextProject.alwaysThinkingEnabled = value.alwaysThinkingEnabled === true;
    nextDevice.includeCoAuthoredBy = value.includeCoAuthoredBy === true;
    nextProject.skipWebFetchPreflight = value.skipWebFetchPreflight === true;
    if (allowedTools.length) permissions.allow = allowedTools; else delete permissions.allow;
    if (deniedTools.length) permissions.deny = deniedTools; else delete permissions.deny;
    if (Object.keys(permissions).length) nextProject.permissions = permissions; else delete nextProject.permissions;
    if (!preserveTextService) {
      if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl; else delete env.ANTHROPIC_BASE_URL;
      if (sonnetModel) env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnetModel; else delete env.ANTHROPIC_DEFAULT_SONNET_MODEL;
      if (sonnetModelName) env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = sonnetModelName; else delete env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME;
      if (opusModel) env.ANTHROPIC_DEFAULT_OPUS_MODEL = opusModel; else delete env.ANTHROPIC_DEFAULT_OPUS_MODEL;
      if (opusModelName) env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = opusModelName; else delete env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME;
      if (haikuModel) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haikuModel; else delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
      if (haikuModelName) env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = haikuModelName; else delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME;
      if (authToken) env.ANTHROPIC_AUTH_TOKEN = authToken;
      else if (value.clearAuthToken === true) delete env.ANTHROPIC_AUTH_TOKEN;
    }
    if (Object.keys(env).length) nextDevice.env = env; else delete nextDevice.env;
    await Promise.all([
      writeAtomically(projectLocation.settingsPath, `${JSON.stringify(nextProject, null, 2)}\n`),
      writeAtomically(deviceLocation.settingsPath, `${JSON.stringify(nextDevice, null, 2)}\n`),
    ]);
    return snapshot();
  };

  return { snapshot, claudeCodeApiSnapshot, saveClaude, saveClaudeCodeApi, fetchClaudeCodeModels };
}

export function registerAgentRuntimeConfigIpc({ ipcMain, agentRuntimeConfigService }) {
  ipcMain.handle("agent-runtime:snapshot", () => agentRuntimeConfigService.snapshot());
  ipcMain.handle("agent-runtime:claude-code-api-snapshot", () => agentRuntimeConfigService.claudeCodeApiSnapshot());
  ipcMain.handle("agent-runtime:save-claude", (_event, value) => agentRuntimeConfigService.saveClaude(value));
  ipcMain.handle("agent-runtime:save-claude-code-api", (_event, value) => agentRuntimeConfigService.saveClaudeCodeApi(value));
  ipcMain.handle("agent-runtime:fetch-claude-code-models", (_event, value) => agentRuntimeConfigService.fetchClaudeCodeModels(value));
}
