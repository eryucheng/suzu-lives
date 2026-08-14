import { isStatefulMemoryKind } from "./ontology.mjs";

const DEFAULT_OPTIONS = Object.freeze({
  provenance: "association-builder-v1",
  minimumAssociationSimilarity: 0.68,
  strongAssociationSimilarity: 0.82,
  minimumAssociationLexicalSimilarity: 0.08,
  minimumTimelineSimilarity: 0.62,
  minimumTimelineLexicalSimilarity: 0.12,
  maximumAssociationsPerNode: 3,
  maximumTimelineGapDays: 7,
  maximumTermDocumentRatio: 0.12,
});

function clean(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().trim();
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function decodeVector(row) {
  return new Float32Array(
    row.vector.buffer.slice(
      row.vector.byteOffset,
      row.vector.byteOffset + row.vector.byteLength,
    ),
  );
}

function dot(left, right) {
  if (!left || !right || left.length !== right.length) return Number.NEGATIVE_INFINITY;
  let value = 0;
  for (let index = 0; index < left.length; index += 1) value += left[index] * right[index];
  return value;
}

const GENERIC_TERMS = new Set([
  "用户", "对方", "agent", "我们", "记得", "事情", "事件", "当时", "之后", "后来",
  "一次", "一个", "这个", "那个", "自己", "已经", "没有", "还是",
]);

function lexicalTerms(value) {
  const text = clean(value);
  const terms = new Set();
  for (const match of text.matchAll(/[\p{Script=Han}]+/gu)) {
    const sequence = match[0];
    for (const width of [2, 3, 4]) {
      for (let index = 0; index + width <= sequence.length; index += 1) {
        const term = sequence.slice(index, index + width);
        if (!GENERIC_TERMS.has(term)) terms.add(term);
      }
    }
  }
  for (const match of text.matchAll(/[a-z0-9][a-z0-9_.-]{1,}/gu)) {
    if (!GENERIC_TERMS.has(match[0])) terms.add(match[0]);
  }
  return terms;
}

function lexicalSimilarity(left, right) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const term of left) {
    if (right.has(term)) intersection += 1;
  }
  if (!intersection) return 0;
  return intersection / Math.sqrt(left.size * right.size);
}

function dateOnlyTime(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value || ""))) return Number.NaN;
  return Date.parse(`${value}T00:00:00.000Z`);
}

function orderingTime(node) {
  const stateful = isStatefulMemoryKind(node.kind);
  const eventDateTime = dateOnlyTime(node.event_date);
  for (const value of [
    stateful ? node.valid_from : "",
    node.event_start,
    Number.isFinite(eventDateTime)
      ? new Date(eventDateTime).toISOString()
      : "",
    node.known_at,
    node.recorded_at,
  ]) {
    const timestamp = Date.parse(value || "");
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return Number.NaN;
}

function eventTime(node) {
  const sourceTime = Date.parse(node.event_start || "");
  if (Number.isFinite(sourceTime)) return sourceTime;
  return dateOnlyTime(node.event_date);
}

function automaticThreadKey(node) {
  if (isStatefulMemoryKind(node.kind) || !Number.isFinite(node.eventTime)) return "";
  return clean(node.canonical_key);
}

function buildThreadAssociations(nodes, seedIds = null) {
  const groups = new Map();
  for (const node of nodes) {
    const canonicalKey = automaticThreadKey(node);
    if (!canonicalKey) continue;
    const members = groups.get(canonicalKey) || [];
    members.push(node);
    groups.set(canonicalKey, members);
  }
  const selectedSeeds = seedIds ? new Set(seedIds) : null;
  const affectedMemoryIds = new Set();
  const edges = new Map();
  for (const [canonicalKey, members] of groups) {
    if (selectedSeeds && !members.some((node) => selectedSeeds.has(node.id))) continue;
    members.sort((left, right) => (
      left.eventTime - right.eventTime
      || left.id.localeCompare(right.id)
    ));
    for (const member of members) affectedMemoryIds.add(member.id);
    for (let index = 1; index < members.length; index += 1) {
      const fromMemoryId = members[index - 1].id;
      const toMemoryId = members[index].id;
      edges.set(`${fromMemoryId}\u001f${toMemoryId}`, {
        fromMemoryId,
        toMemoryId,
        canonicalKey,
      });
    }
  }
  return { edges, affectedMemoryIds };
}

function pairKey(leftId, rightId) {
  return leftId < rightId ? `${leftId}\u001f${rightId}` : `${rightId}\u001f${leftId}`;
}

function orderedPair(leftId, rightId) {
  return leftId < rightId ? [leftId, rightId] : [rightId, leftId];
}

function pairSimilarity(left, right) {
  const commonModels = [...left.vectors.keys()].filter((model) => right.vectors.has(model));
  let vector = Number.NEGATIVE_INFINITY;
  for (const model of commonModels) {
    vector = Math.max(vector, dot(left.vectors.get(model), right.vectors.get(model)));
  }
  const lexical = lexicalSimilarity(left.terms, right.terms);
  const combined = Number.isFinite(vector)
    ? Math.max(vector, vector * 0.9 + lexical * 0.1)
    : lexical;
  return { vector, lexical, combined };
}

function edgeWeight(similarity, threshold) {
  if (!Number.isFinite(similarity)) return 0;
  return Math.min(1, 0.65 + Math.max(0, similarity - threshold) / Math.max(0.01, 1 - threshold) * 0.35);
}

function automaticSemanticEligible(node) {
  return Boolean(node) && !isStatefulMemoryKind(node.kind);
}

function associationEligible(left, right, similarity, options) {
  return automaticSemanticEligible(left)
    && automaticSemanticEligible(right)
    && similarity.combined >= options.minimumAssociationSimilarity
    && (
      similarity.lexical >= options.minimumAssociationLexicalSimilarity
      || similarity.vector >= options.strongAssociationSimilarity
    );
}

function associationPriority(candidate, options) {
  if (candidate.similarity) {
    const weight = edgeWeight(
      candidate.similarity.combined,
      options.minimumAssociationSimilarity,
    );
    return weight * Math.max(0, Math.min(1, candidate.similarity.combined));
  }
  return Math.max(0, Number(candidate.weight || 0))
    * Math.max(0, Number(candidate.confidence || 0));
}

function selectAssociationBudget(candidates, options) {
  const maximumDegree = Math.max(0, Math.floor(Number(options.maximumAssociationsPerNode)));
  const degrees = new Map();
  if (!maximumDegree) return [];
  return [...candidates]
    .sort((left, right) => (
      associationPriority(right, options) - associationPriority(left, options)
      || right.similarity?.lexical - left.similarity?.lexical
      || right.similarity?.combined - left.similarity?.combined
      || left.fromMemoryId.localeCompare(right.fromMemoryId)
      || left.toMemoryId.localeCompare(right.toMemoryId)
    ))
    .filter((candidate) => {
      const fromDegree = degrees.get(candidate.fromMemoryId) || 0;
      const toDegree = degrees.get(candidate.toMemoryId) || 0;
      if (fromDegree >= maximumDegree || toDegree >= maximumDegree) return false;
      degrees.set(candidate.fromMemoryId, fromDegree + 1);
      degrees.set(candidate.toMemoryId, toDegree + 1);
      return true;
    });
}

function loadAssociationNodes(repository, agentId, options) {
  const rows = repository.database.prepare(`
    SELECT *
    FROM memory_nodes
    WHERE agent_id = ? AND status = 'active'
      AND kind NOT IN ('utterance', 'episode', 'topic', 'topic_or_episode')
    ORDER BY recorded_at ASC, id ASC
  `).all(agentId);
  const nodes = rows.map((row) => ({
    ...row,
    metadata: parseJson(row.metadata_json, {}),
    terms: lexicalTerms(`${row.title || ""}\n${row.content || ""}`),
    vectors: new Map(),
    eventTime: eventTime(row),
    orderingTime: orderingTime(row),
  }));
  const documentFrequency = new Map();
  for (const node of nodes) {
    for (const term of node.terms) {
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }
  const maximumDocuments = Math.max(
    3,
    Math.floor(nodes.length * Number(options.maximumTermDocumentRatio)),
  );
  for (const node of nodes) {
    node.terms = new Set(
      [...node.terms].filter((term) => documentFrequency.get(term) <= maximumDocuments),
    );
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const embeddings = repository.database.prepare(`
    SELECT embedding.memory_id, embedding.model, embedding.dimensions, embedding.vector
    FROM memory_embeddings AS embedding
    JOIN memory_nodes AS node ON node.id = embedding.memory_id
    WHERE node.agent_id = ? AND node.status = 'active'
      AND node.kind NOT IN ('utterance', 'episode', 'topic', 'topic_or_episode')
  `).all(agentId);
  for (const row of embeddings) {
    const node = byId.get(row.memory_id);
    if (node) node.vectors.set(row.model, decodeVector(row));
  }
  return nodes;
}

function entityAssociations(repository, agentId, nodes, seedIds = null) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const groups = new Map();
  for (const row of repository.database.prepare(`
    SELECT link.memory_id, link.entity_id, GROUP_CONCAT(link.role, ',') AS role,
      entity.kind AS entity_kind, entity.canonical_name
    FROM memory_entities AS link
    JOIN entities AS entity ON entity.id = link.entity_id
    JOIN memory_nodes AS memory ON memory.id = link.memory_id
    WHERE entity.agent_id = ? AND memory.agent_id = ? AND memory.status = 'active'
    GROUP BY link.memory_id, link.entity_id, entity.kind, entity.canonical_name
    ORDER BY link.entity_id ASC, memory.recorded_at ASC, link.memory_id ASC
  `).all(agentId, agentId)) {
    if (!byId.has(row.memory_id)) continue;
    const values = groups.get(row.entity_id) || [];
    values.push(row);
    groups.set(row.entity_id, values);
  }
  const selectedSeeds = seedIds ? new Set(seedIds) : null;
  const edges = new Map();
  const addEdge = (left, right, entity) => {
    const [fromMemoryId, toMemoryId] = orderedPair(left.memory_id, right.memory_id);
    const key = pairKey(fromMemoryId, toMemoryId);
    const current = edges.get(key) || { fromMemoryId, toMemoryId, entities: [] };
    const from = left.memory_id === fromMemoryId ? left : right;
    const to = left.memory_id === toMemoryId ? left : right;
    current.entities.push({
      entityId: entity.entity_id,
      kind: entity.entity_kind,
      canonicalName: entity.canonical_name,
      fromRole: from.role,
      toRole: to.role,
    });
    edges.set(key, current);
  };
  for (const members of groups.values()) {
    members.sort((left, right) => {
      const leftNode = byId.get(left.memory_id);
      const rightNode = byId.get(right.memory_id);
      const leftTime = Number.isFinite(leftNode.orderingTime)
        ? leftNode.orderingTime
        : Number.POSITIVE_INFINITY;
      const rightTime = Number.isFinite(rightNode.orderingTime)
        ? rightNode.orderingTime
        : Number.POSITIVE_INFINITY;
      return leftTime - rightTime || left.memory_id.localeCompare(right.memory_id);
    });
    if (!selectedSeeds) {
      for (let index = 1; index < members.length; index += 1) {
        addEdge(members[index - 1], members[index], members[index]);
      }
      continue;
    }
    for (let index = 0; index < members.length; index += 1) {
      if (!selectedSeeds.has(members[index].memory_id)) continue;
      if (index > 0) addEdge(members[index - 1], members[index], members[index]);
      if (index < members.length - 1) addEdge(members[index], members[index + 1], members[index]);
    }
  }
  return [...edges.values()];
}

export function rebuildAssociationGraph({
  repository,
  agentId,
  options: overrides = {},
} = {}) {
  if (!repository) throw new Error("rebuildAssociationGraph 需要 repository。");
  const normalizedAgentId = String(agentId || "").trim();
  if (!normalizedAgentId) throw new Error("rebuildAssociationGraph 需要 agentId。");
  const options = { ...DEFAULT_OPTIONS, ...overrides };
  const nodes = loadAssociationNodes(repository, normalizedAgentId, options);
  const associationCandidates = [];
  const neighbors = new Map(nodes.map((node) => [node.id, []]));
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const left = nodes[leftIndex];
      const right = nodes[rightIndex];
      const similarity = pairSimilarity(left, right);
      neighbors.get(left.id).push({ node: right, ...similarity });
      neighbors.get(right.id).push({ node: left, ...similarity });
      if (associationEligible(left, right, similarity, options)) {
        const [fromMemoryId, toMemoryId] = orderedPair(left.id, right.id);
        associationCandidates.push({ fromMemoryId, toMemoryId, similarity });
      }
    }
  }

  const associations = selectAssociationBudget(associationCandidates, options);

  const timelines = [];
  for (const node of nodes) {
    if (!automaticSemanticEligible(node) || !Number.isFinite(node.eventTime)) continue;
    const later = neighbors.get(node.id)
      .filter((candidate) => (
        automaticSemanticEligible(candidate.node)
        && Number.isFinite(candidate.node.eventTime)
        && candidate.node.eventTime > node.eventTime
        && candidate.combined >= options.minimumTimelineSimilarity
        && candidate.lexical >= options.minimumTimelineLexicalSimilarity
      ))
      .map((candidate) => {
        const gapDays = (candidate.node.eventTime - node.eventTime) / 86_400_000;
        const proximity = Math.max(0, 1 - gapDays / Math.max(1, options.maximumTimelineGapDays));
        return {
          ...candidate,
          gapDays,
          timelineScore: candidate.combined * 0.85 + proximity * 0.15,
        };
      })
      .filter((candidate) => candidate.gapDays <= options.maximumTimelineGapDays)
      .sort((left, right) => right.timelineScore - left.timelineScore);
    if (later.length) {
      timelines.push({
        fromMemoryId: node.id,
        toMemoryId: later[0].node.id,
        similarity: later[0],
      });
    }
  }

  const threads = buildThreadAssociations(nodes);
  const sharedEntities = entityAssociations(repository, normalizedAgentId, nodes);

  let associationEdges = 0;
  let timelineEdges = 0;
  let threadEdges = 0;
  let entityEdges = 0;
  repository.transaction(() => {
    repository.database.prepare(`
      DELETE FROM memory_edges WHERE agent_id = ? AND provenance = ?
    `).run(normalizedAgentId, options.provenance);
    for (const value of associations) {
      repository.upsertEdge({
        agentId: normalizedAgentId,
        fromMemoryId: value.fromMemoryId,
        toMemoryId: value.toMemoryId,
        relation: "associated_with",
        direction: "undirected",
        weight: edgeWeight(value.similarity.combined, options.minimumAssociationSimilarity),
        confidence: Math.max(0, Math.min(1, value.similarity.combined)),
        provenance: options.provenance,
        metadata: {
          vectorSimilarity: Number.isFinite(value.similarity.vector)
            ? value.similarity.vector
            : null,
          lexicalSimilarity: value.similarity.lexical,
        },
      });
      associationEdges += 1;
    }
    for (const value of timelines) {
      repository.upsertEdge({
        agentId: normalizedAgentId,
        fromMemoryId: value.fromMemoryId,
        toMemoryId: value.toMemoryId,
        relation: "timeline_next",
        direction: "directed",
        weight: edgeWeight(value.similarity.combined, options.minimumTimelineSimilarity),
        confidence: Math.max(0, Math.min(1, value.similarity.combined)),
        provenance: options.provenance,
        metadata: {
          gapDays: value.similarity.gapDays,
          vectorSimilarity: Number.isFinite(value.similarity.vector)
            ? value.similarity.vector
            : null,
          lexicalSimilarity: value.similarity.lexical,
        },
      });
      timelineEdges += 1;
    }
    for (const value of threads.edges.values()) {
      repository.upsertEdge({
        agentId: normalizedAgentId,
        fromMemoryId: value.fromMemoryId,
        toMemoryId: value.toMemoryId,
        relation: "same_thread",
        direction: "directed",
        weight: 1,
        confidence: 1,
        provenance: options.provenance,
        metadata: { canonicalKey: value.canonicalKey },
      });
      threadEdges += 1;
    }
    for (const value of sharedEntities) {
      repository.upsertEdge({
        agentId: normalizedAgentId,
        fromMemoryId: value.fromMemoryId,
        toMemoryId: value.toMemoryId,
        relation: "shares_entity",
        direction: "undirected",
        weight: 0.9,
        confidence: 1,
        provenance: options.provenance,
        metadata: { entities: value.entities },
      });
      entityEdges += 1;
    }
  });

  return {
    status: "completed",
    memoriesConsidered: nodes.length,
    associationEdges,
    prunedAssociationEdges: 0,
    timelineEdges,
    threadEdges,
    entityEdges,
    totalEdges: associationEdges + timelineEdges + threadEdges + entityEdges,
    provenance: options.provenance,
  };
}

export function updateAssociationGraph({
  repository,
  agentId,
  memoryIds = [],
  options: overrides = {},
} = {}) {
  if (!repository) throw new Error("updateAssociationGraph 需要 repository。");
  const normalizedAgentId = String(agentId || "").trim();
  if (!normalizedAgentId) throw new Error("updateAssociationGraph 需要 agentId。");
  const requestedIds = new Set(memoryIds.map(String).map((value) => value.trim()).filter(Boolean));
  const options = { ...DEFAULT_OPTIONS, ...overrides };
  const nodes = loadAssociationNodes(repository, normalizedAgentId, options);
  const seeds = nodes.filter((node) => requestedIds.has(node.id));
  if (!seeds.length) {
    return {
      status: "skipped",
      memoriesConsidered: 0,
      associationEdges: 0,
      prunedAssociationEdges: 0,
      timelineEdges: 0,
      threadEdges: 0,
      entityEdges: 0,
      totalEdges: 0,
      provenance: options.provenance,
    };
  }
  const associationCandidates = new Map();
  const timelines = new Map();
  const threads = buildThreadAssociations(nodes, seeds.map((node) => node.id));
  for (const seed of seeds) {
    const candidates = nodes
      .filter((node) => node.id !== seed.id)
      .map((node) => ({ node, ...pairSimilarity(seed, node) }));
    const associated = candidates.filter((candidate) => associationEligible(
      seed,
      candidate.node,
      candidate,
      options,
    ));
    for (const candidate of associated) {
      const [fromMemoryId, toMemoryId] = orderedPair(seed.id, candidate.node.id);
      associationCandidates.set(pairKey(fromMemoryId, toMemoryId), {
        fromMemoryId,
        toMemoryId,
        similarity: candidate,
      });
    }
    if (automaticSemanticEligible(seed) && Number.isFinite(seed.eventTime)) {
      const timelineCandidates = candidates
        .filter((candidate) => (
          automaticSemanticEligible(candidate.node)
          && Number.isFinite(candidate.node.eventTime)
          && candidate.combined >= options.minimumTimelineSimilarity
          && candidate.lexical >= options.minimumTimelineLexicalSimilarity
        ))
        .map((candidate) => {
          const gapDays = Math.abs(candidate.node.eventTime - seed.eventTime) / 86_400_000;
          const proximity = Math.max(0, 1 - gapDays / Math.max(1, options.maximumTimelineGapDays));
          return {
            ...candidate,
            gapDays,
            timelineScore: candidate.combined * 0.85 + proximity * 0.15,
          };
        })
        .filter((candidate) => candidate.gapDays <= options.maximumTimelineGapDays);
      for (const direction of ["earlier", "later"]) {
        const selected = timelineCandidates
          .filter((candidate) => direction === "earlier"
            ? candidate.node.eventTime < seed.eventTime
            : candidate.node.eventTime > seed.eventTime)
          .sort((left, right) => right.timelineScore - left.timelineScore)[0];
        if (!selected) continue;
        const fromMemoryId = direction === "earlier" ? selected.node.id : seed.id;
        const toMemoryId = direction === "earlier" ? seed.id : selected.node.id;
        timelines.set(`${fromMemoryId}\u001f${toMemoryId}`, {
          fromMemoryId,
          toMemoryId,
          similarity: selected,
        });
      }
    }
  }
  const sharedEntities = entityAssociations(
    repository,
    normalizedAgentId,
    nodes,
  );

  const placeholders = seeds.map(() => "?").join(", ");
  const eligibleAssociationNodeIds = new Set(
    nodes.filter(automaticSemanticEligible).map((node) => node.id),
  );
  let associations = [];
  let prunedAssociationEdges = 0;
  repository.transaction(() => {
    repository.database.prepare(`
      DELETE FROM memory_edges
      WHERE agent_id = ? AND provenance = ?
        AND (
          from_memory_id IN (${placeholders})
          OR to_memory_id IN (${placeholders})
        )
    `).run(
      normalizedAgentId,
      options.provenance,
      ...seeds.map((node) => node.id),
      ...seeds.map((node) => node.id),
    );
    repository.database.prepare(`
      DELETE FROM memory_edges
      WHERE agent_id = ? AND provenance = ? AND relation = 'shares_entity'
    `).run(normalizedAgentId, options.provenance);
    const existingAssociations = repository.database.prepare(`
      SELECT *
      FROM memory_edges
      WHERE agent_id = ? AND provenance = ? AND relation = 'associated_with'
    `).all(normalizedAgentId, options.provenance);
    const budgetCandidates = new Map();
    for (const edge of existingAssociations) {
      if (
        !eligibleAssociationNodeIds.has(edge.from_memory_id)
        || !eligibleAssociationNodeIds.has(edge.to_memory_id)
      ) continue;
      budgetCandidates.set(pairKey(edge.from_memory_id, edge.to_memory_id), {
        existingEdgeId: edge.id,
        fromMemoryId: edge.from_memory_id,
        toMemoryId: edge.to_memory_id,
        weight: edge.weight,
        confidence: edge.confidence,
      });
    }
    for (const [key, candidate] of associationCandidates) {
      budgetCandidates.set(key, candidate);
    }
    const selectedBudget = selectAssociationBudget(budgetCandidates.values(), options);
    const retainedExistingIds = new Set(
      selectedBudget.map((candidate) => candidate.existingEdgeId).filter(Boolean),
    );
    for (const edge of existingAssociations) {
      if (retainedExistingIds.has(edge.id)) continue;
      repository.database.prepare("DELETE FROM memory_edges WHERE id = ?").run(edge.id);
      prunedAssociationEdges += 1;
    }
    associations = selectedBudget.filter((candidate) => !candidate.existingEdgeId);
    if (threads.affectedMemoryIds.size) {
      const threadMemoryIds = [...threads.affectedMemoryIds];
      const threadPlaceholders = threadMemoryIds.map(() => "?").join(", ");
      repository.database.prepare(`
        DELETE FROM memory_edges
        WHERE agent_id = ? AND provenance = ? AND relation = 'same_thread'
          AND (
            from_memory_id IN (${threadPlaceholders})
            OR to_memory_id IN (${threadPlaceholders})
          )
      `).run(
        normalizedAgentId,
        options.provenance,
        ...threadMemoryIds,
        ...threadMemoryIds,
      );
    }
    for (const value of associations) {
      repository.upsertEdge({
        agentId: normalizedAgentId,
        fromMemoryId: value.fromMemoryId,
        toMemoryId: value.toMemoryId,
        relation: "associated_with",
        direction: "undirected",
        weight: edgeWeight(value.similarity.combined, options.minimumAssociationSimilarity),
        confidence: Math.max(0, Math.min(1, value.similarity.combined)),
        provenance: options.provenance,
        metadata: {
          vectorSimilarity: Number.isFinite(value.similarity.vector)
            ? value.similarity.vector
            : null,
          lexicalSimilarity: value.similarity.lexical,
        },
      });
    }
    for (const value of timelines.values()) {
      repository.upsertEdge({
        agentId: normalizedAgentId,
        fromMemoryId: value.fromMemoryId,
        toMemoryId: value.toMemoryId,
        relation: "timeline_next",
        direction: "directed",
        weight: edgeWeight(value.similarity.combined, options.minimumTimelineSimilarity),
        confidence: Math.max(0, Math.min(1, value.similarity.combined)),
        provenance: options.provenance,
        metadata: {
          gapDays: value.similarity.gapDays,
          vectorSimilarity: Number.isFinite(value.similarity.vector)
            ? value.similarity.vector
            : null,
          lexicalSimilarity: value.similarity.lexical,
        },
      });
    }
    for (const value of threads.edges.values()) {
      repository.upsertEdge({
        agentId: normalizedAgentId,
        fromMemoryId: value.fromMemoryId,
        toMemoryId: value.toMemoryId,
        relation: "same_thread",
        direction: "directed",
        weight: 1,
        confidence: 1,
        provenance: options.provenance,
        metadata: { canonicalKey: value.canonicalKey },
      });
    }
    for (const value of sharedEntities) {
      repository.upsertEdge({
        agentId: normalizedAgentId,
        fromMemoryId: value.fromMemoryId,
        toMemoryId: value.toMemoryId,
        relation: "shares_entity",
        direction: "undirected",
        weight: 0.9,
        confidence: 1,
        provenance: options.provenance,
        metadata: { entities: value.entities },
      });
    }
  });
  return {
    status: "completed",
    memoriesConsidered: seeds.length,
    associationEdges: associations.length,
    prunedAssociationEdges,
    timelineEdges: timelines.size,
    threadEdges: threads.edges.size,
    entityEdges: sharedEntities.length,
    totalEdges: associations.length + timelines.size + threads.edges.size + sharedEntities.length,
    provenance: options.provenance,
  };
}
