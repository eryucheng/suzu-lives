import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendUsageEvent } from "@suzu-lives/cost-ledger";
import {
  buildSubjectAttributionSnapshot,
  proposeMemorySubjectAttribution,
} from "@suzu-lives/memory-core";

import {
  buildSubjectAttributionGenerationInput,
  MEMORY_SUBJECT_ATTRIBUTION_OUTPUT_SCHEMA,
  parseSubjectAttributionGeneration,
} from "./subject-attribution-prompt.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_PATH = path.join(
  PACKAGE_ROOT,
  "resources",
  "subject-attribution-system-prompt.md",
);

function clean(value) {
  return String(value ?? "").trim();
}

async function recordUsage({ generation, usageLedgerPath, agentId, memoryId, warnings }) {
  if (!clean(usageLedgerPath) || !generation?.model) return false;
  const usage = generation.usage && typeof generation.usage === "object" ? generation.usage : {};
  if (!Object.keys(usage).length) return false;
  try {
    await appendUsageEvent(path.resolve(usageLedgerPath), {
      agentId,
      provider: generation.metadata?.provider || "",
      model: generation.model,
      source: "memory-structurer",
      feature: "memory-subject-attribution",
      requestId: generation.requestId || "",
      usage,
      metadata: {
        memoryId,
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

export async function proposeSubjectAttributionForMemory({
  repository,
  agentId,
  memoryId,
  allowedActors,
  generator,
  usageLedgerPath = "",
  systemPromptPath = DEFAULT_PROMPT_PATH,
  snapshotOptions = {},
} = {}) {
  if (!repository) throw new Error("Subject attribution service requires a repository.");
  if (typeof generator !== "function") {
    throw new Error("Subject attribution service requires a generator function.");
  }
  const normalizedAgentId = clean(agentId);
  const normalizedMemoryId = clean(memoryId);
  const snapshot = buildSubjectAttributionSnapshot({
    repository,
    agentId: normalizedAgentId,
    memoryId: normalizedMemoryId,
    allowedActors,
    ...snapshotOptions,
  });
  const systemPrompt = fs.readFileSync(path.resolve(systemPromptPath), "utf8").trim();
  const generation = await generator({
    input: buildSubjectAttributionGenerationInput(snapshot),
    systemPrompt,
    schema: MEMORY_SUBJECT_ATTRIBUTION_OUTPUT_SCHEMA,
    schemaName: "memory-subject-attribution-v1",
  });
  const warnings = [];
  const usageRecorded = await recordUsage({
    generation,
    usageLedgerPath,
    agentId: normalizedAgentId,
    memoryId: normalizedMemoryId,
    warnings,
  });
  const candidate = parseSubjectAttributionGeneration(generation?.output);
  if (candidate.decision === "abstain") {
    return {
      status: "abstained",
      memoryId: normalizedMemoryId,
      proposal: null,
      rationale: candidate.rationale,
      usageRecorded,
      warnings,
    };
  }
  const proposal = proposeMemorySubjectAttribution(repository, {
    agentId: normalizedAgentId,
    memoryId: normalizedMemoryId,
    allowedActors: snapshot.allowedActors,
    candidate,
    snapshotOptions,
  });
  return {
    status: "proposed",
    memoryId: normalizedMemoryId,
    proposal,
    usageRecorded,
    warnings,
  };
}
