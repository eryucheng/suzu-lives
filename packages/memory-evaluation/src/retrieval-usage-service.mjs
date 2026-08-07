import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendUsageEvent } from "@suzu-lives/cost-ledger";

import {
  buildRetrievalUsageInput,
  parseRetrievalUsageGeneration,
  RETRIEVAL_USAGE_PROMPT_VERSION,
  RETRIEVAL_USAGE_SCHEMA,
  RETRIEVAL_USAGE_SCHEMA_NAME,
} from "./retrieval-usage-contracts.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_PATH = path.join(ROOT, "resources", "retrieval-usage-system-prompt.md");
export const RETRIEVAL_USAGE_PROCESSOR_VERSION = "retrieval-usage-processor-v1";

function clean(value) {
  return String(value ?? "").trim();
}

function usageIds(analyses, usage) {
  return analyses.filter((item) => item.usage === usage).map((item) => item.memoryId);
}

async function appendUsage({ usageLedgerPath, generation, agentId, requestId }) {
  if (!clean(usageLedgerPath) || !generation?.model || !generation?.usage) return "";
  try {
    await appendUsageEvent(path.resolve(usageLedgerPath), {
      agentId,
      provider: clean(generation.metadata?.provider),
      model: generation.model,
      source: "memory-evaluation",
      feature: "memory-retrieval-usage",
      requestId: clean(generation.requestId),
      usage: generation.usage,
      metadata: {
        retrievalUsageRequestId: requestId,
        durationMs: Math.max(0, Number(generation.durationMs || 0)),
        ...generation.metadata,
      },
    });
    return "";
  } catch (error) {
    return `费用流水写入失败：${error.message}`;
  }
}

function requestInput(repository, agentId, request) {
  const trace = repository.getRetrievalTrace(agentId, request.trace_id);
  if (!trace || trace.result_status !== "ready" || !trace.selectedIds.length) {
    return { blocked: "retrieval-usage-trace-is-no-longer-eligible" };
  }
  const memories = trace.selectedIds.map((memoryId) => repository.getMemory(memoryId));
  if (memories.some((memory) => !memory || memory.agent_id !== agentId)) {
    return { blocked: "retrieval-usage-memory-is-missing-or-cross-agent" };
  }
  const responseHash = createHash("sha256").update(clean(request.response_text)).digest("hex");
  if (responseHash !== request.response_hash) {
    return { blocked: "retrieval-usage-response-changed-after-capture" };
  }
  const input = buildRetrievalUsageInput({
    trace,
    memories,
    responseText: request.response_text,
  });
  if (input.length > 120_000) return { blocked: "retrieval-usage-input-exceeds-privacy-budget" };
  return { trace, memories, input };
}

export async function processRetrievalUsageRequest({
  repository,
  agentId,
  requestId,
  generator,
  usageLedgerPath = "",
  promptPath = DEFAULT_PROMPT_PATH,
} = {}) {
  if (!repository) throw new Error("Retrieval usage processing requires a repository.");
  const normalizedAgentId = clean(agentId);
  const normalizedRequestId = clean(requestId);
  if (!normalizedAgentId || !normalizedRequestId) {
    throw new Error("Retrieval usage processing requires agentId and requestId.");
  }
  const request = repository.getRetrievalUsageRequest(normalizedAgentId, normalizedRequestId);
  if (!request) throw new Error("Retrieval usage request was not found.");
  if (request.status !== "pending") {
    return { status: "already-resolved", request, run: null, feedback: null, warnings: [] };
  }
  if (typeof generator !== "function") {
    throw new Error("Retrieval usage processing requires a generator.");
  }
  const prepared = requestInput(repository, normalizedAgentId, request);
  if (prepared.blocked) {
    const resolved = repository.resolveRetrievalUsageRequest({
      agentId: normalizedAgentId,
      requestId: request.id,
      status: "blocked",
      errorMessage: prepared.blocked,
    });
    return { status: "blocked", reason: prepared.blocked, request: resolved, run: null, feedback: null, warnings: [] };
  }
  const systemPrompt = fs.readFileSync(path.resolve(promptPath), "utf8")
    .replace(/^\uFEFF/u, "")
    .trim();
  const inputHash = createHash("sha256").update(prepared.input).digest("hex");
  let generation = null;
  let parsed = null;
  let callStatus = "failed";
  let errorMessage = "";
  try {
    generation = await generator({
      input: prepared.input,
      systemPrompt,
      schema: RETRIEVAL_USAGE_SCHEMA,
      schemaName: RETRIEVAL_USAGE_SCHEMA_NAME,
      analyzerRole: "retrieval-usage",
    });
    parsed = parseRetrievalUsageGeneration(generation?.output, {
      expectedMemoryIds: prepared.trace.selectedIds,
    });
    callStatus = "completed";
  } catch (error) {
    callStatus = generation ? "rejected" : "failed";
    errorMessage = clean(error?.message) || "retrieval-usage-analysis-failed";
  }
  const warning = await appendUsage({
    usageLedgerPath,
    generation,
    agentId: normalizedAgentId,
    requestId: request.id,
  });
  if (callStatus !== "completed") {
    const run = repository.recordRetrievalUsageAnalysisRun({
      agentId: normalizedAgentId,
      requestId: request.id,
      traceId: request.trace_id,
      provider: clean(generation?.metadata?.provider) || "unreported",
      model: clean(generation?.model) || "unreported",
      promptVersion: RETRIEVAL_USAGE_PROMPT_VERSION,
      schemaVersion: RETRIEVAL_USAGE_SCHEMA_NAME,
      inputHash,
      status: callStatus,
      output: generation?.output ?? {},
      usage: generation?.usage || {},
      requestExternalId: clean(generation?.requestId),
      durationMs: generation?.durationMs,
      errorMessage,
      metadata: { processorVersion: RETRIEVAL_USAGE_PROCESSOR_VERSION },
    });
    return {
      status: "retryable-failure",
      reason: errorMessage,
      request: repository.getRetrievalUsageRequest(normalizedAgentId, request.id),
      run,
      feedback: null,
      warnings: warning ? [warning] : [],
    };
  }
  const completed = repository.transaction(() => {
    const run = repository.recordRetrievalUsageAnalysisRun({
      agentId: normalizedAgentId,
      requestId: request.id,
      traceId: request.trace_id,
      provider: clean(generation?.metadata?.provider) || "unreported",
      model: clean(generation?.model) || "unreported",
      promptVersion: RETRIEVAL_USAGE_PROMPT_VERSION,
      schemaVersion: RETRIEVAL_USAGE_SCHEMA_NAME,
      inputHash,
      status: "completed",
      output: parsed,
      usage: generation?.usage || {},
      requestExternalId: clean(generation?.requestId),
      durationMs: generation?.durationMs,
      metadata: { processorVersion: RETRIEVAL_USAGE_PROCESSOR_VERSION },
    });
    const usedMemoryIds = usageIds(parsed.analyses, "used");
    const feedback = usedMemoryIds.length ? repository.recordRetrievalFeedback({
      id: `retrieval-used-${request.id}`,
      agentId: normalizedAgentId,
      traceId: request.trace_id,
      signal: "used",
      targetMemoryIds: usedMemoryIds,
      metadata: {
        source: "response-grounded-usage-analysis",
        analysisRunId: run.id,
        processorVersion: RETRIEVAL_USAGE_PROCESSOR_VERSION,
      },
    }) : null;
    const result = {
      analysisRunId: run.id,
      feedbackId: feedback?.id || "",
      usedMemoryIds,
      notUsedMemoryIds: usageIds(parsed.analyses, "not_used"),
      uncertainMemoryIds: usageIds(parsed.analyses, "uncertain"),
    };
    const resolved = repository.resolveRetrievalUsageRequest({
      agentId: normalizedAgentId,
      requestId: request.id,
      status: "completed",
      result,
    });
    return { run, feedback, request: resolved };
  });
  return {
    status: "completed",
    reason: "",
    ...completed,
    warnings: warning ? [warning] : [],
  };
}

export async function processPendingRetrievalUsageRequests({
  repository,
  agentId,
  generator,
  maxRequests,
  usageLedgerPath = "",
} = {}) {
  if (!repository) throw new Error("Retrieval usage batch processing requires a repository.");
  const normalizedAgentId = clean(agentId);
  const maximum = Number(maxRequests);
  if (!normalizedAgentId || !Number.isInteger(maximum) || maximum < 1 || maximum > 500) {
    throw new Error("Retrieval usage batch requires agentId and maxRequests between 1 and 500.");
  }
  if (typeof generator !== "function") {
    throw new Error("Retrieval usage batch processing requires a generator.");
  }
  const requests = repository.listRetrievalUsageRequests(normalizedAgentId, {
    statuses: ["pending"],
    limit: maximum,
  });
  const results = [];
  for (const request of requests) {
    try {
      results.push(await processRetrievalUsageRequest({
        repository,
        agentId: normalizedAgentId,
        requestId: request.id,
        generator,
        usageLedgerPath,
      }));
    } catch (error) {
      results.push({
        status: "retryable-failure",
        reason: clean(error?.message) || "retrieval-usage-request-failed",
        request: repository.getRetrievalUsageRequest(normalizedAgentId, request.id),
        run: null,
        feedback: null,
        warnings: [],
      });
    }
  }
  const counts = Object.fromEntries([
    "completed", "retryable-failure", "blocked", "already-resolved",
  ].map((status) => [status, results.filter((item) => item.status === status).length]));
  return {
    status: results.length === 0
      ? "empty"
      : counts["retryable-failure"] + counts.blocked > 0 ? "partial-failure" : "completed",
    processorVersion: RETRIEVAL_USAGE_PROCESSOR_VERSION,
    agentId: normalizedAgentId,
    maxRequests: maximum,
    selected: requests.length,
    counts,
    results,
  };
}
