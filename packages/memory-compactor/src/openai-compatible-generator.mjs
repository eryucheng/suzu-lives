function clean(value) {
  return String(value ?? "").trim();
}
function httpEndpoint(baseUrl, type = "") {
  const raw = clean(baseUrl).replace(/\/+$/u, "");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("记忆处理 API 地址必须是 HTTP(S) URL。");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("记忆处理 API 地址必须是 HTTP(S) URL。");
  }
  if (clean(type).toLowerCase() === "dashscope"
    && parsed.hostname.endsWith("dashscope.aliyuncs.com")
    && /\/api\/v1$/u.test(parsed.pathname)) {
    parsed.pathname = "/compatible-mode/v1/chat/completions";
    return parsed.toString();
  }
  if (parsed.pathname.endsWith("/chat/completions")) return parsed.toString();
  parsed.pathname = parsed.pathname.endsWith("/v1")
    ? `${parsed.pathname}/chat/completions`
    : `${parsed.pathname}/v1/chat/completions`;
  return parsed.toString();
}

function jsonName(value) {
  const normalized = clean(value).replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64);
  return normalized || "memory_analysis";
}

function parseJsonContent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const text = clean(value)
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .replace(/^\uFEFF/u, "")
    .trim();
  if (!text) throw new Error("记忆处理 API 没有返回结构化内容。");
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("顶层必须是 JSON 对象");
    }
    return parsed;
  } catch (error) {
    throw new Error(`记忆处理 API 返回的不是有效 JSON：${error.message}`);
  }
}

function completionContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => clean(part?.text ?? part?.content)).filter(Boolean).join("\n");
  }
  return content;
}

function providerMessage(payload, status) {
  const message = clean(payload?.error?.message || payload?.message).slice(0, 500);
  return message ? `记忆处理 API 请求失败（${status}）：${message}` : `记忆处理 API 请求失败（${status}）。`;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

/**
 * Creates the same generator contract used by the memory compactor and state
 * specialists. Provider-side JSON mode improves reliability; every specialist
 * still parses and validates the returned object against its own fixed rules.
 */
export function createOpenAiCompatibleStructuredGenerator({
  connection = {},
  fetchImpl = globalThis.fetch,
  timeoutMs,
  maxOutputTokens = 8_192,
} = {}) {
  const apiKey = clean(connection.apiKey || connection.key);
  const model = clean(connection.model);
  const endpoint = httpEndpoint(connection.baseUrl, connection.type);
  if (!apiKey) throw new Error("记忆处理 API 缺少可用密钥。");
  if (!model) throw new Error("记忆处理 API 缺少文字模型名称。");
  if (typeof fetchImpl !== "function") throw new Error("记忆处理 API 缺少 HTTP 客户端。");
  const requestTimeoutMs = boundedInteger(
    timeoutMs ?? connection.timeoutMs,
    180_000,
    1_000,
    600_000,
  );
  const outputLimit = boundedInteger(maxOutputTokens, 8_192, 256, 64_000);

  return async function generate({
    input,
    systemPrompt,
    schema = {},
    schemaName = "memory-analysis-v1",
  } = {}) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const schemaText = JSON.stringify(schema);
    const payload = {
      model,
      messages: [
        {
          role: "system",
          content: `${clean(systemPrompt)}\n\n只输出一个 JSON 对象，不要输出 Markdown 或解释。输出必须符合这个 JSON Schema：\n${schemaText}`,
        },
        { role: "user", content: String(input ?? "") },
      ],
      temperature: 0,
      max_tokens: outputLimit,
      response_format: { type: "json_object" },
    };
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "suzu-lives-memory/1.0",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw new Error(`记忆处理 API 请求超过 ${requestTimeoutMs}ms。`);
      throw new Error(`无法连接记忆处理 API：${clean(error?.message) || "未知网络错误"}`);
    } finally {
      clearTimeout(timer);
    }

    let envelope = {};
    try {
      envelope = await response.json();
    } catch {
      throw new Error(`记忆处理 API 返回的不是有效响应 JSON（${response.status}）。`);
    }
    if (!response.ok) throw new Error(providerMessage(envelope, response.status));
    return {
      output: parseJsonContent(completionContent(envelope)),
      usage: envelope.usage || {},
      model: clean(envelope.model) || model,
      requestId: clean(envelope.id)
        || clean(response.headers?.get?.("x-request-id"))
        || clean(response.headers?.get?.("x-dashscope-request-id")),
      durationMs: Date.now() - started,
      metadata: {
        provider: clean(connection.name || connection.provider || connection.type) || "OpenAI Compatible",
        responseFormat: "json_object",
        schemaName: jsonName(schemaName),
      },
    };
  };
}
