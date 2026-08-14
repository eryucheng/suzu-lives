import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";
import { appendUsageEvent } from "@suzu-lives/cost-ledger";

const DEFAULT_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const DEFAULT_QWEN_MODEL = "qwen3-tts-vd-2026-01-26";
const DEFAULT_COSYVOICE_MODEL = "cosyvoice-v3.5-plus";
const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io/v1";
const DEFAULT_MINIMAX_MODEL = "speech-2.8-hd";
const MAX_RESPONSE_BYTES = 100 * 1024 * 1024;
const MAX_AGENT_VOICE_CANDIDATES = 200;
const MAX_AGENT_CUSTOM_VOICES = 100;
const AGENT_ID = /^agent-[a-f0-9]{16}$/iu;

export class DirectVoiceMessageError extends Error {
  constructor(message, { code = "voice_message_error", exitCode = 4 } = {}) {
    super(message);
    this.name = "DirectVoiceMessageError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function failure(code, message, exitCode = 4) {
  return new DirectVoiceMessageError(message, { code, exitCode });
}

function requiredDataRoot(value) {
  const root = clean(value);
  if (!root) throw failure("data_root_missing", "缺少 Suzu Lives 软件数据目录。");
  return path.resolve(root);
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function voiceRoot(dataRoot) {
  return path.join(dataRoot, "capabilities", "voice-message");
}

function agentVoiceMessageRoot(dataRoot, agentId) {
  const identity = clean(agentId);
  if (!identity) {
    throw failure("agent_identity_missing", "语音消息需要当前联系人身份才能读取已选音色。", 10);
  }
  return path.join(resolveAgentDataRoot({ dataRoot, agentId: identity }), "voice-message");
}

function agentAudioDirectory(dataRoot, agentId) {
  const identity = clean(agentId);
  if (!identity) {
    throw failure("agent_identity_missing", "语音消息需要当前 Agent 身份才能保存音频。", 10);
  }
  return path.join(
    resolveAgentDataRoot({ dataRoot, agentId: identity }),
    "voice-message",
    "audio",
  );
}

function sharedConfigPath(dataRoot) {
  return path.join(voiceRoot(dataRoot), "config.json");
}

function defaultConfigPath(dataRoot, agentId = "") {
  return clean(agentId)
    ? path.join(agentVoiceMessageRoot(dataRoot, agentId), "config.json")
    : sharedConfigPath(dataRoot);
}

export function resolveVoiceMessageConfigPath({ dataRoot, agentId = "", configPath = "" } = {}) {
  const root = requiredDataRoot(dataRoot);
  const requested = clean(configPath);
  const candidate = requested ? path.resolve(root, requested) : defaultConfigPath(root, agentId);
  if (!inside(root, candidate)) {
    throw failure("config_path_outside_data_root", "语音消息配置必须位于 Suzu Lives 软件数据目录内。");
  }
  return candidate;
}

function readJson(filePath, { code, label }) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("顶层必须是 JSON 对象");
    return parsed;
  } catch (error) {
    throw failure(code, "无法读取" + label + "：" + error.message);
  }
}

function readOptionalVoiceConfig(configPath) {
  try {
    const stat = fs.lstatSync(configPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw failure("config_invalid", "语音消息配置不是安全的普通文件：" + configPath);
    }
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof DirectVoiceMessageError) throw error;
    throw failure("config_invalid", "无法检查语音消息配置：" + error.message);
  }
  return readJson(configPath, { code: "config_invalid", label: "语音消息配置" });
}

function readVoiceConfig(configPath) {
  const config = readOptionalVoiceConfig(configPath);
  if (!config) {
    throw failure("config_missing", "配置文件不存在：" + configPath + "；请在 Suzu Lives 的语音设置中选择音色。");
  }
  return config;
}

function voiceIdFromConfig(value) {
  const config = objectValue(value);
  const tts = objectValue(config.tts);
  return clean(config.voiceId || config.voice || tts.voiceId || tts.voice_id || tts.voice);
}

function voiceProviderFromConfig(value) {
  const config = objectValue(value);
  const tts = objectValue(config.tts);
  const provider = clean(config.provider || tts.provider).toLowerCase();
  if (!provider || provider === "qwen" || provider === "dashscope" || provider === "bailian") return "qwen";
  if (provider === "minimax") return "minimax";
  if (provider === "cosyvoice") return "cosyvoice";
  throw failure("tts_provider_invalid", "不支持的语音服务：" + provider + "。", 10);
}

function customVoiceIdFromConfig(value) {
  const config = objectValue(value);
  const tts = objectValue(config.tts);
  return clean(config.customVoiceId || tts.customVoiceId);
}

function sourceAgentId(value) {
  const agentId = clean(value).toLowerCase();
  return AGENT_ID.test(agentId) ? agentId : "";
}

function sourceAgentIdFromConfig(value) {
  const config = objectValue(value);
  const tts = objectValue(config.tts);
  return sourceAgentId(config.sourceAgentId || tts.sourceAgentId);
}

function sourceCandidateIdFromConfig(value) {
  const config = objectValue(value);
  const tts = objectValue(config.tts);
  return clean(config.sourceCandidateId || tts.sourceCandidateId);
}

function customVoiceSourceFromConfig(value) {
  const config = objectValue(value);
  const tts = objectValue(config.tts);
  return clean(config.customVoiceSource || tts.customVoiceSource).toLowerCase();
}

function customVoiceSourceAgentIdFromConfig(value) {
  const config = objectValue(value);
  const tts = objectValue(config.tts);
  return sourceAgentId(config.customVoiceSourceAgentId || tts.customVoiceSourceAgentId);
}

function withoutVoiceSelection(value) {
  const config = objectValue(value);
  const tts = objectValue(config.tts);
  const {
    voiceId: _voiceId,
    voice: _voice,
    customVoiceId: _customVoiceId,
    sourceAgentId: _sourceAgentId,
    sourceCandidateId: _sourceCandidateId,
    customVoiceSource: _customVoiceSource,
    customVoiceSourceAgentId: _customVoiceSourceAgentId,
    tts: _tts,
    ...rest
  } = config;
  const {
    voiceId: _ttsVoiceId,
    voice_id: _ttsVoiceIdSnakeCase,
    voice: _ttsVoice,
    customVoiceId: _ttsCustomVoiceId,
    sourceAgentId: _ttsSourceAgentId,
    sourceCandidateId: _ttsSourceCandidateId,
    customVoiceSource: _ttsCustomVoiceSource,
    customVoiceSourceAgentId: _ttsCustomVoiceSourceAgentId,
    ...restTts
  } = tts;
  return {
    ...rest,
    ...(Object.keys(restTts).length ? { tts: restTts } : {}),
  };
}

function customVoicesAt(customVoicesPath) {
  try {
    const stat = fs.lstatSync(customVoicesPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return [];
    const document = objectValue(JSON.parse(fs.readFileSync(customVoicesPath, "utf8").replace(/^\uFEFF/u, "")));
    const voices = [];
    const seen = new Set();
    for (const value of (Array.isArray(document.voices) ? document.voices : []).slice(0, MAX_AGENT_CUSTOM_VOICES)) {
      const voice = objectValue(value);
      const id = clean(voice.id);
      const name = clean(voice.name);
      const provider = clean(voice.provider).toLowerCase();
      const voiceId = clean(voice.voiceId);
      const apiKey = clean(voice.apiKey);
      if (!id || !name || !["minimax", "cosyvoice"].includes(provider) || !voiceId || !apiKey || seen.has(id)) continue;
      seen.add(id);
      voices.push({
        id,
        name,
        provider,
        voiceId,
        apiKey,
        model: clean(voice.model) || (provider === "cosyvoice" ? DEFAULT_COSYVOICE_MODEL : DEFAULT_MINIMAX_MODEL),
      });
    }
    return voices;
  } catch {
    return [];
  }
}

function agentCustomVoices(dataRoot, agentId) {
  const identity = clean(agentId);
  if (!identity) return [];
  return customVoicesAt(path.join(agentVoiceMessageRoot(dataRoot, identity), "custom-voices.json"));
}

function globalCustomVoices(dataRoot) {
  return customVoicesAt(path.join(requiredDataRoot(dataRoot), "voice-message", "custom-voices.json"));
}

function agentVoiceCandidateIds(dataRoot, agentId) {
  const identity = clean(agentId);
  if (!identity) return new Set();
  const candidatesPath = path.join(resolveAgentDataRoot({ dataRoot, agentId: identity }), "voice-design", "candidates.jsonl");
  try {
    const stat = fs.lstatSync(candidatesPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return new Set();
    const candidates = new Set();
    const lines = fs.readFileSync(candidatesPath, "utf8").split(/\r?\n/u).filter(Boolean).slice(-MAX_AGENT_VOICE_CANDIDATES);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const candidate = objectValue(JSON.parse(line));
        const candidateId = clean(candidate.id);
        const voiceId = clean(candidate.voiceId);
        if (candidateId && voiceId) candidates.add(voiceId);
      } catch {
        // Candidate generation already owns validation. An invalid line cannot authorize a voice here.
      }
    }
    return candidates;
  } catch {
    return new Set();
  }
}

function sourceVoiceCandidateAvailable({ dataRoot, agentId, candidateId, voiceId }) {
  const identity = sourceAgentId(agentId);
  if (!identity || !clean(candidateId)) return false;
  const candidatesPath = path.join(resolveAgentDataRoot({ dataRoot, agentId: identity }), "voice-design", "candidates.jsonl");
  try {
    const stat = fs.lstatSync(candidatesPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    const lines = fs.readFileSync(candidatesPath, "utf8").split(/\r?\n/u).filter(Boolean).slice(-MAX_AGENT_VOICE_CANDIDATES);
    return lines.some((line) => {
      try {
        const candidate = objectValue(JSON.parse(line));
        return clean(candidate.id) === clean(candidateId) && clean(candidate.voiceId) === voiceId && Boolean(clean(candidate.retainedAt));
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function assertAgentVoiceCandidate({ dataRoot, agentId, voiceId, sourceAgentId: configuredSourceAgentId = "", sourceCandidateId = "" }) {
  if (!clean(agentId)) {
    throw failure("agent_identity_missing", "请先选择当前联系人，才能发送联系人专属声音。", 10);
  }
  if (configuredSourceAgentId || sourceCandidateId) {
    if (sourceVoiceCandidateAvailable({ dataRoot, agentId: configuredSourceAgentId, candidateId: sourceCandidateId, voiceId })) return;
    throw failure(
      "voice_not_available_for_agent",
      "联系人所选的百炼音色已经不可用。请在 Suzu 的音色设置中重新选择。",
      10,
    );
  }
  if (!agentVoiceCandidateIds(dataRoot, agentId).has(voiceId)) {
    throw failure(
      "voice_not_available_for_agent",
      "当前联系人没有保存所选音色“" + voiceId + "”。请先在该联系人的音色设计中创建或选择可用音色。",
      10,
    );
  }
}

function selectedCustomVoice({ dataRoot, agentId, provider, customVoiceId, voiceId, customVoiceSource, customVoiceSourceAgentId }) {
  const exact = (voices) => voices.find((voice) => voice.provider === provider && voice.id === customVoiceId && voice.voiceId === voiceId) || null;
  if (customVoiceSource === "global") return exact(globalCustomVoices(dataRoot));
  if (customVoiceSource === "contact") {
    return customVoiceSourceAgentId ? exact(agentCustomVoices(dataRoot, customVoiceSourceAgentId)) : null;
  }
  if (customVoiceSourceAgentId) return exact(agentCustomVoices(dataRoot, customVoiceSourceAgentId));
  return exact(agentCustomVoices(dataRoot, agentId));
}

function assertAgentVoiceSelection({ dataRoot, agentId, provider, voiceId, customVoiceId, sourceAgentId: configuredSourceAgentId = "", sourceCandidateId = "", customVoiceSource = "", customVoiceSourceAgentId = "" }) {
  if (provider === "qwen" && !clean(customVoiceId)) {
    assertAgentVoiceCandidate({ dataRoot, agentId, voiceId, sourceAgentId: configuredSourceAgentId, sourceCandidateId });
    return null;
  }
  const selected = selectedCustomVoice({ dataRoot, agentId, provider, customVoiceId, voiceId, customVoiceSource, customVoiceSourceAgentId });
  if (!selected) {
    const label = provider === "cosyvoice" ? "阿里百炼 CosyVoice 复刻音色" : "MiniMax 自定义音色";
    throw failure(
      "voice_not_available_for_agent",
      "当前联系人没有保存所选的" + label + "。请在 Suzu 的音色设置中重新选择。",
      10,
    );
  }
  return selected;
}

function resolveAgentVoiceConfig({ dataRoot, agentId, requireVoiceSelection }) {
  const contactConfigPath = defaultConfigPath(dataRoot, agentId);
  const contactConfig = readOptionalVoiceConfig(contactConfigPath) || {};
  const sharedConfig = withoutVoiceSelection(readOptionalVoiceConfig(sharedConfigPath(dataRoot)) || {});
  const contactVoiceId = voiceIdFromConfig(contactConfig);
  const contactProvider = contactVoiceId ? voiceProviderFromConfig(contactConfig) : "qwen";
  const contactCustomVoiceId = customVoiceIdFromConfig(contactConfig);
  const contactSourceAgentId = sourceAgentIdFromConfig(contactConfig);
  const contactSourceCandidateId = sourceCandidateIdFromConfig(contactConfig);
  const contactCustomVoiceSource = customVoiceSourceFromConfig(contactConfig);
  const contactCustomVoiceSourceAgentId = customVoiceSourceAgentIdFromConfig(contactConfig);
  const selection = contactVoiceId
    ? {
      voiceId: contactVoiceId,
      provider: contactProvider,
      customVoiceId: contactCustomVoiceId,
      sourceAgentId: contactSourceAgentId,
      sourceCandidateId: contactSourceCandidateId,
      customVoiceSource: contactCustomVoiceSource,
      customVoiceSourceAgentId: contactCustomVoiceSourceAgentId,
      source: "contact",
    }
    : {
      voiceId: "",
      provider: "qwen",
      customVoiceId: "",
      sourceAgentId: "",
      sourceCandidateId: "",
      customVoiceSource: "",
      customVoiceSourceAgentId: "",
      source: "missing",
    };
  let customVoice = null;
  if (requireVoiceSelection) {
    if (!selection.voiceId) {
      throw failure("tts_voice_missing", "当前联系人尚未选择音色；请到“能力”中的“语音消息”配置联系人音色后再发送。", 10);
    }
    customVoice = assertAgentVoiceSelection({
      dataRoot,
      agentId,
      provider: selection.provider,
      voiceId: selection.voiceId,
      customVoiceId: selection.customVoiceId,
      sourceAgentId: selection.sourceAgentId,
      sourceCandidateId: selection.sourceCandidateId,
      customVoiceSource: selection.customVoiceSource,
      customVoiceSourceAgentId: selection.customVoiceSourceAgentId,
    });
  }
  return {
    configPath: contactConfigPath,
    localConfig: selection.voiceId
      ? {
        ...sharedConfig,
        voiceId: selection.voiceId,
        provider: selection.provider,
        customVoiceId: selection.customVoiceId,
        ...(selection.sourceAgentId ? { sourceAgentId: selection.sourceAgentId } : {}),
        ...(selection.sourceCandidateId ? { sourceCandidateId: selection.sourceCandidateId } : {}),
        ...(selection.customVoiceSource ? { customVoiceSource: selection.customVoiceSource } : {}),
        ...(selection.customVoiceSourceAgentId ? { customVoiceSourceAgentId: selection.customVoiceSourceAgentId } : {}),
        ...(customVoice ? { apiKey: customVoice.apiKey, model: customVoice.model } : {}),
      }
      : { ...sharedConfig },
    selectionSource: selection.source,
  };
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function resolveTts(localConfig, environment, {
  apiKeyOverride = "",
  baseUrlOverride = "",
  modelOverride = "",
  requireCredentials = true,
} = {}) {
  const config = objectValue(localConfig);
  const tts = objectValue(config.tts);
  const provider = voiceProviderFromConfig(config);
  const apiKeyEnvironment = clean(config.apiKeyEnv || tts.apiKeyEnv) || (provider === "minimax" ? "MINIMAX_API_KEY" : "DASHSCOPE_API_KEY");
  const configuredApiKey = clean(config.apiKey || tts.apiKey);
  const apiKey = provider === "minimax" || provider === "cosyvoice"
    ? clean(configuredApiKey || environment[apiKeyEnvironment] || apiKeyOverride)
    : clean(apiKeyOverride || environment[apiKeyEnvironment] || configuredApiKey);
  const voice = clean(config.voiceId || config.voice || tts.voiceId || tts.voice_id || tts.voice);
  if (requireCredentials && !apiKey) {
    const providerName = provider === "minimax" ? "MiniMax" : "百炼";
    throw failure("tts_api_key_missing", "缺少" + providerName + " API Key：请在 Suzu 的音色设置中配置，或设置 " + apiKeyEnvironment + "。");
  }
  if (requireCredentials && !voice) {
    throw failure("tts_voice_missing", "缺少音色：请在 Suzu 的语音设置中选择一个音色。");
  }
  return {
    provider,
    apiKey,
    baseUrl: provider === "minimax"
      ? DEFAULT_MINIMAX_BASE_URL
      : clean(baseUrlOverride || config.baseUrl || tts.baseUrl || tts.base_url) || DEFAULT_QWEN_BASE_URL,
    model: provider === "minimax"
      ? clean(config.model || tts.model) || DEFAULT_MINIMAX_MODEL
      : provider === "cosyvoice"
        ? clean(config.model || tts.model) || DEFAULT_COSYVOICE_MODEL
        : clean(modelOverride || config.model || tts.model) || DEFAULT_QWEN_MODEL,
    voice,
    maxTextLength: Math.round(positiveNumber(config.maxTextLength || config.max_text_len || tts.maxTextLength || tts.max_text_len, 300)),
    languageType: provider === "qwen" ? clean(config.languageType || tts.languageType) : "",
  };
}

export function resolveDirectVoiceRuntime({
  dataRoot,
  agentId = "",
  configPath = "",
  timeoutMs,
  apiKeyOverride = "",
  baseUrlOverride = "",
  modelOverride = "",
  requireTtsCredentials = true,
  environment = process.env,
} = {}) {
  const root = requiredDataRoot(dataRoot);
  const identity = clean(agentId);
  const requestedConfigPath = clean(configPath);
  let resolved;
  if (requestedConfigPath || !identity) {
    const selectedConfigPath = resolveVoiceMessageConfigPath({ dataRoot: root, configPath: requestedConfigPath });
    resolved = {
      configPath: selectedConfigPath,
      localConfig: readVoiceConfig(selectedConfigPath),
      selectionSource: requestedConfigPath ? "explicit" : "shared-config",
    };
  } else {
    resolved = resolveAgentVoiceConfig({ dataRoot: root, agentId: identity, requireVoiceSelection: requireTtsCredentials });
  }
  return {
    dataRoot: root,
    runtimeDataRoot: voiceRoot(root),
    agentId: identity,
    configPath: resolved.configPath,
    selectionSource: resolved.selectionSource,
    timeoutMs: Math.round(positiveNumber(timeoutMs || resolved.localConfig.timeoutMs, 30000)),
    ffmpegPath: clean(resolved.localConfig.ffmpegPath) || "ffmpeg",
    tts: resolveTts(resolved.localConfig, environment, {
      apiKeyOverride,
      baseUrlOverride,
      modelOverride,
      requireCredentials: requireTtsCredentials,
    }),
  };
}

function safeInspection(runtime) {
  return {
    status: "ready",
    delivery: "conversation-attachment",
    outputFormat: "mp3",
    configPath: runtime.configPath,
    selectionSource: runtime.selectionSource,
    tts: {
      provider: runtime.tts.provider,
      model: runtime.tts.model,
      voiceConfigured: Boolean(runtime.tts.voice),
      apiKeyConfigured: Boolean(runtime.tts.apiKey),
    },
  };
}

function withTimeout(timeoutMs, abortSignal = null) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (abortSignal?.aborted) onAbort();
  else abortSignal?.addEventListener?.("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener?.("abort", onAbort);
    },
    timedOut: () => timedOut,
  };
}

async function readResponseBytes(response, label, { responseCode = "tts_response_invalid" } = {}) {
  if (!response || typeof response.arrayBuffer !== "function") throw failure(responseCode, label + "响应不可读取。", 5);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES) throw failure(responseCode, label + "响应超过" + MAX_RESPONSE_BYTES + "字节", 5);
  return bytes;
}

async function fetchJson(fetchImpl, url, options, timeoutMs, label, abortSignal = null) {
  const timeout = withTimeout(timeoutMs, abortSignal);
  try {
    const response = await fetchImpl(url, { ...options, signal: timeout.signal });
    const body = await readResponseBytes(response, label);
    if (!response.ok) throw failure("tts_http_error", label + " HTTP " + response.status + "：" + body.toString("utf8").slice(0, 800), 5);
    try {
      return JSON.parse(body.toString("utf8") || "{}");
    } catch (error) {
      throw failure("tts_response_invalid", label + "返回的不是有效 JSON：" + error.message, 5);
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      throw failure(timeout.timedOut() ? "tts_timeout" : "tts_aborted", timeout.timedOut() ? label + "超时" : label + "已取消", 5);
    }
    if (error instanceof DirectVoiceMessageError) throw error;
    throw failure("tts_network_error", label + "请求失败：" + (clean(error?.message) || "未知错误"), 5);
  } finally {
    timeout.cancel();
  }
}

async function fetchBuffer(fetchImpl, url, timeoutMs, label, abortSignal = null) {
  const timeout = withTimeout(timeoutMs, abortSignal);
  try {
    const response = await fetchImpl(url, { signal: timeout.signal });
    if (!response?.ok) throw failure("tts_audio_download_failed", label + " HTTP " + (response?.status || 0), 5);
    return await readResponseBytes(response, label);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw failure(timeout.timedOut() ? "tts_timeout" : "tts_aborted", timeout.timedOut() ? label + "超时" : label + "已取消", 5);
    }
    if (error instanceof DirectVoiceMessageError) throw error;
    throw failure("tts_network_error", label + "请求失败：" + (clean(error?.message) || "未知错误"), 5);
  } finally {
    timeout.cancel();
  }
}

function audioFormat(audioUrl) {
  try {
    const extension = path.extname(new URL(audioUrl).pathname).slice(1).toLowerCase();
    return /^[a-z0-9]{1,12}$/u.test(extension) ? extension : "";
  } catch {
    return "";
  }
}

async function synthesizeQwen({ text, runtime, fetchImpl, ledgerPath, agentId, feature = "voice-message-tts", abortSignal = null }) {
  if (!text) throw failure("voice_text_missing", "语音文本不能为空。");
  if (runtime.tts.maxTextLength > 0 && [...text].length > runtime.tts.maxTextLength) {
    throw failure("voice_text_too_long", "语音文本超过 " + runtime.tts.maxTextLength + " 字符，请缩短内容。");
  }
  if (typeof fetchImpl !== "function") throw failure("tts_fetch_unavailable", "没有可用的 TTS HTTP 客户端。", 5);
  const input = { text, voice: runtime.tts.voice };
  if (runtime.tts.languageType) input.language_type = runtime.tts.languageType;
  const endpoint = runtime.tts.baseUrl.replace(/\/+$/u, "") + "/services/aigc/multimodal-generation/generation";
  const result = await fetchJson(
    fetchImpl,
    endpoint,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + runtime.tts.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: runtime.tts.model, input }),
    },
    runtime.timeoutMs,
    "百炼 TTS",
    abortSignal,
  );
  if (clean(result.code) || Number(result.status_code || 200) >= 400) {
    throw failure("tts_provider_error", ("百炼 TTS 失败：" + clean(result.code) + " " + clean(result.message)).trim(), 5);
  }
  const audioUrl = clean(result.output?.audio?.url);
  if (!audioUrl) throw failure("tts_response_invalid", "百炼 TTS 响应缺少 output.audio.url", 5);
  const audio = await fetchBuffer(fetchImpl, audioUrl, runtime.timeoutMs, "下载合成音频", abortSignal);
  const targetLedger = clean(ledgerPath);
  if (!targetLedger) throw failure("ledger_path_missing", "缺少 Suzu Lives 用量账本路径。", 10);
  try {
    await appendUsageEvent(targetLedger, {
      agentId: clean(agentId),
      provider: "阿里云百炼",
      model: runtime.tts.model,
      source: "语音合成",
      feature,
      requestId: clean(result.request_id),
      usage: result.usage && typeof result.usage === "object" ? result.usage : {},
      units: { inputCharacters: [...text].length },
      metadata: { voice: runtime.tts.voice, outputFormat: "mp3" },
    });
  } catch (error) {
    throw failure("ledger_write_failed", "无法写入 Suzu Lives 用量账本：" + (clean(error?.message) || "未知错误"), 10);
  }
  return { audio, format: audioFormat(audioUrl), requestId: clean(result.request_id) };
}

async function synthesizeCosyVoice({ text, runtime, fetchImpl, ledgerPath, agentId, feature = "voice-message-tts", abortSignal = null }) {
  if (!text) throw failure("voice_text_missing", "语音文本不能为空。");
  if (runtime.tts.maxTextLength > 0 && [...text].length > runtime.tts.maxTextLength) {
    throw failure("voice_text_too_long", "语音文本超过 " + runtime.tts.maxTextLength + " 字符，请缩短内容。");
  }
  if (typeof fetchImpl !== "function") throw failure("tts_fetch_unavailable", "没有可用的 TTS HTTP 客户端。", 5);
  const endpoint = runtime.tts.baseUrl.replace(/\/+$/u, "") + "/services/audio/tts/SpeechSynthesizer";
  const result = await fetchJson(
    fetchImpl,
    endpoint,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + runtime.tts.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: runtime.tts.model,
        input: { text, voice: runtime.tts.voice, format: "mp3", sample_rate: 24000 },
      }),
    },
    runtime.timeoutMs,
    "百炼 CosyVoice TTS",
    abortSignal,
  );
  if (clean(result.code) || Number(result.status_code || 200) >= 400) {
    throw failure("tts_provider_error", ("百炼 CosyVoice TTS 失败：" + clean(result.code) + " " + clean(result.message)).trim(), 5);
  }
  const audioUrl = clean(result.output?.audio?.url);
  if (!audioUrl) throw failure("tts_response_invalid", "百炼 CosyVoice TTS 响应缺少 output.audio.url", 5);
  const audio = await fetchBuffer(fetchImpl, audioUrl, runtime.timeoutMs, "下载合成音频", abortSignal);
  const targetLedger = clean(ledgerPath);
  if (!targetLedger) throw failure("ledger_path_missing", "缺少 Suzu Lives 用量账本路径。", 10);
  try {
    await appendUsageEvent(targetLedger, {
      agentId: clean(agentId),
      provider: "阿里云百炼",
      model: runtime.tts.model,
      source: "语音合成",
      feature,
      requestId: clean(result.request_id),
      usage: result.usage && typeof result.usage === "object" ? result.usage : {},
      units: { inputCharacters: [...text].length },
      metadata: { voice: runtime.tts.voice, outputFormat: "mp3" },
    });
  } catch (error) {
    throw failure("ledger_write_failed", "无法写入 Suzu Lives 用量账本：" + (clean(error?.message) || "未知错误"), 10);
  }
  return { audio, format: "mp3", requestId: clean(result.request_id) };
}

function minimaxAudioBuffer(value) {
  const hex = clean(value);
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(hex)) {
    throw failure("tts_response_invalid", "MiniMax T2A 响应缺少有效的音频数据。", 5);
  }
  const audio = Buffer.from(hex, "hex");
  if (!audio.length) throw failure("tts_response_invalid", "MiniMax T2A 返回了空音频。", 5);
  return audio;
}

async function synthesizeMiniMax({ text, runtime, fetchImpl, ledgerPath, agentId, feature = "voice-message-tts", abortSignal = null }) {
  if (!text) throw failure("voice_text_missing", "语音文本不能为空。");
  if (runtime.tts.maxTextLength > 0 && [...text].length > runtime.tts.maxTextLength) {
    throw failure("voice_text_too_long", "语音文本超过 " + runtime.tts.maxTextLength + " 字符，请缩短内容。");
  }
  if (typeof fetchImpl !== "function") throw failure("tts_fetch_unavailable", "没有可用的 TTS HTTP 客户端。", 5);
  const endpoint = runtime.tts.baseUrl.replace(/\/+$/u, "") + "/t2a_v2";
  const result = await fetchJson(
    fetchImpl,
    endpoint,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + runtime.tts.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: runtime.tts.model,
        text,
        stream: false,
        language_boost: "auto",
        output_format: "hex",
        voice_setting: { voice_id: runtime.tts.voice, speed: 1, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
      }),
    },
    runtime.timeoutMs,
    "MiniMax T2A",
    abortSignal,
  );
  const providerStatus = Number(result.base_resp?.status_code);
  if (Number.isFinite(providerStatus) && providerStatus !== 0) {
    throw failure("tts_provider_error", ("MiniMax T2A 失败：" + clean(result.base_resp?.status_msg || result.base_resp?.status_code)).trim(), 5);
  }
  const audio = minimaxAudioBuffer(result.data?.audio);
  const targetLedger = clean(ledgerPath);
  if (!targetLedger) throw failure("ledger_path_missing", "缺少 Suzu Lives 用量账本路径。", 10);
  try {
    const usageCharacters = Number(result.data?.extra_info?.usage_characters);
    await appendUsageEvent(targetLedger, {
      agentId: clean(agentId),
      provider: "MiniMax",
      model: runtime.tts.model,
      source: "语音合成",
      feature,
      requestId: clean(result.trace_id),
      usage: Number.isFinite(usageCharacters) ? { inputCharacters: usageCharacters } : {},
      units: { inputCharacters: [...text].length },
      metadata: { voice: runtime.tts.voice, outputFormat: "mp3" },
    });
  } catch (error) {
    throw failure("ledger_write_failed", "无法写入 Suzu Lives 用量账本：" + (clean(error?.message) || "未知错误"), 10);
  }
  return { audio, format: "mp3", requestId: clean(result.trace_id) };
}

function runProcess(command, args, label, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(failure("audio_tool_start_failed", label + "无法启动：" + (clean(error?.message) || "未知错误"), 5));
      return;
    }
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => reject(failure("audio_tool_start_failed", label + "无法启动：" + (clean(error?.message) || "未知错误"), 5)));
    child.once("close", (code) => {
      if (code !== 0) {
        reject(failure("audio_tool_failed", label + "失败（" + code + "）：" + Buffer.concat(stderr).toString("utf8").slice(0, 1200), 5));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

async function temporaryDirectory(runtime) {
  const parent = path.join(runtime.runtimeDataRoot, "runtime");
  await fsp.mkdir(parent, { recursive: true });
  return fsp.mkdtemp(path.join(parent, "suzu-voice-"));
}

async function readAudioFile(audioFile) {
  const audioPath = path.resolve(clean(audioFile));
  if (!audioPath || !fs.existsSync(audioPath)) throw failure("audio_missing", "音频文件不存在：" + (audioPath || clean(audioFile)));
  try {
    return {
      audio: await fsp.readFile(audioPath),
      format: path.extname(audioPath).slice(1).toLowerCase(),
    };
  } catch (error) {
    throw failure("audio_read_failed", "无法读取音频文件：" + (clean(error?.message) || "未知错误"));
  }
}

async function saveMp3Audio({ source, sourceFormat, runtime, audioDirectory, workDirectory, processRunner, now }) {
  const directory = audioDirectory;
  await fsp.mkdir(directory, { recursive: true });
  const fileName = "voice-" + now().getTime() + "-" + randomUUID().slice(0, 8) + ".mp3";
  const savedPath = path.join(directory, fileName);
  if (clean(sourceFormat).replace(/^\./u, "").toLowerCase() === "mp3") {
    await fsp.writeFile(savedPath, source);
  } else {
    const normalizedFormat = clean(sourceFormat).replace(/^\./u, "").toLowerCase() || "audio";
    const sourcePath = path.join(workDirectory, "source." + normalizedFormat);
    await fsp.writeFile(sourcePath, source);
    await processRunner(
      runtime.ffmpegPath,
      ["-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath, "-vn", "-c:a", "libmp3lame", "-b:a", "128k", savedPath],
      "ffmpeg MP3 转码",
    );
  }
  let info;
  try {
    info = await fsp.stat(savedPath);
  } catch (error) {
    throw failure("mp3_output_missing", "MP3 转码没有生成输出文件：" + (clean(error?.message) || savedPath), 5);
  }
  if (!info.isFile() || info.size <= 0) throw failure("mp3_output_empty", "生成的 MP3 文件为空。", 5);
  return { fileName, savedPath, size: info.size };
}

/**
 * Synthesizes one short piece of speech without writing a file.  The desktop
 * call surface uses this so it can start playing each sentence while Claude
 * is still producing the rest of its answer.  Credentials stay in the main
 * process because callers pass an already-resolved runtime.
 */
export async function synthesizeDirectVoiceAudio({
  text = "",
  runtime,
  fetchImpl = globalThis.fetch,
  ledgerPath = "",
  agentId = "",
  feature = "voice-message-tts",
  abortSignal = null,
} = {}) {
  const message = clean(text);
  if (!message) throw failure("voice_text_missing", "语音文本不能为空。");
  if (!runtime?.tts?.provider) throw failure("tts_runtime_missing", "缺少联系人语音运行配置。", 10);
  const synthesized = runtime.tts.provider === "minimax"
    ? await synthesizeMiniMax({ text: message, runtime, fetchImpl, ledgerPath, agentId, feature, abortSignal })
    : runtime.tts.provider === "cosyvoice"
      ? await synthesizeCosyVoice({ text: message, runtime, fetchImpl, ledgerPath, agentId, feature, abortSignal })
      : await synthesizeQwen({ text: message, runtime, fetchImpl, ledgerPath, agentId, feature, abortSignal });
  return {
    ...synthesized,
    provider: runtime.tts.provider,
    model: runtime.tts.model,
    voice: runtime.tts.voice,
  };
}

/**
 * Generates a local MP3 only. Delivery is deliberately handled by the current
 * Suzu conversation attachment command, which renders it in Suzu and forwards
 * it as a regular MP3 file to every WeChat account bound to that conversation.
 */
export async function runDirectVoiceMessage({
  dataRoot,
  ledgerPath = "",
  agentId = "",
  text = "",
  audioFile = "",
  configPath = "",
  timeoutMs,
  inspect = false,
  apiKeyOverride = "",
  baseUrlOverride = "",
  modelOverride = "",
  fetchImpl = globalThis.fetch,
  processRunner = runProcess,
  environment = process.env,
  now = () => new Date(),
} = {}) {
  const message = clean(text);
  const selectedAudioFile = clean(audioFile);
  if (!inspect && !selectedAudioFile && !message) {
    throw failure("voice_input_missing", "请提供要说的话或 --audio-file。");
  }
  if (!inspect && !clean(agentId)) {
    throw failure("agent_identity_missing", "请先选择当前联系人，才能生成联系人专属语音。", 10);
  }
  const runtime = resolveDirectVoiceRuntime({
    dataRoot,
    agentId,
    configPath,
    timeoutMs,
    apiKeyOverride,
    baseUrlOverride,
    modelOverride,
    requireTtsCredentials: inspect || !selectedAudioFile,
    environment,
  });
  if (inspect) return safeInspection(runtime);
  const audioDirectory = agentAudioDirectory(runtime.dataRoot, agentId);

  const workDirectory = await temporaryDirectory(runtime);
  try {
    let source;
    let sourceFormat;
    let requestId = "";
    if (selectedAudioFile) {
      const loaded = await readAudioFile(selectedAudioFile);
      source = loaded.audio;
      sourceFormat = loaded.format;
    } else {
      const synthesized = await synthesizeDirectVoiceAudio({ text: message, runtime, fetchImpl, ledgerPath, agentId });
      source = synthesized.audio;
      sourceFormat = synthesized.format;
      requestId = synthesized.requestId;
    }
    const saved = await saveMp3Audio({
      source,
      sourceFormat,
      runtime,
      audioDirectory,
      workDirectory,
      processRunner,
      now,
    });
    return {
      status: "ok",
      type: "suzu-voice-audio",
      mediaKind: "audio",
      fileName: saved.fileName,
      savedPath: saved.savedPath,
      size: saved.size,
      ttsRequestId: requestId,
      note: "已生成 MP3。请使用当前 Suzu 会话提供的 conversation-attachment --audio 命令交付给用户。",
    };
  } finally {
    await fsp.rm(workDirectory, { recursive: true, force: true });
  }
}
