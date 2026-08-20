import {
  BlockAssembler,
  createUserMessage,
} from "@suzu-lives/suzu-agent-runtime/core/llm";

import { createSuzuAgentLifecycleBridgeTransport } from "./lifecycle-bridge.mjs";

export const name = "suzu-structured-generator";
export const inject = [];

const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_INPUT_CHARACTERS = 96_000;
const MAX_SYSTEM_PROMPT_CHARACTERS = 96_000;
const MAX_SCHEMA_CHARACTERS = 96_000;

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
    throw new Error("记忆结构化输出 Schema 无法序列化。 ");
  }
  if (!text || text.length > MAX_SCHEMA_CHARACTERS) {
    throw new Error(`记忆结构化输出 Schema 不能超过 ${MAX_SCHEMA_CHARACTERS} 个字符。`);
  }
  return { schema, text };
}

function schemaName(value) {
  const normalized = clean(value).replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 80);
  return normalized || "memory_analysis";
}

function targetForSession(ctx, rawSessionId) {
  const sessionId = clean(rawSessionId);
  const session = ctx?.sessions?.get?.(sessionId);
  if (!session) throw new Error("当前 Agent Core 会话不可用，无法执行记忆整理。 ");
  const config = plainObject(session?.requestHeader?.()).config;
  const provider = clean(config.provider);
  const model = clean(config.model);
  if (!provider || !model) throw new Error("当前 Agent Core 会话没有可用的模型路由。 ");
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
  if (!text) throw new Error("Agent Core 记忆整理没有返回 JSON 内容。 ");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Agent Core 记忆整理返回的不是有效 JSON：${clean(error?.message) || "解析失败"}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Agent Core 记忆整理返回的顶层必须是 JSON 对象。 ");
  }
  return parsed;
}

function streamFailure(finish) {
  const source = plainObject(finish);
  const kind = clean(source.kind);
  if (kind === "stop") return null;
  const failure = plainObject(source.failure);
  const error = new Error(clean(failure.message) || "Agent Core 记忆整理没有完成。 ");
  error.code = clean(failure.code) || (kind === "max-tokens" ? "MAX_TOKENS" : "AGENT_CORE_STRUCTURED_GENERATION_FAILED");
  return error;
}

function commandFailure(error) {
  return {
    ok: false,
    error: {
      code: clean(error?.code) || "AGENT_CORE_STRUCTURED_GENERATION_FAILED",
      message: clean(error?.message) || "Agent Core 记忆整理失败。",
    },
  };
}

async function runStructuredGeneration(ctx, payload, config = {}) {
  const source = plainObject(payload);
  const target = targetForSession(ctx, source.sessionId);
  const input = boundedText(source.input, "记忆整理输入", MAX_INPUT_CHARACTERS);
  const systemPrompt = boundedText(source.systemPrompt, "记忆整理系统提示词", MAX_SYSTEM_PROMPT_CHARACTERS, { required: false });
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
        content: [{ type: "text", text: input }],
        source: {
          kind: "plugin",
          plugin: name,
          form: "notice",
          summary: "Suzu memory structured generation",
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
      },
    };
  } catch (error) {
    return commandFailure(error);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Agent Core structured-generation bridge for product services such as Suzu
 * Memory. The parent supplies only a schema/prompt/input; this plugin resolves
 * the model from the live Agent Core session, so credential values never leave it.
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
          throw new Error("当前 Agent Core 会话不可用，无法执行记忆整理。 ");
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
