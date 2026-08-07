import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { appendUsageEvent } from "@suzu-lives/cost-ledger";
import {
  MemoryRepository,
  openMemoryDatabase,
  previewEdgePlasticity,
  previewMemoryPlasticity,
  resolveMemorySubjectAttribution,
  resolveMemoryStructureProposal,
  updateAssociationGraph,
} from "@suzu-lives/memory-core";
import {
  createOpenAiCompatibleEmbeddingProvider,
  isContinuationQuery,
  resolveContinuationAnchors,
  retrieveMemories,
} from "@suzu-lives/memory-retriever";
import {
  createBrainSnapshot,
} from "@suzu-lives/memory-visualization";
import { resolveAgentDataRoot } from "@suzu-lives/agent-registry";

function clean(value) {
  return String(value ?? "").trim();
}

function boundedText(value, maximum = 1200) {
  const text = clean(value);
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
  } catch {
    return fallback;
  }
}

function sanitizeEmbeddingConfig(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    enabled: source.enabled !== false,
    baseUrl: clean(source.baseUrl),
    endpoint: clean(source.endpoint) || "embeddings",
    apiKeyEnv: clean(source.apiKeyEnv),
    apiKey: clean(source.apiKey),
    model: clean(source.model),
    dimensions: Math.max(0, Number(source.dimensions || 0)),
    timeoutMs: Math.max(1, Number(source.timeoutMs || 30_000)),
    queryPrefix: String(source.queryPrefix || ""),
    extraHeaders: source.extraHeaders && typeof source.extraHeaders === "object"
      ? source.extraHeaders
      : {},
    extraBody: source.extraBody && typeof source.extraBody === "object"
      ? source.extraBody
      : {},
  };
}

function contextFromSettings(settingsService) {
  const settings = settingsService.response(settingsService.load());
  if (!settings.projectRoot || !settings.agentId) {
    return { status: "needs-project", settings };
  }
  const agentRoot = resolveAgentDataRoot({
    dataRoot: settings.dataRoot,
    agentId: settings.agentId,
  });
  const memoryRoot = path.join(agentRoot, "memory");
  return {
    status: "ready",
    settings,
    agentRoot,
    memoryRoot,
    databasePath: path.join(memoryRoot, "memory.db"),
    configPath: path.join(memoryRoot, "config.json"),
    usageLedgerPath: settings.usageLedgerPath,
  };
}

function databaseStatus(memoryContext) {
  if (!fs.existsSync(memoryContext.databasePath)) {
    return {
      status: "missing",
      databasePath: memoryContext.databasePath,
      memories: 0,
      edges: 0,
      embeddings: 0,
      embeddingConfigured: false,
    };
  }
  const database = openMemoryDatabase(memoryContext.databasePath, { readOnly: true });
  try {
    const counts = database.prepare(`
      SELECT
        (
          SELECT COUNT(*) FROM memory_nodes
          WHERE agent_id = ? AND status = 'active'
        ) AS memories,
        (
          SELECT COUNT(*)
          FROM memory_edges AS edge
          JOIN memory_nodes AS source ON source.id = edge.from_memory_id
          JOIN memory_nodes AS target ON target.id = edge.to_memory_id
          WHERE edge.agent_id = ?
            AND source.status = 'active'
            AND target.status = 'active'
        ) AS edges,
        (
          SELECT COUNT(*) FROM memory_embeddings AS embedding
          JOIN memory_nodes AS node ON node.id = embedding.memory_id
          WHERE node.agent_id = ? AND node.status = 'active'
        ) AS embeddings
    `).get(
      memoryContext.settings.agentId,
      memoryContext.settings.agentId,
      memoryContext.settings.agentId,
    );
    const embedding = sanitizeEmbeddingConfig(
      readJson(memoryContext.configPath, {}).embedding,
    );
    return {
      status: "ready",
      databasePath: memoryContext.databasePath,
      memories: Number(counts.memories || 0),
      edges: Number(counts.edges || 0),
      embeddings: Number(counts.embeddings || 0),
      embeddingConfigured: Boolean(
        embedding.enabled
        && embedding.baseUrl
        && embedding.model
        && (embedding.apiKey || embedding.apiKeyEnv)
      ),
      embeddingModel: embedding.model,
    };
  } finally {
    database.close();
  }
}

function runtimeSessionKey(value) {
  const sessionId = clean(value);
  return sessionId ? createHash("sha256").update(sessionId).digest("hex") : "";
}

function updateRetrievalSessionHead(memoryContext, runtimeSessionId, traceId = "") {
  const sessionKey = runtimeSessionKey(runtimeSessionId);
  if (!sessionKey || !fs.existsSync(memoryContext.databasePath)) return null;
  const database = openMemoryDatabase(memoryContext.databasePath);
  try {
    return new MemoryRepository(database).setRetrievalSessionHead({
      agentId: memoryContext.settings.agentId,
      sessionId: sessionKey,
      traceId: clean(traceId),
    });
  } finally {
    database.close();
  }
}

function persistRetrievalTrace(memoryContext, trace, {
  runtimeSource,
  sessionKey = "",
} = {}) {
  const database = openMemoryDatabase(memoryContext.databasePath);
  try {
    const repository = new MemoryRepository(database);
    return repository.recordRetrievalTrace({
      ...trace,
      metadata: {
        ...(trace?.metadata && typeof trace.metadata === "object" ? trace.metadata : {}),
        runtimeSource: clean(runtimeSource) || "unspecified",
        runtimeSessionKey: clean(sessionKey),
      },
    });
  } finally {
    database.close();
  }
}

function continuationAnchors(memoryContext, {
  sessionKey,
  query,
  now,
  maximumAgeMs,
}) {
  if (!clean(sessionKey)) return resolveContinuationAnchors(query, null);
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.getTime())) return resolveContinuationAnchors(query, null);
  const database = openMemoryDatabase(memoryContext.databasePath, { readOnly: true });
  try {
    const repository = new MemoryRepository(database);
    const trace = repository.listRetrievalTraces(memoryContext.settings.agentId, { limit: 100 })
      .find((item) => (
        item.result_status === "ready"
        && item.metadata?.runtimeSessionKey === sessionKey
        && current.getTime() - Date.parse(item.created_at) >= 0
        && current.getTime() - Date.parse(item.created_at) <= maximumAgeMs
      ));
    return resolveContinuationAnchors(query, trace);
  } finally {
    database.close();
  }
}

export function createMemoryService({ settingsService, connectionResolver = null }) {
  const status = async () => {
    const memoryContext = contextFromSettings(settingsService);
    if (memoryContext.status !== "ready") {
      return {
        status: "needs-project",
        memories: 0,
        edges: 0,
        embeddings: 0,
      };
    }
    const current = databaseStatus(memoryContext);
    if (typeof connectionResolver !== "function") return current;
    try {
      const connection = await connectionResolver({
        kind: "memory-embedding",
        dataRoot: memoryContext.settings.dataRoot,
        agentId: memoryContext.settings.agentId,
      });
      if (!selectedConnection(connection)) return current;
      const embedding = embeddingConfigFromConnection(connection);
      return {
        ...current,
        embeddingConfigured: Boolean(
          embedding.enabled
          && embedding.baseUrl
          && embedding.model
          && embedding.apiKey
        ),
        embeddingModel: embedding.model,
        embeddingSource: "software-binding",
      };
    } catch {
      return current;
    }
  };

  const search = async (query, {
    persistTrace = false,
    runtimeSource = "control-center-preview",
    runtimeSessionId = "",
    now = new Date(),
    continuationMaximumAgeMs = null,
  } = {}) => {
    const memoryContext = contextFromSettings(settingsService);
    if (memoryContext.status !== "ready") throw new Error("请先选择 Agent 项目目录。");
    if (!fs.existsSync(memoryContext.databasePath)) {
      throw new Error("记忆缓存尚未建立，请先完成记忆系统设置。");
    }
    const localConfig = readJson(memoryContext.configPath, {});
    const embeddingRuntime = await resolveEmbeddingRuntime({
      connectionResolver,
      memoryContext,
      localConfig,
    });
    const sessionKey = runtimeSessionKey(runtimeSessionId);
    const configuredContinuationAge = Number(
      continuationMaximumAgeMs
      ?? localConfig.retrieval?.continuationMaximumAgeMs
      ?? 2 * 60 * 60 * 1000,
    );
    const anchorSelection = isContinuationQuery(query)
      ? continuationAnchors(memoryContext, {
        sessionKey,
        query,
        now,
        maximumAgeMs: Math.min(
          24 * 60 * 60 * 1000,
          Math.max(60_000, configuredContinuationAge || 2 * 60 * 60 * 1000),
        ),
      })
      : resolveContinuationAnchors(query, null);
    try {
      const result = await retrieveMemories({
        databasePath: memoryContext.databasePath,
        agentId: memoryContext.settings.agentId,
        query,
        anchorMemoryIds: anchorSelection.memoryIds,
        anchorSelection,
        now,
        embeddingProvider: embeddingRuntime.provider,
        usageLedgerPath: memoryContext.usageLedgerPath,
        options: localConfig.retrieval || {},
      });
      if (!persistTrace) return result;
      if (!result.trace) {
        updateRetrievalSessionHead(memoryContext, runtimeSessionId, "");
        return result;
      }
      const stored = persistRetrievalTrace(memoryContext, result.trace, {
        runtimeSource,
        sessionKey,
      });
      updateRetrievalSessionHead(
        memoryContext,
        runtimeSessionId,
        stored.result_status === "ready" && stored.selectedIds.length ? stored.id : "",
      );
      return {
        ...result,
        trace: {
          ...result.trace,
          persistedTraceId: stored.id,
        },
      };
    } catch (error) {
      if (persistTrace) {
        try {
          updateRetrievalSessionHead(memoryContext, runtimeSessionId, "");
        } catch {
          // An unavailable usage cursor must not replace the retrieval error.
        }
        try {
          persistRetrievalTrace(memoryContext, {
            agentId: memoryContext.settings.agentId,
            queryText: clean(query),
            resultStatus: "error",
            vectorStatus: "error",
            metadata: { errorName: clean(error?.name) || "Error" },
          }, { runtimeSource, sessionKey });
        } catch {
          // Trace persistence must never replace the original retrieval error.
        }
      }
      throw error;
    }
  };

  const withRepository = (callback, { readOnly = false } = {}) => {
    const memoryContext = contextFromSettings(settingsService);
    if (memoryContext.status !== "ready") throw new Error("请先选择 Agent 项目目录。");
    if (!fs.existsSync(memoryContext.databasePath)) {
      throw new Error("记忆缓存尚未建立，请先完成记忆系统设置。");
    }
    if (readOnly) {
      const migrationDatabase = openMemoryDatabase(memoryContext.databasePath);
      migrationDatabase.close();
    }
    const database = openMemoryDatabase(memoryContext.databasePath, { readOnly });
    try {
      return callback({
        database,
        memoryContext,
        repository: new MemoryRepository(database),
      });
    } finally {
      database.close();
    }
  };

  const clearRetrievalSessionHead = (runtimeSessionId) => {
    const memoryContext = contextFromSettings(settingsService);
    if (memoryContext.status !== "ready" || !fs.existsSync(memoryContext.databasePath)) return null;
    return updateRetrievalSessionHead(memoryContext, runtimeSessionId, "");
  };

  const bindRetrievalUsageResponse = ({
    runtimeSessionId,
    responseText,
  } = {}) => withRepository(({ repository, memoryContext }) => {
    const sessionKey = runtimeSessionKey(runtimeSessionId);
    if (!sessionKey || !clean(responseText)) return null;
    return repository.bindRetrievalUsageResponse({
      agentId: memoryContext.settings.agentId,
      sessionId: sessionKey,
      responseText,
      metadata: { source: "claude-stop-hook" },
    });
  });

  const list = (filters = {}) => withRepository(
    ({ repository, memoryContext }) => repository.listMemories(
      memoryContext.settings.agentId,
      filters,
    ),
    { readOnly: true },
  );

  const detail = (memoryId) => withRepository(
    ({ repository, memoryContext }) => {
      const result = repository.getMemoryDetail(
        memoryContext.settings.agentId,
        clean(memoryId),
      );
      if (!result) throw new Error("没有找到这条记忆。");
      return result;
    },
    { readOnly: true },
  );

  const brainGraph = () => withRepository(
    ({ repository, memoryContext }) => createBrainSnapshot({
      repository,
      agentId: memoryContext.settings.agentId,
      cachePath: path.join(memoryContext.memoryRoot, "brain-layout.json"),
    }),
    { readOnly: true },
  );

  const edit = async (memoryId, patch = {}, reason = "") => {
    const normalizedMemoryId = clean(memoryId);
    const updated = withRepository(({ repository, memoryContext }) => {
      const memory = repository.editMemoryManually({
        agentId: memoryContext.settings.agentId,
        memoryId: normalizedMemoryId,
        patch,
        actor: "human:control-center",
        reason,
      });
      const associations = memory.status === "active"
        ? updateAssociationGraph({
          repository,
          agentId: memoryContext.settings.agentId,
          memoryIds: [normalizedMemoryId],
        })
        : { status: "skipped", totalEdges: 0 };
      return { associations, memory, memoryContext };
    });

    const localConfig = readJson(updated.memoryContext.configPath, {});
    let embeddingResult = { status: "disabled" };
    const warnings = [];
    if (updated.memory.status === "active") {
      try {
        const embeddingRuntime = await resolveEmbeddingRuntime({
          connectionResolver,
          memoryContext: updated.memoryContext,
          localConfig,
        });
        if (embeddingRuntime.provider) {
          const input = [updated.memory.title, updated.memory.content].filter(Boolean).join("\n");
          const response = await embeddingRuntime.provider(input);
          const associationUpdate = withRepository(({ repository, memoryContext }) => {
            repository.upsertEmbedding({
              memoryId: normalizedMemoryId,
              model: response.model || embeddingRuntime.config.model,
              vector: response.vector,
              contentHash: createHash("sha256").update(input).digest("hex"),
            });
            return updateAssociationGraph({
              repository,
              agentId: memoryContext.settings.agentId,
              memoryIds: [normalizedMemoryId],
            });
          });
          embeddingResult = {
            status: "updated",
            model: response.model || embeddingRuntime.config.model,
            dimensions: response.vector.length,
          };
          updated.associations = associationUpdate;
          if (updated.memoryContext.usageLedgerPath && response.usage) {
            try {
              await appendUsageEvent(updated.memoryContext.usageLedgerPath, {
                timestamp: new Date().toISOString(),
                agentId: updated.memoryContext.settings.agentId,
                provider: response.metadata?.provider || "",
                model: response.model || embeddingRuntime.config.model,
                source: "memory-editor",
                feature: "memory-edit-embedding",
                requestId: response.requestId || "",
                usage: response.usage,
                metadata: response.metadata || {},
              });
            } catch (error) {
              warnings.push(`向量费用流水写入失败：${error.message}`);
            }
          }
        }
      } catch (error) {
        embeddingResult = {
          status: "error",
          error: error.message,
        };
        warnings.push(`新向量生成失败，已保留文本修改并退回词面检索：${error.message}`);
      }
    }
    return {
      status: "updated",
      memory: updated.memory,
      associations: updated.associations,
      embedding: embeddingResult,
      embeddingInvalidated: embeddingResult.status !== "updated",
      warnings,
    };
  };

  const remove = (memoryId, reason = "") => withRepository(({
    repository,
    memoryContext,
  }) => ({
    status: "deleted",
    memory: repository.setMemoryDeleted({
      agentId: memoryContext.settings.agentId,
      memoryId: clean(memoryId),
      deleted: true,
      actor: "human:control-center",
      reason,
    }),
  }));

  const restore = (memoryId, reason = "") => withRepository(({
    repository,
    memoryContext,
  }) => {
    const normalizedMemoryId = clean(memoryId);
    const memory = repository.setMemoryDeleted({
      agentId: memoryContext.settings.agentId,
      memoryId: normalizedMemoryId,
      deleted: false,
      actor: "human:control-center",
      reason,
    });
    const associations = updateAssociationGraph({
      repository,
      agentId: memoryContext.settings.agentId,
      memoryIds: [normalizedMemoryId],
    });
    return {
      status: "restored",
      memory,
      associations,
    };
  });

  const structureProposals = (filters = {}) => withRepository(
    ({ repository, memoryContext }) => repository.listStructureProposals(
      memoryContext.settings.agentId,
      filters && typeof filters === "object" ? filters : {},
    ).map((proposal) => {
      const memberIds = Array.isArray(proposal.memberIds) ? proposal.memberIds : [];
      const members = memberIds.map((memoryId) => {
        const detail = repository.getMemoryDetail(memoryContext.settings.agentId, memoryId);
        if (!detail?.memory) return null;
        return {
          id: detail.memory.id,
          title: detail.memory.title,
          content: boundedText(detail.memory.content, 1800),
          kind: detail.memory.kind,
          status: detail.memory.status,
          subjectRole: detail.memory.subject_role,
          subjectKey: detail.memory.subject_key,
          eventDate: detail.memory.event_date,
          eventStart: detail.memory.event_start,
          eventEnd: detail.memory.event_end,
          actorRoles: detail.roles.map((role) => ({
            role: role.role,
            actorRole: role.actor_role,
            actorKey: role.actor_key,
            isPrimary: Boolean(role.is_primary),
          })),
          evidenceSources: detail.sources.slice(0, 6).map((source) => ({
            id: source.id,
            kind: source.source_kind,
            speaker: clean(source.speaker),
            occurredAt: source.occurred_at,
            knownAt: source.known_at,
            content: boundedText(source.content, 900),
          })),
        };
      }).filter(Boolean);
      const targetDetail = proposal.targetMemoryId
        ? repository.getMemoryDetail(memoryContext.settings.agentId, proposal.targetMemoryId)
        : null;
      const timedMembers = members.filter((memory) => memory.eventDate || memory.eventStart).length;
      const distinctDates = new Set(members.map((memory) => (
        memory.eventDate || clean(memory.eventStart).slice(0, 10)
      )).filter(Boolean)).size;
      return {
        ...proposal,
        target: targetDetail?.memory ? {
          id: targetDetail.memory.id,
          title: targetDetail.memory.title,
          content: boundedText(targetDetail.memory.content, 1800),
          kind: targetDetail.memory.kind,
          status: targetDetail.memory.status,
        } : null,
        members,
        validation: [
          `${proposal.operation === "attach" ? "挂接" : "创建"} ${proposal.kind}`,
          `${members.length}/${memberIds.length} 个成员当前可读取`,
          proposal.kind === "episode"
            ? `${timedMembers} 个成员带有发生时间`
            : `${distinctDates} 个不同日期提供主题证据`,
          ...(proposal.operation === "attach"
            ? [targetDetail?.memory ? "目标容器存在" : "目标容器当前不可用"]
            : []),
        ],
      };
    }),
    { readOnly: true },
  );

  const resolveStructure = ({
    proposalId,
    action,
    note = "",
  } = {}) => withRepository(({ repository, memoryContext }) => (
    resolveMemoryStructureProposal(repository, {
      agentId: memoryContext.settings.agentId,
      proposalId: clean(proposalId),
      action: clean(action),
      resolvedBy: "human:control-center",
      note: clean(note),
    })
  ));

  const subjectAttributionProposals = (filters = {}) => withRepository(({
    repository,
    memoryContext,
  }) => repository.listSubjectAttributionProposals(
    memoryContext.settings.agentId,
    filters && typeof filters === "object" ? filters : {},
  ).map((proposal) => {
    const detail = repository.getMemoryDetail(
      memoryContext.settings.agentId,
      proposal.memory_id,
    );
    const citedSourceIds = new Set(proposal.sourceIds);
    return {
      ...proposal,
      memory: detail?.memory ? {
        id: detail.memory.id,
        title: detail.memory.title,
        content: boundedText(detail.memory.content, 4000),
        kind: detail.memory.kind,
        status: detail.memory.status,
        subjectRole: detail.memory.subject_role,
        subjectKey: detail.memory.subject_key,
        eventDate: detail.memory.event_date,
        eventStart: detail.memory.event_start,
        eventEnd: detail.memory.event_end,
      } : null,
      evidenceSources: (detail?.sources || [])
        .filter((source) => citedSourceIds.has(source.id))
        .map((source) => ({
          id: source.id,
          kind: source.source_kind,
          speaker: clean(source.speaker),
          occurredAt: source.occurred_at,
          knownAt: source.known_at,
          content: boundedText(source.content),
        })),
    };
  }), { readOnly: true });

  const resolveSubjectAttribution = ({
    proposalId,
    action,
    note = "",
  } = {}) => withRepository(({ repository, memoryContext }) => {
    const result = resolveMemorySubjectAttribution(repository, {
      agentId: memoryContext.settings.agentId,
      proposalId: clean(proposalId),
      action: clean(action),
      resolvedBy: "human:control-center",
      note: clean(note),
    });
    if (result.status !== "accepted" || !result.memory) return result;
    return {
      ...result,
      associations: updateAssociationGraph({
        repository,
        agentId: memoryContext.settings.agentId,
        memoryIds: [result.memory.id],
      }),
    };
  });

  const retrievalTraces = (filters = {}) => withRepository(
    ({ repository, memoryContext }) => repository.listRetrievalTraces(
      memoryContext.settings.agentId,
      filters && typeof filters === "object" ? filters : {},
    ),
    { readOnly: true },
  );

  const recordRetrievalFeedback = ({
    traceId,
    signal,
    targetMemoryIds = [],
    note = "",
  } = {}) => withRepository(({ repository, memoryContext }) => (
    repository.recordRetrievalFeedback({
      agentId: memoryContext.settings.agentId,
      traceId: clean(traceId),
      signal: clean(signal),
      targetMemoryIds: Array.isArray(targetMemoryIds) ? targetMemoryIds : [],
      note: clean(note),
      metadata: { source: "human:control-center" },
    })
  ));

  const memoryRetrievalStats = (filters = {}) => withRepository(
    ({ repository, memoryContext }) => repository.listMemoryRetrievalStats(
      memoryContext.settings.agentId,
      filters && typeof filters === "object" ? filters : {},
    ),
    { readOnly: true },
  );

  const edgeRetrievalStats = (filters = {}) => withRepository(
    ({ repository, memoryContext }) => repository.listEdgeRetrievalStats(
      memoryContext.settings.agentId,
      filters && typeof filters === "object" ? filters : {},
    ),
    { readOnly: true },
  );

  const plasticityPreview = (filters = {}) => withRepository(({
    repository,
    memoryContext,
  }) => {
    const normalized = filters && typeof filters === "object" ? filters : {};
    const memoryStats = repository.listMemoryRetrievalStats(
      memoryContext.settings.agentId,
      {
        memoryIds: Array.isArray(normalized.memoryIds) ? normalized.memoryIds : [],
        limit: normalized.limit,
      },
    );
    const edgeStats = repository.listEdgeRetrievalStats(
      memoryContext.settings.agentId,
      {
        edgeIds: Array.isArray(normalized.edgeIds) ? normalized.edgeIds : [],
        limit: normalized.limit,
      },
    );
    return {
      automaticAdjustmentAllowed: false,
      memories: memoryStats.map(previewMemoryPlasticity),
      edges: edgeStats.map(previewEdgePlasticity),
    };
  }, { readOnly: true });

  return {
    bindRetrievalUsageResponse,
    brainGraph,
    clearRetrievalSessionHead,
    detail,
    edit,
    edgeRetrievalStats,
    list,
    memoryRetrievalStats,
    plasticityPreview,
    remove,
    recordRetrievalFeedback,
    retrievalTraces,
    restore,
    resolveSubjectAttribution,
    resolveStructure,
    search,
    status,
    structureProposals,
    subjectAttributionProposals,
  };
}

function selectedConnection(value) {
  if (!value || typeof value !== "object") return false;
  return Boolean(
    clean(value.id)
    || clean(value.name)
    || clean(value.baseUrl)
    || clean(value.model)
    || clean(value.apiKey || value.key)
    || !["", "none"].includes(clean(value.source).toLowerCase()),
  );
}

function embeddingConfigFromConnection(connection) {
  const type = clean(connection?.type).toLowerCase();
  let baseUrl = clean(connection?.baseUrl).replace(/\/+$/u, "");
  if (type === "dashscope") {
    baseUrl = baseUrl.replace(/\/api\/v1$/u, "/compatible-mode/v1");
  }
  return sanitizeEmbeddingConfig({
    enabled: true,
    baseUrl,
    apiKey: clean(connection?.apiKey || connection?.key),
    model: clean(connection?.model) || (type === "dashscope" ? "text-embedding-v4" : ""),
    dimensions: 1024,
    timeoutMs: Number(connection?.timeoutMs) || 30_000,
    extraBody: { encoding_format: "float" },
  });
}

async function resolveEmbeddingRuntime({ connectionResolver, memoryContext, localConfig }) {
  if (typeof connectionResolver === "function") {
    const connection = await connectionResolver({
      kind: "memory-embedding",
      dataRoot: memoryContext.settings.dataRoot,
      agentId: memoryContext.settings.agentId,
    });
    if (selectedConnection(connection)) {
      const config = embeddingConfigFromConnection(connection);
      return {
        config,
        provider: createOpenAiCompatibleEmbeddingProvider(config),
        source: "software-binding",
      };
    }
  }
  const config = sanitizeEmbeddingConfig(localConfig?.embedding);
  if (!(config.enabled && config.baseUrl && config.model && (config.apiKey || config.apiKeyEnv))) {
    return { config, provider: null, source: "disabled" };
  }
  return {
    config,
    provider: createOpenAiCompatibleEmbeddingProvider(config),
    source: "agent-config-fallback",
  };
}
