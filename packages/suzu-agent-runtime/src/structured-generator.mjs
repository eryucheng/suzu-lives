import {
  BlockAssembler,
  createUserMessage,
} from "@suzu-lives/suzu-agent-runtime/core/llm";

import { createSuzuAgentLifecycleBridgeTransport } from "./lifecycle-bridge.mjs";

export const name = "suzu-structured-generator";
export const inject = ["sessions", "llm", "agents"];

const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_INPUT_CHARACTERS = 96_000;
const MAX_SYSTEM_PROMPT_CHARACTERS = 96_000;
const MAX_SCHEMA_CHARACTERS = 96_000;
const MAX_CONTENT_BLOCKS = 24;
const MAX_IMAGE_BLOCKS = 20;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_NAME_CHARACTERS = 180;
const MAX_TASK_ID_CHARACTERS = 160;
const IMAGE_MEDIA_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function boundedText(value, label, maximum, { required = true } = {}) {
  const text = String(value ?? "").trim();
  if (required && !text) throw new Error(`${label}不能为空。`);
  if (text.length > maximum) throw new Error(`${label}不能超过 ${maximum} 个字符。`);
  return text;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const candidate = Number(value);
  return Number.isInteger(candidate) && candidate >= minimum && candidate <= maximum
    ? candidate
    : fallback;
}

function serializableSchema(value) {
  const schema = plainObject(value);
  let text;
  try {
    text = JSON.stringify(schema);
  } catch {
    throw new Error("一次性结构化推理的输出 Schema 无法序列化。 ");
  }
  if (!text || text.length > MAX_SCHEMA_CHARACTERS) {
    throw new Error(`一次性结构化推理的输出 Schema 不能超过 ${MAX_SCHEMA_CHARACTERS} 个字符。`);
  }
  return { schema, text };
}

function schemaName(value) {
  const normalized = clean(value).replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 80);
  return normalized || "structured_result";
}

function taskId(value) {
  const normalized = clean(value);
  if (normalized.length > MAX_TASK_ID_CHARACTERS || /[\r\n\0]/u.test(normalized)) {
    throw new Error(`一次性结构化推理的任务标识不能超过 ${MAX_TASK_ID_CHARACTERS} 个字符。`);
  }
  return normalized || "structured-generation";
}

function imageName(value) {
  const normalized = clean(value);
  if (normalized.length > MAX_IMAGE_NAME_CHARACTERS || /[\r\n\0]/u.test(normalized)) {
    throw new Error(`一次性结构化推理的图片名称不能超过 ${MAX_IMAGE_NAME_CHARACTERS} 个字符。`);
  }
  return normalized;
}

function imageData(value, mediaType) {
  let encoded = clean(value);
  const dataUrl = encoded.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/iu);
  if (dataUrl) {
    if (clean(dataUrl[1]).toLowerCase() !== mediaType) {
      throw new Error("一次性结构化推理的图片媒体类型与 Data URL 不一致。 ");
    }
    encoded = dataUrl[2];
  }
  encoded = encoded.replace(/\s+/gu, "");
  if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
    throw new Error("一次性结构化推理的图片内容不是有效的 Base64。 ");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`一次性结构化推理的单张图片不能超过 ${MAX_IMAGE_BYTES >> 20} MiB。`);
  }
  const canonical = bytes.toString("base64").replace(/=+$/u, "");
  if (canonical !== encoded.replace(/=+$/u, "")) {
    throw new Error("一次性结构化推理的图片内容不是有效的 Base64。 ");
  }
  return bytes.toString("base64");
}

function inferenceContent(source) {
  const requested = Array.isArray(source.content) ? source.content : [];
  if (!requested.length) {
    return [{
      type: "text",
      text: boundedText(source.input, "一次性结构化推理输入", MAX_INPUT_CHARACTERS),
    }];
  }
  if (requested.length > MAX_CONTENT_BLOCKS) {
    throw new Error(`一次性结构化推理一次最多接受 ${MAX_CONTENT_BLOCKS} 个内容块。`);
  }
  let imageCount = 0;
  let textCharacters = 0;
  const content = requested.map((value) => {
    const block = plainObject(value);
    const type = clean(block.type).toLowerCase();
    if (type === "text") {
      const text = boundedText(block.text, "一次性结构化推理文本块", MAX_INPUT_CHARACTERS);
      textCharacters += text.length;
      if (textCharacters > MAX_INPUT_CHARACTERS) {
        throw new Error(`一次性结构化推理文本合计不能超过 ${MAX_INPUT_CHARACTERS} 个字符。`);
      }
      return { type, text };
    }
    if (type === "image") {
      imageCount += 1;
      if (imageCount > MAX_IMAGE_BLOCKS) {
        throw new Error(`一次性结构化推理一次最多接受 ${MAX_IMAGE_BLOCKS} 张图片。`);
      }
      const mediaType = clean(block.mediaType || block.mimeType).toLowerCase();
      if (!IMAGE_MEDIA_TYPES.has(mediaType)) {
        throw new Error("一次性结构化推理只接受 PNG、JPEG、WebP 或 GIF 图片。 ");
      }
      const name = imageName(block.name);
      return {
        type,
        mediaType,
        data: imageData(block.data, mediaType),
        ...(name ? { name } : {}),
      };
    }
    throw new Error("一次性结构化推理只接受 text 和 image 内容块。 ");
  });
  return content;
}

function targetForSession(ctx, rawSessionId) {
  const sessionId = clean(rawSessionId);
  const session = ctx?.sessions?.get?.(sessionId);
  if (!session) throw new Error("当前 Agent Core 模型路由不可用，无法执行一次性结构化推理。 ");
  const config = plainObject(plainObject(session?.requestHeader?.()).config);
  const agentOptions = plainObject(ctx?.agents?.get?.(sessionId)?.options);
  const provider = clean(config.provider || agentOptions.provider);
  const model = clean(config.model || agentOptions.model);
  if (!provider || !model) throw new Error("当前 Agent Core 没有可用的一次性结构化推理模型路由。 ");
  return { model, provider, sessionId };
}

function outputInstruction({ name: selectedSchemaName, schemaText }) {
  return [
    "只输出一个 JSON 对象，不要输出 Markdown、解释、思考过程或工具调用。",
    `输出必须符合这个 JSON Schema（名称：${selectedSchemaName}）：`,
    schemaText,
  ].join("\n");
}

function jsonOutput(blocks) {
  const text = (Array.isArray(blocks) ? blocks : [])
    .filter((block) => plainObject(block).type === "text")
    .map((block) => String(block.text ?? ""))
    .join("\n")
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .replace(/^\uFEFF/u, "")
    .trim();
  if (!text) throw new Error("Agent Core 一次性结构化推理没有返回 JSON 内容。 ");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Agent Core 一次性结构化推理返回的不是有效 JSON：${clean(error?.message) || "解析失败"}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Agent Core 一次性结构化推理返回的顶层必须是 JSON 对象。 ");
  }
  return parsed;
}

function streamFailure(finish) {
  const source = plainObject(finish);
  const kind = clean(source.kind);
  if (kind === "stop") return null;
  const failure = plainObject(source.failure);
  const error = new Error(clean(failure.message) || "Agent Core 一次性结构化推理没有完成。 ");
  error.code = clean(failure.code) || (kind === "max-tokens" ? "MAX_TOKENS" : "AGENT_CORE_TRANSIENT_INFERENCE_FAILED");
  return error;
}

function commandFailure(error) {
  return {
    ok: false,
    error: {
      code: clean(error?.code) || "AGENT_CORE_TRANSIENT_INFERENCE_FAILED",
      message: clean(error?.message) || "Agent Core 一次性结构化推理失败。",
    },
  };
}

async function runStructuredGeneration(ctx, payload, config = {}) {
  const source = plainObject(payload);
  const target = targetForSession(ctx, source.sessionId);
  const content = inferenceContent(source);
  const selectedTaskId = taskId(source.taskId);
  const systemPrompt = boundedText(source.systemPrompt, "一次性结构化推理系统提示词", MAX_SYSTEM_PROMPT_CHARACTERS, { required: false });
  const selectedSchemaName = schemaName(source.schemaName);
  const { text: schemaText } = serializableSchema(source.schema);
  const maxTokens = boundedInteger(
    source.maxOutputTokens,
    boundedInteger(config.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 256, 32_000),
    256,
    32_000,
  );
  const timeoutMs = boundedInteger(
    source.timeoutMs,
    boundedInteger(config.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 180_000),
    1_000,
    180_000,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const started = Date.now();
  try {
    const assembler = new BlockAssembler();
    const options = {
      provider: target.provider,
      model: target.model,
      system: [systemPrompt, outputInstruction({ name: selectedSchemaName, schemaText })]
        .filter(Boolean)
        .join("\n\n"),
      messages: [createUserMessage({
        content,
        source: {
          kind: "plugin",
          plugin: name,
          form: "notice",
          summary: `Suzu transient inference: ${selectedTaskId}`,
        },
      })],
      tools: [],
      temperature: 0,
      maxTokens,
      signal: controller.signal,
    };
    for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
    const failure = streamFailure(assembler.finish);
    if (failure) throw failure;
    return {
      ok: true,
      output: jsonOutput(assembler.blocks()),
      usage: plainObject(assembler.usage),
      model: target.model,
      requestId: "",
      durationMs: Date.now() - started,
      metadata: {
        provider: "agent-core",
        providerId: target.provider,
        schemaName: selectedSchemaName,
        taskId: selectedTaskId,
      },
    };
  } catch (error) {
    return commandFailure(error);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Agent Core bridge for product-owned, one-shot structured inference. The
 * parent supplies only task content, a prompt, and a schema; this plugin
 * resolves the model from an Agent Core route session, disables tools, and
 * never appends the request or result to that session's transcript.
 */
export function createSuzuStructuredGenerator({
  transport = createSuzuAgentLifecycleBridgeTransport(),
} = {}) {
  if (typeof transport?.handleCommand !== "function") {
    throw new TypeError("structured generator requires handleCommand().");
  }
  const contexts = new Set();
  let registered = false;

  const resolveContext = (sessionId) => {
    for (const ctx of contexts) {
      if (ctx?.sessions?.get?.(clean(sessionId))) return ctx;
    }
    return null;
  };

  const apply = (ctx, config = {}) => {
    contexts.add(ctx);
    if (registered) return;
    registered = true;
    transport.handleCommand("StructuredGenerate", async (payload) => {
      try {
        const commandContext = resolveContext(plainObject(payload).sessionId);
        if (!commandContext) {
          throw new Error("当前 Agent Core 模型路由不可用，无法执行一次性结构化推理。 ");
        }
        return await runStructuredGeneration(commandContext, payload, config);
      } catch (error) {
        return commandFailure(error);
      }
    });
  };

  return Object.freeze({ apply });
}

const defaultStructuredGenerator = createSuzuStructuredGenerator();

export function apply(ctx, config = {}) {
  return defaultStructuredGenerator.apply(ctx, config);
}
