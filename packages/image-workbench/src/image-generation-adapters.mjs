function clean(value) {
  return String(value ?? "").trim();
}

export const DEFAULT_IMAGE_GENERATION_ADAPTER = "auto";

export const IMAGE_GENERATION_ADAPTERS = Object.freeze({
  auto: Object.freeze({
    id: "auto",
    label: "自动匹配 API",
    detail: "按已选 API 的服务类型使用对应的图像生成请求格式。",
    connectionTypes: Object.freeze(["openai-compatible", "dashscope", "generic-api"]),
  }),
  "openai-images": Object.freeze({
    id: "openai-images",
    label: "OpenAI Images",
    detail: "OpenAI Images API 的图片生成和编辑请求格式。",
    connectionTypes: Object.freeze(["openai-compatible", "generic-api"]),
  }),
  "dashscope-image": Object.freeze({
    id: "dashscope-image",
    label: "百炼图像生成",
    detail: "DashScope 原生图像生成接口。",
    connectionTypes: Object.freeze(["dashscope", "generic-api"]),
  }),
  "custom-http-image": Object.freeze({
    id: "custom-http-image",
    label: "自定义图像协议",
    detail: "使用保存的请求模板和图片返回方式。",
    connectionTypes: Object.freeze(["openai-compatible", "dashscope", "generic-api"]),
  }),
});

const LEGACY_ADAPTERS = Object.freeze({
  dashscope: "dashscope-image",
  openai: "openai-images",
  "openai-compatible": "openai-images",
});

export const IMAGE_GENERATION_ADAPTER_OPTIONS = Object.freeze(
  Object.values(IMAGE_GENERATION_ADAPTERS).map(({ id, label }) => Object.freeze({ label, value: id })),
);

export function normalizeImageGenerationAdapter(value, { fallback = DEFAULT_IMAGE_GENERATION_ADAPTER } = {}) {
  const candidate = clean(value).toLowerCase();
  if (Object.hasOwn(IMAGE_GENERATION_ADAPTERS, candidate)) return candidate;
  if (Object.hasOwn(LEGACY_ADAPTERS, candidate)) return LEGACY_ADAPTERS[candidate];
  return fallback;
}

export function imageGenerationAdapterDefinition(value, { fallback = DEFAULT_IMAGE_GENERATION_ADAPTER } = {}) {
  const id = normalizeImageGenerationAdapter(value, { fallback });
  return IMAGE_GENERATION_ADAPTERS[id] || null;
}

export function imageGenerationAdapterLabel(value, { fallback = DEFAULT_IMAGE_GENERATION_ADAPTER } = {}) {
  return imageGenerationAdapterDefinition(value, { fallback })?.label || "未识别的图像协议";
}

export function imageGenerationAdapterSupportsConnection(adapter, connectionType) {
  const definition = imageGenerationAdapterDefinition(adapter, { fallback: "" });
  return Boolean(definition?.connectionTypes.includes(clean(connectionType).toLowerCase()));
}

export function resolveImageGenerationAdapter(adapter, { connectionType = "" } = {}) {
  const selected = normalizeImageGenerationAdapter(adapter, { fallback: DEFAULT_IMAGE_GENERATION_ADAPTER });
  if (selected !== "auto") return selected;
  return clean(connectionType).toLowerCase() === "dashscope" ? "dashscope-image" : "openai-images";
}
