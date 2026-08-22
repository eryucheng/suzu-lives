function clean(value) {
  return String(value ?? "").trim();
}

export const TTS_ADAPTERS = Object.freeze({
  "openai-speech": Object.freeze({
    id: "openai-speech",
    label: "OpenAI TTS",
    detail: "使用 OpenAI 官方文字转语音接口。",
    connectionTypes: Object.freeze(["openai-compatible"]),
    defaultBaseUrl: "https://api.openai.com/v1",
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
  "xiaomi-mimo-tts": Object.freeze({
    id: "xiaomi-mimo-tts",
    label: "小米 MiMo TTS",
    detail: "使用小米 MiMo V2.5 语音合成接口。",
    connectionTypes: Object.freeze(["tts-api", "openai-compatible", "generic-api"]),
    defaultBaseUrl: "https://api.xiaomimimo.com/v1",
    defaultModel: "mimo-v2.5-tts",
    ledgerProvider: "小米 MiMo",
  }),
  "elevenlabs-speech": Object.freeze({
    id: "elevenlabs-speech",
    label: "ElevenLabs TTS",
    detail: "使用 ElevenLabs 标准文字转语音接口。",
    connectionTypes: Object.freeze(["tts-api", "openai-compatible", "generic-api"]),
    defaultBaseUrl: "https://api.elevenlabs.io",
    defaultModel: "eleven_multilingual_v2",
    ledgerProvider: "ElevenLabs",
  }),
  "custom-http-tts": Object.freeze({
    id: "custom-http-tts",
    label: "自定义 JSON TTS",
    detail: "使用本机保存的请求模板、音频返回位置与格式。",
    connectionTypes: Object.freeze(["tts-api", "openai-compatible", "generic-api"]),
    defaultBaseUrl: "",
    defaultModel: "",
    ledgerProvider: "自定义 TTS",
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

// These are the original bare CosyVoice v1 system-voice IDs.  Later
// CosyVoice generations use versioned IDs such as `longwan_v2` and
// `longanhuan_v3`, so treating the bare IDs as v1-only is unambiguous.
const COSYVOICE_V1_VOICE_IDS = new Set([
  "longwan",
  "longcheng",
  "longhua",
  "longxiaochun",
  "longxiaoxia",
  "longxiaocheng",
  "longxiaobai",
  "longlaotie",
  "longshu",
  "longshuo",
  "longjing",
  "longmiao",
  "longyue",
  "longyuan",
  "longfei",
  "longjielidou",
  "longtong",
  "longxiang",
  "loongstella",
  "loongbella",
]);

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

function isOfficialDashScopeEndpoint(value) {
  try {
    const url = new URL(clean(value));
    const hostname = url.hostname.toLowerCase();
    const nativeHost = hostname === "dashscope.aliyuncs.com"
      || hostname === "dashscope-intl.aliyuncs.com"
      || hostname.endsWith(".maas.aliyuncs.com");
    return nativeHost && url.pathname.replace(/\/+$/u, "") === "/api/v1";
  } catch {
    return false;
  }
}

function dashscopeAdapterForModel(model) {
  const identity = clean(model).toLowerCase();
  if (identity.startsWith("cosyvoice-") || identity.startsWith("qwen-audio-")) return "dashscope-cosyvoice";
  if (identity.startsWith("qwen3-tts") || identity.startsWith("qwen-tts")) return "dashscope-qwen";
  return "";
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
  if (!isOfficialDashScopeEndpoint(baseUrl)) return configured;
  if (!new Set(["openai-speech", "dashscope-qwen", "dashscope-cosyvoice"]).has(configured)) return configured;
  const inferred = dashscopeAdapterForModel(model) || dashscopeAdapterForModel(voiceId);
  if (inferred) return inferred;
  return configured;
}

export function ttsAdapterEndpointCompatibilityError({ adapter, baseUrl = "" } = {}) {
  const normalized = normalizeTtsAdapter(adapter);
  if (!normalized || !["dashscope-qwen", "dashscope-cosyvoice"].includes(normalized)) return "";
  try {
    const url = new URL(clean(baseUrl));
    if (/\/compatible-mode\/v1\/?$/iu.test(url.pathname)) {
      return `${ttsAdapterLabel(normalized)}需要百炼原生 API 地址（以 /api/v1 结尾），不能使用 /compatible-mode/v1。`;
    }
  } catch {
    // The caller validates whether an address is required.  This helper only
    // identifies the known incompatible DashScope-compatible URL shape.
  }
  return "";
}

export function ttsProtocolForRuntime({ adapter, model = "" } = {}) {
  const normalized = normalizeTtsAdapter(adapter);
  if (normalized === "dashscope-cosyvoice" && clean(model).toLowerCase() === "cosyvoice-v1") {
    return "dashscope-sse";
  }
  return "json";
}

export function ttsAdapterModelCompatibilityError({ adapter, model = "" } = {}) {
  const normalized = normalizeTtsAdapter(adapter);
  const selectedModel = clean(model).toLowerCase();
  if (normalized === "xiaomi-mimo-tts" && selectedModel !== "mimo-v2.5-tts") {
    return "小米 MiMo TTS 当前使用 mimo-v2.5-tts 与内置音色。请填写该模型名称，或改用与音色设计、声音复刻对应的专用配置。";
  }
  return "";
}

export function ttsAdapterVoiceCompatibilityError({ adapter, model = "", voiceId = "" } = {}) {
  const normalized = normalizeTtsAdapter(adapter);
  if (!normalized || !["dashscope-qwen", "dashscope-cosyvoice"].includes(normalized)) return "";
  const voice = clean(voiceId).toLowerCase();
  const selectedModel = clean(model).toLowerCase();
  if (COSYVOICE_V1_VOICE_IDS.has(voice) && selectedModel !== "cosyvoice-v1") {
    return `音色“${voice}”属于 cosyvoice-v1，不能与“${selectedModel || "当前模型"}”混用。请选择 cosyvoice-v1，或改用该模型支持的音色。`;
  }
  return "";
}

export function ttsAdapterSupportsConnection(adapter, connectionType) {
  const type = clean(connectionType).toLowerCase();
  // TTS API 是通用语音连接：地址、Key、模型都由用户填写，协议由所选音色的适配器决定。
  if (type === "tts-api") return true;
  const definition = ttsAdapterDefinition(adapter);
  return Boolean(definition?.connectionTypes.includes(type));
}

export const TTS_ADAPTER_OPTIONS = Object.freeze(Object.values(TTS_ADAPTERS).map(({ id, label }) => Object.freeze({ label, value: id })));
