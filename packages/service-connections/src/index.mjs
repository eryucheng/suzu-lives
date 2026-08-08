import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";

function clean(value) { return String(value ?? "").trim(); }
function connectionPath(dataRoot) { return path.join(path.resolve(dataRoot), "connections", "dashscope.json"); }
function credentialPath(dataRoot, name) { return path.join(path.resolve(dataRoot), "connections", `${name}.json`); }
function baseUrl(value) {
  const result = clean(value || DEFAULT_BASE_URL).replace(/\/+$/u, "");
  let parsed;
  try { parsed = new URL(result); } catch { throw new Error("Base URL 必须是 HTTP(S) 地址。"); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("Base URL 必须是 HTTP(S) 地址。");
  return result;
}
async function readJson(filePath, fallback = {}) { try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return fallback; } }
async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = filePath + ".tmp";
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(temporary, filePath);
}
function credentialState(value, safeStorage) {
  const encrypted = clean(value);
  if (!encrypted) return { key: "", status: "missing" };
  if (!safeStorage?.isEncryptionAvailable?.()) return { key: "", status: "encryption-unavailable" };
  try {
    const key = clean(safeStorage.decryptString(Buffer.from(encrypted, "base64")));
    return { key, status: key ? "ready" : "invalid" };
  } catch {
    return { key: "", status: "unreadable" };
  }
}
function decrypt(value, safeStorage) {
  return credentialState(value, safeStorage).key;
}

function createCredentialService({ dataRoot, safeStorage, environment = process.env, name, environmentKeys = [] }) {
  const filePath = credentialPath(dataRoot, name);
  async function stored() {
    const value = await readJson(filePath, null);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { encryptedApiKey: "", exists: false };
    return { encryptedApiKey: clean(value.encryptedApiKey), exists: true };
  }
  function environmentKey() {
    for (const key of environmentKeys) {
      const value = clean(environment[key]);
      if (value) return value;
    }
    return "";
  }
  async function snapshot() {
    const value = await stored();
    const savedKey = decrypt(value.encryptedApiKey, safeStorage);
    const fromEnvironment = environmentKey();
    return { configured: Boolean(fromEnvironment || savedKey), source: fromEnvironment ? "environment" : savedKey ? "saved" : "none" };
  }
  async function resolve() {
    const value = await stored();
    const fromEnvironment = environmentKey();
    if (fromEnvironment) return { key: fromEnvironment, source: "environment" };
    const savedKey = decrypt(value.encryptedApiKey, safeStorage);
    return { key: savedKey, source: savedKey ? "saved" : "none" };
  }
  async function save({ apiKey } = {}) {
    const key = clean(apiKey);
    if (!key) throw new Error("API Key 不能为空。 ");
    if (!safeStorage?.isEncryptionAvailable?.()) throw new Error("当前系统无法加密保存 API Key。 ");
    await writeJsonAtomic(filePath, { encryptedApiKey: safeStorage.encryptString(key).toString("base64") });
    return snapshot();
  }
  async function hasStoredConfiguration() {
    try { await fs.lstat(filePath); return true; }
    catch { return false; }
  }
  return { snapshot, resolve, save, hasStoredConfiguration };
}

export function createImageVisionCredentialService(options) {
  return createCredentialService({ ...options, name: "image-vision", environmentKeys: ["VISION_API_KEY", "OPENAI_API_KEY"] });
}

export function createVideoUnderstandingCredentialService(options) {
  return createCredentialService({ ...options, name: "video-understanding", environmentKeys: ["VIDEO_UNDERSTANDING_API_KEY", "DASHSCOPE_API_KEY"] });
}
function extraBody(value, label = "请求扩展 JSON") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + "必须是 JSON 对象。");
  const visit = (item, depth = 0) => {
    if (depth > 8) throw new Error(label + "嵌套层级不能超过 8 层。");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") { if (item.length > 8000) throw new Error(label + "包含过长字符串。"); return item; }
    if (typeof item === "number") { if (!Number.isFinite(item)) throw new Error(label + "只能包含有限数字。"); return item; }
    if (Array.isArray(item)) { if (item.length > 100) throw new Error(label + "数组元素过多。"); return item.map((child) => visit(child, depth + 1)); }
    if (!item || typeof item !== "object" || Object.getPrototypeOf(item) !== Object.prototype) throw new Error(label + "包含不支持的值。");
    const entries = Object.entries(item); if (entries.length > 100) throw new Error(label + "字段过多。");
    const output = {};
    for (const [key, child] of entries) { const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, ""); if (!key || key.length > 120 || ["__proto__", "prototype", "constructor"].includes(key) || ["apikey", "authorization", "token", "secret", "password"].some((term) => normalized.includes(term))) throw new Error(label + "不能包含凭证或敏感字段。"); output[key] = visit(child, depth + 1); }
    return output;
  };
  const result = visit(value); if (JSON.stringify(result).length > 50000) throw new Error(label + "不能超过 50 KB。"); return result;
}

export function createDashScopeConnectionService({ dataRoot, safeStorage, environment = process.env }) {
  const filePath = connectionPath(dataRoot);
  async function stored() {
    const value = await readJson(filePath, null);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { baseUrl: DEFAULT_BASE_URL, encryptedApiKey: "", exists: false };
    let storedBaseUrl;
    try { storedBaseUrl = baseUrl(value.baseUrl); } catch { storedBaseUrl = DEFAULT_BASE_URL; }
    return { baseUrl: storedBaseUrl, encryptedApiKey: clean(value.encryptedApiKey), exists: true };
  }
  async function snapshot() {
    const saved = await stored();
    const environmentKey = clean(environment.DASHSCOPE_API_KEY);
    const savedKey = decrypt(saved.encryptedApiKey, safeStorage);
    const source = environmentKey ? "environment" : savedKey ? "saved" : "none";
    return {
      baseUrl: saved.baseUrl,
      configured: Boolean(environmentKey || savedKey),
      source,
    };
  }
  async function resolve() {
    const saved = await stored();
    const environmentKey = clean(environment.DASHSCOPE_API_KEY);
    if (environmentKey) return { key: environmentKey, baseUrl: saved.baseUrl, source: "environment" };
    const savedKey = decrypt(saved.encryptedApiKey, safeStorage);
    return { key: savedKey, baseUrl: saved.baseUrl, source: savedKey ? "saved" : "none" };
  }
  async function save(value = {}) {
    const existing = await stored();
    const apiKey = clean(value.apiKey);
    let encryptedApiKey = existing.encryptedApiKey;
    if (apiKey) {
      if (!safeStorage?.isEncryptionAvailable?.()) throw new Error("当前系统无法加密保存 API Key；请使用 DASHSCOPE_API_KEY 环境变量。");
      encryptedApiKey = safeStorage.encryptString(apiKey).toString("base64");
    }
    await writeJsonAtomic(filePath, { baseUrl: baseUrl(value.baseUrl ?? existing.baseUrl), encryptedApiKey });
    return snapshot();
  }
  async function clear() {
    const existing = await stored();
    await writeJsonAtomic(filePath, { baseUrl: existing.baseUrl, encryptedApiKey: "" });
    return snapshot();
  }
  return { snapshot, resolve, save, clear };
}

/**
 * Normalizes the single 阿里百炼 credential for image generation.  The image
 * workbench chooses its model from the presence of reference images; callers
 * must not supply a second, OpenAI-compatible image key.
 */
export function asDashScopeImageConnection(value = {}) {
  const key = clean(value.apiKey || value.key);
  return {
    ...value,
    type: "dashscope",
    provider: "阿里百炼",
    apiKey: key,
    key,
    timeoutMs: Math.min(600000, Math.max(1000, Number(value.timeoutMs) || 180000)),
  };
}

export function createDashScopeImageConnectionService(options) {
  const dashscope = createDashScopeConnectionService(options);
  return {
    snapshot: async (value) => {
      const current = await dashscope.snapshot(value);
      return {
        ...current,
        provider: "阿里百炼",
        textToImageModel: "z-image-turbo",
        referenceImageModel: "wan2.7-image",
      };
    },
    resolve: async (value) => asDashScopeImageConnection(await dashscope.resolve(value)),
  };
}

const NAMED_CONNECTION_TYPES = new Set(["openai-compatible", "dashscope", "generic-api"]);
const BINDING_TYPES = {
  "image-workbench": ["dashscope"],
  "image-generation": ["dashscope"],
  "phone-camera": ["dashscope"],
  "voice-design": ["dashscope"],
  "voice-message": ["dashscope"],
  "image-vision": ["openai-compatible", "dashscope", "generic-api"],
  "video-understanding": ["openai-compatible", "dashscope", "generic-api"],
  "memory-embedding": ["openai-compatible", "dashscope"],
};
const BINDING_GROUPS = {
  "image-generation": ["image-workbench", "image-generation", "phone-camera"],
  sound: ["voice-design", "voice-message"],
};

function bindingTargets(feature) {
  return BINDING_GROUPS[feature] || (Object.hasOwn(BINDING_TYPES, feature) ? [feature] : []);
}

function namedConnectionsPath(dataRoot) {
  return path.join(path.resolve(dataRoot), "connections", "api-connections.json");
}

function limited(value, label, maximum, { required = false } = {}) {
  const result = clean(value);
  if (required && !result) throw new Error(`${label}不能为空。`);
  if (result.length > maximum) throw new Error(`${label}不能超过 ${maximum} 个字符。`);
  return result;
}

function namedBaseUrl(value, type) {
  const raw = clean(value || (type === "dashscope" ? DEFAULT_BASE_URL : "")).replace(/\/+$/u, "");
  if (!raw && type === "generic-api") return "";
  if (!raw && type === "openai-compatible") throw new Error("OpenAI Compatible 连接必须填写 Base URL。 ");
  return baseUrl(raw);
}

function typeLabel(type) {
  return type === "dashscope" ? "DashScope" : type === "generic-api" ? "通用 API" : "OpenAI Compatible";
}

function publicNamedConnection(value, safeStorage) {
  const credential = credentialState(value.encryptedApiKey, safeStorage);
  return {
    id: value.id,
    name: value.name,
    type: value.type,
    service: typeLabel(value.type),
    baseUrl: value.baseUrl,
    model: value.model,
    generationEndpoint: value.generationEndpoint,
    editEndpoint: value.editEndpoint,
    quality: value.quality,
    outputFormat: value.outputFormat,
    inputFidelity: value.inputFidelity,
    extraBody: value.extraBody,
    editExtraBody: value.editExtraBody,
    timeoutMs: value.timeoutMs,
    configured: Boolean(credential.key),
    credentialStatus: credential.status,
  };
}

function normalizedNamedConnection(value = {}, { current = null, safeStorage, requireKey = false } = {}) {
  const type = clean(value.type || current?.type).toLowerCase();
  if (!NAMED_CONNECTION_TYPES.has(type)) throw new Error("请选择受支持的 API 服务类型。 ");
  const name = limited(value.name ?? current?.name, "连接名称", 80, { required: true });
  const model = limited(value.model ?? current?.model, "模型", 160, { required: type === "openai-compatible" });
  const key = clean(value.apiKey);
  if ((requireKey || key) && !safeStorage?.isEncryptionAvailable?.()) throw new Error("当前系统无法加密保存 API Key。 ");
  if (requireKey && !key) throw new Error("新建连接必须填写 API Key。 ");
  const encryptedApiKey = key ? safeStorage.encryptString(key).toString("base64") : clean(current?.encryptedApiKey);
  return {
    id: limited(value.id || current?.id, "连接 ID", 80, { required: true }),
    name,
    type,
    baseUrl: namedBaseUrl(value.baseUrl ?? current?.baseUrl, type),
    model,
    encryptedApiKey,
    generationEndpoint: type === "openai-compatible" ? limited(value.generationEndpoint ?? (current?.generationEndpoint || "/images/generations"), "生成端点", 300, { required: true }) : "",
    editEndpoint: type === "openai-compatible" ? limited(value.editEndpoint ?? (current?.editEndpoint || "/images/edits"), "编辑端点", 300, { required: true }) : "",
    quality: type === "openai-compatible" ? limited(value.quality ?? current?.quality, "质量", 120) : "",
    outputFormat: type === "openai-compatible" ? limited(value.outputFormat ?? current?.outputFormat, "输出格式", 120) : "",
    inputFidelity: type === "openai-compatible" ? limited(value.inputFidelity ?? current?.inputFidelity, "参考保真", 120) : "",
    extraBody: type === "openai-compatible" ? (Object.hasOwn(value, "extraBody") ? extraBody(value.extraBody, "生成请求扩展 JSON") : (current?.extraBody || {})) : {},
    editExtraBody: type === "openai-compatible" ? (Object.hasOwn(value, "editExtraBody") ? extraBody(value.editExtraBody, "编辑请求扩展 JSON") : (current?.editExtraBody || {})) : {},
    timeoutMs: type === "openai-compatible" ? Number(value.timeoutMs ?? current?.timeoutMs) || 180000 : 0,
  };
}

function generatedConnectionId(name, existing) {
  const base = clean(name).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48) || "api";
  let candidate = base;
  let suffix = 2;
  while (existing.some((item) => item.id === candidate)) candidate = `${base.slice(0, 42)}-${suffix++}`;
  return candidate;
}

function namedStore(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    version: 1,
    connections: Array.isArray(raw.connections) ? raw.connections : [],
    bindings: raw.bindings && typeof raw.bindings === "object" && !Array.isArray(raw.bindings) ? raw.bindings : {},
  };
}

/**
 * Stores named, user-visible cloud API connections.  Secrets remain encrypted
 * in the main process; the renderer receives only `configured` state.
 */
export function createNamedApiConnectionService({ dataRoot, safeStorage }) {
  const filePath = namedConnectionsPath(dataRoot);
  async function readStore() { return namedStore(await readJson(filePath, {})); }
  async function writeStore(value) { await writeJsonAtomic(filePath, namedStore(value)); }
  async function snapshot() {
    const store = await readStore();
    return {
      connections: store.connections.map((item) => publicNamedConnection(item, safeStorage)),
      bindings: { ...store.bindings },
      bindingTypes: Object.fromEntries(Object.entries(BINDING_TYPES).map(([feature, types]) => [feature, [...types]])),
    };
  }
  async function save(value = {}) {
    const store = await readStore();
    const requestedId = clean(value.id);
    const index = requestedId ? store.connections.findIndex((item) => item.id === requestedId) : -1;
    const current = index === -1 ? null : store.connections[index];
    const id = current?.id || generatedConnectionId(value.name, store.connections);
    const next = normalizedNamedConnection({ ...value, id }, { current, safeStorage, requireKey: !current });
    if (index === -1) store.connections.push(next);
    else store.connections[index] = next;
    for (const [feature, selectedId] of Object.entries(store.bindings)) {
      if (selectedId === id && !BINDING_TYPES[feature]?.includes(next.type)) delete store.bindings[feature];
    }
    await writeStore(store);
    return snapshot();
  }
  async function remove(id) {
    const selectedId = clean(id);
    const store = await readStore();
    const index = store.connections.findIndex((item) => item.id === selectedId);
    if (index === -1) throw new Error("找不到要移除的 API 连接。 ");
    store.connections.splice(index, 1);
    for (const [feature, bindingId] of Object.entries(store.bindings)) if (bindingId === selectedId) delete store.bindings[feature];
    await writeStore(store);
    return snapshot();
  }
  async function bind(feature, connectionId) {
    const name = clean(feature);
    const targets = bindingTargets(name);
    if (!targets.length) throw new Error("不支持这个 API 功能绑定。 ");
    const store = await readStore();
    const id = clean(connectionId);
    if (!id) for (const target of targets) delete store.bindings[target];
    else {
      const connection = store.connections.find((item) => item.id === id);
      if (!connection) throw new Error("请选择已保存的 API 连接。 ");
      if (!targets.every((target) => BINDING_TYPES[target].includes(connection.type))) throw new Error("所选连接与此功能不兼容。 ");
      for (const target of targets) store.bindings[target] = id;
    }
    await writeStore(store);
    return snapshot();
  }
  async function resolve(feature) {
    const name = clean(feature);
    const store = await readStore();
    const id = clean(store.bindings[name]);
    if (!id) return null;
    const connection = store.connections.find((item) => item.id === id);
    if (!connection || !BINDING_TYPES[name]?.includes(connection.type)) return null;
    const credential = credentialState(connection.encryptedApiKey, safeStorage);
    return {
      ...connection,
      provider: typeLabel(connection.type),
      apiKey: credential.key,
      key: credential.key,
      source: credential.key ? "saved" : "none",
      credentialStatus: credential.status,
    };
  }
  return { snapshot, save, remove, bind, resolve };
}
