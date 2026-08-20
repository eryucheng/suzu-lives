function clean(value) {
  return String(value ?? "").trim();
}

export const TTS_ADAPTERS = Object.freeze({
  "openai-speech": Object.freeze({
    id: "openai-speech",
    label: "OpenAI Compatible TTS",
    detail: "适用于实现 OpenAI /audio/speech 协议的语音服务。",
    connectionTypes: Object.freeze(["openai-compatible"]),
    defaultBaseUrl: "",
    defaultModel: "",
    ledgerProvider: "OpenAI Compatible",
  }),
  "siliconflow-speech": Object.freeze({
    id: "siliconflow-speech",
    label: "硅基流动 TTS",
    detail: "使用硅基流动的 OpenAI 兼容语音合成接口。",
    connectionTypes: Object.freeze(["openai-compatible"]),
    defaultBaseUrl: "https://api.siliconflow.cn/v1",
    defaultModel: "FunAudioLLM/CosyVoice2-0.5B",
    ledgerProvider: "硅基流动",
  }),
  "fishaudio-speech": Object.freeze({
    id: "fishaudio-speech",
    label: "Fish Audio TTS",
    detail: "使用 Fish Audio 的 OpenAI 兼容语音合成接口。",
    connectionTypes: Object.freeze(["openai-compatible"]),
    defaultBaseUrl: "https://api.fish.audio",
    defaultModel: "fishaudio/fish-speech-1.5",
    ledgerProvider: "Fish Audio",
  }),
  "dashscope-qwen": Object.freeze({
    id: "dashscope-qwen",
    label: "阿里百炼 Qwen TTS",
    detail: "使用阿里百炼 Qwen 文字转语音协议。",
    connectionTypes: Object.freeze(["dashscope"]),
    defaultBaseUrl: "https://dashscope.aliyuncs.com/api/v1",
    defaultModel: "qwen3-tts-vd-2026-01-26",
    ledgerProvider: "阿里云百炼",
  }),
  "dashscope-cosyvoice": Object.freeze({
    id: "dashscope-cosyvoice",
    label: "阿里百炼 CosyVoice",
    detail: "使用阿里百炼 CosyVoice 文字转语音协议。",
    connectionTypes: Object.freeze(["dashscope"]),
    defaultBaseUrl: "https://dashscope.aliyuncs.com/api/v1",
    defaultModel: "cosyvoice-v3.5-plus",
    ledgerProvider: "阿里云百炼",
  }),
  "minimax-speech": Object.freeze({
    id: "minimax-speech",
    label: "MiniMax TTS",
    detail: "使用 MiniMax T2A 协议；请在通用 API 连接中填写服务地址与 Key。",
    connectionTypes: Object.freeze(["generic-api"]),
    defaultBaseUrl: "https://api.minimax.io/v1",
    defaultModel: "speech-2.8-hd",
    ledgerProvider: "MiniMax",
  }),
});

const LEGACY_ADAPTERS = Object.freeze({
  bailian: "dashscope-qwen",
  cosyvoice: "dashscope-cosyvoice",
  dashscope: "dashscope-qwen",
  minimax: "minimax-speech",
  openai: "openai-speech",
  "openai-compatible": "openai-speech",
  qwen: "dashscope-qwen",
});

export function normalizeTtsAdapter(value, { fallback = "" } = {}) {
  const candidate = clean(value).toLowerCase();
  if (Object.hasOwn(TTS_ADAPTERS, candidate)) return candidate;
  if (Object.hasOwn(LEGACY_ADAPTERS, candidate)) return LEGACY_ADAPTERS[candidate];
  return fallback;
}

export function ttsAdapterDefinition(value, { fallback = "" } = {}) {
  const id = normalizeTtsAdapter(value, { fallback });
  return TTS_ADAPTERS[id] || null;
}

export function ttsAdapterLabel(value, { fallback = "" } = {}) {
  return ttsAdapterDefinition(value, { fallback })?.label || "未识别的语音适配器";
}

function hostnameFromUrl(value) {
  try {
    const url = new URL(clean(value));
    return ["http:", "https:"].includes(url.protocol) ? url.hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}

function isOfficialDashScopeEndpoint(value) {
  return hostnameFromUrl(value) === "dashscope.aliyuncs.com";
}

/**
 * Correct the old default only when its service identity is unambiguous.
 *
 * Older builds let a DashScope CosyVoice sound be saved as the default
 * `openai-speech` adapter.  The selected connection still carries its real
 * endpoint and the voice record carries its CosyVoice model/voice ID, so we
 * can safely use the DashScope request shape without changing user data.
 */
export function resolveTtsAdapterForService({ adapter, baseUrl = "", model = "", voiceId = "" } = {}) {
  const configured = normalizeTtsAdapter(adapter);
  if (configured !== "openai-speech" || !isOfficialDashScopeEndpoint(baseUrl)) return configured;
  const identity = `${clean(model)} ${clean(voiceId)}`.toLowerCase();
  if (identity.includes("cosyvoice")) return "dashscope-cosyvoice";
  if (identity.includes("qwen3-tts") || identity.includes("qwen-tts")) return "dashscope-qwen";
  return configured;
}

export function ttsAdapterSupportsConnection(adapter, connectionType) {
  const type = clean(connectionType).toLowerCase();
  // TTS API 是通用语音连接：地址、Key、模型都由用户填写，协议由所选音色的适配器决定。
  if (type === "tts-api") return true;
  const definition = ttsAdapterDefinition(adapter);
  return Boolean(definition?.connectionTypes.includes(type));
}

export const TTS_ADAPTER_OPTIONS = Object.freeze(Object.values(TTS_ADAPTERS).map(({ id, label }) => Object.freeze({ label, value: id })));
