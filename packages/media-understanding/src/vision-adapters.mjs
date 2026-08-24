function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    ? value
    : {};
}

function httpUrl(value, label = "模型地址") {
  const source = clean(value).replace(/\/+$/u, "");
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    throw new Error(`${label}必须是 http 或 https 地址。`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`${label}必须是 http 或 https 地址。`);
  return source;
}

function appendEndpoint(baseUrl, endpoint, { accepted = [] } = {}) {
  const base = httpUrl(baseUrl);
  const pathname = new URL(base).pathname.replace(/\/+$/u, "");
  if (accepted.some((suffix) => pathname.endsWith(suffix))) return base;
  return `${base}${endpoint}`;
}

function dataUrlParts(value) {
  const matched = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/u.exec(clean(value));
  if (!matched) throw new Error("图片数据不是可用的 Base64 Data URL。 ");
  return { base64: matched[2].replace(/\s+/gu, ""), mimeType: matched[1] };
}

function textFromValue(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((item) => textFromValue(item)).filter(Boolean).join("\n").trim();
  const source = plainObject(value);
  if (typeof source.text === "string") return source.text.trim();
  if (typeof source.content === "string") return source.content.trim();
  return "";
}

function textAtPath(value, rawPath) {
  const sourcePath = clean(rawPath);
  if (!/^[A-Za-z_$][\w$]*(?:\[\d+\]|\.[A-Za-z_$][\w$]*)*$/u.test(sourcePath)) return undefined;
  const tokens = sourcePath.match(/[A-Za-z_$][\w$]*|\d+/gu) || [];
  let current = value;
  for (const token of tokens) {
    if (current === null || current === undefined || ["__proto__", "prototype", "constructor"].includes(token)) return undefined;
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isSafeInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    const source = plainObject(current);
    if (!Object.hasOwn(source, token)) return undefined;
    current = source[token];
  }
  return current;
}

function interpolateTemplate(value, variables) {
  if (Array.isArray(value)) return value.map((item) => interpolateTemplate(item, variables));
  const source = plainObject(value);
  if (Object.keys(source).length) {
    return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, interpolateTemplate(item, variables)]));
  }
  if (typeof value !== "string") return value;
  return value.replace(/\{\{(apiKey|detail|imageBase64|imageDataUrl|imageMimeType|model|question|systemPrompt)\}\}/gu, (_match, key) => String(variables[key] ?? ""));
}

function openAiCompatibleBaseUrl(baseUrl) {
  const configured = httpUrl(baseUrl);
  try {
    const parsed = new URL(configured);
    const hostname = parsed.hostname.toLocaleLowerCase("en-US");
    const pathname = parsed.pathname.replace(/\/+$/u, "");
    if (hostname === "dashscope.aliyuncs.com" && pathname === "/api/v1") return `${parsed.origin}/compatible-mode/v1`;
  } catch {
    // httpUrl already validates the value.  This guard keeps host rewriting best-effort.
  }
  return configured;
}

function dashscopeEndpoint(baseUrl) {
  return appendEndpoint(baseUrl, "/services/aigc/multimodal-generation/generation", {
    accepted: ["/services/aigc/multimodal-generation/generation"],
  });
}

function geminiEndpoint(baseUrl, model) {
  const base = httpUrl(baseUrl);
  const parsed = new URL(base);
  if (/:[^/]*generateContent$/u.test(parsed.pathname)) return base;
  const modelId = encodeURIComponent(clean(model));
  if (!modelId) throw new Error("Gemini 模型不能为空。 ");
  const pathname = parsed.pathname.replace(/\/+$/u, "");
  if (pathname.endsWith("/v1beta") || pathname.endsWith("/v1")) return `${base}/models/${modelId}:generateContent`;
  return `${base}/v1beta/models/${modelId}:generateContent`;
}

function joinCustomEndpoint(baseUrl, endpointPath) {
  const base = httpUrl(baseUrl, "服务地址");
  const endpoint = clean(endpointPath);
  if (!endpoint.startsWith("/") || endpoint.startsWith("//") || endpoint.includes("://")) {
    throw new Error("自定义视觉协议的接口路径无效。 ");
  }
  return `${base}${endpoint}`;
}

export const DEFAULT_VISION_ADAPTER = "openai-chat-completions";

export const VISION_ADAPTERS = Object.freeze({
  "openai-chat-completions": Object.freeze({
    id: "openai-chat-completions",
    label: "OpenAI Chat Completions",
    detail: "OpenAI 兼容协议，也适用于百炼兼容模式。",
    connectionTypes: Object.freeze(["openai-compatible", "dashscope", "generic-api"]),
    ledgerProvider: "OpenAI Compatible",
  }),
  "openai-responses": Object.freeze({
    id: "openai-responses",
    label: "OpenAI Responses",
    detail: "OpenAI Responses API 的图片输入格式。",
    connectionTypes: Object.freeze(["openai-compatible", "generic-api"]),
    ledgerProvider: "OpenAI",
  }),
  "anthropic-messages": Object.freeze({
    id: "anthropic-messages",
    label: "Anthropic Messages",
    detail: "Claude 原生 Messages API 的 Base64 图片格式。",
    connectionTypes: Object.freeze(["generic-api"]),
    ledgerProvider: "Anthropic",
  }),
  "gemini-generate-content": Object.freeze({
    id: "gemini-generate-content",
    label: "Gemini generateContent",
    detail: "Gemini 原生 generateContent API 的 inlineData 图片格式。",
    connectionTypes: Object.freeze(["generic-api"]),
    ledgerProvider: "Google Gemini",
  }),
  "dashscope-multimodal": Object.freeze({
    id: "dashscope-multimodal",
    label: "百炼多模态",
    detail: "DashScope 原生多模态对话接口。",
    connectionTypes: Object.freeze(["dashscope", "generic-api"]),
    ledgerProvider: "阿里云百炼",
  }),
  "custom-http-vision": Object.freeze({
    id: "custom-http-vision",
    label: "自定义视觉协议",
    detail: "使用本机保存的请求模板和文字返回位置。",
    connectionTypes: Object.freeze(["openai-compatible", "dashscope", "generic-api"]),
    ledgerProvider: "自定义视觉服务",
  }),
});

const LEGACY_ADAPTERS = Object.freeze({
  anthropic: "anthropic-messages",
  dashscope: "dashscope-multimodal",
  gemini: "gemini-generate-content",
  openai: "openai-chat-completions",
  "openai-compatible": "openai-chat-completions",
});

export const VISION_ADAPTER_OPTIONS = Object.freeze(Object.values(VISION_ADAPTERS).map(({ id, label }) => Object.freeze({ label, value: id })));

export function normalizeVisionAdapter(value, { fallback = DEFAULT_VISION_ADAPTER } = {}) {
  const candidate = clean(value).toLowerCase();
  if (Object.hasOwn(VISION_ADAPTERS, candidate)) return candidate;
  if (Object.hasOwn(LEGACY_ADAPTERS, candidate)) return LEGACY_ADAPTERS[candidate];
  return fallback;
}

export function visionAdapterDefinition(value, { fallback = DEFAULT_VISION_ADAPTER } = {}) {
  const id = normalizeVisionAdapter(value, { fallback });
  return VISION_ADAPTERS[id] || null;
}

export function visionAdapterLabel(value, { fallback = DEFAULT_VISION_ADAPTER } = {}) {
  return visionAdapterDefinition(value, { fallback })?.label || "未识别的视觉协议";
}

export function visionAdapterSupportsConnection(adapter, connectionType) {
  const definition = visionAdapterDefinition(adapter, { fallback: "" });
  return Boolean(definition?.connectionTypes.includes(clean(connectionType).toLowerCase()));
}

export function visionAdapterLedgerProvider(adapter, { customAdapter = null } = {}) {
  const normalized = normalizeVisionAdapter(adapter, { fallback: "" });
  if (normalized === "custom-http-vision" && clean(customAdapter?.name)) return clean(customAdapter.name);
  return visionAdapterDefinition(normalized, { fallback: "" })?.ledgerProvider || "视觉模型";
}

export function visionAdapterEndpointCompatibilityError({ adapter, baseUrl = "" } = {}) {
  const normalized = normalizeVisionAdapter(adapter, { fallback: "" });
  if (normalized !== "dashscope-multimodal") return "";
  try {
    const parsed = new URL(clean(baseUrl));
    if (/\/compatible-mode\/v1\/?$/iu.test(parsed.pathname)) {
      return "百炼多模态需要原生 API 地址（以 /api/v1 结尾），不能使用 /compatible-mode/v1。";
    }
  } catch {
    // The caller reports invalid or missing endpoints separately.
  }
  return "";
}

export function createVisionHttpRequest({
  adapter = DEFAULT_VISION_ADAPTER,
  apiKey = "",
  baseUrl = "",
  customAdapter = null,
  detail = "auto",
  imageDataUrl = "",
  imageMimeType = "",
  maxOutputTokens = 800,
  model = "",
  question = "",
  systemPrompt = "",
} = {}) {
  const normalized = normalizeVisionAdapter(adapter, { fallback: "" });
  const definition = visionAdapterDefinition(normalized, { fallback: "" });
  if (!definition) throw new Error("图像理解协议无效。 ");
  const key = clean(apiKey);
  if (!key) throw new Error("没有可用的视觉 API Key。 ");
  const selectedModel = clean(model);
  if (normalized !== "custom-http-vision" && !selectedModel) {
    throw new Error("视觉模型不能为空。 ");
  }
  if (normalized !== "custom-http-vision" && !clean(baseUrl)) {
    throw new Error("视觉模型地址不能为空。 ");
  }
  const prompt = clean(question);
  const instruction = clean(systemPrompt);
  const data = clean(imageDataUrl);
  const parts = dataUrlParts(data);
  const mimeType = clean(imageMimeType) || parts.mimeType;
  const maxTokens = Math.max(1, Number.parseInt(maxOutputTokens, 10) || 800);
  const imageDetail = clean(detail).toLowerCase() || "auto";
  const commonHeaders = { "Content-Type": "application/json", "User-Agent": "suzu-lives-image-vision/1.0" };

  if (normalized === "openai-chat-completions") {
    const endpoint = appendEndpoint(openAiCompatibleBaseUrl(baseUrl), "/chat/completions", { accepted: ["/chat/completions"] });
    return {
      adapter: normalized,
      endpoint,
      headers: { ...commonHeaders, Authorization: `Bearer ${key}` },
      body: {
        model: selectedModel,
        messages: [
          { role: "system", content: instruction },
          { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: data, detail: imageDetail } }] },
        ],
        temperature: 0.2,
        max_tokens: maxTokens,
      },
    };
  }

  if (normalized === "openai-responses") {
    const endpoint = appendEndpoint(baseUrl, "/responses", { accepted: ["/responses"] });
    return {
      adapter: normalized,
      endpoint,
      headers: { ...commonHeaders, Authorization: `Bearer ${key}` },
      body: {
        model: selectedModel,
        instructions: instruction,
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: data, detail: imageDetail },
          ],
        }],
        max_output_tokens: maxTokens,
      },
    };
  }

  if (normalized === "anthropic-messages") {
    const endpoint = appendEndpoint(baseUrl, "/messages", { accepted: ["/messages"] });
    return {
      adapter: normalized,
      endpoint,
      headers: { ...commonHeaders, "anthropic-version": "2023-06-01", "x-api-key": key },
      body: {
        model: selectedModel,
        max_tokens: maxTokens,
        system: instruction,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image", source: { type: "base64", media_type: mimeType, data: parts.base64 } },
          ],
        }],
      },
    };
  }

  if (normalized === "gemini-generate-content") {
    return {
      adapter: normalized,
      endpoint: geminiEndpoint(baseUrl, selectedModel),
      headers: { ...commonHeaders, "x-goog-api-key": key },
      body: {
        system_instruction: { parts: [{ text: instruction }] },
        contents: [{
          role: "user",
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: parts.base64 } },
          ],
        }],
        generationConfig: { maxOutputTokens: maxTokens },
      },
    };
  }

  if (normalized === "dashscope-multimodal") {
    return {
      adapter: normalized,
      endpoint: dashscopeEndpoint(baseUrl),
      headers: { ...commonHeaders, Authorization: `Bearer ${key}` },
      body: {
        model: selectedModel,
        input: {
          messages: [
            { role: "system", content: [{ text: instruction }] },
            { role: "user", content: [{ image: data }, { text: prompt }] },
          ],
        },
        parameters: { max_tokens: maxTokens },
      },
    };
  }

  const custom = plainObject(customAdapter);
  if (!clean(custom.baseUrl) || !clean(custom.endpointPath) || !custom.requestBody || !clean(custom.responseTextPath)) {
    throw new Error("请先选择已保存的自定义视觉协议。 ");
  }
  const variables = {
    apiKey: key,
    detail: imageDetail,
    imageBase64: parts.base64,
    imageDataUrl: data,
    imageMimeType: mimeType,
    model: selectedModel,
    question: prompt,
    systemPrompt: instruction,
  };
  const customHeaders = plainObject(interpolateTemplate(custom.requestHeaders, variables));
  return {
    adapter: normalized,
    endpoint: joinCustomEndpoint(custom.baseUrl, custom.endpointPath),
    headers: { ...commonHeaders, ...Object.fromEntries(Object.entries(customHeaders).map(([name, value]) => [name, String(value ?? "")])) },
    body: interpolateTemplate(custom.requestBody, variables),
  };
}

export function extractVisionResponseText({ adapter = DEFAULT_VISION_ADAPTER, customAdapter = null, payload } = {}) {
  const normalized = normalizeVisionAdapter(adapter, { fallback: "" });
  const source = plainObject(payload);
  let value = "";
  if (normalized === "openai-chat-completions") value = source?.choices?.[0]?.message?.content;
  else if (normalized === "openai-responses") {
    value = source.output_text;
    if (!textFromValue(value)) value = (Array.isArray(source.output) ? source.output : []).flatMap((item) => Array.isArray(item?.content) ? item.content : []);
  } else if (normalized === "anthropic-messages") value = source.content;
  else if (normalized === "gemini-generate-content") value = source?.candidates?.[0]?.content?.parts;
  else if (normalized === "dashscope-multimodal") value = source?.output?.choices?.[0]?.message?.content;
  else if (normalized === "custom-http-vision") value = textAtPath(source, plainObject(customAdapter).responseTextPath);
  const text = textFromValue(value);
  if (!text) throw new Error("视觉模型返回中缺少可用文字内容。 ");
  return text;
}
