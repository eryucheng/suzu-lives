import {
  Config,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DeepSeekAdapter,
  PUBLIC_BASE_URL,
  apply as applyUpstream,
  inject,
  name,
  resolveAdapterOptions,
} from "../vendor/core/modules/deepseek-model.mjs";
import { LlmError, attributionHeaders } from "../vendor/core/modules/llm.mjs";

/**
 * DeepSeek publishes modality support per model rather than per provider. Keep
 * that fact beside the adapter so the Core model catalogue remains the single
 * capability source for both the Electron host and the chat attachment route.
 */
export const DEEPSEEK_VISION_MODEL_IDS = Object.freeze(new Set([
  "deepseek-v4-flash-vision-exp",
]));

const PATCH_MARKER = Symbol.for("suzu-lives.deepseek-vision-adapter.v1");
const IMAGE_MIME_TYPE = /^image\/[a-z0-9.+-]+$/iu;
const REASONING_EFFORTS = new Set(["off", "high", "max"]);

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function blocks(value) {
  return Array.isArray(value) ? value.map((entry) => plainObject(entry)) : [];
}

export function isDeepSeekVisionModel(value) {
  return DEEPSEEK_VISION_MODEL_IDS.has(clean(value).toLowerCase());
}

export function deepSeekInputModalities(modelId) {
  return Object.freeze(isDeepSeekVisionModel(modelId) ? ["text", "image"] : ["text"]);
}

function imageBlocks(value) {
  return blocks(value).filter((block) => block.type === "image");
}

function textContent(value) {
  return blocks(value)
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
}

function imageDataUrl(block) {
  const mimeType = clean(block.mediaType || block.mimeType).toLowerCase();
  if (!IMAGE_MIME_TYPE.test(mimeType)) {
    throw new LlmError("DeepSeek Vision 图片缺少可用的 image/* 媒体类型。", "UNSUPPORTED_CONTENT");
  }
  const raw = block.data;
  if (typeof raw === "string") {
    const value = raw.trim();
    if (/^data:image\/[a-z0-9.+-]+;base64,/iu.test(value)) return value;
    if (!value) throw new LlmError("DeepSeek Vision 图片内容为空。", "UNSUPPORTED_CONTENT");
    return `data:${mimeType};base64,${value.replace(/\s+/gu, "")}`;
  }
  if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
    const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
    if (!bytes.byteLength) throw new LlmError("DeepSeek Vision 图片内容为空。", "UNSUPPORTED_CONTENT");
    return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
  }
  throw new LlmError("DeepSeek Vision 图片内容不可读取。", "UNSUPPORTED_CONTENT");
}

function visualUserContent(content) {
  const parts = [];
  for (const block of blocks(content)) {
    if (block.type === "text") {
      const text = String(block.text ?? "");
      if (text) parts.push({ type: "text", text });
      continue;
    }
    if (block.type === "image") {
      parts.push({ type: "image_url", image_url: { url: imageDataUrl(block) } });
    }
  }
  return parts;
}

function ensureImagesAreUserInput(message) {
  if (!imageBlocks(message?.content).length) return;
  if (message?.role === "user") return;
  throw new LlmError("DeepSeek Vision 仅支持用户消息中的图片内容。", "UNSUPPORTED_CONTENT");
}

function assistantMessage(message) {
  const content = blocks(message.content);
  const text = textContent(content);
  const reasoning = content
    .filter((block) => block.type === "reasoning")
    .map((block) => String(block.text ?? ""))
    .join("");
  const toolCalls = content
    .filter((block) => block.type === "tool-call")
    .map((block) => ({
      id: block.id,
      type: "function",
      function: {
        name: block.name,
        arguments: block.arguments,
      },
    }));
  return {
    role: "assistant",
    content: text,
    ...(toolCalls.length && reasoning ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

function deepSeekMessages(messages) {
  const output = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const source = plainObject(message);
    const content = blocks(source.content);
    ensureImagesAreUserInput(source);
    if (source.role === "system") {
      output.push({ role: "system", content: textContent(content) });
      continue;
    }
    if (source.role === "assistant") {
      output.push(assistantMessage(source));
      continue;
    }

    const toolResults = content.filter((block) => block.type === "tool-result");
    const images = imageBlocks(content);
    const text = textContent(content);
    if (images.length) {
      output.push({ role: "user", content: visualUserContent(content) });
    } else if (text.length || toolResults.length === 0) {
      output.push({ role: "user", content: text });
    }
    for (const result of toolResults) {
      output.push({
        role: "tool",
        tool_call_id: result.toolCallId,
        content: text || "(no output)",
      });
    }
  }
  return output;
}

function thinkingOptions(event, defaults = {}) {
  if (event?.purpose === "session-title") return { thinking: "disabled" };
  const configured = event?.reasoningEffort === undefined ? defaults.reasoningEffort : event.reasoningEffort;
  const effort = configured === undefined ? undefined : clean(configured).toLowerCase();
  if (effort !== undefined && !REASONING_EFFORTS.has(effort)) {
    throw new LlmError(`DeepSeek 不支持推理强度“${configured}”。`, "UNSUPPORTED_REASONING_EFFORT");
  }
  if (defaults.thinking === "disabled" && effort !== undefined && effort !== "off") {
    throw new LlmError(`DeepSeek 当前部署不支持推理强度“${configured}”。`, "UNSUPPORTED_REASONING_EFFORT");
  }
  if (effort === "off") return { thinking: "disabled" };
  if (effort === "high" || effort === "max") return { thinking: "enabled", reasoningEffort: effort };
  return defaults.thinking === undefined ? {} : { thinking: defaults.thinking };
}

function visionPayload(event, defaults = {}) {
  const messages = [];
  if (event.system !== undefined) messages.push({ role: "system", content: event.system });
  messages.push(...deepSeekMessages(event.messages));
  const tools = Array.isArray(event.tools) ? event.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  })) : [];
  const thinking = thinkingOptions(event, defaults);
  return {
    model: event.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(thinking.thinking === undefined ? {} : { thinking: { type: thinking.thinking } }),
    ...(thinking.reasoningEffort === undefined ? {} : { reasoning_effort: thinking.reasoningEffort }),
    ...(tools.length ? { tools } : {}),
    ...(event.temperature === undefined ? {} : { temperature: event.temperature }),
    ...(event.maxTokens === undefined ? {} : { max_tokens: event.maxTokens }),
    ...(event.stop === undefined ? {} : { stop: event.stop }),
  };
}

function retryAfterMs(value) {
  const source = clean(value);
  if (!source) return undefined;
  if (/^\d+$/u.test(source)) {
    const milliseconds = Number(source) * 1_000;
    return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
  }
  const milliseconds = Date.parse(source) - Date.now();
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

function providerErrorCode(status, body) {
  if (status === 401 || status === 403) return "AUTH";
  const error = plainObject(body);
  const detail = [error.code, error.type, error.message].filter(Boolean).join(" ").toLowerCase();
  if (status === 429) return "RATE_LIMIT";
  if (status === 400 && /context|maximum context|too many tokens/u.test(detail)) return "CONTEXT_WINDOW_EXCEEDED";
  if (status === 400) return "INVALID_REQUEST";
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
}

function requestId(headers) {
  const value = headers?.get?.("x-request-id") || headers?.get?.("x-deepseek-request-id");
  return clean(value) || undefined;
}

function sseData(event) {
  const data = [];
  let comment = false;
  for (const line of event.split(/\r?\n/gu)) {
    if (line.startsWith(":")) {
      comment = true;
      continue;
    }
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
  }
  return { comment, data: data.join("\n") };
}

async function* readSseData(body, onHeartbeat) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const emit = async function* (raw) {
    const parsed = sseData(raw);
    if (parsed.comment || parsed.data) {
      try { onHeartbeat?.(); } catch { /* A timeout pulse cannot affect the stream. */ }
    }
    if (parsed.data) yield parsed.data;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const delimiter = /\r?\n\r?\n/gu.exec(buffer);
        if (!delimiter) break;
        const event = buffer.slice(0, delimiter.index);
        buffer = buffer.slice(delimiter.index + delimiter[0].length);
        for await (const data of emit(event)) {
          yield data;
          if (data === "[DONE]") return;
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      for await (const data of emit(buffer)) {
        yield data;
        if (data === "[DONE]") return;
      }
    }
  } finally {
    reader.releaseLock();
  }
  throw new LlmError("DeepSeek SSE 流在完成标记前结束。", "STREAM_CLOSED");
}

async function* requestWithVision(event, signal, options, apiKey, userId, onHeartbeat) {
  const payload = visionPayload(event, options.defaults);
  const headers = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    accept: "text/event-stream",
    ...attributionHeaders(),
    "x-deepseek-harness-user-id": String(userId),
    ...(event.sessionId === undefined ? {} : { "x-deepseek-harness-session-id": String(event.sessionId) }),
    ...(event.purpose === "compaction" ? { "x-deepseek-harness-compact": "1" } : {}),
  };
  let response;
  try {
    response = await fetch(`${options.baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new LlmError(`DeepSeek API 请求失败：${options.baseURL}`, "TRANSPORT", { cause: error });
  }
  if (!response.ok) {
    let body = {};
    let message = `DeepSeek API 错误（HTTP ${response.status}）`;
    try {
      body = plainObject((await response.json()).error);
      if (clean(body.message)) message = clean(body.message);
    } catch { /* Preserve the HTTP response when its body is not JSON. */ }
    const retryAfter = retryAfterMs(response.headers.get("retry-after"));
    const correlationId = requestId(response.headers);
    throw new LlmError(message, providerErrorCode(response.status, body), {
      status: response.status,
      ...(retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter }),
      ...(correlationId === undefined ? {} : { requestId: correlationId }),
    });
  }
  if (!response.body) throw new LlmError("DeepSeek API 未返回响应流。", "EMPTY_RESPONSE");
  yield* readSseData(response.body, onHeartbeat);
}

function eventHasImages(event) {
  return (Array.isArray(event?.messages) ? event.messages : []).some((message) => imageBlocks(message?.content).length > 0);
}

function installDeepSeekVisionPatch() {
  if (DeepSeekAdapter[PATCH_MARKER]) return;
  Object.defineProperty(DeepSeekAdapter, PATCH_MARKER, { value: true });
  const listModels = DeepSeekAdapter.prototype.listModels;
  const resolveModel = DeepSeekAdapter.prototype.resolveModel;
  const request = DeepSeekAdapter.prototype.request;

  DeepSeekAdapter.prototype.listModels = async function listModelsWithVision(provider) {
    const models = await listModels.call(this, provider);
    return models.map((model) => ({ ...model, inputModalities: deepSeekInputModalities(model.id) }));
  };

  DeepSeekAdapter.prototype.resolveModel = async function resolveModelWithVision(provider, modelId, signal) {
    const model = await resolveModel.call(this, provider, modelId, signal);
    return { ...model, inputModalities: deepSeekInputModalities(modelId) };
  };

  DeepSeekAdapter.prototype.request = async function* requestWithNativeVision(event, signal, options, apiKey, userId, onHeartbeat) {
    if (!isDeepSeekVisionModel(event?.model) || !eventHasImages(event)) {
      yield* request.call(this, event, signal, options, apiKey, userId, onHeartbeat);
      return;
    }
    yield* requestWithVision(event, signal, options, apiKey, userId, onHeartbeat);
  };
}

// The class is also imported directly by focused tests and maintenance tools;
// install once at module evaluation so they exercise the same adapter path as
// Cordis's `apply()` call.
installDeepSeekVisionPatch();

export function apply(context, configuration) {
  installDeepSeekVisionPatch();
  return applyUpstream(context, configuration);
}

export {
  Config,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DeepSeekAdapter,
  PUBLIC_BASE_URL,
  inject,
  name,
  resolveAdapterOptions,
};
