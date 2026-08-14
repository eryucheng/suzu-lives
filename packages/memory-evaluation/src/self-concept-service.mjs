import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendUsageEvent } from "@suzu-lives/cost-ledger";
import { SELF_CONCEPT_ANALYZERS, buildSelfConceptGenerationInput,
  parseSelfConceptGeneration } from "./self-concept-contracts.mjs";
import { buildPreferenceEvidenceSnapshot } from "./preference-snapshot.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_DIRECTORY = path.join(PACKAGE_ROOT, "resources");
const SELF_CONCEPT_MEMORY_KINDS = new Set(["belief_state", "reflection"]);
function clean(value) { return String(value ?? "").trim(); }
function clip(value, maximum = 1200) { const text = clean(value); return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`; }
function uniqueStrings(values) { return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))]; }
function stableBatchId({ agentId, subjectRole, subjectKey, canonicalKey, currentRepresentationLayer, memoryIds }) {
  const value = [clean(agentId), clean(subjectRole), clean(subjectKey), clean(canonicalKey).toLocaleLowerCase("en-US"),
    clean(currentRepresentationLayer), uniqueStrings(memoryIds).sort().join("\u001f")].join("\u001e");
  return `self-concept-analysis-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}
function currentStateView(repository, agentId, subjectRole, subjectKey, canonicalKey, representationLayer) {
  const current = repository.getCurrentCanonicalMemory({ agentId, subjectRole, subjectKey, canonicalKey,
    representationLayer, stateFamily: "self_concept" });
  if (!current) return null;
  if (!SELF_CONCEPT_MEMORY_KINDS.has(current.kind)) throw new Error("Self-concept canonicalKey currently resolves to a non-self-concept-compatible memory kind.");
  return { id: current.id, kind: current.kind, content: clip(current.content), subjectRole: current.subject_role,
    subjectKey: current.subject_key, canonicalKey: current.canonical_key,
    representationLayer: current.representation_layer, temporalState: current.temporal_state,
    knownAt: current.known_at, validFrom: current.valid_from, validTo: current.valid_to };
}
function targetHasRole(memory, target, allowedRoles, { allowPrimary = true } = {}) {
  if (allowPrimary && memory.subjectRole === target.subjectRole && memory.subjectKey === target.subjectKey) return true;
  return memory.actorRoles.some((role) => allowedRoles.has(role.role)
    && role.actorRole === target.subjectRole && role.actorKey === target.subjectKey);
}
function enforceBoundary(role, analysis, snapshot) {
  const memory = snapshot.memories.find((item) => item.id === analysis.memoryId);
  if (!memory) throw new Error("Self-concept analysis memory must come from the bounded snapshot.");
  const sources = new Set(memory.sourceIds);
  if (analysis.sourceIds.some((id) => !sources.has(id))) throw new Error("Self-concept analysis source must directly support its selected memory.");
  if (role === "holder-attribution"
    && ["explicit_self_definition", "explicit_self_reflection"].includes(analysis.attribution)) {
    if (!targetHasRole(memory, snapshot.target, new Set(["speaker"]), { allowPrimary: false })) {
      throw new Error("Explicit self-concept expression requires the fixed subject as speaker.");
    }
  } else if (!targetHasRole(memory, snapshot.target, new Set(["subject", "speaker", "participant", "experiencer"]))) {
    throw new Error("Self-concept analysis does not identify the fixed holder.");
  }
  if (role === "current-relation") {
    const hasCurrent = Boolean(snapshot.currentState);
    if (analysis.currentStatePresent !== hasCurrent) throw new Error("Self-concept current-state presence does not match the read-only snapshot.");
    if (hasCurrent && analysis.relation === "no_current_state") throw new Error("Self-concept relation cannot omit an available current state.");
    if (!hasCurrent && analysis.relation !== "no_current_state") throw new Error("Self-concept relation invented a current state.");
  }
  return analysis;
}
async function appendAnalyzerUsage({ usageLedgerPath, generation, definition, agentId, batchId }) {
  if (!clean(usageLedgerPath) || !generation?.model || !generation?.usage) return "";
  try {
    await appendUsageEvent(path.resolve(usageLedgerPath), { agentId, provider: generation.metadata?.provider || "",
      model: generation.model, source: "memory-evaluation", feature: `memory-self-concept-${definition.role}`,
      requestId: generation.requestId || "", usage: generation.usage,
      metadata: { batchId, durationMs: Number(generation.durationMs || 0), ...generation.metadata } });
    return "";
  } catch (error) { return `费用流水写入失败：${error.message}`; }
}
async function invokeAnalyzer({ definition, generator, snapshot, promptDirectory, maximumAnalyses }) {
  const systemPrompt = fs.readFileSync(path.join(path.resolve(promptDirectory), definition.promptFile), "utf8")
    .replace(/^\uFEFF/u, "").trim();
  const input = buildSelfConceptGenerationInput(snapshot, definition);
  let generation = null;
  try {
    generation = await generator({ input, systemPrompt, schema: definition.schema,
      schemaName: definition.schemaName, stateFamily: "self_concept", analyzerRole: definition.role });
    const parsed = parseSelfConceptGeneration(definition.role, generation?.output, { maximumAnalyses });
    const accepted = []; const rejected = []; const seen = new Set();
    for (const [index, item] of parsed.analyses.entries()) {
      try {
        if (seen.has(item.memoryId)) throw new Error("A self-concept analyzer can analyze each memory at most once.");
        accepted.push(enforceBoundary(definition.role, item, snapshot)); seen.add(item.memoryId);
      } catch (error) { rejected.push({ index, memoryId: item.memoryId, error: error.message }); }
    }
    return { definition, input, generation, analyses: accepted, rejected,
      status: accepted.length ? "completed" : rejected.length ? "rejected" : "abstained", error: "" };
  } catch (error) { return { definition, input, generation, analyses: [], rejected: [], status: "failed", error: error.message }; }
}
function byMemory(items) { return new Map((Array.isArray(items) ? items : []).map((item) => [item.memoryId, item])); }
function selfConceptGate({ concept, holder, stability, time, relation, currentState }) {
  if (!concept) return { qualification: "unresolved", reason: "missing-self-concept-grounding-analysis" };
  if (["none", "contextual"].includes(concept.targetMatch)) return { qualification: "excluded", reason: "memory-does-not-express-the-fixed-self-concept" };
  if (["unknown", "broader_category"].includes(concept.targetMatch) || concept.conceptType === "unknown" || !concept.conceptLabel) {
    return { qualification: "unresolved", reason: "self-concept-target-is-not-exact-enough" };
  }
  if (!holder) return { qualification: "unresolved", reason: "missing-self-concept-holder-analysis" };
  if (holder.holderMatch === "no") return { qualification: "excluded", reason: "self-concept-belongs-to-another-holder" };
  if (holder.holderMatch === "unknown") return { qualification: "unresolved", reason: "self-concept-holder-unknown" };
  if (holder.attribution === "quoted_or_roleplay") return { qualification: "excluded", reason: "self-concept-is-quoted-or-roleplay" };
  if (!["explicit_self_definition", "explicit_self_reflection"].includes(holder.attribution)) {
    return { qualification: "unresolved", reason: "self-concept-is-not-the-holder-own-understanding" };
  }
  if (!stability) return { qualification: "unresolved", reason: "missing-self-concept-stability-analysis" };
  if (["temporary_self_appraisal", "contextual_role", "identity_fact", "no_self_concept"].includes(stability.expressionType)) {
    return { qualification: "excluded", reason: `self-concept-${stability.expressionType.replaceAll("_", "-")}` };
  }
  if (stability.expressionType === "unknown" || stability.contextBasis === "unknown") {
    return { qualification: "unresolved", reason: "self-concept-stability-or-context-unknown" };
  }
  if (stability.contextBasis === "acute_emotion") return { qualification: "excluded", reason: "acute-emotion-is-not-stable-self-concept" };
  if (stability.contextBasis === "roleplay") return { qualification: "excluded", reason: "roleplay-is-not-real-self-concept" };
  if (!time) return { qualification: "unresolved", reason: "missing-self-concept-time-analysis" };
  if (["future", "temporary"].includes(time.stateTime)) return { qualification: "excluded", reason: "future-or-temporary-appraisal-is-not-current-self-concept" };
  if (time.stateTime === "unknown" || time.revisionCue === "unknown") return { qualification: "unresolved", reason: "self-concept-time-or-revision-unknown" };
  if (!relation) return { qualification: "unresolved", reason: "missing-self-concept-current-relation-analysis" };
  if (Boolean(currentState) !== relation.currentStatePresent) return { qualification: "unresolved", reason: "self-concept-current-state-presence-conflict" };
  if (relation.relation === "unknown") return { qualification: "unresolved", reason: "self-concept-current-relation-unknown" };
  if (currentState && relation.relation === "unrelated") return { qualification: "excluded", reason: "self-concept-is-unrelated-to-current-canonical-state" };
  if (currentState && ["narrows", "broadens", "same_scope_conflict", "replaces", "corrects_attribution"].includes(relation.relation)
    && ["none", "unknown"].includes(relation.scopeOverlap)) return { qualification: "unresolved", reason: "self-concept-scope-overlap-is-not-proven" };
  if (relation.relation === "replaces" && time.revisionCue !== "changed") return { qualification: "unresolved", reason: "self-concept-replacement-needs-explicit-change" };
  if (relation.relation === "corrects_attribution" && time.revisionCue !== "never_held") return { qualification: "unresolved", reason: "self-concept-attribution-correction-needs-explicit-denial" };
  return null;
}
function directionFor(relation, currentState) {
  if (!currentState || relation?.relation === "no_current_state") return "support";
  if (["narrows", "same_scope_conflict", "replaces", "corrects_attribution"].includes(relation?.relation)) return "opposition";
  if (["unrelated", "unknown"].includes(relation?.relation)) return "neutral";
  return "support";
}
function signalFor(holder, stability, time) {
  if (time?.revisionCue === "never_held") return "self_concept_attribution_correction";
  if (time?.stateTime === "historical") return "historical_self_concept";
  if (holder?.attribution === "explicit_self_reflection" || stability?.expressionType === "reflective_reinterpretation") return "self_reflection";
  return "self_definition";
}
function actionPreview({ qualification, time, relation, currentState }) {
  const base = { action: "no_conclusion", proposedKind: "belief_state",
    reason: qualification === "qualified" ? "no-safe-self-concept-action" : "evidence-not-qualified",
    automaticStateWriteAllowed: false };
  if (qualification !== "qualified" || !time || !relation) return base;
  if (time.stateTime === "historical") return { ...base, reason: "historical-self-concept-does-not-change-current-state" };
  if (!currentState) return { ...base, action: "accumulate_evidence", reason: "single-self-concept-expression-needs-later-canonical-review" };
  return {
    no_current_state: base,
    equivalent: { ...base, action: "reinforce", reason: "same-self-concept-evidence-supports-current-state" },
    supports: { ...base, action: "reinforce", reason: "new-evidence-supports-current-self-concept" },
    narrows: { ...base, action: "narrow_scope", reason: "self-concept-clarification-narrows-current-scope" },
    broadens: { ...base, action: "review_required", reason: "broader-self-concept-scope-needs-review" },
    same_scope_conflict: { ...base, action: "contradict", reason: "same-scope-self-concept-conflict" },
    replaces: { ...base, action: "supersede", reason: "subject-explicitly-changed-self-understanding" },
    corrects_attribution: { ...base, action: "correct_attribution", reason: "subject-denies-ever-holding-attributed-self-concept" },
    unrelated: base, unknown: base,
  }[relation.relation] || base;
}
function mergeAnalyses({ evaluation, persistEvidenceLedger }) {
  const maps = Object.fromEntries(Object.entries(evaluation.analyses).map(([key, items]) => [key, byMemory(items)]));
  const memoryIds = uniqueStrings(Object.values(evaluation.analyses).flat().map((item) => item.memoryId));
  const observations = []; const previews = [];
  for (const memoryId of memoryIds) {
    const memory = evaluation.snapshot.memories.find((item) => item.id === memoryId);
    const concept = maps.conceptGrounding?.get(memoryId) || null;
    const holder = maps.holderAttribution?.get(memoryId) || null;
    const stability = maps.stabilityContext?.get(memoryId) || null;
    const time = maps.timeRevision?.get(memoryId) || null;
    const relation = maps.currentRelation?.get(memoryId) || null;
    const gate = selfConceptGate({ concept, holder, stability, time, relation, currentState: evaluation.snapshot.currentState });
    const qualification = gate?.qualification || "qualified";
    const analyses = [concept, holder, stability, time, relation].filter(Boolean);
    const claimedDirection = directionFor(relation, evaluation.snapshot.currentState);
    const sourceIds = uniqueStrings(analyses.flatMap((item) => item.sourceIds)).sort();
    const analysisRunIds = Object.entries(maps).filter(([, map]) => map.has(memoryId))
      .map(([key]) => evaluation.runs[key]).filter((run) => run?.status === "completed").map((run) => run.id).sort();
    let observation = null;
    if (persistEvidenceLedger && sourceIds.length && analysisRunIds.length) {
      observation = evaluation.repository.recordStateEvidenceObservation({
        agentId: evaluation.snapshot.agentId, batchId: evaluation.batchId, stateFamily: "self_concept",
        subjectRole: evaluation.snapshot.target.subjectRole, subjectKey: evaluation.snapshot.target.subjectKey,
        canonicalKey: evaluation.snapshot.target.canonicalKey, memoryId, evidenceGroupId: memory.evidenceGroupId,
        contextId: memory.contextId, signal: signalFor(holder, stability, time), claimedDirection,
        effectiveDirection: qualification === "qualified" ? claimedDirection : "neutral", qualification,
        confidence: Math.min(...analyses.map((item) => item.confidence)), origin: "llm",
        scope: { selfConceptLabel: evaluation.snapshot.target.selfConceptLabel,
          conceptType: concept?.conceptType || "unknown", scopeLabel: concept?.scopeLabel || "",
          expressionType: stability?.expressionType || "unknown", contextBasis: stability?.contextBasis || "unknown",
          stateTime: time?.stateTime || "unknown", currentRelation: relation?.relation || "unknown",
          scopeOverlap: relation?.scopeOverlap || "unknown",
          currentRepresentationLayer: evaluation.snapshot.target.currentRepresentationLayer },
        payloadSchemaVersion: "self-concept-merged-evidence-v1",
        payload: { concept, holder, stability, time, relation }, excludedReason: gate?.reason || "",
        sourceIds, analysisRunIds, observedAt: memory.eventStart || memory.eventDate || memory.knownAt,
      });
      observations.push(observation);
    }
    previews.push({ memoryId, observationId: observation?.id || "", qualification, gateReason: gate?.reason || "",
      ...actionPreview({ qualification, time, relation, currentState: evaluation.snapshot.currentState }) });
  }
  return { observations, previews };
}

export async function evaluateSelfConceptEvidence({
  repository, agentId, subjectRole, subjectKey, canonicalKey, selfConceptLabel,
  memoryIds = [], analyzers = {}, usageLedgerPath = "", promptDirectory = DEFAULT_PROMPT_DIRECTORY,
  snapshotOptions = {}, maximumAnalyses = 60, persistEvidenceLedger = true,
  currentRepresentationLayer = "",
} = {}) {
  if (!repository) throw new Error("Self-concept evaluation requires a repository.");
  if (clean(subjectRole) === "shared") throw new Error("Self-concept evaluation currently requires an individual fixed subject.");
  if (!clean(selfConceptLabel)) throw new Error("Self-concept evaluation requires a readable selfConceptLabel.");
  for (const key of Object.keys(SELF_CONCEPT_ANALYZERS)) if (typeof analyzers[key] !== "function") throw new Error(`Self-concept evaluation requires analyzers.${key}.`);
  const normalizedMemoryIds = uniqueStrings(memoryIds);
  const batchId = stableBatchId({ agentId, subjectRole, subjectKey, canonicalKey,
    currentRepresentationLayer, memoryIds: normalizedMemoryIds });
  const baseSnapshot = buildPreferenceEvidenceSnapshot({ repository, agentId, subjectRole, subjectKey, canonicalKey,
    memoryIds: normalizedMemoryIds, ...snapshotOptions });
  const snapshot = { ...baseSnapshot, agentId: clean(agentId),
    target: { ...baseSnapshot.target, stateFamily: "self_concept", selfConceptLabel: clean(selfConceptLabel),
      currentRepresentationLayer: clean(currentRepresentationLayer) },
    currentState: currentStateView(repository, clean(agentId), baseSnapshot.target.subjectRole,
      baseSnapshot.target.subjectKey, baseSnapshot.target.canonicalKey, clean(currentRepresentationLayer)),
    inputPolicy: { ...baseSnapshot.inputPolicy, currentStateIsReadOnly: true,
      currentStateLayerIsFixedByCaller: Boolean(clean(currentRepresentationLayer)),
      modelCanChooseStateAction: false, modelSummaryCannotBecomeSubjectSelfConcept: true } };
  const snapshotLimit = Math.min(250_000, Math.max(4_000, Math.trunc(Number(snapshotOptions.maxSnapshotChars) || 64_000)));
  if (JSON.stringify(snapshot).length > snapshotLimit) throw new Error(`Self-concept evidence snapshot exceeds the ${snapshotLimit}-character privacy budget.`);
  if (!snapshot.memories.length) return { status: "skipped", reason: "no-eligible-memories-with-direct-sources",
    batchId, snapshot, runs: {}, analyses: {}, rejected: {}, observations: [], actionPreviews: [], failedRoles: [],
    warnings: [], automaticStateWriteAllowed: false };
  const definitions = Object.entries(SELF_CONCEPT_ANALYZERS);
  const invocations = await Promise.all(definitions.map(async ([key, definition]) => [key,
    await invokeAnalyzer({ definition, generator: analyzers[key], snapshot, promptDirectory, maximumAnalyses })]));
  const sourceIds = uniqueStrings(snapshot.memories.flatMap((memory) => memory.sourceIds)).sort();
  const runs = {}; const analyses = {}; const rejected = {}; const warnings = [];
  for (const [key, invocation] of invocations) {
    const warning = await appendAnalyzerUsage({ usageLedgerPath, generation: invocation.generation,
      definition: invocation.definition, agentId: clean(agentId), batchId });
    if (warning) warnings.push(warning);
    runs[key] = repository.recordStateAnalysisRun({ agentId: clean(agentId), batchId, stateFamily: "self_concept",
      analyzerRole: invocation.definition.role, subjectRole: snapshot.target.subjectRole,
      subjectKey: snapshot.target.subjectKey, canonicalKey: snapshot.target.canonicalKey,
      provider: clean(invocation.generation?.metadata?.provider) || "unreported",
      model: clean(invocation.generation?.model) || "unreported", promptVersion: invocation.definition.promptVersion,
      schemaVersion: invocation.definition.schemaName, inputHash: createHash("sha256").update(invocation.input).digest("hex"),
      status: invocation.status, memoryIds: snapshot.memories.map((memory) => memory.id), sourceIds,
      output: invocation.generation?.output ?? {}, rejected: invocation.rejected, usage: invocation.generation?.usage || {},
      costAmount: Number(invocation.generation?.costAmount ?? invocation.generation?.metadata?.costAmount ?? 0) || 0,
      costCurrency: clean(invocation.generation?.costCurrency ?? invocation.generation?.metadata?.costCurrency),
      requestId: clean(invocation.generation?.requestId),
      durationMs: Math.max(0, Math.trunc(Number(invocation.generation?.durationMs) || 0)),
      errorMessage: invocation.error, metadata: { selfConceptLabel: clean(selfConceptLabel),
        currentRepresentationLayer: clean(currentRepresentationLayer), automaticStateWriteAllowed: false } });
    analyses[key] = invocation.analyses; rejected[key] = invocation.rejected;
  }
  const failedRoles = definitions.map(([key]) => key).filter((key) => ["failed", "rejected"].includes(runs[key].status));
  const evaluation = { repository, batchId, snapshot, runs, analyses };
  let merged = { observations: [], previews: [] };
  if (!failedRoles.length) merged = repository.transaction(() => mergeAnalyses({ evaluation, persistEvidenceLedger }));
  const hasAnyAnalysis = Object.values(analyses).some((items) => items.length);
  return { status: failedRoles.length ? "incomplete" : hasAnyAnalysis ? "analyzed" : "abstained",
    reason: failedRoles.length ? "required-self-concept-analyzer-failed-or-rejected" : "", batchId, snapshot,
    runs, analyses, rejected, observations: merged.observations, actionPreviews: merged.previews,
    failedRoles, warnings, automaticStateWriteAllowed: false };
}
