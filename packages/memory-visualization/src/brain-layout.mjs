import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  BIG_NEURON_KINDS,
  isStatefulMemoryKind,
} from "@suzu-lives/memory-core";

export const BRAIN_LAYOUT_VERSION = "brain-v2";

const STRUCTURAL_RELATIONS = new Set([
  "part_of_episode",
  "supports_topic",
]);

const RELATION_FAMILIES = Object.freeze({
  part_of_episode: "structural",
  supports_topic: "structural",
  corrects: "lifecycle",
  supersedes: "lifecycle",
  contradicts: "lifecycle",
  scoped_exception_to: "lifecycle",
  established_from: "lifecycle",
  completes: "lifecycle",
  cancels: "lifecycle",
  supported_by: "evidence",
  challenged_by: "evidence",
  causes: "causal",
  timeline_next: "temporal",
  same_thread: "temporal",
  followed_by: "temporal",
  shares_entity: "entity",
  associated_with: "associative",
});

function clean(value) {
  return String(value ?? "").trim();
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function bounded(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, finite(value)));
}

function hashUnit(value, salt) {
  const buffer = createHash("sha256").update(`${salt}\u001f${value}`).digest();
  return buffer.readUInt32BE(0) / 0xffffffff;
}

function positionValid(value) {
  return value
    && Number.isFinite(Number(value.x))
    && Number.isFinite(Number(value.y))
    && Number.isFinite(Number(value.z));
}

function roundPosition(value) {
  return {
    x: Math.round(value.x * 10_000) / 10_000,
    y: Math.round(value.y * 10_000) / 10_000,
    z: Math.round(value.z * 10_000) / 10_000,
  };
}

function constrainToBrain(position) {
  const sign = position.x < 0 ? -1 : 1;
  let localX = Math.max(0.08, Math.abs(position.x));
  let y = position.y;
  let z = position.z;
  const normalizedX = (localX - 0.08) / 1.08;
  const normalizedY = y / 0.88;
  const normalizedZ = z / 1.08;
  const distance = Math.sqrt(
    normalizedX * normalizedX
    + normalizedY * normalizedY
    + normalizedZ * normalizedZ,
  );
  if (distance > 0.96) {
    const scale = 0.96 / distance;
    localX = 0.08 + (localX - 0.08) * scale;
    y *= scale;
    z *= scale;
  }
  return { x: sign * localX, y, z };
}

function deterministicPoint(id) {
  const hemisphere = hashUnit(id, "hemisphere") < 0.5 ? -1 : 1;
  const azimuth = hashUnit(id, "azimuth") * Math.PI * 2;
  const vertical = hashUnit(id, "vertical") * 2 - 1;
  const radial = 0.38 + Math.cbrt(hashUnit(id, "radius")) * 0.56;
  const horizontal = Math.sqrt(Math.max(0, 1 - vertical * vertical));
  return constrainToBrain({
    x: hemisphere * (0.1 + Math.abs(Math.cos(azimuth)) * horizontal * radial * 1.08),
    y: vertical * radial * 0.88,
    z: Math.sin(azimuth) * horizontal * radial * 1.08,
  });
}

function deterministicOffset(id, scale = 0.16) {
  return {
    x: (hashUnit(id, "offset-x") * 2 - 1) * scale,
    y: (hashUnit(id, "offset-y") * 2 - 1) * scale,
    z: (hashUnit(id, "offset-z") * 2 - 1) * scale,
  };
}

function readCache(cachePath, layoutVersion) {
  if (!cachePath || !fs.existsSync(cachePath)) return { positions: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8").replace(/^\uFEFF/u, ""));
    if (parsed.layoutVersion !== layoutVersion || typeof parsed.positions !== "object") {
      return { positions: {} };
    }
    return parsed;
  } catch {
    return { positions: {} };
  }
}

function writeCache(cachePath, value) {
  if (!cachePath) return;
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, cachePath);
}

export function relationVisualFamily(relation) {
  return RELATION_FAMILIES[clean(relation)] || "associative";
}

export function nodeVisualProfile(node = {}) {
  const kind = clean(node.kind);
  const stateFamily = clean(node.stateFamily || node.state_family);
  if (BIG_NEURON_KINDS.includes(kind)) {
    return { visualTier: "major", visualFamily: kind };
  }
  if (
    isStatefulMemoryKind(kind)
    || !["", "not_applicable", "unspecified"].includes(stateFamily)
  ) {
    return { visualTier: "state", visualFamily: "state" };
  }
  if (["plan", "commitment", "open_loop"].includes(kind)) {
    return { visualTier: "minor", visualFamily: "intent" };
  }
  if (["fact", "derived_hypothesis"].includes(kind)) {
    return { visualTier: "minor", visualFamily: "knowledge" };
  }
  if (kind === "reflection") {
    return { visualTier: "minor", visualFamily: "reflection" };
  }
  if (kind === "topic_or_episode") {
    return { visualTier: "minor", visualFamily: "legacy" };
  }
  return { visualTier: "minor", visualFamily: "event" };
}

function adjacencyFor(nodes, edges) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const value = {
      id: edge.id,
      relation: edge.relation,
      visualFamily: edge.visualFamily || relationVisualFamily(edge.relation),
      structural: Boolean(edge.structural || STRUCTURAL_RELATIONS.has(edge.relation)),
      weight: bounded(edge.weight, 0, 1),
    };
    adjacency.get(edge.source).push({ ...value, neighborId: edge.target });
    adjacency.get(edge.target).push({ ...value, neighborId: edge.source });
  }
  return adjacency;
}

function averagePositions(values) {
  return values.reduce((result, value) => ({
    x: result.x + value.x / values.length,
    y: result.y + value.y / values.length,
    z: result.z + value.z / values.length,
  }), { x: 0, y: 0, z: 0 });
}

function initialPositions(nodes, edges, cachedPositions) {
  const positions = new Map();
  const existingIds = new Set();
  for (const node of nodes) {
    const cached = cachedPositions[node.id];
    if (!positionValid(cached)) continue;
    positions.set(node.id, constrainToBrain({
      x: Number(cached.x),
      y: Number(cached.y),
      z: Number(cached.z),
    }));
    existingIds.add(node.id);
  }
  const adjacency = adjacencyFor(nodes, edges);
  const structuralContainers = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!STRUCTURAL_RELATIONS.has(edge.relation)) continue;
    structuralContainers.get(edge.source)?.push(edge.target);
  }
  const ordered = [...nodes].sort((left, right) => (
    (left.visualTier === "major" ? 0 : 1) - (right.visualTier === "major" ? 0 : 1)
    || clean(left.eventDate || left.recordedAt).localeCompare(
      clean(right.eventDate || right.recordedAt),
    )
    || left.id.localeCompare(right.id)
  ));
  for (const node of ordered) {
    if (positions.has(node.id)) continue;
    if (node.visualTier === "major") {
      positions.set(node.id, deterministicPoint(`major:${node.id}`));
      continue;
    }
    const containerPositions = (structuralContainers.get(node.id) || [])
      .map((id) => positions.get(id))
      .filter(Boolean);
    const neighborPositions = adjacency.get(node.id)
      .map((value) => positions.get(value.neighborId))
      .filter(Boolean);
    const anchors = containerPositions.length ? containerPositions : neighborPositions;
    if (!anchors.length) {
      positions.set(node.id, deterministicPoint(node.id));
      continue;
    }
    const center = averagePositions(anchors);
    const offset = deterministicOffset(node.id, containerPositions.length ? 0.13 : 0.17);
    positions.set(node.id, constrainToBrain({
      x: center.x + offset.x,
      y: center.y + offset.y,
      z: center.z + offset.z,
    }));
  }
  return { adjacency, existingIds, positions };
}

function relaxNewPositions(nodes, adjacency, positions, existingIds) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const movableIds = nodes
    .filter((node) => node.visualTier !== "major" && !existingIds.has(node.id))
    .map((node) => node.id);
  if (!movableIds.length) return;
  const iterations = existingIds.size ? 22 : 72;
  const allIds = nodes.map((node) => node.id);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const changes = new Map();
    for (const id of movableIds) {
      const point = positions.get(id);
      let dx = 0;
      let dy = 0;
      let dz = 0;
      for (const edge of adjacency.get(id)) {
        const neighbor = positions.get(edge.neighborId);
        if (!neighbor) continue;
        const pull = edge.structural
          ? 0.095 + edge.weight * 0.055
          : 0.018 + edge.weight * 0.024;
        dx += (neighbor.x - point.x) * pull;
        dy += (neighbor.y - point.y) * pull;
        dz += (neighbor.z - point.z) * pull;
      }
      for (const otherId of allIds) {
        if (otherId === id) continue;
        const other = positions.get(otherId);
        const x = point.x - other.x;
        const y = point.y - other.y;
        const z = point.z - other.z;
        const distanceSquared = x * x + y * y + z * z;
        if (distanceSquared <= 0.0001 || distanceSquared >= 0.075) continue;
        const otherTier = nodeById.get(otherId)?.visualTier;
        const repulsion = (otherTier === "major" ? 0.0009 : 0.00135) / distanceSquared;
        dx += x * repulsion;
        dy += y * repulsion;
        dz += z * repulsion;
      }
      const magnitude = Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz) / 0.052);
      changes.set(id, constrainToBrain({
        x: point.x + dx / magnitude,
        y: point.y + dy / magnitude,
        z: point.z + dz / magnitude,
      }));
    }
    for (const [id, position] of changes) positions.set(id, position);
  }
}

export function layoutBrainGraph({
  nodes = [],
  edges = [],
  cachePath = "",
  layoutVersion = BRAIN_LAYOUT_VERSION,
} = {}) {
  const profiledNodes = nodes.map((node) => ({
    ...node,
    ...nodeVisualProfile(node),
  }));
  const cache = readCache(cachePath, layoutVersion);
  const { adjacency, existingIds, positions } = initialPositions(
    profiledNodes,
    edges,
    cache.positions || {},
  );
  relaxNewPositions(profiledNodes, adjacency, positions, existingIds);
  const serialized = Object.fromEntries(profiledNodes.map((node) => [
    node.id,
    roundPosition(positions.get(node.id) || deterministicPoint(node.id)),
  ]));
  writeCache(cachePath, {
    schemaVersion: 2,
    layoutVersion,
    updatedAt: new Date().toISOString(),
    positions: serialized,
  });
  return {
    layoutVersion,
    positions: serialized,
    reused: existingIds.size,
    created: profiledNodes.length - existingIds.size,
  };
}

export function loadStructuredMemoryGraph(repository, agentId) {
  const normalizedAgentId = clean(agentId);
  if (!repository) throw new Error("loadStructuredMemoryGraph 需要 repository。");
  if (!normalizedAgentId) throw new Error("loadStructuredMemoryGraph 需要 agentId。");
  const nodes = repository.database.prepare(`
    SELECT id, kind, layer, title, content, event_date, event_start,
           recorded_at, confidence, importance, status,
           reality, evidence_mode,
           subject_role, subject_key, temporal_state, valid_from, valid_to,
           representation_layer, state_family, state_phase
    FROM memory_nodes
    WHERE agent_id = ? AND status = 'active' AND kind <> 'utterance'
    ORDER BY COALESCE(event_date, event_start, recorded_at), id
  `).all(normalizedAgentId).map((row) => {
    const profile = nodeVisualProfile({ kind: row.kind, stateFamily: row.state_family });
    return {
      id: row.id,
      kind: row.kind,
      layer: row.layer,
      title: clean(row.title) || "未命名记忆",
      preview: clean(row.content).slice(0, 180),
      eventDate: row.event_date || "",
      eventStart: row.event_start || "",
      recordedAt: row.recorded_at || "",
      confidence: finite(row.confidence, 1),
      importance: finite(row.importance, 0.5),
      status: row.status,
      reality: row.reality || "uncertain",
      evidenceMode: row.evidence_mode || "unknown",
      subjectRole: row.subject_role || "unknown",
      subjectKey: row.subject_key || "",
      temporalState: row.temporal_state || "unknown",
      validFrom: row.valid_from || "",
      validTo: row.valid_to || "",
      representationLayer: row.representation_layer || "unspecified",
      stateFamily: row.state_family || "not_applicable",
      statePhase: row.state_phase || "not_applicable",
      ...profile,
    };
  });
  const edges = repository.database.prepare(`
    SELECT edge.id, edge.from_memory_id, edge.to_memory_id,
           edge.relation, edge.direction, edge.weight, edge.confidence
    FROM memory_edges AS edge
    JOIN memory_nodes AS source ON source.id = edge.from_memory_id
    JOIN memory_nodes AS target ON target.id = edge.to_memory_id
    WHERE edge.agent_id = ?
      AND source.status = 'active'
      AND target.status = 'active'
      AND source.kind <> 'utterance'
      AND target.kind <> 'utterance'
    ORDER BY edge.weight DESC, edge.id
  `).all(normalizedAgentId).map((row) => ({
    id: row.id,
    source: row.from_memory_id,
    target: row.to_memory_id,
    relation: row.relation,
    direction: row.direction,
    weight: finite(row.weight, 0.5),
    confidence: finite(row.confidence, 1),
    visualFamily: relationVisualFamily(row.relation),
    structural: STRUCTURAL_RELATIONS.has(row.relation),
  }));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    node.connectionCount = 0;
    node.memberCount = 0;
    node.containerIds = [];
  }
  for (const edge of edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (source) source.connectionCount += 1;
    if (target) target.connectionCount += 1;
    if (edge.structural && source && target?.visualTier === "major") {
      source.containerIds.push(target.id);
      target.memberCount += 1;
    }
  }
  return { nodes, edges };
}

export function createBrainSnapshot({
  repository,
  agentId,
  cachePath = "",
  layoutVersion = BRAIN_LAYOUT_VERSION,
} = {}) {
  const graph = loadStructuredMemoryGraph(repository, agentId);
  const layout = layoutBrainGraph({
    nodes: graph.nodes,
    edges: graph.edges,
    cachePath,
    layoutVersion,
  });
  const counts = graph.nodes.reduce((result, node) => {
    result[node.visualTier] += 1;
    return result;
  }, { major: 0, state: 0, minor: 0 });
  return {
    status: "ready",
    generatedAt: new Date().toISOString(),
    layoutVersion,
    nodes: graph.nodes.map((node) => ({
      ...node,
      position: layout.positions[node.id],
    })),
    edges: graph.edges,
    counts: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      ...counts,
    },
    layout: {
      reused: layout.reused,
      created: layout.created,
    },
  };
}
