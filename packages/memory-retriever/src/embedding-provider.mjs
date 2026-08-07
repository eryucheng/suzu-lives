function clean(value) {
  return String(value ?? "").trim();
}

function normalizeVector(input) {
  const vector = Float32Array.from(Array.isArray(input) ? input.map(Number) : []);
  if (!vector.length || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding API 返回了无效向量。");
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  }
  return vector;
}

export function createOpenAiCompatibleEmbeddingProvider({
  baseUrl,
  endpoint = "embeddings",
  apiKey = "",
  apiKeyEnv = "",
  model,
  dimensions = 0,
  timeoutMs = 30_000,
  extraHeaders = {},
  extraBody = {},
  fetchImplementation = globalThis.fetch,
} = {}) {
  if (!clean(baseUrl)) throw new Error("Embedding provider 需要 baseUrl。");
  if (!clean(model)) throw new Error("Embedding provider 需要 model。");
  if (typeof fetchImplementation !== "function") throw new Error("当前运行时没有 fetch。");
  async function requestEmbeddings(inputs) {
    const texts = (Array.isArray(inputs) ? inputs : [inputs]).map((text) => String(text || ""));
    if (!texts.length || texts.some((text) => !text.trim())) {
      throw new Error("Embedding provider 需要非空文本。");
    }
    const secret = clean(apiKey) || clean(process.env[clean(apiKeyEnv)]);
    if (!secret) throw new Error("Embedding API Key 未配置。");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs)));
    try {
      const response = await fetchImplementation(
        `${String(baseUrl).replace(/\/+$/u, "")}/${String(endpoint).replace(/^\/+/u, "")}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${secret}`,
            ...extraHeaders,
          },
          body: JSON.stringify({
            model,
            input: texts,
            ...(Number(dimensions) > 0 ? { dimensions: Number(dimensions) } : {}),
            ...extraBody,
          }),
          signal: controller.signal,
        },
      );
      const raw = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`Embedding API 返回非 JSON（HTTP ${response.status}）。`);
      }
      if (!response.ok) {
        throw new Error(`Embedding API 请求失败（HTTP ${response.status}）：${parsed?.error?.message || raw}`);
      }
      const data = Array.isArray(parsed?.data) ? [...parsed.data] : [];
      data.sort((left, right) => Number(left?.index || 0) - Number(right?.index || 0));
      if (data.length !== texts.length) {
        throw new Error(`Embedding API 应返回 ${texts.length} 个向量，实际返回 ${data.length} 个。`);
      }
      return {
        vectors: data.map((item) => normalizeVector(item?.embedding)),
        model: parsed.model || model,
        usage: parsed.usage || {},
        requestId: response.headers.get("x-request-id") || parsed.request_id || "",
        metadata: { provider: "openai-compatible" },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  const embed = async function embed(text) {
    const response = await requestEmbeddings([text]);
    return {
      ...response,
      vector: response.vectors[0],
    };
  };
  embed.embedMany = requestEmbeddings;
  embed.model = clean(model);
  embed.dimensions = Math.max(0, Math.trunc(Number(dimensions) || 0));
  return embed;
}
