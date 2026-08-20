import path from "node:path";

const DEEPSEEK_SETTINGS_NAMESPACE = "llm-deepseek";
const COMPATIBLE_MODEL_SETTINGS_NAMESPACE = "llm-suzu-compatible";
const AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE = "agent-default-model";
const DEEPSEEK_API_KEY_REFERENCE = "DEEPSEEK_API_KEY";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const CREDENTIAL_REFERENCE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const PROVIDER_ROUTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SUPPORTED_PI_PROTOCOLS = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);

// These are editable provider starting points. Suzu's configurable endpoint
// layer owns the supported wire protocols; Suzu supplies a transparent
// provider profile and makes its default model selection through its private
// Agent Core control plane.
export const TEXT_MODEL_PROVIDERS = Object.freeze({
  deepseek: Object.freeze({
    label: "DeepSeek",
    native: true,
    route: "deepseek-official",
    baseUrl: DEFAULT_DEEPSEEK_BASE_URL,
    model: DEFAULT_DEEPSEEK_MODEL,
    protocol: "openai-completions",
  }),
  minimax: Object.freeze({
    label: "MiniMax（中国区）",
    route: "suzu-minimax",
    baseUrl: "https://api.minimaxi.com/anthropic",
    model: "MiniMax-M2.7",
    protocol: "anthropic-messages",
    staticModels: Object.freeze(["MiniMax-M2.7"]),
  }),
  "bailian-coding": Object.freeze({
    label: "阿里百炼（Coding Plan）",
    route: "suzu-bailian-coding",
    baseUrl: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    model: "qwen3.8-max-preview",
    protocol: "anthropic-messages",
    staticModels: Object.freeze(["qwen3.8-max-preview", "qwen3.7-max", "qwen3.6-flash"]),
  }),
  "bailian-payg": Object.freeze({
    label: "阿里百炼（按量）",
    route: "suzu-bailian-payg",
    baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    model: "qwen3.8-max-preview",
    protocol: "anthropic-messages",
    staticModels: Object.freeze(["qwen3.8-max-preview", "qwen3.7-max", "qwen3.6-flash"]),
  }),
  kimi: Object.freeze({
    label: "Kimi Code",
    route: "suzu-kimi",
    baseUrl: "https://api.kimi.com/coding",
    model: "kimi-for-coding",
    protocol: "anthropic-messages",
    staticModels: Object.freeze(["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"]),
  }),
  custom: Object.freeze({
    label: "自定义兼容服务",
    route: "suzu-custom",
    baseUrl: "",
    model: "",
    protocol: "anthropic-messages",
  }),
});

export class AgentRuntimeConfigError extends Error {
  constructor(message, { cause, code = "AGENT_RUNTIME_CONFIG_ERROR" } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "AgentRuntimeConfigError";
    this.code = code;
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function unwrapRpc(reply, operation) {
  const result = plainObject(reply).result;
  if (result?.ok === true) return plainObject(result.value);
  const error = plainObject(result?.error);
  throw new AgentRuntimeConfigError(
    clean(error.message) || `Suzu Agent Core 拒绝了${operation}。`,
    { code: clean(error.code) || "AGENT_CORE_RPC_REJECTED" },
  );
}

function boundedText(value, label, maximum = 1_000) {
  const text = clean(value);
  if (text.length > maximum || /[\r\n\u0000]/u.test(text)) {
    throw new AgentRuntimeConfigError(`${label}不能超过 ${maximum} 个字符，也不能包含换行。`, { code: "INVALID_INPUT" });
  }
  return text;
}

function endpointUrl(value, { allowBlank = false } = {}) {
  const text = boundedText(value, "服务地址", 500);
  if (!text && allowBlank) return "";
  if (!text) throw new AgentRuntimeConfigError("服务地址不能为空。", { code: "INVALID_ENDPOINT" });
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new AgentRuntimeConfigError("服务地址必须是完整的 HTTP 地址。", { code: "INVALID_ENDPOINT" });
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AgentRuntimeConfigError("服务地址不能包含认证信息、查询参数或片段。", { code: "INVALID_ENDPOINT" });
  }
  const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname.toLowerCase());
  if (parsed.protocol !== "https:" && !localHttp) {
    throw new AgentRuntimeConfigError("服务地址必须使用 HTTPS；本机地址可以使用 HTTP。", { code: "INVALID_ENDPOINT" });
  }
  return parsed.toString().replace(/\/$/u, "");
}

function normalizedEndpoint(value) {
  const source = clean(value);
  if (!source) return "";
  try {
    const parsed = new URL(source);
    const pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname}`;
  } catch {
    return source.replace(/\/+$/u, "").toLowerCase();
  }
}

function namedNamespace(snapshot, namespace) {
  return (Array.isArray(snapshot?.namespaces) ? snapshot.namespaces : [])
    .find((entry) => clean(entry?.ns) === namespace) || null;
}

function providerDefinition(value) {
  const id = clean(value).toLowerCase();
  return TEXT_MODEL_PROVIDERS[id] || TEXT_MODEL_PROVIDERS.custom;
}

function providerId(value) {
  const id = clean(value).toLowerCase();
  if (!id) return "deepseek";
  return Object.hasOwn(TEXT_MODEL_PROVIDERS, id) ? id : "custom";
}

function profileRoute({ providerId: id, route = "" } = {}) {
  const configured = clean(route);
  if (configured && PROVIDER_ROUTE.test(configured)) return configured;
  return providerDefinition(id).route;
}

function credentialReferenceFor({ providerId: id, route = "", profile = null } = {}) {
  const configured = clean(plainObject(profile).apiKeyEnv);
  if (configured && CREDENTIAL_REFERENCE.test(configured)) return configured;
  if (providerId(id) === "deepseek") return DEEPSEEK_API_KEY_REFERENCE;
  const token = profileRoute({ providerId: id, route })
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 96);
  return `SUZU_AGENT_${token || "CUSTOM"}_API_KEY`;
}

function protocol(value, fallback = "anthropic-messages") {
  const candidate = clean(value).toLowerCase() || fallback;
  if (!SUPPORTED_PI_PROTOCOLS.has(candidate)) {
    throw new AgentRuntimeConfigError("自定义服务协议只支持 OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages。", { code: "INVALID_PROTOCOL" });
  }
  return candidate;
}

function modelId(value) {
  const model = boundedText(value, "模型标识", 200);
  if (!model) throw new AgentRuntimeConfigError("请填写模型标识。", { code: "AGENT_MODEL_REQUIRED" });
  return model;
}

function modelEntries(catalog, route = "") {
  const target = clean(route);
  const group = (Array.isArray(catalog?.groups) ? catalog.groups : [])
    .find((candidate) => clean(candidate?.id) === target);
  const seen = new Set();
  return (Array.isArray(group?.models) ? group.models : [])
    .map((entry) => ({
      id: clean(entry?.id),
      name: clean(entry?.name) || clean(entry?.id),
      contextWindow: Number(entry?.contextWindow) || 0,
      maxTokens: Number(entry?.maxTokens) || 0,
    }))
    .filter((entry) => entry.id && !seen.has(entry.id) && (seen.add(entry.id) || true));
}

function profileModels(profile) {
  const seen = new Set();
  return (Array.isArray(profile?.models) ? profile.models : [])
    .map((entry) => ({
      id: clean(entry?.id),
      name: clean(entry?.name) || clean(entry?.id),
      contextWindow: Number(entry?.contextWindow) || 0,
      maxTokens: Number(entry?.maxTokens) || 0,
    }))
    .filter((entry) => entry.id && !seen.has(entry.id) && (seen.add(entry.id) || true));
}

function providerModels(id) {
  const seen = new Set();
  return (Array.isArray(providerDefinition(id).staticModels) ? providerDefinition(id).staticModels : [])
    .map((value) => clean(value))
    .filter((value) => value && !seen.has(value) && (seen.add(value) || true));
}

function defaultSelection(settings) {
  const namespace = namedNamespace(settings, AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE);
  const value = plainObject(namespace?.value);
  return {
    namespace,
    provider: clean(value.provider) || TEXT_MODEL_PROVIDERS.deepseek.route,
    model: clean(value.model) || DEFAULT_DEEPSEEK_MODEL,
    reasoningEffort: clean(value.reasoningEffort),
  };
}

function compatibleProfiles(settings) {
  const namespace = namedNamespace(settings, COMPATIBLE_MODEL_SETTINGS_NAMESPACE);
  const source = plainObject(namespace?.value);
  const profiles = isPlainObject(source.providers) ? source.providers : {};
  return { namespace, profiles };
}

function configuredProviderId(selection, profiles) {
  if (selection.provider === TEXT_MODEL_PROVIDERS.deepseek.route) return "deepseek";
  for (const [id, definition] of Object.entries(TEXT_MODEL_PROVIDERS)) {
    if (id !== "custom" && definition.route === selection.provider) return id;
  }
  return Object.hasOwn(profiles, selection.provider) ? "custom" : "custom";
}

function publicProviderChoices() {
  return Object.entries(TEXT_MODEL_PROVIDERS).map(([id, definition]) => Object.freeze({
    id,
    label: definition.label,
    route: definition.route,
    protocol: definition.protocol,
    baseUrl: definition.baseUrl,
    native: definition.native === true,
  }));
}

function controlPlaneFrom(value) {
  const runtime = typeof value === "function" ? value() : value;
  if (!runtime || typeof runtime.controlPlane !== "function") {
    throw new AgentRuntimeConfigError("Suzu Agent Core 尚未准备好。", { code: "AGENT_RUNTIME_UNAVAILABLE" });
  }
  return runtime.controlPlane();
}

async function readConfiguration(api) {
  if (!api?.settings?.describe || !api?.credentials?.describe || !api?.llm?.models) {
    throw new AgentRuntimeConfigError("Suzu Agent Core 配置接口不完整。", { code: "AGENT_CONTROL_PLANE_INVALID" });
  }
  const [settings, catalog] = await Promise.all([
    api.settings.describe({}).then((reply) => unwrapRpc(reply, "读取模型设置")),
    api.llm.models({}).then((reply) => unwrapRpc(reply, "读取模型目录")),
  ]);
  const selection = defaultSelection(settings);
  const compatible = compatibleProfiles(settings);
  const refs = new Set([DEEPSEEK_API_KEY_REFERENCE]);
  for (const [route, profile] of Object.entries(compatible.profiles)) {
    const ref = credentialReferenceFor({ providerId: "custom", route, profile });
    if (CREDENTIAL_REFERENCE.test(ref)) refs.add(ref);
  }
  const credentials = await api.credentials.describe({ refs: [...refs].sort() })
    .then((reply) => unwrapRpc(reply, "读取模型凭据"));
  return { catalog, compatible, credentials, selection, settings };
}

function presentConfiguration(current) {
  const { catalog, compatible, credentials, selection, settings } = current;
  const id = configuredProviderId(selection, compatible.profiles);
  const definition = providerDefinition(id);
  const profile = id === "deepseek" ? plainObject(namedNamespace(settings, DEEPSEEK_SETTINGS_NAMESPACE)?.value) : plainObject(compatible.profiles[selection.provider]);
  const ref = credentialReferenceFor({ providerId: id, route: selection.provider, profile });
  const credential = plainObject(plainObject(credentials).credentials)[ref] || {};
  const catalogEntries = modelEntries(catalog, selection.provider);
  const configuredEntries = profileModels(profile);
  const models = catalogEntries.length ? catalogEntries : configuredEntries;
  const selectedModel = selection.model || models[0]?.id || definition.model || DEFAULT_DEEPSEEK_MODEL;
  const hasApiKey = credential.configured === true;
  const selectedNamespace = id === "deepseek"
    ? namedNamespace(settings, DEEPSEEK_SETTINGS_NAMESPACE)
    : compatible.namespace;
  const baseUrl = clean(id === "deepseek" ? profile.baseURL : profile.baseURL) || definition.baseUrl || "";
  const selectedProtocol = id === "deepseek" ? definition.protocol : protocol(profile.api, definition.protocol);
  return Object.freeze({
    status: hasApiKey ? "ready" : "new",
    runtime: "agent-core",
    providerId: id,
    provider: clean(profile.displayName) || definition.label,
    providerRoute: selection.provider,
    providerChoices: publicProviderChoices(),
    protocol: selectedProtocol,
    hasApiKey,
    apiKeySource: clean(credential.source),
    apiKeyWritable: credential.writable !== false,
    settingsExists: settings?.hasDocument === true,
    userConfigExists: settings?.hasDocument === true,
    settingsWritable: settings?.writable !== false && selectedNamespace?.writable !== false,
    baseUrl,
    model: selectedModel,
    models: models.map((entry) => entry.id),
    modelEntries: models,
    message: hasApiKey
      ? "Suzu Agent Core 的当前文本模型连接已就绪。"
      : `请为 ${clean(profile.displayName) || definition.label} 填写 API Key。`,
  });
}

function selectedProfileValue({ id, value, current }) {
  const definition = providerDefinition(id);
  const route = profileRoute({ providerId: id, route: value.route });
  const existing = plainObject(current.compatible.profiles[route]);
  const selectedRoute = clean(current.selection.provider);
  const existingSelectedModel = selectedRoute === route ? current.selection.model : "";
  const model = modelId(value.model || existingSelectedModel || definition.model);
  const baseUrl = endpointUrl(value.baseUrl || existing.baseURL || definition.baseUrl, { allowBlank: false });
  const selectedProtocol = protocol(value.protocol || existing.api, definition.protocol);
  const credentialRef = credentialReferenceFor({ providerId: id, route, profile: existing });
  return {
    route,
    credentialRef,
    profile: {
      displayName: boundedText(value.providerLabel || existing.displayName || definition.label, "服务备注", 120) || definition.label,
      apiKeyEnv: credentialRef,
      api: selectedProtocol,
      baseURL: baseUrl,
      models: [{
        id: model,
        name: boundedText(value.modelLabel || model, "模型显示名", 200) || model,
        contextWindow: Number.isSafeInteger(Number(value.contextWindow)) && Number(value.contextWindow) > 0 ? Number(value.contextWindow) : 262_144,
        maxTokens: Number.isSafeInteger(Number(value.maxTokens)) && Number(value.maxTokens) > 0 ? Number(value.maxTokens) : 32_768,
      }],
    },
    model,
  };
}

async function saveDefaultSelection(api, current, { provider, model }) {
  const namespace = defaultSelection(current.settings).namespace;
  if (!namespace || !api?.settings?.mutate) {
    throw new AgentRuntimeConfigError("当前 Suzu Agent Core 没有可用的默认模型设置。", { code: "AGENT_DEFAULT_MODEL_SETTINGS_UNAVAILABLE" });
  }
  unwrapRpc(await api.settings.mutate({
    ns: AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE,
    expectedRevision: Number(namespace.revision),
    ops: [
      { op: "set", path: ["provider"], value: provider },
      { op: "set", path: ["model"], value: model },
      { op: "unset", path: ["reasoningEffort"] },
    ],
  }), "保存默认模型选择");
}

/**
 * Configures Suzu Agent Core's model plane. DeepSeek keeps its native adapter;
 * MiniMax, 百炼, Kimi, and custom compatible endpoints use Suzu's own narrow
 * configurable endpoint layer.
 */
export function createAgentRuntimeConfigService({
  runtime = null,
} = {}) {
  const controlPlane = async () => controlPlaneFrom(runtime);

  const runtimeSnapshot = async () => {
    const api = await controlPlane();
    return presentConfiguration(await readConfiguration(api));
  };

  const saveModelConfiguration = async (value = {}) => {
    const id = providerId(value.provider || value.providerId);
    const api = await controlPlane();
    let current = await readConfiguration(api);
    const apiKey = boundedText(value.apiKey, "API Key", 1_000);

    if (id === "deepseek") {
      const namespace = namedNamespace(current.settings, DEEPSEEK_SETTINGS_NAMESPACE);
      if (!namespace) throw new AgentRuntimeConfigError("当前 Suzu Agent Core 没有可用的 DeepSeek 模型设置。", { code: "AGENT_SETTINGS_UNAVAILABLE" });
      const configuration = plainObject(namespace.value);
      const credentialRef = credentialReferenceFor({ providerId: id, profile: configuration });
      const credential = plainObject(plainObject(current.credentials).credentials)[credentialRef] || {};
      if (!apiKey && credential.configured !== true) {
        throw new AgentRuntimeConfigError("请填写 DeepSeek API Key。", { code: "AGENT_API_KEY_REQUIRED" });
      }
      if (apiKey && credential.writable === false) {
        throw new AgentRuntimeConfigError("当前 DeepSeek API Key 来自只读环境变量；请在系统环境中更新它。", { code: "AGENT_CREDENTIAL_READ_ONLY" });
      }
      const requestedBaseUrl = endpointUrl(value.baseUrl, { allowBlank: true });
      const currentBaseUrl = clean(configuration.baseURL) || DEFAULT_DEEPSEEK_BASE_URL;
      if (normalizedEndpoint(requestedBaseUrl || DEFAULT_DEEPSEEK_BASE_URL) !== normalizedEndpoint(currentBaseUrl)) {
        if (!api.settings?.mutate) throw new AgentRuntimeConfigError("当前 Suzu Agent Core 不支持更新模型地址。", { code: "AGENT_SETTINGS_WRITE_UNAVAILABLE" });
        unwrapRpc(await api.settings.mutate({
          ns: DEEPSEEK_SETTINGS_NAMESPACE,
          expectedRevision: Number(namespace.revision),
          ops: [requestedBaseUrl ? { op: "set", path: ["baseURL"], value: requestedBaseUrl } : { op: "unset", path: ["baseURL"] }],
        }), "保存模型地址");
        current = await readConfiguration(api);
      }
      if (apiKey) {
        if (!api.credentials?.set) throw new AgentRuntimeConfigError("当前 Suzu Agent Core 不支持保存模型凭据。", { code: "AGENT_CREDENTIAL_WRITE_UNAVAILABLE" });
        unwrapRpc(await api.credentials.set({ ref: credentialRef, value: apiKey }), "保存模型凭据");
        current = await readConfiguration(api);
      }
      const model = modelId(value.model || current.selection.model || DEFAULT_DEEPSEEK_MODEL);
      await saveDefaultSelection(api, current, { provider: TEXT_MODEL_PROVIDERS.deepseek.route, model });
      return runtimeSnapshot();
    }

    const selected = selectedProfileValue({ id, value, current });
    const existingCredential = plainObject(plainObject(current.credentials).credentials)[selected.credentialRef] || {};
    if (!apiKey && existingCredential.configured !== true) {
      throw new AgentRuntimeConfigError(`请填写 ${providerDefinition(id).label} API Key。`, { code: "AGENT_API_KEY_REQUIRED" });
    }
    if (apiKey && existingCredential.writable === false) {
      throw new AgentRuntimeConfigError("当前 API Key 来自只读环境变量；请在系统环境中更新它。", { code: "AGENT_CREDENTIAL_READ_ONLY" });
    }
    if (!current.compatible.namespace || !api.settings?.mutate) {
      throw new AgentRuntimeConfigError("当前 Suzu Agent Core 没有可用的兼容模型设置。", { code: "AGENT_COMPATIBLE_MODEL_SETTINGS_UNAVAILABLE" });
    }
    unwrapRpc(await api.settings.mutate({
      ns: COMPATIBLE_MODEL_SETTINGS_NAMESPACE,
      expectedRevision: Number(current.compatible.namespace.revision),
      ops: [{ op: "set", path: ["providers", selected.route], value: selected.profile }],
    }), "保存兼容模型连接");
    if (apiKey) {
      if (!api.credentials?.set) throw new AgentRuntimeConfigError("当前 Suzu Agent Core 不支持保存模型凭据。", { code: "AGENT_CREDENTIAL_WRITE_UNAVAILABLE" });
      unwrapRpc(await api.credentials.set({ ref: selected.credentialRef, value: apiKey }), "保存模型凭据");
    }
    current = await readConfiguration(api);
    await saveDefaultSelection(api, current, { provider: selected.route, model: selected.model });
    return runtimeSnapshot();
  };

  const fetchModels = async (value = {}) => {
    const api = await controlPlane();
    const current = await readConfiguration(api);
    const id = providerId(value.provider || value.providerId || configuredProviderId(current.selection, current.compatible.profiles));
    if (id === "deepseek") {
      const models = modelEntries(current.catalog, TEXT_MODEL_PROVIDERS.deepseek.route).map((entry) => entry.id);
      return Object.freeze({ status: "ready", models, message: models.length ? "已从当前模型目录读取可选模型。" : "当前没有公布可选模型。" });
    }
    const selected = selectedProfileValue({ id, value: { ...value, model: value.model || providerDefinition(id).model || "manual-model" }, current });
    if (api?.llm?.discoverModels && selected.profile.api.startsWith("openai-")) {
      try {
        const discovered = unwrapRpc(await api.llm.discoverModels({
          settingsNs: COMPATIBLE_MODEL_SETTINGS_NAMESPACE,
          provider: selected.route,
          baseURL: selected.profile.baseURL,
          api: selected.profile.api,
          ...(clean(value.apiKey) ? { apiKey: boundedText(value.apiKey, "API Key", 1_000) } : {}),
        }), "获取服务模型列表");
        const models = (Array.isArray(discovered.models) ? discovered.models : [])
          .map((entry) => clean(entry?.id))
          .filter(Boolean);
        return Object.freeze({ status: "ready", models, message: models.length ? "已从服务端读取可选模型；选择后保存即可。" : "服务端没有返回模型标识，请手动填写。" });
      } catch (error) {
        return Object.freeze({ status: "manual", models: profileModels(selected.profile).map((entry) => entry.id), message: `此服务无法自动读取模型列表：${clean(error?.message) || "请手动填写模型标识。"}` });
      }
    }
    const models = [...new Set([...profileModels(selected.profile).map((entry) => entry.id), ...providerModels(id)])];
    return Object.freeze({ status: "manual", models, message: models.length ? "此服务没有通用的模型列表接口；已给出该服务的已知模型，实际可用范围以你的套餐为准。" : "这个协议不提供通用模型列表接口；请按服务商文档手动填写模型标识。" });
  };

  return Object.freeze({ runtimeSnapshot, saveModelConfiguration, fetchModels });
}

export function registerAgentRuntimeConfigIpc({ ipcMain, agentRuntimeConfigService } = {}) {
  if (!ipcMain?.handle || !agentRuntimeConfigService) {
    throw new AgentRuntimeConfigError("Suzu Agent Core 配置 IPC 需要 ipcMain 和配置服务。", { code: "AGENT_RUNTIME_CONFIG_IPC_INVALID" });
  }
  ipcMain.handle("agent-runtime:snapshot", () => agentRuntimeConfigService.runtimeSnapshot());
  ipcMain.handle("agent-runtime:save-model-configuration", (_event, value) => agentRuntimeConfigService.saveModelConfiguration(value));
  ipcMain.handle("agent-runtime:fetch-models", (_event, value) => agentRuntimeConfigService.fetchModels(value));
}
