function preset(value) {
  return Object.freeze({
    type: String(value?.type || "").trim(),
    value: String(value?.value || "").trim(),
    label: String(value?.label || "").trim(),
    baseUrl: String(value?.baseUrl || "").trim(),
  });
}

export const DEFAULT_DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";

export const API_CONNECTION_TYPE_OPTIONS = Object.freeze([
  Object.freeze({ label: "TTS API", value: "tts-api" }),
  Object.freeze({ label: "ASR API", value: "asr-api" }),
  Object.freeze({ label: "OpenAI 兼容", value: "openai-compatible" }),
  Object.freeze({ label: "DashScope", value: "dashscope" }),
  Object.freeze({ label: "其他 API", value: "generic-api" }),
]);

export const API_CONNECTION_ENDPOINT_PRESETS = Object.freeze([
  preset({ type: "openai-compatible", value: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1" }),
  preset({ type: "openai-compatible", value: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" }),
  preset({ type: "openai-compatible", value: "moonshot", label: "Moonshot Kimi", baseUrl: "https://api.moonshot.cn/v1" }),
  preset({ type: "openai-compatible", value: "zhipu", label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4" }),
  preset({ type: "openai-compatible", value: "tongyi", label: "通义（兼容模式）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }),
  preset({ type: "openai-compatible", value: "ollama", label: "本地 Ollama", baseUrl: "http://127.0.0.1:11434/v1" }),
  preset({ type: "dashscope", value: "dashscope", label: "DashScope", baseUrl: DEFAULT_DASHSCOPE_BASE_URL }),
]);

export function apiConnectionEndpointPreset(value) {
  const id = String(value || "").trim().toLowerCase();
  return API_CONNECTION_ENDPOINT_PRESETS.find((entry) => entry.value === id) || null;
}
