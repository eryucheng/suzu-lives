import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";
import { appendUsageEvent } from "@suzu-lives/cost-ledger";

const DEFAULT_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const DEFAULT_QWEN_MODEL = "qwen3-tts-vd-2026-01-26";
const MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

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

function defaultConfigPath(dataRoot) {
  return path.join(voiceRoot(dataRoot), "config.json");
}

export function resolveVoiceMessageConfigPath({ dataRoot, configPath = "" } = {}) {
  const root = requiredDataRoot(dataRoot);
  const requested = clean(configPath);
  const candidate = requested ? path.resolve(root, requested) : defaultConfigPath(root);
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

function readVoiceConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw failure("config_missing", "配置文件不存在：" + configPath + "；请在 Suzu Lives 的语音设置中选择音色。");
  }
  return readJson(configPath, { code: "config_invalid", label: "语音消息配置" });
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
  const apiKeyEnvironment = clean(config.apiKeyEnv || tts.apiKeyEnv) || "DASHSCOPE_API_KEY";
  const apiKey = clean(apiKeyOverride || environment[apiKeyEnvironment] || config.apiKey || tts.apiKey);
  const voice = clean(config.voiceId || config.voice || tts.voiceId || tts.voice_id || tts.voice);
  if (requireCredentials && !apiKey) {
    throw failure("tts_api_key_missing", "缺少百炼 API Key：请在 Suzu 的“声音”连接中配置，或设置 " + apiKeyEnvironment + "。");
  }
  if (requireCredentials && !voice) {
    throw failure("tts_voice_missing", "缺少音色：请在 Suzu 的语音设置中选择一个音色。");
  }
  return {
    apiKey,
    baseUrl: clean(baseUrlOverride || config.baseUrl || tts.baseUrl || tts.base_url) || DEFAULT_QWEN_BASE_URL,
    model: clean(modelOverride || config.model || tts.model) || DEFAULT_QWEN_MODEL,
    voice,
    maxTextLength: Math.round(positiveNumber(config.maxTextLength || config.max_text_len || tts.maxTextLength || tts.max_text_len, 300)),
    languageType: clean(config.languageType || tts.languageType),
  };
}

export function resolveDirectVoiceRuntime({
  dataRoot,
  configPath = "",
  timeoutMs,
  apiKeyOverride = "",
  baseUrlOverride = "",
  modelOverride = "",
  requireTtsCredentials = true,
  environment = process.env,
} = {}) {
  const root = requiredDataRoot(dataRoot);
  const selectedConfigPath = resolveVoiceMessageConfigPath({ dataRoot: root, configPath });
  const localConfig = readVoiceConfig(selectedConfigPath);
  return {
    dataRoot: root,
    runtimeDataRoot: voiceRoot(root),
    configPath: selectedConfigPath,
    timeoutMs: Math.round(positiveNumber(timeoutMs || localConfig.timeoutMs, 30000)),
    ffmpegPath: clean(localConfig.ffmpegPath) || "ffmpeg",
    tts: resolveTts(localConfig, environment, {
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
    tts: {
      provider: "qwen",
      model: runtime.tts.model,
      voiceConfigured: Boolean(runtime.tts.voice),
      apiKeyConfigured: Boolean(runtime.tts.apiKey),
    },
  };
}

function withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

async function readResponseBytes(response, label, { responseCode = "tts_response_invalid" } = {}) {
  if (!response || typeof response.arrayBuffer !== "function") throw failure(responseCode, label + "响应不可读取。", 5);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES) throw failure(responseCode, label + "响应超过" + MAX_RESPONSE_BYTES + "字节", 5);
  return bytes;
}

async function fetchJson(fetchImpl, url, options, timeoutMs, label) {
  const timeout = withTimeout(timeoutMs);
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
    if (error?.name === "AbortError") throw failure("tts_timeout", label + "超时", 5);
    if (error instanceof DirectVoiceMessageError) throw error;
    throw failure("tts_network_error", label + "请求失败：" + (clean(error?.message) || "未知错误"), 5);
  } finally {
    timeout.cancel();
  }
}

async function fetchBuffer(fetchImpl, url, timeoutMs, label) {
  const timeout = withTimeout(timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: timeout.signal });
    if (!response?.ok) throw failure("tts_audio_download_failed", label + " HTTP " + (response?.status || 0), 5);
    return await readResponseBytes(response, label);
  } catch (error) {
    if (error?.name === "AbortError") throw failure("tts_timeout", label + "超时", 5);
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

async function synthesizeQwen({ text, runtime, fetchImpl, ledgerPath, agentId }) {
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
  );
  if (clean(result.code) || Number(result.status_code || 200) >= 400) {
    throw failure("tts_provider_error", ("百炼 TTS 失败：" + clean(result.code) + " " + clean(result.message)).trim(), 5);
  }
  const audioUrl = clean(result.output?.audio?.url);
  if (!audioUrl) throw failure("tts_response_invalid", "百炼 TTS 响应缺少 output.audio.url", 5);
  const audio = await fetchBuffer(fetchImpl, audioUrl, runtime.timeoutMs, "下载合成音频");
  const targetLedger = clean(ledgerPath);
  if (!targetLedger) throw failure("ledger_path_missing", "缺少 Suzu Lives 用量账本路径。", 10);
  try {
    await appendUsageEvent(targetLedger, {
      agentId: clean(agentId),
      provider: "阿里云百炼",
      model: runtime.tts.model,
      source: "语音合成",
      feature: "voice-message-tts",
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
  const runtime = resolveDirectVoiceRuntime({
    dataRoot,
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
      const synthesized = await synthesizeQwen({ text: message, runtime, fetchImpl, ledgerPath, agentId });
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
