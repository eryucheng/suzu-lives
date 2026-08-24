function clean(value) {
  return String(value ?? "").trim();
}

export const DEFAULT_VIDEO_ADAPTER = "dashscope-openai-video";

export const VIDEO_ADAPTERS = Object.freeze({
  "dashscope-openai-video": Object.freeze({
    id: "dashscope-openai-video",
    label: "百炼视频理解（Qwen-VL / QVQ）",
    detail: "百炼兼容模式的完整视频输入格式。",
    connectionTypes: Object.freeze(["dashscope", "generic-api", "openai-compatible"]),
    ledgerProvider: "阿里云百炼",
  }),
  "gemini-generate-content-video": Object.freeze({
    id: "gemini-generate-content-video",
    label: "Gemini 视频理解",
    detail: "Gemini generateContent 的 inlineData 视频输入格式。",
    connectionTypes: Object.freeze(["generic-api"]),
    ledgerProvider: "Google Gemini",
  }),
  "custom-http-video": Object.freeze({
    id: "custom-http-video",
    label: "自定义视频协议",
    detail: "使用本机保存的请求模板和文字返回位置。",
    connectionTypes: Object.freeze(["dashscope", "generic-api", "openai-compatible"]),
    ledgerProvider: "自定义视频服务",
  }),
});

const LEGACY_ADAPTERS = Object.freeze({
  dashscope: "dashscope-openai-video",
  openai: "dashscope-openai-video",
  "openai-chat-completions": "dashscope-openai-video",
  "openai-compatible": "dashscope-openai-video",
});

export const VIDEO_ADAPTER_OPTIONS = Object.freeze(Object.values(VIDEO_ADAPTERS).map(({ id, label }) => Object.freeze({ label, value: id })));

export function normalizeVideoAdapter(value, { fallback = DEFAULT_VIDEO_ADAPTER } = {}) {
  const candidate = clean(value).toLowerCase();
  if (Object.hasOwn(VIDEO_ADAPTERS, candidate)) return candidate;
  if (Object.hasOwn(LEGACY_ADAPTERS, candidate)) return LEGACY_ADAPTERS[candidate];
  return fallback;
}

export function videoAdapterDefinition(value, { fallback = DEFAULT_VIDEO_ADAPTER } = {}) {
  const id = normalizeVideoAdapter(value, { fallback });
  return VIDEO_ADAPTERS[id] || null;
}

export function videoAdapterLabel(value, { fallback = DEFAULT_VIDEO_ADAPTER } = {}) {
  return videoAdapterDefinition(value, { fallback })?.label || "未识别的视频协议";
}

export function videoAdapterSupportsConnection(adapter, connectionType) {
  const definition = videoAdapterDefinition(adapter, { fallback: "" });
  return Boolean(definition?.connectionTypes.includes(clean(connectionType).toLowerCase()));
}

export function videoAdapterLedgerProvider(adapter, { customAdapter = null } = {}) {
  const normalized = normalizeVideoAdapter(adapter, { fallback: "" });
  if (normalized === "custom-http-video" && clean(customAdapter?.name)) return clean(customAdapter.name);
  return videoAdapterDefinition(normalized, { fallback: "" })?.ledgerProvider || "视频模型";
}
