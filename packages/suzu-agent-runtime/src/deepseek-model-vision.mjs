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
import { formatErrorForDisplay } from "./error-detail.mjs";
import { modelCatalogEntries, modelInputModalities } from "./model-capability-catalog.mjs";

/**
 * DeepSeek publishes modality support per model rather than per provider. Keep
 * that fact beside the adapter so the Core model catalogue remains the single
 * capability source for both the Electron host and the chat attachment route.
 */
export const DEEPSEEK_VISION_MODEL_IDS = Object.freeze(new Set([
  ...modelCatalogEntries("deepseek")
    .filter((entry) => entry.input.includes("image"))
    .map((entry) => entry.id),
]));

const PATCH_MARKER = Symbol.for("suzu-lives.deepseek-vision-adapter.v1");
const IMAGE_MIME_TYPE = /^image\/[a-z0-9.+-]+$/iu;
const REASONING_EFFORTS = new Set(["off", "low", "high", "max"]);
const ADAPTER_ATTACHMENT_RESOLVERS = new WeakMap();

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
  return modelInputModalities("deepseek", modelId);
}

function withDeepSeekLowReasoning(model) {
  const reasoning = plainObject(model?.reasoning);
  const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
  if (!efforts.some((effort) => effort?.id === "high" || effort?.id === "max")
    || efforts.some((effort) => effort?.id === "low")) return model;
  const highIndex = efforts.findIndex((effort) => effort?.id === "high");
  const nextEfforts = [...efforts];
  nextEfforts.splice(highIndex < 0 ? nextEfforts.length : highIndex, 0, { id: "low", name: "Low" });
  return { ...model, reasoning: { ...reasoning, efforts: nextEfforts } };
}

function imageBlocks(value) {
  const images = [];
  for (const block of blocks(value)) {
    if (block.type === "image") images.push(block);
    if (block.type === "tool-result") images.push(...imageBlocks(block.content));
  }
  return images;
}

function textContent(value) {
  return blocks(value)
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
}

function nestedTextContent(value) {
  return blocks(value)
    .map((block) => {
      if (block.type === "text") return String(block.text ?? "");
      if (block.type === "tool-result") return nestedTextContent(block.content);
      return "";
    })
    .join("");
}

function attachmentStore(adapter) {
  const configured = adapter?.config?.resolveAttachments;
  if (typeof configured === "function") return configured();
  return ADAPTER_ATTACHMENT_RESOLVERS.get(adapter)?.();
}

async function imageDataUrl(block, attachments) {
  let mimeType = clean(block.mediaType || block.mimeType).toLowerCase();
  let raw = block.data;
  if (raw === undefined && plainObject(block.attachment).attachmentId) {
    if (typeof attachments?.readImage !== "function") {
      throw new LlmError("DeepSeek Vision 无法读取工具返回的图片附件。", "UNSUPPORTED_CONTENT");
    }
    let stored;
    try {
      stored = await attachments.readImage(block.attachment);
    } catch (error) {
      throw new LlmError("DeepSeek Vision 无法读取工具返回的图片附件。", "ATTACHMENT_READ_FAILED", { cause: error });
    }
    const reference = plainObject(stored?.ref);
    mimeType = clean(reference.mediaType || mimeType).toLowerCase();
    raw = stored?.data;
  }
  if (!IMAGE_MIME_TYPE.test(mimeType)) {
    throw new LlmError("DeepSeek Vision 图片缺少可用的 image/* 媒体类型。", "UNSUPPORTED_CONTENT");
  }
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

async function visualUserContent(content, attachments) {
  const parts = [];
  for (const block of blocks(content)) {
    if (block.type === "text") {
      const text = String(block.text ?? "");
      if (text) parts.push({ type: "text", text });
      continue;
    }
    if (block.type === "image") {
      parts.push({ type: "image_url", image_url: { url: await imageDataUrl(block, attachments) } });
      continue;
    }
    if (block.type === "tool-result") {
      parts.push(...await visualUserContent(block.content, attachments));
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

function assistantToolCallIds(message) {
  return blocks(message?.content)
    .filter((block) => block.type === "tool-call")
    .map((block) => clean(block.id))
    .filter(Boolean);
}

function assistantReasoning(message) {
  return blocks(message?.content)
    .filter((block) => block.type === "reasoning")
    .map((block) => String(block.text ?? ""))
    .join("");
}

function removeUnreplayableToolHistory(messages) {
  const unreplayableCallIds = new Set();
  const output = [];
  let changed = false;

  for (const candidate of Array.isArray(messages) ? messages : []) {
    const message = plainObject(candidate);
    const content = blocks(message.content);
    if (message.role === "assistant") {
      const callIds = assistantToolCallIds(message);
      // DeepSeek requires the original reasoning_content to accompany an
      // assistant tool-call message in thinking mode. If a historical record
      // cannot provide it, replaying that pair is invalid. Keep the rest of
      // the conversation rather than fabricating a reasoning trace.
      if (callIds.length && !clean(assistantReasoning(message))) {
        for (const callId of callIds) unreplayableCallIds.add(callId);
        changed = true;
        continue;
      }
      output.push(candidate);
      continue;
    }

    const retainedContent = content.filter((block) => (
      block.type !== "tool-result" || !unreplayableCallIds.has(clean(block.toolCallId))
    ));
    if (retainedContent.length === content.length) {
      output.push(candidate);
      continue;
    }

    changed = true;
    // A tool result without its initiating assistant tool call is not valid
    // OpenAI-compatible history either, so remove the matching result too.
    if (!retainedContent.length) continue;
    output.push({ ...message, content: retainedContent });
  }

  return changed ? output : messages;
}

function eventForThinkingReplay(event, defaults = {}) {
  const thinking = thinkingOptions(event, defaults);
  if (thinking.thinking === "disabled") return event;
  const messages = removeUnreplayableToolHistory(event?.messages);
  return messages === event?.messages ? event : { ...event, messages };
}

async function deepSeekMessages(messages, attachments) {
  const output = [];
  // Parallel tool results can be stored as separate Harness messages. Keep
  // every wire-level `tool` reply adjacent before adding the user image carrier.
  let pendingToolImageContent = [];
  const flushToolImages = async () => {
    if (!pendingToolImageContent.length) return;
    output.push({
      role: "user",
      content: [
        { type: "text", text: "以上工具结果包含以下图片。" },
        ...(await visualUserContent(pendingToolImageContent, attachments)).filter((part) => part.type === "image_url"),
      ],
    });
    pendingToolImageContent = [];
  };
  for (const message of Array.isArray(messages) ? messages : []) {
    const source = plainObject(message);
    const content = blocks(source.content);
    const toolResults = content.filter((block) => block.type === "tool-result");
    const directContent = content.filter((block) => block.type !== "tool-result");
    const toolOnlyMessage = source.role === "user" && toolResults.length > 0 && directContent.length === 0;
    if (!toolOnlyMessage) await flushToolImages();
    ensureImagesAreUserInput(source);
    if (source.role === "system") {
      output.push({ role: "system", content: textContent(content) });
      continue;
    }
    if (source.role === "assistant") {
      output.push(assistantMessage(source));
      continue;
    }

    const images = imageBlocks(directContent);
    const text = textContent(directContent);
    if (images.length) {
      output.push({ role: "user", content: await visualUserContent(directContent, attachments) });
    } else if (text.length || toolResults.length === 0) {
      output.push({ role: "user", content: text });
    }
    for (const result of toolResults) {
      const resultText = nestedTextContent(result.content);
      const resultImages = imageBlocks(result.content);
      output.push({
        role: "tool",
        tool_call_id: result.toolCallId,
        content: resultText || (resultImages.length ? "(image output)" : "(no output)"),
      });
      if (resultImages.length) pendingToolImageContent.push(...blocks(result.content));
    }
  }
  await flushToolImages();
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
  if (effort === "low" || effort === "high" || effort === "max") return { thinking: "enabled", reasoningEffort: effort };
  return defaults.thinking === undefined ? {} : { thinking: defaults.thinking };
}

async function visionPayload(event, defaults = {}, attachments) {
  const messages = [];
  if (event.system !== undefined) messages.push({ role: "system", content: event.system });
  messages.push(...await deepSeekMessages(event.messages, attachments));
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

function finishReason(value) {
  if (value === "stop") return { kind: "stop" };
  if (value === "tool_calls") return { kind: "tool-calls" };
  if (value === "length") return { kind: "max-tokens" };
  return {
    kind: "error",
    failure: {
      message: `模型异常结束：${value}`,
      code: clean(value).toUpperCase() || "UNKNOWN",
    },
  };
}

function responseUsage(value) {
  const usage = plainObject(value);
  const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: Number(usage.prompt_tokens) - (cacheReadTokens === undefined ? 0 : Number(cacheReadTokens)),
    outputTokens: Number(usage.completion_tokens),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens: Number(cacheReadTokens) }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens: Number(reasoningTokens) }),
  };
}

function completedStreamBlock(block) {
  if (block.kind === "text" || block.kind === "reasoning") {
    return { type: block.kind, text: block.text };
  }
  return {
    type: "tool-call",
    id: block.callId || "",
    name: block.name || "",
    arguments: block.text,
  };
}

async function* decodeDeepSeekSseChunks(dataStream) {
  let nextIndex = 0;
  let textBlock;
  let reasoningBlock;
  let finish;
  let usage;
  const orderedBlocks = [];
  const toolBlocks = new Map();
  const openBlock = (kind) => {
    const block = { index: nextIndex++, kind, text: "" };
    orderedBlocks.push(block);
    return block;
  };

  for await (const data of dataStream) {
    if (data === "[DONE]") {
      for (const block of orderedBlocks) {
        yield { type: "block-end", index: block.index, block: completedStreamBlock(block) };
      }
      if (usage) yield { type: "usage", usage };
      const reason = finish || { kind: "stop" };
      yield {
        type: "finish",
        reason: reason.kind === "stop" && !orderedBlocks.length
          ? {
            kind: "error",
            failure: {
              message: "DeepSeek 返回了完成但没有内容的响应。",
              code: "EMPTY_RESPONSE",
            },
          }
          : reason,
      };
      return;
    }

    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new LlmError(`DeepSeek SSE 响应无法解析：${data.slice(0, 120)}`, "MALFORMED_RESPONSE");
    }

    for (const choice of Array.isArray(payload?.choices) ? payload.choices : []) {
      const delta = plainObject(plainObject(choice).delta);
      const reasoningDelta = delta.reasoning_content;
      if (typeof reasoningDelta === "string" && reasoningDelta.length) {
        if (!reasoningBlock) {
          reasoningBlock = openBlock("reasoning");
          yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
        }
        reasoningBlock.text += reasoningDelta;
        yield { type: "reasoning-delta", index: reasoningBlock.index, text: reasoningDelta };
      }

      const textDelta = delta.content;
      if (typeof textDelta === "string" && textDelta.length) {
        if (!textBlock) {
          textBlock = openBlock("text");
          yield { type: "block-start", index: textBlock.index, blockType: "text" };
        }
        textBlock.text += textDelta;
        yield { type: "text-delta", index: textBlock.index, text: textDelta };
      }

      for (const toolCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const source = plainObject(toolCall);
        const sourceIndex = Number.isInteger(source.index) ? source.index : toolBlocks.size;
        let toolBlock = toolBlocks.get(sourceIndex);
        if (!toolBlock) {
          toolBlock = openBlock("tool-call");
          toolBlock.callId = "";
          toolBlock.name = "";
          toolBlocks.set(sourceIndex, toolBlock);
          yield { type: "block-start", index: toolBlock.index, blockType: "tool-call" };
        }
        if (clean(source.id)) toolBlock.callId = clean(source.id);
        const fn = plainObject(source.function);
        if (clean(fn.name)) toolBlock.name = clean(fn.name);
        const argumentsDelta = typeof fn.arguments === "string" ? fn.arguments : "";
        toolBlock.text += argumentsDelta;
        yield {
          type: "tool-call-delta",
          index: toolBlock.index,
          id: toolBlock.callId,
          ...(toolBlock.name ? { name: toolBlock.name } : {}),
          argumentsDelta,
        };
      }

      if (typeof choice?.finish_reason === "string") finish = finishReason(choice.finish_reason);
    }
    if (payload?.usage) usage = responseUsage(payload.usage);
  }
  throw new LlmError("DeepSeek SSE 流在完成标记前结束。", "STREAM_CLOSED");
}

async function* requestWithVision(event, signal, options, apiKey, userId, onHeartbeat, attachments) {
  const payload = await visionPayload(event, options.defaults, attachments);
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
    throw new LlmError(
      `DeepSeek API 请求失败：${options.baseURL}（原因：${formatErrorForDisplay(error, { fallback: "未知网络错误。" })}）`,
      "TRANSPORT",
      { cause: error },
    );
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
  yield* decodeDeepSeekSseChunks(readSseData(response.body, onHeartbeat));
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
    return withDeepSeekLowReasoning({ ...model, inputModalities: deepSeekInputModalities(modelId) });
  };

  DeepSeekAdapter.prototype.request = async function* requestWithNativeVision(event, signal, options, apiKey, userId, onHeartbeat) {
    const replaySafeEvent = eventForThinkingReplay(event, options?.defaults);
    const effort = clean(replaySafeEvent?.reasoningEffort ?? options?.defaults?.reasoningEffort).toLowerCase();
    if (effort !== "low" && (!isDeepSeekVisionModel(replaySafeEvent?.model) || !eventHasImages(replaySafeEvent))) {
      yield* request.call(this, replaySafeEvent, signal, options, apiKey, userId, onHeartbeat);
      return;
    }
    yield* requestWithVision(replaySafeEvent, signal, options, apiKey, userId, onHeartbeat, attachmentStore(this));
  };
}

// The class is also imported directly by focused tests and maintenance tools;
// install once at module evaluation so they exercise the same adapter path as
// Cordis's `apply()` call.
installDeepSeekVisionPatch();

export function apply(context, configuration) {
  installDeepSeekVisionPatch();
  const result = applyUpstream(context, configuration);
  const adapter = context?.llm?.adapters?.get?.("deepseek-official")?.adapter;
  if (adapter instanceof DeepSeekAdapter) {
    ADAPTER_ATTACHMENT_RESOLVERS.set(adapter, () => context.get?.("attachments"));
  }
  return result;
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
