import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const INDEX_SCHEMA = 2;
const VECTOR_ENCODING = "float32-base64-le";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function apiKeyFor(config) {
  const envName = String(config.apiKeyEnv || "").trim();
  return (envName ? process.env[envName] : "") || String(config.apiKey || "").trim();
}

function endpointFor(config) {
  const baseUrl = String(config.baseUrl || "").trim().replace(/\/+$/, "");
  const endpoint = String(config.endpoint || "embeddings").trim().replace(/^\/+/, "");
  if (!baseUrl || /YOUR_|\{[^}]+\}/i.test(baseUrl)) {
    throw new Error("embedding.baseUrl 还没有填写真实地址");
  }
  return `${baseUrl}/${endpoint}`;
}

export function embeddingSignature(config) {
  return sha256(JSON.stringify({
    baseUrl: String(config.baseUrl || "").replace(/\/+$/, ""),
    endpoint: String(config.endpoint || "embeddings").replace(/^\/+/, ""),
    model: config.model,
    dimensions: Number(config.dimensions || 0),
    documentPrefix: String(config.documentPrefix || ""),
    queryPrefix: String(config.queryPrefix || ""),
    extraBody: config.extraBody || {},
  }));
}

function normalizeVector(values) {
  if (!Array.isArray(values) || !values.length) throw new Error("embedding API 返回了空向量");
  let norm = 0;
  const vector = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const number = Number(values[index]);
    if (!Number.isFinite(number)) throw new Error(`embedding 向量第 ${index + 1} 维不是有效数字`);
    vector[index] = number;
    norm += number * number;
  }
  norm = Math.sqrt(norm);
  if (!norm) throw new Error("embedding API 返回了零向量");
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  return vector;
}

function encodeVector(vector) {
  const bytes = Buffer.allocUnsafe(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) bytes.writeFloatLE(vector[index], index * 4);
  return bytes.toString("base64");
}

function decodeVector(value, dimensions) {
  const bytes = Buffer.from(String(value || ""), "base64");
  if (bytes.length !== dimensions * 4) throw new Error("向量索引中的维度与数据长度不一致");
  const vector = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) vector[index] = bytes.readFloatLE(index * 4);
  return vector;
}

function dot(left, right) {
  if (left.length !== right.length) return Number.NEGATIVE_INFINITY;
  let value = 0;
  for (let index = 0; index < left.length; index += 1) value += left[index] * right[index];
  return value;
}

async function requestBatch(config, inputs) {
  const apiKey = apiKeyFor(config);
  if (!apiKey) {
    const name = config.apiKeyEnv || "embedding.apiKey";
    throw new Error(`没有找到 embedding API Key，请设置环境变量 ${name} 或填写 embedding.apiKey`);
  }

  const body = {
    ...(config.extraBody || {}),
    model: String(config.model || ""),
    input: inputs,
  };
  if (!body.model) throw new Error("embedding.model 不能为空");
  if (Number(config.dimensions) > 0) body.dimensions = Number(config.dimensions);

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...(config.extraHeaders || {}),
  };
  const retries = Math.max(0, Number(config.maxRetries || 0));
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, Number(config.timeoutMs || 30_000)));
    try {
      const response = await fetch(endpointFor(config), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const responseText = await response.text();
      if (!response.ok) {
        const error = new Error(`embedding API 返回 HTTP ${response.status}：${responseText.slice(0, 800)}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      let parsed;
      try {
        parsed = JSON.parse(responseText);
      } catch (error) {
        throw new Error(`embedding API 没有返回有效 JSON：${error.message}`);
      }
      const data = Array.isArray(parsed.data) ? [...parsed.data] : [];
      data.sort((left, right) => Number(left.index || 0) - Number(right.index || 0));
      if (data.length !== inputs.length) {
        throw new Error(`embedding API 应返回 ${inputs.length} 个向量，实际返回 ${data.length} 个`);
      }
      return {
        vectors: data.map((item) => normalizeVector(item.embedding)),
        usage: parsed.usage || null,
      };
    } catch (error) {
      lastError = error;
      const retryable = error.name === "AbortError" || error.retryable;
      if (!retryable || attempt >= retries) break;
      await sleep(Math.min(4_000, 500 * (2 ** attempt)));
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastError?.name === "AbortError") throw new Error("embedding API 请求超时");
  throw lastError;
}

function turnId(turn) {
  const source = turn.messages.map((message) => (
    message.id || `${message.timestamp || ""}:${message.role}:${message.text}`
  )).join("\n");
  return sha256(source);
}

function messageLines(turn) {
  return turn.messages.map((message) => {
    const speaker = String(message.speaker || (message.role === "assistant" ? "我" : "对方"));
    return `${speaker}：${String(message.text || "").trim()}`;
  }).filter((line) => line.trim());
}

function splitLongText(value, maxChars, overlapChars) {
  const text = String(value || "");
  if (text.length <= maxChars) return [text];
  const result = [];
  const overlap = Math.min(Math.max(0, overlapChars), Math.floor(maxChars / 3));
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + maxChars);
    result.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return result;
}

export function buildEmbeddingChunks(turns, config) {
  const maxChars = Math.max(200, Number(config.maxInputChars || 6_000));
  const overlapChars = Math.max(0, Number(config.chunkOverlapChars || 200));
  const prefix = String(config.documentPrefix || "");
  const chunks = [];

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex];
    const id = turnId(turn);
    const units = messageLines(turn).flatMap((line) => splitLongText(line, maxChars, overlapChars));
    let current = "";
    let chunkIndex = 0;
    const flush = () => {
      const body = current.trim();
      if (!body) return;
      const text = `${prefix}${body}`;
      const textHash = sha256(text);
      chunks.push({
        chunkId: sha256(`${id}:${chunkIndex}:${textHash}`),
        turnId: id,
        turnIndex,
        chunkIndex,
        text,
        textHash,
      });
      chunkIndex += 1;
      current = "";
    };

    for (const unit of units) {
      if (current && current.length + 1 + unit.length > maxChars) flush();
      current = current ? `${current}\n${unit}` : unit;
    }
    flush();
  }
  return chunks;
}

export function readEmbeddingIndex(indexPath) {
  if (!fs.existsSync(indexPath)) return { meta: null, records: [] };
  const lines = fs.readFileSync(indexPath, "utf8").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return { meta: null, records: [] };
  const parsed = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`向量索引第 ${index + 1} 行损坏：${error.message}`);
    }
  });
  const meta = parsed[0]?.type === "meta" ? parsed[0] : null;
  const records = parsed.filter((item) => item?.type === "chunk");
  return { meta, records };
}

function writeEmbeddingIndex(indexPath, meta, records) {
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  const payload = `${[meta, ...records].map((item) => JSON.stringify(item)).join("\n")}\n`;
  const temporary = `${indexPath}.tmp`;
  fs.writeFileSync(temporary, payload, "utf8");
  fs.renameSync(temporary, indexPath);
}

export async function syncEmbeddingIndex(config, turns, { force = false, onProgress = null } = {}) {
  if (!config.enabled) return { status: "disabled", added: 0, reused: 0, total: 0 };
  const signature = embeddingSignature(config);
  const existing = readEmbeddingIndex(config.indexPath);
  const compatible = !force
    && existing.meta?.schema === INDEX_SCHEMA
    && existing.meta?.signature === signature
    && existing.meta?.encoding === VECTOR_ENCODING;
  const known = compatible
    ? new Map(existing.records.map((record) => [record.chunkId, record]))
    : new Map();
  const chunks = buildEmbeddingChunks(turns, config);
  const records = [];
  const missing = [];
  for (const chunk of chunks) {
    const record = known.get(chunk.chunkId);
    if (record?.textHash === chunk.textHash) records.push(record);
    else missing.push(chunk);
  }

  const batchSize = Math.max(1, Math.min(100, Number(config.batchSize || 10)));
  let dimensions = compatible ? Number(existing.meta.dimensions || 0) : 0;
  for (let offset = 0; offset < missing.length; offset += batchSize) {
    const batch = missing.slice(offset, offset + batchSize);
    const result = await requestBatch(config, batch.map((chunk) => chunk.text));
    for (let index = 0; index < batch.length; index += 1) {
      const vector = result.vectors[index];
      if (!dimensions) dimensions = vector.length;
      if (vector.length !== dimensions) {
        throw new Error(`embedding 返回维度发生变化：预期 ${dimensions}，实际 ${vector.length}`);
      }
      const chunk = batch[index];
      records.push({
        type: "chunk",
        chunkId: chunk.chunkId,
        turnId: chunk.turnId,
        chunkIndex: chunk.chunkIndex,
        textHash: chunk.textHash,
        vector: encodeVector(vector),
      });
    }
    if (onProgress) onProgress({ completed: Math.min(missing.length, offset + batch.length), total: missing.length });
  }

  records.sort((left, right) => left.turnId.localeCompare(right.turnId)
    || left.chunkIndex - right.chunkIndex);
  const now = new Date().toISOString();
  const meta = {
    type: "meta",
    schema: INDEX_SCHEMA,
    encoding: VECTOR_ENCODING,
    signature,
    model: config.model,
    dimensions,
    chunks: records.length,
    createdAt: compatible ? existing.meta.createdAt : now,
    updatedAt: now,
  };
  writeEmbeddingIndex(config.indexPath, meta, records);
  return {
    status: "ready",
    added: missing.length,
    reused: records.length - missing.length,
    total: records.length,
    dimensions,
    indexPath: config.indexPath,
  };
}

export async function scoreTurnsByVector(query, config, turns) {
  if (!config.enabled) return { status: "disabled", scored: [] };
  const index = readEmbeddingIndex(config.indexPath);
  if (!index.meta || !index.records.length) {
    return { status: "missing-index", scored: [], warning: "尚未生成向量索引" };
  }
  if (
    index.meta.schema !== INDEX_SCHEMA
    || index.meta.signature !== embeddingSignature(config)
    || index.meta.encoding !== VECTOR_ENCODING
  ) {
    return { status: "stale-index", scored: [], warning: "向量配置已变化，需要重建索引" };
  }

  const queryText = `${String(config.queryPrefix || "")}${String(query || "").trim()}`;
  const response = await requestBatch(config, [queryText]);
  const queryVector = response.vectors[0];
  const dimensions = Number(index.meta.dimensions || 0);
  if (queryVector.length !== dimensions) {
    return { status: "stale-index", scored: [], warning: "查询向量维度与索引不一致，需要重建索引" };
  }

  const turnMap = new Map(turns.map((turn, indexValue) => [turnId(turn), indexValue]));
  const byTurn = new Map();
  for (const record of index.records) {
    const turnIndex = turnMap.get(record.turnId);
    if (turnIndex === undefined) continue;
    const similarity = dot(queryVector, decodeVector(record.vector, dimensions));
    const previous = byTurn.get(turnIndex);
    if (previous === undefined || similarity > previous) byTurn.set(turnIndex, similarity);
  }
  const scored = [...byTurn].map(([indexValue, similarity]) => ({ index: indexValue, similarity }));
  scored.sort((left, right) => right.similarity - left.similarity
    || (turns[right.index].endMs || 0) - (turns[left.index].endMs || 0));
  const indexedTurns = new Set(index.records.map((record) => record.turnId));
  const missingTurns = [...turnMap.keys()].filter((id) => !indexedTurns.has(id)).length;
  return {
    status: "ready",
    scored,
    indexedChunks: index.records.length,
    missingTurns,
    dimensions,
    model: index.meta.model,
  };
}
