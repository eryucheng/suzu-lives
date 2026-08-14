import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendUsageEvent } from "@suzu-lives/cost-ledger";

import { buildPreferenceEvidenceSnapshot } from "./preference-snapshot.mjs";
import {
  buildPreferenceSpecialistGenerationInput,
  parsePreferenceSpecialistGeneration,
  PREFERENCE_SPECIALIST_ANALYZERS,
} from "./preference-specialist-contracts.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_DIRECTORY = path.join(PACKAGE_ROOT, "resources");

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
  return `preference-specialists-${createHash("sha256").update(signature).digest("hex").slice(0, 24)}`;
}

function targetHasRole(memory, target, allowedRoles, { allowPrimary = true } = {}) {
  if (allowPrimary
    && memory.subjectRole === target.subjectRole
    && memory.subjectKey === target.subjectKey) return true;
  return memory.actorRoles.some((role) => (
    allowedRoles.has(role.role)
    && role.actorRole === target.subjectRole
    && role.actorKey === target.subjectKey
  ));
}

function assertRoleBoundary(role, analysis, memory, target) {
  if (role === "explicit-expression") {
    if (analysis.directness === "explicit_self_statement"
      && !targetHasRole(memory, target, new Set(["speaker"]), { allowPrimary: false })) {
      throw new Error("An explicit self statement requires the fixed subject as speaker.");
    }
    if (analysis.directness === "explicit_reported_statement"
      && !targetHasRole(memory, target, new Set(["preference_holder", "subject"]))) {
      throw new Error("A reported expression does not identify the fixed subject as its holder.");
    }
    return;
  }
  if (role === "behavior-conditions") {
    if (!targetHasRole(memory, target, new Set(["subject", "experiencer"]))) {
      throw new Error("Behavior analysis does not identify the fixed subject as experiencer.");
    }
    return;
  }
  if (role === "sharing-affect") {
    if (!targetHasRole(memory, target, new Set(["speaker"]), { allowPrimary: false })) {
      throw new Error("Sharing analysis requires the fixed subject as speaker.");
    }
    return;
  }
  if (!targetHasRole(memory, target, new Set([
    "subject", "experiencer", "speaker", "observer", "participant",
    "belief_holder", "preference_holder",
  ]))) {
    throw new Error("Time and scope analysis does not identify the fixed subject.");
  }
}

function enforceSpecialistBoundary(role, analysis, snapshot) {
  const memory = snapshot.memories.find((item) => item.id === analysis.memoryId);
  if (!memory) throw new Error("Specialist analysis memory must come from the bounded snapshot.");
  const availableSourceIds = new Set(memory.sourceIds);
  if (analysis.sourceIds.some((sourceId) => !availableSourceIds.has(sourceId))) {
    throw new Error("Specialist analysis source must directly support its selected memory.");
  }
  assertRoleBoundary(role, analysis, memory, snapshot.target);
  return analysis;
}

async function appendSpecialistUsage({ usageLedgerPath, generation, role, agentId, batchId }) {
  if (!clean(usageLedgerPath) || !generation?.model || !generation?.usage) return "";
  try {
    await appendUsageEvent(path.resolve(usageLedgerPath), {
      agentId,
      provider: generation.metadata?.provider || "",
      model: generation.model,
      source: "memory-evaluation",
      feature: `memory-preference-${role}`,
      requestId: generation.requestId || "",
      usage: generation.usage,
      metadata: {
        batchId,
        durationMs: Number(generation.durationMs || 0),
        ...generation.metadata,
      },
    });
    return "";
  } catch (error) {
    return `费用流水写入失败：${error.message}`;
  }
}

async function invokeAnalyzer({ definition, generator, snapshot, promptDirectory, maximumAnalyses }) {
  const systemPrompt = fs.readFileSync(
    path.join(path.resolve(promptDirectory), definition.promptFile),
    "utf8",
  ).replace(/^\uFEFF/u, "").trim();
  const input = buildPreferenceSpecialistGenerationInput(snapshot, definition.role);
  let generation = null;
  try {
    generation = await generator({
      input,
      systemPrompt,
      schema: definition.schema,
      schemaName: definition.schemaName,
      analyzerRole: definition.role,
    });
    const parsed = parsePreferenceSpecialistGeneration(definition.role, generation?.output, {
      maximumAnalyses,
    });
    const accepted = [];
    const rejected = [];
    const seen = new Set();
    for (const [index, candidate] of parsed.analyses.entries()) {
      try {
        if (seen.has(candidate.memoryId)) {
          throw new Error("A specialist can analyze each memory at most once.");
        }
        const guarded = enforceSpecialistBoundary(definition.role, candidate, snapshot);
        seen.add(candidate.memoryId);
        accepted.push(guarded);
      } catch (error) {
        rejected.push({ index, memoryId: candidate.memoryId, error: error.message });
      }
    }
    return {
      definition,
      input,
      generation,
      analyses: accepted,
      rejected,
      status: accepted.length ? "completed" : rejected.length ? "rejected" : "abstained",
      error: "",
    };
  } catch (error) {
    return {
      definition,
      input,
      generation,
      analyses: [],
      rejected: [],
      status: "failed",
      error: error.message,
    };
  }
}

export async function evaluatePreferenceEvidenceSpecialists({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  objectLabel,
  memoryIds = [],
  analyzers = {},
  usageLedgerPath = "",
  promptDirectory = DEFAULT_PROMPT_DIRECTORY,
  snapshotOptions = {},
  maximumAnalyses = 60,
} = {}) {
  if (!repository) throw new Error("Preference specialist evaluation requires a repository.");
  if (!clean(objectLabel)) {
    throw new Error("Preference specialist evaluation requires a readable objectLabel.");
  }
  const definitions = Object.entries(PREFERENCE_SPECIALIST_ANALYZERS);
  for (const [key] of definitions) {
    if (typeof analyzers[key] !== "function") {
      throw new Error(`Preference specialist evaluation requires analyzers.${key}.`);
    }
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
  const baseSnapshot = buildPreferenceEvidenceSnapshot({
    repository,
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    memoryIds: normalizedMemoryIds,
    ...snapshotOptions,
  });
  const snapshot = {
    ...baseSnapshot,
    agentId: clean(agentId),
    target: { ...baseSnapshot.target, objectLabel: clean(objectLabel) },
  };
  if (!snapshot.memories.length) {
    return {
      status: "skipped",
      reason: "no-eligible-memories-with-direct-sources",
      batchId,
      snapshot,
      runs: {},
      analyses: {},
      rejected: {},
      warnings: [],
      automaticMemoryWriteAllowed: false,
    };
  }
  const invocations = await Promise.all(definitions.map(([key, definition]) => invokeAnalyzer({
    definition,
    generator: analyzers[key],
    snapshot,
    promptDirectory,
    maximumAnalyses,
  }).then((result) => [key, result])));
  const sourceIds = [...new Set(snapshot.memories.flatMap((memory) => memory.sourceIds))].sort();
  const runs = {};
  const analyses = {};
  const rejected = {};
  const warnings = [];
  for (const [key, invocation] of invocations) {
    const warning = await appendSpecialistUsage({
      usageLedgerPath,
      generation: invocation.generation,
      role: invocation.definition.role,
      agentId: clean(agentId),
      batchId,
    });
    if (warning) warnings.push(warning);
    runs[key] = repository.recordStateAnalysisRun({
      agentId: clean(agentId),
      batchId,
      stateFamily: "preference",
      analyzerRole: invocation.definition.role,
      subjectRole: snapshot.target.subjectRole,
      subjectKey: snapshot.target.subjectKey,
      canonicalKey: snapshot.target.canonicalKey,
      provider: clean(invocation.generation?.metadata?.provider) || "unreported",
      model: clean(invocation.generation?.model) || "unreported",
      promptVersion: invocation.definition.promptVersion,
      schemaVersion: invocation.definition.schemaName,
      inputHash: createHash("sha256").update(invocation.input).digest("hex"),
      status: invocation.status,
      memoryIds: snapshot.memories.map((memory) => memory.id),
      sourceIds,
      output: invocation.generation?.output ?? {},
      rejected: invocation.rejected,
      usage: invocation.generation?.usage || {},
      costAmount: Number(
        invocation.generation?.costAmount ?? invocation.generation?.metadata?.costAmount ?? 0,
      ) || 0,
      costCurrency: clean(
        invocation.generation?.costCurrency ?? invocation.generation?.metadata?.costCurrency,
      ),
      requestId: clean(invocation.generation?.requestId),
      durationMs: Math.max(0, Math.trunc(Number(invocation.generation?.durationMs) || 0)),
      errorMessage: invocation.error,
      metadata: {
        specialistKey: key,
        automaticMemoryWriteAllowed: false,
      },
    });
    analyses[key] = invocation.analyses;
    rejected[key] = invocation.rejected;
  }
  const failedRoles = definitions
    .map(([key]) => key)
    .filter((key) => ["failed", "rejected"].includes(runs[key].status));
  const hasAnyAnalysis = Object.values(analyses).some((items) => items.length);
  return {
    status: failedRoles.length ? "incomplete" : hasAnyAnalysis ? "analyzed" : "abstained",
    reason: failedRoles.length ? "required-specialist-failed-or-rejected" : "",
    batchId,
    snapshot,
    runs,
    analyses,
    rejected,
    failedRoles,
    warnings,
    automaticMemoryWriteAllowed: false,
  };
}
