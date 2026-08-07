import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { CapabilityExecutionError, assertInvocationGate, assertVerifiedCapabilityAuthorization } from "@suzu-lives/capability-runtime";

export class MediaUnderstandingError extends Error {}

export const IMAGE_VISION_SYSTEM_PROMPT = "只根据图片中能直接看到的内容回答。不要识别真实身份，也不要推测敏感属性；看不清的地方明确说明不确定。";
export const VIDEO_UNDERSTANDING_SYSTEM_PROMPT = "只陈述这段视频里实际出现或能够可靠听到的内容，不用上下文补写，不猜测看不清或听不清的细节。";

const IMAGE_DETAILS = new Set(["auto", "low", "high"]);
const IMAGE_MIME_TYPES = Object.freeze({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" });

function clean(value) {
  return String(value ?? "").trim();
}

function boundedText(value, label, maximum) {
  const text = clean(value);
  if (!text || text.length > maximum) throw new MediaUnderstandingError(`${label}不能为空，且最多 ${maximum} 个字符。`);
  return text;
}

function requiredDataRoot(value) {
  const root = clean(value);
  if (!root) throw new MediaUnderstandingError("缺少 Suzu Lives 软件数据目录。");
  return path.resolve(root);
}

function localFile(value, label) {
  const candidate = clean(value);
  if (!candidate) throw new MediaUnderstandingError(`${label}不能为空。`);
  const resolved = path.resolve(candidate);
  try {
    if (fs.statSync(resolved).isFile()) return resolved;
  } catch {
    // The caller receives the same bounded error for missing and non-file paths.
  }
  throw new MediaUnderstandingError(`${label}不是可读取的文件。`);
}

function optionalFiniteNumber(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER, fallback = 0 } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new MediaUnderstandingError(`${label}必须在 ${minimum} 到 ${maximum} 之间。`);
  }
  return number;
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function mediaRoot(dataRoot, abilityId) {
  return path.join(requiredDataRoot(dataRoot), "capabilities", abilityId);
}

function httpUrl(value, label) {
  const source = clean(value);
  if (!isHttpUrl(source)) throw new MediaUnderstandingError(`${label}必须是 http 或 https 地址。`);
  return source;
}

function endpointFromBaseUrl(value) {
  const base = httpUrl(value, "模型地址").replace(/\/+$/u, "");
  if (base.endsWith("/chat/completions")) return base;
  if (base.endsWith("/v1")) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function providerConfiguration(configuration = {}, label) {
  const provider = configuration.provider && typeof configuration.provider === "object" && !Array.isArray(configuration.provider)
    ? configuration.provider
    : configuration;
  const baseUrl = httpUrl(provider.baseUrl, `${label}模型地址`);
  const model = boundedText(provider.model, `${label}模型`, 200);
  return { baseUrl, model };
}

async function resolveSecureProviderCredential(credentialResolver, { abilityId, provider }) {
  if (typeof credentialResolver !== "function") {
    throw new CapabilityExecutionError("SECURE_CREDENTIAL_SOURCE_UNAVAILABLE", `${abilityId} 尚未接入软件既有的安全凭据来源，已拒绝调用。`, { abilityId });
  }
  const resolved = await credentialResolver({ abilityId, provider: { ...provider } });
  const apiKey = clean(typeof resolved === "string" ? resolved : resolved?.apiKey);
  if (!apiKey) {
    throw new CapabilityExecutionError("SECURE_CREDENTIAL_SOURCE_UNAVAILABLE", `${abilityId} 没有可用的软件安全凭据，已拒绝调用。`, { abilityId });
  }
  return apiKey;
}

function responseText(response) {
  if (typeof response?.text !== "function") return Promise.resolve("");
  return response.text();
}

async function responseJson(response, label) {
  const text = await responseText(response);
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // The bounded error below is intentionally not an upstream body echo.
  }
  throw new MediaUnderstandingError(`${label}返回的不是有效 JSON。`);
}

function extractCompletionText(payload, label) {
  const content = payload?.choices?.[0]?.message?.content;
  const text = typeof content === "string"
    ? content.trim()
    : Array.isArray(content)
      ? content.map((part) => clean(part?.text)).filter(Boolean).join("\n")
      : "";
  if (!text) throw new MediaUnderstandingError(`${label}返回中缺少回复内容。`);
  return text;
}

function contentFromSseOrJson(value, label) {
  const source = clean(value);
  if (!source) throw new MediaUnderstandingError(`${label}返回为空。`);
  if (!source.includes("data:")) return extractCompletionText(JSON.parse(source), label);
  const pieces = [];
  for (const line of source.split(/\r?\n/u)) {
    if (!line.trim().startsWith("data:")) continue;
    const payload = line.replace(/^\s*data:\s*/u, "").trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const content = payload && JSON.parse(payload)?.choices?.[0]?.delta?.content;
      if (typeof content === "string") pieces.push(content);
    } catch {
      // A malformed SSE line will be handled as an empty response below.
    }
  }
  const text = pieces.join("").trim();
  if (!text) throw new MediaUnderstandingError(`${label}返回中缺少回复内容。`);
  return text;
}

function mimeForImage(filePath) {
  return IMAGE_MIME_TYPES[path.extname(filePath).toLowerCase()] || "";
}

function fileDataUrl(filePath, mime) {
  return `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

async function writeJsonAtomic(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, filePath);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeStamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/gu, "-");
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const result = { code: Number(code ?? -1), stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (result.code === 0) resolve(result);
      else reject(new MediaUnderstandingError(`本地媒体工具失败（${result.code}）：${(result.stderr || result.stdout).slice(-1200)}`));
    });
  });
}

async function probeCommand(command, runProcess) {
  try {
    await runProcess(command, ["-version"]);
    return true;
  } catch {
    return false;
  }
}

export function createImageVisionPlan({ imagePath, question, detail = "auto", dataRoot } = {}) {
  const sourcePath = localFile(imagePath, "图片路径");
  const resolvedDetail = clean(detail).toLowerCase() || "auto";
  if (!IMAGE_DETAILS.has(resolvedDetail)) throw new MediaUnderstandingError("图片细节级别只能是 auto、low 或 high。");
  return {
    abilityId: "image-vision",
    status: "requires-provider-configuration",
    sourcePath,
    question: boundedText(question || "请客观说明图片中能直接看到的主要内容。", "问题", 2_000),
    detail: resolvedDetail,
    systemPrompt: IMAGE_VISION_SYSTEM_PROMPT,
    runtimeDataRoot: mediaRoot(dataRoot, "image-vision"),
    willCallExternalService: false,
    nextRequirement: "在 Suzu Lives 中配置视觉模型连接并确认图片访问范围。",
  };
}

/** OpenAI-compatible image vision executor; only called through a gate. */
export async function executeImageVision({
  dataRoot,
  gate,
  configuration = {},
  authorization,
  invocation,
  imagePath,
  question,
  detail = "auto",
  fetchImpl = globalThis.fetch,
  credentialResolver,
  now = () => new Date(),
} = {}) {
  assertInvocationGate({ abilityId: "image-vision", gate, dependencies: {} });
  assertVerifiedCapabilityAuthorization({ authorization, abilityId: "image-vision", action: "analyze-image", scope: invocation?.scope });
  const provider = providerConfiguration(configuration, "视觉");
  const apiKey = await resolveSecureProviderCredential(credentialResolver, { abilityId: "image-vision", provider });
  assertInvocationGate({
    abilityId: "image-vision",
    gate,
    dependencies: { "HTTP 客户端": typeof fetchImpl === "function", "视觉 API Key": Boolean(apiKey) },
  });
  const sourcePath = localFile(imagePath, "图片路径");
  const mime = mimeForImage(sourcePath);
  if (!mime) throw new MediaUnderstandingError("图片格式必须是 JPEG、PNG、WebP 或 GIF。 ");
  if (fs.statSync(sourcePath).size > 20 * 1024 * 1024) throw new MediaUnderstandingError("图片不能超过 20 MB。 ");
  const requestedDetail = clean(detail).toLowerCase() || "auto";
  if (!IMAGE_DETAILS.has(requestedDetail)) throw new MediaUnderstandingError("图片细节级别只能是 auto、low 或 high。");
  const prompt = boundedText(question || "请客观说明图片中能直接看到的主要内容。", "问题", 2_000);
  const payload = {
    model: provider.model,
    messages: [
      { role: "system", content: IMAGE_VISION_SYSTEM_PROMPT },
      { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: fileDataUrl(sourcePath, mime), detail: requestedDetail } }] },
    ],
    temperature: 0.2,
    max_tokens: 2_000,
  };
  let response;
  try {
    response = await fetchImpl(endpointFromBaseUrl(provider.baseUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "User-Agent": "suzu-lives-image-vision/1.0" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new MediaUnderstandingError(`连接视觉模型失败：${clean(error?.message) || "未知错误"}`);
  }
  if (!response?.ok) throw new MediaUnderstandingError(`视觉模型拒绝请求（HTTP ${response?.status || 0}）。`);
  const responsePayload = await responseJson(response, "视觉模型");
  const answer = extractCompletionText(responsePayload, "视觉模型");
  const runtimeDataRoot = mediaRoot(dataRoot, "image-vision");
  const runPath = path.join(runtimeDataRoot, "runs", `vision-${safeStamp(now())}.json`);
  await writeJsonAtomic(runPath, { status: "ok", sourcePath, question: prompt, detail: requestedDetail, answer, model: responsePayload.model || provider.model, completedAt: now().toISOString() });
  return { abilityId: "image-vision", status: "ok", answer, runPath, model: responsePayload.model || provider.model, requestId: clean(responsePayload.request_id || responsePayload.id) };
}

export function createVideoUnderstandingPlan({ video, question, startSeconds = 0, endSeconds = 0, fps = 1, dataRoot } = {}) {
  const source = clean(video);
  if (!source) throw new MediaUnderstandingError("视频路径或 URL 不能为空。");
  const sourceKind = isHttpUrl(source) ? "url" : "file";
  const sourceValue = sourceKind === "url" ? source : localFile(source, "视频路径");
  const start = optionalFiniteNumber(startSeconds, "开始秒数", { maximum: 86_400, fallback: 0 });
  const end = optionalFiniteNumber(endSeconds, "结束秒数", { maximum: 86_400, fallback: 0 });
  if (end && end <= start) throw new MediaUnderstandingError("结束秒数必须大于开始秒数。");
  const sampleRate = optionalFiniteNumber(fps, "采样帧率", { minimum: 0.1, maximum: 10, fallback: 1 });
  return {
    abilityId: "video-understanding",
    status: "requires-provider-and-tooling-configuration",
    source: sourceValue,
    sourceKind,
    question: boundedText(question || "请概括这个片段实际发生了什么。", "问题", 2_000),
    startSeconds: start,
    endSeconds: end || null,
    fps: sampleRate,
    systemPrompt: VIDEO_UNDERSTANDING_SYSTEM_PROMPT,
    runtimeDataRoot: mediaRoot(dataRoot, "video-understanding"),
    cacheDirectory: path.join(mediaRoot(dataRoot, "video-understanding"), "cache"),
    willRunFfmpeg: false,
    willCallExternalService: false,
    nextRequirement: "在 Suzu Lives 中配置视频模型连接，并确认 FFmpeg/FFprobe 可用。",
  };
}

/**
 * Prepares a bounded MP4 in the Suzu Lives runtime directory, then sends it
 * to an OpenAI-compatible video endpoint.  All process/network calls happen
 * only after gate, dependency, and request-authorization checks.
 */
export async function executeVideoUnderstanding({
  dataRoot,
  gate,
  configuration = {},
  authorization,
  invocation,
  video,
  question,
  startSeconds = 0,
  endSeconds = 0,
  fps = 1,
  fetchImpl = globalThis.fetch,
  credentialResolver,
  runProcess = runCommand,
  dependencyProbe,
  now = () => new Date(),
} = {}) {
  assertInvocationGate({ abilityId: "video-understanding", gate, dependencies: {} });
  assertVerifiedCapabilityAuthorization({ authorization, abilityId: "video-understanding", action: "analyze-video", scope: invocation?.scope });
  const provider = providerConfiguration(configuration, "视频");
  const apiKey = await resolveSecureProviderCredential(credentialResolver, { abilityId: "video-understanding", provider });
  const ffmpegPath = boundedText(configuration.ffmpegPath, "FFmpeg 路径", 500);
  const ffprobePath = boundedText(configuration.ffprobePath, "FFprobe 路径", 500);
  assertInvocationGate({
    abilityId: "video-understanding",
    gate,
    dependencies: { "HTTP 客户端": typeof fetchImpl === "function", "视频 API Key": Boolean(apiKey), "视频进程执行器": typeof runProcess === "function" },
  });
  const available = dependencyProbe
    ? await dependencyProbe({ ffmpegPath, ffprobePath })
    : (await probeCommand(ffmpegPath, runProcess)) && (await probeCommand(ffprobePath, runProcess));
  assertInvocationGate({ abilityId: "video-understanding", gate, dependencies: { "FFmpeg/FFprobe": available === true } });
  const source = clean(video);
  if (!source) throw new MediaUnderstandingError("视频路径或 URL 不能为空。");
  const sourceKind = isHttpUrl(source) ? "url" : "file";
  const sourceValue = sourceKind === "url" ? source : localFile(source, "视频路径");
  const start = optionalFiniteNumber(startSeconds, "开始秒数", { maximum: 86_400, fallback: 0 });
  const end = optionalFiniteNumber(endSeconds, "结束秒数", { maximum: 86_400, fallback: 0 });
  if (end && end <= start) throw new MediaUnderstandingError("结束秒数必须大于开始秒数。");
  const sampleRate = optionalFiniteNumber(fps, "采样帧率", { minimum: 0.1, maximum: 10, fallback: 1 });
  const promptQuestion = boundedText(question || "请概括这个片段实际发生了什么。", "问题", 2_000);
  const runtimeDataRoot = mediaRoot(dataRoot, "video-understanding");
  const workId = `video-${safeStamp(now())}`;
  const workDirectory = path.join(runtimeDataRoot, "runtime", workId);
  const clipPath = path.join(workDirectory, "segment.mp4");
  await fsp.mkdir(workDirectory, { recursive: true });
  let probe;
  try {
    probe = await runProcess(ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "json", sourceValue]);
  } catch (error) {
    throw new MediaUnderstandingError(`FFprobe 无法读取视频：${clean(error?.message) || "未知错误"}`);
  }
  let duration;
  try {
    duration = Number(JSON.parse(probe.stdout).format?.duration);
  } catch {
    duration = Number.NaN;
  }
  if (!Number.isFinite(duration) || duration <= 0) throw new MediaUnderstandingError("FFprobe 没有返回有效的视频时长。 ");
  const clipArgs = ["-hide_banner", "-loglevel", "error", "-y"];
  if (start > 0) clipArgs.push("-ss", String(start));
  clipArgs.push("-i", sourceValue);
  if (end > 0) clipArgs.push("-t", String(end - start));
  clipArgs.push("-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=854:854:force_original_aspect_ratio=decrease:force_divisible_by=2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "29", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "56k", "-ar", "16000", "-ac", "1", "-movflags", "+faststart", clipPath);
  try {
    await runProcess(ffmpegPath, clipArgs);
  } catch (error) {
    throw new MediaUnderstandingError(`FFmpeg 无法准备视频片段：${clean(error?.message) || "未知错误"}`);
  }
  let clip;
  try {
    clip = await fsp.readFile(clipPath);
  } catch {
    throw new MediaUnderstandingError("FFmpeg 没有生成可读取的视频片段。 ");
  }
  if (clip.length === 0 || clip.length > 7_500_000) throw new MediaUnderstandingError("准备后的视频片段为空或超过 7.5 MB 上限。 ");
  const clipSha256 = digest(clip);
  const cacheKey = digest(JSON.stringify({ clipSha256, promptQuestion, model: provider.model, fps: sampleRate }));
  const cachePath = path.join(runtimeDataRoot, "cache", `${cacheKey}.json`);
  try {
    const cached = JSON.parse(await fsp.readFile(cachePath, "utf8"));
    if (cached?.status === "ok") return { ...cached, cached: true, cachePath };
  } catch {
    // Cache misses and malformed cache entries are treated as a new run.
  }
  const payload = {
    model: provider.model,
    messages: [
      { role: "system", content: VIDEO_UNDERSTANDING_SYSTEM_PROMPT },
      { role: "user", content: [{ type: "video_url", video_url: { url: `data:video/mp4;base64,${clip.toString("base64")}` }, fps: sampleRate }, { type: "text", text: `你收到的是一段完整输入视频，时长约 ${duration.toFixed(2)} 秒。\n${promptQuestion}` }] },
    ],
    modalities: ["text"],
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.2,
    max_tokens: 2_000,
  };
  let response;
  try {
    response = await fetchImpl(endpointFromBaseUrl(provider.baseUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream", "User-Agent": "suzu-lives-video-understanding/1.0" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new MediaUnderstandingError(`连接视频模型失败：${clean(error?.message) || "未知错误"}`);
  }
  if (!response?.ok) throw new MediaUnderstandingError(`视频模型拒绝请求（HTTP ${response?.status || 0}）。`);
  const raw = await responseText(response);
  let summary;
  try {
    summary = contentFromSseOrJson(raw, "视频模型");
  } catch (error) {
    throw error instanceof MediaUnderstandingError ? error : new MediaUnderstandingError("视频模型返回无法解析。 ");
  }
  let responsePayload = {};
  try { responsePayload = JSON.parse(raw); } catch { /* SSE response has no single JSON envelope. */ }
  const result = { abilityId: "video-understanding", status: "ok", source: sourceKind === "url" ? sourceValue.replace(/\?.*$/u, "") : sourceValue, summary, durationSeconds: Math.round(duration * 1000) / 1000, fps: sampleRate, preparedVideoBytes: clip.length, clipSha256, model: responsePayload.model || provider.model, requestId: clean(responsePayload.request_id || responsePayload.id), completedAt: now().toISOString() };
  await writeJsonAtomic(cachePath, result);
  return { ...result, cached: false, cachePath, clipPath };
}
