import {
  imageGenerationAdapterLabel,
  imageGenerationAdapterSupportsConnection,
  resolveImageGenerationAdapter,
} from "./image-generation-adapters.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function modelKey(value) {
  return clean(value).toLocaleLowerCase("en-US");
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function customTemplateIncludesReferenceImages(value) {
  if (typeof value === "string") return value.includes("{{referenceImages}}");
  if (Array.isArray(value)) return value.some(customTemplateIncludesReferenceImages);
  return Object.values(plainObject(value)).some(customTemplateIncludesReferenceImages);
}

export const DEFAULT_IMAGE_REFERENCE_ADAPTER = "none";

export const IMAGE_REFERENCE_ADAPTERS = Object.freeze({
  none: Object.freeze({
    id: "none",
    label: "不发送参考图",
    detail: "只生成提示词图片，不向模型上传视觉参考。",
    imageGenerationAdapters: Object.freeze([]),
    maxReferences: 0,
  }),
  "openai-images-edit": Object.freeze({
    id: "openai-images-edit",
    label: "OpenAI Images 编辑（multipart）",
    detail: "通过 /images/edits 及 image[] 表单字段发送参考图。",
    imageGenerationAdapters: Object.freeze(["openai-images"]),
    maxReferences: 16,
  }),
  "dashscope-multimodal": Object.freeze({
    id: "dashscope-multimodal",
    label: "DashScope 多模态图片",
    detail: "将参考图作为 messages.content 的图片段发送。",
    imageGenerationAdapters: Object.freeze(["dashscope-image"]),
    maxReferences: 9,
  }),
  "custom-data-url-array": Object.freeze({
    id: "custom-data-url-array",
    label: "自定义 JSON Data URL 数组",
    detail: "将参考图作为 {{referenceImages}} 的 Data URL 数组放入自定义请求 JSON。",
    imageGenerationAdapters: Object.freeze(["custom-http-image"]),
    maxReferences: 16,
  }),
});

export const IMAGE_REFERENCE_ADAPTER_OPTIONS = Object.freeze(
  Object.values(IMAGE_REFERENCE_ADAPTERS).map(({ id, label }) => Object.freeze({ id, label })),
);

export function normalizeImageReferenceAdapter(value, { fallback = DEFAULT_IMAGE_REFERENCE_ADAPTER } = {}) {
  const candidate = clean(value).toLowerCase();
  return Object.hasOwn(IMAGE_REFERENCE_ADAPTERS, candidate) ? candidate : fallback;
}

export function imageReferenceAdapterDefinition(value, { fallback = DEFAULT_IMAGE_REFERENCE_ADAPTER } = {}) {
  const id = normalizeImageReferenceAdapter(value, { fallback });
  return IMAGE_REFERENCE_ADAPTERS[id] || null;
}

export function imageReferenceAdapterLabel(value, { fallback = DEFAULT_IMAGE_REFERENCE_ADAPTER } = {}) {
  return imageReferenceAdapterDefinition(value, { fallback })?.label || "未识别的参考图适配器";
}

export function imageReferenceAdapterSupportsImageGenerationAdapter(referenceAdapter, imageGenerationAdapter, { connectionType = "" } = {}) {
  const definition = imageReferenceAdapterDefinition(referenceAdapter, { fallback: "" });
  if (!definition) return false;
  if (definition.id === DEFAULT_IMAGE_REFERENCE_ADAPTER) return true;
  const protocol = resolveImageGenerationAdapter(imageGenerationAdapter, { connectionType });
  return definition.imageGenerationAdapters.includes(protocol);
}

export function imageReferenceAdapterOptions({ imageGenerationAdapter = "auto", connectionType = "" } = {}) {
  const selected = clean(imageGenerationAdapter).toLowerCase();
  const definitions = selected === "auto" && !clean(connectionType)
    ? Object.values(IMAGE_REFERENCE_ADAPTERS)
    : Object.values(IMAGE_REFERENCE_ADAPTERS).filter((definition) => imageReferenceAdapterSupportsImageGenerationAdapter(definition.id, imageGenerationAdapter, { connectionType }));
  return definitions.map(({ id, label }) => Object.freeze([id, label]));
}

function unavailable({ adapter, model, protocol, reason }) {
  const definition = imageReferenceAdapterDefinition(adapter);
  return Object.freeze({
    adapter,
    adapterLabel: definition?.label || "未识别的参考图适配器",
    detail: definition?.detail || "",
    maxReferences: 0,
    model,
    protocol,
    reason,
    supported: false,
  });
}

/**
 * Resolves the reference-image contract independently from the overall image
 * request protocol.  A model change must not silently reuse the former
 * model's image payload shape.
 */
export function imageReferenceCapability({
  connection = {},
  customImageGenerationAdapter = null,
  imageGenerationAdapter = "auto",
  referenceImageAdapter = DEFAULT_IMAGE_REFERENCE_ADAPTER,
  referenceImageModel = "",
} = {}) {
  const adapter = normalizeImageReferenceAdapter(referenceImageAdapter);
  const definition = imageReferenceAdapterDefinition(adapter);
  const model = clean(connection?.model);
  const confirmedModel = clean(referenceImageModel);
  const connectionType = clean(connection?.type);
  const protocol = resolveImageGenerationAdapter(imageGenerationAdapter, { connectionType: clean(connection?.type) });
  const protocolLabel = imageGenerationAdapterLabel(protocol);

  if (connectionType && !imageGenerationAdapterSupportsConnection(imageGenerationAdapter, connectionType)) {
    return unavailable({
      adapter,
      model,
      protocol,
      reason: `当前选中的 API 类型“${connectionType}”不能使用“${protocolLabel}”请求协议，因此无法确定参考图的上传格式。请先选择兼容的 API，再配置参考图适配器。`,
    });
  }

  if (!model) {
    return unavailable({
      adapter,
      model,
      protocol,
      reason: "当前生图 API 没有填写模型名，无法判断参考图的请求格式。请先在“设置 → API”为生图连接填写模型名，再到“能力 → 图像生成”选择并保存对应的参考图适配器。",
    });
  }

  if (adapter === DEFAULT_IMAGE_REFERENCE_ADAPTER) {
    return unavailable({
      adapter,
      model,
      protocol,
      reason: `模型“${model}”尚未配置参考图适配器。普通文生图仍可使用；为了避免按错误格式上传图片，参考图已禁用。请到“能力 → 图像生成”按服务商文档选择对应的参考图适配器。`,
    });
  }

  if (!definition?.imageGenerationAdapters.includes(protocol)) {
    return unavailable({
      adapter,
      model,
      protocol,
      reason: `参考图适配器“${definition?.label || adapter}”要求的请求协议与当前“${protocolLabel}”不一致。为了避免把参考图按错误格式上传，参考图已禁用；请在“能力 → 图像生成”选择与当前 API 对应的适配器。`,
    });
  }

  if (confirmedModel && modelKey(confirmedModel) !== modelKey(model)) {
    return unavailable({
      adapter,
      model,
      protocol,
      reason: `参考图适配器“${definition.label}”已配置为模型“${confirmedModel}”使用，但当前生图 API 使用的是“${model}”。模型切换后不能沿用旧格式，参考图已禁用；请到“能力 → 图像生成”重新选择并保存匹配的适配器。`,
    });
  }

  if (adapter === "custom-data-url-array") {
    const custom = plainObject(customImageGenerationAdapter);
    const name = clean(custom.name) || "当前自定义图像协议";
    if (!customTemplateIncludesReferenceImages(custom.requestBody)) {
      return unavailable({
        adapter,
        model,
        protocol,
        reason: `自定义图像协议“${name}”的请求 JSON 没有 {{referenceImages}}。该适配器只能把参考图作为 Data URL 数组放入这个变量，参考图已禁用；请在协议模板中加入该变量，或改用匹配的参考图适配器。`,
      });
    }
  }

  return Object.freeze({
    adapter,
    adapterLabel: definition.label,
    detail: definition.detail,
    maxReferences: definition.maxReferences,
    model,
    protocol,
    reason: "",
    supported: true,
  });
}
