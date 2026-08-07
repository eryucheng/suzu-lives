import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendUsageEvent } from "@suzu-lives/cost-ledger";
import {
  DIRECT_INGESTION_MEMORY_KINDS,
  MemoryRepository,
  applyMemoryCandidate,
  isStatefulMemoryKind,
  normalizeStateAnalysisTargetSpec,
  openMemoryDatabase,
  updateAssociationGraph,
} from "@suzu-lives/memory-core";
import { syncMemoryEmbeddings } from "@suzu-lives/memory-embedding-indexer";
import {
  planMemoryConsolidation,
  proposeStructuresForBatch,
} from "@suzu-lives/memory-structurer";

import { standardizeCompactedPrefix } from "./conversation.mjs";
import {
  buildCompactionInput,
  isRetentionReasonCompatible,
  parseGeneratedCompaction,
} from "./prompt.mjs";
import {
  appendCompactRecords,
  buildCompactRecords,
  chooseCompactionPlan,
  parseJsonlText,
  reconstructLogicalContext,
  rollbackCompactWrite,
} from "./transcript.mjs";
import {
  DIRECT_USER_AGENT_DM_TOPOLOGY,
  buildArchivedUtteranceIdentity,
} from "./utterance-evidence.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_PATH = path.join(PACKAGE_ROOT, "resources", "system-prompt.md");

function clean(value) {
  return String(value ?? "").trim();
}

function stableId(prefix, ...parts) {
  const digest = createHash("sha256")
    .update(parts.map(clean).join("\u001f"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}-${digest}`;
}

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, filePath);
}

function writeJsonAtomic(filePath, value) {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isoTimestamp(value, fallback = null) {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : fallback;
}

function actorKeyFor(actorRole, actorName, agentId) {
  switch (actorRole) {
    case "user": return "user";
    case "agent": return agentId;
    case "shared": return `shared:${agentId}:user`;
    case "other": return clean(actorName).toLocaleLowerCase("zh-CN");
    case "world": return "";
    default: return "";
  }
}

function subjectKeyFor(candidate, agentId) {
  return actorKeyFor(candidate.subjectRole, candidate.subjectName, agentId);
}

function requestTargetSpec(candidate, agentId) {
  const target = candidate.stateTarget || {};
  if (candidate.stateFamily === "identity") {
    return normalizeStateAnalysisTargetSpec("identity", {
      identityField: target.identityField,
      fieldCardinality: target.fieldCardinality,
    }, { allowEmpty: false });
  }
  if (candidate.stateFamily === "belief") {
    return normalizeStateAnalysisTargetSpec("belief", {
      objectRole: target.objectRole,
      objectKey: actorKeyFor(target.objectRole, target.objectName, agentId),
      objectLabel: target.objectName,
    }, { allowEmpty: false });
  }
  if (candidate.stateFamily === "relationship") {
    return normalizeStateAnalysisTargetSpec("relationship", {
      counterpartRole: target.counterpartRole,
      counterpartKey: actorKeyFor(target.counterpartRole, target.counterpartName, agentId),
      counterpartLabel: target.counterpartName,
      direction: target.direction,
    }, { allowEmpty: false });
  }
  if (candidate.stateFamily === "affective_association") {
    return normalizeStateAnalysisTargetSpec("affective_association", {
      triggerRole: target.triggerRole,
      triggerKey: actorKeyFor(target.triggerRole, target.triggerName, agentId),
      triggerLabel: target.triggerName,
    }, { allowEmpty: false });
  }
  return {};
}

function structuredActorRoles(candidate, agentId) {
  const roles = (Array.isArray(candidate.actorRoles) ? candidate.actorRoles : []).map((actor) => ({
    role: actor.role,
    actorRole: actor.actorRole,
    actorKey: actorKeyFor(actor.actorRole, actor.actorName, agentId),
    isPrimary: false,
    confidence: actor.confidence,
    provenance: "memory-compactor-v2",
    metadata: { actorName: clean(actor.actorName) },
  }));
  const holderRole = candidate.kind === "belief_state"
    ? "belief_holder"
    : candidate.kind === "preference" ? "preference_holder" : "";
  if (holderRole && candidate.subjectRole !== "unknown") {
    const subjectKey = subjectKeyFor(candidate, agentId);
    if (!roles.some((actor) => (
      actor.role === holderRole
      && actor.actorRole === candidate.subjectRole
      && actor.actorKey === subjectKey
    ))) {
      roles.push({
        role: holderRole,
        actorRole: candidate.subjectRole,
        actorKey: subjectKey,
        isPrimary: true,
        confidence: candidate.confidence,
        provenance: "memory-compactor-v2-kind-subject",
        metadata: { actorName: clean(candidate.subjectName) },
      });
    }
  }
  return roles;
}

function firstEvidenceTime(referenced, fallback) {
  return referenced.reduce((earliest, item) => {
    const timestamp = isoTimestamp(item.message.timestamp);
    return timestamp && (!earliest || timestamp < earliest) ? timestamp : earliest;
  }, "") || fallback;
}

function decisionForResult(result) {
  if (result.status === "review") return "review";
  if (result.status === "reject") return "reject";
  if (result.stateAnalysisRequestId) return "store";
  return result.memoryId ? "store" : "reject";
}

function sameNamedActor(candidate, actor) {
  if (actor.actorRole !== candidate.subjectRole) return false;
  if (candidate.subjectRole !== "other") return true;
  return clean(actor.actorName).toLocaleLowerCase("zh-CN")
    === clean(candidate.subjectName).toLocaleLowerCase("zh-CN");
}

function evidenceAlignmentProblems(candidate, referencedMessages) {
  const problems = new Set();
  const hasUserEvidence = referencedMessages.some((message) => message.role === "user");
  const hasAgentEvidence = referencedMessages.some((message) => message.role === "assistant");
  if (!isRetentionReasonCompatible(candidate.kind, candidate.retentionReason)) {
    problems.add("retention-reason-kind-mismatch");
  }
  if (candidate.subjectRole === "user" && !referencedMessages.some((message) => message.role === "user")) {
    problems.add("user-memory-without-user-source");
  }
  if (candidate.subjectRole === "agent" && !referencedMessages.some((message) => message.role === "assistant")) {
    problems.add("agent-memory-without-agent-source");
  }
  if (candidate.subjectRole === "other" && !clean(candidate.subjectName)) {
    problems.add("other-memory-without-subject-name");
  }
  if (
    candidate.kind === "commitment"
    && candidate.subjectRole === "shared"
    && (!hasUserEvidence || !hasAgentEvidence)
  ) {
    problems.add("shared-commitment-without-bilateral-source");
  }

  const holderRole = candidate.kind === "belief_state"
    ? "belief_holder"
    : candidate.kind === "preference" ? "preference_holder" : "";
  for (const actor of Array.isArray(candidate.actorRoles) ? candidate.actorRoles : []) {
    if (
      actor.actorRole === "user"
      && !hasUserEvidence
      && candidate.subjectRole !== "user"
    ) problems.add("user-actor-without-user-source");
    if (
      actor.actorRole === "agent"
      && !hasAgentEvidence
      && candidate.subjectRole !== "agent"
    ) problems.add("agent-actor-without-agent-source");
    if (holderRole && actor.role === holderRole && !sameNamedActor(candidate, actor)) {
      problems.add("holder-conflicts-with-subject");
    }
  }
  return [...problems];
}

function archiveCompactedMessages({
  repository,
  agentId,
  transcriptPath,
  messages,
  generatedMemories,
  boundaryUuid,
  recordedAt,
  conversationTopology,
}) {
  const sourceByRef = new Map();
  const messageMemoryIds = [];
  const results = [];
  repository.transaction(() => {
    const keepResult = (candidateIndex, generated, result, referenced = []) => {
      const recorded = {
        ...result,
        sourceRefs: generated.sourceRefs,
        candidate: generated,
      };
      repository.recordIngestionDecision({
        agentId,
        batchId: boundaryUuid,
        candidateIndex,
        decision: decisionForResult(recorded),
        resultStatus: recorded.status,
        reasonCodes: recorded.reasons,
        candidate: generated,
        sourceRefs: generated.sourceRefs,
        sourceIds: referenced.map((item) => item.source.id),
        knownAt: firstEvidenceTime(referenced, null),
        memoryId: recorded.memoryId || null,
      });
      results.push(recorded);
    };
    for (const message of messages) {
      const utteranceIdentity = buildArchivedUtteranceIdentity({
        messageRole: message.role,
        agentId,
        conversationTopology,
        provenance: "memory-compactor-v2-utterance",
      });
      const source = repository.upsertSource({
        agentId,
        sourceKind: "transcript-message",
        sourceLocator: path.resolve(transcriptPath),
        externalId: message.id,
        occurredAt: isoTimestamp(message.timestamp),
        knownAt: isoTimestamp(message.timestamp),
        recordedAt,
        speaker: message.speaker,
        content: message.text,
        metadata: {
          role: message.role,
          sourceUuid: message.sourceUuid,
          sourceIndex: message.sourceIndex,
          sourceKind: message.sourceKind,
          compactionBoundaryUuid: boundaryUuid,
          memoryRef: message.memoryRef,
        },
      });
      const memoryId = stableId("mem", agentId, "utterance", message.id);
      repository.upsertMemory({
        id: memoryId,
        agentId,
        kind: "utterance",
        layer: "evidence",
        content: message.text,
        subjectRole: utteranceIdentity.subjectRole,
        subjectKey: utteranceIdentity.subjectKey,
        reality: "real",
        evidenceMode: "imported",
        temporalState: "historical",
        eventStart: isoTimestamp(message.timestamp),
        knownAt: isoTimestamp(message.timestamp),
        recordedAt,
        perspective: message.role,
        importance: 0.25,
        actorRoles: utteranceIdentity.actorRoles,
        metadata: {
          sourceKind: message.sourceKind,
          speaker: message.speaker,
          compactionBoundaryUuid: boundaryUuid,
        },
      });
      repository.linkSource(memoryId, source.id, "verbatim", {
        authority: "verbatim_record",
        sourceTrust: 1,
        evidenceStrength: 1,
        provenance: "memory-compactor-v1",
      });
      sourceByRef.set(message.memoryRef, { source, message, memoryId });
      messageMemoryIds.push(memoryId);
    }
    for (let index = 1; index < messageMemoryIds.length; index += 1) {
      repository.upsertEdge({
        agentId,
        fromMemoryId: messageMemoryIds[index - 1],
        toMemoryId: messageMemoryIds[index],
        relation: "followed_by",
        direction: "directed",
        weight: 1,
        confidence: 1,
        provenance: "memory-compactor-v1",
      });
    }

    for (const [candidateIndex, generated] of generatedMemories.entries()) {
      const referenced = generated.sourceRefs
        .map((reference) => sourceByRef.get(reference))
        .filter(Boolean);
      const missingRefs = generated.sourceRefs.filter((reference) => !sourceByRef.has(reference));
      if (missingRefs.length) {
        keepResult(candidateIndex, generated, {
          status: "reject",
          reasons: ["unknown-source-ref"],
          missingRefs,
        }, referenced);
        continue;
      }
      const alignmentProblems = evidenceAlignmentProblems(
        generated,
        referenced.map((item) => item.message),
      );
      if (alignmentProblems.length) {
        keepResult(candidateIndex, generated, {
          status: "review",
          reasons: alignmentProblems,
        }, referenced);
        continue;
      }
      if (isStatefulMemoryKind(generated.kind)) {
        const subjectKey = subjectKeyFor(generated, agentId);
        if (!["user", "agent", "shared", "other"].includes(generated.subjectRole)
          || !subjectKey) {
          keepResult(candidateIndex, generated, {
            status: "review",
            reasons: ["state-analysis-needs-fixed-personal-subject"],
          }, referenced);
          continue;
        }
        const targetSpec = requestTargetSpec(generated, agentId);
        if (generated.stateFamily === "relationship"
          && targetSpec.counterpartRole === generated.subjectRole
          && targetSpec.counterpartKey === subjectKey) {
          keepResult(candidateIndex, generated, {
            status: "review",
            reasons: ["state-analysis-relationship-counterpart-matches-holder"],
          }, referenced);
          continue;
        }
        const request = repository.recordStateAnalysisRequest({
          agentId,
          batchId: boundaryUuid,
          candidateIndex,
          stateFamily: generated.stateFamily,
          subjectRole: generated.subjectRole,
          subjectKey,
          canonicalKey: generated.canonicalKey,
          targetLabel: generated.stateLabel,
          targetSpec,
          representationLayer: generated.evidenceMode === "explicit" ? "reported" : "inferred",
          evidenceMode: generated.evidenceMode,
          memoryIds: referenced.map((item) => item.memoryId),
          sourceIds: referenced.map((item) => item.source.id),
          metadata: {
            candidateKind: generated.kind,
            subjectName: generated.subjectName,
            retentionReason: generated.retentionReason,
            revisionAction: generated.revisionAction,
            temporalState: generated.temporalState,
            compactionBoundaryUuid: boundaryUuid,
            generator: "memory-compactor-v2-state-target",
          },
          createdAt: recordedAt,
        });
        keepResult(candidateIndex, generated, {
          status: "analysis_pending",
          reasons: [],
          stateAnalysisRequestId: request.id,
          stateAnalysisRequestInserted: request.wasInserted,
        }, referenced);
        continue;
      }
      const result = applyMemoryCandidate(repository, {
        agentId,
        kind: generated.kind,
        title: generated.title,
        content: generated.content,
        subjectRole: generated.subjectRole,
        subjectKey: subjectKeyFor(generated, agentId),
        canonicalKey: generated.canonicalKey,
        reality: generated.reality,
        evidenceMode: generated.evidenceMode,
        temporalState: generated.temporalState,
        revisionAction: generated.revisionAction,
        eventDate: generated.eventDate || null,
        eventStart: generated.eventStart || null,
        eventEnd: generated.eventEnd || null,
        knownAt: firstEvidenceTime(referenced, recordedAt),
        confidence: generated.confidence,
        importance: generated.importance,
        actorRoles: structuredActorRoles(generated, agentId),
        evidenceLinks: referenced.map((item) => {
          const sameSubject = (
            (generated.subjectRole === "user" && item.message.role === "user")
            || (generated.subjectRole === "agent" && item.message.role === "assistant")
          );
          const authority = generated.evidenceMode === "inferred"
            ? "model_inference"
            : sameSubject ? "subject_firsthand"
              : generated.evidenceMode === "observed" ? "direct_observation" : "unknown";
          return {
            sourceId: item.source.id,
            relation: "evidence",
            authority,
            sourceTrust: authority === "subject_firsthand" ? 0.9
              : authority === "direct_observation" ? 0.8
                : authority === "model_inference" ? 0.5 : 0.5,
            evidenceStrength: 1,
            provenance: "memory-compactor-v1",
          };
        }),
        metadata: {
          subjectName: generated.subjectName,
          retentionReason: generated.retentionReason,
          sourceRefs: generated.sourceRefs,
          compactionBoundaryUuid: boundaryUuid,
          generator: "memory-compactor-v1",
        },
      }, { recordedAt });
      if (result.memory) {
        for (const evidence of referenced) {
          repository.upsertEdge({
            agentId,
            fromMemoryId: result.memory.id,
            toMemoryId: evidence.memoryId,
            relation: "supported_by",
            direction: "directed",
            weight: 1,
            confidence: generated.confidence,
            provenance: "memory-compactor-v1",
          });
        }
      }
      keepResult(candidateIndex, generated, {
        status: result.status,
        reasons: result.reasons,
        memoryId: result.memory?.id || "",
      }, referenced);
    }
  });
  return {
    messagesArchived: messages.length,
    candidateResults: results,
    memoriesStored: results.filter((result) => (
      ["created", "reinforced", "update", "correct", "contradict", "complete", "cancel"]
        .includes(result.status)
    )).length,
    memoriesForReview: results.filter((result) => result.status === "review").length,
    memoriesRejected: results.filter((result) => result.status === "reject").length,
    stateAnalysisRequestsQueued: results.filter((result) => result.stateAnalysisRequestId).length,
  };
}

function resolvePaths({
  softwareDataDirectory,
  agentId,
  databasePath,
  usageLedgerPath,
}) {
  const dataRoot = path.resolve(clean(softwareDataDirectory));
  const agentRoot = path.join(dataRoot, "agents", agentId);
  const compactorRoot = path.join(agentRoot, "memory", "compactor");
  return {
    dataRoot,
    agentRoot,
    databasePath: databasePath
      ? path.resolve(databasePath)
      : path.join(agentRoot, "memory", "memory.db"),
    usageLedgerPath: usageLedgerPath
      ? path.resolve(usageLedgerPath)
      : path.join(agentRoot, "cost-ledger", "events.jsonl"),
    workDirectory: path.join(compactorRoot, "work"),
    backupDirectory: path.join(compactorRoot, "backups"),
  };
}

export async function runCompaction({
  transcriptPath,
  agentId,
  softwareDataDirectory,
  databasePath = "",
  usageLedgerPath = "",
  memoryOwner = "记忆拥有者",
  userName = "对方",
  rules = {},
  boundaryContextMessages = 20,
  generator = null,
  structureGenerator = null,
  embeddingProvider = null,
  dryRun = false,
  now = new Date(),
  summaryOverride = "",
  memoriesOverride = [],
  systemPromptPath = DEFAULT_PROMPT_PATH,
} = {}) {
  const normalizedAgentId = clean(agentId);
  if (!normalizedAgentId) throw new Error("runCompaction 需要 agentId。");
  if (!clean(softwareDataDirectory)) throw new Error("runCompaction 需要 softwareDataDirectory。");
  const requestedTranscriptPath = clean(transcriptPath);
  if (!requestedTranscriptPath) throw new Error("runCompaction 需要 transcriptPath。");
  const normalizedTranscriptPath = path.resolve(requestedTranscriptPath);
  if (!fs.existsSync(normalizedTranscriptPath)) {
    throw new Error(`会话 JSONL 不存在：${normalizedTranscriptPath}`);
  }
  const executionTime = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(executionTime.getTime())) throw new Error("now 不是有效时间。");
  const paths = resolvePaths({
    softwareDataDirectory,
    agentId: normalizedAgentId,
    databasePath,
    usageLedgerPath,
  });
  fs.mkdirSync(paths.workDirectory, { recursive: true });
  const originalText = fs.readFileSync(normalizedTranscriptPath, "utf8");
  const entries = parseJsonlText(originalText, normalizedTranscriptPath);
  const context = reconstructLogicalContext(entries);
  const plan = chooseCompactionPlan(context, executionTime, rules);
  if (plan.action === "skip") {
    const report = {
      status: "skipped",
      transcriptPath: normalizedTranscriptPath,
      ...plan,
      checkedAt: executionTime.toISOString(),
    };
    writeJsonAtomic(path.join(paths.workDirectory, "last-run.json"), report);
    return report;
  }
  const archivedMessages = standardizeCompactedPrefix({
    prefix: plan.prefix,
    userName,
    memoryOwner,
  });
  const { input, messages } = buildCompactionInput({
    plan,
    memoryOwner,
    userName,
    boundaryContextMessages,
    archivedMessages,
  });
  writeFileAtomic(path.join(paths.workDirectory, "last-input.md"), input);
  if (dryRun) {
    const report = {
      status: "dry-run",
      transcriptPath: normalizedTranscriptPath,
      databasePath: paths.databasePath,
      mode: plan.mode,
      currentTokens: plan.currentTokens,
      headUuid: plan.head.record.uuid,
      headTimestamp: plan.head.record.timestamp,
      currentTailUuid: context.currentTail.record.uuid,
      prefixRecords: plan.prefix.length,
      messagesToArchive: messages.length,
      preservedRecords: plan.preservedLogical.length,
      inputChars: input.length,
      checkedAt: executionTime.toISOString(),
    };
    writeJsonAtomic(path.join(paths.workDirectory, "last-run.json"), report);
    return report;
  }

  let generation;
  if (clean(summaryOverride)) {
    generation = {
      output: parseGeneratedCompaction({
        summary: summaryOverride,
        memories: Array.isArray(memoriesOverride) ? memoriesOverride : [],
      }),
      usage: {},
      model: "",
      requestId: "",
      durationMs: 0,
      metadata: { source: "override" },
    };
  } else {
    if (typeof generator !== "function") {
      throw new Error("实际压缩需要 generator，或提供 summaryOverride 进行本地模拟。");
    }
    const systemPrompt = fs.readFileSync(systemPromptPath, "utf8").trim();
    generation = await generator({ input, systemPrompt, schemaName: "memory-compaction-v1" });
    generation.output = parseGeneratedCompaction(generation.output);
  }
  const built = buildCompactRecords(
    entries,
    context,
    plan,
    { memoryOwner, userName },
    generation.output.summary,
    executionTime,
    Number(generation.durationMs || 0),
  );
  const compactWrite = appendCompactRecords({
    transcriptPath: normalizedTranscriptPath,
    originalText,
    boundary: built.boundary,
    summary: built.summary,
    backupDirectory: paths.backupDirectory,
    now: executionTime,
  });

  const database = openMemoryDatabase(paths.databasePath);
  let archive;
  let associations;
  let embeddingIndex = { status: "disabled", added: 0, reused: 0, failed: 0 };
  let consolidationPlan = null;
  let structureProposals = null;
  const warnings = [];
  let repository;
  try {
    repository = new MemoryRepository(database);
    archive = archiveCompactedMessages({
      repository,
      agentId: normalizedAgentId,
      transcriptPath: normalizedTranscriptPath,
      messages,
      generatedMemories: generation.output.memories,
      boundaryUuid: built.boundary.uuid,
      recordedAt: executionTime.toISOString(),
      conversationTopology: DIRECT_USER_AGENT_DM_TOPOLOGY,
    });
    if (typeof embeddingProvider === "function") {
      try {
        embeddingIndex = await syncMemoryEmbeddings({
          repository,
          agentId: normalizedAgentId,
          embeddingProvider,
          ledgerPath: paths.usageLedgerPath,
        });
        if (["partial", "error"].includes(embeddingIndex.status)) {
          warnings.push(`长期记忆向量化未完整完成：${embeddingIndex.failed} 条失败。`);
        }
      } catch (error) {
        embeddingIndex = {
          status: "error",
          added: 0,
          reused: 0,
          failed: 0,
          error: error.message,
        };
        warnings.push(`长期记忆向量化失败：${error.message}`);
      }
    }
    associations = updateAssociationGraph({
      repository,
      agentId: normalizedAgentId,
      memoryIds: archive.candidateResults
        .map((result) => result.memoryId)
        .filter(Boolean),
    });
  } catch (error) {
    database.close();
    rollbackCompactWrite({
      transcriptPath: normalizedTranscriptPath,
      expectedText: compactWrite.expectedText,
      backupPath: compactWrite.backupPath,
      cause: error,
    });
  }
  const newlyStoredMemoryIds = [...new Set(
    archive.candidateResults.map((result) => result.memoryId).filter(Boolean),
  )];
  const consolidationTriggerIds = newlyStoredMemoryIds.filter((memoryId) => {
    const memory = repository.getMemory(memoryId);
    return memory
      && memory.agent_id === normalizedAgentId
      && memory.status === "active"
      && DIRECT_INGESTION_MEMORY_KINDS.includes(memory.kind);
  });
  if (consolidationTriggerIds.length) {
    try {
      consolidationPlan = planMemoryConsolidation({
        repository,
        agentId: normalizedAgentId,
        triggerMemoryIds: consolidationTriggerIds,
        metadata: { compactionBoundaryUuid: built.boundary.uuid },
      });
    } catch (error) {
      warnings.push(`回顾性巩固规划失败：${error.message}`);
    }
  }
  if (typeof structureGenerator === "function" && newlyStoredMemoryIds.length) {
    try {
      structureProposals = await proposeStructuresForBatch({
        repository,
        agentId: normalizedAgentId,
        batchId: built.boundary.uuid,
        memoryIds: newlyStoredMemoryIds,
        generator: structureGenerator,
        usageLedgerPath: paths.usageLedgerPath,
      });
    } catch (error) {
      warnings.push(`结构候选生成失败：${error.message}`);
    }
  }
  database.close();

  if (generation.model && generation.usage && Object.keys(generation.usage).length) {
    try {
      await appendUsageEvent(paths.usageLedgerPath, {
        timestamp: executionTime.toISOString(),
        agentId: normalizedAgentId,
        provider: generation.metadata?.provider || "",
        model: generation.model,
        source: "memory-compactor",
        feature: "memory-compaction",
        requestId: generation.requestId || "",
        usage: generation.usage,
        metadata: {
          durationMs: Number(generation.durationMs || 0),
          boundaryUuid: built.boundary.uuid,
          ...generation.metadata,
        },
      });
    } catch (error) {
      warnings.push(`费用流水写入失败：${error.message}`);
    }
  }
  writeFileAtomic(
    path.join(paths.workDirectory, "latest-summary.md"),
    `${generation.output.summary}\n`,
  );
  const report = {
    status: "written",
    transcriptPath: normalizedTranscriptPath,
    backupPath: compactWrite.backupPath,
    databasePath: paths.databasePath,
    mode: plan.mode,
    currentTokens: plan.currentTokens,
    headUuid: plan.head.record.uuid,
    headTimestamp: plan.head.record.timestamp,
    tailUuid: context.currentTail.record.uuid,
    preservedRecords: built.preserved.length,
    summarizedRecords: plan.prefix.length,
    boundaryUuid: built.boundary.uuid,
    summaryUuid: built.summary.uuid,
    summaryChars: generation.output.summary.length,
    messagesArchived: archive.messagesArchived,
    generatedCandidates: generation.output.memories.length,
    memoriesStored: archive.memoriesStored,
    memoriesForReview: archive.memoriesForReview,
    memoriesRejected: archive.memoriesRejected,
    stateAnalysisRequestsQueued: archive.stateAnalysisRequestsQueued,
    candidateResults: archive.candidateResults,
    embeddingIndex,
    associationGraph: associations,
    consolidationPlan: consolidationPlan ? {
      runId: consolidationPlan.id,
      status: consolidationPlan.status,
      wasInserted: consolidationPlan.wasInserted,
      triggerCount: consolidationPlan.triggerIds.length,
      candidateCount: consolidationPlan.candidateIds.length,
    } : null,
    structureProposals: structureProposals ? {
      status: structureProposals.status,
      proposed: structureProposals.proposed.length,
      duplicates: structureProposals.duplicates.length,
      rejected: structureProposals.rejected.length,
      proposalIds: structureProposals.proposed.map((proposal) => proposal.id),
      usageRecorded: structureProposals.usageRecorded,
      warnings: structureProposals.warnings,
    } : null,
    usageRecorded: Boolean(
      generation.model && generation.usage && Object.keys(generation.usage).length,
    ),
    warnings,
    writtenAt: executionTime.toISOString(),
  };
  writeJsonAtomic(path.join(paths.workDirectory, "last-run.json"), report);
  return report;
}
