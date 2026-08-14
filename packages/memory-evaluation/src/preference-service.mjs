import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendUsageEvent } from "@suzu-lives/cost-ledger";

import { enforcePreferenceEvidencePolicy } from "./preference-evidence-policy.mjs";
import {
  buildPreferenceEvidenceGenerationInput,
  MEMORY_PREFERENCE_EVIDENCE_OUTPUT_SCHEMA,
  parsePreferenceEvidenceGeneration,
} from "./preference-prompt.mjs";
import { buildPreferenceEvidenceSnapshot } from "./preference-snapshot.mjs";
import { simulatePreferenceFormation } from "./preference-simulator.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_PATH = path.join(
  PACKAGE_ROOT,
  "resources",
  "preference-labeling-system-prompt.md",
);

function clean(value) {
  return String(value ?? "").trim();
}

function stableBatchId({ agentId, subjectRole, subjectKey, canonicalKey, memoryIds }) {
  const signature = [
    clean(agentId),
    clean(subjectRole),
    clean(subjectKey),
    clean(canonicalKey).toLocaleLowerCase("en-US"),
    [...new Set(memoryIds.map(clean).filter(Boolean))].sort().join("\u001f"),
  ].join("\u001e");
  return `preference-evidence-${createHash("sha256").update(signature).digest("hex").slice(0, 24)}`;
}

function claimedDirection(signal) {
  if ([
    "explicit_preference", "active_choice", "repeated_behavior",
    "active_sharing", "voluntary_acceptance",
  ].includes(clean(signal))) return "support";
  if (["explicit_rejection", "counter_behavior"].includes(clean(signal))) return "opposition";
  return "neutral";
}

function recordPreferenceEvidenceLedger({
  repository,
  generation,
  generationInput,
  batchId,
  snapshot,
  labels,
  rejected,
  preview,
}) {
  const sourceIds = [...new Set(snapshot.memories.flatMap((memory) => memory.sourceIds))].sort();
  const status = labels.length ? "completed" : rejected.length ? "rejected" : "abstained";
  return repository.transaction(() => {
    const analysisRun = repository.recordStateAnalysisRun({
      agentId: snapshot.agentId || snapshot.target.agentId || snapshot.target.subjectKey,
      batchId,
      stateFamily: "preference",
      analyzerRole: "preference-evidence-monolith",
      subjectRole: snapshot.target.subjectRole,
      subjectKey: snapshot.target.subjectKey,
      canonicalKey: snapshot.target.canonicalKey,
      provider: clean(generation?.metadata?.provider) || "unreported",
      model: clean(generation?.model) || "unreported",
      promptVersion: "preference-evidence-monolith-v1",
      schemaVersion: "memory-preference-evidence-v1",
      inputHash: createHash("sha256").update(generationInput).digest("hex"),
      status,
      memoryIds: snapshot.memories.map((memory) => memory.id),
      sourceIds,
      output: generation?.output ?? {},
      rejected,
      usage: generation?.usage || {},
      costAmount: Number(generation?.costAmount ?? generation?.metadata?.costAmount ?? 0) || 0,
      costCurrency: clean(generation?.costCurrency ?? generation?.metadata?.costCurrency),
      requestId: clean(generation?.requestId),
      durationMs: Math.max(0, Math.trunc(Number(generation?.durationMs) || 0)),
      metadata: {
        transitionalAnalyzer: true,
        automaticMemoryWriteAllowed: false,
      },
    });
    const evaluatedByMemory = new Map(
      (preview.evidence || []).map((item) => [item.memoryId, item]),
    );
    const observations = labels.map((label) => {
      const evaluated = evaluatedByMemory.get(label.memoryId) || {};
      const rawDirection = claimedDirection(label.signal);
      const excludedReason = clean(evaluated.ignoredReason)
        || (rawDirection === "neutral" ? "non-qualifying-preference-signal" : "");
      const qualification = excludedReason ? "excluded" : "qualified";
      return repository.recordStateEvidenceObservation({
        agentId: analysisRun.agent_id,
        batchId,
        stateFamily: "preference",
        subjectRole: snapshot.target.subjectRole,
        subjectKey: snapshot.target.subjectKey,
        canonicalKey: snapshot.target.canonicalKey,
        memoryId: label.memoryId,
        evidenceGroupId: label.evidenceGroupId,
        contextId: label.contextId,
        signal: label.signal,
        claimedDirection: rawDirection,
        effectiveDirection: qualification === "qualified" ? rawDirection : "neutral",
        qualification,
        confidence: label.confidence,
        origin: "llm",
        payloadSchemaVersion: "preference-merged-evidence-v1",
        payload: {
          ...label,
          ignoredReason: excludedReason,
          policyVersion: preview.policyVersion,
        },
        excludedReason,
        sourceIds: label.sourceIds,
        analysisRunIds: [analysisRun.id],
        observedAt: label.eventTime || label.knownAt,
      });
    });
    return { analysisRun, observations };
  });
}

async function recordUsage({ generation, usageLedgerPath, agentId, batchId, warnings }) {
  if (!clean(usageLedgerPath) || !generation?.model) return false;
  const usage = generation.usage && typeof generation.usage === "object" ? generation.usage : {};
  if (!Object.keys(usage).length) return false;
  try {
    await appendUsageEvent(path.resolve(usageLedgerPath), {
      agentId,
      provider: generation.metadata?.provider || "",
      model: generation.model,
      source: "memory-evaluation",
      feature: "memory-preference-evidence",
      requestId: generation.requestId || "",
      usage,
      metadata: {
        batchId,
        durationMs: Number(generation.durationMs || 0),
        ...generation.metadata,
      },
    });
    return true;
  } catch (error) {
    warnings.push(`费用流水写入失败：${error.message}`);
    return false;
  }
}

export async function evaluatePreferenceEvidenceTarget({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  memoryIds = [],
  policy,
  generator,
  usageLedgerPath = "",
  systemPromptPath = DEFAULT_PROMPT_PATH,
  snapshotOptions = {},
  maximumEvidence = 60,
  recordEvidenceLedger = true,
} = {}) {
  if (!repository) throw new Error("Preference evidence evaluation requires a repository.");
  if (typeof generator !== "function") {
    throw new Error("Preference evidence evaluation requires a generator function.");
  }
  const normalizedMemoryIds = [...new Set(
    (Array.isArray(memoryIds) ? memoryIds : []).map(clean).filter(Boolean),
  )];
  const batchId = stableBatchId({
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    memoryIds: normalizedMemoryIds,
  });
  const snapshot = buildPreferenceEvidenceSnapshot({
    repository,
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    memoryIds: normalizedMemoryIds,
    ...snapshotOptions,
  });
  if (!snapshot.memories.length) {
    return {
      status: "skipped",
      reason: "no-eligible-memories-with-direct-sources",
      batchId,
      snapshot,
      labels: [],
      rejected: [],
      preview: null,
      usageRecorded: false,
      warnings: [],
    };
  }
  const systemPrompt = fs.readFileSync(path.resolve(systemPromptPath), "utf8")
    .replace(/^\uFEFF/u, "")
    .trim();
  const generationInput = buildPreferenceEvidenceGenerationInput(snapshot);
  const generation = await generator({
    input: generationInput,
    systemPrompt,
    schema: MEMORY_PREFERENCE_EVIDENCE_OUTPUT_SCHEMA,
    schemaName: "memory-preference-evidence-v1",
  });
  const warnings = [];
  const usageRecorded = await recordUsage({
    generation,
    usageLedgerPath,
    agentId: clean(agentId),
    batchId,
    warnings,
  });
  const parsed = parsePreferenceEvidenceGeneration(generation?.output, { maximumEvidence });
  const labels = [];
  const rejected = [];
  const seenMemoryIds = new Set();
  for (const [index, candidate] of parsed.evidence.entries()) {
    try {
      if (seenMemoryIds.has(candidate.memoryId)) {
        throw new Error("A snapshot memory can contribute at most one preference evidence label.");
      }
      const guarded = enforcePreferenceEvidencePolicy(candidate, snapshot);
      seenMemoryIds.add(candidate.memoryId);
      labels.push(guarded);
    } catch (error) {
      rejected.push({ index, memoryId: candidate.memoryId, error: error.message });
    }
  }
  const preview = simulatePreferenceFormation({
    subjectRole: snapshot.target.subjectRole,
    subjectKey: snapshot.target.subjectKey,
    canonicalKey: snapshot.target.canonicalKey,
    evidence: labels,
    policy,
  });
  const evidenceLedger = recordEvidenceLedger
    ? recordPreferenceEvidenceLedger({
      repository,
      generation,
      generationInput,
      batchId,
      snapshot: { ...snapshot, agentId: clean(agentId) },
      labels,
      rejected,
      preview,
    })
    : null;
  return {
    status: labels.length ? "evaluated" : parsed.evidence.length ? "all-labels-rejected" : "abstained",
    batchId,
    snapshot,
    labels,
    rejected,
    preview,
    usageRecorded,
    warnings,
    evidenceLedger,
    automaticMemoryWriteAllowed: false,
  };
}
