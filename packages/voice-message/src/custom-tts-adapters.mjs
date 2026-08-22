import fs from "node:fs";
import path from "node:path";

export const CUSTOM_TTS_ADAPTER_FILE = "custom-tts-adapters.json";
export const CUSTOM_TTS_ADAPTER_SCHEMA_VERSION = 1;
export const MAX_CUSTOM_TTS_ADAPTERS = 40;

const MAX_NAME_LENGTH = 80;
const MAX_BASE_URL_LENGTH = 500;
const MAX_ENDPOINT_LENGTH = 300;
const MAX_HEADERS_LENGTH = 8_000;
const MAX_BODY_LENGTH = 24_000;
const MAX_RESPONSE_PATH_LENGTH = 300;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,120}$/u;
const JSON_PATH = /^[A-Za-z_$][\w$]*(?:\[\d+\]|\.[A-Za-z_$][\w$]*)*$/u;
const AUDIO_FORMAT = /^[a-z0-9]{1,12}$/u;
const RESPONSE_MODES = new Set(["json-base64", "json-url", "binary"]);
const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const ENDPOINT_TEMPLATE = /\{\{([^}]+)\}\}/gu;

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedText(value, label, maximum) {
  const result = clean(value);
  if (result.length > maximum) throw new Error(`${label}不能超过 ${maximum} 个字符。`);
  return result;
}

function ordinaryJson(value, { depth = 0 } = {}) {
  if (depth > 16) throw new Error("请求 JSON 的层级不能超过 16 层。");
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => ordinaryJson(item, { depth: depth + 1 }));
  if (!isPlainObject(value)) throw new Error("请求 JSON 只能包含对象、数组、字符串、数字、布尔值或 null。");
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(key)) throw new Error("请求 JSON 含有不允许的字段。 ");
    result[key] = ordinaryJson(item, { depth: depth + 1 });
  }
  return result;
}

function jsonValue(value, label, maximum) {
  const source = typeof value === "string" ? boundedText(value, label, maximum) : value;
  try {
    return ordinaryJson(typeof source === "string" ? JSON.parse(source || "{}") : source);
  } catch (error) {
    throw new Error(`${label}必须是有效的 JSON：${clean(error?.message) || "格式错误"}`);
  }
}

function headerValues(value) {
  const parsed = jsonValue(value, "请求 Headers", MAX_HEADERS_LENGTH);
  if (!isPlainObject(parsed)) throw new Error("请求 Headers 必须是 JSON 对象。 ");
  const result = {};
  for (const [name, raw] of Object.entries(parsed)) {
    if (!HEADER_NAME.test(name)) throw new Error(`请求 Header 名称无效：${name}`);
    const headerValue = String(raw ?? "");
    if (headerValue.length > 2_000 || /[\r\n]/u.test(headerValue)) throw new Error(`请求 Header“${name}”的值无效。`);
    result[name] = headerValue;
  }
  return result;
}

function endpointPath(value) {
  const result = boundedText(value, "接口路径", MAX_ENDPOINT_LENGTH);
  if (!result.startsWith("/") || result.startsWith("//") || result.includes("://")) {
    throw new Error("接口路径必须是以 / 开头的相对路径。 ");
  }
  try {
    const parsed = new URL(result, "https://suzu.invalid");
    if (parsed.origin !== "https://suzu.invalid") throw new Error();
  } catch {
    throw new Error("接口路径格式无效。 ");
  }
  for (const match of result.matchAll(ENDPOINT_TEMPLATE)) {
    if (match[1] !== "voice") throw new Error("接口路径只支持 {{voice}} 变量。 ");
  }
  return result;
}

function serviceBaseUrl(value, { required = false } = {}) {
  const result = boundedText(value, "服务地址", MAX_BASE_URL_LENGTH).replace(/\/+$/u, "");
  if (!result) {
    if (required) throw new Error("请填写自定义协议的服务地址。 ");
    return "";
  }
  let parsed;
  try { parsed = new URL(result); } catch { throw new Error("服务地址必须是 HTTP(S) 地址。 "); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("服务地址必须是 HTTP(S) 地址。 ");
  return result;
}

function responseMode(value) {
  const result = clean(value) || "json-base64";
  if (!RESPONSE_MODES.has(result)) throw new Error("音频响应类型无效。 ");
  return result;
}

function responsePath(value, mode) {
  const result = boundedText(value, "音频返回位置", MAX_RESPONSE_PATH_LENGTH);
  if (mode === "binary") return "";
  if (!result || !JSON_PATH.test(result)) {
    throw new Error("音频返回位置必须是 JSON 字段路径。 ");
  }
  return result;
}

function outputFormat(value) {
  const result = clean(value).toLowerCase() || "mp3";
  if (!AUDIO_FORMAT.test(result)) throw new Error("音频格式无效。 ");
  return result;
}

export function customTtsAdaptersPath(dataRoot) {
  const root = clean(dataRoot);
  if (!root) throw new Error("缺少本机数据目录。 ");
  return path.join(path.resolve(root), "voice-message", CUSTOM_TTS_ADAPTER_FILE);
}

export function normalizeCustomTtsAdapter(value, { requireBaseUrl = false, requireId = true } = {}) {
  const source = plainObject(value);
  const id = clean(source.id).toLowerCase();
  if (requireId && !/^[a-z0-9][a-z0-9-]{7,99}$/u.test(id)) throw new Error("适配器标识无效。 ");
  const name = boundedText(source.name, "适配器名称", MAX_NAME_LENGTH);
  if (!name) throw new Error("请填写适配器名称。 ");
  const mode = responseMode(source.responseMode);
  const body = jsonValue(source.requestBody, "请求 JSON", MAX_BODY_LENGTH);
  if (!isPlainObject(body)) throw new Error("请求 JSON 的顶层必须是对象。 ");
  if (!Object.keys(body).length) throw new Error("请求 JSON 至少需要一个字段。 ");
  return Object.freeze({
    ...(id ? { id } : {}),
    name,
    baseUrl: serviceBaseUrl(source.baseUrl, { required: requireBaseUrl }),
    endpointPath: endpointPath(source.endpointPath),
    requestHeaders: headerValues(source.requestHeaders),
    requestBody: body,
    responseMode: mode,
    audioPath: responsePath(source.audioPath, mode),
    outputFormat: outputFormat(source.outputFormat),
    createdAt: clean(source.createdAt),
  });
}

export function normalizeCustomTtsAdapters(value) {
  const document = plainObject(value);
  const adapters = [];
  const seen = new Set();
  for (const item of (Array.isArray(document.adapters) ? document.adapters : []).slice(0, MAX_CUSTOM_TTS_ADAPTERS)) {
    try {
      const adapter = normalizeCustomTtsAdapter(item);
      if (seen.has(adapter.id)) continue;
      seen.add(adapter.id);
      adapters.push(adapter);
    } catch {
      // One malformed local record cannot prevent usable adapters from loading.
    }
  }
  return adapters;
}

export function readCustomTtsAdapters(dataRoot) {
  const filePath = customTtsAdaptersPath(dataRoot);
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return [];
    return normalizeCustomTtsAdapters(JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "")));
  } catch {
    return [];
  }
}

export function findCustomTtsAdapter(dataRoot, id) {
  const identity = clean(id).toLowerCase();
  return readCustomTtsAdapters(dataRoot).find((item) => item.id === identity) || null;
}

export function publicCustomTtsAdapter(value) {
  const adapter = normalizeCustomTtsAdapter(value);
  return {
    id: adapter.id,
    name: adapter.name,
    baseUrl: adapter.baseUrl,
    endpointPath: adapter.endpointPath,
    responseMode: adapter.responseMode,
    audioPath: adapter.audioPath,
    outputFormat: adapter.outputFormat,
    createdAt: adapter.createdAt,
  };
}

export function interpolateCustomTtsTemplate(value, variables) {
  if (Array.isArray(value)) return value.map((item) => interpolateCustomTtsTemplate(item, variables));
  if (isPlainObject(value)) {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = interpolateCustomTtsTemplate(item, variables);
    return result;
  }
  if (typeof value !== "string") return value;
  const exact = value.match(/^\{\{(text|model|voice|apiKey)\}\}$/u);
  if (exact) return String(variables?.[exact[1]] ?? "");
  return value.replace(/\{\{(text|model|voice|apiKey)\}\}/gu, (_match, key) => String(variables?.[key] ?? ""));
}

export function interpolateCustomTtsEndpointPath(value, variables) {
  return clean(value).replace(/\{\{voice\}\}/gu, () => encodeURIComponent(String(variables?.voice ?? "")));
}

export function valueAtCustomTtsPath(value, rawPath) {
  const sourcePath = clean(rawPath);
  if (!JSON_PATH.test(sourcePath)) return undefined;
  const tokens = sourcePath.match(/[A-Za-z_$][\w$]*|\d+/gu) || [];
  let current = value;
  for (const token of tokens) {
    if (current === null || current === undefined || BLOCKED_KEYS.has(token)) return undefined;
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isSafeInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (!isPlainObject(current) || !Object.hasOwn(current, token)) return undefined;
    current = current[token];
  }
  return current;
}
