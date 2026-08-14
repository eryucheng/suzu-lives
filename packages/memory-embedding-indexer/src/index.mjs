import crypto from "node:crypto";

import { appendUsageEvent } from "@suzu-lives/cost-ledger";

const DEFAULT_EXCLUDED_KINDS = Object.freeze(["utterance", "topic_or_episode"]);
const DEFAULT_BATCH_SIZE = 10;

function clean(value) {
  return String(value ?? "").trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeVector(input) {
  const values = input instanceof Float32Array
    ? input
    : Float32Array.from(Array.isArray(input) ? input.map(Number) : []);
  if (!values.length || values.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding provider 返回了无效向量。");
  }
  let norm = 0;
  for (const value of values) norm += value * value;
  norm = Math.sqrt(norm);
  if (!norm) throw new Error("Embedding provider 返回了零向量。");
  const normalized = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    normalized[index] = values[index] / norm;
  }
  return normalized;
}

function displayValue(value) {
  const result = clean(value);
  return result && result !== "unknown" && result !== "unspecified" && result !== "not_applicable"
    ? result
    : "";
}

export function buildMemoryEmbeddingDocument(memory = {}) {
  const lines = [
    ["记忆类型", displayValue(memory.kind)],
    ["标题", displayValue(memory.title)],
    ["内容", displayValue(memory.content)],
    ["主体角色", displayValue(memory.subject_role)],
    ["主体标识", displayValue(memory.subject_key)],
    ["稳定语义键", displayValue(memory.canonical_key)],
    ["状态类别", displayValue(memory.state_family)],
    ["状态阶段", displayValue(memory.state_phase)],
    ["表示层", displayValue(memory.representation_layer)],
    ["时间状态", displayValue(memory.temporal_state)],
    ["发生日期", displayValue(memory.event_date)],
    ["发生时间", displayValue(memory.event_start)],
    ["有效开始", displayValue(memory.valid_from)],
    ["有效结束", displayValue(memory.valid_to)],
    ["现实属性", displayValue(memory.reality)],
  ].filter(([, value]) => value);
  if (!lines.some(([label]) => label === "内容")) {
    throw new Error(`记忆 ${clean(memory.id) || "<unknown>"} 没有可索引正文。`);
  }
  return lines.map(([label, value]) => `${label}：${value}`).join("\n");
}

export function memoryEmbeddingContentHash(memory) {
  return sha256(buildMemoryEmbeddingDocument(memory));
}

function listActiveMemories(repository, agentId) {
  const result = [];
  let offset = 0;
  while (true) {
    const page = repository.listMemories(agentId, {
      statuses: ["active"],
      limit: 200,
      offset,
    });
    result.push(...page.items);
    offset += page.items.length;
    if (!page.items.length || result.length >= page.total) break;
  }
  return result;
}

function isRetryable(error) {
  if (error?.retryable || error?.name === "AbortError") return true;
  return /HTTP\s+(?:429|5\d\d)\b/u.test(String(error?.message || ""));
}

async function requestVectors(provider, texts) {
  if (typeof provider?.embedMany === "function") {
    const response = await provider.embedMany(texts);
    return {
      vectors: response.vectors,
      model: response.model,
      requests: [{
        usage: response.usage || {},
        requestId: response.requestId || "",
        metadata: response.metadata || {},
      }],
    };
  }
  const response = await provider(texts[0]);
  return {
    vectors: [response.vector],
    model: response.model,
    requests: [{
      usage: response.usage || {},
      requestId: response.requestId || "",
      metadata: response.metadata || {},
    }],
  };
}

async function requestVectorsWithRetry(provider, texts, maxRetries, retryDelayMs) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await requestVectors(provider, texts);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt >= maxRetries) break;
      await sleep(Math.min(4_000, retryDelayMs * (2 ** attempt)));
    }
  }
  throw lastError;
}

async function recordUsage({
  ledgerPath,
  requests,
  agentId,
  model,
  batchSize,
  dimensions,
}) {
  if (!clean(ledgerPath)) return [];
  const errors = [];
  for (const request of requests) {
    if (!request.usage || !Object.keys(request.usage).length) continue;
    try {
      await appendUsageEvent(ledgerPath, {
        agentId,
        provider: request.metadata?.provider || "",
        model,
        source: "memory-embedding-indexer",
        feature: "memory-index-embedding",
        requestId: request.requestId,
        usage: request.usage,
        metadata: {
          ...request.metadata,
          batchSize,
          dimensions,
        },
      });
    } catch (error) {
      errors.push(error.message);
    }
  }
  return errors;
}

export async function syncMemoryEmbeddings({
  repository,
  agentId,
  embeddingProvider,
  model = embeddingProvider?.model,
  dimensions = embeddingProvider?.dimensions || 0,
  ledgerPath = "",
  batchSize = DEFAULT_BATCH_SIZE,
  maxRetries = 2,
  retryDelayMs = 500,
  excludedKinds = DEFAULT_EXCLUDED_KINDS,
  memoryIds = [],
  limit = Number.POSITIVE_INFINITY,
  force = false,
  dryRun = false,
  continueOnError = true,
  onProgress = null,
} = {}) {
  if (!repository?.listMemories || !repository?.upsertEmbedding) {
    throw new Error("syncMemoryEmbeddings 需要 MemoryRepository。");
  }
  const normalizedAgentId = clean(agentId);
  const normalizedModel = clean(model);
  if (!normalizedAgentId) throw new Error("syncMemoryEmbeddings 需要 agentId。");
  if (typeof embeddingProvider !== "function") throw new Error("syncMemoryEmbeddings 需要 embeddingProvider。");
  if (!normalizedModel) throw new Error("syncMemoryEmbeddings 需要明确的 model。");

  const excluded = new Set((Array.isArray(excludedKinds) ? excludedKinds : []).map(clean));
  const selectedIds = new Set((Array.isArray(memoryIds) ? memoryIds : []).map(clean).filter(Boolean));
  const all = listActiveMemories(repository, normalizedAgentId);
  const longTerm = all.filter((memory) => !excluded.has(memory.kind));
  const eligible = longTerm
    .filter((memory) => !selectedIds.size || selectedIds.has(memory.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const existing = new Map(
    repository.listEmbeddings(normalizedAgentId, normalizedModel, { includeArchived: false })
      .map((embedding) => [embedding.memory_id, embedding]),
  );
  const prepared = eligible.map((memory) => {
    const text = buildMemoryEmbeddingDocument(memory);
    return {
      memory,
      text,
      contentHash: sha256(text),
      current: existing.get(memory.id) || null,
    };
  });
  const reusable = prepared.filter((item) => !force && item.current?.content_hash === item.contentHash);
  const allPending = prepared.filter((item) => force || item.current?.content_hash !== item.contentHash);
  const pending = allPending.slice(
    0,
    Math.max(0, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : prepared.length),
  );
  const report = {
    status: dryRun ? "planned" : "ready",
    agentId: normalizedAgentId,
    model: normalizedModel,
    dimensions: Math.max(0, Math.trunc(Number(dimensions) || 0)),
    totalActive: all.length,
    totalEligible: eligible.length,
    excludedByKind: all.length - longTerm.length,
    notSelected: selectedIds.size ? longTerm.length - eligible.length : 0,
    reused: reusable.length,
    pending: pending.length,
    deferred: allPending.length - pending.length,
    added: 0,
    failed: 0,
    failures: [],
    usageLoggingErrors: [],
  };
  if (dryRun || !pending.length) return report;

  const effectiveBatchSize = typeof embeddingProvider.embedMany === "function"
    ? Math.max(1, Math.min(10, Math.trunc(Number(batchSize) || DEFAULT_BATCH_SIZE)))
    : 1;
  let expectedDimensions = report.dimensions;
  for (let offset = 0; offset < pending.length; offset += effectiveBatchSize) {
    const batch = pending.slice(offset, offset + effectiveBatchSize);
    try {
      const response = await requestVectorsWithRetry(
        embeddingProvider,
        batch.map((item) => item.text),
        Math.max(0, Math.trunc(Number(maxRetries) || 0)),
        Math.max(1, Math.trunc(Number(retryDelayMs) || 500)),
      );
      if (clean(response.model) && clean(response.model) !== normalizedModel) {
        throw new Error(`Embedding 模型发生变化：预期 ${normalizedModel}，实际 ${response.model}。`);
      }
      if (!Array.isArray(response.vectors) || response.vectors.length !== batch.length) {
        throw new Error(`Embedding provider 应返回 ${batch.length} 个向量。`);
      }
      const vectors = response.vectors.map(normalizeVector);
      for (const vector of vectors) {
        if (!expectedDimensions) expectedDimensions = vector.length;
        if (vector.length !== expectedDimensions) {
          throw new Error(`Embedding 维度发生变化：预期 ${expectedDimensions}，实际 ${vector.length}。`);
        }
      }
      repository.transaction(() => {
        for (let index = 0; index < batch.length; index += 1) {
          repository.upsertEmbedding({
            memoryId: batch[index].memory.id,
            model: normalizedModel,
            vector: vectors[index],
            contentHash: batch[index].contentHash,
          });
        }
      });
      report.added += batch.length;
      report.usageLoggingErrors.push(...await recordUsage({
        ledgerPath,
        requests: response.requests,
        agentId: normalizedAgentId,
        model: normalizedModel,
        batchSize: batch.length,
        dimensions: expectedDimensions,
      }));
    } catch (error) {
      report.failed += batch.length;
      report.failures.push({
        memoryIds: batch.map((item) => item.memory.id),
        error: error.message,
      });
      if (!continueOnError) throw error;
    }
    report.dimensions = expectedDimensions;
    if (typeof onProgress === "function") {
      onProgress({
        completed: Math.min(pending.length, offset + batch.length),
        total: pending.length,
        added: report.added,
        failed: report.failed,
      });
    }
  }
  report.status = report.failed ? (report.added ? "partial" : "error") : "ready";
  return report;
}

export {
  DEFAULT_BATCH_SIZE,
  DEFAULT_EXCLUDED_KINDS,
};
