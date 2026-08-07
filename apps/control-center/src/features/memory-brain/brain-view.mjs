const TAU = Math.PI * 2;
const AMBIENT_GROUP_DURATION = 6_200;
const AMBIENT_TRANSITION_DURATION = 720;
const AMBIENT_BREATH_CYCLE = 1_650;
const AMBIENT_BREATH_DURATION = 1_230;
const AMBIENT_BREATH_COUNT = 3;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value)));
}

function nearestAngle(target, current) {
  return current + Math.atan2(Math.sin(target - current), Math.cos(target - current));
}

function rotatePoint(point, rotationX, rotationY) {
  const cosY = Math.cos(rotationY);
  const sinY = Math.sin(rotationY);
  const x = point.x * cosY - point.z * sinY;
  const zAfterY = point.x * sinY + point.z * cosY;
  const cosX = Math.cos(rotationX);
  const sinX = Math.sin(rotationX);
  return {
    x,
    y: point.y * cosX - zAfterY * sinX,
    z: point.y * sinX + zAfterY * cosX,
  };
}

function brainSurface(side, theta, phi, ripple = 0) {
  const vertical = Math.sin(theta) * Math.cos(phi);
  const depth = Math.sin(theta) * Math.sin(phi);
  const lowerTaper = vertical < 0 ? 0.82 + (vertical + 1) * 0.13 : 1;
  const rearTaper = depth < 0 ? 0.92 : 1.03;
  const frontalLift = Math.max(0, depth) * Math.max(0, vertical) * 0.08;
  const wave = 1 + Math.sin(phi * 3.2 + theta * 4.6) * ripple;
  return {
    x: side * (0.065 + Math.cos(theta) * 1.02 * wave * lowerTaper),
    y: 0.06 + vertical * 0.84 * wave * lowerTaper + frontalLift,
    z: depth * 1.08 * wave * rearTaper,
  };
}

function cerebellumSurface(side, theta, phi) {
  const wave = 1 + Math.sin(phi * 5 + theta * 3) * 0.035;
  return {
    x: side * (0.08 + Math.cos(theta) * 0.44 * wave),
    y: -0.59 + Math.sin(theta) * Math.cos(phi) * 0.31 * wave,
    z: -0.55 + Math.sin(theta) * Math.sin(phi) * 0.42 * wave,
  };
}

function buildBrainWireframe() {
  const polylines = [];
  for (const side of [-1, 1]) {
    for (const theta of [0.18, 0.62, 1.12, 1.48]) {
      const points = [];
      for (let step = 0; step <= 72; step += 1) {
        points.push(brainSurface(side, theta, (step / 72) * TAU, 0.016));
      }
      polylines.push({ points, strength: theta === 1.48 ? 0.9 : 0.26 });
    }

    for (let fold = 0; fold < 27; fold += 1) {
      const basePhi = (fold / 27) * TAU;
      const points = [];
      for (let step = 2; step <= 28; step += 1) {
        const theta = 0.08 + (step / 30) * Math.PI * 0.5;
        const phi = basePhi
          + Math.sin(step * 0.76 + fold * 1.41) * 0.105
          + Math.cos(step * 0.29 + fold) * 0.036;
        points.push(brainSurface(
          side,
          theta,
          phi,
          0.026,
        ));
      }
      polylines.push({ points, strength: 0.34 });
    }

    for (let fold = 0; fold < 13; fold += 1) {
      const baseTheta = 0.28 + (fold / 13) * 1.02;
      const startPhi = ((fold * 0.61) % 1) * TAU;
      const points = [];
      for (let step = 0; step <= 22; step += 1) {
        const progress = step / 22;
        const theta = baseTheta
          + Math.sin(progress * Math.PI * 3 + fold) * 0.085;
        const phi = startPhi + (progress - 0.5) * 1.15;
        points.push(brainSurface(side, theta, phi, 0.02));
      }
      polylines.push({ points, strength: 0.23 });
    }

    for (let fold = 0; fold < 8; fold += 1) {
      const phi = (fold / 8) * TAU;
      const points = [];
      for (let step = 2; step <= 17; step += 1) {
        points.push(cerebellumSurface(
          side,
          (step / 18) * Math.PI * 0.5,
          phi + Math.sin(step * 0.9 + fold) * 0.055,
        ));
      }
      polylines.push({ points, strength: 0.3 });
    }
  }
  polylines.push({
    strength: 0.58,
    points: Array.from({ length: 29 }, (_, index) => {
      const progress = index / 28;
      return {
        x: -0.055,
        y: 0.13 + Math.sin(progress * Math.PI) * 0.77,
        z: -0.92 + progress * 1.88,
      };
    }),
  });
  polylines.push({
    strength: 0.58,
    points: Array.from({ length: 29 }, (_, index) => {
      const progress = index / 28;
      return {
        x: 0.055,
        y: 0.13 + Math.sin(progress * Math.PI) * 0.77,
        z: -0.92 + progress * 1.88,
      };
    }),
  });
  for (const side of [-1, 1]) {
    polylines.push({
      strength: 0.42,
      points: Array.from({ length: 18 }, (_, index) => {
        const progress = index / 17;
        return {
          x: side * (0.07 + progress * 0.055),
          y: -0.63 - progress * 0.38,
          z: -0.23 - progress * 0.13,
        };
      }),
    });
  }
  return polylines;
}

function relationColor(edge, alpha) {
  const family = edge?.visualFamily || ({
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
  }[edge?.relation] || "associative");
  const color = {
    structural: "166, 144, 255",
    lifecycle: "255, 184, 112",
    evidence: "111, 180, 255",
    causal: "255, 125, 137",
    temporal: "103, 229, 205",
    entity: "105, 218, 242",
    associative: "151, 142, 255",
  }[family] || "151, 142, 255";
  return `rgba(${color}, ${alpha})`;
}

function nodePalette(node) {
  if (node.visualTier === "major") {
    return node.visualFamily === "episode" ? "87, 239, 210" : "177, 151, 255";
  }
  if (node.visualTier === "state") {
    return ({
      preference: "255, 190, 117",
      belief: "245, 204, 139",
      relationship: "255, 142, 180",
      affective_association: "255, 151, 198",
      goal: "89, 225, 218",
      condition: "108, 205, 255",
      capability: "118, 192, 255",
      identity: "194, 169, 255",
      self_concept: "205, 167, 255",
      value: "255, 212, 128",
      habit: "139, 219, 190",
      disposition: "155, 213, 188",
    }[node.stateFamily] || "255, 199, 128");
  }
  return ({
    reflection: "205, 185, 255",
    legacy: "161, 176, 210",
    knowledge: "151, 207, 255",
    intent: "99, 226, 220",
    event: "220, 246, 255",
  }[node.visualFamily] || "220, 246, 255");
}

function nodeBaseRadius(node) {
  const importance = clamp(node.importance, 0, 1);
  if (node.visualTier === "major") {
    return Math.min(6.2, 3.05 + Math.log2(1 + Number(node.memberCount || 0)) * 0.42 + importance * 0.7);
  }
  if (node.visualTier === "state") return 1.45 + importance * 0.7;
  return 0.42 + importance * 0.42;
}

export function memoryBrainEdgeMode(edge, {
  selectedId = "",
  ambientStrength = 0,
} = {}) {
  if (selectedId && (edge?.source === selectedId || edge?.target === selectedId)) {
    return "direct";
  }
  if (!selectedId && Number(ambientStrength) > 0) return "ambient";
  return "hidden";
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function squaredDistance(left, right) {
  const x = left.x - right.x;
  const y = left.y - right.y;
  const z = left.z - right.z;
  return x * x + y * y + z * z;
}

function ambientPulse(groupAge, phase = 0) {
  if (groupAge >= AMBIENT_BREATH_CYCLE * AMBIENT_BREATH_COUNT) return 0.06;
  const cycleAge = (groupAge + phase) % AMBIENT_BREATH_CYCLE;
  if (cycleAge >= AMBIENT_BREATH_DURATION) return 0.06;
  const progress = cycleAge / AMBIENT_BREATH_DURATION;
  return 0.12 + Math.pow(Math.sin(progress * Math.PI), 1.65) * 0.88;
}

function createAmbientGroup(nodes, adjacency, groupIndex) {
  const candidates = nodes.filter((node) => node.position);
  const groupSize = Math.min(
    candidates.length,
    Math.min(5, Math.max(2, Math.round(Math.sqrt(candidates.length)))),
  );
  const selected = [];
  while (selected.length < groupSize) {
    let choice = null;
    for (const candidate of candidates) {
      if (selected.includes(candidate)) continue;
      const seed = stableHash(`${groupIndex}:${selected.length}:${candidate.id}`) / 0xffff_ffff;
      const separation = selected.length
        ? Math.min(...selected.map((node) => squaredDistance(candidate.position, node.position)))
        : 0;
      const score = selected.length ? separation * 0.78 + seed : seed;
      if (!choice || score > choice.score) choice = { node: candidate, score };
    }
    if (!choice) break;
    selected.push(choice.node);
  }

  const connectedCandidates = [];
  for (const node of selected) {
    const connected = [...(adjacency.get(node.id) || [])]
      .sort((left, right) => (
        stableHash(`${groupIndex}:${node.id}:${left.edge.id}`)
        - stableHash(`${groupIndex}:${node.id}:${right.edge.id}`)
      ))
      .slice(0, 2);
    connectedCandidates.push(...connected);
  }
  connectedCandidates.sort((left, right) => (
    stableHash(`${groupIndex}:edge:${left.edge.id}`)
    - stableHash(`${groupIndex}:edge:${right.edge.id}`)
  ));
  const edgeIndices = new Set();
  const nodeIds = new Set(selected.map((node) => node.id));
  const maximumEdges = Math.min(4, Math.max(1, Math.round(Math.sqrt(candidates.length))));
  for (const connection of connectedCandidates) {
    if (edgeIndices.size >= maximumEdges) break;
    if (edgeIndices.has(connection.index)) continue;
    edgeIndices.add(connection.index);
    nodeIds.add(connection.neighborId);
  }
  return {
    nodeIds,
    edgeIndices,
    index: groupIndex,
  };
}

export function createMemoryBrainView(canvas, graph, {
  onSelect = () => {},
  onReset = () => {},
} = {}) {
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error("记忆大脑需要 canvas 元素。");
  }
  const context = canvas.getContext("2d", { alpha: true });
  const wireframe = buildBrainWireframe();
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || false;
  for (const [index, edge] of edges.entries()) {
    adjacency.get(edge.source)?.push({ edge, index, neighborId: edge.target });
    adjacency.get(edge.target)?.push({ edge, index, neighborId: edge.source });
  }

  let width = 1;
  let height = 1;
  let pixelRatio = 1;
  const restingRotationX = -0.08;
  const restingRotationY = 0.42;
  let rotationX = reducedMotion ? restingRotationX : -0.17;
  let rotationY = reducedMotion ? restingRotationY : 0.72;
  let targetRotationX = restingRotationX;
  let targetRotationY = restingRotationY;
  let zoom = reducedMotion ? 1 : 0.87;
  let targetZoom = 1;
  let selectedId = "";
  let directIds = new Set();
  let hitTargets = [];
  let pointerDown = null;
  let destroyed = false;
  let frame = 0;
  let lastInteractionAt = performance.now();
  let ambientGroup = createAmbientGroup(nodes, adjacency, 0);
  let fadingAmbientGroup = null;
  let ambientGroupAge = 0;
  let lastAmbientFrameAt = performance.now();

  function resize() {
    const bounds = canvas.getBoundingClientRect();
    pixelRatio = Math.min(1.6, window.devicePixelRatio || 1);
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  function project(point) {
    const rotated = rotatePoint(point, rotationX, rotationY);
    const cameraDistance = 3.95 / zoom;
    const depth = cameraDistance - rotated.z;
    const focal = Math.min(width, height) * 1.38;
    return {
      x: width * 0.5 + (rotated.x * focal) / depth,
      y: height * 0.49 - (rotated.y * focal) / depth,
      z: rotated.z,
      scale: focal / depth,
      visible: depth > 0.1,
    };
  }

  function drawBrain() {
    context.save();
    for (const polyline of wireframe) {
      const keyContour = polyline.strength >= 0.58;
      context.lineWidth = keyContour ? 1.08 : 0.72;
      context.shadowColor = keyContour ? "rgba(122, 189, 245, .28)" : "transparent";
      context.shadowBlur = keyContour ? 3.5 : 0;
      for (let index = 1; index < polyline.points.length; index += 1) {
        const left = project(polyline.points[index - 1]);
        const right = project(polyline.points[index]);
        if (!left.visible || !right.visible) continue;
        const depth = clamp(((left.z + right.z) * 0.5 + 1.2) / 2.4, 0, 1);
        const alpha = (0.054 + depth * 0.17) * polyline.strength;
        context.strokeStyle = `rgba(170, 211, 247, ${alpha})`;
        context.beginPath();
        context.moveTo(left.x, left.y);
        context.lineTo(right.x, right.y);
        context.stroke();
      }
    }
    context.restore();
  }

  function updateAmbientState(time) {
    if (reducedMotion || selectedId) {
      lastAmbientFrameAt = time;
      return;
    }
    ambientGroupAge += Math.min(80, Math.max(0, time - lastAmbientFrameAt));
    lastAmbientFrameAt = time;
    if (ambientGroupAge >= AMBIENT_GROUP_DURATION) {
      ambientGroupAge -= AMBIENT_GROUP_DURATION;
      fadingAmbientGroup = ambientGroup;
      ambientGroup = createAmbientGroup(nodes, adjacency, ambientGroup.index + 1);
    }
  }

  function ambientStrengthFor(nodeOrEdgeId, kind) {
    if (reducedMotion || selectedId) return 0;
    const collection = kind === "edge" ? ambientGroup.edgeIndices : ambientGroup.nodeIds;
    const phase = stableHash(`${ambientGroup.index}:${kind}:${nodeOrEdgeId}`) % 140;
    let strength = collection.has(nodeOrEdgeId) ? ambientPulse(ambientGroupAge, phase) : 0;
    if (fadingAmbientGroup) {
      const fadingCollection = kind === "edge"
        ? fadingAmbientGroup.edgeIndices
        : fadingAmbientGroup.nodeIds;
      const transition = clamp(1 - ambientGroupAge / AMBIENT_TRANSITION_DURATION, 0, 1);
      if (fadingCollection.has(nodeOrEdgeId)) strength = Math.max(strength, 0.18 * transition);
      if (!transition) fadingAmbientGroup = null;
    }
    return strength;
  }

  function quadraticPoint(start, control, end, progress) {
    const inverse = 1 - progress;
    return {
      x: inverse * inverse * start.x + 2 * inverse * progress * control.x + progress * progress * end.x,
      y: inverse * inverse * start.y + 2 * inverse * progress * control.y + progress * progress * end.y,
    };
  }

  function edgeProjection(edge) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source?.position || !target?.position) return null;
    const start = project(source.position);
    const end = project(target.position);
    if (!start.visible || !end.visible) return null;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const bend = Math.min(34, length * 0.14) * (edge.id.charCodeAt(0) % 2 ? 1 : -1);
    return {
      start,
      end,
      control: {
        x: (start.x + end.x) * 0.5 - (dy / length) * bend,
        y: (start.y + end.y) * 0.5 + (dx / length) * bend,
      },
    };
  }

  function drawConnections(time) {
    context.save();
    context.globalCompositeOperation = "lighter";
    const visibleEdgeIndices = selectedId
      ? new Set((adjacency.get(selectedId) || []).map((connection) => connection.index))
      : new Set([
        ...ambientGroup.edgeIndices,
        ...(fadingAmbientGroup?.edgeIndices || []),
      ]);
    for (const edgeIndex of visibleEdgeIndices) {
      const edge = edges[edgeIndex];
      if (!edge) continue;
      const ambientStrength = ambientStrengthFor(edgeIndex, "edge");
      const mode = memoryBrainEdgeMode(edge, { selectedId, ambientStrength });
      if (mode === "hidden") continue;
      const direct = mode === "direct";
      const ambient = mode === "ambient";
      const projected = edgeProjection(edge);
      if (!projected) continue;
      const alpha = direct ? 0.78 : 0.075 + ambientStrength * 0.2;
      context.lineWidth = direct ? 1.48 : 0.62 + ambientStrength * 0.22;
      context.strokeStyle = relationColor(edge, alpha);
      if (ambient) {
        context.shadowColor = relationColor(edge, 0.55);
        context.shadowBlur = 6 + ambientStrength * 5;
      }
      context.beginPath();
      context.moveTo(projected.start.x, projected.start.y);
      context.quadraticCurveTo(
        projected.control.x,
        projected.control.y,
        projected.end.x,
        projected.end.y,
      );
      context.stroke();
      context.shadowBlur = 0;
      if (direct || ambient) {
        const speed = direct ? 0.00028 : 0.00021;
        const progress = reducedMotion ? 0.5 : ((time * speed + edgeIndex * 0.17) % 1);
        const pulse = quadraticPoint(
          projected.start,
          projected.control,
          projected.end,
          progress,
        );
        const pulseAlpha = direct ? 0.98 : 0.3 + ambientStrength * 0.62;
        context.fillStyle = relationColor(edge, pulseAlpha);
        context.shadowColor = relationColor(edge, direct ? 1 : 0.76);
        context.shadowBlur = direct ? 12 : 7 + ambientStrength * 4;
        context.beginPath();
        context.arc(pulse.x, pulse.y, direct ? 2 : 1.05 + ambientStrength * 0.45, 0, TAU);
        context.fill();
        context.shadowBlur = 0;
      }
    }
    context.restore();
  }

  function drawNodes(time) {
    const projectedNodes = nodes.map((node) => ({
      node,
      projected: project(node.position),
    })).filter((value) => value.projected.visible)
      .sort((left, right) => left.projected.z - right.projected.z);
    hitTargets = [];
    context.save();
    context.globalCompositeOperation = "lighter";
    for (const value of projectedNodes) {
      const { node, projected } = value;
      const selected = node.id === selectedId;
      const direct = directIds.has(node.id);
      const depth = clamp((projected.z + 1.2) / 2.4, 0, 1);
      const ambientStrength = ambientStrengthFor(node.id, "node");
      const ambient = !selected && !direct && ambientStrength > 0;
      const baseSize = nodeBaseRadius(node);
      const breathing = ambient
        ? 0.98 + ambientStrength * 0.12
        : 1;
      const radius = (selected ? baseSize * 1.72 : direct ? baseSize * 1.3 : baseSize)
        * breathing
        * clamp(projected.scale / 150, 0.76, 1.34);
      let alpha = (node.visualTier === "minor" ? 0.56 : 0.48) + depth * 0.3;
      let color = nodePalette(node);
      if (selected) {
        alpha = 1;
        color = "232, 255, 249";
      } else if (direct) {
        alpha = 0.96;
      } else if (selectedId) {
        alpha *= 0.2;
      } else if (ambient) {
        alpha = Math.min(1, alpha + 0.1 + ambientStrength * 0.24);
        context.fillStyle = `rgba(${color}, ${0.025 + ambientStrength * 0.045})`;
        context.shadowColor = `rgba(${color}, 0.7)`;
        context.shadowBlur = 13 + ambientStrength * 9;
        context.beginPath();
        context.arc(projected.x, projected.y, Math.max(2.8, radius + 2.7), 0, TAU);
        context.fill();
      }
      if (node.visualTier === "major") {
        context.strokeStyle = `rgba(${color}, ${selectedId && !selected && !direct ? 0.07 : 0.24 + depth * 0.16})`;
        context.lineWidth = 0.8;
        context.beginPath();
        context.arc(projected.x, projected.y, radius + 3.5, 0, TAU);
        context.stroke();
        context.strokeStyle = `rgba(${color}, ${selectedId && !selected && !direct ? 0.035 : 0.12 + depth * 0.1})`;
        context.beginPath();
        context.arc(projected.x, projected.y, radius + 6.5, 0, TAU);
        context.stroke();
      } else if (node.visualTier === "state") {
        context.strokeStyle = `rgba(${color}, ${selectedId && !selected && !direct ? 0.05 : 0.22})`;
        context.lineWidth = 0.65;
        context.beginPath();
        context.arc(projected.x, projected.y, radius + 2.2, 0, TAU);
        context.stroke();
      }
      context.fillStyle = `rgba(${color}, ${alpha})`;
      context.shadowColor = `rgba(${color}, ${selected || direct ? 0.95 : node.visualTier === "minor" ? 0.58 : 0.4})`;
      context.shadowBlur = selected ? 25 : direct ? 16 : ambient ? 13 : node.visualTier === "minor" ? 5 : 7;
      context.beginPath();
      context.arc(projected.x, projected.y, Math.max(node.visualTier === "minor" ? 0.58 : 1, radius), 0, TAU);
      context.fill();
      if (selected) {
        context.strokeStyle = "rgba(187, 255, 241, .82)";
        context.lineWidth = 1;
        context.beginPath();
        context.arc(projected.x, projected.y, radius + 8 + (reducedMotion ? 0 : Math.sin(time * 0.003) * 2), 0, TAU);
        context.stroke();
      }
      hitTargets.push({
        id: node.id,
        x: projected.x,
        y: projected.y,
        radius: Math.max(node.visualTier === "major" ? 14 : node.visualTier === "state" ? 10 : 7, radius + 5),
        z: projected.z,
      });
    }
    context.restore();
  }

  function updateRelated() {
    directIds = new Set((adjacency.get(selectedId) || []).map((value) => value.neighborId));
  }

  function focusNode(id, notify = true) {
    const node = nodeById.get(id);
    if (!node?.position) return false;
    selectedId = id;
    updateRelated();
    const point = node.position;
    const yaw = Math.atan2(point.x, point.z);
    const zAfterYaw = Math.sqrt(point.x * point.x + point.z * point.z);
    const pitch = Math.atan2(point.y, Math.max(0.01, zAfterYaw));
    targetRotationY = nearestAngle(yaw, rotationY);
    targetRotationX = nearestAngle(pitch, rotationX);
    targetZoom = node.visualTier === "major" ? 1.42 : node.visualTier === "state" ? 1.55 : 1.72;
    lastInteractionAt = performance.now();
    if (notify) onSelect(node);
    return true;
  }

  function reset() {
    selectedId = "";
    directIds = new Set();
    targetRotationX = restingRotationX;
    targetRotationY = nearestAngle(restingRotationY, rotationY);
    targetZoom = 1;
    lastInteractionAt = performance.now();
    onReset();
  }

  function hitTest(x, y) {
    return [...hitTargets]
      .sort((left, right) => right.z - left.z)
      .find((target) => Math.hypot(target.x - x, target.y - y) <= target.radius);
  }

  function pointerPosition(event) {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    };
  }

  function onPointerDown(event) {
    const point = pointerPosition(event);
    pointerDown = {
      pointerId: event.pointerId,
      x: point.x,
      y: point.y,
      rotationX,
      rotationY,
      moved: false,
    };
    canvas.setPointerCapture(event.pointerId);
    lastInteractionAt = performance.now();
  }

  function onPointerMove(event) {
    const point = pointerPosition(event);
    if (pointerDown?.pointerId === event.pointerId) {
      const dx = point.x - pointerDown.x;
      const dy = point.y - pointerDown.y;
      pointerDown.moved ||= Math.abs(dx) + Math.abs(dy) > 4;
      rotationY = pointerDown.rotationY - dx * 0.006;
      rotationX = clamp(pointerDown.rotationX + dy * 0.005, -Math.PI * 0.48, Math.PI * 0.48);
      targetRotationX = rotationX;
      targetRotationY = rotationY;
      canvas.style.cursor = "grabbing";
      return;
    }
    canvas.style.cursor = hitTest(point.x, point.y) ? "pointer" : "grab";
  }

  function onPointerUp(event) {
    if (!pointerDown || pointerDown.pointerId !== event.pointerId) return;
    const point = pointerPosition(event);
    if (!pointerDown.moved) {
      const target = hitTest(point.x, point.y);
      if (target) focusNode(target.id);
    }
    pointerDown = null;
    canvas.releasePointerCapture(event.pointerId);
    canvas.style.cursor = "grab";
  }

  function onWheel(event) {
    event.preventDefault();
    targetZoom = clamp(targetZoom * Math.exp(-event.deltaY * 0.001), 0.72, 2.25);
    lastInteractionAt = performance.now();
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", reset);

  function render(time) {
    if (destroyed || !canvas.isConnected) {
      destroy();
      return;
    }
    frame = requestAnimationFrame(render);
    updateAmbientState(time);
    if (!reducedMotion && !selectedId && !pointerDown && time - lastInteractionAt > 2_100) {
      targetRotationY += 0.00048;
    }
    rotationX += (targetRotationX - rotationX) * 0.085;
    rotationY += (targetRotationY - rotationY) * 0.085;
    zoom += (targetZoom - zoom) * 0.085;
    context.clearRect(0, 0, width, height);
    drawBrain();
    drawConnections(time);
    drawNodes(time);
  }
  frame = requestAnimationFrame(render);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("dblclick", reset);
  }

  return {
    destroy,
    focusNode,
    reset,
    selectedId: () => selectedId,
  };
}
